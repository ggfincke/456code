// tests/apps/server/textGeneration/AntigravityTextGeneration.test.ts
// verifies isolated official antigravity helpers and fail-closed tool boundaries

// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off

import * as NodeServices from '@effect/platform-node/NodeServices'
import { expect, it } from '@effect/vitest'
import { ProviderInstanceId } from '@t3tools/contracts'
import { createModelSelection } from '@t3tools/shared/model'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'

import {
  makeAntigravityTextGeneration,
  type AntigravityTextGenerationOptions,
} from '../../../../apps/server/src/textGeneration/AntigravityTextGeneration.ts'

type Runtime = Effect.Success<ReturnType<AntigravityTextGenerationOptions['makeRuntime']>>
const sessionId = '123e4567-e89b-42d3-a456-426614174000'
const modelSelection = createModelSelection(ProviderInstanceId.make('antigravity'), 'test-model')
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const makeHarness = Effect.fn('AntigravityTextGenerationTest.makeHarness')(function* (
  mode: 'success' | 'tool' | 'oversized' = 'success',
)
{
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const profileDirectory = yield* fs.makeTempDirectoryScoped({
    prefix: '456code-agy-text-profile-',
  })
  const launches: string[] = []
  const prompts: string[] = []
  let closed = 0
  let onUpdate: Parameters<Runtime['handleSessionUpdate']>[0] | undefined
  let onRead: Parameters<Runtime['handleReadTextFile']>[0] | undefined
  const runtime: Runtime = {
    start: () =>
      Effect.succeed({
        sessionId,
        initializeResult: { protocolVersion: 1 },
        sessionSetupResult: { sessionId },
        modelConfigId: 'model',
      }),
    setMode: () => Effect.succeed({}),
    getConfigOptions: Effect.succeed([
      {
        id: 'model',
        name: 'Model',
        type: 'select',
        category: 'model',
        currentValue: 'test-model',
        options: [{ value: 'test-model', name: 'Test model' }],
      },
    ]),
    setModel: () => Effect.void,
    getEvents: () => Stream.empty,
    cancel: Effect.void,
    handleSessionUpdate: (handler) =>
      Effect.sync(() =>
      {
        onUpdate = handler
      }),
    handleReadTextFile: (handler) =>
      Effect.sync(() =>
      {
        onRead = handler
      }),
    handleWriteTextFile: () => Effect.void,
    handleRequestPermission: () => Effect.void,
    handleElicitation: () => Effect.void,
    handleCreateTerminal: () => Effect.void,
    handleTerminalOutput: () => Effect.void,
    handleTerminalWaitForExit: () => Effect.void,
    handleTerminalKill: () => Effect.void,
    handleTerminalRelease: () => Effect.void,
    handleUnknownExtRequest: () => Effect.void,
    prompt: (input) =>
      Effect.gen(function* ()
      {
        prompts.push(
          input.prompt.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n'),
        )
        if (mode === 'tool')
        {
          if (onRead === undefined) return yield* Effect.die('Read guard was not installed')
          yield* onRead({ sessionId, path: path.join(profileDirectory, 'secret') })
        }
        if (onUpdate === undefined) return yield* Effect.die('Update listener was not installed')
        yield* onUpdate({
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text:
                mode === 'oversized'
                  ? 'x'.repeat(128_001)
                  : encodeJson({
                      subject: 'Use isolated helpers',
                      body: 'Keep the workspace untouched.',
                    }),
            },
          },
        })
        return { stopReason: 'end_turn' as const }
      }),
  }
  const service = yield* makeAntigravityTextGeneration({
    profileDirectory,
    makeRuntime: (cwd) =>
      Effect.gen(function* ()
      {
        launches.push(cwd)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() =>
          {
            closed += 1
          }),
        )
        return runtime
      }),
    withProcess: (_stop, task) => task,
  })
  return { service, profileDirectory, launches, prompts, closed: () => closed }
})

function commitInput()
{
  return {
    cwd: '/never-provide-the-user-workspace',
    branch: 'feature/antigravity',
    stagedSummary: 'M example.ts',
    stagedPatch: 'diff --git a/example.ts b/example.ts',
    modelSelection,
  }
}

it.layer(NodeServices.layer)('AntigravityTextGeneration', (it) =>
{
  it.effect(
    'runs a short-lived official helper outside the user workspace and decodes its JSON',
    () =>
      Effect.gen(function* ()
      {
        const fs = yield* FileSystem.FileSystem
        const h = yield* makeHarness()
        expect(yield* h.service.generateCommitMessage(commitInput())).toEqual({
          subject: 'Use isolated helpers',
          body: 'Keep the workspace untouched.',
        })
        expect(h.launches).toHaveLength(1)
        expect(h.launches[0]).not.toBe(commitInput().cwd)
        expect(h.prompts[0]).toContain('Do not use tools')
        expect(h.prompts[0]).toContain('diff --git')
        expect(h.closed()).toBe(1)
        expect(yield* fs.exists(h.launches[0]!)).toBe(false)
      }),
  )

  it.effect('fails closed for tool requests and oversized output while closing the helper', () =>
    Effect.gen(function* ()
    {
      for (const mode of ['tool', 'oversized'] as const)
      {
        const h = yield* makeHarness(mode)
        const error = yield* Effect.flip(h.service.generateCommitMessage(commitInput()))
        expect(error._tag).toBe('TextGenerationError')
        expect(error.detail).toMatch(mode === 'tool' ? /tool|user input/i : /output limit/i)
        expect(h.closed()).toBe(1)
      }
    }),
  )

  it.effect('does not launch helpers for unsafe global hooks, including attachment metadata', () =>
    Effect.gen(function* ()
    {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const h = yield* makeHarness()
      yield* fs.makeDirectory(path.join(h.profileDirectory, 'config'), { recursive: true })
      yield* fs.writeFileString(
        path.join(h.profileDirectory, 'config', 'hooks.json'),
        encodeJson({ hooks: { startup: 'command' } }),
      )
      expect((yield* Effect.flip(h.service.generateCommitMessage(commitInput()))).detail).toMatch(
        /global hooks|MCP/i,
      )
      expect(
        (yield* Effect.flip(
          h.service.generateThreadTitle({
            cwd: commitInput().cwd,
            message: 'Name this thread',
            attachments: [
              {
                type: 'image',
                id: 'image-1',
                name: 'image.png',
                mimeType: 'image/png',
                sizeBytes: 42,
              },
            ],
            modelSelection,
          }),
        )).detail,
      ).toMatch(/global hooks|MCP/i)
      expect(h.launches).toEqual([])
    }),
  )
})
