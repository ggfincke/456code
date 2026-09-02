// apps/web/src/components/files/fileSaveCoordinator.ts
// coordinates debounced file saves and aggregate pending ownership

import type { AtomCommandResult } from '@t3tools/client-runtime/state/runtime'

export type FileSavePendingOwner = symbol

export function updateFileSavePendingOwners(
  current: ReadonlyMap<string, ReadonlySet<FileSavePendingOwner>>,
  relativePath: string,
  owner: FileSavePendingOwner,
  pending: boolean,
): ReadonlyMap<string, ReadonlySet<FileSavePendingOwner>>
{
  const currentOwners = current.get(relativePath) ?? new Set<FileSavePendingOwner>()
  if (currentOwners.has(owner) === pending) return current

  const next = new Map(current)
  const nextOwners = new Set(currentOwners)
  if (pending)
  {
    nextOwners.add(owner)
    next.set(relativePath, nextOwners)
  }
  else
  {
    const latestOwner = Array.from(currentOwners).at(-1)
    // a successful newest save supersedes older failed writes for the same path
    if (latestOwner === owner)
    {
      next.delete(relativePath)
      return next
    }
    nextOwners.delete(owner)
    if (nextOwners.size === 0) next.delete(relativePath)
    else next.set(relativePath, nextOwners)
  }
  return next
}

export interface FileSaveCoordinatorOptions<A, E>
{
  readonly debounceMs: number
  readonly persist: (contents: string) => Promise<AtomCommandResult<A, E>>
  readonly onPendingChange: (pending: boolean) => void
  readonly onConfirmed: (contents: string) => void
}

export class FileSaveCoordinator<A = unknown, E = unknown>
{
  private timer: ReturnType<typeof setTimeout> | null = null
  private latestContents = ''
  private latestRevision = 0
  private confirmedRevision = 0
  private disposedFlushRevision = 0
  private lastChangeAt = 0
  private saving = false
  private disposed = false

  constructor(private readonly options: FileSaveCoordinatorOptions<A, E>)
  {}

  change(contents: string): void
  {
    if (this.disposed) return
    this.latestContents = contents
    this.latestRevision += 1
    this.lastChangeAt = Date.now()
    this.options.onPendingChange(true)
    this.schedule(this.options.debounceMs)
  }

  dispose(): void
  {
    if (this.disposed) return
    this.disposed = true
    this.clearTimer()
    if (this.latestRevision > 0) void this.persistLatest(true)
  }

  private schedule(delay: number): void
  {
    this.clearTimer()
    this.timer = setTimeout(() =>
    {
      this.timer = null
      void this.persistLatest()
    }, delay)
  }

  private clearTimer(): void
  {
    if (this.timer === null) return
    clearTimeout(this.timer)
    this.timer = null
  }

  private async persistLatest(disposalFlush = false): Promise<void>
  {
    if (this.saving || this.latestRevision === this.confirmedRevision) return

    const contents = this.latestContents
    const revision = this.latestRevision
    if (this.disposed)
    {
      if (!disposalFlush || this.disposedFlushRevision === revision) return
      this.disposedFlushRevision = revision
    }

    this.saving = true
    const result = await this.options.persist(contents)
    const succeeded = result._tag === 'Success'
    if (succeeded)
    {
      this.confirmedRevision = revision
      this.options.onConfirmed(contents)
    }

    this.saving = false
    if (revision === this.latestRevision)
    {
      if (succeeded) this.options.onPendingChange(false)
      return
    }

    const remainingDebounce = Math.max(
      0,
      this.options.debounceMs - (Date.now() - this.lastChangeAt),
    )
    if (this.disposed)
    {
      void this.persistLatest(true)
    }
    else
    {
      this.schedule(remainingDebounce)
    }
  }
}
