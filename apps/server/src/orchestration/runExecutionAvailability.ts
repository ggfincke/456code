// apps/server/src/orchestration/runExecutionAvailability.ts
// guards exact run availability around verified worktree removal

import type {
  CommandId,
  OrchestrateRunExecution,
  OrchestrationDispatchCommandError,
} from '@t3tools/contracts'
import * as Cause from 'effect/Cause'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Path from 'effect/Path'
import * as Result from 'effect/Result'
import * as Semaphore from 'effect/Semaphore'

import type * as CheckpointIdentity from '../checkpointing/CheckpointIdentity.ts'
import type * as OrchestrationEngine from './Services/OrchestrationEngine.ts'
import type * as ProjectionSnapshotQuery from './Services/ProjectionSnapshotQuery.ts'

interface WorktreePermitEntry
{
  readonly semaphore: Semaphore.Semaphore
  leases: number
}

const worktreePermitEntries = new Map<string, WorktreePermitEntry>()

export function withOrchestrateRunWorktreePermit<A, E, R>(
  worktreePath: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R>
{
  return Effect.gen(function* ()
  {
    const path = yield* Path.Path
    const key = path.normalize(path.resolve(worktreePath))
    return yield* Effect.acquireUseRelease(
      Effect.sync(() =>
      {
        const existing = worktreePermitEntries.get(key)
        if (existing !== undefined)
        {
          existing.leases += 1
          return existing
        }
        const entry = { semaphore: Semaphore.makeUnsafe(1), leases: 1 }
        worktreePermitEntries.set(key, entry)
        return entry
      }),
      (entry) => entry.semaphore.withPermit(effect),
      (entry) =>
        Effect.sync(() =>
        {
          entry.leases -= 1
          if (entry.leases === 0 && worktreePermitEntries.get(key) === entry)
          {
            worktreePermitEntries.delete(key)
          }
        }),
    )
  }).pipe(Effect.provide(Path.layer))
}

export class OrchestrateRunWorktreeRemovalBlockedError extends Data.TaggedError(
  'OrchestrateRunWorktreeRemovalBlockedError',
)<{
  readonly worktreePath: string
  readonly threadId: string
  readonly runId: string
  readonly planRevision: number
}>
{
  override get message(): string
  {
    return (
      `Cannot remove '${this.worktreePath}' while exact execution ` +
      `'${this.threadId}/${this.runId}/${this.planRevision}' is active.`
    )
  }
}

interface AvailabilityTransitionDependencies
{
  readonly orchestrationEngine: OrchestrationEngine.OrchestrationEngineService['Service']
  readonly makeCommandId: (
    execution: OrchestrateRunExecution,
  ) => Effect.Effect<CommandId, OrchestrationDispatchCommandError>
}

const dispatchAvailability = Effect.fn('dispatchOrchestrateRunWorktreeAvailability')(function* (
  input: AvailabilityTransitionDependencies & {
    readonly execution: OrchestrateRunExecution
    readonly availability: OrchestrateRunExecution['availability']
    readonly createdAt: string
  },
)
{
  const commandId = yield* input.makeCommandId(input.execution)
  yield* input.orchestrationEngine.dispatch({
    type: 'thread.orchestrate-run-execution.update',
    commandId,
    threadId: input.execution.threadId,
    expectedProviderInstanceId: null,
    execution: {
      ...input.execution,
      availability: input.availability,
      updatedAt: input.createdAt,
    },
    createdAt: input.createdAt,
  })
})

export const restoreOrchestrateRunWorktreeAvailability = Effect.fn(
  'restoreOrchestrateRunWorktreeAvailability',
)(function* (
  input: AvailabilityTransitionDependencies & {
    readonly executions: ReadonlyArray<OrchestrateRunExecution>
    readonly createdAt: string
  },
)
{
  const exits = yield* Effect.forEach(
    input.executions,
    (execution) =>
      dispatchAvailability({
        ...input,
        execution,
        availability: 'available',
      }).pipe(Effect.exit),
    { concurrency: 1 },
  )
  const failures = exits.filter(Exit.isFailure)
  const first = failures[0]
  if (first === undefined)
  {
    return
  }
  const combined = failures
    .slice(1)
    .reduce((cause, failure) => Cause.combine(cause, failure.cause), first.cause)
  return yield* Effect.failCause(combined)
})

export const verifyOrchestrateRunWorktreePresent = Effect.fn('verifyOrchestrateRunWorktreePresent')(
  function* (input: {
    readonly worktreePath: string
    readonly executions: ReadonlyArray<OrchestrateRunExecution>
    readonly checkpointIdentity: CheckpointIdentity.CheckpointIdentityResolver['Service']
  })
  {
    if (input.executions.length === 0)
    {
      return false
    }

    for (const execution of input.executions)
    {
      if (execution.integrationRoot === null || execution.integrationOid === null)
      {
        return false
      }
      const resolved = yield* input.checkpointIdentity
        .resolveRepositoryRevision({
          cwd: input.worktreePath,
          revision: execution.integrationOid,
          expectedRepositoryCommonDir: execution.repositoryCommonDir,
          expectedCommitOid: execution.integrationOid,
        })
        .pipe(Effect.exit)
      if (Exit.isFailure(resolved) || resolved.value.repositoryRoot !== execution.integrationRoot)
      {
        return false
      }
    }

    return true
  },
)

export const retireOrchestrateRunWorktreeAvailability = Effect.fn(
  'retireOrchestrateRunWorktreeAvailability',
)(function* (
  input: AvailabilityTransitionDependencies & {
    readonly worktreePath: string
    readonly createdAt: string
    readonly checkpointIdentity: CheckpointIdentity.CheckpointIdentityResolver['Service']
    readonly projectionSnapshotQuery: ProjectionSnapshotQuery.ProjectionSnapshotQuery['Service']
  },
)
{
  const snapshot = yield* input.projectionSnapshotQuery.getSnapshot()
  const candidates = (snapshot.orchestrateRunExecutions ?? []).filter(
    (execution) =>
      execution.availability === 'available' &&
      execution.integrationRoot !== null &&
      execution.integrationOid !== null,
  )
  const verified: OrchestrateRunExecution[] = []
  for (const execution of candidates)
  {
    const resolved = yield* input.checkpointIdentity
      .resolveRepositoryRevision({
        cwd: input.worktreePath,
        revision: execution.integrationOid as string,
        expectedRepositoryCommonDir: execution.repositoryCommonDir,
        expectedCommitOid: execution.integrationOid as string,
      })
      .pipe(Effect.result)
    if (
      Result.isSuccess(resolved) &&
      resolved.success.repositoryRoot === execution.integrationRoot
    )
    {
      verified.push(execution)
    }
  }

  const active = verified.find((execution) => execution.lifecycle === 'active')
  if (active !== undefined)
  {
    return yield* new OrchestrateRunWorktreeRemovalBlockedError({
      worktreePath: input.worktreePath,
      threadId: active.threadId,
      runId: active.runId,
      planRevision: active.planRevision,
    })
  }

  const retired: OrchestrateRunExecution[] = []
  for (const execution of verified)
  {
    const transition = yield* dispatchAvailability({
      ...input,
      execution,
      availability: 'unavailable',
    }).pipe(Effect.exit)
    if (Exit.isFailure(transition))
    {
      const restoration = yield* restoreOrchestrateRunWorktreeAvailability({
        ...input,
        executions: retired,
      }).pipe(Effect.exit)
      if (Exit.isFailure(restoration))
      {
        return yield* Effect.failCause(Cause.combine(transition.cause, restoration.cause))
      }
      return yield* Effect.failCause(transition.cause)
    }
    retired.push(execution)
  }

  return retired
})
