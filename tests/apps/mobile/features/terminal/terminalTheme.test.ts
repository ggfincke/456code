import { describe, expect, it } from 'vite-plus/test'

import {
  buildGhosttyThemeConfig,
  getPierreTerminalTheme,
} from '../../../../../apps/mobile/src/features/terminal/terminalTheme'

describe('getPierreTerminalTheme', () =>
{
  it('returns a distinct Pierre palette for the dark scheme', () =>
  {
    const theme = getPierreTerminalTheme('dark')
    expect(theme.background).toMatch(/^#[0-9a-f]{6}$/i)
    expect(theme.foreground).toMatch(/^#[0-9a-fA-F]{6}$/)
    expect(theme.palette).toHaveLength(16)
    expect(theme.background).not.toBe(getPierreTerminalTheme('light').background)
  })
})

describe('buildGhosttyThemeConfig', () =>
{
  it('serializes theme colors into a ghostty config file', () =>
  {
    const config = buildGhosttyThemeConfig(getPierreTerminalTheme('dark'))

    expect(config).toContain('background = #0a0a0a')
    expect(config).toContain('foreground = #adadb1')
    expect(config).toContain('cursor-color = #009fff')
    expect(config).toContain('palette = 0=#141415')
    expect(config).toContain('palette = 15=#c6c6c8')
    expect(config.endsWith('\n')).toBe(true)
  })
})
