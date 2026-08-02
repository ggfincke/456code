// apps/server/src/orchestration/decider.ts
// validates orchestration commands and produces domain events

import {
  EventId,
  type CommandId,
  type OrchestratePlanRevision,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type ThreadId,
  ThreadImportContinuationActivityPayload,
  type ThreadImportContinuationActivityPayload as ThreadImportContinuationActivityPayloadType,
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

// server-internal command: plan upserts arrive through the MCP toolkit, not
// the client command union
export interface ThreadOrchestratePlanUpsertCommand
{
  readonly type: 'thread.orchestrate-plan.upsert'
  readonly commandId: CommandId
  readonly threadId: ThreadId
  readonly plan: OrchestratePlanRevision
  readonly createdAt: string
}

type ServerOrchestrationCommand = OrchestrationCommand | ThreadOrchestratePlanUpsertCommand

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
  input: Pick<ServerOrchestrationCommand, 'commandId'> & {
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
  readonly command: ServerOrchestrationCommand
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
      return {
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
      }
    }

    case 'thread.archive':
    {
      yield* requireThreadNotArchived({
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
        type: 'thread.archived',
        payload: {
          threadId: command.threadId,
          archivedAt: occurredAt,
          updatedAt: occurredAt,
        },
      }
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
      return {
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
      }
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
          updatedAt: occurredAt,
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
      const targetThread = yield* requireThread({
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
          interactionMode: targetThread.interactionMode,
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
        return sessionSetEvent
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
      return [unsettledEvent, sessionSetEvent]
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
      yield* requireThread({
        readModel,
        command: command as unknown as OrchestrationCommand,
        threadId: command.threadId,
      })
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
          plan: command.plan,
          createdAt: command.createdAt,
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
