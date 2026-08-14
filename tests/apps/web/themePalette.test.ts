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
  it('gamut maps extreme finite chroma without losing the reachable hue', () =>
  {
    const input = 'oklch(0.5 1e303 0)'
    expect(toCanonicalThemeColor(input)).toBe('oklch(0.5 1e+303 0)')
    const colors = createManagedThemeColors('dark', '#000000', input)
    expect(colors.accent).toBe(toCanonicalThemeColor('#b5005e'))
    expect(Object.values(colors).every((color) => toCanonicalThemeColor(color) !== null)).toBe(true)
  })

  it('canonicalizes bounded literal CSS colors and rejects references or nonfinite values', () =>
  {
    expect(toCanonicalThemeColor('rgb(255 0 0)')).toBe(toCanonicalThemeColor('#ff0000'))
    expect(toCanonicalThemeColor('oklch(0.5 0.1 390 / 0.5)')).toBe('oklch(0.5 0.1 30 / 0.5)')
    for (const value of [
      'var(--color)',
      'currentColor',
      '#fff; color:red',
      'oklch(0.5 1e999 0)',
      ' '.repeat(65),
    ])
    {
      expect(toCanonicalThemeColor(value)).toBeNull()
    }
  })

  it('keeps exact seeds and lets only known valid role overrides win', () =>
  {
    const generated = createManagedThemeColors('dark', '#112233', '#6688aa')
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
