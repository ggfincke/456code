// apps/server/src/provider/Layers/EventNdjsonLogger.ts
// batches provider events into shared rotating thread log sinks

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'

import type { ThreadId } from '@t3tools/contracts'
import { RotatingFileSink } from '@t3tools/shared/logging'
import { errorTag } from '@t3tools/shared/observability'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Queue from 'effect/Queue'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'
import * as SynchronizedRef from 'effect/SynchronizedRef'

import { toSafeThreadAttachmentSegment } from '../../attachments/attachmentStore.ts'

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024
const DEFAULT_MAX_FILES = 10
const DEFAULT_BATCH_WINDOW_MS = 200
const DEFAULT_BATCH_SIZE = 128
const DEFAULT_BUFFER_CAPACITY = 1_024
const GLOBAL_THREAD_SEGMENT = '_global'
const LOG_SCOPE = 'provider-observability'
const encodeUnknownJsonString = Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)

export type EventNdjsonStream = 'native' | 'canonical' | 'orchestration'

export interface EventNdjsonLogger
{
  readonly filePath: string
  write: (event: unknown, threadId: ThreadId | null) => Effect.Effect<void, never, never>
  close: () => Effect.Effect<void, never, never>
}

export interface EventNdjsonLoggerOptions
{
  readonly stream: EventNdjsonStream
  readonly maxBytes?: number
  readonly maxFiles?: number
  readonly batchWindowMs?: number
  readonly batchSize?: number
}

interface ThreadWriter
{
  writeLine: (line: string) => Effect.Effect<void>
  close: () => Effect.Effect<void>
}

interface LoggerState
{
  readonly threadWriters: Map<string, ThreadWriter>
  readonly failedSegments: Set<string>
}

interface EventNdjsonSinkOwner
{
  writeLine: (line: string, threadId: ThreadId | null) => Effect.Effect<void>
  close: () => Effect.Effect<void>
}

export interface ProviderEventNdjsonLoggers
{
  readonly native: EventNdjsonLogger
  readonly canonical: EventNdjsonLogger
  close: () => Effect.Effect<void, never, never>
}

function logWarning(message: string, context: Record<string, unknown>): Effect.Effect<void>
{
  return Effect.logWarning(message, context).pipe(Effect.annotateLogs({ scope: LOG_SCOPE }))
}

function resolveThreadSegment(raw: string | null | undefined): string
{
  const normalized = typeof raw === 'string' ? toSafeThreadAttachmentSegment(raw) : null
  return normalized ?? GLOBAL_THREAD_SEGMENT
}

function formatLogLine(observedAt: string, streamLabel: string, message: string): string
{
  return `[${observedAt}] ${streamLabel}: ${message}\n`
}

function makeBatchedChunks(lines: ReadonlyArray<string>, maxBytes: number): Array<string>
{
  const chunks = new Array<string>()
  let current = new Array<string>()
  let currentBytes = 0

  for (const line of lines)
  {
    const lineBytes = Buffer.byteLength(line)
    if (currentBytes > 0 && currentBytes + lineBytes > maxBytes)
    {
      chunks.push(current.join(''))
      current = []
      currentBytes = 0
    }
    current.push(line)
    currentBytes += lineBytes
  }

  if (currentBytes > 0)
  {
    chunks.push(current.join(''))
  }
  return chunks
}

function resolveStreamLabel(stream: EventNdjsonStream): string
{
  switch (stream)
  {
    case 'native':
      return 'NTIVE'
    case 'canonical':
    case 'orchestration':
    default:
      return 'CANON'
  }
}

const toLogMessage = Effect.fn('toLogMessage')(function* (
  event: unknown,
): Effect.fn.Return<string | undefined>
{
  return yield* encodeUnknownJsonString(event).pipe(
    Effect.catch((error) =>
      logWarning('failed to serialize provider event log record', {
        errorTag: errorTag(error),
      }).pipe(Effect.as(undefined)),
    ),
  )
})

const makeThreadWriter = Effect.fn('makeThreadWriter')(function* (input: {
  readonly filePath: string
  readonly maxBytes: number
  readonly maxFiles: number
  readonly batchWindowMs: number
  readonly batchSize: number
}): Effect.fn.Return<ThreadWriter | undefined>
{
  const sinkResult = yield* Effect.sync(() =>
  {
    try
    {
      return {
        ok: true as const,
        sink: new RotatingFileSink({
          filePath: input.filePath,
          maxBytes: input.maxBytes,
          maxFiles: input.maxFiles,
          throwOnError: true,
        }),
      }
    }
    catch (error)
    {
      return { ok: false as const, error }
    }
  })

  if (!sinkResult.ok)
  {
    yield* logWarning('failed to initialize provider thread log file', {
      filePath: input.filePath,
      errorTag: errorTag(sinkResult.error),
    })
    return undefined
  }

  const sink = sinkResult.sink
  const messages = yield* Queue.bounded<string>(Math.max(DEFAULT_BUFFER_CAPACITY, input.batchSize))
  const flushRequests = yield* Queue.dropping<void>(1)
  const scope = yield* Scope.make()
  const flush = Effect.fn('makeThreadWriter.flush')(function* ()
  {
    const batch = yield* Queue.clear(messages)
    if (batch.length === 0)
    {
      return
    }

    const flushResult = yield* Effect.sync(() =>
    {
      try
      {
        for (const chunk of makeBatchedChunks(batch, input.maxBytes))
        {
          sink.write(chunk)
        }
        return { ok: true as const }
      }
      catch (error)
      {
        return { ok: false as const, error }
      }
    })

    if (!flushResult.ok)
    {
      yield* logWarning('provider event log batch flush failed', {
        filePath: input.filePath,
        errorTag: errorTag(flushResult.error),
      })
    }
  })

  yield* Queue.take(flushRequests).pipe(
    Effect.andThen(flush),
    Effect.forever,
    Effect.forkIn(scope, { startImmediately: true }),
  )
  yield* Effect.sleep(input.batchWindowMs).pipe(
    Effect.andThen(Queue.offer(flushRequests, undefined)),
    Effect.forever,
    Effect.forkIn(scope),
  )

  return {
    writeLine: Effect.fn('ThreadWriter.writeLine')(function* (line: string)
    {
      const accepted = yield* Queue.offer(messages, line)
      if (!accepted)
      {
        return
      }

      const buffered = yield* Queue.size(messages)
      if (buffered >= input.batchSize)
      {
        yield* Queue.offer(flushRequests, undefined)
      }
    }),
    close: Effect.fn('ThreadWriter.close')(function* ()
    {
      yield* Scope.close(scope, Exit.void)
      yield* flush()
      yield* Queue.shutdown(messages)
      yield* Queue.shutdown(flushRequests)
    }),
  } satisfies ThreadWriter
})

const makeEventNdjsonSinkOwner = Effect.fn('makeEventNdjsonSinkOwner')(function* (
  filePath: string,
  options: Omit<EventNdjsonLoggerOptions, 'stream'>,
): Effect.fn.Return<EventNdjsonSinkOwner | undefined>
{
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
  const batchWindowMs = options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE

  const directoryReady = yield* Effect.sync(() =>
  {
    try
    {
      NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true })
      return true
    }
    catch (error)
    {
      return { ok: false as const, error }
    }
  })
  if (directoryReady !== true)
  {
    yield* logWarning('failed to create provider event log directory', {
      filePath,
      errorTag: errorTag(directoryReady.error),
    })
    return undefined
  }

  const stateRef = yield* SynchronizedRef.make<LoggerState>({
    threadWriters: new Map(),
    failedSegments: new Set(),
  })

  const resolveThreadWriter = Effect.fn('resolveThreadWriter')(function* (
    threadSegment: string,
  ): Effect.fn.Return<ThreadWriter | undefined>
  {
    return yield* SynchronizedRef.modifyEffect(stateRef, (state) =>
    {
      if (state.failedSegments.has(threadSegment))
      {
        return Effect.succeed([undefined, state] as const)
      }

      const existing = state.threadWriters.get(threadSegment)
      if (existing)
      {
        return Effect.succeed([existing, state] as const)
      }

      return makeThreadWriter({
        filePath: NodePath.join(NodePath.dirname(filePath), `${threadSegment}.log`),
        maxBytes,
        maxFiles,
        batchWindowMs,
        batchSize,
      }).pipe(
        Effect.map((writer) =>
        {
          if (!writer)
          {
            const nextFailedSegments = new Set(state.failedSegments)
            nextFailedSegments.add(threadSegment)
            return [
              undefined,
              {
                ...state,
                failedSegments: nextFailedSegments,
              },
            ] as const
          }

          const nextThreadWriters = new Map(state.threadWriters)
          nextThreadWriters.set(threadSegment, writer)
          return [
            writer,
            {
              ...state,
              threadWriters: nextThreadWriters,
            },
          ] as const
        }),
      )
    })
  })

  const writeLine = Effect.fn('writeLine')(function* (line: string, threadId: ThreadId | null)
  {
    const writer = yield* resolveThreadWriter(resolveThreadSegment(threadId))
    if (writer)
    {
      yield* writer.writeLine(line)
    }
  })

  const close = Effect.fn('close')(function* ()
  {
    yield* SynchronizedRef.modifyEffect(stateRef, (state) =>
      Effect.gen(function* ()
      {
        for (const writer of state.threadWriters.values())
        {
          yield* writer.close()
        }

        return [
          undefined,
          {
            threadWriters: new Map<string, ThreadWriter>(),
            failedSegments: new Set<string>(),
          },
        ] as const
      }),
    )
  })

  return { writeLine, close }
})

function makeLogger(
  filePath: string,
  stream: EventNdjsonStream,
  owner: EventNdjsonSinkOwner,
): EventNdjsonLogger
{
  const streamLabel = resolveStreamLabel(stream)
  const write = Effect.fn('write')(function* (event: unknown, threadId: ThreadId | null)
  {
    const message = yield* toLogMessage(event)
    if (message !== undefined)
    {
      const observedAt = DateTime.formatIso(yield* DateTime.now)
      yield* owner.writeLine(formatLogLine(observedAt, streamLabel, message), threadId)
    }
  })

  return {
    filePath,
    write,
    close: owner.close,
  }
}

export const makeEventNdjsonLogger = Effect.fn('makeEventNdjsonLogger')(function* (
  filePath: string,
  options: EventNdjsonLoggerOptions,
): Effect.fn.Return<EventNdjsonLogger | undefined>
{
  const owner = yield* makeEventNdjsonSinkOwner(filePath, options)
  return owner ? makeLogger(filePath, options.stream, owner) : undefined
})

export const makeProviderEventNdjsonLoggers = Effect.fn('makeProviderEventNdjsonLoggers')(
  function* (
    filePath: string,
    options: Omit<EventNdjsonLoggerOptions, 'stream'> = {},
  ): Effect.fn.Return<ProviderEventNdjsonLoggers | undefined>
  {
    const owner = yield* makeEventNdjsonSinkOwner(filePath, options)
    if (!owner)
    {
      return undefined
    }

    return {
      native: makeLogger(filePath, 'native', owner),
      canonical: makeLogger(filePath, 'canonical', owner),
      close: owner.close,
    }
  },
)
