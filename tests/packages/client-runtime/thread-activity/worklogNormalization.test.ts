// tests/packages/client-runtime/thread-activity/worklogNormalization.test.ts
// verifies caller-owned work log normalization caching

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
})
