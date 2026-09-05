// tests/apps/web/onboarding/WelcomeWizard.test.tsx
// verify empty history discovery never traps first-run onboarding

// @vitest-environment happy-dom

import { DEFAULT_SERVER_SETTINGS } from '@t3tools/contracts'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vite-plus/test'

const fixtures = vi.hoisted(() => ({
  complete: vi.fn(),
  scan: vi.fn(),
  importSelected: vi.fn(),
  scanResult: { candidates: [] },
}))

vi.mock('../../../../apps/web/src/hooks/useImportSessions', () => ({
  useImportSessions: () => ({
    scan: fixtures.scan,
    scanResult: fixtures.scanResult,
    scanError: null,
    isScanning: false,
    isImporting: false,
    importResult: null,
    importError: null,
    importSelected: fixtures.importSelected,
    cancelImport: vi.fn(),
  }),
}))
vi.mock('../../../../apps/web/src/onboarding/firstRun', () => ({
  useCompleteOnboarding: () => fixtures.complete,
}))
vi.mock('../../../../apps/web/src/hooks/useCopyToClipboard', () => ({
  useCopyToClipboard: () => ({ copyToClipboard: vi.fn(), isCopied: false }),
}))

import { WelcomeWizard } from '../../../../apps/web/src/components/onboarding/WelcomeWizard'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

describe('WelcomeWizard', () =>
{
  it('finishes without importing after an empty scan', async () =>
  {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const onFinished = vi.fn()
    const button = (label: string) =>
      [...container.querySelectorAll('button')].find((item) => item.textContent === label)

    try
    {
      await act(async () =>
      {
        root.render(
          <WelcomeWizard
            providers={[]}
            settings={DEFAULT_SERVER_SETTINGS}
            platform="darwin"
            onFinished={onFinished}
          />,
        )
      })
      await act(async () => button('Continue')?.click())
      expect(fixtures.scan).toHaveBeenCalledOnce()
      expect(container.textContent).toContain('No importable Codex or Claude sessions were found.')
      expect(button('Import selected')?.disabled).toBe(true)
      expect(button('Continue without importing')?.disabled).toBe(false)

      await act(async () => button('Continue without importing')?.click())
      expect(fixtures.complete).toHaveBeenCalledOnce()
      expect(onFinished).toHaveBeenCalledOnce()
      expect(fixtures.importSelected).not.toHaveBeenCalled()
    }
    finally
    {
      await act(async () => root.unmount())
      container.remove()
    }
  })
})
