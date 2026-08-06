// apps/web/src/provider/switchPresentation.ts
// derives provider switch pill, failure, and timeline presentation state

import {
  describeProviderSwitchFailureReason,
  formatProviderSwitchTargetLabel,
  PROVIDER_SWITCH_COMPLETED_ACTIVITY_KIND,
  PROVIDER_SWITCH_FAILED_ACTIVITY_KIND,
  readPayload,
  readString,
  type ProviderSwitchPhase,
} from '@t3tools/client-runtime/provider-switch'
import {
  type OrchestrationThreadActivity,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type TurnId,
} from '@t3tools/contracts'
import { compareOrchestrationThreadActivities } from '@t3tools/shared/orchestrationActivityOrder'

export {
  describeProviderSwitchFailureReason,
  formatProviderSwitchTargetLabel,
  PROVIDER_SWITCH_COMPLETED_ACTIVITY_KIND,
  PROVIDER_SWITCH_FAILED_ACTIVITY_KIND,
  type ProviderSwitchPhase,
}

// send stays blocked for the whole switch; the draft is untouched so the same
// message can go out against the new provider once the handoff lands.
export const PROVIDER_SWITCH_SEND_BLOCKED_NOTICE =
  'Provider switch in progress — your message can be sent when it finishes'

// the composer notice sits next to a disabled picker, so naming the target is
// the only thing that says which provider the blocked draft is waiting on.
export function formatProviderSwitchSendBlockedNotice(targetLabel?: string | null): string
{
  const target = targetLabel?.trim()
  return target
    ? `Switching to ${target} — your message can be sent when it finishes`
    : PROVIDER_SWITCH_SEND_BLOCKED_NOTICE
}

// composer-facing slice of an in-flight switch. `hidesRunningTurn` marks the
// window where the session reads as running only because the old provider is
// compacting: there is no turn to stop, so the stop affordance must not show.
export interface ComposerProviderSwitchState
{
  readonly notice: string
  readonly hidesRunningTurn: boolean
}

// the target is named whenever the outcome carries (or the client still knows)
// one, so a failure divider says which handoff failed rather than just that one did.
export function formatProviderSwitchFailureLabel(
  reasonCode: string | null | undefined,
  targetLabel?: string | null,
): string
{
  const target = targetLabel?.trim()
  const subject = target ? `Provider switch to ${target} failed` : 'Provider switch failed'
  return `${subject} — ${describeProviderSwitchFailureReason(reasonCode)}`
}

export function formatProviderSwitchFailureToastDescription(input: {
  readonly reasonCode: string | null | undefined
  readonly targetLabel?: string | null
}): string
{
  const target = input.targetLabel?.trim()
  const subject = target ? `The switch to ${target}` : 'The switch'
  return `${subject} stopped because ${describeProviderSwitchFailureReason(input.reasonCode)}.`
}

// phase-specific pill copy. `targetLabel` names the configured instance and its
// model. Every phase names the target: the pill doubles as the switch's
// accessible label, and a phase that drops target identity leaves screen
// readers with an unattributed status.
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
      return `Summarizing conversation for handoff to ${input.targetLabel}… (can take a couple of minutes)`
    case 'finalizing':
      return `Finishing switch to ${input.targetLabel}…`
  }
}

// the confirmation is the last point where the switch can be abandoned, so it
// names the exact instance and model it is about to hand off to and keeps the
// operation's cost — summary, fresh session, no cancel — in the same breath.
export function describeProviderSwitchConfirmation(input: { readonly targetLabel: string }): {
  readonly title: string
  readonly description: string
}
{
  return {
    title: `Switch to ${input.targetLabel}?`,
    description:
      'The current provider writes a brief summary of this thread, then its session ends and ' +
      `${input.targetLabel} starts fresh from that summary. It can take up to about 2 minutes and ` +
      "can't be cancelled once it starts. Tool state and pending approvals do not carry over.",
  }
}

export type ProviderSwitchTimelineStatus = 'completed' | 'failed'

export interface ProviderSwitchTimelineParty
{
  readonly driverKind: ProviderDriverKind | null
  readonly displayName: string
  readonly modelLabel: string | null
}

// one side of a completed switch, named the same way the pill names a target:
// instance first, model qualifying it. A model-only label cannot separate two
// configured instances running the same model.
export function formatProviderSwitchPartyLabel(party: ProviderSwitchTimelineParty): string
{
  const model = party.modelLabel?.trim()
  return model && model.length > 0 && model !== party.displayName
    ? `${party.displayName} · ${model}`
    : party.displayName
}

// selection an outcome points at. Durable on the activity payload, so a retry
// no longer depends on the client still holding the in-flight target in memory.
export interface ProviderSwitchRetryTarget
{
  readonly instanceId: ProviderInstanceId
  readonly model: string | null
}

export interface ProviderSwitchTimelineEvent
{
  readonly id: string
  readonly createdAt: string
  readonly turnId: TurnId | null
  readonly status: ProviderSwitchTimelineStatus
  readonly label: string
  readonly from: ProviderSwitchTimelineParty | null
  readonly to: ProviderSwitchTimelineParty | null
  readonly detail: string | null
  readonly reasonCode: string | null
  readonly target: ProviderSwitchRetryTarget | null
  readonly targetLabel: string | null
}

// resolves a provider instance id to the identity needed for the timeline
// icons; returns null when the instance is no longer configured.
export type ProviderSwitchInstanceResolver = (
  instanceId: string,
) => { readonly driverKind: ProviderDriverKind; readonly displayName: string } | null

// durable target selection off an outcome payload. `targetInstanceId` is the
// switch-shaped key; `toInstanceId` is the completed-outcome key, and reading
// both keeps one derivation for either outcome kind.
function readTarget(payload: Record<string, unknown> | null): ProviderSwitchRetryTarget | null
{
  const instanceId = readString(payload, 'targetInstanceId') ?? readString(payload, 'toInstanceId')
  if (instanceId === null)
  {
    return null
  }
  return {
    instanceId: instanceId as ProviderInstanceId,
    model: readString(payload, 'targetModel') ?? readString(payload, 'toModel'),
  }
}

// same identity as the in-flight pill: configured instance name plus model, so
// an outcome and the pill that preceded it name the same target the same way.
function resolveTargetLabel(
  target: ProviderSwitchRetryTarget | null,
  resolveInstance: ProviderSwitchInstanceResolver,
): string | null
{
  if (target === null)
  {
    return null
  }
  return formatProviderSwitchTargetLabel({
    instanceId: target.instanceId,
    displayName: resolveInstance(target.instanceId)?.displayName,
    model: target.model,
  })
}

function toParty(
  instanceId: string | null,
  modelLabel: string | null,
  resolveInstance: ProviderSwitchInstanceResolver,
): ProviderSwitchTimelineParty | null
{
  const resolved = instanceId ? resolveInstance(instanceId) : null
  const displayName = resolved?.displayName ?? modelLabel ?? instanceId
  if (!displayName)
  {
    return null
  }
  return {
    driverKind: resolved?.driverKind ?? null,
    displayName,
    modelLabel,
  }
}

// pull the switch outcome activities out of the thread's activity log. These
// render as timeline dividers instead of work-log rows, so the work log skips
// the same two kinds.
export function deriveProviderSwitchTimelineEvents(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  resolveInstance: ProviderSwitchInstanceResolver,
): ProviderSwitchTimelineEvent[]
{
  const ordered = [...activities].toSorted(compareOrchestrationThreadActivities)
  const events: ProviderSwitchTimelineEvent[] = []

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

    if (activity.kind === PROVIDER_SWITCH_FAILED_ACTIVITY_KIND)
    {
      // reason code and target are only present once the server plumbs them
      // onto the activity; without them the copy falls back to a generic
      // reason and the retry falls back to the client's in-flight target
      const reasonCode = readString(payload, 'reasonCode')
      const detail = readString(payload, 'detail')
      const target = readTarget(payload)
      const targetLabel = resolveTargetLabel(target, resolveInstance)
      events.push({
        id: activity.id,
        createdAt: activity.createdAt,
        turnId: activity.turnId,
        status: 'failed',
        label: formatProviderSwitchFailureLabel(reasonCode, targetLabel),
        from: null,
        to: null,
        detail,
        reasonCode,
        target,
        targetLabel,
      })
      continue
    }

    const fromModel = readString(payload, 'fromModel')
    const toModel = readString(payload, 'toModel')
    const from = toParty(readString(payload, 'fromInstanceId'), fromModel, resolveInstance)
    const to = toParty(readString(payload, 'toInstanceId'), toModel, resolveInstance)
    const target = readTarget(payload)
    events.push({
      id: activity.id,
      createdAt: activity.createdAt,
      turnId: activity.turnId,
      status: 'completed',
      // both parties are named by instance and model; the server summary is
      // only a fallback for an outcome that resolved neither side
      label:
        from && to
          ? `Switched from ${formatProviderSwitchPartyLabel(from)} to ${formatProviderSwitchPartyLabel(to)}`
          : activity.summary,
      from,
      to,
      detail: null,
      reasonCode: null,
      target,
      targetLabel: resolveTargetLabel(target, resolveInstance),
    })
  }

  return events
}

// the server records this once a provider session has accepted a turn carrying
// the handoff summary. It is the only durable delivery evidence the client has.
export const PROVIDER_HANDOFF_DELIVERED_ACTIVITY_KIND = 'provider.handoff.delivered'

// what the thread can prove about the summary the switch left behind:
//   queued    - nothing has been sent since the handoff, so the next message
//               carries it
//   delivered - a provider session accepted it; it is not resent, and the
//               marker says delivered, never that the provider used it
//   unknown   - a message went out after the handoff without recording a
//               delivery, so neither delivery nor a resend can be promised
export type ProviderHandoffDeliveryState = 'queued' | 'delivered' | 'unknown'

export interface PendingHandoffPresentation
{
  readonly delivery: ProviderHandoffDeliveryState
  readonly label: string
}

// resolve the pending-handoff pill from durable evidence only.
//
// a delivery marker is written after the provider accepts the turn, and only
// when the reactor had a session to key it to — so its absence after a send is
// genuinely unknown rather than proof the summary is still waiting.
export function resolvePendingHandoffPresentation(input: {
  readonly handoff: { readonly createdAt: string } | null | undefined
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>
  readonly sentSinceHandoff: boolean
  readonly targetLabel?: string | null
}): PendingHandoffPresentation | null
{
  const handoff = input.handoff
  if (!handoff)
  {
    return null
  }
  const target = input.targetLabel?.trim()
  const provider = target && target.length > 0 ? target : 'the new provider'
  const delivered = input.activities.some(
    (activity) =>
      activity.kind === PROVIDER_HANDOFF_DELIVERED_ACTIVITY_KIND &&
      activity.createdAt >= handoff.createdAt,
  )
  if (delivered)
  {
    return {
      delivery: 'delivered',
      label: `Handoff summary delivered to ${provider} — it stays attached until a turn completes`,
    }
  }
  if (input.sentSinceHandoff)
  {
    return {
      delivery: 'unknown',
      label: `Handoff summary delivery to ${provider} is unconfirmed — it may be sent again with your next message`,
    }
  }
  return {
    delivery: 'queued',
    label: 'Handoff summary pending — it will be included with your next message',
  }
}

// per-thread record of which switch outcomes have already been announced.
export interface ProviderSwitchAnnouncementState
{
  readonly threadKey: string
  readonly announcedIds: ReadonlySet<string>
}

export interface ProviderSwitchAnnouncementDecision
{
  readonly state: ProviderSwitchAnnouncementState | null
  readonly announce: ReadonlyArray<ProviderSwitchTimelineEvent>
}

// decide which switch outcomes are genuinely new for the thread on screen.
//
// * seeding only happens on a synchronized snapshot: a cached or syncing detail
//   can still be missing history, and seeding from it lets the catch-up delivery
//   replay old outcomes as fresh toasts.
// * the record is scoped to one thread. Leaving a thread drops it, so reopening
//   re-seeds from history instead of announcing everything that landed while the
//   thread was off screen.
export function reconcileProviderSwitchAnnouncements(input: {
  readonly events: ReadonlyArray<ProviderSwitchTimelineEvent>
  readonly state: ProviderSwitchAnnouncementState | null
  readonly synchronized: boolean
  readonly threadKey: string
}): ProviderSwitchAnnouncementDecision
{
  const current = input.state?.threadKey === input.threadKey ? input.state : null
  if (!input.synchronized)
  {
    return { state: current, announce: [] }
  }
  if (current === null)
  {
    return {
      state: {
        threadKey: input.threadKey,
        announcedIds: new Set(input.events.map((event) => event.id)),
      },
      announce: [],
    }
  }

  const announce = input.events.filter((event) => !current.announcedIds.has(event.id))
  if (announce.length === 0)
  {
    return { state: current, announce: [] }
  }
  const announcedIds = new Set(current.announcedIds)
  for (const event of announce)
  {
    announcedIds.add(event.id)
  }
  return { state: { threadKey: input.threadKey, announcedIds }, announce }
}

// prefer the outcome's durable target; the in-memory in-flight target is only a
// fallback for outcomes written before the server persisted one, and it is
// ignored once the user has moved to another thread.
export function resolveProviderSwitchRetryTarget(input: {
  readonly event: ProviderSwitchTimelineEvent
  readonly fallback: (ProviderSwitchRetryTarget & { readonly threadKey: string }) | null
  readonly threadKey: string
}): ProviderSwitchRetryTarget | null
{
  if (input.event.target !== null)
  {
    return input.event.target
  }
  const fallback = input.fallback
  if (fallback === null || fallback.threadKey !== input.threadKey)
  {
    return null
  }
  return { instanceId: fallback.instanceId, model: fallback.model }
}

// an outcome toast outlives the route that produced it: it is queued for one
// thread, and the retry it carries dispatches through whatever selection
// handler is current when the user clicks. Refusing the retry once the route
// has moved keeps a thread-A toast from switching thread B.
export function canApplyProviderSwitchRetry(input: {
  readonly announcedThreadKey: string
  readonly routeThreadKey: string
}): boolean
{
  return input.announcedThreadKey === input.routeThreadKey
}

// picker rows carry two very different consequences: a model on the thread's
// current instance applies immediately, another instance opens a confirmation
// and then blocks the composer for the handoff.
export type ProviderSwitchPickerIntent = 'instant' | 'handoff'

export const PROVIDER_SWITCH_PICKER_HEADING = 'Switch provider for this thread'

export const PROVIDER_SWITCH_PICKER_HINT =
  'Models on the current provider apply instantly — another provider asks you to confirm, then pauses sending for the handoff'

export function describeProviderSwitchPickerIntent(input: {
  readonly rowInstanceId: ProviderInstanceId
  readonly threadInstanceId: ProviderInstanceId | null
}): ProviderSwitchPickerIntent | null
{
  if (input.threadInstanceId === null)
  {
    return null
  }
  return input.rowInstanceId === input.threadInstanceId ? 'instant' : 'handoff'
}

export function providerSwitchPickerIntentCopy(intent: ProviderSwitchPickerIntent): {
  readonly badge: string
  readonly description: string
}
{
  return intent === 'instant'
    ? {
        badge: 'Instant',
        description: 'Same provider — this model applies to your next message right away.',
      }
    : {
        badge: 'Confirm & wait',
        description:
          'Different provider — you confirm first, then this thread is summarized and handed off before you can send again.',
      }
}
