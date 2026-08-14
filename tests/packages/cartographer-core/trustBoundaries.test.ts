// tests/packages/cartographer-core/trustBoundaries.test.ts
// verify report, artifact, and annotation trust boundaries

import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import { afterAll, describe, expect, it } from 'vite-plus/test'
import { applyAnnotations } from '../../../packages/cartographer-core/src/analyze/annotations.ts'
import { emitArchitectureMarkdown } from '../../../packages/cartographer-core/src/emit/architectureMarkdown.ts'
import { writeFileAtomic } from '../../../packages/cartographer-core/src/store/artifactFs.ts'
import { saveGraph } from '../../../packages/cartographer-core/src/store/index.ts'
import {
  GRAPH_SCHEMA_VERSION,
  type CartographerGraph,
} from '../../../packages/cartographer-core/src/contracts/types.ts'
import { trackedTempRoot } from './helpers/trackedTempRoot.ts'

const tempRoots = trackedTempRoot('carto-tg1-')
const tempDir = tempRoots.create

afterAll(tempRoots.cleanup)

const PAYLOAD = '<img src="x" onerror="alert(31337)" />'

function makeGraph(over: Partial<CartographerGraph> = {}): CartographerGraph
{
  return {
    version: GRAPH_SCHEMA_VERSION,
    repoRoot: '/tmp/fixture',
    mode: 'imports',
    generatedAt: '2026-07-10T00:00:00.000Z',
    scope: 'src',
    nodes: [
      { id: 'src/a.ts', kind: 'file', label: 'a.ts', group: 'src/core' },
      { id: 'src/b.ts', kind: 'file', label: 'b.ts', group: 'src/util' },
    ],
    edges: [{ id: 'e0', from: 'src/a.ts', to: 'src/b.ts', kind: 'imports' }],
    groups: [
      { id: 'src/core', label: 'core', fileCount: 1, description: PAYLOAD },
      { id: 'src/util', label: 'util', fileCount: 1 },
    ],
    metrics: { cycles: 0, orphans: 0, maxFanIn: 1, maxFanOut: 1 },
    ...over,
  }
}

describe('F01 report escaping', () =>
{
  it('neutralizes active markup in group descriptions', () =>
  {
    const graph = makeGraph()
    const report = emitArchitectureMarkdown(graph)
    expect(report).not.toContain('<img')
    expect(report).toContain('&lt;img src=')
  })

  it('quotes YAML scalars and survives adversarial metadata', () =>
  {
    const graph = makeGraph({
      repoRoot: '/tmp/evil: "root"\n<script>alert(1)</script>',
      scope: 'src`|{}<b>',
      gitRef: 'ref"quote',
    })
    const report = emitArchitectureMarkdown(graph)
    expect(report).toContain(`repoRoot: ${JSON.stringify(graph.repoRoot)}`)
    expect(report).toContain(`scope: ${JSON.stringify(graph.scope)}`)
    expect(report).toContain(`gitRef: ${JSON.stringify(graph.gitRef)}`)
    expect(report).toContain("Imports graph of `src'\\|{}<b>`")
  })

  it('keeps mermaid labels inside their quoted strings', () =>
  {
    const graph = makeGraph({
      groups: [
        {
          id: 'src/core',
          label: 'core"]; click x href "javascript:alert(1)',
          fileCount: 1,
        },
        { id: 'src/util', label: 'util<svg>', fileCount: 1 },
      ],
    })
    const report = emitArchitectureMarkdown(graph)
    const fences = report.match(/```mermaid[\s\S]*?```/g) ?? []
    expect(fences.length).toBeGreaterThan(0)
    for (const fence of fences)
    {
      expect(fence).not.toContain('"]; click')
      expect(fence).not.toContain('<svg>')
    }
  })

  it('escapes authored journey prose in both markdown and mermaid sinks', () =>
  {
    const graph = makeGraph({
      journeys: [
        {
          id: 'signup',
          title: 'Signup"]; click x href "javascript:alert(1)',
          why: PAYLOAD,
          stops: [
            {
              at: 'src/a.ts',
              title: 'Request<svg>',
              timing: 'immediate',
              why: PAYLOAD,
              resolved: ['src/a.ts'],
            },
            {
              at: 'src/b.ts',
              title: 'Persist|{}`',
              timing: 'deferred',
              stale: true,
            },
          ],
        },
      ],
    })
    const report = emitArchitectureMarkdown(graph)
    expect(report).toContain('## Journeys')
    expect(report).not.toContain('<img')
    expect(report).toContain('&lt;img src=')
    const fences = report.match(/```mermaid[\s\S]*?```/g) ?? []
    const journeyFence = fences.find((fence) => fence.includes('classDef'))!
    expect(journeyFence).toContain('no static import')
    expect(journeyFence).not.toContain('"]; click')
    expect(journeyFence).not.toContain('<svg>')
  })
})

describe('graph.json journey normalization', () =>
{
  it('drops invalid journeys and orders survivors by id', () =>
  {
    const root = tempDir()
    const stops = [
      { at: 'src/a.ts', title: 'One', timing: 'immediate' as const },
      { at: 'src/b.ts', title: 'Two', timing: 'deferred' as const },
    ]
    const path = saveGraph(
      makeGraph({
        journeys: [
          { id: 'zeta', title: 'Zeta', stops },
          // unknown timing & a single-stop narrative are both unusable
          {
            id: 'bad-timing',
            title: 'Bad',
            stops: [stops[0]!, { at: 'src/b.ts', title: 'Two', timing: 'eventually' }],
          },
          { id: 'too-short', title: 'Short', stops: [stops[0]!] },
          { id: 'alpha', title: 'Alpha', stops },
        ] as NonNullable<CartographerGraph['journeys']>,
      }),
      root,
    )
    const stored = JSON.parse(NodeFS.readFileSync(path, 'utf-8')) as CartographerGraph
    expect(stored.journeys?.map((journey) => journey.id)).toEqual(['alpha', 'zeta'])
  })
})

describe('F02 symlink-safe artifact writes', () =>
{
  it('publishes complete overwrites and cleans failed-publication temps', () =>
  {
    const root = tempDir()
    const target = NodePath.join(root, 'artifact.json')
    const first = `${'first-α'.repeat(100_000)}\n`
    const second = `${'second-β'.repeat(100_000)}\n`

    writeFileAtomic(target, first)
    expect(NodeFS.readFileSync(target, 'utf-8')).toBe(first)
    writeFileAtomic(target, second)
    expect(NodeFS.readFileSync(target, 'utf-8')).toBe(second)

    const blocked = NodePath.join(root, 'blocked.json')
    NodeFS.mkdirSync(blocked)
    NodeFS.writeFileSync(NodePath.join(blocked, 'sentinel'), 'untouched')
    expect(() => writeFileAtomic(blocked, 'replacement')).toThrow()
    expect(NodeFS.readFileSync(NodePath.join(blocked, 'sentinel'), 'utf-8')).toBe('untouched')
    expect(NodeFS.readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('writes normal artifacts under a real .cartographer dir', () =>
  {
    const root = tempDir()
    const path = saveGraph(makeGraph(), root)
    expect(NodeFS.existsSync(path)).toBe(true)
    expect(NodeFS.existsSync(NodePath.join(root, '.cartographer', 'atlas-index.json'))).toBe(true)
  })

  it('refuses a symlinked default artifact directory', () =>
  {
    const root = tempDir()
    const external = tempDir()
    NodeFS.symlinkSync(external, NodePath.join(root, '.cartographer'))
    expect(() => saveGraph(makeGraph(), root)).toThrow(/refusing/)
    expect(NodeFS.readdirSync(external)).toEqual([])
  })

  it('allows an explicit external --out destination', () =>
  {
    const root = tempDir()
    const external = tempDir()
    const path = saveGraph(makeGraph(), root, NodePath.join(external, 'out'))
    expect(path.startsWith(external)).toBe(true)
    expect(NodeFS.existsSync(path)).toBe(true)
  })

  it('refuses to overwrite through a symlinked artifact file', async () =>
  {
    const { writeReportSource } =
      await import('../../../packages/cartographer-core/src/cli/lib/artifacts.ts')
    const root = tempDir()
    const external = tempDir()
    const sentinel = NodePath.join(external, 'victim.txt')
    NodeFS.writeFileSync(sentinel, 'untouched')
    NodeFS.mkdirSync(NodePath.join(root, '.cartographer'))
    NodeFS.symlinkSync(sentinel, NodePath.join(root, '.cartographer', 'architecture.md'))
    expect(() => writeReportSource('# nope', root)).toThrow(/symlink/)
    expect(NodeFS.readFileSync(sentinel, 'utf-8')).toBe('untouched')
  })
})

describe('F21 annotation containment and description contract', () =>
{
  it('binds one apply operation to the canonical repository identity', () =>
  {
    const root = tempDir()
    const aliasParent = tempDir()
    const alias = NodePath.join(aliasParent, 'repo')
    NodeFS.writeFileSync(NodePath.join(root, 'a.ts'), 'export const a = 1')
    NodeFS.symlinkSync(root, alias)

    const result = applyAnnotations(alias, { 'a.ts': 'description' })

    expect(result.annotationsPath).toBe(
      NodePath.join(NodeFS.realpathSync(alias), '.cartographer.annotations.json'),
    )
    expect(result.written).toBe(1)
    expect(result.missing).toEqual([])
    expect(result.invalid).toEqual([])
    expect(JSON.parse(NodeFS.readFileSync(result.annotationsPath, 'utf-8'))).toMatchObject({
      files: { 'a.ts': { description: 'description' } },
    })
  })

  it('rejects a replacement at the captured repository path', () =>
  {
    const parent = tempDir()
    const root = NodePath.join(parent, 'repo')
    const openedRoot = NodePath.join(parent, 'opened-repo')
    NodeFS.mkdirSync(root)
    NodeFS.writeFileSync(NodePath.join(root, 'a.ts'), 'export const original = 1')
    const supplied: Record<string, unknown> = {}
    Object.defineProperty(supplied, 'a.ts', {
      enumerable: true,
      get: () =>
      {
        NodeFS.renameSync(root, openedRoot)
        NodeFS.mkdirSync(root)
        NodeFS.writeFileSync(NodePath.join(root, 'a.ts'), 'export const replacement = 1')
        return 'description'
      },
    })

    expect(() => applyAnnotations(root, supplied)).toThrow(
      'repository root changed during annotation apply',
    )
    expect(NodeFS.existsSync(NodePath.join(openedRoot, '.cartographer.annotations.json'))).toBe(
      false,
    )
    expect(NodeFS.existsSync(NodePath.join(root, '.cartographer.annotations.json'))).toBe(false)
  })

  it('accepts contained regular files and rejects escapes', () =>
  {
    const root = tempDir()
    const outside = tempDir()
    NodeFS.mkdirSync(NodePath.join(root, 'src'))
    NodeFS.writeFileSync(NodePath.join(root, 'src', 'a.ts'), 'export const a = 1')
    NodeFS.writeFileSync(NodePath.join(outside, 'secret.ts'), 'secret')
    NodeFS.symlinkSync(NodePath.join(outside, 'secret.ts'), NodePath.join(root, 'link.ts'))

    const result = applyAnnotations(root, {
      'src/a.ts': 'valid description',
      '../escape.ts': 'bad',
      [NodePath.join(outside, 'secret.ts')]: 'bad absolute',
      src: 'directory target',
      'link.ts': 'symlink target',
      'missing.ts': 'not there',
      'src/multi.ts': 'line one\nline two',
      'src/long.ts': 'x'.repeat(200),
    })

    expect(result.written).toBe(1)
    expect(result.missing).toEqual(['missing.ts'])
    expect(result.invalid.sort()).toEqual(
      [
        '../escape.ts',
        NodePath.join(outside, 'secret.ts'),
        'src',
        'link.ts',
        'src/multi.ts',
        'src/long.ts',
      ].sort(),
    )
    const sidecar = JSON.parse(
      NodeFS.readFileSync(NodePath.join(root, '.cartographer.annotations.json'), 'utf-8'),
    ) as { files: Record<string, unknown> }
    expect(Object.keys(sidecar.files)).toEqual(['src/a.ts'])
  })

  it('refuses to write through a symlinked sidecar', () =>
  {
    const root = tempDir()
    const external = tempDir()
    const sentinel = NodePath.join(external, 'victim.json')
    NodeFS.writeFileSync(sentinel, '{}')
    NodeFS.writeFileSync(NodePath.join(root, 'a.ts'), 'export {}')
    NodeFS.symlinkSync(sentinel, NodePath.join(root, '.cartographer.annotations.json'))
    expect(() => applyAnnotations(root, { 'a.ts': 'desc' })).toThrow(/symlink/)
    expect(NodeFS.readFileSync(sentinel, 'utf-8')).toBe('{}')
  })
})
