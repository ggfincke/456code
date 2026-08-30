// tests/apps/server/orchestration/decider.pinned.test.ts
// verifies thread pin lifecycle command decisions

import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from '@t3tools/contracts'
import { effectiveSettled } from '@t3tools/client-runtime/state/thread-settled'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as TestClock from 'effect/testing/TestClock'

import { decideOrchestrationCommand } from '../../../../apps/server/src/orchestration/decider.ts'
import { projectEvent } from '../../../../apps/server/src/orchestration/projector.ts'

const NOW = '2026-01-01T00:00:00.000Z'
const PINNED_AT = '1969-12-30T00:00:00.000Z'
const FUTURE_WAKE = '1970-01-02T09:00:00.000Z'

function makeReadModel(input: {
  readonly pinnedAt?: string | null
  readonly archivedAt?: string | null
  readonly settledOverride?: 'settled' | 'active' | null
  readonly snoozedUntil?: string | null
  readonly latestTurn?: OrchestrationThread['latestTurn']
}): OrchestrationReadModel
{
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make('thread-1'),
        projectId: ProjectId.make('project-1'),
        title: 'Thread',
        modelSelection: { instanceId: ProviderInstanceId.make('codex'), model: 'gpt-5.4' },
        runtimeMode: 'full-access',
        interactionMode: 'default',
        branch: null,
        worktreePath: null,
        latestTurn: input.latestTurn ?? null,
        pendingHandoff: null,
        providerSwitch: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: input.archivedAt ?? null,
        archiveGeneration: 0,
        origin: null,
        settledOverride: input.settledOverride ?? null,
        settledAt: input.settledOverride === 'settled' ? NOW : null,
        unsettledAt: null,
        snoozedUntil: input.snoozedUntil ?? null,
        snoozedAt: input.snoozedUntil == null ? null : PINNED_AT,
        pinnedAt: input.pinnedAt ?? null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        orchestratePlans: [],
        activities: [],
        checkpoints: [],
        approvalOutcomes: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  }
}

function toShell(thread: OrchestrationThread)
{
  return {
    ...thread,
    latestUserMessageAt:
      thread.messages.findLast((message) => message.role === 'user')?.createdAt ?? null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  }
}

it.layer(NodeServices.layer)('pinned thread decider', (it) =>
{
  it.effect('fresh pins wake derived settlement until real activity clears the override', () =>
    Effect.gen(function* ()
    {
      yield* TestClock.setTime(Date.parse(NOW))
      const oldActivityAt = '2025-12-20T00:00:00.000Z'
      let readModel = makeReadModel({
        latestTurn: {
          turnId: TurnId.make('old-turn'),
          state: 'completed',
          requestedAt: oldActivityAt,
          startedAt: oldActivityAt,
          completedAt: oldActivityAt,
          assistantMessageId: null,
        },
      })
      const idleOptions = { now: NOW, autoSettleAfterDays: 3 }
      const mergeOptions = {
        now: NOW,
        autoSettleAfterDays: null,
        changeRequestState: 'merged' as const,
      }
      expect(effectiveSettled(toShell(readModel.threads[0]!), idleOptions)).toBe(true)
      expect(effectiveSettled(toShell(readModel.threads[0]!), mergeOptions)).toBe(true)

      const event = yield* decideOrchestrationCommand({
        command: {
          type: 'thread.pin',
          commandId: CommandId.make('cmd-pin'),
          threadId: ThreadId.make('thread-1'),
        },
        readModel,
      })
      const events = Array.isArray(event) ? event : [event]

      expect(events).toMatchObject([
        { type: 'thread.pinned', payload: { pinnedAt: NOW, updatedAt: NOW } },
        { type: 'thread.unsettled', payload: { reason: 'user', updatedAt: NOW } },
      ])
      for (const plannedEvent of events)
      {
        readModel = yield* projectEvent(readModel, {
          ...plannedEvent,
          sequence: readModel.snapshotSequence + 1,
        } as OrchestrationEvent)
      }
      expect(readModel.threads[0]).toMatchObject({ pinnedAt: NOW, settledOverride: 'active' })
      expect(effectiveSettled(toShell(readModel.threads[0]!), idleOptions)).toBe(false)
      expect(effectiveSettled(toShell(readModel.threads[0]!), mergeOptions)).toBe(false)

      const activity = yield* decideOrchestrationCommand({
        command: {
          type: 'thread.turn.start',
          commandId: CommandId.make('cmd-pin-followup'),
          threadId: ThreadId.make('thread-1'),
          message: {
            messageId: MessageId.make('message-followup'),
            role: 'user',
            text: 'Continue',
            attachments: [],
          },
          runtimeMode: 'full-access',
          interactionMode: 'default',
          createdAt: NOW,
        },
        readModel,
      })
      const activityEvents = Array.isArray(activity) ? activity : [activity]
      expect(activityEvents[0]).toMatchObject({
        type: 'thread.unsettled',
        payload: { reason: 'activity' },
      })
      for (const plannedEvent of activityEvents)
      {
        readModel = yield* projectEvent(readModel, {
          ...plannedEvent,
          sequence: readModel.snapshotSequence + 1,
        } as OrchestrationEvent)
      }
      expect(readModel.threads[0]).toMatchObject({ pinnedAt: NOW, settledOverride: null })
      expect(effectiveSettled(toShell(readModel.threads[0]!), idleOptions)).toBe(false)
      expect(
        effectiveSettled(toShell(readModel.threads[0]!), {
          ...idleOptions,
          now: '2026-01-05T00:00:00.000Z',
        }),
      ).toBe(true)

      yield* TestClock.setTime(Date.parse('2026-01-05T00:00:00.000Z'))
      const duplicate = yield* decideOrchestrationCommand({
        command: {
          type: 'thread.pin',
          commandId: CommandId.make('cmd-pin-derived-again'),
          threadId: ThreadId.make('thread-1'),
        },
        readModel,
      })
      const duplicateEvents = Array.isArray(duplicate) ? duplicate : [duplicate]
      expect(duplicateEvents).toMatchObject([
        { type: 'thread.pinned', payload: { pinnedAt: NOW, updatedAt: NOW } },
      ])
      const projected = yield* projectEvent(readModel, {
        ...duplicateEvents[0]!,
        sequence: readModel.snapshotSequence + 1,
      } as OrchestrationEvent)
      expect(projected.threads).toEqual(readModel.threads)
    }),
  )

  it.effect('duplicate pins preserve timestamps and parked lifecycle state', () =>
    Effect.gen(function* ()
    {
      const readModel = makeReadModel({
        pinnedAt: PINNED_AT,
        settledOverride: 'settled',
        snoozedUntil: FUTURE_WAKE,
      })
      const event = yield* decideOrchestrationCommand({
        command: {
          type: 'thread.pin',
          commandId: CommandId.make('cmd-pin-again'),
          threadId: ThreadId.make('thread-1'),
        },
        readModel,
      })
      const events = Array.isArray(event) ? event : [event]

      expect(events).toMatchObject([
        { type: 'thread.pinned', payload: { pinnedAt: PINNED_AT, updatedAt: NOW } },
      ])
      const projected = yield* projectEvent(readModel, {
        ...events[0]!,
        sequence: readModel.snapshotSequence + 1,
      } as OrchestrationEvent)
      expect(projected.threads).toEqual(readModel.threads)
    }),
  )

  it.effect('pinning promotes settled and snoozed threads', () =>
    Effect.gen(function* ()
    {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: 'thread.pin',
          commandId: CommandId.make('cmd-pin-parked'),
          threadId: ThreadId.make('thread-1'),
        },
        readModel: makeReadModel({
          settledOverride: 'settled',
          snoozedUntil: FUTURE_WAKE,
        }),
      })
      const events = Array.isArray(event) ? event : [event]

      expect(events.map((entry) => entry.type)).toEqual([
        'thread.pinned',
        'thread.unsettled',
        'thread.unsnoozed',
      ])
    }),
  )

  it.effect('settling clears a pin and the fork snooze state', () =>
    Effect.gen(function* ()
    {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: 'thread.settle',
          commandId: CommandId.make('cmd-settle-pinned'),
          threadId: ThreadId.make('thread-1'),
        },
        readModel: makeReadModel({ pinnedAt: PINNED_AT, snoozedUntil: FUTURE_WAKE }),
      })
      const events = Array.isArray(event) ? event : [event]

      expect(events.map((entry) => entry.type)).toEqual([
        'thread.settled',
        'thread.unsnoozed',
        'thread.unpinned',
      ])
    }),
  )

  it.effect('unpinning an unpinned thread preserves updatedAt', () =>
    Effect.gen(function* ()
    {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: 'thread.unpin',
          commandId: CommandId.make('cmd-unpin-noop'),
          threadId: ThreadId.make('thread-1'),
        },
        readModel: makeReadModel({}),
      })
      const events = Array.isArray(event) ? event : [event]

      if (events[0]?.type === 'thread.unpinned')
      {
        expect(events[0].payload.updatedAt).toBe(NOW)
      }
    }),
  )

  it.effect('rejects pinning an archived thread', () =>
    Effect.gen(function* ()
    {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: 'thread.pin',
          commandId: CommandId.make('cmd-pin-archived'),
          threadId: ThreadId.make('thread-1'),
        },
        readModel: makeReadModel({ archivedAt: NOW }),
      }).pipe(Effect.flip)

      expect(error._tag).toBe('OrchestrationCommandInvariantError')
    }),
  )
})
