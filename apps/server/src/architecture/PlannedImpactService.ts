// apps/server/src/architecture/PlannedImpactService.ts
// admits immutable provider claims and materializes planned-impact projections

// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off

import * as NodeCrypto from 'node:crypto'

import {
  ARCHITECTURE_PLANNED_IMPACT_CANONICAL_BYTES_LIMIT,
  ArchitecturePlanImpactClaims,
  ArchitecturePlanImpactUpsertResult,
  ArchitecturePlannedImpactDigest,
  ArchitectureToolError,
  PlannedImpactMaterializedProjection,
  PlannedImpactPublication,
  PlannedImpactPublicationId,
  PlannedImpactProjectionId,
  type ArchitecturePlanImpactChangedObject,
  type ArchitecturePlanImpactRelationship,
  type ArchitecturePlannedImpactPlanIdentity,
  type EnvironmentId,
  type PlannedImpactProjectionRef,
  type PlannedImpactProjectionEdge,
  type PlannedImpactProjectionNode,
  type PlannedImpactStandingAnchor,
  type PlannedImpactStandingScope,
  type PlannedImpactStandingSource,
  type ProjectId,
  type ProviderInstanceId,
  type ThreadId,
  type TurnId,
} from '@t3tools/contracts'
import * as Context from 'effect/Context'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as Semaphore from 'effect/Semaphore'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import {
  architectureAdmissionMetricAttributes,
  architectureAnalysisAdmissionsTotal,
  increment,
} from '../observability/Metrics.ts'
import * as ArchitectureAdmissionRepository from './ArchitectureAdmissionRepository.ts'

interface PublicationRow
{
  readonly publicationId: string
  readonly environmentId: string
  readonly projectId: string
  readonly sourceThreadId: string
  readonly turnId: string
  readonly providerSessionId: string
  readonly providerInstanceId: string
  readonly planKind: 'plan' | 'orchestrate'
  readonly planId: string | null
  readonly orchestrateRunId: string | null
  readonly orchestrateRevision: number | null
  readonly publicationRevision: number
  readonly contentDigest: string
  readonly canonicalPayloadJson: string
  readonly supersedesPublicationId: string | null
  readonly createdAt: string
}

interface ProjectionRow
{
  readonly projectionId: string
  readonly publicationId: string
  readonly publicationRevision: number
  readonly projectionRevision: number
  readonly materialization: PlannedImpactProjectionRef['materialization']
  readonly projectionJson: string
  readonly projectionDigest: string
  readonly standingGenerationId: string | null
  readonly standingGraphDigest: string | null
  readonly createdAt: string
}

export interface PlannedImpactUpsertRequest
{
  readonly environmentId: EnvironmentId
  readonly projectId: ProjectId
  readonly sourceThreadId: ThreadId
  readonly turnId: TurnId
  readonly providerSessionId: string
  readonly providerInstanceId: ProviderInstanceId
  readonly plan: ArchitecturePlannedImpactPlanIdentity
  readonly workspaceRoot: string
  readonly claims: ArchitecturePlanImpactClaims
}

export interface PlannedImpactStored
{
  readonly publication: PlannedImpactPublication
  readonly projections: ReadonlyArray<PlannedImpactMaterializedProjection>
}

export interface PlannedImpactServiceShape
{
  readonly upsert: (
    input: PlannedImpactUpsertRequest,
  ) => Effect.Effect<ArchitecturePlanImpactUpsertResult, ArchitectureToolError>
  readonly get: (
    publicationId: PlannedImpactPublicationId,
  ) => Effect.Effect<PlannedImpactStored, ArchitectureToolError>
  readonly findLatestForAuthority: (input: {
    readonly environmentId: EnvironmentId
    readonly projectId: ProjectId
    readonly sourceThreadId: ThreadId
    readonly plan: ArchitecturePlannedImpactPlanIdentity
  }) => Effect.Effect<PlannedImpactStored | null, ArchitectureToolError>
  readonly appendAnchored: (input: {
    readonly publicationId: PlannedImpactPublicationId
    readonly publicationRevision: number
    readonly standingSource: PlannedImpactStandingSource
    readonly standingScope: ReadonlyArray<PlannedImpactStandingScope>
    readonly nodes: ReadonlyArray<PlannedImpactProjectionNode>
    readonly edges: ReadonlyArray<PlannedImpactProjectionEdge>
    readonly standingAnchors: ReadonlyArray<PlannedImpactStandingAnchor>
    readonly leaseFence: ArchitectureAdmissionRepository.ArchitectureAdmissionLeaseFence
    readonly createdAt: string
  }) => Effect.Effect<PlannedImpactMaterializedProjection, ArchitectureToolError>
}

export class PlannedImpactService extends Context.Service<
  PlannedImpactService,
  PlannedImpactServiceShape
>()('456code/architecture/PlannedImpactService')
{}

const publicationColumns = `
  publication_id AS "publicationId",
  environment_id AS "environmentId",
  project_id AS "projectId",
  source_thread_id AS "sourceThreadId",
  turn_id AS "turnId",
  provider_session_id AS "providerSessionId",
  provider_instance_id AS "providerInstanceId",
  plan_kind AS "planKind",
  plan_id AS "planId",
  orchestrate_run_id AS "orchestrateRunId",
  orchestrate_revision AS "orchestrateRevision",
  publication_revision AS "publicationRevision",
  content_digest AS "contentDigest",
  canonical_payload_json AS "canonicalPayloadJson",
  supersedes_publication_id AS "supersedesPublicationId",
  created_at AS "createdAt"
`

const projectionColumns = `
  projection_id AS "projectionId",
  publication_id AS "publicationId",
  publication_revision AS "publicationRevision",
  projection_revision AS "projectionRevision",
  materialization,
  projection_json AS "projectionJson",
  projection_digest AS "projectionDigest",
  standing_generation_id AS "standingGenerationId",
  standing_graph_digest AS "standingGraphDigest",
  created_at AS "createdAt"
`

const decodeClaims = Schema.decodeUnknownEffect(ArchitecturePlanImpactClaims, {
  onExcessProperty: 'error',
})
const decodePublication = Schema.decodeUnknownEffect(PlannedImpactPublication, {
  onExcessProperty: 'error',
})
const decodeProjection = Schema.decodeUnknownEffect(PlannedImpactMaterializedProjection, {
  onExcessProperty: 'error',
})
const decodeUpsertResult = Schema.decodeUnknownEffect(ArchitecturePlanImpactUpsertResult, {
  onExcessProperty: 'error',
})
const isArchitectureToolError = Schema.is(ArchitectureToolError)

function toolError(
  operation: string,
  code: ConstructorParameters<typeof ArchitectureToolError>[0]['code'],
  detail: string,
): ArchitectureToolError
{
  return new ArchitectureToolError({ operation, code, detail })
}

function persistenceError(operation: string, cause: unknown): ArchitectureToolError
{
  return toolError(
    operation,
    'persistence-failed',
    cause instanceof Error ? cause.message : 'Planned impact persistence failed.',
  )
}

function sha256(value: string): string
{
  return NodeCrypto.createHash('sha256').update(value, 'utf8').digest('hex')
}

const normalizeText = (value: string): string => value.trim().normalize('NFC')

const compareCanonicalText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

function stableJson(value: unknown): string
{
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .toSorted(([left], [right]) => compareCanonicalText(left, right))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`
}

export function architecturePlanIdentityKey(plan: ArchitecturePlannedImpactPlanIdentity): string
{
  return plan._tag === 'plan' ? `plan:${plan.planId}` : `orchestrate:${plan.runId}:${plan.revision}`
}

function remapPathHintIndexes(
  indexes: ReadonlyArray<number> | undefined,
  pathHints: ReadonlyArray<string>,
  sortedIndexByPath: ReadonlyMap<string, number>,
): ReadonlyArray<number> | undefined
{
  if (indexes === undefined) return undefined
  return indexes
    .map((index) => sortedIndexByPath.get(pathHints[index]!))
    .filter((index): index is number => index !== undefined)
    .toSorted((left, right) => left - right)
}

function normalizeChangedObject(
  object: ArchitecturePlanImpactChangedObject,
  pathHints: ReadonlyArray<string>,
  sortedIndexByPath: ReadonlyMap<string, number>,
): ArchitecturePlanImpactChangedObject
{
  const pathHintIndexes = remapPathHintIndexes(object.pathHintIndexes, pathHints, sortedIndexByPath)
  return {
    localId: normalizeText(object.localId),
    label: normalizeText(object.label),
    semanticLevel: normalizeText(object.semanticLevel),
    state: object.state,
    ...(object.description === undefined ? {} : { description: normalizeText(object.description) }),
    ...(pathHintIndexes === undefined ? {} : { pathHintIndexes }),
  }
}

function normalizeRelationship(
  relationship: ArchitecturePlanImpactRelationship,
  pathHints: ReadonlyArray<string>,
  sortedIndexByPath: ReadonlyMap<string, number>,
): ArchitecturePlanImpactRelationship
{
  const pathHintIndexes = remapPathHintIndexes(
    relationship.pathHintIndexes,
    pathHints,
    sortedIndexByPath,
  )
  return {
    localId: normalizeText(relationship.localId),
    fromLocalId: normalizeText(relationship.fromLocalId),
    toLocalId: normalizeText(relationship.toLocalId),
    relationshipKind: normalizeText(relationship.relationshipKind),
    state: relationship.state,
    ...(relationship.weight === undefined ? {} : { weight: relationship.weight }),
    ...(relationship.rationale === undefined
      ? {}
      : { rationale: normalizeText(relationship.rationale) }),
    ...(pathHintIndexes === undefined ? {} : { pathHintIndexes }),
  }
}

const normalizeClaims = Effect.fn('PlannedImpactService.normalizeClaims')(function* (
  claims: ArchitecturePlanImpactClaims,
)
{
  const normalizedInputPaths = claims.pathHints.map((path) => path.normalize('NFC'))
  const pathHints = [...normalizedInputPaths].toSorted()
  const sortedIndexByPath = new Map(pathHints.map((path, index) => [path, index] as const))
  const normalized = {
    version: 1 as const,
    summary: normalizeText(claims.summary),
    outcome: claims.outcome,
    changedObjects: claims.changedObjects
      .map((object) => normalizeChangedObject(object, normalizedInputPaths, sortedIndexByPath))
      .toSorted((left, right) => compareCanonicalText(left.localId, right.localId)),
    relationships: claims.relationships
      .map((relationship) =>
        normalizeRelationship(relationship, normalizedInputPaths, sortedIndexByPath),
      )
      .toSorted((left, right) => compareCanonicalText(left.localId, right.localId)),
    pathHints,
    ...(claims.rationale === undefined ? {} : { rationale: normalizeText(claims.rationale) }),
    omissions: {
      changedObjects: claims.omissions.changedObjects,
      relationships: claims.omissions.relationships,
      pathHints: claims.omissions.pathHints,
      ...(claims.omissions.note === undefined
        ? {}
        : { note: normalizeText(claims.omissions.note) }),
    },
  }
  return yield* decodeClaims(normalized).pipe(
    Effect.mapError((cause) =>
      toolError('architecture_plan_impact_upsert.normalize', 'invalid-publication', cause.message),
    ),
  )
})

function pathsForIndexes(
  pathHints: ReadonlyArray<string>,
  indexes: ReadonlyArray<number> | undefined,
): string[]
{
  return (indexes ?? []).map((index) => pathHints[index]!).filter((path) => path !== undefined)
}

function provisionalProjection(input: {
  readonly publicationId: PlannedImpactPublicationId
  readonly publicationRevision: number
  readonly contentDigest: ArchitecturePlannedImpactDigest
  readonly claims: ArchitecturePlanImpactClaims
  readonly createdAt: string
}): PlannedImpactMaterializedProjection
{
  const materialization = input.claims.outcome === 'no-impact' ? 'no-impact' : 'provisional'
  const projectionId = PlannedImpactProjectionId.make(
    `planned-projection-${sha256(`${input.publicationId}:1`)}`,
  )
  const nodeIdByLocalId = new Map(
    input.claims.changedObjects.map((object) => [
      object.localId,
      `planned:${input.contentDigest}:object:${object.localId}`,
    ]),
  )
  const nodes = input.claims.changedObjects.map((object, index) => ({
    id: nodeIdByLocalId.get(object.localId)!,
    localId: object.localId,
    label: object.label,
    semanticLevel: object.semanticLevel,
    state: object.state,
    ...(object.description === undefined ? {} : { description: object.description }),
    pathHints: pathsForIndexes(input.claims.pathHints, object.pathHintIndexes),
    position: {
      x: (index % 6) * 240,
      y: Math.floor(index / 6) * 160,
    },
    tintKey: sha256(object.localId).slice(0, 12),
  }))
  const edges = input.claims.relationships.map((relationship) => ({
    id: `planned:${input.contentDigest}:relationship:${relationship.localId}`,
    localId: relationship.localId,
    from: nodeIdByLocalId.get(relationship.fromLocalId)!,
    to: nodeIdByLocalId.get(relationship.toLocalId)!,
    relationshipKind: relationship.relationshipKind,
    state: relationship.state,
    ...(relationship.weight === undefined ? {} : { weight: relationship.weight }),
    ...(relationship.rationale === undefined ? {} : { rationale: relationship.rationale }),
    pathHints: pathsForIndexes(input.claims.pathHints, relationship.pathHintIndexes),
  }))
  return {
    version: 1,
    projectionId,
    projectionRevision: 1,
    materialization,
    publication: {
      publicationId: input.publicationId,
      publicationRevision: input.publicationRevision,
      contentDigest: input.contentDigest,
    },
    resultState: input.claims.outcome === 'no-impact' ? 'no-impact' : 'graph',
    summary: input.claims.summary,
    nodes,
    edges,
    standingScope: [],
    standingAnchors: [],
    createdAt: input.createdAt,
  }
}

export const make = Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient
  const admissions = yield* ArchitectureAdmissionRepository.ArchitectureAdmissionRepository
  const writeLock = yield* Semaphore.make(1)

  const decodePublicationRow = Effect.fn('PlannedImpactService.decodePublicationRow')(function* (
    row: PublicationRow,
  )
  {
    if (sha256(row.canonicalPayloadJson) !== row.contentDigest)
    {
      return yield* persistenceError(
        'PlannedImpactService.decodePublication',
        new Error('Stored Planned publication failed its content digest check.'),
      )
    }
    const claimsJson = yield* Effect.try({
      try: () => JSON.parse(row.canonicalPayloadJson) as unknown,
      catch: (cause) => persistenceError('PlannedImpactService.decodePublication', cause),
    })
    const claims = yield* decodeClaims(claimsJson).pipe(
      Effect.mapError((cause) => persistenceError('PlannedImpactService.decodePublication', cause)),
    )
    const plan: ArchitecturePlannedImpactPlanIdentity =
      row.planKind === 'plan'
        ? { _tag: 'plan', planId: row.planId! as never }
        : {
            _tag: 'orchestrate',
            runId: row.orchestrateRunId! as never,
            revision: row.orchestrateRevision!,
          }
    return yield* decodePublication({
      version: 1,
      publicationId: row.publicationId,
      publicationRevision: row.publicationRevision,
      contentDigest: row.contentDigest,
      environmentId: row.environmentId,
      projectId: row.projectId,
      sourceThreadId: row.sourceThreadId,
      turnId: row.turnId,
      producerSessionId: row.providerSessionId,
      producerInstanceId: row.providerInstanceId,
      plan,
      claims,
      supersedesPublicationId: row.supersedesPublicationId,
      createdAt: row.createdAt,
    }).pipe(
      Effect.mapError((cause) => persistenceError('PlannedImpactService.decodePublication', cause)),
    )
  })

  const decodeProjectionRow = Effect.fn('PlannedImpactService.decodeProjectionRow')(function* (
    row: ProjectionRow,
  )
  {
    const actualDigest = sha256(row.projectionJson)
    if (actualDigest !== row.projectionDigest)
    {
      return yield* persistenceError(
        'PlannedImpactService.decodeProjection',
        new Error('Stored Planned projection failed its content digest check.'),
      )
    }
    const parsed = yield* Effect.try({
      try: () => JSON.parse(row.projectionJson) as unknown,
      catch: (cause) => persistenceError('PlannedImpactService.decodeProjection', cause),
    })
    return yield* decodeProjection(parsed).pipe(
      Effect.mapError((cause) => persistenceError('PlannedImpactService.decodeProjection', cause)),
    )
  })

  const readStored = Effect.fn('PlannedImpactService.readStored')(function* (
    publicationId: PlannedImpactPublicationId,
  )
  {
    const publicationRows = yield* sql<PublicationRow>`
      SELECT ${sql.unsafe(publicationColumns)}
      FROM architecture_planned_impact_publications
      WHERE publication_id = ${publicationId}
      LIMIT 1
    `
    const publicationRow = publicationRows[0]
    if (publicationRow === undefined)
    {
      return yield* toolError(
        'PlannedImpactService.get',
        'not-found',
        'The exact Planned Impact publication does not exist.',
      )
    }
    const projectionRows = yield* sql<ProjectionRow>`
      SELECT ${sql.unsafe(projectionColumns)}
      FROM architecture_planned_impact_projections
      WHERE publication_id = ${publicationId}
      ORDER BY projection_revision
    `
    return {
      publication: yield* decodePublicationRow(publicationRow),
      projections: yield* Effect.forEach(projectionRows, decodeProjectionRow),
    } satisfies PlannedImpactStored
  })

  const get: PlannedImpactServiceShape['get'] = (publicationId) =>
    readStored(publicationId).pipe(
      Effect.mapError((cause) =>
        isArchitectureToolError(cause)
          ? cause
          : persistenceError('PlannedImpactService.get', cause),
      ),
    )

  const findLatestForAuthority: PlannedImpactServiceShape['findLatestForAuthority'] = Effect.fn(
    'PlannedImpactService.findLatestForAuthority',
  )(function* (input)
  {
    const rows = yield* sql<PublicationRow>`
        SELECT ${sql.unsafe(publicationColumns)}
        FROM architecture_planned_impact_publications
        WHERE environment_id = ${input.environmentId}
          AND project_id = ${input.projectId}
          AND source_thread_id = ${input.sourceThreadId}
          AND plan_identity_key = ${architecturePlanIdentityKey(input.plan)}
        ORDER BY publication_revision DESC
        LIMIT 1
      `.pipe(
      Effect.mapError((cause) =>
        persistenceError('PlannedImpactService.findLatestForAuthority', cause),
      ),
    )
    const row = rows[0]
    if (row === undefined) return null
    const stored = yield* readStored(PlannedImpactPublicationId.make(row.publicationId)).pipe(
      Effect.mapError((cause) =>
        isArchitectureToolError(cause)
          ? cause
          : persistenceError('PlannedImpactService.findLatestForAuthority', cause),
      ),
    )
    if (
      stored.publication.environmentId !== input.environmentId ||
      stored.publication.projectId !== input.projectId ||
      stored.publication.sourceThreadId !== input.sourceThreadId ||
      architecturePlanIdentityKey(stored.publication.plan) !==
        architecturePlanIdentityKey(input.plan)
    )
    {
      return yield* toolError(
        'PlannedImpactService.findLatestForAuthority',
        'identity-mismatch',
        'The stored Planned Impact authority does not match the authenticated request.',
      )
    }
    return stored
  })

  const upsertEffect = Effect.fn('PlannedImpactService.upsert')(function* (
    input: PlannedImpactUpsertRequest,
  )
  {
    const claims = yield* normalizeClaims(input.claims)
    const canonicalPayloadJson = stableJson(claims)
    const canonicalBytes = Buffer.byteLength(canonicalPayloadJson, 'utf8')
    if (canonicalBytes > ARCHITECTURE_PLANNED_IMPACT_CANONICAL_BYTES_LIMIT)
    {
      return yield* new ArchitectureToolError({
        operation: 'architecture_plan_impact_upsert',
        code: 'limit-exceeded',
        detail: `The canonical Planned Impact payload is ${canonicalBytes} bytes; the limit is ${ARCHITECTURE_PLANNED_IMPACT_CANONICAL_BYTES_LIMIT}.`,
        limit: {
          kind: 'bytes',
          scope: 'source',
          actual: canonicalBytes,
          limit: ARCHITECTURE_PLANNED_IMPACT_CANONICAL_BYTES_LIMIT,
        },
      })
    }
    const contentDigest = ArchitecturePlannedImpactDigest.make(sha256(canonicalPayloadJson))
    const planIdentityKey = architecturePlanIdentityKey(input.plan)
    const stored = yield* writeLock.withPermit(
      sql.withTransaction(
        Effect.gen(function* ()
        {
          const existingRows = yield* sql<PublicationRow>`
          SELECT ${sql.unsafe(publicationColumns)}
          FROM architecture_planned_impact_publications
          WHERE source_thread_id = ${input.sourceThreadId}
            AND plan_identity_key = ${planIdentityKey}
            AND content_digest = ${contentDigest}
          LIMIT 1
        `
          const existing = existingRows[0]
          if (existing !== undefined)
          {
            const exact = yield* readStored(PlannedImpactPublicationId.make(existing.publicationId))
            const projection = exact.projections.at(-1)!
            return {
              version: 1 as const,
              publication: {
                publicationId: exact.publication.publicationId,
                publicationRevision: exact.publication.publicationRevision,
                contentDigest: exact.publication.contentDigest,
              },
              plan: exact.publication.plan,
              projection: {
                projectionId: projection.projectionId,
                projectionRevision: projection.projectionRevision,
                materialization: projection.materialization,
              },
              anchoring:
                projection.materialization === 'no-impact'
                  ? ('not-required' as const)
                  : projection.materialization === 'anchored'
                    ? ('materialized' as const)
                    : ('reused' as const),
            }
          }

          const revisionRows = yield* sql<{
            readonly revision: number
            readonly supersedesPublicationId: string | null
          }>`
          SELECT
            COALESCE(MAX(publication_revision), 0) + 1 AS revision,
            (
              SELECT publication_id
              FROM architecture_planned_impact_publications
              WHERE source_thread_id = ${input.sourceThreadId}
                AND plan_identity_key = ${planIdentityKey}
              ORDER BY publication_revision DESC
              LIMIT 1
            ) AS "supersedesPublicationId"
          FROM architecture_planned_impact_publications
          WHERE source_thread_id = ${input.sourceThreadId}
            AND plan_identity_key = ${planIdentityKey}
        `
          const publicationRevision = revisionRows[0]?.revision ?? 1
          const supersedesPublicationId = revisionRows[0]?.supersedesPublicationId ?? null
          const publicationId = PlannedImpactPublicationId.make(
            `planned-impact-${sha256(`${input.environmentId}:${input.sourceThreadId}:${planIdentityKey}:${contentDigest}`)}`,
          )
          const createdAt = DateTime.formatIso(yield* DateTime.now)
          yield* sql`
          INSERT INTO architecture_planned_impact_publications (
            publication_id,
            environment_id,
            project_id,
            source_thread_id,
            turn_id,
            provider_session_id,
            provider_instance_id,
            plan_kind,
            plan_identity_key,
            plan_id,
            orchestrate_run_id,
            orchestrate_revision,
            publication_revision,
            content_digest,
            canonical_payload_json,
            supersedes_publication_id,
            created_at
          )
          VALUES (
            ${publicationId},
            ${input.environmentId},
            ${input.projectId},
            ${input.sourceThreadId},
            ${input.turnId},
            ${input.providerSessionId},
            ${input.providerInstanceId},
            ${input.plan._tag},
            ${planIdentityKey},
            ${input.plan._tag === 'plan' ? input.plan.planId : null},
            ${input.plan._tag === 'orchestrate' ? input.plan.runId : null},
            ${input.plan._tag === 'orchestrate' ? input.plan.revision : null},
            ${publicationRevision},
            ${contentDigest},
            ${canonicalPayloadJson},
            ${supersedesPublicationId},
            ${createdAt}
          )
        `
          const projection = provisionalProjection({
            publicationId,
            publicationRevision,
            contentDigest,
            claims,
            createdAt,
          })
          const projectionJson = stableJson(projection)
          yield* sql`
          INSERT INTO architecture_planned_impact_projections (
            projection_id,
            publication_id,
            publication_revision,
            projection_revision,
            materialization,
            projection_json,
            projection_digest,
            created_at
          )
          VALUES (
            ${projection.projectionId},
            ${publicationId},
            ${publicationRevision},
            ${projection.projectionRevision},
            ${projection.materialization},
            ${projectionJson},
            ${sha256(projectionJson)},
            ${createdAt}
          )
        `
          const admission = yield* admissions.enqueue({
            admissionKey: `planned-anchor:${publicationId}:${publicationRevision}`,
            target: {
              _tag: 'planned-anchor',
              version: 1,
              publicationId,
              publicationRevision,
              contentDigest,
              environmentId: input.environmentId,
              projectId: input.projectId,
              threadId: input.sourceThreadId,
              workspaceRoot: input.workspaceRoot,
            },
            state: claims.outcome === 'no-impact' ? 'complete' : 'queued',
            now: createdAt,
          })
          return {
            version: 1 as const,
            publication: {
              publicationId,
              publicationRevision,
              contentDigest,
            },
            plan: input.plan,
            projection: {
              projectionId: projection.projectionId,
              projectionRevision: projection.projectionRevision,
              materialization: projection.materialization,
            },
            anchoring:
              claims.outcome === 'no-impact'
                ? ('not-required' as const)
                : admission.reused
                  ? ('reused' as const)
                  : ('queued' as const),
          }
        }),
      ),
    )
    return yield* decodeUpsertResult(stored).pipe(
      Effect.mapError((cause) => persistenceError('PlannedImpactService.upsert', cause)),
      Effect.tap((result) =>
        increment(
          architectureAnalysisAdmissionsTotal,
          architectureAdmissionMetricAttributes(
            'planned-anchor',
            result.anchoring === 'queued'
              ? 'queued'
              : result.anchoring === 'not-required'
                ? 'complete'
                : 'reused',
          ),
        ),
      ),
    )
  })

  const upsert: PlannedImpactServiceShape['upsert'] = (input) =>
    upsertEffect(input).pipe(
      Effect.mapError((cause) =>
        isArchitectureToolError(cause)
          ? cause
          : persistenceError('PlannedImpactService.upsert', cause),
      ),
    )

  const appendAnchoredEffect = Effect.fn('PlannedImpactService.appendAnchored')(function* (
    input: Parameters<PlannedImpactServiceShape['appendAnchored']>[0],
  )
  {
    return yield* writeLock.withPermit(
      sql.withTransaction(
        Effect.gen(function* ()
        {
          if (
            !(yield* admissions.assertLeaseActive(
              input.leaseFence,
              `planned-anchor:${input.publicationId}:${input.publicationRevision}`,
            ))
          )
          {
            return yield* toolError(
              'PlannedImpactService.appendAnchored',
              'identity-mismatch',
              'The durable Planned anchor admission lease is no longer active.',
            )
          }
          const stored = yield* readStored(input.publicationId)
          if (stored.publication.publicationRevision !== input.publicationRevision)
          {
            return yield* toolError(
              'PlannedImpactService.appendAnchored',
              'identity-mismatch',
              'The Planned anchor admission does not match the publication revision.',
            )
          }
          const existing = stored.projections.find(
            (projection) =>
              projection.materialization === 'anchored' &&
              projection.standingSource !== undefined &&
              projection.standingSource.generationId === input.standingSource.generationId &&
              projection.standingSource.graphDigest === input.standingSource.graphDigest,
          )
          if (existing !== undefined) return existing
          const previous = stored.projections.at(-1)
          if (previous === undefined || previous.resultState === 'no-impact')
          {
            return yield* toolError(
              'PlannedImpactService.appendAnchored',
              'identity-mismatch',
              'A no-impact or missing projection cannot be anchored.',
            )
          }
          const projectionRevision = previous.projectionRevision + 1
          const projectionId = PlannedImpactProjectionId.make(
            `planned-projection-${sha256(`${input.publicationId}:${projectionRevision}:${input.standingSource.generationId}`)}`,
          )
          const projection = yield* decodeProjection({
            ...previous,
            projectionId,
            projectionRevision,
            materialization: 'anchored',
            standingSource: input.standingSource,
            standingScope: [...input.standingScope],
            nodes: [...input.nodes],
            edges: [...input.edges],
            standingAnchors: [...input.standingAnchors],
            createdAt: input.createdAt,
          }).pipe(
            Effect.mapError((cause) =>
              toolError(
                'PlannedImpactService.appendAnchored',
                'invalid-publication',
                cause.message,
              ),
            ),
          )
          const projectionJson = stableJson(projection)
          yield* sql`
          INSERT INTO architecture_planned_impact_projections (
            projection_id,
            publication_id,
            publication_revision,
            projection_revision,
            materialization,
            projection_json,
            projection_digest,
            standing_generation_id,
            standing_graph_digest,
            created_at
          )
          VALUES (
            ${projectionId},
            ${stored.publication.publicationId},
            ${stored.publication.publicationRevision},
            ${projectionRevision},
            'anchored',
            ${projectionJson},
            ${sha256(projectionJson)},
            ${input.standingSource.generationId},
            ${input.standingSource.graphDigest},
            ${input.createdAt}
          )
        `
          return projection
        }),
      ),
    )
  })

  const appendAnchored: PlannedImpactServiceShape['appendAnchored'] = (input) =>
    appendAnchoredEffect(input).pipe(
      Effect.mapError((cause) =>
        isArchitectureToolError(cause)
          ? cause
          : persistenceError('PlannedImpactService.appendAnchored', cause),
      ),
    )

  return PlannedImpactService.of({ upsert, get, findLatestForAuthority, appendAnchored })
})

export const layer = Layer.effect(PlannedImpactService, make).pipe(
  Layer.provide(ArchitectureAdmissionRepository.layer),
)
