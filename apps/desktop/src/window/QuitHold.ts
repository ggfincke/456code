// apps/desktop/src/window/QuitHold.ts
// handles hold-to-quit keyboard gestures

// @effect-diagnostics globalDate:off globalTimers:off -- synchronous Electron input timing

export const QUIT_HOLD_DURATION_MS = 1_200
export const QUIT_DOUBLE_TAP_MS = 500
export const QUIT_HOLD_RELEASE_GRACE_MS = 600

export type QuitHoldState = 'down' | 'up'

export interface QuitHoldKeyInput
{
  readonly type: string
  readonly key: string
  readonly meta: boolean
  readonly control: boolean
  readonly alt: boolean
  readonly shift: boolean
  readonly isAutoRepeat: boolean
}

export interface QuitHoldOptions
{
  readonly platform: NodeJS.Platform
  readonly enabled: boolean
  readonly notify: (state: QuitHoldState) => void
  readonly quit: () => void
}

export function defaultQuitHoldEnabled(platform: NodeJS.Platform): boolean
{
  return platform !== 'win32'
}

// auto-repeat proves the shortcut is still held when macOS suppresses keyUp
export function makeQuitHoldHandler(
  options: QuitHoldOptions,
): (event: { preventDefault: () => void }, input: QuitHoldKeyInput) => void
{
  const modifierKey = options.platform === 'darwin' ? 'meta' : 'control'
  let watchdog: NodeJS.Timeout | undefined
  let holding = false
  let quitOnRelease = false
  let heldSince = 0
  let lastPressAt = 0

  const clearWatchdog = () =>
  {
    if (watchdog === undefined) return
    clearTimeout(watchdog)
    watchdog = undefined
  }

  const release = () =>
  {
    if (!holding) return
    holding = false
    quitOnRelease = false
    clearWatchdog()
    options.notify('up')
  }

  const quitNow = () =>
  {
    release()
    options.quit()
  }

  return (event, input) =>
  {
    const key = input.key.toLowerCase()
    if (input.type === 'keyUp')
    {
      if (key === 'q')
      {
        const shouldQuit = quitOnRelease
        release()
        if (shouldQuit) options.quit()
      }
      else if (key === modifierKey)
      {
        if (!quitOnRelease)
        {
          release()
        }
        else
        {
          watchdog = setTimeout(quitNow, QUIT_HOLD_RELEASE_GRACE_MS)
        }
      }
      return
    }
    if (input.type !== 'keyDown') return

    if (quitOnRelease && input.isAutoRepeat && key === 'q')
    {
      event.preventDefault()
      clearWatchdog()
      return
    }

    const exactModifier =
      options.platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta
    if (!exactModifier || input.alt || input.shift || key !== 'q')
    {
      if (holding && !input.isAutoRepeat)
      {
        lastPressAt = 0
        release()
      }
      return
    }

    event.preventDefault()
    if (!options.enabled)
    {
      if (!input.isAutoRepeat) options.quit()
      return
    }

    if (input.isAutoRepeat)
    {
      if (holding && Date.now() - heldSince >= QUIT_HOLD_DURATION_MS)
      {
        quitOnRelease = true
        clearWatchdog()
      }
      return
    }

    const now = Date.now()
    const previousPressAt = lastPressAt
    lastPressAt = now
    if (previousPressAt !== 0 && now - previousPressAt <= QUIT_DOUBLE_TAP_MS)
    {
      quitNow()
      return
    }
    if (holding) release()

    holding = true
    heldSince = now
    options.notify('down')
    watchdog = setTimeout(() =>
    {
      watchdog = undefined
      release()
    }, QUIT_HOLD_DURATION_MS + QUIT_HOLD_RELEASE_GRACE_MS)
  }
}
