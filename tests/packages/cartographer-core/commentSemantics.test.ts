// tests/packages/cartographer-core/commentSemantics.test.ts
// comment provenance, declaration ownership & structured markers

import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'
import {
  applyAnnotations,
  contentHash,
  loadAnnotations,
  saveAnnotations,
  type AnnotationEntry,
} from '../../../packages/cartographer-core/src/analyze/annotations.ts'
import { buildGraph } from '../../../packages/cartographer-core/src/analyze/graph.ts'
import type {
  CartographerGraph,
  ExportSymbol,
  GraphNode,
} from '../../../packages/cartographer-core/src/contracts/types.ts'
import { trackedTempRoot } from './helpers/trackedTempRoot.ts'

const tempRoots = trackedTempRoot('carto-csem-')
const tempDir = tempRoots.create

function writeSrc(dir: string, files: Record<string, string>): void
{
  for (const [path, content] of Object.entries(files))
  {
    const full = NodePath.join(dir, 'src', path)
    NodeFS.mkdirSync(NodePath.join(full, '..'), { recursive: true })
    NodeFS.writeFileSync(full, content)
  }
}

function nodeOf(graph: CartographerGraph, id: string): GraphNode
{
  const node = graph.nodes.find((n) => n.id === id)
  expect(node, `node ${id}`).toBeDefined()
  return node!
}

function exportOf(node: GraphNode, name: string): ExportSymbol
{
  const symbol = node.exports?.find((e) => e.name === name)
  expect(symbol, `export ${name} on ${node.id}`).toBeDefined()
  return symbol!
}

afterAll(tempRoots.cleanup)

const SIDECAR_CONTENT = 'export const c = 1\n'

const CLASSY = `// src/classy.ts
// session resolution owner

/**
 * Owns session resolution for authenticated requests.
 *
 * Verified identity is the only accepted session input.
 * @deprecated use SessionResolver2
 */
// cached identity is authoritative until rotation succeeds
export class SessionResolver {
  loadSession(): number {
    // ! accepting an unsigned identity would cross the trust boundary
    return 1
  }
}
`

const MARKERS = `// src/markers.ts
// ? is this header purpose a marker (it must not be)

// * the checkpoint owns run identity
// legacy clients still send the v1 claim name
// TODO(auth): remove fallback after v1 retires
export const subject = 'sub'

// ! unsigned identities cross the trust boundary

// ? should this move to config
// TODO plain follow-up
const internal = 2
export const use = internal
`

const BINDINGS = `// src/bindings.ts
// exported binding detail ownership

/**
 * Documents both declarators as one statement.
 */
// shared declaration note
// * multi declaration evidence
export const first = 1, second = 2

/**
 * Documents one destructuring statement.
 */
// destructured declaration note
// ? destructuring evidence owner
export const { alpha, nested: { beta }, list: [gamma] } = {
  alpha: 1,
  nested: { beta: 2 },
  list: [3],
}
`

const FALLBACKS = `// src/fallbacks.ts
// rejected evidence returns to file ownership

const source = {}
// TODO empty binding fallback
export const {} = source

export function overloaded(value: string): string
// TODO rejected overload fallback
export function overloaded(value: number): number
export function overloaded(value: string | number): string | number {
  return value
}

// TODO superseded interface fallback
export interface Upgrade {}
// * runtime replacement evidence
export class Upgrade {}
`

describe('comment semantics extraction', () =>
{
  let graph: CartographerGraph

  beforeAll(async () =>
  {
    const dir = tempDir()
    writeSrc(dir, {
      'header.ts': '// src/header.ts\n// resolve session state\n\nexport const a = 1\n',
      'moved.ts': '// src/oldname.ts\n// upload compiled artifacts\n\nexport const b = 1\n',
      'nested/canonical.ts':
        '// .\\src\\nested\\canonical.ts\n// canonical path header\n\nexport const canonical = 1\n',
      'nested/basename.ts':
        '// basename.ts\n// basename path header\n\nexport const basename = 1\n',
      'nested/suffix.ts':
        '// elsewhere/src/nested/suffix.ts\n// suffix path header\n\nexport const suffix = 1\n',
      'nested/absolute.ts':
        '// /src/nested/absolute.ts\n// absolute path header\n\nexport const absolute = 1\n',
      'nested/alias.ts':
        '// src/other/../nested/alias.ts\n// alias path header\n\nexport const alias = 1\n',
      'sidecar.ts': SIDECAR_CONTENT,
      'classy.ts': CLASSY,
      'markers.ts': MARKERS,
      'bindings.ts': BINDINGS,
      'bindings-barrel.ts':
        "// src/bindings-barrel.ts\n// re-export binding metadata\n\nexport * from './bindings.js'\n",
      'fallbacks.ts': FALLBACKS,
    })
    NodeFS.writeFileSync(
      NodePath.join(dir, '.cartographer.annotations.json'),
      JSON.stringify({
        files: {
          'src/sidecar.ts': {
            description: 'from the sidecar',
            hash: contentHash(SIDECAR_CONTENT),
          },
        },
      }),
    )
    graph = await buildGraph({ root: dir, scope: 'src' })
  })

  it('records description provenance', () =>
  {
    const header = nodeOf(graph, 'src/header.ts')
    expect(header.description).toBe('resolve session state')
    expect(header.descriptionSource).toBe('header')
    expect(header.headerPathStale).toBeUndefined()
    const sidecar = nodeOf(graph, 'src/sidecar.ts')
    expect(sidecar.description).toBe('from the sidecar')
    expect(sidecar.descriptionSource).toBe('annotation-sidecar')
    expect(sidecar.descriptionStale).toBeUndefined()
  })

  it('requires the full canonical repo-relative header path', () =>
  {
    const canonical = nodeOf(graph, 'src/nested/canonical.ts')
    expect(canonical.description).toBe('canonical path header')
    expect(canonical.headerPathStale).toBeUndefined()

    for (const [id, description] of [
      ['src/moved.ts', 'upload compiled artifacts'],
      ['src/nested/basename.ts', 'basename path header'],
      ['src/nested/suffix.ts', 'suffix path header'],
      ['src/nested/absolute.ts', 'absolute path header'],
      ['src/nested/alias.ts', 'alias path header'],
    ] as const)
    {
      const node = nodeOf(graph, id)
      expect(node.description).toBe(description)
      expect(node.headerPathStale).toBe(true)
    }
  })

  it('splits a class block doc, tags & attached note', () =>
  {
    const resolver = exportOf(nodeOf(graph, 'src/classy.ts'), 'SessionResolver')
    expect(resolver.documentation).toEqual({
      text: 'Owns session resolution for authenticated requests. Verified identity is the only accepted session input.',
      syntax: 'tsdoc',
      tags: [{ name: 'deprecated', value: 'use SessionResolver2' }],
    })
    expect(resolver.comments).toEqual([
      { text: 'cached identity is authoritative until rotation succeeds' },
    ])
  })

  it('keeps a method-interior marker at file level', () =>
  {
    const classy = nodeOf(graph, 'src/classy.ts')
    expect(classy.markers).toEqual([
      {
        kind: 'warning',
        text: 'accepting an unsigned identity would cross the trust boundary',
      },
    ])
  })

  it('parses markers w/ kind, scope & text at the right attachment', () =>
  {
    const node = nodeOf(graph, 'src/markers.ts')
    // header purpose line is never a marker, so only the three file-level
    // markers outside the exported declaration's attached run land here
    expect(node.markers).toEqual([
      { kind: 'warning', text: 'unsigned identities cross the trust boundary' },
      { kind: 'question', text: 'should this move to config' },
      { kind: 'todo', text: 'plain follow-up' },
    ])
    const subject = exportOf(node, 'subject')
    expect(subject.markers).toEqual([
      { kind: 'important', text: 'the checkpoint owns run identity' },
      { kind: 'todo', scope: 'auth', text: 'remove fallback after v1 retires' },
    ])
    expect(subject.comments).toEqual([{ text: 'legacy clients still send the v1 claim name' }])
  })

  it('assigns statement evidence once while retaining every binding detail', () =>
  {
    const node = nodeOf(graph, 'src/bindings.ts')
    const first = exportOf(node, 'first')
    const second = exportOf(node, 'second')
    expect(first.documentation?.text).toBe('Documents both declarators as one statement.')
    expect(first.comments).toEqual([{ text: 'shared declaration note' }])
    expect(first.markers).toEqual([{ kind: 'important', text: 'multi declaration evidence' }])
    expect(second.documentation).toBeUndefined()
    expect(second.comments).toBeUndefined()
    expect(second.markers).toBeUndefined()
    expect(second.kind).toBe('const')
    expect(second.signature).toBe('second = 2')
    expect(second.def).toBe('second = 2')

    const alpha = exportOf(node, 'alpha')
    const beta = exportOf(node, 'beta')
    const gamma = exportOf(node, 'gamma')
    expect(alpha.documentation?.text).toBe('Documents one destructuring statement.')
    expect(alpha.comments).toEqual([{ text: 'destructured declaration note' }])
    expect(alpha.markers).toEqual([{ kind: 'question', text: 'destructuring evidence owner' }])
    for (const sibling of [beta, gamma])
    {
      expect(sibling.documentation).toBeUndefined()
      expect(sibling.comments).toBeUndefined()
      expect(sibling.markers).toBeUndefined()
    }
    for (const binding of [alpha, beta, gamma])
    {
      expect(binding.kind).toBe('const')
      expect(binding.signature).toContain('{ alpha, nested: { beta }')
      expect(binding.def).toContain('{ alpha, nested: { beta }')
    }
    expect(node.exports?.flatMap((entry) => entry.markers ?? [])).toHaveLength(2)
    expect(node.markers).toBeUndefined()
  })

  it('keeps rejected markers at file level & strips re-export evidence', () =>
  {
    const fallback = nodeOf(graph, 'src/fallbacks.ts')
    expect(fallback.markers).toEqual([
      { kind: 'todo', text: 'empty binding fallback' },
      { kind: 'todo', text: 'rejected overload fallback' },
      { kind: 'todo', text: 'superseded interface fallback' },
    ])
    expect(exportOf(fallback, 'Upgrade').markers).toEqual([
      { kind: 'important', text: 'runtime replacement evidence' },
    ])

    expect(exportOf(nodeOf(graph, 'src/bindings-barrel.ts'), 'first')).toEqual({
      name: 'first',
      reExport: true,
    })
    const matchingMarkers = graph.nodes
      .flatMap((node) => [
        ...(node.markers ?? []),
        ...(node.exports?.flatMap((symbol) => symbol.markers ?? []) ?? []),
      ])
      .filter((marker) => marker.text === 'multi declaration evidence')
    expect(matchingMarkers).toHaveLength(1)
  })

  it('rejects malformed sidecar tables with exact entry paths', () =>
  {
    const dir = tempDir()
    const path = NodePath.join(dir, '.cartographer.annotations.json')
    const valid = { description: 'valid description', hash: '0123456789ab' }
    const cases: Array<[unknown, RegExp]> = [
      [null, /\.cartographer\.annotations\.json: \$ must be an object/],
      [{ files: null }, /: files must be an object when present/],
      [{ files: [] }, /: files must be an object when present/],
      [{ files: { 'src/a.ts': null } }, /files\["src\/a\.ts"\] must/],
      [
        { files: { 'src/a.ts': { ...valid, description: 1 } } },
        /files\["src\/a\.ts"\]\.description must be a string/,
      ],
      [
        { files: { 'src/a.ts': { ...valid, description: '  ' } } },
        /files\["src\/a\.ts"\]\.description must not be blank/,
      ],
      [
        { files: { 'src/a.ts': { ...valid, description: ' padded ' } } },
        /files\["src\/a\.ts"\]\.description must not have leading/,
      ],
      [
        { files: { 'src/a.ts': { ...valid, description: 'one\ntwo' } } },
        /files\["src\/a\.ts"\]\.description must be a single line/,
      ],
      [
        { files: { 'src/a.ts': { ...valid, description: 'x'.repeat(161) } } },
        /files\["src\/a\.ts"\]\.description must be at most 160/,
      ],
      [
        { files: { 'src/a.ts': { ...valid, hash: 'ABCDEF123456' } } },
        /files\["src\/a\.ts"\]\.hash must be exactly 12 lowercase/,
      ],
      [{ files: { 'src/../a.ts': valid } }, /files\["src\/\.\.\/a\.ts"\] must not contain/],
    ]
    for (const [sidecar, expected] of cases)
    {
      NodeFS.writeFileSync(path, JSON.stringify(sidecar))
      expect(() => loadAnnotations(dir)).toThrow(expected)
    }

    NodeFS.writeFileSync(path, JSON.stringify({ schema: 1 }))
    expect(loadAnnotations(dir)).toEqual(new Map())
  })

  it('reports invalid apply values & validates before saving', () =>
  {
    const dir = tempDir()
    NodeFS.mkdirSync(NodePath.join(dir, 'src'))
    NodeFS.writeFileSync(NodePath.join(dir, 'src', 'valid.ts'), 'export const valid = 1\n')
    NodeFS.writeFileSync(NodePath.join(dir, '__proto__'), 'export {}\n')
    const supplied = Object.assign(Object.create(null) as Record<string, unknown>, {
      'src/valid.ts': '  trimmed description  ',
      nonString: 7,
      blank: '   ',
      multiline: 'one\ntwo',
      overlong: 'x'.repeat(161),
    })
    Object.defineProperty(supplied, '__proto__', {
      value: 'prototype filename',
      enumerable: true,
    })

    const applied = applyAnnotations(dir, supplied)
    expect(applied.written).toBe(2)
    expect(applied.missing).toEqual([])
    expect(applied.invalid).toEqual(['nonString', 'blank', 'multiline', 'overlong'])
    const loaded = loadAnnotations(dir)
    expect(loaded.get('src/valid.ts')?.description).toBe('trimmed description')
    expect(loaded.get('__proto__')?.description).toBe('prototype filename')
    const serialized = JSON.parse(
      NodeFS.readFileSync(NodePath.join(dir, '.cartographer.annotations.json'), 'utf-8'),
    ) as { files: Record<string, unknown> }
    expect(Object.hasOwn(serialized.files, '__proto__')).toBe(true)

    const before = NodeFS.readFileSync(
      NodePath.join(dir, '.cartographer.annotations.json'),
      'utf-8',
    )
    const invalidEntry = Object.create({
      description: 'inherited description',
      hash: '0123456789ab',
    }) as AnnotationEntry
    const table = new Map(loaded)
    table.set('src/inherited.ts', invalidEntry)
    expect(() => saveAnnotations(dir, table)).toThrow(
      /files\["src\/inherited\.ts"\] must be an object/,
    )
    expect(NodeFS.readFileSync(NodePath.join(dir, '.cartographer.annotations.json'), 'utf-8')).toBe(
      before,
    )

    table.delete('src/inherited.ts')
    table.set('src/bad-hash.ts', {
      description: 'valid description',
      hash: 'ABCDEF123456',
    })
    expect(() => saveAnnotations(dir, table)).toThrow(
      /files\["src\/bad-hash\.ts"\]\.hash must be exactly 12 lowercase/,
    )
    expect(NodeFS.readFileSync(NodePath.join(dir, '.cartographer.annotations.json'), 'utf-8')).toBe(
      before,
    )
  })
})
