// apps/web/src/lib/terminalFocus.ts
// resolve terminal focus owner

export type TerminalFocusOwner = 'drawer' | 'right-panel'

export function getTerminalFocusOwner(): TerminalFocusOwner | null
{
  const activeElement = document.activeElement
  if (!(activeElement instanceof HTMLElement)) return null
  if (!activeElement.isConnected) return null
  const owner = activeElement.closest<HTMLElement>('[data-terminal-owner]')?.dataset.terminalOwner
  if (owner === 'drawer' || owner === 'right-panel') return owner
  return null
}

export function isTerminalFocused(): boolean
{
  return getTerminalFocusOwner() !== null
}

// focus never bubbles, so capture-phase listeners are the only way to observe
// focus entering or leaving the terminal surface from a window-level store.
export function subscribeToTerminalFocusChanges(listener: () => void): () => void
{
  window.addEventListener('focusin', listener, true)
  window.addEventListener('focusout', listener, true)
  return () =>
  {
    window.removeEventListener('focusin', listener, true)
    window.removeEventListener('focusout', listener, true)
  }
}
