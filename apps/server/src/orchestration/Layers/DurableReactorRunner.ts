// apps/server/src/orchestration/Layers/DurableReactorRunner.ts
// replays persisted events and executes fenced reactor actions in FIFO lanes

import * as Cause from 'effect/Cause'
import * as Crypto from 'effect/Crypto'
import * as DateTime from 'effect/DateTime'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Queue from 'effect/Queue'
import * as Semaphore from 'effect/Semaphore'
import * as Stream from 'effect/Stream'

import { ReactorDeliveryError } from '../../persistence/Errors.ts'
import { OrchestrationReactorDelivery } from '../../persistence/Services/OrchestrationReactorDelivery.ts'
import {
  DurableReactorRunner,
  type DurableReactorDefinition,
  type DurableReactorRunnerShape,
} from '../Services/DurableReactorRunner.ts'
import { OrchestrationEngineService } from '../Services/OrchestrationEngine.ts'

const EVENT_PAGE_SIZE = 500
const LEASE_DURATION_MS = 30_000
const LEASE_RENEWAL_MS = 10_000
const POLL_INTERVAL_MS = 5_000
const RETRY_BASE_MS = 1_000
const RETRY_CAP_MS = 5 * 60_000
const MAX_ATTEMPTS = 8

interface ReactorLane
{
  readonly definition: DurableReactorDefinition
  readonly ownerId: string
  readonly lock: Semaphore.Semaphore
  readonly wakeups: Queue.Queue<void>
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso)

const addMilliseconds = (iso: string, milliseconds: number): string =>
  DateTime.formatIso(DateTime.addDuration(DateTime.makeUnsafe(iso), milliseconds))

const describeCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

const make = Effect.gen(function* ()
{
  const delivery = yield* OrchestrationReactorDelivery
  const engine = yield* OrchestrationEngineService
  const crypto = yield* Crypto.Crypto
  const lanes = new Map<string, ReactorLane>()

  const requireLane = (reactorId: ReactorLane['definition']['reactorId']) =>
    Effect.sync(() => lanes.get(reactorId)).pipe(
      Effect.flatMap((lane) =>
        lane === undefined
          ? Effect.fail(
              new ReactorDeliveryError({
                operation: `DurableReactorRunner.requireLane:${reactorId}`,
              }),
            )
          : Effect.succeed(lane),
      ),
    )

  const renewWhileRunning = (
    lane: ReactorLane,
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

  const executeWithRenewal = (
    lane: ReactorLane,
    action: Parameters<DurableReactorDefinition['execute']>[0],
  ) =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        if (action.leaseEpoch === null)
        {
          return yield* new ReactorDeliveryError({
            operation: 'DurableReactorRunner.executeWithRenewal:missingLeaseEpoch',
          })
        }
        const leaseLost = yield* Deferred.make<void>()
        yield* renewWhileRunning(lane, action.actionId, action.leaseEpoch, leaseLost).pipe(
          Effect.forkScoped,
        )
        return yield* Effect.raceFirst(
          // @effect-diagnostics-next-line anyUnknownInErrorContext:off - reactor definitions classify heterogeneous execution failures
          lane.definition.execute(action),
          Deferred.await(leaseLost).pipe(Effect.andThen(Effect.interrupt)),
        )
      }),
    )

  const recordExecution = Effect.fn('DurableReactorRunner.recordExecution')(function* (
    lane: ReactorLane,
    action: Parameters<DurableReactorDefinition['execute']>[0],
  )
  {
    if (action.leaseEpoch === null)
    {
      return yield* new ReactorDeliveryError({
        operation: 'DurableReactorRunner.recordExecution:missingLeaseEpoch',
      })
    }

    // @effect-diagnostics-next-line anyUnknownInErrorContext:off - the definition classifier consumes the captured failure
    const execution = yield* Effect.exit(executeWithRenewal(lane, action))
    const recordedAt = yield* nowIso
    if (Exit.isSuccess(execution))
    {
      const result = execution.value
      yield* delivery.recordOutcome({
        actionId: action.actionId,
        ownerId: lane.ownerId,
        leaseEpoch: action.leaseEpoch,
        status: result.status,
        ...(result.resultJson === undefined ? {} : { outcomeJson: result.resultJson }),
        ...(result.status === 'unknown' ? { error: result.detail } : {}),
        now: recordedAt,
      })
      return
    }

    if (Cause.hasInterruptsOnly(execution.cause))
    {
      return yield* Effect.interrupt
    }

    const cause = Cause.squash(execution.cause)
    const failureClass = lane.definition.classify(cause, action)
    const status =
      failureClass === 'retryable' && action.attemptCount >= MAX_ATTEMPTS
        ? ('manual' as const)
        : failureClass
    const backoffMs = Math.min(
      RETRY_CAP_MS,
      RETRY_BASE_MS * 2 ** Math.max(0, action.attemptCount - 1),
    )
    if (status !== 'retryable' && lane.definition.onBlocked !== undefined)
    {
      yield* lane.definition.onBlocked({ action, cause, status })
    }
    yield* delivery.recordOutcome({
      actionId: action.actionId,
      ownerId: lane.ownerId,
      leaseEpoch: action.leaseEpoch,
      status,
      error: describeCause(cause),
      ...(status === 'retryable' ? { nextAttemptAt: addMilliseconds(recordedAt, backoffMs) } : {}),
      now: recordedAt,
    })
  })

  const claimAvailable = Effect.fn('DurableReactorRunner.claimAvailable')(function* (
    lane: ReactorLane,
  )
  {
    while (true)
    {
      const action = yield* delivery.claimNext({
        reactorId: lane.definition.reactorId,
        ownerId: lane.ownerId,
        leaseDurationMs: LEASE_DURATION_MS,
        now: yield* nowIso,
      })
      if (Option.isNone(action))
      {
        return
      }
      yield* recordExecution(lane, action.value)
    }
  })

  const readEventPage = (cursor: number) =>
    Stream.runCollect(engine.readEvents(cursor, EVENT_PAGE_SIZE)).pipe(
      Effect.map((events) => Array.from(events)),
      Effect.mapError(
        (cause) =>
          new ReactorDeliveryError({
            operation: 'DurableReactorRunner.readEventPage',
            cause,
          }),
      ),
    )

  const drainLaneUnlocked = Effect.fn('DurableReactorRunner.drainLaneUnlocked')(function* (
    lane: ReactorLane,
    throughSequence?: number,
  )
  {
    yield* delivery.recoverExpiredLeases({
      reactorId: lane.definition.reactorId,
      ownerId: lane.ownerId,
      policy: lane.definition.onLeaseExpiry,
      now: yield* nowIso,
    })

    while (true)
    {
      const progressOption = yield* delivery.getProgress(lane.definition.reactorId)
      if (Option.isNone(progressOption))
      {
        return yield* new ReactorDeliveryError({
          operation: 'DurableReactorRunner.drainLaneUnlocked:missingProgress',
        })
      }
      const progress = progressOption.value
      if (progress.mode === 'paused')
      {
        return
      }
      const cursor =
        progress.mode === 'shadow' ? progress.shadowCursorSequence : progress.cursorSequence
      if (throughSequence !== undefined && cursor >= throughSequence)
      {
        return
      }

      const events = yield* readEventPage(cursor)
      if (events.length === 0)
      {
        if (progress.mode === 'durable')
        {
          yield* claimAvailable(lane)
        }
        return
      }

      let madeProgress = false
      for (const event of events)
      {
        if (progress.highWaterSequence !== null && event.sequence > progress.highWaterSequence)
        {
          return
        }
        // @effect-diagnostics-next-line anyUnknownInErrorContext:off - reactor plans expose heterogeneous failures that are wrapped below
        const drafts = yield* lane.definition.plan(event).pipe(
          Effect.mapError(
            (cause) =>
              new ReactorDeliveryError({
                operation: `DurableReactorRunner.plan:${lane.definition.reactorId}`,
                cause,
              }),
          ),
        )
        yield* delivery.materialize({
          reactorId: lane.definition.reactorId,
          operationVersion: lane.definition.operationVersion,
          sourceSequence: event.sequence,
          sourceEventId: event.eventId,
          mode: progress.mode,
          actions: drafts,
          now: yield* nowIso,
        })
        madeProgress = true

        if (progress.mode === 'shadow')
        {
          if (throughSequence !== undefined && event.sequence >= throughSequence)
          {
            return
          }
          continue
        }

        yield* claimAvailable(lane)
        const advanced = yield* delivery.advanceCursor({
          reactorId: lane.definition.reactorId,
          sourceSequence: event.sequence,
          expectedPreviousSequence: event.sequence - 1,
          now: yield* nowIso,
        })
        if (!advanced)
        {
          return
        }
        if (throughSequence !== undefined && event.sequence >= throughSequence)
        {
          return
        }
      }

      if (!madeProgress || events.length < EVENT_PAGE_SIZE)
      {
        return
      }
    }
  })

  const drainLane = (lane: ReactorLane, throughSequence?: number) =>
    lane.lock.withPermits(1)(drainLaneUnlocked(lane, throughSequence))

  const drain: DurableReactorRunnerShape['drain'] = (reactorId) =>
    requireLane(reactorId).pipe(Effect.flatMap((lane) => drainLane(lane)))

  const drainThrough: DurableReactorRunnerShape['drainThrough'] = (reactorId, sourceSequence) =>
    requireLane(reactorId).pipe(Effect.flatMap((lane) => drainLane(lane, sourceSequence)))

  const start: DurableReactorRunnerShape['start'] = Effect.fn('DurableReactorRunner.start')(
    function* (definition)
    {
      if (lanes.has(definition.reactorId))
      {
        return yield* new ReactorDeliveryError({
          operation: `DurableReactorRunner.start:alreadyStarted:${definition.reactorId}`,
        })
      }
      const existing = yield* delivery.ensureProgress({
        reactorId: definition.reactorId,
        operationVersion: definition.operationVersion,
        initialSequence: 0,
        mode: 'shadow',
        now: yield* nowIso,
      })
      const ownerId = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError(
          (cause) =>
            new ReactorDeliveryError({
              operation: 'DurableReactorRunner.start:ownerId',
              cause,
            }),
        ),
      )
      yield* delivery.setMode({
        reactorId: definition.reactorId,
        mode: existing.mode,
        ownerId,
        now: yield* nowIso,
      })
      const lane: ReactorLane = {
        definition,
        ownerId,
        lock: yield* Semaphore.make(1),
        wakeups: yield* Queue.dropping<void>(1),
      }
      lanes.set(definition.reactorId, lane)
      yield* Effect.addFinalizer(() => Effect.sync(() => lanes.delete(definition.reactorId)))

      yield* delivery.recoverExpiredLeases({
        reactorId: definition.reactorId,
        ownerId,
        policy: definition.onLeaseExpiry,
        now: yield* nowIso,
      })
      yield* drainLane(lane)

      yield* Stream.runForEach(engine.streamDomainEvents, () =>
        Queue.offer(lane.wakeups, undefined),
      ).pipe(Effect.forkScoped)
      yield* Effect.forever(
        Effect.raceFirst(Queue.take(lane.wakeups), Effect.sleep(POLL_INTERVAL_MS)).pipe(
          Effect.andThen(drainLane(lane)),
          Effect.catch((cause) =>
            Effect.logError('durable reactor drain failed', {
              reactorId: definition.reactorId,
              cause: cause.message,
            }),
          ),
        ),
      ).pipe(Effect.forkScoped)
    },
  )

  const pauseClaims: DurableReactorRunnerShape['pauseClaims'] = (reactorId) =>
    requireLane(reactorId).pipe(
      Effect.flatMap((lane) =>
        lane.lock.withPermits(1)(
          nowIso.pipe(
            Effect.flatMap((now) =>
              delivery.setMode({ reactorId, mode: 'paused', ownerId: lane.ownerId, now }),
            ),
          ),
        ),
      ),
      Effect.asVoid,
    )

  const resumeClaims: DurableReactorRunnerShape['resumeClaims'] = (reactorId) =>
    requireLane(reactorId).pipe(
      Effect.flatMap((lane) =>
        lane.lock.withPermits(1)(
          nowIso.pipe(
            Effect.flatMap((now) =>
              delivery.setMode({ reactorId, mode: 'durable', ownerId: lane.ownerId, now }),
            ),
            Effect.andThen(Queue.offer(lane.wakeups, undefined)),
          ),
        ),
      ),
      Effect.asVoid,
    )

  const setHighWater: DurableReactorRunnerShape['setHighWater'] = (reactorId, sourceSequence) =>
    requireLane(reactorId).pipe(
      Effect.flatMap((lane) =>
        lane.lock.withPermits(1)(
          delivery.getProgress(reactorId).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(
                    new ReactorDeliveryError({
                      operation: 'DurableReactorRunner.setHighWater:missingProgress',
                    }),
                  ),
                onSome: (progress) =>
                  nowIso.pipe(
                    Effect.flatMap((now) =>
                      delivery.setMode({
                        reactorId,
                        mode: progress.mode,
                        highWaterSequence: sourceSequence,
                        ownerId: lane.ownerId,
                        now,
                      }),
                    ),
                  ),
              }),
            ),
            Effect.andThen(Queue.offer(lane.wakeups, undefined)),
          ),
        ),
      ),
      Effect.asVoid,
    )

  return DurableReactorRunner.of({
    start,
    drain,
    drainThrough,
    pauseClaims,
    resumeClaims,
    setHighWater,
  })
})

export const DurableReactorRunnerLive = Layer.effect(DurableReactorRunner, make)
