// tests/apps/server/provider/Layers/CodexSessionRuntime.integration.test.ts
// verifies codex session lifecycle against a scripted app-server peer

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'

import * as NodeServices from '@effect/platform-node/NodeServices'
import { ThreadId } from '@t3tools/contracts'
import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'

import { makeCodexSessionRuntime } from '../../../../../apps/server/src/provider/Layers/CodexSessionRuntime.ts'

const peerPath = NodePath.join(
  import.meta.dirname,
  '../testFixtures/codexQueuedFollowupMockPeer.mjs',
)
const approvalPeerPath = NodePath.join(
  import.meta.dirname,
  '../testFixtures/codexApprovalMockPeer.mjs',
)
const childMetadataPeerPath = NodePath.join(
  import.meta.dirname,
  '../testFixtures/codexChildMetadataMockPeer.mjs',
)
const decodeInterruptRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      threadId: Schema.optional(Schema.String),
      turnId: Schema.optional(Schema.String),
    }),
  ),
)
const decodeApprovalRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.Number,
      result: Schema.Unknown,
      error: Schema.optional(Schema.Unknown),
    }),
  ),
)
const decodeChildMetadataLookup = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      threadId: Schema.String,
      excludeTurns: Schema.Boolean,
    }),
  ),
)

function readChildMetadataLookups(path: string)
{
  if (!NodeFS.existsSync(path))
  {
    return []
  }
  return NodeFS.readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => decodeChildMetadataLookup(line))
}

describe('CodexSessionRuntime integration', () =>
{
  it.effect('keeps Stop targeted at the active turn when a follow-up is queued', () =>
    Effect.gen(function* ()
    {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'codex-followup-stop-'))
      const recordPath = NodePath.join(tempDir, 'interrupt.json')
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
      )

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make('thread-queued-followup'),
        binaryPath: peerPath,
        cwd: tempDir,
        runtimeMode: 'full-access',
        environment: {
          ...process.env,
          CODEX_QUEUED_FOLLOWUP_RECORD_PATH: recordPath,
        },
      })

      yield* runtime.start()
      const activeTurn = yield* runtime.sendTurn({ input: 'start the active turn' })
      const queuedTurn = yield* runtime.sendTurn({ input: 'queue this follow-up' })
      const session = yield* runtime.getSession

      assert.equal(String(activeTurn.turnId), 'turn-active')
      assert.equal(String(queuedTurn.turnId), 'turn-queued')
      assert.equal(String(session.activeTurnId), 'turn-active')

      yield* runtime.interruptTurn()
      const interrupt = decodeInterruptRecord(NodeFS.readFileSync(recordPath, 'utf8'))
      assert.equal(interrupt.threadId, 'provider-thread-queued-followup')
      assert.equal(interrupt.turnId, 'turn-active')

      yield* runtime.close
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.effect('correlates MCP elicitation resolution notifications to the open request', () =>
    Effect.gen(function* ()
    {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'codex-elicitation-'))
      const recordPath = NodePath.join(tempDir, 'response.json')
      const controlPath = NodePath.join(tempDir, 'correlation.txt')
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
      )

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make('thread-mcp-correlation'),
        binaryPath: approvalPeerPath,
        cwd: tempDir,
        runtimeMode: 'auto',
        environment: {
          ...process.env,
          T3_CODEX_APPROVAL_CONTROL_PATH: controlPath,
          T3_CODEX_APPROVAL_PRE_RESOLVE: '1',
          T3_CODEX_APPROVAL_RECORD_PATH: recordPath,
        },
      })
      const openedFiber = yield* Stream.runHead(runtime.events).pipe(Effect.forkChild)
      yield* runtime.start()
      const opened = yield* Fiber.join(openedFiber)
      assert.equal(opened._tag, 'Some')
      if (opened._tag !== 'Some' || opened.value.requestId === undefined)
      {
        return
      }
      assert.equal(opened.value.method, 'mcpServer/elicitation/request')
      assert.equal(opened.value.requestKind, 'mcp-elicitation')

      const correlatedFiber = yield* runtime.events.pipe(
        Stream.filter((event) => event.method === 'serverRequest/resolved'),
        Stream.runHead,
        Effect.forkChild,
      )
      NodeFS.writeFileSync(controlPath, String(opened.value.requestId), 'utf8')
      const correlated = yield* Fiber.join(correlatedFiber)
      assert.equal(correlated._tag, 'Some')
      if (correlated._tag === 'Some')
      {
        assert.equal(correlated.value.requestId, opened.value.requestId)
        assert.equal(correlated.value.requestKind, 'mcp-elicitation')
      }

      const settledFiber = yield* runtime.events.pipe(
        Stream.filter((event) => event.method === 'serverRequest/resolved'),
        Stream.runHead,
        Effect.forkChild,
      )
      yield* runtime.respondToRequest(opened.value.requestId, 'decline')
      const settled = yield* Fiber.join(settledFiber)
      assert.equal(settled._tag, 'Some')
      yield* runtime.close
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.effect('cleans MCP elicitation pending and correlation state in the request finalizer', () =>
    Effect.gen(function* ()
    {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'codex-elicitation-'))
      const recordPath = NodePath.join(tempDir, 'response.json')
      const controlPath = NodePath.join(tempDir, 'correlation.txt')
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
      )

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make('thread-mcp-finalizer'),
        binaryPath: approvalPeerPath,
        cwd: tempDir,
        runtimeMode: 'auto',
        environment: {
          ...process.env,
          T3_CODEX_APPROVAL_CONTROL_PATH: controlPath,
          T3_CODEX_APPROVAL_RECORD_PATH: recordPath,
        },
      })
      const openedFiber = yield* Stream.runHead(runtime.events).pipe(Effect.forkChild)
      yield* runtime.start()
      const opened = yield* Fiber.join(openedFiber)
      assert.equal(opened._tag, 'Some')
      if (opened._tag !== 'Some' || opened.value.requestId === undefined)
      {
        return
      }
      NodeFS.writeFileSync(controlPath, String(opened.value.requestId), 'utf8')

      const finalizedFiber = yield* runtime.events.pipe(
        Stream.filter((event) => event.method === 'serverRequest/resolved'),
        Stream.runHead,
        Effect.forkChild,
      )
      yield* runtime.respondToRequest(opened.value.requestId, 'acceptAlways')
      const finalized = yield* Fiber.join(finalizedFiber)
      assert.equal(finalized._tag, 'Some')
      if (finalized._tag === 'Some')
      {
        assert.isUndefined(finalized.value.requestId)
        assert.isUndefined(finalized.value.requestKind)
      }

      const duplicateError = yield* Effect.flip(
        runtime.respondToRequest(opened.value.requestId, 'accept'),
      )
      assert.equal(duplicateError._tag, 'CodexSessionRuntimePendingApprovalNotFoundError')
      assert.deepEqual(decodeApprovalRecord(NodeFS.readFileSync(recordPath, 'utf8')).result, {
        action: 'accept',
        _meta: { persist: 'always' },
        content: { approval: 'always' },
      })

      yield* runtime.close
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.effect('maps accept-always command and file approvals to accept-for-session on the wire', () =>
    Effect.gen(function* ()
    {
      for (const approval of [
        {
          method: 'item/commandExecution/requestApproval',
          requestKind: 'command',
          threadId: 'thread-command-approval',
        },
        {
          method: 'item/fileChange/requestApproval',
          requestKind: 'file-change',
          threadId: 'thread-file-approval',
        },
      ] as const)
      {
        yield* Effect.gen(function* ()
        {
          const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'codex-approval-'))
          const recordPath = NodePath.join(tempDir, 'response.json')
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
          )
          const runtime = yield* makeCodexSessionRuntime({
            threadId: ThreadId.make(approval.threadId),
            binaryPath: approvalPeerPath,
            cwd: tempDir,
            runtimeMode: 'auto',
            environment: {
              ...process.env,
              T3_CODEX_APPROVAL_METHOD: approval.method,
              T3_CODEX_APPROVAL_RECORD_PATH: recordPath,
            },
          })
          const openedFiber = yield* Stream.runHead(runtime.events).pipe(Effect.forkChild)
          yield* runtime.start()
          const opened = yield* Fiber.join(openedFiber)
          assert.equal(opened._tag, 'Some')
          if (opened._tag !== 'Some' || opened.value.requestId === undefined)
          {
            yield* runtime.close
            return
          }
          assert.equal(opened.value.requestKind, approval.requestKind)

          const responseRecordedFiber = yield* runtime.events.pipe(
            Stream.filter((event) => event.method === 'serverRequest/resolved'),
            Stream.runHead,
            Effect.forkChild,
          )
          yield* runtime.respondToRequest(opened.value.requestId, 'acceptAlways')
          yield* Fiber.join(responseRecordedFiber)
          assert.deepEqual(decodeApprovalRecord(NodeFS.readFileSync(recordPath, 'utf8')).result, {
            decision: 'acceptForSession',
          })

          yield* runtime.close
        }).pipe(Effect.scoped)
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.effect('uses parent child metadata without resuming an already-described child', () =>
    Effect.gen(function* ()
    {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'codex-child-seeded-'))
      const recordPath = NodePath.join(tempDir, 'lookups.jsonl')
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
      )

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make('thread-child-metadata-seeded'),
        binaryPath: childMetadataPeerPath,
        cwd: tempDir,
        runtimeMode: 'full-access',
        environment: {
          ...process.env,
          CODEX_CHILD_METADATA_RECORD_PATH: recordPath,
          CODEX_CHILD_METADATA_SCENARIO: 'seeded',
        },
      })
      const eventsFiber = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.method === 'turn/completed'),
        Stream.runCollect,
        Effect.forkScoped,
      )

      yield* runtime.start()
      yield* runtime.sendTurn({ input: 'start a described child' })
      const events = Array.from(yield* Fiber.join(eventsFiber))
      const metadataPayloads = events.flatMap((event) =>
        event.method === 'collabAgent/metadataUpdated'
          ? [event.payload as Record<string, unknown>]
          : [],
      )

      assert.deepEqual(readChildMetadataLookups(recordPath), [])
      assert.deepEqual(metadataPayloads.at(-1), {
        model: 'requested-model',
        effort: 'medium',
      })

      yield* runtime.close
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.effect('buffers logger-only v0.150 settings and stabilizes subAgentActivity identity', () =>
    Effect.gen(function* ()
    {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'codex-subagent-activity-'))
      const recordPath = NodePath.join(tempDir, 'lookups.jsonl')
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
      )

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make('thread-subagent-activity'),
        binaryPath: childMetadataPeerPath,
        cwd: tempDir,
        runtimeMode: 'full-access',
        environment: {
          ...process.env,
          CODEX_CHILD_METADATA_RECORD_PATH: recordPath,
          CODEX_CHILD_METADATA_SCENARIO: 'subagent-activity',
        },
      })
      const eventsFiber = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.method === 'turn/completed'),
        Stream.runCollect,
        Effect.forkScoped,
      )

      yield* runtime.start()
      yield* runtime.sendTurn({ input: 'spawn one child' })
      const events = Array.from(yield* Fiber.join(eventsFiber))
      const metadataEvents = events.filter(
        (event) => event.method === 'collabAgent/metadataUpdated',
      )
      const subAgentLifecycleEvents = events.filter((event) =>
      {
        const payload = event.payload as
          { readonly item?: { readonly type?: string; readonly id?: string } } | undefined
        return payload?.item?.type === 'subAgentActivity'
      })

      assert.deepEqual(readChildMetadataLookups(recordPath), [])
      assert.deepEqual(
        [...new Set(subAgentLifecycleEvents.map((event) => String(event.itemId)))],
        ['provider-thread-child'],
      )
      assert.deepEqual(
        [
          ...new Set(
            subAgentLifecycleEvents.map((event) =>
            {
              const payload = event.payload as { readonly item: { readonly id: string } }
              return payload.item.id
            }),
          ),
        ],
        ['call-spawn-child', 'subagent-completed-child-turn'],
      )
      assert.deepEqual(metadataEvents.at(-1)?.payload, {
        model: 'gpt-5.6-sol',
        effort: 'low',
      })
      assert.lengthOf(metadataEvents, 1)
      assert.equal(String(metadataEvents.at(-1)?.itemId), 'provider-thread-child')
      assert.isFalse(events.some((event) => event.method === 'thread/settings/updated'))
      assert.isFalse(metadataEvents.some((event) => String(event.itemId) === 'call-wait-empty'))

      yield* runtime.close
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.effect('retries a timed-out child resume once after terminal subAgentActivity', () =>
    Effect.gen(function* ()
    {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'codex-child-retry-'))
      const recordPath = NodePath.join(tempDir, 'lookups.jsonl')
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
      )

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make('thread-child-metadata-retry'),
        binaryPath: childMetadataPeerPath,
        cwd: tempDir,
        runtimeMode: 'full-access',
        environment: {
          ...process.env,
          CODEX_CHILD_METADATA_RECORD_PATH: recordPath,
          CODEX_CHILD_METADATA_SCENARIO: 'resume-after-terminal',
        },
      })
      const eventsFiber = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.method === 'turn/completed'),
        Stream.runCollect,
        Effect.forkScoped,
      )

      yield* runtime.start()
      yield* runtime.sendTurn({ input: 'spawn a child whose first resume stalls' })
      const events = Array.from(yield* Fiber.join(eventsFiber))
      const metadataEvents = events.filter(
        (event) => event.method === 'collabAgent/metadataUpdated',
      )
      const subAgentLifecycleEvents = events.filter((event) =>
      {
        const payload = event.payload as { readonly item?: { readonly type?: string } } | undefined
        return payload?.item?.type === 'subAgentActivity'
      })

      assert.deepEqual(readChildMetadataLookups(recordPath), [
        { threadId: 'provider-thread-child', excludeTurns: true },
        { threadId: 'provider-thread-child', excludeTurns: true },
      ])
      assert.deepEqual(
        [...new Set(subAgentLifecycleEvents.map((event) => String(event.itemId)))],
        ['provider-thread-child'],
      )
      assert.lengthOf(metadataEvents, 1)
      assert.equal(String(metadataEvents[0]?.itemId), 'provider-thread-child')
      assert.deepEqual(metadataEvents[0]?.payload, {
        model: 'gpt-5.6-sol',
        effort: 'low',
      })

      yield* runtime.close
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.effect('looks up partial child metadata once while live settings and reroutes win', () =>
    Effect.gen(function* ()
    {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'codex-child-metadata-'))
      const recordPath = NodePath.join(tempDir, 'lookups.jsonl')
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
      )

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make('thread-child-metadata-live'),
        binaryPath: childMetadataPeerPath,
        cwd: tempDir,
        runtimeMode: 'full-access',
        environment: {
          ...process.env,
          CODEX_CHILD_METADATA_RECORD_PATH: recordPath,
          CODEX_CHILD_METADATA_SCENARIO: 'live-wins',
        },
      })
      const eventsFiber = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.method === 'turn/completed'),
        Stream.runCollect,
        Effect.forkScoped,
      )

      yield* runtime.start()
      yield* runtime.sendTurn({ input: 'start a child' })
      const events = Array.from(yield* Fiber.join(eventsFiber))
      const metadataEvents = events.filter(
        (event) => event.method === 'collabAgent/metadataUpdated',
      )
      const latestMetadata = metadataEvents.at(-1)?.payload as Record<string, unknown> | undefined

      assert.deepEqual(readChildMetadataLookups(recordPath), [
        { threadId: 'provider-thread-child', excludeTurns: true },
      ])
      assert.deepEqual(latestMetadata, { model: 'rerouted-model', effort: null })
      assert.equal(String(metadataEvents.at(-1)?.itemId), 'collab-child-metadata')
      assert.isFalse(
        metadataEvents.some(
          (event) =>
            (event.payload as Record<string, unknown> | undefined)?.model === 'stale-snapshot',
        ),
      )
      assert.isFalse(
        events.some(
          (event) =>
            (event.method === 'thread/settings/updated' || event.method === 'model/rerouted') &&
            (event.payload as { threadId?: string } | undefined)?.threadId ===
              'provider-thread-child',
        ),
      )

      yield* runtime.close
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.effect('blocks a closed child snapshot and accepts metadata after reopen', () =>
    Effect.gen(function* ()
    {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'codex-child-reopen-'))
      const recordPath = NodePath.join(tempDir, 'lookups.jsonl')
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
      )

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make('thread-child-metadata-reopen'),
        binaryPath: childMetadataPeerPath,
        cwd: tempDir,
        runtimeMode: 'full-access',
        environment: {
          ...process.env,
          CODEX_CHILD_METADATA_RECORD_PATH: recordPath,
          CODEX_CHILD_METADATA_SCENARIO: 'close-reopen',
        },
      })
      const eventsFiber = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.method === 'turn/completed'),
        Stream.runCollect,
        Effect.forkScoped,
      )

      yield* runtime.start()
      yield* runtime.sendTurn({ input: 'reopen a child' })
      const events = Array.from(yield* Fiber.join(eventsFiber))
      const metadataPayloads = events.flatMap((event) =>
        event.method === 'collabAgent/metadataUpdated'
          ? [event.payload as Record<string, unknown>]
          : [],
      )

      assert.deepEqual(readChildMetadataLookups(recordPath), [
        { threadId: 'provider-thread-child', excludeTurns: true },
      ])
      assert.deepEqual(metadataPayloads.at(-1), { model: 'reopened-model', effort: 'xhigh' })
      assert.isFalse(metadataPayloads.some((payload) => payload.model === 'closed-snapshot'))

      yield* runtime.close
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})
