// tests/packages/client-runtime/thread-activity/worklogNormalization.test.ts
// verifies work log filtering, caller-owned caches, and child metadata

import { EventId, TurnId, type OrchestrationThreadActivity } from '@t3tools/contracts'
import { describe, expect, it } from 'vite-plus/test'

import {
  deriveNormalizedWorkLogEntries,
  type NormalizedWorkLogEntry,
} from '@t3tools/client-runtime/thread-activity'

function makeCompletedActivity(id: string, sequence: number): OrchestrationThreadActivity
{
  return {
    id: EventId.make(id),
    createdAt: `2026-08-26T00:00:0${sequence}.000Z`,
    kind: 'tool.completed',
    summary: 'Ran command',
    tone: 'tool',
    payload: {
      itemType: 'command_execution',
      toolCallId: id,
      status: 'completed',
      data: { item: { command: ['git', 'status'] } },
    },
    turnId: TurnId.make('turn-cache'),
    sequence,
  }
}

describe('deriveNormalizedWorkLogEntries caching', () =>
{
  it('filters wire-only warnings without dropping actionable warnings or errors', () =>
  {
    const base = makeCompletedActivity('warning-noise', 1)
    const activities: OrchestrationThreadActivity[] = [
      {
        ...base,
        kind: 'runtime.warning',
        tone: 'info',
        summary: "Claude system message 'background_tasks_changed' (no displayable text content)",
      },
      {
        ...base,
        id: EventId.make('warning-signal'),
        kind: 'runtime.warning',
        tone: 'info',
        summary: 'Reconnecting... 2/5',
        sequence: 2,
      },
      {
        ...base,
        id: EventId.make('runtime-error'),
        kind: 'runtime.error',
        tone: 'error',
        summary: 'Provider failed (no displayable text content)',
        sequence: 3,
      },
    ]

    const entries = deriveNormalizedWorkLogEntries(activities, {
      requestKindFromRequestType: () => null,
    })

    expect(entries.map((entry) => entry.id)).toEqual(['warning-signal', 'runtime-error'])
  })

  it('reuses entries only through the caller-owned cache after attaching collapse keys', () =>
  {
    const firstActivity = makeCompletedActivity('tool-first', 1)
    const secondActivity = makeCompletedActivity('tool-second', 2)
    const entryCache = new WeakMap<OrchestrationThreadActivity, NormalizedWorkLogEntry>()
    const options = {
      requestKindFromRequestType: () => null,
      entryCache,
    }

    const initial = deriveNormalizedWorkLogEntries([firstActivity], options)
    const appended = deriveNormalizedWorkLogEntries([firstActivity, secondActivity], options)
    const uncached = deriveNormalizedWorkLogEntries([firstActivity], {
      requestKindFromRequestType: () => null,
    })

    expect(initial[0]?.collapseKey).toBeDefined()
    expect(appended[0]).toBe(initial[0])
    expect(uncached[0]).not.toBe(initial[0])
  })

  it('merges and clears late child metadata without reopening a terminal collab row', () =>
  {
    const completed: OrchestrationThreadActivity = {
      id: EventId.make('collab-completed'),
      createdAt: '2026-08-26T00:00:01.000Z',
      kind: 'tool.completed',
      summary: 'Agent completed',
      tone: 'tool',
      payload: {
        itemType: 'collab_agent_tool_call',
        toolCallId: 'collab-call',
        status: 'completed',
      },
      turnId: TurnId.make('turn-collab'),
      sequence: 1,
    }
    const metadata: OrchestrationThreadActivity = {
      id: EventId.make('collab-metadata'),
      createdAt: '2026-08-26T00:00:02.000Z',
      kind: 'tool.updated',
      summary: 'Tool updated',
      tone: 'tool',
      payload: {
        itemType: 'collab_agent_tool_call',
        toolCallId: 'collab-call',
        model: 'gpt-5.6-sol',
        effort: 'high',
      },
      turnId: TurnId.make('turn-collab'),
      sequence: 2,
    }
    const clearedEffort: OrchestrationThreadActivity = {
      id: EventId.make('collab-metadata-clear'),
      createdAt: '2026-08-26T00:00:03.000Z',
      kind: 'tool.updated',
      summary: 'Tool updated',
      tone: 'tool',
      payload: {
        itemType: 'collab_agent_tool_call',
        toolCallId: 'collab-call',
        model: 'gpt-5.6-sol',
        effort: null,
      },
      turnId: TurnId.make('turn-collab'),
      sequence: 3,
    }

    const entries = deriveNormalizedWorkLogEntries([completed, metadata, clearedEffort], {
      requestKindFromRequestType: () => null,
    })

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      id: 'collab-completed',
      activityKind: 'tool.completed',
      toolLifecycleStatus: 'completed',
      toolCallId: 'collab-call',
      model: 'gpt-5.6-sol',
      effort: null,
    })
  })

  it('retains child metadata that arrives before the visible lifecycle row', () =>
  {
    const activities: ReadonlyArray<OrchestrationThreadActivity> = [
      {
        id: EventId.make('collab-started'),
        createdAt: '2026-08-26T00:00:01.000Z',
        kind: 'tool.started',
        summary: 'Agent started',
        tone: 'tool',
        payload: {
          itemType: 'collab_agent_tool_call',
          toolCallId: 'collab-race',
          status: 'inProgress',
        },
        turnId: TurnId.make('turn-collab-race'),
        sequence: 1,
      },
      {
        id: EventId.make('collab-metadata-before-row'),
        createdAt: '2026-08-26T00:00:02.000Z',
        kind: 'tool.updated',
        summary: 'Tool updated',
        tone: 'tool',
        payload: {
          itemType: 'collab_agent_tool_call',
          toolCallId: 'collab-race',
          model: 'gpt-5.6-sol',
          effort: 'low',
        },
        turnId: TurnId.make('turn-collab-race'),
        sequence: 2,
      },
      {
        id: EventId.make('collab-completed-after-metadata'),
        createdAt: '2026-08-26T00:00:03.000Z',
        kind: 'tool.completed',
        summary: 'Agent completed',
        tone: 'tool',
        payload: {
          itemType: 'collab_agent_tool_call',
          toolCallId: 'collab-race',
          status: 'completed',
        },
        turnId: TurnId.make('turn-collab-race'),
        sequence: 3,
      },
    ]

    const entries = deriveNormalizedWorkLogEntries(activities, {
      requestKindFromRequestType: () => null,
    })

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      id: 'collab-completed-after-metadata',
      activityKind: 'tool.completed',
      toolLifecycleStatus: 'completed',
      toolCallId: 'collab-race',
      model: 'gpt-5.6-sol',
      effort: 'low',
    })
  })
})
