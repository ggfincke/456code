// apps/server/src/provider/acp/AcpRuntimeModel.ts
// normalizes ACP session state, updates, and replay lifecycle gates

import * as Clock from 'effect/Clock'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Ref from 'effect/Ref'
import type * as EffectAcpSchema from 'effect-acp/schema'
import type { SessionModelsExtension, SessionModelState } from 'effect-acp/provider-extensions'
import { deriveToolActivityPresentation } from '@t3tools/shared/toolActivity'
import type { ToolLifecycleItemType } from '@t3tools/contracts'

function isRecord(value: unknown): value is Record<string, unknown>
{
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSessionModelState(value: unknown): value is SessionModelState
{
  if (!isRecord(value) || typeof value.currentModelId !== 'string')
  {
    return false
  }
  if (!Array.isArray(value.availableModels))
  {
    return false
  }
  return value.availableModels.every(
    (model) =>
      isRecord(model) &&
      typeof model.modelId === 'string' &&
      typeof model.name === 'string' &&
      (model.description === undefined ||
        model.description === null ||
        typeof model.description === 'string'),
  )
}

function isSessionModeState(value: unknown): value is EffectAcpSchema.SessionModeState
{
  if (!isRecord(value) || typeof value.currentModeId !== 'string')
  {
    return false
  }
  if (!Array.isArray(value.availableModes))
  {
    return false
  }
  return value.availableModes.every(
    (mode) =>
      isRecord(mode) &&
      typeof mode.id === 'string' &&
      typeof mode.name === 'string' &&
      (mode.description === undefined || typeof mode.description === 'string'),
  )
}

export interface AcpSessionMode
{
  readonly id: string
  readonly name: string
  readonly description?: string
}

export interface AcpSessionModeState
{
  readonly currentModeId: string
  readonly availableModes: ReadonlyArray<AcpSessionMode>
}

export interface AcpToolCallState
{
  readonly toolCallId: string
  readonly kind?: string
  readonly title?: string
  readonly status?: 'pending' | 'inProgress' | 'completed' | 'failed'
  readonly command?: string
  readonly detail?: string
  readonly data: Record<string, unknown>
}

export interface AcpPlanUpdate
{
  readonly explanation?: string | null
  readonly plan: ReadonlyArray<{
    readonly step: string
    readonly status: 'pending' | 'inProgress' | 'completed'
  }>
}

export interface AcpPermissionRequest
{
  readonly kind: string | 'unknown'
  readonly detail?: string
  readonly toolCall?: AcpToolCallState
}

export type AcpParsedSessionEvent =
  | {
      readonly _tag: 'ModeChanged'
      readonly modeId: string
    }
  | {
      readonly _tag: 'AssistantItemStarted'
      readonly itemId: string
    }
  | {
      readonly _tag: 'AssistantItemCompleted'
      readonly itemId: string
    }
  | {
      readonly _tag: 'PlanUpdated'
      readonly payload: AcpPlanUpdate
      readonly rawPayload: unknown
    }
  | {
      readonly _tag: 'ToolCallUpdated'
      readonly toolCall: AcpToolCallState
      readonly rawPayload: unknown
    }
  | {
      readonly _tag: 'ContentDelta'
      readonly itemId?: string
      readonly text: string
      readonly rawPayload: unknown
    }

type AcpSessionSetupResponse =
  | (EffectAcpSchema.LoadSessionResponse & SessionModelsExtension)
  | (EffectAcpSchema.NewSessionResponse & SessionModelsExtension)
  | (EffectAcpSchema.ResumeSessionResponse & SessionModelsExtension)

type AcpToolCallUpdate = Extract<
  EffectAcpSchema.SessionNotification['update'],
  { readonly sessionUpdate: 'tool_call' | 'tool_call_update' }
>

export function extractModelConfigId(sessionResponse: AcpSessionSetupResponse): string | undefined
{
  const configOptions = sessionResponse.configOptions
  if (!configOptions) return undefined
  for (const opt of configOptions)
  {
    if (opt.category === 'model' && opt.id.trim().length > 0)
    {
      return opt.id.trim()
    }
  }
  return undefined
}

export function findSessionConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  configId: string,
): EffectAcpSchema.SessionConfigOption | undefined
{
  if (!configOptions)
  {
    return undefined
  }
  const normalizedConfigId = configId.trim()
  if (!normalizedConfigId)
  {
    return undefined
  }
  return configOptions.find((option) => option.id.trim() === normalizedConfigId)
}

export function collectSessionConfigOptionValues(
  configOption: EffectAcpSchema.SessionConfigOption,
): ReadonlyArray<string>
{
  if (configOption.type !== 'select')
  {
    return []
  }
  return configOption.options.flatMap((entry) =>
    'value' in entry ? [entry.value] : entry.options.map((option) => option.value),
  )
}

export function parseSessionModeState(
  sessionResponse: AcpSessionSetupResponse,
): AcpSessionModeState | undefined
{
  const modes = sessionResponse.modes
  if (!modes) return undefined
  const currentModeId = modes.currentModeId.trim()
  if (!currentModeId)
  {
    return undefined
  }
  const availableModes: Array<AcpSessionMode> = []
  for (const mode of modes.availableModes)
  {
    const id = mode.id.trim()
    const name = mode.name.trim()
    if (!id || !name)
    {
      continue
    }
    const description = mode.description?.trim() || undefined
    availableModes.push(
      description !== undefined
        ? ({ id, name, description } satisfies AcpSessionMode)
        : ({ id, name } satisfies AcpSessionMode),
    )
  }
  if (availableModes.length === 0)
  {
    return undefined
  }
  return {
    currentModeId,
    availableModes,
  }
}

function normalizePlanStepStatus(raw: unknown): 'pending' | 'inProgress' | 'completed'
{
  switch (raw)
  {
    case 'completed':
      return 'completed'
    case 'in_progress':
    case 'inProgress':
      return 'inProgress'
    default:
      return 'pending'
  }
}

function normalizeToolCallStatus(
  raw: unknown,
  fallback?: 'pending' | 'inProgress' | 'completed' | 'failed',
): 'pending' | 'inProgress' | 'completed' | 'failed' | undefined
{
  switch (raw)
  {
    case 'pending':
      return 'pending'
    case 'in_progress':
    case 'inProgress':
      return 'inProgress'
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    default:
      return fallback
  }
}

function normalizeCommandValue(value: unknown): string | undefined
{
  if (typeof value === 'string' && value.trim().length > 0)
  {
    return value.trim()
  }
  if (!Array.isArray(value))
  {
    return undefined
  }
  const parts: Array<string> = []
  for (const entry of value)
  {
    if (typeof entry === 'string')
    {
      const part = entry.trim()
      if (part.length > 0)
      {
        parts.push(part)
      }
    }
  }
  return parts.length > 0 ? parts.join(' ') : undefined
}

function extractCommandFromTitle(title: string | undefined): string | undefined
{
  if (!title)
  {
    return undefined
  }
  const match = /`([^`]+)`/.exec(title)
  return match?.[1]?.trim() || undefined
}

function extractToolCallCommand(rawInput: unknown, title: string | undefined): string | undefined
{
  if (isRecord(rawInput))
  {
    const directCommand = normalizeCommandValue(rawInput.command)
    if (directCommand)
    {
      return directCommand
    }
    const executable = typeof rawInput.executable === 'string' ? rawInput.executable.trim() : ''
    const args = normalizeCommandValue(rawInput.args)
    if (executable && args)
    {
      return `${executable} ${args}`
    }
    if (executable)
    {
      return executable
    }
  }
  return extractCommandFromTitle(title)
}

// bound cumulative acp redraws before they reach runtime event persistence
const TOOL_CALL_CONTENT_MAX_CHARS = 8_000
const TOOL_CALL_CONTENT_TRUNCATION_MARKER = '[Earlier output truncated]\n\n'

function boundToolCallOutputText(text: string): string
{
  if (text.length <= TOOL_CALL_CONTENT_MAX_CHARS)
  {
    return text
  }
  const tail = text.slice(text.length - TOOL_CALL_CONTENT_MAX_CHARS)
  return `${TOOL_CALL_CONTENT_TRUNCATION_MARKER}${tail}`
}

// provider-defined raw output can mirror the same cumulative terminal buffer
const RAW_OUTPUT_TEXT_FIELDS = ['content', 'stdout', 'stderr', 'output'] as const

function boundToolCallRawOutput(rawOutput: unknown): unknown
{
  if (!isRecord(rawOutput))
  {
    return rawOutput
  }
  let changed = false
  const bounded: Record<string, unknown> = { ...rawOutput }
  for (const field of RAW_OUTPUT_TEXT_FIELDS)
  {
    const value = rawOutput[field]
    if (typeof value === 'string' && value.length > TOOL_CALL_CONTENT_MAX_CHARS)
    {
      bounded[field] = boundToolCallOutputText(value)
      changed = true
    }
  }
  return changed ? bounded : rawOutput
}

interface ExtractedToolCallContent
{
  readonly text: string | undefined
  readonly content: ReadonlyArray<EffectAcpSchema.ToolCallContent> | undefined
}

function toolCallContentText(entry: EffectAcpSchema.ToolCallContent): string | undefined
{
  if (entry.type !== 'content' || entry.content.type !== 'text')
  {
    return undefined
  }
  return entry.content.text
}

// display trimming must not leave oversized whitespace on retained payloads
function boundToolCallContentEntries(
  content: ReadonlyArray<EffectAcpSchema.ToolCallContent>,
): ReadonlyArray<EffectAcpSchema.ToolCallContent>
{
  return content.map((entry) =>
  {
    if (entry.type !== 'content' || entry.content.type !== 'text')
    {
      return entry
    }
    const text = entry.content.text
    if (text.length <= TOOL_CALL_CONTENT_MAX_CHARS) return entry
    return {
      ...entry,
      content: {
        ...entry.content,
        text: boundToolCallOutputText(text.trim() || text),
      },
    }
  })
}

function extractTextContentFromToolCallContent(
  content: ReadonlyArray<EffectAcpSchema.ToolCallContent> | null | undefined,
): ExtractedToolCallContent
{
  if (!content)
  {
    return { text: undefined, content: undefined }
  }
  const chunks: Array<string> = []
  for (const entry of content)
  {
    const text = toolCallContentText(entry)?.trim()
    if (text)
    {
      chunks.push(text)
    }
  }
  if (chunks.length === 0)
  {
    return { text: undefined, content: boundToolCallContentEntries(content) }
  }
  const joined = chunks.join('\n')
  if (joined.length <= TOOL_CALL_CONTENT_MAX_CHARS)
  {
    return { text: joined, content: boundToolCallContentEntries(content) }
  }
  const bounded = boundToolCallOutputText(joined)
  const tailStart = joined.length - TOOL_CALL_CONTENT_MAX_CHARS
  let offset = 0
  let seenText = false
  let markerPending = true
  // retain each text slice on its original side of interleaved images and diffs
  const boundedContent = content.flatMap((entry) =>
  {
    const text = toolCallContentText(entry)?.trim()
    if (text === undefined)
    {
      return [entry]
    }
    if (!text)
    {
      return []
    }
    if (seenText) offset += 1
    seenText = true
    const start = offset
    offset += text.length
    if (offset <= tailStart) return []
    let piece = text.slice(Math.max(0, tailStart - start))
    if (markerPending)
    {
      piece = `${TOOL_CALL_CONTENT_TRUNCATION_MARKER}${piece}`
      markerPending = false
    }
    return [{ type: 'content', content: { type: 'text', text: piece } } as const]
  })
  return { text: bounded, content: boundedContent }
}

function normalizeToolKind(kind: unknown): string | undefined
{
  return typeof kind === 'string' && kind.trim().length > 0 ? kind.trim() : undefined
}

const CORAL_REPOSITORY_SEARCH_TOOL_NAMES = new Set(['search_code', 'grep', 'glob'])

export function canonicalItemTypeFromAcpToolCall(input: {
  readonly kind?: string | undefined
  readonly data: Readonly<Record<string, unknown>>
}): ToolLifecycleItemType
{
  switch (input.kind)
  {
    case 'execute':
      return 'command_execution'
    case 'edit':
    case 'delete':
    case 'move':
      return 'file_change'
    case 'search':
    {
      const rawInput = isRecord(input.data.rawInput) ? input.data.rawInput : undefined
      const rawToolName =
        typeof rawInput?.toolName === 'string' ? rawInput.toolName.trim() : undefined
      return rawToolName !== undefined && CORAL_REPOSITORY_SEARCH_TOOL_NAMES.has(rawToolName)
        ? 'repository_search'
        : 'web_search'
    }
    case 'fetch':
      return 'web_search'
    default:
      return 'dynamic_tool_call'
  }
}

function makeToolCallState(
  input: {
    readonly toolCallId: string
    readonly title?: string | null | undefined
    readonly kind?: EffectAcpSchema.ToolKind | null | undefined
    readonly status?: EffectAcpSchema.ToolCallStatus | null | undefined
    readonly rawInput?: unknown
    readonly rawOutput?: unknown
    readonly content?: ReadonlyArray<EffectAcpSchema.ToolCallContent> | null | undefined
    readonly locations?: ReadonlyArray<EffectAcpSchema.ToolCallLocation> | null | undefined
  },
  options?: {
    readonly fallbackStatus?: 'pending' | 'inProgress' | 'completed' | 'failed'
  },
): AcpToolCallState | undefined
{
  const toolCallId = input.toolCallId.trim()
  if (!toolCallId)
  {
    return undefined
  }
  const title = input.title?.trim() || undefined
  const command = extractToolCallCommand(input.rawInput, title)
  const extractedContent = extractTextContentFromToolCallContent(input.content)
  const textContent = extractedContent.text
  const normalizedTitle =
    title && title.toLowerCase() !== 'terminal' && title.toLowerCase() !== 'tool call'
      ? title
      : undefined
  const data: Record<string, unknown> = { toolCallId }
  const kind = normalizeToolKind(input.kind)
  if (kind)
  {
    data.kind = kind
  }
  if (command)
  {
    data.command = command
  }
  if (input.rawInput !== undefined)
  {
    data.rawInput = input.rawInput
  }
  if (input.rawOutput !== undefined)
  {
    data.rawOutput = boundToolCallRawOutput(input.rawOutput)
  }
  if (input.content !== undefined)
  {
    data.content = extractedContent.content ?? input.content
  }
  if (input.locations !== undefined)
  {
    data.locations = input.locations
  }
  const fallbackDetail = command ?? normalizedTitle ?? textContent
  const hasPresentationSeed =
    title !== undefined ||
    kind !== undefined ||
    command !== undefined ||
    normalizedTitle !== undefined ||
    textContent !== undefined
  const presentation = hasPresentationSeed
    ? deriveToolActivityPresentation({
        itemType: canonicalItemTypeFromAcpToolCall({ kind, data }),
        title,
        detail: fallbackDetail,
        data,
        fallbackSummary: title ?? 'Tool',
      })
    : undefined
  const status = normalizeToolCallStatus(input.status, options?.fallbackStatus)
  return {
    toolCallId,
    ...(kind ? { kind } : {}),
    ...(presentation?.summary ? { title: presentation.summary } : {}),
    ...(status ? { status } : {}),
    ...(command ? { command } : {}),
    ...(presentation?.detail ? { detail: presentation.detail } : {}),
    data,
  }
}

function parseTypedToolCallState(
  event: AcpToolCallUpdate,
  options?: {
    readonly fallbackStatus?: 'pending' | 'inProgress' | 'completed' | 'failed'
  },
): AcpToolCallState | undefined
{
  return makeToolCallState(
    {
      toolCallId: event.toolCallId,
      title: event.title,
      kind: event.kind,
      status: event.status,
      rawInput: event.rawInput,
      rawOutput: event.rawOutput,
      content: event.content,
      locations: event.locations,
    },
    options,
  )
}

export function mergeToolCallState(
  previous: AcpToolCallState | undefined,
  next: AcpToolCallState,
): AcpToolCallState
{
  const nextKind = typeof next.data.kind === 'string' ? next.data.kind : undefined
  const kind = nextKind ?? previous?.kind
  const title = next.title ?? previous?.title
  const status = next.status ?? previous?.status
  const command = next.command ?? previous?.command
  const detail = next.detail ?? previous?.detail
  return {
    toolCallId: next.toolCallId,
    ...(kind ? { kind } : {}),
    ...(title ? { title } : {}),
    ...(status ? { status } : {}),
    ...(command ? { command } : {}),
    ...(detail ? { detail } : {}),
    data: {
      ...previous?.data,
      ...next.data,
    },
  }
}

// coalesce redraws while keeping periodic progress and terminal states visible
const TOOL_CALL_UPDATE_MIN_DETAIL_GROWTH_CHARS = 256
const TOOL_CALL_UPDATE_COALESCE_LIMIT = 10

export interface AcpToolCallEmitDecisionInput
{
  readonly previous: AcpToolCallState | undefined
  readonly next: AcpToolCallState
  readonly lastEmittedDetailLength: number | undefined
  readonly skippedSinceEmit: number
}

export interface AcpToolCallEmitDecision
{
  readonly emit: boolean
  readonly skippedSinceEmit: number
}

function toolCallOutputUnchanged(previous: AcpToolCallState, next: AcpToolCallState): boolean
{
  return (
    JSON.stringify(previous.data.content) === JSON.stringify(next.data.content) &&
    JSON.stringify(previous.data.rawOutput) === JSON.stringify(next.data.rawOutput)
  )
}

// command detail stays fixed while cumulative stdout grows on the retained payload
export function toolCallProgressLength(state: AcpToolCallState): number
{
  let contentChars = 0
  if (Array.isArray(state.data.content))
  {
    for (const entry of state.data.content)
    {
      if (isRecord(entry))
      {
        contentChars += toolCallContentText(entry as EffectAcpSchema.ToolCallContent)?.length ?? 0
      }
    }
  }
  let rawOutputChars = 0
  if (isRecord(state.data.rawOutput))
  {
    for (const field of RAW_OUTPUT_TEXT_FIELDS)
    {
      const value = state.data.rawOutput[field]
      if (typeof value === 'string') rawOutputChars += value.length
    }
  }
  return Math.max(state.detail?.length ?? 0, contentChars, rawOutputChars)
}

export function decideToolCallUpdateEmission(
  input: AcpToolCallEmitDecisionInput,
): AcpToolCallEmitDecision
{
  const { previous, next, lastEmittedDetailLength, skippedSinceEmit } = input
  if (next.status === 'completed' || next.status === 'failed')
  {
    return { emit: true, skippedSinceEmit: 0 }
  }
  if (previous === undefined || previous.title !== next.title || previous.status !== next.status)
  {
    return { emit: true, skippedSinceEmit: 0 }
  }
  if (previous.detail === next.detail && toolCallOutputUnchanged(previous, next))
  {
    return { emit: false, skippedSinceEmit }
  }
  const grewMeaningfully =
    lastEmittedDetailLength === undefined ||
    Math.abs(toolCallProgressLength(next) - lastEmittedDetailLength) >=
      TOOL_CALL_UPDATE_MIN_DETAIL_GROWTH_CHARS
  if (grewMeaningfully || skippedSinceEmit + 1 >= TOOL_CALL_UPDATE_COALESCE_LIMIT)
  {
    return { emit: true, skippedSinceEmit: 0 }
  }
  return { emit: false, skippedSinceEmit: skippedSinceEmit + 1 }
}

export function parsePermissionRequest(
  params: EffectAcpSchema.RequestPermissionRequest,
): AcpPermissionRequest
{
  const toolCall = makeToolCallState(
    {
      toolCallId: params.toolCall.toolCallId,
      title: params.toolCall.title,
      kind: params.toolCall.kind,
      status: params.toolCall.status,
      rawInput: params.toolCall.rawInput,
      rawOutput: params.toolCall.rawOutput,
      content: params.toolCall.content,
      locations: params.toolCall.locations,
    },
    { fallbackStatus: 'pending' },
  )
  const kind = normalizeToolKind(params.toolCall.kind) ?? 'unknown'
  const detail =
    toolCall?.command ??
    toolCall?.title ??
    toolCall?.detail ??
    (typeof params.sessionId === 'string' ? `Session ${params.sessionId}` : undefined)
  return {
    kind,
    ...(detail ? { detail } : {}),
    ...(toolCall ? { toolCall } : {}),
  }
}

export function sessionUpdateIsReplay(params: EffectAcpSchema.SessionNotification): boolean
{
  const meta = params._meta
  return isRecord(meta) && meta.isReplay === true
}

export function replayUserMessageChunk(
  params: EffectAcpSchema.SessionNotification,
): EffectAcpSchema.ContentBlock | undefined
{
  const update = params.update
  return update.sessionUpdate === 'user_message_chunk' ? update.content : undefined
}

export function appendReplayUserMessageChunk(
  current: ReadonlyArray<EffectAcpSchema.ContentBlock>,
  chunk: EffectAcpSchema.ContentBlock,
): ReadonlyArray<EffectAcpSchema.ContentBlock>
{
  const previous = current.at(-1)
  if (chunk.type === 'text' && previous?.type === 'text')
  {
    return [...current.slice(0, -1), { type: 'text', text: previous.text + chunk.text }]
  }
  return [...current, chunk]
}

export function canonicalReplayUserMessage(
  blocks: ReadonlyArray<EffectAcpSchema.ContentBlock>,
): string
{
  return JSON.stringify(
    blocks.map((block) =>
    {
      switch (block.type)
      {
        case 'text':
          return { type: block.type, text: block.text }
        case 'image':
          return {
            type: block.type,
            data: block.data,
            mimeType: block.mimeType,
            ...(block.uri ? { uri: block.uri } : {}),
          }
        case 'audio':
          return { type: block.type, data: block.data, mimeType: block.mimeType }
        case 'resource_link':
          return {
            type: block.type,
            uri: block.uri,
            name: block.name,
            ...(block.title ? { title: block.title } : {}),
            ...(block.description ? { description: block.description } : {}),
            ...(block.mimeType ? { mimeType: block.mimeType } : {}),
            ...(block.size === undefined || block.size === null ? {} : { size: block.size }),
          }
        case 'resource':
          return { type: block.type, resource: block.resource }
      }
    }),
  )
}

export interface SessionLoadGate
{
  readonly active: boolean
  readonly sessionId: string
  readonly lastActivityAtMillis: number | undefined
  readonly idleGap: Duration.Duration
  readonly initializeResult: EffectAcpSchema.InitializeResponse
  readonly expectedReplayUserMessageSha256?: string
  readonly replayUserMessageBlocks: ReadonlyArray<EffectAcpSchema.ContentBlock>
  readonly replayUserMessageOpen: boolean
}

export interface SessionLoadReplayTailMismatch
{
  readonly _tag: 'SessionLoadReplayTailMismatch'
  readonly expected: string
  readonly actual: string
}

export const SESSION_LOAD_REPLAY_TAIL_MISMATCH_DETAIL =
  'session/load replay did not reach the expected local history tail'

export const waitForSessionLoadReplayIdle = (input: {
  readonly gateRef: Ref.Ref<Option.Option<SessionLoadGate>>
  readonly digestReplayUserMessage: (text: string) => Effect.Effect<string, never>
}): Effect.Effect<EffectAcpSchema.LoadSessionResponse, SessionLoadReplayTailMismatch> =>
  Effect.gen(function* ()
  {
    const pollInterval = Duration.millis(25)
    while (true)
    {
      const gate = yield* Ref.get(input.gateRef)
      if (
        Option.isSome(gate) &&
        gate.value.active &&
        gate.value.lastActivityAtMillis !== undefined
      )
      {
        const idleGapMillis = Duration.toMillis(gate.value.idleGap)
        const nowMillis = yield* Clock.currentTimeMillis
        if (nowMillis - gate.value.lastActivityAtMillis >= idleGapMillis)
        {
          if (gate.value.expectedReplayUserMessageSha256 !== undefined)
          {
            const actual = yield* input.digestReplayUserMessage(
              canonicalReplayUserMessage(gate.value.replayUserMessageBlocks),
            )
            if (actual !== gate.value.expectedReplayUserMessageSha256)
            {
              return yield* Effect.fail({
                _tag: 'SessionLoadReplayTailMismatch' as const,
                expected: gate.value.expectedReplayUserMessageSha256,
                actual,
              })
            }
          }
          return syntheticLoadSessionResponseFromInitialize(gate.value.initializeResult)
        }
      }
      yield* Effect.sleep(pollInterval)
    }
  })

export function syntheticLoadSessionResponseFromInitialize(
  initializeResult: EffectAcpSchema.InitializeResponse,
): EffectAcpSchema.LoadSessionResponse & SessionModelsExtension
{
  const meta = initializeResult._meta
  const modelState = isRecord(meta) ? meta.modelState : undefined
  const modeState = isRecord(meta) ? meta.modeState : undefined
  const models = isSessionModelState(modelState) ? modelState : undefined
  const modes = isSessionModeState(modeState) ? modeState : undefined

  return {
    ...(models ? { models } : {}),
    ...(modes ? { modes } : {}),
    _meta: {
      t3SessionLoadReady: 'replay_idle',
    },
  }
}

function boundToolCallRawPayload(
  params: EffectAcpSchema.SessionNotification,
  update: AcpToolCallUpdate,
  toolCall: AcpToolCallState,
): unknown
{
  const boundedContent = toolCall.data.content
  const boundedRawOutput = toolCall.data.rawOutput
  const contentBounded = update.content !== undefined && boundedContent !== update.content
  const rawOutputBounded = update.rawOutput !== undefined && boundedRawOutput !== update.rawOutput
  if (!contentBounded && !rawOutputBounded)
  {
    return params
  }
  return {
    ...params,
    update: {
      ...update,
      ...(contentBounded ? { content: boundedContent } : {}),
      ...(rawOutputBounded ? { rawOutput: boundedRawOutput } : {}),
    },
  }
}

export function parseSessionUpdateEvent(params: EffectAcpSchema.SessionNotification): {
  readonly modeId?: string
  readonly events: ReadonlyArray<AcpParsedSessionEvent>
}
{
  const upd = params.update
  const events: Array<AcpParsedSessionEvent> = []
  let modeId: string | undefined

  switch (upd.sessionUpdate)
  {
    case 'current_mode_update':
    {
      modeId = upd.currentModeId.trim()
      if (modeId)
      {
        events.push({
          _tag: 'ModeChanged',
          modeId,
        })
      }
      break
    }
    case 'plan':
    {
      const plan = upd.entries.map((entry, index) => ({
        step: entry.content.trim().length > 0 ? entry.content.trim() : `Step ${index + 1}`,
        status: normalizePlanStepStatus(entry.status),
      }))
      if (plan.length > 0)
      {
        events.push({
          _tag: 'PlanUpdated',
          payload: {
            plan,
          },
          rawPayload: params,
        })
      }
      break
    }
    case 'tool_call':
    {
      const toolCall = parseTypedToolCallState(upd, {
        fallbackStatus: 'pending',
      })
      if (toolCall)
      {
        events.push({
          _tag: 'ToolCallUpdated',
          toolCall,
          rawPayload: boundToolCallRawPayload(params, upd, toolCall),
        })
      }
      break
    }
    case 'tool_call_update':
    {
      const toolCall = parseTypedToolCallState(upd)
      if (toolCall)
      {
        events.push({
          _tag: 'ToolCallUpdated',
          toolCall,
          rawPayload: boundToolCallRawPayload(params, upd, toolCall),
        })
      }
      break
    }
    case 'agent_message_chunk':
    {
      if (upd.content.type === 'text' && upd.content.text.length > 0)
      {
        events.push({
          _tag: 'ContentDelta',
          text: upd.content.text,
          rawPayload: params,
        })
      }
      break
    }
    default:
      break
  }

  return { ...(modeId !== undefined ? { modeId } : {}), events }
}
