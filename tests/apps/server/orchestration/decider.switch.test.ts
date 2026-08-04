// tests/apps/server/orchestration/decider.switch.test.ts
// verifies provider-switch decisions and handoff projection state

import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
  type OrchestrationThread,
  ThreadProviderSwitchCommand,
} from '@t3tools/contracts'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

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
    providerSwitch: null,
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
  expectedCurrentInstanceId: currentModelSelection.instanceId,
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
      expect(error._tag === 'OrchestrationCommandInvariantError' ? error.code : undefined).toBe(
        'switch-running-turn',
      )
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
      expect(error._tag === 'OrchestrationCommandInvariantError' ? error.code : undefined).toBe(
        'switch-blocking-request',
      )
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
      expect(error._tag === 'OrchestrationCommandInvariantError' ? error.code : undefined).toBe(
        'switch-instance-mismatch',
      )
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
      expect(error._tag === 'OrchestrationCommandInvariantError' ? error.code : undefined).toBe(
        'switch-same-instance',
      )
    }),
  )

  it.effect('requires the expected current provider instance', () =>
    Effect.gen(function* ()
    {
      const result = yield* Schema.decodeUnknownEffect(ThreadProviderSwitchCommand)({
        type: 'thread.provider.switch',
        commandId: CommandId.make('cmd-provider-switch-missing-expected'),
        threadId,
        targetModelSelection,
      }).pipe(Effect.result)

      expect(result._tag).toBe('Failure')
    }),
  )

  it.effect('rejects a switch while another switch is in progress', () =>
    Effect.gen(function* ()
    {
      const error = yield* decideOrchestrationCommand({
        command: switchCommand(),
        readModel: makeReadModel(
          makeThread({
            providerSwitch: {
              phase: 'compacting',
              targetInstanceId: targetModelSelection.instanceId,
              targetModel: targetModelSelection.model,
              requestedAt: NOW,
            },
          }),
        ),
      }).pipe(Effect.flip)

      expect(error._tag).toBe('OrchestrationCommandInvariantError')
      expect(error._tag === 'OrchestrationCommandInvariantError' ? error.code : undefined).toBe(
        'switch-in-progress',
      )
    }),
  )

  it.effect('rejects a switch with a queued turn start', () =>
    Effect.gen(function* ()
    {
      // decider clock is the TestClock at epoch -> keeps the queued message inside the grace window
      const queuedAt = '1970-01-01T00:00:00.000Z'
      const error = yield* decideOrchestrationCommand({
        command: switchCommand(),
        readModel: makeReadModel(
          makeThread({
            messages: [
              {
                id: MessageId.make('message-queued'),
                role: 'user',
                text: 'queued',
                turnId: null,
                streaming: false,
                createdAt: queuedAt,
                updatedAt: queuedAt,
              },
            ],
          }),
        ),
      }).pipe(Effect.flip)

      expect(error._tag).toBe('OrchestrationCommandInvariantError')
      expect(error._tag === 'OrchestrationCommandInvariantError' ? error.code : undefined).toBe(
        'switch-queued-turn',
      )
    }),
  )

  it.effect('rejects turn start while a provider switch is in progress', () =>
    Effect.gen(function* ()
    {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: 'thread.turn.start',
          commandId: CommandId.make('cmd-turn-start-during-switch'),
          threadId,
          message: {
            messageId: MessageId.make('message-turn-start-during-switch'),
            role: 'user',
            text: 'continue',
            attachments: [],
          },
          runtimeMode: 'full-access',
          interactionMode: 'default',
          createdAt: NOW,
        },
        readModel: makeReadModel(
          makeThread({
            providerSwitch: {
              phase: 'pending',
              targetInstanceId: targetModelSelection.instanceId,
              targetModel: targetModelSelection.model,
              requestedAt: NOW,
            },
          }),
        ),
      }).pipe(Effect.flip)

      expect(error._tag).toBe('OrchestrationCommandInvariantError')
      expect(error._tag === 'OrchestrationCommandInvariantError' ? error.code : undefined).toBe(
        'turn-start-during-switch',
      )
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

  it.effect('rejects a second terminal command after the request owner completes', () =>
    Effect.gen(function* ()
    {
      const requestId = EventId.make('provider-switch-owner')
      const completed = yield* decideOrchestrationCommand({
        command: {
          type: 'thread.provider.switch.complete',
          commandId: CommandId.make('cmd-provider-switch-owner-complete'),
          threadId,
          requestId,
          sourceModelSelection: currentModelSelection,
          modelSelection: targetModelSelection,
          fromInstanceId: currentModelSelection.instanceId,
          fromModel: currentModelSelection.model,
          handoffText: 'handoff',
        },
        readModel: makeReadModel(
          makeThread({
            providerSwitch: {
              phase: 'finalizing',
              targetInstanceId: targetModelSelection.instanceId,
              targetModel: targetModelSelection.model,
              requestedAt: NOW,
              requestId,
              requestSequence: 1,
              sourceModelSelection: currentModelSelection,
            },
          }),
        ),
      })
      const terminalEvent = Array.isArray(completed) ? completed[0]! : completed
      const terminalReadModel = yield* projectEvent(
        makeReadModel(
          makeThread({
            providerSwitch: {
              phase: 'finalizing',
              targetInstanceId: targetModelSelection.instanceId,
              targetModel: targetModelSelection.model,
              requestedAt: NOW,
              requestId,
              requestSequence: 1,
              sourceModelSelection: currentModelSelection,
            },
          }),
        ),
        { ...terminalEvent, sequence: 2 },
      )
      const error = yield* decideOrchestrationCommand({
        command: {
          type: 'thread.provider.switch.fail',
          commandId: CommandId.make('cmd-provider-switch-owner-fail'),
          threadId,
          requestId,
          sourceModelSelection: currentModelSelection,
          targetModelSelection,
          reasonCode: 'internal-error',
          detail: 'late failure',
        },
        readModel: terminalReadModel,
      }).pipe(Effect.flip)

      expect(error._tag).toBe('OrchestrationCommandInvariantError')
    }),
  )

  it.effect('atomically fails the owned switch and repairs its idle running session', () =>
    Effect.gen(function* ()
    {
      const requestId = EventId.make('provider-switch-owned-failure')
      const decision = yield* decideOrchestrationCommand({
        command: {
          type: 'thread.provider.switch.fail',
          commandId: CommandId.make('cmd-provider-switch-owned-failure'),
          threadId,
          requestId,
          sourceModelSelection: currentModelSelection,
          targetModelSelection,
          reasonCode: 'compaction-failed',
          detail: 'Compaction failed.',
        },
        readModel: makeReadModel(
          makeThread({
            providerSwitch: {
              phase: 'compacting',
              targetInstanceId: targetModelSelection.instanceId,
              targetModel: targetModelSelection.model,
              requestedAt: NOW,
              requestId,
              sourceModelSelection: currentModelSelection,
            },
            session: {
              threadId,
              status: 'running',
              providerName: 'codex',
              providerInstanceId: currentModelSelection.instanceId,
              runtimeMode: 'full-access',
              activeTurnId: null,
              lastError: null,
              updatedAt: NOW,
            },
          }),
        ),
      })
      const events = Array.isArray(decision) ? decision : [decision]

      expect(events.map((event) => event.type)).toEqual([
        'thread.provider-switch-failed',
        'thread.session-set',
      ])
      expect(
        events[1]?.type === 'thread.session-set' ? events[1].payload.session.status : null,
      ).toBe('ready')
    }),
  )

  it.effect('does not let an older switch request repair a newer running session', () =>
    Effect.gen(function* ()
    {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: 'thread.provider.switch.fail',
          commandId: CommandId.make('cmd-provider-switch-stale-failure'),
          threadId,
          requestId: EventId.make('provider-switch-old-request'),
          sourceModelSelection: currentModelSelection,
          targetModelSelection,
          reasonCode: 'internal-error',
          detail: 'Late failure.',
        },
        readModel: makeReadModel(
          makeThread({
            providerSwitch: {
              phase: 'compacting',
              targetInstanceId: targetModelSelection.instanceId,
              targetModel: targetModelSelection.model,
              requestedAt: NOW,
              requestId: EventId.make('provider-switch-new-request'),
              sourceModelSelection: currentModelSelection,
            },
            session: {
              threadId,
              status: 'running',
              providerName: 'codex',
              providerInstanceId: currentModelSelection.instanceId,
              runtimeMode: 'full-access',
              activeTurnId: null,
              lastError: null,
              updatedAt: NOW,
            },
          }),
        ),
      }).pipe(Effect.flip)

      expect(error._tag).toBe('OrchestrationCommandInvariantError')
      expect(error._tag === 'OrchestrationCommandInvariantError' ? error.code : undefined).toBe(
        'stale-provider-switch-request',
      )
    }),
  )
})
