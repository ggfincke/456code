// tests/apps/desktop/window/QuitHold.test.ts
// verifies desktop hold-to-quit gesture behavior

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import {
  QUIT_DOUBLE_TAP_MS,
  QUIT_HOLD_DURATION_MS,
  QUIT_HOLD_RELEASE_GRACE_MS,
  defaultQuitHoldEnabled,
  makeQuitHoldHandler,
  type QuitHoldKeyInput,
  type QuitHoldState,
} from '../../../../apps/desktop/src/window/QuitHold.ts'

function makeInput(overrides: Partial<QuitHoldKeyInput> = {}): QuitHoldKeyInput
{
  return {
    type: 'keyDown',
    key: 'q',
    meta: true,
    control: false,
    alt: false,
    shift: false,
    isAutoRepeat: false,
    ...overrides,
  }
}

function makeHarness(
  input: { readonly enabled?: boolean; readonly platform?: NodeJS.Platform } = {},
)
{
  const notifications: QuitHoldState[] = []
  const quit = vi.fn()
  const handler = makeQuitHoldHandler({
    platform: input.platform ?? 'darwin',
    enabled: input.enabled ?? true,
    notify: (state) => notifications.push(state),
    quit,
  })
  const preventDefault = vi.fn()
  const send = (keyInput: QuitHoldKeyInput) => handler({ preventDefault }, keyInput)
  const holdFor = (durationMs: number, overrides: Partial<QuitHoldKeyInput> = {}) =>
  {
    for (let elapsed = 0; elapsed < durationMs; elapsed += 100)
    {
      vi.advanceTimersByTime(100)
      send(makeInput({ isAutoRepeat: true, ...overrides }))
    }
  }
  return { notifications, quit, preventDefault, send, holdFor }
}

describe('makeQuitHoldHandler', () =>
{
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('uses the approved platform defaults', () =>
  {
    expect(defaultQuitHoldEnabled('darwin')).toBe(true)
    expect(defaultQuitHoldEnabled('win32')).toBe(false)
    expect(defaultQuitHoldEnabled('linux')).toBe(true)
  })

  it('does not quit a macOS tap even when keyUp is suppressed', () =>
  {
    const harness = makeHarness()
    harness.send(makeInput())

    expect(harness.preventDefault).toHaveBeenCalledOnce()
    expect(harness.notifications).toEqual(['down'])
    vi.advanceTimersByTime(QUIT_HOLD_DURATION_MS + QUIT_HOLD_RELEASE_GRACE_MS)
    expect(harness.quit).not.toHaveBeenCalled()
    expect(harness.notifications).toEqual(['down', 'up'])
  })

  it('quits once after a full hold or a quick double tap', () =>
  {
    const held = makeHarness()
    held.send(makeInput())
    held.holdFor(QUIT_HOLD_DURATION_MS + 200)
    held.holdFor(300)
    expect(held.quit).toHaveBeenCalledOnce()
    expect(held.notifications).toEqual(['down', 'up'])

    const tapped = makeHarness()
    tapped.send(makeInput())
    vi.advanceTimersByTime(QUIT_DOUBLE_TAP_MS - 100)
    tapped.send(makeInput())
    expect(tapped.quit).toHaveBeenCalledOnce()
  })

  it('quits immediately without a hint when hold-to-quit is disabled', () =>
  {
    const harness = makeHarness({ enabled: false, platform: 'win32' })
    harness.send(makeInput({ meta: false, control: true }))

    expect(harness.preventDefault).toHaveBeenCalledOnce()
    expect(harness.quit).toHaveBeenCalledOnce()
    expect(harness.notifications).toEqual([])
  })

  it('only captures the exact platform quit modifier', () =>
  {
    const mac = makeHarness()
    mac.send(makeInput({ control: true }))

    const windows = makeHarness({ enabled: false, platform: 'win32' })
    windows.send(makeInput({ control: true }))

    expect(mac.preventDefault).not.toHaveBeenCalled()
    expect(mac.quit).not.toHaveBeenCalled()
    expect(windows.preventDefault).not.toHaveBeenCalled()
    expect(windows.quit).not.toHaveBeenCalled()
  })

  it('cancels a hold interrupted by another key', () =>
  {
    const harness = makeHarness()
    harness.send(makeInput())
    harness.holdFor(500)
    harness.send(makeInput({ key: 'w' }))
    harness.holdFor(QUIT_HOLD_DURATION_MS)

    expect(harness.quit).not.toHaveBeenCalled()
    expect(harness.notifications).toEqual(['down', 'up'])
  })
})
