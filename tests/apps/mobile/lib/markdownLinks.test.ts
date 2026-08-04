// tests/apps/mobile/lib/markdownLinks.test.ts
// verify resolve markdown link presentation behavior

import { describe, expect, it } from 'vite-plus/test'

import { resolveMarkdownLinkPresentation } from '@t3tools/mobile-markdown-text/links'

describe('resolveMarkdownLinkPresentation', () =>
{
  it('extracts external link hosts', () =>
  {
    expect(resolveMarkdownLinkPresentation('https://example.com/docs?q=1')).toEqual({
      kind: 'external',
      href: 'https://example.com/docs?q=1',
      host: 'example.com',
    })
  })

  it('renders file URLs as basename pills with positions', () =>
  {
    expect(
      resolveMarkdownLinkPresentation('file:///Users/julius/project/src/main.ts#L42C7'),
    ).toEqual({
      kind: 'file',
      href: 'file:///Users/julius/project/src/main.ts#L42C7',
      icon: 'typescript',
      label: 'main.ts:42:7',
      path: '/Users/julius/project/src/main.ts',
      line: 42,
      column: 7,
    })
  })

  it('recognizes relative source paths and bare filenames', () =>
  {
    expect(resolveMarkdownLinkPresentation('apps/mobile/src/index.ts:10')).toEqual({
      kind: 'file',
      href: 'apps/mobile/src/index.ts:10',
      icon: 'typescript',
      label: 'index.ts:10',
      path: 'apps/mobile/src/index.ts',
      line: 10,
    })
    expect(resolveMarkdownLinkPresentation('AGENTS.md')).toEqual({
      kind: 'file',
      href: 'AGENTS.md',
      icon: 'agents',
      label: 'AGENTS.md',
      path: 'AGENTS.md',
    })
    expect(resolveMarkdownLinkPresentation('package.json')).toEqual({
      kind: 'file',
      href: 'package.json',
      icon: 'package',
      label: 'package.json',
      path: 'package.json',
    })
  })

  it('extracts line fragments from relative file links', () =>
  {
    expect(resolveMarkdownLinkPresentation('src/main.ts#L18C2')).toMatchObject({
      kind: 'file',
      path: 'src/main.ts',
      line: 18,
      column: 2,
      label: 'main.ts:18:2',
    })
  })

  it.each([
    { path: 'src/Button.tsx', icon: 'react' },
    { path: 'Dockerfile', icon: 'docker' },
  ])('uses the Pierre icon mapping for $path', ({ path, icon }) =>
  {
    expect(resolveMarkdownLinkPresentation(path)).toMatchObject({
      kind: 'file',
      icon,
    })
  })

  it('does not style app routes as file links', () =>
  {
    expect(resolveMarkdownLinkPresentation('/chat/settings')).toEqual({
      kind: 'link',
      href: null,
    })
  })
})
