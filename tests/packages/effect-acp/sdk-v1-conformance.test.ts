// tests/packages/effect-acp/sdk-v1-conformance.test.ts
// verifies the Effect client against the official ACP SDK v1 over real stdio

import * as Cause from 'effect/Cause'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import * as Queue from 'effect/Queue'
import * as Ref from 'effect/Ref'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'

import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, it } from '@effect/vitest'

import * as AcpClient from 'effect-acp/client'
import * as AcpError from 'effect-acp/errors'

const newSessionId = 'sdk-v1-session::new/opaque'
const storedSessionId = 'sdk-v1-session::stored/opaque'
const toolCallId = 'sdk-v1-tool::opaque/call?one'
const permissionOptionId = 'sdk-v1-permission::opaque/allow?once'

interface ProtocolLogEvent
{
  readonly direction: 'incoming' | 'outgoing'
  readonly stage: 'raw' | 'decoded' | 'decode_failed'
  readonly payload: unknown
}

interface FixtureStatus
{
  readonly closeCount: number
  readonly deletedSessionIds: ReadonlyArray<string>
  readonly genericCancelCount: number
  readonly loadReplayCount: number
  readonly resumeReplayCount: number
  readonly sessionCancelCount: number
  readonly sessions: ReadonlyArray<{
    readonly sessionId: string
    readonly cwd: string
    readonly active: boolean
    readonly closed: boolean
    readonly updatedAt: string
  }>
}

interface JsonRpcMessage
{
  readonly jsonrpc: string
  readonly id?: string | number | null
  readonly method?: string
  readonly params?: unknown
  readonly result?: unknown
  readonly error?: unknown
}

const fixturePath = Effect.map(Effect.service(Path.Path), (path) =>
  path.join(import.meta.dirname, '../../../packages/effect-acp/test/fixtures/acp-sdk-v1-agent.ts'),
)

const parseProtocolFrames = (
  events: ReadonlyArray<ProtocolLogEvent>,
  direction: ProtocolLogEvent['direction'],
) =>
  events
    .filter((event) => event.direction === direction && event.stage === 'raw')
    .flatMap((event) =>
      String(event.payload)
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as JsonRpcMessage),
    )

it.layer(NodeServices.layer)('official ACP SDK v1 conformance', (it) =>
{
  it.effect('covers lifecycle, streaming, cancellation, framing, and EOF cleanup', () =>
    Effect.gen(function* ()
    {
      const scope = yield* Scope.make()

      yield* Effect.gen(function* ()
      {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const path = yield* Path.Path
        const eofInput = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>()
        const command = ChildProcess.make(process.execPath, [yield* fixturePath], {
          cwd: path.join(import.meta.dirname, '..'),
          stdin: {
            stream: Stream.fromQueue(eofInput),
            endOnDone: true,
          },
        })
        const handle = yield* spawner.spawn(command).pipe(Effect.provideService(Scope.Scope, scope))
        const events = yield* Ref.make<Array<ProtocolLogEvent>>([])
        const updates = yield* Ref.make<Array<unknown>>([])
        const permissionRequests = yield* Ref.make<Array<unknown>>([])
        const sessionCancelReady = yield* Deferred.make<void>()
        const genericCancelReady = yield* Deferred.make<void>()
        const genericCancelObserved = yield* Deferred.make<void>()
        const termination = yield* Deferred.make<AcpError.AcpError>()
        const context = yield* Layer.buildWithScope(
          AcpClient.layerChildProcess(handle, {
            logIncoming: true,
            logOutgoing: true,
            maximumIncomingFrameBytes: 1024 * 1024,
            logger: (event) => Ref.update(events, (current) => [...current, event]),
            onTermination: (error) => Deferred.succeed(termination, error).pipe(Effect.asVoid),
          }),
          scope,
        )

        yield* Effect.gen(function* ()
        {
          const acp = yield* AcpClient.AcpClient

          yield* acp.handleRequestPermission((request) =>
            Ref.update(permissionRequests, (current) => [...current, request]).pipe(
              Effect.as({
                outcome: {
                  outcome: 'selected' as const,
                  optionId: permissionOptionId,
                },
              }),
            ),
          )
          yield* acp.handleSessionUpdate((notification) =>
            Ref.update(updates, (current) => [...current, notification]).pipe(
              Effect.andThen(
                notification._meta?.fixtureMarker === 'session-cancel-ready'
                  ? Deferred.succeed(sessionCancelReady, undefined).pipe(Effect.asVoid)
                  : notification._meta?.fixtureMarker === 'generic-cancel-ready'
                    ? Deferred.succeed(genericCancelReady, undefined).pipe(Effect.asVoid)
                    : notification._meta?.fixtureMarker === 'generic-cancel-observed'
                      ? Deferred.succeed(genericCancelObserved, undefined).pipe(Effect.asVoid)
                      : Effect.void,
              ),
            ),
          )

          const initialized = yield* acp.agent.initialize({
            protocolVersion: 1,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
            clientInfo: {
              name: 'effect-acp-sdk-v1-conformance',
              version: '0.0.0',
            },
          })
          assert.equal(initialized.protocolVersion, 1)
          assert.deepEqual(initialized.authMethods, [])
          assert.deepInclude(initialized.agentCapabilities, {
            loadSession: true,
            sessionCapabilities: {
              close: {},
              list: {},
              resume: {},
            },
          })

          const created = yield* acp.agent.createSession({
            cwd: process.cwd(),
            mcpServers: [],
          })
          assert.equal(created.sessionId, newSessionId)

          const beforeResume = (yield* Ref.get(updates)).length
          const resumed = yield* acp.agent.resumeSession({
            sessionId: storedSessionId,
            cwd: '/tmp/sdk-v1-stored',
            mcpServers: [],
          })
          assert.deepInclude(resumed, { _meta: { replayedUpdates: 0 } })
          assert.equal((yield* Ref.get(updates)).length, beforeResume)

          const beforeLoad = (yield* Ref.get(updates)).length
          const loaded = yield* acp.agent.loadSession({
            sessionId: storedSessionId,
            cwd: '/tmp/sdk-v1-stored',
            mcpServers: [],
          })
          assert.deepInclude(loaded, { _meta: { replayedUpdates: 3 } })
          const loadUpdates = (yield* Ref.get(updates)).slice(beforeLoad) as Array<{
            readonly sessionId: string
            readonly update: { readonly sessionUpdate: string }
          }>
          assert.deepEqual(
            loadUpdates.map(({ sessionId, update }) => [sessionId, update.sessionUpdate]),
            [
              [storedSessionId, 'user_message_chunk'],
              [storedSessionId, 'agent_thought_chunk'],
              [storedSessionId, 'agent_message_chunk'],
            ],
          )

          const beforePrompt = (yield* Ref.get(updates)).length
          const prompt = yield* acp.agent.prompt({
            sessionId: newSessionId,
            prompt: [{ type: 'text', text: 'stream deterministic turn' }],
          })
          assert.deepEqual(prompt, {
            stopReason: 'end_turn',
            usage: {
              totalTokens: 13,
              inputTokens: 8,
              outputTokens: 5,
              thoughtTokens: 2,
            },
          })
          const promptUpdates = (yield* Ref.get(updates)).slice(beforePrompt) as Array<{
            readonly sessionId: string
            readonly update: {
              readonly sessionUpdate: string
              readonly toolCallId?: string
              readonly used?: number
              readonly size?: number
            }
          }>
          assert.deepEqual(
            promptUpdates.map(({ update }) => update.sessionUpdate),
            [
              'agent_message_chunk',
              'agent_thought_chunk',
              'tool_call',
              'tool_call_update',
              'usage_update',
            ],
          )
          assert.equal(promptUpdates[2]?.update.toolCallId, toolCallId)
          assert.equal(promptUpdates[3]?.update.toolCallId, toolCallId)
          assert.deepInclude(promptUpdates[4]?.update, { used: 13, size: 4096 })
          const permissions = (yield* Ref.get(permissionRequests)) as Array<{
            readonly sessionId: string
            readonly toolCall: { readonly toolCallId: string }
            readonly options: ReadonlyArray<{ readonly optionId: string }>
          }>
          assert.equal(permissions.length, 1)
          assert.equal(permissions[0]?.sessionId, newSessionId)
          assert.equal(permissions[0]?.toolCall.toolCallId, toolCallId)
          assert.deepEqual(
            permissions[0]?.options.map(({ optionId }) => optionId),
            [permissionOptionId],
          )

          const cancelledPrompt = yield* acp.agent
            .prompt({
              sessionId: newSessionId,
              prompt: [{ type: 'text', text: 'wait-for-session-cancel' }],
            })
            .pipe(Effect.forkScoped)
          yield* Deferred.await(sessionCancelReady)
          yield* acp.agent.cancel({ sessionId: newSessionId })
          assert.deepEqual(yield* Fiber.join(cancelledPrompt), { stopReason: 'cancelled' })

          const genericRequest = yield* acp.raw
            .request('x/conformance/block', { sessionId: newSessionId })
            .pipe(Effect.forkScoped)
          yield* Deferred.await(genericCancelReady)
          yield* Fiber.interrupt(genericRequest)
          yield* Deferred.await(genericCancelObserved)

          yield* acp.agent.closeSession({ sessionId: newSessionId })
          const listed = yield* acp.agent.listSessions({})
          assert.include(
            listed.sessions.map(({ sessionId }) => sessionId),
            newSessionId,
          )

          const status = (yield* acp.raw.request('x/conformance/status', {})) as FixtureStatus
          assert.deepInclude(status, {
            closeCount: 1,
            deletedSessionIds: [],
            genericCancelCount: 1,
            loadReplayCount: 3,
            resumeReplayCount: 0,
            sessionCancelCount: 1,
          })
          assert.deepInclude(
            status.sessions.find(({ sessionId }) => sessionId === newSessionId),
            {
              sessionId: newSessionId,
              active: false,
              closed: true,
              updatedAt: '2026-08-12T12:00:00.000Z',
            },
          )

          const recordedEvents = yield* Ref.get(events)
          const incomingFrames = parseProtocolFrames(recordedEvents, 'incoming')
          const outgoingFrames = parseProtocolFrames(recordedEvents, 'outgoing')
          assert.isAbove(incomingFrames.length, 0)
          assert.isTrue(incomingFrames.every(({ jsonrpc }) => jsonrpc === '2.0'))
          const promptRequests = outgoingFrames.filter(({ method }) => method === 'session/prompt')
          assert.equal(promptRequests.length, 2)
          for (const request of promptRequests)
          {
            assert.equal(
              incomingFrames.filter(
                ({ id, method, result, error }) =>
                  method === undefined &&
                  id === request.id &&
                  (result !== undefined || error !== undefined),
              ).length,
              1,
            )
          }
          assert.isTrue(outgoingFrames.some(({ method }) => method === 'session/cancel'))
          assert.isTrue(outgoingFrames.some(({ method }) => method === '$/cancel_request'))

          yield* Queue.end(eofInput)
          const terminationError = yield* Deferred.await(termination)
          assert.instanceOf(terminationError, AcpError.AcpProcessExitedError)
          if (terminationError._tag === 'AcpProcessExitedError')
          {
            assert.equal(terminationError.code, 0)
          }
          assert.equal(yield* handle.exitCode, 0)
        }).pipe(Effect.provide(context))
      }).pipe(Effect.ensuring(Scope.close(scope, Exit.void)))
    }),
  )
})
