// apps/web/src/workers/WorkersPanel.tsx
// read-only right-panel surface for worker-broker orchestration runs & jobs

import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  WorkersJobDetail,
  WorkersJobStatus,
  WorkersJobSummary,
  WorkersListInput,
  WorkersRunSummary,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Check, ChevronLeft, ChevronRight, Copy, RefreshCw, TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useId, useMemo, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Skeleton } from "~/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useNowMinute } from "~/hooks/useNowMinute";
import { cn } from "~/lib/utils";
import {
  selectActiveRightPanelSurface,
  useRightPanelStore,
  type RightPanelSurface,
} from "~/rightPanelStore";
import { formatDuration } from "~/session-logic";
import { useEnvironmentQuery } from "~/state/query";
import { workersActivityEnvironment, workersEnvironment } from "~/state/workers";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import {
  workerActivityAgeLabel,
  workerActivityHeadline,
  workerActivityNoticeLabel,
  workerActivityTransportLabel,
  workerActivityView,
  type WorkerActivityHeadline,
  type WorkerActivityHistoryEntry,
} from "./workersActivity.logic";
import {
  repoBasename,
  shortSha,
  sortWorkerRunsNewestFirst,
  workerElapsedLabel,
  workerJobPresentation,
  workerJobsHaveStages,
  workerModelLabel,
  workerPatchClipboard,
  workerPatchFileEntries,
  workerRunSpanLabel,
  workerRunStatusChips,
  workerStageCounts,
  workerStageGroups,
  workerStatusBadgeVariant,
  workerVerificationRunEntries,
  workerVerificationView,
  type WorkerRunStatusChip,
} from "./workersPanel.logic";

interface WorkersPanelProps {
  environmentId: EnvironmentId;
}

// the atom family keys on JSON.stringify([environmentId, input]); a module-level
// literal keeps the unfiltered list & runs keys stable across renders
const WORKERS_LIST_INPUT: WorkersListInput = {};

type WorkersView = "runs" | "jobs";

interface WorkersNav {
  readonly view: WorkersView;
  readonly runId: string | null;
  readonly jobId: string | null;
}

// the workers surface carries an optional run id for deep-links; the surface shape is
// widened outside this panel, so read the field structurally instead of narrowing
function surfaceRunId(surface: RightPanelSurface | null): string | null {
  if (surface === null || surface.kind !== "workers") return null;
  if (!("run" in surface)) return null;
  const run = surface.run;
  return typeof run === "string" && run.length > 0 ? run : null;
}

// the panel is mounted without a thread ref, so the deep-link is read off whichever
// thread in this environment currently has the workers surface active
function useWorkersRunDeepLink(environmentId: EnvironmentId): string | null {
  return useRightPanelStore((state) => {
    for (const threadKey of Object.keys(state.byThreadKey)) {
      const ref = parseScopedThreadKey(threadKey);
      if (ref === null || ref.environmentId !== environmentId) continue;
      const run = surfaceRunId(selectActiveRightPanelSurface(state.byThreadKey, ref));
      if (run !== null) return run;
    }
    return null;
  });
}

function SectionHeading({ children, inline }: { children: ReactNode; inline?: boolean }) {
  return (
    <h4
      className={cn(
        "text-[10px] font-medium uppercase tracking-wide text-muted-foreground",
        inline ? null : "mb-1.5",
      )}
    >
      {children}
    </h4>
  );
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-border/60 px-3 py-2.5 last:border-b-0">
      <SectionHeading>{title}</SectionHeading>
      {children}
    </section>
  );
}

function DetailField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-2 py-0.5 text-xs">
      <span className="w-24 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 break-all text-foreground">{children}</span>
    </div>
  );
}

function StringList({ items }: { items: readonly string[] }) {
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
  );
}

function SkeletonRows() {
  return (
    <div className="space-y-2 p-3">
      {[0, 1, 2, 3, 4].map((row) => (
        <Skeleton key={row} className="h-6 w-full" />
      ))}
    </div>
  );
}

function StatusChips({ chips }: { chips: readonly WorkerRunStatusChip[] }) {
  return (
    <>
      {chips.map((chip) => (
        <Badge key={chip.status} size="sm" variant={chip.variant}>
          {chip.count} {chip.status}
        </Badge>
      ))}
    </>
  );
}

function relativeOrDash(timestamp: Option.Option<string>): string {
  const iso = Option.getOrNull(timestamp);
  if (iso === null) return "—";
  const label = formatRelativeTimeLabel(iso);
  return label.length === 0 ? iso : label;
}

function ScopeViolationBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <Badge size="sm" variant="destructive">
      <TriangleAlert />
      {count} scope
    </Badge>
  );
}

function JobMetadataBadges({ job }: { job: WorkersJobSummary }) {
  const workflow = Option.getOrNull(job.workflow);
  const stage = Option.getOrNull(job.stage);
  if (workflow === null && stage === null) return null;

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
  );
}

function WorkersRunRow({
  run,
  nowMs,
  onSelect,
}: {
  run: WorkersRunSummary;
  nowMs: number;
  onSelect: (runId: string) => void;
}) {
  const span = workerRunSpanLabel(run, nowMs);

  return (
    <button
      type="button"
      aria-label={`Open orchestration run ${run.run}`}
      className="block w-full border-b border-border/60 px-3 py-2 text-left hover:bg-accent/50"
      onClick={() => onSelect(run.run)}
    >
      <span className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{run.run}</span>
        <span className="shrink-0 text-[10px] text-muted-foreground">{span ?? "—"}</span>
      </span>
      <span className="mt-1 flex flex-wrap items-center gap-1">
        {run.workflows.map((workflow) => (
          <Badge key={workflow} size="sm" variant="secondary">
            {workflow}
          </Badge>
        ))}
        <StatusChips chips={workerRunStatusChips(run)} />
        <ScopeViolationBadge count={run.scopeViolationCount} />
      </span>
      <span className="mt-1 block text-[10px] text-muted-foreground">
        {run.total.toLocaleString()} job{run.total === 1 ? "" : "s"} ·{" "}
        {run.stages.length.toLocaleString()} stage{run.stages.length === 1 ? "" : "s"}
      </span>
    </button>
  );
}

function WorkersJobRow({
  job,
  onSelect,
}: {
  job: WorkersJobSummary;
  onSelect: (jobId: string) => void;
}) {
  const verification = workerVerificationView(job.verification);
  const elapsed = workerElapsedLabel(job.elapsedMs);
  const changedFileCount = Option.getOrNull(job.changedFileCount);

  return (
    <TableRow
      role="button"
      tabIndex={0}
      aria-label={`Open worker job ${job.jobId}`}
      className="cursor-pointer"
      onClick={() => onSelect(job.jobId)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onSelect(job.jobId);
      }}
    >
      <TableCell className="px-3 font-mono">
        {job.jobId}
        <JobMetadataBadges job={job} />
      </TableCell>
      <TableCell className="px-2">
        <Badge size="sm" variant={workerStatusBadgeVariant(job.status)}>
          {job.status}
        </Badge>
      </TableCell>
      <TableCell className="px-2 text-muted-foreground">{job.provider}</TableCell>
      <TableCell className="px-2 text-muted-foreground">{job.mode}</TableCell>
      <TableCell className="px-2">
        <Tooltip>
          <TooltipTrigger render={<span>{repoBasename(job.repo)}</span>} />
          <TooltipPopup>{job.repo}</TooltipPopup>
        </Tooltip>
      </TableCell>
      <TableCell className="px-2 text-muted-foreground">{elapsed ?? "—"}</TableCell>
      <TableCell className="px-2 text-muted-foreground">{changedFileCount ?? "—"}</TableCell>
      <TableCell
        className={cn("px-3", verification?.failed ? "text-destructive" : "text-muted-foreground")}
      >
        {verification?.label ?? "—"}
      </TableCell>
    </TableRow>
  );
}

// the run detail drops repo/mode (constant within a run) for the per-stage columns that
// actually vary: model & effort
function WorkersRunJobRow({
  job,
  onSelect,
}: {
  job: WorkersJobSummary;
  onSelect: (jobId: string) => void;
}) {
  const elapsed = workerElapsedLabel(job.elapsedMs);
  const changedFileCount = Option.getOrNull(job.changedFileCount);
  const model = workerModelLabel(job);

  return (
    <TableRow
      role="button"
      tabIndex={0}
      aria-label={`Open worker job ${job.jobId}`}
      className="cursor-pointer"
      onClick={() => onSelect(job.jobId)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onSelect(job.jobId);
      }}
    >
      <TableCell className="px-3 font-mono">{job.jobId}</TableCell>
      <TableCell className="px-2">
        <Badge size="sm" variant={workerStatusBadgeVariant(job.status)}>
          {job.status}
        </Badge>
      </TableCell>
      <TableCell className="px-2 text-muted-foreground">{job.provider}</TableCell>
      <TableCell className="px-2 text-muted-foreground">{model ?? "—"}</TableCell>
      <TableCell className="px-2 text-muted-foreground">{elapsed ?? "—"}</TableCell>
      <TableCell className="px-3 text-muted-foreground">{changedFileCount ?? "—"}</TableCell>
    </TableRow>
  );
}

function WorkersRunDetailView({
  run,
  jobs,
  nowMs,
  onSelectJob,
}: {
  run: WorkersRunSummary | null;
  jobs: readonly WorkersJobSummary[];
  nowMs: number;
  onSelectJob: (jobId: string) => void;
}) {
  const groups = workerStageGroups(jobs);

  return (
    <div className="pb-4">
      {run === null ? null : (
        <DetailSection title="Run">
          <div className="mb-2 flex flex-wrap items-center gap-1">
            {run.workflows.map((workflow) => (
              <Badge key={workflow} size="sm" variant="secondary">
                {workflow}
              </Badge>
            ))}
            <StatusChips chips={workerRunStatusChips(run)} />
            <ScopeViolationBadge count={run.scopeViolationCount} />
          </div>
          <DetailField label="Jobs">{run.total.toLocaleString()}</DetailField>
          <DetailField label="Elapsed">{workerRunSpanLabel(run, nowMs) ?? "—"}</DetailField>
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
                      {group.stage ?? "other"}
                    </Badge>
                    <StatusChips chips={workerRunStatusChips(workerStageCounts(group.jobs))} />
                  </span>
                </TableCell>
              </TableRow>,
              ...group.jobs.map((job) => (
                <WorkersRunJobRow key={job.jobId} job={job} onSelect={onSelectJob} />
              )),
            ])}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

// the broker never ships patch text to the client, so the "patch" view is the per-file
// change listing plus a copy affordance for the patch path the broker wrote
function WorkersJobPatchSection({ job }: { job: WorkersJobDetail }) {
  const entries = workerPatchFileEntries(job);
  const clipboard = workerPatchClipboard(job);
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "patch" });

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
            >{`Patch (${entries.length} file${entries.length === 1 ? "" : "s"})`}</SectionHeading>
          </CollapsibleTrigger>
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
                      {entry.status ?? "—"}
                    </span>
                    <span className="min-w-0 flex-1 break-all">{entry.path}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 break-all font-mono text-[10px] text-muted-foreground">
              {Option.getOrNull(job.patchPath) ?? "No patch file recorded."}
            </p>
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </section>
  );
}

// whether three lines hide anything is a question about the rendered width, not the
// character count: a short task wraps past the clamp in a narrow panel & a long one can
// fit in a wide one. the clamped paragraph measures itself instead, and re-measures as
// the panel resizes, so the disclosure appears exactly when text is actually clipped
function useTaskClipped(collapsed: boolean): {
  readonly ref: (node: HTMLParagraphElement | null) => void;
  readonly clipped: boolean;
} {
  const [node, setNode] = useState<HTMLParagraphElement | null>(null);
  const [clipped, setClipped] = useState(false);

  // an expanded paragraph carries no clamp to overflow, so it is left unmeasured & keeps
  // the verdict that opened it; collapsing re-measures at the current width
  useEffect(() => {
    if (node === null || !collapsed) return;

    const measure = () => {
      const next = node.scrollHeight - node.clientHeight > 1;
      setClipped((current) => (current === next ? current : next));
    };

    measure();
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [node, collapsed]);

  return { ref: setNode, clipped };
}

// a broker task runs to hundreds of lines, which used to push everything below it off
// screen; the clamp keeps the detail scannable & the disclosure keeps the full text one
// keystroke away
function WorkersJobTaskSection({ task }: { task: string }) {
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const text = task.trim();
  const collapsed = text.length > 0 && !expanded;
  const { ref, clipped } = useTaskClipped(collapsed);

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
            {expanded ? "Hide full task" : "Show full task"}
          </button>
        ) : null}
      </div>
      <p
        id={bodyId}
        ref={ref}
        className={cn(
          "whitespace-pre-wrap break-words text-xs leading-relaxed",
          text.length === 0 ? "text-muted-foreground" : "text-foreground",
          collapsed ? "line-clamp-3" : null,
        )}
      >
        {text.length > 0 ? text : "No task text recorded."}
      </p>
    </section>
  );
}

// the headline is the one part that changes while a job runs; it renders inside the
// section's persistent live region rather than owning one, so a swap between headline,
// empty & disconnected states is announced in place. status is stated as text inside the
// badge rather than by tint alone
function WorkersActivityHeadlineBlock({
  headline,
  message,
  note,
  actionSummary,
}: {
  headline: WorkerActivityHeadline;
  message: string | null;
  note: string | null;
  actionSummary: string | null;
}) {
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
  );
}

function WorkersActivityHistory({
  entries,
  nowMs,
}: {
  entries: readonly WorkerActivityHistoryEntry[];
  nowMs: number;
}) {
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
  );
}

// the only subscription in this panel that is scoped to a single job; it is mounted from
// the selected detail alone, so list & run rows never open an activity stream
function WorkersJobActivitySection({
  environmentId,
  job,
  status,
  live,
  nowMs,
  elapsedLabel,
}: {
  environmentId: EnvironmentId;
  job: WorkersJobDetail;
  status: WorkersJobStatus;
  live: boolean;
  nowMs: number;
  elapsedLabel: string | null;
}) {
  // the atom family keys on JSON.stringify([environmentId, input]), so the inline input
  // stays one stable key for as long as this job is the selected one
  const activityQuery = useEnvironmentQuery(
    workersActivityEnvironment({ environmentId, input: { jobId: job.jobId } }),
  );

  // a failed stream still hands back the last snapshot it read, so the two are disclosed
  // independently: the transport line qualifies whatever trace remains below it
  const snapshot = activityQuery.data;
  const view = snapshot === null ? null : workerActivityView(snapshot.entries, snapshot.truncated);
  const snapshotError = snapshot === null ? null : Option.getOrNull(snapshot.error);
  const notice = snapshot === null ? null : workerActivityNoticeLabel(snapshot);
  const transport = workerActivityTransportLabel(activityQuery.error, snapshot !== null);
  const headline = workerActivityHeadline(status, view?.latestPhase ?? null);
  const hasTrace = view !== null && view.history.length > 0;

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
              note={hasTrace ? null : "Waiting for the first activity update…"}
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
  );
}

function WorkersJobDetailView({
  environmentId,
  job,
  summary: listSummary,
  nowMs,
}: {
  environmentId: EnvironmentId;
  job: WorkersJobDetail;
  summary: WorkersJobSummary | null;
  nowMs: number;
}) {
  const verification = workerVerificationView(job.verification);
  // the live list row wins over the 30s detail read for status & timing alone; every
  // terminal field below still comes from the detail payload. the id check drops a row
  // that belongs to a newly selected job whose detail read has not landed yet
  const presentation = workerJobPresentation(
    job,
    listSummary?.jobId === job.jobId ? listSummary : null,
    nowMs,
  );
  const elapsed = presentation.elapsedLabel;
  const model = workerModelLabel(job);
  const workflow = Option.getOrNull(job.workflow);
  const stage = Option.getOrNull(job.stage);
  const run = Option.getOrNull(job.run);
  const error = Option.getOrNull(job.error);
  const summary = Option.getOrNull(job.summary);
  const baseSha = Option.getOrNull(job.baseSha);
  const headSha = Option.getOrNull(job.headSha);
  const baseRef = Option.getOrNull(job.baseRef);
  const branch = Option.getOrNull(job.branch);
  const worktree = Option.getOrNull(job.worktree);
  const processExitCode = Option.getOrNull(job.processExitCode);

  return (
    <div className="pb-4">
      <WorkersJobTaskSection task={job.task} />

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
          <Badge size="sm" variant={workerStatusBadgeVariant(presentation.status)}>
            {presentation.status}
          </Badge>
        </DetailField>
        <DetailField label="Provider">{job.provider}</DetailField>
        <DetailField label="Mode">{job.mode}</DetailField>
        <DetailField label="Model">{model ?? "—"}</DetailField>
        {run === null ? null : (
          <DetailField label="Run">
            <span className="font-mono">{run}</span>
          </DetailField>
        )}
        {workflow === null ? null : <DetailField label="Workflow">{workflow}</DetailField>}
        {stage === null ? null : <DetailField label="Stage">{stage}</DetailField>}
        <DetailField label="Elapsed">{elapsed ?? "—"}</DetailField>
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
        <DetailField label="Branch">{branch ?? "—"}</DetailField>
        <DetailField label="Base ref">{baseRef ?? "—"}</DetailField>
        <DetailField label="Base sha">
          <span className="font-mono">{baseSha === null ? "—" : shortSha(baseSha)}</span>
        </DetailField>
        <DetailField label="Head sha">
          <span className="font-mono">{headSha === null ? "—" : shortSha(headSha)}</span>
        </DetailField>
        <DetailField label="Worktree">
          <span className="font-mono">{worktree ?? "—"}</span>
        </DetailField>
      </DetailSection>

      <WorkersJobPatchSection job={job} />

      <DetailSection title="Verification">
        {job.verificationRuns.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {verification === null ? "No verification recorded." : `${verification.label} passed`}
          </p>
        ) : (
          <ul className="space-y-2">
            {workerVerificationRunEntries(job.verificationRuns).map(({ key, run: entry }) => {
              const exitCode = Option.getOrNull(entry.exitCode);
              const runElapsed = Option.getOrNull(entry.elapsedMs);
              const runFailed = entry.timedOut || (exitCode !== null && exitCode !== 0);
              return (
                <li key={key} className="text-xs">
                  <div
                    className={cn(
                      "break-all font-mono",
                      runFailed ? "text-destructive" : "text-foreground",
                    )}
                  >
                    {entry.command}
                  </div>
                  <div className="mt-0.5 text-muted-foreground">
                    {`exit ${exitCode ?? "—"}`}
                    {runElapsed === null ? "" : ` · ${formatDuration(runElapsed)}`}
                    {entry.timedOut ? " · timed out" : ""}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </DetailSection>

      {job.scopeViolations.length === 0 ? null : (
        <DetailSection title={`Scope violations (${job.scopeViolations.length})`}>
          <ul className="space-y-0.5 font-mono text-xs text-destructive">
            {job.scopeViolations.map((path) => (
              <li key={path} className="break-all">
                {path}
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
  );
}

function ViewToggle({
  view,
  onChange,
}: {
  view: WorkersView;
  onChange: (next: WorkersView) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-1.5">
      {(["runs", "jobs"] as const).map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={view === value}
          className={cn(
            "rounded-md px-2 py-0.5 text-[11px] font-medium",
            view === value
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
          )}
          onClick={() => onChange(value)}
        >
          {value === "runs" ? "Runs" : "All jobs"}
        </button>
      ))}
    </div>
  );
}

export default function WorkersPanel({ environmentId }: WorkersPanelProps) {
  const deepLinkRun = useWorkersRunDeepLink(environmentId);
  const [nav, setNav] = useState<WorkersNav>(() =>
    deepLinkRun === null
      ? { view: "runs", runId: null, jobId: null }
      : { view: "runs", runId: deepLinkRun, jobId: null },
  );
  // the deep-link wins whenever the surface's run changes; local navigation afterwards
  // stays put because the applied value only moves with the surface
  const [appliedDeepLink, setAppliedDeepLink] = useState<string | null>(deepLinkRun);
  if (appliedDeepLink !== deepLinkRun) {
    setAppliedDeepLink(deepLinkRun);
    if (deepLinkRun !== null) setNav({ view: "runs", runId: deepLinkRun, jobId: null });
  }

  const selectedRunId = nav.runId;
  const selectedJobId = nav.jobId;
  const listQuery = useEnvironmentQuery(
    workersEnvironment.list({ environmentId, input: WORKERS_LIST_INPUT }),
  );
  const runsQuery = useEnvironmentQuery(
    workersEnvironment.listRuns({ environmentId, input: WORKERS_LIST_INPUT }),
  );
  const runDetailQuery = useEnvironmentQuery(
    selectedRunId === null
      ? null
      : workersEnvironment.getRun({ environmentId, input: { run: selectedRunId } }),
  );
  const detailQuery = useEnvironmentQuery(
    selectedJobId === null
      ? null
      : workersEnvironment.getJob({ environmentId, input: { jobId: selectedJobId } }),
  );

  const activeQuery =
    selectedJobId !== null
      ? detailQuery
      : selectedRunId !== null
        ? runDetailQuery
        : nav.view === "runs"
          ? runsQuery
          : listQuery;
  const readAt = activeQuery.data?.readAt ?? null;

  // the minute clock only drives the re-render; labels re-read the wall clock
  const nowMinute = useNowMinute();
  const readAtLabel = useMemo(
    () => (readAt === null ? null : formatRelativeTimeLabel(readAt)),
    [readAt, nowMinute],
  );
  // elapsed spans for in-flight runs tick with the shared minute clock rather than a
  // panel-local interval
  const nowMs = useMemo(() => Date.parse(`${nowMinute}:00Z`), [nowMinute]);

  const listData = listQuery.data;
  const listError = listData === null ? null : Option.getOrNull(listData.error);
  const jobs = listData?.jobs ?? [];

  const runsData = runsQuery.data;
  const runsError = runsData === null ? null : Option.getOrNull(runsData.error);
  const runs = useMemo(() => sortWorkerRunsNewestFirst(runsData?.runs ?? []), [runsData?.runs]);

  const detailOpen = selectedJobId !== null;
  const runOpen = !detailOpen && selectedRunId !== null;
  const listOpen = !detailOpen && !runOpen;

  // the list subscription is already mounted for every view, so the selected job's row is
  // the freshest record the panel holds while the detail read waits out its 30s interval
  const selectedSummary = useMemo(() => {
    if (selectedJobId === null) return null;
    return jobs.find((job) => job.jobId === selectedJobId) ?? null;
  }, [jobs, selectedJobId]);

  const title = detailOpen ? "Worker job" : runOpen ? "Orchestration run" : "Workers";
  const subtitle = detailOpen
    ? selectedJobId
    : runOpen
      ? selectedRunId
      : nav.view === "runs"
        ? runsData === null
          ? "Reading broker state…"
          : `${runs.length.toLocaleString()} run${runs.length === 1 ? "" : "s"}`
        : listData === null
          ? "Reading broker state…"
          : `${jobs.length.toLocaleString()} job${jobs.length === 1 ? "" : "s"}${
              listData.skippedJobCount > 0 ? ` · ${listData.skippedJobCount} skipped` : ""
            }`;

  const goBack = () => {
    setNav((current) =>
      current.jobId !== null
        ? { ...current, jobId: null }
        : { view: current.view, runId: null, jobId: null },
    );
  };
  const selectJob = (jobId: string) => setNav((current) => ({ ...current, jobId }));
  const selectRun = (runId: string) => setNav({ view: "runs", runId, jobId: null });
  const selectView = (view: WorkersView) => setNav({ view, runId: null, jobId: null });

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background" data-workers-panel={environmentId}>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        {listOpen ? null : (
          <button
            type="button"
            className="-ml-1 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={
              !detailOpen
                ? "Back to orchestration runs"
                : selectedRunId === null
                  ? "Back to worker jobs"
                  : "Back to run jobs"
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
          <RefreshCw className={cn("size-3.5", activeQuery.isPending && "animate-spin")} />
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
            (() => {
              const detail = detailQuery.data;
              if (!detail) return null;
              const job = Option.getOrNull(detail.job);
              const detailError = Option.getOrNull(detail.error);
              if (job === null) {
                return (
                  <div className="p-4 text-xs leading-relaxed text-muted-foreground">
                    {detailError?.message ??
                      "This worker job is no longer in the broker state directory."}
                  </div>
                );
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
              );
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
            (() => {
              const detail = runDetailQuery.data;
              if (!detail) return null;
              const run = Option.getOrNull(detail.run);
              const runError = Option.getOrNull(detail.error);
              if (run === null && detail.jobs.length === 0) {
                return (
                  <div className="p-4 text-xs leading-relaxed text-muted-foreground">
                    {runError?.message ??
                      "This orchestration run is no longer in the broker state directory."}
                  </div>
                );
              }
              return (
                <WorkersRunDetailView
                  run={run}
                  jobs={detail.jobs}
                  nowMs={nowMs}
                  onSelectJob={selectJob}
                />
              );
            })()
          )
        ) : nav.view === "runs" ? (
          runsQuery.isPending && runsData === null ? (
            <SkeletonRows />
          ) : runsQuery.error && runsData === null ? (
            <div className="p-4 text-xs leading-relaxed text-destructive">{runsQuery.error}</div>
          ) : runsData === null ? null : runsData.state === "state-dir-missing" ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No worker state</EmptyTitle>
                <EmptyDescription>
                  Workers unavailable: worker-broker state is not present on this host.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
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
        ) : listData === null ? null : listData.state === "state-dir-missing" ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No worker state</EmptyTitle>
              <EmptyDescription>
                Workers unavailable: worker-broker state is not present on this host.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
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
                      <WorkersJobRow key={job.jobId} job={job} onSelect={selectJob} />
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
                              {group.stage ?? "other"}
                            </Badge>
                          </span>
                        </TableCell>
                      </TableRow>,
                      ...group.jobs.map((job) => (
                        <WorkersJobRow key={job.jobId} job={job} onSelect={selectJob} />
                      )),
                    ])}
              </TableBody>
            </Table>
          </>
        )}
      </ScrollArea>
    </div>
  );
}
