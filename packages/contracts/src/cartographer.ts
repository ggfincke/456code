// packages/contracts/src/cartographer.ts
// defines authenticated cartographer embed and analysis transports

import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString, TurnId } from "./baseSchemas.ts";
import { OrchestrationProposedPlanId } from "./orchestration.ts";
import { ProposalId, ProposalRevisionId } from "./proposal.ts";

export const CartographerEmbedSessionId = TrimmedNonEmptyString.pipe(
  Schema.brand("CartographerEmbedSessionId"),
);
export type CartographerEmbedSessionId = typeof CartographerEmbedSessionId.Type;

export const ProposalGenerationId = TrimmedNonEmptyString.pipe(
  Schema.brand("ProposalGenerationId"),
);
export type ProposalGenerationId = typeof ProposalGenerationId.Type;

export const CartographerIssueEmbedInput = Schema.Struct({
  threadId: ThreadId,
  generationId: Schema.optionalKey(ProposalGenerationId),
  parentOrigin: TrimmedNonEmptyString,
  theme: Schema.Literals(["light", "dark"]),
});
export type CartographerIssueEmbedInput = typeof CartographerIssueEmbedInput.Type;

export const CartographerCloseEmbedInput = Schema.Struct({
  threadId: ThreadId,
  sessionId: CartographerEmbedSessionId,
});
export type CartographerCloseEmbedInput = typeof CartographerCloseEmbedInput.Type;

export const CartographerIssueEmbedResult = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: CartographerEmbedSessionId,
  url: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
});
export type CartographerIssueEmbedResult = typeof CartographerIssueEmbedResult.Type;

export class CartographerEmbedError extends Schema.TaggedErrorClass<CartographerEmbedError>()(
  "CartographerEmbedError",
  {
    failure: Schema.Literals([
      "unsupported",
      "workspace_context_not_found",
      "generation_not_found",
      "start_failed",
      "invalid_handshake",
      "session_not_found",
      "ticket_invalid",
      "proxy_failed",
    ]),
    message: TrimmedNonEmptyString,
  },
) {}

export const ProposalGenerationState = Schema.Literals([
  "queued",
  "preparing",
  "analyzing",
  "ready",
  "failed",
  "cancelled",
  "abandoned",
]);
export type ProposalGenerationState = typeof ProposalGenerationState.Type;

export const ProposalGenerationAuthority = Schema.Literals(["authoritative", "estimated"]);
export type ProposalGenerationAuthority = typeof ProposalGenerationAuthority.Type;

export const ProposalGenerationFreshness = Schema.Literals([
  "fresh",
  "base-changed",
  "worktree-changed",
  "analyzer-changed",
]);
export type ProposalGenerationFreshness = typeof ProposalGenerationFreshness.Type;

export const ProposalGeneration = Schema.Struct({
  generationId: ProposalGenerationId,
  proposalId: ProposalId,
  revisionId: ProposalRevisionId,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  threadId: ThreadId,
  state: ProposalGenerationState,
  authority: ProposalGenerationAuthority,
  freshness: ProposalGenerationFreshness,
  workspaceSnapshotTreeOid: TrimmedNonEmptyString,
  analyzerVersion: TrimmedNonEmptyString,
  baseGraphArtifact: Schema.NullOr(TrimmedNonEmptyString),
  proposedGraphArtifact: Schema.NullOr(TrimmedNonEmptyString),
  impactArtifact: Schema.NullOr(TrimmedNonEmptyString),
  errorCode: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProposalGeneration = typeof ProposalGeneration.Type;

export const ProposalGenerationStartInput = Schema.Struct({
  threadId: ThreadId,
  proposalId: ProposalId,
  revision: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
});
export type ProposalGenerationStartInput = typeof ProposalGenerationStartInput.Type;

export const ProposalGenerationGetInput = Schema.Struct({
  threadId: ThreadId,
  generationId: ProposalGenerationId,
});
export type ProposalGenerationGetInput = typeof ProposalGenerationGetInput.Type;

export const ProposalGenerationLatestInput = Schema.Struct({
  threadId: ThreadId,
  proposalId: ProposalId,
  revision: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
});
export type ProposalGenerationLatestInput = typeof ProposalGenerationLatestInput.Type;

export class ProposalGenerationError extends Schema.TaggedErrorClass<ProposalGenerationError>()(
  "ProposalGenerationError",
  {
    failure: Schema.Literals([
      "not-found",
      "scope-mismatch",
      "unsupported",
      "limit-exceeded",
      "materialization-failed",
      "analysis-failed",
      "persistence-failed",
    ]),
    message: TrimmedNonEmptyString,
  },
) {}

export const ImplementationAttemptOutcome = Schema.Literals([
  "pending",
  "matched",
  "partial",
  "divergent",
]);
export type ImplementationAttemptOutcome = typeof ImplementationAttemptOutcome.Type;

export const ImplementationAttemptId = TrimmedNonEmptyString.pipe(
  Schema.brand("ImplementationAttemptId"),
);
export type ImplementationAttemptId = typeof ImplementationAttemptId.Type;

export const ImplementationAttempt = Schema.Struct({
  attemptId: ImplementationAttemptId,
  proposalId: ProposalId,
  revisionId: ProposalRevisionId,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  sourceThreadId: ThreadId,
  implementationThreadId: ThreadId,
  implementationTurnId: TurnId,
  planId: OrchestrationProposedPlanId,
  baselineTreeOid: TrimmedNonEmptyString,
  actualTreeOid: Schema.NullOr(TrimmedNonEmptyString),
  outcome: ImplementationAttemptOutcome,
  matchedOperationCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  intendedOperationCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  createdAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
});
export type ImplementationAttempt = typeof ImplementationAttempt.Type;

export const ImplementationAttemptLatestInput = Schema.Struct({
  sourceThreadId: ThreadId,
  proposalId: ProposalId,
  revision: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
});
export type ImplementationAttemptLatestInput = typeof ImplementationAttemptLatestInput.Type;
