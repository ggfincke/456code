// tests/apps/web/components/chat/composerMenuHighlight.test.ts
// verify resolve composer menu active item id behavior

import { describe, expect, it } from 'vite-plus/test'

import { resolveComposerMenuActiveItemId } from '../../../../../apps/web/src/components/chat/composerMenuHighlight'

describe('resolveComposerMenuActiveItemId', () =>
{
  const items = [{ id: 'top' }, { id: 'second' }, { id: 'third' }] as const

  it('defaults to the first item when nothing is highlighted', () =>
  {
    expect(
      resolveComposerMenuActiveItemId({
        items,
        highlightedItemId: null,
        currentSearchKey: 'skill:u',
        highlightedSearchKey: null,
      }),
    ).toBe('top')
  })

  it('preserves the highlighted item within the same query', () =>
  {
    expect(
      resolveComposerMenuActiveItemId({
        items,
        highlightedItemId: 'second',
        currentSearchKey: 'skill:u',
        highlightedSearchKey: 'skill:u',
      }),
    ).toBe('second')
  })

  it('resets to the top result when the query changes', () =>
  {
    expect(
      resolveComposerMenuActiveItemId({
        items,
        highlightedItemId: 'second',
        currentSearchKey: 'skill:ui',
        highlightedSearchKey: 'skill:u',
      }),
    ).toBe('top')
  })

  it('falls back to the first item when the highlighted item disappears', () =>
  {
    expect(
      resolveComposerMenuActiveItemId({
        items,
        highlightedItemId: 'missing',
        currentSearchKey: 'skill:ui',
        highlightedSearchKey: 'skill:ui',
      }),
    ).toBe('top')
  })
})
