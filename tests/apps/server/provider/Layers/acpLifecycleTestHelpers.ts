// tests/apps/server/provider/Layers/acpLifecycleTestHelpers.ts
// shared ACP child-process lifecycle assertions for Cursor and Grok adapters

import { assert } from '@effect/vitest'
import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderRuntimeEvent,
  ThreadId,
} from '@t3tools/contracts'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Stream from 'effect/Stream'

import type { ProviderAdapterError } from '../../../../../apps/server/src/provider/Errors.ts'
import type { ProviderAdapterShape } from '../../../../../apps/server/src/provider/Services/ProviderAdapter.ts'

type AcpLifecycleAdapter = Pick<
  ProviderAdapterShape<ProviderAdapterError>,
  'startSession' | 'sendTurn' | 'stopSession' | 'hasSession' | 'listSessions' | 'streamEvents'
>

export function waitForAcpSessionDrop(
  adapter: Pick<AcpLifecycleAdapter, 'hasSession'>,
  threadId: ThreadId,
  label: string,
): Effect.Effect<void>
{
  const wait = (attempts: number): Effect.Effect<void> =>
    adapter.hasSession(threadId).pipe(
      Effect.flatMap((active) =>
      {
        if (!active) return Effect.void
        if (attempts <= 0)
        {
          return Effect.die(new Error(`Timed out waiting for ${label} session ${threadId} to stop`))
        }
        // @effect-diagnostics-next-line globalTimers:off globalTimersInEffect:off - polling follows a real child process
        return Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25))).pipe(
          Effect.andThen(wait(attempts - 1)),
        )
      }),
    )
  return wait(200)
}

function forkEventCollector(adapter: AcpLifecycleAdapter)
{
  return Effect.gen(function* ()
  {
    const events: Array<ProviderRuntimeEvent> = []
    const requestOpened = yield* Deferred.make<void>()
    yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.sync(() => events.push(event)).pipe(
        Effect.andThen(
          event.type === 'request.opened'
            ? Deferred.succeed(requestOpened, undefined)
            : Effect.void,
        ),
      ),
    ).pipe(Effect.forkChild)
    return { events, requestOpened }
  })
}

export function assertStopClosesAcpChild(
  adapter: AcpLifecycleAdapter,
  input: {
    readonly threadId: ThreadId
    readonly provider: ProviderDriverKind
    readonly modelSelection: {
      readonly instanceId: ProviderInstanceId
      readonly model: string
    }
    readonly readExitLog: Effect.Effect<string>
  },
)
{
  return Effect.gen(function* ()
  {
    yield* adapter.startSession({
      threadId: input.threadId,
      provider: input.provider,
      cwd: process.cwd(),
      runtimeMode: 'full-access',
      modelSelection: input.modelSelection,
    })

    yield* adapter.stopSession(input.threadId)

    const exitLog = yield* input.readExitLog
    assert.include(exitLog, 'SIGTERM')
  })
}

export function assertAbnormalChildExitFinalizesOnce(
  adapter: AcpLifecycleAdapter,
  input: {
    readonly threadId: ThreadId
    readonly provider: ProviderDriverKind
    readonly label: string
    // cursor awaits request.opened; grok races it against session drop because
    // the delayed child exit can beat the mock tool-call emission.
    readonly promptInFlight: 'await-request' | 'race-session-drop'
  },
)
{
  return Effect.gen(function* ()
  {
    const { events, requestOpened } = yield* forkEventCollector(adapter)

    yield* adapter.startSession({
      threadId: input.threadId,
      provider: input.provider,
      cwd: process.cwd(),
      runtimeMode: 'approval-required',
    })
    const turnFiber = yield* adapter
      .sendTurn({ threadId: input.threadId, input: 'trigger exit', attachments: [] })
      .pipe(Effect.ignore, Effect.forkChild)

    if (input.promptInFlight === 'await-request')
    {
      yield* Deferred.await(requestOpened)
    }
    else
    {
      yield* Effect.race(
        Deferred.await(requestOpened),
        waitForAcpSessionDrop(adapter, input.threadId, input.label),
      )
    }

    yield* waitForAcpSessionDrop(adapter, input.threadId, input.label)
    yield* Fiber.await(turnFiber)
    yield* Effect.yieldNow

    const exits = events.filter((event) => event.type === 'session.exited')
    assert.equal(exits.length, 1)
    assert.deepInclude(exits[0]?.payload, {
      exitKind: 'error',
      reason: 'ACP process exited with code 9',
      recoverable: false,
    })
    assert.isFalse(yield* adapter.hasSession(input.threadId))
    assert.equal((yield* adapter.listSessions()).length, 0)
  })
}

export function assertAbnormalExitDisabledByDefault(
  adapter: AcpLifecycleAdapter,
  input: {
    readonly threadId: ThreadId
    readonly provider: ProviderDriverKind
    readonly label: string
  },
)
{
  return Effect.gen(function* ()
  {
    const events: Array<ProviderRuntimeEvent> = []
    yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.sync(() => events.push(event)),
    ).pipe(Effect.forkChild)

    yield* adapter.startSession({
      threadId: input.threadId,
      provider: input.provider,
      cwd: process.cwd(),
      runtimeMode: 'full-access',
    })
    yield* adapter
      .sendTurn({ threadId: input.threadId, input: 'trigger exit', attachments: [] })
      .pipe(Effect.ignore, Effect.forkChild)
    yield* waitForAcpSessionDrop(adapter, input.threadId, input.label)
    yield* Effect.yieldNow

    assert.equal(events.filter((event) => event.type === 'session.exited').length, 0)
    assert.isFalse(yield* adapter.hasSession(input.threadId))
  })
}

export function assertOneExitWhenStopRacesTermination(
  adapter: AcpLifecycleAdapter,
  input: {
    readonly threadId: ThreadId
    readonly provider: ProviderDriverKind
    readonly label: string
  },
)
{
  return Effect.gen(function* ()
  {
    const events: Array<ProviderRuntimeEvent> = []
    yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.sync(() => events.push(event)),
    ).pipe(Effect.forkChild)
    yield* adapter.startSession({
      threadId: input.threadId,
      provider: input.provider,
      cwd: process.cwd(),
      runtimeMode: 'full-access',
    })

    const turnFiber = yield* adapter
      .sendTurn({ threadId: input.threadId, input: 'race exit', attachments: [] })
      .pipe(Effect.ignore, Effect.forkChild)
    yield* Effect.yieldNow
    yield* adapter.stopSession(input.threadId).pipe(Effect.result)
    yield* Fiber.await(turnFiber)
    yield* waitForAcpSessionDrop(adapter, input.threadId, input.label)
    yield* Effect.yieldNow

    assert.equal(events.filter((event) => event.type === 'session.exited').length, 1)
  })
}
