// tests/packages/cartographer-core/analyze/analyzerTruth.test.ts
// real-repo analyzer truth for globs, config, history, identity & symbols

import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import { afterAll, describe, expect, it } from 'vite-plus/test'
import { buildGraph } from '../../../../packages/cartographer-core/src/analyze/graph.ts'
import {
  buildSymbolTable,
  exportList,
} from '../../../../packages/cartographer-core/src/analyze/symbols.ts'
import { computeCoChanges } from '../../../../packages/cartographer-core/src/analyze/cochange.ts'
import {
  loadConfig,
  MAX_JOURNEYS,
  MAX_RUNTIMES,
  resolveGroup,
  resolveSystem,
} from '../../../../packages/cartographer-core/src/analyze/config.ts'
import { parsePositiveInt } from '../../../../packages/cartographer-core/src/cli/lib/args.ts'
import { normalizeGraphJson } from '../../../../packages/cartographer-core/src/store/graphJson.ts'
import { trackedTempRoot } from '../helpers/trackedTempRoot.ts'

const tempRoots = trackedTempRoot('carto-tg2-')
const tempDir = tempRoots.create

function gitRepo(): string
{
  const dir = tempDir()
  NodeChildProcess.execFileSync('git', ['-C', dir, 'init', '-q'])
  NodeChildProcess.execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t.com'])
  NodeChildProcess.execFileSync('git', ['-C', dir, 'config', 'user.name', 't'])
  return dir
}

function commit(dir: string, files: Record<string, string>, message: string): void
{
  for (const [path, content] of Object.entries(files))
  {
    const full = NodePath.join(dir, path)
    NodeFS.mkdirSync(NodePath.join(full, '..'), { recursive: true })
    NodeFS.writeFileSync(full, content)
  }
  NodeChildProcess.execFileSync('git', ['-C', dir, 'add', '-A'])
  NodeChildProcess.execFileSync('git', ['-C', dir, 'commit', '-qm', message])
}

afterAll(tempRoots.cleanup)

describe('F03 segment-aware glob matcher', () =>
{
  const cfg = {
    groups: [{ match: '**/*.ts', name: 'ALL' }],
    systems: [{ match: 'src/**/foo.ts', name: 'FOO' }],
    groupDepth: 2,
  }

  it('matches zero-directory globstar (**/*.ts covers root.ts)', () =>
  {
    expect(resolveGroup('root.ts', cfg).id).toBe('ALL')
    expect(resolveGroup('nested/a.ts', cfg).id).toBe('ALL')
  })

  it('matches zero-directory inner globstar (src/**/foo.ts covers src/foo.ts)', () =>
  {
    expect(resolveSystem('src/foo.ts', cfg)?.id).toBe('FOO')
    expect(resolveSystem('src/deep/foo.ts', cfg)?.id).toBe('FOO')
    expect(resolveSystem('other/foo.ts', cfg)).toBeUndefined()
  })

  it('keeps single-star within one segment', () =>
  {
    const single = {
      groups: [{ match: 'src/*.ts', name: 'DIRECT' }],
      systems: [],
      groupDepth: 2,
    }
    expect(resolveGroup('src/a.ts', single).id).toBe('DIRECT')
    expect(resolveGroup('src/deep/a.ts', single).id).not.toBe('DIRECT')
  })

  it('does not backtrack catastrophically on adversarial patterns', () =>
  {
    const evil = {
      groups: [{ match: 'a*a*a*a*a*a*a*b', name: 'X' }],
      systems: [],
      groupDepth: 2,
    }
    const start = process.hrtime.bigint()
    resolveGroup('a'.repeat(60), evil)
    const ms = Number(process.hrtime.bigint() - start) / 1e6
    expect(ms).toBeLessThan(100)
  })
})

describe('F36 authored config validation', () =>
{
  function configWith(raw: unknown): () => void
  {
    const dir = tempDir()
    NodeFS.writeFileSync(NodePath.join(dir, '.cartographer.json'), JSON.stringify(raw))
    return () => loadConfig(dir)
  }

  it('rejects empty and control-bearing names', () =>
  {
    expect(configWith({ groups: [{ match: 'src', name: '' }] })).toThrow(/empty/)
    expect(configWith({ groups: [{ match: 'src', name: 'a\u0000b' }] })).toThrow(/control/)
  })

  it('accepts ordinary unicode and punctuation names', () =>
  {
    const dir = tempDir()
    NodeFS.writeFileSync(
      NodePath.join(dir, '.cartographer.json'),
      JSON.stringify({ groups: [{ match: 'src', name: 'Café · >/:,' }] }),
    )
    expect(loadConfig(dir).groups[0]!.name).toBe('Café · >/:,')
  })

  const journey = (over: Record<string, unknown> = {}): unknown => ({
    id: 'signup',
    title: 'Signup',
    stops: [
      { at: 'src/a.ts', title: 'Request', timing: 'immediate' },
      { at: 'src/b.ts', title: 'Email', timing: 'deferred' },
    ],
    ...over,
  })

  it('parses authored journeys', () =>
  {
    const dir = tempDir()
    NodeFS.writeFileSync(
      NodePath.join(dir, '.cartographer.json'),
      JSON.stringify({ journeys: [journey({ why: 'the lifecycle' })] }),
    )
    const parsed = loadConfig(dir).journeys!
    expect(parsed).toHaveLength(1)
    expect(parsed[0]!.why).toBe('the lifecycle')
    expect(parsed[0]!.stops.map((stop) => stop.timing)).toEqual(['immediate', 'deferred'])
  })

  it('rejects unknown timing, duplicate ids, short & oversized journeys', () =>
  {
    expect(
      configWith({
        journeys: [
          journey({
            stops: [
              { at: 'src/a.ts', title: 'Request', timing: 'eventually' },
              { at: 'src/b.ts', title: 'Email', timing: 'deferred' },
            ],
          }),
        ],
      }),
    ).toThrow(/"timing" must be one of/)
    expect(configWith({ journeys: [journey(), journey()] })).toThrow(/duplicates id "signup"/)
    expect(
      configWith({
        journeys: [
          journey({
            stops: [{ at: 'src/a.ts', title: 'Only', timing: 'immediate' }],
          }),
        ],
      }),
    ).toThrow(/"stops" must be an array of 2 or more stops/)
    expect(
      configWith({
        journeys: Array.from({ length: MAX_JOURNEYS + 1 }, (_, index) =>
          journey({ id: `j-${index}` }),
        ),
      }),
    ).toThrow(/"journeys" exceeds/)
  })
})

describe('journeys verify themselves against the built graph', () =>
{
  it('resolves stops, flags stale ones & computes hop distance', async () =>
  {
    const dir = tempDir()
    NodeFS.mkdirSync(NodePath.join(dir, 'src'), { recursive: true })
    NodeFS.writeFileSync(
      NodePath.join(dir, 'src', 'entry.ts'),
      "import { relay } from './relay.js'\nexport const start = () => relay()\n",
    )
    NodeFS.writeFileSync(
      NodePath.join(dir, 'src', 'relay.ts'),
      "import { persist } from './store.js'\nexport const relay = () => persist()\n",
    )
    NodeFS.writeFileSync(NodePath.join(dir, 'src', 'store.ts'), 'export const persist = () => 1\n')
    NodeFS.writeFileSync(
      NodePath.join(dir, '.cartographer.json'),
      JSON.stringify({
        journeys: [
          {
            id: 'signup',
            title: 'Signup',
            stops: [
              { at: 'src/entry.ts', title: 'Request', timing: 'immediate' },
              { at: 'src/store.ts', title: 'Persist', timing: 'transaction' },
              { at: 'src/worker/**', title: 'Digest', timing: 'deferred' },
            ],
          },
        ],
      }),
    )

    const graph = await buildGraph({ root: dir, scope: 'src' })
    const stops = graph.journeys![0]!.stops
    expect(stops[0]!.resolved).toEqual(['src/entry.ts'])
    expect(stops[0]!.hopDistance).toBeUndefined()
    expect(stops[1]!.hopDistance).toBe(2)
    expect(stops[1]!.hopVia).toEqual(['src/entry.ts', 'src/relay.ts', 'src/store.ts'])
    // an authored stop nothing resolves to announces its own rot
    expect(stops[2]!.stale).toBe(true)
    expect(stops[2]!.resolved).toBeUndefined()
    expect(stops[2]!.hopDistance).toBeUndefined()
  })
})

describe('authored runtimes resolve against the built graph', () =>
{
  it('rejects bad keys & oversized sets, then resolves roots to file ids', async () =>
  {
    const badKey = tempDir()
    NodeFS.writeFileSync(
      NodePath.join(badKey, '.cartographer.json'),
      JSON.stringify({
        runtimes: [{ key: 'Browser', label: 'Browser', roots: ['src/web/**'] }],
      }),
    )
    expect(() => loadConfig(badKey)).toThrow(/"key" must be kebab-case/)

    const tooMany = tempDir()
    NodeFS.writeFileSync(
      NodePath.join(tooMany, '.cartographer.json'),
      JSON.stringify({
        runtimes: Array.from({ length: MAX_RUNTIMES + 1 }, (_, index) => ({
          key: `rt-${index}`,
          label: `Runtime ${index}`,
          roots: ['src/**'],
        })),
      }),
    )
    expect(() => loadConfig(tooMany)).toThrow(/"runtimes" exceeds/)

    const dir = tempDir()
    NodeFS.mkdirSync(NodePath.join(dir, 'src', 'web'), { recursive: true })
    NodeFS.writeFileSync(
      NodePath.join(dir, 'src', 'web', 'main.ts'),
      "import { render } from '../shared.js'\nexport const boot = () => render()\n",
    )
    NodeFS.writeFileSync(NodePath.join(dir, 'src', 'shared.ts'), 'export const render = () => 1\n')
    NodeFS.writeFileSync(
      NodePath.join(dir, '.cartographer.json'),
      JSON.stringify({
        runtimes: [
          { key: 'browser', label: 'Browser', roots: ['src/web/**'] },
          { key: 'worker', label: 'Worker', roots: ['src/worker/**'] },
        ],
      }),
    )

    const graph = await buildGraph({ root: dir, scope: 'src' })
    expect(graph.runtimes![0]!.resolved).toEqual(['src/web/main.ts'])
    expect(graph.runtimes![0]!.stale).toBeUndefined()
    // an authored root nothing resolves to announces its own rot
    expect(graph.runtimes![1]!.stale).toBe(true)
    expect(graph.runtimes![1]!.resolved).toBeUndefined()
  })
})

describe('authored rule citations verify against the cited file', () =>
{
  it('stamps verified w/ a hash, not-found for a dead path & skips "none"', async () =>
  {
    const dir = tempDir()
    NodeFS.mkdirSync(NodePath.join(dir, 'src'), { recursive: true })
    NodeFS.writeFileSync(NodePath.join(dir, 'src', 'a.ts'), 'export const a = 1\n')
    NodeFS.writeFileSync(
      NodePath.join(dir, 'eslint.config.json'),
      '{ "note": "web-imports-analyze lives here" }\n',
    )
    NodeFS.writeFileSync(
      NodePath.join(dir, '.cartographer.json'),
      JSON.stringify({
        rules: [
          {
            id: 'web-imports-analyze',
            from: 'web',
            to: 'analyze',
            verdict: 'forbid',
            enforcedBy: { mechanism: 'eslint', file: 'eslint.config.json' },
          },
          {
            id: 'dead-citation',
            from: 'web',
            to: 'cli',
            verdict: 'forbid',
            enforcedBy: { mechanism: 'eslint', file: 'eslint.gone.json' },
          },
          {
            id: 'unenforced',
            from: 'cli',
            to: 'web',
            verdict: 'forbid',
            enforcedBy: { mechanism: 'none' },
          },
        ],
      }),
    )

    const graph = await buildGraph({ root: dir, scope: 'src' })
    const byId = new Map(graph.rules!.map((rule) => [rule.id, rule]))
    const verified = byId.get('web-imports-analyze')!.enforcedBy!
    expect(verified.status).toBe('verified')
    expect(verified.fileHash).toMatch(/^[0-9a-f]{12}$/)
    expect(byId.get('dead-citation')!.enforcedBy!.status).toBe('citation-not-found')
    // an unenforced rule has nothing to go stale
    expect(byId.get('unenforced')!.enforcedBy!.status).toBeUndefined()
  })
})

describe('graph rule wire normalization', () =>
{
  it('accepts legacy strings and canonical arrays as allowVia arrays', () =>
  {
    const base = {
      version: 4,
      repoRoot: '/repo',
      mode: 'imports',
      generatedAt: '2026-08-07T00:00:00.000Z',
      scope: 'src',
      nodes: [],
      edges: [],
      groups: [],
      metrics: { cycles: 0, orphans: 0, maxFanIn: 0, maxFanOut: 0 },
    }
    for (const allowVia of ['src/public/**', ['src/public/**', 'src/internal/**']])
    {
      const graph = normalizeGraphJson({
        ...base,
        rules: [
          {
            id: 'public-entrypoints',
            from: 'src/**',
            to: 'src/core/**',
            verdict: 'allow-only',
            allowVia,
            severity: 'error',
          },
        ],
      } as unknown as Parameters<typeof normalizeGraphJson>[0])
      expect(graph.rules?.[0]?.allowVia).toEqual(
        typeof allowVia === 'string' ? [allowVia] : allowVia,
      )
    }
  })
})

describe('F06-F08 co-change history semantics', () =>
{
  it('counts singleton commits in the strength denominator (F06)', () =>
  {
    const dir = gitRepo()
    for (let i = 0; i < 3; i += 1)
    {
      commit(dir, { 'src/a.ts': `v${i}`, 'src/b.ts': `v${i}` }, `ab${i}`)
    }
    commit(dir, { 'src/a.ts': 'x' }, 'a-only')
    commit(dir, { 'src/b.ts': 'y' }, 'b-only')
    const pairs = computeCoChanges(dir, ['src/a.ts', 'src/b.ts'], 'src')
    expect(pairs).toEqual([{ a: 'src/a.ts', b: 'src/b.ts', count: 3, strength: 0.75 }])
  })

  it('scopes history before the commit limit (F07)', () =>
  {
    const dir = gitRepo()
    for (let i = 0; i < 3; i += 1)
    {
      commit(dir, { 'src/a.ts': `v${i}`, 'src/b.ts': `v${i}` }, `ab${i}`)
    }
    for (let i = 0; i < 3; i += 1)
    {
      commit(dir, { 'docs/x.md': `d${i}` }, `doc${i}`)
    }
    // limit 3 would be entirely consumed by docs commits without pathspec
    const pairs = computeCoChanges(dir, ['src/a.ts', 'src/b.ts'], 'src', 3)
    expect(pairs).toHaveLength(1)
    expect(pairs[0]!.count).toBe(3)
  })

  it('parses paths with embedded newlines (F08)', () =>
  {
    const dir = gitRepo()
    const weird = 'src/li\nne.ts'
    for (let i = 0; i < 3; i += 1)
    {
      commit(dir, { [weird]: `v${i}`, 'src/b.ts': `v${i}` }, `c${i}`)
    }
    const pairs = computeCoChanges(dir, [weird, 'src/b.ts'], 'src')
    expect(pairs).toHaveLength(1)
    expect(new Set([pairs[0]!.a, pairs[0]!.b])).toEqual(new Set([weird, 'src/b.ts']))
  })
})

describe('F19 strict integer flags', () =>
{
  it('rejects malformed suffixes instead of partial parsing', () =>
  {
    for (const bad of ['1junk', '1.5', '1e3', '0', '-1', ''])
    {
      expect(() => parsePositiveInt(bad, '--x')).toThrow()
    }
    expect(parsePositiveInt('42', '--x')).toBe(42)
  })

  it('applies domain bounds', () =>
  {
    expect(() => parsePositiveInt('70000', '--limit', 65535)).toThrow(/range/)
    expect(parsePositiveInt('4977', '--limit', 65535)).toBe(4977)
  })
})

describe('F05/F09/F20 buildGraph exclusions and import modality', () =>
{
  it('preserves named, namespace, type-only & side-effect evidence in the graph', async () =>
  {
    const dir = tempDir()
    NodeFS.mkdirSync(NodePath.join(dir, 'src'), { recursive: true })
    NodeFS.mkdirSync(NodePath.join(dir, 'src', 'dist'), { recursive: true })
    NodeFS.writeFileSync(
      NodePath.join(dir, 'src', 'types.ts'),
      'export interface T { n: number }\nexport const val = 1\nconst star = 2\nexport { star as "*" }\n',
    )
    // dist-NAMED file must survive; dist/ segment must not
    NodeFS.writeFileSync(
      NodePath.join(dir, 'src', 'distribution.ts'),
      "import type { T } from './types.js'\nexport const d: T = { n: 1 }\n",
    )
    NodeFS.writeFileSync(
      NodePath.join(dir, 'src', 'dist', 'excluded.ts'),
      'export const gone = 1\n',
    )
    NodeFS.writeFileSync(
      NodePath.join(dir, 'src', 'mixed.ts'),
      "import { type T, val } from './types.js'\nexport const m: T = { n: val }\n",
    )
    NodeFS.writeFileSync(
      NodePath.join(dir, 'src', 'namespace.ts'),
      "import * as types from './types.js'\nexport const n = types.val\n",
    )
    NodeFS.writeFileSync(
      NodePath.join(dir, 'src', 'side-effect.ts'),
      "import './types.js'\nexport const loaded = true\n",
    )
    NodeFS.writeFileSync(
      NodePath.join(dir, 'src', 'named-star.ts'),
      'import { "*" as star } from \'./types.js\'\nexport const namedStar = star\n',
    )
    NodeFS.writeFileSync(
      NodePath.join(dir, 'src', 'type-empty.ts'),
      "import type {} from './types.js'\nexport const erased = true\n",
    )
    NodeFS.writeFileSync(
      NodePath.join(dir, 'src', 'empty-merge.ts'),
      "import type {} from './types.js'\nimport {} from './types.js'\nexport const merged = true\n",
    )
    NodeFS.writeFileSync(
      NodePath.join(dir, 'src', 'dynamic-mixed.ts'),
      "import type { T } from './types.js'\nexport const shape: T = { n: 0 }\nexport const load = () => import('./types.js')\n",
    )

    const graph = await buildGraph({ root: dir, scope: 'src' })
    const ids = graph.nodes.map((n) => n.id).sort()
    expect(ids).toContain('src/distribution.ts')
    expect(ids).toContain('src/types.ts')
    expect(ids).not.toContain('src/dist/excluded.ts')

    const typeEdge = graph.edges.find(
      (e) => e.from === 'src/distribution.ts' && e.to === 'src/types.ts',
    )
    expect(typeEdge?.typeOnly).toBe(true)

    const mixedEdge = graph.edges.find((e) => e.from === 'src/mixed.ts' && e.to === 'src/types.ts')
    expect(mixedEdge?.typeOnly).toBeUndefined()
    expect(mixedEdge?.typeSymbols).toEqual(['T'])
    expect(mixedEdge?.symbols).toEqual(['T', 'val'])

    const namespaceEdge = graph.edges.find(
      (e) => e.from === 'src/namespace.ts' && e.to === 'src/types.ts',
    )
    expect(namespaceEdge?.symbols).toBeUndefined()
    const sideEffectEdge = graph.edges.find(
      (e) => e.from === 'src/side-effect.ts' && e.to === 'src/types.ts',
    )
    expect(sideEffectEdge?.symbols).toEqual([])
    const namedStarEdge = graph.edges.find(
      (e) => e.from === 'src/named-star.ts' && e.to === 'src/types.ts',
    )
    expect(namedStarEdge?.symbols).toEqual(['*'])
    const typeEmptyEdge = graph.edges.find(
      (e) => e.from === 'src/type-empty.ts' && e.to === 'src/types.ts',
    )
    expect(typeEmptyEdge?.symbols).toEqual([])
    expect(typeEmptyEdge?.typeOnly).toBe(true)
    const emptyMergeEdge = graph.edges.find(
      (e) => e.from === 'src/empty-merge.ts' && e.to === 'src/types.ts',
    )
    expect(emptyMergeEdge?.symbols).toEqual([])
    expect(emptyMergeEdge?.typeOnly).toBeUndefined()
    const dynamicMixedEdge = graph.edges.find(
      (e) => e.from === 'src/dynamic-mixed.ts' && e.to === 'src/types.ts',
    )
    expect(dynamicMixedEdge?.symbols).toBeUndefined()
    expect(dynamicMixedEdge?.typeSymbols).toBeUndefined()
    expect(dynamicMixedEdge?.typeOnly).toBeUndefined()
  })
})

describe('F22 star re-export origin resolution', () =>
{
  it('keeps one binding through diamonds and removes competing origins', async () =>
  {
    const dir = tempDir()
    const files: Record<string, string> = {
      'src/star/origin.ts':
        'export default function originDefault() {}\nexport const shared = 1\nexport const runtimeValue = 2\nexport interface Shape { n: number }\nexport const aliased = 3\n',
      'src/star/origin-two.ts': 'export const other = 1\n',
      'src/star/left.ts': "export * from './origin.js'\n",
      'src/star/right.ts': "export * from './origin.js'\n",
      'src/star/diamond.ts': "export * from './left.js'\nexport * from './right.js'\n",
      'src/star/type-route.ts': "export type * from './origin.js'\n",
      'src/star/modality.ts': "export * from './left.js'\nexport * from './type-route.js'\n",
      'src/star/same-specifier-type-first.ts':
        "export type * from './origin.js'\nexport * from './origin.js'\n",
      'src/star/same-specifier-runtime-first.ts':
        "export * from './origin.js'\nexport type * from './origin.js'\n",
      'src/star/alias-left.ts': "export { aliased as branchName } from './origin.js'\n",
      'src/star/alias-right.ts': "export { aliased as branchName } from './origin.js'\n",
      'src/star/chain-left.ts': "export { branchName as finalAlias } from './alias-left.js'\n",
      'src/star/chain-right.ts': "export { branchName as finalAlias } from './alias-right.js'\n",
      'src/star/alias-diamond.ts':
        "export * from './chain-left.js'\nexport * from './chain-right.js'\n",
      'src/star/local-base.ts':
        'const local = 1\nexport { local as a, local as b }\ninterface HiddenShape { n: number }\nexport { HiddenShape }\nconst RuntimeFirst = 1\nexport { RuntimeFirst }\nexport interface RuntimeFirst {}\nexport interface TypeFirst {}\nconst TypeFirst = 1\nexport { TypeFirst }\n',
      'src/star/local-left.ts': "export { a as localShared } from './local-base.js'\n",
      'src/star/local-right.ts': "export { b as localShared } from './local-base.js'\n",
      'src/star/local-diamond.ts':
        "export * from './local-left.js'\nexport * from './local-right.js'\n",
      'src/star/import-left.ts':
        "import leftDefault, * as leftNs from './origin.js'\nimport { runtimeValue as leftValue } from './origin.js'\nexport { leftDefault as importedDefault, leftNs as importedNamespace, leftValue as importedShared }\n",
      'src/star/import-right.ts':
        "import rightDefault, * as rightNs from './origin.js'\nimport { runtimeValue as rightValue } from './origin.js'\nexport { rightDefault as importedDefault, rightNs as importedNamespace, rightValue as importedShared }\n",
      'src/star/import-diamond.ts':
        "export * from './import-left.js'\nexport * from './import-right.js'\n",
      'src/star/default-alias.ts': "export { default as defaultAlias } from './origin.js'\n",
      'src/star/default-alias-barrel.ts': "export * from './default-alias.js'\n",
      'src/star/namespace-left.ts': "export * as ns from './origin.js'\n",
      'src/star/namespace-right.ts': "export * as ns from './origin.js'\n",
      'src/star/namespace-type.ts': "export type * as ns from './origin.js'\n",
      'src/star/namespace-other.ts': "export * as ns from './origin-two.js'\n",
      'src/star/namespace-diamond.ts':
        "export * from './namespace-left.js'\nexport * from './namespace-right.js'\n",
      'src/star/namespace-modality.ts':
        "export * from './namespace-type.js'\nexport * from './namespace-left.js'\n",
      'src/star/namespace-competing.ts':
        "export * from './namespace-left.js'\nexport * from './namespace-other.js'\n",
      'src/star/a.ts':
        "export const conflict = 'a'\nexport const explicitChoice = 'a'\nexport const localChoice = 'a'\n",
      'src/star/b.ts':
        "export const conflict = 'b'\nexport const explicitChoice = 'b'\nexport const localChoice = 'b'\n",
      'src/star/ambiguous.ts': "export * from './a.js'\nexport * from './b.js'\n",
      'src/star/ambiguous-forward.ts': "export * from './ambiguous.js'\nexport * from './a.js'\n",
      'src/star/override.ts':
        "export * from './a.js'\nexport * from './b.js'\nexport { explicitChoice } from './a.js'\nexport const localChoice = 'local'\n",
      'src/star/unresolved-a/index.ts': "export { missingValue } from './missing.js'\n",
      'src/star/unresolved-b/index.ts': "export { missingValue } from './missing.js'\n",
      'src/star/unresolved-barrel.ts':
        "export * from './unresolved-a/index.js'\nexport * from './unresolved-b/index.js'\n",
      'src/star/external-left.ts':
        "export { externalValue as externalShared } from '../../dist/shared.js'\n",
      'src/star/external-right.ts':
        "export { externalValue as externalShared } from '../../dist/shared.js'\n",
      'src/star/external-diamond.ts':
        "export * from './external-left.js'\nexport * from './external-right.js'\n",
      'src/star/seed-cycle-a.ts': "export const cycleSeed = 1\nexport * from './seed-cycle-b.js'\n",
      'src/star/seed-cycle-b.ts': "export * from './seed-cycle-a.js'\n",
      'src/star/empty-cycle-a.ts': "export { cycleB as cycleA } from './empty-cycle-b.js'\n",
      'src/star/empty-cycle-b.ts': "export { cycleA as cycleB } from './empty-cycle-a.js'\n",
      'src/star/unresolved-star-collision.ts': "export * from 'src/star/origin.ts'\n",
      'dist/shared.js': 'export const externalValue = 1\n',
    }
    for (const [path, content] of Object.entries(files))
    {
      const full = NodePath.join(dir, path)
      NodeFS.mkdirSync(NodePath.join(full, '..'), { recursive: true })
      NodeFS.writeFileSync(full, content)
    }

    const graph = await buildGraph({ root: dir, scope: 'src' })
    const exportsOf = (id: string) =>
    {
      const node = graph.nodes.find((entry) => entry.id === id)
      expect(node, `graph node ${id}`).toBeDefined()
      return new Map((node?.exports ?? []).map((entry) => [entry.name, entry]))
    }

    const diamond = exportsOf('src/star/diamond.ts')
    expect(diamond.get('shared')).toMatchObject({
      name: 'shared',
      reExport: true,
    })

    const modality = exportsOf('src/star/modality.ts')
    expect(modality.get('runtimeValue')?.typeOnly).toBeUndefined()
    expect(modality.get('Shape')?.typeOnly).toBe(true)
    for (const id of [
      'src/star/same-specifier-type-first.ts',
      'src/star/same-specifier-runtime-first.ts',
    ])
    {
      const exports = exportsOf(id)
      expect(exports.get('runtimeValue')?.typeOnly).toBeUndefined()
      expect(exports.get('Shape')?.typeOnly).toBe(true)
    }

    const aliasDiamond = exportsOf('src/star/alias-diamond.ts')
    expect(aliasDiamond.get('finalAlias')).toMatchObject({
      name: 'finalAlias',
      reExport: true,
    })

    expect(exportsOf('src/star/local-diamond.ts').get('localShared')).toEqual({
      name: 'localShared',
      reExport: true,
    })
    expect(exportsOf('src/star/local-base.ts').get('HiddenShape')).toMatchObject({
      name: 'HiddenShape',
      typeOnly: true,
    })
    for (const name of ['RuntimeFirst', 'TypeFirst'])
    {
      expect(exportsOf('src/star/local-base.ts').get(name)).toEqual({ name })
    }
    const imported = exportsOf('src/star/import-diamond.ts')
    for (const name of ['importedDefault', 'importedNamespace', 'importedShared'])
    {
      expect(imported.get(name)).toEqual({ name, reExport: true })
    }
    expect(exportsOf('src/star/left.ts').has('default')).toBe(false)
    expect(exportsOf('src/star/default-alias-barrel.ts').get('defaultAlias')).toEqual({
      name: 'defaultAlias',
      reExport: true,
    })

    expect(exportsOf('src/star/namespace-diamond.ts').get('ns')).toMatchObject({
      name: 'ns',
      reExport: true,
    })
    expect(exportsOf('src/star/namespace-modality.ts').get('ns')?.typeOnly).toBeUndefined()
    expect(exportsOf('src/star/namespace-type.ts').get('ns')?.typeOnly).toBe(true)
    expect(exportsOf('src/star/namespace-competing.ts').has('ns')).toBe(false)

    const ambiguous = exportsOf('src/star/ambiguous.ts')
    expect(ambiguous.has('conflict')).toBe(false)
    expect(ambiguous.has('explicitChoice')).toBe(false)
    expect(ambiguous.has('localChoice')).toBe(false)
    expect(exportsOf('src/star/ambiguous-forward.ts').has('conflict')).toBe(false)

    const override = exportsOf('src/star/override.ts')
    expect(override.has('conflict')).toBe(false)
    expect(override.get('explicitChoice')).toMatchObject({
      name: 'explicitChoice',
      reExport: true,
    })
    expect(override.get('localChoice')).toMatchObject({
      name: 'localChoice',
    })
    expect(override.get('localChoice')?.reExport).toBeUndefined()

    expect(exportsOf('src/star/unresolved-a/index.ts').has('missingValue')).toBe(true)
    expect(exportsOf('src/star/unresolved-b/index.ts').has('missingValue')).toBe(true)
    expect(exportsOf('src/star/unresolved-barrel.ts').has('missingValue')).toBe(false)
    expect(exportsOf('src/star/seed-cycle-a.ts').has('cycleSeed')).toBe(true)
    expect(exportsOf('src/star/seed-cycle-b.ts').get('cycleSeed')).toEqual({
      name: 'cycleSeed',
      reExport: true,
    })
    expect(exportsOf('src/star/empty-cycle-a.ts').has('cycleA')).toBe(false)
    expect(exportsOf('src/star/empty-cycle-b.ts').has('cycleB')).toBe(false)

    const externalTable = buildSymbolTable(dir, [
      {
        source: 'src/star/external-left.ts',
        dependencies: [
          {
            module: '../../dist/shared.js',
            resolved: 'dist/shared.js',
            couldNotResolve: false,
          },
        ],
      },
      {
        source: 'src/star/external-right.ts',
        dependencies: [
          {
            module: '../../dist/shared.js',
            resolved: 'dist/shared.js',
            couldNotResolve: false,
          },
        ],
      },
      {
        source: 'src/star/external-diamond.ts',
        dependencies: [
          {
            module: './external-left.js',
            resolved: 'src/star/external-left.ts',
            couldNotResolve: false,
          },
          {
            module: './external-right.js',
            resolved: 'src/star/external-right.ts',
            couldNotResolve: false,
          },
        ],
      },
    ])
    const externalExports = new Map(
      exportList(externalTable.get('src/star/external-diamond.ts')!).map((symbol) => [
        symbol.name,
        symbol,
      ]),
    )
    expect(externalExports.get('externalShared')).toEqual({
      name: 'externalShared',
      reExport: true,
    })

    const unresolvedStarTable = buildSymbolTable(dir, [
      { source: 'src/star/origin.ts', dependencies: [] },
      {
        source: 'src/star/unresolved-star-collision.ts',
        dependencies: [
          {
            module: 'src/star/origin.ts',
            resolved: 'src/star/origin.ts',
            couldNotResolve: true,
          },
        ],
      },
    ])
    expect(exportList(unresolvedStarTable.get('src/star/unresolved-star-collision.ts')!)).toEqual(
      [],
    )

    const orderedModules = [
      { source: 'src/star/origin.ts', dependencies: [] },
      {
        source: 'src/star/left.ts',
        dependencies: [
          {
            module: './origin.js',
            resolved: 'src/star/origin.ts',
            couldNotResolve: false,
          },
        ],
      },
      {
        source: 'src/star/right.ts',
        dependencies: [
          {
            module: './origin.js',
            resolved: 'src/star/origin.ts',
            couldNotResolve: false,
          },
        ],
      },
      {
        source: 'src/star/diamond.ts',
        dependencies: [
          {
            module: './left.js',
            resolved: 'src/star/left.ts',
            couldNotResolve: false,
          },
          {
            module: './right.js',
            resolved: 'src/star/right.ts',
            couldNotResolve: false,
          },
        ],
      },
    ]
    const exportSnapshot = (modules: typeof orderedModules) =>
      Object.fromEntries(
        [...buildSymbolTable(dir, modules)]
          .map(([source, symbols]) => [source, exportList(symbols)] as const)
          .sort(([left], [right]) => left.localeCompare(right)),
      )
    expect(exportSnapshot(orderedModules)).toEqual(exportSnapshot(orderedModules.toReversed()))
  })
})
