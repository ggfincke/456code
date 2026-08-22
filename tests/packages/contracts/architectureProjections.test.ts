// tests/packages/contracts/architectureProjections.test.ts
// verifies exact graph projection authority, identities, and fail-closed invariants

import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vite-plus/test'

import {
  ArchitectureGraphProjection,
  ArchitectureGraphProjectionEvidence,
  ArchitectureImpactDescriptor,
  ArchitectureImpactProjectionResult,
} from '../../../packages/contracts/src/architectureProjections.ts'

const decode = <A>(schema: Schema.Decoder<A, never>) =>
  Schema.decodeUnknownSync(schema, { errors: 'all', onExcessProperty: 'error' })

const generatedAt = '2026-08-20T12:00:00.000Z'
const plan = {
  _tag: 'plan' as const,
  planId: 'plan:thread-projection-contract:turn:turn-projection-contract',
}
const plannedSource = {
  kind: 'planned-impact' as const,
  environmentId: 'environment-projection-contract',
  projectId: 'project-projection-contract',
  threadId: 'thread-projection-contract',
  plan,
  publication: {
    publicationId: 'planned-publication-projection-contract',
    publicationRevision: 1,
    contentDigest: '1'.repeat(64),
  },
  projection: {
    projectionId: 'planned-projection-contract',
    projectionRevision: 1,
    materialization: 'provisional' as const,
  },
}
const verifiedSource = {
  kind: 'verified-proposal-impact' as const,
  threadId: 'thread-projection-contract',
  generationId: 'generation-projection-contract',
  proposalId: 'proposal-projection-contract',
  revisionId: 'revision-projection-contract',
  baseTreeOid: '2'.repeat(40),
  headTreeOid: '3'.repeat(40),
  baseGraphDigest: `sha256:${'4'.repeat(64)}` as const,
  headGraphDigest: `sha256:${'5'.repeat(64)}` as const,
  projectionDigest: `sha256:${'6'.repeat(64)}` as const,
}
const descriptor = {
  version: 1 as const,
  descriptorId: '7'.repeat(64),
  threadId: 'thread-projection-contract',
  projectId: 'project-projection-contract',
  target: { kind: 'plan' as const, plan, state: 'active' as const },
  plannedCandidate: {
    authority: 'planned' as const,
    source: plannedSource,
    projectionId: plannedSource.projection.projectionId,
    projectionRevision: 1,
    resultState: 'graph' as const,
    freshness: 'fresh' as const,
    generatedAt,
    publishedAt: generatedAt,
  },
  verifiedCandidate: {
    authority: 'verified' as const,
    source: verifiedSource,
    projectionId: 'verified-projection-contract',
    projectionRevision: 1,
    projectionDigest: verifiedSource.projectionDigest,
    resultState: 'no-impact' as const,
    freshness: 'stale' as const,
    generatedAt,
    publishedAt: generatedAt,
  },
  defaultAuthority: 'verified' as const,
  resolvedAt: generatedAt,
}
const verifiedNoImpact = {
  projectionVersion: 1 as const,
  projectionId: 'verified-projection-contract',
  projectionRevision: 1,
  kind: 'impact-diff' as const,
  authority: 'verified' as const,
  resultState: 'no-impact' as const,
  freshness: 'stale' as const,
  generatedAt,
  publishedAt: generatedAt,
  source: verifiedSource,
  lens: 'structure' as const,
  semanticLevel: 'files' as const,
  breadcrumbs: [],
  layoutVersion: 'semantic-impact-v1',
  totals: {
    nodes: { total: 0, returned: 0, omitted: 0 },
    edges: { total: 0, returned: 0, omitted: 0 },
    evidence: { total: 0, returned: 0, omitted: 0 },
    changedFiles: { total: 1, returned: 0, omitted: 1 },
  },
  nodes: [],
  edges: [],
  evidence: [],
  anchors: [],
}

describe('architecture graph projection contracts', () =>
{
  it('defaults to exact Verified authority while retaining immutable Planned access', () =>
  {
    const decodedDescriptor = decode(ArchitectureImpactDescriptor)(descriptor)
    expect(decodedDescriptor.defaultAuthority).toBe('verified')
    expect(decodedDescriptor.plannedCandidate?.source).toEqual(plannedSource)
    expect(
      decode(ArchitectureImpactProjectionResult)({
        version: 1,
        descriptor,
        selectedAuthority: 'verified',
        projection: verifiedNoImpact,
      }),
    ).toMatchObject({
      selectedAuthority: 'verified',
      projection: { resultState: 'no-impact', freshness: 'stale' },
    })
  })

  it('rejects authority drift, fabricated no-impact totals, and dangling source-side refs', () =>
  {
    expect(() =>
      decode(ArchitectureImpactDescriptor)({
        ...descriptor,
        plannedCandidate: undefined,
        defaultAuthority: 'planned',
      }),
    ).toThrow()
    expect(() =>
      decode(ArchitectureGraphProjection)({
        ...verifiedNoImpact,
        totals: {
          ...verifiedNoImpact.totals,
          nodes: { total: 1, returned: 0, omitted: 1 },
        },
      }),
    ).toThrow()
    expect(() =>
      decode(ArchitectureImpactProjectionResult)({
        version: 1,
        descriptor,
        selectedAuthority: 'planned',
        projection: verifiedNoImpact,
      }),
    ).toThrow()
    expect(() =>
      decode(ArchitectureGraphProjectionEvidence)({
        id: `evidence:${'8'.repeat(64)}`,
        kind: 'file',
        state: 'affected',
        label: 'Changed source',
        paths: ['src/value.ts'],
        pathRefs: [{ path: 'src/other.ts', side: 'head' }],
      }),
    ).toThrow()
  })
})
