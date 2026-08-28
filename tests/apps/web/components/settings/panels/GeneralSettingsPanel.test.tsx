// tests/apps/web/components/settings/panels/GeneralSettingsPanel.test.tsx
// verifies unpin confirmation participates in settings restore

import { DEFAULT_UNIFIED_SETTINGS } from '@t3tools/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vite-plus/test'

const state = vi.hoisted(() => ({
  confirmThreadUnpin: false,
  confirm: vi.fn(async () => true),
  updateSettings: vi.fn(),
  setTheme: vi.fn(),
}))

vi.mock('../../../../../../apps/web/src/hooks/useSettings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../../apps/web/src/hooks/useSettings')>()),
  usePrimarySettings: () => ({
    ...DEFAULT_UNIFIED_SETTINGS,
    confirmThreadUnpin: state.confirmThreadUnpin,
  }),
  useUpdatePrimarySettings: () => state.updateSettings,
}))
vi.mock('../../../../../../apps/web/src/hooks/useTheme', () => ({
  useTheme: () => ({ theme: 'system', setTheme: state.setTheme }),
}))
vi.mock('../../../../../../apps/web/src/localApi', () => ({
  readLocalApi: () => ({ dialogs: { confirm: state.confirm } }),
  ensureLocalApi: () => ({ dialogs: { confirm: state.confirm } }),
}))

import { useSettingsRestore } from '../../../../../../apps/web/src/components/settings/panels/GeneralSettingsPanel'

describe('unpin confirmation settings restore', () =>
{
  it('marks the opt-in setting dirty and restores its false default', async () =>
  {
    const restored = vi.fn()
    const result: { current?: ReturnType<typeof useSettingsRestore> } = {}
    function Harness()
    {
      result.current = useSettingsRestore(restored)
      return null
    }

    state.confirmThreadUnpin = false
    renderToStaticMarkup(<Harness />)
    expect(result.current?.changedSettingLabels).toEqual([])

    state.confirmThreadUnpin = true
    renderToStaticMarkup(<Harness />)
    expect(result.current?.changedSettingLabels).toEqual(['Unpin confirmation'])
    await result.current?.restoreDefaults()

    expect(state.confirm).toHaveBeenCalledWith(
      'Restore default settings?\nThis will reset: Unpin confirmation.',
    )
    expect(state.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmThreadUnpin: false,
      }),
    )
    expect(restored).toHaveBeenCalledOnce()
  })
})
