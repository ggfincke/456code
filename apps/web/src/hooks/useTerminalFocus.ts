// apps/web/src/hooks/useTerminalFocus.ts
// track terminal focus through a React hook

import { useSyncExternalStore } from 'react'

import { isTerminalFocused, subscribeToTerminalFocusChanges } from '../lib/terminalFocus'

export function useTerminalFocus(): boolean
{
  return useSyncExternalStore(subscribeToTerminalFocusChanges, isTerminalFocused, () => false)
}
