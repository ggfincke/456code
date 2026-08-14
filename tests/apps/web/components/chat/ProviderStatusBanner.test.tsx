// tests/apps/web/components/chat/ProviderStatusBanner.test.tsx
// verify provider status banner behavior

import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from '@t3tools/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vite-plus/test'

import {
  getProviderStatusBannerKey,
  ProviderStatusBanner,
  shouldPromoteThreadErrorToProviderReAuth,
  shouldShowProviderStatusBanner,
} from '../../../../../apps/web/src/components/chat/ProviderStatusBanner'

function warningProvider(): ServerProvider
{
  return {
    instanceId: ProviderInstanceId.make('codex'),
    driver: ProviderDriverKind.make('codex'),
    displayName: 'Codex',
    enabled: true,
    installed: true,
    version: '1.0.0',
    status: 'warning',
    auth: { status: 'authenticated' },
    checkedAt: '2026-07-23T12:00:00.000Z',
    message: 'Provider is temporarily degraded.',
    models: [],
    slashCommands: [],
    skills: [],
  }
}

describe('ProviderStatusBanner', () =>
{
  it('stays hidden after its current warning is dismissed', () =>
  {
    const status = warningProvider()

    expect(shouldShowProviderStatusBanner(status, null)).toBe(true)
    expect(shouldShowProviderStatusBanner(status, getProviderStatusBannerKey(status))).toBe(false)
  })

  it('does not re-promote an authentication error after its thread banner is dismissed', () =>
  {
    const status = { ...warningProvider(), status: 'ready' as const }

    expect(shouldPromoteThreadErrorToProviderReAuth(status, 'Authentication expired')).toBe(true)
    expect(shouldPromoteThreadErrorToProviderReAuth(status, null)).toBe(false)
  })

  it('renders an accessible dismiss control for provider warnings', () =>
  {
    const markup = renderToStaticMarkup(
      <ProviderStatusBanner status={warningProvider()} onDismiss={() =>
      {}} />,
    )

    expect(markup).toContain('role="alert"')
    expect(markup).toContain('aria-label="Dismiss Codex provider warning"')
    expect(markup).toContain('absolute top-2 right-2')
  })

  it('labels error dismiss controls with the correct severity', () =>
  {
    const markup = renderToStaticMarkup(
      <ProviderStatusBanner
        status={{ ...warningProvider(), status: 'error' }}
        onDismiss={() =>
        {}}
      />,
    )

    expect(markup).toContain('aria-label="Dismiss Codex provider error"')
  })
})
