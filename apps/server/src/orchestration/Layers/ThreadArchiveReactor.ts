// apps/server/src/orchestration/Layers/ThreadArchiveReactor.ts
// materializes and executes exact provider and terminal cleanup for archives

import {
  IsoDateTime,
  NonNegativeInt,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TrimmedNonEmptyString,
} from '@t3tools/contracts'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import { ReactorDeliveryError } from '../../persistence/Errors.ts'
import { OrchestrationReactorDelivery } from '../../persistence/Services/OrchestrationReactorDelivery.ts'
import { ProjectionThreadRepository } from '../../persistence/Services/ProjectionThreads.ts'
import { ProviderService } from '../../provider/Services/ProviderService.ts'
import * as TerminalManager from '../../terminal/Manager.ts'
import {
  DurableReactorRunner,
  type DurableReactorDefinition,
} from '../Services/DurableReactorRunner.ts'
import { ProjectionSnapshotQuery } from '../Services/ProjectionSnapshotQuery.ts'
import {
  ThreadArchiveReactor,
  type ThreadArchiveReactorShape,
} from '../Services/ThreadArchiveReactor.ts'
import { ThreadArchiveLifecyclePermit } from '../Services/ThreadArchiveLifecyclePermit.ts'
import { DurableReactorInfrastructureLive } from './OrchestrationReactor.ts'

const REACTOR_ID = 'thread-archive' as const
const OPERATION_VERSION = 1
const nowIso = Effect.map(DateTime.now, DateTime.formatIso)

const ProviderArchiveIdentity = Schema.Struct({
  provider: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId,
  threadId: ThreadId,
  sessionGeneration: NonNegativeInt,
  createdAt: IsoDateTime,
})

const TerminalArchiveIdentity = Schema.Struct({
  threadId: ThreadId,
  terminalId: TrimmedNonEmptyString,
  lifecycleId: TrimmedNonEmptyString,
  startedAt: IsoDateTime,
})

const ThreadArchivePayload = Schema.Struct({
  threadId: ThreadId,
  archiveGeneration: NonNegativeInt,
  archivedAt: IsoDateTime,
  providerIdentity: Schema.NullOr(ProviderArchiveIdentity),
  providerIdentities: Schema.optionalKey(Schema.Array(ProviderArchiveIdentity)),
  terminalIdentities: Schema.Array(TerminalArchiveIdentity),
})
type ThreadArchivePayload = typeof ThreadArchivePayload.Type
const StoredThreadArchivePayload = Schema.fromJsonString(ThreadArchivePayload)
const encodePayload = Schema.encodeEffect(StoredThreadArchivePayload)
const decodePayload = Schema.decodeUnknownEffect(StoredThreadArchivePayload)
const encodeOutcome = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      outcome: Schema.Literals(['archive-generation-stale', 'cleanup-complete']),
    }),
  ),
)

class ThreadArchivePayloadError extends Schema.TaggedErrorClass<ThreadArchivePayloadError>()(
  'ThreadArchivePayloadError',
  { detail: Schema.String },
)
{}
const isThreadArchivePayloadError = Schema.is(ThreadArchivePayloadError)

function targetIdFor(payload: ThreadArchivePayload): string
{
  return JSON.stringify([payload.threadId, payload.archiveGeneration])
}

function hasInvalidResourceIdentity(payload: ThreadArchivePayload): boolean
{
  const providerIdentityKeys = new Set<string>()
  const providerIdentities =
    payload.providerIdentities ??
    (payload.providerIdentity === null ? [] : [payload.providerIdentity])
  for (const identity of providerIdentities)
  {
    if (identity.threadId !== payload.threadId)
    {
      return true
    }
    const key = JSON.stringify([
      identity.providerInstanceId,
      identity.threadId,
      identity.sessionGeneration,
    ])
    if (providerIdentityKeys.has(key))
    {
      return true
    }
    providerIdentityKeys.add(key)
  }

  const terminalIdentityKeys = new Set<string>()
  for (const identity of payload.terminalIdentities)
  {
    if (identity.threadId !== payload.threadId)
    {
      return true
    }
    const key = JSON.stringify([identity.terminalId, identity.lifecycleId])
    if (terminalIdentityKeys.has(key))
    {
      return true
    }
    terminalIdentityKeys.add(key)
  }
  return false
}

function isPayloadFailure(cause: unknown): boolean
{
  return Schema.isSchemaError(cause) || isThreadArchivePayloadError(cause)
}

const make = Effect.gen(function* ()
{
  const delivery = yield* OrchestrationReactorDelivery
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery
  const projectionThreadRepository = yield* ProjectionThreadRepository
  const durableRunner = yield* DurableReactorRunner
  const providerService = yield* ProviderService
  const terminalManager = yield* TerminalManager.TerminalManager
  const threadArchiveLifecyclePermit = yield* ThreadArchiveLifecyclePermit

  const definition: DurableReactorDefinition = {
    reactorId: REACTOR_ID,
    operationVersion: OPERATION_VERSION,
    plan: (event) =>
    {
      if (event.type !== 'thread.archived')
      {
        return Effect.succeed([])
      }

      return Effect.gen(function* ()
      {
        const archiveGeneration = event.payload.archiveGeneration ?? 0
        const [providerIdentities, terminalIdentities] = yield* Effect.all(
          [
            providerService.captureSessionIdentities({
              threadId: event.payload.threadId,
            }),
            terminalManager.captureLifecycleIdentities({
              threadId: event.payload.threadId,
            }),
          ],
          { concurrency: 2 },
        )

        const payload: ThreadArchivePayload = {
          threadId: event.payload.threadId,
          archiveGeneration,
          archivedAt: event.payload.archivedAt,
          providerIdentity: providerIdentities[0] ?? null,
          providerIdentities,
          terminalIdentities: terminalIdentities.map((identity) => ({
            threadId: event.payload.threadId,
            terminalId: identity.terminalId,
            lifecycleId: identity.lifecycleId,
            startedAt: identity.startedAt,
          })),
        }
        return yield* encodePayload(payload).pipe(
          Effect.map((payloadJson) => [
            {
              outputIndex: 0,
              effectKind: 'thread.archive.cleanup-exact',
              targetKind: 'thread-archive-generation',
              targetId: targetIdFor(payload),
              payloadJson,
            },
          ]),
        )
      })
    },
    execute: Effect.fn('ThreadArchiveReactor.execute')(function* (action)
    {
      const payload = yield* decodePayload(action.payloadJson)
      if (
        action.targetId !== targetIdFor(payload) ||
        action.effectKind !== 'thread.archive.cleanup-exact' ||
        hasInvalidResourceIdentity(payload)
      )
      {
        return yield* new ThreadArchivePayloadError({
          detail: `Action ${action.actionId} does not match its persisted archive resource identity.`,
        })
      }

      return yield* threadArchiveLifecyclePermit.withPermit(
        payload.threadId,
        Effect.gen(function* ()
        {
          const archiveGenerationIsCurrent = projectionThreadRepository
            .getById({ threadId: payload.threadId })
            .pipe(
              Effect.map(
                (projected) =>
                  Option.isSome(projected) &&
                  projected.value.archivedAt === payload.archivedAt &&
                  projected.value.archiveGeneration === payload.archiveGeneration,
              ),
            )
          const staleResult = {
            status: 'succeeded' as const,
            resultJson: encodeOutcome({ outcome: 'archive-generation-stale' }),
          }

          if (!(yield* archiveGenerationIsCurrent))
          {
            return staleResult
          }

          const persistedProviderIdentities =
            payload.providerIdentities ??
            (payload.providerIdentity === null ? [] : [payload.providerIdentity])
          const currentProviderIdentities = yield* providerService.captureSessionIdentities({
            threadId: payload.threadId,
          })
          const providerIdentities = [
            ...new Map(
              [...persistedProviderIdentities, ...currentProviderIdentities].map((identity) => [
                JSON.stringify([
                  identity.providerInstanceId,
                  identity.threadId,
                  identity.sessionGeneration,
                ]),
                identity,
              ]),
            ).values(),
          ]
          if (
            hasInvalidResourceIdentity({
              ...payload,
              providerIdentity: providerIdentities[0] ?? null,
              providerIdentities,
            })
          )
          {
            return yield* new ThreadArchivePayloadError({
              detail: `Action ${action.actionId} contains a provider generation outside its archived thread target.`,
            })
          }
          for (const providerIdentity of providerIdentities)
          {
            if (yield* providerService.matchesSessionIdentity(providerIdentity))
            {
              yield* providerService.stopSessionIfExact(providerIdentity)
            }
          }
          const remainingProviderIdentities = yield* providerService.captureSessionIdentities({
            threadId: payload.threadId,
          })
          if (remainingProviderIdentities.length > 0)
          {
            return yield* new ReactorDeliveryError({
              operation: 'ThreadArchiveReactor.execute:provider-session.stop',
              cause: new Error(
                `Thread '${payload.threadId}' still has ${remainingProviderIdentities.length} open provider generation(s) after exact archive cleanup.`,
              ),
            })
          }

          for (const identity of payload.terminalIdentities)
          {
            yield* terminalManager.closeIfExact(identity)
          }

          return {
            status: 'succeeded' as const,
            resultJson: encodeOutcome({ outcome: 'cleanup-complete' }),
          }
        }),
      )
    }),
    classify: (cause) => (isPayloadFailure(cause) ? 'poison' : 'retryable'),
    onLeaseExpiry: 'retryable',
  }

  const start: ThreadArchiveReactorShape['start'] = Effect.fn('ThreadArchiveReactor.start')(
    function* ()
    {
      const startedAt = yield* nowIso
      const existingProgress = yield* delivery.getProgress(REACTOR_ID)
      const initialSequence = Option.isSome(existingProgress)
        ? 0
        : (yield* projectionSnapshotQuery.getSnapshotSequence().pipe(
            Effect.mapError(
              (cause) =>
                new ReactorDeliveryError({
                  operation: 'ThreadArchiveReactor.start:initialSequence',
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
  } satisfies ThreadArchiveReactorShape
})

export const ThreadArchiveReactorLive = Layer.effect(ThreadArchiveReactor, make).pipe(
  Layer.provideMerge(DurableReactorInfrastructureLive),
)
