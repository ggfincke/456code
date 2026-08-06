// tests/apps/web/components/chat/composer/composerContextWindow.test.ts
// verify provider-scoped context window selection

import { describe, expect, it } from 'vite-plus/test'
import {
  EventId,
  ProviderInstanceId,
  type OrchestrationThreadActivity,
  TurnId,
} from '@t3tools/contracts'

import { selectThreadContextWindowSnapshot } from '../../../../../../apps/web/src/components/chat/composer/composerContextWindow'

const CODEX = ProviderInstanceId.make('codex')
const CLAUDE = ProviderInstanceId.make('claudeAgent')

function makeActivity(id: string, kind: string, payload: unknown): OrchestrationThreadActivity
{
  return {
    id: EventId.make(id),
    tone: 'info',
    kind,
    summary: kind,
    payload,
    turnId: TurnId.make('turn-1'),
    createdAt: '2026-08-01T00:00:00.000Z',
  }
}

function contextWindow(id: string, usedTokens: number, providerInstanceId?: string)
{
  return makeActivity(id, 'context-window.updated', {
    usedTokens,
    maxTokens: 200_000,
    ...(providerInstanceId ? { providerInstanceId } : {}),
  })
}

describe('selectThreadContextWindowSnapshot', () =>
{
  it('prefers the newest snapshot tagged for the current instance', () =>
  {
    const selection = selectThreadContextWindowSnapshot({
      activities: [
        contextWindow('activity-1', 1_000, CLAUDE),
        contextWindow('activity-2', 2_000, CLAUDE),
        contextWindow('activity-3', 90_000, CODEX),
      ],
      currentProviderInstanceId: CLAUDE,
    })

    expect(selection.state).toBe('current')
    expect(selection.state === 'current' ? selection.snapshot.usedTokens : null).toBe(2_000)
  })

  it('reports unavailable when every snapshot belongs to another instance', () =>
  {
    const selection = selectThreadContextWindowSnapshot({
      activities: [contextWindow('activity-1', 90_000, CODEX)],
      currentProviderInstanceId: CLAUDE,
    })

    expect(selection.state).toBe('unavailable')
  })

  it('treats an untagged snapshot as current while the thread has not switched', () =>
  {
    const selection = selectThreadContextWindowSnapshot({
      activities: [contextWindow('activity-1', 5_000)],
      currentProviderInstanceId: CLAUDE,
    })

    expect(selection.state).toBe('current')
    expect(selection.state === 'current' ? selection.snapshot.usedTokens : null).toBe(5_000)
  })

  it('qualifies an untagged snapshot recorded before a completed switch', () =>
  {
    const selection = selectThreadContextWindowSnapshot({
      activities: [
        contextWindow('activity-1', 5_000),
        makeActivity('activity-2', 'provider.switch.completed', {
          fromInstanceId: CODEX,
          toInstanceId: CLAUDE,
        }),
      ],
      currentProviderInstanceId: CLAUDE,
    })

    expect(selection.state).toBe('previous-provider')
    expect(selection.state === 'previous-provider' ? selection.snapshot.usedTokens : null).toBe(
      5_000,
    )
  })

  // the switch-completed activity is the usual evidence, but a legacy thread can
  // have moved instance without one. A snapshot tagged for an instance the
  // thread is no longer on proves the move on its own.
  it('resets an untagged snapshot on an observed instance transition with no switch activity', () =>
  {
    const selection = selectThreadContextWindowSnapshot({
      activities: [contextWindow('activity-1', 90_000, CODEX), contextWindow('activity-2', 5_000)],
      currentProviderInstanceId: CLAUDE,
    })

    expect(selection.state).toBe('previous-provider')
    expect(selection.state === 'previous-provider' ? selection.snapshot.usedTokens : null).toBe(
      5_000,
    )
  })

  // switching back to codex starts a fresh codex session, so the pre-switch
  // codex numbers describe a session that no longer exists
  it('ignores a codex snapshot from before the latest switch after codex -> claude -> codex', () =>
  {
    const selection = selectThreadContextWindowSnapshot({
      activities: [
        contextWindow('activity-1', 90_000, CODEX),
        makeActivity('activity-2', 'provider.switch.completed', {
          fromInstanceId: CODEX,
          toInstanceId: CLAUDE,
        }),
        contextWindow('activity-3', 40_000, CLAUDE),
        makeActivity('activity-4', 'provider.switch.completed', {
          fromInstanceId: CLAUDE,
          toInstanceId: CODEX,
        }),
      ],
      currentProviderInstanceId: CODEX,
    })

    expect(selection.state).toBe('unavailable')
  })

  it('uses the codex snapshot recorded after the switch back to codex', () =>
  {
    const selection = selectThreadContextWindowSnapshot({
      activities: [
        contextWindow('activity-1', 90_000, CODEX),
        makeActivity('activity-2', 'provider.switch.completed', {
          fromInstanceId: CODEX,
          toInstanceId: CLAUDE,
        }),
        contextWindow('activity-3', 40_000, CLAUDE),
        makeActivity('activity-4', 'provider.switch.completed', {
          fromInstanceId: CLAUDE,
          toInstanceId: CODEX,
        }),
        contextWindow('activity-5', 3_000, CODEX),
      ],
      currentProviderInstanceId: CODEX,
    })

    expect(selection.state).toBe('current')
    expect(selection.state === 'current' ? selection.snapshot.usedTokens : null).toBe(3_000)
  })

  it('reports none when the thread recorded no usable context window activity', () =>
  {
    const selection = selectThreadContextWindowSnapshot({
      activities: [makeActivity('activity-1', 'tool.started', {})],
      currentProviderInstanceId: CLAUDE,
    })

    expect(selection.state).toBe('none')
  })
})
