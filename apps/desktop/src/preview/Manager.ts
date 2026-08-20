// apps/desktop/src/preview/Manager.ts
// owns desktop preview tabs, automation, picking, and recording lifecycles

// desktop side of the in-app browser preview.
//
// hosts per-tab Chromium WebContents references (the actual <webview>
// elements live in the renderer; we only attach listeners and forward state
// here). Single layer-scoped browser session partition.
import type {
  DesktopPreviewAnnotationTheme,
  DesktopPreviewColorScheme,
  DesktopPreviewTabDefaults,
  PreviewAnnotationPayload,
  PreviewAnnotationRect,
  DesktopPreviewRecordingArtifact,
  DesktopPreviewRecordingFrame,
  DesktopPreviewScreenshotArtifact,
  PreviewAutomationClickInput,
  PreviewAutomationActionEvent,
  PreviewAutomationEvaluateInput,
  PreviewAutomationPressInput,
  PreviewAutomationScrollInput,
  PreviewAutomationSnapshot,
  PreviewAutomationStatus,
  PreviewAutomationTypeInput,
  PreviewAutomationWaitForInput,
} from '@t3tools/contracts'
import { HostProcessPlatform } from '@t3tools/shared/hostProcess'
import {
  type BrowserWindow,
  type Session,
  clipboard,
  nativeImage,
  shell,
  webContents,
} from 'electron'
import * as Cause from 'effect/Cause'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Ref from 'effect/Ref'
import * as Schema from 'effect/Schema'
import * as Semaphore from 'effect/Semaphore'
import * as Scope from 'effect/Scope'
import * as SynchronizedRef from 'effect/SynchronizedRef'

import * as DesktopEnvironment from '../app/DesktopEnvironment.ts'
import * as BrowserSession from './BrowserSession.ts'
import { HUMAN_INPUT_CHANNEL, MOUSE_NAVIGATE_CHANNEL } from './GuestProtocol.ts'
import {
  PreviewArtifactImageLoadError,
  PreviewArtifactPathOutsideDirectoryError,
  PreviewAutomationControlInterruptedError,
  PreviewAutomationDebuggerAttachedError,
  PreviewAutomationDevToolsOpenError,
  PreviewAutomationEvaluationError,
  PreviewAutomationInvalidSelectorError,
  type PreviewManagerError,
  PreviewOperationError,
  PreviewTabNotFoundError,
  PreviewWebContentsNotFoundError,
  PreviewWebviewNotInitializedError,
  type PreviewAutomationSelectorKind,
  isPreviewAutomationControlInterruptedError,
  isPreviewAutomationEvaluationError,
  isPreviewAutomationInvalidSelectorError,
  isPreviewOperationError,
  previewAutomationEvaluationDetail,
} from './ManagerErrors.ts'
import {
  DEFAULT_ZOOM_FACTOR,
  DIAGNOSTIC_BUFFER_LIMIT,
  MAX_ARTIFACT_SITE_SLUG_LENGTH,
  ZOOM_EPSILON,
  ZOOM_LEVELS,
  type BrowserControlSession,
  type BrowserDiagnostics,
  type ExpectedAgentInput,
  type Listener,
  type ManagedListeners,
  type PickSession,
  type PointerEventListener,
  type PreviewInputSignal,
  type PreviewNavStatus,
  type PreviewOperationContext,
  type PreviewTabRecord,
  type PreviewTabState,
  type RecordingFrameListener,
  type RecordingOwner,
} from './ManagerTypes.ts'
import { playwrightInjectedRuntimeInstallExpression } from './PlaywrightInjectedRuntime.ts'
import { createAutomationOperations } from './ManagerAutomation.ts'
import { createPickRecordingOperations } from './ManagerPickRecording.ts'
import { createTabOperations } from './ManagerTabs.ts'
import { captureFavicon, safeHttpOrigin, selectFaviconCandidates } from './FaviconCapture.ts'

export type { PreviewNavStatus, PreviewTabState } from './ManagerTypes.ts'
export {
  isPreviewAutomationControlInterruptedError,
  isPreviewAutomationEvaluationError,
  isPreviewAutomationInvalidSelectorError,
  isPreviewOperationError,
  PreviewArtifactImageLoadError,
  PreviewArtifactPathOutsideDirectoryError,
  PreviewAutomationControlInterruptedError,
  PreviewAutomationCoordinatesOutsideViewportError,
  PreviewAutomationDebuggerAttachedError,
  PreviewAutomationDevToolsOpenError,
  PreviewAutomationEvaluationDetailKind,
  PreviewAutomationEvaluationError,
  PreviewAutomationInvalidSelectorError,
  PreviewAutomationResultTooLargeError,
  PreviewAutomationSelectorKind,
  PreviewAutomationTargetNotEditableError,
  PreviewAutomationTargetNotFoundError,
  PreviewAutomationTimeoutError,
  PreviewManagerError,
  PreviewOperationError,
  PreviewRecordingAlreadyActiveError,
  PreviewTabNotFoundError,
  PreviewWebContentsNotFoundError,
  PreviewWebviewNotInitializedError,
} from './ManagerErrors.ts'

const encodeUnknownJson = Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)
const DEFAULT_ANNOTATION_THEME: DesktopPreviewAnnotationTheme = {
  colorScheme: 'light',
  radius: '0.625rem',
  background: 'white',
  foreground: 'oklch(0.269 0 0)',
  popover: 'white',
  popoverForeground: 'oklch(0.269 0 0)',
  primary: 'oklch(0.488 0.217 264)',
  primaryForeground: 'white',
  muted: 'rgb(0 0 0 / 4%)',
  mutedForeground: 'oklch(0.556 0 0)',
  accent: 'rgb(0 0 0 / 4%)',
  accentForeground: 'oklch(0.269 0 0)',
  border: 'rgb(0 0 0 / 8%)',
  input: 'rgb(0 0 0 / 10%)',
  ring: 'oklch(0.488 0.217 264)',
  fontSans: 'system-ui, sans-serif',
  fontMono: 'ui-monospace, monospace',
}

const artifactSiteSlug = (rawUrl: string): string =>
{
  try
  {
    const url = new URL(rawUrl)
    const slug = url.hostname
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, MAX_ARTIFACT_SITE_SLUG_LENGTH)
      .replace(/-+$/g, '')
    return slug || 'site'
  }
  catch
  {
    return 'site'
  }
}

interface CdpEvaluationResult
{
  readonly result?: {
    readonly value?: unknown
    readonly description?: string
  }
  readonly exceptionDetails?: {
    readonly text?: string
    readonly exception?: { readonly description?: string }
  }
}
const normalizeCaptureRect = (value: unknown): PreviewAnnotationRect | null =>
{
  if (typeof value !== 'object' || value === null) return null
  const rect = value as Record<string, unknown>
  const x = rect['x']
  const y = rect['y']
  const width = rect['width']
  const height = rect['height']
  if (
    typeof x !== 'number' ||
    !Number.isFinite(x) ||
    typeof y !== 'number' ||
    !Number.isFinite(y) ||
    typeof width !== 'number' ||
    !Number.isFinite(width) ||
    typeof height !== 'number' ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  )
  {
    return null
  }
  return {
    x: Math.max(0, Math.floor(x)),
    y: Math.max(0, Math.floor(y)),
    width: Math.max(1, Math.ceil(width)),
    height: Math.max(1, Math.ceil(height)),
  }
}

const captureAnnotationScreenshot = (
  tabId: string,
  wc: Electron.WebContents,
  cropRect: PreviewAnnotationRect | null,
): Effect.Effect<PreviewAnnotationPayload['screenshot'], PreviewManagerError> =>
  Effect.tryPromise({
    try: () =>
      wc.capturePage(
        cropRect
          ? {
              x: cropRect.x,
              y: cropRect.y,
              width: cropRect.width,
              height: cropRect.height,
            }
          : undefined,
      ),
    catch: (cause) =>
      new PreviewOperationError({
        operation: 'captureAnnotationScreenshot',
        tabId,
        webContentsId: wc.id,
        cause,
      }),
  }).pipe(
    Effect.map((image) =>
    {
      const size = image.getSize()
      return {
        dataUrl: image.toDataURL(),
        width: size.width,
        height: size.height,
        cropRect: cropRect ?? { x: 0, y: 0, width: size.width, height: size.height },
      }
    }),
  )

const findZoomStep = (current: number): number =>
{
  const index = ZOOM_LEVELS.findIndex(
    (level) => Math.abs(level - current) < ZOOM_EPSILON || level > current,
  )
  if (index < 0) return ZOOM_LEVELS.length - 1
  return Math.abs(ZOOM_LEVELS[index]! - current) < ZOOM_EPSILON ? index : index - 1
}

const nextZoomLevel = (current: number, direction: 'in' | 'out'): number =>
{
  const step = findZoomStep(current)
  if (direction === 'in')
  {
    return ZOOM_LEVELS[Math.min(step + 1, ZOOM_LEVELS.length - 1)] ?? current
  }
  return ZOOM_LEVELS[Math.max(step - 1, 0)] ?? current
}
const APP_FORWARDED_SHORTCUTS: ReadonlyArray<{
  key: string
  meta: boolean
  shift: boolean
  control: boolean
}> = Object.freeze([
  // mod+shift+J -> preview.toggle
  { key: 'j', meta: true, shift: true, control: false },
  // mod+K -> command palette
  { key: 'k', meta: true, shift: false, control: false },
  // mod+, -> settings (macOS convention)
  { key: ',', meta: true, shift: false, control: false },
  // mod+W -> close tab/panel
  { key: 'w', meta: true, shift: false, control: false },
])

const isPreviewInputSignal = (value: unknown): value is PreviewInputSignal =>
{
  if (typeof value !== 'object' || value === null || !('kind' in value)) return false
  if (value.kind === 'pointer')
  {
    return (
      'x' in value &&
      typeof value.x === 'number' &&
      'y' in value &&
      typeof value.y === 'number' &&
      'button' in value &&
      typeof value.button === 'number'
    )
  }
  return (
    value.kind === 'key' &&
    'key' in value &&
    typeof value.key === 'string' &&
    'code' in value &&
    typeof value.code === 'string'
  )
}

const inputSignalsMatch = (left: PreviewInputSignal, right: PreviewInputSignal): boolean =>
{
  if (left.kind !== right.kind) return false
  if (left.kind === 'pointer' && right.kind === 'pointer')
  {
    return (
      Math.abs(left.x - right.x) <= 1 &&
      Math.abs(left.y - right.y) <= 1 &&
      left.button === right.button
    )
  }
  return (
    left.kind === 'key' &&
    right.kind === 'key' &&
    left.key === right.key &&
    left.code === right.code
  )
}

const makeNativeOperations = Effect.fn('PreviewManager.makeOperations')(function* (
  artifactDirectory: string,
)
{
  const fileSystem = yield* FileSystem.FileSystem
  const hostPlatform = yield* HostProcessPlatform
  const path = yield* Path.Path
  const parentScope = yield* Scope.Scope
  const context = yield* Effect.context<never>()
  const runFork = Effect.runForkWith(context)
  const resolvedArtifactDirectory = path.resolve(artifactDirectory)
  const playwrightInstallExpression = yield* Effect.cached(
    playwrightInjectedRuntimeInstallExpression(),
  )

  const annotationThemeRef = yield* Ref.make(DEFAULT_ANNOTATION_THEME)
  const mainWindowRef = yield* Ref.make<Option.Option<BrowserWindow>>(Option.none())
  const tabsRef = yield* SynchronizedRef.make<ReadonlyMap<string, PreviewTabRecord>>(new Map())
  // webcontents ownership moves are global even when the source tabs differ
  const attachmentTransitionSemaphore = yield* Semaphore.make(1)
  const tabLifecycleSemaphoresRef = yield* SynchronizedRef.make<
    ReadonlyMap<string, Semaphore.Semaphore>
  >(new Map())
  const attachedRef = yield* Ref.make<ReadonlyMap<number, ManagedListeners>>(new Map())
  const listenersRef = yield* Ref.make<ReadonlySet<Listener>>(new Set())
  const pointerEventListenersRef = yield* Ref.make<ReadonlySet<PointerEventListener>>(new Set())
  const recordingFrameListenersRef = yield* Ref.make<ReadonlySet<RecordingFrameListener>>(new Set())
  const pickSessionsRef = yield* Ref.make<ReadonlyMap<string, PickSession>>(new Map())
  const controlSessionsRef = yield* SynchronizedRef.make<
    ReadonlyMap<number, BrowserControlSession>
  >(new Map())
  const diagnosticsRef = yield* Ref.make<ReadonlyMap<number, BrowserDiagnostics>>(new Map())
  const expectedAgentInputsRef = yield* Ref.make<
    ReadonlyMap<string, ReadonlyArray<ExpectedAgentInput>>
  >(new Map())
  const controlEpochRef = yield* Ref.make<ReadonlyMap<string, number>>(new Map())
  const actionTimelineRef = yield* Ref.make<
    ReadonlyMap<string, ReadonlyArray<PreviewAutomationActionEvent>>
  >(new Map())
  const actionSequenceRef = yield* Ref.make(0)
  const artifactSequenceRef = yield* Ref.make(0)
  const pointerSequenceRef = yield* Ref.make(0)
  const pickSequenceRef = yield* Ref.make(0)
  const recordingSequenceRef = yield* Ref.make(0)
  const tabGenerationSequenceRef = yield* Ref.make(0)
  const recordingOwnerRef = yield* Ref.make<Option.Option<RecordingOwner>>(Option.none())

  const attempt = <A>(errorContext: PreviewOperationContext, evaluate: () => A) =>
    Effect.try({
      try: evaluate,
      catch: (cause) => new PreviewOperationError({ ...errorContext, cause }),
    })
  const attemptPromise = <A>(
    errorContext: PreviewOperationContext,
    evaluate: () => PromiseLike<A>,
  ) =>
    Effect.tryPromise({
      try: evaluate,
      catch: (cause) => new PreviewOperationError({ ...errorContext, cause }),
    })
  const currentIso = DateTime.now.pipe(Effect.map(DateTime.formatIso))
  const currentMillis = Clock.currentTimeMillis
  const encodeJson = (errorContext: PreviewOperationContext, value: unknown) =>
    encodeUnknownJson(value).pipe(
      Effect.mapError((cause) => new PreviewOperationError({ ...errorContext, cause })),
    )
  const nextCounter = (ref: Ref.Ref<number>) =>
    Ref.modify(ref, (value) => [value, value + 1] as const)
  const setRecordingBackgroundThrottling = Effect.fn(
    'PreviewManager.setRecordingBackgroundThrottling',
  )(function* (enabled: boolean)
  {
    const mainWindow = yield* Ref.get(mainWindowRef)
    if (Option.isNone(mainWindow) || mainWindow.value.isDestroyed()) return
    yield* attempt({ operation: 'setRecordingBackgroundThrottling' }, () =>
      mainWindow.value.webContents.setBackgroundThrottling(enabled),
    )
  })
  const withTabLifecycle = <A, E, R>(
    tabId: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    SynchronizedRef.modifyEffect(tabLifecycleSemaphoresRef, (semaphores) =>
    {
      const existing = semaphores.get(tabId)
      if (existing) return Effect.succeed([existing, semaphores] as const)
      return Semaphore.make(1).pipe(
        Effect.map(
          (semaphore) =>
            [
              semaphore,
              replaceMap(semaphores, (copy) =>
              {
                copy.set(tabId, semaphore)
              }),
            ] as const,
        ),
      )
    }).pipe(Effect.flatMap((semaphore) => semaphore.withPermit(effect)))
  const withAttachmentTransition = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> => attachmentTransitionSemaphore.withPermit(effect)
  const replaceMap = <K, V>(
    source: ReadonlyMap<K, V>,
    update: (copy: Map<K, V>) => void,
  ): ReadonlyMap<K, V> =>
  {
    const copy = new Map(source)
    update(copy)
    return copy
  }

  const deliverEvent = (
    eventKind: 'state-change' | 'recording-frame' | 'pointer-event',
    tabId: string,
    delivery: () => Effect.Effect<void>,
  ) =>
    Effect.suspend(delivery).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning('Desktop preview event listener failed.', {
              eventKind,
              tabId,
              cause,
            }),
      ),
    )

  const toPreviewTabState = (state: PreviewTabState): PreviewTabState => ({
    tabId: state.tabId,
    webContentsId: state.webContentsId,
    navStatus: state.navStatus,
    canGoBack: state.canGoBack,
    canGoForward: state.canGoForward,
    zoomFactor: state.zoomFactor,
    colorScheme: state.colorScheme,
    audioMuted: state.audioMuted,
    audible: state.audible,
    controller: state.controller,
    ...(state.favicon ? { favicon: state.favicon } : {}),
    updatedAt: state.updatedAt,
  })

  const emit = Effect.fn('PreviewManager.emit')(function* (tabId: string, state: PreviewTabState)
  {
    const listeners = yield* Ref.get(listenersRef)
    const publicState = toPreviewTabState(state)
    yield* Effect.forEach(
      listeners,
      (listener) => deliverEvent('state-change', tabId, () => listener(tabId, publicState)),
      { discard: true },
    )
  })

  const emitIfCurrent = Effect.fn('PreviewManager.emitIfCurrent')(function* (
    tabId: string,
    state: PreviewTabState,
  )
  {
    if ((yield* SynchronizedRef.get(tabsRef)).get(tabId) === state)
    {
      yield* emit(tabId, state)
    }
  })

  const update = Effect.fn('PreviewManager.update')(function* (
    tabId: string,
    patch: Partial<PreviewTabState>,
    lifecycleGeneration?: number,
  )
  {
    const updatedAt = yield* currentIso
    const next = yield* SynchronizedRef.modify(tabsRef, (tabs) =>
    {
      const current = tabs.get(tabId)
      if (
        !current ||
        (lifecycleGeneration !== undefined && current.lifecycleGeneration !== lifecycleGeneration)
      )
      {
        return [Option.none<PreviewTabRecord>(), tabs] as const
      }
      const state: PreviewTabRecord = { ...current, ...patch, updatedAt }
      return [
        Option.some(state),
        replaceMap(tabs, (copy) =>
        {
          copy.set(tabId, state)
        }),
      ] as const
    })
    if (Option.isSome(next)) yield* emitIfCurrent(tabId, next.value)
  })

  const syncTabAudible = Effect.fn('PreviewManager.syncTabAudible')(function* (
    tabId: string,
    wc: Electron.WebContents,
    audible: boolean,
  )
  {
    if (wc.isDestroyed()) return
    const updatedAt = yield* currentIso
    const next = yield* SynchronizedRef.modify(tabsRef, (tabs) =>
    {
      const current = tabs.get(tabId)
      if (
        !current ||
        current.webContentsId !== wc.id ||
        webContents.fromId(wc.id) !== wc ||
        current.audible === audible
      )
      {
        return [Option.none<PreviewTabRecord>(), tabs] as const
      }
      const state: PreviewTabRecord = { ...current, audible, updatedAt }
      return [
        Option.some(state),
        replaceMap(tabs, (copy) =>
        {
          copy.set(tabId, state)
        }),
      ] as const
    })
    if (Option.isSome(next)) yield* emitIfCurrent(tabId, next.value)
  })

  const requireWebContents = Effect.fn('PreviewManager.requireWebContents')(function* (
    tabId: string,
  )
  {
    const tabs = yield* SynchronizedRef.get(tabsRef)
    const tab = tabs.get(tabId)
    if (!tab)
    {
      return yield* new PreviewTabNotFoundError({ tabId })
    }
    if (tab.webContentsId == null)
    {
      return yield* new PreviewWebviewNotInitializedError({ tabId })
    }
    const wc = webContents.fromId(tab.webContentsId)
    if (!wc || wc.isDestroyed())
    {
      return yield* new PreviewWebContentsNotFoundError({
        tabId,
        webContentsId: tab.webContentsId,
      })
    }
    return wc
  })

  const resolveArtifactPath = (artifactPath: string) =>
    attempt({ operation: 'resolveArtifactPath', artifactPath }, () =>
    {
      const resolvedPath = path.resolve(artifactPath)
      const relativePath = path.relative(resolvedArtifactDirectory, resolvedPath)
      if (
        relativePath.length === 0 ||
        relativePath === '..' ||
        relativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativePath)
      )
      {
        return null
      }
      return resolvedPath
    }).pipe(
      Effect.flatMap((resolvedPath) =>
        resolvedPath === null
          ? Effect.fail(
              new PreviewArtifactPathOutsideDirectoryError({
                artifactPath,
                artifactDirectory: resolvedArtifactDirectory,
              }),
            )
          : Effect.succeed(resolvedPath),
      ),
    )

  const tabIdForWebContents = Effect.fn('PreviewManager.tabIdForWebContents')(function* (
    webContentsId: number,
  )
  {
    const tabs = yield* SynchronizedRef.get(tabsRef)
    return (
      Array.from(tabs.entries()).find(([, tab]) => tab.webContentsId === webContentsId)?.[0] ?? null
    )
  })

  const pushBounded = <A>(buffer: ReadonlyArray<A>, entry: A): ReadonlyArray<A> =>
    [...buffer, entry].slice(-DIAGNOSTIC_BUFFER_LIMIT)

  const captureDiagnosticMessage = Effect.fn('PreviewManager.captureDiagnosticMessage')(function* (
    webContentsId: number,
    method: string,
    params: Record<string, unknown>,
  )
  {
    const timestamp = yield* currentIso
    yield* Ref.update(diagnosticsRef, (allDiagnostics) =>
    {
      const current = allDiagnostics.get(webContentsId)
      if (!current) return allDiagnostics
      const requestId = typeof params['requestId'] === 'string' ? params['requestId'] : null
      const next = (() =>
      {
        if (method === 'Runtime.consoleAPICalled')
        {
          const args = Array.isArray(params['args']) ? params['args'] : []
          const text = args
            .map((arg) =>
            {
              if (typeof arg !== 'object' || arg === null) return String(arg)
              const value = arg as Record<string, unknown>
              return String(value['value'] ?? value['description'] ?? '')
            })
            .join(' ')
          return {
            ...current,
            consoleEntries: pushBounded(current.consoleEntries, {
              level: typeof params['type'] === 'string' ? params['type'] : 'log',
              text,
              timestamp,
              source: 'console',
            }),
          }
        }
        if (method === 'Runtime.exceptionThrown')
        {
          const details =
            typeof params['exceptionDetails'] === 'object' && params['exceptionDetails'] !== null
              ? (params['exceptionDetails'] as Record<string, unknown>)
              : {}
          return {
            ...current,
            consoleEntries: pushBounded(current.consoleEntries, {
              level: 'error',
              text: String(details['text'] ?? 'Uncaught exception'),
              timestamp,
              source: 'exception',
            }),
          }
        }
        if (method === 'Log.entryAdded')
        {
          const entry =
            typeof params['entry'] === 'object' && params['entry'] !== null
              ? (params['entry'] as Record<string, unknown>)
              : {}
          return {
            ...current,
            consoleEntries: pushBounded(current.consoleEntries, {
              level: typeof entry['level'] === 'string' ? entry['level'] : 'info',
              text: String(entry['text'] ?? ''),
              timestamp,
              source: typeof entry['source'] === 'string' ? entry['source'] : 'log',
            }),
          }
        }
        if (method === 'Network.requestWillBeSent' && requestId)
        {
          const request =
            typeof params['request'] === 'object' && params['request'] !== null
              ? (params['request'] as Record<string, unknown>)
              : {}
          return {
            ...current,
            requests: replaceMap(current.requests, (copy) =>
            {
              copy.set(requestId, {
                url: String(request['url'] ?? ''),
                method: String(request['method'] ?? 'GET'),
              })
            }),
          }
        }
        if (method === 'Network.responseReceived' && requestId)
        {
          const request = current.requests.get(requestId)
          const response =
            typeof params['response'] === 'object' && params['response'] !== null
              ? (params['response'] as Record<string, unknown>)
              : {}
          const status = typeof response['status'] === 'number' ? response['status'] : null
          return request && status !== null && status >= 400
            ? {
                ...current,
                networkEntries: pushBounded(current.networkEntries, {
                  ...request,
                  status,
                  failed: true,
                  timestamp,
                }),
              }
            : current
        }
        if (method === 'Network.loadingFailed' && requestId)
        {
          const request = current.requests.get(requestId)
          return {
            ...current,
            requests: replaceMap(current.requests, (copy) =>
            {
              copy.delete(requestId)
            }),
            networkEntries: request
              ? pushBounded(current.networkEntries, {
                  ...request,
                  status: null,
                  failed: true,
                  errorText: String(params['errorText'] ?? 'Network request failed'),
                  timestamp,
                })
              : current.networkEntries,
          }
        }
        if (method === 'Network.loadingFinished' && requestId)
        {
          return {
            ...current,
            requests: replaceMap(current.requests, (copy) =>
            {
              copy.delete(requestId)
            }),
          }
        }
        return current
      })()
      return replaceMap(allDiagnostics, (copy) =>
      {
        copy.set(webContentsId, next)
      })
    })
  })

  const detachControlSession = Effect.fn('PreviewManager.detachControlSession')(function* (
    webContentsId: number,
  )
  {
    const control = yield* SynchronizedRef.modify(controlSessionsRef, (sessions) => [
      sessions.get(webContentsId),
      replaceMap(sessions, (copy) =>
      {
        copy.delete(webContentsId)
      }),
    ])
    if (control)
    {
      yield* Scope.close(control.scope, Exit.void).pipe(Effect.ignore)
      return
    }
    yield* Ref.update(diagnosticsRef, (diagnostics) =>
      replaceMap(diagnostics, (copy) =>
      {
        copy.delete(webContentsId)
      }),
    )
  })

  const ensureControlSession = Effect.fn('PreviewManager.ensureControlSession')(function* (
    wc: Electron.WebContents,
  )
  {
    return yield* SynchronizedRef.modifyEffect(
      controlSessionsRef,
      (
        sessions,
      ): Effect.Effect<
        readonly [BrowserControlSession, ReadonlyMap<number, BrowserControlSession>],
        PreviewManagerError
      > =>
      {
        const existing = sessions.get(wc.id)
        if (existing) return Effect.succeed([existing, sessions] as const)
        if (wc.isDevToolsOpened())
        {
          return Effect.fail(
            new PreviewAutomationDevToolsOpenError({
              webContentsId: wc.id,
            }),
          )
        }
        if (wc.debugger.isAttached())
        {
          return Effect.fail(
            new PreviewAutomationDebuggerAttachedError({
              webContentsId: wc.id,
            }),
          )
        }
        const createControlSession = Effect.fn('PreviewManager.createControlSession')(function* ()
        {
          const semaphore = yield* Semaphore.make(1)
          const scope = yield* Scope.fork(parentScope, 'sequential')
          const handleDebuggerMessage = Effect.fn('PreviewManager.handleDebuggerMessage')(
            function* (method: string, params: Record<string, unknown>)
            {
              if (method === 'Page.screencastFrame')
              {
                const sessionId = params['sessionId']
                if (typeof sessionId === 'number')
                {
                  yield* attemptPromise(
                    {
                      operation: 'ackScreencastFrame',
                      webContentsId: wc.id,
                    },
                    () => wc.debugger.sendCommand('Page.screencastFrameAck', { sessionId }),
                  ).pipe(Effect.ignore)
                }
                const tabId = yield* tabIdForWebContents(wc.id)
                const metadata =
                  typeof params['metadata'] === 'object' && params['metadata'] !== null
                    ? (params['metadata'] as Record<string, unknown>)
                    : {}
                if (tabId && typeof params['data'] === 'string')
                {
                  const receivedAt = yield* currentIso
                  const listeners = yield* Ref.get(recordingFrameListenersRef)
                  const frame: DesktopPreviewRecordingFrame = {
                    tabId,
                    data: params['data'],
                    width:
                      typeof metadata['deviceWidth'] === 'number' ? metadata['deviceWidth'] : 0,
                    height:
                      typeof metadata['deviceHeight'] === 'number' ? metadata['deviceHeight'] : 0,
                    receivedAt,
                  }
                  yield* Effect.forEach(
                    listeners,
                    (listener) =>
                      deliverEvent('recording-frame', frame.tabId, () => listener(frame)),
                    { discard: true },
                  )
                }
              }
              yield* captureDiagnosticMessage(wc.id, method, params)
            },
          )
          const onMessage: BrowserControlSession['onMessage'] = (_event, method, params) =>
          {
            runFork(handleDebuggerMessage(method, params))
          }
          const onDestroyed = () =>
          {
            runFork(detachControlSession(wc.id))
          }
          yield* Scope.addFinalizer(
            scope,
            Effect.all(
              [
                Ref.update(diagnosticsRef, (diagnostics) =>
                  replaceMap(diagnostics, (copy) =>
                  {
                    copy.delete(wc.id)
                  }),
                ),
                attempt({ operation: 'detachControlSession', webContentsId: wc.id }, () =>
                {
                  wc.off('destroyed', onDestroyed)
                  wc.debugger.off('message', onMessage)
                  if (wc.debugger.isAttached()) wc.debugger.detach()
                }).pipe(Effect.ignore),
              ],
              { discard: true },
            ),
          )
          const control: BrowserControlSession = {
            webContentsId: wc.id,
            semaphore,
            scope,
            onMessage,
          }
          const initialize = Effect.fn('PreviewManager.initializeControlSession')(function* ()
          {
            yield* Ref.update(diagnosticsRef, (diagnostics) =>
              replaceMap(diagnostics, (copy) =>
              {
                copy.set(wc.id, {
                  consoleEntries: [],
                  networkEntries: [],
                  requests: new Map(),
                })
              }),
            )
            yield* attempt({ operation: 'attachDebuggerListeners', webContentsId: wc.id }, () =>
            {
              wc.on('destroyed', onDestroyed)
              wc.debugger.on('message', onMessage)
              wc.debugger.attach('1.3')
            })
            yield* Effect.all(
              ['Runtime.enable', 'Accessibility.enable', 'Network.enable', 'Log.enable'].map(
                (method) =>
                  attemptPromise(
                    { operation: `initializeDebugger.${method}`, webContentsId: wc.id },
                    () => wc.debugger.sendCommand(method),
                  ),
              ),
              { concurrency: 'unbounded', discard: true },
            )
            return [
              control,
              replaceMap(sessions, (copy) =>
              {
                copy.set(wc.id, control)
              }),
            ] as const
          })
          return yield* initialize().pipe(
            Effect.onError(() => Scope.close(scope, Exit.void).pipe(Effect.ignore)),
          )
        })
        return createControlSession()
      },
    )
  })

  const pushAction = (tabId: string, event: PreviewAutomationActionEvent) =>
    Ref.update(actionTimelineRef, (timelines) =>
      replaceMap(timelines, (copy) =>
      {
        copy.set(tabId, [...(timelines.get(tabId) ?? []), event].slice(-200))
      }),
    )
  const replaceAction = (tabId: string, event: PreviewAutomationActionEvent) =>
    Ref.update(actionTimelineRef, (timelines) =>
    {
      const timeline = timelines.get(tabId)
      if (!timeline) return timelines
      return replaceMap(timelines, (copy) =>
      {
        copy.set(
          tabId,
          timeline.map((candidate) => (candidate.id === event.id ? event : candidate)),
        )
      })
    })

  type SendCommand = (
    method: string,
    commandParams?: Record<string, unknown>,
  ) => Effect.Effect<unknown, PreviewManagerError>

  const prepareAutomationInput = Effect.fn('PreviewManager.prepareAutomationInput')(function* (
    send: SendCommand,
    enableRuntime: boolean,
  )
  {
    yield* Effect.all(
      [
        ...(enableRuntime ? [send('Runtime.enable')] : []),
        send('Input.setIgnoreInputEvents', { ignore: false }),
      ],
      { concurrency: 2, discard: true },
    )
  })

  const withControlSession = Effect.fn('PreviewManager.withControlSession')(function* <A>(
    tabId: string,
    wc: Electron.WebContents,
    action: string,
    use: (send: SendCommand, sendCleanup: SendCommand) => Effect.Effect<A, PreviewManagerError>,
  )
  {
    const sequence = yield* nextCounter(actionSequenceRef)
    const startedAt = yield* currentIso
    const millis = yield* currentMillis
    const actionEvent: PreviewAutomationActionEvent = {
      id: `browser-action-${millis.toString(36)}-${sequence.toString(36)}`,
      action,
      status: 'running',
      startedAt,
    }
    yield* pushAction(tabId, actionEvent)
    const lifecycleGeneration = (yield* SynchronizedRef.get(tabsRef)).get(
      tabId,
    )?.lifecycleGeneration
    if (lifecycleGeneration === undefined)
    {
      return yield* new PreviewTabNotFoundError({ tabId })
    }
    const epoch = (yield* Ref.get(controlEpochRef)).get(tabId) ?? 0
    const control = yield* ensureControlSession(wc)
    const currentAfterControl = (yield* SynchronizedRef.get(tabsRef)).get(tabId)
    if (
      currentAfterControl?.lifecycleGeneration !== lifecycleGeneration ||
      currentAfterControl.webContentsId !== wc.id
    )
    {
      yield* detachControlSession(wc.id)
      return yield* new PreviewAutomationControlInterruptedError({
        operation: action,
        tabId,
        webContentsId: wc.id,
      })
    }
    const execute = Effect.fn('PreviewManager.executeControlAction')(function* ()
    {
      yield* update(tabId, { controller: 'agent' }, lifecycleGeneration)
      const send: SendCommand = Effect.fn('PreviewManager.sendCommand')(
        function* (method, commandParams)
        {
          const before = (yield* Ref.get(controlEpochRef)).get(tabId) ?? 0
          const currentBefore = (yield* SynchronizedRef.get(tabsRef)).get(tabId)
          if (
            before !== epoch ||
            currentBefore?.lifecycleGeneration !== lifecycleGeneration ||
            currentBefore.webContentsId !== wc.id
          )
          {
            return yield* new PreviewAutomationControlInterruptedError({
              operation: action,
              tabId,
              webContentsId: wc.id,
            })
          }
          const result = yield* attemptPromise(
            { operation: `${action}.${method}`, tabId, webContentsId: wc.id },
            () => wc.debugger.sendCommand(method, commandParams),
          )
          const after = (yield* Ref.get(controlEpochRef)).get(tabId) ?? 0
          const currentAfter = (yield* SynchronizedRef.get(tabsRef)).get(tabId)
          if (
            after !== epoch ||
            currentAfter?.lifecycleGeneration !== lifecycleGeneration ||
            currentAfter.webContentsId !== wc.id
          )
          {
            return yield* new PreviewAutomationControlInterruptedError({
              operation: action,
              tabId,
              webContentsId: wc.id,
            })
          }
          return result
        },
      )
      // cleanup commands must still run after human input invalidates the action's
      // control epoch. Otherwise a partially dispatched input can leave Chromium
      // with a held key or focus emulation enabled for subsequent actions.
      const sendCleanup: SendCommand = Effect.fn('PreviewManager.sendCleanupCommand')(
        function* (method, commandParams)
        {
          return yield* attemptPromise(
            {
              operation: `${action}.cleanup.${method}`,
              tabId,
              webContentsId: wc.id,
            },
            () => wc.debugger.sendCommand(method, commandParams),
          )
        },
      )
      return yield* use(send, sendCleanup)
    })
    const finalize = Effect.fn('PreviewManager.finalizeControlAction')(function* (
      exit: Exit.Exit<A, PreviewManagerError>,
    )
    {
      const completedAt = yield* currentIso
      if (exit._tag === 'Success')
      {
        yield* replaceAction(tabId, {
          ...actionEvent,
          status: 'succeeded',
          completedAt,
        })
      }
      else
      {
        const error = Option.getOrNull(Cause.findErrorOption(exit.cause))
        const interrupted = isPreviewAutomationControlInterruptedError(error)
        const errorMessage = isPreviewOperationError(error)
          ? PreviewOperationError.toTimelineMessage(error)
          : isPreviewAutomationEvaluationError(error)
            ? PreviewAutomationEvaluationError.toTimelineMessage(error)
            : isPreviewAutomationInvalidSelectorError(error)
              ? PreviewAutomationInvalidSelectorError.toTimelineMessage(error)
              : error instanceof Error
                ? error.message
                : String(error)
        yield* replaceAction(tabId, {
          ...actionEvent,
          status: interrupted ? 'interrupted' : 'failed',
          completedAt,
          error: errorMessage,
        })
      }
      const tabs = yield* SynchronizedRef.get(tabsRef)
      const current = tabs.get(tabId)
      if (current?.lifecycleGeneration === lifecycleGeneration && current.webContentsId === wc.id)
      {
        yield* update(tabId, { controller: 'none' }, lifecycleGeneration)
      }
    })
    return yield* control.semaphore.withPermit(execute().pipe(Effect.onExit(finalize)))
  })

  const evaluateWithDebugger = <A = unknown>(
    tabId: string,
    send: SendCommand,
    expression: string,
    returnByValue: boolean,
    awaitPromise = true,
  ): Effect.Effect<A, PreviewManagerError> =>
    send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue,
      userGesture: true,
    }).pipe(
      Effect.flatMap((rawResponse) =>
      {
        const response = rawResponse as CdpEvaluationResult
        if (!response.exceptionDetails)
        {
          return Effect.succeed((returnByValue ? response.result?.value : response.result) as A)
        }
        const detail = previewAutomationEvaluationDetail(response.exceptionDetails)
        return Effect.fail(
          new PreviewAutomationEvaluationError({
            tabId,
            detailKind: detail.detailKind,
            detailLength: detail.detail?.length ?? 0,
            cause: response.exceptionDetails,
          }),
        )
      }),
    )

  const automationLocator = (input: {
    readonly selector?: string | undefined
    readonly locator?: string | undefined
  }): string | null => input.locator ?? (input.selector ? `css=${input.selector}` : null)

  const automationSelectorDiagnostics = (input: {
    readonly selector?: string | undefined
    readonly locator?: string | undefined
  }): {
    readonly selectorKind: PreviewAutomationSelectorKind
    readonly selectorLength?: number
  } =>
  {
    if (input.locator !== undefined)
    {
      return { selectorKind: 'locator', selectorLength: input.locator.length }
    }
    if (input.selector !== undefined)
    {
      return { selectorKind: 'selector', selectorLength: input.selector.length }
    }
    return { selectorKind: 'focused-element' }
  }

  const ensurePlaywrightInjected = Effect.fn('PreviewManager.ensurePlaywrightInjected')(function* (
    tabId: string,
    send: SendCommand,
  )
  {
    const installed = yield* evaluateWithDebugger<boolean>(
      tabId,
      send,
      'Boolean(globalThis.__t3PlaywrightInjected)',
      true,
    )
    if (installed) return
    const expression = yield* playwrightInstallExpression.pipe(
      Effect.mapError(
        (cause) =>
          new PreviewOperationError({
            operation: 'ensurePlaywrightInjected',
            tabId,
            cause,
          }),
      ),
    )
    yield* evaluateWithDebugger(tabId, send, expression, true)
  })

  const cancelPickElement = Effect.fn('PreviewManager.cancelPickElement')(function* (
    tabId: string,
  )
  {
    const session = (yield* Ref.get(pickSessionsRef)).get(tabId)
    if (session) yield* session.cancel
  })

  const detachListeners = Effect.fn('PreviewManager.detachListeners')(function* (
    webContentsId: number,
    attachmentToken: symbol,
  )
  {
    const managed = (yield* Ref.get(attachedRef)).get(webContentsId)
    if (managed?.attachmentToken === attachmentToken)
    {
      managed.cancelFaviconCapture()
      yield* Scope.close(managed.scope, Exit.void).pipe(Effect.ignore)
    }
  })

  const isAppShortcut = (input: Electron.Input): boolean =>
    input.type === 'keyDown' &&
    APP_FORWARDED_SHORTCUTS.some(
      (shortcut) =>
        shortcut.key.toLowerCase() === input.key.toLowerCase() &&
        shortcut.meta === input.meta &&
        shortcut.shift === input.shift &&
        shortcut.control === input.control,
    )

  const computeNavStatus = (wc: Electron.WebContents): PreviewNavStatus =>
  {
    const url = wc.getURL()
    const title = wc.getTitle()
    if (url === '' || url === 'about:blank') return { kind: 'Idle' }
    if (wc.isLoading()) return { kind: 'Loading', url, title }
    return { kind: 'Success', url, title }
  }

  const consumeExpectedAgentInput = Effect.fn('PreviewManager.consumeExpectedAgentInput')(
    function* (tabId: string, signal: PreviewInputSignal)
    {
      const now = yield* currentMillis
      return yield* Ref.modify(expectedAgentInputsRef, (allExpected) =>
      {
        const pending = (allExpected.get(tabId) ?? []).filter(
          (expected) => expected.expiresAt > now,
        )
        const index = pending.findIndex((expected) => inputSignalsMatch(expected.signal, signal))
        const matched = index >= 0
        const nextPending = matched
          ? pending.filter((_, pendingIndex) => pendingIndex !== index)
          : pending
        return [
          matched,
          replaceMap(allExpected, (copy) =>
          {
            if (nextPending.length === 0) copy.delete(tabId)
            else copy.set(tabId, nextPending)
          }),
        ] as const
      })
    },
  )

  const expectAgentInput = Effect.fn('PreviewManager.expectAgentInput')(function* (
    tabId: string,
    signal: PreviewInputSignal,
  )
  {
    const now = yield* currentMillis
    yield* Ref.update(expectedAgentInputsRef, (allExpected) =>
      replaceMap(allExpected, (copy) =>
      {
        const pending = (allExpected.get(tabId) ?? []).filter(
          (expected) => expected.expiresAt > now,
        )
        copy.set(tabId, [...pending, { signal, expiresAt: now + 1_000 }])
      }),
    )
  })

  const attachListeners = Effect.fn('PreviewManager.attachListeners')(function* (
    tabId: string,
    wc: Electron.WebContents,
    lifecycleGeneration: number,
  )
  {
    const scope = yield* Scope.fork(parentScope, 'sequential')
    const attachmentToken = Symbol()
    let documentGeneration = 0
    let nextRequestId = 0
    let activeCapture: {
      readonly controller: AbortController
      readonly documentGeneration: number
      readonly eventKey: string
      readonly requestId: number
    } | null = null
    const cancelFaviconCapture = () =>
    {
      documentGeneration += 1
      activeCapture?.controller.abort()
      activeCapture = null
    }
    const syncState = Effect.fn('PreviewManager.syncWebContentsState')(function* (
      preserveLoadFailure: boolean,
      confirmedNavigation = false,
    )
    {
      if (wc.isDestroyed()) return
      const managed = (yield* Ref.get(attachedRef)).get(wc.id)
      if (managed?.attachmentToken !== attachmentToken) return
      const computedNavStatus = computeNavStatus(wc)
      const canGoBack = wc.navigationHistory.canGoBack()
      const canGoForward = wc.navigationHistory.canGoForward()
      const updatedAt = yield* currentIso
      const next = yield* SynchronizedRef.modify(tabsRef, (tabs) =>
      {
        const current = tabs.get(tabId)
        if (
          !current ||
          current.lifecycleGeneration !== lifecycleGeneration ||
          current.webContentsId !== wc.id ||
          webContents.fromId(wc.id) !== wc
        )
        {
          return [Option.none<PreviewTabRecord>(), tabs] as const
        }
        // electron emits did-stop-loading after did-fail-load. At that point the
        // failed guest is no longer "loading", but it has not successfully
        // navigated anywhere. Keep the failure until a new load actually starts.
        const navStatus =
          preserveLoadFailure &&
          current.navStatus.kind === 'LoadFailed' &&
          computedNavStatus.kind === 'Success'
            ? current.navStatus
            : computedNavStatus
        const clearFavicon =
          confirmedNavigation &&
          current.favicon !== undefined &&
          safeHttpOrigin(current.favicon.pageUrl) !==
            safeHttpOrigin(navStatus.kind === 'Idle' ? wc.getURL() : navStatus.url)
        const { favicon: _favicon, ...currentWithoutFavicon } = current
        const state: PreviewTabRecord = {
          ...(clearFavicon ? currentWithoutFavicon : current),
          navStatus,
          canGoBack,
          canGoForward,
          // preview zoom is tab state; the guest may report app-window zoom
          updatedAt,
        }
        return [
          Option.some(state),
          replaceMap(tabs, (copy) =>
          {
            copy.set(tabId, state)
          }),
        ] as const
      })
      if (Option.isSome(next)) yield* emitIfCurrent(tabId, next.value)
    })
    const sync = () => runFork(syncState(true))
    const syncNavigation = () => runFork(syncState(false, true))
    const syncInPageNavigation = () => runFork(syncState(false))
    const navigationStarted = (
      event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
    ): void =>
    {
      if (event.isMainFrame && !event.isSameDocument) cancelFaviconCapture()
    }
    const audioStateChanged = (
      event: Electron.Event<Electron.WebContentsAudioStateChangedEventParams>,
    ) => runFork(syncTabAudible(tabId, wc, event.audible))
    const publishFavicon = Effect.fn('PreviewManager.publishFavicon')(function* (input: {
      readonly captureDocumentGeneration: number
      readonly dataUrl: string
      readonly pageUrl: string
      readonly requestId: number
    })
    {
      const pageOrigin = safeHttpOrigin(input.pageUrl)
      const managed = (yield* Ref.get(attachedRef)).get(wc.id)
      if (
        !pageOrigin ||
        wc.isDestroyed() ||
        webContents.fromId(wc.id) !== wc ||
        managed?.attachmentToken !== attachmentToken ||
        managed.tabId !== tabId ||
        managed.webContents !== wc ||
        activeCapture?.documentGeneration !== input.captureDocumentGeneration ||
        activeCapture.requestId !== input.requestId ||
        safeHttpOrigin(wc.getURL()) !== pageOrigin
      )
      {
        return
      }
      const capturedAt = yield* currentMillis
      const updatedAt = yield* currentIso
      const next = yield* SynchronizedRef.modify(tabsRef, (tabs) =>
      {
        const current = tabs.get(tabId)
        if (
          !current ||
          current.lifecycleGeneration !== lifecycleGeneration ||
          current.webContentsId !== wc.id ||
          webContents.fromId(wc.id) !== wc ||
          activeCapture?.documentGeneration !== input.captureDocumentGeneration ||
          activeCapture.requestId !== input.requestId
        )
        {
          return [Option.none<PreviewTabRecord>(), tabs] as const
        }
        const state: PreviewTabRecord = {
          ...current,
          favicon: { dataUrl: input.dataUrl, pageUrl: pageOrigin, capturedAt },
          updatedAt,
        }
        return [
          Option.some(state),
          replaceMap(tabs, (copy) =>
          {
            copy.set(tabId, state)
          }),
        ] as const
      })
      if (Option.isSome(next)) yield* emitIfCurrent(tabId, next.value)
    })
    const faviconUpdated = (_event: Event, rawCandidates: ReadonlyArray<string>): void =>
    {
      const pageUrl = wc.getURL()
      if (!safeHttpOrigin(pageUrl)) return
      const candidates = selectFaviconCandidates(rawCandidates)
      if (candidates.length === 0) return
      const eventKey = JSON.stringify([pageUrl, ...candidates])
      if (activeCapture?.eventKey === eventKey) return
      activeCapture?.controller.abort()
      const captureDocumentGeneration = documentGeneration
      const requestId = ++nextRequestId
      const controller = new AbortController()
      activeCapture = {
        controller,
        documentGeneration: captureDocumentGeneration,
        eventKey,
        requestId,
      }
      runFork(
        Effect.tryPromise({
          try: () =>
            captureFavicon({ webContents: wc, pageUrl, candidates, signal: controller.signal }),
          catch: (cause) =>
            new PreviewOperationError({
              operation: 'captureFavicon',
              tabId,
              webContentsId: wc.id,
              cause,
            }),
        }).pipe(
          Effect.flatMap((result) =>
            result.kind === 'captured'
              ? publishFavicon({
                  captureDocumentGeneration,
                  dataUrl: result.dataUrl,
                  pageUrl,
                  requestId,
                })
              : Effect.void,
          ),
          Effect.catch((error) =>
            controller.signal.aborted
              ? Effect.void
              : Effect.logDebug('Favicon capture failed.', {
                  error,
                  tabId,
                  webContentsId: wc.id,
                }),
          ),
          Effect.ensuring(
            Effect.sync(() =>
            {
              if (activeCapture?.requestId === requestId) activeCapture = null
            }),
          ),
        ),
      )
    }
    const failed = (
      _event: Event,
      code: number,
      description: string,
      validatedUrl: string,
      isMainFrame: boolean,
    ): void =>
    {
      if (code === -3 || !isMainFrame) return
      runFork(
        update(
          tabId,
          {
            navStatus: {
              kind: 'LoadFailed',
              url: validatedUrl || wc.getURL(),
              title: wc.getTitle(),
              code,
              description,
            },
          },
          lifecycleGeneration,
        ),
      )
    }
    const handleHumanInput = Effect.fn('PreviewManager.handleHumanInput')(function* (
      rawSignal?: unknown,
    )
    {
      const current = (yield* SynchronizedRef.get(tabsRef)).get(tabId)
      if (current?.lifecycleGeneration !== lifecycleGeneration || current.webContentsId !== wc.id)
      {
        return
      }
      if (isPreviewInputSignal(rawSignal) && (yield* consumeExpectedAgentInput(tabId, rawSignal)))
      {
        return
      }
      yield* Ref.update(controlEpochRef, (epochs) =>
        replaceMap(epochs, (copy) =>
        {
          copy.set(tabId, (epochs.get(tabId) ?? 0) + 1)
        }),
      )
      yield* update(tabId, { controller: 'human' }, lifecycleGeneration)
      yield* Effect.sleep(750)
      const tabs = yield* SynchronizedRef.get(tabsRef)
      const latest = tabs.get(tabId)
      if (
        latest?.lifecycleGeneration === lifecycleGeneration &&
        latest.webContentsId === wc.id &&
        latest.controller === 'human'
      )
      {
        yield* update(tabId, { controller: 'none' }, lifecycleGeneration)
      }
    })
    const humanInput = (_event: unknown, rawSignal?: unknown): void =>
    {
      runFork(handleHumanInput(rawSignal))
    }
    const mouseNavigate = (_event: unknown, payload?: unknown): void =>
    {
      const direction =
        typeof payload === 'object' && payload !== null && 'direction' in payload
          ? (payload as { direction?: unknown }).direction
          : undefined
      if (direction !== 'back' && direction !== 'forward') return
      runFork(
        attempt({ operation: 'mouseNavigate', tabId, webContentsId: wc.id }, () =>
        {
          if (direction === 'back')
          {
            if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
            return
          }
          if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
        }).pipe(Effect.ignore),
      )
    }
    const forwardShortcut = Effect.fn('PreviewManager.forwardShortcut')(function* (
      event: Electron.Event,
      input: Electron.Input,
    )
    {
      const mainWindow = yield* Ref.get(mainWindowRef)
      if (!isAppShortcut(input) || Option.isNone(mainWindow) || mainWindow.value.isDestroyed())
      {
        return
      }
      event.preventDefault()
      mainWindow.value.webContents.sendInputEvent({
        type: 'keyDown',
        keyCode: input.key,
        modifiers: [
          ...(input.meta ? (['meta'] as const) : []),
          ...(input.shift ? (['shift'] as const) : []),
          ...(input.control ? (['control'] as const) : []),
          ...(input.alt ? (['alt'] as const) : []),
        ],
      })
    })
    const beforeInput = (event: Electron.Event, input: Electron.Input): void =>
    {
      runFork(forwardShortcut(event, input))
    }
    yield* Scope.addFinalizer(
      scope,
      Effect.gen(function* ()
      {
        cancelFaviconCapture()
        yield* attempt({ operation: 'detachListeners', tabId, webContentsId: wc.id }, () =>
        {
          wc.off('did-start-navigation', navigationStarted)
          wc.off('did-navigate', syncNavigation)
          wc.off('did-navigate-in-page', syncInPageNavigation)
          wc.off('page-title-updated', sync)
          wc.off('page-favicon-updated', faviconUpdated as never)
          wc.off('did-start-loading', sync)
          wc.off('did-stop-loading', sync)
          wc.off('did-fail-load', failed as never)
          wc.off('audio-state-changed', audioStateChanged)
          wc.off('before-input-event', beforeInput)
          wc.ipc.off(HUMAN_INPUT_CHANNEL, humanInput)
          wc.ipc.off(MOUSE_NAVIGATE_CHANNEL, mouseNavigate)
        }).pipe(Effect.ignore)
        yield* Ref.update(attachedRef, (attached) =>
          attached.get(wc.id)?.attachmentToken !== attachmentToken
            ? attached
            : replaceMap(attached, (copy) =>
              {
                copy.delete(wc.id)
              }),
        )
      }),
    )
    const claimed = yield* Ref.modify(attachedRef, (attached) =>
    {
      if (attached.has(wc.id)) return [false, attached] as const
      return [
        true,
        replaceMap(attached, (copy) =>
        {
          copy.set(wc.id, {
            attachmentToken,
            cancelFaviconCapture,
            scope,
            tabId,
            webContents: wc,
          })
        }),
      ] as const
    })
    if (!claimed)
    {
      yield* Scope.close(scope, Exit.void).pipe(Effect.ignore)
      return yield* new PreviewWebContentsNotFoundError({ tabId, webContentsId: wc.id })
    }
    const install = Effect.fn('PreviewManager.installWebContentsListeners')(function* ()
    {
      yield* attempt({ operation: 'attachListeners', tabId, webContentsId: wc.id }, () =>
      {
        wc.on('did-start-navigation', navigationStarted)
        wc.on('did-navigate', syncNavigation)
        wc.on('did-navigate-in-page', syncInPageNavigation)
        wc.on('page-title-updated', sync)
        wc.on('page-favicon-updated', faviconUpdated as never)
        wc.on('did-start-loading', sync)
        wc.on('did-stop-loading', sync)
        wc.on('did-fail-load', failed as never)
        wc.on('audio-state-changed', audioStateChanged)
        wc.ipc.on(HUMAN_INPUT_CHANNEL, humanInput)
        wc.ipc.on(MOUSE_NAVIGATE_CHANNEL, mouseNavigate)
        wc.setWindowOpenHandler(({ url }) =>
        {
          runFork(
            attemptPromise({ operation: 'openPreviewWindow', tabId, webContentsId: wc.id }, () =>
              wc.loadURL(url),
            ).pipe(Effect.ignore),
          )
          return { action: 'deny' }
        })
        wc.on('before-input-event', beforeInput)
      })
    })
    yield* install().pipe(Effect.onError(() => Scope.close(scope, Exit.void).pipe(Effect.ignore)))
    return attachmentToken
  })

  const tabOps = createTabOperations({
    tabsRef,
    mainWindowRef,
    recordingOwnerRef,
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
    emitIfCurrent,
    nextCounter,
    replaceMap,
    requireWebContents,
    toPreviewTabState,
    withTabLifecycle,
    withAttachmentTransition,
    update,
    runFork,
    ensureControlSession,
    syncTabAudible,
  })

  const {
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
    setAudioMuted,
  } = tabOps

  const pickOps = createPickRecordingOperations({
    tabsRef,
    pickSessionsRef,
    annotationThemeRef,
    pickSequenceRef,
    recordingSequenceRef,
    recordingOwnerRef,
    setRecordingBackgroundThrottling,
    artifactSequenceRef,
    fileSystem,
    path,
    resolvedArtifactDirectory,
    attempt,
    attemptPromise,
    cancelPickElement,
    currentIso,
    currentMillis,
    ensureControlSession,
    nextCounter,
    replaceMap,
    requireWebContents,
    withControlSession,
    runFork,
    normalizeCaptureRect,
    captureAnnotationScreenshot,
    artifactSiteSlug,
  })

  const { pickElement, captureScreenshot, startRecording, stopRecording, saveRecording } = pickOps

  const automationOps = createAutomationOperations({
    tabsRef,
    diagnosticsRef,
    actionTimelineRef,
    pointerEventListenersRef,
    pointerSequenceRef,
    attempt,
    attemptPromise,
    currentIso,
    currentMillis,
    deliverEvent,
    encodeJson,
    ensurePlaywrightInjected,
    evaluateWithDebugger,
    expectAgentInput,
    nextCounter,
    prepareAutomationInput,
    requireWebContents,
    withControlSession,
    automationLocator,
    automationSelectorDiagnostics,
    hostPlatform,
  })

  const {
    automationStatus,
    automationSnapshot,
    automationClick,
    automationType,
    automationPress,
    automationScroll,
    automationEvaluate,
    automationWaitFor,
  } = automationOps

  const revealArtifact = Effect.fn('PreviewManager.revealArtifact')(function* (
    artifactPath: string,
  )
  {
    const resolvedPath = yield* resolveArtifactPath(artifactPath)
    yield* attempt({ operation: 'revealArtifact', artifactPath: resolvedPath }, () =>
      shell.showItemInFolder(resolvedPath),
    )
  })

  const copyArtifactToClipboard = Effect.fn('PreviewManager.copyArtifactToClipboard')(function* (
    artifactPath: string,
  )
  {
    const resolvedPath = yield* resolveArtifactPath(artifactPath)
    const image = yield* attempt(
      { operation: 'copyArtifactToClipboard.load', artifactPath: resolvedPath },
      () => nativeImage.createFromPath(resolvedPath),
    )
    if (image.isEmpty())
    {
      return yield* new PreviewArtifactImageLoadError({ artifactPath: resolvedPath })
    }
    yield* attempt({ operation: 'copyArtifactToClipboard.write', artifactPath: resolvedPath }, () =>
      clipboard.writeImage(image),
    )
  })

  const subscribe = <A>(
    ref: Ref.Ref<ReadonlySet<A>>,
    listener: A,
  ): Effect.Effect<void, never, Scope.Scope> =>
    Effect.acquireRelease(
      Ref.update(ref, (listeners) => new Set([...listeners, listener])),
      () =>
        Ref.update(ref, (listeners) =>
        {
          const next = new Set(listeners)
          next.delete(listener)
          return next
        }),
    ).pipe(Effect.asVoid)

  const destroy = Effect.fn('PreviewManager.destroy')(function* ()
  {
    const tabs = yield* SynchronizedRef.get(tabsRef)
    yield* Effect.forEach(tabs.keys(), closeTab, { discard: true })
    yield* Effect.all(
      [
        Ref.set(listenersRef, new Set()),
        Ref.set(expectedAgentInputsRef, new Map()),
        Ref.set(pointerEventListenersRef, new Set()),
        Ref.set(recordingFrameListenersRef, new Set()),
      ],
      { discard: true },
    )
  })

  yield* Effect.addFinalizer(() => destroy().pipe(Effect.ignore))

  return {
    automationClick,
    automationEvaluate,
    automationPress,
    automationScroll,
    automationSnapshot,
    automationStatus,
    automationType,
    automationWaitFor,
    cancelPickElement,
    captureScreenshot,
    closeTab,
    copyArtifactToClipboard,
    createTab,
    goBack,
    goForward,
    hardReload,
    navigate,
    openDevTools,
    pickElement,
    refresh,
    reapplyZoom,
    registerWebview,
    resetZoom: (tabId: string) => applyZoom(tabId, () => DEFAULT_ZOOM_FACTOR),
    revealArtifact,
    saveRecording,
    setAnnotationTheme,
    setColorScheme,
    setAudioMuted,
    setMainWindow,
    startRecording,
    stopRecording,
    subscribePointerEvents: (listener: PointerEventListener) =>
      subscribe(pointerEventListenersRef, listener),
    subscribeRecordingFrames: (listener: RecordingFrameListener) =>
      subscribe(recordingFrameListenersRef, listener),
    subscribeStateChanges: (listener: Listener) => subscribe(listenersRef, listener),
    zoomIn: (tabId: string) => applyZoom(tabId, (current) => nextZoomLevel(current, 'in')),
    zoomOut: (tabId: string) => applyZoom(tabId, (current) => nextZoomLevel(current, 'out')),
  }
})
export class PreviewManager extends Context.Service<
  PreviewManager,
  {
    readonly setMainWindow: (window: BrowserWindow) => Effect.Effect<void, PreviewManagerError>
    readonly getBrowserSession: (scope?: string) => Effect.Effect<Session, PreviewManagerError>
    readonly isBrowserPartition: (partition: string) => boolean
    readonly createTab: (
      tabId: string,
      defaults?: DesktopPreviewTabDefaults,
    ) => Effect.Effect<PreviewTabState, PreviewManagerError>
    readonly closeTab: (tabId: string) => Effect.Effect<void, PreviewManagerError>
    readonly registerWebview: (
      tabId: string,
      webContentsId: number,
    ) => Effect.Effect<void, PreviewManagerError>
    readonly navigate: (tabId: string, url: string) => Effect.Effect<void, PreviewManagerError>
    readonly goBack: (tabId: string) => Effect.Effect<void, PreviewManagerError>
    readonly goForward: (tabId: string) => Effect.Effect<void, PreviewManagerError>
    readonly refresh: (tabId: string) => Effect.Effect<void, PreviewManagerError>
    readonly zoomIn: (tabId: string) => Effect.Effect<void, PreviewManagerError>
    readonly zoomOut: (tabId: string) => Effect.Effect<void, PreviewManagerError>
    readonly resetZoom: (tabId: string) => Effect.Effect<void, PreviewManagerError>
    readonly reapplyZoom: () => Effect.Effect<void>
    readonly hardReload: (tabId: string) => Effect.Effect<void, PreviewManagerError>
    readonly setColorScheme: (
      tabId: string,
      colorScheme: DesktopPreviewColorScheme,
    ) => Effect.Effect<void, PreviewManagerError>
    readonly setAudioMuted: (
      tabId: string,
      audioMuted: boolean,
    ) => Effect.Effect<void, PreviewManagerError>
    readonly openDevTools: (tabId: string) => Effect.Effect<void, PreviewManagerError>
    readonly clearCookies: () => Effect.Effect<void, PreviewManagerError>
    readonly clearCache: () => Effect.Effect<void, PreviewManagerError>
    readonly getBrowserPartition: (scope?: string) => Effect.Effect<string, PreviewManagerError>
    readonly setAnnotationTheme: (
      theme: DesktopPreviewAnnotationTheme,
    ) => Effect.Effect<void, PreviewManagerError>
    readonly pickElement: (
      tabId: string,
    ) => Effect.Effect<PreviewAnnotationPayload | null, PreviewManagerError>
    readonly cancelPickElement: (tabId: string) => Effect.Effect<void, PreviewManagerError>
    readonly captureScreenshot: (
      tabId: string,
    ) => Effect.Effect<DesktopPreviewScreenshotArtifact, PreviewManagerError>
    readonly revealArtifact: (path: string) => Effect.Effect<void, PreviewManagerError>
    readonly copyArtifactToClipboard: (path: string) => Effect.Effect<void, PreviewManagerError>
    readonly startRecording: (tabId: string) => Effect.Effect<void, PreviewManagerError>
    readonly stopRecording: (tabId: string) => Effect.Effect<void, PreviewManagerError>
    readonly saveRecording: (
      tabId: string,
      mimeType: string,
      data: Uint8Array,
    ) => Effect.Effect<DesktopPreviewRecordingArtifact, PreviewManagerError>
    readonly automationStatus: (
      tabId: string,
    ) => Effect.Effect<PreviewAutomationStatus, PreviewManagerError>
    readonly automationSnapshot: (
      tabId: string,
    ) => Effect.Effect<PreviewAutomationSnapshot, PreviewManagerError>
    readonly automationClick: (
      tabId: string,
      input: PreviewAutomationClickInput,
    ) => Effect.Effect<void, PreviewManagerError>
    readonly automationType: (
      tabId: string,
      input: PreviewAutomationTypeInput,
    ) => Effect.Effect<void, PreviewManagerError>
    readonly automationPress: (
      tabId: string,
      input: PreviewAutomationPressInput,
    ) => Effect.Effect<void, PreviewManagerError>
    readonly automationScroll: (
      tabId: string,
      input: PreviewAutomationScrollInput,
    ) => Effect.Effect<void, PreviewManagerError>
    readonly automationEvaluate: (
      tabId: string,
      input: PreviewAutomationEvaluateInput,
    ) => Effect.Effect<unknown, PreviewManagerError>
    readonly automationWaitFor: (
      tabId: string,
      input: PreviewAutomationWaitForInput,
    ) => Effect.Effect<void, PreviewManagerError>
    readonly subscribeStateChanges: (listener: Listener) => Effect.Effect<void, never, Scope.Scope>
    readonly subscribePointerEvents: (
      listener: PointerEventListener,
    ) => Effect.Effect<void, never, Scope.Scope>
    readonly subscribeRecordingFrames: (
      listener: RecordingFrameListener,
    ) => Effect.Effect<void, never, Scope.Scope>
  }
>()('@t3tools/desktop/preview/Manager/PreviewManager')
{}

export const make = Effect.gen(function* PreviewManagerMake()
{
  const environment = yield* DesktopEnvironment.DesktopEnvironment
  const browserSession = yield* BrowserSession.BrowserSession
  const operations = yield* makeNativeOperations(environment.browserArtifactsDir)

  return PreviewManager.of({
    setMainWindow: operations.setMainWindow,
    getBrowserSession: Effect.fn('PreviewManager.getBrowserSession')(function* (scope)
    {
      return yield* browserSession
        .getSession(scope)
        .pipe(
          Effect.mapError(
            (cause) => new PreviewOperationError({ operation: 'getBrowserSession', cause }),
          ),
        )
    }),
    isBrowserPartition: browserSession.isPartition,
    createTab: operations.createTab,
    closeTab: operations.closeTab,
    registerWebview: operations.registerWebview,
    navigate: operations.navigate,
    goBack: operations.goBack,
    goForward: operations.goForward,
    refresh: operations.refresh,
    reapplyZoom: operations.reapplyZoom,
    zoomIn: operations.zoomIn,
    zoomOut: operations.zoomOut,
    resetZoom: operations.resetZoom,
    hardReload: operations.hardReload,
    setColorScheme: operations.setColorScheme,
    setAudioMuted: operations.setAudioMuted,
    openDevTools: operations.openDevTools,
    clearCookies: Effect.fn('PreviewManager.clearCookies')(function* ()
    {
      yield* browserSession
        .clearCookies()
        .pipe(
          Effect.mapError(
            (cause) => new PreviewOperationError({ operation: 'clearCookies', cause }),
          ),
        )
    }),
    clearCache: Effect.fn('PreviewManager.clearCache')(function* ()
    {
      yield* browserSession
        .clearCache()
        .pipe(
          Effect.mapError((cause) => new PreviewOperationError({ operation: 'clearCache', cause })),
        )
    }),
    getBrowserPartition: Effect.fn('PreviewManager.getBrowserPartition')(function* (scope)
    {
      return yield* browserSession
        .getPartition(scope)
        .pipe(
          Effect.mapError(
            (cause) => new PreviewOperationError({ operation: 'getBrowserPartition', cause }),
          ),
        )
    }),
    setAnnotationTheme: operations.setAnnotationTheme,
    pickElement: operations.pickElement,
    cancelPickElement: operations.cancelPickElement,
    captureScreenshot: operations.captureScreenshot,
    revealArtifact: operations.revealArtifact,
    copyArtifactToClipboard: operations.copyArtifactToClipboard,
    startRecording: operations.startRecording,
    stopRecording: operations.stopRecording,
    saveRecording: operations.saveRecording,
    automationStatus: operations.automationStatus,
    automationSnapshot: operations.automationSnapshot,
    automationClick: operations.automationClick,
    automationType: operations.automationType,
    automationPress: operations.automationPress,
    automationScroll: operations.automationScroll,
    automationEvaluate: operations.automationEvaluate,
    automationWaitFor: operations.automationWaitFor,
    subscribeStateChanges: operations.subscribeStateChanges,
    subscribePointerEvents: operations.subscribePointerEvents,
    subscribeRecordingFrames: operations.subscribeRecordingFrames,
  })
}).pipe(Effect.withSpan('PreviewManager.make'))

export const layer = Layer.effect(PreviewManager, make)
