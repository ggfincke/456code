// tests/apps/web/components/files/SafeDocumentRenderer.test.tsx
// verifies exhaustive fail-closed native rendering of safe mdx documents

import {
  EnvironmentId,
  type MdxSafeDocument,
  type MdxSafeDocumentNode,
  ThreadId,
} from '@t3tools/contracts'
import { isValidElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vite-plus/test'

import {
  SafeDocumentRenderer,
  renderMdxSafeNode,
} from '../../../../../apps/web/src/components/files/SafeDocumentRenderer'

vi.mock('~/assets/assetUrls', () => ({
  useAssetUrlState: () => ({
    _tag: 'Success',
    url: 'https://assets.invalid/capability-token',
  }),
}))

const environmentId = EnvironmentId.make('environment-safe-mdx-renderer-test')
const threadId = ThreadId.make('thread-safe-mdx-renderer-test')

function text(value: string): MdxSafeDocumentNode
{
  return { type: 'text', value }
}

const exhaustiveDocument = {
  version: 1,
  frontmatter: { title: 'Safe document', nested: { enabled: true } },
  diagnostics: [
    {
      code: 'MDX_INFO',
      ruleId: 'test/info',
      severity: 'info',
      message: 'Informational diagnostic.',
      source: '456code',
    },
  ],
  root: {
    type: 'root',
    children: [
      { type: 'element', tag: 'h1', props: {}, children: [text('Heading 1')] },
      { type: 'element', tag: 'h2', props: {}, children: [text('Heading 2')] },
      { type: 'element', tag: 'h3', props: {}, children: [text('Heading 3')] },
      { type: 'element', tag: 'h4', props: {}, children: [text('Heading 4')] },
      { type: 'element', tag: 'h5', props: {}, children: [text('Heading 5')] },
      { type: 'element', tag: 'h6', props: {}, children: [text('Heading 6')] },
      {
        type: 'element',
        tag: 'p',
        props: {},
        children: [
          { type: 'element', tag: 'strong', props: {}, children: [text('Strong')] },
          { type: 'element', tag: 'em', props: {}, children: [text('Emphasis')] },
          { type: 'element', tag: 'del', props: {}, children: [text('Deleted')] },
          { type: 'element', tag: 'br', props: {}, children: [] },
          {
            type: 'element',
            tag: 'code',
            props: { language: 'ts', meta: 'title=example.ts' },
            children: [text('const safe = true')],
          },
          {
            type: 'element',
            tag: 'a',
            props: { href: 'https://example.com/docs', title: 'External docs' },
            children: [text('External')],
          },
          {
            type: 'element',
            tag: 'a',
            props: { href: '../src/index.ts' },
            children: [text('Source')],
          },
          {
            type: 'element',
            tag: 'img',
            props: { src: './diagram.svg#overview', alt: 'Architecture diagram' },
            children: [],
          },
        ],
      },
      {
        type: 'element',
        tag: 'blockquote',
        props: {},
        children: [text('Quoted')],
      },
      { type: 'element', tag: 'hr', props: {}, children: [] },
      {
        type: 'element',
        tag: 'pre',
        props: {},
        children: [
          {
            type: 'element',
            tag: 'code',
            props: { language: 'tsx' },
            children: [text('<Component />')],
          },
        ],
      },
      {
        type: 'element',
        tag: 'ul',
        props: {},
        children: [
          {
            type: 'element',
            tag: 'li',
            props: { checked: true },
            children: [text('Complete')],
          },
        ],
      },
      {
        type: 'element',
        tag: 'ol',
        props: { start: 3 },
        children: [
          {
            type: 'element',
            tag: 'li',
            props: {},
            children: [text('Third')],
          },
        ],
      },
      {
        type: 'element',
        tag: 'table',
        props: {},
        children: [
          {
            type: 'element',
            tag: 'thead',
            props: {},
            children: [
              {
                type: 'element',
                tag: 'tr',
                props: {},
                children: [
                  {
                    type: 'element',
                    tag: 'th',
                    props: { align: 'center' },
                    children: [text('Name')],
                  },
                ],
              },
            ],
          },
          {
            type: 'element',
            tag: 'tbody',
            props: {},
            children: [
              {
                type: 'element',
                tag: 'tr',
                props: {},
                children: [
                  {
                    type: 'element',
                    tag: 'td',
                    props: { align: 'right' },
                    children: [text('Value')],
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        type: 'component',
        name: 'Callout',
        props: { type: 'warning', title: 'Careful' },
        children: [text('Use the safe path.')],
      },
      {
        type: 'component',
        name: 'FileReference',
        props: { path: 'src/index.ts', line: 12, label: 'Entry point' },
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
        props: { id: 'diff:proposal-1', label: 'Proposed diff' },
        children: [],
      },
      {
        type: 'component',
        name: 'ArchitectureImpact',
        props: { id: 'impact:proposal-1', title: 'Impact' },
        children: [text('Awaiting analysis.')],
      },
    ],
  },
} satisfies MdxSafeDocument

describe('SafeDocumentRenderer', () =>
{
  it('renders every intrinsic tag and the closed host catalog without authored DOM props', () =>
  {
    const markup = renderToStaticMarkup(
      <SafeDocumentRenderer
        document={exhaustiveDocument}
        source="# Safe"
        documentPath="docs/guide.mdx"
        environmentId={environmentId}
        threadId={threadId}
        onOpenFile={vi.fn()}
      />,
    )

    for (const tag of [
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'p',
      'strong',
      'em',
      'del',
      'br',
      'code',
      'a',
      'img',
      'blockquote',
      'hr',
      'pre',
      'ul',
      'ol',
      'li',
      'table',
      'thead',
      'tbody',
      'tr',
      'th',
      'td',
    ])
    {
      expect(markup).toContain(`<${tag}`)
    }
    expect(markup).toContain('data-language="ts"')
    expect(markup).toContain('<ol start="3">')
    expect(markup).toContain('type="checkbox"')
    expect(markup).toContain('task-list-item')
    expect(markup).toContain('text-center')
    expect(markup).toContain('text-right')
    expect(markup).toContain('chat-markdown-table-container')
    expect(markup).toContain('href="https://example.com/docs"')
    expect(markup).toContain('target="_blank"')
    expect(markup).toContain('rel="noopener noreferrer"')
    expect(markup).toContain('src="https://assets.invalid/capability-token#overview"')
    expect(markup).not.toContain('src="./diagram.svg')
    expect(markup).toContain('Entry point')
    expect(markup).toContain('Proposed diff')
    expect(markup).toContain('Architecture analysis is unavailable')
    expect(markup).toContain('Informational diagnostic.')
    expect(markup).not.toContain('title=example.ts')
  })

  it('wires normalized file references without inventing diff or architecture actions', () =>
  {
    const onOpenFile = vi.fn()
    const context = {
      documentPath: 'docs/guide.mdx',
      environmentId,
      threadId,
      onOpenFile,
    }
    const fileNode = exhaustiveDocument.root.children.find(
      (node) => node.type === 'component' && node.name === 'FileReference',
    )
    const symbolNode = exhaustiveDocument.root.children.find(
      (node) => node.type === 'component' && node.name === 'SymbolReference',
    )
    if (!fileNode || !symbolNode) throw new Error('Reference fixture is incomplete.')

    const fileElement = renderMdxSafeNode(fileNode, context, 'file')
    const symbolElement = renderMdxSafeNode(symbolNode, context, 'symbol')
    if (!isValidElement(fileElement) || !isValidElement(symbolElement))
    {
      throw new Error('Reference nodes did not render controls.')
    }
    ;(fileElement as ReactElement<{ onClick: () => void }>).props.onClick()
    ;(symbolElement as ReactElement<{ onClick: () => void }>).props.onClick()

    expect(onOpenFile).toHaveBeenNthCalledWith(1, 'src/index.ts', 12)
    expect(onOpenFile).toHaveBeenNthCalledWith(2, 'src/index.ts', 12)
  })

  it('blocks the complete partial tree on an error and escapes the exact source', () =>
  {
    const source = '<script data-secret="never-run">alert(1)</script>'
    const document = {
      ...exhaustiveDocument,
      diagnostics: [
        {
          code: 'MDXF110',
          ruleId: 'mdx-forge/unsupported-safe-syntax',
          severity: 'error',
          message: 'Executable syntax is not supported.',
          source: 'mdx-forge',
          range: {
            start: { line: 1, column: 1, offset: 0 },
            end: { line: 1, column: 7, offset: 6 },
          },
        },
        {
          code: 'MDX_INFO',
          ruleId: 'test/info',
          severity: 'info',
          message: 'Additional document diagnostic.',
          source: '456code',
        },
      ],
    } satisfies MdxSafeDocument
    const markup = renderToStaticMarkup(
      <SafeDocumentRenderer
        document={document}
        source={source}
        documentPath="docs/unsafe.mdx"
        environmentId={environmentId}
        threadId={threadId}
        onOpenFile={vi.fn()}
      />,
    )

    expect(markup).toContain('MDX preview is unavailable.')
    expect(markup).toContain('MDXF110')
    expect(markup).toContain('MDX_INFO')
    expect(markup).toContain('Additional document diagnostic.')
    expect(markup).toContain('line 1, column 1')
    expect(markup).toContain('&lt;script data-secret=&quot;never-run&quot;&gt;')
    expect(markup).not.toContain('<h1')
    expect(markup).not.toContain('<script')
  })

  it('throws on future runtime tags, components, and node kinds', () =>
  {
    const context = {
      documentPath: 'docs/guide.mdx',
      environmentId,
      threadId,
      onOpenFile: vi.fn(),
    }
    const futureTag = {
      type: 'element',
      tag: 'iframe',
      props: { src: 'https://example.com' },
      children: [],
    } as unknown as MdxSafeDocumentNode
    const futureComponent = {
      type: 'component',
      name: 'FutureComponent',
      props: {},
      children: [],
    } as unknown as MdxSafeDocumentNode
    const unknownComponent = {
      type: 'unknownComponent',
      name: 'Unknown',
      children: [],
    } as unknown as MdxSafeDocumentNode

    expect(() => renderMdxSafeNode(futureTag, context, 'future-tag')).toThrow(
      'Unsupported MDX element',
    )
    expect(() => renderMdxSafeNode(futureComponent, context, 'future-component')).toThrow(
      'Unsupported MDX component',
    )
    expect(() => renderMdxSafeNode(unknownComponent, context, 'unknown-component')).toThrow(
      'Unsupported MDX node',
    )

    const futureDocument = {
      ...exhaustiveDocument,
      root: {
        ...exhaustiveDocument.root,
        children: [futureTag],
      },
    } as unknown as MdxSafeDocument
    const source = '<iframe />'
    const markup = renderToStaticMarkup(
      <SafeDocumentRenderer
        document={futureDocument}
        source={source}
        documentPath="docs/future.mdx"
        environmentId={environmentId}
        threadId={threadId}
        onOpenFile={vi.fn()}
      />,
    )

    expect(markup).toContain('MDX preview is unavailable.')
    expect(markup).toContain('Unsupported MDX element')
    expect(markup).toContain('&lt;iframe /&gt;')
  })

  it('fails closed on unsupported workspace fragments', () =>
  {
    const source = '[Architecture](./reference.md#architecture)'
    const document = {
      ...exhaustiveDocument,
      root: {
        ...exhaustiveDocument.root,
        children: [
          {
            type: 'element',
            tag: 'a',
            props: { href: './reference.md#architecture' },
            children: [text('Architecture')],
          },
        ],
      },
    } satisfies MdxSafeDocument
    const markup = renderToStaticMarkup(
      <SafeDocumentRenderer
        document={document}
        source={source}
        documentPath="docs/guide.mdx"
        environmentId={environmentId}
        threadId={threadId}
        onOpenFile={vi.fn()}
      />,
    )

    expect(markup).toContain('MDX preview is unavailable.')
    expect(markup).toContain('fragment_not_allowed')
    expect(markup).toContain('./reference.md#architecture')
    expect(markup).not.toContain('<button')
  })

  it('passes all diagnostics into the descendant render boundary', () =>
  {
    const rendered = SafeDocumentRenderer({
      document: exhaustiveDocument,
      source: '# Safe',
      documentPath: 'docs/guide.mdx',
      environmentId,
      threadId,
      onOpenFile: vi.fn(),
    })
    if (!isValidElement(rendered))
    {
      throw new Error('Safe document did not create a render boundary.')
    }

    expect(
      (
        rendered as ReactElement<{
          diagnostics: ReadonlyArray<MdxSafeDocument['diagnostics'][number]>
        }>
      ).props.diagnostics,
    ).toBe(exhaustiveDocument.diagnostics)
  })
})
