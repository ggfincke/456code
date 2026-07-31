// apps/web/src/workers/workersPanel.logic.ts
// pure derivations for the workers right-panel surface

import type {
  WorkersJobChange,
  WorkersJobStatus,
  WorkersJobSummary,
  WorkersRunSummary,
  WorkersVerificationRun,
  WorkersVerificationSummary,
} from "@t3tools/contracts";
import * as Option from "effect/Option";

import { formatDuration } from "~/session-logic";

export type WorkerStatusBadgeVariant =
  | "default"
  | "destructive"
  | "error"
  | "info"
  | "outline"
  | "secondary"
  | "success"
  | "warning";

// every broker status gets its own tint so a scan of the table separates
// terminal failures from in-flight work without reading the label
export function workerStatusBadgeVariant(status: WorkersJobStatus): WorkerStatusBadgeVariant {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
      return "error";
    case "rejected":
      return "destructive";
    case "running":
      return "info";
    case "queued":
      return "secondary";
    case "cancelled":
      return "warning";
    case "unknown":
      return "outline";
  }
}

export interface WorkerVerificationView {
  readonly label: string;
  readonly failed: boolean;
}

// "passed/total" with a failure flag; timed-out runs count as failures because
// the broker records them separately from hard failures
export function workerVerificationView(
  verification: Option.Option<WorkersVerificationSummary>,
): WorkerVerificationView | null {
  const summary = Option.getOrNull(verification);
  if (summary === null) return null;
  return {
    label: `${summary.passed}/${summary.total}`,
    failed: summary.failed > 0 || summary.timedOut > 0,
  };
}

export interface WorkerVerificationRunEntry {
  readonly key: string;
  readonly run: WorkersVerificationRun;
}

// the same command can be run more than once per job, so keys carry an
// occurrence suffix instead of leaning on the array index
export function workerVerificationRunEntries(
  runs: readonly WorkersVerificationRun[],
): readonly WorkerVerificationRunEntry[] {
  const occurrences = new Map<string, number>();
  return runs.map((run) => {
    const occurrence = occurrences.get(run.command) ?? 0;
    occurrences.set(run.command, occurrence + 1);
    return { key: `${run.command}#${occurrence}`, run };
  });
}

export function workerElapsedLabel(elapsedMs: Option.Option<number>): string | null {
  const value = Option.getOrNull(elapsedMs);
  return value === null ? null : formatDuration(value);
}

// queued & running are the states the broker is still moving; everything else is terminal
export function workerJobIsLive(status: WorkersJobStatus): boolean {
  return status === "running" || status === "queued";
}

export type WorkerJobElapsedFields = Pick<
  WorkersJobSummary,
  "status" | "elapsedMs" | "startedAt" | "createdAt"
>;

// the caller's clock is the panel's shared minute timer, so a running span is only ever
// known to the minute; hours roll up so a long job does not read as a three-digit minute
function minuteSpanLabel(spanMs: number): string {
  const minutes = Math.floor(spanMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}

// every span measured against that clock shares one vocabulary, so nothing still in
// flight ever claims a precision the minute timer cannot back
function clockSpanLabel(spanMs: number): string {
  if (spanMs === 0) return "just started";
  return spanMs < 60_000 ? "under a minute so far" : `${minuteSpanLabel(spanMs)} so far`;
}

// the broker only records elapsedMs once a job settles, so a live job counts from its own
// start against the caller's clock instead of rendering a dash; the recorded span keeps
// its measured precision while the clock-derived one stays minute-honest
export function workerJobElapsedLabel(job: WorkerJobElapsedFields, nowMs: number): string | null {
  const recorded = Option.getOrNull(job.elapsedMs);
  const settled = recorded === null ? null : formatDuration(recorded);
  if (!workerJobIsLive(job.status)) return settled;

  const start =
    timestampMs(Option.getOrNull(job.startedAt)) ?? timestampMs(Option.getOrNull(job.createdAt));
  if (start === null) return settled;

  return clockSpanLabel(Math.max(0, nowMs - start));
}

export interface WorkerJobPresentation {
  readonly status: WorkersJobStatus;
  readonly live: boolean;
  readonly elapsedLabel: string | null;
}

// the job detail RPC only refreshes every 30s while the jobs list is a live subscription,
// so a job that settled in between keeps reading as Running in the detail payload; status
// & timing are taken from whichever record has already settled, preferring the live list
// when both agree, and the rest of the detail payload is left untouched
export function workerJobPresentation(
  detail: WorkerJobElapsedFields,
  summary: WorkerJobElapsedFields | null,
  nowMs: number,
): WorkerJobPresentation {
  const source =
    summary === null
      ? detail
      : !workerJobIsLive(summary.status)
        ? summary
        : !workerJobIsLive(detail.status)
          ? detail
          : summary;

  return {
    status: source.status,
    live: workerJobIsLive(source.status),
    elapsedLabel: workerJobElapsedLabel(source, nowMs),
  };
}

export function repoBasename(repoPath: string): string {
  const trimmed = repoPath.replace(/\/+$/, "");
  const separator = trimmed.lastIndexOf("/");
  return separator >= 0 ? trimmed.slice(separator + 1) : trimmed;
}

export function shortSha(sha: string): string {
  return sha.length > 10 ? sha.slice(0, 10) : sha;
}

function timestampMs(iso: string | null): number | null {
  if (iso === null) return null;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

// model & effort only exist on records the broker wrote with them, so they are read
// as optional on top of the summary shape a detail record also satisfies
export interface WorkerModelFields {
  readonly model?: Option.Option<string>;
  readonly effort?: Option.Option<string>;
}

// "model · effort", collapsing to whichever half the record carries
export function workerModelLabel(job: WorkersJobSummary & WorkerModelFields): string | null {
  const model = Option.getOrNull(job.model ?? Option.none<string>());
  const effort = Option.getOrNull(job.effort ?? Option.none<string>());
  if (model === null) return effort;
  return effort === null ? model : `${model} · ${effort}`;
}

export interface WorkerStageGroup {
  readonly key: string;
  readonly stage: string | null;
  readonly workflow: string | null;
  readonly jobs: readonly WorkersJobSummary[];
}

// groups come out in plan order of first appearance (oldest job wins the slot) while
// jobs inside a group stay newest-first to match the flat list; stage-less jobs fall
// into a trailing "other" bucket
export function workerStageGroups(jobs: readonly WorkersJobSummary[]): readonly WorkerStageGroup[] {
  interface MutableGroup {
    key: string;
    stage: string | null;
    workflow: string | null;
    jobs: WorkersJobSummary[];
  }

  const groups = new Map<string, MutableGroup>();
  const other: MutableGroup = { key: "other", stage: null, workflow: null, jobs: [] };
  for (const job of jobs.toReversed()) {
    const stage = Option.getOrNull(job.stage);
    if (stage === null) {
      other.jobs.unshift(job);
      continue;
    }

    const workflow = Option.getOrNull(job.workflow);
    const key = `${workflow ?? ""}\u0000${stage}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { key, stage, workflow, jobs: [job] });
    } else {
      group.jobs.unshift(job);
    }
  }

  return other.jobs.length === 0 ? [...groups.values()] : [...groups.values(), other];
}

export function workerJobsHaveStages(jobs: readonly WorkersJobSummary[]): boolean {
  return jobs.some((job) => Option.isSome(job.stage));
}

export interface WorkerRunStatusChip {
  readonly status: WorkersJobStatus;
  readonly count: number;
  readonly variant: WorkerStatusBadgeVariant;
}

// in-flight statuses lead so a glance at a row answers "is this run still moving?"
const RUN_CHIP_STATUSES = [
  "running",
  "queued",
  "completed",
  "failed",
  "rejected",
  "cancelled",
] as const;

export type WorkerRunCounts = {
  readonly [Status in (typeof RUN_CHIP_STATUSES)[number]]: number;
};

// shared by run rows & per-stage rollups; zero-count statuses are dropped so a clean
// run reads as one chip instead of six
export function workerRunStatusChips(counts: WorkerRunCounts): readonly WorkerRunStatusChip[] {
  return RUN_CHIP_STATUSES.flatMap((status) =>
    counts[status] === 0
      ? []
      : [{ status, count: counts[status], variant: workerStatusBadgeVariant(status) }],
  );
}

// a stage group can span workflows, so its chips are counted off the grouped jobs
// rather than looked up in the run's stage rollups
export function workerStageCounts(jobs: readonly WorkersJobSummary[]): WorkerRunCounts {
  const counts = { queued: 0, running: 0, completed: 0, failed: 0, rejected: 0, cancelled: 0 };
  for (const job of jobs) {
    if (job.status === "unknown") continue;
    counts[job.status] += 1;
  }
  return counts;
}

export function workerRunIsSettled(counts: WorkerRunCounts): boolean {
  return counts.queued === 0 && counts.running === 0;
}

// a settled run spans two recorded timestamps, so it keeps their measured precision; any
// other run is still ending against the caller's minute clock & reads minute-honest,
// matching how a live job states its own elapsed
export function workerRunSpanLabel(run: WorkersRunSummary, nowMs: number): string | null {
  const start = timestampMs(Option.getOrNull(run.firstCreatedAt));
  if (start === null) return null;
  const completed = timestampMs(Option.getOrNull(run.lastCompletedAt));
  if (workerRunIsSettled(run) && completed !== null) {
    return formatDuration(Math.max(0, completed - start));
  }
  return clockSpanLabel(Math.max(0, nowMs - start));
}

function runOrderKey(run: WorkersRunSummary): number {
  return (
    timestampMs(Option.getOrNull(run.firstCreatedAt)) ??
    timestampMs(Option.getOrNull(run.lastCompletedAt)) ??
    0
  );
}

// newest first, with the run id as a stable tiebreaker for records the broker wrote
// without timestamps
export function sortWorkerRunsNewestFirst(
  runs: readonly WorkersRunSummary[],
): readonly WorkersRunSummary[] {
  return [...runs].sort((left, right) => {
    const delta = runOrderKey(right) - runOrderKey(left);
    return delta === 0 ? right.run.localeCompare(left.run) : delta;
  });
}

export interface WorkerPatchFileEntry {
  readonly path: string;
  readonly status: string | null;
}

// the broker records per-file change statuses separately from the flat changed-file
// list; statuses win & the flat list backfills anything they missed
export function workerPatchFileEntries(job: {
  readonly changes: readonly WorkersJobChange[];
  readonly changedFiles: readonly string[];
}): readonly WorkerPatchFileEntry[] {
  const seen = new Set<string>();
  const entries: WorkerPatchFileEntry[] = [];
  for (const change of job.changes) {
    for (const path of change.paths) {
      if (seen.has(path)) continue;
      seen.add(path);
      entries.push({ path, status: change.status });
    }
  }
  for (const path of job.changedFiles) {
    if (seen.has(path)) continue;
    seen.add(path);
    entries.push({ path, status: null });
  }
  return entries;
}

export interface WorkerPatchClipboard {
  readonly label: string;
  readonly text: string;
}

// patch contents never cross the wire, so the copy affordance hands over the broker's
// patch file path when there is one & the per-file listing otherwise
export function workerPatchClipboard(job: {
  readonly patchPath: Option.Option<string>;
  readonly changes: readonly WorkersJobChange[];
  readonly changedFiles: readonly string[];
}): WorkerPatchClipboard | null {
  const patchPath = Option.getOrNull(job.patchPath);
  if (patchPath !== null) return { label: "Copy patch path", text: patchPath };

  const entries = workerPatchFileEntries(job);
  if (entries.length === 0) return null;
  return {
    label: "Copy file list",
    text: entries
      .map((entry) => (entry.status === null ? entry.path : `${entry.status}\t${entry.path}`))
      .join("\n"),
  };
}
