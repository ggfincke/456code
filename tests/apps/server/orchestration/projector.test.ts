// tests/apps/server/orchestration/projector.test.ts
// verifies in-memory orchestration projections

import {
  CommandId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  type OrchestrationEvent,
} from '@t3tools/contracts'
import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'

import {
  createEmptyReadModel,
  projectEvent,
} from '../../../../apps/server/src/orchestration/projector.ts'

function makeEvent(input: {
  sequence: number
  type: OrchestrationEvent['type']
  occurredAt: string
  aggregateKind: OrchestrationEvent['aggregateKind']
  aggregateId: string
  commandId: string | null
  payload: unknown
}): OrchestrationEvent
{
  return {
    sequence: input.sequence,
    eventId: EventId.make(`event-${input.sequence}`),
    type: input.type,
    aggregateKind: input.aggregateKind,
    aggregateId:
      input.aggregateKind === 'project'
        ? ProjectId.make(input.aggregateId)
        : ThreadId.make(input.aggregateId),
    occurredAt: input.occurredAt,
    commandId: input.commandId === null ? null : CommandId.make(input.commandId),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent
}

describe('orchestration projector', () =>
{
  it('applies thread.created events', async () =>
  {
    const now = '2026-01-01T00:00:00.000Z'
    const model = createEmptyReadModel(now)

    const next = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: 'thread.created',
          aggregateKind: 'thread',
          aggregateId: 'thread-1',
          occurredAt: now,
          commandId: 'cmd-thread-create',
          payload: {
            threadId: 'thread-1',
            projectId: 'project-1',
            title: 'demo',
            modelSelection: {
              provider: ProviderDriverKind.make('codex'),
              model: 'gpt-5-codex',
            },
            runtimeMode: 'full-access',
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        }),
      ),
    )

    expect(next.snapshotSequence).toBe(1)
    expect(next.threads).toEqual([
      {
        id: 'thread-1',
        projectId: 'project-1',
        title: 'demo',
        modelSelection: {
          instanceId: 'codex',
          model: 'gpt-5-codex',
        },
        runtimeMode: 'full-access',
        interactionMode: 'default',
        branch: null,
        worktreePath: null,
        latestTurn: null,
        pendingHandoff: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        origin: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        approvalOutcomes: [],
        session: null,
      },
    ])
  })

  it.effect('projects provider switch outcomes from their terminal events', () =>
    Effect.gen(function* ()
    {
      const now = '2026-01-01T00:00:00.000Z'
      const threadId = 'thread-provider-switch-outcomes'
      let model = yield* projectEvent(
        createEmptyReadModel(now),
        makeEvent({
          sequence: 1,
          type: 'thread.created',
          aggregateKind: 'thread',
          aggregateId: threadId,
          occurredAt: now,
          commandId: 'cmd-create-provider-switch-outcomes',
          payload: {
            threadId,
            projectId: 'project-1',
            title: 'Provider switch outcomes',
            modelSelection: { instanceId: 'codex', model: 'gpt-5-codex' },
            runtimeMode: 'full-access',
            interactionMode: 'default',
            branch: null,
            worktreePath: null,
            origin: null,
            createdAt: now,
            updatedAt: now,
          },
        }),
      )
      model = yield* projectEvent(
        model,
        makeEvent({
          sequence: 2,
          type: 'thread.provider-switch-requested',
          aggregateKind: 'thread',
          aggregateId: threadId,
          occurredAt: now,
          commandId: 'cmd-request-provider-switch-failure',
          payload: {
            threadId,
            targetModelSelection: { instanceId: 'claudeAgent', model: 'sonnet' },
            expectedCurrentInstanceId: 'codex',
          },
        }),
      )
      model = yield* projectEvent(
        model,
        makeEvent({
          sequence: 3,
          type: 'thread.provider-switch-failed',
          aggregateKind: 'thread',
          aggregateId: threadId,
          occurredAt: now,
          commandId: 'cmd-fail-provider-switch',
          payload: {
            threadId,
            reasonCode: 'compaction-failed',
            detail: 'Compaction failed.',
          },
        }),
      )
      model = yield* projectEvent(
        model,
        makeEvent({
          sequence: 4,
          type: 'thread.provider-switch-requested',
          aggregateKind: 'thread',
          aggregateId: threadId,
          occurredAt: now,
          commandId: 'cmd-request-provider-switch-completion',
          payload: {
            threadId,
            targetModelSelection: { instanceId: 'claudeAgent', model: 'sonnet' },
            expectedCurrentInstanceId: 'codex',
          },
        }),
      )
      model = yield* projectEvent(
        model,
        makeEvent({
          sequence: 5,
          type: 'thread.provider-switched',
          aggregateKind: 'thread',
          aggregateId: threadId,
          occurredAt: now,
          commandId: 'cmd-complete-provider-switch',
          payload: {
            modelSelection: { instanceId: 'claudeAgent', model: 'sonnet' },
            fromInstanceId: 'codex',
            fromModel: 'gpt-5-codex',
            handoffText: 'Durable handoff.',
          },
        }),
      )

      const thread = model.threads[0]
      expect(thread?.providerSwitch).toBeNull()
      expect(thread?.pendingHandoff?.text).toBe('Durable handoff.')
      expect(thread?.activities).toMatchObject([
        {
          id: 'event-3',
          kind: 'provider.switch.failed',
          payload: {
            reasonCode: 'compaction-failed',
            retryTargetModelSelection: { instanceId: 'claudeAgent', model: 'sonnet' },
          },
        },
        {
          id: 'event-5',
          kind: 'provider.switch.completed',
          payload: {
            targetModelSelection: { instanceId: 'claudeAgent', model: 'sonnet' },
          },
        },
      ])

      model = yield* projectEvent(
        model,
        makeEvent({
          sequence: 6,
          type: 'thread.activity-appended',
          aggregateKind: 'thread',
          aggregateId: threadId,
          occurredAt: now,
          commandId: 'cmd-record-provider-handoff-delivery',
          payload: {
            threadId,
            activity: {
              id: 'provider-handoff-delivered',
              tone: 'info',
              kind: 'provider.handoff.delivered',
              summary: 'Provider handoff delivered',
              payload: {
                type: 'provider.handoff.delivered',
                handoffKey: 'durable-handoff-key',
                providerSessionIdentity: 'provider-session-1',
              },
              turnId: null,
              createdAt: now,
            },
          },
        }),
      )
      expect(model.threads[0]?.pendingHandoff).toBeNull()

      model = yield* projectEvent(
        model,
        makeEvent({
          sequence: 7,
          type: 'thread.activity-appended',
          aggregateKind: 'thread',
          aggregateId: threadId,
          occurredAt: now,
          commandId: 'cmd-append-historical-failure-activity',
          payload: {
            threadId,
            activity: {
              id: 'historical-provider-switch-failed',
              tone: 'error',
              kind: 'provider.switch.failed',
              summary: 'Provider switch failed',
              payload: { detail: 'Compaction failed.' },
              turnId: null,
              sequence: 3,
              createdAt: now,
            },
          },
        }),
      )
      model = yield* projectEvent(
        model,
        makeEvent({
          sequence: 8,
          type: 'thread.activity-appended',
          aggregateKind: 'thread',
          aggregateId: threadId,
          occurredAt: now,
          commandId: 'cmd-append-historical-completion-activity',
          payload: {
            threadId,
            activity: {
              id: 'historical-provider-switch-completed',
              tone: 'info',
              kind: 'provider.switch.completed',
              summary: 'Provider switch completed',
              payload: {
                fromInstanceId: 'codex',
                fromModel: 'gpt-5-codex',
                toInstanceId: 'claudeAgent',
                toModel: 'sonnet',
              },
              turnId: null,
              sequence: 5,
              createdAt: now,
            },
          },
        }),
      )
      expect(model.threads[0]?.activities.map((activity) => activity.id)).toEqual([
        'historical-provider-switch-failed',
        'historical-provider-switch-completed',
        'provider-handoff-delivered',
      ])
    }),
  )

  it.effect('keeps imported history before continued native activities', () =>
    Effect.gen(function* ()
    {
      const createdAt = '2026-01-01T00:00:00.000Z'
      let model = yield* projectEvent(
        createEmptyReadModel(createdAt),
        makeEvent({
          sequence: 1,
          type: 'thread.created',
          aggregateKind: 'thread',
          aggregateId: 'thread-mixed-activity-order',
          occurredAt: createdAt,
          commandId: 'cmd-thread-mixed-activity-order',
          payload: {
            threadId: 'thread-mixed-activity-order',
            projectId: 'project-1',
            title: 'Imported then continued',
            modelSelection: {
              provider: ProviderDriverKind.make('codex'),
              model: 'gpt-5-codex',
            },
            runtimeMode: 'approval-required',
            interactionMode: 'default',
            branch: null,
            worktreePath: null,
            origin: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      )

      for (const [eventSequence, activity] of [
        [
          2,
          {
            id: 'imported-activity',
            tone: 'info',
            kind: 'task.progress',
            summary: 'Imported history',
            payload: {},
            turnId: null,
            sequence: 100,
            createdAt: '2026-01-01T00:00:01.000Z',
          },
        ],
        [
          3,
          {
            id: 'native-activity',
            tone: 'info',
            kind: 'task.progress',
            summary: 'Continued native work',
            payload: {},
            turnId: 'turn-native',
            sequence: 1,
            createdAt: '2026-01-01T00:00:02.000Z',
          },
        ],
      ] as const)
      {
        model = yield* projectEvent(
          model,
          makeEvent({
            sequence: eventSequence,
            type: 'thread.activity-appended',
            aggregateKind: 'thread',
            aggregateId: 'thread-mixed-activity-order',
            occurredAt: activity.createdAt,
            commandId: `cmd-activity-${eventSequence}`,
            payload: {
              threadId: 'thread-mixed-activity-order',
              activity,
            },
          }),
        )
      }

      expect(model.threads[0]?.activities.map((activity) => activity.id)).toEqual([
        'imported-activity',
        'native-activity',
      ])
    }),
  )

  it.effect('retains 500 live activities plus imported continuation authority', () =>
    Effect.gen(function* ()
    {
      const importedAt = '2026-01-01T00:00:00.000Z'
      let model = yield* projectEvent(
        createEmptyReadModel(importedAt),
        makeEvent({
          sequence: 1,
          type: 'thread.created',
          aggregateKind: 'thread',
          aggregateId: 'thread-import-retention',
          occurredAt: importedAt,
          commandId: 'cmd-thread-import-retention',
          payload: {
            threadId: 'thread-import-retention',
            projectId: 'project-1',
            title: 'Imported timeline',
            modelSelection: {
              provider: ProviderDriverKind.make('codex'),
              model: 'gpt-5-codex',
            },
            runtimeMode: 'approval-required',
            interactionMode: 'default',
            branch: null,
            worktreePath: null,
            origin: {
              kind: 'imported',
              source: 'codex-cli',
              sourcePath: '/tmp/import.jsonl',
              contentHash: 'import-hash',
              nativeSessionId: 'native-import',
              providerInstanceId: 'codex',
              importedAt,
            },
            createdAt: importedAt,
            updatedAt: importedAt,
          },
        }),
      )

      model = yield* projectEvent(
        model,
        makeEvent({
          sequence: 2,
          type: 'thread.activity-appended',
          aggregateKind: 'thread',
          aggregateId: 'thread-import-retention',
          occurredAt: '2026-01-01T00:00:00.001Z',
          commandId: 'cmd-import-marker',
          payload: {
            threadId: 'thread-import-retention',
            activity: {
              id: 'import-continuation-marker',
              tone: 'info',
              kind: 'task.completed',
              summary: 'Native codex continuation verified',
              payload: {
                type: 'import.continuation',
                driverKind: 'codex',
                continuation: {
                  state: 'verified',
                  providerInstanceId: 'codex',
                  reason: null,
                },
              },
              turnId: null,
              sequence: 0,
              createdAt: '2026-01-01T00:00:00.001Z',
            },
          },
        }),
      )

      for (let index = 0; index < 500; index += 1)
      {
        const isApproval = index === 0
        const createdAt = `2026-01-01T00:${String(Math.floor(index / 60)).padStart(
          2,
          '0',
        )}:${String(index % 60).padStart(2, '0')}.100Z`
        model = yield* projectEvent(
          model,
          makeEvent({
            sequence: index + 3,
            type: 'thread.activity-appended',
            aggregateKind: 'thread',
            aggregateId: 'thread-import-retention',
            occurredAt: createdAt,
            commandId: `cmd-live-activity-${index}`,
            payload: {
              threadId: 'thread-import-retention',
              activity: {
                id: isApproval
                  ? 'live-approval'
                  : `live-activity-${String(index).padStart(3, '0')}`,
                tone: isApproval ? 'approval' : 'info',
                kind: isApproval ? 'approval.requested' : 'task.progress',
                summary: isApproval ? 'Approve live command' : `Live activity ${index}`,
                payload: isApproval ? { requestId: 'approval-live' } : {},
                turnId: null,
                createdAt,
              },
            },
          }),
        )
      }

      const activities = model.threads[0]?.activities ?? []
      expect(activities).toHaveLength(501)
      expect(activities.some((activity) => activity.id === 'live-approval')).toBe(true)
      expect(activities.some((activity) => activity.id === 'import-continuation-marker')).toBe(true)
      expect(
        activities
          .filter((activity) => activity.id.startsWith('live-'))
          .map((activity) => activity.id),
      ).toHaveLength(500)
    }),
  )

  it.effect('compacts finalized imported history while retaining command state', () =>
    Effect.gen(function* ()
    {
      const importedAt = '2026-01-01T00:00:00.000Z'
      const threadId = 'thread-finalized-import'
      let model = yield* projectEvent(
        createEmptyReadModel(importedAt),
        makeEvent({
          sequence: 1,
          type: 'thread.created',
          aggregateKind: 'thread',
          aggregateId: threadId,
          occurredAt: importedAt,
          commandId: 'cmd-thread-finalized-import',
          payload: {
            threadId,
            projectId: 'project-1',
            title: 'Imported timeline',
            modelSelection: {
              provider: ProviderDriverKind.make('codex'),
              model: 'gpt-5-codex',
            },
            runtimeMode: 'approval-required',
            interactionMode: 'default',
            branch: null,
            worktreePath: null,
            origin: {
              kind: 'imported',
              source: 'codex-cli',
              sourcePath: '/tmp/import.jsonl',
              contentHash: 'import-hash',
              nativeSessionId: 'native-import',
              providerInstanceId: 'codex',
              importedAt,
            },
            createdAt: importedAt,
            updatedAt: importedAt,
          },
        }),
      )

      const importedEvents = [
        makeEvent({
          sequence: 2,
          type: 'thread.message-sent',
          aggregateKind: 'thread',
          aggregateId: threadId,
          occurredAt: '2026-01-01T00:00:01.000Z',
          commandId: 'cmd-imported-message',
          payload: {
            threadId,
            messageId: 'imported-message',
            role: 'user',
            text: 'Historical prompt',
            turnId: null,
            streaming: false,
            createdAt: '2026-01-01T00:00:01.000Z',
            updatedAt: '2026-01-01T00:00:01.000Z',
          },
        }),
        makeEvent({
          sequence: 3,
          type: 'thread.activity-appended',
          aggregateKind: 'thread',
          aggregateId: threadId,
          occurredAt: '2026-01-01T00:00:02.000Z',
          commandId: 'cmd-imported-activity',
          payload: {
            threadId,
            activity: {
              id: 'imported-tool',
              tone: 'info',
              kind: 'tool.completed',
              summary: 'Historical tool result',
              payload: { output: 'large imported body' },
              turnId: null,
              sequence: 1,
              createdAt: '2026-01-01T00:00:02.000Z',
            },
          },
        }),
        makeEvent({
          sequence: 4,
          type: 'thread.activity-appended',
          aggregateKind: 'thread',
          aggregateId: threadId,
          occurredAt: '2026-01-01T00:00:03.000Z',
          commandId: 'cmd-imported-approval',
          payload: {
            threadId,
            activity: {
              id: 'imported-approval',
              tone: 'approval',
              kind: 'approval.requested',
              summary: 'Approval requested',
              payload: { requestId: 'approval-imported' },
              turnId: null,
              sequence: 2,
              createdAt: '2026-01-01T00:00:03.000Z',
            },
          },
        }),
      ]
      for (const event of importedEvents)
      {
        model = yield* projectEvent(model, event)
      }

      model = yield* projectEvent(
        model,
        makeEvent({
          sequence: 5,
          type: 'thread.activity-appended',
          aggregateKind: 'thread',
          aggregateId: threadId,
          occurredAt: '2026-01-01T00:00:04.000Z',
          commandId: 'cmd-import-finalized',
          payload: {
            threadId,
            activity: {
              id: 'import-continuation-marker',
              tone: 'info',
              kind: 'task.completed',
              summary: 'Native codex continuation verified',
              payload: {
                type: 'import.continuation',
                driverKind: 'codex',
                continuation: {
                  state: 'verified',
                  providerInstanceId: 'codex',
                  continuationIdentity: {
                    driverKind: 'codex',
                    continuationKey: 'codex:native-import',
                  },
                  reason: null,
                },
              },
              turnId: null,
              sequence: 3,
              createdAt: '2026-01-01T00:00:04.000Z',
            },
          },
        }),
      )

      const finalizedThread = model.threads[0]
      expect(finalizedThread?.messages).toEqual([])
      expect(finalizedThread?.checkpoints).toEqual([])
      expect(finalizedThread?.activities.map((activity) => activity.id)).toEqual([
        'imported-approval',
        'import-continuation-marker',
      ])
      expect(finalizedThread?.origin?.contentHash).toBe('import-hash')
      expect(model.snapshotSequence).toBe(5)

      const continued = yield* projectEvent(
        model,
        makeEvent({
          sequence: 6,
          type: 'thread.message-sent',
          aggregateKind: 'thread',
          aggregateId: threadId,
          occurredAt: '2026-01-01T00:00:05.000Z',
          commandId: 'cmd-live-message',
          payload: {
            threadId,
            messageId: 'live-message',
            role: 'user',
            text: 'Continue this session',
            turnId: null,
            streaming: false,
            createdAt: '2026-01-01T00:00:05.000Z',
            updatedAt: '2026-01-01T00:00:05.000Z',
          },
        }),
      )
      expect(continued.threads[0]?.messages.map((message) => message.id)).toEqual(['live-message'])
    }),
  )

  it('fails when event payload cannot be decoded by runtime schema', async () =>
  {
    const now = '2026-01-01T00:00:00.000Z'
    const model = createEmptyReadModel(now)

    await expect(
      Effect.runPromise(
        projectEvent(
          model,
          makeEvent({
            sequence: 1,
            type: 'thread.created',
            aggregateKind: 'thread',
            aggregateId: 'thread-1',
            occurredAt: now,
            commandId: 'cmd-invalid',
            payload: {
              // missing required threadId
              projectId: 'project-1',
              title: 'demo',
              modelSelection: {
                provider: ProviderDriverKind.make('codex'),
                model: 'gpt-5-codex',
              },
              branch: null,
              worktreePath: null,
              createdAt: now,
              updatedAt: now,
            },
          }),
        ),
      ),
    ).rejects.toBeDefined()
  })

  it('applies thread.archived and thread.unarchived events', async () =>
  {
    const now = '2026-01-01T00:00:00.000Z'
    const later = '2026-01-01T00:00:01.000Z'
    const created = await Effect.runPromise(
      projectEvent(
        createEmptyReadModel(now),
        makeEvent({
          sequence: 1,
          type: 'thread.created',
          aggregateKind: 'thread',
          aggregateId: 'thread-1',
          occurredAt: now,
          commandId: 'cmd-thread-create',
          payload: {
            threadId: 'thread-1',
            projectId: 'project-1',
            title: 'demo',
            modelSelection: {
              provider: ProviderDriverKind.make('codex'),
              model: 'gpt-5-codex',
            },
            runtimeMode: 'full-access',
            interactionMode: 'default',
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        }),
      ),
    )

    const archived = await Effect.runPromise(
      projectEvent(
        created,
        makeEvent({
          sequence: 2,
          type: 'thread.archived',
          aggregateKind: 'thread',
          aggregateId: 'thread-1',
          occurredAt: later,
          commandId: 'cmd-thread-archive',
          payload: {
            threadId: 'thread-1',
            archivedAt: later,
            updatedAt: later,
          },
        }),
      ),
    )
    expect(archived.threads[0]?.archivedAt).toBe(later)

    const unarchived = await Effect.runPromise(
      projectEvent(
        archived,
        makeEvent({
          sequence: 3,
          type: 'thread.unarchived',
          aggregateKind: 'thread',
          aggregateId: 'thread-1',
          occurredAt: later,
          commandId: 'cmd-thread-unarchive',
          payload: {
            threadId: 'thread-1',
            updatedAt: later,
          },
        }),
      ),
    )
    expect(unarchived.threads[0]?.archivedAt).toBeNull()
  })

  it('keeps projector forward-compatible for unhandled event types', async () =>
  {
    const now = '2026-01-01T00:00:00.000Z'
    const model = createEmptyReadModel(now)

    const next = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 7,
          type: 'thread.turn-start-requested',
          aggregateKind: 'thread',
          aggregateId: 'thread-1',
          occurredAt: '2026-01-01T00:00:00.000Z',
          commandId: 'cmd-unhandled',
          payload: {
            threadId: 'thread-1',
            messageId: 'message-1',
            runtimeMode: 'approval-required',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        }),
      ),
    )

    expect(next.snapshotSequence).toBe(7)
    expect(next.updatedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(next.threads).toEqual([])
  })

  it('tracks latest turn id from session lifecycle events', async () =>
  {
    const createdAt = '2026-02-23T08:00:00.000Z'
    const startedAt = '2026-02-23T08:00:05.000Z'
    const model = createEmptyReadModel(createdAt)

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: 'thread.created',
          aggregateKind: 'thread',
          aggregateId: 'thread-1',
          occurredAt: createdAt,
          commandId: 'cmd-create',
          payload: {
            threadId: 'thread-1',
            projectId: 'project-1',
            title: 'demo',
            modelSelection: {
              provider: ProviderDriverKind.make('codex'),
              model: 'gpt-5.3-codex',
            },
            runtimeMode: 'full-access',
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    )

    const settledAt = '2026-02-23T08:01:00.000Z'
    const [afterRunning, afterReady] = await Effect.runPromise(
      Effect.flatMap(
        projectEvent(
          afterCreate,
          makeEvent({
            sequence: 2,
            type: 'thread.session-set',
            aggregateKind: 'thread',
            aggregateId: 'thread-1',
            occurredAt: startedAt,
            commandId: 'cmd-running',
            payload: {
              threadId: 'thread-1',
              session: {
                threadId: 'thread-1',
                status: 'running',
                providerName: 'codex',
                providerSessionId: 'session-1',
                providerThreadId: 'provider-thread-1',
                runtimeMode: 'approval-required',
                activeTurnId: 'turn-1',
                lastError: null,
                updatedAt: startedAt,
              },
            },
          }),
        ),
        (running) =>
          Effect.map(
            projectEvent(
              running,
              makeEvent({
                sequence: 3,
                type: 'thread.session-set',
                aggregateKind: 'thread',
                aggregateId: 'thread-1',
                occurredAt: settledAt,
                commandId: 'cmd-ready',
                payload: {
                  threadId: 'thread-1',
                  session: {
                    threadId: 'thread-1',
                    status: 'ready',
                    providerName: 'codex',
                    providerSessionId: 'session-1',
                    providerThreadId: 'provider-thread-1',
                    runtimeMode: 'approval-required',
                    activeTurnId: null,
                    lastError: null,
                    updatedAt: settledAt,
                  },
                },
              }),
            ),
            (ready) => [running, ready] as const,
          ),
      ),
    )

    const thread = afterRunning.threads[0]
    expect(thread?.latestTurn?.turnId).toBe('turn-1')
    expect(thread?.session?.status).toBe('running')

    // Leaving the "running" session status settles the running turn with the
    // session timestamp as the turn end.
    const settledThread = afterReady.threads[0]
    expect(settledThread?.latestTurn?.turnId).toBe('turn-1')
    expect(settledThread?.latestTurn?.state).toBe('completed')
    expect(settledThread?.latestTurn?.completedAt).toBe(settledAt)
  })

  it('updates canonical thread runtime mode from thread.runtime-mode-set', async () =>
  {
    const createdAt = '2026-02-23T08:00:00.000Z'
    const updatedAt = '2026-02-23T08:00:05.000Z'
    const model = createEmptyReadModel(createdAt)

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: 'thread.created',
          aggregateKind: 'thread',
          aggregateId: 'thread-1',
          occurredAt: createdAt,
          commandId: 'cmd-create',
          payload: {
            threadId: 'thread-1',
            projectId: 'project-1',
            title: 'demo',
            modelSelection: {
              provider: ProviderDriverKind.make('codex'),
              model: 'gpt-5.3-codex',
            },
            runtimeMode: 'full-access',
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    )

    const afterUpdate = await Effect.runPromise(
      projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: 'thread.runtime-mode-set',
          aggregateKind: 'thread',
          aggregateId: 'thread-1',
          occurredAt: updatedAt,
          commandId: 'cmd-runtime-mode-set',
          payload: {
            threadId: 'thread-1',
            runtimeMode: 'approval-required',
            updatedAt,
          },
        }),
      ),
    )

    expect(afterUpdate.threads[0]?.runtimeMode).toBe('approval-required')
    expect(afterUpdate.threads[0]?.updatedAt).toBe(updatedAt)
  })

  it('marks assistant messages completed with non-streaming updates', async () =>
  {
    const createdAt = '2026-02-23T09:00:00.000Z'
    const deltaAt = '2026-02-23T09:00:01.000Z'
    const completeAt = '2026-02-23T09:00:03.500Z'
    const model = createEmptyReadModel(createdAt)

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: 'thread.created',
          aggregateKind: 'thread',
          aggregateId: 'thread-1',
          occurredAt: createdAt,
          commandId: 'cmd-create',
          payload: {
            threadId: 'thread-1',
            projectId: 'project-1',
            title: 'demo',
            modelSelection: {
              provider: ProviderDriverKind.make('codex'),
              model: 'gpt-5.3-codex',
            },
            runtimeMode: 'full-access',
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    )

    const afterDelta = await Effect.runPromise(
      projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: 'thread.message-sent',
          aggregateKind: 'thread',
          aggregateId: 'thread-1',
          occurredAt: deltaAt,
          commandId: 'cmd-delta',
          payload: {
            threadId: 'thread-1',
            messageId: 'assistant:msg-1',
            role: 'assistant',
            text: 'hello',
            turnId: 'turn-1',
            streaming: true,
            createdAt: deltaAt,
            updatedAt: deltaAt,
          },
        }),
      ),
    )

    const afterComplete = await Effect.runPromise(
      projectEvent(
        afterDelta,
        makeEvent({
          sequence: 3,
          type: 'thread.message-sent',
          aggregateKind: 'thread',
          aggregateId: 'thread-1',
          occurredAt: completeAt,
          commandId: 'cmd-complete',
          payload: {
            threadId: 'thread-1',
            messageId: 'assistant:msg-1',
            role: 'assistant',
            text: '',
            turnId: 'turn-1',
            streaming: false,
            createdAt: completeAt,
            updatedAt: completeAt,
          },
        }),
      ),
    )

    const message = afterComplete.threads[0]?.messages[0]
    expect(message?.id).toBe('assistant:msg-1')
    expect(message?.text).toBe('hello')
    expect(message?.streaming).toBe(false)
    expect(message?.updatedAt).toBe(completeAt)
  })

  it('prunes reverted turn messages from in-memory thread snapshot', async () =>
  {
    const createdAt = '2026-02-23T10:00:00.000Z'
    const model = createEmptyReadModel(createdAt)

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: 'thread.created',
          aggregateKind: 'thread',
          aggregateId: 'thread-1',
          occurredAt: createdAt,
          commandId: 'cmd-create',
          payload: {
            threadId: 'thread-1',
            projectId: 'project-1',
            title: 'demo',
            modelSelection: {
              provider: ProviderDriverKind.make('codex'),
              model: 'gpt-5.3-codex',
            },
            runtimeMode: 'full-access',
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    )

    const events: ReadonlyArray<OrchestrationEvent> = [
      makeEvent({
        sequence: 2,
        type: 'thread.message-sent',
        aggregateKind: 'thread',
        aggregateId: 'thread-1',
        occurredAt: '2026-02-23T10:00:01.000Z',
        commandId: 'cmd-user-1',
        payload: {
          threadId: 'thread-1',
          messageId: 'user-msg-1',
          role: 'user',
          text: 'First edit',
          turnId: null,
          streaming: false,
          createdAt: '2026-02-23T10:00:01.000Z',
          updatedAt: '2026-02-23T10:00:01.000Z',
        },
      }),
      makeEvent({
        sequence: 3,
        type: 'thread.message-sent',
        aggregateKind: 'thread',
        aggregateId: 'thread-1',
        occurredAt: '2026-02-23T10:00:02.000Z',
        commandId: 'cmd-assistant-1',
        payload: {
          threadId: 'thread-1',
          messageId: 'assistant-msg-1',
          role: 'assistant',
          text: 'Updated README to v2.\n',
          turnId: 'turn-1',
          streaming: false,
          createdAt: '2026-02-23T10:00:02.000Z',
          updatedAt: '2026-02-23T10:00:02.000Z',
        },
      }),
      makeEvent({
        sequence: 4,
        type: 'thread.turn-diff-completed',
        aggregateKind: 'thread',
        aggregateId: 'thread-1',
        occurredAt: '2026-02-23T10:00:02.500Z',
        commandId: 'cmd-turn-1-complete',
        payload: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          checkpointTurnCount: 1,
          checkpointRef: 'refs/t3/checkpoints/thread-1/turn/1',
          status: 'ready',
          files: [],
          assistantMessageId: 'assistant-msg-1',
          completedAt: '2026-02-23T10:00:02.500Z',
        },
      }),
      makeEvent({
        sequence: 5,
        type: 'thread.activity-appended',
        aggregateKind: 'thread',
        aggregateId: 'thread-1',
        occurredAt: '2026-02-23T10:00:02.750Z',
        commandId: 'cmd-activity-1',
        payload: {
          threadId: 'thread-1',
          activity: {
            id: 'activity-1',
            tone: 'tool',
            kind: 'tool.started',
            summary: 'Edit file started',
            payload: { toolKind: 'command' },
            turnId: 'turn-1',
            createdAt: '2026-02-23T10:00:02.750Z',
          },
        },
      }),
      makeEvent({
        sequence: 6,
        type: 'thread.message-sent',
        aggregateKind: 'thread',
        aggregateId: 'thread-1',
        occurredAt: '2026-02-23T10:00:03.000Z',
        commandId: 'cmd-user-2',
        payload: {
          threadId: 'thread-1',
          messageId: 'user-msg-2',
          role: 'user',
          text: 'Second edit',
          turnId: null,
          streaming: false,
          createdAt: '2026-02-23T10:00:03.000Z',
          updatedAt: '2026-02-23T10:00:03.000Z',
        },
      }),
      makeEvent({
        sequence: 7,
        type: 'thread.message-sent',
        aggregateKind: 'thread',
        aggregateId: 'thread-1',
        occurredAt: '2026-02-23T10:00:04.000Z',
        commandId: 'cmd-assistant-2',
        payload: {
          threadId: 'thread-1',
          messageId: 'assistant-msg-2',
          role: 'assistant',
          text: 'Updated README to v3.\n',
          turnId: 'turn-2',
          streaming: false,
          createdAt: '2026-02-23T10:00:04.000Z',
          updatedAt: '2026-02-23T10:00:04.000Z',
        },
      }),
      makeEvent({
        sequence: 8,
        type: 'thread.turn-diff-completed',
        aggregateKind: 'thread',
        aggregateId: 'thread-1',
        occurredAt: '2026-02-23T10:00:04.500Z',
        commandId: 'cmd-turn-2-complete',
        payload: {
          threadId: 'thread-1',
          turnId: 'turn-2',
          checkpointTurnCount: 2,
          checkpointRef: 'refs/t3/checkpoints/thread-1/turn/2',
          status: 'ready',
          files: [],
          assistantMessageId: 'assistant-msg-2',
          completedAt: '2026-02-23T10:00:04.500Z',
        },
      }),
      makeEvent({
        sequence: 9,
        type: 'thread.activity-appended',
        aggregateKind: 'thread',
        aggregateId: 'thread-1',
        occurredAt: '2026-02-23T10:00:04.750Z',
        commandId: 'cmd-activity-2',
        payload: {
          threadId: 'thread-1',
          activity: {
            id: 'activity-2',
            tone: 'tool',
            kind: 'tool.completed',
            summary: 'Edit file complete',
            payload: { toolKind: 'command' },
            turnId: 'turn-2',
            createdAt: '2026-02-23T10:00:04.750Z',
          },
        },
      }),
      makeEvent({
        sequence: 10,
        type: 'thread.reverted',
        aggregateKind: 'thread',
        aggregateId: 'thread-1',
        occurredAt: '2026-02-23T10:00:05.000Z',
        commandId: 'cmd-revert',
        payload: {
          threadId: 'thread-1',
          turnCount: 1,
        },
      }),
    ]

    const afterRevert = await events.reduce<Promise<ReturnType<typeof createEmptyReadModel>>>(
      (statePromise, event) =>
        statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
      Promise.resolve(afterCreate),
    )

    const thread = afterRevert.threads[0]
    expect(thread?.messages.map((message) => ({ role: message.role, text: message.text }))).toEqual(
      [
        { role: 'user', text: 'First edit' },
        { role: 'assistant', text: 'Updated README to v2.\n' },
      ],
    )
    expect(
      thread?.activities.map((activity) => ({ id: activity.id, turnId: activity.turnId })),
    ).toEqual([{ id: 'activity-1', turnId: 'turn-1' }])
    expect(thread?.checkpoints.map((checkpoint) => checkpoint.checkpointTurnCount)).toEqual([1])
    expect(thread?.latestTurn?.turnId).toBe('turn-1')
  })

  it('does not fallback-retain messages tied to removed turn IDs', async () =>
  {
    const createdAt = '2026-02-26T12:00:00.000Z'
    const model = createEmptyReadModel(createdAt)

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: 'thread.created',
          aggregateKind: 'thread',
          aggregateId: 'thread-revert',
          occurredAt: createdAt,
          commandId: 'cmd-create-revert',
          payload: {
            threadId: 'thread-revert',
            projectId: 'project-1',
            title: 'demo',
            modelSelection: {
              provider: ProviderDriverKind.make('codex'),
              model: 'gpt-5.3-codex',
            },
            runtimeMode: 'full-access',
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    )

    const events: ReadonlyArray<OrchestrationEvent> = [
      makeEvent({
        sequence: 2,
        type: 'thread.turn-diff-completed',
        aggregateKind: 'thread',
        aggregateId: 'thread-revert',
        occurredAt: '2026-02-26T12:00:01.000Z',
        commandId: 'cmd-turn-1',
        payload: {
          threadId: 'thread-revert',
          turnId: 'turn-1',
          checkpointTurnCount: 1,
          checkpointRef: 'refs/t3/checkpoints/thread-revert/turn/1',
          status: 'ready',
          files: [],
          assistantMessageId: 'assistant-keep',
          completedAt: '2026-02-26T12:00:01.000Z',
        },
      }),
      makeEvent({
        sequence: 3,
        type: 'thread.message-sent',
        aggregateKind: 'thread',
        aggregateId: 'thread-revert',
        occurredAt: '2026-02-26T12:00:01.100Z',
        commandId: 'cmd-assistant-keep',
        payload: {
          threadId: 'thread-revert',
          messageId: 'assistant-keep',
          role: 'assistant',
          text: 'kept',
          turnId: 'turn-1',
          streaming: false,
          createdAt: '2026-02-26T12:00:01.100Z',
          updatedAt: '2026-02-26T12:00:01.100Z',
        },
      }),
      makeEvent({
        sequence: 4,
        type: 'thread.turn-diff-completed',
        aggregateKind: 'thread',
        aggregateId: 'thread-revert',
        occurredAt: '2026-02-26T12:00:02.000Z',
        commandId: 'cmd-turn-2',
        payload: {
          threadId: 'thread-revert',
          turnId: 'turn-2',
          checkpointTurnCount: 2,
          checkpointRef: 'refs/t3/checkpoints/thread-revert/turn/2',
          status: 'ready',
          files: [],
          assistantMessageId: 'assistant-remove',
          completedAt: '2026-02-26T12:00:02.000Z',
        },
      }),
      makeEvent({
        sequence: 5,
        type: 'thread.message-sent',
        aggregateKind: 'thread',
        aggregateId: 'thread-revert',
        occurredAt: '2026-02-26T12:00:02.050Z',
        commandId: 'cmd-user-remove',
        payload: {
          threadId: 'thread-revert',
          messageId: 'user-remove',
          role: 'user',
          text: 'removed',
          turnId: 'turn-2',
          streaming: false,
          createdAt: '2026-02-26T12:00:02.050Z',
          updatedAt: '2026-02-26T12:00:02.050Z',
        },
      }),
      makeEvent({
        sequence: 6,
        type: 'thread.message-sent',
        aggregateKind: 'thread',
        aggregateId: 'thread-revert',
        occurredAt: '2026-02-26T12:00:02.100Z',
        commandId: 'cmd-assistant-remove',
        payload: {
          threadId: 'thread-revert',
          messageId: 'assistant-remove',
          role: 'assistant',
          text: 'removed',
          turnId: 'turn-2',
          streaming: false,
          createdAt: '2026-02-26T12:00:02.100Z',
          updatedAt: '2026-02-26T12:00:02.100Z',
        },
      }),
      makeEvent({
        sequence: 7,
        type: 'thread.reverted',
        aggregateKind: 'thread',
        aggregateId: 'thread-revert',
        occurredAt: '2026-02-26T12:00:03.000Z',
        commandId: 'cmd-revert',
        payload: {
          threadId: 'thread-revert',
          turnCount: 1,
        },
      }),
    ]

    const afterRevert = await events.reduce<Promise<ReturnType<typeof createEmptyReadModel>>>(
      (statePromise, event) =>
        statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
      Promise.resolve(afterCreate),
    )

    const thread = afterRevert.threads[0]
    expect(
      thread?.messages.map((message) => ({
        id: message.id,
        role: message.role,
        turnId: message.turnId,
      })),
    ).toEqual([{ id: 'assistant-keep', role: 'assistant', turnId: 'turn-1' }])
  })

  it('caps message and checkpoint retention for long-lived threads', async () =>
  {
    const createdAt = '2026-03-01T10:00:00.000Z'
    const model = createEmptyReadModel(createdAt)

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: 'thread.created',
          aggregateKind: 'thread',
          aggregateId: 'thread-capped',
          occurredAt: createdAt,
          commandId: 'cmd-create-capped',
          payload: {
            threadId: 'thread-capped',
            projectId: 'project-1',
            title: 'capped',
            modelSelection: {
              provider: ProviderDriverKind.make('codex'),
              model: 'gpt-5-codex',
            },
            runtimeMode: 'full-access',
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    )

    const messageEvents: ReadonlyArray<OrchestrationEvent> = Array.from(
      { length: 2_100 },
      (_, index) =>
        makeEvent({
          sequence: index + 2,
          type: 'thread.message-sent',
          aggregateKind: 'thread',
          aggregateId: 'thread-capped',
          occurredAt: `2026-03-01T10:00:${String(index % 60).padStart(2, '0')}.000Z`,
          commandId: `cmd-message-${index}`,
          payload: {
            threadId: 'thread-capped',
            messageId: `msg-${index}`,
            role: 'assistant',
            text: `message-${index}`,
            turnId: `turn-${index}`,
            streaming: false,
            createdAt: `2026-03-01T10:00:${String(index % 60).padStart(2, '0')}.000Z`,
            updatedAt: `2026-03-01T10:00:${String(index % 60).padStart(2, '0')}.000Z`,
          },
        }),
    )
    const afterMessages = await messageEvents.reduce<
      Promise<ReturnType<typeof createEmptyReadModel>>
    >(
      (statePromise, event) =>
        statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
      Promise.resolve(afterCreate),
    )

    const checkpointEvents: ReadonlyArray<OrchestrationEvent> = Array.from(
      { length: 600 },
      (_, index) =>
        makeEvent({
          sequence: index + 2_102,
          type: 'thread.turn-diff-completed',
          aggregateKind: 'thread',
          aggregateId: 'thread-capped',
          occurredAt: `2026-03-01T10:30:${String(index % 60).padStart(2, '0')}.000Z`,
          commandId: `cmd-checkpoint-${index}`,
          payload: {
            threadId: 'thread-capped',
            turnId: `turn-${index}`,
            checkpointTurnCount: index + 1,
            checkpointRef: `refs/t3/checkpoints/thread-capped/turn/${index + 1}`,
            status: 'ready',
            files: [],
            assistantMessageId: `msg-${index}`,
            completedAt: `2026-03-01T10:30:${String(index % 60).padStart(2, '0')}.000Z`,
          },
        }),
    )
    const finalState = await checkpointEvents.reduce<
      Promise<ReturnType<typeof createEmptyReadModel>>
    >(
      (statePromise, event) =>
        statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
      Promise.resolve(afterMessages),
    )

    const thread = finalState.threads[0]
    expect(thread?.messages).toHaveLength(2_000)
    expect(thread?.messages[0]?.id).toBe('msg-100')
    expect(thread?.messages.at(-1)?.id).toBe('msg-2099')
    expect(thread?.checkpoints).toHaveLength(500)
    expect(thread?.checkpoints[0]?.turnId).toBe('turn-100')
    expect(thread?.checkpoints.at(-1)?.turnId).toBe('turn-599')
  })
})
