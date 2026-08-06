// apps/server/src/terminal/sessionSnapshot.ts
// terminal session snapshot, summary, and attach-event helpers

import { getTerminalLabel } from '@t3tools/shared/terminalLabels'
import type {
  TerminalAttachStreamEvent,
  TerminalEvent,
  TerminalSessionSnapshot,
  TerminalSessionStatus,
  TerminalSummary,
} from '@t3tools/contracts'

const MAX_TERMINAL_LABEL_LENGTH = 128

export type TerminalSessionSnapshotSource = {
  readonly threadId: string
  readonly terminalId: string
  readonly cwd: string
  readonly worktreePath: string | null
  readonly status: TerminalSessionStatus
  readonly pid: number | null
  readonly history: string
  readonly exitCode: number | null
  readonly exitSignal: number | null
  readonly updatedAt: string
  readonly eventSequence: number
  readonly hasRunningSubprocess: boolean
  readonly childCommandLabel: string | null
}

export function truncateTerminalWireLabel(value: string): string
{
  if (value.length <= MAX_TERMINAL_LABEL_LENGTH) return value
  return value.slice(0, MAX_TERMINAL_LABEL_LENGTH)
}

export function normalizeChildCommandName(raw: string, platform: NodeJS.Platform): string | null
{
  let trimmed = raw.trim()
  if (trimmed.length === 0) return null
  if (
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    (trimmed.startsWith('(') && trimmed.endsWith(')'))
  )
  {
    trimmed = trimmed.slice(1, -1).trim()
  }
  const firstToken = (trimmed.split(/\s+/)[0] ?? trimmed).trim()
  if (firstToken.length === 0) return null
  const separators = platform === 'win32' ? /[\\/]/ : /\//
  const base = firstToken.split(separators).at(-1) ?? firstToken
  const withoutExe =
    platform === 'win32' && base.toLowerCase().endsWith('.exe') ? base.slice(0, -4) : base
  return withoutExe.length > 0 ? withoutExe : null
}

export function terminalWireLabel(session: TerminalSessionSnapshotSource): string
{
  if (session.hasRunningSubprocess && session.childCommandLabel)
  {
    const trimmed = session.childCommandLabel.trim()
    if (trimmed.length > 0)
    {
      return truncateTerminalWireLabel(trimmed)
    }
  }
  return truncateTerminalWireLabel(getTerminalLabel(session.terminalId))
}

export function snapshot(session: TerminalSessionSnapshotSource): TerminalSessionSnapshot
{
  return {
    threadId: session.threadId,
    terminalId: session.terminalId,
    cwd: session.cwd,
    worktreePath: session.worktreePath,
    status: session.status,
    pid: session.pid,
    history: session.history,
    exitCode: session.exitCode,
    exitSignal: session.exitSignal,
    label: terminalWireLabel(session),
    updatedAt: session.updatedAt,
    sequence: session.eventSequence,
  }
}

export function summary(session: TerminalSessionSnapshotSource): TerminalSummary
{
  return {
    threadId: session.threadId,
    terminalId: session.terminalId,
    cwd: session.cwd,
    worktreePath: session.worktreePath,
    status: session.status,
    pid: session.pid,
    exitCode: session.exitCode,
    exitSignal: session.exitSignal,
    hasRunningSubprocess: session.hasRunningSubprocess,
    label: terminalWireLabel(session),
    updatedAt: session.updatedAt,
  }
}

export function shouldPublishTerminalMetadataEvent(event: TerminalEvent): boolean
{
  switch (event.type)
  {
    case 'started':
    case 'restarted':
    case 'exited':
    case 'closed':
    case 'error':
    case 'activity':
      return true
    case 'output':
    case 'cleared':
      return false
  }
}

export function terminalEventToAttachEvent(event: TerminalEvent): TerminalAttachStreamEvent | null
{
  switch (event.type)
  {
    case 'started':
      return {
        type: 'snapshot',
        snapshot: event.snapshot,
      }
    case 'output':
    case 'exited':
    case 'closed':
    case 'error':
    case 'cleared':
    case 'restarted':
    case 'activity':
      return event
  }
}

export function isDuplicateAttachSnapshotEvent(
  event: TerminalEvent,
  initialSnapshot: TerminalSessionSnapshot,
)
{
  return typeof event.sequence === 'number' && typeof initialSnapshot.sequence === 'number'
    ? event.sequence <= initialSnapshot.sequence
    : event.type === 'started' &&
        event.snapshot.threadId === initialSnapshot.threadId &&
        event.snapshot.terminalId === initialSnapshot.terminalId &&
        event.snapshot.updatedAt <= initialSnapshot.updatedAt
}
