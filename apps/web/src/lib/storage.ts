// apps/web/src/lib/storage.ts
// persist storage data

import { Debouncer } from '@tanstack/react-pacer'

export interface StateStorage<R = unknown>
{
  getItem: (name: string) => string | null | Promise<string | null>
  setItem: (name: string, value: string) => R
  removeItem: (name: string) => R
}

export interface DebouncedStorage<R = unknown> extends StateStorage<R>
{
  flush: () => void
}

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
  const resolvedStorage = resolveStorage(baseStorage)
  const debouncedSetItems = new Map<string, Debouncer<(value: string) => void>>()
  const getDebouncedSetItem = (name: string) =>
  {
    const existing = debouncedSetItems.get(name)
    if (existing !== undefined)
    {
      return existing
    }
    const created: Debouncer<(value: string) => void> = new Debouncer(
      (value: string) =>
      {
        resolvedStorage.setItem(name, value)
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
