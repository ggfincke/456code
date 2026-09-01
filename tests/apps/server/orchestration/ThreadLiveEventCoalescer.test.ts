// tests/apps/server/orchestration/ThreadLiveEventCoalescer.test.ts
// verifies bounded live thread tool-update coalescing

import {
  EventId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationThreadActivity,
  ThreadId,
  TurnId,
} from '@t3tools/contracts'
import { it } from '@effect/vitest'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Stream from 'effect/Stream'
import * as TestClock from 'effect/testing/TestClock'
import { describe, expect } from 'vite-plus/test'

import {
  coalesceLiveToolUpdatedEvents,
  makeThreadLiveEventCoalescer,
} from '../../../../apps/server/src/orchestration/ThreadLiveEventCoalescer.ts'

const threadId = ThreadId.make('thread-coalescer-test')
const turnId = TurnId.make('turn-coalescer-test')

function makeToolActivity(
  sequence: number,
  options: {
    readonly kind?: 'tool.started' | 'tool.updated' | 'tool.completed'
    readonly status?: 'pending' | 'inProgress' | 'completed' | 'failed'
    readonly toolCallId?: string
    readonly turnId?: TurnId
    readonly error?: string
  } = {},
): OrchestrationEvent
{
  const {
    kind = 'tool.updated',
    toolCallId = 'call-edit',
    turnId: activityTurnId = turnId,
  } = options
  const activity: OrchestrationThreadActivity = {
    id: EventId.make(`activity-${sequence}`),
    tone: options.error === undefined ? 'tool' : 'error',
    kind,
    summary: 'Editing app.ts',
    payload: {
      itemType: 'file_change',
      title: 'Editing app.ts',
      ...(options.status === undefined ? {} : { status: options.status }),
      ...(options.error === undefined ? {} : { error: options.error }),
      data: toolCallId ? { toolCallId } : {},
    },
    turnId: activityTurnId,
    createdAt: '2026-01-01T00:00:01.000Z',
  }
  return {
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    aggregateKind: 'thread',
    aggregateId: threadId,
    occurredAt: '2026-01-01T00:00:01.000Z',
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: 'thread.activity-appended',
    payload: { threadId, activity },
  }
}

function makeMessage(sequence: number, text = 'Still working'): OrchestrationEvent
{
  return {
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    aggregateKind: 'thread',
    aggregateId: threadId,
    occurredAt: '2026-01-01T00:00:02.000Z',
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: 'thread.message-sent',
    payload: {
      threadId,
      messageId: MessageId.make(`message-${sequence}`),
      role: 'assistant',
      text,
      turnId,
      streaming: false,
      createdAt: '2026-01-01T00:00:02.000Z',
      updatedAt: '2026-01-01T00:00:02.000Z',
    },
  }
}

describe('ThreadLiveEventCoalescer', () =>
{
  it('coalesces only repeated-status calls with a stable tool id', () =>
  {
    const events = [
      makeToolActivity(1, { status: 'pending', toolCallId: 'call-a' }),
      makeToolActivity(2, { status: 'inProgress', toolCallId: 'call-a' }),
      makeToolActivity(3, { status: 'inProgress', toolCallId: 'call-b' }),
      makeToolActivity(4, { status: 'inProgress', toolCallId: 'call-a' }),
      makeToolActivity(5, { status: 'inProgress', toolCallId: 'call-a' }),
      makeToolActivity(6, { status: 'failed', toolCallId: 'call-a', error: 'failed' }),
    ]

    expect(coalesceLiveToolUpdatedEvents(events).map((event) => event.sequence)).toEqual([
      1, 2, 3, 5, 6,
    ])
  })

  it('preserves parallel anonymous calls and turn-local tool identities', () =>
  {
    const events = [
      makeToolActivity(1, { toolCallId: '' }),
      makeToolActivity(2, { toolCallId: '' }),
      makeToolActivity(3, { turnId: TurnId.make('turn-other') }),
      makeToolActivity(4),
    ]

    expect(coalesceLiveToolUpdatedEvents(events).map((event) => event.sequence)).toEqual([
      1, 2, 3, 4,
    ])
  })

  it.effect('flushes pending updates before a status transition and unrelated boundary', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const coalescer = yield* makeThreadLiveEventCoalescer({
          coalesceWindow: '500 millis',
        })
        const startedAt = yield* Clock.currentTimeMillis
        yield* coalescer.offer({ kind: 'event', event: makeToolActivity(1, { status: 'pending' }) })
        yield* coalescer.offer({ kind: 'event', event: makeToolActivity(2, { status: 'pending' }) })
        yield* coalescer.offer({
          kind: 'event',
          event: makeToolActivity(3, { status: 'inProgress' }),
        })
        yield* coalescer.offer({ kind: 'event', event: makeMessage(4) })

        expect(yield* Clock.currentTimeMillis).toBe(startedAt)
        expect(
          (yield* coalescer.stream.pipe(Stream.take(4), Stream.runCollect)).map((item) =>
            item.kind === 'event' ? item.event.sequence : item.kind,
          ),
        ).toEqual([1, 2, 3, 4])
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  )

  it.effect('keeps an unacknowledged item charged and detaches synchronous admission', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const coalescer = yield* makeThreadLiveEventCoalescer({ maxItems: 3 })
        expect(coalescer.admit({ kind: 'event', event: makeMessage(1) })).toBe(true)

        yield* Effect.scoped(
          Effect.gen(function* ()
          {
            const pull = yield* Stream.toPull(coalescer.stream)
            const batch = yield* pull
            expect(
              batch.map((item) => (item.kind === 'event' ? item.event.sequence : null)),
            ).toEqual([1])
            expect(coalescer.admit({ kind: 'event', event: makeMessage(2) })).toBe(true)
            expect(coalescer.admit({ kind: 'event', event: makeMessage(3) })).toBe(true)
            expect(coalescer.admit({ kind: 'event', event: makeMessage(4) })).toBe(false)
            yield* coalescer.closed
            expect((yield* coalescer.usage).retainedItems).toBe(1)
          }),
        )
        expect(yield* coalescer.usage).toEqual({
          retainedItems: 0,
          retainedSerializedBytes: 0,
        })
      }),
    ),
  )
})
