// tests/apps/desktop/electron/ElectronMenu.test.ts
// verify electron menu behavior

import { assert, describe, it } from '@effect/vitest'
import { HostProcessPlatform } from '@t3tools/shared/hostProcess'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import type * as Electron from 'electron'
import { beforeEach, vi } from 'vite-plus/test'

const { buildFromTemplateMock, createFromNamedImageMock, setApplicationMenuMock } = vi.hoisted(
  () => ({
    buildFromTemplateMock: vi.fn(),
    createFromNamedImageMock: vi.fn(),
    setApplicationMenuMock: vi.fn(),
  }),
)

vi.mock('electron', () => ({
  Menu: {
    buildFromTemplate: buildFromTemplateMock,
    setApplicationMenu: setApplicationMenuMock,
  },
  nativeImage: {
    createFromNamedImage: createFromNamedImageMock,
  },
}))

import * as ElectronMenu from '../../../../apps/desktop/src/electron/ElectronMenu.ts'

const TestLayer = ElectronMenu.layer.pipe(
  Layer.provide(Layer.succeed(HostProcessPlatform, 'linux')),
)

const makeWindow = (zoomFactor = 1): Electron.BrowserWindow =>
  ({
    id: 7,
    webContents: { getZoomFactor: () => zoomFactor },
  }) as unknown as Electron.BrowserWindow

describe('ElectronMenu', () =>
{
  beforeEach(() =>
  {
    buildFromTemplateMock.mockReset()
    createFromNamedImageMock.mockReset()
    setApplicationMenuMock.mockReset()
  })

  it.effect('returns none without building a menu when there are no valid items', () =>
    Effect.gen(function* ()
    {
      const electronMenu = yield* ElectronMenu.ElectronMenu
      const selectedItemId = yield* electronMenu.showContextMenu({
        window: {} as Electron.BrowserWindow,
        items: [],
        position: Option.none(),
      })

      assert.isTrue(Option.isNone(selectedItemId))
      assert.equal(buildFromTemplateMock.mock.calls.length, 0)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect('resolves with the clicked leaf item id', () =>
    Effect.gen(function* ()
    {
      buildFromTemplateMock.mockImplementation(
        (template: Electron.MenuItemConstructorOptions[]) => ({
          popup: () =>
          {
            const firstItem = template[0]
            assert.isDefined(firstItem)
            const click = firstItem.click
            if (!click)
            {
              throw new Error('Expected menu item to have a click handler.')
            }
            click({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent)
          },
        }),
      )

      const electronMenu = yield* ElectronMenu.ElectronMenu
      const selectedItemId = yield* electronMenu.showContextMenu({
        window: makeWindow(),
        items: [{ id: 'copy', label: 'Copy' }],
        position: Option.none(),
      })

      assert.equal(Option.getOrNull(selectedItemId), 'copy')
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect('resolves with none when the menu closes without a click', () =>
    Effect.gen(function* ()
    {
      let popupOptions: Electron.PopupOptions | undefined
      buildFromTemplateMock.mockImplementation(() => ({
        popup: (options: Electron.PopupOptions) =>
        {
          popupOptions = options
          options.callback?.()
        },
      }))

      const electronMenu = yield* ElectronMenu.ElectronMenu
      const selectedItemId = yield* electronMenu.showContextMenu({
        window: makeWindow(2),
        items: [
          { id: 'copy', label: 'Copy' },
          { id: 'delete', label: 'Delete', destructive: true, separatorBefore: true },
        ],
        position: Option.some({ x: 10.8, y: 20.2 }),
      })

      assert.isTrue(Option.isNone(selectedItemId))
      assert.equal(popupOptions?.x, 21)
      assert.equal(popupOptions?.y, 40)
      assert.deepEqual(buildFromTemplateMock.mock.calls[0]?.[0][0], {
        label: 'Copy',
        enabled: true,
        click: buildFromTemplateMock.mock.calls[0]?.[0][0].click,
      })
      assert.deepEqual(
        buildFromTemplateMock.mock.calls[0]?.[0].map(
          (item: Electron.MenuItemConstructorOptions) => item.type ?? item.label,
        ),
        ['Copy', 'separator', 'Delete'],
      )
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect('keeps a preceding non-destructive action in the destructive section', () =>
    Effect.gen(function* ()
    {
      buildFromTemplateMock.mockImplementation(() => ({
        popup: (options: Electron.PopupOptions) => options.callback?.(),
      }))

      const electronMenu = yield* ElectronMenu.ElectronMenu
      yield* electronMenu.showContextMenu({
        window: makeWindow(),
        items: [
          { id: 'copy', label: 'Copy' },
          { id: 'archive', label: 'Archive', separatorBefore: true },
          { id: 'delete', label: 'Delete', destructive: true },
        ],
        position: Option.none(),
      })

      assert.deepEqual(
        buildFromTemplateMock.mock.calls[0]?.[0].map(
          (item: Electron.MenuItemConstructorOptions) => item.type ?? item.label,
        ),
        ['Copy', 'separator', 'Archive', 'Delete'],
      )
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect('defers popupTemplate side effects until the returned Effect runs', () =>
    Effect.gen(function* ()
    {
      const popupMock = vi.fn()
      buildFromTemplateMock.mockImplementation(() => ({ popup: popupMock }))

      const electronMenu = yield* ElectronMenu.ElectronMenu
      const popup = electronMenu.popupTemplate({
        window: {} as Electron.BrowserWindow,
        template: [{ label: 'Copy' }],
      })

      assert.equal(buildFromTemplateMock.mock.calls.length, 0)
      assert.equal(popupMock.mock.calls.length, 0)

      yield* popup

      assert.equal(buildFromTemplateMock.mock.calls.length, 1)
      assert.equal(popupMock.mock.calls.length, 1)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect.each([
    {
      label: 'application-menu',
      operation: 'set-application-menu' as const,
      windowId: null,
      itemCount: 2,
      causeMessage: 'application menu build failed',
      setupFailure: (cause: Error) =>
      {
        buildFromTemplateMock.mockImplementationOnce(() =>
        {
          throw cause
        })
      },
      invoke: (electronMenu: ElectronMenu.ElectronMenu['Service']) =>
        electronMenu.setApplicationMenu([{ label: 'File' }, { label: 'Edit' }]),
    },
    {
      label: 'popup-template',
      operation: 'popup-template' as const,
      windowId: 41,
      itemCount: 1,
      causeMessage: 'popup failed',
      setupFailure: (cause: Error) =>
      {
        buildFromTemplateMock.mockReturnValueOnce({
          popup: () =>
          {
            throw cause
          },
        })
      },
      invoke: (electronMenu: ElectronMenu.ElectronMenu['Service']) =>
        electronMenu.popupTemplate({
          window: { id: 41 } as Electron.BrowserWindow,
          template: [{ label: 'Copy' }],
        }),
    },
    {
      label: 'context-menu',
      operation: 'show-context-menu' as const,
      windowId: 42,
      itemCount: 1,
      causeMessage: 'context menu build failed',
      setupFailure: (cause: Error) =>
      {
        buildFromTemplateMock.mockImplementationOnce(() =>
        {
          throw cause
        })
      },
      invoke: (electronMenu: ElectronMenu.ElectronMenu['Service']) =>
        electronMenu.showContextMenu({
          window: { id: 42 } as Electron.BrowserWindow,
          items: [{ id: 'copy', label: 'Copy' }],
          position: Option.none(),
        }),
    },
  ])(
    'preserves $label failures as structured defects',
    ({ operation, windowId, itemCount, causeMessage, setupFailure, invoke }) =>
      Effect.gen(function* ()
      {
        const cause = new Error(causeMessage)
        setupFailure(cause)

        const electronMenu = yield* ElectronMenu.ElectronMenu
        const exit = yield* Effect.exit(invoke(electronMenu))

        assert.equal(exit._tag, 'Failure')
        if (exit._tag === 'Failure')
        {
          const error = Cause.squash(exit.cause)
          assert.instanceOf(error, ElectronMenu.ElectronMenuOperationError)
          assert.equal(error.operation, operation)
          assert.equal(error.platform, 'linux')
          assert.equal(error.windowId, windowId)
          assert.equal(error.itemCount, itemCount)
          assert.strictEqual(error.cause, cause)
          assert.notInclude(error.message, cause.message)
        }
      }).pipe(Effect.provide(TestLayer)),
  )
})
