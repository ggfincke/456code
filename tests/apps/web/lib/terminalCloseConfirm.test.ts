// tests/apps/web/lib/terminalCloseConfirm.test.ts
// verifies terminal close confirmation state and destructive copy

import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'

const { confirmMock, readLocalApiMock } = vi.hoisted(() =>
{
  const confirmMock = vi.fn<(message: string) => Promise<boolean>>()
  const readLocalApiMock = vi.fn<
    () =>
      | {
          dialogs: { confirm: (message: string) => Promise<boolean> }
        }
      | undefined
  >()
  return { confirmMock, readLocalApiMock }
})

vi.mock('~/localApi', () => ({
  readLocalApi: () => readLocalApiMock(),
}))

import {
  confirmTerminalClose,
  isTerminalCloseConfirmPending,
} from '../../../../apps/web/src/lib/terminalCloseConfirm'

describe('terminal close confirmation', () =>
{
  beforeEach(() =>
  {
    confirmMock.mockReset()
    readLocalApiMock.mockReset()
    readLocalApiMock.mockReturnValue({ dialogs: { confirm: confirmMock } })
  })

  it('tracks pending state and clears it after dialog failures', async () =>
  {
    let reject: (reason?: unknown) => void = () => undefined
    confirmMock.mockImplementation(
      () =>
        new Promise<boolean>((_resolve, rejectPromise) =>
        {
          reject = rejectPromise
        }),
    )

    const confirmation = confirmTerminalClose(['Terminal 1'])
    expect(isTerminalCloseConfirmPending()).toBe(true)

    reject(new Error('dialog failed'))
    await expect(confirmation).resolves.toBe(false)
    expect(isTerminalCloseConfirmPending()).toBe(false)
  })

  it('names every terminal in a multi-terminal destructive confirmation', async () =>
  {
    confirmMock.mockResolvedValue(true)

    await expect(confirmTerminalClose(['Terminal 1', 'Development server'])).resolves.toBe(true)
    expect(confirmMock).toHaveBeenCalledWith(
      [
        'Close 2 terminals?',
        'This stops their running processes and clears their histories: "Terminal 1", "Development server".',
      ].join('\n'),
    )
  })

  it('closes without prompting when the local dialog API is unavailable', async () =>
  {
    readLocalApiMock.mockReturnValue(undefined)

    await expect(confirmTerminalClose(['Terminal 1'])).resolves.toBe(true)
    expect(confirmMock).not.toHaveBeenCalled()
  })
})
