// tests/apps/server/orchestration/decider.orchestrateExecution.test.ts
// verifies authoritative orchestrate execution admission and lifecycle invariants

import {
  CommandId,
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
import * as NodeServices from '@effect/platform-node/NodeServices'
import { it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import { expect } from 'vite-plus/test'

import { decideOrchestrationCommand } from '../../../../apps/server/src/orchestration/decider.ts'
import {
  createEmptyReadModel,
  projectEvent,
} from '../../../../apps/server/src/orchestration/projector.ts'

const NOW = '2026-08-09T03:00:00.000Z'
const LATER = '2026-08-09T03:01:00.000Z'
const PROJECT_ID = ProjectId.make('project-orchestrate-execution')
const THREAD_ID = ThreadId.make('thread-orchestrate-execution')
const TURN_ID = TurnId.make('turn-orchestrate-execution')

function plan(runId: string, revision: number, sourceSequence: number): OrchestratePlanRevision
{
  return {
    runId,
    revision,
    turnId: TURN_ID,
    workflow: 'single-edit',
    task: 'Implement the approved change.',
    stages: [],
    totalWorkers: 0,
    maxWorkers: 0,
    source: 'tool',
    leadModelSelection: {
      instanceId: ProviderInstanceId.make('codex'),
      model: 'gpt-5.6',
    },
    status: 'approved',
    sourceSequence,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function execution(
  runId: string,
  planRevision: number,
  sourceSequence: number,
): OrchestrateRunExecution
{
  return {
    threadId: THREAD_ID,
    runId,
    planRevision,
    sourceTurnId: TURN_ID,
    sourceSequence,
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
    admittedAt: NOW,
    updatedAt: NOW,
    terminalAt: null,
    jobs: [],
  }
}

const admitCommand = (
  commandId: string,
  value: OrchestrateRunExecution,
): Extract<OrchestrationCommand, { readonly type: 'thread.orchestrate-run-execution.admit' }> => ({
  type: 'thread.orchestrate-run-execution.admit',
  commandId: CommandId.make(commandId),
  threadId: THREAD_ID,
  expectedProviderInstanceId: ProviderInstanceId.make('codex'),
  execution: value,
  createdAt: LATER,
})

function job(jobId: string)
{
  return {
    jobId,
    status: 'completed' as const,
    requestRunId: 'run-a',
    requestRepositoryRoot: '/repo',
    resultRepositoryRoot: `/repo/worktrees/${jobId}`,
    repositoryCommonDir: '/repo/.git',
    baseOid: 'base-oid',
    headOid: 'head-oid',
    worktreeRoot: `/repo/worktrees/${jobId}`,
    branch: `run/${jobId}`,
    boundAt: NOW,
  }
}

function requireSingleEvent(
  value: Omit<OrchestrationEvent, 'sequence'> | ReadonlyArray<Omit<OrchestrationEvent, 'sequence'>>,
): Omit<OrchestrationEvent, 'sequence'>
{
  if (Array.isArray(value))
  {
    throw new Error('Expected one orchestration event.')
  }
  return value as Omit<OrchestrationEvent, 'sequence'>
}

const makeReadModel = Effect.gen(function* ()
{
  const withProject = yield* projectEvent(createEmptyReadModel(NOW), {
    sequence: 1,
    eventId: EventId.make('event-orchestrate-execution-project'),
    aggregateKind: 'project',
    aggregateId: PROJECT_ID,
    type: 'project.created',
    occurredAt: NOW,
    commandId: CommandId.make('command-orchestrate-execution-project'),
    causationEventId: null,
    correlationId: CommandId.make('command-orchestrate-execution-project'),
    metadata: {},
    payload: {
      projectId: PROJECT_ID,
      title: 'Orchestrate execution',
      workspaceRoot: '/repo',
      defaultModelSelection: null,
      scripts: [],
      createdAt: NOW,
      updatedAt: NOW,
    },
  })
  const withThread = yield* projectEvent(withProject, {
    sequence: 2,
    eventId: EventId.make('event-orchestrate-execution-thread'),
    aggregateKind: 'thread',
    aggregateId: THREAD_ID,
    type: 'thread.created',
    occurredAt: NOW,
    commandId: CommandId.make('command-orchestrate-execution-thread'),
    causationEventId: null,
    correlationId: CommandId.make('command-orchestrate-execution-thread'),
    metadata: {},
    payload: {
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      title: 'Thread',
      modelSelection: {
        instanceId: ProviderInstanceId.make('codex'),
        model: 'gpt-5.6',
      },
      interactionMode: 'orchestrate',
      runtimeMode: 'full-access',
      branch: null,
      worktreePath: null,
      origin: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
  })
  const plans = [
    plan('run-a', 1, 101),
    plan('run-a', 2, 102),
    plan('run-a', 3, 103),
    plan('run-b', 1, 201),
  ]
  return {
    ...withThread,
    threads: withThread.threads.map((thread) =>
      thread.id === THREAD_ID
        ? {
            ...thread,
            orchestratePlans: plans,
            session: {
              threadId: THREAD_ID,
              status: 'running' as const,
              providerName: 'codex',
              providerInstanceId: ProviderInstanceId.make('codex'),
              runtimeMode: 'full-access' as const,
              activeTurnId: TURN_ID,
              lastError: null,
              updatedAt: NOW,
            },
            latestTurn: {
              turnId: TURN_ID,
              state: 'running' as const,
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: null,
              assistantMessageId: null,
            },
          }
        : thread,
    ),
    orchestrateRunExecutions: [execution('run-a', 2, 102)],
  }
})

it.layer(NodeServices.layer)('orchestrate execution decider', (it) =>
{
  it.effect('requires monotonic revisions per run while allowing an independent new run', () =>
    Effect.gen(function* ()
    {
      const readModel = yield* makeReadModel
      const stale = yield* decideOrchestrationCommand({
        command: admitCommand('command-admit-stale', execution('run-a', 1, 101)),
        readModel,
      }).pipe(Effect.flip)
      expect(stale).toMatchObject({
        _tag: 'OrchestrationCommandInvariantError',
        code: 'orchestrate-execution-stale-revision',
      })

      const duplicate = yield* decideOrchestrationCommand({
        command: admitCommand('command-admit-duplicate', execution('run-a', 2, 102)),
        readModel,
      }).pipe(Effect.flip)
      expect(duplicate).toMatchObject({
        _tag: 'OrchestrationCommandInvariantError',
        code: 'orchestrate-execution-duplicate',
      })

      const newer = yield* decideOrchestrationCommand({
        command: admitCommand('command-admit-newer', execution('run-a', 3, 103)),
        readModel,
      })
      const newerEvents = 'type' in newer ? [newer] : newer
      expect(newerEvents.map((event) => event.type)).toEqual([
        'thread.orchestrate-run-execution-updated',
        'thread.orchestrate-run-execution-admitted',
      ])

      const independent = yield* decideOrchestrationCommand({
        command: admitCommand('command-admit-independent', execution('run-b', 1, 201)),
        readModel,
      })
      const independentEvents = Array.isArray(independent) ? independent : [independent]
      expect(independentEvents.at(-1)).toMatchObject({
        type: 'thread.orchestrate-run-execution-admitted',
        payload: { execution: { runId: 'run-b', planRevision: 1 } },
      })
    }),
  )

  it.effect('rejects post-terminal updates before they can rewrite frozen evidence', () =>
    Effect.gen(function* ()
    {
      const readModel = yield* makeReadModel
      const completed: OrchestrateRunExecution = {
        ...execution('run-a', 2, 102),
        lifecycle: 'completed',
        availability: 'available',
        integrationRoot: '/repo/worktrees/run-a',
        integrationCommonDir: '/repo/.git',
        integrationBranch: 'run-a',
        integrationOid: 'head-oid',
        observedHeadOid: 'head-oid',
        finalHeadOid: 'head-oid',
        closeReason: 'Completed.',
        updatedAt: LATER,
        terminalAt: LATER,
      }
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: 'thread.orchestrate-run-execution.update',
          commandId: CommandId.make('command-complete-execution'),
          threadId: THREAD_ID,
          expectedProviderInstanceId: ProviderInstanceId.make('codex'),
          execution: completed,
          createdAt: LATER,
        },
        readModel,
      })
      const completedEvent = requireSingleEvent(decided)
      const terminalReadModel = yield* projectEvent(readModel, {
        ...completedEvent,
        sequence: 3,
      } as OrchestrationEvent)
      const retiredAt = '2026-08-09T03:01:30.000Z'
      const retiredExecution: OrchestrateRunExecution = {
        ...completed,
        availability: 'unavailable',
        updatedAt: retiredAt,
      }
      const retirement = yield* decideOrchestrationCommand({
        command: {
          type: 'thread.orchestrate-run-execution.update',
          commandId: CommandId.make('command-retire-terminal-execution-root'),
          threadId: THREAD_ID,
          expectedProviderInstanceId: null,
          execution: retiredExecution,
          createdAt: retiredAt,
        },
        readModel: terminalReadModel,
      })
      const retirementEvent = requireSingleEvent(retirement)
      expect(retirementEvent).toMatchObject({
        type: 'thread.orchestrate-run-execution-updated',
        payload: {
          execution: {
            availability: 'unavailable',
            finalHeadOid: 'head-oid',
            terminalAt: LATER,
          },
        },
      })
      const retiredReadModel = yield* projectEvent(terminalReadModel, {
        ...retirementEvent,
        sequence: 4,
      } as OrchestrationEvent)
      const restoredAt = '2026-08-09T03:01:45.000Z'
      const restoration = yield* decideOrchestrationCommand({
        command: {
          type: 'thread.orchestrate-run-execution.update',
          commandId: CommandId.make('command-restore-terminal-execution-root'),
          threadId: THREAD_ID,
          expectedProviderInstanceId: null,
          execution: {
            ...completed,
            updatedAt: restoredAt,
          },
          createdAt: restoredAt,
        },
        readModel: retiredReadModel,
      })
      const restorationEvent = requireSingleEvent(restoration)
      expect(restorationEvent).toMatchObject({
        type: 'thread.orchestrate-run-execution-updated',
        payload: {
          execution: {
            availability: 'available',
            finalHeadOid: 'head-oid',
            terminalAt: LATER,
          },
        },
      })
      const restoredReadModel = yield* projectEvent(retiredReadModel, {
        ...restorationEvent,
        sequence: 5,
      } as OrchestrationEvent)
      const staleUpdate = yield* decideOrchestrationCommand({
        command: {
          type: 'thread.orchestrate-run-execution.update',
          commandId: CommandId.make('command-rewrite-terminal-execution'),
          threadId: THREAD_ID,
          expectedProviderInstanceId: ProviderInstanceId.make('codex'),
          execution: {
            ...completed,
            integrationOid: 'rewritten-head',
            observedHeadOid: 'rewritten-head',
            finalHeadOid: 'rewritten-head',
            closeReason: 'Rewritten.',
            updatedAt: '2026-08-09T03:02:00.000Z',
            terminalAt: '2026-08-09T03:02:00.000Z',
          },
          createdAt: '2026-08-09T03:02:00.000Z',
        },
        readModel: restoredReadModel,
      }).pipe(Effect.flip)
      expect(staleUpdate).toMatchObject({
        _tag: 'OrchestrationCommandInvariantError',
        code: 'orchestrate-execution-terminal',
      })
    }),
  )

  it.effect('allows exact availability retirement for a historical terminal execution', () =>
    Effect.gen(function* ()
    {
      const readModel = yield* makeReadModel
      const historical: OrchestrateRunExecution = {
        ...execution('run-a', 2, 102),
        lifecycle: 'superseded',
        availability: 'available',
        integrationRoot: '/repo/worktrees/run-a',
        integrationCommonDir: '/repo/.git',
        integrationBranch: 'run-a',
        integrationOid: 'head-oid',
        observedHeadOid: 'head-oid',
        finalHeadOid: 'head-oid',
        closeReason: 'Superseded.',
        current: false,
        updatedAt: LATER,
        terminalAt: LATER,
      }
      const historicalReadModel = {
        ...readModel,
        orchestrateRunExecutions: [historical],
      }
      const retiredAt = '2026-08-09T03:02:00.000Z'
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: 'thread.orchestrate-run-execution.update',
          commandId: CommandId.make('command-retire-historical-execution-root'),
          threadId: THREAD_ID,
          expectedProviderInstanceId: null,
          execution: {
            ...historical,
            availability: 'unavailable',
            updatedAt: retiredAt,
          },
          createdAt: retiredAt,
        },
        readModel: historicalReadModel,
      })

      expect(decided).toMatchObject({
        type: 'thread.orchestrate-run-execution-updated',
        payload: {
          execution: {
            current: false,
            lifecycle: 'superseded',
            availability: 'unavailable',
            finalHeadOid: 'head-oid',
            terminalAt: LATER,
          },
        },
      })
    }),
  )

  it.effect('rechecks live provider-turn authority inside the serialized decider', () =>
    Effect.gen(function* ()
    {
      const readModel = yield* makeReadModel
      const staleAuthority = {
        ...readModel,
        threads: readModel.threads.map((thread) =>
          thread.id === THREAD_ID
            ? {
                ...thread,
                session:
                  thread.session === null
                    ? null
                    : { ...thread.session, status: 'ready' as const, activeTurnId: null },
                latestTurn:
                  thread.latestTurn === null
                    ? null
                    : { ...thread.latestTurn, state: 'completed' as const, completedAt: LATER },
              }
            : thread,
        ),
      }
      const error = yield* decideOrchestrationCommand({
        command: {
          type: 'thread.orchestrate-run-execution.update',
          commandId: CommandId.make('command-expired-execution-authority'),
          threadId: THREAD_ID,
          expectedProviderInstanceId: ProviderInstanceId.make('codex'),
          execution: {
            ...execution('run-a', 2, 102),
            lifecycle: 'completed',
            availability: 'available',
            integrationRoot: '/repo/worktrees/run-a',
            integrationCommonDir: '/repo/.git',
            integrationBranch: 'run-a',
            integrationOid: 'head-oid',
            observedHeadOid: 'head-oid',
            finalHeadOid: 'head-oid',
            closeReason: 'Completed.',
            updatedAt: LATER,
            terminalAt: LATER,
          },
          createdAt: LATER,
        },
        readModel: staleAuthority,
      }).pipe(Effect.flip)

      expect(error).toMatchObject({
        _tag: 'OrchestrationCommandInvariantError',
        code: 'orchestrate-execution-authority-expired',
      })

      const providerMismatch = yield* decideOrchestrationCommand({
        command: {
          type: 'thread.orchestrate-run-execution.update',
          commandId: CommandId.make('command-wrong-provider-execution-authority'),
          threadId: THREAD_ID,
          expectedProviderInstanceId: ProviderInstanceId.make('other-provider'),
          execution: {
            ...execution('run-a', 2, 102),
            lifecycle: 'completed',
            availability: 'available',
            integrationRoot: '/repo/worktrees/run-a',
            integrationCommonDir: '/repo/.git',
            integrationBranch: 'run-a',
            integrationOid: 'head-oid',
            observedHeadOid: 'head-oid',
            finalHeadOid: 'head-oid',
            closeReason: 'Completed.',
            updatedAt: LATER,
            terminalAt: LATER,
          },
          createdAt: LATER,
        },
        readModel,
      }).pipe(Effect.flip)
      expect(providerMismatch).toMatchObject({
        _tag: 'OrchestrationCommandInvariantError',
        code: 'orchestrate-execution-authority-expired',
      })
    }),
  )

  it.effect(
    'terminalizes active execution ownership before session, archive, or delete closure',
    () =>
      Effect.gen(function* ()
      {
        const readModel = yield* makeReadModel
        const session = readModel.threads.find((thread) => thread.id === THREAD_ID)?.session
        if (session === null || session === undefined)
        {
          return yield* Effect.die('Expected live session fixture.')
        }
        const commands = [
          {
            type: 'thread.session.set' as const,
            commandId: CommandId.make('command-end-execution-session'),
            threadId: THREAD_ID,
            session: { ...session, status: 'ready' as const, activeTurnId: null, updatedAt: LATER },
            createdAt: LATER,
          },
          {
            type: 'thread.archive' as const,
            commandId: CommandId.make('command-end-execution-archive'),
            threadId: THREAD_ID,
          },
          {
            type: 'thread.delete' as const,
            commandId: CommandId.make('command-end-execution-delete'),
            threadId: THREAD_ID,
          },
        ]

        for (const command of commands)
        {
          const decided = yield* decideOrchestrationCommand({ command, readModel })
          const events = Array.isArray(decided) ? decided : [decided]
          expect(events[0]).toMatchObject({
            type: 'thread.orchestrate-run-execution-updated',
            payload: {
              execution: {
                lifecycle: 'cancelled',
                finalHeadOid: null,
                terminalAt: expect.any(String),
              },
            },
          })
        }

        const replacementProvider = ProviderInstanceId.make('replacement-provider')
        const providerReplacementReadModel = {
          ...readModel,
          threads: readModel.threads.map((thread) =>
            thread.id === THREAD_ID
              ? {
                  ...thread,
                  modelSelection: {
                    ...thread.modelSelection,
                    instanceId: replacementProvider,
                  },
                }
              : thread,
          ),
        }
        const providerReplacement = yield* decideOrchestrationCommand({
          command: {
            type: 'thread.session.set',
            commandId: CommandId.make('command-replace-execution-provider'),
            threadId: THREAD_ID,
            session: {
              ...session,
              providerInstanceId: replacementProvider,
              updatedAt: LATER,
            },
            createdAt: LATER,
          },
          readModel: providerReplacementReadModel,
        })
        const providerReplacementEvents = Array.isArray(providerReplacement)
          ? providerReplacement
          : [providerReplacement]
        expect(providerReplacementEvents[0]).toMatchObject({
          type: 'thread.orchestrate-run-execution-updated',
          payload: { execution: { lifecycle: 'cancelled' } },
        })
      }),
  )

  it.effect('persists broker job evidence in canonical order independent of request order', () =>
    Effect.gen(function* ()
    {
      const readModel = yield* makeReadModel
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: 'thread.orchestrate-run-execution.update',
          commandId: CommandId.make('command-canonical-job-order'),
          threadId: THREAD_ID,
          expectedProviderInstanceId: ProviderInstanceId.make('codex'),
          execution: {
            ...execution('run-a', 2, 102),
            lifecycle: 'completed',
            availability: 'available',
            integrationRoot: '/repo/worktrees/run-a',
            integrationCommonDir: '/repo/.git',
            integrationBranch: 'run-a',
            integrationOid: 'head-oid',
            observedHeadOid: 'head-oid',
            finalHeadOid: 'head-oid',
            closeReason: 'Completed.',
            updatedAt: LATER,
            terminalAt: LATER,
            jobs: [job('job-z'), job('job-a')],
          },
          createdAt: LATER,
        },
        readModel,
      })
      const event = requireSingleEvent(decided)

      expect(event).toMatchObject({
        type: 'thread.orchestrate-run-execution-updated',
        payload: { execution: { jobs: [{ jobId: 'job-a' }, { jobId: 'job-z' }] } },
      })

      const duplicate = yield* decideOrchestrationCommand({
        command: {
          type: 'thread.orchestrate-run-execution.update',
          commandId: CommandId.make('command-duplicate-job-evidence'),
          threadId: THREAD_ID,
          expectedProviderInstanceId: ProviderInstanceId.make('codex'),
          execution: {
            ...execution('run-a', 2, 102),
            lifecycle: 'completed',
            availability: 'available',
            integrationRoot: '/repo/worktrees/run-a',
            integrationCommonDir: '/repo/.git',
            integrationBranch: 'run-a',
            integrationOid: 'head-oid',
            observedHeadOid: 'head-oid',
            finalHeadOid: 'head-oid',
            closeReason: 'Completed.',
            updatedAt: LATER,
            terminalAt: LATER,
            jobs: [job('job-a'), job('job-a')],
          },
          createdAt: LATER,
        },
        readModel,
      }).pipe(Effect.flip)
      expect(duplicate).toMatchObject({
        _tag: 'OrchestrationCommandInvariantError',
        code: 'orchestrate-execution-job-mutation',
      })
    }),
  )
})
