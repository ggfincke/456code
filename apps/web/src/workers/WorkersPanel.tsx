// apps/web/src/workers/WorkersPanel.tsx
// read-only right-panel surface for worker-broker orchestration runs & jobs

import type { EnvironmentId, WorkersListInput } from '@t3tools/contracts'
import * as Option from 'effect/Option'
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react'
import { useEffect, useId, useMemo, useState } from 'react'

import { Badge } from '~/components/ui/badge'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '~/components/ui/empty'
import { ScrollArea } from '~/components/ui/scroll-area'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import { useNowMinute } from '~/hooks/useNowMinute'
import { cn } from '~/lib/utils'
import { workersEnvironment, useWorkersRunDeepLink } from '~/state/workers'
import { useEnvironmentQuery } from '~/state/query'
import { formatRelativeTimeLabel } from '~/timestampFormat'

import { WorkersJobDetailView } from './WorkersJobDetail'
import { WorkersJobRow, WorkersRunRow } from './WorkersList'
import { WorkersRunDetailView } from './WorkersRunDetail'
import { SectionHeading, SkeletonRows } from './workersPanelChrome'
import {
  sortWorkerRunsNewestFirst,
  workerJobsHaveStages,
  workerStageCounts,
  workerStageGroups,
} from './workersPanel.logic'

interface WorkersPanelProps
{
  environmentId: EnvironmentId
}

// the atom family keys on JSON.stringify([environmentId, input]); a module-level
// literal keeps the unfiltered list & runs keys stable across renders
const WORKERS_LIST_INPUT: WorkersListInput = {}

type WorkersView = 'runs' | 'jobs'

interface WorkersNav
{
  readonly view: WorkersView
  readonly runId: string | null
  readonly jobId: string | null
}

function ViewToggle({
  view,
  onChange,
}: {
  view: WorkersView
  onChange: (next: WorkersView) => void
})
{
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-1.5">
      {(['runs', 'jobs'] as const).map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={view === value}
          className={cn(
            'rounded-md px-2 py-0.5 text-[11px] font-medium',
            view === value
              ? 'bg-accent text-foreground'
              : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
          )}
          onClick={() => onChange(value)}
        >
          {value === 'runs' ? 'Runs' : 'All jobs'}
        </button>
      ))}
    </div>
  )
}

export default function WorkersPanel({ environmentId }: WorkersPanelProps)
{
  const deepLink = useWorkersRunDeepLink(environmentId)
  const deepLinkRun = deepLink.runId
  const [nav, setNav] = useState<WorkersNav>(() =>
    deepLinkRun === null
      ? { view: 'runs', runId: null, jobId: null }
      : { view: 'runs', runId: deepLinkRun, jobId: null },
  )
  // the deep-link resets when its owning thread or pinned run changes; local navigation
  // afterwards stays put because the applied identity only moves with that surface
  const [appliedDeepLink, setAppliedDeepLink] = useState(deepLink)
  if (
    appliedDeepLink.threadKey !== deepLink.threadKey ||
    appliedDeepLink.runId !== deepLink.runId
  )
  {
    setAppliedDeepLink(deepLink)
    setNav({ view: 'runs', runId: deepLinkRun, jobId: null })
  }

  const selectedRunId = nav.runId
  const selectedJobId = nav.jobId
  const listQuery = useEnvironmentQuery(
    workersEnvironment.list({ environmentId, input: WORKERS_LIST_INPUT }),
  )
  const runsQuery = useEnvironmentQuery(
    workersEnvironment.listRuns({ environmentId, input: WORKERS_LIST_INPUT }),
  )
  const runDetailQuery = useEnvironmentQuery(
    selectedRunId === null
      ? null
      : workersEnvironment.getRun({ environmentId, input: { run: selectedRunId } }),
  )
  const detailQuery = useEnvironmentQuery(
    selectedJobId === null
      ? null
      : workersEnvironment.getJob({ environmentId, input: { jobId: selectedJobId } }),
  )

  const activeQuery =
    selectedJobId !== null
      ? detailQuery
      : selectedRunId !== null
        ? runDetailQuery
        : nav.view === 'runs'
          ? runsQuery
          : listQuery
  const readAt = activeQuery.data?.readAt ?? null

  // the minute clock only drives the re-render; labels re-read the wall clock
  const nowMinute = useNowMinute()
  const readAtLabel = useMemo(
    () => (readAt === null ? null : formatRelativeTimeLabel(readAt)),
    [readAt, nowMinute],
  )
  // elapsed spans for in-flight runs tick with the shared minute clock rather than a
  // panel-local interval
  const nowMs = useMemo(() => Date.parse(`${nowMinute}:00Z`), [nowMinute])

  const listData = listQuery.data
  const listError = listData === null ? null : Option.getOrNull(listData.error)
  const jobs = listData?.jobs ?? []

  const runsData = runsQuery.data
  const runsError = runsData === null ? null : Option.getOrNull(runsData.error)
  const runs = useMemo(() => sortWorkerRunsNewestFirst(runsData?.runs ?? []), [runsData?.runs])

  const detailOpen = selectedJobId !== null
  const runOpen = !detailOpen && selectedRunId !== null
  const listOpen = !detailOpen && !runOpen

  // the list subscription is already mounted for every view, so the selected job's row is
  // the freshest record the panel holds while the detail read waits out its 30s interval
  const selectedSummary = useMemo(() =>
  {
    if (selectedJobId === null) return null
    return jobs.find((job) => job.jobId === selectedJobId) ?? null
  }, [jobs, selectedJobId])

  const title = detailOpen ? 'Worker job' : runOpen ? 'Orchestration run' : 'Workers'
  const subtitle = detailOpen
    ? selectedJobId
    : runOpen
      ? selectedRunId
      : nav.view === 'runs'
        ? runsData === null
          ? 'Reading broker state…'
          : `${runs.length.toLocaleString()} run${runs.length === 1 ? '' : 's'}`
        : listData === null
          ? 'Reading broker state…'
          : `${jobs.length.toLocaleString()} job${jobs.length === 1 ? '' : 's'}${
              listData.skippedJobCount > 0 ? ` · ${listData.skippedJobCount} skipped` : ''
            }`

  const goBack = () =>
  {
    setNav((current) =>
      current.jobId !== null
        ? { ...current, jobId: null }
        : { view: current.view, runId: null, jobId: null },
    )
  }
  const selectJob = (jobId: string) => setNav((current) => ({ ...current, jobId }))
  const selectRun = (runId: string) => setNav({ view: 'runs', runId, jobId: null })
  const selectView = (view: WorkersView) => setNav({ view, runId: null, jobId: null })

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background" data-workers-panel={environmentId}>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        {listOpen ? null : (
          <button
            type="button"
            className="-ml-1 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={
              !detailOpen
                ? 'Back to orchestration runs'
                : selectedRunId === null
                  ? 'Back to worker jobs'
                  : 'Back to run jobs'
            }
            onClick={goBack}
          >
            <ChevronLeft className="size-3.5" />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-foreground">{title}</div>
          <div className="truncate text-[10px] leading-none text-muted-foreground">{subtitle}</div>
        </div>
        {readAtLabel === null ? null : (
          <span className="shrink-0 text-[10px] text-muted-foreground">{readAtLabel}</span>
        )}
        <button
          type="button"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Refresh worker jobs"
          onClick={activeQuery.refresh}
        >
          <RefreshCw className={cn('size-3.5', activeQuery.isPending && 'animate-spin')} />
        </button>
      </div>

      {listOpen ? <ViewToggle view={nav.view} onChange={selectView} /> : null}

      <ScrollArea className="min-h-0 flex-1">
        {detailOpen ? (
          detailQuery.isPending && detailQuery.data === null ? (
            <SkeletonRows />
          ) : detailQuery.error && detailQuery.data === null ? (
            <div className="p-4 text-xs leading-relaxed text-destructive">{detailQuery.error}</div>
          ) : (
            (() =>
              {
              const detail = detailQuery.data
              if (!detail) return null
              const job = Option.getOrNull(detail.job)
              const detailError = Option.getOrNull(detail.error)
              if (job === null)
                {
                return (
                  <div className="p-4 text-xs leading-relaxed text-muted-foreground">
                    {detailError?.message ??
                      'This worker job is no longer in the broker state directory.'}
                  </div>
                )
              }
              // keyed by job so the task disclosure & activity stream reset per selection
              return (
                <WorkersJobDetailView
                  key={job.jobId}
                  environmentId={environmentId}
                  job={job}
                  summary={selectedSummary}
                  nowMs={nowMs}
                />
              )
            })()
          )
        ) : runOpen ? (
          runDetailQuery.isPending && runDetailQuery.data === null ? (
            <SkeletonRows />
          ) : runDetailQuery.error && runDetailQuery.data === null ? (
            <div className="p-4 text-xs leading-relaxed text-destructive">
              {runDetailQuery.error}
            </div>
          ) : (
            (() =>
              {
              const detail = runDetailQuery.data
              if (!detail) return null
              const run = Option.getOrNull(detail.run)
              const runError = Option.getOrNull(detail.error)
              if (run === null && detail.jobs.length === 0)
                {
                return (
                  <div className="p-4 text-xs leading-relaxed text-muted-foreground">
                    {runError?.message ??
                      'This orchestration run is no longer in the broker state directory.'}
                  </div>
                )
              }
              return (
                <WorkersRunDetailView
                  run={run}
                  jobs={detail.jobs}
                  nowMs={nowMs}
                  onSelectJob={selectJob}
                />
              )
            })()
          )
        ) : nav.view === 'runs' ? (
          runsQuery.isPending && runsData === null ? (
            <SkeletonRows />
          ) : runsQuery.error && runsData === null ? (
            <div className="p-4 text-xs leading-relaxed text-destructive">{runsQuery.error}</div>
          ) : runsData === null ? null : runsData.state === 'state-dir-missing' ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No worker state</EmptyTitle>
                <EmptyDescription>
                  Workers unavailable: worker-broker state is not present on this host.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : runsError !== null && runs.length === 0 ? (
            <div className="p-4 text-xs leading-relaxed text-destructive">{runsError.message}</div>
          ) : runs.length === 0 ? (
            <div className="p-4 text-xs leading-relaxed text-muted-foreground">
              No orchestration runs recorded yet.
            </div>
          ) : (
            <>
              {runsError === null ? null : (
                <div className="border-b border-border/60 px-3 py-2 text-xs leading-relaxed text-destructive">
                  {runsError.message}
                </div>
              )}
              {runs.map((run) => (
                <WorkersRunRow key={run.run} run={run} nowMs={nowMs} onSelect={selectRun} />
              ))}
            </>
          )
        ) : listQuery.isPending && listData === null ? (
          <SkeletonRows />
        ) : listQuery.error && listData === null ? (
          <div className="p-4 text-xs leading-relaxed text-destructive">{listQuery.error}</div>
        ) : listData === null ? null : listData.state === 'state-dir-missing' ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No worker state</EmptyTitle>
              <EmptyDescription>
                Workers unavailable: worker-broker state is not present on this host.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : listError !== null && jobs.length === 0 ? (
          <div className="p-4 text-xs leading-relaxed text-destructive">{listError.message}</div>
        ) : jobs.length === 0 ? (
          <div className="p-4 text-xs leading-relaxed text-muted-foreground">
            No worker jobs recorded yet.
          </div>
        ) : (
          <>
            {listError === null ? null : (
              <div className="border-b border-border/60 px-3 py-2 text-xs leading-relaxed text-destructive">
                {listError.message}
              </div>
            )}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="h-8 px-3">Job</TableHead>
                  <TableHead className="h-8 px-2">Status</TableHead>
                  <TableHead className="h-8 px-2">Provider</TableHead>
                  <TableHead className="h-8 px-2">Mode</TableHead>
                  <TableHead className="h-8 px-2">Repo</TableHead>
                  <TableHead className="h-8 px-2">Elapsed</TableHead>
                  <TableHead className="h-8 px-2">Files</TableHead>
                  <TableHead className="h-8 px-3">Verified</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!workerJobsHaveStages(jobs)
                  ? jobs.map((job) => (
                      <WorkersJobRow key={job.jobId} job={job} nowMs={nowMs} onSelect={selectJob} />
                    ))
                  : workerStageGroups(jobs).flatMap((group) => [
                      <TableRow key={`group:${group.key}`} className="hover:bg-transparent">
                        <TableCell
                          colSpan={8}
                          className="border-y border-border/60 bg-muted/30 px-3 py-1.5"
                        >
                          <span className="flex items-center gap-1.5">
                            {group.workflow === null ? null : (
                              <Badge size="sm" variant="secondary">
                                {group.workflow}
                              </Badge>
                            )}
                            <Badge size="sm" variant="outline">
                              {group.stage ?? 'other'}
                            </Badge>
                          </span>
                        </TableCell>
                      </TableRow>,
                      ...group.jobs.map((job) => (
                        <WorkersJobRow
                          key={job.jobId}
                          job={job}
                          nowMs={nowMs}
                          onSelect={selectJob}
                        />
                      )),
                    ])}
              </TableBody>
            </Table>
          </>
        )}
      </ScrollArea>
    </div>
  )
}
