// tests/apps/web/themePalette.test.ts
// protect bounded palette generation and dynamic CSS ownership

// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vite-plus/test'
import { THEME_COLOR_ROLES } from '@t3tools/shared/themePalettes'
import {
  applyThemeColorOverrides,
  applyThemeColors,
  createManagedThemeColors,
  getStandardThemeColors,
  toCanonicalThemeColor,
} from '../../../apps/web/src/themePalette'

afterEach(() =>
{
  applyThemeColors(null)
  document.documentElement.className = ''
  document.documentElement.style.removeProperty('--unrelated')
})

describe('environment palette colors', () =>
{
  it('keeps exact seeds and lets only known valid role overrides win', () =>
  {
    const generated = createManagedThemeColors('dark', '#112233', '#6688aa', { exactSeeds: true })
    expect(generated.canvas).toBe(toCanonicalThemeColor('#112233'))
    expect(generated.accent).toBe(toCanonicalThemeColor('#6688aa'))
    const colors = applyThemeColorOverrides(generated, {
      accent: '#abcdef',
      text: 'var(--untrusted)',
      unknownRole: '#ffffff',
    })
    expect(colors.accent).toBe(toCanonicalThemeColor('#abcdef'))
    expect(colors.canvas).toBe(generated.canvas)
    expect(colors.text).toBe(generated.text)
    expect(Object.keys(colors).sort()).toEqual([...THEME_COLOR_ROLES].sort())
  })

  it('clears every owned variable and marker without changing stock classes or other styles', () =>
  {
    const root = document.documentElement
    root.className = 'dark ocean'
    root.style.setProperty('--unrelated', 'preserved')
    applyThemeColors(getStandardThemeColors('dark'))
    expect(root.dataset.environmentTheme).toBe('true')
    expect(root.style.getPropertyValue('--app-theme-sidebar')).toBe(
      toCanonicalThemeColor('#000000'),
    )
    expect(root.style.length).toBe(THEME_COLOR_ROLES.length + 1)
    applyThemeColors(null)
    expect(root.dataset.environmentTheme).toBeUndefined()
    expect(root.style.length).toBe(1)
    expect(root.style.getPropertyValue('--unrelated')).toBe('preserved')
    expect(root.className).toBe('dark ocean')
  })
})
