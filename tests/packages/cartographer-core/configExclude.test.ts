// tests/packages/cartographer-core/configExclude.test.ts
// verifies bounded literal-segment exclusions in Cartographer config

import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'

import { afterEach, describe, expect, it } from 'vite-plus/test'

import { loadConfig } from '../../../packages/cartographer-core/src/analyze/config.ts'
import { buildGraph } from '../../../packages/cartographer-core/src/analyze/graph.ts'

const roots = new Set<string>()

function temporaryRoot(): string
{
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'carto-config-exclude-'))
  roots.add(root)
  return root
}

function write(root: string, relativePath: string, value: string): void
{
  const path = NodePath.join(root, relativePath)
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true })
  NodeFS.writeFileSync(path, value)
}

afterEach(() =>
{
  for (const root of roots) NodeFS.rmSync(root, { recursive: true, force: true })
  roots.clear()
})

describe('Cartographer config exclude', () =>
{
  it('defaults absent config and validates, escapes, and applies bounded path segments', async () =>
  {
    const absent = temporaryRoot()
    expect(loadConfig(absent).exclude).toEqual([])

    const invalid = temporaryRoot()
    for (const exclude of [['/'], ['..'], Array.from({ length: 33 }, (_, i) => `x${i}`)])
    {
      write(invalid, '.cartographer.json', JSON.stringify({ exclude }))
      expect(() => loadConfig(invalid)).toThrow(/"exclude"/u)
    }

    const escaped = temporaryRoot()
    write(escaped, '.cartographer.json', JSON.stringify({ exclude: ['generated[1]'] }))
    write(escaped, 'src/live.ts', 'export const live = true\n')
    write(escaped, 'src/generated[1]/ignored.ts', 'export const ignored = true\n')
    const graph = await buildGraph({ root: escaped, scope: 'src' })
    expect(graph.nodes.map((node) => node.id)).toContain('src/live.ts')
    expect(graph.nodes.map((node) => node.id)).not.toContain('src/generated[1]/ignored.ts')
  })
})
