// tests/apps/web/components/files/fileSaveCoordinator.test.ts
// verifies debounced file persistence and pending ownership

import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import type { AtomCommandResult } from '@t3tools/client-runtime/state/runtime'
import * as Cause from 'effect/Cause'
import { AsyncResult } from 'effect/unstable/reactivity'

import {
  FileSaveCoordinator,
  updateFileSavePendingOwners,
} from '../../../../../apps/web/src/components/files/fileSaveCoordinator'

function deferred<E = never>()
{
  let resolve!: (result: AtomCommandResult<void, E>) => void
  const promise = new Promise<AtomCommandResult<void, E>>((resolvePromise) =>
  {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('FileSaveCoordinator', () =>
{
  afterEach(() =>
  {
    vi.useRealTimers()
  })

  it('debounces edits and persists only the latest contents', async () =>
  {
    vi.useFakeTimers()
    const persist = vi
      .fn<(contents: string) => Promise<AtomCommandResult<void, never>>>()
      .mockResolvedValue(AsyncResult.success(undefined))
    const onPendingChange = vi.fn()
    const onConfirmed = vi.fn()
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange,
      onConfirmed,
    })

    coordinator.change('first')
    await vi.advanceTimersByTimeAsync(300)
    coordinator.change('latest')
    await vi.advanceTimersByTimeAsync(499)
    expect(persist).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(persist).toHaveBeenCalledOnce()
    expect(persist).toHaveBeenCalledWith('latest')
    expect(onConfirmed).toHaveBeenCalledWith('latest')
    expect(onPendingChange.mock.calls).toEqual([[true], [true], [false]])
  })

  it('keeps pending state until an edit made during a write is also saved', async () =>
  {
    vi.useFakeTimers()
    const firstWrite = deferred()
    const persist = vi
      .fn<(contents: string) => Promise<AtomCommandResult<void, never>>>()
      .mockReturnValueOnce(firstWrite.promise)
      .mockResolvedValueOnce(AsyncResult.success(undefined))
    const onPendingChange = vi.fn()
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange,
      onConfirmed: vi.fn(),
    })

    coordinator.change('first')
    await vi.advanceTimersByTimeAsync(500)
    coordinator.change('latest')
    await vi.advanceTimersByTimeAsync(500)
    expect(persist).toHaveBeenCalledTimes(1)

    firstWrite.resolve(AsyncResult.success(undefined))
    await vi.runAllTimersAsync()
    expect(persist).toHaveBeenCalledTimes(2)
    expect(persist).toHaveBeenLastCalledWith('latest')
    expect(onPendingChange.mock.calls.at(-1)).toEqual([false])
  })

  it('flushes the latest edit when the editor closes during a write', async () =>
  {
    vi.useFakeTimers()
    const inFlight = deferred()
    const persist = vi
      .fn<(contents: string) => Promise<AtomCommandResult<void, never>>>()
      .mockReturnValueOnce(inFlight.promise)
      .mockResolvedValue(AsyncResult.success(undefined))
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    })

    coordinator.change('first')
    await vi.advanceTimersByTimeAsync(500)
    coordinator.change('latest')
    coordinator.dispose()
    inFlight.resolve(AsyncResult.success(undefined))
    await vi.runAllTimersAsync()

    expect(persist).toHaveBeenCalledTimes(2)
    expect(persist).toHaveBeenLastCalledWith('latest')
  })

  it('does not rewrite a confirmed revision when the editor closes', async () =>
  {
    vi.useFakeTimers()
    const inFlight = deferred()
    const persist = vi
      .fn<(contents: string) => Promise<AtomCommandResult<void, never>>>()
      .mockReturnValueOnce(inFlight.promise)
      .mockResolvedValue(AsyncResult.success(undefined))
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    })

    coordinator.change('only')
    await vi.advanceTimersByTimeAsync(500)
    coordinator.dispose()
    inFlight.resolve(AsyncResult.success(undefined))
    await vi.runAllTimersAsync()

    expect(persist).toHaveBeenCalledOnce()
  })

  it('retries a completed failed write once when the editor closes', async () =>
  {
    vi.useFakeTimers()
    const persist = vi
      .fn<(contents: string) => Promise<AtomCommandResult<void, Error>>>()
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error('write failed'))))
      .mockResolvedValue(AsyncResult.success(undefined))
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    })

    coordinator.change('latest')
    await vi.advanceTimersByTimeAsync(500)
    expect(persist).toHaveBeenCalledOnce()

    coordinator.dispose()
    await vi.runAllTimersAsync()

    expect(persist).toHaveBeenCalledTimes(2)
    expect(persist).toHaveBeenLastCalledWith('latest')
  })

  it('does not retry a failed in-flight write behind a replacement coordinator', async () =>
  {
    vi.useFakeTimers()
    const inFlight = deferred<Error>()
    let backingContents = ''
    const stalePersist = vi
      .fn<(contents: string) => Promise<AtomCommandResult<void, Error>>>()
      .mockReturnValueOnce(inFlight.promise)
      .mockImplementation(async (contents) =>
      {
        backingContents = contents
        return AsyncResult.success(undefined)
      })
    const staleCoordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist: stalePersist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    })
    const replacementCoordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist: async (contents) =>
      {
        backingContents = contents
        return AsyncResult.success(undefined)
      },
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    })

    staleCoordinator.change('stale')
    await vi.advanceTimersByTimeAsync(500)
    staleCoordinator.dispose()

    replacementCoordinator.change('replacement')
    await vi.advanceTimersByTimeAsync(500)
    expect(backingContents).toBe('replacement')

    inFlight.resolve(AsyncResult.failure(Cause.fail(new Error('write failed'))))
    await vi.runAllTimersAsync()

    expect(stalePersist).toHaveBeenCalledOnce()
    expect(backingContents).toBe('replacement')
  })

  it('leaves the file pending when the latest write fails', async () =>
  {
    vi.useFakeTimers()
    const onPendingChange = vi.fn()
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist: vi
        .fn()
        .mockResolvedValue(AsyncResult.failure(Cause.fail(new Error('write failed')))),
      onPendingChange,
      onConfirmed: vi.fn(),
    })

    coordinator.change('latest')
    await vi.advanceTimersByTimeAsync(500)
    await Promise.resolve()
    expect(onPendingChange).toHaveBeenCalledWith(true)
    expect(onPendingChange).not.toHaveBeenCalledWith(false)
  })

  it('ignores editor changes emitted after disposal', async () =>
  {
    vi.useFakeTimers()
    const persist = vi
      .fn<(contents: string) => Promise<AtomCommandResult<void, never>>>()
      .mockResolvedValue(AsyncResult.success(undefined))
    const onPendingChange = vi.fn()
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange,
      onConfirmed: vi.fn(),
    })

    coordinator.dispose()
    coordinator.change('stale contents')
    await vi.runAllTimersAsync()

    expect(persist).not.toHaveBeenCalled()
    expect(onPendingChange).not.toHaveBeenCalled()
  })

  it('keeps a path pending until every overlapping coordinator settles', () =>
  {
    const firstOwner = Symbol('first')
    const secondOwner = Symbol('second')
    let pending: ReadonlyMap<string, ReadonlySet<symbol>> = new Map()

    pending = updateFileSavePendingOwners(pending, 'docs/guide.mdx', firstOwner, true)
    pending = updateFileSavePendingOwners(pending, 'docs/guide.mdx', secondOwner, true)
    pending = updateFileSavePendingOwners(pending, 'docs/guide.mdx', firstOwner, false)
    expect(pending.get('docs/guide.mdx')).toEqual(new Set([secondOwner]))

    pending = updateFileSavePendingOwners(pending, 'docs/guide.mdx', secondOwner, false)
    expect(pending.has('docs/guide.mdx')).toBe(false)
  })

  it('retires an older failed owner when the newest coordinator saves successfully', () =>
  {
    const failedOwner = Symbol('failed')
    const successfulOwner = Symbol('successful')
    let pending: ReadonlyMap<string, ReadonlySet<symbol>> = new Map()

    pending = updateFileSavePendingOwners(pending, 'docs/guide.mdx', failedOwner, true)
    pending = updateFileSavePendingOwners(pending, 'docs/guide.mdx', successfulOwner, true)
    pending = updateFileSavePendingOwners(pending, 'docs/guide.mdx', successfulOwner, false)

    expect(pending.has('docs/guide.mdx')).toBe(false)
  })
})
