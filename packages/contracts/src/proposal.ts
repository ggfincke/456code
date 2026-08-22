// packages/contracts/src/proposal.ts
// defines immutable proposal revisions and exact proposed file changes

import * as Schema from 'effect/Schema'

import {
  EnvironmentId,
  GitRefString,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from './baseSchemas.ts'
import {
  OrchestratePlanRevision,
  OrchestratePlanRunId,
  OrchestrationProposedPlanId,
} from './orchestration.ts'
import { ProviderInstanceId } from './providerInstance.ts'
import { ProjectReadMdxDocumentResult } from './mdx.ts'
import { PlannedImpactPublicationRef } from './plannedArchitectureImpact.ts'

export const PROPOSAL_MAX_OPERATIONS = 200
export const PROPOSAL_MAX_FILE_BYTES = 2 * 1024 * 1024
export const PROPOSAL_MAX_TOTAL_CONTENT_BYTES = 10 * 1024 * 1024
export const PROPOSAL_MAX_UNIFIED_DIFF_BYTES = 10 * 1024 * 1024
export const PROPOSAL_MAX_DIFF_OUTPUT_BYTES = 20 * 1024 * 1024
export const PROPOSAL_MAX_NARRATIVE_MDX_BYTES = 1024 * 1024
export const PROPOSAL_MAX_PATH_LENGTH = 1_024

export const ProposalId = TrimmedNonEmptyString.pipe(Schema.brand('ProposalId'))
export type ProposalId = typeof ProposalId.Type

export const ProposalRevisionId = TrimmedNonEmptyString.pipe(Schema.brand('ProposalRevisionId'))
export type ProposalRevisionId = typeof ProposalRevisionId.Type

export const ProposalSha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
export type ProposalSha256 = typeof ProposalSha256.Type

export const ProposalGitObjectOid = Schema.String.check(
  Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
)
export type ProposalGitObjectOid = typeof ProposalGitObjectOid.Type

export const ProposalFilePath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROPOSAL_MAX_PATH_LENGTH),
)
export type ProposalFilePath = typeof ProposalFilePath.Type

export const ProposalProducerIdentity = Schema.Struct({
  providerSessionId: TrimmedNonEmptyString,
  providerInstanceId: ProviderInstanceId,
})
export type ProposalProducerIdentity = typeof ProposalProducerIdentity.Type

export const ProposalFileContent = Schema.Struct({
  encoding: Schema.Literals(['utf8', 'base64']),
  data: Schema.String.check(Schema.isMaxLength(Math.ceil((PROPOSAL_MAX_FILE_BYTES * 4) / 3) + 4)),
})
export type ProposalFileContent = typeof ProposalFileContent.Type

const ProposalExecutableFlag = Schema.optionalKey(Schema.Boolean)

export const ProposalAddOperationInput = Schema.TaggedStruct('add', {
  path: ProposalFilePath,
  content: ProposalFileContent,
  executable: ProposalExecutableFlag,
})
export type ProposalAddOperationInput = typeof ProposalAddOperationInput.Type

export const ProposalModifyOperationInput = Schema.TaggedStruct('modify', {
  path: ProposalFilePath,
  beforeSha256: ProposalSha256,
  content: ProposalFileContent,
  executable: ProposalExecutableFlag,
})
export type ProposalModifyOperationInput = typeof ProposalModifyOperationInput.Type

export const ProposalDeleteOperationInput = Schema.TaggedStruct('delete', {
  path: ProposalFilePath,
  beforeSha256: ProposalSha256,
})
export type ProposalDeleteOperationInput = typeof ProposalDeleteOperationInput.Type

export const ProposalRenameOperationInput = Schema.TaggedStruct('rename', {
  fromPath: ProposalFilePath,
  toPath: ProposalFilePath,
  beforeSha256: ProposalSha256,
  content: Schema.optionalKey(ProposalFileContent),
  executable: ProposalExecutableFlag,
})
export type ProposalRenameOperationInput = typeof ProposalRenameOperationInput.Type

export const ProposalOperationInput = Schema.Union([
  ProposalAddOperationInput,
  ProposalModifyOperationInput,
  ProposalDeleteOperationInput,
  ProposalRenameOperationInput,
])
export type ProposalOperationInput = typeof ProposalOperationInput.Type

export const ProposalTypedChangeInput = Schema.TaggedStruct('typed', {
  operations: Schema.Array(ProposalOperationInput).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(PROPOSAL_MAX_OPERATIONS),
  ),
})
export type ProposalTypedChangeInput = typeof ProposalTypedChangeInput.Type

export const ProposalChangeInput = Schema.Union([
  ProposalTypedChangeInput,
  Schema.TaggedStruct('unified-diff', {
    diff: Schema.String.check(Schema.isMaxLength(PROPOSAL_MAX_UNIFIED_DIFF_BYTES)),
  }),
])
export type ProposalChangeInput = typeof ProposalChangeInput.Type

export const ProposalOrchestratePlanTarget = Schema.Struct({
  runId: OrchestratePlanRunId,
  revision: OrchestratePlanRevision.fields.revision,
})
export type ProposalOrchestratePlanTarget = typeof ProposalOrchestratePlanTarget.Type

export const ProposalPreviewUpsertInput = Schema.Struct({
  proposalId: Schema.optionalKey(ProposalId),
  changes: ProposalTypedChangeInput,
  orchestratePlan: Schema.optionalKey(ProposalOrchestratePlanTarget),
  narrativeMdx: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(PROPOSAL_MAX_NARRATIVE_MDX_BYTES)),
  ),
})
export type ProposalPreviewUpsertInput = typeof ProposalPreviewUpsertInput.Type

export const ProposalSnapshotPolicy = Schema.Struct({
  version: Schema.Literal('v1'),
  trackedContent: Schema.Literal('working-tree-bytes'),
  untrackedContent: Schema.Literal('include-unignored'),
  ignoredContent: Schema.Literal('omit'),
  staging: Schema.Literal('flattened'),
  submodules: Schema.Literal('reject-dirty'),
})
export type ProposalSnapshotPolicy = typeof ProposalSnapshotPolicy.Type

export const PROPOSAL_SNAPSHOT_POLICY_V1 = {
  version: 'v1',
  trackedContent: 'working-tree-bytes',
  untrackedContent: 'include-unignored',
  ignoredContent: 'omit',
  staging: 'flattened',
  submodules: 'reject-dirty',
} as const satisfies ProposalSnapshotPolicy

export const ProposalRepositoryIdentity = Schema.Union([
  Schema.TaggedStruct('git-remote', {
    canonicalKey: TrimmedNonEmptyString,
    remoteName: TrimmedNonEmptyString,
    remoteUrl: TrimmedNonEmptyString,
  }),
  Schema.TaggedStruct('local-git', {
    canonicalKey: TrimmedNonEmptyString,
  }),
])
export type ProposalRepositoryIdentity = typeof ProposalRepositoryIdentity.Type

export const ProposalWorktreeIdentity = Schema.Struct({
  rootPath: TrimmedNonEmptyString,
  gitDir: TrimmedNonEmptyString,
  gitCommonDir: TrimmedNonEmptyString,
})
export type ProposalWorktreeIdentity = typeof ProposalWorktreeIdentity.Type

export const ProposalBlobReference = Schema.Struct({
  sha256: ProposalSha256,
  byteLength: NonNegativeInt,
  gitBlobOid: ProposalGitObjectOid,
  mode: Schema.Literals(['100644', '100755']),
})
export type ProposalBlobReference = typeof ProposalBlobReference.Type

export const ProposalNormalizedOperation = Schema.Union([
  Schema.TaggedStruct('add', {
    path: ProposalFilePath,
    after: ProposalBlobReference,
  }),
  Schema.TaggedStruct('modify', {
    path: ProposalFilePath,
    before: ProposalBlobReference,
    after: ProposalBlobReference,
  }),
  Schema.TaggedStruct('delete', {
    path: ProposalFilePath,
    before: ProposalBlobReference,
  }),
  Schema.TaggedStruct('rename', {
    fromPath: ProposalFilePath,
    toPath: ProposalFilePath,
    before: ProposalBlobReference,
    after: ProposalBlobReference,
  }),
])
export type ProposalNormalizedOperation = typeof ProposalNormalizedOperation.Type

export const ProposalRevisionManifest = Schema.Struct({
  version: Schema.Literal('v1'),
  operations: Schema.Array(ProposalNormalizedOperation).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(PROPOSAL_MAX_OPERATIONS),
  ),
  operationCount: PositiveInt,
  changedFileCount: PositiveInt,
  changedContentBytes: NonNegativeInt,
})
export type ProposalRevisionManifest = typeof ProposalRevisionManifest.Type

export const ProposalBaseSnapshot = Schema.Struct({
  headCommitOid: ProposalGitObjectOid,
  workingTreeOid: ProposalGitObjectOid,
  retainedRef: GitRefString,
  fileCount: NonNegativeInt,
  byteCount: NonNegativeInt,
  policy: ProposalSnapshotPolicy,
})
export type ProposalBaseSnapshot = typeof ProposalBaseSnapshot.Type

export const ProposalRevision = Schema.Struct({
  proposalId: ProposalId,
  revisionId: ProposalRevisionId,
  revision: PositiveInt,
  baseSnapshot: ProposalBaseSnapshot,
  proposedTreeOid: ProposalGitObjectOid,
  proposedRetainedRef: GitRefString,
  manifest: ProposalRevisionManifest,
  manifestSha256: ProposalSha256,
  diffSha256: ProposalSha256,
  diffByteLength: NonNegativeInt,
  narrativeSha256: Schema.optionalKey(ProposalSha256),
  narrativeByteLength: Schema.optionalKey(NonNegativeInt),
  planId: Schema.optionalKey(OrchestrationProposedPlanId),
  planMarkdownSha256: Schema.optionalKey(ProposalSha256),
  plannedImpactRef: Schema.optionalKey(PlannedImpactPublicationRef),
  createdAt: IsoDateTime,
})
export type ProposalRevision = typeof ProposalRevision.Type

export const Proposal = Schema.Struct({
  proposalId: ProposalId,
  environmentId: EnvironmentId,
  projectId: ProjectId,
  sourceThreadId: ThreadId,
  producer: ProposalProducerIdentity,
  repository: ProposalRepositoryIdentity,
  worktree: ProposalWorktreeIdentity,
  latestRevision: PositiveInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
})
export type Proposal = typeof Proposal.Type

export const ProposalListInput = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
  sourceThreadId: Schema.optionalKey(ThreadId),
})
export type ProposalListInput = typeof ProposalListInput.Type

export const ProposalListResult = Schema.Struct({
  proposals: Schema.Array(Proposal),
})
export type ProposalListResult = typeof ProposalListResult.Type

export const ProposalRevisionSelector = Schema.Struct({
  proposalId: ProposalId,
  revision: Schema.optionalKey(PositiveInt),
})
export type ProposalRevisionSelector = typeof ProposalRevisionSelector.Type

export const ProposalGetResult = Schema.Struct({
  proposal: Proposal,
  revision: ProposalRevision,
  revisions: Schema.Array(ProposalRevision),
})
export type ProposalGetResult = typeof ProposalGetResult.Type

export const ProposalDiffResult = Schema.Struct({
  proposalId: ProposalId,
  revisionId: ProposalRevisionId,
  revision: PositiveInt,
  diff: Schema.String,
  diffSha256: ProposalSha256,
})
export type ProposalDiffResult = typeof ProposalDiffResult.Type

export const ProposalNarrativeResult = Schema.Struct({
  proposalId: ProposalId,
  revisionId: ProposalRevisionId,
  revision: PositiveInt,
  source: Schema.String,
  sourceSha256: ProposalSha256,
})
export type ProposalNarrativeResult = typeof ProposalNarrativeResult.Type

export const ProposalNarrativeDocumentResult = Schema.Struct({
  proposalId: ProposalId,
  revisionId: ProposalRevisionId,
  revision: PositiveInt,
  sourceSha256: ProposalSha256,
  document: ProjectReadMdxDocumentResult,
})
export type ProposalNarrativeDocumentResult = typeof ProposalNarrativeDocumentResult.Type

export const ProposalPlanLookupInput = Schema.Struct({
  sourceThreadId: ThreadId,
  planId: OrchestrationProposedPlanId,
})
export type ProposalPlanLookupInput = typeof ProposalPlanLookupInput.Type

export const ProposalPlanLookupResult = Schema.Struct({
  proposal: Proposal,
  revision: ProposalRevision,
})
export type ProposalPlanLookupResult = typeof ProposalPlanLookupResult.Type

export const ProposalOrchestratePlanLink = Schema.Struct({
  proposalId: ProposalId,
  proposalRevision: PositiveInt,
  sourceThreadId: ThreadId,
  runId: OrchestratePlanRunId,
  revision: OrchestratePlanRevision.fields.revision,
  createdAt: IsoDateTime,
})
export type ProposalOrchestratePlanLink = typeof ProposalOrchestratePlanLink.Type

export const ProposalOrchestratePlanLookupInput = Schema.Struct({
  sourceThreadId: ThreadId,
  runId: OrchestratePlanRunId,
  revision: OrchestratePlanRevision.fields.revision,
})
export type ProposalOrchestratePlanLookupInput = typeof ProposalOrchestratePlanLookupInput.Type

export const ProposalOrchestratePlanLookupResult = Schema.Struct({
  link: ProposalOrchestratePlanLink,
  proposal: Proposal,
  revision: ProposalRevision,
  orchestratePlan: OrchestratePlanRevision,
})
export type ProposalOrchestratePlanLookupResult = typeof ProposalOrchestratePlanLookupResult.Type

export const ProposalFailureCode = Schema.Literals([
  'not-git-repository',
  'missing-head',
  'dirty-submodule',
  'repository-identity-failed',
  'invalid-path',
  'limit-exceeded',
  'path-exists',
  'path-missing',
  'before-hash-mismatch',
  'unsupported-file-mode',
  'invalid-patch',
  'empty-change',
  'git-failed',
  'analyzer-unavailable',
  'persistence-failed',
  'not-found',
  'identity-mismatch',
])
export type ProposalFailureCode = typeof ProposalFailureCode.Type

export class ProposalError extends Schema.TaggedErrorClass<ProposalError>()('ProposalError', {
  operation: TrimmedNonEmptyString,
  code: ProposalFailureCode,
  detail: TrimmedNonEmptyString,
  proposalId: Schema.optionalKey(ProposalId),
  path: Schema.optionalKey(ProposalFilePath),
})
{
  override get message(): string
  {
    return `${this.operation}: ${this.detail}`
  }
}
