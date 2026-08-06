// tests/apps/mobile/features/terminal/terminalTheme.test.ts
// verify get pierre terminal theme behavior

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
    const theme = getPierreTerminalTheme('dark')
    const config = buildGhosttyThemeConfig(theme)

    expect(config).toContain(`background = ${theme.background}`)
    expect(config).toContain(`foreground = ${theme.foreground}`)
    expect(config).toContain(`cursor-color = ${theme.cursorForeground}`)
    expect(config.match(/^palette = \d+=/gm)).toHaveLength(16)
    expect(config.endsWith('\n')).toBe(true)
  })
})
