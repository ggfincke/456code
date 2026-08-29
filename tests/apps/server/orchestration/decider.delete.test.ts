// tests/apps/server/orchestration/decider.delete.test.ts
// verifies delete command decisions

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  ProviderInstanceId,
} from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { expect, it } from '@effect/vitest'

import { decideOrchestrationCommand } from '../../../../apps/server/src/orchestration/decider.ts'
import {
  createEmptyReadModel,
  projectEvent,
} from '../../../../apps/server/src/orchestration/projector.ts'

const asCommandId = (value: string): CommandId => CommandId.make(value)
const asEventId = (value: string): EventId => EventId.make(value)
const asProjectId = (value: string): ProjectId => ProjectId.make(value)
const asThreadId = (value: string): ThreadId => ThreadId.make(value)

const seedReadModel = Effect.gen(function* ()
{
  const now = '2026-01-01T00:00:00.000Z'
  const initial = createEmptyReadModel(now)
  const withProject = yield* projectEvent(initial, {
    sequence: 1,
    eventId: asEventId('evt-project-create'),
    aggregateKind: 'project',
    aggregateId: asProjectId('project-delete'),
    type: 'project.created',
    occurredAt: now,
    commandId: asCommandId('cmd-project-create'),
    causationEventId: null,
    correlationId: asCommandId('cmd-project-create'),
    metadata: {},
    payload: {
      projectId: asProjectId('project-delete'),
      title: 'Project Delete',
      workspaceRoot: '/tmp/project-delete',
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  })

  const withFirstThread = yield* projectEvent(withProject, {
    sequence: 2,
    eventId: asEventId('evt-thread-create-1'),
    aggregateKind: 'thread',
    aggregateId: asThreadId('thread-delete-1'),
    type: 'thread.created',
    occurredAt: now,
    commandId: asCommandId('cmd-thread-create-1'),
    causationEventId: null,
    correlationId: asCommandId('cmd-thread-create-1'),
    metadata: {},
    payload: {
      threadId: asThreadId('thread-delete-1'),
      projectId: asProjectId('project-delete'),
      title: 'Thread Delete 1',
      modelSelection: {
        instanceId: ProviderInstanceId.make('codex'),
        model: 'gpt-5-codex',
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: 'approval-required',
      branch: null,
      worktreePath: null,
      origin: null,
      createdAt: now,
      updatedAt: now,
    },
  })

  return yield* projectEvent(withFirstThread, {
    sequence: 3,
    eventId: asEventId('evt-thread-create-2'),
    aggregateKind: 'thread',
    aggregateId: asThreadId('thread-delete-2'),
    type: 'thread.created',
    occurredAt: now,
    commandId: asCommandId('cmd-thread-create-2'),
    causationEventId: null,
    correlationId: asCommandId('cmd-thread-create-2'),
    metadata: {},
    payload: {
      threadId: asThreadId('thread-delete-2'),
      projectId: asProjectId('project-delete'),
      title: 'Thread Delete 2',
      modelSelection: {
        instanceId: ProviderInstanceId.make('codex'),
        model: 'gpt-5-codex',
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: 'approval-required',
      branch: null,
      worktreePath: null,
      origin: null,
      createdAt: now,
      updatedAt: now,
    },
  })
})

type PlannedEvent = Omit<OrchestrationEvent, 'sequence'>

function normalizeDeleteEvent(event: PlannedEvent | ReadonlyArray<PlannedEvent>)
{
  const events = Array.isArray(event) ? event : [event]
  return events.map((entry) =>
  {
    switch (entry.type)
    {
      case 'thread.deleted':
        return {
          type: entry.type,
          aggregateKind: entry.aggregateKind,
          aggregateId: entry.aggregateId,
          commandId: entry.commandId,
          correlationId: entry.correlationId,
          payload: {
            threadId: entry.payload.threadId,
          },
        }
      case 'project.deleted':
        return {
          type: entry.type,
          aggregateKind: entry.aggregateKind,
          aggregateId: entry.aggregateId,
          commandId: entry.commandId,
          correlationId: entry.correlationId,
          payload: {
            projectId: entry.payload.projectId,
          },
        }
      default:
        return entry
    }
  })
}

it.layer(NodeServices.layer)('decider deletion flows', (it) =>
{
  it.effect('rejects deleting a non-empty project without force', () =>
    Effect.gen(function* ()
    {
      const readModel = yield* seedReadModel
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: 'project.delete',
            commandId: asCommandId('cmd-project-delete-no-force'),
            projectId: asProjectId('project-delete'),
          },
          readModel,
        }),
      )
      expect(error.message).toContain('cannot be deleted without force=true')
    }),
  )

  it.effect('reuses thread.delete semantics when force-deleting a non-empty project', () =>
    Effect.gen(function* ()
    {
      const readModel = yield* seedReadModel
      const projectDeleteCommand: Extract<OrchestrationCommand, { type: 'project.delete' }> = {
        type: 'project.delete',
        commandId: asCommandId('cmd-project-delete-force'),
        projectId: asProjectId('project-delete'),
        force: true,
      }

      const forcedResult = yield* decideOrchestrationCommand({
        command: projectDeleteCommand,
        readModel,
      })
      const forcedEvents = Array.isArray(forcedResult) ? forcedResult : [forcedResult]

      expect(forcedEvents.map((event) => event.type)).toEqual([
        'thread.deleted',
        'thread.deleted',
        'project.deleted',
      ])

      let sequentialReadModel = readModel
      let nextSequence = readModel.snapshotSequence
      const sequentialEvents: PlannedEvent[] = []
      for (const nextCommand of [
        {
          type: 'thread.delete',
          commandId: projectDeleteCommand.commandId,
          threadId: asThreadId('thread-delete-1'),
        },
        {
          type: 'thread.delete',
          commandId: projectDeleteCommand.commandId,
          threadId: asThreadId('thread-delete-2'),
        },
        {
          type: 'project.delete',
          commandId: projectDeleteCommand.commandId,
          projectId: asProjectId('project-delete'),
        },
      ] satisfies ReadonlyArray<OrchestrationCommand>)
      {
        const decided = yield* decideOrchestrationCommand({
          command: nextCommand,
          readModel: sequentialReadModel,
        })
        const nextEvents = Array.isArray(decided) ? decided : [decided]
        sequentialEvents.push(...nextEvents)
        for (const nextEvent of nextEvents)
        {
          nextSequence += 1
          sequentialReadModel = yield* projectEvent(sequentialReadModel, {
            ...nextEvent,
            sequence: nextSequence,
          })
        }
      }

      expect(normalizeDeleteEvent(forcedResult)).toEqual(normalizeDeleteEvent(sequentialEvents))
    }),
  )

  it.effect('allows a deleted draft to re-create its client-minted thread id', () =>
    Effect.gen(function* ()
    {
      const readModel = yield* seedReadModel
      const deleted = yield* decideOrchestrationCommand({
        command: {
          type: 'thread.delete',
          commandId: asCommandId('cmd-thread-delete-for-retry'),
          threadId: asThreadId('thread-delete-1'),
        },
        readModel,
      })
      const deletedEvent = Array.isArray(deleted) ? deleted[0]! : deleted
      const afterDelete = yield* projectEvent(readModel, {
        ...deletedEvent,
        sequence: readModel.snapshotSequence + 1,
      })

      const recreated = yield* decideOrchestrationCommand({
        command: {
          type: 'thread.create',
          commandId: asCommandId('cmd-thread-recreate'),
          threadId: asThreadId('thread-delete-1'),
          projectId: asProjectId('project-delete'),
          title: 'Retried draft',
          modelSelection: {
            instanceId: ProviderInstanceId.make('codex'),
            model: 'gpt-5-codex',
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: 'approval-required',
          branch: null,
          worktreePath: null,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        readModel: afterDelete,
      })

      const recreatedEvents = Array.isArray(recreated) ? recreated : [recreated]
      expect(recreatedEvents[0]?.type).toBe('thread.created')
    }),
  )
})
