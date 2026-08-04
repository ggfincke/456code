// tests/apps/web/components/preview/previewAutomationOpenReadiness.test.ts
// verify preview automation open readiness behavior

import type { PreviewAutomationOpenInput, PreviewSessionSnapshot } from '@t3tools/contracts'
import { describe, expect, it } from 'vite-plus/test'

import { previewAutomationOpenNeedsOverlay } from '../../../../../apps/web/src/components/preview/previewAutomationOpenReadiness'

const snapshot = (navStatus: PreviewSessionSnapshot['navStatus']): PreviewSessionSnapshot => ({
  threadId: 'thread-1',
  tabId: 'tab-1',
  navStatus,
  canGoBack: false,
  canGoForward: false,
  updatedAt: '2026-06-26T00:00:00.000Z',
})

describe('preview automation open readiness', () =>
{
  it('does not wait for a desktop overlay when opening an empty tab', () =>
  {
    expect(
      previewAutomationOpenNeedsOverlay(
        {} as PreviewAutomationOpenInput,
        snapshot({ _tag: 'Idle' }),
      ),
    ).toBe(false)
  })

  it('waits when an empty tab is immediately given a URL', () =>
  {
    expect(
      previewAutomationOpenNeedsOverlay(
        { url: 'https://example.com' } as PreviewAutomationOpenInput,
        snapshot({ _tag: 'Idle' }),
      ),
    ).toBe(true)
  })

  it('waits for existing tabs that already have rendered content', () =>
  {
    expect(
      previewAutomationOpenNeedsOverlay(
        {} as PreviewAutomationOpenInput,
        snapshot({
          _tag: 'Success',
          url: 'https://example.com/',
          title: 'Example',
        }),
      ),
    ).toBe(true)
  })
})
