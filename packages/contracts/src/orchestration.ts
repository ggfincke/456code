// packages/contracts/src/orchestration.ts
// defines orchestration commands, events, projections, and import rpc schemas

import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as SchemaIssue from 'effect/SchemaIssue'
import * as SchemaTransformation from 'effect/SchemaTransformation'
import * as Struct from 'effect/Struct'
import { ProviderOptionSelections } from './model.ts'
import { RepositoryIdentity } from './environment.ts'
import {
  ApprovalRequestId,
  CheckpointRef,
  CommandId,
  EventId,
  GitRefString,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ProviderItemId,
  ProviderRuntimeModeWarningIdSchema,
  ThreadId,
  TrimmedString,
  TrimmedNonEmptyString,
  TurnId,
} from './baseSchemas.ts'
import {
  ProviderContinuationIdentity,
  ProviderDriverKind,
  ProviderInstanceId,
} from './providerInstance.ts'
import { ARCHITECTURE_BLAST_PATH_LIMIT, ArchitectureRelativePath } from './architecturePath.ts'

export const ORCHESTRATION_WS_METHODS = {
  dispatchCommand: 'orchestration.dispatchCommand',
  importScan: 'orchestration.importScan',
  importSessions: 'orchestration.importSessions',
  getTurnDiff: 'orchestration.getTurnDiff',
  getFullThreadDiff: 'orchestration.getFullThreadDiff',
  getRunDiff: 'orchestration.getRunDiff',
  getRunExecutionDiffV1: 'orchestration.getRunExecutionDiff.v1',
  getArchivedShellSnapshot: 'orchestration.getArchivedShellSnapshot',
  searchThreads: 'orchestration.searchThreads',
  subscribeShell: 'orchestration.subscribeShell',
  subscribeThread: 'orchestration.subscribeThread',
} as const

export const ThreadImportSource = Schema.Literals([
  'codex-cli',
  'claude-code',
  'opencode',
  'cursor',
  'grok',
])
export type ThreadImportSource = typeof ThreadImportSource.Type

export const ThreadImportContinuation = Schema.Union([
  Schema.Struct({
    state: Schema.Literal('verified'),
    providerInstanceId: ProviderInstanceId,
    continuationIdentity: ProviderContinuationIdentity,
    reason: Schema.Null,
  }),
  Schema.Struct({
    state: Schema.Literal('history-only'),
    providerInstanceId: ProviderInstanceId,
    // null means no exact provider route was available and consent must fail closed
    continuationIdentity: Schema.NullOr(ProviderContinuationIdentity),
    reason: TrimmedNonEmptyString,
  }),
])
export type ThreadImportContinuation = typeof ThreadImportContinuation.Type

export const ThreadImportContinuationActivityPayload = Schema.Struct({
  type: Schema.Literal('import.continuation'),
  driverKind: ProviderDriverKind,
  continuation: ThreadImportContinuation,
})
export type ThreadImportContinuationActivityPayload =
  typeof ThreadImportContinuationActivityPayload.Type

export const ThreadImportContinuationConsent = Schema.Struct({
  originContentHash: TrimmedNonEmptyString,
  activityId: EventId,
  driverKind: ProviderDriverKind,
  targetProviderInstanceId: ProviderInstanceId,
  continuation: ThreadImportContinuation,
})
export type ThreadImportContinuationConsent = typeof ThreadImportContinuationConsent.Type

export const ThreadImportContinuationAuthority = Schema.Struct({
  driverKind: ProviderDriverKind,
  targetProviderInstanceId: ProviderInstanceId,
  continuationIdentity: Schema.NullOr(ProviderContinuationIdentity),
})
export type ThreadImportContinuationAuthority = typeof ThreadImportContinuationAuthority.Type

export const ThreadOrigin = Schema.Struct({
  kind: Schema.Literal('imported'),
  source: ThreadImportSource,
  sourcePath: TrimmedNonEmptyString,
  contentHash: TrimmedNonEmptyString,
  nativeSessionId: Schema.NullOr(TrimmedNonEmptyString),
  providerInstanceId: Schema.NullOr(ProviderInstanceId).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  originalWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
  importedAt: IsoDateTime,
})
export type ThreadOrigin = typeof ThreadOrigin.Type

export const ProviderApprovalPolicy = Schema.Literals([
  'untrusted',
  'on-failure',
  'on-request',
  'never',
])
export type ProviderApprovalPolicy = typeof ProviderApprovalPolicy.Type
export const ProviderSandboxMode = Schema.Literals([
  'read-only',
  'workspace-write',
  'danger-full-access',
])
export type ProviderSandboxMode = typeof ProviderSandboxMode.Type

// `ModelSelection` — selection of a model on a configured provider instance.
//
// the routing key is `instanceId` (a user-defined slug identifying one
// configured provider instance). Drivers, credentials, working-directory
// bindings, and any other per-instance state are recovered from the
// runtime registry via the instance id.
//
// wire legacy: persisted selections produced before the driver/instance
// split carried a `provider: <driver-id>` field instead. The schema absorbs
// that shape via a pre-decoding transform — `{provider, model}` is promoted
// to `{instanceId: defaultInstanceIdForDriver(provider), model}`. No
// post-decode compatibility code lives in the runtime; the transform is the
// only compat surface.
const ModelSelectionWire = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(ProviderOptionSelections),
})

// source shape for persisted legacy payloads. Fields are typed as
// `Schema.Unknown` so malformed drafts still make it into the transform and
// fail validation through the target schema (with proper error messages)
// rather than at the source-struct layer where the error is less actionable.
const ModelSelectionSource = Schema.Struct({
  provider: Schema.optional(Schema.Unknown),
  instanceId: Schema.optional(Schema.Unknown),
  model: Schema.Unknown,
  options: Schema.optional(Schema.Unknown),
})

export const ModelSelection = ModelSelectionSource.pipe(
  Schema.decodeTo(
    ModelSelectionWire,
    SchemaTransformation.transformOrFail({
      decode: (raw) =>
      {
        // resolve the routing key: prefer an explicit `instanceId`; fall
        // back to promoting the legacy `provider` slug (the canonical
        // `defaultInstanceIdForDriver` mapping) so persisted rollout-era
        // payloads decode without data loss. The target schema brands the
        // string as `ProviderInstanceId`.
        const instanceIdSource =
          raw.instanceId !== undefined
            ? raw.instanceId
            : typeof raw.provider === 'string'
              ? raw.provider
              : undefined
        const base: Record<string, unknown> = {
          instanceId: instanceIdSource,
          model: raw.model,
        }
        if (raw.options !== undefined) base.options = raw.options
        return Effect.succeed(base as typeof ModelSelectionWire.Encoded)
      },
      encode: (value) =>
      {
        const base: Record<string, unknown> = {
          model: value.model,
          instanceId: value.instanceId,
        }
        if (value.options !== undefined) base.options = value.options
        return Effect.succeed(base as typeof ModelSelectionSource.Encoded)
      },
    }),
  ),
)
export type ModelSelection = typeof ModelSelection.Type

export const RuntimeMode = Schema.Literals([
  'approval-required',
  'auto-accept-edits',
  'auto',
  'full-access',
])
export type RuntimeMode = typeof RuntimeMode.Type
export const DEFAULT_RUNTIME_MODE: RuntimeMode = 'full-access'

// footer already displays a supported mode; send/start must persist the same value
export function coerceRuntimeMode(
  requested: RuntimeMode,
  supported: ReadonlyArray<RuntimeMode> | undefined,
): RuntimeMode
{
  if (supported === undefined || supported.length === 0)
  {
    return requested
  }
  return supported.includes(requested) ? requested : (supported[0] ?? 'approval-required')
}

export const ProviderInteractionMode = Schema.Literals(['default', 'plan', 'orchestrate'])
export type ProviderInteractionMode = typeof ProviderInteractionMode.Type
export const DEFAULT_PROVIDER_INTERACTION_MODE: ProviderInteractionMode = 'default'
export interface CollaborationMode
{
  readonly baseMode: 'default' | 'plan'
  readonly orchestrate: boolean
}

export function normalizeCollaborationMode(
  interactionMode: ProviderInteractionMode,
  orchestrate?: boolean,
): CollaborationMode
{
  return {
    baseMode: interactionMode === 'plan' ? 'plan' : 'default',
    orchestrate: interactionMode === 'orchestrate' || orchestrate === true,
  }
}

export function toWireInteractionMode(mode: CollaborationMode): {
  readonly interactionMode: ProviderInteractionMode
  readonly orchestrate: boolean
}
{
  if (mode.baseMode === 'plan')
  {
    return { interactionMode: 'plan', orchestrate: mode.orchestrate }
  }
  return {
    interactionMode: mode.orchestrate ? 'orchestrate' : 'default',
    orchestrate: mode.orchestrate,
  }
}
export const ProviderRequestKind = Schema.Literals([
  'command',
  'file-read',
  'file-change',
  'mcp-elicitation',
])
export type ProviderRequestKind = typeof ProviderRequestKind.Type
export const AssistantDeliveryMode = Schema.Literals(['buffered', 'streaming'])
export type AssistantDeliveryMode = typeof AssistantDeliveryMode.Type
export const ProviderApprovalDecision = Schema.Literals([
  'accept',
  'acceptForSession',
  'acceptAlways',
  'decline',
  'cancel',
])
export type ProviderApprovalDecision = typeof ProviderApprovalDecision.Type
export const ProviderApprovalOption = Schema.Struct({
  decision: ProviderApprovalDecision,
  label: TrimmedNonEmptyString,
})
export type ProviderApprovalOption = typeof ProviderApprovalOption.Type
export const ProviderUserInputAnswers = Schema.Record(Schema.String, Schema.Unknown)
export type ProviderUserInputAnswers = typeof ProviderUserInputAnswers.Type

export const PROVIDER_SEND_TURN_MAX_INPUT_CHARS = 120_000
export const PROVIDER_SEND_TURN_MAX_ATTACHMENTS = 8
export const PROVIDER_SEND_TURN_MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const PROVIDER_SEND_TURN_MAX_FILE_BYTES = 50 * 1024 * 1024
export const PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES = [
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const
const PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPE_SET = new Set<string>(
  PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES,
)

export function isProviderSendTurnSupportedImageMimeType(mimeType: string): boolean
{
  return PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPE_SET.has(mimeType.toLowerCase())
}

const PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS = 14_000_000
const CHAT_ATTACHMENT_ID_MAX_CHARS = 128
// correlation id is command id by design in this model.
export const CorrelationId = CommandId
export type CorrelationId = typeof CorrelationId.Type

const ChatAttachmentId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(CHAT_ATTACHMENT_ID_MAX_CHARS),
  Schema.isPattern(/^[a-z0-9_-]+$/i),
)
export type ChatAttachmentId = typeof ChatAttachmentId.Type

export const ChatImageAttachment = Schema.Struct({
  type: Schema.Literal('image'),
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
})
export type ChatImageAttachment = typeof ChatImageAttachment.Type

export const ChatFileAttachment = Schema.Struct({
  type: Schema.Literal('file'),
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  sizeBytes: NonNegativeInt.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_FILE_BYTES),
  ),
})
export type ChatFileAttachment = typeof ChatFileAttachment.Type
export const ChatKnownAttachment = Schema.Union([ChatImageAttachment, ChatFileAttachment])
export type ChatKnownAttachment = typeof ChatKnownAttachment.Type

// persisted readers tolerate future kinds without relaxing known attachment validation
export const ChatUnknownAttachment = Schema.Struct({
  type: TrimmedNonEmptyString.check(
    Schema.isMaxLength(50),
    Schema.isPattern(/^(?!(?:image|file)$)/),
  ),
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  sizeBytes: NonNegativeInt,
})
export type ChatUnknownAttachment = typeof ChatUnknownAttachment.Type

const UploadChatImageAttachment = Schema.Struct({
  type: Schema.Literal('image'),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
  dataUrl: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS),
  ),
})
export type UploadChatImageAttachment = typeof UploadChatImageAttachment.Type

export const ChatAttachment = Schema.Union([
  ChatImageAttachment,
  ChatFileAttachment,
  ChatUnknownAttachment,
])
export type ChatAttachment = typeof ChatAttachment.Type
const UploadChatAttachment = Schema.Union([UploadChatImageAttachment])
export type UploadChatAttachment = typeof UploadChatAttachment.Type

export const ProjectScriptIcon = Schema.Literals([
  'play',
  'test',
  'lint',
  'configure',
  'build',
  'debug',
])
export type ProjectScriptIcon = typeof ProjectScriptIcon.Type

export const ProjectScript = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  icon: ProjectScriptIcon,
  runOnWorktreeCreate: Schema.Boolean,
  // URL to open in the in-app browser preview when this script runs (or
  // when the user explicitly requests a preview). Optional; only honored on
  // the desktop build.
  previewUrl: Schema.optional(TrimmedNonEmptyString),
  // when true, automatically open the preview panel pointed at `previewUrl`
  // the moment this script starts. Ignored without `previewUrl` or on web.
  autoOpenPreview: Schema.optional(Schema.Boolean),
})
export type ProjectScript = typeof ProjectScript.Type

export const OrchestrationProject = Schema.Struct({
  id: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
})
export type OrchestrationProject = typeof OrchestrationProject.Type

export const OrchestrationMessageRole = Schema.Literals(['user', 'assistant', 'system'])
export type OrchestrationMessageRole = typeof OrchestrationMessageRole.Type

export const OrchestrationMessage = Schema.Struct({
  id: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
})
export type OrchestrationMessage = typeof OrchestrationMessage.Type

export const OrchestrationProposedPlanId = TrimmedNonEmptyString
export type OrchestrationProposedPlanId = typeof OrchestrationProposedPlanId.Type

export const OrchestrationProposedPlan = Schema.Struct({
  id: OrchestrationProposedPlanId,
  turnId: Schema.NullOr(TurnId),
  planMarkdown: TrimmedNonEmptyString,
  implementedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  implementationThreadId: Schema.NullOr(ThreadId).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
})
export type OrchestrationProposedPlan = typeof OrchestrationProposedPlan.Type

export const OrchestratePlanRunId = TrimmedNonEmptyString
export type OrchestratePlanRunId = typeof OrchestratePlanRunId.Type

export const OrchestratePlanStage = Schema.Struct({
  id: TrimmedNonEmptyString,
  provider: TrimmedNonEmptyString,
  // null -> provider default; the card shows the resolved instance default
  model: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  effort: Schema.optional(TrimmedNonEmptyString),
  mode: Schema.Literals(['read', 'edit']),
  workers: NonNegativeInt,
  scope: Schema.optional(Schema.String),
  phase: Schema.optional(TrimmedNonEmptyString),
})
export type OrchestratePlanStage = typeof OrchestratePlanStage.Type

export const OrchestrateArchitecturePaths = Schema.Array(ArchitectureRelativePath).check(
  Schema.isMaxLength(ARCHITECTURE_BLAST_PATH_LIMIT),
)
export type OrchestrateArchitecturePaths = typeof OrchestrateArchitecturePaths.Type

// one revision of an orchestrate model plan: the durable server-held
// counterpart of the fenced `orchestrate-plan` block, written by the agent
// through the orchestrate MCP toolkit (or backfilled from a fence) and
// rendered by the plan card. revisions are immutable; a re-gated plan for the
// same run appends the next revision and supersedes earlier pending ones.
export const OrchestratePlanRevision = Schema.Struct({
  runId: OrchestratePlanRunId,
  revision: NonNegativeInt,
  turnId: Schema.NullOr(TurnId),
  workflow: TrimmedNonEmptyString,
  task: Schema.String,
  stages: Schema.Array(OrchestratePlanStage),
  totalWorkers: NonNegativeInt,
  maxWorkers: NonNegativeInt,
  source: Schema.Literals(['tool', 'fence']),
  // stamped by the decider from the thread's live session so the agent can
  // neither omit nor misreport the model it is itself burning; null on the
  // revisions persisted before this field existed, which cannot be backfilled
  // because their source events do not carry the value either
  leadModelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  // discuss responses leave the revision pending
  status: Schema.Literals(['pending', 'approved', 'rejected', 'superseded']),
  // exact source event sequence for authoritative execution admission. absent
  // only on older projections that cannot prove which immutable event won
  sourceSequence: Schema.optional(NonNegativeInt),
  // existing repo-relative files/dirs for the standing-atlas scope strip.
  // stage `scope` stays worker text and is not graph identity
  architecturePaths: Schema.optional(OrchestrateArchitecturePaths),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
})
export type OrchestratePlanRevision = typeof OrchestratePlanRevision.Type

export const OrchestrateRunExecutionLifecycle = Schema.Literals([
  'active',
  'completed',
  'failed',
  'cancelled',
  'superseded',
])
export type OrchestrateRunExecutionLifecycle = typeof OrchestrateRunExecutionLifecycle.Type

export const OrchestrateRunExecutionAvailability = Schema.Literals(['available', 'unavailable'])
export type OrchestrateRunExecutionAvailability = typeof OrchestrateRunExecutionAvailability.Type

export const OrchestrateRunExecutionIdentity = Schema.Struct({
  threadId: ThreadId,
  runId: OrchestratePlanRunId,
  planRevision: NonNegativeInt,
})
export type OrchestrateRunExecutionIdentity = typeof OrchestrateRunExecutionIdentity.Type

export const OrchestrateRunExecutionJob = Schema.Struct({
  jobId: TrimmedNonEmptyString,
  status: Schema.Literals(['completed', 'failed', 'rejected', 'cancelled']),
  requestRunId: OrchestratePlanRunId,
  requestRepositoryRoot: TrimmedNonEmptyString,
  resultRepositoryRoot: Schema.NullOr(TrimmedNonEmptyString),
  repositoryCommonDir: TrimmedNonEmptyString,
  baseOid: TrimmedNonEmptyString,
  headOid: Schema.NullOr(TrimmedNonEmptyString),
  worktreeRoot: Schema.NullOr(TrimmedNonEmptyString),
  branch: Schema.NullOr(GitRefString),
  boundAt: IsoDateTime,
})
export type OrchestrateRunExecutionJob = typeof OrchestrateRunExecutionJob.Type

// immutable source/base identity is captured once at admission. lifecycle and
// availability change only through verified execution updates; terminal final
// OIDs remain authoritative after a broker path or worktree is pruned
export const OrchestrateRunExecution = Schema.Struct({
  ...OrchestrateRunExecutionIdentity.fields,
  sourceTurnId: TurnId,
  sourceSequence: NonNegativeInt,
  repositoryRoot: TrimmedNonEmptyString,
  repositoryCommonDir: TrimmedNonEmptyString,
  baseOid: TrimmedNonEmptyString,
  lifecycle: OrchestrateRunExecutionLifecycle,
  availability: OrchestrateRunExecutionAvailability,
  integrationRoot: Schema.NullOr(TrimmedNonEmptyString),
  integrationCommonDir: Schema.NullOr(TrimmedNonEmptyString),
  integrationBranch: Schema.NullOr(GitRefString),
  integrationOid: Schema.NullOr(TrimmedNonEmptyString),
  observedHeadOid: Schema.NullOr(TrimmedNonEmptyString),
  finalHeadOid: Schema.NullOr(TrimmedNonEmptyString),
  closeReason: Schema.NullOr(TrimmedNonEmptyString),
  current: Schema.Boolean,
  admittedAt: IsoDateTime,
  updatedAt: IsoDateTime,
  terminalAt: Schema.NullOr(IsoDateTime),
  jobs: Schema.Array(OrchestrateRunExecutionJob).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
})
export type OrchestrateRunExecution = typeof OrchestrateRunExecution.Type

export const OrchestrateRunAggregate = Schema.Struct({
  threadId: ThreadId,
  runId: OrchestratePlanRunId,
  currentPlanRevision: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
})
export type OrchestrateRunAggregate = typeof OrchestrateRunAggregate.Type

const SourceProposedPlanReference = Schema.Struct({
  threadId: ThreadId,
  planId: OrchestrationProposedPlanId,
})

export const OrchestrationSessionStatus = Schema.Literals([
  'idle',
  'starting',
  'running',
  'ready',
  'interrupted',
  'stopped',
  'error',
])
export type OrchestrationSessionStatus = typeof OrchestrationSessionStatus.Type

export const OrchestrationSession = Schema.Struct({
  threadId: ThreadId,
  status: OrchestrationSessionStatus,
  providerName: Schema.NullOr(TrimmedNonEmptyString),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  activeTurnId: Schema.NullOr(TurnId),
  lastError: Schema.NullOr(TrimmedNonEmptyString),
  updatedAt: IsoDateTime,
})
export type OrchestrationSession = typeof OrchestrationSession.Type

export const OrchestrationCheckpointFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: TrimmedNonEmptyString,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
})
export type OrchestrationCheckpointFile = typeof OrchestrationCheckpointFile.Type

export const OrchestrationCheckpointStatus = Schema.Literals(['ready', 'missing', 'error'])
export type OrchestrationCheckpointStatus = typeof OrchestrationCheckpointStatus.Type

const OptionalCheckpointCaptureIdentityFields = {
  // these stay optional/null for wire and event-log compatibility; a complete
  // non-null triple is authoritative, while older combinations follow the
  // server's explicit read-only legacy policy
  checkpointCaptureRoot: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  checkpointRepositoryCommonDir: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  checkpointCommitOid: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
}

export const OrchestrationCheckpointSummary = Schema.Struct({
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
  ...OptionalCheckpointCaptureIdentityFields,
})
export type OrchestrationCheckpointSummary = typeof OrchestrationCheckpointSummary.Type

export const OrchestrationThreadActivityTone = Schema.Literals([
  'info',
  'tool',
  'approval',
  'error',
])
export type OrchestrationThreadActivityTone = typeof OrchestrationThreadActivityTone.Type

export const OrchestrationThreadActivity = Schema.Struct({
  id: EventId,
  tone: OrchestrationThreadActivityTone,
  kind: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  payload: Schema.Unknown,
  turnId: Schema.NullOr(TurnId),
  sequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
})
export type OrchestrationThreadActivity = typeof OrchestrationThreadActivity.Type

const OrchestrationLatestTurnState = Schema.Literals([
  'running',
  'interrupted',
  'completed',
  'error',
])
export type OrchestrationLatestTurnState = typeof OrchestrationLatestTurnState.Type

export const OrchestrationLatestTurn = Schema.Struct({
  turnId: TurnId,
  state: OrchestrationLatestTurnState,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  assistantMessageId: Schema.NullOr(MessageId),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
})
export type OrchestrationLatestTurn = typeof OrchestrationLatestTurn.Type

export const OrchestrationPendingHandoff = Schema.Struct({
  text: Schema.String,
  fromInstanceId: Schema.NullOr(ProviderInstanceId),
  fromModel: Schema.optional(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
})
export type OrchestrationPendingHandoff = typeof OrchestrationPendingHandoff.Type

export const OrchestrationProviderSwitch = Schema.Struct({
  phase: Schema.Literals(['pending', 'compacting', 'finalizing']),
  targetInstanceId: ProviderInstanceId,
  targetModel: Schema.NullOr(TrimmedNonEmptyString),
  requestedAt: IsoDateTime,
  requestId: Schema.optional(EventId),
  requestSequence: Schema.optional(NonNegativeInt),
  sourceModelSelection: Schema.optional(ModelSelection),
})
export type OrchestrationProviderSwitch = typeof OrchestrationProviderSwitch.Type

// approval outcome lifecycle: user intent (responding) is distinct from provider
// acceptance; only provider evidence or explicit stale classification closes an
// approval. legacy pending|resolved rows remain the compatibility surface.
export const ApprovalOutcomeStatus = Schema.Literals([
  'pending',
  'responding',
  'accepted',
  'stale-terminal',
  'unknown',
])
export type ApprovalOutcomeStatus = typeof ApprovalOutcomeStatus.Type

export const ApprovalAcceptanceEvidence = Schema.Struct({
  providerEventId: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.String),
  providerRequestId: Schema.optional(Schema.String),
})
export type ApprovalAcceptanceEvidence = typeof ApprovalAcceptanceEvidence.Type

export const ApprovalOutcome = Schema.Struct({
  requestId: ApprovalRequestId,
  status: ApprovalOutcomeStatus,
  requestedDecision: Schema.optional(ProviderApprovalDecision),
  decision: Schema.optional(Schema.NullOr(ProviderApprovalDecision)),
  detail: Schema.optional(Schema.String),
  actionId: Schema.optional(Schema.String),
  acceptanceEvidence: Schema.optional(ApprovalAcceptanceEvidence),
  updatedAt: IsoDateTime,
})
export type ApprovalOutcome = typeof ApprovalOutcome.Type

export const OrchestrationThread = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  orchestrate: Schema.optional(Schema.Boolean),
  branch: Schema.NullOr(GitRefString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  // the tree and branch the thread's active orchestrate run integrates into.
  // a run can live in a worktree the thread itself never had, and without these
  // the app shows the thread's own (empty) tree and reports that the run changed
  // nothing. optional so payloads from pre-integration servers still decode
  orchestrateRunWorktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  orchestrateRunBranch: Schema.optional(Schema.NullOr(GitRefString)),
  // authoritative current execution for new servers. optional distinguishes
  // an older server from a new server whose thread has no admitted execution
  orchestrateRunExecution: Schema.optional(Schema.NullOr(OrchestrateRunExecution)),
  latestTurn: Schema.NullOr(OrchestrationLatestTurn),
  pendingHandoff: Schema.optional(Schema.NullOr(OrchestrationPendingHandoff)),
  providerSwitch: Schema.NullOr(OrchestrationProviderSwitch).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  // optional on the wire so pre-generation snapshots keep decoding; live
  // projections always emit a non-negative value and only archive advances it
  archiveGeneration: Schema.optional(NonNegativeInt),
  origin: Schema.NullOr(ThreadOrigin).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  settledOverride: Schema.NullOr(Schema.Literals(['settled', 'active'])).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  settledAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  // last re-entry into the active list; old payloads decode to null
  unsettledAt: Schema.optional(Schema.NullOr(IsoDateTime)).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  // snooze is an overlay on the active lifecycle, not a fourth destination:
  // a snoozed thread stays "active" in the model and is only suppressed from
  // the inbox until snoozedUntil passes (or the thread raises its hand).
  // optional so payloads from pre-snooze servers still decode.
  snoozedUntil: Schema.optional(Schema.NullOr(IsoDateTime)),
  snoozedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  // active pinned threads render in the pinned block. settled and snoozed
  // threads stay in their lifecycle shelves while retaining this timestamp.
  // optional so payloads from pre-pinning servers still decode.
  pinnedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  deletedAt: Schema.NullOr(IsoDateTime),
  messages: Schema.Array(OrchestrationMessage),
  proposedPlans: Schema.Array(OrchestrationProposedPlan).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  orchestratePlans: Schema.Array(OrchestratePlanRevision).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  activities: Schema.Array(OrchestrationThreadActivity),
  checkpoints: Schema.Array(OrchestrationCheckpointSummary),
  session: Schema.NullOr(OrchestrationSession),
  // optional so payloads from pre-outcome servers still decode
  approvalOutcomes: Schema.optional(Schema.Array(ApprovalOutcome)),
})
export type OrchestrationThread = typeof OrchestrationThread.Type

export const OrchestrationReadModel = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  projects: Schema.Array(OrchestrationProject),
  threads: Schema.Array(OrchestrationThread),
  // optional while independently released servers/clients cross the exact-run
  // capability boundary. Server command/projector owners normalize absence to
  // an empty history; legacy payloads are never promoted into exact identity.
  orchestrateRuns: Schema.optional(Schema.Array(OrchestrateRunAggregate)),
  orchestrateRunExecutions: Schema.optional(Schema.Array(OrchestrateRunExecution)),
  updatedAt: IsoDateTime,
})
export type OrchestrationReadModel = typeof OrchestrationReadModel.Type

export const OrchestrationProjectShell = Schema.Struct({
  id: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
})
export type OrchestrationProjectShell = typeof OrchestrationProjectShell.Type

export const OrchestrationThreadShell = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  orchestrate: Schema.optional(Schema.Boolean),
  branch: Schema.NullOr(GitRefString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  // projected onto the shell as well as the detail because the sidebar reads
  // only the shell, and the sidebar is the surface that shows nothing at all for
  // a thread whose run lives in another worktree
  orchestrateRunWorktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  orchestrateRunBranch: Schema.optional(Schema.NullOr(GitRefString)),
  orchestrateRunExecution: Schema.optional(Schema.NullOr(OrchestrateRunExecution)),
  latestTurn: Schema.NullOr(OrchestrationLatestTurn),
  providerSwitch: Schema.NullOr(OrchestrationProviderSwitch).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  origin: Schema.NullOr(ThreadOrigin).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  settledOverride: Schema.NullOr(Schema.Literals(['settled', 'active'])).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  settledAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  // see OrchestrationThread.unsettledAt
  unsettledAt: Schema.optional(Schema.NullOr(IsoDateTime)).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  snoozedUntil: Schema.optional(Schema.NullOr(IsoDateTime)),
  snoozedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  pinnedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  session: Schema.NullOr(OrchestrationSession),
  latestUserMessageAt: Schema.NullOr(IsoDateTime),
  hasPendingApprovals: Schema.Boolean,
  hasPendingUserInput: Schema.Boolean,
  hasActionableProposedPlan: Schema.Boolean,
  // optional so payloads from pre-outcome servers still decode
  approvalOutcomes: Schema.optional(Schema.Array(ApprovalOutcome)),
})
export type OrchestrationThreadShell = typeof OrchestrationThreadShell.Type

export const OrchestrationShellSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  projects: Schema.Array(OrchestrationProjectShell),
  threads: Schema.Array(OrchestrationThreadShell),
  updatedAt: IsoDateTime,
})
export type OrchestrationShellSnapshot = typeof OrchestrationShellSnapshot.Type

export const OrchestrationShellStreamEvent = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('project-upserted'),
    sequence: NonNegativeInt,
    project: OrchestrationProjectShell,
  }),
  Schema.Struct({
    kind: Schema.Literal('project-removed'),
    sequence: NonNegativeInt,
    projectId: ProjectId,
  }),
  Schema.Struct({
    kind: Schema.Literal('thread-upserted'),
    sequence: NonNegativeInt,
    thread: OrchestrationThreadShell,
  }),
  Schema.Struct({
    kind: Schema.Literal('thread-removed'),
    sequence: NonNegativeInt,
    threadId: ThreadId,
  }),
])
export type OrchestrationShellStreamEvent = typeof OrchestrationShellStreamEvent.Type

export const OrchestrationShellStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('synchronized'),
  }),
  Schema.Struct({
    kind: Schema.Literal('snapshot'),
    snapshot: OrchestrationShellSnapshot,
  }),
  OrchestrationShellStreamEvent,
])
export type OrchestrationShellStreamItem = typeof OrchestrationShellStreamItem.Type

export const OrchestrationSubscribeShellInput = Schema.Struct({
  // when provided, the server skips the initial full shell snapshot and instead
  // replays shell events after this sequence before streaming live events.
  // clients that already hold a cached (or HTTP-loaded) shell snapshot pass its
  // sequence here so the subscription resumes without re-sending the entire
  // projects/threads list (overlapping events are deduped by sequence on the
  // client).
  afterSequence: Schema.optionalKey(NonNegativeInt),
  // requests an explicit marker after the subscription has emitted its initial
  // snapshot or catch-up replay and before it begins emitting live events.
  requestCompletionMarker: Schema.optionalKey(Schema.Boolean),
})
export type OrchestrationSubscribeShellInput = typeof OrchestrationSubscribeShellInput.Type

export const OrchestrationSubscribeThreadInput = Schema.Struct({
  threadId: ThreadId,
  // when provided, the server skips the initial snapshot frame and instead
  // replays events after this sequence before streaming live events. Clients
  // that load the snapshot over HTTP pass the snapshot's sequence here so the
  // live subscription resumes without a gap (overlapping events are deduped by
  // sequence on the client).
  afterSequence: Schema.optionalKey(NonNegativeInt),
  // requests an explicit marker after the subscription has emitted its initial
  // snapshot or catch-up replay and before it begins emitting live events.
  requestCompletionMarker: Schema.optionalKey(Schema.Boolean),
})
export type OrchestrationSubscribeThreadInput = typeof OrchestrationSubscribeThreadInput.Type

export const OrchestrationThreadDetailSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  thread: OrchestrationThread,
})
export type OrchestrationThreadDetailSnapshot = typeof OrchestrationThreadDetailSnapshot.Type

export const ProjectCreateCommand = Schema.Struct({
  type: Schema.Literal('project.create'),
  commandId: CommandId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  createWorkspaceRootIfMissing: Schema.optional(Schema.Boolean),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  createdAt: IsoDateTime,
})

const ProjectMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal('project.meta.update'),
  commandId: CommandId,
  projectId: ProjectId,
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
})

const ProjectDeleteCommand = Schema.Struct({
  type: Schema.Literal('project.delete'),
  commandId: CommandId,
  projectId: ProjectId,
  force: Schema.optional(Schema.Boolean),
})

const ThreadCreateCommand = Schema.Struct({
  type: Schema.Literal('thread.create'),
  commandId: CommandId,
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  orchestrate: Schema.optional(Schema.Boolean),
  branch: Schema.NullOr(GitRefString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  origin: Schema.optional(ThreadOrigin),
  createdAt: IsoDateTime,
})

const ClientThreadCreateCommand = Schema.Struct({
  type: Schema.Literal('thread.create'),
  commandId: CommandId,
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  orchestrate: Schema.optional(Schema.Boolean),
  branch: Schema.NullOr(GitRefString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
})

const ThreadDeleteCommand = Schema.Struct({
  type: Schema.Literal('thread.delete'),
  commandId: CommandId,
  threadId: ThreadId,
})

const ThreadArchiveCommand = Schema.Struct({
  type: Schema.Literal('thread.archive'),
  commandId: CommandId,
  threadId: ThreadId,
})

const ThreadUnarchiveCommand = Schema.Struct({
  type: Schema.Literal('thread.unarchive'),
  commandId: CommandId,
  threadId: ThreadId,
})

const ThreadSettleCommand = Schema.Struct({
  type: Schema.Literal('thread.settle'),
  commandId: CommandId,
  threadId: ThreadId,
})

const ThreadUnsettleCommand = Schema.Struct({
  type: Schema.Literal('thread.unsettle'),
  commandId: CommandId,
  threadId: ThreadId,
  // commands only carry "user": activity un-settles are decided server-side
  // (the decider emits thread.unsettled(reason: "activity") events directly,
  // never through this command), so a client cannot forge the neutral reset.
  reason: Schema.Literal('user'),
})

const ThreadSnoozeCommand = Schema.Struct({
  type: Schema.Literal('thread.snooze'),
  commandId: CommandId,
  threadId: ThreadId,
  // the wake time. Event-based wake conditions (PR merged, review posted)
  // will arrive as an optional condition field alongside this; time-based
  // snooze is just the first kind of condition.
  snoozedUntil: IsoDateTime,
})

const ThreadUnsnoozeCommand = Schema.Struct({
  type: Schema.Literal('thread.unsnooze'),
  commandId: CommandId,
  threadId: ThreadId,
  // commands only carry "user": activity wakes are decided server-side (the
  // decider emits thread.unsnoozed(reason: "activity") directly), and timer
  // wakes need no event at all — clients derive visibility from snoozedUntil,
  // so a passed wake time simply stops classifying as snoozed.
  reason: Schema.Literal('user'),
})

const ThreadPinCommand = Schema.Struct({
  type: Schema.Literal('thread.pin'),
  commandId: CommandId,
  threadId: ThreadId,
})

const ThreadUnpinCommand = Schema.Struct({
  type: Schema.Literal('thread.unpin'),
  commandId: CommandId,
  threadId: ThreadId,
})

const ThreadMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal('thread.meta.update'),
  commandId: CommandId,
  threadId: ThreadId,
  title: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  branch: Schema.optional(Schema.NullOr(GitRefString)),
  expectedBranch: Schema.optional(Schema.NullOr(GitRefString)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
})

const ThreadRuntimeModeSetCommand = Schema.Struct({
  type: Schema.Literal('thread.runtime-mode.set'),
  commandId: CommandId,
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  createdAt: IsoDateTime,
})

const ThreadInteractionModeSetCommand = Schema.Struct({
  type: Schema.Literal('thread.interaction-mode.set'),
  commandId: CommandId,
  threadId: ThreadId,
  interactionMode: ProviderInteractionMode,
  orchestrate: Schema.optional(Schema.Boolean),
  createdAt: IsoDateTime,
})

export const WORKER_VERDICT_MAX_LENGTH = 200
export const WORKER_VERDICT_ACTIVITY_KIND = 'orchestrate.worker.verdict'
export const WorkerVerdict = TrimmedString.check(Schema.isMaxLength(WORKER_VERDICT_MAX_LENGTH))
export type WorkerVerdict = typeof WorkerVerdict.Type

const ThreadWorkerVerdictSetCommand = Schema.Struct({
  type: Schema.Literal('thread.worker-verdict.set'),
  commandId: CommandId,
  threadId: ThreadId,
  runId: TrimmedNonEmptyString,
  jobId: TrimmedNonEmptyString,
  verdict: WorkerVerdict,
  createdAt: IsoDateTime,
})

export const ThreadProviderSwitchCommand = Schema.Struct({
  type: Schema.Literal('thread.provider.switch'),
  commandId: CommandId,
  threadId: ThreadId,
  targetModelSelection: ModelSelection,
  expectedCurrentInstanceId: ProviderInstanceId,
})
export type ThreadProviderSwitchCommand = typeof ThreadProviderSwitchCommand.Type

const ThreadTurnStartBootstrapCreateThread = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  orchestrate: Schema.optional(Schema.Boolean),
  branch: Schema.NullOr(GitRefString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
})

const ThreadTurnStartBootstrapPrepareWorktree = Schema.Struct({
  projectCwd: TrimmedNonEmptyString,
  baseBranch: GitRefString,
  branch: Schema.optional(GitRefString),
  startFromOrigin: Schema.optional(Schema.Boolean),
})

const ThreadTurnStartBootstrap = Schema.Struct({
  createThread: Schema.optional(ThreadTurnStartBootstrapCreateThread),
  prepareWorktree: Schema.optional(ThreadTurnStartBootstrapPrepareWorktree),
  runSetupScript: Schema.optional(Schema.Boolean),
})

export type ThreadTurnStartBootstrap = typeof ThreadTurnStartBootstrap.Type

export const ThreadTurnStartCommand = Schema.Struct({
  type: Schema.Literal('thread.turn.start'),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal('user'),
    text: Schema.String,
    attachments: Schema.Array(ChatAttachment),
  }),
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  runtimeModeAcknowledgements: Schema.optionalKey(
    Schema.Array(ProviderRuntimeModeWarningIdSchema).pipe(
      Schema.withDecodingDefault(Effect.succeed([] as const)),
    ),
  ),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  orchestrate: Schema.optional(Schema.Boolean),
  bootstrap: Schema.optional(ThreadTurnStartBootstrap),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  importContinuationConsent: Schema.optional(ThreadImportContinuationConsent),
  createdAt: IsoDateTime,
})

const ClientThreadTurnStartCommand = Schema.Struct({
  type: Schema.Literal('thread.turn.start'),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal('user'),
    text: Schema.String,
    attachments: Schema.Array(
      Schema.Union([UploadChatAttachment, ChatImageAttachment, ChatFileAttachment]),
    ).check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
  }),
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode,
  runtimeModeAcknowledgements: Schema.optionalKey(
    Schema.Array(ProviderRuntimeModeWarningIdSchema).pipe(
      Schema.withDecodingDefault(Effect.succeed([] as const)),
    ),
  ),
  interactionMode: ProviderInteractionMode,
  orchestrate: Schema.optional(Schema.Boolean),
  bootstrap: Schema.optional(ThreadTurnStartBootstrap),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  importContinuationConsent: Schema.optional(ThreadImportContinuationConsent),
  createdAt: IsoDateTime,
})

const ThreadTurnInterruptCommand = Schema.Struct({
  type: Schema.Literal('thread.turn.interrupt'),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
})

const ThreadApprovalRespondCommand = Schema.Struct({
  type: Schema.Literal('thread.approval.respond'),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
  createdAt: IsoDateTime,
})

const ThreadUserInputRespondCommand = Schema.Struct({
  type: Schema.Literal('thread.user-input.respond'),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  createdAt: IsoDateTime,
})

export const OrchestratePlanDecision = Schema.Literals(['approve', 'reject', 'discuss'])
export type OrchestratePlanDecision = typeof OrchestratePlanDecision.Type

// a per-stage binding override chosen in the plan card; only present fields change
export const OrchestratePlanStageOverride = Schema.Struct({
  stageId: TrimmedNonEmptyString,
  provider: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  effort: Schema.optional(TrimmedNonEmptyString),
  workers: Schema.optional(NonNegativeInt),
})
export type OrchestratePlanStageOverride = typeof OrchestratePlanStageOverride.Type

// typed plan-gate response: replaces the token-grammar chat reply; the server
// validates revision ownership/staleness, records the decision, and delivers a
// canonical envelope to the orchestrator through the normal turn path
const ThreadOrchestratePlanRespondCommand = Schema.Struct({
  type: Schema.Literal('thread.orchestrate-plan.respond'),
  commandId: CommandId,
  threadId: ThreadId,
  runId: OrchestratePlanRunId,
  revision: NonNegativeInt,
  decision: OrchestratePlanDecision,
  stageOverrides: Schema.optional(Schema.Array(OrchestratePlanStageOverride)),
  maxWorkers: Schema.optional(NonNegativeInt),
  // free-text rider for discuss (and optional context on reject)
  note: Schema.optional(Schema.String),
  createdAt: IsoDateTime,
})

const ThreadCheckpointRevertCommand = Schema.Struct({
  type: Schema.Literal('thread.checkpoint.revert'),
  commandId: CommandId,
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
})

const ThreadSessionStopCommand = Schema.Struct({
  type: Schema.Literal('thread.session.stop'),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
})

const DispatchableClientOrchestrationCommand = Schema.Union([
  ProjectCreateCommand,
  ProjectMetaUpdateCommand,
  ProjectDeleteCommand,
  ThreadCreateCommand,
  ThreadDeleteCommand,
  ThreadArchiveCommand,
  ThreadUnarchiveCommand,
  ThreadSettleCommand,
  ThreadUnsettleCommand,
  ThreadSnoozeCommand,
  ThreadUnsnoozeCommand,
  ThreadPinCommand,
  ThreadUnpinCommand,
  ThreadMetaUpdateCommand,
  ThreadRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ThreadWorkerVerdictSetCommand,
  ThreadProviderSwitchCommand,
  ThreadTurnStartCommand,
  ThreadTurnInterruptCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadOrchestratePlanRespondCommand,
  ThreadCheckpointRevertCommand,
  ThreadSessionStopCommand,
])
export type DispatchableClientOrchestrationCommand =
  typeof DispatchableClientOrchestrationCommand.Type

export const ClientOrchestrationCommand = Schema.Union([
  ProjectCreateCommand,
  ProjectMetaUpdateCommand,
  ProjectDeleteCommand,
  ClientThreadCreateCommand,
  ThreadDeleteCommand,
  ThreadArchiveCommand,
  ThreadUnarchiveCommand,
  ThreadSettleCommand,
  ThreadUnsettleCommand,
  ThreadSnoozeCommand,
  ThreadUnsnoozeCommand,
  ThreadPinCommand,
  ThreadUnpinCommand,
  ThreadMetaUpdateCommand,
  ThreadRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ThreadWorkerVerdictSetCommand,
  ThreadProviderSwitchCommand,
  ClientThreadTurnStartCommand,
  ThreadTurnInterruptCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadOrchestratePlanRespondCommand,
  ThreadCheckpointRevertCommand,
  ThreadSessionStopCommand,
])
export type ClientOrchestrationCommand = typeof ClientOrchestrationCommand.Type

const ThreadSessionSetCommand = Schema.Struct({
  type: Schema.Literal('thread.session.set'),
  commandId: CommandId,
  threadId: ThreadId,
  session: OrchestrationSession,
  createdAt: IsoDateTime,
})

const ThreadProviderSwitchProgressCommand = Schema.Struct({
  type: Schema.Literal('thread.provider.switch.progress'),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: Schema.optional(EventId),
  expectedRequestedAt: Schema.optional(IsoDateTime),
  phase: Schema.Literals(['compacting', 'finalizing']),
})

const ThreadProviderSwitchFailCommand = Schema.Struct({
  type: Schema.Literal('thread.provider.switch.fail'),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: Schema.optional(EventId),
  expectedRequestedAt: Schema.optional(IsoDateTime),
  sourceModelSelection: Schema.optional(ModelSelection),
  targetModelSelection: Schema.optional(ModelSelection),
  reasonCode: TrimmedNonEmptyString,
  detail: Schema.String,
})

export const ThreadProviderSwitchCompleteCommand = Schema.Struct({
  type: Schema.Literal('thread.provider.switch.complete'),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: Schema.optional(EventId),
  expectedRequestedAt: Schema.optional(IsoDateTime),
  sourceModelSelection: Schema.optional(ModelSelection),
  modelSelection: ModelSelection,
  fromInstanceId: Schema.NullOr(ProviderInstanceId),
  handoffText: Schema.String,
  fromModel: Schema.optional(TrimmedNonEmptyString),
})
export type ThreadProviderSwitchCompleteCommand = typeof ThreadProviderSwitchCompleteCommand.Type

export const ThreadHandoffClearCommand = Schema.Struct({
  type: Schema.Literal('thread.handoff.clear'),
  commandId: CommandId,
  threadId: ThreadId,
})
export type ThreadHandoffClearCommand = typeof ThreadHandoffClearCommand.Type

const ThreadMessageAssistantDeltaCommand = Schema.Struct({
  type: Schema.Literal('thread.message.assistant.delta'),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  delta: Schema.String,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
})

const ThreadMessageAssistantCompleteCommand = Schema.Struct({
  type: Schema.Literal('thread.message.assistant.complete'),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
})

const ThreadProposedPlanUpsertCommand = Schema.Struct({
  type: Schema.Literal('thread.proposed-plan.upsert'),
  commandId: CommandId,
  threadId: ThreadId,
  proposedPlan: OrchestrationProposedPlan,
  createdAt: IsoDateTime,
})

// server-internal: dispatched by the orchestrate MCP toolkit after validation
const ThreadOrchestratePlanUpsertCommand = Schema.Struct({
  type: Schema.Literal('thread.orchestrate-plan.upsert'),
  commandId: CommandId,
  threadId: ThreadId,
  plan: OrchestratePlanRevision,
  createdAt: IsoDateTime,
})

// server-internal: dispatched by the checkpoint reactor once it has verified
// that a tree the turn wrote to is a worktree of the thread's own repository.
// deliberately not client-dispatchable: adoption is only safe because the server
// proved the shared git common dir, and a client-writable field would let any
// surface be pointed at an unrelated repository
const ThreadOrchestrateRunIntegrationSetCommand = Schema.Struct({
  type: Schema.Literal('thread.orchestrate-run-integration.set'),
  commandId: CommandId,
  threadId: ThreadId,
  // null clears the adoption and returns every surface to the thread's own tree.
  // the reactor dispatches it once the recorded tree stops resolving as a
  // worktree of its own, and once the thread's own tree records a turn again
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  branch: Schema.NullOr(GitRefString),
  createdAt: IsoDateTime,
})

// server-internal: the authenticated orchestrate toolkit admits only the exact
// approved plan event owned by its active turn and captures repository/base
// identity before any broker output can become authoritative
const ThreadOrchestrateRunExecutionAdmitCommand = Schema.Struct({
  type: Schema.Literal('thread.orchestrate-run-execution.admit'),
  commandId: CommandId,
  threadId: ThreadId,
  expectedProviderInstanceId: Schema.NullOr(ProviderInstanceId),
  execution: OrchestrateRunExecution,
  createdAt: IsoDateTime,
})

// server-internal: the toolkit supplies the complete next record after it has
// verified every explicitly named broker job and integration Git revision
const ThreadOrchestrateRunExecutionUpdateCommand = Schema.Struct({
  type: Schema.Literal('thread.orchestrate-run-execution.update'),
  commandId: CommandId,
  threadId: ThreadId,
  expectedProviderInstanceId: Schema.NullOr(ProviderInstanceId),
  execution: OrchestrateRunExecution,
  createdAt: IsoDateTime,
})

const ThreadTurnDiffCompleteCommand = Schema.Struct({
  type: Schema.Literal('thread.turn.diff.complete'),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  completedAt: IsoDateTime,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.optional(MessageId),
  checkpointTurnCount: NonNegativeInt,
  ...OptionalCheckpointCaptureIdentityFields,
  createdAt: IsoDateTime,
})

// server-internal: turn zero has no projected turn row, so its exact capture
// identity is recorded as its own durable event instead of fabricating a turn
const ThreadCheckpointBaselineRecordCommand = Schema.Struct({
  type: Schema.Literal('thread.checkpoint.baseline.record'),
  commandId: CommandId,
  threadId: ThreadId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  checkpointCaptureRoot: TrimmedNonEmptyString,
  checkpointRepositoryCommonDir: TrimmedNonEmptyString,
  checkpointCommitOid: TrimmedNonEmptyString,
  capturedAt: IsoDateTime,
  createdAt: IsoDateTime,
})

const ThreadActivityAppendCommand = Schema.Struct({
  type: Schema.Literal('thread.activity.append'),
  commandId: CommandId,
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
  createdAt: IsoDateTime,
})

export const ThreadMessagesImportCommand = Schema.Struct({
  type: Schema.Literal('thread.messages.import'),
  commandId: CommandId,
  threadId: ThreadId,
  messages: Schema.Array(
    Schema.Struct({
      messageId: MessageId,
      role: Schema.Literals(['user', 'assistant']),
      text: Schema.String,
      createdAt: IsoDateTime,
    }),
  ),
  activities: Schema.Array(OrchestrationThreadActivity),
  createdAt: IsoDateTime,
})
export type ThreadMessagesImportCommand = typeof ThreadMessagesImportCommand.Type

const ThreadRevertCompleteCommand = Schema.Struct({
  type: Schema.Literal('thread.revert.complete'),
  commandId: CommandId,
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
})

const InternalOrchestrationCommand = Schema.Union([
  ThreadSessionSetCommand,
  ThreadProviderSwitchProgressCommand,
  ThreadProviderSwitchFailCommand,
  ThreadProviderSwitchCompleteCommand,
  ThreadHandoffClearCommand,
  ThreadMessageAssistantDeltaCommand,
  ThreadMessageAssistantCompleteCommand,
  ThreadProposedPlanUpsertCommand,
  ThreadOrchestratePlanUpsertCommand,
  ThreadOrchestrateRunIntegrationSetCommand,
  ThreadOrchestrateRunExecutionAdmitCommand,
  ThreadOrchestrateRunExecutionUpdateCommand,
  ThreadTurnDiffCompleteCommand,
  ThreadCheckpointBaselineRecordCommand,
  ThreadActivityAppendCommand,
  ThreadMessagesImportCommand,
  ThreadRevertCompleteCommand,
])
export type InternalOrchestrationCommand = typeof InternalOrchestrationCommand.Type

export const OrchestrationCommand = Schema.Union([
  DispatchableClientOrchestrationCommand,
  InternalOrchestrationCommand,
])
export type OrchestrationCommand = typeof OrchestrationCommand.Type

export const OrchestrationEventType = Schema.Literals([
  'project.created',
  'project.meta-updated',
  'project.deleted',
  'thread.created',
  'thread.deleted',
  'thread.archived',
  'thread.unarchived',
  'thread.settled',
  'thread.unsettled',
  'thread.snoozed',
  'thread.unsnoozed',
  'thread.pinned',
  'thread.unpinned',
  'thread.meta-updated',
  'thread.orchestrate-run-integration-set',
  'thread.orchestrate-run-execution-admitted',
  'thread.orchestrate-run-execution-updated',
  'thread.runtime-mode-set',
  'thread.interaction-mode-set',
  'thread.provider-switch-requested',
  'thread.provider-switch-progressed',
  'thread.provider-switch-failed',
  'thread.provider-switched',
  'thread.handoff-cleared',
  'thread.message-sent',
  'thread.turn-start-requested',
  'thread.turn-interrupt-requested',
  'thread.approval-response-requested',
  'thread.user-input-response-requested',
  'thread.checkpoint-revert-requested',
  'thread.reverted',
  'thread.session-stop-requested',
  'thread.session-set',
  'thread.proposed-plan-upserted',
  'thread.orchestrate-plan-upserted',
  'thread.orchestrate-plan-response-requested',
  'thread.checkpoint-baseline-recorded',
  'thread.turn-diff-completed',
  'thread.activity-appended',
])
export type OrchestrationEventType = typeof OrchestrationEventType.Type

export const OrchestrationAggregateKind = Schema.Literals(['project', 'thread'])
export type OrchestrationAggregateKind = typeof OrchestrationAggregateKind.Type
export const OrchestrationActorKind = Schema.Literals(['client', 'server', 'provider'])

export const ProjectCreatedPayload = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
})

export const ProjectMetaUpdatedPayload = Schema.Struct({
  projectId: ProjectId,
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
  updatedAt: IsoDateTime,
})

export const ProjectDeletedPayload = Schema.Struct({
  projectId: ProjectId,
  deletedAt: IsoDateTime,
})

export const ThreadCreatedPayload = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  orchestrate: Schema.optional(Schema.Boolean),
  branch: Schema.NullOr(GitRefString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  origin: Schema.NullOr(ThreadOrigin).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
})

export const ThreadDeletedPayload = Schema.Struct({
  threadId: ThreadId,
  deletedAt: IsoDateTime,
})

export const ThreadArchivedPayload = Schema.Struct({
  threadId: ThreadId,
  archivedAt: IsoDateTime,
  // historical archive events decode as generation zero and remain legacy;
  // every newly decided archive carries the next monotonic generation
  archiveGeneration: Schema.optional(NonNegativeInt),
  updatedAt: IsoDateTime,
})

export const ThreadUnarchivedPayload = Schema.Struct({
  threadId: ThreadId,
  updatedAt: IsoDateTime,
})

export const ThreadSettledPayload = Schema.Struct({
  threadId: ThreadId,
  settledAt: IsoDateTime,
  updatedAt: IsoDateTime,
})

export const ThreadUnsettledPayload = Schema.Struct({
  threadId: ThreadId,
  reason: Schema.Literals(['user', 'activity']),
  updatedAt: IsoDateTime,
})

export const ThreadSnoozedPayload = Schema.Struct({
  threadId: ThreadId,
  snoozedUntil: IsoDateTime,
  snoozedAt: IsoDateTime,
  updatedAt: IsoDateTime,
})

export const ThreadUnsnoozedPayload = Schema.Struct({
  threadId: ThreadId,
  // user: explicit "wake now". activity: real work arrived (user message /
  // session coming alive) and the decider cleared the snooze — mirrors
  // thread.unsettled's activity resets. Timer wakes emit no event: clients
  // derive them from snoozedUntil passing.
  reason: Schema.Literals(['user', 'activity']),
  updatedAt: IsoDateTime,
})

export const ThreadPinnedPayload = Schema.Struct({
  threadId: ThreadId,
  pinnedAt: IsoDateTime,
  updatedAt: IsoDateTime,
})

export const ThreadUnpinnedPayload = Schema.Struct({
  threadId: ThreadId,
  updatedAt: IsoDateTime,
})

export const ThreadMetaUpdatedPayload = Schema.Struct({
  threadId: ThreadId,
  title: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  branch: Schema.optional(Schema.NullOr(GitRefString)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  updatedAt: IsoDateTime,
})

// the tree and branch the thread's active orchestrate run integrates into.
// carries no updatedAt on purpose: adoption is a server observation, not user
// activity, and bumping the thread's updatedAt would reshuffle the inbox for a
// change the user never made
export const ThreadOrchestrateRunIntegrationSetPayload = Schema.Struct({
  threadId: ThreadId,
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  branch: Schema.NullOr(GitRefString),
})

export const ThreadOrchestrateRunExecutionAdmittedPayload = Schema.Struct({
  execution: OrchestrateRunExecution,
})
export type ThreadOrchestrateRunExecutionAdmittedPayload =
  typeof ThreadOrchestrateRunExecutionAdmittedPayload.Type

export const ThreadOrchestrateRunExecutionUpdatedPayload = Schema.Struct({
  execution: OrchestrateRunExecution,
})
export type ThreadOrchestrateRunExecutionUpdatedPayload =
  typeof ThreadOrchestrateRunExecutionUpdatedPayload.Type

export const ThreadRuntimeModeSetPayload = Schema.Struct({
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  updatedAt: IsoDateTime,
})

export const ThreadInteractionModeSetPayload = Schema.Struct({
  threadId: ThreadId,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  orchestrate: Schema.optional(Schema.Boolean),
  updatedAt: IsoDateTime,
})

export const ThreadProviderSwitchRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  targetModelSelection: ModelSelection,
  expectedCurrentInstanceId: Schema.NullOr(ProviderInstanceId),
  sourceModelSelection: Schema.optional(ModelSelection),
})
export type ThreadProviderSwitchRequestedPayload = typeof ThreadProviderSwitchRequestedPayload.Type

export const ThreadProviderSwitchProgressedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: Schema.optional(EventId),
  phase: Schema.Literals(['compacting', 'finalizing']),
})
export type ThreadProviderSwitchProgressedPayload =
  typeof ThreadProviderSwitchProgressedPayload.Type

export const ThreadProviderSwitchFailedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: Schema.optional(EventId),
  sourceModelSelection: Schema.optional(ModelSelection),
  targetModelSelection: Schema.optional(ModelSelection),
  activityVersion: Schema.optional(Schema.Literal(1)),
  reasonCode: TrimmedNonEmptyString,
  detail: Schema.String,
})
export type ThreadProviderSwitchFailedPayload = typeof ThreadProviderSwitchFailedPayload.Type

export const ThreadProviderSwitchedPayload = Schema.Struct({
  requestId: Schema.optional(EventId),
  sourceModelSelection: Schema.optional(ModelSelection),
  activityVersion: Schema.optional(Schema.Literal(1)),
  modelSelection: ModelSelection,
  fromInstanceId: Schema.NullOr(ProviderInstanceId),
  fromModel: Schema.optional(TrimmedNonEmptyString),
  handoffText: Schema.String,
})
export type ThreadProviderSwitchedPayload = typeof ThreadProviderSwitchedPayload.Type

export const ThreadHandoffClearedPayload = Schema.Struct({
  threadId: ThreadId,
})
export type ThreadHandoffClearedPayload = typeof ThreadHandoffClearedPayload.Type

export const ThreadMessageSentPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  provenance: Schema.Literals(['live', 'import']).pipe(
    Schema.optional,
    Schema.withDecodingDefault(Effect.succeed('live')),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
})

export const ThreadTurnStartRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  runtimeModeAcknowledgements: Schema.optionalKey(
    Schema.Array(ProviderRuntimeModeWarningIdSchema).pipe(
      Schema.withDecodingDefault(Effect.succeed([] as const)),
    ),
  ),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  orchestrate: Schema.optional(Schema.Boolean),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  importContinuationAuthority: Schema.optional(ThreadImportContinuationAuthority),
  createdAt: IsoDateTime,
})

export const ThreadTurnInterruptRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
})

export const ThreadApprovalResponseRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
  createdAt: IsoDateTime,
  // additive: live clients can render responding state without waiting for projection
  approvalOutcome: Schema.optional(ApprovalOutcome),
})

const ThreadUserInputResponseRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  createdAt: IsoDateTime,
})

export const ThreadOrchestratePlanUpsertedPayload = Schema.Struct({
  threadId: ThreadId,
  plan: OrchestratePlanRevision,
  createdAt: IsoDateTime,
})
export type ThreadOrchestratePlanUpsertedPayload = typeof ThreadOrchestratePlanUpsertedPayload.Type

export const ThreadOrchestratePlanResponseRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  runId: OrchestratePlanRunId,
  revision: NonNegativeInt,
  decision: OrchestratePlanDecision,
  stageOverrides: Schema.optional(Schema.Array(OrchestratePlanStageOverride)),
  maxWorkers: Schema.optional(NonNegativeInt),
  note: Schema.optional(Schema.String),
  createdAt: IsoDateTime,
})
export type ThreadOrchestratePlanResponseRequestedPayload =
  typeof ThreadOrchestratePlanResponseRequestedPayload.Type

export const ThreadCheckpointRevertRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
})

export const ThreadRevertedPayload = Schema.Struct({
  threadId: ThreadId,
  turnCount: NonNegativeInt,
})

export const ThreadSessionStopRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  createdAt: IsoDateTime,
})

export const ThreadSessionSetPayload = Schema.Struct({
  threadId: ThreadId,
  session: OrchestrationSession,
})

export const ThreadProposedPlanUpsertedPayload = Schema.Struct({
  threadId: ThreadId,
  proposedPlan: OrchestrationProposedPlan,
})

export const ThreadTurnDiffCompletedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
  ...OptionalCheckpointCaptureIdentityFields,
})

export const ThreadCheckpointBaselineRecordedPayload = Schema.Struct({
  threadId: ThreadId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  checkpointCaptureRoot: TrimmedNonEmptyString,
  checkpointRepositoryCommonDir: TrimmedNonEmptyString,
  checkpointCommitOid: TrimmedNonEmptyString,
  capturedAt: IsoDateTime,
})

export const ThreadActivityAppendedPayload = Schema.Struct({
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
})

export const OrchestrationEventMetadata = Schema.Struct({
  providerTurnId: Schema.optional(TrimmedNonEmptyString),
  providerItemId: Schema.optional(ProviderItemId),
  adapterKey: Schema.optional(TrimmedNonEmptyString),
  requestId: Schema.optional(ApprovalRequestId),
  ingestedAt: Schema.optional(IsoDateTime),
})
export type OrchestrationEventMetadata = typeof OrchestrationEventMetadata.Type

const EventBaseFields = {
  sequence: NonNegativeInt,
  eventId: EventId,
  aggregateKind: OrchestrationAggregateKind,
  aggregateId: Schema.Union([ProjectId, ThreadId]),
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  metadata: OrchestrationEventMetadata,
} as const

const knownOrchestrationEventMembers = [
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal('project.created'),
    payload: ProjectCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal('project.meta-updated'),
    payload: ProjectMetaUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal('project.deleted'),
    payload: ProjectDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal('thread.created'),
    payload: ThreadCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal('thread.deleted'),
    payload: ThreadDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal('thread.archived'),
    payload: ThreadArchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal('thread.unarchived'),
    payload: ThreadUnarchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal('thread.settled'),
    payload: ThreadSettledPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal('thread.unsettled'),
    payload: ThreadUnsettledPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal('thread.snoozed'),
    payload: ThreadSnoozedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal('thread.unsnoozed'),
    payload: ThreadUnsnoozedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal('thread.pinned'),
    payload: ThreadPinnedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal('thread.unpinned'),
    payload: ThreadUnpinnedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal('thread.meta-updated'),
    payload: ThreadMetaUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal('thread.orchestrate-run-integration-set'),
    payload: ThreadOrchestrateRunIntegrationSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal('thread.orchestrate-run-execution-admitted'),
    payload: ThreadOrchestrateRunExecutionAdmittedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal('thread.orchestrate-run-execution-updated'),
    payload: ThreadOrchestrateRunExecutionUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal('thread.runtime-mode-set'),
    payload: ThreadRuntimeModeSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal('thread.interaction-mode-set'),
    payload: ThreadInteractionModeSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal('thread.provider-switch-requested'),
    payload: ThreadProviderSwitchRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal('thread.provider-switch-progressed'),
    payload: ThreadProviderSwitchProgressedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal('thread.provider-switch-failed'),
    payload: ThreadProviderSwitchFailedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal('thread.provider-switched'),
    payload: ThreadProviderSwitchedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal('thread.handoff-cleared'),
    payload: ThreadHandoffClearedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal('thread.message-sent'),
    payload: ThreadMessageSentPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal('thread.turn-start-requested'),
    payload: ThreadTurnStartRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal('thread.turn-interrupt-requested'),
    payload: ThreadTurnInterruptRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal('thread.approval-response-requested'),
    payload: ThreadApprovalResponseRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal('thread.user-input-response-requested'),
    payload: ThreadUserInputResponseRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal('thread.orchestrate-plan-upserted'),
    payload: ThreadOrchestratePlanUpsertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal('thread.orchestrate-plan-response-requested'),
    payload: ThreadOrchestratePlanResponseRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal('thread.checkpoint-revert-requested'),
    payload: ThreadCheckpointRevertRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal('thread.reverted'),
    payload: ThreadRevertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal('thread.session-stop-requested'),
    payload: ThreadSessionStopRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal('thread.session-set'),
    payload: ThreadSessionSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal('thread.proposed-plan-upserted'),
    payload: ThreadProposedPlanUpsertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal('thread.checkpoint-baseline-recorded'),
    payload: ThreadCheckpointBaselineRecordedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal('thread.turn-diff-completed'),
    payload: ThreadTurnDiffCompletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal('thread.activity-appended'),
    payload: ThreadActivityAppendedPayload,
  }),
] as const

type KnownOrchestrationEventType = (typeof knownOrchestrationEventMembers)[number]['Type']['type']

// wire tolerance: the event union used to be closed, so an event type added by
// a newer server failed the whole batch decode on older clients — RpcClient
// decodes stream chunks behind Effect.orDie, so one unknown event killed the
// thread subscription fiber with no retry — and blocked event-store replay on
// downgraded servers. Unknown types now decode into a sentinel member that
// consumers ignore through their existing forward-compatible defaults. The
// sentinel keeps a distinct literal `type` so discriminated narrowing over the
// known members is unaffected, and it encodes back to the original wire shape
// losslessly.
// * known types with malformed payloads still fail loudly: the sentinel's
//   source filter rejects every type in the known list.
export const UNKNOWN_ORCHESTRATION_EVENT_TYPE = 'orchestration.unknown-event'

// compile-time drift guards: `OrchestrationEventType`'s literal list and the
// union's members must stay in lockstep in both directions
type EventTypeMissingFromLiterals = Exclude<KnownOrchestrationEventType, OrchestrationEventType>
type LiteralMissingFromUnion = Exclude<OrchestrationEventType, KnownOrchestrationEventType>
const _orchestrationEventTypeListsMatch: [
  EventTypeMissingFromLiterals | LiteralMissingFromUnion,
] extends [never]
  ? true
  : never = true
void _orchestrationEventTypeListsMatch

const KNOWN_ORCHESTRATION_EVENT_TYPES: ReadonlySet<string> = new Set(
  OrchestrationEventType.literals,
)

const unknownOrchestrationEventTypeFilter = Schema.makeFilter(
  (type: string) =>
    !KNOWN_ORCHESTRATION_EVENT_TYPES.has(type) ||
    'Known event types must decode through their own union member.',
)

// source shape mirrors EventBaseFields loosely (like ModelSelectionSource) so
// base-field validation happens once, in the sentinel target, with actionable
// errors
const UnknownOrchestrationEventSource = Schema.Struct({
  sequence: Schema.Unknown,
  eventId: Schema.Unknown,
  aggregateKind: Schema.Unknown,
  aggregateId: Schema.Unknown,
  occurredAt: Schema.Unknown,
  commandId: Schema.Unknown,
  causationEventId: Schema.Unknown,
  correlationId: Schema.Unknown,
  metadata: Schema.Unknown,
  type: Schema.String.check(unknownOrchestrationEventTypeFilter),
  payload: Schema.Unknown,
})

const UnknownOrchestrationEventSentinel = Schema.Struct({
  ...EventBaseFields,
  type: Schema.Literal(UNKNOWN_ORCHESTRATION_EVENT_TYPE),
  originalType: Schema.String,
  payload: Schema.Unknown,
})

export const UnknownOrchestrationEvent = UnknownOrchestrationEventSource.pipe(
  Schema.decodeTo(
    UnknownOrchestrationEventSentinel,
    SchemaTransformation.transform({
      decode: (raw) =>
        ({
          ...raw,
          type: UNKNOWN_ORCHESTRATION_EVENT_TYPE,
          originalType: raw.type,
        }) as typeof UnknownOrchestrationEventSentinel.Encoded,
      encode: (sentinel) =>
      {
        const { originalType, ...rest } = sentinel
        return {
          ...rest,
          type: originalType,
        } as typeof UnknownOrchestrationEventSource.Encoded
      },
    }),
  ),
)
export type UnknownOrchestrationEvent = typeof UnknownOrchestrationEvent.Type

export const OrchestrationEvent = Schema.Union([
  ...knownOrchestrationEventMembers,
  UnknownOrchestrationEvent,
])
export type OrchestrationEvent = typeof OrchestrationEvent.Type

export const OrchestrationThreadStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('synchronized'),
  }),
  Schema.Struct({
    kind: Schema.Literal('snapshot'),
    snapshot: OrchestrationThreadDetailSnapshot,
  }),
  Schema.Struct({
    kind: Schema.Literal('event'),
    event: OrchestrationEvent,
  }),
])
export type OrchestrationThreadStreamItem = typeof OrchestrationThreadStreamItem.Type

export const OrchestrationCommandReceiptStatus = Schema.Literals(['accepted', 'rejected'])
export type OrchestrationCommandReceiptStatus = typeof OrchestrationCommandReceiptStatus.Type

export const TurnCountRange = Schema.Struct({
  fromTurnCount: NonNegativeInt,
  toTurnCount: NonNegativeInt,
}).check(
  Schema.makeFilter(
    (input) =>
      input.fromTurnCount <= input.toTurnCount ||
      new SchemaIssue.InvalidValue(Option.some(input.fromTurnCount), {
        message: 'fromTurnCount must be less than or equal to toTurnCount',
      }),
    { identifier: 'OrchestrationTurnDiffRange' },
  ),
)

export const ThreadTurnDiff = TurnCountRange.mapFields(
  Struct.assign({
    threadId: ThreadId,
    diff: Schema.String,
  }),
  { unsafePreserveChecks: true },
)

export const ProviderSessionRuntimeStatus = Schema.Literals([
  'starting',
  'running',
  'stopped',
  'error',
])
export type ProviderSessionRuntimeStatus = typeof ProviderSessionRuntimeStatus.Type

const ProjectionThreadTurnStatus = Schema.Literals(['running', 'completed', 'interrupted', 'error'])
export type ProjectionThreadTurnStatus = typeof ProjectionThreadTurnStatus.Type

const ProjectionCheckpointRow = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
})
export type ProjectionCheckpointRow = typeof ProjectionCheckpointRow.Type

export const ProjectionPendingApprovalStatus = Schema.Literals(['pending', 'resolved'])
export type ProjectionPendingApprovalStatus = typeof ProjectionPendingApprovalStatus.Type

export const ProjectionPendingApprovalDecision = Schema.NullOr(ProviderApprovalDecision)
export type ProjectionPendingApprovalDecision = typeof ProjectionPendingApprovalDecision.Type

export const DispatchResult = Schema.Struct({
  sequence: NonNegativeInt,
})
export type DispatchResult = typeof DispatchResult.Type

export const OrchestrationGetTurnDiffInput = TurnCountRange.mapFields(
  Struct.assign({
    threadId: ThreadId,
    ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
  }),
  { unsafePreserveChecks: true },
)
export type OrchestrationGetTurnDiffInput = typeof OrchestrationGetTurnDiffInput.Type

export const OrchestrationGetTurnDiffResult = ThreadTurnDiff
export type OrchestrationGetTurnDiffResult = typeof OrchestrationGetTurnDiffResult.Type

export const OrchestrationGetFullThreadDiffInput = Schema.Struct({
  threadId: ThreadId,
  toTurnCount: NonNegativeInt,
  ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
})
export type OrchestrationGetFullThreadDiffInput = typeof OrchestrationGetFullThreadDiffInput.Type

export const OrchestrationGetFullThreadDiffResult = ThreadTurnDiff
export type OrchestrationGetFullThreadDiffResult = typeof OrchestrationGetFullThreadDiffResult.Type

// the run's integration tree and branch are recorded per thread, so the thread
// id is the whole request. a client-supplied branch or worktree would be a new
// trust boundary buying nothing the server cannot already read
export const OrchestrationGetRunDiffInput = Schema.Struct({
  threadId: ThreadId,
  ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
})
export type OrchestrationGetRunDiffInput = typeof OrchestrationGetRunDiffInput.Type

// a run diff spans an integration branch measured against its fork point, so it
// has no turn range. reusing ThreadTurnDiff would drag fromTurnCount and
// toTurnCount along with nothing meaningful to put in them. the metadata fields
// are nullable because a thread that has adopted no run tree answers with an
// empty diff rather than a failure
export const OrchestrationGetRunDiffResult = Schema.Struct({
  threadId: ThreadId,
  diff: Schema.String,
  branch: Schema.NullOr(GitRefString),
  baseSha: Schema.NullOr(TrimmedNonEmptyString),
  headSha: Schema.NullOr(TrimmedNonEmptyString),
  truncated: Schema.optionalKey(Schema.Boolean),
})
export type OrchestrationGetRunDiffResult = typeof OrchestrationGetRunDiffResult.Type

// additive versioned query: unlike the legacy thread-only method, both ends of
// this range are immutable captured OIDs belonging to one exact execution
export const OrchestrationGetRunExecutionDiffV1Input = Schema.Struct({
  ...OrchestrateRunExecutionIdentity.fields,
  ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
})
export type OrchestrationGetRunExecutionDiffV1Input =
  typeof OrchestrationGetRunExecutionDiffV1Input.Type

export const OrchestrationGetRunExecutionDiffV1Result = Schema.Struct({
  ...OrchestrateRunExecutionIdentity.fields,
  lifecycle: OrchestrateRunExecutionLifecycle,
  availability: OrchestrateRunExecutionAvailability,
  diff: Schema.String,
  branch: Schema.NullOr(GitRefString),
  baseSha: TrimmedNonEmptyString,
  headSha: TrimmedNonEmptyString,
  finalized: Schema.Boolean,
  truncated: Schema.optionalKey(Schema.Boolean),
})
export type OrchestrationGetRunExecutionDiffV1Result =
  typeof OrchestrationGetRunExecutionDiffV1Result.Type

export const IMPORT_SCAN_MAX_CANDIDATES = 50_000
export const IMPORT_SCAN_MAX_ERRORS = 100
export const IMPORT_SESSIONS_MAX_ITEMS = 100
export const IMPORT_SOURCE_PATH_MAX_CHARS = 4_096
export const IMPORT_TITLE_MAX_CHARS = 512
export const IMPORT_METADATA_MAX_CHARS = 512
export const IMPORT_WORKSPACE_ROOT_MAX_CHARS = 4_096
export const IMPORT_RESULT_MESSAGE_MAX_CHARS = 2_048

const ImportSourcePath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(IMPORT_SOURCE_PATH_MAX_CHARS),
)
const ImportTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(IMPORT_TITLE_MAX_CHARS))
const ImportMetadata = TrimmedNonEmptyString.check(Schema.isMaxLength(IMPORT_METADATA_MAX_CHARS))
const ImportGitBranch = GitRefString.check(Schema.isMaxLength(IMPORT_METADATA_MAX_CHARS))
const ImportWorkspaceRoot = TrimmedNonEmptyString.check(
  Schema.isMaxLength(IMPORT_WORKSPACE_ROOT_MAX_CHARS),
)
const ImportResultMessage = TrimmedNonEmptyString.check(
  Schema.isMaxLength(IMPORT_RESULT_MESSAGE_MAX_CHARS),
)

export const ImportScanCandidate = Schema.Struct({
  source: ThreadImportSource,
  sourcePath: ImportSourcePath,
  providerInstanceIds: Schema.Array(ProviderInstanceId),
  nativeSessionId: Schema.NullOr(ImportMetadata),
  title: Schema.NullOr(ImportTitle),
  cwd: Schema.NullOr(ImportWorkspaceRoot),
  gitBranch: Schema.NullOr(ImportGitBranch),
  model: Schema.NullOr(ImportMetadata),
  messageCount: Schema.NullOr(NonNegativeInt),
  modifiedAt: Schema.NullOr(IsoDateTime),
  alreadyImportedThreadId: Schema.NullOr(ThreadId),
  alreadyImportedProviderInstanceId: Schema.NullOr(ProviderInstanceId).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  alreadyImportedArchived: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  matchedProjectId: Schema.NullOr(ProjectId),
  resumable: Schema.Boolean,
})
export type ImportScanCandidate = typeof ImportScanCandidate.Type

export const ImportScanResult = Schema.Struct({
  candidates: Schema.Array(ImportScanCandidate).check(
    Schema.isMaxLength(IMPORT_SCAN_MAX_CANDIDATES),
  ),
  scannedAt: IsoDateTime,
  truncated: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  errors: Schema.Array(
    Schema.Struct({
      sourcePath: Schema.NullOr(ImportSourcePath),
      message: ImportResultMessage,
    }),
  ).check(Schema.isMaxLength(IMPORT_SCAN_MAX_ERRORS + 1)),
})
export type ImportScanResult = typeof ImportScanResult.Type

export const ImportSessionsRequest = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      source: ThreadImportSource,
      sourcePath: ImportSourcePath,
      providerInstanceId: ProviderInstanceId,
    }),
  ).check(Schema.isMaxLength(IMPORT_SESSIONS_MAX_ITEMS)),
})
export type ImportSessionsRequest = typeof ImportSessionsRequest.Type

export const ImportSessionsResult = Schema.Struct({
  imported: Schema.Array(
    Schema.Struct({
      sourcePath: ImportSourcePath,
      threadId: ThreadId,
      projectId: ProjectId,
      messageCount: NonNegativeInt,
      activityCount: NonNegativeInt,
      continuation: ThreadImportContinuation,
    }),
  ).check(Schema.isMaxLength(IMPORT_SESSIONS_MAX_ITEMS)),
  skipped: Schema.Array(
    Schema.Struct({
      sourcePath: ImportSourcePath,
      reason: ImportResultMessage,
      threadId: Schema.NullOr(ThreadId),
    }),
  ).check(Schema.isMaxLength(IMPORT_SESSIONS_MAX_ITEMS)),
  failed: Schema.Array(
    Schema.Struct({
      sourcePath: ImportSourcePath,
      message: ImportResultMessage,
    }),
  ).check(Schema.isMaxLength(IMPORT_SESSIONS_MAX_ITEMS)),
})
export type ImportSessionsResult = typeof ImportSessionsResult.Type

export const THREAD_SEARCH_QUERY_MIN_CHARS = 2
export const THREAD_SEARCH_QUERY_MAX_CHARS = 200
export const THREAD_SEARCH_SNIPPET_MAX_CHARS = 240
export const THREAD_SEARCH_MAX_RESULTS = 50

export const OrchestrationSearchThreadsInput = Schema.Struct({
  query: TrimmedNonEmptyString.check(
    Schema.isMinLength(THREAD_SEARCH_QUERY_MIN_CHARS),
    Schema.isMaxLength(THREAD_SEARCH_QUERY_MAX_CHARS),
  ),
  limit: Schema.optionalKey(
    Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(THREAD_SEARCH_MAX_RESULTS),
    ),
  ),
})
export type OrchestrationSearchThreadsInput = typeof OrchestrationSearchThreadsInput.Type

export const OrchestrationThreadSearchSource = Schema.Literals(['user', 'assistant'])
export const OrchestrationThreadSearchMatch = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  source: OrchestrationThreadSearchSource,
  snippet: Schema.String.check(Schema.isMaxLength(THREAD_SEARCH_SNIPPET_MAX_CHARS)),
  messageCreatedAt: Schema.NullOr(IsoDateTime),
})
export type OrchestrationThreadSearchMatch = typeof OrchestrationThreadSearchMatch.Type

export const OrchestrationSearchThreadsResult = Schema.Struct({
  matches: Schema.Array(OrchestrationThreadSearchMatch),
})
export type OrchestrationSearchThreadsResult = typeof OrchestrationSearchThreadsResult.Type

export class OrchestrationSearchThreadsError extends Schema.TaggedErrorClass<OrchestrationSearchThreadsError>()(
  'OrchestrationSearchThreadsError',
  { message: TrimmedNonEmptyString },
)
{}

export const OrchestrationRpcSchemas = {
  searchThreads: {
    input: OrchestrationSearchThreadsInput,
    output: OrchestrationSearchThreadsResult,
  },
  dispatchCommand: {
    input: ClientOrchestrationCommand,
    output: DispatchResult,
  },
  importScan: {
    input: Schema.Struct({}),
    output: ImportScanResult,
  },
  importSessions: {
    input: ImportSessionsRequest,
    output: ImportSessionsResult,
  },
  getTurnDiff: {
    input: OrchestrationGetTurnDiffInput,
    output: OrchestrationGetTurnDiffResult,
  },
  getFullThreadDiff: {
    input: OrchestrationGetFullThreadDiffInput,
    output: OrchestrationGetFullThreadDiffResult,
  },
  getRunDiff: {
    input: OrchestrationGetRunDiffInput,
    output: OrchestrationGetRunDiffResult,
  },
  getRunExecutionDiffV1: {
    input: OrchestrationGetRunExecutionDiffV1Input,
    output: OrchestrationGetRunExecutionDiffV1Result,
  },
  getArchivedShellSnapshot: {
    input: Schema.Struct({}),
    output: OrchestrationShellSnapshot,
  },
  subscribeThread: {
    input: OrchestrationSubscribeThreadInput,
    output: OrchestrationThreadStreamItem,
  },
  subscribeShell: {
    input: OrchestrationSubscribeShellInput,
    output: OrchestrationShellStreamItem,
  },
} as const

export class OrchestrationGetSnapshotError extends Schema.TaggedErrorClass<OrchestrationGetSnapshotError>()(
  'OrchestrationGetSnapshotError',
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
)
{}

export class OrchestrationDispatchCommandError extends Schema.TaggedErrorClass<OrchestrationDispatchCommandError>()(
  'OrchestrationDispatchCommandError',
  {
    message: TrimmedNonEmptyString,
    code: Schema.optional(TrimmedNonEmptyString),
    cause: Schema.optional(Schema.Defect()),
    // set when the server rolled back a bootstrap thread it just created,
    // letting clients rotate their draft onto a fresh thread id and retry
    bootstrapThreadDisposition: Schema.optional(Schema.Literal('deleted')),
  },
)
{}

export const CheckpointIdentityErrorCode = Schema.Literals([
  'checkpoint-identity-missing',
  'checkpoint-repository-mismatch',
  'checkpoint-ref-oid-mismatch',
  'checkpoint-root-unavailable',
  'checkpoint-destructive-legacy-refusal',
])
export type CheckpointIdentityErrorCode = typeof CheckpointIdentityErrorCode.Type

export class OrchestrationGetTurnDiffError extends Schema.TaggedErrorClass<OrchestrationGetTurnDiffError>()(
  'OrchestrationGetTurnDiffError',
  {
    message: TrimmedNonEmptyString,
    code: Schema.optional(CheckpointIdentityErrorCode),
    cause: Schema.optional(Schema.Defect()),
  },
)
{}

export class OrchestrationGetFullThreadDiffError extends Schema.TaggedErrorClass<OrchestrationGetFullThreadDiffError>()(
  'OrchestrationGetFullThreadDiffError',
  {
    message: TrimmedNonEmptyString,
    code: Schema.optional(CheckpointIdentityErrorCode),
    cause: Schema.optional(Schema.Defect()),
  },
)
{}

export class OrchestrationGetRunDiffError extends Schema.TaggedErrorClass<OrchestrationGetRunDiffError>()(
  'OrchestrationGetRunDiffError',
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
)
{}

export const OrchestrationRunExecutionErrorCode = Schema.Literals([
  'execution-not-found',
  'execution-head-unavailable',
  'execution-repository-unavailable',
  'execution-repository-mismatch',
  'execution-oid-mismatch',
])
export type OrchestrationRunExecutionErrorCode = typeof OrchestrationRunExecutionErrorCode.Type

export class OrchestrationGetRunExecutionDiffV1Error extends Schema.TaggedErrorClass<OrchestrationGetRunExecutionDiffV1Error>()(
  'OrchestrationGetRunExecutionDiffV1Error',
  {
    message: TrimmedNonEmptyString,
    code: OrchestrationRunExecutionErrorCode,
    cause: Schema.optional(Schema.Defect()),
  },
)
{}
