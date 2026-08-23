// apps/web/src/components/chat/runtimeModeWarnings.ts
// resolve when a provider session needs an explicitly confirmed runtime warning

import type {
  ModelSelection,
  ProviderRuntimeCapabilities,
  ProviderRuntimeModeWarning,
  RuntimeMode,
} from '@t3tools/contracts'

interface RuntimeModeWarningSession
{
  readonly providerInstanceId?: ModelSelection['instanceId'] | undefined
  readonly runtimeMode: RuntimeMode
  readonly status: string
}

export function resolveRuntimeModeStartWarnings(input: {
  readonly capabilities: ProviderRuntimeCapabilities
  readonly confirmedIds: ReadonlyArray<string>
  readonly currentModelSelection: ModelSelection
  readonly session: RuntimeModeWarningSession | null
  readonly targetModelSelection: ModelSelection
  readonly runtimeMode: RuntimeMode
}): {
  readonly acknowledgements: ReadonlyArray<string>
  readonly missingWarning: ProviderRuntimeModeWarning | null
}
{
  const sessionInstanceId =
    input.session?.providerInstanceId ?? input.currentModelSelection.instanceId
  const startsFreshSession =
    input.session === null ||
    input.session.status === 'stopped' ||
    input.session.runtimeMode !== input.runtimeMode ||
    sessionInstanceId !== input.targetModelSelection.instanceId
  if (!startsFreshSession)
  {
    return { acknowledgements: [], missingWarning: null }
  }

  const requiredWarnings = input.capabilities.runtimeModeWarnings.filter(
    (warning) => warning.mode === input.runtimeMode && warning.requiresAcknowledgement,
  )
  const confirmed = new Set(input.confirmedIds)
  const acknowledgements = requiredWarnings
    .filter((warning) => confirmed.has(warning.id))
    .map((warning) => warning.id)
  return {
    acknowledgements,
    missingWarning: requiredWarnings.find((warning) => !confirmed.has(warning.id)) ?? null,
  }
}
