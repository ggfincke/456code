// tests/apps/web/components/ChatMarkdown.workspace-images.test.tsx
// verify authenticated workspace markdown images and expansion affordances

import { EnvironmentId, ThreadId, DEFAULT_CLIENT_SETTINGS } from '@t3tools/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'

const testState = vi.hoisted(() => ({
  resources: [] as unknown[],
  assetState: 'success' as 'success' | 'loading' | 'failure',
  dimensions: undefined as { width: number; height: number } | undefined,
}))

vi.mock('@effect/atom-react', () => ({ useAtomValue: () => null }))
vi.mock('../../../../apps/web/src/assets/assetUrls', () => ({
  useAssetUrlState: (_environmentId: unknown, resource: unknown) =>
  {
    testState.resources.push(resource)
    if (testState.assetState === 'loading') return { _tag: 'Loading' }
    if (testState.assetState === 'failure') return { _tag: 'Failure' }
    return {
      _tag: 'Success',
      url: 'https://signed.test/workspace-image.svg',
      imageDimensions: testState.dimensions,
    }
  },
}))
vi.mock('../../../../apps/web/src/hooks/useTheme', () => ({
  useTheme: () => ({ resolvedTheme: 'dark' }),
}))
vi.mock('../../../../apps/web/src/hooks/useSettings', () => ({
  useClientSettings: (selector: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    selector(DEFAULT_CLIENT_SETTINGS),
}))
vi.mock('../../../../apps/web/src/hooks/useSyntaxThemeName', () => ({
  useSyntaxThemeName: () => 'github-dark',
}))
vi.mock('../../../../apps/web/src/state/use-atom-query-runner', () => ({
  useAtomQueryRunner: () => vi.fn(),
}))
vi.mock('../../../../apps/web/src/state/use-atom-command', () => ({
  useAtomCommand: () => vi.fn(),
}))
vi.mock('../../../../apps/web/src/state/session', () => ({
  usePreparedConnection: () => ({ _tag: 'Loading' }),
}))
vi.mock('../../../../apps/web/src/state/server', () => ({
  serverEnvironment: { configValueAtom: () => null },
}))
vi.mock('../../../../apps/web/src/state/entities', () => ({
  useActiveEnvironmentId: () => EnvironmentId.make('environment-images'),
}))
vi.mock('../../../../apps/web/src/lib/editorPreferences', () => ({
  useOpenInPreferredEditor: () => vi.fn(),
}))

import ChatMarkdown from '../../../../apps/web/src/components/ChatMarkdown'

const threadRef = {
  environmentId: EnvironmentId.make('environment-images'),
  threadId: ThreadId.make('thread-images'),
}

describe('ChatMarkdown workspace images', () =>
{
  beforeEach(() =>
  {
    testState.resources = []
    testState.assetState = 'success'
    testState.dimensions = undefined
  })

  it('loads nested workspace images through a signed URL and retains fragments', () =>
  {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/workspace/project"
        imageBaseDir="/workspace/project/docs"
        threadRef={threadRef}
        text="![diagram](images/diagram.svg#layer)"
      />,
    )

    expect(testState.resources).toEqual([
      {
        _tag: 'workspace-file',
        threadId: threadRef.threadId,
        path: '/workspace/project/docs/images/diagram.svg',
      },
    ])
    expect(html).toContain('src="https://signed.test/workspace-image.svg#layer"')
    expect(html).toContain('data-markdown-copy="![diagram](images/diagram.svg#layer)"')
  })

  it('keeps unresolved workspace sources visible and out of raw image requests', () =>
  {
    const html = renderToStaticMarkup(
      <ChatMarkdown cwd="/workspace/project" text="![diagram](images/diagram.png)" />,
    )

    expect(testState.resources).toEqual([])
    expect(html).toContain('Image unavailable')
    expect(html).not.toContain('<img')
    expect(html).toContain('data-markdown-copy="![diagram](images/diagram.png)"')
  })

  it('reserves signed dimensions before decode while inline badges stay inline', () =>
  {
    testState.dimensions = { width: 120, height: 600 }
    const figure = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/workspace/project"
        threadRef={threadRef}
        text="![diagram](diagram.png)"
      />,
    )
    expect(figure).toContain('data-image-loading="true"')
    expect(figure).toContain('aspect-ratio:120 / 600')
    expect(figure).toContain('max-width:min(100%, 30rem, 6rem)')
    const inline = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/workspace/project"
        threadRef={threadRef}
        text="Status ![badge](badge.png) ready"
      />,
    )
    expect(inline).not.toContain('data-image-loading')
  })

  it('makes standalone images expandable but leaves linked images to their anchor', () =>
  {
    const standalone = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/workspace/project"
        text="![diagram](https://example.test/diagram.png)"
        onImageExpand={() => undefined}
      />,
    )
    const linked = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/workspace/project"
        text="[![diagram](https://example.test/diagram.png)](https://example.test)"
        onImageExpand={() => undefined}
      />,
    )

    expect(standalone).toContain('role="button"')
    expect(standalone).toContain('aria-label="Preview diagram"')
    expect(linked).not.toContain('aria-label="Preview diagram"')
  })

  it('preserves authored markdown while an asset is loading or failed', () =>
  {
    testState.assetState = 'loading'
    const loading = renderToStaticMarkup(
      <ChatMarkdown cwd="/workspace/project" threadRef={threadRef} text="![logo](logo.svg)" />,
    )
    testState.assetState = 'failure'
    const failed = renderToStaticMarkup(
      <ChatMarkdown cwd="/workspace/project" threadRef={threadRef} text="![logo](logo.svg)" />,
    )

    expect(loading).toContain('aria-label="Loading image"')
    expect(loading).toContain('data-markdown-copy="![logo](logo.svg)"')
    expect(failed).toContain('Image unavailable')
    expect(failed).toContain('data-markdown-copy="![logo](logo.svg)"')
  })
})
