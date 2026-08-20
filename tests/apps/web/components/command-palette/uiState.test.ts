// tests/apps/web/components/command-palette/uiState.test.ts
// verifies command palette close animation and reopen reset identity

import { describe, expect, it } from 'vite-plus/test'

import { reduceCommandPaletteUiState } from '../../../../../apps/web/src/components/command-palette/uiState'

describe('command palette UI state', () =>
{
  it('keeps the closing generation mounted and advances it only when reopening', () =>
  {
    const initial = { open: false, openGeneration: 0, openIntent: null }
    const opened = reduceCommandPaletteUiState(initial, { _tag: 'SetOpen', open: true })
    const closed = reduceCommandPaletteUiState(opened, { _tag: 'SetOpen', open: false })
    const reopened = reduceCommandPaletteUiState(closed, { _tag: 'SetOpen', open: true })

    expect(opened.openGeneration).toBe(1)
    expect(closed).toMatchObject({ open: false, openGeneration: 1 })
    expect(reopened).toMatchObject({ open: true, openGeneration: 2 })
  })
})
