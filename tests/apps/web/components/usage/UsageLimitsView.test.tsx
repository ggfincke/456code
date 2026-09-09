// tests/apps/web/components/usage/UsageLimitsView.test.tsx
// verify email-bearing usage labels require disclosure and reset on identity changes

// @vitest-environment happy-dom

import { ProviderDriverKind } from '@t3tools/contracts'
import type { LimitAccount } from '@t3tools/shared/usageLimits'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vite-plus/test'

import { UsageLimitsView } from '../../../../../apps/web/src/components/usage/UsageLimitsView'
import { TooltipProvider } from '../../../../../apps/web/src/components/ui/tooltip'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

it('hides email labels until requested and hides a replacement label again', async () =>
{
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const account: LimitAccount = {
    key: 'account',
    driver: ProviderDriverKind.make('codex'),
    displayName: 'Private person@example.com',
    email: undefined,
    plan: undefined,
    accentColor: undefined,
    environments: [],
    usage: { status: 'available', observedAt: '2026-09-09T12:00:00Z', windows: [] },
  }
  const render = async (displayName: string) =>
    act(async () =>
      root.render(
        <TooltipProvider>
          <UsageLimitsView accounts={[{ ...account, displayName }]} />
        </TooltipProvider>,
      ),
    )
  try
  {
    await render('Private person@example.com')
    expect(container.innerHTML).not.toContain('person@example.com')
    await act(async () => container.querySelector<HTMLButtonElement>('button')?.click())
    expect(container.textContent).toContain('Private person@example.com')
    await render('other@example.com')
    expect(container.innerHTML).not.toContain('other@example.com')
    await act(async () => container.querySelector<HTMLButtonElement>('button')?.click())
    expect(container.textContent).toContain('other@example.com')
    await act(async () => container.querySelector<HTMLButtonElement>('button')?.click())
    expect(container.innerHTML).not.toContain('other@example.com')
    await render('Personal Codex')
    expect(container.textContent).toContain('Personal Codex')
    expect(container.querySelector('button')).toBeNull()
  }
  finally
  {
    await act(async () => root.unmount())
    container.remove()
  }
})
