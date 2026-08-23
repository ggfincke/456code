// apps/server/src/provider/antigravity/AntigravitySessionRuntime.ts
// own one persistent antigravity stream-json child

import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Option from 'effect/Option'
import * as PubSub from 'effect/PubSub'
import * as Ref from 'effect/Ref'
import * as Scope from 'effect/Scope'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'
import { resolveSpawnCommand } from '@t3tools/shared/shell'
class AntigravityRuntimeError extends Schema.TaggedErrorClass<AntigravityRuntimeError>()(
  'AntigravityRuntimeError',
  { detail: Schema.String },
)
{}

import {
  buildAntigravityLaunchArgs,
  conversationIdFromStreamMessage,
  parseAntigravityStreamLine,
  resultErrorFromStreamMessage,
  resultResponseFromStreamMessage,
  resultStatusFromStreamMessage,
  type AntigravityRuntimeMode,
  type AntigravityResumeCursor,
  type AntigravityStreamMessage,
} from './AntigravityCli.ts'

export interface AntigravitySessionRuntimeOptions
{
  readonly binaryPath: string
  readonly environment?: NodeJS.ProcessEnv
  readonly cwd: string
  readonly runtimeMode: AntigravityRuntimeMode
  readonly model?: string
  readonly agent?: string
  readonly sandbox: boolean
  readonly resumeCursor?: AntigravityResumeCursor
}

export interface AntigravityResult
{
  readonly conversationId?: string
  readonly status: string
  readonly response: string
  readonly error?: string
  readonly raw: Record<string, unknown>
}

export interface AntigravitySessionRuntimeShape
{
  readonly conversationId: Effect.Effect<string>
  readonly isLive: Effect.Effect<boolean>
  readonly events: Stream.Stream<AntigravityStreamMessage>
  readonly sendTurn: (text: string) => Effect.Effect<AntigravityResult>
  readonly interrupt: Effect.Effect<void>
  readonly close: Effect.Effect<void>
}

const START_TIMEOUT = '30 seconds' as const
const TURN_TIMEOUT = '5 minutes' as const
const MAX_STDOUT_LINE_BYTES = 2 * 1024 * 1024
const MAX_STDERR_BYTES = 128 * 1024

function boundedUtf8Tail(value: string, maxBytes: number): string
{
  const bytes = Buffer.from(value)
  return bytes.byteLength <= maxBytes
    ? value
    : bytes.subarray(bytes.byteLength - maxBytes).toString('utf8')
}

function resultForError(error: string): AntigravityResult
{
  return { status: 'ERROR', response: '', error, raw: { event: 'result', error } }
}

export const makeAntigravitySessionRuntime = Effect.fn('makeAntigravitySessionRuntime')(function* (
  options: AntigravitySessionRuntimeOptions,
): Effect.fn.Return<
  AntigravitySessionRuntimeShape,
  AntigravityRuntimeError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
>
{
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const runtimeScope = yield* Scope.Scope
  const events = yield* PubSub.unbounded<AntigravityStreamMessage>()
  const initialInit = yield* Deferred.make<string>()
  const initRef = yield* Ref.make(initialInit)
  const initialFailure = yield* Deferred.make<string>()
  const startupFailureRef = yield* Ref.make(initialFailure)
  const closed = yield* Ref.make(false)
  const live = yield* Ref.make(false)
  const shutdownRequested = yield* Ref.make(false)
  const stderrTail = yield* Ref.make('')
  const pendingResult = yield* Ref.make<Deferred.Deferred<Record<string, unknown>> | undefined>(
    undefined,
  )
  const childRef = yield* Ref.make<ChildProcessSpawner.ChildProcessHandle | undefined>(undefined)
  const readerFibersRef = yield* Ref.make<ReadonlyArray<Fiber.Fiber<void, unknown>>>([])
  const monitorFiberRef = yield* Ref.make<Fiber.Fiber<void, unknown> | undefined>(undefined)
  const conversationRef = yield* Ref.make<string | undefined>(options.resumeCursor?.conversationId)
  const expectedInit = yield* Ref.make(false)
  const respawnAllowance = yield* Ref.make(1)
  const recoveryInFlight = yield* Ref.make(false)
  const interruptInFlight = yield* Ref.make(false)

  let stdoutRemainder = ''
  const detailWithStderr = (detail: string) =>
    Ref.get(stderrTail).pipe(
      Effect.map((tail) => (tail.length > 0 ? `${detail} Stderr tail: ${tail}` : detail)),
    )
  const failRuntime = (detail: string) =>
    detailWithStderr(detail).pipe(
      Effect.flatMap((message) => Effect.fail(new AntigravityRuntimeError({ detail: message }))),
    )
  const failPending = (detail: string) =>
    Effect.gen(function* ()
    {
      const pending = yield* Ref.get(pendingResult)
      if (pending)
      {
        const message = yield* detailWithStderr(detail)
        yield* Deferred.succeed(pending, resultForError(message).raw)
        yield* Ref.set(pendingResult, undefined)
      }
    })
  const failStartup = (detail: string) =>
    Effect.gen(function* ()
    {
      const detailed = yield* detailWithStderr(detail)
      const startupFailure = yield* Ref.get(startupFailureRef)
      yield* Deferred.succeed(startupFailure, detailed)
      yield* Ref.set(expectedInit, false)
      yield* Ref.set(live, false)
      yield* failPending(detailed)
      const child = yield* Ref.get(childRef)
      if (child)
        yield* child
          .kill({ killSignal: 'SIGTERM', forceKillAfter: '2 seconds' })
          .pipe(Effect.ignore)
      return yield* new AntigravityRuntimeError({ detail: detailed })
    })
  const messageConversationId = (message: AntigravityStreamMessage): string | undefined =>
  {
    const direct = message.value.conversation_id
    if (typeof direct === 'string' && direct.trim()) return direct.trim()
    for (const key of ['result', 'step_update'] as const)
    {
      const nested = message.value[key]
      if (nested && typeof nested === 'object' && !Array.isArray(nested))
      {
        const conversationId = (nested as Record<string, unknown>).conversation_id
        if (typeof conversationId === 'string' && conversationId.trim())
          return conversationId.trim()
      }
    }
    return undefined
  }
  const processMessage = (message: AntigravityStreamMessage) =>
    Effect.gen(function* ()
    {
      if (message.kind === 'init')
      {
        if (!(yield* Ref.getAndSet(expectedInit, false)))
        {
          yield* failPending('Antigravity emitted a second initialization event.')
          return yield* failRuntime('Antigravity emitted a second initialization event.')
        }
        const conversationId = conversationIdFromStreamMessage(message.value)
        if (conversationId)
        {
          const established = yield* Ref.get(conversationRef)
          if (established && established !== conversationId)
          {
            return yield* failStartup(
              `Antigravity emitted conversation id '${conversationId}' instead of '${established}'.`,
            )
          }
          yield* Ref.set(conversationRef, conversationId)
          const init = yield* Ref.get(initRef)
          yield* Deferred.succeed(init, conversationId)
        }
        yield* PubSub.publish(events, message)
        return
      }
      if ((yield* Ref.get(expectedInit)) && message.kind === 'result')
      {
        const status = resultStatusFromStreamMessage(message.value)
        const detail =
          resultErrorFromStreamMessage(message.value)?.trim() ||
          resultResponseFromStreamMessage(message.value).trim() ||
          `Antigravity returned terminal status '${status}' before initialization.`
        return yield* failStartup(
          status === 'ERROR' || status === 'INVALID'
            ? `Antigravity failed before initialization: ${detail}`
            : `Antigravity returned terminal status '${status}' before initialization: ${detail}`,
        )
      }
      const established = yield* Ref.get(conversationRef)
      const emittedConversationId = messageConversationId(message)
      const allowsMissingErrorConversationId =
        message.kind === 'result' &&
        ['ERROR', 'INVALID'].includes(resultStatusFromStreamMessage(message.value)) &&
        emittedConversationId === undefined
      if (
        established &&
        !allowsMissingErrorConversationId &&
        emittedConversationId !== established
      )
      {
        yield* failPending(
          `Antigravity emitted conversation id '${emittedConversationId ?? 'missing'}' instead of '${established}'.`,
        )
        return yield* failRuntime(
          `Antigravity emitted conversation id '${emittedConversationId ?? 'missing'}' instead of '${established}'.`,
        )
      }
      if (message.kind === 'result')
      {
        const pending = yield* Ref.get(pendingResult)
        if (!pending)
        {
          return yield* failRuntime('Antigravity emitted a result without an active turn.')
        }
        yield* PubSub.publish(events, message)
        if (!(yield* Deferred.succeed(pending, message.value)))
        {
          return yield* failRuntime('Antigravity emitted more than one result for a turn.')
        }
        return
      }
      yield* PubSub.publish(events, message)
    })

  const processStdoutChunk = (chunk: string) =>
    Effect.sync(() =>
    {
      stdoutRemainder += chunk
      const lines = stdoutRemainder.split(/\r?\n/)
      stdoutRemainder = lines.pop() ?? ''
      const oversized =
        Buffer.byteLength(stdoutRemainder) > MAX_STDOUT_LINE_BYTES ||
        lines.some((line) => Buffer.byteLength(line) > MAX_STDOUT_LINE_BYTES)
      return { lines, oversized }
    }).pipe(
      Effect.flatMap(({ lines, oversized }) =>
        oversized
          ? failRuntime('Antigravity stdout exceeded the 2 MiB per-line limit.')
          : Effect.succeed(lines),
      ),
      Effect.flatMap((lines) =>
        Effect.forEach(
          lines,
          (line) =>
          {
            const parsed = parseAntigravityStreamLine(line)
            if (parsed.kind === 'known') return processMessage(parsed.message)
            if (parsed.kind === 'unknown')
            {
              return Effect.logDebug('Ignored unknown Antigravity stream event.', {
                event: parsed.event,
              })
            }
            return failPending(`Antigravity emitted malformed stream JSON: ${parsed.detail}`).pipe(
              Effect.andThen(Effect.fail(new AntigravityRuntimeError({ detail: parsed.detail }))),
            )
          },
          { discard: true },
        ),
      ),
    )

  let spawnChildRaw: (
    conversationId: string | undefined,
    retrySpawn: boolean,
  ) => Effect.Effect<ChildProcessSpawner.ChildProcessHandle, AntigravityRuntimeError, never>
  const spawnChild = (conversationId: string | undefined, retrySpawn: boolean) =>
    spawnChildRaw(conversationId, retrySpawn).pipe(Effect.result)
  const interruptReaderFibers = Effect.gen(function* ()
  {
    const fibers = yield* Ref.getAndSet(readerFibersRef, [])
    yield* Effect.forEach(fibers, (fiber) => Fiber.interrupt(fiber).pipe(Effect.ignore), {
      discard: true,
    })
  })
  const interruptMonitor = Effect.gen(function* ()
  {
    const monitor = yield* Ref.getAndSet(monitorFiberRef, undefined)
    if (monitor) yield* Fiber.interrupt(monitor).pipe(Effect.ignore)
  })
  const interruptReaders = Effect.gen(function* ()
  {
    yield* interruptReaderFibers
    yield* interruptMonitor
  })
  const gracefulCloseChild = (child: ChildProcessSpawner.ChildProcessHandle) =>
    Effect.gen(function* ()
    {
      yield* Stream.run(Stream.empty, child.stdin).pipe(Effect.ignore)
      const exited = yield* child.exitCode.pipe(Effect.timeoutOption('2 seconds'))
      if (exited._tag === 'None')
      {
        const running = yield* child.isRunning.pipe(Effect.orElseSucceed(() => false))
        if (running)
        {
          yield* child
            .kill({ killSignal: 'SIGTERM', forceKillAfter: '2 seconds' })
            .pipe(Effect.ignore)
        }
      }
    }).pipe(Effect.ignoreCause)
  const completePending = (pending: Deferred.Deferred<Record<string, unknown>>, detail: string) =>
    detailWithStderr(detail).pipe(
      Effect.flatMap((message) => Deferred.succeed(pending, resultForError(message).raw)),
    )
  const recoverChild = (
    conversationId: string | undefined,
    pending: Deferred.Deferred<Record<string, unknown>> | undefined,
  ) =>
    Effect.gen(function* ()
    {
      const allowance = yield* Ref.getAndSet(respawnAllowance, 0)
      if (allowance <= 0)
      {
        yield* Ref.set(childRef, undefined)
        yield* Ref.set(live, false)
        if (pending)
          yield* completePending(
            pending,
            'Antigravity child exited during a turn; recovery was already exhausted.',
          )
        return false
      }
      if (!conversationId)
      {
        yield* Ref.set(childRef, undefined)
        yield* Ref.set(live, false)
        if (pending)
          yield* completePending(
            pending,
            'Antigravity exited before establishing a conversation id.',
          )
        return false
      }
      const nextInit = yield* Deferred.make<string>()
      yield* Ref.set(initRef, nextInit)
      const restarted = yield* spawnChild(conversationId, false)
      if (restarted._tag === 'Failure')
      {
        yield* Ref.set(childRef, undefined)
        yield* Ref.set(live, false)
        if (pending)
          yield* completePending(
            pending,
            'Antigravity child exited during a turn and could not be respawned.',
          )
        return false
      }
      if ((yield* Ref.get(shutdownRequested)) || (yield* Ref.get(closed)))
      {
        yield* Ref.set(childRef, undefined)
        yield* Ref.set(live, false)
        yield* gracefulCloseChild(restarted.success)
        return false
      }
      const restartFailure = yield* Ref.get(startupFailureRef)
      const restartResult = yield* Effect.race(
        Deferred.await(nextInit).pipe(Effect.map((id) => ({ _tag: 'initialized' as const, id }))),
        Deferred.await(restartFailure).pipe(
          Effect.map((detail) => ({ _tag: 'failed' as const, detail })),
        ),
      ).pipe(Effect.timeoutOption(START_TIMEOUT))
      if (
        restartResult._tag === 'None' ||
        restartResult.value._tag === 'failed' ||
        restartResult.value.id !== conversationId
      )
      {
        yield* Ref.set(childRef, undefined)
        yield* Ref.set(live, false)
        yield* gracefulCloseChild(restarted.success)
        if (pending)
          yield* completePending(
            pending,
            restartResult._tag === 'Some' && restartResult.value._tag === 'failed'
              ? restartResult.value.detail
              : 'Antigravity respawn returned an incompatible conversation id.',
          )
        return false
      }
      if (pending)
      {
        yield* completePending(
          pending,
          'Antigravity child exited during a turn; the turn was not replayed.',
        )
      }
      return true
    })
  const recoverAfterExit = (exitedChild: ChildProcessSpawner.ChildProcessHandle) =>
    Effect.gen(function* ()
    {
      const current = yield* Ref.get(childRef)
      if (current !== exitedChild) return
      yield* Ref.set(live, false)
      yield* Ref.set(childRef, undefined)
      const wasInterrupted = yield* Ref.get(interruptInFlight)
      yield* Ref.set(interruptInFlight, false)
      if ((yield* Ref.get(closed)) || (yield* Ref.get(shutdownRequested))) return
      const alreadyRecovering = yield* Ref.getAndSet(recoveryInFlight, true)
      if (alreadyRecovering) return
      yield* interruptReaderFibers
      const pending = wasInterrupted
        ? yield* Ref.getAndSet(pendingResult, undefined)
        : yield* Ref.get(pendingResult)
      if (pending && wasInterrupted)
      {
        yield* completePending(
          pending,
          'Antigravity turn interrupted by SIGINT; the turn was not replayed.',
        )
      }
      const conversationId = yield* Ref.get(conversationRef)
      yield* recoverChild(conversationId, pending).pipe(
        Effect.ensuring(Ref.set(recoveryInFlight, false)),
        Effect.ignoreCause,
      )
    })
  const invalidateFromReader = (child: ChildProcessSpawner.ChildProcessHandle, detail: string) =>
    Effect.gen(function* ()
    {
      if (
        (yield* Ref.get(childRef)) !== child ||
        (yield* Ref.get(closed)) ||
        (yield* Ref.get(shutdownRequested))
      )
        return
      yield* Ref.set(live, false)
      yield* failPending(detail)
      yield* child.kill({ killSignal: 'SIGTERM', forceKillAfter: '2 seconds' }).pipe(Effect.ignore)
    })

  spawnChildRaw = (conversationId, retrySpawn) =>
    Effect.gen(function* ()
    {
      const launchArgs = [
        ...buildAntigravityLaunchArgs({
          ...(conversationId ? { conversationId } : {}),
          ...(options.model ? { model: options.model } : {}),
          ...(options.agent ? { agent: options.agent } : {}),
          runtimeMode: options.runtimeMode,
          sandbox: options.sandbox,
        }),
      ]
      const resolved = yield* resolveSpawnCommand(
        options.binaryPath,
        launchArgs,
        options.environment ? { env: options.environment } : {},
      )
      const spawn = spawner
        .spawn(
          ChildProcess.make(resolved.command, resolved.args, {
            cwd: options.cwd,
            env: options.environment,
            shell: resolved.shell,
            forceKillAfter: '2 seconds',
          }),
        )
        .pipe(Effect.provideService(Scope.Scope, runtimeScope))
      const child = yield* retrySpawn ? spawn.pipe(Effect.retry({ times: 1 })) : spawn
      const startupFailure = yield* Deferred.make<string>()
      yield* Ref.set(startupFailureRef, startupFailure)
      yield* Ref.set(expectedInit, true)
      yield* Ref.set(childRef, child)
      yield* Ref.set(live, true)
      stdoutRemainder = ''
      const stdoutFiber = yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.runForEach(processStdoutChunk),
        Effect.catchCause((cause) =>
          invalidateFromReader(child, `Antigravity stdout reader failed: ${String(cause)}`),
        ),
        Effect.forkIn(runtimeScope),
      )
      const stderrFiber = yield* child.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) =>
          Ref.update(stderrTail, (tail) => boundedUtf8Tail(tail + chunk, MAX_STDERR_BYTES)).pipe(
            Effect.andThen(Effect.logDebug('Antigravity stderr.', { chunk: chunk.slice(0, 4096) })),
          ),
        ),
        Effect.catchCause((cause) =>
          invalidateFromReader(child, `Antigravity stderr reader failed: ${String(cause)}`),
        ),
        Effect.forkIn(runtimeScope),
      )
      yield* Ref.set(readerFibersRef, [stdoutFiber, stderrFiber])
      const monitor = yield* child.exitCode.pipe(
        Effect.flatMap(() => recoverAfterExit(child)),
        // some platform adapters report signal termination as a failed exit
        // wait rather than an exit code; use the same exact-id recovery path.
        Effect.catchCause(() => recoverAfterExit(child)),
        Effect.forkIn(runtimeScope),
      )
      yield* Ref.set(monitorFiberRef, monitor)
      return child
    }).pipe(
      Effect.catchCause((cause) => failRuntime(`Failed to start Antigravity: ${String(cause)}`)),
    )

  const initialSpawn = yield* spawnChild(options.resumeCursor?.conversationId, true)
  if (initialSpawn._tag === 'Failure')
  {
    return yield* initialSpawn.failure
  }
  yield* Effect.addFinalizer(() => interruptReaders)

  const abortStartup = (detail: string) =>
    Effect.gen(function* ()
    {
      yield* Ref.set(closed, true)
      yield* Ref.set(shutdownRequested, true)
      yield* Ref.set(live, false)
      const child = yield* Ref.getAndSet(childRef, undefined)
      yield* interruptReaders
      if (child) yield* gracefulCloseChild(child)
      return yield* failRuntime(detail)
    })
  const startupFailure = yield* Ref.get(startupFailureRef)
  const startupResult = yield* Effect.race(
    Deferred.await(initialInit).pipe(
      Effect.map((conversationId) => ({ _tag: 'initialized' as const, conversationId })),
    ),
    Deferred.await(startupFailure).pipe(
      Effect.map((detail) => ({ _tag: 'failed' as const, detail })),
    ),
  ).pipe(Effect.timeoutOption(START_TIMEOUT))
  if (Option.isNone(startupResult))
  {
    return yield* abortStartup('Antigravity did not emit its initialization event.')
  }
  if (startupResult.value._tag === 'failed')
  {
    return yield* abortStartup(startupResult.value.detail)
  }
  const conversationId = startupResult.value.conversationId
  if (options.resumeCursor && conversationId !== options.resumeCursor.conversationId)
  {
    return yield* abortStartup(
      'Antigravity returned a conversation id incompatible with the resume cursor.',
    )
  }

  const writeLine = (child: ChildProcessSpawner.ChildProcessHandle, value: unknown) =>
    Stream.run(Stream.encodeText(Stream.make(`${JSON.stringify(value)}\n`)), child.stdin)

  const close = Effect.gen(function* ()
  {
    const wasClosed = yield* Ref.getAndSet(closed, true)
    if (wasClosed) return
    yield* Ref.set(shutdownRequested, true)
    const child = yield* Ref.get(childRef)
    if (child)
    {
      yield* Ref.set(childRef, undefined)
      yield* Ref.set(live, false)
      yield* interruptReaders
      yield* gracefulCloseChild(child)
    }
    yield* interruptReaders
    const pending = yield* Ref.get(pendingResult)
    if (pending)
    {
      yield* Deferred.succeed(pending, resultForError('Antigravity session closed.').raw)
      yield* Ref.set(pendingResult, undefined)
    }
  }).pipe(Effect.uninterruptible)

  const interrupt = Effect.gen(function* ()
  {
    if (yield* Ref.get(closed)) return
    if (yield* Ref.getAndSet(interruptInFlight, true)) return
    const child = yield* Ref.get(childRef)
    if (!child)
    {
      yield* Ref.set(interruptInFlight, false)
      return
    }
    const pending = yield* Ref.getAndSet(pendingResult, undefined)
    if (pending)
    {
      yield* completePending(
        pending,
        'Antigravity turn interrupted by SIGINT; the turn was not replayed.',
      )
    }
    yield* child.kill({ killSignal: 'SIGINT', forceKillAfter: '2 seconds' }).pipe(Effect.ignore)
    const exited = yield* child.exitCode.pipe(
      Effect.timeoutOption('2 seconds'),
      Effect.orElseSucceed(() => ({ _tag: 'None' as const })),
    )
    if (exited._tag === 'None')
    {
      const running = yield* child.isRunning.pipe(Effect.orElseSucceed(() => false))
      if (running)
        yield* child
          .kill({ killSignal: 'SIGTERM', forceKillAfter: '2 seconds' })
          .pipe(Effect.ignore)
    }
  })

  const sendTurn = (text: string) =>
    Effect.gen(function* ()
    {
      if (text.trim().length === 0) return resultForError('Antigravity turns require text input.')
      if ((yield* Ref.get(closed)) || (yield* Ref.get(shutdownRequested)))
        return resultForError('Antigravity session is closed.')
      if (!(yield* Ref.get(live)))
        return resultForError('Antigravity session is recovering or exited.')
      const child = yield* Ref.get(childRef)
      if (!child) return resultForError('Antigravity session is exited.')
      const deferred = yield* Deferred.make<Record<string, unknown>>()
      const claimed = yield* Ref.modify(pendingResult, (existing) =>
        existing === undefined ? [true, deferred] : [false, existing],
      )
      if (!claimed) return resultForError('Antigravity does not support an active second turn.')
      yield* writeLine(child, { event: 'user', message: { content: text } }).pipe(
        Effect.catch((cause) =>
          Deferred.succeed(
            deferred,
            resultForError(`Failed to write Antigravity input: ${cause}`).raw,
          ),
        ),
      )
      const rawOption = yield* Deferred.await(deferred).pipe(Effect.timeoutOption(TURN_TIMEOUT))
      if (rawOption._tag === 'None')
      {
        yield* Ref.set(pendingResult, undefined)
        yield* Ref.set(live, false)
        yield* Ref.set(childRef, undefined)
        yield* interruptReaderFibers
        yield* interruptMonitor
        yield* child
          .kill({ killSignal: 'SIGTERM', forceKillAfter: '2 seconds' })
          .pipe(Effect.ignore)
        yield* child.exitCode.pipe(Effect.timeoutOption('2 seconds'), Effect.ignore)
        const alreadyRecovering = yield* Ref.getAndSet(recoveryInFlight, true)
        if (!alreadyRecovering)
        {
          const conversation = yield* Ref.get(conversationRef)
          yield* recoverChild(conversation, undefined).pipe(
            Effect.ensuring(Ref.set(recoveryInFlight, false)),
            Effect.ignoreCause,
          )
        }
        const timeoutMessage = yield* detailWithStderr(
          'Antigravity turn timed out; the child was invalidated and the turn was not replayed.',
        )
        return resultForError(timeoutMessage)
      }
      const raw = rawOption.value
      yield* Ref.set(pendingResult, undefined)
      const resultConversationId = conversationIdFromStreamMessage(raw)
      const resultError = resultErrorFromStreamMessage(raw)
      if (resultStatusFromStreamMessage(raw) === 'SUCCESS') yield* Ref.set(respawnAllowance, 1)
      return {
        ...(resultConversationId ? { conversationId: resultConversationId } : {}),
        status: resultStatusFromStreamMessage(raw),
        response: resultResponseFromStreamMessage(raw),
        ...(resultError ? { error: resultError } : {}),
        raw,
      } satisfies AntigravityResult
    })

  return {
    conversationId: Effect.succeed(conversationId),
    isLive: Effect.gen(function* ()
    {
      if (!(yield* Ref.get(live))) return false
      const child = yield* Ref.get(childRef)
      return child ? yield* child.isRunning.pipe(Effect.orElseSucceed(() => false)) : false
    }),
    events: Stream.fromPubSub(events),
    sendTurn,
    interrupt,
    close,
  }
})
