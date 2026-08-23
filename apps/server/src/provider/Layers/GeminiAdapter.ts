// apps/server/src/provider/Layers/GeminiAdapter.ts
// run Gemini sessions through ACP with exact lifecycle ownership

import {
  ApprovalRequestId,
  EventId,
  normalizeCollaborationMode,
  type GeminiSettings,
  type ProviderApprovalDecision,
  type ProviderRuntimeCapabilities,
  type ProviderRuntimeEvent,
  type ProviderSession,
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
import * as Path from 'effect/Path'
import * as PubSub from 'effect/PubSub'
import * as Ref from 'effect/Ref'
import * as Result from 'effect/Result'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'
import * as FileSystem from 'effect/FileSystem'
import * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner'
import * as EffectAcpErrors from 'effect-acp/errors'
import type * as EffectAcpSchema from 'effect-acp/schema'
import { resolveAttachmentPath } from '../../attachments/attachmentStore.ts'

import { GEMINI_PROVIDER_CAPABILITIES } from '../providerCapabilities.ts'
import {
  ProviderAdapterProcessError,
  type ProviderAdapterError,
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
import {
  canonicalReplayUserMessage,
  parsePermissionRequest,
  SESSION_LOAD_REPLAY_TAIL_MISMATCH_DETAIL,
} from '../acp/AcpRuntimeModel.ts'
import {
  applyGeminiAcpModelSelection,
  currentGeminiModelIdFromSessionSetup,
  geminiAcpModeIdForRuntimeMode,
  geminiAcpModeIdForTurn,
  geminiCapabilitiesFromSessionSetup,
  geminiModeSupportFromSessionSetup,
  geminiModelsFromSessionSetup,
  isGeminiRuntimeMode,
  makeGeminiAcpRuntime,
} from '../acp/GeminiAcpSupport.ts'
import type {
  ProviderAdapterRuntimeEvent,
  ProviderAdapterRuntimeSessionBinding,
  ProviderAdapterShape,
} from '../Services/ProviderAdapter.ts'
import { makeAcpAdapterSessionLifecycle } from './AcpAdapterSessionLifecycle.ts'

const PROVIDER = ProviderDriverKind.make('gemini')
const GEMINI_RESUME_VERSION = 1 as const
const GEMINI_CANCEL_DRAIN_WINDOW = '2 seconds'

export type GeminiAdapterShape = ProviderAdapterShape<ProviderAdapterError>

export interface GeminiAdapterLiveOptions
{
  readonly environment?: NodeJS.ProcessEnv
  readonly attachmentsDir?: string
  readonly enableAbnormalTermination?: boolean
  readonly instanceId?: ProviderInstanceId
  readonly onSessionSetup?: (
    sessionSetupResult: Parameters<typeof geminiModelsFromSessionSetup>[0] &
      Parameters<typeof geminiCapabilitiesFromSessionSetup>[1],
  ) => Effect.Effect<void>
  readonly onSessionModelSwitchSupported?: () => Effect.Effect<void>
}

interface PendingApproval
{
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>
}

interface GeminiSessionContext
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
  turns: Array<{ id: TurnId; items: Array<unknown> }>
  activeTurnId: TurnId | undefined
  promptDone: Deferred.Deferred<void> | undefined
  currentModel: string | undefined
  readonly availableModelIds: ReadonlySet<string>
  readonly availableModeIds: ReadonlySet<string>
  readonly interruptedTurnIds: Set<TurnId>
  readonly toolCallTurnIds: Map<string, TurnId>
  recentInterruptedTurnId: TurnId | undefined
  readonly finalizationState: Ref.Ref<'open' | 'graceful' | 'abnormal'>
  stopped: boolean
}

function isRecord(value: unknown): value is Record<string, unknown>
{
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface GeminiResumeCursor
{
  readonly sessionId: string
  readonly historyTailSha256?: string
}

function parseGeminiResume(raw: unknown): GeminiResumeCursor | undefined
{
  if (!isRecord(raw) || raw.schemaVersion !== GEMINI_RESUME_VERSION) return undefined
  if (typeof raw.sessionId !== 'string' || !raw.sessionId.trim()) return undefined
  if (
    raw.historyTailSha256 !== undefined &&
    (typeof raw.historyTailSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.historyTailSha256))
  )
  {
    return undefined
  }
  return {
    sessionId: raw.sessionId.trim(),
    ...(typeof raw.historyTailSha256 === 'string'
      ? { historyTailSha256: raw.historyTailSha256 }
      : {}),
  }
}

function isReplayTailMismatch(error: EffectAcpErrors.AcpError): boolean
{
  return (
    error._tag === 'AcpTransportError' && error.detail === SESSION_LOAD_REPLAY_TAIL_MISMATCH_DETAIL
  )
}

function selectPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: Exclude<ProviderApprovalDecision, 'cancel'>,
): string | undefined
{
  if (decision === 'decline')
  {
    return request.options.find((option) => option.kind === 'reject_once')?.optionId.trim()
  }
  if (decision === 'acceptForSession')
  {
    const always = request.options.find((option) => option.kind === 'allow_always')
    if (always?.optionId.trim()) return always.optionId.trim()
  }
  return request.options.find((option) => option.kind === 'allow_once')?.optionId.trim()
}

function settlePendingApprovals(
  pendingApprovals: Map<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void>
{
  // clear before yielding so late UI responses cannot race a cancellation or
  // session finalization and resolve a request that the ACP child no longer owns.
  const pending = [...pendingApprovals.values()]
  pendingApprovals.clear()
  return Effect.forEach(
    pending,
    (pending) => Deferred.succeed(pending.decision, 'cancel').pipe(Effect.ignore),
    { discard: true },
  )
}

export function makeGeminiAdapter(
  geminiSettings: GeminiSettings,
  options?: GeminiAdapterLiveOptions,
): Effect.Effect<
  GeminiAdapterShape,
  never,
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | Scope.Scope
>
{
  return Effect.gen(function* ()
  {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make('gemini')
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const fileSystem = yield* FileSystem.FileSystem
    const crypto = yield* Crypto.Crypto
    const path = yield* Path.Path
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderAdapterRuntimeEvent>()
    let runtimeCapabilities: ProviderRuntimeCapabilities = GEMINI_PROVIDER_CAPABILITIES
    const markSessionModelSwitchSupported = Effect.suspend(() =>
    {
      if (runtimeCapabilities.sessionModelSwitch === 'in-session') return Effect.void
      runtimeCapabilities = {
        ...runtimeCapabilities,
        sessionModelSwitch: 'in-session',
      }
      return options?.onSessionModelSwitchSupported?.() ?? Effect.void
    })
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso)
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: 'crypto/randomUUIDv4',
            detail: 'Failed to generate a Gemini runtime identifier.',
            cause,
          }),
      ),
    )
    const sha256 = (value: string) =>
      crypto.digest('SHA-256', new TextEncoder().encode(value)).pipe(
        Effect.map((bytes) =>
          Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(''),
        ),
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: 'crypto/digest',
              detail: 'Failed to fingerprint Gemini continuation history.',
              cause,
            }),
        ),
      )
    const makeEventStamp = () =>
      Effect.all({
        eventId: Effect.map(randomUUIDv4, (id) => EventId.make(id)),
        createdAt: nowIso,
      })
    const offerRuntimeEvent = (
      binding: ProviderAdapterRuntimeSessionBinding,
      event: ProviderRuntimeEvent,
    ) =>
      PubSub.publish(runtimeEventPubSub, {
        binding,
        event: { ...event, providerInstanceId: boundInstanceId },
      }).pipe(Effect.asVoid)

    const sessionLifecycle = yield* makeAcpAdapterSessionLifecycle<
      GeminiSessionContext,
      ProviderAdapterError
    >({
      provider: PROVIDER,
      enableAbnormalTermination: options?.enableAbnormalTermination === true,
      settlePending: (context) =>
        Effect.gen(function* ()
        {
          yield* settlePendingApprovals(context.pendingApprovals)
          if (context.promptDone !== undefined)
          {
            yield* Deferred.succeed(context.promptDone, undefined).pipe(Effect.ignore)
          }
        }),
      emitSessionExited: (context, classification) =>
        Effect.gen(function* ()
        {
          yield* offerRuntimeEvent(context.runtimeSessionBinding, {
            type: 'session.exited',
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
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
    const gracefulStop = classifyAcpTermination({ _tag: 'AdapterStop' })

    // settle the local snapshot before publishing a terminal turn event.
    const settleTurn = (context: GeminiSessionContext, turnId: TurnId, updatedAt: string) =>
    {
      if (context.activeTurnId !== turnId) return
      const { activeTurnId: _activeTurnId, ...readySession } = context.session
      context.activeTurnId = undefined
      context.session = {
        ...readySession,
        status: 'ready',
        updatedAt,
      }
    }

    const completeInterruptedTurn = (context: GeminiSessionContext, turnId: TurnId) =>
      Effect.gen(function* ()
      {
        if (!context.interruptedTurnIds.delete(turnId)) return
        settleTurn(context, turnId, yield* nowIso)
        if (context.promptDone !== undefined)
        {
          yield* Deferred.succeed(context.promptDone, undefined).pipe(Effect.ignore)
        }
        yield* offerRuntimeEvent(context.runtimeSessionBinding, {
          type: 'turn.completed',
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          turnId,
          payload: { state: 'cancelled', stopReason: 'cancelled' },
        })
      })

    const startSession: GeminiAdapterShape['startSession'] = (input) =>
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
          if (!isGeminiRuntimeMode(input.runtimeMode))
          {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: 'startSession',
              issue: `Gemini does not support runtime mode '${input.runtimeMode}'.`,
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
          const parsedResume = parseGeminiResume(input.resumeCursor)
          if (input.resumeCursor !== undefined && parsedResume === undefined)
          {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: 'startSession',
              issue: 'Gemini resume cursor is invalid or unsupported.',
            })
          }
          const existing = sessions.get(input.threadId)
          if (existing && !existing.stopped)
          {
            yield* finalizeSessionLocked(existing, gracefulStop)
          }

          const cwd = path.resolve(input.cwd.trim())
          const modelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined
          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>()
          let sessionScope = yield* Scope.make('sequential')
          let scopeTransferred = false
          yield* Effect.addFinalizer(() =>
            scopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          )
          const createRuntime = (
            resume: GeminiResumeCursor | undefined,
          ): Effect.Effect<
            AcpSessionRuntime.AcpSessionRuntime['Service'],
            ProviderAdapterProcessError
          > =>
            makeGeminiAcpRuntime({
              geminiSettings,
              ...(options?.environment ? { environment: options.environment } : {}),
              apiKeyConfigured: Boolean(options?.environment?.GEMINI_API_KEY?.trim()),
              childProcessSpawner,
              cwd,
              ...(resume
                ? {
                    resumeSessionId: resume.sessionId,
                    expectedReplayUserMessageSha256: resume.historyTailSha256,
                  }
                : {}),
              clientInfo: { name: 'code456', version: '0.0.0' },
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
          const registerPermissionHandler = (
            runtime: AcpSessionRuntime.AcpSessionRuntime['Service'],
          ) =>
            runtime.handleRequestPermission((params) =>
              Effect.gen(function* ()
              {
                const permissionRequest = parsePermissionRequest(params)
                const requestId = ApprovalRequestId.make(yield* randomUUIDv4)
                const runtimeRequestId = RuntimeRequestId.make(requestId)
                const decision = yield* Deferred.make<ProviderApprovalDecision>()
                const registration = yield* withThreadLock(
                  input.threadId,
                  Effect.gen(function* ()
                  {
                    const context = sessions.get(input.threadId)
                    const turnId = context?.activeTurnId
                    if (
                      context === undefined ||
                      context.stopped ||
                      turnId === undefined ||
                      context.interruptedTurnIds.has(turnId)
                    )
                    {
                      return { registered: false as const, turnId }
                    }
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
                        detail: permissionRequest.detail ?? 'Gemini requested tool permission.',
                        args: params,
                        source: 'acp.jsonrpc',
                        method: 'session/request_permission',
                        rawPayload: params,
                      }),
                    )
                    return { registered: true as const, turnId }
                  }),
                )
                if (!registration.registered)
                {
                  yield* Deferred.succeed(decision, 'cancel').pipe(Effect.ignore)
                  return { outcome: { outcome: 'cancelled' as const } }
                }
                const resolved = yield* Deferred.await(decision)
                yield* withThreadLock(
                  input.threadId,
                  Effect.sync(() => pendingApprovals.delete(requestId)).pipe(Effect.asVoid),
                )
                yield* offerRuntimeEvent(
                  input.runtimeSessionBinding,
                  makeAcpRequestResolvedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: registration.turnId,
                    requestId: runtimeRequestId,
                    permissionRequest,
                    decision: resolved,
                  }),
                )
                const selectedOptionId =
                  resolved === 'cancel' ? undefined : selectPermissionOptionId(params, resolved)
                return {
                  outcome: selectedOptionId
                    ? { outcome: 'selected' as const, optionId: selectedOptionId }
                    : ({ outcome: 'cancelled' } as const),
                }
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new EffectAcpErrors.AcpTransportError({
                      detail: 'Failed to process a Gemini permission request.',
                      cause,
                    }),
                ),
              ),
            )
          const verifiedResume = parsedResume?.historyTailSha256 ? parsedResume : undefined
          let continuationLossReason =
            parsedResume && !verifiedResume
              ? 'The stored Gemini continuation predates replay-tail verification.'
              : undefined
          let acp = yield* createRuntime(verifiedResume)
          yield* registerPermissionHandler(acp)
          let startedResult = yield* acp.start().pipe(Effect.result)
          if (verifiedResume !== undefined && Result.isFailure(startedResult))
          {
            continuationLossReason = isReplayTailMismatch(startedResult.failure)
              ? 'Gemini replay did not reach the locally known history tail.'
              : `Gemini could not load the stored ACP session: ${startedResult.failure.message}`
            yield* Scope.close(sessionScope, Exit.void)
            sessionScope = yield* Scope.make('sequential')
            acp = yield* createRuntime(undefined)
            yield* registerPermissionHandler(acp)
            startedResult = yield* acp.start().pipe(Effect.result)
          }
          const started = Result.isFailure(startedResult)
            ? yield* mapAcpToAdapterError(
                PROVIDER,
                input.threadId,
                'session/start',
                startedResult.failure,
              )
            : startedResult.success
          const modeSupport = geminiModeSupportFromSessionSetup(started.sessionSetupResult)
          runtimeCapabilities = geminiCapabilitiesFromSessionSetup(
            runtimeCapabilities,
            started.sessionSetupResult,
          )
          const requestedModeId = geminiAcpModeIdForRuntimeMode(
            input.runtimeMode,
            modeSupport.availableModeIds,
          )
          if (requestedModeId === undefined)
          {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: 'startSession',
              issue: `Gemini ACP did not advertise a mode for runtime mode '${input.runtimeMode}'.`,
            })
          }
          yield* acp
            .setMode(requestedModeId)
            .pipe(
              Effect.mapError((cause) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, 'session/set_mode', cause),
              ),
            )
          const sessionModels = geminiModelsFromSessionSetup(started.sessionSetupResult)
          const availableModelIds = new Set(sessionModels.map((model) => model.slug))
          if (
            modelSelection?.model !== undefined &&
            availableModelIds.size > 0 &&
            !availableModelIds.has(modelSelection.model)
          )
          {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: 'startSession',
              issue: `Gemini ACP did not advertise model '${modelSelection.model}'.`,
            })
          }
          const advertisedCurrentModel = currentGeminiModelIdFromSessionSetup(
            started.sessionSetupResult,
          )
          const currentModel = yield* applyGeminiAcpModelSelection({
            runtime: acp,
            currentModelId: advertisedCurrentModel,
            requestedModelId: modelSelection?.model,
            availableModelIds,
            mapError: (cause) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, 'session/set_model', cause),
          })
          if (
            modelSelection?.model !== undefined &&
            modelSelection.model !== advertisedCurrentModel
          )
          {
            yield* markSessionModelSwitchSupported
          }
          else if (currentModel !== undefined)
          {
            yield* acp.setSessionModel(currentModel).pipe(
              Effect.tap(() => markSessionModelSwitchSupported),
              Effect.catch(() => Effect.void),
            )
          }
          if (options?.onSessionSetup) yield* options.onSessionSetup(started.sessionSetupResult)
          const now = yield* nowIso
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: 'ready',
            runtimeMode: input.runtimeMode,
            cwd,
            ...(currentModel ? { model: currentModel } : {}),
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: GEMINI_RESUME_VERSION,
              sessionId: started.sessionId,
              ...(continuationLossReason === undefined && verifiedResume?.historyTailSha256
                ? { historyTailSha256: verifiedResume.historyTailSha256 }
                : {}),
            },
            createdAt: now,
            updatedAt: now,
          }
          const context: GeminiSessionContext = {
            threadId: input.threadId,
            runtimeSessionBinding: input.runtimeSessionBinding,
            acpSessionId: started.sessionId,
            generationId: yield* randomUUIDv4,
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            pendingApprovals,
            turns: [],
            activeTurnId: undefined,
            promptDone: undefined,
            currentModel,
            availableModelIds,
            availableModeIds: modeSupport.availableModeIds,
            interruptedTurnIds: new Set(),
            toolCallTurnIds: new Map(),
            recentInterruptedTurnId: undefined,
            finalizationState: yield* Ref.make<'open' | 'graceful' | 'abnormal'>('open'),
            stopped: false,
          }

          context.notificationFiber = yield* Stream.runForEach(acp.getEvents(), (event) =>
            Effect.gen(function* ()
            {
              if (event._tag === 'EventStreamBarrier')
              {
                yield* Deferred.succeed(event.acknowledge, undefined)
                return
              }
              if (event._tag === 'ModeChanged') return
              const terminalToolUpdate =
                event._tag === 'ToolCallUpdated' &&
                (event.toolCall.status === 'completed' || event.toolCall.status === 'failed')
              const mappedToolTurnId =
                event._tag === 'ToolCallUpdated'
                  ? context.toolCallTurnIds.get(event.toolCall.toolCallId)
                  : undefined
              const turnId =
                mappedToolTurnId ??
                context.activeTurnId ??
                (terminalToolUpdate ? context.recentInterruptedTurnId : undefined)
              if (!turnId) return
              if (event._tag === 'ToolCallUpdated')
              {
                if (terminalToolUpdate)
                {
                  context.toolCallTurnIds.delete(event.toolCall.toolCallId)
                }
                else
                {
                  context.toolCallTurnIds.set(event.toolCall.toolCallId, turnId)
                }
              }
              const interrupted =
                context.interruptedTurnIds.has(turnId) || context.recentInterruptedTurnId === turnId
              if (interrupted && !terminalToolUpdate)
              {
                return
              }
              const stamp = yield* makeEventStamp()
              switch (event._tag)
              {
                case 'AssistantItemStarted':
                  yield* offerRuntimeEvent(
                    context.runtimeSessionBinding,
                    makeAcpAssistantItemEvent({
                      stamp,
                      provider: PROVIDER,
                      threadId: context.threadId,
                      turnId,
                      itemId: event.itemId,
                      lifecycle: 'item.started',
                    }),
                  )
                  return
                case 'AssistantItemCompleted':
                  yield* offerRuntimeEvent(
                    context.runtimeSessionBinding,
                    makeAcpAssistantItemEvent({
                      stamp,
                      provider: PROVIDER,
                      threadId: context.threadId,
                      turnId,
                      itemId: event.itemId,
                      lifecycle: 'item.completed',
                    }),
                  )
                  return
                case 'PlanUpdated':
                  yield* offerRuntimeEvent(
                    context.runtimeSessionBinding,
                    makeAcpPlanUpdatedEvent({
                      stamp,
                      provider: PROVIDER,
                      threadId: context.threadId,
                      turnId,
                      payload: event.payload,
                      source: 'acp.jsonrpc',
                      method: 'session/update',
                      rawPayload: event.rawPayload,
                    }),
                  )
                  return
                case 'ToolCallUpdated':
                  yield* offerRuntimeEvent(
                    context.runtimeSessionBinding,
                    makeAcpToolCallEvent({
                      stamp,
                      provider: PROVIDER,
                      threadId: context.threadId,
                      turnId,
                      toolCall: event.toolCall,
                      rawPayload: event.rawPayload,
                    }),
                  )
                  return
                case 'ContentDelta':
                  yield* offerRuntimeEvent(
                    context.runtimeSessionBinding,
                    makeAcpContentDeltaEvent({
                      stamp,
                      provider: PROVIDER,
                      threadId: context.threadId,
                      turnId,
                      ...(event.itemId ? { itemId: event.itemId } : {}),
                      text: event.text,
                      rawPayload: event.rawPayload,
                    }),
                  )
                  return
              }
            }),
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning('Failed to process a Gemini ACP event.', { cause }),
            ),
            Effect.forkIn(sessionScope),
          )
          sessions.set(input.threadId, context)
          scopeTransferred = true
          yield* Stream.runForEach(Stream.take(acp.getTerminationEvents(), 1), (cause) =>
            finalizeSession(context, classifyAcpTermination(cause)),
          ).pipe(Effect.forkIn(sessionScope))

          yield* offerRuntimeEvent(input.runtimeSessionBinding, {
            type: 'session.started',
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          })
          yield* offerRuntimeEvent(input.runtimeSessionBinding, {
            type: 'session.state.changed',
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: input.threadId,
            payload: { state: 'ready', reason: 'Gemini ACP session ready' },
          })
          yield* offerRuntimeEvent(input.runtimeSessionBinding, {
            type: 'thread.started',
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          })
          if (continuationLossReason !== undefined)
          {
            yield* offerRuntimeEvent(input.runtimeSessionBinding, {
              type: 'runtime.warning',
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              threadId: input.threadId,
              payload: {
                message: 'Gemini continuation was not verified; a fresh session was started.',
                detail: {
                  reason: continuationLossReason,
                  previousSessionId: parsedResume?.sessionId,
                  sessionId: started.sessionId,
                },
              },
            })
          }
          return session
        }).pipe(Effect.scoped),
      )

    const sendTurn: GeminiAdapterShape['sendTurn'] = (input) =>
      Effect.gen(function* ()
      {
        const started = yield* withThreadLock(
          input.threadId,
          Effect.gen(function* ()
          {
            const context = yield* requireSession(input.threadId)
            const promptPending =
              context.promptDone !== undefined && !(yield* Deferred.isDone(context.promptDone))
            if (context.activeTurnId !== undefined || promptPending)
            {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: 'sendTurn',
                issue: 'Gemini does not support input while a turn is active.',
              })
            }
            const collaborationMode = normalizeCollaborationMode(
              input.interactionMode ?? 'default',
              input.orchestrate,
            )
            const sessionRuntimeMode = context.session.runtimeMode
            if (!isGeminiRuntimeMode(sessionRuntimeMode))
            {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: 'sendTurn',
                issue: `Gemini does not support runtime mode '${sessionRuntimeMode}'.`,
              })
            }
            const text = input.input?.trim()
            const modelSelection =
              input.modelSelection?.instanceId === boundInstanceId
                ? input.modelSelection
                : undefined
            if (
              modelSelection?.model !== undefined &&
              context.availableModelIds.size > 0 &&
              !context.availableModelIds.has(modelSelection.model)
            )
            {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: 'sendTurn',
                issue: `Gemini ACP did not advertise model '${modelSelection.model}'.`,
              })
            }
            const imagePromptParts = yield* Effect.forEach(input.attachments ?? [], (attachment) =>
              Effect.gen(function* ()
              {
                if (!attachment.mimeType.startsWith('image/'))
                {
                  return yield* new ProviderAdapterValidationError({
                    provider: PROVIDER,
                    operation: 'sendTurn',
                    issue: `Gemini does not support attachment type '${attachment.mimeType}'.`,
                  })
                }
                if (!options?.attachmentsDir)
                {
                  return yield* new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: 'session/prompt',
                    detail: 'Gemini attachment storage is not configured.',
                  })
                }
                const attachmentPath = resolveAttachmentPath({
                  attachmentsDir: options.attachmentsDir,
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
            if (!text && imagePromptParts.length === 0)
            {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: 'sendTurn',
                issue: 'Turn requires non-empty text or attachments.',
              })
            }
            const requestedModeId = geminiAcpModeIdForTurn({
              runtimeMode: sessionRuntimeMode,
              interactionMode: collaborationMode.baseMode,
              availableModeIds: context.availableModeIds,
            })
            if (requestedModeId === undefined)
            {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: 'sendTurn',
                issue: `Gemini ACP did not advertise interaction mode '${collaborationMode.baseMode}'.`,
              })
            }
            yield* context.acp
              .setMode(requestedModeId)
              .pipe(
                Effect.mapError((cause) =>
                  mapAcpToAdapterError(PROVIDER, input.threadId, 'session/set_mode', cause),
                ),
              )
            const previousModel = context.currentModel
            context.currentModel = yield* applyGeminiAcpModelSelection({
              runtime: context.acp,
              currentModelId: context.currentModel,
              requestedModelId: modelSelection?.model,
              availableModelIds: context.availableModelIds,
              mapError: (cause) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, 'session/set_model', cause),
            })
            if (context.currentModel !== previousModel) yield* markSessionModelSwitchSupported
            const promptParts: ReadonlyArray<EffectAcpSchema.ContentBlock> = [
              ...(text ? [{ type: 'text' as const, text }] : []),
              ...imagePromptParts,
            ]
            const historyTailSha256 = yield* sha256(canonicalReplayUserMessage(promptParts))
            const resumeCursor = {
              schemaVersion: GEMINI_RESUME_VERSION,
              sessionId: context.acpSessionId,
              historyTailSha256,
            } as const
            const turnId = TurnId.make(yield* randomUUIDv4)
            const promptDone = yield* Deferred.make<void>()
            const promptStarted = yield* Deferred.make<void>()
            context.activeTurnId = turnId
            context.promptDone = promptDone
            context.session = {
              ...context.session,
              status: 'running',
              activeTurnId: turnId,
              resumeCursor,
              updatedAt: yield* nowIso,
              ...(context.currentModel ? { model: context.currentModel } : {}),
            }
            yield* offerRuntimeEvent(context.runtimeSessionBinding, {
              type: 'turn.started',
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              threadId: input.threadId,
              turnId,
              payload: context.currentModel ? { model: context.currentModel } : {},
            })
            return {
              context,
              turnId,
              promptDone,
              promptStarted,
              promptParts,
              resumeCursor,
            }
          }),
        )

        // return before session/prompt settles so ProviderService can release
        // the instance lock during permission roundtrips
        yield* started.context.acp
          .prompt(
            { prompt: started.promptParts },
            Deferred.succeed(started.promptStarted, undefined).pipe(Effect.asVoid),
          )
          .pipe(
            Effect.tap(() => started.context.acp.drainEvents),
            Effect.ensuring(
              Effect.suspend(() =>
                started.context.interruptedTurnIds.has(started.turnId)
                  ? Effect.sleep(GEMINI_CANCEL_DRAIN_WINDOW).pipe(
                      Effect.andThen(started.context.acp.drainEvents),
                      Effect.ignore,
                    )
                  : Effect.void,
              ),
            ),
            Effect.mapError((cause) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, 'session/prompt', cause),
            ),
            Effect.flatMap((result) =>
              withThreadLock(
                input.threadId,
                Effect.gen(function* ()
                {
                  if (started.context.interruptedTurnIds.has(started.turnId))
                  {
                    yield* completeInterruptedTurn(started.context, started.turnId)
                    return
                  }
                  started.context.turns = [
                    ...started.context.turns,
                    { id: started.turnId, items: [{ prompt: started.promptParts, result }] },
                  ]
                  started.context.recentInterruptedTurnId = undefined
                  settleTurn(started.context, started.turnId, yield* nowIso)
                  yield* Deferred.succeed(started.promptDone, undefined).pipe(Effect.ignore)
                  yield* offerRuntimeEvent(started.context.runtimeSessionBinding, {
                    type: 'turn.completed',
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    providerInstanceId: boundInstanceId,
                    threadId: input.threadId,
                    turnId: started.turnId,
                    payload: {
                      state: result.stopReason === 'cancelled' ? 'cancelled' : 'completed',
                      stopReason: result.stopReason,
                    },
                  })
                }),
              ),
            ),
            Effect.catchCause(() =>
              withThreadLock(
                input.threadId,
                Effect.gen(function* ()
                {
                  if (started.context.interruptedTurnIds.has(started.turnId))
                  {
                    yield* completeInterruptedTurn(started.context, started.turnId)
                    return
                  }
                  if (started.context.activeTurnId !== started.turnId) return
                  settleTurn(started.context, started.turnId, yield* nowIso)
                  yield* Deferred.succeed(started.promptDone, undefined).pipe(Effect.ignore)
                  yield* offerRuntimeEvent(started.context.runtimeSessionBinding, {
                    type: 'turn.completed',
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    providerInstanceId: boundInstanceId,
                    threadId: input.threadId,
                    turnId: started.turnId,
                    payload: {
                      state: 'failed',
                      errorMessage: 'Gemini ACP prompt failed.',
                    },
                  })
                }),
              ).pipe(Effect.ignore),
            ),
            Effect.ensuring(Deferred.succeed(started.promptDone, undefined).pipe(Effect.ignore)),
            Effect.forkIn(started.context.scope, { startImmediately: true }),
          )
        yield* Deferred.await(started.promptStarted)

        return {
          threadId: input.threadId,
          turnId: started.turnId,
          resumeCursor: started.resumeCursor,
        }
      })

    const interruptTurn: GeminiAdapterShape['interruptTurn'] = (threadId, requestedTurnId) =>
      Effect.gen(function* ()
      {
        const interrupted = yield* withThreadLock(
          threadId,
          Effect.gen(function* ()
          {
            const context = yield* requireSession(threadId)
            const turnId = context.activeTurnId
            if (!turnId || (requestedTurnId !== undefined && requestedTurnId !== turnId))
            {
              return undefined
            }
            context.interruptedTurnIds.add(turnId)
            context.recentInterruptedTurnId = turnId
            // settle handlers before canceling ACP so they observe cancellation;
            // late UI responses must fail instead of affecting a new turn
            yield* settlePendingApprovals(context.pendingApprovals)
            return { context, turnId }
          }),
        )
        if (interrupted === undefined) return
        yield* interrupted.context.acp.cancel.pipe(
          Effect.mapError((cause) =>
            mapAcpToAdapterError(PROVIDER, threadId, 'session/cancel', cause),
          ),
        )
        // the prompt fiber drains terminal tool updates before it settles and
        // publishes the canonical cancellation event.
      })

    const respondToRequest: GeminiAdapterShape['respondToRequest'] = (
      threadId,
      requestId,
      decision,
    ) =>
      withThreadLock(
        threadId,
        Effect.gen(function* ()
        {
          const context = yield* requireSession(threadId)
          const pending = context.pendingApprovals.get(requestId)
          if (!pending)
          {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: 'session/request_permission',
              detail: `Unknown pending Gemini approval request: ${requestId}`,
            })
          }
          yield* Deferred.succeed(pending.decision, decision)
        }),
      )

    const respondToUserInput: GeminiAdapterShape['respondToUserInput'] = () =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: 'respondToUserInput',
          issue: 'Gemini does not support structured user input yet.',
        }),
      )

    const readThread: GeminiAdapterShape['readThread'] = (threadId) =>
      requireSession(threadId).pipe(Effect.map((context) => ({ threadId, turns: context.turns })))

    const rollbackThread: GeminiAdapterShape['rollbackThread'] = () =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: 'rollbackThread',
          issue: 'Gemini conversation rollback is not supported yet.',
        }),
      )

    const stopSession: GeminiAdapterShape['stopSession'] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* ()
        {
          const context = yield* requireSession(threadId)
          yield* finalizeSessionLocked(context, gracefulStop)
        }),
      )

    const getSessionRuntimeBinding: GeminiAdapterShape['getSessionRuntimeBinding'] = (threadId) =>
      Effect.sync(() => sessions.get(threadId)?.runtimeSessionBinding)

    return {
      provider: PROVIDER,
      get capabilities()
      {
        return runtimeCapabilities
      },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      getSessionRuntimeBinding,
      readThread,
      rollbackThread,
      stopAll: () => sessionLifecycle.stopAll(gracefulStop),
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies GeminiAdapterShape
  })
}
