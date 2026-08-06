// apps/mobile/src/features/terminal/terminalRouteHelpers.ts
// pure helpers for thread terminal route bootstrap and key modifiers

import { DEFAULT_TERMINAL_ID } from '@t3tools/contracts'
import { type KnownTerminalSession } from '@t3tools/client-runtime/state/terminal'

export const DEFAULT_TERMINAL_COLS = 80
export const DEFAULT_TERMINAL_ROWS = 24
export const TERMINAL_ACCESSORY_HEIGHT = 52
export const SHOWCASE_ENABLED = process.env.EXPO_PUBLIC_SHOWCASE === '1'

export type PendingModifier = 'ctrl' | 'meta'
export type HostPlatform = 'mac' | 'linux' | 'windows' | 'unknown'

export type TerminalToolbarAction =
  | { readonly kind: 'send'; readonly key: string; readonly label: string; readonly data: string }
  | { readonly kind: 'clear'; readonly key: string; readonly label: string }
  | {
      readonly kind: 'modifier'
      readonly key: string
      readonly label: string
      readonly modifier: PendingModifier
    }

export function firstRouteParam(value: string | string[] | undefined): string | null
{
  if (Array.isArray(value))
  {
    return value[0] ?? null
  }

  return value ?? null
}

export function inferHostPlatform(environmentLabel: string | null): HostPlatform
{
  const value = environmentLabel?.toLowerCase() ?? ''
  if (
    value.includes('mac') ||
    value.includes('macbook') ||
    value.includes('mac mini') ||
    value.includes('imac') ||
    value.includes('darwin')
  )
  {
    return 'mac'
  }
  if (value.includes('windows') || value.includes('win'))
  {
    return 'windows'
  }
  if (value.includes('linux') || value.includes('ubuntu') || value.includes('debian'))
  {
    return 'linux'
  }

  return 'unknown'
}

export function applyCtrlModifier(input: string): string
{
  const firstCharacter = input[0]
  if (!firstCharacter)
  {
    return input
  }

  const lowerCharacter = firstCharacter.toLowerCase()
  if (lowerCharacter >= 'a' && lowerCharacter <= 'z')
  {
    return String.fromCharCode(lowerCharacter.charCodeAt(0) - 96)
  }

  if (firstCharacter === '@') return '\u0000'
  if (firstCharacter === '[') return '\u001b'
  if (firstCharacter === '\\') return '\u001c'
  if (firstCharacter === ']') return '\u001d'
  if (firstCharacter === '^') return '\u001e'
  if (firstCharacter === '_') return '\u001f'
  if (firstCharacter === '?') return '\u007f'

  return input
}

export function pickRunningTerminalSessionForBootstrap(
  sessions: ReadonlyArray<KnownTerminalSession>,
): KnownTerminalSession | null
{
  const running = sessions.filter(
    (session) => session.state.status === 'running' || session.state.status === 'starting',
  )
  if (running.length === 0)
  {
    return null
  }
  return (
    running.find((session) => session.target.terminalId === DEFAULT_TERMINAL_ID) ??
    running[0] ??
    null
  )
}
