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
})
