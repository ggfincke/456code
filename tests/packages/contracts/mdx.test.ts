// tests/packages/contracts/mdx.test.ts
// verifies the versioned closed safe mdx transport schema

import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vite-plus/test'

import {
  MdxSafeDocument,
  ProjectReadMdxDocumentResult,
} from '../../../packages/contracts/src/mdx.ts'

const representativeDocument = {
  version: 1,
  frontmatter: {
    title: 'Safe document',
    metadata: { reviewed: true, sequence: [1, 2, 3] },
  },
  root: {
    type: 'root',
    children: [
      {
        type: 'element',
        tag: 'a',
        props: { href: 'docs/guide.md', title: 'Guide' },
        children: [{ type: 'text', value: 'Read the guide' }],
      },
      {
        type: 'component',
        name: 'Callout',
        props: { type: 'warning', title: 'Careful' },
        children: [{ type: 'text', value: 'Review this first.' }],
      },
      {
        type: 'component',
        name: 'FileReference',
        props: { path: 'src/index.ts', line: 12, label: 'entry point' },
        children: [],
      },
      {
        type: 'component',
        name: 'SymbolReference',
        props: {
          id: 'symbol:entry',
          label: 'entry',
          path: 'src/index.ts',
          line: 12,
        },
        children: [],
      },
      {
        type: 'component',
        name: 'DiffReference',
        props: { id: 'diff:proposal-1', label: 'proposal' },
        children: [],
      },
      {
        type: 'component',
        name: 'ArchitectureImpact',
        props: { id: 'impact:proposal-1', title: 'Impact' },
        children: [{ type: 'text', value: 'Three modules affected.' }],
      },
    ],
  },
  diagnostics: [
    {
      code: 'MDXF001',
      ruleId: 'safe-document/unknown-component',
      severity: 'error',
      message: 'unknown component FutureComponent',
      source: 'mdx-forge',
      data: { componentName: 'FutureComponent' },
    },
  ],
} as const

describe('safe MDX transport', () =>
{
  it('decodes the complete closed v1 node and component catalog', () =>
  {
    const decode = Schema.decodeUnknownSync(ProjectReadMdxDocumentResult, {
      errors: 'all',
      onExcessProperty: 'error',
    })

    const result = decode({
      transportVersion: 1,
      relativePath: 'docs/guide.mdx',
      byteLength: 42,
      source: '# Guide\n',
      document: representativeDocument,
    })

    expect(result.transportVersion).toBe(1)
    expect(result.document.root.children).toHaveLength(6)
    expect(result.document.diagnostics[0]?.source).toBe('mdx-forge')
  })

  it('rejects unsupported versions, node kinds, and arbitrary component props', () =>
  {
    const decode = Schema.decodeUnknownSync(MdxSafeDocument, {
      errors: 'all',
      onExcessProperty: 'error',
    })

    expect(() => decode({ ...representativeDocument, version: 2 })).toThrow()
    expect(() =>
      decode({
        ...representativeDocument,
        frontmatter: { invalidNumber: Number.POSITIVE_INFINITY },
      }),
    ).toThrow()
    expect(() =>
      decode({
        ...representativeDocument,
        root: {
          type: 'root',
          children: [{ type: 'script', value: 'alert(1)' }],
        },
      }),
    ).toThrow()
    expect(() =>
      decode({
        ...representativeDocument,
        root: {
          type: 'root',
          children: [
            {
              type: 'unknownComponent',
              name: 'FutureComponent',
              children: [],
            },
          ],
        },
      }),
    ).toThrow()
    expect(() =>
      decode({
        ...representativeDocument,
        root: {
          type: 'root',
          children: [
            {
              type: 'component',
              name: 'FileReference',
              props: {
                path: 'src/index.ts',
                payload: { authorization: 'Bearer secret' },
              },
              children: [],
            },
          ],
        },
      }),
    ).toThrow()
    expect(() =>
      decode({
        ...representativeDocument,
        root: {
          type: 'root',
          children: [
            {
              type: 'component',
              name: 'FileReference',
              props: { path: 'src/index.ts' },
              children: [{ type: 'text', value: 'forbidden child' }],
            },
          ],
        },
      }),
    ).toThrow()
  })
})
