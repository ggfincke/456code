// tests/apps/server/provider/Layers/acpLifecycleTestHelpers.ts
// shared ACP child-process lifecycle assertions for Cursor and Grok adapters

import { assert } from '@effect/vitest'
import {
  ProviderInstanceId,
  type ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ThreadId,
} from '@t3tools/contracts'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Stream from 'effect/Stream'

import type { ProviderAdapterError } from '../../../../../apps/server/src/provider/Errors.ts'
import type {
  ProviderAdapterRuntimeSessionBinding,
  ProviderAdapterSessionStartInput,
  ProviderAdapterShape,
} from '../../../../../apps/server/src/provider/Services/ProviderAdapter.ts'

type TestProviderAdapterSessionStartInput = Omit<
  ProviderAdapterSessionStartInput,
  'runtimeSessionBinding'
> & {
  readonly runtimeSessionBinding?: ProviderAdapterRuntimeSessionBinding
}

export function startAcpTestSession<TError>(
  adapter: Pick<ProviderAdapterShape<TError>, 'provider' | 'startSession'>,
  input: TestProviderAdapterSessionStartInput,
)
{
  return adapter.startSession({
    ...input,
    runtimeSessionBinding: input.runtimeSessionBinding ?? {
      providerInstanceId:
        input.providerInstanceId ??
        input.modelSelection?.instanceId ??
        ProviderInstanceId.make(String(adapter.provider)),
      threadId: input.threadId,
      sessionGeneration: 1,
    },
  })
}

export function unwrapAcpRuntimeEvents<TError>(
  adapter: Pick<ProviderAdapterShape<TError>, 'streamEvents'>,
)
{
  return adapter.streamEvents.pipe(Stream.map(({ event }) => event))
}

type AcpLifecycleAdapter = Pick<
  ProviderAdapterShape<ProviderAdapterError>,
  | 'provider'
  | 'startSession'
  | 'sendTurn'
  | 'stopSession'
  | 'hasSession'
  | 'listSessions'
  | 'streamEvents'
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
    yield* Stream.runForEach(unwrapAcpRuntimeEvents(adapter), (event) =>
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
    yield* startAcpTestSession(adapter, {
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

    yield* startAcpTestSession(adapter, {
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
    yield* Stream.runForEach(unwrapAcpRuntimeEvents(adapter), (event) =>
      Effect.sync(() => events.push(event)),
    ).pipe(Effect.forkChild)

    yield* startAcpTestSession(adapter, {
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
    yield* Stream.runForEach(unwrapAcpRuntimeEvents(adapter), (event) =>
      Effect.sync(() => events.push(event)),
    ).pipe(Effect.forkChild)
    yield* startAcpTestSession(adapter, {
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

export function assertConcurrentStartSerializesSameThread(
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
    const events: Array<ProviderRuntimeEvent> = []
    yield* Stream.runForEach(unwrapAcpRuntimeEvents(adapter), (event) =>
      Effect.sync(() => events.push(event)),
    ).pipe(Effect.forkChild)

    const startInput = {
      threadId: input.threadId,
      provider: input.provider,
      cwd: process.cwd(),
      runtimeMode: 'full-access' as const,
      modelSelection: input.modelSelection,
    }

    const [firstSession, secondSession] = yield* Effect.all(
      [startAcpTestSession(adapter, startInput), startAcpTestSession(adapter, startInput)],
      { concurrency: 'unbounded' },
    )

    assert.equal(firstSession.threadId, input.threadId)
    assert.equal(secondSession.threadId, input.threadId)
    yield* Effect.yieldNow
    assert.isTrue(yield* adapter.hasSession(input.threadId))
    assert.equal((yield* adapter.listSessions()).length, 1)
    assert.equal(events.filter((event) => event.type === 'session.exited').length, 1)

    yield* adapter.stopSession(input.threadId)
    yield* Effect.yieldNow
    assert.equal(events.filter((event) => event.type === 'session.exited').length, 2)

    const exitLog = yield* input.readExitLog
    assert.equal(exitLog.match(/SIGTERM/g)?.length ?? 0, 2)
  })
}
