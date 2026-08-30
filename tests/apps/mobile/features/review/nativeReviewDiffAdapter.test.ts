// tests/apps/mobile/features/review/nativeReviewDiffAdapter.test.ts
// verify get cached native review diff data behavior

import { describe, expect, it } from 'vite-plus/test'

import {
  createNativeReviewDiffTheme,
  getCachedNativeReviewDiffData,
  type BuildNativeReviewDiffDataInput,
} from '../../../../../apps/mobile/src/features/review/nativeReviewDiffAdapter'
import type { ReviewInlineComment } from '../../../../../apps/mobile/src/features/review/reviewCommentSelection'
import { buildReviewParsedDiff } from '../../../../../apps/mobile/src/features/review/reviewModel'
import { getDefaultMobileThemeVariables } from '../../../../../apps/mobile/src/lib/mobileThemeVariables'

const parsedDiff = buildReviewParsedDiff(
  [
    'diff --git a/example.ts b/example.ts',
    '--- a/example.ts',
    '+++ b/example.ts',
    '@@ -1 +1 @@',
    '-const before = 1;',
    '+const after = 2;',
  ].join('\n'),
  'native-review-cache-test',
)

function makeComment(text: string): ReviewInlineComment
{
  return {
    id: 'comment-1',
    sectionId: 'git:working-tree',
    sectionTitle: 'Dirty worktree',
    filePath: 'example.ts',
    startIndex: 0,
    endIndex: 0,
    rangeLabel: '-1',
    text,
    diff: '@@ -1,1 +1,0 @@\n-const before = 1;',
  }
}

function buildInput(comments: BuildNativeReviewDiffDataInput['comments'])
{
  return { parsedDiff, comments } satisfies BuildNativeReviewDiffDataInput
}

describe('getCachedNativeReviewDiffData', () =>
{
  it('reuses the row model for equivalent empty comment arrays', () =>
  {
    const first = getCachedNativeReviewDiffData(buildInput([]))
    const second = getCachedNativeReviewDiffData(buildInput([]))

    expect(second).toBe(first)
  })

  it('reuses equivalent comment contents and invalidates changed comments', () =>
  {
    const first = getCachedNativeReviewDiffData(buildInput([makeComment('First')]))
    const equivalent = getCachedNativeReviewDiffData(buildInput([makeComment('First')]))
    const changed = getCachedNativeReviewDiffData(buildInput([makeComment('Changed')]))

    expect(equivalent).toBe(first)
    expect(changed).not.toBe(first)
  })
})

describe('createNativeReviewDiffTheme', () =>
{
  it('uses the compiled default semantic palette for native code surfaces', () =>
  {
    for (const appearance of ['light', 'dark'] as const)
    {
      const variables = getDefaultMobileThemeVariables(appearance)
      const theme = createNativeReviewDiffTheme(appearance, variables)

      expect(theme.background).toMatch(/^#[\da-f]{6}$/iu)
      expect(theme.text).toBe(variables['--color-md-code-text'])
      expect(theme.mutedText).toMatch(/^#[\da-f]{6}$/iu)
      expect(theme.border).toMatch(/^#[\da-f]{6}$/iu)
      expect(theme.headerBackground).toBe(theme.background)
    }
  })
})
