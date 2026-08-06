// apps/web/src/components/settings/diagnostics/ProcessDiagnosticsTable.tsx
// render server process diagnostics table and signal actions

import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import type { ServerProcessDiagnosticsEntry, ServerProcessSignal } from '@t3tools/contracts'

import { ScrollArea } from '../../ui/scroll-area'
import { Tooltip, TooltipPopup, TooltipTrigger } from '../../ui/tooltip'
import { DiagnosticsTable, EmptyRows, formatBytes, formatRelativeNoWrap } from './chrome'

export function formatProcessName(command: string): string
{
  const firstToken = command.trim().split(/\s+/)[0]
  if (!firstToken) return command
  const normalized = firstToken.replace(/^['"]|['"]$/g, '')
  const segments = normalized.split(/[\\/]/).filter(Boolean)
  return segments.at(-1) ?? normalized
}

export function formatProcessType(process: ServerProcessDiagnosticsEntry): string
{
  if (process.depth > 0) return 'Subprocess'
  if (/\b(codex|claude|opencode|cursor)\b/i.test(process.command)) return 'Agent'
  return 'Process'
}

export function ProcessNameCell({
  process,
  isExpanded,
  onToggle,
}: {
  process: ServerProcessDiagnosticsEntry
  isExpanded: boolean
  onToggle: (pid: number) => void
})
{
  const name = formatProcessName(process.command)
  const hasChildren = process.childPids.length > 0
  const ChevronIcon = isExpanded ? ChevronDownIcon : ChevronRightIcon

  return (
    <div
      className="grid min-w-0 grid-cols-[1.25rem_0.375rem_minmax(0,1fr)] items-center gap-2"
      style={{ paddingLeft: `${Math.min(process.depth, 6) * 10}px` }}
    >
      {hasChildren ? (
        <button
          type="button"
          className="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={isExpanded ? `Collapse ${name}` : `Expand ${name}`}
          onClick={() => onToggle(process.pid)}
        >
          <ChevronIcon className="size-3.5" />
        </button>
      ) : (
        <span className="size-5 shrink-0" aria-hidden="true" />
      )}
      <span className="size-1.5 shrink-0 rounded-full bg-emerald-500/80" />
      <Tooltip>
        <TooltipTrigger
          render={<span className="min-w-0 truncate font-medium text-foreground">{name}</span>}
        />
        <TooltipPopup
          side="top"
          className="max-w-[min(440px,calc(100vw-2rem))] whitespace-normal break-words text-left font-mono text-[11px] leading-relaxed text-wrap"
        >
          {process.command}
        </TooltipPopup>
      </Tooltip>
    </div>
  )
}

export function ProcessSignalActions({
  process,
  isSignaling,
  onSignal,
}: {
  process: ServerProcessDiagnosticsEntry
  isSignaling: boolean
  onSignal: (pid: number, signal: ServerProcessSignal) => void
})
{
  return (
    <div className="flex items-center justify-end gap-1.5">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              disabled={isSignaling}
              className="text-[11px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:pointer-events-none disabled:opacity-50"
              onClick={() => onSignal(process.pid, 'SIGINT')}
            >
              INT
            </button>
          }
        />
        <TooltipPopup side="top">Send SIGINT</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              disabled={isSignaling}
              className="text-[11px] font-medium text-destructive underline-offset-2 hover:underline disabled:pointer-events-none disabled:opacity-50"
              onClick={() => onSignal(process.pid, 'SIGKILL')}
            >
              KILL
            </button>
          }
        />
        <TooltipPopup side="top">Send SIGKILL</TooltipPopup>
      </Tooltip>
    </div>
  )
}

export function ProcessDiagnosticsTable({
  processes,
  signalingPid,
  onSignal,
  emptyLabel,
}: {
  processes: ReadonlyArray<ServerProcessDiagnosticsEntry>
  signalingPid: number | null
  onSignal: (pid: number, signal: ServerProcessSignal) => void
  emptyLabel?: string
})
{
  const [collapsedPids, setCollapsedPids] = useState<ReadonlySet<number>>(() => new Set())
  const visibleProcesses = useMemo(() =>
  {
    const visible: ServerProcessDiagnosticsEntry[] = []
    let hiddenChildDepth: number | null = null

    for (const process of processes)
    {
      if (hiddenChildDepth !== null)
      {
        if (process.depth > hiddenChildDepth) continue
        hiddenChildDepth = null
      }

      visible.push(process)
      if (collapsedPids.has(process.pid))
      {
        hiddenChildDepth = process.depth
      }
    }

    return visible
  }, [collapsedPids, processes])

  const toggleProcess = useCallback((pid: number) =>
  {
    setCollapsedPids((previous) =>
    {
      const next = new Set(previous)
      if (next.has(pid))
      {
        next.delete(pid)
      }
      else
      {
        next.add(pid)
      }
      return next
    })
  }, [])

  return (
    <ScrollArea
      chainVerticalScroll
      scrollFade
      hideScrollbars
      className="max-h-[min(64vh,44rem)] w-full max-w-full rounded-none border-t border-border/60"
    >
      <table className="w-full min-w-[1040px] table-fixed text-left text-xs">
        <colgroup>
          <col className="w-[24%]" />
          <col className="w-[8%]" />
          <col className="w-[10%]" />
          <col className="w-[33%]" />
          <col className="w-[8%]" />
          <col className="w-[11%]" />
          <col className="w-[6%]" />
        </colgroup>
        <thead className="sticky top-0 z-10 border-b border-border/60 bg-card text-[11px] uppercase tracking-[0.08em] text-muted-foreground/70">
          <tr>
            <th className="px-4 py-2 font-semibold sm:pl-5">Name</th>
            <th className="px-3 py-2 text-right font-semibold">CPU</th>
            <th className="px-3 py-2 text-right font-semibold">Memory</th>
            <th className="px-3 py-2 font-semibold">Command</th>
            <th className="px-3 py-2 text-right font-semibold">PID</th>
            <th className="px-3 py-2 font-semibold">Type</th>
            <th className="p-2 text-right font-semibold sm:pr-4">Kill</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/50">
          {visibleProcesses.length === 0 ? (
            <tr>
              <td colSpan={7} className="px-4 py-4 text-xs text-muted-foreground sm:px-5">
                {emptyLabel ?? 'No live descendant processes found.'}
              </td>
            </tr>
          ) : null}
          {visibleProcesses.map((process) => (
            <tr key={process.pid} className="hover:bg-muted/20">
              <td className="px-4 py-2 align-middle sm:pl-5">
                <ProcessNameCell
                  process={process}
                  isExpanded={!collapsedPids.has(process.pid)}
                  onToggle={toggleProcess}
                />
              </td>
              <td className="px-3 py-2 text-right align-middle font-mono tabular-nums">
                {process.cpuPercent.toFixed(1)}%
              </td>
              <td className="px-3 py-2 text-right align-middle font-mono tabular-nums">
                {formatBytes(process.rssBytes)}
              </td>
              <td className="px-3 py-2 align-middle text-muted-foreground">
                <Tooltip>
                  <TooltipTrigger
                    render={<span className="block truncate">{process.command}</span>}
                  />
                  <TooltipPopup
                    side="top"
                    className="max-w-[min(440px,calc(100vw-2rem))] whitespace-normal break-words text-left font-mono text-[11px] leading-relaxed text-wrap"
                  >
                    {process.command}
                  </TooltipPopup>
                </Tooltip>
              </td>
              <td className="px-3 py-2 text-right align-middle font-mono tabular-nums text-muted-foreground">
                {process.pid}
              </td>
              <td className="truncate px-3 py-2 align-middle text-muted-foreground">
                {formatProcessType(process)}
              </td>
              <td className="p-2 align-middle sm:pr-4">
                <ProcessSignalActions
                  process={process}
                  isSignaling={signalingPid === process.pid}
                  onSignal={onSignal}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollArea>
  )
}
