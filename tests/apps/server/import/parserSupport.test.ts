// tests/apps/server/import/parserSupport.test.ts
// verifies provider-independent session parser support helpers

import { describe, expect, it } from '@effect/vitest'

import {
  addWarning,
  appendParsingWarningActivity,
  applyStrictlyIncreasingTimestamps,
  iterateJsonlPhysicalLines,
  JsonlParseLimitError,
  materializeWarnings,
  type WarningState,
} from '../../../../apps/server/src/import/parserSupport.ts'
import type { ImportedRecord } from '../../../../apps/server/src/import/types.ts'

function pushImportedRecord(records: ImportedRecord[], record: ImportedRecord): void
{
  records.push(record)
}

describe('applyStrictlyIncreasingTimestamps', () =>
{
  it('clamps duplicate maximum Date timestamps without throwing', () =>
  {
    const maximumDate = '+275760-09-13T00:00:00.000Z'
    const records: ImportedRecord[] = [
      {
        kind: 'message',
        role: 'user',
        text: 'At the limit',
        createdAt: maximumDate,
        sourceIndex: 0,
      },
      {
        kind: 'message',
        role: 'assistant',
        text: 'Still at the limit',
        createdAt: maximumDate,
        sourceIndex: 1,
      },
    ]

    expect(() => applyStrictlyIncreasingTimestamps(records)).not.toThrow()
    expect(records.map((record) => record.createdAt)).toEqual([maximumDate, maximumDate])
  })
})

describe('iterateJsonlPhysicalLines', () =>
{
  it('rejects JSONL beyond the hard physical-line cap', () =>
  {
    const drain = () =>
    {
      for (const _line of iterateJsonlPhysicalLines(`${'{}\n'.repeat(100_000)}{}`, 100_000))
      {
        // drain until the shared physical-line cap throws
      }
    }

    expect(drain).toThrow(JsonlParseLimitError)
    expect(drain).toThrow(/physical-line limit exceeded/)
  })
})

describe('materializeWarnings', () =>
{
  it('caps warning detail and reports how many warnings were omitted', () =>
  {
    const state: WarningState = { details: [], omittedCount: 0, totalCount: 0 }
    for (let index = 0; index < 105; index += 1)
    {
      addWarning(state, `line ${index + 1}: malformed JSON skipped`)
    }

    const warnings = materializeWarnings(state)
    expect(warnings).toHaveLength(101)
    expect(warnings.at(-1)).toBe('5 additional parsing warnings omitted after the first 100')
    expect(state.totalCount).toBe(105)
    expect(state.omittedCount).toBe(5)
  })
})

describe('appendParsingWarningActivity', () =>
{
  it('surfaces a malformed tail inside the normalized transcript', () =>
  {
    const records: ImportedRecord[] = [
      {
        kind: 'message',
        role: 'user',
        text: 'Keep this',
        createdAt: '2026-01-01T00:00:00.000Z',
        sourceIndex: 0,
      },
    ]
    const warnings: WarningState = { details: [], omittedCount: 0, totalCount: 0 }
    addWarning(warnings, 'line 2: malformed JSON skipped')

    appendParsingWarningActivity(records, warnings, 1, pushImportedRecord)

    expect(records.at(-1)).toMatchObject({
      kind: 'activity',
      tone: 'error',
      activityKind: 'task.completed',
      payload: {
        importWarningCount: 1,
        omittedWarningCount: 0,
        detail: 'line 2: malformed JSON skipped',
      },
    })
  })
})
