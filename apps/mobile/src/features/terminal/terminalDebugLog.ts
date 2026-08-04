/**
 * Debug logging for the mobile terminal pipeline. Prefix: `[code456-terminal]`.
 *
 * Enabled when `__DEV__` is true, or set `globalThis.__CODE456_TERMINAL_DEBUG__ = true` in a JS
 * debugger / Metro console to trace release/TestFlight builds.
 */
export function isTerminalDebugEnabled(): boolean
{
  return (
    (typeof __DEV__ !== 'undefined' && __DEV__) ||
    (typeof globalThis !== 'undefined' &&
      (globalThis as { __CODE456_TERMINAL_DEBUG__?: boolean }).__CODE456_TERMINAL_DEBUG__ === true)
  )
}

export function terminalDebugLog(message: string, data?: Record<string, unknown>): void
{
  if (!isTerminalDebugEnabled())
  {
    return
  }
  if (data !== undefined)
  {
    console.log(`[code456-terminal] ${message}`, data)
  }
  else
  {
    console.log(`[code456-terminal] ${message}`)
  }
}
