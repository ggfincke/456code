// tests/apps/server/provider/Layers/GeminiAdapter.test.ts
// verify Gemini ACP lifecycle, load-fallback resume, auth, approvals, and termination

// @effect-diagnostics globalTimers:off - cancellation exercises a real child process
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from 'node:crypto'
import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'

import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, it } from '@effect/vitest'
import {
  ApprovalRequestId,
  GeminiSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import * as TestClock from 'effect/testing/TestClock'

import { makeGeminiAdapter } from '../../../../../apps/server/src/provider/Layers/GeminiAdapter.ts'
import { startAcpTestSession, unwrapAcpRuntimeEvents } from './acpLifecycleTestHelpers.ts'

const decodeGeminiSettings = Schema.decodeSync(GeminiSettings)
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url))
const mockAgentPath = NodePath.join(
  __dirname,
  '../../../../../apps/server/scripts/acp-mock-agent.ts',
)
const geminiHistoryTailSha256 = (text: string): string =>
  NodeCrypto.createHash('sha256')
    .update(JSON.stringify([{ type: 'text', text }]), 'utf8')
    .digest('hex')

function shellSingleQuote(value: string): string
{
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

async function makeMockGeminiWrapper(extraEnv: Record<string, string> = {}): Promise<string>
{
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'gemini-acp-mock-'))
  const wrapperPath = NodePath.join(dir, 'gemini')
  await NodeFSP.writeFile(
    wrapperPath,
    [
      '#!/bin/sh',
      'export T3_ACP_GEMINI_MODES=1',
      ...Object.entries(extraEnv).map(([key, value]) => `export ${key}=${shellSingleQuote(value)}`),
      'if [ -n "${T3_ACP_CHILD_ENV_LOG_PATH:-}" ]; then printf "GEMINI_API_KEY=%s\\nGOOGLE_API_KEY=%s\\n" "${GEMINI_API_KEY:-}" "${GOOGLE_API_KEY:-}" > "$T3_ACP_CHILD_ENV_LOG_PATH"; fi',
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

const waitForFile = (filePath: string, label: string) =>
{
  const wait = (attempts: number): Effect.Effect<void> =>
    Effect.promise(() => NodeFSP.access(filePath)).pipe(
      Effect.catch(() =>
        attempts <= 0
          ? Effect.die(new Error(`Timed out waiting for Gemini ${label}`))
          : Effect.sleep('20 millis').pipe(Effect.andThen(wait(attempts - 1))),
      ),
    )
  return wait(250)
}

const makeTestAdapter = (binaryPath: string, options?: Parameters<typeof makeGeminiAdapter>[1]) =>
  makeGeminiAdapter(decodeGeminiSettings({ binaryPath }), options).pipe(Effect.orDie)

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
          return Effect.die(new Error(`Timed out waiting for Gemini ACP ${label}`))
        }
        return Effect.sleep('20 millis').pipe(Effect.andThen(wait(attempts - 1)))
      }),
    )
  return wait(250)
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
          return Effect.die(new Error(`Timed out waiting for Gemini ACP ${label}`))
        }
        return Effect.sleep('20 millis').pipe(Effect.andThen(wait(attempts - 1)))
      }),
    )
  return wait(250)
}

const waitForGeminiTurnIdle = (
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
            return Effect.die(new Error('Timed out waiting for the Gemini session to go ready'))
          }
          return Effect.sleep('20 millis').pipe(Effect.andThen(wait(attempts - 1)))
        }),
      )
    return yield* wait(250)
  })

it.layer(NodeServices.layer)('GeminiAdapterLive', (it) =>
{
  it.effect('runs multiple Gemini turns, projects ACP events, and closes the child on stop', () =>
    Effect.gen(function* ()
    {
      const threadId = ThreadId.make('gemini-lifecycle')
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'gemini-exit-log-')),
      )
      const exitLogPath = NodePath.join(tempDir, 'exit.log')
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGeminiWrapper({ T3_ACP_EXIT_LOG_PATH: exitLogPath }),
      )
      const adapter = yield* makeTestAdapter(wrapperPath)
      assert.equal(adapter.capabilities.sessionModelSwitch, 'unsupported')
      const runtimeEvents: Array<ProviderRuntimeEvent> = []
      const activeTurnIdsAtCompletion = new Map<string, TurnId | undefined>()
      const eventsFiber = yield* Stream.runForEach(unwrapAcpRuntimeEvents(adapter), (event) =>
        Effect.gen(function* ()
        {
          runtimeEvents.push(event)
          if (event.type === 'turn.completed')
          {
            const session = (yield* adapter.listSessions()).find(
              (entry) => entry.threadId === threadId,
            )
            activeTurnIdsAtCompletion.set(String(event.turnId), session?.activeTurnId)
          }
        }),
      ).pipe(Effect.forkChild)

      const session = yield* startAcpTestSession(adapter, {
        threadId,
        provider: ProviderDriverKind.make('gemini'),
        cwd: process.cwd(),
        runtimeMode: 'approval-required',
      })
      assert.equal(adapter.capabilities.sessionModelSwitch, 'in-session')
      const firstTurn = yield* adapter.sendTurn({
        threadId,
        input: 'first Gemini turn',
        attachments: [],
      })
      yield* waitForGeminiTurnIdle(adapter, threadId, runtimeEvents, firstTurn.turnId)
      const secondTurn = yield* adapter.sendTurn({
        threadId,
        input: 'second Gemini turn',
        attachments: [],
      })
      yield* waitForGeminiTurnIdle(adapter, threadId, runtimeEvents, secondTurn.turnId)
      assert.isUndefined(activeTurnIdsAtCompletion.get(String(firstTurn.turnId)))
      assert.isUndefined(activeTurnIdsAtCompletion.get(String(secondTurn.turnId)))

      assert.equal(session.provider, 'gemini')
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
          (event) => String(event.providerInstanceId) === String(ProviderInstanceId.make('gemini')),
        ),
      )

      yield* adapter.stopSession(threadId)
      yield* Fiber.interrupt(eventsFiber)
      const exitLog = yield* Effect.promise(() => NodeFSP.readFile(exitLogPath, 'utf8'))
      assert.include(exitLog, 'SIGTERM')
    }).pipe(TestClock.withLive),
  )

  it.effect('settles a failed Gemini turn before publishing its terminal event', () =>
    Effect.gen(function* ()
    {
      const threadId = ThreadId.make('gemini-failed-turn-snapshot')
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGeminiWrapper({ T3_ACP_FAIL_PROMPT: '1' }),
      )
      const adapter = yield* makeTestAdapter(wrapperPath)
      const runtimeEvents: Array<ProviderRuntimeEvent> = []
      const activeTurnIdsAtCompletion = new Map<string, TurnId | undefined>()
      const eventsFiber = yield* Stream.runForEach(unwrapAcpRuntimeEvents(adapter), (event) =>
        Effect.gen(function* ()
        {
          runtimeEvents.push(event)
          if (event.type === 'turn.completed')
          {
            const session = (yield* adapter.listSessions()).find(
              (entry) => entry.threadId === threadId,
            )
            activeTurnIdsAtCompletion.set(String(event.turnId), session?.activeTurnId)
          }
        }),
      ).pipe(Effect.forkChild)

      yield* Effect.gen(function* ()
      {
        yield* startAcpTestSession(adapter, {
          threadId,
          provider: ProviderDriverKind.make('gemini'),
          cwd: process.cwd(),
          runtimeMode: 'approval-required',
        })
        const turn = yield* adapter.sendTurn({
          threadId,
          input: 'fail this turn',
          attachments: [],
        })
        yield* waitForRuntimeEvent(
          runtimeEvents,
          (event) => event.type === 'turn.completed' && event.turnId === turn.turnId,
          'failed turn completion',
        )
        const completion = runtimeEvents.find(
          (event) => event.type === 'turn.completed' && event.turnId === turn.turnId,
        )
        assert.equal(completion?.type, 'turn.completed')
        if (completion?.type === 'turn.completed')
        {
          assert.equal(completion.payload.state, 'failed')
        }
        assert.isUndefined(activeTurnIdsAtCompletion.get(String(turn.turnId)))
      }).pipe(
        Effect.ensuring(
          Effect.all(
            [
              Fiber.interrupt(eventsFiber).pipe(Effect.ignore),
              adapter.stopSession(threadId).pipe(Effect.ignore),
            ],
            { discard: true },
          ),
        ),
      )
    }).pipe(TestClock.withLive),
  )

  it.effect('uses only ACP-advertised Gemini runtime and interaction mode ids', () =>
    Effect.gen(function* ()
    {
      const threadId = ThreadId.make('gemini-modes')
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'gemini-mode-log-')),
      )
      const requestLogPath = NodePath.join(tempDir, 'requests.ndjson')
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGeminiWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      )
      const adapter = yield* makeTestAdapter(wrapperPath)
      const runtimeEvents: Array<ProviderRuntimeEvent> = []
      const eventsFiber = yield* Stream.runForEach(unwrapAcpRuntimeEvents(adapter), (event) =>
        Effect.sync(() => runtimeEvents.push(event)),
      ).pipe(Effect.forkChild)

      yield* Effect.gen(function* ()
      {
        yield* startAcpTestSession(adapter, {
          threadId,
          provider: ProviderDriverKind.make('gemini'),
          cwd: process.cwd(),
          runtimeMode: 'full-access',
        })
        assert.deepStrictEqual(adapter.capabilities.supportedRuntimeModes, [
          'approval-required',
          'auto-accept-edits',
          'full-access',
        ])
        assert.deepStrictEqual(adapter.capabilities.supportedInteractionModes, ['default', 'plan'])

        const turn = yield* adapter.sendTurn({
          threadId,
          input: 'plan this change',
          attachments: [],
          interactionMode: 'plan',
        })
        yield* waitForGeminiTurnIdle(adapter, threadId, runtimeEvents, turn.turnId)
        const requests = yield* Effect.promise(() => readJsonLines(requestLogPath))
        const selectedModes = requests.flatMap((entry) =>
          entry.method === 'session/set_mode' &&
          typeof entry.params === 'object' &&
          entry.params !== null &&
          'modeId' in entry.params &&
          typeof entry.params.modeId === 'string'
            ? [entry.params.modeId]
            : [],
        )
        assert.deepStrictEqual(selectedModes, ['yolo', 'plan'])
      }).pipe(
        Effect.ensuring(
          Effect.all(
            [
              Fiber.interrupt(eventsFiber).pipe(Effect.ignore),
              adapter.stopSession(threadId).pipe(Effect.ignore),
            ],
            { discard: true },
          ),
        ),
      )
    }).pipe(TestClock.withLive),
  )

  it.effect('resumes without replacing the preconfigured Gemini login', () =>
    Effect.gen(function* ()
    {
      const threadId = ThreadId.make('gemini-load-fallback')
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'gemini-resume-log-')),
      )
      const requestLogPath = NodePath.join(tempDir, 'requests.ndjson')
      // no T3_ACP_ADVERTISE_RESUME: gemini-cli only documents session/load,
      // so continuation must ride the replay-gated load fallback.
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGeminiWrapper({
          T3_ACP_AUTH_METHOD_IDS: 'oauth-personal,gemini-api-key,vertex-ai,gateway',
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      )
      const adapter = yield* makeTestAdapter(wrapperPath, {
        environment: { PATH: process.env.PATH },
      })

      const session = yield* startAcpTestSession(adapter, {
        threadId,
        provider: ProviderDriverKind.make('gemini'),
        cwd: process.cwd(),
        runtimeMode: 'approval-required',
        resumeCursor: {
          schemaVersion: 1,
          sessionId: 'mock-session-1',
          historyTailSha256: geminiHistoryTailSha256('replay'),
        },
      })
      yield* waitForRequestLog(
        requestLogPath,
        (entry) => entry.method === 'session/load',
        'session/load',
      )
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath))
      const methods = requests.flatMap((entry) =>
        typeof entry.method === 'string' ? [entry.method] : [],
      )

      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: 'mock-session-1',
        historyTailSha256: geminiHistoryTailSha256('replay'),
      })
      assert.include(methods, 'session/load')
      assert.notInclude(methods, 'session/resume')
      assert.notInclude(methods, 'authenticate')

      yield* adapter.stopSession(threadId)
    }).pipe(TestClock.withLive),
  )

  it.effect('replaces a Gemini load whose replay misses the local history tail', () =>
    Effect.gen(function* ()
    {
      const threadId = ThreadId.make('gemini-replay-tail-fallback')
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'gemini-replay-fallback-')),
      )
      const requestLogPath = NodePath.join(tempDir, 'requests.ndjson')
      const exitLogPath = NodePath.join(tempDir, 'exits.log')
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGeminiWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_EXIT_LOG_PATH: exitLogPath,
        }),
      )
      const adapter = yield* makeTestAdapter(wrapperPath)
      const runtimeEvents: Array<ProviderRuntimeEvent> = []
      const eventsFiber = yield* Stream.runForEach(unwrapAcpRuntimeEvents(adapter), (event) =>
        Effect.sync(() => runtimeEvents.push(event)),
      ).pipe(Effect.forkChild)

      yield* Effect.gen(function* ()
      {
        const session = yield* startAcpTestSession(adapter, {
          threadId,
          provider: ProviderDriverKind.make('gemini'),
          cwd: process.cwd(),
          runtimeMode: 'approval-required',
          resumeCursor: {
            schemaVersion: 1,
            sessionId: 'mock-session-1',
            historyTailSha256: geminiHistoryTailSha256('different local tail'),
          },
        })
        yield* waitForRuntimeEvent(
          runtimeEvents,
          (event) =>
            event.type === 'runtime.warning' &&
            event.payload.message.includes('fresh session was started'),
          'continuation-loss warning',
        )

        const requests = yield* Effect.promise(() => readJsonLines(requestLogPath))
        const methods = requests.flatMap((entry) =>
          typeof entry.method === 'string' ? [entry.method] : [],
        )
        assert.include(methods, 'session/load')
        assert.include(methods, 'session/new')
        assert.deepStrictEqual(session.resumeCursor, {
          schemaVersion: 1,
          sessionId: 'mock-session-1',
        })
        const exits = yield* Effect.promise(() => NodeFSP.readFile(exitLogPath, 'utf8'))
        assert.include(exits, 'SIGTERM')
      }).pipe(
        Effect.ensuring(
          Effect.all(
            [
              Fiber.interrupt(eventsFiber).pipe(Effect.ignore),
              adapter.stopSession(threadId).pipe(Effect.ignore),
            ],
            { discard: true },
          ),
        ),
      )
    }).pipe(TestClock.withLive),
  )

  it.effect('starts fresh when Gemini rejects a stored ACP session', () =>
    Effect.gen(function* ()
    {
      const threadId = ThreadId.make('gemini-load-error-fallback')
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'gemini-load-error-')),
      )
      const requestLogPath = NodePath.join(tempDir, 'requests.ndjson')
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGeminiWrapper({
          T3_ACP_FAIL_LOAD_SESSION: '1',
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      )
      const adapter = yield* makeTestAdapter(wrapperPath)
      const runtimeEvents: Array<ProviderRuntimeEvent> = []
      const eventsFiber = yield* Stream.runForEach(unwrapAcpRuntimeEvents(adapter), (event) =>
        Effect.sync(() => runtimeEvents.push(event)),
      ).pipe(Effect.forkChild)

      yield* Effect.gen(function* ()
      {
        yield* startAcpTestSession(adapter, {
          threadId,
          provider: ProviderDriverKind.make('gemini'),
          cwd: process.cwd(),
          runtimeMode: 'approval-required',
          resumeCursor: {
            schemaVersion: 1,
            sessionId: 'mock-session-1',
            historyTailSha256: geminiHistoryTailSha256('replay'),
          },
        })
        yield* waitForRuntimeEvent(
          runtimeEvents,
          (event) =>
            event.type === 'runtime.warning' &&
            event.payload.message.includes('fresh session was started'),
          'load-error continuation warning',
        )
        const requests = yield* Effect.promise(() => readJsonLines(requestLogPath))
        const methods = requests.flatMap((entry) =>
          typeof entry.method === 'string' ? [entry.method] : [],
        )
        assert.include(methods, 'session/load')
        assert.include(methods, 'session/new')
      }).pipe(
        Effect.ensuring(
          Effect.all(
            [
              Fiber.interrupt(eventsFiber).pipe(Effect.ignore),
              adapter.stopSession(threadId).pipe(Effect.ignore),
            ],
            { discard: true },
          ),
        ),
      )
    }).pipe(TestClock.withLive),
  )

  it.effect('authenticates through the advertised api-key method when a key is configured', () =>
    Effect.gen(function* ()
    {
      const threadId = ThreadId.make('gemini-api-key-auth')
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'gemini-auth-log-')),
      )
      const requestLogPath = NodePath.join(tempDir, 'requests.ndjson')
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGeminiWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_AUTH_METHOD_IDS: 'gemini-api-key,oauth-personal',
        }),
      )
      const adapter = yield* makeGeminiAdapter(
        decodeGeminiSettings({
          binaryPath: wrapperPath,
        }),
        {
          environment: { PATH: process.env.PATH, GEMINI_API_KEY: 'test-key-123' },
        },
      ).pipe(Effect.orDie)

      yield* startAcpTestSession(adapter, {
        threadId,
        provider: ProviderDriverKind.make('gemini'),
        cwd: process.cwd(),
        runtimeMode: 'approval-required',
      })
      yield* waitForRequestLog(
        requestLogPath,
        (entry) => entry.method === 'authenticate',
        'authenticate',
      )
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath))
      const authenticate = requests.find((entry) => entry.method === 'authenticate')

      assert.isDefined(authenticate)
      assert.deepStrictEqual(authenticate?.params, { methodId: 'gemini-api-key' })
      assert.include(
        requests.flatMap((entry) => (typeof entry.method === 'string' ? [entry.method] : [])),
        'session/new',
      )

      yield* adapter.stopSession(threadId)
    }).pipe(TestClock.withLive),
  )

  it.effect('does not reintroduce ambient API keys at the child process boundary', () =>
    Effect.gen(function* ()
    {
      const threadId = ThreadId.make('gemini-closed-child-environment')
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'gemini-child-env-')),
      )
      const envLogPath = NodePath.join(tempDir, 'child-env.log')
      const originalGeminiApiKey = process.env.GEMINI_API_KEY
      const originalGoogleApiKey = process.env.GOOGLE_API_KEY
      process.env.GEMINI_API_KEY = 'ambient-gemini-key'
      process.env.GOOGLE_API_KEY = 'ambient-google-key'
      try
      {
        const wrapperPath = yield* Effect.promise(() =>
          makeMockGeminiWrapper({ T3_ACP_CHILD_ENV_LOG_PATH: envLogPath }),
        )
        const adapter = yield* makeTestAdapter(wrapperPath, {
          environment: { PATH: process.env.PATH },
        })
        yield* startAcpTestSession(adapter, {
          threadId,
          provider: ProviderDriverKind.make('gemini'),
          cwd: process.cwd(),
          runtimeMode: 'approval-required',
        })
        yield* waitForFile(envLogPath, 'child environment log')
        const childEnvironment = yield* Effect.promise(() => NodeFSP.readFile(envLogPath, 'utf8'))
        assert.include(childEnvironment, 'GEMINI_API_KEY=\n')
        assert.include(childEnvironment, 'GOOGLE_API_KEY=\n')
        yield* adapter.stopSession(threadId)
      }
      finally
      {
        if (originalGeminiApiKey === undefined) delete process.env.GEMINI_API_KEY
        else process.env.GEMINI_API_KEY = originalGeminiApiKey
        if (originalGoogleApiKey === undefined) delete process.env.GOOGLE_API_KEY
        else process.env.GOOGLE_API_KEY = originalGoogleApiKey
      }
    }).pipe(TestClock.withLive),
  )

  it.effect('settles allow and reject through opaque request and provider option ids', () =>
    Effect.gen(function* ()
    {
      const scenarios = [
        {
          label: 'allow',
          decision: 'accept' as const,
          optionEnvironment: { T3_ACP_ALLOW_ONCE_OPTION_ID: 'gemini-agent-allow-once' },
          expectedOptionId: 'gemini-agent-allow-once',
        },
        {
          label: 'reject',
          decision: 'decline' as const,
          optionEnvironment: { T3_ACP_REJECT_ONCE_OPTION_ID: 'gemini-agent-reject-once' },
          expectedOptionId: 'gemini-agent-reject-once',
        },
      ]

      yield* Effect.forEach(scenarios, (scenario) =>
        Effect.gen(function* ()
        {
          const threadId = ThreadId.make(`gemini-approval-${scenario.label}`)
          const tempDir = yield* Effect.promise(() =>
            NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'gemini-approval-log-')),
          )
          const requestLogPath = NodePath.join(tempDir, 'requests.ndjson')
          const wrapperPath = yield* Effect.promise(() =>
            makeMockGeminiWrapper({
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
            provider: ProviderDriverKind.make('gemini'),
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
          yield* waitForGeminiTurnIdle(adapter, threadId, runtimeEvents, turn.turnId)

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

  it.effect('keeps terminal tool updates after cancellation and drops late assistant text', () =>
    Effect.gen(function* ()
    {
      const threadId = ThreadId.make('gemini-cancel-terminal-tool')
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'gemini-cancel-log-')),
      )
      const requestLogPath = NodePath.join(tempDir, 'requests.ndjson')
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGeminiWrapper({
          T3_ACP_HANG_FIRST_PROMPT_FOREVER: '1',
          T3_ACP_EMIT_LATE_UPDATE_AFTER_CANCEL: '1',
          T3_ACP_EMIT_LATE_TERMINAL_TOOL_AFTER_CANCEL: '1',
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      )
      const adapter = yield* makeTestAdapter(wrapperPath)
      const runtimeEvents: Array<ProviderRuntimeEvent> = []
      const eventsFiber = yield* Stream.runForEach(unwrapAcpRuntimeEvents(adapter), (event) =>
        Effect.sync(() => runtimeEvents.push(event)),
      ).pipe(Effect.forkChild)
      yield* Effect.gen(function* ()
      {
        yield* startAcpTestSession(adapter, {
          threadId,
          provider: ProviderDriverKind.make('gemini'),
          cwd: process.cwd(),
          runtimeMode: 'approval-required',
        })
        const turn = yield* adapter.sendTurn({
          threadId,
          input: 'cancel this turn',
          attachments: [],
        })
        yield* adapter.interruptTurn(threadId, turn.turnId).pipe(Effect.timeout('2 seconds'))
        yield* waitForRuntimeEvent(
          runtimeEvents,
          (event) => event.type === 'item.completed' && event.itemId === 'late-terminal-tool',
          'late terminal tool completion',
        )
        yield* waitForRuntimeEvent(
          runtimeEvents,
          (event) =>
            event.type === 'turn.completed' &&
            event.turnId === turn.turnId &&
            event.payload.state === 'cancelled',
          'cancelled turn completion',
        )

        assert.isTrue(
          runtimeEvents.some(
            (event) => event.type === 'turn.completed' && event.payload.state === 'cancelled',
          ),
        )
        assert.isFalse(
          runtimeEvents.some(
            (event) =>
              event.type === 'content.delta' && event.payload.delta === 'late after cancel',
          ),
        )

        yield* waitForGeminiTurnIdle(adapter, threadId, runtimeEvents, turn.turnId)
        const nextTurn = yield* adapter.sendTurn({
          threadId,
          input: 'continue after cancellation',
          attachments: [],
        })
        yield* waitForRequestLog(
          requestLogPath,
          (entry) =>
            entry.method === 'session/prompt' &&
            JSON.stringify(entry).includes('continue after cancellation'),
          'post-cancellation session/prompt',
        )
        yield* waitForGeminiTurnIdle(adapter, threadId, runtimeEvents, nextTurn.turnId)
      }).pipe(
        Effect.ensuring(
          Effect.all(
            [
              Fiber.interrupt(eventsFiber).pipe(Effect.ignore),
              adapter.stopSession(threadId).pipe(Effect.ignore),
            ],
            { discard: true },
          ),
        ),
      )
    }).pipe(TestClock.withLive),
  )

  it.effect('settles pending approvals before interrupt and rejects late responses', () =>
    Effect.gen(function* ()
    {
      const threadId = ThreadId.make('gemini-cancel-pending-approval')
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGeminiWrapper({ T3_ACP_EMIT_TOOL_CALLS: '1' }),
      )
      const adapter = yield* makeTestAdapter(wrapperPath)
      const runtimeEvents: Array<ProviderRuntimeEvent> = []
      const eventsFiber = yield* Stream.runForEach(unwrapAcpRuntimeEvents(adapter), (event) =>
        Effect.sync(() => runtimeEvents.push(event)),
      ).pipe(Effect.forkChild)
      yield* Effect.gen(function* ()
      {
        yield* startAcpTestSession(adapter, {
          threadId,
          provider: ProviderDriverKind.make('gemini'),
          cwd: process.cwd(),
          runtimeMode: 'approval-required',
        })
        const turn = yield* adapter.sendTurn({
          threadId,
          input: 'interrupt approval',
          attachments: [],
        })
        yield* waitForRuntimeEvent(
          runtimeEvents,
          (event) => event.type === 'request.opened',
          'pending approval',
        )
        const request = runtimeEvents.find((event) => event.type === 'request.opened')
        assert.isDefined(request)
        const requestId = request?.type === 'request.opened' ? request.requestId : undefined
        assert.isDefined(requestId)
        yield* adapter.interruptTurn(threadId, turn.turnId).pipe(Effect.timeout('2 seconds'))
        yield* waitForGeminiTurnIdle(adapter, threadId, runtimeEvents, turn.turnId)
        const lateResponse = yield* adapter
          .respondToRequest(threadId, ApprovalRequestId.make(String(requestId)), 'accept')
          .pipe(Effect.result)
        assert.isTrue(lateResponse._tag === 'Failure')
      }).pipe(
        Effect.ensuring(
          Effect.all(
            [
              Fiber.interrupt(eventsFiber).pipe(Effect.ignore),
              adapter.stopSession(threadId).pipe(Effect.ignore),
            ],
            { discard: true },
          ),
        ),
      )
    }).pipe(TestClock.withLive),
  )
})
