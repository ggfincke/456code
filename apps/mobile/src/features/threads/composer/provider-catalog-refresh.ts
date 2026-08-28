// apps/mobile/src/features/threads/composer/provider-catalog-refresh.ts
// share native model refresh progress and safe failure feedback

import type { EnvironmentId, ServerProviderUpdatedPayload } from '@t3tools/contracts'
import type { AtomCommandResult } from '@t3tools/client-runtime/state/runtime'
import { Cause } from 'effect'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert } from 'react-native'
import { serverEnvironment } from '../../../state/server'
import { useAtomCommand } from '../../../state/use-atom-command'

export const REFRESH_MODELS_ACTION = 'refresh-models'

export function providerCatalogRefreshFailureMessage(
  result: AtomCommandResult<ServerProviderUpdatedPayload, unknown>,
): string | null
{
  if (result._tag === 'Failure')
  {
    return Cause.hasInterruptsOnly(result.cause)
      ? null
      : "Unable to refresh models. Check this environment's connection and permissions."
  }
  const errorCount = result.value.providers.filter(
    (provider) => provider.enabled && provider.status === 'error',
  ).length
  if (errorCount === 0) return null
  return `${errorCount} enabled provider${errorCount === 1 ? '' : 's'} could not refresh ${errorCount === 1 ? 'its' : 'their'} model catalog. Check provider settings and try again.`
}

export function useProviderCatalogRefresh(environmentId: EnvironmentId | null, disabled = false)
{
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  })
  const [isRefreshing, setIsRefreshing] = useState(false)
  const pending = useRef(false)
  const currentEnvironment = useRef(environmentId)

  useEffect(() =>
  {
    currentEnvironment.current = environmentId
    return () =>
    {
      currentEnvironment.current = null
    }
  }, [environmentId])

  async function refreshModels(): Promise<void>
  {
    if (!environmentId || disabled || pending.current) return
    pending.current = true
    setIsRefreshing(true)
    try
    {
      const result = await refreshProviders({ environmentId, input: {} })
      const message = providerCatalogRefreshFailureMessage(result)
      if (message && currentEnvironment.current === environmentId)
      {
        Alert.alert('Could not refresh models', message)
      }
    }
    finally
    {
      pending.current = false
      setIsRefreshing(false)
    }
  }

  const refreshAction = useMemo(
    () => ({
      id: REFRESH_MODELS_ACTION,
      title: isRefreshing ? 'Refreshing models…' : 'Refresh models',
      image: 'arrow.clockwise',
      attributes: { disabled: disabled || !environmentId || isRefreshing },
    }),
    [disabled, environmentId, isRefreshing],
  )

  return { refreshModels, refreshAction }
}
