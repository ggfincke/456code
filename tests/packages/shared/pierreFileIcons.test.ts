// tests/packages/shared/pierreFileIcons.test.ts
// verifies the neutral custom pierre icon catalog contract

import { describe, expect, it } from 'vite-plus/test'

import {
  PIERRE_CUSTOM_FILE_ICON_BY_FILE_NAME,
  PIERRE_CUSTOM_FILE_ICON_SPRITE,
  PIERRE_MOBILE_CUSTOM_ICON_BY_TOKEN,
} from '@t3tools/shared/pierreFileIcons'

describe('Pierre custom file icon catalog', () =>
{
  it('exports one normalized catalog with valid symbol references', () =>
  {
    const symbolIds = [...PIERRE_CUSTOM_FILE_ICON_SPRITE.matchAll(/<symbol\s+id="([^"]+)"/g)].map(
      (match) => match[1],
    )
    const knownSymbols = new Set(symbolIds)

    expect(symbolIds).toHaveLength(6)
    expect(knownSymbols.size).toBe(symbolIds.length)
    expect(Object.keys(PIERRE_CUSTOM_FILE_ICON_BY_FILE_NAME)).toEqual([
      'agents.md',
      'claude.md',
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'readme.md',
      'tsconfig.json',
    ])
    expect(Object.keys(PIERRE_MOBILE_CUSTOM_ICON_BY_TOKEN)).toEqual([
      'agents',
      'claude',
      'package',
      'pnpm',
      'readme',
      'tsconfig',
    ])

    for (const symbolId of [
      ...Object.values(PIERRE_CUSTOM_FILE_ICON_BY_FILE_NAME),
      ...Object.values(PIERRE_MOBILE_CUSTOM_ICON_BY_TOKEN),
    ])
    {
      expect(knownSymbols.has(symbolId)).toBe(true)
    }
  })
})
