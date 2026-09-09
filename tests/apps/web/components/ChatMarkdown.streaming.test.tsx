// tests/apps/web/components/ChatMarkdown.streaming.test.tsx
// verify stable markdown mounts across streaming and settlement

// @vitest-environment happy-dom

import { EnvironmentId, ThreadId, DEFAULT_CLIENT_SETTINGS } from '@t3tools/contracts'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vite-plus/test'

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
  getClientSettings: () => DEFAULT_CLIENT_SETTINGS,
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

describe('ChatMarkdown streaming mounts', () =>
{
  it('keeps existing markdown image nodes mounted across streaming updates and settlement', async () =>
  {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) =>
    {
      callback(0)
      return 1
    })
    const container = document.createElement('div')
    const root = createRoot(container)
    const prefix = '![chart](https://images.example/chart.png)\n\n```text\nclosed code\n```\n\n'
    const render = async (text: string, isStreaming: boolean) =>
      act(async () =>
      {
        root.render(
          <ChatMarkdown
            text={text}
            isStreaming={isStreaming}
            cwd="/workspace"
            threadRef={threadRef}
          />,
        )
      })
    try
    {
      await render(prefix + 'First', true)
      const image = container.querySelector('img')
      expect(image).not.toBeNull()
      await render(prefix + 'First update', true)
      expect(container.querySelector('img')).toBe(image)
      await render(prefix + 'First update finished', false)
      expect(container.querySelector('img')).toBe(image)
    }
    finally
    {
      await act(async () => root.unmount())
      raf.mockRestore()
      vi.unstubAllGlobals()
    }
  })
})
