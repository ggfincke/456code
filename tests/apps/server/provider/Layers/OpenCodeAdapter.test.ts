// tests/apps/server/provider/Layers/OpenCodeAdapter.test.ts
// verifies opencode adapter session lifecycle and runtime event translation

import * as NodeAssert from 'node:assert/strict'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { it } from '@effect/vitest'
import * as Cause from 'effect/Cause'
import * as Context from 'effect/Context'
import * as Crypto from 'effect/Crypto'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'
import * as TestClock from 'effect/testing/TestClock'
import { beforeEach } from 'vite-plus/test'

import {
  OpenCodeSettings,
  ApprovalRequestId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from '@t3tools/contracts'
import { createModelSelection } from '@t3tools/shared/model'
import { ServerConfig } from '../../../../../apps/server/src/config.ts'
import { ServerSettingsService } from '../../../../../apps/server/src/serverSettings.ts'
import { ProviderSessionDirectory } from '../../../../../apps/server/src/provider/Services/ProviderSessionDirectory.ts'
import type { OpenCodeAdapterShape } from '../../../../../apps/server/src/provider/Services/OpenCodeAdapter.ts'
import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  type OpenCodeRuntimeShape,
  toOpenCodePermissionReply,
} from '../../../../../apps/server/src/provider/opencodeRuntime.ts'
import {
  appendOpenCodeAssistantTextDelta,
  isOpenCodeNotFound,
  isSameOpenCodeDirectory,
  mapOpenCodePermissionDecision,
  makeOpenCodeAdapter,
  mergeOpenCodeAssistantText,
  toToolLifecycleItemType,
} from '../../../../../apps/server/src/provider/Layers/OpenCodeAdapter.ts'
import {
  makeTestMcpProviderSession,
  TEST_MCP_AUTHORIZATION,
  TEST_MCP_ENDPOINT,
} from './mcpProviderSessionTestHelpers.ts'

// test-local service tag so the rest of the file can keep using `yield* OpenCodeAdapter`.
type OpenCodeSdkClient = ReturnType<OpenCodeRuntimeShape['createOpenCodeSdkClient']>
type OpenCodeEventSubscription = Awaited<ReturnType<OpenCodeSdkClient['event']['subscribe']>>
type OpenCodeEvent =
  OpenCodeEventSubscription['stream'] extends AsyncIterable<infer Event> ? Event : never
type PermissionRequest = NonNullable<
  Awaited<ReturnType<OpenCodeSdkClient['permission']['list']>>['data']
>[number]
type QuestionRequest = NonNullable<
  Awaited<ReturnType<OpenCodeSdkClient['question']['list']>>['data']
>[number]

class OpenCodeAdapter extends Context.Service<OpenCodeAdapter, OpenCodeAdapterShape>()(
  '@t3tools/tests/apps/server/provider/Layers/OpenCodeAdapter.test/OpenCodeAdapter',
)
{}

const asThreadId = (value: string): ThreadId => ThreadId.make(value)

it('maps accept-always approvals to OpenCode persistent permission replies', () =>
{
  NodeAssert.equal(toOpenCodePermissionReply('acceptAlways'), 'always')
  NodeAssert.equal(mapOpenCodePermissionDecision('always'), 'acceptAlways')
})

type OpenCodeTestSessionStartInput = Omit<
  Parameters<OpenCodeAdapterShape['startSession']>[0],
  'runtimeSessionBinding'
> & {
  readonly runtimeSessionBinding?: Parameters<
    OpenCodeAdapterShape['startSession']
  >[0]['runtimeSessionBinding']
}

function startOpenCodeTestSession(
  adapter: OpenCodeAdapterShape,
  input: OpenCodeTestSessionStartInput,
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

function unwrapOpenCodeRuntimeEvents(
  adapter: OpenCodeAdapterShape,
): Stream.Stream<ProviderRuntimeEvent>
{
  return adapter.streamEvents.pipe(Stream.map(({ event }) => event))
}

type MessageEntry = {
  info: {
    id: string
    role: 'user' | 'assistant'
  }
  parts: Array<unknown>
}

const runtimeMock = {
  state: {
    startCalls: [] as string[],
    sessionCreateUrls: [] as string[],
    sessionCreateInputs: [] as Array<Record<string, unknown>>,
    createdSessionIds: [] as string[],
    authHeaders: [] as Array<string | null>,
    abortCalls: [] as string[],
    abortSignals: [] as AbortSignal[],
    abortImplementation: null as
      ((sessionID: string, signal?: AbortSignal) => Promise<void>) | null,
    sessionChildrenCalls: [] as string[],
    sessionChildrenById: new Map<string, Array<{ id: string }>>(),
    closeCalls: [] as string[],
    revertCalls: [] as Array<{ sessionID: string; messageID?: string }>,
    messageCalls: [] as Array<{ sessionID: string; messageID: string }>,
    messageFailures: 0,
    promptCalls: [] as Array<unknown>,
    promptAsyncError: null as Error | null,
    promptAsyncImplementation: null as ((signal?: AbortSignal) => Promise<void>) | null,
    autoPromptEcho: true,
    autoConnect: true,
    endEventStream: false,
    promptEchoEvents: [] as Array<unknown>,
    closeError: null as Error | null,
    messages: [] as MessageEntry[],
    subscribedEvents: [] as Array<unknown | Promise<unknown>>,
    eventSubscribeObserved: null as (() => void) | null,
    eventStreamError: null as ((cause: unknown) => void) | null,
    randomUuidBlock: null as {
      readonly entered: () => void
      readonly release: Promise<void>
    } | null,
    permissionReplyCalls: [] as Array<{ requestID: string; reply: string }>,
    permissionReplyImplementation: null as
      ((requestID: string, reply: string, signal?: AbortSignal) => Promise<void>) | null,
    permissionReplySignals: [] as AbortSignal[],
    questionReplyCalls: [] as Array<{
      requestID: string
      answers: ReadonlyArray<ReadonlyArray<string>>
    }>,
    sessionStatus: 'idle' as 'idle' | 'busy',
    sessionStatusFailures: 0,
    sessionStatusCalls: 0,
    sessionStatusImplementation: null as (() => Promise<unknown>) | null,
    sessionGetIds: [] as string[],
    sessionGetSignals: [] as AbortSignal[],
    sessionGetObserved: null as ((sessionID: string) => void) | null,
    missingSessionIds: new Set<string>(),
    transientErrorSessionIds: new Set<string>(),
    sessionGetPayloadById: new Map<string, unknown>(),
    sessionGetBlock: null as {
      readonly sessionId: string
      readonly entered: () => void
      readonly release: Promise<void>
    } | null,
    sessionDirectoryById: new Map<string, string>(),
    sessionParentById: new Map<string, string>(),
    pendingPermissions: [] as Array<PermissionRequest>,
    pendingQuestions: [] as Array<QuestionRequest>,
    permissionListCalls: 0,
    questionListCalls: 0,
    permissionListImplementation: null as (() => Promise<Array<PermissionRequest>>) | null,
    questionListImplementation: null as (() => Promise<Array<QuestionRequest>>) | null,
    sessionUpdateCalls: [] as Array<{ sessionID: string; permission: unknown }>,
    mcpAddCalls: [] as Array<Record<string, unknown>>,
    promptSignals: [] as AbortSignal[],
    forkCalls: [] as Array<{ sessionID: string; directory?: string }>,
  },
  reset()
  {
    this.state.startCalls.length = 0
    this.state.sessionCreateUrls.length = 0
    this.state.sessionCreateInputs.length = 0
    this.state.createdSessionIds.length = 0
    this.state.authHeaders.length = 0
    this.state.abortCalls.length = 0
    this.state.abortSignals.length = 0
    this.state.abortImplementation = null
    this.state.sessionChildrenCalls.length = 0
    this.state.sessionChildrenById.clear()
    this.state.closeCalls.length = 0
    this.state.revertCalls.length = 0
    this.state.messageCalls.length = 0
    this.state.messageFailures = 0
    this.state.promptCalls.length = 0
    this.state.promptAsyncError = null
    this.state.promptAsyncImplementation = null
    this.state.autoPromptEcho = true
    this.state.autoConnect = true
    this.state.endEventStream = false
    this.state.promptEchoEvents.length = 0
    this.state.closeError = null
    this.state.messages = []
    this.state.subscribedEvents = []
    this.state.eventSubscribeObserved = null
    this.state.eventStreamError = null
    this.state.randomUuidBlock = null
    this.state.permissionReplyCalls.length = 0
    this.state.permissionReplyImplementation = null
    this.state.permissionReplySignals.length = 0
    this.state.questionReplyCalls.length = 0
    this.state.sessionStatus = 'idle'
    this.state.sessionStatusFailures = 0
    this.state.sessionStatusCalls = 0
    this.state.sessionStatusImplementation = null
    this.state.sessionGetIds.length = 0
    this.state.sessionGetSignals.length = 0
    this.state.sessionGetObserved = null
    this.state.missingSessionIds.clear()
    this.state.transientErrorSessionIds.clear()
    this.state.sessionGetPayloadById.clear()
    this.state.sessionGetBlock = null
    this.state.mcpAddCalls.length = 0
    this.state.promptSignals.length = 0
    this.state.sessionDirectoryById.clear()
    this.state.sessionParentById.clear()
    this.state.pendingPermissions = []
    this.state.pendingQuestions = []
    this.state.permissionListCalls = 0
    this.state.questionListCalls = 0
    this.state.permissionListImplementation = null
    this.state.questionListImplementation = null
    this.state.sessionUpdateCalls.length = 0
    this.state.forkCalls.length = 0
  },
}

const OpenCodeRuntimeTestDouble: OpenCodeRuntimeShape = {
  startOpenCodeServerProcess: ({ binaryPath, serverPassword }) =>
    Effect.gen(function* ()
    {
      runtimeMock.state.startCalls.push(binaryPath)
      const url = 'http://127.0.0.1:4301'
      yield* Effect.addFinalizer(() =>
        Effect.sync(() =>
        {
          runtimeMock.state.closeCalls.push(url)
          if (runtimeMock.state.closeError)
          {
            throw runtimeMock.state.closeError
          }
        }),
      )
      return {
        url,
        version: '1.15.13',
        ...(serverPassword ? { serverPassword } : {}),
        exitCode: Effect.never,
        isRunning: Effect.succeed(true),
      }
    }),
  connectToOpenCodeServer: ({ serverUrl, serverPassword }) =>
    Effect.gen(function* ()
    {
      const url = serverUrl ?? 'http://127.0.0.1:4301'
      // always register a finalizer so the closeCalls/closeError probes fire;
      // production attaches none for external servers.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() =>
        {
          runtimeMock.state.closeCalls.push(url)
          if (runtimeMock.state.closeError)
          {
            throw runtimeMock.state.closeError
          }
        }),
      )
      return {
        url,
        version: '1.15.13',
        ...(serverPassword ? { serverPassword } : {}),
        exitCode: null,
        external: Boolean(serverUrl),
      }
    }),
  runOpenCodeCommand: () => Effect.succeed({ stdout: '', stderr: '', code: 0 }),
  createOpenCodeSdkClient: ({ baseUrl, serverPassword }) =>
    ({
      mcp: {
        add: async (input: Record<string, unknown>) =>
        {
          runtimeMock.state.mcpAddCalls.push(input)
          return { data: true }
        },
      },
      session: {
        create: async (input: Record<string, unknown>) =>
        {
          runtimeMock.state.sessionCreateUrls.push(baseUrl)
          runtimeMock.state.sessionCreateInputs.push(input)
          runtimeMock.state.authHeaders.push(
            serverPassword ? `Basic ${btoa(`opencode:${serverPassword}`)}` : null,
          )
          return {
            data: { id: runtimeMock.state.createdSessionIds.shift() ?? `${baseUrl}/session` },
          }
        },
        get: async ({ sessionID }: { sessionID: string }, options?: { signal?: AbortSignal }) =>
        {
          runtimeMock.state.sessionGetIds.push(sessionID)
          if (options?.signal) runtimeMock.state.sessionGetSignals.push(options.signal)
          runtimeMock.state.sessionGetObserved?.(sessionID)
          const block = runtimeMock.state.sessionGetBlock
          if (block?.sessionId === sessionID)
          {
            block.entered()
            await block.release
          }

          // the real client is `throwOnError: true`: non-2xx rejects rather
          // than resolving, so missing -> 404 throw, transient -> 500 throw.
          if (runtimeMock.state.transientErrorSessionIds.has(sessionID))
          {
            throw new Error('opencode server error', { cause: { status: 500 } })
          }
          if (runtimeMock.state.missingSessionIds.has(sessionID))
          {
            throw new Error(`Session not found: ${sessionID}`, {
              cause: { status: 404, body: { name: 'NotFoundError' } },
            })
          }
          if (runtimeMock.state.sessionGetPayloadById.has(sessionID))
          {
            return { data: runtimeMock.state.sessionGetPayloadById.get(sessionID) }
          }
          const directory = runtimeMock.state.sessionDirectoryById.get(sessionID)
          const parentID = runtimeMock.state.sessionParentById.get(sessionID)
          return {
            data: {
              id: sessionID,
              ...(directory ? { directory } : {}),
              ...(parentID ? { parentID } : {}),
            },
          }
        },
        update: async ({ sessionID, permission }: { sessionID: string; permission: unknown }) =>
        {
          runtimeMock.state.sessionUpdateCalls.push({ sessionID, permission })
          return { data: { id: sessionID } }
        },
        fork: async ({ sessionID, directory }: { sessionID: string; directory?: string }) =>
        {
          // fork clones history into a new session bound to the directory.
          const forkedId = `${sessionID}_fork`
          runtimeMock.state.forkCalls.push({ sessionID, ...(directory ? { directory } : {}) })
          if (directory)
          {
            runtimeMock.state.sessionDirectoryById.set(forkedId, directory)
          }
          return { data: { id: forkedId, ...(directory ? { directory } : {}) } }
        },
        abort: async ({ sessionID }: { sessionID: string }, options?: { signal?: AbortSignal }) =>
        {
          runtimeMock.state.abortCalls.push(sessionID)
          if (options?.signal)
          {
            runtimeMock.state.abortSignals.push(options.signal)
          }
          await runtimeMock.state.abortImplementation?.(sessionID, options?.signal)
          runtimeMock.state.pendingPermissions = runtimeMock.state.pendingPermissions.filter(
            (request) => request.sessionID !== sessionID,
          )
          runtimeMock.state.pendingQuestions = runtimeMock.state.pendingQuestions.filter(
            (request) => request.sessionID !== sessionID,
          )
        },
        children: async ({ sessionID }: { sessionID: string }) =>
        {
          runtimeMock.state.sessionChildrenCalls.push(sessionID)
          return { data: runtimeMock.state.sessionChildrenById.get(sessionID) ?? [] }
        },
        status: async () =>
        {
          runtimeMock.state.sessionStatusCalls += 1
          if (runtimeMock.state.sessionStatusImplementation)
          {
            return await runtimeMock.state.sessionStatusImplementation()
          }
          if (runtimeMock.state.sessionStatusFailures > 0)
          {
            runtimeMock.state.sessionStatusFailures -= 1
            throw new Error('status failed')
          }
          return {
            data:
              runtimeMock.state.sessionStatus === 'idle'
                ? {}
                : { 'http://127.0.0.1:9999/session': { type: 'busy' as const } },
          }
        },
        promptAsync: async (input: unknown, options?: { signal?: AbortSignal }) =>
        {
          runtimeMock.state.promptCalls.push(input)
          if (options?.signal) runtimeMock.state.promptSignals.push(options.signal)
          await runtimeMock.state.promptAsyncImplementation?.(options?.signal)
          if (runtimeMock.state.promptAsyncError)
          {
            throw runtimeMock.state.promptAsyncError
          }
          if (
            runtimeMock.state.autoPromptEcho &&
            typeof input === 'object' &&
            input !== null &&
            'sessionID' in input &&
            'messageID' in input &&
            typeof input.sessionID === 'string' &&
            typeof input.messageID === 'string'
          )
          {
            runtimeMock.state.messages.push({
              info: { id: input.messageID, role: 'user' },
              parts: [],
            })
            runtimeMock.state.promptEchoEvents.push({
              id: `evt-auto-user-${input.messageID}`,
              type: 'message.updated',
              properties: {
                sessionID: input.sessionID,
                info: { id: input.messageID, role: 'user' },
              },
            })
          }
        },
        messages: async () => ({ data: runtimeMock.state.messages }),
        message: async ({ sessionID, messageID }: { sessionID: string; messageID: string }) =>
        {
          runtimeMock.state.messageCalls.push({ sessionID, messageID })
          if (runtimeMock.state.messageFailures > 0)
          {
            runtimeMock.state.messageFailures -= 1
            throw new Error('message lookup failed', { cause: { status: 500 } })
          }
          const message = runtimeMock.state.messages.find((entry) => entry.info.id === messageID)
          if (!message)
          {
            throw new Error(`Message not found: ${messageID}`, {
              cause: { status: 404, body: { name: 'NotFoundError' } },
            })
          }
          return { data: message }
        },
        revert: async ({ sessionID, messageID }: { sessionID: string; messageID?: string }) =>
        {
          runtimeMock.state.revertCalls.push({
            sessionID,
            ...(messageID ? { messageID } : {}),
          })
          if (!messageID)
          {
            runtimeMock.state.messages = []
            return
          }

          const targetIndex = runtimeMock.state.messages.findIndex(
            (entry) => entry.info.id === messageID,
          )
          runtimeMock.state.messages =
            targetIndex >= 0
              ? runtimeMock.state.messages.slice(0, targetIndex + 1)
              : runtimeMock.state.messages
        },
      },
      event: {
        subscribe: async (
          _input: unknown,
          options?: { signal?: AbortSignal; onSseError?: (cause: unknown) => void },
        ) =>
        {
          runtimeMock.state.eventSubscribeObserved?.()
          runtimeMock.state.eventStreamError = options?.onSseError ?? null
          return {
            stream: (async function* ()
            {
              const aborted = promiseWithResolvers<void>()
              const onAbort = () => aborted.resolve(undefined)
              options?.signal?.addEventListener('abort', onAbort, { once: true })
              try
              {
                if (runtimeMock.state.autoConnect)
                {
                  yield { id: 'evt-auto-connected', type: 'server.connected', properties: {} }
                }
                for (const event of runtimeMock.state.subscribedEvents)
                {
                  if (options?.signal?.aborted) return
                  const resolved = await Promise.race([event, aborted.promise])
                  if (options?.signal?.aborted) return
                  while (runtimeMock.state.promptEchoEvents.length > 0)
                  {
                    yield runtimeMock.state.promptEchoEvents.shift()
                  }
                  const nativeEvent = resolved as OpenCodeEvent
                  if (nativeEvent.type === 'permission.asked')
                  {
                    runtimeMock.state.pendingPermissions = runtimeMock.state.pendingPermissions
                      .filter((request) => request.id !== nativeEvent.properties.id)
                      .concat(nativeEvent.properties)
                  }
                  else if (nativeEvent.type === 'permission.replied')
                  {
                    runtimeMock.state.pendingPermissions =
                      runtimeMock.state.pendingPermissions.filter(
                        (request) => request.id !== nativeEvent.properties.requestID,
                      )
                  }
                  yield resolved
                }
                if (!runtimeMock.state.endEventStream && !options?.signal?.aborted)
                {
                  await aborted.promise
                }
              }
              finally
              {
                options?.signal?.removeEventListener('abort', onAbort)
              }
            })(),
          }
        },
      },
      permission: {
        list: async () =>
        {
          runtimeMock.state.permissionListCalls += 1
          return {
            data: runtimeMock.state.permissionListImplementation
              ? await runtimeMock.state.permissionListImplementation()
              : runtimeMock.state.pendingPermissions,
          }
        },
        reply: async (
          { requestID, reply }: { requestID: string; reply: string },
          options?: { signal?: AbortSignal },
        ) =>
        {
          runtimeMock.state.permissionReplyCalls.push({ requestID, reply })
          if (options?.signal) runtimeMock.state.permissionReplySignals.push(options.signal)
          await runtimeMock.state.permissionReplyImplementation?.(requestID, reply, options?.signal)
          runtimeMock.state.pendingPermissions = runtimeMock.state.pendingPermissions.filter(
            (request) => request.id !== requestID,
          )
        },
      },
      question: {
        list: async () =>
        {
          runtimeMock.state.questionListCalls += 1
          return {
            data: runtimeMock.state.questionListImplementation
              ? await runtimeMock.state.questionListImplementation()
              : runtimeMock.state.pendingQuestions,
          }
        },
        reply: async ({
          requestID,
          answers,
        }: {
          requestID: string
          answers: ReadonlyArray<ReadonlyArray<string>>
        }) =>
        {
          runtimeMock.state.questionReplyCalls.push({ requestID, answers })
        },
      },
    }) as unknown as ReturnType<OpenCodeRuntimeShape['createOpenCodeSdkClient']>,
  loadOpenCodeInventory: () =>
    Effect.fail(
      new OpenCodeRuntimeError({
        operation: 'loadOpenCodeInventory',
        detail: 'OpenCodeRuntimeTestDouble.loadOpenCodeInventory not used in this test',
        cause: null,
      }),
    ),
  loadInventoryFromCli: () =>
    Effect.fail(
      new OpenCodeRuntimeError({
        operation: 'loadInventoryFromCli',
        detail: 'OpenCodeRuntimeTestDouble.loadInventoryFromCli not used in this test',
        cause: null,
      }),
    ),
}

const providerSessionDirectoryTestLayer = Layer.succeed(ProviderSessionDirectory, {
  upsert: () => Effect.void,
  getProvider: () =>
    Effect.die(new Error('ProviderSessionDirectory.getProvider is not used in test')),
  getBinding: () => Effect.succeed(Option.none()),
  listThreadIds: () => Effect.succeed([]),
  listBindings: () => Effect.succeed([]),
})

// the adapter now receives its settings as a plain argument (the old design
// read from `ServerSettingsService` internally). The test-only
// `ServerSettingsService` below is still kept because other dependencies in
// the layer graph reach for it — but the routing values the assertions
// probe (serverUrl, serverPassword) must be threaded directly through the
// decoded `OpenCodeSettings`.
const openCodeAdapterTestSettings = Schema.decodeSync(OpenCodeSettings)({
  binaryPath: 'fake-opencode',
  serverUrl: 'http://127.0.0.1:9999',
  serverPassword: 'secret-password',
})
const openCodeMcpAdapterTestSettings = Schema.decodeSync(OpenCodeSettings)({
  binaryPath: 'fake-opencode',
})
const openCodeTestCryptoLayer = Layer.effect(
  Crypto.Crypto,
  Effect.gen(function* ()
  {
    const crypto = yield* Crypto.Crypto
    return Crypto.Crypto.of({
      ...crypto,
      randomUUIDv4: Effect.suspend(() =>
      {
        const block = runtimeMock.state.randomUuidBlock
        if (block === null) return crypto.randomUUIDv4
        runtimeMock.state.randomUuidBlock = null
        block.entered()
        return Effect.promise(() => block.release).pipe(Effect.andThen(crypto.randomUUIDv4))
      }),
    })
  }),
).pipe(Layer.provide(NodeServices.layer))
const openCodeTestNodeServicesLayer = Layer.merge(NodeServices.layer, openCodeTestCryptoLayer)

const OpenCodeAdapterTestLayer = Layer.effect(
  OpenCodeAdapter,
  makeOpenCodeAdapter(openCodeAdapterTestSettings),
).pipe(
  Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
  Layer.provideMerge(
    ServerSettingsService.layerTest({
      providers: {
        opencode: {
          binaryPath: 'fake-opencode',
          serverUrl: 'http://127.0.0.1:9999',
          serverPassword: 'secret-password',
        },
      },
    }),
  ),
  Layer.provideMerge(providerSessionDirectoryTestLayer),
  Layer.provideMerge(openCodeTestNodeServicesLayer),
)

beforeEach(() =>
{
  runtimeMock.reset()
})

const advanceTestClock = (ms: number) =>
  TestClock.adjust(`${ms} millis`).pipe(Effect.andThen(Effect.yieldNow))

function promiseWithResolvers<T>()
{
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) =>
  {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const permissionRequest = (id: string, sessionID: string): PermissionRequest => ({
  id,
  sessionID,
  permission: 'bash',
  patterns: ['pwd'],
  metadata: {},
  always: [],
})

const questionRequest = (id: string, sessionID: string): QuestionRequest => ({
  id,
  sessionID,
  questions: [
    {
      header: 'Scope',
      question: 'Which scope should OpenCode use?',
      options: [{ label: 'Workspace', description: 'Use this workspace.' }],
    },
  ],
})

it.layer(OpenCodeAdapterTestLayer)('OpenCodeAdapterLive', (it) =>
{
  it.effect('aborts the admitted SDK request when its send caller is interrupted', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      const threadId = asThreadId('thread-interrupted-send-caller')
      const started = promiseWithResolvers<void>()
      runtimeMock.state.promptAsyncImplementation = (signal) =>
        new Promise<void>((_resolve, reject) =>
        {
          started.resolve(undefined)
          signal?.addEventListener('abort', () => reject(new Error('prompt interrupted')), {
            once: true,
          })
        })
      yield* startOpenCodeTestSession(adapter, {
        provider: ProviderDriverKind.make('opencode'),
        threadId,
        runtimeMode: 'full-access',
      })
      const sending = yield* adapter
        .sendTurn({
          threadId,
          input: 'Start work',
          modelSelection: createModelSelection(
            ProviderInstanceId.make('opencode'),
            'opencode/kimi-k2.5',
          ),
        })
        .pipe(Effect.forkChild)
      yield* Effect.promise(() => started.promise)
      yield* Fiber.interrupt(sending)
      NodeAssert.equal(runtimeMock.state.promptSignals[0]?.aborted, true)
      NodeAssert.deepEqual(runtimeMock.state.abortCalls, ['http://127.0.0.1:9999/session'])
      const session = (yield* adapter.listSessions()).find((entry) => entry.threadId === threadId)
      NodeAssert.equal(session?.status, 'ready')
      NodeAssert.equal(session?.activeTurnId, undefined)
      runtimeMock.state.promptAsyncImplementation = null
      yield* adapter.stopSession(threadId)
    }),
  )
  it.effect('keeps a native startup alive when only a compatible joiner is interrupted', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      const threadId = asThreadId('thread-native-start-joiner')
      const entered = promiseWithResolvers<void>()
      const release = promiseWithResolvers<void>()
      runtimeMock.state.sessionGetBlock = {
        sessionId: 'ses_joined',
        entered: () => entered.resolve(undefined),
        release: release.promise,
      }
      const input = {
        provider: ProviderDriverKind.make('opencode'),
        threadId,
        runtimeMode: 'approval-required' as const,
        resumeCursor: { schemaVersion: 1, sessionId: 'ses_joined', requireExisting: true },
      }
      const owner = yield* startOpenCodeTestSession(adapter, input).pipe(Effect.forkChild)
      yield* Effect.promise(() => entered.promise)
      const joiner = yield* startOpenCodeTestSession(adapter, input).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Fiber.interrupt(joiner)
      NodeAssert.equal(runtimeMock.state.sessionGetSignals[0]?.aborted, false)
      release.resolve(undefined)
      NodeAssert.equal((yield* Fiber.join(owner)).status, 'ready')
      NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, ['ses_joined'])
      yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('does not join a pending start from a different durable generation', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      const threadId = asThreadId('thread-start-generation')
      const connected = promiseWithResolvers<unknown>()
      const subscribed = promiseWithResolvers<void>()
      runtimeMock.state.autoConnect = false
      runtimeMock.state.createdSessionIds.push('ses_generation_one', 'ses_generation_two')
      runtimeMock.state.subscribedEvents = [connected.promise]
      runtimeMock.state.eventSubscribeObserved = () => subscribed.resolve(undefined)
      const binding = {
        providerInstanceId: ProviderInstanceId.make('opencode'),
        threadId,
        sessionGeneration: 1,
      }
      const input = {
        provider: ProviderDriverKind.make('opencode'),
        threadId,
        runtimeMode: 'full-access' as const,
        runtimeSessionBinding: binding,
      }
      const events = yield* adapter.streamEvents.pipe(
        Stream.filter(
          ({ event }) => event.threadId === threadId && event.type === 'thread.started',
        ),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      )
      const first = yield* startOpenCodeTestSession(adapter, input).pipe(Effect.forkChild)
      yield* Effect.promise(() => subscribed.promise)
      const second = yield* startOpenCodeTestSession(adapter, {
        ...input,
        runtimeSessionBinding: { ...binding, sessionGeneration: 2 },
      }).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      NodeAssert.equal(runtimeMock.state.sessionCreateUrls.length, 1)
      connected.resolve({ id: 'connected-generation', type: 'server.connected', properties: {} })
      const firstSession = yield* Fiber.join(first)
      const secondSession = yield* Fiber.join(second)
      NodeAssert.notDeepEqual(firstSession.resumeCursor, secondSession.resumeCursor)
      NodeAssert.equal(runtimeMock.state.sessionCreateUrls.length, 2)
      NodeAssert.equal((yield* adapter.getSessionRuntimeBinding(threadId))?.sessionGeneration, 2)
      NodeAssert.deepEqual(
        (yield* Fiber.join(events)).map(({ binding }) => binding.sessionGeneration),
        [1, 2],
      )
      yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('keeps a replacement binding when an older stopAll finishes cleanup', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      const threadId = asThreadId('thread-stopall-replacement')
      const entered = promiseWithResolvers<void>()
      const release = promiseWithResolvers<void>()
      runtimeMock.state.createdSessionIds.push('ses_cleanup_old', 'ses_cleanup_new')
      const input = {
        provider: ProviderDriverKind.make('opencode'),
        threadId,
        runtimeMode: 'full-access' as const,
      }
      yield* startOpenCodeTestSession(adapter, input)
      runtimeMock.state.abortImplementation = async (sessionId) =>
      {
        if (sessionId === 'ses_cleanup_old')
        {
          entered.resolve(undefined)
          await release.promise
        }
      }
      const stopping = yield* adapter.stopAll().pipe(Effect.forkChild)
      yield* Effect.promise(() => entered.promise)
      const replacement = yield* startOpenCodeTestSession(adapter, {
        ...input,
        runtimeSessionBinding: {
          providerInstanceId: ProviderInstanceId.make('opencode'),
          threadId,
          sessionGeneration: 2,
        },
      })
      release.resolve(undefined)
      yield* Fiber.join(stopping)
      NodeAssert.equal(yield* adapter.hasSession(threadId), true)
      NodeAssert.deepEqual(
        (yield* adapter.listSessions()).find((session) => session.threadId === threadId),
        replacement,
      )
      NodeAssert.equal((yield* adapter.getSessionRuntimeBinding(threadId))?.sessionGeneration, 2)
      runtimeMock.state.abortImplementation = null
      yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('rejects unrelated, cyclic, mismatched, and over-depth child request ancestry', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      const threadId = asThreadId('thread-invalid-child-ancestry')
      const bounded = promiseWithResolvers<void>()
      runtimeMock.state.sessionGetObserved = (id) =>
      {
        if (id === 'ses_depth_31') bounded.resolve(undefined)
      }
      runtimeMock.state.sessionParentById.set('ses_cycle_a', 'ses_cycle_b')
      runtimeMock.state.sessionParentById.set('ses_cycle_b', 'ses_cycle_a')
      runtimeMock.state.sessionGetPayloadById.set('ses_mismatch', {
        id: 'ses_other',
        parentID: 'ses_parent',
      })
      for (let depth = 0; depth < 33; depth += 1)
      {
        runtimeMock.state.sessionParentById.set(
          `ses_depth_${depth}`,
          depth === 32 ? 'ses_parent' : `ses_depth_${depth + 1}`,
        )
      }
      const invalid = ['ses_unrelated', 'ses_cycle_a', 'ses_mismatch', 'ses_depth_0']
      runtimeMock.state.pendingPermissions = invalid.map((id) => permissionRequest(`per_${id}`, id))
      yield* startOpenCodeTestSession(adapter, {
        provider: ProviderDriverKind.make('opencode'),
        threadId,
        runtimeMode: 'approval-required',
        resumeCursor: { schemaVersion: 1, sessionId: 'ses_parent', requireExisting: true },
      })
      yield* Effect.promise(() => bounded.promise)
      yield* Effect.yieldNow
      for (const id of invalid)
      {
        const response = yield* adapter
          .respondToRequest(threadId, ApprovalRequestId.make(`per_${id}`), 'accept')
          .pipe(Effect.result)
        NodeAssert.equal(response._tag, 'Failure')
      }
      NodeAssert.equal(runtimeMock.state.sessionGetIds.includes('ses_depth_32'), false)
      NodeAssert.equal(
        runtimeMock.state.sessionGetIds.filter((id) => id === 'ses_cycle_a').length,
        1,
      )
      NodeAssert.deepEqual(runtimeMock.state.permissionReplyCalls, [])
      yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('emits each terminal child request once and retains acceptAlways', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      const threadId = asThreadId('thread-terminal-request-dedup')
      const parentId = 'http://127.0.0.1:9999/session'
      const childId = 'ses_terminal_child'
      const terminal = {
        id: 'permission-terminal',
        type: 'permission.replied',
        properties: { sessionID: childId, requestID: 'per_terminal', reply: 'always' },
      }
      runtimeMock.state.subscribedEvents = [
        {
          id: 'child-created',
          type: 'session.created',
          properties: { sessionID: childId, info: { id: childId, parentID: parentId } },
        },
        {
          id: 'permission-asked',
          type: 'permission.asked',
          properties: permissionRequest('per_terminal', childId),
        },
        terminal,
        terminal,
        {
          id: 'terminal-marker',
          type: 'session.updated',
          properties: { sessionID: parentId, info: { id: parentId, title: 'Terminal marker' } },
        },
      ]
      const events = yield* unwrapOpenCodeRuntimeEvents(adapter).pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.takeUntil((event) => event.type === 'thread.metadata.updated'),
        Stream.runCollect,
        Effect.forkChild,
      )
      yield* startOpenCodeTestSession(adapter, {
        provider: ProviderDriverKind.make('opencode'),
        threadId,
        runtimeMode: 'approval-required',
      })
      const resolved = (yield* Fiber.join(events)).filter(
        (event) => event.type === 'request.resolved',
      )
      NodeAssert.equal(resolved.length, 1)
      NodeAssert.equal(resolved[0]?.payload.decision, 'acceptAlways')
      const response = yield* adapter
        .respondToRequest(threadId, ApprovalRequestId.make('per_terminal'), 'accept')
        .pipe(Effect.result)
      NodeAssert.equal(response._tag, 'Failure')
      yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('surfaces one manual workspace-aware approval when full-access auto-reply fails', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      const threadId = asThreadId('thread-full-access-reply-failed')
      const request = permissionRequest('per_doom_loop_failed', 'http://127.0.0.1:9999/session')
      runtimeMock.state.permissionReplyImplementation = async () =>
      {
        throw new Error('reply failed')
      }
      runtimeMock.state.subscribedEvents = [
        {
          id: 'evt-doom-loop',
          type: 'permission.asked',
          properties: { ...request, permission: 'doom_loop', patterns: ['bash'] },
        },
      ]

      const openedFiber = yield* unwrapOpenCodeRuntimeEvents(adapter).pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === 'request.opened'),
        Stream.runHead,
        Effect.forkChild,
      )
      yield* startOpenCodeTestSession(adapter, {
        provider: ProviderDriverKind.make('opencode'),
        threadId,
        runtimeMode: 'full-access',
      })

      const opened = Option.getOrThrow(
        yield* Fiber.join(openedFiber).pipe(Effect.timeout('1 second')),
      )
      NodeAssert.equal(opened.requestId, request.id)
      if (opened.type === 'request.opened')
      {
        NodeAssert.deepEqual(opened.payload.options, [
          { decision: 'accept', label: 'Allow once' },
          { decision: 'acceptAlways', label: 'Allow for workspace' },
          { decision: 'decline', label: 'Deny' },
        ])
      }
      NodeAssert.deepEqual(runtimeMock.state.permissionReplyCalls, [
        { requestID: request.id, reply: 'once' },
      ])
      yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('preserves an observed native rejection when the HTTP approval succeeds', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      const threadId = asThreadId('thread-native-reply-wins')
      const sessionID = 'http://127.0.0.1:9999/session'
      const request = permissionRequest('per_native_reply_wins', sessionID)
      const nativeReply = promiseWithResolvers<OpenCodeEvent>()
      const requestOpened = promiseWithResolvers<void>()
      const nativeBaseStarted = promiseWithResolvers<void>()
      const releaseNativeBase = promiseWithResolvers<void>()
      runtimeMock.state.subscribedEvents = [
        { id: 'evt-ask', type: 'permission.asked', properties: request },
        nativeReply.promise,
        {
          id: 'evt-native-reply-marker',
          type: 'session.updated',
          properties: { sessionID, info: { id: sessionID, title: 'Reply marker' } },
        },
      ]
      runtimeMock.state.permissionReplyImplementation = async (requestID) =>
      {
        nativeReply.resolve({
          id: 'evt-native-reject',
          type: 'permission.replied',
          properties: { sessionID, requestID, reply: 'reject' },
        })
        await nativeBaseStarted.promise
      }

      const eventsFiber = yield* unwrapOpenCodeRuntimeEvents(adapter).pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.tap((event) =>
          Effect.sync(() =>
          {
            if (event.type === 'request.opened') requestOpened.resolve(undefined)
          }),
        ),
        Stream.takeUntil((event) => event.type === 'thread.metadata.updated'),
        Stream.runCollect,
        Effect.forkChild,
      )
      yield* startOpenCodeTestSession(adapter, {
        provider: ProviderDriverKind.make('opencode'),
        threadId,
        runtimeMode: 'approval-required',
      })
      yield* Effect.promise(() => requestOpened.promise)
      runtimeMock.state.randomUuidBlock = {
        entered: () => nativeBaseStarted.resolve(undefined),
        release: releaseNativeBase.promise,
      }
      yield* adapter.respondToRequest(threadId, ApprovalRequestId.make(request.id), 'accept')
      NodeAssert.equal(eventsFiber.pollUnsafe(), undefined)
      releaseNativeBase.resolve(undefined)

      const resolved = Array.from(yield* Fiber.join(eventsFiber)).filter(
        (event) => event.type === 'request.resolved',
      )
      NodeAssert.equal(resolved.length, 1)
      NodeAssert.equal(resolved[0]?.payload.decision, 'decline')
      yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('classifies the structured OpenCode permission 404 as stale terminal', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      const threadId = asThreadId('thread-permission-not-found')
      const request = permissionRequest('per_permission_not_found', 'http://127.0.0.1:9999/session')
      runtimeMock.state.subscribedEvents = [
        { id: 'evt-permission-not-found', type: 'permission.asked', properties: request },
      ]
      runtimeMock.state.permissionReplyImplementation = async (requestID) =>
      {
        throw {
          _tag: 'PermissionNotFoundError',
          requestID,
          message: 'Permission request was not found.',
        }
      }
      const openedFiber = yield* unwrapOpenCodeRuntimeEvents(adapter).pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === 'request.opened'),
        Stream.runHead,
        Effect.forkChild,
      )
      yield* startOpenCodeTestSession(adapter, {
        provider: ProviderDriverKind.make('opencode'),
        threadId,
        runtimeMode: 'approval-required',
      })
      yield* Fiber.join(openedFiber)

      const response = yield* adapter
        .respondToRequest(threadId, ApprovalRequestId.make(request.id), 'accept')
        .pipe(Effect.result)
      NodeAssert.equal(response._tag, 'Failure')
      if (response._tag === 'Failure' && response.failure._tag === 'ProviderAdapterRequestError')
      {
        NodeAssert.match(response.failure.detail, /Unknown pending permission request/)
      }
      const retry = yield* adapter
        .respondToRequest(threadId, ApprovalRequestId.make(request.id), 'accept')
        .pipe(Effect.result)
      NodeAssert.equal(retry._tag, 'Failure')
      NodeAssert.equal(runtimeMock.state.permissionReplyCalls.length, 1)
      yield* adapter.stopSession(threadId)
    }),
  )
  it.effect('fails startup when the OpenCode event stream does not connect', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      const threadId = asThreadId('thread-opencode-connect-timeout')
      runtimeMock.state.autoConnect = false

      const startFiber = yield* startOpenCodeTestSession(adapter, {
        provider: ProviderDriverKind.make('opencode'),
        threadId,
        runtimeMode: 'full-access',
      }).pipe(Effect.result, Effect.forkChild)
      yield* Effect.yieldNow
      yield* advanceTestClock(10_000)

      const result = yield* Fiber.join(startFiber)
      NodeAssert.equal(result._tag, 'Failure')
      NodeAssert.equal(result.failure._tag, 'ProviderAdapterRequestError')
      NodeAssert.equal(result.failure.method, 'event.subscribe')
      NodeAssert.equal(yield* adapter.hasSession(threadId), false)
      runtimeMock.state.abortImplementation = null
      if (yield* adapter.hasSession(threadId)) yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('stops a connecting session and rejects its waiting send', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      const threadId = asThreadId('thread-opencode-stop-connecting')
      const eventSubscribeObserved = promiseWithResolvers<void>()
      runtimeMock.state.autoConnect = false
      runtimeMock.state.eventSubscribeObserved = () => eventSubscribeObserved.resolve(undefined)

      const startFiber = yield* startOpenCodeTestSession(adapter, {
        provider: ProviderDriverKind.make('opencode'),
        threadId,
        runtimeMode: 'full-access',
      }).pipe(Effect.result, Effect.forkChild)
      yield* Effect.promise(() => eventSubscribeObserved.promise)
      const connecting = (yield* adapter.listSessions()).find(
        (session) => session.threadId === threadId,
      )
      NodeAssert.equal(connecting?.status, 'connecting')

      const sendFiber = yield* adapter
        .sendTurn({
          threadId,
          input: 'Must not be sent',
          modelSelection: createModelSelection(
            ProviderInstanceId.make('opencode'),
            'opencode/kimi-k2.5',
          ),
        })
        .pipe(Effect.exit, Effect.forkChild)
      yield* Effect.yieldNow
      NodeAssert.equal(runtimeMock.state.promptCalls.length, 0)

      yield* adapter.stopSession(threadId)
      const startResult = yield* Fiber.join(startFiber)
      const sendResult = yield* Fiber.join(sendFiber)
      NodeAssert.equal(startResult._tag, 'Failure')
      NodeAssert.equal(sendResult._tag, 'Failure')
      NodeAssert.equal(runtimeMock.state.promptCalls.length, 0)
      NodeAssert.deepEqual(runtimeMock.state.closeCalls, ['http://127.0.0.1:9999'])
      NodeAssert.equal(yield* adapter.hasSession(threadId), false)
      runtimeMock.state.abortImplementation = null
      if (yield* adapter.hasSession(threadId)) yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('reuses a published connecting session after it becomes ready', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      const threadId = asThreadId('thread-opencode-reuse-connecting')
      const connectionEvent = promiseWithResolvers<unknown>()
      const eventSubscribeObserved = promiseWithResolvers<void>()
      runtimeMock.state.autoConnect = false
      runtimeMock.state.eventSubscribeObserved = () => eventSubscribeObserved.resolve(undefined)
      runtimeMock.state.subscribedEvents = [connectionEvent.promise]

      const owningStart = yield* startOpenCodeTestSession(adapter, {
        provider: ProviderDriverKind.make('opencode'),
        threadId,
        runtimeMode: 'full-access',
      }).pipe(Effect.forkChild)
      yield* Effect.promise(() => eventSubscribeObserved.promise)
      const reusedStart = yield* startOpenCodeTestSession(adapter, {
        provider: ProviderDriverKind.make('opencode'),
        threadId,
        runtimeMode: 'full-access',
      }).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      NodeAssert.equal(runtimeMock.state.sessionCreateUrls.length, 1)

      connectionEvent.resolve({
        id: 'evt-reused-start-connected',
        type: 'server.connected',
        properties: {},
      })
      const [ownedSession, reusedSession] = yield* Effect.all([
        Fiber.join(owningStart),
        Fiber.join(reusedStart),
      ])
      NodeAssert.equal(ownedSession.status, 'ready')
      NodeAssert.equal(reusedSession.status, 'ready')
      NodeAssert.deepEqual(ownedSession.resumeCursor, reusedSession.resumeCursor)

      yield* adapter.stopSession(threadId)
      runtimeMock.state.abortImplementation = null
      if (yield* adapter.hasSession(threadId)) yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('waits for steer admission before accepting the only idle event', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      const threadId = asThreadId('thread-steer-admission-only-idle')
      runtimeMock.state.autoPromptEcho = false
      const firstUserMessageEvent = promiseWithResolvers<unknown>()
      const staleIdleEvent = promiseWithResolvers<unknown>()
      const userMessageEvent = promiseWithResolvers<unknown>()
      const idleEvent = promiseWithResolvers<unknown>()
      const steerStarted = promiseWithResolvers<void>()
      const steerRelease = promiseWithResolvers<void>()
      runtimeMock.state.subscribedEvents = [
        firstUserMessageEvent.promise,
        staleIdleEvent.promise,
        userMessageEvent.promise,
        idleEvent.promise,
      ]
      runtimeMock.state.sessionStatusImplementation = async () => ({ data: {} })
      runtimeMock.state.promptAsyncImplementation = async () =>
      {
        if (runtimeMock.state.promptCalls.length === 2)
        {
          steerStarted.resolve(undefined)
          await steerRelease.promise
        }
      }

      const completedFiber = yield* unwrapOpenCodeRuntimeEvents(adapter).pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === 'turn.completed'),
        Stream.runHead,
        Effect.forkChild,
      )
      yield* startOpenCodeTestSession(adapter, {
        provider: ProviderDriverKind.make('opencode'),
        threadId,
        runtimeMode: 'full-access',
      })
      const activeTurn = yield* adapter.sendTurn({
        threadId,
        input: 'Start work',
        modelSelection: createModelSelection(
          ProviderInstanceId.make('opencode'),
          'opencode/kimi-k2.5',
        ),
      })
      const steerFiber = yield* adapter
        .sendTurn({
          threadId,
          input: 'Add another task',
          modelSelection: createModelSelection(
            ProviderInstanceId.make('opencode'),
            'opencode/kimi-k2.5',
          ),
        })
        .pipe(Effect.forkChild)
      yield* Effect.promise(() => steerStarted.promise)
      const firstMessageId = (runtimeMock.state.promptCalls[0] as { messageID?: string }).messageID
      const steerMessageId = (runtimeMock.state.promptCalls[1] as { messageID?: string }).messageID
      NodeAssert.match(firstMessageId ?? '', /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
      NodeAssert.match(steerMessageId ?? '', /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
      firstUserMessageEvent.resolve({
        id: 'evt-delayed-first-user-message',
        type: 'message.updated',
        properties: {
          sessionID: 'http://127.0.0.1:9999/session',
          info: { id: firstMessageId, role: 'user' },
        },
      })
      staleIdleEvent.resolve({
        id: 'evt-stale-idle-during-steer',
        type: 'session.status',
        properties: {
          sessionID: 'http://127.0.0.1:9999/session',
          status: { type: 'idle' },
        },
      })
      userMessageEvent.resolve({
        id: 'evt-steer-user-message',
        type: 'message.updated',
        properties: {
          sessionID: 'http://127.0.0.1:9999/session',
          info: { id: steerMessageId, role: 'user' },
        },
      })
      idleEvent.resolve({
        id: 'evt-only-idle-during-steer',
        type: 'session.status',
        properties: {
          sessionID: 'http://127.0.0.1:9999/session',
          status: { type: 'idle' },
        },
      })
      yield* Effect.yieldNow
      NodeAssert.equal(runtimeMock.state.sessionStatusCalls, 0)
      steerRelease.resolve(undefined)
      yield* Fiber.join(steerFiber)

      const completed = Option.getOrUndefined(
        yield* Fiber.join(completedFiber).pipe(Effect.timeout('1 second')),
      )
      NodeAssert.equal(completed?.turnId, activeTurn.turnId)
      NodeAssert.equal(runtimeMock.state.sessionStatusCalls > 0, true)
      runtimeMock.state.abortImplementation = null
      if (yield* adapter.hasSession(threadId)) yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('ignores a stale admission status response after the next turn starts', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      const threadId = asThreadId('thread-stale-admission-status-after-stop')
      const idleEvent = promiseWithResolvers<unknown>()
      const userMessageEvent = promiseWithResolvers<unknown>()
      const staleStatusStarted = promiseWithResolvers<void>()
      const staleStatusRelease = promiseWithResolvers<void>()
      const staleStatusReturned = promiseWithResolvers<void>()
      const activePromptStarted = promiseWithResolvers<void>()
      const activePromptRelease = promiseWithResolvers<void>()
      runtimeMock.state.autoPromptEcho = false
      runtimeMock.state.subscribedEvents = [idleEvent.promise, userMessageEvent.promise]
      runtimeMock.state.sessionStatusImplementation = async () =>
      {
        if (runtimeMock.state.sessionStatusCalls === 1)
        {
          staleStatusStarted.resolve(undefined)
          await staleStatusRelease.promise
          staleStatusReturned.resolve(undefined)
          return {
            data: { 'http://127.0.0.1:9999/session': { type: 'busy' as const } },
          }
        }
        return { data: {} }
      }
      runtimeMock.state.promptAsyncImplementation = async () =>
      {
        if (runtimeMock.state.promptCalls.length === 2)
        {
          activePromptStarted.resolve(undefined)
          await activePromptRelease.promise
        }
      }

      const completedFiber = yield* unwrapOpenCodeRuntimeEvents(adapter).pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === 'turn.completed'),
        Stream.runHead,
        Effect.forkChild,
      )
      yield* startOpenCodeTestSession(adapter, {
        provider: ProviderDriverKind.make('opencode'),
        threadId,
        runtimeMode: 'full-access',
      })
      const stoppedTurn = yield* adapter.sendTurn({
        threadId,
        input: 'Stop while status is pending',
        modelSelection: createModelSelection(
          ProviderInstanceId.make('opencode'),
          'opencode/kimi-k2.5',
        ),
      })
      yield* Effect.promise(() => staleStatusStarted.promise)
      yield* adapter.interruptTurn(threadId, stoppedTurn.turnId)

      const activeTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: 'Start while the old status is pending',
          modelSelection: createModelSelection(
            ProviderInstanceId.make('opencode'),
            'opencode/kimi-k2.5',
          ),
        })
        .pipe(Effect.forkChild)
      yield* Effect.promise(() => activePromptStarted.promise)
      const activeMessageId = (runtimeMock.state.promptCalls.at(-1) as { messageID: string })
        .messageID

      staleStatusRelease.resolve(undefined)
      yield* Effect.promise(() => staleStatusReturned.promise)
      for (let index = 0; index < 2; index += 1)
      {
        yield* Effect.yieldNow
      }
      idleEvent.resolve({
        id: 'evt-idle-after-stale-admission-status',
        type: 'session.status',
        properties: {
          sessionID: 'http://127.0.0.1:9999/session',
          status: { type: 'idle' },
        },
      })
      for (let index = 0; index < 4; index += 1)
      {
        yield* Effect.yieldNow
      }
      NodeAssert.equal(activeTurnFiber.pollUnsafe(), undefined)
      NodeAssert.equal(completedFiber.pollUnsafe(), undefined)
      const sessionsBeforeAcceptance = yield* adapter.listSessions()
      const sessionBeforeAcceptance = sessionsBeforeAcceptance.find(
        (candidate) => candidate.threadId === threadId,
      )
      NodeAssert.equal(sessionBeforeAcceptance?.status, 'running')
      NodeAssert.notEqual(sessionBeforeAcceptance?.activeTurnId, stoppedTurn.turnId)

      userMessageEvent.resolve({
        id: 'evt-user-after-stale-admission-status',
        type: 'message.updated',
        properties: {
          sessionID: 'http://127.0.0.1:9999/session',
          info: { id: activeMessageId, role: 'user' },
        },
      })
      yield* Effect.yieldNow
      activePromptRelease.resolve(undefined)
      const activeTurn = yield* Fiber.join(activeTurnFiber)
      yield* advanceTestClock(250)

      const completed = Option.getOrUndefined(
        yield* Fiber.join(completedFiber).pipe(Effect.timeout('1 second')),
      )
      NodeAssert.equal(completed?.turnId, activeTurn.turnId)
      const sessions = yield* adapter.listSessions()
      const session = sessions.find((candidate) => candidate.threadId === threadId)
      NodeAssert.equal(session?.status, 'ready')
      NodeAssert.equal(session?.activeTurnId, undefined)

      yield* adapter.stopSession(threadId)
      runtimeMock.state.abortImplementation = null
      if (yield* adapter.hasSession(threadId)) yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('recovers pending requests from existing nested child sessions on resume', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      const threadId = asThreadId('thread-resume-child-requests')
      runtimeMock.state.sessionParentById.set('ses_child', 'ses_parent')
      runtimeMock.state.sessionParentById.set('ses_nested', 'ses_child')
      runtimeMock.state.pendingPermissions = [permissionRequest('per_existing', 'ses_nested')]
      runtimeMock.state.pendingQuestions = [questionRequest('que_existing', 'ses_child')]

      const requestsFiber = yield* unwrapOpenCodeRuntimeEvents(adapter).pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === 'request.opened' || event.type === 'user-input.requested'),
        ),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      )
      yield* startOpenCodeTestSession(adapter, {
        provider: ProviderDriverKind.make('opencode'),
        threadId,
        runtimeMode: 'approval-required',
        resumeCursor: { schemaVersion: 1, sessionId: 'ses_parent' },
      })

      const requests = Array.from(yield* Fiber.join(requestsFiber).pipe(Effect.timeout('1 second')))
      NodeAssert.deepEqual(requests.map((event) => [event.type, event.requestId]).sort(), [
        ['request.opened', 'per_existing'],
        ['user-input.requested', 'que_existing'],
      ])
      yield* adapter.respondToRequest(threadId, ApprovalRequestId.make('per_existing'), 'accept')
      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make('que_existing'), {
        Scope: 'Workspace',
      })
      NodeAssert.deepEqual(runtimeMock.state.permissionReplyCalls, [
        { requestID: 'per_existing', reply: 'once' },
      ])
      NodeAssert.deepEqual(runtimeMock.state.questionReplyCalls, [
        { requestID: 'que_existing', answers: [['Workspace']] },
      ])
      runtimeMock.state.abortImplementation = null
      if (yield* adapter.hasSession(threadId)) yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('retries ancestry for one live child request after a transient failure', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      const threadId = asThreadId('thread-child-request-ancestry-retry')
      const parentId = 'http://127.0.0.1:9999/session'
      const ancestryAttempted = promiseWithResolvers<void>()
      runtimeMock.state.sessionParentById.set('ses_existing_child', parentId)
      runtimeMock.state.transientErrorSessionIds.add('ses_existing_child')
      runtimeMock.state.sessionGetObserved = (sessionID) =>
      {
        if (sessionID === 'ses_existing_child')
        {
          ancestryAttempted.resolve(undefined)
        }
      }
      runtimeMock.state.subscribedEvents = [
        {
          id: 'evt-existing-child-permission',
          type: 'permission.asked',
          properties: permissionRequest('per_retry', 'ses_existing_child'),
        },
      ]

      const eventsFiber = yield* unwrapOpenCodeRuntimeEvents(adapter).pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === 'runtime.warning' || event.type === 'request.opened'),
        ),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      )
      yield* startOpenCodeTestSession(adapter, {
        provider: ProviderDriverKind.make('opencode'),
        threadId,
        runtimeMode: 'approval-required',
      })
      yield* Effect.promise(() => ancestryAttempted.promise)
      runtimeMock.state.transientErrorSessionIds.delete('ses_existing_child')
      yield* advanceTestClock(250)

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout('1 second')))
      NodeAssert.deepEqual(
        events.map((event) => event.type),
        ['runtime.warning', 'request.opened'],
      )
      yield* adapter.respondToRequest(threadId, ApprovalRequestId.make('per_retry'), 'accept')
      runtimeMock.state.abortImplementation = null
      if (yield* adapter.hasSession(threadId)) yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('does not resurrect a recovered child request after its live reply', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      const threadId = asThreadId('thread-stale-child-request-recovery')
      const listStarted = promiseWithResolvers<void>()
      const listRelease = promiseWithResolvers<void>()
      const stale = permissionRequest('per_stale', 'ses_existing_child')
      runtimeMock.state.sessionParentById.set('ses_existing_child', 'ses_parent')
      runtimeMock.state.permissionListImplementation = async () =>
      {
        listStarted.resolve(undefined)
        await listRelease.promise
        return [stale]
      }
      runtimeMock.state.subscribedEvents = [
        {
          id: 'evt-stale-child-replied',
          type: 'permission.replied',
          properties: {
            sessionID: 'ses_existing_child',
            requestID: stale.id,
            reply: 'once',
          },
        },
      ]

      const resolvedFiber = yield* unwrapOpenCodeRuntimeEvents(adapter).pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === 'request.opened' || event.type === 'request.resolved'),
        ),
        Stream.runHead,
        Effect.forkChild,
      )

      yield* startOpenCodeTestSession(adapter, {
        provider: ProviderDriverKind.make('opencode'),
        threadId,
        runtimeMode: 'approval-required',
        resumeCursor: { schemaVersion: 1, sessionId: 'ses_parent' },
      })
      yield* Effect.promise(() => listStarted.promise)
      const resolved = Option.getOrUndefined(
        yield* Fiber.join(resolvedFiber).pipe(Effect.timeout('1 second')),
      )
      NodeAssert.equal(resolved?.type, 'request.resolved')
      listRelease.resolve(undefined)
      yield* Effect.yieldNow

      const response = yield* Effect.exit(
        adapter.respondToRequest(threadId, ApprovalRequestId.make(stale.id), 'accept'),
      )
      NodeAssert.equal(Exit.isFailure(response), true)
      runtimeMock.state.abortImplementation = null
      if (yield* adapter.hasSession(threadId)) yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('rejects a prompt accepted after its turn was interrupted', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      const threadId = asThreadId('thread-interrupt-during-prompt-admission')
      const promptStarted = promiseWithResolvers<void>()
      const promptRelease = promiseWithResolvers<void>()
      const lateBusy = promiseWithResolvers<unknown>()
      const lateMessage = promiseWithResolvers<unknown>()
      const latePart = promiseWithResolvers<unknown>()
      const lateIdle = promiseWithResolvers<unknown>()
      const marker = promiseWithResolvers<unknown>()
      runtimeMock.state.autoPromptEcho = false
      runtimeMock.state.subscribedEvents = [
        lateBusy.promise,
        lateMessage.promise,
        latePart.promise,
        lateIdle.promise,
        marker.promise,
      ]
      runtimeMock.state.promptAsyncImplementation = async () =>
      {
        if (runtimeMock.state.promptCalls.length === 1)
        {
          promptStarted.resolve(undefined)
          await promptRelease.promise
        }
      }

      const firstLateOutput = yield* unwrapOpenCodeRuntimeEvents(adapter).pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === 'content.delta' || event.type === 'thread.metadata.updated'),
        ),
        Stream.runHead,
        Effect.forkChild,
      )
      yield* startOpenCodeTestSession(adapter, {
        provider: ProviderDriverKind.make('opencode'),
        threadId,
        runtimeMode: 'full-access',
      })
      const sendFiber = yield* adapter
        .sendTurn({
          threadId,
          input: 'This request is still pending',
          modelSelection: createModelSelection(
            ProviderInstanceId.make('opencode'),
            'opencode/kimi-k2.5',
          ),
        })
        .pipe(Effect.exit, Effect.forkChild)
      yield* Effect.promise(() => promptStarted.promise)

      yield* adapter.interruptTurn(threadId)
      NodeAssert.equal(runtimeMock.state.abortCalls.length, 1)
      const sessionsAfterStop = yield* adapter.listSessions()
      const sessionAfterStop = sessionsAfterStop.find(
        (candidate) => candidate.threadId === threadId,
      )
      NodeAssert.equal(sessionAfterStop?.status, 'ready')
      NodeAssert.equal(sessionAfterStop?.activeTurnId, undefined)

      promptRelease.resolve(undefined)
      const sendResult = yield* Fiber.join(sendFiber)
      lateBusy.resolve({
        id: 'evt-busy-after-late-prompt-acceptance',
        type: 'session.status',
        properties: {
          sessionID: 'http://127.0.0.1:9999/session',
          status: { type: 'busy' },
        },
      })
      lateMessage.resolve({
        id: 'evt-assistant-after-late-prompt-acceptance',
        type: 'message.updated',
        properties: {
          sessionID: 'http://127.0.0.1:9999/session',
          info: { id: 'msg-late-assistant', role: 'assistant' },
        },
      })
      latePart.resolve({
        id: 'evt-part-after-late-prompt-acceptance',
        type: 'message.part.updated',
        properties: {
          sessionID: 'http://127.0.0.1:9999/session',
          part: {
            id: 'part-late-assistant',
            sessionID: 'http://127.0.0.1:9999/session',
            messageID: 'msg-late-assistant',
            type: 'text',
            text: 'Late output',
            time: { start: 1 },
          },
          time: 1,
        },
      })
      lateIdle.resolve({
        id: 'evt-idle-after-late-prompt-acceptance',
        type: 'session.status',
        properties: {
          sessionID: 'http://127.0.0.1:9999/session',
          status: { type: 'idle' },
        },
      })
      marker.resolve({
        id: 'evt-marker-after-late-prompt-acceptance',
        type: 'session.updated',
        properties: {
          info: {
            id: 'http://127.0.0.1:9999/session',
            title: 'Late prompt cleaned up',
          },
        },
      })

      const firstOutput = Option.getOrUndefined(
        yield* Fiber.join(firstLateOutput).pipe(Effect.timeout('1 second')),
      )
      NodeAssert.equal(firstOutput?.type, 'thread.metadata.updated')
      NodeAssert.equal(Exit.isFailure(sendResult), true)
      if (Exit.isFailure(sendResult))
      {
        NodeAssert.equal(Cause.hasInterruptsOnly(sendResult.cause), true)
      }

      yield* adapter.sendTurn({
        threadId,
        input: 'Start after late cleanup',
        modelSelection: createModelSelection(
          ProviderInstanceId.make('opencode'),
          'opencode/kimi-k2.5',
        ),
      })
      yield* Effect.yieldNow
      NodeAssert.equal(runtimeMock.state.abortCalls.length, 1)
      const sessionsAfterNextTurn = yield* adapter.listSessions()
      const sessionAfterNextTurn = sessionsAfterNextTurn.find(
        (candidate) => candidate.threadId === threadId,
      )
      NodeAssert.equal(sessionAfterNextTurn?.status, 'running')

      yield* adapter.stopSession(threadId)
      runtimeMock.state.abortImplementation = null
      if (yield* adapter.hasSession(threadId)) yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('treats MessageAbortedError as the acknowledgment for a pending user stop', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      const threadId = asThreadId('thread-interrupt-error-race')
      const abortedEvent = promiseWithResolvers<unknown>()
      const abortStarted = promiseWithResolvers<void>()
      const abortRelease = promiseWithResolvers<void>()
      runtimeMock.state.subscribedEvents = [abortedEvent.promise]
      runtimeMock.state.abortImplementation = async () =>
      {
        abortStarted.resolve(undefined)
        await abortRelease.promise
      }

      const eventsFiber = yield* unwrapOpenCodeRuntimeEvents(adapter).pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(4),
        Stream.runCollect,
        Effect.forkChild,
      )
      yield* startOpenCodeTestSession(adapter, {
        provider: ProviderDriverKind.make('opencode'),
        threadId,
        runtimeMode: 'full-access',
      })
      const turn = yield* adapter.sendTurn({
        threadId,
        input: 'Keep working',
        modelSelection: createModelSelection(
          ProviderInstanceId.make('opencode'),
          'opencode/kimi-k2.5',
        ),
      })

      const interruptFiber = yield* adapter
        .interruptTurn(threadId, turn.turnId)
        .pipe(Effect.forkChild)
      yield* Effect.promise(() => abortStarted.promise)
      abortedEvent.resolve({
        id: 'evt-aborted-after-stop',
        type: 'session.error',
        properties: {
          sessionID: 'http://127.0.0.1:9999/session',
          error: { name: 'MessageAbortedError', data: { message: 'Aborted' } },
        },
      })
      yield* Effect.yieldNow
      abortRelease.resolve(undefined)
      yield* Fiber.join(interruptFiber)

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout('1 second')))
      NodeAssert.deepEqual(
        events
          .filter(
            (event) =>
              event.type === 'turn.completed' ||
              event.type === 'turn.aborted' ||
              event.type === 'runtime.error',
          )
          .map((event) => event.type),
        ['turn.aborted'],
      )

      yield* adapter.stopSession(threadId)
      runtimeMock.state.abortImplementation = null
      if (yield* adapter.hasSession(threadId)) yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('closes live requests before an accepted stop and ignores late asks', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      const threadId = asThreadId('thread-stop-requests')
      const sessionID = 'http://127.0.0.1:9999/session'
      const firstAsk = promiseWithResolvers<OpenCodeEvent>()
      const lateAsk = promiseWithResolvers<OpenCodeEvent>()
      const requestsOpened = promiseWithResolvers<void>()
      let openedCount = 0
      runtimeMock.state.subscribedEvents = [
        firstAsk.promise,
        {
          id: 'evt-question',
          type: 'question.asked',
          properties: questionRequest('que_stop', sessionID),
        },
        lateAsk.promise,
        {
          id: 'evt-late-question',
          type: 'question.asked',
          properties: questionRequest('que_late', sessionID),
        },
        {
          id: 'evt-drained',
          type: 'session.updated',
          properties: { sessionID, info: { id: sessionID, title: 'Late request marker' } },
        },
      ]
      const eventsFiber = yield* unwrapOpenCodeRuntimeEvents(adapter).pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.tap((event) =>
          Effect.sync(() =>
          {
            if (event.type === 'request.opened' || event.type === 'user-input.requested')
            {
              openedCount += 1
              if (openedCount === 2) requestsOpened.resolve(undefined)
            }
          }),
        ),
        Stream.takeUntil((event) => event.type === 'thread.metadata.updated'),
        Stream.runCollect,
        Effect.forkChild,
      )
      yield* startOpenCodeTestSession(adapter, {
        provider: ProviderDriverKind.make('opencode'),
        threadId,
        runtimeMode: 'approval-required',
      })
      const turn = yield* adapter.sendTurn({
        threadId,
        input: 'Work',
        modelSelection: createModelSelection(
          ProviderInstanceId.make('opencode'),
          'opencode/kimi-k2.5',
        ),
      })
      firstAsk.resolve({
        id: 'evt-permission',
        type: 'permission.asked',
        properties: permissionRequest('per_stop', sessionID),
      })
      yield* Effect.promise(() => requestsOpened.promise)
      yield* adapter.interruptTurn(threadId, turn.turnId)
      lateAsk.resolve({
        id: 'evt-late-permission',
        type: 'permission.asked',
        properties: permissionRequest('per_late', sessionID),
      })
      const events = Array.from(yield* Fiber.join(eventsFiber))
      const lifecycle = events
        .filter(
          (event) =>
            event.type === 'request.opened' ||
            event.type === 'user-input.requested' ||
            event.type === 'request.resolved' ||
            event.type === 'user-input.resolved' ||
            event.type === 'turn.aborted' ||
            event.type === 'thread.metadata.updated',
        )
        .map((event) => event.type)
      NodeAssert.deepEqual(lifecycle.slice(0, 2), ['request.opened', 'user-input.requested'])
      NodeAssert.deepEqual(
        new Set(lifecycle.slice(2, 4)),
        new Set(['request.resolved', 'user-input.resolved']),
      )
      NodeAssert.deepEqual(lifecycle.slice(4), ['turn.aborted', 'thread.metadata.updated'])
      yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('does not claim a turn stopped when the abort request fails', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      const threadId = asThreadId('thread-interrupt-request-failure')
      runtimeMock.state.abortImplementation = async () =>
      {
        throw new Error('abort failed')
      }

      yield* startOpenCodeTestSession(adapter, {
        provider: ProviderDriverKind.make('opencode'),
        threadId,
        runtimeMode: 'full-access',
      })
      const turn = yield* adapter.sendTurn({
        threadId,
        input: 'Keep working',
        modelSelection: createModelSelection(
          ProviderInstanceId.make('opencode'),
          'opencode/kimi-k2.5',
        ),
      })

      const exit = yield* Effect.exit(adapter.interruptTurn(threadId, turn.turnId))
      NodeAssert.equal(Exit.isFailure(exit), true)
      const sessions = yield* adapter.listSessions()
      const session = sessions.find((candidate) => candidate.threadId === threadId)
      NodeAssert.equal(session?.status, 'running')
      NodeAssert.equal(session?.activeTurnId, turn.turnId)
      runtimeMock.state.abortImplementation = null
      if (yield* adapter.hasSession(threadId)) yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('reconciles deferred idle after child cleanup fails', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      const threadId = asThreadId('thread-child-abort-idle')
      const sessionID = 'http://127.0.0.1:9999/session'
      const idle = promiseWithResolvers<OpenCodeEvent>()
      const childAbortStarted = promiseWithResolvers<void>()
      const childAbortRelease = promiseWithResolvers<void>()
      const markerObserved = promiseWithResolvers<void>()
      runtimeMock.state.sessionChildrenById.set(sessionID, [{ id: 'ses_failing_child' }])
      runtimeMock.state.abortImplementation = async (abortedSessionID) =>
      {
        if (abortedSessionID === 'ses_failing_child')
        {
          childAbortStarted.resolve(undefined)
          await childAbortRelease.promise
          throw new Error('child abort failed')
        }
      }
      runtimeMock.state.subscribedEvents = [
        idle.promise,
        {
          id: 'evt-idle-observed',
          type: 'session.updated',
          properties: { sessionID, info: { id: sessionID, title: 'Idle observed' } },
        },
      ]
      const eventsFiber = yield* unwrapOpenCodeRuntimeEvents(adapter).pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.tap((event) =>
          event.type === 'thread.metadata.updated'
            ? Effect.sync(() => markerObserved.resolve(undefined))
            : Effect.void,
        ),
        Stream.takeUntil((event) => event.type === 'turn.completed'),
        Stream.runCollect,
        Effect.forkChild,
      )
      yield* startOpenCodeTestSession(adapter, {
        provider: ProviderDriverKind.make('opencode'),
        threadId,
        runtimeMode: 'full-access',
      })
      const turn = yield* adapter.sendTurn({
        threadId,
        input: 'Run a child agent',
        modelSelection: createModelSelection(
          ProviderInstanceId.make('opencode'),
          'opencode/kimi-k2.5',
        ),
      })

      const interruptFiber = yield* adapter
        .interruptTurn(threadId, turn.turnId)
        .pipe(Effect.result, Effect.forkChild)
      yield* Effect.promise(() => childAbortStarted.promise)
      idle.resolve({
        id: 'evt-idle-during-child-abort',
        type: 'session.status',
        properties: { sessionID, status: { type: 'idle' } },
      })
      yield* Effect.promise(() => markerObserved.promise)
      childAbortRelease.resolve(undefined)

      const result = yield* Fiber.join(interruptFiber)
      NodeAssert.equal(result._tag, 'Failure')
      if (result._tag === 'Failure' && result.failure._tag === 'ProviderAdapterRequestError')
      {
        NodeAssert.equal(result.failure.detail, 'child abort failed')
      }
      const completed = Array.from(yield* Fiber.join(eventsFiber)).find(
        (event) => event.type === 'turn.completed',
      )
      NodeAssert.ok(completed)
      NodeAssert.equal(completed.turnId, turn.turnId)
      const session = (yield* adapter.listSessions()).find((entry) => entry.threadId === threadId)
      NodeAssert.equal(session?.status, 'ready')
      NodeAssert.equal(session?.activeTurnId, undefined)

      runtimeMock.state.abortImplementation = null
      runtimeMock.state.sessionChildrenById.clear()
      yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('shares one abort request across concurrent stops', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      const threadId = asThreadId('thread-concurrent-interrupt')
      const abortStarted = promiseWithResolvers<void>()
      const abortRelease = promiseWithResolvers<void>()
      runtimeMock.state.abortImplementation = async () =>
      {
        abortStarted.resolve(undefined)
        await abortRelease.promise
      }

      const eventsFiber = yield* unwrapOpenCodeRuntimeEvents(adapter).pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(4),
        Stream.runCollect,
        Effect.forkChild,
      )
      yield* startOpenCodeTestSession(adapter, {
        provider: ProviderDriverKind.make('opencode'),
        threadId,
        runtimeMode: 'full-access',
      })
      const turn = yield* adapter.sendTurn({
        threadId,
        input: 'Keep working',
        modelSelection: createModelSelection(
          ProviderInstanceId.make('opencode'),
          'opencode/kimi-k2.5',
        ),
      })

      const firstInterrupt = yield* adapter
        .interruptTurn(threadId, turn.turnId)
        .pipe(Effect.forkChild)
      const secondInterrupt = yield* adapter
        .interruptTurn(threadId, turn.turnId)
        .pipe(Effect.forkChild)
      yield* Effect.promise(() => abortStarted.promise)
      yield* Effect.yieldNow
      NodeAssert.equal(runtimeMock.state.abortCalls.length, 1)

      abortRelease.resolve(undefined)
      yield* Fiber.join(firstInterrupt)
      yield* Fiber.join(secondInterrupt)

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout('1 second')))
      NodeAssert.deepEqual(
        events
          .filter((event) => event.type === 'turn.completed' || event.type === 'turn.aborted')
          .map((event) => event.type),
        ['turn.aborted'],
      )

      yield* adapter.stopSession(threadId)
      runtimeMock.state.abortImplementation = null
      if (yield* adapter.hasSession(threadId)) yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('passes the scoped MCP endpoint and bearer header to OpenCode', () =>
    Effect.gen(function* ()
    {
      const threadId = asThreadId('thread-opencode-mcp')
      const adapter = yield* makeOpenCodeAdapter(openCodeMcpAdapterTestSettings)

      yield* startOpenCodeTestSession(adapter, {
        threadId,
        provider: ProviderDriverKind.make('opencode'),
        runtimeMode: 'full-access',
        mcp: makeTestMcpProviderSession(threadId, ProviderInstanceId.make('opencode')),
      })

      NodeAssert.deepStrictEqual(runtimeMock.state.mcpAddCalls, [
        {
          name: 'code456',
          config: {
            type: 'remote',
            url: TEST_MCP_ENDPOINT,
            headers: { Authorization: TEST_MCP_AUTHORIZATION },
            oauth: false,
          },
        },
      ])
      yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('classifies MCP patch tools before native file-change names', () =>
    Effect.sync(() =>
    {
      NodeAssert.equal(
        toToolLifecycleItemType('code456_architecture_propose_patch'),
        'mcp_tool_call',
      )
    }),
  )

  it.effect(
    'reuses a configured OpenCode server URL and returns a durable resume cursor for a fresh session',
    () =>
      Effect.gen(function* ()
      {
        const adapter = yield* OpenCodeAdapter
        const threadId = asThreadId('thread-opencode-cursor')

        const session = yield* startOpenCodeTestSession(adapter, {
          provider: ProviderDriverKind.make('opencode'),
          threadId,
          runtimeMode: 'full-access',
        })

        NodeAssert.equal(session.provider, 'opencode')
        NodeAssert.equal(session.threadId, 'thread-opencode-cursor')
        NodeAssert.deepEqual(runtimeMock.state.startCalls, [])
        NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, ['http://127.0.0.1:9999'])
        NodeAssert.deepEqual(runtimeMock.state.authHeaders, [
          `Basic ${btoa('opencode:secret-password')}`,
        ])
        NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, [])
        NodeAssert.deepEqual(session.resumeCursor, {
          schemaVersion: 1,
          sessionId: 'http://127.0.0.1:9999/session',
        })

        yield* adapter.stopSession(threadId)
      }),
  )

  it.effect('resumes the persisted OpenCode session instead of creating a new one', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      const threadId = asThreadId('thread-opencode-resume')

      const session = yield* startOpenCodeTestSession(adapter, {
        provider: ProviderDriverKind.make('opencode'),
        threadId,
        runtimeMode: 'full-access',
        resumeCursor: { schemaVersion: 1, sessionId: 'ses_persisted' },
      })

      // the adapter validates the persisted id with session.get and re-adopts
      // it — no new session is minted (issue #3604).
      NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, ['ses_persisted'])
      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, [])
      NodeAssert.deepEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: 'ses_persisted',
      })
      // resume re-asserts the permission ruleset for the current runtimeMode.
      NodeAssert.equal(runtimeMock.state.sessionUpdateCalls.length, 1)
      NodeAssert.equal(runtimeMock.state.sessionUpdateCalls[0]?.sessionID, 'ses_persisted')
      NodeAssert.equal(runtimeMock.state.sessionUpdateCalls[0]?.permission != null, true)

      yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('sends follow-up turns to the resumed session id', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      const threadId = asThreadId('thread-opencode-resume-turn')

      yield* startOpenCodeTestSession(adapter, {
        provider: ProviderDriverKind.make('opencode'),
        threadId,
        runtimeMode: 'full-access',
        resumeCursor: { schemaVersion: 1, sessionId: 'ses_persisted' },
      })

      const result = yield* adapter.sendTurn({
        threadId,
        input: 'continue where we left off',
        modelSelection: createModelSelection(
          ProviderInstanceId.make('opencode'),
          'anthropic/sonnet',
        ),
      })

      // the prompt targets the resumed id, and the turn re-surfaces the cursor.
      NodeAssert.deepEqual(
        (runtimeMock.state.promptCalls[0] as { sessionID: string }).sessionID,
        'ses_persisted',
      )
      NodeAssert.deepEqual(result.resumeCursor, {
        schemaVersion: 1,
        sessionId: 'ses_persisted',
      })

      yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('falls back to a fresh session when the persisted session is gone', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      const threadId = asThreadId('thread-opencode-stale')
      runtimeMock.state.missingSessionIds.add('ses_stale')

      const session = yield* startOpenCodeTestSession(adapter, {
        provider: ProviderDriverKind.make('opencode'),
        threadId,
        runtimeMode: 'full-access',
        resumeCursor: { schemaVersion: 1, sessionId: 'ses_stale' },
      })

      // get probed the stale id, found nothing, then created a new session and
      // emitted a fresh cursor rather than wedging the thread.
      NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, ['ses_stale'])
      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, ['http://127.0.0.1:9999'])
      NodeAssert.deepEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: 'http://127.0.0.1:9999/session',
      })

      yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('refuses to replace a required imported session when native history is gone', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      const threadId = asThreadId('thread-opencode-import-missing')
      runtimeMock.state.missingSessionIds.add('ses_imported')

      const result = yield* startOpenCodeTestSession(adapter, {
        provider: ProviderDriverKind.make('opencode'),
        threadId,
        runtimeMode: 'approval-required',
        resumeCursor: {
          schemaVersion: 1,
          sessionId: 'ses_imported',
          requireExisting: true,
        },
      }).pipe(Effect.result)

      NodeAssert.equal(result._tag, 'Failure')
      NodeAssert.equal(result.failure._tag, 'ProviderAdapterProcessError')
      NodeAssert.equal(
        result.failure.detail,
        "OpenCode native history 'ses_imported' could not be resumed because that session no longer exists.",
      )
      NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, ['ses_imported'])
      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, [])
    }),
  )

  it.effect('rejects a malformed required-history cursor without starting fresh', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      const result = yield* startOpenCodeTestSession(adapter, {
        provider: ProviderDriverKind.make('opencode'),
        threadId: asThreadId('thread-opencode-import-invalid'),
        runtimeMode: 'approval-required',
        resumeCursor: {
          schemaVersion: 99,
          sessionId: 'ses_imported',
          requireExisting: true,
        },
      }).pipe(Effect.result)

      NodeAssert.equal(result._tag, 'Failure')
      NodeAssert.equal(result.failure._tag, 'ProviderAdapterValidationError')
      NodeAssert.equal(
        result.failure.issue,
        'An imported OpenCode session requires a valid existing native session id.',
      )
      NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, [])
      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, [])
    }),
  )

  it.effect('rejects an invalid strict marker without stopping the active OpenCode session', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      const threadId = asThreadId('thread-opencode-import-invalid-marker-active')
      const active = yield* startOpenCodeTestSession(adapter, {
        provider: ProviderDriverKind.make('opencode'),
        threadId,
        runtimeMode: 'approval-required',
      })

      const result = yield* startOpenCodeTestSession(adapter, {
        provider: ProviderDriverKind.make('opencode'),
        threadId,
        runtimeMode: 'approval-required',
        resumeCursor: {
          schemaVersion: 1,
          sessionId: 'ses_imported',
          requireExisting: 'true',
        },
      }).pipe(Effect.result)

      NodeAssert.equal(result._tag, 'Failure')
      NodeAssert.equal(result.failure._tag, 'ProviderAdapterValidationError')
      NodeAssert.equal(yield* adapter.hasSession(threadId), true)
      NodeAssert.deepEqual(
        (yield* adapter.listSessions()).find((entry) => entry.threadId === threadId)?.resumeCursor,
        active.resumeCursor,
      )
      NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, [])
      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, ['http://127.0.0.1:9999'])

      yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('preserves the required-history marker after a successful imported resume', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      const threadId = asThreadId('thread-opencode-import-resume')

      const session = yield* startOpenCodeTestSession(adapter, {
        provider: ProviderDriverKind.make('opencode'),
        threadId,
        runtimeMode: 'approval-required',
        resumeCursor: {
          schemaVersion: 1,
          sessionId: 'ses_imported',
          requireExisting: true,
        },
      })

      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, [])
      NodeAssert.deepEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: 'ses_imported',
        requireExisting: true,
      })
      const turn = yield* adapter.sendTurn({
        threadId,
        input: 'continue the imported session',
        attachments: [],
        modelSelection: createModelSelection(ProviderInstanceId.make('opencode'), 'openai/gpt-5.2'),
      })
      NodeAssert.deepEqual(turn.resumeCursor, {
        schemaVersion: 1,
        sessionId: 'ses_imported',
        requireExisting: true,
      })

      yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('rejects empty or mismatched successful strict resume payloads without creating', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      const cases = [
        {
          sessionId: 'ses_empty_payload',
          payload: undefined,
          detail: "OpenCode session.get returned no session payload for 'ses_empty_payload'.",
        },
        {
          sessionId: 'ses_mismatched_payload',
          payload: { id: 'ses_other_history' },
          detail:
            "OpenCode session.get returned session 'ses_other_history' while resuming 'ses_mismatched_payload'.",
        },
      ] as const

      for (const testCase of cases)
      {
        runtimeMock.state.sessionGetPayloadById.set(testCase.sessionId, testCase.payload)
        const result = yield* startOpenCodeTestSession(adapter, {
          provider: ProviderDriverKind.make('opencode'),
          threadId: asThreadId(`thread-${testCase.sessionId}`),
          runtimeMode: 'approval-required',
          resumeCursor: {
            schemaVersion: 1,
            sessionId: testCase.sessionId,
            requireExisting: true,
          },
        }).pipe(Effect.result)

        NodeAssert.equal(result._tag, 'Failure')
        NodeAssert.equal(result.failure._tag, 'ProviderAdapterProcessError')
        NodeAssert.equal(result.failure.detail, testCase.detail)
      }

      NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, [
        'ses_empty_payload',
        'ses_mismatched_payload',
      ])
      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, [])
    }),
  )

  it.effect('serializes concurrent starts so a fresh session cannot satisfy strict lineage', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      const threadId = asThreadId('thread-opencode-concurrent-lineage')
      let markGetEntered: (() => void) | undefined
      const getEntered = new Promise<void>((resolve) =>
      {
        markGetEntered = resolve
      })
      let releaseGet: (() => void) | undefined
      const getRelease = new Promise<void>((resolve) =>
      {
        releaseGet = resolve
      })
      runtimeMock.state.sessionGetBlock = {
        sessionId: 'ses_strict_lineage',
        entered: () => markGetEntered?.(),
        release: getRelease,
      }

      const strictStart = yield* startOpenCodeTestSession(adapter, {
        provider: ProviderDriverKind.make('opencode'),
        threadId,
        runtimeMode: 'approval-required',
        resumeCursor: {
          schemaVersion: 1,
          sessionId: 'ses_strict_lineage',
          requireExisting: true,
        },
      }).pipe(Effect.forkChild)
      yield* Effect.promise(() => getEntered)

      const freshStart = yield* startOpenCodeTestSession(adapter, {
        provider: ProviderDriverKind.make('opencode'),
        threadId,
        runtimeMode: 'full-access',
      }).pipe(Effect.result, Effect.forkChild)
      yield* Effect.forEach([0, 1, 2, 3, 4], () => Effect.yieldNow)

      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, [])
      releaseGet?.()

      const strictSession = yield* Fiber.join(strictStart)
      const freshResult = yield* Fiber.join(freshStart)
      NodeAssert.deepEqual(strictSession.resumeCursor, {
        schemaVersion: 1,
        sessionId: 'ses_strict_lineage',
        requireExisting: true,
      })
      NodeAssert.equal(freshResult._tag, 'Failure')
      NodeAssert.equal(freshResult.failure._tag, 'ProviderAdapterValidationError')
      NodeAssert.equal(
        freshResult.failure.issue,
        'An active imported OpenCode session must be stopped before starting a fresh native session.',
      )
      NodeAssert.deepEqual(
        (yield* adapter.listSessions()).find((entry) => entry.threadId === threadId)?.resumeCursor,
        {
          schemaVersion: 1,
          sessionId: 'ses_strict_lineage',
          requireExisting: true,
        },
      )
      NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, ['ses_strict_lineage'])
      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, [])

      yield* adapter.stopSession(threadId)

      const freshSession = yield* startOpenCodeTestSession(adapter, {
        provider: ProviderDriverKind.make('opencode'),
        threadId,
        runtimeMode: 'full-access',
      })
      NodeAssert.deepEqual(freshSession.resumeCursor, {
        schemaVersion: 1,
        sessionId: 'http://127.0.0.1:9999/session',
      })
      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, ['http://127.0.0.1:9999'])

      yield* adapter.stopSession(threadId)
    }),
  )

  it.effect(
    'interrupts a strict native resume before publication without leaking a late context',
    () =>
      Effect.gen(function* ()
      {
        const adapter = yield* OpenCodeAdapter
        const threadId = asThreadId('thread-opencode-concurrent-stop')
        let markGetEntered: (() => void) | undefined
        const getEntered = new Promise<void>((resolve) =>
        {
          markGetEntered = resolve
        })
        let releaseGet: (() => void) | undefined
        const getRelease = new Promise<void>((resolve) =>
        {
          releaseGet = resolve
        })
        runtimeMock.state.sessionGetBlock = {
          sessionId: 'ses_strict_stop',
          entered: () => markGetEntered?.(),
          release: getRelease,
        }

        const strictStart = yield* startOpenCodeTestSession(adapter, {
          provider: ProviderDriverKind.make('opencode'),
          threadId,
          runtimeMode: 'approval-required',
          resumeCursor: {
            schemaVersion: 1,
            sessionId: 'ses_strict_stop',
            requireExisting: true,
          },
        }).pipe(Effect.exit, Effect.forkChild)
        yield* Effect.promise(() => getEntered)

        const stopResult = yield* adapter
          .stopSession(threadId)
          .pipe(Effect.result, Effect.forkChild)
        yield* Effect.forEach([0, 1, 2, 3, 4], () => Effect.yieldNow)
        NodeAssert.equal((yield* Fiber.join(stopResult))._tag, 'Success')
        NodeAssert.equal(runtimeMock.state.sessionGetSignals[0]?.aborted, true)
        NodeAssert.equal(Exit.isFailure(yield* Fiber.join(strictStart)), true)
        NodeAssert.deepEqual(runtimeMock.state.closeCalls, ['http://127.0.0.1:9999'])
        releaseGet?.()
        yield* Effect.yieldNow
        NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, [])
        NodeAssert.equal(yield* adapter.hasSession(threadId), false)
      }),
  )

  it.effect('ignores a malformed or wrong-version resume cursor', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      const threadId = asThreadId('thread-opencode-badcursor')

      const session = yield* startOpenCodeTestSession(adapter, {
        provider: ProviderDriverKind.make('opencode'),
        threadId,
        runtimeMode: 'full-access',
        resumeCursor: { schemaVersion: 99, sessionId: 'ses_persisted' },
      })

      // a foreign/stale-shaped cursor is treated as "no resume": never probed,
      // a fresh session is created.
      NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, [])
      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, ['http://127.0.0.1:9999'])
      NodeAssert.deepEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: 'http://127.0.0.1:9999/session',
      })

      yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('surfaces a non-not-found resume probe error instead of silently starting fresh', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      const threadId = asThreadId('thread-opencode-transient')
      // session.get returns a 500 (not a 404) for this id.
      runtimeMock.state.transientErrorSessionIds.add('ses_transient')

      const exit = yield* Effect.exit(
        startOpenCodeTestSession(adapter, {
          provider: ProviderDriverKind.make('opencode'),
          threadId,
          runtimeMode: 'full-access',
          resumeCursor: { schemaVersion: 1, sessionId: 'ses_transient' },
        }),
      )

      // a transient/transport/auth failure must propagate — NOT be masked as a
      // brand-new empty session (the #3604 class of silent context loss).
      NodeAssert.equal(Exit.isFailure(exit), true)
      NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, ['ses_transient'])
      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, [])
    }),
  )

  it.effect(
    'forks the resumed session into the requested directory instead of losing context',
    () =>
      Effect.gen(function* ()
      {
        const adapter = yield* OpenCodeAdapter
        const threadId = asThreadId('thread-opencode-cwd')
        // the persisted session still exists but was created in another working dir
        // (e.g. the thread moved from the project root into a git worktree).
        runtimeMock.state.sessionDirectoryById.set('ses_otherdir', '/some/other/worktree')

        const session = yield* startOpenCodeTestSession(adapter, {
          provider: ProviderDriverKind.make('opencode'),
          threadId,
          runtimeMode: 'full-access',
          resumeCursor: {
            schemaVersion: 1,
            sessionId: 'ses_otherdir',
            requireExisting: true,
          },
        })

        // a cwd change must not mint an empty session: the adapter forks the
        // persisted session into the requested cwd, carrying history forward.
        NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, ['ses_otherdir'])
        NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, [])
        NodeAssert.equal(runtimeMock.state.forkCalls.length, 1)
        NodeAssert.equal(runtimeMock.state.forkCalls[0]?.sessionID, 'ses_otherdir')
        NodeAssert.equal(typeof runtimeMock.state.forkCalls[0]?.directory, 'string')
        // permission ruleset re-asserted on the fork for the current runtimeMode.
        NodeAssert.equal(runtimeMock.state.sessionUpdateCalls.length, 1)
        NodeAssert.equal(runtimeMock.state.sessionUpdateCalls[0]?.sessionID, 'ses_otherdir_fork')
        // durable cursor now points at the history-complete fork in the new directory.
        NodeAssert.deepEqual(session.resumeCursor, {
          schemaVersion: 1,
          sessionId: 'ses_otherdir_fork',
          requireExisting: true,
        })

        yield* adapter.stopSession(threadId)
      }),
  )

  it.effect('reuses the resumed session when the stored directory differs only lexically', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      const threadId = asThreadId('thread-opencode-samedir')
      // same working tree, different spelling (trailing slash) — must reuse,
      // not fork.
      runtimeMock.state.sessionDirectoryById.set('ses_samedir', `${process.cwd()}/`)

      const session = yield* startOpenCodeTestSession(adapter, {
        provider: ProviderDriverKind.make('opencode'),
        threadId,
        runtimeMode: 'full-access',
        resumeCursor: { schemaVersion: 1, sessionId: 'ses_samedir' },
      })

      NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, ['ses_samedir'])
      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, [])
      NodeAssert.deepEqual(runtimeMock.state.forkCalls, [])
      NodeAssert.deepEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: 'ses_samedir',
      })

      yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('fails sendTurn for missing sessions through the typed error channel', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      const result = yield* adapter
        .sendTurn({
          threadId: asThreadId('thread-opencode-missing-send'),
          input: 'hello',
          attachments: [],
        })
        .pipe(Effect.result)

      NodeAssert.equal(result._tag, 'Failure')
      NodeAssert.equal(result.failure._tag, 'ProviderAdapterSessionNotFoundError')
      NodeAssert.equal(result.failure.provider, 'opencode')
      NodeAssert.equal(result.failure.threadId, 'thread-opencode-missing-send')
    }),
  )

  it.effect('fails stopSession for missing sessions through the typed error channel', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      const result = yield* adapter
        .stopSession(asThreadId('thread-opencode-missing-stop'))
        .pipe(Effect.result)

      NodeAssert.equal(result._tag, 'Failure')
      NodeAssert.equal(result.failure._tag, 'ProviderAdapterSessionNotFoundError')
      NodeAssert.equal(result.failure.provider, 'opencode')
      NodeAssert.equal(result.failure.threadId, 'thread-opencode-missing-stop')
    }),
  )

  it.effect('stops a configured-server session without trying to own server lifecycle', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      yield* startOpenCodeTestSession(adapter, {
        provider: ProviderDriverKind.make('opencode'),
        threadId: asThreadId('thread-opencode'),
        runtimeMode: 'full-access',
      })

      yield* adapter.stopSession(asThreadId('thread-opencode'))

      NodeAssert.deepEqual(runtimeMock.state.startCalls, [])
      NodeAssert.deepEqual(
        runtimeMock.state.abortCalls.includes('http://127.0.0.1:9999/session'),
        true,
      )
    }),
  )

  it.effect('emits one session.exited event when stopping a session', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      const threadId = asThreadId('thread-opencode-stop-event')
      const eventsFiber = yield* unwrapOpenCodeRuntimeEvents(adapter).pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      )

      yield* startOpenCodeTestSession(adapter, {
        provider: ProviderDriverKind.make('opencode'),
        threadId,
        runtimeMode: 'full-access',
      })
      yield* adapter.stopSession(threadId)

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout('1 second')))
      NodeAssert.deepEqual(
        events.map((event) => event.type),
        ['session.started', 'thread.started', 'session.exited'],
      )
    }),
  )

  it.effect('clears session state even when cleanup finalizers throw', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      yield* startOpenCodeTestSession(adapter, {
        provider: ProviderDriverKind.make('opencode'),
        threadId: asThreadId('thread-stop-all-a'),
        runtimeMode: 'full-access',
      })
      yield* startOpenCodeTestSession(adapter, {
        provider: ProviderDriverKind.make('opencode'),
        threadId: asThreadId('thread-stop-all-b'),
        runtimeMode: 'full-access',
      })

      runtimeMock.state.closeError = new Error('close failed')
      // `stopAll` relies on `stopOpenCodeContext`, which is typed as
      // never-failing. A throwing finalizer surfaces as a defect — `Effect.exit`
      // captures it so the assertions can still run. The key invariant we're
      // validating is "the sessions map and close-call probes reflect cleanup
      // attempts regardless of finalizer outcome".
      yield* Effect.exit(adapter.stopAll())
      const sessions = yield* adapter.listSessions()

      NodeAssert.deepEqual(runtimeMock.state.closeCalls, [
        'http://127.0.0.1:9999',
        'http://127.0.0.1:9999',
      ])
      NodeAssert.deepEqual(sessions, [])
    }),
  )

  it.effect('completes streamEvents when the adapter scope closes', () =>
    Effect.gen(function* ()
    {
      const scope = yield* Scope.make('sequential')
      let scopeClosed = false

      try
      {
        const adapterLayer = Layer.effect(
          OpenCodeAdapter,
          makeOpenCodeAdapter(openCodeAdapterTestSettings),
        ).pipe(
          Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
          Layer.provideMerge(ServerSettingsService.layerTest()),
          Layer.provideMerge(providerSessionDirectoryTestLayer),
          Layer.provideMerge(NodeServices.layer),
        )
        const context = yield* Layer.buildWithScope(adapterLayer, scope)
        const adapter = yield* Effect.service(OpenCodeAdapter).pipe(Effect.provide(context))
        const eventsFiber = yield* unwrapOpenCodeRuntimeEvents(adapter).pipe(
          Stream.runCollect,
          Effect.forkChild,
        )

        yield* Scope.close(scope, Exit.void)
        scopeClosed = true

        const exit = yield* Fiber.await(eventsFiber).pipe(Effect.timeout('1 second'))
        NodeAssert.equal(Exit.hasInterrupts(exit), true)
      }
      finally
      {
        if (!scopeClosed)
        {
          yield* Scope.close(scope, Exit.void).pipe(Effect.ignore)
        }
      }
    }),
  )

  it.effect('rolls back session state when sendTurn fails before OpenCode accepts the prompt', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      yield* startOpenCodeTestSession(adapter, {
        provider: ProviderDriverKind.make('opencode'),
        threadId: asThreadId('thread-send-turn-failure'),
        runtimeMode: 'full-access',
      })

      runtimeMock.state.promptAsyncError = new Error('prompt failed')
      const error = yield* adapter
        .sendTurn({
          threadId: asThreadId('thread-send-turn-failure'),
          input: 'Fix it',
          modelSelection: {
            instanceId: ProviderInstanceId.make('opencode'),
            model: 'openai/gpt-5',
          },
        })
        .pipe(Effect.flip)
      const sessions = yield* adapter.listSessions()

      NodeAssert.equal(error._tag, 'ProviderAdapterRequestError')
      if (error._tag !== 'ProviderAdapterRequestError')
      {
        throw new Error('Unexpected error type')
      }
      NodeAssert.equal(error.detail, 'prompt failed')
      NodeAssert.equal(
        error.message,
        'Provider adapter request failed (opencode) for session.promptAsync: prompt failed',
      )
      NodeAssert.equal(sessions.length, 1)
      NodeAssert.equal(sessions[0]?.status, 'ready')
      NodeAssert.equal(sessions[0]?.activeTurnId, undefined)
      NodeAssert.equal(sessions[0]?.lastError, 'prompt failed')
    }),
  )

  it.effect('steers a running turn instead of opening a new one on mid-turn sendTurn (smoke)', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      const threadId = asThreadId('thread-steer')
      yield* startOpenCodeTestSession(adapter, {
        provider: ProviderDriverKind.make('opencode'),
        threadId,
        runtimeMode: 'full-access',
      })

      const turn = yield* adapter.sendTurn({
        threadId,
        input: 'run 5 commands',
        modelSelection: {
          instanceId: ProviderInstanceId.make('opencode'),
          model: 'openai/gpt-5',
        },
      })

      // steer: OpenCode queues the prompt into the busy session, so the
      // active turn id is reused instead of opening a new turn.
      const steeredTurn = yield* adapter.sendTurn({
        threadId,
        input: 'actually run 15',
        modelSelection: {
          instanceId: ProviderInstanceId.make('opencode'),
          model: 'openai/gpt-5',
        },
      })
      NodeAssert.equal(String(steeredTurn.turnId), String(turn.turnId))

      const sessions = yield* adapter.listSessions()
      const session = sessions.find((entry) => entry.threadId === threadId)
      NodeAssert.equal(session?.status, 'running')
      NodeAssert.equal(String(session?.activeTurnId), String(turn.turnId))
      NodeAssert.equal(runtimeMock.state.promptCalls.length, 2)
    }),
  )

  it.effect('keeps the running turn when a steer prompt fails', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      const threadId = asThreadId('thread-steer-failure')
      yield* startOpenCodeTestSession(adapter, {
        provider: ProviderDriverKind.make('opencode'),
        threadId,
        runtimeMode: 'full-access',
      })

      const turn = yield* adapter.sendTurn({
        threadId,
        input: 'run 5 commands',
        modelSelection: {
          instanceId: ProviderInstanceId.make('opencode'),
          model: 'openai/gpt-5',
        },
      })

      runtimeMock.state.promptAsyncError = new Error('steer failed')
      const error = yield* adapter
        .sendTurn({
          threadId,
          input: 'actually run 15',
          modelSelection: {
            instanceId: ProviderInstanceId.make('opencode'),
            model: 'openai/gpt-5',
          },
        })
        .pipe(Effect.flip)

      // the original turn keeps running — only the steer prompt failed.
      NodeAssert.equal(error._tag, 'ProviderAdapterRequestError')
      const sessions = yield* adapter.listSessions()
      const session = sessions.find((entry) => entry.threadId === threadId)
      NodeAssert.equal(session?.status, 'running')
      NodeAssert.equal(String(session?.activeTurnId), String(turn.turnId))
    }),
  )

  it.effect("passes agent and variant options for the adapter's bound custom instance id", () =>
  {
    const instanceId = ProviderInstanceId.make('opencode_zen')
    const adapterLayer = Layer.effect(
      OpenCodeAdapter,
      makeOpenCodeAdapter(openCodeAdapterTestSettings, { instanceId }),
    ).pipe(
      Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    )

    return Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      yield* startOpenCodeTestSession(adapter, {
        provider: ProviderDriverKind.make('opencode'),
        providerInstanceId: instanceId,
        threadId: asThreadId('thread-custom-instance'),
        runtimeMode: 'full-access',
      })

      yield* adapter.sendTurn({
        threadId: asThreadId('thread-custom-instance'),
        input: 'Fix it',
        modelSelection: createModelSelection(
          ProviderInstanceId.make('opencode_zen'),
          'anthropic/claude-sonnet-4-5',
          [
            { id: 'agent', value: 'github-copilot' },
            { id: 'variant', value: 'high' },
          ],
        ),
      })

      const { messageID, ...prompt } = runtimeMock.state.promptCalls.at(-1) as Record<
        string,
        unknown
      >
      NodeAssert.match(String(messageID), /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
      NodeAssert.deepEqual(prompt, {
        sessionID: 'http://127.0.0.1:9999/session',
        model: {
          providerID: 'anthropic',
          modelID: 'claude-sonnet-4-5',
        },
        agent: 'github-copilot',
        variant: 'high',
        parts: [{ type: 'text', text: 'Fix it' }],
      })
    }).pipe(Effect.provide(adapterLayer))
  })

  it.effect('uses the bound custom instance id for fallback sendTurn model selection', () =>
  {
    const instanceId = ProviderInstanceId.make('opencode_zen')
    const adapterLayer = Layer.effect(
      OpenCodeAdapter,
      makeOpenCodeAdapter(openCodeAdapterTestSettings, { instanceId }),
    ).pipe(
      Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    )

    return Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      const threadId = asThreadId('thread-custom-instance-fallback-model')
      yield* startOpenCodeTestSession(adapter, {
        provider: ProviderDriverKind.make('opencode'),
        providerInstanceId: instanceId,
        threadId,
        runtimeMode: 'full-access',
        modelSelection: createModelSelection(
          ProviderInstanceId.make('opencode_zen'),
          'anthropic/claude-sonnet-4-5',
        ),
      })

      yield* adapter.sendTurn({
        threadId,
        input: 'Fix it',
      })

      const { messageID, ...prompt } = runtimeMock.state.promptCalls.at(-1) as Record<
        string,
        unknown
      >
      NodeAssert.match(String(messageID), /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
      NodeAssert.deepEqual(prompt, {
        sessionID: 'http://127.0.0.1:9999/session',
        model: {
          providerID: 'anthropic',
          modelID: 'claude-sonnet-4-5',
        },
        parts: [{ type: 'text', text: 'Fix it' }],
      })
    }).pipe(Effect.provide(adapterLayer))
  })

  it.effect('rejects sendTurn model selections for another instance id', () =>
  {
    const instanceId = ProviderInstanceId.make('opencode_zen')
    const adapterLayer = Layer.effect(
      OpenCodeAdapter,
      makeOpenCodeAdapter(openCodeAdapterTestSettings, { instanceId }),
    ).pipe(
      Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    )

    return Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      const threadId = asThreadId('thread-custom-instance-wrong-selection')
      yield* startOpenCodeTestSession(adapter, {
        provider: ProviderDriverKind.make('opencode'),
        providerInstanceId: instanceId,
        threadId,
        runtimeMode: 'full-access',
      })

      const error = yield* adapter
        .sendTurn({
          threadId,
          input: 'Fix it',
          modelSelection: createModelSelection(
            ProviderInstanceId.make('opencode'),
            'anthropic/claude-sonnet-4-5',
          ),
        })
        .pipe(Effect.flip)

      NodeAssert.equal(error._tag, 'ProviderAdapterValidationError')
      if (error._tag !== 'ProviderAdapterValidationError')
      {
        throw new Error('Unexpected error type')
      }
      NodeAssert.equal(
        error.issue,
        "OpenCode model selection is bound to instance 'opencode', expected 'opencode_zen'.",
      )
      NodeAssert.deepEqual(runtimeMock.state.promptCalls, [])
    }).pipe(Effect.provide(adapterLayer))
  })

  it.effect('reverts the full thread when rollback removes every assistant turn', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      const threadId = asThreadId('thread-rollback-all')
      yield* startOpenCodeTestSession(adapter, {
        provider: ProviderDriverKind.make('opencode'),
        threadId,
        runtimeMode: 'full-access',
      })

      runtimeMock.state.messages = [
        {
          info: { id: 'assistant-1', role: 'assistant' },
          parts: [],
        },
        {
          info: { id: 'assistant-2', role: 'assistant' },
          parts: [],
        },
      ]

      const snapshot = yield* adapter.rollbackThread(threadId, 2)

      NodeAssert.deepEqual(runtimeMock.state.revertCalls, [
        { sessionID: 'http://127.0.0.1:9999/session' },
      ])
      NodeAssert.deepEqual(snapshot.turns, [])
    }),
  )

  it.effect('classifies a confirmed not-found across the shapes the SDK/runtime can produce', () =>
    Effect.sync(() =>
    {
      // the real production shape: runOpenCodeSdk wraps the thrown Error
      // (cause = { body, status }) under OpenCodeRuntimeError.
      const wrappedError = new Error('Session not found: ses_x', {
        cause: { body: { name: 'NotFoundError' }, status: 404 },
      })
      NodeAssert.equal(
        isOpenCodeNotFound({
          _tag: 'OpenCodeRuntimeError',
          operation: 'session.get',
          detail: 'Session not found: ses_x',
          cause: wrappedError,
        }),
        true,
      )

      // 404 expressed only via response.status (the bot's flagged shape).
      NodeAssert.equal(isOpenCodeNotFound({ cause: { response: { status: 404 } } }), true)
      // 404 via a bare numeric status / statusCode.
      NodeAssert.equal(isOpenCodeNotFound(new Error('x', { cause: { status: 404 } })), true)
      NodeAssert.equal(isOpenCodeNotFound({ statusCode: 404 }), true)
      // openCode NotFoundError body name with no status.
      NodeAssert.equal(isOpenCodeNotFound({ body: { name: 'NotFoundError' } }), true)

      // nOT a miss: only structured signals count, never free text. A non-404
      // error whose message/detail merely contains "not found" must propagate,
      // not be misread as a missing session and silently start fresh.
      NodeAssert.equal(
        isOpenCodeNotFound(new Error('upstream provider not found', { cause: { status: 500 } })),
        false,
      )
      NodeAssert.equal(isOpenCodeNotFound({ detail: 'status=500 body={...not found...}' }), false)
      // an explicit non-404 status seals its subtree: a 500 whose serialized
      // body echoes a NotFoundError name — or that is itself named
      // `NotFound` is a real failure, never a miss.
      NodeAssert.equal(isOpenCodeNotFound({ status: 500, body: { name: 'NotFoundError' } }), false)
      NodeAssert.equal(isOpenCodeNotFound({ name: 'UpstreamNotFoundError', status: 500 }), false)
      // a "NotFound"-flavored name that isn't OpenCode's exact `NotFoundError`
      // is not a confirmed miss even without a sealing status.
      NodeAssert.equal(isOpenCodeNotFound({ name: 'UpstreamNotFoundError' }), false)
      NodeAssert.equal(isOpenCodeNotFound({ cause: { name: 'ProviderNotFoundError' } }), false)
      NodeAssert.equal(
        isOpenCodeNotFound(
          new Error('x', { cause: { status: 502, body: { name: 'NotFoundError' } } }),
        ),
        false,
      )
      // other transient/auth/network failures must propagate too.
      NodeAssert.equal(isOpenCodeNotFound(new Error('boom', { cause: { status: 500 } })), false)
      NodeAssert.equal(isOpenCodeNotFound({ cause: { response: { status: 401 } } }), false)
      NodeAssert.equal(isOpenCodeNotFound(new Error('network error (no response)')), false)
      NodeAssert.equal(isOpenCodeNotFound(undefined), false)
    }),
  )

  it.effect('treats lexically or physically identical directories as the same', () =>
    Effect.gen(function* ()
    {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const sameDirectory = (left: string, right: string) =>
        isSameOpenCodeDirectory(fileSystem, path, left, right)

      // lexical-only differences (trailing slash, dot segments) short-circuit
      // without touching the filesystem — the paths need not exist.
      NodeAssert.equal(yield* sameDirectory('/repo/project/', '/repo/project'), true)
      NodeAssert.equal(yield* sameDirectory('/repo/nested/../project', '/repo/project'), true)
      // nonexistent paths degrade to the lexical comparison instead of failing.
      NodeAssert.equal(yield* sameDirectory('/repo/project', '/repo/other'), false)

      // a symlinked cwd (the macOS `/tmp` -> `/private/tmp` shape) resolves to
      // the directory it points at, so the two spellings compare equal.
      const base = yield* fileSystem.makeTempDirectoryScoped({ prefix: 't3-opencode-dir-' })
      const real = path.join(base, 'real')
      const link = path.join(base, 'link')
      yield* fileSystem.makeDirectory(real)
      yield* fileSystem.symlink(real, link)
      NodeAssert.equal(yield* sameDirectory(link, real), true)
      NodeAssert.equal(yield* sameDirectory(link, path.join(base, 'other')), false)
    }).pipe(Effect.scoped),
  )

  it.effect('appends raw assistant text deltas and reconciles part update snapshots', () =>
    Effect.sync(() =>
    {
      const firstUpdate = mergeOpenCodeAssistantText(undefined, 'Hello')
      const overlapDelta = appendOpenCodeAssistantTextDelta(firstUpdate.latestText, 'lo world')
      const secondUpdate = mergeOpenCodeAssistantText(overlapDelta.nextText, 'Hellolo world')

      NodeAssert.deepEqual(
        [firstUpdate.deltaToEmit, overlapDelta.deltaToEmit, secondUpdate.deltaToEmit],
        ['Hello', 'lo world', ''],
      )
      NodeAssert.equal(secondUpdate.latestText, 'Hellolo world')
    }),
  )

  it.effect('does not strip coincidental prefix overlap from OpenCode part deltas', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      const threadId = asThreadId('thread-opencode-raw-delta')
      const part = {
        id: 'part-raw-delta',
        sessionID: 'http://127.0.0.1:9999/session',
        messageID: 'msg-raw-delta',
        type: 'text',
        text: 'A B',
        time: { start: 1 },
      }
      runtimeMock.state.subscribedEvents = [
        {
          type: 'message.updated',
          properties: {
            sessionID: 'http://127.0.0.1:9999/session',
            info: {
              id: 'msg-raw-delta',
              role: 'assistant',
            },
          },
        },
        {
          type: 'message.part.updated',
          properties: {
            sessionID: 'http://127.0.0.1:9999/session',
            part,
            time: 1,
          },
        },
        {
          type: 'message.part.delta',
          properties: {
            sessionID: 'http://127.0.0.1:9999/session',
            messageID: 'msg-raw-delta',
            partID: 'part-raw-delta',
            field: 'text',
            delta: 'Bonus',
          },
        },
        {
          type: 'message.part.updated',
          properties: {
            sessionID: 'http://127.0.0.1:9999/session',
            part: {
              ...part,
              text: 'A BBonus',
              time: { start: 1, end: 2 },
            },
            time: 2,
          },
        },
      ]
      const eventsFiber = yield* unwrapOpenCodeRuntimeEvents(adapter).pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(5),
        Stream.runCollect,
        Effect.forkChild,
      )

      yield* startOpenCodeTestSession(adapter, {
        provider: ProviderDriverKind.make('opencode'),
        threadId,
        runtimeMode: 'full-access',
      })

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout('1 second')))
      const deltas = events.filter((event) => event.type === 'content.delta')
      NodeAssert.deepEqual(
        deltas.map((event) => (event.type === 'content.delta' ? event.payload.delta : '')),
        ['A B', 'Bonus'],
      )
      NodeAssert.equal(events.at(-1)?.type, 'item.completed')
      const completed = events.at(-1)
      if (completed?.type === 'item.completed')
      {
        NodeAssert.equal(completed.payload.detail, 'A BBonus')
      }
    }),
  )

  it.effect('retains text deltas until late assistant role metadata arrives', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      const threadId = asThreadId('thread-opencode-late-role-delta')
      const sessionID = 'http://127.0.0.1:9999/session'
      const messageID = 'msg-late-role'
      const partID = 'part-late-role'
      runtimeMock.state.subscribedEvents = [
        {
          type: 'message.part.updated',
          properties: {
            sessionID,
            part: {
              id: partID,
              sessionID,
              messageID,
              type: 'text',
              text: 'A',
              time: { start: 1 },
            },
            time: 1,
          },
        },
        {
          type: 'message.part.delta',
          properties: {
            sessionID,
            messageID,
            partID,
            field: 'text',
            delta: 'B',
          },
        },
        {
          type: 'message.updated',
          properties: { sessionID, info: { id: messageID, role: 'assistant' } },
        },
        {
          type: 'session.updated',
          properties: { sessionID, info: { id: sessionID, title: 'Late role marker' } },
        },
      ]
      const eventsFiber = yield* unwrapOpenCodeRuntimeEvents(adapter).pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.takeUntil((event) => event.type === 'thread.metadata.updated'),
        Stream.runCollect,
        Effect.forkChild,
      )

      yield* startOpenCodeTestSession(adapter, {
        provider: ProviderDriverKind.make('opencode'),
        threadId,
        runtimeMode: 'full-access',
      })

      const events = Array.from(yield* Fiber.join(eventsFiber))
      NodeAssert.deepEqual(
        events
          .filter((event) => event.type === 'content.delta')
          .map((event) => event.payload.delta),
        ['AB'],
      )
      yield* adapter.stopSession(threadId)
    }),
  )

  it.effect('passes the thread title and ignores OpenCode placeholder title updates', () =>
    Effect.gen(function* ()
    {
      const adapter = yield* OpenCodeAdapter
      const threadId = asThreadId('thread-opencode-title-sync')
      runtimeMock.state.subscribedEvents = [
        {
          type: 'session.updated',
          properties: {
            info: {
              id: 'http://127.0.0.1:9999/session',
              title: 'New session - 2026-08-09T10:20:30.456Z',
            },
          },
        },
        {
          type: 'session.updated',
          properties: {
            info: {
              id: 'http://127.0.0.1:9999/session',
              title: 'Investigate OpenCode title sync',
            },
          },
        },
      ]

      const eventsFiber = yield* unwrapOpenCodeRuntimeEvents(adapter).pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      )

      yield* startOpenCodeTestSession(adapter, {
        provider: ProviderDriverKind.make('opencode'),
        threadId,
        runtimeMode: 'full-access',
        title: 'Investigate OpenCode title sync',
      })

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout('1 second')))
      NodeAssert.equal(runtimeMock.state.sessionCreateInputs.length, 1)
      NodeAssert.equal(
        runtimeMock.state.sessionCreateInputs[0]?.title,
        'Investigate OpenCode title sync',
      )

      const metadataUpdated = events.filter((event) => event.type === 'thread.metadata.updated')
      NodeAssert.equal(metadataUpdated.length, 1)
      if (metadataUpdated[0]?.type === 'thread.metadata.updated')
      {
        NodeAssert.equal(metadataUpdated[0].payload.name, 'Investigate OpenCode title sync')
      }
    }),
  )

  it.effect('writes provider-native observability records using the session thread id', () =>
    Effect.gen(function* ()
    {
      const nativeEvents: Array<{
        readonly event?: {
          readonly provider?: string
          readonly threadId?: string
          readonly providerThreadId?: string
          readonly type?: string
        }
      }> = []
      const nativeThreadIds: Array<string | null> = []
      runtimeMock.state.subscribedEvents = [
        {
          type: 'message.updated',
          properties: {
            info: {
              id: 'msg-missing-session',
              role: 'assistant',
            },
          },
        },
        {
          type: 'message.updated',
          properties: {
            sessionID: 'http://127.0.0.1:9999/other-session',
            info: {
              id: 'msg-other-session',
              role: 'assistant',
            },
          },
        },
        {
          type: 'message.updated',
          properties: {
            sessionID: 'http://127.0.0.1:9999/session',
            info: {
              id: 'msg-native-log',
              role: 'assistant',
            },
          },
        },
      ]

      const nativeEventLogger = {
        filePath: 'memory://opencode-native-events',
        write: (event: unknown, threadId: ThreadId | null) =>
        {
          nativeEvents.push(event as (typeof nativeEvents)[number])
          nativeThreadIds.push(threadId ?? null)
          return Effect.void
        },
        close: () => Effect.void,
      }

      const adapterLayer = Layer.effect(
        OpenCodeAdapter,
        makeOpenCodeAdapter(openCodeAdapterTestSettings, {
          nativeEventLogger,
        }),
      ).pipe(
        Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(
          ServerSettingsService.layerTest({
            providers: {
              opencode: {
                binaryPath: 'fake-opencode',
                serverUrl: 'http://127.0.0.1:9999',
                serverPassword: 'secret-password',
              },
            },
          }),
        ),
        Layer.provideMerge(providerSessionDirectoryTestLayer),
        Layer.provideMerge(NodeServices.layer),
      )

      const session = yield* Effect.gen(function* ()
      {
        const adapter = yield* OpenCodeAdapter
        const started = yield* startOpenCodeTestSession(adapter, {
          provider: ProviderDriverKind.make('opencode'),
          threadId: asThreadId('thread-native-log'),
          runtimeMode: 'full-access',
        })
        yield* advanceTestClock(10)
        return started
      }).pipe(Effect.provide(adapterLayer))

      NodeAssert.equal(session.threadId, 'thread-native-log')
      NodeAssert.equal(nativeEvents.length, 1)
      NodeAssert.equal(
        nativeEvents.some((record) => record.event?.provider === 'opencode'),
        true,
      )
      NodeAssert.equal(
        nativeEvents.some(
          (record) => record.event?.providerThreadId === 'http://127.0.0.1:9999/session',
        ),
        true,
      )
      NodeAssert.equal(
        nativeEvents.some((record) => record.event?.threadId === 'thread-native-log'),
        true,
      )
      NodeAssert.equal(
        nativeEvents.some((record) => record.event?.type === 'message.updated'),
        true,
      )
      NodeAssert.equal(
        nativeThreadIds.every((threadId) => threadId === 'thread-native-log'),
        true,
      )
    }),
  )

  it.effect('keeps the event pump alive when native event logging fails', () =>
    Effect.gen(function* ()
    {
      runtimeMock.state.subscribedEvents = [
        {
          type: 'message.updated',
          properties: {
            sessionID: 'http://127.0.0.1:9999/session',
            info: {
              id: 'msg-native-log-failure',
              role: 'assistant',
            },
          },
        },
      ]

      const nativeEventLogger = {
        filePath: 'memory://opencode-native-events',
        write: () => Effect.die(new Error('native log write failed')),
        close: () => Effect.void,
      }

      const adapterLayer = Layer.effect(
        OpenCodeAdapter,
        makeOpenCodeAdapter(openCodeAdapterTestSettings, {
          nativeEventLogger,
        }),
      ).pipe(
        Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(
          ServerSettingsService.layerTest({
            providers: {
              opencode: {
                binaryPath: 'fake-opencode',
                serverUrl: 'http://127.0.0.1:9999',
                serverPassword: 'secret-password',
              },
            },
          }),
        ),
        Layer.provideMerge(providerSessionDirectoryTestLayer),
        Layer.provideMerge(NodeServices.layer),
      )

      // capture closeCalls *inside* the provided layer scope: the adapter's
      // layer finalizer now tears down any live sessions when the layer
      // closes (which is exactly what we want for leak prevention), so
      // inspecting closeCalls after `Effect.provide` completes would observe
      // the teardown — not the behavior under test. We care that the event
      // pump kept the session alive while logging was failing.
      const { sessions, closeCallsDuringRun } = yield* Effect.gen(function* ()
      {
        const adapter = yield* OpenCodeAdapter
        yield* startOpenCodeTestSession(adapter, {
          provider: ProviderDriverKind.make('opencode'),
          threadId: asThreadId('thread-native-log-failure'),
          runtimeMode: 'full-access',
        })
        yield* advanceTestClock(10)
        return {
          sessions: yield* adapter.listSessions(),
          closeCallsDuringRun: [...runtimeMock.state.closeCalls],
        }
      }).pipe(Effect.provide(adapterLayer))

      NodeAssert.equal(sessions.length, 1)
      NodeAssert.equal(sessions[0]?.threadId, 'thread-native-log-failure')
      NodeAssert.deepEqual(closeCallsDuringRun, [])
    }),
  )
})
