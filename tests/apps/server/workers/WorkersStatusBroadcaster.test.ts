// tests/apps/server/workers/WorkersStatusBroadcaster.test.ts
// verifies selected-job activity streams react only with normalized snapshots

import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, describe, it } from '@effect/vitest'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Stream from 'effect/Stream'
import * as TestClock from 'effect/testing/TestClock'

import * as WorkerBrokerStore from '../../../../apps/server/src/workers/WorkerBrokerStore.ts'
import * as WorkersStatusBroadcaster from '../../../../apps/server/src/workers/WorkersStatusBroadcaster.ts'

describe('WorkersStatusBroadcaster activity', () =>
{
  it.effect('suppresses unchanged fallback snapshots and emits selected-job changes', () =>
  {
    let reads = 0
    const store = Layer.succeed(WorkerBrokerStore.WorkerBrokerStore, {
      jobsDir: '/missing/jobs',
      list: () => Effect.die('unused'),
      listRuns: () => Effect.die('unused'),
      getJob: () => Effect.die('unused'),
      getRun: () => Effect.die('unused'),
      getExecutionEvidence: () => Effect.die('unused'),
      readActivity: ({ jobId }) =>
        Effect.sync(() => ({
          jobId,
          readAt: DateTime.formatIso(DateTime.makeUnsafe(reads)),
          entries:
            reads++ < 2
              ? []
              : [
                  {
                    sequence: 1,
                    recordedAt: '2026-07-31T12:00:00Z',
                    kind: 'action' as const,
                    status: 'started' as const,
                  },
                ],
          skippedEntryCount: 0,
          truncated: false,
          error: Option.none(),
        })),
    })
    return Effect.gen(function* ()
    {
      const broadcaster = yield* WorkersStatusBroadcaster.make
      const snapshotsFiber = yield* broadcaster
        .streamActivity({ jobId: 'job-a' })
        .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild)
      yield* Effect.yieldNow
      yield* TestClock.adjust('4 seconds')
      yield* Effect.yieldNow
      yield* TestClock.adjust('4 seconds')
      const snapshots = yield* Fiber.join(snapshotsFiber)
      yield* Effect.sync(() =>
      {
        assert.strictEqual(reads, 3)
        assert.strictEqual(snapshots.length, 2)
        assert.strictEqual(snapshots[1]?.jobId, 'job-a')
        assert.strictEqual(snapshots[1]?.entries.length, 1)
      })
    }).pipe(Effect.provide(Layer.merge(store, NodeServices.layer)))
  })
})
