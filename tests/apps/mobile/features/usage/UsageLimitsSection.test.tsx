// tests/apps/mobile/features/usage/UsageLimitsSection.test.tsx
// verify native usage labels reveal explicitly without retaining a prior identity disclosure

// @vitest-environment happy-dom

import { ProviderDriverKind } from '@t3tools/contracts'
import type { LimitAccount } from '@t3tools/shared/usageLimits'
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vite-plus/test'

vi.mock('react-native', () => ({
  View: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
  Pressable: (props: {
    readonly children?: ReactNode
    readonly accessibilityLabel?: string
    readonly onPress?: () => void
  }) => (
    <button aria-label={props.accessibilityLabel} onClick={props.onPress}>
      {props.children}
    </button>
  ),
}))
vi.mock('../../../../../apps/mobile/src/components/AppText', () => ({
  AppText: ({ children }: { readonly children?: ReactNode }) => <span>{children}</span>,
}))

import { UsageLimitsSection } from '../../../../../apps/mobile/src/features/usage/UsageLimitsSection'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

it('redacts email labels, reveals by action, and resets when the label changes', async () =>
{
  const container = document.createElement('div')
  const root = createRoot(container)
  const account: LimitAccount = {
    key: 'account',
    driver: ProviderDriverKind.make('codex'),
    displayName: 'person@example.com',
    email: undefined,
    plan: undefined,
    accentColor: undefined,
    environments: [],
    usage: { status: 'available', observedAt: '2026-09-09T12:00:00Z', windows: [] },
  }
  const render = async (displayName: string) =>
    act(async () => root.render(<UsageLimitsSection accounts={[{ ...account, displayName }]} />))
  try
  {
    await render('person@example.com')
    expect(container.innerHTML).not.toContain('person@example.com')
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe(
      'Reveal account label',
    )
    await act(async () => container.querySelector<HTMLButtonElement>('button')?.click())
    expect(container.textContent).toContain('person@example.com')
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe('Hide account label')
    await render('other@example.com')
    expect(container.innerHTML).not.toContain('other@example.com')
    await render('Personal Codex')
    expect(container.textContent).toContain('Personal Codex')
    expect(container.querySelector('button')).toBeNull()
  }
  finally
  {
    await act(async () => root.unmount())
  }
})
