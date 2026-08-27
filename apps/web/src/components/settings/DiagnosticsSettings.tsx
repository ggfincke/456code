// apps/web/src/components/settings/DiagnosticsSettings.tsx
// render diagnostics settings

import { AlertTriangleIcon, FolderOpenIcon } from 'lucide-react'
import { useAtomValue } from '@effect/atom-react'
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from '@t3tools/client-runtime/state/runtime'
import { useCallback, useMemo, useState } from 'react'
import type { ServerProcessSignal } from '@t3tools/contracts'
import * as DateTime from 'effect/DateTime'
import * as Option from 'effect/Option'

import { cn } from '../../lib/utils'
import { resolveAndPersistPreferredEditor } from '../../lib/editorPreferences'
import { useEnvironmentQuery } from '../../state/query'
import {
  primaryServerAvailableEditorsAtom,
  primaryServerObservabilityAtom,
  serverEnvironment,
} from '../../state/server'
import { shellEnvironment } from '../../state/shell'
import { usePrimaryEnvironment } from '../../state/environments'
import { Button } from '../ui/button'
import { ScrollArea } from '../ui/scroll-area'
import { toastManager } from '../ui/toast'
import { Tooltip, TooltipPopup, TooltipTrigger } from '../ui/tooltip'
import { SettingsPageContainer, SettingsSection } from './settingsLayout'
import { useAtomCommand } from '../../state/use-atom-command'
import {
  DiagnosticsLastChecked,
  DiagnosticsRefreshButton,
  DiagnosticsTable,
  EmptyRows,
  ExpandableText,
  StatBlock,
  StatsGrid,
  TraceIdCell,
  formatBytes,
  formatCount,
  formatDuration,
  formatRelative,
  formatRelativeNoWrap,
  isStaleProcessSignalMessage,
} from './diagnostics/chrome'
import { ProcessDiagnosticsTable } from './diagnostics/ProcessDiagnosticsTable'
import {
  formatCpuTime,
  ProcessResourceHistoryChart,
  ProcessResourceHistoryTable,
  RESOURCE_HISTORY_WINDOWS,
  ResourceHistoryWindowSelector,
} from './diagnostics/ProcessResourceHistory'

export function DiagnosticsSettingsPanel()
{
  const observability = useAtomValue(primaryServerObservabilityAtom)
  const availableEditors = useAtomValue(primaryServerAvailableEditorsAtom)
  const primaryEnvironment = usePrimaryEnvironment()
  const environmentId = primaryEnvironment?.environmentId ?? null
  const signalServerProcess = useAtomCommand(serverEnvironment.signalProcess, {
    reportFailure: false,
  })
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, {
    reportFailure: false,
  })
  const [resourceWindowMs, setResourceWindowMs] = useState(15 * 60_000)
  const selectedResourceWindow =
    RESOURCE_HISTORY_WINDOWS.find((option) => option.windowMs === resourceWindowMs) ??
    RESOURCE_HISTORY_WINDOWS[1]
  const { data, error, isPending, refresh } = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.traceDiagnostics({ environmentId, input: {} }),
  )
  const {
    data: processData,
    error: processError,
    isPending: isProcessPending,
    refresh: refreshProcesses,
  } = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.processDiagnostics({ environmentId, input: {} }),
  )
  const {
    data: resourceData,
    error: resourceError,
    isPending: isResourcePending,
    refresh: refreshResources,
  } = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.processResourceHistory({
          environmentId,
          input: {
            windowMs: selectedResourceWindow.windowMs,
            bucketMs: selectedResourceWindow.bucketMs,
          },
        }),
  )
  const [isOpeningLogsDirectory, setIsOpeningLogsDirectory] = useState(false)
  const [openLogsDirectoryError, setOpenLogsDirectoryError] = useState<string | null>(null)
  const [signalingPid, setSignalingPid] = useState<number | null>(null)

  const openLogsDirectory = useCallback(() =>
  {
    const logsDirectoryPath = observability?.logsDirectoryPath ?? null
    if (!logsDirectoryPath) return

    const editor = resolveAndPersistPreferredEditor(availableEditors ?? [])
    if (!editor)
    {
      setOpenLogsDirectoryError('No available editors found.')
      return
    }
    if (environmentId === null)
    {
      setOpenLogsDirectoryError('No environment is selected.')
      return
    }

    setIsOpeningLogsDirectory(true)
    setOpenLogsDirectoryError(null)
    void (async () =>
    {
      const result = await openInEditor({
        environmentId,
        input: {
          cwd: logsDirectoryPath,
          editor,
        },
      })
      setIsOpeningLogsDirectory(false)
      if (result._tag === 'Failure' && !isAtomCommandInterrupted(result))
      {
        const error = squashAtomCommandFailure(result)
        setOpenLogsDirectoryError(
          error instanceof Error ? error.message : 'Unable to open logs folder.',
        )
      }
    })()
  }, [availableEditors, environmentId, observability?.logsDirectoryPath, openInEditor])

  const isInitialLoading = isPending && data === null
  const isProcessInitialLoading = isProcessPending && processData === null
  const signalProcess = useCallback(
    (pid: number, signal: ServerProcessSignal) =>
    {
      if (
        signal === 'SIGKILL' &&
        !window.confirm(`Send SIGKILL to process ${pid}? This cannot be handled by the process.`)
      )
      {
        return
      }
      if (environmentId === null)
      {
        return
      }

      setSignalingPid(pid)
      void (async () =>
      {
        const result = await signalServerProcess({
          environmentId,
          input: { pid, signal },
        })
        setSignalingPid(null)
        if (result._tag === 'Failure')
        {
          if (!isAtomCommandInterrupted(result))
          {
            const error = squashAtomCommandFailure(result)
            toastManager.add({
              type: 'error',
              title: `Could not send ${signal}`,
              description: error instanceof Error ? error.message : `Failed to send ${signal}.`,
            })
          }
          return
        }
        if (!result.value.signaled)
        {
          const message = Option.getOrUndefined(result.value.message)
          refreshProcesses()
          if (isStaleProcessSignalMessage(message))
          {
            toastManager.add({
              type: 'info',
              title: 'Process already exited',
              description:
                'The process is not a child of the 456code server. It might already have exited.',
            })
            return
          }

          toastManager.add({
            type: 'error',
            title: `Could not send ${signal}`,
            description: message ?? `Failed to send ${signal}.`,
          })
          return
        }
        refreshProcesses()
      })()
    },
    [environmentId, refreshProcesses, signalServerProcess],
  )

  const processDiagnosticsError = processData ? Option.getOrNull(processData.error) : null
  const processResourceError = resourceData ? Option.getOrNull(resourceData.error) : null
  const traceDiagnosticsError = data ? Option.getOrNull(data.error) : null
  const traceDiagnosticsPartialFailure = data
    ? Option.getOrElse(data.partialFailure, () => false)
    : false

  return (
    <SettingsPageContainer>
      <SettingsSection
        id="settings-live-processes"
        title="Live Processes"
        headerAction={
          <div className="flex items-center gap-1.5">
            <DiagnosticsLastChecked checkedAt={processData?.readAt ?? null} />
            <DiagnosticsRefreshButton
              isPending={isProcessPending}
              label="Refresh process diagnostics"
              onClick={refreshProcesses}
            />
          </div>
        }
      >
        <StatsGrid>
          <StatBlock
            label="Child Processes"
            value={processData ? formatCount(processData.processCount) : '...'}
          />
          <StatBlock
            label="CPU"
            value={processData ? `${processData.totalCpuPercent.toFixed(1)}%` : '...'}
            tooltip="Total CPU across live child processes of the current server process. The desktop shell and other parent processes are not included."
          />
          <StatBlock
            label="Memory"
            value={processData ? formatBytes(processData.totalRssBytes) : '...'}
            tooltip="Total resident memory across live child processes of the current server process. The desktop shell and other parent processes are not included."
          />
          <StatBlock
            label="Server PID"
            value={processData ? String(processData.serverPid) : '...'}
          />
        </StatsGrid>
        {processDiagnosticsError || processError ? (
          <div className="space-y-2 border-t border-border/60 px-4 py-3 text-xs text-muted-foreground sm:px-5">
            {processDiagnosticsError ? (
              <div className="flex items-start gap-2 text-destructive">
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>{processDiagnosticsError.message}</span>
              </div>
            ) : null}
            {processError ? (
              <div className="flex items-start gap-2 text-destructive">
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>{processError}</span>
              </div>
            ) : null}
          </div>
        ) : null}
        <ProcessDiagnosticsTable
          processes={processData?.processes ?? []}
          signalingPid={signalingPid}
          onSignal={signalProcess}
          emptyLabel={
            isProcessInitialLoading
              ? 'Loading live processes...'
              : 'No live descendant processes found.'
          }
        />
      </SettingsSection>

      <SettingsSection
        id="settings-resource-history"
        title="Resource History"
        headerAction={
          <div className="flex items-center gap-1.5">
            <ResourceHistoryWindowSelector
              selectedWindowMs={resourceWindowMs}
              onSelect={setResourceWindowMs}
            />
            <DiagnosticsLastChecked checkedAt={resourceData?.readAt ?? null} />
            <DiagnosticsRefreshButton
              isPending={isResourcePending}
              label="Refresh resource history"
              onClick={refreshResources}
            />
          </div>
        }
      >
        <StatsGrid>
          <StatBlock
            label="CPU Time"
            value={resourceData ? formatCpuTime(resourceData.totalCpuSecondsApprox) : '...'}
            tooltip="Approximate active CPU time for the 456code server root process and its descendants during the selected window. It grows only while sampled processes use CPU and older samples leave as the window moves."
          />
          <StatBlock
            label="Samples"
            value={resourceData ? formatCount(resourceData.retainedSampleCount) : '...'}
            tooltip="In-memory process samples retained by the server. This resets when the server restarts."
          />
          <StatBlock
            label="Interval"
            value={resourceData ? formatDuration(resourceData.sampleIntervalMs) : '...'}
          />
          <StatBlock
            label="Processes"
            value={resourceData ? formatCount(resourceData.topProcesses.length) : '...'}
          />
        </StatsGrid>
        {processResourceError || resourceError ? (
          <div className="space-y-2 border-t border-border/60 px-4 py-3 text-xs text-muted-foreground sm:px-5">
            {processResourceError ? (
              <div className="flex items-start gap-2 text-destructive">
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>{processResourceError.message}</span>
              </div>
            ) : null}
            {resourceError ? (
              <div className="flex items-start gap-2 text-destructive">
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>{resourceError}</span>
              </div>
            ) : null}
          </div>
        ) : null}
        <ProcessResourceHistoryChart buckets={resourceData?.buckets ?? []} />
        <ProcessResourceHistoryTable
          processes={resourceData?.topProcesses ?? []}
          emptyLabel={
            isResourcePending && resourceData === null
              ? 'Collecting process resource samples...'
              : 'No process resource samples found for this window.'
          }
        />
      </SettingsSection>

      <SettingsSection
        id="settings-trace-diagnostics"
        title="Trace Diagnostics"
        headerAction={
          <div className="flex items-center gap-1.5">
            <DiagnosticsLastChecked checkedAt={data?.readAt ?? null} />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                    disabled={!observability?.logsDirectoryPath || isOpeningLogsDirectory}
                    onClick={openLogsDirectory}
                    aria-label="Open logs folder"
                  >
                    <FolderOpenIcon className="size-3" />
                  </Button>
                }
              />
              <TooltipPopup side="top">Open logs folder</TooltipPopup>
            </Tooltip>
            <DiagnosticsRefreshButton
              isPending={isPending}
              label="Refresh trace diagnostics"
              onClick={refresh}
            />
          </div>
        }
      >
        <StatsGrid>
          <StatBlock label="Spans" value={data ? formatCount(data.recordCount) : '...'} />
          <StatBlock
            label="Failures"
            value={data ? formatCount(data.failureCount) : '...'}
            tone={data && data.failureCount > 0 ? 'danger' : 'default'}
          />
          <StatBlock
            label="Slow Spans"
            value={data ? formatCount(data.slowSpanCount) : '...'}
            tooltip={
              data
                ? `Spans with a duration of ${formatDuration(data.slowSpanThresholdMs)} or longer.`
                : 'Spans at or above the configured slow-span threshold.'
            }
            tone={data && data.slowSpanCount > 0 ? 'warning' : 'default'}
          />
          <StatBlock
            label="Parse Errors"
            value={data ? formatCount(data.parseErrorCount) : '...'}
            tone={data && data.parseErrorCount > 0 ? 'warning' : 'default'}
          />
        </StatsGrid>
        {openLogsDirectoryError || traceDiagnosticsError || error ? (
          <div className="space-y-2 border-t border-border/60 px-4 py-3 text-xs text-muted-foreground sm:px-5">
            {openLogsDirectoryError ? (
              <div className="flex items-start gap-2 text-destructive">
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>{openLogsDirectoryError}</span>
              </div>
            ) : null}
            {traceDiagnosticsError ? (
              <div
                className={cn(
                  'flex items-start gap-2',
                  traceDiagnosticsPartialFailure
                    ? 'text-amber-600 dark:text-amber-400'
                    : 'text-destructive',
                )}
              >
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  {traceDiagnosticsPartialFailure
                    ? `Some trace files could not be read, so diagnostics may be incomplete. ${traceDiagnosticsError.message}`
                    : traceDiagnosticsError.message}
                </span>
              </div>
            ) : null}
            {error ? (
              <div className="flex items-start gap-2 text-destructive">
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>{error}</span>
              </div>
            ) : null}
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection title="Latest Failures">
        {data && data.latestFailures.length > 0 ? (
          <DiagnosticsTable headers={['Span', 'Cause', 'Duration', 'Ended']}>
            {data.latestFailures.map((failure) => (
              <tr key={`${failure.traceId}:${failure.spanId}`}>
                <td className="px-4 py-3 align-top text-xs font-medium text-foreground first:sm:pl-5">
                  {failure.name}
                </td>
                <td className="max-w-[360px] px-4 py-3 align-top text-muted-foreground">
                  <ExpandableText text={failure.cause} />
                </td>
                <td className="px-4 py-3 align-top font-mono tabular-nums">
                  {formatDuration(failure.durationMs)}
                </td>
                <td className="whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums text-muted-foreground last:sm:pr-5">
                  {formatRelativeNoWrap(failure.endedAt)}
                </td>
              </tr>
            ))}
          </DiagnosticsTable>
        ) : (
          <EmptyRows label={isInitialLoading ? 'Loading failures...' : 'No failed spans found.'} />
        )}
      </SettingsSection>

      <SettingsSection title="Most Common Failures">
        {data && data.commonFailures.length > 0 ? (
          <DiagnosticsTable
            headers={['Span', 'Count', 'Cause', 'Last Seen']}
            minTableWidth="min-w-[760px]"
          >
            {data.commonFailures.map((failure) => (
              <tr key={`${failure.name}:${failure.cause}`}>
                <td className="px-4 py-3 align-top text-xs font-medium text-foreground first:sm:pl-5">
                  {failure.name}
                </td>
                <td className="px-4 py-3 align-top font-mono tabular-nums">
                  {formatCount(failure.count)}
                </td>
                <td className="max-w-[360px] px-4 py-3 align-top text-muted-foreground">
                  <ExpandableText text={failure.cause} />
                </td>
                <td className="w-px whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums text-muted-foreground last:sm:pr-5">
                  {formatRelativeNoWrap(failure.lastSeenAt)}
                </td>
              </tr>
            ))}
          </DiagnosticsTable>
        ) : (
          <EmptyRows
            label={isInitialLoading ? 'Loading failure groups...' : 'No repeated failures found.'}
          />
        )}
      </SettingsSection>

      <SettingsSection title="Slowest Spans">
        {data && data.slowestSpans.length > 0 ? (
          <DiagnosticsTable
            headers={['Span', 'Duration', 'Ended', 'Trace']}
            minTableWidth="min-w-[900px]"
            columnWidths={['w-[44%]', 'w-[14%]', 'w-[12%]', 'w-[30%]']}
          >
            {data.slowestSpans.map((span) => (
              <tr key={`${span.traceId}:${span.spanId}`}>
                <td className="px-4 py-3 align-top text-xs font-medium text-foreground first:sm:pl-5">
                  {span.name}
                </td>
                <td className="px-4 py-3 align-top font-mono tabular-nums">
                  {formatDuration(span.durationMs)}
                </td>
                <td className="w-px whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums text-muted-foreground">
                  {formatRelativeNoWrap(span.endedAt)}
                </td>
                <td className="min-w-0 whitespace-nowrap px-4 py-3 align-top text-muted-foreground last:sm:pr-5">
                  <TraceIdCell traceId={span.traceId} />
                </td>
              </tr>
            ))}
          </DiagnosticsTable>
        ) : (
          <EmptyRows label={isInitialLoading ? 'Loading slow spans...' : 'No spans found.'} />
        )}
      </SettingsSection>

      <SettingsSection title="Span Logs">
        {data && data.latestWarningAndErrorLogs.length > 0 ? (
          <ScrollArea
            chainVerticalScroll
            scrollFade
            hideScrollbars
            className="w-full max-w-full rounded-none"
          >
            <table className="w-full min-w-[920px] table-fixed text-left text-xs">
              <colgroup>
                <col className="w-[11%]" />
                <col className="w-[9%]" />
                <col className="w-[24%]" />
                <col className="w-[26%]" />
                <col className="w-[30%]" />
              </colgroup>
              <thead className="border-b border-border/60 text-[11px] uppercase tracking-[0.08em] text-muted-foreground/70">
                <tr>
                  <th className="whitespace-nowrap px-4 py-2.5 font-semibold sm:pl-5">Time</th>
                  <th className="whitespace-nowrap px-4 py-2.5 font-semibold">Level</th>
                  <th className="whitespace-nowrap px-4 py-2.5 font-semibold">Span</th>
                  <th className="whitespace-nowrap px-4 py-2.5 font-semibold">Message</th>
                  <th className="whitespace-nowrap px-4 py-2.5 font-semibold sm:pr-5">Trace</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {data.latestWarningAndErrorLogs.map((event) => (
                  <tr
                    key={`${event.traceId}:${event.spanId}:${DateTime.formatIso(event.seenAt)}:${event.message}`}
                    className="hover:bg-muted/15"
                  >
                    <td className="whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums text-muted-foreground sm:pl-5">
                      {formatRelativeNoWrap(event.seenAt)}
                    </td>
                    <td className="px-4 py-3 align-top">
                      <span className="inline-flex rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] font-medium uppercase text-foreground/80">
                        {event.level}
                      </span>
                    </td>
                    <td className="px-4 py-3 align-top">
                      <div className="truncate font-medium text-foreground">{event.spanName}</div>
                    </td>
                    <td className="px-4 py-3 align-top text-muted-foreground">
                      <ExpandableText
                        collapsedClassName="line-clamp-2"
                        expandLabel="Show full message"
                        text={event.message}
                      />
                    </td>
                    <td className="min-w-0 whitespace-nowrap px-4 py-3 align-top text-muted-foreground sm:pr-5">
                      <TraceIdCell traceId={event.traceId} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollArea>
        ) : (
          <EmptyRows
            label={isInitialLoading ? 'Loading recent logs...' : 'No warnings or errors found.'}
          />
        )}
      </SettingsSection>

      <SettingsSection title="Top Span Names">
        {data && data.topSpansByCount.length > 0 ? (
          <DiagnosticsTable
            headers={['Span', 'Count', 'Failures', 'Average', 'Max']}
            minTableWidth="min-w-[760px]"
            columnWidths={['w-[48%]', 'w-[13%]', 'w-[13%]', 'w-[13%]', 'w-[13%]']}
          >
            {data.topSpansByCount.map((span) => (
              <tr key={span.name}>
                <td className="px-4 py-3 align-top text-xs font-medium text-foreground first:sm:pl-5">
                  {span.name}
                </td>
                <td className="whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums">
                  {formatCount(span.count)}
                </td>
                <td className="whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums">
                  {formatCount(span.failureCount)}
                </td>
                <td className="whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums">
                  {formatDuration(span.averageDurationMs)}
                </td>
                <td className="whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums last:sm:pr-5">
                  {formatDuration(span.maxDurationMs)}
                </td>
              </tr>
            ))}
          </DiagnosticsTable>
        ) : (
          <EmptyRows label={isInitialLoading ? 'Loading span names...' : 'No spans found.'} />
        )}
      </SettingsSection>
    </SettingsPageContainer>
  )
}
