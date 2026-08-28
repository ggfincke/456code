// tests/apps/server/provider/Layers/CodexAdapter.test.ts
// verifies Codex adapter event translation and runtime behavior

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from 'node:assert/strict'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import {
  ApprovalRequestId,
  CodexSettings,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderItemId,
  type ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  ThreadId,
  TurnId,
} from '@t3tools/contracts'
import { createModelSelection } from '@t3tools/shared/model'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { it, vi } from '@effect/vitest'

import * as Context from 'effect/Context'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Queue from 'effect/Queue'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'
import * as CodexErrors from 'effect-codex-app-server/errors'
import * as TestClock from 'effect/testing/TestClock'

import { ServerConfig } from '../../../../../apps/server/src/config.ts'
import { ServerSettingsService } from '../../../../../apps/server/src/serverSettings.ts'
import { ProviderAdapterValidationError } from '../../../../../apps/server/src/provider/Errors.ts'
import type { CodexAdapterShape } from '../../../../../apps/server/src/provider/Services/CodexAdapter.ts'
import type { ProviderAdapterRuntimeEvent } from '../../../../../apps/server/src/provider/Services/ProviderAdapter.ts'
import { ProviderSessionDirectory } from '../../../../../apps/server/src/provider/Services/ProviderSessionDirectory.ts'
import {
  type CodexSessionRuntimeOptions,
  type CodexSessionRuntimeSendTurnInput,
  type CodexSessionRuntimeShape,
  type CodexThreadSnapshot,
} from '../../../../../apps/server/src/provider/Layers/CodexSessionRuntime.ts'
import { makeCodexAdapter } from '../../../../../apps/server/src/provider/Layers/CodexAdapter.ts'
import { makeTestMcpProviderSession, TEST_MCP_ENDPOINT } from './mcpProviderSessionTestHelpers.ts'
const decodeCodexSettings = Schema.decodeSync(CodexSettings)

// test-local service tag so the rest of the file can keep using `yield* CodexAdapter`.
class CodexAdapter extends Context.Service<CodexAdapter, CodexAdapterShape>()(
  '@t3tools/tests/apps/server/provider/Layers/CodexAdapter.test/CodexAdapter',
)
{}

const asThreadId = (value: string): ThreadId => ThreadId.make(value)
const asTurnId = (value: string): TurnId => TurnId.make(value)
const asEventId = (value: string): EventId => EventId.make(value)
const asItemId = (value: string): ProviderItemId => ProviderItemId.make(value)

type CodexTestSessionStartInput = Omit<
  Parameters<CodexAdapterShape['startSession']>[0],
  'runtimeSessionBinding'
> & {
  readonly runtimeSessionBinding?: Parameters<
    CodexAdapterShape['startSession']
  >[0]['runtimeSessionBinding']
}

type CodexRuntimeSessionBinding = NonNullable<CodexTestSessionStartInput['runtimeSessionBinding']>

const codexBindingByAdapter = new WeakMap<CodexAdapterShape, CodexRuntimeSessionBinding>()
const codexGenerationByAdapter = new WeakMap<CodexAdapterShape, number>()

function isSameCodexRuntimeSessionBinding(
  left: CodexRuntimeSessionBinding,
  right: CodexRuntimeSessionBinding,
): boolean
{
  return (
    left.providerInstanceId === right.providerInstanceId &&
    left.threadId === right.threadId &&
    left.sessionGeneration === right.sessionGeneration
  )
}

function startCodexTestSession(adapter: CodexAdapterShape, input: CodexTestSessionStartInput)
{
  const previousGeneration = codexGenerationByAdapter.get(adapter) ?? 0
  const runtimeSessionBinding = input.runtimeSessionBinding ?? {
    providerInstanceId:
      input.providerInstanceId ??
      input.modelSelection?.instanceId ??
      ProviderInstanceId.make(String(adapter.provider)),
    threadId: input.threadId,
    sessionGeneration: previousGeneration + 1,
  }
  codexGenerationByAdapter.set(
    adapter,
    Math.max(previousGeneration, runtimeSessionBinding.sessionGeneration),
  )

  return Effect.sync(() => codexBindingByAdapter.set(adapter, runtimeSessionBinding)).pipe(
    Effect.andThen(
      adapter.startSession({
        ...input,
        runtimeSessionBinding,
      }),
    ),
  )
}

function unwrapCodexRuntimeEvents(adapter: CodexAdapterShape): Stream.Stream<ProviderRuntimeEvent>
{
  const expectedBinding = codexBindingByAdapter.get(adapter)
  return adapter.streamEvents.pipe(
    Stream.filter(
      ({ binding }) =>
        expectedBinding === undefined || isSameCodexRuntimeSessionBinding(binding, expectedBinding),
    ),
    Stream.map(({ event }) => event),
  )
}

class FakeCodexRuntime implements CodexSessionRuntimeShape
{
  private readonly eventQueue = Effect.runSync(Queue.unbounded<ProviderEvent>())
  private readonly now = '2026-01-01T00:00:00.000Z'

  public readonly startImpl = vi.fn(() =>
    Promise.resolve({
      provider: ProviderDriverKind.make('codex'),
      status: 'ready' as const,
      runtimeMode: this.options.runtimeMode,
      threadId: this.options.threadId,
      cwd: this.options.cwd,
      ...(this.options.model ? { model: this.options.model } : {}),
      createdAt: this.now,
      updatedAt: this.now,
    } satisfies ProviderSession),
  )

  public readonly sendTurnImpl = vi.fn(
    (_input: CodexSessionRuntimeSendTurnInput): Promise<ProviderTurnStartResult> =>
      Promise.resolve({
        threadId: this.options.threadId,
        turnId: asTurnId('turn-1'),
      }),
  )

  public readonly interruptTurnImpl = vi.fn((_turnId?: TurnId): Promise<void> =>
    Promise.resolve(undefined),
  )

  public readonly readThreadImpl = vi.fn((): Promise<CodexThreadSnapshot> =>
    Promise.resolve({
      threadId: 'provider-thread-1',
      turns: [],
    }),
  )

  public readonly rollbackThreadImpl = vi.fn((_numTurns: number): Promise<CodexThreadSnapshot> =>
    Promise.resolve({
      threadId: 'provider-thread-1',
      turns: [],
    }),
  )

  public readonly respondToRequestImpl = vi.fn(
    (_requestId: ApprovalRequestId, _decision: ProviderApprovalDecision): Promise<void> =>
      Promise.resolve(undefined),
  )

  public readonly respondToUserInputImpl = vi.fn(
    (_requestId: ApprovalRequestId, _answers: ProviderUserInputAnswers): Promise<void> =>
      Promise.resolve(undefined),
  )

  public readonly closeImpl = vi.fn(() => Promise.resolve(undefined))
  public eventDeliveryGate: Deferred.Deferred<void> | undefined
  public eventDeliveryStarted: Deferred.Deferred<void> | undefined

  readonly options: CodexSessionRuntimeOptions

  constructor(options: CodexSessionRuntimeOptions)
  {
    this.options = options
  }

  start()
  {
    return Effect.promise(() => this.startImpl())
  }

  getSession = Effect.promise(() => this.startImpl())

  sendTurn(input: CodexSessionRuntimeSendTurnInput)
  {
    return Effect.promise(() => this.sendTurnImpl(input))
  }

  interruptTurn(turnId?: TurnId)
  {
    return Effect.promise(() => this.interruptTurnImpl(turnId))
  }

  readThread = Effect.promise(() => this.readThreadImpl())

  rollbackThread(numTurns: number)
  {
    return Effect.promise(() => this.rollbackThreadImpl(numTurns))
  }

  respondToRequest(requestId: ApprovalRequestId, decision: ProviderApprovalDecision)
  {
    return Effect.promise(() => this.respondToRequestImpl(requestId, decision))
  }

  respondToUserInput(requestId: ApprovalRequestId, answers: ProviderUserInputAnswers)
  {
    return Effect.promise(() => this.respondToUserInputImpl(requestId, answers))
  }

  get events()
  {
    return Stream.fromQueue(this.eventQueue).pipe(
      Stream.mapEffect((event) =>
      {
        const eventDeliveryGate = this.eventDeliveryGate
        if (eventDeliveryGate === undefined)
        {
          return Effect.succeed(event)
        }
        const notifyDeliveryStarted =
          this.eventDeliveryStarted === undefined
            ? Effect.void
            : Deferred.succeed(this.eventDeliveryStarted, undefined).pipe(Effect.asVoid)
        return notifyDeliveryStarted.pipe(
          Effect.andThen(Deferred.await(eventDeliveryGate)),
          Effect.as(event),
        )
      }),
    )
  }

  close = Effect.promise(() => this.closeImpl())

  emit(event: ProviderEvent)
  {
    return Queue.offer(this.eventQueue, event).pipe(Effect.asVoid)
  }
}

function makeRuntimeFactory()
{
  const runtimes: Array<FakeCodexRuntime> = []
  const factory = vi.fn((options: CodexSessionRuntimeOptions) =>
  {
    const runtime = new FakeCodexRuntime(options)
    runtimes.push(runtime)
    return Effect.succeed(runtime)
  })

  return {
    factory,
    get lastRuntime(): FakeCodexRuntime | undefined
    {
      return runtimes.at(-1)
    },
  }
}

function makeScopedRuntimeFactory(options?: { readonly failConstruction?: boolean })
{
  const runtimes: Array<FakeCodexRuntime> = []
  const releasedThreadIds: Array<ThreadId> = []

  const factory = vi.fn((runtimeOptions: CodexSessionRuntimeOptions) =>
    Effect.gen(function* ()
    {
      yield* Scope.Scope
      yield* Effect.addFinalizer(() =>
        Effect.sync(() =>
        {
          releasedThreadIds.push(runtimeOptions.threadId)
        }),
      )

      if (options?.failConstruction)
      {
        return yield* new CodexErrors.CodexAppServerSpawnError({
          command: `${runtimeOptions.binaryPath} app-server`,
          cause: new Error('runtime construction failed'),
        })
      }

      const runtime = new FakeCodexRuntime(runtimeOptions)
      runtimes.push(runtime)
      return runtime
    }),
  )

  return {
    factory,
    releasedThreadIds,
    get lastRuntime(): FakeCodexRuntime | undefined
    {
      return runtimes.at(-1)
    },
  }
}

const providerSessionDirectoryTestLayer = Layer.succeed(ProviderSessionDirectory, {
  upsert: () => Effect.void,
  getProvider: () =>
    Effect.die(new Error('ProviderSessionDirectory.getProvider is not used in test')),
  getBinding: () => Effect.succeed(Option.none()),
  listThreadIds: () => Effect.succeed([]),
  listBindings: () => Effect.succeed([]),
})

const validationRuntimeFactory = makeRuntimeFactory()
const validationLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* ()
    {
      const codexConfig = decodeCodexSettings({})
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: validationRuntimeFactory.factory,
      })
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
)

validationLayer('CodexAdapterLive validation', (it) =>
{
  it.effect('returns validation error for non-codex provider on startSession', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* CodexAdapter
      const result = yield* startCodexTestSession(adapter, {
        provider: ProviderDriverKind.make('claudeAgent'),
        threadId: asThreadId('thread-1'),
        runtimeMode: 'full-access',
      }).pipe(Effect.result)

      NodeAssert.equal(result._tag, 'Failure')
      NodeAssert.deepStrictEqual(
        result.failure,
        new ProviderAdapterValidationError({
          provider: ProviderDriverKind.make('codex'),
          operation: 'startSession',
          issue: "Expected provider 'codex' but received 'claudeAgent'.",
        }),
      )
      NodeAssert.equal(validationRuntimeFactory.factory.mock.calls.length, 0)
    }),
  )
  it.effect('passes the scoped MCP endpoint and bearer token to the Codex runtime', () =>
    Effect.gen(function* ()
    {
      validationRuntimeFactory.factory.mockClear()
      const adapter = yield* CodexAdapter
      const threadId = asThreadId('thread-mcp')

      yield* startCodexTestSession(adapter, {
        provider: ProviderDriverKind.make('codex'),
        threadId,
        runtimeMode: 'full-access',
        mcp: makeTestMcpProviderSession(threadId, ProviderInstanceId.make('codex')),
      })

      const runtimeOptions = validationRuntimeFactory.factory.mock.calls[0]?.[0]
      NodeAssert.equal(
        runtimeOptions?.environment?.CODE456_MCP_BEARER_TOKEN,
        'provider-session-test-token',
      )
      NodeAssert.deepStrictEqual(runtimeOptions?.appServerArgs, [
        '-c',
        `mcp_servers.code456.url=${TEST_MCP_ENDPOINT}`,
        '-c',
        'mcp_servers.code456.bearer_token_env_var="CODE456_MCP_BEARER_TOKEN"',
      ])
    }),
  )

  it.effect('passes strict imported resume cursors into the session runtime', () =>
    Effect.gen(function* ()
    {
      validationRuntimeFactory.factory.mockClear()
      const adapter = yield* CodexAdapter

      yield* startCodexTestSession(adapter, {
        provider: ProviderDriverKind.make('codex'),
        threadId: asThreadId('thread-imported'),
        runtimeMode: 'approval-required',
        resumeCursor: {
          threadId: 'native-imported-thread',
          requireExisting: true,
        },
      })

      NodeAssert.deepStrictEqual(validationRuntimeFactory.factory.mock.calls[0]?.[0].resumeCursor, {
        threadId: 'native-imported-thread',
        requireExisting: true,
      })
    }),
  )
})

const sessionRuntimeFactory = makeRuntimeFactory()
const sessionErrorLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* ()
    {
      const codexConfig = decodeCodexSettings({})
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: sessionRuntimeFactory.factory,
      })
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
)

sessionErrorLayer('CodexAdapterLive session errors', (it) =>
{
  it.effect('maps missing adapter sessions to ProviderAdapterSessionNotFoundError', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* CodexAdapter
      const result = yield* adapter
        .sendTurn({
          threadId: asThreadId('sess-missing'),
          input: 'hello',
          attachments: [],
        })
        .pipe(Effect.result)

      NodeAssert.equal(result._tag, 'Failure')
      NodeAssert.equal(result.failure._tag, 'ProviderAdapterSessionNotFoundError')
      NodeAssert.equal(result.failure.provider, 'codex')
      NodeAssert.equal(result.failure.threadId, 'sess-missing')
    }),
  )

  it.effect('maps codex model options on startSession and sendTurn', () =>
    Effect.gen(function* ()
    {
      sessionRuntimeFactory.factory.mockClear()
      const adapter = yield* CodexAdapter
      const threadId = asThreadId('sess-model-options')

      yield* startCodexTestSession(adapter, {
        provider: ProviderDriverKind.make('codex'),
        threadId,
        modelSelection: createModelSelection(ProviderInstanceId.make('codex'), 'gpt-5.3-codex', [
          { id: 'serviceTier', value: 'priority' },
        ]),
        runtimeMode: 'full-access',
      })

      NodeAssert.deepStrictEqual(sessionRuntimeFactory.factory.mock.calls[0]?.[0], {
        binaryPath: 'codex',
        cwd: process.cwd(),
        launchArgs: '',
        model: 'gpt-5.3-codex',
        providerInstanceId: ProviderInstanceId.make('codex'),
        serviceTier: 'priority',
        threadId,
        runtimeMode: 'full-access',
      })

      const runtime = sessionRuntimeFactory.lastRuntime
      NodeAssert.ok(runtime)
      runtime.sendTurnImpl.mockClear()

      yield* Effect.ignore(
        adapter.sendTurn({
          threadId,
          input: 'hello',
          modelSelection: createModelSelection(ProviderInstanceId.make('codex'), 'gpt-5.3-codex', [
            { id: 'reasoningEffort', value: 'high' },
            { id: 'serviceTier', value: 'priority' },
          ]),
          attachments: [],
        }),
      )

      NodeAssert.deepStrictEqual(runtime.sendTurnImpl.mock.calls[0]?.[0], {
        input: 'hello',
        model: 'gpt-5.3-codex',
        effort: 'high',
        serviceTier: 'priority',
      })
    }),
  )

  it.effect('forwards configured and env override launch args into the session runtime', () =>
  {
    const configuredFactory = makeRuntimeFactory()
    const configuredLayer = Layer.effect(
      CodexAdapter,
      Effect.gen(function* ()
      {
        const codexConfig = decodeCodexSettings({ launchArgs: '--strict-config --enable foo' })
        return yield* makeCodexAdapter(codexConfig, {
          makeRuntime: configuredFactory.factory,
        })
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    )

    const envFactory = makeRuntimeFactory()
    const envLayer = Layer.effect(
      CodexAdapter,
      Effect.gen(function* ()
      {
        const codexConfig = decodeCodexSettings({ launchArgs: '--enable settings-feature' })
        return yield* makeCodexAdapter(codexConfig, {
          environment: { T3CODE_CODEX_LAUNCH_ARGS: ' --strict-config --enable env-feature ' },
          makeRuntime: envFactory.factory,
        })
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    )

    return Effect.gen(function* ()
    {
      const configuredAdapter = yield* CodexAdapter
      yield* startCodexTestSession(configuredAdapter, {
        provider: ProviderDriverKind.make('codex'),
        threadId: asThreadId('sess-launch-args'),
        runtimeMode: 'full-access',
      })
      NodeAssert.ok(configuredFactory.lastRuntime)
      NodeAssert.equal(
        configuredFactory.lastRuntime.options.launchArgs,
        '--strict-config --enable foo',
      )
    }).pipe(
      Effect.provide(configuredLayer),
      Effect.andThen(
        Effect.gen(function* ()
        {
          const envAdapter = yield* CodexAdapter
          yield* startCodexTestSession(envAdapter, {
            provider: ProviderDriverKind.make('codex'),
            threadId: asThreadId('sess-launch-args-env'),
            runtimeMode: 'full-access',
          })
          NodeAssert.ok(envFactory.lastRuntime)
          NodeAssert.equal(
            envFactory.lastRuntime.options.launchArgs,
            '--strict-config --enable env-feature',
          )
        }).pipe(Effect.provide(envLayer)),
      ),
    )
  })

  it.effect("maps codex model options for the adapter's bound custom instance id", () =>
  {
    const customInstanceId = ProviderInstanceId.make('codex_personal')
    const customRuntimeFactory = makeRuntimeFactory()
    const customLayer = Layer.effect(
      CodexAdapter,
      Effect.gen(function* ()
      {
        const codexConfig = decodeCodexSettings({})
        return yield* makeCodexAdapter(codexConfig, {
          instanceId: customInstanceId,
          makeRuntime: customRuntimeFactory.factory,
        })
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    )

    return Effect.gen(function* ()
    {
      const adapter = yield* CodexAdapter
      yield* startCodexTestSession(adapter, {
        provider: ProviderDriverKind.make('codex'),
        providerInstanceId: customInstanceId,
        threadId: asThreadId('sess-custom-instance'),
        runtimeMode: 'full-access',
      })
      const runtime = customRuntimeFactory.lastRuntime
      NodeAssert.ok(runtime)
      runtime.sendTurnImpl.mockClear()

      yield* Effect.ignore(
        adapter.sendTurn({
          threadId: asThreadId('sess-custom-instance'),
          input: 'hello',
          modelSelection: createModelSelection(
            ProviderInstanceId.make('codex_personal'),
            'gpt-5.3-codex',
            [
              { id: 'reasoningEffort', value: 'high' },
              { id: 'serviceTier', value: 'flex' },
            ],
          ),
          attachments: [],
        }),
      )

      NodeAssert.deepStrictEqual(runtime.sendTurnImpl.mock.calls[0]?.[0], {
        input: 'hello',
        model: 'gpt-5.3-codex',
        effort: 'high',
        serviceTier: 'flex',
      })
    }).pipe(Effect.provide(customLayer))
  })
})

const lifecycleRuntimeFactory = makeRuntimeFactory()
const lifecycleLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* ()
    {
      const codexConfig = decodeCodexSettings({})
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: lifecycleRuntimeFactory.factory,
      })
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
)

function startLifecycleRuntime()
{
  return Effect.gen(function* ()
  {
    const adapter = yield* CodexAdapter
    yield* startCodexTestSession(adapter, {
      provider: ProviderDriverKind.make('codex'),
      threadId: asThreadId('thread-1'),
      runtimeMode: 'full-access',
    })
    const runtime = lifecycleRuntimeFactory.lastRuntime
    NodeAssert.ok(runtime)
    return { adapter, runtime }
  })
}

lifecycleLayer('CodexAdapterLive lifecycle', (it) =>
{
  it.effect(
    'uses one stable subAgentActivity row for child metadata and ignores an empty wait',
    () =>
      Effect.gen(function* ()
      {
        const { adapter, runtime } = yield* startLifecycleRuntime()
        const eventsFiber = yield* Stream.runCollect(
          Stream.take(unwrapCodexRuntimeEvents(adapter), 4),
        ).pipe(Effect.forkChild)
        const identity = {
          threadId: asThreadId('thread-1'),
          turnId: asTurnId('turn-1'),
          itemId: asItemId('provider-child'),
        }

        yield* runtime.emit({
          id: asEventId('evt-subagent-started-snapshot'),
          kind: 'notification',
          provider: ProviderDriverKind.make('codex'),
          createdAt: '2026-01-01T00:00:00.000Z',
          method: 'item/started',
          ...identity,
          payload: {
            startedAtMs: 1_778_000_000_000,
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: {
              type: 'subAgentActivity',
              id: 'call_D9',
              agentPath: '/root/package_metadata',
              agentThreadId: 'provider-child',
              kind: 'started',
            },
          },
        } satisfies ProviderEvent)
        yield* runtime.emit({
          id: asEventId('evt-subagent-completed'),
          kind: 'notification',
          provider: ProviderDriverKind.make('codex'),
          createdAt: '2026-01-01T00:00:00.000Z',
          method: 'item/completed',
          ...identity,
          payload: {
            completedAtMs: 1_778_000_000_000,
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: {
              type: 'subAgentActivity',
              id: 'call_D9',
              agentPath: '/root/package_metadata',
              agentThreadId: 'provider-child',
              kind: 'started',
            },
          },
        } satisfies ProviderEvent)
        yield* runtime.emit({
          id: asEventId('evt-subagent-finished-snapshot'),
          kind: 'notification',
          provider: ProviderDriverKind.make('codex'),
          createdAt: '2026-01-01T00:00:00.250Z',
          method: 'item/started',
          ...identity,
          payload: {
            startedAtMs: 1_778_000_000_250,
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: {
              type: 'subAgentActivity',
              id: 'subagent-completed-child-turn',
              agentPath: '/root/package_metadata',
              agentThreadId: 'provider-child',
              kind: 'completed',
            },
          },
        } satisfies ProviderEvent)
        yield* runtime.emit({
          id: asEventId('evt-subagent-finished'),
          kind: 'notification',
          provider: ProviderDriverKind.make('codex'),
          createdAt: '2026-01-01T00:00:00.250Z',
          method: 'item/completed',
          ...identity,
          payload: {
            completedAtMs: 1_778_000_000_250,
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: {
              type: 'subAgentActivity',
              id: 'subagent-completed-child-turn',
              agentPath: '/root/package_metadata',
              agentThreadId: 'provider-child',
              kind: 'completed',
            },
          },
        } satisfies ProviderEvent)
        yield* runtime.emit({
          id: asEventId('evt-empty-wait-completed'),
          kind: 'notification',
          provider: ProviderDriverKind.make('codex'),
          createdAt: '2026-01-01T00:00:00.500Z',
          method: 'item/completed',
          threadId: asThreadId('thread-1'),
          turnId: asTurnId('turn-1'),
          itemId: asItemId('call-wait-empty'),
          payload: {
            completedAtMs: 1_778_000_000_500,
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: {
              type: 'collabAgentToolCall',
              id: 'call-wait-empty',
              tool: 'wait',
              status: 'completed',
              senderThreadId: 'provider-root',
              receiverThreadIds: [],
              agentsStates: {},
              model: null,
              reasoningEffort: null,
            },
          },
        } satisfies ProviderEvent)
        yield* runtime.emit({
          id: asEventId('evt-subagent-model-updated'),
          kind: 'notification',
          provider: ProviderDriverKind.make('codex'),
          createdAt: '2026-01-01T00:00:01.000Z',
          method: 'collabAgent/metadataUpdated',
          ...identity,
          payload: {
            model: ' actual-model ',
            effort: ' high ',
          },
        } satisfies ProviderEvent)
        yield* runtime.emit({
          id: asEventId('evt-subagent-effort-cleared'),
          kind: 'notification',
          provider: ProviderDriverKind.make('codex'),
          createdAt: '2026-01-01T00:00:02.000Z',
          method: 'collabAgent/metadataUpdated',
          ...identity,
          payload: {
            model: ' actual-model ',
            effort: null,
          },
        } satisfies ProviderEvent)

        const events = Array.from(yield* Fiber.join(eventsFiber))
        const lifecycleEvents = events.filter(
          (event) => event.type === 'item.started' || event.type === 'item.completed',
        )
        NodeAssert.equal(lifecycleEvents.length, 2)
        NodeAssert.deepEqual(
          lifecycleEvents.map((event) => event.itemId),
          [asItemId('provider-child'), asItemId('provider-child')],
        )
        NodeAssert.equal(events[0]?.type, 'item.started')
        NodeAssert.deepEqual(events[0]?.payload, {
          itemType: 'collab_agent_tool_call',
          status: 'inProgress',
          title: 'package_metadata',
          data: {
            completedAtMs: 1_778_000_000_000,
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: {
              type: 'subAgentActivity',
              id: 'call_D9',
              agentPath: '/root/package_metadata',
              agentThreadId: 'provider-child',
              kind: 'started',
            },
          },
        })
        NodeAssert.equal(events[1]?.type, 'item.completed')
        NodeAssert.deepEqual(events[1]?.payload, {
          itemType: 'collab_agent_tool_call',
          status: 'completed',
          title: 'package_metadata',
          data: {
            completedAtMs: 1_778_000_000_250,
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: {
              type: 'subAgentActivity',
              id: 'subagent-completed-child-turn',
              agentPath: '/root/package_metadata',
              agentThreadId: 'provider-child',
              kind: 'completed',
            },
          },
        })
        NodeAssert.equal(events[2]?.type, 'item.updated')
        NodeAssert.deepEqual(events[2]?.payload, {
          itemType: 'collab_agent_tool_call',
          model: 'actual-model',
          effort: 'high',
        })
        NodeAssert.equal(events[3]?.type, 'item.updated')
        NodeAssert.deepEqual(events[3]?.payload, {
          itemType: 'collab_agent_tool_call',
          model: 'actual-model',
          effort: null,
        })
        NodeAssert.equal(events[0]?.itemId, events[1]?.itemId)
        NodeAssert.equal(events[0]?.turnId, events[1]?.turnId)
        NodeAssert.equal(events[1]?.itemId, events[2]?.itemId)
        NodeAssert.equal(events[1]?.turnId, events[2]?.turnId)
        NodeAssert.equal(events[2]?.itemId, events[3]?.itemId)
        NodeAssert.equal(events[2]?.turnId, events[3]?.turnId)
      }),
  )

  it.effect('maps completed agent message items to canonical item.completed events', () =>
    Effect.gen(function* ()
    {
      const { adapter, runtime } = yield* startLifecycleRuntime()
      const firstEventFiber = yield* Stream.runHead(unwrapCodexRuntimeEvents(adapter)).pipe(
        Effect.forkChild,
      )

      const event: ProviderEvent = {
        id: asEventId('evt-msg-complete'),
        kind: 'notification',
        provider: ProviderDriverKind.make('codex'),
        createdAt: '2026-01-01T00:00:00.000Z',
        method: 'item/completed',
        threadId: asThreadId('thread-1'),
        turnId: asTurnId('turn-1'),
        itemId: asItemId('msg_1'),
        payload: {
          completedAtMs: 1_778_000_000_000,
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            type: 'agentMessage',
            id: 'msg_1',
            text: 'done',
          },
        },
      }

      yield* runtime.emit(event)
      const firstEvent = yield* Fiber.join(firstEventFiber)

      NodeAssert.equal(firstEvent._tag, 'Some')
      if (firstEvent._tag !== 'Some')
      {
        return
      }
      NodeAssert.equal(firstEvent.value.type, 'item.completed')
      if (firstEvent.value.type !== 'item.completed')
      {
        return
      }
      NodeAssert.equal(firstEvent.value.itemId, 'msg_1')
      NodeAssert.equal(firstEvent.value.turnId, 'turn-1')
      NodeAssert.equal(firstEvent.value.payload.itemType, 'assistant_message')
    }),
  )

  it.effect('preserves failed and declined outcomes on completed tool items', () =>
    Effect.gen(function* ()
    {
      const { adapter, runtime } = yield* startLifecycleRuntime()
      const items = [
        {
          type: 'commandExecution',
          id: 'failed-command',
          command: 'vp test run',
          commandActions: [],
          cwd: '/tmp',
          exitCode: 1,
          status: 'failed',
        },
        {
          type: 'mcpToolCall',
          id: 'failed-mcp',
          server: 'simulator',
          tool: 'build',
          arguments: {},
          error: { message: 'Build failed' },
          status: 'failed',
        },
        {
          type: 'fileChange',
          id: 'declined-change',
          changes: [],
          status: 'declined',
        },
      ] as const

      for (const item of items)
      {
        const firstEventFiber = yield* Stream.runHead(unwrapCodexRuntimeEvents(adapter)).pipe(
          Effect.forkChild,
        )

        yield* runtime.emit({
          id: asEventId(`evt-${item.id}`),
          kind: 'notification',
          provider: ProviderDriverKind.make('codex'),
          createdAt: '2026-01-01T00:00:00.000Z',
          method: 'item/completed',
          threadId: asThreadId('thread-1'),
          turnId: asTurnId('turn-1'),
          itemId: asItemId(item.id),
          payload: {
            completedAtMs: 1_778_000_000_000,
            threadId: 'thread-1',
            turnId: 'turn-1',
            item,
          },
        })

        const firstEvent = yield* Fiber.join(firstEventFiber)
        NodeAssert.equal(firstEvent._tag, 'Some')
        if (firstEvent._tag !== 'Some' || firstEvent.value.type !== 'item.completed')
        {
          return
        }
        NodeAssert.equal(firstEvent.value.payload.status, item.status)
      }
    }),
  )

  it.effect('labels MCP lifecycle entries with server and tool names', () =>
    Effect.gen(function* ()
    {
      const { adapter, runtime } = yield* startLifecycleRuntime()
      const firstEventFiber = yield* Stream.runHead(unwrapCodexRuntimeEvents(adapter)).pipe(
        Effect.forkChild,
      )

      yield* runtime.emit({
        id: asEventId('evt-mcp-complete'),
        kind: 'notification',
        provider: ProviderDriverKind.make('codex'),
        createdAt: '2026-01-01T00:00:00.000Z',
        method: 'item/completed',
        threadId: asThreadId('thread-1'),
        turnId: asTurnId('turn-1'),
        itemId: asItemId('mcp_1'),
        payload: {
          completedAtMs: 1_778_000_000_000,
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            type: 'mcpToolCall',
            id: 'mcp_1',
            server: 't3-code',
            tool: 'preview_status',
            arguments: {},
            durationMs: 12,
            error: null,
            result: { content: [{ type: 'text', text: 'attached' }] },
            status: 'completed',
          },
        },
      })
      const firstEvent = yield* Fiber.join(firstEventFiber)

      NodeAssert.equal(firstEvent._tag, 'Some')
      if (firstEvent._tag !== 'Some' || firstEvent.value.type !== 'item.completed')
      {
        return
      }
      NodeAssert.equal(firstEvent.value.payload.itemType, 'mcp_tool_call')
      NodeAssert.equal(firstEvent.value.payload.title, 't3-code · preview_status')
      NodeAssert.deepStrictEqual(firstEvent.value.payload.data, {
        completedAtMs: 1_778_000_000_000,
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'mcpToolCall',
          id: 'mcp_1',
          server: 't3-code',
          tool: 'preview_status',
          arguments: {},
          durationMs: 12,
          error: null,
          result: { content: [{ type: 'text', text: 'attached' }] },
          status: 'completed',
        },
      })
    }),
  )

  it.effect('maps completed plan items to canonical proposed-plan completion events', () =>
    Effect.gen(function* ()
    {
      const { adapter, runtime } = yield* startLifecycleRuntime()
      const firstEventFiber = yield* Stream.runHead(unwrapCodexRuntimeEvents(adapter)).pipe(
        Effect.forkChild,
      )

      const event: ProviderEvent = {
        id: asEventId('evt-plan-complete'),
        kind: 'notification',
        provider: ProviderDriverKind.make('codex'),
        createdAt: '2026-01-01T00:00:00.000Z',
        method: 'item/completed',
        threadId: asThreadId('thread-1'),
        turnId: asTurnId('turn-1'),
        itemId: asItemId('plan_1'),
        payload: {
          completedAtMs: 1_778_000_000_000,
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            type: 'plan',
            id: 'plan_1',
            text: '## Final plan\n\n- one\n- two',
          },
        },
      }

      yield* runtime.emit(event)
      const firstEvent = yield* Fiber.join(firstEventFiber)

      NodeAssert.equal(firstEvent._tag, 'Some')
      if (firstEvent._tag !== 'Some')
      {
        return
      }
      NodeAssert.equal(firstEvent.value.type, 'turn.proposed.completed')
      if (firstEvent.value.type !== 'turn.proposed.completed')
      {
        return
      }
      NodeAssert.equal(firstEvent.value.turnId, 'turn-1')
      NodeAssert.equal(firstEvent.value.payload.planMarkdown, '## Final plan\n\n- one\n- two')
    }),
  )

  it.effect('maps plan deltas to canonical proposed-plan delta events', () =>
    Effect.gen(function* ()
    {
      const { adapter, runtime } = yield* startLifecycleRuntime()
      const firstEventFiber = yield* Stream.runHead(unwrapCodexRuntimeEvents(adapter)).pipe(
        Effect.forkChild,
      )

      yield* runtime.emit({
        id: asEventId('evt-plan-delta'),
        kind: 'notification',
        provider: ProviderDriverKind.make('codex'),
        createdAt: '2026-01-01T00:00:00.000Z',
        method: 'item/plan/delta',
        threadId: asThreadId('thread-1'),
        turnId: asTurnId('turn-1'),
        itemId: asItemId('plan_1'),
        payload: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'plan_1',
          delta: '## Final plan',
        },
      } satisfies ProviderEvent)

      const firstEvent = yield* Fiber.join(firstEventFiber)

      NodeAssert.equal(firstEvent._tag, 'Some')
      if (firstEvent._tag !== 'Some')
      {
        return
      }
      NodeAssert.equal(firstEvent.value.type, 'turn.proposed.delta')
      if (firstEvent.value.type !== 'turn.proposed.delta')
      {
        return
      }
      NodeAssert.equal(firstEvent.value.turnId, 'turn-1')
      NodeAssert.equal(firstEvent.value.payload.delta, '## Final plan')
    }),
  )

  it.effect('maps session/closed lifecycle events to canonical session.exited runtime events', () =>
    Effect.gen(function* ()
    {
      const { adapter, runtime } = yield* startLifecycleRuntime()
      const firstEventFiber = yield* Stream.runHead(unwrapCodexRuntimeEvents(adapter)).pipe(
        Effect.forkChild,
      )

      const event: ProviderEvent = {
        id: asEventId('evt-session-closed'),
        kind: 'session',
        provider: ProviderDriverKind.make('codex'),
        threadId: asThreadId('thread-1'),
        createdAt: '2026-01-01T00:00:00.000Z',
        method: 'session/closed',
        message: 'Session stopped',
      }

      yield* runtime.emit(event)
      const firstEvent = yield* Fiber.join(firstEventFiber)

      NodeAssert.equal(firstEvent._tag, 'Some')
      if (firstEvent._tag !== 'Some')
      {
        return
      }
      NodeAssert.equal(firstEvent.value.type, 'session.exited')
      if (firstEvent.value.type !== 'session.exited')
      {
        return
      }
      NodeAssert.equal(firstEvent.value.threadId, 'thread-1')
      NodeAssert.equal(firstEvent.value.payload.reason, 'Session stopped')
    }),
  )

  it.effect('maps retryable Codex error notifications to runtime.warning', () =>
    Effect.gen(function* ()
    {
      const { adapter, runtime } = yield* startLifecycleRuntime()
      const firstEventFiber = yield* Stream.runHead(unwrapCodexRuntimeEvents(adapter)).pipe(
        Effect.forkChild,
      )

      yield* runtime.emit({
        id: asEventId('evt-retryable-error'),
        kind: 'notification',
        provider: ProviderDriverKind.make('codex'),
        threadId: asThreadId('thread-1'),
        createdAt: '2026-01-01T00:00:00.000Z',
        method: 'error',
        turnId: asTurnId('turn-1'),
        payload: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          error: {
            message: 'Reconnecting... 2/5',
          },
          willRetry: true,
        },
      } satisfies ProviderEvent)

      const firstEvent = yield* Fiber.join(firstEventFiber)

      NodeAssert.equal(firstEvent._tag, 'Some')
      if (firstEvent._tag !== 'Some')
      {
        return
      }
      NodeAssert.equal(firstEvent.value.type, 'runtime.warning')
      if (firstEvent.value.type !== 'runtime.warning')
      {
        return
      }
      NodeAssert.equal(firstEvent.value.turnId, 'turn-1')
      NodeAssert.equal(firstEvent.value.payload.message, 'Reconnecting... 2/5')
    }),
  )

  it.effect('maps imported resume fallback to a visible canonical runtime warning', () =>
    Effect.gen(function* ()
    {
      const { adapter, runtime } = yield* startLifecycleRuntime()
      const firstEventFiber = yield* Stream.runHead(unwrapCodexRuntimeEvents(adapter)).pipe(
        Effect.forkChild,
      )

      yield* runtime.emit({
        id: asEventId('evt-resume-fallback'),
        kind: 'notification',
        provider: ProviderDriverKind.make('codex'),
        threadId: asThreadId('thread-1'),
        createdAt: '2026-01-01T00:00:00.000Z',
        method: 'thread/resumeFallback',
        message: 'Imported native history was unavailable; Codex started a fresh thread.',
      } satisfies ProviderEvent)

      const firstEvent = yield* Fiber.join(firstEventFiber)

      NodeAssert.equal(firstEvent._tag, 'Some')
      if (firstEvent._tag !== 'Some')
      {
        return
      }
      NodeAssert.equal(firstEvent.value.type, 'runtime.warning')
      if (firstEvent.value.type !== 'runtime.warning')
      {
        return
      }
      NodeAssert.equal(firstEvent.value.threadId, 'thread-1')
      NodeAssert.equal(
        firstEvent.value.payload.message,
        'Imported native history was unavailable; Codex started a fresh thread.',
      )
    }),
  )

  it.effect('maps process stderr notifications to runtime.warning', () =>
    Effect.gen(function* ()
    {
      const { adapter, runtime } = yield* startLifecycleRuntime()
      const firstEventFiber = yield* Stream.runHead(unwrapCodexRuntimeEvents(adapter)).pipe(
        Effect.forkChild,
      )

      yield* runtime.emit({
        id: asEventId('evt-process-stderr'),
        kind: 'notification',
        provider: ProviderDriverKind.make('codex'),
        threadId: asThreadId('thread-1'),
        createdAt: '2026-01-01T00:00:00.000Z',
        method: 'process/stderr',
        turnId: asTurnId('turn-1'),
        message: 'The filename or extension is too long. (os error 206)',
      } satisfies ProviderEvent)

      const firstEvent = yield* Fiber.join(firstEventFiber)

      NodeAssert.equal(firstEvent._tag, 'Some')
      if (firstEvent._tag !== 'Some')
      {
        return
      }
      NodeAssert.equal(firstEvent.value.type, 'runtime.warning')
      if (firstEvent.value.type !== 'runtime.warning')
      {
        return
      }
      NodeAssert.equal(firstEvent.value.turnId, 'turn-1')
      NodeAssert.equal(
        firstEvent.value.payload.message,
        'The filename or extension is too long. (os error 206)',
      )
    }),
  )

  it.effect('maps realtime started notifications with upstream realtime session ids', () =>
    Effect.gen(function* ()
    {
      const { adapter, runtime } = yield* startLifecycleRuntime()
      const firstEventFiber = yield* Stream.runHead(unwrapCodexRuntimeEvents(adapter)).pipe(
        Effect.forkChild,
      )

      yield* runtime.emit({
        id: asEventId('evt-realtime-started'),
        kind: 'notification',
        provider: ProviderDriverKind.make('codex'),
        threadId: asThreadId('thread-1'),
        createdAt: '2026-01-01T00:00:00.000Z',
        method: 'thread/realtime/started',
        payload: {
          threadId: 'thread-1',
          realtimeSessionId: 'realtime-session-1',
          version: 'v2',
        },
      } satisfies ProviderEvent)

      const firstEvent = yield* Fiber.join(firstEventFiber)

      NodeAssert.equal(firstEvent._tag, 'Some')
      if (firstEvent._tag !== 'Some')
      {
        return
      }
      NodeAssert.equal(firstEvent.value.type, 'thread.realtime.started')
      if (firstEvent.value.type !== 'thread.realtime.started')
      {
        return
      }
      NodeAssert.equal(firstEvent.value.threadId, 'thread-1')
      NodeAssert.equal(firstEvent.value.payload.realtimeSessionId, 'realtime-session-1')
    }),
  )

  it.effect('maps fatal websocket stderr notifications to runtime.error', () =>
    Effect.gen(function* ()
    {
      const { adapter, runtime } = yield* startLifecycleRuntime()
      const firstEventFiber = yield* Stream.runHead(unwrapCodexRuntimeEvents(adapter)).pipe(
        Effect.forkChild,
      )

      yield* runtime.emit({
        id: asEventId('evt-process-stderr-websocket'),
        kind: 'notification',
        provider: ProviderDriverKind.make('codex'),
        threadId: asThreadId('thread-1'),
        createdAt: '2026-01-01T00:00:00.000Z',
        method: 'process/stderr',
        turnId: asTurnId('turn-1'),
        message:
          '2026-03-31T18:14:06.833399Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 503 Service Unavailable, url: wss://chatgpt.com/backend-api/codex/responses',
      } satisfies ProviderEvent)

      const firstEvent = yield* Fiber.join(firstEventFiber)

      NodeAssert.equal(firstEvent._tag, 'Some')
      if (firstEvent._tag !== 'Some')
      {
        return
      }
      NodeAssert.equal(firstEvent.value.type, 'runtime.error')
      if (firstEvent.value.type !== 'runtime.error')
      {
        return
      }
      NodeAssert.equal(firstEvent.value.turnId, 'turn-1')
      NodeAssert.equal(firstEvent.value.payload.class, 'provider_error')
      NodeAssert.equal(
        firstEvent.value.payload.message,
        '2026-03-31T18:14:06.833399Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 503 Service Unavailable, url: wss://chatgpt.com/backend-api/codex/responses',
      )
    }),
  )

  it.effect('maps MCP elicitation requests and resolutions into app access approvals', () =>
    Effect.gen(function* ()
    {
      const { adapter, runtime } = yield* startLifecycleRuntime()
      const openedFiber = yield* Stream.runHead(unwrapCodexRuntimeEvents(adapter)).pipe(
        Effect.forkChild,
      )

      yield* runtime.emit({
        id: asEventId('evt-mcp-elicitation'),
        kind: 'request',
        provider: ProviderDriverKind.make('codex'),
        threadId: asThreadId('thread-1'),
        createdAt: '2026-08-24T00:00:00.000Z',
        method: 'mcpServer/elicitation/request',
        requestKind: 'mcp-elicitation',
        requestId: ApprovalRequestId.make('req-safari'),
        turnId: asTurnId('turn-1'),
        payload: {
          mode: 'form',
          message: 'Allow ChatGPT to use Safari?',
          serverName: 'computer-use',
          threadId: 'provider-thread-1',
          turnId: 'turn-1',
          _meta: { app_name: 'Safari', persist: ['session', 'always'] },
          requestedSchema: { type: 'object', properties: {} },
        },
      } satisfies ProviderEvent)

      const opened = yield* Fiber.join(openedFiber)
      NodeAssert.equal(opened._tag, 'Some')
      if (opened._tag !== 'Some' || opened.value.type !== 'request.opened')
      {
        return
      }
      NodeAssert.equal(opened.value.payload.requestType, 'mcp_elicitation_approval')
      NodeAssert.equal(opened.value.payload.appName, 'Safari')
      NodeAssert.equal(opened.value.payload.detail, 'Allow ChatGPT to use Safari?')
      NodeAssert.deepStrictEqual(opened.value.payload.options, [
        { decision: 'cancel', label: 'Cancel' },
        { decision: 'decline', label: 'Decline' },
        { decision: 'acceptForSession', label: 'Always allow this session' },
        { decision: 'acceptAlways', label: 'Always allow' },
        { decision: 'accept', label: 'Approve' },
      ])

      const resolvedFiber = yield* Stream.runHead(unwrapCodexRuntimeEvents(adapter)).pipe(
        Effect.forkChild,
      )
      yield* runtime.emit({
        id: asEventId('evt-mcp-elicitation-resolved'),
        kind: 'notification',
        provider: ProviderDriverKind.make('codex'),
        threadId: asThreadId('thread-1'),
        createdAt: '2026-08-24T00:00:01.000Z',
        method: 'item/requestApproval/decision',
        requestKind: 'mcp-elicitation',
        requestId: ApprovalRequestId.make('req-safari'),
        payload: { decision: 'acceptAlways' },
      } satisfies ProviderEvent)

      const resolved = yield* Fiber.join(resolvedFiber)
      NodeAssert.equal(resolved._tag, 'Some')
      if (resolved._tag !== 'Some' || resolved.value.type !== 'request.resolved')
      {
        return
      }
      NodeAssert.equal(resolved.value.payload.requestType, 'mcp_elicitation_approval')
      NodeAssert.equal(resolved.value.payload.decision, 'acceptAlways')
    }),
  )

  it.effect.each([
    {
      requestKind: 'command' as const,
      requestId: 'req-1',
      expectedRequestType: 'command_execution_approval',
    },
    {
      requestKind: 'file-read' as const,
      requestId: 'req-file-read-1',
      expectedRequestType: 'file_read_approval',
    },
  ])(
    'preserves $requestKind request type when mapping serverRequest/resolved',
    ({ requestKind, requestId, expectedRequestType }) =>
      Effect.gen(function* ()
      {
        const { adapter, runtime } = yield* startLifecycleRuntime()
        const firstEventFiber = yield* Stream.runHead(unwrapCodexRuntimeEvents(adapter)).pipe(
          Effect.forkChild,
        )

        const event: ProviderEvent = {
          id: asEventId(`evt-${requestKind}-request-resolved`),
          kind: 'notification',
          provider: ProviderDriverKind.make('codex'),
          threadId: asThreadId('thread-1'),
          createdAt: '2026-01-01T00:00:00.000Z',
          method: 'serverRequest/resolved',
          requestKind,
          requestId: ApprovalRequestId.make(requestId),
          payload: {
            threadId: 'thread-1',
            requestId,
          },
        }

        yield* runtime.emit(event)
        const firstEvent = yield* Fiber.join(firstEventFiber)

        NodeAssert.equal(firstEvent._tag, 'Some')
        if (firstEvent._tag !== 'Some')
        {
          return
        }
        NodeAssert.equal(firstEvent.value.type, 'request.resolved')
        if (firstEvent.value.type !== 'request.resolved')
        {
          return
        }
        NodeAssert.equal(firstEvent.value.payload.requestType, expectedRequestType)
      }),
  )

  it.effect('preserves explicit empty multi-select user-input answers', () =>
    Effect.gen(function* ()
    {
      const { adapter, runtime } = yield* startLifecycleRuntime()
      const firstEventFiber = yield* Stream.runHead(unwrapCodexRuntimeEvents(adapter)).pipe(
        Effect.forkChild,
      )

      const event: ProviderEvent = {
        id: asEventId('evt-user-input-empty'),
        kind: 'notification',
        provider: ProviderDriverKind.make('codex'),
        threadId: asThreadId('thread-1'),
        createdAt: '2026-01-01T00:00:00.000Z',
        method: 'item/tool/requestUserInput/answered',
        payload: {
          answers: {
            scope: {
              answers: [],
            },
          },
        },
      }

      yield* runtime.emit(event)
      const firstEvent = yield* Fiber.join(firstEventFiber)

      NodeAssert.equal(firstEvent._tag, 'Some')
      if (firstEvent._tag !== 'Some')
      {
        return
      }
      NodeAssert.equal(firstEvent.value.type, 'user-input.resolved')
      if (firstEvent.value.type !== 'user-input.resolved')
      {
        return
      }
      NodeAssert.deepEqual(firstEvent.value.payload.answers, {
        scope: [],
      })
    }),
  )

  it.effect('maps windowsSandbox/setupCompleted to session state and warning on failure', () =>
    Effect.gen(function* ()
    {
      const { adapter, runtime } = yield* startLifecycleRuntime()
      const eventsFiber = yield* Stream.runCollect(
        Stream.take(unwrapCodexRuntimeEvents(adapter), 2),
      ).pipe(Effect.forkChild)

      const event: ProviderEvent = {
        id: asEventId('evt-windows-sandbox-failed'),
        kind: 'notification',
        provider: ProviderDriverKind.make('codex'),
        threadId: asThreadId('thread-1'),
        createdAt: '2026-01-01T00:00:00.000Z',
        method: 'windowsSandbox/setupCompleted',
        message: 'Sandbox setup failed',
        payload: {
          mode: 'unelevated',
          success: false,
          error: 'unsupported environment',
        },
      }

      yield* runtime.emit(event)
      const events = Array.from(yield* Fiber.join(eventsFiber))

      NodeAssert.equal(events.length, 2)

      const firstEvent = events[0]
      const secondEvent = events[1]

      NodeAssert.equal(firstEvent?.type, 'session.state.changed')
      if (firstEvent?.type === 'session.state.changed')
      {
        NodeAssert.equal(firstEvent.payload.state, 'error')
        NodeAssert.equal(firstEvent.payload.reason, 'Sandbox setup failed')
      }

      NodeAssert.equal(secondEvent?.type, 'runtime.warning')
      if (secondEvent?.type === 'runtime.warning')
      {
        NodeAssert.equal(secondEvent.payload.message, 'Sandbox setup failed')
      }
    }),
  )

  it.effect(
    'maps requestUserInput requests and answered notifications to canonical user-input events',
    () =>
      Effect.gen(function* ()
      {
        const { adapter, runtime } = yield* startLifecycleRuntime()
        const eventsFiber = yield* Stream.runCollect(
          Stream.take(unwrapCodexRuntimeEvents(adapter), 2),
        ).pipe(Effect.forkChild)

        yield* runtime.emit({
          id: asEventId('evt-user-input-requested'),
          kind: 'request',
          provider: ProviderDriverKind.make('codex'),
          threadId: asThreadId('thread-1'),
          createdAt: '2026-01-01T00:00:00.000Z',
          method: 'item/tool/requestUserInput',
          requestId: ApprovalRequestId.make('req-user-input-1'),
          payload: {
            itemId: 'item-user-input-1',
            threadId: 'thread-1',
            turnId: 'turn-1',
            questions: [
              {
                id: 'sandbox_mode',
                header: 'Sandbox',
                question: 'Which mode should be used?',
                options: [
                  {
                    label: 'workspace-write',
                    description: 'Allow workspace writes only',
                  },
                ],
              },
            ],
          },
        } satisfies ProviderEvent)
        yield* runtime.emit({
          id: asEventId('evt-user-input-resolved'),
          kind: 'notification',
          provider: ProviderDriverKind.make('codex'),
          threadId: asThreadId('thread-1'),
          createdAt: '2026-01-01T00:00:00.000Z',
          method: 'item/tool/requestUserInput/answered',
          requestId: ApprovalRequestId.make('req-user-input-1'),
          payload: {
            answers: {
              sandbox_mode: {
                answers: ['workspace-write'],
              },
            },
          },
        } satisfies ProviderEvent)

        const events = Array.from(yield* Fiber.join(eventsFiber))
        NodeAssert.equal(events[0]?.type, 'user-input.requested')
        if (events[0]?.type === 'user-input.requested')
        {
          NodeAssert.equal(events[0].requestId, 'req-user-input-1')
          NodeAssert.equal(events[0].payload.questions[0]?.id, 'sandbox_mode')
          NodeAssert.equal(events[0].payload.questions[0]?.multiSelect, false)
        }

        NodeAssert.equal(events[1]?.type, 'user-input.resolved')
        if (events[1]?.type === 'user-input.resolved')
        {
          NodeAssert.equal(events[1].requestId, 'req-user-input-1')
          NodeAssert.deepEqual(events[1].payload.answers, {
            sandbox_mode: 'workspace-write',
          })
        }
      }),
  )

  it.effect('unwraps Codex token usage payloads for context window events', () =>
    Effect.gen(function* ()
    {
      const { adapter, runtime } = yield* startLifecycleRuntime()
      const firstEventFiber = yield* Stream.runHead(unwrapCodexRuntimeEvents(adapter)).pipe(
        Effect.forkChild,
      )

      yield* runtime.emit({
        id: asEventId('evt-codex-thread-token-usage-updated'),
        kind: 'notification',
        provider: ProviderDriverKind.make('codex'),
        threadId: asThreadId('thread-1'),
        turnId: asTurnId('turn-1'),
        createdAt: '2026-01-01T00:00:00.000Z',
        method: 'thread/tokenUsage/updated',
        payload: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          tokenUsage: {
            total: {
              inputTokens: 11_833,
              cachedInputTokens: 3456,
              outputTokens: 6,
              reasoningOutputTokens: 0,
              totalTokens: 11_839,
            },
            last: {
              inputTokens: 120,
              cachedInputTokens: 0,
              outputTokens: 6,
              reasoningOutputTokens: 0,
              totalTokens: 126,
            },
            modelContextWindow: 258_400,
          },
        },
      } satisfies ProviderEvent)

      const firstEvent = yield* Fiber.join(firstEventFiber)
      NodeAssert.equal(firstEvent._tag, 'Some')
      if (firstEvent._tag !== 'Some')
      {
        return
      }
      NodeAssert.equal(firstEvent.value.type, 'thread.token-usage.updated')
      if (firstEvent.value.type !== 'thread.token-usage.updated')
      {
        return
      }

      NodeAssert.deepEqual(firstEvent.value.payload.usage, {
        usedTokens: 126,
        totalProcessedTokens: 11_839,
        maxTokens: 258_400,
        inputTokens: 120,
        cachedInputTokens: 0,
        outputTokens: 6,
        reasoningOutputTokens: 0,
        lastUsedTokens: 126,
        lastInputTokens: 120,
        lastCachedInputTokens: 0,
        lastOutputTokens: 6,
        lastReasoningOutputTokens: 0,
        compactsAutomatically: true,
      })
    }),
  )
})

const scopedLifecycleRuntimeFactory = makeScopedRuntimeFactory()
const scopedLifecycleLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* ()
    {
      const codexConfig = decodeCodexSettings({})
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: scopedLifecycleRuntimeFactory.factory,
      })
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
)

scopedLifecycleLayer('CodexAdapterLive scoped lifecycle', (it) =>
{
  it.effect('keeps event forwarding alive after the startSession caller exits', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* CodexAdapter
      const threadId = asThreadId('thread-event-forwarding')
      yield* Effect.raceFirst(
        Effect.gen(function* ()
        {
          yield* startCodexTestSession(adapter, {
            provider: ProviderDriverKind.make('codex'),
            threadId,
            runtimeMode: 'full-access',
          })
          yield* adapter.sendTurn({
            threadId,
            input: 'hello',
            attachments: [],
          })
        }),
        Effect.never,
      )

      const runtime = scopedLifecycleRuntimeFactory.lastRuntime
      NodeAssert.ok(runtime)

      const firstEventFiber = yield* Stream.runHead(unwrapCodexRuntimeEvents(adapter)).pipe(
        Effect.forkChild,
      )
      yield* runtime.emit({
        id: asEventId('evt-after-start-caller-exit'),
        kind: 'notification',
        provider: ProviderDriverKind.make('codex'),
        threadId,
        turnId: asTurnId('turn-1'),
        createdAt: '2026-01-01T00:00:00.000Z',
        method: 'turn/started',
      } satisfies ProviderEvent)

      const firstEvent = yield* Fiber.join(firstEventFiber).pipe(
        Effect.timeout('1 second'),
        TestClock.withLive,
      )
      NodeAssert.equal(firstEvent._tag, 'Some')
      if (firstEvent._tag === 'Some')
      {
        NodeAssert.equal(firstEvent.value.type, 'turn.started')
        NodeAssert.equal(firstEvent.value.threadId, threadId)
        NodeAssert.equal(firstEvent.value.turnId, 'turn-1')
      }

      yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('closes the externally owned session scope on stopSession', () =>
    Effect.gen(function* ()
    {
      scopedLifecycleRuntimeFactory.releasedThreadIds.length = 0
      const adapter = yield* CodexAdapter

      yield* startCodexTestSession(adapter, {
        provider: ProviderDriverKind.make('codex'),
        threadId: asThreadId('thread-stop'),
        runtimeMode: 'full-access',
      })

      const runtime = scopedLifecycleRuntimeFactory.lastRuntime
      NodeAssert.ok(runtime)

      yield* adapter.stopSession(asThreadId('thread-stop'))

      NodeAssert.equal(runtime.closeImpl.mock.calls.length, 1)
      NodeAssert.deepStrictEqual(scopedLifecycleRuntimeFactory.releasedThreadIds, [
        asThreadId('thread-stop'),
      ])
      NodeAssert.equal(yield* adapter.hasSession(asThreadId('thread-stop')), false)
    }),
  )

  it.effect(
    'emits one bound graceful terminal and suppresses a delayed native event after stop',
    () =>
      Effect.gen(function* ()
      {
        const adapter = yield* CodexAdapter
        const threadId = asThreadId('thread-graceful-terminal')
        const runtimeSessionBinding: CodexRuntimeSessionBinding = {
          providerInstanceId: ProviderInstanceId.make('codex'),
          threadId,
          sessionGeneration: 701,
        }
        yield* startCodexTestSession(adapter, {
          provider: ProviderDriverKind.make('codex'),
          threadId,
          runtimeMode: 'full-access',
          runtimeSessionBinding,
        })

        const runtime = scopedLifecycleRuntimeFactory.lastRuntime
        NodeAssert.ok(runtime)
        const eventDeliveryGate = yield* Deferred.make<void>()
        const eventDeliveryStarted = yield* Deferred.make<void>()
        runtime.eventDeliveryGate = eventDeliveryGate
        runtime.eventDeliveryStarted = eventDeliveryStarted

        const envelopes: ProviderAdapterRuntimeEvent[] = []
        const terminalObserved = yield* Deferred.make<void>()
        const collectorFiber = yield* Stream.runForEach(adapter.streamEvents, (envelope) =>
          Effect.sync(() =>
          {
            envelopes.push(envelope)
          }).pipe(
            Effect.andThen(
              isSameCodexRuntimeSessionBinding(envelope.binding, runtimeSessionBinding) &&
                envelope.event.type === 'session.exited'
                ? Deferred.succeed(terminalObserved, undefined).pipe(Effect.asVoid)
                : Effect.void,
            ),
          ),
        ).pipe(Effect.forkChild)

        yield* runtime.emit({
          id: asEventId('evt-delayed-after-stop'),
          kind: 'notification',
          provider: ProviderDriverKind.make('codex'),
          threadId,
          turnId: asTurnId('turn-delayed-after-stop'),
          createdAt: '2026-01-01T00:00:00.000Z',
          method: 'turn/started',
        } satisfies ProviderEvent)
        const eventDeliveryStart = yield* Deferred.await(eventDeliveryStarted).pipe(
          Effect.timeoutOption('1 second'),
          TestClock.withLive,
        )
        NodeAssert.equal(eventDeliveryStart._tag, 'Some', 'event delivery did not start')

        const stopFiber = yield* adapter.stopSession(threadId).pipe(Effect.forkChild)
        const observedTerminal = yield* Deferred.await(terminalObserved).pipe(
          Effect.timeoutOption('1 second'),
          TestClock.withLive,
        )
        NodeAssert.equal(observedTerminal._tag, 'Some', 'terminal was not observed')
        yield* Deferred.succeed(eventDeliveryGate, undefined)
        yield* Fiber.join(stopFiber).pipe(Effect.timeout('1 second'), TestClock.withLive)
        yield* Effect.yieldNow
        yield* Fiber.interrupt(collectorFiber)

        const boundEnvelopes = envelopes.filter((envelope) =>
          isSameCodexRuntimeSessionBinding(envelope.binding, runtimeSessionBinding),
        )
        NodeAssert.equal(boundEnvelopes.length, 1)
        NodeAssert.deepStrictEqual(boundEnvelopes[0]?.binding, runtimeSessionBinding)
        NodeAssert.equal(boundEnvelopes.at(-1)?.event.type, 'session.exited')
        const terminalEvent = boundEnvelopes[0]?.event
        NodeAssert.equal(terminalEvent?.type, 'session.exited')
        if (terminalEvent?.type === 'session.exited')
        {
          NodeAssert.equal(terminalEvent.payload.reason, 'Codex adapter stopped the session.')
          NodeAssert.equal(terminalEvent.payload.exitKind, 'graceful')
          NodeAssert.equal(terminalEvent.payload.recoverable, false)
        }
        NodeAssert.equal(runtime.closeImpl.mock.calls.length, 1)
      }),
  )
})

const scopedFailureRuntimeFactory = makeScopedRuntimeFactory({ failConstruction: true })
const scopedFailureLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* ()
    {
      const codexConfig = decodeCodexSettings({})
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: scopedFailureRuntimeFactory.factory,
      })
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
)

scopedFailureLayer('CodexAdapterLive scoped startup failure', (it) =>
{
  it.effect('closes the externally owned session scope when startSession fails', () =>
    Effect.gen(function* ()
    {
      scopedFailureRuntimeFactory.releasedThreadIds.length = 0
      const adapter = yield* CodexAdapter

      const result = yield* startCodexTestSession(adapter, {
        provider: ProviderDriverKind.make('codex'),
        threadId: asThreadId('thread-fail'),
        runtimeMode: 'full-access',
      }).pipe(Effect.result)

      NodeAssert.equal(result._tag, 'Failure')
      NodeAssert.equal(result.failure._tag, 'ProviderAdapterProcessError')
      NodeAssert.deepStrictEqual(scopedFailureRuntimeFactory.releasedThreadIds, [
        asThreadId('thread-fail'),
      ])
      NodeAssert.equal(yield* adapter.hasSession(asThreadId('thread-fail')), false)
    }),
  )
})

it.effect('flushes managed native logs when the adapter layer shuts down', () =>
  Effect.gen(function* ()
  {
    const tempDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), 't3-codex-adapter-native-log-'),
    )
    const basePath = NodePath.join(tempDir, 'provider-native.ndjson')
    const runtimeFactory = makeRuntimeFactory()
    const scope = yield* Scope.make('sequential')
    let scopeClosed = false

    try
    {
      const layer = Layer.effect(
        CodexAdapter,
        Effect.gen(function* ()
        {
          const codexConfig = decodeCodexSettings({})
          return yield* makeCodexAdapter(codexConfig, {
            makeRuntime: runtimeFactory.factory,
            nativeEventLogPath: basePath,
          })
        }),
      ).pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(ServerSettingsService.layerTest()),
        Layer.provideMerge(providerSessionDirectoryTestLayer),
        Layer.provideMerge(NodeServices.layer),
      )
      const context = yield* Layer.buildWithScope(layer, scope)
      const adapter = yield* Effect.service(CodexAdapter).pipe(Effect.provide(context))

      yield* startCodexTestSession(adapter, {
        provider: ProviderDriverKind.make('codex'),
        threadId: asThreadId('thread-logger'),
        runtimeMode: 'full-access',
      })

      const runtime = runtimeFactory.lastRuntime
      NodeAssert.ok(runtime)

      const firstEventFiber = yield* Stream.runHead(unwrapCodexRuntimeEvents(adapter)).pipe(
        Effect.forkChild,
      )
      yield* runtime.emit({
        id: asEventId('evt-native-log'),
        kind: 'notification',
        provider: ProviderDriverKind.make('codex'),
        threadId: asThreadId('thread-logger'),
        createdAt: '2026-01-01T00:00:00.000Z',
        method: 'process/stderr',
        message: 'native flush test',
      } satisfies ProviderEvent)
      yield* Fiber.join(firstEventFiber)

      yield* Scope.close(scope, Exit.void)
      scopeClosed = true

      const threadLogPath = NodePath.join(tempDir, 'thread-logger.log')
      NodeAssert.equal(NodeFS.existsSync(threadLogPath), true)
      const contents = NodeFS.readFileSync(threadLogPath, 'utf8')
      NodeAssert.match(contents, /NTIVE: .*"message":"native flush test"/)
    }
    finally
    {
      if (!scopeClosed)
      {
        yield* Scope.close(scope, Exit.void)
      }
      NodeFS.rmSync(tempDir, { recursive: true, force: true })
    }
  }),
)
