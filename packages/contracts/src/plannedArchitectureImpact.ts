// packages/contracts/src/plannedArchitectureImpact.ts
// defines bounded provider claims and immutable planned-impact identities

import * as Schema from 'effect/Schema'

import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from './baseSchemas.ts'
import { OrchestratePlanRunId, OrchestrationProposedPlanId } from './orchestration.ts'
import { ProviderInstanceId } from './providerInstance.ts'

export const ARCHITECTURE_PLANNED_IMPACT_CHANGED_OBJECT_LIMIT = 60
export const ARCHITECTURE_PLANNED_IMPACT_RELATIONSHIP_LIMIT = 120
export const ARCHITECTURE_PLANNED_IMPACT_PATH_HINT_LIMIT = 100
export const ARCHITECTURE_PLANNED_IMPACT_CANONICAL_BYTES_LIMIT = 256 * 1024
export const ARCHITECTURE_PLANNED_IMPACT_SUMMARY_BYTES_LIMIT = 4_000
export const ARCHITECTURE_PLANNED_IMPACT_RATIONALE_BYTES_LIMIT = 16_000
export const ARCHITECTURE_PLANNED_IMPACT_DESCRIPTION_BYTES_LIMIT = 2_000
export const ARCHITECTURE_PLANNED_IMPACT_OMISSION_NOTE_BYTES_LIMIT = 2_000
export const ARCHITECTURE_PLANNED_IMPACT_ID_LENGTH_LIMIT = 200
export const ARCHITECTURE_PLANNED_IMPACT_PATH_LENGTH_LIMIT = 1_024

const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).byteLength

const displayTextWithoutControlCharacters = Schema.makeFilter<string>((value) =>
{
  for (let index = 0; index < value.length; index += 1)
  {
    const code = value.charCodeAt(index)
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f)
    {
      return 'Planned-impact text must not contain non-display control characters.'
    }
  }
  return true
})

const singleLineTextWithoutControlCharacters = Schema.makeFilter<string>((value) =>
{
  for (let index = 0; index < value.length; index += 1)
  {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f)
    {
      return 'Planned-impact identifiers and labels must not contain control characters.'
    }
  }
  return true
})

const boundedUtf8 = (maximumBytes: number, label: string) =>
  Schema.makeFilter<string>((value) =>
    utf8ByteLength(value) <= maximumBytes
      ? true
      : `${label} is limited to ${maximumBytes} UTF-8 bytes.`,
  )

const PlannedImpactShortText = TrimmedNonEmptyString.check(
  Schema.isMaxLength(ARCHITECTURE_PLANNED_IMPACT_ID_LENGTH_LIMIT),
  singleLineTextWithoutControlCharacters,
)

const PlannedImpactDescription = TrimmedNonEmptyString.check(
  boundedUtf8(ARCHITECTURE_PLANNED_IMPACT_DESCRIPTION_BYTES_LIMIT, 'Descriptions'),
  displayTextWithoutControlCharacters,
)

export const ArchitecturePlannedImpactDigest = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}$/u),
)
export type ArchitecturePlannedImpactDigest = typeof ArchitecturePlannedImpactDigest.Type

export const PlannedImpactPublicationId = TrimmedNonEmptyString.pipe(
  Schema.brand('PlannedImpactPublicationId'),
)
export type PlannedImpactPublicationId = typeof PlannedImpactPublicationId.Type

export const PlannedImpactProjectionId = TrimmedNonEmptyString.pipe(
  Schema.brand('PlannedImpactProjectionId'),
)
export type PlannedImpactProjectionId = typeof PlannedImpactProjectionId.Type

export const ArchitectureAnalysisAdmissionId = TrimmedNonEmptyString.pipe(
  Schema.brand('ArchitectureAnalysisAdmissionId'),
)
export type ArchitectureAnalysisAdmissionId = typeof ArchitectureAnalysisAdmissionId.Type

export const ArchitecturePlannedImpactPlanIdentity = Schema.Union([
  Schema.TaggedStruct('plan', {
    planId: OrchestrationProposedPlanId,
  }),
  Schema.TaggedStruct('orchestrate', {
    runId: OrchestratePlanRunId,
    revision: NonNegativeInt,
  }),
])
export type ArchitecturePlannedImpactPlanIdentity =
  typeof ArchitecturePlannedImpactPlanIdentity.Type

export const ArchitecturePlanImpactOrchestrateTarget = Schema.Struct({
  runId: OrchestratePlanRunId,
  revision: NonNegativeInt,
})
export type ArchitecturePlanImpactOrchestrateTarget =
  typeof ArchitecturePlanImpactOrchestrateTarget.Type

export const ArchitecturePlanImpactPathHint = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(ARCHITECTURE_PLANNED_IMPACT_PATH_LENGTH_LIMIT),
  Schema.makeFilter((value) =>
  {
    if (value !== value.trim())
    {
      return 'Planned-impact paths must not contain leading or trailing whitespace.'
    }
    if (value.startsWith('/') || value.includes('\\'))
    {
      return 'Planned-impact paths must be repository-relative POSIX paths.'
    }
    if (value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..'))
    {
      return 'Planned-impact paths must not contain empty, dot, or parent segments.'
    }
    for (let index = 0; index < value.length; index += 1)
    {
      if (value.charCodeAt(index) < 0x20 || value.charCodeAt(index) === 0x7f)
      {
        return 'Planned-impact paths must not contain control characters.'
      }
    }
    return true
  }),
)
export type ArchitecturePlanImpactPathHint = typeof ArchitecturePlanImpactPathHint.Type

const PlannedImpactPathHintIndexes = Schema.Array(NonNegativeInt).check(
  Schema.isMaxLength(ARCHITECTURE_PLANNED_IMPACT_PATH_HINT_LIMIT),
  Schema.makeFilter(
    (indexes) => new Set(indexes).size === indexes.length || 'Path-hint references must be unique.',
  ),
)

export const ArchitecturePlanImpactChangeState = Schema.Literals(['added', 'removed', 'affected'])
export type ArchitecturePlanImpactChangeState = typeof ArchitecturePlanImpactChangeState.Type

export const ArchitecturePlanImpactChangedObject = Schema.Struct({
  localId: PlannedImpactShortText,
  label: PlannedImpactShortText,
  semanticLevel: PlannedImpactShortText,
  state: ArchitecturePlanImpactChangeState,
  description: Schema.optionalKey(PlannedImpactDescription),
  pathHintIndexes: Schema.optionalKey(PlannedImpactPathHintIndexes),
})
export type ArchitecturePlanImpactChangedObject = typeof ArchitecturePlanImpactChangedObject.Type

export const ArchitecturePlanImpactRelationship = Schema.Struct({
  localId: PlannedImpactShortText,
  fromLocalId: PlannedImpactShortText,
  toLocalId: PlannedImpactShortText,
  relationshipKind: PlannedImpactShortText,
  state: ArchitecturePlanImpactChangeState,
  weight: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThan(0))),
  rationale: Schema.optionalKey(PlannedImpactDescription),
  pathHintIndexes: Schema.optionalKey(PlannedImpactPathHintIndexes),
})
export type ArchitecturePlanImpactRelationship = typeof ArchitecturePlanImpactRelationship.Type

export const ArchitecturePlanImpactOmissionCount = Schema.Struct({
  total: NonNegativeInt,
  omitted: NonNegativeInt,
})
export type ArchitecturePlanImpactOmissionCount = typeof ArchitecturePlanImpactOmissionCount.Type

export const ArchitecturePlanImpactOmissions = Schema.Struct({
  changedObjects: ArchitecturePlanImpactOmissionCount,
  relationships: ArchitecturePlanImpactOmissionCount,
  pathHints: ArchitecturePlanImpactOmissionCount,
  note: Schema.optionalKey(
    TrimmedNonEmptyString.check(
      boundedUtf8(ARCHITECTURE_PLANNED_IMPACT_OMISSION_NOTE_BYTES_LIMIT, 'Omission notes'),
      displayTextWithoutControlCharacters,
    ),
  ),
})
export type ArchitecturePlanImpactOmissions = typeof ArchitecturePlanImpactOmissions.Type

const ArchitecturePlanImpactClaimsFields = {
  version: Schema.Literal(1),
  summary: TrimmedNonEmptyString.check(
    boundedUtf8(ARCHITECTURE_PLANNED_IMPACT_SUMMARY_BYTES_LIMIT, 'Summaries'),
    displayTextWithoutControlCharacters,
  ),
  outcome: Schema.Literals(['changed', 'no-impact']),
  changedObjects: Schema.Array(ArchitecturePlanImpactChangedObject).check(
    Schema.isMaxLength(ARCHITECTURE_PLANNED_IMPACT_CHANGED_OBJECT_LIMIT),
  ),
  relationships: Schema.Array(ArchitecturePlanImpactRelationship).check(
    Schema.isMaxLength(ARCHITECTURE_PLANNED_IMPACT_RELATIONSHIP_LIMIT),
  ),
  pathHints: Schema.Array(ArchitecturePlanImpactPathHint).check(
    Schema.isMaxLength(ARCHITECTURE_PLANNED_IMPACT_PATH_HINT_LIMIT),
  ),
  rationale: Schema.optionalKey(
    TrimmedNonEmptyString.check(
      boundedUtf8(ARCHITECTURE_PLANNED_IMPACT_RATIONALE_BYTES_LIMIT, 'Rationales'),
      displayTextWithoutControlCharacters,
    ),
  ),
  omissions: ArchitecturePlanImpactOmissions,
} as const

export const ArchitecturePlanImpactClaims = Schema.Struct(ArchitecturePlanImpactClaimsFields).check(
  Schema.makeFilter((value) =>
  {
    const objectIds = new Set(value.changedObjects.map((object) => object.localId))
    if (objectIds.size !== value.changedObjects.length)
    {
      return 'Changed-object local IDs must be unique within a publication.'
    }
    const relationshipIds = new Set(value.relationships.map((relationship) => relationship.localId))
    if (relationshipIds.size !== value.relationships.length)
    {
      return 'Relationship local IDs must be unique within a publication.'
    }
    if (new Set(value.pathHints).size !== value.pathHints.length)
    {
      return 'Repository path hints must be unique within a publication.'
    }
    const pathHintCount = value.pathHints.length
    for (const object of value.changedObjects)
    {
      if ((object.pathHintIndexes ?? []).some((index) => index >= pathHintCount))
      {
        return `Changed object '${object.localId}' references a missing path hint.`
      }
    }
    for (const relationship of value.relationships)
    {
      if (!objectIds.has(relationship.fromLocalId) || !objectIds.has(relationship.toLocalId))
      {
        return `Relationship '${relationship.localId}' has a dangling endpoint.`
      }
      if ((relationship.pathHintIndexes ?? []).some((index) => index >= pathHintCount))
      {
        return `Relationship '${relationship.localId}' references a missing path hint.`
      }
    }
    if (
      value.omissions.changedObjects.total !==
        value.changedObjects.length + value.omissions.changedObjects.omitted ||
      value.omissions.relationships.total !==
        value.relationships.length + value.omissions.relationships.omitted ||
      value.omissions.pathHints.total !== value.pathHints.length + value.omissions.pathHints.omitted
    )
    {
      return 'Planned-impact totals must equal returned items plus omitted items.'
    }
    if (value.outcome === 'no-impact')
    {
      return (
        (value.changedObjects.length === 0 &&
          value.relationships.length === 0 &&
          value.omissions.changedObjects.total === 0 &&
          value.omissions.relationships.total === 0) ||
        'A no-impact publication cannot claim changed objects or relationships.'
      )
    }
    return (
      value.changedObjects.length > 0 ||
      value.relationships.length > 0 ||
      'A changed publication must include at least one changed object or relationship.'
    )
  }),
)
export type ArchitecturePlanImpactClaims = typeof ArchitecturePlanImpactClaims.Type

export const ArchitecturePlanImpactUpsertInput = Schema.Struct({
  ...ArchitecturePlanImpactClaimsFields,
  orchestratePlan: Schema.optionalKey(ArchitecturePlanImpactOrchestrateTarget),
})
export type ArchitecturePlanImpactUpsertInput = typeof ArchitecturePlanImpactUpsertInput.Type

export const PlannedImpactPublicationRef = Schema.Struct({
  publicationId: PlannedImpactPublicationId,
  publicationRevision: PositiveInt,
  contentDigest: ArchitecturePlannedImpactDigest,
})
export type PlannedImpactPublicationRef = typeof PlannedImpactPublicationRef.Type

export const PlannedImpactProjectionRef = Schema.Struct({
  projectionId: PlannedImpactProjectionId,
  projectionRevision: PositiveInt,
  materialization: Schema.Literals(['provisional', 'anchored', 'no-impact']),
})
export type PlannedImpactProjectionRef = typeof PlannedImpactProjectionRef.Type

export const ArchitecturePlanImpactUpsertResult = Schema.Struct({
  version: Schema.Literal(1),
  publication: PlannedImpactPublicationRef,
  plan: ArchitecturePlannedImpactPlanIdentity,
  projection: PlannedImpactProjectionRef,
  anchoring: Schema.Literals(['queued', 'reused', 'materialized', 'not-required']),
})
export type ArchitecturePlanImpactUpsertResult = typeof ArchitecturePlanImpactUpsertResult.Type

export const PlannedImpactPublication = Schema.Struct({
  version: Schema.Literal(1),
  ...PlannedImpactPublicationRef.fields,
  environmentId: EnvironmentId,
  projectId: ProjectId,
  sourceThreadId: ThreadId,
  turnId: TurnId,
  producerSessionId: TrimmedNonEmptyString,
  producerInstanceId: ProviderInstanceId,
  plan: ArchitecturePlannedImpactPlanIdentity,
  claims: ArchitecturePlanImpactClaims,
  supersedesPublicationId: Schema.NullOr(PlannedImpactPublicationId),
  createdAt: IsoDateTime,
})
export type PlannedImpactPublication = typeof PlannedImpactPublication.Type

export const PlannedImpactProjectionNode = Schema.Struct({
  id: TrimmedNonEmptyString,
  localId: PlannedImpactShortText,
  label: PlannedImpactShortText,
  semanticLevel: PlannedImpactShortText,
  state: ArchitecturePlanImpactChangeState,
  description: Schema.optionalKey(PlannedImpactDescription),
  pathHints: Schema.Array(ArchitecturePlanImpactPathHint).check(
    Schema.isMaxLength(ARCHITECTURE_PLANNED_IMPACT_PATH_HINT_LIMIT),
  ),
  position: Schema.Struct({ x: Schema.Finite, y: Schema.Finite }),
  tintKey: TrimmedNonEmptyString,
})
export type PlannedImpactProjectionNode = typeof PlannedImpactProjectionNode.Type

export const PlannedImpactProjectionEdge = Schema.Struct({
  id: TrimmedNonEmptyString,
  localId: PlannedImpactShortText,
  from: TrimmedNonEmptyString,
  to: TrimmedNonEmptyString,
  relationshipKind: PlannedImpactShortText,
  state: ArchitecturePlanImpactChangeState,
  weight: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThan(0))),
  rationale: Schema.optionalKey(PlannedImpactDescription),
  pathHints: Schema.Array(ArchitecturePlanImpactPathHint).check(
    Schema.isMaxLength(ARCHITECTURE_PLANNED_IMPACT_PATH_HINT_LIMIT),
  ),
})
export type PlannedImpactProjectionEdge = typeof PlannedImpactProjectionEdge.Type

export const PlannedImpactStandingSource = Schema.Struct({
  projectId: ProjectId,
  generationId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  graphDigest: Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/u)),
  builtAt: IsoDateTime,
})
export type PlannedImpactStandingSource = typeof PlannedImpactStandingSource.Type

export const PlannedImpactStandingScope = Schema.Struct({
  role: Schema.Literals(['touched', 'context']),
  level: Schema.Literals(['systems', 'blocks']),
  id: TrimmedNonEmptyString,
  key: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
})
export type PlannedImpactStandingScope = typeof PlannedImpactStandingScope.Type

const PlannedImpactStandingAnchorId = TrimmedNonEmptyString.check(Schema.isMaxLength(1_280))
const PlannedImpactStandingAnchorDisclosure = TrimmedNonEmptyString.check(
  Schema.isMaxLength(4_000),
  displayTextWithoutControlCharacters,
)

export const PlannedImpactStandingAnchorCandidateCount = Schema.Struct({
  total: NonNegativeInt,
  returned: NonNegativeInt,
  omitted: NonNegativeInt,
}).check(
  Schema.makeFilter((value) =>
    value.total === value.returned + value.omitted
      ? true
      : 'Planned anchor total must equal returned plus omitted.',
  ),
)
export type PlannedImpactStandingAnchorCandidateCount =
  typeof PlannedImpactStandingAnchorCandidateCount.Type

export const PlannedImpactStandingAnchor = Schema.Struct({
  selectionKind: Schema.Literals(['object', 'relationship']),
  localId: PlannedImpactShortText,
  status: Schema.Literals(['matched', 'ambiguous', 'unmatched']),
  lens: Schema.Literals(['architecture', 'structure']),
  candidateIds: Schema.Array(PlannedImpactStandingAnchorId).check(
    Schema.isMaxLength(ARCHITECTURE_PLANNED_IMPACT_CHANGED_OBJECT_LIMIT),
  ),
  candidateCount: PlannedImpactStandingAnchorCandidateCount,
  focusId: Schema.optionalKey(PlannedImpactStandingAnchorId),
  nearestId: Schema.optionalKey(PlannedImpactStandingAnchorId),
  disclosure: PlannedImpactStandingAnchorDisclosure,
}).check(
  Schema.makeFilter((value) =>
  {
    if (
      new Set(value.candidateIds).size !== value.candidateIds.length ||
      value.candidateCount.returned !== value.candidateIds.length
    )
    {
      return 'Planned anchor candidates must be unique and match their returned count.'
    }
    if (value.status === 'matched')
    {
      return (
        (value.candidateCount.total === 1 &&
          value.candidateIds.length === 1 &&
          value.focusId === value.candidateIds[0]) ||
        'A matched Planned anchor requires one exact focus candidate.'
      )
    }
    if (value.status === 'ambiguous')
    {
      return (
        (value.candidateCount.total > 1 &&
          value.candidateIds.length > 1 &&
          value.focusId === undefined) ||
        'An ambiguous Planned anchor requires multiple candidates and no exact focus.'
      )
    }
    return (
      (value.candidateCount.total === 0 &&
        value.candidateIds.length === 0 &&
        value.focusId === undefined) ||
      'An unmatched Planned anchor cannot claim a candidate.'
    )
  }),
)
export type PlannedImpactStandingAnchor = typeof PlannedImpactStandingAnchor.Type

export const PlannedImpactMaterializedProjection = Schema.Struct({
  version: Schema.Literal(1),
  ...PlannedImpactProjectionRef.fields,
  publication: PlannedImpactPublicationRef,
  resultState: Schema.Literals(['graph', 'no-impact']),
  summary: TrimmedNonEmptyString,
  nodes: Schema.Array(PlannedImpactProjectionNode).check(
    Schema.isMaxLength(ARCHITECTURE_PLANNED_IMPACT_CHANGED_OBJECT_LIMIT),
  ),
  edges: Schema.Array(PlannedImpactProjectionEdge).check(
    Schema.isMaxLength(ARCHITECTURE_PLANNED_IMPACT_RELATIONSHIP_LIMIT),
  ),
  standingSource: Schema.optionalKey(PlannedImpactStandingSource),
  standingScope: Schema.Array(PlannedImpactStandingScope).check(
    Schema.isMaxLength(ARCHITECTURE_PLANNED_IMPACT_PATH_HINT_LIMIT),
  ),
  standingAnchors: Schema.optionalKey(
    Schema.Array(PlannedImpactStandingAnchor).check(
      Schema.isMaxLength(
        ARCHITECTURE_PLANNED_IMPACT_CHANGED_OBJECT_LIMIT +
          ARCHITECTURE_PLANNED_IMPACT_RELATIONSHIP_LIMIT,
      ),
    ),
  ),
  createdAt: IsoDateTime,
}).check(
  Schema.makeFilter((value) =>
  {
    const anchors = value.standingAnchors ?? []
    const objectIds = new Set(value.nodes.map((node) => node.localId))
    const relationshipIds = new Set(value.edges.map((edge) => edge.localId))
    const anchorKeys = anchors.map((anchor) => `${anchor.selectionKind}:${anchor.localId}`)
    if (new Set(anchorKeys).size !== anchorKeys.length)
    {
      return 'Planned standing anchors must have unique selection identities.'
    }
    if (
      anchors.some((anchor) =>
        anchor.selectionKind === 'object'
          ? !objectIds.has(anchor.localId)
          : !relationshipIds.has(anchor.localId),
      )
    )
    {
      return 'Planned standing anchors must reference a materialized publication selection.'
    }
    if (value.materialization === 'anchored')
    {
      return (
        (value.standingSource !== undefined &&
          anchors.length === value.nodes.length + value.edges.length) ||
        'An anchored Planned projection requires one exact standing anchor per selection.'
      )
    }
    return (
      (value.standingSource === undefined && anchors.length === 0) ||
      'Only an anchored Planned projection can contain a standing source or anchors.'
    )
  }),
)
export type PlannedImpactMaterializedProjection = typeof PlannedImpactMaterializedProjection.Type

export const ArchitectureAnalysisAdmissionState = Schema.Literals([
  'queued',
  'leased',
  'complete',
  'retry-wait',
  'terminal-failed',
  'cancelled',
])
export type ArchitectureAnalysisAdmissionState = typeof ArchitectureAnalysisAdmissionState.Type
