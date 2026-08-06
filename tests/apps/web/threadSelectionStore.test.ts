// tests/apps/web/threadSelectionStore.test.ts
// verify thread selection store behavior

import { ThreadId } from '@t3tools/contracts'
import { beforeEach, describe, expect, it } from 'vite-plus/test'

import { useThreadSelectionStore } from '../../../apps/web/src/threadSelectionStore'

const THREAD_A = ThreadId.make('thread-a')
const THREAD_B = ThreadId.make('thread-b')
const THREAD_C = ThreadId.make('thread-c')
const THREAD_D = ThreadId.make('thread-d')
const THREAD_E = ThreadId.make('thread-e')

const ORDERED = [THREAD_A, THREAD_B, THREAD_C, THREAD_D, THREAD_E] as const

describe('threadSelectionStore', () =>
{
  beforeEach(() =>
  {
    useThreadSelectionStore.getState().clearSelection()
  })

  describe('toggleThread', () =>
  {
    it('adds a thread to empty selection', () =>
    {
      useThreadSelectionStore.getState().toggleThread(THREAD_A)

      const state = useThreadSelectionStore.getState()
      expect(state.selectedThreadKeys.has(THREAD_A)).toBe(true)
      expect(state.selectedThreadKeys.size).toBe(1)
      expect(state.anchorThreadKey).toBe(THREAD_A)
      expect(state.hasSelection()).toBe(true)
    })

    it('removes a thread that is already selected', () =>
    {
      const store = useThreadSelectionStore.getState()
      store.toggleThread(THREAD_A)
      store.toggleThread(THREAD_A)

      const state = useThreadSelectionStore.getState()
      expect(state.selectedThreadKeys.has(THREAD_A)).toBe(false)
      expect(state.selectedThreadKeys.size).toBe(0)
    })

    it('preserves existing selections when toggling a new thread', () =>
    {
      const store = useThreadSelectionStore.getState()
      store.toggleThread(THREAD_A)
      store.toggleThread(THREAD_B)

      const state = useThreadSelectionStore.getState()
      expect(state.selectedThreadKeys.has(THREAD_A)).toBe(true)
      expect(state.selectedThreadKeys.has(THREAD_B)).toBe(true)
      expect(state.selectedThreadKeys.size).toBe(2)
    })

    it('sets anchor to the newly added thread', () =>
    {
      const store = useThreadSelectionStore.getState()
      store.toggleThread(THREAD_A)
      store.toggleThread(THREAD_B)

      expect(useThreadSelectionStore.getState().anchorThreadKey).toBe(THREAD_B)
    })

    it('preserves anchor when deselecting a non-anchor thread', () =>
    {
      const store = useThreadSelectionStore.getState()
      store.toggleThread(THREAD_A)
      store.toggleThread(THREAD_B)
      // deselect A, anchor should stay B
      store.toggleThread(THREAD_A)

      expect(useThreadSelectionStore.getState().anchorThreadKey).toBe(THREAD_B)
    })
  })

  describe('setAnchor', () =>
  {
    it('sets anchor without adding to selection', () =>
    {
      useThreadSelectionStore.getState().setAnchor(THREAD_B)

      const state = useThreadSelectionStore.getState()
      expect(state.anchorThreadKey).toBe(THREAD_B)
      expect(state.selectedThreadKeys.size).toBe(0)
    })

    it('enables range select from a plain-click anchor', () =>
    {
      const store = useThreadSelectionStore.getState()
      // simulate plain-click navigate to B
      store.setAnchor(THREAD_B)
      // shift-click D
      store.rangeSelectTo(THREAD_D, ORDERED)

      const state = useThreadSelectionStore.getState()
      expect(state.selectedThreadKeys.has(THREAD_B)).toBe(true)
      expect(state.selectedThreadKeys.has(THREAD_C)).toBe(true)
      expect(state.selectedThreadKeys.has(THREAD_D)).toBe(true)
      expect(state.selectedThreadKeys.size).toBe(3)
    })

    it.each([
      {
        label: 'setAnchor to the same thread',
        setup: () =>
        {
          useThreadSelectionStore.getState().setAnchor(THREAD_B)
        },
        act: () =>
        {
          useThreadSelectionStore.getState().setAnchor(THREAD_B)
        },
        assertSame: (
          before: ReturnType<typeof useThreadSelectionStore.getState>,
          after: ReturnType<typeof useThreadSelectionStore.getState>,
        ) =>
        {
          expect(after).toBe(before)
        },
      },
      {
        label: 'clearSelection when already empty',
        setup: () =>
        {},
        act: () =>
        {
          useThreadSelectionStore.getState().clearSelection()
        },
        assertSame: (
          before: ReturnType<typeof useThreadSelectionStore.getState>,
          after: ReturnType<typeof useThreadSelectionStore.getState>,
        ) =>
        {
          expect(after.selectedThreadKeys).toBe(before.selectedThreadKeys)
          expect(after.hasSelection()).toBe(false)
        },
      },
    ])('is a no-op for $label', ({ setup, act, assertSame }) =>
    {
      setup()
      const stateBefore = useThreadSelectionStore.getState()
      act()
      assertSame(stateBefore, useThreadSelectionStore.getState())
    })

    it('survives clearSelection followed by setAnchor', () =>
    {
      const store = useThreadSelectionStore.getState()
      store.toggleThread(THREAD_A)
      store.toggleThread(THREAD_B)
      store.clearSelection()
      store.setAnchor(THREAD_C)

      const state = useThreadSelectionStore.getState()
      expect(state.anchorThreadKey).toBe(THREAD_C)
      expect(state.selectedThreadKeys.size).toBe(0)
    })
  })

  describe('rangeSelectTo', () =>
  {
    it('selects a single thread when no anchor exists', () =>
    {
      useThreadSelectionStore.getState().rangeSelectTo(THREAD_C, ORDERED)

      const state = useThreadSelectionStore.getState()
      expect(state.selectedThreadKeys.has(THREAD_C)).toBe(true)
      expect(state.selectedThreadKeys.size).toBe(1)
      expect(state.anchorThreadKey).toBe(THREAD_C)
    })

    it.each([
      { label: 'forward', anchor: THREAD_B, target: THREAD_D },
      { label: 'backward', anchor: THREAD_D, target: THREAD_B },
    ])('selects range from anchor to target ($label)', ({ anchor, target }) =>
    {
      const store = useThreadSelectionStore.getState()
      store.toggleThread(anchor)
      store.rangeSelectTo(target, ORDERED)

      const state = useThreadSelectionStore.getState()
      expect(state.selectedThreadKeys.has(THREAD_B)).toBe(true)
      expect(state.selectedThreadKeys.has(THREAD_C)).toBe(true)
      expect(state.selectedThreadKeys.has(THREAD_D)).toBe(true)
      expect(state.selectedThreadKeys.size).toBe(3)
    })

    it('keeps anchor stable across multiple range selects', () =>
    {
      const store = useThreadSelectionStore.getState()
      // anchor = B
      store.toggleThread(THREAD_B)
      // selects B-D
      store.rangeSelectTo(THREAD_D, ORDERED)
      // extends B-E (anchor stays B)
      store.rangeSelectTo(THREAD_E, ORDERED)

      const state = useThreadSelectionStore.getState()
      expect(state.anchorThreadKey).toBe(THREAD_B)
      expect(state.selectedThreadKeys.has(THREAD_B)).toBe(true)
      expect(state.selectedThreadKeys.has(THREAD_C)).toBe(true)
      expect(state.selectedThreadKeys.has(THREAD_D)).toBe(true)
      expect(state.selectedThreadKeys.has(THREAD_E)).toBe(true)
    })

    it('falls back to toggle when anchor is not in the ordered list', () =>
    {
      const store = useThreadSelectionStore.getState()
      // anchor = A
      store.toggleThread(THREAD_A)
      // range-select with a list that does NOT contain the anchor
      store.rangeSelectTo(THREAD_C, [THREAD_B, THREAD_C, THREAD_D])

      const state = useThreadSelectionStore.getState()
      // should have added C and reset anchor to C
      expect(state.selectedThreadKeys.has(THREAD_C)).toBe(true)
      expect(state.anchorThreadKey).toBe(THREAD_C)
    })

    it('falls back to toggle when target is not in the ordered list', () =>
    {
      const store = useThreadSelectionStore.getState()
      // anchor = B
      store.toggleThread(THREAD_B)
      const unknownThread = ThreadId.make('thread-unknown')
      store.rangeSelectTo(unknownThread, ORDERED)

      const state = useThreadSelectionStore.getState()
      expect(state.selectedThreadKeys.has(unknownThread)).toBe(true)
      expect(state.anchorThreadKey).toBe(unknownThread)
    })

    it('selects the single thread when anchor equals target', () =>
    {
      const store = useThreadSelectionStore.getState()
      // anchor = C
      store.toggleThread(THREAD_C)
      // range from C to C
      store.rangeSelectTo(THREAD_C, ORDERED)

      const state = useThreadSelectionStore.getState()
      expect(state.selectedThreadKeys.has(THREAD_C)).toBe(true)
      expect(state.selectedThreadKeys.size).toBe(1)
    })

    it('preserves previously selected threads outside the range', () =>
    {
      const store = useThreadSelectionStore.getState()
      // select A, anchor = A
      store.toggleThread(THREAD_A)
      // select B, anchor = B
      store.toggleThread(THREAD_B)

      // now shift-select from B (anchor) to D — should add B, C, D but keep A
      store.rangeSelectTo(THREAD_D, ORDERED)

      const state = useThreadSelectionStore.getState()
      expect(state.selectedThreadKeys.has(THREAD_A)).toBe(true)
      expect(state.selectedThreadKeys.has(THREAD_B)).toBe(true)
      expect(state.selectedThreadKeys.has(THREAD_C)).toBe(true)
      expect(state.selectedThreadKeys.has(THREAD_D)).toBe(true)
      expect(state.selectedThreadKeys.size).toBe(4)
    })
  })

  describe('clearSelection', () =>
  {
    it('clears all selected threads and anchor', () =>
    {
      const store = useThreadSelectionStore.getState()
      store.toggleThread(THREAD_A)
      store.toggleThread(THREAD_B)
      expect(store.hasSelection()).toBe(true)
      store.clearSelection()

      const state = useThreadSelectionStore.getState()
      expect(state.selectedThreadKeys.size).toBe(0)
      expect(state.anchorThreadKey).toBeNull()
      expect(state.hasSelection()).toBe(false)
    })
  })

  describe('removeFromSelection', () =>
  {
    it('removes specified threads from selection', () =>
    {
      const store = useThreadSelectionStore.getState()
      store.toggleThread(THREAD_A)
      store.toggleThread(THREAD_B)
      store.toggleThread(THREAD_C)
      store.removeFromSelection([THREAD_A, THREAD_C])

      const state = useThreadSelectionStore.getState()
      expect(state.selectedThreadKeys.has(THREAD_B)).toBe(true)
      expect(state.selectedThreadKeys.size).toBe(1)
    })

    it('clears anchor when the anchor thread is removed', () =>
    {
      const store = useThreadSelectionStore.getState()
      store.toggleThread(THREAD_A)
      // anchor = B
      store.toggleThread(THREAD_B)
      store.removeFromSelection([THREAD_B])

      expect(useThreadSelectionStore.getState().anchorThreadKey).toBeNull()
    })

    it('preserves anchor when the anchor thread is not removed', () =>
    {
      const store = useThreadSelectionStore.getState()
      store.toggleThread(THREAD_A)
      // anchor = B
      store.toggleThread(THREAD_B)
      store.removeFromSelection([THREAD_A])

      expect(useThreadSelectionStore.getState().anchorThreadKey).toBe(THREAD_B)
    })

    it('is a no-op when none of the specified threads are selected', () =>
    {
      const store = useThreadSelectionStore.getState()
      store.toggleThread(THREAD_A)
      const stateBefore = useThreadSelectionStore.getState()
      store.removeFromSelection([THREAD_B, THREAD_C])
      const stateAfter = useThreadSelectionStore.getState()

      expect(stateAfter.selectedThreadKeys).toBe(stateBefore.selectedThreadKeys)
    })
  })
})
