// tests/apps/web/lib/markdown/clipboard.test.ts
// verify rendered markdown code selections retain their inline or block shape

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import {
  chatMarkdownClipboardPayload,
  serializeRenderedMarkdownFragment,
} from '../../../../../apps/web/src/lib/markdown/clipboard'

const TEXT_NODE = 3
const ELEMENT_NODE = 1

class FakeText
{
  readonly nodeType = TEXT_NODE
  readonly childNodes: ReadonlyArray<never> = []

  constructor(readonly textContent: string)
  {}
}

class FakeElement
{
  readonly nodeType = ELEMENT_NODE
  readonly childNodes: Array<FakeElement | FakeText> = []
  readonly classList = {
    contains: (name: string) => this.classNames.includes(name),
  }

  constructor(
    readonly tagName: string,
    private readonly classNames: ReadonlyArray<string> = [],
  )
  {}

  get localName(): string
  {
    return this.tagName.toLowerCase()
  }

  get textContent(): string
  {
    return this.childNodes.map((child) => child.textContent).join('')
  }

  append(...children: Array<FakeElement | FakeText>): this
  {
    this.childNodes.push(...children)
    return this
  }

  getAttribute(): string | null
  {
    return null
  }

  hasAttribute(): boolean
  {
    return false
  }
}

function asNode(element: FakeElement): Node
{
  return element as unknown as Node
}

function shikiCodeLine(text: string): FakeElement
{
  const token = new FakeElement('SPAN').append(new FakeText(text))
  return new FakeElement('SPAN', ['line']).append(token)
}

describe('serializeRenderedMarkdownFragment', () =>
{
  beforeEach(() =>
  {
    vi.stubGlobal('Node', { TEXT_NODE, ELEMENT_NODE })
  })

  afterEach(() =>
  {
    vi.unstubAllGlobals()
  })

  it('wraps inline code in backticks', () =>
  {
    const container = new FakeElement('DIV').append(
      new FakeElement('P').append(
        new FakeText('run '),
        new FakeElement('CODE').append(new FakeText('git status')),
        new FakeText(' first'),
      ),
    )

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe('run `git status` first')
  })

  it('keeps highlighted block code plain when the pre wrapper is outside the range', () =>
  {
    const container = new FakeElement('DIV').append(
      new FakeElement('CODE').append(shikiCodeLine('git show-ref --verify refs/heads/main')),
    )

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe(
      'git show-ref --verify refs/heads/main',
    )
  })

  it('keeps multiline code plain instead of inline-wrapping it', () =>
  {
    const container = new FakeElement('DIV').append(
      new FakeElement('CODE').append(new FakeText('first line\nsecond line')),
    )

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe('first line\nsecond line')
  })

  it('copies a partial pre selection as plain text without adding fences', () =>
  {
    const container = {
      appendChild: vi.fn(),
      querySelectorAll: () => [],
      innerHTML: '<code>git status</code>',
    }
    vi.stubGlobal('document', { createElement: () => container })
    const selection = {
      rangeCount: 1,
      getRangeAt: () => ({
        collapsed: false,
        cloneContents: () => ({}),
        commonAncestorContainer: {
          nodeType: ELEMENT_NODE,
          closest: (selector: string) => (selector === 'pre' ? {} : null),
        },
        toString: () => 'git status',
      }),
    }

    expect(chatMarkdownClipboardPayload(selection as unknown as Selection)).toEqual({
      text: 'git status',
      html: '<meta charset="utf-8"><code>git status</code>',
    })
  })
})
