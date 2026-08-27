// apps/web/src/lib/shortcutModifierState.ts
// manage shortcut modifier state

import { useEffect, useState } from 'react'

export interface ShortcutModifierState
{
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

const EMPTY_SHORTCUT_MODIFIER_STATE: ShortcutModifierState = {
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
}

export function areShortcutModifierStatesEqual(
  left: ShortcutModifierState,
  right: ShortcutModifierState,
): boolean
{
  return (
    left.metaKey === right.metaKey &&
    left.ctrlKey === right.ctrlKey &&
    left.altKey === right.altKey &&
    left.shiftKey === right.shiftKey
  )
}

export function useShortcutModifierState(): ShortcutModifierState
{
  const [state, setState] = useState(EMPTY_SHORTCUT_MODIFIER_STATE)

  useEffect(() =>
  {
    const onKeyboardEvent = (event: KeyboardEvent) =>
    {
      setState((current) => shortcutModifierStateAfterKeyboardEvent(current, event))
    }
    // dictation paste can omit the modifier keyup, so it cannot retain jump intent
    const onResetEvent = () =>
    {
      setState((current) =>
        areShortcutModifierStatesEqual(current, EMPTY_SHORTCUT_MODIFIER_STATE)
          ? current
          : EMPTY_SHORTCUT_MODIFIER_STATE,
      )
    }

    window.addEventListener('keydown', onKeyboardEvent, true)
    window.addEventListener('keyup', onKeyboardEvent, true)
    window.addEventListener('paste', onResetEvent, true)
    window.addEventListener('blur', onResetEvent)
    return () =>
    {
      window.removeEventListener('keydown', onKeyboardEvent, true)
      window.removeEventListener('keyup', onKeyboardEvent, true)
      window.removeEventListener('paste', onResetEvent, true)
      window.removeEventListener('blur', onResetEvent)
    }
  }, [])

  return state
}

function normalizeModifierKey(key: string): keyof ShortcutModifierState | null
{
  switch (key)
  {
    case 'Meta':
    case 'OS':
    case 'Command':
      return 'metaKey'
    case 'Control':
      return 'ctrlKey'
    case 'Alt':
    case 'Option':
      return 'altKey'
    case 'Shift':
      return 'shiftKey'
    default:
      return null
  }
}

export function shortcutModifierStateAfterKeyboardEvent(
  currentState: ShortcutModifierState,
  event: KeyboardEvent,
): ShortcutModifierState
{
  const normalizedModifierKey = normalizeModifierKey(event.key)
  let nextState: ShortcutModifierState
  if (normalizedModifierKey)
  {
    nextState = {
      ...currentState,
      [normalizedModifierKey]: event.type === 'keydown',
    }
  }
  else
  {
    // stale flags after a synthetic paste may clear modifiers, but cannot set them
    nextState = {
      metaKey: currentState.metaKey && event.metaKey,
      ctrlKey: currentState.ctrlKey && event.ctrlKey,
      altKey: currentState.altKey && event.altKey,
      shiftKey: currentState.shiftKey && event.shiftKey,
    }
  }

  return areShortcutModifierStatesEqual(currentState, nextState) ? currentState : nextState
}
