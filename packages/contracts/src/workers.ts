// packages/contracts/src/workers.ts
// read-model contract for the workers dashboard over local worker-broker state

import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

// broker statuses plus "unknown" so newer broker records degrade instead of failing decode
export const WorkersJobStatus = Schema.Literals([
  "queued",
  "running",
  "completed",
  "failed",
  "rejected",
  "cancelled",
  "unknown",
]);
export type WorkersJobStatus = typeof WorkersJobStatus.Type;

export const WorkersVerificationSummary = Schema.Struct({
  total: NonNegativeInt,
  passed: NonNegativeInt,
  failed: NonNegativeInt,
  timedOut: NonNegativeInt,
});
export type WorkersVerificationSummary = typeof WorkersVerificationSummary.Type;

export const WorkersVerificationRun = Schema.Struct({
  command: TrimmedNonEmptyString,
  exitCode: Schema.Option(Schema.Int),
  timedOut: Schema.Boolean,
  elapsedMs: Schema.Option(NonNegativeInt),
});
export type WorkersVerificationRun = typeof WorkersVerificationRun.Type;

export const WorkersJobSummary = Schema.Struct({
  jobId: TrimmedNonEmptyString,
  status: WorkersJobStatus,
  provider: TrimmedNonEmptyString,
  mode: TrimmedNonEmptyString,
  repo: TrimmedNonEmptyString,
  branch: Schema.Option(TrimmedNonEmptyString),
  createdAt: Schema.Option(IsoDateTime),
  startedAt: Schema.Option(IsoDateTime),
  completedAt: Schema.Option(IsoDateTime),
  elapsedMs: Schema.Option(NonNegativeInt),
  changedFileCount: Schema.Option(NonNegativeInt),
  verification: Schema.Option(WorkersVerificationSummary),
  scopeViolationCount: NonNegativeInt,
});
export type WorkersJobSummary = typeof WorkersJobSummary.Type;

export const WorkersJobChange = Schema.Struct({
  status: TrimmedNonEmptyString,
  paths: Schema.Array(TrimmedNonEmptyString),
});
export type WorkersJobChange = typeof WorkersJobChange.Type;

export const WorkersJobDetail = Schema.Struct({
  ...WorkersJobSummary.fields,
  task: Schema.String,
  allowedPaths: Schema.Array(TrimmedNonEmptyString),
  model: Schema.Option(TrimmedNonEmptyString),
  effort: Schema.Option(TrimmedNonEmptyString),
  baseRef: Schema.Option(TrimmedNonEmptyString),
  baseSha: Schema.Option(TrimmedNonEmptyString),
  headSha: Schema.Option(TrimmedNonEmptyString),
  worktree: Schema.Option(TrimmedNonEmptyString),
  patchPath: Schema.Option(TrimmedNonEmptyString),
  summary: Schema.Option(Schema.String),
  error: Schema.Option(Schema.String),
  assumptions: Schema.Array(Schema.String),
  risks: Schema.Array(Schema.String),
  followUps: Schema.Array(Schema.String),
  changedFiles: Schema.Array(TrimmedNonEmptyString),
  changes: Schema.Array(WorkersJobChange),
  verificationRuns: Schema.Array(WorkersVerificationRun),
  scopeViolations: Schema.Array(TrimmedNonEmptyString),
  processExitCode: Schema.Option(Schema.Int),
});
export type WorkersJobDetail = typeof WorkersJobDetail.Type;

// "state-dir-missing" is the explicit local-only unavailable state; it is not an error
export const WorkersSnapshotState = Schema.Literals(["available", "state-dir-missing"]);
export type WorkersSnapshotState = typeof WorkersSnapshotState.Type;

export const WorkersListInput = Schema.Struct({});
export type WorkersListInput = typeof WorkersListInput.Type;

export const WorkersListResult = Schema.Struct({
  state: WorkersSnapshotState,
  stateDir: TrimmedNonEmptyString,
  readAt: IsoDateTime,
  jobs: Schema.Array(WorkersJobSummary),
  // records skipped by lenient parsing: corrupt json or unsupported schema_version
  skippedJobCount: NonNegativeInt,
  error: Schema.Option(
    Schema.Struct({
      message: TrimmedNonEmptyString,
    }),
  ),
});
export type WorkersListResult = typeof WorkersListResult.Type;

export const WorkersGetJobInput = Schema.Struct({
  jobId: TrimmedNonEmptyString,
});
export type WorkersGetJobInput = typeof WorkersGetJobInput.Type;

export const WorkersGetJobResult = Schema.Struct({
  readAt: IsoDateTime,
  job: Schema.Option(WorkersJobDetail),
  error: Schema.Option(
    Schema.Struct({
      message: TrimmedNonEmptyString,
    }),
  ),
});
export type WorkersGetJobResult = typeof WorkersGetJobResult.Type;
