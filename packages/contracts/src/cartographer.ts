// packages/contracts/src/cartographer.ts
// defines cartographer analysis and proposal-generation transports

import * as Schema from 'effect/Schema'

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from './baseSchemas.ts'
import { OrchestrationProposedPlanId } from './orchestration.ts'
import { ProposalGitObjectOid, ProposalId, ProposalRevisionId } from './proposal.ts'
import { ReviewDiffPreviewSourceKind } from './review.ts'

export const ProposalGenerationId = TrimmedNonEmptyString.pipe(Schema.brand('ProposalGenerationId'))
export type ProposalGenerationId = typeof ProposalGenerationId.Type

export const DiffAnalysisId = TrimmedNonEmptyString.pipe(Schema.brand('DiffAnalysisId'))
export type DiffAnalysisId = typeof DiffAnalysisId.Type

export const DiffAnalysisSourceKind = Schema.Literals([
  'checkpoint',
  'review',
  'tree-pair',
  'commit-pair',
])
export type DiffAnalysisSourceKind = typeof DiffAnalysisSourceKind.Type

export const DiffAnalysisSource = Schema.Union([
  Schema.Struct({
    sourceKind: Schema.Literal('checkpoint'),
    threadId: ThreadId,
    fromTurnCount: NonNegativeInt,
    toTurnCount: NonNegativeInt,
  }),
  Schema.Struct({
    sourceKind: Schema.Literal('review'),
    cwd: TrimmedNonEmptyString,
    kind: ReviewDiffPreviewSourceKind,
    baseRef: Schema.optionalKey(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    sourceKind: Schema.Literal('tree-pair'),
    cwd: TrimmedNonEmptyString,
    baseTreeOid: ProposalGitObjectOid,
    headTreeOid: ProposalGitObjectOid,
  }),
  Schema.Struct({
    sourceKind: Schema.Literal('commit-pair'),
    cwd: TrimmedNonEmptyString,
    baseCommitOid: ProposalGitObjectOid,
    headCommitOid: ProposalGitObjectOid,
  }),
])
export type DiffAnalysisSource = typeof DiffAnalysisSource.Type

export const DiffAnalysisOwner = Schema.Union([
  Schema.Struct({ threadId: ThreadId }),
  Schema.Struct({ projectId: ProjectId }),
])
export type DiffAnalysisOwner = typeof DiffAnalysisOwner.Type

export const DiffAnalysisState = Schema.Literals([
  'queued',
  'preparing',
  'analyzing',
  'ready',
  'failed',
  'cancelled',
  'abandoned',
])
export type DiffAnalysisState = typeof DiffAnalysisState.Type

export const DiffAnalysisErrorCode = Schema.Literals([
  'invalid-source',
  'thread-not-found',
  'workspace-path-missing',
  'repository-out-of-scope',
  'not-git-repository',
  'repository-identity-failed',
  'checkpoint-ref-missing',
  'base-ref-missing',
  'merge-base-missing',
  'tree-object-missing',
  'dirty-submodule',
  'unsupported',
  'limit-exceeded',
  'materialization-failed',
  'analysis-timeout',
  'analysis-failed',
  'analysis-manifest-invalid',
  'artifact-invalid',
  'request-cancelled',
  'server-restarted',
  'persistence-failed',
])
export type DiffAnalysisErrorCode = typeof DiffAnalysisErrorCode.Type

export const DiffAnalysisGeneration = Schema.Struct({
  version: Schema.Literal(1),
  diffAnalysisId: DiffAnalysisId,
  sourceKind: DiffAnalysisSourceKind,
  state: DiffAnalysisState,
  baseTreeOid: ProposalGitObjectOid,
  headTreeOid: ProposalGitObjectOid,
  analyzerVersion: TrimmedNonEmptyString,
  analysisPolicyVersion: TrimmedNonEmptyString,
  sourceCurrent: Schema.Boolean,
  baseGraphArtifact: Schema.NullOr(TrimmedNonEmptyString),
  headGraphArtifact: Schema.NullOr(TrimmedNonEmptyString),
  impactArtifact: Schema.NullOr(TrimmedNonEmptyString),
  artifactByteLength: NonNegativeInt,
  errorCode: Schema.NullOr(DiffAnalysisErrorCode),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastAccessedAt: IsoDateTime,
})
export type DiffAnalysisGeneration = typeof DiffAnalysisGeneration.Type

export const CartographerRequestDiffAnalysisInput = Schema.Struct({
  owner: DiffAnalysisOwner,
  source: DiffAnalysisSource,
})
export type CartographerRequestDiffAnalysisInput = typeof CartographerRequestDiffAnalysisInput.Type

export const CartographerGetDiffAnalysisInput = Schema.Struct({
  owner: DiffAnalysisOwner,
  source: DiffAnalysisSource,
  diffAnalysisId: Schema.optionalKey(DiffAnalysisId),
})
export type CartographerGetDiffAnalysisInput = typeof CartographerGetDiffAnalysisInput.Type

export class DiffAnalysisError extends Schema.TaggedErrorClass<DiffAnalysisError>()(
  'DiffAnalysisError',
  {
    code: DiffAnalysisErrorCode,
    message: TrimmedNonEmptyString,
    diffAnalysisId: Schema.optionalKey(DiffAnalysisId),
  },
)
{}

export const CartographerRebuildProjectAtlasInput = Schema.Struct({
  projectId: ProjectId,
})
export type CartographerRebuildProjectAtlasInput = typeof CartographerRebuildProjectAtlasInput.Type

export const CartographerPrepareCurrentWorktreeArchitectureInput = Schema.Struct({
  threadId: ThreadId,
})
export type CartographerPrepareCurrentWorktreeArchitectureInput =
  typeof CartographerPrepareCurrentWorktreeArchitectureInput.Type

export class CartographerError extends Schema.TaggedErrorClass<CartographerError>()(
  'CartographerError',
  {
    failure: Schema.Literals([
      'unsupported',
      'workspace_context_not_found',
      'generation_not_found',
      'snapshot_failed',
      'context_start_failed',
      'context_not_found',
      'diff_analysis_not_found',
    ]),
    message: TrimmedNonEmptyString,
  },
)
{}

export const ProposalGenerationState = Schema.Literals([
  'queued',
  'preparing',
  'analyzing',
  'ready',
  'failed',
  'cancelled',
  'abandoned',
])
export type ProposalGenerationState = typeof ProposalGenerationState.Type

export const ProposalGenerationAuthority = Schema.Literals(['authoritative', 'estimated'])
export type ProposalGenerationAuthority = typeof ProposalGenerationAuthority.Type

export const ProposalGenerationFreshness = Schema.Literals([
  'fresh',
  'base-changed',
  'worktree-changed',
  'analyzer-changed',
])
export type ProposalGenerationFreshness = typeof ProposalGenerationFreshness.Type

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
})
export type ProposalGeneration = typeof ProposalGeneration.Type

export const ProposalGenerationStartInput = Schema.Struct({
  threadId: ThreadId,
  proposalId: ProposalId,
  revision: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
})
export type ProposalGenerationStartInput = typeof ProposalGenerationStartInput.Type

export const ProposalGenerationGetInput = Schema.Struct({
  threadId: ThreadId,
  generationId: ProposalGenerationId,
})
export type ProposalGenerationGetInput = typeof ProposalGenerationGetInput.Type

export const ProposalGenerationLatestInput = Schema.Struct({
  threadId: ThreadId,
  proposalId: ProposalId,
  revision: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
})
export type ProposalGenerationLatestInput = typeof ProposalGenerationLatestInput.Type

export class ProposalGenerationError extends Schema.TaggedErrorClass<ProposalGenerationError>()(
  'ProposalGenerationError',
  {
    failure: Schema.Literals([
      'not-found',
      'scope-mismatch',
      'unsupported',
      'limit-exceeded',
      'materialization-failed',
      'analysis-failed',
      'persistence-failed',
    ]),
    message: TrimmedNonEmptyString,
  },
)
{}

export const ImplementationAttemptOutcome = Schema.Literals([
  'pending',
  'matched',
  'partial',
  'divergent',
])
export type ImplementationAttemptOutcome = typeof ImplementationAttemptOutcome.Type

export const ImplementationAttemptId = TrimmedNonEmptyString.pipe(
  Schema.brand('ImplementationAttemptId'),
)
export type ImplementationAttemptId = typeof ImplementationAttemptId.Type

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
})
export type ImplementationAttempt = typeof ImplementationAttempt.Type

export const ImplementationAttemptLatestInput = Schema.Struct({
  sourceThreadId: ThreadId,
  proposalId: ProposalId,
  revision: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
})
export type ImplementationAttemptLatestInput = typeof ImplementationAttemptLatestInput.Type
