// apps/web/src/lib/storage.ts
// persist storage data

import { Debouncer } from '@tanstack/react-pacer'

export interface StateStorage<R = unknown>
{
  getItem: (name: string) => string | null | Promise<string | null>
  setItem: (name: string, value: string) => R
  removeItem: (name: string) => R
}

export interface DeferredStorage<TValue>
{
  getItem: StateStorage['getItem']
  setItem: (name: string, value: TValue) => void
  removeItem: (name: string) => void
  flush: () => void
}

export type DebouncedStorage = DeferredStorage<string>

export function createMemoryStorage(): StateStorage
{
  const store = new Map<string, string>()
  return {
    getItem: (name) => store.get(name) ?? null,
    setItem: (name, value) =>
    {
      store.set(name, value)
    },
    removeItem: (name) =>
    {
      store.delete(name)
    },
  }
}

export function isStateStorage(
  storage: Partial<StateStorage> | null | undefined,
): storage is StateStorage
{
  return (
    storage !== null &&
    storage !== undefined &&
    typeof storage.getItem === 'function' &&
    typeof storage.setItem === 'function' &&
    typeof storage.removeItem === 'function'
  )
}

export function resolveStorage(storage: Partial<StateStorage> | null | undefined): StateStorage
{
  return isStateStorage(storage) ? storage : createMemoryStorage()
}

export function createDebouncedStorage(
  baseStorage: Partial<StateStorage> | null | undefined,
  debounceMs: number = 300,
): DebouncedStorage
{
  return createDeferredStorage(baseStorage, (value: string) => value, debounceMs)
}

// retain immutable values until flush so expensive serialization stays off the typing path.
export function createDeferredStorage<TValue>(
  baseStorage: Partial<StateStorage> | null | undefined,
  serialize: (value: TValue) => string,
  debounceMs: number = 300,
): DeferredStorage<TValue>
{
  const resolvedStorage = resolveStorage(baseStorage)
  const debouncedSetItems = new Map<string, Debouncer<(value: TValue) => void>>()
  const getDebouncedSetItem = (name: string) =>
  {
    const existing = debouncedSetItems.get(name)
    if (existing !== undefined)
    {
      return existing
    }
    const created: Debouncer<(value: TValue) => void> = new Debouncer(
      (value: TValue) =>
      {
        resolvedStorage.setItem(name, serialize(value))
        if (debouncedSetItems.get(name) === created)
        {
          debouncedSetItems.delete(name)
        }
      },
      { wait: debounceMs },
    )
    debouncedSetItems.set(name, created)
    return created
  }

  return {
    getItem: (name) => resolvedStorage.getItem(name),
    setItem: (name, value) =>
    {
      getDebouncedSetItem(name).maybeExecute(value)
    },
    removeItem: (name) =>
    {
      debouncedSetItems.get(name)?.cancel()
      debouncedSetItems.get(name)?.reset()
      debouncedSetItems.delete(name)
      resolvedStorage.removeItem(name)
    },
    flush: () =>
    {
      for (const debouncedSetItem of debouncedSetItems.values())
      {
        debouncedSetItem.flush()
      }
    },
  }
}
