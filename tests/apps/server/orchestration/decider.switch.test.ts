// tests/apps/server/orchestration/decider.switch.test.ts
// verifies provider-switch decisions and handoff projection state

import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type ThreadProviderSwitchCommand,
} from '@t3tools/contracts'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'

import { decideOrchestrationCommand } from '../../../../apps/server/src/orchestration/decider.ts'
import { projectEvent } from '../../../../apps/server/src/orchestration/projector.ts'

const NOW = '2026-01-01T00:00:00.000Z'
const threadId = ThreadId.make('thread-switch')
const currentModelSelection = {
  instanceId: ProviderInstanceId.make('codex'),
  model: 'gpt-5.6-luna',
}
const targetModelSelection = {
  instanceId: ProviderInstanceId.make('claude'),
  model: 'sonnet',
}

function makeThread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread
{
  return {
    id: threadId,
    projectId: ProjectId.make('project-switch'),
    title: 'Switch thread',
    modelSelection: currentModelSelection,
    runtimeMode: 'full-access',
    interactionMode: 'default',
    branch: null,
    worktreePath: null,
    latestTurn: null,
    pendingHandoff: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    origin: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  }
}

function makeReadModel(thread: OrchestrationThread = makeThread()): OrchestrationReadModel
{
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [thread],
    updatedAt: NOW,
  }
}

const switchCommand = (
  overrides: Partial<ThreadProviderSwitchCommand> = {},
): ThreadProviderSwitchCommand => ({
  type: 'thread.provider.switch' as const,
  commandId: CommandId.make('cmd-provider-switch'),
  threadId,
  targetModelSelection,
  ...overrides,
})

it.layer(NodeServices.layer)('provider switch decider', (it) =>
{
  it.effect('rejects a switch while a turn is running', () =>
    Effect.gen(function* ()
    {
      const error = yield* decideOrchestrationCommand({
        command: switchCommand(),
        readModel: makeReadModel(
          makeThread({
            latestTurn: {
              turnId: TurnId.make('turn-running'),
              state: 'running',
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: null,
              assistantMessageId: null,
            },
          }),
        ),
      }).pipe(Effect.flip)

      expect(error._tag).toBe('OrchestrationCommandInvariantError')
    }),
  )

  it.effect('rejects a switch with an open blocking request', () =>
    Effect.gen(function* ()
    {
      const error = yield* decideOrchestrationCommand({
        command: switchCommand(),
        readModel: makeReadModel(
          makeThread({
            activities: [
              {
                id: EventId.make('activity-approval'),
                tone: 'approval',
                kind: 'approval.requested',
                summary: 'Approval requested',
                payload: { requestId: 'request-1' },
                turnId: null,
                createdAt: NOW,
              },
            ],
          }),
        ),
      }).pipe(Effect.flip)

      expect(error._tag).toBe('OrchestrationCommandInvariantError')
    }),
  )

  it.effect('rejects an expected-instance mismatch', () =>
    Effect.gen(function* ()
    {
      const error = yield* decideOrchestrationCommand({
        command: switchCommand({
          expectedCurrentInstanceId: ProviderInstanceId.make('codex-work'),
        }),
        readModel: makeReadModel(),
      }).pipe(Effect.flip)

      expect(error._tag).toBe('OrchestrationCommandInvariantError')
    }),
  )

  it.effect('rejects a no-op switch to the same instance and model', () =>
    Effect.gen(function* ()
    {
      const error = yield* decideOrchestrationCommand({
        command: switchCommand({ targetModelSelection: currentModelSelection }),
        readModel: makeReadModel(),
      }).pipe(Effect.flip)

      expect(error._tag).toBe('OrchestrationCommandInvariantError')
    }),
  )

  it.effect('emits thread.provider-switch-requested for a valid switch', () =>
    Effect.gen(function* ()
    {
      const event = yield* decideOrchestrationCommand({
        command: switchCommand({ expectedCurrentInstanceId: currentModelSelection.instanceId }),
        readModel: makeReadModel(),
      })
      const events = Array.isArray(event) ? event : [event]

      expect(events).toHaveLength(1)
      expect(events[0]?.type).toBe('thread.provider-switch-requested')
      if (events[0]?.type === 'thread.provider-switch-requested')
      {
        expect(events[0].payload.targetModelSelection).toEqual(targetModelSelection)
        expect(events[0].payload.expectedCurrentInstanceId).toBe(currentModelSelection.instanceId)
      }
    }),
  )

  it.effect('projects provider-switched into model selection and pending handoff', () =>
    Effect.gen(function* ()
    {
      const projected = yield* projectEvent(makeReadModel(), {
        sequence: 1,
        eventId: EventId.make('event-provider-switched'),
        aggregateKind: 'thread',
        aggregateId: threadId,
        type: 'thread.provider-switched',
        occurredAt: NOW,
        commandId: CommandId.make('cmd-provider-switch-complete'),
        causationEventId: null,
        correlationId: CommandId.make('cmd-provider-switch-complete'),
        metadata: {},
        payload: {
          modelSelection: targetModelSelection,
          fromInstanceId: currentModelSelection.instanceId,
          fromModel: currentModelSelection.model,
          handoffText: 'Completed the server workflow.',
        },
      })
      const thread = projected.threads[0]

      expect(thread?.modelSelection).toEqual(targetModelSelection)
      expect(thread?.pendingHandoff).toEqual({
        text: 'Completed the server workflow.',
        fromInstanceId: currentModelSelection.instanceId,
        fromModel: currentModelSelection.model,
        createdAt: NOW,
      })
    }),
  )

  it.effect('projects handoff-cleared by nulling the pending handoff', () =>
    Effect.gen(function* ()
    {
      const readModel = makeReadModel(
        makeThread({
          pendingHandoff: {
            text: 'Prior context',
            fromInstanceId: currentModelSelection.instanceId,
            fromModel: currentModelSelection.model,
            createdAt: NOW,
          },
        }),
      )
      const projected = yield* projectEvent(readModel, {
        sequence: 1,
        eventId: EventId.make('event-handoff-cleared'),
        aggregateKind: 'thread',
        aggregateId: threadId,
        type: 'thread.handoff-cleared',
        occurredAt: NOW,
        commandId: CommandId.make('cmd-handoff-clear'),
        causationEventId: null,
        correlationId: CommandId.make('cmd-handoff-clear'),
        metadata: {},
        payload: { threadId },
      })

      expect(projected.threads[0]?.pendingHandoff).toBeNull()
    }),
  )
})
