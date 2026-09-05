// tests/apps/server/provider/Layers/CursorAdapter.test.ts
// verifies Cursor ACP session behavior

// @effect-diagnostics globalTimers:off - session-drop polls need wall-clock waits; the test clock freezes Effect.sleep
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from 'node:path'
import * as NodeOS from 'node:os'
import * as NodeFSP from 'node:fs/promises'
import * as NodeURL from 'node:url'

import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, it } from '@effect/vitest'
import * as Context from 'effect/Context'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import * as TestClock from 'effect/testing/TestClock'
import { createModelSelection } from '@t3tools/shared/model'

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
  CursorSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from '@t3tools/contracts'

import { ServerConfig } from '../../../../../apps/server/src/config.ts'
import { ServerSettingsService } from '../../../../../apps/server/src/serverSettings.ts'
import type { CursorAdapterShape } from '../../../../../apps/server/src/provider/Services/CursorAdapter.ts'
import { makeCursorAdapter } from '../../../../../apps/server/src/provider/Layers/CursorAdapter.ts'
import {
  makeTestMcpProviderSession,
  TEST_MCP_AUTHORIZATION,
  TEST_MCP_ENDPOINT,
} from './mcpProviderSessionTestHelpers.ts'
const decodeCursorSettings = Schema.decodeSync(CursorSettings)

// test-local service tag so the rest of the file can keep using `yield* CursorAdapter`.
class CursorAdapter extends Context.Service<CursorAdapter, CursorAdapterShape>()(
  '@t3tools/tests/apps/server/provider/Layers/CursorAdapter.test/CursorAdapter',
)
{}

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url))
const mockAgentPath = NodePath.join(
  __dirname,
  '../../../../../apps/server/scripts/acp-mock-agent.ts',
)
const mockAgentCommand = 'node'
const mockAgentArgs = [mockAgentPath] as const

async function makeMockAgentWrapper(
  extraEnv?: Record<string, string>,
  options?: { initialDelaySeconds?: number },
)
{
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'cursor-acp-mock-'))
  const wrapperPath = NodePath.join(dir, 'fake-agent.sh')
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join('\n')
  const script = `#!/bin/sh
${envExports}
${options?.initialDelaySeconds ? `sleep ${JSON.stringify(String(options.initialDelaySeconds))}` : ''}
exec ${JSON.stringify(mockAgentCommand)} ${mockAgentArgs.map((arg) => JSON.stringify(arg)).join(' ')} "$@"
`
  await NodeFSP.writeFile(wrapperPath, script, 'utf8')
  await NodeFSP.chmod(wrapperPath, 0o755)
  return wrapperPath
}

// densify lifecycle/import wrapper setup — keep Cursor driver entrypoints
const makeTestCursorAdapter = (
  binaryPath: string,
  options?: { readonly enableAbnormalTermination?: boolean },
) =>
{
  const cursorConfig = decodeCursorSettings({ binaryPath })
  return makeCursorAdapter(cursorConfig, {
    ...(options?.enableAbnormalTermination ? { enableAbnormalTermination: true } : {}),
    resolveSettings: Effect.succeed(cursorConfig),
  })
}

async function makeProbeWrapper(
  requestLogPath: string,
  argvLogPath: string,
  extraEnv?: Record<string, string>,
)
{
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'cursor-acp-probe-'))
  const wrapperPath = NodePath.join(dir, 'fake-agent.sh')
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join('\n')
  const script = `#!/bin/sh
printf '%s\t' "$@" >> ${JSON.stringify(argvLogPath)}
printf '\n' >> ${JSON.stringify(argvLogPath)}
export T3_ACP_REQUEST_LOG_PATH=${JSON.stringify(requestLogPath)}
${envExports}
exec ${JSON.stringify(mockAgentCommand)} ${mockAgentArgs.map((arg) => JSON.stringify(arg)).join(' ')} "$@"
`
  await NodeFSP.writeFile(wrapperPath, script, 'utf8')
  await NodeFSP.chmod(wrapperPath, 0o755)
  return wrapperPath
}

async function readArgvLog(filePath: string)
{
  const raw = await NodeFSP.readFile(filePath, 'utf8')
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split('\t').filter((token) => token.length > 0))
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

async function waitForFileContent(filePath: string, attempts = 40)
{
  for (let attempt = 0; attempt < attempts; attempt += 1)
  {
    try
    {
      const raw = await NodeFSP.readFile(filePath, 'utf8')
      if (raw.trim().length > 0)
      {
        return raw
      }
    }
    catch
    {}
    await Effect.runPromise(Effect.yieldNow)
  }
  throw new Error(`Timed out waiting for file content at ${filePath}`)
}

function waitForJsonLogMatch(
  filePath: string,
  predicate: (entry: Record<string, unknown>) => boolean,
  attempts = 40,
)
{
  return Effect.gen(function* ()
  {
    for (let attempt = 0; attempt < attempts; attempt += 1)
    {
      const requests = yield* Effect.promise(() => readJsonLines(filePath))
      if (requests.some(predicate))
      {
        return requests
      }
      yield* Effect.yieldNow
    }
    return yield* Effect.promise(() => readJsonLines(filePath))
  })
}

function waitForCursorSessionDrop(
  adapter: CursorAdapterShape,
  threadId: ThreadId,
): Effect.Effect<void>
{
  return waitForAcpSessionDrop(adapter, threadId, 'Cursor')
}

// tests mutate `ServerSettingsService` mid-flight (e.g. setting
// `providers.cursor.binaryPath` to a mock ACP wrapper). The adapter
// captures `cursorSettings` once at construction, so without a resolver
// the mutation is invisible — sessions would spawn the constructor's
// (empty) binary path. Wiring `resolveSettings` through
// `ServerSettingsService.getSettings` makes each session read the latest
// snapshot, matching the old "always read live" behavior that these
// tests assumed.
const makeResolveCursorSettings = Effect.gen(function* ()
{
  const serverSettings = yield* ServerSettingsService
  return yield* Effect.succeed(
    serverSettings.getSettings.pipe(
      Effect.map((snapshot) => snapshot.providers.cursor),
      Effect.orDie,
    ),
  )
})

const cursorAdapterTestLayer = it.layer(
  Layer.effect(
    CursorAdapter,
    Effect.gen(function* ()
    {
      const cursorConfig = decodeCursorSettings({})
      const resolveSettings = yield* makeResolveCursorSettings
      return yield* makeCursorAdapter(cursorConfig, { resolveSettings })
    }),
  ).pipe(
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: 't3code-cursor-adapter-test-',
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
)

cursorAdapterTestLayer('CursorAdapterLive', (it) =>
{
  it.effect('preserves the strict import marker through a successful Cursor turn', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* CursorAdapter
      const settings = yield* ServerSettingsService
      const threadId = ThreadId.make('cursor-import-strict-marker')
      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper())
      yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } })

      const session = yield* startAcpTestSession(adapter, {
        threadId,
        provider: ProviderDriverKind.make('cursor'),
        cwd: process.cwd(),
        runtimeMode: 'approval-required',
        modelSelection: {
          instanceId: ProviderInstanceId.make('cursor'),
          model: 'default',
        },
        resumeCursor: STRICT_IMPORT_RESUME_CURSOR,
      })
      const turn = yield* adapter.sendTurn({
        threadId,
        input: 'continue imported Cursor session',
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

  it.effect('keeps an ordinary resumed Cursor cursor marker-free', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* CursorAdapter
      const settings = yield* ServerSettingsService
      const threadId = ThreadId.make('cursor-ordinary-resume-marker')
      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper())
      yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } })

      const ordinaryCursor = {
        schemaVersion: 1,
        sessionId: 'mock-session-1',
      }
      const session = yield* startAcpTestSession(adapter, {
        threadId,
        provider: ProviderDriverKind.make('cursor'),
        cwd: process.cwd(),
        runtimeMode: 'approval-required',
        modelSelection: {
          instanceId: ProviderInstanceId.make('cursor'),
          model: 'default',
        },
        resumeCursor: ordinaryCursor,
      })
      const turn = yield* adapter.sendTurn({
        threadId,
        input: 'continue ordinary Cursor session',
        attachments: [],
      })

      assertStrictImportMarkerPreserved({
        sessionResumeCursor: session.resumeCursor,
        turnResumeCursor: turn.resumeCursor,
        expectedCursor: ordinaryCursor,
      })

      yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('rejects a malformed strict Cursor cursor before starting the native session', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* CursorAdapter
      const settings = yield* ServerSettingsService
      const threadId = ThreadId.make('cursor-import-malformed-strict')
      yield* settings.updateSettings({
        providers: { cursor: { binaryPath: '/definitely/missing/cursor-agent' } },
      })

      const error = yield* Effect.flip(
        startAcpTestSession(adapter, {
          threadId,
          provider: ProviderDriverKind.make('cursor'),
          cwd: process.cwd(),
          runtimeMode: 'approval-required',
          modelSelection: {
            instanceId: ProviderInstanceId.make('cursor'),
            model: 'default',
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

  it.effect('rejects an invalid strict marker without stopping the active Cursor session', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* CursorAdapter
      const settings = yield* ServerSettingsService
      const threadId = ThreadId.make('cursor-import-invalid-marker-active')
      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper())
      yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } })

      const active = yield* startAcpTestSession(adapter, {
        threadId,
        provider: ProviderDriverKind.make('cursor'),
        cwd: process.cwd(),
        runtimeMode: 'approval-required',
        modelSelection: {
          instanceId: ProviderInstanceId.make('cursor'),
          model: 'default',
        },
      })
      const error = yield* Effect.flip(
        startAcpTestSession(adapter, {
          threadId,
          provider: ProviderDriverKind.make('cursor'),
          cwd: process.cwd(),
          runtimeMode: 'approval-required',
          modelSelection: {
            instanceId: ProviderInstanceId.make('cursor'),
            model: 'default',
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

  it.effect('never replaces a missing imported Cursor session with a fresh session', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* CursorAdapter
      const settings = yield* ServerSettingsService
      const threadId = ThreadId.make('cursor-import-strict-resume')
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_FAIL_LOAD_SESSION: '1' }),
      )
      yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } })

      const error = yield* Effect.flip(
        startAcpTestSession(adapter, {
          threadId,
          provider: ProviderDriverKind.make('cursor'),
          cwd: process.cwd(),
          runtimeMode: 'approval-required',
          modelSelection: {
            instanceId: ProviderInstanceId.make('cursor'),
            model: 'default',
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

  it.effect('requires an explicit stop before replacing an active imported Cursor session', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* CursorAdapter
      const settings = yield* ServerSettingsService
      const threadId = ThreadId.make('cursor-import-active-lineage')
      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper())
      yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } })

      const imported = yield* startAcpTestSession(adapter, {
        threadId,
        provider: ProviderDriverKind.make('cursor'),
        cwd: process.cwd(),
        runtimeMode: 'approval-required',
        modelSelection: {
          instanceId: ProviderInstanceId.make('cursor'),
          model: 'default',
        },
        resumeCursor: STRICT_IMPORT_RESUME_CURSOR,
      })
      const error = yield* Effect.flip(
        startAcpTestSession(adapter, {
          threadId,
          provider: ProviderDriverKind.make('cursor'),
          cwd: process.cwd(),
          runtimeMode: 'full-access',
          modelSelection: {
            instanceId: ProviderInstanceId.make('cursor'),
            model: 'default',
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
      const adapter = yield* CursorAdapter
      const settings = yield* ServerSettingsService
      const threadId = ThreadId.make('cursor-mock-thread')

      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper())
      yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } })

      const runtimeEventsFiber = yield* Stream.take(unwrapAcpRuntimeEvents(adapter), 9).pipe(
        Stream.runCollect,
        Effect.forkChild,
      )

      const session = yield* startAcpTestSession(adapter, {
        threadId,
        provider: ProviderDriverKind.make('cursor'),
        cwd: process.cwd(),
        runtimeMode: 'full-access',
        modelSelection: { instanceId: ProviderInstanceId.make('cursor'), model: 'default' },
      })

      assert.equal(session.provider, 'cursor')
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: 'mock-session-1',
      })

      yield* adapter.sendTurn({
        threadId,
        input: 'hello mock',
        attachments: [],
      })

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber))
      const types = runtimeEvents.map((e) => e.type)

      for (const t of [
        'session.started',
        'session.state.changed',
        'thread.started',
        'turn.started',
        'turn.plan.updated',
        'item.started',
        'content.delta',
        'item.completed',
        'turn.completed',
      ] as const)
      {
        assert.include(types, t)
      }

      const assistantStarted = runtimeEvents.find(
        (event) => event.type === 'item.started' && event.payload.itemType === 'assistant_message',
      )
      assert.isDefined(assistantStarted)

      const delta = runtimeEvents.find((e) => e.type === 'content.delta')
      assert.isDefined(delta)
      if (delta?.type === 'content.delta')
      {
        assert.equal(delta.payload.delta, 'hello from mock')
        assert.match(String(delta.itemId), /^assistant:mock-session-1:runtime:[^:]+:segment:0$/)
      }

      const assistantCompleted = runtimeEvents.find(
        (event) =>
          event.type === 'item.completed' && event.payload.itemType === 'assistant_message',
      )
      assert.isDefined(assistantCompleted)

      const planUpdate = runtimeEvents.find((event) => event.type === 'turn.plan.updated')
      assert.isDefined(planUpdate)
      if (planUpdate?.type === 'turn.plan.updated')
      {
        assert.deepStrictEqual(planUpdate.payload.plan, [
          { step: 'Inspect mock ACP state', status: 'completed' },
          { step: 'Implement the requested change', status: 'inProgress' },
        ])
      }

      yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('steers a running turn instead of opening a new one on mid-turn sendTurn (smoke)', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* CursorAdapter
      const settings = yield* ServerSettingsService
      const threadId = ThreadId.make('cursor-steer-thread')

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_PROMPT_DELAY_MS: '1500' }),
      )
      yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } })

      yield* startAcpTestSession(adapter, {
        threadId,
        provider: ProviderDriverKind.make('cursor'),
        cwd: process.cwd(),
        runtimeMode: 'full-access',
        modelSelection: { instanceId: ProviderInstanceId.make('cursor'), model: 'default' },
      })

      const firstTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: 'run 5 commands',
          attachments: [],
        })
        .pipe(Effect.forkChild)

      yield* Effect.gen(function* ()
      {
        for (let attempt = 0; attempt < 200; attempt += 1)
        {
          const sessions = yield* adapter.listSessions()
          const session = sessions.find((entry) => entry.threadId === threadId)
          if (session?.activeTurnId !== undefined)
          {
            return
          }
          yield* TestClock.adjust('10 millis')
        }
        throw new Error('Timed out waiting for the first prompt to be in flight.')
      })

      const steeredTurn = yield* adapter.sendTurn({
        threadId,
        input: 'actually run 15',
        attachments: [],
      })
      const firstTurn = yield* Fiber.join(firstTurnFiber)
      assert.equal(String(steeredTurn.turnId), String(firstTurn.turnId))

      yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('closes the ACP child process when a session stops', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* CursorAdapter
      const settings = yield* ServerSettingsService
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'cursor-adapter-exit-log-')),
      )
      const exitLogPath = NodePath.join(tempDir, 'exit.log')
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_EXIT_LOG_PATH: exitLogPath }),
      )
      yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } })

      yield* assertStopClosesAcpChild(adapter, {
        threadId: ThreadId.make('cursor-stop-session-close'),
        provider: ProviderDriverKind.make('cursor'),
        modelSelection: { instanceId: ProviderInstanceId.make('cursor'), model: 'default' },
        readExitLog: Effect.promise(() => waitForFileContent(exitLogPath)),
      })
    }),
  )

  it.effect('finalizes an active Cursor session once when its ACP child exits', () =>
    Effect.gen(function* ()
    {
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({
          T3_ACP_EMIT_TOOL_CALLS: '1',
          T3_ACP_EXIT_DURING_PROMPT_CODE: '9',
          T3_ACP_EXIT_DURING_PROMPT_DELAY_MS: '100',
        }),
      )
      const adapter = yield* makeTestCursorAdapter(wrapperPath, {
        enableAbnormalTermination: true,
      })

      yield* assertAbnormalChildExitFinalizesOnce(adapter, {
        threadId: ThreadId.make('cursor-abnormal-child-exit'),
        provider: ProviderDriverKind.make('cursor'),
        label: 'Cursor',
        promptInFlight: 'await-request',
      })
    }),
  )

  it.effect('keeps abnormal Cursor exit emission disabled by default', () =>
    Effect.gen(function* ()
    {
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_EXIT_DURING_PROMPT_CODE: '9' }),
      )
      const adapter = yield* makeTestCursorAdapter(wrapperPath)

      yield* assertAbnormalExitDisabledByDefault(adapter, {
        threadId: ThreadId.make('cursor-abnormal-child-exit-disabled'),
        provider: ProviderDriverKind.make('cursor'),
        label: 'Cursor',
      })
    }),
  )

  it.effect('emits one Cursor exit when graceful stop races ACP termination', () =>
    Effect.gen(function* ()
    {
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_EXIT_DURING_PROMPT_CODE: '9' }),
      )
      const adapter = yield* makeTestCursorAdapter(wrapperPath, {
        enableAbnormalTermination: true,
      })

      yield* assertOneExitWhenStopRacesTermination(adapter, {
        threadId: ThreadId.make('cursor-stop-termination-race'),
        provider: ProviderDriverKind.make('cursor'),
        label: 'Cursor',
      })
    }),
  )

  it.effect(
    'serializes concurrent startSession calls for the same thread and closes the replaced ACP session',
    () =>
      Effect.gen(function* ()
      {
        const adapter = yield* CursorAdapter
        const settings = yield* ServerSettingsService
        const threadId = ThreadId.make('cursor-concurrent-start-session')
        const tempDir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'cursor-adapter-concurrent-exit-log-')),
        )
        const exitLogPath = NodePath.join(tempDir, 'exit.log')

        const wrapperPath = yield* Effect.promise(() =>
          makeMockAgentWrapper(
            {
              T3_ACP_EXIT_LOG_PATH: exitLogPath,
            },
            { initialDelaySeconds: 0.2 },
          ),
        )
        yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } })

        yield* assertConcurrentStartSerializesSameThread(adapter, {
          threadId,
          provider: ProviderDriverKind.make('cursor'),
          modelSelection: { instanceId: ProviderInstanceId.make('cursor'), model: 'default' },
          readExitLog: Effect.promise(() => waitForFileContent(exitLogPath)),
        })
      }),
  )

  it.effect('rejects startSession when provider mismatches', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* CursorAdapter
      const result = yield* startAcpTestSession(adapter, {
        threadId: ThreadId.make('bad-provider'),
        provider: ProviderDriverKind.make('codex'),
        cwd: process.cwd(),
        runtimeMode: 'full-access',
      }).pipe(Effect.result)

      assert.equal(result._tag, 'Failure')
    }),
  )

  it.effect('passes the scoped MCP endpoint and bearer header to Cursor ACP', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* CursorAdapter
      const serverSettings = yield* ServerSettingsService
      const threadId = ThreadId.make('cursor-mcp-probe')
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'cursor-acp-')),
      )
      const requestLogPath = NodePath.join(tempDir, 'requests.ndjson')
      const argvLogPath = NodePath.join(tempDir, 'argv.txt')
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, '', 'utf8'))
      const wrapperPath = yield* Effect.promise(() => makeProbeWrapper(requestLogPath, argvLogPath))
      yield* serverSettings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } })

      yield* startAcpTestSession(adapter, {
        threadId,
        provider: ProviderDriverKind.make('cursor'),
        cwd: process.cwd(),
        runtimeMode: 'full-access',
        mcp: makeTestMcpProviderSession(threadId, ProviderInstanceId.make('cursor')),
      })
      yield* Effect.promise(() => waitForFileContent(requestLogPath))
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

  it.effect('maps app plan mode onto the ACP plan session mode', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* CursorAdapter
      const serverSettings = yield* ServerSettingsService
      const threadId = ThreadId.make('cursor-plan-mode-probe')
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'cursor-acp-')),
      )
      const requestLogPath = NodePath.join(tempDir, 'requests.ndjson')
      const argvLogPath = NodePath.join(tempDir, 'argv.txt')
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, '', 'utf8'))
      const wrapperPath = yield* Effect.promise(() => makeProbeWrapper(requestLogPath, argvLogPath))
      yield* serverSettings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } })

      yield* startAcpTestSession(adapter, {
        threadId,
        provider: ProviderDriverKind.make('cursor'),
        cwd: process.cwd(),
        runtimeMode: 'full-access',
        modelSelection: { instanceId: ProviderInstanceId.make('cursor'), model: 'composer-2' },
      })

      yield* adapter.sendTurn({
        threadId,
        input: 'plan this change',
        attachments: [],
        interactionMode: 'plan',
      })
      yield* adapter.stopSession(threadId)

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath))
      const modeRequest = requests
        .toReversed()
        .find(
          (entry) =>
            entry.method === 'session/set_mode' ||
            (entry.method === 'session/set_config_option' &&
              (entry.params as Record<string, unknown> | undefined)?.configId === 'mode'),
        )
      assert.isDefined(modeRequest)
      assert.equal(
        (modeRequest?.params as Record<string, unknown> | undefined)?.sessionId,
        'mock-session-1',
      )
      assert.include(
        ['architect', 'plan'],
        String(
          (modeRequest?.params as Record<string, unknown> | undefined)?.modeId ??
            (modeRequest?.params as Record<string, unknown> | undefined)?.value,
        ),
      )
    }),
  )

  it.effect(
    'applies initial model and mode configuration during startSession and skips repeating it on first send',
    () =>
      Effect.gen(function* ()
      {
        const adapter = yield* CursorAdapter
        const serverSettings = yield* ServerSettingsService
        const threadId = ThreadId.make('cursor-initial-config-probe')
        const tempDir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'cursor-acp-')),
        )
        const requestLogPath = NodePath.join(tempDir, 'requests.ndjson')
        const argvLogPath = NodePath.join(tempDir, 'argv.txt')
        yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, '', 'utf8'))
        const wrapperPath = yield* Effect.promise(() =>
          makeProbeWrapper(requestLogPath, argvLogPath),
        )
        yield* serverSettings.updateSettings({
          providers: { cursor: { binaryPath: wrapperPath } },
        })

        const modelSelection = createModelSelection(ProviderInstanceId.make('cursor'), 'gpt-5.4', [
          { id: 'reasoning', value: 'xhigh' },
          { id: 'contextWindow', value: '1m' },
          { id: 'fastMode', value: true },
        ])

        yield* startAcpTestSession(adapter, {
          threadId,
          provider: ProviderDriverKind.make('cursor'),
          cwd: process.cwd(),
          runtimeMode: 'full-access',
          modelSelection,
        })

        yield* Effect.promise(() => waitForFileContent(requestLogPath))

        const requestsAfterStart = yield* Effect.promise(() => readJsonLines(requestLogPath))
        const configIdsAfterStart = requestsAfterStart.flatMap((entry) =>
          entry.method === 'session/set_config_option' &&
          typeof (entry.params as Record<string, unknown> | undefined)?.configId === 'string'
            ? [String((entry.params as Record<string, unknown>).configId)]
            : [],
        )
        // mode now travels over the typed session/set_mode rpc rather than
        // session/set_config_option (megacore U-076)
        assert.deepStrictEqual(configIdsAfterStart, ['model', 'reasoning', 'context', 'fast'])
        assert.equal(
          requestsAfterStart.filter((entry) => entry.method === 'session/set_mode').length,
          1,
        )

        yield* adapter.sendTurn({
          threadId,
          input: 'hello mock',
          attachments: [],
          modelSelection,
          interactionMode: 'default',
        })
        yield* adapter.stopSession(threadId)

        const finalRequests = yield* Effect.promise(() => readJsonLines(requestLogPath))
        const finalConfigIds = finalRequests.flatMap((entry) =>
          entry.method === 'session/set_config_option' &&
          typeof (entry.params as Record<string, unknown> | undefined)?.configId === 'string'
            ? [String((entry.params as Record<string, unknown>).configId)]
            : [],
        )
        assert.deepStrictEqual(finalConfigIds, ['model', 'reasoning', 'context', 'fast'])
        assert.equal(finalRequests.filter((entry) => entry.method === 'session/set_mode').length, 1)
        assert.equal(finalRequests.filter((entry) => entry.method === 'session/prompt').length, 1)
      }),
  )

  it.effect(
    'streams ACP tool calls and approvals on the active turn in approval-required mode',
    () =>
      Effect.gen(function* ()
      {
        const previousEmitToolCalls = process.env.T3_ACP_EMIT_TOOL_CALLS
        process.env.T3_ACP_EMIT_TOOL_CALLS = '1'

        const adapter = yield* CursorAdapter
        const serverSettings = yield* ServerSettingsService
        const threadId = ThreadId.make('cursor-tool-call-probe')
        const runtimeEvents: Array<ProviderRuntimeEvent> = []
        const settledEventTypes = new Set<string>()
        const settledEventsReady = yield* Deferred.make<void>()
        const tempDir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'cursor-approval-log-')),
        )
        const requestLogPath = NodePath.join(tempDir, 'requests.ndjson')

        const wrapperPath = yield* Effect.promise(() =>
          makeMockAgentWrapper({
            T3_ACP_EMIT_TOOL_CALLS: '1',
            T3_ACP_REQUEST_LOG_PATH: requestLogPath,
            T3_ACP_ALLOW_ALWAYS_OPTION_ID: 'cursor-agent-allow-always',
          }),
        )
        yield* serverSettings.updateSettings({
          providers: { cursor: { binaryPath: wrapperPath } },
        })

        yield* Stream.runForEach(unwrapAcpRuntimeEvents(adapter), (event) =>
          Effect.gen(function* ()
          {
            runtimeEvents.push(event)
            if (String(event.threadId) !== String(threadId))
            {
              return
            }
            if (event.type === 'request.opened' && event.requestId)
            {
              yield* adapter.respondToRequest(
                threadId,
                ApprovalRequestId.make(String(event.requestId)),
                'acceptAlways',
              )
            }
            if (
              event.type === 'turn.completed' ||
              (event.type === 'item.completed' && event.payload.itemType === 'command_execution') ||
              event.type === 'content.delta'
            )
            {
              settledEventTypes.add(event.type)
              if (settledEventTypes.size === 3)
              {
                yield* Deferred.succeed(settledEventsReady, undefined).pipe(Effect.orDie)
              }
            }
          }),
        ).pipe(Effect.forkChild)

        const program = Effect.gen(function* ()
        {
          yield* startAcpTestSession(adapter, {
            threadId,
            provider: ProviderDriverKind.make('cursor'),
            cwd: process.cwd(),
            runtimeMode: 'approval-required',
            modelSelection: { instanceId: ProviderInstanceId.make('cursor'), model: 'default' },
          })

          const turn = yield* adapter.sendTurn({
            threadId,
            input: 'run a tool call',
            attachments: [],
          })
          yield* Deferred.await(settledEventsReady)

          const threadEvents = runtimeEvents.filter(
            (event) => String(event.threadId) === String(threadId),
          )
          assert.includeMembers(
            threadEvents.map((event) => event.type),
            [
              'session.started',
              'session.state.changed',
              'thread.started',
              'turn.started',
              'request.opened',
              'request.resolved',
              'item.updated',
              'item.completed',
              'content.delta',
              'turn.completed',
            ],
          )

          const turnEvents = threadEvents.filter(
            (event) => String(event.turnId) === String(turn.turnId),
          )
          const toolUpdates = turnEvents.filter((event) => event.type === 'item.updated')
          // ACP updates can arrive either as distinct pending + in-progress events
          // or as a single coalesced in-progress update before approval resolves.
          assert.isAtLeast(toolUpdates.length, 1)
          for (const toolUpdate of toolUpdates)
          {
            if (toolUpdate.type !== 'item.updated')
            {
              continue
            }
            assert.equal(toolUpdate.payload.itemType, 'command_execution')
            assert.equal(toolUpdate.payload.status, 'inProgress')
            assert.equal(toolUpdate.payload.detail, 'cat server/package.json')
            assert.equal(String(toolUpdate.itemId), 'tool-call-1')
          }

          const requestOpened = turnEvents.find((event) => event.type === 'request.opened')
          assert.isDefined(requestOpened)
          if (requestOpened?.type === 'request.opened')
          {
            assert.equal(String(requestOpened.turnId), String(turn.turnId))
            assert.equal(requestOpened.payload.requestType, 'exec_command_approval')
            assert.equal(requestOpened.payload.detail, 'cat server/package.json')
          }

          const requestResolved = turnEvents.find((event) => event.type === 'request.resolved')
          assert.isDefined(requestResolved)
          if (requestResolved?.type === 'request.resolved')
          {
            assert.equal(String(requestResolved.turnId), String(turn.turnId))
            assert.equal(requestResolved.payload.requestType, 'exec_command_approval')
            assert.equal(requestResolved.payload.decision, 'acceptAlways')
          }

          const toolCompleted = turnEvents.find(
            (event) =>
              event.type === 'item.completed' && event.payload.itemType === 'command_execution',
          )
          assert.isDefined(toolCompleted)
          if (toolCompleted?.type === 'item.completed')
          {
            assert.equal(String(toolCompleted.turnId), String(turn.turnId))
            assert.equal(toolCompleted.payload.itemType, 'command_execution')
            assert.equal(toolCompleted.payload.status, 'completed')
            assert.equal(toolCompleted.payload.detail, 'cat server/package.json')
            assert.equal(String(toolCompleted.itemId), 'tool-call-1')
          }

          const contentDelta = turnEvents.find((event) => event.type === 'content.delta')
          assert.isDefined(contentDelta)
          if (contentDelta?.type === 'content.delta')
          {
            assert.equal(String(contentDelta.turnId), String(turn.turnId))
            assert.equal(contentDelta.payload.delta, 'hello from mock')
            assert.match(
              String(contentDelta.itemId),
              /^assistant:mock-session-1:runtime:[^:]+:segment:0$/,
            )
          }

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
                entry.result.outcome.optionId === 'cursor-agent-allow-always',
            ),
          )
        })

        yield* program.pipe(
          Effect.ensuring(
            Effect.sync(() =>
            {
              if (previousEmitToolCalls === undefined)
              {
                delete process.env.T3_ACP_EMIT_TOOL_CALLS
              }
              else
              {
                process.env.T3_ACP_EMIT_TOOL_CALLS = previousEmitToolCalls
              }
            }),
          ),
        )
      }).pipe(
        Effect.provide(
          Layer.effect(
            CursorAdapter,
            Effect.gen(function* ()
            {
              const cursorConfig = decodeCursorSettings({})
              const resolveSettings = yield* makeResolveCursorSettings
              return yield* makeCursorAdapter(cursorConfig, { resolveSettings })
            }),
          ).pipe(
            Layer.provideMerge(ServerSettingsService.layerTest()),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: 't3code-cursor-adapter-test-',
              }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
  )

  it.effect(
    'auto-approves ACP tool permissions in full-access mode without approval runtime events',
    () =>
      Effect.gen(function* ()
      {
        const adapter = yield* CursorAdapter
        const serverSettings = yield* ServerSettingsService
        const threadId = ThreadId.make('cursor-full-access-auto-approve')
        const runtimeEvents: Array<ProviderRuntimeEvent> = []
        const settledEventTypes = new Set<string>()
        const settledEventsReady = yield* Deferred.make<void>()
        const tempDir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'cursor-acp-')),
        )
        const requestLogPath = NodePath.join(tempDir, 'requests.ndjson')
        const argvLogPath = NodePath.join(tempDir, 'argv.txt')
        yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, '', 'utf8'))
        const wrapperPath = yield* Effect.promise(() =>
          makeProbeWrapper(requestLogPath, argvLogPath, { T3_ACP_EMIT_TOOL_CALLS: '1' }),
        )
        yield* serverSettings.updateSettings({
          providers: { cursor: { binaryPath: wrapperPath } },
        })

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
              if (
                event.type === 'turn.completed' ||
                (event.type === 'item.completed' &&
                  event.payload.itemType === 'command_execution') ||
                event.type === 'content.delta'
              )
              {
                settledEventTypes.add(event.type)
                if (settledEventTypes.size === 3)
                {
                  yield* Deferred.succeed(settledEventsReady, undefined).pipe(Effect.orDie)
                }
              }
            }),
        ).pipe(Effect.forkChild)

        yield* startAcpTestSession(adapter, {
          threadId,
          provider: ProviderDriverKind.make('cursor'),
          cwd: process.cwd(),
          runtimeMode: 'full-access',
          modelSelection: { instanceId: ProviderInstanceId.make('cursor'), model: 'default' },
        })

        const turn = yield* adapter.sendTurn({
          threadId,
          input: 'run a tool call',
          attachments: [],
        })

        yield* Deferred.await(settledEventsReady)
        yield* Fiber.interrupt(runtimeEventsFiber)

        const turnEvents = runtimeEvents.filter(
          (event) =>
            String(event.threadId) === String(threadId) &&
            String(event.turnId) === String(turn.turnId),
        )
        assert.notInclude(
          turnEvents.map((event) => event.type),
          'request.opened',
        )
        assert.notInclude(
          turnEvents.map((event) => event.type),
          'request.resolved',
        )
        assert.includeMembers(
          turnEvents.map((event) => event.type),
          ['item.updated', 'item.completed', 'content.delta', 'turn.completed'],
        )

        const requests = yield* Effect.promise(() => readJsonLines(requestLogPath))
        const permissionResponse = requests.find(
          (entry) =>
            !('method' in entry) &&
            typeof entry.result === 'object' &&
            entry.result !== null &&
            'outcome' in entry.result &&
            typeof entry.result.outcome === 'object' &&
            entry.result.outcome !== null &&
            'outcome' in entry.result.outcome &&
            entry.result.outcome.outcome === 'selected' &&
            'optionId' in entry.result.outcome &&
            entry.result.outcome.optionId === 'allow-always',
        )
        assert.isDefined(permissionResponse)

        yield* adapter.stopSession(threadId)
      }),
  )

  it.effect('segments assistant messages around ACP tool activity in full-access mode', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* CursorAdapter
      const serverSettings = yield* ServerSettingsService
      const threadId = ThreadId.make('cursor-assistant-tool-segmentation')
      const runtimeEvents: Array<ProviderRuntimeEvent> = []
      const settledEventTypes = new Set<string>()
      const settledEventsReady = yield* Deferred.make<void>()

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_EMIT_INTERLEAVED_ASSISTANT_TOOL_CALLS: '1' }),
      )
      yield* serverSettings.updateSettings({
        providers: { cursor: { binaryPath: wrapperPath } },
      })

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
            if (
              event.type === 'content.delta' ||
              (event.type === 'item.completed' && event.payload.itemType === 'command_execution') ||
              event.type === 'turn.completed'
            )
            {
              if (event.type === 'content.delta')
              {
                settledEventTypes.add(`delta:${event.payload.delta}`)
              }
              else
              {
                settledEventTypes.add(event.type)
              }
              if (
                settledEventTypes.has('delta:before tool') &&
                settledEventTypes.has('delta:after tool') &&
                settledEventTypes.has('item.completed') &&
                settledEventTypes.has('turn.completed')
              )
              {
                yield* Deferred.succeed(settledEventsReady, undefined).pipe(Effect.orDie)
              }
            }
          }),
      ).pipe(Effect.forkChild)

      yield* startAcpTestSession(adapter, {
        threadId,
        provider: ProviderDriverKind.make('cursor'),
        cwd: process.cwd(),
        runtimeMode: 'full-access',
        modelSelection: { instanceId: ProviderInstanceId.make('cursor'), model: 'default' },
      })

      const turn = yield* adapter.sendTurn({
        threadId,
        input: 'run an interleaved tool call',
        attachments: [],
      })

      yield* Deferred.await(settledEventsReady)
      yield* Fiber.interrupt(runtimeEventsFiber)

      const turnEvents = runtimeEvents.filter(
        (event) =>
          String(event.threadId) === String(threadId) &&
          String(event.turnId) === String(turn.turnId),
      )
      const firstAssistantStartIndex = turnEvents.findIndex(
        (event) => event.type === 'item.started' && event.payload.itemType === 'assistant_message',
      )
      const firstAssistantDeltaIndex = turnEvents.findIndex(
        (event) => event.type === 'content.delta' && event.payload.delta === 'before tool',
      )
      const assistantBoundaryIndex = turnEvents.findIndex(
        (event) =>
          event.type === 'item.completed' && event.payload.itemType === 'assistant_message',
      )
      const toolUpdateIndex = turnEvents.findIndex(
        (event) => event.type === 'item.updated' && event.payload.itemType === 'command_execution',
      )
      const toolCompletedIndex = turnEvents.findIndex(
        (event) =>
          event.type === 'item.completed' && event.payload.itemType === 'command_execution',
      )
      const secondAssistantStartIndex = turnEvents.findIndex(
        (event, index) =>
          index > toolCompletedIndex &&
          event.type === 'item.started' &&
          event.payload.itemType === 'assistant_message',
      )
      const secondAssistantDeltaIndex = turnEvents.findIndex(
        (event) => event.type === 'content.delta' && event.payload.delta === 'after tool',
      )

      assert.isAtLeast(firstAssistantStartIndex, 0)
      assert.isAtLeast(firstAssistantDeltaIndex, 0)
      assert.isAtLeast(assistantBoundaryIndex, 0)
      assert.isAtLeast(toolUpdateIndex, 0)
      assert.isAtLeast(toolCompletedIndex, 0)
      assert.isAtLeast(secondAssistantStartIndex, 0)
      assert.isAtLeast(secondAssistantDeltaIndex, 0)
      assert.isBelow(firstAssistantStartIndex, firstAssistantDeltaIndex)
      assert.isBelow(firstAssistantDeltaIndex, assistantBoundaryIndex)
      assert.isBelow(assistantBoundaryIndex, toolUpdateIndex)
      assert.isBelow(toolUpdateIndex, toolCompletedIndex)
      assert.isBelow(toolCompletedIndex, secondAssistantStartIndex)
      assert.isBelow(secondAssistantStartIndex, secondAssistantDeltaIndex)

      const assistantStarts = turnEvents.filter(
        (event) => event.type === 'item.started' && event.payload.itemType === 'assistant_message',
      )
      const assistantDeltas = turnEvents.filter((event) => event.type === 'content.delta')
      assert.lengthOf(assistantStarts, 2)
      assert.lengthOf(assistantDeltas, 2)
      if (
        assistantStarts[0]?.type === 'item.started' &&
        assistantStarts[1]?.type === 'item.started' &&
        assistantDeltas[0]?.type === 'content.delta' &&
        assistantDeltas[1]?.type === 'content.delta'
      )
      {
        assert.notEqual(String(assistantStarts[0].itemId), String(assistantStarts[1].itemId))
        assert.equal(String(assistantDeltas[0].itemId), String(assistantStarts[0].itemId))
        assert.equal(String(assistantDeltas[1].itemId), String(assistantStarts[1].itemId))
      }

      yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('cancels pending ACP approvals and marks the turn cancelled when interrupted', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* CursorAdapter
      const serverSettings = yield* ServerSettingsService
      const threadId = ThreadId.make('cursor-cancel-probe')
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'cursor-acp-')),
      )
      const requestLogPath = NodePath.join(tempDir, 'requests.ndjson')
      const argvLogPath = NodePath.join(tempDir, 'argv.txt')
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, '', 'utf8'))
      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath, { T3_ACP_EMIT_TOOL_CALLS: '1' }),
      )
      yield* serverSettings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } })

      const requestResolvedReady = yield* Deferred.make<ProviderRuntimeEvent>()
      const turnCompletedReady = yield* Deferred.make<ProviderRuntimeEvent>()
      let interrupted = false

      const runtimeEventsFiber = yield* Stream.runForEach(
        unwrapAcpRuntimeEvents(adapter),
        (event) =>
          Effect.gen(function* ()
          {
            if (String(event.threadId) !== String(threadId))
            {
              return
            }
            if (event.type === 'request.opened' && event.requestId && !interrupted)
            {
              interrupted = true
              yield* adapter.respondToRequest(
                threadId,
                ApprovalRequestId.make(String(event.requestId)),
                'cancel',
              )
              yield* adapter.interruptTurn(threadId)
              return
            }
            if (event.type === 'request.resolved')
            {
              yield* Deferred.succeed(requestResolvedReady, event).pipe(Effect.ignore)
              return
            }
            if (event.type === 'turn.completed')
            {
              yield* Deferred.succeed(turnCompletedReady, event).pipe(Effect.ignore)
            }
          }),
      ).pipe(Effect.forkChild)

      yield* startAcpTestSession(adapter, {
        threadId,
        provider: ProviderDriverKind.make('cursor'),
        cwd: process.cwd(),
        runtimeMode: 'approval-required',
        modelSelection: { instanceId: ProviderInstanceId.make('cursor'), model: 'default' },
      })

      const sendTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: 'cancel this turn',
          attachments: [],
        })
        .pipe(Effect.forkChild)

      const requestResolved = yield* Deferred.await(requestResolvedReady)
      const turnCompleted = yield* Deferred.await(turnCompletedReady)
      yield* Fiber.join(sendTurnFiber)
      yield* Fiber.interrupt(runtimeEventsFiber)

      assert.equal(requestResolved.type, 'request.resolved')
      if (requestResolved.type === 'request.resolved')
      {
        assert.equal(requestResolved.payload.decision, 'cancel')
      }

      assert.equal(turnCompleted.type, 'turn.completed')
      if (turnCompleted.type === 'turn.completed')
      {
        assert.equal(turnCompleted.payload.state, 'cancelled')
        assert.equal(turnCompleted.payload.stopReason, 'cancelled')
      }

      const isCancelledApprovalResponse = (entry: Record<string, unknown>) =>
        !('method' in entry) &&
        typeof entry.result === 'object' &&
        entry.result !== null &&
        'outcome' in entry.result &&
        typeof entry.result.outcome === 'object' &&
        entry.result.outcome !== null &&
        'outcome' in entry.result.outcome &&
        entry.result.outcome.outcome === 'cancelled'
      const approvalResponses = yield* waitForJsonLogMatch(
        requestLogPath,
        isCancelledApprovalResponse,
      )
      assert.isTrue(approvalResponses.some(isCancelledApprovalResponse))

      yield* adapter.stopSession(threadId)
    }),
  )
  it.effect.each([
    {
      name: 'stop settles pending approval waits',
      threadId: 'cursor-stop-pending-approval',
      emitEnv: { T3_ACP_EMIT_TOOL_CALLS: '1' },
      waitEvent: 'request.opened' as const,
      runtimeMode: 'approval-required' as const,
      input: 'run a tool call and then stop',
      settle: 'stop' as const,
      expectSessionAfterSettle: false,
    },
    {
      name: 'stop settles pending user-input waits',
      threadId: 'cursor-stop-pending-user-input',
      emitEnv: { T3_ACP_EMIT_ASK_QUESTION: '1' },
      waitEvent: 'user-input.requested' as const,
      runtimeMode: 'full-access' as const,
      input: 'ask me a question and then stop',
      settle: 'stop' as const,
      expectSessionAfterSettle: false,
    },
    {
      name: 'interrupt settles pending user-input waits',
      threadId: 'cursor-interrupt-pending-user-input',
      emitEnv: { T3_ACP_EMIT_ASK_QUESTION: '1' },
      waitEvent: 'user-input.requested' as const,
      runtimeMode: 'full-access' as const,
      input: 'ask me a question and then interrupt',
      settle: 'interrupt' as const,
      expectSessionAfterSettle: true,
    },
  ])(
    '$name',
    ({
      threadId: threadIdValue,
      emitEnv,
      waitEvent,
      runtimeMode,
      input,
      settle,
      expectSessionAfterSettle,
    }) =>
      Effect.gen(function* ()
      {
        const adapter = yield* CursorAdapter
        const serverSettings = yield* ServerSettingsService
        const threadId = ThreadId.make(threadIdValue)
        const pendingRequested = yield* Deferred.make<void>()

        const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper(emitEnv))
        yield* serverSettings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } })

        yield* Stream.runForEach(unwrapAcpRuntimeEvents(adapter), (event) =>
        {
          if (String(event.threadId) !== String(threadId) || event.type !== waitEvent)
          {
            return Effect.void
          }
          return Deferred.succeed(pendingRequested, undefined).pipe(Effect.ignore)
        }).pipe(Effect.forkChild)

        yield* startAcpTestSession(adapter, {
          threadId,
          provider: ProviderDriverKind.make('cursor'),
          cwd: process.cwd(),
          runtimeMode,
          modelSelection: { instanceId: ProviderInstanceId.make('cursor'), model: 'default' },
        })

        const sendTurnFiber = yield* adapter
          .sendTurn({
            threadId,
            input,
            attachments: [],
          })
          .pipe(Effect.forkChild)

        yield* Deferred.await(pendingRequested)
        if (settle === 'stop')
        {
          yield* adapter.stopSession(threadId)
        }
        else
        {
          yield* adapter.interruptTurn(threadId)
        }
        yield* Fiber.await(sendTurnFiber)

        assert.equal(yield* adapter.hasSession(threadId), expectSessionAfterSettle)
        if (expectSessionAfterSettle)
        {
          yield* adapter.stopSession(threadId)
        }
      }),
  )

  it.effect('broadcasts runtime events to multiple stream consumers', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* CursorAdapter
      const settings = yield* ServerSettingsService
      const threadId = ThreadId.make('cursor-runtime-event-broadcast')

      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper())
      yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } })

      const firstConsumer = yield* Stream.take(unwrapAcpRuntimeEvents(adapter), 3).pipe(
        Stream.runCollect,
        Effect.forkChild,
      )
      const secondConsumer = yield* Stream.take(unwrapAcpRuntimeEvents(adapter), 3).pipe(
        Stream.runCollect,
        Effect.forkChild,
      )

      yield* startAcpTestSession(adapter, {
        threadId,
        provider: ProviderDriverKind.make('cursor'),
        cwd: process.cwd(),
        runtimeMode: 'full-access',
        modelSelection: { instanceId: ProviderInstanceId.make('cursor'), model: 'default' },
      })

      const firstEvents = Array.from(yield* Fiber.join(firstConsumer))
      const secondEvents = Array.from(yield* Fiber.join(secondConsumer))

      assert.deepStrictEqual(
        firstEvents.map((event) => event.type),
        ['session.started', 'session.state.changed', 'thread.started'],
      )
      assert.deepStrictEqual(
        secondEvents.map((event) => event.type),
        ['session.started', 'session.state.changed', 'thread.started'],
      )

      yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('keeps consuming notifications after the startSession fiber completes', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* CursorAdapter
      const settings = yield* ServerSettingsService
      const threadId = ThreadId.make('cursor-consumer-outlives-start-session')
      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper())
      yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } })

      const contentDelta = yield* Deferred.make<string>()
      const eventsFiber = yield* Stream.runForEach(unwrapAcpRuntimeEvents(adapter), (event) =>
        event.type === 'content.delta' && String(event.threadId) === String(threadId)
          ? Deferred.succeed(contentDelta, event.payload.delta).pipe(Effect.asVoid)
          : Effect.void,
      ).pipe(Effect.forkChild)

      // mirror production: the request fiber finishes immediately after session creation.
      const startFiber = yield* startAcpTestSession(adapter, {
        threadId,
        provider: ProviderDriverKind.make('cursor'),
        cwd: process.cwd(),
        runtimeMode: 'full-access',
        modelSelection: { instanceId: ProviderInstanceId.make('cursor'), model: 'default' },
      }).pipe(Effect.forkChild)
      yield* Fiber.join(startFiber).pipe(Effect.timeout('10 seconds'))

      const sendFiber = yield* adapter
        .sendTurn({ threadId, input: 'hello mock', attachments: [] })
        .pipe(Effect.forkChild)
      assert.equal(
        yield* Deferred.await(contentDelta).pipe(Effect.timeout('10 seconds')),
        'hello from mock',
      )
      yield* Fiber.join(sendFiber).pipe(Effect.timeout('10 seconds'))

      yield* Fiber.interrupt(eventsFiber)
      yield* adapter.stopSession(threadId)
    }).pipe(TestClock.withLive),
  )

  it.effect('switches model in-session via session/set_config_option', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* CursorAdapter
      const serverSettings = yield* ServerSettingsService
      const threadId = ThreadId.make('cursor-model-switch')
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'cursor-acp-')),
      )
      const requestLogPath = NodePath.join(tempDir, 'requests.ndjson')
      const argvLogPath = NodePath.join(tempDir, 'argv.txt')
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, '', 'utf8'))
      const wrapperPath = yield* Effect.promise(() => makeProbeWrapper(requestLogPath, argvLogPath))
      yield* serverSettings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } })

      yield* startAcpTestSession(adapter, {
        threadId,
        provider: ProviderDriverKind.make('cursor'),
        cwd: process.cwd(),
        runtimeMode: 'full-access',
        modelSelection: { instanceId: ProviderInstanceId.make('cursor'), model: 'composer-2' },
      })

      yield* adapter.sendTurn({
        threadId,
        input: 'first turn',
        attachments: [],
      })

      yield* adapter.sendTurn({
        threadId,
        input: 'second turn after switching model',
        attachments: [],
        modelSelection: createModelSelection(ProviderInstanceId.make('cursor'), 'composer-2', [
          { id: 'fastMode', value: true },
        ]),
      })

      const argvRuns = yield* Effect.promise(() => readArgvLog(argvLogPath))
      assert.lengthOf(argvRuns, 1, 'session should not restart — only one spawn')
      assert.deepStrictEqual(argvRuns[0], ['--force', 'acp'])

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath))
      const setConfigRequests = requests.filter(
        (entry) =>
          entry.method === 'session/set_config_option' &&
          (entry.params as Record<string, unknown> | undefined)?.configId === 'model',
      )
      assert.isAbove(setConfigRequests.length, 0, 'should call session/set_config_option')
      assert.equal((setConfigRequests[0]?.params as Record<string, unknown>)?.value, 'composer-2')

      const fastConfigRequests = requests.filter(
        (entry) =>
          entry.method === 'session/set_config_option' &&
          (entry.params as Record<string, unknown> | undefined)?.configId === 'fast',
      )
      assert.isAbove(fastConfigRequests.length, 0, 'should apply fast mode as a separate config')
      const lastFastConfig = fastConfigRequests[fastConfigRequests.length - 1]
      assert.equal((lastFastConfig?.params as Record<string, unknown>)?.value, 'true')

      yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('clears prior fast mode in-session when the next turn sets fastMode: false', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* CursorAdapter
      const serverSettings = yield* ServerSettingsService
      const threadId = ThreadId.make('cursor-fast-mode-reset')
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'cursor-acp-')),
      )
      const requestLogPath = NodePath.join(tempDir, 'requests.ndjson')
      const argvLogPath = NodePath.join(tempDir, 'argv.txt')
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, '', 'utf8'))
      const wrapperPath = yield* Effect.promise(() => makeProbeWrapper(requestLogPath, argvLogPath))
      yield* serverSettings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } })

      yield* startAcpTestSession(adapter, {
        threadId,
        provider: ProviderDriverKind.make('cursor'),
        cwd: process.cwd(),
        runtimeMode: 'full-access',
        modelSelection: { instanceId: ProviderInstanceId.make('cursor'), model: 'composer-2' },
      })

      yield* adapter.sendTurn({
        threadId,
        input: 'first turn with fast mode',
        attachments: [],
        modelSelection: createModelSelection(ProviderInstanceId.make('cursor'), 'composer-2', [
          { id: 'fastMode', value: true },
        ]),
      })

      yield* adapter.sendTurn({
        threadId,
        input: 'second turn without fast mode',
        attachments: [],
        modelSelection: createModelSelection(ProviderInstanceId.make('cursor'), 'composer-2', [
          { id: 'fastMode', value: false },
        ]),
      })

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath))
      const fastConfigRequests = requests.filter(
        (entry) =>
          entry.method === 'session/set_config_option' &&
          (entry.params as Record<string, unknown> | undefined)?.configId === 'fast',
      )
      assert.isAtLeast(fastConfigRequests.length, 2, 'should set fast mode on and then off')

      const lastFastConfig = fastConfigRequests[fastConfigRequests.length - 1]
      assert.equal((lastFastConfig?.params as Record<string, unknown>)?.value, 'false')

      yield* adapter.stopSession(threadId)
    }),
  )

  it.effect(
    'applies fast mode on the first turn when modelSelection uses a non-default instance id',
    () =>
    {
      const customInstanceId = ProviderInstanceId.make('cursor_secondary')
      // custom-instance cases can't share the suite-level `CursorAdapter`
      // layer because that one binds `instanceId: "cursor"`. We build a
      // fresh layer graph — including a fresh `ServerSettingsService` — so
      // mid-test `updateSettings` calls target the same service instance the
      // adapter's `resolveSettings` reads from, and so the outer
      // `yield* ServerSettingsService` sees the same snapshot as well.
      const customAdapterLayer = Layer.effect(
        CursorAdapter,
        Effect.gen(function* ()
        {
          const cursorConfig = decodeCursorSettings({})
          const resolveSettings = yield* makeResolveCursorSettings
          return yield* makeCursorAdapter(cursorConfig, {
            instanceId: customInstanceId,
            resolveSettings,
          })
        }),
      ).pipe(
        Layer.provideMerge(ServerSettingsService.layerTest()),
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), {
            prefix: 't3code-cursor-adapter-custom-instance-',
          }),
        ),
        Layer.provideMerge(NodeServices.layer),
      )

      return Effect.gen(function* ()
      {
        const adapter = yield* CursorAdapter
        const serverSettings = yield* ServerSettingsService
        const threadId = ThreadId.make('cursor-fast-mode-custom-instance')
        const tempDir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'cursor-acp-')),
        )
        const requestLogPath = NodePath.join(tempDir, 'requests.ndjson')
        const argvLogPath = NodePath.join(tempDir, 'argv.txt')
        yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, '', 'utf8'))
        const wrapperPath = yield* Effect.promise(() =>
          makeProbeWrapper(requestLogPath, argvLogPath),
        )
        yield* serverSettings.updateSettings({
          providers: { cursor: { binaryPath: wrapperPath } },
        })

        yield* startAcpTestSession(adapter, {
          threadId,
          provider: ProviderDriverKind.make('cursor'),
          cwd: process.cwd(),
          runtimeMode: 'full-access',
          modelSelection: {
            instanceId: customInstanceId,
            model: 'composer-2',
          },
        })

        yield* adapter.sendTurn({
          threadId,
          input: 'first turn with fast mode',
          attachments: [],
          modelSelection: {
            ...createModelSelection(ProviderInstanceId.make('cursor'), 'composer-2', [
              { id: 'fastMode', value: true },
            ]),
            instanceId: customInstanceId,
          },
        })

        const requests = yield* Effect.promise(() => readJsonLines(requestLogPath))
        const fastConfigRequests = requests.filter(
          (entry) =>
            entry.method === 'session/set_config_option' &&
            (entry.params as Record<string, unknown> | undefined)?.configId === 'fast',
        )
        assert.isAbove(
          fastConfigRequests.length,
          0,
          'fast mode should apply when instance id matches the adapter binding',
        )
        const lastFastConfig = fastConfigRequests[fastConfigRequests.length - 1]
        assert.equal((lastFastConfig?.params as Record<string, unknown>)?.value, 'true')

        yield* adapter.stopSession(threadId)
      }).pipe(Effect.provide(customAdapterLayer))
    },
  )
})
