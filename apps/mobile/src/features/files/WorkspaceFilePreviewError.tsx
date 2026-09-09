// apps/mobile/src/features/files/WorkspaceFilePreviewError.tsx
// render a retryable terminal file-preview failure

import type { EnvironmentId } from '@t3tools/contracts'
import { useCallback } from 'react'
import { View } from 'react-native'

import { EmptyState } from '../../components/EmptyState'
import { environmentCatalog } from '../../connection/catalog'
import type { AssetUrlState } from '../../state/assets'
import { useAtomCommand } from '../../state/use-atom-command'
import { useEnvironmentPresentation } from '../../state/presentation'
import { EnvironmentConnectionNotice } from '../connection/EnvironmentConnectionNotice'

type PreviewFailure = Extract<AssetUrlState, { readonly _tag: 'Failure' }>

export function WorkspaceFilePreviewError(props: {
  readonly environmentId: EnvironmentId | null
  readonly failure: PreviewFailure
})
{
  const environment = useEnvironmentPresentation(props.environmentId)
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, 'environment retry')
  const retryConnection = useCallback(() =>
  {
    if (props.environmentId !== null) void retryEnvironment(props.environmentId)
    props.failure.retry()
  }, [props.environmentId, props.failure, retryEnvironment])

  if (props.failure.reason === 'disconnected')
  {
    return (
      <View className="flex-1 bg-sheet">
        <EnvironmentConnectionNotice
          environmentLabel={environment.presentation?.entry.target.label ?? 'Environment'}
          connection={
            environment.presentation?.connection ?? {
              phase: 'available',
              error: props.failure.error,
              traceId: null,
            }
          }
          resourceName="preview"
          onRetry={retryConnection}
        />
      </View>
    )
  }

  return (
    <View className="flex-1 items-center justify-center bg-sheet px-6">
      <EmptyState
        title="Preview unavailable"
        detail={props.failure.error}
        actionLabel="Try again"
        onAction={props.failure.retry}
      />
    </View>
  )
}
