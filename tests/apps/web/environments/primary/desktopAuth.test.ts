// tests/apps/web/environments/primary/desktopAuth.test.ts
// verify desktop primary auth behavior

import type { DesktopBridge } from '@t3tools/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from '@effect/vitest'

import {
  __resetDesktopPrimaryAuthForTests,
  readDesktopPrimaryBearerToken,
} from '../../../../../apps/web/src/environments/primary/desktopAuth'

describe('desktop primary auth', () =>
{
  beforeEach(() =>
  {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    })
  })

  afterEach(() =>
  {
    __resetDesktopPrimaryAuthForTests()
    Reflect.deleteProperty(globalThis, 'window')
  })

  it('shares one in-flight main-process bearer fetch across concurrent requests', async () =>
  {
    const getLocalEnvironmentBearerToken = vi.fn().mockResolvedValue('desktop-bearer-token')
    window.desktopBridge = {
      getLocalEnvironmentBearerToken,
    } as unknown as DesktopBridge

    const [first, second] = await Promise.all([
      readDesktopPrimaryBearerToken(),
      readDesktopPrimaryBearerToken(),
    ])
    expect(first).toBe('desktop-bearer-token')
    expect(second).toBe('desktop-bearer-token')
    expect(getLocalEnvironmentBearerToken).toHaveBeenCalledTimes(1)
  })

  it('re-reads the bearer token after the in-flight fetch settles', async () =>
  {
    // the token is no longer cached for the process lifetime, so a rotated
    // credential is picked up on the next request (megacore U-133)
    const getLocalEnvironmentBearerToken = vi
      .fn()
      .mockResolvedValueOnce('desktop-bearer-token')
      .mockResolvedValueOnce('rotated-bearer-token')
    window.desktopBridge = {
      getLocalEnvironmentBearerToken,
    } as unknown as DesktopBridge

    await expect(readDesktopPrimaryBearerToken()).resolves.toBe('desktop-bearer-token')
    await expect(readDesktopPrimaryBearerToken()).resolves.toBe('rotated-bearer-token')
    expect(getLocalEnvironmentBearerToken).toHaveBeenCalledTimes(2)
  })

  it('does not require desktop auth in a browser', async () =>
  {
    await expect(readDesktopPrimaryBearerToken()).resolves.toBeNull()
  })
})
