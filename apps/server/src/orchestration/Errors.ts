// apps/server/src/orchestration/Errors.ts
// define orchestration errors

import {
  type GitCommandError,
  NonNegativeInt,
  OrchestratePlanRunId,
  ThreadId,
  TrimmedNonEmptyString,
} from '@t3tools/contracts'
import * as SchemaIssue from 'effect/SchemaIssue'
import * as Schema from 'effect/Schema'

import type { CheckpointStoreError } from '../checkpointing/Errors.ts'
import type {
  CheckpointIdentityError,
  RepositoryRevisionIdentityError,
} from '../checkpointing/CheckpointIdentity.ts'
import type { ProjectionRepositoryError } from '../persistence/Errors.ts'

export const CheckpointDiffOperation = Schema.Literals([
  'CheckpointDiffQuery.getTurnDiff',
  'CheckpointDiffQuery.getFullThreadDiff',
  'CheckpointDiffQuery.getRunDiff',
  'CheckpointDiffQuery.getRunExecutionDiffV1',
])
export type CheckpointDiffOperation = typeof CheckpointDiffOperation.Type

// * every operation literal needs an entry here. the two messages below used to
// pick a label with a binary ternary, so any operation that was not getTurnDiff
// reported itself as a full thread diff
const DIFF_KIND_LABEL: Record<CheckpointDiffOperation, string> = {
  'CheckpointDiffQuery.getTurnDiff': 'turn diff',
  'CheckpointDiffQuery.getFullThreadDiff': 'full thread diff',
  'CheckpointDiffQuery.getRunDiff': 'run diff',
  'CheckpointDiffQuery.getRunExecutionDiffV1': 'exact run execution diff',
}

/** The computed result does not satisfy the checkpoint RPC contract. */
export class CheckpointDiffResultInvalidError extends Schema.TaggedErrorClass<CheckpointDiffResultInvalidError>()(
  'CheckpointDiffResultInvalidError',
  {
    operation: CheckpointDiffOperation,
    threadId: ThreadId,
  },
)
{
  override get message(): string
  {
    const result = DIFF_KIND_LABEL[this.operation]
    return `Checkpoint invariant violation in ${this.operation}: Computed ${result} result does not satisfy contract schema.`
  }
}

/** Projection state no longer contains the requested checkpoint thread. */
export class CheckpointThreadNotFoundError extends Schema.TaggedErrorClass<CheckpointThreadNotFoundError>()(
  'CheckpointThreadNotFoundError',
  {
    operation: CheckpointDiffOperation,
    threadId: ThreadId,
  },
)
{
  override get message(): string
  {
    return `Checkpoint invariant violation in ${this.operation}: Thread '${this.threadId}' not found.`
  }
}

/** The checkpoint thread has no workspace path from which to compute a diff. */
export class CheckpointWorkspacePathMissingError extends Schema.TaggedErrorClass<CheckpointWorkspacePathMissingError>()(
  'CheckpointWorkspacePathMissingError',
  {
    operation: CheckpointDiffOperation,
    threadId: ThreadId,
  },
)
{
  override get message(): string
  {
    const diff = DIFF_KIND_LABEL[this.operation]
    return `Checkpoint invariant violation in ${this.operation}: Workspace path missing for thread '${this.threadId}' when computing ${diff}.`
  }
}

/** The requested turn lies beyond the latest available checkpoint. */
export class CheckpointTurnRangeUnavailableError extends Schema.TaggedErrorClass<CheckpointTurnRangeUnavailableError>()(
  'CheckpointTurnRangeUnavailableError',
  {
    operation: CheckpointDiffOperation,
    threadId: ThreadId,
    requestedTurnCount: NonNegativeInt,
    availableTurnCount: NonNegativeInt,
  },
)
{
  override get message(): string
  {
    return `Checkpoint unavailable for thread ${this.threadId} turn ${this.requestedTurnCount}: Turn diff range exceeds current turn count: requested ${this.requestedTurnCount}, current ${this.availableTurnCount}.`
  }
}

/** Expected checkpoint metadata does not contain the requested Git ref. */
export class CheckpointRefUnavailableError extends Schema.TaggedErrorClass<CheckpointRefUnavailableError>()(
  'CheckpointRefUnavailableError',
  {
    operation: CheckpointDiffOperation,
    threadId: ThreadId,
    turnCount: NonNegativeInt,
    checkpoint: Schema.Literals(['from', 'to']),
  },
)
{
  override get message(): string
  {
    return `Checkpoint unavailable for thread ${this.threadId} turn ${this.turnCount}: Checkpoint ref is unavailable for turn ${this.turnCount}.`
  }
}

/** The worktree recorded as the run's integration tree no longer resolves. */
export class CheckpointRunIntegrationUnavailableError extends Schema.TaggedErrorClass<CheckpointRunIntegrationUnavailableError>()(
  'CheckpointRunIntegrationUnavailableError',
  {
    operation: CheckpointDiffOperation,
    threadId: ThreadId,
    worktreePath: Schema.String,
  },
)
{
  override get message(): string
  {
    return `Checkpoint unavailable for thread ${this.threadId}: Recorded run worktree '${this.worktreePath}' is no longer a repository.`
  }
}

/** No base commit could be resolved for the run's integration branch. */
export class CheckpointRunBaseUnavailableError extends Schema.TaggedErrorClass<CheckpointRunBaseUnavailableError>()(
  'CheckpointRunBaseUnavailableError',
  {
    operation: CheckpointDiffOperation,
    threadId: ThreadId,
    branch: Schema.NullOr(TrimmedNonEmptyString),
    detail: Schema.String,
  },
)
{
  override get message(): string
  {
    const branch = this.branch ?? 'a detached HEAD'
    return `Checkpoint unavailable for thread ${this.threadId}: Could not resolve a base commit for ${branch}: ${this.detail}`
  }
}

export type CheckpointDiffQueryError =
  | CheckpointStoreError
  | GitCommandError
  | CheckpointIdentityError
  | ProjectionRepositoryError
  | CheckpointDiffResultInvalidError
  | CheckpointThreadNotFoundError
  | CheckpointWorkspacePathMissingError
  | CheckpointTurnRangeUnavailableError
  | CheckpointRefUnavailableError

// the run diff reaches into the adopted worktree with raw git rather than
// through the checkpoint store, so it can also fail with GitCommandError. kept
// separate from CheckpointDiffQueryError so the two checkpoint-backed diffs
// keep their narrower failure set
export type CheckpointRunDiffQueryError =
  | CheckpointDiffQueryError
  | GitCommandError
  | CheckpointRunIntegrationUnavailableError
  | CheckpointRunBaseUnavailableError

export class CheckpointRunExecutionNotFoundError extends Schema.TaggedErrorClass<CheckpointRunExecutionNotFoundError>()(
  'CheckpointRunExecutionNotFoundError',
  {
    operation: Schema.Literal('CheckpointDiffQuery.getRunExecutionDiffV1'),
    threadId: ThreadId,
    runId: OrchestratePlanRunId,
    planRevision: NonNegativeInt,
  },
)
{
  override get message(): string
  {
    return (
      `Authoritative execution '${this.runId}/${this.planRevision}' was not found for ` +
      `thread '${this.threadId}'.`
    )
  }
}

export class CheckpointRunExecutionHeadUnavailableError extends Schema.TaggedErrorClass<CheckpointRunExecutionHeadUnavailableError>()(
  'CheckpointRunExecutionHeadUnavailableError',
  {
    operation: Schema.Literal('CheckpointDiffQuery.getRunExecutionDiffV1'),
    threadId: ThreadId,
    runId: OrchestratePlanRunId,
    planRevision: NonNegativeInt,
  },
)
{
  override get message(): string
  {
    return (
      `Execution '${this.runId}/${this.planRevision}' has no verified observed or final head OID. ` +
      'An unbound broker record cannot authorize a run diff.'
    )
  }
}

export type CheckpointRunExecutionDiffQueryError =
  | GitCommandError
  | ProjectionRepositoryError
  | RepositoryRevisionIdentityError
  | CheckpointRunExecutionNotFoundError
  | CheckpointRunExecutionHeadUnavailableError

export class OrchestrationCommandJsonParseError extends Schema.TaggedErrorClass<OrchestrationCommandJsonParseError>()(
  'OrchestrationCommandJsonParseError',
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
)
{
  override get message(): string
  {
    return `Invalid orchestration command JSON: ${this.detail}`
  }
}

export class OrchestrationCommandDecodeError extends Schema.TaggedErrorClass<OrchestrationCommandDecodeError>()(
  'OrchestrationCommandDecodeError',
  {
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
)
{
  override get message(): string
  {
    return `Invalid orchestration command payload: ${this.issue}`
  }
}

export class OrchestrationCommandInvariantError extends Schema.TaggedErrorClass<OrchestrationCommandInvariantError>()(
  'OrchestrationCommandInvariantError',
  {
    commandType: Schema.String,
    detail: Schema.String,
    code: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
)
{
  override get message(): string
  {
    return `Orchestration command invariant failed (${this.commandType}): ${this.detail}`
  }
}

export class OrchestrationCommandPreviouslyRejectedError extends Schema.TaggedErrorClass<OrchestrationCommandPreviouslyRejectedError>()(
  'OrchestrationCommandPreviouslyRejectedError',
  {
    commandId: Schema.String,
    detail: Schema.String,
    code: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
)
{
  override get message(): string
  {
    return `Command previously rejected (${this.commandId}): ${this.detail}`
  }
}

export class OrchestrationCommandIdConflictError extends Schema.TaggedErrorClass<OrchestrationCommandIdConflictError>()(
  'OrchestrationCommandIdConflictError',
  {
    commandId: Schema.String,
    receiptAggregateKind: Schema.String,
    receiptAggregateId: Schema.String,
    commandAggregateKind: Schema.String,
    commandAggregateId: Schema.String,
  },
)
{
  override get message(): string
  {
    return `Command id '${this.commandId}' already used for ${this.receiptAggregateKind} '${this.receiptAggregateId}'; refusing to replay its receipt for ${this.commandAggregateKind} '${this.commandAggregateId}'.`
  }
}

export class OrchestrationProjectorDecodeError extends Schema.TaggedErrorClass<OrchestrationProjectorDecodeError>()(
  'OrchestrationProjectorDecodeError',
  {
    eventType: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
)
{
  override get message(): string
  {
    return `Projector decode failed for ${this.eventType}: ${this.issue}`
  }
}

export class OrchestrationListenerCallbackError extends Schema.TaggedErrorClass<OrchestrationListenerCallbackError>()(
  'OrchestrationListenerCallbackError',
  {
    listener: Schema.Literals(['read-model', 'domain-event']),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
)
{
  override get message(): string
  {
    return `Orchestration ${this.listener} listener failed: ${this.detail}`
  }
}

export type OrchestrationDispatchError =
  | ProjectionRepositoryError
  | OrchestrationCommandInvariantError
  | OrchestrationCommandIdConflictError
  | OrchestrationCommandPreviouslyRejectedError
  | OrchestrationProjectorDecodeError
  | OrchestrationListenerCallbackError

export type OrchestrationEngineError =
  OrchestrationDispatchError | OrchestrationCommandJsonParseError | OrchestrationCommandDecodeError

export function toOrchestrationCommandDecodeError(error: Schema.SchemaError)
{
  return new OrchestrationCommandDecodeError({
    issue: SchemaIssue.makeFormatterDefault()(error.issue),
    cause: error,
  })
}

export function toProjectorDecodeError(eventType: string)
{
  return (error: Schema.SchemaError): OrchestrationProjectorDecodeError =>
    new OrchestrationProjectorDecodeError({
      eventType,
      issue: SchemaIssue.makeFormatterDefault()(error.issue),
      cause: error,
    })
}

export function toOrchestrationJsonParseError(cause: unknown)
{
  return new OrchestrationCommandJsonParseError({
    detail: `Failed to parse orchestration command JSON`,
    cause,
  })
}

export function toListenerCallbackError(listener: 'read-model' | 'domain-event')
{
  return (cause: unknown): OrchestrationListenerCallbackError =>
    new OrchestrationListenerCallbackError({
      listener,
      detail: `Failed to invoke orchestration ${listener} listener`,
      cause,
    })
}
