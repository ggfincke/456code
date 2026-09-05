// tests/apps/desktop/preview/Manager.test.ts
// verifies desktop preview tab, picker, automation, and recording behavior
import { it as effectIt } from '@effect/vitest'
import { HostProcessPlatform } from '@t3tools/shared/hostProcess'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as FileSystem from 'effect/FileSystem'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Logger from 'effect/Logger'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'
import type * as Scope from 'effect/Scope'
import { TestClock } from 'effect/testing'
import type * as Electron from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import * as DesktopEnvironment from '../../../../apps/desktop/src/app/DesktopEnvironment.ts'
import * as ElectronWindow from '../../../../apps/desktop/src/electron/ElectronWindow.ts'
import * as BrowserSession from '../../../../apps/desktop/src/preview/BrowserSession.ts'
import * as PreviewManager from '../../../../apps/desktop/src/preview/Manager.ts'

const {
  createFromPath,
  fromId,
  getFocusedWebContents,
  mkdir,
  showItemInFolder,
  webviewSend,
  writeFile,
  writeImage,
} = vi.hoisted(() => ({
  createFromPath: vi.fn((): { readonly isEmpty: () => boolean } => ({ isEmpty: () => false })),
  fromId: vi.fn((_id?: number): unknown => null),
  getFocusedWebContents: vi.fn(() => null),
  mkdir: vi.fn((_path: string) => undefined),
  showItemInFolder: vi.fn(),
  webviewSend: vi.fn(),
  writeFile: vi.fn((_path: string, _data: Uint8Array) => undefined),
  writeImage: vi.fn(),
}))

vi.mock('electron', () => ({
  clipboard: {
    writeImage,
  },
  nativeImage: {
    createFromPath,
  },
  shell: {
    showItemInFolder,
  },
  session: {
    fromPartition: vi.fn(),
  },
  webContents: {
    fromId,
    getFocusedWebContents,
  },
}))

const browserSessionLayer = Layer.succeed(
  BrowserSession.BrowserSession,
  BrowserSession.BrowserSession.of({
    getPartition: () => Effect.succeed('persist:456code-preview-test'),
    isPartition: (partition) => partition.startsWith('persist:456code-preview-'),
    getSession: () => Effect.die('unexpected getSession'),
    clearCookies: () => Effect.void,
    clearCache: () => Effect.void,
  }),
)

const environmentLayer = Layer.succeed(
  DesktopEnvironment.DesktopEnvironment,
  DesktopEnvironment.DesktopEnvironment.of({
    browserArtifactsDir: '/tmp/t3/dev/browser-artifacts',
  } as DesktopEnvironment.DesktopEnvironment['Service']),
)

const fileSystemLayer = FileSystem.layerNoop({
  makeDirectory: (path) =>
    Effect.sync(() =>
    {
      mkdir(path)
    }),
  writeFile: (path, data) =>
    Effect.sync(() =>
    {
      writeFile(path, data)
    }),
})

const layer = PreviewManager.layer.pipe(
  Layer.provideMerge(browserSessionLayer),
  Layer.provideMerge(environmentLayer),
  Layer.provideMerge(fileSystemLayer),
  Layer.provideMerge(Path.layer),
  Layer.provideMerge(Layer.succeed(HostProcessPlatform, 'linux')),
)
const encodePreviewManagerError = Schema.encodeSync(PreviewManager.PreviewManagerError)

const withManager = <A>(
  use: (
    manager: PreviewManager.PreviewManager['Service'],
  ) => Effect.Effect<A, PreviewManager.PreviewManagerError, Scope.Scope>,
) =>
  Effect.gen(function* ()
  {
    const manager = yield* PreviewManager.PreviewManager
    return yield* use(manager)
  }).pipe(Effect.provide(layer), Effect.scoped)

const TEST_FAVICON = 'data:image/png;base64,cG5n'

const makeSourcePng = (): Buffer =>
{
  const buffer = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer)
  buffer.writeUInt32BE(1, 16)
  buffer.writeUInt32BE(1, 20)
  return buffer
}

const makeFaviconWebContents = (options?: {
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>
  readonly id?: number
  readonly rasterize?: (code: string) => Promise<unknown>
  readonly url?: string
}) =>
{
  type Listener = (...args: Array<unknown>) => void
  const listeners = new Map<string, Set<Listener>>()
  let currentUrl = options?.url ?? 'http://localhost:3200/'
  let destroyed = false
  let loading = false
  let audible = false
  const fetch = vi.fn(
    options?.fetch ??
      (async () =>
        new Response(new Uint8Array(makeSourcePng()), {
          headers: { 'content-type': 'image/png' },
        })),
  )
  const executeJavaScriptInIsolatedWorld = vi.fn(
    async (_worldId: number, scripts: ReadonlyArray<{ readonly code: string }>) =>
      options?.rasterize ? options.rasterize(scripts[0]?.code ?? '') : TEST_FAVICON,
  )
  const reload = vi.fn()
  const loadURL = vi.fn(async (url: string) =>
  {
    currentUrl = url
  })
  const setIgnoreMenuShortcuts = vi.fn()
  const setWindowOpenHandler = vi.fn(
    (_handler: (details: Electron.HandlerDetails) => Electron.WindowOpenHandlerResponse) =>
      undefined,
  )
  const off = vi.fn((event: string, listener: Listener) =>
  {
    const registered = listeners.get(event)
    registered?.delete(listener)
    if (registered?.size === 0) listeners.delete(event)
  })
  const webContents = {
    id: options?.id ?? 42,
    isDestroyed: () => destroyed,
    getType: () => 'webview',
    getURL: () => currentUrl,
    getTitle: () => 'Preview',
    isLoading: () => loading,
    isDevToolsOpened: () => false,
    getZoomFactor: () => 1,
    setZoomFactor: vi.fn(),
    setAudioMuted: vi.fn(),
    isCurrentlyAudible: () => audible,
    reload,
    reloadIgnoringCache: vi.fn(),
    loadURL,
    on: vi.fn((event: string, listener: Listener) =>
    {
      const registered = listeners.get(event) ?? new Set<Listener>()
      registered.add(listener)
      listeners.set(event, registered)
    }),
    off,
    ipc: { on: vi.fn(), off: vi.fn() },
    send: webviewSend,
    session: { fetch },
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    setIgnoreMenuShortcuts,
    setWindowOpenHandler,
    executeJavaScriptInIsolatedWorld,
    debugger: {
      isAttached: () => false,
      attach: vi.fn(),
      sendCommand: vi.fn(async () => undefined),
      on: vi.fn(),
      off: vi.fn(),
    },
  }
  return {
    emit: (event: string, ...args: Array<unknown>) =>
    {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
    fetch,
    listenerCount: (event: string) => listeners.get(event)?.size ?? 0,
    listeners,
    loadURL,
    off,
    reload,
    setIgnoreMenuShortcuts,
    setWindowOpenHandler,
    setDestroyed: (value: boolean) =>
    {
      destroyed = value
    },
    setLoading: (value: boolean) =>
    {
      loading = value
    },
    setAudible: (value: boolean) =>
    {
      audible = value
    },
    setUrl: (url: string) =>
    {
      currentUrl = url
    },
    webContents: webContents as never,
  }
}

const settle = function* (until: () => boolean)
{
  for (let attempt = 0; attempt < 30 && !until(); attempt += 1)
  {
    yield* Effect.promise(() => Promise.resolve())
  }
}

describe('PreviewManager', () =>
{
  beforeEach(() =>
  {
    fromId.mockClear()
    getFocusedWebContents.mockReset()
    getFocusedWebContents.mockReturnValue(null)
    mkdir.mockClear()
    writeFile.mockClear()
    showItemInFolder.mockClear()
    writeImage.mockClear()
    createFromPath.mockClear()
    webviewSend.mockClear()
  })

  effectIt.effect(
    'opens only HTTP(S) scripted popups and keeps ordinary links in the preview',
    () =>
      withManager((manager) =>
        Effect.gen(function* ()
        {
          const preview = makeFaviconWebContents()
          fromId.mockReturnValue(preview.webContents)
          yield* manager.createTab('tab_popup_policy')
          yield* manager.registerWebview('tab_popup_policy', 42)
          const openWindow = preview.setWindowOpenHandler.mock.calls[0]![0]
          const details = (url: string, disposition: Electron.HandlerDetails['disposition']) => ({
            url,
            disposition,
            frameName: '',
            features: '',
            referrer: { url: '', policy: 'default' as const },
          })

          for (const url of ['http://localhost:3200/auth', 'https://accounts.example/auth'])
          {
            expect(openWindow(details(url, 'new-window'))).toEqual({
              action: 'allow',
              overrideBrowserWindowOptions: {
                webPreferences: {
                  contextIsolation: true,
                  nodeIntegration: false,
                  sandbox: true,
                },
              },
            })
          }
          expect(preview.loadURL).not.toHaveBeenCalled()

          for (const disposition of ['foreground-tab', 'background-tab'] as const)
          {
            const url = `https://example.com/${disposition}`
            expect(openWindow(details(url, disposition))).toEqual({ action: 'deny' })
            yield* settle(() => preview.loadURL.mock.calls.some(([loaded]) => loaded === url))
            expect(preview.loadURL).toHaveBeenCalledWith(url)
          }
          preview.loadURL.mockClear()

          for (const url of [
            'about:blank',
            'javascript:alert(1)',
            'data:text/html,popup',
            'file:///tmp/popup.html',
            'vscode://vscode-remote/ssh-remote+example/project',
            'https://[invalid',
          ])
          {
            for (const disposition of ['new-window', 'foreground-tab'] as const)
            {
              expect(openWindow(details(url, disposition))).toEqual({ action: 'deny' })
            }
          }
          yield* settle(() => false)
          expect(preview.loadURL).not.toHaveBeenCalled()
        }),
      ),
  )

  effectIt.effect(
    'denies child popup chains and retires handlers with their exact attachment',
    () =>
      Effect.gen(function* ()
      {
        const initial = makeFaviconWebContents()
        const replacement = makeFaviconWebContents({ id: 42 })
        let active = initial.webContents
        fromId.mockImplementation(() => active)
        const popup = () => ({
          webContents: {
            setIgnoreMenuShortcuts: vi.fn(),
            setWindowOpenHandler: vi.fn(),
          },
        })
        const request: Electron.HandlerDetails = {
          url: 'https://accounts.example/auth',
          disposition: 'new-window',
          frameName: '',
          features: '',
          referrer: { url: '', policy: 'default' },
        }

        yield* withManager((manager) =>
          Effect.gen(function* ()
          {
            yield* manager.createTab('tab_popup_lifecycle')
            yield* manager.registerWebview('tab_popup_lifecycle', 42)
            expect(initial.setIgnoreMenuShortcuts).toHaveBeenCalledWith(true)
            const initialOpen = initial.setWindowOpenHandler.mock.calls[0]![0]
            const initialCreated = [...(initial.listeners.get('did-create-window') ?? [])][0]!
            expect(initial.listenerCount('did-create-window')).toBe(1)
            const child = popup()
            initial.emit('did-create-window', child)
            expect(child.webContents.setIgnoreMenuShortcuts).toHaveBeenCalledWith(true)
            expect(child.webContents.setWindowOpenHandler).toHaveBeenCalledOnce()
            expect(child.webContents.setWindowOpenHandler.mock.calls[0]![0](request)).toEqual({
              action: 'deny',
            })

            active = replacement.webContents
            yield* manager.registerWebview('tab_popup_lifecycle', 42)
            expect(initial.listenerCount('did-create-window')).toBe(0)
            expect(replacement.listenerCount('did-create-window')).toBe(1)
            expect(initialOpen(request)).toEqual({ action: 'deny' })
            const replacementChild = popup()
            initialCreated(replacementChild)
            expect(replacementChild.webContents.setWindowOpenHandler).not.toHaveBeenCalled()
            replacement.emit('did-create-window', replacementChild)
            expect(replacementChild.webContents.setIgnoreMenuShortcuts).toHaveBeenCalledWith(true)
            expect(replacementChild.webContents.setWindowOpenHandler).toHaveBeenCalledOnce()
            const replacementOpen = replacement.setWindowOpenHandler.mock.calls[0]![0]
            expect(replacementOpen(request).action).toBe('allow')

            yield* manager.closeTab('tab_popup_lifecycle')
            expect(replacement.listenerCount('did-create-window')).toBe(0)
            expect(replacementOpen(request)).toEqual({ action: 'deny' })
            expect(replacementOpen({ ...request, disposition: 'foreground-tab' })).toEqual({
              action: 'deny',
            })
            yield* settle(() => false)
            expect(replacement.loadURL).not.toHaveBeenCalled()

            yield* manager.createTab('tab_popup_lifecycle')
            yield* manager.registerWebview('tab_popup_lifecycle', 42)
            expect(replacement.listenerCount('did-create-window')).toBe(1)
            expect(replacement.setWindowOpenHandler.mock.calls.at(-1)![0](request).action).toBe(
              'allow',
            )
          }),
        )
        expect(replacement.listenerCount('did-create-window')).toBe(0)
        expect(replacement.setWindowOpenHandler.mock.calls.at(-1)![0](request)).toEqual({
          action: 'deny',
        })
      }),
  )

  effectIt.effect('keeps preview shortcuts out of the host window', () =>
    withManager((manager) =>
      Effect.gen(function* ()
      {
        const preview = makeFaviconWebContents()
        const sendInputEvent = vi.fn()
        const hostWebContents = { sendInputEvent }
        Object.assign(preview.webContents, { hostWebContents })
        fromId.mockReturnValue(preview.webContents)
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          webContents: hostWebContents,
        } as never)
        yield* manager.createTab('tab_shortcuts')
        yield* manager.registerWebview('tab_shortcuts', 42)

        expect(preview.setIgnoreMenuShortcuts).toHaveBeenCalledWith(true)
        expect(preview.listenerCount('before-input-event')).toBe(0)
        expect(sendInputEvent).not.toHaveBeenCalled()
      }),
    ),
  )

  effectIt.effect('publishes one canonical favicon while the document is loading', () =>
    withManager((manager) =>
      Effect.gen(function* ()
      {
        const preview = makeFaviconWebContents({
          url: `http://localhost:3200/${'x'.repeat(3_000)}`,
        })
        preview.setLoading(true)
        fromId.mockReturnValue(preview.webContents)
        const states: PreviewManager.PreviewTabState[] = []
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() =>
          {
            states.push(state)
          }),
        )
        yield* manager.createTab('tab_favicon_loading')
        yield* manager.registerWebview('tab_favicon_loading', 42)

        preview.emit('page-favicon-updated', {}, ['http://localhost:3200/favicon.png'])
        preview.emit('page-favicon-updated', {}, ['http://localhost:3200/favicon.png'])
        yield* settle(() => states.at(-1)?.favicon !== undefined)

        expect(preview.fetch).toHaveBeenCalledOnce()
        expect(states.at(-1)?.favicon).toMatchObject({
          dataUrl: TEST_FAVICON,
          pageUrl: 'http://localhost:3200',
        })
        expect(states.at(-1)?.favicon?.capturedAt).toEqual(expect.any(Number))
      }),
    ),
  )

  effectIt.effect('invalidates in-flight captures on navigation and close', () =>
    withManager((manager) =>
      Effect.gen(function* ()
      {
        let resolveFetch!: (response: Response) => void
        const preview = makeFaviconWebContents({
          fetch: () =>
            new Promise<Response>((resolve) =>
            {
              resolveFetch = resolve
            }),
        })
        fromId.mockReturnValue(preview.webContents)
        const states: PreviewManager.PreviewTabState[] = []
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() =>
          {
            states.push(state)
          }),
        )
        yield* manager.createTab('tab_favicon_navigation')
        yield* manager.registerWebview('tab_favicon_navigation', 42)
        preview.emit('page-favicon-updated', {}, ['http://localhost:3200/favicon.png'])
        yield* settle(() => preview.fetch.mock.calls.length === 1)

        preview.emit('did-start-navigation', {
          isMainFrame: true,
          isSameDocument: false,
        })
        resolveFetch(
          new Response(new Uint8Array(makeSourcePng()), {
            headers: { 'content-type': 'image/png' },
          }),
        )
        yield* settle(() => false)

        expect(states.some((state) => state.favicon !== undefined)).toBe(false)

        preview.emit('page-favicon-updated', {}, ['http://localhost:3200/retry.png'])
        yield* settle(() => preview.fetch.mock.calls.length === 2)
        yield* manager.closeTab('tab_favicon_navigation')
        resolveFetch(
          new Response(new Uint8Array(makeSourcePng()), {
            headers: { 'content-type': 'image/png' },
          }),
        )
        yield* settle(() => false)
        expect(states.at(-1)?.navStatus).toEqual({ kind: 'Idle' })
        expect(states.at(-1)?.favicon).toBeUndefined()
      }),
    ),
  )

  effectIt.effect(
    'retains a favicon through reload and failure but clears confirmed new origins',
    () =>
      withManager((manager) =>
        Effect.gen(function* ()
        {
          const preview = makeFaviconWebContents()
          fromId.mockReturnValue(preview.webContents)
          const states: PreviewManager.PreviewTabState[] = []
          yield* manager.subscribeStateChanges((_tabId, state) =>
            Effect.sync(() =>
            {
              states.push(state)
            }),
          )
          yield* manager.createTab('tab_favicon_retention')
          yield* manager.registerWebview('tab_favicon_retention', 42)
          preview.emit('page-favicon-updated', {}, ['http://localhost:3200/favicon.png'])
          yield* settle(() => states.at(-1)?.favicon !== undefined)

          yield* manager.navigate('tab_favicon_retention', 'http://localhost:3200/')
          expect(preview.reload).toHaveBeenCalledOnce()
          expect(states.at(-1)?.favicon?.dataUrl).toBe(TEST_FAVICON)

          preview.setUrl('http://localhost:3200/next')
          preview.emit('did-navigate', {})
          yield* settle(() =>
          {
            const navStatus = states.at(-1)?.navStatus
            return navStatus?.kind === 'Success' && navStatus.url === 'http://localhost:3200/next'
          })
          expect(states.at(-1)?.favicon?.dataUrl).toBe(TEST_FAVICON)

          preview.emit(
            'did-fail-load',
            {},
            -105,
            'Name not resolved',
            'https://unreachable.example/',
            true,
          )
          yield* settle(() => states.at(-1)?.navStatus.kind === 'LoadFailed')
          expect(states.at(-1)?.favicon?.dataUrl).toBe(TEST_FAVICON)

          preview.setUrl('https://example.com/')
          preview.emit('did-navigate', {})
          yield* settle(() => states.at(-1)?.navStatus.kind === 'Success')
          expect(states.at(-1)?.favicon).toBeUndefined()
        }),
      ),
  )

  effectIt.effect('rejects stale captures and clears state when a WebContents id is reused', () =>
    withManager((manager) =>
      Effect.gen(function* ()
      {
        let resolveSecond!: (response: Response) => void
        const initial = makeFaviconWebContents({
          fetch: (url) =>
            url.endsWith('first.png')
              ? Promise.resolve(
                  new Response(new Uint8Array(makeSourcePng()), {
                    headers: { 'content-type': 'image/png' },
                  }),
                )
              : new Promise<Response>((resolve) =>
                {
                  resolveSecond = resolve
                }),
        })
        const replacement = makeFaviconWebContents({ id: 42 })
        let active = initial.webContents
        fromId.mockImplementation(() => active)
        const states: PreviewManager.PreviewTabState[] = []
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() =>
          {
            states.push(state)
          }),
        )
        yield* manager.createTab('tab_favicon_reused_id')
        yield* manager.registerWebview('tab_favicon_reused_id', 42)
        initial.emit('page-favicon-updated', {}, ['http://localhost:3200/first.png'])
        yield* settle(() => states.at(-1)?.favicon !== undefined)
        initial.emit('page-favicon-updated', {}, ['http://localhost:3200/second.png'])
        yield* settle(() => initial.fetch.mock.calls.length === 2)

        active = replacement.webContents
        yield* manager.registerWebview('tab_favicon_reused_id', 42)
        expect(states.at(-1)?.favicon).toBeUndefined()
        expect(initial.off).toHaveBeenCalled()
        expect(replacement.listeners.has('page-favicon-updated')).toBe(true)

        resolveSecond(
          new Response(new Uint8Array(makeSourcePng()), {
            headers: { 'content-type': 'image/png' },
          }),
        )
        yield* settle(() => false)
        expect(states.at(-1)?.favicon).toBeUndefined()
      }),
    ),
  )

  effectIt.effect('serializes concurrent cross-tab WebContents transfers', () =>
    withManager((manager) =>
      Effect.gen(function* ()
      {
        const firstSource = makeFaviconWebContents({ id: 41 })
        const secondSource = makeFaviconWebContents({ id: 42 })
        const target = makeFaviconWebContents({ id: 43 })
        const allWebContents = new Map([
          [41, firstSource.webContents],
          [42, secondSource.webContents],
          [43, target.webContents],
        ])
        fromId.mockImplementation((id?: number) =>
          id === undefined ? null : (allWebContents.get(id) ?? null),
        )
        yield* manager.createTab('tab_first')
        yield* manager.createTab('tab_second')
        yield* manager.registerWebview('tab_first', 41)
        yield* manager.registerWebview('tab_second', 42)

        const [firstTransfer, secondTransfer] = yield* Effect.all(
          [
            Effect.exit(manager.registerWebview('tab_first', 43)),
            Effect.exit(manager.registerWebview('tab_second', 43)),
          ],
          { concurrency: 2 },
        )
        expect([firstTransfer, secondTransfer].filter(Exit.isSuccess)).toHaveLength(1)

        const firstWon = Exit.isSuccess(firstTransfer)
        const winnerTabId = firstWon ? 'tab_first' : 'tab_second'
        const loserTabId = firstWon ? 'tab_second' : 'tab_first'
        const loserSourceId = firstWon ? 42 : 41
        const winnerSource = firstWon ? firstSource : secondSource
        const loserSource = firstWon ? secondSource : firstSource
        const losingTransfer = firstWon ? secondTransfer : firstTransfer
        expect(Exit.isFailure(losingTransfer)).toBe(true)
        if (Exit.isFailure(losingTransfer))
        {
          expect(Option.getOrThrow(Cause.findErrorOption(losingTransfer.cause))).toMatchObject({
            _tag: 'PreviewWebContentsNotFoundError',
            webContentsId: 43,
          })
        }
        expect(target.listenerCount('page-favicon-updated')).toBe(1)
        expect(winnerSource.listenerCount('page-favicon-updated')).toBe(0)
        expect(loserSource.listenerCount('page-favicon-updated')).toBe(1)

        yield* manager.closeTab(winnerTabId)
        expect(target.listenerCount('page-favicon-updated')).toBe(0)
        expect(loserSource.listenerCount('page-favicon-updated')).toBe(1)
        yield* manager.registerWebview(loserTabId, loserSourceId)
        expect(loserSource.listenerCount('page-favicon-updated')).toBe(1)
        yield* manager.closeTab(loserTabId)
        expect(loserSource.listenerCount('page-favicon-updated')).toBe(0)
      }),
    ),
  )

  effectIt.effect('reports an unregistered webview as temporarily unavailable', () =>
    withManager((manager) =>
      Effect.gen(function* ()
      {
        expect(yield* manager.automationStatus('tab_1')).toEqual({
          available: false,
          visible: true,
          tabId: 'tab_1',
          url: null,
          title: null,
          loading: false,
        })

        yield* manager.createTab('tab_1')

        expect(yield* manager.automationStatus('tab_1')).toEqual({
          available: false,
          visible: true,
          tabId: 'tab_1',
          url: null,
          title: null,
          loading: false,
        })
        expect(fromId).not.toHaveBeenCalled()
      }),
    ),
  )

  effectIt.effect('isolates failed state listeners and continues delivery', () =>
  {
    const loggedErrors: Array<unknown> = []
    const logger = Logger.make(({ message }) =>
    {
      for (const value of Array.isArray(message) ? message : [message])
      {
        if (typeof value === 'object' && value !== null && 'cause' in value)
        {
          loggedErrors.push(Cause.squash(value.cause as Cause.Cause<never>))
        }
      }
    })
    const deliveryError = new ElectronWindow.ElectronWindowOperationError({
      operation: 'send-window-message',
      platform: 'darwin',
      windowId: 42,
      channel: 'preview:state-change',
      cause: new Error('renderer unavailable'),
    })
    const delivered = vi.fn()

    return withManager((manager) =>
      Effect.gen(function* ()
      {
        yield* manager.subscribeStateChanges(() => Effect.die(deliveryError))
        yield* manager.subscribeStateChanges((tabId, state) =>
          Effect.sync(() =>
          {
            delivered(tabId, state)
          }),
        )

        const state = yield* manager.createTab('tab_listener_failure')

        expect(delivered).toHaveBeenCalledOnce()
        expect(delivered).toHaveBeenCalledWith('tab_listener_failure', state)
        expect(loggedErrors).toHaveLength(1)
        expect(loggedErrors[0]).toBeInstanceOf(ElectronWindow.ElectronWindowOperationError)
        expect(loggedErrors[0]).toMatchObject({
          operation: 'send-window-message',
          windowId: 42,
          channel: 'preview:state-change',
        })
      }),
    ).pipe(
      Effect.provide(
        Logger.layer([logger], {
          mergeWithExisting: false,
        }),
      ),
    )
  })

  effectIt.effect('does not swallow state listener interruption', () =>
    withManager((manager) =>
      Effect.gen(function* ()
      {
        const exit = yield* Effect.scoped(
          Effect.gen(function* ()
          {
            yield* manager.subscribeStateChanges(() => Effect.interrupt)
            return yield* Effect.exit(manager.createTab('tab_interrupted_listener'))
          }),
        )

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit))
        {
          expect(Cause.hasInterrupts(exit.cause)).toBe(true)
        }
      }),
    ),
  )

  effectIt.effect('queues navigation until the webview registers', () =>
    withManager((manager) =>
      Effect.gen(function* ()
      {
        const loadURL = vi.fn(async () => undefined)
        const listeners = new Map<string, (...args: never[]) => void>()
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => 'webview',
          getURL: () => 'about:blank',
          getTitle: () => '',
          isLoading: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          loadURL,
          on: vi.fn((event: string, listener: (...args: never[]) => void) =>
          {
            listeners.set(event, listener)
          }),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setIgnoreMenuShortcuts: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never)

        yield* manager.navigate('tab_pending', 'localhost:3200')

        expect(yield* manager.automationStatus('tab_pending')).toEqual({
          available: false,
          visible: true,
          tabId: 'tab_pending',
          url: 'http://localhost:3200/',
          title: '',
          loading: true,
        })

        yield* manager.registerWebview('tab_pending', 42)
        yield* Effect.yieldNow

        expect(loadURL).toHaveBeenCalledOnce()
        expect(loadURL).toHaveBeenCalledWith('http://localhost:3200/')
      }),
    ),
  )

  effectIt.effect("keeps the tab's own zoom across registration and navigation", () =>
    withManager((manager) =>
      Effect.gen(function* ()
      {
        let effectiveZoom = 0.9
        let zoomReadable = true
        let url = 'https://example.com'
        const listeners = new Map<string, (...args: unknown[]) => void>()
        const setZoomFactor = vi.fn()
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => 'webview',
          getURL: () => url,
          getTitle: () => 'Example',
          isLoading: () => false,
          getZoomFactor: () =>
          {
            if (!zoomReadable) throw new Error('zoom unavailable')
            return effectiveZoom
          },
          setZoomFactor,
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          on: vi.fn((event: string, listener: (...args: unknown[]) => void) =>
          {
            listeners.set(event, listener)
          }),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setIgnoreMenuShortcuts: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never)
        const states: PreviewManager.PreviewTabState[] = []

        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() =>
          {
            states.push(state)
          }),
        )
        yield* manager.createTab('tab_zoom')
        yield* manager.registerWebview('tab_zoom', 42)

        expect(states.at(-1)?.zoomFactor).toBe(1)
        expect(setZoomFactor).toHaveBeenCalledWith(1)

        effectiveZoom = 0.8
        listeners.get('did-navigate')?.()
        yield* Effect.yieldNow

        expect(states.at(-1)?.zoomFactor).toBe(1)

        yield* manager.zoomIn('tab_zoom')
        expect(setZoomFactor).toHaveBeenCalledWith(1.1)
        expect(states.at(-1)?.zoomFactor).toBe(1.1)

        zoomReadable = false
        url = 'https://example.com/after-zoom-read-failed'
        listeners.get('did-navigate')?.()
        yield* Effect.yieldNow

        expect(states.at(-1)?.navStatus).toEqual({
          kind: 'Success',
          url,
          title: 'Example',
        })
        expect(states.at(-1)?.zoomFactor).toBe(1.1)

        const replacementSetZoomFactor = vi.fn()
        fromId.mockReturnValue({
          id: 43,
          isDestroyed: () => false,
          getType: () => 'webview',
          getURL: () => url,
          getTitle: () => 'Example',
          isLoading: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: replacementSetZoomFactor,
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          on: vi.fn(),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setIgnoreMenuShortcuts: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never)

        yield* manager.registerWebview('tab_zoom', 43)

        expect(replacementSetZoomFactor).toHaveBeenCalledWith(1.1)
        expect(states.at(-1)?.zoomFactor).toBe(1.1)
      }),
    ),
  )

  effectIt.effect("re-applies each tab's own zoom when the app window zooms", () =>
    withManager((manager) =>
      Effect.gen(function* ()
      {
        const setZoomFactor = vi.fn()
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => 'webview',
          getURL: () => 'https://example.com',
          getTitle: () => 'Example',
          isLoading: () => false,
          getZoomFactor: () => 1,
          setZoomFactor,
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          on: vi.fn(),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setIgnoreMenuShortcuts: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never)

        yield* manager.createTab('tab_reapply')
        yield* manager.registerWebview('tab_reapply', 42)
        yield* manager.zoomIn('tab_reapply')
        setZoomFactor.mockClear()

        yield* manager.reapplyZoom()

        expect(setZoomFactor).toHaveBeenCalledOnce()
        expect(setZoomFactor).toHaveBeenCalledWith(1.1)
      }),
    ),
  )

  effectIt.effect('applies creation defaults and preserves mute across guest replacement', () =>
    withManager((manager) =>
      Effect.gen(function* ()
      {
        const first = makeFaviconWebContents({ id: 42 })
        const replacement = makeFaviconWebContents({ id: 43 })
        const byId = new Map([
          [42, first.webContents],
          [43, replacement.webContents],
        ])
        fromId.mockImplementation((id?: number) => byId.get(id ?? -1) as never)
        const states: PreviewManager.PreviewTabState[] = []
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() =>
          {
            states.push(state)
          }),
        )

        yield* manager.createTab('tab_audio', { zoomFactor: 1.25, colorScheme: 'dark' })
        yield* manager.registerWebview('tab_audio', 42)
        yield* manager.setAudioMuted('tab_audio', true)
        first.setAudible(true)
        first.emit('audio-state-changed', { audible: true })
        yield* Effect.yieldNow

        expect(states.at(-1)).toMatchObject({
          zoomFactor: 1.25,
          colorScheme: 'dark',
          audioMuted: true,
          audible: true,
        })
        expect(
          (first.webContents as unknown as { setZoomFactor: ReturnType<typeof vi.fn> })
            .setZoomFactor,
        ).toHaveBeenCalledWith(1.25)

        yield* manager.registerWebview('tab_audio', 43)
        expect(
          (replacement.webContents as unknown as { setAudioMuted: ReturnType<typeof vi.fn> })
            .setAudioMuted,
        ).toHaveBeenCalledWith(true)
        expect(states.at(-1)).toMatchObject({ audioMuted: true, audible: false })
      }),
    ),
  )

  effectIt.effect('reasserts same-guest zoom without republishing tab state', () =>
    withManager((manager) =>
      Effect.gen(function* ()
      {
        const setZoomFactor = vi.fn()
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => 'webview',
          getURL: () => 'https://example.com',
          getTitle: () => 'Example',
          isLoading: () => false,
          getZoomFactor: () => 1,
          setZoomFactor,
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          on: vi.fn(),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setIgnoreMenuShortcuts: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never)
        const states: PreviewManager.PreviewTabState[] = []

        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() =>
          {
            states.push(state)
          }),
        )
        yield* manager.createTab('tab_same_guest')
        yield* manager.registerWebview('tab_same_guest', 42)
        yield* manager.zoomIn('tab_same_guest')
        setZoomFactor.mockClear()
        const publishedStateCount = states.length

        yield* manager.registerWebview('tab_same_guest', 42)

        expect(setZoomFactor).toHaveBeenCalledOnce()
        expect(setZoomFactor).toHaveBeenCalledWith(1.1)
        expect(states).toHaveLength(publishedStateCount)
      }),
    ),
  )

  effectIt.effect('routes guest thumb-button requests through that tab history', () =>
    withManager((manager) =>
      Effect.gen(function* ()
      {
        let mouseNavigate: ((event: unknown, payload: unknown) => void) | undefined
        const goBack = vi.fn()
        const goForward = vi.fn()
        let canGoBack = true
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => 'webview',
          getURL: () => 'https://example.com',
          getTitle: () => 'Example',
          isLoading: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          on: vi.fn(),
          off: vi.fn(),
          ipc: {
            on: vi.fn((channel: string, listener: typeof mouseNavigate) =>
            {
              if (channel === 'preview:mouse-navigate') mouseNavigate = listener
            }),
            off: vi.fn(),
          },
          send: webviewSend,
          navigationHistory: {
            canGoBack: () => canGoBack,
            canGoForward: () => true,
            goBack,
            goForward,
          },
          setIgnoreMenuShortcuts: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never)

        yield* manager.createTab('tab_mouse_navigation')
        yield* manager.registerWebview('tab_mouse_navigation', 42)
        expect(mouseNavigate).toBeDefined()

        mouseNavigate?.({}, { direction: 'back' })
        mouseNavigate?.({}, { direction: 'forward' })
        mouseNavigate?.({}, { direction: 'sideways' })
        canGoBack = false
        mouseNavigate?.({}, { direction: 'back' })
        yield* Effect.yieldNow

        expect(goBack).toHaveBeenCalledOnce()
        expect(goForward).toHaveBeenCalledOnce()
      }),
    ),
  )

  effectIt.effect('emulates prefers-color-scheme and re-applies it across webview swaps', () =>
    withManager((manager) =>
      Effect.gen(function* ()
      {
        const makeWebContents = (id: number) =>
        {
          const sendCommand = vi.fn(async () => undefined)
          return {
            sendCommand,
            wc: {
              id,
              isDestroyed: () => false,
              isDevToolsOpened: () => false,
              getType: () => 'webview',
              getURL: () => 'https://example.com',
              getTitle: () => 'Example',
              isLoading: () => false,
              getZoomFactor: () => 1,
              setZoomFactor: vi.fn(),
              setAudioMuted: vi.fn(),
              isCurrentlyAudible: () => false,
              on: vi.fn(),
              off: vi.fn(),
              ipc: { on: vi.fn(), off: vi.fn() },
              send: webviewSend,
              navigationHistory: { canGoBack: () => false, canGoForward: () => false },
              setIgnoreMenuShortcuts: vi.fn(),
              setWindowOpenHandler: vi.fn(),
              debugger: {
                isAttached: () => false,
                attach: vi.fn(),
                sendCommand,
                on: vi.fn(),
                off: vi.fn(),
              },
            } as never,
          }
        }
        const first = makeWebContents(42)
        fromId.mockReturnValue(first.wc)
        const states: PreviewManager.PreviewTabState[] = []

        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() =>
          {
            states.push(state)
          }),
        )
        yield* manager.createTab('tab_scheme')
        yield* manager.registerWebview('tab_scheme', 42)
        yield* Effect.yieldNow

        yield* manager.setColorScheme('tab_scheme', 'dark')

        expect(first.sendCommand).toHaveBeenCalledWith('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-color-scheme', value: 'dark' }],
        })
        expect(states.at(-1)?.colorScheme).toBe('dark')

        const replacement = makeWebContents(43)
        fromId.mockReturnValue(replacement.wc)
        yield* manager.registerWebview('tab_scheme', 43)
        yield* Effect.yieldNow

        expect(replacement.sendCommand).toHaveBeenCalledWith('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-color-scheme', value: 'dark' }],
        })
        expect(states.at(-1)?.colorScheme).toBe('dark')

        yield* manager.setColorScheme('tab_scheme', 'system')

        expect(replacement.sendCommand).toHaveBeenCalledWith('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-color-scheme', value: '' }],
        })
        expect(states.at(-1)?.colorScheme).toBe('system')
      }),
    ),
  )

  effectIt.effect('keeps a main-frame load failure visible until a retry starts', () =>
    withManager((manager) =>
      Effect.gen(function* ()
      {
        const url = 'http://localhost:5733/'
        let loading = false
        const listeners = new Map<string, (...args: unknown[]) => void>()
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => 'webview',
          getURL: () => url,
          getTitle: () => 'localhost:5733',
          isLoading: () => loading,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          on: vi.fn((event: string, listener: (...args: unknown[]) => void) =>
          {
            listeners.set(event, listener)
          }),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setIgnoreMenuShortcuts: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never)
        const statuses: PreviewManager.PreviewNavStatus[] = []

        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() =>
          {
            statuses.push(state.navStatus)
          }),
        )
        yield* manager.createTab('tab_failed')
        yield* manager.registerWebview('tab_failed', 42)

        listeners.get('did-fail-load')?.(
          {},
          -105,
          'ERR_NAME_NOT_RESOLVED',
          'https://missing-frame.example/',
          false,
        )
        yield* Effect.yieldNow
        expect(statuses.at(-1)?.kind).toBe('Success')

        loading = true
        listeners.get('did-start-loading')?.()
        yield* Effect.yieldNow
        expect(statuses.at(-1)?.kind).toBe('Loading')

        loading = false
        listeners.get('did-fail-load')?.({}, -102, 'ERR_CONNECTION_REFUSED', url, true)
        listeners.get('did-stop-loading')?.()
        listeners.get('page-title-updated')?.()
        yield* Effect.yieldNow
        expect(statuses.at(-1)).toEqual({
          kind: 'LoadFailed',
          url,
          title: 'localhost:5733',
          code: -102,
          description: 'ERR_CONNECTION_REFUSED',
        })

        loading = true
        listeners.get('did-start-loading')?.()
        yield* Effect.yieldNow
        expect(statuses.at(-1)?.kind).toBe('Loading')

        loading = false
        listeners.get('did-stop-loading')?.()
        yield* Effect.yieldNow
        expect(statuses.at(-1)?.kind).toBe('Success')

        listeners.get('did-fail-load')?.({}, -102, 'ERR_CONNECTION_REFUSED', url, true)
        yield* Effect.yieldNow
        expect(statuses.at(-1)?.kind).toBe('LoadFailed')

        listeners.get('did-navigate')?.()
        yield* Effect.yieldNow
        expect(statuses.at(-1)?.kind).toBe('Success')
      }),
    ),
  )

  effectIt.effect('captures a PNG screenshot into browser artifacts', () =>
    withManager((manager) =>
      Effect.gen(function* ()
      {
        const png = Buffer.from('preview-png')
        const capturePage = vi.fn(async () => ({ toPNG: () => png }))
        const listeners = new Map<string, (...args: never[]) => void>()
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => 'webview',
          getURL: () => 'https://example.com:8443/path?query=value',
          getTitle: () => 'Example',
          isLoading: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          on: vi.fn((event: string, listener: (...args: never[]) => void) =>
          {
            listeners.set(event, listener)
          }),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setIgnoreMenuShortcuts: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
          capturePage,
        } as never)

        yield* manager.createTab('tab_1')
        yield* manager.registerWebview('tab_1', 42)

        expect(webviewSend).toHaveBeenCalledWith(
          'preview:annotation-theme',
          expect.objectContaining({
            colorScheme: 'light',
            primary: 'oklch(0.488 0.217 264)',
          }),
        )

        const artifact = yield* manager.captureScreenshot('tab_1')

        expect(capturePage).toHaveBeenCalledOnce()
        expect(mkdir).toHaveBeenCalledWith('/tmp/t3/dev/browser-artifacts')
        expect(writeFile).toHaveBeenCalledWith(artifact.path, png)
        expect(artifact).toMatchObject({
          tabId: 'tab_1',
          mimeType: 'image/png',
          sizeBytes: png.byteLength,
        })
        expect(artifact.path).toMatch(
          /\/browser-artifacts\/browser-screenshot-example-com-[^.]+\.png$/,
        )

        const captureCause = new Error('capture failed')
        capturePage.mockRejectedValueOnce(captureCause)
        const exit = yield* Effect.exit(manager.captureScreenshot('tab_1'))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isSuccess(exit)) return
        const error = Option.getOrThrow(Cause.findErrorOption(exit.cause))
        expect(error).toMatchObject({
          _tag: 'PreviewOperationError',
          operation: 'captureScreenshot.capturePage',
          tabId: 'tab_1',
          webContentsId: 42,
          cause: captureCause,
        })
      }),
    ),
  )

  effectIt.effect('keeps element picking active during subframe navigation', () =>
    withManager((manager) =>
      Effect.gen(function* ()
      {
        const listeners = new Map<string, (...args: unknown[]) => void>()
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => 'webview',
          getURL: () => 'https://example.com',
          getTitle: () => 'Example',
          isLoading: () => false,
          isFocused: () => true,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          on: vi.fn((event: string, listener: (...args: unknown[]) => void) =>
          {
            listeners.set(event, listener)
          }),
          once: vi.fn((event: string, listener: (...args: unknown[]) => void) =>
          {
            listeners.set(event, listener)
          }),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn(), removeListener: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setIgnoreMenuShortcuts: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never)

        yield* manager.createTab('tab_1')
        yield* manager.registerWebview('tab_1', 42)
        const pick = yield* manager.pickElement('tab_1').pipe(Effect.forkChild)
        yield* Effect.yieldNow

        listeners.get('did-start-navigation')?.({}, 'about:blank', false, false)
        yield* Effect.yieldNow
        expect(pick.pollUnsafe()).toBeUndefined()

        listeners.get('did-start-navigation')?.({}, 'https://example.com/next', false, true)
        expect(yield* Fiber.join(pick)).toBeNull()
      }),
    ),
  )

  effectIt.effect('drops picker completions from a cancelled session', () =>
    withManager((manager) =>
      Effect.gen(function* ()
      {
        const listeners = new Map<string, (...args: unknown[]) => void>()
        const ipcListeners = new Map<string, (...args: unknown[]) => void>()
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => 'webview',
          getURL: () => 'https://example.com',
          getTitle: () => 'Example',
          isLoading: () => false,
          isFocused: () => true,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          on: vi.fn((event: string, listener: (...args: unknown[]) => void) =>
          {
            listeners.set(event, listener)
          }),
          once: vi.fn((event: string, listener: (...args: unknown[]) => void) =>
          {
            listeners.set(event, listener)
          }),
          off: vi.fn(),
          ipc: {
            on: vi.fn((channel: string, listener: (...args: unknown[]) => void) =>
            {
              ipcListeners.set(channel, listener)
            }),
            off: vi.fn(),
            removeListener: vi.fn(),
          },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setIgnoreMenuShortcuts: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never)

        yield* manager.createTab('tab_1')
        yield* manager.registerWebview('tab_1', 42)

        const firstPick = yield* manager.pickElement('tab_1').pipe(Effect.forkChild)
        yield* Effect.yieldNow
        const firstStart = webviewSend.mock.calls.find(
          ([channel]) => channel === 'preview:start-pick',
        )
        const firstSessionId = firstStart?.[1]
        expect(typeof firstSessionId).toBe('string')

        yield* manager.cancelPickElement('tab_1')
        expect(yield* Fiber.join(firstPick)).toBeNull()

        const secondPick = yield* manager.pickElement('tab_1').pipe(Effect.forkChild)
        yield* Effect.yieldNow
        const startCalls = webviewSend.mock.calls.filter(
          ([channel]) => channel === 'preview:start-pick',
        )
        const secondSessionId = startCalls.at(-1)?.[1]
        expect(secondSessionId).not.toBe(firstSessionId)

        const completePick = ipcListeners.get('preview:element-picked')
        if (!completePick) return yield* Effect.die('picker completion listener was not installed')
        completePick({}, firstSessionId, null)
        yield* Effect.yieldNow
        expect(secondPick.pollUnsafe()).toBeUndefined()

        completePick({}, secondSessionId, null)
        expect(yield* Fiber.join(secondPick)).toBeNull()
      }),
    ),
  )

  effectIt.effect('atomically claims recording and releases ownership when its webview dies', () =>
    withManager((manager) =>
      Effect.gen(function* ()
      {
        const firstMainThrottling = vi.fn()
        const secondMainThrottling = vi.fn()
        const firstMainWebContents = { setBackgroundThrottling: firstMainThrottling }
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          webContents: firstMainWebContents,
        } as unknown as Electron.BrowserWindow)
        let releaseFirstStart: (() => void) | undefined
        let reportFirstStart: (() => void) | undefined
        const firstStartReleased = new Promise<void>((resolve) =>
        {
          releaseFirstStart = resolve
        })
        const firstStartReported = new Promise<void>((resolve) =>
        {
          reportFirstStart = resolve
        })
        const listenersByWebContents = new Map<number, Map<string, (...args: unknown[]) => void>>()
        const webviews = new Map<number, unknown>()

        for (const id of [41, 42])
        {
          const listeners = new Map<string, (...args: unknown[]) => void>()
          listenersByWebContents.set(id, listeners)
          webviews.set(id, {
            id,
            hostWebContents: firstMainWebContents,
            isDestroyed: () => false,
            getType: () => 'webview',
            getURL: () => `https://example.com/${id}`,
            getTitle: () => `Example ${id}`,
            isLoading: () => false,
            isDevToolsOpened: () => false,
            getZoomFactor: () => 1,
            setZoomFactor: vi.fn(),
            setAudioMuted: vi.fn(),
            isCurrentlyAudible: () => false,
            on: vi.fn((event: string, listener: (...args: unknown[]) => void) =>
            {
              listeners.set(event, listener)
            }),
            off: vi.fn((event: string) =>
            {
              listeners.delete(event)
            }),
            ipc: { on: vi.fn(), off: vi.fn() },
            send: webviewSend,
            navigationHistory: { canGoBack: () => false, canGoForward: () => false },
            setIgnoreMenuShortcuts: vi.fn(),
            setWindowOpenHandler: vi.fn(),
            debugger: {
              isAttached: () => false,
              attach: vi.fn(),
              sendCommand: vi.fn(async (method: string) =>
              {
                if (id === 41 && method === 'Page.startScreencast')
                {
                  reportFirstStart?.()
                  await firstStartReleased
                }
                return undefined
              }),
              on: vi.fn(),
              off: vi.fn(),
              detach: vi.fn(),
            },
          })
        }
        fromId.mockImplementation((id?: number) => webviews.get(id as number) as never)

        yield* manager.createTab('tab_1')
        yield* manager.createTab('tab_2')
        yield* manager.registerWebview('tab_1', 41)
        yield* manager.registerWebview('tab_2', 42)
        yield* Effect.yieldNow

        const firstRecording = yield* manager.startRecording('tab_1').pipe(Effect.forkChild)
        yield* Effect.promise(() => firstStartReported)
        expect(firstMainThrottling.mock.calls).toEqual([[false]])

        yield* manager.setMainWindow({
          isDestroyed: () => false,
          webContents: { setBackgroundThrottling: secondMainThrottling },
        } as unknown as Electron.BrowserWindow)
        expect(secondMainThrottling.mock.calls).toEqual([[false]])

        const conflicting = yield* Effect.exit(manager.startRecording('tab_2'))
        expect(Exit.isFailure(conflicting)).toBe(true)
        if (Exit.isFailure(conflicting))
        {
          expect(Option.getOrThrow(Cause.findErrorOption(conflicting.cause))).toMatchObject({
            _tag: 'PreviewRecordingAlreadyActiveError',
            requestedTabId: 'tab_2',
            activeTabId: 'tab_1',
          })
        }

        releaseFirstStart?.()
        yield* Fiber.join(firstRecording)
        listenersByWebContents.get(41)?.get('destroyed')?.()
        yield* Effect.yieldNow
        yield* Effect.yieldNow
        expect(secondMainThrottling.mock.calls).toEqual([[false], [true]])

        yield* manager.startRecording('tab_2')
        expect(secondMainThrottling.mock.calls).toEqual([[false], [true], [false]])
        yield* manager.stopRecording('tab_2')
        expect(secondMainThrottling.mock.calls).toEqual([[false], [true], [false], [true]])
      }),
    ),
  )

  effectIt.effect('reveals only files inside the configured browser artifact directory', () =>
    withManager((manager) =>
      Effect.gen(function* ()
      {
        yield* manager.revealArtifact('/tmp/t3/dev/browser-artifacts/browser-screenshot-test.png')

        expect(showItemInFolder).toHaveBeenCalledWith(
          '/tmp/t3/dev/browser-artifacts/browser-screenshot-test.png',
        )
        const exit = yield* Effect.exit(manager.revealArtifact('/tmp/t3/dev/settings.json'))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isSuccess(exit)) return
        const error = Option.getOrThrow(Cause.findErrorOption(exit.cause))
        expect(error).toMatchObject({
          _tag: 'PreviewArtifactPathOutsideDirectoryError',
          artifactPath: '/tmp/t3/dev/settings.json',
          artifactDirectory: '/tmp/t3/dev/browser-artifacts',
        })
        expect('cause' in error).toBe(false)
      }),
    ),
  )

  effectIt.effect('copies screenshot artifacts to the system clipboard', () =>
    withManager((manager) =>
      Effect.gen(function* ()
      {
        const artifactPath = '/tmp/t3/dev/browser-artifacts/browser-screenshot-test.png'

        yield* manager.copyArtifactToClipboard(artifactPath)

        expect(createFromPath).toHaveBeenCalledWith(artifactPath)
        expect(writeImage).toHaveBeenCalledOnce()
        const exit = yield* Effect.exit(
          manager.copyArtifactToClipboard('/tmp/t3/dev/settings.json'),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isSuccess(exit)) return
        const error = Option.getOrThrow(Cause.findErrorOption(exit.cause))
        expect(error).toMatchObject({
          _tag: 'PreviewArtifactPathOutsideDirectoryError',
          artifactPath: '/tmp/t3/dev/settings.json',
          artifactDirectory: '/tmp/t3/dev/browser-artifacts',
        })
        expect('cause' in error).toBe(false)

        createFromPath.mockReturnValueOnce({ isEmpty: () => true })
        const invalidImageExit = yield* Effect.exit(manager.copyArtifactToClipboard(artifactPath))
        expect(Exit.isFailure(invalidImageExit)).toBe(true)
        if (Exit.isSuccess(invalidImageExit)) return
        expect(Option.getOrThrow(Cause.findErrorOption(invalidImageExit.cause))).toMatchObject({
          _tag: 'PreviewArtifactImageLoadError',
          artifactPath,
        })
      }),
    ),
  )

  effectIt.effect('emits the resolved pointer target before dispatching an automation click', () =>
    withManager((manager) =>
      Effect.gen(function* ()
      {
        let humanInput: ((_event: unknown, signal: unknown) => void) | undefined
        const activity: string[] = []
        const sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>) =>
        {
          if (method === 'Runtime.evaluate')
          {
            return {
              result: {
                value: { width: 800, height: 600 },
              },
            }
          }
          if (method === 'Input.dispatchMouseEvent' && params?.type === 'mousePressed')
          {
            activity.push('mousePressed')
            humanInput?.({}, { kind: 'pointer', x: params.x, y: params.y, button: 0 })
          }
          return undefined
        })
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => 'webview',
          getURL: () => 'https://example.com',
          getTitle: () => 'Example',
          isLoading: () => false,
          isDevToolsOpened: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          on: vi.fn(),
          off: vi.fn(),
          ipc: {
            on: vi.fn((channel: string, listener: typeof humanInput) =>
            {
              if (channel === 'preview:human-input') humanInput = listener
            }),
            off: vi.fn(),
          },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setIgnoreMenuShortcuts: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand,
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never)

        yield* manager.subscribePointerEvents((event) =>
          Effect.sync(() =>
          {
            activity.push(event.phase)
          }),
        )
        yield* manager.createTab('tab_1')
        yield* manager.registerWebview('tab_1', 42)
        const click = yield* manager
          .automationClick('tab_1', { x: 120, y: 80 })
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* TestClock.adjust(200)
        yield* Fiber.join(click)

        expect(activity).toEqual(['move', 'click', 'mousePressed'])
        expect(sendCommand).toHaveBeenCalledWith('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: 120,
          y: 80,
          button: 'left',
          clickCount: 1,
        })
        expect(sendCommand).toHaveBeenCalledWith('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: 120,
          y: 80,
          button: 'left',
          clickCount: 1,
        })
      }),
    ),
  )

  effectIt.effect('types in background webviews and enables native key input', () =>
    withManager((manager) =>
      Effect.gen(function* ()
      {
        let failKeyDown = false
        let humanInput: ((_event: unknown, signal: unknown) => void) | undefined
        const sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>) =>
        {
          if (
            failKeyDown &&
            method === 'Input.dispatchKeyEvent' &&
            (params?.['type'] === 'keyDown' || params?.['type'] === 'rawKeyDown')
          )
          {
            throw new Error('key dispatch failed')
          }
          if (
            method === 'Input.dispatchKeyEvent' &&
            (params?.['type'] === 'keyDown' || params?.['type'] === 'rawKeyDown')
          )
          {
            humanInput?.(
              {},
              {
                kind: 'key',
                key: params['key'],
                code: params['code'] ?? 'Digit1',
              },
            )
          }
          return method === 'Runtime.evaluate' ? { result: { value: { ok: true } } } : undefined
        })
        const restoreFocus = vi.fn()
        const focus = vi.fn()
        getFocusedWebContents.mockReturnValue({
          id: 7,
          isDestroyed: () => false,
          focus: restoreFocus,
        } as never)
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => 'webview',
          getURL: () => 'https://example.com',
          getTitle: () => 'Example',
          isLoading: () => false,
          isDevToolsOpened: () => false,
          focus,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          on: vi.fn(),
          off: vi.fn(),
          ipc: {
            on: vi.fn((channel: string, listener: typeof humanInput) =>
            {
              if (channel === 'preview:human-input') humanInput = listener
            }),
            off: vi.fn(),
          },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setIgnoreMenuShortcuts: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand,
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never)

        yield* manager.createTab('tab_input')
        yield* manager.registerWebview('tab_input', 42)
        yield* manager.automationType('tab_input', { text: 'hello', clear: true })
        yield* manager.automationType('tab_input', { text: '', clear: true })
        yield* manager.automationPress('tab_input', { key: 'x' })

        const calls = sendCommand.mock.calls
        const methods = calls.map(([method]) => method)
        const enableIndex = methods.indexOf('Input.setIgnoreInputEvents')
        const focusOnIndex = calls.findIndex(
          ([method, params]) =>
            method === 'Emulation.setFocusEmulationEnabled' && params?.['enabled'] === true,
        )
        const keyDownIndex = calls.findIndex(
          ([method, params]) =>
            method === 'Input.dispatchKeyEvent' && params?.['type'] === 'keyDown',
        )
        const keyUpIndex = calls.findIndex(
          ([method, params]) => method === 'Input.dispatchKeyEvent' && params?.['type'] === 'keyUp',
        )
        const focusOffIndex = calls.findIndex(
          ([method, params]) =>
            method === 'Emulation.setFocusEmulationEnabled' && params?.['enabled'] === false,
        )
        const typeEvaluation = sendCommand.mock.calls.find(
          ([method, params]) =>
            method === 'Runtime.evaluate' &&
            typeof params === 'object' &&
            params !== null &&
            'expression' in params &&
            typeof params.expression === 'string' &&
            params.expression.includes('document.execCommand("insertText"'),
        )
        expect(typeEvaluation).toBeDefined()
        const clearOnlyEvaluation = sendCommand.mock.calls.find(
          ([method, params]) =>
            method === 'Runtime.evaluate' &&
            typeof params === 'object' &&
            params !== null &&
            'expression' in params &&
            typeof params.expression === 'string' &&
            params.expression.includes('const text = ""') &&
            params.expression.includes('Object.getOwnPropertyDescriptor'),
        )
        expect(clearOnlyEvaluation).toBeDefined()
        expect(methods).not.toContain('Input.insertText')
        expect(enableIndex).toBeGreaterThanOrEqual(0)
        expect(focus).toHaveBeenCalledOnce()
        expect(restoreFocus).toHaveBeenCalledOnce()
        expect(methods).toContain('Page.bringToFront')
        expect(enableIndex).toBeLessThan(focusOnIndex)
        expect(focusOnIndex).toBeLessThan(keyDownIndex)
        expect(keyDownIndex).toBeLessThan(keyUpIndex)
        expect(keyUpIndex).toBeLessThan(focusOffIndex)
        expect(
          calls.filter(
            ([method, params]) =>
              method === 'Input.dispatchKeyEvent' && params?.['type'] === 'keyUp',
          ),
        ).toHaveLength(1)
        expect(sendCommand).toHaveBeenCalledWith('Input.setIgnoreInputEvents', { ignore: false })

        sendCommand.mockClear()
        failKeyDown = true
        const failedPress = yield* Effect.exit(manager.automationPress('tab_input', { key: 'y' }))

        expect(Exit.isFailure(failedPress)).toBe(true)
        expect(sendCommand).toHaveBeenCalledWith('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'y',
          code: 'KeyY',
          modifiers: 0,
          windowsVirtualKeyCode: 89,
          location: 0,
          isKeypad: false,
        })
        expect(sendCommand).toHaveBeenCalledWith('Emulation.setFocusEmulationEnabled', {
          enabled: false,
        })
        expect(restoreFocus).toHaveBeenCalledTimes(2)
        expect(
          sendCommand.mock.calls.filter(
            ([method, params]) =>
              method === 'Input.dispatchKeyEvent' && params?.['type'] === 'keyUp',
          ),
        ).toHaveLength(1)

        sendCommand.mockClear()
        failKeyDown = false
        yield* manager.automationPress('tab_input', { key: '!' })
        expect(sendCommand).toHaveBeenCalledWith('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: '!',
          code: 'Digit1',
          modifiers: 0,
          windowsVirtualKeyCode: 49,
          location: 0,
          isKeypad: false,
          text: '!',
          unmodifiedText: '!',
        })
        expect(restoreFocus).toHaveBeenCalledTimes(3)
      }),
    ),
  )

  effectIt.effect('still interrupts agent control for a different human pointer event', () =>
    withManager((manager) =>
      Effect.gen(function* ()
      {
        let humanInput: ((_event: unknown, signal: unknown) => void) | undefined
        const sendCommand = vi.fn(async (method: string) =>
        {
          if (method === 'Runtime.evaluate')
          {
            return {
              result: {
                value: { width: 800, height: 600 },
              },
            }
          }
          if (method === 'Input.dispatchMouseEvent')
          {
            humanInput?.({}, { kind: 'pointer', x: 400, y: 300, button: 0 })
          }
          return undefined
        })
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => 'webview',
          getURL: () => 'https://example.com',
          getTitle: () => 'Example',
          isLoading: () => false,
          isDevToolsOpened: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          on: vi.fn(),
          off: vi.fn(),
          ipc: {
            on: vi.fn((channel: string, listener: typeof humanInput) =>
            {
              if (channel === 'preview:human-input') humanInput = listener
            }),
            off: vi.fn(),
          },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setIgnoreMenuShortcuts: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand,
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never)

        yield* manager.createTab('tab_1')
        yield* manager.registerWebview('tab_1', 42)

        const click = yield* manager
          .automationClick('tab_1', { x: 120, y: 80 })
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* TestClock.adjust(200)
        const exit = yield* Fiber.await(click)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isSuccess(exit)) return
        const error = Option.getOrThrow(Cause.findErrorOption(exit.cause))
        expect(error).toMatchObject({
          _tag: 'PreviewAutomationControlInterruptedError',
          operation: 'click',
          tabId: 'tab_1',
          webContentsId: 42,
        })
        expect(error).toBeInstanceOf(Error)
        if (error instanceof Error)
        {
          expect(error.name).toBe('PreviewAutomationControlInterruptedError')
        }
        expect('cause' in error).toBe(false)
      }),
    ),
  )

  effectIt.effect('derives evaluation detail kind and length from the same non-empty source', () =>
    withManager((manager) =>
      Effect.gen(function* ()
      {
        const text = 'ReferenceError: fallbackDetail is not defined'
        const exceptionDetails = {
          text,
          exception: { description: '' },
        }
        const sendCommand = vi.fn(async (method: string) =>
          method === 'Runtime.evaluate' ? { exceptionDetails } : undefined,
        )
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => 'webview',
          getURL: () => 'https://example.com',
          getTitle: () => 'Example',
          isLoading: () => false,
          isDevToolsOpened: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          on: vi.fn(),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setIgnoreMenuShortcuts: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand,
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never)

        yield* manager.createTab('tab_1')
        yield* manager.registerWebview('tab_1', 42)
        const exit = yield* Effect.exit(
          manager.automationEvaluate('tab_1', { expression: 'fallbackDetail' }),
        )

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isSuccess(exit)) return
        const error = Option.getOrThrow(Cause.findErrorOption(exit.cause))
        expect(error).toMatchObject({
          _tag: 'PreviewAutomationEvaluationError',
          detailKind: 'exception-text',
          detailLength: text.length,
          cause: exceptionDetails,
        })
      }),
    ),
  )
})

describe('PreviewOperationError', () =>
{
  it('keeps timeline detail separate from its structured message', () =>
  {
    const cause = new Error('CDP command failed with an invalid node id')
    const error = new PreviewManager.PreviewOperationError({
      operation: 'click.DOM.resolveNode',
      tabId: 'tab_1',
      webContentsId: 42,
      cause,
    })

    expect(error.message).not.toContain(cause.message)
    expect(PreviewManager.PreviewOperationError.toTimelineMessage(error)).toBe(cause.message)
  })
})

describe('Preview automation diagnostics', () =>
{
  it('keeps browser exception detail out of structural diagnostics', () =>
  {
    const secret = 'unrelated-browser-payload-secret'
    const detail = 'ReferenceError: missingValue is not defined'
    const cause = {
      text: 'Uncaught Error',
      exception: { description: detail },
      unsafePayload: secret,
    }
    const error = new PreviewManager.PreviewAutomationEvaluationError({
      tabId: 'tab_1',
      detailKind: 'exception-description',
      detailLength: detail.length,
      cause,
    })

    const encoded = encodePreviewManagerError(error)
    const { cause: encodedCause, ...encodedDiagnostics } = encoded as typeof encoded & {
      readonly cause?: unknown
    }

    expect(error.cause).toBe(cause)
    expect(encodedCause).toStrictEqual(cause)
    expect(error.message).toBe('Preview JavaScript evaluation failed in tab tab_1')
    expect(error.message).not.toContain(secret)
    expect(JSON.stringify(encodedDiagnostics)).not.toContain(secret)
    expect('detail' in error).toBe(false)
    expect(PreviewManager.PreviewAutomationEvaluationError.toTimelineMessage(error)).toBe(detail)
    expect(PreviewManager.PreviewAutomationEvaluationError.toTimelineMessage(error)).not.toContain(
      secret,
    )
  })

  it('retains bounded selector diagnostics without exposing selector or reason text', () =>
  {
    const selector = "role=button[name='selector-secret']"
    const reason = 'Unexpected token near reason-secret'
    const cause = { invalidSelector: true as const, message: reason }
    const error = new PreviewManager.PreviewAutomationInvalidSelectorError({
      operation: 'click',
      tabId: 'tab_1',
      selectorKind: 'locator',
      selectorLength: selector.length,
      reasonLength: reason.length,
      cause,
    })

    const encoded = encodePreviewManagerError(error)
    const { cause: encodedCause, ...encodedDiagnostics } = encoded as typeof encoded & {
      readonly cause?: unknown
    }

    expect(error.cause).toBe(cause)
    expect(encodedCause).toStrictEqual(cause)
    expect(error).toMatchObject({
      selectorKind: 'locator',
      selectorLength: selector.length,
      reasonLength: reason.length,
    })
    expect(error.detail).toEqual({
      selectorKind: 'locator',
      selectorLength: selector.length,
    })
    expect(error.message).not.toContain('secret')
    expect(JSON.stringify(encodedDiagnostics)).not.toContain('secret')
    expect('selector' in error).toBe(false)
    expect('reason' in error).toBe(false)
    expect(PreviewManager.PreviewAutomationInvalidSelectorError.toTimelineMessage(error)).toBe(
      reason,
    )
  })

  it('does not retain a missing target locator', () =>
  {
    const selector = "[data-token='target-secret']"
    const error = new PreviewManager.PreviewAutomationTargetNotFoundError({
      operation: 'scroll',
      tabId: 'tab_1',
      selectorKind: 'selector',
      selectorLength: selector.length,
    })

    expect(error.message).not.toContain(selector)
    expect(JSON.stringify(error)).not.toContain(selector)
    expect('locator' in error).toBe(false)
  })
})
