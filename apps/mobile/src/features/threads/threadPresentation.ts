// apps/mobile/src/features/threads/threadPresentation.ts
// expose thread sort value

import type { StatusTone } from '../../components/StatusPill'
import {
  normalizeCollaborationMode,
  type OrchestrationLatestTurn,
  type OrchestrationSession,
} from '@t3tools/contracts'
import { EnvironmentThreadShell } from '@t3tools/client-runtime/state/shell'
import { isThreadAwarenessStale } from '@t3tools/shared/agentAwareness'

export function threadSortValue(thread: EnvironmentThreadShell): number
{
  const candidate = Date.parse(thread.updatedAt ?? thread.createdAt)
  return Number.isNaN(candidate) ? 0 : candidate
}

export type ThreadStatusKind =
  | 'pending-approval'
  | 'awaiting-input'
  | 'working'
  | 'stale'
  | 'connecting'
  | 'error'
  | 'plan-ready'

export interface ThreadStatusPresentation extends StatusTone
{
  readonly kind: ThreadStatusKind
  // foreground color for the leading status icon.
  readonly iconColor: string
  // background color for the leading status icon circle.
  readonly iconBackground: string
  // whether the indicator represents in-flight activity.
  readonly pulse: boolean
}

// neutral icon colors for threads with no actionable status.
export const THREAD_STATUS_NEUTRAL_ICON = {
  iconColor: '#8e8e93',
  iconBackground: 'rgba(142,142,147,0.22)',
} as const

function isLatestTurnSettled(
  latestTurn: OrchestrationLatestTurn | null,
  session: OrchestrationSession | null,
): boolean
{
  if (!latestTurn?.startedAt) return false
  if (!latestTurn.completedAt) return false
  if (!session) return true
  return session.status !== 'running'
}

// resolves the user-facing status of a thread, in priority order. Returns
// `null` for quiescent threads so rows stay free of "Idle"-style noise.
// mirrors `resolveThreadStatusPill` in apps/web/src/components/Sidebar.logic.ts.
export function resolveThreadStatus(
  thread: EnvironmentThreadShell,
  options?: { readonly nowMs?: number | undefined },
): ThreadStatusPresentation | null
{
  if (thread.hasPendingApprovals)
  {
    return {
      kind: 'pending-approval',
      label: 'Needs Approval',
      pillClassName: 'bg-adaptive-amber-500-a12-a16',
      textClassName: 'text-adaptive-amber-700-300',
      iconColor: '#ff9f0a',
      iconBackground: 'rgba(255,159,10,0.22)',
      pulse: false,
    }
  }

  if (thread.hasPendingUserInput)
  {
    return {
      kind: 'awaiting-input',
      label: 'Awaiting Input',
      pillClassName: 'bg-adaptive-indigo-500-a12-a16',
      textClassName: 'text-adaptive-indigo-700-300',
      iconColor: '#5e5ce6',
      iconBackground: 'rgba(94,92,230,0.22)',
      pulse: false,
    }
  }

  if (thread.session?.status === 'running')
  {
    // same amber as the pending-approval branch and the Live Activity's stale
    // tint, so a thread that stopped reporting reads the same on every surface.
    if (options?.nowMs !== undefined && isThreadAwarenessStale(thread, options.nowMs))
    {
      return {
        kind: 'stale',
        label: 'Stalled',
        pillClassName: 'bg-adaptive-amber-500-a12-a16',
        textClassName: 'text-adaptive-amber-700-300',
        iconColor: '#ff9f0a',
        iconBackground: 'rgba(255,159,10,0.22)',
        pulse: false,
      }
    }
    return {
      kind: 'working',
      label: 'Working',
      pillClassName: 'bg-adaptive-sky-500-a12-a16',
      textClassName: 'text-adaptive-sky-700-300',
      iconColor: '#0a84ff',
      iconBackground: 'rgba(10,132,255,0.22)',
      pulse: true,
    }
  }

  if (thread.session?.status === 'starting')
  {
    return {
      kind: 'connecting',
      label: 'Connecting',
      pillClassName: 'bg-adaptive-sky-500-a12-a16',
      textClassName: 'text-adaptive-sky-700-300',
      iconColor: '#0a84ff',
      iconBackground: 'rgba(10,132,255,0.22)',
      pulse: true,
    }
  }

  if (thread.session?.status === 'error' || thread.latestTurn?.state === 'error')
  {
    return {
      kind: 'error',
      label: 'Error',
      pillClassName: 'bg-adaptive-rose-500-a12-a16',
      textClassName: 'text-adaptive-rose-700-300',
      iconColor: '#ff453a',
      iconBackground: 'rgba(255,69,58,0.22)',
      pulse: false,
    }
  }

  const hasPlanReadyPrompt =
    normalizeCollaborationMode(thread.interactionMode, thread.orchestrate).baseMode === 'plan' &&
    isLatestTurnSettled(thread.latestTurn, thread.session) &&
    thread.hasActionableProposedPlan
  if (hasPlanReadyPrompt)
  {
    return {
      kind: 'plan-ready',
      label: 'Plan Ready',
      pillClassName: 'bg-adaptive-violet-500-a12-a16',
      textClassName: 'text-adaptive-violet-700-300',
      iconColor: '#bf5af2',
      iconBackground: 'rgba(191,90,242,0.22)',
      pulse: false,
    }
  }

  return null
}
