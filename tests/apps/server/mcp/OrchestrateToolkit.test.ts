// tests/apps/server/mcp/OrchestrateToolkit.test.ts
// verifies orchestrate MCP revision derivation and committed readback

import { expect, it } from '@effect/vitest'
import {
  EnvironmentId,
  EventId,
  type OrchestratePlanRevision,
  type OrchestrateRunExecution,
  type OrchestrationCommand,
  type OrchestrationEvent,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from '@t3tools/contracts'
import * as Crypto from 'effect/Crypto'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Stream from 'effect/Stream'
import { McpSchema, McpServer } from 'effect/unstable/ai'

import * as McpHttpServer from '../../../../apps/server/src/mcp/McpHttpServer.ts'
import * as McpInvocationContext from '../../../../apps/server/src/mcp/McpInvocationContext.ts'
import * as CheckpointIdentity from '../../../../apps/server/src/checkpointing/CheckpointIdentity.ts'
import * as OrchestrationEngine from '../../../../apps/server/src/orchestration/Services/OrchestrationEngine.ts'
import * as ProjectionSnapshotQuery from '../../../../apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts'
import * as ProviderService from '../../../../apps/server/src/provider/Services/ProviderService.ts'
import * as WorkerBrokerStore from '../../../../apps/server/src/workers/WorkerBrokerStore.ts'
import { GitVcsDriver } from '../../../../apps/server/src/vcs/GitVcsDriver.ts'

const environmentId = EnvironmentId.make('environment-orchestrate-mcp')
const projectId = ProjectId.make('project-orchestrate-mcp')
const threadId = ThreadId.make('thread-orchestrate-mcp')
const providerInstanceId = ProviderInstanceId.make('codex')
const turnId = TurnId.make('turn-orchestrate-mcp')
const runId = 'run-orchestrate-mcp'
const createdAt = '2026-08-07T12:00:00.000Z'

const makePlan = (revision: number): OrchestratePlanRevision => ({
  runId,
  revision,
  turnId,
  workflow: 'implementation',
  task: 'Ship the orchestrate plan.',
  stages: [
    {
      id: 'research',
      provider: 'codex',
      model: null,
      mode: 'read',
      workers: 2,
    },
    {
      id: 'implementation',
      provider: 'codex',
      model: null,
      mode: 'edit',
      workers: 1,
    },
  ],
  totalWorkers: 3,
  maxWorkers: 2,
  source: 'tool',
  leadModelSelection: null,
  status: 'pending',
  createdAt,
  updatedAt: createdAt,
})

const persistedPlan = makePlan(4)
const projectedPlan = makePlan(5)
const committedPlan = makePlan(7)

const makePlanEvent = (
  sequence: number,
  plan: OrchestratePlanRevision,
): Extract<OrchestrationEvent, { type: 'thread.orchestrate-plan-upserted' }> => ({
  sequence,
  eventId: EventId.make(`event-orchestrate-plan-${sequence}`),
  aggregateKind: 'thread',
  aggregateId: threadId,
  occurredAt: createdAt,
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  type: 'thread.orchestrate-plan-upserted',
  payload: {
    threadId,
    plan,
    createdAt,
  },
})

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  initializePayload: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'orchestrate-mcp-test', version: '1.0.0' },
  },
  getClient: Effect.die('unused'),
})

const invocation = McpInvocationContext.McpInvocationContext.of({
  environmentId,
  threadId,
  providerSessionId: 'provider-session-orchestrate-mcp',
  providerInstanceId,
  activeTurnId: turnId,
  capabilities: new Set<McpInvocationContext.McpCapability>(['orchestrate']),
  issuedAt: 1,
})

const cryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(size),
    digest: (_algorithm, data) => Effect.succeed(data),
  }),
)

function makeLayer(
  dispatched: Array<OrchestrationCommand>,
  readEventsCalls: Array<readonly [number, number | undefined]>,
): Layer.Layer<McpServer.McpServer>
{
  const engine = OrchestrationEngine.OrchestrationEngineService.of({
    readEvents: (afterSequence, limit) =>
      Stream.sync(() =>
      {
        readEventsCalls.push([afterSequence, limit])
        return afterSequence === 0
          ? makePlanEvent(4, persistedPlan)
          : makePlanEvent(42, committedPlan)
      }),
    readThreadEvents: () => Stream.die('thread replay is not used by toolkit tests'),
    getThreadReplayStats: () => Effect.die('thread replay stats are not used by toolkit tests'),
    dispatch: (command) =>
      Effect.sync(() =>
      {
        dispatched.push(command)
        return { sequence: 42 }
      }),
    dispatchInternal: () => Effect.die(new Error('internal dispatch is not used by toolkit tests')),
    streamDomainEvents: Stream.empty,
    streamDomainEventsForAggregate: () => Stream.empty,
    latestSequence: Effect.succeed(42),
  })
  const snapshots = {
    getThreadDetailById: (requestedThreadId: ThreadId) =>
      Effect.succeed(
        requestedThreadId === threadId
          ? Option.some({
              id: threadId,
              projectId,
              interactionMode: 'orchestrate',
              session: {
                status: 'running',
                activeTurnId: turnId,
              },
              latestTurn: {
                turnId,
                state: 'running',
              },
              orchestratePlans: [projectedPlan],
            })
          : Option.none(),
      ),
  } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery['Service']

  return McpHttpServer.OrchestrateToolkitRegistrationLive.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(Layer.succeed(OrchestrationEngine.OrchestrationEngineService, engine)),
    Layer.provide(Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, snapshots)),
    Layer.provide(cryptoLayer),
  )
}

type ExecutionVerificationMode =
  | 'success'
  | 'job-id-mismatch'
  | 'run-mismatch'
  | 'base-mismatch'
  | 'repository-mismatch'
  | 'status-mismatch'
  | 'head-mismatch'
  | 'missing-job-branch'
  | 'changed-job-branch'
  | 'changed-integration-branch'
  | 'changed-job-head'
  | 'changed-integration-head'
  | 'checked-out-branch-mismatch'
  | 'authority-changed'

interface RepositoryRevisionCall
{
  readonly cwd: string
  readonly revision: string
  readonly expectedRepositoryCommonDir?: string | undefined
  readonly expectedCommitOid?: string | undefined
}

const approvedPlan: OrchestratePlanRevision = {
  ...makePlan(8),
  status: 'approved',
  sourceSequence: 80,
}

const currentExecution: OrchestrateRunExecution = {
  threadId,
  runId,
  planRevision: approvedPlan.revision,
  sourceTurnId: turnId,
  sourceSequence: 80,
  repositoryRoot: '/repo',
  repositoryCommonDir: '/repo/.git',
  baseOid: 'base-oid',
  lifecycle: 'active',
  availability: 'unavailable',
  integrationRoot: null,
  integrationCommonDir: null,
  integrationBranch: null,
  integrationOid: null,
  observedHeadOid: null,
  finalHeadOid: null,
  closeReason: null,
  current: true,
  admittedAt: createdAt,
  updatedAt: createdAt,
  terminalAt: null,
  jobs: [],
}

function makeExecutionLayer(input: {
  readonly mode: ExecutionVerificationMode
  readonly dispatched: Array<OrchestrationCommand>
  readonly revisionCalls: Array<RepositoryRevisionCall>
  readonly existingExecution?: boolean
}): Layer.Layer<McpServer.McpServer>
{
  let committedExecution = currentExecution
  let hasExecution = input.existingExecution !== false
  let threadReadCount = 0
  const engine = OrchestrationEngine.OrchestrationEngineService.of({
    readEvents: (_afterSequence, _limit) =>
      Stream.sync(
        () =>
          ({
            sequence: 81,
            eventId: EventId.make('event-orchestrate-execution-81'),
            aggregateKind: 'thread' as const,
            aggregateId: threadId,
            occurredAt: createdAt,
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type:
              input.dispatched.at(-1)?.type === 'thread.orchestrate-run-execution.admit'
                ? ('thread.orchestrate-run-execution-admitted' as const)
                : ('thread.orchestrate-run-execution-updated' as const),
            payload: { execution: committedExecution },
          }) as OrchestrationEvent,
      ),
    readThreadEvents: () => Stream.die('thread replay is not used by toolkit tests'),
    getThreadReplayStats: () => Effect.die('thread replay stats are not used by toolkit tests'),
    dispatch: (command) =>
      Effect.sync(() =>
      {
        input.dispatched.push(command)
        if (
          command.type === 'thread.orchestrate-run-execution.admit' ||
          command.type === 'thread.orchestrate-run-execution.update'
        )
        {
          committedExecution = command.execution
          hasExecution = true
        }
        return { sequence: 81 }
      }),
    dispatchInternal: () => Effect.die(new Error('internal dispatch is not used by toolkit tests')),
    streamDomainEvents: Stream.empty,
    streamDomainEventsForAggregate: () => Stream.empty,
    latestSequence: Effect.succeed(81),
  })
  const snapshots = {
    getThreadDetailById: () =>
      Effect.sync(() =>
      {
        threadReadCount += 1
        return Option.some({
          id: threadId,
          projectId,
          interactionMode: 'orchestrate',
          session: {
            status: 'running',
            providerInstanceId,
            activeTurnId: turnId,
          },
          latestTurn: {
            turnId:
              input.mode === 'authority-changed' && threadReadCount > 1
                ? TurnId.make('different-turn')
                : turnId,
            state: 'running',
          },
          orchestratePlans: [approvedPlan],
        })
      }),
    getOrchestrateRunExecution: () =>
      Effect.succeed(hasExecution ? Option.some(committedExecution) : Option.none()),
  } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery['Service']
  const providers = {
    listSessions: () =>
      Effect.succeed([
        {
          provider: 'codex' as const,
          providerInstanceId,
          status: 'running' as const,
          runtimeMode: 'full-access' as const,
          cwd: '/repo',
          threadId,
          activeTurnId: turnId,
          createdAt,
          updatedAt: createdAt,
        },
      ]),
  } as unknown as ProviderService.ProviderService['Service']
  const broker = {
    getExecutionEvidence: (requestedJobId: string) =>
      Effect.succeed({
        state: 'loaded' as const,
        evidence: {
          requestedJobId,
          recordJobId: input.mode === 'job-id-mismatch' ? 'different-job' : requestedJobId,
          recordStatus: 'completed',
          resultStatus: input.mode === 'status-mismatch' ? 'failed' : 'completed',
          requestRunId: input.mode === 'run-mismatch' ? 'different-run' : runId,
          requestRepositoryRoot: '/repo',
          resultRepositoryRoot: '/repo/worktrees/job',
          recordBaseOid: 'base-oid',
          resultBaseOid: input.mode === 'base-mismatch' ? 'different-base' : 'base-oid',
          headOid: input.mode === 'head-mismatch' ? 'different-head' : 'head-oid',
          recordBranch: input.mode === 'missing-job-branch' ? null : 'job-branch',
          resultBranch: input.mode === 'missing-job-branch' ? null : 'job-branch',
          recordWorktreeRoot: '/repo/worktrees/job',
          resultWorktreeRoot: '/repo/worktrees/job',
        },
      }),
  } as unknown as WorkerBrokerStore.WorkerBrokerStore['Service']
  const checkpointIdentity = CheckpointIdentity.CheckpointIdentityResolver.of({
    resolveCapture: () => Effect.die('unused resolveCapture'),
    resolveRead: () => Effect.die('unused resolveRead'),
    resolveDestructive: () => Effect.die('unused resolveDestructive'),
    resolveReadRange: () => Effect.die('unused resolveReadRange'),
    resolveRepositoryObjectRevision: () => Effect.die('unused resolveRepositoryObjectRevision'),
    resolveRepositoryRevision: (request) =>
      Effect.gen(function* ()
      {
        input.revisionCalls.push(request)
        if (
          (input.mode === 'changed-job-branch' && request.revision === 'job-branch') ||
          (input.mode === 'changed-integration-branch' &&
            request.revision === 'integration-branch') ||
          (input.mode === 'changed-job-head' &&
            request.cwd === '/repo/worktrees/job' &&
            request.revision === 'HEAD') ||
          (input.mode === 'changed-integration-head' &&
            request.cwd === '/repo/worktrees/integration' &&
            request.revision === 'HEAD')
        )
        {
          return yield* new CheckpointIdentity.RepositoryRevisionOidMismatchError({
            cwd: request.cwd,
            revision: request.revision,
            expectedCommitOid: request.expectedCommitOid ?? 'head-oid',
            actualCommitOid: 'changed-oid',
          })
        }
        const commitOid =
          request.revision === 'HEAD' ? 'base-oid' : (request.expectedCommitOid ?? request.revision)
        return {
          cwd: request.cwd,
          repositoryRoot:
            input.mode === 'repository-mismatch' && request.cwd === '/repo'
              ? '/different-repository'
              : request.cwd === '/repo/worktrees/integration-alias'
                ? '/repo/worktrees/integration'
                : request.cwd,
          repositoryCommonDir: '/repo/.git',
          commitOid,
        }
      }),
  })
  const git = {
    execute: (request: { readonly cwd: string; readonly args: ReadonlyArray<string> }) =>
      Effect.succeed({
        exitCode: 0 as never,
        stdout:
          input.mode === 'checked-out-branch-mismatch'
            ? 'different-branch\n'
            : request.cwd === '/repo/worktrees/job'
              ? 'job-branch\n'
              : 'integration-branch\n',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
  } as unknown as GitVcsDriver['Service']

  return McpHttpServer.OrchestrateToolkitRegistrationLive.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(Layer.succeed(OrchestrationEngine.OrchestrationEngineService, engine)),
    Layer.provide(Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, snapshots)),
    Layer.provide(Layer.succeed(ProviderService.ProviderService, providers)),
    Layer.provide(Layer.succeed(WorkerBrokerStore.WorkerBrokerStore, broker)),
    Layer.provide(Layer.succeed(CheckpointIdentity.CheckpointIdentityResolver, checkpointIdentity)),
    Layer.provide(Layer.succeed(GitVcsDriver, git)),
    Layer.provide(cryptoLayer),
  )
}

function callExecutionTool(
  layer: Layer.Layer<McpServer.McpServer>,
  name: 'orchestrate_execution_admit' | 'orchestrate_execution_update',
  arguments_: Record<string, unknown>,
)
{
  return Effect.gen(function* ()
  {
    const server = yield* McpServer.McpServer
    return yield* server
      .callTool({ name, arguments: arguments_ })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      )
  }).pipe(Effect.provide(layer))
}

it.effect('derives the draft revision and returns the exact committed revision', () =>
{
  const dispatched: Array<OrchestrationCommand> = []
  const readEventsCalls: Array<readonly [number, number | undefined]> = []

  return Effect.gen(function* ()
  {
    const server = yield* McpServer.McpServer
    const result = yield* server
      .callTool({
        name: 'orchestrate_plan_upsert',
        arguments: {
          runId,
          workflow: 'implementation',
          task: 'Ship the orchestrate plan.',
          stages: projectedPlan.stages,
          maxWorkers: 2,
        },
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      )

    expect(result.isError).toBe(false)
    expect(result.structuredContent).toEqual(committedPlan)
    expect(readEventsCalls).toEqual([[41, 1]])
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]).toMatchObject({
      type: 'thread.orchestrate-plan.upsert',
      threadId,
      plan: {
        runId,
        revision: 6,
        turnId,
        workflow: 'implementation',
        task: 'Ship the orchestrate plan.',
        stages: projectedPlan.stages,
        totalWorkers: 3,
        maxWorkers: 2,
        source: 'tool',
        status: 'pending',
      },
    })
  }).pipe(Effect.provide(makeLayer(dispatched, readEventsCalls)))
})

it.effect('persists optional architecturePaths on the dispatched revision', () =>
{
  const dispatched: Array<OrchestrationCommand> = []
  const readEventsCalls: Array<readonly [number, number | undefined]> = []

  return Effect.gen(function* ()
  {
    const server = yield* McpServer.McpServer
    yield* server
      .callTool({
        name: 'orchestrate_plan_upsert',
        arguments: {
          runId,
          workflow: 'implementation',
          task: 'Ship the orchestrate plan.',
          stages: projectedPlan.stages,
          maxWorkers: 2,
          architecturePaths: ['src/api.ts', 'apps/web'],
        },
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      )

    expect(dispatched[0]).toMatchObject({
      type: 'thread.orchestrate-plan.upsert',
      plan: {
        runId,
        architecturePaths: ['src/api.ts', 'apps/web'],
      },
    })
    expect(readEventsCalls).toEqual([[41, 1]])
  }).pipe(Effect.provide(makeLayer(dispatched, readEventsCalls)))
})

it.effect(
  'admits only the approved source event and captures repository identity server-side',
  () =>
  {
    const dispatched: Array<OrchestrationCommand> = []
    const revisionCalls: Array<RepositoryRevisionCall> = []
    const layer = makeExecutionLayer({
      mode: 'success',
      dispatched,
      revisionCalls,
      existingExecution: false,
    })

    return Effect.gen(function* ()
    {
      const result = yield* callExecutionTool(layer, 'orchestrate_execution_admit', {
        runId,
        planRevision: approvedPlan.revision,
      })
      const retry = yield* callExecutionTool(layer, 'orchestrate_execution_admit', {
        runId,
        planRevision: approvedPlan.revision,
      })

      expect(result.isError).toBe(false)
      expect(retry.structuredContent).toEqual(result.structuredContent)
      expect(result.structuredContent).toMatchObject({
        runId,
        planRevision: approvedPlan.revision,
        sourceTurnId: turnId,
        sourceSequence: approvedPlan.sourceSequence,
        repositoryRoot: '/repo',
        repositoryCommonDir: '/repo/.git',
        baseOid: 'base-oid',
      })
      expect(revisionCalls).toEqual([{ cwd: '/repo', revision: 'HEAD' }])
      expect(dispatched).toHaveLength(2)
      expect(dispatched[1]?.commandId).toBe(dispatched[0]?.commandId)
      expect(dispatched[0]).toMatchObject({
        type: 'thread.orchestrate-run-execution.admit',
        threadId,
        expectedProviderInstanceId: providerInstanceId,
        execution: {
          runId,
          planRevision: approvedPlan.revision,
          sourceSequence: approvedPlan.sourceSequence,
        },
      })
    })
  },
)

it.effect(
  'canonically binds live broker and integration evidence with byte-identical retry',
  () =>
  {
    const dispatched: Array<OrchestrationCommand> = []
    const revisionCalls: Array<RepositoryRevisionCall> = []
    const layer = makeExecutionLayer({ mode: 'success', dispatched, revisionCalls })

    return Effect.gen(function* ()
    {
      const arguments_ = {
        runId,
        planRevision: approvedPlan.revision,
        jobIds: ['job-2', 'job-1'],
        integrationRoot: '/repo/worktrees/integration-alias',
        integrationBranch: 'integration-branch',
        integrationOid: 'head-oid',
        lifecycle: 'completed',
        availability: 'available',
        closeReason: 'Completed.',
      } as const
      const result = yield* callExecutionTool(layer, 'orchestrate_execution_update', arguments_)
      const retry = yield* callExecutionTool(layer, 'orchestrate_execution_update', {
        ...arguments_,
        jobIds: ['job-1', 'job-2'],
      })

      expect(result.isError).toBe(false)
      expect(retry.structuredContent).toEqual(result.structuredContent)
      expect(revisionCalls).toContainEqual({
        cwd: '/repo/worktrees/job',
        revision: 'job-branch',
        expectedRepositoryCommonDir: '/repo/.git',
        expectedCommitOid: 'head-oid',
      })
      expect(revisionCalls).toContainEqual({
        cwd: '/repo/worktrees/integration',
        revision: 'integration-branch',
        expectedRepositoryCommonDir: '/repo/.git',
        expectedCommitOid: 'head-oid',
      })
      expect(dispatched).toHaveLength(2)
      expect(dispatched[1]?.commandId).toBe(dispatched[0]?.commandId)
      expect(dispatched[0]).toMatchObject({
        type: 'thread.orchestrate-run-execution.update',
        expectedProviderInstanceId: providerInstanceId,
        execution: {
          lifecycle: 'completed',
          integrationRoot: '/repo/worktrees/integration',
          finalHeadOid: 'head-oid',
          jobs: [
            { jobId: 'job-1', branch: 'job-branch', headOid: 'head-oid' },
            { jobId: 'job-2', branch: 'job-branch', headOid: 'head-oid' },
          ],
        },
      })
    })
  },
)

it.effect(
  'rejects mismatched broker identity, run, base, repository, status, branch, or head evidence',
  () =>
    Effect.forEach(
      [
        'job-id-mismatch',
        'run-mismatch',
        'base-mismatch',
        'repository-mismatch',
        'status-mismatch',
        'head-mismatch',
        'changed-job-branch',
        'checked-out-branch-mismatch',
        'authority-changed',
      ] as const,
      (mode) =>
      {
        const dispatched: Array<OrchestrationCommand> = []
        const revisionCalls: Array<RepositoryRevisionCall> = []
        const layer = makeExecutionLayer({ mode, dispatched, revisionCalls })
        return Effect.gen(function* ()
        {
          const result = yield* callExecutionTool(layer, 'orchestrate_execution_update', {
            runId,
            planRevision: approvedPlan.revision,
            jobIds: ['job-1'],
            integrationRoot: '/repo/worktrees/integration',
            integrationBranch: 'integration-branch',
            integrationOid: 'head-oid',
            lifecycle: 'completed',
            availability: 'available',
            closeReason: 'Completed.',
          })
          expect(result.isError).toBe(true)
          expect(dispatched).toEqual([])
        })
      },
      { concurrency: 1 },
    ),
)
