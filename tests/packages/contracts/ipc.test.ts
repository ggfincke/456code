// tests/packages/contracts/ipc.test.ts
// verify desktop environment bootstrap schema behavior

import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vite-plus/test'

import {
  DesktopEnvironmentBootstrapSchema,
  DesktopPreviewTabStateSchema,
  FAVICON_CAPTURED_AT_MAX,
  FAVICON_DATA_URL_MAX_LENGTH,
} from '../../../packages/contracts/src/ipc.ts'

const decodeDesktopEnvironmentBootstrap = Schema.decodeUnknownSync(
  DesktopEnvironmentBootstrapSchema,
)
const decodeDesktopPreviewTabState = Schema.decodeUnknownSync(DesktopPreviewTabStateSchema)

describe('DesktopEnvironmentBootstrapSchema', () =>
{
  it('preserves the concrete running distro separately from the backend id', () =>
  {
    expect(
      decodeDesktopEnvironmentBootstrap({
        id: 'wsl:default',
        label: 'WSL (Ubuntu)',
        runningDistro: 'Ubuntu',
        httpBaseUrl: 'http://127.0.0.1:3774/',
        wsBaseUrl: 'ws://127.0.0.1:3774/',
      }),
    ).toEqual({
      id: 'wsl:default',
      label: 'WSL (Ubuntu)',
      runningDistro: 'Ubuntu',
      httpBaseUrl: 'http://127.0.0.1:3774/',
      wsBaseUrl: 'ws://127.0.0.1:3774/',
    })
  })
})

describe('DesktopPreviewTabStateSchema favicon boundary', () =>
{
  const base = {
    tabId: 'tab-1',
    webContentsId: 42,
    navStatus: { kind: 'Success' as const, url: 'https://example.com/', title: 'Example' },
    canGoBack: false,
    canGoForward: false,
    zoomFactor: 1,
    colorScheme: 'system' as const,
    audioMuted: false,
    audible: false,
    controller: 'none' as const,
    updatedAt: '2026-08-16T00:00:00.000Z',
  }

  it('preserves a bounded PNG capture and rejects malformed or oversized fields', () =>
  {
    const favicon = {
      dataUrl: 'data:image/png;base64,cG5n',
      pageUrl: 'https://example.com',
      capturedAt: 1_786_838_400_000,
    }
    expect(decodeDesktopPreviewTabState({ ...base, favicon })).toMatchObject({ favicon })

    for (const invalidFavicon of [
      { ...favicon, dataUrl: 'data:image/svg+xml;base64,c3Zn' },
      {
        ...favicon,
        dataUrl: `data:image/png;base64,${'a'.repeat(FAVICON_DATA_URL_MAX_LENGTH)}`,
      },
      { ...favicon, pageUrl: `https://example.com/${'x'.repeat(2_048)}` },
      { ...favicon, capturedAt: Number.NaN },
      { ...favicon, capturedAt: FAVICON_CAPTURED_AT_MAX + 1 },
    ])
    {
      expect(() => decodeDesktopPreviewTabState({ ...base, favicon: invalidFavicon })).toThrow()
    }
  })
})
