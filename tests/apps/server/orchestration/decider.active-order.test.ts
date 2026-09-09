// tests/apps/server/orchestration/decider.active-order.test.ts
// verifies durable active-thread ordering across lifecycle transitions

import * as NodeServices from '@effect/platform-node/NodeServices'
import { expect, it } from '@effect/vitest'
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as TestClock from 'effect/testing/TestClock'

import { decideOrchestrationCommand } from '../../../../apps/server/src/orchestration/decider.ts'
import { projectEvent } from '../../../../apps/server/src/orchestration/projector.ts'

const NOW = '2026-01-01T00:00:00.000Z'
const THREAD_ID = ThreadId.make('thread-active-order')

function makeReadModel(overrides: Partial<OrchestrationThread> = {}): OrchestrationReadModel
{
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.make('project-active-order'),
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
        archivedAt: null,
        archiveGeneration: 0,
        origin: null,
        settledOverride: null,
        settledAt: null,
        unsettledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        activeOrderKey: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        orchestratePlans: [],
        activities: [],
        checkpoints: [],
        approvalOutcomes: [],
        session: null,
        ...overrides,
      },
    ],
    updatedAt: NOW,
  }
}

function command(
  type: OrchestrationCommand['type'],
  fields: Record<string, unknown> = {},
): OrchestrationCommand
{
  return {
    type,
    commandId: CommandId.make(`command-${type}`),
    threadId: THREAD_ID,
    ...fields,
  } as OrchestrationCommand
}

it.layer(NodeServices.layer)('active thread ordering', (it) =>
{
  it.effect('retains an arranged slot through snooze and pin, then clears it on settlement', () =>
    Effect.gen(function* ()
    {
      yield* TestClock.setTime(Date.parse(NOW))
      let readModel = makeReadModel()
      const steps = [
        [command('thread.active.reorder', { orderKey: 'm' }), 'm'],
        [command('thread.snooze', { snoozedUntil: '2026-01-02T00:00:00.000Z' }), 'm'],
        [command('thread.pin'), 'm'],
        [command('thread.unpin'), 'm'],
        [command('thread.settle'), null],
        [command('thread.unsettle', { reason: 'user' }), null],
      ] as const

      for (const [nextCommand, expectedOrderKey] of steps)
      {
        const planned = yield* decideOrchestrationCommand({ command: nextCommand, readModel })
        for (const event of Array.isArray(planned) ? planned : [planned])
        {
          readModel = yield* projectEvent(readModel, {
            ...event,
            sequence: readModel.snapshotSequence + 1,
          })
        }
        expect(readModel.threads[0]?.activeOrderKey).toBe(expectedOrderKey)
      }
    }),
  )

  it.effect('reorders a snoozed active thread without waking it or changing activity time', () =>
    Effect.gen(function* ()
    {
      yield* TestClock.setTime(Date.parse('2026-01-03T00:00:00.000Z'))
      const readModel = makeReadModel({
        activeOrderKey: 'g',
        snoozedAt: NOW,
        snoozedUntil: '2026-01-04T00:00:00.000Z',
      })
      const planned = yield* decideOrchestrationCommand({
        command: command('thread.active.reorder', { orderKey: 't' }),
        readModel,
      })
      const event = Array.isArray(planned) ? planned[0]! : planned
      expect(event).toMatchObject({
        type: 'thread.meta-updated',
        payload: { activeOrderKey: 't', updatedAt: NOW },
      })
      const projected = yield* projectEvent(readModel, { ...event, sequence: 1 })
      expect(projected.threads[0]).toEqual({ ...readModel.threads[0], activeOrderKey: 't' })
    }),
  )

  it.effect('rejects reorder commands for rows outside the active list', () =>
    Effect.gen(function* ()
    {
      for (const overrides of [
        { archivedAt: NOW },
        { deletedAt: NOW },
        { pinnedAt: NOW },
        { settledOverride: 'settled' as const, settledAt: NOW },
      ])
      {
        const error = yield* decideOrchestrationCommand({
          command: command('thread.active.reorder', { orderKey: 'm' }),
          readModel: makeReadModel(overrides),
        }).pipe(Effect.flip)
        expect(error._tag).toBe('OrchestrationCommandInvariantError')
      }
    }),
  )
})
