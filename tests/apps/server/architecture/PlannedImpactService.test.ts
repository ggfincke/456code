// tests/apps/server/architecture/PlannedImpactService.test.ts
// verifies immutable planned publications, canonical retries, and projections

import { it } from '@effect/vitest'
import {
  ArchitecturePlanImpactClaims,
  EnvironmentId,
  OrchestrationProposedPlanId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import { describe, expect } from 'vite-plus/test'

import * as PlannedImpactService from '../../../../apps/server/src/architecture/PlannedImpactService.ts'
import * as ArchitectureAdmissionRepository from '../../../../apps/server/src/architecture/ArchitectureAdmissionRepository.ts'
import { PersistenceSqlError } from '../../../../apps/server/src/persistence/Errors.ts'
import { SqlitePersistenceMemory } from '../../../../apps/server/src/persistence/Layers/Sqlite.ts'

const decodeClaims = Schema.decodeUnknownSync(ArchitecturePlanImpactClaims, {
  errors: 'all',
  onExcessProperty: 'error',
})

const authority = {
  environmentId: EnvironmentId.make('environment-planned-impact-service'),
  projectId: ProjectId.make('project-planned-impact-service'),
  sourceThreadId: ThreadId.make('thread-planned-impact-service'),
  turnId: TurnId.make('turn-planned-impact-service'),
  providerSessionId: 'provider-session-planned-impact-service',
  providerInstanceId: ProviderInstanceId.make('codex'),
  plan: {
    _tag: 'plan' as const,
    planId: OrchestrationProposedPlanId.make(
      'plan:thread-planned-impact-service:turn:turn-planned-impact-service',
    ),
  },
  workspaceRoot: '/workspace/planned-impact-service',
}

const claims = decodeClaims({
  version: 1,
  summary: 'The session block becomes a public dependency of the API block.',
  outcome: 'changed',
  changedObjects: [
    {
      localId: 'session',
      label: 'Session',
      semanticLevel: 'block',
      state: 'added',
      pathHintIndexes: [0],
    },
    {
      localId: 'api',
      label: 'API',
      semanticLevel: 'block',
      state: 'affected',
      pathHintIndexes: [1],
    },
  ],
  relationships: [
    {
      localId: 'api-session',
      fromLocalId: 'api',
      toLocalId: 'session',
      relationshipKind: 'imports',
      state: 'added',
      pathHintIndexes: [1, 0],
    },
  ],
  pathHints: ['packages/session/src/index.ts', 'packages/api/src/index.ts'],
  omissions: {
    changedObjects: { total: 2, omitted: 0 },
    relationships: { total: 1, omitted: 0 },
    pathHints: { total: 2, omitted: 0 },
  },
})

const layer = it.layer(
  Layer.mergeAll(PlannedImpactService.layer, ArchitectureAdmissionRepository.layer).pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
)

layer('PlannedImpactService', (it) =>
{
  describe('publication identity', () =>
  {
    it.effect('canonicalizes retries and appends changed immutable revisions', () =>
      Effect.gen(function* ()
      {
        const service = yield* PlannedImpactService.PlannedImpactService
        const admissions = yield* ArchitectureAdmissionRepository.ArchitectureAdmissionRepository
        const sql = yield* SqlClient.SqlClient
        const first = yield* service.upsert({ ...authority, claims })
        expect(first).toMatchObject({
          publication: { publicationRevision: 1 },
          projection: { projectionRevision: 1, materialization: 'provisional' },
          anchoring: 'queued',
        })

        const reorderedClaims = decodeClaims({
          ...claims,
          changedObjects: [
            { ...claims.changedObjects[1], pathHintIndexes: [0] },
            { ...claims.changedObjects[0], pathHintIndexes: [1] },
          ],
          pathHints: ['packages/api/src/index.ts', 'packages/session/src/index.ts'],
          relationships: [{ ...claims.relationships[0], pathHintIndexes: [0, 1] }],
        })
        const retries = yield* Effect.all(
          Array.from({ length: 8 }, () =>
            service.upsert({ ...authority, claims: reorderedClaims }),
          ),
          { concurrency: 'unbounded' },
        )
        for (const retry of retries)
        {
          expect(retry.publication).toEqual(first.publication)
          expect(retry.projection).toEqual(first.projection)
          expect(retry.anchoring).toBe('reused')
        }

        const stored = yield* service.get(first.publication.publicationId)
        expect(stored.publication.claims.pathHints).toEqual([
          'packages/api/src/index.ts',
          'packages/session/src/index.ts',
        ])
        expect(stored.publication.claims.changedObjects.map((object) => object.localId)).toEqual([
          'api',
          'session',
        ])
        expect(
          stored.projections[0]?.nodes.every((node) =>
            node.id.startsWith(`planned:${first.publication.contentDigest}:object:`),
          ),
        ).toBe(true)
        expect(
          stored.projections[0]?.edges.every((edge) =>
            edge.id.startsWith(`planned:${first.publication.contentDigest}:relationship:`),
          ),
        ).toBe(true)

        const leased = yield* admissions.leaseForExplicitStart({
          admissionKey: `planned-anchor:${first.publication.publicationId}:1`,
          ownerId: 'planned-impact-test-worker',
          leaseExpiresAt: '2099-08-20T12:00:30.000Z',
          now: '2026-08-20T12:00:00.000Z',
        })
        if (leased === null)
        {
          return yield* Effect.die('expected the Planned anchor admission to be leaseable')
        }
        const leaseFence = {
          admissionId: leased.admissionId,
          ownerId: 'planned-impact-test-worker',
          leaseEpoch: leased.leaseEpoch,
        }

        const anchored = yield* service.appendAnchored({
          publicationId: first.publication.publicationId,
          publicationRevision: first.publication.publicationRevision,
          standingSource: {
            projectId: authority.projectId,
            generationId: 'b'.repeat(64),
            graphDigest: `sha256:${'c'.repeat(64)}`,
            builtAt: '2026-08-20T12:00:00.000Z',
          },
          standingScope: [
            {
              role: 'touched',
              level: 'blocks',
              id: 'block-api',
              key: 'api',
              label: 'API',
            },
          ],
          nodes: stored.projections[0]!.nodes,
          edges: stored.projections[0]!.edges,
          standingAnchors: [
            ...stored.projections[0]!.nodes.map((node) => ({
              selectionKind: 'object' as const,
              localId: node.localId,
              status: 'unmatched' as const,
              lens: 'structure' as const,
              candidateIds: [],
              candidateCount: { total: 0, returned: 0, omitted: 0 },
              disclosure: 'Not present in this repository generation.',
            })),
            ...stored.projections[0]!.edges.map((edge) => ({
              selectionKind: 'relationship' as const,
              localId: edge.localId,
              status: 'unmatched' as const,
              lens: 'architecture' as const,
              candidateIds: [],
              candidateCount: { total: 0, returned: 0, omitted: 0 },
              disclosure: 'No common standing relationship anchor exists.',
            })),
          ],
          leaseFence,
          createdAt: '2026-08-20T12:00:01.000Z',
        })
        expect(anchored).toMatchObject({ projectionRevision: 2, materialization: 'anchored' })
        const repeatedAnchor = yield* service.appendAnchored({
          publicationId: first.publication.publicationId,
          publicationRevision: first.publication.publicationRevision,
          standingSource: anchored.standingSource!,
          standingScope: anchored.standingScope,
          nodes: anchored.nodes,
          edges: anchored.edges,
          standingAnchors: anchored.standingAnchors ?? [],
          leaseFence,
          createdAt: '2026-08-20T12:00:02.000Z',
        })
        expect(repeatedAnchor.projectionId).toBe(anchored.projectionId)

        const changedClaims = {
          ...claims,
          summary: 'A later interpretation changes the public API.',
        }
        const [changed, changedRetry] = yield* Effect.all(
          [
            service.upsert({ ...authority, claims: changedClaims }),
            service.upsert({ ...authority, claims: changedClaims }),
          ],
          { concurrency: 'unbounded' },
        )
        expect(changed.publication.publicationRevision).toBe(2)
        expect(changedRetry.publication).toEqual(changed.publication)
        expect(changed.publication.publicationId).not.toBe(first.publication.publicationId)
        const changedStored = yield* service.get(changed.publication.publicationId)
        expect(changedStored.publication.supersedesPublicationId).toBe(
          first.publication.publicationId,
        )

        const counts = yield* sql<{
          readonly publications: number
          readonly projections: number
          readonly admissions: number
        }>`
          SELECT
            (SELECT COUNT(*) FROM architecture_planned_impact_publications) AS publications,
            (SELECT COUNT(*) FROM architecture_planned_impact_projections) AS projections,
            (SELECT COUNT(*) FROM architecture_analysis_admissions) AS admissions
        `
        expect(counts[0]).toEqual({ publications: 2, projections: 3, admissions: 2 })
      }),
    )

    it.effect('materializes no-impact immediately without an anchor build', () =>
      Effect.gen(function* ()
      {
        const service = yield* PlannedImpactService.PlannedImpactService
        const repository = yield* ArchitectureAdmissionRepository.ArchitectureAdmissionRepository
        const sql = yield* SqlClient.SqlClient
        const noImpact = yield* service.upsert({
          ...authority,
          plan: {
            _tag: 'plan',
            planId: OrchestrationProposedPlanId.make(
              'plan:thread-planned-impact-service:turn:turn-no-impact',
            ),
          },
          claims: decodeClaims({
            version: 1,
            summary: 'The plan is contained inside the existing implementation unit.',
            outcome: 'no-impact',
            changedObjects: [],
            relationships: [],
            pathHints: ['packages/api/src/internal.ts'],
            omissions: {
              changedObjects: { total: 0, omitted: 0 },
              relationships: { total: 0, omitted: 0 },
              pathHints: { total: 1, omitted: 0 },
            },
          }),
        })
        expect(noImpact).toMatchObject({
          projection: { materialization: 'no-impact' },
          anchoring: 'not-required',
        })
        const admissions = yield* sql<{ readonly state: string }>`
          SELECT state
          FROM architecture_analysis_admissions
          WHERE admission_key = ${`planned-anchor:${noImpact.publication.publicationId}:1`}
        `
        expect(admissions).toEqual([{ state: 'complete' }])
        const admission = (yield* repository.list).find(
          (candidate) =>
            candidate.admissionKey === `planned-anchor:${noImpact.publication.publicationId}:1`,
        )!

        const rejected = yield* service
          .appendAnchored({
            publicationId: noImpact.publication.publicationId,
            publicationRevision: noImpact.publication.publicationRevision,
            standingSource: {
              projectId: authority.projectId,
              generationId: 'd'.repeat(64),
              graphDigest: `sha256:${'e'.repeat(64)}`,
              builtAt: '2026-08-20T12:00:00.000Z',
            },
            standingScope: [],
            nodes: [],
            edges: [],
            standingAnchors: [],
            leaseFence: {
              admissionId: admission.admissionId,
              ownerId: 'planned-impact-test-worker',
              leaseEpoch: admission.leaseEpoch,
            },
            createdAt: '2026-08-20T12:00:01.000Z',
          })
          .pipe(Effect.flip)
        expect(rejected.code).toBe('identity-mismatch')
      }),
    )

    it.effect('rejects an anchored projection after its claimed admission is cancelled', () =>
      Effect.gen(function* ()
      {
        const service = yield* PlannedImpactService.PlannedImpactService
        const repository = yield* ArchitectureAdmissionRepository.ArchitectureAdmissionRepository
        const published = yield* service.upsert({
          ...authority,
          plan: {
            _tag: 'plan',
            planId: OrchestrationProposedPlanId.make(
              'plan:thread-planned-impact-service:turn:turn-cancelled-anchor',
            ),
          },
          claims,
        })
        const leased = yield* repository.leaseForExplicitStart({
          admissionKey: `planned-anchor:${published.publication.publicationId}:1`,
          ownerId: 'planned-impact-cancelled-worker',
          leaseExpiresAt: '2099-08-20T12:10:30.000Z',
          now: '2026-08-20T12:10:00.000Z',
        })
        if (leased === null)
        {
          return yield* Effect.die('expected the Planned anchor admission to be leaseable')
        }
        yield* repository.cancelThread({
          threadId: authority.sourceThreadId,
          now: '2026-08-20T12:10:01.000Z',
        })

        const rejected = yield* service
          .appendAnchored({
            publicationId: published.publication.publicationId,
            publicationRevision: published.publication.publicationRevision,
            standingSource: {
              projectId: authority.projectId,
              generationId: 'f'.repeat(64),
              graphDigest: `sha256:${'a'.repeat(64)}`,
              builtAt: '2026-08-20T12:10:02.000Z',
            },
            standingScope: [],
            nodes: [],
            edges: [],
            standingAnchors: [],
            leaseFence: {
              admissionId: leased.admissionId,
              ownerId: 'planned-impact-cancelled-worker',
              leaseEpoch: leased.leaseEpoch,
            },
            createdAt: '2026-08-20T12:10:03.000Z',
          })
          .pipe(Effect.flip)
        expect(rejected.code).toBe('identity-mismatch')
        expect((yield* service.get(published.publication.publicationId)).projections).toHaveLength(
          1,
        )
      }),
    )

    it.effect('rejects an oversized canonical publication before any insert', () =>
      Effect.gen(function* ()
      {
        const service = yield* PlannedImpactService.PlannedImpactService
        const sql = yield* SqlClient.SqlClient
        const objects = Array.from({ length: 60 }, (_, index) => ({
          localId: `object-${index}`,
          label: `Object ${index}`,
          semanticLevel: 'file',
          state: 'affected' as const,
          description: 'o'.repeat(2_000),
        }))
        const relationships = Array.from({ length: 120 }, (_, index) => ({
          localId: `relationship-${index}`,
          fromLocalId: `object-${index % objects.length}`,
          toLocalId: `object-${(index + 1) % objects.length}`,
          relationshipKind: 'imports',
          state: 'affected' as const,
          rationale: 'r'.repeat(2_000),
        }))
        const oversizedClaims = decodeClaims({
          version: 1,
          summary: 'Bounded fields can still exceed the aggregate canonical payload limit.',
          outcome: 'changed',
          changedObjects: objects,
          relationships,
          pathHints: [],
          rationale: 'x'.repeat(16_000),
          omissions: {
            changedObjects: { total: objects.length, omitted: 0 },
            relationships: { total: relationships.length, omitted: 0 },
            pathHints: { total: 0, omitted: 0 },
          },
        })
        const rejected = yield* service
          .upsert({
            ...authority,
            plan: {
              _tag: 'plan',
              planId: OrchestrationProposedPlanId.make(
                'plan:thread-planned-impact-service:turn:turn-oversized',
              ),
            },
            claims: oversizedClaims,
          })
          .pipe(Effect.flip)
        expect(rejected).toMatchObject({ code: 'limit-exceeded' })
        const rows = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count
          FROM architecture_planned_impact_publications
          WHERE plan_identity_key LIKE '%turn-oversized'
        `
        expect(rows).toEqual([{ count: 0 }])
      }),
    )

    it.effect('rolls back publication and projection when durable admission fails', () =>
      Effect.gen(function* ()
      {
        const liveAdmissions =
          yield* ArchitectureAdmissionRepository.ArchitectureAdmissionRepository
        const failingAdmissions =
          ArchitectureAdmissionRepository.ArchitectureAdmissionRepository.of({
            ...liveAdmissions,
            enqueue: () =>
              Effect.fail(
                new PersistenceSqlError({
                  operation: 'PlannedImpactService.test.enqueue',
                  detail: 'forced admission failure',
                }),
              ),
          })
        const service = yield* PlannedImpactService.make.pipe(
          Effect.provideService(
            ArchitectureAdmissionRepository.ArchitectureAdmissionRepository,
            failingAdmissions,
          ),
        )
        const sql = yield* SqlClient.SqlClient
        const planId = OrchestrationProposedPlanId.make(
          'plan:thread-planned-impact-service:turn:turn-admission-rollback',
        )

        const rejected = yield* service
          .upsert({
            ...authority,
            plan: { _tag: 'plan', planId },
            claims,
          })
          .pipe(Effect.flip)
        expect(rejected).toMatchObject({ code: 'persistence-failed' })
        const rows = yield* sql<{
          readonly publications: number
          readonly projections: number
        }>`
          SELECT
            (
              SELECT COUNT(*)
              FROM architecture_planned_impact_publications
              WHERE plan_identity_key = ${`plan:${planId}`}
            ) AS publications,
            (
              SELECT COUNT(*)
              FROM architecture_planned_impact_projections AS projection
              JOIN architecture_planned_impact_publications AS publication
                ON publication.publication_id = projection.publication_id
              WHERE publication.plan_identity_key = ${`plan:${planId}`}
            ) AS projections
        `
        expect(rows).toEqual([{ publications: 0, projections: 0 }])
      }),
    )
  })
})
