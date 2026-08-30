// tests/apps/server/orchestration/projector.pinned.test.ts
// verifies thread pin projection and same-id recreation reset

import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
} from '@t3tools/contracts'
import { expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'

import {
  createEmptyReadModel,
  projectEvent,
} from '../../../../apps/server/src/orchestration/projector.ts'

const NOW = '2026-01-01T00:00:00.000Z'

function makeEvent(input: {
  readonly sequence: number
  readonly type: OrchestrationEvent['type']
  readonly payload: unknown
}): OrchestrationEvent
{
  return {
    sequence: input.sequence,
    eventId: EventId.make(`event-${input.sequence}`),
    type: input.type,
    aggregateKind: 'thread',
    aggregateId: ThreadId.make('thread-1'),
    occurredAt: NOW,
    commandId: CommandId.make(`command-${input.sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent
}

function threadCreated(sequence: number): OrchestrationEvent
{
  return makeEvent({
    sequence,
    type: 'thread.created',
    payload: {
      threadId: ThreadId.make('thread-1'),
      projectId: ProjectId.make('project-1'),
      title: 'Thread',
      modelSelection: {
        instanceId: ProviderInstanceId.make('codex'),
        model: 'gpt-5.4',
      },
      runtimeMode: 'full-access',
      interactionMode: 'default',
      branch: null,
      worktreePath: null,
      origin: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
  })
}

it.effect('projects pin lifecycle events', () =>
  Effect.gen(function* ()
  {
    const created = yield* projectEvent(createEmptyReadModel(NOW), threadCreated(1))
    expect(created.threads[0]?.pinnedAt).toBeNull()

    const pinned = yield* projectEvent(
      created,
      makeEvent({
        sequence: 2,
        type: 'thread.pinned',
        payload: {
          threadId: ThreadId.make('thread-1'),
          pinnedAt: NOW,
          updatedAt: NOW,
        },
      }),
    )
    expect(pinned.threads[0]?.pinnedAt).toBe(NOW)

    const unpinned = yield* projectEvent(
      pinned,
      makeEvent({
        sequence: 3,
        type: 'thread.unpinned',
        payload: { threadId: ThreadId.make('thread-1'), updatedAt: NOW },
      }),
    )
    expect(unpinned.threads[0]?.pinnedAt).toBeNull()
  }),
)

it.effect('resets pinning and fork lifecycle fields on same-id recreation', () =>
  Effect.gen(function* ()
  {
    const created = yield* projectEvent(createEmptyReadModel(NOW), threadCreated(1))
    const stale = {
      ...created,
      threads: created.threads.map((thread) => ({
        ...thread,
        pinnedAt: '2026-01-02T00:00:00.000Z',
        archiveGeneration: 3,
        settledOverride: 'active' as const,
        unsettledAt: '2026-01-02T00:00:00.000Z',
        snoozedUntil: '2026-01-03T00:00:00.000Z',
        snoozedAt: '2026-01-02T00:00:00.000Z',
      })),
    }
    const recreated = yield* projectEvent(stale, threadCreated(2))
    const thread = recreated.threads[0]

    expect(thread?.pinnedAt).toBeNull()
    expect(thread?.archiveGeneration).toBe(0)
    expect(thread?.settledOverride).toBeNull()
    expect(thread?.unsettledAt).toBeNull()
    expect(thread?.snoozedUntil).toBeNull()
    expect(thread?.snoozedAt).toBeNull()
  }),
)
