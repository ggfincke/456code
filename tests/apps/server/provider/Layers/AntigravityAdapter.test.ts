// tests/apps/server/provider/Layers/AntigravityAdapter.test.ts
// verifies Antigravity adapter lifecycle, normalization, usage, and fail-closed behavior

// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'

import * as NodeServices from '@effect/platform-node/NodeServices'
import { beforeEach, vi } from 'vite-plus/test'

const runtimeHarness = vi.hoisted(() => ({
  scripts: [] as Array<{
    readonly conversationId: string
    readonly turns: Array<{
      readonly events: ReadonlyArray<unknown>
      readonly hold?: boolean
      readonly result: {
        readonly conversationId?: string
        readonly status: string
        readonly response: string
        readonly error?: string
        readonly raw: Record<string, unknown>
      }
    }>
  }>,
  created: [] as Array<Record<string, unknown>>,
  sentTexts: [] as string[],
}))

vi.mock(
  '../../../../../apps/server/src/provider/antigravity/AntigravitySessionRuntime.ts',
  async () =>
  {
    const Effect = await import('effect/Effect')
    const PubSub = await import('effect/PubSub')
    const Stream = await import('effect/Stream')

    return {
      makeAntigravitySessionRuntime: (options: Record<string, unknown>) =>
        Effect.gen(function* ()
        {
          const script = runtimeHarness.scripts.shift() ?? {
            conversationId: 'conv-default',
            turns: [],
          }
          runtimeHarness.created.push(options)
          const events = yield* PubSub.unbounded<unknown>()
          return {
            conversationId: Effect.succeed(script.conversationId),
            isLive: Effect.succeed(true),
            events: Stream.fromPubSub(events),
            sendTurn: (text: string) =>
              Effect.gen(function* ()
              {
                runtimeHarness.sentTexts.push(text)
                const turn = script.turns.shift()
                if (!turn)
                {
                  const fallback = {
                    conversationId: script.conversationId,
                    status: 'SUCCESS',
                    response: text,
                    raw: { event: 'result', result: { conversation_id: script.conversationId } },
                  }
                  yield* PubSub.publish(events, { kind: 'result', value: fallback.raw })
                  return fallback
                }
                if (turn.hold) return yield* Effect.never
                yield* Effect.sleep('2 millis')
                yield* Effect.forEach(turn.events, (event) => PubSub.publish(events, event), {
                  discard: true,
                })
                yield* PubSub.publish(events, { kind: 'result', value: turn.result.raw })
                return turn.result
              }),
            interrupt: Effect.void,
            close: Effect.void,
          }
        }),
    }
  },
)

import { it } from '@effect/vitest'
import {
  ApprovalRequestId,
  AntigravitySettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import * as TestClock from 'effect/testing/TestClock'
import { expect } from 'vite-plus/test'

import { makeAntigravityAdapter } from '../../../../../apps/server/src/provider/Layers/AntigravityAdapter.ts'
import {
  type ProviderAdapterError,
  ProviderAdapterValidationError,
} from '../../../../../apps/server/src/provider/Errors.ts'

const decodeSettings = Schema.decodeSync(AntigravitySettings)
const isProviderAdapterValidationError = Schema.is(ProviderAdapterValidationError)
const provider = ProviderDriverKind.make('antigravity')
const instanceId = ProviderInstanceId.make('antigravity')

const step = (
  stepType: string,
  stepState: 'ACTIVE' | 'DONE',
  stepIndex: number,
  extra: Record<string, unknown> = {},
) => ({
  kind: 'step_update' as const,
  value: {
    event: 'step_update',
    conversation_id: 'conv-1',
    step_update: {
      conversation_id: 'conv-1',
      step_type: stepType,
      state: stepState,
      step_index: stepIndex,
      ...extra,
    },
  },
})

const result = (input: {
  readonly status: string
  readonly response?: string
  readonly conversationId?: string
  readonly error?: string
  readonly usage?: Record<string, unknown>
}) => ({
  conversationId: input.conversationId ?? 'conv-1',
  status: input.status,
  response: input.response ?? '',
  ...(input.error === undefined ? {} : { error: input.error }),
  raw: {
    event: 'result',
    result: {
      conversation_id: input.conversationId ?? 'conv-1',
      status: input.status,
      response: input.response ?? '',
      ...(input.error === undefined ? {} : { error: input.error }),
      ...(input.usage === undefined ? {} : { usage: input.usage }),
    },
  },
})

const turn = (
  events: ReadonlyArray<unknown>,
  turnResult: ReturnType<typeof result>,
  hold = false,
) => ({ events, result: turnResult, hold })

const startInput = (threadId: ThreadId, overrides: Record<string, unknown> = {}) => ({
  threadId,
  provider,
  providerInstanceId: instanceId,
  cwd: process.cwd(),
  runtimeMode: 'auto-accept-edits' as const,
  runtimeSessionBinding: {
    providerInstanceId: instanceId,
    threadId,
    sessionGeneration: 1,
  },
  ...overrides,
})

const expectedDefaultExecutable = (() =>
{
  for (const entry of (process.env.PATH ?? '').split(NodePath.delimiter))
  {
    const candidate = NodePath.join(entry, 'agy')
    try
    {
      NodeFS.accessSync(candidate, NodeFS.constants.X_OK)
      return NodePath.resolve(candidate)
    }
    catch
    {
      // keep searching the test process PATH
    }
  }
  return 'agy'
})()

const defaultCursorBinding = {
  workspace: process.cwd(),
  executable: expectedDefaultExecutable,
  model: 'default',
  agent: '',
  runtimeMode: 'auto-accept-edits' as const,
  sandbox: false,
}

const makeAdapter = () =>
  makeAntigravityAdapter(decodeSettings({ binaryPath: 'agy', agent: '', sandbox: false }))

const waitForEvent = (
  events: ReadonlyArray<ProviderRuntimeEvent>,
  predicate: (event: ProviderRuntimeEvent) => boolean,
): Effect.Effect<void> =>
  Effect.gen(function* ()
  {
    for (let attempt = 0; attempt < 500; attempt += 1)
    {
      if (events.some(predicate)) return
      yield* Effect.sleep('2 millis')
    }
    return yield* Effect.die(
      new Error(`Timed out waiting for event; saw ${events.map((event) => event.type).join(',')}`),
    )
  })

const expectValidationFailure = <A>(effect: Effect.Effect<A, ProviderAdapterError>) =>
  effect.pipe(
    Effect.flip,
    Effect.flatMap((error) =>
      isProviderAdapterValidationError(error)
        ? Effect.succeed(error)
        : Effect.die(new Error('Expected Antigravity validation failure.')),
    ),
  )

const eventPayload = (event: ProviderRuntimeEvent): Record<string, unknown> =>
  event.payload as Record<string, unknown>

beforeEach(() =>
{
  runtimeHarness.scripts.length = 0
  runtimeHarness.created.length = 0
  runtimeHarness.sentTexts.length = 0
})

it.layer(NodeServices.layer)('AntigravityAdapter', (it) =>
{
  it.effect(
    'passes generic attachment path context as text without enabling native attachments',
    () =>
      Effect.gen(function* ()
      {
        const adapter = yield* makeAdapter()
        const threadId = ThreadId.make('antigravity-file-context')
        const events: Array<ProviderRuntimeEvent> = []
        const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => events.push(event.event)),
        ).pipe(Effect.forkChild)
        yield* adapter.startSession(startInput(threadId))
        const input = '[Attached file: "/managed/report.pdf"]'
        const sent = yield* adapter.sendTurn({
          threadId,
          input,
          attachments: [
            {
              type: 'file',
              id: 'thread-file-12345678-1234-1234-1234-123456789abc-pdf',
              name: 'report.pdf',
              mimeType: 'application/pdf',
              sizeBytes: 4,
            },
          ],
        })
        yield* waitForEvent(
          events,
          (event) => event.type === 'turn.completed' && event.turnId === sent.turnId,
        )
        expect(adapter.capabilities.supportedAttachmentTypes).toEqual([])
        expect(runtimeHarness.sentTexts).toEqual([input])
        yield* adapter.stopSession(threadId)
        yield* Fiber.interrupt(eventFiber)
      }).pipe(TestClock.withLive, Effect.timeout('10 seconds')),
  )

  it.effect(
    'starts and resumes identity, normalizes events, and reports cumulative usage deltas',
    () =>
      Effect.gen(function* ()
      {
        runtimeHarness.scripts.push({
          conversationId: 'conv-1',
          turns: [
            turn(
              [
                step('agent_response', 'ACTIVE', 0, {
                  text_delta: 'hello ',
                  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
                }),
                step('agent_response', 'ACTIVE', 0, { text_delta: 'world' }),
                step('tool', 'ACTIVE', 1, {
                  tool_name: 'run_command',
                  tool_info: { parameters: { command: 'pwd' } },
                }),
                step('tool', 'DONE', 1, {
                  tool_name: 'run_command',
                  tool_info: { parameters: { command: 'pwd' }, output: '/tmp' },
                }),
                step('checkpoint', 'DONE', 2, { checkpoint: 'saved' }),
                step('tool', 'ACTIVE', 3, {
                  tool_name: 'delegate',
                  subagent_info: {
                    subagents: [{ conversation_id: 'sub-1', role: 'review', type_name: 'worker' }],
                  },
                }),
                step('system_message', 'DONE', 4, { future_metadata: { retained: true } }),
              ],
              result({
                status: 'SUCCESS',
                response: 'fallback',
                usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
              }),
            ),
            turn(
              [],
              result({
                status: 'SUCCESS',
                response: 'second',
                usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
              }),
            ),
            turn(
              [],
              result({
                status: 'SUCCESS',
                response: 'reset',
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
              }),
            ),
          ],
        })
        runtimeHarness.scripts.push({ conversationId: 'conv-1', turns: [] })
        const adapter = yield* makeAdapter()
        const events: Array<ProviderRuntimeEvent> = []
        const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => events.push(event.event)),
        ).pipe(Effect.forkChild)
        const threadId = ThreadId.make('antigravity-adapter-lifecycle')
        const session = yield* adapter.startSession(startInput(threadId))
        const first = yield* adapter.sendTurn({ threadId, input: 'first', attachments: [] })
        yield* waitForEvent(
          events,
          (event) => event.type === 'turn.completed' && event.turnId === first.turnId,
        )
        const second = yield* adapter.sendTurn({ threadId, input: 'second', attachments: [] })
        yield* waitForEvent(
          events,
          (event) => event.type === 'turn.completed' && event.turnId === second.turnId,
        )
        const third = yield* adapter.sendTurn({ threadId, input: 'third', attachments: [] })
        yield* waitForEvent(
          events,
          (event) => event.type === 'turn.completed' && event.turnId === third.turnId,
        )

        expect(session.resumeCursor).toEqual({
          schemaVersion: 2,
          conversationId: 'conv-1',
          binding: defaultCursorBinding,
        })
        expect(runtimeHarness.created[0]).not.toHaveProperty('resumeCursor')
        expect(
          events.some(
            (event) => event.type === 'content.delta' && eventPayload(event).delta === 'hello ',
          ),
        ).toBe(true)
        expect(
          events.some(
            (event) => event.type === 'content.delta' && eventPayload(event).delta === 'fallback',
          ),
        ).toBe(false)
        expect(
          events.some(
            (event) =>
              event.type === 'item.completed' &&
              eventPayload(event).itemType === 'command_execution',
          ),
        ).toBe(true)
        expect(
          events.some(
            (event) =>
              event.type === 'task.progress' && eventPayload(event).taskId === 'antigravity:sub-1',
          ),
        ).toBe(true)
        expect(
          events.some(
            (event) =>
              event.type === 'item.completed' &&
              eventPayload(event).title === 'Antigravity system message',
          ),
        ).toBe(true)
        const usageEvents = events.filter((event) => event.type === 'thread.token-usage.updated')
        expect(
          usageEvents.map(
            (event) => (eventPayload(event).usage as Record<string, unknown>).lastUsedTokens,
          ),
        ).toContain(15)
        const terminalUsage = events
          .filter((event) => event.type === 'turn.completed')
          .map((event) => (eventPayload(event).usage as Record<string, unknown>).totalTokens)
        expect(terminalUsage).toEqual([15, 5, 2])
        expect(events.some((event) => event.type === 'runtime.warning')).toBe(true)

        const persistedCursor = (yield* adapter.listSessions()).find(
          (entry) => entry.threadId === threadId,
        )?.resumeCursor
        expect(persistedCursor).toEqual({
          schemaVersion: 2,
          conversationId: 'conv-1',
          binding: defaultCursorBinding,
          cumulativeUsage: {
            input: 1,
            output: 1,
            total: 2,
          },
        })

        yield* adapter.stopSession(threadId)
        const resumed = yield* adapter.startSession(
          startInput(threadId, {
            resumeCursor: persistedCursor,
            runtimeSessionBinding: {
              providerInstanceId: instanceId,
              threadId,
              sessionGeneration: 2,
            },
          }),
        )
        expect(resumed.resumeCursor).toEqual(persistedCursor)
        expect(runtimeHarness.created[1]?.resumeCursor).toEqual(persistedCursor)
        yield* adapter.stopSession(threadId)
        yield* Fiber.interrupt(eventFiber)
      }).pipe(TestClock.withLive, Effect.timeout('10 seconds')),
  )

  it.effect('preserves omitted cumulative counters instead of subtracting from zero', () =>
    Effect.gen(function* ()
    {
      runtimeHarness.scripts.push({
        conversationId: 'conv-usage',
        turns: [
          turn(
            [],
            result({
              status: 'SUCCESS',
              response: 'first',
              usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
            }),
          ),
          turn(
            [],
            result({
              status: 'SUCCESS',
              response: 'second',
              usage: { output_tokens: 8, total_tokens: 18 },
            }),
          ),
        ],
      })
      const adapter = yield* makeAdapter()
      const events: Array<ProviderRuntimeEvent> = []
      const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event.event)),
      ).pipe(Effect.forkChild)
      const threadId = ThreadId.make('antigravity-usage-omission')
      yield* adapter.startSession(startInput(threadId))
      const first = yield* adapter.sendTurn({ threadId, input: 'first', attachments: [] })
      yield* waitForEvent(
        events,
        (event) => event.type === 'turn.completed' && event.turnId === first.turnId,
      )
      const second = yield* adapter.sendTurn({ threadId, input: 'second', attachments: [] })
      yield* waitForEvent(
        events,
        (event) => event.type === 'turn.completed' && event.turnId === second.turnId,
      )
      const completion = events.find(
        (event) => event.type === 'turn.completed' && event.turnId === second.turnId,
      )
      const usage = completion && (eventPayload(completion).usage as Record<string, unknown>)
      expect(usage).toMatchObject({ outputTokens: 3, totalTokens: 3 })
      expect(usage).not.toHaveProperty('inputTokens')
      const cursor = (yield* adapter.listSessions()).find(
        (entry) => entry.threadId === threadId,
      )?.resumeCursor
      const cursorRecord = cursor as Record<string, unknown> | undefined
      expect(cursorRecord?.cumulativeUsage).toEqual({
        input: 10,
        output: 8,
        total: 18,
      })
      yield* adapter.stopSession(threadId)
      yield* Fiber.interrupt(eventFiber)
    }).pipe(TestClock.withLive, Effect.timeout('10 seconds')),
  )

  it.effect('resolves a bare Antigravity executable from the launch environment', () =>
    Effect.gen(function* ()
    {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'antigravity-adapter-'))
      const executable = NodePath.join(root, 'agy')
      NodeFS.writeFileSync(executable, '#!/bin/sh\n')
      NodeFS.chmodSync(executable, 0o755)
      runtimeHarness.scripts.push({ conversationId: 'conv-path', turns: [] })
      const adapter = yield* makeAntigravityAdapter(
        decodeSettings({ binaryPath: 'agy', agent: '', sandbox: false }),
        { environment: { PATH: root } },
      )
      const threadId = ThreadId.make('antigravity-executable-resolution')
      yield* adapter.startSession(startInput(threadId))
      expect(runtimeHarness.created[0]?.binaryPath).toBe(NodeFS.realpathSync(executable))
      yield* adapter.stopSession(threadId)
    }).pipe(TestClock.withLive, Effect.timeout('10 seconds')),
  )

  it.effect('starts fresh and reports continuation loss for an incompatible cursor', () =>
    Effect.gen(function* ()
    {
      runtimeHarness.scripts.push({ conversationId: 'conv-fresh', turns: [] })
      const adapter = yield* makeAdapter()
      const events: Array<ProviderRuntimeEvent> = []
      const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event.event)),
      ).pipe(Effect.forkChild)
      const threadId = ThreadId.make('antigravity-fresh-after-mismatch')
      const session = yield* adapter.startSession(
        startInput(threadId, {
          resumeCursor: {
            schemaVersion: 2,
            conversationId: 'stale-conversation',
            binding: { ...defaultCursorBinding, model: 'stale-model' },
            cumulativeUsage: { total: 999 },
          },
        }),
      )
      yield* waitForEvent(events, (event) => event.type === 'runtime.warning')
      expect(JSON.stringify(session.resumeCursor)).toContain('conv-fresh')
      expect(runtimeHarness.created[0]).not.toHaveProperty('resumeCursor')
      yield* adapter.stopSession(threadId)
      yield* Fiber.interrupt(eventFiber)
    }).pipe(TestClock.withLive, Effect.timeout('10 seconds')),
  )

  it.effect('rejects active second turns and unsupported interaction operations', () =>
    Effect.gen(function* ()
    {
      runtimeHarness.scripts.push({
        conversationId: 'conv-1',
        turns: [turn([], result({ status: 'SUCCESS', response: 'done' }), true)],
      })
      const adapter = yield* makeAdapter()
      const threadId = ThreadId.make('antigravity-adapter-restrictions')
      yield* adapter.startSession(startInput(threadId))
      const first = yield* adapter.sendTurn({ threadId, input: 'first', attachments: [] })
      const secondTurn = yield* expectValidationFailure(
        adapter.sendTurn({ threadId, input: 'second', attachments: [] }),
      )
      expect((secondTurn as ProviderAdapterValidationError).issue).toContain('active second turn')
      yield* adapter.interruptTurn(threadId, first.turnId)

      const attachmentFailure = yield* expectValidationFailure(
        adapter.sendTurn({
          threadId,
          input: 'text',
          attachments: [
            {
              type: 'image',
              id: 'image-1',
              name: 'image.png',
              mimeType: 'image/png',
              sizeBytes: 1,
            },
          ],
        }),
      )
      expect((attachmentFailure as ProviderAdapterValidationError).issue).toContain(
        'text input only',
      )
      const planFailure = yield* expectValidationFailure(
        adapter.sendTurn({ threadId, input: 'text', attachments: [], interactionMode: 'plan' }),
      )
      expect((planFailure as ProviderAdapterValidationError).issue).toContain('plan mode')
      const modelFailure = yield* expectValidationFailure(
        adapter.sendTurn({
          threadId,
          input: 'text',
          attachments: [],
          modelSelection: { instanceId, model: 'different-model' },
        }),
      )
      expect((modelFailure as ProviderAdapterValidationError).issue).toContain('model changes')
      const approvalFailure = yield* expectValidationFailure(
        adapter.respondToRequest(threadId, ApprovalRequestId.make('request-1'), 'accept'),
      )
      expect((approvalFailure as ProviderAdapterValidationError).issue).toContain('approvals')
      const inputFailure = yield* expectValidationFailure(
        adapter.respondToUserInput(threadId, ApprovalRequestId.make('request-1'), {}),
      )
      expect((inputFailure as ProviderAdapterValidationError).issue).toContain('structured input')
      const rollbackFailure = yield* expectValidationFailure(adapter.rollbackThread(threadId, 1))
      expect((rollbackFailure as ProviderAdapterValidationError).issue).toContain('rollback')
      expect(String(first.turnId)).not.toHaveLength(0)
      yield* adapter.stopSession(threadId)
    }).pipe(TestClock.withLive, Effect.timeout('10 seconds')),
  )

  it.effect('fails closed on result conversation mismatches and unknown terminal statuses', () =>
    Effect.gen(function* ()
    {
      runtimeHarness.scripts.push({
        conversationId: 'conv-1',
        turns: [
          turn([], result({ status: 'SUCCESS', conversationId: 'conv-other', response: 'wrong' })),
          turn([], result({ status: 'ERROR', response: '', error: 'native failure' })),
          turn([], result({ status: 'MAYBE', response: 'unknown' })),
        ],
      })
      const adapter = yield* makeAdapter()
      const threadId = ThreadId.make('antigravity-adapter-fail-closed')
      const events: Array<ProviderRuntimeEvent> = []
      const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event.event)),
      ).pipe(Effect.forkChild)
      yield* adapter.startSession(startInput(threadId))
      const mismatch = yield* adapter.sendTurn({ threadId, input: 'mismatch', attachments: [] })
      yield* waitForEvent(
        events,
        (event) => event.type === 'turn.completed' && event.turnId === mismatch.turnId,
      )
      const mismatchCompletion = events.find(
        (event) => event.type === 'turn.completed' && event.turnId === mismatch.turnId,
      )
      expect(mismatchCompletion && eventPayload(mismatchCompletion).state).toBe('failed')
      expect(mismatchCompletion && eventPayload(mismatchCompletion).errorMessage).toContain(
        'did not match',
      )
      const nativeError = yield* adapter.sendTurn({
        threadId,
        input: 'native-error',
        attachments: [],
      })
      yield* waitForEvent(
        events,
        (event) => event.type === 'turn.completed' && event.turnId === nativeError.turnId,
      )
      const nativeErrorCompletion = events.find(
        (event) => event.type === 'turn.completed' && event.turnId === nativeError.turnId,
      )
      expect(nativeErrorCompletion && eventPayload(nativeErrorCompletion).state).toBe('failed')
      expect(nativeErrorCompletion && eventPayload(nativeErrorCompletion).errorMessage).toContain(
        'native failure',
      )
      const unknown = yield* adapter.sendTurn({ threadId, input: 'unknown', attachments: [] })
      yield* waitForEvent(
        events,
        (event) => event.type === 'turn.completed' && event.turnId === unknown.turnId,
      )
      const unknownCompletion = events.find(
        (event) => event.type === 'turn.completed' && event.turnId === unknown.turnId,
      )
      expect(unknownCompletion && eventPayload(unknownCompletion).state).toBe('failed')
      expect(unknownCompletion && eventPayload(unknownCompletion).errorMessage).toContain(
        'unexpected terminal status',
      )
      const session = (yield* adapter.listSessions()).find((entry) => entry.threadId === threadId)
      expect(session?.status).toBe('error')
      yield* adapter.stopSession(threadId)
      yield* Fiber.interrupt(eventFiber)
    }).pipe(TestClock.withLive, Effect.timeout('10 seconds')),
  )

  it.effect(
    'interrupts without closing the logical session and resumes the exact conversation',
    () =>
      Effect.gen(function* ()
      {
        runtimeHarness.scripts.push({
          conversationId: 'conv-interrupt',
          turns: [
            turn(
              [],
              result({ status: 'SUCCESS', conversationId: 'conv-interrupt', response: 'never' }),
              true,
            ),
            turn(
              [],
              result({ status: 'SUCCESS', conversationId: 'conv-interrupt', response: 'resumed' }),
            ),
          ],
        })
        const adapter = yield* makeAdapter()
        const threadId = ThreadId.make('antigravity-adapter-interrupt')
        const events: Array<ProviderRuntimeEvent> = []
        const activeTurnIdsAtCompletion = new Map<string, unknown>()
        const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.gen(function* ()
          {
            events.push(event.event)
            if (event.event.type === 'turn.completed')
            {
              const session = (yield* adapter.listSessions()).find(
                (entry) => entry.threadId === threadId,
              )
              activeTurnIdsAtCompletion.set(String(event.event.turnId), session?.activeTurnId)
            }
          }),
        ).pipe(Effect.forkChild)
        const session = yield* adapter.startSession(startInput(threadId))
        const interrupted = yield* adapter.sendTurn({
          threadId,
          input: 'interrupt-me',
          attachments: [],
        })
        yield* Effect.sleep('5 millis')
        yield* adapter.interruptTurn(threadId, interrupted.turnId)
        yield* waitForEvent(
          events,
          (event) => event.type === 'turn.completed' && event.turnId === interrupted.turnId,
        )
        const interruptedCompletion = events.find(
          (event) => event.type === 'turn.completed' && event.turnId === interrupted.turnId,
        )
        expect(interruptedCompletion && eventPayload(interruptedCompletion).state).toBe(
          'interrupted',
        )
        expect(activeTurnIdsAtCompletion.get(String(interrupted.turnId))).toBeUndefined()
        expect(yield* adapter.hasSession(threadId)).toBe(true)
        const resumed = yield* adapter.sendTurn({ threadId, input: 'resume-me', attachments: [] })
        yield* waitForEvent(
          events,
          (event) => event.type === 'turn.completed' && event.turnId === resumed.turnId,
        )
        const resumedCompletion = events.find(
          (event) => event.type === 'turn.completed' && event.turnId === resumed.turnId,
        )
        expect(resumedCompletion && eventPayload(resumedCompletion).state).toBe('completed')
        expect(session.resumeCursor).toEqual({
          schemaVersion: 2,
          conversationId: 'conv-interrupt',
          binding: defaultCursorBinding,
        })
        expect(
          (yield* adapter.listSessions()).find((entry) => entry.threadId === threadId)
            ?.resumeCursor,
        ).toEqual({
          schemaVersion: 2,
          conversationId: 'conv-interrupt',
          binding: defaultCursorBinding,
        })
        yield* adapter.stopSession(threadId)
        yield* Fiber.interrupt(eventFiber)
      }).pipe(TestClock.withLive, Effect.timeout('10 seconds')),
  )
})
