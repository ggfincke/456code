// tests/apps/mobile/features/threads/feed/feedMarkdown.test.tsx
// verify mounted mobile markdown favicon privacy and host-scoped failures

// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vite-plus/test'

vi.mock('react-native', () => ({
  Image: (props: { readonly source: { readonly uri?: string }; readonly onError?: () => void }) => (
    <img alt="" src={props.source.uri} onError={props.onError} />
  ),
  Linking: { openURL: vi.fn() },
  ScrollView: (props: { readonly children?: ReactNode }) => <div>{props.children}</div>,
  StyleSheet: { create: <Styles,>(styles: Styles) => styles },
  Text: (props: { readonly children?: ReactNode }) => <span>{props.children}</span>,
  useColorScheme: () => 'light',
  View: (props: { readonly children?: ReactNode }) => <div>{props.children}</div>,
}))
vi.mock('@t3tools/mobile-markdown-text/file-icons', () => ({
  markdownFileIconSource: vi.fn(),
}))
vi.mock('@t3tools/mobile-markdown-text/links', () => ({
  resolveMarkdownLinkPresentation: vi.fn(),
}))
vi.mock('../../../../../../apps/mobile/src/components/CopyTextButton', () => ({
  CopyTextButton: () => null,
}))
vi.mock('../../../../../../apps/mobile/src/lib/appearancePreferences', () => ({
  resolveMarkdownFontSizes: vi.fn(),
  resolveNativeMarkdownTypography: vi.fn(),
}))
vi.mock(
  '../../../../../../apps/mobile/src/features/settings/appearance/AppearancePreferencesProvider',
  () => ({ useAppearancePreferences: vi.fn() }),
)
vi.mock('../../../../../../apps/mobile/src/lib/useFontFamily', () => ({
  useFontFamily: vi.fn(),
}))
vi.mock('../../../../../../apps/mobile/src/lib/useThemeColor', () => ({
  useThemeColor: vi.fn(),
}))
vi.mock('../../../../../../apps/mobile/src/features/threads/markdownCodeHighlightState', () => ({
  useMarkdownCodeHighlight: vi.fn(),
}))

import { MarkdownExternalLink } from '../../../../../../apps/mobile/src/features/threads/feed/feedMarkdown'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

describe('MarkdownExternalLink', () =>
{
  it('omits private favicon requests and retries public icons after a host failure or change', async () =>
  {
    const container = document.createElement('div')
    const root = createRoot(container)
    const render = async (host: string) =>
    {
      await act(async () =>
      {
        root.render(
          <MarkdownExternalLink color="#2563eb" host={host} href={`https://${host}/private-path`}>
            Link
          </MarkdownExternalLink>,
        )
      })
    }

    try
    {
      await render('mobile-favicon-one.example.org')
      expect(container.querySelector('img')?.getAttribute('src')).toBe(
        'https://www.google.com/s2/favicons?domain=mobile-favicon-one.example.org&sz=32',
      )

      await act(async () =>
      {
        container.querySelector('img')?.dispatchEvent(new Event('error', { bubbles: true }))
      })
      expect(container.querySelector('img')).toBeNull()
      expect(container.textContent).toContain('◉')

      await render('localhost')
      expect(container.querySelector('img')).toBeNull()
      expect(container.textContent).toContain('◉')

      await render('mobile-favicon-two.example.org')
      expect(container.querySelector('img')?.getAttribute('src')).toBe(
        'https://www.google.com/s2/favicons?domain=mobile-favicon-two.example.org&sz=32',
      )
    }
    finally
    {
      await act(async () => root.unmount())
    }
  })
})
