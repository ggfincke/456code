// apps/server/src/orchestration/Layers/ThreadDeletionReactor.ts
// executes durable ordered cleanup after thread deletion

import {
  IsoDateTime,
  NonNegativeInt,
  OrchestrationEvent,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from '@t3tools/contracts'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import { ArchitectureAdmissionService } from '../../architecture/ArchitectureAdmissionService.ts'
import { CurrentWorktreeArchitectureService } from '../../cartographer/CurrentWorktreeArchitectureService.ts'
import { ReactorDeliveryError } from '../../persistence/Errors.ts'
import { OrchestrationReactorDelivery } from '../../persistence/Services/OrchestrationReactorDelivery.ts'
import { ProposalGenerationService } from '../../proposal/ProposalGenerationService.ts'
import { ProviderService } from '../../provider/Services/ProviderService.ts'
import * as TerminalManager from '../../terminal/Manager.ts'
import {
  DurableReactorRunner,
  type DurableReactorDefinition,
} from '../Services/DurableReactorRunner.ts'
import { DurableReactorInfrastructureLive } from './OrchestrationReactor.ts'
import { ThreadArchiveLifecyclePermit } from '../Services/ThreadArchiveLifecyclePermit.ts'
import { ProjectionSnapshotQuery } from '../Services/ProjectionSnapshotQuery.ts'
import {
  ThreadDeletionReactor,
  type ThreadDeletionReactorShape,
} from '../Services/ThreadDeletionReactor.ts'

const REACTOR_ID = 'thread-deletion' as const
const OPERATION_VERSION = 1
const EventPayload = Schema.fromJsonString(OrchestrationEvent)
const encodeEventPayload = Schema.encodeEffect(EventPayload)
const decodeEventPayload = Schema.decodeUnknownEffect(EventPayload)
const ProviderDeletionIdentity = Schema.Struct({
  provider: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId,
  threadId: ThreadId,
  sessionGeneration: NonNegativeInt,
  createdAt: IsoDateTime,
})
const ProviderDeletionPayload = Schema.Struct({
  event: OrchestrationEvent,
  providerIdentities: Schema.Array(ProviderDeletionIdentity),
})
const StoredProviderDeletionPayload = Schema.fromJsonString(ProviderDeletionPayload)
const encodeProviderDeletionPayload = Schema.encodeEffect(StoredProviderDeletionPayload)
const decodeProviderDeletionPayload = Schema.decodeUnknownEffect(StoredProviderDeletionPayload)
const nowIso = Effect.map(DateTime.now, DateTime.formatIso)

class ThreadDeletionPayloadError extends Schema.TaggedErrorClass<ThreadDeletionPayloadError>()(
  'ThreadDeletionPayloadError',
  { detail: Schema.String },
)
{}
const isThreadDeletionPayloadError = Schema.is(ThreadDeletionPayloadError)

function isPayloadError(cause: unknown): boolean
{
  return Schema.isSchemaError(cause) || isThreadDeletionPayloadError(cause)
}

function hasInvalidProviderIdentities(
  threadId: ThreadId,
  identities: ReadonlyArray<typeof ProviderDeletionIdentity.Type>,
): boolean
{
  const keys = new Set<string>()
  for (const identity of identities)
  {
    if (identity.threadId !== threadId)
    {
      return true
    }
    const key = JSON.stringify([
      identity.providerInstanceId,
      identity.threadId,
      identity.sessionGeneration,
    ])
    if (keys.has(key))
    {
      return true
    }
    keys.add(key)
  }
  return false
}

const make = Effect.gen(function* ()
{
  const delivery = yield* OrchestrationReactorDelivery
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery
  const durableRunner = yield* DurableReactorRunner
  const providerService = yield* ProviderService
  const threadArchiveLifecyclePermit = yield* ThreadArchiveLifecyclePermit
  const terminalManager = yield* TerminalManager.TerminalManager
  const proposalGenerationService = yield* ProposalGenerationService
  const architectureAdmissions = yield* ArchitectureAdmissionService
  const currentWorktrees = yield* CurrentWorktreeArchitectureService

  const definition: DurableReactorDefinition = {
    reactorId: REACTOR_ID,
    operationVersion: OPERATION_VERSION,
    plan: (event) =>
    {
      if (event.type !== 'thread.deleted')
      {
        return Effect.succeed([])
      }
      return Effect.gen(function* ()
      {
        const [payloadJson, providerPayloadJson] = yield* Effect.all([
          encodeEventPayload(event),
          providerService
            .captureSessionIdentities({ threadId: event.payload.threadId })
            .pipe(
              Effect.flatMap((providerIdentities) =>
                encodeProviderDeletionPayload({ event, providerIdentities }),
              ),
            ),
        ])
        return [
          {
            outputIndex: 0,
            effectKind: 'proposal-generation.cancel',
            targetKind: 'thread',
            targetId: event.payload.threadId,
            payloadJson,
          },
          {
            outputIndex: 1,
            effectKind: 'current-worktree-architecture.close',
            targetKind: 'thread',
            targetId: event.payload.threadId,
            payloadJson,
          },
          {
            outputIndex: 2,
            effectKind: 'provider-session.stop',
            targetKind: 'thread',
            targetId: event.payload.threadId,
            payloadJson: providerPayloadJson,
          },
          {
            outputIndex: 3,
            effectKind: 'terminal.close-and-delete-history',
            targetKind: 'thread',
            targetId: event.payload.threadId,
            payloadJson,
          },
        ]
      })
    },
    execute: Effect.fn('ThreadDeletionReactor.execute')(function* (action)
    {
      const providerPayload =
        action.effectKind === 'provider-session.stop'
          ? yield* decodeProviderDeletionPayload(action.payloadJson).pipe(Effect.result)
          : undefined
      const event =
        providerPayload?._tag === 'Success'
          ? providerPayload.success.event
          : yield* decodeEventPayload(action.payloadJson)
      if (event.type !== 'thread.deleted' || event.payload.threadId !== action.targetId)
      {
        return yield* new ThreadDeletionPayloadError({
          detail: `Action ${action.actionId} does not contain its thread.deleted target.`,
        })
      }

      switch (action.effectKind)
      {
        case 'proposal-generation.cancel':
          yield* architectureAdmissions.cancelThread(event.payload.threadId)
          yield* proposalGenerationService.cancelThread(event.payload.threadId)
          break
        // historical durable rows keep replaying through the neutral lifecycle owner
        case 'cartographer-embed.close':
        case 'atlas-context.close':
        case 'current-worktree-architecture.close':
          yield* currentWorktrees.closeThread(event.payload.threadId)
          break
        case 'provider-session.stop':
        {
          yield* threadArchiveLifecyclePermit.withPermit(
            event.payload.threadId,
            Effect.gen(function* ()
            {
              const persistedIdentities =
                providerPayload?._tag === 'Success'
                  ? providerPayload.success.providerIdentities
                  : []
              if (hasInvalidProviderIdentities(event.payload.threadId, persistedIdentities))
              {
                return yield* new ThreadDeletionPayloadError({
                  detail: `Action ${action.actionId} contains duplicate or cross-thread persisted provider identities.`,
                })
              }
              const currentIdentities = yield* providerService.captureSessionIdentities({
                threadId: event.payload.threadId,
              })
              const providerIdentities = [
                ...new Map(
                  [...persistedIdentities, ...currentIdentities].map((identity) => [
                    JSON.stringify([
                      identity.providerInstanceId,
                      identity.threadId,
                      identity.sessionGeneration,
                    ]),
                    identity,
                  ]),
                ).values(),
              ]
              if (hasInvalidProviderIdentities(event.payload.threadId, providerIdentities))
              {
                return yield* new ThreadDeletionPayloadError({
                  detail: `Action ${action.actionId} contains a provider generation outside its deleted thread target.`,
                })
              }
              for (const identity of providerIdentities)
              {
                if (yield* providerService.matchesSessionIdentity(identity))
                {
                  yield* providerService.stopSessionIfExact(identity)
                }
              }
              const remaining = yield* providerService.captureSessionIdentities({
                threadId: event.payload.threadId,
              })
              if (remaining.length > 0)
              {
                return yield* new ReactorDeliveryError({
                  operation: 'ThreadDeletionReactor.execute:provider-session.stop',
                  cause: new Error(
                    `Thread '${event.payload.threadId}' still has ${remaining.length} open provider generation(s) after exact deletion cleanup.`,
                  ),
                })
              }
            }),
          )
          break
        }
        case 'terminal.close-and-delete-history':
          yield* terminalManager.close({ threadId: event.payload.threadId, deleteHistory: true })
          break
        default:
          return yield* new ThreadDeletionPayloadError({
            detail: `Unsupported thread deletion effect kind '${action.effectKind}'.`,
          })
      }
      return { status: 'succeeded' as const }
    }),
    classify: (cause) => (isPayloadError(cause) ? 'poison' : 'retryable'),
    onLeaseExpiry: 'retryable',
  }

  const start: ThreadDeletionReactorShape['start'] = Effect.fn('ThreadDeletionReactor.start')(
    function* ()
    {
      const startedAt = yield* nowIso
      // an install that predates this reactor's durable progress row would
      // otherwise start at 0 and replay history as unhandled, re-running
      // deletion cleanup for threads deleted long ago
      const existingProgress = yield* delivery.getProgress(REACTOR_ID)
      const initialSequence = Option.isSome(existingProgress)
        ? 0
        : (yield* projectionSnapshotQuery.getSnapshotSequence().pipe(
            Effect.mapError(
              (cause) =>
                new ReactorDeliveryError({
                  operation: 'ThreadDeletionReactor.start:initialSequence',
                  cause,
                }),
            ),
          )).snapshotSequence
      const progress = yield* delivery.ensureProgress({
        reactorId: REACTOR_ID,
        operationVersion: OPERATION_VERSION,
        initialSequence,
        mode: 'durable',
        now: startedAt,
      })
      if (progress.mode === 'shadow')
      {
        yield* delivery.setMode({
          reactorId: REACTOR_ID,
          mode: 'durable',
          ownerId: `${REACTOR_ID}:cutover`,
          now: startedAt,
        })
      }
      yield* durableRunner.start(definition)
    },
  )

  return {
    start,
    drain: durableRunner.drain(REACTOR_ID),
    drainThrough: (sequence) => durableRunner.drainThrough(REACTOR_ID, sequence),
  } satisfies ThreadDeletionReactorShape
})

export const ThreadDeletionReactorLive = Layer.effect(ThreadDeletionReactor, make).pipe(
  Layer.provideMerge(DurableReactorInfrastructureLive),
)
