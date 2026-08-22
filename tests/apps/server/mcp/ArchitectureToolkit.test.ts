// tests/apps/server/mcp/ArchitectureToolkit.test.ts
// verifies architecture MCP registration, authorization, and typed result delivery

import { expect, it } from '@effect/vitest'
import {
  ArchitectureToolError,
  DiffAnalysisId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ArchitectureBlastRadiusInput,
  type ArchitectureBlastRadiusResult,
  type ArchitectureGraphDiffInput,
  type ArchitectureGraphDiffResult,
  type ArchitectureProposePatchInput,
  type ArchitectureProposePatchResult,
} from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import { McpSchema, McpServer } from 'effect/unstable/ai'

import * as ArchitectureQueryService from '../../../../apps/server/src/cartographer/ArchitectureQueryService.ts'
import * as PlannedImpactService from '../../../../apps/server/src/architecture/PlannedImpactService.ts'
import * as McpHttpServer from '../../../../apps/server/src/mcp/McpHttpServer.ts'
import * as McpInvocationContext from '../../../../apps/server/src/mcp/McpInvocationContext.ts'
import { architectureToolkitHandlers } from '../../../../apps/server/src/mcp/toolkits/architecture/handlers.ts'
import * as ProjectionSnapshotQuery from '../../../../apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts'
import { SqlitePersistenceMemory } from '../../../../apps/server/src/persistence/Layers/Sqlite.ts'

const environmentId = EnvironmentId.make('environment-architecture-mcp')
const projectId = ProjectId.make('project-architecture-mcp')
const threadId = ThreadId.make('thread-architecture-mcp')
const providerInstanceId = ProviderInstanceId.make('codex')
const turnId = TurnId.make('turn-architecture-mcp')
const diffAnalysisId = DiffAnalysisId.make('diff-analysis-architecture-mcp')
const generatedAt = '2026-08-07T12:00:00.000Z'

const emptyBoundedList = <T>() => ({ items: [] as ReadonlyArray<T>, total: 0, omitted: 0 })

const blastInput: ArchitectureBlastRadiusInput = {
  context: { kind: 'standing-project' },
  target: 'src/entry.ts',
}

const graphDiffInput: ArchitectureGraphDiffInput = {
  comparison: { kind: 'diff-analysis', diffAnalysisId },
}

const proposePatchInput: ArchitectureProposePatchInput = {
  context: { kind: 'current-thread-worktree' },
  ops: [{ op: 'remove_file', path: 'src/old.ts' }],
}

const blastResult: ArchitectureBlastRadiusResult = {
  version: 1,
  graph: { generatedAt },
  target: 'src/entry.ts',
  precision: 'file',
  direction: 'both',
  maxDepth: 4,
  upstream: emptyBoundedList<string>(),
  downstream: emptyBoundedList<string>(),
  impactedFileCount: 0,
}

const graphDiffResult: ArchitectureGraphDiffResult = {
  version: 1,
  summary: 'No architecture changes.',
  base: { generatedAt },
  head: { generatedAt },
  changed: false,
  addedNodes: emptyBoundedList<string>(),
  removedNodes: emptyBoundedList<string>(),
  addedEdges: emptyBoundedList(),
  removedEdges: emptyBoundedList(),
  movedNodes: emptyBoundedList(),
  moveFlows: emptyBoundedList(),
  movedEdges: 0,
  apiChanges: emptyBoundedList(),
  apiTotals: {
    files: 0,
    addedExports: 0,
    removedExports: 0,
    brokenConsumers: 0,
  },
  newViolations: emptyBoundedList(),
  resolvedViolations: emptyBoundedList(),
}

const proposePatchResult: ArchitectureProposePatchResult = {
  version: 1,
  summary: 'No structural changes.',
  issues: emptyBoundedList(),
  issueTotals: { errors: 0, warnings: 0 },
  validation: {
    cycles: emptyBoundedList(),
    newBoundaries: emptyBoundedList(),
    orphans: emptyBoundedList(),
  },
  diff: graphDiffResult,
  staleness: {
    stale: false,
    reasons: [],
    graph: { generatedAt },
  },
}

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  initializePayload: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'architecture-mcp-test', version: '1.0.0' },
  },
  getClient: Effect.die('unused'),
})

function invocation(
  capabilities: ReadonlySet<McpInvocationContext.McpCapability>,
  activeTurnId?: TurnId,
): McpInvocationContext.McpInvocationScope
{
  return {
    environmentId,
    threadId,
    providerSessionId: 'provider-session-architecture-mcp',
    providerInstanceId,
    ...(activeTurnId === undefined ? {} : { activeTurnId }),
    capabilities,
    issuedAt: 1,
  }
}

function makeService(
  overrides: Partial<ArchitectureQueryService.ArchitectureQueryServiceShape> = {},
): ArchitectureQueryService.ArchitectureQueryServiceShape
{
  return ArchitectureQueryService.ArchitectureQueryService.of({
    resolveContext: () => Effect.die('unused'),
    blastRadius: () => Effect.succeed(blastResult),
    graphDiff: () => Effect.succeed(graphDiffResult),
    architectureImpactProjection: () => Effect.die('unused'),
    proposePatch: () => Effect.succeed(proposePatchResult),
    ...overrides,
  })
}

function registrationLayer(service: ArchitectureQueryService.ArchitectureQueryServiceShape)
{
  const snapshots = {
    getThreadDetailById: (requestedThreadId: ThreadId) =>
      Effect.succeed(
        requestedThreadId === threadId
          ? Option.some({
              id: threadId,
              projectId,
              worktreePath: '/derived/architecture-worktree',
              interactionMode: 'plan',
              session: { status: 'running', activeTurnId: turnId },
              latestTurn: {
                turnId,
                state: 'running',
                requestedAt: generatedAt,
                startedAt: generatedAt,
                completedAt: null,
                assistantMessageId: null,
              },
              orchestratePlans: [],
            })
          : Option.none(),
      ),
    getProjectShellById: (requestedProjectId: ProjectId) =>
      Effect.succeed(
        requestedProjectId === projectId
          ? Option.some({ id: projectId, workspaceRoot: '/derived/architecture-project' })
          : Option.none(),
      ),
  } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery['Service']
  const plannedImpacts = PlannedImpactService.layer.pipe(Layer.provide(SqlitePersistenceMemory))
  return McpHttpServer.ArchitectureToolkitRegistrationLive.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(Layer.succeed(ArchitectureQueryService.ArchitectureQueryService, service)),
    Layer.provide(Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, snapshots)),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provide(plannedImpacts),
  )
}

it.effect('registers the four closed-world architecture tools with exact safety hints', () =>
{
  const service = makeService()
  return Effect.gen(function* ()
  {
    const server = yield* McpServer.McpServer
    expect(server.tools.map(({ tool }) => tool.name).sort()).toEqual([
      'architecture_blast_radius',
      'architecture_graph_diff',
      'architecture_plan_impact_upsert',
      'architecture_propose_patch',
    ])

    for (const name of ['architecture_blast_radius', 'architecture_graph_diff'])
    {
      const annotations = server.tools.find(({ tool }) => tool.name === name)?.tool.annotations
      expect(annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      })
    }

    const proposeAnnotations = server.tools.find(
      ({ tool }) => tool.name === 'architecture_propose_patch',
    )?.tool.annotations
    expect(proposeAnnotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    })
    const plannedAnnotations = server.tools.find(
      ({ tool }) => tool.name === 'architecture_plan_impact_upsert',
    )?.tool.annotations
    expect(plannedAnnotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    })
  }).pipe(Effect.provide(registrationLayer(service)))
})

it.effect('allows idle-session read tools and delegates only authenticated authority', () =>
{
  const calls: Array<{
    readonly operation: 'blastRadius' | 'graphDiff'
    readonly authority: ArchitectureQueryService.ArchitectureQueryAuthority
    readonly input: ArchitectureBlastRadiusInput | ArchitectureGraphDiffInput
  }> = []
  const service = makeService({
    blastRadius: (authority, input) =>
      Effect.sync(() =>
      {
        calls.push({ operation: 'blastRadius', authority, input })
        return blastResult
      }),
    graphDiff: (authority, input) =>
      Effect.sync(() =>
      {
        calls.push({ operation: 'graphDiff', authority, input })
        return graphDiffResult
      }),
  })

  return Effect.gen(function* ()
  {
    const server = yield* McpServer.McpServer
    const scope = invocation(new Set(['architecture']))
    const authority = { environmentId, threadId }
    const blast = yield* server
      .callTool({ name: 'architecture_blast_radius', arguments: blastInput })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      )
    const diff = yield* server
      .callTool({ name: 'architecture_graph_diff', arguments: graphDiffInput })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      )
    const activeBlast = yield* server
      .callTool({ name: 'architecture_blast_radius', arguments: blastInput })
      .pipe(
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          invocation(new Set(['architecture']), turnId),
        ),
        Effect.provideService(McpSchema.McpServerClient, client),
      )

    expect(blast.isError).toBe(false)
    expect(blast.structuredContent).toEqual(blastResult)
    expect(diff.isError).toBe(false)
    expect(diff.structuredContent).toEqual(graphDiffResult)
    expect(activeBlast.isError).toBe(false)
    expect(calls).toEqual([
      {
        operation: 'blastRadius',
        authority,
        input: blastInput,
      },
      {
        operation: 'graphDiff',
        authority,
        input: graphDiffInput,
      },
      {
        operation: 'blastRadius',
        authority,
        input: blastInput,
      },
    ])
    for (const call of calls)
    {
      expect(call.authority).not.toHaveProperty('activeTurnId')
    }
  }).pipe(Effect.provide(registrationLayer(service)))
})

it.effect('returns a typed architecture error before service access without capability', () =>
{
  let calls = 0
  const service = makeService({
    blastRadius: () =>
      Effect.sync(() =>
      {
        calls += 1
        return blastResult
      }),
  })

  return Effect.gen(function* ()
  {
    const server = yield* McpServer.McpServer
    const result = yield* server
      .callTool({ name: 'architecture_blast_radius', arguments: blastInput })
      .pipe(
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          invocation(new Set(['preview'])),
        ),
        Effect.provideService(McpSchema.McpServerClient, client),
      )

    expect(result).toMatchObject({
      isError: true,
      content: [
        {
          type: 'text',
          text: 'Architecture tool failed. See structuredContent.error for details.',
        },
      ],
      structuredContent: {
        error: {
          _tag: 'ArchitectureToolError',
          operation: 'architecture_blast_radius',
          code: 'capability-unavailable',
          detail: 'The authenticated MCP session does not grant the architecture capability.',
        },
      },
    })
    expect(calls).toBe(0)
  }).pipe(Effect.provide(registrationLayer(service)))
})

it.effect(
  'strictly admits Planned Impact only with both capabilities and active Plan authority',
  () =>
  {
    const service = makeService()
    const arguments_ = {
      version: 1,
      summary: 'The proposal remains inside the existing implementation unit.',
      outcome: 'no-impact',
      changedObjects: [],
      relationships: [],
      pathHints: ['src/internal.ts'],
      omissions: {
        changedObjects: { total: 0, omitted: 0 },
        relationships: { total: 0, omitted: 0 },
        pathHints: { total: 1, omitted: 0 },
      },
    } as const

    return Effect.gen(function* ()
    {
      const server = yield* McpServer.McpServer
      const sql = yield* SqlClient.SqlClient
      const authorized = invocation(new Set(['architecture', 'proposal']), turnId)
      const result = yield* server
        .callTool({ name: 'architecture_plan_impact_upsert', arguments: arguments_ })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, authorized),
          Effect.provideService(McpSchema.McpServerClient, client),
        )
      expect(result).toMatchObject({
        isError: false,
        structuredContent: {
          version: 1,
          publication: { publicationRevision: 1 },
          projection: { projectionRevision: 1, materialization: 'no-impact' },
          anchoring: 'not-required',
        },
      })

      const spoofed = yield* server
        .callTool({
          name: 'architecture_plan_impact_upsert',
          arguments: { ...arguments_, root: '/attacker/root' },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, authorized),
          Effect.provideService(McpSchema.McpServerClient, client),
        )
      expect(spoofed).toMatchObject({
        isError: true,
        structuredContent: {
          error: { code: 'invalid-publication' },
        },
      })

      for (const capabilities of [new Set(['architecture']), new Set(['proposal'])])
      {
        const denied = yield* server
          .callTool({ name: 'architecture_plan_impact_upsert', arguments: arguments_ })
          .pipe(
            Effect.provideService(
              McpInvocationContext.McpInvocationContext,
              invocation(capabilities as ReadonlySet<McpInvocationContext.McpCapability>, turnId),
            ),
            Effect.provideService(McpSchema.McpServerClient, client),
          )
        expect(denied).toMatchObject({
          isError: true,
          structuredContent: { error: { code: 'capability-unavailable' } },
        })
      }

      const rows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM architecture_planned_impact_publications
    `
      expect(rows).toEqual([{ count: 1 }])
    }).pipe(Effect.provide(registrationLayer(service)))
  },
)

it.effect('preserves recovery and limit details in registered MCP failures', () =>
{
  const service = makeService({
    blastRadius: () =>
      Effect.fail(
        new ArchitectureToolError({
          operation: 'architecture_blast_radius',
          code: 'context-not-ready',
          detail: 'The standing project graph is not ready.',
          recovery: 'build_project_atlas',
        }),
      ),
    proposePatch: () =>
      Effect.fail(
        new ArchitectureToolError({
          operation: 'architecture_propose_patch',
          code: 'limit-exceeded',
          detail: 'The patch exceeds the evaluation work limit.',
          limit: {
            kind: 'work',
            scope: 'evaluation',
            actual: 2_001,
            limit: 2_000,
          },
        }),
      ),
  })

  return Effect.gen(function* ()
  {
    const server = yield* McpServer.McpServer
    const recovery = yield* server
      .callTool({ name: 'architecture_blast_radius', arguments: blastInput })
      .pipe(
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          invocation(new Set(['architecture'])),
        ),
        Effect.provideService(McpSchema.McpServerClient, client),
      )
    const limit = yield* server
      .callTool({ name: 'architecture_propose_patch', arguments: proposePatchInput })
      .pipe(
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          invocation(new Set(['architecture']), turnId),
        ),
        Effect.provideService(McpSchema.McpServerClient, client),
      )

    expect(recovery.isError).toBe(true)
    expect(recovery.structuredContent).toEqual({
      error: {
        _tag: 'ArchitectureToolError',
        operation: 'architecture_blast_radius',
        code: 'context-not-ready',
        detail: 'The standing project graph is not ready.',
        recovery: 'build_project_atlas',
      },
    })
    expect(limit.isError).toBe(true)
    expect(limit.structuredContent).toEqual({
      error: {
        _tag: 'ArchitectureToolError',
        operation: 'architecture_propose_patch',
        code: 'limit-exceeded',
        detail: 'The patch exceeds the evaluation work limit.',
        limit: {
          kind: 'work',
          scope: 'evaluation',
          actual: 2_001,
          limit: 2_000,
        },
      },
    })
  }).pipe(Effect.provide(registrationLayer(service)))
})

it.effect('delegates active-turn enforcement for patch proposals to the query service', () =>
{
  const calls: Array<{
    readonly authority: ArchitectureQueryService.ArchitectureQueryAuthority
    readonly input: ArchitectureProposePatchInput
  }> = []
  const service = makeService({
    proposePatch: (authority, input) =>
      Effect.gen(function* ()
      {
        calls.push({ authority, input })
        if (authority.activeTurnId === undefined)
        {
          return yield* new ArchitectureToolError({
            operation: 'architecture_propose_patch',
            code: 'identity-mismatch',
            detail: 'Query service rejected an invocation without its exact active turn.',
          })
        }
        return proposePatchResult
      }),
  })

  return Effect.gen(function* ()
  {
    const idleError = yield* architectureToolkitHandlers
      .architecture_propose_patch(proposePatchInput)
      .pipe(
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          invocation(new Set(['architecture'])),
        ),
        Effect.provideService(ArchitectureQueryService.ArchitectureQueryService, service),
        Effect.flip,
      )
    const activeScope = invocation(new Set(['architecture']), turnId)
    const activeResult = yield* architectureToolkitHandlers
      .architecture_propose_patch(proposePatchInput)
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, activeScope),
        Effect.provideService(ArchitectureQueryService.ArchitectureQueryService, service),
      )

    expect(idleError).toMatchObject({
      operation: 'architecture_propose_patch',
      code: 'identity-mismatch',
      detail: 'Query service rejected an invocation without its exact active turn.',
    })
    expect(activeResult).toEqual(proposePatchResult)
    expect(calls).toEqual([
      { authority: { environmentId, threadId }, input: proposePatchInput },
      { authority: { environmentId, threadId, activeTurnId: turnId }, input: proposePatchInput },
    ])
  })
})
