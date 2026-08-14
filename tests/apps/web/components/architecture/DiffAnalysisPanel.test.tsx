// tests/apps/web/components/architecture/DiffAnalysisPanel.test.tsx
// verifies native diff analysis failure and first-use state classification

import { CartographerError, type DiffAnalysisGeneration } from '@t3tools/contracts'
import { describe, expect, it } from 'vite-plus/test'

import {
  analysisError,
  DIFF_ANALYSIS_SERVER_RESTARTED_MESSAGE,
  diffAnalysisQueryStreamError,
  isDiffAnalysisUnavailableFailure,
} from '../../../../../apps/web/src/components/architecture/DiffAnalysisPanel'

describe('DiffAnalysisPanel', () =>
{
  it('presents the exact server-restarted retry copy', () =>
  {
    expect(
      analysisError({
        state: 'abandoned',
        errorCode: 'server-restarted',
      } as DiffAnalysisGeneration),
    ).toBe(DIFF_ANALYSIS_SERVER_RESTARTED_MESSAGE)
  })

  it('treats only a first-use missing analysis as an idle query result', () =>
  {
    const missing = new CartographerError({
      failure: 'diff_analysis_not_found',
      message: 'A ready diff analysis was not found for this owner.',
    })
    expect(isDiffAnalysisUnavailableFailure(missing)).toBe(true)
    expect(diffAnalysisQueryStreamError(missing.message, missing, false)).toBeNull()
    expect(diffAnalysisQueryStreamError(missing.message, missing, true)).toBe(missing.message)

    const failure = new CartographerError({
      failure: 'context_start_failed',
      message: 'Architecture analysis could not start.',
    })
    expect(isDiffAnalysisUnavailableFailure(failure)).toBe(false)
    expect(diffAnalysisQueryStreamError(failure.message, failure, false)).toBe(failure.message)
  })
})
