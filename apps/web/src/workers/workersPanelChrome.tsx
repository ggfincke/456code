// apps/web/src/workers/workersPanelChrome.tsx
// shared workers panel badges, skeleton, and detail chrome

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
  workerRunSpanLabel,
  workerRunStatusChips,
  workerStageCounts,
  workerStageGroups,
  workerStatusBadgeVariant,
  workerVerificationRunEntries,
  workerVerificationView,
  type WorkerRunStatusChip,
} from './workersPanel.logic'

export function SectionHeading({ children, inline }: { children: ReactNode; inline?: boolean })
{
  return (
    <h4
      className={cn(
        'text-[10px] font-medium uppercase tracking-wide text-muted-foreground',
        inline ? null : 'mb-1.5',
      )}
    >
      {children}
    </h4>
  )
}

export function DetailSection({ title, children }: { title: string; children: ReactNode })
{
  return (
    <section className="border-b border-border/60 px-3 py-2.5 last:border-b-0">
      <SectionHeading>{title}</SectionHeading>
      {children}
    </section>
  )
}

export function DetailField({ label, children }: { label: string; children: ReactNode })
{
  return (
    <div className="flex gap-2 py-0.5 text-xs">
      <span className="w-24 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 break-all text-foreground">{children}</span>
    </div>
  )
}

export function StringList({ items }: { items: readonly string[] })
{
  return (
    <ul className="space-y-1 text-xs leading-relaxed text-foreground">
      {items.map((item) => (
        <li key={item} className="flex gap-1.5">
          <span aria-hidden className="text-muted-foreground">
            •
          </span>
          <span className="min-w-0 flex-1 break-words">{item}</span>
        </li>
      ))}
    </ul>
  )
}

export function SkeletonRows()
{
  return (
    <div className="space-y-2 p-3">
      {[0, 1, 2, 3, 4].map((row) => (
        <Skeleton key={row} className="h-6 w-full" />
      ))}
    </div>
  )
}

export function StatusChips({ chips }: { chips: readonly WorkerRunStatusChip[] })
{
  return (
    <>
      {chips.map((chip) => (
        <Badge key={chip.status} size="sm" variant={chip.variant}>
          {chip.count} {chip.status}
        </Badge>
      ))}
    </>
  )
}

export function relativeOrDash(timestamp: Option.Option<string>): string
{
  const iso = Option.getOrNull(timestamp)
  if (iso === null) return '—'
  const label = formatRelativeTimeLabel(iso)
  return label.length === 0 ? iso : label
}

export function ScopeViolationBadge({ count }: { count: number })
{
  if (count === 0) return null
  return (
    <Badge size="sm" variant="destructive">
      <TriangleAlert />
      {count} scope
    </Badge>
  )
}

// status chip plus, for terminal failures, the broker's failure class and the
// salvageability evidence separating recoverable work from lost work
export function JobStatusBadges({ job }: { job: WorkersJobSummary })
{
  const failure = workerFailureView(job)
  const failureBadge =
    failure === null ? null : (
      <Badge size="sm" variant={failure.salvageable ? 'warning' : 'outline'}>
        {failure.label}
      </Badge>
    )
  return (
    <span className="flex flex-wrap items-center gap-1">
      <Badge size="sm" variant={workerStatusBadgeVariant(job.status)}>
        {job.status}
      </Badge>
      {failureBadge === null || failure === null ? null : failure.evidence === null ? (
        failureBadge
      ) : (
        <Tooltip>
          <TooltipTrigger render={failureBadge} />
          <TooltipPopup>{failure.evidence}</TooltipPopup>
        </Tooltip>
      )}
    </span>
  )
}

export function JobMetadataBadges({ job }: { job: WorkersJobSummary })
{
  const workflow = Option.getOrNull(job.workflow)
  const stage = Option.getOrNull(job.stage)
  if (workflow === null && stage === null) return null

  return (
    <span className="mt-1 flex flex-wrap gap-1">
      {workflow === null ? null : (
        <Badge size="sm" variant="secondary">
          {workflow}
        </Badge>
      )}
      {stage === null ? null : (
        <Badge size="sm" variant="outline">
          {stage}
        </Badge>
      )}
    </span>
  )
}
