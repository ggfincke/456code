// apps/server/src/orchestration/Services/CheckpointDiffQuery.ts
// defines orchestration checkpoint diff query contracts

import type {
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetRunDiffInput,
  OrchestrationGetRunDiffResult,
  OrchestrationGetRunExecutionDiffV1Input,
  OrchestrationGetRunExecutionDiffV1Result,
  OrchestrationGetTurnDiffInput,
  OrchestrationGetTurnDiffResult,
} from '@t3tools/contracts'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'

import type {
  CheckpointDiffQueryError,
  CheckpointRunDiffQueryError,
  CheckpointRunExecutionDiffQueryError,
} from '../Errors.ts'

/** Reads checkpoint diffs through orchestration projection state. */
export class CheckpointDiffQuery extends Context.Service<
  CheckpointDiffQuery,
  {
    readonly getTurnDiff: (
      input: OrchestrationGetTurnDiffInput,
    ) => Effect.Effect<OrchestrationGetTurnDiffResult, CheckpointDiffQueryError>
    readonly getFullThreadDiff: (
      input: OrchestrationGetFullThreadDiffInput,
    ) => Effect.Effect<OrchestrationGetFullThreadDiffResult, CheckpointDiffQueryError>
    // reads the whole integration branch of the thread's adopted run worktree
    // against its fork point. this is the diff of the adopted tree, not of the
    // run: adoption picks one root and never re-chooses, so a run spanning two
    // sibling worktrees reports only the one that was adopted
    readonly getRunDiff: (
      input: OrchestrationGetRunDiffInput,
    ) => Effect.Effect<OrchestrationGetRunDiffResult, CheckpointRunDiffQueryError>
    readonly getRunExecutionDiffV1: (
      input: OrchestrationGetRunExecutionDiffV1Input,
    ) => Effect.Effect<
      OrchestrationGetRunExecutionDiffV1Result,
      CheckpointRunExecutionDiffQueryError
    >
  }
>()('456code/orchestration/Services/CheckpointDiffQuery')
{}
