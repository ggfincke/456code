// apps/server/src/provider/Layers/GrokAdapter.ts
// runs Grok CLI sessions through ACP

import {
  ApprovalRequestId,
  type GrokSettings,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
} from '@t3tools/contracts'
import * as Crypto from 'effect/Crypto'
import * as DateTime from 'effect/DateTime'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import * as PubSub from 'effect/PubSub'
import * as Ref from 'effect/Ref'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'
import * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner'
import * as EffectAcpErrors from 'effect-acp/errors'
import type * as EffectAcpSchema from 'effect-acp/schema'

import { resolveAttachmentPath } from '../../attachments/attachmentStore.ts'
import { ServerConfig } from '../../config.ts'
import { GROK_PROVIDER_CAPABILITIES } from '../providerCapabilities.ts'
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterValidationError,
} from '../Errors.ts'
import { classifyAcpTermination, mapAcpToAdapterError } from '../acp/AcpAdapterSupport.ts'
import type * as AcpSessionRuntime from '../acp/AcpSessionRuntime.ts'
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from '../acp/AcpCoreRuntimeEvents.ts'
import { parsePermissionRequest } from '../acp/AcpRuntimeModel.ts'
import { makeAcpNativeLoggerFactory } from '../acp/AcpNativeLogging.ts'
import {
  applyGrokAcpModelSelection,
  currentGrokModelIdFromSessionSetup,
  makeGrokAcpRuntime,
  resolveGrokAcpBaseModelId,
} from '../acp/GrokAcpSupport.ts'
import {
  extractXAiAskUserQuestions,
  makeXAiAskUserQuestionCancelledResponse,
  makeXAiAskUserQuestionResponse,
  promptResponseHasMissingXAiStopReason,
  XAiAskUserQuestionRequest,
} from '../acp/XAiAcpExtension.ts'
import { type GrokAdapterShape } from '../Services/GrokAdapter.ts'
import type {
  ProviderAdapterRuntimeEvent,
  ProviderAdapterRuntimeSessionBinding,
} from '../Services/ProviderAdapter.ts'
import { makeAcpAdapterSessionLifecycle } from './AcpAdapterSessionLifecycle.ts'
import { type EventNdjsonLogger, makeEventNdjsonLogger } from './EventNdjsonLogger.ts'

const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.UnknownFromJsonString)

const PROVIDER = ProviderDriverKind.make('grok')
const GROK_RESUME_VERSION = 1 as const

function encodeJsonStringForDiagnostics(input: unknown): string | undefined
{
  const result = encodeUnknownJsonStringExit(input)
  return Exit.isSuccess(result) ? result.value : undefined
}

export interface GrokAdapterLiveOptions
{
  readonly environment?: NodeJS.ProcessEnv
  readonly enableAbnormalTermination?: boolean
  readonly nativeEventLogPath?: string
  readonly nativeEventLogger?: EventNdjsonLogger
  readonly instanceId?: ProviderInstanceId
}

interface PendingApproval
{
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>
}

type PendingUserInputResolution =
  | { readonly _tag: 'answered'; readonly answers: ProviderUserInputAnswers }
  | { readonly _tag: 'cancelled' }

interface PendingUserInput
{
  readonly resolution: Deferred.Deferred<PendingUserInputResolution>
}

interface GrokSessionContext
{
  readonly threadId: ThreadId
  readonly runtimeSessionBinding: ProviderAdapterRuntimeSessionBinding
  readonly acpSessionId: string
  readonly generationId: string
  session: ProviderSession
  readonly scope: Scope.Closeable
  readonly acp: AcpSessionRuntime.AcpSessionRuntime['Service']
  notificationFiber: Fiber.Fiber<void, never> | undefined
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>
  turns: Array<{ id: TurnId; items: Array<unknown> }>
  lastPlanFingerprint: string | undefined
  activeTurnId: TurnId | undefined
  // turns already interrupted; late prompt RPCs must not resurrect them.
  interruptedTurnIds: Set<TurnId>
  // number of sendTurn prompts currently in flight or being prepared.
  // >0 means a turn is actively running, so a new sendTurn is a steer that
  // continues it, and only the last remaining prompt settles the turn.
  promptsInFlight: number
  currentModelId: string | undefined
  readonly finalizationState: Ref.Ref<'open' | 'graceful' | 'abnormal'>
  stopped: boolean
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void>
{
  return Effect.forEach(
    Array.from(pendingApprovals.values()),
    (pending) => Deferred.succeed(pending.decision, 'cancel').pipe(Effect.ignore),
    { discard: true },
  )
}

function settlePendingUserInputsAsCancelled(
  pendingUserInputs: ReadonlyMap<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void>
{
  return Effect.forEach(
    Array.from(pendingUserInputs.values()),
    (pending) => Deferred.succeed(pending.resolution, { _tag: 'cancelled' }).pipe(Effect.ignore),
    { discard: true },
  )
}

function appendPromptResultToTurn(
  ctx: GrokSessionContext,
  turnId: TurnId,
  promptParts: ReadonlyArray<EffectAcpSchema.ContentBlock>,
  result: EffectAcpSchema.PromptResponse,
): void
{
  const existingTurnRecord = ctx.turns.find((turn) => turn.id === turnId)
  ctx.turns = existingTurnRecord
    ? ctx.turns.map((turn) =>
        turn.id === turnId
          ? { ...turn, items: [...turn.items, { prompt: promptParts, result }] }
          : turn,
      )
    : [...ctx.turns, { id: turnId, items: [{ prompt: promptParts, result }] }]
}

function isRecord(value: unknown): value is Record<string, unknown>
{
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const resolveNotificationTurnId = (ctx: GrokSessionContext): TurnId | undefined => ctx.activeTurnId

const resolveCallbackTurnId = (ctx: GrokSessionContext): TurnId | undefined => ctx.activeTurnId

const resolveSessionCallbackTurnId = (
  sessions: ReadonlyMap<ThreadId, GrokSessionContext>,
  threadId: ThreadId,
): TurnId | undefined =>
{
  const ctx = sessions.get(threadId)
  return ctx ? resolveCallbackTurnId(ctx) : undefined
}

function parseGrokResume(
  raw: unknown,
): { sessionId: string; requireExisting: boolean } | undefined
{
  if (!isRecord(raw)) return undefined
  if (raw.schemaVersion !== GROK_RESUME_VERSION) return undefined
  if (typeof raw.sessionId !== 'string' || !raw.sessionId.trim()) return undefined
  if (Object.hasOwn(raw, 'requireExisting') && raw.requireExisting !== true) return undefined
  return {
    sessionId: raw.sessionId,
    requireExisting: raw.requireExisting === true,
  }
}

function selectPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: Exclude<ProviderApprovalDecision, 'cancel'>,
): string | undefined
{
  const kind =
    decision === 'acceptForSession' || decision === 'acceptAlways'
      ? 'allow_always'
      : decision === 'accept'
        ? 'allow_once'
        : 'reject_once'
  const option = request.options.find((entry) => entry.kind === kind)
  return option?.optionId.trim() || undefined
}

function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined
{
  return (
    selectPermissionOptionId(request, 'acceptForSession') ??
    selectPermissionOptionId(request, 'accept')
  )
}

function completedStopReasonFromPromptResponse(
  response: EffectAcpSchema.PromptResponse | undefined,
): EffectAcpSchema.StopReason | null
{
  if (response === undefined || promptResponseHasMissingXAiStopReason(response))
  {
    return null
  }
  return response.stopReason
}

export function grokPromptSettlementBelongsToContext(input: {
  readonly liveAcpSessionId: string
  readonly expectedAcpSessionId: string
  readonly liveActiveTurnId: TurnId | undefined
  readonly liveSessionActiveTurnId: TurnId | undefined
  readonly turnId: TurnId
}): boolean
{
  return (
    input.liveAcpSessionId === input.expectedAcpSessionId &&
    (input.liveActiveTurnId === input.turnId || input.liveSessionActiveTurnId === input.turnId)
  )
}

export function makeGrokAdapter(grokSettings: GrokSettings, options?: GrokAdapterLiveOptions)
{
  return Effect.gen(function* ()
  {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make('grok')
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const serverConfig = yield* Effect.service(ServerConfig)
    const crypto = yield* Crypto.Crypto
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: 'native' })
        : undefined)
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined
    const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory()

    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderAdapterRuntimeEvent>()

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso)
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: 'crypto/randomUUIDv4',
            detail: 'Failed to generate Grok runtime identifier.',
            cause,
          }),
      ),
    )
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id))
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso })
    const mapAcpCallbackFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpTransportError({
              detail: 'Failed to process Grok ACP callback.',
              cause,
            }),
        ),
      )

    const offerRuntimeEvent = (
      binding: ProviderAdapterRuntimeSessionBinding,
      event: ProviderRuntimeEvent,
    ) => PubSub.publish(runtimeEventPubSub, { binding, event }).pipe(Effect.asVoid)

    const sessionLifecycle = yield* makeAcpAdapterSessionLifecycle<
      GrokSessionContext,
      ProviderAdapterRequestError
    >({
      provider: PROVIDER,
      enableAbnormalTermination: options?.enableAbnormalTermination === true,
      settlePending: (context) =>
        Effect.all([
          settlePendingApprovalsAsCancelled(context.pendingApprovals),
          settlePendingUserInputsAsCancelled(context.pendingUserInputs),
        ]).pipe(Effect.asVoid),
      emitSessionExited: (context, classification) =>
        Effect.gen(function* ()
        {
          yield* offerRuntimeEvent(context.runtimeSessionBinding, {
            type: 'session.exited',
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: context.threadId,
            payload: {
              exitKind: classification.exitKind,
              reason: classification.reason,
              recoverable: classification.recoverable,
            },
          })
        }),
    })
    const {
      sessions,
      withThreadLock,
      requireSession,
      finalizeSessionLocked,
      finalizeSession,
      listSessions,
      hasSession,
    } = sessionLifecycle

    const settlePromptInFlight = (
      expectedContext: GrokSessionContext,
      turnId: TurnId,
      options?: {
        readonly errorMessage?: string
        readonly completedStopReason?: EffectAcpSchema.StopReason | null
        readonly emitTurnCompletion?: boolean
        // interrupt/cancel: drop every outstanding prompt slot and settle once.
        readonly settleAllPrompts?: boolean
      },
    ) =>
      Effect.gen(function* ()
      {
        const threadId = expectedContext.threadId
        const liveCtx = sessions.get(threadId)
        if (
          liveCtx !== expectedContext ||
          liveCtx.generationId !== expectedContext.generationId ||
          liveCtx.runtimeSessionBinding.providerInstanceId !==
            expectedContext.runtimeSessionBinding.providerInstanceId ||
          liveCtx.runtimeSessionBinding.threadId !==
            expectedContext.runtimeSessionBinding.threadId ||
          liveCtx.runtimeSessionBinding.sessionGeneration !==
            expectedContext.runtimeSessionBinding.sessionGeneration
        )
        {
          return
        }
        const expectedAcpSessionId = expectedContext.acpSessionId
        const settlementBelongsToLiveContext = grokPromptSettlementBelongsToContext({
          liveAcpSessionId: liveCtx.acpSessionId,
          expectedAcpSessionId,
          liveActiveTurnId: liveCtx.activeTurnId,
          liveSessionActiveTurnId: liveCtx.session.activeTurnId,
          turnId,
        })
        if (!settlementBelongsToLiveContext)
        {
          // interruptTurn already consumed every prompt slot for this turn. A
          // late prompt result must neither emit a second terminal event nor
          // consume a slot belonging to a newer turn on the same ACP session.
          if (
            liveCtx.acpSessionId !== expectedAcpSessionId ||
            liveCtx.interruptedTurnIds.has(turnId)
          )
          {
            return
          }
          if (options?.emitTurnCompletion !== false)
          {
            if (options?.errorMessage !== undefined)
            {
              yield* offerRuntimeEvent(expectedContext.runtimeSessionBinding, {
                type: 'turn.completed',
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId,
                turnId,
                payload: {
                  state: 'failed',
                  errorMessage: options.errorMessage,
                },
              })
            }
            else if (options?.completedStopReason !== undefined)
            {
              yield* offerRuntimeEvent(expectedContext.runtimeSessionBinding, {
                type: 'turn.completed',
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId,
                turnId,
                payload: {
                  state: options.completedStopReason === 'cancelled' ? 'cancelled' : 'completed',
                  stopReason: options.completedStopReason ?? null,
                },
              })
            }
          }
          return
        }
        let settleTurnId = turnId
        if (options?.settleAllPrompts)
        {
          liveCtx.promptsInFlight = 0
          if (liveCtx.activeTurnId !== turnId && liveCtx.session.activeTurnId !== turnId)
          {
            const fallbackTurnId = liveCtx.activeTurnId ?? liveCtx.session.activeTurnId
            if (!fallbackTurnId)
            {
              if (liveCtx.session.status === 'running' || liveCtx.session.status === 'connecting')
              {
                const updatedAt = yield* nowIso
                const { activeTurnId: _activeTurnId, ...readySession } = liveCtx.session
                liveCtx.activeTurnId = undefined
                liveCtx.session = {
                  ...readySession,
                  status: 'ready',
                  updatedAt,
                }
              }
              return
            }
            settleTurnId = fallbackTurnId
          }
        }
        else
        {
          const remainingPrompts = Math.max(0, liveCtx.promptsInFlight - 1)
          if (
            remainingPrompts > 0 ||
            liveCtx.activeTurnId !== settleTurnId ||
            liveCtx.session.activeTurnId !== settleTurnId
          )
          {
            liveCtx.promptsInFlight = remainingPrompts
            return
          }
          liveCtx.promptsInFlight = remainingPrompts
        }
        const updatedAt = yield* nowIso
        const canEmitTurnCompletion =
          liveCtx.session.status === 'running' || liveCtx.session.status === 'connecting'
        const shouldEmitFailedTurn = options?.errorMessage !== undefined && canEmitTurnCompletion
        const shouldEmitCompletedTurn =
          options?.completedStopReason !== undefined && canEmitTurnCompletion
        const { activeTurnId: _activeTurnId, ...readySession } = liveCtx.session
        liveCtx.activeTurnId = undefined
        liveCtx.session = {
          ...readySession,
          status: 'ready',
          updatedAt,
        }
        if (options?.emitTurnCompletion === false)
        {
          return
        }
        if (shouldEmitFailedTurn)
        {
          yield* offerRuntimeEvent(expectedContext.runtimeSessionBinding, {
            type: 'turn.completed',
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId,
            turnId: settleTurnId,
            payload: {
              state: 'failed',
              errorMessage: options.errorMessage,
            },
          })
        }
        else if (shouldEmitCompletedTurn)
        {
          yield* offerRuntimeEvent(expectedContext.runtimeSessionBinding, {
            type: 'turn.completed',
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId,
            turnId: settleTurnId,
            payload: {
              state: options.completedStopReason === 'cancelled' ? 'cancelled' : 'completed',
              stopReason: options.completedStopReason ?? null,
            },
          })
        }
      })

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
      Effect.gen(function* ()
      {
        if (!nativeEventLogger) return
        const observedAt = yield* nowIso
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* randomUUIDv4,
              kind: 'notification',
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        )
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning('Failed to write native Grok notification log.', {
            cause,
            threadId,
            method,
          }),
        ),
      )

    const emitPlanUpdate = (
      ctx: GrokSessionContext,
      turnId: TurnId | undefined,
      stamp: { readonly eventId: EventId; readonly createdAt: string },
      payload: {
        readonly explanation?: string | null
        readonly plan: ReadonlyArray<{
          readonly step: string
          readonly status: 'pending' | 'inProgress' | 'completed'
        }>
      },
      rawPayload: unknown,
      method: string,
    ) =>
      Effect.gen(function* ()
      {
        const fingerprint = `${turnId ?? 'no-turn'}:${encodeJsonStringForDiagnostics(payload) ?? '[unserializable payload]'}`
        if (ctx.lastPlanFingerprint === fingerprint)
        {
          return
        }
        ctx.lastPlanFingerprint = fingerprint
        yield* offerRuntimeEvent(
          ctx.runtimeSessionBinding,
          makeAcpPlanUpdatedEvent({
            stamp,
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId,
            payload,
            source: 'acp.jsonrpc',
            method,
            rawPayload,
          }),
        )
      })

    const gracefulStop = classifyAcpTermination({ _tag: 'AdapterStop' })

    const startSession: GrokAdapterShape['startSession'] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* ()
        {
          if (input.provider !== undefined && input.provider !== PROVIDER)
          {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: 'startSession',
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            })
          }
          if (!input.cwd?.trim())
          {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: 'startSession',
              issue: 'cwd is required and must be non-empty.',
            })
          }

          const cwd = path.resolve(input.cwd.trim())
          const grokModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined
          const parsedResume = parseGrokResume(input.resumeCursor)
          if (
            isRecord(input.resumeCursor) &&
            Object.hasOwn(input.resumeCursor, 'requireExisting') &&
            parsedResume === undefined
          )
          {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: 'startSession',
              issue: 'An imported Grok session requires a valid existing native session id.',
            })
          }
          const resumeSessionId = parsedResume?.sessionId
          const existing = sessions.get(input.threadId)
          if (
            existing &&
            !existing.stopped &&
            parseGrokResume(existing.session.resumeCursor)?.requireExisting === true &&
            parsedResume?.requireExisting !== true
          )
          {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: 'startSession',
              issue:
                'An active imported Grok session must be stopped before starting a fresh native session.',
            })
          }
          if (existing && !existing.stopped)
          {
            yield* finalizeSessionLocked(existing, gracefulStop)
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>()
          const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>()
          const sessionScope = yield* Scope.make('sequential')
          let sessionScopeTransferred = false
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          )

          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          })

          const mcpSession = input.mcp
          const acp = yield* makeGrokAcpRuntime({
            grokSettings,
            ...(options?.environment ? { environment: options.environment } : {}),
            childProcessSpawner,
            cwd,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            ...(parsedResume?.requireExisting === true ? { sessionSetup: 'import' as const } : {}),
            clientInfo: { name: 'code456', version: '0.0.0' },
            ...(mcpSession
              ? {
                  mcpServers: [
                    {
                      type: 'http' as const,
                      name: 'code456',
                      url: mcpSession.endpoint,
                      headers: [
                        {
                          name: 'Authorization',
                          value: mcpSession.authorizationHeader,
                        },
                      ],
                    },
                  ],
                }
              : {}),
            ...acpNativeLoggers,
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cause.message,
                  cause,
                }),
            ),
          )
          const started = yield* Effect.gen(function* ()
          {
            yield* Effect.forEach(
              ['x.ai/ask_user_question', '_x.ai/ask_user_question'] as const,
              (method) =>
                acp.handleExtRequest(method, XAiAskUserQuestionRequest, (params) =>
                  mapAcpCallbackFailure(
                    Effect.gen(function* ()
                    {
                      yield* logNative(input.threadId, method, params)
                      const requestId = ApprovalRequestId.make(yield* randomUUIDv4)
                      const runtimeRequestId = RuntimeRequestId.make(requestId)
                      const resolution = yield* Deferred.make<PendingUserInputResolution>()
                      const turnId = resolveSessionCallbackTurnId(sessions, input.threadId)
                      pendingUserInputs.set(requestId, { resolution })
                      yield* offerRuntimeEvent(input.runtimeSessionBinding, {
                        type: 'user-input.requested',
                        ...(yield* makeEventStamp()),
                        provider: PROVIDER,
                        threadId: input.threadId,
                        turnId,
                        requestId: runtimeRequestId,
                        payload: { questions: extractXAiAskUserQuestions(params) },
                        raw: {
                          source: 'acp.grok.extension',
                          method,
                          payload: params,
                        },
                      })
                      const resolved = yield* Deferred.await(resolution)
                      pendingUserInputs.delete(requestId)
                      const resolvedAnswers = resolved._tag === 'answered' ? resolved.answers : {}
                      yield* offerRuntimeEvent(input.runtimeSessionBinding, {
                        type: 'user-input.resolved',
                        ...(yield* makeEventStamp()),
                        provider: PROVIDER,
                        threadId: input.threadId,
                        turnId,
                        requestId: runtimeRequestId,
                        payload: { answers: resolvedAnswers },
                        raw: {
                          source: 'acp.grok.extension',
                          method,
                          payload: params,
                        },
                      })
                      switch (resolved._tag)
                      {
                        case 'answered':
                          return makeXAiAskUserQuestionResponse(params, resolved.answers)
                        case 'cancelled':
                          return makeXAiAskUserQuestionCancelledResponse()
                      }
                    }),
                  ),
                ),
              { discard: true },
            )
            yield* acp.handleRequestPermission((params) =>
              mapAcpCallbackFailure(
                Effect.gen(function* ()
                {
                  yield* logNative(input.threadId, 'session/request_permission', params)
                  if (input.runtimeMode === 'full-access')
                  {
                    const autoApprovedOptionId = selectAutoApprovedPermissionOption(params)
                    if (autoApprovedOptionId !== undefined)
                    {
                      return {
                        outcome: {
                          outcome: 'selected' as const,
                          optionId: autoApprovedOptionId,
                        },
                      }
                    }
                  }
                  const permissionRequest = parsePermissionRequest(params)
                  const requestId = ApprovalRequestId.make(yield* randomUUIDv4)
                  const runtimeRequestId = RuntimeRequestId.make(requestId)
                  const decision = yield* Deferred.make<ProviderApprovalDecision>()
                  const turnId = resolveSessionCallbackTurnId(sessions, input.threadId)
                  pendingApprovals.set(requestId, { decision })
                  yield* offerRuntimeEvent(
                    input.runtimeSessionBinding,
                    makeAcpRequestOpenedEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId,
                      requestId: runtimeRequestId,
                      permissionRequest,
                      detail:
                        permissionRequest.detail ??
                        encodeJsonStringForDiagnostics(params)?.slice(0, 2000) ??
                        '[unserializable params]',
                      args: params,
                      source: 'acp.jsonrpc',
                      method: 'session/request_permission',
                      rawPayload: params,
                    }),
                  )
                  const resolved = yield* Deferred.await(decision)
                  pendingApprovals.delete(requestId)
                  yield* offerRuntimeEvent(
                    input.runtimeSessionBinding,
                    makeAcpRequestResolvedEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId,
                      requestId: runtimeRequestId,
                      permissionRequest,
                      decision: resolved,
                    }),
                  )
                  const selectedOptionId =
                    resolved === 'cancel' ? undefined : selectPermissionOptionId(params, resolved)
                  return {
                    outcome: selectedOptionId
                      ? {
                          outcome: 'selected' as const,
                          optionId: selectedOptionId,
                        }
                      : ({ outcome: 'cancelled' } as const),
                  }
                }),
              ),
            )
            return yield* acp.start()
          }).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, 'session/start', error),
            ),
          )

          const requestedStartModelId = grokModelSelection?.model
            ? resolveGrokAcpBaseModelId(grokModelSelection.model)
            : undefined
          const boundModelId = yield* applyGrokAcpModelSelection({
            runtime: acp,
            currentModelId: currentGrokModelIdFromSessionSetup(started.sessionSetupResult),
            requestedModelId: requestedStartModelId,
            mapError: (cause) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, 'session/set_model', cause),
          })

          const now = yield* nowIso
          const generationId = yield* randomUUIDv4
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: 'ready',
            runtimeMode: input.runtimeMode,
            cwd,
            ...(boundModelId ? { model: resolveGrokAcpBaseModelId(boundModelId) } : {}),
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: GROK_RESUME_VERSION,
              sessionId: started.sessionId,
              ...(parsedResume?.requireExisting === true ? { requireExisting: true } : {}),
            },
            createdAt: now,
            updatedAt: now,
          }

          const ctx: GrokSessionContext = {
            threadId: input.threadId,
            runtimeSessionBinding: input.runtimeSessionBinding,
            acpSessionId: started.sessionId,
            generationId,
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            pendingApprovals,
            pendingUserInputs,
            turns: [],
            lastPlanFingerprint: undefined,
            activeTurnId: undefined,
            interruptedTurnIds: new Set(),
            promptsInFlight: 0,
            currentModelId: boundModelId,
            finalizationState: yield* Ref.make<'open' | 'graceful' | 'abnormal'>('open'),
            stopped: false,
          }

          const nf = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* ()
              {
                if (event._tag === 'EventStreamBarrier')
                {
                  yield* Deferred.succeed(event.acknowledge, undefined)
                  return
                }
                if (
                  event._tag === 'PlanUpdated' ||
                  event._tag === 'ToolCallUpdated' ||
                  event._tag === 'ContentDelta'
                )
                {
                  yield* logNative(ctx.threadId, 'session/update', event.rawPayload)
                }

                if (event._tag === 'ModeChanged')
                {
                  return
                }

                const notificationTurnId = resolveNotificationTurnId(ctx)
                if (
                  notificationTurnId === undefined ||
                  ctx.interruptedTurnIds.has(notificationTurnId)
                )
                {
                  return
                }
                const stamp = yield* makeEventStamp()

                switch (event._tag)
                {
                  case 'AssistantItemStarted':
                    yield* offerRuntimeEvent(
                      ctx.runtimeSessionBinding,
                      makeAcpAssistantItemEvent({
                        stamp,
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        itemId: event.itemId,
                        lifecycle: 'item.started',
                      }),
                    )
                    return
                  case 'AssistantItemCompleted':
                    yield* offerRuntimeEvent(
                      ctx.runtimeSessionBinding,
                      makeAcpAssistantItemEvent({
                        stamp,
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        itemId: event.itemId,
                        lifecycle: 'item.completed',
                      }),
                    )
                    return
                  case 'PlanUpdated':
                    yield* emitPlanUpdate(
                      ctx,
                      notificationTurnId,
                      stamp,
                      event.payload,
                      event.rawPayload,
                      'session/update',
                    )
                    return
                  case 'ToolCallUpdated':
                    yield* offerRuntimeEvent(
                      ctx.runtimeSessionBinding,
                      makeAcpToolCallEvent({
                        stamp,
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        toolCall: event.toolCall,
                        rawPayload: event.rawPayload,
                      }),
                    )
                    return
                  case 'ContentDelta':
                    yield* offerRuntimeEvent(
                      ctx.runtimeSessionBinding,
                      makeAcpContentDeltaEvent({
                        stamp,
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    )
                    return
                }
              }),
            ),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logError('Failed to process Grok runtime notification.', { cause }),
            ),
            // session consumers outlive the request fiber that called startSession.
            Effect.forkIn(ctx.scope),
          )

          ctx.notificationFiber = nf
          sessions.set(input.threadId, ctx)
          sessionScopeTransferred = true

          yield* Stream.runForEach(Stream.take(acp.getTerminationEvents(), 1), (cause) =>
            finalizeSession(ctx, classifyAcpTermination(cause)),
          ).pipe(Effect.forkIn(ctx.scope))

          yield* offerRuntimeEvent(input.runtimeSessionBinding, {
            type: 'session.started',
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          })
          yield* offerRuntimeEvent(input.runtimeSessionBinding, {
            type: 'session.state.changed',
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: 'ready', reason: 'Grok ACP session ready' },
          })
          yield* offerRuntimeEvent(input.runtimeSessionBinding, {
            type: 'thread.started',
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          })

          return session
        }).pipe(Effect.scoped),
      )

    const sendTurn: GrokAdapterShape['sendTurn'] = (input) =>
      Effect.gen(function* ()
      {
        const prepared = yield* withThreadLock(
          input.threadId,
          Effect.gen(function* ()
          {
            const ctx = yield* requireSession(input.threadId)
            // a sendTurn while a prompt is in flight is a steer: the agent
            // folds the new prompt into the ongoing work, so the active turn
            // id is reused instead of opening a new turn.
            const steeringTurnId = ctx.promptsInFlight > 0 ? ctx.activeTurnId : undefined
            const turnId = steeringTurnId ?? TurnId.make(yield* randomUUIDv4)
            // count this prompt immediately so a superseded in-flight prompt
            // resolving from here on does not settle the turn; decremented on
            // preparation failure here, and after the prompt below otherwise.
            ctx.promptsInFlight += 1
            // bind the turn id before cooperative yields so interruptTurn can
            // settle this prompt even if stop arrives during preparation.
            ctx.activeTurnId = turnId
            ctx.session = {
              ...ctx.session,
              status: steeringTurnId === undefined ? 'connecting' : 'running',
              activeTurnId: turnId,
              updatedAt: yield* nowIso,
            }

            return yield* Effect.gen(function* ()
            {
              const turnModelSelection =
                input.modelSelection?.instanceId === boundInstanceId
                  ? input.modelSelection
                  : undefined
              const requestedTurnModelId = turnModelSelection?.model
                ? resolveGrokAcpBaseModelId(turnModelSelection.model)
                : undefined
              const currentModelId = yield* applyGrokAcpModelSelection({
                runtime: ctx.acp,
                currentModelId: ctx.currentModelId,
                requestedModelId: requestedTurnModelId,
                mapError: (cause) =>
                  mapAcpToAdapterError(PROVIDER, input.threadId, 'session/set_model', cause),
              })

              const text = input.input?.trim()
              const imagePromptParts = yield* Effect.forEach(
                (input.attachments ?? []).filter((attachment) => attachment.type === 'image'),
                (attachment) =>
                  Effect.gen(function* ()
                  {
                    const attachmentPath = resolveAttachmentPath({
                      attachmentsDir: serverConfig.attachmentsDir,
                      attachment,
                    })
                    if (!attachmentPath)
                    {
                      return yield* new ProviderAdapterRequestError({
                        provider: PROVIDER,
                        method: 'session/prompt',
                        detail: `Invalid attachment id '${attachment.id}'.`,
                      })
                    }
                    const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
                      Effect.mapError(
                        (cause) =>
                          new ProviderAdapterRequestError({
                            provider: PROVIDER,
                            method: 'session/prompt',
                            detail: cause.message,
                            cause,
                          }),
                      ),
                    )
                    return {
                      type: 'image',
                      data: Buffer.from(bytes).toString('base64'),
                      mimeType: attachment.mimeType,
                    } satisfies EffectAcpSchema.ContentBlock
                  }),
              )
              const promptParts: Array<EffectAcpSchema.ContentBlock> = [
                ...(text ? [{ type: 'text' as const, text }] : []),
                ...imagePromptParts,
              ]

              if (promptParts.length === 0)
              {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: 'sendTurn',
                  issue: 'Turn requires non-empty text or attachments.',
                })
              }

              ctx.currentModelId = currentModelId
              const displayModel = currentModelId
                ? resolveGrokAcpBaseModelId(currentModelId)
                : undefined
              for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1)
              {
                yield* Effect.yieldNow
              }
              if (ctx.interruptedTurnIds.has(turnId))
              {
                yield* settlePromptInFlight(ctx, turnId, {
                  completedStopReason: 'cancelled',
                  emitTurnCompletion: false,
                  settleAllPrompts: true,
                })
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: 'session/prompt',
                  detail: 'Grok prompt was interrupted during preparation.',
                })
              }
              if (steeringTurnId === undefined)
              {
                ctx.lastPlanFingerprint = undefined
              }
              ctx.session = {
                ...ctx.session,
                status: 'running',
                activeTurnId: turnId,
                updatedAt: yield* nowIso,
                ...(displayModel ? { model: displayModel } : {}),
              }

              if (steeringTurnId === undefined)
              {
                yield* offerRuntimeEvent(ctx.runtimeSessionBinding, {
                  type: 'turn.started',
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  payload: displayModel ? { model: displayModel } : {},
                })
              }

              return {
                context: ctx,
                acp: ctx.acp,
                acpSessionId: ctx.acpSessionId,
                displayModel,
                promptParts,
                turnId,
              }
            }).pipe(
              Effect.tapCause(() =>
                settlePromptInFlight(ctx, turnId, {
                  errorMessage: 'Grok prompt preparation failed.',
                  emitTurnCompletion: false,
                }),
              ),
            )
          }),
        )
        const promptSettled = yield* Ref.make(false)
        const promptRpcSucceeded = yield* Ref.make(false)
        const promptResultRef = yield* Ref.make<EffectAcpSchema.PromptResponse | undefined>(
          undefined,
        )

        const promptFailureMessageRef = yield* Ref.make<string | undefined>(undefined)

        return yield* Effect.gen(function* ()
        {
          const result = yield* prepared.acp
            .prompt({
              prompt: prepared.promptParts,
            })
            .pipe(
              Effect.tap((promptResult) =>
                Effect.all([
                  Ref.set(promptRpcSucceeded, true),
                  Ref.set(promptResultRef, promptResult),
                ]),
              ),
              Effect.tapError((error) =>
                Ref.set(
                  promptFailureMessageRef,
                  mapAcpToAdapterError(PROVIDER, input.threadId, 'session/prompt', error).message,
                ).pipe(
                  Effect.andThen(
                    Effect.suspend(() =>
                    {
                      const liveCtx = sessions.get(input.threadId)
                      return liveCtx === prepared.context && !prepared.context.stopped
                        ? prepared.acp.drainEvents
                        : Effect.void
                    }),
                  ),
                ),
              ),
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, 'session/prompt', error),
              ),
            )

          return yield* withThreadLock(
            input.threadId,
            Effect.gen(function* ()
            {
              const ctx = sessions.get(input.threadId)
              if (ctx !== prepared.context)
              {
                yield* settlePromptInFlight(prepared.context, prepared.turnId, {
                  errorMessage: 'Grok session changed before the turn completed.',
                  settleAllPrompts: true,
                })
                yield* Ref.set(promptSettled, true)
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: 'session/prompt',
                  detail: 'Grok session changed before the turn completed.',
                })
              }
              // keep prompt settlement atomic with respect to Stop and steering.
              // interruptTurn marks its target before waiting for this lock, so
              // cancellation can still win while queued ACP events are drained.
              for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1)
              {
                yield* Effect.yieldNow
              }
              yield* prepared.acp.drainEvents
              if (ctx.interruptedTurnIds.has(prepared.turnId))
              {
                yield* Ref.set(promptSettled, true)
                return {
                  threadId: input.threadId,
                  turnId: prepared.turnId,
                  resumeCursor: ctx.session.resumeCursor,
                }
              }

              if (
                ctx.promptsInFlight <= 0 ||
                ctx.activeTurnId !== prepared.turnId ||
                ctx.session.activeTurnId !== prepared.turnId
              )
              {
                yield* Ref.set(promptSettled, true)
                return {
                  threadId: input.threadId,
                  turnId: prepared.turnId,
                  resumeCursor: ctx.session.resumeCursor,
                }
              }

              appendPromptResultToTurn(ctx, prepared.turnId, prepared.promptParts, result)
              ctx.session = {
                ...ctx.session,
                status: 'running',
                activeTurnId: prepared.turnId,
                updatedAt: yield* nowIso,
                ...(prepared.displayModel ? { model: prepared.displayModel } : {}),
              }
              const remainingPrompts = Math.max(0, ctx.promptsInFlight - 1)
              ctx.promptsInFlight = remainingPrompts

              // only the last remaining prompt settles the turn. A steer-
              // superseded prompt resolving while another is in flight or
              // pending must leave the merged turn running.
              if (
                remainingPrompts === 0 &&
                ctx.activeTurnId === prepared.turnId &&
                ctx.session.activeTurnId === prepared.turnId
              )
              {
                if (ctx.interruptedTurnIds.has(prepared.turnId))
                {
                  yield* Ref.set(promptSettled, true)
                  return {
                    threadId: input.threadId,
                    turnId: prepared.turnId,
                    resumeCursor: ctx.session.resumeCursor,
                  }
                }
                const completedAt = yield* nowIso
                const { activeTurnId: _completedTurnId, ...readySession } = ctx.session
                ctx.activeTurnId = undefined
                ctx.session = {
                  ...readySession,
                  status: 'ready',
                  updatedAt: completedAt,
                  ...(prepared.displayModel ? { model: prepared.displayModel } : {}),
                }
                const completedStopReason = completedStopReasonFromPromptResponse(result)
                yield* offerRuntimeEvent(prepared.context.runtimeSessionBinding, {
                  type: 'turn.completed',
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: prepared.turnId,
                  payload: {
                    state: result.stopReason === 'cancelled' ? 'cancelled' : 'completed',
                    stopReason: completedStopReason,
                  },
                })
                ctx.interruptedTurnIds.delete(prepared.turnId)
                yield* Ref.set(promptSettled, true)
              }
              else if (remainingPrompts > 0)
              {
                yield* Ref.set(promptSettled, true)
              }

              return {
                threadId: input.threadId,
                turnId: prepared.turnId,
                resumeCursor: ctx.session.resumeCursor,
              }
            }),
          )
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* ()
            {
              if (yield* Ref.get(promptSettled))
              {
                return
              }

              if (yield* Ref.get(promptRpcSucceeded))
              {
                const promptResult = yield* Ref.get(promptResultRef)
                if (promptResult === undefined)
                {
                  return
                }
                yield* withThreadLock(
                  input.threadId,
                  Effect.gen(function* ()
                  {
                    const ctx = sessions.get(input.threadId)
                    if (ctx !== prepared.context)
                    {
                      yield* settlePromptInFlight(prepared.context, prepared.turnId, {
                        errorMessage: 'Grok session changed before the turn completed.',
                        settleAllPrompts: true,
                      })
                      return
                    }
                    if (ctx.interruptedTurnIds.has(prepared.turnId))
                    {
                      return
                    }
                    if (
                      ctx.promptsInFlight <= 0 ||
                      ctx.activeTurnId !== prepared.turnId ||
                      ctx.session.activeTurnId !== prepared.turnId
                    )
                    {
                      return
                    }
                    appendPromptResultToTurn(
                      ctx,
                      prepared.turnId,
                      prepared.promptParts,
                      promptResult,
                    )
                    yield* settlePromptInFlight(prepared.context, prepared.turnId, {
                      completedStopReason: completedStopReasonFromPromptResponse(promptResult),
                    })
                  }),
                )
                return
              }

              const errorMessage = yield* Ref.get(promptFailureMessageRef)
              yield* withThreadLock(
                input.threadId,
                settlePromptInFlight(prepared.context, prepared.turnId, {
                  errorMessage: errorMessage ?? 'Grok prompt request failed.',
                }),
              )
            }).pipe(Effect.catch(() => Effect.void)),
          ),
        )
      })

    const interruptTurn: GrokAdapterShape['interruptTurn'] = (threadId, turnId) =>
      Effect.gen(function* ()
      {
        const observed = yield* Effect.sync(() =>
        {
          const ctx = sessions.get(threadId)
          if (!ctx || ctx.stopped)
          {
            return {
              _tag: 'Proceed' as const,
              acpSessionId: undefined,
              interruptedTurnId: turnId,
            }
          }
          const activeTurnId = ctx.activeTurnId ?? ctx.session.activeTurnId
          if (turnId !== undefined && activeTurnId !== undefined && activeTurnId !== turnId)
          {
            return { _tag: 'Ignore' as const }
          }
          const interruptedTurnId = turnId ?? activeTurnId
          if (interruptedTurnId !== undefined)
          {
            ctx.interruptedTurnIds.add(interruptedTurnId)
          }
          return {
            _tag: 'Proceed' as const,
            acpSessionId: ctx.acpSessionId,
            interruptedTurnId,
          }
        })
        if (observed._tag === 'Ignore')
        {
          return
        }

        yield* withThreadLock(
          threadId,
          Effect.gen(function* ()
          {
            const ctx = yield* requireSession(threadId)
            if (observed.acpSessionId !== undefined && ctx.acpSessionId !== observed.acpSessionId)
            {
              return
            }
            const activeTurnId = ctx.activeTurnId ?? ctx.session.activeTurnId
            if (turnId !== undefined && activeTurnId !== undefined && activeTurnId !== turnId)
            {
              return
            }
            if (
              observed.interruptedTurnId !== undefined &&
              activeTurnId !== undefined &&
              activeTurnId !== observed.interruptedTurnId
            )
            {
              return
            }
            const interruptedTurnId =
              observed.interruptedTurnId ?? turnId ?? activeTurnId ?? ctx.session.activeTurnId
            yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals)
            yield* settlePendingUserInputsAsCancelled(ctx.pendingUserInputs)
            yield* Effect.ignore(
              ctx.acp.cancel.pipe(
                Effect.mapError((error) =>
                  mapAcpToAdapterError(PROVIDER, threadId, 'session/cancel', error),
                ),
              ),
            )
            if (interruptedTurnId)
            {
              ctx.interruptedTurnIds.add(interruptedTurnId)
              yield* settlePromptInFlight(ctx, interruptedTurnId, {
                completedStopReason: 'cancelled',
                settleAllPrompts: true,
              })
            }
            else if (
              ctx.promptsInFlight > 0 ||
              ctx.session.status === 'running' ||
              ctx.session.status === 'connecting'
            )
            {
              const updatedAt = yield* nowIso
              ctx.promptsInFlight = 0
              ctx.activeTurnId = undefined
              const { activeTurnId: _activeTurnId, ...readySession } = ctx.session
              ctx.session = {
                ...readySession,
                status: 'ready',
                updatedAt,
              }
            }
          }),
        )
      })

    const respondToRequest: GrokAdapterShape['respondToRequest'] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* ()
      {
        const ctx = yield* requireSession(threadId)
        const pending = ctx.pendingApprovals.get(requestId)
        if (!pending)
        {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: 'session/request_permission',
            detail: `Unknown pending approval request: ${requestId}`,
          })
        }
        yield* Deferred.succeed(pending.decision, decision)
      })

    const respondToUserInput: GrokAdapterShape['respondToUserInput'] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* ()
      {
        const ctx = yield* requireSession(threadId)
        const pending = ctx.pendingUserInputs.get(requestId)
        if (!pending)
        {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: '_x.ai/ask_user_question',
            detail: `Unknown pending user-input request: ${requestId}`,
          })
        }
        yield* Deferred.succeed(pending.resolution, { _tag: 'answered', answers })
      })

    const readThread: GrokAdapterShape['readThread'] = (threadId) =>
      Effect.gen(function* ()
      {
        const ctx = yield* requireSession(threadId)
        return { threadId, turns: ctx.turns }
      })

    const rollbackThread: GrokAdapterShape['rollbackThread'] = (threadId, numTurns) =>
      Effect.gen(function* ()
      {
        yield* requireSession(threadId)
        if (!Number.isInteger(numTurns) || numTurns < 1)
        {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: 'rollbackThread',
            issue: 'numTurns must be an integer >= 1.',
          })
        }
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: 'thread/rollback',
          detail: 'Grok ACP sessions do not support provider-side rollback yet.',
        })
      })

    const stopSession: GrokAdapterShape['stopSession'] = (threadId) =>
      sessionLifecycle.stopSession(threadId, gracefulStop)

    const stopAll: GrokAdapterShape['stopAll'] = () => sessionLifecycle.stopAll(gracefulStop)

    const getSessionRuntimeBinding: GrokAdapterShape['getSessionRuntimeBinding'] = (threadId) =>
      Effect.sync(() => sessions.get(threadId)?.runtimeSessionBinding)

    yield* Effect.addFinalizer(() =>
      Effect.ignore(stopAll()).pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    )

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub)

    return {
      provider: PROVIDER,
      capabilities: GROK_PROVIDER_CAPABILITIES,
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      getSessionRuntimeBinding,
      stopAll,
      streamEvents,
    } satisfies GrokAdapterShape
  })
}
