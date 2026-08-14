// tests/packages/cartographer-core/analyze/graphDiff.test.ts
// structural edge identity, move/API drift, bounded evidence & staleness

import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import { afterAll, describe, expect, it } from 'vite-plus/test'
import {
  computeBlastRadius,
  impactedFileCount,
} from '../../../../packages/cartographer-core/src/analyze/blast-radius.ts'
import {
  diffGraphs,
  formatDiffSummary,
  type FileApiChange,
} from '../../../../packages/cartographer-core/src/analyze/diff.ts'
import {
  boundApiChanges,
  boundList,
} from '../../../../packages/cartographer-core/src/analyze/evidenceBounds.ts'
import {
  aggregateMoveFlows,
  pairMoves,
} from '../../../../packages/cartographer-core/src/analyze/moves.ts'
import { formatPrSummary } from '../../../../packages/cartographer-core/src/emit/pr-summary.ts'
import { writeCheckPrArtifacts } from '../../../../packages/cartographer-core/src/cli/commands/checkPr.ts'
import {
  gitRefsMatch,
  proposalStaleness,
} from '../../../../packages/cartographer-core/src/store/proposalStaleness.ts'
import { workingTreeState } from '../../../../packages/cartographer-core/src/store/workingTree.ts'
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

function apiGraph(
  provider: string,
  exports: string[],
  pulls: Array<[string, string[] | undefined]>,
): CartographerGraph
{
  const result = graph(
    [provider, ...pulls.map(([from]) => from)],
    pulls.map(([from]) => [from, provider]),
  )
  result.nodes.find((node) => node.id === provider)!.exports = exports.map((name) => ({ name }))
  pulls.forEach(([, symbols], index) =>
  {
    if (symbols !== undefined)
    {
      result.edges[index]!.symbols = symbols
    }
  })
  return result
}

const tempRoots = trackedTempRoot('carto-tg7-')
const tempDir = tempRoots.create

afterAll(tempRoots.cleanup)

describe('move pairing', () =>
{
  it('resolves same-basename ambiguity via stable-neighbor overlap', () =>
  {
    // two index.ts moves; each keeps its own stable importer
    const base = graph(
      ['src/a/index.ts', 'src/b/index.ts', 'src/useA.ts', 'src/useB.ts'],
      [
        ['src/useA.ts', 'src/a/index.ts'],
        ['src/useB.ts', 'src/b/index.ts'],
      ],
    )
    const head = graph(
      ['src/x/index.ts', 'src/y/index.ts', 'src/useA.ts', 'src/useB.ts'],
      [
        ['src/useA.ts', 'src/x/index.ts'],
        ['src/useB.ts', 'src/y/index.ts'],
      ],
    )
    const diff = diffGraphs(base, head)
    expect(diff.movedNodes).toEqual([
      { from: 'src/a/index.ts', to: 'src/x/index.ts' },
      { from: 'src/b/index.ts', to: 'src/y/index.ts' },
    ])
    expect(diff.addedNodes).toEqual([])
    expect(diff.removedNodes).toEqual([])
  })

  it('refuses low-confidence pairs (no neighbors, different parent dir)', () =>
  {
    const base = graph(['src/old/util.ts'], [])
    const head = graph(['src/new/util.ts'], [])
    const diff = diffGraphs(base, head)
    expect(diff.movedNodes).toEqual([])
    expect(diff.addedNodes).toEqual(['src/new/util.ts'])
    expect(diff.removedNodes).toEqual(['src/old/util.ts'])
  })

  it('admits neighbor-less pairs when the parent dir name matches', () =>
  {
    // features/auth/api.ts -> modules/auth/api.ts shares the auth segment
    const base = graph(['features/auth/api.ts'], [])
    const head = graph(['modules/auth/api.ts'], [])
    const { moved } = pairMoves(base, head, ['features/auth/api.ts'], ['modules/auth/api.ts'])
    expect(moved).toEqual([{ from: 'features/auth/api.ts', to: 'modules/auth/api.ts' }])
  })

  it('aggregates dir-level flows w/ exact counts, heaviest first', () =>
  {
    const flows = aggregateMoveFlows([
      { from: 'src/a/one.ts', to: 'src/z/one.ts' },
      { from: 'src/a/two.ts', to: 'src/z/two.ts' },
      { from: 'src/b/three.ts', to: 'src/z/three.ts' },
    ])
    expect(flows).toEqual([
      { from: 'src/a', to: 'src/z', count: 2 },
      { from: 'src/b', to: 'src/z', count: 1 },
    ])
  })
})

describe('edge reclassification', () =>
{
  it('keeps legal display-delimiter endpoints structurally distinct', () =>
  {
    const files = ['a -> b', 'c', 'a', 'b -> c']
    const base = graph(files, [
      ['a -> b', 'c'],
      ['a', 'b -> c'],
    ])
    const head = graph(files, [['a', 'b -> c']])

    const diff = diffGraphs(base, head)

    expect(diff.addedEdges).toEqual([])
    expect(diff.removedEdges).toEqual([{ from: 'a -> b', to: 'c' }])
  })

  it('collapses churn that followed a move & keeps genuine drift', () =>
  {
    const base = graph(
      ['src/lib/moved.ts', 'src/keep/stable.ts', 'src/keep/other.ts'],
      [
        ['src/keep/stable.ts', 'src/lib/moved.ts'],
        ['src/lib/moved.ts', 'src/keep/other.ts'],
      ],
    )
    const head = graph(
      ['src/core/moved.ts', 'src/keep/stable.ts', 'src/keep/other.ts'],
      [
        // both edges followed the move; one import is genuinely new
        ['src/keep/stable.ts', 'src/core/moved.ts'],
        ['src/core/moved.ts', 'src/keep/other.ts'],
        ['src/keep/other.ts', 'src/keep/stable.ts'],
      ],
    )
    const diff = diffGraphs(base, head)
    expect(diff.movedNodes).toEqual([{ from: 'src/lib/moved.ts', to: 'src/core/moved.ts' }])
    expect(diff.movedEdges).toBe(2)
    expect(diff.removedEdges).toEqual([])
    expect(diff.addedEdges).toEqual([{ from: 'src/keep/other.ts', to: 'src/keep/stable.ts' }])
    expect(diff.changed).toBe(true)
  })

  it('reports moves-only drift as changed w/ a move summary', () =>
  {
    const base = graph(
      ['src/lib/moved.ts', 'src/keep/stable.ts'],
      [['src/keep/stable.ts', 'src/lib/moved.ts']],
    )
    const head = graph(
      ['src/core/moved.ts', 'src/keep/stable.ts'],
      [['src/keep/stable.ts', 'src/core/moved.ts']],
    )
    const diff = diffGraphs(base, head)
    expect(diff.addedNodes).toEqual([])
    expect(diff.removedNodes).toEqual([])
    expect(diff.addedEdges).toEqual([])
    expect(diff.removedEdges).toEqual([])
    expect(diff.changed).toBe(true)
    expect(formatDiffSummary(diff)).toBe('1 moved file(s), 1 moved import(s)')
  })
})

describe('move-aware API drift', () =>
{
  it('reports the head path & only currently broken consumers', () =>
  {
    const oldProvider = 'src/old/service.ts'
    const newProvider = 'src/new/service.ts'
    const base = apiGraph(
      oldProvider,
      ['gone', 'stay'],
      [
        ['src/consumer/named.ts', ['gone']],
        ['src/consumer/unknown.ts', undefined],
        ['src/consumer/side-effect.ts', []],
        ['src/consumer/updated.ts', ['gone']],
      ],
    )
    const head = apiGraph(
      newProvider,
      ['stay'],
      [
        ['src/consumer/named.ts', ['gone']],
        ['src/consumer/unknown.ts', undefined],
        ['src/consumer/side-effect.ts', []],
        ['src/consumer/updated.ts', ['stay']],
      ],
    )

    const diff = diffGraphs(base, head)

    expect(diff.movedNodes).toEqual([{ from: oldProvider, to: newProvider }])
    expect(diff.apiChanges).toEqual([
      {
        file: newProvider,
        addedExports: [],
        removedExports: [
          {
            name: 'gone',
            brokenConsumers: ['src/consumer/named.ts', 'src/consumer/unknown.ts'],
          },
        ],
      },
    ])
    const bounded = boundApiChanges(diff.apiChanges, {
      files: 200,
      exportsPerFile: 100,
      consumersPerExport: 50,
    })
    expect(bounded.totals.consumers).toBe(2)
    expect(bounded.files[0]?.removedExports[0]?.item.brokenConsumers).toEqual([
      'src/consumer/named.ts',
      'src/consumer/unknown.ts',
    ])
  })
})

describe('bounder truncation invariants', () =>
{
  it('keeps totals - retained === truncated for moved lists past the cap', () =>
  {
    const count = 620
    const baseFiles: string[] = ['src/keep/anchor.ts']
    const headFiles: string[] = ['src/keep/anchor.ts']
    const baseEdges: Array<[string, string]> = []
    const headEdges: Array<[string, string]> = []
    for (let i = 0; i < count; i += 1)
    {
      // per-file dirs -> one flow per move, so flows exceed the cap too
      baseFiles.push(`src/old/d${i}/f${i}.ts`)
      headFiles.push(`src/new/d${i}/f${i}.ts`)
      baseEdges.push([`src/old/d${i}/f${i}.ts`, 'src/keep/anchor.ts'])
      headEdges.push([`src/new/d${i}/f${i}.ts`, 'src/keep/anchor.ts'])
    }
    const diff = diffGraphs(graph(baseFiles, baseEdges), graph(headFiles, headEdges))
    expect(diff.movedNodes).toHaveLength(count)
    const movedNodes = boundList(diff.movedNodes, 500)
    const moveFlows = boundList(diff.moveFlows, 500)
    expect(movedNodes.items).toHaveLength(500)
    expect(moveFlows.items).toHaveLength(500)
    expect(movedNodes.total - movedNodes.items.length).toBe(movedNodes.omitted)
    expect(moveFlows.total - moveFlows.items.length).toBe(moveFlows.omitted)
    // flow counts stay exact under slicing
    expect(moveFlows.items.reduce((sum, flow) => sum + flow.count, 0)).toBe(500)
  })
})

describe('nested API evidence policies', () =>
{
  it('rejects every invalid policy dimension even on empty evidence', () =>
  {
    for (const limits of [
      { files: -1, exportsPerFile: 1, consumersPerExport: 1 },
      { files: 1, exportsPerFile: Number.NaN, consumersPerExport: 1 },
      {
        files: 1,
        exportsPerFile: 1,
        consumersPerExport: Number.MAX_SAFE_INTEGER + 1,
      },
    ])
    {
      expect(() => boundApiChanges([], limits)).toThrow(/evidence limit/)
    }
  })

  it('keeps adapter caps distinct w/ exact hierarchical omissions', () =>
  {
    const first: FileApiChange = {
      file: 'src/api/first.ts',
      removedExports: Array.from({ length: 120 }, (_, index) => ({
        name: `removed${index}`,
        ...(index === 0
          ? {
              brokenConsumers: Array.from(
                { length: 60 },
                (_, consumer) => `src/consumer/visible${consumer}.ts`,
              ),
            }
          : index === 110
            ? {
                brokenConsumers: Array.from(
                  { length: 7 },
                  (_, consumer) => `src/consumer/export-hidden${consumer}.ts`,
                ),
              }
            : {}),
      })),
      addedExports: Array.from({ length: 20 }, (_, index) => ({
        name: `added${index}`,
      })),
    }
    const changes: FileApiChange[] = [
      first,
      ...Array.from({ length: 199 }, (_, index) => ({
        file: `src/api/file-${index + 1}.ts`,
        removedExports: [{ name: `stable${index}` }],
        addedExports: [],
      })),
      {
        file: 'src/api/file-200.ts',
        removedExports: [
          {
            name: 'fileHidden',
            brokenConsumers: Array.from(
              { length: 4 },
              (_, index) => `src/consumer/file-hidden${index}.ts`,
            ),
          },
          { name: 'alsoFileHidden' },
        ],
        addedExports: [{ name: 'newFileHidden' }],
      },
    ]

    const http = boundApiChanges(changes, {
      files: 200,
      exportsPerFile: 100,
      consumersPerExport: 50,
    })
    const mcp = boundApiChanges(changes, {
      files: 100,
      exportsPerFile: 50,
      consumersPerExport: 25,
    })

    expect(http.totals).toEqual({
      files: 201,
      addedExports: 21,
      removedExports: 321,
      exports: 342,
      consumers: 71,
    })
    expect(mcp.totals).toEqual(http.totals)
    expect(http.omitted).toEqual({
      files: 1,
      exports: 43,
      consumers: 21,
      total: 65,
    })
    expect(mcp.omitted).toEqual({
      files: 101,
      exports: 193,
      consumers: 46,
      total: 340,
    })
    expect(http.files[0]!.removedExports).toHaveLength(100)
    expect(http.files[0]!.addedExports).toEqual([])
    expect(http.files[0]!.omittedExports).toBe(40)
    expect(http.files[0]!.omittedConsumers).toBe(17)
    expect(mcp.files[0]!.removedExports).toHaveLength(50)
    expect(mcp.files[0]!.addedExports).toEqual([])
    expect(mcp.files[0]!.omittedExports).toBe(90)
    expect(mcp.files[0]!.omittedConsumers).toBe(42)
    expect(http.files.at(-1)!.file).toBe('src/api/file-199.ts')
    expect(mcp.files.at(-1)!.file).toBe('src/api/file-99.ts')
  })
})

describe('bounded PR summary', () =>
{
  it('keeps a combined removed-first API budget w/ exact file omissions', () =>
  {
    const provider = 'src/api/provider.ts'
    const base = apiGraph(
      provider,
      Array.from({ length: 120 }, (_, index) => `removed${index}`),
      [],
    )
    const head = apiGraph(
      provider,
      Array.from({ length: 20 }, (_, index) => `added${index}`),
      [],
    )

    const diff = diffGraphs(base, head)
    const firstFile = diff.apiChanges[0]!
    firstFile.removedExports[0]!.brokenConsumers = Array.from(
      { length: 10 },
      (_, index) => `src/consumer/visible${index}.ts`,
    )
    firstFile.removedExports.at(-1)!.brokenConsumers = [
      'src/consumer/hidden0.ts',
      'src/consumer/hidden1.ts',
      'src/consumer/hidden2.ts',
    ]
    diff.apiChanges.push(
      ...Array.from({ length: 19 }, (_, index) => ({
        file: `src/api/secondary${index}.ts`,
        removedExports: [{ name: `secondary${index}` }],
        addedExports: [],
      })),
      {
        file: 'src/api/omitted-file.ts',
        removedExports: [
          {
            name: 'hiddenExport',
            brokenConsumers: [
              'src/consumer/file-hidden0.ts',
              'src/consumer/file-hidden1.ts',
              'src/consumer/file-hidden2.ts',
              'src/consumer/file-hidden3.ts',
            ],
          },
          { name: 'alsoHidden' },
        ],
        addedExports: [{ name: 'newButHidden' }],
      },
    )

    const summary = formatPrSummary(diff, base, head)

    expect(summary).toContain('omitted for this file: 40 export change(s), 5 importer name(s)')
    expect(summary).toContain(
      'omitted overall: 1 API-change file(s), 43 export change(s), 9 importer name(s)',
    )
    expect(summary).toContain('removed `removed0`')
    expect(summary).not.toContain('added `added0`')
    expect(summary).not.toContain('src/api/omitted-file.ts')
  })

  it('falls back to exact counts below the UTF-8 comment ceiling', () =>
  {
    const provider = 'src/api/provider.ts'
    const longSuffix = 'x'.repeat(1_000)
    const base = apiGraph(
      provider,
      Array.from({ length: 150 }, (_, index) => `removed${index}${longSuffix}`),
      [],
    )
    const head = apiGraph(
      provider,
      Array.from({ length: 50 }, (_, index) => `added${index}${longSuffix}`),
      [],
    )

    const summary = formatPrSummary(diffGraphs(base, head), base, head)

    expect(Buffer.byteLength(summary, 'utf-8')).toBeLessThanOrEqual(60_000)
    expect(summary).toContain('| Added exports | 50 |')
    expect(summary).toContain('| Removed exports | 150 |')
    expect(summary).toContain('Run `cartographer diff`')
    expect(summary).toContain('uploaded `pr-diff.json` artifact')
  })

  it('writes the complete diff artifact under a custom output path', () =>
  {
    const root = tempDir()
    const base = graph(['src/a.ts'], [])
    const head = graph(['src/a.ts', 'src/b.ts'], [])
    const diff = diffGraphs(base, head)
    const summary = formatPrSummary(diff, base, head)

    const paths = writeCheckPrArtifacts(root, 'custom-output', diff, summary)

    expect(paths.diffPath).toBe(NodePath.join(root, 'custom-output', 'pr-diff.json'))
    expect(JSON.parse(NodeFS.readFileSync(paths.diffPath, 'utf-8'))).toEqual(diff)
    expect(NodeFS.readFileSync(paths.summaryPath, 'utf-8')).toBe(summary)
  })

  it('includes current API totals in the count-only fallback', () =>
  {
    const base = graph([], [])
    const head = graph(
      Array.from({ length: 20 }, (_, index) => `src/${index}-${'x'.repeat(4_000)}.ts`),
      [],
    )

    const summary = formatPrSummary(diffGraphs(base, head), base, head)

    expect(Buffer.byteLength(summary, 'utf-8')).toBeLessThanOrEqual(60_000)
    expect(summary).toContain('| Public API files | 0 |')
  })
})

describe('blast radius totals', () =>
{
  it('counts a file reached through both sides of a cycle once', () =>
  {
    const result = computeBlastRadius(
      graph(
        ['src/a.ts', 'src/b.ts'],
        [
          ['src/a.ts', 'src/b.ts'],
          ['src/b.ts', 'src/a.ts'],
        ],
      ),
      'src/a.ts',
    )

    expect(result.upstream).toEqual(['src/b.ts'])
    expect(result.downstream).toEqual(['src/b.ts'])
    expect(impactedFileCount(result)).toBe(1)
  })
})

describe('working-tree staleness', () =>
{
  function gitRepo(): string
  {
    const dir = tempDir()
    NodeChildProcess.execFileSync('git', ['-C', dir, 'init', '-q'])
    NodeChildProcess.execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t.com'])
    NodeChildProcess.execFileSync('git', ['-C', dir, 'config', 'user.name', 't'])
    NodeFS.mkdirSync(NodePath.join(dir, 'src'), { recursive: true })
    NodeFS.writeFileSync(NodePath.join(dir, 'src/a.ts'), 'export const a = 1\n')
    NodeChildProcess.execFileSync('git', ['-C', dir, 'add', '-A'])
    NodeChildProcess.execFileSync('git', ['-C', dir, 'commit', '-qm', 'init'])
    return dir
  }

  it('reports ref + clean/dirty state & caches per root', () =>
  {
    const dir = gitRepo()
    const clean = workingTreeState(dir, 0)
    expect(clean?.gitRef).toMatch(/^[0-9a-f]{4,}$/)
    expect(clean?.dirty).toBe(false)
    NodeFS.writeFileSync(NodePath.join(dir, 'src/b.ts'), 'export const b = 2\n')
    expect(workingTreeState(dir, 0)?.dirty).toBe(true)
  })

  it('returns undefined outside a git repository', () =>
  {
    expect(workingTreeState(tempDir(), 0)).toBeUndefined()
  })
})

describe('proposal staleness', () =>
{
  it('reports every independent reason in canonical order', () =>
  {
    expect(
      proposalStaleness(
        {
          generatedAt: '2026-01-01T00:00:00.000Z',
          gitRef: 'aaaa1111',
        },
        {
          generatedAt: '2026-01-02T00:00:00.000Z',
          gitRef: 'bbbb2222',
        },
        { gitRef: 'bbbb2222', dirty: true },
      ),
    ).toEqual({
      stale: true,
      reasons: ['generation-mismatch', 'ref-mismatch', 'dirty-tree'],
      baseline: {
        generatedAt: '2026-01-01T00:00:00.000Z',
        gitRef: 'aaaa1111',
      },
      graph: {
        generatedAt: '2026-01-02T00:00:00.000Z',
        gitRef: 'bbbb2222',
      },
      workingTree: { gitRef: 'bbbb2222', dirty: true },
    })
  })

  it('keeps missing evidence fresh & compares abbreviated refs both ways', () =>
  {
    expect(gitRefsMatch('abcdef1', 'abcdef1234567890')).toBe(true)
    expect(gitRefsMatch('abcdef1234567890', 'abcdef1')).toBe(true)
    expect(
      proposalStaleness(undefined, {
        generatedAt: '2026-01-02T00:00:00.000Z',
      }),
    ).toEqual({
      stale: false,
      reasons: [],
      graph: { generatedAt: '2026-01-02T00:00:00.000Z' },
    })
    expect(
      proposalStaleness(
        {
          generatedAt: '2026-01-02T00:00:00.000Z',
          gitRef: 'abcdef1',
        },
        {
          generatedAt: '2026-01-02T00:00:00.000Z',
          gitRef: 'abcdef1234567890',
        },
        { gitRef: 'abcdef1234567890', dirty: false },
      ).reasons,
    ).toEqual([])
    expect(
      proposalStaleness(
        {
          generatedAt: '2026-01-02T00:00:00.000Z',
          gitRef: 'abcdef1',
        },
        {
          generatedAt: '2026-01-02T00:00:00.000Z',
          gitRef: 'abcdef1234567890',
        },
        { gitRef: '9999999', dirty: false },
      ).reasons,
    ).toEqual(['ref-mismatch'])
  })
})
