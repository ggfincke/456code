// tests/apps/server/provider/Layers/CoralAdapter.test.ts
// verify Coral ACP lifecycle, resume, approval, cancellation, and termination behavior

// @effect-diagnostics globalTimers:off - cancellation exercises a real child process
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'

import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, it } from '@effect/vitest'
import {
  ApprovalRequestId,
  CoralSettings,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from '@t3tools/contracts'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Ref from 'effect/Ref'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import * as TestClock from 'effect/testing/TestClock'

import { makeCoralAdapter } from '../../../../../apps/server/src/provider/Layers/CoralAdapter.ts'
import {
  buildInitialCoralProviderSnapshot,
  coralProviderModelsFromSessionSetup,
  overlayCoralSessionModels,
} from '../../../../../apps/server/src/provider/Layers/CoralProvider.ts'
import {
  assertAbnormalChildExitFinalizesOnce,
  startAcpTestSession,
  unwrapAcpRuntimeEvents,
} from './acpLifecycleTestHelpers.ts'

const decodeCoralSettings = Schema.decodeSync(CoralSettings)
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url))
const mockAgentPath = NodePath.join(
  __dirname,
  '../../../../../apps/server/scripts/acp-mock-agent.ts',
)

function shellSingleQuote(value: string): string
{
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

async function makeMockCoralWrapper(extraEnv: Record<string, string> = {}): Promise<string>
{
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'coral-acp-mock-'))
  const wrapperPath = NodePath.join(dir, 'coral')
  await NodeFSP.writeFile(
    wrapperPath,
    [
      '#!/bin/sh',
      'export T3_ACP_CORAL_MODES=1',
      ...Object.entries(extraEnv).map(([key, value]) => `export ${key}=${shellSingleQuote(value)}`),
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)} "$@"`,
      '',
    ].join('\n'),
    'utf8',
  )
  await NodeFSP.chmod(wrapperPath, 0o755)
  return wrapperPath
}

async function readJsonLines(filePath: string): Promise<ReadonlyArray<Record<string, unknown>>>
{
  const raw = await NodeFSP.readFile(filePath, 'utf8')
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

const waitForRequestLog = (
  requestLogPath: string,
  predicate: (entry: Record<string, unknown>) => boolean,
  label: string,
) =>
{
  const wait = (attempts: number): Effect.Effect<void> =>
    Effect.promise(() => readJsonLines(requestLogPath)).pipe(
      Effect.flatMap((entries) =>
      {
        if (entries.some(predicate)) return Effect.void
        if (attempts <= 0)
        {
          return Effect.die(new Error(`Timed out waiting for Coral ACP ${label}`))
        }
        return Effect.sleep('20 millis').pipe(Effect.andThen(wait(attempts - 1)))
      }),
    )
  return wait(250)
}

const makeTestAdapter = (binaryPath: string, options?: Parameters<typeof makeCoralAdapter>[1]) =>
  makeCoralAdapter(decodeCoralSettings({ binaryPath }), options).pipe(Effect.orDie)

const waitForRuntimeEvent = (
  runtimeEvents: Array<ProviderRuntimeEvent>,
  predicate: (event: ProviderRuntimeEvent) => boolean,
  label: string,
) =>
{
  const wait = (attempts: number): Effect.Effect<void> =>
    Effect.sync(() => runtimeEvents.find(predicate)).pipe(
      Effect.flatMap((event) =>
      {
        if (event !== undefined) return Effect.void
        if (attempts <= 0)
        {
          return Effect.die(new Error(`Timed out waiting for Coral ${label}`))
        }
        return Effect.sleep('20 millis').pipe(Effect.andThen(wait(attempts - 1)))
      }),
    )
  return wait(250)
}

const waitForCoralTurnIdle = (
  adapter: {
    listSessions: () => Effect.Effect<
      ReadonlyArray<{ threadId: ThreadId; status: string; activeTurnId?: TurnId | undefined }>
    >
  },
  threadId: ThreadId,
  runtimeEvents: Array<ProviderRuntimeEvent>,
  turnId: TurnId,
) =>
  Effect.gen(function* ()
  {
    yield* waitForRuntimeEvent(
      runtimeEvents,
      (event) => event.type === 'turn.completed' && event.turnId === turnId,
      `turn.completed ${turnId}`,
    )
    const wait = (attempts: number): Effect.Effect<void> =>
      adapter.listSessions().pipe(
        Effect.flatMap((sessions) =>
        {
          const session = sessions.find((entry) => entry.threadId === threadId)
          if (session?.status === 'ready' && session.activeTurnId === undefined)
          {
            return Effect.void
          }
          if (attempts <= 0)
          {
            return Effect.die(new Error(`Timed out waiting for Coral session ${threadId} to idle`))
          }
          return Effect.sleep('20 millis').pipe(Effect.andThen(wait(attempts - 1)))
        }),
      )
    yield* wait(250)
  })

it.layer(NodeServices.layer)('CoralAdapterLive', (it) =>
{
  it.effect('publishes session-setup models into the provider snapshot after session/new', () =>
    Effect.gen(function* ()
    {
      const threadId = ThreadId.make('coral-snapshot-models')
      const wrapperPath = yield* Effect.promise(() => makeMockCoralWrapper())
      const snapshot = yield* Ref.make(
        yield* buildInitialCoralProviderSnapshot(
          decodeCoralSettings({ enabled: true, binaryPath: wrapperPath }),
        ),
      )
      const adapter = yield* makeTestAdapter(wrapperPath, {
        onSessionSetup: (sessionSetupResult) =>
          Ref.update(snapshot, (current) =>
            overlayCoralSessionModels(
              current,
              coralProviderModelsFromSessionSetup(sessionSetupResult),
            ),
          ),
      })
      const eventsFiber = yield* Stream.runForEach(
        unwrapAcpRuntimeEvents(adapter),
        () => Effect.void,
      ).pipe(Effect.forkChild)

      const before = yield* Ref.get(snapshot)
      assert.deepStrictEqual(
        before.models.map((model) => model.slug),
        ['gemma4:31b-mlx'],
      )

      yield* startAcpTestSession(adapter, {
        threadId,
        provider: ProviderDriverKind.make('coral'),
        cwd: process.cwd(),
        runtimeMode: 'approval-required',
      })

      const slugs = (yield* Ref.get(snapshot)).models.map((model) => model.slug)
      assert.includeMembers(slugs, ['composer-2'])
      assert.isAbove(slugs.length, 1)

      yield* Fiber.interrupt(eventsFiber)
      yield* adapter.stopSession(threadId)
    }).pipe(TestClock.withLive),
  )

  it.effect('runs multiple Coral turns, projects ACP events, and closes the child on stop', () =>
    Effect.gen(function* ()
    {
      const threadId = ThreadId.make('coral-lifecycle')
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'coral-exit-log-')),
      )
      const exitLogPath = NodePath.join(tempDir, 'exit.log')
      const wrapperPath = yield* Effect.promise(() =>
        makeMockCoralWrapper({ T3_ACP_EXIT_LOG_PATH: exitLogPath }),
      )
      const adapter = yield* makeTestAdapter(wrapperPath)
      const runtimeEvents: Array<ProviderRuntimeEvent> = []
      const eventsFiber = yield* Stream.runForEach(unwrapAcpRuntimeEvents(adapter), (event) =>
        Effect.sync(() => runtimeEvents.push(event)),
      ).pipe(Effect.forkChild)

      const session = yield* startAcpTestSession(adapter, {
        threadId,
        provider: ProviderDriverKind.make('coral'),
        cwd: process.cwd(),
        runtimeMode: 'approval-required',
        modelSelection: {
          instanceId: ProviderInstanceId.make('coral'),
          model: 'composer-2',
        },
      })
      const firstTurn = yield* adapter.sendTurn({
        threadId,
        input: 'first Coral turn',
        attachments: [],
      })
      yield* waitForCoralTurnIdle(adapter, threadId, runtimeEvents, firstTurn.turnId)
      const secondTurn = yield* adapter.sendTurn({
        threadId,
        input: 'second Coral turn',
        attachments: [],
      })
      yield* waitForCoralTurnIdle(adapter, threadId, runtimeEvents, secondTurn.turnId)

      assert.equal(session.provider, 'coral')
      assert.equal(session.model, 'composer-2')
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: 'mock-session-1',
      })
      assert.notEqual(firstTurn.turnId, secondTurn.turnId)
      assert.includeMembers(
        runtimeEvents.map((event) => event.type),
        [
          'session.started',
          'thread.started',
          'turn.started',
          'item.started',
          'content.delta',
          'turn.completed',
        ] as const,
      )
      assert.isTrue(
        runtimeEvents.some(
          (event) => event.type === 'content.delta' && event.payload.delta === 'hello from mock',
        ),
      )
      assert.isTrue(
        runtimeEvents.every(
          (event) => String(event.providerInstanceId) === String(ProviderInstanceId.make('coral')),
        ),
      )

      yield* adapter.stopSession(threadId)
      yield* Fiber.interrupt(eventsFiber)
      const exitLog = yield* Effect.promise(() => NodeFSP.readFile(exitLogPath, 'utf8'))
      assert.include(exitLog, 'SIGTERM')
    }).pipe(TestClock.withLive),
  )

  it.effect('keeps Coral session workers alive after the initiating caller completes', () =>
    Effect.gen(function* ()
    {
      const threadId = ThreadId.make('coral-caller-lifetime')
      const wrapperPath = yield* Effect.promise(() => makeMockCoralWrapper())
      const adapter = yield* makeTestAdapter(wrapperPath)
      const runtimeEvents: Array<ProviderRuntimeEvent> = []
      const eventsFiber = yield* Stream.runForEach(unwrapAcpRuntimeEvents(adapter), (event) =>
        Effect.sync(() => runtimeEvents.push(event)),
      ).pipe(Effect.forkChild)

      const firstCaller = yield* Effect.gen(function* ()
      {
        yield* startAcpTestSession(adapter, {
          threadId,
          provider: ProviderDriverKind.make('coral'),
          cwd: process.cwd(),
          runtimeMode: 'approval-required',
        })
        return yield* adapter.sendTurn({
          threadId,
          input: 'first caller-owned turn',
          attachments: [],
        })
      }).pipe(Effect.forkChild)
      const firstTurn = yield* Fiber.join(firstCaller)
      yield* waitForCoralTurnIdle(adapter, threadId, runtimeEvents, firstTurn.turnId)

      const secondTurn = yield* adapter
        .sendTurn({
          threadId,
          input: 'second turn after caller completion',
          attachments: [],
        })
        .pipe(Effect.timeout('2 seconds'))
      yield* waitForCoralTurnIdle(adapter, threadId, runtimeEvents, secondTurn.turnId)

      assert.notEqual(firstTurn.turnId, secondTurn.turnId)
      assert.equal(runtimeEvents.filter((event) => event.type === 'content.delta').length, 2)
      assert.equal(runtimeEvents.filter((event) => event.type === 'turn.completed').length, 2)

      yield* Fiber.interrupt(eventsFiber)
      yield* adapter.stopSession(threadId)
    }).pipe(TestClock.withLive),
  )

  it.effect('uses native session/resume without auth or session/load fallback', () =>
    Effect.gen(function* ()
    {
      const threadId = ThreadId.make('coral-native-resume')
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'coral-resume-log-')),
      )
      const requestLogPath = NodePath.join(tempDir, 'requests.ndjson')
      const wrapperPath = yield* Effect.promise(() =>
        makeMockCoralWrapper({
          T3_ACP_ADVERTISE_RESUME: '1',
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      )
      const adapter = yield* makeTestAdapter(wrapperPath)

      const session = yield* startAcpTestSession(adapter, {
        threadId,
        provider: ProviderDriverKind.make('coral'),
        cwd: process.cwd(),
        runtimeMode: 'approval-required',
        resumeCursor: { schemaVersion: 1, sessionId: 'mock-session-1' },
      })
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath))
      const methods = requests.flatMap((entry) =>
        typeof entry.method === 'string' ? [entry.method] : [],
      )

      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: 'mock-session-1',
      })
      assert.include(methods, 'session/resume')
      assert.notInclude(methods, 'session/load')
      assert.notInclude(methods, 'authenticate')
      assert.notInclude(methods, 'session/new')

      yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('does not inject HTTP MCP and applies Core runtime and default turn mode', () =>
    Effect.gen(function* ()
    {
      const threadId = ThreadId.make('coral-session-configuration')
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'coral-session-config-log-')),
      )
      const requestLogPath = NodePath.join(tempDir, 'requests.ndjson')
      const wrapperPath = yield* Effect.promise(() =>
        makeMockCoralWrapper({
          T3_ACP_ADVERTISE_RESUME: '1',
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      )
      const adapter = yield* makeTestAdapter(wrapperPath)
      const environmentId = EnvironmentId.make('coral-test-environment')

      yield* startAcpTestSession(adapter, {
        threadId,
        provider: ProviderDriverKind.make('coral'),
        cwd: process.cwd(),
        runtimeMode: 'approval-required',
        mcp: {
          environmentId,
          threadId,
          providerSessionId: 'coral-provider-session-1',
          providerInstanceId: ProviderInstanceId.make('coral'),
          providerSessionGeneration: 1,
          endpoint: 'http://127.0.0.1:4567/mcp',
          authorizationHeader: 'Bearer first-token',
          previewToolsAvailable: true,
        },
      })
      yield* adapter.sendTurn({
        threadId,
        input: 'describe this change',
        attachments: [],
      })
      yield* waitForRequestLog(
        requestLogPath,
        (entry) => entry.method === 'session/prompt',
        'session/prompt',
      )
      yield* adapter.stopSession(threadId)

      yield* startAcpTestSession(adapter, {
        threadId,
        provider: ProviderDriverKind.make('coral'),
        cwd: process.cwd(),
        runtimeMode: 'approval-required',
        resumeCursor: { schemaVersion: 1, sessionId: 'mock-session-1' },
        mcp: {
          environmentId,
          threadId,
          providerSessionId: 'coral-provider-session-2',
          providerInstanceId: ProviderInstanceId.make('coral'),
          providerSessionGeneration: 2,
          endpoint: 'http://127.0.0.1:4567/mcp',
          authorizationHeader: 'Bearer second-token',
          previewToolsAvailable: true,
        },
      })

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath))
      const newRequest = requests.find((entry) => entry.method === 'session/new')
      const resumeRequest = requests.find((entry) => entry.method === 'session/resume')
      assert.deepInclude(newRequest?.params, {
        mcpServers: [],
      })
      assert.deepInclude(resumeRequest?.params, {
        mcpServers: [],
      })
      const methods = requests.flatMap((entry) =>
        typeof entry.method === 'string' ? [entry.method] : [],
      )
      const runtimeConfigWrites = requests.filter(
        (entry) =>
          entry.method === 'session/set_config_option' &&
          typeof entry.params === 'object' &&
          entry.params !== null &&
          (entry.params as Record<string, unknown>).configId === 'coral.runtime-mode',
      )
      // core already starts on approval-required/default, so those writes are skipped
      assert.deepEqual(
        runtimeConfigWrites.map((entry) => (entry.params as Record<string, unknown>).value),
        [],
      )
      assert.include(methods, 'session/prompt')
      assert.isFalse(
        requests.some(
          (entry) =>
            entry.method === 'session/set_mode' &&
            typeof entry.params === 'object' &&
            entry.params !== null &&
            (entry.params as Record<string, unknown>).modeId === 'plan',
        ),
      )

      yield* adapter.stopSession(threadId)
    }).pipe(TestClock.withLive),
  )

  it.effect('rejects a load-only ACP peer without sending session/load', () =>
    Effect.gen(function* ()
    {
      const threadId = ThreadId.make('coral-requires-native-resume')
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'coral-native-only-log-')),
      )
      const requestLogPath = NodePath.join(tempDir, 'requests.ndjson')
      const wrapperPath = yield* Effect.promise(() =>
        makeMockCoralWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      )
      const adapter = yield* makeTestAdapter(wrapperPath)

      const error = yield* Effect.flip(
        startAcpTestSession(adapter, {
          threadId,
          provider: ProviderDriverKind.make('coral'),
          cwd: process.cwd(),
          runtimeMode: 'approval-required',
          resumeCursor: { schemaVersion: 1, sessionId: 'mock-session-1' },
        }),
      )
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath))
      const methods = requests.flatMap((entry) =>
        typeof entry.method === 'string' ? [entry.method] : [],
      )

      assert.equal(error._tag, 'ProviderAdapterRequestError')
      assert.include(error.message, 'required session/resume support')
      assert.notInclude(methods, 'session/load')
      assert.notInclude(methods, 'session/new')
      assert.isFalse(yield* adapter.hasSession(threadId))
    }),
  )

  it.effect('settles allow and reject through opaque request and provider option ids', () =>
    Effect.gen(function* ()
    {
      const scenarios = [
        {
          label: 'allow',
          decision: 'accept' as const,
          optionEnvironment: { T3_ACP_ALLOW_ONCE_OPTION_ID: 'coral-agent-allow-once' },
          expectedOptionId: 'coral-agent-allow-once',
        },
        {
          label: 'allow-always',
          decision: 'acceptAlways' as const,
          optionEnvironment: { T3_ACP_ALLOW_ALWAYS_OPTION_ID: 'coral-agent-allow-always' },
          expectedOptionId: 'coral-agent-allow-always',
        },
        {
          label: 'reject',
          decision: 'decline' as const,
          optionEnvironment: { T3_ACP_REJECT_ONCE_OPTION_ID: 'coral-agent-reject-once' },
          expectedOptionId: 'coral-agent-reject-once',
        },
      ]

      yield* Effect.forEach(scenarios, (scenario) =>
        Effect.gen(function* ()
        {
          const threadId = ThreadId.make(`coral-approval-${scenario.label}`)
          const tempDir = yield* Effect.promise(() =>
            NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'coral-approval-log-')),
          )
          const requestLogPath = NodePath.join(tempDir, 'requests.ndjson')
          const wrapperPath = yield* Effect.promise(() =>
            makeMockCoralWrapper({
              ...scenario.optionEnvironment,
              T3_ACP_EMIT_TOOL_CALLS: '1',
              T3_ACP_REQUEST_LOG_PATH: requestLogPath,
            }),
          )
          const adapter = yield* makeTestAdapter(wrapperPath)
          const runtimeEvents: Array<ProviderRuntimeEvent> = []
          const eventsFiber = yield* Stream.runForEach(unwrapAcpRuntimeEvents(adapter), (event) =>
            Effect.sync(() => runtimeEvents.push(event)).pipe(
              Effect.andThen(
                event.type === 'request.opened'
                  ? adapter.respondToRequest(
                      threadId,
                      ApprovalRequestId.make(String(event.requestId)),
                      scenario.decision,
                    )
                  : Effect.void,
              ),
            ),
          ).pipe(Effect.forkChild)

          yield* startAcpTestSession(adapter, {
            threadId,
            provider: ProviderDriverKind.make('coral'),
            cwd: process.cwd(),
            runtimeMode: 'approval-required',
          })
          const turn = yield* adapter.sendTurn({
            threadId,
            input: `${scenario.label} the tool`,
            attachments: [],
          })
          yield* waitForRuntimeEvent(
            runtimeEvents,
            (event) =>
              event.type === 'request.resolved' && event.payload.decision === scenario.decision,
            `request.resolved ${scenario.label}`,
          )
          yield* waitForCoralTurnIdle(adapter, threadId, runtimeEvents, turn.turnId)

          const requests = yield* Effect.promise(() => readJsonLines(requestLogPath))
          assert.isTrue(
            requests.some((entry) =>
            {
              if (
                !('result' in entry) ||
                typeof entry.result !== 'object' ||
                entry.result === null
              )
              {
                return false
              }
              const outcome = (entry.result as Record<string, unknown>).outcome
              return (
                typeof outcome === 'object' &&
                outcome !== null &&
                (outcome as Record<string, unknown>).optionId === scenario.expectedOptionId
              )
            }),
          )
          assert.isTrue(
            runtimeEvents.some(
              (event) =>
                event.type === 'request.resolved' && event.payload.decision === scenario.decision,
            ),
          )

          yield* Fiber.interrupt(eventsFiber)
          yield* adapter.stopSession(threadId)
        }),
      )
    }).pipe(TestClock.withLive),
  )

  it.effect('returns sendTurn while a permission request is still open', () =>
    Effect.gen(function* ()
    {
      const threadId = ThreadId.make('coral-send-turn-returns-before-approval')
      const wrapperPath = yield* Effect.promise(() =>
        makeMockCoralWrapper({ T3_ACP_EMIT_TOOL_CALLS: '1' }),
      )
      const adapter = yield* makeTestAdapter(wrapperPath)
      const runtimeEvents: Array<ProviderRuntimeEvent> = []
      const requestOpened = yield* Deferred.make<ApprovalRequestId>()
      const eventsFiber = yield* Stream.runForEach(unwrapAcpRuntimeEvents(adapter), (event) =>
        Effect.sync(() => runtimeEvents.push(event)).pipe(
          Effect.andThen(
            event.type === 'request.opened'
              ? Deferred.succeed(
                  requestOpened,
                  ApprovalRequestId.make(String(event.requestId)),
                ).pipe(Effect.ignore)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild)

      yield* startAcpTestSession(adapter, {
        threadId,
        provider: ProviderDriverKind.make('coral'),
        cwd: process.cwd(),
        runtimeMode: 'approval-required',
      })
      const turn = yield* adapter
        .sendTurn({
          threadId,
          input: 'write a file that needs approval',
          attachments: [],
        })
        .pipe(Effect.timeout('2 seconds'))
      const requestId = yield* Deferred.await(requestOpened).pipe(Effect.timeout('2 seconds'))
      assert.isFalse(runtimeEvents.some((event) => event.type === 'turn.completed'))
      const session = (yield* adapter.listSessions()).find((entry) => entry.threadId === threadId)
      assert.equal(session?.status, 'running')
      assert.equal(session?.activeTurnId, turn.turnId)

      yield* adapter.respondToRequest(threadId, requestId, 'accept')
      yield* waitForCoralTurnIdle(adapter, threadId, runtimeEvents, turn.turnId)

      yield* Fiber.interrupt(eventsFiber)
      yield* adapter.stopSession(threadId)
    }).pipe(TestClock.withLive),
  )

  it.effect('cancels a hung turn once and accepts a follow-up turn', () =>
    Effect.gen(function* ()
    {
      const threadId = ThreadId.make('coral-cancel-follow-up')
      const wrapperPath = yield* Effect.promise(() =>
        makeMockCoralWrapper({ T3_ACP_HANG_FIRST_PROMPT_FOREVER: '1' }),
      )
      const adapter = yield* makeTestAdapter(wrapperPath)
      const runtimeEvents: Array<ProviderRuntimeEvent> = []
      const turnStarted = yield* Deferred.make<void>()
      const eventsFiber = yield* Stream.runForEach(unwrapAcpRuntimeEvents(adapter), (event) =>
        Effect.sync(() => runtimeEvents.push(event)).pipe(
          Effect.andThen(
            event.type === 'turn.started' ? Deferred.succeed(turnStarted, undefined) : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild)

      yield* startAcpTestSession(adapter, {
        threadId,
        provider: ProviderDriverKind.make('coral'),
        cwd: process.cwd(),
        runtimeMode: 'approval-required',
      })
      yield* adapter.sendTurn({ threadId, input: 'cancel this turn', attachments: [] })
      yield* Deferred.await(turnStarted)
      yield* Effect.sleep('100 millis')
      yield* adapter.interruptTurn(threadId)
      const followUp = yield* adapter.sendTurn({
        threadId,
        input: 'continue after cancellation',
        attachments: [],
      })
      yield* waitForCoralTurnIdle(adapter, threadId, runtimeEvents, followUp.turnId)

      const completions = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: 'turn.completed' }> =>
          event.type === 'turn.completed',
      )
      assert.deepEqual(
        completions.map((event) => event.payload.state),
        ['cancelled', 'completed'],
      )
      const session = (yield* adapter.listSessions()).find((entry) => entry.threadId === threadId)
      assert.equal(session?.status, 'ready')
      assert.isUndefined(session?.activeTurnId)

      yield* Fiber.interrupt(eventsFiber)
      yield* adapter.stopSession(threadId)
    }).pipe(TestClock.withLive),
  )

  it.effect('finalizes an active Coral session once after abnormal child exit', () =>
    Effect.gen(function* ()
    {
      const wrapperPath = yield* Effect.promise(() =>
        makeMockCoralWrapper({
          T3_ACP_EMIT_TOOL_CALLS: '1',
          T3_ACP_EXIT_DURING_PROMPT_CODE: '9',
          T3_ACP_EXIT_DURING_PROMPT_DELAY_MS: '100',
        }),
      )
      const adapter = yield* makeTestAdapter(wrapperPath, {
        enableAbnormalTermination: true,
      })

      yield* assertAbnormalChildExitFinalizesOnce(adapter, {
        threadId: ThreadId.make('coral-abnormal-exit'),
        provider: ProviderDriverKind.make('coral'),
        label: 'Coral',
        promptInFlight: 'race-session-drop',
      })
    }),
  )
})
