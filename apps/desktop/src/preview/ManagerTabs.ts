// apps/desktop/src/preview/ManagerTabs.ts
// owns desktop preview tab lifecycle, navigation, zoom, and color scheme

import type { BrowserWindow } from 'electron'
import { webContents } from 'electron'
import * as Effect from 'effect/Effect'
import type * as Fiber from 'effect/Fiber'
import * as Option from 'effect/Option'
import * as Ref from 'effect/Ref'
import * as SynchronizedRef from 'effect/SynchronizedRef'

import {
  PreviewOperationError,
  PreviewTabNotFoundError,
  PreviewWebContentsNotFoundError,
  type PreviewManagerError,
} from './ManagerErrors.ts'
import {
  DEFAULT_ZOOM_FACTOR,
  ZOOM_EPSILON,
  type BrowserControlSession,
  type ManagedListeners,
  type PreviewNavStatus,
  type PreviewOperationContext,
  type PreviewTabRecord,
  type PreviewTabState,
} from './ManagerTypes.ts'
import { normalizePreviewUrl } from '@t3tools/shared/preview'
import type { DesktopPreviewAnnotationTheme, DesktopPreviewColorScheme } from '@t3tools/contracts'
import { ANNOTATION_THEME_CHANNEL } from './GuestProtocol.ts'

export interface ManagerTabsDeps
{
  readonly tabsRef: SynchronizedRef.SynchronizedRef<ReadonlyMap<string, PreviewTabRecord>>
  readonly mainWindowRef: Ref.Ref<Option.Option<BrowserWindow>>
  readonly attachedRef: Ref.Ref<ReadonlyMap<number, ManagedListeners>>
  readonly annotationThemeRef: Ref.Ref<DesktopPreviewAnnotationTheme>
  readonly tabGenerationSequenceRef: Ref.Ref<number>
  readonly attempt: <A>(
    errorContext: PreviewOperationContext,
    evaluate: () => A,
  ) => Effect.Effect<A, PreviewOperationError>
  readonly attemptPromise: <A>(
    errorContext: PreviewOperationContext,
    evaluate: () => PromiseLike<A>,
  ) => Effect.Effect<A, PreviewOperationError>
  readonly cancelPickElement: (tabId: string) => Effect.Effect<void, PreviewManagerError>
  readonly computeNavStatus: (wc: Electron.WebContents) => PreviewNavStatus
  readonly currentIso: Effect.Effect<string>
  readonly detachControlSession: (webContentsId: number) => Effect.Effect<void, PreviewManagerError>
  readonly detachListeners: (webContentsId: number, attachmentToken: symbol) => Effect.Effect<void>
  readonly attachListeners: (
    tabId: string,
    wc: Electron.WebContents,
    lifecycleGeneration: number,
  ) => Effect.Effect<symbol, PreviewManagerError>
  readonly emit: (tabId: string, state: PreviewTabState) => Effect.Effect<void>
  readonly nextCounter: (ref: Ref.Ref<number>) => Effect.Effect<number>
  readonly replaceMap: <K, V>(
    source: ReadonlyMap<K, V>,
    update: (copy: Map<K, V>) => void,
  ) => ReadonlyMap<K, V>
  readonly requireWebContents: (
    tabId: string,
  ) => Effect.Effect<Electron.WebContents, PreviewManagerError>
  readonly toPreviewTabState: (state: PreviewTabState) => PreviewTabState
  readonly withTabLifecycle: <A, E, R>(
    tabId: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
  readonly withAttachmentTransition: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
  readonly update: (
    tabId: string,
    patch: Partial<PreviewTabState>,
    lifecycleGeneration?: number,
  ) => Effect.Effect<void>
  readonly runFork: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>
  readonly ensureControlSession: (
    wc: Electron.WebContents,
  ) => Effect.Effect<BrowserControlSession, PreviewManagerError>
}

export const createTabOperations = (deps: ManagerTabsDeps) =>
{
  const {
    tabsRef,
    mainWindowRef,
    attachedRef,
    annotationThemeRef,
    tabGenerationSequenceRef,
    attempt,
    attemptPromise,
    cancelPickElement,
    computeNavStatus,
    currentIso,
    detachControlSession,
    detachListeners,
    attachListeners,
    emit,
    nextCounter,
    replaceMap,
    requireWebContents,
    toPreviewTabState,
    withTabLifecycle,
    withAttachmentTransition,
    update,
    runFork,
    ensureControlSession,
  } = deps

  const setMainWindow = Effect.fn('PreviewManager.setMainWindow')(function* (
    window: BrowserWindow,
  )
  {
    yield* Ref.set(mainWindowRef, Option.some(window))
  })

  // read both owners at call time so an attach race cannot restore stale zoom
  const assertTabZoom = Effect.fn('PreviewManager.assertTabZoom')(function* (tabId: string)
  {
    const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId)
    if (!tab || tab.webContentsId === null) return
    const wc = webContents.fromId(tab.webContentsId)
    if (!wc || wc.isDestroyed()) return
    yield* attempt({ operation: 'assertTabZoom', tabId, webContentsId: wc.id }, () =>
      wc.setZoomFactor(tab.zoomFactor),
    ).pipe(Effect.ignore)
  })

  const createTabUnlocked = Effect.fn('PreviewManager.createTab')(function* (tabId: string)
  {
    const lifecycleGeneration = yield* nextCounter(tabGenerationSequenceRef)
    const updatedAt = yield* currentIso
    const state = yield* SynchronizedRef.modify(tabsRef, (tabs) =>
    {
      const existing = tabs.get(tabId)
      if (existing) return [existing, tabs] as const
      const initial: PreviewTabRecord = {
        tabId,
        webContentsId: null,
        navStatus: { kind: 'Idle' },
        canGoBack: false,
        canGoForward: false,
        zoomFactor: DEFAULT_ZOOM_FACTOR,
        colorScheme: 'system',
        controller: 'none',
        updatedAt,
        lifecycleGeneration,
      }
      return [
        initial,
        replaceMap(tabs, (copy) =>
        {
          copy.set(tabId, initial)
        }),
      ] as const
    })
    yield* emit(tabId, state)
    return toPreviewTabState(state)
  })

  const closeTabUnlocked = Effect.fn('PreviewManager.closeTab')(function* (tabId: string)
  {
    const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId)
    if (!tab) return
    yield* cancelPickElement(tabId)
    if (tab.webContentsId != null)
    {
      const attachment = (yield* Ref.get(attachedRef)).get(tab.webContentsId)
      const ownsWebContents = attachment === undefined || attachment.tabId === tabId
      yield* Effect.all(
        [
          ownsWebContents ? detachControlSession(tab.webContentsId) : Effect.void,
          attachment?.tabId === tabId
            ? detachListeners(tab.webContentsId, attachment.attachmentToken)
            : Effect.void,
        ],
        { concurrency: 2, discard: true },
      )
    }
    const updatedAt = yield* currentIso
    const { favicon: _favicon, ...tabWithoutFavicon } = tab
    const closed: PreviewTabState = {
      ...tabWithoutFavicon,
      webContentsId: null,
      navStatus: { kind: 'Idle' },
      canGoBack: false,
      canGoForward: false,
      zoomFactor: DEFAULT_ZOOM_FACTOR,
      colorScheme: 'system',
      controller: 'none',
      updatedAt,
    }
    yield* SynchronizedRef.update(tabsRef, (tabs) =>
      replaceMap(tabs, (copy) =>
      {
        copy.delete(tabId)
      }),
    )
    yield* emit(tabId, closed)
  })

  const registerWebviewUnlocked = Effect.fn('PreviewManager.registerWebview')(function* (
    tabId: string,
    webContentsId: number,
  )
  {
    const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId)
    if (!tab)
    {
      return yield* new PreviewTabNotFoundError({ tabId })
    }
    const wc = webContents.fromId(webContentsId)
    const mainWindow = yield* Ref.get(mainWindowRef)
    if (
      !wc ||
      wc.isDestroyed() ||
      wc.getType() !== 'webview' ||
      (Option.isSome(mainWindow) && wc.hostWebContents !== mainWindow.value.webContents)
    )
    {
      return yield* new PreviewWebContentsNotFoundError({ tabId, webContentsId })
    }
    const attached = yield* Ref.get(attachedRef)
    const annotationTheme = yield* Ref.get(annotationThemeRef)
    const currentAttachment = attached.get(webContentsId)
    if (currentAttachment && currentAttachment.tabId !== tabId)
    {
      return yield* new PreviewWebContentsNotFoundError({ tabId, webContentsId })
    }
    if (
      tab.webContentsId === webContentsId &&
      currentAttachment?.tabId === tabId &&
      currentAttachment.webContents === wc
    )
    {
      // chromium may have just copied the embedder's zoom onto this guest
      yield* assertTabZoom(tabId)
      yield* attempt({ operation: 'registerWebview.sendTheme', tabId, webContentsId }, () =>
        wc.send(ANNOTATION_THEME_CHANNEL, annotationTheme),
      )
      return
    }
    if (currentAttachment && tab.webContentsId !== webContentsId)
    {
      return yield* new PreviewWebContentsNotFoundError({ tabId, webContentsId })
    }
    const replacedWebContentsId =
      tab.webContentsId != null &&
      (tab.webContentsId !== webContentsId || currentAttachment?.webContents !== wc)
        ? tab.webContentsId
        : null
    // a new guest inherits the app window zoom, never the preview tab zoom
    yield* attempt({ operation: 'registerWebview.restoreZoomFactor', tabId, webContentsId }, () =>
      wc.setZoomFactor(tab.zoomFactor),
    )
    const lifecycleGeneration = yield* nextCounter(tabGenerationSequenceRef)
    // once the source is released, failure leaves the tab explicitly unattached
    const detachFailedTransition = Effect.gen(function* ()
    {
      const updatedAt = yield* currentIso
      const detached = yield* SynchronizedRef.modify(tabsRef, (tabs) =>
      {
        const current = tabs.get(tabId)
        if (!current || current.webContentsId !== tab.webContentsId)
        {
          return [Option.none<PreviewTabRecord>(), tabs] as const
        }
        const { favicon: _favicon, ...currentWithoutFavicon } = current
        const next: PreviewTabRecord = {
          ...currentWithoutFavicon,
          webContentsId: null,
          navStatus:
            current.navStatus.kind === 'Loading' ? current.navStatus : { kind: 'Idle' as const },
          canGoBack: false,
          canGoForward: false,
          controller: 'none',
          updatedAt,
          lifecycleGeneration,
        }
        return [
          Option.some(next),
          replaceMap(tabs, (copy) =>
          {
            copy.set(tabId, next)
          }),
        ] as const
      })
      if (Option.isSome(detached)) yield* emit(tabId, detached.value)
    })
    const attachmentToken = yield* Effect.gen(function* ()
    {
      if (replacedWebContentsId !== null)
      {
        const replacedAttachment = attached.get(replacedWebContentsId)
        const ownsReplacedWebContents =
          replacedAttachment === undefined || replacedAttachment.tabId === tabId
        yield* Effect.all(
          [
            ownsReplacedWebContents ? detachControlSession(replacedWebContentsId) : Effect.void,
            replacedAttachment?.tabId === tabId
              ? detachListeners(replacedWebContentsId, replacedAttachment.attachmentToken)
              : Effect.void,
            cancelPickElement(tabId),
          ],
          { concurrency: 3, discard: true },
        )
      }
      return yield* attachListeners(tabId, wc, lifecycleGeneration)
    }).pipe(Effect.onError(() => detachFailedTransition))
    const registeredAt = yield* currentIso
    const registration = yield* SynchronizedRef.modify(tabsRef, (tabs) =>
    {
      const current = tabs.get(tabId)
      if (!current)
      {
        return [
          Option.none<{ readonly state: PreviewTabRecord; readonly pendingUrl: string | null }>(),
          tabs,
        ] as const
      }
      const pendingUrl = current.navStatus.kind === 'Loading' ? current.navStatus.url : null
      const { favicon: _favicon, ...currentWithoutFavicon } = current
      const next: PreviewTabRecord = {
        ...currentWithoutFavicon,
        webContentsId,
        navStatus: pendingUrl === null ? computeNavStatus(wc) : current.navStatus,
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
        updatedAt: registeredAt,
        lifecycleGeneration,
      }
      return [
        Option.some({
          state: next,
          pendingUrl,
        }),
        replaceMap(tabs, (copy) =>
        {
          copy.set(tabId, next)
        }),
      ] as const
    })
    if (Option.isNone(registration))
    {
      yield* Effect.all([detachControlSession(wc.id), detachListeners(wc.id, attachmentToken)], {
        concurrency: 2,
        discard: true,
      })
      return yield* new PreviewTabNotFoundError({ tabId })
    }
    const { state: registered, pendingUrl } = registration.value
    // a zoom action may have landed while the replacement attached
    yield* assertTabZoom(tabId)
    runFork(restoreControlSession(tabId, wc))
    yield* emit(tabId, registered)
    yield* attempt({ operation: 'registerWebview.sendTheme', tabId, webContentsId }, () =>
      wc.send(ANNOTATION_THEME_CHANNEL, annotationTheme),
    )
    const latestNavStatus = (yield* SynchronizedRef.get(tabsRef)).get(tabId)?.navStatus
    if (
      pendingUrl &&
      latestNavStatus?.kind === 'Loading' &&
      latestNavStatus.url === pendingUrl &&
      wc.getURL() !== pendingUrl
    )
    {
      runFork(
        attemptPromise({ operation: 'registerWebview.loadPendingUrl', tabId, webContentsId }, () =>
          wc.loadURL(pendingUrl),
        ).pipe(Effect.ignore),
      )
    }
  })

  const navigateUnlocked = Effect.fn('PreviewManager.navigate')(function* (
    tabId: string,
    rawUrl: string,
  )
  {
    const url = yield* attempt({ operation: 'navigate.normalizeUrl', tabId }, () =>
      normalizePreviewUrl(rawUrl),
    )
    const lifecycleGeneration = yield* nextCounter(tabGenerationSequenceRef)
    const updatedAt = yield* currentIso
    const pending = yield* SynchronizedRef.modify(tabsRef, (tabs) =>
    {
      const current = tabs.get(tabId)
      const next: PreviewTabRecord = {
        tabId,
        webContentsId: current?.webContentsId ?? null,
        navStatus: {
          kind: 'Loading',
          url,
          title: current?.navStatus.kind === 'Idle' || !current ? '' : current.navStatus.title,
        },
        canGoBack: current?.canGoBack ?? false,
        canGoForward: current?.canGoForward ?? false,
        zoomFactor: current?.zoomFactor ?? DEFAULT_ZOOM_FACTOR,
        colorScheme: current?.colorScheme ?? 'system',
        controller: current?.controller ?? 'none',
        ...(current?.favicon ? { favicon: current.favicon } : {}),
        updatedAt,
        lifecycleGeneration: current?.lifecycleGeneration ?? lifecycleGeneration,
      }
      return [
        next,
        replaceMap(tabs, (copy) =>
        {
          copy.set(tabId, next)
        }),
      ] as const
    })
    yield* emit(tabId, pending)
    if (pending.webContentsId == null) return
    const webContentsId = pending.webContentsId
    const wc = webContents.fromId(webContentsId)
    if (!wc || wc.isDestroyed())
    {
      yield* withAttachmentTransition(
        Effect.gen(function* ()
        {
          const expectedAttachment = (yield* Ref.get(attachedRef)).get(webContentsId)
          const currentTab = (yield* SynchronizedRef.get(tabsRef)).get(tabId)
          const currentWebContents = webContents.fromId(webContentsId)
          if (
            currentTab?.webContentsId !== webContentsId ||
            (currentWebContents && !currentWebContents.isDestroyed())
          )
          {
            return
          }
          yield* Effect.all(
            [
              expectedAttachment === undefined || expectedAttachment.tabId === tabId
                ? detachControlSession(webContentsId)
                : Effect.void,
              expectedAttachment?.tabId === tabId
                ? detachListeners(webContentsId, expectedAttachment.attachmentToken)
                : Effect.void,
              cancelPickElement(tabId),
            ],
            { concurrency: 3, discard: true },
          )
          const detached = yield* SynchronizedRef.modify(tabsRef, (tabs) =>
          {
            const current = tabs.get(tabId)
            if (current?.webContentsId !== webContentsId)
            {
              return [Option.none<PreviewTabRecord>(), tabs] as const
            }
            const { favicon: _favicon, ...currentWithoutFavicon } = current
            const next: PreviewTabRecord = { ...currentWithoutFavicon, webContentsId: null }
            return [
              Option.some(next),
              replaceMap(tabs, (copy) =>
              {
                copy.set(tabId, next)
              }),
            ] as const
          })
          if (Option.isSome(detached)) yield* emit(tabId, detached.value)
        }),
      )
      return
    }
    if (wc.getURL() === url)
    {
      yield* attempt({ operation: 'navigate.reload', tabId, webContentsId: wc.id }, () =>
        wc.reload(),
      )
      return
    }
    yield* attemptPromise({ operation: 'navigate.loadURL', tabId, webContentsId: wc.id }, () =>
      wc.loadURL(url),
    )
  })

  const createTab = (tabId: string) => withTabLifecycle(tabId, createTabUnlocked(tabId))
  const closeTab = (tabId: string) =>
    withTabLifecycle(tabId, withAttachmentTransition(closeTabUnlocked(tabId)))
  const registerWebview = (tabId: string, webContentsId: number) =>
    withTabLifecycle(tabId, withAttachmentTransition(registerWebviewUnlocked(tabId, webContentsId)))
  const navigate = (tabId: string, rawUrl: string) =>
    withTabLifecycle(tabId, navigateUnlocked(tabId, rawUrl))

  const withWebContents = Effect.fn('PreviewManager.withWebContents')(function* (
    operation: string,
    tabId: string,
    use: (wc: Electron.WebContents) => void,
  )
  {
    const wc = yield* requireWebContents(tabId)
    yield* attempt({ operation, tabId, webContentsId: wc.id }, () => use(wc))
  })

  const goBack = (tabId: string) =>
    withWebContents('goBack', tabId, (wc) =>
    {
      if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
    })
  const goForward = (tabId: string) =>
    withWebContents('goForward', tabId, (wc) =>
    {
      if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
    })
  const refresh = (tabId: string) => withWebContents('refresh', tabId, (wc) => wc.reload())
  const hardReload = (tabId: string) =>
    withWebContents('hardReload', tabId, (wc) => wc.reloadIgnoringCache())

  const openDevTools = Effect.fn('PreviewManager.openDevTools')(function* (tabId: string)
  {
    const wc = yield* requireWebContents(tabId)
    if (wc.isDevToolsOpened())
    {
      yield* attempt({ operation: 'openDevTools.focus', tabId, webContentsId: wc.id }, () =>
        wc.devToolsWebContents?.focus(),
      )
      return
    }
    yield* detachControlSession(wc.id)
    yield* attempt({ operation: 'openDevTools', tabId, webContentsId: wc.id }, () =>
    {
      wc.once('devtools-closed', () =>
      {
        if (!wc.isDestroyed())
        {
          runFork(withTabLifecycle(tabId, restoreControlSession(tabId, wc)))
        }
      })
      wc.openDevTools({ mode: 'detach' })
    })
  })

  const setAnnotationTheme = Effect.fn('PreviewManager.setAnnotationTheme')(function* (
    theme: DesktopPreviewAnnotationTheme,
  )
  {
    yield* Ref.set(annotationThemeRef, theme)
    const tabs = yield* SynchronizedRef.get(tabsRef)
    yield* Effect.forEach(
      tabs.values(),
      (tab) =>
      {
        if (tab.webContentsId == null) return Effect.void
        const wc = webContents.fromId(tab.webContentsId)
        return !wc || wc.isDestroyed()
          ? Effect.void
          : attempt(
              {
                operation: 'setAnnotationTheme',
                tabId: tab.tabId,
                webContentsId: tab.webContentsId,
              },
              () => wc.send(ANNOTATION_THEME_CHANNEL, theme),
            ).pipe(Effect.ignore)
      },
      { discard: true },
    )
  })

  const applyZoom = Effect.fn('PreviewManager.applyZoom')(function* (
    tabId: string,
    transform: (current: number) => number,
  )
  {
    const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId)
    if (!tab) return
    const next = transform(tab.zoomFactor)
    if (Math.abs(next - tab.zoomFactor) < ZOOM_EPSILON) return
    if (tab.webContentsId != null)
    {
      const wc = webContents.fromId(tab.webContentsId)
      if (wc && !wc.isDestroyed())
      {
        yield* attempt({ operation: 'applyZoom', tabId, webContentsId: wc.id }, () =>
          wc.setZoomFactor(next),
        )
      }
    }
    yield* update(tabId, { zoomFactor: next })
  })

  const reapplyZoom = Effect.fn('PreviewManager.reapplyZoom')(function* ()
  {
    const tabIds = Array.from((yield* SynchronizedRef.get(tabsRef)).keys())
    yield* Effect.forEach(tabIds, assertTabZoom, { discard: true })
  })

  // emulated media lives on the CDP debugger session, not the WebContents, so
  // it is lost whenever the session detaches (webview swap, DevTools
  // open/close) and must be re-applied after every (re)attach.
  const applyColorScheme = Effect.fn('PreviewManager.applyColorScheme')(function* (
    tabId: string,
    wc: Electron.WebContents,
    colorScheme: DesktopPreviewColorScheme,
  )
  {
    yield* ensureControlSession(wc)
    yield* attemptPromise({ operation: 'applyColorScheme', tabId, webContentsId: wc.id }, () =>
      wc.debugger.sendCommand('Emulation.setEmulatedMedia', {
        features: [
          {
            name: 'prefers-color-scheme',
            // an empty value clears the override so the page follows the OS.
            value: colorScheme === 'system' ? '' : colorScheme,
          },
        ],
      }),
    )
  })

  // re-establish the control session after a detach, restoring any
  // color-scheme override the tab carries. The scheme is read after the
  // session attaches so a concurrent setColorScheme is not overwritten with
  // a stale snapshot.
  const restoreControlSession = (tabId: string, wc: Electron.WebContents) =>
    SynchronizedRef.get(tabsRef).pipe(
      Effect.flatMap((tabs) =>
      {
        const tab = tabs.get(tabId)
        if (tab?.webContentsId !== wc.id) return Effect.void
        return ensureControlSession(wc).pipe(
          Effect.andThen(SynchronizedRef.get(tabsRef)),
          Effect.flatMap((latestTabs) =>
          {
            const latest = latestTabs.get(tabId)
            if (
              latest?.lifecycleGeneration !== tab.lifecycleGeneration ||
              latest.webContentsId !== wc.id
            )
            {
              return detachControlSession(wc.id)
            }
            return latest.colorScheme === 'system'
              ? Effect.void
              : applyColorScheme(tabId, wc, latest.colorScheme)
          }),
        )
      }),
      Effect.ignore,
    )

  const setColorScheme = Effect.fn('PreviewManager.setColorScheme')(function* (
    tabId: string,
    colorScheme: DesktopPreviewColorScheme,
  )
  {
    const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId)
    if (!tab)
    {
      return yield* new PreviewTabNotFoundError({ tabId })
    }
    if (tab.colorScheme !== colorScheme)
    {
      // record the choice even when the CDP call below can't run yet (no
      // webview, DevTools holding the debugger) — it is re-applied on the
      // next control-session (re)attach.
      yield* update(tabId, { colorScheme })
    }
    // re-read after the update: registerWebview may have swapped the guest
    // in the meantime and the override must land on the current one.
    const webContentsId = (yield* SynchronizedRef.get(tabsRef)).get(tabId)?.webContentsId
    if (webContentsId == null) return
    const wc = webContents.fromId(webContentsId)
    if (!wc || wc.isDestroyed()) return
    yield* applyColorScheme(tabId, wc, colorScheme)
  })

  return {
    setMainWindow,
    createTab,
    closeTab,
    registerWebview,
    navigate,
    goBack,
    goForward,
    refresh,
    hardReload,
    openDevTools,
    setAnnotationTheme,
    applyZoom,
    reapplyZoom,
    setColorScheme,
    withWebContents,
  }
}
