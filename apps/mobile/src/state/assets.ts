// apps/mobile/src/state/assets.ts
// manage retryable asset URL state

import { useAtomRefresh, useAtomValue } from '@effect/atom-react'
import type { PreparedConnection } from '@t3tools/client-runtime/connection'
import { createAssetEnvironmentAtoms, resolveAssetUrl } from '@t3tools/client-runtime/state/assets'
import type { AssetCreateUrlResult, AssetResource, EnvironmentId } from '@t3tools/contracts'
import * as Cause from 'effect/Cause'
import * as Option from 'effect/Option'
import { AsyncResult, Atom } from 'effect/unstable/reactivity'
import { useCallback } from 'react'

import { connectionAtomRuntime } from '../connection/runtime'
import { environmentSession } from './session'

export const assetEnvironment = createAssetEnvironmentAtoms(connectionAtomRuntime)

const EMPTY_ASSET_URL_ATOM = Atom.make(
  AsyncResult.initial<AssetCreateUrlResult, unknown>(false),
).pipe(Atom.withLabel('mobile-asset-url:empty'))
const EMPTY_PREPARED_CONNECTION_ATOM = Atom.make(
  AsyncResult.initial<Option.Option<PreparedConnection>, unknown>(false),
).pipe(Atom.withLabel('mobile-asset-prepared-connection:empty'))

export type AssetUrlState =
  | { readonly _tag: 'Idle'; readonly retry: () => void }
  | { readonly _tag: 'Loading'; readonly retry: () => void }
  | { readonly _tag: 'Failure'; readonly error: string; readonly retry: () => void }
  | { readonly _tag: 'Success'; readonly url: string; readonly retry: () => void }

function formatAssetUrlError(cause: Cause.Cause<unknown>): string
{
  const error = Cause.squash(cause)
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : 'The preview URL could not be created.'
}

export function useAssetUrl(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): AssetUrlState
{
  const assetUrlAtom: Atom.Atom<AsyncResult.AsyncResult<AssetCreateUrlResult, unknown>> =
    environmentId === null || resource === null
      ? EMPTY_ASSET_URL_ATOM
      : assetEnvironment.createUrl({ environmentId, input: { resource } })
  const preparedConnectionAtom: Atom.Atom<
    AsyncResult.AsyncResult<Option.Option<PreparedConnection>, unknown>
  > =
    environmentId === null
      ? EMPTY_PREPARED_CONNECTION_ATOM
      : environmentSession.preparedConnectionAtom(environmentId)
  const result = useAtomValue(assetUrlAtom)
  const preparedResult = useAtomValue(preparedConnectionAtom)
  const refreshAssetUrl = useAtomRefresh(assetUrlAtom)
  const refreshPreparedConnection = useAtomRefresh(preparedConnectionAtom)
  const retry = useCallback(() =>
  {
    refreshPreparedConnection()
    refreshAssetUrl()
  }, [refreshAssetUrl, refreshPreparedConnection])

  if (environmentId === null || resource === null)
  {
    return { _tag: 'Idle', retry }
  }
  if (result._tag === 'Failure')
  {
    return { _tag: 'Failure', error: formatAssetUrlError(result.cause), retry }
  }
  if (preparedResult._tag === 'Failure')
  {
    return { _tag: 'Failure', error: formatAssetUrlError(preparedResult.cause), retry }
  }
  if (result._tag !== 'Success' || preparedResult._tag !== 'Success')
  {
    return { _tag: 'Loading', retry }
  }
  const preparedConnection = Option.getOrNull(preparedResult.value)
  if (preparedConnection === null)
  {
    return {
      _tag: 'Failure',
      error: 'The environment connection is unavailable. Reconnect and try again.',
      retry,
    }
  }
  const url = resolveAssetUrl(preparedConnection.httpBaseUrl, result.value.relativeUrl)
  return url === null
    ? { _tag: 'Failure', error: 'The preview URL returned by the environment is invalid.', retry }
    : { _tag: 'Success', url, retry }
}
