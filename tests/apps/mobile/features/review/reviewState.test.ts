// tests/apps/mobile/features/review/reviewState.test.ts
// verify review state behavior

import { afterEach, assert, it } from 'vite-plus/test'

import { appAtomRegistry } from '../../../../../apps/mobile/src/state/atom-registry'
import {
  getReviewAsyncStateSnapshot,
  getCachedReviewParsedDiff,
  setReviewAsyncError,
  setReviewTurnDiffLoading,
} from '../../../../../apps/mobile/src/features/review/reviewState'

const reviewInput = {
  threadKey: 'env-local:thread-review',
  sectionId: 'turn:1',
  diff: [
    'diff --git a/src/a.ts b/src/a.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/src/a.ts',
    '@@ -0,0 +1 @@',
    '+export const value = 1;',
  ].join('\n'),
}

afterEach(() =>
{
  appAtomRegistry.reset()
})

it('stores review async loading and error state in atoms', () =>
{
  const threadKey = `env-local:thread-review-state-${Date.now()}`

  setReviewTurnDiffLoading(threadKey, 'turn-1', true)
  setReviewAsyncError(threadKey, 'load failed')

  assert.deepStrictEqual(getReviewAsyncStateSnapshot(threadKey), {
    loadingTurnIds: { 'turn-1': true },
    error: 'load failed',
  })

  setReviewTurnDiffLoading(threadKey, 'turn-1', false)
  setReviewAsyncError(threadKey, null)

  assert.deepStrictEqual(getReviewAsyncStateSnapshot(threadKey), {
    loadingTurnIds: {},
    error: null,
  })
})

it('evicts the least recently used parsed review without changing rebuilt contents', () =>
{
  const oldestInput = { ...reviewInput, threadKey: 'env-local:thread-oldest' }
  const oldest = getCachedReviewParsedDiff(oldestInput)
  for (let index = 0; index < 8; index += 1)
  {
    getCachedReviewParsedDiff({ ...reviewInput, threadKey: `env-local:thread-${index}` })
  }

  const rebuilt = getCachedReviewParsedDiff(oldestInput)

  assert.notStrictEqual(rebuilt, oldest)
  assert.deepStrictEqual(rebuilt, oldest)
})

it('limits cached parsed reviews by their full source character budget', () =>
{
  const firstInput = { ...reviewInput, diff: 'x'.repeat(2 * 1024 * 1024) }
  const secondInput = { ...firstInput, sectionId: 'turn:2' }
  const first = getCachedReviewParsedDiff(firstInput)
  const second = getCachedReviewParsedDiff(secondInput)

  getCachedReviewParsedDiff({ ...firstInput, sectionId: 'turn:3' })

  assert.strictEqual(getCachedReviewParsedDiff(secondInput), second)
  assert.notStrictEqual(getCachedReviewParsedDiff(firstInput), first)
})
