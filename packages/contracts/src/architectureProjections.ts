// packages/contracts/src/architectureProjections.ts
// defines generation-bound native architecture projection transports

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
import { DiffAnalysisId, ProposalGenerationId } from './cartographer.ts'
import { ArchitectureRelativePath } from './architecturePath.ts'
import {
  ArchitecturePlannedImpactPlanIdentity,
  PlannedImpactPublicationRef,
  PlannedImpactProjectionRef,
} from './plannedArchitectureImpact.ts'
import { ProposalGitObjectOid, ProposalId, ProposalRevisionId } from './proposal.ts'
import { ArchitectureComparisonSelector } from './architectureTools.ts'

export const ARCHITECTURE_PROJECTION_EDGE_LIMIT = 400
export const ARCHITECTURE_PROJECTION_FILE_LIMIT = 100
export const ARCHITECTURE_SOURCE_MAX_BYTES = 2 * 1024 * 1024
export const ARCHITECTURE_GRAPH_PROJECTION_NODE_LIMIT = 60
export const ARCHITECTURE_GRAPH_PROJECTION_EDGE_LIMIT = 120
export const ARCHITECTURE_GRAPH_PROJECTION_EVIDENCE_LIMIT = 200
export const ARCHITECTURE_GRAPH_PROJECTION_EVIDENCE_PATH_LIMIT = 25
export const ARCHITECTURE_GRAPH_PROJECTION_EVIDENCE_PATH_REF_LIMIT = 50
export const ARCHITECTURE_GRAPH_PROJECTION_ANCHOR_LIMIT = 180

export const ArchitectureGenerationId = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isPattern(/^[0-9a-f]{64}$/u),
)
export type ArchitectureGenerationId = typeof ArchitectureGenerationId.Type

export const ArchitectureGraphDigest = Schema.String.check(
  Schema.isPattern(/^sha256:[0-9a-f]{64}$/u),
)
export type ArchitectureGraphDigest = typeof ArchitectureGraphDigest.Type

export const ArchitectureSourceDigest = Schema.String.check(
  Schema.isPattern(/^sha256:[0-9a-f]{64}$/u),
)
export type ArchitectureSourceDigest = typeof ArchitectureSourceDigest.Type

export { ArchitectureRelativePath }

export const ArchitectureProposalSource = Schema.Struct({
  kind: Schema.Literal('proposal-generation'),
  threadId: ThreadId,
  generationId: ProposalGenerationId,
  side: Schema.Literals(['base', 'proposed']),
  graphDigest: ArchitectureGraphDigest,
})
export type ArchitectureProposalSource = typeof ArchitectureProposalSource.Type

export const ArchitectureDiffSource = Schema.Struct({
  kind: Schema.Literal('diff-analysis'),
  threadId: ThreadId,
  diffAnalysisId: DiffAnalysisId,
  side: Schema.Literals(['base', 'head']),
  graphDigest: ArchitectureGraphDigest,
})
export type ArchitectureDiffSource = typeof ArchitectureDiffSource.Type

export const ArchitectureStandingSource = Schema.Struct({
  kind: Schema.Literal('standing-project-generation'),
  projectId: ProjectId,
  generationId: ArchitectureGenerationId,
  side: Schema.Literal('analyzed'),
  graphDigest: ArchitectureGraphDigest,
})
export type ArchitectureStandingSource = typeof ArchitectureStandingSource.Type

export const ArchitectureProjectionSource = Schema.Union([
  ArchitectureProposalSource,
  ArchitectureDiffSource,
  ArchitectureStandingSource,
])
export type ArchitectureProjectionSource = typeof ArchitectureProjectionSource.Type

const ArchitectureGraphProjectionId = TrimmedNonEmptyString.check(Schema.isMaxLength(1_280))
const ArchitectureGraphProjectionLabel = TrimmedNonEmptyString.check(Schema.isMaxLength(4_000))
const ArchitectureGraphProjectionReference = TrimmedNonEmptyString.check(Schema.isMaxLength(1_280))

export const ArchitectureGraphProjectionSemanticLevel = Schema.Literals([
  'systems',
  'blocks',
  'dirs',
  'files',
])
export type ArchitectureGraphProjectionSemanticLevel =
  typeof ArchitectureGraphProjectionSemanticLevel.Type

export const ArchitectureGraphProjectionState = Schema.Literals([
  'added',
  'removed',
  'affected',
  'context',
])
export type ArchitectureGraphProjectionState = typeof ArchitectureGraphProjectionState.Type

export const ArchitectureGraphProjectionExactCount = Schema.Struct({
  total: NonNegativeInt,
  returned: NonNegativeInt,
  omitted: NonNegativeInt,
}).check(
  Schema.makeFilter((value) =>
    value.total === value.returned + value.omitted
      ? true
      : 'Projection total must equal returned plus omitted.',
  ),
)
export type ArchitectureGraphProjectionExactCount =
  typeof ArchitectureGraphProjectionExactCount.Type

export const ArchitecturePlannedProjectionSource = Schema.Struct({
  kind: Schema.Literal('planned-impact'),
  environmentId: EnvironmentId,
  projectId: ProjectId,
  threadId: ThreadId,
  plan: ArchitecturePlannedImpactPlanIdentity,
  publication: PlannedImpactPublicationRef,
  projection: PlannedImpactProjectionRef,
})
export type ArchitecturePlannedProjectionSource = typeof ArchitecturePlannedProjectionSource.Type

export const ArchitectureVerifiedProposalProjectionSource = Schema.Struct({
  kind: Schema.Literal('verified-proposal-impact'),
  threadId: ThreadId,
  generationId: ProposalGenerationId,
  proposalId: ProposalId,
  revisionId: ProposalRevisionId,
  baseTreeOid: ProposalGitObjectOid,
  headTreeOid: ProposalGitObjectOid,
  baseGraphDigest: ArchitectureGraphDigest,
  headGraphDigest: ArchitectureGraphDigest,
  projectionDigest: ArchitectureSourceDigest,
})
export type ArchitectureVerifiedProposalProjectionSource =
  typeof ArchitectureVerifiedProposalProjectionSource.Type

export const ArchitectureVerifiedDiffProjectionSource = Schema.Struct({
  kind: Schema.Literal('verified-diff-impact'),
  threadId: ThreadId,
  diffAnalysisId: DiffAnalysisId,
  baseTreeOid: ProposalGitObjectOid,
  headTreeOid: ProposalGitObjectOid,
  baseGraphDigest: ArchitectureGraphDigest,
  headGraphDigest: ArchitectureGraphDigest,
  projectionDigest: ArchitectureSourceDigest,
})
export type ArchitectureVerifiedDiffProjectionSource =
  typeof ArchitectureVerifiedDiffProjectionSource.Type

export const ArchitectureGraphProjectionSource = Schema.Union([
  ArchitectureStandingSource,
  ArchitecturePlannedProjectionSource,
  ArchitectureVerifiedProposalProjectionSource,
  ArchitectureVerifiedDiffProjectionSource,
])
export type ArchitectureGraphProjectionSource = typeof ArchitectureGraphProjectionSource.Type

export const ArchitectureStandingAnchor = Schema.Struct({
  selectionId: ArchitectureGraphProjectionId,
  status: Schema.Literals(['matched', 'ambiguous', 'unmatched', 'stale']),
  source: ArchitectureStandingSource,
  lens: Schema.Literals(['architecture', 'structure']),
  candidateIds: Schema.Array(ArchitectureGraphProjectionId).check(
    Schema.isMaxLength(ARCHITECTURE_GRAPH_PROJECTION_NODE_LIMIT),
  ),
  candidateCount: ArchitectureGraphProjectionExactCount,
  focusId: Schema.optionalKey(ArchitectureGraphProjectionId),
  nearestId: Schema.optionalKey(ArchitectureGraphProjectionId),
  disclosure: ArchitectureGraphProjectionLabel,
}).check(
  Schema.makeFilter((value) =>
  {
    if (new Set(value.candidateIds).size !== value.candidateIds.length)
    {
      return 'Standing anchor candidates must be unique.'
    }
    if (value.candidateCount.returned !== value.candidateIds.length)
    {
      return 'Standing anchor candidates must match their exact returned count.'
    }
    if (value.status === 'matched')
    {
      return (
        (value.candidateCount.total === 1 &&
          value.candidateIds.length === 1 &&
          value.focusId === value.candidateIds[0]) ||
        'A matched standing anchor requires one exact focus candidate.'
      )
    }
    if (value.status === 'ambiguous')
    {
      return (
        (value.candidateCount.total > 1 &&
          value.candidateIds.length > 1 &&
          value.focusId === undefined) ||
        'An ambiguous standing anchor requires multiple candidates and no exact focus.'
      )
    }
    if (value.status === 'unmatched')
    {
      return (
        (value.candidateCount.total === 0 &&
          value.candidateIds.length === 0 &&
          value.focusId === undefined) ||
        'An unmatched standing anchor cannot claim a candidate.'
      )
    }
    return true
  }),
)
export type ArchitectureStandingAnchor = typeof ArchitectureStandingAnchor.Type

export const ArchitectureGraphProjectionEvidencePathRef = Schema.Struct({
  path: ArchitectureRelativePath,
  side: Schema.Literals(['base', 'head']),
})
export type ArchitectureGraphProjectionEvidencePathRef =
  typeof ArchitectureGraphProjectionEvidencePathRef.Type

export const ArchitectureGraphProjectionEvidence = Schema.Struct({
  id: ArchitectureGraphProjectionReference,
  kind: Schema.Literals(['file', 'relationship', 'api', 'violation', 'move', 'planned']),
  state: Schema.Literals(['added', 'removed', 'affected']),
  label: ArchitectureGraphProjectionLabel,
  paths: Schema.Array(ArchitectureRelativePath).check(
    Schema.isMaxLength(ARCHITECTURE_GRAPH_PROJECTION_EVIDENCE_PATH_LIMIT),
  ),
  pathRefs: Schema.optionalKey(
    Schema.Array(ArchitectureGraphProjectionEvidencePathRef).check(
      Schema.isMaxLength(ARCHITECTURE_GRAPH_PROJECTION_EVIDENCE_PATH_REF_LIMIT),
    ),
  ),
}).check(
  Schema.makeFilter((value) =>
  {
    if (new Set(value.paths).size !== value.paths.length)
    {
      return 'Projection evidence paths must be unique.'
    }
    if (value.pathRefs === undefined) return true
    const pathSet = new Set(value.paths)
    const refKeys = value.pathRefs.map((ref) => `${ref.side}\0${ref.path}`)
    if (new Set(refKeys).size !== refKeys.length)
    {
      return 'Projection evidence path references must be unique.'
    }
    if (value.pathRefs.some((ref) => !pathSet.has(ref.path)))
    {
      return 'Projection evidence path references must target returned paths.'
    }
    const referencedPaths = new Set(value.pathRefs.map((ref) => ref.path))
    return (
      value.paths.every((path) => referencedPaths.has(path)) ||
      'Every returned projection evidence path must identify an immutable source side.'
    )
  }),
)
export type ArchitectureGraphProjectionEvidence = typeof ArchitectureGraphProjectionEvidence.Type

export const ArchitectureGraphProjectionNode = Schema.Struct({
  id: ArchitectureGraphProjectionId,
  label: ArchitectureGraphProjectionLabel,
  semanticLevel: ArchitectureGraphProjectionSemanticLevel,
  parentId: Schema.optionalKey(ArchitectureGraphProjectionId),
  relativePath: Schema.optionalKey(ArchitectureRelativePath),
  position: Schema.Struct({ x: Schema.Finite, y: Schema.Finite }),
  tintKey: Schema.String.check(Schema.isPattern(/^[0-9a-f]{12}$/u)),
  state: ArchitectureGraphProjectionState,
  stateLabel: Schema.Literals(['Added', 'Removed', 'Affected', 'Context']),
  badge: Schema.Literals(['plus', 'minus', 'affected', 'context']),
  stroke: Schema.Literals(['solid', 'dashed', 'double', 'muted']),
  fileCount: NonNegativeInt,
  inbound: NonNegativeInt,
  outbound: NonNegativeInt,
  affectedConsumerCount: NonNegativeInt,
  evidenceRefs: Schema.Array(ArchitectureGraphProjectionReference).check(
    Schema.isMaxLength(ARCHITECTURE_GRAPH_PROJECTION_EVIDENCE_LIMIT),
  ),
})
export type ArchitectureGraphProjectionNode = typeof ArchitectureGraphProjectionNode.Type

export const ArchitectureGraphProjectionEdge = Schema.Struct({
  id: ArchitectureGraphProjectionId,
  from: ArchitectureGraphProjectionId,
  to: ArchitectureGraphProjectionId,
  relationshipKind: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  weight: Schema.Finite.check(Schema.isGreaterThan(0)),
  state: ArchitectureGraphProjectionState,
  stateLabel: Schema.Literals(['Added', 'Removed', 'Affected', 'Context']),
  stroke: Schema.Literals(['solid', 'dashed', 'double', 'muted']),
  evidenceRefs: Schema.Array(ArchitectureGraphProjectionReference).check(
    Schema.isMaxLength(ARCHITECTURE_GRAPH_PROJECTION_EVIDENCE_LIMIT),
  ),
})
export type ArchitectureGraphProjectionEdge = typeof ArchitectureGraphProjectionEdge.Type

export const ArchitectureGraphProjectionBreadcrumb = Schema.Struct({
  id: ArchitectureGraphProjectionId,
  label: ArchitectureGraphProjectionLabel,
  level: ArchitectureGraphProjectionSemanticLevel,
})
export type ArchitectureGraphProjectionBreadcrumb =
  typeof ArchitectureGraphProjectionBreadcrumb.Type

export const ArchitectureGraphProjection = Schema.Struct({
  projectionVersion: Schema.Literal(1),
  projectionId: ArchitectureGraphProjectionId,
  projectionRevision: PositiveInt,
  kind: Schema.Literals(['repository-map', 'impact-diff']),
  authority: Schema.Literals(['standing', 'planned', 'verified']),
  resultState: Schema.Literals(['graph', 'no-impact']),
  freshness: Schema.Literals(['fresh', 'dirty', 'stale', 'reverted']),
  generatedAt: IsoDateTime,
  publishedAt: Schema.optionalKey(IsoDateTime),
  source: ArchitectureGraphProjectionSource,
  repository: Schema.optionalKey(
    Schema.Struct({
      name: Schema.String.check(Schema.isNonEmpty()),
      scope: Schema.String.check(Schema.isNonEmpty()),
      gitRef: Schema.optionalKey(GitRefString),
    }),
  ),
  lens: Schema.Literals(['architecture', 'structure']),
  semanticLevel: ArchitectureGraphProjectionSemanticLevel,
  breadcrumbs: Schema.Array(ArchitectureGraphProjectionBreadcrumb).check(Schema.isMaxLength(32)),
  layoutVersion: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  totals: Schema.Struct({
    nodes: ArchitectureGraphProjectionExactCount,
    edges: ArchitectureGraphProjectionExactCount,
    evidence: ArchitectureGraphProjectionExactCount,
    changedFiles: ArchitectureGraphProjectionExactCount,
  }),
  nodes: Schema.Array(ArchitectureGraphProjectionNode).check(
    Schema.isMaxLength(ARCHITECTURE_GRAPH_PROJECTION_NODE_LIMIT),
  ),
  edges: Schema.Array(ArchitectureGraphProjectionEdge).check(
    Schema.isMaxLength(ARCHITECTURE_GRAPH_PROJECTION_EDGE_LIMIT),
  ),
  evidence: Schema.Array(ArchitectureGraphProjectionEvidence).check(
    Schema.isMaxLength(ARCHITECTURE_GRAPH_PROJECTION_EVIDENCE_LIMIT),
  ),
  anchors: Schema.Array(ArchitectureStandingAnchor).check(
    Schema.isMaxLength(ARCHITECTURE_GRAPH_PROJECTION_ANCHOR_LIMIT),
  ),
  newerProjectionId: Schema.optionalKey(ArchitectureGraphProjectionId),
}).check(
  Schema.makeFilter((value) =>
  {
    const nodeIds = new Set(value.nodes.map((node) => node.id))
    const edgeIds = new Set(value.edges.map((edge) => edge.id))
    const evidenceIds = new Set(value.evidence.map((evidence) => evidence.id))
    if (
      nodeIds.size !== value.nodes.length ||
      edgeIds.size !== value.edges.length ||
      evidenceIds.size !== value.evidence.length
    )
    {
      return 'Projection node, edge, and evidence identities must be unique.'
    }
    if (
      value.totals.nodes.returned !== value.nodes.length ||
      value.totals.edges.returned !== value.edges.length ||
      value.totals.evidence.returned !== value.evidence.length
    )
    {
      return 'Projection arrays must match their exact returned counts.'
    }
    if (
      value.nodes.some(
        (node) =>
          new Set(node.evidenceRefs).size !== node.evidenceRefs.length ||
          node.evidenceRefs.some((ref) => !evidenceIds.has(ref)),
      ) ||
      value.edges.some(
        (edge) =>
          !nodeIds.has(edge.from) ||
          !nodeIds.has(edge.to) ||
          new Set(edge.evidenceRefs).size !== edge.evidenceRefs.length ||
          edge.evidenceRefs.some((ref) => !evidenceIds.has(ref)),
      )
    )
    {
      return 'Projection graph cross-references must resolve within the returned resource.'
    }
    const treatments = {
      added: ['Added', 'plus', 'solid'],
      removed: ['Removed', 'minus', 'dashed'],
      affected: ['Affected', 'affected', 'double'],
      context: ['Context', 'context', 'muted'],
    } as const
    if (
      value.nodes.some((node) =>
      {
        const expected = treatments[node.state]
        return (
          node.stateLabel !== expected[0] ||
          node.badge !== expected[1] ||
          node.stroke !== expected[2]
        )
      }) ||
      value.edges.some((edge) =>
      {
        const expected = treatments[edge.state]
        return edge.stateLabel !== expected[0] || edge.stroke !== expected[2]
      })
    )
    {
      return 'Projection state must match its textual and stroke treatment.'
    }
    if (
      value.anchors.some(
        (anchor) => !nodeIds.has(anchor.selectionId) && !edgeIds.has(anchor.selectionId),
      )
    )
    {
      return 'Standing anchors must refer to returned graph selections.'
    }
    if (
      value.resultState === 'no-impact' &&
      (value.nodes.length > 0 ||
        value.edges.length > 0 ||
        value.evidence.length > 0 ||
        value.totals.nodes.total > 0 ||
        value.totals.edges.total > 0 ||
        value.totals.evidence.total > 0)
    )
    {
      return 'A no-impact projection cannot contain graph evidence.'
    }
    const sourceAuthority =
      value.source.kind === 'planned-impact'
        ? 'planned'
        : value.source.kind === 'standing-project-generation'
          ? 'standing'
          : 'verified'
    return (
      sourceAuthority === value.authority || 'Projection authority must match its exact source.'
    )
  }),
)
export type ArchitectureGraphProjection = typeof ArchitectureGraphProjection.Type

export const ArchitectureImpactPlannedCandidate = Schema.Struct({
  authority: Schema.Literal('planned'),
  source: ArchitecturePlannedProjectionSource,
  projectionId: ArchitectureGraphProjectionId,
  projectionRevision: PositiveInt,
  resultState: Schema.Literals(['graph', 'no-impact']),
  freshness: Schema.Literals(['fresh', 'dirty', 'stale', 'reverted']),
  generatedAt: IsoDateTime,
  publishedAt: IsoDateTime,
})
export type ArchitectureImpactPlannedCandidate = typeof ArchitectureImpactPlannedCandidate.Type

export const ArchitectureImpactVerifiedCandidate = Schema.Struct({
  authority: Schema.Literal('verified'),
  source: Schema.Union([
    ArchitectureVerifiedProposalProjectionSource,
    ArchitectureVerifiedDiffProjectionSource,
  ]),
  projectionId: ArchitectureGraphProjectionId,
  projectionRevision: PositiveInt,
  projectionDigest: ArchitectureSourceDigest,
  resultState: Schema.Literals(['graph', 'no-impact']),
  freshness: Schema.Literals(['fresh', 'dirty', 'stale', 'reverted']),
  generatedAt: IsoDateTime,
  publishedAt: IsoDateTime,
  standingSource: Schema.optionalKey(ArchitectureStandingSource),
})
export type ArchitectureImpactVerifiedCandidate = typeof ArchitectureImpactVerifiedCandidate.Type

export const ArchitectureImpactDescriptor = Schema.Struct({
  version: Schema.Literal(1),
  descriptorId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  threadId: ThreadId,
  projectId: ProjectId,
  target: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal('plan'),
      plan: ArchitecturePlannedImpactPlanIdentity,
      state: Schema.Literals(['active', 'superseded', 'reverted']),
    }),
    Schema.Struct({
      kind: Schema.Literal('comparison'),
      comparison: ArchitectureComparisonSelector,
    }),
  ]),
  plannedCandidate: Schema.optionalKey(ArchitectureImpactPlannedCandidate),
  verifiedCandidate: Schema.optionalKey(ArchitectureImpactVerifiedCandidate),
  defaultAuthority: Schema.Literals(['planned', 'verified']),
  resolvedAt: IsoDateTime,
  newerDescriptorId: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))),
}).check(
  Schema.makeFilter((value) =>
  {
    if (value.plannedCandidate === undefined && value.verifiedCandidate === undefined)
    {
      return 'An Impact descriptor must contain at least one exact authority candidate.'
    }
    if (value.defaultAuthority === 'planned' && value.plannedCandidate === undefined)
    {
      return 'The default Planned authority candidate is missing.'
    }
    if (value.defaultAuthority === 'verified' && value.verifiedCandidate === undefined)
    {
      return 'The default Verified authority candidate is missing.'
    }
    if (value.newerDescriptorId === value.descriptorId)
    {
      return 'A newer Impact descriptor must have a different exact identity.'
    }
    if (value.target.kind === 'comparison' && value.plannedCandidate !== undefined)
    {
      return 'Comparison-bound Impact descriptors are Verified-only.'
    }
    return true
  }),
)
export type ArchitectureImpactDescriptor = typeof ArchitectureImpactDescriptor.Type

export const ArchitectureImpactProjectionRequest = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal('resolve-plan'),
    threadId: ThreadId,
    plan: ArchitecturePlannedImpactPlanIdentity,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal('resolve-comparison'),
    threadId: ThreadId,
    comparison: ArchitectureComparisonSelector,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal('read-exact'),
    descriptor: ArchitectureImpactDescriptor,
    authority: Schema.optionalKey(Schema.Literals(['planned', 'verified'])),
  }),
])
export type ArchitectureImpactProjectionRequest = typeof ArchitectureImpactProjectionRequest.Type

function plannedImpactPlanMatches(
  left: ArchitecturePlannedImpactPlanIdentity,
  right: ArchitecturePlannedImpactPlanIdentity,
): boolean
{
  if (left._tag !== right._tag) return false
  if (left._tag === 'plan')
  {
    return right._tag === 'plan' && left.planId === right.planId
  }
  return (
    right._tag === 'orchestrate' && left.runId === right.runId && left.revision === right.revision
  )
}

function plannedProjectionSourcesMatch(
  left: ArchitecturePlannedProjectionSource,
  right: ArchitecturePlannedProjectionSource,
): boolean
{
  return (
    left.environmentId === right.environmentId &&
    left.projectId === right.projectId &&
    left.threadId === right.threadId &&
    plannedImpactPlanMatches(left.plan, right.plan) &&
    left.publication.publicationId === right.publication.publicationId &&
    left.publication.publicationRevision === right.publication.publicationRevision &&
    left.publication.contentDigest === right.publication.contentDigest &&
    left.projection.projectionId === right.projection.projectionId &&
    left.projection.projectionRevision === right.projection.projectionRevision &&
    left.projection.materialization === right.projection.materialization
  )
}

function verifiedProjectionSourcesMatch(
  left: ArchitectureImpactVerifiedCandidate['source'],
  right: ArchitectureVerifiedProposalProjectionSource | ArchitectureVerifiedDiffProjectionSource,
): boolean
{
  if (left.kind !== right.kind) return false
  if (left.kind === 'verified-proposal-impact')
  {
    const proposal = right as ArchitectureVerifiedProposalProjectionSource
    return (
      left.threadId === proposal.threadId &&
      left.generationId === proposal.generationId &&
      left.proposalId === proposal.proposalId &&
      left.revisionId === proposal.revisionId &&
      left.baseTreeOid === proposal.baseTreeOid &&
      left.headTreeOid === proposal.headTreeOid &&
      left.baseGraphDigest === proposal.baseGraphDigest &&
      left.headGraphDigest === proposal.headGraphDigest &&
      left.projectionDigest === proposal.projectionDigest
    )
  }
  const diff = right as ArchitectureVerifiedDiffProjectionSource
  return (
    left.threadId === diff.threadId &&
    left.diffAnalysisId === diff.diffAnalysisId &&
    left.baseTreeOid === diff.baseTreeOid &&
    left.headTreeOid === diff.headTreeOid &&
    left.baseGraphDigest === diff.baseGraphDigest &&
    left.headGraphDigest === diff.headGraphDigest &&
    left.projectionDigest === diff.projectionDigest
  )
}

export const ArchitectureImpactProjectionResult = Schema.Struct({
  version: Schema.Literal(1),
  descriptor: ArchitectureImpactDescriptor,
  selectedAuthority: Schema.Literals(['planned', 'verified']),
  projection: ArchitectureGraphProjection,
  newerDescriptorId: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))),
}).check(
  Schema.makeFilter((value) =>
  {
    if (value.selectedAuthority !== value.projection.authority)
    {
      return 'Selected Impact authority must match the returned projection.'
    }
    if (value.projection.kind !== 'impact-diff')
    {
      return 'An Impact result must contain an Impact Diff projection.'
    }
    if (value.newerDescriptorId !== value.descriptor.newerDescriptorId)
    {
      return 'Impact result and descriptor must agree on the explicit newer identity.'
    }
    const candidate =
      value.selectedAuthority === 'planned'
        ? value.descriptor.plannedCandidate
        : value.descriptor.verifiedCandidate
    if (candidate === undefined)
    {
      return 'The selected Impact authority candidate is missing.'
    }
    if (
      value.projection.projectionId !== candidate.projectionId ||
      value.projection.projectionRevision !== candidate.projectionRevision ||
      value.projection.resultState !== candidate.resultState ||
      value.projection.generatedAt !== candidate.generatedAt ||
      value.projection.publishedAt !== candidate.publishedAt
    )
    {
      return 'The returned Impact projection must match its exact authority candidate.'
    }
    if (candidate.authority === 'planned')
    {
      if (
        value.projection.source.kind !== 'planned-impact' ||
        !plannedProjectionSourcesMatch(candidate.source, value.projection.source)
      )
      {
        return 'The returned Planned Impact source must match its exact candidate.'
      }
      if (
        value.descriptor.target.kind !== 'plan' ||
        value.projection.source.threadId !== value.descriptor.threadId ||
        value.projection.source.projectId !== value.descriptor.projectId ||
        !plannedImpactPlanMatches(value.projection.source.plan, value.descriptor.target.plan)
      )
      {
        return 'The returned Planned Impact source must match its exact descriptor target.'
      }
      return true
    }
    if (
      (value.projection.source.kind !== 'verified-proposal-impact' &&
        value.projection.source.kind !== 'verified-diff-impact') ||
      !verifiedProjectionSourcesMatch(candidate.source, value.projection.source) ||
      value.projection.source.threadId !== value.descriptor.threadId
    )
    {
      return 'The returned Verified Impact source must match its exact candidate.'
    }
    if (value.descriptor.target.kind === 'comparison')
    {
      const comparison = value.descriptor.target.comparison
      if (
        (comparison.kind === 'proposal-generation' &&
          (value.projection.source.kind !== 'verified-proposal-impact' ||
            value.projection.source.generationId !== comparison.generationId)) ||
        (comparison.kind === 'diff-analysis' &&
          (value.projection.source.kind !== 'verified-diff-impact' ||
            value.projection.source.diffAnalysisId !== comparison.diffAnalysisId))
      )
      {
        return 'The returned Verified Impact source must match its comparison target.'
      }
    }
    return true
  }),
)
export type ArchitectureImpactProjectionResult = typeof ArchitectureImpactProjectionResult.Type

export const CartographerEnsureProjectArchitectureInput = Schema.Struct({
  projectId: ProjectId,
})
export type CartographerEnsureProjectArchitectureInput =
  typeof CartographerEnsureProjectArchitectureInput.Type

export const CartographerSubscribeProjectAtlasStatusInput = Schema.Struct({
  projectId: ProjectId,
})
export type CartographerSubscribeProjectAtlasStatusInput =
  typeof CartographerSubscribeProjectAtlasStatusInput.Type

export const ProjectAtlasStatus = Schema.Struct({
  state: Schema.Literals(['idle', 'building', 'ready', 'error']),
  source: Schema.NullOr(ArchitectureStandingSource),
  freshness: Schema.Struct({
    builtAt: Schema.NullOr(IsoDateTime),
    dirty: Schema.Boolean,
  }),
  lastBuildError: Schema.NullOr(TrimmedNonEmptyString),
})
export type ProjectAtlasStatus = typeof ProjectAtlasStatus.Type

export const CartographerGetRepositoryMapInput = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  generationId: Schema.optionalKey(ArchitectureGenerationId),
  lens: Schema.Literals(['architecture', 'structure']),
  focusIds: Schema.optionalKey(
    Schema.Array(ArchitectureGraphProjectionId).check(
      Schema.isMaxLength(ARCHITECTURE_GRAPH_PROJECTION_NODE_LIMIT),
    ),
  ),
}).check(
  Schema.makeFilter((value) =>
    value.focusIds === undefined || new Set(value.focusIds).size === value.focusIds.length
      ? true
      : 'Repository Map focus identities must be unique.',
  ),
)
export type CartographerGetRepositoryMapInput = typeof CartographerGetRepositoryMapInput.Type

export const CartographerGetArchitectureScopeInput = Schema.Struct({
  threadId: ThreadId,
  source: ArchitectureStandingSource,
  lens: Schema.Literals(['architecture', 'structure']),
  scope: Schema.Struct({
    level: ArchitectureGraphProjectionSemanticLevel,
    id: ArchitectureGraphProjectionId,
  }),
})
export type CartographerGetArchitectureScopeInput =
  typeof CartographerGetArchitectureScopeInput.Type

export const CartographerGetArchitectureSourceInput = Schema.Struct({
  threadId: ThreadId,
  source: Schema.Union([ArchitectureProposalSource, ArchitectureDiffSource]),
  relativePath: ArchitectureRelativePath,
})
export type CartographerGetArchitectureSourceInput =
  typeof CartographerGetArchitectureSourceInput.Type

export const CartographerGetArchitectureSourceResult = Schema.Struct({
  version: Schema.Literal(1),
  source: Schema.Union([ArchitectureProposalSource, ArchitectureDiffSource]),
  relativePath: ArchitectureRelativePath,
  sourceDigest: ArchitectureSourceDigest,
  content: Schema.String.check(
    Schema.makeFilter((value) =>
      new TextEncoder().encode(value).byteLength <= ARCHITECTURE_SOURCE_MAX_BYTES
        ? true
        : `Architecture source is limited to ${ARCHITECTURE_SOURCE_MAX_BYTES} bytes.`,
    ),
  ),
})
export type CartographerGetArchitectureSourceResult =
  typeof CartographerGetArchitectureSourceResult.Type
