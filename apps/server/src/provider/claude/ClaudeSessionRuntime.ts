// apps/server/src/provider/claude/ClaudeSessionRuntime.ts
// constructs and closes bounded Claude SDK query resources

import {
  type Options as ClaudeQueryOptions,
  type PermissionMode,
  query,
  type SDKControlGetContextUsageResponse,
  type SDKControlInterruptResponse,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { ProviderDriverKind, type ThreadId } from '@t3tools/contracts'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Queue from 'effect/Queue'
import * as Stream from 'effect/Stream'

import { ProviderAdapterProcessError } from '../Errors.ts'

const PROVIDER = ProviderDriverKind.make('claudeAgent')

export type PromptQueueItem =
  | {
      readonly type: 'message'
      readonly message: SDKUserMessage
    }
  | {
      readonly type: 'terminate'
    }

export interface ClaudeQueryRuntime extends AsyncIterable<SDKMessage>
{
  readonly interrupt: () => Promise<void | SDKControlInterruptResponse>
  readonly setModel: (model?: string) => Promise<void>
  readonly setPermissionMode: (mode: PermissionMode) => Promise<void>
  readonly setMaxThinkingTokens: (maxThinkingTokens: number | null) => Promise<void>
  readonly initializationResult: () => Promise<unknown>
  readonly getContextUsage?: () => Promise<SDKControlGetContextUsageResponse>
  readonly close: () => void
}

export type ClaudeQueryFactory = (input: {
  readonly prompt: AsyncIterable<SDKUserMessage>
  readonly options: ClaudeQueryOptions
}) => ClaudeQueryRuntime

const defaultClaudeQueryFactory: ClaudeQueryFactory = (input) =>
  query({
    prompt: input.prompt,
    options: input.options,
  })

export const makeClaudePromptChannel = Effect.fn('makeClaudePromptChannel')(function* ()
{
  const promptQueue = yield* Queue.unbounded<PromptQueueItem>()
  const prompt = Stream.fromQueue(promptQueue).pipe(
    Stream.filter((item) => item.type === 'message'),
    Stream.map((item) => item.message),
    Stream.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause) ? Stream.empty : Stream.failCause(cause),
    ),
    Stream.toAsyncIterable,
  )
  return { promptQueue, prompt }
})

export const createClaudeQuery = Effect.fn('createClaudeQuery')(function* (
  threadId: ThreadId,
  prompt: AsyncIterable<SDKUserMessage>,
  options: ClaudeQueryOptions,
  failureDetail: string,
  createQuery?: ClaudeQueryFactory,
)
{
  return yield* Effect.try({
    try: () => (createQuery ?? defaultClaudeQueryFactory)({ prompt, options }),
    catch: (cause) =>
      new ProviderAdapterProcessError({
        provider: PROVIDER,
        threadId,
        detail: failureDetail,
        cause,
      }),
  })
})

export const awaitClaudeQueryInitialization = Effect.fn('awaitClaudeQueryInitialization')(
  function* (threadId: ThreadId, queryRuntime: ClaudeQueryRuntime)
  {
    yield* Effect.tryPromise({
      try: () => queryRuntime.initializationResult(),
      catch: (cause) =>
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId,
          detail: 'Failed to initialize Claude runtime session.',
          cause,
        }),
    })
  },
)

export const closeClaudeQueryResources = Effect.fn('closeClaudeQueryResources')(function* (
  threadId: ThreadId,
  promptQueue: Queue.Queue<PromptQueueItem>,
  streamFiber: Fiber.Fiber<void, never> | undefined,
  queryRuntime: ClaudeQueryRuntime,
  failureDetail: string,
)
{
  yield* Queue.shutdown(promptQueue)
  if (streamFiber && streamFiber.pollUnsafe() === undefined)
  {
    yield* Fiber.interrupt(streamFiber)
  }
  yield* Effect.try({
    try: () => queryRuntime.close(),
    catch: (cause) =>
      new ProviderAdapterProcessError({
        provider: PROVIDER,
        threadId,
        detail: failureDetail,
        cause,
      }),
  })
})
