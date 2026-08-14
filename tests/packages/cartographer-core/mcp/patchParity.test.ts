// tests/packages/cartographer-core/mcp/patchParity.test.ts
// verifies MCP patch evaluation, paging, staleness, bounds, and store integrity

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import * as NodeFS from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'
import { MAX_PATCH_EVALUATION_NODES } from '../../../../packages/cartographer-core/src/analyze/patchEvaluation.ts'
import {
  PATCH_SCHEMA_VERSION,
  type GraphPatch,
} from '../../../../packages/cartographer-core/src/analyze/patch.ts'
import {
  GRAPH_SCHEMA_VERSION,
  type CartographerGraph,
} from '../../../../packages/cartographer-core/src/contracts/types.ts'
import { mcpServer } from '../../../../packages/cartographer-core/src/mcp/server.ts'
import {
  listPatches,
  patchCatalogRevision,
  savePatchAs,
} from '../../../../packages/cartographer-core/src/store/patches.ts'
import { patchesDirPath } from '../../../../packages/cartographer-core/src/store/paths.ts'
import { saveGraph } from '../../../../packages/cartographer-core/src/store/index.ts'
import { trackedTempRoot } from '../helpers/trackedTempRoot.ts'

interface PatchPageBody
{
  patches: Array<{ id: string }>
  total: number
  returned: number
  omitted: number
  remaining: number
  revision: string
  patchesPath: string
  nextCursor?: string
}

const tempRoots = trackedTempRoot('carto-mcp-patch-')
const tempRoot = tempRoots.create
const client = new Client({ name: 'cartographer-patch-test', version: '1.0.0' })

function graph(root: string): CartographerGraph
{
  return {
    version: GRAPH_SCHEMA_VERSION,
    repoRoot: root,
    mode: 'imports',
    generatedAt: '2026-01-01T00:00:00.000Z',
    scope: 'src',
    nodes: ['src/a.ts', 'src/b.ts'].map((id) => ({
      id,
      kind: 'file',
      label: id.slice(id.lastIndexOf('/') + 1),
      group: 'src',
    })),
    groups: [{ id: 'src', label: 'src', fileCount: 2 }],
    edges: [
      {
        id: 'src/a.ts>src/b.ts',
        from: 'src/a.ts',
        to: 'src/b.ts',
        kind: 'imports',
      },
    ],
    metrics: { cycles: 0, orphans: 0, maxFanIn: 1, maxFanOut: 1 },
  }
}

function patch(name: string, index = 0): GraphPatch
{
  return {
    version: PATCH_SCHEMA_VERSION,
    meta: {
      name,
      createdAt: new Date(Date.UTC(2026, 0, 1) + index * 1_000).toISOString(),
    },
    ops: [{ op: 'add_file', path: `src/generated/file-${index}.ts` }],
  }
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ payload?: Record<string, unknown>; error?: string }>
{
  const result = await client.callTool({ name, arguments: args })
  const content = (result as { content?: unknown }).content
  const entry = Array.isArray(content)
    ? content.find(
        (item): item is { type: 'text'; text: string } =>
          typeof item === 'object' &&
          item !== null &&
          (item as Record<string, unknown>).type === 'text' &&
          typeof (item as Record<string, unknown>).text === 'string',
      )
    : undefined
  if (!entry)
  {
    throw new Error(`${name} returned no text payload`)
  }
  if ((result as { isError?: boolean }).isError)
  {
    return { error: entry.text }
  }
  return { payload: JSON.parse(entry.text) as Record<string, unknown> }
}

function pageBody(value: Record<string, unknown>): PatchPageBody
{
  return value as unknown as PatchPageBody
}

async function drainMcp(root: string, limit: number): Promise<string[]>
{
  const ids: string[] = []
  let cursor: string | undefined
  let revision: string | undefined
  let patchesPath: string | undefined
  do
  {
    const result = await callTool('list_patches', {
      root,
      limit,
      ...(cursor ? { cursor } : {}),
    })
    expect(result.error).toBeUndefined()
    const page = pageBody(result.payload!)
    expect(page.total).toBe(252)
    expect(page.returned).toBe(page.patches.length)
    expect(page.omitted).toBe(page.total - page.returned)
    revision ??= page.revision
    patchesPath ??= page.patchesPath
    expect(page.revision).toBe(revision)
    expect(page.patchesPath).toBe(patchesPath)
    ids.push(...page.patches.map((entry) => entry.id))
    expect(page.remaining).toBe(page.total - ids.length)
    cursor = page.nextCursor
    expect(Boolean(cursor)).toBe(page.remaining > 0)
  } while (cursor)
  return ids
}

beforeAll(async () =>
{
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await mcpServer.connect(serverTransport)
  await client.connect(clientTransport)
})

afterAll(async () =>
{
  await client.close()
  await mcpServer.close()
  tempRoots.cleanup()
})

describe('MCP patch invariants', () =>
{
  it('projects one staleness contract through propose, list, and get', async () =>
  {
    const root = tempRoot()
    saveGraph(graph(root), root)

    const proposed = await callTool('propose_patch', {
      root,
      name: 'shared staleness',
      ops: [{ op: 'add_file', path: 'src/new.ts' }],
    })
    expect(proposed.error).toBeUndefined()
    const expected = {
      stale: false,
      reasons: [],
      baseline: { generatedAt: '2026-01-01T00:00:00.000Z' },
      graph: { generatedAt: '2026-01-01T00:00:00.000Z' },
    }
    expect(proposed.payload!.staleness).toEqual(expected)

    const listed = await callTool('list_patches', { root })
    const entries = listed.payload!.patches as Array<Record<string, unknown>>
    expect(entries).toHaveLength(1)
    expect(entries[0]!.staleness).toEqual(expected)

    const fetched = await callTool('get_patch', {
      root,
      id: proposed.payload!.patchId,
    })
    expect(fetched.payload!.staleness).toEqual(expected)
  })

  it('returns ordered issues and structural validation from the current graph', async () =>
  {
    const root = tempRoot()
    saveGraph(graph(root), root)
    const saved = savePatchAs(root, 'parity', {
      version: PATCH_SCHEMA_VERSION,
      meta: {
        name: 'parity',
        createdAt: '2026-01-02T00:00:00.000Z',
        baseline: { generatedAt: '2025-12-31T00:00:00.000Z' },
      },
      ops: [
        { op: 'add_file', path: 'src/fresh.ts' },
        { op: 'add_import', from: 'src/b.ts', to: 'src/a.ts' },
        { op: 'remove_file', path: 'src/missing.ts' },
      ],
    })

    const result = await callTool('get_patch', { root, id: 'parity' })

    expect(result.error).toBeUndefined()
    expect(result.payload!.ops).toEqual([
      { op: 'add_file', path: 'src/fresh.ts' },
      { op: 'add_import', from: 'src/b.ts', to: 'src/a.ts' },
      { op: 'remove_file', path: 'src/missing.ts' },
    ])
    expect(result.payload!.issueTotals).toEqual({ total: 1, errors: 1, omitted: 0 })
    expect(result.payload!.issues).toEqual([
      {
        opIndex: 2,
        severity: 'error',
        message: 'remove_file: src/missing.ts does not exist',
      },
    ])
    expect(result.payload!.validation).toMatchObject({
      totals: { cycles: 1, newBoundaries: 0, orphans: 1 },
      orphans: [{ file: 'src/fresh.ts', kind: 'added-unconnected' }],
    })
    expect(result.payload!.staleness).toMatchObject({
      stale: true,
      reasons: ['generation-mismatch'],
    })
    expect(result.payload!.patchPath).toBe(saved.path)
  })

  it('bounds get_patch payloads while preserving exact totals and the artifact path', async () =>
  {
    const root = tempRoot()
    saveGraph(graph(root), root)
    const saved = savePatchAs(root, 'large', {
      version: PATCH_SCHEMA_VERSION,
      meta: { name: 'large', createdAt: '2026-01-02T00:00:00.000Z' },
      ops: [
        ...Array.from({ length: 120 }, (_, index) => ({
          op: 'add_file' as const,
          path: `src/generated-${index}.ts`,
        })),
        ...Array.from({ length: 1_880 }, (_, index) => ({
          op: 'remove_file' as const,
          path: `src/missing-${index}.ts`,
        })),
      ],
    })

    const result = await callTool('get_patch', { root, id: 'large' })
    const validation = result.payload!.validation as {
      totals: { orphans: number }
      orphans: unknown[]
    }

    expect(result.error).toBeUndefined()
    expect(result.payload!.ops).toHaveLength(200)
    expect(result.payload!.opTotals).toEqual({ total: 2_000, omitted: 1_800 })
    expect(result.payload!.issues).toHaveLength(100)
    expect(result.payload!.issueTotals).toEqual({
      total: 1_880,
      errors: 1_880,
      omitted: 1_780,
    })
    expect(validation.totals.orphans).toBe(120)
    expect(validation.orphans).toHaveLength(50)
    expect(result.payload!.patchPath).toBe(saved.path)
    expect(result.payload!.opsNote).toContain('all 2000')
    expect(JSON.parse(NodeFS.readFileSync(saved.path, 'utf-8')).ops).toHaveLength(2_000)
  })

  it('drains 250-plus stable pages and rejects malformed or cross-root cursors', async () =>
  {
    const root = tempRoot()
    const otherRoot = tempRoot()
    saveGraph(graph(root), root)
    for (let index = 0; index < 251; index += 1)
    {
      savePatchAs(root, `patch-${String(index).padStart(3, '0')}`, patch('p', index))
    }
    NodeFS.writeFileSync(`${patchesDirPath(root)}/broken.json`, '{ invalid')
    const expected = [
      ...Array.from(
        { length: 251 },
        (_, offset) => `patch-${String(250 - offset).padStart(3, '0')}`,
      ),
      'broken',
    ]

    const first = await callTool('list_patches', { root, limit: 31 })
    const cursor = pageBody(first.payload!).nextCursor!
    expect(await drainMcp(root, 31)).toEqual(expected)

    for (const badCursor of ['not/base64', `${cursor.slice(0, -1)}A`, `${cursor}=`])
    {
      const result = await callTool('list_patches', { root, cursor: badCursor })
      expect(result.error).toMatch(/cursor|invalid/i)
    }
    const crossRoot = await callTool('list_patches', { root: otherRoot, cursor })
    expect(crossRoot.error).toMatch(/cursor|invalid/i)
  })

  it('changes the catalog revision for raw edits with identical projections', () =>
  {
    const root = tempRoot()
    const saved = savePatchAs(root, 'revision', patch('revision'))
    const before = patchCatalogRevision(root)
    const raw = NodeFS.readFileSync(saved.path, 'utf-8')
    NodeFS.writeFileSync(saved.path, `${raw.trimEnd()}  \n`)
    const after = patchCatalogRevision(root)

    expect(after).not.toBe(before)
    expect(listPatches(root)).toHaveLength(1)
  })

  it('maps evaluation ceilings without hiding the stored catalog', async () =>
  {
    const root = tempRoot()
    const oversized = graph(root)
    oversized.nodes = Array.from({ length: MAX_PATCH_EVALUATION_NODES + 1 }, (_, index) => ({
      id: `src/generated/n${index}.ts`,
      kind: 'file',
      label: `n${index}.ts`,
      group: 'src/generated',
    }))
    oversized.edges = []
    saveGraph(oversized, root)
    const saved = savePatchAs(root, 'over-limit', patch('over limit'))

    const fetched = await callTool('get_patch', { root, id: 'over-limit' })
    expect(fetched.error).toMatch(/patch evaluation refused.*50,001 nodes/)

    const proposed = await callTool('propose_patch', {
      root,
      name: 'must not save',
      ops: [{ op: 'add_file', path: 'src/new.ts' }],
    })
    expect(proposed.error).toMatch(/patch evaluation refused.*50,001 nodes/)

    const listed = await callTool('list_patches', { root })
    expect(listed.error).toBeUndefined()
    expect((listed.payload!.patches as Array<{ id: string }>).map((entry) => entry.id)).toEqual([
      'over-limit',
    ])
    expect(JSON.parse(NodeFS.readFileSync(saved.path, 'utf-8')).ops).toHaveLength(1)
  })
})
