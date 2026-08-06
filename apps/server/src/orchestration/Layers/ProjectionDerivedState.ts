// apps/server/src/orchestration/Layers/ProjectionDerivedState.ts
// derive pending user-input and proposed-plan flags from projections

import { ApprovalRequestId, type OrchestrationSessionStatus } from '@t3tools/contracts'

import type { ProjectionThreadActivity } from '../../persistence/Services/ProjectionThreadActivities.ts'
import type { ProjectionThreadProposedPlan } from '../../persistence/Services/ProjectionThreadProposedPlans.ts'

export function settledTurnStateForSessionStatus(
  status: OrchestrationSessionStatus,
): 'completed' | 'interrupted' | 'error' | null
{
  switch (status)
  {
    case 'idle':
    case 'ready':
      return 'completed'
    case 'error':
      return 'error'
    case 'interrupted':
    case 'stopped':
      return 'interrupted'
    case 'starting':
    case 'running':
      return null
  }
}

export function extractActivityRequestId(payload: unknown): ApprovalRequestId | null
{
  if (typeof payload !== 'object' || payload === null)
  {
    return null
  }
  const requestId = (payload as Record<string, unknown>).requestId
  return typeof requestId === 'string' ? ApprovalRequestId.make(requestId) : null
}

export function derivePendingUserInputCountFromActivities(
  activities: ReadonlyArray<ProjectionThreadActivity>,
): number
{
  const openRequestIds = new Set<string>()
  const ordered = [...activities].toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.activityId.localeCompare(right.activityId),
  )

  for (const activity of ordered)
  {
    const requestId = extractActivityRequestId(activity.payload)
    if (requestId === null)
    {
      continue
    }
    const payload =
      typeof activity.payload === 'object' && activity.payload !== null
        ? (activity.payload as Record<string, unknown>)
        : null
    const detail = typeof payload?.detail === 'string' ? payload.detail.toLowerCase() : null

    if (activity.kind === 'user-input.requested')
    {
      openRequestIds.add(requestId)
      continue
    }

    if (activity.kind === 'user-input.resolved')
    {
      openRequestIds.delete(requestId)
      continue
    }

    if (
      activity.kind === 'provider.user-input.respond.failed' &&
      detail !== null &&
      (detail.includes('stale pending user-input request') ||
        detail.includes('unknown pending user-input request') ||
        detail.includes('unknown pending user input request') ||
        detail.includes('unknown pending codex user input request'))
    )
    {
      openRequestIds.delete(requestId)
    }
  }

  return openRequestIds.size
}

export function deriveHasActionableProposedPlan(input: {
  readonly latestTurnId: string | null
  readonly proposedPlans: ReadonlyArray<ProjectionThreadProposedPlan>
}): boolean
{
  const sorted = [...input.proposedPlans].toSorted(
    (left, right) =>
      left.updatedAt.localeCompare(right.updatedAt) || left.planId.localeCompare(right.planId),
  )

  let latestForTurn: ProjectionThreadProposedPlan | null = null
  if (input.latestTurnId !== null)
  {
    for (let index = sorted.length - 1; index >= 0; index -= 1)
    {
      const plan = sorted[index]
      if (plan?.turnId === input.latestTurnId)
      {
        latestForTurn = plan
        break
      }
    }
  }
  if (latestForTurn !== null)
  {
    return latestForTurn.implementedAt === null
  }

  const latestPlan = sorted.at(-1) ?? null
  return latestPlan !== null && latestPlan.implementedAt === null
}
