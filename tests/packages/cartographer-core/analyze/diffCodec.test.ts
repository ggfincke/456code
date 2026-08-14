// tests/packages/cartographer-core/analyze/diffCodec.test.ts
// verifies sealed graph diffs decode as one strict complete artifact

import { describe, expect, it } from 'vite-plus/test'

import { parseGraphDiff } from '../../../../packages/cartographer-core/src/analyze/diffCodec.ts'
import type { GraphDiff } from '../../../../packages/cartographer-core/src/analyze/diff.ts'

const sealedDiff: GraphDiff = {
  baseGeneratedAt: '2026-08-09T00:00:00.000Z',
  headGeneratedAt: '2026-08-09T00:00:01.000Z',
  baseGitRef: '1'.repeat(40),
  headGitRef: '2'.repeat(40),
  addedNodes: ['src/added.ts'],
  removedNodes: ['src/removed.ts'],
  addedEdges: [{ from: 'src/consumer.ts', to: 'src/added.ts' }],
  removedEdges: [{ from: 'src/consumer.ts', to: 'src/removed.ts' }],
  movedNodes: [{ from: 'src/old.ts', to: 'src/new.ts' }],
  moveFlows: [{ from: 'src/old', to: 'src/new', count: 1 }],
  movedEdges: 2,
  apiChanges: [
    {
      file: 'src/api.ts',
      addedExports: [{ name: 'added', typeOnly: true }],
      removedExports: [{ name: 'removed', brokenConsumers: ['src/consumer.ts'] }],
    },
  ],
  newViolations: [
    {
      from: 'src/consumer.ts',
      to: 'src/added.ts',
      rule: 'runtime-boundary',
      severity: 'error',
    },
  ],
  resolvedViolations: [
    {
      from: 'src/consumer.ts',
      to: 'src/removed.ts',
      rule: 'legacy-boundary',
      severity: 'warn',
    },
  ],
  changed: true,
}

describe('parseGraphDiff', () =>
{
  it('round-trips the complete sealed artifact shape', () =>
  {
    expect(parseGraphDiff(sealedDiff)).toEqual(sealedDiff)
  })

  it('rejects partial, extended, and malformed nested artifacts', () =>
  {
    const { headGeneratedAt: _missing, ...partial } = sealedDiff
    expect(() => parseGraphDiff(partial)).toThrow()
    expect(() => parseGraphDiff({ ...sealedDiff, unsealedField: true })).toThrow()
    expect(() =>
      parseGraphDiff({
        ...sealedDiff,
        moveFlows: [{ from: 'src/old', to: 'src/new', count: -1 }],
      }),
    ).toThrow()
  })
})
