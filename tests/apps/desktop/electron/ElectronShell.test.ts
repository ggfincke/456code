// tests/apps/desktop/electron/ElectronShell.test.ts
// verify electron shell behavior

import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import { beforeEach, vi } from 'vite-plus/test'

const { openExternalMock, writeTextMock } = vi.hoisted(() => ({
  openExternalMock: vi.fn(),
  writeTextMock: vi.fn(),
}))

vi.mock('electron', () => ({
  shell: {
    openExternal: openExternalMock,
  },
  clipboard: {
    writeText: writeTextMock,
  },
}))

import * as ElectronShell from '../../../../apps/desktop/src/electron/ElectronShell.ts'

describe('ElectronShell', () =>
{
  beforeEach(() =>
  {
    openExternalMock.mockReset()
    writeTextMock.mockReset()
  })

  it.effect('opens web and remote editor URLs', () =>
    Effect.gen(function* ()
    {
      openExternalMock.mockResolvedValue(undefined)

      const electronShell = yield* ElectronShell.ElectronShell
      const urls = [
        'http://example.com/path',
        'https://example.com/path',
        'cursor://vscode-remote/ssh-remote+dev/home/user/project',
        'vscode://vscode-remote/ssh-remote+dev/home/user/project',
        'vscode-insiders://vscode-remote/ssh-remote+dev/home/user/project',
        'vscodium://vscode-remote/ssh-remote+dev/home/user/project',
      ]
      const results = yield* Effect.forEach(urls, electronShell.openExternal)

      assert.deepEqual(
        results,
        urls.map(() => true),
      )
      assert.deepEqual(
        openExternalMock.mock.calls,
        urls.map((url) => [url]),
      )
    }).pipe(Effect.provide(ElectronShell.layer)),
  )

  it.effect('does not open unapproved external URLs', () =>
    Effect.gen(function* ()
    {
      const electronShell = yield* ElectronShell.ElectronShell
      const results = yield* Effect.forEach(
        ['file:///etc/passwd', 'javascript:alert(1)', 'zed://ssh-remote/dev/project'],
        electronShell.openExternal,
      )

      assert.deepEqual(results, [false, false, false])
      assert.equal(openExternalMock.mock.calls.length, 0)
    }).pipe(Effect.provide(ElectronShell.layer)),
  )

  it.effect('does not open remote editor URLs with userinfo', () =>
    Effect.gen(function* ()
    {
      openExternalMock.mockResolvedValue(undefined)

      const electronShell = yield* ElectronShell.ElectronShell
      const results = yield* Effect.all([
        electronShell.openExternal(
          'vscode://user@vscode-remote/ssh-remote+example.com/home/user/project',
        ),
        electronShell.openExternal(
          'vscode://:secret@vscode-remote/ssh-remote+example.com/home/user/project',
        ),
      ])

      assert.deepEqual(results, [false, false])
      assert.equal(openExternalMock.mock.calls.length, 0)
    }).pipe(Effect.provide(ElectronShell.layer)),
  )

  it.effect('does not open non-remote editor URLs', () =>
    Effect.gen(function* ()
    {
      openExternalMock.mockResolvedValue(undefined)

      const electronShell = yield* ElectronShell.ElectronShell
      const result = yield* electronShell.openExternal(
        'vscode://ms-python.python/some-command?argument=attacker',
      )

      assert.equal(result, false)
      assert.equal(openExternalMock.mock.calls.length, 0)
    }).pipe(Effect.provide(ElectronShell.layer)),
  )

  it.effect('returns false when Electron rejects openExternal', () =>
    Effect.gen(function* ()
    {
      openExternalMock.mockRejectedValue(new Error('open failed'))

      const electronShell = yield* ElectronShell.ElectronShell
      const result = yield* electronShell.openExternal('https://example.com/path')

      assert.equal(result, false)
    }).pipe(Effect.provide(ElectronShell.layer)),
  )
})
