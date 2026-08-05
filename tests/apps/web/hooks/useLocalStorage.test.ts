// tests/apps/web/hooks/useLocalStorage.test.ts
// verify local storage errors behavior

import * as Schema from 'effect/Schema'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

function createStorage(overrides: Partial<Storage> = {}): Storage
{
  const store = new Map<string, string>()
  return {
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    get length()
    {
      return store.size
    },
    removeItem: (key) =>
    {
      store.delete(key)
    },
    setItem: (key, value) =>
    {
      store.set(key, value)
    },
    ...overrides,
  }
}

async function loadWithStorage(storage: Storage)
{
  vi.stubGlobal('window', { localStorage: storage })
  vi.stubGlobal('localStorage', storage)
  return import('../../../../apps/web/src/hooks/useLocalStorage')
}

afterEach(() =>
{
  vi.resetModules()
  vi.unstubAllGlobals()
})

describe('local storage errors', () =>
{
  it.each([
    {
      label: 'read',
      storageKey: 'read-key',
      cause: new Error('storage unavailable'),
      createOverrides: (cause: Error): Partial<Storage> => ({
        getItem: () =>
        {
          throw cause
        },
      }),
      run: async (
        api: Awaited<ReturnType<typeof loadWithStorage>>,
        storageKey: string,
      ): Promise<void> =>
      {
        api.getLocalStorageItem(storageKey, Schema.String)
      },
      expectedCause: (cause: Error) => cause,
    },
    {
      label: 'decode',
      storageKey: 'decode-key',
      cause: null,
      createOverrides: (): Partial<Storage> => ({ getItem: () => 'not-json' }),
      run: async (
        api: Awaited<ReturnType<typeof loadWithStorage>>,
        storageKey: string,
      ): Promise<void> =>
      {
        api.getLocalStorageItem(storageKey, Schema.String)
      },
      expectedCause: () => expect.anything(),
    },
    {
      label: 'write',
      storageKey: 'write-key',
      cause: new Error('storage quota exceeded'),
      createOverrides: (cause: Error): Partial<Storage> => ({
        setItem: () =>
        {
          throw cause
        },
      }),
      run: async (
        api: Awaited<ReturnType<typeof loadWithStorage>>,
        storageKey: string,
      ): Promise<void> =>
      {
        api.setLocalStorageItem(storageKey, 'value', Schema.String)
      },
      expectedCause: (cause: Error) => cause,
    },
    {
      label: 'remove',
      storageKey: 'remove-key',
      cause: new Error('storage unavailable'),
      createOverrides: (cause: Error): Partial<Storage> => ({
        removeItem: () =>
        {
          throw cause
        },
      }),
      run: async (
        api: Awaited<ReturnType<typeof loadWithStorage>>,
        storageKey: string,
      ): Promise<void> =>
      {
        api.removeLocalStorageItem(storageKey)
      },
      expectedCause: (cause: Error) => cause,
    },
  ])(
    'preserves $label failure context',
    async ({ label, storageKey, cause, createOverrides, run, expectedCause }) =>
    {
      const { LocalStorageOperationError, ...api } = await loadWithStorage(
        createStorage(createOverrides(cause ?? new Error('unused'))),
      )

      try
      {
        await run({ LocalStorageOperationError, ...api }, storageKey)
        expect.unreachable(`expected the ${label} to fail`)
      }
      catch (error)
      {
        expect(error).toBeInstanceOf(LocalStorageOperationError)
        expect(error).toMatchObject({
          operation: label,
          storageKey,
          cause: expectedCause(cause ?? new Error('unused')),
        })
      }
    },
  )
})
