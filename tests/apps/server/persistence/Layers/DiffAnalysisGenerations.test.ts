// tests/apps/server/persistence/Layers/DiffAnalysisGenerations.test.ts
// verifies atomic diff analysis admission and lifecycle persistence

import { DiffAnalysisId, type DiffAnalysisSource } from '@t3tools/contracts'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'

import { DiffAnalysisGenerationRepositoryLive } from '../../../../../apps/server/src/persistence/Layers/DiffAnalysisGenerations.ts'
import { runMigrations } from '../../../../../apps/server/src/persistence/Migrations.ts'
import { DiffAnalysisGenerationRepository } from '../../../../../apps/server/src/persistence/Services/DiffAnalysisGenerations.ts'
import * as NodeSqliteClient from '../../../../../apps/server/src/persistence/NodeSqliteClient.ts'

const prepareMigration = Effect.gen(function* ()
{
  yield* runMigrations({ toMigrationInclusive: 70 })
})

const persistenceLayer = Layer.mergeAll(
  DiffAnalysisGenerationRepositoryLive,
  Layer.effectDiscard(prepareMigration),
).pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()))
const layer = it.layer(persistenceLayer)
const now = '2026-08-07T12:00:00.000Z'

const source: DiffAnalysisSource = {
  sourceKind: 'tree-pair',
  cwd: '/tmp/repository',
  baseTreeOid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  headTreeOid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
}

// the suite shares one in-memory database; each case passes its own repository
// key so admissions do not collide on the cache identity
function row(
  diffAnalysisId: DiffAnalysisId,
  descriptor: DiffAnalysisSource = source,
  repositoryKey = 'repository-1',
)
{
  return {
    diffAnalysisId,
    environmentId: 'environment-1',
    repositoryKey,
    baseTreeOid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    headTreeOid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    baseAnalyzerRef: 'base-commit',
    headAnalyzerRef: 'head-commit',
    analyzerVersion: 'analyzer-1',
    analysisPolicyVersion: 'diff-analysis-v1',
    configDigest: 'config-1',
    scopeDigest: 'scope-1',
    tsconfigDigest: 'tsconfig-1',
    source: descriptor,
    state: 'queued' as const,
    artifactRoot: `/tmp/${diffAnalysisId}`,
    headRootPath: null,
    baseGraphPath: null,
    headGraphPath: null,
    impactPath: null,
    impactProjectionPath: null,
    implementationChangedFileCount: null,
    artifactByteLength: 0,
    errorCode: null,
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
  }
}

layer('DiffAnalysisGenerationRepository', (it) =>
{
  it.effect('admits once and transactionally refetches the first provenance row', () =>
    Effect.gen(function* ()
    {
      const repository = yield* DiffAnalysisGenerationRepository
      const firstId = DiffAnalysisId.make('analysis-first')
      const first = yield* repository.admit(row(firstId))
      assert.isTrue(first.inserted)

      const secondSource = { ...source, cwd: '/tmp/other-worktree' } as DiffAnalysisSource
      const second = yield* repository.admit(
        row(DiffAnalysisId.make('analysis-second'), secondSource),
      )
      assert.isFalse(second.inserted)
      assert.equal(second.row.diffAnalysisId, firstId)
      assert.deepStrictEqual(second.row.source, source)
    }),
  )

  it.effect('persists terminal observation rows and returns deletion status', () =>
    Effect.gen(function* ()
    {
      const repository = yield* DiffAnalysisGenerationRepository
      const diffAnalysisId = DiffAnalysisId.make('analysis-lifecycle')
      yield* repository.admit(row(diffAnalysisId, source, 'repository-lifecycle'))
      yield* repository.update({
        diffAnalysisId,
        state: 'failed',
        headRootPath: null,
        baseGraphPath: null,
        headGraphPath: null,
        impactPath: null,
        impactProjectionPath: '/tmp/analysis-lifecycle/impact-projection.json',
        implementationChangedFileCount: 4,
        artifactByteLength: 0,
        errorCode: 'analysis-failed',
        updatedAt: now,
      })
      const terminal = yield* repository.listTerminalBefore({
        cutoff: '2026-08-07T12:05:00.001Z',
      })
      assert.equal(
        terminal[0]?.impactProjectionPath,
        '/tmp/analysis-lifecycle/impact-projection.json',
      )
      assert.equal(terminal[0]?.implementationChangedFileCount, 4)
      assert.deepStrictEqual(
        terminal.map((entry) => entry.diffAnalysisId),
        [diffAnalysisId],
      )
      const retried = yield* repository.retryTerminal({
        diffAnalysisId,
        updatedAt: '2026-08-07T12:05:01.000Z',
      })
      const retriedRow = Option.getOrThrow(retried)
      assert.equal(retriedRow.state, 'queued')
      assert.isTrue(
        Option.isNone(
          yield* repository.retryTerminal({
            diffAnalysisId,
            updatedAt: '2026-08-07T12:05:02.000Z',
          }),
        ),
      )
      const touchedAt = yield* repository.touch({
        diffAnalysisId,
        lastAccessedAt: retriedRow.lastAccessedAt,
      })
      assert.equal(touchedAt, '2026-08-07T12:05:01.001Z')
      assert.isFalse(
        yield* repository.deleteIfUnchanged({
          diffAnalysisId,
          state: retriedRow.state,
          updatedAt: retriedRow.updatedAt,
          lastAccessedAt: retriedRow.lastAccessedAt,
        }),
      )
      assert.isTrue((yield* repository.listAllIds()).includes(diffAnalysisId))
      assert.isTrue(
        yield* repository.deleteIfUnchanged({
          diffAnalysisId,
          state: retriedRow.state,
          updatedAt: retriedRow.updatedAt,
          lastAccessedAt: touchedAt,
        }),
      )
      assert.isFalse(
        yield* repository.deleteIfUnchanged({
          diffAnalysisId,
          state: retriedRow.state,
          updatedAt: retriedRow.updatedAt,
          lastAccessedAt: touchedAt,
        }),
      )
      assert.isTrue(Option.isNone(yield* repository.getById({ diffAnalysisId })))
    }),
  )

  it.effect('preserves a retried row against a same-clock stale terminal deletion', () =>
    Effect.gen(function* ()
    {
      const repository = yield* DiffAnalysisGenerationRepository
      const diffAnalysisId = DiffAnalysisId.make('analysis-terminal-retry-aba')
      const before = '2026-08-07T11:59:59.999Z'
      yield* repository.admit({
        ...row(diffAnalysisId, source, 'repository-terminal-retry-aba'),
        createdAt: before,
        updatedAt: before,
        lastAccessedAt: before,
      })
      assert.equal(yield* repository.touch({ diffAnalysisId, lastAccessedAt: now }), now)
      const firstFailure = yield* repository.update({
        diffAnalysisId,
        state: 'failed',
        headRootPath: null,
        baseGraphPath: null,
        headGraphPath: null,
        impactPath: null,
        impactProjectionPath: null,
        implementationChangedFileCount: null,
        artifactByteLength: 0,
        errorCode: 'analysis-failed',
        updatedAt: now,
      })
      assert.equal(firstFailure.updatedAt, now)
      assert.equal(firstFailure.lastAccessedAt, now)
      const staleCandidates = yield* repository.listTerminalBefore({
        cutoff: '2026-08-07T12:00:00.001Z',
      })
      const staleCandidate = staleCandidates.find(
        (candidate) => candidate.diffAnalysisId === diffAnalysisId,
      )
      assert.isDefined(staleCandidate)
      if (staleCandidate === undefined) return yield* Effect.die('stale candidate was not listed')

      const retried = Option.getOrThrow(
        yield* repository.retryTerminal({ diffAnalysisId, updatedAt: now }),
      )
      assert.equal(retried.updatedAt, '2026-08-07T12:00:00.001Z')
      assert.equal(retried.lastAccessedAt, '2026-08-07T12:00:00.001Z')
      const secondFailure = yield* repository.update({
        diffAnalysisId,
        state: 'failed',
        headRootPath: null,
        baseGraphPath: null,
        headGraphPath: null,
        impactPath: null,
        impactProjectionPath: null,
        implementationChangedFileCount: null,
        artifactByteLength: 0,
        errorCode: 'analysis-failed',
        updatedAt: now,
      })
      assert.equal(secondFailure.updatedAt, '2026-08-07T12:00:00.002Z')
      assert.equal(secondFailure.lastAccessedAt, '2026-08-07T12:00:00.001Z')
      assert.isFalse(
        yield* repository.deleteIfUnchanged({
          diffAnalysisId,
          state: staleCandidate.state,
          updatedAt: staleCandidate.updatedAt,
          lastAccessedAt: staleCandidate.lastAccessedAt,
        }),
      )
      const current = yield* repository.getById({ diffAnalysisId })
      assert.deepStrictEqual(Option.getOrThrow(current), secondFailure)

      const rollbackRetry = Option.getOrThrow(
        yield* repository.retryTerminal({
          diffAnalysisId,
          updatedAt: '2026-08-07T11:00:00.000Z',
        }),
      )
      assert.equal(rollbackRetry.updatedAt, '2026-08-07T12:00:00.003Z')
      assert.equal(rollbackRetry.lastAccessedAt, '2026-08-07T12:00:00.002Z')
    }),
  )
})
