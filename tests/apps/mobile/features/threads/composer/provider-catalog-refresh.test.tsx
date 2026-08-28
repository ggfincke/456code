// tests/apps/mobile/features/threads/composer/provider-catalog-refresh.test.tsx
// verify native refresh feedback, duplicate taps, and retry routing

// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EnvironmentId, type ServerProvider } from '@t3tools/contracts'
import { Cause } from 'effect'
import { AsyncResult } from 'effect/unstable/reactivity'
import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test'

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), alert: vi.fn() }))
vi.mock('react-native', () => ({ Alert: { alert: mocks.alert } }))
vi.mock('../../../../../../apps/mobile/src/state/server', () => ({
  serverEnvironment: { refreshProviders: {} },
}))
vi.mock('../../../../../../apps/mobile/src/state/use-atom-command', () => ({
  useAtomCommand: () => mocks.refresh,
}))

import {
  providerCatalogRefreshFailureMessage,
  useProviderCatalogRefresh,
} from '../../../../../../apps/mobile/src/features/threads/composer/provider-catalog-refresh'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const environmentId = EnvironmentId.make('remote')
let root: Root
let refresh: ReturnType<typeof useProviderCatalogRefresh>

function Probe(props: { environmentId?: EnvironmentId | null; disabled?: boolean })
{
  refresh = useProviderCatalogRefresh(
    props.environmentId === undefined ? environmentId : props.environmentId,
    props.disabled,
  )
  return null
}

beforeEach(() =>
{
  vi.clearAllMocks()
  root = createRoot(document.createElement('div'))
})
afterEach(() => act(() => root.unmount()))

it.each([
  {
    name: 'transport failure',
    result: AsyncResult.failure<never, Error>(Cause.fail(new Error('secret-token@private-host'))),
    expected: "Unable to refresh models. Check this environment's connection and permissions.",
  },
  { name: 'interrupted', result: AsyncResult.failure<never>(Cause.interrupt()), expected: null },
  {
    name: 'enabled provider probe failures',
    result: AsyncResult.success({
      providers: [
        { enabled: true, status: 'error', message: 'secret-token@private-host' },
        { enabled: true, status: 'error' },
        { enabled: false, status: 'error' },
        { enabled: true, status: 'warning' },
      ] as ServerProvider[],
    }),
    expected:
      '2 enabled providers could not refresh their model catalog. Check provider settings and try again.',
  },
  {
    name: 'warnings and disabled errors',
    result: AsyncResult.success({
      providers: [
        { enabled: false, status: 'error' },
        { enabled: true, status: 'warning' },
      ] as ServerProvider[],
    }),
    expected: null,
  },
])('uses safe feedback for $name', ({ result, expected }) =>
{
  expect(providerCatalogRefreshFailureMessage(result)).toBe(expected)
})

it('suppresses duplicate taps, allows retry, and keeps incoming-share and environment locks', async () =>
{
  const pending = Promise.withResolvers<ReturnType<typeof AsyncResult.failure<never, Error>>>()
  mocks.refresh
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValue(AsyncResult.success({ providers: [] }))
  act(() => root.render(<Probe />))
  let first: Promise<void>
  act(() =>
  {
    first = refresh.refreshModels()
    void refresh.refreshModels()
  })
  expect(mocks.refresh).toHaveBeenCalledTimes(1)
  expect(mocks.refresh).toHaveBeenCalledWith({ environmentId, input: {} })
  expect(refresh.refreshAction.attributes.disabled).toBe(true)
  await act(async () =>
  {
    pending.resolve(AsyncResult.failure(Cause.fail(new Error('private diagnostics'))))
    await first
  })
  expect(mocks.alert).toHaveBeenCalledTimes(1)
  expect(mocks.alert).toHaveBeenLastCalledWith(
    'Could not refresh models',
    "Unable to refresh models. Check this environment's connection and permissions.",
  )
  expect(refresh.refreshAction.attributes.disabled).toBe(false)
  await act(async () =>
  {
    await refresh.refreshModels()
  })
  expect(mocks.refresh).toHaveBeenCalledTimes(2)
  act(() => root.render(<Probe disabled />))
  await act(async () =>
  {
    await refresh.refreshModels()
  })
  act(() => root.render(<Probe environmentId={null} />))
  await act(async () =>
  {
    await refresh.refreshModels()
  })
  expect(mocks.refresh).toHaveBeenCalledTimes(2)
  const other = EnvironmentId.make('other')
  act(() => root.render(<Probe environmentId={other} />))
  await act(async () =>
  {
    await refresh.refreshModels()
  })
  expect(mocks.refresh).toHaveBeenLastCalledWith({ environmentId: other, input: {} })
})
