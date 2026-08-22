// tests/apps/server/proposal/ProposalRetainedRefReconciliation.test.ts
// verifies bounded report-only recovery of owner-local proposal retained refs

// @effect-diagnostics-next-line nodeBuiltinImport:off - integration fixture invokes host git
import * as NodeChildProcess from 'node:child_process'
// @effect-diagnostics-next-line nodeBuiltinImport:off - integration fixture owns temp files
import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
// @effect-diagnostics-next-line nodeBuiltinImport:off - integration fixture resolves host paths
import * as NodePath from 'node:path'
import * as NodeUtil from 'node:util'

import { it } from '@effect/vitest'
import {
  EnvironmentId,
  ProjectId,
  ProposalId,
  ProviderInstanceId,
  ThreadId,
} from '@t3tools/contracts'
import * as Clock from 'effect/Clock'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as TestClock from 'effect/testing/TestClock'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import { describe, expect } from 'vite-plus/test'

import { SqlitePersistenceMemory } from '../../../../apps/server/src/persistence/Layers/Sqlite.ts'
import * as ProposalRetainedRefAttemptStore from '../../../../apps/server/src/proposal/ProposalRetainedRefAttemptStore.ts'
import * as ProposalRetainedRefReconciler from '../../../../apps/server/src/proposal/ProposalRetainedRefReconciler.ts'
import * as ProposalService from '../../../../apps/server/src/proposal/ProposalService.ts'

const execFile = NodeUtil.promisify(NodeChildProcess.execFile)
const ReconcilerLayer = ProposalRetainedRefReconciler.layer.pipe(
  Layer.provide(ProposalRetainedRefAttemptStore.layer),
)
const TestLayer = Layer.mergeAll(
  ReconcilerLayer,
  ProposalService.layer,
  ProposalRetainedRefAttemptStore.layer,
).pipe(Layer.provideMerge(SqlitePersistenceMemory))

async function git(cwd: string, args: ReadonlyArray<string>): Promise<string>
{
  const result = await execFile('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  })
  return result.stdout.trim()
}

async function initializeRepository(prefix: string): Promise<string>
{
  const cwd = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix))
  await git(cwd, ['init'])
  await git(cwd, ['config', 'user.email', 'proposal-reconcile@example.com'])
  await git(cwd, ['config', 'user.name', 'Proposal Reconcile'])
  await NodeFSP.writeFile(NodePath.join(cwd, 'tracked.txt'), 'tracked\n')
  await git(cwd, ['add', '.'])
  await git(cwd, ['commit', '-m', 'initial'])
  return cwd
}

async function commonDir(cwd: string): Promise<string>
{
  return NodePath.resolve(cwd, await git(cwd, ['rev-parse', '--git-common-dir']))
}

async function createPair(cwd: string, token: string): Promise<void>
{
  await git(cwd, ['update-ref', `refs/t3/proposals/${token}/base`, 'HEAD'])
  await git(cwd, ['update-ref', `refs/t3/proposals/${token}/proposed`, 'HEAD'])
}

function refsFor(token: string)
{
  return {
    baseRef: `refs/t3/proposals/${token}/base`,
    proposedRef: `refs/t3/proposals/${token}/proposed`,
  }
}

const scope = {
  environmentId: EnvironmentId.make('environment-proposal-reconcile'),
  projectId: ProjectId.make('project-proposal-reconcile'),
  sourceThreadId: ThreadId.make('thread-proposal-reconcile'),
  producer: {
    providerSessionId: 'provider-session-proposal-reconcile',
    providerInstanceId: ProviderInstanceId.make('codex-test'),
  },
  verifiedAnalyzerFingerprint: 'cartographer:proposal-reconcile-test',
} as const

const clearProposalState = Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient
  yield* sql`DELETE FROM proposal_retained_ref_attempts`
  yield* sql`DELETE FROM proposals`
})

it.layer(TestLayer)('ProposalRetainedRefReconciler', (it) =>
{
  describe('classification and safety', () =>
  {
    it.effect(
      'reports stale, grace, malformed, partial, lookalike, and packed refs without mutation',
      () =>
        Effect.gen(function* ()
        {
          yield* clearProposalState
          const cwd = yield* Effect.acquireRelease(
            Effect.promise(() => initializeRepository('456code-proposal-reconcile-')),
            (directory) =>
              Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })).pipe(
                Effect.ignore,
              ),
          )
          const store = yield* ProposalRetainedRefAttemptStore.ProposalRetainedRefAttemptStore
          const reconciler = yield* ProposalRetainedRefReconciler.ProposalRetainedRefReconciler
          const gitCommonDir = yield* Effect.promise(() => commonDir(cwd))
          yield* TestClock.setTime(2 * 24 * 60 * 60 * 1_000)
          const now = yield* Clock.currentTimeMillis
          const staleToken = 'a'.repeat(64)
          const exactToken = 'b'.repeat(64)
          const recentToken = 'c'.repeat(64)
          const partialToken = 'd'.repeat(64)
          const lookalikeToken = 'e'.repeat(64)
          const attempts = [
            [staleToken, now - 24 * 60 * 60 * 1_000 - 1],
            [exactToken, now - 24 * 60 * 60 * 1_000],
            [recentToken, now - 60_000],
            [partialToken, now - 24 * 60 * 60 * 1_000 - 1],
          ] as const
          for (const [refToken, createdAtMillis] of attempts)
          {
            yield* store.register({
              refToken,
              gitCommonDir,
              ...refsFor(refToken),
              createdAt: DateTime.formatIso(DateTime.makeUnsafe(createdAtMillis)),
            })
          }
          yield* Effect.promise(() => createPair(cwd, staleToken))
          yield* Effect.promise(() => createPair(cwd, exactToken))
          yield* Effect.promise(() => createPair(cwd, recentToken))
          yield* Effect.promise(() =>
            git(cwd, ['update-ref', refsFor(partialToken).baseRef, 'HEAD']),
          )
          yield* Effect.promise(() => createPair(cwd, lookalikeToken))
          yield* Effect.promise(() => createPair(cwd, 'malformed'))
          yield* Effect.promise(() => git(cwd, ['pack-refs', '--all']))
          const before = yield* Effect.promise(() =>
            git(cwd, ['for-each-ref', '--format=%(refname)', 'refs/t3/proposals']),
          )

          const report = yield* reconciler.reconcile
          const after = yield* Effect.promise(() =>
            git(cwd, ['for-each-ref', '--format=%(refname)', 'refs/t3/proposals']),
          )

          expect(report.candidates).toBe(1)
          expect(report.grace).toBe(2)
          expect(report.malformed).toBe(2)
          expect(report.manualSkip).toBe(2)
          expect(report.deleteAttempted).toBe(0)
          expect(report.deleteSucceeded).toBe(0)
          expect(report.deleteFailed).toBe(0)
          expect(report.items.every((item) => !('gitCommonDir' in item))).toBe(true)
          expect(after).toBe(before)
        }),
    )

    it.effect('retains durable refs and prunes a pending attempt after append', () =>
      Effect.gen(function* ()
      {
        yield* clearProposalState
        const cwd = yield* Effect.acquireRelease(
          Effect.promise(() => initializeRepository('456code-proposal-live-')),
          (directory) =>
            Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })).pipe(
              Effect.ignore,
            ),
        )
        const service = yield* ProposalService.ProposalService
        const store = yield* ProposalRetainedRefAttemptStore.ProposalRetainedRefAttemptStore
        const reconciler = yield* ProposalRetainedRefReconciler.ProposalRetainedRefReconciler
        const sql = yield* SqlClient.SqlClient
        const revision = yield* service.upsert({
          ...scope,
          proposalId: ProposalId.make('proposal-reconcile-live'),
          cwd,
          changes: {
            _tag: 'typed',
            operations: [
              {
                _tag: 'add',
                path: 'live.txt',
                content: { encoding: 'utf8', data: 'live\n' },
              },
            ],
          },
        })
        const token = revision.baseSnapshot.retainedRef.split('/')[3]!
        yield* sql`
          UPDATE proposal_retained_ref_attempts
          SET durable_at = NULL
          WHERE ref_token = ${token}
        `

        const report = yield* reconciler.reconcile

        expect(report.live).toBe(1)
        expect((yield* store.list).some((attempt) => attempt.refToken === token)).toBe(false)
        expect(
          yield* Effect.promise(() =>
            git(cwd, ['show-ref', '--verify', revision.baseSnapshot.retainedRef]),
          ),
        ).not.toBe('')
      }),
    )
  })

  describe('caps', () =>
  {
    it.effect('enumerates at most eight canonical repositories', () =>
      Effect.scoped(
        Effect.gen(function* ()
        {
          yield* clearProposalState
          const store = yield* ProposalRetainedRefAttemptStore.ProposalRetainedRefAttemptStore
          const reconciler = yield* ProposalRetainedRefReconciler.ProposalRetainedRefReconciler
          for (let index = 0; index < 9; index += 1)
          {
            const cwd = yield* Effect.acquireRelease(
              Effect.promise(() => initializeRepository(`456code-proposal-repo-cap-${index}-`)),
              (directory) =>
                Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })).pipe(
                  Effect.ignore,
                ),
            )
            const refToken = index.toString(16).padStart(64, '0')
            yield* store.register({
              refToken,
              gitCommonDir: yield* Effect.promise(() => commonDir(cwd)),
              ...refsFor(refToken),
              createdAt: '2020-01-01T00:00:00.000Z',
            })
            yield* Effect.promise(() => createPair(cwd, refToken))
          }

          const report = yield* reconciler.reconcile

          expect(report.budgetExceeded).toBe(true)
          expect(report.enumerated).toBeLessThanOrEqual(16)
        }),
      ),
    )

    it.effect('enumerates at most 512 refs from one repository', () =>
      Effect.gen(function* ()
      {
        yield* clearProposalState
        const cwd = yield* Effect.acquireRelease(
          Effect.promise(() => initializeRepository('456code-proposal-ref-cap-')),
          (directory) =>
            Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })).pipe(
              Effect.ignore,
            ),
        )
        const store = yield* ProposalRetainedRefAttemptStore.ProposalRetainedRefAttemptStore
        const reconciler = yield* ProposalRetainedRefReconciler.ProposalRetainedRefReconciler
        const token = 'f'.repeat(64)
        yield* store.register({
          refToken: token,
          gitCommonDir: yield* Effect.promise(() => commonDir(cwd)),
          ...refsFor(token),
          createdAt: '2020-01-01T00:00:00.000Z',
        })
        const updates = Array.from(
          { length: 513 },
          (_, index) => `update refs/t3/proposals/cap-${index.toString().padStart(3, '0')} HEAD`,
        )
        yield* Effect.sync(() =>
          NodeChildProcess.execFileSync('git', ['-C', cwd, 'update-ref', '--stdin'], {
            input: `${updates.join('\n')}\n`,
          }),
        )

        const report = yield* reconciler.reconcile

        expect(report.budgetExceeded).toBe(true)
        expect(report.enumerated).toBe(512)
      }),
    )
  })
})
