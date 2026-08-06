// tests/apps/mobile/lib/thread-activity/activity-order.test.ts
// verifies mobile activity ordering matches the canonical shared comparator

import { EventId, TurnId, type OrchestrationThreadActivity } from '@t3tools/contracts'
import { compareOrchestrationThreadActivities } from '@t3tools/shared/orchestrationActivityOrder'
import { describe, expect, it } from 'vite-plus/test'

import { sortThreadActivities } from '../../../../../apps/mobile/src/lib/threadActivity'
import { deriveWorkLogEntries } from '../../../../../apps/mobile/src/lib/thread-activity/worklog'

const EARLIER = '2026-08-02T10:00:00.000Z'
const LATER = '2026-08-02T10:00:01.000Z'

function makeActivity(
  id: string,
  overrides: Partial<OrchestrationThreadActivity> = {},
): OrchestrationThreadActivity
{
  return {
    id: EventId.make(id),
    tone: 'info',
    kind: 'runtime.warning',
    summary: id,
    payload: {},
    turnId: TurnId.make('turn-1'),
    createdAt: LATER,
    ...overrides,
  }
}

// one older activity carrying the newest sequence (timestamp must win), three
// activities sharing a timestamp with ascending sequences, and one of those
// missing its sequence entirely (it sorts last, never first).
const ACTIVITIES: ReadonlyArray<OrchestrationThreadActivity> = [
  makeActivity('later-no-sequence'),
  makeActivity('later-sequence-2', { sequence: 2 }),
  makeActivity('earlier-sequence-9', { createdAt: EARLIER, sequence: 9 }),
  makeActivity('later-sequence-1', { sequence: 1 }),
]

const CANONICAL_ORDER = [
  'earlier-sequence-9',
  'later-sequence-1',
  'later-sequence-2',
  'later-no-sequence',
]

describe('mobile thread activity ordering', () =>
{
  it('sorts request activities in canonical order', () =>
  {
    expect(
      [...ACTIVITIES].toSorted(compareOrchestrationThreadActivities).map(({ id }) => id),
    ).toEqual(CANONICAL_ORDER)
    expect(sortThreadActivities(ACTIVITIES).map(({ id }) => id)).toEqual(CANONICAL_ORDER)
  })

  it('derives work log entries in canonical order', () =>
  {
    expect(deriveWorkLogEntries(ACTIVITIES).map(({ id }) => id)).toEqual(CANONICAL_ORDER)
  })

  it('keeps provider switch outcomes out of the work log', () =>
  {
    const entries = deriveWorkLogEntries([
      makeActivity('switch-completed', {
        kind: 'provider.switch.completed',
        summary: 'Switched provider',
        sequence: 1,
      }),
      makeActivity('switch-failed', {
        kind: 'provider.switch.failed',
        tone: 'error',
        summary: 'Provider switch failed',
        sequence: 2,
      }),
      makeActivity('warning', { sequence: 3 }),
    ])

    expect(entries.map(({ id }) => id)).toEqual(['warning'])
  })
})
