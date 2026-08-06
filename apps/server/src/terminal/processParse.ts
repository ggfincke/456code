// apps/server/src/terminal/processParse.ts
// parse process table snapshots for terminal subprocess inspection

import { normalizeChildCommandName, truncateTerminalWireLabel } from './sessionSnapshot.ts'

export interface TerminalSubprocessInspectResult
{
  readonly hasRunningSubprocess: boolean
  readonly childCommand: string | null
  readonly processIds: ReadonlyArray<number>
}

export interface ProcessSnapshotRow
{
  readonly pid: number
  readonly ppid: number
  readonly command: string
}

export function parseProcessSnapshot(
  output: string,
  platform: NodeJS.Platform,
): ProcessSnapshotRow[]
{
  const rows: ProcessSnapshotRow[] = []
  for (const line of output.split(/\r?\n/g))
  {
    const parts = platform === 'win32' ? line.trim().split('|', 3) : line.trim().split(/\s+/, 3)
    const pid = Number(parts[0])
    const ppid = Number(parts[1])
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid) || ppid < 0) continue
    rows.push({ pid, ppid, command: parts[2]?.trim() ?? '' })
  }
  return rows
}

export function inspectProcessSnapshotRows(
  terminalPids: ReadonlyArray<number>,
  rows: ReadonlyArray<ProcessSnapshotRow>,
  platform: NodeJS.Platform,
): ReadonlyMap<number, TerminalSubprocessInspectResult>
{
  const commandByPid = new Map(rows.map((row) => [row.pid, row.command]))
  const childrenByParent = new Map<number, number[]>()
  for (const row of rows)
  {
    const children = childrenByParent.get(row.ppid) ?? []
    children.push(row.pid)
    childrenByParent.set(row.ppid, children)
  }

  const inspections = new Map<number, TerminalSubprocessInspectResult>()
  for (const terminalPid of terminalPids)
  {
    const childPid = childrenByParent.get(terminalPid)?.[0]
    if (childPid === undefined)
    {
      inspections.set(terminalPid, {
        hasRunningSubprocess: false,
        childCommand: null,
        processIds: [],
      })
      continue
    }

    const processIds = new Set<number>([terminalPid])
    const pending = [terminalPid]
    while (pending.length > 0)
    {
      const parentPid = pending.pop()
      if (parentPid === undefined) continue
      for (const pid of childrenByParent.get(parentPid) ?? [])
      {
        if (processIds.has(pid)) continue
        processIds.add(pid)
        pending.push(pid)
      }
    }

    const normalized = normalizeChildCommandName(commandByPid.get(childPid) ?? '', platform)
    inspections.set(terminalPid, {
      hasRunningSubprocess: true,
      childCommand: normalized ? truncateTerminalWireLabel(normalized) : null,
      processIds: [...processIds],
    })
  }
  return inspections
}
