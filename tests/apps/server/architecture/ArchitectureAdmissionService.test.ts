// tests/apps/server/architecture/ArchitectureAdmissionService.test.ts
// verifies durable proposal admission execution and retry classification

import { it } from '@effect/vitest'
import {
  ProposalGenerationError,
  ProposalGenerationId,
  ProposalId,
  ProposalRevisionId,
  ThreadId,
} from '@t3tools/contracts'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import * as TestClock from 'effect/testing/TestClock'
import { expect } from 'vite-plus/test'

import * as ArchitectureAdmissionRepository from '../../../../apps/server/src/architecture/ArchitectureAdmissionRepository.ts'
import * as ArchitectureAdmissionService from '../../../../apps/server/src/architecture/ArchitectureAdmissionService.ts'
import * as PlannedImpactService from '../../../../apps/server/src/architecture/PlannedImpactService.ts'
import * as AtlasRebuildService from '../../../../apps/server/src/cartographer/AtlasRebuildService.ts'
import * as CartographerAnalyzer from '../../../../apps/server/src/cartographer/CartographerAnalyzer.ts'
import * as ProjectArchitectureLifecycleService from '../../../../apps/server/src/cartographer/ProjectArchitectureLifecycleService.ts'
import { SqlitePersistenceMemory } from '../../../../apps/server/src/persistence/Layers/Sqlite.ts'
import * as ProposalGenerationService from '../../../../apps/server/src/proposal/ProposalGenerationService.ts'

const threadId = ThreadId.make('thread-architecture-admission-service')
const proposalId = ProposalId.make('proposal-architecture-admission-service')
const startCalls: Array<{
  readonly admissionKey: string
  readonly revision: number
  readonly revisionId: ProposalRevisionId
}> = []
const forcedStartCalls: boolean[] = []
let currentAnalyzerFingerprint = 'cartographer:test'
const admittedGenerationStates = new Map<
  string,
  {
    readonly generationId: ProposalGenerationId
    readonly state: 'abandoned' | 'queued' | 'ready'
    readonly errorCode: string | null
  }
>()
let blockedStart: {
  readonly revision: number
  readonly started: Deferred.Deferred<void>
  readonly interrupted: Deferred.Deferred<void>
} | null = null

const proposalGenerations = ProposalGenerationService.ProposalGenerationService.of({
  startAdmitted: (input) =>
  {
    const blocked = blockedStart
    return Effect.sync(() =>
    {
      forcedStartCalls.push(input.forceNewAttempt === true)
      startCalls.push({
        admissionKey: input.admissionKey,
        revision: input.revision ?? 1,
        revisionId: input.revisionId,
      })
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() =>
        {
          admittedGenerationStates.set(input.admissionKey, {
            generationId: ProposalGenerationId.make(`generation-${input.revision}`),
            state: 'ready',
            errorCode: null,
          })
        }),
      ),
      Effect.andThen(
        blocked?.revision === input.revision
          ? Deferred.succeed(blocked.started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(blocked.interrupted, undefined)),
            )
          : input.revision === 2
            ? Effect.fail(
                new ProposalGenerationError({
                  failure: 'persistence-failed',
                  message: 'The admitted generation could not be stored transiently.',
                }),
              )
            : input.revision === 3
              ? Effect.fail(
                  new ProposalGenerationError({
                    failure: 'scope-mismatch',
                    message: 'The exact proposal identity no longer matches.',
                  }),
                )
              : input.revision === 4
                ? Effect.fail(
                    new ProposalGenerationError({
                      failure: 'analysis-failed',
                      message: 'The analyzer identity is terminal for this admission.',
                    }),
                  )
                : input.revision === 9
                  ? Effect.fail(
                      new ProposalGenerationError({
                        failure: 'io-failed',
                        message: 'The bounded analysis artifact read failed transiently.',
                      }),
                    )
                  : input.revision === 10
                    ? Effect.fail(
                        new ProposalGenerationError({
                          failure: 'process-failed',
                          message: 'The analyzer process failed transiently.',
                        }),
                      )
                    : Effect.succeed({
                        generationId: ProposalGenerationId.make(
                          input.revision === 13
                            ? 'generation-admitted-background-io'
                            : 'generation-admitted-success',
                        ),
                        proposalId,
                        revisionId: input.revisionId,
                        revision: input.revision,
                        threadId,
                        state: input.revision === 13 ? ('queued' as const) : ('ready' as const),
                        authority: 'authoritative' as const,
                        freshness: 'fresh' as const,
                        workspaceSnapshotTreeOid: 'workspace-tree',
                        analyzerVersion: input.analyzerFingerprint,
                        baseGraphArtifact: null,
                        proposedGraphArtifact: null,
                        impactArtifact: null,
                        impactProjectionArtifact: null,
                        errorCode: null,
                        createdAt: '2026-08-20T12:00:00.000Z',
                        updatedAt: '2026-08-20T12:00:00.000Z',
                      }),
      ),
    )
  },
  get: (input) =>
    input.generationId === 'generation-admitted-background-io'
      ? Effect.succeed({
          generationId: input.generationId,
          proposalId,
          revisionId: ProposalRevisionId.make('revision-admitted-13'),
          revision: 13,
          threadId,
          state: 'failed' as const,
          authority: 'authoritative' as const,
          freshness: 'fresh' as const,
          workspaceSnapshotTreeOid: 'workspace-tree',
          analyzerVersion: 'cartographer:test',
          baseGraphArtifact: null,
          proposedGraphArtifact: null,
          impactArtifact: null,
          impactProjectionArtifact: null,
          errorCode: 'io-failed',
          createdAt: '2026-08-20T12:00:00.000Z',
          updatedAt: '2026-08-20T12:00:01.000Z',
        })
      : Effect.die('unused'),
  latest: () => Effect.die('unused'),
  latestAdmitted: (input) =>
    Effect.sync(() => admittedGenerationStates.get(input.admissionKey) ?? null),
  resolveArchitectureTarget: () => Effect.die('unused'),
  resolveImpactTarget: () => Effect.die('unused'),
  cancelThread: () => Effect.die('unused'),
})

const cartographerAnalyzer = CartographerAnalyzer.CartographerAnalyzer.of({
  identify: Effect.sync(() => ({
    cliPath: '/test/cartographer',
    fingerprint: currentAnalyzerFingerprint,
  })),
  prepareCurrentWorktree: () => Effect.die('unused'),
  analyzeTrees: () => Effect.die('unused'),
  buildProjectAtlas: () => Effect.die('unused'),
})

const plannedImpacts = PlannedImpactService.PlannedImpactService.of({
  upsert: () => Effect.die('unused'),
  get: () => Effect.die('unused'),
  findLatestForAuthority: () => Effect.die('unused'),
  appendAnchored: () => Effect.die('unused'),
})

const projectArchitecture =
  {} as ProjectArchitectureLifecycleService.ProjectArchitectureLifecycleService['Service']
const atlasRebuild = {} as AtlasRebuildService.AtlasRebuildService['Service']

const seedActiveThread = (activeThreadId: ThreadId) =>
  Effect.gen(function* ()
  {
    const sql = yield* SqlClient.SqlClient
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
        'project-admission-active',
        'Active admission thread',
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
        '2026-08-20T11:59:58.000Z',
        '2026-08-20T11:59:59.000Z',
        NULL
      )
      ON CONFLICT(thread_id) DO UPDATE SET
        deleted_at = NULL,
        updated_at = excluded.updated_at
    `
  })

const serviceLayer = ArchitectureAdmissionService.layer.pipe(
  Layer.provideMerge(
    Layer.succeed(ProposalGenerationService.ProposalGenerationService, proposalGenerations),
  ),
  Layer.provideMerge(
    Layer.succeed(CartographerAnalyzer.CartographerAnalyzer, cartographerAnalyzer),
  ),
  Layer.provideMerge(Layer.succeed(PlannedImpactService.PlannedImpactService, plannedImpacts)),
  Layer.provideMerge(
    Layer.succeed(
      ProjectArchitectureLifecycleService.ProjectArchitectureLifecycleService,
      projectArchitecture,
    ),
  ),
  Layer.provideMerge(Layer.succeed(AtlasRebuildService.AtlasRebuildService, atlasRebuild)),
)

const layer = it.layer(
  Layer.mergeAll(serviceLayer, ArchitectureAdmissionRepository.layer).pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
)

layer('ArchitectureAdmissionService', (it) =>
{
  it.effect('queues one exact generation and separates transient from terminal failures', () =>
    Effect.gen(function* ()
    {
      startCalls.length = 0
      forcedStartCalls.length = 0
      admittedGenerationStates.clear()
      currentAnalyzerFingerprint = 'cartographer:test'
      const repository = yield* ArchitectureAdmissionRepository.ArchitectureAdmissionRepository
      const service = yield* ArchitectureAdmissionService.ArchitectureAdmissionService
      yield* seedActiveThread(threadId)
      for (const revision of [1, 2, 3, 4, 9, 10, 13])
      {
        const revisionId = ProposalRevisionId.make(
          revision === 1 ? 'revision-admitted-success' : `revision-admitted-${revision}`,
        )
        yield* repository.enqueue({
          admissionKey: `proposal-verified:${revisionId}:cartographer:test`,
          target: {
            _tag: 'proposal-verified',
            version: 1,
            threadId,
            proposalId,
            revisionId,
            revision,
            analyzerFingerprint: 'cartographer:test',
          },
          now: `2026-08-20T12:00:0${revision}.000Z`,
        })
      }

      const drainFiber = yield* service.drain.pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      yield* TestClock.adjust('200 millis')
      yield* Fiber.join(drainFiber)

      const byRevision = new Map(
        (yield* repository.list).map((admission) => [
          admission.target._tag === 'proposal-verified' ? admission.target.revision : -1,
          admission,
        ]),
      )
      expect(byRevision.get(1)).toMatchObject({
        state: 'complete',
        attemptCount: 1,
        lastErrorCode: null,
      })
      expect(byRevision.get(2)).toMatchObject({
        state: 'retry-wait',
        attemptCount: 1,
        lastErrorClass: 'proposal-generation',
        lastErrorCode: 'persistence-failed',
      })
      expect(byRevision.get(2)?.nextAttemptAt).not.toBeNull()
      expect(byRevision.get(3)).toMatchObject({
        state: 'terminal-failed',
        attemptCount: 1,
        lastErrorClass: 'proposal-generation',
        lastErrorCode: 'scope-mismatch',
      })
      expect(byRevision.get(4)).toMatchObject({
        state: 'terminal-failed',
        attemptCount: 1,
        lastErrorClass: 'proposal-generation',
        lastErrorCode: 'analysis-failed',
      })
      for (const revision of [9, 10])
      {
        expect(byRevision.get(revision)).toMatchObject({
          state: 'retry-wait',
          attemptCount: 1,
          lastErrorClass: 'proposal-generation',
        })
        expect(byRevision.get(revision)?.nextAttemptAt).not.toBeNull()
      }
      expect(byRevision.get(9)?.lastErrorCode).toBe('io-failed')
      expect(byRevision.get(10)?.lastErrorCode).toBe('process-failed')
      expect(byRevision.get(13)).toMatchObject({
        state: 'retry-wait',
        lastErrorClass: 'proposal-generation',
        lastErrorCode: 'io-failed',
      })
      expect(
        startCalls.map((call) => call.revision).toSorted((left, right) => left - right),
      ).toEqual([1, 2, 3, 4, 9, 10, 13])
      expect(startCalls).toContainEqual({
        admissionKey: 'proposal-verified:revision-admitted-success:cartographer:test',
        revision: 1,
        revisionId: ProposalRevisionId.make('revision-admitted-success'),
      })

      yield* service.drain
      expect(
        startCalls.map((call) => call.revision).toSorted((left, right) => left - right),
      ).toEqual([1, 2, 3, 4, 9, 10, 13])
    }),
  )

  it.effect('reconciles one startup-abandoned generation before the initial drain', () =>
    Effect.gen(function* ()
    {
      startCalls.length = 0
      forcedStartCalls.length = 0
      admittedGenerationStates.clear()
      currentAnalyzerFingerprint = 'cartographer:test'
      const repository = yield* ArchitectureAdmissionRepository.ArchitectureAdmissionRepository
      const service = yield* ArchitectureAdmissionService.ArchitectureAdmissionService
      const sql = yield* SqlClient.SqlClient
      yield* seedActiveThread(threadId)
      const abandonedRevisionId = ProposalRevisionId.make('revision-admitted-abandoned')
      const abandonedKey = `proposal-verified:${abandonedRevisionId}:cartographer:test`
      const readyRevisionId = ProposalRevisionId.make('revision-admitted-ready')
      const readyKey = `proposal-verified:${readyRevisionId}:cartographer:test`
      const deletedThreadId = ThreadId.make('thread-admitted-deleted-at-restart')
      const deletedRevisionId = ProposalRevisionId.make('revision-admitted-deleted-at-restart')
      const deletedKey = `proposal-verified:${deletedRevisionId}:cartographer:test`
      for (const [revision, revisionId, admissionKey] of [
        [5, abandonedRevisionId, abandonedKey],
        [6, readyRevisionId, readyKey],
      ] as const)
      {
        yield* repository.enqueue({
          admissionKey,
          target: {
            _tag: 'proposal-verified',
            version: 1,
            threadId,
            proposalId,
            revisionId,
            revision,
            analyzerFingerprint: 'cartographer:test',
          },
          state: 'complete',
          now: '2026-08-20T13:00:00.000Z',
        })
      }
      admittedGenerationStates.set(abandonedKey, {
        generationId: ProposalGenerationId.make('generation-admitted-abandoned'),
        state: 'abandoned',
        errorCode: 'server-restarted',
      })
      admittedGenerationStates.set(readyKey, {
        generationId: ProposalGenerationId.make('generation-admitted-ready'),
        state: 'ready',
        errorCode: null,
      })
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
          ${deletedThreadId},
          'project-admission-restart-deleted',
          'Deleted restart admission thread',
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
          '2026-08-20T13:00:00.000Z',
          '2026-08-20T13:00:01.000Z',
          '2026-08-20T13:00:02.000Z'
        )
      `
      yield* repository.enqueue({
        admissionKey: deletedKey,
        target: {
          _tag: 'proposal-verified',
          version: 1,
          threadId: deletedThreadId,
          proposalId,
          revisionId: deletedRevisionId,
          revision: 12,
          analyzerFingerprint: 'cartographer:test',
        },
        state: 'complete',
        now: '2026-08-20T13:00:03.000Z',
      })
      admittedGenerationStates.set(deletedKey, {
        generationId: ProposalGenerationId.make('generation-admitted-deleted-at-restart'),
        state: 'abandoned',
        errorCode: 'server-restarted',
      })

      yield* Effect.scoped(service.start)
      expect(startCalls.map((call) => call.revision)).toEqual([5])
      expect(
        (yield* repository.list).find((admission) => admission.admissionKey === abandonedKey),
      ).toMatchObject({ state: 'complete', attemptCount: 1 })
      expect(
        (yield* repository.list).find((admission) => admission.admissionKey === readyKey),
      ).toMatchObject({ state: 'complete', attemptCount: 0 })
      expect(
        (yield* repository.list).find((admission) => admission.admissionKey === deletedKey),
      ).toMatchObject({ state: 'complete', attemptCount: 0 })

      yield* Effect.scoped(service.start)
      expect(startCalls.map((call) => call.revision)).toEqual([5])
    }),
  )

  it.effect('routes explicit retry through the exact durable proposal admission', () =>
    Effect.gen(function* ()
    {
      startCalls.length = 0
      forcedStartCalls.length = 0
      admittedGenerationStates.clear()
      currentAnalyzerFingerprint = 'cartographer:test'
      const repository = yield* ArchitectureAdmissionRepository.ArchitectureAdmissionRepository
      const service = yield* ArchitectureAdmissionService.ArchitectureAdmissionService
      const sql = yield* SqlClient.SqlClient
      yield* seedActiveThread(threadId)
      const revisionId = ProposalRevisionId.make('revision-admitted-explicit-retry')
      const admissionKey = `proposal-verified:${revisionId}:cartographer:test`
      yield* repository.enqueue({
        admissionKey,
        target: {
          _tag: 'proposal-verified',
          version: 1,
          threadId,
          proposalId,
          revisionId,
          revision: 7,
          analyzerFingerprint: 'cartographer:test',
        },
        state: 'complete',
        now: '2026-08-20T14:00:00.000Z',
      })

      const generation = yield* service.retryProposal({ threadId, proposalId, revisionId })
      expect(generation).toMatchObject({
        proposalId,
        revisionId,
        revision: 7,
        state: 'ready',
      })
      expect(
        (yield* repository.list).find((admission) => admission.admissionKey === admissionKey),
      ).toMatchObject({ state: 'queued' })
      expect(startCalls).toContainEqual({ admissionKey, revision: 7, revisionId })
      expect(forcedStartCalls).toEqual([true])

      currentAnalyzerFingerprint = 'cartographer:rotated'
      const rotated = yield* service.retryProposal({ threadId, proposalId, revisionId })
      expect(rotated).toMatchObject({ analyzerVersion: 'cartographer:rotated' })
      expect(startCalls.at(-1)).toMatchObject({
        admissionKey: `proposal-verified:${revisionId}:cartographer:rotated`,
        revisionId,
      })
      expect(forcedStartCalls.at(-1)).toBe(false)
      expect(
        (yield* repository.list).filter(
          (candidate) =>
            candidate.target._tag === 'proposal-verified' &&
            candidate.target.revisionId === revisionId,
        ),
      ).toHaveLength(2)

      yield* sql`
        UPDATE architecture_analysis_admissions
        SET state = 'cancelled'
        WHERE admission_key = ${`proposal-verified:${revisionId}:cartographer:rotated`}
      `
      yield* sql`
        UPDATE architecture_analysis_admissions
        SET created_at = '2099-08-20T14:00:00.000Z'
        WHERE admission_key = ${admissionKey}
      `
      const cancelledRotated = yield* service
        .retryProposal({ threadId, proposalId, revisionId })
        .pipe(Effect.flip)
      expect(cancelledRotated).toMatchObject({ failure: 'scope-mismatch' })

      yield* sql`
        UPDATE projection_threads
        SET deleted_at = '2026-08-20T14:00:01.000Z'
        WHERE thread_id = ${threadId}
      `
      const deletedRetry = yield* service
        .retryProposal({ threadId, proposalId, revisionId })
        .pipe(Effect.flip)
      expect(deletedRetry).toMatchObject({ failure: 'scope-mismatch' })

      const missingAdmission = yield* service
        .retryProposal({
          threadId,
          proposalId,
          revisionId: ProposalRevisionId.make('revision-admitted-missing'),
        })
        .pipe(Effect.flip)
      expect(missingAdmission).toMatchObject({ failure: 'not-found' })
    }),
  )

  it.effect('cancels and interrupts an in-flight admission for a deleted thread', () =>
    Effect.gen(function* ()
    {
      startCalls.length = 0
      forcedStartCalls.length = 0
      admittedGenerationStates.clear()
      currentAnalyzerFingerprint = 'cartographer:test'
      const repository = yield* ArchitectureAdmissionRepository.ArchitectureAdmissionRepository
      const service = yield* ArchitectureAdmissionService.ArchitectureAdmissionService
      yield* seedActiveThread(threadId)
      const revisionId = ProposalRevisionId.make('revision-admitted-cancelled-in-flight')
      const admissionKey = `proposal-verified:${revisionId}:cartographer:test`
      const started = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      blockedStart = { revision: 8, started, interrupted }

      yield* repository.enqueue({
        admissionKey,
        target: {
          _tag: 'proposal-verified',
          version: 1,
          threadId,
          proposalId,
          revisionId,
          revision: 8,
          analyzerFingerprint: 'cartographer:test',
        },
        now: '2026-08-20T15:00:00.000Z',
      })

      const drainFiber = yield* service.drain.pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* service.cancelThread(threadId)
      yield* Deferred.await(interrupted)
      yield* Fiber.join(drainFiber)

      expect(
        (yield* repository.list).find((admission) => admission.admissionKey === admissionKey),
      ).toMatchObject({ state: 'cancelled', leaseOwner: null, leaseExpiresAt: null })
    }).pipe(
      Effect.ensuring(
        Effect.sync(() =>
        {
          blockedStart = null
        }),
      ),
    ),
  )

  it.effect('cancels claimed work before side effects when its thread is durably deleted', () =>
    Effect.gen(function* ()
    {
      startCalls.length = 0
      forcedStartCalls.length = 0
      admittedGenerationStates.clear()
      currentAnalyzerFingerprint = 'cartographer:test'
      const repository = yield* ArchitectureAdmissionRepository.ArchitectureAdmissionRepository
      const service = yield* ArchitectureAdmissionService.ArchitectureAdmissionService
      const sql = yield* SqlClient.SqlClient
      const deletedThreadId = ThreadId.make('thread-admission-durably-deleted')
      const revisionId = ProposalRevisionId.make('revision-admission-durably-deleted')
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
          ${deletedThreadId},
          'project-admission-deleted',
          'Deleted admission thread',
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
          '2026-08-20T16:00:00.000Z',
          '2026-08-20T16:00:01.000Z',
          '2026-08-20T16:00:02.000Z'
        )
      `
      yield* repository.enqueue({
        admissionKey: `proposal-verified:${revisionId}:cartographer:test`,
        target: {
          _tag: 'proposal-verified',
          version: 1,
          threadId: deletedThreadId,
          proposalId,
          revisionId,
          revision: 11,
          analyzerFingerprint: 'cartographer:test',
        },
        now: '2026-08-20T16:00:03.000Z',
      })

      yield* service.drain

      expect(startCalls).toEqual([])
      expect(
        (yield* repository.list).find(
          (admission) =>
            admission.target._tag === 'proposal-verified' &&
            admission.target.revisionId === revisionId,
        ),
      ).toMatchObject({
        state: 'cancelled',
        lastErrorClass: 'lifecycle',
        lastErrorCode: 'thread-deleted',
      })
    }),
  )
})
