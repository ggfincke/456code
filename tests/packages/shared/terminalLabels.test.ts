import { describe, expect, it } from 'vite-plus/test'

import type { TerminalSummary } from '@t3tools/contracts'
import { DEFAULT_TERMINAL_ID } from '@t3tools/contracts'

import {
  getTerminalLabel,
  nextTerminalId,
  resolveTerminalSessionLabel,
} from '../../../packages/shared/src/terminalLabels.ts'

describe('getTerminalLabel', () =>
{
  it('falls back to the raw id for unknown shapes', () =>
  {
    expect(getTerminalLabel('custom-session')).toBe('custom-session')
  })
})

describe('resolveTerminalSessionLabel', () =>
{
  it('prefers a non-empty summary label', () =>
  {
    const summary = { label: '  bun  ' } as Pick<TerminalSummary, 'label'>
    expect(resolveTerminalSessionLabel('term-1', summary)).toBe('bun')
  })

  it('falls back to getTerminalLabel when summary is missing or blank', () =>
  {
    expect(resolveTerminalSessionLabel(DEFAULT_TERMINAL_ID, { label: '   ' })).toBe('Terminal 1')
    expect(resolveTerminalSessionLabel(DEFAULT_TERMINAL_ID, null)).toBe('Terminal 1')
    expect(resolveTerminalSessionLabel('term-2', undefined)).toBe('Terminal 2')
    expect(resolveTerminalSessionLabel('term-12', null)).toBe('Terminal 12')
    expect(resolveTerminalSessionLabel('terminal-3', null)).toBe('Terminal 3')
  })
})

describe('nextTerminalId', () =>
{
  it('allocates term-1 when no terminals are listed yet', () =>
  {
    expect(nextTerminalId([])).toBe(DEFAULT_TERMINAL_ID)
    expect(nextTerminalId([])).toBe('term-1')
  })

  it('allocates term-2 when only term-1 exists', () =>
  {
    expect(nextTerminalId([DEFAULT_TERMINAL_ID])).toBe('term-2')
  })

  it('skips over taken term-N slots', () =>
  {
    expect(nextTerminalId([DEFAULT_TERMINAL_ID, 'term-2', 'term-3'])).toBe('term-4')
    expect(nextTerminalId([DEFAULT_TERMINAL_ID, 'term-3'])).toBe('term-2')
    expect(nextTerminalId(['term-2', 'term-3'])).toBe('term-1')
  })

  it('ignores blank/whitespace-only ids', () =>
  {
    expect(nextTerminalId(['', '  ', DEFAULT_TERMINAL_ID])).toBe('term-2')
    expect(nextTerminalId(['', '  '])).toBe('term-1')
  })
})
