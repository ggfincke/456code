// apps/server/src/orchestration/Layers/CheckpointReactor.ts
// captures and restores git checkpoints in response to orchestration events
import {
  CommandId,
  CheckpointRef,
  EventId,
  MessageId,
  type OrchestrationProposedPlanId,
  type OrchestrationThreadActivity,
  type ProjectId,
  ProviderInstanceId,
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
import { collectToolMutationTargets } from '@t3tools/shared/toolMutationTargets'

import { parseTurnDiffFilesFromUnifiedDiff } from '../../checkpointing/Diffs.ts'
import { CheckpointIdentityResolver } from '../../checkpointing/CheckpointIdentity.ts'
import type { CheckpointStoreError } from '../../checkpointing/Errors.ts'
import { checkpointRefForThreadTurn, resolveThreadWorkspaceCwd } from '../../checkpointing/Utils.ts'
import * as CheckpointStore from '../../checkpointing/CheckpointStore.ts'
import { ServerConfig } from '../../config.ts'
import {
  CheckpointRevertOperations,
  type CheckpointRevertOperation,
} from '../../persistence/Services/CheckpointRevertOperations.ts'
import {
  ProviderRuntimeInbox,
  type ProviderRuntimeSessionIdentity,
} from '../../persistence/Services/ProviderRuntimeInbox.ts'
import { ProviderService } from '../../provider/Services/ProviderService.ts'
import { CheckpointReactor, type CheckpointReactorShape } from '../Services/CheckpointReactor.ts'
import {
  DurableReactorRunner,
  type DurableReactorDefinition,
} from '../Services/DurableReactorRunner.ts'
import { OrchestrationEngineService } from '../Services/OrchestrationEngine.ts'
import { ProjectionSnapshotQuery } from '../Services/ProjectionSnapshotQuery.ts'
import { RuntimeReceiptBus } from '../Services/RuntimeReceiptBus.ts'
import {
  PROVIDER_RUNTIME_CHECKPOINT_REACTOR_ID,
  PROVIDER_RUNTIME_INGESTION_REACTOR_ID,
  PROVIDER_RUNTIME_INBOX_OPERATION_VERSION,
  ProviderRuntimeInboxRunner,
  type ProviderRuntimeInboxConsumerDefinition,
} from '../Services/ProviderRuntimeInboxRunner.ts'
import { ProposalImplementationAttemptService } from '../../proposal/ProposalImplementationAttemptService.ts'
import { VcsStatusBroadcaster } from '../../vcs/VcsStatusBroadcaster.ts'
import * as VcsDriverRegistry from '../../vcs/VcsDriverRegistry.ts'
import * as WorkspaceEntries from '../../workspace/WorkspaceEntries.ts'
import { isHiddenTurnRuntimeEvent } from '../../provider/HiddenTurnRegistry.ts'
import { ReactorDeliveryError } from '../../persistence/Errors.ts'
import { OrchestrationReactorDelivery } from '../../persistence/Services/OrchestrationReactorDelivery.ts'
import { DurableReactorInfrastructureLive } from './OrchestrationReactor.ts'
import { runtimeEventMatchesThreadProviderInstance } from './ProviderRuntimeEventMapping.ts'
import {
  checkpointRevertOperationId,
  decodeProviderRollbackJournalDetail,
  encodeProviderRollbackJournalDetail,
  errorDetail,
  isCheckpointBaselineMessage,
  rollbackCapabilityFrom,
  type ProviderRollbackJournalDetail,
} from './CheckpointRollbackJournal.ts'

const nowIso = Effect.map(DateTime.now, DateTime.formatIso)
const REACTOR_ID = 'checkpoint-domain' as const
const OPERATION_VERSION = 1
const REVERT_STAGE_DIRECTORY = 'checkpoint-reverts'
const DomainActionPayload = Schema.fromJsonString(
  Schema.Struct({
    event: OrchestrationEvent,
    targetCheckpointRef: CheckpointRef,
  }),
)
const encodeDomainActionPayload = Schema.encodeEffect(DomainActionPayload)
const decodeDomainActionPayload = Schema.decodeUnknownEffect(DomainActionPayload)
const RuntimeCheckpointBufferState = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Literal(1) }),
)
const decodeRuntimeCheckpointBufferState = Schema.decodeUnknownEffect(RuntimeCheckpointBufferState)
const RUNTIME_CHECKPOINT_BUFFER_JSON = '{"version":1}'

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

class CheckpointRuntimeConsumerError extends Schema.TaggedErrorClass<CheckpointRuntimeConsumerError>()(
  'CheckpointRuntimeConsumerError',
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
)
{
  override get message(): string
  {
    return this.detail
  }
}

const isCheckpointDomainPayloadErrorInstance = Schema.is(CheckpointDomainPayloadError)
const isCheckpointRuntimeConsumerError = Schema.is(CheckpointRuntimeConsumerError)

function isCheckpointDomainPayloadError(cause: unknown): boolean
{
  return Schema.isSchemaError(cause) || isCheckpointDomainPayloadErrorInstance(cause)
}

// whether a planned baseline ref still denotes the projection's current
// pre-turn boundary at the moment its durable action runs
type PlannedBaselineBoundary = 'current' | 'superseded'

function decodeProviderRollbackJournalDetailEffect(operation: CheckpointRevertOperation)
{
  return Effect.try({
    try: () => decodeProviderRollbackJournalDetail(operation),
    catch: (cause) => new CheckpointOperationError({ detail: errorDetail(cause) }),
  })
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

// a turn diff entry as this reactor builds it, plus whether the diff could be
// computed at all
interface TurnDiffFile
{
  readonly path: string
  readonly kind: 'modified'
  readonly additions: number
  readonly deletions: number
}

interface TurnDiffOutcome
{
  readonly derived: boolean
  readonly files: ReadonlyArray<TurnDiffFile>
}

interface DivergenceCheckInput
{
  readonly threadId: ThreadId
  readonly turnId: TurnId
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>
  readonly watchedCwd: string | undefined
  readonly createdAt: string
  readonly actionId?: string | undefined
}

// a tree that a turn wrote to, paired with the git common directory that
// identifies the repository owning it. every worktree of one repository reports
// the main checkout's common dir, and that is the only signal separating a
// sibling worktree the thread may adopt from an unrelated repository it must not
interface MutationRepository
{
  readonly rootPath: string
  readonly commonDir: string | null
}

// scratch trees the app deliberately does not watch. a write here is never the
// work the user was waiting to see, and suppressing them is what takes the
// alarm from 50% precision to no measured false positives.
// both the logical and the resolved form of each macOS temp root are listed:
// /tmp and /var are symlinks into /private, and a path that reached the payload
// through realpath arrives in the /private form
const EPHEMERAL_MUTATION_PREFIXES = [
  '/tmp/',
  '/private/tmp/',
  '/var/folders/',
  '/private/var/folders/',
] as const

// matched anywhere in the path so no home directory lookup is needed
const EPHEMERAL_MUTATION_SEGMENTS = ['/.claude/', '/.codex/'] as const

function isEphemeralMutationPath(value: string): boolean
{
  return (
    EPHEMERAL_MUTATION_PREFIXES.some((prefix) => value.startsWith(prefix)) ||
    EPHEMERAL_MUTATION_SEGMENTS.some((segment) => value.includes(segment))
  )
}

// only the completed row counts. a tool.started row carries no data at all, and
// a tool.updated row is emitted while the arguments are still streaming, so both
// describe an edit that has not run yet: an edit the user then denies would
// otherwise be indistinguishable from one that landed
const MUTATION_EVIDENCE_ACTIVITY_KINDS: ReadonlySet<string> = new Set(['tool.completed'])

// what a turn demonstrably wrote, read back off its own activity rows
interface TurnMutationEvidence
{
  readonly mutatedPaths: ReadonlyArray<string>
  readonly editWorkerRepos: ReadonlyArray<string>
}

// activity payloads are Schema.Unknown, so every property read below has to be
// guarded; an unguarded read would throw inside the reactor's runtime fiber,
// where it is swallowed into a log warning and the capture tail silently stops
function asPayloadRecord(value: unknown): Record<string, unknown> | null
{
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

// the two adapters shape an mcp tool call differently: the claude adapter puts
// the tool name at data.toolName with the arguments at data.input, while the
// codex adapter forwards the raw item, so the same fields sit under data.item.
// probing both is the only way the alarm sees an edit worker on either provider
function mcpToolCallNames(data: Record<string, unknown>): ReadonlyArray<string>
{
  const item = asPayloadRecord(data.item)
  return [data.toolName, data.tool, item?.tool].filter(
    (value): value is string => typeof value === 'string',
  )
}

function mcpToolCallArguments(
  data: Record<string, unknown>,
): ReadonlyArray<Record<string, unknown>>
{
  const item = asPayloadRecord(data.item)
  return [
    asPayloadRecord(data.input),
    asPayloadRecord(data.arguments),
    item === null ? null : asPayloadRecord(item.input),
    item === null ? null : asPayloadRecord(item.arguments),
  ].filter((record): record is Record<string, unknown> => record !== null)
}

// an edit-mode broker worker is handed a repo it may rewrite, so the repo is
// mutation evidence even when the worker's own edits never reach this thread
function editWorkerRepoFrom(data: Record<string, unknown>): string | null
{
  if (!mcpToolCallNames(data).some((name) => name.endsWith('start_worker')))
  {
    return null
  }
  for (const record of mcpToolCallArguments(data))
  {
    if (record.mode !== 'edit' || typeof record.repo !== 'string')
    {
      continue
    }
    const repo = record.repo.trim()
    if (repo.length > 0)
    {
      return repo
    }
  }
  return null
}

// a relative path cannot be attributed to a tree, so it is not evidence of
// anything and would only add noise
function isAttributableMutationPath(value: string): boolean
{
  return value.startsWith('/') && !isEphemeralMutationPath(value)
}

// whether a tree is the watched tree itself or sits inside it
function isWithinRoot(candidate: string, root: string): boolean
{
  return candidate === root || candidate.startsWith(root.endsWith('/') ? root : `${root}/`)
}

// a tool that failed, or whose permission the user denied, still reports the
// arguments it was going to use, so the path it names is a write that never
// happened. the completed row drops the item status on its way through the
// runtime mapping, but the provider's own error flag survives inside data.result
function isFailedToolActivity(payload: Record<string, unknown>): boolean
{
  if (payload.status === 'failed')
  {
    return true
  }
  const data = asPayloadRecord(payload.data)
  const result = data === null ? null : asPayloadRecord(data.result)
  return result?.is_error === true
}

function turnMutationEvidence(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  turnId: TurnId,
): TurnMutationEvidence
{
  const mutatedPaths = new Set<string>()
  const editWorkerRepos = new Set<string>()

  for (const activity of activities)
  {
    if (activity.turnId !== turnId || !MUTATION_EVIDENCE_ACTIVITY_KINDS.has(activity.kind))
    {
      continue
    }
    const payload = asPayloadRecord(activity.payload)
    if (payload === null || isFailedToolActivity(payload))
    {
      continue
    }
    if (payload.itemType === 'file_change')
    {
      const targets = collectToolMutationTargets(payload.data, { includeSnakeCaseKeys: true })
      for (const target of targets)
      {
        if (isAttributableMutationPath(target))
        {
          mutatedPaths.add(target)
        }
      }
      continue
    }
    if (payload.itemType !== 'mcp_tool_call')
    {
      continue
    }
    const data = asPayloadRecord(payload.data)
    const repo = data === null ? null : editWorkerRepoFrom(data)
    if (repo !== null && isAttributableMutationPath(repo))
    {
      editWorkerRepos.add(repo)
    }
  }

  return { mutatedPaths: [...mutatedPaths], editWorkerRepos: [...editWorkerRepos] }
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
  const eventIdFor = (tag: string, actionId?: string) =>
    actionId === undefined
      ? serverEventId
      : Effect.succeed(EventId.make(`server:${tag}:reactor-action:${actionId}`))
  const delivery = yield* OrchestrationReactorDelivery
  const durableRunner = yield* DurableReactorRunner
  const runtimeInboxRunner = yield* ProviderRuntimeInboxRunner
  const providerRuntimeInbox = yield* ProviderRuntimeInbox
  const orchestrationEngine = yield* OrchestrationEngineService
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery
  const providerService = yield* ProviderService
  const checkpointStore = yield* CheckpointStore.CheckpointStore
  const checkpointIdentity = yield* CheckpointIdentityResolver
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
      activityId: eventIdFor('checkpoint-revert-failure', input.actionId),
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
      activityId: eventIdFor('checkpoint-capture-failure', input.actionId),
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

  // one namespace for every path this reactor compares. git reports a tree's
  // root physically, with symlinks resolved, while the cwd handed to it keeps
  // whatever form the caller used; a lexical fallback covers a path that no
  // longer exists, which is exactly the case the comparison has to survive
  const canonicalPath = (value: string): Effect.Effect<string> =>
    fileSystem.realPath(value).pipe(Effect.orElseSucceed(() => path.normalize(value)))

  // resolves the git root that owns a directory, falling back to the directory
  // itself when it is not in a repository at all (a plain /Users/... scratch dir).
  // git reports the common dir relative to the directory it was asked about, so
  // a bare `.git` has to be resolved against that same cwd before two trees can
  // be compared at all, and then canonicalized: resolved against a cwd reached
  // through a symlink it would otherwise name the same directory differently
  // from every sibling worktree, and no genuine sibling would ever compare equal
  const resolveMutationRepository = (cwd: string): Effect.Effect<MutationRepository> =>
    vcsRegistry.detect({ cwd, requestedKind: 'git' }).pipe(
      Effect.orElseSucceed(() => null),
      Effect.flatMap((handle) =>
      {
        const metadataPath = handle?.repository.metadataPath ?? null
        const resolvedCommonDir =
          metadataPath === null
            ? null
            : path.isAbsolute(metadataPath)
              ? metadataPath
              : path.resolve(cwd, metadataPath)
        const commonDir: Effect.Effect<string | null> =
          resolvedCommonDir === null ? Effect.succeed(null) : canonicalPath(resolvedCommonDir)
        return Effect.all({
          rootPath: canonicalPath(handle?.repository.rootPath ?? cwd),
          commonDir,
        })
      }),
    )

  // pairs an empty (or never computed) turn diff with the turn's own mutation
  // evidence and names the tree the work actually went into. duration is
  // deliberately not part of the signal: measured over the historical corpus it
  // ran at 50% precision and only delayed the alarm, while mutation evidence
  // alone kept every true case and silenced every false one
  const checkWorkspaceDivergence = Effect.fn('checkWorkspaceDivergence')(function* (
    input: DivergenceCheckInput,
  )
  {
    const evidence = turnMutationEvidence(input.activities, input.turnId)
    if (evidence.mutatedPaths.length === 0 && evidence.editWorkerRepos.length === 0)
    {
      return
    }

    const watched =
      input.watchedCwd === undefined ? null : yield* resolveMutationRepository(input.watchedCwd)
    const watchedRoot = watched?.rootPath ?? null

    // one detection per distinct directory rather than per path; detection is
    // cached, but a turn can carry hundreds of file_change rows
    const candidateCwds = new Set<string>([
      ...evidence.mutatedPaths.map((value) => path.dirname(value)),
      ...evidence.editWorkerRepos,
    ])
    // keyed by root so repeated mutation paths collapse into one alarm target;
    // repository identity remains diagnostic only and grants no redirect authority
    const divergentRepositories = new Map<string, string | null>()
    for (const candidateCwd of candidateCwds)
    {
      const repository = yield* resolveMutationRepository(candidateCwd)
      if (repository.rootPath === watchedRoot)
      {
        continue
      }
      // a workspace that is not a git repository is a supported project here, and
      // it has no root but its own directory, so every subdirectory it writes to
      // resolves as a separate "root". those writes landed inside the watched
      // workspace and nothing about them is divergent; only a tree that is its
      // own repository can be
      if (
        watchedRoot !== null &&
        repository.commonDir === null &&
        isWithinRoot(repository.rootPath, watchedRoot)
      )
      {
        continue
      }
      divergentRepositories.set(repository.rootPath, repository.commonDir)
    }
    if (divergentRepositories.size === 0)
    {
      return
    }

    const roots = [...divergentRepositories.keys()]
    // the sentence goes in payload.detail because that is the one payload field
    // every surface already renders on an error-toned row, so the alarm reads
    // correctly on web and mobile without a single client change
    const detail =
      watchedRoot === null
        ? `This thread has no watched git workspace, so nothing this turn changed can be shown here. It wrote to ${roots.join(', ')}.`
        : `No changes were recorded in ${watchedRoot}. This turn changed files in ${roots.join(', ')}, which this thread is not watching.`

    yield* Effect.all({
      commandId: commandIdFor('checkpoint-workspace-divergence', input.actionId),
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
            kind: 'workspace.divergence.detected',
            summary: 'Changes landed outside the tracked workspace',
            payload: {
              detail,
              watchedRoot,
              divergentRoots: roots,
              mutatedPathCount: evidence.mutatedPaths.length,
              editWorkerRepoCount: evidence.editWorkerRepos.length,
            },
            turnId: input.turnId,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    )
  })

  // generic mutation/sibling evidence is alarm-only. only the authenticated
  // exact execution toolkit may write authoritative current-run identity
  const detectAndAnnounceDivergence = (input: DivergenceCheckInput) =>
    checkWorkspaceDivergence(input).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning('workspace divergence detection failed', {
              threadId: input.threadId,
              turnId: input.turnId,
              cause: Cause.pretty(cause),
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

  // the directory the thread works in, whatever it turns out to be. checkpoint
  // work needs a git repository and stops here, but the divergence alarm needs
  // the directory itself: a project that is not a repository is a supported
  // workspace, and telling its owner every turn that the work went somewhere
  // else is the alarm firing on the one population it can never help
  const resolveWorkspaceCwd = Effect.fn('resolveWorkspaceCwd')(function* (input: {
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

    return input.preferSessionRuntime
      ? (Option.match(fromSession, {
          onNone: () => undefined,
          onSome: (runtime) => runtime.cwd,
        }) ?? fromThread)
      : (fromThread ??
          Option.match(fromSession, {
            onNone: () => undefined,
            onSome: (runtime) => runtime.cwd,
          }))
  })

  // resolves the workspace CWD for checkpoint operations, preferring the
  // active provider session CWD and falling back to the thread/project config.
  // returns undefined when no CWD can be determined or the workspace is not
  // a git repository.
  const resolveCheckpointCwd = Effect.fn('resolveCheckpointCwd')(function* (input: {
    readonly threadId: ThreadId
    readonly thread: { readonly projectId: ProjectId; readonly worktreePath: string | null }
    readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly workspaceRoot: string }>
    readonly preferSessionRuntime: boolean
  }): Effect.fn.Return<string | undefined, CheckpointStoreError>
  {
    const cwd = yield* resolveWorkspaceCwd(input)
    if (!cwd)
    {
      return undefined
    }
    if (!(yield* checkpointStore.isGitRepository(cwd)))
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
      // both call sites already hand over a whole OrchestrationThread; the
      // divergence check reads this turn's own tool rows out of it, and the
      // adoption that follows reads the target it has already recorded
      readonly activities: ReadonlyArray<OrchestrationThreadActivity>
      readonly orchestrateRunWorktreePath?: string | null | undefined
      readonly orchestrateRunBranch?: string | null | undefined
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
    let publishedCommitOid: string | undefined
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
      else
      {
        publishedCommitOid = publication.commitOid
      }
    }
    const targetIdentity = yield* checkpointIdentity.resolveCapture({
      cwd: input.cwd,
      checkpointRef: targetCheckpointRef,
      checkpointTurnCount: input.turnCount,
      ...(publishedCommitOid === undefined ? {} : { expectedCommitOid: publishedCommitOid }),
    })

    // refresh the workspace entry index so the @-mention file picker
    // reflects files created or deleted during this turn.
    yield* workspaceEntries.refresh(input.cwd)

    // `derived` keeps a genuinely empty diff apart from a diff that could not be
    // computed at all (a missing pre-turn baseline lands in the catch below).
    // both produce zero files, but only the first says anything about where the
    // turn's work went, and the second is already reported as a capture failure
    const turnDiff: TurnDiffOutcome = yield* checkpointStore
      .diffCheckpoints({
        cwd: input.cwd,
        fromCheckpointRef,
        toCheckpointRef: targetCheckpointRef,
        fallbackFromToHead: false,
        ignoreWhitespace: false,
      })
      .pipe(
        Effect.map((diff): TurnDiffOutcome => ({
          derived: true,
          files: parseTurnDiffFilesFromUnifiedDiff(diff).map((file) => ({
            path: file.path,
            kind: 'modified' as const,
            additions: file.additions,
            deletions: file.deletions,
          })),
        })),
        Effect.tapError((error) =>
          appendCaptureFailureActivity({
            threadId: input.threadId,
            turnId: input.turnId,
            detail: `Checkpoint captured, but turn diff summary is unavailable: ${error.message}`,
            createdAt: input.createdAt,
            ...(input.actionId === undefined ? {} : { actionId: input.actionId }),
          }),
        ),
        Effect.catch((error) =>
          Effect.logWarning('failed to derive checkpoint file summary', {
            threadId: input.threadId,
            turnId: input.turnId,
            turnCount: input.turnCount,
            detail: error.message,
          }).pipe(Effect.as<TurnDiffOutcome>({ derived: false, files: [] })),
        ),
      )
    const files = turnDiff.files

    // an empty diff paired with real mutation evidence means the work landed in
    // a tree this thread does not watch. that is the failure the app used to be
    // silent about: the user opened the diff, saw nothing, and concluded the run
    // had done nothing
    if (turnDiff.derived && files.length === 0)
    {
      yield* detectAndAnnounceDivergence({
        threadId: input.threadId,
        turnId: input.turnId,
        activities: input.thread.activities,
        watchedCwd: input.cwd,
        createdAt: input.createdAt,
        ...(input.actionId === undefined ? {} : { actionId: input.actionId }),
      })
    }

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
      // record the tree the capture actually ran in rather than re-deriving it
      // later: resolveCheckpointCwd's choice is not reproducible after the
      // session moves, and a diff or revert bound to the wrong tree is how a
      // whole run became invisible
      checkpointCaptureRoot: targetIdentity.checkpointCaptureRoot,
      checkpointRepositoryCommonDir: targetIdentity.checkpointRepositoryCommonDir,
      checkpointCommitOid: targetIdentity.checkpointCommitOid,
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
        id: yield* eventIdFor('checkpoint-captured-activity', input.actionId),
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
  // the outcome tells the caller which early return it took, because only
  // 'no-workspace' means the app never looked at a tree for this turn
  const captureCheckpointFromTurnCompletion = Effect.fn('captureCheckpointFromTurnCompletion')(
    function* (event: Extract<ProviderRuntimeEvent, { type: 'turn.completed' }>, actionId: string)
    {
      const turnId = toTurnId(event.turnId)
      if (!turnId)
      {
        return 'skipped' as const
      }

      const thread = yield* resolveThreadDetail(event.threadId)
      if (!thread)
      {
        return 'skipped' as const
      }

      // when a primary turn is active, only that turn may produce completion checkpoints.
      // this is an auxiliary turn, not an unwatched one, so it must never alarm
      if (thread.session?.activeTurnId && !sameId(thread.session.activeTurnId, turnId))
      {
        return 'skipped' as const
      }

      const projects = yield* resolveThreadProjects(thread.projectId)
      const checkpointCwd = yield* resolveCheckpointCwd({
        threadId: thread.id,
        thread,
        projects,
        preferSessionRuntime: true,
      })
      // no session cwd, or the workspace is not a git repository: nothing this
      // turn did was ever going to appear in a checkpoint diff
      if (!checkpointCwd)
      {
        return 'no-workspace' as const
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
        actionId,
      })
      return 'captured' as const
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
    function* (event: Extract<ProviderRuntimeEvent, { type: 'turn.started' }>, actionId: string)
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
      const publication = baselineExists
        ? undefined
        : yield* checkpointStore.captureCheckpoint({
            cwd: checkpointCwd,
            checkpointRef: baselineCheckpointRef,
            expected: { kind: 'absent' },
          })
      const baselineIdentity = yield* checkpointIdentity.resolveCapture({
        cwd: checkpointCwd,
        checkpointRef: baselineCheckpointRef,
        checkpointTurnCount: currentTurnCount,
        ...(publication?.outcome === 'published'
          ? { expectedCommitOid: publication.commitOid }
          : {}),
      })
      yield* orchestrationEngine.dispatch({
        type: 'thread.checkpoint.baseline.record',
        commandId: yield* commandIdFor('checkpoint-baseline-record', actionId),
        threadId: thread.id,
        checkpointTurnCount: currentTurnCount,
        checkpointRef: baselineCheckpointRef,
        checkpointCaptureRoot: baselineIdentity.checkpointCaptureRoot,
        checkpointRepositoryCommonDir: baselineIdentity.checkpointRepositoryCommonDir,
        checkpointCommitOid: baselineIdentity.checkpointCommitOid,
        capturedAt: event.createdAt,
        createdAt: event.createdAt,
      })
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
    actionId?: string,
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
    const publication = baselineExists
      ? undefined
      : yield* checkpointStore.captureCheckpoint({
          cwd: checkpointCwd,
          checkpointRef: baselineCheckpointRef,
          expected: { kind: 'absent' },
        })
    const baselineIdentity = yield* checkpointIdentity.resolveCapture({
      cwd: checkpointCwd,
      checkpointRef: baselineCheckpointRef,
      checkpointTurnCount: currentTurnCount,
      ...(publication?.outcome === 'published' ? { expectedCommitOid: publication.commitOid } : {}),
    })
    yield* orchestrationEngine.dispatch({
      type: 'thread.checkpoint.baseline.record',
      commandId: yield* commandIdFor('checkpoint-baseline-record', actionId),
      threadId,
      checkpointTurnCount: currentTurnCount,
      checkpointRef: baselineCheckpointRef,
      checkpointCaptureRoot: baselineIdentity.checkpointCaptureRoot,
      checkpointRepositoryCommonDir: baselineIdentity.checkpointRepositoryCommonDir,
      checkpointCommitOid: baselineIdentity.checkpointCommitOid,
      capturedAt: event.occurredAt,
      createdAt: event.occurredAt,
    })
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

  const verifyJournalCheckpointIdentity = Effect.fn('verifyJournalCheckpointIdentity')(function* (
    operation: CheckpointRevertOperation,
  )
  {
    if (
      operation.cwd === null ||
      operation.checkpointCaptureRoot === null ||
      operation.repositoryCommonDir === null ||
      operation.checkpointCommitOid === null
    )
    {
      return yield* new CheckpointOperationError({
        detail:
          `Checkpoint revert '${operation.operationId}' predates exact capture identity; ` +
          'automatic destructive recovery is refused.',
      })
    }
    return yield* checkpointIdentity.resolveDestructive({
      record: {
        checkpointRef: CheckpointRef.make(operation.targetRef),
        checkpointTurnCount: operation.targetTurnCount,
        checkpointCaptureRoot: operation.checkpointCaptureRoot,
        checkpointRepositoryCommonDir: operation.repositoryCommonDir,
        checkpointCommitOid: operation.checkpointCommitOid,
      },
      restoreRoot: operation.cwd,
    })
  })

  const journalProviderIdentity = (
    operation: CheckpointRevertOperation,
  ): ProviderRuntimeSessionIdentity | null =>
  {
    if (
      operation.provider === null ||
      operation.providerInstanceId === null ||
      operation.providerThreadId === null ||
      operation.providerSessionGeneration === null ||
      operation.providerThreadId !== operation.threadId
    )
    {
      return null
    }
    return {
      provider: operation.provider,
      providerInstanceId: operation.providerInstanceId,
      threadId: operation.providerThreadId,
      sessionGeneration: operation.providerSessionGeneration,
    }
  }

  const drainProviderRuntimeThrough = Effect.fn('drainProviderRuntimeThrough')(function* (
    sequence: number,
  )
  {
    yield* runtimeInboxRunner.drainThrough(PROVIDER_RUNTIME_INGESTION_REACTOR_ID, sequence)
    yield* runtimeInboxRunner.drainThrough(PROVIDER_RUNTIME_CHECKPOINT_REACTOR_ID, sequence)
  })

  const synchronizeRevertInputs = Effect.fn('synchronizeRevertInputs')(function* (
    operation: CheckpointRevertOperation,
  )
  {
    if (operation.requestSourceSequence <= 0)
    {
      return yield* new CheckpointOperationError({
        detail:
          `Checkpoint revert '${operation.operationId}' predates the transactional source ` +
          'barrier; automatic destructive recovery is refused.',
      })
    }
    yield* durableRunner.drainThrough(
      'provider-command',
      Math.max(0, operation.requestSourceSequence - 1),
    )
    yield* drainProviderRuntimeThrough(operation.providerInboxHighWater)

    const providerIdentity = journalProviderIdentity(operation)
    if (providerIdentity === null) return
    const state = yield* providerService.getSessionIdentityState(providerIdentity)
    if (
      Option.isSome(state) &&
      state.value.status === 'closed' &&
      state.value.closedSequence !== null
    )
    {
      yield* drainProviderRuntimeThrough(state.value.closedSequence)
    }
  })

  const stopExactProviderAndDrain = Effect.fn('stopExactProviderAndDrain')(function* (
    identity: ProviderRuntimeSessionIdentity,
  )
  {
    let state = yield* providerService.getSessionIdentityState(identity)
    if (Option.isNone(state))
    {
      return {
        mismatch: 'The captured provider generation is no longer present in durable state.',
      }
    }
    if (state.value.status === 'open')
    {
      const stopped = yield* providerService.stopSessionIfExact(identity)
      state = yield* providerService.getSessionIdentityState(identity)
      if (!stopped && (Option.isNone(state) || state.value.status !== 'closed'))
      {
        return {
          mismatch: 'The captured provider generation changed before exact stop completed.',
        }
      }
    }
    if (
      Option.isNone(state) ||
      state.value.provider !== identity.provider ||
      state.value.providerInstanceId !== identity.providerInstanceId ||
      state.value.threadId !== identity.threadId ||
      state.value.sessionGeneration !== identity.sessionGeneration ||
      state.value.status !== 'closed' ||
      state.value.closedSequence === null
    )
    {
      return {
        mismatch: 'The captured provider generation has no exact durable terminal sequence.',
      }
    }
    yield* drainProviderRuntimeThrough(state.value.closedSequence)
    return { closedSequence: state.value.closedSequence }
  })

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
            const cwd = operation.cwd
            if (cwd === null)
            {
              return yield* new CheckpointOperationError({
                detail: `Checkpoint revert '${operation.operationId}' is missing its restore root.`,
              })
            }
            const identity = yield* verifyJournalCheckpointIdentity(operation)
            const stagePath = path.join(
              serverConfig.stateDir,
              REVERT_STAGE_DIRECTORY,
              encodeURIComponent(operation.operationId),
            )

            // admitted retries own this directory and can safely replace a partial stage.
            yield* fileSystem.remove(stagePath, { recursive: true, force: true })
            yield* fileSystem.makeDirectory(stagePath, { recursive: true })
            const verification = yield* checkpointStore.stageCheckpointTree({
              cwd,
              ref: CheckpointRef.make(operation.targetRef),
              commitOid: identity.checkpointCommitOid,
              stagePath,
            })
            return yield* transition('target-staged', {
              targetTree: verification.treeOid,
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
            const cwd = operation.cwd
            if (cwd === null)
            {
              return yield* new CheckpointOperationError({
                detail: `Checkpoint revert '${operation.operationId}' is missing its restore root.`,
              })
            }
            const identity = yield* verifyJournalCheckpointIdentity(operation)
            if (operation.targetTree === null || operation.stagePath === null)
            {
              return yield* new CheckpointOperationError({
                detail: `Checkpoint revert '${operation.operationId}' is missing staged target metadata.`,
              })
            }
            const preflight = yield* checkpointStore.verifyRestorePreconditions({
              cwd,
              ref: CheckpointRef.make(operation.targetRef),
              commitOid: identity.checkpointCommitOid,
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
        return yield* withJournalRetry(
          operation,
          Effect.gen(function* ()
          {
            const providerIdentity = journalProviderIdentity(operation)
            if (providerIdentity === null)
            {
              return yield* new CheckpointOperationError({
                detail: `Checkpoint revert '${operation.operationId}' lacks exact provider generation identity.`,
              })
            }
            const providerTurnCount =
              yield* providerService.getConversationTurnCountIfExact(providerIdentity)
            if (Option.isNone(providerTurnCount))
            {
              const detail: ProviderRollbackJournalDetail = {
                version: 1,
                capability: 'legacy-unreported',
                state: 'identity-unavailable',
                rolledBackTurns: 0,
                staleRefs: [],
                detail: `Checkpoint revert '${operation.operationId}' provider generation changed before its native turn count could be frozen.`,
              }
              return yield* transition('provider-pending', {
                providerOutcomeJson: encodeProviderRollbackJournalDetail(detail),
                lastError: null,
              })
            }
            if (providerTurnCount.value < operation.targetTurnCount)
            {
              const detail: ProviderRollbackJournalDetail = {
                version: 1,
                capability: 'legacy-unreported',
                state: 'identity-unavailable',
                rolledBackTurns: 0,
                staleRefs: [],
                detail: `Checkpoint revert '${operation.operationId}' provider history is already shorter than the requested target.`,
              }
              return yield* transition('provider-pending', {
                providerOutcomeJson: encodeProviderRollbackJournalDetail(detail),
                lastError: null,
              })
            }
            const capabilities = yield* providerService.getCapabilities(
              providerIdentity.providerInstanceId,
            )
            const detail: ProviderRollbackJournalDetail = {
              version: 1,
              capability: rollbackCapabilityFrom(capabilities),
              state: 'pending',
              rolledBackTurns: providerTurnCount.value - operation.targetTurnCount,
              staleRefs: [],
              detail: null,
            }
            return yield* transition('provider-pending', {
              providerOutcomeJson: encodeProviderRollbackJournalDetail(detail),
              lastError: null,
            })
          }),
        )

      case 'restore-started':
        return yield* withJournalRetry(
          operation,
          Effect.gen(function* ()
          {
            const cwd = operation.cwd
            if (cwd === null)
            {
              return yield* new CheckpointOperationError({
                detail: `Checkpoint revert '${operation.operationId}' is missing its restore root.`,
              })
            }
            const identity = yield* verifyJournalCheckpointIdentity(operation)
            if (operation.targetTree === null || operation.stagePath === null)
            {
              return yield* new CheckpointOperationError({
                detail: `Checkpoint revert '${operation.operationId}' is missing restore metadata.`,
              })
            }
            const restored = yield* checkpointStore.applyStagedRestore({
              cwd,
              ref: CheckpointRef.make(operation.targetRef),
              commitOid: identity.checkpointCommitOid,
              stagePath: operation.stagePath,
            })
            if (restored.treeOid !== operation.targetTree)
            {
              return yield* new CheckpointOperationError({
                detail: `Checkpoint revert '${operation.operationId}' restored an unexpected Git tree.`,
              })
            }
            const verification = yield* checkpointStore.postVerifyRestore({
              cwd,
              ref: CheckpointRef.make(operation.targetRef),
              commitOid: identity.checkpointCommitOid,
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
            const cwd = operation.cwd
            if (cwd === null)
            {
              return yield* new CheckpointOperationError({
                detail: `Checkpoint revert '${operation.operationId}' is missing its restore root.`,
              })
            }
            yield* workspaceEntries.refresh(cwd)
            const createdAt = yield* nowIso
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

      case 'provider-pending':
        return yield* withJournalRetry(
          operation,
          Effect.gen(function* ()
          {
            const detail = yield* decodeProviderRollbackJournalDetailEffect(operation)
            const providerIdentity = journalProviderIdentity(operation)
            if (providerIdentity === null)
            {
              return yield* new CheckpointOperationError({
                detail: `Checkpoint revert '${operation.operationId}' lacks exact provider generation identity.`,
              })
            }
            const recordOutcome = (
              outcome: 'exact' | 'known-unsupported' | 'manual-unknown',
              outcomeDetail: string | null,
              journalDetail: ProviderRollbackJournalDetail,
            ) =>
              Effect.flatMap(nowIso, (now) =>
                checkpointRevertOperations.recordProviderOutcome({
                  operationId: operation.operationId,
                  outcome,
                  outcomeJson: encodeProviderRollbackJournalDetail({
                    ...journalDetail,
                    state: 'recorded',
                    detail: outcomeDetail,
                  }),
                  providerSessionId: operation.providerSessionId,
                  now,
                }),
              )

            let outcome: 'exact' | 'known-unsupported' | 'manual-unknown' = 'exact'
            let outcomeDetail: string | null = null
            let journalDetail = detail
            if (detail.state === 'identity-unavailable')
            {
              outcome = 'manual-unknown'
              outcomeDetail =
                detail.detail ??
                'The captured provider generation was unavailable before rollback metadata could be frozen.'
            }
            else if (detail.capability === 'known-unsupported')
            {
              outcome = 'known-unsupported'
              outcomeDetail =
                'The bound provider declares that conversation rollback is unsupported.'
            }
            else if (detail.rolledBackTurns === 0)
            {
              outcome = 'exact'
            }
            else if (detail.state === 'attempt-started')
            {
              outcome = 'manual-unknown'
              outcomeDetail =
                'A previous provider rollback attempt did not record a definitive result.'
            }
            else
            {
              const currentThread = yield* resolveThreadDetail(ThreadId.make(operation.threadId))
              if (
                currentThread === undefined ||
                currentThread.providerSwitch !== null ||
                (currentThread.session !== null && currentThread.session.activeTurnId !== null) ||
                currentThread.latestTurn?.state === 'running'
              )
              {
                outcome = 'manual-unknown'
                outcomeDetail =
                  'The provider lifecycle changed before conversation rollback could start.'
              }
              else
              {
                const attemptStarted = yield* transition('provider-pending', {
                  providerOutcomeJson: encodeProviderRollbackJournalDetail({
                    ...detail,
                    state: 'attempt-started',
                  }),
                  lastError: null,
                })
                journalDetail = yield* decodeProviderRollbackJournalDetailEffect(attemptStarted)
                outcomeDetail = yield* providerService
                  .rollbackConversationIfExact({
                    identity: providerIdentity,
                    numTurns: detail.rolledBackTurns,
                  })
                  .pipe(
                    Effect.map((matched) =>
                      matched
                        ? null
                        : 'The captured provider generation changed before conversation rollback could start.',
                    ),
                    // the attempt-started marker forbids issuing an indeterminate
                    // rollback twice after interruption, defect, or typed failure
                    Effect.catchCause((cause) => Effect.succeed(errorDetail(Cause.squash(cause)))),
                  )
                outcome = outcomeDetail === null ? 'exact' : 'manual-unknown'
              }
            }

            const stopped = yield* stopExactProviderAndDrain(providerIdentity)
            if ('mismatch' in stopped)
            {
              outcome = 'manual-unknown'
              outcomeDetail =
                outcomeDetail === null ? stopped.mismatch : `${outcomeDetail} ${stopped.mismatch}`
            }
            const settledThread = yield* resolveThreadDetail(ThreadId.make(operation.threadId))
            if (settledThread === undefined)
            {
              outcome = 'manual-unknown'
              outcomeDetail =
                outcomeDetail === null
                  ? 'The thread projection is unavailable after the provider terminal barrier.'
                  : `${outcomeDetail} The thread projection is unavailable after the provider terminal barrier.`
            }
            else
            {
              journalDetail = {
                ...journalDetail,
                staleRefs: settledThread.checkpoints
                  .filter(
                    (checkpoint) => checkpoint.checkpointTurnCount > operation.targetTurnCount,
                  )
                  .map((checkpoint) => String(checkpoint.checkpointRef)),
              }
            }
            return yield* recordOutcome(outcome, outcomeDetail, journalDetail)
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
                  'This provider cannot roll back its conversation; the exact session was stopped before filesystem restore.',
                createdAt,
              })
            }
            return yield* transition('restore-started', { lastError: null })
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
            const cwd = operation.cwd
            if (cwd === null)
            {
              return yield* new CheckpointOperationError({
                detail: `Checkpoint revert '${operation.operationId}' is missing its restore root.`,
              })
            }
            yield* verifyJournalCheckpointIdentity(operation)
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
                cwd,
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
      case 'requested':
        return operation
    }
  })

  const driveCheckpointRevert = Effect.fn('driveCheckpointRevert')(function* (
    initialOperation: CheckpointRevertOperation,
  )
  {
    let operation = initialOperation
    if (operation.phase === 'requested') return operation
    if (
      operation.phase !== 'completed' &&
      operation.phase !== 'aborted' &&
      operation.phase !== 'manual-required'
    )
    {
      yield* synchronizeRevertInputs(operation)
    }
    const lacksCheckpointIdentity =
      operation.checkpointCaptureRoot === null ||
      operation.repositoryCommonDir === null ||
      operation.checkpointCommitOid === null
    const lacksProviderIdentity = journalProviderIdentity(operation) === null
    if (
      operation.phase !== 'completed' &&
      operation.phase !== 'aborted' &&
      operation.phase !== 'manual-required' &&
      (lacksCheckpointIdentity || lacksProviderIdentity)
    )
    {
      const missingIdentity = lacksCheckpointIdentity
        ? 'checkpoint capture identity'
        : 'provider generation identity'
      const detail =
        `Checkpoint revert '${operation.operationId}' predates exact ${missingIdentity}; ` +
        'automatic destructive recovery is refused and manual inspection is required.'
      yield* appendRevertFailureActivity({
        threadId: ThreadId.make(operation.threadId),
        turnCount: operation.targetTurnCount,
        detail,
        createdAt: yield* nowIso,
        actionId: operation.operationId,
      }).pipe(Effect.catch(() => Effect.void))
      return yield* checkpointRevertOperations.markManual({
        operationId: operation.operationId,
        expectedPhase: operation.phase,
        error: detail,
        now: yield* nowIso,
      })
    }
    while (
      operation.phase !== 'completed' &&
      operation.phase !== 'aborted' &&
      operation.phase !== 'manual-required' &&
      operation.phase !== 'requested'
    )
    {
      operation = yield* driveCheckpointRevertPhase(operation)
    }
    return operation
  })

  const abortRequestedOperation = Effect.fn('abortRequestedOperation')(function* (
    operation: CheckpointRevertOperation,
    detail: string,
    actionId = operation.operationId,
  )
  {
    yield* appendRevertFailureActivity({
      threadId: ThreadId.make(operation.threadId),
      turnCount: operation.targetTurnCount,
      detail,
      createdAt: yield* nowIso,
      actionId,
    }).pipe(Effect.catch(() => Effect.void))
    yield* checkpointRevertOperations.casTransition({
      operationId: operation.operationId,
      expectedPhase: 'requested',
      nextPhase: 'aborted',
      patch: { lastError: detail },
      now: yield* nowIso,
    })
  })

  const handleRevertRequested = Effect.fn('handleRevertRequested')(function* (
    event: Extract<OrchestrationEvent, { type: 'thread.checkpoint-revert-requested' }>,
    actionId?: string,
  )
  {
    if (event.commandId === null)
    {
      return yield* new CheckpointDomainPayloadError({
        detail: 'Checkpoint revert request is missing its originating command id.',
      })
    }

    const now = yield* nowIso
    const failureActionId = actionId ?? String(event.commandId)
    const operationId = checkpointRevertOperationId(event.commandId)
    let reserved = yield* checkpointRevertOperations.getById(operationId)
    if (Option.isNone(reserved))
    {
      const admissionState = yield* providerRuntimeInbox.getAdmissionState
      reserved = Option.some(
        yield* checkpointRevertOperations.reserve({
          operationId,
          threadId: event.payload.threadId,
          targetRef: checkpointRefForThreadTurn(event.payload.threadId, event.payload.turnCount),
          targetTurnCount: event.payload.turnCount,
          requestSourceSequence: event.sequence,
          providerInboxHighWater: Math.max(0, admissionState.nextSequence - 1),
          now,
        }),
      )
    }
    const reservedOperation = Option.getOrThrow(reserved)
    if (reservedOperation.phase !== 'requested')
    {
      yield* driveCheckpointRevert(reservedOperation)
      return
    }
    if (
      reservedOperation.threadId !== event.payload.threadId ||
      reservedOperation.targetTurnCount !== event.payload.turnCount ||
      reservedOperation.targetRef !==
        checkpointRefForThreadTurn(event.payload.threadId, event.payload.turnCount) ||
      reservedOperation.requestSourceSequence !== event.sequence
    )
    {
      yield* abortRequestedOperation(
        reservedOperation,
        `Checkpoint revert '${operationId}' does not match its persisted request fence.`,
        failureActionId,
      )
      return
    }

    const abortRequested = Effect.fn('abortRequested')(function* (detail: string)
    {
      yield* abortRequestedOperation(reservedOperation, detail, failureActionId)
    })

    // provider commands before the revert request and every provider event
    // admitted at request time must be fully projected before target/session
    // identity is selected. These are replayable persisted barriers, not sleeps.
    yield* synchronizeRevertInputs(reservedOperation)

    const thread = yield* resolveThreadDetail(event.payload.threadId)
    if (!thread)
    {
      yield* abortRequested('Thread was not found in read model.')
      return
    }
    if (
      thread.providerSwitch !== null ||
      (thread.session !== null && thread.session.activeTurnId !== null) ||
      thread.latestTurn?.state === 'running' ||
      (thread.pendingHandoff !== undefined && thread.pendingHandoff !== null) ||
      thread.orchestrateRunExecution?.lifecycle === 'active'
    )
    {
      yield* abortRequested(
        'The thread acquired an active provider, handoff, or orchestrate lifecycle before revert admission.',
      )
      return
    }
    const sessionRuntime = yield* resolveSessionRuntimeForThread(event.payload.threadId)
    if (Option.isNone(sessionRuntime))
    {
      yield* abortRequested(
        'No active provider session with workspace cwd is bound to this thread.',
      )
      return
    }
    const providerInstanceId =
      sessionRuntime.value.providerInstanceId ??
      thread.session?.providerInstanceId ??
      thread.modelSelection.instanceId
    const capturedProviderIdentity = yield* providerService.captureSessionIdentity({
      threadId: event.payload.threadId,
      expectedProviderInstanceId: providerInstanceId,
    })
    if (Option.isNone(capturedProviderIdentity))
    {
      yield* abortRequested(
        'No exact provider generation is available for checkpoint revert admission.',
      )
      return
    }
    const currentTurnCount = thread.checkpoints.reduce(
      (maximum, checkpoint) => Math.max(maximum, checkpoint.checkpointTurnCount),
      0,
    )
    if (event.payload.turnCount > currentTurnCount)
    {
      yield* abortRequested(
        `Checkpoint turn count ${event.payload.turnCount} exceeds current turn count ${currentTurnCount}.`,
      )
      return
    }
    const targetCheckpoint =
      event.payload.turnCount === 0
        ? (Option.getOrNull(
            yield* projectionSnapshotQuery.getCheckpointIdentity(event.payload.threadId, 0),
          ) ?? {
            checkpointTurnCount: 0,
            checkpointRef: checkpointRefForThreadTurn(event.payload.threadId, 0),
            checkpointCaptureRoot: null,
            checkpointRepositoryCommonDir: null,
            checkpointCommitOid: null,
          })
        : thread.checkpoints.find(
            (checkpoint) => checkpoint.checkpointTurnCount === event.payload.turnCount,
          )
    if (!targetCheckpoint)
    {
      yield* abortRequested(
        `Checkpoint ref for turn ${event.payload.turnCount} is unavailable in read model.`,
      )
      return
    }
    const resolvedTarget = yield* checkpointIdentity
      .resolveDestructive({
        record: {
          checkpointRef: targetCheckpoint.checkpointRef,
          checkpointTurnCount: targetCheckpoint.checkpointTurnCount,
          checkpointCaptureRoot: targetCheckpoint.checkpointCaptureRoot ?? null,
          checkpointRepositoryCommonDir: targetCheckpoint.checkpointRepositoryCommonDir ?? null,
          checkpointCommitOid: targetCheckpoint.checkpointCommitOid ?? null,
        },
        restoreRoot: sessionRuntime.value.cwd,
      })
      .pipe(
        Effect.map(Option.some),
        Effect.catch((error) => abortRequested(error.message).pipe(Effect.as(Option.none()))),
      )
    if (Option.isNone(resolvedTarget)) return

    const admitted = yield* checkpointRevertOperations
      .admit({
        operationId,
        threadId: event.payload.threadId,
        targetRef: resolvedTarget.value.checkpointRef,
        targetTurnCount: event.payload.turnCount,
        requestSourceSequence: reservedOperation.requestSourceSequence,
        providerInboxHighWater: reservedOperation.providerInboxHighWater,
        cwd: resolvedTarget.value.cwd,
        checkpointCaptureRoot: resolvedTarget.value.checkpointCaptureRoot,
        repositoryCommonDir: resolvedTarget.value.checkpointRepositoryCommonDir,
        checkpointCommitOid: resolvedTarget.value.checkpointCommitOid,
        providerIdentity: capturedProviderIdentity.value,
        providerSessionId: sessionRuntime.value.providerSessionId ?? null,
        now,
      })
      .pipe(
        Effect.map(Option.some),
        Effect.catchTag('CheckpointRevertOperationConflictError', (conflict) =>
          abortRequested(conflict.message).pipe(Effect.as(Option.none())),
        ),
      )
    if (Option.isNone(admitted))
    {
      return
    }
    yield* driveCheckpointRevert(admitted.value)
  })

  const resumeRequestedRevert = Effect.fn('resumeRequestedRevert')(function* (
    operation: CheckpointRevertOperation,
  )
  {
    const events = yield* Stream.runCollect(
      orchestrationEngine.readEvents(Math.max(0, operation.requestSourceSequence - 1), 1),
    ).pipe(
      Effect.map((chunk) => Array.from(chunk)),
      Effect.mapError(
        (cause) =>
          new ReactorDeliveryError({
            operation: 'CheckpointReactor.resumeRequestedRevert:readEvent',
            cause,
          }),
      ),
    )
    const event = events[0]
    if (
      event === undefined ||
      event.sequence !== operation.requestSourceSequence ||
      event.type !== 'thread.checkpoint-revert-requested' ||
      event.commandId === null ||
      checkpointRevertOperationId(event.commandId) !== operation.operationId ||
      event.payload.threadId !== operation.threadId ||
      event.payload.turnCount !== operation.targetTurnCount
    )
    {
      yield* abortRequestedOperation(
        operation,
        `Checkpoint revert '${operation.operationId}' cannot recover its authoritative request event.`,
      )
      return
    }
    yield* handleRevertRequested(event, operation.operationId)
  })

  const processRuntimeEvent = Effect.fn('processRuntimeEvent')(function* (
    event: ProviderRuntimeEvent,
    actionId: string,
  )
  {
    if (isHiddenTurnRuntimeEvent(event))
    {
      return
    }
    const thread = yield* resolveThreadDetail(event.threadId)
    if (
      !thread ||
      thread.providerSwitch !== null ||
      !runtimeEventMatchesThreadProviderInstance(event, thread)
    )
    {
      return
    }
    if (event.type === 'turn.started')
    {
      yield* ensurePreTurnBaselineFromTurnStart(event, actionId)
      yield* beginImplementationAttemptFromTurnStart(event)
      return
    }

    if (event.type === 'turn.completed')
    {
      const turnId = toTurnId(event.turnId)
      yield* refreshLocalGitStatusFromTurnCompletion(event)
      const outcome = yield* captureCheckpointFromTurnCompletion(event, actionId).pipe(
        Effect.catch((error) =>
          Effect.flatMap(nowIso, (createdAt) =>
            appendCaptureFailureActivity({
              threadId: event.threadId,
              turnId,
              detail: error.message,
              createdAt,
              actionId,
            }).pipe(
              Effect.catch(() => Effect.void),
              Effect.andThen(Effect.fail(error)),
            ),
          ),
        ),
      )

      // capture never ran, so the empty-diff branch inside
      // captureAndDispatchCheckpoint is unreachable for exactly the turns that
      // most need the alarm: no checkpoint could be taken, so anything this turn
      // wrote could never have been shown.
      // the thread is re-read rather than reusing the snapshot taken at the top
      // of this handler, because tool activities are ingested on a separate lane
      // and the later read gives that lane time to land this turn's last rows
      if (outcome === 'no-workspace' && turnId !== null)
      {
        const completedThread = yield* resolveThreadDetail(event.threadId)
        if (completedThread)
        {
          // the workspace directory is resolved again without the git gate: a
          // project that is simply not a repository has a tree of its own, and a
          // write inside it is not divergent even though no checkpoint could be
          // taken. only a thread with no directory at all reports none here
          const workspaceCwd = yield* resolveWorkspaceCwd({
            threadId: completedThread.id,
            thread: completedThread,
            projects: yield* resolveThreadProjects(completedThread.projectId),
            preferSessionRuntime: true,
          })
          yield* detectAndAnnounceDivergence({
            threadId: event.threadId,
            turnId,
            activities: completedThread.activities,
            // no repository was watched, so nothing can be proved the same and
            // the adoption gate declines; the alarm is all this path can offer
            watchedCwd: workspaceCwd,
            createdAt: event.createdAt,
            actionId,
          })
        }
      }
      return
    }
  })

  const runtimeDefinition: ProviderRuntimeInboxConsumerDefinition = {
    consumerId: PROVIDER_RUNTIME_CHECKPOINT_REACTOR_ID,
    operationVersion: PROVIDER_RUNTIME_INBOX_OPERATION_VERSION,
    restore: (checkpoint) =>
      Option.match(checkpoint, {
        onNone: () => Effect.void,
        onSome: (buffer) =>
          buffer.stateVersion !== 1
            ? Effect.fail(
                new CheckpointRuntimeConsumerError({
                  detail: `Unsupported checkpoint runtime buffer version ${buffer.stateVersion}.`,
                }),
              )
            : decodeRuntimeCheckpointBufferState(buffer.stateJson).pipe(
                Effect.asVoid,
                Effect.mapError(
                  (cause) =>
                    new CheckpointRuntimeConsumerError({
                      detail: 'Unable to decode the checkpoint runtime consumer buffer.',
                      cause,
                    }),
                ),
              ),
      }),
    prerequisite: (record) =>
      delivery.getProgress(PROVIDER_RUNTIME_INGESTION_REACTOR_ID).pipe(
        Effect.map(
          Option.match({
            onNone: () => false,
            onSome: (progress) => progress.cursorSequence >= record.sequence,
          }),
        ),
        Effect.mapError(
          (cause) =>
            new CheckpointRuntimeConsumerError({
              detail: `Unable to verify provider runtime ingestion progress before checkpoint event ${record.sequence}.`,
              cause,
            }),
        ),
      ),
    process: (record, event) =>
      processRuntimeEvent(
        event,
        JSON.stringify([
          PROVIDER_RUNTIME_CHECKPOINT_REACTOR_ID,
          PROVIDER_RUNTIME_INBOX_OPERATION_VERSION,
          record.sequence,
          'runtime-event',
          0,
        ]),
      ).pipe(
        Effect.as({
          stateVersion: 1,
          stateJson: RUNTIME_CHECKPOINT_BUFFER_JSON,
          sessionBufferTerminal: event.type === 'session.exited',
        }),
        Effect.mapError((cause) =>
          isCheckpointRuntimeConsumerError(cause)
            ? cause
            : new CheckpointRuntimeConsumerError({
                detail: `Checkpoint runtime processing failed for event '${event.eventId}'.`,
                cause,
              }),
        ),
      ),
    classify: () => 'retryable',
  }

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
          yield* ensurePreTurnBaselineFromDomainTurnStart(
            event,
            payload.targetCheckpointRef,
            action.actionId,
          )
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
    onBlocked: ({ action, cause, status }) =>
    {
      if (action.effectKind !== 'checkpoint.revert') return Effect.void
      return checkpointRevertOperations.getRequestedBySourceSequence(action.sourceSequence).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (operation) =>
              abortRequestedOperation(
                operation,
                `Checkpoint revert action became ${status} before admission: ${errorDetail(cause)}`,
                action.actionId,
              ),
          }),
        ),
        Effect.mapError(
          (hookCause) =>
            new ReactorDeliveryError({
              operation: 'CheckpointReactor.onBlocked:abortRequested',
              cause: hookCause,
            }),
        ),
      )
    },
    onLeaseExpiry: 'retryable',
  }

  const startRuntimeLane: CheckpointReactorShape['startRuntimeLane'] = Effect.fn(
    'CheckpointReactor.startRuntimeLane',
  )(function* ()
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

    yield* runtimeInboxRunner.start(runtimeDefinition)
  })

  const startDomain: CheckpointReactorShape['startDomain'] = Effect.fn(
    'CheckpointReactor.startDomain',
  )(function* ()
  {
    // the checkpoint inbox lane and provider admission handoff must be ready
    // before a persisted destructive journal can publish a terminal event.
    // resume journals before the domain runner to avoid a duplicate action
    // racing the same row.
    const resumableReverts = yield* checkpointRevertOperations.listResumable()
    yield* Effect.forEach(
      resumableReverts,
      (operation) =>
      {
        if (operation.phase === 'requested')
        {
          return resumeRequestedRevert(operation).pipe(
            Effect.mapError(
              (cause) =>
                new ReactorDeliveryError({
                  operation: 'CheckpointReactor.startDomain:resumeRequested',
                  cause,
                }),
            ),
          )
        }
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
  })

  const start: CheckpointReactorShape['start'] = Effect.fn('CheckpointReactor.start')(function* ()
  {
    yield* startRuntimeLane()
    yield* startDomain()
  })

  return {
    startRuntimeLane,
    startDomain,
    start,
    drain: runtimeInboxRunner
      .drain(PROVIDER_RUNTIME_CHECKPOINT_REACTOR_ID)
      .pipe(Effect.andThen(durableRunner.drain(REACTOR_ID))),
  } satisfies CheckpointReactorShape
})

export const CheckpointReactorLive = Layer.effect(CheckpointReactor, make).pipe(
  Layer.provideMerge(DurableReactorInfrastructureLive),
)
