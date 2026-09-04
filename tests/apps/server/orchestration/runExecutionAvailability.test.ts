// tests/apps/server/orchestration/runExecutionAvailability.test.ts
// verifies exact execution availability guards around worktree cleanup

import {
  CommandId,
  type OrchestrateRunExecution,
  type OrchestrationCommand,
  ThreadId,
  TurnId,
} from '@t3tools/contracts'
import { it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Stream from 'effect/Stream'
import { expect } from 'vite-plus/test'

import {
  CheckpointIdentityResolver,
  RepositoryRevisionMismatchError,
} from '../../../../apps/server/src/checkpointing/CheckpointIdentity.ts'
import { createEmptyReadModel } from '../../../../apps/server/src/orchestration/projector.ts'
import {
  OrchestrateRunWorktreeRemovalBlockedError,
  retireOrchestrateRunWorktreeAvailability,
} from '../../../../apps/server/src/orchestration/runExecutionAvailability.ts'
import { OrchestrationEngineService } from '../../../../apps/server/src/orchestration/Services/OrchestrationEngine.ts'
import { makeProjectionSnapshotQueryStub } from '../projectionSnapshotQueryTestHelpers.ts'

const NOW = '2026-08-09T04:00:00.000Z'
const RETIRED_AT = '2026-08-09T04:05:00.000Z'
const COMMON_DIR = '/repo/.git'
const REMOVED_ROOT = '/repo/worktrees/removed'

function terminalExecution(input: {
  readonly threadId: string
  readonly runId: string
  readonly integrationRoot: string
  readonly current: boolean
}): OrchestrateRunExecution
{
  return {
    threadId: ThreadId.make(input.threadId),
    runId: input.runId,
    planRevision: 1,
    sourceTurnId: TurnId.make(`turn-${input.runId}`),
    sourceSequence: 10,
    repositoryRoot: '/repo',
    repositoryCommonDir: COMMON_DIR,
    baseOid: 'base-oid',
    lifecycle: input.current ? 'completed' : 'superseded',
    availability: 'available',
    integrationRoot: input.integrationRoot,
    integrationCommonDir: COMMON_DIR,
    integrationBranch: `run/${input.runId}`,
    integrationOid: 'final-oid',
    observedHeadOid: 'final-oid',
    finalHeadOid: 'final-oid',
    closeReason: input.current ? 'Completed.' : 'Superseded.',
    current: input.current,
    admittedAt: NOW,
    updatedAt: NOW,
    terminalAt: NOW,
    jobs: [],
  }
}

function unsupported<A>(): Effect.Effect<A>
{
  return Effect.die(new Error('Unsupported checkpoint identity call in availability test'))
}

function makeCheckpointIdentity(
  resolutionCalls: Array<{ readonly cwd: string; readonly revision: string }>,
)
{
  return CheckpointIdentityResolver.of({
    resolveCapture: unsupported,
    resolveRead: unsupported,
    resolveReadRange: unsupported,
    resolveDestructive: unsupported,
    resolveRepositoryObjectRevision: unsupported,
    resolveRepositoryRevision: (input) =>
      Effect.gen(function* ()
      {
        resolutionCalls.push({ cwd: input.cwd, revision: input.revision })
        if (input.expectedRepositoryCommonDir !== COMMON_DIR)
        {
          return yield* new RepositoryRevisionMismatchError({
            cwd: input.cwd,
            expectedRepositoryCommonDir: input.expectedRepositoryCommonDir ?? '',
            actualRepositoryCommonDir: COMMON_DIR,
          })
        }
        return {
          cwd: REMOVED_ROOT,
          repositoryRoot: REMOVED_ROOT,
          repositoryCommonDir: COMMON_DIR,
          commitOid: 'final-oid',
        }
      }),
  })
}

function makeEngine(dispatched: OrchestrationCommand[])
{
  return OrchestrationEngineService.of({
    dispatch: (command) =>
      Effect.sync(() =>
      {
        dispatched.push(command)
        return { sequence: dispatched.length }
      }),
    dispatchInternal: () =>
      Effect.die(new Error('internal dispatch is not used by availability tests')),
    readEvents: () => Stream.empty,
    readThreadEvents: () => Stream.die('thread replay is not used by availability tests'),
    getThreadReplayStats: () =>
      Effect.die('thread replay stats are not used by availability tests'),
    streamDomainEvents: Stream.empty,
    streamDomainEventsForAggregate: () => Stream.empty,
    latestSequence: Effect.succeed(0),
  })
}

it.effect('retires matching historical execution roots without rewriting terminal evidence', () =>
  Effect.gen(function* ()
  {
    const historical = terminalExecution({
      threadId: 'thread-historical',
      runId: 'run-historical',
      integrationRoot: REMOVED_ROOT,
      current: false,
    })
    const unrelated = terminalExecution({
      threadId: 'thread-unrelated',
      runId: 'run-unrelated',
      integrationRoot: '/repo/worktrees/other',
      current: true,
    })
    const projectionSnapshotQuery = makeProjectionSnapshotQueryStub({
      getSnapshot: () =>
        Effect.succeed({
          ...createEmptyReadModel(NOW),
          orchestrateRunExecutions: [historical, unrelated],
        }),
    })
    const resolutionCalls: Array<{ readonly cwd: string; readonly revision: string }> = []
    const checkpointIdentity = makeCheckpointIdentity(resolutionCalls)
    const dispatched: OrchestrationCommand[] = []
    const orchestrationEngine = makeEngine(dispatched)

    const retired = yield* retireOrchestrateRunWorktreeAvailability({
      worktreePath: REMOVED_ROOT,
      createdAt: RETIRED_AT,
      checkpointIdentity,
      orchestrationEngine,
      projectionSnapshotQuery,
      makeCommandId: (execution) =>
        Effect.succeed(CommandId.make(`retire:${execution.threadId}:${execution.runId}`)),
    })

    expect(retired).toEqual([historical])
    expect(resolutionCalls).toEqual([
      { cwd: REMOVED_ROOT, revision: 'final-oid' },
      { cwd: REMOVED_ROOT, revision: 'final-oid' },
    ])
    expect(dispatched).toHaveLength(1)
    const command = dispatched[0]
    expect(command).toMatchObject({
      type: 'thread.orchestrate-run-execution.update',
      threadId: historical.threadId,
      execution: {
        ...historical,
        availability: 'unavailable',
        updatedAt: RETIRED_AT,
      },
      createdAt: RETIRED_AT,
    })
    if (command?.type !== 'thread.orchestrate-run-execution.update')
    {
      throw new Error('Expected one exact execution availability update.')
    }
    expect({ ...command.execution, availability: historical.availability, updatedAt: NOW }).toEqual(
      historical,
    )
  }),
)

it.effect('refuses removal while a verified exact execution is active', () =>
  Effect.gen(function* ()
  {
    const active: OrchestrateRunExecution = {
      ...terminalExecution({
        threadId: 'thread-active',
        runId: 'run-active',
        integrationRoot: REMOVED_ROOT,
        current: true,
      }),
      lifecycle: 'active',
      finalHeadOid: null,
      closeReason: null,
      terminalAt: null,
    }
    const projectionSnapshotQuery = makeProjectionSnapshotQueryStub({
      getSnapshot: () =>
        Effect.succeed({
          ...createEmptyReadModel(NOW),
          orchestrateRunExecutions: [active],
        }),
    })
    const resolutionCalls: Array<{ readonly cwd: string; readonly revision: string }> = []
    const dispatched: OrchestrationCommand[] = []

    const error = yield* retireOrchestrateRunWorktreeAvailability({
      worktreePath: REMOVED_ROOT,
      createdAt: RETIRED_AT,
      checkpointIdentity: makeCheckpointIdentity(resolutionCalls),
      orchestrationEngine: makeEngine(dispatched),
      projectionSnapshotQuery,
      makeCommandId: () => Effect.succeed(CommandId.make('must-not-dispatch')),
    }).pipe(Effect.flip)

    expect(error).toBeInstanceOf(OrchestrateRunWorktreeRemovalBlockedError)
    expect(error).toMatchObject({
      worktreePath: REMOVED_ROOT,
      threadId: active.threadId,
      runId: active.runId,
      planRevision: active.planRevision,
    })
    expect(resolutionCalls).toEqual([{ cwd: REMOVED_ROOT, revision: 'final-oid' }])
    expect(dispatched).toEqual([])
  }),
)

it.effect('restores every prior retirement when a later dispatch defects', () =>
  Effect.gen(function* ()
  {
    const first = terminalExecution({
      threadId: 'thread-first',
      runId: 'run-first',
      integrationRoot: REMOVED_ROOT,
      current: false,
    })
    const second = terminalExecution({
      threadId: 'thread-second',
      runId: 'run-second',
      integrationRoot: REMOVED_ROOT,
      current: true,
    })
    const projectionSnapshotQuery = makeProjectionSnapshotQueryStub({
      getSnapshot: () =>
        Effect.succeed({
          ...createEmptyReadModel(NOW),
          orchestrateRunExecutions: [first, second],
        }),
    })
    const dispatched: OrchestrationCommand[] = []
    let dispatchCount = 0
    const orchestrationEngine = OrchestrationEngineService.of({
      ...makeEngine([]),
      dispatch: (command) =>
        Effect.suspend(() =>
        {
          dispatched.push(command)
          dispatchCount += 1
          return dispatchCount === 2
            ? Effect.die(new Error('simulated retirement defect'))
            : Effect.succeed({ sequence: dispatchCount })
        }),
    })

    const exit = yield* retireOrchestrateRunWorktreeAvailability({
      worktreePath: REMOVED_ROOT,
      createdAt: RETIRED_AT,
      checkpointIdentity: makeCheckpointIdentity([]),
      orchestrationEngine,
      projectionSnapshotQuery,
      makeCommandId: (execution) =>
        Effect.succeed(CommandId.make(`retire-defect:${execution.threadId}:${dispatchCount}`)),
    }).pipe(Effect.exit)

    expect(Exit.hasDies(exit)).toBe(true)
    expect(
      dispatched.map((command) =>
        command.type === 'thread.orchestrate-run-execution.update'
          ? command.execution.availability
          : 'unexpected',
      ),
    ).toEqual(['unavailable', 'unavailable', 'available'])
  }),
)
