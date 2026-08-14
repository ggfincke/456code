// tests/apps/server/cartographer/ArchitectureQueryService.test.ts
// verifies authorized architecture resolution, bounded caching, and ephemeral patch evaluation

// @effect-diagnostics nodeBuiltinImport:off

import * as NodeChildProcess from 'node:child_process'
import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'

import { expect, it } from '@effect/vitest'
import {
  CartographerError,
  DiffAnalysisError,
  DiffAnalysisId,
  EnvironmentId,
  OrchestratePlanRunId,
  ProjectId,
  ProposalGenerationError,
  ProposalGenerationId,
  ProposalId,
  ProposalRevisionId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type DiffAnalysisGeneration,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type ProposalGeneration,
} from '@t3tools/contracts'
import {
  createGraphRelationIndex,
  GRAPH_SCHEMA_VERSION,
  loadContextQuery,
  type CartographerGraph,
  type ContextQueryGraph,
  type GraphDiff,
} from '@t3tools/cartographer-core'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import { afterEach, describe } from 'vite-plus/test'

import {
  make,
  type ArchitectureQueryAuthority,
} from '../../../../apps/server/src/cartographer/ArchitectureQueryService.ts'
import * as AtlasRebuildService from '../../../../apps/server/src/cartographer/AtlasRebuildService.ts'
import * as CurrentWorktreeArchitectureService from '../../../../apps/server/src/cartographer/CurrentWorktreeArchitectureService.ts'
import * as DiffAnalysisService from '../../../../apps/server/src/cartographer/DiffAnalysisService.ts'
import * as ServerEnvironment from '../../../../apps/server/src/environment/ServerEnvironment.ts'
import * as ProjectionSnapshotQuery from '../../../../apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts'
import * as ProposalGenerationService from '../../../../apps/server/src/proposal/ProposalGenerationService.ts'
import { makeProjectionSnapshotQueryStub } from '../projectionSnapshotQueryTestHelpers.ts'

const environmentId = EnvironmentId.make('environment-architecture-query')
const projectId = ProjectId.make('project-architecture-query')
const threadId = ThreadId.make('thread-architecture-query')
const turnId = TurnId.make('turn-architecture-query')
const createdAt = '2026-08-07T12:00:00.000Z'
const temporaryRoots = new Set<string>()

const authority: ArchitectureQueryAuthority = {
  environmentId,
  threadId,
  activeTurnId: turnId,
}

async function makeTemporaryRoot(prefix: string): Promise<string>
{
  const created = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix))
  const root = await NodeFSP.realpath(created)
  temporaryRoots.add(root)
  return root
}

function graph(
  nodes: ReadonlyArray<string>,
  edges: ReadonlyArray<{ readonly from: string; readonly to: string }> = [],
  generatedAt = createdAt,
): CartographerGraph
{
  return {
    version: GRAPH_SCHEMA_VERSION,
    repoRoot: '.',
    mode: 'imports',
    generatedAt,
    gitRef: 'a'.repeat(40),
    scope: '.',
    nodes: nodes.map((id) => ({
      id,
      kind: 'file',
      label: NodePath.basename(id),
      group: 'src',
    })),
    edges: edges.map((edge, index) => ({
      id: `edge-${index}`,
      kind: 'imports',
      from: edge.from,
      to: edge.to,
    })),
    groups: [{ id: 'src', label: 'src', fileCount: nodes.length }],
    metrics: {
      cycles: 0,
      orphans: Math.max(0, nodes.length - edges.length),
      maxFanIn: edges.length > 0 ? 1 : 0,
      maxFanOut: edges.length > 0 ? 1 : 0,
    },
  }
}

function graphDiff(): GraphDiff
{
  return {
    baseGeneratedAt: createdAt,
    headGeneratedAt: createdAt,
    baseGitRef: 'a'.repeat(40),
    headGitRef: 'b'.repeat(40),
    addedNodes: ['src/added.ts'],
    removedNodes: [],
    addedEdges: [{ from: 'src/added.ts', to: 'src/provider.ts' }],
    removedEdges: [],
    movedNodes: [],
    moveFlows: [],
    movedEdges: 0,
    apiChanges: [],
    newViolations: [],
    resolvedViolations: [],
    changed: true,
  }
}

async function writeGraph(root: string, value: CartographerGraph, name = 'graph.json')
{
  const path = NodePath.join(root, name)
  await NodeFSP.writeFile(path, `${JSON.stringify(value)}\n`)
  return path
}

function thread(worktreePath: string): OrchestrationThread
{
  return {
    id: threadId,
    projectId,
    title: 'Architecture query thread',
    modelSelection: {
      instanceId: ProviderInstanceId.make('codex'),
      model: 'gpt-5.6',
    },
    runtimeMode: 'full-access',
    interactionMode: 'default',
    branch: null,
    worktreePath,
    latestTurn: {
      turnId,
      state: 'running',
      requestedAt: createdAt,
      startedAt: createdAt,
      completedAt: null,
      assistantMessageId: null,
    },
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
    session: {
      threadId,
      status: 'running',
      providerName: 'codex',
      providerInstanceId: ProviderInstanceId.make('codex'),
      runtimeMode: 'full-access',
      activeTurnId: turnId,
      lastError: null,
      updatedAt: createdAt,
    },
  }
}

function project(workspaceRoot: string): OrchestrationProjectShell
{
  return {
    id: projectId,
    title: 'Architecture query project',
    workspaceRoot,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt,
    updatedAt: createdAt,
  }
}

function proposalGeneration(generationId: ProposalGenerationId): ProposalGeneration
{
  return {
    generationId,
    proposalId: ProposalId.make(`proposal-${generationId}`),
    revisionId: ProposalRevisionId.make(`revision-${generationId}`),
    revision: 1,
    threadId,
    state: 'ready',
    authority: 'authoritative',
    freshness: 'fresh',
    workspaceSnapshotTreeOid: 'a'.repeat(40),
    analyzerVersion: 'cartographer-test',
    baseGraphArtifact: `proposal:${generationId}:base`,
    proposedGraphArtifact: `proposal:${generationId}:proposed`,
    impactArtifact: `proposal:${generationId}:impact`,
    errorCode: null,
    createdAt,
    updatedAt: createdAt,
  }
}

function diffGeneration(diffAnalysisId: DiffAnalysisId): DiffAnalysisGeneration
{
  return {
    version: 1,
    diffAnalysisId,
    sourceKind: 'review',
    state: 'ready',
    baseTreeOid: 'a'.repeat(40),
    headTreeOid: 'b'.repeat(40),
    analyzerVersion: 'cartographer-test',
    analysisPolicyVersion: 'diff-analysis-v1',
    sourceCurrent: true,
    baseGraphArtifact: `diff:${diffAnalysisId}:base`,
    headGraphArtifact: `diff:${diffAnalysisId}:head`,
    impactArtifact: `diff:${diffAnalysisId}:impact`,
    artifactByteLength: 1,
    errorCode: null,
    createdAt,
    updatedAt: createdAt,
    lastAccessedAt: createdAt,
  }
}

interface DependencyOptions
{
  readonly root: string
  readonly currentWorktree?: Partial<
    CurrentWorktreeArchitectureService.CurrentWorktreeArchitectureService['Service']
  >
  readonly rebuild?: Partial<AtlasRebuildService.AtlasRebuildService['Service']>
  readonly proposals?: Partial<ProposalGenerationService.ProposalGenerationService['Service']>
  readonly diffs?: Partial<DiffAnalysisService.DiffAnalysisService['Service']>
  readonly projectedThread?: OrchestrationThread
}

function dependencyLayer(options: DependencyOptions)
{
  const projectedThread = options.projectedThread ?? thread(options.root)
  return Layer.mergeAll(
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(environmentId),
    }),
    Layer.succeed(
      ProjectionSnapshotQuery.ProjectionSnapshotQuery,
      makeProjectionSnapshotQueryStub({
        getThreadDetailById: (requestedThreadId) =>
          Effect.succeed(
            requestedThreadId === threadId ? Option.some(projectedThread) : Option.none(),
          ),
        getProjectShellById: (requestedProjectId) =>
          Effect.succeed(
            requestedProjectId === projectId ? Option.some(project(options.root)) : Option.none(),
          ),
      }),
    ),
    Layer.mock(CurrentWorktreeArchitectureService.CurrentWorktreeArchitectureService)({
      retainThreadTarget: () => Effect.die('unexpected retainThreadTarget'),
      ...options.currentWorktree,
    }),
    Layer.mock(AtlasRebuildService.AtlasRebuildService)({
      retainLastGood: () => Effect.succeed(null),
      retainPublishedIndex: () => Effect.succeed(null),
      ...options.rebuild,
    }),
    Layer.mock(ProposalGenerationService.ProposalGenerationService)({
      get: () => Effect.die('unexpected ProposalGenerationService.get'),
      resolveArchitectureTarget: () =>
        Effect.die('unexpected ProposalGenerationService.resolveArchitectureTarget'),
      resolveImpactTarget: () =>
        Effect.die('unexpected ProposalGenerationService.resolveImpactTarget'),
      ...options.proposals,
    }),
    Layer.mock(DiffAnalysisService.DiffAnalysisService)({
      getById: () => Effect.die('unexpected DiffAnalysisService.getById'),
      retainReadyTarget: () => Effect.die('unexpected DiffAnalysisService.retainReadyTarget'),
      retainReadyImpactTarget: () =>
        Effect.die('unexpected DiffAnalysisService.retainReadyImpactTarget'),
      ...options.diffs,
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

describe('ArchitectureQueryService', () =>
{
  it.effect(
    'authorizes before every cache hit and releases the current-worktree target lease',
    () =>
      Effect.gen(function* ()
      {
        const root = yield* Effect.promise(() => makeTemporaryRoot('456code-architecture-query-'))
        const graphPath = yield* Effect.promise(() =>
          writeGraph(
            root,
            graph(
              ['src/entry.ts', 'src/dependency.ts'],
              [{ from: 'src/entry.ts', to: 'src/dependency.ts' }],
            ),
          ),
        )
        let acquired = 0
        let released = 0
        let loaded = 0
        const service = yield* make({
          loadGraph: (path) =>
          {
            loaded += 1
            return loadContextQuery(path)
          },
        }).pipe(
          Effect.provide(
            dependencyLayer({
              root,
              currentWorktree: {
                retainThreadTarget: () =>
                  Effect.acquireRelease(
                    Effect.sync(() =>
                    {
                      acquired += 1
                      return {
                        sourceKind: 'current-worktree' as const,
                        root,
                        outDir: root,
                        graphPath,
                        liveRoot: root,
                      }
                    }),
                    () =>
                      Effect.sync(() =>
                      {
                        released += 1
                      }),
                  ),
              },
            }),
          ),
        )

        const input = {
          context: { kind: 'current-thread-worktree' as const },
          target: 'src/dependency.ts',
        }
        const first = yield* service.blastRadius(authority, input)
        const second = yield* service.blastRadius(authority, input)

        expect(first.upstream).toEqual({
          items: ['src/entry.ts'],
          total: 1,
          omitted: 0,
        })
        expect(second).toEqual(first)
        expect({ acquired, released, loaded }).toEqual({ acquired: 2, released: 2, loaded: 1 })
      }),
  )

  it.effect(
    'queries a retained resolved project target without reacquiring its publication lock',
    () =>
      Effect.gen(function* ()
      {
        const root = yield* Effect.promise(() => makeTemporaryRoot('456code-resolved-project-'))
        const graphPath = yield* Effect.promise(() =>
          writeGraph(
            root,
            graph(
              ['src/entry.ts', 'src/provider.ts'],
              [{ from: 'src/entry.ts', to: 'src/provider.ts' }],
            ),
          ),
        )
        let selectorRetains = 0
        const service = yield* make().pipe(
          Effect.provide(
            dependencyLayer({
              root,
              rebuild: {
                retainLastGood: () =>
                  Effect.sync(() =>
                  {
                    selectorRetains += 1
                    throw new Error('resolved target reacquired the publication lock')
                  }),
              },
            }),
          ),
        )

        const result = yield* service.blastRadius(
          authority,
          {
            context: { kind: 'standing-project' },
            target: 'src/provider.ts',
            direction: 'upstream',
            maxDepth: 1,
          },
          {
            context: { root, outDir: root, graphPath, liveRoot: root },
            recovery: 'build_project_atlas',
          },
        )

        expect(result.upstream).toEqual({ items: ['src/entry.ts'], total: 1, omitted: 0 })
        expect(selectorRetains).toBe(0)
      }),
  )

  it.effect(
    'masks foreign proposal identities and reports unavailable contexts with recovery',
    () =>
      Effect.gen(function* ()
      {
        const root = yield* Effect.promise(() => makeTemporaryRoot('456code-architecture-mask-'))
        const generationId = ProposalGenerationId.make('generation-foreign')
        const masked = yield* make().pipe(
          Effect.provide(
            dependencyLayer({
              root,
              proposals: {
                get: () =>
                  Effect.fail(
                    new ProposalGenerationError({
                      failure: 'scope-mismatch',
                      message: 'foreign generation',
                    }),
                  ),
              },
            }),
          ),
        )
        const maskedError = yield* masked
          .blastRadius(authority, {
            context: { kind: 'proposal-generation', generationId, graph: 'base' },
            target: 'src/entry.ts',
          })
          .pipe(Effect.flip)
        expect(maskedError).toMatchObject({
          operation: 'architecture_blast_radius',
          code: 'not-found',
        })

        const unavailable = yield* make().pipe(
          Effect.provide(
            dependencyLayer({
              root,
              currentWorktree: {
                retainThreadTarget: () =>
                  Effect.fail(
                    new CartographerError({
                      failure: 'context_not_found',
                      message: 'closed',
                    }),
                  ),
              },
            }),
          ),
        )
        const unavailableError = yield* unavailable
          .blastRadius(authority, {
            context: { kind: 'current-thread-worktree' },
            target: 'src/entry.ts',
          })
          .pipe(Effect.flip)
        expect(unavailableError).toMatchObject({
          operation: 'architecture_blast_radius',
          code: 'context-not-ready',
          recovery: 'prepare_current_worktree_architecture',
        })

        const projectGraphPath = yield* Effect.promise(() =>
          writeGraph(root, graph(['src/project.ts']), 'project.graph.json'),
        )
        let projectRetained = 0
        let projectReleased = 0
        const projectContext = yield* make().pipe(
          Effect.provide(
            dependencyLayer({
              root,
              rebuild: {
                retainLastGood: () =>
                  Effect.acquireRelease(
                    Effect.sync(() =>
                    {
                      projectRetained += 1
                      return {
                        projectId,
                        root,
                        outDir: root,
                        graphPath: projectGraphPath,
                        generation: 'b'.repeat(64),
                        builtAt: createdAt,
                      }
                    }),
                    () =>
                      Effect.sync(() =>
                      {
                        projectReleased += 1
                      }),
                  ),
              },
            }),
          ),
        )
        const resolvedProject = yield* Effect.scoped(
          projectContext.resolveContext(authority, { kind: 'standing-project' }),
        )
        expect(resolvedProject).toEqual({
          root,
          outDir: root,
          graphPath: projectGraphPath,
          liveRoot: root,
        })
        expect({ projectRetained, projectReleased }).toEqual({
          projectRetained: 1,
          projectReleased: 1,
        })

        const missingProject = yield* make().pipe(Effect.provide(dependencyLayer({ root })))
        const missingProjectError = yield* missingProject
          .blastRadius(authority, {
            context: { kind: 'standing-project' },
            target: 'src/project.ts',
          })
          .pipe(Effect.flip)
        expect(missingProjectError).toMatchObject({
          operation: 'architecture_blast_radius',
          code: 'context-not-ready',
          recovery: 'build_project_atlas',
        })
      }),
  )

  it.effect('rejects retained current and project graphs bound to stale projected roots', () =>
    Effect.gen(function* ()
    {
      const [projectedRoot, staleRoot] = yield* Effect.promise(() =>
        Promise.all([
          makeTemporaryRoot('456code-architecture-projected-root-'),
          makeTemporaryRoot('456code-architecture-stale-root-'),
        ]),
      )
      let currentReleased = 0
      const current = yield* make().pipe(
        Effect.provide(
          dependencyLayer({
            root: projectedRoot,
            currentWorktree: {
              retainThreadTarget: () =>
                Effect.acquireRelease(
                  Effect.succeed({
                    sourceKind: 'current-worktree' as const,
                    root: staleRoot,
                    outDir: staleRoot,
                    graphPath: NodePath.join(staleRoot, 'graph.json'),
                    liveRoot: staleRoot,
                  }),
                  () =>
                    Effect.sync(() =>
                    {
                      currentReleased += 1
                    }),
                ),
            },
          }),
        ),
      )
      const currentError = yield* Effect.scoped(
        current.resolveContext(authority, { kind: 'current-thread-worktree' }),
      ).pipe(Effect.flip)
      expect(currentError).toMatchObject({
        code: 'context-not-ready',
        recovery: 'prepare_current_worktree_architecture',
      })
      expect(currentReleased).toBe(1)

      let projectReleased = 0
      const standing = yield* make().pipe(
        Effect.provide(
          dependencyLayer({
            root: projectedRoot,
            rebuild: {
              retainLastGood: () =>
                Effect.acquireRelease(
                  Effect.succeed({
                    projectId,
                    root: staleRoot,
                    outDir: staleRoot,
                    graphPath: NodePath.join(staleRoot, 'graph.json'),
                    generation: 'c'.repeat(64),
                    builtAt: createdAt,
                  }),
                  () =>
                    Effect.sync(() =>
                    {
                      projectReleased += 1
                    }),
                ),
            },
          }),
        ),
      )
      const standingError = yield* Effect.scoped(
        standing.resolveContext(authority, { kind: 'standing-project' }),
      ).pipe(Effect.flip)
      expect(standingError).toMatchObject({
        code: 'context-not-ready',
        recovery: 'build_project_atlas',
      })
      expect(projectReleased).toBe(1)
    }),
  )

  it.effect('evicts the oldest fifth graph without initiating analysis or rebuild work', () =>
    Effect.gen(function* ()
    {
      const root = yield* Effect.promise(() => makeTemporaryRoot('456code-architecture-cache-'))
      const generations = Array.from({ length: 5 }, (_, index) =>
        ProposalGenerationId.make(`generation-cache-${index}`),
      )
      const paths = new Map<ProposalGenerationId, string>()
      for (const [index, generationId] of generations.entries())
      {
        paths.set(
          generationId,
          yield* Effect.promise(() =>
            writeGraph(
              root,
              graph([`src/target-${index}.ts`], [], `2026-08-07T12:00:0${index}.000Z`),
              `graph-${index}.json`,
            ),
          ),
        )
      }
      let loaded = 0
      let resolved = 0
      let generationStarts = 0
      let rebuildRequests = 0
      let diffRequests = 0
      const service = yield* make({
        loadGraph: (path) =>
        {
          loaded += 1
          return loadContextQuery(path)
        },
      }).pipe(
        Effect.provide(
          dependencyLayer({
            root,
            rebuild: {
              request: () =>
                Effect.sync(() =>
                {
                  rebuildRequests += 1
                  throw new Error('unexpected rebuild')
                }),
            },
            proposals: {
              start: () =>
                Effect.sync(() =>
                {
                  generationStarts += 1
                  throw new Error('unexpected proposal analysis')
                }),
              get: ({ generationId }) => Effect.succeed(proposalGeneration(generationId)),
              resolveArchitectureTarget: (_threadId, generationId) =>
                Effect.sync(() =>
                {
                  resolved += 1
                  const graphPath = paths.get(generationId)
                  if (graphPath === undefined) throw new Error('missing graph fixture')
                  return {
                    generation: proposalGeneration(generationId),
                    proposedRoot: root,
                    baseGraphPath: graphPath,
                    proposedGraphPath: graphPath,
                    impactPath: graphPath,
                  }
                }),
            },
            diffs: {
              request: () =>
                Effect.sync(() =>
                {
                  diffRequests += 1
                  throw new Error('unexpected diff analysis')
                }),
            },
          }),
        ),
      )

      yield* Effect.forEach(
        generations,
        (generationId, index) =>
          service.blastRadius(authority, {
            context: { kind: 'proposal-generation', generationId, graph: 'base' },
            target: `src/target-${index}.ts`,
          }),
        { discard: true },
      )
      yield* service.blastRadius(authority, {
        context: {
          kind: 'proposal-generation',
          generationId: generations[0]!,
          graph: 'base',
        },
        target: 'src/target-0.ts',
      })

      expect({ loaded, resolved }).toEqual({ loaded: 6, resolved: 6 })
      expect({ generationStarts, rebuildRequests, diffRequests }).toEqual({
        generationStarts: 0,
        rebuildRequests: 0,
        diffRequests: 0,
      })
    }),
  )

  it.effect('holds one diff-analysis lease across both sides of a comparison', () =>
    Effect.gen(function* ()
    {
      const root = yield* Effect.promise(() => makeTemporaryRoot('456code-architecture-pair-'))
      const provider = 'src/provider.ts'
      const consumers = Array.from(
        { length: 30 },
        (_, index) => `src/consumer-${index.toString().padStart(2, '0')}.ts`,
      )
      const baseGraph = graph(
        [provider, ...consumers],
        consumers.map((consumer) => ({ from: consumer, to: provider })),
      )
      const headGraph = graph(
        [provider, ...consumers, 'src/head.ts'],
        consumers.map((consumer) => ({ from: consumer, to: provider })),
      )
      baseGraph.nodes.find((node) => node.id === provider)!.exports = [{ name: 'removedApi' }]
      headGraph.nodes.find((node) => node.id === provider)!.exports = [{ name: 'addedApi' }]
      for (const edge of headGraph.edges.filter((edge) => edge.to === provider))
      {
        edge.symbols = ['removedApi']
      }
      const baseGraphPath = yield* Effect.promise(() =>
        writeGraph(root, baseGraph, 'base.graph.json'),
      )
      const headGraphPath = yield* Effect.promise(() =>
        writeGraph(root, headGraph, 'head.graph.json'),
      )
      const diffAnalysisId = DiffAnalysisId.make('diff-analysis-pair')
      let retained = 0
      let released = 0
      const authorizedRoots: string[] = []
      const projectedThread: OrchestrationThread = {
        ...thread('/tmp/pruned-integration-worktree'),
        orchestrateRunExecution: {
          threadId,
          runId: OrchestratePlanRunId.make('run-architecture-query'),
          planRevision: 1,
          sourceTurnId: turnId,
          sourceSequence: 10,
          repositoryRoot: root,
          repositoryCommonDir: NodePath.join(root, '.git'),
          baseOid: 'a'.repeat(40),
          lifecycle: 'completed',
          availability: 'unavailable',
          integrationRoot: '/tmp/pruned-integration-worktree',
          integrationCommonDir: NodePath.join(root, '.git'),
          integrationBranch: 'run/exact',
          integrationOid: 'b'.repeat(40),
          observedHeadOid: 'b'.repeat(40),
          finalHeadOid: 'b'.repeat(40),
          closeReason: 'completed fixture',
          current: true,
          admittedAt: createdAt,
          updatedAt: createdAt,
          terminalAt: createdAt,
          jobs: [],
        },
      }
      const service = yield* make().pipe(
        Effect.provide(
          dependencyLayer({
            root,
            projectedThread,
            diffs: {
              getById: (input) =>
                Effect.sync(() =>
                {
                  authorizedRoots.push(input.workspaceRoot)
                  return diffGeneration(diffAnalysisId)
                }),
              retainReadyTarget: (input) =>
                Effect.acquireRelease(
                  Effect.sync(() =>
                  {
                    authorizedRoots.push(input.workspaceRoot)
                    retained += 1
                    return {
                      generation: diffGeneration(diffAnalysisId),
                      repositoryKey: 'repository-test',
                      headRoot: root,
                      baseGraphPath,
                      headGraphPath,
                      impactPath: headGraphPath,
                    }
                  }),
                  () =>
                    Effect.sync(() =>
                    {
                      released += 1
                    }),
                ),
            },
          }),
        ),
      )

      const result = yield* service.graphDiff(authority, {
        comparison: { kind: 'diff-analysis', diffAnalysisId },
      })

      expect(result.addedNodes).toEqual({ items: ['src/head.ts'], total: 1, omitted: 0 })
      expect(result.apiTotals).toEqual({
        files: 1,
        addedExports: 1,
        removedExports: 1,
        brokenConsumers: 30,
      })
      expect(result.apiChanges.items[0]?.removedExports.items[0]?.brokenConsumers).toEqual({
        items: consumers.slice(0, 25),
        total: 30,
        omitted: 5,
      })
      expect({ retained, released }).toEqual({ retained: 1, released: 1 })
      expect(authorizedRoots).toEqual([root, root])

      const persistenceFailure = yield* make().pipe(
        Effect.provide(
          dependencyLayer({
            root,
            diffs: {
              getById: () => Effect.succeed(diffGeneration(diffAnalysisId)),
              retainReadyTarget: () =>
                Effect.fail(
                  new DiffAnalysisError({
                    code: 'persistence-failed',
                    message: 'touch failed',
                    diffAnalysisId,
                  }),
                ),
            },
          }),
        ),
      )
      const persistenceError = yield* persistenceFailure
        .graphDiff(authority, {
          comparison: { kind: 'diff-analysis', diffAnalysisId },
        })
        .pipe(Effect.flip)
      expect(persistenceError.code).toBe('persistence-failed')
      expect('recovery' in persistenceError).toBe(false)
    }),
  )

  it.effect('serves sealed proposal and diff impact without loading either graph', () =>
    Effect.gen(function* ()
    {
      const root = yield* Effect.promise(() => makeTemporaryRoot('456code-sealed-impact-'))
      const generationId = ProposalGenerationId.make('generation-sealed-impact')
      const diffAnalysisId = DiffAnalysisId.make('diff-analysis-sealed-impact')
      const sealedDiff = graphDiff()
      let graphLoads = 0
      let proposalReads = 0
      let diffRetained = 0
      let diffReleased = 0
      const service = yield* make({
        loadGraph: () =>
        {
          graphLoads += 1
          throw new Error('sealed impact loaded a graph')
        },
      }).pipe(
        Effect.provide(
          dependencyLayer({
            root,
            proposals: {
              resolveImpactTarget: () =>
                Effect.sync(() =>
                {
                  proposalReads += 1
                  return {
                    diff: sealedDiff,
                    impactDigest: `sha256:${'c'.repeat(64)}`,
                    legacy: false,
                    repositoryRoot: root,
                    baseTreeOid: 'a'.repeat(40),
                    proposedTreeOid: 'b'.repeat(40),
                    baseGraphDigest: `sha256:${'d'.repeat(64)}`,
                    proposedGraphDigest: `sha256:${'e'.repeat(64)}`,
                  }
                }),
            },
            diffs: {
              retainReadyImpactTarget: () =>
                Effect.acquireRelease(
                  Effect.sync(() =>
                  {
                    diffRetained += 1
                    return {
                      generation: diffGeneration(diffAnalysisId),
                      diff: sealedDiff,
                      impactDigest: `sha256:${'f'.repeat(64)}`,
                      legacy: false,
                      repositoryRoot: root,
                      baseTreeOid: 'a'.repeat(40),
                      headTreeOid: 'b'.repeat(40),
                      baseGraphDigest: `sha256:${'1'.repeat(64)}`,
                      headGraphDigest: `sha256:${'2'.repeat(64)}`,
                      baseRoot: root,
                      headRoot: root,
                    }
                  }),
                  () =>
                    Effect.sync(() =>
                    {
                      diffReleased += 1
                    }),
                ),
            },
          }),
        ),
      )

      const proposal = yield* service.architectureImpact(authority, {
        comparison: { kind: 'proposal-generation', generationId },
      })
      const diff = yield* service.architectureImpact(authority, {
        comparison: { kind: 'diff-analysis', diffAnalysisId },
      })

      expect(proposal).toMatchObject({
        version: 2,
        comparison: { kind: 'proposal-generation', generationId },
        changed: true,
        addedNodes: { items: ['src/added.ts'], total: 1, omitted: 0 },
        baseSource: {
          kind: 'proposal-generation',
          threadId,
          generationId,
          side: 'base',
        },
        headSource: {
          kind: 'proposal-generation',
          threadId,
          generationId,
          side: 'proposed',
        },
      })
      expect(diff).toMatchObject({
        version: 2,
        comparison: { kind: 'diff-analysis', diffAnalysisId },
        changed: true,
        baseSource: { kind: 'diff-analysis', threadId, diffAnalysisId, side: 'base' },
        headSource: { kind: 'diff-analysis', threadId, diffAnalysisId, side: 'head' },
      })
      expect({ graphLoads, proposalReads, diffRetained, diffReleased }).toEqual({
        graphLoads: 0,
        proposalReads: 1,
        diffRetained: 1,
        diffReleased: 1,
      })
    }),
  )

  it.effect('falls back to paired graph reads only for a legacy sealed impact', () =>
    Effect.gen(function* ()
    {
      const root = yield* Effect.promise(() => makeTemporaryRoot('456code-legacy-impact-'))
      const generationId = ProposalGenerationId.make('generation-legacy-impact')
      const baseGraphPath = yield* Effect.promise(() =>
        writeGraph(root, graph(['src/base.ts']), 'legacy-base.graph.json'),
      )
      const headGraphPath = yield* Effect.promise(() =>
        writeGraph(root, graph(['src/base.ts', 'src/added.ts']), 'legacy-head.graph.json'),
      )
      let graphLoads = 0
      const service = yield* make({
        loadGraph: (path) =>
        {
          graphLoads += 1
          return loadContextQuery(path)
        },
      }).pipe(
        Effect.provide(
          dependencyLayer({
            root,
            proposals: {
              get: () => Effect.succeed(proposalGeneration(generationId)),
              resolveArchitectureTarget: () =>
                Effect.succeed({
                  generation: proposalGeneration(generationId),
                  proposedRoot: root,
                  baseGraphPath,
                  proposedGraphPath: headGraphPath,
                  impactPath: headGraphPath,
                }),
              resolveImpactTarget: () =>
                Effect.succeed({
                  diff: null,
                  impactDigest: `sha256:${'3'.repeat(64)}`,
                  legacy: true,
                  repositoryRoot: root,
                  baseTreeOid: 'a'.repeat(40),
                  proposedTreeOid: 'b'.repeat(40),
                  baseGraphDigest: `sha256:${'4'.repeat(64)}`,
                  proposedGraphDigest: `sha256:${'5'.repeat(64)}`,
                }),
            },
          }),
        ),
      )

      const result = yield* service.architectureImpact(authority, {
        comparison: { kind: 'proposal-generation', generationId },
      })

      expect(result).toMatchObject({
        version: 2,
        comparison: { kind: 'proposal-generation', generationId },
        changed: true,
        addedNodes: { items: ['src/added.ts'], total: 1, omitted: 0 },
      })
      expect(graphLoads).toBe(2)
    }),
  )

  it.effect('accepts all-skipped patches and returns exact byte and graph limit details', () =>
    Effect.gen(function* ()
    {
      const root = yield* Effect.promise(() => makeTemporaryRoot('456code-architecture-patch-'))
      const graphPath = yield* Effect.promise(() => writeGraph(root, graph(['src/existing.ts'])))
      yield* Effect.sync(() =>
      {
        NodeChildProcess.execFileSync('git', ['init', '--quiet'], { cwd: root })
        NodeChildProcess.execFileSync('git', ['add', '.'], { cwd: root })
        NodeChildProcess.execFileSync(
          'git',
          [
            '-c',
            'user.name=456code Test',
            '-c',
            'user.email=456code@example.invalid',
            'commit',
            '--quiet',
            '-m',
            'fixture',
          ],
          { cwd: root },
        )
      })
      const layer = dependencyLayer({
        root,
        currentWorktree: {
          retainThreadTarget: () =>
            Effect.succeed({
              sourceKind: 'current-worktree',
              root,
              outDir: root,
              graphPath,
              liveRoot: root,
            }),
        },
      })
      const service = yield* make().pipe(Effect.provide(layer))
      const allSkipped = yield* service.proposePatch(authority, {
        context: { kind: 'current-thread-worktree' },
        ops: [{ op: 'remove_file', path: 'src/missing.ts' }],
      })
      expect(allSkipped).toMatchObject({
        version: 1,
        issueTotals: { errors: 1, warnings: 0 },
        issues: { total: 1, omitted: 0 },
        diff: { changed: false, apiChanges: { items: [], total: 0, omitted: 0 } },
        staleness: {
          stale: true,
          reasons: ['ref-mismatch'],
          graph: { gitRef: 'a'.repeat(40) },
          workingTree: { dirty: false },
        },
      })

      const oversized = Array.from({ length: 600 }, (_, index) => ({
        op: 'add_file' as const,
        path: `src/generated-${index}.ts`,
        description: 'x'.repeat(2_000),
      }))
      const byteError = yield* service
        .proposePatch(authority, {
          context: { kind: 'current-thread-worktree' },
          ops: oversized,
        })
        .pipe(Effect.flip)
      expect(byteError).toMatchObject({
        code: 'limit-exceeded',
        limit: {
          kind: 'bytes',
          scope: 'patch',
          limit: 1_048_576,
        },
      })
      expect(byteError.limit?.actual).toBeGreaterThan(1_048_576)

      const largeGraph = graph(Array.from({ length: 50_001 }, (_, index) => `src/node-${index}.ts`))
      const largeContext: ContextQueryGraph = {
        graph: largeGraph,
        relations: createGraphRelationIndex(largeGraph),
      }
      const graphLimited = yield* make({ loadGraph: () => largeContext }).pipe(
        Effect.provide(layer),
      )
      const nodeError = yield* graphLimited
        .proposePatch(authority, {
          context: { kind: 'current-thread-worktree' },
          ops: [{ op: 'remove_file', path: 'src/missing.ts' }],
        })
        .pipe(Effect.flip)
      expect(nodeError).toMatchObject({
        code: 'limit-exceeded',
        limit: {
          kind: 'nodes',
          scope: 'base',
          actual: 50_001,
          limit: 50_000,
        },
      })

      let inactiveContextReads = 0
      const inactive = yield* make().pipe(
        Effect.provide(
          dependencyLayer({
            root,
            currentWorktree: {
              retainThreadTarget: () =>
                Effect.sync(() =>
                {
                  inactiveContextReads += 1
                  return {
                    sourceKind: 'current-worktree' as const,
                    root,
                    outDir: root,
                    graphPath,
                    liveRoot: root,
                  }
                }),
            },
          }),
        ),
      )
      const inactiveError = yield* inactive
        .proposePatch(
          { ...authority, activeTurnId: TurnId.make('different-active-turn') },
          {
            context: { kind: 'current-thread-worktree' },
            ops: [{ op: 'remove_file', path: 'src/missing.ts' }],
          },
        )
        .pipe(Effect.flip)
      expect(inactiveError.code).toBe('identity-mismatch')
      expect(inactiveContextReads).toBe(0)
    }),
  )
})
