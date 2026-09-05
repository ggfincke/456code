// apps/desktop/src/preview/ManagerPickRecording.ts
// owns desktop preview element picking, screenshots, and recording artifacts

import type {
  DesktopPreviewAnnotationTheme,
  PreviewAnnotationPayload,
  PreviewAnnotationRect,
} from '@t3tools/contracts'
import { webContents } from 'electron'
import * as Effect from 'effect/Effect'
import type * as Fiber from 'effect/Fiber'
import type * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import type * as Path from 'effect/Path'
import * as Ref from 'effect/Ref'
import * as Scope from 'effect/Scope'
import * as SynchronizedRef from 'effect/SynchronizedRef'

import {
  CANCEL_PICK_CHANNEL,
  ELEMENT_PICKED_CHANNEL,
  START_PICK_CHANNEL,
  ANNOTATION_CAPTURED_CHANNEL,
} from './GuestProtocol.ts'
import {
  PreviewOperationError,
  PreviewRecordingAlreadyActiveError,
  type PreviewManagerError,
} from './ManagerErrors.ts'
import { isPreviewAnnotationPayload } from './PickedElementPayload.ts'
import type {
  BrowserControlSession,
  PickSession,
  PreviewOperationContext,
  PreviewTabRecord,
  RecordingClaim,
  RecordingOwner,
} from './ManagerTypes.ts'

type SendCommand = (
  method: string,
  commandParams?: Record<string, unknown>,
) => Effect.Effect<unknown, PreviewManagerError>

export interface ManagerPickRecordingDeps
{
  readonly tabsRef: SynchronizedRef.SynchronizedRef<ReadonlyMap<string, PreviewTabRecord>>
  readonly pickSessionsRef: Ref.Ref<ReadonlyMap<string, PickSession>>
  readonly annotationThemeRef: Ref.Ref<DesktopPreviewAnnotationTheme>
  readonly pickSequenceRef: Ref.Ref<number>
  readonly recordingSequenceRef: Ref.Ref<number>
  readonly recordingOwnerRef: Ref.Ref<Option.Option<RecordingOwner>>
  readonly setRecordingBackgroundThrottling: (
    enabled: boolean,
  ) => Effect.Effect<void, PreviewManagerError>
  readonly artifactSequenceRef: Ref.Ref<number>
  readonly fileSystem: FileSystem.FileSystem
  readonly path: Path.Path
  readonly resolvedArtifactDirectory: string
  readonly attempt: <A>(
    errorContext: PreviewOperationContext,
    evaluate: () => A,
  ) => Effect.Effect<A, PreviewOperationError>
  readonly attemptPromise: <A>(
    errorContext: PreviewOperationContext,
    evaluate: () => PromiseLike<A>,
  ) => Effect.Effect<A, PreviewOperationError>
  readonly cancelPickElement: (tabId: string) => Effect.Effect<void, PreviewManagerError>
  readonly currentIso: Effect.Effect<string>
  readonly currentMillis: Effect.Effect<number>
  readonly ensureControlSession: (
    wc: Electron.WebContents,
  ) => Effect.Effect<BrowserControlSession, PreviewManagerError>
  readonly nextCounter: (ref: Ref.Ref<number>) => Effect.Effect<number>
  readonly replaceMap: <K, V>(
    source: ReadonlyMap<K, V>,
    update: (copy: Map<K, V>) => void,
  ) => ReadonlyMap<K, V>
  readonly requireWebContents: (
    tabId: string,
  ) => Effect.Effect<Electron.WebContents, PreviewManagerError>
  readonly withControlSession: <A>(
    tabId: string,
    wc: Electron.WebContents,
    action: string,
    use: (send: SendCommand, sendCleanup: SendCommand) => Effect.Effect<A, PreviewManagerError>,
  ) => Effect.Effect<A, PreviewManagerError>
  readonly runFork: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>
  readonly normalizeCaptureRect: (value: unknown) => PreviewAnnotationRect | null
  readonly captureAnnotationScreenshot: (
    tabId: string,
    wc: Electron.WebContents,
    cropRect: PreviewAnnotationRect | null,
  ) => Effect.Effect<PreviewAnnotationPayload['screenshot'], PreviewManagerError>
  readonly artifactSiteSlug: (rawUrl: string) => string
}

export const createPickRecordingOperations = (deps: ManagerPickRecordingDeps) =>
{
  const {
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
  } = deps

  const pickElement = Effect.fn('PreviewManager.pickElement')(function* (tabId: string)
  {
    const wc = yield* requireWebContents(tabId)
    const annotationTheme = yield* Ref.get(annotationThemeRef)
    const pickSequence = yield* nextCounter(pickSequenceRef)
    const sessionId = `${tabId}:${pickSequence.toString(36)}`
    return yield* Effect.callback<PreviewAnnotationPayload | null, PreviewManagerError>(
      (resume) =>
      {
        const session: PickSession = {
          id: sessionId,
          cancel: Effect.suspend(() => cancelPickSession()),
        }
        const cleanup = Effect.fn('PreviewManager.cleanupPickElement')(function* ()
        {
          yield* attempt({ operation: 'pickElement.cleanup', tabId, webContentsId: wc.id }, () =>
          {
            wc.ipc.removeListener(ELEMENT_PICKED_CHANNEL, onMessage)
            wc.off('destroyed', onDestroyed)
            wc.off('did-start-navigation', onNavigated)
          }).pipe(Effect.ignore)
          yield* Ref.update(pickSessionsRef, (sessions) =>
            sessions.get(tabId) === session
              ? replaceMap(sessions, (copy) =>
                {
                  copy.delete(tabId)
                })
              : sessions,
          )
        })
        let settled = false
        let captureStarted = false
        const claimCancellation = (): boolean =>
        {
          if (settled) return false
          settled = true
          return true
        }
        const claimCurrentSession = Effect.fn('PreviewManager.claimCurrentPickSession')(
          function* ()
          {
            if (settled) return false
            return yield* Ref.modify(pickSessionsRef, (sessions) =>
            {
              if (settled || sessions.get(tabId) !== session) return [false, sessions]
              settled = true
              return [
                true,
                replaceMap(sessions, (copy) =>
                {
                  copy.delete(tabId)
                }),
              ]
            })
          },
        )
        const finishPick = Effect.fn('PreviewManager.finishPickElement')(function* (
          payload: PreviewAnnotationPayload | null,
        )
        {
          yield* cleanup()
          resume(Effect.succeed(payload))
        })
        const settle = (payload: PreviewAnnotationPayload | null) =>
        {
          if (!claimCancellation()) return
          runFork(finishPick(payload))
        }
        const cancelPickSession = Effect.fn('PreviewManager.cancelPickSession')(function* ()
        {
          if (!claimCancellation()) return
          yield* cleanup()
          const tabs = yield* SynchronizedRef.get(tabsRef)
          const activeTab = tabs.get(tabId)
          if (activeTab?.webContentsId != null)
          {
            const activeWc = webContents.fromId(activeTab.webContentsId)
            if (activeWc && !activeWc.isDestroyed())
            {
              yield* attempt(
                {
                  operation: 'cancelPickElement',
                  tabId,
                  webContentsId: activeWc.id,
                },
                () => activeWc.send(CANCEL_PICK_CHANNEL, sessionId),
              ).pipe(Effect.ignore)
            }
          }
          resume(Effect.succeed(null))
        })
        const onMessage = (_event: Electron.IpcMainEvent, ...args: unknown[]): void =>
        {
          if (args[0] !== sessionId || settled) return
          const payload = args[1]
          if (!isPreviewAnnotationPayload(payload))
          {
            settle(null)
            return
          }
          if (captureStarted) return
          captureStarted = true
          const cropRect = normalizeCaptureRect(args[2])
          runFork(
            captureAnnotationScreenshot(tabId, wc, cropRect).pipe(
              Effect.match({
                onFailure: () => ({
                  ...payload,
                  screenshot: null,
                  screenshotFailed: true,
                }),
                onSuccess: (screenshot) =>
                  screenshot === null
                    ? {
                        ...payload,
                        screenshot: null,
                        screenshotFailed: true,
                      }
                    : { ...payload, screenshot },
              }),
              Effect.flatMap((result) =>
                claimCurrentSession().pipe(
                  Effect.flatMap((claimed) =>
                    claimed
                      ? attempt(
                          {
                            operation: 'pickElement.captureComplete',
                            tabId,
                            webContentsId: wc.id,
                          },
                          () =>
                            wc.isDestroyed()
                              ? undefined
                              : wc.send(ANNOTATION_CAPTURED_CHANNEL, sessionId),
                        ).pipe(Effect.ignore, Effect.andThen(finishPick(result)))
                      : Effect.void,
                  ),
                ),
              ),
            ),
          )
        }
        const onDestroyed = () => settle(null)
        const onNavigated = (
          _event: Electron.Event,
          _url: string,
          _isInPlace: boolean,
          isMainFrame: boolean,
        ) =>
        {
          if (isMainFrame) settle(null)
        }
        const registerPickElement = Effect.fn('PreviewManager.registerPickElement')(function* ()
        {
          const replaced = yield* Ref.modify(pickSessionsRef, (sessions) => [
            settled ? null : (sessions.get(tabId) ?? null),
            settled
              ? sessions
              : replaceMap(sessions, (copy) =>
                {
                  copy.set(tabId, session)
                }),
          ])
          if (replaced) yield* replaced.cancel
          if (settled) return
          yield* attempt({ operation: 'pickElement.register', tabId, webContentsId: wc.id }, () =>
          {
            wc.ipc.on(ELEMENT_PICKED_CHANNEL, onMessage)
            wc.once('destroyed', onDestroyed)
            wc.on('did-start-navigation', onNavigated)
            if (!wc.isFocused()) wc.focus()
            wc.send(START_PICK_CHANNEL, sessionId, annotationTheme)
          })
        })
        runFork(
          registerPickElement().pipe(
            Effect.catch((error: PreviewManagerError) =>
            {
              if (!claimCancellation()) return Effect.void
              resume(Effect.fail(error))
              return cleanup()
            }),
          ),
        )
        return session.cancel
      },
    )
  })

  const captureScreenshot = Effect.fn('PreviewManager.captureScreenshot')(function* (
    tabId: string,
  )
  {
    const wc = yield* requireWebContents(tabId)
    const [createdAt, millis, sequence, image] = yield* Effect.all([
      currentIso,
      currentMillis,
      nextCounter(artifactSequenceRef),
      attemptPromise(
        {
          operation: 'captureScreenshot.capturePage',
          tabId,
          webContentsId: wc.id,
        },
        () => wc.capturePage(),
      ),
    ])
    const id = `browser-screenshot-${artifactSiteSlug(wc.getURL())}-${millis.toString(36)}-${sequence.toString(36)}`
    const artifactPath = path.join(resolvedArtifactDirectory, `${id}.png`)
    const data = image.toPNG()
    yield* fileSystem.makeDirectory(resolvedArtifactDirectory, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new PreviewOperationError({
            operation: 'captureScreenshot.makeDirectory',
            tabId,
            webContentsId: wc.id,
            artifactPath,
            cause,
          }),
      ),
    )
    yield* fileSystem.writeFile(artifactPath, data).pipe(
      Effect.mapError(
        (cause) =>
          new PreviewOperationError({
            operation: 'captureScreenshot.writeFile',
            tabId,
            webContentsId: wc.id,
            artifactPath,
            cause,
          }),
      ),
    )
    return {
      id,
      tabId,
      path: artifactPath,
      mimeType: 'image/png' as const,
      sizeBytes: data.byteLength,
      createdAt,
    }
  })

  const startScreencast = Effect.fn('PreviewManager.startScreencast')(function* (
    send: SendCommand,
  )
  {
    yield* send('Page.enable')
    yield* send('Page.startScreencast', {
      format: 'jpeg',
      quality: 80,
      maxWidth: 1600,
      maxHeight: 1200,
      everyNthFrame: 1,
    })
  })

  const releaseRecordingOwner = Effect.fn('PreviewManager.releaseRecordingOwner')(function* (
    owner: RecordingOwner,
  )
  {
    const released = yield* Ref.modify(recordingOwnerRef, (current) =>
      Option.isSome(current) && current.value.token === owner.token
        ? ([true, Option.none<RecordingOwner>()] as const)
        : ([false, current] as const),
    )
    if (released)
    {
      yield* setRecordingBackgroundThrottling(true).pipe(Effect.ignore)
    }
  })

  const startRecording = Effect.fn('PreviewManager.startRecording')(function* (tabId: string)
  {
    const wc = yield* requireWebContents(tabId)
    const control = yield* ensureControlSession(wc)
    const owner: RecordingOwner = {
      tabId,
      webContentsId: wc.id,
      token: yield* nextCounter(recordingSequenceRef),
    }
    const claim = yield* Ref.modify(
      recordingOwnerRef,
      (current): readonly [RecordingClaim, Option.Option<RecordingOwner>] =>
        Option.isSome(current)
          ? [{ claimed: false, owner: current.value }, current]
          : [{ claimed: true, owner }, Option.some(owner)],
    )
    if (!claim.claimed && claim.owner.tabId !== tabId)
    {
      return yield* new PreviewRecordingAlreadyActiveError({
        requestedTabId: tabId,
        activeTabId: claim.owner.tabId,
      })
    }
    if (!claim.claimed) return

    yield* setRecordingBackgroundThrottling(false).pipe(
      Effect.onError(() => releaseRecordingOwner(owner)),
    )
    yield* Scope.addFinalizer(control.scope, releaseRecordingOwner(owner))
    yield* withControlSession(tabId, wc, 'recording.start', startScreencast).pipe(
      Effect.onError(() => releaseRecordingOwner(owner)),
    )
  })

  const stopRecording = Effect.fn('PreviewManager.stopRecording')(function* (tabId: string)
  {
    const owner = yield* Ref.get(recordingOwnerRef)
    if (Option.isNone(owner) || owner.value.tabId !== tabId) return
    yield* Effect.gen(function* ()
    {
      const wc = yield* requireWebContents(tabId)
      yield* withControlSession(tabId, wc, 'recording.stop', (send) =>
        send('Page.stopScreencast').pipe(Effect.asVoid),
      )
    }).pipe(Effect.ensuring(releaseRecordingOwner(owner.value)))
  })

  const saveRecording = Effect.fn('PreviewManager.saveRecording')(function* (
    tabId: string,
    mimeType: string,
    data: Uint8Array,
  )
  {
    const [createdAt, millis, sequence] = yield* Effect.all([
      currentIso,
      currentMillis,
      nextCounter(artifactSequenceRef),
    ])
    const id = `browser-recording-${millis.toString(36)}-${sequence.toString(36)}`
    const extension = mimeType.includes('mp4') ? 'mp4' : 'webm'
    const artifactPath = path.join(resolvedArtifactDirectory, `${id}.${extension}`)
    yield* fileSystem.makeDirectory(resolvedArtifactDirectory, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new PreviewOperationError({
            operation: 'saveRecording.makeDirectory',
            tabId,
            artifactPath,
            cause,
          }),
      ),
    )
    yield* fileSystem.writeFile(artifactPath, data).pipe(
      Effect.mapError(
        (cause) =>
          new PreviewOperationError({
            operation: 'saveRecording.writeFile',
            tabId,
            artifactPath,
            cause,
          }),
      ),
    )
    return {
      id,
      tabId,
      path: artifactPath,
      mimeType,
      sizeBytes: data.byteLength,
      createdAt,
    }
  })

  return {
    pickElement,
    cancelPickElement,
    captureScreenshot,
    startRecording,
    stopRecording,
    saveRecording,
  }
}
