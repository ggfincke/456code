// tests/apps/server/cartographer/AtlasRebuildSuggestionService.test.ts
// verifies retained project atlas turn dedup, debounce, and authoring watchers

import { it } from '@effect/vitest'
import {
  CheckpointRef,
  CommandId,
  EventId,
  MessageId,
  type OrchestrationEvent,
  ProjectId,
  ThreadId,
  TurnId,
} from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as PubSub from 'effect/PubSub'
import * as Stream from 'effect/Stream'
import * as TestClock from 'effect/testing/TestClock'
import { describe, expect } from 'vite-plus/test'

import {
  make,
  PROJECT_ATLAS_REBUILD_DEBOUNCE_MS,
  type ProjectAuthoringWatcherFactory,
} from '../../../../apps/server/src/cartographer/AtlasRebuildSuggestionService.ts'

const now = '2026-08-07T12:00:00.000Z'
const threadId = ThreadId.make('thread-project-atlas-suggestion')
const projectId = ProjectId.make('project-atlas-suggestion')

function turnDiffEvent(
  sequence: number,
  status: 'ready' | 'missing',
  turnSequence = sequence,
): OrchestrationEvent
{
  return {
    sequence,
    eventId: EventId.make(`event-project-atlas-${sequence}`),
    aggregateKind: 'thread',
    aggregateId: threadId,
    type: 'thread.turn-diff-completed',
    occurredAt: now,
    commandId: CommandId.make(`command-project-atlas-${sequence}`),
    causationEventId: null,
    correlationId: CommandId.make(`command-project-atlas-${sequence}`),
    metadata: {},
    payload: {
      threadId,
      turnId: TurnId.make(`turn-project-atlas-${turnSequence}`),
      checkpointTurnCount: sequence,
      checkpointRef: CheckpointRef.make(`refs/t3/checkpoints/project-atlas/${sequence}`),
      status,
      files: [],
      assistantMessageId: MessageId.make(`message-project-atlas-${sequence}`),
      completedAt: now,
    },
  }
}

function sessionSetEvent(sequence: number): OrchestrationEvent
{
  return {
    sequence,
    eventId: EventId.make(`event-project-atlas-session-${sequence}`),
    aggregateKind: 'thread',
    aggregateId: threadId,
    type: 'thread.session-set',
    occurredAt: now,
    commandId: CommandId.make(`command-project-atlas-session-${sequence}`),
    causationEventId: null,
    correlationId: CommandId.make(`command-project-atlas-session-${sequence}`),
    metadata: {},
    payload: {
      threadId,
      session: {
        threadId,
        status: 'ready',
        providerName: 'codex',
        runtimeMode: 'full-access',
        activeTurnId: null,
        lastError: null,
        updatedAt: now,
      },
    },
  }
}

describe('AtlasRebuildSuggestionService', () =>
{
  it.effect('debounces ready diffs only for retained standing contexts', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const events = yield* Effect.acquireRelease(
          PubSub.unbounded<OrchestrationEvent>(),
          (pubsub) => PubSub.shutdown(pubsub),
        )
        let retained = false
        let rebuildCount = 0
        const service = make({
          events: Stream.fromPubSub(events),
          resolveProjectId: () => Effect.succeed(projectId),
          hasRetainedProjectContext: () => Effect.succeed(retained),
          requestRebuild: () =>
            Effect.sync(() =>
            {
              rebuildCount += 1
            }),
        })
        yield* service.start()
        yield* Effect.yieldNow

        yield* PubSub.publish(events, turnDiffEvent(1, 'ready'))
        yield* Effect.yieldNow
        retained = true
        yield* PubSub.publish(events, turnDiffEvent(2, 'missing'))
        yield* PubSub.publish(events, sessionSetEvent(3))
        yield* Effect.yieldNow
        yield* TestClock.adjust(`${PROJECT_ATLAS_REBUILD_DEBOUNCE_MS} millis`)
        expect(rebuildCount).toBe(0)

        yield* PubSub.publish(events, turnDiffEvent(4, 'ready'))
        yield* Effect.yieldNow
        yield* TestClock.adjust('150 millis')
        yield* PubSub.publish(events, turnDiffEvent(5, 'ready'))
        yield* Effect.yieldNow
        yield* TestClock.adjust('299 millis')
        expect(rebuildCount).toBe(0)
        yield* TestClock.adjust('1 millis')
        expect(rebuildCount).toBe(1)

        retained = false
        yield* PubSub.publish(events, turnDiffEvent(6, 'ready'))
        yield* Effect.yieldNow
        yield* TestClock.adjust(`${PROJECT_ATLAS_REBUILD_DEBOUNCE_MS} millis`)
        expect(rebuildCount).toBe(1)
      }),
    ),
  )

  it.effect('deduplicates recent turn ids outside the debounce window with a bounded LRU', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const events = yield* Effect.acquireRelease(
          PubSub.unbounded<OrchestrationEvent>(),
          PubSub.shutdown,
        )
        let rebuildCount = 0
        const service = make({
          events: Stream.fromPubSub(events),
          resolveProjectId: () => Effect.succeed(projectId),
          hasRetainedProjectContext: () => Effect.succeed(true),
          requestRebuild: () =>
            Effect.sync(() =>
            {
              rebuildCount += 1
            }),
        })
        yield* service.start()
        yield* Effect.yieldNow

        for (let sequence = 1; sequence <= 65; sequence += 1)
        {
          yield* PubSub.publish(events, turnDiffEvent(sequence, 'ready'))
          yield* Effect.yieldNow
          yield* TestClock.adjust(`${PROJECT_ATLAS_REBUILD_DEBOUNCE_MS} millis`)
        }
        expect(rebuildCount).toBe(65)

        yield* PubSub.publish(events, turnDiffEvent(66, 'ready', 65))
        yield* Effect.yieldNow
        yield* TestClock.adjust(`${PROJECT_ATLAS_REBUILD_DEBOUNCE_MS} millis`)
        expect(rebuildCount).toBe(65)

        yield* PubSub.publish(events, turnDiffEvent(67, 'ready', 1))
        yield* Effect.yieldNow
        yield* TestClock.adjust(`${PROJECT_ATLAS_REBUILD_DEBOUNCE_MS} millis`)
        expect(rebuildCount).toBe(66)
      }),
    ),
  )

  it.effect('watches only authoring files while a standing context is retained', () =>
  {
    let closeCount = 0
    let listener: (filename: string | null) => void = () => undefined
    const watchedRoots: string[] = []
    const watchProjectRoot: ProjectAuthoringWatcherFactory = (root, onChange) =>
    {
      watchedRoots.push(root)
      listener = onChange
      return { close: () => (closeCount += 1) }
    }
    let rebuildCount = 0
    return Effect.gen(function* ()
    {
      yield* Effect.scoped(
        Effect.gen(function* ()
        {
          const events = yield* Effect.acquireRelease(
            PubSub.unbounded<OrchestrationEvent>(),
            PubSub.shutdown,
          )
          const retention = yield* Effect.acquireRelease(
            PubSub.unbounded<{
              readonly projectId: ProjectId
              readonly retained: boolean
              readonly root: string | null
            }>(),
            PubSub.shutdown,
          )
          const service = make({
            events: Stream.fromPubSub(events),
            retentionChanges: Stream.fromPubSub(retention),
            resolveProjectId: () => Effect.succeed(projectId),
            hasRetainedProjectContext: () => Effect.succeed(true),
            requestRebuild: () =>
              Effect.sync(() =>
              {
                rebuildCount += 1
              }),
            watchProjectRoot,
            debounceMs: 0,
          })
          yield* service.start()
          yield* Effect.yieldNow
          yield* PubSub.publish(retention, { projectId, retained: true, root: '/repo' })
          yield* Effect.yieldNow
          expect(watchedRoots).toEqual(['/repo'])

          listener('package.json')
          yield* Effect.sleep('10 millis').pipe(TestClock.withLive)
          expect(rebuildCount).toBe(0)
          listener('.cartographer.json')
          listener('.cartographer.annotations.json')
          yield* Effect.sleep('10 millis').pipe(TestClock.withLive)
          expect(rebuildCount).toBe(1)

          yield* PubSub.publish(retention, { projectId, retained: false, root: null })
          yield* Effect.yieldNow
          expect(closeCount).toBe(1)
          yield* PubSub.publish(retention, { projectId, retained: true, root: '/repo' })
          yield* Effect.yieldNow
          expect(watchedRoots).toEqual(['/repo', '/repo'])
        }),
      )
      expect(closeCount).toBe(2)
    })
  })
})
