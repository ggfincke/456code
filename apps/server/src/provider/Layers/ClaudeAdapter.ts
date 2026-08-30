// apps/server/src/provider/Layers/ClaudeAdapter.ts
// adapts Claude Agent SDK sessions into canonical provider runtime events
import {
  type CanUseTool,
  type Options as ClaudeQueryOptions,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type SDKMessage,
  type SDKConversationResetMessage,
  type SDKAssistantMessageError,
  type SDKResultMessage,
  type SettingSource,
  type TerminalReason,
} from '@anthropic-ai/claude-agent-sdk'
import { parseCliArgs } from '@t3tools/shared/cliArgs'
import {
  ApprovalRequestId,
  type CanonicalItemType,
  type CanonicalRequestType,
  type ClaudeSettings,
  EventId,
  type ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderItemId,
  type ProviderRuntimeEvent,
  type ProviderRuntimeTurnStatus,
  type ProviderSendTurnInput,
  normalizeCollaborationMode,
  type ProviderSession,
  type ThreadTokenUsageSnapshot,
  type TaskUsageSnapshot,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type UserInputQuestion,
} from '@t3tools/contracts'
import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
  getProviderOptionDescriptors,
} from '@t3tools/shared/model'
import * as Cause from 'effect/Cause'
import * as Crypto from 'effect/Crypto'
import * as DateTime from 'effect/DateTime'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as FileSystem from 'effect/FileSystem'
import * as Fiber from 'effect/Fiber'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Queue from 'effect/Queue'
import * as Ref from 'effect/Ref'
import * as Semaphore from 'effect/Semaphore'
import * as Stream from 'effect/Stream'
import { CLAUDE_PROVIDER_CAPABILITIES } from '../providerCapabilities.ts'

import { resolveAttachmentPath } from '../../attachments/attachmentStore.ts'
import { ServerConfig } from '../../config.ts'
import {
  buildClaudeImageContentBlock,
  buildPromptText,
  buildUserMessage,
  claudeSystemPrompt,
  isSupportedClaudeImageMimeType,
} from '../claude/ClaudePrompt.ts'
import {
  awaitClaudeQueryInitialization,
  type ClaudeQueryFactory,
  type ClaudeQueryRuntime,
  closeClaudeQueryResources,
  createClaudeQuery,
  makeClaudePromptChannel,
  type PromptQueueItem,
} from '../claude/ClaudeSessionRuntime.ts'
import {
  describeUnknownSdkMessage,
  encodeJsonStringForDiagnostics,
  extractAssistantTextBlocks,
  extractContentBlockText,
  readClaudeToolUseResult,
  sdkNativeItemId,
  sdkNativeMethod,
  streamKindFromDeltaType,
  toolInputFingerprint,
  toolResultBlocksFromUserMessage,
  tryParseJsonRecord,
} from '../claude/ClaudeSdkMessages.ts'
import {
  claudeTotalProcessedTokens,
  claudeUsageInputTokens,
  claudeUsageOutputTokens,
  compactBoundaryMetadata,
  compactBoundaryTokenUsageSnapshot,
  lastClaudeUsageIteration,
  maxClaudeContextWindowFromModelUsage,
  normalizeClaudeActiveTokenUsage,
  normalizeClaudeTaskProgressTokenUsage,
  normalizeClaudeTaskUsage,
  selectedClaudeContextWindow,
} from '../claude/ClaudeTokenUsage.ts'
import {
  classifyRequestType,
  classifyToolItemType,
  type ClaudeNativeTaskTool,
  exitPlanCaptureKey,
  extractExitPlanModePlan,
  extractPlanStepsFromTodoInput,
  isClaudeTaskTool,
  isTodoTool,
  makeClaudeAgentCompletion,
  makeClaudeNativeTaskTool,
  normalizeClaudeTaskStatus,
  type PlanStep,
  planStepsFromClaudeTasks,
  readClaudeTaskFromResult,
  readCompletedClaudeAgentOutput,
  readString,
  readStringArray,
  summarizeToolRequest,
  titleForTool,
  toolResultStreamKind,
} from '../claude/ClaudeToolProjection.ts'
import { resolveClaudeSdkExecutablePath } from '../Drivers/ClaudeExecutable.ts'
import { makeClaudeEnvironment } from '../Drivers/ClaudeHome.ts'
import {
  getClaudeModelCapabilities,
  isClaudeUltracodeEffort,
  normalizeClaudeCliEffort,
  resolveClaudeApiModelId,
  resolveClaudeEffort,
} from './ClaudeProvider.ts'
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from '../Errors.ts'
import { type ClaudeAdapterShape } from '../Services/ClaudeAdapter.ts'
import type {
  ProviderAdapterRuntimeEvent,
  ProviderAdapterRuntimeSessionBinding,
} from '../Services/ProviderAdapter.ts'
import { type EventNdjsonLogger, makeEventNdjsonLogger } from './EventNdjsonLogger.ts'

const PROVIDER = ProviderDriverKind.make('claudeAgent')
const CLAUDE_RESUME_FAILURE_MESSAGE =
  'Native Claude history could not be resumed. The session was stopped to avoid continuing from a fresh session.'
type ClaudeSdkEffort = NonNullable<ClaudeQueryOptions['effort']>

interface ClaudeResumeState
{
  readonly threadId?: ThreadId
  readonly resume?: string
  readonly resumeSessionAt?: string
  readonly turnCount?: number
}

interface ClaudeResumeAttempt
{
  readonly sessionId: string
  usable: boolean
  handshakePending: boolean
}

interface ClaudeTurnState
{
  readonly turnId: TurnId
  readonly startedAt: string
  // true for turns auto-started by assistant output arriving without an
  // active turn (background agent/subagent responses between user prompts).
  // synthetic turns are auto-closed by the next sendTurn; real turns are
  // steered instead (the queued message continues the same turn).
  readonly synthetic?: boolean
  readonly items: Array<unknown>
  readonly assistantTextBlocks: Map<number, AssistantTextBlockState>
  readonly assistantTextBlockOrder: Array<AssistantTextBlockState>
  readonly capturedProposedPlanKeys: Set<string>
  latestAssistantUsage: unknown | undefined
  compactedSinceLatestAssistantUsage: boolean
  nextSyntheticAssistantBlockIndex: number
}

interface AssistantTextBlockState
{
  readonly itemId: string
  readonly blockIndex: number
  emittedTextDelta: boolean
  fallbackText: string
  streamClosed: boolean
  completionEmitted: boolean
}

interface PendingApproval
{
  readonly cancel: Effect.Effect<void>
  readonly requestType: CanonicalRequestType
  readonly detail?: string
  readonly suggestions?: ReadonlyArray<PermissionUpdate>
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>
}

// keep "accept for session" inside the current session even when Claude
// suggests a persistent settings destination. MCP tools often supply no
// suggestion, so synthesize a whole-tool session rule in that case.
function toSessionPermissionUpdates(
  toolName: string,
  suggestions: ReadonlyArray<PermissionUpdate> | undefined,
): Array<PermissionUpdate>
{
  const sessionScoped = (suggestions ?? []).map((suggestion): PermissionUpdate => ({
    ...suggestion,
    destination: 'session',
  }))
  if (sessionScoped.length > 0)
  {
    return sessionScoped
  }
  return [
    {
      type: 'addRules',
      rules: [{ toolName }],
      behavior: 'allow',
      destination: 'session',
    },
  ]
}

type PendingUserInputSettlement =
  | {
      readonly _tag: 'answered'
      readonly answers: ProviderUserInputAnswers
    }
  | {
      readonly _tag: 'cancelled'
    }

interface PendingUserInput
{
  readonly questions: ReadonlyArray<UserInputQuestion>
  readonly result: Deferred.Deferred<PendingUserInputSettlement>
  readonly settle: (settlement: PendingUserInputSettlement) => Effect.Effect<boolean>
  readonly cancel: Effect.Effect<void>
}

interface ToolInFlight
{
  readonly itemId: string
  readonly itemType: CanonicalItemType
  readonly toolName: string
  readonly title: string
  readonly detail?: string
  readonly input: Record<string, unknown>
  readonly partialInputJson: string
  readonly lastEmittedInputFingerprint?: string
  readonly nativeTask?: ClaudeNativeTaskTool
}

interface ClaudeNativeTaskCompletion
{
  readonly status: 'completed' | 'failed' | 'stopped'
  readonly summary?: string
  readonly usage?: unknown
  readonly tokenUsage?: TaskUsageSnapshot
}

interface ClaudeNativeTaskState
{
  readonly taskId: string
  toolUseId?: string
  subagentType?: string
  taskType?: string
  workflowName?: string
  authoritativeModel?: string
  completion?: ClaudeNativeTaskCompletion
}

interface ClaudeTaskState
{
  readonly id: string
  subject: string
  status: PlanStep['status']
  readonly blockedBy: Set<string>
}

interface ClaudeSessionContext
{
  session: ProviderSession
  readonly runtimeSessionBinding: ProviderAdapterRuntimeSessionBinding
  promptQueue: Queue.Queue<PromptQueueItem>
  query: ClaudeQueryRuntime
  readonly baseQueryOptions: ClaudeQueryOptions
  readonly runStream: (effect: Effect.Effect<void, never>) => Fiber.Fiber<void, never>
  streamFiber: Fiber.Fiber<void, never> | undefined
  readonly startedAt: string
  readonly basePermissionMode: PermissionMode | undefined
  currentApiModelId: string | undefined
  resumeSessionId: string | undefined
  resumeAttempt: ClaudeResumeAttempt | undefined
  hasResumableHistory: boolean
  orchestrateSystemPromptActive: boolean
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>
  readonly userInputEventGate: Semaphore.Semaphore
  readonly stopGate: Semaphore.Semaphore
  readonly sessionStopped: Deferred.Deferred<void>
  readonly turns: Array<{
    id: TurnId
    items: Array<unknown>
  }>
  readonly inFlightTools: Map<number, ToolInFlight>
  readonly claudeTasks: Map<string, ClaudeTaskState>
  readonly nativeTaskTools: Map<string, ClaudeNativeTaskTool>
  readonly nativeTasks: Map<string, ClaudeNativeTaskState>
  readonly pendingNativeTaskModels: Map<string, string>
  turnState: ClaudeTurnState | undefined
  lastKnownContextWindow: number | undefined
  lastKnownTokenUsage: ThreadTokenUsageSnapshot | undefined
  lastKnownTotalProcessedTokens: number | undefined
  // status + window of the last rate-limit frame we surfaced, so a re-streamed
  // snapshot does not append a duplicate row on every tick
  lastRateLimitKey: string | undefined
  // a terminal model refusal raises its error before the result frame arrives;
  // the frame itself carries no failing reason, so the turn has to be told
  terminalRefusal: string | undefined
  lastAssistantUuid: string | undefined
  lastThreadStartedId: string | undefined
  stopping: boolean
  stopped: boolean
}

export interface ClaudeAdapterLiveOptions
{
  readonly instanceId?: ProviderInstanceId
  readonly environment?: NodeJS.ProcessEnv
  readonly sourceCwd?: string
  readonly createQuery?: ClaudeQueryFactory
  readonly nativeEventLogPath?: string
  readonly nativeEventLogger?: EventNdjsonLogger
}

function isUuid(value: string): boolean
{
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

// the SDK types resetsAt as a bare `number` with no documented unit. treat anything under the
// year-2001 millisecond boundary as epoch seconds so a seven-day reset does not render as 1970
function claudeResetsAtToIso(value: number): string | undefined
{
  if (!Number.isFinite(value) || value <= 0)
  {
    return undefined
  }
  return Option.match(DateTime.make(value > 1e12 ? value : value * 1_000), {
    onNone: () => undefined,
    onSome: DateTime.formatIso,
  })
}

function isSyntheticClaudeThreadId(value: string): boolean
{
  return value.startsWith('claude-thread-')
}

function hasDurableClaudeSessionId(message: SDKMessage): boolean
{
  if (message.type !== 'system')
  {
    return true
  }

  return (
    message.subtype !== 'hook_started' &&
    message.subtype !== 'hook_progress' &&
    message.subtype !== 'hook_response'
  )
}

function isClaudeResumeUsableMessage(message: SDKMessage): boolean
{
  if (message.type === 'system')
  {
    return message.subtype === 'init'
  }

  return (
    message.type === 'stream_event' ||
    message.type === 'user' ||
    message.type === 'assistant' ||
    message.type === 'tool_progress' ||
    message.type === 'tool_use_summary' ||
    (message.type === 'result' && message.subtype === 'success')
  )
}

function toMessage(cause: unknown, fallback: string): string
{
  if (cause instanceof Error && cause.message.length > 0)
  {
    return cause.message
  }
  return fallback
}

function normalizeClaudeStreamMessages(
  cause: Cause.Cause<ProviderAdapterProcessError>,
): ReadonlyArray<string>
{
  const errors: Array<string> = []
  for (const error of Cause.prettyErrors(cause))
  {
    const message = error.message.trim()
    if (message.length > 0)
    {
      errors.push(message)
    }
  }
  if (errors.length > 0)
  {
    return errors
  }

  const squashed = toMessage(Cause.squash(cause), '').trim()
  return squashed.length > 0 ? [squashed] : []
}

function getEffectiveClaudeAgentEffort(
  effort: string | null | undefined,
  model: string | null | undefined,
): ClaudeSdkEffort | null
{
  const normalized = normalizeClaudeCliEffort(effort, model)
  return normalized ? (normalized as ClaudeSdkEffort) : null
}

function isClaudeInterruptedMessage(message: string): boolean
{
  const normalized = message.toLowerCase()
  return (
    normalized.includes('all fibers interrupted without error') ||
    normalized.includes('request was aborted') ||
    normalized.includes('interrupted by user')
  )
}

function isClaudeInterruptedCause(cause: Cause.Cause<ProviderAdapterProcessError>): boolean
{
  return (
    Cause.hasInterruptsOnly(cause) ||
    normalizeClaudeStreamMessages(cause).some(isClaudeInterruptedMessage) ||
    cause.reasons.some(
      (reason) =>
        Cause.isFailReason(reason) && isClaudeInterruptedMessage(toMessage(reason.error.cause, '')),
    )
  )
}

function resultErrorsText(result: SDKResultMessage): string
{
  return 'errors' in result && Array.isArray(result.errors)
    ? result.errors.join(' ').toLowerCase()
    : ''
}

function isInterruptedResult(result: SDKResultMessage): boolean
{
  const errors = resultErrorsText(result)
  if (errors.includes('interrupt'))
  {
    return true
  }

  // deliberately not gated on `is_error === false`. An abort the SDK also flags as an error is
  // still an abort, and requiring the flag to be clear is what let a user-pressed Stop fall
  // through to 'failed' and surface its raw internal diagnostic as a provider crash. The
  // remaining conjuncts -- an execution-phase result carrying explicit abort text -- are what
  // make this specific
  return (
    result.subtype === 'error_during_execution' &&
    (errors.includes('request was aborted') ||
      errors.includes('interrupted by user') ||
      errors.includes('aborted'))
  )
}

function asRuntimeItemId(value: string): RuntimeItemId
{
  return RuntimeItemId.make(value)
}

function asCanonicalTurnId(value: TurnId): TurnId
{
  return value
}

function asRuntimeRequestId(value: ApprovalRequestId): RuntimeRequestId
{
  return RuntimeRequestId.make(value)
}

const PENDING_NATIVE_TASK_MODEL_CAP = 64

// snapshots can beat task_started; retain only the newest bounded FIFO window
function rememberPendingNativeTaskModel(
  pending: Map<string, string>,
  toolUseId: string,
  model: string,
): void
{
  pending.set(toolUseId, model)
  if (pending.size <= PENDING_NATIVE_TASK_MODEL_CAP)
  {
    return
  }

  const oldest = pending.keys().next()
  if (!oldest.done)
  {
    pending.delete(oldest.value)
  }
}

function nativeTaskModel(
  context: ClaudeSessionContext,
  state: ClaudeNativeTaskState,
): string | undefined
{
  const taskTool = state.toolUseId ? context.nativeTaskTools.get(state.toolUseId) : undefined
  return (
    state.authoritativeModel ??
    taskTool?.agentCompletion?.resolvedModel ??
    taskTool?.requestedModel ??
    context.session.model ??
    undefined
  )
}

// merge sdk task frames into the per-session native task state, preferring
// fresh fields but falling back to what the correlated task tool captured
function updateClaudeNativeTaskState(
  context: ClaudeSessionContext,
  input: {
    readonly taskId: string
    readonly toolUseId?: string
    readonly subagentType?: string
    readonly taskType?: string
    readonly workflowName?: string
  },
): ClaudeNativeTaskState
{
  const state = context.nativeTasks.get(input.taskId) ?? {
    taskId: input.taskId,
  }
  const toolUseId = input.toolUseId ?? state.toolUseId
  const taskTool = toolUseId ? context.nativeTaskTools.get(toolUseId) : undefined

  if (toolUseId)
  {
    state.toolUseId = toolUseId
  }
  const subagentType = input.subagentType ?? state.subagentType ?? taskTool?.subagentType
  if (subagentType)
  {
    state.subagentType = subagentType
  }
  if (input.taskType)
  {
    state.taskType = input.taskType
  }
  const workflowName = input.workflowName ?? state.workflowName ?? taskTool?.workflowName
  if (workflowName)
  {
    state.workflowName = workflowName
  }

  context.nativeTasks.set(input.taskId, state)
  return state
}

function readClaudeResumeSessionIdCandidate(resumeCursor: unknown): string | undefined
{
  if (!resumeCursor || typeof resumeCursor !== 'object')
  {
    return undefined
  }
  const cursor = resumeCursor as {
    resume?: unknown
    sessionId?: unknown
  }
  const resume =
    typeof cursor.resume === 'string' && cursor.resume.length > 0 ? cursor.resume : null
  const sessionId =
    typeof cursor.sessionId === 'string' && cursor.sessionId.length > 0 ? cursor.sessionId : null
  return resume ?? sessionId ?? undefined
}

function readClaudeResumeState(resumeCursor: unknown): ClaudeResumeState | undefined
{
  if (!resumeCursor || typeof resumeCursor !== 'object')
  {
    return undefined
  }
  const cursor = resumeCursor as {
    threadId?: unknown
    resume?: unknown
    sessionId?: unknown
    resumeSessionAt?: unknown
    turnCount?: unknown
  }

  const threadIdCandidate = typeof cursor.threadId === 'string' ? cursor.threadId : undefined
  const threadId =
    threadIdCandidate && !isSyntheticClaudeThreadId(threadIdCandidate)
      ? ThreadId.make(threadIdCandidate)
      : undefined
  const resumeCandidate = readClaudeResumeSessionIdCandidate(resumeCursor)
  const resume = resumeCandidate && isUuid(resumeCandidate) ? resumeCandidate : undefined
  const resumeSessionAt =
    typeof cursor.resumeSessionAt === 'string' ? cursor.resumeSessionAt : undefined
  const turnCountValue = typeof cursor.turnCount === 'number' ? cursor.turnCount : undefined

  return {
    ...(threadId ? { threadId } : {}),
    ...(resume ? { resume } : {}),
    ...(resumeSessionAt ? { resumeSessionAt } : {}),
    ...(turnCountValue !== undefined && Number.isInteger(turnCountValue) && turnCountValue >= 0
      ? { turnCount: turnCountValue }
      : {}),
  }
}

function applyClaudeTaskToolResult(
  tasks: Map<string, ClaudeTaskState>,
  tool: ToolInFlight,
  result: Record<string, unknown> | undefined,
): boolean
{
  if (!isClaudeTaskTool(tool.toolName))
  {
    return false
  }

  let changed = false
  if (tool.toolName === 'TaskList')
  {
    const resultTasks = result?.tasks
    if (!Array.isArray(resultTasks))
    {
      return false
    }
    tasks.clear()
    for (const entry of resultTasks)
    {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry))
      {
        continue
      }
      const task = entry as Record<string, unknown>
      const id = readString(task.id)
      const subject = readString(task.subject)
      if (!id || !subject)
      {
        continue
      }
      tasks.set(id, {
        id,
        subject,
        status: normalizeClaudeTaskStatus(task.status),
        blockedBy: new Set(readStringArray(task.blockedBy)),
      })
    }
    return tasks.size > 0
  }

  if (tool.toolName === 'TaskCreate')
  {
    const resultTask = readClaudeTaskFromResult(result)
    const id = readString(resultTask?.id)
    const subject = readString(resultTask?.subject) ?? readString(tool.input.subject)
    if (!id || !subject)
    {
      return false
    }
    tasks.set(id, {
      id,
      subject,
      status: normalizeClaudeTaskStatus(tool.input.status),
      blockedBy: new Set(readStringArray(tool.input.blockedBy)),
    })
    return true
  }

  const taskId = readString(tool.input.taskId) ?? readString(result?.taskId)
  if (!taskId)
  {
    return false
  }
  const task = tasks.get(taskId)
  if (!task)
  {
    return false
  }
  const subject = readString(tool.input.subject)
  if (subject && task.subject !== subject)
  {
    task.subject = subject
    changed = true
  }
  if (typeof tool.input.status === 'string')
  {
    const status = normalizeClaudeTaskStatus(tool.input.status)
    if (task.status !== status)
    {
      task.status = status
      changed = true
    }
  }
  for (const dependency of readStringArray(tool.input.addBlockedBy))
  {
    if (!task.blockedBy.has(dependency))
    {
      task.blockedBy.add(dependency)
      changed = true
    }
  }
  for (const dependency of readStringArray(tool.input.removeBlockedBy))
  {
    if (task.blockedBy.delete(dependency))
    {
      changed = true
    }
  }
  return changed
}

const CLAUDE_SETTING_SOURCES = [
  'user',
  'project',
  'local',
] as const satisfies ReadonlyArray<SettingSource>

const buildUserMessageEffect = Effect.fn('buildUserMessageEffect')(function* (
  input: ProviderSendTurnInput,
  dependencies: {
    readonly fileSystem: FileSystem.FileSystem
    readonly attachmentsDir: string
    readonly boundInstanceId: ProviderInstanceId
  },
)
{
  const text = buildPromptText(input, dependencies.boundInstanceId)
  const sdkContent: Array<Record<string, unknown>> = []

  if (text.length > 0)
  {
    sdkContent.push({ type: 'text', text })
  }

  for (const attachment of input.attachments ?? [])
  {
    // generic files use the verified path context supplied by ProviderService
    if (attachment.type !== 'image')
    {
      continue
    }

    if (!isSupportedClaudeImageMimeType(attachment.mimeType))
    {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: 'turn/start',
        detail: `Unsupported Claude image attachment type '${attachment.mimeType}'.`,
      })
    }

    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: dependencies.attachmentsDir,
      attachment,
    })
    if (!attachmentPath)
    {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: 'turn/start',
        detail: `Invalid attachment id '${attachment.id}'.`,
      })
    }

    const bytes = yield* dependencies.fileSystem.readFile(attachmentPath).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: 'turn/start',
            detail: 'Failed to read attachment file.',
            cause,
          }),
      ),
    )

    sdkContent.push(
      buildClaudeImageContentBlock({
        mimeType: attachment.mimeType,
        bytes,
      }),
    )
  }

  return buildUserMessage({ sdkContent })
})

// a stopped stream and a hook-blocked turn are non-completions, not provider errors: they end the
// turn without anything having gone wrong, so they must not raise an error banner
const INTERRUPTING_TERMINAL_REASONS = new Set<TerminalReason>([
  'aborted_streaming',
  'aborted_tools',
  'hook_stopped',
  'stop_hook_prevented',
])

// reasons that end a turn against the user's intent. everything absent from both sets --
// 'completed', 'max_turns', 'background_requested', 'tool_deferred' -- is a real completion
const FAILING_TERMINAL_REASONS = new Set<TerminalReason>([
  'api_error',
  'blocking_limit',
  'budget_exhausted',
  'image_error',
  'malformed_tool_use_exhausted',
  'model_error',
  'prompt_too_long',
  'rapid_refill_breaker',
  'structured_output_retry_exhausted',
  'tool_deferred_unavailable',
  'turn_setup_failed',
])

// `subtype: 'success'` means the SDK reached a terminal frame, NOT that the turn succeeded. The
// same frame carries `is_error`, `api_error_status` (429) and `terminal_reason`, and a usage-limit
// kill sets those while leaving the subtype alone. Reading only the subtype is what projected a
// 3 h 26 m death as a clean completion: session ready, lastError null, turn state 'completed'.
function turnStatusFromResult(result: SDKResultMessage): ProviderRuntimeTurnStatus
{
  if (result.subtype === 'success')
  {
    const terminalReason = result.terminal_reason
    if (terminalReason !== undefined && INTERRUPTING_TERMINAL_REASONS.has(terminalReason))
    {
      return 'interrupted'
    }
    if (terminalReason !== undefined && FAILING_TERMINAL_REASONS.has(terminalReason))
    {
      return 'failed'
    }
    // no reason given, but the frame still reports a transport or API failure
    if (result.is_error || (result.api_error_status ?? null) !== null)
    {
      return 'failed'
    }
    return 'completed'
  }

  const errors = resultErrorsText(result)
  // an abort reason is authoritative over the free-text error scan below, which is what
  // misread a user-pressed Stop as a provider error and surfaced its raw diagnostic string
  const errorTerminalReason = result.terminal_reason
  if (errorTerminalReason !== undefined && INTERRUPTING_TERMINAL_REASONS.has(errorTerminalReason))
  {
    return 'interrupted'
  }
  if (isInterruptedResult(result))
  {
    return 'interrupted'
  }
  if (errors.includes('cancel'))
  {
    return 'cancelled'
  }
  return 'failed'
}

// SDKResultSuccess carries no `errors` array, so a turn that failed inside a success frame has no
// message to show; name the cause instead of falling back to a bare 'Claude turn failed.'
function successResultErrorMessage(result: SDKResultMessage): string | undefined
{
  if (result.subtype !== 'success')
  {
    return undefined
  }
  switch (result.terminal_reason)
  {
    case 'blocking_limit':
    case 'rapid_refill_breaker':
      // deliberately no reset estimate: the limit that killed the run this fix came from was a
      // seven-day overage window, and promising a short wait would have been wrong by days
      return 'Claude usage limit reached. The turn stopped before it finished; check your plan usage for when it resets.'
    case 'budget_exhausted':
      return 'The configured budget was exhausted. The turn stopped before it finished.'
    case 'prompt_too_long':
      return 'The prompt exceeded the model context window. The turn stopped before it finished.'
    default:
      break
  }
  const apiErrorStatus = result.api_error_status ?? null
  if (apiErrorStatus !== null)
  {
    return apiErrorStatus === 429
      ? 'Claude rate limited this request (HTTP 429). The turn stopped before it finished.'
      : `Claude returned HTTP ${apiErrorStatus}. The turn stopped before it finished.`
  }
  return result.terminal_reason === undefined
    ? undefined
    : `Claude ended the turn early (${result.terminal_reason}).`
}

// the CLI writes internal breadcrumbs such as `[ede_diagnostic] result_type=user last_content_type=…`
// into `errors`. They are machine telemetry, not prose, and putting one straight into the thread's
// error banner is how a user-pressed Stop came to read like a provider crash
const INTERNAL_DIAGNOSTIC_RE = /^\[[a-z0-9_]+\]/i

function presentableResultError(error: string | undefined): string | undefined
{
  const trimmed = error?.trim() ?? ''
  if (trimmed.length === 0 || INTERNAL_DIAGNOSTIC_RE.test(trimmed))
  {
    return undefined
  }
  return trimmed
}

// a Record rather than a switch so a new SDK union member fails the build here instead of
// silently degrading to a generic message
const ASSISTANT_ERROR_MESSAGES: Record<SDKAssistantMessageError, string> = {
  authentication_failed:
    'Claude authentication failed. Reconnect this provider instance, then retry the turn.',
  billing_error: 'Claude reported a billing problem on this account, so the turn stopped.',
  invalid_request: 'Claude rejected this request as invalid, so the turn stopped.',
  max_output_tokens: 'The response reached the model output-token limit and stopped early.',
  model_not_found: 'The selected Claude model is not available to this account.',
  oauth_org_not_allowed: "This Claude account's organization is not permitted to use this client.",
  overloaded: 'Claude is overloaded and could not take this request. Retry the turn.',
  // no reset estimate on purpose: the limit behind this fix was a seven-day overage window, and
  // any "try again shortly" copy would have been wrong by days
  rate_limit:
    'Claude usage limit reached. The turn stopped before it finished; check your plan usage for when it resets.',
  server_error: 'Claude returned a server error, so the turn stopped.',
  unknown: 'Claude ended this response with an unspecified error.',
}

function assistantErrorMessage(error: SDKAssistantMessageError): string
{
  // a newer CLI can send a member these types were not built against
  return ASSISTANT_ERROR_MESSAGES[error] ?? `Claude reported an error (${error}).`
}

function nativeProviderRefs(
  _context: ClaudeSessionContext,
  options?: {
    readonly providerItemId?: string | undefined
  },
): NonNullable<ProviderRuntimeEvent['providerRefs']>
{
  if (options?.providerItemId)
  {
    return {
      providerItemId: ProviderItemId.make(options.providerItemId),
    }
  }
  return {}
}

function toSessionError(
  threadId: ThreadId,
  cause: unknown,
): ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError | undefined
{
  const normalized = toMessage(cause, '').toLowerCase()
  if (normalized.includes('unknown session') || normalized.includes('not found'))
  {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
      cause,
    })
  }
  if (normalized.includes('closed'))
  {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
      cause,
    })
  }
  return undefined
}

function toRequestError(threadId: ThreadId, method: string, cause: unknown): ProviderAdapterError
{
  const sessionError = toSessionError(threadId, cause)
  if (sessionError)
  {
    return sessionError
  }
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: `${method} failed`,
    cause,
  })
}

export const makeClaudeAdapter = Effect.fn('makeClaudeAdapter')(function* (
  claudeSettings: ClaudeSettings,
  options?: ClaudeAdapterLiveOptions,
)
{
  const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make('claudeAgent')
  const createQuery = options?.createQuery
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const serverConfig = yield* ServerConfig
  const crypto = yield* Crypto.Crypto
  const claudeEnvironment = yield* makeClaudeEnvironment(
    claudeSettings,
    options?.environment,
    options?.sourceCwd,
  ).pipe(Effect.provideService(Path.Path, path))
  const claudeSdkExecutablePath = yield* resolveClaudeSdkExecutablePath(
    claudeSettings.binaryPath,
    claudeEnvironment,
  )
  const nativeEventLogger =
    options?.nativeEventLogger ??
    (options?.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
          stream: 'native',
        })
      : undefined)

  const sessions = new Map<ThreadId, ClaudeSessionContext>()
  const runtimeEventQueue = yield* Queue.unbounded<ProviderAdapterRuntimeEvent>()

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso)
  const randomUUIDv4 = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: 'crypto/randomUUIDv4',
          detail: 'Failed to generate Claude runtime identifier.',
          cause,
        }),
    ),
  )
  const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id))
  const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso })

  const offerRuntimeEvent = (
    context: ClaudeSessionContext,
    event: ProviderRuntimeEvent,
  ): Effect.Effect<void> =>
    Queue.offer(runtimeEventQueue, {
      binding: context.runtimeSessionBinding,
      event,
    }).pipe(Effect.asVoid)

  const logNativeSdkMessage = Effect.fn('logNativeSdkMessage')(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  )
  {
    if (!nativeEventLogger)
    {
      return
    }

    const observedAt = yield* nowIso
    const itemId = sdkNativeItemId(message)

    yield* nativeEventLogger.write(
      {
        observedAt,
        event: {
          id:
            'uuid' in message && typeof message.uuid === 'string'
              ? message.uuid
              : yield* randomUUIDv4,
          kind: 'notification',
          provider: PROVIDER,
          createdAt: observedAt,
          method: sdkNativeMethod(message),
          ...(typeof message.session_id === 'string'
            ? { providerThreadId: message.session_id }
            : {}),
          ...(context.turnState
            ? {
                turnId: asCanonicalTurnId(context.turnState.turnId),
              }
            : {}),
          ...(itemId ? { itemId: ProviderItemId.make(itemId) } : {}),
          payload: message,
        },
      },
      context.session.threadId,
    )
  })

  const snapshotThread = Effect.fn('snapshotThread')(function* (context: ClaudeSessionContext)
  {
    const threadId = context.session.threadId
    if (!threadId)
    {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: 'readThread',
        issue: 'Session thread id is not initialized yet.',
      })
    }
    return {
      threadId,
      turns: context.turns.map((turn) => ({
        id: turn.id,
        items: [...turn.items],
      })),
    }
  })

  const updateResumeCursor = Effect.fn('updateResumeCursor')(function* (
    context: ClaudeSessionContext,
  )
  {
    const threadId = context.session.threadId
    if (!threadId) return

    const resumeCursor = {
      threadId,
      ...(context.resumeSessionId ? { resume: context.resumeSessionId } : {}),
      ...(context.lastAssistantUuid ? { resumeSessionAt: context.lastAssistantUuid } : {}),
      turnCount: context.turns.length,
    }

    context.session = {
      ...context.session,
      resumeCursor,
      updatedAt: yield* nowIso,
    }
  })

  const ensureAssistantTextBlock = Effect.fn('ensureAssistantTextBlock')(function* (
    context: ClaudeSessionContext,
    blockIndex: number,
    options?: {
      readonly fallbackText?: string
      readonly streamClosed?: boolean
    },
  )
  {
    const turnState = context.turnState
    if (!turnState)
    {
      return undefined
    }

    const existing = turnState.assistantTextBlocks.get(blockIndex)
    if (existing && !existing.completionEmitted)
    {
      if (existing.fallbackText.length === 0 && options?.fallbackText)
      {
        existing.fallbackText = options.fallbackText
      }
      if (options?.streamClosed)
      {
        existing.streamClosed = true
      }
      return { blockIndex, block: existing }
    }

    const block: AssistantTextBlockState = {
      itemId: yield* randomUUIDv4,
      blockIndex,
      emittedTextDelta: false,
      fallbackText: options?.fallbackText ?? '',
      streamClosed: options?.streamClosed ?? false,
      completionEmitted: false,
    }
    turnState.assistantTextBlocks.set(blockIndex, block)
    turnState.assistantTextBlockOrder.push(block)
    return { blockIndex, block }
  })

  const createSyntheticAssistantTextBlock = Effect.fn('createSyntheticAssistantTextBlock')(
    function* (context: ClaudeSessionContext, fallbackText: string)
    {
      const turnState = context.turnState
      if (!turnState)
      {
        return undefined
      }

      const blockIndex = turnState.nextSyntheticAssistantBlockIndex
      turnState.nextSyntheticAssistantBlockIndex -= 1
      return yield* ensureAssistantTextBlock(context, blockIndex, {
        fallbackText,
        streamClosed: true,
      })
    },
  )

  const completeAssistantTextBlock = Effect.fn('completeAssistantTextBlock')(function* (
    context: ClaudeSessionContext,
    block: AssistantTextBlockState,
    options?: {
      readonly force?: boolean
      readonly rawMethod?: string
      readonly rawPayload?: unknown
    },
  )
  {
    const turnState = context.turnState
    if (!turnState || block.completionEmitted)
    {
      return
    }

    if (!options?.force && !block.streamClosed)
    {
      return
    }

    if (!block.emittedTextDelta && block.fallbackText.length > 0)
    {
      const deltaStamp = yield* makeEventStamp()
      yield* offerRuntimeEvent(context, {
        type: 'content.delta',
        eventId: deltaStamp.eventId,
        provider: PROVIDER,
        createdAt: deltaStamp.createdAt,
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        itemId: asRuntimeItemId(block.itemId),
        payload: {
          streamKind: 'assistant_text',
          delta: block.fallbackText,
        },
        providerRefs: nativeProviderRefs(context),
        ...(options?.rawMethod || options?.rawPayload
          ? {
              raw: {
                source: 'claude.sdk.message' as const,
                ...(options.rawMethod ? { method: options.rawMethod } : {}),
                payload: options?.rawPayload,
              },
            }
          : {}),
      })
    }

    block.completionEmitted = true
    if (turnState.assistantTextBlocks.get(block.blockIndex) === block)
    {
      turnState.assistantTextBlocks.delete(block.blockIndex)
    }

    const stamp = yield* makeEventStamp()
    yield* offerRuntimeEvent(context, {
      type: 'item.completed',
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      itemId: asRuntimeItemId(block.itemId),
      threadId: context.session.threadId,
      turnId: turnState.turnId,
      payload: {
        itemType: 'assistant_message',
        status: 'completed',
        title: 'Assistant message',
        ...(block.fallbackText.length > 0 ? { detail: block.fallbackText } : {}),
      },
      providerRefs: nativeProviderRefs(context),
      ...(options?.rawMethod || options?.rawPayload
        ? {
            raw: {
              source: 'claude.sdk.message' as const,
              ...(options.rawMethod ? { method: options.rawMethod } : {}),
              payload: options?.rawPayload,
            },
          }
        : {}),
    })
  })

  const backfillAssistantTextBlocksFromSnapshot = Effect.fn(
    'backfillAssistantTextBlocksFromSnapshot',
  )(function* (context: ClaudeSessionContext, message: SDKMessage)
  {
    const turnState = context.turnState
    if (!turnState)
    {
      return
    }

    const snapshotTextBlocks = extractAssistantTextBlocks(message)
    if (snapshotTextBlocks.length === 0)
    {
      return
    }

    const orderedBlocks = turnState.assistantTextBlockOrder.map((block) => ({
      blockIndex: block.blockIndex,
      block,
    }))

    for (const [position, text] of snapshotTextBlocks.entries())
    {
      const existingEntry = orderedBlocks[position]
      const entry =
        existingEntry ??
        (yield* createSyntheticAssistantTextBlock(context, text).pipe(
          Effect.map((created) =>
          {
            if (!created)
            {
              return undefined
            }
            orderedBlocks.push(created)
            return created
          }),
        ))
      if (!entry)
      {
        continue
      }

      if (entry.block.fallbackText.length === 0)
      {
        entry.block.fallbackText = text
      }

      if (entry.block.streamClosed && !entry.block.completionEmitted)
      {
        yield* completeAssistantTextBlock(context, entry.block, {
          rawMethod: 'claude/assistant',
          rawPayload: message,
        })
      }
    }
  })

  const ensureThreadId = Effect.fn('ensureThreadId')(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  )
  {
    if (typeof message.session_id !== 'string' || message.session_id.length === 0)
    {
      return
    }
    if (!hasDurableClaudeSessionId(message))
    {
      return
    }
    const nextThreadId = message.session_id
    const resumeAttempt = context.resumeAttempt
    if (resumeAttempt && !resumeAttempt.usable)
    {
      if (nextThreadId !== resumeAttempt.sessionId)
      {
        return yield* new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: context.session.threadId,
          detail: CLAUDE_RESUME_FAILURE_MESSAGE,
          cause: {
            reason: 'resume-session-id-mismatch',
            expectedSessionId: resumeAttempt.sessionId,
            receivedSessionId: nextThreadId,
          },
        })
      }
      if (message.type === 'result' && message.subtype !== 'success')
      {
        return yield* new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: context.session.threadId,
          detail: CLAUDE_RESUME_FAILURE_MESSAGE,
          cause: {
            reason: 'resume-result-failed',
            resultSubtype: message.subtype,
          },
        })
      }
      if (!isClaudeResumeUsableMessage(message))
      {
        return
      }
    }

    context.resumeSessionId = message.session_id
    yield* updateResumeCursor(context)

    if (context.lastThreadStartedId !== nextThreadId)
    {
      context.lastThreadStartedId = nextThreadId
      const stamp = yield* makeEventStamp()
      yield* offerRuntimeEvent(context, {
        type: 'thread.started',
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        payload: {
          providerThreadId: nextThreadId,
        },
        providerRefs: {},
        raw: {
          source: 'claude.sdk.message',
          method: 'claude/thread/started',
          payload: {
            session_id: message.session_id,
          },
        },
      })
    }
  })

  const emitRuntimeError = Effect.fn('emitRuntimeError')(function* (
    context: ClaudeSessionContext,
    message: string,
    cause?: unknown,
  )
  {
    if (cause !== undefined)
    {
      void cause
    }
    const turnState = context.turnState
    const stamp = yield* makeEventStamp()
    yield* offerRuntimeEvent(context, {
      type: 'runtime.error',
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(turnState ? { turnId: asCanonicalTurnId(turnState.turnId) } : {}),
      payload: {
        message,
        class: 'provider_error',
        ...(cause !== undefined ? { detail: cause } : {}),
      },
      providerRefs: nativeProviderRefs(context),
    })
  })

  const emitRuntimeWarning = Effect.fn('emitRuntimeWarning')(function* (
    context: ClaudeSessionContext,
    message: string,
    detail?: unknown,
  )
  {
    const turnState = context.turnState
    const stamp = yield* makeEventStamp()
    yield* offerRuntimeEvent(context, {
      type: 'runtime.warning',
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(turnState ? { turnId: asCanonicalTurnId(turnState.turnId) } : {}),
      payload: {
        message,
        ...(detail !== undefined ? { detail } : {}),
      },
      providerRefs: nativeProviderRefs(context),
    })
  })

  const emitThreadTokenUsage = Effect.fn('emitThreadTokenUsage')(function* (
    context: ClaudeSessionContext,
    usage: ThreadTokenUsageSnapshot | undefined,
    options?: {
      readonly rawMethod?: string
      readonly rawPayload?: unknown
    },
  )
  {
    if (!usage)
    {
      return
    }

    context.lastKnownTokenUsage = usage
    context.lastKnownTotalProcessedTokens =
      usage.totalProcessedTokens ?? context.lastKnownTotalProcessedTokens

    const turnState = context.turnState
    const stamp = yield* makeEventStamp()
    yield* offerRuntimeEvent(context, {
      type: 'thread.token-usage.updated',
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(turnState ? { turnId: turnState.turnId } : {}),
      payload: {
        usage,
      },
      providerRefs: nativeProviderRefs(context),
      ...(options?.rawMethod || options?.rawPayload
        ? {
            raw: {
              source: 'claude.sdk.message' as const,
              ...(options.rawMethod ? { method: options.rawMethod } : {}),
              payload: options.rawPayload,
            },
          }
        : {}),
    })
  })

  const emitProposedPlanCompleted = Effect.fn('emitProposedPlanCompleted')(function* (
    context: ClaudeSessionContext,
    input: {
      readonly planMarkdown: string
      readonly toolUseId?: string | undefined
      readonly rawSource: 'claude.sdk.message' | 'claude.sdk.permission'
      readonly rawMethod: string
      readonly rawPayload: unknown
    },
  )
  {
    const turnState = context.turnState
    const planMarkdown = input.planMarkdown.trim()
    if (!turnState || planMarkdown.length === 0)
    {
      return
    }

    const captureKey = exitPlanCaptureKey({
      toolUseId: input.toolUseId,
      planMarkdown,
    })
    if (turnState.capturedProposedPlanKeys.has(captureKey))
    {
      return
    }
    turnState.capturedProposedPlanKeys.add(captureKey)

    const stamp = yield* makeEventStamp()
    yield* offerRuntimeEvent(context, {
      type: 'turn.proposed.completed',
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      turnId: turnState.turnId,
      payload: {
        planMarkdown,
      },
      providerRefs: nativeProviderRefs(context, {
        providerItemId: input.toolUseId,
      }),
      raw: {
        source: input.rawSource,
        method: input.rawMethod,
        payload: input.rawPayload,
      },
    })
  })

  const emitClaudeTaskPlanUpdated = Effect.fn('emitClaudeTaskPlanUpdated')(function* (
    context: ClaudeSessionContext,
    input: {
      readonly toolUseId: string
      readonly rawMethod: string
      readonly rawPayload: unknown
    },
  )
  {
    const plan = planStepsFromClaudeTasks(context.claudeTasks)
    if (plan.length === 0)
    {
      return
    }

    const stamp = yield* makeEventStamp()
    yield* offerRuntimeEvent(context, {
      type: 'turn.plan.updated',
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      payload: {
        explanation: 'Claude Tasks',
        plan,
      },
      providerRefs: nativeProviderRefs(context, {
        providerItemId: input.toolUseId,
      }),
      raw: {
        source: 'claude.sdk.message',
        method: input.rawMethod,
        payload: input.rawPayload,
      },
    })
  })

  const completeTurn = Effect.fn('completeTurn')(function* (
    context: ClaudeSessionContext,
    status: ProviderRuntimeTurnStatus,
    errorMessage?: string,
    result?: SDKResultMessage,
    options?: { readonly suppressLifecycle?: boolean },
  )
  {
    const resultContextWindow = maxClaudeContextWindowFromModelUsage(result?.modelUsage)
    if (resultContextWindow !== undefined)
    {
      context.lastKnownContextWindow = resultContextWindow
    }

    const maxTokens = resultContextWindow ?? context.lastKnownContextWindow
    const accumulatedTotalProcessedTokens = claudeTotalProcessedTokens(result?.usage)
    if (accumulatedTotalProcessedTokens !== undefined)
    {
      context.lastKnownTotalProcessedTokens = accumulatedTotalProcessedTokens
    }

    // avoid getContextUsage because its token-count fallback can make extra model requests
    const resultUsageRecord =
      result?.usage && typeof result.usage === 'object' && !Array.isArray(result.usage)
        ? (result.usage as Record<string, unknown>)
        : undefined
    const hasResultUsageIteration =
      resultUsageRecord !== undefined && lastClaudeUsageIteration(resultUsageRecord) !== undefined
    const resultHasActiveUsage =
      resultUsageRecord !== undefined &&
      (hasResultUsageIteration ||
        claudeUsageInputTokens(resultUsageRecord) + claudeUsageOutputTokens(resultUsageRecord) > 0)
    const resultTotalOnly =
      resultUsageRecord !== undefined &&
      !resultHasActiveUsage &&
      claudeTotalProcessedTokens(resultUsageRecord) !== undefined
    const resultIterationSnapshot = resultUsageRecord
      ? normalizeClaudeActiveTokenUsage(
          resultUsageRecord,
          maxTokens,
          accumulatedTotalProcessedTokens ?? context.lastKnownTotalProcessedTokens,
        )
      : undefined
    const latestAssistantSnapshot = normalizeClaudeActiveTokenUsage(
      context.turnState?.latestAssistantUsage,
      maxTokens,
      accumulatedTotalProcessedTokens ?? context.lastKnownTotalProcessedTokens,
    )
    const lastGoodUsage = context.lastKnownTokenUsage
    const usageSnapshot: ThreadTokenUsageSnapshot | undefined =
      latestAssistantSnapshot ??
      (context.turnState?.compactedSinceLatestAssistantUsage
        ? undefined
        : resultTotalOnly && lastGoodUsage
          ? {
              ...lastGoodUsage,
              ...(typeof maxTokens === 'number' && Number.isFinite(maxTokens) && maxTokens > 0
                ? { maxTokens }
                : {}),
              ...(typeof accumulatedTotalProcessedTokens === 'number' &&
              Number.isFinite(accumulatedTotalProcessedTokens) &&
              accumulatedTotalProcessedTokens > lastGoodUsage.usedTokens
                ? {
                    totalProcessedTokens: accumulatedTotalProcessedTokens,
                  }
                : {}),
            }
          : resultIterationSnapshot) ??
      (lastGoodUsage
        ? {
            ...lastGoodUsage,
            ...(typeof maxTokens === 'number' && Number.isFinite(maxTokens) && maxTokens > 0
              ? { maxTokens }
              : {}),
            ...(typeof accumulatedTotalProcessedTokens === 'number' &&
            Number.isFinite(accumulatedTotalProcessedTokens) &&
            accumulatedTotalProcessedTokens > lastGoodUsage.usedTokens
              ? {
                  totalProcessedTokens: accumulatedTotalProcessedTokens,
                }
              : {}),
          }
        : undefined)

    const turnState = context.turnState
    if (!turnState || options?.suppressLifecycle === true)
    {
      yield* emitThreadTokenUsage(context, usageSnapshot, {
        rawMethod: 'claude/result',
        rawPayload: result ?? { status },
      })

      // resume handshakes and late results do not represent the active local turn
      yield* Effect.logInfo('claude.turn.result-without-matching-turn', {
        threadId: context.session.threadId,
        status,
        numTurns: result?.num_turns,
        hasUsage: result?.usage !== undefined,
      })
      return
    }

    for (const [index, tool] of context.inFlightTools.entries())
    {
      const toolStamp = yield* makeEventStamp()
      yield* offerRuntimeEvent(context, {
        type: 'item.completed',
        eventId: toolStamp.eventId,
        provider: PROVIDER,
        createdAt: toolStamp.createdAt,
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        itemId: asRuntimeItemId(tool.itemId),
        payload: {
          itemType: tool.itemType,
          status: status === 'completed' ? 'completed' : 'failed',
          title: tool.title,
          ...(tool.detail ? { detail: tool.detail } : {}),
          data: {
            toolName: tool.toolName,
            input: tool.input,
          },
        },
        providerRefs: nativeProviderRefs(context, {
          providerItemId: tool.itemId,
        }),
        raw: {
          source: 'claude.sdk.message',
          method: 'claude/result',
          payload: result ?? { status },
        },
      })
      context.inFlightTools.delete(index)
    }
    // clear any remaining stale entries (e.g. from interrupted content blocks)
    context.inFlightTools.clear()

    for (const block of turnState.assistantTextBlockOrder)
    {
      yield* completeAssistantTextBlock(context, block, {
        force: true,
        rawMethod: 'claude/result',
        rawPayload: result ?? { status },
      })
    }

    context.turns.push({
      id: turnState.turnId,
      items: [...turnState.items],
    })

    yield* emitThreadTokenUsage(context, usageSnapshot, {
      rawMethod: 'claude/result',
      rawPayload: result ?? { status },
    })

    const stamp = yield* makeEventStamp()
    yield* offerRuntimeEvent(context, {
      type: 'turn.completed',
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      turnId: turnState.turnId,
      payload: {
        state: status,
        ...(result?.stop_reason !== undefined ? { stopReason: result.stop_reason } : {}),
        ...(result?.usage ? { usage: result.usage } : {}),
        ...(result?.modelUsage ? { modelUsage: result.modelUsage } : {}),
        ...(typeof result?.total_cost_usd === 'number'
          ? { totalCostUsd: result.total_cost_usd }
          : {}),
        ...(errorMessage ? { errorMessage } : {}),
      },
      providerRefs: nativeProviderRefs(context),
    })

    const updatedAt = yield* nowIso
    context.turnState = undefined
    context.session = {
      ...context.session,
      status: 'ready',
      activeTurnId: undefined,
      updatedAt,
      ...(status === 'failed' && errorMessage ? { lastError: errorMessage } : {}),
    }
    yield* updateResumeCursor(context)
  })

  const handleStreamEvent = Effect.fn('handleStreamEvent')(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  )
  {
    if (message.type !== 'stream_event')
    {
      return
    }

    const { event } = message
    const isNestedFrame =
      message.parent_tool_use_id !== null && message.parent_tool_use_id !== undefined

    // nested subagent frames must never touch root tool tracking: the shared
    // index-keyed in-flight map would let a subagent block at the same index
    // replace or delete the root entry (breaking Agent -> task correlation)
    // and leak subagent tool calls as root work-log items; subagent activity
    // reaches the timeline through task events instead
    if (
      isNestedFrame &&
      (event.type === 'content_block_start' ||
        event.type === 'content_block_stop' ||
        (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta'))
    )
    {
      return
    }

    if (event.type === 'message_delta')
    {
      if (isNestedFrame)
      {
        return
      }

      const snapshot = normalizeClaudeActiveTokenUsage(
        event.usage,
        context.lastKnownContextWindow,
        context.lastKnownTotalProcessedTokens,
      )
      yield* emitThreadTokenUsage(context, snapshot, {
        rawMethod: 'claude/stream_event/message_delta',
        rawPayload: message,
      })
      return
    }

    if (event.type === 'content_block_delta')
    {
      if (
        isNestedFrame &&
        (event.delta.type === 'text_delta' || event.delta.type === 'thinking_delta')
      )
      {
        return
      }

      if (
        (event.delta.type === 'text_delta' || event.delta.type === 'thinking_delta') &&
        context.turnState
      )
      {
        const deltaText =
          event.delta.type === 'text_delta'
            ? event.delta.text
            : typeof event.delta.thinking === 'string'
              ? event.delta.thinking
              : ''
        if (deltaText.length === 0)
        {
          return
        }
        const streamKind = streamKindFromDeltaType(event.delta.type)
        const assistantBlockEntry =
          event.delta.type === 'text_delta'
            ? yield* ensureAssistantTextBlock(context, event.index)
            : context.turnState.assistantTextBlocks.get(event.index)
              ? {
                  blockIndex: event.index,
                  block: context.turnState.assistantTextBlocks.get(
                    event.index,
                  ) as AssistantTextBlockState,
                }
              : undefined
        if (assistantBlockEntry?.block && event.delta.type === 'text_delta')
        {
          assistantBlockEntry.block.emittedTextDelta = true
        }
        const stamp = yield* makeEventStamp()
        yield* offerRuntimeEvent(context, {
          type: 'content.delta',
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          turnId: context.turnState.turnId,
          ...(assistantBlockEntry?.block
            ? {
                itemId: asRuntimeItemId(assistantBlockEntry.block.itemId),
              }
            : {}),
          payload: {
            streamKind,
            delta: deltaText,
          },
          providerRefs: nativeProviderRefs(context),
          raw: {
            source: 'claude.sdk.message',
            method: 'claude/stream_event/content_block_delta',
            payload: message,
          },
        })
        return
      }

      if (event.delta.type === 'input_json_delta')
      {
        const tool = context.inFlightTools.get(event.index)
        if (!tool || typeof event.delta.partial_json !== 'string')
        {
          return
        }

        const partialInputJson = tool.partialInputJson + event.delta.partial_json
        const parsedInput = tryParseJsonRecord(partialInputJson)
        const detail = parsedInput ? summarizeToolRequest(tool.toolName, parsedInput) : tool.detail
        const nativeTask = parsedInput
          ? makeClaudeNativeTaskTool(tool.toolName, tool.itemId, parsedInput, tool.nativeTask)
          : tool.nativeTask
        let nextTool: ToolInFlight = {
          ...tool,
          partialInputJson,
          ...(parsedInput ? { input: parsedInput } : {}),
          ...(detail ? { detail } : {}),
          ...(nativeTask ? { nativeTask } : {}),
        }
        if (nativeTask)
        {
          context.nativeTaskTools.set(nativeTask.toolUseId, nativeTask)
        }

        const nextFingerprint =
          parsedInput && Object.keys(parsedInput).length > 0
            ? toolInputFingerprint(parsedInput)
            : undefined
        context.inFlightTools.set(event.index, nextTool)

        if (
          !parsedInput ||
          !nextFingerprint ||
          tool.lastEmittedInputFingerprint === nextFingerprint
        )
        {
          return
        }

        nextTool = {
          ...nextTool,
          lastEmittedInputFingerprint: nextFingerprint,
        }
        context.inFlightTools.set(event.index, nextTool)

        const stamp = yield* makeEventStamp()
        yield* offerRuntimeEvent(context, {
          type: 'item.updated',
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState
            ? {
                turnId: asCanonicalTurnId(context.turnState.turnId),
              }
            : {}),
          itemId: asRuntimeItemId(nextTool.itemId),
          payload: {
            itemType: nextTool.itemType,
            status: 'inProgress',
            title: nextTool.title,
            ...(nextTool.detail ? { detail: nextTool.detail } : {}),
            data: {
              toolName: nextTool.toolName,
              input: nextTool.input,
            },
          },
          providerRefs: nativeProviderRefs(context, {
            providerItemId: nextTool.itemId,
          }),
          raw: {
            source: 'claude.sdk.message',
            method: 'claude/stream_event/content_block_delta/input_json_delta',
            payload: message,
          },
        })

        // emit plan update when TodoWrite input is parsed
        if (parsedInput && isTodoTool(nextTool.toolName))
        {
          const planSteps = extractPlanStepsFromTodoInput(parsedInput)
          if (planSteps && planSteps.length > 0)
          {
            const planStamp = yield* makeEventStamp()
            yield* offerRuntimeEvent(context, {
              type: 'turn.plan.updated',
              eventId: planStamp.eventId,
              provider: PROVIDER,
              createdAt: planStamp.createdAt,
              threadId: context.session.threadId,
              ...(context.turnState
                ? {
                    turnId: asCanonicalTurnId(context.turnState.turnId),
                  }
                : {}),
              payload: {
                plan: planSteps,
              },
              providerRefs: nativeProviderRefs(context),
            })
          }
        }
      }
      return
    }

    if (event.type === 'content_block_start')
    {
      const { index, content_block: block } = event
      if (block.type === 'text')
      {
        if (isNestedFrame)
        {
          return
        }
        yield* ensureAssistantTextBlock(context, index, {
          fallbackText: extractContentBlockText(block),
        })
        return
      }
      if (
        block.type !== 'tool_use' &&
        block.type !== 'server_tool_use' &&
        block.type !== 'mcp_tool_use'
      )
      {
        return
      }

      const toolName = block.name
      const itemType = classifyToolItemType(toolName)
      const toolInput =
        typeof block.input === 'object' && block.input !== null
          ? (block.input as Record<string, unknown>)
          : {}
      const itemId = block.id
      const detail = summarizeToolRequest(toolName, toolInput)
      const inputFingerprint =
        Object.keys(toolInput).length > 0 ? toolInputFingerprint(toolInput) : undefined
      const nativeTask = makeClaudeNativeTaskTool(toolName, itemId, toolInput)

      const tool: ToolInFlight = {
        itemId,
        itemType,
        toolName,
        title: titleForTool(itemType, toolName),
        detail,
        input: toolInput,
        partialInputJson: '',
        ...(inputFingerprint ? { lastEmittedInputFingerprint: inputFingerprint } : {}),
        ...(nativeTask ? { nativeTask } : {}),
      }
      context.inFlightTools.set(index, tool)
      if (nativeTask)
      {
        context.nativeTaskTools.set(nativeTask.toolUseId, nativeTask)
      }

      const stamp = yield* makeEventStamp()
      yield* offerRuntimeEvent(context, {
        type: 'item.started',
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        itemId: asRuntimeItemId(tool.itemId),
        payload: {
          itemType: tool.itemType,
          status: 'inProgress',
          title: tool.title,
          ...(tool.detail ? { detail: tool.detail } : {}),
          data: {
            toolName: tool.toolName,
            input: toolInput,
          },
        },
        providerRefs: nativeProviderRefs(context, {
          providerItemId: tool.itemId,
        }),
        raw: {
          source: 'claude.sdk.message',
          method: 'claude/stream_event/content_block_start',
          payload: message,
        },
      })
      return
    }

    if (event.type === 'content_block_stop')
    {
      if (isNestedFrame)
      {
        return
      }
      const { index } = event
      const assistantBlock = context.turnState?.assistantTextBlocks.get(index)
      if (assistantBlock)
      {
        assistantBlock.streamClosed = true
        yield* completeAssistantTextBlock(context, assistantBlock, {
          rawMethod: 'claude/stream_event/content_block_stop',
          rawPayload: message,
        })
        return
      }
      const tool = context.inFlightTools.get(index)
      if (!tool)
      {
        return
      }
    }
  })

  // terminal task event enriched with whatever the correlated Agent tool
  // result reported (agent id, resolved model, authoritative usage)
  const emitClaudeNativeTaskCompleted = Effect.fn('emitClaudeNativeTaskCompleted')(function* (
    context: ClaudeSessionContext,
    state: ClaudeNativeTaskState,
    input: {
      readonly rawMethod: string
      readonly rawPayload: unknown
    },
  )
  {
    if (!state.completion)
    {
      return
    }

    const taskTool = state.toolUseId ? context.nativeTaskTools.get(state.toolUseId) : undefined
    const agentCompletion = taskTool?.agentCompletion
    const model = nativeTaskModel(context, state)
    const stamp = yield* makeEventStamp()
    yield* offerRuntimeEvent(context, {
      type: 'task.completed',
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      payload: {
        taskId: RuntimeTaskId.make(state.taskId),
        status: state.completion.status,
        ...(state.completion.summary ? { summary: state.completion.summary } : {}),
        ...(state.completion.usage ? { usage: state.completion.usage } : {}),
        ...((agentCompletion?.tokenUsage ?? state.completion.tokenUsage)
          ? {
              tokenUsage: agentCompletion?.tokenUsage ?? state.completion.tokenUsage,
            }
          : {}),
        ...(state.toolUseId ? { toolUseId: state.toolUseId } : {}),
        ...(agentCompletion?.agentId ? { agentId: agentCompletion.agentId } : {}),
        ...((state.subagentType ?? taskTool?.subagentType)
          ? { subagentType: state.subagentType ?? taskTool?.subagentType }
          : {}),
        ...(model ? { model } : {}),
        ...(agentCompletion
          ? {
              totalToolUseCount: agentCompletion.totalToolUseCount,
              totalDurationMs: agentCompletion.totalDurationMs,
            }
          : {}),
      },
      providerRefs: nativeProviderRefs(context, {
        providerItemId: state.toolUseId,
      }),
      raw: {
        source: 'claude.sdk.message',
        method: input.rawMethod,
        payload: input.rawPayload,
      },
    })
  })

  const handleUserMessage = Effect.fn('handleUserMessage')(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  )
  {
    if (message.type !== 'user')
    {
      return
    }

    if (
      context.turnState &&
      (message.parent_tool_use_id === null || message.parent_tool_use_id === undefined)
    )
    {
      context.turnState.items.push(message.message)
    }

    // nested subagent tool results must not resolve or delete root in-flight
    // tool entries; the root Agent result itself arrives with a null parent
    if (message.parent_tool_use_id !== null && message.parent_tool_use_id !== undefined)
    {
      return
    }

    for (const toolResult of toolResultBlocksFromUserMessage(message))
    {
      const toolEntry = Array.from(context.inFlightTools.entries()).find(
        ([, tool]) => tool.itemId === toolResult.toolUseId,
      )
      if (!toolEntry)
      {
        continue
      }

      const [index, tool] = toolEntry
      const itemStatus = toolResult.isError ? 'failed' : 'completed'
      const toolUseResult = readClaudeToolUseResult(message)
      const toolData = {
        toolName: tool.toolName,
        input: tool.input,
        result: toolResult.block,
      }

      const updatedStamp = yield* makeEventStamp()
      yield* offerRuntimeEvent(context, {
        type: 'item.updated',
        eventId: updatedStamp.eventId,
        provider: PROVIDER,
        createdAt: updatedStamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        itemId: asRuntimeItemId(tool.itemId),
        payload: {
          itemType: tool.itemType,
          status: toolResult.isError ? 'failed' : 'inProgress',
          title: tool.title,
          ...(tool.detail ? { detail: tool.detail } : {}),
          data: toolData,
        },
        providerRefs: nativeProviderRefs(context, {
          providerItemId: tool.itemId,
        }),
        raw: {
          source: 'claude.sdk.message',
          method: 'claude/user',
          payload: message,
        },
      })

      const streamKind = toolResultStreamKind(tool.itemType)
      if (streamKind && toolResult.text.length > 0 && context.turnState)
      {
        const deltaStamp = yield* makeEventStamp()
        yield* offerRuntimeEvent(context, {
          type: 'content.delta',
          eventId: deltaStamp.eventId,
          provider: PROVIDER,
          createdAt: deltaStamp.createdAt,
          threadId: context.session.threadId,
          turnId: context.turnState.turnId,
          itemId: asRuntimeItemId(tool.itemId),
          payload: {
            streamKind,
            delta: toolResult.text,
          },
          providerRefs: nativeProviderRefs(context, {
            providerItemId: tool.itemId,
          }),
          raw: {
            source: 'claude.sdk.message',
            method: 'claude/user',
            payload: message,
          },
        })
      }

      const completedStamp = yield* makeEventStamp()
      yield* offerRuntimeEvent(context, {
        type: 'item.completed',
        eventId: completedStamp.eventId,
        provider: PROVIDER,
        createdAt: completedStamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        itemId: asRuntimeItemId(tool.itemId),
        payload: {
          itemType: tool.itemType,
          status: itemStatus,
          title: tool.title,
          ...(tool.detail ? { detail: tool.detail } : {}),
          data: toolData,
        },
        providerRefs: nativeProviderRefs(context, {
          providerItemId: tool.itemId,
        }),
        raw: {
          source: 'claude.sdk.message',
          method: 'claude/user',
          payload: message,
        },
      })

      if (
        !toolResult.isError &&
        applyClaudeTaskToolResult(context.claudeTasks, tool, toolUseResult)
      )
      {
        yield* emitClaudeTaskPlanUpdated(context, {
          toolUseId: tool.itemId,
          rawMethod: 'claude/user',
          rawPayload: message,
        })
      }

      // an Agent tool result may land before or after its task_notification;
      // emit the completion here only when the task state already closed
      if (!toolResult.isError && tool.nativeTask?.toolName !== 'Workflow')
      {
        const agentOutput = readCompletedClaudeAgentOutput(toolUseResult)
        if (agentOutput)
        {
          const nativeTask =
            tool.nativeTask ?? makeClaudeNativeTaskTool(tool.toolName, tool.itemId, tool.input)
          if (nativeTask)
          {
            nativeTask.agentCompletion = makeClaudeAgentCompletion(agentOutput)
            context.nativeTaskTools.set(nativeTask.toolUseId, nativeTask)
            const taskState = Array.from(context.nativeTasks.values()).find(
              (state) => state.toolUseId === nativeTask.toolUseId,
            )
            if (taskState?.completion)
            {
              yield* emitClaudeNativeTaskCompleted(context, taskState, {
                rawMethod: 'claude/user/agent-result',
                rawPayload: message,
              })
            }
          }
        }
      }

      context.inFlightTools.delete(index)
    }
  })

  const handleAssistantMessage = Effect.fn('handleAssistantMessage')(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  )
  {
    if (message.type !== 'assistant')
    {
      return
    }

    if (message.parent_tool_use_id !== null && message.parent_tool_use_id !== undefined)
    {
      const snapshotModel = readString(message.message.model)
      if (snapshotModel)
      {
        const nativeTask = Array.from(context.nativeTasks.values()).find(
          (state) => state.toolUseId === message.parent_tool_use_id,
        )
        if (nativeTask)
        {
          nativeTask.authoritativeModel = snapshotModel
        }
        else
        {
          rememberPendingNativeTaskModel(
            context.pendingNativeTaskModels,
            message.parent_tool_use_id,
            snapshotModel,
          )
        }
      }
      context.lastAssistantUuid = message.uuid
      yield* updateResumeCursor(context)
      return
    }

    // the SDK reports why an assistant frame failed, and nothing read it. surfacing it here shows
    // the cause at the moment it happens instead of waiting for the terminal frame -- which, for a
    // usage limit, used to claim the turn had completed cleanly. this only holds because
    // turnStatusFromResult now marks that frame failed: a runtime.error raised here is wiped
    // ~0.5 s later by any turn.completed that is not itself 'failed', since
    // ProviderRuntimeIngestion nulls lastError whenever the session goes ready
    if (message.error !== undefined)
    {
      yield* emitRuntimeError(context, assistantErrorMessage(message.error), message.error)
    }

    // auto-start a synthetic turn for assistant messages that arrive without
    // an active turn (e.g., background agent/subagent responses between user prompts).
    if (!context.turnState)
    {
      const turnId = TurnId.make(yield* randomUUIDv4)
      const startedAt = yield* nowIso
      context.turnState = {
        turnId,
        startedAt,
        synthetic: true,
        items: [],
        assistantTextBlocks: new Map(),
        assistantTextBlockOrder: [],
        capturedProposedPlanKeys: new Set(),
        latestAssistantUsage: undefined,
        compactedSinceLatestAssistantUsage: false,
        nextSyntheticAssistantBlockIndex: -1,
      }
      context.session = {
        ...context.session,
        status: 'running',
        activeTurnId: turnId,
        updatedAt: startedAt,
      }
      const turnStartedStamp = yield* makeEventStamp()
      yield* offerRuntimeEvent(context, {
        type: 'turn.started',
        eventId: turnStartedStamp.eventId,
        provider: PROVIDER,
        createdAt: turnStartedStamp.createdAt,
        threadId: context.session.threadId,
        turnId,
        payload: {},
        providerRefs: {
          ...nativeProviderRefs(context),
          providerTurnId: turnId,
        },
        raw: {
          source: 'claude.sdk.message',
          method: 'claude/synthetic-turn-start',
          payload: {},
        },
      })
    }

    const content = message.message?.content
    if (Array.isArray(content))
    {
      for (const block of content)
      {
        if (!block || typeof block !== 'object')
        {
          continue
        }
        const toolUse = block as {
          type?: unknown
          id?: unknown
          name?: unknown
          input?: unknown
        }
        if (toolUse.type !== 'tool_use' || toolUse.name !== 'ExitPlanMode')
        {
          continue
        }
        const planMarkdown = extractExitPlanModePlan(toolUse.input)
        if (!planMarkdown)
        {
          continue
        }
        yield* emitProposedPlanCompleted(context, {
          planMarkdown,
          toolUseId: typeof toolUse.id === 'string' ? toolUse.id : undefined,
          rawSource: 'claude.sdk.message',
          rawMethod: 'claude/assistant',
          rawPayload: message,
        })
      }
    }

    if (context.turnState)
    {
      context.turnState.items.push(message.message)
      if (
        normalizeClaudeActiveTokenUsage(
          message.message.usage,
          context.lastKnownContextWindow,
          context.lastKnownTotalProcessedTokens,
        )
      )
      {
        context.turnState.latestAssistantUsage = message.message.usage
        context.turnState.compactedSinceLatestAssistantUsage = false
      }
      yield* backfillAssistantTextBlocksFromSnapshot(context, message)
    }

    context.lastAssistantUuid = message.uuid
    yield* updateResumeCursor(context)
  })

  const handleResultMessage = Effect.fn('handleResultMessage')(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  )
  {
    if (message.type !== 'result')
    {
      return
    }

    // a terminal refusal already raised its own error row, and the frame it precedes looks like
    // a clean success. consume the flag here so the classification stays in one place
    const refusal = context.terminalRefusal
    context.terminalRefusal = undefined

    const status = refusal === undefined ? turnStatusFromResult(message) : 'failed'
    const rawError = message.subtype === 'success' ? undefined : message.errors[0]
    const errorMessage =
      (message.subtype === 'success'
        ? successResultErrorMessage(message)
        : presentableResultError(rawError)) ?? refusal

    const resumeAttempt = context.resumeAttempt
    const isResumeHandshake =
      resumeAttempt?.handshakePending === true &&
      message.subtype === 'success' &&
      message.num_turns === 0 &&
      message.session_id === resumeAttempt.sessionId
    if (isResumeHandshake)
    {
      resumeAttempt.handshakePending = false
    }

    if (status === 'failed' && refusal === undefined)
    {
      // a suppressed internal diagnostic still travels, as structured detail rather than as prose
      yield* emitRuntimeError(
        context,
        errorMessage ?? 'Claude turn failed.',
        errorMessage === undefined ? rawError : undefined,
      )
    }

    yield* completeTurn(
      context,
      status,
      errorMessage,
      message,
      isResumeHandshake ? { suppressLifecycle: true } : undefined,
    )
  })

  const handleSystemMessage = Effect.fn('handleSystemMessage')(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  )
  {
    if (message.type !== 'system')
    {
      return
    }

    const wireSubtype = message.subtype as string
    if (wireSubtype === 'vcs_state_changed' || wireSubtype === 'code_change_published')
    {
      // informational git notices duplicate the underlying tool calls in the work log
      return
    }

    const stamp = yield* makeEventStamp()
    const base = {
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      providerRefs: nativeProviderRefs(context),
      raw: {
        source: 'claude.sdk.message' as const,
        method: sdkNativeMethod(message),
        messageType: `${message.type}:${message.subtype}`,
        payload: message,
      },
    }

    switch (message.subtype)
    {
      case 'init':
        yield* offerRuntimeEvent(context, {
          ...base,
          type: 'session.configured',
          payload: {
            config: message as Record<string, unknown>,
          },
        })
        return
      case 'status':
        // a compaction used to report itself as 'waiting', indistinguishable from any other
        // pause, so two multi-minute freezes showed nothing at all. the typed state lets the
        // mapper open a row for the wait instead of guessing from the reason string
        yield* offerRuntimeEvent(context, {
          ...base,
          type: 'session.state.changed',
          payload: {
            state: message.status === 'compacting' ? 'compacting' : 'running',
            reason: `status:${message.status ?? 'active'}`,
            detail: message,
          },
        })
        return
      case 'compact_boundary':
      {
        if (context.turnState)
        {
          context.turnState.latestAssistantUsage = undefined
          context.turnState.compactedSinceLatestAssistantUsage = true
        }
        const rawCompactBoundary = message as unknown as Record<string, unknown>
        yield* emitThreadTokenUsage(
          context,
          compactBoundaryTokenUsageSnapshot(
            rawCompactBoundary,
            context.lastKnownContextWindow,
            context.lastKnownTotalProcessedTokens,
          ),
          {
            rawMethod: 'claude/system/compact_boundary',
            rawPayload: message,
          },
        )
        const compaction = compactBoundaryMetadata(rawCompactBoundary)
        yield* offerRuntimeEvent(context, {
          ...base,
          type: 'thread.state.changed',
          payload: {
            state: 'compacted',
            // the raw `detail` blob is deliberately dropped here: the numbers worth showing
            // are now typed, & the blob carries preserved-message uuid arrays that have no
            // business growing an activity row
            ...(compaction !== undefined ? { compaction } : {}),
          },
        })
        // anchor the durable cursor on the boundary itself. between the boundary and the next
        // assistant message the persisted cursor otherwise names a message the compaction just
        // summarized away
        context.lastAssistantUuid = message.uuid
        yield* updateResumeCursor(context)
        return
      }
      case 'hook_started':
        yield* offerRuntimeEvent(context, {
          ...base,
          type: 'hook.started',
          payload: {
            hookId: message.hook_id,
            hookName: message.hook_name,
            hookEvent: message.hook_event,
          },
        })
        return
      case 'hook_progress':
        yield* offerRuntimeEvent(context, {
          ...base,
          type: 'hook.progress',
          payload: {
            hookId: message.hook_id,
            output: message.output,
            stdout: message.stdout,
            stderr: message.stderr,
          },
        })
        return
      case 'hook_response':
        yield* offerRuntimeEvent(context, {
          ...base,
          type: 'hook.completed',
          payload: {
            hookId: message.hook_id,
            outcome: message.outcome,
            output: message.output,
            stdout: message.stdout,
            stderr: message.stderr,
            ...(typeof message.exit_code === 'number' ? { exitCode: message.exit_code } : {}),
          },
        })
        return
      case 'task_started':
      {
        const bufferedModel = message.tool_use_id
          ? context.pendingNativeTaskModels.get(message.tool_use_id)
          : undefined
        if (message.tool_use_id)
        {
          context.pendingNativeTaskModels.delete(message.tool_use_id)
        }
        const state = updateClaudeNativeTaskState(context, {
          taskId: message.task_id,
          ...(message.tool_use_id ? { toolUseId: message.tool_use_id } : {}),
          ...(message.subagent_type ? { subagentType: message.subagent_type } : {}),
          ...(message.task_type ? { taskType: message.task_type } : {}),
          ...(message.workflow_name ? { workflowName: message.workflow_name } : {}),
        })
        if (bufferedModel)
        {
          state.authoritativeModel = bufferedModel
        }
        const model = nativeTaskModel(context, state)
        yield* offerRuntimeEvent(context, {
          ...base,
          type: 'task.started',
          payload: {
            taskId: RuntimeTaskId.make(message.task_id),
            description: message.description,
            ...(state.taskType ? { taskType: state.taskType } : {}),
            ...(state.workflowName ? { workflowName: state.workflowName } : {}),
            ...(state.toolUseId ? { toolUseId: state.toolUseId } : {}),
            ...(state.subagentType ? { subagentType: state.subagentType } : {}),
            ...(model ? { model } : {}),
          },
        })
        return
      }
      case 'task_progress':
      {
        const state = updateClaudeNativeTaskState(context, {
          taskId: message.task_id,
          ...(message.tool_use_id ? { toolUseId: message.tool_use_id } : {}),
          ...(message.subagent_type ? { subagentType: message.subagent_type } : {}),
        })
        const model = nativeTaskModel(context, state)
        const tokenUsage = normalizeClaudeTaskUsage(message.usage)
        yield* emitThreadTokenUsage(
          context,
          normalizeClaudeTaskProgressTokenUsage(message.usage, context),
          {
            rawMethod: 'claude/system/task_progress',
            rawPayload: message,
          },
        )
        yield* offerRuntimeEvent(context, {
          ...base,
          type: 'task.progress',
          payload: {
            taskId: RuntimeTaskId.make(message.task_id),
            description: message.description,
            ...(message.summary ? { summary: message.summary } : {}),
            ...(message.usage ? { usage: message.usage } : {}),
            ...(tokenUsage ? { tokenUsage } : {}),
            ...(message.last_tool_name ? { lastToolName: message.last_tool_name } : {}),
            ...(state.toolUseId ? { toolUseId: state.toolUseId } : {}),
            ...(state.subagentType ? { subagentType: state.subagentType } : {}),
            ...(model ? { model } : {}),
          },
        })
        return
      }
      // task state patch (status/backgrounded/end_time). No runtime mapping
      // yet — the terminal task_notification reports the outcome — but it
      // must not surface as an unknown-subtype warning row.
      case 'task_updated':
        return
      case 'task_notification':
      {
        const state = updateClaudeNativeTaskState(context, {
          taskId: message.task_id,
          ...(message.tool_use_id ? { toolUseId: message.tool_use_id } : {}),
        })
        const tokenUsage = normalizeClaudeTaskUsage(message.usage)
        state.completion = {
          status: message.status,
          ...(message.summary ? { summary: message.summary } : {}),
          ...(message.usage ? { usage: message.usage } : {}),
          ...(tokenUsage ? { tokenUsage } : {}),
        }
        yield* emitThreadTokenUsage(
          context,
          normalizeClaudeTaskProgressTokenUsage(message.usage, context),
          {
            rawMethod: 'claude/system/task_notification',
            rawPayload: message,
          },
        )
        yield* emitClaudeNativeTaskCompleted(context, state, {
          rawMethod: 'claude/system/task_notification',
          rawPayload: message,
        })
        return
      }
      case 'files_persisted':
        yield* offerRuntimeEvent(context, {
          ...base,
          type: 'files.persisted',
          payload: {
            files: Array.isArray(message.files)
              ? message.files.map((file: { filename: string; file_id: string }) => ({
                  filename: file.filename,
                  fileId: file.file_id,
                }))
              : [],
            ...(Array.isArray(message.failed)
              ? {
                  failed: message.failed.map((entry: { filename: string; error: string }) => ({
                    filename: entry.filename,
                    error: entry.error,
                  })),
                }
              : {}),
          },
        })
        return
      case 'thinking_tokens':
        return
      case 'api_retry':
        // transport-level retry heartbeat. Surfacing each attempt as a
        // warning row spammed the work log (10 rows during a 502 storm);
        // the terminal result/error path reports the actual failure. Keep
        // the session visibly alive instead.
        yield* offerRuntimeEvent(context, {
          ...base,
          type: 'session.state.changed',
          payload: {
            state: 'running',
            reason: `api_retry:${message.attempt}/${message.max_retries}`,
          },
        })
        return
      case 'session_state_changed':
        // authoritative turn-over signal from the CLI.
        yield* offerRuntimeEvent(context, {
          ...base,
          type: 'session.state.changed',
          payload: {
            state:
              message.state === 'running'
                ? 'running'
                : message.state === 'requires_action'
                  ? 'waiting'
                  : 'ready',
            reason: `session_state:${message.state}`,
          },
        })
        return
      case 'notification':
        // user-facing CLI notification (e.g. context-limit warnings). Only
        // high-priority ones warrant a work-log row.
        if (message.priority === 'high' || message.priority === 'immediate')
        {
          yield* emitRuntimeWarning(context, message.text, message)
        }
        return
      case 'model_refusal_no_fallback':
        // terminal refusal: unlike model_refusal_fallback there is no retry on
        // another model, so the turn dies here & the user needs to see why.
        // the result frame that follows carries no failing terminal_reason, so
        // record the refusal for handleResultMessage -- without it the turn
        // completes clean and ingestion nulls the error the moment the session
        // goes ready, the same erasure the usage-limit path used to suffer
        context.terminalRefusal = message.content
        yield* emitRuntimeError(context, message.content, message)
        return
      case 'worker_shutting_down':
        // host-side teardown (host_exit, remote_control_disabled, ...). The
        // stream ends right after, so surface the reason before it does.
        yield* emitRuntimeWarning(
          context,
          `Claude worker shutting down: ${message.reason}`,
          message,
        )
        return
      // inner protocol/UX details with no T3 surface today — consumed
      // deliberately so they don't masquerade as unknown-subtype warnings.
      // background_tasks_changed is a roster snapshot ({tasks: [...]}) — the
      // task_* lifecycle events carry the authoritative per-agent data & the
      // typed background_tasks control request is the reconciliation source.
      // control_request_progress is per-attempt retry telemetry for in-flight
      // control requests; api_retry already has its own session.state.changed.
      case 'model_refusal_fallback':
      case 'local_command_output':
      case 'plugin_install':
      case 'commands_changed':
      case 'memory_recall':
      case 'elicitation_complete':
      case 'background_tasks_changed':
      case 'control_request_progress':
      case 'informational':
        return
      case 'permission_denied':
        yield* offerRuntimeEvent(context, {
          ...base,
          type: 'tool.denied',
          payload: {
            toolName: message.tool_name,
            ...(message.tool_use_id ? { toolUseId: message.tool_use_id } : {}),
            ...(message.decision_reason ? { reason: message.decision_reason } : {}),
            ...(message.agent_id ? { agentId: message.agent_id } : {}),
          },
        })
        return
      case 'mirror_error':
        yield* emitRuntimeError(context, `Claude workspace mirror error: ${message.error}`, message)
        return
      default:
      {
        // exhaustiveness guard: every subtype in the SDK's typed union is
        // handled above, so `message` narrows to never here — a new SDK
        // release adding a subtype fails this typecheck instead of silently
        // warning at runtime. The runtime fallback still catches undeclared
        // wire-only subtypes (like background_tasks_changed used to be).
        message satisfies never
        const unknownMessage = message as never as { subtype: string }
        yield* emitRuntimeWarning(
          context,
          describeUnknownSdkMessage(`Claude system message '${unknownMessage.subtype}'`, message),
          message,
        )
        return
      }
    }
  })

  const handleSdkTelemetryMessage = Effect.fn('handleSdkTelemetryMessage')(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  )
  {
    const stamp = yield* makeEventStamp()
    const base = {
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      providerRefs: nativeProviderRefs(context),
      raw: {
        source: 'claude.sdk.message' as const,
        method: sdkNativeMethod(message),
        messageType: message.type,
        payload: message,
      },
    }

    if (message.type === 'tool_progress')
    {
      yield* offerRuntimeEvent(context, {
        ...base,
        type: 'tool.progress',
        payload: {
          toolUseId: message.tool_use_id,
          toolName: message.tool_name,
          elapsedSeconds: message.elapsed_time_seconds,
          ...(message.task_id ? { summary: `task:${message.task_id}` } : {}),
        },
      })
      return
    }

    if (message.type === 'tool_use_summary')
    {
      yield* offerRuntimeEvent(context, {
        ...base,
        type: 'tool.summary',
        payload: {
          summary: message.summary,
          ...(message.preceding_tool_use_ids.length > 0
            ? {
                precedingToolUseIds: message.preceding_tool_use_ids,
              }
            : {}),
        },
      })
      return
    }

    if (message.type === 'auth_status')
    {
      yield* offerRuntimeEvent(context, {
        ...base,
        type: 'auth.status',
        payload: {
          isAuthenticating: message.isAuthenticating,
          output: message.output,
          ...(message.error ? { error: message.error } : {}),
        },
      })
      return
    }

    if (message.type === 'rate_limit_event')
    {
      const info = message.rate_limit_info
      // the SDK re-streams this frame on every tick. keying on the transition, not the
      // percentage, keeps a slowly-climbing window from writing a row per tick
      const key = `${info.status}:${info.rateLimitType ?? ''}`
      if (context.lastRateLimitKey === key)
      {
        return
      }
      context.lastRateLimitKey = key
      const resetsAt = info.resetsAt === undefined ? undefined : claudeResetsAtToIso(info.resetsAt)
      yield* offerRuntimeEvent(context, {
        ...base,
        type: 'account.rate-limits.updated',
        payload: {
          snapshot: {
            status: info.status,
            ...(info.rateLimitType ? { windowId: info.rateLimitType } : {}),
            ...(info.utilization !== undefined ? { utilization: info.utilization } : {}),
            ...(resetsAt !== undefined ? { resetsAt } : {}),
          },
          // the snapshot, not the envelope. the envelope is already carried verbatim by
          // base.raw.payload, so wrapping it again lost the shape a consumer could read
          rateLimits: info,
        },
      })
      return
    }
  })

  // /clear, plan-mode exit & fresh-session flows abandon the current
  // conversation for a new one. The resume cursor has to follow, or a later
  // resume replays the dead conversation.
  const handleConversationReset = Effect.fn('handleConversationReset')(function* (
    context: ClaudeSessionContext,
    message: SDKConversationResetMessage,
  )
  {
    const nextThreadId = message.new_conversation_id
    context.resumeSessionId = nextThreadId
    context.lastAssistantUuid = undefined
    yield* updateResumeCursor(context)

    if (context.lastThreadStartedId === nextThreadId)
    {
      return
    }
    context.lastThreadStartedId = nextThreadId
    const stamp = yield* makeEventStamp()
    yield* offerRuntimeEvent(context, {
      type: 'thread.started',
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      payload: {
        providerThreadId: nextThreadId,
      },
      providerRefs: nativeProviderRefs(context),
      raw: {
        source: 'claude.sdk.message',
        method: 'claude/conversation/reset',
        payload: message,
      },
    })
  })

  const handleSdkMessage = Effect.fn('handleSdkMessage')(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  )
  {
    yield* logNativeSdkMessage(context, message)
    yield* ensureThreadId(context, message)

    switch (message.type)
    {
      case 'stream_event':
        yield* handleStreamEvent(context, message)
        return
      case 'user':
        yield* handleUserMessage(context, message)
        return
      case 'assistant':
        yield* handleAssistantMessage(context, message)
        return
      case 'result':
        yield* handleResultMessage(context, message)
        return
      case 'system':
        yield* handleSystemMessage(context, message)
        return
      case 'tool_progress':
      case 'tool_use_summary':
      case 'auth_status':
      case 'rate_limit_event':
        yield* handleSdkTelemetryMessage(context, message)
        return
      // composer prompt suggestions have no T3 surface; consumed deliberately.
      case 'prompt_suggestion':
        return
      case 'conversation_reset':
        yield* handleConversationReset(context, message)
        return
      default:
      {
        // exhaustiveness guard (see handleSystemMessage): new SDK top-level
        // message types fail typecheck here instead of warning at runtime.
        message satisfies never
        const unknownMessage = message as never as { type: string }
        yield* emitRuntimeWarning(
          context,
          describeUnknownSdkMessage(`Claude SDK message '${unknownMessage.type}'`, message),
          message,
        )
        return
      }
    }
  })

  const runSdkStream = (
    context: ClaudeSessionContext,
  ): Effect.Effect<void, ProviderAdapterProcessError> =>
    Stream.fromAsyncIterable(
      context.query,
      (cause) =>
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: context.session.threadId,
          detail: 'Claude runtime stream failed.',
          cause,
        }),
    ).pipe(
      Stream.takeWhile(() => !context.stopped && !context.stopping),
      Stream.runForEach((message) =>
        handleSdkMessage(context, message).pipe(
          Effect.tap(() =>
            Effect.sync(() =>
            {
              const resumeAttempt = context.resumeAttempt
              if (
                resumeAttempt?.usable === false &&
                message.session_id === resumeAttempt.sessionId &&
                isClaudeResumeUsableMessage(message)
              )
              {
                resumeAttempt.usable = true
              }
            }),
          ),
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: context.session.threadId,
                detail: 'Failed to process Claude runtime event.',
                cause,
              }),
          ),
        ),
      ),
    )

  const handleStreamExit = Effect.fn('handleStreamExit')(function* (
    context: ClaudeSessionContext,
    exit: Exit.Exit<void, ProviderAdapterProcessError>,
  )
  {
    if (context.stopped || context.stopping)
    {
      return
    }

    if (context.resumeAttempt?.usable === false)
    {
      const failures = Exit.isFailure(exit)
        ? exit.cause.reasons.flatMap((reason) => (Cause.isFailReason(reason) ? [reason.error] : []))
        : []
      yield* emitRuntimeError(context, CLAUDE_RESUME_FAILURE_MESSAGE, {
        failureCount: failures.length,
        failureTags: failures.map((failure) => failure._tag),
      })
      yield* completeTurn(context, 'failed', CLAUDE_RESUME_FAILURE_MESSAGE)
    }
    else if (Exit.isFailure(exit))
    {
      if (isClaudeInterruptedCause(exit.cause))
      {
        if (context.turnState)
        {
          yield* completeTurn(context, 'interrupted', 'Claude runtime interrupted.')
        }
      }
      else
      {
        const failures = exit.cause.reasons.flatMap((reason) =>
          Cause.isFailReason(reason) ? [reason.error] : [],
        )
        const message = failures[0]?.detail ?? 'Claude runtime stream failed.'
        yield* emitRuntimeError(context, message, {
          failureCount: failures.length,
          failureTags: failures.map((failure) => failure._tag),
        })
        yield* completeTurn(context, 'failed', message)
      }
    }
    else if (context.turnState)
    {
      yield* completeTurn(context, 'interrupted', 'Claude runtime stream ended.')
    }

    yield* stopSessionInternal(context, {
      emitExitEvent: true,
    })
  })

  const launchSdkStream = (context: ClaudeSessionContext): void =>
  {
    let streamFiber: Fiber.Fiber<void, never>
    streamFiber = context.runStream(
      Effect.exit(runSdkStream(context)).pipe(
        Effect.flatMap((exit) =>
        {
          if (context.stopped || context.stopping || context.streamFiber !== streamFiber)
          {
            return Effect.void
          }
          context.streamFiber = undefined
          return handleStreamExit(context, exit).pipe(
            Effect.catch((cause) =>
              Effect.logError('Failed to close Claude runtime stream.', { cause }),
            ),
          )
        }),
      ),
    )
    context.streamFiber = streamFiber
    streamFiber.addObserver(() =>
    {
      if (context.streamFiber === streamFiber)
      {
        context.streamFiber = undefined
      }
    })
  }

  // sdk system prompts are initialization-only, so mode changes restart the query and resume
  // whenever history exists; this costs one subprocess initialization per transition
  const replaceQueryForOrchestrateMode = Effect.fn('replaceClaudeQueryForOrchestrateMode')(
    function* (context: ClaudeSessionContext, orchestrate: boolean)
    {
      if (context.orchestrateSystemPromptActive === orchestrate)
      {
        return
      }

      yield* awaitClaudeQueryInitialization(context.session.threadId, context.query)

      const currentSessionId = context.resumeSessionId
      if (!currentSessionId)
      {
        return yield* new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: context.session.threadId,
          detail: 'Claude runtime session cannot switch collaboration modes before initialization.',
          cause: { reason: 'missing-resume-session-id' },
        })
      }

      const { promptQueue, prompt } = yield* makeClaudePromptChannel()
      const queryOptions: ClaudeQueryOptions = {
        ...context.baseQueryOptions,
        ...(context.currentApiModelId ? { model: context.currentApiModelId } : {}),
        systemPrompt: claudeSystemPrompt(orchestrate),
        ...(context.hasResumableHistory
          ? { resume: currentSessionId }
          : { sessionId: yield* randomUUIDv4 }),
      }
      const queryRuntime = yield* createClaudeQuery(
        context.session.threadId,
        prompt,
        queryOptions,
        CLAUDE_RESUME_FAILURE_MESSAGE,
        createQuery,
      )

      const previousPromptQueue = context.promptQueue
      const previousQuery = context.query
      const previousStreamFiber = context.streamFiber
      context.streamFiber = undefined
      yield* closeClaudeQueryResources(
        context.session.threadId,
        previousPromptQueue,
        previousStreamFiber,
        previousQuery,
        'Failed to close Claude runtime query during collaboration mode switch.',
      )

      context.promptQueue = promptQueue
      context.query = queryRuntime
      if (queryOptions.resume)
      {
        context.resumeAttempt = {
          sessionId: queryOptions.resume,
          usable: false,
          handshakePending: true,
        }
      }
      else
      {
        context.resumeSessionId = queryOptions.sessionId
        context.resumeAttempt = undefined
        context.lastThreadStartedId = undefined
        yield* updateResumeCursor(context)
      }
      context.orchestrateSystemPromptActive = orchestrate
      launchSdkStream(context)
      yield* awaitClaudeQueryInitialization(context.session.threadId, queryRuntime)
    },
  )

  const stopSessionInternal = Effect.fn('stopSessionInternal')(function* (
    context: ClaudeSessionContext,
    options?: { readonly emitExitEvent?: boolean },
  )
  {
    if (context.stopped)
    {
      return
    }
    yield* context.stopGate.withPermit(
      Effect.gen(function* ()
      {
        if (context.stopped)
        {
          return
        }

        context.stopping = true
        const streamFiber = context.streamFiber
        yield* closeClaudeQueryResources(
          context.session.threadId,
          context.promptQueue,
          streamFiber,
          context.query,
          'Failed to close Claude runtime query.',
        ).pipe(
          Effect.tap(() =>
            Effect.sync(() =>
            {
              context.streamFiber = undefined
              context.stopped = true
              context.stopping = false
            }),
          ),
          Effect.tap(() => Deferred.succeed(context.sessionStopped, undefined)),
          Effect.tapError(() =>
            Effect.sync(() =>
            {
              context.stopping = false
            }),
          ),
        )

        for (const state of context.nativeTasks.values())
        {
          if (state.completion)
          {
            continue
          }
          state.completion = { status: 'stopped' }
          yield* emitClaudeNativeTaskCompleted(context, state, {
            rawMethod: 'claude/session/stop',
            rawPayload: { reason: 'session-stopped' },
          })
        }

        for (const pending of context.pendingApprovals.values())
        {
          yield* pending.cancel
        }
        context.pendingApprovals.clear()

        // requests cannot be answered after teardown, so release every SDK waiter
        for (const pending of context.pendingUserInputs.values())
        {
          yield* pending.cancel
        }

        if (context.turnState)
        {
          yield* completeTurn(context, 'interrupted', 'Session stopped.')
        }

        const updatedAt = yield* nowIso
        context.session = {
          ...context.session,
          status: 'closed',
          activeTurnId: undefined,
          updatedAt,
        }

        const isCurrentSession = sessions.get(context.session.threadId) === context
        if (options?.emitExitEvent !== false && isCurrentSession)
        {
          const stamp = yield* makeEventStamp()
          yield* offerRuntimeEvent(context, {
            type: 'session.exited',
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            threadId: context.session.threadId,
            payload: {
              reason: 'Session stopped',
              exitKind: 'graceful',
            },
            providerRefs: {},
          })
        }

        if (isCurrentSession)
        {
          sessions.delete(context.session.threadId)
        }
      }),
    )
  })

  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<ClaudeSessionContext, ProviderAdapterError> =>
  {
    const context = sessions.get(threadId)
    if (!context)
    {
      return Effect.fail(
        new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        }),
      )
    }
    if (context.stopping || context.stopped || context.session.status === 'closed')
    {
      return Effect.fail(
        new ProviderAdapterSessionClosedError({
          provider: PROVIDER,
          threadId,
        }),
      )
    }
    return Effect.succeed(context)
  }

  const startSession: ClaudeAdapterShape['startSession'] = Effect.fn('startSession')(
    function* (input)
    {
      if (input.provider !== undefined && input.provider !== PROVIDER)
      {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: 'startSession',
          issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
        })
      }

      const resumeSessionIdCandidate = readClaudeResumeSessionIdCandidate(input.resumeCursor)
      if (resumeSessionIdCandidate !== undefined && !isUuid(resumeSessionIdCandidate))
      {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: 'startSession',
          issue: 'Claude resume session id must be a UUID.',
        })
      }
      const resumeState = readClaudeResumeState(input.resumeCursor)

      const existingContext = sessions.get(input.threadId)
      if (existingContext)
      {
        yield* Effect.logWarning('claude.session.replacing', {
          threadId: input.threadId,
          existingSessionStatus: existingContext.session.status,
          reason: 'startSession called with existing active session',
        })
        yield* stopSessionInternal(existingContext, {
          emitExitEvent: false,
        })
      }

      const startedAt = yield* nowIso
      const threadId = input.threadId
      const existingResumeSessionId = resumeState?.resume
      const newSessionId = existingResumeSessionId === undefined ? yield* randomUUIDv4 : undefined
      const sessionId = existingResumeSessionId ?? newSessionId

      const runtimeContext = yield* Effect.context<never>()
      const runFork = Effect.runForkWith(runtimeContext)
      const runPromise = Effect.runPromiseWith(runtimeContext)

      const { promptQueue, prompt } = yield* makeClaudePromptChannel()

      const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>()
      const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>()
      const userInputEventGate = yield* Semaphore.make(1)
      const stopGate = yield* Semaphore.make(1)
      const sessionStopped = yield* Deferred.make<void>()
      const inFlightTools = new Map<number, ToolInFlight>()
      const claudeTasks = new Map<string, ClaudeTaskState>()
      const nativeTaskTools = new Map<string, ClaudeNativeTaskTool>()
      const nativeTasks = new Map<string, ClaudeNativeTaskState>()
      const pendingNativeTaskModels = new Map<string, string>()

      const contextRef = yield* Ref.make<ClaudeSessionContext | undefined>(undefined)

      // handle AskUserQuestion tool calls by emitting a `user-input.requested`
      // runtime event and waiting for the user to respond via `respondToUserInput`.
      const handleAskUserQuestion = Effect.fn('handleAskUserQuestion')(function* (
        context: ClaudeSessionContext,
        toolInput: Record<string, unknown>,
        callbackOptions: {
          readonly signal: AbortSignal
          readonly toolUseID?: string
        },
      )
      {
        const requestId = ApprovalRequestId.make(yield* randomUUIDv4)

        // parse questions from the SDK's AskUserQuestion input.
        // `id` MUST equal the full question text — Claude SDK >= 2.1.121 looks
        // up answers by question text in `mapToolResultToToolResultBlockParam`,
        // so the key the UI uses to keep its draft answer must match the SDK's
        // expected lookup key. See https://github.com/pingdotgg/t3code/issues/2388
        const rawQuestions = Array.isArray(toolInput.questions) ? toolInput.questions : []
        const questions: Array<UserInputQuestion> = rawQuestions.map(
          (q: Record<string, unknown>, idx: number) => ({
            id: typeof q.question === 'string' && q.question.length > 0 ? q.question : `q-${idx}`,
            header: typeof q.header === 'string' ? q.header : `Question ${idx + 1}`,
            question: typeof q.question === 'string' ? q.question : '',
            options: Array.isArray(q.options)
              ? q.options.map((opt: Record<string, unknown>) => ({
                  label: typeof opt.label === 'string' ? opt.label : '',
                  description: typeof opt.description === 'string' ? opt.description : '',
                }))
              : [],
            multiSelect: typeof q.multiSelect === 'boolean' ? q.multiSelect : false,
          }),
        )

        const resultDeferred = yield* Deferred.make<PendingUserInputSettlement>()
        const requestCancelled = yield* Deferred.make<void>()
        const settle = (settlement: PendingUserInputSettlement) =>
          Effect.uninterruptible(
            Effect.gen(function* ()
            {
              if (pendingUserInputs.get(requestId)?.result !== resultDeferred)
              {
                return false
              }
              pendingUserInputs.delete(requestId)
              yield* Deferred.succeed(resultDeferred, settlement)
              return true
            }),
          )
        const settleAsCancelled = Effect.uninterruptible(
          Effect.gen(function* ()
          {
            yield* Deferred.succeed(requestCancelled, undefined)
            yield* settle({ _tag: 'cancelled' })
          }),
        )
        const pendingInput: PendingUserInput = {
          questions,
          result: resultDeferred,
          settle,
          cancel: settleAsCancelled,
        }

        // register teardown before event publication can yield to stop or abort.
        const onAbort = () =>
        {
          runFork(settleAsCancelled)
        }
        pendingUserInputs.set(requestId, pendingInput)
        callbackOptions.signal.addEventListener('abort', onAbort, {
          once: true,
        })
        const cleanupPendingInput = Effect.sync(() =>
        {
          callbackOptions.signal.removeEventListener('abort', onAbort)
        })
        const cancellation = Effect.raceFirst(
          Deferred.await(requestCancelled),
          Deferred.await(context.sessionStopped),
        )
        const cancellableEventStamp = Effect.suspend(() =>
        {
          if (
            callbackOptions.signal.aborted ||
            context.stopped ||
            Deferred.isDoneUnsafe(requestCancelled)
          )
          {
            return Effect.succeed(Option.none())
          }
          return Effect.raceFirst(
            makeEventStamp().pipe(Effect.map(Option.some)),
            cancellation.pipe(Effect.as(Option.none())),
          )
        })
        const publishIfActive = Effect.fn('publishUserInputEventIfActive')(function* (
          event: ProviderRuntimeEvent,
        )
        {
          return yield* context.userInputEventGate.withPermit(
            Effect.gen(function* ()
            {
              if (
                context.stopped ||
                callbackOptions.signal.aborted ||
                Deferred.isDoneUnsafe(requestCancelled)
              )
              {
                return false
              }
              yield* offerRuntimeEvent(context, event)
              return true
            }),
          )
        })

        const runUserInputLifecycle = Effect.gen(function* ()
        {
          if (callbackOptions.signal.aborted || context.stopped)
          {
            yield* settleAsCancelled
            return { _tag: 'cancelled' } as const
          }

          // emit user-input.requested so the UI can present the questions.
          const requestedStamp = yield* cancellableEventStamp
          if (Option.isNone(requestedStamp))
          {
            yield* settleAsCancelled
            return { _tag: 'cancelled' } as const
          }
          const requestedPublished = yield* publishIfActive({
            type: 'user-input.requested',
            eventId: requestedStamp.value.eventId,
            provider: PROVIDER,
            createdAt: requestedStamp.value.createdAt,
            threadId: context.session.threadId,
            ...(context.turnState
              ? {
                  turnId: asCanonicalTurnId(context.turnState.turnId),
                }
              : {}),
            requestId: asRuntimeRequestId(requestId),
            payload: { questions },
            providerRefs: nativeProviderRefs(context, {
              providerItemId: callbackOptions.toolUseID,
            }),
            raw: {
              source: 'claude.sdk.permission',
              method: 'canUseTool/AskUserQuestion',
              payload: {
                toolName: 'AskUserQuestion',
                input: toolInput,
              },
            },
          })
          if (!requestedPublished)
          {
            yield* settleAsCancelled
            return { _tag: 'cancelled' } as const
          }

          // block until the user provides answers.
          const settlement = yield* Deferred.await(resultDeferred)
          if (settlement._tag === 'cancelled')
          {
            return settlement
          }

          // a published request gets one resolved event unless teardown wins.
          const resolvedStamp = yield* cancellableEventStamp
          if (Option.isNone(resolvedStamp))
          {
            return { _tag: 'cancelled' } as const
          }
          const resolvedPublished = yield* publishIfActive({
            type: 'user-input.resolved',
            eventId: resolvedStamp.value.eventId,
            provider: PROVIDER,
            createdAt: resolvedStamp.value.createdAt,
            threadId: context.session.threadId,
            ...(context.turnState
              ? {
                  turnId: asCanonicalTurnId(context.turnState.turnId),
                }
              : {}),
            requestId: asRuntimeRequestId(requestId),
            payload: { answers: settlement.answers },
            providerRefs: nativeProviderRefs(context, {
              providerItemId: callbackOptions.toolUseID,
            }),
            raw: {
              source: 'claude.sdk.permission',
              method: 'canUseTool/AskUserQuestion/resolved',
              payload: { answers: settlement.answers },
            },
          })
          return resolvedPublished ? settlement : ({ _tag: 'cancelled' } as const)
        })

        const settlement = yield* runUserInputLifecycle.pipe(
          Effect.ensuring(settleAsCancelled),
          Effect.ensuring(cleanupPendingInput),
        )
        if (settlement._tag === 'cancelled')
        {
          return {
            behavior: 'deny',
            message: 'User cancelled tool execution.',
          } satisfies PermissionResult
        }

        // return the answers to the SDK in the expected format:
        // { questions: [...], answers: { questionText: selectedLabel } }
        return {
          behavior: 'allow',
          updatedInput: {
            questions: toolInput.questions,
            answers: settlement.answers,
          },
        } satisfies PermissionResult
      })

      const canUseToolEffect = Effect.fn('canUseTool')(function* (
        toolName: Parameters<CanUseTool>[0],
        toolInput: Parameters<CanUseTool>[1],
        callbackOptions: Parameters<CanUseTool>[2],
      )
      {
        const context = yield* Ref.get(contextRef)
        if (!context)
        {
          return {
            behavior: 'deny',
            message: 'Claude session context is unavailable.',
          } satisfies PermissionResult
        }

        // handle AskUserQuestion: surface clarifying questions to the
        // user via the user-input runtime event channel, regardless of
        // runtime mode (plan mode relies on this heavily).
        if (toolName === 'AskUserQuestion')
        {
          return yield* handleAskUserQuestion(context, toolInput, callbackOptions)
        }

        if (toolName === 'ExitPlanMode')
        {
          const planMarkdown = extractExitPlanModePlan(toolInput)
          if (planMarkdown)
          {
            yield* emitProposedPlanCompleted(context, {
              planMarkdown,
              toolUseId: callbackOptions.toolUseID,
              rawSource: 'claude.sdk.permission',
              rawMethod: 'canUseTool/ExitPlanMode',
              rawPayload: {
                toolName,
                input: toolInput,
              },
            })
          }

          return {
            behavior: 'deny',
            message:
              "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.",
          } satisfies PermissionResult
        }

        const runtimeMode = input.runtimeMode ?? 'full-access'
        if (runtimeMode === 'full-access')
        {
          return {
            behavior: 'allow',
            updatedInput: toolInput,
          } satisfies PermissionResult
        }

        const requestId = ApprovalRequestId.make(yield* randomUUIDv4)
        const requestType = classifyRequestType(toolName)
        const detail = summarizeToolRequest(toolName, toolInput)
        const decisionDeferred = yield* Deferred.make<ProviderApprovalDecision>()
        let published = false
        let resolved = false
        let resolvedEventId: EventId | undefined
        const resolveApproval = Effect.fn('resolveClaudeApproval')(function* (
          decision: ProviderApprovalDecision,
        )
        {
          yield* Deferred.succeed(decisionDeferred, decision)
          const createdAt = yield* nowIso
          // one synchronous queue offer owns resolution even when teardown removed the map entry.
          yield* Effect.sync(() =>
          {
            if (!published || resolved || resolvedEventId === undefined) return
            resolved = true
            Queue.offerUnsafe(runtimeEventQueue, {
              binding: context.runtimeSessionBinding,
              event: {
                type: 'request.resolved',
                eventId: resolvedEventId,
                provider: PROVIDER,
                createdAt,
                threadId: context.session.threadId,
                ...(context.turnState
                  ? { turnId: asCanonicalTurnId(context.turnState.turnId) }
                  : {}),
                requestId: asRuntimeRequestId(requestId),
                payload: { requestType, decision },
                providerRefs: nativeProviderRefs(context, {
                  providerItemId: callbackOptions.toolUseID,
                }),
                raw: {
                  source: 'claude.sdk.permission',
                  method: 'canUseTool/decision',
                  payload: { decision },
                },
              },
            })
          })
        })
        const pendingApproval: PendingApproval = {
          requestType,
          detail,
          decision: decisionDeferred,
          cancel: resolveApproval('cancel'),
          ...(callbackOptions.suggestions ? { suggestions: callbackOptions.suggestions } : {}),
        }

        // register cancellation before event-id allocation or publication can yield.
        const onAbort = () =>
        {
          runFork(resolveApproval('cancel'))
        }
        pendingApprovals.set(requestId, pendingApproval)
        callbackOptions.signal.addEventListener('abort', onAbort, { once: true })
        const decision = yield* Effect.gen(function* ()
        {
          if (callbackOptions.signal.aborted || context.stopped || context.stopping)
          {
            return 'cancel' as const
          }
          const publication = yield* Effect.raceFirst(
            Effect.all({ requestedStamp: makeEventStamp(), resolvedEventId: nextEventId }).pipe(
              Effect.map(Option.some),
            ),
            Effect.raceFirst(
              Deferred.await(decisionDeferred),
              Deferred.await(context.sessionStopped),
            ).pipe(Effect.as(Option.none())),
          )
          if (Option.isNone(publication)) return 'cancel' as const
          const { requestedStamp } = publication.value
          resolvedEventId = publication.value.resolvedEventId
          // publication and its ownership flag cannot interleave with another fiber.
          yield* Effect.sync(() =>
          {
            if (callbackOptions.signal.aborted || context.stopped || context.stopping) return
            published = Queue.offerUnsafe(runtimeEventQueue, {
              binding: context.runtimeSessionBinding,
              event: {
                type: 'request.opened',
                eventId: requestedStamp.eventId,
                provider: PROVIDER,
                createdAt: requestedStamp.createdAt,
                threadId: context.session.threadId,
                ...(context.turnState
                  ? { turnId: asCanonicalTurnId(context.turnState.turnId) }
                  : {}),
                requestId: asRuntimeRequestId(requestId),
                payload: {
                  requestType,
                  detail,
                  args: {
                    toolName,
                    input: toolInput,
                    ...(callbackOptions.toolUseID ? { toolUseId: callbackOptions.toolUseID } : {}),
                  },
                },
                providerRefs: nativeProviderRefs(context, {
                  providerItemId: callbackOptions.toolUseID,
                }),
                raw: {
                  source: 'claude.sdk.permission',
                  method: 'canUseTool/request',
                  payload: {
                    toolName,
                    input: toolInput,
                  },
                },
              },
            })
          })
          if (!published) return 'cancel' as const
          const answer = yield* Deferred.await(decisionDeferred)
          const decision =
            callbackOptions.signal.aborted || context.stopped || context.stopping
              ? 'cancel'
              : answer
          yield* resolveApproval(decision)
          return decision
        }).pipe(
          Effect.ensuring(
            Effect.sync(() =>
            {
              callbackOptions.signal.removeEventListener('abort', onAbort)
              if (pendingApprovals.get(requestId) === pendingApproval)
                pendingApprovals.delete(requestId)
            }),
          ),
        )
        if (
          decision === 'accept' ||
          decision === 'acceptForSession' ||
          decision === 'acceptAlways'
        )
        {
          return {
            behavior: 'allow',
            updatedInput: toolInput,
            ...(decision === 'acceptForSession' || decision === 'acceptAlways'
              ? {
                  updatedPermissions: toSessionPermissionUpdates(
                    toolName,
                    pendingApproval.suggestions,
                  ),
                }
              : {}),
          } satisfies PermissionResult
        }

        return {
          behavior: 'deny',
          message:
            decision === 'cancel'
              ? 'User cancelled tool execution.'
              : 'User declined tool execution.',
        } satisfies PermissionResult
      })

      const canUseTool: CanUseTool = (toolName, toolInput, callbackOptions) =>
        runPromise(canUseToolEffect(toolName, toolInput, callbackOptions))

      const claudeBinaryPath = claudeSdkExecutablePath
      const extraArgs = parseCliArgs(claudeSettings.launchArgs).flags
      const modelSelection =
        input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined
      const caps = getClaudeModelCapabilities(modelSelection?.model)
      const descriptors = getProviderOptionDescriptors({ caps })
      const apiModelId = modelSelection ? resolveClaudeApiModelId(modelSelection) : undefined
      const initialContextWindow = selectedClaudeContextWindow(modelSelection)
      const rawEffort = getModelSelectionStringOptionValue(modelSelection, 'effort')
      const effort = resolveClaudeEffort(caps, rawEffort) ?? null
      const fastModeSupported = descriptors.some(
        (descriptor) => descriptor.type === 'boolean' && descriptor.id === 'fastMode',
      )
      const thinkingSupported = descriptors.some(
        (descriptor) => descriptor.type === 'boolean' && descriptor.id === 'thinking',
      )
      const fastMode =
        getModelSelectionBooleanOptionValue(modelSelection, 'fastMode') === true &&
        fastModeSupported
      const thinking = thinkingSupported
        ? getModelSelectionBooleanOptionValue(modelSelection, 'thinking')
        : undefined
      const ultracode = isClaudeUltracodeEffort(effort)
      const effectiveEffort = getEffectiveClaudeAgentEffort(effort, modelSelection?.model)
      const runtimeModeToPermission: Record<string, PermissionMode> = {
        'auto-accept-edits': 'acceptEdits',
        auto: 'auto',
        'full-access': 'bypassPermissions',
      }
      const permissionMode = runtimeModeToPermission[input.runtimeMode]
      const settings = {
        ...(typeof thinking === 'boolean' ? { alwaysThinkingEnabled: thinking } : {}),
        ...(fastMode ? { fastMode: true } : {}),
        ...(ultracode ? { ultracode: true } : {}),
      }
      const mcpSession = input.mcp
      const baseQueryOptions: ClaudeQueryOptions = {
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(apiModelId ? { model: apiModelId } : {}),
        pathToClaudeCodeExecutable: claudeBinaryPath,
        systemPrompt: claudeSystemPrompt(false),
        settingSources: [...CLAUDE_SETTING_SOURCES],
        // `ultracode` is a Claude Code setting, not an API effort level. It is
        // normalized to `xhigh` above and paired with `settings.ultracode`.
        ...(effectiveEffort
          ? {
              effort: effectiveEffort as unknown as NonNullable<ClaudeQueryOptions['effort']>,
            }
          : {}),
        ...(permissionMode ? { permissionMode } : {}),
        ...(permissionMode === 'bypassPermissions'
          ? { allowDangerouslySkipPermissions: true }
          : {}),
        ...(Object.keys(settings).length > 0 ? { settings } : {}),
        includePartialMessages: true,
        // TODO(config): expose forwardSubagentText setting
        forwardSubagentText: true,
        canUseTool,
        env: claudeEnvironment,
        ...(input.cwd ? { additionalDirectories: [input.cwd] } : {}),
        ...(Object.keys(extraArgs).length > 0 ? { extraArgs } : {}),
        ...(mcpSession
          ? {
              mcpServers: {
                code456: {
                  type: 'http',
                  url: mcpSession.endpoint,
                  headers: {
                    Authorization: mcpSession.authorizationHeader,
                  },
                },
              },
            }
          : {}),
      }
      // resumeState.resumeSessionAt is deliberately NOT spread in here. the SDK reads that
      // option as 'resume only messages up to and including this uuid', so passing the durable
      // cursor would TRUNCATE the resumed history at whatever the cursor last named, silently
      // discarding everything that landed after it -- including the tail of an interrupted
      // turn. it would only be correct on an explicit post-failure re-anchor path, and no such
      // path exists. the cursor stays durable so one can be built without a schema change
      const queryOptions: ClaudeQueryOptions = {
        ...baseQueryOptions,
        ...(existingResumeSessionId ? { resume: existingResumeSessionId } : {}),
        ...(newSessionId ? { sessionId: newSessionId } : {}),
      }

      yield* Effect.annotateCurrentSpan({
        'provider.kind': PROVIDER,
        'provider.thread_id': threadId,
        'provider.runtime_mode': input.runtimeMode,
        'claude.resume.source':
          existingResumeSessionId !== undefined ? 'resume-session' : 'generated-session',
        'claude.resume.thread_id': resumeState?.threadId ?? '',
        'claude.resume.session_id': existingResumeSessionId ?? '',
        'claude.resume.session_at': resumeState?.resumeSessionAt ?? '',
        'claude.resume.turn_count': resumeState?.turnCount ?? -1,
        'claude.query.cwd': input.cwd ?? '',
        'claude.query.model': apiModelId ?? '',
        'claude.query.effort': effectiveEffort ?? '',
        'claude.query.permission_mode': permissionMode ?? '',
        'claude.query.allow_dangerously_skip_permissions': permissionMode === 'bypassPermissions',
        'claude.query.resume': existingResumeSessionId ?? '',
        'claude.query.session_id': newSessionId ?? '',
        'claude.query.include_partial_messages': true,
        'claude.query.additional_directories': input.cwd ? [input.cwd] : [],
        'claude.query.setting_sources': [...CLAUDE_SETTING_SOURCES],
        'claude.query.settings_json': encodeJsonStringForDiagnostics(settings) ?? '',
        'claude.query.extra_args_json': encodeJsonStringForDiagnostics(extraArgs) ?? '',
        'claude.query.path_to_executable': claudeBinaryPath,
      })

      const queryRuntime = yield* createClaudeQuery(
        threadId,
        prompt,
        queryOptions,
        existingResumeSessionId !== undefined
          ? CLAUDE_RESUME_FAILURE_MESSAGE
          : 'Failed to start Claude runtime session.',
        createQuery,
      )

      const session: ProviderSession = {
        threadId,
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        status: 'ready',
        runtimeMode: input.runtimeMode,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(modelSelection?.model ? { model: modelSelection.model } : {}),
        ...(threadId ? { threadId } : {}),
        resumeCursor: {
          ...(threadId ? { threadId } : {}),
          ...(sessionId ? { resume: sessionId } : {}),
          ...(resumeState?.resumeSessionAt ? { resumeSessionAt: resumeState.resumeSessionAt } : {}),
          turnCount: resumeState?.turnCount ?? 0,
        },
        createdAt: startedAt,
        updatedAt: startedAt,
      }

      const context: ClaudeSessionContext = {
        session,
        runtimeSessionBinding: input.runtimeSessionBinding,
        promptQueue,
        query: queryRuntime,
        baseQueryOptions,
        runStream: (effect) => runFork(effect),
        streamFiber: undefined,
        startedAt,
        basePermissionMode: permissionMode,
        currentApiModelId: apiModelId,
        resumeSessionId: sessionId,
        resumeAttempt:
          existingResumeSessionId !== undefined
            ? {
                sessionId: existingResumeSessionId,
                usable: false,
                handshakePending: true,
              }
            : undefined,
        hasResumableHistory: existingResumeSessionId !== undefined,
        orchestrateSystemPromptActive: false,
        pendingApprovals,
        pendingUserInputs,
        userInputEventGate,
        stopGate,
        sessionStopped,
        turns: [],
        inFlightTools,
        claudeTasks,
        nativeTaskTools,
        nativeTasks,
        pendingNativeTaskModels,
        turnState: undefined,
        lastKnownContextWindow: initialContextWindow,
        lastKnownTokenUsage: undefined,
        lastKnownTotalProcessedTokens: undefined,
        lastRateLimitKey: undefined,
        terminalRefusal: undefined,
        lastAssistantUuid: resumeState?.resumeSessionAt,
        lastThreadStartedId: undefined,
        stopping: false,
        stopped: false,
      }
      yield* Ref.set(contextRef, context)
      sessions.set(threadId, context)

      const sessionStartedStamp = yield* makeEventStamp()
      yield* offerRuntimeEvent(context, {
        type: 'session.started',
        eventId: sessionStartedStamp.eventId,
        provider: PROVIDER,
        createdAt: sessionStartedStamp.createdAt,
        threadId,
        payload: input.resumeCursor !== undefined ? { resume: input.resumeCursor } : {},
        providerRefs: {},
      })

      const configuredStamp = yield* makeEventStamp()
      yield* offerRuntimeEvent(context, {
        type: 'session.configured',
        eventId: configuredStamp.eventId,
        provider: PROVIDER,
        createdAt: configuredStamp.createdAt,
        threadId,
        payload: {
          config: {
            ...(apiModelId ? { model: apiModelId } : {}),
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(effectiveEffort ? { effort: effectiveEffort } : {}),
            ...(permissionMode ? { permissionMode } : {}),
            ...(fastMode ? { fastMode: true } : {}),
          },
        },
        providerRefs: {},
      })

      const readyStamp = yield* makeEventStamp()
      yield* offerRuntimeEvent(context, {
        type: 'session.state.changed',
        eventId: readyStamp.eventId,
        provider: PROVIDER,
        createdAt: readyStamp.createdAt,
        threadId,
        payload: {
          state: 'ready',
        },
        providerRefs: {},
      })

      launchSdkStream(context)

      return {
        ...session,
      }
    },
  )

  const sendTurn: ClaudeAdapterShape['sendTurn'] = Effect.fn('sendTurn')(function* (input)
  {
    const context = yield* requireSession(input.threadId)
    const collaborationMode = normalizeCollaborationMode(
      input.interactionMode ?? 'default',
      input.orchestrate,
    )
    const modelSelection =
      input.modelSelection !== undefined && input.modelSelection.instanceId === boundInstanceId
        ? input.modelSelection
        : undefined

    // a sendTurn while a real turn is running is a steer: the message is
    // queued into the live SDK agent loop and the work continues as the same
    // turn — no synthetic turn boundary. Stale synthetic turns (from
    // background agent responses between user prompts) are auto-closed
    // instead, so they don't block the user's next turn.
    const steeringTurnState =
      context.turnState && context.turnState.synthetic !== true ? context.turnState : null
    if (context.turnState && steeringTurnState === null)
    {
      yield* completeTurn(context, 'completed')
    }

    if (steeringTurnState === null)
    {
      yield* replaceQueryForOrchestrateMode(context, collaborationMode.orchestrate)
    }

    if (modelSelection?.model)
    {
      const apiModelId = resolveClaudeApiModelId(modelSelection)
      if (context.currentApiModelId !== apiModelId)
      {
        yield* Effect.tryPromise({
          try: () => context.query.setModel(apiModelId),
          catch: (cause) => toRequestError(input.threadId, 'turn/setModel', cause),
        })
        context.currentApiModelId = apiModelId
      }
      context.session = {
        ...context.session,
        model: modelSelection.model,
      }
    }

    // apply interaction mode by switching the SDK's permission mode.
    // "plan" maps directly to the SDK's "plan" permission mode;
    // non-plan modes restore the session's original permission mode.
    // when both collaboration fields are absent we leave the current mode unchanged.
    if (input.interactionMode !== undefined || input.orchestrate !== undefined)
    {
      yield* Effect.tryPromise({
        try: () =>
          context.query.setPermissionMode(
            collaborationMode.baseMode === 'plan'
              ? 'plan'
              : (context.basePermissionMode ?? 'default'),
          ),
        catch: (cause) => toRequestError(input.threadId, 'turn/setPermissionMode', cause),
      })
    }

    const turnId = steeringTurnState?.turnId ?? TurnId.make(yield* randomUUIDv4)
    if (steeringTurnState === null)
    {
      const turnState: ClaudeTurnState = {
        turnId,
        startedAt: yield* nowIso,
        items: [],
        assistantTextBlocks: new Map(),
        assistantTextBlockOrder: [],
        capturedProposedPlanKeys: new Set(),
        latestAssistantUsage: undefined,
        compactedSinceLatestAssistantUsage: false,
        nextSyntheticAssistantBlockIndex: -1,
      }

      const updatedAt = yield* nowIso
      context.turnState = turnState
      context.session = {
        ...context.session,
        status: 'running',
        activeTurnId: turnId,
        updatedAt,
      }

      const turnStartedStamp = yield* makeEventStamp()
      yield* offerRuntimeEvent(context, {
        type: 'turn.started',
        eventId: turnStartedStamp.eventId,
        provider: PROVIDER,
        createdAt: turnStartedStamp.createdAt,
        threadId: context.session.threadId,
        turnId,
        payload: modelSelection?.model ? { model: modelSelection.model } : {},
        providerRefs: {},
      })
    }

    const message = yield* buildUserMessageEffect(input, {
      fileSystem,
      attachmentsDir: serverConfig.attachmentsDir,
      boundInstanceId,
    })

    yield* Queue.offer(context.promptQueue, {
      type: 'message',
      message,
    }).pipe(Effect.mapError((cause) => toRequestError(input.threadId, 'turn/start', cause)))
    context.hasResumableHistory = true

    return {
      threadId: context.session.threadId,
      turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    }
  })

  const interruptTurn: ClaudeAdapterShape['interruptTurn'] = Effect.fn('interruptTurn')(
    function* (threadId, _turnId)
    {
      const context = yield* requireSession(threadId)
      yield* stopSessionInternal(context, {
        emitExitEvent: true,
      })
    },
  )

  const readThread: ClaudeAdapterShape['readThread'] = Effect.fn('readThread')(
    function* (threadId)
    {
      const context = yield* requireSession(threadId)
      return yield* snapshotThread(context)
    },
  )

  const rollbackThread: ClaudeAdapterShape['rollbackThread'] = Effect.fn('rollbackThread')(
    function* (threadId, numTurns)
    {
      const context = yield* requireSession(threadId)
      const nextLength = Math.max(0, context.turns.length - numTurns)
      context.turns.splice(nextLength)
      yield* updateResumeCursor(context)
      return yield* snapshotThread(context)
    },
  )

  const respondToRequest: ClaudeAdapterShape['respondToRequest'] = Effect.fn('respondToRequest')(
    function* (threadId, requestId, decision)
    {
      const context = yield* requireSession(threadId)
      const pending = context.pendingApprovals.get(requestId)
      if (!pending)
      {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: 'item/requestApproval/decision',
          detail: `Unknown pending approval request: ${requestId}`,
        })
      }

      context.pendingApprovals.delete(requestId)
      yield* Deferred.succeed(pending.decision, decision)
    },
  )

  const respondToUserInput: ClaudeAdapterShape['respondToUserInput'] = Effect.fn(
    'respondToUserInput',
  )(function* (threadId, requestId, answers)
  {
    const context = yield* requireSession(threadId)
    const pending = context.pendingUserInputs.get(requestId)
    if (!pending)
    {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: 'item/tool/respondToUserInput',
        detail: `Unknown pending user-input request: ${requestId}`,
      })
    }

    const settled = yield* pending.settle({
      _tag: 'answered',
      answers,
    })
    if (!settled)
    {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: 'item/tool/respondToUserInput',
        detail: `Unknown pending user-input request: ${requestId}`,
      })
    }
  })

  const stopSession: ClaudeAdapterShape['stopSession'] = Effect.fn('stopSession')(
    function* (threadId)
    {
      const context = yield* requireSession(threadId)
      yield* stopSessionInternal(context, {
        emitExitEvent: true,
      })
    },
  )

  const listSessions: ClaudeAdapterShape['listSessions'] = () =>
    Effect.sync(() => Array.from(sessions.values(), ({ session }) => ({ ...session })))

  const hasSession: ClaudeAdapterShape['hasSession'] = (threadId) =>
    Effect.sync(() =>
    {
      const context = sessions.get(threadId)
      return context !== undefined && !context.stopping && !context.stopped
    })

  const getSessionRuntimeBinding: ClaudeAdapterShape['getSessionRuntimeBinding'] = (threadId) =>
    Effect.sync(() => sessions.get(threadId)?.runtimeSessionBinding)

  const stopSessions = Effect.fn('stopSessions')(function* (
    contexts: ReadonlyArray<ClaudeSessionContext>,
    emitExitEvent: boolean,
  )
  {
    const results = yield* Effect.forEach(contexts, (context) =>
      stopSessionInternal(context, { emitExitEvent }).pipe(Effect.result),
    )
    for (const result of results)
    {
      if (result._tag === 'Failure')
      {
        return yield* result.failure
      }
    }
  })

  const stopAll: ClaudeAdapterShape['stopAll'] = () =>
    stopSessions(Array.from(sessions.values()), true)

  yield* Effect.addFinalizer(() =>
    stopSessions(Array.from(sessions.values()), false).pipe(
      Effect.catch((cause) =>
        Effect.logError('Failed to emit Claude session shutdown event.', { cause }),
      ),
      Effect.tap(() => Queue.shutdown(runtimeEventQueue)),
    ),
  )

  return {
    provider: PROVIDER,
    capabilities: CLAUDE_PROVIDER_CAPABILITIES,
    startSession,
    sendTurn,
    interruptTurn,
    readThread,
    rollbackThread,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    getSessionRuntimeBinding,
    stopAll,
    get streamEvents()
    {
      return Stream.fromQueue(runtimeEventQueue)
    },
  } satisfies ClaudeAdapterShape
})
