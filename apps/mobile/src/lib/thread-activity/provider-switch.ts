// apps/mobile/src/lib/thread-activity/provider-switch.ts
// derives mobile provider-switch lifecycle copy, outcomes, and notice state

import {
  describeProviderSwitchFailureReason,
  formatProviderSwitchTargetLabel,
  PROVIDER_SWITCH_COMPLETED_ACTIVITY_KIND,
  PROVIDER_SWITCH_FAILED_ACTIVITY_KIND,
  providerSwitchBlockReason,
  readPayload,
  readString,
  type ProviderSwitchPhase,
} from '@t3tools/client-runtime/provider-switch'
import type {
  ModelSelection,
  OrchestrationProviderSwitch,
  OrchestrationThreadActivity,
  ProviderInstanceId,
} from '@t3tools/contracts'
import { compareOrchestrationThreadActivities } from '@t3tools/shared/orchestrationActivityOrder'

export {
  describeProviderSwitchFailureReason,
  formatProviderSwitchTargetLabel,
  providerSwitchBlockReason,
  PROVIDER_SWITCH_COMPLETED_ACTIVITY_KIND,
  PROVIDER_SWITCH_FAILED_ACTIVITY_KIND,
  type ProviderSwitchPhase,
}

// * a switch runs server-side across a compaction and a session handoff; there
//   is no client-side cancel for it, and the composer must say so instead of
//   offering a stop button that would only interrupt the outgoing provider.
export const PROVIDER_SWITCH_UNCANCELABLE_NOTICE =
  'This switch cannot be cancelled. Your message sends once it finishes.'

export function resolveProviderSwitchPillLabel(input: {
  readonly phase: ProviderSwitchPhase
  readonly targetLabel: string
}): string
{
  switch (input.phase)
  {
    case 'pending':
      return `Switching to ${input.targetLabel}…`
    case 'compacting':
      return `Summarizing this thread for ${input.targetLabel}…`
    case 'finalizing':
      return `Finishing switch to ${input.targetLabel}…`
  }
}

export type ProviderSwitchOutcomeStatus = 'completed' | 'failed'

export interface ProviderSwitchOutcome
{
  readonly id: string
  readonly createdAt: string
  readonly status: ProviderSwitchOutcomeStatus
  readonly instanceId: ProviderInstanceId | null
  readonly model: string | null
  // durable selection to re-dispatch on retry; null when the outcome predates
  // the server persisting one, which disables retry rather than guessing.
  readonly retrySelection: ModelSelection | null
  readonly reasonCode: string | null
  readonly detail: string | null
}

// the server writes the whole selection under one of two keys depending on the
// outcome kind; reading both keeps one derivation for either. Falling back to
// the flat instance/model pair covers outcomes written before either key.
function readRetrySelection(payload: Record<string, unknown> | null): ModelSelection | null
{
  for (const key of ['retryTargetModelSelection', 'targetModelSelection'])
  {
    const value = payload?.[key]
    if (value && typeof value === 'object')
    {
      const candidate = value as Record<string, unknown>
      const instanceId = typeof candidate.instanceId === 'string' ? candidate.instanceId.trim() : ''
      const model = typeof candidate.model === 'string' ? candidate.model.trim() : ''
      if (instanceId.length > 0 && model.length > 0)
      {
        return value as ModelSelection
      }
    }
  }
  const instanceId = readString(payload, 'toInstanceId') ?? readString(payload, 'targetInstanceId')
  const model = readString(payload, 'toModel') ?? readString(payload, 'targetModel')
  if (instanceId === null || model === null)
  {
    return null
  }
  return { instanceId: instanceId as ProviderInstanceId, model }
}

// the newest switch outcome in the thread's activity log, or null when the
// thread has never switched. Only the newest one is presented: older outcomes
// stay readable in the work log.
export function deriveLatestProviderSwitchOutcome(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ProviderSwitchOutcome | null
{
  const ordered = [...activities].toSorted(compareOrchestrationThreadActivities)
  let latest: ProviderSwitchOutcome | null = null

  for (const activity of ordered)
  {
    if (
      activity.kind !== PROVIDER_SWITCH_COMPLETED_ACTIVITY_KIND &&
      activity.kind !== PROVIDER_SWITCH_FAILED_ACTIVITY_KIND
    )
    {
      continue
    }
    const payload = readPayload(activity)
    const retrySelection = readRetrySelection(payload)
    latest = {
      id: activity.id,
      createdAt: activity.createdAt,
      status: activity.kind === PROVIDER_SWITCH_FAILED_ACTIVITY_KIND ? 'failed' : 'completed',
      instanceId:
        retrySelection?.instanceId ??
        (readString(payload, 'toInstanceId') as ProviderInstanceId | null),
      model: retrySelection?.model ?? readString(payload, 'toModel'),
      retrySelection,
      reasonCode: readString(payload, 'reasonCode'),
      detail: readString(payload, 'detail'),
    }
  }

  return latest
}

export type ThreadProviderSwitchNotice =
  | {
      readonly kind: 'switching'
      readonly label: string
      readonly detail: string
    }
  | {
      readonly kind: 'completed'
      readonly outcomeId: string
      readonly label: string
    }
  | {
      readonly kind: 'failed'
      readonly outcomeId: string
      readonly label: string
      readonly detail: string | null
      readonly retrySelection: ModelSelection | null
    }

export type ProviderInstanceDisplayNameResolver = (instanceId: ProviderInstanceId) => string | null

// the composer's single provider-switch surface.
//
// an in-flight switch always wins over a past outcome: the outcome that
// preceded a fresh request is history the moment the next handoff starts.
// a dismissed outcome stays dismissed so a completion banner does not
// reappear on every re-render or receipt replay of the same activity.
export function resolveThreadProviderSwitchNotice(input: {
  readonly providerSwitch: OrchestrationProviderSwitch | null
  readonly latestOutcome: ProviderSwitchOutcome | null
  readonly dismissedOutcomeId: string | null
  readonly resolveInstanceDisplayName: ProviderInstanceDisplayNameResolver
}): ThreadProviderSwitchNotice | null
{
  if (input.providerSwitch !== null)
  {
    const targetLabel = formatProviderSwitchTargetLabel({
      instanceId: input.providerSwitch.targetInstanceId,
      displayName: input.resolveInstanceDisplayName(input.providerSwitch.targetInstanceId),
      model: input.providerSwitch.targetModel,
    })
    return {
      kind: 'switching',
      label: resolveProviderSwitchPillLabel({
        phase: input.providerSwitch.phase,
        targetLabel,
      }),
      detail: PROVIDER_SWITCH_UNCANCELABLE_NOTICE,
    }
  }

  const outcome = input.latestOutcome
  if (outcome === null || outcome.id === input.dismissedOutcomeId)
  {
    return null
  }

  const targetLabel =
    outcome.instanceId === null
      ? null
      : formatProviderSwitchTargetLabel({
          instanceId: outcome.instanceId,
          displayName: input.resolveInstanceDisplayName(outcome.instanceId),
          model: outcome.model,
        })

  if (outcome.status === 'completed')
  {
    return {
      kind: 'completed',
      outcomeId: outcome.id,
      label: targetLabel === null ? 'Provider switched' : `Switched to ${targetLabel}`,
    }
  }

  return {
    kind: 'failed',
    outcomeId: outcome.id,
    label:
      targetLabel === null
        ? `Provider switch failed — ${describeProviderSwitchFailureReason(outcome.reasonCode)}`
        : `Switch to ${targetLabel} failed — ${describeProviderSwitchFailureReason(outcome.reasonCode)}`,
    detail: outcome.detail,
    retrySelection: outcome.retrySelection,
  }
}

// a thread that has taken a turn (or holds a session) is bound to its provider;
// only those threads need the handoff. A never-started thread just re-targets.
export function threadProviderSwitchRequired(input: {
  readonly threadStarted: boolean
  readonly currentInstanceId: ProviderInstanceId
  readonly nextInstanceId: ProviderInstanceId
}): boolean
{
  return input.threadStarted && input.currentInstanceId !== input.nextInstanceId
}

export const PROVIDER_SWITCH_BLOCKED_TITLE = 'Could not switch providers'

export function providerSwitchConfirmationCopy(targetLabel: string): {
  readonly title: string
  readonly message: string
  readonly confirmLabel: string
}
{
  return {
    title: `Switch to ${targetLabel}?`,
    message: `This thread is summarized and handed off to ${targetLabel}. ${PROVIDER_SWITCH_UNCANCELABLE_NOTICE} Your draft and queued messages are kept.`,
    confirmLabel: 'Switch',
  }
}

// during a switch the session can read as running (the outgoing provider is
// compacting) or be temporarily null. Neither is a turn the user can stop, so
// the stop affordance is suppressed for the whole switch.
export function providerSwitchSuppressesStop(input: {
  readonly sessionStatus: string | null | undefined
  readonly providerSwitchActive: boolean
}): boolean
{
  if (input.providerSwitchActive)
  {
    return true
  }
  return input.sessionStatus !== 'running' && input.sessionStatus !== 'starting'
}
