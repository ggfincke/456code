// tests/apps/server/provider/Layers/GrokAdapter.test.ts
// verifies Grok ACP session behavior

// @effect-diagnostics globalTimers:off - session-drop polls need wall-clock waits; the test clock freezes Effect.sleep
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from 'node:path'
import * as NodeOS from 'node:os'
import * as NodeFSP from 'node:fs/promises'
import * as NodeURL from 'node:url'

import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, it } from '@effect/vitest'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Ref from 'effect/Ref'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import * as TestClock from 'effect/testing/TestClock'

import {
  STRICT_IMPORT_RESUME_CURSOR,
  assertActiveImportedSessionBlocksFreshStart,
  assertInvalidStrictMarkerPreservesActive,
  assertMalformedStrictImportRejected,
  assertMissingImportedSessionRejected,
  assertStrictImportMarkerPreserved,
} from './acpImportLineageTestHelpers.ts'
import {
  assertAbnormalChildExitFinalizesOnce,
  assertAbnormalExitDisabledByDefault,
  assertConcurrentStartSerializesSameThread,
  assertOneExitWhenStopRacesTermination,
  assertStopClosesAcpChild,
  startAcpTestSession,
  unwrapAcpRuntimeEvents,
  waitForAcpSessionDrop,
} from './acpLifecycleTestHelpers.ts'
import {
  ApprovalRequestId,
  GrokSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from '@t3tools/contracts'

import { ServerConfig } from '../../../../../apps/server/src/config.ts'
import {
  grokPromptSettlementBelongsToContext,
  makeGrokAdapter,
} from '../../../../../apps/server/src/provider/Layers/GrokAdapter.ts'
import type {
  ProviderAdapterRuntimeEvent,
  ProviderAdapterRuntimeSessionBinding,
} from '../../../../../apps/server/src/provider/Services/ProviderAdapter.ts'
import {
  makeTestMcpProviderSession,
  TEST_MCP_AUTHORIZATION,
  TEST_MCP_ENDPOINT,
} from './mcpProviderSessionTestHelpers.ts'
const decodeGrokSettings = Schema.decodeSync(GrokSettings)

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url))
const mockAgentPath = NodePath.join(
  __dirname,
  '../../../../../apps/server/scripts/acp-mock-agent.ts',
)
const mockAgentCommand = process.execPath

async function makeMockGrokWrapper(
  extraEnv?: Record<string, string>,
  options?: { initialDelaySeconds?: number },
)
{
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'grok-acp-mock-'))
  const wrapperPath = NodePath.join(dir, 'fake-grok.sh')
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join('\n')
  const script = `#!/bin/sh
${envExports}
${options?.initialDelaySeconds ? `sleep ${JSON.stringify(String(options.initialDelaySeconds))}` : ''}
exec ${JSON.stringify(mockAgentCommand)} ${JSON.stringify(mockAgentPath)} "$@"
`
  await NodeFSP.writeFile(wrapperPath, script, 'utf8')
  await NodeFSP.chmod(wrapperPath, 0o755)
  return wrapperPath
}

function waitForFileContent(
  filePath: string,
  attempts = 40,
  expectedContent?: string,
): Effect.Effect<string>
{
  const readAttempt = (remainingAttempts: number): Effect.Effect<string> =>
    Effect.gen(function* ()
    {
      if (remainingAttempts <= 0)
      {
        return yield* Effect.die(new Error(`Timed out waiting for file content at ${filePath}`))
      }
      const raw = yield* Effect.tryPromise(() => NodeFSP.readFile(filePath, 'utf8')).pipe(
        Effect.orElseSucceed(() => ''),
      )
      if (
        raw.trim().length > 0 &&
        (expectedContent === undefined || raw.includes(expectedContent))
      )
      {
        return raw
      }
      yield* Effect.sleep('25 millis')
      return yield* readAttempt(remainingAttempts - 1)
    })
  return readAttempt(attempts)
}

async function readJsonLines(filePath: string)
{
  const raw = await NodeFSP.readFile(filePath, 'utf8')
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

const grokAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: 't3code-grok-adapter-test-',
}).pipe(Layer.provideMerge(NodeServices.layer))

const makeTestAdapter = (binaryPath: string, options?: Parameters<typeof makeGrokAdapter>[1]) =>
  makeGrokAdapter(decodeGrokSettings({ binaryPath }), options).pipe(Effect.orDie)

function waitForGrokSessionDrop(
  adapter: Effect.Success<ReturnType<typeof makeTestAdapter>>,
  threadId: ThreadId,
): Effect.Effect<void>
{
  return waitForAcpSessionDrop(adapter, threadId, 'Grok')
}

it('requires a settlement to match the live Grok turn', () =>
{
  const staleTurnId = TurnId.make('stale-turn')
  const replacementTurnId = TurnId.make('replacement-turn')

  assert.isFalse(
    grokPromptSettlementBelongsToContext({
      liveAcpSessionId: 'session-1',
      expectedAcpSessionId: 'session-1',
      liveActiveTurnId: replacementTurnId,
      liveSessionActiveTurnId: replacementTurnId,
      turnId: staleTurnId,
    }),
  )
  assert.isFalse(
    grokPromptSettlementBelongsToContext({
      liveAcpSessionId: 'replacement-session',
      expectedAcpSessionId: 'stale-session',
      liveActiveTurnId: staleTurnId,
      liveSessionActiveTurnId: staleTurnId,
      turnId: staleTurnId,
    }),
  )
  assert.isTrue(
    grokPromptSettlementBelongsToContext({
      liveAcpSessionId: 'session-1',
      expectedAcpSessionId: 'session-1',
      liveActiveTurnId: staleTurnId,
      liveSessionActiveTurnId: staleTurnId,
      turnId: staleTurnId,
    }),
  )
})

it.layer(grokAdapterTestLayer)('GrokAdapterLive', (it) =>
{
  it.effect('passes the scoped MCP endpoint and bearer header to Grok ACP', () =>
    Effect.gen(function* ()
    {
      const threadId = ThreadId.make('grok-mcp-probe')
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'grok-acp-')),
      )
      const requestLogPath = NodePath.join(tempDir, 'requests.ndjson')
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, '', 'utf8'))
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      )
      const adapter = yield* makeTestAdapter(wrapperPath)

      yield* startAcpTestSession(adapter, {
        threadId,
        provider: ProviderDriverKind.make('grok'),
        cwd: process.cwd(),
        runtimeMode: 'full-access',
        mcp: makeTestMcpProviderSession(threadId, ProviderInstanceId.make('grok')),
      })
      yield* waitForFileContent(requestLogPath)
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath))
      const sessionStart = requests.find((entry) => entry.method === 'session/new')

      assert.deepStrictEqual(
        (sessionStart?.params as Record<string, unknown> | undefined)?.mcpServers,
        [
          {
            type: 'http',
            name: 'code456',
            url: TEST_MCP_ENDPOINT,
            headers: [{ name: 'Authorization', value: TEST_MCP_AUTHORIZATION }],
          },
        ],
      )
      yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('preserves the strict import marker through a successful Grok turn', () =>
    Effect.gen(function* ()
    {
      const threadId = ThreadId.make('grok-import-strict-marker')
      const wrapperPath = yield* Effect.promise(() => makeMockGrokWrapper())
      const adapter = yield* makeTestAdapter(wrapperPath)

      const session = yield* startAcpTestSession(adapter, {
        threadId,
        provider: ProviderDriverKind.make('grok'),
        cwd: process.cwd(),
        runtimeMode: 'approval-required',
        modelSelection: {
          instanceId: ProviderInstanceId.make('grok'),
          model: 'grok-build',
        },
        resumeCursor: STRICT_IMPORT_RESUME_CURSOR,
      })
      const turn = yield* adapter.sendTurn({
        threadId,
        input: 'continue imported Grok session',
        attachments: [],
      })
      const listed = (yield* adapter.listSessions()).find((entry) => entry.threadId === threadId)

      assertStrictImportMarkerPreserved({
        sessionResumeCursor: session.resumeCursor,
        turnResumeCursor: turn.resumeCursor,
        listedResumeCursor: listed?.resumeCursor,
      })

      yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('rejects a malformed strict Grok cursor before starting the native session', () =>
    Effect.gen(function* ()
    {
      const threadId = ThreadId.make('grok-import-malformed-strict')
      const adapter = yield* makeTestAdapter('/definitely/missing/grok')

      const error = yield* Effect.flip(
        startAcpTestSession(adapter, {
          threadId,
          provider: ProviderDriverKind.make('grok'),
          cwd: process.cwd(),
          runtimeMode: 'approval-required',
          modelSelection: {
            instanceId: ProviderInstanceId.make('grok'),
            model: 'grok-build',
          },
          resumeCursor: {
            schemaVersion: 1,
            sessionId: ' ',
            requireExisting: true,
          },
        }),
      )

      yield* assertMalformedStrictImportRejected(adapter, threadId, error)
    }),
  )

  it.effect('rejects an invalid strict marker without stopping the active Grok session', () =>
    Effect.gen(function* ()
    {
      const threadId = ThreadId.make('grok-import-invalid-marker-active')
      const wrapperPath = yield* Effect.promise(() => makeMockGrokWrapper())
      const adapter = yield* makeTestAdapter(wrapperPath)

      const active = yield* startAcpTestSession(adapter, {
        threadId,
        provider: ProviderDriverKind.make('grok'),
        cwd: process.cwd(),
        runtimeMode: 'approval-required',
        modelSelection: {
          instanceId: ProviderInstanceId.make('grok'),
          model: 'grok-build',
        },
      })
      const error = yield* Effect.flip(
        startAcpTestSession(adapter, {
          threadId,
          provider: ProviderDriverKind.make('grok'),
          cwd: process.cwd(),
          runtimeMode: 'approval-required',
          modelSelection: {
            instanceId: ProviderInstanceId.make('grok'),
            model: 'grok-build',
          },
          resumeCursor: {
            schemaVersion: 1,
            sessionId: 'mock-session-1',
            requireExisting: 'true',
          },
        }),
      )

      yield* assertInvalidStrictMarkerPreservesActive(adapter, threadId, error, active.resumeCursor)

      yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('never replaces a missing imported Grok session with a fresh session', () =>
    Effect.gen(function* ()
    {
      const threadId = ThreadId.make('grok-import-strict-resume')
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({ T3_ACP_FAIL_LOAD_SESSION: '1' }),
      )
      const adapter = yield* makeTestAdapter(wrapperPath)

      const error = yield* Effect.flip(
        startAcpTestSession(adapter, {
          threadId,
          provider: ProviderDriverKind.make('grok'),
          cwd: process.cwd(),
          runtimeMode: 'approval-required',
          modelSelection: {
            instanceId: ProviderInstanceId.make('grok'),
            model: 'grok-build',
          },
          resumeCursor: {
            schemaVersion: 1,
            sessionId: 'missing-imported-session',
            requireExisting: true,
          },
        }),
      )

      yield* assertMissingImportedSessionRejected(adapter, threadId, error)
    }),
  )

  it.effect('requires an explicit stop before replacing an active imported Grok session', () =>
    Effect.gen(function* ()
    {
      const threadId = ThreadId.make('grok-import-active-lineage')
      const wrapperPath = yield* Effect.promise(() => makeMockGrokWrapper())
      const adapter = yield* makeTestAdapter(wrapperPath)

      const imported = yield* startAcpTestSession(adapter, {
        threadId,
        provider: ProviderDriverKind.make('grok'),
        cwd: process.cwd(),
        runtimeMode: 'approval-required',
        modelSelection: {
          instanceId: ProviderInstanceId.make('grok'),
          model: 'grok-build',
        },
        resumeCursor: STRICT_IMPORT_RESUME_CURSOR,
      })
      const error = yield* Effect.flip(
        startAcpTestSession(adapter, {
          threadId,
          provider: ProviderDriverKind.make('grok'),
          cwd: process.cwd(),
          runtimeMode: 'full-access',
          modelSelection: {
            instanceId: ProviderInstanceId.make('grok'),
            model: 'grok-build',
          },
        }),
      )

      yield* assertActiveImportedSessionBlocksFreshStart(
        adapter,
        threadId,
        error,
        imported.resumeCursor,
      )

      yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('starts a session and maps mock ACP prompt flow to runtime events', () =>
    Effect.gen(function* ()
    {
      const threadId = ThreadId.make('grok-mock-thread')
      const wrapperPath = yield* Effect.promise(() => makeMockGrokWrapper())
      const adapter = yield* makeTestAdapter(wrapperPath)

      const runtimeEvents: ProviderRuntimeEvent[] = []
      const turnCompleted = yield* Deferred.make<void>()
      const runtimeEventsFiber = yield* Stream.runForEach(
        unwrapAcpRuntimeEvents(adapter),
        (event) =>
          Effect.sync(() =>
          {
            runtimeEvents.push(event)
          }).pipe(
            Effect.andThen(
              event.type === 'turn.completed'
                ? Deferred.succeed(turnCompleted, undefined)
                : Effect.void,
            ),
          ),
      ).pipe(Effect.forkChild)

      const session = yield* startAcpTestSession(adapter, {
        threadId,
        provider: ProviderDriverKind.make('grok'),
        cwd: process.cwd(),
        runtimeMode: 'full-access',
        modelSelection: { instanceId: ProviderInstanceId.make('grok'), model: 'grok-mock-alt' },
      })

      assert.equal(session.provider, 'grok')
      assert.equal(session.model, 'grok-mock-alt')
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: 'mock-session-1',
      })

      yield* adapter.sendTurn({
        threadId,
        input: 'hello grok',
        attachments: [],
      })

      yield* Deferred.await(turnCompleted)
      yield* Fiber.interrupt(runtimeEventsFiber)
      const types = runtimeEvents.map((e) => e.type)

      assert.includeMembers(types, [
        'session.started',
        'session.state.changed',
        'thread.started',
        'turn.started',
        'item.started',
        'content.delta',
        'turn.completed',
      ] as const)

      const delta = runtimeEvents.find((e) => e.type === 'content.delta')
      assert.isDefined(delta)
      if (delta?.type === 'content.delta')
      {
        assert.equal(delta.payload.delta, 'hello from mock')
      }

      yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('closes the ACP child process when a session stops', () =>
    Effect.gen(function* ()
    {
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'grok-adapter-exit-log-')),
      )
      const exitLogPath = NodePath.join(tempDir, 'exit.log')
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({ T3_ACP_EXIT_LOG_PATH: exitLogPath }),
      )
      const adapter = yield* makeTestAdapter(wrapperPath)

      yield* assertStopClosesAcpChild(adapter, {
        threadId: ThreadId.make('grok-stop-session-close'),
        provider: ProviderDriverKind.make('grok'),
        modelSelection: { instanceId: ProviderInstanceId.make('grok'), model: 'grok-build' },
        readExitLog: waitForFileContent(exitLogPath),
      })
    }),
  )

  it.effect('finalizes an active Grok session once when its ACP child exits', () =>
    Effect.gen(function* ()
    {
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_TOOL_CALLS: '1',
          T3_ACP_EXIT_DURING_PROMPT_CODE: '9',
          T3_ACP_EXIT_DURING_PROMPT_DELAY_MS: '100',
        }),
      )
      const adapter = yield* makeTestAdapter(wrapperPath, {
        enableAbnormalTermination: true,
      })

      yield* assertAbnormalChildExitFinalizesOnce(adapter, {
        threadId: ThreadId.make('grok-abnormal-child-exit'),
        provider: ProviderDriverKind.make('grok'),
        label: 'Grok',
        promptInFlight: 'race-session-drop',
      })
    }),
  )

  it.effect('keeps abnormal Grok exit emission disabled by default', () =>
    Effect.gen(function* ()
    {
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({ T3_ACP_EXIT_DURING_PROMPT_CODE: '9' }),
      )
      const adapter = yield* makeTestAdapter(wrapperPath)

      yield* assertAbnormalExitDisabledByDefault(adapter, {
        threadId: ThreadId.make('grok-abnormal-child-exit-disabled'),
        provider: ProviderDriverKind.make('grok'),
        label: 'Grok',
      })
    }),
  )

  it.effect('emits one Grok exit when graceful stop races ACP termination', () =>
    Effect.gen(function* ()
    {
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({ T3_ACP_EXIT_DURING_PROMPT_CODE: '9' }),
      )
      const adapter = yield* makeTestAdapter(wrapperPath, {
        enableAbnormalTermination: true,
      })

      yield* assertOneExitWhenStopRacesTermination(adapter, {
        threadId: ThreadId.make('grok-stop-termination-race'),
        provider: ProviderDriverKind.make('grok'),
        label: 'Grok',
      })
    }),
  )

  it.effect('serializes concurrent Grok starts and closes both same-thread ACP sessions', () =>
    Effect.gen(function* ()
    {
      const threadId = ThreadId.make('grok-concurrent-start-session')
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'grok-adapter-concurrent-exit-log-')),
      )
      const exitLogPath = NodePath.join(tempDir, 'exit.log')
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({ T3_ACP_EXIT_LOG_PATH: exitLogPath }, { initialDelaySeconds: 0.2 }),
      )
      const adapter = yield* makeTestAdapter(wrapperPath)

      yield* assertConcurrentStartSerializesSameThread(adapter, {
        threadId,
        provider: ProviderDriverKind.make('grok'),
        modelSelection: {
          instanceId: ProviderInstanceId.make('grok'),
          model: 'grok-build',
        },
        readExitLog: waitForFileContent(exitLogPath),
      })
    }),
  )

  it.effect('drops delayed prompt settlement after the same native session id is rebound', () =>
    Effect.gen(function* ()
    {
      const threadId = ThreadId.make('grok-rebound-native-session')
      const providerInstanceId = ProviderInstanceId.make('grok')
      const staleBinding = {
        providerInstanceId,
        threadId,
        sessionGeneration: 1,
      } satisfies ProviderAdapterRuntimeSessionBinding
      const replacementBinding = {
        providerInstanceId,
        threadId,
        sessionGeneration: 2,
      } satisfies ProviderAdapterRuntimeSessionBinding
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'grok-rebound-native-session-')),
      )
      const requestLogPath = NodePath.join(tempDir, 'requests.ndjson')
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_PROMPT_DELAY_MS: '30000',
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      )
      const adapter = yield* makeTestAdapter(wrapperPath)
      const envelopes: ProviderAdapterRuntimeEvent[] = []
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (envelope) =>
        Effect.sync(() => envelopes.push(envelope)),
      ).pipe(Effect.forkChild)

      const staleSession = yield* startAcpTestSession(adapter, {
        threadId,
        provider: ProviderDriverKind.make('grok'),
        cwd: process.cwd(),
        runtimeMode: 'full-access',
        runtimeSessionBinding: staleBinding,
      })
      const staleTurnFiber = yield* adapter
        .sendTurn({ threadId, input: 'finish after replacement', attachments: [] })
        .pipe(Effect.result, Effect.forkChild)
      yield* waitForFileContent(requestLogPath, 80, '"method":"session/prompt"')

      const replacementSession = yield* startAcpTestSession(adapter, {
        threadId,
        provider: ProviderDriverKind.make('grok'),
        cwd: process.cwd(),
        runtimeMode: 'full-access',
        runtimeSessionBinding: replacementBinding,
      })
      yield* Fiber.join(staleTurnFiber).pipe(Effect.timeout('2 seconds'))
      for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1)
      {
        yield* Effect.yieldNow
      }

      const liveSession = (yield* adapter.listSessions()).find(
        (session) => session.threadId === threadId,
      )
      const snapshot = yield* adapter.readThread(threadId)
      const terminalTurnEnvelopes = envelopes.filter(({ event }) => event.type === 'turn.completed')
      const replacementTurnEnvelopes = envelopes.filter(
        ({ binding, event }) =>
          binding.sessionGeneration === replacementBinding.sessionGeneration &&
          (event.type === 'turn.started' || event.type === 'turn.completed'),
      )

      assert.deepEqual(staleSession.resumeCursor, replacementSession.resumeCursor)
      assert.deepEqual(yield* adapter.getSessionRuntimeBinding(threadId), replacementBinding)
      assert.equal(liveSession?.status, 'ready')
      assert.isUndefined(liveSession?.activeTurnId)
      assert.deepEqual(snapshot.turns, [])
      assert.deepEqual(terminalTurnEnvelopes, [])
      assert.deepEqual(replacementTurnEnvelopes, [])

      yield* Fiber.interrupt(eventsFiber)
      yield* adapter.stopSession(threadId)
    }).pipe(TestClock.withLive),
  )

  it.effect('reports a Grok session running only while the prompt is in flight', () =>
    Effect.gen(function* ()
    {
      const threadId = ThreadId.make('grok-session-ready-after-prompt')
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_TOOL_CALLS: '1',
        }),
      )
      const adapter = yield* makeTestAdapter(wrapperPath)
      const requestOpened =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: 'request.opened' }>>()
      const eventsFiber = yield* Stream.runForEach(unwrapAcpRuntimeEvents(adapter), (event) =>
        event.type === 'request.opened'
          ? Deferred.succeed(requestOpened, event).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkChild)

      yield* startAcpTestSession(adapter, {
        threadId,
        provider: ProviderDriverKind.make('grok'),
        cwd: process.cwd(),
        runtimeMode: 'approval-required',
        modelSelection: { instanceId: ProviderInstanceId.make('grok'), model: 'grok-build' },
      })

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: 'check lifecycle', attachments: [] })
        .pipe(Effect.forkChild)
      const requestOpenedEvent = yield* Deferred.await(requestOpened)

      const runningSessions = yield* adapter.listSessions()
      const runningSession = runningSessions.find((session) => session.threadId === threadId)
      assert.equal(runningSession?.status, 'running')
      assert.isDefined(runningSession?.activeTurnId)

      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(String(requestOpenedEvent.requestId)),
        'accept',
      )
      yield* Fiber.join(sendTurnFiber)

      const readySessions = yield* adapter.listSessions()
      const readySession = readySessions.find((session) => session.threadId === threadId)
      assert.equal(readySession?.status, 'ready')
      assert.isUndefined(readySession?.activeTurnId)

      yield* Fiber.interrupt(eventsFiber)
      yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('restores ready without completing an unstarted turn when preparation fails', () =>
    Effect.gen(function* ()
    {
      const threadId = ThreadId.make('grok-preparation-failure-while-connecting')
      const wrapperPath = yield* Effect.promise(() => makeMockGrokWrapper())
      const adapter = yield* makeTestAdapter(wrapperPath)

      const runtimeEvents: ProviderRuntimeEvent[] = []
      const runtimeEventsFiber = yield* Stream.runForEach(
        unwrapAcpRuntimeEvents(adapter),
        (event) =>
          Effect.sync(() =>
          {
            runtimeEvents.push(event)
          }),
      ).pipe(Effect.forkChild)

      yield* startAcpTestSession(adapter, {
        threadId,
        provider: ProviderDriverKind.make('grok'),
        cwd: process.cwd(),
        runtimeMode: 'full-access',
        modelSelection: { instanceId: ProviderInstanceId.make('grok'), model: 'grok-build' },
      })

      const error = yield* Effect.flip(
        adapter.sendTurn({
          threadId,
          input: 'prepare invalid attachment',
          attachments: [
            {
              type: 'image',
              id: 'missing-image',
              name: 'missing.png',
              mimeType: 'image/png',
              sizeBytes: 1,
            },
          ],
        }),
      )
      for (let yieldAttempt = 0; yieldAttempt < 4; yieldAttempt += 1)
      {
        yield* Effect.yieldNow
      }

      const turnCompletedEvent = runtimeEvents.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: 'turn.completed' }> =>
          event.type === 'turn.completed',
      )
      const readySessions = yield* adapter.listSessions()
      const readySession = readySessions.find((session) => session.threadId === threadId)

      assert.equal(error._tag, 'ProviderAdapterRequestError')
      assert.isUndefined(turnCompletedEvent)
      assert.equal(readySession?.status, 'ready')
      assert.isUndefined(readySession?.activeTurnId)

      yield* Fiber.interrupt(runtimeEventsFiber)
      yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('completes a Grok turn from xAI prompt completion when the prompt RPC hangs', () =>
    Effect.gen(function* ()
    {
      const threadId = ThreadId.make('grok-xai-prompt-complete-fallback')
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_XAI_PROMPT_COMPLETE_THEN_HANG: '1',
          T3_ACP_EMIT_FOREIGN_SESSION_UPDATES: '1',
        }),
      )
      const adapter = yield* makeTestAdapter(wrapperPath)

      const runtimeEvents: ProviderRuntimeEvent[] = []
      const turnCompleted = yield* Deferred.make<void>()
      const runtimeEventsFiber = yield* Stream.runForEach(
        unwrapAcpRuntimeEvents(adapter),
        (event) =>
          Effect.sync(() =>
          {
            runtimeEvents.push(event)
          }).pipe(
            Effect.andThen(
              event.type === 'turn.completed'
                ? Deferred.succeed(turnCompleted, undefined)
                : Effect.void,
            ),
          ),
      ).pipe(Effect.forkChild)

      yield* startAcpTestSession(adapter, {
        threadId,
        provider: ProviderDriverKind.make('grok'),
        cwd: process.cwd(),
        runtimeMode: 'full-access',
        modelSelection: { instanceId: ProviderInstanceId.make('grok'), model: 'grok-build' },
      })

      const sendTurnResult = yield* adapter.sendTurn({
        threadId,
        input: 'exercise fallback',
        attachments: [],
      })

      yield* Deferred.await(turnCompleted)
      for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1)
      {
        yield* Effect.yieldNow
      }
      const readySessions = yield* adapter.listSessions()
      const readySession = readySessions.find((session) => session.threadId === threadId)
      const turnCompletedEvent = runtimeEvents.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: 'turn.completed' }> =>
          event.type === 'turn.completed',
      )
      const eventTypes = runtimeEvents.map((event) => event.type)
      const content = runtimeEvents
        .filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: 'content.delta' }> =>
            event.type === 'content.delta' && String(event.threadId) === String(threadId),
        )
        .map((event) => event.payload.delta)
        .join('')
      const terminalIndex = runtimeEvents.findIndex(
        (event) => event.type === 'turn.completed' && String(event.threadId) === String(threadId),
      )
      const turnOutputTypes = new Set([
        'content.delta',
        'item.started',
        'item.updated',
        'item.completed',
        'turn.plan.updated',
      ])
      const outputAfterTerminal = runtimeEvents
        .slice(terminalIndex + 1)
        .filter(
          (event) => String(event.threadId) === String(threadId) && turnOutputTypes.has(event.type),
        )
      const toolTitles = runtimeEvents.flatMap((event) =>
        event.type === 'item.updated' && event.payload.title ? [event.payload.title] : [],
      )

      assert.equal(sendTurnResult.threadId, threadId)
      assert.include(eventTypes, 'turn.completed')
      assert.equal(content, 'hello from mock')
      assert.isAtLeast(terminalIndex, 0)
      assert.deepEqual(outputAfterTerminal, [])
      assert.notInclude(toolTitles, 'Child-only tool')
      assert.equal(turnCompletedEvent?.payload.stopReason, 'end_turn')
      assert.equal(readySession?.status, 'ready')
      assert.isUndefined(readySession?.activeTurnId)

      yield* Fiber.interrupt(runtimeEventsFiber)
      yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('retains turn transcript when sendTurn is interrupted after prompt success', () =>
    Effect.gen(function* ()
    {
      const threadId = ThreadId.make('grok-send-turn-interrupt-after-prompt')
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_XAI_PROMPT_COMPLETE_THEN_HANG: '1',
        }),
      )
      const adapter = yield* makeTestAdapter(wrapperPath)
      const contentDelta = yield* Deferred.make<void>()
      const runtimeEventsFiber = yield* Stream.runForEach(
        unwrapAcpRuntimeEvents(adapter),
        (event) =>
          event.type === 'content.delta' ? Deferred.succeed(contentDelta, undefined) : Effect.void,
      ).pipe(Effect.forkChild)

      yield* startAcpTestSession(adapter, {
        threadId,
        provider: ProviderDriverKind.make('grok'),
        cwd: process.cwd(),
        runtimeMode: 'full-access',
        modelSelection: { instanceId: ProviderInstanceId.make('grok'), model: 'grok-build' },
      })

      const sendTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: 'interrupt after prompt',
          attachments: [],
        })
        .pipe(Effect.forkChild)

      yield* Deferred.await(contentDelta)
      for (let yieldAttempt = 0; yieldAttempt < 6; yieldAttempt += 1)
      {
        yield* Effect.yieldNow
      }
      yield* Fiber.interrupt(sendTurnFiber)
      for (let yieldAttempt = 0; yieldAttempt < 4; yieldAttempt += 1)
      {
        yield* Effect.yieldNow
      }

      const snapshot = yield* adapter.readThread(threadId)
      assert.equal(snapshot.turns.length, 1)
      assert.equal(snapshot.turns[0]?.items.length, 1)

      yield* Fiber.interrupt(runtimeEventsFiber)
      yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('does not report a synthetic stop reason when xAI omits one', () =>
    Effect.gen(function* ()
    {
      const threadId = ThreadId.make('grok-xai-prompt-complete-missing-stop-reason')
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_XAI_PROMPT_COMPLETE_THEN_HANG: '1',
          T3_ACP_OMIT_XAI_PROMPT_COMPLETE_STOP_REASON: '1',
        }),
      )
      const adapter = yield* makeTestAdapter(wrapperPath)

      const runtimeEvents: ProviderRuntimeEvent[] = []
      const turnCompleted = yield* Deferred.make<void>()
      const runtimeEventsFiber = yield* Stream.runForEach(
        unwrapAcpRuntimeEvents(adapter),
        (event) =>
          Effect.sync(() =>
          {
            runtimeEvents.push(event)
          }).pipe(
            Effect.andThen(
              event.type === 'turn.completed'
                ? Deferred.succeed(turnCompleted, undefined)
                : Effect.void,
            ),
          ),
      ).pipe(Effect.forkChild)

      yield* startAcpTestSession(adapter, {
        threadId,
        provider: ProviderDriverKind.make('grok'),
        cwd: process.cwd(),
        runtimeMode: 'full-access',
        modelSelection: { instanceId: ProviderInstanceId.make('grok'), model: 'grok-build' },
      })

      yield* adapter.sendTurn({
        threadId,
        input: 'exercise missing stop reason',
        attachments: [],
      })

      yield* Deferred.await(turnCompleted)
      const turnCompletedEvent = runtimeEvents.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: 'turn.completed' }> =>
          event.type === 'turn.completed',
      )

      assert.equal(turnCompletedEvent?.payload.state, 'completed')
      assert.isNull(turnCompletedEvent?.payload.stopReason)

      yield* Fiber.interrupt(runtimeEventsFiber)
      yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('lets Stop unblock a fully silent Grok prompt and accept a follow-up turn', () =>
    Effect.gen(function* ()
    {
      const threadId = ThreadId.make('grok-stop-after-full-silence')
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_HANG_FIRST_PROMPT_FOREVER: '1',
        }),
      )
      const adapter = yield* makeTestAdapter(wrapperPath)

      const runtimeEvents: ProviderRuntimeEvent[] = []
      const runtimeEventsFiber = yield* Stream.runForEach(
        unwrapAcpRuntimeEvents(adapter),
        (event) =>
          Effect.sync(() =>
          {
            runtimeEvents.push(event)
          }),
      ).pipe(Effect.forkChild)

      yield* startAcpTestSession(adapter, {
        threadId,
        provider: ProviderDriverKind.make('grok'),
        cwd: process.cwd(),
        runtimeMode: 'full-access',
        modelSelection: { instanceId: ProviderInstanceId.make('grok'), model: 'grok-build' },
      })

      yield* Effect.gen(function* ()
      {
        yield* Effect.sleep('500 millis')
        yield* adapter.interruptTurn(threadId)
      }).pipe(Effect.forkChild({ startImmediately: true }))

      yield* adapter.sendTurn({
        threadId,
        input: 'hang forever',
        attachments: [],
      })
      for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1)
      {
        yield* Effect.yieldNow
      }

      const cancelledEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: 'turn.completed' }> =>
          event.type === 'turn.completed' && String(event.threadId) === String(threadId),
      )
      const readySessions = yield* adapter.listSessions()
      const readySession = readySessions.find((session) => session.threadId === threadId)

      assert.lengthOf(cancelledEvents, 1)
      assert.equal(cancelledEvents[0]?.payload.state, 'cancelled')
      assert.equal(readySession?.status, 'ready')
      assert.isUndefined(readySession?.activeTurnId)

      const followUpEventsBefore = runtimeEvents.length
      yield* adapter.sendTurn({
        threadId,
        input: 'continue after stop',
        attachments: [],
      })
      for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1)
      {
        yield* Effect.yieldNow
      }

      const followUpCompletedEvents = runtimeEvents
        .slice(followUpEventsBefore)
        .filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: 'turn.completed' }> =>
            event.type === 'turn.completed' && String(event.threadId) === String(threadId),
        )
      assert.lengthOf(followUpCompletedEvents, 1)
      assert.equal(followUpCompletedEvents[0]?.payload.state, 'completed')

      yield* Fiber.interrupt(runtimeEventsFiber)
      yield* adapter.stopSession(threadId)
    }).pipe(TestClock.withLive),
  )

  it.effect('does not let a cancelled prompt settlement consume the follow-up prompt slot', () =>
    Effect.gen(function* ()
    {
      const threadId = ThreadId.make('grok-cancelled-settlement-before-follow-up')
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'grok-acp-cancel-race-')),
      )
      const requestLogPath = NodePath.join(tempDir, 'requests.ndjson')
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_HANG_FIRST_PROMPT_FOREVER: '1',
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      )
      const adapter = yield* makeTestAdapter(wrapperPath)

      const runtimeEvents: ProviderRuntimeEvent[] = []
      const firstTurnStarted = yield* Deferred.make<TurnId>()
      const twoTurnsCompleted = yield* Deferred.make<void>()
      const completedCountRef = yield* Ref.make(0)
      const runtimeEventsFiber = yield* Stream.runForEach(
        unwrapAcpRuntimeEvents(adapter),
        (event) =>
          Effect.gen(function* ()
          {
            runtimeEvents.push(event)
            if (String(event.threadId) !== String(threadId))
            {
              return
            }
            if (event.type === 'turn.started' && event.turnId !== undefined)
            {
              yield* Deferred.succeed(firstTurnStarted, event.turnId).pipe(Effect.ignore)
              return
            }
            if (event.type !== 'turn.completed')
            {
              return
            }
            const completedCount = yield* Ref.updateAndGet(completedCountRef, (count) => count + 1)
            if (completedCount === 2)
            {
              yield* Deferred.succeed(twoTurnsCompleted, undefined)
            }
          }),
      ).pipe(Effect.forkChild)

      yield* startAcpTestSession(adapter, {
        threadId,
        provider: ProviderDriverKind.make('grok'),
        cwd: process.cwd(),
        runtimeMode: 'full-access',
      })

      const firstSendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: 'cancel this prompt', attachments: [] })
        .pipe(Effect.forkChild)
      const firstTurnId = yield* Deferred.await(firstTurnStarted).pipe(Effect.timeout('2 seconds'))
      yield* waitForFileContent(requestLogPath, 80, '"method":"session/prompt"')

      yield* adapter.interruptTurn(threadId, firstTurnId).pipe(Effect.timeout('2 seconds'))
      const followUp = yield* adapter
        .sendTurn({ threadId, input: 'complete the follow-up', attachments: [] })
        .pipe(Effect.timeout('2 seconds'))
      yield* Fiber.join(firstSendTurnFiber).pipe(Effect.timeout('2 seconds'))
      yield* Deferred.await(twoTurnsCompleted).pipe(Effect.timeout('2 seconds'))

      const turnCompletedEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: 'turn.completed' }> =>
          event.type === 'turn.completed' && String(event.threadId) === String(threadId),
      )
      const readySessions = yield* adapter.listSessions()
      const readySession = readySessions.find((session) => session.threadId === threadId)

      assert.notEqual(String(followUp.turnId), String(firstTurnId))
      assert.deepEqual(
        turnCompletedEvents.map((event) => [String(event.turnId), event.payload.state]),
        [
          [String(firstTurnId), 'cancelled'],
          [String(followUp.turnId), 'completed'],
        ],
      )
      assert.equal(readySession?.status, 'ready')
      assert.isUndefined(readySession?.activeTurnId)

      yield* Fiber.interrupt(runtimeEventsFiber)
      yield* adapter.stopSession(threadId)
    }).pipe(TestClock.withLive),
  )

  it.effect('drops late ACP notifications after a turn is cancelled', () =>
    Effect.gen(function* ()
    {
      const threadId = ThreadId.make('grok-drop-late-cancelled-notifications')
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_HANG_PROMPT_FOREVER: '1',
          T3_ACP_EMIT_LATE_UPDATE_AFTER_CANCEL: '1',
        }),
      )
      const lateNativeUpdate = yield* Deferred.make<void>()
      const adapter = yield* makeTestAdapter(wrapperPath, {
        nativeEventLogger: {
          filePath: 'memory://grok-cancelled-native-events',
          write: (record: unknown) =>
            JSON.stringify(record).includes('late after cancel')
              ? Deferred.succeed(lateNativeUpdate, undefined).pipe(Effect.asVoid)
              : Effect.void,
          close: () => Effect.void,
        },
      })

      const runtimeEvents: ProviderRuntimeEvent[] = []
      const turnStarted = yield* Deferred.make<TurnId>()
      const runtimeEventsFiber = yield* Stream.runForEach(
        unwrapAcpRuntimeEvents(adapter),
        (event) =>
          Effect.sync(() =>
          {
            runtimeEvents.push(event)
          }).pipe(
            Effect.andThen(
              event.type === 'turn.started' &&
                event.turnId !== undefined &&
                String(event.threadId) === String(threadId)
                ? Deferred.succeed(turnStarted, event.turnId).pipe(Effect.asVoid)
                : Effect.void,
            ),
          ),
      ).pipe(Effect.forkChild)

      yield* startAcpTestSession(adapter, {
        threadId,
        provider: ProviderDriverKind.make('grok'),
        cwd: process.cwd(),
        runtimeMode: 'full-access',
      })

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: 'cancel before the late update', attachments: [] })
        .pipe(Effect.forkChild)
      const turnId = yield* Deferred.await(turnStarted).pipe(Effect.timeout('2 seconds'))
      yield* adapter.interruptTurn(threadId, turnId).pipe(Effect.timeout('2 seconds'))
      yield* Fiber.join(sendTurnFiber).pipe(Effect.timeout('2 seconds'))
      yield* Deferred.await(lateNativeUpdate).pipe(Effect.timeout('2 seconds'))
      for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1)
      {
        yield* Effect.yieldNow
      }

      const cancelledIndex = runtimeEvents.findIndex(
        (event) =>
          event.type === 'turn.completed' &&
          String(event.threadId) === String(threadId) &&
          String(event.turnId) === String(turnId) &&
          event.payload.state === 'cancelled',
      )
      const turnOutputTypes = new Set([
        'content.delta',
        'item.started',
        'item.updated',
        'item.completed',
        'turn.plan.updated',
      ])
      const outputAfterCancellation = runtimeEvents
        .slice(cancelledIndex + 1)
        .filter(
          (event) => String(event.threadId) === String(threadId) && turnOutputTypes.has(event.type),
        )

      assert.isAtLeast(cancelledIndex, 0)
      assert.deepEqual(outputAfterCancellation, [])

      yield* Fiber.interrupt(runtimeEventsFiber)
      yield* adapter.stopSession(threadId)
    }).pipe(TestClock.withLive),
  )

  it.effect('lets Stop cancel during the xAI completion drain window', () =>
    Effect.gen(function* ()
    {
      const threadId = ThreadId.make('grok-stop-during-completion-drain')
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_XAI_PROMPT_COMPLETE_THEN_HANG: '1',
        }),
      )
      const adapter = yield* makeTestAdapter(wrapperPath)

      const runtimeEvents: ProviderRuntimeEvent[] = []
      const activeTurnIdRef = yield* Ref.make<TurnId | undefined>(undefined)
      const trailingChunkTurnId = yield* Deferred.make<TurnId>()
      const runtimeEventsFiber = yield* Stream.runForEach(
        unwrapAcpRuntimeEvents(adapter),
        (event) =>
          Effect.gen(function* ()
          {
            runtimeEvents.push(event)
            if (String(event.threadId) !== String(threadId))
            {
              return
            }
            if (event.type === 'turn.started')
            {
              yield* Ref.set(activeTurnIdRef, event.turnId)
            }
            if (event.type !== 'content.delta' || event.payload.delta !== 'mock')
            {
              return
            }
            const turnId = event.turnId ?? (yield* Ref.get(activeTurnIdRef))
            if (turnId === undefined)
            {
              return
            }
            yield* Deferred.succeed(trailingChunkTurnId, turnId).pipe(Effect.ignore)
          }),
      ).pipe(Effect.forkChild)

      yield* startAcpTestSession(adapter, {
        threadId,
        provider: ProviderDriverKind.make('grok'),
        cwd: process.cwd(),
        runtimeMode: 'full-access',
        modelSelection: { instanceId: ProviderInstanceId.make('grok'), model: 'grok-build' },
      })

      const sendTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: 'cancel during completion drain',
          attachments: [],
        })
        .pipe(Effect.forkChild)

      const turnId = yield* Deferred.await(trailingChunkTurnId).pipe(Effect.timeout('2 seconds'))
      yield* adapter.interruptTurn(threadId, turnId).pipe(Effect.timeout('2 seconds'))
      yield* Fiber.join(sendTurnFiber).pipe(Effect.timeout('2 seconds'))

      const turnCompletedEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: 'turn.completed' }> =>
          event.type === 'turn.completed' && String(event.threadId) === String(threadId),
      )
      const readySessions = yield* adapter.listSessions()
      const readySession = readySessions.find((session) => session.threadId === threadId)

      assert.lengthOf(turnCompletedEvents, 1)
      assert.equal(turnCompletedEvents[0]?.payload.state, 'cancelled')
      assert.equal(readySession?.status, 'ready')
      assert.isUndefined(readySession?.activeTurnId)

      yield* Fiber.interrupt(runtimeEventsFiber)
      yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('settles the in-flight prompt before emitting completion', () =>
    Effect.gen(function* ()
    {
      const threadId = ThreadId.make('grok-completion-before-next-turn')
      const wrapperPath = yield* Effect.promise(() => makeMockGrokWrapper())
      const adapter = yield* makeTestAdapter(wrapperPath)
      const completedCountRef = yield* Ref.make(0)
      const secondTurnCompleted = yield* Deferred.make<void>()

      const runtimeEventsFiber = yield* Stream.runForEach(
        unwrapAcpRuntimeEvents(adapter),
        (event) =>
        {
          if (event.type !== 'turn.completed' || String(event.threadId) !== String(threadId))
          {
            return Effect.void
          }

          return Ref.modify(completedCountRef, (count) =>
          {
            const nextCount = count + 1
            return [nextCount, nextCount] as const
          }).pipe(
            Effect.flatMap((count) =>
            {
              if (count === 1)
              {
                return adapter
                  .sendTurn({
                    threadId,
                    input: 'second turn after completion',
                    attachments: [],
                  })
                  .pipe(Effect.forkChild, Effect.asVoid)
              }
              if (count === 2)
              {
                return Deferred.succeed(secondTurnCompleted, undefined).pipe(Effect.asVoid)
              }
              return Effect.void
            }),
          )
        },
      ).pipe(Effect.forkChild)

      yield* startAcpTestSession(adapter, {
        threadId,
        provider: ProviderDriverKind.make('grok'),
        cwd: process.cwd(),
        runtimeMode: 'full-access',
        modelSelection: { instanceId: ProviderInstanceId.make('grok'), model: 'grok-build' },
      })

      yield* adapter.sendTurn({
        threadId,
        input: 'first turn',
        attachments: [],
      })
      yield* Deferred.await(secondTurnCompleted)

      const completedCount = yield* Ref.get(completedCountRef)
      const readySessions = yield* adapter.listSessions()
      const readySession = readySessions.find((session) => session.threadId === threadId)

      assert.equal(completedCount, 2)
      assert.equal(readySession?.status, 'ready')
      assert.isUndefined(readySession?.activeTurnId)

      yield* Fiber.interrupt(runtimeEventsFiber)
      yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('restores a Grok session to ready when the prompt RPC fails', () =>
    Effect.gen(function* ()
    {
      const threadId = ThreadId.make('grok-prompt-failure-ready')
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_FAIL_PROMPT: '1',
        }),
      )
      const adapter = yield* makeTestAdapter(wrapperPath)
      const runtimeEvents: ProviderRuntimeEvent[] = []
      const runtimeEventsFiber = yield* Stream.runForEach(
        unwrapAcpRuntimeEvents(adapter),
        (event) =>
          Effect.sync(() =>
          {
            runtimeEvents.push(event)
          }),
      ).pipe(Effect.forkChild)

      yield* startAcpTestSession(adapter, {
        threadId,
        provider: ProviderDriverKind.make('grok'),
        cwd: process.cwd(),
        runtimeMode: 'full-access',
        modelSelection: { instanceId: ProviderInstanceId.make('grok'), model: 'grok-build' },
      })

      const error = yield* Effect.flip(
        adapter.sendTurn({
          threadId,
          input: 'fail prompt',
          attachments: [],
        }),
      )
      const readySessions = yield* adapter.listSessions()
      const readySession = readySessions.find((session) => session.threadId === threadId)
      const failedTurnCompleted = runtimeEvents.find(
        (event) => event.type === 'turn.completed' && event.threadId === threadId,
      )

      assert.equal(error._tag, 'ProviderAdapterRequestError')
      assert.equal(readySession?.status, 'ready')
      assert.isUndefined(readySession?.activeTurnId)
      assert.equal(failedTurnCompleted?.type, 'turn.completed')
      if (failedTurnCompleted?.type === 'turn.completed')
      {
        assert.equal(failedTurnCompleted.payload.state, 'failed')
        assert.isString(failedTurnCompleted.payload.errorMessage)
      }

      yield* Fiber.interrupt(runtimeEventsFiber)
      yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('ignores replayed session/load updates when resuming a Grok session', () =>
    Effect.gen(function* ()
    {
      const threadId = ThreadId.make('grok-load-replay-filter')
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_LOAD_REPLAY: '1',
        }),
      )
      const adapter = yield* makeTestAdapter(wrapperPath)
      const runtimeEvents: ProviderRuntimeEvent[] = []
      const runtimeEventsFiber = yield* Stream.runForEach(
        unwrapAcpRuntimeEvents(adapter),
        (event) =>
          Effect.sync(() =>
          {
            runtimeEvents.push(event)
          }),
      ).pipe(Effect.forkChild)

      const session = yield* startAcpTestSession(adapter, {
        threadId,
        provider: ProviderDriverKind.make('grok'),
        cwd: process.cwd(),
        runtimeMode: 'full-access',
        modelSelection: { instanceId: ProviderInstanceId.make('grok'), model: 'grok-build' },
        resumeCursor: { schemaVersion: 1, sessionId: 'mock-session-1' },
      })

      const turn = yield* adapter.sendTurn({
        threadId,
        input: 'after resume',
        attachments: [],
      })

      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: 'mock-session-1',
      })
      assert.deepStrictEqual(turn.resumeCursor, {
        schemaVersion: 1,
        sessionId: 'mock-session-1',
      })
      assert.isFalse(
        runtimeEvents.some(
          (event) => event.type === 'item.completed' && event.payload.title === 'Replay tool',
        ),
      )
      assert.isFalse(
        runtimeEvents.some(
          (event) =>
            event.type === 'content.delta' && event.payload.delta === 'replayed assistant text',
        ),
      )

      yield* Fiber.interrupt(runtimeEventsFiber)
      yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('rejects startSession when provider mismatches', () =>
    Effect.gen(function* ()
    {
      const wrapperPath = yield* Effect.promise(() => makeMockGrokWrapper())
      const adapter = yield* makeTestAdapter(wrapperPath)
      const threadId = ThreadId.make('grok-provider-mismatch')

      const error = yield* Effect.flip(
        startAcpTestSession(adapter, {
          threadId,
          provider: ProviderDriverKind.make('cursor'),
          cwd: process.cwd(),
          runtimeMode: 'full-access',
          modelSelection: { instanceId: ProviderInstanceId.make('grok'), model: 'grok-build' },
        }),
      )

      assert.equal(error._tag, 'ProviderAdapterValidationError')
    }),
  )

  it.effect('rejects sendTurn with empty input and no attachments', () =>
    Effect.gen(function* ()
    {
      const threadId = ThreadId.make('grok-empty-turn')

      const wrapperPath = yield* Effect.promise(() => makeMockGrokWrapper())
      const adapter = yield* makeTestAdapter(wrapperPath)

      yield* startAcpTestSession(adapter, {
        threadId,
        provider: ProviderDriverKind.make('grok'),
        cwd: process.cwd(),
        runtimeMode: 'full-access',
        modelSelection: { instanceId: ProviderInstanceId.make('grok'), model: 'grok-build' },
      })

      const error = yield* Effect.flip(
        adapter.sendTurn({
          threadId,
          input: '   ',
          attachments: [],
        }),
      )

      assert.equal(error._tag, 'ProviderAdapterValidationError')

      yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('responds to ACP approvals using provider-supplied option ids', () =>
    Effect.gen(function* ()
    {
      const threadId = ThreadId.make('grok-custom-approval-option-id')
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'grok-acp-')),
      )
      const requestLogPath = NodePath.join(tempDir, 'requests.ndjson')
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_EMIT_TOOL_CALLS: '1',
          T3_ACP_ALLOW_ONCE_OPTION_ID: 'agent-defined-approval-id',
        }),
      )
      const adapter = yield* makeTestAdapter(wrapperPath)
      const eventsFiber = yield* Stream.runForEach(unwrapAcpRuntimeEvents(adapter), (event) =>
        event.type === 'request.opened'
          ? adapter.respondToRequest(
              threadId,
              ApprovalRequestId.make(String(event.requestId)),
              'accept',
            )
          : Effect.void,
      ).pipe(Effect.forkChild)

      yield* startAcpTestSession(adapter, {
        threadId,
        provider: ProviderDriverKind.make('grok'),
        cwd: process.cwd(),
        runtimeMode: 'approval-required',
      })
      yield* adapter.sendTurn({ threadId, input: 'approve this', attachments: [] })

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath))
      assert.isTrue(
        requests.some(
          (entry) =>
            !('method' in entry) &&
            typeof entry.result === 'object' &&
            entry.result !== null &&
            'outcome' in entry.result &&
            typeof entry.result.outcome === 'object' &&
            entry.result.outcome !== null &&
            'optionId' in entry.result.outcome &&
            entry.result.outcome.optionId === 'agent-defined-approval-id',
        ),
      )

      yield* Fiber.interrupt(eventsFiber)
      yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('handles xAI ask_user_question extension requests', () =>
    Effect.gen(function* ()
    {
      const threadId = ThreadId.make('grok-xai-ask-user-question')
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({ T3_ACP_EMIT_XAI_ASK_USER_QUESTION: '1' }),
      )
      const adapter = yield* makeTestAdapter(wrapperPath)
      const requested =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: 'user-input.requested' }>>()
      const resolved =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: 'user-input.resolved' }>>()

      const eventsFiber = yield* Stream.runForEach(unwrapAcpRuntimeEvents(adapter), (event) =>
      {
        if (String(event.threadId) !== String(threadId))
        {
          return Effect.void
        }
        if (event.type === 'user-input.requested')
        {
          return Deferred.succeed(requested, event).pipe(Effect.ignore)
        }
        if (event.type === 'user-input.resolved')
        {
          return Deferred.succeed(resolved, event).pipe(Effect.ignore)
        }
        return Effect.void
      }).pipe(Effect.forkChild)

      yield* startAcpTestSession(adapter, {
        threadId,
        provider: ProviderDriverKind.make('grok'),
        cwd: process.cwd(),
        runtimeMode: 'full-access',
      })

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: 'ask before continuing', attachments: [] })
        .pipe(Effect.forkChild)

      const requestedEvent = yield* Deferred.await(requested)
      assert.equal(requestedEvent.payload.questions.length, 1)
      assert.equal(requestedEvent.payload.questions[0]?.id, 'Which scope should Grok use?')
      assert.equal(requestedEvent.payload.questions[0]?.question, 'Which scope should Grok use?')
      assert.equal(requestedEvent.raw?.method, '_x.ai/ask_user_question')

      yield* adapter.respondToUserInput(
        threadId,
        ApprovalRequestId.make(String(requestedEvent.requestId)),
        {
          'Which scope should Grok use?': 'Workspace',
        },
      )

      const resolvedEvent = yield* Deferred.await(resolved)
      assert.deepEqual(resolvedEvent.payload.answers, {
        'Which scope should Grok use?': 'Workspace',
      })
      assert.equal(String(resolvedEvent.turnId), String(requestedEvent.turnId))
      yield* Fiber.join(sendTurnFiber)

      yield* Fiber.interrupt(eventsFiber)
      yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('continues streaming events when native notification logging fails', () =>
    Effect.gen(function* ()
    {
      const threadId = ThreadId.make('grok-native-log-failure')
      const wrapperPath = yield* Effect.promise(() => makeMockGrokWrapper())
      const adapter = yield* makeTestAdapter(wrapperPath, {
        nativeEventLogger: {
          filePath: 'memory://grok-native-events',
          write: (record: unknown) =>
            typeof record === 'object' &&
            record !== null &&
            'event' in record &&
            typeof record.event === 'object' &&
            record.event !== null &&
            'kind' in record.event &&
            record.event.kind === 'notification'
              ? Effect.die(new Error('native log write failed'))
              : Effect.void,
          close: () => Effect.void,
        },
      })
      const contentDelta = yield* Deferred.make<void>()
      const eventsFiber = yield* Stream.runForEach(unwrapAcpRuntimeEvents(adapter), (event) =>
        event.type === 'content.delta' ? Deferred.succeed(contentDelta, undefined) : Effect.void,
      ).pipe(Effect.forkChild)

      yield* startAcpTestSession(adapter, {
        threadId,
        provider: ProviderDriverKind.make('grok'),
        cwd: process.cwd(),
        runtimeMode: 'full-access',
      })
      yield* adapter.sendTurn({ threadId, input: 'keep streaming', attachments: [] })
      yield* Deferred.await(contentDelta)

      yield* Fiber.interrupt(eventsFiber)
      yield* adapter.stopSession(threadId)
    }),
  )
})
