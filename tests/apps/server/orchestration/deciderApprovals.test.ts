// tests/apps/server/orchestration/deciderApprovals.test.ts
// verifies approval response decisions preserve pending outcome state

import {
  ApprovalRequestId,
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
import { projectEvent } from '../../../../apps/server/src/orchestration/projector.ts'

const NOW = '2026-08-02T00:00:00.000Z'
const REQUEST_ID = ApprovalRequestId.make('approval-1')

const readModel: OrchestrationReadModel = {
  snapshotSequence: 1,
  projects: [],
  threads: [
    {
      id: ThreadId.make('thread-1'),
      projectId: ProjectId.make('project-1'),
      title: 'Thread',
      modelSelection: { instanceId: ProviderInstanceId.make('codex'), model: 'gpt-5.4' },
      runtimeMode: 'approval-required',
      interactionMode: 'default',
      branch: null,
      worktreePath: null,
      latestTurn: null,
      providerSwitch: null,
      createdAt: NOW,
      updatedAt: NOW,
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
      approvalOutcomes: [{ requestId: REQUEST_ID, status: 'pending', updatedAt: NOW }],
    },
  ],
  updatedAt: NOW,
}

it.layer(NodeServices.layer)('approval response decider', (it) =>
{
  it.effect('keeps the approval visible and records the requested decision', () =>
    Effect.gen(function* ()
    {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: 'thread.approval.respond',
          commandId: CommandId.make('cmd-approval-respond'),
          threadId: ThreadId.make('thread-1'),
          requestId: REQUEST_ID,
          decision: 'accept',
          createdAt: NOW,
        },
        readModel,
      })
      const event = Array.isArray(decided) ? decided[0] : decided
      expect(event?.type).toBe('thread.approval-response-requested')
      if (event?.type !== 'thread.approval-response-requested')
      {
        return
      }
      expect(event.payload.approvalOutcome).toEqual({
        requestId: REQUEST_ID,
        status: 'responding',
        requestedDecision: 'accept',
        updatedAt: NOW,
      })

      const projected = yield* projectEvent(readModel, { ...event, sequence: 2 })
      expect(projected.threads[0]?.approvalOutcomes).toEqual([
        {
          requestId: REQUEST_ID,
          status: 'responding',
          requestedDecision: 'accept',
          updatedAt: NOW,
        },
      ])
    }),
  )
})
