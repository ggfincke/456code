// tests/apps/server/persistence/Layers/CheckpointRevertOperations.test.ts
// verifies checkpoint revert admission, transitions, recovery, and resumable listing

import { ProviderDriverKind, ProviderInstanceId, ThreadId } from '@t3tools/contracts'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { CheckpointRevertOperationsLive } from '../../../../../apps/server/src/persistence/Layers/CheckpointRevertOperations.ts'
import { SqlitePersistenceMemory } from '../../../../../apps/server/src/persistence/Layers/Sqlite.ts'
import {
  CheckpointRevertOperationConflictError,
  CheckpointRevertOperations,
  type CheckpointRevertPhase,
  CheckpointRevertTransitionError,
} from '../../../../../apps/server/src/persistence/Services/CheckpointRevertOperations.ts'
const persistenceLayer = CheckpointRevertOperationsLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
)
const layer = it.layer(persistenceLayer)
const isConflict = Schema.is(CheckpointRevertOperationConflictError)
const isTransitionError = Schema.is(CheckpointRevertTransitionError)
const now = '2026-08-02T00:00:00.000Z'
const captureIdentity = {
  checkpointCaptureRoot: '/tmp/capture-worktree',
  repositoryCommonDir: '/tmp/repository/.git',
  checkpointCommitOid: '0123456789abcdef0123456789abcdef01234567',
} as const
const requestFence = {
  requestSourceSequence: 11,
  providerInboxHighWater: 7,
} as const
const providerIdentityFor = (threadId: string, sessionGeneration = 7) => ({
  providerIdentity: {
    provider: ProviderDriverKind.make('codex'),
    providerInstanceId: ProviderInstanceId.make('codex'),
    threadId: ThreadId.make(threadId),
    sessionGeneration,
  },
  providerSessionId: 'provider-session-1',
})

const forwardPhases: ReadonlyArray<CheckpointRevertPhase> = [
  'admitted',
  'target-staged',
  'restore-ready',
  'provider-pending',
  'provider-outcome-recorded',
  'restore-started',
  'filesystem-restored',
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
  // old journals can be refused before any destructive phase; these early
  // manual rows intentionally have no automatic resume phase
  { source: 'admitted', target: 'manual-required', legal: true },
  { source: 'target-staged', target: 'restore-ready', legal: true },
  { source: 'restore-ready', target: 'aborted', legal: true },
  { source: 'restore-ready', target: 'provider-pending', legal: true },
  { source: 'provider-outcome-recorded', target: 'restore-started', legal: true },
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
  it.effect(
    'reserves the request fence before admission and promotes the same row exactly once',
    () =>
      Effect.gen(function* ()
      {
        const operations = yield* CheckpointRevertOperations
        const reserved = yield* operations.reserve({
          operationId: 'operation-reserved',
          threadId: 'thread-reserved',
          targetRef: 'refs/t3/checkpoint/reserved',
          targetTurnCount: 4,
          ...requestFence,
          now,
        })
        assert.equal(reserved.phase, 'requested')
        assert.isNull(reserved.cwd)
        assert.equal(reserved.requestSourceSequence, requestFence.requestSourceSequence)
        assert.equal(reserved.providerInboxHighWater, requestFence.providerInboxHighWater)
        const resumableReservation = (yield* operations.listResumable()).find(
          (operation) => operation.operationId === reserved.operationId,
        )
        assert.equal(resumableReservation?.phase, 'requested')
        assert.isFalse(resumableReservation?.manualRequired)
        const requestedBySequence = yield* operations.getRequestedBySourceSequence(
          requestFence.requestSourceSequence,
        )
        assert.isTrue(Option.isSome(requestedBySequence))
        assert.equal(Option.getOrThrow(requestedBySequence).operationId, reserved.operationId)

        const abortedReservation = yield* operations.reserve({
          operationId: 'operation-reserved-aborted',
          threadId: 'thread-reserved-aborted',
          targetRef: 'refs/t3/checkpoint/reserved-aborted',
          targetTurnCount: 2,
          ...requestFence,
          now,
        })
        const aborted = yield* operations.casTransition({
          operationId: abortedReservation.operationId,
          expectedPhase: 'requested',
          nextPhase: 'aborted',
          patch: { lastError: 'request preflight refused' },
          now,
        })
        assert.equal(aborted.phase, 'aborted')
        assert.isNull(aborted.cwd)

        const admitted = yield* operations.admit({
          operationId: reserved.operationId,
          threadId: reserved.threadId,
          targetRef: reserved.targetRef,
          targetTurnCount: reserved.targetTurnCount,
          ...requestFence,
          cwd: '/tmp/worktree',
          ...captureIdentity,
          ...providerIdentityFor(reserved.threadId),
          now,
        })
        assert.equal(admitted.phase, 'admitted')
        assert.equal(admitted.cwd, '/tmp/worktree')
        assert.equal(admitted.provider, 'codex')
        assert.isTrue(
          Option.isNone(
            yield* operations.getRequestedBySourceSequence(requestFence.requestSourceSequence),
          ),
        )
        assert.equal(admitted.providerSessionGeneration, 7)

        const replayed = yield* operations.admit({
          operationId: admitted.operationId,
          threadId: admitted.threadId,
          targetRef: admitted.targetRef,
          targetTurnCount: admitted.targetTurnCount,
          ...requestFence,
          cwd: '/tmp/different-worktree',
          ...captureIdentity,
          ...providerIdentityFor(admitted.threadId, 9),
          now,
        })
        assert.equal(replayed.cwd, '/tmp/worktree')
        assert.equal(replayed.providerSessionGeneration, 7)
      }),
  )

  it.effect('returns a typed conflict and admits another operation after completion', () =>
    Effect.gen(function* ()
    {
      const operations = yield* CheckpointRevertOperations
      const admitted = yield* operations.admit({
        operationId: 'operation-conflict-1',
        threadId: 'thread-conflict',
        targetRef: 'refs/t3/checkpoint/1',
        targetTurnCount: 1,
        ...requestFence,
        cwd: '/tmp/worktree',
        ...captureIdentity,
        ...providerIdentityFor('thread-conflict'),
        now,
      })
      assert.equal(admitted.phase, 'admitted')
      assert.equal(admitted.providerInstanceId, 'codex')
      assert.equal(admitted.providerThreadId, 'thread-conflict')
      assert.equal(admitted.providerSessionGeneration, 7)

      const replayed = yield* operations.admit({
        operationId: admitted.operationId,
        threadId: 'thread-conflict',
        targetRef: 'refs/t3/checkpoint/1',
        targetTurnCount: 1,
        ...requestFence,
        cwd: '/tmp/worktree',
        ...captureIdentity,
        ...providerIdentityFor('thread-conflict', 8),
        now,
      })
      assert.equal(replayed.providerSessionGeneration, 7)

      const conflict = yield* Effect.result(
        operations.admit({
          operationId: 'operation-conflict-2',
          threadId: 'thread-conflict',
          targetRef: 'refs/t3/checkpoint/2',
          targetTurnCount: 2,
          ...requestFence,
          cwd: '/tmp/worktree',
          ...captureIdentity,
          ...providerIdentityFor('thread-conflict'),
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
        ...requestFence,
        cwd: '/tmp/worktree',
        ...captureIdentity,
        ...providerIdentityFor('thread-conflict'),
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
            request_source_sequence,
            provider_inbox_high_water,
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
            ${requestFence.requestSourceSequence},
            ${requestFence.providerInboxHighWater},
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
        ...requestFence,
        cwd: '/tmp/worktree',
        ...captureIdentity,
        ...providerIdentityFor('thread-manual-flow'),
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
        nextPhase: 'provider-pending',
        now,
      })
      yield* operations.casTransition({
        operationId: admitted.operationId,
        expectedPhase: 'provider-pending',
        nextPhase: 'provider-outcome-recorded',
        now,
      })
      yield* operations.casTransition({
        operationId: admitted.operationId,
        expectedPhase: 'provider-outcome-recorded',
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
        ...requestFence,
        cwd: '/tmp/worktree',
        ...captureIdentity,
        ...providerIdentityFor('thread-list-active'),
        now,
      })
      const terminal = yield* operations.admit({
        operationId: 'operation-list-terminal',
        threadId: 'thread-list-terminal',
        targetRef: 'refs/t3/checkpoint/list-terminal',
        targetTurnCount: 1,
        ...requestFence,
        cwd: '/tmp/worktree',
        ...captureIdentity,
        ...providerIdentityFor('thread-list-terminal'),
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
          request_source_sequence,
          provider_inbox_high_water,
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
          ${requestFence.requestSourceSequence},
          ${requestFence.providerInboxHighWater},
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

  it.effect(
    'decodes a legacy provider-generation-less journal without inventing a resume phase',
    () =>
      Effect.gen(function* ()
      {
        const operations = yield* CheckpointRevertOperations
        const sql = yield* SqlClient.SqlClient
        const operationId = 'operation-legacy-identity'
        yield* sql`
        INSERT INTO checkpoint_revert_operations (
          operation_id,
          thread_id,
          target_ref,
          target_turn_count,
          request_source_sequence,
          provider_inbox_high_water,
          cwd,
          checkpoint_capture_root,
          repository_common_dir,
          checkpoint_commit_oid,
          provider_instance_id,
          provider_thread_id,
          phase,
          created_at,
          updated_at
        )
        VALUES (
          ${operationId},
          'thread-legacy-identity',
          'refs/t3/checkpoint/thread-legacy-identity/1',
          1,
          ${requestFence.requestSourceSequence},
          ${requestFence.providerInboxHighWater},
          '/tmp/legacy-worktree',
          ${captureIdentity.checkpointCaptureRoot},
          ${captureIdentity.repositoryCommonDir},
          ${captureIdentity.checkpointCommitOid},
          'codex',
          'thread-legacy-identity',
          'admitted',
          ${now},
          ${now}
        )
      `

        const resumable = yield* operations.listResumable()
        const decoded = resumable.find((operation) => operation.operationId === operationId)
        assert.isDefined(decoded)
        assert.equal(decoded?.checkpointCaptureRoot, captureIdentity.checkpointCaptureRoot)
        assert.equal(decoded?.repositoryCommonDir, captureIdentity.repositoryCommonDir)
        assert.equal(decoded?.checkpointCommitOid, captureIdentity.checkpointCommitOid)
        assert.isNull(decoded?.providerSessionGeneration)

        const manual = yield* operations.markManual({
          operationId,
          expectedPhase: 'admitted',
          error: 'Legacy checkpoint journal lacks exact provider generation identity',
          now,
        })
        assert.equal(manual.phase, 'manual-required')
        assert.isNull(manual.manualResumePhase)
        const blocked = (yield* operations.listResumable()).find(
          (operation) => operation.operationId === operationId,
        )
        assert.isDefined(blocked)
        assert.isTrue(blocked?.manualRequired)
        assert.isNull(blocked?.manualResumePhase)
      }),
  )
})
