// tests/packages/cartographer-core/configRules.test.ts
// allow-via normalization, evaluation & config-pattern staleness

import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import { afterAll, describe, expect, it } from 'vite-plus/test'
import { loadConfig } from '../../../packages/cartographer-core/src/analyze/config.ts'
import { buildGraph } from '../../../packages/cartographer-core/src/analyze/graph.ts'
import { compileRuleEvaluator } from '../../../packages/cartographer-core/src/analyze/ruleEval.ts'
import {
  GRAPH_SCHEMA_VERSION,
  type CartographerGraph,
} from '../../../packages/cartographer-core/src/contracts/types.ts'
import { normalizeGraphJson } from '../../../packages/cartographer-core/src/store/graphJson.ts'

const roots: string[] = []

function tempRoot(): string
{
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'carto-config-rules-'))
  roots.push(root)
  return root
}

function write(root: string, path: string, source: string): void
{
  const target = NodePath.join(root, path)
  NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true })
  NodeFS.writeFileSync(target, source)
}

function graphWithRule(allowVia: unknown): CartographerGraph
{
  return {
    version: GRAPH_SCHEMA_VERSION,
    repoRoot: '/repo',
    mode: 'imports',
    generatedAt: '2026-08-07T00:00:00.000Z',
    scope: 'src',
    nodes: [],
    edges: [],
    groups: [],
    rules: [
      {
        id: 'public-entrypoints',
        from: 'src/**',
        to: 'src/core/**',
        verdict: 'allow-only',
        allowVia,
        severity: 'error',
      },
    ] as unknown as NonNullable<CartographerGraph['rules']>,
    metrics: { cycles: 0, orphans: 0, maxFanIn: 0, maxFanOut: 0 },
  }
}

afterAll(() =>
{
  for (const root of roots)
  {
    NodeFS.rmSync(root, { recursive: true, force: true })
  }
})

describe('allowVia arrays', () =>
{
  it('normalizes authored strings and arrays to the canonical array', () =>
  {
    for (const [authored, expected] of [
      ['src/public/**', ['src/public/**']],
      [
        ['src/public/**', 'src/internal/**'],
        ['src/public/**', 'src/internal/**'],
      ],
    ] as const)
    {
      const root = tempRoot()
      write(
        root,
        '.cartographer.json',
        JSON.stringify({
          rules: [
            {
              id: 'public-entrypoints',
              from: 'src/**',
              to: 'src/core/**',
              verdict: 'allow-only',
              allowVia: authored,
            },
          ],
        }),
      )
      expect(loadConfig(root).rules?.[0]?.allowVia).toEqual(expected)
      expect(normalizeGraphJson(graphWithRule(authored)).rules?.[0]?.allowVia).toEqual(expected)
    }
  })

  it('exempts a source when any allowed pattern matches', () =>
  {
    const violations = compileRuleEvaluator([
      {
        id: 'public-entrypoints',
        from: 'src/**',
        to: 'src/core/**',
        verdict: 'allow-only',
        allowVia: ['src/public/**', 'src/internal/**'],
        severity: 'error',
      },
    ])

    expect(violations('src/public/client.ts', 'src/core/service.ts')).toBeUndefined()
    expect(violations('src/internal/client.ts', 'src/core/service.ts')).toBeUndefined()
    expect(violations('src/feature/client.ts', 'src/core/service.ts')).toEqual([
      'public-entrypoints',
    ])
  })

  it('preserves one exclusion and emits alternatives for multiple patterns', async () =>
  {
    for (const allowVia of ['src/public/**', ['src/public/**', 'src/internal/**']] as const)
    {
      const root = tempRoot()
      write(root, 'src/core/service.ts', 'export const service = 1\n')
      write(
        root,
        'src/public/client.ts',
        "import { service } from '../core/service.js'\nvoid service\n",
      )
      write(
        root,
        'src/internal/client.ts',
        "import { service } from '../core/service.js'\nvoid service\n",
      )
      write(
        root,
        'src/feature/client.ts',
        "import { service } from '../core/service.js'\nvoid service\n",
      )
      write(
        root,
        '.cartographer.json',
        JSON.stringify({
          rules: [
            {
              id: 'public-entrypoints',
              from: 'src/**',
              to: 'src/core/**',
              verdict: 'allow-only',
              allowVia,
            },
          ],
        }),
      )

      const graph = await buildGraph({ root, scope: 'src' })
      const violations = new Map(graph.edges.map((edge) => [edge.from, edge.violations]))
      expect(violations.get('src/public/client.ts')).toBeUndefined()
      expect(violations.get('src/internal/client.ts')).toEqual(
        typeof allowVia === 'string' ? ['public-entrypoints'] : undefined,
      )
      expect(violations.get('src/feature/client.ts')).toEqual(['public-entrypoints'])
    }
  })
})

describe('config pattern staleness', () =>
{
  it('adds warning markers for zero-match group, system and rule patterns', async () =>
  {
    const root = tempRoot()
    write(root, 'src/live.ts', 'export const live = true\n')
    write(
      root,
      '.cartographer.json',
      JSON.stringify({
        groups: [{ match: 'src/missing-group/**', name: 'Missing group' }],
        systems: [{ match: 'src/missing-system/**', name: 'Missing system' }],
        rules: [
          {
            id: 'missing-rule-side',
            from: 'src/missing-from/**',
            to: 'src/missing-to/**',
            verdict: 'allow-only',
            allowVia: ['src/missing-via/**'],
          },
        ],
      }),
    )

    const graph = await buildGraph({ root, scope: 'src' })
    expect(graph.markers).toEqual([
      {
        kind: 'warning',
        text: 'group "Missing group" match pattern "src/missing-group/**" matches no files',
      },
      {
        kind: 'warning',
        text: 'system "Missing system" match pattern "src/missing-system/**" matches no files',
      },
      {
        kind: 'warning',
        text: 'rule "missing-rule-side" from pattern "src/missing-from/**" matches no files',
      },
      {
        kind: 'warning',
        text: 'rule "missing-rule-side" to pattern "src/missing-to/**" matches no files',
      },
      {
        kind: 'warning',
        text: 'rule "missing-rule-side" allowVia pattern "src/missing-via/**" matches no files',
      },
    ])
  })
})
