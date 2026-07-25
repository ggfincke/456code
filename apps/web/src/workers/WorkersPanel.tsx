// apps/web/src/workers/WorkersPanel.tsx
// read-only right-panel surface listing worker-broker jobs with an in-panel detail view

import type { EnvironmentId, WorkersJobDetail, WorkersListInput } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { ChevronLeft, RefreshCw } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

import { Badge } from "~/components/ui/badge";
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
import { useNowMinute } from "~/hooks/useNowMinute";
import { cn } from "~/lib/utils";
import { formatDuration } from "~/session-logic";
import { useEnvironmentQuery } from "~/state/query";
import { workersEnvironment } from "~/state/workers";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import {
  repoBasename,
  shortSha,
  workerElapsedLabel,
  workerStatusBadgeVariant,
  workerVerificationRunEntries,
  workerVerificationView,
} from "./workersPanel.logic";

interface WorkersPanelProps {
  environmentId: EnvironmentId;
}

// the atom family keys on JSON.stringify([environmentId, input]); a module-level
// literal keeps the list key stable across renders
const WORKERS_LIST_INPUT: WorkersListInput = {};

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h4 className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
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

function WorkersJobDetailView({ job }: { job: WorkersJobDetail }) {
  const verification = workerVerificationView(job.verification);
  const elapsed = workerElapsedLabel(job.elapsedMs);
  const model = Option.getOrNull(job.model);
  const effort = Option.getOrNull(job.effort);
  const error = Option.getOrNull(job.error);
  const summary = Option.getOrNull(job.summary);
  const baseSha = Option.getOrNull(job.baseSha);
  const headSha = Option.getOrNull(job.headSha);
  const baseRef = Option.getOrNull(job.baseRef);
  const branch = Option.getOrNull(job.branch);
  const worktree = Option.getOrNull(job.worktree);
  const patchPath = Option.getOrNull(job.patchPath);
  const processExitCode = Option.getOrNull(job.processExitCode);

  return (
    <div className="pb-4">
      <DetailSection title="Task">
        <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground">
          {job.task.trim().length > 0 ? job.task : "No task text recorded."}
        </p>
      </DetailSection>

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
          <Badge size="sm" variant={workerStatusBadgeVariant(job.status)}>
            {job.status}
          </Badge>
        </DetailField>
        <DetailField label="Provider">{job.provider}</DetailField>
        <DetailField label="Mode">{job.mode}</DetailField>
        <DetailField label="Model">
          {model === null ? "—" : effort === null ? model : `${model} · ${effort}`}
        </DetailField>
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
        <DetailField label="Patch">
          <span className="font-mono">{patchPath ?? "—"}</span>
        </DetailField>
      </DetailSection>

      <DetailSection title={`Changed files (${job.changedFiles.length})`}>
        {job.changedFiles.length === 0 ? (
          <p className="text-xs text-muted-foreground">No file changes recorded.</p>
        ) : (
          <ul className="space-y-0.5 font-mono text-xs text-foreground">
            {job.changedFiles.map((path) => (
              <li key={path} className="break-all">
                {path}
              </li>
            ))}
          </ul>
        )}
      </DetailSection>

      <DetailSection title="Verification">
        {job.verificationRuns.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {verification === null ? "No verification recorded." : `${verification.label} passed`}
          </p>
        ) : (
          <ul className="space-y-2">
            {workerVerificationRunEntries(job.verificationRuns).map(({ key, run }) => {
              const exitCode = Option.getOrNull(run.exitCode);
              const runElapsed = Option.getOrNull(run.elapsedMs);
              const runFailed = run.timedOut || (exitCode !== null && exitCode !== 0);
              return (
                <li key={key} className="text-xs">
                  <div
                    className={cn(
                      "break-all font-mono",
                      runFailed ? "text-destructive" : "text-foreground",
                    )}
                  >
                    {run.command}
                  </div>
                  <div className="mt-0.5 text-muted-foreground">
                    {`exit ${exitCode ?? "—"}`}
                    {runElapsed === null ? "" : ` · ${formatDuration(runElapsed)}`}
                    {run.timedOut ? " · timed out" : ""}
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

export default function WorkersPanel({ environmentId }: WorkersPanelProps) {
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const listQuery = useEnvironmentQuery(
    workersEnvironment.list({ environmentId, input: WORKERS_LIST_INPUT }),
  );
  const detailQuery = useEnvironmentQuery(
    selectedJobId === null
      ? null
      : workersEnvironment.getJob({ environmentId, input: { jobId: selectedJobId } }),
  );

  const detailOpen = selectedJobId !== null;
  const activeQuery = detailOpen ? detailQuery : listQuery;
  const readAt = activeQuery.data?.readAt ?? null;

  // the minute clock only drives the re-render; the label re-reads the wall clock
  const nowMinute = useNowMinute();
  const readAtLabel = useMemo(
    () => (readAt === null ? null : formatRelativeTimeLabel(readAt)),
    [readAt, nowMinute],
  );

  const listData = listQuery.data;
  const listError = listData === null ? null : Option.getOrNull(listData.error);
  const jobs = listData?.jobs ?? [];

  const subtitle = detailOpen
    ? selectedJobId
    : listData === null
      ? "Reading broker state…"
      : `${jobs.length.toLocaleString()} job${jobs.length === 1 ? "" : "s"}${
          listData.skippedJobCount > 0 ? ` · ${listData.skippedJobCount} skipped` : ""
        }`;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background" data-workers-panel={environmentId}>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        {detailOpen ? (
          <button
            type="button"
            className="-ml-1 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Back to worker jobs"
            onClick={() => setSelectedJobId(null)}
          >
            <ChevronLeft className="size-3.5" />
          </button>
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-foreground">
            {detailOpen ? "Worker job" : "Workers"}
          </div>
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
              return <WorkersJobDetailView job={job} />;
            })()
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
                {jobs.map((job) => {
                  const verification = workerVerificationView(job.verification);
                  const elapsed = workerElapsedLabel(job.elapsedMs);
                  const changedFileCount = Option.getOrNull(job.changedFileCount);
                  return (
                    <TableRow
                      key={job.jobId}
                      role="button"
                      tabIndex={0}
                      aria-label={`Open worker job ${job.jobId}`}
                      className="cursor-pointer"
                      onClick={() => setSelectedJobId(job.jobId)}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        setSelectedJobId(job.jobId);
                      }}
                    >
                      <TableCell className="px-3 font-mono">{job.jobId}</TableCell>
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
                      <TableCell className="px-2 text-muted-foreground">
                        {changedFileCount ?? "—"}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "px-3",
                          verification?.failed ? "text-destructive" : "text-muted-foreground",
                        )}
                      >
                        {verification?.label ?? "—"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </>
        )}
      </ScrollArea>
    </div>
  );
}
