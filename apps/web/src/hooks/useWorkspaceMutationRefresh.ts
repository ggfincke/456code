// apps/web/src/hooks/useWorkspaceMutationRefresh.ts
// refresh workspace resources after terminal mutations without interrupting local saves

import type { OrchestrationThreadActivity } from '@t3tools/contracts'
import { useEffect, useRef } from 'react'

const WORKSPACE_MUTATION_ITEM_TYPES = new Set(['command_execution', 'file_change'])

export function latestWorkspaceMutationId(
  activities: ReadonlyArray<Pick<OrchestrationThreadActivity, 'id' | 'kind' | 'payload'>>,
): string | null
{
  for (let index = activities.length - 1; index >= 0; index -= 1)
  {
    const activity = activities[index]
    if (!activity) continue
    const payload =
      activity.payload !== null && typeof activity.payload === 'object'
        ? (activity.payload as Record<string, unknown>)
        : null
    const terminalUpdate =
      activity.kind === 'tool.updated' &&
      typeof payload?.status === 'string' &&
      payload.status !== 'inProgress' &&
      payload.status !== 'in_progress'
    if (activity.kind !== 'tool.completed' && !terminalUpdate) continue
    if (
      typeof payload?.itemType === 'string' &&
      WORKSPACE_MUTATION_ITEM_TYPES.has(payload.itemType)
    )
    {
      return activity.id
    }
  }
  return null
}

export function useWorkspaceMutationRefresh(input: {
  readonly enabled?: boolean
  readonly mutationId: string | null
  readonly refresh: () => void
  readonly resourceKey: string
}): void
{
  const { enabled = true, mutationId, refresh, resourceKey } = input
  const handledTokenRef = useRef<string | null>(null)

  useEffect(() =>
  {
    if (!enabled || mutationId === null) return
    const token = JSON.stringify([resourceKey, mutationId])
    if (handledTokenRef.current === token) return
    // leave disabled mutations pending until their local save owner releases them
    handledTokenRef.current = token
    refresh()
  }, [enabled, mutationId, refresh, resourceKey])
}
