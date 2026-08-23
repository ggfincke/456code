// apps/server/src/provider/Layers/AntigravityAdapter.ts
// adapt antigravity stream-json turns to the provider runtime contract

// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from 'node:path'

import {
  type AntigravitySettings,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeTaskId,
  type ThreadTokenUsageSnapshot,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadId,
  TurnId,
} from '@t3tools/contracts'
import * as Crypto from 'effect/Crypto'
import * as Cause from 'effect/Cause'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import * as PubSub from 'effect/PubSub'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'
import { ChildProcessSpawner } from 'effect/unstable/process'
import { resolveCommandPath } from '@t3tools/shared/shell'

import {
  AntigravityResumeCursor,
  ANTIGRAVITY_RESUME_CURSOR_VERSION,
  ANTIGRAVITY_DEFAULT_MODEL,
  ANTIGRAVITY_PROVIDER,
  conversationIdFromStreamMessage,
  resultErrorFromStreamMessage,
  resultResponseFromStreamMessage,
  resultStatusFromStreamMessage,
  type AntigravityResumeCursor as AntigravityResumeCursorType,
  type AntigravityResumeBinding,
} from '../antigravity/AntigravityCli.ts'
import {
  makeAntigravitySessionRuntime,
  type AntigravityResult,
  type AntigravitySessionRuntimeShape,
} from '../antigravity/AntigravitySessionRuntime.ts'
import { ProviderAdapterValidationError, type ProviderAdapterError } from '../Errors.ts'
import { ANTIGRAVITY_PROVIDER_CAPABILITIES } from '../providerCapabilities.ts'
import type {
  ProviderAdapterRuntimeEvent,
  ProviderAdapterRuntimeSessionBinding,
  ProviderAdapterShape,
} from '../Services/ProviderAdapter.ts'
import { makeKeyedSemaphore } from './KeyedSemaphore.ts'

const PROVIDER = ProviderDriverKind.make(ANTIGRAVITY_PROVIDER)
const isResumeCursor = Schema.is(AntigravityResumeCursor)
const MAPPED_STEP_TYPES = new Set(['agent_response', 'checkpoint', 'tool', 'user_input'])

interface AntigravitySessionContext
{
  readonly threadId: ThreadId
  readonly binding: ProviderAdapterRuntimeSessionBinding
  readonly runtime: AntigravitySessionRuntimeShape
  readonly conversationId: string
  readonly cursorBinding: AntigravityResumeBinding
  session: ProviderSession
  activeTurnId: TurnId | undefined
  turnFiber: Fiber.Fiber<void, never> | undefined
  eventFiber: Fiber.Fiber<void, never> | undefined
  sawResponseDelta: boolean
  turns: Array<{ id: TurnId; items: Array<unknown> }>
  lastUsage: AntigravityCumulativeUsage | undefined
  toolStepStates: Map<number, 'started' | 'completed'>
  subagentTaskStates: Map<string, 'started' | 'completed'>
  finalizedTurnIds: Set<TurnId>
  activeTurnInput: string | undefined
  stopped: boolean
}

type AntigravityCumulativeUsage = NonNullable<AntigravityResumeCursorType['cumulativeUsage']>
type MutableAntigravityCumulativeUsage = {
  -readonly [K in keyof AntigravityCumulativeUsage]?: number
}

function cursorBindingMatches(
  left: AntigravityResumeBinding,
  right: AntigravityResumeBinding,
): boolean
{
  return (
    left.workspace === right.workspace &&
    left.executable === right.executable &&
    left.model === right.model &&
    left.agent === right.agent &&
    left.runtimeMode === right.runtimeMode &&
    left.sandbox === right.sandbox
  )
}

function isRecord(value: unknown): value is Record<string, unknown>
{
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined
{
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function antigravityToolItemType(
  toolName: string,
):
  | 'command_execution'
  | 'file_change'
  | 'mcp_tool_call'
  | 'repository_search'
  | 'web_search'
  | 'image_view'
  | 'dynamic_tool_call'
  {
  if (toolName === 'run_command') return 'command_execution'
  if (['write_to_file', 'replace_file_content', 'multi_replace_file_content'].includes(toolName))
  {
    return 'file_change'
  }
  if (['code_search', 'grep_search', 'view_file'].includes(toolName)) return 'repository_search'
  if (['read_url', 'browser'].includes(toolName)) return 'web_search'
  if (toolName === 'view_image') return 'image_view'
  if (toolName.includes('mcp')) return 'mcp_tool_call'
  return 'dynamic_tool_call'
}

function antigravityRaw(value: Record<string, unknown>)
{
  return {
    source: 'antigravity.stream-json' as const,
    method: typeof value.event === 'string' ? value.event : 'unknown',
    payload: value,
  }
}

function usageRecord(value: Record<string, unknown>): Record<string, unknown> | undefined
{
  const direct = value.usage
  if (isRecord(direct)) return direct
  const nested = value.result
  return isRecord(nested) && isRecord(nested.usage) ? nested.usage : undefined
}

function usageNumber(
  value: Record<string, unknown>,
  ...keys: ReadonlyArray<string>
): number | undefined
{
  for (const key of keys)
  {
    const candidate = value[key]
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0)
      return Math.floor(candidate)
  }
  return undefined
}

function antigravityUsageSnapshot(
  result: Record<string, unknown>,
  previous: AntigravityCumulativeUsage | undefined,
):
  | {
      readonly usage: ThreadTokenUsageSnapshot
      readonly cumulative: AntigravityCumulativeUsage
      readonly turnUsage: Record<string, number>
      readonly countersReset: boolean
    }
  | undefined
  {
  const raw = usageRecord(result)
  if (!raw) return undefined
  const observed: { -readonly [K in keyof AntigravityCumulativeUsage]?: number } = {}
  const fields = {
    input: usageNumber(raw, 'input_tokens', 'inputTokens'),
    cached: usageNumber(
      raw,
      'cache_read_tokens',
      'cached_input_tokens',
      'cachedInputTokens',
      'cache_read_input_tokens',
    ),
    output: usageNumber(raw, 'output_tokens', 'outputTokens'),
    reasoning: usageNumber(
      raw,
      'reasoning_output_tokens',
      'reasoningOutputTokens',
      'thinking_tokens',
    ),
    total: usageNumber(raw, 'total_tokens', 'totalTokens'),
    durationMs:
      typeof (isRecord(result.result)
        ? result.result.duration_seconds
        : result.duration_seconds) === 'number'
        ? Math.max(
            0,
            Math.round(
              Number(
                isRecord(result.result) ? result.result.duration_seconds : result.duration_seconds,
              ) * 1_000,
            ),
          )
        : undefined,
    turns: usageNumber(isRecord(result.result) ? result.result : result, 'num_turns'),
  }
  for (const key of Object.keys(fields) as Array<keyof typeof fields>)
  {
    const value = fields[key]
    if (value !== undefined) observed[key] = value
  }
  if (Object.keys(observed).length === 0) return undefined
  const cumulative = {} as MutableAntigravityCumulativeUsage
  if (previous !== undefined) Object.assign(cumulative, previous)
  for (const key of Object.keys(observed) as Array<keyof AntigravityCumulativeUsage>)
  {
    const value = observed[key]
    if (value !== undefined) cumulative[key] = value
  }
  const countersReset =
    previous !== undefined &&
    (Object.keys(observed) as Array<keyof AntigravityCumulativeUsage>).some(
      (key) => previous[key] !== undefined && observed[key]! < previous[key]!,
    )
  const delta = (key: keyof AntigravityCumulativeUsage) =>
  {
    const current = observed[key]
    if (current === undefined) return undefined
    const before = previous?.[key]
    return countersReset || before === undefined ? current : current - before
  }
  const input = observed.input
  const cached = observed.cached
  const output = observed.output
  const reasoning = observed.reasoning
  const turnInput = delta('input') ?? 0
  const turnCached = delta('cached') ?? 0
  const turnOutput = delta('output') ?? 0
  const turnReasoning = delta('reasoning') ?? 0
  const turnTotal = delta('total') ?? turnInput + turnOutput
  const durationMs = delta('durationMs')
  const numTurns = delta('turns')
  return {
    cumulative,
    countersReset,
    turnUsage: {
      totalTokens: turnTotal,
      ...(input === undefined ? {} : { inputTokens: turnInput }),
      ...(cached === undefined ? {} : { cachedInputTokens: turnCached }),
      ...(output === undefined ? {} : { outputTokens: turnOutput }),
      ...(reasoning === undefined ? {} : { reasoningOutputTokens: turnReasoning }),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(numTurns === undefined ? {} : { numTurns }),
    },
    usage: {
      usedTokens: turnTotal,
      ...(cumulative.total !== undefined ? { totalProcessedTokens: cumulative.total } : {}),
      ...(input !== undefined ? { inputTokens: turnInput, lastInputTokens: turnInput } : {}),
      ...(cached !== undefined
        ? { cachedInputTokens: turnCached, lastCachedInputTokens: turnCached }
        : {}),
      ...(output !== undefined ? { outputTokens: turnOutput, lastOutputTokens: turnOutput } : {}),
      ...(reasoning !== undefined
        ? { reasoningOutputTokens: turnReasoning, lastReasoningOutputTokens: turnReasoning }
        : {}),
      ...(durationMs === undefined ? {} : { durationMs }),
      lastUsedTokens: turnTotal,
    },
  }
}

function antigravityLiveUsageSnapshot(
  value: Record<string, unknown>,
): ThreadTokenUsageSnapshot | undefined
{
  const raw = usageRecord(value)
  if (!raw) return undefined
  const inputTokens = usageNumber(raw, 'input_tokens', 'inputTokens')
  const cachedInputTokens = usageNumber(
    raw,
    'cache_read_tokens',
    'cached_input_tokens',
    'cachedInputTokens',
    'cache_read_input_tokens',
  )
  const outputTokens = usageNumber(raw, 'output_tokens', 'outputTokens')
  const reasoningOutputTokens = usageNumber(
    raw,
    'reasoning_output_tokens',
    'reasoningOutputTokens',
    'thinking_tokens',
  )
  const usedTokens =
    usageNumber(raw, 'total_tokens', 'totalTokens') ?? (inputTokens ?? 0) + (outputTokens ?? 0)
  if (
    usedTokens === 0 &&
    inputTokens === undefined &&
    cachedInputTokens === undefined &&
    outputTokens === undefined &&
    reasoningOutputTokens === undefined
  )
  {
    return undefined
  }
  return {
    usedTokens,
    lastUsedTokens: usedTokens,
    ...(inputTokens === undefined ? {} : { inputTokens, lastInputTokens: inputTokens }),
    ...(cachedInputTokens === undefined
      ? {}
      : { cachedInputTokens, lastCachedInputTokens: cachedInputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens, lastOutputTokens: outputTokens }),
    ...(reasoningOutputTokens === undefined
      ? {}
      : { reasoningOutputTokens, lastReasoningOutputTokens: reasoningOutputTokens }),
  }
}

export interface AntigravityAdapterOptions
{
  readonly environment?: NodeJS.ProcessEnv
  readonly instanceId?: ProviderInstanceId
  readonly resolvedBinaryPath?: string
  readonly discoverAgents?: () => Effect.Effect<ReadonlyArray<string> | undefined>
}

export type AntigravityAdapterShape = ProviderAdapterShape<ProviderAdapterError>

export const makeAntigravityAdapter = Effect.fn('makeAntigravityAdapter')(function* (
  settings: Pick<AntigravitySettings, 'agent' | 'binaryPath' | 'sandbox'>,
  options?: AntigravityAdapterOptions,
): Effect.fn.Return<
  AntigravityAdapterShape,
  never,
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | Scope.Scope
>
{
  const crypto = yield* Crypto.Crypto
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const scope = yield* Scope.Scope
  const instanceId = options?.instanceId ?? ProviderInstanceId.make(ANTIGRAVITY_PROVIDER)
  const events = yield* PubSub.unbounded<ProviderAdapterRuntimeEvent>()
  const sessions = new Map<ThreadId, AntigravitySessionContext>()
  const threadLocks = yield* makeKeyedSemaphore<ThreadId>()
  const withThreadLock = <A, E, R>(threadId: ThreadId, effect: Effect.Effect<A, E, R>) =>
    threadLocks.withPermit(threadId, effect)

  const now: Effect.Effect<string> = Effect.map(DateTime.now, DateTime.formatIso)
  const eventBase = (binding: ProviderAdapterRuntimeSessionBinding, turnId?: TurnId) =>
    Effect.gen(function* ()
    {
      const eventId = yield* crypto.randomUUIDv4.pipe(Effect.orDie)
      return {
        eventId: EventId.make(eventId),
        provider: PROVIDER,
        providerInstanceId: instanceId,
        threadId: binding.threadId,
        createdAt: yield* DateTime.now.pipe(Effect.map(DateTime.formatIso)),
        ...(turnId ? { turnId } : {}),
      }
    })

  const emit = (
    binding: ProviderAdapterRuntimeSessionBinding,
    type: ProviderRuntimeEvent['type'],
    payload: unknown,
    turnId?: TurnId,
    extra?: {
      readonly itemId?: RuntimeItemId
      readonly raw?: ReturnType<typeof antigravityRaw>
    },
  ): Effect.Effect<void, never> =>
    eventBase(binding, turnId).pipe(
      Effect.flatMap((base) =>
        PubSub.publish(events, {
          binding,
          event: {
            ...base,
            type,
            payload,
            ...(extra?.itemId ? { itemId: extra.itemId } : {}),
            ...(extra?.raw ? { raw: extra.raw } : {}),
          } as ProviderRuntimeEvent,
        }).pipe(Effect.orDie),
      ),
      Effect.asVoid,
    )

  const fail = (operation: string, issue: string): Effect.Effect<never, ProviderAdapterError> =>
    Effect.fail(new ProviderAdapterValidationError({ provider: PROVIDER, operation, issue }))

  const finalizeTurn = (
    context: AntigravitySessionContext,
    turnId: TurnId,
    text: string,
    result: AntigravityResult,
  ): Effect.Effect<void> =>
    Effect.gen(function* ()
    {
      if (context.finalizedTurnIds.has(turnId)) return
      context.finalizedTurnIds.add(turnId)
      if (result.response && !context.sawResponseDelta)
      {
        yield* emit(
          context.binding,
          'content.delta',
          {
            streamKind: 'assistant_text',
            delta: result.response,
          },
          turnId,
        )
      }
      const usage = antigravityUsageSnapshot(result.raw, context.lastUsage)
      if (usage)
      {
        context.lastUsage = usage.cumulative
        yield* emit(context.binding, 'thread.token-usage.updated', { usage: usage.usage }, turnId)
        if (usage.countersReset)
        {
          yield* emit(
            context.binding,
            'runtime.warning',
            {
              message: 'Antigravity cumulative usage counters reset.',
              detail: { current: usage.cumulative },
            },
            turnId,
          )
        }
      }
      const resultConversationMismatch =
        result.conversationId !== undefined && result.conversationId !== context.conversationId
      const nativeCancellation = result.status === 'CANCELED' || result.status === 'INTERRUPTED'
      const completed = result.status === 'SUCCESS' && !resultConversationMismatch
      const knownFailure = result.status === 'ERROR' || result.status === 'INVALID'
      const protocolError = resultConversationMismatch
        ? `Antigravity result conversation id '${result.conversationId}' did not match '${context.conversationId}'.`
        : !completed && !nativeCancellation && !knownFailure
          ? `Antigravity returned unexpected terminal status '${result.status}'.`
          : undefined
      const terminalError =
        protocolError ??
        result.error ??
        (knownFailure
          ? result.response.trim() || `Antigravity turn failed with status '${result.status}'.`
          : undefined)
      const state =
        result.status === 'CANCELED'
          ? ('cancelled' as const)
          : result.status === 'INTERRUPTED'
            ? ('interrupted' as const)
            : completed
              ? ('completed' as const)
              : ('failed' as const)
      context.turns.push({ id: turnId, items: [{ prompt: text, result }] })
      if (context.activeTurnId === turnId)
      {
        context.activeTurnId = undefined
        context.activeTurnInput = undefined
      }
      context.turnFiber = undefined
      if (protocolError) yield* context.runtime.close
      const runtimeLive = protocolError ? false : yield* context.runtime.isLive
      const { activeTurnId: _activeTurnId, ...settledSession } = context.session
      context.session = {
        ...settledSession,
        status: runtimeLive ? 'ready' : 'error',
        resumeCursor: {
          schemaVersion: ANTIGRAVITY_RESUME_CURSOR_VERSION,
          conversationId: context.conversationId,
          binding: context.cursorBinding,
          ...(context.lastUsage ? { cumulativeUsage: context.lastUsage } : {}),
        },
        updatedAt: yield* now,
      }
      yield* emit(
        context.binding,
        'turn.completed',
        {
          state,
          stopReason: result.status,
          ...(usage ? { usage: usage.turnUsage } : {}),
          ...(terminalError ? { errorMessage: terminalError } : {}),
        },
        turnId,
        { raw: antigravityRaw(result.raw) },
      )
    })

  const startSession: AntigravityAdapterShape['startSession'] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* ()
      {
        if (input.provider !== undefined && input.provider !== PROVIDER)
        {
          return yield* fail('startSession', `Expected provider '${PROVIDER}'.`)
        }
        if (!input.cwd?.trim()) return yield* fail('startSession', 'cwd is required.')
        if (input.runtimeMode !== 'auto-accept-edits' && input.runtimeMode !== 'full-access')
        {
          return yield* fail(
            'startSession',
            `Antigravity does not support runtime mode '${input.runtimeMode}'.`,
          )
        }
        if (input.modelSelection !== undefined && input.modelSelection.instanceId !== instanceId)
        {
          return yield* fail(
            'startSession',
            `Model selection is bound to '${input.modelSelection.instanceId}'.`,
          )
        }
        const selectedModel = input.modelSelection?.model ?? ANTIGRAVITY_DEFAULT_MODEL
        const requestedAgent = settings.agent.trim() || undefined
        const workspacePath = NodePath.resolve(input.cwd)
        const workspace = yield* fileSystem
          .realPath(workspacePath)
          .pipe(Effect.orElseSucceed(() => workspacePath))
        const configuredExecutable =
          options?.resolvedBinaryPath?.trim() || settings.binaryPath.trim() || 'agy'
        const lookupExecutable =
          configuredExecutable.includes('/') || configuredExecutable.includes('\\')
            ? path.resolve(input.cwd, configuredExecutable)
            : configuredExecutable
        const resolvedExecutable = yield* resolveCommandPath(
          lookupExecutable,
          options?.environment === undefined ? {} : { env: options.environment },
        ).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.catchTag('CommandResolutionError', () => Effect.succeed(null)),
        )
        const executableCandidate =
          resolvedExecutable ??
          (lookupExecutable.includes('/') || lookupExecutable.includes('\\')
            ? lookupExecutable
            : configuredExecutable)
        const executable = yield* fileSystem
          .realPath(executableCandidate)
          .pipe(Effect.orElseSucceed(() => executableCandidate))
        const cursorBinding: AntigravityResumeBinding = {
          workspace,
          executable,
          model: selectedModel,
          agent: requestedAgent ?? '',
          runtimeMode: input.runtimeMode,
          sandbox: settings.sandbox,
        }
        if (requestedAgent && options?.discoverAgents)
        {
          const discoveredAgents = yield* options.discoverAgents()
          if (discoveredAgents !== undefined && !discoveredAgents.includes(requestedAgent))
          {
            return yield* fail(
              'startSession',
              `Antigravity agent '${requestedAgent}' was not discovered.`,
            )
          }
        }
        const candidateResumeCursor = isResumeCursor(input.resumeCursor)
          ? (input.resumeCursor as AntigravityResumeCursorType)
          : undefined
        const continuationIssue =
          input.resumeCursor === undefined
            ? undefined
            : candidateResumeCursor === undefined
              ? 'The persisted Antigravity continuation cursor is invalid or from an older cursor version.'
              : !cursorBindingMatches(candidateResumeCursor.binding, cursorBinding)
                ? 'The persisted Antigravity continuation cursor does not match the current workspace, executable, model, agent, runtime mode, or sandbox.'
                : undefined
        const resumeCursor = continuationIssue === undefined ? candidateResumeCursor : undefined
        const existing = sessions.get(input.threadId)
        if (existing !== undefined) yield* stopContext(existing)
        const runtimeResult = yield* makeAntigravitySessionRuntime({
          binaryPath: executable,
          cwd: input.cwd,
          runtimeMode: input.runtimeMode,
          ...(selectedModel !== ANTIGRAVITY_DEFAULT_MODEL ? { model: selectedModel } : {}),
          ...(options?.environment ? { environment: options.environment } : {}),
          ...(requestedAgent ? { agent: requestedAgent } : {}),
          sandbox: settings.sandbox,
          ...(resumeCursor ? { resumeCursor } : {}),
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
          Effect.provideService(Scope.Scope, scope),
          Effect.result,
        )
        const runtime = Result.isFailure(runtimeResult)
          ? yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: 'startSession',
              issue: `Failed to start Antigravity: ${String(runtimeResult.failure)}`,
              cause: runtimeResult.failure,
            })
          : runtimeResult.success
        const conversationId = yield* runtime.conversationId
        const createdAt = yield* now
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: instanceId,
          status: 'ready',
          runtimeMode: input.runtimeMode,
          cwd: input.cwd,
          ...(selectedModel ? { model: selectedModel } : {}),
          threadId: input.threadId,
          resumeCursor: {
            schemaVersion: ANTIGRAVITY_RESUME_CURSOR_VERSION,
            conversationId,
            binding: cursorBinding,
            ...(resumeCursor?.cumulativeUsage
              ? { cumulativeUsage: resumeCursor.cumulativeUsage }
              : {}),
          },
          createdAt,
          updatedAt: createdAt,
        }
        const context: AntigravitySessionContext = {
          threadId: input.threadId,
          binding: input.runtimeSessionBinding,
          runtime,
          conversationId,
          cursorBinding,
          session,
          activeTurnId: undefined,
          turnFiber: undefined,
          eventFiber: undefined,
          sawResponseDelta: false,
          turns: [],
          lastUsage: resumeCursor?.cumulativeUsage,
          toolStepStates: new Map(),
          subagentTaskStates: new Map(),
          finalizedTurnIds: new Set(),
          activeTurnInput: undefined,
          stopped: false,
        }
        sessions.set(input.threadId, context)
        context.eventFiber = yield* Stream.runForEach(runtime.events, (message) =>
          Effect.gen(function* ()
          {
            const turnId = context.activeTurnId
            if (!turnId) return
            if (message.kind === 'result')
            {
              const text = context.activeTurnInput
              if (!text) return
              const resultError = resultErrorFromStreamMessage(message.value)
              const resultConversationId = conversationIdFromStreamMessage(message.value)
              yield* withThreadLock(
                context.threadId,
                finalizeTurn(context, turnId, text, {
                  ...(resultConversationId ? { conversationId: resultConversationId } : {}),
                  status: resultStatusFromStreamMessage(message.value),
                  response: resultResponseFromStreamMessage(message.value),
                  ...(resultError ? { error: resultError } : {}),
                  raw: message.value,
                }),
              )
              return
            }
            if (message.kind === 'step_update')
            {
              const step = isRecord(message.value.step_update) ? message.value.step_update : {}
              const stepIndex = typeof step.step_index === 'number' ? step.step_index : 0
              const stepType = nonEmptyString(step.step_type)
              const stepState = nonEmptyString(step.state)
              const raw = antigravityRaw(message.value)
              const liveUsage = antigravityLiveUsageSnapshot(step)
              if (liveUsage)
              {
                yield* emit(
                  context.binding,
                  'thread.token-usage.updated',
                  { usage: liveUsage },
                  turnId,
                  { raw },
                )
              }
              if (stepType === 'agent_response')
              {
                const text = typeof step.text_delta === 'string' ? step.text_delta : undefined
                if (text)
                {
                  context.sawResponseDelta = true
                  yield* emit(
                    context.binding,
                    'content.delta',
                    { streamKind: 'assistant_text', delta: text },
                    turnId,
                    { raw },
                  )
                }
              }
              if (stepType === 'tool')
              {
                const itemId = RuntimeItemId.make(
                  `antigravity:${conversationId}:${turnId}:${stepIndex}`,
                )
                const toolInfo = isRecord(step.tool_info) ? step.tool_info : {}
                const toolName =
                  nonEmptyString(step.tool_name) ??
                  nonEmptyString(toolInfo.name) ??
                  'Antigravity tool'
                const error = isRecord(toolInfo.error) ? toolInfo.error : undefined
                const errorMessage =
                  nonEmptyString(error?.message) ?? nonEmptyString(toolInfo.error)
                const output = nonEmptyString(toolInfo.output)
                const payload = {
                  itemType: antigravityToolItemType(toolName),
                  status:
                    stepState === 'DONE'
                      ? errorMessage
                        ? ('failed' as const)
                        : ('completed' as const)
                      : ('inProgress' as const),
                  title: toolName,
                  ...(errorMessage || output ? { detail: errorMessage ?? output } : {}),
                  data: {
                    toolName,
                    ...(isRecord(toolInfo.parameters) ? { input: toolInfo.parameters } : {}),
                    ...(toolInfo.output !== undefined ? { output: toolInfo.output } : {}),
                    ...(toolInfo.error !== undefined ? { error: toolInfo.error } : {}),
                  },
                }
                const previousState = context.toolStepStates.get(stepIndex)
                if (stepState === 'DONE')
                {
                  if (previousState === undefined)
                  {
                    yield* emit(
                      context.binding,
                      'item.started',
                      { ...payload, status: 'inProgress' },
                      turnId,
                      { itemId, raw },
                    )
                  }
                  if (previousState !== 'completed')
                  {
                    yield* emit(context.binding, 'item.completed', payload, turnId, { itemId, raw })
                    context.toolStepStates.set(stepIndex, 'completed')
                  }
                }
                else if (previousState === undefined)
                {
                  yield* emit(context.binding, 'item.started', payload, turnId, { itemId, raw })
                  context.toolStepStates.set(stepIndex, 'started')
                }
                else if (previousState === 'started')
                {
                  yield* emit(context.binding, 'item.updated', payload, turnId, { itemId, raw })
                }
              }
              if (stepType === 'checkpoint' && stepState === 'DONE')
              {
                const itemId = RuntimeItemId.make(
                  `antigravity:${conversationId}:${turnId}:${stepIndex}`,
                )
                if (context.toolStepStates.get(stepIndex) !== 'completed')
                {
                  yield* emit(
                    context.binding,
                    'item.started',
                    {
                      itemType: 'unknown',
                      status: 'inProgress',
                      title: 'Antigravity checkpoint',
                      data: step,
                    },
                    turnId,
                    { itemId, raw },
                  )
                  yield* emit(
                    context.binding,
                    'item.completed',
                    {
                      itemType: 'unknown',
                      status: 'completed',
                      title: 'Antigravity checkpoint',
                      data: step,
                    },
                    turnId,
                    { itemId, raw },
                  )
                  context.toolStepStates.set(stepIndex, 'completed')
                }
              }
              if (stepType && !MAPPED_STEP_TYPES.has(stepType))
              {
                const itemId = RuntimeItemId.make(
                  `antigravity:${conversationId}:${turnId}:${stepIndex}`,
                )
                const previousState = context.toolStepStates.get(stepIndex)
                const title = `Antigravity ${stepType.replaceAll('_', ' ')}`
                if (previousState === undefined)
                {
                  yield* emit(
                    context.binding,
                    'item.started',
                    { itemType: 'unknown', status: 'inProgress', title, data: step },
                    turnId,
                    { itemId, raw },
                  )
                  context.toolStepStates.set(stepIndex, 'started')
                }
                if (stepState === 'DONE' && previousState !== 'completed')
                {
                  yield* emit(
                    context.binding,
                    'item.completed',
                    { itemType: 'unknown', status: 'completed', title, data: step },
                    turnId,
                    { itemId, raw },
                  )
                  context.toolStepStates.set(stepIndex, 'completed')
                }
              }
              const subagentInfo = isRecord(step.subagent_info) ? step.subagent_info : undefined
              const subagents = Array.isArray(subagentInfo?.subagents)
                ? subagentInfo.subagents.filter(isRecord)
                : []
              for (const [index, subagent] of subagents.entries())
              {
                const providerTaskId =
                  nonEmptyString(subagent.conversation_id) ??
                  `${conversationId}:${stepIndex}:${index}`
                const description =
                  nonEmptyString(subagent.role) ??
                  nonEmptyString(subagent.type_name) ??
                  'Antigravity delegated agent'
                const taskId = RuntimeTaskId.make(`antigravity:${providerTaskId}`)
                const subagentType = nonEmptyString(subagent.type_name)
                const previousState = context.subagentTaskStates.get(providerTaskId)
                if (previousState === undefined)
                {
                  yield* emit(
                    context.binding,
                    'task.started',
                    {
                      taskId,
                      description,
                      ...(subagentType ? { subagentType } : {}),
                    },
                    turnId,
                    { raw },
                  )
                  context.subagentTaskStates.set(providerTaskId, 'started')
                }
                yield* emit(
                  context.binding,
                  'task.progress',
                  {
                    taskId,
                    description,
                    ...(subagentType ? { subagentType } : {}),
                    summary:
                      stepState === 'DONE'
                        ? 'Delegated agent update completed.'
                        : 'Delegated agent is running.',
                  },
                  turnId,
                  { raw },
                )
                if (stepState === 'DONE' && previousState !== 'completed')
                {
                  yield* emit(
                    context.binding,
                    'task.completed',
                    {
                      taskId,
                      status: 'completed',
                      summary: 'Delegated agent update completed.',
                      ...(subagentType ? { subagentType } : {}),
                    },
                    turnId,
                    { raw },
                  )
                  context.subagentTaskStates.set(providerTaskId, 'completed')
                }
              }
            }
          }),
        ).pipe(Effect.ignoreCause, Effect.forkDetach)
        yield* emit(context.binding, 'session.started', { resume: { conversationId } })
        yield* emit(context.binding, 'session.state.changed', { state: 'ready' })
        yield* emit(context.binding, 'thread.started', { providerThreadId: conversationId })
        if (continuationIssue !== undefined)
        {
          yield* emit(context.binding, 'runtime.warning', {
            message: `${continuationIssue} Started a fresh Antigravity conversation instead.`,
            detail: { continuation: 'fresh-session' },
          })
        }
        return session
      }),
    )

  const sendTurn: AntigravityAdapterShape['sendTurn'] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* ()
      {
        const context = sessions.get(input.threadId)
        if (!context || context.stopped) return yield* fail('sendTurn', 'Session is not active.')
        if (context.activeTurnId !== undefined)
        {
          return yield* fail('sendTurn', 'Antigravity does not support an active second turn.')
        }
        if (!(yield* context.runtime.isLive))
        {
          return yield* fail('sendTurn', 'Antigravity session is recovering or exited.')
        }
        if ((input.attachments?.length ?? 0) > 0)
        {
          return yield* fail('sendTurn', 'Antigravity supports text input only.')
        }
        if (input.interactionMode !== undefined && input.interactionMode !== 'default')
        {
          return yield* fail('sendTurn', 'Antigravity does not support plan mode switching.')
        }
        const text = input.input?.trim()
        if (!text) return yield* fail('sendTurn', 'Antigravity turns require non-empty text.')
        if (
          input.modelSelection?.instanceId !== undefined &&
          input.modelSelection.instanceId !== instanceId
        )
        {
          return yield* fail(
            'sendTurn',
            `Model selection is bound to '${input.modelSelection.instanceId}'.`,
          )
        }
        if (input.modelSelection?.model && input.modelSelection.model !== context.session.model)
        {
          return yield* fail('sendTurn', 'Antigravity model changes require a new session.')
        }
        const turnId = TurnId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie))
        context.activeTurnId = turnId
        context.activeTurnInput = text
        context.sawResponseDelta = false
        context.toolStepStates.clear()
        context.subagentTaskStates.clear()
        context.session = {
          ...context.session,
          status: 'running',
          activeTurnId: turnId,
          updatedAt: yield* now,
        }
        yield* emit(
          context.binding,
          'turn.started',
          context.session.model ? { model: context.session.model } : {},
          turnId,
        )
        context.turnFiber = yield* context.runtime.sendTurn(text).pipe(
          Effect.flatMap((result) =>
            isRecord(result.raw.result)
              ? Effect.void
              : withThreadLock(context.threadId, finalizeTurn(context, turnId, text, result)),
          ),
          Effect.catchCause((cause) =>
          {
            const error = Cause.pretty(cause)
            return withThreadLock(
              context.threadId,
              finalizeTurn(context, turnId, text, {
                status: 'ERROR',
                response: '',
                error,
                raw: { event: 'result', error },
              }),
            )
          }),
          Effect.forkIn(scope),
        )
        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: context.session.resumeCursor,
        }
      }),
    )

  function stopContext(context: AntigravitySessionContext): Effect.Effect<void>
  {
    return Effect.gen(function* ()
    {
      if (context.stopped) return
      context.stopped = true
      if (context.turnFiber) yield* Fiber.interrupt(context.turnFiber).pipe(Effect.ignore)
      if (context.eventFiber) yield* Fiber.interrupt(context.eventFiber).pipe(Effect.ignore)
      yield* context.runtime.close
      sessions.delete(context.threadId)
      yield* emit(context.binding, 'session.exited', {
        reason: 'Antigravity session stopped.',
        exitKind: 'graceful',
        recoverable: true,
      })
    })
  }

  const waitForRuntimeLive = (runtime: AntigravitySessionRuntimeShape) =>
    Effect.gen(function* ()
    {
      for (let attempt = 0; attempt < 600; attempt += 1)
      {
        if (yield* runtime.isLive) return true
        yield* Effect.sleep('50 millis')
      }
      return false
    })

  return {
    provider: PROVIDER,
    capabilities: ANTIGRAVITY_PROVIDER_CAPABILITIES,
    startSession,
    sendTurn,
    interruptTurn: (threadId, requestedTurnId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* ()
        {
          const context = sessions.get(threadId)
          if (!context || context.activeTurnId === undefined) return
          if (requestedTurnId !== undefined && requestedTurnId !== context.activeTurnId) return
          const turnId = context.activeTurnId
          context.finalizedTurnIds.add(turnId)
          yield* context.runtime.interrupt
          const runtimeLive = yield* waitForRuntimeLive(context.runtime)
          context.activeTurnId = undefined
          context.activeTurnInput = undefined
          context.turnFiber = undefined
          const { activeTurnId: _activeTurnId, ...settledSession } = context.session
          context.session = {
            ...settledSession,
            status: runtimeLive ? 'ready' : 'error',
            updatedAt: yield* now,
          }
          yield* emit(
            context.binding,
            'turn.completed',
            { state: 'interrupted', stopReason: 'SIGINT' },
            turnId,
          )
          if (!runtimeLive)
          {
            yield* emit(
              context.binding,
              'runtime.error',
              {
                message: 'Antigravity could not recover after interruption.',
                class: 'transport_error',
                detail: { recoverable: false },
              },
              turnId,
            )
          }
        }),
      ),
    respondToRequest: () => fail('respondToRequest', 'Antigravity does not support approvals.'),
    respondToUserInput: () =>
      fail('respondToUserInput', 'Antigravity does not support structured input.'),
    stopSession: (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* ()
        {
          const context = sessions.get(threadId)
          if (context) yield* stopContext(context)
        }),
      ),
    listSessions: () =>
      Effect.succeed(Array.from(sessions.values(), (context) => ({ ...context.session }))),
    hasSession: (threadId) =>
      Effect.gen(function* ()
      {
        const context = sessions.get(threadId)
        return context !== undefined && !context.stopped && (yield* context.runtime.isLive)
      }),
    getSessionRuntimeBinding: (threadId) => Effect.succeed(sessions.get(threadId)?.binding),
    readThread: (threadId) =>
      Effect.succeed({ threadId, turns: sessions.get(threadId)?.turns ?? [] }),
    rollbackThread: () =>
      fail('rollbackThread', 'Antigravity conversation rollback is unsupported.'),
    stopAll: () =>
      Effect.forEach(
        Array.from(sessions.values()),
        (context) => withThreadLock(context.threadId, stopContext(context)),
        { discard: true },
      ),
    streamEvents: Stream.fromPubSub(events),
  } satisfies AntigravityAdapterShape
})
