// tests/apps/server/orchestration/decider.archivedGate.test.ts
// verifies archived threads reject settle, unsettle, and snooze

import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from '@t3tools/contracts'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'

import { decideOrchestrationCommand } from '../../../../apps/server/src/orchestration/decider.ts'

const NOW = '2026-01-01T00:00:00.000Z'
const SETTLED_AT = '2025-12-30T00:00:00.000Z'
const FUTURE_WAKE = '1970-01-02T09:00:00.000Z'

function makeArchivedReadModel(
  settledOverride: OrchestrationThread['settledOverride'] = null,
): OrchestrationReadModel
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
        providerSwitch: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: NOW,
        origin: null,
        settledOverride,
        settledAt: settledOverride === 'settled' ? SETTLED_AT : null,
        snoozedUntil: null,
        snoozedAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        orchestratePlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  }
}

it.layer(NodeServices.layer)('archived thread command gates', (it) =>
{
  it.effect.each([
    {
      label: 'settle',
      command: {
        type: 'thread.settle' as const,
        commandId: CommandId.make('cmd-settle-archived'),
        threadId: ThreadId.make('thread-1'),
      },
      readModel: makeArchivedReadModel(null),
    },
    {
      label: 'unsettle',
      command: {
        type: 'thread.unsettle' as const,
        commandId: CommandId.make('cmd-unsettle-archived'),
        threadId: ThreadId.make('thread-1'),
        reason: 'user' as const,
      },
      readModel: makeArchivedReadModel('settled'),
    },
    {
      label: 'snooze',
      command: {
        type: 'thread.snooze' as const,
        commandId: CommandId.make('cmd-snooze-archived'),
        threadId: ThreadId.make('thread-1'),
        snoozedUntil: FUTURE_WAKE,
      },
      readModel: makeArchivedReadModel(null),
    },
  ])('rejects $label on an archived thread', ({ command, readModel }) =>
    Effect.gen(function* ()
    {
      const error = yield* decideOrchestrationCommand({ command, readModel }).pipe(Effect.flip)
      expect(error._tag).toBe('OrchestrationCommandInvariantError')
    }),
  )
})
