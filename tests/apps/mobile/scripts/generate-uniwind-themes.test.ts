// tests/apps/mobile/scripts/generate-uniwind-themes.test.ts
// verify deterministic mobile semantic theme generation

import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import { describe, expect, it } from 'vite-plus/test'

import {
  getGeneratedUniwindThemeOutputs,
  readDefaultThemeVariables,
  renderUniwindThemesCSS,
} from '../../../../apps/mobile/scripts/generate-uniwind-themes.mts'

describe('generate mobile Uniwind themes', () =>
{
  it('keeps committed outputs current', () =>
  {
    const staleOutputs = getGeneratedUniwindThemeOutputs()
      .filter(
        ([filename, contents]) =>
          !NodeFS.existsSync(filename) || NodeFS.readFileSync(filename, 'utf8') !== contents,
      )
      .map(([filename]) => NodePath.relative(import.meta.dirname, filename))

    expect(
      staleOutputs,
      'Run `pnpm --filter @t3tools/mobile generate` and commit the generated outputs.',
    ).toEqual([])
  })

  it('compiles one adaptive variable set for each system appearance', () =>
  {
    const stylesheet = renderUniwindThemesCSS()
    expect(stylesheet.match(/@variant light \{/gu)).toHaveLength(1)
    expect(stylesheet.match(/@variant dark \{/gu)).toHaveLength(1)
    expect(stylesheet).not.toContain('@variant light-')
    expect(stylesheet).not.toContain('@variant dark-')
  })

  it('extracts matching default token maps from the authored CSS', () =>
  {
    const css = NodeFS.readFileSync(
      NodePath.resolve(import.meta.dirname, '../../../../apps/mobile/global.css'),
      'utf8',
    )
    const variables = readDefaultThemeVariables(css)

    expect(variables.light['--color-screen']).toBe('#f2f2f7')
    expect(variables.dark['--color-screen']).toBe('#0a0a0a')
    expect(Object.keys(variables.light)).toEqual(Object.keys(variables.dark))
  })
})
