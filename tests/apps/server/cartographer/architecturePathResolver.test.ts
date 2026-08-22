// tests/apps/server/cartographer/architecturePathResolver.test.ts
// verifies Atlas v6 file and directory anchoring for planned-impact materialization

import {
  GRAPH_SCHEMA_VERSION,
  type CartographerGraph,
} from '../../../../packages/cartographer-core/src/contracts/types.ts'
import { describe, expect, it } from 'vite-plus/test'

import { resolveArchitecturePathScope } from '../../../../apps/server/src/cartographer/architecturePathResolver.ts'
import { buildAtlasIndex } from '../../../../packages/cartographer-core/src/store/atlasIndex/build.ts'

const createdAt = '2026-08-20T12:00:00.000Z'
const graphDigest = `sha256:${'a'.repeat(64)}` as const

function graph(): CartographerGraph
{
  return {
    version: GRAPH_SCHEMA_VERSION,
    repoRoot: '/repo',
    mode: 'imports',
    generatedAt: createdAt,
    gitRef: '1'.repeat(40),
    scope: '.',
    nodes: [
      {
        id: 'src/api.ts',
        kind: 'file',
        label: 'api.ts',
        group: 'api',
        system: 'runtime',
      },
      {
        id: 'src/store.ts',
        kind: 'file',
        label: 'store.ts',
        group: 'store',
        system: 'runtime',
      },
      {
        id: 'outside/outside.ts',
        kind: 'file',
        label: 'outside.ts',
        group: 'outside',
        system: 'auxiliary',
      },
    ],
    edges: [
      {
        id: 'api-store',
        from: 'src/api.ts',
        to: 'src/store.ts',
        kind: 'imports',
      },
    ],
    groups: [
      { id: 'api', label: 'API', fileCount: 1 },
      { id: 'store', label: 'Store', fileCount: 1 },
      { id: 'outside', label: 'Outside', fileCount: 1 },
    ],
    systems: [
      { id: 'runtime', label: 'Runtime', fileCount: 2, source: 'authored' },
      { id: 'auxiliary', label: 'Auxiliary', fileCount: 1, source: 'authored' },
    ],
    metrics: { cycles: 0, orphans: 1, maxFanIn: 1, maxFanOut: 1 },
  }
}

const index = () => buildAtlasIndex(graph(), graphDigest)

describe('resolveArchitecturePathScope', () =>
{
  it('classifies an exact file as touched units plus one-hop neighbors', () =>
  {
    expect(resolveArchitecturePathScope(index(), ['src/api.ts'])).toEqual([
      {
        role: 'touched',
        level: 'systems',
        id: 'systems:runtime',
        key: 'runtime',
        label: 'Runtime',
      },
      { role: 'touched', level: 'blocks', id: 'blocks:api', key: 'api', label: 'API' },
      { role: 'context', level: 'blocks', id: 'blocks:store', key: 'store', label: 'Store' },
    ])
  })

  it('treats a directory prefix as every contained file without fabricated matches', () =>
  {
    expect(resolveArchitecturePathScope(index(), ['src'])).toEqual([
      {
        role: 'touched',
        level: 'systems',
        id: 'systems:runtime',
        key: 'runtime',
        label: 'Runtime',
      },
      { role: 'touched', level: 'blocks', id: 'blocks:api', key: 'api', label: 'API' },
      { role: 'touched', level: 'blocks', id: 'blocks:store', key: 'store', label: 'Store' },
    ])
    expect(resolveArchitecturePathScope(index(), ['missing/file.ts'])).toEqual([])
  })
})
