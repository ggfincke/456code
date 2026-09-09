// tests/apps/server/orchestration/ThreadSettlementPolicy.test.ts
// protect settlement activity anchors, live exclusions, and snooze precedence

import {
  OrchestrationThreadShell,
  type OrchestrationThreadShell as Thread,
} from '@t3tools/contracts'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vite-plus/test'

import {
  isAutoSettlementCandidate,
  resolveAutoSettlementAt,
} from '../../../../apps/server/src/orchestration/ThreadSettlementPolicy.ts'

const ACTIVITY = '2026-01-01T00:00:00.000Z'
const NOW = '2026-01-10T00:00:00.000Z'
function thread(overrides: Partial<Thread> = {}): Thread
{
  return Schema.decodeSync(OrchestrationThreadShell)({
    id: 'thread-settlement',
    projectId: 'project-settlement',
    title: 'Settlement',
    modelSelection: { instanceId: 'codex', model: 'gpt-5.4' },
    runtimeMode: 'full-access',
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: ACTIVITY,
    updatedAt: NOW,
    session: null,
    latestUserMessageAt: ACTIVITY,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  })
}

describe('automatic settlement policy', () =>
{
  it('preserves qualifying activity instead of metadata time and keeps open PRs active', () =>
  {
    const input = {
      thread: thread(),
      now: NOW,
      autoSettleAfterDays: 3,
      autoSettleOnMerge: true,
      pullRequest: null,
    }
    expect(resolveAutoSettlementAt(input)).toBe(ACTIVITY)
    expect(resolveAutoSettlementAt({ ...input, autoSettleAfterDays: null })).toBeNull()
    expect(
      resolveAutoSettlementAt({ ...input, pullRequest: { state: 'open', terminalAt: ACTIVITY } }),
    ).toBeNull()
    expect(
      resolveAutoSettlementAt({
        ...input,
        autoSettleAfterDays: null,
        pullRequest: { state: 'merged', terminalAt: NOW },
      }),
    ).toBe(ACTIVITY)
    expect(
      resolveAutoSettlementAt({
        ...input,
        autoSettleAfterDays: null,
        autoSettleOnMerge: false,
        pullRequest: { state: 'merged', terminalAt: NOW },
      }),
    ).toBeNull()
    expect(
      resolveAutoSettlementAt({
        ...input,
        autoSettleAfterDays: null,
        pullRequest: { state: 'merged', terminalAt: '2025-12-31T00:00:00.000Z' },
      }),
    ).toBeNull()
    expect(
      resolveAutoSettlementAt({
        ...input,
        autoSettleAfterDays: null,
        pullRequest: { state: 'closed', terminalAt: null },
      }),
    ).toBeNull()
  })

  it('excludes live and snoozed work without treating a pin as user activity', () =>
  {
    const idle = thread()
    const session = {
      threadId: idle.id,
      status: 'ready' as const,
      providerName: 'Codex',
      runtimeMode: 'full-access' as const,
      activeTurnId: null,
      lastError: null,
      updatedAt: ACTIVITY,
    }
    for (const candidate of [
      thread({ archivedAt: ACTIVITY }),
      thread({ settledOverride: 'active' }),
      thread({ hasPendingApprovals: true }),
      thread({ hasPendingUserInput: true }),
      thread({ session: { ...session, status: 'starting' } }),
      thread({ session: { ...session, status: 'running' } }),
      thread({ latestUserMessageAt: NOW }),
      thread({ snoozedAt: ACTIVITY, snoozedUntil: '2026-01-11T00:00:00.000Z' }),
    ])
      expect(isAutoSettlementCandidate(candidate, NOW)).toBe(false)
    expect(isAutoSettlementCandidate(thread({ pinnedAt: NOW }), NOW)).toBe(true)
    expect(
      isAutoSettlementCandidate(
        thread({
          snoozedAt: ACTIVITY,
          snoozedUntil: '2026-01-11T00:00:00.000Z',
          session: { ...session, status: 'error', updatedAt: NOW },
        }),
        NOW,
      ),
    ).toBe(true)
  })
})
