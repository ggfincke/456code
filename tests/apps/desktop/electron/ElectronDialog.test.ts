// tests/apps/desktop/electron/ElectronDialog.test.ts
// verify electron dialog behavior

import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import type { BrowserWindow } from 'electron'
import { beforeEach, vi } from 'vite-plus/test'

import * as ElectronDialog from '../../../../apps/desktop/src/electron/ElectronDialog.ts'

const { showMessageBoxMock } = vi.hoisted(() => ({
  showMessageBoxMock: vi.fn(),
}))

vi.mock('electron', () => ({
  dialog: {
    showMessageBox: showMessageBoxMock,
    showOpenDialog: vi.fn(),
    showErrorBox: vi.fn(),
  },
}))

describe('ElectronDialog', () =>
{
  beforeEach(() =>
  {
    showMessageBoxMock.mockReset()
  })

  it.effect('returns false without opening a confirm dialog for empty messages', () =>
    Effect.gen(function* ()
    {
      const dialog = yield* ElectronDialog.ElectronDialog

      const result = yield* dialog.confirm({
        message: '   ',
        owner: Option.none(),
      })

      assert.isFalse(result)
      assert.equal(showMessageBoxMock.mock.calls.length, 0)
    }).pipe(Effect.provide(ElectronDialog.layer)),
  )

  it.effect('opens a confirm dialog for the owner window', () =>
    Effect.gen(function* ()
    {
      const owner = { id: 1 } as BrowserWindow
      showMessageBoxMock.mockResolvedValue({ response: 1 })
      const dialog = yield* ElectronDialog.ElectronDialog

      const result = yield* dialog.confirm({
        message: 'Delete worktree?',
        owner: Option.some(owner),
      })

      assert.isTrue(result)
      assert.deepEqual(showMessageBoxMock.mock.calls[0], [
        owner,
        {
          type: 'question',
          buttons: ['No', 'Yes'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
          message: 'Delete worktree?',
        },
      ])
    }).pipe(Effect.provide(ElectronDialog.layer)),
  )

  it.effect('opens an app-level confirm dialog when there is no owner window', () =>
    Effect.gen(function* ()
    {
      showMessageBoxMock.mockResolvedValue({ response: 0 })
      const dialog = yield* ElectronDialog.ElectronDialog

      const result = yield* dialog.confirm({
        message: 'Delete worktree?',
        owner: Option.none(),
      })

      assert.isFalse(result)
      assert.deepEqual(showMessageBoxMock.mock.calls[0], [
        {
          type: 'question',
          buttons: ['No', 'Yes'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
          message: 'Delete worktree?',
        },
      ])
    }).pipe(Effect.provide(ElectronDialog.layer)),
  )

  it.effect('preserves confirmation request context and cause without prompt text', () =>
    Effect.gen(function* ()
    {
      const cause = new Error('confirmation failed')
      const owner = { id: 9 } as BrowserWindow
      showMessageBoxMock.mockRejectedValue(cause)
      const dialog = yield* ElectronDialog.ElectronDialog

      const error = yield* Effect.flip(
        dialog.confirm({
          owner: Option.some(owner),
          message: '  Confirm removal?  ',
        }),
      )

      assert.instanceOf(error, ElectronDialog.ElectronDialogConfirmError)
      assert.isTrue(ElectronDialog.isElectronDialogError(error))
      assert.strictEqual(error.ownerWindowId, 9)
      assert.strictEqual(error.promptLength, 'Confirm removal?'.length)
      assert.notProperty(error, 'promptMessage')
      assert.strictEqual(error.cause, cause)
      assert.include(error.message, 'window 9')
      assert.notInclude(error.message, 'Confirm removal?')
      assert.notInclude(error.message, cause.message)
    }).pipe(Effect.provide(ElectronDialog.layer)),
  )
})
