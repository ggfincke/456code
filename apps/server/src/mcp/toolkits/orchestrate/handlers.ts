// apps/server/src/mcp/toolkits/orchestrate/handlers.ts
// derives orchestrate plan and execution authority from authenticated MCP context

import {
  CommandId,
  OrchestratePlanRevision,
  OrchestrateRunExecution,
  type OrchestrateRunExecutionJob,
  type OrchestrationCommand,
  type OrchestratePlanRunId,
  normalizeCollaborationMode,
} from '@t3tools/contracts'
import * as Crypto from 'effect/Crypto'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'

import * as CheckpointIdentity from '../../../checkpointing/CheckpointIdentity.ts'
import type {
  ThreadOrchestratePlanUpsertCommand,
  ThreadOrchestrateRunExecutionAdmitCommand,
  ThreadOrchestrateRunExecutionUpdateCommand,
} from '../../../orchestration/decider.ts'
import * as OrchestrationEngine from '../../../orchestration/Services/OrchestrationEngine.ts'
import * as ProjectionSnapshotQuery from '../../../orchestration/Services/ProjectionSnapshotQuery.ts'
import * as ProviderService from '../../../provider/Services/ProviderService.ts'
import * as WorkerBrokerStore from '../../../workers/WorkerBrokerStore.ts'
import { withOrchestrateRunWorktreePermit } from '../../../orchestration/runExecutionAvailability.ts'
import { GitVcsDriver } from '../../../vcs/GitVcsDriver.ts'
import * as McpInvocationContext from '../../McpInvocationContext.ts'
import {
  OrchestrateExecutionError,
  OrchestratePlanUpsertError,
  OrchestrateToolkit,
  type OrchestrateExecutionAdmitInput,
  type OrchestrateExecutionUpdateInput,
  type OrchestratePlanUpsertInput,
} from './tools.ts'

// compiled once at module scope; rebuilding per call is a lint-flagged cost
const decodeOrchestratePlanRevision = Schema.decodeUnknownEffect(OrchestratePlanRevision)
const decodeOrchestrateRunExecution = Schema.decodeUnknownEffect(OrchestrateRunExecution)
const encodeUnknownJsonString = Schema.encodeUnknownSync(Schema.UnknownFromJsonString)

function orchestratePlanError(
  operation: string,
  code: ConstructorParameters<typeof OrchestratePlanUpsertError>[0]['code'],
  detail: string,
  runId?: OrchestratePlanRunId,
): OrchestratePlanUpsertError
{
  return new OrchestratePlanUpsertError({
    operation,
    code,
    detail,
    ...(runId === undefined ? {} : { runId }),
  })
}

function errorDetail(cause: unknown): string
{
  return cause instanceof Error ? cause.message : String(cause)
}

type ExecutionErrorCode = ConstructorParameters<typeof OrchestrateExecutionError>[0]['code']

function executionError(
  operation: string,
  code: ExecutionErrorCode,
  detail: string,
  input: Pick<OrchestrateExecutionAdmitInput, 'runId' | 'planRevision'>,
  jobId?: string,
): OrchestrateExecutionError
{
  return new OrchestrateExecutionError({
    operation,
    code,
    detail,
    runId: input.runId,
    planRevision: input.planRevision,
    ...(jobId === undefined ? {} : { jobId }),
  })
}

function dispatchExecutionErrorCode(cause: unknown): ExecutionErrorCode
{
  const code =
    typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string'
      ? cause.code
      : ''
  if (code.includes('duplicate') || code.includes('already-bound')) return 'duplicate'
  if (code.includes('transition') || code.includes('terminal')) return 'invalid-transition'
  if (code.includes('mismatch') || code.includes('identity')) return 'identity-mismatch'
  if (code.includes('not-current')) return 'not-found'
  return 'persistence-failed'
}

function repositoryExecutionErrorCode(cause: unknown): ExecutionErrorCode
{
  const tag =
    typeof cause === 'object' && cause !== null && '_tag' in cause && typeof cause._tag === 'string'
      ? cause._tag
      : ''
  return tag === 'RepositoryRevisionMismatchError' || tag === 'RepositoryRevisionOidMismatchError'
    ? 'repository-mismatch'
    : 'evidence-unavailable'
}

function canonicalJobIds(jobIds: ReadonlyArray<string>): Array<string>
{
  return [...jobIds].toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

function bytesToHex(bytes: Uint8Array): string
{
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

const executionCommandId = Effect.fn('orchestrate.executionCommandId')(function* (input: {
  readonly operation: 'admit' | 'update'
  readonly threadId: string
  readonly providerInstanceId: string
  readonly identity: Pick<OrchestrateExecutionAdmitInput, 'runId' | 'planRevision'>
  readonly request: ReadonlyArray<string | number | null>
})
{
  const crypto = yield* Crypto.Crypto
  const digest = yield* crypto
    .digest(
      'SHA-256',
      new TextEncoder().encode(
        encodeUnknownJsonString([
          input.operation,
          input.threadId,
          input.providerInstanceId,
          input.identity.runId,
          input.identity.planRevision,
          input.request,
        ]),
      ),
    )
    .pipe(
      Effect.mapError((cause) =>
        executionError(
          `orchestrate_execution_${input.operation}.create_command`,
          'persistence-failed',
          errorDetail(cause),
          input.identity,
        ),
      ),
    )
  return CommandId.make(`provider:orchestrate-execution-${input.operation}:${bytesToHex(digest)}`)
})

function executionUpdateAlreadyApplied(
  execution: OrchestrateRunExecution,
  input: OrchestrateExecutionUpdateInput,
  integrationRoot = input.integrationRoot,
): boolean
{
  const requestedJobs = new Set(input.jobIds)
  return (
    execution.lifecycle === input.lifecycle &&
    execution.availability === input.availability &&
    execution.integrationRoot === integrationRoot &&
    execution.integrationBranch === input.integrationBranch &&
    execution.integrationOid === input.integrationOid &&
    execution.observedHeadOid === input.integrationOid &&
    execution.finalHeadOid === (input.lifecycle === 'active' ? null : input.integrationOid) &&
    execution.closeReason === (input.closeReason ?? null) &&
    [...requestedJobs].every((jobId) => execution.jobs.some((job) => job.jobId === jobId))
  )
}

const resolveExecutionAuthority = Effect.fn('orchestrate.resolveExecutionAuthority')(function* (
  input: Pick<OrchestrateExecutionAdmitInput, 'runId' | 'planRevision'>,
)
{
  const scope = yield* McpInvocationContext.McpInvocationContext
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery
  const providers = yield* ProviderService.ProviderService

  if (!scope.capabilities.has('orchestrate'))
  {
    return yield* executionError(
      'orchestrate_execution.authorize',
      'capability-unavailable',
      'The authenticated MCP session does not grant the orchestrate capability.',
      input,
    )
  }
  if (scope.activeTurnId === undefined)
  {
    return yield* executionError(
      'orchestrate_execution.resolve_turn',
      'identity-mismatch',
      'The authenticated MCP session is not bound to an active provider turn.',
      input,
    )
  }

  const threadOption = yield* snapshots
    .getThreadDetailById(scope.threadId)
    .pipe(
      Effect.mapError((cause) =>
        executionError(
          'orchestrate_execution.resolve_thread',
          'persistence-failed',
          errorDetail(cause),
          input,
        ),
      ),
    )
  if (Option.isNone(threadOption))
  {
    return yield* executionError(
      'orchestrate_execution.resolve_thread',
      'not-found',
      'The authenticated source thread is not active.',
      input,
    )
  }
  const thread = threadOption.value
  if (
    thread.session?.status !== 'running' ||
    thread.session.providerInstanceId !== scope.providerInstanceId ||
    thread.session.activeTurnId !== scope.activeTurnId ||
    thread.latestTurn?.state !== 'running' ||
    thread.latestTurn.turnId !== scope.activeTurnId ||
    !normalizeCollaborationMode(thread.interactionMode, thread.orchestrate).orchestrate
  )
  {
    return yield* executionError(
      'orchestrate_execution.resolve_turn',
      'identity-mismatch',
      "The authenticated MCP turn does not match the thread's active orchestrate turn.",
      input,
    )
  }

  const providerSessions = yield* providers.listSessions()
  const providerSession = providerSessions.find(
    (candidate) =>
      candidate.threadId === scope.threadId &&
      candidate.providerInstanceId === scope.providerInstanceId &&
      candidate.activeTurnId === scope.activeTurnId &&
      candidate.status === 'running',
  )
  const cwd = providerSession?.cwd
  if (cwd === undefined)
  {
    return yield* executionError(
      'orchestrate_execution.resolve_provider_session',
      'identity-mismatch',
      'No live provider session with an exact thread, instance, turn, and repository root was found.',
      input,
    )
  }
  return { scope, thread, providerSession, cwd }
})

const readCommittedExecution = Effect.fn('orchestrate.readCommittedExecution')(function* (input: {
  readonly operation: string
  readonly identity: Pick<OrchestrateExecutionAdmitInput, 'runId' | 'planRevision'>
  readonly threadId: string
  readonly sequence: number
  readonly eventType:
    'thread.orchestrate-run-execution-admitted' | 'thread.orchestrate-run-execution-updated'
})
{
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService
  const eventOption = yield* orchestrationEngine.readEvents(input.sequence - 1, 1).pipe(
    Stream.runHead,
    Effect.mapError((cause) =>
      executionError(input.operation, 'persistence-failed', errorDetail(cause), input.identity),
    ),
  )
  if (
    Option.isNone(eventOption) ||
    eventOption.value.sequence !== input.sequence ||
    eventOption.value.type !== input.eventType ||
    eventOption.value.payload.execution.threadId !== input.threadId ||
    eventOption.value.payload.execution.runId !== input.identity.runId ||
    eventOption.value.payload.execution.planRevision !== input.identity.planRevision
  )
  {
    return yield* executionError(
      input.operation,
      'persistence-failed',
      `The committed execution event at sequence ${input.sequence} was unavailable.`,
      input.identity,
    )
  }
  return eventOption.value.payload.execution
})

const TERMINAL_JOB_STATUSES = new Set<OrchestrateRunExecutionJob['status']>([
  'completed',
  'failed',
  'rejected',
  'cancelled',
])

function isTerminalJobStatus(value: string | null): value is OrchestrateRunExecutionJob['status']
{
  return value !== null && TERMINAL_JOB_STATUSES.has(value as OrchestrateRunExecutionJob['status'])
}

const resolveBrokerJobEvidence = Effect.fn('orchestrate.resolveBrokerJobEvidence')(
  function* (input: {
    readonly identity: Pick<OrchestrateExecutionAdmitInput, 'runId' | 'planRevision'>
    readonly execution: OrchestrateRunExecution
    readonly jobId: string
    readonly boundAt: string
  })
  {
    const broker = yield* WorkerBrokerStore.WorkerBrokerStore
    const checkpointIdentity = yield* CheckpointIdentity.CheckpointIdentityResolver
    const git = yield* GitVcsDriver
    const outcome = yield* broker.getExecutionEvidence(input.jobId)
    if (outcome.state === 'unavailable')
    {
      return yield* executionError(
        'orchestrate_execution_update.read_job',
        'evidence-unavailable',
        outcome.detail,
        input.identity,
        input.jobId,
      )
    }
    const evidence = outcome.evidence
    if (evidence.recordJobId !== evidence.requestedJobId || evidence.recordJobId !== input.jobId)
    {
      return yield* executionError(
        'orchestrate_execution_update.verify_job_identity',
        'evidence-mismatch',
        `Broker record identity '${evidence.recordJobId ?? 'missing'}' does not match requested job '${input.jobId}'.`,
        input.identity,
        input.jobId,
      )
    }
    if (evidence.requestRunId !== input.execution.runId)
    {
      return yield* executionError(
        'orchestrate_execution_update.verify_job_run',
        'evidence-mismatch',
        `Broker job run '${evidence.requestRunId ?? 'missing'}' does not match authoritative run '${input.execution.runId}'.`,
        input.identity,
        input.jobId,
      )
    }
    if (
      !isTerminalJobStatus(evidence.recordStatus) ||
      !isTerminalJobStatus(evidence.resultStatus) ||
      evidence.recordStatus !== evidence.resultStatus
    )
    {
      return yield* executionError(
        'orchestrate_execution_update.verify_job_status',
        'evidence-mismatch',
        `Broker job status '${evidence.recordStatus ?? 'missing'}' and result status '${evidence.resultStatus ?? 'missing'}' must name the same terminal outcome.`,
        input.identity,
        input.jobId,
      )
    }
    const recordedBaseOids = [evidence.recordBaseOid, evidence.resultBaseOid].filter(
      (candidate): candidate is string => candidate !== null,
    )
    if (
      recordedBaseOids.length === 0 ||
      recordedBaseOids.some((candidate) => candidate !== input.execution.baseOid)
    )
    {
      return yield* executionError(
        'orchestrate_execution_update.verify_job_base',
        'evidence-mismatch',
        `Broker job base evidence does not match immutable base '${input.execution.baseOid}'.`,
        input.identity,
        input.jobId,
      )
    }
    if (evidence.requestRepositoryRoot === null)
    {
      return yield* executionError(
        'orchestrate_execution_update.verify_job_repository',
        'evidence-mismatch',
        'Broker job request repository is missing.',
        input.identity,
        input.jobId,
      )
    }

    const resolveRevision = (
      cwd: string,
      revision: string,
      expectedCommitOid: string,
      operation: string,
    ) =>
      checkpointIdentity
        .resolveRepositoryRevision({
          cwd,
          revision,
          expectedRepositoryCommonDir: input.execution.repositoryCommonDir,
          expectedCommitOid,
        })
        .pipe(
          Effect.mapError((cause) =>
            executionError(
              operation,
              repositoryExecutionErrorCode(cause),
              errorDetail(cause),
              input.identity,
              input.jobId,
            ),
          ),
        )

    const requestRepository = yield* resolveRevision(
      evidence.requestRepositoryRoot,
      input.execution.baseOid,
      input.execution.baseOid,
      'orchestrate_execution_update.verify_job_repository',
    )
    if (requestRepository.repositoryRoot !== input.execution.repositoryRoot)
    {
      return yield* executionError(
        'orchestrate_execution_update.verify_job_repository',
        'repository-mismatch',
        `Broker request repository '${requestRepository.repositoryRoot}' does not match captured repository '${input.execution.repositoryRoot}'.`,
        input.identity,
        input.jobId,
      )
    }

    const resultRepository =
      evidence.resultRepositoryRoot === null
        ? null
        : yield* resolveRevision(
            evidence.resultRepositoryRoot,
            evidence.headOid ?? input.execution.baseOid,
            evidence.headOid ?? input.execution.baseOid,
            'orchestrate_execution_update.verify_job_result_repository',
          )
    if (evidence.recordBranch !== null && evidence.resultBranch !== null)
    {
      if (evidence.recordBranch !== evidence.resultBranch)
      {
        return yield* executionError(
          'orchestrate_execution_update.verify_job_branch',
          'evidence-mismatch',
          `Broker record branch '${evidence.recordBranch}' does not match result branch '${evidence.resultBranch}'.`,
          input.identity,
          input.jobId,
        )
      }
    }
    if (evidence.recordWorktreeRoot !== null && evidence.resultWorktreeRoot !== null)
    {
      if (evidence.recordWorktreeRoot !== evidence.resultWorktreeRoot)
      {
        return yield* executionError(
          'orchestrate_execution_update.verify_job_worktree',
          'evidence-mismatch',
          `Broker record worktree '${evidence.recordWorktreeRoot}' does not match result worktree '${evidence.resultWorktreeRoot}'.`,
          input.identity,
          input.jobId,
        )
      }
    }

    const rawWorktreeRoot = evidence.resultWorktreeRoot ?? evidence.recordWorktreeRoot
    const worktree =
      rawWorktreeRoot === null
        ? null
        : yield* resolveRevision(
            rawWorktreeRoot,
            evidence.headOid ?? input.execution.baseOid,
            evidence.headOid ?? input.execution.baseOid,
            'orchestrate_execution_update.verify_job_worktree',
          )
    if (evidence.recordStatus === 'completed' && evidence.headOid === null)
    {
      return yield* executionError(
        'orchestrate_execution_update.verify_job_head',
        'evidence-mismatch',
        'A completed broker job must carry an immutable result head OID.',
        input.identity,
        input.jobId,
      )
    }
    if (evidence.headOid !== null && worktree === null)
    {
      return yield* executionError(
        'orchestrate_execution_update.verify_job_worktree',
        'evidence-mismatch',
        'A broker result head must name the worktree where that exact commit was verified.',
        input.identity,
        input.jobId,
      )
    }

    const branch = evidence.resultBranch ?? evidence.recordBranch
    if (evidence.headOid !== null && branch === null)
    {
      return yield* executionError(
        'orchestrate_execution_update.verify_job_branch',
        'evidence-mismatch',
        'A broker result head must retain its immutable branch evidence.',
        input.identity,
        input.jobId,
      )
    }
    if (evidence.headOid !== null && branch !== null && worktree !== null)
    {
      yield* resolveRevision(
        worktree.repositoryRoot,
        branch,
        evidence.headOid,
        'orchestrate_execution_update.verify_job_branch',
      )
      yield* resolveRevision(
        worktree.repositoryRoot,
        'HEAD',
        evidence.headOid,
        'orchestrate_execution_update.verify_job_head',
      )
      const currentBranch = yield* git
        .execute({
          operation: 'orchestrate_execution_update.verify_job_branch',
          cwd: worktree.repositoryRoot,
          args: ['symbolic-ref', '--quiet', '--short', 'HEAD'],
          allowNonZeroExit: true,
          maxOutputBytes: 4_096,
        })
        .pipe(
          Effect.mapError((cause) =>
            executionError(
              'orchestrate_execution_update.verify_job_branch',
              'evidence-unavailable',
              errorDetail(cause),
              input.identity,
              input.jobId,
            ),
          ),
        )
      if (currentBranch.exitCode !== 0 || currentBranch.stdout.trim() !== branch)
      {
        return yield* executionError(
          'orchestrate_execution_update.verify_job_branch',
          'evidence-mismatch',
          `Broker worktree HEAD is not checked out on recorded branch '${branch}'.`,
          input.identity,
          input.jobId,
        )
      }
    }
    return {
      jobId: input.jobId,
      status: evidence.recordStatus,
      requestRunId: input.execution.runId,
      requestRepositoryRoot: requestRepository.repositoryRoot,
      resultRepositoryRoot: resultRepository?.repositoryRoot ?? null,
      repositoryCommonDir: input.execution.repositoryCommonDir,
      baseOid: input.execution.baseOid,
      headOid: evidence.headOid,
      worktreeRoot: worktree?.repositoryRoot ?? null,
      branch,
      boundAt: input.boundAt,
    } satisfies OrchestrateRunExecutionJob
  },
)

const resolveUpdateWorktreePermitPath = Effect.fn('orchestrate.resolveUpdateWorktreePermitPath')(
  function* (input: OrchestrateExecutionUpdateInput)
  {
    const authority = yield* resolveExecutionAuthority(input)
    const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery
    const checkpointIdentity = yield* CheckpointIdentity.CheckpointIdentityResolver
    const executionOption = yield* snapshots
      .getOrchestrateRunExecution({
        threadId: authority.scope.threadId,
        runId: input.runId,
        planRevision: input.planRevision,
      })
      .pipe(
        Effect.mapError((cause) =>
          executionError(
            'orchestrate_execution_update.resolve_execution',
            'persistence-failed',
            errorDetail(cause),
            input,
          ),
        ),
      )
    if (Option.isNone(executionOption))
    {
      return yield* executionError(
        'orchestrate_execution_update.resolve_execution',
        'not-found',
        'The exact orchestrate execution does not exist.',
        input,
      )
    }
    const current = executionOption.value
    if (current.sourceTurnId !== authority.scope.activeTurnId)
    {
      return yield* executionError(
        'orchestrate_execution_update.resolve_execution',
        'identity-mismatch',
        'The exact execution is not owned by this authenticated source turn.',
        input,
      )
    }
    if (
      current.integrationRoot !== null &&
      (current.integrationRoot === input.integrationRoot ||
        executionUpdateAlreadyApplied(current, input))
    )
    {
      return current.integrationRoot
    }
    const target = yield* checkpointIdentity
      .resolveRepositoryRevision({
        cwd: input.integrationRoot,
        revision: input.integrationOid,
        expectedCommitOid: input.integrationOid,
      })
      .pipe(
        Effect.mapError((cause) =>
          executionError(
            'orchestrate_execution_update.resolve_worktree_permit',
            repositoryExecutionErrorCode(cause),
            errorDetail(cause),
            input,
          ),
        ),
      )
    return target.repositoryRoot
  },
)

const handlers = {
  orchestrate_plan_upsert: (input: OrchestratePlanUpsertInput) =>
    Effect.gen(function* ()
    {
      const scope = yield* McpInvocationContext.McpInvocationContext
      const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery
      const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService

      if (!scope.capabilities.has('orchestrate'))
      {
        return yield* orchestratePlanError(
          'orchestrate_plan_upsert.authorize',
          'capability-unavailable',
          'The authenticated MCP session does not grant the orchestrate capability.',
          input.runId,
        )
      }
      if (scope.activeTurnId === undefined)
      {
        return yield* orchestratePlanError(
          'orchestrate_plan_upsert.resolve_plan',
          'identity-mismatch',
          'The authenticated MCP session is not bound to an active provider turn.',
          input.runId,
        )
      }

      const threadOption = yield* snapshots
        .getThreadDetailById(scope.threadId)
        .pipe(
          Effect.mapError((cause) =>
            orchestratePlanError(
              'orchestrate_plan_upsert.resolve_thread',
              'persistence-failed',
              errorDetail(cause),
              input.runId,
            ),
          ),
        )
      if (Option.isNone(threadOption))
      {
        return yield* orchestratePlanError(
          'orchestrate_plan_upsert.resolve_thread',
          'not-found',
          'The authenticated source thread is not active.',
          input.runId,
        )
      }
      const thread = threadOption.value
      if (
        thread.session?.status !== 'running' ||
        thread.session.activeTurnId !== scope.activeTurnId ||
        thread.latestTurn?.state !== 'running' ||
        thread.latestTurn.turnId !== scope.activeTurnId
      )
      {
        return yield* orchestratePlanError(
          'orchestrate_plan_upsert.resolve_plan',
          'identity-mismatch',
          "The authenticated MCP turn does not match the thread's active projected turn.",
          input.runId,
        )
      }
      if (!normalizeCollaborationMode(thread.interactionMode, thread.orchestrate).orchestrate)
      {
        return yield* orchestratePlanError(
          'orchestrate_plan_upsert.resolve_plan',
          'identity-mismatch',
          'The authenticated MCP turn is not running in orchestrate mode.',
          input.runId,
        )
      }

      // the serialized decider is the revision authority and bumps any
      // colliding suggestion past its own max, so this projected max is only a
      // floor hint. it used to be maxed against a fold of the entire event log,
      // which paged and schema-decoded every row in orchestration_events
      // (682k events / 1.8GB) on every single plan upsert to learn a number the
      // decider recomputes anyway
      const projectedMaxRevision = thread.orchestratePlans.reduce(
        (maxRevision, plan) =>
          plan.runId === input.runId ? Math.max(maxRevision, plan.revision) : maxRevision,
        0,
      )
      const createdAt = DateTime.formatIso(yield* DateTime.now)
      const totalWorkers =
        input.totalWorkers ?? input.stages.reduce((total, stage) => total + stage.workers, 0)
      const plan = yield* decodeOrchestratePlanRevision({
        runId: input.runId,
        revision: projectedMaxRevision + 1,
        turnId: scope.activeTurnId,
        workflow: input.workflow,
        task: input.task,
        stages: input.stages,
        totalWorkers,
        maxWorkers: input.maxWorkers ?? totalWorkers,
        source: 'tool',
        status: 'pending',
        createdAt,
        updatedAt: createdAt,
      }).pipe(
        Effect.mapError((cause) =>
          orchestratePlanError(
            'orchestrate_plan_upsert.validate_revision',
            'persistence-failed',
            errorDetail(cause),
            input.runId,
          ),
        ),
      )

      const crypto = yield* Crypto.Crypto
      const command: ThreadOrchestratePlanUpsertCommand = {
        type: 'thread.orchestrate-plan.upsert',
        commandId: CommandId.make(
          `provider:orchestrate-plan-upsert:${yield* crypto.randomUUIDv4.pipe(
            Effect.mapError((cause) =>
              orchestratePlanError(
                'orchestrate_plan_upsert.create_command',
                'persistence-failed',
                errorDetail(cause),
                input.runId,
              ),
            ),
          )}`,
        ),
        threadId: scope.threadId,
        plan,
        createdAt,
      }
      const dispatchResult = yield* orchestrationEngine
        .dispatch(command as unknown as OrchestrationCommand)
        .pipe(
          Effect.mapError((cause) =>
            orchestratePlanError(
              'orchestrate_plan_upsert.persist',
              'persistence-failed',
              errorDetail(cause),
              input.runId,
            ),
          ),
        )
      const committedEventOption = yield* orchestrationEngine
        .readEvents(dispatchResult.sequence - 1, 1)
        .pipe(
          Stream.runHead,
          Effect.mapError((cause) =>
            orchestratePlanError(
              'orchestrate_plan_upsert.resolve_persisted_revision',
              'persistence-failed',
              errorDetail(cause),
              input.runId,
            ),
          ),
        )
      if (
        Option.isNone(committedEventOption) ||
        committedEventOption.value.sequence !== dispatchResult.sequence ||
        committedEventOption.value.type !== 'thread.orchestrate-plan-upserted' ||
        committedEventOption.value.payload.threadId !== scope.threadId ||
        committedEventOption.value.payload.plan.runId !== input.runId
      )
      {
        return yield* orchestratePlanError(
          'orchestrate_plan_upsert.resolve_persisted_revision',
          'persistence-failed',
          `The committed orchestrate plan event at sequence ${dispatchResult.sequence} was unavailable.`,
          input.runId,
        )
      }
      // the committed revision is the decider's, not the one suggested above
      return committedEventOption.value.payload.plan
    }),

  orchestrate_execution_admit: (input: OrchestrateExecutionAdmitInput) =>
    Effect.gen(function* ()
    {
      const authority = yield* resolveExecutionAuthority(input)
      const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery
      const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService
      const checkpointIdentity = yield* CheckpointIdentity.CheckpointIdentityResolver
      const plan = authority.thread.orchestratePlans.find(
        (candidate) => candidate.runId === input.runId && candidate.revision === input.planRevision,
      )
      if (plan === undefined)
      {
        return yield* executionError(
          'orchestrate_execution_admit.resolve_plan',
          'not-found',
          'The exact orchestrate plan revision does not exist.',
          input,
        )
      }
      if (
        plan.status !== 'approved' ||
        plan.turnId !== authority.scope.activeTurnId ||
        plan.sourceSequence === undefined
      )
      {
        return yield* executionError(
          'orchestrate_execution_admit.resolve_plan',
          'identity-mismatch',
          'Admission requires the exact approved plan event owned by this authenticated active turn.',
          input,
        )
      }

      const existingExecution = yield* snapshots
        .getOrchestrateRunExecution({
          threadId: authority.scope.threadId,
          runId: input.runId,
          planRevision: input.planRevision,
        })
        .pipe(
          Effect.mapError((cause) =>
            executionError(
              'orchestrate_execution_admit.resolve_execution',
              'persistence-failed',
              errorDetail(cause),
              input,
            ),
          ),
        )
      if (Option.isSome(existingExecution))
      {
        const existing = existingExecution.value
        if (
          existing.sourceTurnId === authority.scope.activeTurnId &&
          existing.sourceSequence === plan.sourceSequence &&
          existing.lifecycle === 'active' &&
          existing.availability === 'unavailable' &&
          existing.integrationRoot === null &&
          existing.observedHeadOid === null &&
          existing.jobs.length === 0
        )
        {
          const retryCommand: ThreadOrchestrateRunExecutionAdmitCommand = {
            type: 'thread.orchestrate-run-execution.admit',
            commandId: yield* executionCommandId({
              operation: 'admit',
              threadId: authority.scope.threadId,
              providerInstanceId: authority.scope.providerInstanceId,
              identity: input,
              request: [],
            }),
            threadId: authority.scope.threadId,
            expectedProviderInstanceId: authority.scope.providerInstanceId,
            execution: existing,
            createdAt: existing.admittedAt,
          }
          const retryResult = yield* orchestrationEngine
            .dispatch(retryCommand)
            .pipe(
              Effect.mapError((cause) =>
                executionError(
                  'orchestrate_execution_admit.retry',
                  dispatchExecutionErrorCode(cause),
                  errorDetail(cause),
                  input,
                ),
              ),
            )
          return yield* readCommittedExecution({
            operation: 'orchestrate_execution_admit.resolve_retry',
            identity: input,
            threadId: authority.scope.threadId,
            sequence: retryResult.sequence,
            eventType: 'thread.orchestrate-run-execution-admitted',
          })
        }
        return yield* executionError(
          'orchestrate_execution_admit.resolve_execution',
          'duplicate',
          'The plan revision already has a different committed execution state.',
          input,
        )
      }

      const captured = yield* checkpointIdentity
        .resolveRepositoryRevision({
          cwd: authority.cwd,
          revision: 'HEAD',
        })
        .pipe(
          Effect.mapError((cause) =>
            executionError(
              'orchestrate_execution_admit.capture_repository',
              repositoryExecutionErrorCode(cause),
              errorDetail(cause),
              input,
            ),
          ),
        )
      const createdAt = DateTime.formatIso(yield* DateTime.now)
      const execution = yield* decodeOrchestrateRunExecution({
        threadId: authority.scope.threadId,
        runId: input.runId,
        planRevision: input.planRevision,
        sourceTurnId: authority.scope.activeTurnId,
        sourceSequence: plan.sourceSequence,
        repositoryRoot: captured.repositoryRoot,
        repositoryCommonDir: captured.repositoryCommonDir,
        baseOid: captured.commitOid,
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
      }).pipe(
        Effect.mapError((cause) =>
          executionError(
            'orchestrate_execution_admit.validate',
            'persistence-failed',
            errorDetail(cause),
            input,
          ),
        ),
      )
      const command: ThreadOrchestrateRunExecutionAdmitCommand = {
        type: 'thread.orchestrate-run-execution.admit',
        commandId: yield* executionCommandId({
          operation: 'admit',
          threadId: authority.scope.threadId,
          providerInstanceId: authority.scope.providerInstanceId,
          identity: input,
          request: [],
        }),
        threadId: authority.scope.threadId,
        expectedProviderInstanceId: authority.scope.providerInstanceId,
        execution,
        createdAt,
      }
      const dispatchResult = yield* orchestrationEngine
        .dispatch(command)
        .pipe(
          Effect.mapError((cause) =>
            executionError(
              'orchestrate_execution_admit.persist',
              dispatchExecutionErrorCode(cause),
              errorDetail(cause),
              input,
            ),
          ),
        )
      return yield* readCommittedExecution({
        operation: 'orchestrate_execution_admit.resolve_persisted_execution',
        identity: input,
        threadId: authority.scope.threadId,
        sequence: dispatchResult.sequence,
        eventType: 'thread.orchestrate-run-execution-admitted',
      })
    }),

  orchestrate_execution_update: (input: OrchestrateExecutionUpdateInput) =>
    Effect.gen(function* ()
    {
      const worktreePermitPath = yield* resolveUpdateWorktreePermitPath(input)
      return yield* withOrchestrateRunWorktreePermit(
        worktreePermitPath,
        Effect.gen(function* ()
        {
          const authority = yield* resolveExecutionAuthority(input)
          const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery
          const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService
          const checkpointIdentity = yield* CheckpointIdentity.CheckpointIdentityResolver
          const git = yield* GitVcsDriver
          const executionOption = yield* snapshots
            .getOrchestrateRunExecution({
              threadId: authority.scope.threadId,
              runId: input.runId,
              planRevision: input.planRevision,
            })
            .pipe(
              Effect.mapError((cause) =>
                executionError(
                  'orchestrate_execution_update.resolve_execution',
                  'persistence-failed',
                  errorDetail(cause),
                  input,
                ),
              ),
            )
          if (Option.isNone(executionOption))
          {
            return yield* executionError(
              'orchestrate_execution_update.resolve_execution',
              'not-found',
              'The exact orchestrate execution does not exist.',
              input,
            )
          }
          const current = executionOption.value
          if (current.sourceTurnId !== authority.scope.activeTurnId)
          {
            return yield* executionError(
              'orchestrate_execution_update.resolve_execution',
              'identity-mismatch',
              'The exact execution is not owned by this authenticated source turn.',
              input,
            )
          }
          const requestedJobIds = canonicalJobIds(input.jobIds)
          if (new Set(requestedJobIds).size !== requestedJobIds.length)
          {
            return yield* executionError(
              'orchestrate_execution_update.verify_job_identity',
              'duplicate',
              'Every explicitly named broker job ID must be unique.',
              input,
            )
          }
          const terminal = input.lifecycle !== 'active'
          if (
            (terminal && input.closeReason === undefined) ||
            (input.availability === 'unavailable' && input.closeReason === undefined) ||
            (!terminal && input.availability === 'available' && input.closeReason !== undefined)
          )
          {
            return yield* executionError(
              'orchestrate_execution_update.validate_transition',
              'invalid-transition',
              'Terminal or unavailable updates require a close reason; an active available execution cannot carry one.',
              input,
            )
          }
          if (executionUpdateAlreadyApplied(current, input, worktreePermitPath))
          {
            const retryCommand: ThreadOrchestrateRunExecutionUpdateCommand = {
              type: 'thread.orchestrate-run-execution.update',
              commandId: yield* executionCommandId({
                operation: 'update',
                threadId: authority.scope.threadId,
                providerInstanceId: authority.scope.providerInstanceId,
                identity: input,
                request: [
                  input.lifecycle,
                  input.availability,
                  input.integrationRoot,
                  input.integrationBranch,
                  input.integrationOid,
                  input.closeReason ?? null,
                  ...requestedJobIds,
                ],
              }),
              threadId: authority.scope.threadId,
              expectedProviderInstanceId: authority.scope.providerInstanceId,
              execution: current,
              createdAt: current.updatedAt,
            }
            const retryResult = yield* orchestrationEngine
              .dispatch(retryCommand)
              .pipe(
                Effect.mapError((cause) =>
                  executionError(
                    'orchestrate_execution_update.retry',
                    dispatchExecutionErrorCode(cause),
                    errorDetail(cause),
                    input,
                  ),
                ),
              )
            return yield* readCommittedExecution({
              operation: 'orchestrate_execution_update.resolve_retry',
              identity: input,
              threadId: authority.scope.threadId,
              sequence: retryResult.sequence,
              eventType: 'thread.orchestrate-run-execution-updated',
            })
          }
          if (!current.current || current.lifecycle !== 'active')
          {
            return yield* executionError(
              'orchestrate_execution_update.resolve_execution',
              'invalid-transition',
              'Only the current active execution owned by this authenticated source turn can advance.',
              input,
            )
          }

          const updatedAt = DateTime.formatIso(yield* DateTime.now)
          const jobsById = new Map(current.jobs.map((job) => [job.jobId, job]))
          const namedJobs: OrchestrateRunExecutionJob[] = []
          for (const jobId of requestedJobIds)
          {
            const verified = yield* resolveBrokerJobEvidence({
              identity: input,
              execution: current,
              jobId,
              boundAt: updatedAt,
            })
            const previous = jobsById.get(jobId)
            if (
              previous !== undefined &&
              (previous.status !== verified.status ||
                previous.requestRunId !== verified.requestRunId ||
                previous.requestRepositoryRoot !== verified.requestRepositoryRoot ||
                previous.resultRepositoryRoot !== verified.resultRepositoryRoot ||
                previous.repositoryCommonDir !== verified.repositoryCommonDir ||
                previous.baseOid !== verified.baseOid ||
                previous.headOid !== verified.headOid ||
                previous.worktreeRoot !== verified.worktreeRoot ||
                previous.branch !== verified.branch)
            )
            {
              return yield* executionError(
                'orchestrate_execution_update.verify_job_identity',
                'evidence-mismatch',
                `Broker job '${jobId}' no longer matches its immutable bound evidence.`,
                input,
                jobId,
              )
            }
            const bound = previous ?? verified
            jobsById.set(jobId, bound)
            namedJobs.push(bound)
          }

          if (
            !namedJobs.some((job) => job.headOid === input.integrationOid) &&
            current.observedHeadOid !== input.integrationOid &&
            !(
              namedJobs.every((job) => job.headOid === null) &&
              input.integrationOid === current.baseOid
            )
          )
          {
            return yield* executionError(
              'orchestrate_execution_update.verify_integration_head',
              'evidence-mismatch',
              'The integration OID is not a verified head from a named job, the prior observed head, or the unchanged immutable base.',
              input,
            )
          }

          const integration =
            input.availability === 'available'
              ? input.integrationBranch === null
                ? yield* executionError(
                    'orchestrate_execution_update.verify_integration_branch',
                    'evidence-mismatch',
                    'An available integration worktree must retain its checked-out branch.',
                    input,
                  )
                : yield* checkpointIdentity
                    .resolveRepositoryRevision({
                      cwd: input.integrationRoot,
                      revision: input.integrationOid,
                      expectedRepositoryCommonDir: current.repositoryCommonDir,
                      expectedCommitOid: input.integrationOid,
                    })
                    .pipe(
                      Effect.mapError((cause) =>
                        executionError(
                          'orchestrate_execution_update.verify_integration_target',
                          repositoryExecutionErrorCode(cause),
                          errorDetail(cause),
                          input,
                        ),
                      ),
                    )
              : yield* Effect.gen(function* ()
                {
                  if (
                    current.availability !== 'available' ||
                    current.integrationRoot !== input.integrationRoot ||
                    current.integrationCommonDir !== current.repositoryCommonDir ||
                    current.integrationOid !== input.integrationOid ||
                    current.integrationBranch !== input.integrationBranch
                  )
                    {
                    return yield* executionError(
                      'orchestrate_execution_update.verify_unavailable_target',
                      'invalid-transition',
                      'An unavailable transition must preserve a previously verified integration root, anchor, and OID.',
                      input,
                    )
                  }
                  const retained = yield* checkpointIdentity
                    .resolveRepositoryRevision({
                      cwd: current.repositoryRoot,
                      revision: input.integrationOid,
                      expectedRepositoryCommonDir: current.repositoryCommonDir,
                      expectedCommitOid: input.integrationOid,
                    })
                    .pipe(
                      Effect.mapError((cause) =>
                        executionError(
                          'orchestrate_execution_update.verify_unavailable_target',
                          repositoryExecutionErrorCode(cause),
                          errorDetail(cause),
                          input,
                        ),
                      ),
                    )
                  return { ...retained, repositoryRoot: input.integrationRoot }
                })

          if (input.availability === 'available' && input.integrationBranch !== null)
          {
            yield* checkpointIdentity
              .resolveRepositoryRevision({
                cwd: integration.repositoryRoot,
                revision: input.integrationBranch,
                expectedRepositoryCommonDir: current.repositoryCommonDir,
                expectedCommitOid: input.integrationOid,
              })
              .pipe(
                Effect.mapError((cause) =>
                  executionError(
                    'orchestrate_execution_update.verify_integration_branch',
                    repositoryExecutionErrorCode(cause),
                    errorDetail(cause),
                    input,
                  ),
                ),
              )
            yield* checkpointIdentity
              .resolveRepositoryRevision({
                cwd: integration.repositoryRoot,
                revision: 'HEAD',
                expectedRepositoryCommonDir: current.repositoryCommonDir,
                expectedCommitOid: input.integrationOid,
              })
              .pipe(
                Effect.mapError((cause) =>
                  executionError(
                    'orchestrate_execution_update.verify_integration_head',
                    repositoryExecutionErrorCode(cause),
                    errorDetail(cause),
                    input,
                  ),
                ),
              )
            const currentBranch = yield* git
              .execute({
                operation: 'orchestrate_execution_update.verify_integration_branch',
                cwd: integration.repositoryRoot,
                args: ['symbolic-ref', '--quiet', '--short', 'HEAD'],
                allowNonZeroExit: true,
                maxOutputBytes: 4_096,
              })
              .pipe(
                Effect.mapError((cause) =>
                  executionError(
                    'orchestrate_execution_update.verify_integration_branch',
                    'evidence-unavailable',
                    errorDetail(cause),
                    input,
                  ),
                ),
              )
            if (
              currentBranch.exitCode !== 0 ||
              currentBranch.stdout.trim() !== input.integrationBranch
            )
            {
              return yield* executionError(
                'orchestrate_execution_update.verify_integration_branch',
                'evidence-mismatch',
                `Integration worktree HEAD is not checked out on branch '${input.integrationBranch}'.`,
                input,
              )
            }
          }

          const recheckedAuthority = yield* resolveExecutionAuthority(input)
          if (
            recheckedAuthority.scope.threadId !== authority.scope.threadId ||
            recheckedAuthority.scope.providerInstanceId !== authority.scope.providerInstanceId ||
            recheckedAuthority.scope.activeTurnId !== authority.scope.activeTurnId ||
            recheckedAuthority.cwd !== authority.cwd
          )
          {
            return yield* executionError(
              'orchestrate_execution_update.recheck_authority',
              'identity-mismatch',
              'The exact provider, turn, or repository authority changed during evidence verification.',
              input,
            )
          }

          const nextExecution = yield* decodeOrchestrateRunExecution({
            ...current,
            lifecycle: input.lifecycle,
            availability: input.availability,
            integrationRoot: integration.repositoryRoot,
            integrationCommonDir: current.repositoryCommonDir,
            integrationBranch: input.integrationBranch,
            integrationOid: input.integrationOid,
            observedHeadOid: input.integrationOid,
            finalHeadOid: terminal ? input.integrationOid : null,
            closeReason: input.closeReason ?? null,
            updatedAt,
            terminalAt: terminal ? updatedAt : null,
            jobs: [...jobsById.values()].toSorted((left, right) =>
              left.jobId < right.jobId ? -1 : left.jobId > right.jobId ? 1 : 0,
            ),
          }).pipe(
            Effect.mapError((cause) =>
              executionError(
                'orchestrate_execution_update.validate',
                'invalid-transition',
                errorDetail(cause),
                input,
              ),
            ),
          )
          const command: ThreadOrchestrateRunExecutionUpdateCommand = {
            type: 'thread.orchestrate-run-execution.update',
            commandId: yield* executionCommandId({
              operation: 'update',
              threadId: authority.scope.threadId,
              providerInstanceId: authority.scope.providerInstanceId,
              identity: input,
              request: [
                input.lifecycle,
                input.availability,
                input.integrationRoot,
                input.integrationBranch,
                input.integrationOid,
                input.closeReason ?? null,
                ...requestedJobIds,
              ],
            }),
            threadId: authority.scope.threadId,
            expectedProviderInstanceId: authority.scope.providerInstanceId,
            execution: nextExecution,
            createdAt: updatedAt,
          }
          const dispatchResult = yield* orchestrationEngine
            .dispatch(command)
            .pipe(
              Effect.mapError((cause) =>
                executionError(
                  'orchestrate_execution_update.persist',
                  dispatchExecutionErrorCode(cause),
                  errorDetail(cause),
                  input,
                ),
              ),
            )
          return yield* readCommittedExecution({
            operation: 'orchestrate_execution_update.resolve_persisted_execution',
            identity: input,
            threadId: authority.scope.threadId,
            sequence: dispatchResult.sequence,
            eventType: 'thread.orchestrate-run-execution-updated',
          })
        }),
      )
    }),
} satisfies Parameters<typeof OrchestrateToolkit.toLayer>[0]

export const OrchestrateToolkitHandlersLive = OrchestrateToolkit.toLayer(handlers)
