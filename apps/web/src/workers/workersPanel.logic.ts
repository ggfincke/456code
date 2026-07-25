// apps/web/src/workers/workersPanel.logic.ts
// pure derivations for the workers right-panel surface

import type {
  WorkersJobStatus,
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

export function repoBasename(repoPath: string): string {
  const trimmed = repoPath.replace(/\/+$/, "");
  const separator = trimmed.lastIndexOf("/");
  return separator >= 0 ? trimmed.slice(separator + 1) : trimmed;
}

export function shortSha(sha: string): string {
  return sha.length > 10 ? sha.slice(0, 10) : sha;
}
