// tests/apps/server/architecture/ArchitectureAdmissionRepository.test.ts
// verifies idempotent admission keys, lease fencing, retries, and recovery

import { it } from '@effect/vitest'
import { ProposalId, ProposalRevisionId, ThreadId } from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import { expect } from 'vite-plus/test'

import * as ArchitectureAdmissionRepository from '../../../../apps/server/src/architecture/ArchitectureAdmissionRepository.ts'
import { SqlitePersistenceMemory } from '../../../../apps/server/src/persistence/Layers/Sqlite.ts'

const target = {
  _tag: 'proposal-verified' as const,
  version: 1 as const,
  threadId: ThreadId.make('thread-admission-repository'),
  proposalId: ProposalId.make('proposal-admission-repository'),
  revisionId: ProposalRevisionId.make('revision-admission-repository'),
  revision: 1,
  analyzerFingerprint: 'cartographer:test',
}

const layer = it.layer(
  ArchitectureAdmissionRepository.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
)

layer('ArchitectureAdmissionRepository', (it) =>
{
  it.effect('reuses exact targets and fences every leased transition', () =>
    Effect.gen(function* ()
    {
      const repository = yield* ArchitectureAdmissionRepository.ArchitectureAdmissionRepository
      const admissionKey = 'proposal-verified:revision-admission-repository:cartographer:test'
      const first = yield* repository.enqueue({
        admissionKey,
        target,
        now: '2026-08-20T12:00:00.000Z',
      })
      const retry = yield* repository.enqueue({
        admissionKey,
        target,
        now: '2026-08-20T12:00:01.000Z',
      })
      expect(first.reused).toBe(false)
      expect(retry.reused).toBe(true)
      expect(retry.admission.admissionId).toBe(first.admission.admissionId)

      const collision = yield* repository
        .enqueue({
          admissionKey,
          target: { ...target, revision: 2 },
          now: '2026-08-20T12:00:02.000Z',
        })
        .pipe(Effect.flip)
      expect(collision.detail).toContain('different exact target')

      const claimed = yield* repository.claimDue({
        ownerId: 'worker-a',
        now: '2026-08-20T12:00:03.000Z',
        leaseExpiresAt: '2026-08-20T12:00:33.000Z',
        limit: 8,
      })
      expect(claimed).toHaveLength(1)
      expect(claimed[0]).toMatchObject({
        state: 'leased',
        leaseOwner: 'worker-a',
        leaseEpoch: 1,
        attemptCount: 1,
      })

      expect(
        yield* repository.complete({
          admissionId: claimed[0]!.admissionId,
          ownerId: 'stale-worker',
          leaseEpoch: 1,
          now: '2026-08-20T12:00:04.000Z',
        }),
      ).toBe(false)
      expect((yield* repository.list)[0]).toMatchObject({
        state: 'leased',
        leaseOwner: 'worker-a',
      })

      expect(
        yield* repository.retry({
          admissionId: claimed[0]!.admissionId,
          ownerId: 'worker-a',
          leaseEpoch: 1,
          nextAttemptAt: '2026-08-20T12:00:10.000Z',
          errorClass: 'persistence',
          errorCode: 'persistence-failed',
          now: '2026-08-20T12:00:05.000Z',
        }),
      ).toBe(true)
      expect(
        yield* repository.claimDue({
          ownerId: 'worker-b',
          now: '2026-08-20T12:00:09.000Z',
          leaseExpiresAt: '2026-08-20T12:00:39.000Z',
          limit: 8,
        }),
      ).toEqual([])

      const reclaimed = yield* repository.claimDue({
        ownerId: 'worker-b',
        now: '2026-08-20T12:00:10.000Z',
        leaseExpiresAt: '2026-08-20T12:00:40.000Z',
        limit: 8,
      })
      expect(reclaimed[0]).toMatchObject({
        state: 'leased',
        leaseOwner: 'worker-b',
        leaseEpoch: 2,
        attemptCount: 2,
      })
      expect(
        yield* repository.complete({
          admissionId: reclaimed[0]!.admissionId,
          ownerId: 'worker-b',
          leaseEpoch: 2,
          now: '2026-08-20T12:00:11.000Z',
        }),
      ).toBe(true)
      expect((yield* repository.list)[0]).toMatchObject({
        state: 'complete',
        leaseOwner: null,
        leaseExpiresAt: null,
      })
    }),
  )

  it.effect('recovers only expired leases and permits explicit terminal retry', () =>
    Effect.gen(function* ()
    {
      const repository = yield* ArchitectureAdmissionRepository.ArchitectureAdmissionRepository
      const expiredKey = 'proposal-verified:revision-expired:cartographer:test'
      const terminalKey = 'proposal-verified:revision-terminal:cartographer:test'
      yield* repository.enqueue({
        admissionKey: expiredKey,
        target: {
          ...target,
          revisionId: ProposalRevisionId.make('revision-expired'),
        },
        now: '2026-08-20T13:00:00.000Z',
      })
      yield* repository.enqueue({
        admissionKey: terminalKey,
        target: {
          ...target,
          revisionId: ProposalRevisionId.make('revision-terminal'),
        },
        now: '2026-08-20T13:00:01.000Z',
      })
      const claimed = yield* repository.claimDue({
        ownerId: 'worker-recovery',
        now: '2026-08-20T13:00:02.000Z',
        leaseExpiresAt: '2026-08-20T13:00:10.000Z',
        limit: 8,
      })
      const terminal = claimed.find((admission) => admission.admissionKey === terminalKey)!
      expect(
        yield* repository.failTerminal({
          admissionId: terminal.admissionId,
          ownerId: 'worker-recovery',
          leaseEpoch: terminal.leaseEpoch,
          errorClass: 'proposal',
          errorCode: 'identity-mismatch',
          now: '2026-08-20T13:00:03.000Z',
        }),
      ).toBe(true)

      const expired = claimed.find((admission) => admission.admissionKey === expiredKey)!
      expect(
        yield* repository.renew({
          admissionId: expired.admissionId,
          ownerId: 'worker-recovery',
          leaseEpoch: expired.leaseEpoch,
          leaseExpiresAt: '2026-08-20T13:00:41.000Z',
          now: '2026-08-20T13:00:11.000Z',
        }),
      ).toBe(false)
      expect(
        yield* repository.complete({
          admissionId: expired.admissionId,
          ownerId: 'worker-recovery',
          leaseEpoch: expired.leaseEpoch,
          now: '2026-08-20T13:00:11.000Z',
        }),
      ).toBe(false)

      yield* repository.recoverExpired('2026-08-20T13:00:11.000Z')
      const recovered = (yield* repository.list).find(
        (admission) => admission.admissionKey === expiredKey,
      )
      expect(recovered).toMatchObject({
        state: 'queued',
        leaseOwner: null,
        lastErrorClass: 'recovery',
        lastErrorCode: 'expired-lease',
      })

      expect(
        yield* repository.requeue({
          admissionKey: terminalKey,
          now: '2026-08-20T13:00:12.000Z',
        }),
      ).toBe(true)
      expect(
        (yield* repository.list).find((admission) => admission.admissionKey === terminalKey),
      ).toMatchObject({ state: 'queued', lastErrorClass: null, lastErrorCode: null })
    }),
  )

  it.effect('requeues only completed restart work and cancels only active thread work', () =>
    Effect.gen(function* ()
    {
      const repository = yield* ArchitectureAdmissionRepository.ArchitectureAdmissionRepository
      const sql = yield* SqlClient.SqlClient
      const lifecycleThreadId = ThreadId.make('thread-admission-lifecycle')
      const states = [
        ['queued', 'revision-lifecycle-queued'],
        ['leased', 'revision-lifecycle-leased'],
        ['retry-wait', 'revision-lifecycle-retry'],
        ['complete', 'revision-lifecycle-complete'],
        ['terminal-failed', 'revision-lifecycle-terminal'],
      ] as const
      for (const [state, revisionId] of states)
      {
        yield* repository.enqueue({
          admissionKey: `proposal-verified:${revisionId}:cartographer:test`,
          target: {
            ...target,
            threadId: lifecycleThreadId,
            revisionId: ProposalRevisionId.make(revisionId),
          },
          now: '2026-08-20T14:00:00.000Z',
        })
        yield* sql`
          UPDATE architecture_analysis_admissions
          SET
            state = ${state},
            lease_owner = ${state === 'leased' ? 'worker-lifecycle' : null},
            lease_epoch = ${state === 'leased' ? 1 : 0},
            lease_expires_at = ${state === 'leased' ? '2026-08-20T14:01:00.000Z' : null},
            next_attempt_at = ${state === 'retry-wait' ? '2026-08-20T14:01:00.000Z' : null}
          WHERE admission_key = ${`proposal-verified:${revisionId}:cartographer:test`}
        `
      }

      const completeKey = 'proposal-verified:revision-lifecycle-complete:cartographer:test'
      expect(
        yield* repository.requeueCompletedAfterRestart({
          admissionKey: completeKey,
          now: '2026-08-20T14:00:01.000Z',
        }),
      ).toBe(true)
      expect(
        yield* repository.requeueCompletedAfterRestart({
          admissionKey: completeKey,
          now: '2026-08-20T14:00:02.000Z',
        }),
      ).toBe(false)
      yield* sql`
        UPDATE architecture_analysis_admissions
        SET state = 'complete'
        WHERE admission_key = ${completeKey}
      `

      expect(
        yield* repository.cancelThread({
          threadId: lifecycleThreadId,
          now: '2026-08-20T14:00:03.000Z',
        }),
      ).toEqual({ plannedAnchor: 0, proposalVerified: 3 })
      const byState = new Map(
        (yield* repository.list)
          .filter((admission) => admission.target.threadId === lifecycleThreadId)
          .map((admission) => [admission.admissionKey, admission]),
      )
      for (const revisionId of [
        'revision-lifecycle-queued',
        'revision-lifecycle-leased',
        'revision-lifecycle-retry',
      ])
      {
        expect(byState.get(`proposal-verified:${revisionId}:cartographer:test`)).toMatchObject({
          state: 'cancelled',
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorClass: 'lifecycle',
          lastErrorCode: 'thread-deleted',
        })
      }
      expect(byState.get(completeKey)).toMatchObject({ state: 'complete' })
      expect(
        byState.get('proposal-verified:revision-lifecycle-terminal:cartographer:test'),
      ).toMatchObject({ state: 'terminal-failed' })
    }),
  )

  it.effect('fails closed for missing thread authority and fences explicit-start leases', () =>
    Effect.gen(function* ()
    {
      const repository = yield* ArchitectureAdmissionRepository.ArchitectureAdmissionRepository
      const sql = yield* SqlClient.SqlClient
      const activeThreadId = ThreadId.make('thread-admission-authority-active')
      const missingThreadId = ThreadId.make('thread-admission-authority-missing')
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          ${activeThreadId},
          'project-admission-authority',
          'Admission authority thread',
          '{"instanceId":"codex","model":"gpt-5.4"}',
          'full-access',
          'default',
          NULL,
          NULL,
          NULL,
          NULL,
          0,
          0,
          0,
          '2026-08-20T15:00:00.000Z',
          '2026-08-20T15:00:00.000Z',
          NULL
        )
      `
      expect(yield* repository.isThreadDeleted(activeThreadId)).toBe(false)
      expect(yield* repository.isThreadDeleted(missingThreadId)).toBe(true)
      yield* sql`
        UPDATE projection_threads
        SET deleted_at = '2026-08-20T15:00:01.000Z'
        WHERE thread_id = ${activeThreadId}
      `
      expect(yield* repository.isThreadDeleted(activeThreadId)).toBe(true)

      const admissionKey = 'proposal-verified:revision-explicit-lease:cartographer:test'
      yield* repository.enqueue({
        admissionKey,
        target: {
          ...target,
          revisionId: ProposalRevisionId.make('revision-explicit-lease'),
        },
        now: '2026-08-20T15:00:02.000Z',
      })
      const leased = yield* repository.leaseForExplicitStart({
        admissionKey,
        ownerId: 'worker-explicit',
        leaseExpiresAt: '2099-08-20T15:00:32.000Z',
        now: '2026-08-20T15:00:03.000Z',
      })
      expect(leased).not.toBeNull()
      expect(
        yield* repository.assertLeaseActive(
          {
            admissionId: leased!.admissionId,
            ownerId: 'worker-explicit',
            leaseEpoch: leased!.leaseEpoch,
          },
          admissionKey,
        ),
      ).toBe(true)
      expect(
        yield* repository.assertLeaseActive(
          {
            admissionId: leased!.admissionId,
            ownerId: 'stale-worker',
            leaseEpoch: leased!.leaseEpoch,
          },
          admissionKey,
        ),
      ).toBe(false)
      expect(
        yield* repository.releaseExplicitStart({
          admissionId: leased!.admissionId,
          ownerId: 'worker-explicit',
          leaseEpoch: leased!.leaseEpoch,
          now: '2026-08-20T15:00:04.000Z',
        }),
      ).toBe(true)
      expect(
        yield* repository.assertLeaseActive(
          {
            admissionId: leased!.admissionId,
            ownerId: 'worker-explicit',
            leaseEpoch: leased!.leaseEpoch,
          },
          admissionKey,
        ),
      ).toBe(false)
    }),
  )
})
