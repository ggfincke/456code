// apps/mobile/src/lib/providerRuntimeModeWarnings.ts
// confirm server-reported runtime warnings before mobile starts a provider session

import {
  type ModelSelection,
  type ProviderRuntimeCapabilities,
  type ProviderRuntimeModeWarning,
  type ProviderRuntimeModeWarningId,
  type RuntimeMode,
} from '@t3tools/contracts'
import { Alert } from 'react-native'

export function requiredProviderRuntimeModeWarnings(
  capabilities: ProviderRuntimeCapabilities,
  runtimeMode: RuntimeMode,
): ReadonlyArray<ProviderRuntimeModeWarning>
{
  return capabilities.runtimeModeWarnings.filter(
    (warning) => warning.mode === runtimeMode && warning.requiresAcknowledgement,
  )
}

export function providerSessionNeedsRuntimeModeAcknowledgement(input: {
  readonly currentModelSelection: ModelSelection
  readonly session: {
    readonly providerInstanceId?: ModelSelection['instanceId']
    readonly runtimeMode: RuntimeMode
    readonly status: string
  } | null
  readonly targetModelSelection: ModelSelection
  readonly runtimeMode: RuntimeMode
}): boolean
{
  const sessionInstanceId =
    input.session?.providerInstanceId ?? input.currentModelSelection.instanceId
  return (
    input.session === null ||
    input.session.status === 'stopped' ||
    input.session.runtimeMode !== input.runtimeMode ||
    sessionInstanceId !== input.targetModelSelection.instanceId
  )
}

function confirmWarning(warning: ProviderRuntimeModeWarning): Promise<boolean>
{
  return new Promise((resolve) =>
  {
    Alert.alert(
      warning.mode === 'full-access' ? 'Start with full access?' : 'Confirm provider mode',
      warning.message,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        {
          text: 'I understand, start',
          style: warning.severity === 'danger' ? 'destructive' : 'default',
          onPress: () => resolve(true),
        },
      ],
    )
  })
}

export async function confirmProviderRuntimeModeWarnings(
  capabilities: ProviderRuntimeCapabilities,
  runtimeMode: RuntimeMode,
): Promise<ReadonlyArray<ProviderRuntimeModeWarningId> | null>
{
  const acknowledgements: ProviderRuntimeModeWarningId[] = []
  for (const warning of requiredProviderRuntimeModeWarnings(capabilities, runtimeMode))
  {
    if (!(await confirmWarning(warning)))
    {
      return null
    }
    acknowledgements.push(warning.id)
  }
  return acknowledgements
}
