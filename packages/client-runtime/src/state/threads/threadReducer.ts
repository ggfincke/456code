// packages/client-runtime/src/state/threads/threadReducer.ts
// applies thread events to client state

import { pipe } from 'effect/Function'
import * as Arr from 'effect/Array'
import * as O from 'effect/Order'
import type {
  MessageId,
  OrchestrationCheckpointSummary,
  OrchestrationEvent,
  OrchestrationLatestTurn,
  OrchestrationMessage,
  OrchestrationSession,
  OrchestrationThread,
  TurnId,
} from '@t3tools/contracts'
import { compareOrchestrationThreadActivities } from '@t3tools/shared/orchestrationActivityOrder'
import { isAdjacentProviderSwitchActivity } from '@t3tools/shared/providerSwitchActivity'

export type ThreadDetailReducerResult =
  | { readonly kind: 'updated'; readonly thread: OrchestrationThread }
  | { readonly kind: 'deleted' }
  | { readonly kind: 'unchanged' }

const proposedPlanOrder = O.combine<OrchestrationThread['proposedPlans'][number]>(
  O.mapInput(O.String, (p) => p.createdAt),
  O.mapInput(O.String, (p) => p.id),
)

const checkpointOrder = O.mapInput(
  O.Number,
  (cp: OrchestrationThread['checkpoints'][number]) =>
    cp.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER,
)

function upsertThreadActivity(
  activities: OrchestrationThread['activities'],
  activity: OrchestrationThread['activities'][number],
): ReadonlyArray<OrchestrationThread['activities'][number]>
{
  return pipe(
    activities,
    Arr.filter((entry) => entry.id !== activity.id),
    Arr.append(activity),
    Arr.sort(compareOrchestrationThreadActivities),
  )
}

// apply a single orchestration event to an `OrchestrationThread`, returning
// the updated thread, a deletion signal, or an "unchanged" marker when the
// event doesn't affect this thread.
//
// this is a pure reducer operating on contract types. UI-specific mapping
// (e.g. resolving attachment preview URLs, normalising model slugs, adding
// scoped fields like `environmentId`) is the caller's responsibility.
export function applyThreadDetailEvent(
  thread: OrchestrationThread,
  event: OrchestrationEvent,
): ThreadDetailReducerResult
{
  switch (event.type)
  {
    // ── Project events (irrelevant to thread detail) ────────────────
    case 'project.created':
    case 'project.meta-updated':
    case 'project.deleted':
      return { kind: 'unchanged' }

    // ── Thread lifecycle ────────────────────────────────────────────
    case 'thread.created':
      return {
        kind: 'updated',
        thread: {
          id: event.payload.threadId,
          projectId: event.payload.projectId,
          title: event.payload.title,
          modelSelection: event.payload.modelSelection,
          runtimeMode: event.payload.runtimeMode,
          interactionMode: event.payload.interactionMode,
          branch: event.payload.branch,
          worktreePath: event.payload.worktreePath,
          origin: event.payload.origin ?? null,
          latestTurn: null,
          providerSwitch: null,
          createdAt: event.payload.createdAt,
          updatedAt: event.payload.updatedAt,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          snoozedUntil: null,
          snoozedAt: null,
          deletedAt: null,
          messages: [],
          proposedPlans: [],
          orchestratePlans: [],
          activities: [],
          checkpoints: [],
          session: null,
          approvalOutcomes: [],
        },
      }

    case 'thread.deleted':
      return { kind: 'deleted' }

    case 'thread.archived':
      return {
        kind: 'updated',
        thread: {
          ...thread,
          archivedAt: event.payload.archivedAt,
          updatedAt: event.payload.updatedAt,
        },
      }

    case 'thread.unarchived':
      return {
        kind: 'updated',
        thread: { ...thread, archivedAt: null, updatedAt: event.payload.updatedAt },
      }

    case 'thread.settled':
      return {
        kind: 'updated',
        thread: {
          ...thread,
          settledOverride: 'settled',
          settledAt: event.payload.settledAt,
          updatedAt: event.payload.updatedAt,
        },
      }

    case 'thread.unsettled':
      return {
        kind: 'updated',
        thread: {
          ...thread,
          settledOverride: event.payload.reason === 'user' ? 'active' : null,
          settledAt: null,
          updatedAt: event.payload.updatedAt,
        },
      }

    case 'thread.snoozed':
      return {
        kind: 'updated',
        thread: {
          ...thread,
          snoozedUntil: event.payload.snoozedUntil,
          snoozedAt: event.payload.snoozedAt,
          updatedAt: event.payload.updatedAt,
        },
      }

    case 'thread.unsnoozed':
      return {
        kind: 'updated',
        thread: {
          ...thread,
          snoozedUntil: null,
          snoozedAt: null,
          updatedAt: event.payload.updatedAt,
        },
      }

    // ── Thread metadata ─────────────────────────────────────────────
    case 'thread.meta-updated':
      return {
        kind: 'updated',
        thread: {
          ...thread,
          ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
          ...(event.payload.modelSelection !== undefined
            ? { modelSelection: event.payload.modelSelection }
            : {}),
          ...(event.payload.branch !== undefined ? { branch: event.payload.branch } : {}),
          ...(event.payload.worktreePath !== undefined
            ? { worktreePath: event.payload.worktreePath }
            : {}),
          updatedAt: event.payload.updatedAt,
        },
      }

    case 'thread.provider-switch-requested':
      return {
        kind: 'updated',
        thread: {
          ...thread,
          providerSwitch: {
            phase: 'pending',
            targetInstanceId: event.payload.targetModelSelection.instanceId,
            targetModel: event.payload.targetModelSelection.model,
            requestedAt: event.occurredAt,
            requestId: event.eventId,
            requestSequence: event.sequence,
            sourceModelSelection: event.payload.sourceModelSelection ?? thread.modelSelection,
          },
          updatedAt: event.occurredAt,
        },
      }

    case 'thread.provider-switch-progressed':
      if (
        thread.providerSwitch === null ||
        (event.payload.requestId !== undefined &&
          thread.providerSwitch.requestId !== event.payload.requestId)
      )
      {
        return { kind: 'unchanged' }
      }
      return {
        kind: 'updated',
        thread: {
          ...thread,
          providerSwitch: {
            ...thread.providerSwitch,
            phase: event.payload.phase,
          },
          updatedAt: event.occurredAt,
        },
      }

    case 'thread.provider-switch-failed':
    {
      if (
        event.payload.requestId !== undefined &&
        thread.providerSwitch?.requestId !== event.payload.requestId
      )
      {
        return { kind: 'unchanged' }
      }
      const sourceModelSelection = event.payload.sourceModelSelection ?? thread.modelSelection
      const targetModelSelection =
        event.payload.targetModelSelection ??
        (thread.providerSwitch === null
          ? undefined
          : {
              instanceId: thread.providerSwitch.targetInstanceId,
              model: thread.providerSwitch.targetModel,
            })
      const activity: OrchestrationThread['activities'][number] = {
        id: event.eventId,
        tone: 'error',
        kind: 'provider.switch.failed',
        summary: 'Provider switch failed',
        payload: {
          reasonCode: event.payload.reasonCode,
          detail: event.payload.detail,
          fromInstanceId: sourceModelSelection.instanceId,
          fromModel: sourceModelSelection.model,
          ...(targetModelSelection === undefined
            ? {}
            : {
                toInstanceId: targetModelSelection.instanceId,
                toModel: targetModelSelection.model,
                retryTargetModelSelection: targetModelSelection,
              }),
        },
        turnId: null,
        sequence: event.sequence,
        createdAt: event.occurredAt,
      }
      const hasHistoricalActivity =
        event.payload.activityVersion === undefined &&
        thread.activities.some((entry) => isAdjacentProviderSwitchActivity(entry, activity))
      return {
        kind: 'updated',
        thread: {
          ...thread,
          providerSwitch: null,
          activities: hasHistoricalActivity
            ? thread.activities
            : upsertThreadActivity(thread.activities, activity),
          updatedAt: event.occurredAt,
        },
      }
    }

    // payload carries no threadId; the caller matched this event to the
    // thread via the event's aggregate id
    case 'thread.provider-switched':
    {
      if (
        event.payload.requestId !== undefined &&
        thread.providerSwitch?.requestId !== event.payload.requestId
      )
      {
        return { kind: 'unchanged' }
      }
      const sourceModelSelection = event.payload.sourceModelSelection ?? {
        instanceId: event.payload.fromInstanceId,
        model: event.payload.fromModel ?? null,
      }
      const activity: OrchestrationThread['activities'][number] = {
        id: event.eventId,
        tone: 'info',
        kind: 'provider.switch.completed',
        summary: `Switched from ${
          sourceModelSelection.model ?? sourceModelSelection.instanceId ?? 'prior provider'
        } to ${event.payload.modelSelection.model || event.payload.modelSelection.instanceId}`,
        payload: {
          fromInstanceId: sourceModelSelection.instanceId,
          ...(sourceModelSelection.model === null ? {} : { fromModel: sourceModelSelection.model }),
          toInstanceId: event.payload.modelSelection.instanceId,
          toModel: event.payload.modelSelection.model,
          targetModelSelection: event.payload.modelSelection,
        },
        turnId: null,
        sequence: event.sequence,
        createdAt: event.occurredAt,
      }
      const hasHistoricalActivity =
        event.payload.activityVersion === undefined &&
        thread.activities.some((entry) => isAdjacentProviderSwitchActivity(entry, activity))
      return {
        kind: 'updated',
        thread: {
          ...thread,
          modelSelection: event.payload.modelSelection,
          providerSwitch: null,
          activities: hasHistoricalActivity
            ? thread.activities
            : upsertThreadActivity(thread.activities, activity),
          pendingHandoff:
            event.payload.handoffText.trim().length > 0
              ? {
                  text: event.payload.handoffText,
                  fromInstanceId: event.payload.fromInstanceId,
                  ...(event.payload.fromModel !== undefined
                    ? { fromModel: event.payload.fromModel }
                    : {}),
                  createdAt: event.occurredAt,
                }
              : thread.pendingHandoff,
          updatedAt: event.occurredAt,
        },
      }
    }

    case 'thread.handoff-cleared':
      return {
        kind: 'updated',
        thread: {
          ...thread,
          pendingHandoff: null,
          updatedAt: event.occurredAt,
        },
      }

    case 'thread.runtime-mode-set':
      return {
        kind: 'updated',
        thread: {
          ...thread,
          runtimeMode: event.payload.runtimeMode,
          updatedAt: event.payload.updatedAt,
        },
      }

    case 'thread.interaction-mode-set':
      return {
        kind: 'updated',
        thread: {
          ...thread,
          interactionMode: event.payload.interactionMode,
          updatedAt: event.payload.updatedAt,
        },
      }

    // ── Turn lifecycle ──────────────────────────────────────────────
    case 'thread.turn-start-requested':
      return {
        kind: 'updated',
        thread: {
          ...thread,
          ...(event.payload.modelSelection !== undefined
            ? { modelSelection: event.payload.modelSelection }
            : {}),
          runtimeMode: event.payload.runtimeMode,
          interactionMode: event.payload.interactionMode,
          updatedAt: event.occurredAt,
        },
      }

    case 'thread.turn-interrupt-requested':
    {
      if (event.payload.turnId === undefined)
      {
        return { kind: 'unchanged' }
      }
      const latestTurn = thread.latestTurn
      if (latestTurn === null || latestTurn.turnId !== event.payload.turnId)
      {
        return { kind: 'unchanged' }
      }
      return {
        kind: 'updated',
        thread: {
          ...thread,
          latestTurn: {
            ...latestTurn,
            state: 'interrupted',
            startedAt: latestTurn.startedAt ?? event.payload.createdAt,
            completedAt: latestTurn.completedAt ?? event.payload.createdAt,
          },
          updatedAt: event.occurredAt,
        },
      }
    }

    // ── Messages ────────────────────────────────────────────────────
    case 'thread.message-sent':
    {
      const message: OrchestrationMessage = {
        id: event.payload.messageId,
        role: event.payload.role,
        text: event.payload.text,
        ...(event.payload.attachments !== undefined
          ? { attachments: event.payload.attachments }
          : {}),
        turnId: event.payload.turnId,
        streaming: event.payload.streaming,
        createdAt: event.payload.createdAt,
        updatedAt: event.payload.updatedAt,
      }

      const lastMessageIndex = thread.messages.length - 1
      const existingMessageIndex =
        thread.messages[lastMessageIndex]?.id === message.id
          ? lastMessageIndex
          : thread.messages.findIndex((entry) => entry.id === message.id)
      const messages =
        existingMessageIndex < 0
          ? Arr.append(thread.messages, message)
          : (() =>
            {
              const existingMessage = thread.messages[existingMessageIndex]!
              const next = thread.messages.slice()
              next[existingMessageIndex] = {
                ...existingMessage,
                text: message.streaming
                  ? `${existingMessage.text}${message.text}`
                  : message.text.length > 0
                    ? message.text
                    : existingMessage.text,
                streaming: message.streaming,
                ...(message.turnId !== undefined ? { turnId: message.turnId } : {}),
                ...(message.streaming ? {} : { updatedAt: message.updatedAt }),
                ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
              }
              return next
            })()
      // update latestTurn for assistant messages bound to a turn. A completed
      // assistant message only settles the turn once the session is no longer
      // running it — providers may emit several assistant messages per turn
      // (commentary between tool calls), and the turn must stay unsettled
      // until the provider reports turn end.
      const turnStillRunning =
        event.payload.turnId !== null &&
        thread.session?.status === 'running' &&
        thread.session.activeTurnId === event.payload.turnId
      const settlesTurn = !event.payload.streaming && !turnStillRunning
      const latestTurn: OrchestrationThread['latestTurn'] =
        event.payload.role === 'assistant' &&
        event.payload.turnId !== null &&
        (thread.latestTurn === null || thread.latestTurn.turnId === event.payload.turnId)
          ? {
              turnId: event.payload.turnId,
              state: settlesTurn
                ? thread.latestTurn?.state === 'interrupted'
                  ? 'interrupted'
                  : thread.latestTurn?.state === 'error'
                    ? 'error'
                    : 'completed'
                : 'running',
              requestedAt:
                thread.latestTurn?.turnId === event.payload.turnId
                  ? thread.latestTurn.requestedAt
                  : event.payload.createdAt,
              startedAt:
                thread.latestTurn?.turnId === event.payload.turnId
                  ? (thread.latestTurn.startedAt ?? event.payload.createdAt)
                  : event.payload.createdAt,
              completedAt: settlesTurn
                ? event.payload.updatedAt
                : thread.latestTurn?.turnId === event.payload.turnId
                  ? (thread.latestTurn.completedAt ?? null)
                  : null,
              assistantMessageId: event.payload.messageId,
            }
          : thread.latestTurn

      // rebind checkpoint assistant message IDs for assistant messages.
      const checkpoints =
        event.payload.role === 'assistant' && event.payload.turnId !== null
          ? rebindCheckpointAssistantMessage(
              thread.checkpoints,
              event.payload.turnId,
              event.payload.messageId,
            )
          : thread.checkpoints

      return {
        kind: 'updated',
        thread: {
          ...thread,
          messages,
          checkpoints,
          latestTurn,
          updatedAt: event.occurredAt,
        },
      }
    }

    // ── Session ─────────────────────────────────────────────────────
    case 'thread.session-set':
    {
      // leaving the "running" session status is the turn-end signal: settle a
      // still-running latest turn so its duration reflects the whole turn.
      const settledTurnState = settledTurnStateForSessionStatus(event.payload.session.status)
      const latestTurn: OrchestrationLatestTurn | null =
        event.payload.session.status === 'running' && event.payload.session.activeTurnId !== null
          ? {
              turnId: event.payload.session.activeTurnId,
              state: 'running',
              requestedAt:
                thread.latestTurn?.turnId === event.payload.session.activeTurnId
                  ? thread.latestTurn.requestedAt
                  : event.payload.session.updatedAt,
              startedAt:
                thread.latestTurn?.turnId === event.payload.session.activeTurnId
                  ? (thread.latestTurn.startedAt ?? event.payload.session.updatedAt)
                  : event.payload.session.updatedAt,
              completedAt: null,
              assistantMessageId:
                thread.latestTurn?.turnId === event.payload.session.activeTurnId
                  ? thread.latestTurn.assistantMessageId
                  : null,
            }
          : thread.latestTurn !== null &&
              thread.latestTurn.state === 'running' &&
              settledTurnState !== null
            ? {
                ...thread.latestTurn,
                state: settledTurnState,
                // a running turn's completedAt can only hold a mid-turn
                // placeholder checkpoint timestamp — the session leaving
                // "running" is the authoritative turn end.
                completedAt: event.payload.session.updatedAt,
              }
            : thread.latestTurn

      return {
        kind: 'updated',
        thread: {
          ...thread,
          session: event.payload.session,
          latestTurn,
          updatedAt: event.occurredAt,
        },
      }
    }

    case 'thread.session-stop-requested':
      return { kind: 'unchanged' }

    // ── Proposed plans ──────────────────────────────────────────────
    case 'thread.proposed-plan-upserted':
    {
      const proposedPlan = event.payload.proposedPlan

      const proposedPlans = pipe(
        thread.proposedPlans,
        Arr.filter((entry) => entry.id !== proposedPlan.id),
        Arr.append(proposedPlan),
        Arr.sort(proposedPlanOrder),
      )

      return {
        kind: 'updated',
        thread: { ...thread, proposedPlans, updatedAt: event.occurredAt },
      }
    }

    // ── Checkpoints / turn diffs ────────────────────────────────────
    case 'thread.turn-diff-completed':
    {
      const checkpoint: OrchestrationCheckpointSummary = {
        turnId: event.payload.turnId,
        checkpointTurnCount: event.payload.checkpointTurnCount,
        checkpointRef: event.payload.checkpointRef,
        status: event.payload.status,
        files: event.payload.files,
        assistantMessageId: event.payload.assistantMessageId,
        completedAt: event.payload.completedAt,
      }

      const existing = thread.checkpoints.find((entry) => entry.turnId === checkpoint.turnId)
      // don't overwrite a non-missing checkpoint with a missing one.
      if (existing && existing.status !== 'missing' && checkpoint.status === 'missing')
      {
        return { kind: 'unchanged' }
      }

      const checkpoints = pipe(
        thread.checkpoints,
        Arr.filter((entry) => entry.turnId !== checkpoint.turnId),
        Arr.append(checkpoint),
        Arr.sort(checkpointOrder),
      )

      // mid-turn diff updates produce placeholder checkpoints; record the
      // checkpoint, but don't settle a turn its session is still running.
      const diffTurnStillRunning =
        thread.session?.status === 'running' && thread.session.activeTurnId === event.payload.turnId
      const latestTurn =
        !diffTurnStillRunning &&
        (thread.latestTurn === null || thread.latestTurn.turnId === event.payload.turnId)
          ? {
              turnId: event.payload.turnId,
              state: checkpointStatusToTurnState(event.payload.status),
              requestedAt: thread.latestTurn?.requestedAt ?? event.payload.completedAt,
              startedAt: thread.latestTurn?.startedAt ?? event.payload.completedAt,
              completedAt: event.payload.completedAt,
              assistantMessageId: event.payload.assistantMessageId,
            }
          : thread.latestTurn

      return {
        kind: 'updated',
        thread: { ...thread, checkpoints, latestTurn, updatedAt: event.occurredAt },
      }
    }

    // ── Revert ──────────────────────────────────────────────────────
    case 'thread.reverted':
    {
      const checkpoints = pipe(
        thread.checkpoints,
        Arr.filter(
          (entry) =>
            entry.checkpointTurnCount !== undefined &&
            entry.checkpointTurnCount <= event.payload.turnCount,
        ),
        Arr.sort(checkpointOrder),
      )

      const retainedTurnIds = new Set(Arr.map(checkpoints, (entry) => entry.turnId))
      const messages = retainMessagesAfterRevert(
        thread.messages,
        retainedTurnIds,
        event.payload.turnCount,
      )
      const proposedPlans = pipe(
        thread.proposedPlans,
        Arr.filter((plan) => plan.turnId === null || retainedTurnIds.has(plan.turnId)),
      )
      const orchestratePlans = pipe(
        thread.orchestratePlans,
        Arr.filter((plan) => plan.turnId === null || retainedTurnIds.has(plan.turnId)),
      )
      const activities = pipe(
        thread.activities,
        Arr.filter((activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId)),
      )
      const latestCheckpoint = checkpoints.at(-1) ?? null

      return {
        kind: 'updated',
        thread: {
          ...thread,
          checkpoints,
          messages,
          proposedPlans,
          orchestratePlans,
          activities,
          latestTurn:
            latestCheckpoint === null
              ? null
              : {
                  turnId: latestCheckpoint.turnId,
                  state: checkpointStatusToTurnState(
                    latestCheckpoint.status as 'ready' | 'missing' | 'error',
                  ),
                  requestedAt: latestCheckpoint.completedAt,
                  startedAt: latestCheckpoint.completedAt,
                  completedAt: latestCheckpoint.completedAt,
                  assistantMessageId: latestCheckpoint.assistantMessageId ?? null,
                },
          updatedAt: event.occurredAt,
        },
      }
    }

    // ── Activities ──────────────────────────────────────────────────
    case 'thread.activity-appended':
    {
      const isProviderSwitchActivity =
        event.payload.activity.kind === 'provider.switch.failed' ||
        event.payload.activity.kind === 'provider.switch.completed'
      const activity =
        isProviderSwitchActivity && event.payload.activity.sequence === undefined
          ? { ...event.payload.activity, sequence: event.sequence }
          : event.payload.activity
      const replacedActivityId = isProviderSwitchActivity
        ? thread.activities.findLast(
            (entry) =>
              event.causationEventId === entry.id ||
              isAdjacentProviderSwitchActivity(entry, activity),
          )?.id
        : undefined
      const activities = upsertThreadActivity(
        thread.activities.filter((entry) => entry.id !== replacedActivityId),
        activity,
      )

      return {
        kind: 'updated',
        thread: {
          ...thread,
          activities,
          pendingHandoff:
            event.payload.activity.kind === 'provider.handoff.delivered'
              ? null
              : thread.pendingHandoff,
          updatedAt: event.occurredAt,
        },
      }
    }

    case 'thread.approval-response-requested':
    {
      const approvalOutcome = event.payload.approvalOutcome
      if (approvalOutcome === undefined)
      {
        return { kind: 'unchanged' }
      }
      const approvalOutcomes = Arr.append(
        Arr.filter(
          thread.approvalOutcomes ?? [],
          (outcome) => outcome.requestId !== approvalOutcome.requestId,
        ),
        approvalOutcome,
      )
      return {
        kind: 'updated',
        thread: {
          ...thread,
          approvalOutcomes,
          updatedAt: event.occurredAt,
        },
      }
    }

    // ── Orchestrate plans ───────────────────────────────────────────
    // mirror the server projection so live subscribers see plan revisions
    // and status flips without waiting for a fresh snapshot
    case 'thread.orchestrate-plan-upserted':
    {
      const incoming = event.payload.plan
      const orchestratePlans = pipe(
        thread.orchestratePlans,
        Arr.filter(
          (plan) => !(plan.runId === incoming.runId && plan.revision === incoming.revision),
        ),
        Arr.map((plan) =>
          plan.runId === incoming.runId && plan.status === 'pending'
            ? { ...plan, status: 'superseded' as const, updatedAt: event.occurredAt }
            : plan,
        ),
        Arr.append(incoming),
      )
      return {
        kind: 'updated',
        thread: { ...thread, orchestratePlans, updatedAt: event.occurredAt },
      }
    }
    case 'thread.orchestrate-plan-response-requested':
    {
      if (event.payload.decision === 'discuss') return { kind: 'unchanged' }
      const nextStatus = event.payload.decision === 'approve' ? 'approved' : 'rejected'
      const orchestratePlans = thread.orchestratePlans.map((plan) =>
        plan.runId === event.payload.runId && plan.revision === event.payload.revision
          ? { ...plan, status: nextStatus as 'approved' | 'rejected', updatedAt: event.occurredAt }
          : plan,
      )
      return {
        kind: 'updated',
        thread: { ...thread, orchestratePlans, updatedAt: event.occurredAt },
      }
    }

    // ── Events that don't mutate thread state directly ──────────────
    case 'thread.user-input-response-requested':
    case 'thread.checkpoint-revert-requested':
      return { kind: 'unchanged' }
  }

  // forward-compatible: ignore unrecognized event types.
  return { kind: 'unchanged' }
}

// ── Helpers ──────────────────────────────────────────────────────────

// turn state to settle a still-running latest turn with when its session
// leaves the "running" status, or null while the session is (re)starting or
// running and the turn must stay unsettled.
function settledTurnStateForSessionStatus(
  status: OrchestrationSession['status'],
): 'completed' | 'interrupted' | 'error' | null
{
  switch (status)
  {
    case 'idle':
    case 'ready':
      return 'completed'
    case 'error':
      return 'error'
    case 'interrupted':
    case 'stopped':
      return 'interrupted'
    case 'starting':
    case 'running':
      return null
  }
}

function checkpointStatusToTurnState(
  status: 'ready' | 'missing' | 'error',
): OrchestrationLatestTurn['state']
{
  switch (status)
  {
    case 'ready':
      return 'completed'
    case 'error':
      return 'error'
    case 'missing':
      return 'interrupted'
  }
}

function rebindCheckpointAssistantMessage(
  checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>,
  turnId: TurnId,
  messageId: MessageId,
): OrchestrationCheckpointSummary[]
{
  return Arr.map(checkpoints, (entry) =>
    entry.turnId === turnId ? { ...entry, assistantMessageId: messageId } : entry,
  )
}

function retainMessagesAfterRevert(
  messages: ReadonlyArray<OrchestrationMessage>,
  retainedTurnIds: ReadonlySet<string>,
  turnCount: number,
): OrchestrationMessage[]
{
  const retainedMessageIds = new Set<MessageId>()
  for (const message of messages)
  {
    if (
      message.role === 'system' ||
      (message.turnId !== null && retainedTurnIds.has(message.turnId))
    )
    {
      retainedMessageIds.add(message.id)
    }
  }

  for (const role of ['user', 'assistant'] as const)
  {
    const retainedCount = messages.filter(
      (message) => message.role === role && retainedMessageIds.has(message.id),
    ).length
    const missingCount = Math.max(0, turnCount - retainedCount)
    if (missingCount === 0)
    {
      continue
    }

    const fallbackMessages = messages
      .filter(
        (message) =>
          message.role === role &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingCount)
    for (const message of fallbackMessages)
    {
      retainedMessageIds.add(message.id)
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.id))
}
