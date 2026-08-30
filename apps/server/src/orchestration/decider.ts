// apps/server/src/orchestration/decider.ts
// validates orchestration commands and produces domain events

import {
  EventId,
  normalizeCollaborationMode,
  type OrchestrateRunExecution,
  type OrchestrateRunExecutionJob,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type ThreadOrchestratePlanResponseRequestedPayload,
  type ThreadImportContinuationActivityPayload as ThreadImportContinuationActivityPayloadType,
  ThreadImportContinuationActivityPayload,
  WORKER_VERDICT_ACTIVITY_KIND,
  WORKER_VERDICT_MAX_LENGTH,
} from '@t3tools/contracts'
import { classifyApprovalFailure } from '@t3tools/shared/approvalOutcomeClassifier'
import * as DateTime from 'effect/DateTime'
import * as Crypto from 'effect/Crypto'
import * as Effect from 'effect/Effect'
import type * as PlatformError from 'effect/PlatformError'
import * as Schema from 'effect/Schema'

import { OrchestrationCommandInvariantError } from './Errors.ts'
import {
  listThreadsByProjectId,
  requireActiveThread,
  requireActiveProjectWorkspaceRootAbsent,
  requireActiveProject,
  requireProject,
  requireProjectAbsent,
  requireThread,
  requireThreadArchived,
  requireThreadAbsent,
  requireThreadNotArchived,
} from './commandInvariants.ts'
import {
  isBlockingRequestActivityKind,
  isBlockingRequestFailureActivityKind,
  isBlockingRequestResolutionActivityKind,
  isImportContinuationActivityPayload,
} from './activityPolicy.ts'
import { projectEvent } from './projector.ts'

const nowIso = Effect.map(DateTime.now, DateTime.formatIso)

function sameRunExecutionJob(
  left: OrchestrateRunExecutionJob,
  right: OrchestrateRunExecutionJob,
): boolean
{
  return (
    left.jobId === right.jobId &&
    left.status === right.status &&
    left.requestRunId === right.requestRunId &&
    left.requestRepositoryRoot === right.requestRepositoryRoot &&
    left.resultRepositoryRoot === right.resultRepositoryRoot &&
    left.repositoryCommonDir === right.repositoryCommonDir &&
    left.baseOid === right.baseOid &&
    left.headOid === right.headOid &&
    left.worktreeRoot === right.worktreeRoot &&
    left.branch === right.branch &&
    left.boundAt === right.boundAt
  )
}

function canonicalRunExecutionJobs(
  jobs: ReadonlyArray<OrchestrateRunExecutionJob>,
): Array<OrchestrateRunExecutionJob>
{
  return [...jobs].toSorted((left, right) =>
    left.jobId < right.jobId ? -1 : left.jobId > right.jobId ? 1 : 0,
  )
}

function sameRunExecutionJobs(
  left: ReadonlyArray<OrchestrateRunExecutionJob>,
  right: ReadonlyArray<OrchestrateRunExecutionJob>,
): boolean
{
  if (left.length !== right.length)
  {
    return false
  }
  const canonicalLeft = canonicalRunExecutionJobs(left)
  const canonicalRight = canonicalRunExecutionJobs(right)
  return canonicalLeft.every((job, index) =>
  {
    const candidate = canonicalRight[index]
    return candidate !== undefined && sameRunExecutionJob(job, candidate)
  })
}

function isTerminalAvailabilityTransition(
  current: OrchestrateRunExecution,
  next: OrchestrateRunExecution,
  updatedAt: string,
): boolean
{
  return (
    current.lifecycle !== 'active' &&
    ((current.availability === 'available' && next.availability === 'unavailable') ||
      (current.availability === 'unavailable' && next.availability === 'available')) &&
    next.threadId === current.threadId &&
    next.runId === current.runId &&
    next.planRevision === current.planRevision &&
    next.sourceTurnId === current.sourceTurnId &&
    next.sourceSequence === current.sourceSequence &&
    next.repositoryRoot === current.repositoryRoot &&
    next.repositoryCommonDir === current.repositoryCommonDir &&
    next.baseOid === current.baseOid &&
    next.lifecycle === current.lifecycle &&
    next.integrationRoot === current.integrationRoot &&
    next.integrationCommonDir === current.integrationCommonDir &&
    next.integrationBranch === current.integrationBranch &&
    next.integrationOid === current.integrationOid &&
    next.observedHeadOid === current.observedHeadOid &&
    next.finalHeadOid === current.finalHeadOid &&
    next.closeReason === current.closeReason &&
    next.current === current.current &&
    next.admittedAt === current.admittedAt &&
    next.updatedAt === updatedAt &&
    next.terminalAt === current.terminalAt &&
    sameRunExecutionJobs(next.jobs, current.jobs)
  )
}

function hasSerializedExecutionAuthority(
  thread: OrchestrationThread,
  execution: Pick<OrchestrateRunExecution, 'sourceTurnId'>,
  expectedProviderInstanceId: OrchestrationThread['modelSelection']['instanceId'] | null,
): boolean
{
  return (
    expectedProviderInstanceId !== null &&
    thread.deletedAt === null &&
    thread.archivedAt === null &&
    thread.session?.status === 'running' &&
    thread.session.providerInstanceId === expectedProviderInstanceId &&
    thread.session.providerInstanceId === thread.modelSelection.instanceId &&
    thread.session.activeTurnId === execution.sourceTurnId &&
    thread.latestTurn?.state === 'running' &&
    thread.latestTurn.turnId === execution.sourceTurnId &&
    normalizeCollaborationMode(thread.interactionMode, thread.orchestrate).orchestrate
  )
}

export type ThreadOrchestratePlanUpsertCommand = Extract<
  OrchestrationCommand,
  { readonly type: 'thread.orchestrate-plan.upsert' }
>
export type ThreadOrchestrateRunExecutionAdmitCommand = Extract<
  OrchestrationCommand,
  { readonly type: 'thread.orchestrate-run-execution.admit' }
>
export type ThreadOrchestrateRunExecutionUpdateCommand = Extract<
  OrchestrationCommand,
  { readonly type: 'thread.orchestrate-run-execution.update' }
>

// session adoption takes seconds; a user message still unadopted after this
// window is a failed/stale start, not pending work. Mirrors the client's
// QUEUED_TURN_START_GRACE_MS in client-runtime threadSettled.ts.
const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000
const isThreadImportContinuationActivityPayload = Schema.is(ThreadImportContinuationActivityPayload)

function providerSwitchRequestMatches(
  providerSwitch: OrchestrationThread['providerSwitch'],
  requestId: EventId | undefined,
  expectedRequestedAt: string | undefined,
): boolean
{
  if (providerSwitch === null)
  {
    return false
  }
  return requestId !== undefined
    ? providerSwitch.requestId === requestId
    : expectedRequestedAt !== undefined && providerSwitch.requestedAt === expectedRequestedAt
}

type LatestImportContinuationActivity =
  | { readonly state: 'missing' | 'invalid' }
  | {
      readonly state: 'valid'
      readonly activityId: EventId
      readonly payload: ThreadImportContinuationActivityPayloadType
    }

function latestImportContinuationActivity(
  thread: Pick<OrchestrationThread, 'activities'>,
): LatestImportContinuationActivity
{
  for (let index = thread.activities.length - 1; index >= 0; index -= 1)
  {
    const activity = thread.activities[index]
    if (!activity || !isImportContinuationActivityPayload(activity.payload))
    {
      continue
    }
    return isThreadImportContinuationActivityPayload(activity.payload)
      ? {
          state: 'valid',
          activityId: activity.id,
          payload: activity.payload,
        }
      : { state: 'invalid' }
  }
  return { state: 'missing' }
}

function importContinuationConsentMatches(
  command: Extract<OrchestrationCommand, { readonly type: 'thread.turn.start' }>,
  thread: OrchestrationThread,
): boolean
{
  const origin = thread.origin
  const consent = command.importContinuationConsent
  if (origin === null || consent === undefined)
  {
    return false
  }
  const marker = latestImportContinuationActivity(thread)
  if (marker.state !== 'valid')
  {
    return false
  }
  const expected = marker.payload.continuation
  const expectedIdentity = expected.continuationIdentity
  const consentIdentity = consent.continuation.continuationIdentity
  const effectiveProviderInstanceId =
    command.modelSelection?.instanceId ?? thread.modelSelection.instanceId
  return (
    expectedIdentity !== null &&
    consentIdentity !== null &&
    consent.originContentHash === origin.contentHash &&
    consent.activityId === marker.activityId &&
    consent.driverKind === marker.payload.driverKind &&
    expectedIdentity.driverKind === marker.payload.driverKind &&
    consent.targetProviderInstanceId === effectiveProviderInstanceId &&
    consent.targetProviderInstanceId === expected.providerInstanceId &&
    consent.continuation.state === expected.state &&
    consent.continuation.providerInstanceId === expected.providerInstanceId &&
    consentIdentity.driverKind === expectedIdentity.driverKind &&
    consentIdentity.continuationKey === expectedIdentity.continuationKey &&
    consent.continuation.reason === expected.reason
  )
}

// blocked-on-you work derived from the thread's retained activities: an
// approval or user-input request with no later resolution for the same
// requestId. The server-side twin of the shell's hasPendingApprovals /
// hasPendingUserInput flags, which the decider read model does not carry.
// the clearing rules MUST match ProjectionPipeline's pending accounting;
// classifyApprovalFailure is the shared source of truth for failures.

// scans the read model's activities, which the projector caps at the most
// recent 500. That bound is safe here: an OPEN approval/user-input request
// blocks its turn, so the thread cannot accumulate hundreds of later
// activities while one is outstanding — a request that has scrolled out of
// the window is one whose turn kept running, i.e. it was resolved or went
// stale. (The projection pipeline's pendingApprovalCount reads the same
// capped stream and stays consistent with this view.)
function hasOpenBlockingRequest(thread: {
  readonly activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>
}): boolean
{
  const openRequestIds = new Set<string>()
  for (const activity of thread.activities)
  {
    const payload =
      typeof activity.payload === 'object' && activity.payload !== null
        ? (activity.payload as Record<string, unknown>)
        : null
    const requestId = typeof payload?.requestId === 'string' ? payload.requestId : null
    if (requestId === null) continue
    if (isBlockingRequestActivityKind(activity.kind))
    {
      openRequestIds.add(requestId)
    }
    else if (isBlockingRequestResolutionActivityKind(activity.kind))
    {
      openRequestIds.delete(requestId)
    }
    else if (
      isBlockingRequestFailureActivityKind(activity.kind) &&
      classifyApprovalFailure(payload).clearsBlockingRequest
    )
    {
      openRequestIds.delete(requestId)
    }
  }
  return openRequestIds.size > 0
}

// a queued turn start — a user message no turn has picked up yet — is work
// in flight even though session is still null (turn.start emits
// message-sent + turn-start-requested; the session arrives later). Detection
// mirrors the client's hasQueuedTurnStart: the newest user message is
// strictly newer than every latestTurn timestamp (adoption stamps the new
// turn's requestedAt with the message time, clearing this), and only within
// the adoption grace window — historical threads whose last user message
// postdates their turn timestamps (older-server data, mid-turn messages)
// must not be blocked forever. A failed session start (status "error")
// clears the block immediately.
//
// the age check is bounded on BOTH sides: message timestamps are
// client-supplied, so a client clock ahead of the server yields a negative
// age. Without the lower bound that negative age satisfies `<= grace` for
// as long as the skew lasts, extending the block far past the intended two
// minutes.
function threadHasQueuedTurnStart(
  thread: {
    readonly messages: ReadonlyArray<{ readonly role: string; readonly createdAt: string }>
    readonly latestTurn: {
      readonly requestedAt: string
      readonly startedAt: string | null
      readonly completedAt: string | null
    } | null
    readonly session: { readonly status: string } | null
  },
  occurredAt: string,
): boolean
{
  const latestUserMessageAtMs = thread.messages.reduce(
    (latest, message) =>
      message.role === 'user' ? Math.max(latest, Date.parse(message.createdAt)) : latest,
    Number.NEGATIVE_INFINITY,
  )
  const latestTurnAtMs =
    thread.latestTurn === null
      ? Number.NEGATIVE_INFINITY
      : Math.max(
          ...[
            thread.latestTurn.requestedAt,
            thread.latestTurn.startedAt,
            thread.latestTurn.completedAt,
          ].map((candidate) =>
            candidate == null ? Number.NEGATIVE_INFINITY : Date.parse(candidate),
          ),
        )
  const queuedAgeMs = Date.parse(occurredAt) - latestUserMessageAtMs
  return (
    thread.session?.status !== 'error' &&
    Number.isFinite(latestUserMessageAtMs) &&
    latestUserMessageAtMs > latestTurnAtMs &&
    Math.abs(queuedAgeMs) <= QUEUED_TURN_START_GRACE_MS
  )
}

function withEventBase(
  input: Pick<OrchestrationCommand, 'commandId'> & {
    readonly aggregateKind: OrchestrationEvent['aggregateKind']
    readonly aggregateId: OrchestrationEvent['aggregateId']
    readonly occurredAt: string
    readonly metadata?: OrchestrationEvent['metadata']
  },
): Effect.Effect<
  Omit<OrchestrationEvent, 'sequence' | 'type' | 'payload'>,
  PlatformError.PlatformError,
  Crypto.Crypto
>
{
  return Crypto.Crypto.pipe(
    Effect.flatMap((crypto) =>
      crypto.randomUUIDv4.pipe(
        Effect.map((eventId) => ({
          eventId: EventId.make(eventId),
          aggregateKind: input.aggregateKind,
          aggregateId: input.aggregateId,
          occurredAt: input.occurredAt,
          commandId: input.commandId,
          causationEventId: null,
          correlationId: input.commandId,
          metadata: input.metadata ?? {},
        })),
      ),
    ),
  )
}

const terminalizeActiveExecutions = Effect.fn('terminalizeActiveOrchestrateExecutions')(
  function* (input: {
    readonly readModel: OrchestrationReadModel
    readonly command: Pick<OrchestrationCommand, 'commandId'>
    readonly threadId: OrchestrationThread['id']
    readonly occurredAt: string
    readonly reason: string
    readonly shouldClose?: (execution: OrchestrateRunExecution) => boolean
  })
  {
    const executions = (input.readModel.orchestrateRunExecutions ?? []).filter(
      (execution) =>
        execution.threadId === input.threadId &&
        execution.lifecycle === 'active' &&
        (input.shouldClose?.(execution) ?? true),
    )
    return yield* Effect.forEach(
      executions,
      (execution) =>
        withEventBase({
          aggregateKind: 'thread',
          aggregateId: input.threadId,
          occurredAt: input.occurredAt,
          commandId: input.command.commandId,
        }).pipe(
          Effect.map((base) => ({
            ...base,
            type: 'thread.orchestrate-run-execution-updated' as const,
            payload: {
              execution: {
                ...execution,
                lifecycle: 'cancelled' as const,
                finalHeadOid: execution.observedHeadOid,
                closeReason: input.reason,
                updatedAt: input.occurredAt,
                terminalAt: input.occurredAt,
                jobs: canonicalRunExecutionJobs(execution.jobs),
              },
            },
          })),
        ),
      { concurrency: 1 },
    )
  },
)

type PlannedOrchestrationEvent = Omit<OrchestrationEvent, 'sequence'>

type DecideOrchestrationCommandResult =
  PlannedOrchestrationEvent | ReadonlyArray<PlannedOrchestrationEvent>

const decideCommandSequence = Effect.fn('decideCommandSequence')(function* ({
  commands,
  readModel,
}: {
  readonly commands: ReadonlyArray<OrchestrationCommand>
  readonly readModel: OrchestrationReadModel
}): Effect.fn.Return<
  ReadonlyArray<PlannedOrchestrationEvent>,
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
>
{
  let nextReadModel = readModel
  let nextSequence = readModel.snapshotSequence
  const plannedEvents: PlannedOrchestrationEvent[] = []

  for (const nextCommand of commands)
  {
    const decided = yield* decideOrchestrationCommand({
      command: nextCommand,
      readModel: nextReadModel,
    })
    const nextEvents = Array.isArray(decided) ? decided : [decided]
    for (const nextEvent of nextEvents)
    {
      plannedEvents.push(nextEvent)
      nextSequence += 1
      nextReadModel = yield* projectEvent(nextReadModel, {
        ...nextEvent,
        sequence: nextSequence,
      }).pipe(Effect.orDie)
    }
  }

  return plannedEvents
})

export const decideOrchestrationCommand = Effect.fn('decideOrchestrationCommand')(function* ({
  command,
  readModel,
}: {
  readonly command: OrchestrationCommand
  readonly readModel: OrchestrationReadModel
}): Effect.fn.Return<
  DecideOrchestrationCommandResult,
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
>
{
  switch (command.type)
  {
    case 'project.create':
    {
      yield* requireProjectAbsent({
        readModel,
        command,
        projectId: command.projectId,
      })
      yield* requireActiveProjectWorkspaceRootAbsent({
        readModel,
        command,
        workspaceRoot: command.workspaceRoot,
        exceptProjectId: command.projectId,
      })

      return {
        ...(yield* withEventBase({
          aggregateKind: 'project',
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: 'project.created',
        payload: {
          projectId: command.projectId,
          title: command.title,
          workspaceRoot: command.workspaceRoot,
          defaultModelSelection: command.defaultModelSelection ?? null,
          scripts: [],
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      }
    }

    case 'project.meta.update':
    {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      })
      if (command.workspaceRoot !== undefined)
      {
        yield* requireActiveProjectWorkspaceRootAbsent({
          readModel,
          command,
          workspaceRoot: command.workspaceRoot,
          exceptProjectId: command.projectId,
        })
      }
      const occurredAt = yield* nowIso
      return {
        ...(yield* withEventBase({
          aggregateKind: 'project',
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: 'project.meta-updated',
        payload: {
          projectId: command.projectId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.workspaceRoot !== undefined ? { workspaceRoot: command.workspaceRoot } : {}),
          ...(command.defaultModelSelection !== undefined
            ? { defaultModelSelection: command.defaultModelSelection }
            : {}),
          ...(command.scripts !== undefined ? { scripts: command.scripts } : {}),
          updatedAt: occurredAt,
        },
      }
    }

    case 'project.delete':
    {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      })
      const activeThreads = listThreadsByProjectId(readModel, command.projectId).filter(
        (thread) => thread.deletedAt === null,
      )
      if (activeThreads.length > 0 && command.force !== true)
      {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Project '${command.projectId}' is not empty and cannot be deleted without force=true.`,
        })
      }
      if (activeThreads.length > 0)
      {
        return yield* decideCommandSequence({
          readModel,
          commands: [
            ...activeThreads.map(
              (thread): Extract<OrchestrationCommand, { type: 'thread.delete' }> => ({
                type: 'thread.delete',
                commandId: command.commandId,
                threadId: thread.id,
              }),
            ),
            {
              type: 'project.delete',
              commandId: command.commandId,
              projectId: command.projectId,
            },
          ],
        })
      }

      const occurredAt = yield* nowIso
      return {
        ...(yield* withEventBase({
          aggregateKind: 'project',
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: 'project.deleted' as const,
        payload: {
          projectId: command.projectId,
          deletedAt: occurredAt,
        },
      }
    }

    case 'thread.create':
    {
      yield* requireActiveProject({
        readModel,
        command,
        projectId: command.projectId,
      })
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      })
      return {
        ...(yield* withEventBase({
          aggregateKind: 'thread',
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: 'thread.created',
        payload: {
          threadId: command.threadId,
          projectId: command.projectId,
          title: command.title,
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          ...(command.orchestrate !== undefined ? { orchestrate: command.orchestrate } : {}),
          branch: command.branch,
          worktreePath: command.worktreePath,
          origin: command.origin ?? null,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      }
    }

    case 'thread.delete':
    {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      })
      const occurredAt = yield* nowIso
      const deletedEvent = {
        ...(yield* withEventBase({
          aggregateKind: 'thread',
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: 'thread.deleted',
        payload: {
          threadId: command.threadId,
          deletedAt: occurredAt,
        },
      } satisfies PlannedOrchestrationEvent
      const executionEvents = yield* terminalizeActiveExecutions({
        readModel,
        command,
        threadId: command.threadId,
        occurredAt,
        reason: 'The owning thread was deleted.',
      })
      return [...executionEvents, deletedEvent]
    }

    case 'thread.archive':
    {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      })
      const occurredAt = yield* nowIso
      const archivedEvent = {
        ...(yield* withEventBase({
          aggregateKind: 'thread',
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: 'thread.archived',
        payload: {
          threadId: command.threadId,
          archivedAt: occurredAt,
          archiveGeneration: (thread.archiveGeneration ?? 0) + 1,
          updatedAt: occurredAt,
        },
      } satisfies PlannedOrchestrationEvent
      const executionEvents = yield* terminalizeActiveExecutions({
        readModel,
        command,
        threadId: command.threadId,
        occurredAt,
        reason: 'The owning thread was archived.',
      })
      return [...executionEvents, archivedEvent]
    }

    case 'thread.unarchive':
    {
      yield* requireThreadArchived({
        readModel,
        command,
        threadId: command.threadId,
      })
      const occurredAt = yield* nowIso
      return {
        ...(yield* withEventBase({
          aggregateKind: 'thread',
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: 'thread.unarchived',
        payload: {
          threadId: command.threadId,
          updatedAt: occurredAt,
        },
      }
    }

    case 'thread.settle':
    {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      })
      // server-side twin of the client's canSettle session check: a stale
      // or raced client must not settle a thread whose session is coming
      // alive or working.
      if (thread.session?.status === 'starting' || thread.session?.status === 'running')
      {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} has an active session and cannot be settled`,
          }),
        )
      }
      // pending approval / user-input requests are blocked-on-you work: a
      // raced or stale client must not park them behind a settled override
      // that would surface only after the request resolves.
      if (hasOpenBlockingRequest(thread))
      {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} has a pending approval or user-input request and cannot be settled`,
          }),
        )
      }
      const occurredAt = yield* nowIso
      // settling inside the adoption window would hide just-requested work.
      if (threadHasQueuedTurnStart(thread, occurredAt))
      {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} has a queued turn start and cannot be settled`,
          }),
        )
      }
      // settling an already-settled thread re-emits with the original
      // settledAt: the engine rejects zero-event commands, and bulk-settle /
      // double-click must stay silent no-ops rather than surface errors.
      const alreadySettled = thread.settledOverride === 'settled' && thread.settledAt !== null
      const settledEvent = {
        ...(yield* withEventBase({
          aggregateKind: 'thread',
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: 'thread.settled',
        payload: {
          threadId: command.threadId,
          settledAt: alreadySettled ? thread.settledAt : occurredAt,
          // a re-emission is a projected no-op: keep the existing updatedAt
          // so duplicate settles neither rewind nor churn ordering. A fresh
          // settle stamps the command time.
          updatedAt: alreadySettled ? thread.updatedAt : occurredAt,
        },
      } satisfies PlannedOrchestrationEvent
      const lifecycleEvents: Array<PlannedOrchestrationEvent> = [settledEvent]
      if (thread.snoozedUntil != null)
      {
        // settling is an immediate "done" action, so stale snooze state must
        // not keep the row parked until its former wake time
        lifecycleEvents.push({
          ...(yield* withEventBase({
            aggregateKind: 'thread',
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: 'thread.unsnoozed',
          payload: {
            threadId: command.threadId,
            reason: 'user',
            updatedAt: occurredAt,
          },
        } satisfies PlannedOrchestrationEvent)
      }
      // settling is "I'm done with this": it clears a pin the same way it
      // parks the thread, while retaining the fork's snooze reset above.
      if (thread.pinnedAt != null)
      {
        lifecycleEvents.push({
          ...(yield* withEventBase({
            aggregateKind: 'thread',
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: 'thread.unpinned',
          payload: {
            threadId: command.threadId,
            updatedAt: occurredAt,
          },
        } satisfies PlannedOrchestrationEvent)
      }
      return lifecycleEvents.length === 1 ? settledEvent : lifecycleEvents
    }

    case 'thread.unsettle':
    {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      })
      // idempotent by re-emission (see thread.settle): reducing the event a
      // second time lands on the same override state. A re-emission keeps
      // the existing updatedAt so duplicates do not churn ordering.
      const alreadyPinnedActive = thread.settledOverride === 'active'
      const occurredAt = yield* nowIso
      return {
        ...(yield* withEventBase({
          aggregateKind: 'thread',
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: 'thread.unsettled',
        payload: {
          threadId: command.threadId,
          reason: command.reason,
          updatedAt: alreadyPinnedActive ? thread.updatedAt : occurredAt,
        },
      }
    }

    case 'thread.snooze':
    {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      })
      const occurredAt = yield* nowIso
      // a wake time in the past would create a thread that is snoozed and
      // woken at once — the row would never leave the inbox but still carry
      // snooze state. Reject instead of silently normalizing. The negated
      // comparison also catches unparseable wake times (IsoDateTime is
      // structurally just a string): NaN fails every comparison, and an
      // unparseable snoozedUntil must never persist.
      if (!(Date.parse(command.snoozedUntil) > Date.parse(occurredAt)))
      {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} snooze wake time ${command.snoozedUntil} is not in the future`,
          }),
        )
      }
      // blocked-on-you work must not be snoozed away: a pending approval or
      // user-input request is the agent waiting on the user, and hiding it
      // defeats the request. (A running session IS snoozable — snooze only
      // affects visibility, never the agent.)
      if (hasOpenBlockingRequest(thread))
      {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} has a pending approval or user-input request and cannot be snoozed`,
          }),
        )
      }
      // a queued turn start — a user message no turn has adopted yet — is
      // invisible pending work: no session, no pending flags. Snoozing in
      // that window would hide a just-requested turn exactly the way settle
      // would.
      if (threadHasQueuedTurnStart(thread, occurredAt))
      {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} has a queued turn start and cannot be snoozed`,
          }),
        )
      }
      // re-snoozing an already-snoozed thread to the SAME wake time is a
      // duplicate (double-click, raced clients): re-emit with the original
      // timestamps so the projection is a no-op. A different wake time is a
      // real change and stamps fresh.
      const existingSnoozedAt =
        thread.snoozedUntil === command.snoozedUntil && thread.snoozedAt != null
          ? thread.snoozedAt
          : null
      return {
        ...(yield* withEventBase({
          aggregateKind: 'thread',
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: 'thread.snoozed',
        payload: {
          threadId: command.threadId,
          snoozedUntil: command.snoozedUntil,
          snoozedAt: existingSnoozedAt ?? occurredAt,
          updatedAt: existingSnoozedAt !== null ? thread.updatedAt : occurredAt,
        },
      }
    }

    case 'thread.unsnooze':
    {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      })
      // idempotent by re-emission (see thread.settle): waking a thread that
      // is not snoozed lands on the same null state without churning
      // updatedAt.
      const alreadyAwake = thread.snoozedUntil == null
      const occurredAt = yield* nowIso
      return {
        ...(yield* withEventBase({
          aggregateKind: 'thread',
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: 'thread.unsnoozed',
        payload: {
          threadId: command.threadId,
          reason: command.reason,
          updatedAt: alreadyAwake ? thread.updatedAt : occurredAt,
        },
      }
    }

    case 'thread.pin':
    {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      })
      const occurredAt = yield* nowIso
      // duplicate pins preserve projection ordering by retaining the original
      // pin and update timestamps.
      const existingPinnedAt = thread.pinnedAt ?? null
      const pinnedEvent = {
        ...(yield* withEventBase({
          aggregateKind: 'thread',
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: 'thread.pinned',
        payload: {
          threadId: command.threadId,
          pinnedAt: existingPinnedAt ?? occurredAt,
          updatedAt: existingPinnedAt !== null ? thread.updatedAt : occurredAt,
        },
      } satisfies PlannedOrchestrationEvent
      // duplicate pins must not wake a thread parked after its original pin.
      if (existingPinnedAt !== null) return pinnedEvent

      // fresh pins explicitly wake client-derived settlement too; real
      // activity later clears the active override through the existing path.
      const promotionEvents: Array<PlannedOrchestrationEvent> = [
        {
          ...(yield* withEventBase({
            aggregateKind: 'thread',
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: 'thread.unsettled',
          payload: {
            threadId: command.threadId,
            reason: 'user',
            updatedAt: occurredAt,
          },
        } satisfies PlannedOrchestrationEvent,
      ]
      if (thread.snoozedUntil != null)
      {
        promotionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: 'thread',
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: 'thread.unsnoozed',
          payload: {
            threadId: command.threadId,
            reason: 'user',
            updatedAt: occurredAt,
          },
        } satisfies PlannedOrchestrationEvent)
      }
      return [pinnedEvent, ...promotionEvents]
    }

    case 'thread.unpin':
    {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      })
      // duplicate unpins re-emit the null state without churning ordering.
      const alreadyUnpinned = thread.pinnedAt == null
      const occurredAt = yield* nowIso
      return {
        ...(yield* withEventBase({
          aggregateKind: 'thread',
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: 'thread.unpinned',
        payload: {
          threadId: command.threadId,
          updatedAt: alreadyUnpinned ? thread.updatedAt : occurredAt,
        },
      }
    }

    case 'thread.meta.update':
    {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      })
      // cross-instance rebinding of a started thread must go through
      // thread.provider.switch so the handoff workflow runs; meta updates
      // may still change the model within the bound instance
      const threadStarted =
        thread.session !== null || thread.latestTurn !== null || thread.messages.length > 0
      if (
        command.modelSelection !== undefined &&
        command.modelSelection.instanceId !== thread.modelSelection.instanceId &&
        threadStarted
      )
      {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' is bound to provider instance '${thread.modelSelection.instanceId}'. Use thread.provider.switch to change providers on a started thread.`,
        })
      }
      const branch =
        command.branch !== undefined &&
        command.expectedBranch !== undefined &&
        thread.branch !== command.expectedBranch
          ? thread.branch
          : command.branch
      const occurredAt = yield* nowIso
      return {
        ...(yield* withEventBase({
          aggregateKind: 'thread',
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: 'thread.meta-updated',
        payload: {
          threadId: command.threadId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(branch !== undefined ? { branch } : {}),
          ...(command.worktreePath !== undefined ? { worktreePath: command.worktreePath } : {}),
          updatedAt: occurredAt,
        },
      }
    }

    case 'thread.orchestrate-run-integration.set':
    {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      })
      return {
        ...(yield* withEventBase({
          aggregateKind: 'thread',
          aggregateId: command.threadId,
          occurredAt: yield* nowIso,
          commandId: command.commandId,
        })),
        type: 'thread.orchestrate-run-integration-set',
        payload: {
          threadId: command.threadId,
          worktreePath: command.worktreePath,
          branch: command.branch,
        },
      }
    }

    case 'thread.orchestrate-run-execution.admit':
    {
      const execution = command.execution
      if (command.threadId !== execution.threadId)
      {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          code: 'orchestrate-execution-plan-mismatch',
          detail: 'The command thread does not match the captured execution identity.',
        })
      }
      const thread = yield* requireActiveThread({
        readModel,
        command,
        threadId: execution.threadId,
      })
      if (!hasSerializedExecutionAuthority(thread, execution, command.expectedProviderInstanceId))
      {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          code: 'orchestrate-execution-authority-expired',
          detail:
            `Execution '${execution.runId}/${execution.planRevision}' no longer has the exact ` +
            `live provider and turn authority for '${execution.sourceTurnId}'.`,
        })
      }
      const plan = thread.orchestratePlans.find(
        (entry) => entry.runId === execution.runId && entry.revision === execution.planRevision,
      )
      if (
        plan === undefined ||
        plan.status !== 'approved' ||
        plan.turnId === null ||
        plan.turnId !== execution.sourceTurnId ||
        plan.sourceSequence === undefined ||
        plan.sourceSequence !== execution.sourceSequence
      )
      {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          code: 'orchestrate-execution-plan-mismatch',
          detail:
            `Execution '${execution.runId}/${execution.planRevision}' does not name the exact ` +
            `approved plan event owned by turn '${execution.sourceTurnId}'.`,
        })
      }
      const existingRunExecutions = (readModel.orchestrateRunExecutions ?? []).filter(
        (entry) => entry.threadId === execution.threadId && entry.runId === execution.runId,
      )
      if (existingRunExecutions.some((entry) => entry.planRevision === execution.planRevision))
      {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          code: 'orchestrate-execution-duplicate',
          detail:
            `Execution '${execution.runId}/${execution.planRevision}' already exists; ` +
            'retry requires a new approved plan revision.',
        })
      }
      if (existingRunExecutions.some((entry) => entry.planRevision > execution.planRevision))
      {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          code: 'orchestrate-execution-stale-revision',
          detail:
            `Execution '${execution.runId}/${execution.planRevision}' is older than an existing ` +
            'authoritative execution; retry requires a newly approved higher revision.',
        })
      }
      if (
        execution.lifecycle !== 'active' ||
        execution.availability !== 'unavailable' ||
        execution.integrationRoot !== null ||
        execution.integrationCommonDir !== null ||
        execution.integrationBranch !== null ||
        execution.integrationOid !== null ||
        execution.observedHeadOid !== null ||
        execution.finalHeadOid !== null ||
        execution.closeReason !== null ||
        execution.terminalAt !== null ||
        !execution.current ||
        execution.jobs.length !== 0
      )
      {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          code: 'orchestrate-execution-invalid-admission',
          detail:
            'A new execution must be active, current, unavailable, and contain no result evidence.',
        })
      }

      const events: PlannedOrchestrationEvent[] = []
      const currentExecution = (readModel.orchestrateRunExecutions ?? []).find(
        (entry) => entry.threadId === execution.threadId && entry.current,
      )
      if (currentExecution !== undefined)
      {
        const retired =
          currentExecution.lifecycle === 'active'
            ? {
                ...currentExecution,
                lifecycle: 'superseded' as const,
                current: false,
                finalHeadOid: currentExecution.observedHeadOid,
                closeReason: `Superseded by ${execution.runId}/${execution.planRevision}.`,
                updatedAt: command.createdAt,
                terminalAt: command.createdAt,
                jobs: canonicalRunExecutionJobs(currentExecution.jobs),
              }
            : {
                ...currentExecution,
                current: false,
                updatedAt: command.createdAt,
                jobs: canonicalRunExecutionJobs(currentExecution.jobs),
              }
        events.push({
          ...(yield* withEventBase({
            aggregateKind: 'thread',
            aggregateId: execution.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: 'thread.orchestrate-run-execution-updated',
          payload: { execution: retired },
        })
      }
      events.push({
        ...(yield* withEventBase({
          aggregateKind: 'thread',
          aggregateId: execution.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: 'thread.orchestrate-run-execution-admitted',
        payload: { execution },
      })
      return events
    }

    case 'thread.orchestrate-run-execution.update':
    {
      const nextExecution = {
        ...command.execution,
        jobs: canonicalRunExecutionJobs(command.execution.jobs),
      }
      if (command.threadId !== nextExecution.threadId)
      {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          code: 'orchestrate-execution-identity-mutation',
          detail: 'The command thread does not match the captured execution identity.',
        })
      }
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: nextExecution.threadId,
      })
      const currentExecution = (readModel.orchestrateRunExecutions ?? []).find(
        (entry) =>
          entry.threadId === nextExecution.threadId &&
          entry.runId === nextExecution.runId &&
          entry.planRevision === nextExecution.planRevision,
      )
      if (currentExecution === undefined)
      {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          code: 'orchestrate-execution-not-current',
          detail: `Execution '${nextExecution.runId}/${nextExecution.planRevision}' is not current.`,
        })
      }
      const terminalAvailabilityTransition = isTerminalAvailabilityTransition(
        currentExecution,
        nextExecution,
        command.createdAt,
      )
      if (!currentExecution.current && !terminalAvailabilityTransition)
      {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          code: 'orchestrate-execution-not-current',
          detail: `Execution '${nextExecution.runId}/${nextExecution.planRevision}' is not current.`,
        })
      }
      if (currentExecution.lifecycle !== 'active')
      {
        if (!terminalAvailabilityTransition)
        {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            code: 'orchestrate-execution-terminal',
            detail: `Execution '${nextExecution.runId}/${nextExecution.planRevision}' is already terminal.`,
          })
        }
        return {
          ...(yield* withEventBase({
            aggregateKind: 'thread',
            aggregateId: nextExecution.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: 'thread.orchestrate-run-execution-updated',
          payload: { execution: nextExecution },
        }
      }
      if (
        !hasSerializedExecutionAuthority(
          thread,
          currentExecution,
          command.expectedProviderInstanceId,
        )
      )
      {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          code: 'orchestrate-execution-authority-expired',
          detail:
            `Execution '${nextExecution.runId}/${nextExecution.planRevision}' no longer has the ` +
            `exact live provider and turn authority for '${currentExecution.sourceTurnId}'.`,
        })
      }
      if (
        nextExecution.threadId !== currentExecution.threadId ||
        nextExecution.runId !== currentExecution.runId ||
        nextExecution.planRevision !== currentExecution.planRevision ||
        nextExecution.sourceTurnId !== currentExecution.sourceTurnId ||
        nextExecution.sourceSequence !== currentExecution.sourceSequence ||
        nextExecution.repositoryRoot !== currentExecution.repositoryRoot ||
        nextExecution.repositoryCommonDir !== currentExecution.repositoryCommonDir ||
        nextExecution.baseOid !== currentExecution.baseOid ||
        nextExecution.admittedAt !== currentExecution.admittedAt ||
        !nextExecution.current
      )
      {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          code: 'orchestrate-execution-identity-mutation',
          detail: 'An execution update cannot rewrite captured source or repository identity.',
        })
      }
      const terminal = nextExecution.lifecycle !== 'active'
      if (
        (terminal && nextExecution.terminalAt === null) ||
        (!terminal && (nextExecution.terminalAt !== null || nextExecution.finalHeadOid !== null)) ||
        (terminal && nextExecution.finalHeadOid !== nextExecution.observedHeadOid) ||
        (nextExecution.lifecycle === 'completed' && nextExecution.finalHeadOid === null) ||
        (nextExecution.availability === 'available' &&
          (nextExecution.integrationRoot === null ||
            nextExecution.integrationCommonDir !== currentExecution.repositoryCommonDir ||
            nextExecution.integrationOid === null ||
            nextExecution.integrationOid !== nextExecution.observedHeadOid))
      )
      {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          code: 'orchestrate-execution-invalid-transition',
          detail: 'Execution lifecycle, availability, integration target, and final OID disagree.',
        })
      }

      const existingJobs = new Map(currentExecution.jobs.map((job) => [job.jobId, job]))
      if (new Set(nextExecution.jobs.map((job) => job.jobId)).size !== nextExecution.jobs.length)
      {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          code: 'orchestrate-execution-job-mutation',
          detail: 'An execution cannot contain duplicate broker job evidence.',
        })
      }
      for (const job of nextExecution.jobs)
      {
        const previous = existingJobs.get(job.jobId)
        if (previous !== undefined && !sameRunExecutionJob(previous, job))
        {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            code: 'orchestrate-execution-job-mutation',
            detail: `Broker job '${job.jobId}' evidence cannot be rewritten.`,
          })
        }
        const conflictingExecution = (readModel.orchestrateRunExecutions ?? []).find(
          (entry) =>
            (entry.threadId !== nextExecution.threadId ||
              entry.runId !== nextExecution.runId ||
              entry.planRevision !== nextExecution.planRevision) &&
            entry.jobs.some((bound) => bound.jobId === job.jobId),
        )
        if (conflictingExecution !== undefined)
        {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            code: 'orchestrate-execution-job-already-bound',
            detail:
              `Broker job '${job.jobId}' is already bound to ` +
              `'${conflictingExecution.runId}/${conflictingExecution.planRevision}'.`,
          })
        }
      }
      if (
        [...existingJobs.keys()].some(
          (jobId) => !nextExecution.jobs.some((job) => job.jobId === jobId),
        )
      )
      {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          code: 'orchestrate-execution-job-removal',
          detail: 'An execution update cannot remove immutable broker job evidence.',
        })
      }

      return {
        ...(yield* withEventBase({
          aggregateKind: 'thread',
          aggregateId: nextExecution.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: 'thread.orchestrate-run-execution-updated',
        payload: { execution: nextExecution },
      }
    }

    case 'thread.runtime-mode.set':
    {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      })
      const occurredAt = yield* nowIso
      return {
        ...(yield* withEventBase({
          aggregateKind: 'thread',
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: 'thread.runtime-mode-set',
        payload: {
          threadId: command.threadId,
          runtimeMode: command.runtimeMode,
          updatedAt: occurredAt,
        },
      }
    }

    case 'thread.interaction-mode.set':
    {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      })
      const occurredAt = yield* nowIso
      return {
        ...(yield* withEventBase({
          aggregateKind: 'thread',
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: 'thread.interaction-mode-set',
        payload: {
          threadId: command.threadId,
          interactionMode: command.interactionMode,
          ...(command.orchestrate !== undefined ? { orchestrate: command.orchestrate } : {}),
          updatedAt: occurredAt,
        },
      }
    }

    case 'thread.worker-verdict.set':
    {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      })
      const runId = command.runId.trim()
      const jobId = command.jobId.trim()
      const verdict = command.verdict.trim()
      if (runId.length === 0 || jobId.length === 0)
      {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: 'Worker verdict run and job ids must be non-empty.',
          }),
        )
      }
      if (verdict.length > WORKER_VERDICT_MAX_LENGTH)
      {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Worker verdict must be at most ${WORKER_VERDICT_MAX_LENGTH} characters.`,
          }),
        )
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: 'thread',
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: 'thread.activity-appended',
        payload: {
          threadId: command.threadId,
          activity: {
            id: EventId.make(
              `worker-verdict:${encodeURIComponent(runId)}:${encodeURIComponent(jobId)}`,
            ),
            tone: 'info',
            kind: WORKER_VERDICT_ACTIVITY_KIND,
            summary: 'Worker verdict',
            payload: { runId, jobId, verdict },
            turnId: null,
            createdAt: command.createdAt,
          },
        },
      }
    }

    case 'thread.provider.switch':
    {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      })
      if (thread.providerSwitch !== null)
      {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          code: 'switch-in-progress',
          detail: `Thread '${command.threadId}' already has a provider switch in progress.`,
        })
      }
      if (command.expectedCurrentInstanceId !== thread.modelSelection.instanceId)
      {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          code: 'switch-instance-mismatch',
          detail: `Thread '${command.threadId}' is bound to provider instance '${thread.modelSelection.instanceId}', not expected instance '${command.expectedCurrentInstanceId}'.`,
        })
      }
      if (command.targetModelSelection.instanceId === thread.modelSelection.instanceId)
      {
        // same-instance model changes use thread.meta.update; routing the
        // switch workflow at the same instance would reuse the persisted
        // resume cursor and double-inject context alongside the handoff
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          code: 'switch-same-instance',
          detail: `Thread '${command.threadId}' is already bound to provider instance '${thread.modelSelection.instanceId}'; provider switch requires a different instance.`,
        })
      }
      const hasActiveSessionTurn =
        (thread.session?.status === 'starting' || thread.session?.status === 'running') &&
        thread.session.activeTurnId !== null
      if (hasActiveSessionTurn || thread.latestTurn?.state === 'running')
      {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          code: 'switch-running-turn',
          detail: `Thread '${command.threadId}' has a running turn and cannot switch providers.`,
        })
      }
      const occurredAtForQueueCheck = yield* nowIso
      if (threadHasQueuedTurnStart(thread, occurredAtForQueueCheck))
      {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          code: 'switch-queued-turn',
          detail: `Thread '${command.threadId}' has a queued turn start and cannot switch providers.`,
        })
      }
      if (hasOpenBlockingRequest(thread))
      {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          code: 'switch-blocking-request',
          detail: `Thread '${command.threadId}' has a pending approval or user-input request and cannot switch providers.`,
        })
      }
      const occurredAt = yield* nowIso
      const eventBase = yield* withEventBase({
        aggregateKind: 'thread',
        aggregateId: command.threadId,
        occurredAt,
        commandId: command.commandId,
      })
      return {
        ...eventBase,
        type: 'thread.provider-switch-requested',
        payload: {
          threadId: command.threadId,
          targetModelSelection: command.targetModelSelection,
          expectedCurrentInstanceId: command.expectedCurrentInstanceId,
          sourceModelSelection: thread.modelSelection,
        },
      }
    }

    case 'thread.turn.start':
    {
      const targetThread = yield* requireActiveThread({
        readModel,
        command,
        threadId: command.threadId,
      })
      if (targetThread.providerSwitch !== null)
      {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          code: 'turn-start-during-switch',
          detail: `Thread '${command.threadId}' cannot start a turn while a provider switch is in progress.`,
        })
      }
      const requiresImportContinuationConsent =
        targetThread.origin !== null && targetThread.latestTurn === null
      if (
        requiresImportContinuationConsent &&
        !importContinuationConsentMatches(command, targetThread)
      )
      {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Imported thread '${command.threadId}' requires consent for its current continuation state before starting its first turn.`,
        })
      }
      const sourceProposedPlan = command.sourceProposedPlan
      const sourceThread = sourceProposedPlan
        ? yield* requireThread({
            readModel,
            command,
            threadId: sourceProposedPlan.threadId,
          })
        : null
      const sourcePlan =
        sourceProposedPlan && sourceThread
          ? sourceThread.proposedPlans.find((entry) => entry.id === sourceProposedPlan.planId)
          : null
      if (sourceProposedPlan && !sourcePlan)
      {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan.planId}' does not exist on thread '${sourceProposedPlan.threadId}'.`,
        })
      }
      if (sourceThread && sourceThread.projectId !== targetThread.projectId)
      {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan?.planId}' belongs to thread '${sourceThread.id}' in a different project.`,
        })
      }
      const userMessageEvent: Omit<OrchestrationEvent, 'sequence'> = {
        ...(yield* withEventBase({
          aggregateKind: 'thread',
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: 'thread.message-sent',
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          role: 'user',
          text: command.message.text,
          attachments: command.message.attachments,
          turnId: null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      }
      const turnStartRequestedEvent: Omit<OrchestrationEvent, 'sequence'> = {
        ...(yield* withEventBase({
          aggregateKind: 'thread',
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        causationEventId: userMessageEvent.eventId,
        type: 'thread.turn-start-requested',
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.titleSeed !== undefined ? { titleSeed: command.titleSeed } : {}),
          runtimeMode: targetThread.runtimeMode,
          runtimeModeAcknowledgements: command.runtimeModeAcknowledgements,
          interactionMode: targetThread.interactionMode,
          ...(command.orchestrate !== undefined || targetThread.orchestrate !== undefined
            ? { orchestrate: command.orchestrate ?? targetThread.orchestrate }
            : {}),
          ...(sourceProposedPlan !== undefined ? { sourceProposedPlan } : {}),
          ...(requiresImportContinuationConsent && command.importContinuationConsent !== undefined
            ? {
                importContinuationAuthority: {
                  driverKind: command.importContinuationConsent.driverKind,
                  targetProviderInstanceId:
                    command.importContinuationConsent.targetProviderInstanceId,
                  continuationIdentity:
                    command.importContinuationConsent.continuation.continuationIdentity,
                },
              }
            : {}),
          createdAt: command.createdAt,
        },
      }
      // real activity resets ANY override: it wakes an explicitly settled
      // thread, and it clears a keep-active pin back to neutral so the
      // thread can auto-settle again after this burst of work goes stale.
      // a snooze clears the same way — sending a message to a snoozed
      // thread is the user re-engaging, so the return ticket is spent.
      const lifecycleResetEvents: Array<Omit<OrchestrationEvent, 'sequence'>> = []
      if (targetThread.settledOverride !== null)
      {
        lifecycleResetEvents.push({
          ...(yield* withEventBase({
            aggregateKind: 'thread',
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: 'thread.unsettled',
          payload: {
            threadId: command.threadId,
            reason: 'activity',
            updatedAt: command.createdAt,
          },
        })
      }
      if (targetThread.snoozedUntil != null)
      {
        lifecycleResetEvents.push({
          ...(yield* withEventBase({
            aggregateKind: 'thread',
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: 'thread.unsnoozed',
          payload: {
            threadId: command.threadId,
            reason: 'activity',
            updatedAt: command.createdAt,
          },
        })
      }
      return [...lifecycleResetEvents, userMessageEvent, turnStartRequestedEvent]
    }

    case 'thread.turn.interrupt':
    {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      })
      return {
        ...(yield* withEventBase({
          aggregateKind: 'thread',
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: 'thread.turn-interrupt-requested',
        payload: {
          threadId: command.threadId,
          ...(command.turnId !== undefined ? { turnId: command.turnId } : {}),
          createdAt: command.createdAt,
        },
      }
    }

    case 'thread.approval.respond':
    {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      })
      return {
        ...(yield* withEventBase({
          aggregateKind: 'thread',
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        })),
        type: 'thread.approval-response-requested',
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          decision: command.decision,
          createdAt: command.createdAt,
          approvalOutcome: {
            requestId: command.requestId,
            status: 'responding',
            requestedDecision: command.decision,
            updatedAt: command.createdAt,
          },
        },
      }
    }

    case 'thread.orchestrate-plan.respond':
    {
      if (command.runId.trim().length === 0)
      {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: 'Orchestrate plan run id must not be empty.',
        })
      }
      if (!Number.isInteger(command.revision) || command.revision < 0)
      {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: 'Orchestrate plan revision must be a non-negative integer.',
        })
      }
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      })
      const runPlans = thread.orchestratePlans.filter((plan) => plan.runId === command.runId)
      const targetPlan = runPlans.find((plan) => plan.revision === command.revision)
      if (!targetPlan)
      {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Orchestrate plan '${command.runId}' revision '${command.revision}' does not exist on thread '${command.threadId}'.`,
        })
      }
      const latestRevision = runPlans.reduce(
        (revision, plan) => Math.max(revision, plan.revision),
        command.revision,
      )
      if (command.revision !== latestRevision || targetPlan.status !== 'pending')
      {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Orchestrate plan '${command.runId}' revision '${command.revision}' is stale or no longer pending.`,
        })
      }
      // overrides must target real, distinct stages of the plan they edit
      if (command.stageOverrides !== undefined)
      {
        const stageIds = new Set(targetPlan.stages.map((stage) => stage.id))
        const seen = new Set<string>()
        for (const override of command.stageOverrides)
        {
          if (!stageIds.has(override.stageId) || seen.has(override.stageId))
          {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: `Orchestrate plan stage override '${override.stageId}' is unknown or duplicated for run '${command.runId}'.`,
            })
          }
          seen.add(override.stageId)
        }
      }
      const payload = {
        threadId: command.threadId,
        runId: command.runId,
        revision: command.revision,
        decision: command.decision,
        ...(command.stageOverrides !== undefined ? { stageOverrides: command.stageOverrides } : {}),
        ...(command.maxWorkers !== undefined ? { maxWorkers: command.maxWorkers } : {}),
        ...(command.note !== undefined ? { note: command.note } : {}),
        createdAt: command.createdAt,
      } satisfies ThreadOrchestratePlanResponseRequestedPayload
      return {
        ...(yield* withEventBase({
          aggregateKind: 'thread',
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: 'thread.orchestrate-plan-response-requested',
        payload,
      }
    }

    case 'thread.user-input.respond':
    {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      })
      return {
        ...(yield* withEventBase({
          aggregateKind: 'thread',
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        })),
        type: 'thread.user-input-response-requested',
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          answers: command.answers,
          createdAt: command.createdAt,
        },
      }
    }

    case 'thread.checkpoint.revert':
    {
      const thread = yield* requireActiveThread({
        readModel,
        command,
        threadId: command.threadId,
      })
      if (thread.providerSwitch !== null)
      {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          code: 'checkpoint-revert-provider-switch-in-progress',
          detail: `Thread '${command.threadId}' has a provider switch in progress.`,
        })
      }
      if (
        thread.session?.status === 'starting' ||
        (thread.session !== null && thread.session.activeTurnId !== null) ||
        thread.latestTurn?.state === 'running'
      )
      {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          code: 'checkpoint-revert-turn-in-progress',
          detail: `Thread '${command.threadId}' has an active provider lifecycle or turn.`,
        })
      }
      if (threadHasQueuedTurnStart(thread, command.createdAt))
      {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          code: 'checkpoint-revert-turn-in-progress',
          detail: `Thread '${command.threadId}' has a queued turn start.`,
        })
      }
      if (thread.pendingHandoff !== undefined && thread.pendingHandoff !== null)
      {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          code: 'checkpoint-revert-handoff-in-progress',
          detail: `Thread '${command.threadId}' has a pending provider handoff.`,
        })
      }
      const activeExecution = (readModel.orchestrateRunExecutions ?? []).find(
        (execution) => execution.threadId === command.threadId && execution.lifecycle === 'active',
      )
      if (activeExecution !== undefined)
      {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          code: 'checkpoint-revert-orchestrate-execution-active',
          detail:
            `Thread '${command.threadId}' has active orchestrate execution ` +
            `'${activeExecution.runId}/${activeExecution.planRevision}'.`,
        })
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: 'thread',
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: 'thread.checkpoint-revert-requested',
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
          createdAt: command.createdAt,
        },
      }
    }

    case 'thread.session.stop':
    {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      })
      return {
        ...(yield* withEventBase({
          aggregateKind: 'thread',
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: 'thread.session-stop-requested',
        payload: {
          threadId: command.threadId,
          createdAt: command.createdAt,
        },
      }
    }

    case 'thread.messages.import':
    {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      })
      if (thread.deletedAt !== null)
      {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' is deleted and cannot import messages.`,
        })
      }
      if (thread.origin === null)
      {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' is not imported and cannot import messages.`,
        })
      }
      if (thread.latestTurn !== null)
      {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' has an existing turn and cannot import messages.`,
        })
      }
      if (latestImportContinuationActivity(thread).state !== 'missing')
      {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' has finalized its import and cannot import more messages.`,
        })
      }
      if (command.messages.length === 0 && command.activities.length === 0)
      {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: 'An import batch must contain at least one message or activity.',
        })
      }

      const events: PlannedOrchestrationEvent[] = []
      for (const message of command.messages)
      {
        events.push({
          ...(yield* withEventBase({
            aggregateKind: 'thread',
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: 'thread.message-sent',
          payload: {
            threadId: command.threadId,
            messageId: message.messageId,
            role: message.role,
            text: message.text,
            turnId: null,
            streaming: false,
            provenance: 'import',
            createdAt: message.createdAt,
            updatedAt: message.createdAt,
          },
        })
      }
      for (const activity of command.activities)
      {
        events.push({
          ...(yield* withEventBase({
            aggregateKind: 'thread',
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: 'thread.activity-appended',
          payload: {
            threadId: command.threadId,
            activity,
          },
        })
      }
      return events
    }

    case 'thread.session.set':
    {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      })
      const sessionSetEvent: Omit<OrchestrationEvent, 'sequence'> = {
        ...(yield* withEventBase({
          aggregateKind: 'thread',
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {},
        })),
        type: 'thread.session-set',
        payload: {
          threadId: command.threadId,
          session: command.session,
        },
      }
      const executionEvents = yield* terminalizeActiveExecutions({
        readModel,
        command,
        threadId: command.threadId,
        occurredAt: command.createdAt,
        reason: 'The owning provider turn or session ended.',
        shouldClose: (execution) =>
          command.session.status !== 'running' ||
          command.session.activeTurnId !== execution.sourceTurnId ||
          command.session.providerInstanceId !== thread.session?.providerInstanceId ||
          command.session.providerInstanceId !== thread.modelSelection.instanceId ||
          !normalizeCollaborationMode(thread.interactionMode, thread.orchestrate).orchestrate,
      })
      // only a session coming alive is activity worth waking a settled thread
      // for — status writes like ready/stopped/error arrive after the fact and
      // must not fight a user's explicit settle. Snooze is deliberately NOT
      // cleared here: snooze never pauses the agent, so its session starting
      // or erroring is not the user re-engaging. Blocked/failed work still
      // surfaces immediately — effectiveSnoozed refuses to classify a thread
      // with a raised hand (approval / input / failure / fresh completion)
      // as snoozed, without spending the return ticket.
      const isSessionActivity =
        command.session.status === 'starting' || command.session.status === 'running'
      // real activity resets ANY override (settled wakes, active unpins).
      if (thread.settledOverride === null || !isSessionActivity)
      {
        return executionEvents.length === 0
          ? sessionSetEvent
          : [...executionEvents, sessionSetEvent]
      }
      const unsettledEvent: Omit<OrchestrationEvent, 'sequence'> = {
        ...(yield* withEventBase({
          aggregateKind: 'thread',
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: 'thread.unsettled',
        payload: {
          threadId: command.threadId,
          reason: 'activity',
          updatedAt: command.createdAt,
        },
      }
      return [...executionEvents, unsettledEvent, sessionSetEvent]
    }

    case 'thread.provider.switch.progress':
    {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      })
      if (
        !providerSwitchRequestMatches(
          thread.providerSwitch,
          command.requestId,
          command.expectedRequestedAt,
        )
      )
      {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          code: 'stale-provider-switch-request',
          detail: `Provider switch request '${command.requestId}' no longer owns thread '${command.threadId}'.`,
        })
      }
      const occurredAt = yield* nowIso
      return {
        ...(yield* withEventBase({
          aggregateKind: 'thread',
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: 'thread.provider-switch-progressed',
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          phase: command.phase,
        },
      }
    }

    case 'thread.provider.switch.fail':
    {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      })
      if (
        !providerSwitchRequestMatches(
          thread.providerSwitch,
          command.requestId,
          command.expectedRequestedAt,
        )
      )
      {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          code: 'stale-provider-switch-request',
          detail: `Provider switch request '${command.requestId}' no longer owns thread '${command.threadId}'.`,
        })
      }
      const sourceModelSelection =
        thread.providerSwitch?.sourceModelSelection ??
        command.sourceModelSelection ??
        thread.modelSelection
      const targetModelSelection =
        thread.providerSwitch === null || thread.providerSwitch.targetModel === null
          ? command.targetModelSelection
          : {
              instanceId: thread.providerSwitch.targetInstanceId,
              model: thread.providerSwitch.targetModel,
            }
      const occurredAt = yield* nowIso
      const failureEvent: Omit<OrchestrationEvent, 'sequence'> = {
        ...(yield* withEventBase({
          aggregateKind: 'thread',
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: 'thread.provider-switch-failed',
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          sourceModelSelection,
          ...(targetModelSelection === undefined ? {} : { targetModelSelection }),
          activityVersion: 1,
          reasonCode: command.reasonCode,
          detail: command.detail,
        },
      }
      const session = thread.session
      if (
        session?.status !== 'running' ||
        session.activeTurnId !== null ||
        session.providerInstanceId !== thread.modelSelection.instanceId
      )
      {
        return failureEvent
      }
      const sessionRepairEvent: Omit<OrchestrationEvent, 'sequence'> = {
        ...(yield* withEventBase({
          aggregateKind: 'thread',
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: 'thread.session-set',
        payload: {
          threadId: command.threadId,
          session: {
            ...session,
            status: 'ready',
            updatedAt: occurredAt,
          },
        },
      }
      return [failureEvent, sessionRepairEvent]
    }

    case 'thread.provider.switch.complete':
    {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      })
      if (
        !providerSwitchRequestMatches(
          thread.providerSwitch,
          command.requestId,
          command.expectedRequestedAt,
        )
      )
      {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          code: 'stale-provider-switch-request',
          detail: `Provider switch request '${command.requestId}' no longer owns thread '${command.threadId}'.`,
        })
      }
      if (
        thread.providerSwitch !== null &&
        (thread.providerSwitch.targetInstanceId !== command.modelSelection.instanceId ||
          thread.providerSwitch.targetModel !== command.modelSelection.model)
      )
      {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          code: 'stale-provider-switch-target',
          detail: `Provider switch request '${command.requestId}' does not own target '${command.modelSelection.instanceId}'.`,
        })
      }
      const occurredAt = yield* nowIso
      return {
        ...(yield* withEventBase({
          aggregateKind: 'thread',
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: 'thread.provider-switched',
        payload: {
          requestId: command.requestId,
          sourceModelSelection:
            thread.providerSwitch?.sourceModelSelection ??
            command.sourceModelSelection ??
            thread.modelSelection,
          activityVersion: 1,
          modelSelection: command.modelSelection,
          fromInstanceId: command.fromInstanceId,
          ...(command.fromModel !== undefined ? { fromModel: command.fromModel } : {}),
          handoffText: command.handoffText,
        },
      }
    }

    case 'thread.handoff.clear':
    {
      // emits unconditionally: the engine rejects zero-event results, and a
      // raced duplicate clear is harmless (projector re-sets null)
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      })
      const occurredAt = yield* nowIso
      return {
        ...(yield* withEventBase({
          aggregateKind: 'thread',
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: 'thread.handoff-cleared',
        payload: {
          threadId: command.threadId,
        },
      }
    }

    case 'thread.message.assistant.delta':
    {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      })
      return {
        ...(yield* withEventBase({
          aggregateKind: 'thread',
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: 'thread.message-sent',
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: 'assistant',
          text: command.delta,
          turnId: command.turnId ?? null,
          streaming: true,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      }
    }

    case 'thread.message.assistant.complete':
    {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      })
      return {
        ...(yield* withEventBase({
          aggregateKind: 'thread',
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: 'thread.message-sent',
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: 'assistant',
          text: '',
          turnId: command.turnId ?? null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      }
    }

    case 'thread.proposed-plan.upsert':
    {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      })
      return {
        ...(yield* withEventBase({
          aggregateKind: 'thread',
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: 'thread.proposed-plan-upserted',
        payload: {
          threadId: command.threadId,
          proposedPlan: command.proposedPlan,
        },
      }
    }

    case 'thread.orchestrate-plan.upsert':
    {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      })
      // the serialized decider is the revision authority: concurrent tool
      // calls can both compute the same next revision before either event
      // commits, so a stale or colliding suggestion is bumped past the
      // current max instead of overwriting an existing immutable revision
      const maxExistingRevision = thread.orchestratePlans
        .filter((existing) => existing.runId === command.plan.runId)
        .reduce((max, existing) => Math.max(max, existing.revision), 0)
      // the lead's binding is server truth, not something the agent reports:
      // stamp it over whatever arrived, on every revision, so a plan can never
      // hide that a stage is bound to the model the lead is already burning.
      // the pendingHandoff precedence mirrors the composer's own rule so the
      // stamped row agrees with the card during a compaction handoff
      const leadSessionInstanceId = thread.session?.providerInstanceId
      const handoffPending = thread.pendingHandoff !== undefined && thread.pendingHandoff !== null
      const leadModelSelection =
        handoffPending || leadSessionInstanceId === undefined
          ? thread.modelSelection
          : { ...thread.modelSelection, instanceId: leadSessionInstanceId }
      const plan = {
        ...command.plan,
        leadModelSelection,
        ...(command.plan.revision > maxExistingRevision
          ? {}
          : { revision: maxExistingRevision + 1 }),
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: 'thread',
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: 'thread.orchestrate-plan-upserted',
        payload: {
          threadId: command.threadId,
          plan,
          createdAt: command.createdAt,
        },
      }
    }

    case 'thread.checkpoint.baseline.record':
    {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      })
      return {
        ...(yield* withEventBase({
          aggregateKind: 'thread',
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: 'thread.checkpoint-baseline-recorded',
        payload: {
          threadId: command.threadId,
          checkpointTurnCount: command.checkpointTurnCount,
          checkpointRef: command.checkpointRef,
          checkpointCaptureRoot: command.checkpointCaptureRoot,
          checkpointRepositoryCommonDir: command.checkpointRepositoryCommonDir,
          checkpointCommitOid: command.checkpointCommitOid,
          capturedAt: command.capturedAt,
        },
      }
    }

    case 'thread.turn.diff.complete':
    {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      })
      return {
        ...(yield* withEventBase({
          aggregateKind: 'thread',
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: 'thread.turn-diff-completed',
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
          checkpointTurnCount: command.checkpointTurnCount,
          checkpointRef: command.checkpointRef,
          status: command.status,
          files: command.files,
          assistantMessageId: command.assistantMessageId ?? null,
          completedAt: command.completedAt,
          checkpointCaptureRoot: command.checkpointCaptureRoot ?? null,
          checkpointRepositoryCommonDir: command.checkpointRepositoryCommonDir ?? null,
          checkpointCommitOid: command.checkpointCommitOid ?? null,
        },
      }
    }

    case 'thread.revert.complete':
    {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      })
      return {
        ...(yield* withEventBase({
          aggregateKind: 'thread',
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: 'thread.reverted',
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
        },
      }
    }

    case 'thread.activity.append':
    {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      })
      const requestId =
        typeof command.activity.payload === 'object' &&
        command.activity.payload !== null &&
        'requestId' in command.activity.payload &&
        typeof (command.activity.payload as { requestId?: unknown }).requestId === 'string'
          ? ((command.activity.payload as { requestId: string })
              .requestId as OrchestrationEvent['metadata']['requestId'])
          : undefined
      const activityAppendedEvent: Omit<OrchestrationEvent, 'sequence'> = {
        ...(yield* withEventBase({
          aggregateKind: 'thread',
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          ...(requestId !== undefined ? { metadata: { requestId } } : {}),
        })),
        type: 'thread.activity-appended',
        payload: {
          threadId: command.threadId,
          activity: command.activity,
        },
      }
      // an approval or user-input request is blocked-on-you work — it must
      // never stay hidden inside a settled slim row.
      const wakesSettledThread = isBlockingRequestActivityKind(command.activity.kind)
      // real activity resets ANY override (settled wakes, active unpins).
      if (thread.settledOverride === null || !wakesSettledThread)
      {
        return activityAppendedEvent
      }
      const unsettledEvent: Omit<OrchestrationEvent, 'sequence'> = {
        ...(yield* withEventBase({
          aggregateKind: 'thread',
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: 'thread.unsettled',
        payload: {
          threadId: command.threadId,
          reason: 'activity',
          updatedAt: command.createdAt,
        },
      }
      return [unsettledEvent, activityAppendedEvent]
    }

    default:
    {
      command satisfies never
      const fallback = command as never as { type: string }
      return yield* new OrchestrationCommandInvariantError({
        commandType: fallback.type,
        detail: `Unknown command type: ${fallback.type}`,
      })
    }
  }
})
