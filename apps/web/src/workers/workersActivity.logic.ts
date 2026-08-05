// apps/web/src/workers/workersActivity.logic.ts
// pure derivations for the live worker activity trace

import type {
  WorkersActivityEntry,
  WorkersActivityPhase,
  WorkersActivityStatus,
  WorkersJobStatus,
} from '@t3tools/contracts'

import {
  workerJobIsActive,
  workerStatusBadgeVariant,
  type WorkerStatusBadgeVariant,
} from './workersPanel.logic'

const PHASE_LABELS: Record<WorkersActivityPhase, string> = {
  preparing: 'Preparing',
  working: 'Working',
  verifying: 'Verifying',
  finalizing: 'Finalizing',
}

const JOB_STATUS_LABELS: Record<WorkersJobStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  unknown: 'Unknown',
}

// the trace only carries start/complete/fail, so the tint mirrors the job-status scale
// rather than inventing a separate vocabulary
const ACTIVITY_STATUS_VARIANTS: Record<WorkersActivityStatus, WorkerStatusBadgeVariant> = {
  started: 'info',
  completed: 'success',
  failed: 'error',
}

export interface WorkerActivityPhaseView
{
  readonly phase: WorkersActivityPhase
  readonly status: WorkersActivityStatus
}

export function workerActivityPhaseLabel(view: WorkerActivityPhaseView): string
{
  const name = PHASE_LABELS[view.phase]
  switch (view.status)
  {
    case 'started':
      return name
    case 'completed':
      return `${name} complete`
    case 'failed':
      return `${name} failed`
  }
}

export interface WorkerActivityHeadline
{
  readonly label: string
  readonly variant: WorkerStatusBadgeVariant
}

// a live job leads with the phase it is actually in; a terminal job leads with its own
// status because the last phase entry can predate whatever ended the job
export function workerActivityHeadline(
  status: WorkersJobStatus,
  phase: WorkerActivityPhaseView | null,
): WorkerActivityHeadline
{
  if (phase !== null && workerJobIsActive(status))
  {
    return {
      label: workerActivityPhaseLabel(phase),
      variant: ACTIVITY_STATUS_VARIANTS[phase.status],
    }
  }
  return { label: JOB_STATUS_LABELS[status], variant: workerStatusBadgeVariant(status) }
}

export interface WorkerActivityHistoryEntry
{
  readonly key: string
  readonly recordedAt: string
  readonly label: string
  readonly text: string | null
}

function historyEntry(entry: WorkersActivityEntry): WorkerActivityHistoryEntry
{
  const key = `${entry.sequence}:${entry.kind}`
  switch (entry.kind)
  {
    case 'phase':
      return {
        key,
        recordedAt: entry.recordedAt,
        label: `${entry.phase} ${entry.status}`,
        text: null,
      }
    case 'action':
      // actions deliberately carry no command, path, or output — only that one ran
      return { key, recordedAt: entry.recordedAt, label: `action ${entry.status}`, text: null }
    case 'message':
      return { key, recordedAt: entry.recordedAt, label: 'note', text: entry.summary }
  }
}

// a truncated window has settlements whose starts fell off the front, so pairing them
// would invent both a total & an in-flight count; it reports the events it can actually
// see instead — "3 started · 2 done in visible history"
function visibleActionLabel(started: number, completed: number, failed: number): string | null
{
  const parts: string[] = []
  if (started > 0) parts.push(`${started} started`)
  if (completed > 0) parts.push(`${completed} done`)
  if (failed > 0) parts.push(`${failed} failed`)
  return parts.length === 0 ? null : `${parts.join(' · ')} in visible history`
}

// "4 actions · 2 done · 1 failed · 1 in flight" for a complete window, where every
// settlement has its start in view; the total still guards against a settlement whose
// start was skipped as unreadable
function actionSummaryLabel(
  started: number,
  completed: number,
  failed: number,
  truncated: boolean,
): string | null
{
  if (truncated) return visibleActionLabel(started, completed, failed)

  const total = Math.max(started, completed + failed)
  if (total === 0) return null
  const parts = [`${total} action${total === 1 ? '' : 's'}`]
  if (completed > 0) parts.push(`${completed} done`)
  if (failed > 0) parts.push(`${failed} failed`)
  const inFlight = Math.max(0, started - completed - failed)
  if (inFlight > 0) parts.push(`${inFlight} in flight`)
  return parts.join(' · ')
}

export interface WorkerActivityView
{
  readonly latestPhase: WorkerActivityPhaseView | null
  readonly latestMessage: string | null
  readonly actionSummary: string | null
  readonly history: readonly WorkerActivityHistoryEntry[]
}

// one pass over the sequence-ordered window: the latest phase & message win the headline
// while actions only ever roll up into counts; truncation is carried in because it
// decides whether those counts may be paired at all
export function workerActivityView(
  entries: readonly WorkersActivityEntry[],
  truncated: boolean,
): WorkerActivityView
{
  const ordered = [...entries].sort((left, right) => left.sequence - right.sequence)
  let latestPhase: WorkerActivityPhaseView | null = null
  let latestMessage: string | null = null
  let started = 0
  let completed = 0
  let failed = 0

  for (const entry of ordered)
  {
    switch (entry.kind)
    {
      case 'phase':
        latestPhase = { phase: entry.phase, status: entry.status }
        break
      case 'message':
        latestMessage = entry.summary
        break
      case 'action':
        if (entry.status === 'started') started += 1
        else if (entry.status === 'completed') completed += 1
        else failed += 1
        break
    }
  }

  return {
    latestPhase,
    latestMessage,
    actionSummary: actionSummaryLabel(started, completed, failed, truncated),
    history: ordered.map(historyEntry),
  }
}

// the stream can fail while the last snapshot is still on screen, so the disconnect is
// stated either way: as an outright unavailability when nothing was ever read, and as a
// staleness qualifier over the trace that remains
export function workerActivityTransportLabel(
  error: string | null,
  hasSnapshot: boolean,
): string | null
{
  if (error === null) return null
  return hasSnapshot
    ? `Live updates disconnected — showing the last activity read. ${error}`
    : `Live activity is unavailable. ${error}`
}

// the panel clock is minute-quantized, so trace ages round to it instead of borrowing a
// second-level relative label the clock cannot back
export function workerActivityAgeLabel(recordedAt: string, nowMs: number): string
{
  const at = Date.parse(recordedAt)
  if (!Number.isFinite(at)) return '—'

  const minutes = Math.floor(Math.max(0, nowMs - at) / 60_000)
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

// the window is bounded on the broker side, so both degradations are stated rather than
// letting the trace silently read as complete
export function workerActivityNoticeLabel(snapshot: {
  readonly skippedEntryCount: number
  readonly truncated: boolean
}): string | null
{
  const parts: string[] = []
  if (snapshot.truncated) parts.push('earlier entries not shown')
  if (snapshot.skippedEntryCount > 0)
  {
    const count = snapshot.skippedEntryCount
    parts.push(`${count} unreadable entr${count === 1 ? 'y' : 'ies'}`)
  }
  return parts.length === 0 ? null : parts.join(' · ')
}
