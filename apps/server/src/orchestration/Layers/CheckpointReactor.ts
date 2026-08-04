// apps/server/src/orchestration/Layers/CheckpointReactor.ts
// captures and restores git checkpoints in response to orchestration events
import {
  CommandId,
  CheckpointRef,
  EventId,
  MessageId,
  type OrchestrationProposedPlanId,
  type ProjectId,
  type ProviderInstanceId,
  ThreadId,
  TurnId,
  OrchestrationEvent,
  type ProviderRuntimeEvent,
} from '@t3tools/contracts'
import * as Cause from 'effect/Cause'
import * as Crypto from 'effect/Crypto'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import { makeDrainableWorker } from '@t3tools/shared/DrainableWorker'

import { parseTurnDiffFilesFromUnifiedDiff } from '../../checkpointing/Diffs.ts'
import { checkpointRefForThreadTurn, resolveThreadWorkspaceCwd } from '../../checkpointing/Utils.ts'
import * as CheckpointStore from '../../checkpointing/CheckpointStore.ts'
import { ServerConfig } from '../../config.ts'
import {
  CheckpointRevertOperations,
  type CheckpointRevertOperation,
} from '../../persistence/Services/CheckpointRevertOperations.ts'
import type { ProviderAdapterCapabilities } from '../../provider/Services/ProviderAdapter.ts'
import { ProviderService } from '../../provider/Services/ProviderService.ts'
import { CheckpointReactor, type CheckpointReactorShape } from '../Services/CheckpointReactor.ts'
import {
  DurableReactorRunner,
  type DurableReactorDefinition,
} from '../Services/DurableReactorRunner.ts'
import { OrchestrationEngineService } from '../Services/OrchestrationEngine.ts'
import { ProjectionSnapshotQuery } from '../Services/ProjectionSnapshotQuery.ts'
import { RuntimeReceiptBus } from '../Services/RuntimeReceiptBus.ts'
import { isGitRepository } from '../../git/Utils.ts'
import { ProposalImplementationAttemptService } from '../../proposal/ProposalImplementationAttemptService.ts'
import { VcsStatusBroadcaster } from '../../vcs/VcsStatusBroadcaster.ts'
import * as VcsDriverRegistry from '../../vcs/VcsDriverRegistry.ts'
import * as WorkspaceEntries from '../../workspace/WorkspaceEntries.ts'
import { isHiddenTurnRuntimeEvent } from '../../provider/HiddenTurnRegistry.ts'
import { ReactorDeliveryError } from '../../persistence/Errors.ts'
import { OrchestrationReactorDelivery } from '../../persistence/Services/OrchestrationReactorDelivery.ts'
import { DurableReactorInfrastructureLive } from './OrchestrationReactor.ts'

const nowIso = Effect.map(DateTime.now, DateTime.formatIso)
const REACTOR_ID = 'checkpoint-domain' as const
const OPERATION_VERSION = 1
const REVERT_OPERATION_PREFIX = 'checkpoint-revert:'
const REVERT_STAGE_DIRECTORY = 'checkpoint-reverts'
const DomainActionPayload = Schema.fromJsonString(
  Schema.Struct({
    event: OrchestrationEvent,
    targetCheckpointRef: CheckpointRef,
  }),
)
const encodeDomainActionPayload = Schema.encodeEffect(DomainActionPayload)
const decodeDomainActionPayload = Schema.decodeUnknownEffect(DomainActionPayload)

class CheckpointDomainPayloadError extends Schema.TaggedErrorClass<CheckpointDomainPayloadError>()(
  'CheckpointDomainPayloadError',
  { detail: Schema.String },
)
{}

// retryable failure of a durable checkpoint step: a missing journal field, a
// target that moved under the operation, or an unreadable journal detail
class CheckpointOperationError extends Schema.TaggedErrorClass<CheckpointOperationError>()(
  'CheckpointOperationError',
  { detail: Schema.String },
)
{
  override get message(): string
  {
    return this.detail
  }
}

const isCheckpointDomainPayloadErrorInstance = Schema.is(CheckpointDomainPayloadError)

function isCheckpointDomainPayloadError(cause: unknown): boolean
{
  return Schema.isSchemaError(cause) || isCheckpointDomainPayloadErrorInstance(cause)
}

// whether a planned baseline ref still denotes the projection's current
// pre-turn boundary at the moment its durable action runs
type PlannedBaselineBoundary = 'current' | 'superseded'

type ProviderRollbackCapability = 'exact' | 'known-unsupported' | 'legacy-unreported'

interface ProviderRollbackJournalDetail
{
  readonly version: 1
  readonly capability: ProviderRollbackCapability
  readonly state: 'pending' | 'attempt-started' | 'recorded'
  readonly rolledBackTurns: number
  readonly staleRefs: ReadonlyArray<string>
  readonly detail: string | null
}

function checkpointRevertOperationId(commandId: CommandId): string
{
  return `${REVERT_OPERATION_PREFIX}${commandId}`
}

function errorDetail(cause: unknown): string
{
  return cause instanceof Error ? cause.message : String(cause)
}

function rollbackCapabilityFrom(
  capabilities: ProviderAdapterCapabilities,
): ProviderRollbackCapability
{
  const declared = capabilities.conversationRollback
  if (declared === 'unsupported')
  {
    return 'known-unsupported'
  }
  if (declared === 'exact')
  {
    return 'exact'
  }
  // no adapter declares the capability yet, so the revert attempts the
  // rollback and classifies the outcome from what the provider does
  return 'legacy-unreported'
}

function encodeProviderRollbackJournalDetail(detail: ProviderRollbackJournalDetail): string
{
  return JSON.stringify(detail)
}

function decodeProviderRollbackJournalDetail(
  operation: CheckpointRevertOperation,
): ProviderRollbackJournalDetail
{
  if (operation.providerOutcomeJson === null)
  {
    throw new Error(
      `Checkpoint revert '${operation.operationId}' is missing provider rollback detail.`,
    )
  }

  const decoded: unknown = JSON.parse(operation.providerOutcomeJson)
  if (typeof decoded !== 'object' || decoded === null)
  {
    throw new Error(
      `Checkpoint revert '${operation.operationId}' has invalid provider rollback detail.`,
    )
  }
  const candidate = decoded as Partial<ProviderRollbackJournalDetail>
  if (
    candidate.version !== 1 ||
    (candidate.capability !== 'exact' &&
      candidate.capability !== 'known-unsupported' &&
      candidate.capability !== 'legacy-unreported') ||
    (candidate.state !== 'pending' &&
      candidate.state !== 'attempt-started' &&
      candidate.state !== 'recorded') ||
    typeof candidate.rolledBackTurns !== 'number' ||
    !Number.isInteger(candidate.rolledBackTurns) ||
    candidate.rolledBackTurns < 0 ||
    !Array.isArray(candidate.staleRefs) ||
    !candidate.staleRefs.every((ref) => typeof ref === 'string') ||
    (candidate.detail !== null && typeof candidate.detail !== 'string')
  )
  {
    throw new Error(
      `Checkpoint revert '${operation.operationId}' has invalid provider rollback detail.`,
    )
  }
  return candidate as ProviderRollbackJournalDetail
}

function decodeProviderRollbackJournalDetailEffect(operation: CheckpointRevertOperation)
{
  return Effect.try({
    try: () => decodeProviderRollbackJournalDetail(operation),
    catch: (cause) => new CheckpointOperationError({ detail: errorDetail(cause) }),
  })
}

type ThreadMessageSentEvent = Extract<OrchestrationEvent, { type: 'thread.message-sent' }>

function isCheckpointBaselineMessage(event: ThreadMessageSentEvent): boolean
{
  return (
    event.payload.provenance !== 'import' &&
    event.payload.role === 'user' &&
    !event.payload.streaming &&
    event.payload.turnId === null
  )
}

function toTurnId(value: string | undefined): TurnId | null
{
  return value === undefined ? null : TurnId.make(String(value))
}

function sameId(left: string | null | undefined, right: string | null | undefined): boolean
{
  if (left === null || left === undefined || right === null || right === undefined)
  {
    return false
  }
  return left === right
}

interface ImplementationSource
{
  readonly threadId: ThreadId
  readonly planId: OrchestrationProposedPlanId
}

interface PendingImplementationRequest
{
  readonly requestedAt: string
  readonly sourceProposedPlan?: ImplementationSource
}

function matchingImplementationRequest(
  thread: {
    readonly latestTurn: {
      readonly turnId: TurnId
      readonly requestedAt: string
      readonly sourceProposedPlan?: ImplementationSource | undefined
    } | null
  },
  turnId: TurnId,
  pending: PendingImplementationRequest | undefined,
):
  | {
      readonly requestedAt: string
      readonly sourceProposedPlan: ImplementationSource
    }
  | undefined
  {
  if (
    thread.latestTurn !== null &&
    sameId(thread.latestTurn.turnId, turnId) &&
    thread.latestTurn.sourceProposedPlan !== undefined
  )
  {
    return {
      requestedAt: thread.latestTurn.requestedAt,
      sourceProposedPlan: thread.latestTurn.sourceProposedPlan,
    }
  }
  return pending?.sourceProposedPlan === undefined
    ? undefined
    : {
        requestedAt: pending.requestedAt,
        sourceProposedPlan: pending.sourceProposedPlan,
      }
}

function checkpointStatusFromRuntime(status: string | undefined): 'ready' | 'missing' | 'error'
{
  switch (status)
  {
    case 'failed':
      return 'error'
    case 'cancelled':
    case 'interrupted':
      return 'missing'
    case 'completed':
    default:
      return 'ready'
  }
}

const make = Effect.gen(function* ()
{
  const crypto = yield* Crypto.Crypto
  const randomUUID = crypto.randomUUIDv4
  const serverEventId = randomUUID.pipe(Effect.map(EventId.make))
  const serverCommandId = (tag: string) =>
    randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)))
  const reactorCommandId = (actionId: string, tag: string) =>
    CommandId.make(`server:${tag}:reactor-action:${actionId}`)
  const commandIdFor = (tag: string, actionId?: string) =>
    actionId === undefined ? serverCommandId(tag) : Effect.succeed(reactorCommandId(actionId, tag))
  const delivery = yield* OrchestrationReactorDelivery
  const durableRunner = yield* DurableReactorRunner
  const orchestrationEngine = yield* OrchestrationEngineService
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery
  const providerService = yield* ProviderService
  const checkpointStore = yield* CheckpointStore.CheckpointStore
  const checkpointRevertOperations = yield* CheckpointRevertOperations
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const serverConfig = yield* ServerConfig
  const receiptBus = yield* RuntimeReceiptBus
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster
  const proposalImplementationAttempts = Option.getOrUndefined(
    yield* Effect.serviceOption(ProposalImplementationAttemptService),
  )
  const pendingImplementationRequests = new Map<string, PendingImplementationRequest>()

  const appendRevertFailureActivity = (input: {
    readonly threadId: ThreadId
    readonly turnCount: number
    readonly detail: string
    readonly createdAt: string
    readonly actionId?: string
  }) =>
    Effect.all({
      commandId: commandIdFor('checkpoint-revert-failure', input.actionId),
      activityId: serverEventId,
    }).pipe(
      Effect.flatMap(({ commandId, activityId }) =>
        orchestrationEngine.dispatch({
          type: 'thread.activity.append',
          commandId,
          threadId: input.threadId,
          activity: {
            id: activityId,
            tone: 'error',
            kind: 'checkpoint.revert.failed',
            summary: 'Checkpoint revert failed',
            payload: {
              turnCount: input.turnCount,
              detail: input.detail,
            },
            turnId: null,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    )

  const appendCaptureFailureActivity = (input: {
    readonly threadId: ThreadId
    readonly turnId: TurnId | null
    readonly detail: string
    readonly createdAt: string
    readonly actionId?: string
  }) =>
    Effect.all({
      commandId: commandIdFor('checkpoint-capture-failure', input.actionId),
      activityId: serverEventId,
    }).pipe(
      Effect.flatMap(({ commandId, activityId }) =>
        orchestrationEngine.dispatch({
          type: 'thread.activity.append',
          commandId,
          threadId: input.threadId,
          activity: {
            id: activityId,
            tone: 'error',
            kind: 'checkpoint.capture.failed',
            summary: 'Checkpoint capture failed',
            payload: {
              detail: input.detail,
            },
            turnId: input.turnId,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    )

  const appendProviderRollbackNotice = (input: {
    readonly operationId: string
    readonly threadId: ThreadId
    readonly turnCount: number
    readonly detail: string
    readonly createdAt: string
  }) =>
    Effect.all({
      commandId: commandIdFor('checkpoint-revert-provider-notice', input.operationId),
      activityId: serverEventId,
    }).pipe(
      Effect.flatMap(({ commandId, activityId }) =>
        orchestrationEngine.dispatch({
          type: 'thread.activity.append',
          commandId,
          threadId: input.threadId,
          activity: {
            id: activityId,
            tone: 'error',
            kind: 'checkpoint.revert.provider-diverged',
            summary: 'Provider conversation was not reverted',
            payload: {
              turnCount: input.turnCount,
              detail: input.detail,
            },
            turnId: null,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    )

  const resolveSessionRuntimeForThread = Effect.fn('resolveSessionRuntimeForThread')(function* (
    threadId: ThreadId,
  ): Effect.fn.Return<
    Option.Option<{
      readonly threadId: ThreadId
      readonly cwd: string
      readonly providerInstanceId: ProviderInstanceId | undefined
      readonly providerSessionId: string | undefined
    }>
  >
  {
    const sessions = yield* providerService.listSessions()
    const session = sessions.find((entry) => entry.threadId === threadId)
    return session?.cwd
      ? Option.some({
          threadId: session.threadId,
          cwd: session.cwd,
          providerInstanceId: session.providerInstanceId,
          providerSessionId:
            typeof session.resumeCursor === 'string' ? session.resumeCursor : undefined,
        })
      : Option.none()
  })

  const resolveThreadDetail = Effect.fn('resolveThreadDetail')(function* (threadId: ThreadId)
  {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrUndefined))
  })

  const resolveThreadProjects = Effect.fn('resolveThreadProjects')(function* (
    projectId: ProjectId,
  )
  {
    const project = yield* projectionSnapshotQuery
      .getProjectShellById(projectId)
      .pipe(Effect.map(Option.getOrUndefined))
    return project ? [project] : []
  })

  const isGitWorkspace = (cwd: string) => isGitRepository(cwd)

  // resolves the workspace CWD for checkpoint operations, preferring the
  // active provider session CWD and falling back to the thread/project config.
  // returns undefined when no CWD can be determined or the workspace is not
  // a git repository.
  const resolveCheckpointCwd = Effect.fn('resolveCheckpointCwd')(function* (input: {
    readonly threadId: ThreadId
    readonly thread: { readonly projectId: ProjectId; readonly worktreePath: string | null }
    readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly workspaceRoot: string }>
    readonly preferSessionRuntime: boolean
  }): Effect.fn.Return<string | undefined>
  {
    const fromSession = yield* resolveSessionRuntimeForThread(input.threadId)
    const fromThread = resolveThreadWorkspaceCwd({
      thread: input.thread,
      projects: input.projects,
    })

    const cwd = input.preferSessionRuntime
      ? (Option.match(fromSession, {
          onNone: () => undefined,
          onSome: (runtime) => runtime.cwd,
        }) ?? fromThread)
      : (fromThread ??
        Option.match(fromSession, {
          onNone: () => undefined,
          onSome: (runtime) => runtime.cwd,
        }))

    if (!cwd)
    {
      return undefined
    }
    if (!isGitWorkspace(cwd))
    {
      return undefined
    }
    return cwd
  })

  // shared tail for both capture paths: creates the git checkpoint ref, diffs
  // it against the previous turn, then dispatches the domain events to update
  // the orchestration read model.
  const captureAndDispatchCheckpoint = Effect.fn('captureAndDispatchCheckpoint')(function* (input: {
    readonly threadId: ThreadId
    readonly turnId: TurnId
    readonly thread: {
      readonly messages: ReadonlyArray<{
        readonly id: MessageId
        readonly role: string
        readonly turnId: TurnId | null
      }>
    }
    readonly cwd: string
    readonly turnCount: number
    readonly status: 'ready' | 'missing' | 'error'
    readonly assistantMessageId: MessageId | undefined
    readonly createdAt: string
    readonly actionId?: string
  })
  {
    const fromTurnCount = Math.max(0, input.turnCount - 1)
    const fromCheckpointRef = checkpointRefForThreadTurn(input.threadId, fromTurnCount)
    const targetCheckpointRef = checkpointRefForThreadTurn(input.threadId, input.turnCount)

    const fromCheckpointExists = yield* checkpointStore.hasCheckpointRef({
      cwd: input.cwd,
      checkpointRef: fromCheckpointRef,
    })
    if (!fromCheckpointExists)
    {
      yield* Effect.logWarning('checkpoint capture missing pre-turn baseline', {
        threadId: input.threadId,
        turnId: input.turnId,
        fromTurnCount,
      })
    }

    // the existence check is only a cheap way to skip the snapshot work; the
    // publication itself is compare-and-swapped so a late capture cannot
    // overwrite a ref another lane already published for this turn
    const targetCheckpointExists = yield* checkpointStore.hasCheckpointRef({
      cwd: input.cwd,
      checkpointRef: targetCheckpointRef,
    })
    if (!targetCheckpointExists)
    {
      const publication = yield* checkpointStore.captureCheckpoint({
        cwd: input.cwd,
        checkpointRef: targetCheckpointRef,
        expected: { kind: 'absent' },
      })
      if (publication.outcome === 'lost-race')
      {
        yield* Effect.logWarning('checkpoint capture lost the ref publication race', {
          threadId: input.threadId,
          turnId: input.turnId,
          turnCount: input.turnCount,
          checkpointRef: targetCheckpointRef,
        })
      }
    }

    // refresh the workspace entry index so the @-mention file picker
    // reflects files created or deleted during this turn.
    yield* workspaceEntries.refresh(input.cwd)

    const files = yield* checkpointStore
      .diffCheckpoints({
        cwd: input.cwd,
        fromCheckpointRef,
        toCheckpointRef: targetCheckpointRef,
        fallbackFromToHead: false,
        ignoreWhitespace: false,
      })
      .pipe(
        Effect.map((diff) =>
          parseTurnDiffFilesFromUnifiedDiff(diff).map((file) => ({
            path: file.path,
            kind: 'modified' as const,
            additions: file.additions,
            deletions: file.deletions,
          })),
        ),
        Effect.tapError((error) =>
          appendCaptureFailureActivity({
            threadId: input.threadId,
            turnId: input.turnId,
            detail: `Checkpoint captured, but turn diff summary is unavailable: ${error.message}`,
            createdAt: input.createdAt,
          }),
        ),
        Effect.catch((error) =>
          Effect.logWarning('failed to derive checkpoint file summary', {
            threadId: input.threadId,
            turnId: input.turnId,
            turnCount: input.turnCount,
            detail: error.message,
          }).pipe(Effect.as([])),
        ),
      )

    const assistantMessageId =
      input.assistantMessageId ??
      input.thread.messages
        .toReversed()
        .find((entry) => entry.role === 'assistant' && entry.turnId === input.turnId)?.id ??
      MessageId.make(`assistant:${input.turnId}`)

    yield* orchestrationEngine.dispatch({
      type: 'thread.turn.diff.complete',
      commandId: yield* commandIdFor('checkpoint-turn-diff-complete', input.actionId),
      threadId: input.threadId,
      turnId: input.turnId,
      completedAt: input.createdAt,
      checkpointRef: targetCheckpointRef,
      status: input.status,
      files,
      assistantMessageId,
      checkpointTurnCount: input.turnCount,
      createdAt: input.createdAt,
    })
    yield* receiptBus.publish({
      type: 'checkpoint.diff.finalized',
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointTurnCount: input.turnCount,
      checkpointRef: targetCheckpointRef,
      status: input.status,
      createdAt: input.createdAt,
    })
    yield* receiptBus.publish({
      type: 'turn.processing.quiesced',
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointTurnCount: input.turnCount,
      createdAt: input.createdAt,
    })

    yield* orchestrationEngine.dispatch({
      type: 'thread.activity.append',
      commandId: yield* commandIdFor('checkpoint-captured-activity', input.actionId),
      threadId: input.threadId,
      activity: {
        id: EventId.make(yield* randomUUID),
        tone: 'info',
        kind: 'checkpoint.captured',
        summary: 'Checkpoint captured',
        payload: {
          turnCount: input.turnCount,
          status: input.status,
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    })
  })

  // captures a real git checkpoint when a turn completes via a runtime event.
  const captureCheckpointFromTurnCompletion = Effect.fn('captureCheckpointFromTurnCompletion')(
    function* (event: Extract<ProviderRuntimeEvent, { type: 'turn.completed' }>)
    {
      const turnId = toTurnId(event.turnId)
      if (!turnId)
      {
        return
      }

      const thread = yield* resolveThreadDetail(event.threadId)
      if (!thread)
      {
        return
      }

      // when a primary turn is active, only that turn may produce completion checkpoints.
      if (thread.session?.activeTurnId && !sameId(thread.session.activeTurnId, turnId))
      {
        return
      }

      // only skip if a real (non-placeholder) checkpoint already exists for this turn.
      // ProviderRuntimeIngestion may insert placeholder entries with status "missing"
      // before this reactor runs; those must not prevent real git capture.
      if (
        thread.checkpoints.some(
          (checkpoint) => checkpoint.turnId === turnId && checkpoint.status !== 'missing',
        )
      )
      {
        return
      }

      const projects = yield* resolveThreadProjects(thread.projectId)
      const checkpointCwd = yield* resolveCheckpointCwd({
        threadId: thread.id,
        thread,
        projects,
        preferSessionRuntime: true,
      })
      if (!checkpointCwd)
      {
        return
      }

      // if a placeholder checkpoint exists for this turn, reuse its turn count
      // instead of incrementing past it.
      const existingPlaceholder = thread.checkpoints.find(
        (checkpoint) => checkpoint.turnId === turnId && checkpoint.status === 'missing',
      )
      const currentTurnCount = thread.checkpoints.reduce(
        (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
        0,
      )
      const nextTurnCount = existingPlaceholder
        ? existingPlaceholder.checkpointTurnCount
        : currentTurnCount + 1

      yield* captureAndDispatchCheckpoint({
        threadId: thread.id,
        turnId,
        thread,
        cwd: checkpointCwd,
        turnCount: nextTurnCount,
        status: checkpointStatusFromRuntime(event.payload.state),
        assistantMessageId: undefined,
        createdAt: event.createdAt,
      })
    },
  )

  // captures a real git checkpoint when a placeholder checkpoint (status "missing")
  // is detected via a domain event. This replaces the placeholder with a real
  // git-ref-based checkpoint.
  //
  // ProviderRuntimeIngestion creates placeholder checkpoints on turn.diff.updated
  // events from the Codex runtime. This handler fires when the corresponding
  // domain event arrives, allowing the reactor to capture the actual filesystem
  // state into a git ref and dispatch a replacement checkpoint.
  const captureCheckpointFromPlaceholder = Effect.fn('captureCheckpointFromPlaceholder')(function* (
    event: Extract<OrchestrationEvent, { type: 'thread.turn-diff-completed' }>,
    actionId?: string,
  )
  {
    const { threadId, turnId, checkpointTurnCount, status } = event.payload

    // only replace placeholders; skip events from our own real captures.
    if (status !== 'missing')
    {
      return
    }

    const thread = yield* resolveThreadDetail(threadId)
    if (!thread)
    {
      yield* Effect.logWarning('checkpoint capture from placeholder skipped: thread not found', {
        threadId,
      })
      return
    }

    // if a real checkpoint already exists for this turn, skip.
    if (
      thread.checkpoints.some(
        (checkpoint) => checkpoint.turnId === turnId && checkpoint.status !== 'missing',
      )
    )
    {
      yield* Effect.logDebug(
        'checkpoint capture from placeholder skipped: real checkpoint already exists',
        { threadId, turnId },
      )
      return
    }

    const projects = yield* resolveThreadProjects(thread.projectId)
    const checkpointCwd = yield* resolveCheckpointCwd({
      threadId,
      thread,
      projects,
      preferSessionRuntime: true,
    })
    if (!checkpointCwd)
    {
      return
    }

    yield* captureAndDispatchCheckpoint({
      threadId,
      turnId,
      thread,
      cwd: checkpointCwd,
      turnCount: checkpointTurnCount,
      status: 'ready',
      assistantMessageId: event.payload.assistantMessageId ?? undefined,
      createdAt: event.payload.completedAt,
      ...(actionId === undefined ? {} : { actionId }),
    })
  })

  const ensurePreTurnBaselineFromTurnStart = Effect.fn('ensurePreTurnBaselineFromTurnStart')(
    function* (event: Extract<ProviderRuntimeEvent, { type: 'turn.started' }>)
    {
      const turnId = toTurnId(event.turnId)
      if (!turnId)
      {
        return
      }

      const thread = yield* resolveThreadDetail(event.threadId)
      if (!thread)
      {
        return
      }

      const projects = yield* resolveThreadProjects(thread.projectId)
      const checkpointCwd = yield* resolveCheckpointCwd({
        threadId: thread.id,
        thread,
        projects,
        preferSessionRuntime: false,
      })
      if (!checkpointCwd)
      {
        return
      }

      const currentTurnCount = thread.checkpoints.reduce(
        (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
        0,
      )
      const baselineCheckpointRef = checkpointRefForThreadTurn(thread.id, currentTurnCount)
      const baselineExists = yield* checkpointStore.hasCheckpointRef({
        cwd: checkpointCwd,
        checkpointRef: baselineCheckpointRef,
      })
      if (baselineExists)
      {
        return
      }

      const publication = yield* checkpointStore.captureCheckpoint({
        cwd: checkpointCwd,
        checkpointRef: baselineCheckpointRef,
        expected: { kind: 'absent' },
      })
      // another lane published this baseline first; its snapshot stands and
      // this one is dropped, exactly as if the ref had existed up front
      if (publication.outcome === 'lost-race')
      {
        return
      }
      yield* receiptBus.publish({
        type: 'checkpoint.baseline.captured',
        threadId: thread.id,
        checkpointTurnCount: currentTurnCount,
        checkpointRef: baselineCheckpointRef,
        createdAt: event.createdAt,
      })
    },
  )

  const beginImplementationAttemptFromTurnStart = Effect.fn(
    'beginImplementationAttemptFromTurnStart',
  )(function* (event: Extract<ProviderRuntimeEvent, { type: 'turn.started' }>)
  {
    if (!proposalImplementationAttempts)
    {
      return
    }
    const turnId = toTurnId(event.turnId)
    if (!turnId)
    {
      return
    }
    const thread = yield* resolveThreadDetail(event.threadId)
    if (!thread)
    {
      return
    }
    if (thread.session?.activeTurnId && !sameId(thread.session.activeTurnId, turnId))
    {
      return
    }
    const implementationRequest = matchingImplementationRequest(
      thread,
      turnId,
      pendingImplementationRequests.get(thread.id),
    )
    if (!implementationRequest)
    {
      return
    }
    const projects = yield* resolveThreadProjects(thread.projectId)
    const cwd = yield* resolveCheckpointCwd({
      threadId: thread.id,
      thread,
      projects,
      preferSessionRuntime: false,
    })
    if (!cwd)
    {
      return
    }

    const checkpointTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    )
    yield* proposalImplementationAttempts.begin({
      implementationThreadId: thread.id,
      implementationTurnId: turnId,
      cwd,
      baselineCheckpointRef: checkpointRefForThreadTurn(thread.id, checkpointTurnCount),
      ...(implementationRequest.sourceProposedPlan === undefined
        ? {}
        : { sourceProposedPlan: implementationRequest.sourceProposedPlan }),
      createdAt: implementationRequest.requestedAt,
    })
    pendingImplementationRequests.delete(thread.id)
  })

  const completeImplementationAttemptFromCheckpoint = Effect.fn(
    'completeImplementationAttemptFromCheckpoint',
  )(function* (event: Extract<OrchestrationEvent, { type: 'thread.turn-diff-completed' }>)
  {
    if (!proposalImplementationAttempts || event.payload.status !== 'ready')
    {
      return
    }
    const thread = yield* resolveThreadDetail(event.payload.threadId)
    if (!thread)
    {
      return
    }
    const projects = yield* resolveThreadProjects(thread.projectId)
    const cwd = yield* resolveCheckpointCwd({
      threadId: thread.id,
      thread,
      projects,
      preferSessionRuntime: true,
    })
    if (!cwd)
    {
      return
    }

    const implementationRequest = matchingImplementationRequest(
      thread,
      event.payload.turnId,
      pendingImplementationRequests.get(thread.id),
    )
    if (implementationRequest)
    {
      yield* proposalImplementationAttempts.begin({
        implementationThreadId: thread.id,
        implementationTurnId: event.payload.turnId,
        cwd,
        baselineCheckpointRef: checkpointRefForThreadTurn(
          thread.id,
          Math.max(0, event.payload.checkpointTurnCount - 1),
        ),
        ...(implementationRequest.sourceProposedPlan === undefined
          ? {}
          : { sourceProposedPlan: implementationRequest.sourceProposedPlan }),
        createdAt: implementationRequest.requestedAt,
      })
      pendingImplementationRequests.delete(thread.id)
    }
    yield* proposalImplementationAttempts.complete({
      implementationThreadId: thread.id,
      implementationTurnId: event.payload.turnId,
      cwd,
      actualCheckpointRef: event.payload.checkpointRef,
      completedAt: event.payload.completedAt,
    })
  })

  const refreshLocalGitStatusFromTurnCompletion = Effect.fn(
    'refreshLocalGitStatusFromTurnCompletion',
  )(function* (event: Extract<ProviderRuntimeEvent, { type: 'turn.completed' }>)
  {
    const sessionRuntime = yield* resolveSessionRuntimeForThread(event.threadId)
    if (Option.isNone(sessionRuntime))
    {
      return
    }

    yield* vcsStatusBroadcaster.refreshLocalStatus(sessionRuntime.value.cwd).pipe(
      Effect.catch((error) =>
        Effect.logWarning('failed to refresh local git status after turn completion', {
          threadId: event.threadId,
          turnId: event.turnId ?? null,
          cwd: sessionRuntime.value.cwd,
          detail: error.message,
        }),
      ),
    )
  })

  const ensurePreTurnBaselineFromDomainTurnStart = Effect.fn(
    'ensurePreTurnBaselineFromDomainTurnStart',
  )(function* (
    event: Extract<
      OrchestrationEvent,
      { type: 'thread.turn-start-requested' | 'thread.message-sent' }
    >,
    targetCheckpointRef?: CheckpointRef,
  )
  {
    if (event.type === 'thread.message-sent' && !isCheckpointBaselineMessage(event))
    {
      return
    }

    const threadId = event.payload.threadId
    const thread = yield* resolveThreadDetail(threadId)
    if (!thread)
    {
      return
    }
    if (thread.origin !== null && thread.latestTurn === null)
    {
      return
    }

    const projects = yield* resolveThreadProjects(thread.projectId)
    const checkpointCwd = yield* resolveCheckpointCwd({
      threadId,
      thread,
      projects,
      preferSessionRuntime: false,
    })
    if (!checkpointCwd)
    {
      return
    }

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    )
    const baselineCheckpointRef =
      targetCheckpointRef ?? checkpointRefForThreadTurn(threadId, currentTurnCount)
    const baselineExists = yield* checkpointStore.hasCheckpointRef({
      cwd: checkpointCwd,
      checkpointRef: baselineCheckpointRef,
    })
    if (baselineExists)
    {
      return
    }

    const publication = yield* checkpointStore.captureCheckpoint({
      cwd: checkpointCwd,
      checkpointRef: baselineCheckpointRef,
      expected: { kind: 'absent' },
    })
    if (publication.outcome === 'lost-race')
    {
      return
    }
    yield* receiptBus.publish({
      type: 'checkpoint.baseline.captured',
      threadId,
      checkpointTurnCount: currentTurnCount,
      checkpointRef: baselineCheckpointRef,
      createdAt: event.occurredAt,
    })
  })

  // a durable baseline action serializes the ref it selected from the live
  // projection at plan time. a lane that executes later can find the projection
  // already past that boundary, which would capture post-turn bytes under a
  // pre-turn ref, so the boundary is re-derived here before anything is written.
  const validatePlannedBaseline = Effect.fn('validatePlannedBaseline')(function* (input: {
    readonly threadId: ThreadId
    readonly sourceSequence: number
    readonly targetCheckpointRef: CheckpointRef
  })
  {
    // the projection must already contain the event that planned this action,
    // otherwise the boundary would be derived from state that predates it
    const snapshot = yield* projectionSnapshotQuery.getSnapshotSequence()
    if (snapshot.snapshotSequence < input.sourceSequence)
    {
      return yield* new CheckpointOperationError({
        detail:
          `Checkpoint baseline for '${input.targetCheckpointRef}' cannot be validated: ` +
          `projection is at sequence ${snapshot.snapshotSequence}, ` +
          `behind source sequence ${input.sourceSequence}.`,
      })
    }

    const thread = yield* resolveThreadDetail(input.threadId)
    const currentTurnCount =
      thread?.checkpoints.reduce(
        (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
        0,
      ) ?? 0
    const boundary: PlannedBaselineBoundary =
      checkpointRefForThreadTurn(input.threadId, currentTurnCount) === input.targetCheckpointRef
        ? 'current'
        : 'superseded'
    return boundary
  })

  const recordPhaseFailure = (operation: CheckpointRevertOperation, cause: unknown) =>
    Effect.flatMap(nowIso, (now) =>
      checkpointRevertOperations.casTransition({
        operationId: operation.operationId,
        expectedPhase: operation.phase,
        nextPhase: operation.phase,
        patch: {
          lastError: errorDetail(cause),
          ...(operation.phase === 'cleanup-pending' ? { cleanupStatus: 'retryable' } : {}),
        },
        now,
      }),
    )

  const withJournalRetry = <A, E, R>(
    operation: CheckpointRevertOperation,
    effect: Effect.Effect<A, E, R>,
  ) => effect.pipe(Effect.tapError((cause) => recordPhaseFailure(operation, cause)))

  const driveCheckpointRevertPhase = Effect.fn('driveCheckpointRevertPhase')(function* (
    operation: CheckpointRevertOperation,
  )
  {
    const transition = (
      nextPhase: CheckpointRevertOperation['phase'],
      patch?: Parameters<typeof checkpointRevertOperations.casTransition>[0]['patch'],
    ) =>
      Effect.flatMap(nowIso, (now) =>
        checkpointRevertOperations.casTransition({
          operationId: operation.operationId,
          expectedPhase: operation.phase,
          nextPhase,
          ...(patch === undefined ? {} : { patch }),
          now,
        }),
      )

    switch (operation.phase)
    {
      case 'admitted':
        return yield* withJournalRetry(
          operation,
          Effect.gen(function* ()
          {
            const repository = yield* vcsRegistry.resolve({
              cwd: operation.cwd,
              requestedKind: 'git',
            })
            if (repository.repository.metadataPath === null)
            {
              return yield* new CheckpointOperationError({
                detail: `Checkpoint revert '${operation.operationId}' could not resolve the Git common directory.`,
              })
            }
            const repositoryCommonDir = path.isAbsolute(repository.repository.metadataPath)
              ? path.normalize(repository.repository.metadataPath)
              : path.resolve(operation.cwd, repository.repository.metadataPath)
            const stagePath = path.join(
              serverConfig.stateDir,
              REVERT_STAGE_DIRECTORY,
              encodeURIComponent(operation.operationId),
            )

            // admitted retries own this directory and can safely replace a partial stage.
            yield* fileSystem.remove(stagePath, { recursive: true, force: true })
            yield* fileSystem.makeDirectory(stagePath, { recursive: true })
            const verification = yield* checkpointStore.stageCheckpointTree({
              cwd: operation.cwd,
              ref: CheckpointRef.make(operation.targetRef),
              stagePath,
            })
            return yield* transition('target-staged', {
              targetTree: verification.treeOid,
              repositoryCommonDir,
              stagePath,
              lastError: null,
            })
          }),
        )

      case 'target-staged':
        return yield* withJournalRetry(
          operation,
          Effect.gen(function* ()
          {
            if (operation.targetTree === null || operation.stagePath === null)
            {
              return yield* new CheckpointOperationError({
                detail: `Checkpoint revert '${operation.operationId}' is missing staged target metadata.`,
              })
            }
            const preflight = yield* checkpointStore.verifyRestorePreconditions({
              cwd: operation.cwd,
              ref: CheckpointRef.make(operation.targetRef),
            })
            if (preflight.treeOid !== operation.targetTree)
            {
              return yield* new CheckpointOperationError({
                detail: `Checkpoint revert '${operation.operationId}' target changed after staging.`,
              })
            }
            return yield* transition('restore-ready', { lastError: null })
          }),
        )

      case 'restore-ready':
        return yield* transition('restore-started', { lastError: null })

      case 'restore-started':
        return yield* withJournalRetry(
          operation,
          Effect.gen(function* ()
          {
            if (operation.targetTree === null || operation.stagePath === null)
            {
              return yield* new CheckpointOperationError({
                detail: `Checkpoint revert '${operation.operationId}' is missing restore metadata.`,
              })
            }
            const restored = yield* checkpointStore.applyStagedRestore({
              cwd: operation.cwd,
              ref: CheckpointRef.make(operation.targetRef),
              stagePath: operation.stagePath,
            })
            if (restored.treeOid !== operation.targetTree)
            {
              return yield* new CheckpointOperationError({
                detail: `Checkpoint revert '${operation.operationId}' restored an unexpected Git tree.`,
              })
            }
            const verification = yield* checkpointStore.postVerifyRestore({
              cwd: operation.cwd,
              ref: CheckpointRef.make(operation.targetRef),
            })
            if (verification.treeOid !== operation.targetTree)
            {
              return yield* new CheckpointOperationError({
                detail: `Checkpoint revert '${operation.operationId}' failed post-restore verification.`,
              })
            }
            return yield* transition('filesystem-restored', { lastError: null })
          }),
        )

      case 'filesystem-restored':
        return yield* withJournalRetry(
          operation,
          Effect.gen(function* ()
          {
            yield* workspaceEntries.refresh(operation.cwd)
            const threadId = ThreadId.make(operation.threadId)
            const thread = yield* resolveThreadDetail(threadId)
            if (!thread)
            {
              return yield* new CheckpointOperationError({
                detail: `Checkpoint revert '${operation.operationId}' thread is unavailable during provider preparation.`,
              })
            }
            const sessionRuntime = yield* resolveSessionRuntimeForThread(threadId)
            if (Option.isNone(sessionRuntime))
            {
              return yield* new CheckpointOperationError({
                detail: `Checkpoint revert '${operation.operationId}' provider session is unavailable.`,
              })
            }
            const providerInstanceId =
              sessionRuntime.value.providerInstanceId ??
              thread.session?.providerInstanceId ??
              thread.modelSelection.instanceId
            const capabilities = yield* providerService.getCapabilities(providerInstanceId)
            const currentTurnCount = thread.checkpoints.reduce(
              (maximum, checkpoint) => Math.max(maximum, checkpoint.checkpointTurnCount),
              0,
            )
            const staleRefs = thread.checkpoints
              .filter((checkpoint) => checkpoint.checkpointTurnCount > operation.targetTurnCount)
              .map((checkpoint) => String(checkpoint.checkpointRef))
            const detail: ProviderRollbackJournalDetail = {
              version: 1,
              capability: rollbackCapabilityFrom(capabilities),
              state: 'pending',
              rolledBackTurns: Math.max(0, currentTurnCount - operation.targetTurnCount),
              staleRefs,
              detail: null,
            }
            return yield* transition('provider-pending', {
              providerInstanceId,
              providerSessionId: sessionRuntime.value.providerSessionId ?? null,
              providerThreadId: sessionRuntime.value.threadId,
              providerOutcomeJson: encodeProviderRollbackJournalDetail(detail),
              lastError: null,
            })
          }),
        )

      case 'provider-pending':
        return yield* withJournalRetry(
          operation,
          Effect.gen(function* ()
          {
            const detail = yield* decodeProviderRollbackJournalDetailEffect(operation)
            const recordOutcome = (
              outcome: 'exact' | 'known-unsupported' | 'manual-unknown',
              outcomeDetail: string | null,
            ) =>
              Effect.flatMap(nowIso, (now) =>
                checkpointRevertOperations.recordProviderOutcome({
                  operationId: operation.operationId,
                  outcome,
                  outcomeJson: encodeProviderRollbackJournalDetail({
                    ...detail,
                    state: 'recorded',
                    detail: outcomeDetail,
                  }),
                  providerInstanceId: operation.providerInstanceId,
                  providerSessionId: operation.providerSessionId,
                  providerThreadId: operation.providerThreadId,
                  now,
                }),
              )

            if (detail.capability === 'known-unsupported')
            {
              return yield* recordOutcome(
                'known-unsupported',
                'The bound provider declares that conversation rollback is unsupported.',
              )
            }
            if (detail.rolledBackTurns === 0)
            {
              return yield* recordOutcome('exact', null)
            }
            if (detail.state === 'attempt-started')
            {
              return yield* recordOutcome(
                'manual-unknown',
                'A previous provider rollback attempt did not record a definitive result.',
              )
            }

            const attemptStarted = yield* transition('provider-pending', {
              providerOutcomeJson: encodeProviderRollbackJournalDetail({
                ...detail,
                state: 'attempt-started',
              }),
              lastError: null,
            })
            const attemptDetail = yield* decodeProviderRollbackJournalDetailEffect(attemptStarted)
            const rollbackError = yield* providerService
              .rollbackConversation({
                threadId: ThreadId.make(operation.threadId),
                numTurns: detail.rolledBackTurns,
              })
              .pipe(
                Effect.as(null),
                // defects are as indeterminate as typed failures here, and the
                // attempt-started marker is already written, so catch the whole
                // cause rather than letting a defect escape into a retry that
                // would re-issue a rollback that may have already landed
                Effect.catchCause((cause) => Effect.succeed(errorDetail(Cause.squash(cause)))),
              )
            return yield* Effect.flatMap(nowIso, (now) =>
              checkpointRevertOperations.recordProviderOutcome({
                operationId: operation.operationId,
                outcome: rollbackError === null ? 'exact' : 'manual-unknown',
                outcomeJson: encodeProviderRollbackJournalDetail({
                  ...attemptDetail,
                  state: 'recorded',
                  detail: rollbackError,
                }),
                providerInstanceId: operation.providerInstanceId,
                providerSessionId: operation.providerSessionId,
                providerThreadId: operation.providerThreadId,
                now,
              }),
            )
          }),
        )

      case 'provider-outcome-recorded':
        return yield* withJournalRetry(
          operation,
          Effect.gen(function* ()
          {
            const detail = yield* decodeProviderRollbackJournalDetailEffect(operation)
            const createdAt = yield* nowIso
            if (operation.providerOutcome === 'manual-unknown')
            {
              const failureDetail =
                detail.detail ??
                'Provider rollback is indeterminate and requires manual operator resolution.'
              yield* appendRevertFailureActivity({
                threadId: ThreadId.make(operation.threadId),
                turnCount: operation.targetTurnCount,
                detail: failureDetail,
                createdAt,
                actionId: operation.operationId,
              })
              return yield* checkpointRevertOperations.markManual({
                operationId: operation.operationId,
                expectedPhase: 'provider-outcome-recorded',
                error: failureDetail,
                now: yield* nowIso,
              })
            }
            if (operation.providerOutcome === 'known-unsupported')
            {
              yield* appendProviderRollbackNotice({
                operationId: operation.operationId,
                threadId: ThreadId.make(operation.threadId),
                turnCount: operation.targetTurnCount,
                detail:
                  detail.detail ??
                  'The filesystem was restored, but this provider cannot roll back its conversation.',
                createdAt,
              })
            }

            yield* orchestrationEngine.dispatch({
              type: 'thread.revert.complete',
              commandId: yield* commandIdFor('checkpoint-revert-complete', operation.operationId),
              threadId: ThreadId.make(operation.threadId),
              turnCount: operation.targetTurnCount,
              createdAt,
            })
            return yield* transition('projection-finalized', {
              projectionStatus: 'finalized',
              lastError: null,
            })
          }),
        )

      case 'projection-finalized':
      {
        const detail = yield* decodeProviderRollbackJournalDetailEffect(operation)
        return yield* withJournalRetry(
          operation,
          Effect.flatMap(nowIso, (now) =>
            checkpointRevertOperations.recordStaleRefs({
              operationId: operation.operationId,
              staleRefs: [...detail.staleRefs],
              now,
            }),
          ),
        )
      }

      case 'cleanup-pending':
        return yield* withJournalRetry(
          operation,
          Effect.gen(function* ()
          {
            const staleRefs =
              operation.staleRefsJson === null
                ? []
                : yield* Schema.decodeUnknownEffect(
                    Schema.fromJsonString(Schema.Array(Schema.String)),
                  )(operation.staleRefsJson).pipe(
                    Effect.mapError(
                      () =>
                        new CheckpointOperationError({
                          detail: `Checkpoint revert '${operation.operationId}' has invalid stale checkpoint refs.`,
                        }),
                    ),
                  )
            if (staleRefs.length > 0)
            {
              yield* checkpointStore.deleteCheckpointRefs({
                cwd: operation.cwd,
                checkpointRefs: staleRefs.map((ref) => CheckpointRef.make(ref)),
              })
            }
            if (operation.stagePath !== null)
            {
              yield* fileSystem.remove(operation.stagePath, { recursive: true, force: true })
            }
            return yield* transition('completed', {
              cleanupStatus: 'completed',
              lastError: null,
            })
          }),
        )

      case 'completed':
      case 'aborted':
      case 'manual-required':
        return operation
    }
  })

  const driveCheckpointRevert = Effect.fn('driveCheckpointRevert')(function* (
    initialOperation: CheckpointRevertOperation,
  )
  {
    let operation = initialOperation
    while (
      operation.phase !== 'completed' &&
      operation.phase !== 'aborted' &&
      operation.phase !== 'manual-required'
    )
    {
      operation = yield* driveCheckpointRevertPhase(operation)
    }
    return operation
  })

  const handleRevertRequested = Effect.fn('handleRevertRequested')(function* (
    event: Extract<OrchestrationEvent, { type: 'thread.checkpoint-revert-requested' }>,
    actionId?: string,
  )
  {
    const now = yield* nowIso
    const failureActionId = actionId ?? String(event.commandId ?? event.eventId)
    const failVisibly = (detail: string) =>
      appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail,
        createdAt: now,
        actionId: failureActionId,
      }).pipe(Effect.catch(() => Effect.void))

    const thread = yield* resolveThreadDetail(event.payload.threadId)
    if (!thread)
    {
      yield* failVisibly('Thread was not found in read model.')
      return
    }
    const sessionRuntime = yield* resolveSessionRuntimeForThread(event.payload.threadId)
    if (Option.isNone(sessionRuntime))
    {
      yield* failVisibly('No active provider session with workspace cwd is bound to this thread.')
      return
    }
    if (!isGitWorkspace(sessionRuntime.value.cwd))
    {
      yield* failVisibly(
        'Checkpoints are unavailable because this project is not a git repository.',
      )
      return
    }

    const currentTurnCount = thread.checkpoints.reduce(
      (maximum, checkpoint) => Math.max(maximum, checkpoint.checkpointTurnCount),
      0,
    )
    if (event.payload.turnCount > currentTurnCount)
    {
      yield* failVisibly(
        `Checkpoint turn count ${event.payload.turnCount} exceeds current turn count ${currentTurnCount}.`,
      )
      return
    }
    const targetCheckpointRef =
      event.payload.turnCount === 0
        ? checkpointRefForThreadTurn(event.payload.threadId, 0)
        : thread.checkpoints.find(
            (checkpoint) => checkpoint.checkpointTurnCount === event.payload.turnCount,
          )?.checkpointRef
    if (!targetCheckpointRef)
    {
      yield* failVisibly(
        `Checkpoint ref for turn ${event.payload.turnCount} is unavailable in read model.`,
      )
      return
    }
    if (event.commandId === null)
    {
      yield* failVisibly('Checkpoint revert request is missing its originating command id.')
      return
    }

    const operationId = checkpointRevertOperationId(event.commandId)
    const admitted = yield* checkpointRevertOperations
      .admit({
        operationId,
        threadId: event.payload.threadId,
        targetRef: targetCheckpointRef,
        targetTurnCount: event.payload.turnCount,
        cwd: sessionRuntime.value.cwd,
        now,
      })
      .pipe(
        Effect.map(Option.some),
        Effect.catchTag('CheckpointRevertOperationConflictError', (conflict) =>
          failVisibly(conflict.message).pipe(Effect.as(Option.none())),
        ),
      )
    if (Option.isNone(admitted))
    {
      return
    }
    yield* driveCheckpointRevert(admitted.value)
  })

  const processRuntimeEvent = Effect.fn('processRuntimeEvent')(function* (
    event: ProviderRuntimeEvent,
  )
  {
    if (isHiddenTurnRuntimeEvent(event))
    {
      return
    }
    if (event.type === 'turn.started')
    {
      yield* ensurePreTurnBaselineFromTurnStart(event)
      yield* beginImplementationAttemptFromTurnStart(event).pipe(
        Effect.catch((error) =>
          Effect.logWarning('proposal implementation attempt start failed', {
            threadId: event.threadId,
            turnId: event.turnId ?? null,
            detail: error.message,
          }),
        ),
      )
      return
    }

    if (event.type === 'turn.completed')
    {
      const turnId = toTurnId(event.turnId)
      yield* refreshLocalGitStatusFromTurnCompletion(event)
      yield* captureCheckpointFromTurnCompletion(event).pipe(
        Effect.catch((error) =>
          Effect.flatMap(nowIso, (createdAt) =>
            appendCaptureFailureActivity({
              threadId: event.threadId,
              turnId,
              detail: error.message,
              createdAt,
            }).pipe(Effect.catch(() => Effect.void)),
          ),
        ),
      )
      return
    }
  })

  const processRuntimeEventSafely = (event: ProviderRuntimeEvent) =>
    processRuntimeEvent(event).pipe(
      Effect.catchCause((cause) =>
      {
        if (Cause.hasInterruptsOnly(cause))
        {
          return Effect.failCause(cause)
        }
        return Effect.logWarning('checkpoint reactor failed to process runtime input', {
          eventType: event.type,
          cause: Cause.pretty(cause),
        })
      }),
    )

  const runtimeWorker = yield* makeDrainableWorker(processRuntimeEventSafely)

  const definition: DurableReactorDefinition = {
    reactorId: REACTOR_ID,
    operationVersion: OPERATION_VERSION,
    plan: (event) =>
    {
      if (
        (event.type === 'thread.message-sent' && isCheckpointBaselineMessage(event)) ||
        event.type === 'thread.turn-start-requested'
      )
      {
        return Effect.gen(function* ()
        {
          const thread = yield* resolveThreadDetail(event.payload.threadId)
          const currentTurnCount =
            thread?.checkpoints.reduce(
              (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
              0,
            ) ?? 0
          const targetCheckpointRef = checkpointRefForThreadTurn(
            event.payload.threadId,
            currentTurnCount,
          )
          const payloadJson = yield* encodeDomainActionPayload({
            event,
            targetCheckpointRef,
          })
          return [
            {
              outputIndex: 0,
              effectKind: 'checkpoint.baseline.capture',
              targetKind: 'checkpoint-ref',
              targetId: targetCheckpointRef,
              payloadJson,
            },
          ]
        })
      }
      if (event.type === 'thread.checkpoint-revert-requested')
      {
        const targetCheckpointRef = checkpointRefForThreadTurn(
          event.payload.threadId,
          event.payload.turnCount,
        )
        return encodeDomainActionPayload({ event, targetCheckpointRef }).pipe(
          Effect.map((payloadJson) => [
            {
              outputIndex: 0,
              effectKind: 'checkpoint.revert',
              targetKind: 'checkpoint-ref',
              targetId: targetCheckpointRef,
              payloadJson,
            },
          ]),
        )
      }
      if (event.type === 'thread.turn-diff-completed' && event.payload.status === 'missing')
      {
        const targetCheckpointRef = checkpointRefForThreadTurn(
          event.payload.threadId,
          event.payload.checkpointTurnCount,
        )
        return encodeDomainActionPayload({ event, targetCheckpointRef }).pipe(
          Effect.map((payloadJson) => [
            {
              outputIndex: 0,
              effectKind: 'checkpoint.placeholder.capture',
              targetKind: 'checkpoint-ref',
              targetId: targetCheckpointRef,
              payloadJson,
            },
          ]),
        )
      }
      if (event.type === 'thread.turn-diff-completed' && event.payload.status === 'ready')
      {
        return encodeDomainActionPayload({
          event,
          targetCheckpointRef: event.payload.checkpointRef,
        }).pipe(
          Effect.map((payloadJson) => [
            {
              outputIndex: 0,
              effectKind: 'proposal-implementation.complete',
              targetKind: 'checkpoint-ref',
              targetId: event.payload.checkpointRef,
              payloadJson,
            },
          ]),
        )
      }
      return Effect.succeed([])
    },
    execute: Effect.fn('CheckpointReactor.executeDomainAction')(function* (action)
    {
      const payload = yield* decodeDomainActionPayload(action.payloadJson)
      if (payload.targetCheckpointRef !== action.targetId)
      {
        return yield* new CheckpointDomainPayloadError({
          detail: `Action ${action.actionId} does not match its checkpoint ref target.`,
        })
      }
      const event = payload.event

      switch (action.effectKind)
      {
        case 'checkpoint.baseline.capture':
          if (
            event.type !== 'thread.turn-start-requested' &&
            event.type !== 'thread.message-sent'
          )
          {
            return yield* new CheckpointDomainPayloadError({
              detail: `Action ${action.actionId} does not contain a baseline event.`,
            })
          }
          if (event.type === 'thread.turn-start-requested')
          {
            pendingImplementationRequests.set(event.payload.threadId, {
              requestedAt: event.payload.createdAt,
              ...(event.payload.sourceProposedPlan === undefined
                ? {}
                : { sourceProposedPlan: event.payload.sourceProposedPlan }),
            })
          }
          {
            const boundary = yield* validatePlannedBaseline({
              threadId: event.payload.threadId,
              sourceSequence: action.sourceSequence,
              targetCheckpointRef: payload.targetCheckpointRef,
            })
            // the projection moved on while this action waited, so the planned
            // ref no longer denotes a pre-turn boundary; the turn that advanced
            // it owns its own baseline and this snapshot is dropped
            if (boundary === 'superseded')
            {
              yield* Effect.logWarning('checkpoint baseline skipped: planned boundary superseded', {
                threadId: event.payload.threadId,
                actionId: action.actionId,
                sourceSequence: action.sourceSequence,
                checkpointRef: payload.targetCheckpointRef,
              })
              break
            }
          }
          yield* ensurePreTurnBaselineFromDomainTurnStart(event, payload.targetCheckpointRef)
          break
        case 'checkpoint.placeholder.capture':
          if (
            event.type !== 'thread.turn-diff-completed' ||
            event.payload.status !== 'missing' ||
            payload.targetCheckpointRef !==
              checkpointRefForThreadTurn(event.payload.threadId, event.payload.checkpointTurnCount)
          )
          {
            return yield* new CheckpointDomainPayloadError({
              detail: `Action ${action.actionId} does not contain a placeholder checkpoint event.`,
            })
          }
          yield* captureCheckpointFromPlaceholder(event, action.actionId).pipe(
            Effect.catch((error) =>
              Effect.flatMap(nowIso, (createdAt) =>
                appendCaptureFailureActivity({
                  threadId: event.payload.threadId,
                  turnId: event.payload.turnId,
                  detail: error.message,
                  createdAt,
                  actionId: action.actionId,
                }).pipe(
                  Effect.catch(() => Effect.void),
                  Effect.andThen(Effect.fail(error)),
                ),
              ),
            ),
          )
          break
        case 'proposal-implementation.complete':
          if (
            event.type !== 'thread.turn-diff-completed' ||
            event.payload.status !== 'ready' ||
            payload.targetCheckpointRef !== event.payload.checkpointRef
          )
          {
            return yield* new CheckpointDomainPayloadError({
              detail: `Action ${action.actionId} does not contain a ready checkpoint event.`,
            })
          }
          yield* completeImplementationAttemptFromCheckpoint(event)
          break
        case 'checkpoint.revert':
          if (
            event.type !== 'thread.checkpoint-revert-requested' ||
            payload.targetCheckpointRef !==
              checkpointRefForThreadTurn(event.payload.threadId, event.payload.turnCount)
          )
          {
            return yield* new CheckpointDomainPayloadError({
              detail: `Action ${action.actionId} does not contain a checkpoint revert event.`,
            })
          }
          yield* handleRevertRequested(event, action.actionId).pipe(
            Effect.catch((error) =>
              Effect.flatMap(nowIso, (createdAt) =>
                appendRevertFailureActivity({
                  threadId: event.payload.threadId,
                  turnCount: event.payload.turnCount,
                  detail: error.message,
                  createdAt,
                  actionId: action.actionId,
                }).pipe(
                  Effect.catch(() => Effect.void),
                  Effect.andThen(Effect.fail(error)),
                ),
              ),
            ),
          )
          break
        default:
          return yield* new CheckpointDomainPayloadError({
            detail: `Unsupported checkpoint domain effect kind '${action.effectKind}'.`,
          })
      }

      return { status: 'succeeded' as const }
    }),
    classify: (cause, _action) =>
    {
      if (isCheckpointDomainPayloadError(cause))
      {
        return 'poison'
      }
      return 'retryable'
    },
    onLeaseExpiry: 'retryable',
  }

  const start: CheckpointReactorShape['start'] = Effect.fn('CheckpointReactor.start')(function* ()
  {
    const startedAt = yield* nowIso
    // an install that predates this reactor's journal has no progress row, and
    // seeding it at 0 would replay every historical event as if unhandled -
    // re-capturing checkpoints against today's files and re-admitting reverts
    // that already completed. start at what the projection has already applied
    const existingProgress = yield* delivery.getProgress(REACTOR_ID)
    const initialSequence = Option.isSome(existingProgress)
      ? 0
      : (yield* projectionSnapshotQuery.getSnapshotSequence().pipe(
          Effect.mapError(
            (cause) =>
              new ReactorDeliveryError({
                operation: 'CheckpointReactor.start:initialSequence',
                cause,
              }),
          ),
        )).snapshotSequence
    const progress = yield* delivery.ensureProgress({
      reactorId: REACTOR_ID,
      operationVersion: OPERATION_VERSION,
      initialSequence,
      mode: 'durable',
      now: startedAt,
    })
    if (progress.mode === 'shadow')
    {
      yield* delivery.setMode({
        reactorId: REACTOR_ID,
        mode: 'durable',
        ownerId: `${REACTOR_ID}:cutover`,
        now: startedAt,
      })
    }

    const resumableReverts = yield* checkpointRevertOperations.listResumable()
    yield* Effect.forEach(
      resumableReverts,
      (operation) =>
      {
        if (operation.manualRequired)
        {
          return Effect.void
        }
        return driveCheckpointRevert(operation).pipe(
          Effect.catch((cause) =>
            Effect.gen(function* ()
            {
              const createdAt = yield* nowIso
              yield* appendRevertFailureActivity({
                threadId: ThreadId.make(operation.threadId),
                turnCount: operation.targetTurnCount,
                detail: errorDetail(cause),
                createdAt,
                actionId: operation.operationId,
              }).pipe(Effect.catch(() => Effect.void))
              yield* Effect.logWarning('checkpoint revert resume failed', {
                operationId: operation.operationId,
                phase: operation.phase,
                detail: errorDetail(cause),
              })
            }),
          ),
        )
      },
      { discard: true },
    )
    yield* durableRunner.start(definition)

    yield* Effect.forkScoped(
      Stream.runForEach(providerService.streamEvents, (event) =>
      {
        if (event.type !== 'turn.started' && event.type !== 'turn.completed')
        {
          return Effect.void
        }
        return runtimeWorker.enqueue(event)
      }),
    )
  })

  return {
    start,
    drain: runtimeWorker.drain.pipe(Effect.andThen(durableRunner.drain(REACTOR_ID))),
  } satisfies CheckpointReactorShape
})

export const CheckpointReactorLive = Layer.effect(CheckpointReactor, make).pipe(
  Layer.provideMerge(DurableReactorInfrastructureLive),
)
