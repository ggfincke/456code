// tests/packages/contracts/plannedArchitectureImpact.test.ts
// verifies bounded planned-impact claims and exact immutable identities

import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vite-plus/test'

import {
  ARCHITECTURE_PLANNED_IMPACT_CANONICAL_BYTES_LIMIT,
  ARCHITECTURE_PLANNED_IMPACT_CHANGED_OBJECT_LIMIT,
  ARCHITECTURE_PLANNED_IMPACT_PATH_HINT_LIMIT,
  ARCHITECTURE_PLANNED_IMPACT_RELATIONSHIP_LIMIT,
  ArchitecturePlanImpactClaims,
  ArchitecturePlanImpactUpsertInput,
  PlannedImpactPublicationRef,
} from '../../../packages/contracts/src/index.ts'

const strictDecode = <A>(schema: Schema.Decoder<A, never>) =>
  Schema.decodeUnknownSync(schema, {
    errors: 'all',
    onExcessProperty: 'error',
  })

const changedClaims = {
  version: 1,
  summary: 'The API package will expose the new session service.',
  outcome: 'changed',
  changedObjects: [
    {
      localId: 'api',
      label: 'Public API',
      semanticLevel: 'block',
      state: 'affected',
      pathHintIndexes: [0],
    },
    {
      localId: 'session',
      label: 'Session service',
      semanticLevel: 'block',
      state: 'added',
      pathHintIndexes: [1],
    },
  ],
  relationships: [
    {
      localId: 'api-session',
      fromLocalId: 'api',
      toLocalId: 'session',
      relationshipKind: 'exposes',
      state: 'added',
      pathHintIndexes: [0, 1],
    },
  ],
  pathHints: ['packages/api/src/index.ts', 'packages/session/src/service.ts'],
  rationale: 'The plan adds one public dependency edge.',
  omissions: {
    changedObjects: { total: 2, omitted: 0 },
    relationships: { total: 1, omitted: 0 },
    pathHints: { total: 2, omitted: 0 },
  },
} as const

describe('planned architecture impact contracts', () =>
{
  it('pins the provider and canonical payload limits', () =>
  {
    expect({
      objects: ARCHITECTURE_PLANNED_IMPACT_CHANGED_OBJECT_LIMIT,
      relationships: ARCHITECTURE_PLANNED_IMPACT_RELATIONSHIP_LIMIT,
      paths: ARCHITECTURE_PLANNED_IMPACT_PATH_HINT_LIMIT,
      canonicalBytes: ARCHITECTURE_PLANNED_IMPACT_CANONICAL_BYTES_LIMIT,
    }).toEqual({
      objects: 60,
      relationships: 120,
      paths: 100,
      canonicalBytes: 262_144,
    })
  })

  it('accepts changed and exact no-impact claims', () =>
  {
    const decodeClaims = strictDecode(ArchitecturePlanImpactClaims)
    expect(decodeClaims(changedClaims)).toEqual(changedClaims)
    expect(
      decodeClaims({
        version: 1,
        summary: 'The implementation stays inside the existing block.',
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
    ).toMatchObject({ outcome: 'no-impact', changedObjects: [], relationships: [] })
  })

  it('rejects spoofed authority fields and unsafe repository paths', () =>
  {
    const decodeInput = strictDecode(ArchitecturePlanImpactUpsertInput)
    expect(() =>
      decodeInput({
        ...changedClaims,
        environmentId: 'attacker-environment',
      }),
    ).toThrow()

    for (const path of ['/absolute.ts', '../escape.ts', 'src\\windows.ts', 'src/./dot.ts'])
    {
      expect(() =>
        decodeInput({
          ...changedClaims,
          pathHints: [path, 'packages/session/src/service.ts'],
        }),
      ).toThrow()
    }
  })

  it('rejects duplicate identities, dangling endpoints, and invalid path references', () =>
  {
    const decodeClaims = strictDecode(ArchitecturePlanImpactClaims)
    expect(() =>
      decodeClaims({
        ...changedClaims,
        changedObjects: [changedClaims.changedObjects[0], changedClaims.changedObjects[0]],
      }),
    ).toThrow()
    expect(() =>
      decodeClaims({
        ...changedClaims,
        relationships: [
          {
            ...changedClaims.relationships[0],
            toLocalId: 'missing',
          },
        ],
      }),
    ).toThrow()
    expect(() =>
      decodeClaims({
        ...changedClaims,
        changedObjects: [
          {
            ...changedClaims.changedObjects[0],
            pathHintIndexes: [2],
          },
        ],
        relationships: [],
        omissions: {
          ...changedClaims.omissions,
          changedObjects: { total: 1, omitted: 0 },
          relationships: { total: 0, omitted: 0 },
        },
      }),
    ).toThrow()
  })

  it('rejects control characters from publication text and identities', () =>
  {
    const decodeClaims = strictDecode(ArchitecturePlanImpactClaims)
    expect(() => decodeClaims({ ...changedClaims, summary: 'unsafe\u0000summary' })).toThrow()
    expect(() =>
      decodeClaims({
        ...changedClaims,
        changedObjects: [
          { ...changedClaims.changedObjects[0], localId: 'api\nspoofed' },
          changedClaims.changedObjects[1],
        ],
        relationships: [{ ...changedClaims.relationships[0], fromLocalId: 'api\nspoofed' }],
      }),
    ).toThrow()
  })

  it('rejects false totals, fabricated no-impact graphs, and empty changed results', () =>
  {
    const decodeClaims = strictDecode(ArchitecturePlanImpactClaims)
    expect(() =>
      decodeClaims({
        ...changedClaims,
        omissions: {
          ...changedClaims.omissions,
          changedObjects: { total: 3, omitted: 0 },
        },
      }),
    ).toThrow()
    expect(() => decodeClaims({ ...changedClaims, outcome: 'no-impact' })).toThrow()
    expect(() =>
      decodeClaims({
        ...changedClaims,
        outcome: 'changed',
        changedObjects: [],
        relationships: [],
        omissions: {
          changedObjects: { total: 0, omitted: 0 },
          relationships: { total: 0, omitted: 0 },
          pathHints: { total: 2, omitted: 0 },
        },
      }),
    ).toThrow()
  })

  it('enforces every publication cardinality bound', () =>
  {
    const decodeClaims = strictDecode(ArchitecturePlanImpactClaims)
    const objects = Array.from(
      { length: ARCHITECTURE_PLANNED_IMPACT_CHANGED_OBJECT_LIMIT + 1 },
      (_, index) => ({
        localId: `object-${index}`,
        label: `Object ${index}`,
        semanticLevel: 'file',
        state: 'affected',
      }),
    )
    expect(() =>
      decodeClaims({
        ...changedClaims,
        changedObjects: objects,
        relationships: [],
        omissions: {
          ...changedClaims.omissions,
          changedObjects: { total: objects.length, omitted: 0 },
          relationships: { total: 0, omitted: 0 },
        },
      }),
    ).toThrow()

    const relationships = Array.from(
      { length: ARCHITECTURE_PLANNED_IMPACT_RELATIONSHIP_LIMIT + 1 },
      (_, index) => ({
        ...changedClaims.relationships[0],
        localId: `relationship-${index}`,
      }),
    )
    expect(() =>
      decodeClaims({
        ...changedClaims,
        relationships,
        omissions: {
          ...changedClaims.omissions,
          relationships: { total: relationships.length, omitted: 0 },
        },
      }),
    ).toThrow()

    const paths = Array.from(
      { length: ARCHITECTURE_PLANNED_IMPACT_PATH_HINT_LIMIT + 1 },
      (_, index) => `src/path-${index}.ts`,
    )
    expect(() =>
      decodeClaims({
        ...changedClaims,
        pathHints: paths,
        omissions: {
          ...changedClaims.omissions,
          pathHints: { total: paths.length, omitted: 0 },
        },
      }),
    ).toThrow()
  })

  it('accepts only exact immutable publication references', () =>
  {
    const decodeRef = strictDecode(PlannedImpactPublicationRef)
    expect(
      decodeRef({
        publicationId: 'planned-impact-contract',
        publicationRevision: 2,
        contentDigest: 'a'.repeat(64),
      }),
    ).toMatchObject({ publicationRevision: 2 })
    expect(() =>
      decodeRef({
        publicationId: 'planned-impact-contract',
        publicationRevision: 0,
        contentDigest: 'sha256:not-a-bare-digest',
      }),
    ).toThrow()
  })
})
