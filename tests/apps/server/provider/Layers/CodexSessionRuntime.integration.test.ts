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
import * as Schema from 'effect/Schema'

import { makeCodexSessionRuntime } from '../../../../../apps/server/src/provider/Layers/CodexSessionRuntime.ts'

const peerPath = NodePath.join(
  import.meta.dirname,
  '../testFixtures/codexQueuedFollowupMockPeer.mjs',
)
const decodeInterruptRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      threadId: Schema.optional(Schema.String),
      turnId: Schema.optional(Schema.String),
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
})
