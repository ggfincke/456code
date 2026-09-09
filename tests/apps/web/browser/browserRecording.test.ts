// tests/apps/web/browser/browserRecording.test.ts
// verify browser recording behavior

import { EnvironmentId, ThreadId } from '@t3tools/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

const { events, onFrame, registrySet, save, startScreencast, stopScreencast, surfaceState } =
  vi.hoisted(() =>
  {
    const events: string[] = []
    const surfaceState = {
      byTabId: {} as Record<string, unknown>,
    }
    return {
      events,
      onFrame: vi.fn(() => vi.fn()),
      registrySet: vi.fn((_atom: unknown, value: string | null) =>
      {
        events.push(value === null ? 'clear' : `publish:${value}`)
      }),
      save: vi.fn(async () => ({
        id: 'recording-test',
        tabId: 'recording-tab',
        path: '/tmp/recording-test.webm',
        mimeType: 'video/webm' as const,
        sizeBytes: 0,
        createdAt: '2026-06-26T00:00:00.000Z',
      })),
      startScreencast: vi.fn(async () =>
      {
        events.push('start-screencast')
      }),
      stopScreencast: vi.fn(async () => undefined),
      surfaceState,
    }
  })

vi.mock('~/browser/previewBridge', () => ({
  previewBridge: {
    recording: { onFrame, save, startScreencast, stopScreencast },
  },
}))

vi.mock('~/rpc/atomRegistry', () => ({
  appAtomRegistry: { set: registrySet },
}))

vi.mock('../../../../apps/web/src/browser/browserSurfaceStore', () => ({
  useBrowserSurfaceStore: {
    getState: () => surfaceState,
  },
}))

import {
  BROWSER_RECORDING_STARTUP_SETTLE_TIMEOUT_MS,
  BrowserRecordingConflictError,
  BrowserRecordingOperationError,
  BrowserRecordingRequiresVisibleTabError,
  findActiveBrowserRecordingRuntimeTabId,
  readActiveBrowserRecordingTabId,
  readActiveBrowserRecordingTargets,
  startBrowserRecording,
  stopBrowserRecording,
  stopBrowserRecordingForUpload,
} from '../../../../apps/web/src/browser/browserRecording'
import { previewRuntimeTabId } from '../../../../apps/web/src/browser/previewRuntimeTabId'

class FakeMediaRecorder
{
  static instances: FakeMediaRecorder[] = []

  static isTypeSupported(): boolean
  {
    return true
  }

  state: RecordingState = 'inactive'
  readonly mimeType = 'video/webm'
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()

  constructor(
    readonly stream: MediaStream,
    readonly options: MediaRecorderOptions,
  )
  {
    FakeMediaRecorder.instances.push(this)
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void
  {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  start(): void
  {
    this.state = 'recording'
  }

  stop(): void
  {
    events.push('flush-recorder')
    this.state = 'inactive'
    for (const listener of this.listeners.get('stop') ?? [])
    {
      if (typeof listener === 'function') listener(new Event('stop'))
      else listener.handleEvent(new Event('stop'))
    }
  }
}

const capturedStreams: Array<{ readonly stop: ReturnType<typeof vi.fn> }> = []

describe('browser recording', () =>
{
  beforeEach(() =>
  {
    events.length = 0
    capturedStreams.length = 0
    FakeMediaRecorder.instances.length = 0
    surfaceState.byTabId = {
      'recording-tab': {
        visible: true,
        rect: { x: 0, y: 0, width: 800, height: 600 },
        content: { x: 0, y: 0, width: 800, height: 600, scale: 1, scrollLeft: 0, scrollTop: 0 },
      },
    }
    vi.clearAllMocks()
    vi.stubGlobal('window', globalThis)
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder as unknown as typeof MediaRecorder)
    vi.stubGlobal('document', {
      createElement: () =>
      {
        const canvas = {
          width: 0,
          height: 0,
          captureStream: (frameRate: number) =>
          {
            const stop = vi.fn(() => events.push('stop-capture'))
            const track = {
              stop,
              getSettings: () => ({ width: canvas.width, height: canvas.height, frameRate }),
            }
            capturedStreams.push({ stop })
            return { getTracks: () => [track], getVideoTracks: () => [track] }
          },
          getContext: () => ({ drawImage: vi.fn() }),
        }
        return canvas
      },
    })
  })

  afterEach(() =>
  {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('starts recording for a visible tab', async () =>
  {
    await startBrowserRecording('recording-tab')

    expect(events).toEqual(['publish:recording-tab', 'start-screencast'])

    await stopBrowserRecording('recording-tab')
    expect(events.at(-1)).toBe('clear')
  })

  it('releases capture after encoding before save and on startup failures', async () =>
  {
    surfaceState.byTabId['recording-tab'] = {
      visible: true,
      content: { width: 3840, height: 2160 },
    }
    save.mockImplementationOnce(async () =>
    {
      expect(events.indexOf('flush-recorder')).toBeLessThan(events.indexOf('stop-capture'))
      expect(capturedStreams[0]?.stop).toHaveBeenCalledOnce()
      return {
        id: 'recording-test',
        tabId: 'recording-tab',
        path: '/tmp/recording-test.webm',
        mimeType: 'video/webm',
        sizeBytes: 0,
        createdAt: '2026-06-26T00:00:00.000Z',
      }
    })
    await startBrowserRecording('recording-tab')
    const options = FakeMediaRecorder.instances[0]?.options
    await stopBrowserRecording('recording-tab')
    expect(options).toEqual({ mimeType: 'video/mp4;codecs=avc1', videoBitsPerSecond: 4_976_640 })
    expect(save).toHaveBeenCalledWith('recording-tab', 'video/webm', expect.any(Uint8Array))
    expect(capturedStreams[0]?.stop).toHaveBeenCalledOnce()

    startScreencast.mockRejectedValueOnce(new Error('native startup failed'))
    await expect(startBrowserRecording('recording-tab')).rejects.toMatchObject({
      operation: 'start-screencast',
    })
    expect(capturedStreams[1]?.stop).toHaveBeenCalledOnce()
    expect(readActiveBrowserRecordingTabId()).toBeNull()

    vi.stubGlobal(
      'MediaRecorder',
      class extends FakeMediaRecorder
      {
        constructor(stream: MediaStream, recorderOptions: MediaRecorderOptions)
        {
          super(stream, recorderOptions)
          throw new Error('encoder unavailable')
        }
      },
    )
    await expect(startBrowserRecording('recording-tab')).rejects.toMatchObject({
      operation: 'initialize-media-recorder',
    })
    expect(capturedStreams[2]?.stop).toHaveBeenCalledOnce()
    expect(save).toHaveBeenCalledOnce()
  })

  it('clears the published starting target when native startup fails', async () =>
  {
    startScreencast.mockRejectedValueOnce(new Error('native startup failed'))

    await expect(startBrowserRecording('recording-tab')).rejects.toMatchObject({
      operation: 'start-screencast',
    })
    expect(events).toEqual(['publish:recording-tab', 'flush-recorder', 'stop-capture', 'clear'])
    expect(readActiveBrowserRecordingTabId()).toBeNull()
  })

  it('keeps the runtime recording key mapped to its server tab', async () =>
  {
    const threadRef = {
      environmentId: EnvironmentId.make('environment-recording'),
      threadId: ThreadId.make('thread-recording'),
    }
    const runtimeTabId = previewRuntimeTabId(threadRef, 'epoch-a', 'tab_1')
    surfaceState.byTabId = {
      [runtimeTabId]: {
        visible: true,
        rect: { x: 0, y: 0, width: 800, height: 600 },
        content: { x: 0, y: 0, width: 800, height: 600, scale: 1, scrollLeft: 0, scrollTop: 0 },
      },
    }

    await startBrowserRecording(runtimeTabId, threadRef, 'tab_1')

    expect(startScreencast).toHaveBeenCalledWith(runtimeTabId)
    expect(readActiveBrowserRecordingTargets(threadRef)).toEqual([
      { runtimeTabId, serverTabId: 'tab_1' },
    ])
    expect(findActiveBrowserRecordingRuntimeTabId(threadRef, 'tab_1')).toBe(runtimeTabId)
    await stopBrowserRecording(runtimeTabId)
  })

  it('rejects recording for a hidden tab before starting screencast', async () =>
  {
    surfaceState.byTabId = {
      'recording-tab': {
        visible: false,
        rect: { x: 0, y: 0, width: 800, height: 600 },
        content: { x: 0, y: 0, width: 800, height: 600, scale: 1, scrollLeft: 0, scrollTop: 0 },
      },
    }

    await expect(startBrowserRecording('recording-tab')).rejects.toBeInstanceOf(
      BrowserRecordingRequiresVisibleTabError,
    )

    expect(startScreencast).not.toHaveBeenCalled()
    expect(registrySet).not.toHaveBeenCalled()
  })

  it('does not report success for a second start while the first is still starting', async () =>
  {
    let finishStartingScreencast: (() => void) | undefined
    startScreencast.mockImplementationOnce(async () =>
    {
      events.push('start-screencast')
      await new Promise<void>((resolve) =>
      {
        finishStartingScreencast = resolve
      })
    })

    const firstStart = startBrowserRecording('recording-tab')
    await vi.waitFor(() => expect(startScreencast).toHaveBeenCalledOnce())

    await expect(startBrowserRecording('recording-tab')).rejects.toBeInstanceOf(
      BrowserRecordingConflictError,
    )

    finishStartingScreencast?.()
    await firstStart
    await stopBrowserRecording('recording-tab')
  })

  it('does not report success for a start while the recording is stopping', async () =>
  {
    let finishStoppingScreencast: (() => void) | undefined
    stopScreencast.mockImplementationOnce(async () =>
    {
      await new Promise<void>((resolve) =>
      {
        finishStoppingScreencast = resolve
      })
      return undefined
    })

    await startBrowserRecording('recording-tab')
    const stopPromise = stopBrowserRecording('recording-tab')
    await vi.waitFor(() => expect(stopScreencast).toHaveBeenCalledOnce())

    await expect(startBrowserRecording('recording-tab')).rejects.toBeInstanceOf(
      BrowserRecordingConflictError,
    )

    finishStoppingScreencast?.()
    await stopPromise
  })

  it('shares an in-progress stop with duplicate callers', async () =>
  {
    let finishStoppingScreencast: (() => void) | undefined
    stopScreencast.mockImplementationOnce(async () =>
    {
      await new Promise<void>((resolve) =>
      {
        finishStoppingScreencast = resolve
      })
      return undefined
    })

    await startBrowserRecording('recording-tab')
    const firstStop = stopBrowserRecording('recording-tab')
    await vi.waitFor(() => expect(stopScreencast).toHaveBeenCalledOnce())
    const duplicateStop = stopBrowserRecording('recording-tab')

    finishStoppingScreencast?.()
    const [firstArtifact, duplicateArtifact] = await Promise.all([firstStop, duplicateStop])

    expect(duplicateArtifact).toEqual(firstArtifact)
    expect(stopScreencast).toHaveBeenCalledOnce()
    expect(save).toHaveBeenCalledOnce()
  })

  it('saves locally before transferring the encoded recording only once', async () =>
  {
    await startBrowserRecording('recording-tab')
    let finishUpload!: () => void
    const uploaded = new Promise<void>((resolve) =>
    {
      finishUpload = resolve
    })
    const transfer = vi.fn(async (artifact, blob: Blob) =>
    {
      expect(save).toHaveBeenCalledOnce()
      expect(artifact.path).toBe('/tmp/recording-test.webm')
      expect(blob).toBeInstanceOf(Blob)
      await uploaded
      return 'uploaded-recording'
    })
    const localStop = stopBrowserRecording('recording-tab')
    const firstStop = stopBrowserRecordingForUpload('recording-tab', transfer)
    const secondStop = stopBrowserRecordingForUpload('recording-tab', transfer)
    finishUpload()

    expect(await firstStop).toEqual(await secondStop)
    expect((await firstStop)?.uploadedAttachmentId).toBe('uploaded-recording')
    expect((await localStop)?.path).toBe('/tmp/recording-test.webm')
    expect(transfer).toHaveBeenCalledOnce()
  })

  it('keeps the saved desktop file and releases recording state when transfer fails', async () =>
  {
    await startBrowserRecording('recording-tab')
    await expect(
      stopBrowserRecordingForUpload('recording-tab', async () =>
      {
        throw new Error('Connection interrupted')
      }),
    ).rejects.toThrow('Connection interrupted')
    expect(save).toHaveBeenCalledOnce()
    expect(readActiveBrowserRecordingTabId()).toBeNull()
  })

  it('stops a screencast that finishes starting after cancellation', async () =>
  {
    let finishStartingScreencast: (() => void) | undefined
    startScreencast.mockImplementationOnce(async () =>
    {
      events.push('start-screencast')
      await new Promise<void>((resolve) =>
      {
        finishStartingScreencast = resolve
      })
    })

    const startPromise = startBrowserRecording('recording-tab')
    const rejectedStart = expect(startPromise).rejects.toBeInstanceOf(
      BrowserRecordingOperationError,
    )
    await vi.waitFor(() => expect(startScreencast).toHaveBeenCalledOnce())

    const stopPromise = stopBrowserRecording('recording-tab')
    await vi.waitFor(() => expect(stopScreencast).toHaveBeenCalledOnce())
    finishStartingScreencast?.()

    await rejectedStart
    await stopPromise
    expect(stopScreencast).toHaveBeenCalledTimes(2)
    expect(events.at(-1)).toBe('clear')
  })

  it('does not release the recording slot until a cancelled start settles', async () =>
  {
    let finishStartingScreencast: (() => void) | undefined
    startScreencast.mockImplementationOnce(async () =>
    {
      events.push('start-screencast')
      await new Promise<void>((resolve) =>
      {
        finishStartingScreencast = resolve
      })
    })

    const firstStart = startBrowserRecording('recording-tab')
    const rejectedFirstStart = expect(firstStart).rejects.toBeInstanceOf(
      BrowserRecordingOperationError,
    )
    await vi.waitFor(() => expect(startScreencast).toHaveBeenCalledOnce())

    const stopPromise = stopBrowserRecording('recording-tab')
    const restartAfterStop = stopPromise.then(() => startBrowserRecording('recording-tab'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const startCallsBeforeFirstSettled = startScreencast.mock.calls.length

    finishStartingScreencast?.()
    await rejectedFirstStart
    await stopPromise
    await restartAfterStop
    await stopBrowserRecording('recording-tab')

    expect(startCallsBeforeFirstSettled).toBe(1)
  })

  it('fails a stop that waits too long for startup without freeing the recording slot', async () =>
  {
    vi.useFakeTimers()
    let finishStartingScreencast: (() => void) | undefined
    startScreencast.mockImplementationOnce(async () =>
    {
      events.push('start-screencast')
      await new Promise<void>((resolve) =>
      {
        finishStartingScreencast = resolve
      })
    })

    const startPromise = startBrowserRecording('recording-tab')
    const rejectedStart = expect(startPromise).rejects.toBeInstanceOf(
      BrowserRecordingOperationError,
    )
    expect(startScreencast).toHaveBeenCalledOnce()

    const stopPromise = stopBrowserRecording('recording-tab')
    await Promise.resolve()
    await Promise.resolve()
    expect(stopScreencast).toHaveBeenCalledOnce()

    const rejection = expect(stopPromise).rejects.toMatchObject({
      operation: 'wait-startup',
      tabId: 'recording-tab',
    })
    await vi.advanceTimersByTimeAsync(BROWSER_RECORDING_STARTUP_SETTLE_TIMEOUT_MS)

    await rejection
    expect(capturedStreams[0]?.stop).toHaveBeenCalledOnce()
    expect(save).not.toHaveBeenCalled()
    await expect(startBrowserRecording('recording-tab')).rejects.toBeInstanceOf(
      BrowserRecordingConflictError,
    )

    finishStartingScreencast?.()
    await rejectedStart
    const cleanupResult = await stopBrowserRecording('recording-tab')
    expect(cleanupResult).toBeNull()
    expect(save).not.toHaveBeenCalled()
    expect(events.at(-1)).toBe('clear')
  })
})
