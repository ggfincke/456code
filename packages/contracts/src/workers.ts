// packages/contracts/src/workers.ts
// read-model contract for the workers dashboard over local worker-broker state

import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

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
  stage: Schema.Option(TrimmedNonEmptyString),
  workflow: Schema.Option(TrimmedNonEmptyString),
  run: Schema.Option(TrimmedNonEmptyString),
  model: Schema.Option(TrimmedNonEmptyString),
  effort: Schema.Option(TrimmedNonEmptyString),
  error: Schema.Option(Schema.String),
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
  baseRef: Schema.Option(TrimmedNonEmptyString),
  baseSha: Schema.Option(TrimmedNonEmptyString),
  headSha: Schema.Option(TrimmedNonEmptyString),
  worktree: Schema.Option(TrimmedNonEmptyString),
  patchPath: Schema.Option(TrimmedNonEmptyString),
  summary: Schema.Option(Schema.String),
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

export const WorkersReadinessInput = Schema.Struct({});
export type WorkersReadinessInput = typeof WorkersReadinessInput.Type;

export const WorkersReadinessResult = Schema.Struct({
  stateDir: TrimmedNonEmptyString,
  stateDirExists: Schema.Boolean,
  brokerConfigured: Schema.Boolean,
  brokerConfigSource: Schema.Option(TrimmedNonEmptyString),
  message: Schema.Option(Schema.String),
});
export type WorkersReadinessResult = typeof WorkersReadinessResult.Type;

export const WorkersListInput = Schema.Struct({
  run: Schema.optional(TrimmedNonEmptyString),
});
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

export const WorkersRunStageRollup = Schema.Struct({
  stage: Schema.Option(TrimmedNonEmptyString),
  total: NonNegativeInt,
  queued: NonNegativeInt,
  running: NonNegativeInt,
  completed: NonNegativeInt,
  failed: NonNegativeInt,
  rejected: NonNegativeInt,
  cancelled: NonNegativeInt,
});
export type WorkersRunStageRollup = typeof WorkersRunStageRollup.Type;

export const WorkersRunSummary = Schema.Struct({
  run: TrimmedNonEmptyString,
  workflows: Schema.Array(TrimmedNonEmptyString),
  firstCreatedAt: Schema.Option(IsoDateTime),
  lastCompletedAt: Schema.Option(IsoDateTime),
  total: NonNegativeInt,
  queued: NonNegativeInt,
  running: NonNegativeInt,
  completed: NonNegativeInt,
  failed: NonNegativeInt,
  rejected: NonNegativeInt,
  cancelled: NonNegativeInt,
  stages: Schema.Array(WorkersRunStageRollup),
  scopeViolationCount: NonNegativeInt,
});
export type WorkersRunSummary = typeof WorkersRunSummary.Type;

export const WorkersListRunsInput = Schema.Struct({});
export type WorkersListRunsInput = typeof WorkersListRunsInput.Type;

export const WorkersListRunsResult = Schema.Struct({
  state: WorkersSnapshotState,
  stateDir: TrimmedNonEmptyString,
  readAt: IsoDateTime,
  runs: Schema.Array(WorkersRunSummary),
  skippedJobCount: NonNegativeInt,
  error: Schema.Option(
    Schema.Struct({
      message: TrimmedNonEmptyString,
    }),
  ),
});
export type WorkersListRunsResult = typeof WorkersListRunsResult.Type;

export const WorkersStatusSnapshot = Schema.Struct({
  list: WorkersListResult,
  runs: WorkersListRunsResult,
});
export type WorkersStatusSnapshot = typeof WorkersStatusSnapshot.Type;

export const WorkersGetRunInput = Schema.Struct({
  run: TrimmedNonEmptyString,
});
export type WorkersGetRunInput = typeof WorkersGetRunInput.Type;

export const WorkersGetRunResult = Schema.Struct({
  readAt: IsoDateTime,
  run: Schema.Option(WorkersRunSummary),
  jobs: Schema.Array(WorkersJobSummary),
  error: Schema.Option(
    Schema.Struct({
      message: TrimmedNonEmptyString,
    }),
  ),
});
export type WorkersGetRunResult = typeof WorkersGetRunResult.Type;

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

export const WorkersActivityPhase = Schema.Literals([
  "preparing",
  "working",
  "verifying",
  "finalizing",
]);
export type WorkersActivityPhase = typeof WorkersActivityPhase.Type;

export const WorkersActivityStatus = Schema.Literals(["started", "completed", "failed"]);
export type WorkersActivityStatus = typeof WorkersActivityStatus.Type;

const WorkersActivityEntryBase = {
  sequence: PositiveInt,
  recordedAt: IsoDateTime,
};

export const WorkersActivityPhaseEntry = Schema.Struct({
  ...WorkersActivityEntryBase,
  kind: Schema.Literal("phase"),
  phase: WorkersActivityPhase,
  status: WorkersActivityStatus,
});
export type WorkersActivityPhaseEntry = typeof WorkersActivityPhaseEntry.Type;

export const WorkersActivityMessageEntry = Schema.Struct({
  ...WorkersActivityEntryBase,
  kind: Schema.Literal("message"),
  summary: TrimmedNonEmptyString,
});
export type WorkersActivityMessageEntry = typeof WorkersActivityMessageEntry.Type;

export const WorkersActivityActionEntry = Schema.Struct({
  ...WorkersActivityEntryBase,
  kind: Schema.Literal("action"),
  status: WorkersActivityStatus,
});
export type WorkersActivityActionEntry = typeof WorkersActivityActionEntry.Type;

export const WorkersActivityEntry = Schema.Union([
  WorkersActivityPhaseEntry,
  WorkersActivityMessageEntry,
  WorkersActivityActionEntry,
]);
export type WorkersActivityEntry = typeof WorkersActivityEntry.Type;

export const WorkersActivityInput = Schema.Struct({
  jobId: TrimmedNonEmptyString,
});
export type WorkersActivityInput = typeof WorkersActivityInput.Type;

export const WorkersActivitySnapshot = Schema.Struct({
  jobId: TrimmedNonEmptyString,
  readAt: IsoDateTime,
  entries: Schema.Array(WorkersActivityEntry),
  skippedEntryCount: NonNegativeInt,
  truncated: Schema.Boolean,
  error: Schema.Option(
    Schema.Struct({
      message: TrimmedNonEmptyString,
    }),
  ),
});
export type WorkersActivitySnapshot = typeof WorkersActivitySnapshot.Type;
