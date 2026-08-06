// apps/web/src/components/chat/composerContextWindow.ts
// picks the context-window snapshot that belongs to the thread's current provider

import type { OrchestrationThreadActivity, ProviderInstanceId } from '@t3tools/contracts'

import {
  buildContextWindowSnapshot,
  readContextWindowProviderInstanceId,
  type ContextWindowSnapshot,
} from '../../lib/contextWindow'
import { PROVIDER_SWITCH_COMPLETED_ACTIVITY_KIND } from '../../providerSwitchPresentation'

// what the composer meter may render for the thread's current provider:
//   current           - recorded by the provider the meter is labelled with,
//                       so its numbers can be shown as-is
//   previous-provider - an untagged snapshot the thread has since switched
//                       away from; shown only behind a qualifier
//   unavailable       - every recorded snapshot belongs to another instance or
//                       to a session the thread has switched out of, so there
//                       is nothing honest to show yet
//   none              - no usable context-window activity on the thread
export type ThreadContextWindowSelection =
  | { readonly state: 'current'; readonly snapshot: ContextWindowSnapshot }
  | { readonly state: 'previous-provider'; readonly snapshot: ContextWindowSnapshot }
  | { readonly state: 'unavailable' }
  | { readonly state: 'none' }

// a cross-provider switch leaves the old provider's `context-window.updated`
// activities in the thread log, so "latest wins" hands the meter the wrong
// identity's numbers under the new provider's label.
//
// * the newest completed switch is the epoch boundary: every session before it
//   has been torn down, so no snapshot recorded earlier describes the context
//   the thread is now running in — including snapshots tagged for the instance
//   the thread has switched back to (A -> B -> A).
function latestCompletedProviderSwitchIndex(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): number
{
  for (let index = activities.length - 1; index >= 0; index -= 1)
  {
    if (activities[index]?.kind === PROVIDER_SWITCH_COMPLETED_ACTIVITY_KIND)
    {
      return index
    }
  }
  return -1
}

// resolve which snapshot, if any, the composer may attribute to
// `currentProviderInstanceId`.
//
// tagged snapshots decide on their own, but only within the current switch
// epoch: the newest one matching the current instance and recorded after the
// last completed switch wins. Untagged (legacy) snapshots carry no identity, so
// they only count while the thread shows no sign of having moved instance —
// neither a completed switch after they were recorded nor any activity tagged
// for an instance the thread is no longer on. a newest snapshot that is tagged
// but out of epoch yields nothing rather than a wrong-session number.
export function selectThreadContextWindowSnapshot(input: {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>
  readonly currentProviderInstanceId: ProviderInstanceId | null
}): ThreadContextWindowSelection
{
  const { activities, currentProviderInstanceId } = input
  const switchEpochIndex = latestCompletedProviderSwitchIndex(activities)
  let latest: {
    readonly snapshot: ContextWindowSnapshot
    readonly index: number
    readonly instanceId: string | null
  } | null = null
  // a switch that predates the switch-outcome activities (or whose outcome was
  // never written) leaves no divider to find, but any activity tagged for an
  // instance the thread is no longer on still proves it moved
  let observedForeignInstance = false

  for (let index = activities.length - 1; index >= 0; index -= 1)
  {
    const activity = activities[index]
    if (!activity)
    {
      continue
    }
    const instanceId = readContextWindowProviderInstanceId(activity)
    if (
      instanceId !== null &&
      currentProviderInstanceId !== null &&
      instanceId !== currentProviderInstanceId
    )
    {
      observedForeignInstance = true
    }
    const snapshot = buildContextWindowSnapshot(activity)
    if (snapshot === null)
    {
      continue
    }
    if (
      index > switchEpochIndex &&
      currentProviderInstanceId !== null &&
      instanceId === currentProviderInstanceId
    )
    {
      return { state: 'current', snapshot }
    }
    latest ??= { snapshot, index, instanceId }
  }

  if (latest === null)
  {
    return { state: 'none' }
  }
  // without a resolved current instance there is no identity to compare
  // against, so keep the pre-tagging behavior instead of blanking the meter.
  if (currentProviderInstanceId === null)
  {
    return { state: 'current', snapshot: latest.snapshot }
  }
  // a tagged snapshot that reached here is either another instance's or the
  // current instance's from a torn-down session; neither is honest to show
  if (latest.instanceId !== null)
  {
    return { state: 'unavailable' }
  }
  return observedForeignInstance || latest.index < switchEpochIndex
    ? { state: 'previous-provider', snapshot: latest.snapshot }
    : { state: 'current', snapshot: latest.snapshot }
}
