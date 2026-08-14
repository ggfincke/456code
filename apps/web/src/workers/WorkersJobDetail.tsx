// apps/web/src/workers/WorkersJobDetail.tsx
// workers job detail, verdict, patch, task, and activity sections

import {
  WORKER_VERDICT_MAX_LENGTH,
  type EnvironmentId,
  type WorkersJobDetail,
  type WorkersJobStatus,
  type WorkersJobSummary,
  type WorkersListInput,
  type WorkersRunSummary,
} from '@t3tools/contracts'
import * as Option from 'effect/Option'
import { Check, ChevronLeft, ChevronRight, Copy, RefreshCw, TriangleAlert } from 'lucide-react'
import { type ReactNode, useEffect, useId, useMemo, useState } from 'react'

import { Badge } from '~/components/ui/badge'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '~/components/ui/collapsible'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '~/components/ui/empty'
import { DraftInput } from '~/components/ui/draft-input'
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
  workerJobOutcomeView,
  workerJobPresentation,
  workerJobsHaveStages,
  workerModelLabel,
  workerPatchClipboard,
  workerPatchFileEntries,
  workerRunFailureBreakdown,
  workerRunSpanLabel,
  workerRunStatusChips,
  workerScopeViolationGroups,
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
  SectionHeading,
  StringList,
  relativeOrDash,
} from './workersPanelChrome'

export function WorkersJobPatchSection({ job }: { job: WorkersJobDetail })
{
  const entries = workerPatchFileEntries(job)
  const clipboard = workerPatchClipboard(job)
  const outcome = workerJobOutcomeView(job)
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: 'patch' })

  return (
    <section className="border-b border-border/60 last:border-b-0">
      <Collapsible defaultOpen>
        <div className="flex items-center gap-2 px-3 py-2.5">
          <CollapsibleTrigger className="-ml-1 flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-0.5 text-left data-panel-open:[&_svg]:rotate-90">
            <ChevronRight
              aria-hidden
              className="size-3 shrink-0 text-muted-foreground transition-transform"
            />
            <SectionHeading
              inline
            >{`Patch (${entries.length} file${entries.length === 1 ? '' : 's'})`}</SectionHeading>
          </CollapsibleTrigger>
          {outcome === null ? null : (
            <Badge size="sm" variant={outcome.variant}>
              {outcome.label}
            </Badge>
          )}
          {clipboard === null ? null : (
            <button
              type="button"
              className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label={clipboard.label}
              onClick={() => copyToClipboard(clipboard.text)}
            >
              {isCopied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </button>
          )}
        </div>
        <CollapsiblePanel>
          <div className="px-3 pb-2.5">
            {entries.length === 0 ? (
              <p className="text-xs text-muted-foreground">No file changes recorded.</p>
            ) : (
              <ul className="space-y-0.5 font-mono text-xs text-foreground">
                {entries.map((entry) => (
                  <li key={entry.path} className="flex gap-2">
                    <span className="w-6 shrink-0 uppercase text-muted-foreground">
                      {entry.status ?? '—'}
                    </span>
                    <span className="min-w-0 flex-1 break-all">{entry.path}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 break-all font-mono text-[10px] text-muted-foreground">
              {Option.getOrNull(job.patchPath) ?? 'No patch file recorded.'}
            </p>
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </section>
  )
}

// whether three lines hide anything is a question about the rendered width, not the
// character count: a short task wraps past the clamp in a narrow panel & a long one can
// fit in a wide one. the clamped paragraph measures itself instead, and re-measures as
// the panel resizes, so the disclosure appears exactly when text is actually clipped
export function useTaskClipped(collapsed: boolean): {
  readonly ref: (node: HTMLParagraphElement | null) => void
  readonly clipped: boolean
}
{
  const [node, setNode] = useState<HTMLParagraphElement | null>(null)
  const [clipped, setClipped] = useState(false)

  // an expanded paragraph carries no clamp to overflow, so it is left unmeasured & keeps
  // the verdict that opened it; collapsing re-measures at the current width
  useEffect(() =>
  {
    if (node === null || !collapsed) return

    const measure = () =>
    {
      const next = node.scrollHeight - node.clientHeight > 1
      setClipped((current) => (current === next ? current : next))
    }

    measure()
    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [node, collapsed])

  return { ref: setNode, clipped }
}

// a broker task runs to hundreds of lines, which used to push everything below it off
// screen; the clamp keeps the detail scannable & the disclosure keeps the full text one
// keystroke away
export function WorkersJobTaskSection({ task }: { task: string })
{
  const [expanded, setExpanded] = useState(false)
  const bodyId = useId()
  const text = task.trim()
  const collapsed = text.length > 0 && !expanded
  const { ref, clipped } = useTaskClipped(collapsed)

  return (
    <section className="border-b border-border/60 px-3 py-2.5 last:border-b-0">
      <div className="mb-1.5 flex items-center gap-2">
        <SectionHeading inline>Task</SectionHeading>
        {clipped ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={bodyId}
            className="ml-auto shrink-0 rounded-md px-1 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? 'Hide full task' : 'Show full task'}
          </button>
        ) : null}
      </div>
      <p
        id={bodyId}
        ref={ref}
        className={cn(
          'whitespace-pre-wrap break-words text-xs leading-relaxed',
          text.length === 0 ? 'text-muted-foreground' : 'text-foreground',
          collapsed ? 'line-clamp-3' : null,
        )}
      >
        {text.length > 0 ? text : 'No task text recorded.'}
      </p>
    </section>
  )
}

export function WorkersJobVerdictSection({
  verdict,
  onSave,
}: {
  verdict: string
  onSave: (verdict: string) => void
})
{
  return (
    <section className="border-b border-border/60 px-3 py-2.5 last:border-b-0">
      <div className="mb-1.5 flex items-center gap-2">
        <SectionHeading inline>Verdict</SectionHeading>
        <span className="ml-auto text-[10px] text-muted-foreground">Enter or blur to save</span>
      </div>
      <DraftInput
        aria-label="Worker job verdict"
        maxLength={WORKER_VERDICT_MAX_LENGTH}
        placeholder="Add a one-line verdict"
        size="sm"
        value={verdict}
        onCommit={(next) =>
        {
          const trimmed = next.trim()
          if (trimmed !== verdict)
          {
            onSave(trimmed)
          }
        }}
      />
    </section>
  )
}

// the headline is the one part that changes while a job runs; it renders inside the
// section's persistent live region rather than owning one, so a swap between headline,
// empty & disconnected states is announced in place. status is stated as text inside the
// badge rather than by tint alone
export function WorkersActivityHeadlineBlock({
  headline,
  message,
  note,
  actionSummary,
}: {
  headline: WorkerActivityHeadline
  message: string | null
  note: string | null
  actionSummary: string | null
})
{
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Badge size="sm" variant={headline.variant}>
          {headline.label}
        </Badge>
        {actionSummary === null ? null : (
          <span className="text-[10px] text-muted-foreground">{actionSummary}</span>
        )}
      </div>
      {message !== null ? (
        <p className="mt-1 break-words text-xs leading-relaxed text-foreground">{message}</p>
      ) : note !== null ? (
        <p className="mt-1 break-words text-xs leading-relaxed text-muted-foreground">{note}</p>
      ) : null}
    </div>
  )
}

export function WorkersActivityHistory({
  entries,
  nowMs,
}: {
  entries: readonly WorkerActivityHistoryEntry[]
  nowMs: number
})
{
  return (
    <Collapsible>
      <CollapsibleTrigger className="-ml-1 mt-1.5 flex items-center gap-1.5 rounded-md px-1 py-0.5 text-[10px] font-medium text-muted-foreground hover:text-foreground data-panel-open:[&_svg]:rotate-90">
        <ChevronRight aria-hidden className="size-3 shrink-0 transition-transform" />
        {`History (${entries.length})`}
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <ol className="mt-1 space-y-0.5 text-[10px] leading-relaxed">
          {entries.map((entry) => (
            <li key={entry.key} className="flex gap-2">
              <span className="w-14 shrink-0 tabular-nums text-muted-foreground">
                {workerActivityAgeLabel(entry.recordedAt, nowMs)}
              </span>
              <span className="min-w-0 flex-1 break-words text-foreground">
                <span className="text-muted-foreground">{entry.label}</span>
                {entry.text === null ? null : ` ${entry.text}`}
              </span>
            </li>
          ))}
        </ol>
      </CollapsiblePanel>
    </Collapsible>
  )
}

// the only subscription in this panel that is scoped to a single job; it is mounted from
// the selected detail alone, so list & run rows never open an activity stream
export function WorkersJobActivitySection({
  environmentId,
  job,
  status,
  live,
  nowMs,
  elapsedLabel,
}: {
  environmentId: EnvironmentId
  job: WorkersJobDetail
  status: WorkersJobStatus
  live: boolean
  nowMs: number
  elapsedLabel: string | null
})
{
  // the atom family keys on JSON.stringify([environmentId, input]), so the inline input
  // stays one stable key for as long as this job is the selected one
  const activityQuery = useEnvironmentQuery(
    workersActivityEnvironment({ environmentId, input: { jobId: job.jobId } }),
  )

  // a failed stream still hands back the last snapshot it read, so the two are disclosed
  // independently: the transport line qualifies whatever trace remains below it
  const snapshot = activityQuery.data
  const view = snapshot === null ? null : workerActivityView(snapshot.entries, snapshot.truncated)
  const snapshotError = snapshot === null ? null : Option.getOrNull(snapshot.error)
  const notice = snapshot === null ? null : workerActivityNoticeLabel(snapshot)
  const transport = workerActivityTransportLabel(activityQuery.error, snapshot !== null)
  const headline = workerActivityHeadline(status, view?.latestPhase ?? null)
  const hasTrace = view !== null && view.history.length > 0

  return (
    <section className="border-b border-border/60 px-3 py-2.5 last:border-b-0">
      <div className="mb-1.5 flex items-center gap-2">
        <SectionHeading inline>Activity</SectionHeading>
        {elapsedLabel === null ? null : (
          <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{elapsedLabel}</span>
        )}
      </div>

      {/* one region for every status this section can be in, so a change is announced in
          place instead of remounting a new live node; the ordered history stays outside it
          so expanding the disclosure is not read out */}
      <div aria-live="polite" className="min-w-0">
        {transport === null ? null : (
          <p className="mb-1.5 break-words text-xs leading-relaxed text-muted-foreground">
            {transport}
          </p>
        )}

        {snapshotError === null ? null : (
          <p className="mb-1.5 break-words text-xs leading-relaxed text-destructive">
            {snapshotError.message}
          </p>
        )}

        {snapshot === null ? (
          transport === null ? (
            <p className="text-xs text-muted-foreground">Reading activity…</p>
          ) : null
        ) : !hasTrace && !live ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            No activity was recorded for this job.
          </p>
        ) : (
          <>
            <WorkersActivityHeadlineBlock
              headline={headline}
              message={view?.latestMessage ?? null}
              note={hasTrace ? null : 'Waiting for the first activity update…'}
              actionSummary={view?.actionSummary ?? null}
            />
            {notice === null ? null : (
              <p className="mt-1 text-[10px] text-muted-foreground">{notice}</p>
            )}
          </>
        )}
      </div>

      {view === null || view.history.length === 0 ? null : (
        <WorkersActivityHistory entries={view.history} nowMs={nowMs} />
      )}
    </section>
  )
}

export function WorkersJobDetailView({
  environmentId,
  job,
  summary: listSummary,
  nowMs,
  verdict,
  onSaveVerdict,
}: {
  environmentId: EnvironmentId
  job: WorkersJobDetail
  summary: WorkersJobSummary | null
  nowMs: number
  verdict?: string | undefined
  onSaveVerdict?: ((verdict: string) => void) | undefined
})
{
  const verification = workerVerificationView(job.verification)
  // the live list row wins over the 30s detail read for status & timing alone; every
  // terminal field below still comes from the detail payload. the id check drops a row
  // that belongs to a newly selected job whose detail read has not landed yet
  const presentation = workerJobPresentation(
    job,
    listSummary?.jobId === job.jobId ? listSummary : null,
    nowMs,
  )
  const elapsed = presentation.elapsedLabel
  const model = workerModelLabel(job)
  const workflow = Option.getOrNull(job.workflow)
  const stage = Option.getOrNull(job.stage)
  const run = Option.getOrNull(job.run)
  const error = Option.getOrNull(job.error)
  const summary = Option.getOrNull(job.summary)
  const baseSha = Option.getOrNull(job.baseSha)
  const headSha = Option.getOrNull(job.headSha)
  const baseRef = Option.getOrNull(job.baseRef)
  const branch = Option.getOrNull(job.branch)
  const worktree = Option.getOrNull(job.worktree)
  const processExitCode = Option.getOrNull(job.processExitCode)
  const scopeViolationGroups = workerScopeViolationGroups(job)
  const scopeViolationCount = scopeViolationGroups.reduce(
    (count, group) => count + group.items.length,
    0,
  )
  const scopeViolationTitle = `${scopeViolationCount} warning${
    scopeViolationCount === 1 ? '' : 's'
  } in ${scopeViolationGroups.length} group${scopeViolationGroups.length === 1 ? '' : 's'}`

  return (
    <div className="pb-4">
      <WorkersJobTaskSection task={job.task} />

      {onSaveVerdict === undefined ? null : (
        <WorkersJobVerdictSection verdict={verdict ?? ''} onSave={onSaveVerdict} />
      )}

      <WorkersJobActivitySection
        environmentId={environmentId}
        job={job}
        status={presentation.status}
        live={presentation.live}
        nowMs={nowMs}
        elapsedLabel={elapsed}
      />

      {error === null ? null : (
        <DetailSection title="Error">
          <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-destructive">
            {error}
          </p>
        </DetailSection>
      )}

      {summary === null ? null : (
        <DetailSection title="Summary">
          <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground">
            {summary}
          </p>
        </DetailSection>
      )}

      <DetailSection title="Run">
        <DetailField label="Status">
          <JobStatusBadges job={job} />
        </DetailField>
        <DetailField label="Provider">{job.provider}</DetailField>
        <DetailField label="Mode">{job.mode}</DetailField>
        <DetailField label="Model">{model ?? '—'}</DetailField>
        {run === null ? null : (
          <DetailField label="Run">
            <span className="font-mono">{run}</span>
          </DetailField>
        )}
        {workflow === null ? null : <DetailField label="Workflow">{workflow}</DetailField>}
        {stage === null ? null : <DetailField label="Stage">{stage}</DetailField>}
        <DetailField label="Elapsed">{elapsed ?? '—'}</DetailField>
        {processExitCode === null ? null : (
          <DetailField label="Exit code">
            <span className="font-mono">{processExitCode}</span>
          </DetailField>
        )}
      </DetailSection>

      <DetailSection title="Repository">
        <DetailField label="Repo">
          <span className="font-mono">{job.repo}</span>
        </DetailField>
        <DetailField label="Branch">{branch ?? '—'}</DetailField>
        <DetailField label="Base ref">{baseRef ?? '—'}</DetailField>
        <DetailField label="Base sha">
          <span className="font-mono">{baseSha === null ? '—' : shortSha(baseSha)}</span>
        </DetailField>
        <DetailField label="Head sha">
          <span className="font-mono">{headSha === null ? '—' : shortSha(headSha)}</span>
        </DetailField>
        <DetailField label="Worktree">
          <span className="font-mono">{worktree ?? '—'}</span>
        </DetailField>
      </DetailSection>

      <WorkersJobPatchSection job={job} />

      <DetailSection title="Verification">
        {job.verificationRuns.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {verification === null ? 'No verification recorded.' : `${verification.label} passed`}
          </p>
        ) : (
          <ul className="space-y-2">
            {workerVerificationRunEntries(job.verificationRuns).map(({ key, run: entry }) =>
              {
              const exitCode = Option.getOrNull(entry.exitCode)
              const runElapsed = Option.getOrNull(entry.elapsedMs)
              const runFailed = entry.timedOut || (exitCode !== null && exitCode !== 0)
              const runUnknown = !entry.timedOut && exitCode === null
              return (
                <li key={key} className="text-xs">
                  <div
                    className={cn(
                      'break-all font-mono',
                      runFailed
                        ? 'text-destructive'
                        : runUnknown
                          ? 'text-muted-foreground'
                          : 'text-foreground',
                    )}
                  >
                    {entry.command}
                  </div>
                  <div className="mt-0.5 text-muted-foreground">
                    {exitCode === null ? 'exit unknown' : `exit ${exitCode}`}
                    {runElapsed === null ? '' : ` · ${formatDuration(runElapsed)}`}
                    {entry.timedOut ? ' · timed out' : ''}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </DetailSection>

      {scopeViolationGroups.length === 0 ? null : (
        <DetailSection title={scopeViolationTitle}>
          <ul className="space-y-2 text-xs text-destructive">
            {scopeViolationGroups.map((group) => (
              <li key={group.key}>
                <div className="font-medium text-foreground">{group.label}</div>
                <ul className="mt-1 space-y-0.5 border-s border-destructive/30 ps-2 font-mono">
                  {group.items.map((item, index) => (
                    <li
                      key={`${item.path}:${item.phase ?? 'legacy'}:${index}`}
                      className="break-all"
                    >
                      {item.path}
                      {item.phase === null ? null : (
                        <span className="ms-1 font-sans text-muted-foreground">({item.phase})</span>
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </DetailSection>
      )}

      {job.assumptions.length === 0 ? null : (
        <DetailSection title="Assumptions">
          <StringList items={job.assumptions} />
        </DetailSection>
      )}

      {job.risks.length === 0 ? null : (
        <DetailSection title="Risks">
          <StringList items={job.risks} />
        </DetailSection>
      )}

      {job.followUps.length === 0 ? null : (
        <DetailSection title="Follow-ups">
          <StringList items={job.followUps} />
        </DetailSection>
      )}
    </div>
  )
}
