// packages/client-runtime/src/state/threads/threadSettled.ts
// manage change request state like state

import type { OrchestrationThreadShell } from '@t3tools/contracts'
import { classifyApprovalFailure } from '@t3tools/shared/approvalOutcomeClassifier'
import { isThreadAwarenessStale } from '@t3tools/shared/agentAwareness'

export type ChangeRequestStateLike = 'open' | 'closed' | 'merged'

export interface ChangeRequestSettleSource
{
  readonly state: ChangeRequestStateLike
  readonly updatedAt?: string | null | undefined
}

// closed change requests always settle; merged ones honor the user preference.
export function changeRequestAutoSettles(
  changeRequest: ChangeRequestSettleSource | null | undefined,
  options: {
    readonly autoSettleOnMerge?: boolean | undefined
  } = {},
): boolean
{
  if (changeRequest == null) return false
  return (
    changeRequest.state === 'closed' ||
    (changeRequest.state === 'merged' && options.autoSettleOnMerge !== false)
  )
}

const DAY_MS = 24 * 60 * 60 * 1_000

export function hasBlockingApprovalOutcome(
  shell: Pick<OrchestrationThreadShell, 'approvalOutcomes'>,
): boolean
{
  return Boolean(
    shell.approvalOutcomes?.some(
      (outcome) => !classifyApprovalFailure({ approvalOutcome: outcome }).clearsBlockingRequest,
    ),
  )
}

export function threadLastActivityAt(shell: OrchestrationThreadShell): string | null
{
  const candidates = [
    shell.latestUserMessageAt,
    shell.latestTurn?.requestedAt,
    shell.latestTurn?.startedAt,
    shell.latestTurn?.completedAt,
  ]
  let latest: string | null = null
  let latestTimestamp = Number.NEGATIVE_INFINITY

  for (const candidate of candidates)
  {
    if (candidate === null || candidate === undefined) continue
    const timestamp = Date.parse(candidate)
    if (timestamp > latestTimestamp)
    {
      latest = candidate
      latestTimestamp = timestamp
    }
  }

  return latest
}

// a queued turn start lives for at most this long: session adoption takes
// seconds, so a user message still unadopted after the grace window is a
// failed start (or stale data — shells from older servers can carry user
// messages with no latestTurn at all), not pending work. Without this bound
// such threads would be permanently unsettleable.
export const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000

// a user message no turn has picked up yet: the turn.start command was
// dispatched (message-sent + turn-start-requested) but no session has
// adopted it, so `session` is still null and the pending work is invisible
// to the session-status checks. Detectable as a user message strictly newer
// than every timestamp on the latest turn — on adoption the new turn's
// requestedAt equals the message time, clearing the condition — and only
// within the adoption grace window.
export function hasQueuedTurnStart(
  shell: Pick<OrchestrationThreadShell, 'latestUserMessageAt' | 'latestTurn' | 'session'>,
  options: { readonly now: string },
): boolean
{
  if (shell.latestUserMessageAt == null) return false
  // a failed session start clears the queued state: the failure is already
  // visible (status edge / error).
  if (shell.session?.status === 'error') return false
  const messageAt = Date.parse(shell.latestUserMessageAt)
  if (Number.isNaN(messageAt)) return false
  const nowMs = Date.parse(options.now)
  if (Number.isNaN(nowMs)) return false
  // bounded on both sides: message timestamps originate on whichever device
  // sent the message, so a clock ahead of this one yields a negative age
  // that would otherwise hold the queued state for the whole skew. Mirrors
  // the decider's guard.
  if (Math.abs(nowMs - messageAt) > QUEUED_TURN_START_GRACE_MS) return false
  const turn = shell.latestTurn
  if (turn === null) return true
  return [turn.requestedAt, turn.startedAt, turn.completedAt].every(
    (candidate) => candidate == null || Date.parse(candidate) < messageAt,
  )
}

// a thread may be settled only when none of effectiveSettled's activity
// blockers hold. This is deliberately the same list: anything the partition
// refuses to CLASSIFY as settled must also be refused as a settle TARGET.
// the server enforces its own invariants; this client-side twin exists so
// the UI can disable/reject before a round trip.
export function canSettle(
  shell: Pick<
    OrchestrationThreadShell,
    | 'approvalOutcomes'
    | 'hasPendingApprovals'
    | 'hasPendingUserInput'
    | 'session'
    | 'latestUserMessageAt'
    | 'latestTurn'
  >,
  options: { readonly now: string },
): boolean
{
  if (shell.hasPendingApprovals || hasBlockingApprovalOutcome(shell) || shell.hasPendingUserInput)
  {
    return false
  }
  if (shell.session?.status === 'starting' || shell.session?.status === 'running') return false
  // queued work is as blocked-on-progress as a live session: settling it
  // (or auto-settling it on a closed PR) would hide a just-requested turn.
  if (hasQueuedTurnStart(shell, options)) return false
  return true
}

// the snooze lifecycle fields plus everything needed to detect a raised
// hand. Snooze is an overlay on the active state: a snoozed thread stays
// "active" in the data model and is only suppressed from the inbox until
// its wake time passes or the thread demands attention.
export type ThreadSnoozeShell = Pick<
  OrchestrationThreadShell,
  | 'snoozedUntil'
  | 'snoozedAt'
  | 'approvalOutcomes'
  | 'hasPendingApprovals'
  | 'hasPendingUserInput'
  | 'session'
  | 'latestTurn'
>

// a snoozed thread "raises its hand" when something happens that outranks
// the user's snooze: the agent is blocked on them (approval / user input),
// the session failed, or a run completed after the snooze was set — the
// v1 taste of event-based snooze ("something happened" wakes early).
// raising a hand never clears the server-side snooze fields; it only stops
// the thread from CLASSIFYING as snoozed, exactly like blocked work and
// effectiveSettled.
export function threadRaisedHandWhileSnoozed(shell: ThreadSnoozeShell): boolean
{
  if (shell.hasPendingApprovals || hasBlockingApprovalOutcome(shell) || shell.hasPendingUserInput)
  {
    return true
  }
  // only a FRESH failure raises the hand: a thread snoozed while already
  // failed stays snoozed — that snooze was the user saying "I saw it, not
  // now". session.updatedAt stamps the status edge, so an error newer than
  // the snooze is new information.
  if (
    shell.session?.status === 'error' &&
    (shell.snoozedAt == null || Date.parse(shell.session.updatedAt) > Date.parse(shell.snoozedAt))
  )
  {
    return true
  }
  if (
    shell.snoozedAt != null &&
    shell.latestTurn?.state === 'completed' &&
    shell.latestTurn.completedAt != null &&
    Date.parse(shell.latestTurn.completedAt) > Date.parse(shell.snoozedAt)
  )
  {
    return true
  }
  return false
}

// why a thread wants the user's eyes right now, ordered by urgency:
// blocked-on-user outranks a dead run, which outranks a clean finish.
// 'stale' sits between failed and completed: the run never reported an error,
// it just stopped saying anything, which is the failure mode that stayed
// invisible for 3.5 hours precisely because nothing declared it.
export type ThreadAttentionKind =
  'needs-approval' | 'needs-input' | 'failed' | 'stale' | 'completed'

// the single attention classifier every surface reads (desktop notification,
// dock badge). It exists as one function because the post-mortem's 3.5-hour
// dead thread was invisible everywhere at once: with per-surface rules a
// thread can be "done" to the tray, "running" to the badge and silent to the
// notifier, and nothing tells the user the run died.
//
// an 'interrupted' turn is deliberately NOT attention-worthy: the user
// cancelled it themselves, so they already know.
//
// the clock is optional: this module cannot read one (the repo's
// effect(globalDate) rule bans it here), and a caller with no ticking value
// classifies exactly as it did before staleness existed.
export function resolveThreadAttention(
  shell: Pick<
    OrchestrationThreadShell,
    | 'approvalOutcomes'
    | 'hasPendingApprovals'
    | 'hasPendingUserInput'
    | 'session'
    | 'latestTurn'
    | 'updatedAt'
  >,
  options?: { readonly nowMs?: number | undefined },
): ThreadAttentionKind | null
{
  if (shell.hasPendingApprovals || hasBlockingApprovalOutcome(shell)) return 'needs-approval'
  if (shell.hasPendingUserInput) return 'needs-input'
  // a session error is the failure mode that cost the post-mortem its 3.5
  // hours: the run is dead and nothing else in the shell says so.
  if (shell.session?.status === 'error' || shell.latestTurn?.state === 'error') return 'failed'
  // the quieter twin of that failure: no error was ever reported, the run just
  // stopped. It only applies to a run that actually started -- 'starting' has
  // produced nothing yet, so there is no silence to measure.
  if (
    options?.nowMs !== undefined &&
    (shell.session?.status === 'running' || shell.latestTurn?.state === 'running') &&
    isThreadAwarenessStale(shell, options.nowMs)
  )
  {
    return 'stale'
  }
  if (shell.latestTurn?.state === 'completed' && shell.latestTurn.completedAt !== null)
  {
    return 'completed'
  }
  return null
}

// whether an attention kind still needs the user to DO something. A completed
// turn never clears on its own, so a badge that counted it would only ever
// grow and would stop meaning anything; the blocked, failed and stale kinds
// clear when the user acts, so they are the only ones worth a persistent
// count. Stale clears either way -- the run resumes and the stamp moves, or
// the user opens the thread and kills it.
export function threadAttentionNeedsAction(kind: ThreadAttentionKind): boolean
{
  return kind !== 'completed'
}

// a thread may be snoozed unless the agent is blocked on the user: hiding a
// pending approval or user-input request defeats the request, and a queued
// turn start (a message no turn has adopted yet) is invisible pending work
// the same way it is for settle. A running session IS snoozable — snooze
// only affects visibility, never the agent. Client-side twin of the server
// invariants so the UI can reject before a round trip.
export function canSnooze(
  shell: Pick<
    OrchestrationThreadShell,
    | 'approvalOutcomes'
    | 'hasPendingApprovals'
    | 'hasPendingUserInput'
    | 'latestUserMessageAt'
    | 'latestTurn'
    | 'session'
  >,
  options: { readonly now: string },
): boolean
{
  if (shell.hasPendingApprovals || hasBlockingApprovalOutcome(shell) || shell.hasPendingUserInput)
  {
    return false
  }
  if (hasQueuedTurnStart(shell, options)) return false
  return true
}

// snoozed resolution: hidden from the inbox while the wake time is in the
// future and the thread has not raised its hand. Timer wakes are derived —
// no server event fires when snoozedUntil passes; the stale fields simply
// stop classifying as snoozed (and feed the woke indicator until the user
// visits or re-engages).
export function effectiveSnoozed(
  shell: ThreadSnoozeShell,
  options: { readonly now: string },
): boolean
{
  if (shell.snoozedUntil == null) return false
  const wakeAtMs = Date.parse(shell.snoozedUntil)
  // malformed data never hides a thread.
  if (Number.isNaN(wakeAtMs)) return false
  if (wakeAtMs <= Date.parse(options.now)) return false
  return !threadRaisedHandWhileSnoozed(shell)
}

// when a previously-snoozed thread woke, or null if it never snoozed / is
// still snoozed. Used for the "Woke" indicator: the thread reappears in its
// original sort position (the inbox sort is deliberately static), so the
// wake signal has to carry the weight. Compare against the client's
// lastVisitedAt — visiting clears the indicator like it clears unread.
//
// timer wakes report the wake time itself; raised-hand wakes report the
// triggering timestamp so a visit BEFORE the early wake doesn't suppress
// the indicator.
export function threadWokeAt(
  shell: ThreadSnoozeShell,
  options: { readonly now: string },
): string | null
{
  if (shell.snoozedUntil == null) return null
  const wakeAtMs = Date.parse(shell.snoozedUntil)
  if (Number.isNaN(wakeAtMs)) return null
  // an early hand-raise wake stays authoritative even after the scheduled
  // wake time passes: reporting snoozedUntil then would resurface a Woke
  // indicator the user already cleared by visiting (snoozedUntil is newer
  // than that visit's lastVisitedAt).
  if (threadRaisedHandWhileSnoozed(shell))
  {
    if (
      shell.snoozedAt != null &&
      shell.latestTurn?.state === 'completed' &&
      shell.latestTurn.completedAt != null &&
      Date.parse(shell.latestTurn.completedAt) > Date.parse(shell.snoozedAt)
    )
    {
      return shell.latestTurn.completedAt
    }
    return shell.session?.updatedAt ?? shell.snoozedAt ?? null
  }
  // no raised hand: woke iff the timer elapsed (still-snoozed -> null).
  return wakeAtMs <= Date.parse(options.now) ? shell.snoozedUntil : null
}

// an eligible terminal change request settles its thread only once the thread
// has been idle this long. Without the idle guard the terminal signal persists:
// sending a message to a merged-PR thread would un-settle the row only until
// its turn completed, then the still-merged PR would snap it straight back
// into the settled tail. An hour keeps the follow-up conversation visible
// while it is warm; once the burst goes stale the merge signal settles it
// again. Activity timestamps can originate on another device while `now` is
// this caller's clock: skew shortens or stretches the window by its size,
// the same exposure the inactivity auto-settle already accepts — worst case
// is a row changing lists early or late, never lost work.
export const CHANGE_REQUEST_SETTLE_IDLE_MS = 60 * 60 * 1_000

// settled resolution over the server-backed settled lifecycle. Activity
// blockers (pending approval/user-input, a live session, an unadjudicated
// queued turn) are checked first and hold a thread active regardless of any
// override. Past the blockers, the explicit user override (thread.settle /
// thread.unsettle commands, projected into settledOverride + settledAt)
// wins in both directions; without one, a thread auto-settles on a closed PR,
// an enabled merged-PR signal (both once idle), or inactivity past the window.
// the server un-settles on real activity (user message, session start, approval/
// user-input request), so an override never goes stale silently.
export function effectiveSettled(
  shell: OrchestrationThreadShell,
  options: {
    readonly now: string
    readonly autoSettleAfterDays: number | null
    readonly autoSettleOnMerge?: boolean
    readonly changeRequest?: ChangeRequestSettleSource | null
    readonly changeRequestState?: ChangeRequestStateLike | null
  },
): boolean
{
  // blocked work must remain visible even when a user explicitly settled it.
  if (shell.hasPendingApprovals || hasBlockingApprovalOutcome(shell) || shell.hasPendingUserInput)
  {
    return false
  }
  if (shell.session?.status === 'starting' || shell.session?.status === 'running') return false
  if (hasQueuedTurnStart(shell, { now: options.now }))
  {
    // the queued-turn blocker alone is forgivable: it is clock-derived, and
    // list callers pass a coarser `now` than the settle action used. When
    // the server already adjudicated the queued message by accepting a
    // settle after it (settledAt stamps server accept time), trust that
    // ruling — otherwise a settle near the grace boundary leaves the row
    // pinned active until the caller's clock ticks over. A message NEWER
    // than settledAt is genuinely new work and keeps the block until the
    // server's auto-unsettle lands.
    const serverAdjudicated =
      shell.settledOverride === 'settled' &&
      shell.settledAt !== null &&
      shell.latestUserMessageAt !== null &&
      Date.parse(shell.settledAt) >= Date.parse(shell.latestUserMessageAt)
    if (!serverAdjudicated) return false
  }
  if (shell.settledOverride === 'settled') return true
  // "active" is the explicit keep-active pin: it suppresses auto-settle
  // until real activity clears it server-side.
  if (shell.settledOverride === 'active') return false
  const changeRequest =
    options.changeRequest ??
    (options.changeRequestState == null ? null : { state: options.changeRequestState })
  if (
    changeRequestAutoSettles(changeRequest, {
      autoSettleOnMerge: options.autoSettleOnMerge,
    })
  )
  {
    // only an idle thread settles on the merge signal: the signal itself
    // never clears, so without this guard fresh activity (a message sent in
    // a settled thread) would re-settle the moment its turn completed.
    const lastActivityAt = threadLastActivityAt(shell)
    if (
      lastActivityAt === null ||
      Date.parse(lastActivityAt) < Date.parse(options.now) - CHANGE_REQUEST_SETTLE_IDLE_MS
    )
    {
      return true
    }
  }
  if (changeRequest?.state === 'open') return false
  if (options.autoSettleAfterDays === null) return false

  const lastActivityAt = threadLastActivityAt(shell)
  if (lastActivityAt === null) return false

  // threadLastActivityAt only returns candidates whose Date.parse beat
  // -Infinity, so this parse is a real number; a malformed `now` yields NaN,
  // the comparison is false, and the thread stays active (never a surprise
  // auto-settle on bad input).
  return Date.parse(lastActivityAt) < Date.parse(options.now) - options.autoSettleAfterDays * DAY_MS
}
