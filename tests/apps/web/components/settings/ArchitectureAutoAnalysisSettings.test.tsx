// tests/apps/web/components/settings/ArchitectureAutoAnalysisSettings.test.tsx
// verifies automatic architecture analysis settings copy and updates
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import type { ArchitectureAutoAnalysis } from '@t3tools/contracts/settings'

const mocks = vi.hoisted(() => ({
  mode: 'on-demand' as ArchitectureAutoAnalysis,
  updateSettings: vi.fn(),
}))

vi.mock('../../../../../apps/web/src/hooks/useSettings', () => ({
  usePrimarySettings: (
    selector: (settings: { architectureAutoAnalysis: ArchitectureAutoAnalysis }) => unknown,
  ) => selector({ architectureAutoAnalysis: mocks.mode }),
  useUpdatePrimarySettings: () => mocks.updateSettings,
}))

import { ArchitectureAutoAnalysisSettings } from '../../../../../apps/web/src/components/settings/ArchitectureAutoAnalysisSettings'
import { SettingResetButton } from '../../../../../apps/web/src/components/settings/settingsLayout'
import { Select } from '../../../../../apps/web/src/components/ui/select'

interface SelectProps
{
  readonly value: ArchitectureAutoAnalysis
  readonly onValueChange: (value: ArchitectureAutoAnalysis) => void
}

function findElementByType(element: ReactElement, type: ReactElement['type']): ReactElement | null
{
  if (element.type === type)
  {
    return element
  }
  const props = element.props as { readonly children?: unknown }
  const children = Array.isArray(props.children) ? props.children : [props.children]
  for (const child of children)
  {
    if (child && typeof child === 'object' && 'type' in child)
    {
      const match = findElementByType(child as ReactElement, type)
      if (match) return match
    }
  }
  return null
}

describe('ArchitectureAutoAnalysisSettings', () =>
{
  beforeEach(() =>
  {
    mocks.mode = 'on-demand'
    mocks.updateSettings.mockClear()
  })

  it('states that off and on-demand disable automatic work without hiding manual Diff analysis', () =>
  {
    const markup = renderToStaticMarkup(<ArchitectureAutoAnalysisSettings />)

    expect(markup).toContain('Off and On demand both disable automatic analysis in this version.')
    expect(markup).toContain(
      'Manual architecture analysis from Diff remains available in every mode.',
    )
    expect(markup).toContain('On demand')
  })

  it('publishes the selected scalar mode', () =>
  {
    const view = ArchitectureAutoAnalysisSettings()
    const select = findElementByType(view, Select) as ReactElement<SelectProps> | null

    expect(select?.props.value).toBe('on-demand')
    select?.props.onValueChange('auto')
    expect(mocks.updateSettings).toHaveBeenCalledWith({ architectureAutoAnalysis: 'auto' })
  })

  it('offers a reset only for a non-default mode', () =>
  {
    expect(findElementByType(ArchitectureAutoAnalysisSettings(), SettingResetButton)).toBeNull()

    mocks.mode = 'off'
    const reset = findElementByType(
      ArchitectureAutoAnalysisSettings(),
      SettingResetButton,
    ) as ReactElement<{ readonly onClick: () => void }> | null

    reset?.props.onClick()
    expect(mocks.updateSettings).toHaveBeenCalledWith({ architectureAutoAnalysis: 'on-demand' })
  })
})
