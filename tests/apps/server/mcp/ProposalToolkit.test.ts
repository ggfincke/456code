// tests/apps/server/mcp/ProposalToolkit.test.ts
// verifies proposal MCP authority derivation and safe narrative handling

import { expect, it } from '@effect/vitest'
import {
  EnvironmentId,
  ProjectId,
  PROPOSAL_SNAPSHOT_POLICY_V1,
  ProposalId,
  ProposalRevisionId,
  type OrchestratePlanRevision,
  type ProviderInteractionMode,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import { McpSchema, McpServer } from 'effect/unstable/ai'

import * as McpHttpServer from '../../../../apps/server/src/mcp/McpHttpServer.ts'
import * as McpInvocationContext from '../../../../apps/server/src/mcp/McpInvocationContext.ts'
import { proposalToolkitHandlers } from '../../../../apps/server/src/mcp/toolkits/proposal/handlers.ts'
import * as ProjectionSnapshotQuery from '../../../../apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts'
import * as ProposalService from '../../../../apps/server/src/proposal/ProposalService.ts'

const environmentId = EnvironmentId.make('environment-proposal-mcp')
const projectId = ProjectId.make('project-proposal-mcp')
const threadId = ThreadId.make('thread-proposal-mcp')
const proposalId = ProposalId.make('proposal-mcp')
const revisionId = ProposalRevisionId.make('revision-mcp')
const providerInstanceId = ProviderInstanceId.make('codex')
const turnId = TurnId.make('turn-proposal-mcp')
const sha256 = 'a'.repeat(64)
const gitOid = 'b'.repeat(40)
const createdAt = '2026-07-27T12:00:00.000Z'

const revision = {
  proposalId,
  revisionId,
  revision: 1,
  baseSnapshot: {
    headCommitOid: gitOid,
    workingTreeOid: gitOid,
    retainedRef: 'refs/t3/proposals/proposal-mcp/revisions/1/base',
    fileCount: 1,
    byteCount: 1,
    policy: PROPOSAL_SNAPSHOT_POLICY_V1,
  },
  proposedTreeOid: gitOid,
  proposedRetainedRef: 'refs/t3/proposals/proposal-mcp/revisions/1/proposed',
  manifest: {
    version: 'v1',
    operations: [
      {
        _tag: 'add',
        path: 'src/proposed.ts',
        after: {
          sha256,
          byteLength: 1,
          gitBlobOid: gitOid,
          mode: '100644',
        },
      },
    ],
    operationCount: 1,
    changedFileCount: 1,
    changedContentBytes: 1,
  },
  manifestSha256: sha256,
  diffSha256: sha256,
  diffByteLength: 1,
  createdAt,
} as const

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  initializePayload: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'proposal-mcp-test', version: '1.0.0' },
  },
  getClient: Effect.die('unused'),
})

function makeLayer(
  captured: Array<ProposalService.ProposalUpsertRequest>,
  options: {
    readonly proposedPlanTurnId?: TurnId | null
    readonly interactionMode?: ProviderInteractionMode
    readonly orchestrate?: boolean
    readonly orchestratePlans?: ReadonlyArray<OrchestratePlanRevision>
  } = {},
): Layer.Layer<
  | McpServer.McpServer
  | ProposalService.ProposalService
  | ProjectionSnapshotQuery.ProjectionSnapshotQuery
>
{
  const proposals = ProposalService.ProposalService.of({
    upsert: (input) =>
      Effect.sync(() =>
      {
        captured.push(input)
        return revision
      }),
    list: () => Effect.succeed({ proposals: [] }),
    get: () => Effect.die('unused'),
    diff: () => Effect.die('unused'),
    narrative: () => Effect.succeed(null),
    findLatestByPlan: () => Effect.succeed(null),
    findByOrchestrateRevision: () => Effect.succeed(null),
  })
  const proposedPlanTurnId =
    options.proposedPlanTurnId === undefined ? turnId : options.proposedPlanTurnId
  const snapshots = {
    getThreadDetailById: (requestedThreadId: ThreadId) =>
      Effect.succeed(
        requestedThreadId === threadId
          ? Option.some({
              id: threadId,
              projectId,
              worktreePath: '/derived/worktree',
              interactionMode: options.interactionMode ?? 'plan',
              ...(options.orchestrate !== undefined ? { orchestrate: options.orchestrate } : {}),
              session: {
                status: 'running',
                activeTurnId: turnId,
              },
              latestTurn: {
                turnId,
                state: 'running',
                requestedAt: createdAt,
                startedAt: createdAt,
                completedAt: null,
                assistantMessageId: null,
              },
              proposedPlans:
                proposedPlanTurnId === null
                  ? []
                  : [
                      {
                        id: `plan:${threadId}:turn:${proposedPlanTurnId}`,
                        turnId: proposedPlanTurnId,
                        planMarkdown: '# Persisted plan',
                        implementedAt: null,
                        implementationThreadId: null,
                        createdAt,
                        updatedAt: createdAt,
                      },
                    ],
              orchestratePlans: options.orchestratePlans ?? [],
            })
          : Option.none(),
      ),
    getProjectShellById: (requestedProjectId: ProjectId) =>
      Effect.succeed(
        requestedProjectId === projectId
          ? Option.some({
              id: projectId,
              workspaceRoot: '/derived/project',
            })
          : Option.none(),
      ),
  } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery['Service']

  return McpHttpServer.ProposalToolkitRegistrationLive.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(Layer.succeed(ProposalService.ProposalService, proposals)),
    Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, snapshots)),
  )
}

function invocation(
  capabilities: ReadonlySet<McpInvocationContext.McpCapability>,
  activeTurnId: TurnId | null = turnId,
)
{
  return McpInvocationContext.McpInvocationContext.of({
    environmentId,
    threadId,
    providerSessionId: 'provider-session-proposal-mcp',
    providerInstanceId,
    ...(activeTurnId === null ? {} : { activeTurnId }),
    capabilities,
    issuedAt: 1,
  })
}

it.effect('derives every authority field and never executes authored narrative code', () =>
{
  const captured: Array<ProposalService.ProposalUpsertRequest> = []
  return Effect.gen(function* ()
  {
    const server = yield* McpServer.McpServer
    Reflect.set(globalThis, '__proposalMcpExecuted', false)

    const result = yield* server
      .callTool({
        name: 'proposal_preview_upsert',
        arguments: {
          proposalId,
          changes: {
            _tag: 'typed',
            operations: [
              {
                _tag: 'add',
                path: 'src/proposed.ts',
                content: { encoding: 'utf8', data: 'x' },
              },
            ],
          },
          narrativeMdx: '{globalThis.__proposalMcpExecuted = true}',
          planMarkdownSha256: 'c'.repeat(64),
          planId: 'attacker-plan',
          environmentId: 'attacker-environment',
          projectId: 'attacker-project',
          sourceThreadId: 'attacker-thread',
          providerSessionId: 'attacker-session',
          providerInstanceId: 'attacker-provider',
          cwd: '/attacker/root',
        },
      })
      .pipe(
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          invocation(new Set(['proposal'])),
        ),
        Effect.provideService(McpSchema.McpServerClient, client),
      )

    expect(result.isError).toBe(false)
    expect(Reflect.get(globalThis, '__proposalMcpExecuted')).toBe(false)
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({
      proposalId,
      environmentId,
      projectId,
      sourceThreadId: threadId,
      cwd: '/derived/worktree',
      planId: `plan:${threadId}:turn:${turnId}`,
      producer: {
        providerSessionId: 'provider-session-proposal-mcp',
        providerInstanceId,
      },
    })
    expect(captured[0]).not.toHaveProperty('root')
    expect(captured[0]).not.toHaveProperty('planMarkdownSha256')
    Reflect.deleteProperty(globalThis, '__proposalMcpExecuted')
  }).pipe(Effect.provide(makeLayer(captured)))
})

it.effect('requires the separate proposal capability before persistence', () =>
{
  const captured: Array<ProposalService.ProposalUpsertRequest> = []
  return Effect.gen(function* ()
  {
    const server = yield* McpServer.McpServer
    const result = yield* server
      .callTool({
        name: 'proposal_preview_upsert',
        arguments: {
          changes: {
            _tag: 'typed',
            operations: [
              {
                _tag: 'add',
                path: 'src/proposed.ts',
                content: { encoding: 'utf8', data: 'x' },
              },
            ],
          },
        },
      })
      .pipe(
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          invocation(new Set(['preview'])),
        ),
        Effect.provideService(McpSchema.McpServerClient, client),
      )

    expect(result.isError).toBe(true)
    expect(captured).toHaveLength(0)
  }).pipe(Effect.provide(makeLayer(captured)))
})

it.effect('rejects a proposal call when the credential is not bound to a turn', () =>
{
  const captured: Array<ProposalService.ProposalUpsertRequest> = []
  return Effect.gen(function* ()
  {
    const server = yield* McpServer.McpServer
    const result = yield* server
      .callTool({
        name: 'proposal_preview_upsert',
        arguments: {
          changes: {
            _tag: 'typed',
            operations: [
              {
                _tag: 'add',
                path: 'src/proposed.ts',
                content: { encoding: 'utf8', data: 'x' },
              },
            ],
          },
        },
      })
      .pipe(
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          invocation(new Set(['proposal']), null),
        ),
        Effect.provideService(McpSchema.McpServerClient, client),
      )

    expect(result.isError).toBe(true)
    expect(captured).toHaveLength(0)
  }).pipe(Effect.provide(makeLayer(captured)))
})

it.effect('accepts an active plan-mode turn before its proposed plan row is persisted', () =>
{
  const captured: Array<ProposalService.ProposalUpsertRequest> = []
  return Effect.gen(function* ()
  {
    const server = yield* McpServer.McpServer
    const result = yield* server
      .callTool({
        name: 'proposal_preview_upsert',
        arguments: {
          changes: {
            _tag: 'typed',
            operations: [
              {
                _tag: 'add',
                path: 'src/proposed.ts',
                content: { encoding: 'utf8', data: 'x' },
              },
            ],
          },
        },
      })
      .pipe(
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          invocation(new Set(['proposal'])),
        ),
        Effect.provideService(McpSchema.McpServerClient, client),
      )

    expect(result.isError).toBe(false)
    expect(captured).toHaveLength(1)
    expect(captured[0]?.planId).toBe(`plan:${threadId}:turn:${turnId}`)
  }).pipe(Effect.provide(makeLayer(captured, { proposedPlanTurnId: null, orchestrate: true })))
})

it.effect('rejects an orchestrate target supplied from a plan-mode turn', () =>
{
  const captured: Array<ProposalService.ProposalUpsertRequest> = []
  return Effect.gen(function* ()
  {
    const failure = yield* proposalToolkitHandlers
      .proposal_preview_upsert({
        changes: {
          _tag: 'typed',
          operations: [
            {
              _tag: 'add',
              path: 'src/proposed.ts',
              content: { encoding: 'utf8', data: 'x' },
            },
          ],
        },
        orchestratePlan: { runId: 'run-plan-mode', revision: 1 },
      })
      .pipe(
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          invocation(new Set(['proposal'])),
        ),
        Effect.flip,
        Effect.orDie,
      )

    expect(failure).toMatchObject({ _tag: 'ProposalError', code: 'identity-mismatch' })
    expect(captured).toHaveLength(0)
  }).pipe(Effect.provide(makeLayer(captured)))
})

it.effect('binds only an exact tool-sourced orchestrate revision from the active turn', () =>
{
  const captured: Array<ProposalService.ProposalUpsertRequest> = []
  const orchestratePlans = [
    {
      runId: 'run-wrong-turn',
      revision: 2,
      turnId: TurnId.make('turn-other'),
      workflow: 'implementation',
      task: 'wrong turn',
      stages: [],
      totalWorkers: 0,
      maxWorkers: 1,
      leadModelSelection: null,
      source: 'tool',
      status: 'pending',
      createdAt,
      updatedAt: createdAt,
    },
    {
      runId: 'run-fence',
      revision: 3,
      turnId,
      workflow: 'implementation',
      task: 'fence sourced',
      stages: [],
      totalWorkers: 0,
      maxWorkers: 1,
      leadModelSelection: null,
      source: 'fence',
      status: 'pending',
      createdAt,
      updatedAt: createdAt,
    },
    {
      runId: 'run-exact',
      revision: 4,
      turnId,
      workflow: 'implementation',
      task: 'exact target',
      stages: [],
      totalWorkers: 0,
      maxWorkers: 1,
      leadModelSelection: null,
      source: 'tool',
      status: 'superseded',
      createdAt,
      updatedAt: createdAt,
    },
  ] as const satisfies ReadonlyArray<OrchestratePlanRevision>

  return Effect.gen(function* ()
  {
    const call = (orchestratePlan?: { readonly runId: string; readonly revision: number }) =>
      proposalToolkitHandlers
        .proposal_preview_upsert({
          changes: {
            _tag: 'typed',
            operations: [
              {
                _tag: 'add',
                path: 'src/proposed.ts',
                content: { encoding: 'utf8', data: 'x' },
              },
            ],
          },
          ...(orchestratePlan === undefined ? {} : { orchestratePlan }),
        })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(new Set(['proposal'])),
          ),
        )

    expect(yield* call().pipe(Effect.flip, Effect.orDie)).toMatchObject({
      _tag: 'ProposalError',
      code: 'identity-mismatch',
    })
    expect(
      yield* call({ runId: 'run-missing', revision: 1 }).pipe(Effect.flip, Effect.orDie),
    ).toMatchObject({ _tag: 'ProposalError', code: 'not-found' })
    expect(
      yield* call({ runId: 'run-wrong-turn', revision: 2 }).pipe(Effect.flip, Effect.orDie),
    ).toMatchObject({ _tag: 'ProposalError', code: 'identity-mismatch' })
    expect(
      yield* call({ runId: 'run-fence', revision: 3 }).pipe(Effect.flip, Effect.orDie),
    ).toMatchObject({ _tag: 'ProposalError', code: 'identity-mismatch' })
    expect(yield* call({ runId: 'run-exact', revision: 4 })).toEqual(revision)
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({
      orchestratePlan: {
        runId: 'run-exact',
        revision: 4,
        turnId,
      },
    })
    expect(captured[0]).not.toHaveProperty('planId')
  }).pipe(
    Effect.provide(
      makeLayer(captured, {
        proposedPlanTurnId: null,
        interactionMode: 'orchestrate',
        orchestratePlans,
      }),
    ),
  )
})

it.effect('rejects proposal persistence from an active default-mode turn', () =>
{
  const captured: Array<ProposalService.ProposalUpsertRequest> = []
  return Effect.gen(function* ()
  {
    const failure = yield* proposalToolkitHandlers
      .proposal_preview_upsert({
        changes: {
          _tag: 'typed',
          operations: [
            {
              _tag: 'add',
              path: 'src/proposed.ts',
              content: { encoding: 'utf8', data: 'x' },
            },
          ],
        },
      })
      .pipe(
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          invocation(new Set(['proposal'])),
        ),
        Effect.flip,
        Effect.orDie,
      )

    expect(failure).toMatchObject({ _tag: 'ProposalError', code: 'identity-mismatch' })
    expect(captured).toHaveLength(0)
  }).pipe(
    Effect.provide(
      makeLayer(captured, {
        proposedPlanTurnId: null,
        interactionMode: 'default',
      }),
    ),
  )
})
