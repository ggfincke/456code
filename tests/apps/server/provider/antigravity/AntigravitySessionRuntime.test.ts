// tests/apps/server/provider/antigravity/AntigravitySessionRuntime.test.ts
// verifies one bounded resume with exact conversation continuity and no replay

import * as NodeServices from '@effect/platform-node/NodeServices'
import { it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'
import * as TestClock from 'effect/testing/TestClock'
import { expect } from 'vite-plus/test'

import {
  makeAntigravitySessionRuntime,
  type AntigravitySessionRuntimeOptions,
  type AntigravitySessionRuntimeShape,
} from '../../../../../apps/server/src/provider/antigravity/AntigravitySessionRuntime.ts'

const decodeStringArray = Schema.decodeUnknownSync(Schema.Array(Schema.String))

it.layer(NodeServices.layer)('AntigravitySessionRuntime', (it) =>
{
  it.effect('respawns once with the exact conversation and never replays a turn', () =>
    Effect.gen(function* ()
    {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: 'antigravity-runtime-' })
      const binary = path.join(root, 'agy-mock.mjs')
      const state = path.join(root, 'state')
      const argsLog = path.join(root, 'args.log')
      const inputLog = path.join(root, 'input.log')
      yield* fileSystem.writeFileString(state, '0')
      yield* fileSystem.writeFileString(inputLog, '')
      yield* fileSystem.writeFileString(
        binary,
        `#!/usr/bin/env node
import fs from 'node:fs'

const statePath = process.env.AGY_STATE
const argsPath = process.env.AGY_ARGS
const inputPath = process.env.AGY_INPUT
let phase = fs.readFileSync(statePath, 'utf8').trim()
fs.appendFileSync(argsPath, JSON.stringify(process.argv.slice(2)) + '\\n')
process.stdout.write(JSON.stringify({ event: 'init', conversation_id: 'conv-1', init: {} }) + '\\n')
if (phase === 'idle') {
  fs.writeFileSync(statePath, 'idle-recovered')
  setTimeout(() => process.exit(1), 100)
}
let remainder = ''
process.stdin.on('data', (chunk) => {
  remainder += chunk.toString('utf8')
  const lines = remainder.split('\\n')
  remainder = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    const message = JSON.parse(line)
    const text = message?.message?.content
    fs.appendFileSync(inputPath, text + '\\n')
    if (phase === '0' && text === 'first') {
      fs.writeFileSync(statePath, '1')
      process.exit(1)
    }
    if (phase === '1' && text === 'second') {
      fs.writeFileSync(statePath, '2')
      phase = '2'
      process.stdout.write(JSON.stringify({ event: 'result', result: { conversation_id: 'conv-1', status: 'SUCCESS', response: 'ok' } }) + '\\n')
    }
    if (phase === '2' && text === 'third') {
      fs.writeFileSync(statePath, '3')
      process.exit(1)
    }
    if (phase === 'timeout' && text === 'timeout') {
      fs.writeFileSync(statePath, 'timeout-recovered')
    }
    if (phase === 'interrupt' && text === 'interrupt') {
      fs.writeFileSync(statePath, 'interrupt-recovered')
    }
  }
})
`,
      )
      yield* fileSystem.chmod(binary, 0o755)

      const options: AntigravitySessionRuntimeOptions = {
        binaryPath: binary,
        cwd: root,
        runtimeMode: 'auto-accept-edits',
        sandbox: true,
        environment: { ...process.env, AGY_STATE: state, AGY_ARGS: argsLog, AGY_INPUT: inputLog },
      }
      const runtimeFactory = makeAntigravitySessionRuntime as unknown as (
        options: AntigravitySessionRuntimeOptions,
      ) => Effect.Effect<AntigravitySessionRuntimeShape, never, never>
      const runtime = yield* runtimeFactory(options).pipe(Effect.timeout('20 seconds'))
      const first = yield* runtime.sendTurn('first').pipe(Effect.timeout('20 seconds'))
      expect(first.status).toBe('ERROR')
      expect(first.error).toContain('not replayed')

      const second = yield* runtime.sendTurn('second').pipe(Effect.timeout('20 seconds'))
      expect(second.status).toBe('SUCCESS')
      expect(yield* runtime.isLive).toBe(true)

      yield* runtime.close

      const args = (yield* fileSystem.readFileString(argsLog))
        .trim()
        .split('\n')
        .map((line) => decodeStringArray(JSON.parse(line)))
      expect(args).toHaveLength(2)
      expect(args[0]).not.toContain('--conversation')
      expect(args[1]).toContain('--conversation')
      expect(args[1]).toContain('conv-1')

      yield* fileSystem.writeFileString(state, 'idle')
      const idleRuntime = yield* runtimeFactory(options).pipe(Effect.timeout('20 seconds'))
      yield* Effect.sleep('500 millis').pipe(TestClock.withLive)
      expect(yield* idleRuntime.isLive).toBe(true)
      yield* idleRuntime.close

      yield* fileSystem.writeFileString(state, 'interrupt')
      yield* fileSystem.writeFileString(inputLog, '')
      const interruptRuntime = yield* runtimeFactory(options).pipe(Effect.timeout('20 seconds'))
      const interruptedFiber = yield* interruptRuntime.sendTurn('interrupt').pipe(Effect.forkScoped)
      yield* Effect.sleep('500 millis').pipe(TestClock.withLive)
      expect(yield* fileSystem.readFileString(inputLog)).toContain('interrupt')
      expect(yield* interruptRuntime.isLive).toBe(true)
      yield* interruptRuntime.interrupt
      const interrupted = yield* Fiber.join(interruptedFiber)
      expect(interrupted.status).toBe('ERROR')
      yield* Effect.sleep('500 millis').pipe(TestClock.withLive)
      const inputLines = (yield* fileSystem.readFileString(inputLog))
        .trim()
        .split('\n')
        .filter(Boolean)
      expect(inputLines).toEqual(['interrupt'])
      const interruptArgs = (yield* fileSystem.readFileString(argsLog))
        .trim()
        .split('\n')
        .map((line) => decodeStringArray(JSON.parse(line)))
      expect(interruptArgs.at(-1)).toContain('conv-1')
      yield* interruptRuntime.close
    }),
  )

  it.effect('fails startup immediately on a pre-init terminal model error', () =>
    Effect.gen(function* ()
    {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: 'antigravity-startup-error-',
      })
      const binary = path.join(root, 'agy-mock.mjs')
      yield* fileSystem.writeFileString(
        binary,
        `#!/usr/bin/env node
process.stderr.write('agy rejected the model\\n')
process.stdout.write(JSON.stringify({ event: 'result', result: { conversation_id: '', status: 'ERROR', response: '', error: 'invalid model selection' } }) + '\\n')
setTimeout(() => {}, 1000)
`,
      )
      yield* fileSystem.chmod(binary, 0o755)

      const startup = yield* Effect.result(
        makeAntigravitySessionRuntime({
          binaryPath: binary,
          cwd: root,
          model: 'opaque-model',
          runtimeMode: 'auto-accept-edits',
          sandbox: true,
        }),
      ).pipe(Effect.timeout('5 seconds'))
      expect(startup._tag).toBe('Failure')
      if (startup._tag === 'Failure')
      {
        expect(startup.failure.detail).toContain('invalid model selection')
        expect(startup.failure.detail).toContain('agy rejected the model')
      }
    }),
  )

  it.effect('preserves native errors without a conversation id and rejects mismatches', () =>
    Effect.gen(function* ()
    {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: 'antigravity-result-errors-',
      })
      const binary = path.join(root, 'agy-mock.mjs')
      yield* fileSystem.writeFileString(
        binary,
        `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ event: 'init', conversation_id: 'conv-errors', init: {} }) + '\\n')
let remainder = ''
process.stdin.on('data', (chunk) => {
  remainder += chunk.toString('utf8')
  const lines = remainder.split('\\n')
  remainder = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    const result = process.env.AGY_RESULT_MODE === 'empty'
      ? { conversation_id: '', status: 'INVALID', response: '', error: 'native empty id error' }
      : process.env.AGY_RESULT_MODE === 'mismatch'
        ? { conversation_id: 'different-conversation', status: 'ERROR', response: '', error: 'native mismatched id error' }
        : { status: 'ERROR', response: '', error: 'native missing id error' }
    process.stdout.write(JSON.stringify({ event: 'result', result }) + '\\n')
  }
})
`,
      )
      yield* fileSystem.chmod(binary, 0o755)

      const baseOptions = {
        binaryPath: binary,
        cwd: root,
        runtimeMode: 'auto-accept-edits' as const,
        sandbox: true,
      }
      const missingRuntime = yield* makeAntigravitySessionRuntime({
        ...baseOptions,
        environment: { ...process.env, AGY_RESULT_MODE: 'missing' },
      })
      const missing = yield* missingRuntime.sendTurn('missing').pipe(Effect.timeout('5 seconds'))
      expect(missing.status).toBe('ERROR')
      expect(missing.error).toBe('native missing id error')
      yield* missingRuntime.close

      const emptyRuntime = yield* makeAntigravitySessionRuntime({
        ...baseOptions,
        environment: { ...process.env, AGY_RESULT_MODE: 'empty' },
      })
      const empty = yield* emptyRuntime.sendTurn('empty').pipe(Effect.timeout('5 seconds'))
      expect(empty.status).toBe('INVALID')
      expect(empty.error).toBe('native empty id error')
      yield* emptyRuntime.close

      const mismatchRuntime = yield* makeAntigravitySessionRuntime({
        ...baseOptions,
        environment: { ...process.env, AGY_RESULT_MODE: 'mismatch' },
      })
      const mismatch = yield* mismatchRuntime.sendTurn('mismatch').pipe(Effect.timeout('5 seconds'))
      expect(mismatch.status).toBe('ERROR')
      expect(mismatch.error).toContain("instead of 'conv-errors'")
      yield* mismatchRuntime.close
    }),
  )

  it.effect('fails a resumed startup immediately on an incompatible init id', () =>
    Effect.gen(function* ()
    {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: 'antigravity-resume-mismatch-',
      })
      const binary = path.join(root, 'agy-mock.mjs')
      yield* fileSystem.writeFileString(
        binary,
        `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ event: 'init', conversation_id: 'actual-conversation', init: {} }) + '\\n')
setTimeout(() => {}, 1000)
`,
      )
      yield* fileSystem.chmod(binary, 0o755)

      const startup = yield* Effect.result(
        makeAntigravitySessionRuntime({
          binaryPath: binary,
          cwd: root,
          runtimeMode: 'auto-accept-edits',
          sandbox: true,
          resumeCursor: {
            schemaVersion: 2,
            conversationId: 'expected-conversation',
            binding: {
              workspace: root,
              executable: binary,
              model: 'default',
              agent: '',
              runtimeMode: 'auto-accept-edits',
              sandbox: true,
            },
          },
        }),
      ).pipe(Effect.timeout('5 seconds'))
      expect(startup._tag).toBe('Failure')
      if (startup._tag === 'Failure')
      {
        expect(startup.failure.detail).toBe(
          "Antigravity emitted conversation id 'actual-conversation' instead of 'expected-conversation'.",
        )
      }
    }),
  )
})
