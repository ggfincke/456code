// tests/apps/web/components/explorer/explorerBridge.test.ts
// verifies the cartographer frame boundary rejects spoofed and unsafe messages
import { describe, expect, it, vi } from 'vite-plus/test'

import {
  CARTOGRAPHER_BRIDGE_PROTOCOL,
  CARTOGRAPHER_BRIDGE_VERSION,
  decodeCartographerFrameMessage,
  postCartographerHostMessage,
  readCartographerFrameMessage,
} from '../../../../../apps/web/src/components/explorer/explorerBridge'

describe('explorerBridge', () =>
{
  it('enforces the frozen envelope, exact origin/window, safe paths, and host target', () =>
  {
    const frameWindow = { postMessage: vi.fn() } as unknown as Window
    const expectedOrigin = 'https://456code.test'
    const lifecycle = {
      protocol: CARTOGRAPHER_BRIDGE_PROTOCOL,
      version: CARTOGRAPHER_BRIDGE_VERSION,
      type: 'lifecycle',
      state: 'ready',
      message: 'Indexed',
    } as const
    const trustedEvent = {
      data: lifecycle,
      source: frameWindow,
      origin: expectedOrigin,
    } as MessageEvent

    expect(readCartographerFrameMessage(trustedEvent, { frameWindow, expectedOrigin })).toEqual(
      lifecycle,
    )
    expect(
      readCartographerFrameMessage({ ...trustedEvent, source: {} as Window } as MessageEvent, {
        frameWindow,
        expectedOrigin,
      }),
    ).toBeNull()
    expect(
      readCartographerFrameMessage(
        { ...trustedEvent, origin: 'https://attacker.invalid' } as MessageEvent,
        { frameWindow, expectedOrigin },
      ),
    ).toBeNull()
    expect(
      decodeCartographerFrameMessage({
        source: 'cartographer',
        version: 1,
        type: 'lifecycle',
        state: 'ready',
      }),
    ).toBeNull()
    expect(
      decodeCartographerFrameMessage({
        protocol: CARTOGRAPHER_BRIDGE_PROTOCOL,
        version: CARTOGRAPHER_BRIDGE_VERSION,
        type: 'open-source',
        file: '../secrets.txt',
      }),
    ).toBeNull()
    expect(
      decodeCartographerFrameMessage({
        protocol: CARTOGRAPHER_BRIDGE_PROTOCOL,
        version: CARTOGRAPHER_BRIDGE_VERSION,
        type: 'open-source',
        file: 'src/index.ts',
        line: 42,
      }),
    ).toEqual({
      protocol: CARTOGRAPHER_BRIDGE_PROTOCOL,
      version: CARTOGRAPHER_BRIDGE_VERSION,
      type: 'open-source',
      file: 'src/index.ts',
      line: 42,
    })

    const hostMessage = {
      protocol: CARTOGRAPHER_BRIDGE_PROTOCOL,
      version: CARTOGRAPHER_BRIDGE_VERSION,
      type: 'proposal-generation-changed',
      generationId: 'generation-1',
    } as const
    expect(postCartographerHostMessage(frameWindow, expectedOrigin, hostMessage)).toBe(true)
    expect(frameWindow.postMessage).toHaveBeenCalledWith(hostMessage, expectedOrigin)
    expect(postCartographerHostMessage(null, expectedOrigin, hostMessage)).toBe(false)
  })
})
