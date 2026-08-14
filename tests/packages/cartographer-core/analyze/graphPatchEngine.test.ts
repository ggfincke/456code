// tests/packages/cartographer-core/analyze/graphPatchEngine.test.ts
// patch parsing, sequential apply, structural validation & trust boundaries

import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import { afterAll, describe, expect, it } from 'vite-plus/test'
import { diffGraphs } from '../../../../packages/cartographer-core/src/analyze/diff.ts'
import {
  evaluatePatch,
  MAX_PATCH_EVALUATION_EDGES,
  MAX_PATCH_EVALUATION_NODES,
  MAX_PATCH_EVALUATION_WORK,
  PatchEvaluationLimitError,
} from '../../../../packages/cartographer-core/src/analyze/patchEvaluation.ts'
import {
  listPatchPage,
  listPatches,
  loadPatch,
  savePatch,
} from '../../../../packages/cartographer-core/src/store/patches.ts'
import {
  applyPatch,
  MAX_PATCH_OPS,
  parseGraphPatch,
  PATCH_SCHEMA_VERSION,
  patchHeadGraph,
  patchToDiff,
  validatePatchStructure,
  type GraphPatch,
  type GraphPatchOp,
} from '../../../../packages/cartographer-core/src/analyze/patch.ts'
import {
  GRAPH_SCHEMA_VERSION,
  type CartographerGraph,
} from '../../../../packages/cartographer-core/src/contracts/types.ts'
import { trackedTempRoot } from '../helpers/trackedTempRoot.ts'

function graph(files: string[], edges: Array<[string, string]>): CartographerGraph
{
  return {
    version: GRAPH_SCHEMA_VERSION,
    repoRoot: '/repo',
    mode: 'imports',
    generatedAt: '2026-01-01T00:00:00.000Z',
    scope: 'src',
    nodes: files.map((id) => ({
      id,
      kind: 'file',
      label: id.slice(id.lastIndexOf('/') + 1),
      group: id.split('/').slice(0, 2).join('/'),
    })),
    groups: [],
    edges: edges.map(([from, to]) => ({
      id: `${from}>${to}`,
      from,
      to,
      kind: 'imports',
    })),
    metrics: { cycles: 0, orphans: 0, maxFanIn: 0, maxFanOut: 0 },
  }
}

// membership resolver mirroring the helper graph's two-segment groups
function resolver(path: string): { group: string }
{
  return { group: path.split('/').slice(0, 2).join('/') }
}

function patchOf(ops: GraphPatchOp[]): GraphPatch
{
  return {
    version: PATCH_SCHEMA_VERSION,
    meta: { name: 'test patch', createdAt: '2026-01-02T00:00:00.000Z' },
    ops,
  }
}

describe('parseGraphPatch', () =>
{
  const valid = {
    version: 1,
    meta: { name: 'demo', createdAt: '2026-01-02T00:00:00.000Z' },
    ops: [{ op: 'add_file', path: 'src/a/new.ts' }],
  }

  it('round-trips a valid patch', () =>
  {
    const patch = parseGraphPatch(valid)
    expect(patch.meta.name).toBe('demo')
    expect(patch.ops).toEqual([{ op: 'add_file', path: 'src/a/new.ts' }])
  })

  it('rejects newer schema versions loudly', () =>
  {
    expect(() => parseGraphPatch({ ...valid, version: 99 })).toThrow(/patch schema version 99/)
  })

  it('rejects traversal, absolute & non-canonical paths', () =>
  {
    for (const path of [
      '../evil.ts',
      '/abs.ts',
      'src/../up.ts',
      'a\\b.ts',
      './src/a.ts',
      'src/./a.ts',
      'src/a/.',
      'src//a.ts',
    ])
    {
      expect(() =>
        parseGraphPatch({
          ...valid,
          ops: [{ op: 'remove_file', path }],
        }),
      ).toThrow(/patch -> ops\[0\]\.path/)
    }
  })

  it('rejects unknown op kinds & oversize op lists', () =>
  {
    expect(() => parseGraphPatch({ ...valid, ops: [{ op: 'rename_file' }] })).toThrow(
      /unknown kind/,
    )
    const ops = Array.from({ length: MAX_PATCH_OPS + 1 }, () => ({
      op: 'remove_file',
      path: 'src/a/x.ts',
    }))
    expect(() => parseGraphPatch({ ...valid, ops })).toThrow(/exceeds/)
  })
})

describe('applyPatch', () =>
{
  it('re-judges patched edges against every allowVia alternative', () =>
  {
    const base = graph(
      [
        'src/public/client.ts',
        'src/internal/client.ts',
        'src/feature/client.ts',
        'src/core/service.ts',
      ],
      [],
    )
    base.rules = [
      {
        id: 'public-entrypoints',
        from: 'src/**',
        to: 'src/core/**',
        verdict: 'allow-only',
        allowVia: ['src/public/**', 'src/internal/**'],
        severity: 'error',
      },
    ]
    const applied = applyPatch(
      base,
      patchOf([
        { op: 'add_import', from: 'src/public/client.ts', to: 'src/core/service.ts' },
        { op: 'add_import', from: 'src/internal/client.ts', to: 'src/core/service.ts' },
        { op: 'add_import', from: 'src/feature/client.ts', to: 'src/core/service.ts' },
      ]),
      resolver,
    )

    expect(applied.edges.map((edge) => [edge.from, edge.violations])).toEqual([
      ['src/public/client.ts', undefined],
      ['src/internal/client.ts', undefined],
      ['src/feature/client.ts', ['public-entrypoints']],
    ])
  })

  it('applies ops sequentially so later ops see earlier results', () =>
  {
    const base = graph(['src/a/one.ts'], [])
    const applied = applyPatch(
      base,
      patchOf([
        { op: 'add_file', path: 'src/b/two.ts', exports: ['thing'] },
        { op: 'add_import', from: 'src/a/one.ts', to: 'src/b/two.ts' },
      ]),
      resolver,
    )
    expect(applied.issues).toEqual([])
    expect(applied.nodes.map((n) => n.id).sort()).toEqual(['src/a/one.ts', 'src/b/two.ts'])
    expect(applied.edges).toEqual([
      {
        id: 'p0',
        from: 'src/a/one.ts',
        to: 'src/b/two.ts',
        kind: 'imports',
      },
    ])
    const added = applied.nodes.find((n) => n.id === 'src/b/two.ts')
    expect(added?.exports).toEqual([{ name: 'thing' }])
    expect(added?.group).toBe('src/b')
  })

  it('collects an issue per failure class & skips errored ops', () =>
  {
    const base = graph(['src/a/one.ts', 'src/a/two.ts'], [['src/a/one.ts', 'src/a/two.ts']])
    const applied = applyPatch(
      base,
      patchOf([
        { op: 'add_file', path: 'src/a/one.ts' },
        { op: 'remove_file', path: 'src/a/ghost.ts' },
        { op: 'move_file', from: 'src/a/ghost.ts', to: 'src/a/x.ts' },
        { op: 'move_file', from: 'src/a/one.ts', to: 'src/a/two.ts' },
        { op: 'add_import', from: 'src/a/one.ts', to: 'src/a/ghost.ts' },
        { op: 'add_import', from: 'src/a/one.ts', to: 'src/a/two.ts' },
        { op: 'remove_import', from: 'src/a/two.ts', to: 'src/a/one.ts' },
      ]),
      resolver,
    )
    expect(applied.issues).toEqual([
      {
        opIndex: 0,
        severity: 'error',
        message: expect.stringContaining('already exists'),
      },
      {
        opIndex: 1,
        severity: 'error',
        message: expect.stringContaining('does not exist'),
      },
      {
        opIndex: 2,
        severity: 'error',
        message: expect.stringContaining('does not exist'),
      },
      {
        opIndex: 3,
        severity: 'error',
        message: expect.stringContaining('already exists'),
      },
      {
        opIndex: 4,
        severity: 'error',
        message: expect.stringContaining('does not exist'),
      },
      {
        opIndex: 5,
        severity: 'warning',
        message: expect.stringContaining('already exists'),
      },
      {
        opIndex: 6,
        severity: 'error',
        message: expect.stringContaining('does not exist'),
      },
    ])
    // graph unchanged: every op errored or was a skipped duplicate
    expect(applied.nodes.map((n) => n.id).sort()).toEqual(['src/a/one.ts', 'src/a/two.ts'])
    expect(applied.edges).toHaveLength(1)
  })

  it('retargets incident edges through a move & drops them on remove', () =>
  {
    const base = graph(
      ['src/a/hub.ts', 'src/a/user.ts', 'src/a/dead.ts'],
      [
        ['src/a/user.ts', 'src/a/hub.ts'],
        ['src/a/hub.ts', 'src/a/dead.ts'],
      ],
    )
    const applied = applyPatch(
      base,
      patchOf([
        { op: 'move_file', from: 'src/a/hub.ts', to: 'src/core/hub.ts' },
        { op: 'remove_file', path: 'src/a/dead.ts' },
      ]),
      resolver,
    )
    expect(applied.issues).toEqual([])
    expect(applied.moved).toEqual([{ from: 'src/a/hub.ts', to: 'src/core/hub.ts' }])
    expect([...applied.originByPath].sort()).toEqual([
      ['src/a/user.ts', 'src/a/user.ts'],
      ['src/core/hub.ts', 'src/a/hub.ts'],
    ])
    expect(applied.edges.map((e) => `${e.from} -> ${e.to}`).sort()).toEqual([
      'src/a/user.ts -> src/core/hub.ts',
    ])
    const movedNode = applied.nodes.find((n) => n.id === 'src/core/hub.ts')
    expect(movedNode?.group).toBe('src/core')
    expect(movedNode?.label).toBe('hub.ts')
  })

  it('removes only the matching structural delimiter edge', () =>
  {
    const base = graph(
      ['a -> b', 'c', 'a', 'b -> c'],
      [
        ['a -> b', 'c'],
        ['a', 'b -> c'],
      ],
    )
    const applied = applyPatch(
      base,
      patchOf([{ op: 'remove_import', from: 'a -> b', to: 'c' }]),
      resolver,
    )

    expect(applied.issues).toEqual([])
    expect(applied.edges.map(({ from, to }) => ({ from, to }))).toEqual([
      { from: 'a', to: 'b -> c' },
    ])
  })

  it('preserves edge order, origins & synthetic ids through indexed mutations', () =>
  {
    const base = graph(
      ['src/hub.ts', 'src/in.ts', 'src/out.ts', 'src/leaf.ts'],
      [
        ['src/leaf.ts', 'src/out.ts'],
        ['src/hub.ts', 'src/out.ts'],
        ['src/in.ts', 'src/hub.ts'],
        ['src/hub.ts', 'src/hub.ts'],
      ],
    )
    const applied = applyPatch(
      base,
      patchOf([
        { op: 'move_file', from: 'src/hub.ts', to: 'src/middle.ts' },
        { op: 'remove_import', from: 'src/in.ts', to: 'src/middle.ts' },
        { op: 'add_import', from: 'src/middle.ts', to: 'src/leaf.ts' },
        { op: 'move_file', from: 'src/middle.ts', to: 'src/final.ts' },
        { op: 'remove_file', path: 'src/out.ts' },
      ]),
      resolver,
    )

    expect(applied.issues).toEqual([])
    expect(applied.edges).toEqual([
      {
        id: 'src/hub.ts>src/hub.ts',
        from: 'src/final.ts',
        to: 'src/final.ts',
        kind: 'imports',
      },
      {
        id: 'p0',
        from: 'src/final.ts',
        to: 'src/leaf.ts',
        kind: 'imports',
      },
    ])
    expect(applied.moved).toEqual([{ from: 'src/hub.ts', to: 'src/final.ts' }])
    expect([...applied.originByPath]).toEqual([
      ['src/in.ts', 'src/in.ts'],
      ['src/leaf.ts', 'src/leaf.ts'],
      ['src/final.ts', 'src/hub.ts'],
    ])
  })

  it('keeps duplicate endpoint last-value & first-position behavior', () =>
  {
    const base = graph(
      ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'],
      [
        ['src/a.ts', 'src/b.ts'],
        ['src/c.ts', 'src/d.ts'],
        ['src/a.ts', 'src/b.ts'],
      ],
    )
    base.edges[0]!.id = 'first'
    base.edges[2]!.id = 'last'
    const applied = applyPatch(
      base,
      patchOf([{ op: 'move_file', from: 'src/a.ts', to: 'src/moved.ts' }]),
      resolver,
    )

    expect(applied.edges).toEqual([
      base.edges[1],
      {
        ...base.edges[2],
        from: 'src/moved.ts',
      },
    ])
  })
})

describe('patchToDiff', () =>
{
  it('matches diffGraphs on an equivalent before/after pair', () =>
  {
    const base = graph(
      ['src/a/keep.ts', 'src/a/mover.ts', 'src/a/user.ts'],
      [
        ['src/a/user.ts', 'src/a/mover.ts'],
        ['src/a/user.ts', 'src/a/keep.ts'],
      ],
    )
    const patch = patchOf([
      { op: 'move_file', from: 'src/a/mover.ts', to: 'src/b/mover.ts' },
      { op: 'add_file', path: 'src/b/fresh.ts' },
      { op: 'add_import', from: 'src/b/fresh.ts', to: 'src/b/mover.ts' },
    ])
    const applied = applyPatch(base, patch, resolver)
    const head = patchHeadGraph(base, patch, applied)
    const diff = patchToDiff(base, applied, head)

    // the inferring differ agrees on every structural field
    const inferred = diffGraphs(base, head)
    expect(diff.addedNodes).toEqual(inferred.addedNodes)
    expect(diff.removedNodes).toEqual(inferred.removedNodes)
    expect(diff.addedEdges).toEqual(inferred.addedEdges)
    expect(diff.removedEdges).toEqual(inferred.removedEdges)
    expect(diff.movedNodes).toEqual(inferred.movedNodes)
    expect(diff.movedEdges).toEqual(inferred.movedEdges)

    expect(diff.addedNodes).toEqual(['src/b/fresh.ts'])
    expect(diff.movedNodes).toEqual([{ from: 'src/a/mover.ts', to: 'src/b/mover.ts' }])
    // the retargeted user import collapses into movedEdges, not churn
    expect(diff.movedEdges).toBe(1)
    expect(diff.addedEdges).toEqual([{ from: 'src/b/fresh.ts', to: 'src/b/mover.ts' }])
    expect(diff.moveFlows).toEqual([{ from: 'src/a', to: 'src/b', count: 1 }])
    // patches never claim api drift
    expect(diff.apiChanges).toEqual([])
    expect(diff.changed).toBe(true)
  })

  it('keeps a replaced source path distinct from the file moved out of it', () =>
  {
    const base = graph(['src/a.ts', 'src/c.ts'], [['src/a.ts', 'src/c.ts']])
    const patch = patchOf([
      { op: 'move_file', from: 'src/a.ts', to: 'src/b.ts' },
      { op: 'add_file', path: 'src/a.ts' },
      { op: 'add_import', from: 'src/a.ts', to: 'src/c.ts' },
    ])
    const applied = applyPatch(base, patch, resolver)
    const head = patchHeadGraph(base, patch, applied)
    const diff = patchToDiff(base, applied, head)

    expect(diff.addedNodes).toEqual(['src/a.ts'])
    expect(diff.removedNodes).toEqual([])
    expect(diff.movedNodes).toEqual([{ from: 'src/a.ts', to: 'src/b.ts' }])
    expect(diff.addedEdges).toEqual([{ from: 'src/a.ts', to: 'src/c.ts' }])
    expect(diff.removedEdges).toEqual([])
    expect(diff.movedEdges).toBe(1)
    expect(diff.addedEdges).not.toContainEqual({
      from: 'src/b.ts',
      to: 'src/c.ts',
    })
  })

  it('reports remove-and-replace occupants at one path independently', () =>
  {
    const base = graph(['src/a.ts', 'src/c.ts'], [['src/a.ts', 'src/c.ts']])
    const patch = patchOf([
      { op: 'remove_file', path: 'src/a.ts' },
      { op: 'add_file', path: 'src/a.ts' },
      { op: 'add_import', from: 'src/a.ts', to: 'src/c.ts' },
    ])
    const applied = applyPatch(base, patch, resolver)
    const head = patchHeadGraph(base, patch, applied)
    const diff = patchToDiff(base, applied, head)

    expect(diff.addedNodes).toEqual(['src/a.ts'])
    expect(diff.removedNodes).toEqual(['src/a.ts'])
    expect(diff.movedNodes).toEqual([])
    expect(diff.addedEdges).toEqual([{ from: 'src/a.ts', to: 'src/c.ts' }])
    expect(diff.removedEdges).toEqual([{ from: 'src/a.ts', to: 'src/c.ts' }])
    expect(diff.movedEdges).toBe(0)
  })
})

const tempRoots = trackedTempRoot('carto-patch-')
const tempRoot = tempRoots.create

afterAll(tempRoots.cleanup)

describe('patch store', () =>
{
  it('slugifies ids, suffixes collisions & round-trips the artifact', () =>
  {
    const root = tempRoot()
    const patch = patchOf([{ op: 'add_file', path: 'src/a/new.ts' }])
    const first = savePatch(root, {
      ...patch,
      meta: { ...patch.meta, name: 'Split the Store!' },
    })
    const second = savePatch(root, {
      ...patch,
      meta: { ...patch.meta, name: 'Split the Store!' },
    })
    expect(first.id).toBe('split-the-store')
    expect(second.id).toBe('split-the-store-2')
    const loaded = loadPatch(root, first.id)
    expect(loaded.meta.name).toBe('Split the Store!')
    expect(loaded.ops).toEqual(patch.ops)
  })

  it('keeps collision suffixes inside the patch-id length contract', () =>
  {
    const root = tempRoot()
    const name = 'a'.repeat(80)
    const patch = {
      ...patchOf([{ op: 'add_file', path: 'src/a/new.ts' }]),
      meta: { name, createdAt: '2026-01-02T00:00:00.000Z' },
    }

    const first = savePatch(root, patch)
    const second = savePatch(root, patch)

    expect(first.id).toBe('a'.repeat(64))
    expect(second.id).toBe(`${'a'.repeat(62)}-2`)
    expect(second.id).toHaveLength(64)
  })

  it('lists valid & invalid patches, skipping unsafe stems & symlinks', () =>
  {
    const root = tempRoot()
    const patch = patchOf([{ op: 'add_file', path: 'src/a/new.ts' }])
    savePatch(root, patch)
    const dir = NodePath.join(root, '.cartographer', 'patches')
    NodeFS.writeFileSync(NodePath.join(dir, 'broken.json'), '{ not json')
    NodeFS.writeFileSync(NodePath.join(dir, 'bad id!.json'), '{}')
    NodeFS.symlinkSync(NodePath.join(dir, 'test-patch.json'), NodePath.join(dir, 'linked.json'))
    const entries = listPatches(root)
    expect(entries.map((e) => e.id).sort()).toEqual(['broken', 'test-patch'])
    const broken = entries.find((e) => e.id === 'broken')
    expect(broken?.invalid?.message).toBeTruthy()
    const valid = entries.find((e) => e.id === 'test-patch')
    expect(valid?.opTotals).toEqual({
      addFiles: 1,
      removeFiles: 0,
      moves: 0,
      addImports: 0,
      removeImports: 0,
    })
  })

  it('keeps cached catalog entries private from returned DTO mutations', () =>
  {
    const root = tempRoot()
    savePatch(root, {
      ...patchOf([{ op: 'add_file', path: 'src/a/new.ts' }]),
      meta: {
        name: 'cached patch',
        createdAt: '2026-01-02T00:00:00.000Z',
        baseline: { generatedAt: '2026-01-01T00:00:00.000Z', gitRef: 'abc' },
      },
    })
    NodeFS.writeFileSync(
      NodePath.join(root, '.cartographer', 'patches', 'broken.json'),
      '{ invalid',
    )
    const original = listPatches(root)
    const returned = listPatches(root)
    returned[0]!.name = 'poisoned'
    returned[0]!.baseline!.gitRef = 'poisoned'
    returned[0]!.opTotals!.addFiles = 999
    returned[1]!.invalid!.message = 'poisoned'
    const page = listPatchPage(root, 10)
    page.patches[0]!.baseline!.generatedAt = 'poisoned'
    page.patches[1]!.invalid!.message = 'poisoned again'

    expect(listPatches(root)).toEqual(original)
    expect(listPatchPage(root, 10).patches).toEqual(original)
  })

  it('refuses traversal ids & symlinked patch files on load', () =>
  {
    const root = tempRoot()
    savePatch(root, patchOf([{ op: 'add_file', path: 'src/a/new.ts' }]))
    expect(() => loadPatch(root, '../evil')).toThrow(/invalid patch id/)
    const dir = NodePath.join(root, '.cartographer', 'patches')
    NodeFS.symlinkSync(NodePath.join(dir, 'test-patch.json'), NodePath.join(dir, 'alias.json'))
    expect(() => loadPatch(root, 'alias')).toThrow(/symlink/)
  })

  it('refuses a symlinked patches directory on save', () =>
  {
    const root = tempRoot()
    const outside = tempRoot()
    NodeFS.mkdirSync(NodePath.join(root, '.cartographer'), { recursive: true })
    NodeFS.symlinkSync(outside, NodePath.join(root, '.cartographer', 'patches'))
    expect(() => savePatch(root, patchOf([{ op: 'add_file', path: 'src/a/new.ts' }]))).toThrow(
      /symlink/,
    )
  })

  it('does not report an unreadable patch catalog as empty', () =>
  {
    const root = tempRoot()
    NodeFS.mkdirSync(NodePath.join(root, '.cartographer'), { recursive: true })
    NodeFS.writeFileSync(NodePath.join(root, '.cartographer', 'patches'), 'not a directory')

    expect(() => listPatches(root)).toThrow(/ENOTDIR|not a directory/i)
  })
})

describe('validatePatchStructure', () =>
{
  it('flags boundary pairs going from zero imports to some', () =>
  {
    const base = graph(['src/a/one.ts', 'src/b/two.ts'], [['src/a/one.ts', 'src/b/two.ts']])
    const patch = patchOf([{ op: 'add_import', from: 'src/b/two.ts', to: 'src/a/one.ts' }])
    const applied = applyPatch(base, patch, resolver)
    const head = patchHeadGraph(base, patch, applied)
    const validation = validatePatchStructure(base, head, applied.originByPath)
    expect(validation.newBoundaries).toEqual([
      {
        from: 'src/b',
        to: 'src/a',
        baseCount: 0,
        headCount: 1,
        sample: [{ from: 'src/b/two.ts', to: 'src/a/one.ts' }],
      },
    ])
    // the pre-existing a -> b boundary is not news
    expect(validation.newBoundaries.some((b) => b.from === 'src/a')).toBe(false)
  })

  it('distinguishes files orphaned by the patch from unconnected adds', () =>
  {
    const base = graph(['src/a/one.ts', 'src/a/two.ts'], [['src/a/one.ts', 'src/a/two.ts']])
    const patch = patchOf([
      { op: 'remove_import', from: 'src/a/one.ts', to: 'src/a/two.ts' },
      { op: 'add_file', path: 'src/a/loose.ts' },
    ])
    const applied = applyPatch(base, patch, resolver)
    const head = patchHeadGraph(base, patch, applied)
    const validation = validatePatchStructure(base, head, applied.originByPath)
    expect(validation.orphans).toEqual([
      { file: 'src/a/loose.ts', kind: 'added-unconnected' },
      { file: 'src/a/one.ts', kind: 'becomes-orphan' },
      { file: 'src/a/two.ts', kind: 'becomes-orphan' },
    ])
    expect(validation.totals).toEqual({
      cycles: 0,
      newBoundaries: 0,
      orphans: 3,
    })
  })

  it('does not report a pre-existing cycle after one endpoint moves', () =>
  {
    const base = graph(
      ['src/a/one.ts', 'src/b/two.ts'],
      [
        ['src/a/one.ts', 'src/b/two.ts'],
        ['src/b/two.ts', 'src/a/one.ts'],
      ],
    )
    const patch = patchOf([{ op: 'move_file', from: 'src/a/one.ts', to: 'src/c/one.ts' }])
    const applied = applyPatch(base, patch, resolver)
    const head = patchHeadGraph(base, patch, applied)
    const validation = validatePatchStructure(base, head, applied.originByPath)

    expect(validation).toEqual({
      cycles: [],
      newBoundaries: [],
      orphans: [],
      totals: { cycles: 0, newBoundaries: 0, orphans: 0 },
    })
  })

  it('handles move orphan edges: keep existing orphan, flag lost connectivity', () =>
  {
    const keptOrphanBase = graph(['src/a/lone.ts'], [])
    const keptOrphanPatch = patchOf([
      { op: 'move_file', from: 'src/a/lone.ts', to: 'src/b/lone.ts' },
    ])
    const keptApplied = applyPatch(keptOrphanBase, keptOrphanPatch, resolver)
    expect(
      validatePatchStructure(
        keptOrphanBase,
        patchHeadGraph(keptOrphanBase, keptOrphanPatch, keptApplied),
        keptApplied.originByPath,
      ).orphans,
    ).toEqual([])

    const base = graph(
      ['src/a/one.ts', 'src/b/two.ts', 'src/c/three.ts'],
      [
        ['src/a/one.ts', 'src/b/two.ts'],
        ['src/b/two.ts', 'src/c/three.ts'],
      ],
    )
    const patch = patchOf([
      { op: 'move_file', from: 'src/a/one.ts', to: 'src/d/one.ts' },
      { op: 'remove_import', from: 'src/d/one.ts', to: 'src/b/two.ts' },
    ])
    const applied = applyPatch(base, patch, resolver)
    const head = patchHeadGraph(base, patch, applied)
    const validation = validatePatchStructure(base, head, applied.originByPath)

    expect(validation.orphans).toEqual([{ file: 'src/d/one.ts', kind: 'becomes-orphan' }])
  })

  it('reports a genuinely new boundary after a move', () =>
  {
    const base = graph(
      ['src/a/one.ts', 'src/b/two.ts', 'src/c/three.ts'],
      [['src/a/one.ts', 'src/b/two.ts']],
    )
    const patch = patchOf([
      { op: 'move_file', from: 'src/a/one.ts', to: 'src/d/one.ts' },
      { op: 'add_import', from: 'src/d/one.ts', to: 'src/c/three.ts' },
    ])
    const applied = applyPatch(base, patch, resolver)
    const head = patchHeadGraph(base, patch, applied)
    const validation = validatePatchStructure(base, head, applied.originByPath)

    expect(validation.newBoundaries).toEqual([
      {
        from: 'src/d',
        to: 'src/c',
        baseCount: 0,
        headCount: 1,
        sample: [{ from: 'src/d/one.ts', to: 'src/c/three.ts' }],
      },
    ])
  })

  it('reports only the first new edge in one final cycle component', () =>
  {
    const base = graph(
      ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'],
      [
        ['src/a.ts', 'src/b.ts'],
        ['src/b.ts', 'src/c.ts'],
        ['src/c.ts', 'src/d.ts'],
      ],
    )
    const patch = patchOf([
      { op: 'add_import', from: 'src/c.ts', to: 'src/a.ts' },
      { op: 'add_import', from: 'src/d.ts', to: 'src/b.ts' },
    ])
    const applied = applyPatch(base, patch, resolver)
    const head = patchHeadGraph(base, patch, applied)
    const validation = validatePatchStructure(base, head, applied.originByPath)

    // one cluster / one witness even when multiple new edges close the same SCC
    expect(validation.totals.cycles).toBe(1)
    expect(validation.cycles).toEqual([
      {
        from: 'src/c.ts',
        to: 'src/a.ts',
        path: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      },
    ])
  })

  it('orders separate cycle components by their first new edge', () =>
  {
    const base = graph(
      ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'],
      [
        ['src/a.ts', 'src/b.ts'],
        ['src/c.ts', 'src/d.ts'],
      ],
    )
    const patch = patchOf([
      { op: 'add_import', from: 'src/d.ts', to: 'src/c.ts' },
      { op: 'add_import', from: 'src/b.ts', to: 'src/a.ts' },
    ])
    const applied = applyPatch(base, patch, resolver)
    const head = patchHeadGraph(base, patch, applied)

    expect(validatePatchStructure(base, head, applied.originByPath).cycles).toEqual([
      {
        from: 'src/d.ts',
        to: 'src/c.ts',
        path: ['src/c.ts', 'src/d.ts'],
      },
      {
        from: 'src/b.ts',
        to: 'src/a.ts',
        path: ['src/a.ts', 'src/b.ts'],
      },
    ])
  })

  it('reports a new chord in an existing SCC & a new self-loop', () =>
  {
    const base = graph(
      ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/x.ts'],
      [
        ['src/a.ts', 'src/b.ts'],
        ['src/b.ts', 'src/c.ts'],
        ['src/c.ts', 'src/a.ts'],
      ],
    )
    const patch = patchOf([
      { op: 'add_import', from: 'src/a.ts', to: 'src/c.ts' },
      { op: 'add_import', from: 'src/x.ts', to: 'src/x.ts' },
    ])
    const applied = applyPatch(base, patch, resolver)
    const head = patchHeadGraph(base, patch, applied)

    expect(validatePatchStructure(base, head, applied.originByPath).cycles).toEqual([
      {
        from: 'src/a.ts',
        to: 'src/c.ts',
        path: ['src/c.ts', 'src/a.ts'],
      },
      {
        from: 'src/x.ts',
        to: 'src/x.ts',
        path: ['src/x.ts'],
      },
    ])
  })

  it('keeps both endpoints when clipping a long cycle witness', () =>
  {
    const files = Array.from({ length: 45 }, (_, index) => `src/n${index}.ts`)
    const base = graph(
      files,
      files.slice(0, -1).map((file, index) => [file, files[index + 1]!] as [string, string]),
    )
    const patch = patchOf([{ op: 'add_import', from: files[44]!, to: files[0]! }])
    const applied = applyPatch(base, patch, resolver)
    const head = patchHeadGraph(base, patch, applied)

    const cycle = validatePatchStructure(base, head, applied.originByPath).cycles[0]!

    // clipping drops from the middle so the witness still connects the pair
    // it is labelled w/; the elided hop count rides along
    expect(cycle.path).toEqual([...files.slice(0, 20), ...files.slice(25)])
    expect(cycle.path[0]).toBe(cycle.to)
    expect(cycle.path.at(-1)).toBe(cycle.from)
    expect(cycle.pathOmitted).toBe(5)
  })
})

describe('evaluatePatch limits', () =>
{
  it('rejects oversized base & hypothetical head graphs', () =>
  {
    const base = graph(
      Array.from({ length: MAX_PATCH_EVALUATION_NODES }, (_, index) => `src/n${index}.ts`),
      [],
    )

    expect(() =>
      evaluatePatch(base, patchOf([{ op: 'add_file', path: 'src/new.ts' }]), resolver),
    ).toThrowError(
      expect.objectContaining({
        code: 'PATCH_EVALUATION_LIMIT',
        kind: 'nodes',
        scope: 'head',
      }),
    )

    base.nodes.push({
      id: 'src/over-limit.ts',
      kind: 'file',
      label: 'over-limit.ts',
      group: 'src',
    })
    expect(() =>
      evaluatePatch(base, patchOf([{ op: 'remove_file', path: 'src/over-limit.ts' }]), resolver),
    ).toThrowError(PatchEvaluationLimitError)
  })

  it('bounds repeated incident-edge work independently of graph size', () =>
  {
    const hub = 'src/hub-a.ts'
    const leaves = Array.from({ length: 1_600 }, (_, index) => `src/leaf-${index}.ts`)
    const base = graph(
      [hub, ...leaves],
      leaves.map((leaf) => [leaf, hub]),
    )
    const ops = Array.from({ length: 1_900 }, (_, index) => ({
      op: 'move_file' as const,
      from: index % 2 === 0 ? 'src/hub-a.ts' : 'src/hub-b.ts',
      to: index % 2 === 0 ? 'src/hub-b.ts' : 'src/hub-a.ts',
    }))

    expect(() => evaluatePatch(base, patchOf(ops), resolver)).toThrowError(
      expect.objectContaining({
        code: 'PATCH_EVALUATION_LIMIT',
        kind: 'work',
      }),
    )
  })

  it('charges edge, rule, and allowVia matching before it can run unbounded', () =>
  {
    const ruleCount = 1_000
    const edgeCount = 800
    const target = 'src/target.ts'
    const sources = Array.from({ length: edgeCount }, (_, index) => `src/source-${index}.ts`)
    const base = graph(
      [target, ...sources],
      sources.map((source) => [source, target]),
    )
    base.rules = Array.from({ length: ruleCount }, (_, index) => ({
      id: `rule-${index}`,
      from: 'src/**',
      to: 'src/**',
      verdict: 'allow-only' as const,
      allowVia: ['allowed/**', 'internal/**'],
      severity: 'error' as const,
    }))

    expect(() =>
      evaluatePatch(base, patchOf([{ op: 'add_file', path: 'src/new.ts' }]), resolver),
    ).toThrowError(
      expect.objectContaining({
        code: 'PATCH_EVALUATION_LIMIT',
        kind: 'work',
        actual: MAX_PATCH_EVALUATION_WORK + 1,
        limit: MAX_PATCH_EVALUATION_WORK,
        scope: 'evaluation',
      }),
    )
  })

  it('checks the raw base edge ceiling before endpoint deduplication', () =>
  {
    const base = graph(
      ['src/a.ts', 'src/b.ts'],
      Array.from(
        { length: MAX_PATCH_EVALUATION_EDGES + 1 },
        () => ['src/a.ts', 'src/b.ts'] as [string, string],
      ),
    )

    expect(() =>
      evaluatePatch(
        base,
        patchOf([{ op: 'remove_import', from: 'src/a.ts', to: 'src/b.ts' }]),
        resolver,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: 'PATCH_EVALUATION_LIMIT',
        kind: 'edges',
        scope: 'base',
      }),
    )
  })
})
