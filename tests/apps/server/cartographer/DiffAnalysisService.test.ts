// tests/apps/server/cartographer/DiffAnalysisService.test.ts
// verifies exact diff analysis caching and deterministic checkpoint failures

// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off

import * as NodeChildProcess from 'node:child_process'
import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeTimersPromises from 'node:timers/promises'
import * as NodeUtil from 'node:util'

import * as NodeServices from '@effect/platform-node/NodeServices'
import {
  CartographerError,
  DiffAnalysisId,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type DiffAnalysisSource,
} from '@t3tools/contracts'
import { assert, it } from '@effect/vitest'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Scope from 'effect/Scope'
import * as TestClock from 'effect/testing/TestClock'

import * as CartographerAnalyzer from '../../../../apps/server/src/cartographer/CartographerAnalyzer.ts'
import * as DiffAnalysisService from '../../../../apps/server/src/cartographer/DiffAnalysisService.ts'
import * as ServerConfig from '../../../../apps/server/src/config.ts'
import * as ServerEnvironment from '../../../../apps/server/src/environment/ServerEnvironment.ts'
import * as ProjectionSnapshotQuery from '../../../../apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts'
import { DiffAnalysisGenerationRepositoryLive } from '../../../../apps/server/src/persistence/Layers/DiffAnalysisGenerations.ts'
import { SqlitePersistenceMemory } from '../../../../apps/server/src/persistence/Layers/Sqlite.ts'
import {
  DiffAnalysisGenerationRepository,
  type DiffAnalysisGenerationRecord,
  type DiffAnalysisGenerationRepositoryShape,
} from '../../../../apps/server/src/persistence/Services/DiffAnalysisGenerations.ts'
import * as GitVcsDriver from '../../../../apps/server/src/vcs/GitVcsDriver.ts'
import { makeProjectionSnapshotQueryStub } from '../projectionSnapshotQueryTestHelpers.ts'

const execFile = NodeUtil.promisify(NodeChildProcess.execFile)
const fixedEpoch = Date.UTC(2026, 7, 7, 12, 0, 0)
const fixedTimestamp = '2026-08-07T12:00:00.000Z'

async function git(cwd: string, args: ReadonlyArray<string>): Promise<string>
{
  const result = await execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  return result.stdout.trim()
}

async function gitObjectExists(cwd: string, oid: string): Promise<boolean>
{
  try
  {
    await execFile('git', ['-C', cwd, 'cat-file', '-e', oid])
    return true
  }
  catch
  {
    return false
  }
}

async function initializeRepository(): Promise<{
  readonly cwd: string
  readonly baseCommitOid: string
  readonly headCommitOid: string
  readonly baseTreeOid: string
  readonly headTreeOid: string
}>
{
  const cwd = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), '456code-diff-analysis-'))
  await git(cwd, ['init'])
  await git(cwd, ['config', 'user.email', 'diff-analysis@example.com'])
  await git(cwd, ['config', 'user.name', 'Diff Analysis'])
  await NodeFSP.writeFile(NodePath.join(cwd, 'source.ts'), 'export const value = 1\n')
  await git(cwd, ['add', '.'])
  await git(cwd, ['commit', '-m', 'base'])
  const baseCommitOid = await git(cwd, ['rev-parse', 'HEAD^{commit}'])
  const baseTreeOid = await git(cwd, ['rev-parse', 'HEAD^{tree}'])
  await NodeFSP.writeFile(NodePath.join(cwd, 'source.ts'), 'export const value = 2\n')
  await NodeFSP.writeFile(NodePath.join(cwd, 'tsconfig.app.json'), '{"compilerOptions":{}}\n')
  await git(cwd, ['add', '.'])
  await git(cwd, ['commit', '-m', 'head'])
  return {
    cwd,
    baseCommitOid,
    headCommitOid: await git(cwd, ['rev-parse', 'HEAD^{commit}']),
    baseTreeOid,
    headTreeOid: await git(cwd, ['rev-parse', 'HEAD^{tree}']),
  }
}

function makeAnalyzer(callCount: {
  value: number
}): CartographerAnalyzer.CartographerAnalyzerShape
{
  return CartographerAnalyzer.CartographerAnalyzer.of({
    identify: Effect.succeed({ cliPath: '/test/cartographer', fingerprint: 'analyzer-test-v1' }),
    prepareCurrentWorktree: () => Effect.die('unexpected prepareCurrentWorktree'),
    buildProjectAtlas: () => Effect.die('unexpected buildProjectAtlas'),
    analyzeTrees: (input) =>
      Effect.promise(async () =>
      {
        callCount.value += 1
        await Promise.all([
          NodeFSP.writeFile(
            NodePath.join(input.outDir, 'base.graph.json'),
            JSON.stringify({ repoRoot: '.', gitRef: input.baseRef }),
          ),
          NodeFSP.writeFile(
            NodePath.join(input.outDir, 'proposed.graph.json'),
            JSON.stringify({ repoRoot: '.', gitRef: input.proposedRef }),
          ),
          NodeFSP.writeFile(
            NodePath.join(input.outDir, 'impact.json'),
            JSON.stringify({
              baseGeneratedAt: fixedTimestamp,
              headGeneratedAt: fixedTimestamp,
              baseGitRef: input.baseRef,
              headGitRef: input.proposedRef,
              addedNodes: ['source.ts'],
              removedNodes: [],
              addedEdges: [],
              removedEdges: [],
              movedNodes: [],
              moveFlows: [],
              movedEdges: 0,
              apiChanges: [],
              newViolations: [],
              resolvedViolations: [],
              changed: true,
            }),
          ),
        ])
        return {
          fingerprint: 'analyzer-test-v1',
          process: {
            stdout: `${JSON.stringify({
              type: 'cartographer.analysis-ready',
              version: 1,
              analyzerVersion: 'analyzer-test-v1',
              baseGraph: 'base.graph.json',
              proposedGraph: 'proposed.graph.json',
              impact: 'impact.json',
            })}\n`,
            stderr: '',
            code: 0 as never,
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
          },
        }
      }),
  })
}

function makeTestLayer(input: {
  readonly cwd: string
  readonly baseDir: string
  readonly analyzer: CartographerAnalyzer.CartographerAnalyzerShape
  readonly projection?: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape
  readonly wrapRepository?: (
    repository: DiffAnalysisGenerationRepositoryShape,
  ) => DiffAnalysisGenerationRepositoryShape
})
{
  const configLayer = ServerConfig.layerTest(input.cwd, input.baseDir)
  const gitLayer = GitVcsDriver.layer.pipe(
    Layer.provide(configLayer),
    Layer.provideMerge(NodeServices.layer),
  )
  const basePersistenceLayer = DiffAnalysisGenerationRepositoryLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
  )
  const wrapRepository = input.wrapRepository
  const persistenceLayer =
    wrapRepository === undefined
      ? basePersistenceLayer
      : Layer.effect(
          DiffAnalysisGenerationRepository,
          Effect.map(DiffAnalysisGenerationRepository, (repository) =>
            DiffAnalysisGenerationRepository.of(wrapRepository(repository)),
          ),
        ).pipe(Layer.provide(basePersistenceLayer))
  const environmentLayer = Layer.succeed(
    ServerEnvironment.ServerEnvironment,
    ServerEnvironment.ServerEnvironment.of({
      getEnvironmentId: Effect.succeed(EnvironmentId.make('environment-diff-analysis-test')),
      getDescriptor: Effect.die('unexpected getDescriptor'),
    }),
  )
  const projectionLayer = Layer.succeed(
    ProjectionSnapshotQuery.ProjectionSnapshotQuery,
    input.projection ?? makeProjectionSnapshotQueryStub(),
  )
  return DiffAnalysisService.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(gitLayer),
    Layer.provideMerge(persistenceLayer),
    Layer.provideMerge(environmentLayer),
    Layer.provideMerge(projectionLayer),
    Layer.provideMerge(Layer.succeed(CartographerAnalyzer.CartographerAnalyzer, input.analyzer)),
    Layer.provideMerge(NodeServices.layer),
  )
}

function readyRetentionRow(input: {
  readonly diffAnalysisId: DiffAnalysisId
  readonly cwd: string
  readonly artifactRoot: string
  readonly repositoryKey: string
  readonly cacheSuffix: string
  readonly lastAccessedAt: string
  readonly artifactByteLength?: number
}): DiffAnalysisGenerationRecord
{
  const baseTreeOid = 'a'.repeat(40)
  const headTreeOid = 'b'.repeat(40)
  return {
    diffAnalysisId: input.diffAnalysisId,
    environmentId: 'environment-diff-analysis-test',
    repositoryKey: input.repositoryKey,
    baseTreeOid,
    headTreeOid,
    baseAnalyzerRef: `base-ref-${input.cacheSuffix}`,
    headAnalyzerRef: `head-ref-${input.cacheSuffix}`,
    analyzerVersion: 'analyzer-test-v1',
    analysisPolicyVersion: DiffAnalysisService.DIFF_ANALYSIS_POLICY_VERSION,
    configDigest: `config-${input.cacheSuffix}`,
    scopeDigest: `scope-${input.cacheSuffix}`,
    tsconfigDigest: `tsconfig-${input.cacheSuffix}`,
    source: {
      sourceKind: 'tree-pair',
      cwd: input.cwd,
      baseTreeOid,
      headTreeOid,
    },
    state: 'ready',
    artifactRoot: input.artifactRoot,
    headRootPath: null,
    baseGraphPath: null,
    headGraphPath: null,
    impactPath: null,
    artifactByteLength: input.artifactByteLength ?? 0,
    errorCode: null,
    createdAt: fixedTimestamp,
    updatedAt: fixedTimestamp,
    lastAccessedAt: input.lastAccessedAt,
  }
}

const waitForTerminal = Effect.fn('DiffAnalysisService.test.waitForTerminal')(function* (
  service: DiffAnalysisService.DiffAnalysisServiceShape,
  target: DiffAnalysisService.DiffAnalysisTargetInput,
)
{
  for (let attempt = 0; attempt < 200; attempt += 1)
  {
    const generation = yield* service.get(target)
    if (
      generation.state === 'ready' ||
      generation.state === 'failed' ||
      generation.state === 'cancelled' ||
      generation.state === 'abandoned'
    )
    {
      return generation
    }
    yield* Effect.promise(() => NodeTimersPromises.setTimeout(5))
  }
  return yield* Effect.die('diff analysis did not reach a terminal state')
})

it.effect('single-flights a tree pair and retains both verified immutable roots', () =>
  Effect.scoped(
    Effect.gen(function* ()
    {
      yield* TestClock.setTime(fixedEpoch)
      const [fixture, otherRepository] = yield* Effect.promise(() =>
        Promise.all([initializeRepository(), initializeRepository()]),
      )
      const baseDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), '456code-diff-analysis-state-')),
      )
      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          Promise.all([
            NodeFSP.rm(fixture.cwd, { recursive: true, force: true }),
            NodeFSP.rm(otherRepository.cwd, { recursive: true, force: true }),
            NodeFSP.rm(baseDir, { recursive: true, force: true }),
          ]),
        ).pipe(Effect.ignore),
      )
      const analyzerCalls = { value: 0 }
      const source: DiffAnalysisSource = {
        sourceKind: 'tree-pair',
        cwd: fixture.cwd,
        baseTreeOid: fixture.baseTreeOid,
        headTreeOid: fixture.headTreeOid,
      }

      yield* Effect.gen(function* ()
      {
        const service = yield* DiffAnalysisService.DiffAnalysisService
        const repository = yield* DiffAnalysisGenerationRepository
        const first = yield* service.request({ source, workspaceRoot: fixture.cwd })
        const second = yield* service.request({ source, workspaceRoot: fixture.cwd })
        assert.equal(second.diffAnalysisId, first.diffAnalysisId)
        assert.equal(second.lastAccessedAt, '2026-08-07T12:00:00.001Z')
        const ready = yield* waitForTerminal(service, { source, workspaceRoot: fixture.cwd })
        assert.equal(ready.state, 'ready')
        assert.equal(ready.sourceCurrent, true)
        assert.equal(analyzerCalls.value, 1)
        assert.equal(
          Option.getOrThrow(yield* repository.getById({ diffAnalysisId: first.diffAnalysisId }))
            .lastAccessedAt,
          ready.lastAccessedAt,
        )
        const ownerMismatch = yield* service
          .request({ source, workspaceRoot: otherRepository.cwd })
          .pipe(Effect.flip)
        assert.equal(ownerMismatch.code, 'repository-out-of-scope')

        yield* TestClock.setTime(fixedEpoch + 1_000)
        const inspected = yield* service.getById({
          workspaceRoot: fixture.cwd,
          diffAnalysisId: first.diffAnalysisId,
        })
        assert.equal(inspected.state, 'ready')
        assert.equal(inspected.sourceCurrent, true)
        assert.equal(inspected.lastAccessedAt, '2026-08-07T12:00:01.000Z')
        const maskedOwner = yield* service
          .getById({
            workspaceRoot: otherRepository.cwd,
            diffAnalysisId: first.diffAnalysisId,
          })
          .pipe(Effect.flip)
        assert.equal(maskedOwner.code, 'invalid-source')
        const missing = yield* service
          .getById({
            workspaceRoot: fixture.cwd,
            diffAnalysisId: DiffAnalysisId.make('diff-analysis-missing'),
          })
          .pipe(Effect.flip)
        assert.equal(missing.code, 'invalid-source')

        const target = yield* Effect.scoped(
          service.retainReadyTarget({
            diffAnalysisId: first.diffAnalysisId,
            workspaceRoot: fixture.cwd,
          }),
        )
        assert.equal(target.generation.lastAccessedAt, '2026-08-07T12:00:01.001Z')
        assert.equal(
          Option.getOrThrow(yield* repository.getById({ diffAnalysisId: first.diffAnalysisId }))
            .lastAccessedAt,
          target.generation.lastAccessedAt,
        )
        assert.isTrue(yield* Effect.promise(() => pathExists(target.headRoot)))
        assert.isTrue(
          yield* Effect.promise(() =>
            pathExists(NodePath.join(NodePath.dirname(target.headRoot), 'base')),
          ),
        )
        assert.match(
          NodePath.basename(target.baseGraphPath),
          /^base\.graph\.[0-9a-f]{64}\.[0-9a-f]{64}\.json$/u,
        )
        assert.match(
          NodePath.basename(target.headGraphPath),
          /^head\.graph\.[0-9a-f]{64}\.[0-9a-f]{64}\.json$/u,
        )
        const nativeImpact = yield* Effect.scoped(
          service.retainReadyImpactTarget({
            diffAnalysisId: first.diffAnalysisId,
            workspaceRoot: fixture.cwd,
          }),
        )
        assert.equal(nativeImpact.legacy, false)
        assert.equal(nativeImpact.diff?.changed, true)
        assert.equal(
          nativeImpact.baseRoot,
          NodePath.join(NodePath.dirname(target.headRoot), 'base'),
        )
        assert.equal(nativeImpact.headRoot, target.headRoot)

        const originalBaseGraphBytes = yield* Effect.promise(() =>
          NodeFSP.readFile(target.baseGraphPath),
        )
        yield* Effect.promise(() => NodeFSP.writeFile(target.baseGraphPath, '{"tampered":true}'))
        assert.equal(
          (yield* Effect.scoped(
            service.retainReadyImpactTarget({
              diffAnalysisId: first.diffAnalysisId,
              workspaceRoot: fixture.cwd,
            }),
          )).diff?.changed,
          true,
        )
        yield* Effect.promise(() => NodeFSP.writeFile(target.baseGraphPath, originalBaseGraphBytes))

        const originalImpactBytes = yield* Effect.promise(() => NodeFSP.readFile(target.impactPath))
        yield* Effect.promise(() => NodeFSP.writeFile(target.impactPath, '{"changed":true}'))
        const corruptImpact = yield* Effect.scoped(
          service.retainReadyImpactTarget({
            diffAnalysisId: first.diffAnalysisId,
            workspaceRoot: fixture.cwd,
          }),
        ).pipe(Effect.flip)
        assert.equal(corruptImpact.code, 'artifact-invalid')
        yield* Effect.promise(() => NodeFSP.writeFile(target.impactPath, originalImpactBytes))
      }).pipe(
        Effect.provide(
          makeTestLayer({
            cwd: fixture.cwd,
            baseDir,
            analyzer: makeAnalyzer(analyzerCalls),
          }),
        ),
      )
    }),
  ),
)

it.effect('analyzes an immutable commit pair without reading the mutable worktree HEAD', () =>
  Effect.scoped(
    Effect.gen(function* ()
    {
      yield* TestClock.setTime(fixedEpoch)
      const fixture = yield* Effect.promise(initializeRepository)
      const baseDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), '456code-diff-analysis-state-')),
      )
      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          Promise.all([
            NodeFSP.rm(fixture.cwd, { recursive: true, force: true }),
            NodeFSP.rm(baseDir, { recursive: true, force: true }),
          ]),
        ).pipe(Effect.ignore),
      )
      const source: DiffAnalysisSource = {
        sourceKind: 'commit-pair',
        cwd: fixture.cwd,
        baseCommitOid: fixture.baseCommitOid,
        headCommitOid: fixture.headCommitOid,
      }
      const analyzerCalls = { value: 0 }

      yield* Effect.gen(function* ()
      {
        const service = yield* DiffAnalysisService.DiffAnalysisService
        const requested = yield* service.request({ source, workspaceRoot: fixture.cwd })
        const ready = yield* waitForTerminal(service, { source, workspaceRoot: fixture.cwd })

        assert.equal(requested.sourceKind, 'commit-pair')
        assert.equal(ready.state, 'ready')
        assert.equal(ready.baseTreeOid, fixture.baseTreeOid)
        assert.equal(ready.headTreeOid, fixture.headTreeOid)
        assert.equal(analyzerCalls.value, 1)
      }).pipe(
        Effect.provide(
          makeTestLayer({
            cwd: fixture.cwd,
            baseDir,
            analyzer: makeAnalyzer(analyzerCalls),
          }),
        ),
      )
    }),
  ),
)

it.effect('inspects an authorized active diff without source metadata', () =>
  Effect.scoped(
    Effect.gen(function* ()
    {
      yield* TestClock.setTime(fixedEpoch)
      const fixture = yield* Effect.promise(initializeRepository)
      const baseDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), '456code-diff-analysis-state-')),
      )
      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          Promise.all([
            NodeFSP.rm(fixture.cwd, { recursive: true, force: true }),
            NodeFSP.rm(baseDir, { recursive: true, force: true }),
          ]),
        ).pipe(Effect.ignore),
      )
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const analyzer = makeAnalyzer({ value: 0 })
      const gatedAnalyzer = CartographerAnalyzer.CartographerAnalyzer.of({
        ...analyzer,
        analyzeTrees: Effect.fn('TestDiffAnalyzer.analyzeTrees')(function* ()
        {
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(release)
          return yield* new CartographerError({
            failure: 'context_start_failed',
            message: 'deterministic test failure',
          })
        }),
      })
      const source: DiffAnalysisSource = {
        sourceKind: 'tree-pair',
        cwd: fixture.cwd,
        baseTreeOid: fixture.baseTreeOid,
        headTreeOid: fixture.headTreeOid,
      }

      yield* Effect.gen(function* ()
      {
        const service = yield* DiffAnalysisService.DiffAnalysisService
        const requested = yield* service.request({ workspaceRoot: fixture.cwd, source })
        yield* Deferred.await(started)
        const active = yield* service.getById({
          workspaceRoot: fixture.cwd,
          diffAnalysisId: requested.diffAnalysisId,
        })
        assert.equal(active.state, 'analyzing')
        yield* Deferred.succeed(release, undefined)
        const terminal = yield* waitForTerminal(service, { workspaceRoot: fixture.cwd, source })
        assert.equal(terminal.state, 'failed')
        const inspectedTerminal = yield* service.getById({
          workspaceRoot: fixture.cwd,
          diffAnalysisId: requested.diffAnalysisId,
        })
        assert.equal(inspectedTerminal.state, 'failed')
      }).pipe(
        Effect.provide(
          makeTestLayer({
            cwd: fixture.cwd,
            baseDir,
            analyzer: gatedAnalyzer,
          }),
        ),
      )
    }),
  ),
)

it.effect('abandons active diff analyses and removes partial artifacts on startup', () =>
  Effect.scoped(
    Effect.gen(function* ()
    {
      yield* TestClock.setTime(fixedEpoch)
      const fixture = yield* Effect.promise(initializeRepository)
      const baseDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), '456code-diff-analysis-state-')),
      )
      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          Promise.all([
            NodeFSP.rm(fixture.cwd, { recursive: true, force: true }),
            NodeFSP.rm(baseDir, { recursive: true, force: true }),
          ]),
        ).pipe(Effect.ignore),
      )
      const diffAnalysisId = DiffAnalysisId.make('diff-analysis-startup-abandoned')
      const source: DiffAnalysisSource = {
        sourceKind: 'tree-pair',
        cwd: fixture.cwd,
        baseTreeOid: fixture.baseTreeOid,
        headTreeOid: fixture.headTreeOid,
      }

      yield* Effect.gen(function* ()
      {
        const repository = yield* DiffAnalysisGenerationRepository
        const config = yield* ServerConfig.ServerConfig
        const artifactRoot = NodePath.join(
          config.stateDir,
          'cartographer',
          'diff-analyses',
          diffAnalysisId,
        )
        yield* Effect.promise(async () =>
        {
          await NodeFSP.mkdir(artifactRoot, { recursive: true })
          await NodeFSP.writeFile(NodePath.join(artifactRoot, 'partial.json'), '{}')
        })
        yield* repository.admit({
          diffAnalysisId,
          environmentId: 'environment-diff-analysis-test',
          repositoryKey: 'local-git:startup-abandonment',
          baseTreeOid: fixture.baseTreeOid,
          headTreeOid: fixture.headTreeOid,
          baseAnalyzerRef: fixture.baseTreeOid,
          headAnalyzerRef: fixture.headTreeOid,
          analyzerVersion: 'analyzer-test-v1',
          analysisPolicyVersion: DiffAnalysisService.DIFF_ANALYSIS_POLICY_VERSION,
          configDigest: 'config-digest-startup',
          scopeDigest: 'scope-digest-startup',
          tsconfigDigest: 'tsconfig-digest-startup',
          source,
          state: 'analyzing',
          artifactRoot,
          headRootPath: null,
          baseGraphPath: null,
          headGraphPath: null,
          impactPath: null,
          artifactByteLength: 0,
          errorCode: null,
          createdAt: fixedTimestamp,
          updatedAt: fixedTimestamp,
          lastAccessedAt: fixedTimestamp,
        })

        yield* DiffAnalysisService.make

        const recovered = yield* repository.getById({ diffAnalysisId })
        assert.isTrue(Option.isSome(recovered))
        if (Option.isNone(recovered)) return yield* Effect.die('startup row was not retained')
        assert.equal(recovered.value.state, 'abandoned')
        assert.equal(recovered.value.errorCode, 'server-restarted')
        assert.equal(recovered.value.updatedAt, '2026-08-07T12:00:00.001Z')
        assert.isFalse(yield* Effect.promise(() => pathExists(artifactRoot)))
      }).pipe(
        Effect.provide(
          makeTestLayer({
            cwd: fixture.cwd,
            baseDir,
            analyzer: makeAnalyzer({ value: 0 }),
          }),
        ),
      )
    }),
  ),
)

it.effect('abandons an in-flight diff analysis when its service scope closes', () =>
  Effect.scoped(
    Effect.gen(function* ()
    {
      yield* TestClock.setTime(fixedEpoch)
      const fixture = yield* Effect.promise(initializeRepository)
      const baseDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), '456code-diff-analysis-state-')),
      )
      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          Promise.all([
            NodeFSP.rm(fixture.cwd, { recursive: true, force: true }),
            NodeFSP.rm(baseDir, { recursive: true, force: true }),
          ]),
        ).pipe(Effect.ignore),
      )
      const analyzerStarted = yield* Deferred.make<void>()
      const analyzer = makeAnalyzer({ value: 0 })
      const gatedAnalyzer = CartographerAnalyzer.CartographerAnalyzer.of({
        ...analyzer,
        analyzeTrees: () =>
          Deferred.succeed(analyzerStarted, undefined).pipe(Effect.andThen(Effect.never)),
      })
      const source: DiffAnalysisSource = {
        sourceKind: 'tree-pair',
        cwd: fixture.cwd,
        baseTreeOid: fixture.baseTreeOid,
        headTreeOid: fixture.headTreeOid,
      }

      yield* Effect.gen(function* ()
      {
        const repository = yield* DiffAnalysisGenerationRepository
        const serviceScope = yield* Scope.make('sequential')
        yield* Effect.addFinalizer(() => Scope.close(serviceScope, Exit.void))
        const service = yield* DiffAnalysisService.make.pipe(
          Effect.provideService(Scope.Scope, serviceScope),
        )
        const requested = yield* service.request({ workspaceRoot: fixture.cwd, source })
        yield* Deferred.await(analyzerStarted)

        yield* Scope.close(serviceScope, Exit.void)

        const result = yield* repository.getById({ diffAnalysisId: requested.diffAnalysisId })
        assert.isTrue(Option.isSome(result))
        if (Option.isNone(result)) return yield* Effect.die('shutdown row was not retained')
        assert.equal(result.value.state, 'abandoned')
        assert.equal(result.value.errorCode, 'server-restarted')
        assert.isFalse(yield* Effect.promise(() => pathExists(result.value.artifactRoot)))

        const rejected = yield* service
          .request({ workspaceRoot: fixture.cwd, source })
          .pipe(Effect.flip)
        assert.equal(rejected.code, 'server-restarted')
        const unchanged = yield* repository.getById({ diffAnalysisId: requested.diffAnalysisId })
        assert.isTrue(Option.isSome(unchanged))
        if (Option.isNone(unchanged)) return yield* Effect.die('shutdown row disappeared')
        assert.equal(unchanged.value.state, 'abandoned')
        assert.equal(unchanged.value.errorCode, 'server-restarted')
      }).pipe(
        Effect.provide(
          makeTestLayer({
            cwd: fixture.cwd,
            baseDir,
            analyzer: gatedAnalyzer,
          }),
        ),
      )
    }),
  ),
)

it.effect('surfaces stale working-tree generations and opens them against the live root', () =>
  Effect.scoped(
    Effect.gen(function* ()
    {
      yield* TestClock.setTime(fixedEpoch)
      const fixture = yield* Effect.promise(initializeRepository)
      const baseDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), '456code-diff-analysis-state-')),
      )
      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          Promise.all([
            NodeFSP.rm(fixture.cwd, { recursive: true, force: true }),
            NodeFSP.rm(baseDir, { recursive: true, force: true }),
          ]),
        ).pipe(Effect.ignore),
      )
      const source: DiffAnalysisSource = {
        sourceKind: 'review',
        cwd: fixture.cwd,
        kind: 'working-tree',
      }

      yield* Effect.gen(function* ()
      {
        const service = yield* DiffAnalysisService.DiffAnalysisService
        const requested = yield* service.request({ source, workspaceRoot: fixture.cwd })
        const ready = yield* waitForTerminal(service, {
          source,
          workspaceRoot: fixture.cwd,
          diffAnalysisId: requested.diffAnalysisId,
        })
        assert.equal(ready.state, 'ready')

        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(fixture.cwd, 'source.ts'), 'export const value = 3\n'),
        )
        const stale = yield* service.get({
          source,
          workspaceRoot: fixture.cwd,
          diffAnalysisId: requested.diffAnalysisId,
        })
        assert.equal(stale.sourceCurrent, false)

        const target = yield* Effect.scoped(
          service.retainReadyTarget({
            diffAnalysisId: requested.diffAnalysisId,
            workspaceRoot: fixture.cwd,
          }),
        )
        assert.equal(target.headRoot, yield* Effect.promise(() => NodeFSP.realpath(fixture.cwd)))
      }).pipe(
        Effect.provide(
          makeTestLayer({
            cwd: fixture.cwd,
            baseDir,
            analyzer: makeAnalyzer({ value: 0 }),
          }),
        ),
      )
    }),
  ),
)

it.effect('retains exact working-tree source sides after aggressive Git pruning', () =>
  Effect.scoped(
    Effect.gen(function* ()
    {
      yield* TestClock.setTime(fixedEpoch)
      const fixture = yield* Effect.promise(initializeRepository)
      const baseDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), '456code-diff-analysis-state-')),
      )
      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          Promise.all([
            NodeFSP.rm(fixture.cwd, { recursive: true, force: true }),
            NodeFSP.rm(baseDir, { recursive: true, force: true }),
          ]),
        ).pipe(Effect.ignore),
      )
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(fixture.cwd, 'source.ts'), 'export const value = 3\n'),
      )
      const source: DiffAnalysisSource = {
        sourceKind: 'review',
        cwd: fixture.cwd,
        kind: 'working-tree',
      }

      yield* Effect.gen(function* ()
      {
        const service = yield* DiffAnalysisService.DiffAnalysisService
        const requested = yield* service.request({ source, workspaceRoot: fixture.cwd })
        const ready = yield* waitForTerminal(service, {
          source,
          workspaceRoot: fixture.cwd,
          diffAnalysisId: requested.diffAnalysisId,
        })
        assert.equal(ready.state, 'ready')
        assert.notEqual(ready.headTreeOid, fixture.headTreeOid)

        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(fixture.cwd, 'source.ts'), 'export const value = 4\n'),
        )
        yield* Effect.promise(() => git(fixture.cwd, ['reflog', 'expire', '--expire=now', '--all']))
        yield* Effect.promise(() => git(fixture.cwd, ['gc', '--prune=now', '--aggressive']))
        assert.isFalse(yield* Effect.promise(() => gitObjectExists(fixture.cwd, ready.headTreeOid)))

        const retained = yield* Effect.scoped(
          Effect.gen(function* ()
          {
            const base = yield* service.retainReadyImpactTarget({
              diffAnalysisId: requested.diffAnalysisId,
              workspaceRoot: fixture.cwd,
              sourceSide: 'base',
            })
            const head = yield* service.retainReadyImpactTarget({
              diffAnalysisId: requested.diffAnalysisId,
              workspaceRoot: fixture.cwd,
              sourceSide: 'head',
            })
            if (base.baseRoot === null)
            {
              return yield* Effect.die('generated analysis did not retain its base source root')
            }
            const baseRoot = base.baseRoot
            return yield* Effect.promise(() =>
              Promise.all([
                NodeFSP.readFile(NodePath.join(baseRoot, 'source.ts'), 'utf8'),
                NodeFSP.readFile(NodePath.join(head.headRoot, 'source.ts'), 'utf8'),
              ]),
            )
          }),
        )
        assert.deepStrictEqual(retained, ['export const value = 2\n', 'export const value = 3\n'])
      }).pipe(
        Effect.provide(
          makeTestLayer({
            cwd: fixture.cwd,
            baseDir,
            analyzer: makeAnalyzer({ value: 0 }),
          }),
        ),
      )
    }),
  ),
)

it.effect('returns checkpoint-ref-missing when a deleted checkpoint ref cannot resolve', () =>
  Effect.scoped(
    Effect.gen(function* ()
    {
      yield* TestClock.setTime(fixedEpoch)
      const fixture = yield* Effect.promise(initializeRepository)
      const baseDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), '456code-diff-analysis-state-')),
      )
      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          Promise.all([
            NodeFSP.rm(fixture.cwd, { recursive: true, force: true }),
            NodeFSP.rm(baseDir, { recursive: true, force: true }),
          ]),
        ).pipe(Effect.ignore),
      )
      const threadId = ThreadId.make('thread-missing-checkpoint-ref')
      const projection = makeProjectionSnapshotQueryStub({
        getThreadCheckpointContext: () =>
          Effect.succeed(
            Option.some({
              threadId,
              projectId: ProjectId.make('project-missing-checkpoint-ref'),
              workspaceRoot: fixture.cwd,
              worktreePath: null,
              checkpoints: [],
            }),
          ),
      })

      const error = yield* Effect.gen(function* ()
      {
        const service = yield* DiffAnalysisService.DiffAnalysisService
        return yield* service
          .request({
            workspaceRoot: fixture.cwd,
            source: {
              sourceKind: 'checkpoint',
              threadId,
              fromTurnCount: 0,
              toTurnCount: 1,
            },
          })
          .pipe(Effect.flip)
      }).pipe(
        Effect.provide(
          makeTestLayer({
            cwd: fixture.cwd,
            baseDir,
            analyzer: makeAnalyzer({ value: 0 }),
            projection,
          }),
        ),
      )
      assert.equal(error.code, 'checkpoint-ref-missing')
    }),
  ),
)

it.effect('skips a touched LRU candidate and evicts the next unchanged row', () =>
  Effect.scoped(
    Effect.gen(function* ()
    {
      yield* TestClock.setTime(fixedEpoch)
      const fixture = yield* Effect.promise(initializeRepository)
      const baseDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), '456code-diff-analysis-state-')),
      )
      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          Promise.all([
            NodeFSP.rm(fixture.cwd, { recursive: true, force: true }),
            NodeFSP.rm(baseDir, { recursive: true, force: true }),
          ]),
        ).pipe(Effect.ignore),
      )
      const analysesRoot = NodePath.join(baseDir, 'userdata', 'cartographer', 'diff-analyses')
      const touchedId = DiffAnalysisId.make('00000000-0000-4000-8000-000000000001')
      const nextId = DiffAnalysisId.make('00000000-0000-4000-8000-000000000002')
      const touchedRoot = NodePath.join(analysesRoot, touchedId)
      const nextRoot = NodePath.join(analysesRoot, nextId)
      const touchedRow = readyRetentionRow({
        diffAnalysisId: touchedId,
        cwd: fixture.cwd,
        artifactRoot: touchedRoot,
        repositoryKey: 'repository-retention-race',
        cacheSuffix: 'touched',
        lastAccessedAt: fixedTimestamp,
        artifactByteLength: 400 * 1024 * 1024,
      })
      const nextRow = readyRetentionRow({
        diffAnalysisId: nextId,
        cwd: fixture.cwd,
        artifactRoot: nextRoot,
        repositoryKey: 'repository-retention-race',
        cacheSuffix: 'next',
        lastAccessedAt: '2026-08-07T12:00:00.500Z',
        artifactByteLength: 400 * 1024 * 1024,
      })
      const lruListed = yield* Deferred.make<ReadonlyArray<DiffAnalysisGenerationRecord>>()
      const releaseEviction = yield* Deferred.make<void>()
      const deletedRow = yield* Deferred.make<DiffAnalysisId>()
      const retentionFinished = yield* Deferred.make<void>()
      let seeded = false
      let globalListCount = 0
      let lruPaused = false
      const wrapRepository = (
        repository: DiffAnalysisGenerationRepositoryShape,
      ): DiffAnalysisGenerationRepositoryShape =>
        DiffAnalysisGenerationRepository.of({
          ...repository,
          listReadyGlobalLru: () =>
            Effect.gen(function* ()
            {
              if (!seeded)
              {
                seeded = true
                yield* Effect.promise(() =>
                  Promise.all([
                    NodeFSP.mkdir(NodePath.join(touchedRoot, 'base'), { recursive: true }),
                    NodeFSP.mkdir(NodePath.join(touchedRoot, 'head'), { recursive: true }),
                    NodeFSP.mkdir(NodePath.join(nextRoot, 'base'), { recursive: true }),
                    NodeFSP.mkdir(NodePath.join(nextRoot, 'head'), { recursive: true }),
                  ]),
                )
                yield* repository.admit(touchedRow)
                yield* repository.admit(nextRow)
              }
              const rows = yield* repository.listReadyGlobalLru()
              globalListCount += 1
              if (globalListCount === 2)
              {
                yield* Deferred.succeed(retentionFinished, undefined)
              }
              return rows
            }),
          listReadyByRepositoryLru: (input) =>
            repository.listReadyByRepositoryLru(input).pipe(
              Effect.tap((rows) =>
              {
                if (lruPaused || rows.length < 2) return Effect.void
                lruPaused = true
                return Deferred.succeed(lruListed, rows).pipe(
                  Effect.andThen(Deferred.await(releaseEviction)),
                )
              }),
            ),
          deleteIfUnchanged: (input) =>
            repository
              .deleteIfUnchanged(input)
              .pipe(
                Effect.tap((deleted) =>
                  deleted ? Deferred.succeed(deletedRow, input.diffAnalysisId) : Effect.void,
                ),
              ),
        })

      yield* Effect.gen(function* ()
      {
        yield* DiffAnalysisService.DiffAnalysisService
        const repository = yield* DiffAnalysisGenerationRepository
        const listed = yield* Deferred.await(lruListed)
        assert.deepStrictEqual(
          listed.map((row) => row.diffAnalysisId),
          [touchedId, nextId],
        )
        const touchedAt = yield* repository.touch({
          diffAnalysisId: touchedId,
          lastAccessedAt: '2026-08-07T12:01:00.000Z',
        })
        assert.equal(touchedAt, '2026-08-07T12:01:00.000Z')
        yield* Deferred.succeed(releaseEviction, undefined)
        assert.equal(yield* Deferred.await(deletedRow), nextId)
        yield* Deferred.await(retentionFinished)

        const retained = yield* repository.getById({ diffAnalysisId: touchedId })
        assert.isTrue(Option.isSome(retained))
        assert.equal(Option.getOrThrow(retained).lastAccessedAt, touchedAt)
        assert.isTrue(Option.isNone(yield* repository.getById({ diffAnalysisId: nextId })))
        assert.isTrue(yield* Effect.promise(() => pathExists(touchedRoot)))
        assert.isFalse(yield* Effect.promise(() => pathExists(nextRoot)))
      }).pipe(
        Effect.provide(
          makeTestLayer({
            cwd: fixture.cwd,
            baseDir,
            analyzer: makeAnalyzer({ value: 0 }),
            wrapRepository,
          }),
        ),
      )
    }),
  ),
)

it.effect('retries an orphan cleanup failure without deleting live or recent roots', () =>
  Effect.scoped(
    Effect.gen(function* ()
    {
      const stateRoot = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), '456code-diff-orphan-sweep-')),
      )
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => NodeFSP.rm(stateRoot, { recursive: true, force: true })).pipe(
          Effect.ignore,
        ),
      )
      const analysesRoot = NodePath.join(stateRoot, 'cartographer', 'diff-analyses')
      const orphanId = DiffAnalysisId.make('00000000-0000-4000-8000-000000000011')
      const liveId = DiffAnalysisId.make('00000000-0000-4000-8000-000000000012')
      const recentId = DiffAnalysisId.make('00000000-0000-4000-8000-000000000013')
      const orphanRoot = NodePath.join(analysesRoot, orphanId)
      const liveRoot = NodePath.join(analysesRoot, liveId)
      const recentRoot = NodePath.join(analysesRoot, recentId)
      yield* Effect.promise(async () =>
      {
        await Promise.all(
          [orphanRoot, liveRoot, recentRoot].flatMap((root) => [
            NodeFSP.mkdir(NodePath.join(root, 'base'), { recursive: true }),
            NodeFSP.mkdir(NodePath.join(root, 'head'), { recursive: true }),
          ]),
        )
        const agedAt =
          (fixedEpoch - DiffAnalysisService.DIFF_ANALYSIS_ORPHAN_SWEEP_GRACE_MS - 1_000) / 1_000
        const recentAt =
          (fixedEpoch - DiffAnalysisService.DIFF_ANALYSIS_ORPHAN_SWEEP_GRACE_MS + 1_000) / 1_000
        await Promise.all([
          NodeFSP.utimes(orphanRoot, agedAt, agedAt),
          NodeFSP.utimes(liveRoot, agedAt, agedAt),
          NodeFSP.utimes(recentRoot, recentAt, recentAt),
        ])
      })

      const persistenceLayer = DiffAnalysisGenerationRepositoryLive.pipe(
        Layer.provideMerge(SqlitePersistenceMemory),
      )
      yield* Effect.gen(function* ()
      {
        const repository = yield* DiffAnalysisGenerationRepository
        const orphanRow = readyRetentionRow({
          diffAnalysisId: orphanId,
          cwd: stateRoot,
          artifactRoot: orphanRoot,
          repositoryKey: 'repository-orphan-retry',
          cacheSuffix: 'orphan',
          lastAccessedAt: fixedTimestamp,
        })
        const liveRow = readyRetentionRow({
          diffAnalysisId: liveId,
          cwd: stateRoot,
          artifactRoot: liveRoot,
          repositoryKey: 'repository-orphan-retry',
          cacheSuffix: 'live',
          lastAccessedAt: fixedTimestamp,
        })
        yield* repository.admit(orphanRow)
        yield* repository.admit(liveRow)
        assert.isTrue(
          yield* repository.deleteIfUnchanged({
            diffAnalysisId: orphanId,
            state: orphanRow.state,
            updatedAt: orphanRow.updatedAt,
            lastAccessedAt: orphanRow.lastAccessedAt,
          }),
        )
        const protectedIds = new Set<string>(yield* repository.listAllIds())

        const failed = yield* Effect.promise(() =>
          DiffAnalysisService.reconcileOrphanedDiffAnalysisRoots(analysesRoot, {
            protectedIds,
            now: () => fixedEpoch,
            removeRoot: async (artifactRoot) =>
            {
              if (artifactRoot === orphanRoot)
              {
                throw new Error('injected orphan cleanup failure')
              }
              await NodeFSP.rm(artifactRoot, { recursive: true, force: true })
            },
          }),
        )
        assert.equal(failed.removed, 0)
        assert.deepStrictEqual(
          failed.failures.map((failure) => failure.artifactRoot),
          [orphanRoot],
        )
        assert.isTrue(yield* Effect.promise(() => pathExists(orphanRoot)))

        const retried = yield* Effect.promise(() =>
          DiffAnalysisService.reconcileOrphanedDiffAnalysisRoots(analysesRoot, {
            protectedIds,
            now: () => fixedEpoch,
          }),
        )
        assert.equal(retried.removed, 1)
        assert.deepStrictEqual(retried.failures, [])
        assert.isFalse(yield* Effect.promise(() => pathExists(orphanRoot)))
        assert.isTrue(yield* Effect.promise(() => pathExists(liveRoot)))
        assert.isTrue(yield* Effect.promise(() => pathExists(recentRoot)))
      }).pipe(Effect.provide(persistenceLayer))
    }),
  ),
)

async function pathExists(path: string): Promise<boolean>
{
  return NodeFSP.access(path).then(
    () => true,
    () => false,
  )
}
