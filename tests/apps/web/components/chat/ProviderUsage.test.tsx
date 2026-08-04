// tests/apps/web/components/chat/ProviderUsage.test.tsx
// verifies provider usage math, compact selection, suppression, and state rendering
import type {
  ServerProviderAccountUsage,
  ServerProviderAccountUsageWindow,
} from '@t3tools/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vite-plus/test'

import {
  formatProviderUsagePercentLeft,
  isProviderUsageWindowDanger,
  ProviderUsageDetails,
  ProviderUsageStrip,
  providerUsagePercentLeft,
  selectCompactProviderUsageWindows,
  shouldShowProviderUsageStrip,
} from '../../../../../apps/web/src/components/chat/ProviderUsage'

function window(
  id: string,
  label: string,
  usedPercent: number,
  scopeLabel?: string,
): ServerProviderAccountUsageWindow
{
  return {
    id,
    label,
    usedPercent,
    resetsAt: '2026-08-01T12:00:00.000Z',
    ...(scopeLabel ? { scopeLabel } : {}),
  }
}

describe('provider usage presentation', () =>
{
  it('reports remaining percentage and marks ten percent left as dangerous', () =>
  {
    const healthy = window('five-hour', '5h', 61.6)
    const threshold = window('week', 'Week', 90)

    expect(providerUsagePercentLeft(healthy)).toBeCloseTo(38.4)
    expect(formatProviderUsagePercentLeft(healthy)).toBe('38% left')
    expect(isProviderUsageWindowDanger(healthy)).toBe(false)
    expect(isProviderUsageWindowDanger(threshold)).toBe(true)
  })

  it('selects the shortest and longest aggregate windows and omits scoped limits', () =>
  {
    const selected = selectCompactProviderUsageWindows([
      window('week', 'Week', 84),
      window('month', 'Month', 20),
      window('five-hour', '5h', 62),
      window('opus', 'Week', 95, 'Opus'),
    ])

    expect(selected.map(({ id }) => id)).toEqual(['five-hour', 'month'])
  })

  it('suppresses the strip for Favorites and search', () =>
  {
    const usage: ServerProviderAccountUsage = {
      status: 'available',
      observedAt: '2026-07-31T12:00:00.000Z',
      windows: [window('five-hour', '5h', 62)],
    }

    expect(
      shouldShowProviderUsageStrip({
        usage,
        selectedInstanceId: 'favorites',
        isSearching: false,
      }),
    ).toBe(false)
    expect(
      shouldShowProviderUsageStrip({
        usage,
        selectedInstanceId: 'codex',
        isSearching: true,
      }),
    ).toBe(false)
    expect(
      shouldShowProviderUsageStrip({
        usage,
        selectedInstanceId: 'codex',
        isSearching: false,
      }),
    ).toBe(true)
  })

  it('renders the compact percent-left summary', () =>
  {
    const usage: ServerProviderAccountUsage = {
      status: 'available',
      observedAt: '2026-07-31T12:00:00.000Z',
      windows: [window('five-hour', '5h', 62), window('week', 'Week', 84)],
    }
    const markup = renderToStaticMarkup(<ProviderUsageStrip usage={usage} />)

    expect(markup).toContain('data-model-picker-usage="available"')
    expect(markup).toContain('5h')
    expect(markup).toContain('38% left')
    expect(markup).toContain('Week')
    expect(markup).toContain('16% left')
  })

  it('renders the Cursor dashboard as a safe new-tab link', () =>
  {
    const usage: ServerProviderAccountUsage = {
      status: 'external',
      dashboardUrl: 'https://cursor.com/dashboard',
    }
    const markup = renderToStaticMarkup(<ProviderUsageStrip usage={usage} />)

    expect(markup).toContain('href="https://cursor.com/dashboard"')
    expect(markup).toContain('target="_blank"')
    expect(markup).toContain('rel="noopener noreferrer"')
    expect(markup).toContain('View Cursor usage')
  })

  it('renders unavailable and non-applicable explanations', () =>
  {
    const unavailable: ServerProviderAccountUsage = {
      status: 'unavailable',
      observedAt: '2026-07-31T12:00:00.000Z',
      message: 'Claude plan usage is temporarily unavailable.',
    }
    const notApplicable: ServerProviderAccountUsage = {
      status: 'notApplicable',
      observedAt: '2026-07-31T12:00:00.000Z',
      message: 'Plan limits do not apply to API key sessions.',
    }

    expect(renderToStaticMarkup(<ProviderUsageStrip usage={unavailable} />)).toContain(
      unavailable.message,
    )
    expect(renderToStaticMarkup(<ProviderUsageDetails usage={notApplicable} />)).toContain(
      notApplicable.message,
    )
  })
})
