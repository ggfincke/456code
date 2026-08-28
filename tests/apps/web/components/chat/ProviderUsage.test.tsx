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

  it('selects the shortest and longest aggregate windows and re-admits spent scoped limits', () =>
  {
    const selected = selectCompactProviderUsageWindows([
      window('week', 'Week', 84),
      window('month', 'Month', 20),
      window('five-hour', '5h', 62),
      window('sonnet', 'Week', 30, 'Sonnet'),
      window('opus', 'Week', 95, 'Opus'),
    ])

    expect(selected.map(({ id }) => id)).toEqual(['five-hour', 'month', 'opus'])
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

  it('keeps both healthy quota groups visible with five-hour limits before weekly limits', () =>
  {
    const usage: ServerProviderAccountUsage = {
      status: 'available',
      observedAt: '2026-08-28T12:00:00.000Z',
      windows: [
        window('gemini-week', 'Week', 25, 'Gemini Models'),
        window('gemini-5h', '5h', 20, 'Gemini Models'),
        window('other-week', 'Week', 40, 'Claude and GPT models'),
        window('other-5h', '5h', 0, 'Claude and GPT models'),
      ],
    }
    const markup = renderToStaticMarkup(<ProviderUsageStrip usage={usage} groupByScope />)
    expect(markup).toMatch(/Gemini Models.*?5h.*?80% left.*?Week.*?75% left/)
    expect(markup).toMatch(/Claude and GPT models.*?5h.*?100% left.*?Week.*?60% left/)
    expect(markup).not.toContain('text-destructive')
  })

  it('preserves the used-percent preference, exhaustion warnings, and grouped reset details', () =>
  {
    const usage: ServerProviderAccountUsage = {
      status: 'available',
      observedAt: '2026-08-28T12:00:00.000Z',
      windows: [
        window('gemini-5h', '5h', 100, 'Gemini Models'),
        window('other-week', 'Week', 25, 'Claude and GPT models'),
      ],
    }
    const markup = renderToStaticMarkup(
      <ProviderUsageStrip usage={usage} displayMode="percent-used" groupByScope />,
    )
    expect(markup).toContain('text-destructive')
    expect(markup).toContain('100% used')
    expect(markup).toContain('25% used')
    const details = renderToStaticMarkup(<ProviderUsageDetails usage={usage} />)
    expect(details).toContain('Gemini Models')
    expect(details).toContain('Claude and GPT models')
    expect(details).toContain('Resets ')
    expect(details).toContain('0% left')
  })

  it('keeps Codex and Claude scoped-only readings in the existing compact layout', () =>
  {
    const usage: ServerProviderAccountUsage = {
      status: 'available',
      observedAt: '2026-08-28T12:00:00.000Z',
      windows: [
        window('healthy', 'Week', 25, 'Healthy model'),
        window('spent', 'Week', 95, 'Spent model'),
      ],
    }
    const markup = renderToStaticMarkup(<ProviderUsageStrip usage={usage} />)
    expect(markup).toContain('Usage')
    expect(markup).toContain('5% left')
    expect(markup).not.toContain('75% left')
    expect(markup).not.toContain('Healthy model')
    expect(markup).not.toContain('Spent model')
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
