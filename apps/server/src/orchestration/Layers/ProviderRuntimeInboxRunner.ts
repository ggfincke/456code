// apps/server/src/orchestration/Layers/ProviderRuntimeInboxRunner.ts
// replays admitted provider events through independently fenced durable lanes

import { ProviderRuntimeEvent } from '@t3tools/contracts'
import { stableStringify } from '@t3tools/shared/relaySigning'
import * as Cause from 'effect/Cause'
import * as Crypto from 'effect/Crypto'
import * as DateTime from 'effect/DateTime'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as Metric from 'effect/Metric'
import * as Option from 'effect/Option'
import * as Queue from 'effect/Queue'
import * as Schema from 'effect/Schema'
import * as Semaphore from 'effect/Semaphore'
import * as Stream from 'effect/Stream'

import { ReactorDeliveryError } from '../../persistence/Errors.ts'
import { ProviderRuntimeInbox } from '../../persistence/Services/ProviderRuntimeInbox.ts'
import type {
  ProviderRuntimeInboxBuffer,
  ProviderRuntimeInboxConsumerId,
  ProviderRuntimeInboxRecord,
} from '../../persistence/Services/ProviderRuntimeInbox.ts'
import { OrchestrationReactorDelivery } from '../../persistence/Services/OrchestrationReactorDelivery.ts'
import type { ReactorActionRecord } from '../../persistence/Services/OrchestrationReactorDelivery.ts'
import {
  metricAttributes,
  providerRuntimeInboxAdmissionRequired,
  providerRuntimeInboxBacklog,
  providerRuntimeInboxConsumerLag,
  providerRuntimeInboxOldestPendingAgeSeconds,
  providerRuntimeInboxRetainedRecords,
} from '../../observability/Metrics.ts'
import {
  PROVIDER_RUNTIME_INBOX_EFFECT_KIND,
  PROVIDER_RUNTIME_INBOX_TARGET_KIND,
  ProviderRuntimeInboxRunner,
  type ProviderRuntimeInboxConsumerDefinition,
  type ProviderRuntimeInboxRunnerShape,
} from '../Services/ProviderRuntimeInboxRunner.ts'

const EVENT_PAGE_SIZE = 500
const LEASE_DURATION_MS = 30_000
const LEASE_RENEWAL_MS = 10_000
const POLL_INTERVAL_MS = 5_000
const RETRY_BASE_MS = 1_000
const RETRY_CAP_MS = 5 * 60_000
const MAX_ATTEMPTS = 8
const COMPLETED_RETENTION = '7 days'

interface ConsumerLane
{
  readonly definition: ProviderRuntimeInboxConsumerDefinition
  readonly ownerId: string
  readonly lock: Semaphore.Semaphore
  readonly wakeups: Queue.Queue<void>
}

class ProviderRuntimeInboxDecodeError extends Error
{
  readonly _tag = 'ProviderRuntimeInboxDecodeError'
}

const decodeRuntimeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(ProviderRuntimeEvent))
const isReactorDeliveryError = Schema.is(ReactorDeliveryError)
const nowIso = Effect.map(DateTime.now, DateTime.formatIso)

const addMilliseconds = (iso: string, milliseconds: number): string =>
  DateTime.formatIso(DateTime.addDuration(DateTime.makeUnsafe(iso), milliseconds))

const describeCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

const toRunnerError =
  (operation: string) =>
  (cause: unknown): ReactorDeliveryError =>
    isReactorDeliveryError(cause) ? cause : new ReactorDeliveryError({ operation, cause })

const targetIdForRecord = (record: ProviderRuntimeInboxRecord): string =>
  `provider-runtime-event:${record.sequence}:${record.eventDigest.slice(0, 16)}`

const make = Effect.gen(function* ()
{
  const inbox = yield* ProviderRuntimeInbox
  const delivery = yield* OrchestrationReactorDelivery
  const crypto = yield* Crypto.Crypto
  const lanes = new Map<ProviderRuntimeInboxConsumerId, ConsumerLane>()

  const wakeAllLanes = () =>
    Effect.forEach(lanes.values(), (lane) => Queue.offer(lane.wakeups, undefined), {
      discard: true,
    })

  const observeInbox = Effect.gen(function* ()
  {
    const diagnostics = yield* inbox.getDiagnostics
    const observedAt = yield* DateTime.now
    const oldestPendingAgeSeconds =
      diagnostics.oldestPendingReceivedAt === null
        ? 0
        : Math.max(
            0,
            (DateTime.toEpochMillis(observedAt) -
              DateTime.toEpochMillis(DateTime.makeUnsafe(diagnostics.oldestPendingReceivedAt))) /
              1_000,
          )
    yield* Metric.update(providerRuntimeInboxRetainedRecords, diagnostics.retainedRecordCount)
    yield* Metric.update(providerRuntimeInboxBacklog, diagnostics.backlogCount)
    yield* Metric.update(providerRuntimeInboxOldestPendingAgeSeconds, oldestPendingAgeSeconds)
    yield* Metric.update(
      providerRuntimeInboxAdmissionRequired,
      diagnostics.admissionMode === 'required' ? 1 : 0,
    )
    yield* Effect.forEach(
      diagnostics.consumers,
      (consumer) =>
        Metric.update(
          Metric.withAttributes(
            providerRuntimeInboxConsumerLag,
            metricAttributes({ consumer: consumer.consumerId }),
          ),
          consumer.lag,
        ),
      { discard: true },
    )
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning('provider runtime inbox diagnostics could not be observed', { cause }),
    ),
  )

  const requireLane = (consumerId: ProviderRuntimeInboxConsumerId) =>
    Effect.sync(() => lanes.get(consumerId)).pipe(
      Effect.flatMap((lane) =>
        lane === undefined
          ? Effect.fail(
              new ReactorDeliveryError({
                operation: `ProviderRuntimeInboxRunner.requireLane:${consumerId}`,
              }),
            )
          : Effect.succeed(lane),
      ),
    )

  const renewWhileRunning = (
    lane: ConsumerLane,
    actionId: string,
    leaseEpoch: number,
    leaseLost: Deferred.Deferred<void>,
  ) =>
    Effect.forever(
      Effect.sleep(LEASE_RENEWAL_MS).pipe(
        Effect.andThen(
          Effect.gen(function* ()
          {
            const renewed = yield* delivery.renewLease({
              actionId,
              ownerId: lane.ownerId,
              leaseEpoch,
              leaseDurationMs: LEASE_DURATION_MS,
              now: yield* nowIso,
            })
            if (!renewed)
            {
              yield* Deferred.succeed(leaseLost, undefined)
              return yield* Effect.interrupt
            }
          }),
        ),
      ),
    ).pipe(Effect.catchCause(() => Deferred.succeed(leaseLost, undefined).pipe(Effect.asVoid)))

  const restoreCheckpoint = (
    definition: ProviderRuntimeInboxConsumerDefinition,
    checkpoint: Option.Option<ProviderRuntimeInboxBuffer>,
  ) =>
    definition
      .restore(checkpoint)
      .pipe(
        Effect.mapError(
          toRunnerError(`ProviderRuntimeInboxRunner.restore:${definition.consumerId}`),
        ),
      )

  const executeWithRenewal = (
    lane: ConsumerLane,
    action: {
      readonly actionId: string
      readonly leaseEpoch: number
      readonly record: ProviderRuntimeInboxRecord
    },
    event: ProviderRuntimeEvent,
  ) =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const leaseLost = yield* Deferred.make<void>()
        yield* renewWhileRunning(lane, action.actionId, action.leaseEpoch, leaseLost).pipe(
          Effect.forkScoped,
        )
        return yield* Effect.raceFirst(
          lane.definition.process(action.record, event),
          Deferred.await(leaseLost).pipe(Effect.andThen(Effect.interrupt)),
        )
      }),
    )

  const recordExecution = Effect.fn('ProviderRuntimeInboxRunner.recordExecution')(function* (
    lane: ConsumerLane,
    action: ReactorActionRecord,
  )
  {
    if (action.leaseEpoch === null)
    {
      return yield* new ReactorDeliveryError({
        operation: 'ProviderRuntimeInboxRunner.recordExecution:missingLeaseEpoch',
      })
    }
    const recordOption = yield* inbox.get(action.sourceSequence)
    if (Option.isNone(recordOption))
    {
      yield* delivery.recordOutcome({
        actionId: action.actionId,
        ownerId: lane.ownerId,
        leaseEpoch: action.leaseEpoch,
        status: 'poison',
        error: `admitted provider event ${action.sourceSequence} is missing`,
        now: yield* nowIso,
      })
      return
    }
    const record = recordOption.value
    const previousCheckpoint = yield* inbox.getBuffer(lane.definition.consumerId)
    const eventExit = yield* Effect.exit(
      decodeRuntimeEvent(record.eventJson).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderRuntimeInboxDecodeError(
              `cannot decode admitted provider event ${record.sequence}: ${cause.message}`,
            ),
        ),
      ),
    )
    if (Exit.isFailure(eventExit))
    {
      yield* delivery.recordOutcome({
        actionId: action.actionId,
        ownerId: lane.ownerId,
        leaseEpoch: action.leaseEpoch,
        status: 'poison',
        error: describeCause(Cause.squash(eventExit.cause)),
        now: yield* nowIso,
      })
      return
    }

    const execution = yield* Effect.exit(
      executeWithRenewal(
        lane,
        { actionId: action.actionId, leaseEpoch: action.leaseEpoch, record },
        eventExit.value,
      ),
    )
    const recordedAt = yield* nowIso
    if (Exit.isSuccess(execution))
    {
      const completion = yield* Effect.exit(
        inbox.completeConsumerEvent({
          consumerId: lane.definition.consumerId,
          actionId: action.actionId,
          ownerId: lane.ownerId,
          leaseEpoch: action.leaseEpoch,
          record,
          stateVersion: execution.value.stateVersion,
          stateJson: execution.value.stateJson,
          sessionBufferTerminal: execution.value.sessionBufferTerminal,
          ...(execution.value.outcomeJson === undefined
            ? {}
            : { outcomeJson: execution.value.outcomeJson }),
          now: recordedAt,
        }),
      )
      if (Exit.isSuccess(completion) && completion.value)
      {
        yield* wakeAllLanes()
        return
      }
      const completionCause = Exit.isFailure(completion)
        ? Cause.squash(completion.cause)
        : new Error('consumer completion fence rejected the leased action')
      const restored = yield* Effect.exit(restoreCheckpoint(lane.definition, previousCheckpoint))
      if (Exit.isSuccess(restored))
      {
        return yield* toRunnerError(
          `ProviderRuntimeInboxRunner.complete:${lane.definition.consumerId}`,
        )(completionCause)
      }
      const restoreCause = Cause.squash(restored.cause)
      yield* delivery
        .recordOutcome({
          actionId: action.actionId,
          ownerId: lane.ownerId,
          leaseEpoch: action.leaseEpoch,
          status: 'manual',
          error: `consumer completion failed and its prior buffer could not be restored: ${describeCause(
            completionCause,
          )}; restore failed: ${describeCause(restoreCause)}`,
          now: recordedAt,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logError('failed to record provider runtime buffer restore failure', {
              consumerId: lane.definition.consumerId,
              cause,
            }),
          ),
        )
      return yield* new ReactorDeliveryError({
        operation: `ProviderRuntimeInboxRunner.completeRestore:${lane.definition.consumerId}`,
        cause: new AggregateError(
          [completionCause, restoreCause],
          'consumer completion and buffer restoration both failed',
        ),
      })
    }

    if (Cause.hasInterruptsOnly(execution.cause))
    {
      yield* restoreCheckpoint(lane.definition, previousCheckpoint)
      return yield* Effect.interrupt
    }

    const cause = Cause.squash(execution.cause)
    const restored = yield* Effect.exit(restoreCheckpoint(lane.definition, previousCheckpoint))
    const failureClass = Exit.isFailure(restored)
      ? ('manual' as const)
      : lane.definition.classify(cause, record)
    const status =
      failureClass === 'retryable' && action.attemptCount >= MAX_ATTEMPTS
        ? ('manual' as const)
        : failureClass
    const backoffMs = Math.min(
      RETRY_CAP_MS,
      RETRY_BASE_MS * 2 ** Math.max(0, action.attemptCount - 1),
    )
    yield* delivery.recordOutcome({
      actionId: action.actionId,
      ownerId: lane.ownerId,
      leaseEpoch: action.leaseEpoch,
      status,
      error: Exit.isFailure(restored)
        ? `consumer failed and its prior buffer could not be restored: ${describeCause(
            Cause.squash(restored.cause),
          )}`
        : describeCause(cause),
      ...(status === 'retryable' ? { nextAttemptAt: addMilliseconds(recordedAt, backoffMs) } : {}),
      now: recordedAt,
    })
  })

  const materializeBacklog = Effect.fn('ProviderRuntimeInboxRunner.materializeBacklog')(function* (
    lane: ConsumerLane,
    cursor: number,
    highWaterSequence: number | null,
  )
  {
    let afterSequence = cursor
    while (true)
    {
      const records = yield* inbox.readPage({ afterSequence, limit: EVENT_PAGE_SIZE })
      if (records.length === 0)
      {
        return
      }
      let reachedHighWater = false
      for (const record of records)
      {
        if (highWaterSequence !== null && record.sequence > highWaterSequence)
        {
          reachedHighWater = true
          break
        }
        if (
          lane.definition.prerequisite !== undefined &&
          !(yield* lane.definition
            .prerequisite(record)
            .pipe(
              Effect.mapError(
                toRunnerError(
                  `ProviderRuntimeInboxRunner.prerequisite:${lane.definition.consumerId}`,
                ),
              ),
            ))
        )
        {
          return
        }
        yield* delivery.materialize({
          reactorId: lane.definition.consumerId,
          operationVersion: lane.definition.operationVersion,
          sourceSequence: record.sequence,
          sourceEventId: `${record.providerInstanceId}:${record.sessionGeneration}:${record.sourceEventId}`,
          mode: 'durable',
          actions: [
            {
              outputIndex: 0,
              effectKind: PROVIDER_RUNTIME_INBOX_EFFECT_KIND,
              targetKind: PROVIDER_RUNTIME_INBOX_TARGET_KIND,
              targetId: targetIdForRecord(record),
              payloadJson: stableStringify({
                sequence: record.sequence,
                operationVersion: lane.definition.operationVersion,
              }),
            },
          ],
          now: yield* nowIso,
        })
        afterSequence = record.sequence
      }
      if (reachedHighWater || records.length < EVENT_PAGE_SIZE)
      {
        return
      }
    }
  })

  const claimAvailable = Effect.fn('ProviderRuntimeInboxRunner.claimAvailable')(function* (
    lane: ConsumerLane,
    throughSequence?: number,
  )
  {
    while (true)
    {
      const action = yield* delivery.claimNext({
        reactorId: lane.definition.consumerId,
        ownerId: lane.ownerId,
        leaseDurationMs: LEASE_DURATION_MS,
        now: yield* nowIso,
      })
      if (Option.isNone(action))
      {
        return
      }
      yield* recordExecution(lane, action.value)
      if (throughSequence !== undefined && action.value.sourceSequence >= throughSequence)
      {
        return
      }
    }
  })

  const drainLaneUnlocked = Effect.fn('ProviderRuntimeInboxRunner.drainLaneUnlocked')(function* (
    lane: ConsumerLane,
    throughSequence?: number,
  )
  {
    yield* delivery.recoverExpiredLeases({
      reactorId: lane.definition.consumerId,
      ownerId: lane.ownerId,
      policy: 'retryable',
      now: yield* nowIso,
    })
    const progressOption = yield* delivery.getProgress(lane.definition.consumerId)
    if (Option.isNone(progressOption))
    {
      return yield* new ReactorDeliveryError({
        operation: `ProviderRuntimeInboxRunner.drain:missingProgress:${lane.definition.consumerId}`,
      })
    }
    const progress = progressOption.value
    if (throughSequence !== undefined && progress.cursorSequence >= throughSequence)
    {
      return
    }
    if (progress.mode !== 'durable')
    {
      if (throughSequence === undefined)
      {
        return
      }
      return yield* new ReactorDeliveryError({
        operation: `ProviderRuntimeInboxRunner.drain:pausedBeforeHighWater:${lane.definition.consumerId}:${progress.cursorSequence}:${throughSequence}`,
      })
    }
    yield* materializeBacklog(lane, progress.cursorSequence, progress.highWaterSequence)
    yield* claimAvailable(lane, throughSequence)
    if (throughSequence !== undefined)
    {
      const completedProgress = yield* delivery.getProgress(lane.definition.consumerId)
      if (
        Option.isNone(completedProgress) ||
        completedProgress.value.cursorSequence < throughSequence
      )
      {
        const completedSequence = Option.match(completedProgress, {
          onNone: () => 'missing',
          onSome: (value) => String(value.cursorSequence),
        })
        return yield* new ReactorDeliveryError({
          operation: `ProviderRuntimeInboxRunner.drain:blockedBeforeHighWater:${lane.definition.consumerId}:${completedSequence}:${throughSequence}`,
        })
      }
    }

    const cutoff = DateTime.formatIso(
      DateTime.subtractDuration(DateTime.makeUnsafe(yield* nowIso), COMPLETED_RETENTION),
    )
    yield* inbox.pruneCompleted({ completedBefore: cutoff, now: yield* nowIso })
  })

  const drainLane = (lane: ConsumerLane, throughSequence?: number) =>
    lane.lock.withPermits(1)(
      drainLaneUnlocked(lane, throughSequence).pipe(
        Effect.mapError(
          toRunnerError(`ProviderRuntimeInboxRunner.drain:${lane.definition.consumerId}`),
        ),
        Effect.ensuring(observeInbox),
      ),
    )

  const drain: ProviderRuntimeInboxRunnerShape['drain'] = (consumerId) =>
    requireLane(consumerId).pipe(Effect.flatMap((lane) => drainLane(lane)))

  const drainThrough: ProviderRuntimeInboxRunnerShape['drainThrough'] = (consumerId, sequence) =>
    requireLane(consumerId).pipe(Effect.flatMap((lane) => drainLane(lane, sequence)))

  const start: ProviderRuntimeInboxRunnerShape['start'] = Effect.fn(
    'ProviderRuntimeInboxRunner.start',
  )(function* (definition)
  {
    if (lanes.has(definition.consumerId))
    {
      return yield* new ReactorDeliveryError({
        operation: `ProviderRuntimeInboxRunner.start:alreadyStarted:${definition.consumerId}`,
      })
    }
    const existing = yield* delivery.ensureProgress({
      reactorId: definition.consumerId,
      operationVersion: definition.operationVersion,
      initialSequence: 0,
      mode: 'durable',
      now: yield* nowIso,
    })
    const ownerId = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError(toRunnerError('ProviderRuntimeInboxRunner.start:ownerId')),
    )
    const progress = yield* delivery.setMode({
      reactorId: definition.consumerId,
      mode: existing.mode,
      ownerId,
      now: yield* nowIso,
    })
    const checkpoint = yield* inbox
      .getBuffer(definition.consumerId)
      .pipe(
        Effect.mapError(
          toRunnerError(`ProviderRuntimeInboxRunner.start:getBuffer:${definition.consumerId}`),
        ),
      )
    if (
      (Option.isNone(checkpoint) && progress.cursorSequence !== 0) ||
      (Option.isSome(checkpoint) && checkpoint.value.throughSequence !== progress.cursorSequence)
    )
    {
      return yield* new ReactorDeliveryError({
        operation: `ProviderRuntimeInboxRunner.start:bufferCursorMismatch:${definition.consumerId}`,
      })
    }
    yield* restoreCheckpoint(definition, checkpoint)

    const lane: ConsumerLane = {
      definition,
      ownerId,
      lock: yield* Semaphore.make(1),
      wakeups: yield* Queue.dropping<void>(1),
    }
    lanes.set(definition.consumerId, lane)
    yield* Effect.addFinalizer(() => Effect.sync(() => lanes.delete(definition.consumerId)))
    yield* drainLane(lane)

    yield* Stream.runForEach(inbox.wakeups, () => Queue.offer(lane.wakeups, undefined)).pipe(
      Effect.forkScoped,
    )
    yield* Effect.forever(
      Effect.raceFirst(Queue.take(lane.wakeups), Effect.sleep(POLL_INTERVAL_MS)).pipe(
        Effect.andThen(drainLane(lane)),
        Effect.catch((cause) =>
          Effect.logError('provider runtime inbox drain failed', {
            consumerId: definition.consumerId,
            cause: cause.message,
          }),
        ),
      ),
    ).pipe(Effect.forkScoped)
  })

  const pauseClaims: ProviderRuntimeInboxRunnerShape['pauseClaims'] = (consumerId) =>
    requireLane(consumerId).pipe(
      Effect.flatMap((lane) =>
        lane.lock.withPermits(1)(
          nowIso.pipe(
            Effect.flatMap((now) =>
              delivery.setMode({
                reactorId: consumerId,
                mode: 'paused',
                ownerId: lane.ownerId,
                now,
              }),
            ),
          ),
        ),
      ),
      Effect.asVoid,
    )

  const resumeClaims: ProviderRuntimeInboxRunnerShape['resumeClaims'] = (consumerId) =>
    requireLane(consumerId).pipe(
      Effect.flatMap((lane) =>
        lane.lock.withPermits(1)(
          nowIso.pipe(
            Effect.flatMap((now) =>
              delivery.setMode({
                reactorId: consumerId,
                mode: 'durable',
                ownerId: lane.ownerId,
                now,
              }),
            ),
            Effect.andThen(Queue.offer(lane.wakeups, undefined)),
          ),
        ),
      ),
      Effect.asVoid,
    )

  return ProviderRuntimeInboxRunner.of({
    start,
    drain,
    drainThrough,
    pauseClaims,
    resumeClaims,
  })
})

export const ProviderRuntimeInboxRunnerLive = Layer.effect(ProviderRuntimeInboxRunner, make)
