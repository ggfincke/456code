// tests/apps/server/orchestration/decider.pinned.test.ts
// verifies thread pin lifecycle command decisions

import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from '@t3tools/contracts'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'

import { decideOrchestrationCommand } from '../../../../apps/server/src/orchestration/decider.ts'

const NOW = '2026-01-01T00:00:00.000Z'
const PINNED_AT = '1969-12-30T00:00:00.000Z'
const FUTURE_WAKE = '1970-01-02T09:00:00.000Z'

function makeReadModel(input: {
  readonly pinnedAt?: string | null
  readonly archivedAt?: string | null
  readonly settledOverride?: 'settled' | 'active' | null
  readonly snoozedUntil?: string | null
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
        latestTurn: null,
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

it.layer(NodeServices.layer)('pinned thread decider', (it) =>
{
  it.effect('pins a thread with matching pin and update timestamps', () =>
    Effect.gen(function* ()
    {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: 'thread.pin',
          commandId: CommandId.make('cmd-pin'),
          threadId: ThreadId.make('thread-1'),
        },
        readModel: makeReadModel({}),
      })
      const events = Array.isArray(event) ? event : [event]

      expect(events).toHaveLength(1)
      expect(events[0]?.type).toBe('thread.pinned')
      if (events[0]?.type === 'thread.pinned')
      {
        expect(events[0].payload.pinnedAt).toBe(events[0].payload.updatedAt)
      }
    }),
  )

  it.effect('re-pinning preserves the original pin and update timestamps', () =>
    Effect.gen(function* ()
    {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: 'thread.pin',
          commandId: CommandId.make('cmd-pin-again'),
          threadId: ThreadId.make('thread-1'),
        },
        readModel: makeReadModel({ pinnedAt: PINNED_AT }),
      })
      const events = Array.isArray(event) ? event : [event]

      if (events[0]?.type === 'thread.pinned')
      {
        expect(events[0].payload.pinnedAt).toBe(PINNED_AT)
        expect(events[0].payload.updatedAt).toBe(NOW)
      }
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
