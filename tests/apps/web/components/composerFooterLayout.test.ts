// tests/apps/web/components/composerFooterLayout.test.ts
// verify should use compact composer footer behavior

import { describe, expect, it } from 'vite-plus/test'

import {
  COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX,
  COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX,
  shouldUseCompactComposerFooter,
} from '../../../../apps/web/src/components/composerFooterLayout'

describe('shouldUseCompactComposerFooter', () =>
{
  it('stays expanded without a measured width', () =>
  {
    expect(shouldUseCompactComposerFooter(null)).toBe(false)
  })

  it('switches to compact mode below the breakpoint', () =>
  {
    expect(shouldUseCompactComposerFooter(COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX - 1)).toBe(true)
  })

  it('stays expanded at and above the breakpoint', () =>
  {
    expect(shouldUseCompactComposerFooter(COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX)).toBe(false)
    expect(shouldUseCompactComposerFooter(COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX + 48)).toBe(false)
  })

  it('uses a higher breakpoint for wide action states', () =>
  {
    expect(
      shouldUseCompactComposerFooter(COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX - 1, {
        hasWideActions: true,
      }),
    ).toBe(true)
    expect(
      shouldUseCompactComposerFooter(COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX, {
        hasWideActions: true,
      }),
    ).toBe(false)
  })
})
