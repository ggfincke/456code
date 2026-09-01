// apps/server/src/orchestration/ThreadSettlementPolicy.ts
// decide automatic settlement from qualifying activity and current liveness

import type { OrchestrationThreadShell } from '@t3tools/contracts'

export interface SettlementPullRequest
{
  readonly state: 'open' | 'closed' | 'merged'
  readonly terminalAt: string | null
}

const DAY_MS = 24 * 60 * 60 * 1_000
const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000

function latestTimestamp(values: ReadonlyArray<string | null | undefined>): string | null
{
  let latest: string | null = null
  for (const value of values)
  {
    if (value != null && Date.parse(value) > (latest === null ? -Infinity : Date.parse(latest)))
    {
      latest = value
    }
  }
  return latest
}

export function isAutoSettlementCandidate(thread: OrchestrationThreadShell, now: string): boolean
{
  if (thread.archivedAt !== null || thread.settledOverride !== null) return false
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return false
  if (
    thread.session?.status === 'starting' ||
    thread.session?.status === 'running' ||
    thread.session?.activeTurnId != null ||
    thread.providerSwitch !== null ||
    thread.orchestrateRunExecution?.lifecycle === 'active'
  )
    return false
  const latestTurnAt = latestTimestamp([
    thread.latestTurn?.requestedAt,
    thread.latestTurn?.startedAt,
    thread.latestTurn?.completedAt,
  ])
  if (
    thread.session?.status !== 'error' &&
    thread.latestUserMessageAt !== null &&
    Math.abs(Date.parse(now) - Date.parse(thread.latestUserMessageAt)) <=
      QUEUED_TURN_START_GRACE_MS &&
    (latestTurnAt === null || Date.parse(thread.latestUserMessageAt) > Date.parse(latestTurnAt))
  )
    return false
  if (thread.snoozedUntil == null || Date.parse(thread.snoozedUntil) <= Date.parse(now)) return true
  return (
    (thread.session?.status === 'error' &&
      (thread.snoozedAt == null ||
        Date.parse(thread.session.updatedAt) > Date.parse(thread.snoozedAt))) ||
    (thread.snoozedAt != null &&
      thread.latestTurn?.state === 'completed' &&
      thread.latestTurn.completedAt != null &&
      Date.parse(thread.latestTurn.completedAt) > Date.parse(thread.snoozedAt))
  )
}

export function resolveAutoSettlementAt(input: {
  readonly thread: OrchestrationThreadShell
  readonly pullRequest: SettlementPullRequest | null
  readonly now: string
  readonly autoSettleAfterDays: number | null
  readonly autoSettleOnMerge: boolean
}): string | null
{
  const { thread, pullRequest } = input
  if (!isAutoSettlementCandidate(thread, input.now)) return null
  const activityAt = latestTimestamp([
    thread.latestUserMessageAt,
    thread.latestTurn?.requestedAt,
    thread.latestTurn?.startedAt,
    thread.latestTurn?.completedAt,
  ])
  if (pullRequest?.state === 'open') return null
  if (
    pullRequest !== null &&
    pullRequest.terminalAt !== null &&
    (pullRequest.state === 'closed' || (pullRequest.state === 'merged' && input.autoSettleOnMerge))
  )
  {
    const userAnchor = latestTimestamp([
      thread.createdAt,
      thread.latestUserMessageAt,
      thread.latestTurn?.requestedAt,
    ])
    if (userAnchor !== null && Date.parse(pullRequest.terminalAt) >= Date.parse(userAnchor))
    {
      return input.now
    }
  }
  if (input.autoSettleAfterDays === null || activityAt === null) return null
  return Date.parse(activityAt) < Date.parse(input.now) - input.autoSettleAfterDays * DAY_MS
    ? input.now
    : null
}
