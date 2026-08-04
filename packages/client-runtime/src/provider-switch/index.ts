// packages/client-runtime/src/provider-switch/index.ts
// shares provider-switch protocol and presentation primitives across clients

import type { OrchestrationProviderSwitch, OrchestrationThreadActivity } from '@t3tools/contracts'

export type ProviderSwitchPhase = OrchestrationProviderSwitch['phase']

export const PROVIDER_SWITCH_COMPLETED_ACTIVITY_KIND = 'provider.switch.completed'
export const PROVIDER_SWITCH_FAILED_ACTIVITY_KIND = 'provider.switch.failed'

const PROVIDER_SWITCH_FAILURE_REASONS: Readonly<Record<string, string>> = {
  'compaction-timeout': 'the summary took too long',
  'compaction-failed': 'the summary could not be generated',
  'stop-failed': 'the current session could not be stopped',
  'target-unavailable': 'the new provider was unavailable',
  'stale-instance': 'the thread had already moved to another provider',
  'switch-in-progress': 'another switch was already running',
  'interrupted-by-restart': 'the server restarted mid-switch',
  'internal-error': 'an unexpected error occurred',
}

const UNKNOWN_PROVIDER_SWITCH_FAILURE_REASON = 'an unexpected error occurred'

// map a server reason code to the sentence fragment shown after "failed —"
export function describeProviderSwitchFailureReason(reasonCode: string | null | undefined): string
{
  const normalized = reasonCode?.trim()
  if (!normalized)
  {
    return UNKNOWN_PROVIDER_SWITCH_FAILURE_REASON
  }
  return PROVIDER_SWITCH_FAILURE_REASONS[normalized] ?? normalized
}

// name one switch target unambiguously
export function formatProviderSwitchTargetLabel(input: {
  readonly instanceId: string
  readonly displayName?: string | null | undefined
  readonly model?: string | null | undefined
}): string
{
  const displayName = input.displayName?.trim()
  const model = input.model?.trim()
  const instance = displayName && displayName.length > 0 ? displayName : input.instanceId
  return model && model.length > 0 && model !== instance ? `${instance} · ${model}` : instance
}

export function readPayload(activity: OrchestrationThreadActivity): Record<string, unknown> | null
{
  return activity.payload && typeof activity.payload === 'object'
    ? (activity.payload as Record<string, unknown>)
    : null
}

export function readString(payload: Record<string, unknown> | null, key: string): string | null
{
  const value = payload?.[key]
  if (typeof value !== 'string')
  {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}
