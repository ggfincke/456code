// apps/server/src/orchestration/projector.ts
// applies orchestration events to in-memory read models

import type { OrchestrationEvent, OrchestrationReadModel } from '@t3tools/contracts'
import {
  ApprovalOutcome,
  ApprovalRequestId,
  OrchestrationCheckpointSummary,
  OrchestrationMessage,
  OrchestrationSession,
  OrchestrationThread,
  ThreadId,
} from '@t3tools/contracts'
import { classifyApprovalFailure } from '@t3tools/shared/approvalOutcomeClassifier'
import { compareOrchestrationThreadActivities } from '@t3tools/shared/orchestrationActivityOrder'
import { isAdjacentProviderSwitchActivity } from '@t3tools/shared/providerSwitchActivity'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { toProjectorDecodeError, type OrchestrationProjectorDecodeError } from './Errors.ts'
import {
  COMMAND_RELEVANT_THREAD_ACTIVITY_KIND_SET,
  isImportContinuationActivityPayload,
} from './activityPolicy.ts'
import {
  MessageSentPayloadSchema,
  ProjectCreatedPayload,
  ProjectDeletedPayload,
  ProjectMetaUpdatedPayload,
  ThreadActivityAppendedPayload,
  ThreadArchivedPayload,
  ThreadCreatedPayload,
  ThreadDeletedPayload,
  ThreadInteractionModeSetPayload,
  ThreadHandoffClearedPayload,
  ThreadMetaUpdatedPayload,
  ThreadOrchestrateRunExecutionAdmittedPayload,
  ThreadOrchestrateRunExecutionUpdatedPayload,
  ThreadOrchestrateRunIntegrationSetPayload,
  ThreadOrchestratePlanResponseRequestedPayload,
  ThreadOrchestratePlanUpsertedPayload,
  ThreadProviderSwitchedPayload,
  ThreadProviderSwitchFailedPayload,
  ThreadProviderSwitchProgressedPayload,
  ThreadProviderSwitchRequestedPayload,
  ThreadProposedPlanUpsertedPayload,
  ThreadRuntimeModeSetPayload,
  ThreadSettledPayload,
  ThreadSnoozedPayload,
  ThreadUnarchivedPayload,
  ThreadUnsettledPayload,
  ThreadUnsnoozedPayload,
  ThreadRevertedPayload,
  ThreadApprovalResponseRequestedPayload,
  ThreadSessionSetPayload,
  ThreadTurnDiffCompletedPayload,
} from './Schemas.ts'

type ThreadPatch = Partial<Omit<OrchestrationThread, 'id' | 'projectId'>>
const MAX_THREAD_MESSAGES = 2_000
const MAX_THREAD_CHECKPOINTS = 500
const isApprovalOutcome = Schema.is(ApprovalOutcome)

function upsertApprovalOutcome(
  outcomes: OrchestrationThread['approvalOutcomes'],
  outcome: ApprovalOutcome,
): ReadonlyArray<ApprovalOutcome>
{
  const current = outcomes ?? []
  const existing = current.find((entry) => entry.requestId === outcome.requestId)
  if (
    existing !== undefined &&
    (existing.status === 'accepted' || existing.status === 'stale-terminal') &&
    existing.status !== outcome.status
  )
  {
    return current
  }
  return [...current.filter((entry) => entry.requestId !== outcome.requestId), outcome]
}

function approvalOutcomeFromActivity(
  activity: OrchestrationThread['activities'][number],
): ApprovalOutcome | null
{
  const payload =
    typeof activity.payload === 'object' && activity.payload !== null
      ? (activity.payload as Record<string, unknown>)
      : null
  const embedded = payload?.approvalOutcome
  if (activity.kind === 'provider.approval.respond.failed')
  {
    const classification = classifyApprovalFailure(payload)
    if (isApprovalOutcome(embedded))
    {
      return { ...embedded, status: classification.status }
    }
    const requestId = typeof payload?.requestId === 'string' ? payload.requestId : null
    if (requestId === null)
    {
      return null
    }
    const detail =
      typeof payload?.detail === 'string' ? payload.detail : 'Provider response failed.'
    return {
      requestId: ApprovalRequestId.make(requestId),
      status: classification.status,
      detail,
      updatedAt: activity.createdAt,
    }
  }
  if (isApprovalOutcome(embedded))
  {
    return embedded
  }
  const requestId = typeof payload?.requestId === 'string' ? payload.requestId : null
  if (requestId === null)
  {
    return null
  }
  if (activity.kind === 'approval.requested')
  {
    return {
      requestId: ApprovalRequestId.make(requestId),
      status: 'pending',
      updatedAt: activity.createdAt,
    }
  }
  if (activity.kind === 'approval.resolved')
  {
    const decision =
      payload?.decision === 'accept' ||
      payload?.decision === 'acceptForSession' ||
      payload?.decision === 'decline' ||
      payload?.decision === 'cancel'
        ? payload.decision
        : null
    return {
      requestId: ApprovalRequestId.make(requestId),
      status: 'accepted',
      decision,
      updatedAt: activity.createdAt,
    }
  }
  return null
}

function checkpointStatusToLatestTurnState(status: 'ready' | 'missing' | 'error')
{
  if (status === 'error') return 'error' as const
  if (status === 'missing') return 'interrupted' as const
  return 'completed' as const
}

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

function updateThread(
  threads: ReadonlyArray<OrchestrationThread>,
  threadId: ThreadId,
  patch: ThreadPatch,
): OrchestrationThread[]
{
  return threads.map((thread) => (thread.id === threadId ? { ...thread, ...patch } : thread))
}

function decodeForEvent<A>(
  schema: Schema.Decoder<A, never>,
  value: unknown,
  eventType: OrchestrationEvent['type'],
  field: string,
): Effect.Effect<A, OrchestrationProjectorDecodeError>
{
  return Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(toProjectorDecodeError(`${eventType}:${field}`)),
  )
}

function retainThreadMessagesAfterRevert(
  messages: ReadonlyArray<OrchestrationMessage>,
  retainedTurnIds: ReadonlySet<string>,
  turnCount: number,
): ReadonlyArray<OrchestrationMessage>
{
  const retainedMessageIds = new Set<string>()
  for (const message of messages)
  {
    if (message.role === 'system')
    {
      retainedMessageIds.add(message.id)
      continue
    }
    if (message.turnId !== null && retainedTurnIds.has(message.turnId))
    {
      retainedMessageIds.add(message.id)
    }
  }

  const retainedUserCount = messages.filter(
    (message) => message.role === 'user' && retainedMessageIds.has(message.id),
  ).length
  const missingUserCount = Math.max(0, turnCount - retainedUserCount)
  if (missingUserCount > 0)
  {
    const fallbackUserMessages = messages
      .filter(
        (message) =>
          message.role === 'user' &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingUserCount)
    for (const message of fallbackUserMessages)
    {
      retainedMessageIds.add(message.id)
    }
  }

  const retainedAssistantCount = messages.filter(
    (message) => message.role === 'assistant' && retainedMessageIds.has(message.id),
  ).length
  const missingAssistantCount = Math.max(0, turnCount - retainedAssistantCount)
  if (missingAssistantCount > 0)
  {
    const fallbackAssistantMessages = messages
      .filter(
        (message) =>
          message.role === 'assistant' &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingAssistantCount)
    for (const message of fallbackAssistantMessages)
    {
      retainedMessageIds.add(message.id)
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.id))
}

function retainThreadActivitiesAfterRevert(
  activities: ReadonlyArray<OrchestrationThread['activities'][number]>,
  retainedTurnIds: ReadonlySet<string>,
): ReadonlyArray<OrchestrationThread['activities'][number]>
{
  return activities.filter(
    (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
  )
}

function retainThreadProposedPlansAfterRevert(
  proposedPlans: ReadonlyArray<OrchestrationThread['proposedPlans'][number]>,
  retainedTurnIds: ReadonlySet<string>,
): ReadonlyArray<OrchestrationThread['proposedPlans'][number]>
{
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || retainedTurnIds.has(proposedPlan.turnId),
  )
}

function retainThreadOrchestratePlansAfterRevert(
  orchestratePlans: ReadonlyArray<OrchestrationThread['orchestratePlans'][number]>,
  retainedTurnIds: ReadonlySet<string>,
): ReadonlyArray<OrchestrationThread['orchestratePlans'][number]>
{
  return orchestratePlans.filter((plan) => plan.turnId === null || retainedTurnIds.has(plan.turnId))
}

function isImportContinuationActivity(
  activity: OrchestrationThread['activities'][number],
): boolean
{
  return isImportContinuationActivityPayload(activity.payload)
}

function retainThreadActivities(
  activities: ReadonlyArray<OrchestrationThread['activities'][number]>,
): ReadonlyArray<OrchestrationThread['activities'][number]>
{
  const latestImportContinuation = activities.findLast(isImportContinuationActivity)
  const retainedActivities = activities
    .filter((activity) => !isImportContinuationActivity(activity))
    .slice(-500)
  if (latestImportContinuation === undefined)
  {
    return retainedActivities
  }
  return [latestImportContinuation, ...retainedActivities].toSorted(
    compareOrchestrationThreadActivities,
  )
}

function appendProjectedActivity(
  activities: ReadonlyArray<OrchestrationThread['activities'][number]>,
  activity: OrchestrationThread['activities'][number],
): ReadonlyArray<OrchestrationThread['activities'][number]>
{
  return retainThreadActivities(
    [...activities.filter((entry) => entry.id !== activity.id), activity].toSorted(
      compareOrchestrationThreadActivities,
    ),
  )
}

function compactFinalizedImportActivities(
  activities: ReadonlyArray<OrchestrationThread['activities'][number]>,
): ReadonlyArray<OrchestrationThread['activities'][number]>
{
  const latestImportContinuation = activities.findLast(isImportContinuationActivity)
  const retainedActivities = activities.filter((activity) =>
    COMMAND_RELEVANT_THREAD_ACTIVITY_KIND_SET.has(activity.kind),
  )
  if (latestImportContinuation === undefined)
  {
    return retainedActivities
  }
  return [...retainedActivities, latestImportContinuation].toSorted(
    compareOrchestrationThreadActivities,
  )
}

export function createEmptyReadModel(nowIso: string): OrchestrationReadModel
{
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [],
    orchestrateRuns: [],
    orchestrateRunExecutions: [],
    updatedAt: nowIso,
  }
}

export function projectEvent(
  model: OrchestrationReadModel,
  event: OrchestrationEvent,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError>
{
  const nextBase: OrchestrationReadModel = {
    ...model,
    snapshotSequence: event.sequence,
    updatedAt: event.occurredAt,
  }

  switch (event.type)
  {
    case 'project.created':
      return decodeForEvent(ProjectCreatedPayload, event.payload, event.type, 'payload').pipe(
        Effect.map((payload) =>
        {
          const existing = nextBase.projects.find((entry) => entry.id === payload.projectId)
          const nextProject = {
            id: payload.projectId,
            title: payload.title,
            workspaceRoot: payload.workspaceRoot,
            defaultModelSelection: payload.defaultModelSelection,
            scripts: payload.scripts,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
            deletedAt: null,
          }

          return {
            ...nextBase,
            projects: existing
              ? nextBase.projects.map((entry) =>
                  entry.id === payload.projectId ? nextProject : entry,
                )
              : [...nextBase.projects, nextProject],
          }
        }),
      )

    case 'project.meta-updated':
      return decodeForEvent(ProjectMetaUpdatedPayload, event.payload, event.type, 'payload').pipe(
        Effect.map((payload) => ({
          ...nextBase,
          projects: nextBase.projects.map((project) =>
            project.id === payload.projectId
              ? {
                  ...project,
                  ...(payload.title !== undefined ? { title: payload.title } : {}),
                  ...(payload.workspaceRoot !== undefined
                    ? { workspaceRoot: payload.workspaceRoot }
                    : {}),
                  ...(payload.defaultModelSelection !== undefined
                    ? { defaultModelSelection: payload.defaultModelSelection }
                    : {}),
                  ...(payload.scripts !== undefined ? { scripts: payload.scripts } : {}),
                  updatedAt: payload.updatedAt,
                }
              : project,
          ),
        })),
      )

    case 'project.deleted':
      return decodeForEvent(ProjectDeletedPayload, event.payload, event.type, 'payload').pipe(
        Effect.map((payload) => ({
          ...nextBase,
          projects: nextBase.projects.map((project) =>
            project.id === payload.projectId
              ? {
                  ...project,
                  deletedAt: payload.deletedAt,
                  updatedAt: payload.deletedAt,
                }
              : project,
          ),
        })),
      )

    case 'thread.created':
      return Effect.gen(function* ()
      {
        const payload = yield* decodeForEvent(
          ThreadCreatedPayload,
          event.payload,
          event.type,
          'payload',
        )
        const thread: OrchestrationThread = yield* decodeForEvent(
          OrchestrationThread,
          {
            id: payload.threadId,
            projectId: payload.projectId,
            title: payload.title,
            modelSelection: payload.modelSelection,
            runtimeMode: payload.runtimeMode,
            interactionMode: payload.interactionMode,
            ...(payload.orchestrate !== undefined ? { orchestrate: payload.orchestrate } : {}),
            branch: payload.branch,
            worktreePath: payload.worktreePath,
            latestTurn: null,
            pendingHandoff: null,
            providerSwitch: null,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
            archivedAt: null,
            archiveGeneration: 0,
            origin: payload.origin,
            settledOverride: null,
            settledAt: null,
            snoozedUntil: null,
            snoozedAt: null,
            deletedAt: null,
            messages: [],
            activities: [],
            checkpoints: [],
            session: null,
            approvalOutcomes: [],
          },
          event.type,
          'thread',
        )
        const existing = nextBase.threads.find((entry) => entry.id === thread.id)
        return {
          ...nextBase,
          threads: existing
            ? nextBase.threads.map((entry) => (entry.id === thread.id ? thread : entry))
            : [...nextBase.threads, thread],
        }
      })

    case 'thread.deleted':
      return decodeForEvent(ThreadDeletedPayload, event.payload, event.type, 'payload').pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            deletedAt: payload.deletedAt,
            updatedAt: payload.deletedAt,
          }),
        })),
      )

    case 'thread.archived':
      return decodeForEvent(ThreadArchivedPayload, event.payload, event.type, 'payload').pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            archivedAt: payload.archivedAt,
            archiveGeneration: payload.archiveGeneration ?? 0,
            updatedAt: payload.updatedAt,
          }),
        })),
      )

    case 'thread.unarchived':
      return decodeForEvent(ThreadUnarchivedPayload, event.payload, event.type, 'payload').pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            archivedAt: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      )

    case 'thread.settled':
      return decodeForEvent(ThreadSettledPayload, event.payload, event.type, 'payload').pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            settledOverride: 'settled',
            settledAt: payload.settledAt,
            updatedAt: payload.updatedAt,
          }),
        })),
      )

    case 'thread.unsettled':
      return decodeForEvent(ThreadUnsettledPayload, event.payload, event.type, 'payload').pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            settledOverride: payload.reason === 'user' ? 'active' : null,
            settledAt: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      )

    case 'thread.snoozed':
      return decodeForEvent(ThreadSnoozedPayload, event.payload, event.type, 'payload').pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            snoozedUntil: payload.snoozedUntil,
            snoozedAt: payload.snoozedAt,
            updatedAt: payload.updatedAt,
          }),
        })),
      )

    case 'thread.unsnoozed':
      return decodeForEvent(ThreadUnsnoozedPayload, event.payload, event.type, 'payload').pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            snoozedUntil: null,
            snoozedAt: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      )

    case 'thread.meta-updated':
      return decodeForEvent(ThreadMetaUpdatedPayload, event.payload, event.type, 'payload').pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            ...(payload.title !== undefined ? { title: payload.title } : {}),
            ...(payload.modelSelection !== undefined
              ? { modelSelection: payload.modelSelection }
              : {}),
            ...(payload.branch !== undefined ? { branch: payload.branch } : {}),
            ...(payload.worktreePath !== undefined ? { worktreePath: payload.worktreePath } : {}),
            updatedAt: payload.updatedAt,
          }),
        })),
      )

    // updatedAt is left alone on purpose; see ThreadOrchestrateRunIntegrationSetPayload
    case 'thread.orchestrate-run-integration-set':
      if (
        nextBase.threads.find((thread) => thread.id === event.payload.threadId)
          ?.orchestrateRunExecution !== undefined
      )
      {
        return Effect.succeed(nextBase)
      }
      return decodeForEvent(
        ThreadOrchestrateRunIntegrationSetPayload,
        event.payload,
        event.type,
        'payload',
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            orchestrateRunWorktreePath: payload.worktreePath,
            orchestrateRunBranch: payload.branch,
          }),
        })),
      )

    case 'thread.orchestrate-run-execution-admitted':
      return decodeForEvent(
        ThreadOrchestrateRunExecutionAdmittedPayload,
        event.payload,
        event.type,
        'payload',
      ).pipe(
        Effect.map(({ execution }) =>
        {
          const nextExecution = { ...execution, current: true }
          const orchestrateRunExecutions = [
            ...(nextBase.orchestrateRunExecutions ?? [])
              .filter(
                (entry) =>
                  entry.threadId !== execution.threadId ||
                  entry.runId !== execution.runId ||
                  entry.planRevision !== execution.planRevision,
              )
              .map((entry) =>
                entry.threadId === execution.threadId && entry.current
                  ? { ...entry, current: false }
                  : entry,
              ),
            nextExecution,
          ]
          const existingRun = (nextBase.orchestrateRuns ?? []).find(
            (entry) => entry.threadId === execution.threadId && entry.runId === execution.runId,
          )
          const nextRun = {
            threadId: execution.threadId,
            runId: execution.runId,
            currentPlanRevision: execution.planRevision,
            createdAt: existingRun?.createdAt ?? execution.admittedAt,
            updatedAt: execution.updatedAt,
          }
          return {
            ...nextBase,
            orchestrateRuns: [
              ...(nextBase.orchestrateRuns ?? []).filter(
                (entry) => entry.threadId !== execution.threadId || entry.runId !== execution.runId,
              ),
              nextRun,
            ],
            orchestrateRunExecutions,
            threads: updateThread(nextBase.threads, execution.threadId, {
              orchestrateRunExecution: nextExecution,
              orchestrateRunWorktreePath:
                nextExecution.availability === 'available' ? nextExecution.integrationRoot : null,
              orchestrateRunBranch:
                nextExecution.availability === 'available' ? nextExecution.integrationBranch : null,
            }),
          }
        }),
      )

    case 'thread.orchestrate-run-execution-updated':
      return decodeForEvent(
        ThreadOrchestrateRunExecutionUpdatedPayload,
        event.payload,
        event.type,
        'payload',
      ).pipe(
        Effect.map(({ execution }) =>
        {
          const orchestrateRunExecutions = [
            ...(nextBase.orchestrateRunExecutions ?? []).filter(
              (entry) =>
                entry.threadId !== execution.threadId ||
                entry.runId !== execution.runId ||
                entry.planRevision !== execution.planRevision,
            ),
            execution,
          ]
          if (!execution.current)
          {
            return { ...nextBase, orchestrateRunExecutions }
          }
          return {
            ...nextBase,
            orchestrateRunExecutions,
            threads: updateThread(nextBase.threads, execution.threadId, {
              orchestrateRunExecution: execution,
              orchestrateRunWorktreePath:
                execution.availability === 'available' ? execution.integrationRoot : null,
              orchestrateRunBranch:
                execution.availability === 'available' ? execution.integrationBranch : null,
            }),
          }
        }),
      )

    case 'thread.runtime-mode-set':
      return decodeForEvent(ThreadRuntimeModeSetPayload, event.payload, event.type, 'payload').pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            runtimeMode: payload.runtimeMode,
            updatedAt: payload.updatedAt,
          }),
        })),
      )

    case 'thread.interaction-mode-set':
      return decodeForEvent(
        ThreadInteractionModeSetPayload,
        event.payload,
        event.type,
        'payload',
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            interactionMode: payload.interactionMode,
            orchestrate: payload.orchestrate ?? false,
            updatedAt: payload.updatedAt,
          }),
        })),
      )

    case 'thread.provider-switch-requested':
      return decodeForEvent(
        ThreadProviderSwitchRequestedPayload,
        event.payload,
        event.type,
        'payload',
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            providerSwitch: {
              phase: 'pending',
              targetInstanceId: payload.targetModelSelection.instanceId,
              targetModel: payload.targetModelSelection.model,
              requestedAt: event.occurredAt,
              requestId: event.eventId,
              requestSequence: event.sequence,
              sourceModelSelection:
                payload.sourceModelSelection ??
                nextBase.threads.find((thread) => thread.id === payload.threadId)?.modelSelection,
            },
            updatedAt: event.occurredAt,
          }),
        })),
      )

    case 'thread.provider-switch-progressed':
      return decodeForEvent(
        ThreadProviderSwitchProgressedPayload,
        event.payload,
        event.type,
        'payload',
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: nextBase.threads.map((thread) =>
            thread.id === payload.threadId &&
            thread.providerSwitch !== null &&
            (payload.requestId === undefined ||
              thread.providerSwitch.requestId === payload.requestId)
              ? {
                  ...thread,
                  providerSwitch: { ...thread.providerSwitch, phase: payload.phase },
                  updatedAt: event.occurredAt,
                }
              : thread,
          ),
        })),
      )

    case 'thread.provider-switch-failed':
      return decodeForEvent(
        ThreadProviderSwitchFailedPayload,
        event.payload,
        event.type,
        'payload',
      ).pipe(
        Effect.map((payload) =>
        {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId)
          if (!thread)
          {
            return nextBase
          }
          const target = thread.providerSwitch
          if (payload.requestId !== undefined && target?.requestId !== payload.requestId)
          {
            return nextBase
          }
          const sourceModelSelection = payload.sourceModelSelection ?? thread.modelSelection
          const targetModelSelection =
            payload.targetModelSelection ??
            (target === null
              ? undefined
              : { instanceId: target.targetInstanceId, model: target.targetModel })
          const activity: OrchestrationThread['activities'][number] = {
            id: event.eventId,
            tone: 'error',
            kind: 'provider.switch.failed',
            summary: 'Provider switch failed',
            payload: {
              reasonCode: payload.reasonCode,
              detail: payload.detail,
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
            payload.activityVersion === undefined &&
            thread.activities.some((entry) => isAdjacentProviderSwitchActivity(entry, activity))
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              providerSwitch: null,
              activities: hasHistoricalActivity
                ? thread.activities
                : appendProjectedActivity(thread.activities, activity),
              updatedAt: event.occurredAt,
            }),
          }
        }),
      )

    case 'thread.provider-switched':
      return decodeForEvent(
        ThreadProviderSwitchedPayload,
        event.payload,
        event.type,
        'payload',
      ).pipe(
        Effect.map((payload) =>
        {
          const threadId = ThreadId.make(event.aggregateId)
          const thread = nextBase.threads.find((entry) => entry.id === threadId)
          if (!thread)
          {
            return nextBase
          }
          if (
            payload.requestId !== undefined &&
            thread.providerSwitch?.requestId !== payload.requestId
          )
          {
            return nextBase
          }
          const sourceModelSelection = payload.sourceModelSelection ?? {
            instanceId: payload.fromInstanceId ?? thread.modelSelection.instanceId,
            model: payload.fromModel ?? thread.modelSelection.model,
          }
          const activity: OrchestrationThread['activities'][number] = {
            id: event.eventId,
            tone: 'info',
            kind: 'provider.switch.completed',
            summary: `Switched from ${
              sourceModelSelection.model ?? sourceModelSelection.instanceId ?? 'prior provider'
            } to ${payload.modelSelection.model || payload.modelSelection.instanceId}`,
            payload: {
              fromInstanceId: sourceModelSelection.instanceId,
              fromModel: sourceModelSelection.model,
              toInstanceId: payload.modelSelection.instanceId,
              toModel: payload.modelSelection.model,
              targetModelSelection: payload.modelSelection,
            },
            turnId: null,
            sequence: event.sequence,
            createdAt: event.occurredAt,
          }
          const hasHistoricalActivity =
            payload.activityVersion === undefined &&
            thread.activities.some((entry) => isAdjacentProviderSwitchActivity(entry, activity))
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, threadId, {
              modelSelection: payload.modelSelection,
              providerSwitch: null,
              // empty text contributes no new context, so preserve any
              // unconsumed handoff until delivery or explicit clearing
              pendingHandoff:
                payload.handoffText.trim().length > 0
                  ? {
                      text: payload.handoffText,
                      fromInstanceId: payload.fromInstanceId,
                      ...(payload.fromModel !== undefined ? { fromModel: payload.fromModel } : {}),
                      createdAt: event.occurredAt,
                    }
                  : thread.pendingHandoff,
              activities: hasHistoricalActivity
                ? thread.activities
                : appendProjectedActivity(thread.activities, activity),
              updatedAt: event.occurredAt,
            }),
          }
        }),
      )

    case 'thread.handoff-cleared':
      return decodeForEvent(ThreadHandoffClearedPayload, event.payload, event.type, 'payload').pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            pendingHandoff: null,
            updatedAt: event.occurredAt,
          }),
        })),
      )

    case 'thread.message-sent':
      return Effect.gen(function* ()
      {
        const payload = yield* decodeForEvent(
          MessageSentPayloadSchema,
          event.payload,
          event.type,
          'payload',
        )
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId)
        if (!thread)
        {
          return nextBase
        }

        const message: OrchestrationMessage = yield* decodeForEvent(
          OrchestrationMessage,
          {
            id: payload.messageId,
            role: payload.role,
            text: payload.text,
            ...(payload.attachments !== undefined ? { attachments: payload.attachments } : {}),
            turnId: payload.turnId,
            streaming: payload.streaming,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
          },
          event.type,
          'message',
        )

        const existingMessage = thread.messages.find((entry) => entry.id === message.id)
        const messages = existingMessage
          ? thread.messages.map((entry) =>
              entry.id === message.id
                ? {
                    ...entry,
                    text: message.streaming
                      ? `${entry.text}${message.text}`
                      : message.text.length > 0
                        ? message.text
                        : entry.text,
                    streaming: message.streaming,
                    updatedAt: message.updatedAt,
                    turnId: message.turnId,
                    ...(message.attachments !== undefined
                      ? { attachments: message.attachments }
                      : {}),
                  }
                : entry,
            )
          : [...thread.messages, message]
        const cappedMessages = messages.slice(-MAX_THREAD_MESSAGES)

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            messages: cappedMessages,
            updatedAt: event.occurredAt,
          }),
        }
      })

    case 'thread.session-stop-requested':
    {
      const thread = nextBase.threads.find((entry) => entry.id === event.payload.threadId)
      if (!thread?.session)
      {
        return Effect.succeed(nextBase)
      }
      return Effect.succeed({
        ...nextBase,
        threads: updateThread(nextBase.threads, event.payload.threadId, {
          session: {
            ...thread.session,
            status: 'stopped',
            activeTurnId: null,
            updatedAt: event.payload.createdAt,
          },
          updatedAt: event.occurredAt,
        }),
      })
    }

    case 'thread.session-set':
      return Effect.gen(function* ()
      {
        const payload = yield* decodeForEvent(
          ThreadSessionSetPayload,
          event.payload,
          event.type,
          'payload',
        )
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId)
        if (!thread)
        {
          return nextBase
        }

        const session: OrchestrationSession = yield* decodeForEvent(
          OrchestrationSession,
          payload.session,
          event.type,
          'session',
        )

        // leaving the "running" session status is the turn-end signal: settle
        // a still-running latest turn so its duration reflects the whole turn.
        const settledTurnState = settledTurnStateForSessionStatus(session.status)
        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            session,
            latestTurn:
              session.status === 'running' && session.activeTurnId !== null
                ? {
                    turnId: session.activeTurnId,
                    state: 'running',
                    requestedAt:
                      thread.latestTurn?.turnId === session.activeTurnId
                        ? thread.latestTurn.requestedAt
                        : session.updatedAt,
                    startedAt:
                      thread.latestTurn?.turnId === session.activeTurnId
                        ? (thread.latestTurn.startedAt ?? session.updatedAt)
                        : session.updatedAt,
                    completedAt: null,
                    assistantMessageId:
                      thread.latestTurn?.turnId === session.activeTurnId
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
                      completedAt: session.updatedAt,
                    }
                  : thread.latestTurn,
            updatedAt: event.occurredAt,
          }),
        }
      })

    case 'thread.proposed-plan-upserted':
      return Effect.gen(function* ()
      {
        const payload = yield* decodeForEvent(
          ThreadProposedPlanUpsertedPayload,
          event.payload,
          event.type,
          'payload',
        )
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId)
        if (!thread)
        {
          return nextBase
        }

        const proposedPlans = [
          ...thread.proposedPlans.filter((entry) => entry.id !== payload.proposedPlan.id),
          payload.proposedPlan,
        ]
          .toSorted(
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
          )
          .slice(-200)

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            proposedPlans,
            updatedAt: event.occurredAt,
          }),
        }
      })

    case 'thread.orchestrate-plan-upserted':
      return Effect.gen(function* ()
      {
        const payload = yield* decodeForEvent(
          ThreadOrchestratePlanUpsertedPayload,
          event.payload,
          event.type,
          'payload',
        )
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId)
        if (!thread)
        {
          return nextBase
        }

        // a new revision supersedes older pending revisions of the same run
        const orchestratePlans = [
          ...thread.orchestratePlans
            .filter(
              (entry) =>
                entry.runId !== payload.plan.runId || entry.revision !== payload.plan.revision,
            )
            .map((entry) =>
              entry.runId === payload.plan.runId &&
              entry.revision < payload.plan.revision &&
              entry.status === 'pending'
                ? {
                    ...entry,
                    status: 'superseded' as const,
                    updatedAt: payload.plan.updatedAt,
                  }
                : entry,
            ),
          { ...payload.plan, sourceSequence: event.sequence },
        ]
          .toSorted(
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) ||
              left.runId.localeCompare(right.runId) ||
              left.revision - right.revision,
          )
          .slice(-200)

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            orchestratePlans,
            updatedAt: event.occurredAt,
          }),
        }
      })

    case 'thread.orchestrate-plan-response-requested':
      return Effect.gen(function* ()
      {
        const payload = yield* decodeForEvent(
          ThreadOrchestratePlanResponseRequestedPayload,
          event.payload,
          event.type,
          'payload',
        )
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId)
        const plan = thread?.orchestratePlans.find(
          (entry) => entry.runId === payload.runId && entry.revision === payload.revision,
        )
        if (!thread || !plan)
        {
          yield* Effect.logWarning('ignoring response for unknown orchestrate plan revision', {
            threadId: payload.threadId,
            runId: payload.runId,
            revision: payload.revision,
          })
          return nextBase
        }
        if (payload.decision === 'discuss')
        {
          return nextBase
        }

        const status = payload.decision === 'approve' ? 'approved' : 'rejected'
        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            orchestratePlans: thread.orchestratePlans.map((entry) =>
              entry.runId === payload.runId && entry.revision === payload.revision
                ? { ...entry, status, updatedAt: payload.createdAt }
                : entry,
            ),
            updatedAt: event.occurredAt,
          }),
        }
      })

    // turn-zero identity is durable projection evidence but is intentionally
    // absent from the public turn timeline because no turn owns that boundary
    case 'thread.checkpoint-baseline-recorded':
      return Effect.succeed(nextBase)

    case 'thread.turn-diff-completed':
      return Effect.gen(function* ()
      {
        const payload = yield* decodeForEvent(
          ThreadTurnDiffCompletedPayload,
          event.payload,
          event.type,
          'payload',
        )
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId)
        if (!thread)
        {
          return nextBase
        }

        const checkpoint = yield* decodeForEvent(
          OrchestrationCheckpointSummary,
          {
            turnId: payload.turnId,
            checkpointTurnCount: payload.checkpointTurnCount,
            checkpointRef: payload.checkpointRef,
            status: payload.status,
            files: payload.files,
            assistantMessageId: payload.assistantMessageId,
            completedAt: payload.completedAt,
            checkpointCaptureRoot: payload.checkpointCaptureRoot ?? null,
            checkpointRepositoryCommonDir: payload.checkpointRepositoryCommonDir ?? null,
            checkpointCommitOid: payload.checkpointCommitOid ?? null,
          },
          event.type,
          'checkpoint',
        )

        // do not let a placeholder (status "missing") overwrite a checkpoint
        // that has already been captured with a real git ref (status "ready").
        // ProviderRuntimeIngestion may fire multiple turn.diff.updated events
        // per turn; without this guard later placeholders would clobber the
        // real capture dispatched by CheckpointReactor.
        const existing = thread.checkpoints.find((entry) => entry.turnId === checkpoint.turnId)
        if (existing && existing.status !== 'missing' && checkpoint.status === 'missing')
        {
          return nextBase
        }

        const checkpoints = [
          ...thread.checkpoints.filter((entry) => entry.turnId !== checkpoint.turnId),
          checkpoint,
        ]
          .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)
          .slice(-MAX_THREAD_CHECKPOINTS)

        // mid-turn diff updates produce placeholder checkpoints; record the
        // checkpoint, but don't settle a turn its session is still running.
        const turnStillRunning =
          thread.session?.status === 'running' && thread.session.activeTurnId === payload.turnId

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            checkpoints,
            latestTurn: turnStillRunning
              ? thread.latestTurn
              : {
                  turnId: payload.turnId,
                  state: checkpointStatusToLatestTurnState(payload.status),
                  requestedAt:
                    thread.latestTurn?.turnId === payload.turnId
                      ? thread.latestTurn.requestedAt
                      : payload.completedAt,
                  startedAt:
                    thread.latestTurn?.turnId === payload.turnId
                      ? (thread.latestTurn.startedAt ?? payload.completedAt)
                      : payload.completedAt,
                  completedAt: payload.completedAt,
                  assistantMessageId: payload.assistantMessageId,
                },
            updatedAt: event.occurredAt,
          }),
        }
      })

    case 'thread.reverted':
      return decodeForEvent(ThreadRevertedPayload, event.payload, event.type, 'payload').pipe(
        Effect.map((payload) =>
        {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId)
          if (!thread)
          {
            return nextBase
          }

          const checkpoints = thread.checkpoints
            .filter((entry) => entry.checkpointTurnCount <= payload.turnCount)
            .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)
            .slice(-MAX_THREAD_CHECKPOINTS)
          const retainedTurnIds = new Set(checkpoints.map((checkpoint) => checkpoint.turnId))
          const messages = retainThreadMessagesAfterRevert(
            thread.messages,
            retainedTurnIds,
            payload.turnCount,
          ).slice(-MAX_THREAD_MESSAGES)
          const proposedPlans = retainThreadProposedPlansAfterRevert(
            thread.proposedPlans,
            retainedTurnIds,
          ).slice(-200)
          const orchestratePlans = retainThreadOrchestratePlansAfterRevert(
            thread.orchestratePlans,
            retainedTurnIds,
          ).slice(-200)
          const activities = retainThreadActivitiesAfterRevert(thread.activities, retainedTurnIds)

          const latestCheckpoint = checkpoints.at(-1) ?? null
          const latestTurn =
            latestCheckpoint === null
              ? null
              : {
                  turnId: latestCheckpoint.turnId,
                  state: checkpointStatusToLatestTurnState(latestCheckpoint.status),
                  requestedAt: latestCheckpoint.completedAt,
                  startedAt: latestCheckpoint.completedAt,
                  completedAt: latestCheckpoint.completedAt,
                  assistantMessageId: latestCheckpoint.assistantMessageId,
                }

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              checkpoints,
              messages,
              proposedPlans,
              orchestratePlans,
              activities,
              latestTurn,
              updatedAt: event.occurredAt,
            }),
          }
        }),
      )

    case 'thread.activity-appended':
      return decodeForEvent(
        ThreadActivityAppendedPayload,
        event.payload,
        event.type,
        'payload',
      ).pipe(
        Effect.map((payload) =>
        {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId)
          if (!thread)
          {
            return nextBase
          }

          const isProviderSwitchActivity =
            payload.activity.kind === 'provider.switch.failed' ||
            payload.activity.kind === 'provider.switch.completed'
          const activity =
            isProviderSwitchActivity && payload.activity.sequence === undefined
              ? { ...payload.activity, sequence: event.sequence }
              : payload.activity
          const replacedActivityId = isProviderSwitchActivity
            ? thread.activities.findLast(
                (entry) =>
                  event.causationEventId === entry.id ||
                  isAdjacentProviderSwitchActivity(entry, activity),
              )?.id
            : undefined
          const activities = [
            ...thread.activities.filter(
              (entry) => entry.id !== activity.id && entry.id !== replacedActivityId,
            ),
            activity,
          ].toSorted(compareOrchestrationThreadActivities)
          const importFinalized =
            thread.origin !== null &&
            thread.latestTurn === null &&
            isImportContinuationActivity(activity)
          const approvalOutcome = approvalOutcomeFromActivity(activity)

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              activities: importFinalized
                ? compactFinalizedImportActivities(activities)
                : retainThreadActivities(activities),
              pendingHandoff:
                activity.kind === 'provider.handoff.delivered' ? null : thread.pendingHandoff,
              ...(approvalOutcome === null
                ? {}
                : {
                    approvalOutcomes: upsertApprovalOutcome(
                      thread.approvalOutcomes,
                      approvalOutcome,
                    ),
                  }),
              ...(importFinalized
                ? {
                    messages: [],
                    checkpoints: [],
                  }
                : {}),
              updatedAt: event.occurredAt,
            }),
          }
        }),
      )

    case 'thread.approval-response-requested':
      return decodeForEvent(
        ThreadApprovalResponseRequestedPayload,
        event.payload,
        event.type,
        'payload',
      ).pipe(
        Effect.map((payload) =>
        {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId)
          if (!thread)
          {
            return nextBase
          }
          const outcome = payload.approvalOutcome ?? {
            requestId: payload.requestId,
            status: 'responding' as const,
            requestedDecision: payload.decision,
            updatedAt: payload.createdAt,
          }
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              approvalOutcomes: upsertApprovalOutcome(thread.approvalOutcomes, outcome),
              updatedAt: event.occurredAt,
            }),
          }
        }),
      )

    default:
      return Effect.succeed(nextBase)
  }
}
