// apps/server/src/orchestration/Errors.ts
// define orchestration errors

import { NonNegativeInt, ThreadId } from '@t3tools/contracts'
import * as SchemaIssue from 'effect/SchemaIssue'
import * as Schema from 'effect/Schema'

import type { CheckpointStoreError } from '../checkpointing/Errors.ts'
import type { ProjectionRepositoryError } from '../persistence/Errors.ts'

export const CheckpointDiffOperation = Schema.Literals([
  'CheckpointDiffQuery.getTurnDiff',
  'CheckpointDiffQuery.getFullThreadDiff',
])
export type CheckpointDiffOperation = typeof CheckpointDiffOperation.Type

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
    const result =
      this.operation === 'CheckpointDiffQuery.getTurnDiff' ? 'turn diff' : 'full thread diff'
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
    const diff =
      this.operation === 'CheckpointDiffQuery.getTurnDiff' ? 'turn diff' : 'full thread diff'
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

export type CheckpointDiffQueryError =
  | CheckpointStoreError
  | ProjectionRepositoryError
  | CheckpointDiffResultInvalidError
  | CheckpointThreadNotFoundError
  | CheckpointWorkspacePathMissingError
  | CheckpointTurnRangeUnavailableError
  | CheckpointRefUnavailableError

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
