// apps/server/src/orchestration/Services/CheckpointDiffQuery.ts
// defines orchestration checkpoint diff query contracts

import type {
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetTurnDiffInput,
  OrchestrationGetTurnDiffResult,
} from '@t3tools/contracts'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'

import type { CheckpointDiffQueryError } from '../Errors.ts'

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
  }
>()('456code/orchestration/Services/CheckpointDiffQuery')
{}
