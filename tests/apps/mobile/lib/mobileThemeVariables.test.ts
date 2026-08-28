// tests/apps/mobile/lib/mobileThemeVariables.test.ts
// verify generated default mobile theme variables

import { describe, expect, it } from 'vite-plus/test'

import { getDefaultMobileThemeVariables } from '../../../../apps/mobile/src/lib/mobileThemeVariables'

describe('default mobile theme variables', () =>
{
  it('exposes complete light and dark palettes for native interop', () =>
  {
    const light = getDefaultMobileThemeVariables('light')
    const dark = getDefaultMobileThemeVariables('dark')

    expect(light['--color-screen']).toBe('#f2f2f7')
    expect(dark['--color-screen']).toBe('#0a0a0a')
    expect(light['--color-foreground']).toBe('#262626')
    expect(dark['--color-foreground']).toBe('#f5f5f5')
    expect(Object.keys(light)).toEqual(Object.keys(dark))
  })
})
