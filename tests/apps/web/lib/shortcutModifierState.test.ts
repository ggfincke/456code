// tests/apps/web/lib/shortcutModifierState.test.ts
// verify shortcut modifier state behavior

// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vite-plus/test'

import {
  shortcutModifierStateAfterKeyboardEvent,
  useShortcutModifierState,
  type ShortcutModifierState,
} from '../../../../apps/web/src/lib/shortcutModifierState'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const emptyState = (): ShortcutModifierState => ({
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
})

function keyboardEventLike(type: 'keydown' | 'keyup', init: Partial<KeyboardEvent>): KeyboardEvent
{
  return {
    type,
    key: '',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...init,
  } as KeyboardEvent
}

describe('shortcutModifierState', () =>
{
  it('clears dictation paste state and requires a new modifier keydown to restore it', async () =>
  {
    function Probe()
    {
      return createElement('output', null, JSON.stringify(useShortcutModifierState()))
    }
    const container = document.createElement('div')
    const root = createRoot(container)
    try
    {
      await act(async () => root.render(createElement(Probe)))
      await act(async () =>
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', metaKey: true })),
      )
      expect(JSON.parse(container.textContent ?? '{}').metaKey).toBe(true)
      await act(async () => window.dispatchEvent(new Event('paste')))
      expect(JSON.parse(container.textContent ?? '{}')).toEqual(emptyState())
      await act(async () =>
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true })),
      )
      expect(JSON.parse(container.textContent ?? '{}')).toEqual(emptyState())
      await act(async () =>
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', metaKey: true })),
      )
      expect(JSON.parse(container.textContent ?? '{}').metaKey).toBe(true)
    }
    finally
    {
      await act(async () => root.unmount())
    }
  })

  it('preserves the current object when modifier values do not change', () =>
  {
    const initialState = emptyState()
    const nextState = shortcutModifierStateAfterKeyboardEvent(
      initialState,
      keyboardEventLike('keyup', { key: 'Shift' }),
    )
    expect(nextState).toBe(initialState)
  })

  it('tracks bare modifier keydown and keyup events explicitly', () =>
  {
    let state = emptyState()
    state = shortcutModifierStateAfterKeyboardEvent(
      state,
      keyboardEventLike('keydown', {
        key: 'Meta',
        metaKey: false,
      }),
    )
    expect(state).toEqual({
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    })

    state = shortcutModifierStateAfterKeyboardEvent(
      state,
      keyboardEventLike('keydown', {
        key: 'Shift',
        metaKey: true,
        shiftKey: false,
      }),
    )
    expect(state).toEqual({
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
    })

    state = shortcutModifierStateAfterKeyboardEvent(
      state,
      keyboardEventLike('keyup', {
        key: 'Meta',
        metaKey: true,
        shiftKey: true,
      }),
    )
    expect(state).toEqual({
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
    })

    state = shortcutModifierStateAfterKeyboardEvent(
      state,
      keyboardEventLike('keyup', {
        key: 'Shift',
        shiftKey: true,
      }),
    )
    expect(state).toEqual({
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    })
  })

  it('lets non-modifier flags clear held state without restoring poisoned paste flags', () =>
  {
    const heldMeta = { ...emptyState(), metaKey: true }
    const released = shortcutModifierStateAfterKeyboardEvent(
      heldMeta,
      keyboardEventLike('keydown', { key: 'a', metaKey: false }),
    )
    expect(released).toEqual(emptyState())
    expect(
      shortcutModifierStateAfterKeyboardEvent(
        released,
        keyboardEventLike('keydown', { key: 'Enter', metaKey: true, ctrlKey: true }),
      ),
    ).toBe(released)
  })
})
