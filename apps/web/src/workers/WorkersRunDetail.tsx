// apps/web/src/workers/WorkersRunDetail.tsx
// workers run detail view

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
import { workerVerdictKey } from '~/session/worklog'
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
  workerRunJobRows,
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
  DetailField,
  DetailSection,
  JobMetadataBadges,
  JobStatusBadges,
  ScopeViolationBadge,
  SectionHeading,
  StatusChips,
  StringList,
  relativeOrDash,
} from './workersPanelChrome'
import { WorkersPriorAttemptsRow, WorkersRunJobRow } from './WorkersList'

function OutcomeSummary({ jobs }: { jobs: readonly WorkersJobSummary[] })
{
  const summary = workerRunOutcomeSummaryView(jobs)
  return summary === null ? null : <span className="font-medium">{summary.label}</span>
}

export function WorkersRunDetailView({
  run,
  runId,
  jobs,
  nowMs,
  onSelectJob,
  verdicts,
}: {
  run: WorkersRunSummary | null
  runId: string
  jobs: readonly WorkersJobSummary[]
  nowMs: number
  onSelectJob: (jobId: string) => void
  verdicts: ReadonlyMap<string, string>
})
{
  const groups = workerStageGroups(jobs)
  const rowsByJobId = new Map(workerRunJobRows(jobs).map((row) => [row.job.jobId, row]))
  const failureBreakdown = run === null ? null : workerRunFailureBreakdown(jobs)
  const scopeViolationGroups = run === null ? null : Option.getOrNull(run.scopeViolationGroups)

  return (
    <div className="pb-4">
      {run === null ? null : (
        <DetailSection title="Run">
          <div className="mb-2 text-xs text-foreground">
            <OutcomeSummary jobs={jobs} />
          </div>
          <div className="mb-2 flex flex-wrap items-center gap-1">
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
          </div>
          <DetailField label="Jobs">{run.total.toLocaleString()}</DetailField>
          {failureBreakdown === null ? null : (
            <DetailField label="Failures">{failureBreakdown}</DetailField>
          )}
          <DetailField label="Elapsed">{workerRunSpanLabel(run, nowMs) ?? '—'}</DetailField>
          <DetailField label="Started">{relativeOrDash(run.firstCreatedAt)}</DetailField>
          <DetailField label="Last update">{relativeOrDash(run.lastCompletedAt)}</DetailField>
        </DetailSection>
      )}

      {jobs.length === 0 ? (
        <div className="p-4 text-xs leading-relaxed text-muted-foreground">
          No jobs recorded for this run.
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="h-8 px-3">Job</TableHead>
              <TableHead className="h-8 px-2">Status</TableHead>
              <TableHead className="h-8 px-2">Provider</TableHead>
              <TableHead className="h-8 px-2">Model</TableHead>
              <TableHead className="h-8 px-2">Elapsed</TableHead>
              <TableHead className="h-8 px-3">Files</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.flatMap((group) => [
              <TableRow key={`group:${group.key}`} className="hover:bg-transparent">
                <TableCell
                  colSpan={6}
                  className="border-y border-border/60 bg-muted/30 px-3 py-1.5"
                >
                  <span className="flex flex-wrap items-center gap-1.5">
                    {group.workflow === null ? null : (
                      <Badge size="sm" variant="secondary">
                        {group.workflow}
                      </Badge>
                    )}
                    <Badge size="sm" variant="outline">
                      {group.stage ?? 'other'}
                    </Badge>
                    <OutcomeSummary jobs={group.jobs} />
                    <StatusChips chips={workerRunStatusChips(workerStageCounts(group.jobs))} />
                  </span>
                </TableCell>
              </TableRow>,
              ...group.jobs.flatMap((job) =>
                {
                const row = rowsByJobId.get(job.jobId)
                if (row === undefined) return []
                return [
                  <WorkersRunJobRow
                    key={job.jobId}
                    job={job}
                    nowMs={nowMs}
                    onSelect={onSelectJob}
                    verdict={verdicts.get(workerVerdictKey(runId, job.jobId))}
                  />,
                  <WorkersPriorAttemptsRow
                    key={`${job.jobId}:prior-attempts`}
                    attempts={row.priorAttempts}
                    onSelect={onSelectJob}
                  />,
                ]
              }),
            ])}
          </TableBody>
        </Table>
      )}
    </div>
  )
}

// the broker never ships patch text to the client, so the "patch" view is the per-file
// change listing plus a copy affordance for the patch path the broker wrote
