// tests/apps/web/components/chat/ComposerPrimaryActions.test.ts
// verify format pending primary action label behavior

import { describe, expect, it } from 'vite-plus/test'

import { formatPendingPrimaryActionLabel } from '../../../../../apps/web/src/components/chat/ComposerPrimaryActions'

describe('formatPendingPrimaryActionLabel', () =>
{
  it("returns 'Submitting...' while responding", () =>
  {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: false,
        isResponding: true,
        questionIndex: 0,
      }),
    ).toBe('Submitting...')
  })
})
