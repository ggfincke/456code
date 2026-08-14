// apps/web/src/workers/WorkersList.tsx
// workers run and job list rows with thread verdicts

import type {
  EnvironmentId,
  WorkersJobDetail,
  WorkersJobStatus,
  WorkersJobSummary,
  WorkersListInput,
  WorkersRunSummary,
} from '@t3tools/contracts'
import * as Option from 'effect/Option'
import { Check, ChevronLeft, ChevronRight, Copy, RefreshCw, TriangleAlert } from 'lucide-react'
import { type ReactNode, useEffect, useId, useMemo, useState } from 'react'

import { Badge } from '~/components/ui/badge'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '~/components/ui/collapsible'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '~/components/ui/empty'
import { ScrollArea } from '~/components/ui/scroll-area'
import { Skeleton } from '~/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import { Tooltip, TooltipPopup, TooltipTrigger } from '~/components/ui/tooltip'
import { useCopyToClipboard } from '~/hooks/useCopyToClipboard'
import { useNowMinute } from '~/hooks/useNowMinute'
import { cn } from '~/lib/utils'
import {
  workersActivityEnvironment,
  workersEnvironment,
  useWorkersRunDeepLink,
} from '~/state/workers'
import { formatDuration } from '~/session-logic'
import { useEnvironmentQuery } from '~/state/query'
import { formatRelativeTimeLabel } from '~/timestampFormat'

import {
  workerActivityAgeLabel,
  workerActivityHeadline,
  workerActivityNoticeLabel,
  workerActivityTransportLabel,
  workerActivityView,
  type WorkerActivityHeadline,
  type WorkerActivityHistoryEntry,
} from './workersActivity.logic'
import {
  repoBasename,
  shortSha,
  sortWorkerRunsNewestFirst,
  workerFailureView,
  workerJobElapsedLabel,
  workerJobPresentation,
  workerJobsHaveStages,
  workerModelLabel,
  workerPatchClipboard,
  workerPatchFileEntries,
  workerRunFailureBreakdown,
  workerRunOutcomeSummaryView,
  workerRunSpanLabel,
  workerRunStatusChips,
  workerStageCounts,
  workerStageGroups,
  workerStatusBadgeVariant,
  workerVerificationRunEntries,
  workerVerificationView,
  type WorkerRunStatusChip,
} from './workersPanel.logic'

import {
  JobMetadataBadges,
  JobStatusBadges,
  ScopeViolationBadge,
  StatusChips,
  relativeOrDash,
} from './workersPanelChrome'

export function WorkersRunRow({
  run,
  jobs,
  nowMs,
  onSelect,
}: {
  run: WorkersRunSummary
  jobs: readonly WorkersJobSummary[]
  nowMs: number
  onSelect: (runId: string) => void
})
{
  const span = workerRunSpanLabel(run, nowMs)
  const outcomeSummary = workerRunOutcomeSummaryView(jobs, run.outcomeCounts)
  const scopeViolationGroups = Option.getOrNull(run.scopeViolationGroups)

  return (
    <button
      type="button"
      aria-label={`Open orchestration run ${run.run}`}
      className="block w-full border-b border-border/60 px-3 py-2 text-left hover:bg-accent/50"
      onClick={() => onSelect(run.run)}
    >
      <span className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{run.run}</span>
        <span className="shrink-0 text-[10px] text-muted-foreground">{span ?? '—'}</span>
      </span>
      {outcomeSummary === null ? null : (
        <span className="mt-1 block text-xs font-medium text-foreground">
          {outcomeSummary.label}
        </span>
      )}
      <span className="mt-1 flex flex-wrap items-center gap-1">
        {run.workflows.map((workflow) => (
          <Badge key={workflow} size="sm" variant="secondary">
            {workflow}
          </Badge>
        ))}
        <StatusChips chips={workerRunStatusChips(run)} />
        <ScopeViolationBadge
          count={run.scopeViolationCount}
          groupCount={scopeViolationGroups?.length}
        />
      </span>
      <span className="mt-1 block text-[10px] text-muted-foreground">
        {run.total.toLocaleString()} job{run.total === 1 ? '' : 's'} ·{' '}
        {run.stages.length.toLocaleString()} stage{run.stages.length === 1 ? '' : 's'}
      </span>
    </button>
  )
}

export function WorkersJobRow({
  job,
  nowMs,
  onSelect,
  verdict,
}: {
  job: WorkersJobSummary
  nowMs: number
  onSelect: (jobId: string) => void
  verdict?: string | undefined
})
{
  const verification = workerVerificationView(job.verification)
  const elapsed = workerJobElapsedLabel(job, nowMs)
  const changedFileCount = Option.getOrNull(job.changedFileCount)

  return (
    <TableRow
      role="button"
      tabIndex={0}
      aria-label={`Open worker job ${job.jobId}`}
      className="cursor-pointer"
      onClick={() => onSelect(job.jobId)}
      onKeyDown={(event) =>
      {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onSelect(job.jobId)
      }}
    >
      <TableCell className="px-3 font-mono">
        {job.jobId}
        {verdict ? (
          <span className="block max-w-48 truncate font-sans text-[10px] text-muted-foreground">
            {verdict}
          </span>
        ) : null}
        <JobMetadataBadges job={job} />
      </TableCell>
      <TableCell className="px-2">
        <JobStatusBadges job={job} />
      </TableCell>
      <TableCell className="px-2 text-muted-foreground">{job.provider}</TableCell>
      <TableCell className="px-2 text-muted-foreground">{job.mode}</TableCell>
      <TableCell className="px-2">
        <Tooltip>
          <TooltipTrigger render={<span>{repoBasename(job.repo)}</span>} />
          <TooltipPopup>{job.repo}</TooltipPopup>
        </Tooltip>
      </TableCell>
      <TableCell className="px-2 text-muted-foreground">{elapsed ?? '—'}</TableCell>
      <TableCell className="px-2 text-muted-foreground">{changedFileCount ?? '—'}</TableCell>
      <TableCell
        className={cn('px-3', verification?.failed ? 'text-destructive' : 'text-muted-foreground')}
      >
        {verification?.label ?? '—'}
      </TableCell>
    </TableRow>
  )
}

// the run detail drops repo/mode (constant within a run) for the per-stage columns that
// actually vary: model & effort
export function WorkersRunJobRow({
  job,
  nowMs,
  onSelect,
  verdict,
}: {
  job: WorkersJobSummary
  nowMs: number
  onSelect: (jobId: string) => void
  verdict?: string | undefined
})
{
  const elapsed = workerJobElapsedLabel(job, nowMs)
  const changedFileCount = Option.getOrNull(job.changedFileCount)
  const model = workerModelLabel(job)

  return (
    <TableRow
      role="button"
      tabIndex={0}
      aria-label={`Open worker job ${job.jobId}`}
      className="cursor-pointer"
      onClick={() => onSelect(job.jobId)}
      onKeyDown={(event) =>
      {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onSelect(job.jobId)
      }}
    >
      <TableCell className="px-3 font-mono">
        {job.jobId}
        {verdict ? (
          <span className="block max-w-48 truncate font-sans text-[10px] text-muted-foreground">
            {verdict}
          </span>
        ) : null}
      </TableCell>
      <TableCell className="px-2">
        <JobStatusBadges job={job} />
      </TableCell>
      <TableCell className="px-2 text-muted-foreground">{job.provider}</TableCell>
      <TableCell className="px-2 text-muted-foreground">{model ?? '—'}</TableCell>
      <TableCell className="px-2 text-muted-foreground">{elapsed ?? '—'}</TableCell>
      <TableCell className="px-3 text-muted-foreground">{changedFileCount ?? '—'}</TableCell>
    </TableRow>
  )
}

export function WorkersPriorAttemptsRow({
  attempts,
  onSelect,
}: {
  attempts: readonly WorkersJobSummary[]
  onSelect: (jobId: string) => void
})
{
  if (attempts.length === 0) return null
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={6} className="px-3 py-1.5">
        <details className="font-sans text-[10px] text-muted-foreground">
          <summary className="cursor-pointer select-none">
            relaunched ({attempts.length} prior attempt{attempts.length === 1 ? '' : 's'})
          </summary>
          <div className="mt-1 space-y-1 border-s border-border ps-2">
            {attempts.map((attempt) => (
              <button
                key={attempt.jobId}
                type="button"
                className="block w-full rounded px-1 py-1 text-left hover:bg-accent/50"
                onClick={() => onSelect(attempt.jobId)}
              >
                <span className="block font-mono text-foreground">{attempt.jobId}</span>
                <span className="mt-0.5 flex flex-wrap items-center gap-1">
                  <JobStatusBadges job={attempt} />
                  <span>{attempt.provider}</span>
                </span>
              </button>
            ))}
          </div>
        </details>
      </TableCell>
    </TableRow>
  )
}
