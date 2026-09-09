// tests/apps/mobile/features/review/useReviewDiffPrewarming.test.ts
// verify bounded review diff prewarming

import { afterEach, assert, it } from 'vite-plus/test'

import { appAtomRegistry } from '../../../../../apps/mobile/src/state/atom-registry'
import type { ReviewSectionItem } from '../../../../../apps/mobile/src/features/review/reviewModel'
import { MAX_CACHED_REVIEW_SOURCE_CHARACTERS } from '../../../../../apps/mobile/src/features/review/reviewState'
import { getReviewDiffPrewarmSections } from '../../../../../apps/mobile/src/features/review/useReviewDiffPrewarming'

const threadKey = 'env:thread-prewarm'
const reviewDiff = [
  'diff --git a/src/a.ts b/src/a.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/a.ts',
  '@@ -0,0 +1 @@',
  '+export const value = 1;',
].join('\n')

function makeSection(index: number, diff: string | null = reviewDiff): ReviewSectionItem
{
  return {
    id: `turn:${index}`,
    kind: 'turn',
    title: `Turn ${index}`,
    subtitle: null,
    isLoading: false,
    diff,
  }
}

afterEach(() =>
{
  appAtomRegistry.reset()
})

it('warms the nearest review sections within the retained entry budget', () =>
{
  const sections = Array.from({ length: 12 }, (_, index) => makeSection(index))

  const pending = getReviewDiffPrewarmSections({
    threadKey,
    sections,
    selectedSectionId: 'turn:5',
  })

  assert.deepStrictEqual(
    pending.map((section) => section.id),
    ['turn:4', 'turn:6', 'turn:3', 'turn:7', 'turn:2', 'turn:8', 'turn:1'],
  )
})

it('reserves the selected source budget and skips unloaded or oversized sections', () =>
{
  const halfBudget = 'x'.repeat(2 * 1024 * 1024)
  const sections = [
    makeSection(0),
    makeSection(1, halfBudget),
    makeSection(2, 'x'.repeat(MAX_CACHED_REVIEW_SOURCE_CHARACTERS + 1)),
    makeSection(3, halfBudget),
    makeSection(4, null),
    makeSection(5),
  ]

  const pending = getReviewDiffPrewarmSections({
    threadKey,
    sections,
    selectedSectionId: 'turn:3',
  })

  assert.deepStrictEqual(
    pending.map((section) => section.id),
    ['turn:1'],
  )
})
