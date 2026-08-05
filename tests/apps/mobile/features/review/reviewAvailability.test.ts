// tests/apps/mobile/features/review/reviewAvailability.test.ts
// verify resolve review availability behavior

import { describe, expect, it } from 'vite-plus/test'

import { resolveReviewAvailability } from '../../../../../apps/mobile/src/features/review/reviewAvailability'

describe('resolveReviewAvailability', () =>
{
  it.each([
    [
      'offline with other cached section',
      {
        hasEnvironmentPresentation: true,
        isEnvironmentConnected: false,
        hasCachedSelectedDiff: false,
        hasAnyCachedDiff: true,
      },
      { showConnectionNotice: true, showSectionToolbar: true },
    ],
    [
      'offline with no cached sections',
      {
        hasEnvironmentPresentation: true,
        isEnvironmentConnected: false,
        hasCachedSelectedDiff: false,
        hasAnyCachedDiff: false,
      },
      { showConnectionNotice: true, showSectionToolbar: false },
    ],
    [
      'offline with cached selected content',
      {
        hasEnvironmentPresentation: true,
        isEnvironmentConnected: false,
        hasCachedSelectedDiff: true,
        hasAnyCachedDiff: true,
      },
      { showConnectionNotice: false, showSectionToolbar: true },
    ],
  ])('%s', (_label, input, expected) =>
  {
    expect(resolveReviewAvailability(input)).toEqual(expected)
  })
})
