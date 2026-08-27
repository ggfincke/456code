// apps/server/src/provider/Layers/CoralAdapter.ts
// run baseline Coral sessions through ACP with exact lifecycle ownership

import {
  ApprovalRequestId,
  EventId,
  normalizeCollaborationMode,
  type CoralSettings,
  type ProviderApprovalDecision,
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
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'
import * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner'
import * as EffectAcpErrors from 'effect-acp/errors'
import type * as EffectAcpSchema from 'effect-acp/schema'

import { CORAL_PROVIDER_CAPABILITIES } from '../providerCapabilities.ts'
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
import { parsePermissionRequest } from '../acp/AcpRuntimeModel.ts'
import {
  applyCoralAcpInteractionMode,
  applyCoralAcpModelSelection,
  applyCoralAcpRuntimeMode,
  coralModelsFromSessionSetup,
  currentCoralModelFromSessionSetup,
  isCoralRuntimeMode,
  makeCoralAcpRuntime,
} from '../acp/CoralAcpSupport.ts'
import type {
  ProviderAdapterRuntimeEvent,
  ProviderAdapterRuntimeSessionBinding,
  ProviderAdapterShape,
} from '../Services/ProviderAdapter.ts'
import { makeAcpAdapterSessionLifecycle } from './AcpAdapterSessionLifecycle.ts'

const PROVIDER = ProviderDriverKind.make('coral')
const CORAL_RESUME_VERSION = 1 as const

export type CoralAdapterShape = ProviderAdapterShape<ProviderAdapterError>

export interface CoralAdapterLiveOptions
{
  readonly environment?: NodeJS.ProcessEnv
  readonly enableAbnormalTermination?: boolean
  readonly instanceId?: ProviderInstanceId
  // picker reads snapshot models; session/new is the first authoritative inventory
  readonly onSessionSetup?: (
    sessionSetupResult: Parameters<typeof coralModelsFromSessionSetup>[0],
  ) => Effect.Effect<void>
}

interface PendingApproval
{
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>
}

interface CoralSessionContext
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
  readonly interruptedTurnIds: Set<TurnId>
  readonly finalizationState: Ref.Ref<'open' | 'graceful' | 'abnormal'>
  stopped: boolean
}

function isRecord(value: unknown): value is Record<string, unknown>
{
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseCoralResume(raw: unknown): { readonly sessionId: string } | undefined
{
  if (!isRecord(raw) || raw.schemaVersion !== CORAL_RESUME_VERSION) return undefined
  if (typeof raw.sessionId !== 'string' || !raw.sessionId.trim()) return undefined
  return { sessionId: raw.sessionId.trim() }
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
  if (decision === 'acceptForSession' || decision === 'acceptAlways')
  {
    const always = request.options.find((option) => option.kind === 'allow_always')
    if (always?.optionId.trim()) return always.optionId.trim()
  }
  return request.options.find((option) => option.kind === 'allow_once')?.optionId.trim()
}

function settlePendingApprovals(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void>
{
  return Effect.forEach(
    pendingApprovals.values(),
    (pending) => Deferred.succeed(pending.decision, 'cancel').pipe(Effect.ignore),
    { discard: true },
  )
}

export function makeCoralAdapter(
  coralSettings: CoralSettings,
  options?: CoralAdapterLiveOptions,
): Effect.Effect<
  CoralAdapterShape,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Path.Path | Scope.Scope
>
{
  return Effect.gen(function* ()
  {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make('coral')
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const crypto = yield* Crypto.Crypto
    const path = yield* Path.Path
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderAdapterRuntimeEvent>()
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso)
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: 'crypto/randomUUIDv4',
            detail: 'Failed to generate a Coral runtime identifier.',
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
      CoralSessionContext,
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

    const startSession: CoralAdapterShape['startSession'] = (input) =>
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
          if (!isCoralRuntimeMode(input.runtimeMode))
          {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: 'startSession',
              issue: `Coral does not support runtime mode '${input.runtimeMode}'.`,
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
          const parsedResume = parseCoralResume(input.resumeCursor)
          if (input.resumeCursor !== undefined && parsedResume === undefined)
          {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: 'startSession',
              issue: 'Coral resume cursor is invalid or unsupported.',
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
          const sessionScope = yield* Scope.make('sequential')
          let scopeTransferred = false
          yield* Effect.addFinalizer(() =>
            scopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          )
          const acp = yield* makeCoralAcpRuntime({
            coralSettings,
            ...(options?.environment ? { environment: options.environment } : {}),
            childProcessSpawner,
            cwd,
            ...(parsedResume ? { resumeSessionId: parsedResume.sessionId } : {}),
            ...(modelSelection ? { model: modelSelection.model } : {}),
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
          yield* acp.handleRequestPermission((params) =>
            Effect.gen(function* ()
            {
              const permissionRequest = parsePermissionRequest(params)
              const requestId = ApprovalRequestId.make(yield* randomUUIDv4)
              const runtimeRequestId = RuntimeRequestId.make(requestId)
              const decision = yield* Deferred.make<ProviderApprovalDecision>()
              pendingApprovals.set(requestId, { decision })
              const context = sessions.get(input.threadId)
              const turnId = context?.activeTurnId
              yield* offerRuntimeEvent(
                input.runtimeSessionBinding,
                makeAcpRequestOpenedEvent({
                  stamp: yield* makeEventStamp(),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  requestId: runtimeRequestId,
                  permissionRequest,
                  detail: permissionRequest.detail ?? 'Coral requested tool permission.',
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
                  ? { outcome: 'selected' as const, optionId: selectedOptionId }
                  : ({ outcome: 'cancelled' } as const),
              }
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new EffectAcpErrors.AcpTransportError({
                    detail: 'Failed to process a Coral permission request.',
                    cause,
                  }),
              ),
            ),
          )
          const started = yield* acp
            .start()
            .pipe(
              Effect.mapError((cause) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, 'session/start', cause),
              ),
            )
          yield* applyCoralAcpRuntimeMode({
            runtime: acp,
            runtimeMode: input.runtimeMode,
            mapError: (cause) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, 'session/set_config_option', cause),
          })
          const currentModel = yield* applyCoralAcpModelSelection({
            runtime: acp,
            currentModel: currentCoralModelFromSessionSetup(started.sessionSetupResult),
            requestedModel: modelSelection?.model,
            mapError: (cause) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, 'session/set_config_option', cause),
          })
          if (options?.onSessionSetup)
          {
            yield* options.onSessionSetup(started.sessionSetupResult)
          }
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
              schemaVersion: CORAL_RESUME_VERSION,
              sessionId: started.sessionId,
            },
            createdAt: now,
            updatedAt: now,
          }
          const context: CoralSessionContext = {
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
            interruptedTurnIds: new Set(),
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
              const turnId = context.activeTurnId
              if (!turnId || context.interruptedTurnIds.has(turnId)) return
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
              Effect.logWarning('Failed to process a Coral ACP event.', { cause }),
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
            payload: { state: 'ready', reason: 'Coral ACP session ready' },
          })
          yield* offerRuntimeEvent(input.runtimeSessionBinding, {
            type: 'thread.started',
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          })
          return session
        }).pipe(Effect.scoped),
      )

    const sendTurn: CoralAdapterShape['sendTurn'] = (input) =>
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
                issue: 'Coral does not support input while a turn is active.',
              })
            }
            const collaborationMode = normalizeCollaborationMode(
              input.interactionMode ?? 'default',
              input.orchestrate,
            )
            if (collaborationMode.baseMode !== 'default')
            {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: 'sendTurn',
                issue: `Coral does not support interaction mode '${collaborationMode.baseMode}'.`,
              })
            }
            if ((input.attachments?.length ?? 0) > 0)
            {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: 'sendTurn',
                issue: 'Coral ACP does not support image attachments yet.',
              })
            }
            const text = input.input?.trim()
            if (!text)
            {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: 'sendTurn',
                issue: 'Turn requires non-empty text.',
              })
            }
            const modelSelection =
              input.modelSelection?.instanceId === boundInstanceId
                ? input.modelSelection
                : undefined
            yield* applyCoralAcpInteractionMode({
              runtime: context.acp,
              interactionMode: collaborationMode.baseMode,
              mapError: (cause) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, 'session/set_mode', cause),
            })
            context.currentModel = yield* applyCoralAcpModelSelection({
              runtime: context.acp,
              currentModel: context.currentModel,
              requestedModel: modelSelection?.model,
              mapError: (cause) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, 'session/set_config_option', cause),
            })
            const turnId = TurnId.make(yield* randomUUIDv4)
            const promptDone = yield* Deferred.make<void>()
            context.activeTurnId = turnId
            context.promptDone = promptDone
            context.session = {
              ...context.session,
              status: 'running',
              activeTurnId: turnId,
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
              promptParts: [{ type: 'text' as const, text }],
              resumeCursor: context.session.resumeCursor,
            }
          }),
        )

        // return before session/prompt settles so ProviderService can release
        // the instance lock during permission roundtrips
        yield* started.context.acp.prompt({ prompt: started.promptParts }).pipe(
          Effect.tap(() => started.context.acp.drainEvents),
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
                  started.context.interruptedTurnIds.delete(started.turnId)
                  return
                }
                started.context.turns = [
                  ...started.context.turns,
                  { id: started.turnId, items: [{ prompt: started.promptParts, result }] },
                ]
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
                const { activeTurnId: _activeTurnId, ...readySession } = started.context.session
                started.context.activeTurnId = undefined
                started.context.session = {
                  ...readySession,
                  status: 'ready',
                  updatedAt: yield* nowIso,
                }
              }),
            ),
          ),
          Effect.catchCause(() =>
            withThreadLock(
              input.threadId,
              Effect.gen(function* ()
              {
                if (started.context.activeTurnId !== started.turnId) return
                yield* offerRuntimeEvent(started.context.runtimeSessionBinding, {
                  type: 'turn.completed',
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  providerInstanceId: boundInstanceId,
                  threadId: input.threadId,
                  turnId: started.turnId,
                  payload: {
                    state: 'failed',
                    errorMessage: 'Coral ACP prompt failed.',
                  },
                })
                const { activeTurnId: _activeTurnId, ...readySession } = started.context.session
                started.context.activeTurnId = undefined
                started.context.session = {
                  ...readySession,
                  status: 'ready',
                  updatedAt: yield* nowIso,
                }
              }),
            ).pipe(Effect.ignore),
          ),
          Effect.ensuring(Deferred.succeed(started.promptDone, undefined).pipe(Effect.ignore)),
          Effect.forkIn(started.context.scope),
        )

        return {
          threadId: input.threadId,
          turnId: started.turnId,
          resumeCursor: started.resumeCursor,
        }
      })

    const interruptTurn: CoralAdapterShape['interruptTurn'] = (threadId, requestedTurnId) =>
      Effect.gen(function* ()
      {
        const context = yield* requireSession(threadId)
        const turnId = context.activeTurnId
        if (!turnId || (requestedTurnId !== undefined && requestedTurnId !== turnId)) return
        context.interruptedTurnIds.add(turnId)
        yield* context.acp.cancel.pipe(
          Effect.mapError((cause) =>
            mapAcpToAdapterError(PROVIDER, threadId, 'session/cancel', cause),
          ),
        )
        yield* offerRuntimeEvent(context.runtimeSessionBinding, {
          type: 'turn.completed',
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId,
          turnId,
          payload: { state: 'cancelled', stopReason: 'cancelled' },
        })
        const { activeTurnId: _activeTurnId, ...readySession } = context.session
        context.activeTurnId = undefined
        context.session = {
          ...readySession,
          status: 'ready',
          updatedAt: yield* nowIso,
        }
        if (context.promptDone !== undefined)
        {
          yield* Deferred.await(context.promptDone)
        }
      })

    const respondToRequest: CoralAdapterShape['respondToRequest'] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* ()
      {
        const context = yield* requireSession(threadId)
        const pending = context.pendingApprovals.get(requestId)
        if (!pending)
        {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: 'session/request_permission',
            detail: `Unknown pending Coral approval request: ${requestId}`,
          })
        }
        yield* Deferred.succeed(pending.decision, decision)
      })

    const respondToUserInput: CoralAdapterShape['respondToUserInput'] = () =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: 'respondToUserInput',
          issue: 'Coral does not support structured user input yet.',
        }),
      )

    const readThread: CoralAdapterShape['readThread'] = (threadId) =>
      requireSession(threadId).pipe(Effect.map((context) => ({ threadId, turns: context.turns })))

    const rollbackThread: CoralAdapterShape['rollbackThread'] = () =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: 'rollbackThread',
          issue: 'Coral conversation rollback is not supported yet.',
        }),
      )

    const stopSession: CoralAdapterShape['stopSession'] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* ()
        {
          const context = yield* requireSession(threadId)
          yield* finalizeSessionLocked(context, gracefulStop)
        }),
      )

    const getSessionRuntimeBinding: CoralAdapterShape['getSessionRuntimeBinding'] = (threadId) =>
      Effect.sync(() => sessions.get(threadId)?.runtimeSessionBinding)

    return {
      provider: PROVIDER,
      capabilities: CORAL_PROVIDER_CAPABILITIES,
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
    } satisfies CoralAdapterShape
  })
}
