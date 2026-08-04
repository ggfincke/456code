// tests/apps/server/persistence/Layers/CheckpointRevertOperations.test.ts
// verifies checkpoint revert admission, transitions, recovery, and resumable listing

import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { CheckpointRevertOperationsLive } from '../../../../../apps/server/src/persistence/Layers/CheckpointRevertOperations.ts'
import Migration048 from '../../../../../apps/server/src/persistence/Migrations/048_CheckpointRevertOperations.ts'
import {
  CheckpointRevertOperationConflictError,
  CheckpointRevertOperations,
  type CheckpointRevertPhase,
  CheckpointRevertTransitionError,
} from '../../../../../apps/server/src/persistence/Services/CheckpointRevertOperations.ts'
import * as NodeSqliteClient from '../../../../../apps/server/src/persistence/NodeSqliteClient.ts'

const persistenceLayer = Layer.mergeAll(
  CheckpointRevertOperationsLive,
  Layer.effectDiscard(Migration048),
).pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()))
const layer = it.layer(persistenceLayer)
const isConflict = Schema.is(CheckpointRevertOperationConflictError)
const isTransitionError = Schema.is(CheckpointRevertTransitionError)
const now = '2026-08-02T00:00:00.000Z'

const forwardPhases: ReadonlyArray<CheckpointRevertPhase> = [
  'admitted',
  'target-staged',
  'restore-ready',
  'restore-started',
  'filesystem-restored',
  'provider-pending',
  'provider-outcome-recorded',
  'projection-finalized',
  'cleanup-pending',
  'completed',
]
// representative legal + illegal edges — avoids a 12×12 oracle that mirrors production
const representativeEdges: ReadonlyArray<{
  readonly source: CheckpointRevertPhase
  readonly target: CheckpointRevertPhase
  readonly legal: boolean
}> = [
  { source: 'admitted', target: 'admitted', legal: true },
  { source: 'admitted', target: 'target-staged', legal: true },
  { source: 'admitted', target: 'aborted', legal: true },
  { source: 'admitted', target: 'manual-required', legal: false },
  { source: 'target-staged', target: 'restore-ready', legal: true },
  { source: 'restore-ready', target: 'aborted', legal: true },
  { source: 'restore-started', target: 'filesystem-restored', legal: true },
  { source: 'restore-started', target: 'aborted', legal: false },
  { source: 'restore-started', target: 'manual-required', legal: true },
  { source: 'cleanup-pending', target: 'completed', legal: true },
  { source: 'completed', target: 'manual-required', legal: false },
  { source: 'completed', target: 'admitted', legal: false },
  { source: 'manual-required', target: 'restore-started', legal: true },
  { source: 'manual-required', target: 'aborted', legal: false },
  { source: 'aborted', target: 'admitted', legal: false },
  { source: 'provider-pending', target: 'admitted', legal: false },
]

layer('CheckpointRevertOperations', (it) =>
{
  it.effect('returns a typed conflict and admits another operation after completion', () =>
    Effect.gen(function* ()
    {
      const operations = yield* CheckpointRevertOperations
      const admitted = yield* operations.admit({
        operationId: 'operation-conflict-1',
        threadId: 'thread-conflict',
        targetRef: 'refs/t3/checkpoint/1',
        targetTurnCount: 1,
        cwd: '/tmp/worktree',
        now,
      })
      assert.equal(admitted.phase, 'admitted')

      const conflict = yield* Effect.result(
        operations.admit({
          operationId: 'operation-conflict-2',
          threadId: 'thread-conflict',
          targetRef: 'refs/t3/checkpoint/2',
          targetTurnCount: 2,
          cwd: '/tmp/worktree',
          now,
        }),
      )
      assert.equal(conflict._tag, 'Failure')
      if (conflict._tag === 'Failure') assert.isTrue(isConflict(conflict.failure))

      for (let index = 0; index < forwardPhases.length - 1; index += 1)
      {
        yield* operations.casTransition({
          operationId: admitted.operationId,
          expectedPhase: forwardPhases[index]!,
          nextPhase: forwardPhases[index + 1]!,
          now,
        })
      }
      const next = yield* operations.admit({
        operationId: 'operation-conflict-2',
        threadId: 'thread-conflict',
        targetRef: 'refs/t3/checkpoint/2',
        targetTurnCount: 2,
        cwd: '/tmp/worktree',
        now,
      })
      assert.equal(next.phase, 'admitted')
    }),
  )

  it.effect('accepts representative legal transitions and rejects illegal edges', () =>
    Effect.gen(function* ()
    {
      const operations = yield* CheckpointRevertOperations
      const sql = yield* SqlClient.SqlClient

      for (const [edgeIndex, edge] of representativeEdges.entries())
      {
        const operationId = `operation-edge-${edgeIndex}`
        yield* sql`
          INSERT INTO checkpoint_revert_operations (
            operation_id,
            thread_id,
            target_ref,
            target_turn_count,
            cwd,
            phase,
            manual_resume_phase,
            created_at,
            updated_at
          )
          VALUES (
            ${operationId},
            ${`thread-edge-${edgeIndex}`},
            'refs/t3/checkpoint/edge',
            1,
            '/tmp/worktree',
            ${edge.source},
            ${edge.source === 'manual-required' ? 'restore-started' : null},
            ${now},
            ${now}
          )
        `
        const result = yield* Effect.result(
          operations.casTransition({
            operationId,
            expectedPhase: edge.source,
            nextPhase: edge.target,
            now,
          }),
        )
        assert.equal(
          result._tag,
          edge.legal ? 'Success' : 'Failure',
          `${edge.source} -> ${edge.target}`,
        )
        if (result._tag === 'Failure') assert.isTrue(isTransitionError(result.failure))
      }
    }),
  )

  it.effect('increments same-phase attempts and resumes only the recorded manual phase', () =>
    Effect.gen(function* ()
    {
      const operations = yield* CheckpointRevertOperations
      const admitted = yield* operations.admit({
        operationId: 'operation-manual-flow',
        threadId: 'thread-manual-flow',
        targetRef: 'refs/t3/checkpoint/manual',
        targetTurnCount: 3,
        cwd: '/tmp/worktree',
        now,
      })
      const retried = yield* operations.casTransition({
        operationId: admitted.operationId,
        expectedPhase: 'admitted',
        nextPhase: 'admitted',
        patch: { lastError: 'retry' },
        now,
      })
      assert.equal(retried.attemptCount, 1)
      yield* operations.casTransition({
        operationId: admitted.operationId,
        expectedPhase: 'admitted',
        nextPhase: 'target-staged',
        now,
      })
      yield* operations.casTransition({
        operationId: admitted.operationId,
        expectedPhase: 'target-staged',
        nextPhase: 'restore-ready',
        now,
      })
      yield* operations.casTransition({
        operationId: admitted.operationId,
        expectedPhase: 'restore-ready',
        nextPhase: 'restore-started',
        now,
      })
      const manual = yield* operations.markManual({
        operationId: admitted.operationId,
        expectedPhase: 'restore-started',
        error: 'operator review required',
        now,
      })
      assert.equal(manual.manualResumePhase, 'restore-started')
      const wrongResume = yield* Effect.result(
        operations.casTransition({
          operationId: admitted.operationId,
          expectedPhase: 'manual-required',
          nextPhase: 'filesystem-restored',
          now,
        }),
      )
      assert.equal(wrongResume._tag, 'Failure')
      const resumed = yield* operations.casTransition({
        operationId: admitted.operationId,
        expectedPhase: 'manual-required',
        nextPhase: 'restore-started',
        now,
      })
      assert.isNull(resumed.manualResumePhase)
    }),
  )

  it.effect('lists active and manual-required operations but excludes terminal rows', () =>
    Effect.gen(function* ()
    {
      const operations = yield* CheckpointRevertOperations
      const active = yield* operations.admit({
        operationId: 'operation-list-active',
        threadId: 'thread-list-active',
        targetRef: 'refs/t3/checkpoint/list-active',
        targetTurnCount: 1,
        cwd: '/tmp/worktree',
        now,
      })
      const terminal = yield* operations.admit({
        operationId: 'operation-list-terminal',
        threadId: 'thread-list-terminal',
        targetRef: 'refs/t3/checkpoint/list-terminal',
        targetTurnCount: 1,
        cwd: '/tmp/worktree',
        now,
      })
      yield* operations.casTransition({
        operationId: terminal.operationId,
        expectedPhase: 'admitted',
        nextPhase: 'aborted',
        now,
      })
      const sql = yield* SqlClient.SqlClient
      yield* sql`
        INSERT INTO checkpoint_revert_operations (
          operation_id,
          thread_id,
          target_ref,
          target_turn_count,
          cwd,
          phase,
          manual_resume_phase,
          created_at,
          updated_at
        )
        VALUES (
          'operation-list-manual',
          'thread-list-manual',
          'refs/t3/checkpoint/list-manual',
          1,
          '/tmp/worktree',
          'manual-required',
          'restore-started',
          ${now},
          ${now}
        )
      `

      const resumable = yield* operations.listResumable()
      const resumableIds = resumable.map((operation) => operation.operationId)
      assert.include(resumableIds, active.operationId)
      assert.include(resumableIds, 'operation-list-manual')
      assert.notInclude(resumableIds, terminal.operationId)
      assert.isTrue(
        resumable.find((operation) => operation.operationId === 'operation-list-manual')
          ?.manualRequired,
      )
      assert.isFalse(
        resumable.find((operation) => operation.operationId === active.operationId)?.manualRequired,
      )
      assert.isTrue(Option.isSome(yield* operations.getActiveByThread(active.threadId)))
    }),
  )
})
