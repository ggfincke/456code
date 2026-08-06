// tests/packages/client-runtime/state/threadReducer.test.ts
// verifies thread detail event reduction

import { describe, expect, it } from 'vite-plus/test'

import {
  ApprovalRequestId,
  CheckpointRef,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from '@t3tools/contracts'
import type { OrchestrationThread } from '@t3tools/contracts'

import { applyThreadDetailEvent } from '../../../../packages/client-runtime/src/state/threadReducer.ts'

const baseEventFields = {
  eventId: EventId.make('event-1'),
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
} as const

const importedOrigin = {
  kind: 'imported',
  source: 'claude-code',
  sourcePath: '/imports/claude/session.jsonl',
  contentHash: 'content-hash',
  nativeSessionId: '123e4567-e89b-12d3-a456-426614174000',
  providerInstanceId: ProviderInstanceId.make('claude'),
  importedAt: '2026-04-01T00:30:00.000Z',
} as const

const baseThread: OrchestrationThread = {
  id: ThreadId.make('thread-1'),
  projectId: ProjectId.make('project-1'),
  title: 'Test Thread',
  modelSelection: { instanceId: ProviderInstanceId.make('codex'), model: 'gpt-5.4' },
  runtimeMode: 'full-access',
  interactionMode: 'default',
  branch: null,
  worktreePath: null,
  latestTurn: null,
  providerSwitch: null,
  createdAt: '2026-04-01T00:00:00.000Z',
  updatedAt: '2026-04-01T00:00:00.000Z',
  archivedAt: null,
  origin: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  orchestratePlans: [],
  activities: [],
  checkpoints: [],
  session: null,
}

describe('applyThreadDetailEvent', () =>
{
  describe('project events', () =>
  {
    it('returns unchanged for project.created', () =>
    {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 1,
        occurredAt: '2026-04-01T01:00:00.000Z',
        aggregateKind: 'project',
        aggregateId: ProjectId.make('project-1'),
        type: 'project.created',
        payload: {
          projectId: ProjectId.make('project-1'),
          title: '456code',
          workspaceRoot: '/repo',
          repositoryIdentity: null,
          defaultModelSelection: null,
          scripts: [],
          createdAt: '2026-04-01T01:00:00.000Z',
          updatedAt: '2026-04-01T01:00:00.000Z',
          deletedAt: null,
        },
      } as any)
      expect(result.kind).toBe('unchanged')
    })
  })

  describe('thread.created', () =>
  {
    it('creates a fresh thread', () =>
    {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 1,
        occurredAt: '2026-04-01T01:00:00.000Z',
        aggregateKind: 'thread',
        aggregateId: ThreadId.make('thread-2'),
        type: 'thread.created',
        payload: {
          threadId: ThreadId.make('thread-2'),
          projectId: ProjectId.make('project-1'),
          title: 'New Thread',
          modelSelection: { instanceId: ProviderInstanceId.make('codex'), model: 'gpt-5.4' },
          runtimeMode: 'full-access',
          interactionMode: 'default',
          branch: 'main',
          worktreePath: null,
          origin: importedOrigin,
          createdAt: '2026-04-01T01:00:00.000Z',
          updatedAt: '2026-04-01T01:00:00.000Z',
        },
      })

      expect(result.kind).toBe('updated')
      if (result.kind === 'updated')
      {
        expect(result.thread.id).toBe('thread-2')
        expect(result.thread.title).toBe('New Thread')
        expect(result.thread.branch).toBe('main')
        expect(result.thread.origin).toEqual(importedOrigin)
        expect(result.thread.messages).toEqual([])
        expect(result.thread.session).toBeNull()
      }
    })
  })

  describe('provider switch lifecycle', () =>
  {
    it('clears a pending handoff when durable delivery evidence arrives live', () =>
    {
      const result = applyThreadDetailEvent(
        {
          ...baseThread,
          pendingHandoff: {
            text: 'Continue from this summary.',
            fromInstanceId: ProviderInstanceId.make('codex'),
            fromModel: 'gpt-5.4',
            createdAt: '2026-04-01T01:00:00.000Z',
          },
        },
        {
          ...baseEventFields,
          sequence: 1,
          occurredAt: '2026-04-01T01:00:01.000Z',
          aggregateKind: 'thread',
          aggregateId: baseThread.id,
          type: 'thread.activity-appended',
          payload: {
            threadId: baseThread.id,
            activity: {
              id: EventId.make('provider-handoff-delivered'),
              tone: 'info',
              kind: 'provider.handoff.delivered',
              summary: 'Provider handoff delivered',
              payload: {
                type: 'provider.handoff.delivered',
                handoffKey: 'handoff-key',
                providerSessionIdentity: 'provider-session',
              },
              turnId: null,
              createdAt: '2026-04-01T01:00:01.000Z',
            },
          },
        },
      )

      expect(result.kind).toBe('updated')
      if (result.kind === 'updated')
      {
        expect(result.thread.pendingHandoff).toBeNull()
      }
    })

    it('rebinds the model after the full live switch sequence', () =>
    {
      const requestedAt = '2026-04-01T01:00:00.000Z'
      const targetModelSelection = {
        instanceId: ProviderInstanceId.make('claude'),
        model: 'sonnet',
      }
      const requested = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 1,
        occurredAt: requestedAt,
        aggregateKind: 'thread',
        aggregateId: baseThread.id,
        type: 'thread.provider-switch-requested',
        payload: {
          threadId: baseThread.id,
          targetModelSelection,
          expectedCurrentInstanceId: baseThread.modelSelection.instanceId,
        },
      })
      expect(requested.kind).toBe('updated')
      if (requested.kind !== 'updated') return
      expect(requested.thread.providerSwitch).toEqual({
        phase: 'pending',
        targetInstanceId: targetModelSelection.instanceId,
        targetModel: targetModelSelection.model,
        requestedAt,
        requestId: EventId.make('event-1'),
        requestSequence: 1,
        sourceModelSelection: baseThread.modelSelection,
      })

      const compacting = applyThreadDetailEvent(requested.thread, {
        ...baseEventFields,
        sequence: 2,
        occurredAt: '2026-04-01T01:00:01.000Z',
        aggregateKind: 'thread',
        aggregateId: baseThread.id,
        type: 'thread.provider-switch-progressed',
        payload: { threadId: baseThread.id, phase: 'compacting' },
      })
      expect(compacting.kind).toBe('updated')
      if (compacting.kind !== 'updated') return
      expect(compacting.thread.providerSwitch).toEqual({
        phase: 'compacting',
        targetInstanceId: targetModelSelection.instanceId,
        targetModel: targetModelSelection.model,
        requestedAt,
        requestId: EventId.make('event-1'),
        requestSequence: 1,
        sourceModelSelection: baseThread.modelSelection,
      })

      const finalizing = applyThreadDetailEvent(compacting.thread, {
        ...baseEventFields,
        sequence: 3,
        occurredAt: '2026-04-01T01:00:02.000Z',
        aggregateKind: 'thread',
        aggregateId: baseThread.id,
        type: 'thread.provider-switch-progressed',
        payload: { threadId: baseThread.id, phase: 'finalizing' },
      })
      expect(finalizing.kind).toBe('updated')
      if (finalizing.kind !== 'updated') return
      expect(finalizing.thread.providerSwitch).toEqual({
        phase: 'finalizing',
        targetInstanceId: targetModelSelection.instanceId,
        targetModel: targetModelSelection.model,
        requestedAt,
        requestId: EventId.make('event-1'),
        requestSequence: 1,
        sourceModelSelection: baseThread.modelSelection,
      })

      const switched = applyThreadDetailEvent(finalizing.thread, {
        ...baseEventFields,
        sequence: 4,
        occurredAt: '2026-04-01T01:00:03.000Z',
        aggregateKind: 'thread',
        aggregateId: baseThread.id,
        type: 'thread.provider-switched',
        payload: {
          modelSelection: targetModelSelection,
          fromInstanceId: baseThread.modelSelection.instanceId,
          fromModel: baseThread.modelSelection.model,
          handoffText: 'Continue from this summary.',
        },
      })
      expect(switched.kind).toBe('updated')
      if (switched.kind === 'updated')
      {
        expect(switched.thread.providerSwitch).toBeNull()
        expect(switched.thread.modelSelection).toEqual(targetModelSelection)
        expect(switched.thread.activities).toContainEqual(
          expect.objectContaining({
            id: baseEventFields.eventId,
            kind: 'provider.switch.completed',
            payload: expect.objectContaining({ targetModelSelection }),
          }),
        )
        const historicalPair = applyThreadDetailEvent(switched.thread, {
          ...baseEventFields,
          eventId: EventId.make('event-explicit-provider-switch-completed'),
          sequence: 5,
          occurredAt: '2026-04-01T01:00:04.000Z',
          aggregateKind: 'thread',
          aggregateId: baseThread.id,
          causationEventId: null,
          type: 'thread.activity-appended',
          payload: {
            threadId: baseThread.id,
            activity: {
              id: EventId.make('historical-provider-switch-completed'),
              tone: 'info',
              kind: 'provider.switch.completed',
              summary: 'Provider switch completed',
              payload: {
                fromInstanceId: baseThread.modelSelection.instanceId,
                fromModel: baseThread.modelSelection.model,
                toInstanceId: targetModelSelection.instanceId,
                toModel: targetModelSelection.model,
              },
              turnId: null,
              sequence: 5,
              createdAt: '2026-04-01T01:00:03.000Z',
            },
          },
        })
        expect(historicalPair.kind).toBe('updated')
        if (historicalPair.kind === 'updated')
        {
          expect(historicalPair.thread.activities).toHaveLength(1)
          expect(historicalPair.thread.activities[0]?.id).toBe(
            'historical-provider-switch-completed',
          )
        }
      }
    })

    it('clears a directly failed request without rebinding the model', () =>
    {
      const requested = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 1,
        occurredAt: '2026-04-01T01:00:00.000Z',
        aggregateKind: 'thread',
        aggregateId: baseThread.id,
        type: 'thread.provider-switch-requested',
        payload: {
          threadId: baseThread.id,
          targetModelSelection: {
            instanceId: ProviderInstanceId.make('claude'),
            model: 'sonnet',
          },
          expectedCurrentInstanceId: baseThread.modelSelection.instanceId,
        },
      })
      expect(requested.kind).toBe('updated')
      if (requested.kind !== 'updated') return

      const failed = applyThreadDetailEvent(requested.thread, {
        ...baseEventFields,
        sequence: 2,
        occurredAt: '2026-04-01T01:00:01.000Z',
        aggregateKind: 'thread',
        aggregateId: baseThread.id,
        type: 'thread.provider-switch-failed',
        payload: {
          threadId: baseThread.id,
          reasonCode: 'target-unavailable',
          detail: 'Target provider unavailable.',
        },
      })
      expect(failed.kind).toBe('updated')
      if (failed.kind === 'updated')
      {
        expect(failed.thread.providerSwitch).toBeNull()
        expect(failed.thread.modelSelection).toEqual(baseThread.modelSelection)
        expect(failed.thread.activities).toContainEqual(
          expect.objectContaining({
            id: baseEventFields.eventId,
            kind: 'provider.switch.failed',
          }),
        )
      }
    })

    it('sets, progresses, and clears provider switch state', () =>
    {
      const requestedAt = '2026-04-01T01:00:00.000Z'
      const targetInstanceId = ProviderInstanceId.make('claude')
      const requested = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 1,
        occurredAt: requestedAt,
        aggregateKind: 'thread',
        aggregateId: baseThread.id,
        type: 'thread.provider-switch-requested',
        payload: {
          threadId: baseThread.id,
          targetModelSelection: { instanceId: targetInstanceId, model: 'sonnet' },
          expectedCurrentInstanceId: baseThread.modelSelection.instanceId,
        },
      })
      expect(requested.kind).toBe('updated')
      if (requested.kind !== 'updated') return
      expect(requested.thread.providerSwitch).toEqual({
        phase: 'pending',
        targetInstanceId,
        targetModel: 'sonnet',
        requestedAt,
        requestId: EventId.make('event-1'),
        requestSequence: 1,
        sourceModelSelection: baseThread.modelSelection,
      })

      const progressed = applyThreadDetailEvent(requested.thread, {
        ...baseEventFields,
        sequence: 2,
        occurredAt: '2026-04-01T01:00:01.000Z',
        aggregateKind: 'thread',
        aggregateId: baseThread.id,
        type: 'thread.provider-switch-progressed',
        payload: { threadId: baseThread.id, phase: 'compacting' },
      })
      expect(progressed.kind).toBe('updated')
      if (progressed.kind !== 'updated') return
      expect(progressed.thread.providerSwitch).toEqual({
        phase: 'compacting',
        targetInstanceId,
        targetModel: 'sonnet',
        requestedAt,
        requestId: EventId.make('event-1'),
        requestSequence: 1,
        sourceModelSelection: baseThread.modelSelection,
      })

      const failed = applyThreadDetailEvent(progressed.thread, {
        ...baseEventFields,
        sequence: 3,
        occurredAt: '2026-04-01T01:00:02.000Z',
        aggregateKind: 'thread',
        aggregateId: baseThread.id,
        type: 'thread.provider-switch-failed',
        payload: {
          threadId: baseThread.id,
          reasonCode: 'compaction-failed',
          detail: 'Compaction failed.',
        },
      })
      expect(failed.kind).toBe('updated')
      if (failed.kind === 'updated')
      {
        expect(failed.thread.providerSwitch).toBeNull()
        expect(failed.thread.modelSelection).toEqual(baseThread.modelSelection)
      }
    })

    it('ignores provider switch lifecycle events for a different request', () =>
    {
      const requested = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        eventId: EventId.make('provider-switch-request-a'),
        sequence: 1,
        occurredAt: '2026-04-01T01:00:00.000Z',
        aggregateKind: 'thread',
        aggregateId: baseThread.id,
        type: 'thread.provider-switch-requested',
        payload: {
          threadId: baseThread.id,
          targetModelSelection: {
            instanceId: ProviderInstanceId.make('claude'),
            model: 'sonnet',
          },
          expectedCurrentInstanceId: baseThread.modelSelection.instanceId,
        },
      })
      expect(requested.kind).toBe('updated')
      if (requested.kind !== 'updated') return

      const requestId = EventId.make('provider-switch-request-b')
      const progressed = applyThreadDetailEvent(requested.thread, {
        ...baseEventFields,
        eventId: EventId.make('provider-switch-progressed-b'),
        sequence: 2,
        occurredAt: '2026-04-01T01:00:01.000Z',
        aggregateKind: 'thread',
        aggregateId: baseThread.id,
        type: 'thread.provider-switch-progressed',
        payload: {
          threadId: baseThread.id,
          requestId,
          phase: 'compacting',
        },
      })
      const failed = applyThreadDetailEvent(requested.thread, {
        ...baseEventFields,
        eventId: EventId.make('provider-switch-failed-b'),
        sequence: 3,
        occurredAt: '2026-04-01T01:00:02.000Z',
        aggregateKind: 'thread',
        aggregateId: baseThread.id,
        type: 'thread.provider-switch-failed',
        payload: {
          threadId: baseThread.id,
          requestId,
          reasonCode: 'target-unavailable',
          detail: 'Target provider unavailable.',
        },
      })
      const switched = applyThreadDetailEvent(requested.thread, {
        ...baseEventFields,
        eventId: EventId.make('provider-switched-b'),
        sequence: 4,
        occurredAt: '2026-04-01T01:00:03.000Z',
        aggregateKind: 'thread',
        aggregateId: baseThread.id,
        type: 'thread.provider-switched',
        payload: {
          requestId,
          modelSelection: {
            instanceId: ProviderInstanceId.make('cursor'),
            model: 'composer',
          },
          fromInstanceId: baseThread.modelSelection.instanceId,
          fromModel: baseThread.modelSelection.model,
          handoffText: 'Ignore this stale switch.',
        },
      })

      expect(progressed).toEqual({ kind: 'unchanged' })
      expect(failed).toEqual({ kind: 'unchanged' })
      expect(switched).toEqual({ kind: 'unchanged' })
      expect(requested.thread.providerSwitch).toEqual({
        phase: 'pending',
        targetInstanceId: ProviderInstanceId.make('claude'),
        targetModel: 'sonnet',
        requestedAt: '2026-04-01T01:00:00.000Z',
        requestId: EventId.make('provider-switch-request-a'),
        requestSequence: 1,
        sourceModelSelection: baseThread.modelSelection,
      })
      expect(requested.thread.modelSelection).toEqual(baseThread.modelSelection)
      expect(requested.thread.activities).toEqual([])
    })
  })

  describe('thread.deleted', () =>
  {
    it('returns deleted signal', () =>
    {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 2,
        occurredAt: '2026-04-01T02:00:00.000Z',
        aggregateKind: 'thread',
        aggregateId: ThreadId.make('thread-1'),
        type: 'thread.deleted',
        payload: {
          threadId: ThreadId.make('thread-1'),
          deletedAt: '2026-04-01T02:00:00.000Z',
        },
      })
      expect(result.kind).toBe('deleted')
    })
  })

  describe('thread.archived / thread.unarchived', () =>
  {
    it('sets archivedAt', () =>
    {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 3,
        occurredAt: '2026-04-01T03:00:00.000Z',
        aggregateKind: 'thread',
        aggregateId: ThreadId.make('thread-1'),
        type: 'thread.archived',
        payload: {
          threadId: ThreadId.make('thread-1'),
          archivedAt: '2026-04-01T03:00:00.000Z',
          updatedAt: '2026-04-01T03:00:00.000Z',
        },
      })

      expect(result.kind).toBe('updated')
      if (result.kind === 'updated')
      {
        expect(result.thread.archivedAt).toBe('2026-04-01T03:00:00.000Z')
      }
    })

    it('clears archivedAt', () =>
    {
      const archivedThread = { ...baseThread, archivedAt: '2026-04-01T03:00:00.000Z' }
      const result = applyThreadDetailEvent(archivedThread, {
        ...baseEventFields,
        sequence: 4,
        occurredAt: '2026-04-01T04:00:00.000Z',
        aggregateKind: 'thread',
        aggregateId: ThreadId.make('thread-1'),
        type: 'thread.unarchived',
        payload: {
          threadId: ThreadId.make('thread-1'),
          updatedAt: '2026-04-01T04:00:00.000Z',
        },
      })

      expect(result.kind).toBe('updated')
      if (result.kind === 'updated')
      {
        expect(result.thread.archivedAt).toBeNull()
      }
    })
  })

  describe('thread.settled / thread.unsettled', () =>
  {
    it('sets the settled override and timestamp', () =>
    {
      const settledAt = '2026-04-01T05:00:00.000Z'
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 5,
        occurredAt: settledAt,
        aggregateKind: 'thread',
        aggregateId: ThreadId.make('thread-1'),
        type: 'thread.settled',
        payload: {
          threadId: ThreadId.make('thread-1'),
          settledAt,
          updatedAt: settledAt,
        },
      })

      expect(result.kind).toBe('updated')
      if (result.kind === 'updated')
      {
        expect(result.thread.settledOverride).toBe('settled')
        expect(result.thread.settledAt).toBe(settledAt)
      }
    })

    it.each([
      ['user', 'active'],
      ['activity', null],
    ] as const)('unsettles for %s with override %s', (reason, settledOverride) =>
    {
      const settledThread: OrchestrationThread = {
        ...baseThread,
        settledOverride: 'settled',
        settledAt: '2026-04-01T05:00:00.000Z',
      }
      const updatedAt = '2026-04-01T06:00:00.000Z'
      const result = applyThreadDetailEvent(settledThread, {
        ...baseEventFields,
        sequence: 6,
        occurredAt: updatedAt,
        aggregateKind: 'thread',
        aggregateId: ThreadId.make('thread-1'),
        type: 'thread.unsettled',
        payload: {
          threadId: ThreadId.make('thread-1'),
          reason,
          updatedAt,
        },
      })

      expect(result.kind).toBe('updated')
      if (result.kind === 'updated')
      {
        expect(result.thread.settledOverride).toBe(settledOverride)
        expect(result.thread.settledAt).toBeNull()
      }
    })
  })

  describe('thread.meta-updated', () =>
  {
    it('patches title and branch', () =>
    {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 5,
        occurredAt: '2026-04-01T05:00:00.000Z',
        aggregateKind: 'thread',
        aggregateId: ThreadId.make('thread-1'),
        type: 'thread.meta-updated',
        payload: {
          threadId: ThreadId.make('thread-1'),
          title: 'Updated Title',
          branch: 'feature/demo',
          updatedAt: '2026-04-01T05:00:00.000Z',
        },
      })

      expect(result.kind).toBe('updated')
      if (result.kind === 'updated')
      {
        expect(result.thread.title).toBe('Updated Title')
        expect(result.thread.branch).toBe('feature/demo')
        // model selection should be unchanged since it wasn't in the payload
        expect(result.thread.modelSelection).toEqual(baseThread.modelSelection)
      }
    })
  })

  describe('thread.message-sent', () =>
  {
    it('appends, streams, and updates latestTurn for message sends', () =>
    {
      const appended = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 6,
        occurredAt: '2026-04-01T06:00:00.000Z',
        aggregateKind: 'thread',
        aggregateId: ThreadId.make('thread-1'),
        type: 'thread.message-sent',
        payload: {
          threadId: ThreadId.make('thread-1'),
          messageId: MessageId.make('msg-1'),
          role: 'user',
          text: 'Hello, world!',
          turnId: null,
          streaming: false,
          createdAt: '2026-04-01T06:00:00.000Z',
          updatedAt: '2026-04-01T06:00:00.000Z',
        },
      })
      expect(appended.kind).toBe('updated')
      if (appended.kind === 'updated')
      {
        expect(appended.thread.messages).toHaveLength(1)
        expect(appended.thread.messages[0]?.text).toBe('Hello, world!')
      }

      const threadWithMessage: OrchestrationThread = {
        ...baseThread,
        messages: [
          {
            id: MessageId.make('msg-2'),
            role: 'assistant',
            text: 'Hello',
            turnId: TurnId.make('turn-1'),
            streaming: true,
            createdAt: '2026-04-01T06:00:00.000Z',
            updatedAt: '2026-04-01T06:00:00.000Z',
          },
        ],
      }
      const streamed = applyThreadDetailEvent(threadWithMessage, {
        ...baseEventFields,
        sequence: 7,
        occurredAt: '2026-04-01T06:01:00.000Z',
        aggregateKind: 'thread',
        aggregateId: ThreadId.make('thread-1'),
        type: 'thread.message-sent',
        payload: {
          threadId: ThreadId.make('thread-1'),
          messageId: MessageId.make('msg-2'),
          role: 'assistant',
          text: ', world!',
          turnId: TurnId.make('turn-1'),
          streaming: true,
          createdAt: '2026-04-01T06:00:00.000Z',
          updatedAt: '2026-04-01T06:01:00.000Z',
        },
      })
      expect(streamed.kind).toBe('updated')
      if (streamed.kind === 'updated')
      {
        expect(streamed.thread.messages).toHaveLength(1)
        expect(streamed.thread.messages[0]?.text).toBe('Hello, world!')
      }

      const completed = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 8,
        occurredAt: '2026-04-01T07:00:00.000Z',
        aggregateKind: 'thread',
        aggregateId: ThreadId.make('thread-1'),
        type: 'thread.message-sent',
        payload: {
          threadId: ThreadId.make('thread-1'),
          messageId: MessageId.make('msg-3'),
          role: 'assistant',
          text: 'Done.',
          turnId: TurnId.make('turn-1'),
          streaming: false,
          createdAt: '2026-04-01T07:00:00.000Z',
          updatedAt: '2026-04-01T07:00:00.000Z',
        },
      })
      expect(completed.kind).toBe('updated')
      if (completed.kind === 'updated')
      {
        expect(completed.thread.latestTurn?.turnId).toBe('turn-1')
        expect(completed.thread.latestTurn?.state).toBe('completed')
        expect(completed.thread.latestTurn?.assistantMessageId).toBe('msg-3')
      }
    })

    it('keeps latestTurn running for interim assistant messages while the session runs the turn', () =>
    {
      const threadWithRunningSession: OrchestrationThread = {
        ...baseThread,
        session: {
          threadId: ThreadId.make('thread-1'),
          status: 'running',
          providerName: 'claude',
          runtimeMode: 'full-access',
          activeTurnId: TurnId.make('turn-1'),
          lastError: null,
          updatedAt: '2026-04-01T06:59:00.000Z',
        },
        latestTurn: {
          turnId: TurnId.make('turn-1'),
          state: 'running',
          requestedAt: '2026-04-01T06:59:00.000Z',
          startedAt: '2026-04-01T06:59:00.000Z',
          completedAt: null,
          assistantMessageId: null,
        },
      }

      const result = applyThreadDetailEvent(threadWithRunningSession, {
        ...baseEventFields,
        sequence: 8,
        occurredAt: '2026-04-01T07:00:00.000Z',
        aggregateKind: 'thread',
        aggregateId: ThreadId.make('thread-1'),
        type: 'thread.message-sent',
        payload: {
          threadId: ThreadId.make('thread-1'),
          messageId: MessageId.make('msg-3'),
          role: 'assistant',
          text: 'Interim commentary between tool calls.',
          turnId: TurnId.make('turn-1'),
          streaming: false,
          createdAt: '2026-04-01T07:00:00.000Z',
          updatedAt: '2026-04-01T07:00:00.000Z',
        },
      })

      expect(result.kind).toBe('updated')
      if (result.kind === 'updated')
      {
        expect(result.thread.latestTurn?.state).toBe('running')
        expect(result.thread.latestTurn?.completedAt).toBeNull()
      }
    })
  })

  describe('thread.session-set', () =>
  {
    it('settles a running latestTurn when the session leaves the running status', () =>
    {
      const threadWithRunningTurn: OrchestrationThread = {
        ...baseThread,
        latestTurn: {
          turnId: TurnId.make('turn-1'),
          state: 'running',
          requestedAt: '2026-04-01T07:00:00.000Z',
          startedAt: '2026-04-01T07:00:00.000Z',
          completedAt: null,
          assistantMessageId: MessageId.make('msg-3'),
        },
      }

      const result = applyThreadDetailEvent(threadWithRunningTurn, {
        ...baseEventFields,
        sequence: 9,
        occurredAt: '2026-04-01T08:00:00.000Z',
        aggregateKind: 'thread',
        aggregateId: ThreadId.make('thread-1'),
        type: 'thread.session-set',
        payload: {
          threadId: ThreadId.make('thread-1'),
          session: {
            threadId: ThreadId.make('thread-1'),
            status: 'ready',
            providerName: 'claude',
            runtimeMode: 'full-access',
            activeTurnId: null,
            lastError: null,
            updatedAt: '2026-04-01T08:00:00.000Z',
          },
        },
      })

      expect(result.kind).toBe('updated')
      if (result.kind === 'updated')
      {
        expect(result.thread.latestTurn?.state).toBe('completed')
        expect(result.thread.latestTurn?.completedAt).toBe('2026-04-01T08:00:00.000Z')
      }
    })

    it('updates session and latestTurn for a running session', () =>
    {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 9,
        occurredAt: '2026-04-01T08:00:00.000Z',
        aggregateKind: 'thread',
        aggregateId: ThreadId.make('thread-1'),
        type: 'thread.session-set',
        payload: {
          threadId: ThreadId.make('thread-1'),
          session: {
            threadId: ThreadId.make('thread-1'),
            status: 'running',
            providerName: 'codex',
            runtimeMode: 'full-access',
            activeTurnId: TurnId.make('turn-1'),
            lastError: null,
            updatedAt: '2026-04-01T08:00:00.000Z',
          },
        },
      })

      expect(result.kind).toBe('updated')
      if (result.kind === 'updated')
      {
        expect(result.thread.session?.status).toBe('running')
        expect(result.thread.latestTurn?.turnId).toBe('turn-1')
        expect(result.thread.latestTurn?.state).toBe('running')
      }
    })
  })

  describe('thread.session-stop-requested', () =>
  {
    it('marks session as stopped', () =>
    {
      const threadWithSession: OrchestrationThread = {
        ...baseThread,
        session: {
          threadId: ThreadId.make('thread-1'),
          status: 'running',
          providerName: 'codex',
          runtimeMode: 'full-access',
          activeTurnId: TurnId.make('turn-1'),
          lastError: null,
          updatedAt: '2026-04-01T08:00:00.000Z',
        },
      }

      const result = applyThreadDetailEvent(threadWithSession, {
        ...baseEventFields,
        sequence: 10,
        occurredAt: '2026-04-01T09:00:00.000Z',
        aggregateKind: 'thread',
        aggregateId: ThreadId.make('thread-1'),
        type: 'thread.session-stop-requested',
        payload: {
          threadId: ThreadId.make('thread-1'),
          createdAt: '2026-04-01T09:00:00.000Z',
        },
      })

      // stop requests no longer optimistically mark the session stopped; the
      // authoritative session events own the transition (megacore U-009)
      expect(result.kind).toBe('unchanged')
    })

    it('returns unchanged when no session exists', () =>
    {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 10,
        occurredAt: '2026-04-01T09:00:00.000Z',
        aggregateKind: 'thread',
        aggregateId: ThreadId.make('thread-1'),
        type: 'thread.session-stop-requested',
        payload: {
          threadId: ThreadId.make('thread-1'),
          createdAt: '2026-04-01T09:00:00.000Z',
        },
      })
      expect(result.kind).toBe('unchanged')
    })
  })

  describe('thread.proposed-plan-upserted', () =>
  {
    it('adds a proposed plan', () =>
    {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 11,
        occurredAt: '2026-04-01T10:00:00.000Z',
        aggregateKind: 'thread',
        aggregateId: ThreadId.make('thread-1'),
        type: 'thread.proposed-plan-upserted',
        payload: {
          threadId: ThreadId.make('thread-1'),
          proposedPlan: {
            id: 'plan-1',
            turnId: TurnId.make('turn-1'),
            planMarkdown: '## Plan\n- Do stuff',
            implementedAt: null,
            implementationThreadId: null,
            createdAt: '2026-04-01T10:00:00.000Z',
            updatedAt: '2026-04-01T10:00:00.000Z',
          },
        },
      })

      expect(result.kind).toBe('updated')
      if (result.kind === 'updated')
      {
        expect(result.thread.proposedPlans).toHaveLength(1)
        expect(result.thread.proposedPlans[0]?.id).toBe('plan-1')
      }
    })
  })

  describe('thread.activity-appended', () =>
  {
    it('adds an activity', () =>
    {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 12,
        occurredAt: '2026-04-01T11:00:00.000Z',
        aggregateKind: 'thread',
        aggregateId: ThreadId.make('thread-1'),
        type: 'thread.activity-appended',
        payload: {
          threadId: ThreadId.make('thread-1'),
          activity: {
            id: EventId.make('activity-1'),
            tone: 'tool',
            kind: 'file-edit',
            summary: 'Edited src/index.ts',
            payload: {},
            turnId: TurnId.make('turn-1'),
            createdAt: '2026-04-01T11:00:00.000Z',
          },
        },
      })

      expect(result.kind).toBe('updated')
      if (result.kind === 'updated')
      {
        expect(result.thread.activities).toHaveLength(1)
        expect(result.thread.activities[0]?.kind).toBe('file-edit')
      }
    })

    it('preserves the complete activity history when live events arrive', () =>
    {
      const existingActivities = Array.from({ length: 129 }, (_, index) => ({
        id: EventId.make(`activity-${index}`),
        tone: 'tool' as const,
        kind: 'command',
        summary: `Ran command ${index}`,
        payload: {},
        turnId: TurnId.make('turn-1'),
        sequence: index,
        createdAt: '2026-04-01T11:00:00.000Z',
      }))
      const result = applyThreadDetailEvent(
        { ...baseThread, activities: existingActivities },
        {
          ...baseEventFields,
          sequence: 130,
          occurredAt: '2026-04-01T11:01:00.000Z',
          aggregateKind: 'thread',
          aggregateId: ThreadId.make('thread-1'),
          type: 'thread.activity-appended',
          payload: {
            threadId: ThreadId.make('thread-1'),
            activity: {
              id: EventId.make('activity-129'),
              tone: 'tool',
              kind: 'command',
              summary: 'Ran command 129',
              payload: {},
              turnId: TurnId.make('turn-1'),
              sequence: 129,
              createdAt: '2026-04-01T11:01:00.000Z',
            },
          },
        },
      )

      expect(result.kind).toBe('updated')
      if (result.kind === 'updated')
      {
        expect(result.thread.activities).toHaveLength(130)
        expect(result.thread.activities[0]?.id).toBe('activity-0')
      }
    })

    it('keeps imported history before continued native activities', () =>
    {
      const importedActivity = {
        id: EventId.make('imported-activity'),
        tone: 'info' as const,
        kind: 'task.progress',
        summary: 'Imported history',
        payload: {},
        turnId: null,
        sequence: 100,
        createdAt: '2026-04-01T11:00:00.000Z',
      }
      const result = applyThreadDetailEvent(
        { ...baseThread, activities: [importedActivity] },
        {
          ...baseEventFields,
          sequence: 13,
          occurredAt: '2026-04-01T11:01:00.000Z',
          aggregateKind: 'thread',
          aggregateId: ThreadId.make('thread-1'),
          type: 'thread.activity-appended',
          payload: {
            threadId: ThreadId.make('thread-1'),
            activity: {
              id: EventId.make('native-activity'),
              tone: 'info',
              kind: 'task.progress',
              summary: 'Continued native work',
              payload: {},
              turnId: TurnId.make('turn-native'),
              sequence: 1,
              createdAt: '2026-04-01T11:01:00.000Z',
            },
          },
        },
      )

      expect(result.kind).toBe('updated')
      if (result.kind === 'updated')
      {
        expect(result.thread.activities.map((activity) => activity.id)).toEqual([
          'imported-activity',
          'native-activity',
        ])
      }
    })
  })

  describe('thread.turn-diff-completed', () =>
  {
    it('adds a checkpoint and updates latestTurn', () =>
    {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 13,
        occurredAt: '2026-04-01T12:00:00.000Z',
        aggregateKind: 'thread',
        aggregateId: ThreadId.make('thread-1'),
        type: 'thread.turn-diff-completed',
        payload: {
          threadId: ThreadId.make('thread-1'),
          turnId: TurnId.make('turn-1'),
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make('ref-1'),
          status: 'ready',
          files: [],
          assistantMessageId: MessageId.make('msg-3'),
          completedAt: '2026-04-01T12:00:00.000Z',
        },
      })

      expect(result.kind).toBe('updated')
      if (result.kind === 'updated')
      {
        expect(result.thread.checkpoints).toHaveLength(1)
        expect(result.thread.latestTurn?.turnId).toBe('turn-1')
        expect(result.thread.latestTurn?.state).toBe('completed')
      }
    })
  })

  describe('thread.reverted', () =>
  {
    it('filters entities to retained turns', () =>
    {
      const threadWithData: OrchestrationThread = {
        ...baseThread,
        messages: [
          {
            id: MessageId.make('msg-1'),
            role: 'user',
            text: 'First',
            turnId: null,
            streaming: false,
            createdAt: '2026-04-01T01:00:00.000Z',
            updatedAt: '2026-04-01T01:00:00.000Z',
          },
          {
            id: MessageId.make('msg-2'),
            role: 'assistant',
            text: 'Response 1',
            turnId: TurnId.make('turn-1'),
            streaming: false,
            createdAt: '2026-04-01T02:00:00.000Z',
            updatedAt: '2026-04-01T02:00:00.000Z',
          },
          {
            id: MessageId.make('msg-3'),
            role: 'assistant',
            text: 'Response 2',
            turnId: TurnId.make('turn-2'),
            streaming: false,
            createdAt: '2026-04-01T03:00:00.000Z',
            updatedAt: '2026-04-01T03:00:00.000Z',
          },
        ],
        checkpoints: [
          {
            turnId: TurnId.make('turn-1'),
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make('ref-1'),
            status: 'ready',
            files: [],
            assistantMessageId: MessageId.make('msg-2'),
            completedAt: '2026-04-01T02:00:00.000Z',
          },
          {
            turnId: TurnId.make('turn-2'),
            checkpointTurnCount: 2,
            checkpointRef: CheckpointRef.make('ref-2'),
            status: 'ready',
            files: [],
            assistantMessageId: MessageId.make('msg-3'),
            completedAt: '2026-04-01T03:00:00.000Z',
          },
        ],
      }

      const result = applyThreadDetailEvent(threadWithData, {
        ...baseEventFields,
        sequence: 14,
        occurredAt: '2026-04-01T04:00:00.000Z',
        aggregateKind: 'thread',
        aggregateId: ThreadId.make('thread-1'),
        type: 'thread.reverted',
        payload: {
          threadId: ThreadId.make('thread-1'),
          turnCount: 1,
        },
      })

      expect(result.kind).toBe('updated')
      if (result.kind === 'updated')
      {
        // turn-2 checkpoint is filtered out (turnCount 2 > revert target 1)
        expect(result.thread.checkpoints).toHaveLength(1)
        expect(result.thread.checkpoints[0]?.turnId).toBe('turn-1')
        // msg-3 (turn-2) is filtered, msg-1 (no turn) and msg-2 (turn-1) remain
        expect(result.thread.messages).toHaveLength(2)
        expect(result.thread.latestTurn?.turnId).toBe('turn-1')
      }
    })
  })

  describe('approval response events', () =>
  {
    it('upserts approval outcomes from response-requested events without duplicates', () =>
    {
      const respondingEvent = {
        ...baseEventFields,
        sequence: 15,
        occurredAt: '2026-04-01T13:00:00.000Z',
        aggregateKind: 'thread' as const,
        aggregateId: ThreadId.make('thread-1'),
        type: 'thread.approval-response-requested' as const,
        payload: {
          threadId: ThreadId.make('thread-1'),
          requestId: ApprovalRequestId.make('req-1'),
          decision: 'accept' as const,
          createdAt: '2026-04-01T13:00:00.000Z',
          approvalOutcome: {
            requestId: ApprovalRequestId.make('req-1'),
            status: 'responding' as const,
            requestedDecision: 'accept' as const,
            decision: null,
            actionId: 'action-1',
            updatedAt: '2026-04-01T13:00:00.000Z',
          },
        },
      }
      const first = applyThreadDetailEvent(baseThread, respondingEvent)

      expect(first.kind).toBe('updated')
      if (first.kind !== 'updated') return
      expect(first.thread.approvalOutcomes).toEqual([respondingEvent.payload.approvalOutcome])

      const unknownEvent = {
        ...respondingEvent,
        sequence: 16,
        occurredAt: '2026-04-01T13:00:01.000Z',
        payload: {
          ...respondingEvent.payload,
          approvalOutcome: {
            ...respondingEvent.payload.approvalOutcome,
            status: 'unknown' as const,
            detail: 'Delivery is ambiguous.',
            updatedAt: '2026-04-01T13:00:01.000Z',
          },
        },
      }
      const second = applyThreadDetailEvent(first.thread, unknownEvent)

      expect(second.kind).toBe('updated')
      if (second.kind === 'updated')
      {
        expect(second.thread.approvalOutcomes).toEqual([unknownEvent.payload.approvalOutcome])
        expect(second.thread.activities).toBe(first.thread.activities)
      }
    })

    it('returns unchanged for approval-response-requested', () =>
    {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 15,
        occurredAt: '2026-04-01T13:00:00.000Z',
        aggregateKind: 'thread',
        aggregateId: ThreadId.make('thread-1'),
        type: 'thread.approval-response-requested',
        payload: {
          threadId: ThreadId.make('thread-1'),
          requestId: 'req-1',
          decision: 'approve',
          createdAt: '2026-04-01T13:00:00.000Z',
        },
      } as any)
      expect(result.kind).toBe('unchanged')
    })
  })
})
