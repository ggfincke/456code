// tests/apps/server/orchestration/decider.workerVerdict.test.ts
// verifies worker verdict command validation, emission, and replacement

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WORKER_VERDICT_MAX_LENGTH,
} from '@t3tools/contracts'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'

import { decideOrchestrationCommand } from '../../../../apps/server/src/orchestration/decider.ts'
import {
  createEmptyReadModel,
  projectEvent,
} from '../../../../apps/server/src/orchestration/projector.ts'

const NOW = '2026-08-06T12:00:00.000Z'
const THREAD_ID = ThreadId.make('thread-worker-verdict')

const makeReadModel = Effect.gen(function* ()
{
  const withProject = yield* projectEvent(createEmptyReadModel(NOW), {
    sequence: 1,
    eventId: EventId.make('event-worker-verdict-project'),
    aggregateKind: 'project',
    aggregateId: ProjectId.make('project-worker-verdict'),
    type: 'project.created',
    occurredAt: NOW,
    commandId: CommandId.make('command-worker-verdict-project'),
    causationEventId: null,
    correlationId: CommandId.make('command-worker-verdict-project'),
    metadata: {},
    payload: {
      projectId: ProjectId.make('project-worker-verdict'),
      title: 'Worker verdicts',
      workspaceRoot: '/tmp/worker-verdicts',
      defaultModelSelection: null,
      scripts: [],
      createdAt: NOW,
      updatedAt: NOW,
    },
  })
  return yield* projectEvent(withProject, {
    sequence: 2,
    eventId: EventId.make('event-worker-verdict-thread'),
    aggregateKind: 'thread',
    aggregateId: THREAD_ID,
    type: 'thread.created',
    occurredAt: NOW,
    commandId: CommandId.make('command-worker-verdict-thread'),
    causationEventId: null,
    correlationId: CommandId.make('command-worker-verdict-thread'),
    metadata: {},
    payload: {
      threadId: THREAD_ID,
      projectId: ProjectId.make('project-worker-verdict'),
      title: 'Thread',
      modelSelection: {
        instanceId: ProviderInstanceId.make('codex'),
        model: 'gpt-5.6',
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: 'full-access',
      branch: null,
      worktreePath: null,
      origin: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
  })
})

const command = (
  commandId: string,
  verdict: string,
  runId = 'run-1',
  jobId = 'job-1',
): Extract<OrchestrationCommand, { readonly type: 'thread.worker-verdict.set' }> => ({
  type: 'thread.worker-verdict.set',
  commandId: CommandId.make(commandId),
  threadId: THREAD_ID,
  runId,
  jobId,
  verdict,
  createdAt: NOW,
})

// mirrors the decider's own result shape; `Omit` over the event union is not distributive, so this
// flat form keeps only the shared keys & widens `payload` to unknown
type PlannedOrchestrationEvent = Omit<OrchestrationEvent, 'sequence'>

// `Extract` picks the single union member first, so this one keeps its concrete `payload` & stays
// assignable to `projectEvent` once `sequence` is spread back on
type PlannedActivityAppendedEvent = Omit<
  Extract<OrchestrationEvent, { readonly type: 'thread.activity-appended' }>,
  'sequence'
>

// `Array.isArray` is typed `arg is any[]`, so it never drops ReadonlyArray from the decider's union;
// `in` does, & the predicate restores the discriminated member the flat form loses
function isActivityAppendedEvent(
  result: PlannedOrchestrationEvent | ReadonlyArray<PlannedOrchestrationEvent>,
): result is PlannedActivityAppendedEvent
{
  return 'type' in result && result.type === 'thread.activity-appended'
}

it.layer(NodeServices.layer)('worker verdict decider', (it) =>
{
  it.effect('emits a durable activity and replaces the same run/job verdict', () =>
    Effect.gen(function* ()
    {
      const readModel = yield* makeReadModel
      const first = yield* decideOrchestrationCommand({
        command: command('command-worker-verdict-first', '  needs follow-up  '),
        readModel,
      })
      if (!isActivityAppendedEvent(first))
      {
        throw new Error('Expected one worker verdict activity event.')
      }
      expect(first.payload.activity).toMatchObject({
        id: 'worker-verdict:run-1:job-1',
        kind: 'orchestrate.worker.verdict',
        payload: { runId: 'run-1', jobId: 'job-1', verdict: 'needs follow-up' },
        turnId: null,
      })

      const withFirst = yield* projectEvent(readModel, { ...first, sequence: 3 })
      const second = yield* decideOrchestrationCommand({
        command: command('command-worker-verdict-second', 'approved'),
        readModel: withFirst,
      })
      if (!isActivityAppendedEvent(second))
      {
        throw new Error('Expected one replacement worker verdict activity event.')
      }
      const withSecond = yield* projectEvent(withFirst, { ...second, sequence: 4 })
      expect(
        withSecond.threads.find((thread) => thread.id === THREAD_ID)?.activities,
      ).toMatchObject([{ payload: { verdict: 'approved' } }])
      const cleared = yield* decideOrchestrationCommand({
        command: command('command-worker-verdict-cleared', ''),
        readModel: withSecond,
      })
      if (!isActivityAppendedEvent(cleared))
      {
        throw new Error('Expected one cleared worker verdict activity event.')
      }
      const withCleared = yield* projectEvent(withSecond, { ...cleared, sequence: 5 })
      const activities = withCleared.threads.find((thread) => thread.id === THREAD_ID)?.activities

      expect(activities).toHaveLength(1)
      expect(activities?.[0]).toMatchObject({
        id: 'worker-verdict:run-1:job-1',
        payload: { verdict: '' },
        turnId: null,
      })
    }),
  )

  it.effect('rejects empty ids and oversized verdicts', () =>
    Effect.gen(function* ()
    {
      const readModel = yield* makeReadModel
      const emptyIdError = yield* decideOrchestrationCommand({
        command: command('command-worker-verdict-empty-id', 'approved', '   '),
        readModel,
      }).pipe(Effect.flip)
      const oversizedError = yield* decideOrchestrationCommand({
        command: command(
          'command-worker-verdict-oversized',
          'x'.repeat(WORKER_VERDICT_MAX_LENGTH + 1),
        ),
        readModel,
      }).pipe(Effect.flip)

      expect(emptyIdError.message).toContain('run and job ids must be non-empty')
      expect(oversizedError.message).toContain(`at most ${WORKER_VERDICT_MAX_LENGTH} characters`)
    }),
  )
})
