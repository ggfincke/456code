// apps/server/src/orchestration/Layers/OrchestrationEngine.ts
// assemble orchestration engine Effect layer

import type {
  OrchestrationEvent,
  OrchestrationReadModel,
  ProjectId,
  ThreadId,
} from '@t3tools/contracts'
import { OrchestrationCommand } from '@t3tools/contracts'
import * as Cause from 'effect/Cause'
import * as Clock from 'effect/Clock'
import * as Crypto from 'effect/Crypto'
import * as DateTime from 'effect/DateTime'
import * as Deferred from 'effect/Deferred'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as Metric from 'effect/Metric'
import * as Option from 'effect/Option'
import * as PubSub from 'effect/PubSub'
import * as Queue from 'effect/Queue'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import {
  metricAttributes,
  orchestrationCommandAckDuration,
  orchestrationCommandsTotal,
  orchestrationCommandDuration,
} from '../../observability/Metrics.ts'
import { toPersistenceSqlError } from '../../persistence/Errors.ts'
import { AttachmentLifecycleRepository } from '../../persistence/Services/AttachmentLifecycle.ts'
import { CheckpointRevertOperations } from '../../persistence/Services/CheckpointRevertOperations.ts'
import { ProjectionTurnRepositoryLive } from '../../persistence/Layers/ProjectionTurns.ts'
import { ProviderRuntimeInboxLive } from '../../persistence/Layers/ProviderRuntimeInbox.ts'
import { OrchestrationEventStore } from '../../persistence/Services/OrchestrationEventStore.ts'
import { OrchestrationCommandReceiptRepository } from '../../persistence/Services/OrchestrationCommandReceipts.ts'
import { ProjectionTurnRepository } from '../../persistence/Services/ProjectionTurns.ts'
import { ProviderRuntimeInbox } from '../../persistence/Services/ProviderRuntimeInbox.ts'
import { checkpointRefForThreadTurn } from '../../checkpointing/Utils.ts'
import {
  OrchestrationCommandIdConflictError,
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
  type OrchestrationDispatchError,
  type OrchestrationProjectorDecodeError,
} from '../Errors.ts'
import { decideOrchestrationCommand } from '../decider.ts'
import { checkpointRevertOperationId } from './CheckpointRollbackJournal.ts'
import { createEmptyReadModel, projectEvent } from '../projector.ts'
import { OrchestrationProjectionPipeline } from '../Services/ProjectionPipeline.ts'
import { ProjectionSnapshotQuery } from '../Services/ProjectionSnapshotQuery.ts'
import {
  OrchestrationEngineService,
  type OrchestrationCausalSettlementAuthority,
  type OrchestrationEngineShape,
} from '../Services/OrchestrationEngine.ts'
import { ThreadArchiveLifecyclePermit } from '../Services/ThreadArchiveLifecyclePermit.ts'
import { ThreadArchiveLifecyclePermitLive } from './ThreadArchiveLifecyclePermit.ts'
const isOrchestrationCommandPreviouslyRejectedError = Schema.is(
  OrchestrationCommandPreviouslyRejectedError,
)
const isOrchestrationCommandIdConflictError = Schema.is(OrchestrationCommandIdConflictError)
const isOrchestrationCommandInvariantError = Schema.is(OrchestrationCommandInvariantError)
// external commands that can change the selected tree or provider lifecycle
// stay fenced from request acceptance through cleanup/manual resolution.
// internal projection and provider-settling commands remain allowed so the
// request's persisted source/inbox barriers can actually drain.
const checkpointRevertBlockedCommandTypes: ReadonlySet<OrchestrationCommand['type']> = new Set([
  'project.delete',
  'thread.delete',
  'thread.archive',
  'thread.unarchive',
  'thread.meta.update',
  'thread.runtime-mode.set',
  'thread.interaction-mode.set',
  'thread.worker-verdict.set',
  'thread.provider.switch',
  'thread.turn.start',
  'thread.turn.interrupt',
  'thread.approval.respond',
  'thread.user-input.respond',
  'thread.orchestrate-plan.respond',
  'thread.checkpoint.revert',
  'thread.session.stop',
  'thread.orchestrate-run-execution.admit',
  'thread.orchestrate-run-execution.update',
  'thread.messages.import',
])

interface CommandEnvelope
{
  command: OrchestrationCommand
  causalSettlementAuthority: OrchestrationCausalSettlementAuthority | null
  result: Deferred.Deferred<{ sequence: number }, OrchestrationDispatchError>
  startedAtMs: number
}

function commandToAggregateRef(command: OrchestrationCommand): {
  readonly aggregateKind: 'project' | 'thread'
  readonly aggregateId: ProjectId | ThreadId
}
{
  switch (command.type)
  {
    case 'project.create':
    case 'project.meta.update':
    case 'project.delete':
      return {
        aggregateKind: 'project',
        aggregateId: command.projectId,
      }
    default:
      return {
        aggregateKind: 'thread',
        aggregateId: command.threadId,
      }
  }
}

function aggregateEventKey(
  aggregateKind: OrchestrationEvent['aggregateKind'],
  aggregateId: OrchestrationEvent['aggregateId'],
): string
{
  return JSON.stringify([aggregateKind, aggregateId])
}

const makeOrchestrationEngine = Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient
  const eventStore = yield* OrchestrationEventStore
  const commandReceiptRepository = yield* OrchestrationCommandReceiptRepository
  const attachmentLifecycle = yield* AttachmentLifecycleRepository
  const checkpointRevertOperations = yield* CheckpointRevertOperations
  const projectionTurns = yield* ProjectionTurnRepository
  const providerRuntimeInbox = yield* ProviderRuntimeInbox
  const projectionPipeline = yield* OrchestrationProjectionPipeline
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery
  const threadArchiveLifecyclePermit = yield* ThreadArchiveLifecyclePermit
  const crypto = yield* Crypto.Crypto

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso)
  let commandReadModel = createEmptyReadModel(yield* nowIso)

  const commandQueue = yield* Queue.unbounded<CommandEnvelope>()
  const eventPubSub = yield* PubSub.unbounded<OrchestrationEvent>()
  const aggregateEventSubscribers = new Map<string, Set<Queue.Queue<OrchestrationEvent>>>()

  const publishEvent = Effect.fn('OrchestrationEngine.publishEvent')(function* (
    event: OrchestrationEvent,
  )
  {
    yield* PubSub.publish(eventPubSub, event)
    const subscribers = aggregateEventSubscribers.get(
      aggregateEventKey(event.aggregateKind, event.aggregateId),
    )
    if (subscribers === undefined)
    {
      return
    }
    yield* Effect.forEach(subscribers, (subscriber) => Queue.offer(subscriber, event), {
      discard: true,
    })
  })

  const projectEventsOntoReadModel = (
    baseReadModel: OrchestrationReadModel,
    events: ReadonlyArray<OrchestrationEvent>,
  ): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError, never> =>
    Effect.gen(function* ()
    {
      let nextReadModel = baseReadModel
      for (const event of events)
      {
        nextReadModel = yield* projectEvent(nextReadModel, event)
      }
      return nextReadModel
    })

  const processEnvelope = (envelope: CommandEnvelope): Effect.Effect<void> =>
  {
    const dispatchStartSequence = commandReadModel.snapshotSequence
    let processingStartedAtMs = 0
    const aggregateRef = commandToAggregateRef(envelope.command)
    const baseMetricAttributes = {
      commandType: envelope.command.type,
      aggregateKind: aggregateRef.aggregateKind,
    } as const
    const reconcileReadModelAfterDispatchFailure = Effect.gen(function* ()
    {
      const persistedEvents = yield* Stream.runCollect(
        eventStore.readFromSequence(dispatchStartSequence),
      ).pipe(Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)))
      if (persistedEvents.length === 0)
      {
        return
      }

      commandReadModel = yield* projectEventsOntoReadModel(commandReadModel, persistedEvents)

      for (const persistedEvent of persistedEvents)
      {
        yield* publishEvent(persistedEvent)
      }
    })

    return Effect.exit(
      Effect.gen(function* ()
      {
        processingStartedAtMs = yield* Clock.currentTimeMillis
        yield* Effect.annotateCurrentSpan({
          'orchestration.command_id': envelope.command.commandId,
          'orchestration.command_type': envelope.command.type,
          'orchestration.aggregate_kind': aggregateRef.aggregateKind,
          'orchestration.aggregate_id': aggregateRef.aggregateId,
        })

        const existingReceipt = yield* commandReceiptRepository.getByCommandId({
          commandId: envelope.command.commandId,
        })
        if (Option.isSome(existingReceipt))
        {
          // a receipt proves only the command accepted for this exact aggregate
          if (
            existingReceipt.value.aggregateKind !== aggregateRef.aggregateKind ||
            existingReceipt.value.aggregateId !== aggregateRef.aggregateId
          )
          {
            return yield* new OrchestrationCommandIdConflictError({
              commandId: envelope.command.commandId,
              receiptAggregateKind: existingReceipt.value.aggregateKind,
              receiptAggregateId: existingReceipt.value.aggregateId,
              commandAggregateKind: aggregateRef.aggregateKind,
              commandAggregateId: aggregateRef.aggregateId,
            })
          }
          if (existingReceipt.value.status === 'accepted')
          {
            return {
              sequence: existingReceipt.value.resultSequence,
            }
          }
          return yield* new OrchestrationCommandPreviouslyRejectedError({
            commandId: envelope.command.commandId,
            detail: existingReceipt.value.error ?? 'Previously rejected.',
            ...(existingReceipt.value.errorCode === null
              ? {}
              : { code: existingReceipt.value.errorCode }),
          })
        }

        const committedCommand = yield* sql
          .withTransaction(
            Effect.gen(function* ()
            {
              if (checkpointRevertBlockedCommandTypes.has(envelope.command.type))
              {
                let affectedThreadIds: ReadonlyArray<ThreadId> = []
                if (envelope.command.type === 'project.delete')
                {
                  const projectId = envelope.command.projectId
                  affectedThreadIds = commandReadModel.threads
                    .filter((thread) => thread.projectId === projectId)
                    .map((thread) => thread.id)
                }
                else if ('threadId' in envelope.command)
                {
                  affectedThreadIds = [envelope.command.threadId]
                }
                for (const threadId of affectedThreadIds)
                {
                  const activeRevert = yield* checkpointRevertOperations.getActiveByThread(threadId)
                  const authority = envelope.causalSettlementAuthority
                  const isCausallyPriorInternalSettlement =
                    envelope.command.type === 'thread.meta.update' &&
                    authority !== null &&
                    Option.isSome(activeRevert) &&
                    (authority.sourceKind === 'domain-event'
                      ? authority.sourceSequence < activeRevert.value.requestSourceSequence
                      : authority.sourceSequence <= activeRevert.value.providerInboxHighWater)
                  if (Option.isSome(activeRevert) && !isCausallyPriorInternalSettlement)
                  {
                    return yield* new OrchestrationCommandInvariantError({
                      commandType: envelope.command.type,
                      code: 'checkpoint-revert-in-progress',
                      detail:
                        `Checkpoint revert '${activeRevert.value.operationId}' is in progress ` +
                        `for thread '${threadId}' (phase '${activeRevert.value.phase}').`,
                    })
                  }
                }
              }

              const eventBase = yield* decideOrchestrationCommand({
                command: envelope.command,
                readModel: commandReadModel,
              }).pipe(
                Effect.provideService(Crypto.Crypto, crypto),
                Effect.mapError((cause) =>
                  isOrchestrationCommandInvariantError(cause)
                    ? cause
                    : new OrchestrationCommandInvariantError({
                        commandType: envelope.command.type,
                        detail: 'Failed to generate an event identifier.',
                        cause,
                      }),
                ),
              )
              const eventBases = Array.isArray(eventBase) ? eventBase : [eventBase]
              if (envelope.command.type === 'thread.checkpoint.revert')
              {
                const pendingTurn = yield* projectionTurns.getPendingTurnStartByThreadId({
                  threadId: envelope.command.threadId,
                })
                if (Option.isSome(pendingTurn))
                {
                  return yield* new OrchestrationCommandInvariantError({
                    commandType: envelope.command.type,
                    code: 'checkpoint-revert-turn-in-progress',
                    detail:
                      `Thread '${envelope.command.threadId}' has a queued turn start ` +
                      `for message '${pendingTurn.value.messageId}'.`,
                  })
                }
              }
              const savedEvents = yield* eventStore.appendAll(eventBases)
              if (envelope.command.type === 'thread.checkpoint.revert')
              {
                const requestEvent = savedEvents.find(
                  (event) => event.type === 'thread.checkpoint-revert-requested',
                )
                if (requestEvent === undefined)
                {
                  return yield* new OrchestrationCommandInvariantError({
                    commandType: envelope.command.type,
                    detail: 'Checkpoint revert command produced no request event.',
                  })
                }
                const admissionState = yield* providerRuntimeInbox.getAdmissionState
                yield* checkpointRevertOperations
                  .reserve({
                    operationId: checkpointRevertOperationId(envelope.command.commandId),
                    threadId: envelope.command.threadId,
                    targetRef: checkpointRefForThreadTurn(
                      envelope.command.threadId,
                      envelope.command.turnCount,
                    ),
                    targetTurnCount: envelope.command.turnCount,
                    requestSourceSequence: requestEvent.sequence,
                    providerInboxHighWater: Math.max(0, admissionState.nextSequence - 1),
                    now: requestEvent.occurredAt,
                  })
                  .pipe(
                    Effect.catchTag('CheckpointRevertOperationConflictError', (cause) =>
                      Effect.fail(
                        new OrchestrationCommandInvariantError({
                          commandType: envelope.command.type,
                          code: 'checkpoint-revert-in-progress',
                          detail: cause.message,
                        }),
                      ),
                    ),
                  )
              }
              const committedEvents: OrchestrationEvent[] = []
              let nextCommandReadModel = commandReadModel

              for (const savedEvent of savedEvents)
              {
                nextCommandReadModel = yield* projectEvent(nextCommandReadModel, savedEvent)
                yield* projectionPipeline.projectEvent(savedEvent)
                committedEvents.push(savedEvent)

                if (savedEvent.type === 'thread.message-sent')
                {
                  yield* attachmentLifecycle.associateAccepted({
                    commandId: envelope.command.commandId,
                    ownerSequence: savedEvent.sequence,
                    ownerEventType: savedEvent.type,
                    now: savedEvent.occurredAt,
                  })
                }
              }

              const lastSavedEvent = committedEvents.at(-1) ?? null
              if (lastSavedEvent === null)
              {
                return yield* new OrchestrationCommandInvariantError({
                  commandType: envelope.command.type,
                  detail: 'Command produced no events.',
                })
              }

              yield* commandReceiptRepository.upsert({
                commandId: envelope.command.commandId,
                aggregateKind: lastSavedEvent.aggregateKind,
                aggregateId: lastSavedEvent.aggregateId,
                acceptedAt: lastSavedEvent.occurredAt,
                resultSequence: lastSavedEvent.sequence,
                status: 'accepted',
                error: null,
                errorCode: null,
              })

              return {
                committedEvents,
                lastSequence: lastSavedEvent.sequence,
                nextCommandReadModel,
              } as const
            }),
          )
          .pipe(
            Effect.catchTag('SqlError', (sqlError) =>
              Effect.fail(
                toPersistenceSqlError('OrchestrationEngine.processEnvelope:transaction')(sqlError),
              ),
            ),
          )

        commandReadModel = committedCommand.nextCommandReadModel
        for (const [index, event] of committedCommand.committedEvents.entries())
        {
          yield* publishEvent(event)
          if (index === 0)
          {
            yield* Metric.update(
              Metric.withAttributes(
                orchestrationCommandAckDuration,
                metricAttributes({
                  ...baseMetricAttributes,
                  ackEventType: event.type,
                }),
              ),
              Duration.millis(Math.max(0, (yield* Clock.currentTimeMillis) - envelope.startedAtMs)),
            )
          }
        }
        return { sequence: committedCommand.lastSequence }
      }).pipe(Effect.withSpan(`orchestration.command.${envelope.command.type}`)),
    ).pipe(
      Effect.flatMap((exit) =>
        Effect.gen(function* ()
        {
          const outcome = Exit.isSuccess(exit)
            ? 'success'
            : Cause.hasInterruptsOnly(exit.cause)
              ? 'interrupt'
              : 'failure'
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandDuration,
              metricAttributes(baseMetricAttributes),
            ),
            Duration.millis(Math.max(0, (yield* Clock.currentTimeMillis) - processingStartedAtMs)),
          )
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandsTotal,
              metricAttributes({
                ...baseMetricAttributes,
                outcome,
              }),
            ),
            1,
          )

          if (Exit.isSuccess(exit))
          {
            yield* Deferred.succeed(envelope.result, exit.value)
            return
          }

          const error = Cause.squash(exit.cause) as OrchestrationDispatchError
          if (
            !isOrchestrationCommandPreviouslyRejectedError(error) &&
            !isOrchestrationCommandIdConflictError(error)
          )
          {
            yield* reconcileReadModelAfterDispatchFailure.pipe(
              Effect.catch(() =>
                Effect.logWarning(
                  'failed to reconcile orchestration read model after dispatch failure',
                ).pipe(
                  Effect.annotateLogs({
                    commandId: envelope.command.commandId,
                    snapshotSequence: commandReadModel.snapshotSequence,
                  }),
                ),
              ),
            )

            if (isOrchestrationCommandInvariantError(error))
            {
              yield* commandReceiptRepository
                .upsert({
                  commandId: envelope.command.commandId,
                  aggregateKind: aggregateRef.aggregateKind,
                  aggregateId: aggregateRef.aggregateId,
                  acceptedAt: yield* nowIso,
                  resultSequence: commandReadModel.snapshotSequence,
                  status: 'rejected',
                  error: error.message,
                  errorCode: error.code ?? null,
                })
                .pipe(Effect.catch(() => Effect.void))
            }
          }

          yield* Deferred.fail(envelope.result, error)
        }),
      ),
    )
  }

  yield* projectionPipeline.bootstrap
  commandReadModel = yield* projectionSnapshotQuery.getCommandReadModel()

  const worker = Effect.forever(Queue.take(commandQueue).pipe(Effect.flatMap(processEnvelope)))
  yield* Effect.forkScoped(worker)
  yield* Effect.logDebug('orchestration engine started').pipe(
    Effect.annotateLogs({ sequence: commandReadModel.snapshotSequence }),
  )

  const readEvents: OrchestrationEngineShape['readEvents'] = (fromSequenceExclusive, limit) =>
    eventStore.readFromSequence(fromSequenceExclusive, limit)

  const readThreadEvents: OrchestrationEngineShape['readThreadEvents'] = ({ threadId, ...range }) =>
    eventStore.readAggregateRange({ ...range, aggregateKind: 'thread', aggregateId: threadId })

  const getThreadReplayStats: OrchestrationEngineShape['getThreadReplayStats'] = ({
    threadId,
    ...range
  }) =>
    eventStore.getAggregateReplayStats({
      ...range,
      aggregateKind: 'thread',
      aggregateId: threadId,
    })

  const dispatchCommand = (
    command: OrchestrationCommand,
    causalSettlementAuthority: OrchestrationCausalSettlementAuthority | null,
  ) =>
    Effect.gen(function* ()
    {
      const result = yield* Deferred.make<{ sequence: number }, OrchestrationDispatchError>()
      yield* Queue.offer(commandQueue, {
        command,
        causalSettlementAuthority,
        result,
        startedAtMs: yield* Clock.currentTimeMillis,
      })
      return yield* Deferred.await(result)
    })

  const dispatch: OrchestrationEngineShape['dispatch'] = (command) =>
    command.type === 'thread.archive' || command.type === 'thread.unarchive'
      ? threadArchiveLifecyclePermit.withPermit(command.threadId, dispatchCommand(command, null))
      : dispatchCommand(command, null)

  const dispatchInternal: OrchestrationEngineShape['dispatchInternal'] = (command, authority) =>
    dispatchCommand(command, authority)

  const streamDomainEventsForAggregate: OrchestrationEngineShape['streamDomainEventsForAggregate'] =
    (aggregateKind, aggregateId) =>
    {
      const key = aggregateEventKey(aggregateKind, aggregateId)
      return Stream.unwrap(
        Effect.acquireRelease(
          Effect.gen(function* ()
          {
            const subscriber = yield* Queue.unbounded<OrchestrationEvent>()
            const subscribers = aggregateEventSubscribers.get(key) ?? new Set()
            subscribers.add(subscriber)
            aggregateEventSubscribers.set(key, subscribers)
            return subscriber
          }),
          (subscriber) =>
            Effect.sync(() =>
            {
              const subscribers = aggregateEventSubscribers.get(key)
              subscribers?.delete(subscriber)
              if (subscribers?.size === 0)
              {
                aggregateEventSubscribers.delete(key)
              }
            }).pipe(Effect.andThen(Queue.shutdown(subscriber))),
        ).pipe(Effect.map(Stream.fromQueue)),
      )
    }

  return {
    readEvents,
    readThreadEvents,
    getThreadReplayStats,
    dispatch,
    dispatchInternal,
    // each access creates a fresh PubSub subscription so that multiple
    // consumers (wsServer, ProviderRuntimeIngestion, CheckpointReactor, etc.)
    // each independently receive all domain events.
    get streamDomainEvents(): OrchestrationEngineShape['streamDomainEvents']
    {
      return Stream.fromPubSub(eventPubSub)
    },
    streamDomainEventsForAggregate,
    // the command read model's snapshotSequence tracks the latest committed
    // event sequence (updated on the worker fiber). A plain property read is a
    // consistent, committed value — reassignment of `commandReadModel` is
    // atomic on the single-threaded event loop.
    latestSequence: Effect.sync(() => commandReadModel.snapshotSequence),
  } satisfies OrchestrationEngineShape
})

export const OrchestrationEngineWithArchivePermitLive = Layer.effect(
  OrchestrationEngineService,
  makeOrchestrationEngine,
)

export const OrchestrationEngineLive = OrchestrationEngineWithArchivePermitLive.pipe(
  Layer.provide(ThreadArchiveLifecyclePermitLive),
  Layer.provide(ProjectionTurnRepositoryLive),
  Layer.provide(ProviderRuntimeInboxLive),
)
