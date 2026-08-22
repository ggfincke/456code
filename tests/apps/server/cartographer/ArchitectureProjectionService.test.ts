// tests/apps/server/cartographer/ArchitectureProjectionService.test.ts
// verifies current Atlas v6 map and drill projections stay exact and generation-bound

// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'

import {
  EnvironmentId,
  ProjectId,
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
import {
  GRAPH_SCHEMA_VERSION,
  type CartographerGraph,
} from '../../../../packages/cartographer-core/src/contracts/types.ts'
import { buildAtlasIndex } from '../../../../packages/cartographer-core/src/store/atlasIndex/build.ts'
import { makeProjectionSnapshotQueryStub } from '../projectionSnapshotQueryTestHelpers.ts'

const environmentId = EnvironmentId.make('environment-architecture-projection')
const projectId = ProjectId.make('project-architecture-projection')
const threadId = ThreadId.make('thread-architecture-projection')
const createdAt = '2026-08-20T12:00:00.000Z'
const generationId = '9'.repeat(64)
const graphDigest = `sha256:${'a'.repeat(64)}` as const
const temporaryRoots = new Set<string>()

const authority: ArchitectureQueryService.ArchitectureQueryAuthority = {
  environmentId,
  threadId,
}

async function makeTemporaryRoot(): Promise<string>
{
  const created = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), '456code-architecture-projection-'),
  )
  const root = await NodeFSP.realpath(created)
  temporaryRoots.add(root)
  return root
}

function thread(root: string): OrchestrationThread
{
  return {
    id: threadId,
    projectId,
    title: 'Architecture projection thread',
    modelSelection: { instanceId: ProviderInstanceId.make('codex'), model: 'gpt-5.6' },
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

function graph(root: string): CartographerGraph
{
  return {
    version: GRAPH_SCHEMA_VERSION,
    repoRoot: root,
    mode: 'imports',
    generatedAt: createdAt,
    gitRef: '1'.repeat(40),
    scope: '.',
    nodes: [
      {
        id: 'src/api.ts',
        kind: 'file',
        label: 'api.ts',
        group: 'api',
        system: 'runtime',
      },
      {
        id: 'src/store.ts',
        kind: 'file',
        label: 'store.ts',
        group: 'store',
        system: 'runtime',
      },
      {
        id: 'tools/cli.ts',
        kind: 'file',
        label: 'cli.ts',
        group: 'cli',
        system: 'tooling',
      },
    ],
    edges: [
      {
        id: 'api-store',
        from: 'src/api.ts',
        to: 'src/store.ts',
        kind: 'imports',
      },
      {
        id: 'cli-api',
        from: 'tools/cli.ts',
        to: 'src/api.ts',
        kind: 'imports',
      },
    ],
    groups: [
      { id: 'api', label: 'API', fileCount: 1 },
      { id: 'store', label: 'Store', fileCount: 1 },
      { id: 'cli', label: 'CLI', fileCount: 1 },
    ],
    systems: [
      { id: 'runtime', label: 'Runtime', fileCount: 2, source: 'authored' },
      { id: 'tooling', label: 'Tooling', fileCount: 1, source: 'authored' },
    ],
    metrics: { cycles: 0, orphans: 0, maxFanIn: 1, maxFanOut: 1 },
  }
}

function standingSource(): ArchitectureStandingSource
{
  return {
    kind: 'standing-project-generation',
    projectId,
    generationId,
    side: 'analyzed',
    graphDigest,
  }
}

function dependencies(root: string)
{
  const index = buildAtlasIndex(graph(root), graphDigest)
  return Layer.mergeAll(
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(environmentId),
    }),
    Layer.succeed(
      ProjectionSnapshotQuery.ProjectionSnapshotQuery,
      makeProjectionSnapshotQueryStub({
        getThreadDetailById: (requestedThreadId) =>
          Effect.succeed(
            requestedThreadId === threadId ? Option.some(thread(root)) : Option.none(),
          ),
        getProjectShellById: (requestedProjectId) =>
          Effect.succeed(
            requestedProjectId === projectId ? Option.some(project(root)) : Option.none(),
          ),
      }),
    ),
    Layer.mock(AtlasRebuildService.AtlasRebuildService)({
      retainPublishedIndex: (requestedProjectId, requestedGeneration) =>
        Effect.succeed(
          requestedProjectId === projectId &&
            (requestedGeneration === undefined || requestedGeneration === generationId)
            ? {
                projectId,
                root,
                outDir: root,
                graphPath: NodePath.join(root, 'graph.json'),
                generation: generationId,
                graphDigest,
                builtAt: createdAt,
                index,
              }
            : null,
        ),
    }),
    Layer.mock(ProjectAtlasStatusBroadcaster.ProjectAtlasStatusBroadcaster)({
      getStatus: () =>
        Effect.succeed({
          state: 'ready',
          source: standingSource(),
          freshness: { builtAt: createdAt, dirty: false },
          lastBuildError: null,
        }),
    }),
    Layer.mock(ProposalGenerationService.ProposalGenerationService)({
      resolveImpactTarget: () => Effect.die('unexpected proposal source resolution'),
    }),
    Layer.mock(DiffAnalysisService.DiffAnalysisService)({
      retainReadyImpactTarget: () => Effect.die('unexpected diff source resolution'),
    }),
    Layer.mock(ArchitectureQueryService.ArchitectureQueryService)({
      blastRadius: () => Effect.die('unexpected raw architecture query'),
    }),
  )
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
  it.effect('serves only current Architecture and Structure projections from Atlas v6', () =>
    Effect.gen(function* ()
    {
      const root = yield* Effect.promise(makeTemporaryRoot)
      const service = yield* ArchitectureProjectionService.make.pipe(
        Effect.provide(dependencies(root)),
      )

      const architecture = yield* service.repositoryMap(authority, {
        threadId,
        projectId,
        lens: 'architecture',
      })
      expect(architecture).toMatchObject({
        projectionVersion: 1,
        kind: 'repository-map',
        authority: 'standing',
        source: standingSource(),
        lens: 'architecture',
        semanticLevel: 'systems',
        totals: {
          nodes: { total: 2, returned: 2, omitted: 0 },
          edges: { total: 1, returned: 1, omitted: 0 },
        },
      })
      expect(architecture.nodes.map((node) => node.id)).toEqual([
        'systems:runtime',
        'systems:tooling',
      ])

      const structure = yield* service.repositoryMap(authority, {
        threadId,
        projectId,
        generationId,
        lens: 'structure',
      })
      expect(structure).toMatchObject({
        projectionVersion: 1,
        lens: 'structure',
        semanticLevel: 'dirs',
      })
      expect(structure.nodes.map((node) => node.id)).toEqual(['dirs:src', 'dirs:tools'])

      const blocks = yield* service.architectureScope(authority, {
        threadId,
        source: standingSource(),
        lens: 'architecture',
        scope: { level: 'systems', id: 'systems:runtime' },
      })
      expect(blocks).toMatchObject({
        projectionVersion: 1,
        lens: 'architecture',
        semanticLevel: 'blocks',
        breadcrumbs: [{ id: 'systems:runtime', level: 'systems' }],
      })
      expect(blocks.nodes.map((node) => node.id).sort()).toEqual(['blocks:api', 'blocks:store'])
      expect(blocks.edges).toHaveLength(1)

      const files = yield* service.architectureScope(authority, {
        threadId,
        source: standingSource(),
        lens: 'structure',
        scope: { level: 'dirs', id: 'dirs:src' },
      })
      expect(files).toMatchObject({
        projectionVersion: 1,
        lens: 'structure',
        semanticLevel: 'files',
      })
      expect(files.nodes.map((node) => node.id).sort()).toEqual(['src/api.ts', 'src/store.ts'])

      const missingGeneration = yield* service
        .repositoryMap(authority, {
          threadId,
          projectId,
          generationId: '8'.repeat(64),
          lens: 'architecture',
        })
        .pipe(Effect.flip)
      expect(missingGeneration).toMatchObject({
        operation: 'architecture_repository_map',
        code: 'context-not-ready',
      })

      const wrongDigest = yield* service
        .architectureScope(authority, {
          threadId,
          source: { ...standingSource(), graphDigest: `sha256:${'b'.repeat(64)}` },
          lens: 'architecture',
          scope: { level: 'systems', id: 'systems:runtime' },
        })
        .pipe(Effect.flip)
      expect(wrongDigest).toMatchObject({
        operation: 'architecture_scope',
        code: 'identity-mismatch',
      })
    }),
  )
})
