// tests/apps/server/cartographer/architecturePathResolver.test.ts
// verifies standing-atlas file/dir resolution and touched vs context chips

import type { AtlasIndex } from '@t3tools/cartographer-core/server'
import { describe, expect, it } from 'vite-plus/test'

import { resolveArchitecturePathScope } from '../../../../apps/server/src/cartographer/architecturePathResolver.ts'

const createdAt = '2026-08-07T12:00:00.000Z'
const graphDigest = `sha256:${'a'.repeat(64)}` as const

function unit(input: {
  readonly id: string
  readonly key: string
  readonly level: 'systems' | 'blocks' | 'dirs'
  readonly label: string
  readonly parent?: string
  readonly order: number
})
{
  return {
    ...input,
    fileCount: 1,
    inbound: 0,
    outbound: 0,
    visibilityRank: input.order + 1,
    position: { x: input.order * 240, y: 0 },
  }
}

function index(): AtlasIndex
{
  const system = unit({
    id: 'systems:runtime',
    key: 'runtime',
    level: 'systems',
    label: 'Runtime',
    order: 0,
  })
  const api = unit({
    id: 'blocks:api',
    key: 'api',
    level: 'blocks',
    label: 'API',
    parent: system.id,
    order: 0,
  })
  const store = unit({
    id: 'blocks:store',
    key: 'store',
    level: 'blocks',
    label: 'Store',
    parent: system.id,
    order: 1,
  })
  const directory = unit({
    id: 'dirs:src',
    key: 'src',
    level: 'dirs',
    label: 'src',
    parent: api.id,
    order: 0,
  })
  return {
    version: 5,
    sourceGeneratedAt: createdAt,
    sourceGraphDigest: graphDigest,
    repo: { root: '/repo', name: 'path-scope-fixture', scope: '.', mode: 'imports' },
    counts: {
      files: 3,
      imports: 2,
      systems: 1,
      blocks: 2,
      dirs: 1,
      indexedSystems: 1,
      indexedBlocks: 2,
      indexedDirs: 1,
    },
    systemSource: 'authored',
    units: { systems: [system], blocks: [api, store], dirs: [directory] },
    edges: {
      systems: [],
      blocks: [{ from: api.id, to: store.id, weight: 2 }],
      dirs: [],
    },
    edgeCounts: {
      systems: { total: 0, indexed: 0, omitted: 0 },
      blocks: { total: 1, indexed: 1, omitted: 0 },
      dirs: { total: 0, indexed: 0, omitted: 0 },
    },
    scopes: [],
    health: {
      cycles: 0,
      orphans: 0,
      violatingImports: 0,
      violatedRules: 0,
      ruleTotal: 0,
    },
    files: [
      {
        id: 'src/api.ts',
        label: 'api.ts',
        system: system.id,
        block: api.id,
        dir: directory.id,
        fanIn: 0,
        fanOut: 1,
        visibilityRank: 1,
      },
      {
        id: 'src/store.ts',
        label: 'store.ts',
        system: system.id,
        block: store.id,
        dir: directory.id,
        fanIn: 1,
        fanOut: 0,
        visibilityRank: 2,
      },
      {
        id: 'src/outside.ts',
        label: 'outside.ts',
        system: system.id,
        fanIn: 0,
        fanOut: 0,
        visibilityRank: 3,
      },
    ],
  }
}

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

  it('treats a directory prefix as all contained files without extra context', () =>
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
  })

  it('returns no chips for paths that are not in the standing catalog', () =>
  {
    expect(resolveArchitecturePathScope(index(), ['missing/file.ts'])).toEqual([])
  })
})
