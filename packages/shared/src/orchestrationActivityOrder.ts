// packages/shared/src/orchestrationActivityOrder.ts
// defines canonical ordering for imported and live orchestration activities

import type { OrchestrationThreadActivity } from '@t3tools/contracts'

type Ordering = -1 | 0 | 1

function compareValues(left: number | string, right: number | string): Ordering
{
  return left < right ? -1 : left > right ? 1 : 0
}

function activityLifecycleRank(kind: string): number
{
  if (kind.endsWith('.started') || kind === 'tool.started')
  {
    return 0
  }
  if (kind.endsWith('.completed') || kind.endsWith('.resolved'))
  {
    return 2
  }
  return 1
}

export function compareOrchestrationThreadActivities(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): Ordering
{
  const leftImported = left.turnId === null && left.sequence !== undefined
  const rightImported = right.turnId === null && right.sequence !== undefined
  if (leftImported !== rightImported)
  {
    return leftImported ? -1 : 1
  }

  if (leftImported && rightImported && left.sequence !== right.sequence)
  {
    return compareValues(left.sequence!, right.sequence!)
  }

  const createdAtOrder = compareValues(left.createdAt, right.createdAt)
  if (createdAtOrder !== 0)
  {
    return createdAtOrder
  }

  if (left.sequence !== undefined && right.sequence !== undefined)
  {
    const sequenceOrder = compareValues(left.sequence, right.sequence)
    if (sequenceOrder !== 0)
    {
      return sequenceOrder
    }
  }
  else if (left.sequence !== undefined)
  {
    return -1
  }
  else if (right.sequence !== undefined)
  {
    return 1
  }

  const lifecycleOrder = compareValues(
    activityLifecycleRank(left.kind),
    activityLifecycleRank(right.kind),
  )
  return lifecycleOrder !== 0 ? lifecycleOrder : compareValues(left.id, right.id)
}
