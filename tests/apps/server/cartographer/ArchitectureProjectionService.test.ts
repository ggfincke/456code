// tests/apps/server/cartographer/ArchitectureProjectionService.test.ts
// verifies authorized sealed projections, exact paging, neighborhoods, and immutable source sides

// @effect-diagnostics nodeBuiltinImport:off

import * as NodeChildProcess from 'node:child_process'
import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeUtil from 'node:util'

import type { AtlasIndex } from '@t3tools/cartographer-core/server'
import {
  ARCHITECTURE_SOURCE_MAX_BYTES,
  DiffAnalysisId,
  EnvironmentId,
  ProjectId,
  ProposalGenerationId,
  ProviderInstanceId,
  ThreadId,
  type ArchitectureStandingSource,
  type OrchestrationProjectShell,
  type OrchestrationThread,
} from '@t3tools/contracts'
import { it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import { afterEach, describe, expect } from 'vite-plus/test'

import * as ArchitectureProjectionService from '../../../../apps/server/src/cartographer/ArchitectureProjectionService.ts'
import * as ArchitectureQueryService from '../../../../apps/server/src/cartographer/ArchitectureQueryService.ts'
import * as AtlasRebuildService from '../../../../apps/server/src/cartographer/AtlasRebuildService.ts'
import * as DiffAnalysisService from '../../../../apps/server/src/cartographer/DiffAnalysisService.ts'
import * as ProjectAtlasStatusBroadcaster from '../../../../apps/server/src/cartographer/ProjectAtlasStatusBroadcaster.ts'
import * as ServerEnvironment from '../../../../apps/server/src/environment/ServerEnvironment.ts'
import * as ProjectionSnapshotQuery from '../../../../apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts'
import * as ProposalGenerationService from '../../../../apps/server/src/proposal/ProposalGenerationService.ts'
import { makeProjectionSnapshotQueryStub } from '../projectionSnapshotQueryTestHelpers.ts'

const execFile = NodeUtil.promisify(NodeChildProcess.execFile)
const environmentId = EnvironmentId.make('environment-architecture-projection')
const projectId = ProjectId.make('project-architecture-projection')
const threadId = ThreadId.make('thread-architecture-projection')
const createdAt = '2026-08-07T12:00:00.000Z'
const generation = '9'.repeat(64)
const graphDigest = `sha256:${'a'.repeat(64)}` as const
const temporaryRoots = new Set<string>()
const literalSourceFixtures = [
  { relativePath: 'src/ spaced.ts ', content: 'export const spaced = true\n' },
  { relativePath: 'src/*.ts', content: 'export const wildcard = true\n' },
  { relativePath: 'src/[literal].ts', content: 'export const bracket = true\n' },
  { relativePath: 'src/tab\tname.ts', content: 'export const tabbed = true\n' },
  { relativePath: 'src/newline\nname.ts', content: 'export const newline = true\n' },
  { relativePath: ':(literal).ts', content: 'export const pathspecMagic = false\n' },
] as const

const authority: ArchitectureQueryService.ArchitectureQueryAuthority = {
  environmentId,
  threadId,
}

async function makeTemporaryRoot(prefix: string): Promise<string>
{
  const created = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix))
  const root = await NodeFSP.realpath(created)
  temporaryRoots.add(root)
  return root
}

async function git(cwd: string, args: ReadonlyArray<string>): Promise<string>
{
  const result = await execFile('git', args, { cwd })
  return result.stdout.trim()
}

async function initializeRepository(): Promise<{
  readonly root: string
  readonly baseTreeOid: string
  readonly headTreeOid: string
}>
{
  const root = await makeTemporaryRoot('456code-architecture-source-')
  await git(root, ['init', '--quiet'])
  await git(root, ['config', 'user.name', '456code Test'])
  await git(root, ['config', 'user.email', '456code@example.invalid'])
  await NodeFSP.mkdir(NodePath.join(root, 'src'), { recursive: true })
  await NodeFSP.writeFile(NodePath.join(root, 'src', 'value.ts'), 'export const value = 1\n')
  await git(root, ['add', '.'])
  await git(root, ['commit', '--quiet', '-m', 'base'])
  const baseTreeOid = await git(root, ['rev-parse', 'HEAD^{tree}'])
  await NodeFSP.writeFile(NodePath.join(root, 'src', 'value.ts'), 'export const value = 2\n')
  await NodeFSP.writeFile(
    NodePath.join(root, 'src', 'large.txt'),
    'x'.repeat(ARCHITECTURE_SOURCE_MAX_BYTES + 1),
  )
  await Promise.all(
    literalSourceFixtures.map(({ content, relativePath }) =>
      NodeFSP.writeFile(NodePath.join(root, relativePath), content),
    ),
  )
  await git(root, ['add', '.'])
  await git(root, ['commit', '--quiet', '-m', 'head'])
  return {
    root,
    baseTreeOid,
    headTreeOid: await git(root, ['rev-parse', 'HEAD^{tree}']),
  }
}

async function initializeRetainedDiffRoots(): Promise<{
  readonly baseRoot: string
  readonly headRoot: string
}>
{
  const [baseRoot, headRoot] = await Promise.all([
    makeTemporaryRoot('456code-architecture-diff-base-'),
    makeTemporaryRoot('456code-architecture-diff-head-'),
  ])
  await Promise.all([
    NodeFSP.mkdir(NodePath.join(baseRoot, 'src'), { recursive: true }),
    NodeFSP.mkdir(NodePath.join(headRoot, 'src'), { recursive: true }),
  ])
  await Promise.all([
    NodeFSP.writeFile(NodePath.join(baseRoot, 'src', 'value.ts'), 'export const value = 1\n'),
    NodeFSP.writeFile(NodePath.join(headRoot, 'src', 'value.ts'), 'export const value = 2\n'),
    NodeFSP.writeFile(
      NodePath.join(headRoot, 'src', 'large.txt'),
      'x'.repeat(ARCHITECTURE_SOURCE_MAX_BYTES + 1),
    ),
    NodeFSP.symlink('value.ts', NodePath.join(headRoot, 'src', 'value-link.ts')),
  ])
  return { baseRoot, headRoot }
}

function thread(root: string): OrchestrationThread
{
  return {
    id: threadId,
    projectId,
    title: 'Architecture projection thread',
    modelSelection: {
      instanceId: ProviderInstanceId.make('codex'),
      model: 'gpt-5.6',
    },
    runtimeMode: 'full-access',
    interactionMode: 'default',
    branch: null,
    worktreePath: root,
    latestTurn: null,
    pendingHandoff: null,
    providerSwitch: null,
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
    origin: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    orchestratePlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  }
}

function project(root: string): OrchestrationProjectShell
{
  return {
    id: projectId,
    title: 'Architecture projection project',
    workspaceRoot: root,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt,
    updatedAt: createdAt,
  }
}

function unit(input: {
  readonly id: string
  readonly key: string
  readonly level: 'systems' | 'blocks' | 'dirs'
  readonly label: string
  readonly parent?: string
  readonly order: number
})
{
  return {
    ...input,
    fileCount: 1,
    inbound: 0,
    outbound: 0,
    visibilityRank: input.order + 1,
    position: { x: input.order * 240, y: 0 },
  }
}

function index(root: string): AtlasIndex
{
  const system = unit({
    id: 'systems:runtime',
    key: 'runtime',
    level: 'systems',
    label: 'Runtime',
    order: 0,
  })
  const api = unit({
    id: 'blocks:api',
    key: 'api',
    level: 'blocks',
    label: 'API',
    parent: system.id,
    order: 0,
  })
  const store = unit({
    id: 'blocks:store',
    key: 'store',
    level: 'blocks',
    label: 'Store',
    parent: system.id,
    order: 1,
  })
  const directory = unit({
    id: 'dirs:src',
    key: 'src',
    level: 'dirs',
    label: 'src',
    parent: api.id,
    order: 0,
  })
  return {
    version: 5,
    sourceGeneratedAt: createdAt,
    sourceGraphDigest: graphDigest,
    repo: { root, name: 'projection-fixture', scope: '.', mode: 'imports' },
    counts: {
      files: 3,
      imports: 2,
      systems: 1,
      blocks: 3,
      dirs: 1,
      indexedSystems: 1,
      indexedBlocks: 2,
      indexedDirs: 1,
    },
    systemSource: 'authored',
    units: { systems: [system], blocks: [api, store], dirs: [directory] },
    edges: {
      systems: [],
      blocks: [{ from: api.id, to: store.id, weight: 2 }],
      dirs: [],
    },
    edgeCounts: {
      systems: { total: 0, indexed: 0, omitted: 0 },
      blocks: { total: 2, indexed: 1, omitted: 1 },
      dirs: { total: 0, indexed: 0, omitted: 0 },
    },
    scopes: [
      {
        parent: system.id,
        childLevel: 'blocks',
        children: { total: 3, indexed: 2, omitted: 1 },
        edges: { total: 2, indexed: 1, omitted: 1 },
      },
      {
        parent: api.id,
        childLevel: 'dirs',
        children: { total: 1, indexed: 1, omitted: 0 },
        edges: { total: 0, indexed: 0, omitted: 0 },
      },
    ],
    health: {
      cycles: 1,
      orphans: 2,
      violatingImports: 3,
      violatedRules: 1,
      ruleTotal: 4,
    },
    files: [
      {
        id: 'src/api.ts',
        label: 'api.ts',
        system: system.id,
        block: api.id,
        dir: directory.id,
        fanIn: 0,
        fanOut: 1,
        visibilityRank: 1,
      },
      {
        id: 'src/store.ts',
        label: 'store.ts',
        system: system.id,
        block: store.id,
        dir: directory.id,
        fanIn: 1,
        fanOut: 0,
        visibilityRank: 2,
      },
      {
        id: 'src/outside.ts',
        label: 'outside.ts',
        system: system.id,
        fanIn: 0,
        fanOut: 0,
        visibilityRank: 3,
      },
    ],
  }
}

interface DependencyOptions
{
  readonly root: string
  readonly rebuild?: Partial<AtlasRebuildService.AtlasRebuildService['Service']>
  readonly proposals?: Partial<ProposalGenerationService.ProposalGenerationService['Service']>
  readonly diffs?: Partial<DiffAnalysisService.DiffAnalysisService['Service']>
  readonly queries?: Partial<ArchitectureQueryService.ArchitectureQueryService['Service']>
}

function dependencyLayer(options: DependencyOptions)
{
  return Layer.mergeAll(
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(environmentId),
    }),
    Layer.succeed(
      ProjectionSnapshotQuery.ProjectionSnapshotQuery,
      makeProjectionSnapshotQueryStub({
        getThreadDetailById: (requestedThreadId) =>
          Effect.succeed(
            requestedThreadId === threadId ? Option.some(thread(options.root)) : Option.none(),
          ),
        getProjectShellById: (requestedProjectId) =>
          Effect.succeed(
            requestedProjectId === projectId ? Option.some(project(options.root)) : Option.none(),
          ),
      }),
    ),
    Layer.mock(AtlasRebuildService.AtlasRebuildService)({
      retainPublishedIndex: () => Effect.succeed(null),
      ...options.rebuild,
    }),
    Layer.mock(ProjectAtlasStatusBroadcaster.ProjectAtlasStatusBroadcaster)({
      getStatus: () =>
        Effect.succeed({
          state: 'ready',
          source: standingSource(),
          freshness: { builtAt: createdAt, dirty: true },
          lastBuildError: null,
        }),
    }),
    Layer.mock(ProposalGenerationService.ProposalGenerationService)({
      resolveImpactTarget: () => Effect.die('unexpected proposal source resolution'),
      ...options.proposals,
    }),
    Layer.mock(DiffAnalysisService.DiffAnalysisService)({
      retainReadyImpactTarget: () => Effect.die('unexpected diff source resolution'),
      ...options.diffs,
    }),
    Layer.mock(ArchitectureQueryService.ArchitectureQueryService)({
      blastRadius: () => Effect.die('unexpected architecture neighborhood query'),
      ...options.queries,
    }),
  )
}

function standingSource(): ArchitectureStandingSource
{
  return {
    kind: 'standing-project-generation',
    projectId,
    generationId: generation,
    side: 'analyzed',
    graphDigest,
  }
}

afterEach(async () =>
{
  await Promise.all(
    [...temporaryRoots].map((root) =>
      NodeFSP.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 }),
    ),
  )
  temporaryRoots.clear()
})

describe('ArchitectureProjectionService', () =>
{
  it.effect('serves a graph-free map and exact generation-bound scope pages', () =>
    Effect.gen(function* ()
    {
      const root = yield* Effect.promise(() => makeTemporaryRoot('456code-architecture-map-'))
      const atlasIndex = index(root)
      const retainedRequests: Array<{ projectId: ProjectId; generation?: string }> = []
      const resolvedNeighborhoodTargets: unknown[] = []
      const service = yield* ArchitectureProjectionService.make.pipe(
        Effect.provide(
          dependencyLayer({
            root,
            rebuild: {
              retainPublishedIndex: (requestedProjectId, requestedGeneration) =>
                Effect.sync(() =>
                {
                  retainedRequests.push({
                    projectId: requestedProjectId,
                    ...(requestedGeneration === undefined
                      ? {}
                      : { generation: requestedGeneration }),
                  })
                  if (
                    requestedProjectId !== projectId ||
                    (requestedGeneration !== undefined && requestedGeneration !== generation)
                  )
                  {
                    return null
                  }
                  return {
                    projectId,
                    root,
                    outDir: root,
                    graphPath: NodePath.join(root, 'graph.json'),
                    generation,
                    graphDigest,
                    builtAt: createdAt,
                    index: atlasIndex,
                  }
                }),
            },
            queries: {
              blastRadius: (_authority, input, resolvedTarget) =>
                Effect.sync(() =>
                {
                  resolvedNeighborhoodTargets.push(resolvedTarget)
                  return {
                    version: 1,
                    graph: { generatedAt: createdAt },
                    target: input.target,
                    precision: 'file',
                    direction: input.direction ?? 'both',
                    maxDepth: input.maxDepth ?? 4,
                    upstream: { items: [], total: 0, omitted: 0 },
                    downstream: { items: [], total: 0, omitted: 0 },
                    impactedFileCount: 0,
                  }
                }),
            },
          }),
        ),
      )

      const map = yield* service.repositoryMap(authority, { threadId, projectId })
      expect(map).toMatchObject({
        version: 1,
        source: standingSource(),
        dirty: true,
        counts: { files: 3, imports: 2, systems: 1, blocks: 3 },
        health: { cycles: 1, orphans: 2, violatingImports: 3, violatedRules: 1, ruleTotal: 4 },
        level: 'systems',
        unitCount: { total: 1, indexed: 1, returned: 1, omitted: 0 },
        edgeCount: { total: 0, indexed: 0, returned: 0, omitted: 0 },
      })

      const first = yield* service.architectureScope(authority, {
        threadId,
        source: standingSource(),
        scope: { level: 'systems', id: 'systems:runtime' },
        limit: 1,
        fileLimit: 1,
      })
      expect(first).toMatchObject({
        childLevel: 'blocks',
        children: [{ id: 'blocks:api' }],
        childCount: { total: 3, indexed: 2, returned: 1, omitted: 1 },
        edges: [],
        edgeCount: { total: 2, indexed: 1, returned: 0, omitted: 1 },
        files: [{ id: 'src/api.ts' }],
        fileCount: { total: 3, indexed: 3, returned: 1, omitted: 0 },
      })
      expect(first.nextCursor).toBeTypeOf('string')
      expect(first.nextFileCursor).toBeTypeOf('string')
      if (first.nextCursor === undefined || first.nextFileCursor === undefined)
      {
        return yield* Effect.die('scope fixture did not return both paging cursors')
      }

      const second = yield* service.architectureScope(authority, {
        threadId,
        source: standingSource(),
        scope: { level: 'systems', id: 'systems:runtime' },
        cursor: first.nextCursor,
        limit: 1,
        fileCursor: first.nextFileCursor,
        fileLimit: 1,
      })
      expect(second.children).toMatchObject([{ id: 'blocks:store' }])
      expect(second.files).toMatchObject([{ id: 'src/store.ts' }])
      expect(second.nextCursor).toBeUndefined()
      expect(second.nextFileCursor).toBeTypeOf('string')
      if (second.nextFileCursor === undefined)
      {
        return yield* Effect.die('scope fixture did not return the final file cursor')
      }

      const third = yield* service.architectureScope(authority, {
        threadId,
        source: standingSource(),
        scope: { level: 'systems', id: 'systems:runtime' },
        fileCursor: second.nextFileCursor,
        fileLimit: 1,
      })
      expect(third.files).toMatchObject([{ id: 'src/outside.ts' }])
      expect(third.nextFileCursor).toBeUndefined()

      const complete = yield* service.architectureScope(authority, {
        threadId,
        source: standingSource(),
        scope: { level: 'systems', id: 'systems:runtime' },
      })
      expect(complete.edges).toEqual([{ from: 'blocks:api', to: 'blocks:store', weight: 2 }])
      expect(complete.edgeCount).toEqual({
        total: 2,
        indexed: 1,
        returned: 1,
        omitted: 1,
      })

      const blockScope = yield* service.architectureScope(authority, {
        threadId,
        source: standingSource(),
        scope: { level: 'blocks', id: 'blocks:api' },
      })
      expect(blockScope).toMatchObject({
        source: standingSource(),
        scope: { level: 'blocks', id: 'blocks:api' },
        childLevel: 'dirs',
        children: [{ id: 'dirs:src' }],
        childCount: { total: 1, indexed: 1, returned: 1, omitted: 0 },
        edges: [],
        edgeCount: { total: 0, indexed: 0, returned: 0, omitted: 0 },
        files: [{ id: 'src/api.ts' }],
      })

      const directoryFirst = yield* service.architectureScope(authority, {
        threadId,
        source: standingSource(),
        scope: { level: 'dirs', id: 'dirs:src' },
        fileLimit: 1,
      })
      expect(directoryFirst).toMatchObject({
        source: standingSource(),
        scope: { level: 'dirs', id: 'dirs:src' },
        childLevel: 'dirs',
        children: [],
        childCount: { total: 0, indexed: 0, returned: 0, omitted: 0 },
        edges: [],
        edgeCount: { total: 0, indexed: 0, returned: 0, omitted: 0 },
        files: [{ id: 'src/api.ts' }],
        fileCount: { total: 2, indexed: 2, returned: 1, omitted: 0 },
      })
      expect(directoryFirst.nextCursor).toBeUndefined()
      expect(directoryFirst.nextFileCursor).toBeTypeOf('string')
      if (directoryFirst.nextFileCursor === undefined)
      {
        return yield* Effect.die('directory fixture did not return its file cursor')
      }

      const directorySecond = yield* service.architectureScope(authority, {
        threadId,
        source: standingSource(),
        scope: { level: 'dirs', id: 'dirs:src' },
        fileCursor: directoryFirst.nextFileCursor,
        fileLimit: 1,
      })
      expect(directorySecond.files).toEqual([
        expect.objectContaining({ id: 'src/store.ts', dir: 'dirs:src' }),
      ])
      expect(directorySecond.nextFileCursor).toBeUndefined()

      const neighborhood = yield* service.architectureNeighborhood(authority, {
        threadId,
        source: standingSource(),
        target: 'src/api.ts',
        direction: 'both',
        maxDepth: 1,
      })
      expect(neighborhood.target).toBe('src/api.ts')
      expect(resolvedNeighborhoodTargets).toEqual([
        {
          context: {
            root,
            outDir: root,
            graphPath: NodePath.join(root, 'graph.json'),
            liveRoot: root,
          },
          recovery: 'build_project_atlas',
        },
      ])

      const wrongGeneration = yield* service
        .repositoryMap(authority, {
          threadId,
          projectId,
          generationId: '8'.repeat(64),
        })
        .pipe(Effect.flip)
      expect(wrongGeneration).toMatchObject({
        operation: 'architecture_repository_map',
        code: 'context-not-ready',
      })
      const wrongDigest = yield* service
        .architectureScope(authority, {
          threadId,
          source: { ...standingSource(), graphDigest: `sha256:${'b'.repeat(64)}` },
          scope: { level: 'systems', id: 'systems:runtime' },
        })
        .pipe(Effect.flip)
      expect(wrongDigest).toMatchObject({
        operation: 'architecture_scope',
        code: 'identity-mismatch',
      })
      expect(retainedRequests).toHaveLength(11)
    }),
  )

  it.effect('resolves standing path-scope chips from retained atlas files', () =>
    Effect.gen(function* ()
    {
      const root = yield* Effect.promise(() =>
        makeTemporaryRoot('456code-architecture-path-scope-'),
      )
      const atlasIndex = index(root)
      const service = yield* ArchitectureProjectionService.make.pipe(
        Effect.provide(
          dependencyLayer({
            root,
            rebuild: {
              retainPublishedIndex: () =>
                Effect.succeed({
                  projectId,
                  root,
                  outDir: root,
                  graphPath: NodePath.join(root, 'graph.json'),
                  generation,
                  graphDigest,
                  builtAt: createdAt,
                  index: atlasIndex,
                }),
            },
          }),
        ),
      )

      const fileScope = yield* service.architecturePathScope(authority, {
        threadId,
        projectId,
        paths: ['src/api.ts'],
      })
      expect(fileScope).toMatchObject({
        version: 1,
        source: standingSource(),
        chips: [
          {
            role: 'touched',
            level: 'systems',
            id: 'systems:runtime',
            label: 'Runtime',
          },
          { role: 'touched', level: 'blocks', id: 'blocks:api', label: 'API' },
          { role: 'context', level: 'blocks', id: 'blocks:store', label: 'Store' },
        ],
      })

      const directoryScope = yield* service.architecturePathScope(authority, {
        threadId,
        projectId,
        paths: ['src'],
        generationId: generation,
      })
      expect(directoryScope.chips.map((chip) => `${chip.role}:${chip.id}`)).toEqual([
        'touched:systems:runtime',
        'touched:blocks:api',
        'touched:blocks:store',
      ])
    }),
  )

  it.effect('reports missing system and block scopes as missing targets', () =>
    Effect.gen(function* ()
    {
      const root = yield* Effect.promise(() => makeTemporaryRoot('456code-architecture-scope-'))
      const atlasIndex = index(root)
      const service = yield* ArchitectureProjectionService.make.pipe(
        Effect.provide(
          dependencyLayer({
            root,
            rebuild: {
              retainPublishedIndex: () =>
                Effect.succeed({
                  projectId,
                  root,
                  outDir: root,
                  graphPath: NodePath.join(root, 'graph.json'),
                  generation,
                  graphDigest,
                  builtAt: createdAt,
                  index: atlasIndex,
                }),
            },
          }),
        ),
      )

      for (const scope of [
        { level: 'systems', id: 'systems:missing' },
        { level: 'blocks', id: 'blocks:missing' },
      ] as const)
      {
        const error = yield* service
          .architectureScope(authority, {
            threadId,
            source: standingSource(),
            scope,
          })
          .pipe(Effect.flip)
        expect(error).toMatchObject({
          operation: 'architecture_scope',
          code: 'target-not-found',
        })
      }
    }),
  )

  it.effect('binds neighborhoods and immutable source reads to exact proposal and diff sides', () =>
    Effect.gen(function* ()
    {
      const repository = yield* Effect.promise(initializeRepository)
      const diffRoots = yield* Effect.promise(initializeRetainedDiffRoots)
      const proposalGenerationId = ProposalGenerationId.make('generation-immutable-source')
      const diffAnalysisId = DiffAnalysisId.make('diff-analysis-immutable-source')
      const baseGraphDigest = `sha256:${'c'.repeat(64)}`
      const headGraphDigest = `sha256:${'d'.repeat(64)}`
      const neighborhoodInputs: unknown[] = []
      const retainedSourceSides: Array<'base' | 'head' | undefined> = []
      const retainedTarget = {
        diff: null,
        impactDigest: `sha256:${'e'.repeat(64)}`,
        legacy: false,
        repositoryRoot: repository.root,
        baseTreeOid: repository.baseTreeOid,
        proposedTreeOid: repository.headTreeOid,
        baseGraphDigest,
        proposedGraphDigest: headGraphDigest,
      }
      const service = yield* ArchitectureProjectionService.make.pipe(
        Effect.provide(
          dependencyLayer({
            root: repository.root,
            proposals: {
              resolveImpactTarget: () => Effect.succeed(retainedTarget),
            },
            diffs: {
              retainReadyImpactTarget: (input) =>
                Effect.sync(() =>
                {
                  retainedSourceSides.push(input.sourceSide)
                  return {
                    generation: null as never,
                    diff: null,
                    impactDigest: `sha256:${'f'.repeat(64)}`,
                    legacy: false,
                    repositoryRoot: repository.root,
                    baseTreeOid: repository.baseTreeOid,
                    headTreeOid: repository.headTreeOid,
                    baseGraphDigest,
                    headGraphDigest,
                    baseRoot: diffRoots.baseRoot,
                    headRoot: diffRoots.headRoot,
                  }
                }),
            },
            queries: {
              blastRadius: (_authority, input) =>
                Effect.sync(() =>
                {
                  neighborhoodInputs.push(input)
                  return {
                    version: 1,
                    graph: { generatedAt: createdAt },
                    target: input.target,
                    precision: 'file',
                    direction: input.direction ?? 'both',
                    maxDepth: input.maxDepth ?? 4,
                    upstream: { items: ['src/consumer.ts'], total: 1, omitted: 0 },
                    downstream: { items: [], total: 0, omitted: 0 },
                    impactedFileCount: 1,
                  }
                }),
            },
          }),
        ),
      )
      const proposalBase = {
        kind: 'proposal-generation' as const,
        threadId,
        generationId: proposalGenerationId,
        side: 'base' as const,
        graphDigest: baseGraphDigest,
      }
      const proposalHead = {
        ...proposalBase,
        side: 'proposed' as const,
        graphDigest: headGraphDigest,
      }

      const baseSource = yield* service.architectureSource(authority, {
        threadId,
        source: proposalBase,
        relativePath: 'src/value.ts',
      })
      const headSource = yield* service.architectureSource(authority, {
        threadId,
        source: proposalHead,
        relativePath: 'src/value.ts',
      })
      expect(baseSource.content).toBe('export const value = 1\n')
      expect(headSource.content).toBe('export const value = 2\n')
      expect(baseSource.sourceDigest).not.toBe(headSource.sourceDigest)
      for (const fixture of literalSourceFixtures)
      {
        const source = yield* service.architectureSource(authority, {
          threadId,
          source: proposalHead,
          relativePath: fixture.relativePath,
        })
        expect(source.content).toBe(fixture.content)
      }

      const neighborhood = yield* service.architectureNeighborhood(authority, {
        threadId,
        source: proposalHead,
        target: 'src/value.ts',
        direction: 'upstream',
        maxDepth: 2,
      })
      expect(neighborhood).toMatchObject({
        source: proposalHead,
        target: 'src/value.ts',
        direction: 'upstream',
        maxDepth: 2,
        upstream: { items: ['src/consumer.ts'], total: 1, omitted: 0 },
      })
      expect(neighborhoodInputs).toEqual([
        {
          context: {
            kind: 'proposal-generation',
            generationId: proposalGenerationId,
            graph: 'proposed',
          },
          target: 'src/value.ts',
          direction: 'upstream',
          maxDepth: 2,
        },
      ])

      const diffBase = yield* service.architectureSource(authority, {
        threadId,
        source: {
          kind: 'diff-analysis',
          threadId,
          diffAnalysisId,
          side: 'base',
          graphDigest: baseGraphDigest,
        },
        relativePath: 'src/value.ts',
      })
      const diffHeadSource = {
        kind: 'diff-analysis' as const,
        threadId,
        diffAnalysisId,
        side: 'head' as const,
        graphDigest: headGraphDigest,
      }
      const diffHead = yield* service.architectureSource(authority, {
        threadId,
        source: diffHeadSource,
        relativePath: 'src/value.ts',
      })
      const diffLink = yield* service.architectureSource(authority, {
        threadId,
        source: diffHeadSource,
        relativePath: 'src/value-link.ts',
      })
      expect(diffBase.content).toBe('export const value = 1\n')
      expect(diffHead.content).toBe('export const value = 2\n')
      expect(diffLink.content).toBe('value.ts')
      const diffTooLarge = yield* service
        .architectureSource(authority, {
          threadId,
          source: diffHeadSource,
          relativePath: 'src/large.txt',
        })
        .pipe(Effect.flip)
      expect(diffTooLarge).toMatchObject({
        operation: 'architecture_source',
        code: 'limit-exceeded',
        limit: {
          kind: 'bytes',
          scope: 'source',
          actual: ARCHITECTURE_SOURCE_MAX_BYTES + 1,
          limit: ARCHITECTURE_SOURCE_MAX_BYTES,
        },
      })
      expect(retainedSourceSides).toEqual(['base', 'head', 'head', 'head'])

      const wrongDigest = yield* service
        .architectureSource(authority, {
          threadId,
          source: { ...proposalHead, graphDigest: `sha256:${'0'.repeat(64)}` },
          relativePath: 'src/value.ts',
        })
        .pipe(Effect.flip)
      expect(wrongDigest).toMatchObject({
        operation: 'architecture_source',
        code: 'identity-mismatch',
      })
      const missing = yield* service
        .architectureSource(authority, {
          threadId,
          source: proposalHead,
          relativePath: 'src/missing.ts',
        })
        .pipe(Effect.flip)
      expect(missing).toMatchObject({
        operation: 'architecture_source',
        code: 'target-not-found',
      })
      const tooLarge = yield* service
        .architectureSource(authority, {
          threadId,
          source: proposalHead,
          relativePath: 'src/large.txt',
        })
        .pipe(Effect.flip)
      expect(tooLarge).toMatchObject({
        operation: 'architecture_source',
        code: 'limit-exceeded',
        limit: {
          kind: 'bytes',
          scope: 'source',
          actual: ARCHITECTURE_SOURCE_MAX_BYTES + 1,
          limit: ARCHITECTURE_SOURCE_MAX_BYTES,
        },
      })
      const foreignThread = yield* service
        .architectureNeighborhood(authority, {
          threadId,
          source: {
            ...proposalHead,
            threadId: ThreadId.make('foreign-architecture-thread'),
          },
          target: 'src/value.ts',
          direction: 'both',
          maxDepth: 1,
        })
        .pipe(Effect.flip)
      expect(foreignThread).toMatchObject({
        operation: 'architecture_neighborhood',
        code: 'identity-mismatch',
      })
      expect(neighborhoodInputs).toHaveLength(1)
    }),
  )

  it.effect('serves a historical diff neighborhood when the sealed base tree is absent', () =>
    Effect.gen(function* ()
    {
      const root = yield* Effect.promise(() =>
        makeTemporaryRoot('456code-architecture-neighborhood-base-'),
      )
      const diffAnalysisId = DiffAnalysisId.make('diff-analysis-historical-base')
      const baseGraphDigest = `sha256:${'c'.repeat(64)}`
      const headGraphDigest = `sha256:${'d'.repeat(64)}`
      const retainCalls: Array<{ readonly sourceSide?: 'base' | 'head' }> = []
      const neighborhoodInputs: unknown[] = []
      const service = yield* ArchitectureProjectionService.make.pipe(
        Effect.provide(
          dependencyLayer({
            root,
            diffs: {
              retainReadyImpactTarget: (input) =>
                Effect.sync(() =>
                {
                  retainCalls.push('sourceSide' in input ? { sourceSide: input.sourceSide } : {})
                  return {
                    generation: null as never,
                    diff: null,
                    impactDigest: `sha256:${'f'.repeat(64)}`,
                    legacy: false,
                    repositoryRoot: root,
                    baseTreeOid: 'base-tree',
                    headTreeOid: 'head-tree',
                    baseGraphDigest,
                    headGraphDigest,
                    baseRoot: null,
                    headRoot: root,
                  }
                }),
            },
            queries: {
              blastRadius: (_authority, input) =>
                Effect.sync(() =>
                {
                  neighborhoodInputs.push(input)
                  return {
                    version: 1,
                    graph: { generatedAt: createdAt },
                    target: input.target,
                    precision: 'file',
                    direction: input.direction ?? 'both',
                    maxDepth: input.maxDepth ?? 4,
                    upstream: { items: ['src/consumer.ts'], total: 1, omitted: 0 },
                    downstream: { items: [], total: 0, omitted: 0 },
                    impactedFileCount: 1,
                  }
                }),
            },
          }),
        ),
      )
      const diffBase = {
        kind: 'diff-analysis' as const,
        threadId,
        diffAnalysisId,
        side: 'base' as const,
        graphDigest: baseGraphDigest,
      }

      const neighborhood = yield* service.architectureNeighborhood(authority, {
        threadId,
        source: diffBase,
        target: 'src/value.ts',
        direction: 'upstream',
        maxDepth: 2,
      })
      expect(neighborhood).toMatchObject({
        source: diffBase,
        target: 'src/value.ts',
        direction: 'upstream',
        maxDepth: 2,
        upstream: { items: ['src/consumer.ts'], total: 1, omitted: 0 },
      })
      expect(neighborhoodInputs).toEqual([
        {
          context: {
            kind: 'diff-analysis',
            diffAnalysisId,
            graph: 'base',
          },
          target: 'src/value.ts',
          direction: 'upstream',
          maxDepth: 2,
        },
      ])
      expect(retainCalls).toEqual([{}])

      const missingBaseTree = yield* service
        .architectureSource(authority, {
          threadId,
          source: diffBase,
          relativePath: 'src/value.ts',
        })
        .pipe(Effect.flip)
      expect(missingBaseTree).toMatchObject({
        operation: 'architecture_source',
        code: 'context-not-ready',
      })
      expect(retainCalls).toEqual([{}, { sourceSide: 'base' }])
    }),
  )
})
