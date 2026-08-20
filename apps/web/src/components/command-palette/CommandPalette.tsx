// apps/web/src/components/command-palette/CommandPalette.tsx
// provides keyboard-driven navigation and project actions

'use client'

import { useAtomValue } from '@effect/atom-react'
import { useParams } from '@tanstack/react-router'
import { useCallback, useEffect, useReducer, useRef, type ReactNode } from 'react'

import { onOpenCommandPalette } from '../../commandPaletteBus'
import { isTerminalFocused } from '../../lib/terminalFocus'
import { selectThreadTerminalUiState, useTerminalUiStateStore } from '../../terminalUiStateStore'
import { resolveThreadRouteTarget } from '../../threadRoutes'
import { ComposerHandleContext } from '../chat/composer/composerHandleContext'
import type { ChatComposerHandle } from '../chat/composer/ChatComposer'
import { primaryServerKeybindingsAtom } from '../../state/server'
import { resolveShortcutCommand } from '../../keybindings'
import { CommandDialog } from '../ui/command'
import { CommandPaletteDialog } from './OpenCommandPaletteDialog'
import { reduceCommandPaletteUiState } from './uiState'

export function CommandPalette({ children }: { children: ReactNode })
{
  const [state, dispatch] = useReducer(reduceCommandPaletteUiState, {
    open: false,
    openGeneration: 0,
    openIntent: null,
  })
  const setOpen = useCallback((open: boolean) => dispatch({ _tag: 'SetOpen', open }), [])
  const toggleOpen = useCallback(() => dispatch({ _tag: 'Toggle' }), [])
  const openAddProject = useCallback(() => dispatch({ _tag: 'OpenAddProject' }), [])
  const openNewThreadIn = useCallback(() => dispatch({ _tag: 'OpenNewThreadIn' }), [])
  const clearOpenIntent = useCallback(() => dispatch({ _tag: 'ClearOpenIntent' }), [])
  const keybindings = useAtomValue(primaryServerKeybindingsAtom)
  const composerHandleRef = useRef<ChatComposerHandle | null>(null)
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  })
  const routeThreadRef = routeTarget?.kind === 'server' ? routeTarget.threadRef : null
  const terminalOpen = useTerminalUiStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  )

  useEffect(() =>
  {
    const onKeyDown = (event: globalThis.KeyboardEvent) =>
    {
      if (event.defaultPrevented) return
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
        },
      })
      if (command !== 'commandPalette.toggle')
      {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      toggleOpen()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [keybindings, terminalOpen, toggleOpen])

  useEffect(
    () =>
      onOpenCommandPalette((detail) =>
      {
        if (detail.open === 'new-thread-in')
        {
          openNewThreadIn()
        }
        else if (detail.open === 'add-project')
        {
          openAddProject()
        }
        else
        {
          setOpen(true)
        }
      }),
    [openAddProject, openNewThreadIn, setOpen],
  )

  return (
    <ComposerHandleContext value={composerHandleRef}>
      <CommandDialog open={state.open} onOpenChange={setOpen}>
        {children}
        <CommandPaletteDialog
          key={state.openGeneration}
          openIntent={state.openIntent}
          setOpen={setOpen}
          clearOpenIntent={clearOpenIntent}
        />
      </CommandDialog>
    </ComposerHandleContext>
  )
}
