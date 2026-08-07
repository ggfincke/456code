// tests/packages/shared/themePalettes.test.ts
// protect stock theme identities and publication color presence

import { describe, expect, it } from 'vite-plus/test'
import {
  BUILT_IN_THEME_IDS,
  RESERVED_THEME_IDS,
  environmentThemeFileHasColors,
} from '../../../packages/shared/src/themePalettes.js'

describe('published theme vocabulary', () =>
{
  it('reserves stock selections including Ocean without adding a theme library', () =>
  {
    expect(BUILT_IN_THEME_IDS).toEqual(['light', 'dark', 'ocean'])
    expect([...RESERVED_THEME_IDS]).toEqual(['system', 'light', 'dark', 'ocean'])
    expect(RESERVED_THEME_IDS.has('desktop-dusk')).toBe(false)
  })

  it('requires both seeds or a nonempty role palette', () =>
  {
    expect(environmentThemeFileHasColors({})).toBe(false)
    expect(environmentThemeFileHasColors({ canvas: '#fff', colors: {} })).toBe(false)
    expect(environmentThemeFileHasColors({ accent: '#123' })).toBe(false)
    expect(environmentThemeFileHasColors({ canvas: '#fff', accent: '#123' })).toBe(true)
    expect(environmentThemeFileHasColors({ colors: { canvas: '#fff' } })).toBe(true)
  })
})
