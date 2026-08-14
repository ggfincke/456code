// apps/mobile/src/state/threads/thread-outbox-model.ts
// defines durable queued-message delivery decisions and retry policy

import { isTransportConnectionErrorMessage } from '@t3tools/client-runtime/errors'
import type {
  EnvironmentShellStatus,
  EnvironmentThreadShell,
} from '@t3tools/client-runtime/state/shell'
import {
  CommandId,
  EnvironmentId,
  IsoDateTime,
  MessageId,
  ModelSelection,
  NonNegativeInt,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  normalizeCollaborationMode,
  type ModelSelection as ModelSelectionType,
  type ProjectId as ProjectIdType,
  type ProviderInteractionMode as ProviderInteractionModeType,
  type RuntimeMode as RuntimeModeType,
} from '@t3tools/contracts'
import * as Schema from 'effect/Schema'

import { DraftComposerImageAttachmentSchema } from '../../lib/composer-image-schema'
import type { DraftComposerImageAttachment } from '../../lib/composerImages'
import { scopedThreadKey } from '../../lib/scopedEntities'

const THREAD_OUTBOX_SCHEMA_VERSION = 5
const THREAD_OUTBOX_MAX_RETRY_DELAY_MS = 16_000
const THREAD_OUTBOX_MAX_SETTINGS_SYNC_ATTEMPTS = 3
const THREAD_OUTBOX_MAX_DELIVERY_ATTEMPTS = 3

const QueuedThreadFailureSchema = Schema.Struct({
  reason: Schema.String,
})

const QueuedThreadCreationSchema = Schema.Struct({
  projectId: ProjectId,
  // snapshot of the project's display metadata so a pending task stays
  // presentable in the thread list even when the project shell is not loaded.
  projectTitle: Schema.optional(Schema.String),
  projectCwd: Schema.optional(Schema.String),
  workspaceMode: Schema.Literals(['local', 'worktree']),
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  startFromOrigin: Schema.optional(Schema.Boolean),
})

export const QueuedThreadMessageSchema = Schema.Struct({
  schemaVersion: Schema.Literals([1, 2, 3, 4, THREAD_OUTBOX_SCHEMA_VERSION]),
  environmentId: EnvironmentId,
  threadId: ThreadId,
  messageId: MessageId,
  commandId: CommandId,
  text: Schema.String,
  attachments: Schema.Array(DraftComposerImageAttachmentSchema),
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  orchestrate: Schema.optional(Schema.Boolean),
  // present when the queued item creates a brand-new thread (pending task)
  // instead of appending a turn to an existing one.
  creation: Schema.optional(QueuedThreadCreationSchema),
  failure: Schema.optional(QueuedThreadFailureSchema),
  deliveryAttemptCount: Schema.optional(NonNegativeInt),
  settingsSyncAttemptCount: Schema.optional(NonNegativeInt),
  turnStartCreatedAt: Schema.optional(IsoDateTime),
  createdAt: IsoDateTime,
})

const decodeStoredQueuedThreadMessage = Schema.decodeUnknownSync(QueuedThreadMessageSchema)
const encodeStoredQueuedThreadMessage = Schema.encodeUnknownSync(QueuedThreadMessageSchema)

export interface QueuedThreadCreation
{
  readonly projectId: ProjectIdType
  readonly projectTitle?: string
  readonly projectCwd?: string
  readonly workspaceMode: 'local' | 'worktree'
  readonly branch: string | null
  readonly worktreePath: string | null
  readonly startFromOrigin?: boolean
}

export interface QueuedThreadMessage
{
  readonly environmentId: EnvironmentId
  readonly threadId: ThreadId
  readonly messageId: MessageId
  readonly commandId: CommandId
  readonly text: string
  readonly attachments: ReadonlyArray<DraftComposerImageAttachment>
  readonly modelSelection?: ModelSelectionType
  readonly runtimeMode?: RuntimeModeType
  readonly interactionMode?: ProviderInteractionModeType
  readonly orchestrate?: boolean
  readonly creation?: QueuedThreadCreation
  readonly failure?: QueuedThreadFailure
  readonly deliveryAttemptCount?: number
  readonly settingsSyncAttemptCount?: number
  readonly turnStartCreatedAt?: string
  readonly createdAt: string
}

export interface QueuedThreadFailure
{
  readonly reason: string
}

export interface ThreadSettingsSnapshot
{
  readonly modelSelection: ModelSelectionType
  readonly runtimeMode: RuntimeModeType
  readonly interactionMode: ProviderInteractionModeType
  readonly orchestrate?: boolean
}

export function resolveQueuedThreadSettings(
  message: QueuedThreadMessage,
  thread: ThreadSettingsSnapshot,
  threadStarted: boolean,
): ThreadSettingsSnapshot & { readonly orchestrate: boolean }
{
  const queuedModelSelection = message.modelSelection
  const providerSwitched =
    threadStarted &&
    queuedModelSelection !== undefined &&
    queuedModelSelection.instanceId !== thread.modelSelection.instanceId
  const threadCollaborationMode = normalizeCollaborationMode(
    thread.interactionMode,
    thread.orchestrate,
  )
  const queuedCollaborationMode =
    message.interactionMode === undefined
      ? normalizeCollaborationMode(
          threadCollaborationMode.baseMode,
          message.orchestrate ?? threadCollaborationMode.orchestrate,
        )
      : normalizeCollaborationMode(message.interactionMode, message.orchestrate)
  return {
    modelSelection: providerSwitched
      ? thread.modelSelection
      : (queuedModelSelection ?? thread.modelSelection),
    runtimeMode: message.runtimeMode ?? thread.runtimeMode,
    interactionMode: queuedCollaborationMode.baseMode,
    orchestrate: queuedCollaborationMode.orchestrate,
  }
}

export function modelSelectionsEqual(left: ModelSelectionType, right: ModelSelectionType): boolean
{
  return (
    left.instanceId === right.instanceId &&
    left.model === right.model &&
    JSON.stringify(left.options ?? null) === JSON.stringify(right.options ?? null)
  )
}

export function requiresWebImportContinuation(
  thread: Pick<EnvironmentThreadShell, 'latestTurn' | 'origin'> | null | undefined,
): boolean
{
  return thread?.origin !== null && thread?.origin !== undefined && thread.latestTurn === null
}

export function encodeQueuedThreadMessage(message: QueuedThreadMessage): unknown
{
  return encodeStoredQueuedThreadMessage({
    schemaVersion: THREAD_OUTBOX_SCHEMA_VERSION,
    ...normalizeStoredQueuedThreadMessage(message),
  })
}

export function decodeQueuedThreadMessage(value: unknown): QueuedThreadMessage
{
  const { schemaVersion: _, ...message } = decodeStoredQueuedThreadMessage(value)
  return normalizeStoredQueuedThreadMessage(message)
}

function normalizeStoredQueuedThreadMessage(message: QueuedThreadMessage): QueuedThreadMessage
{
  if (message.interactionMode === undefined && message.orchestrate === undefined)
  {
    return message
  }
  const collaborationMode = normalizeCollaborationMode(
    message.interactionMode ?? 'default',
    message.orchestrate,
  )
  return {
    ...message,
    interactionMode: collaborationMode.baseMode,
    orchestrate: collaborationMode.orchestrate,
  }
}

export function groupQueuedThreadMessages(
  messages: ReadonlyArray<QueuedThreadMessage>,
): Record<string, ReadonlyArray<QueuedThreadMessage>>
{
  const deduplicated = new Map<string, QueuedThreadMessage>()
  for (const message of messages)
  {
    deduplicated.set(`${message.environmentId}\0${message.messageId}`, message)
  }

  const grouped: Record<string, Array<QueuedThreadMessage>> = {}
  for (const message of deduplicated.values())
  {
    const threadKey = scopedThreadKey(message.environmentId, message.threadId)
    ;(grouped[threadKey] ??= []).push(message)
  }
  for (const queue of Object.values(grouped))
  {
    queue.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }
  return grouped
}

export function flattenQueuedThreadMessages(
  queues: Record<string, ReadonlyArray<QueuedThreadMessage>>,
): ReadonlyArray<QueuedThreadMessage>
{
  return Object.values(queues).flat()
}

export function threadOutboxRetryDelayMs(attempt: number): number
{
  return Math.min(1_000 * 2 ** Math.max(0, attempt - 1), THREAD_OUTBOX_MAX_RETRY_DELAY_MS)
}

export type ThreadOutboxDeliveryAction = 'wait' | 'remove' | 'fail' | 'send'

export function resolveThreadOutboxDeliveryAction(input: {
  readonly isCreation: boolean
  readonly threadExists: boolean
  readonly shellStatus: EnvironmentShellStatus
  readonly environmentConnected: boolean
  readonly threadBusy: boolean
  readonly providerSwitchActive: boolean
}): ThreadOutboxDeliveryAction
{
  if (input.isCreation)
  {
    // a pending task creates its thread on delivery. If the thread already
    // exists the creation command went through and only cleanup remains.
    if (input.threadExists)
    {
      return 'remove'
    }
    // wait for the shell to be live before sending: until the thread list has
    // synchronized, a previously delivered creation whose cleanup failed would
    // look missing and get re-issued, duplicating the thread.
    return input.environmentConnected && input.shellStatus === 'live' ? 'send' : 'wait'
  }
  if (!input.threadExists)
  {
    return input.shellStatus === 'live' ? 'fail' : 'wait'
  }
  return input.environmentConnected &&
    input.shellStatus === 'live' &&
    !input.threadBusy &&
    !input.providerSwitchActive
    ? 'send'
    : 'wait'
}

// a queued creation can only be dispatched once its payload would pass server
// validation; incomplete payloads stay pending until the user edits them.
export function isQueuedThreadCreationSendable(
  message: QueuedThreadMessage,
): message is QueuedThreadMessage & {
  readonly creation: QueuedThreadCreation
  readonly modelSelection: ModelSelectionType
}
{
  if (!message.creation)
  {
    return false
  }
  if (message.text.trim().length === 0 || message.modelSelection === undefined)
  {
    return false
  }
  return message.creation.workspaceMode !== 'worktree' || Boolean(message.creation.branch)
}

function errorMessage(error: unknown): string | null
{
  if (error instanceof Error)
  {
    return error.message
  }
  if (typeof error === 'object' && error !== null && 'message' in error)
  {
    return typeof error.message === 'string' ? error.message : null
  }
  return typeof error === 'string' ? error : null
}

export function describeThreadOutboxFailure(
  stage: ThreadOutboxCommandStage,
  error: unknown,
): string
{
  return (
    errorMessage(error) ??
    (stage === 'settings-sync'
      ? 'Thread settings could not be applied.'
      : 'The queued message could not be sent.')
  )
}

export function shouldRetryThreadOutboxDelivery(error: unknown): boolean
{
  if (
    typeof error === 'object' &&
    error !== null &&
    '_tag' in error &&
    error._tag === 'ConnectionTransientError'
  )
  {
    return true
  }
  return isTransportConnectionErrorMessage(errorMessage(error))
}

export function isTurnStartDuringProviderSwitch(error: unknown): boolean
{
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'turn-start-during-switch'
  )
}

export type ThreadOutboxCommandStage = 'settings-sync' | 'start-turn'
export type ThreadOutboxFailureAction = 'wait' | 'retry' | 'fail'

export function resolveThreadOutboxFailureAction(input: {
  readonly stage: ThreadOutboxCommandStage
  readonly error: unknown
  readonly interrupted: boolean
  readonly attempt: number
}): ThreadOutboxFailureAction
{
  if (input.stage === 'start-turn' && isTurnStartDuringProviderSwitch(input.error))
  {
    return 'wait'
  }
  if (input.stage === 'settings-sync')
  {
    return input.attempt < THREAD_OUTBOX_MAX_SETTINGS_SYNC_ATTEMPTS ? 'retry' : 'fail'
  }
  if (input.interrupted || shouldRetryThreadOutboxDelivery(input.error))
  {
    return input.attempt < THREAD_OUTBOX_MAX_DELIVERY_ATTEMPTS ? 'retry' : 'fail'
  }
  return 'fail'
}
