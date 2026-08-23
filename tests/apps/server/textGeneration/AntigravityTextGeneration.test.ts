// tests/apps/server/textGeneration/AntigravityTextGeneration.test.ts
// verify isolated Antigravity one-shot JSON generation

// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'

import * as NodeServices from '@effect/platform-node/NodeServices'
import { it } from '@effect/vitest'
import { AntigravitySettings, ProviderInstanceId } from '@t3tools/contracts'
import { createModelSelection } from '@t3tools/shared/model'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { expect } from 'vite-plus/test'

import { makeAntigravityTextGeneration } from '../../../../apps/server/src/textGeneration/AntigravityTextGeneration.ts'

const decodeAntigravitySettings = Schema.decodeSync(AntigravitySettings)

function shellSingleQuote(value: string): string
{
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function makeAntigravityWrapper(input: {
  readonly dir: string
  readonly stdout: string
  readonly stderr?: string
  readonly exitCode?: number
  readonly waitForStdinEof?: boolean
}): { readonly argsPath: string; readonly binaryPath: string }
{
  const argsPath = NodePath.join(input.dir, 'args.json')
  const runnerPath = NodePath.join(input.dir, 'runner.mjs')
  const binaryPath = NodePath.join(input.dir, 'agy')
  NodeFS.writeFileSync(
    runnerPath,
    [
      '#!/usr/bin/env node',
      "import * as NodeFS from 'node:fs'",
      `NodeFS.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)))`,
      ...(input.waitForStdinEof
        ? [
            'process.stdin.resume()',
            "await new Promise((resolve) => process.stdin.once('end', resolve))",
          ]
        : []),
      `process.stdout.write(${JSON.stringify(input.stdout)})`,
      `process.stderr.write(${JSON.stringify(input.stderr ?? '')})`,
      `process.exitCode = ${input.exitCode ?? 0}`,
      '',
    ].join('\n'),
    'utf8',
  )
  NodeFS.chmodSync(runnerPath, 0o755)
  NodeFS.writeFileSync(
    binaryPath,
    [
      '#!/bin/sh',
      `exec ${shellSingleQuote(process.execPath)} ${shellSingleQuote(runnerPath)} "$@"`,
      '',
    ].join('\n'),
    'utf8',
  )
  NodeFS.chmodSync(binaryPath, 0o755)
  return { argsPath, binaryPath }
}

function successEnvelope(response: { readonly subject: string; readonly body: string }): string
{
  return `${JSON.stringify({
    conversation_id: 'antigravity-test-conversation',
    status: 'SUCCESS',
    response: JSON.stringify(response),
  })}\n`
}

function commitInput(model: string)
{
  return {
    cwd: process.cwd(),
    branch: 'feature/antigravity-text-generation',
    stagedSummary: 'M apps/server/src/textGeneration/AntigravityTextGeneration.ts',
    stagedPatch: 'diff --git a/AntigravityTextGeneration.ts b/AntigravityTextGeneration.ts',
    modelSelection: createModelSelection(ProviderInstanceId.make('antigravity'), model),
  }
}

it.layer(NodeServices.layer)('AntigravityTextGeneration', (it) =>
{
  it.effect('invokes agy with the exact JSON one-shot flags and omits the default model', () =>
    Effect.gen(function* ()
    {
      const tempDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), 'antigravity-text-generation-'),
      )
      const wrapper = makeAntigravityWrapper({
        dir: tempDir,
        stdout: successEnvelope({
          subject: 'Use the Antigravity default',
          body: 'The default model is selected by the CLI.',
        }),
        waitForStdinEof: true,
      })
      const textGeneration = yield* makeAntigravityTextGeneration(
        decodeAntigravitySettings({ binaryPath: wrapper.binaryPath, sandbox: true }),
        { PATH: process.env.PATH ?? '' },
      )

      const generated = yield* textGeneration.generateCommitMessage({
        ...commitInput('default'),
      })

      expect(generated).toEqual({
        subject: 'Use the Antigravity default',
        body: 'The default model is selected by the CLI.',
      })
      const args = JSON.parse(
        NodeFS.readFileSync(wrapper.argsPath, 'utf8'),
      ) as ReadonlyArray<string>
      expect(args[0]).toBe('-p')
      expect(args[1]).toContain('Staged patch:')
      expect(args.slice(2)).toEqual(['--output-format', 'json', '--sandbox'])
    }),
  )

  it.effect('passes a non-default model and disables the native sandbox when configured', () =>
    Effect.gen(function* ()
    {
      const tempDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), 'antigravity-text-generation-'),
      )
      const wrapper = makeAntigravityWrapper({
        dir: tempDir,
        stdout: successEnvelope({
          subject: 'Use the selected model',
          body: 'The wrapper received the explicit model.',
        }),
      })
      const textGeneration = yield* makeAntigravityTextGeneration(
        decodeAntigravitySettings({ binaryPath: wrapper.binaryPath, sandbox: false }),
        { PATH: process.env.PATH ?? '' },
      )

      yield* textGeneration.generateCommitMessage({
        ...commitInput('gemini-3.5-flash'),
      })

      const args = JSON.parse(
        NodeFS.readFileSync(wrapper.argsPath, 'utf8'),
      ) as ReadonlyArray<string>
      expect(args.slice(2)).toEqual(['--output-format', 'json', '--model', 'gemini-3.5-flash'])
    }),
  )

  it.effect('decodes a successful terminal envelope and reports CLI terminal errors', () =>
    Effect.gen(function* ()
    {
      const tempDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), 'antigravity-text-generation-'),
      )
      const wrapper = makeAntigravityWrapper({
        dir: tempDir,
        stdout: JSON.stringify({
          conversation_id: 'antigravity-error-conversation',
          status: 'ERROR',
          response: '',
          error: 'invalid model selection',
        }),
        exitCode: 1,
      })
      const textGeneration = yield* makeAntigravityTextGeneration(
        decodeAntigravitySettings({ binaryPath: wrapper.binaryPath }),
        { PATH: process.env.PATH ?? '' },
      )

      const error = yield* Effect.flip(
        textGeneration.generateCommitMessage(commitInput('gemini-3.5-flash')),
      )
      expect(error._tag).toBe('TextGenerationError')
      expect(error.detail).toContain('invalid model selection')
    }),
  )

  it.effect('rejects malformed terminal envelopes', () =>
    Effect.gen(function* ()
    {
      const tempDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), 'antigravity-text-generation-'),
      )
      const wrapper = makeAntigravityWrapper({
        dir: tempDir,
        stdout: JSON.stringify({
          status: 'SUCCESS',
          response: '{"subject":"missing envelope fields"}',
        }),
      })
      const textGeneration = yield* makeAntigravityTextGeneration(
        decodeAntigravitySettings({ binaryPath: wrapper.binaryPath }),
        { PATH: process.env.PATH ?? '' },
      )

      const error = yield* Effect.flip(textGeneration.generateCommitMessage(commitInput('default')))
      expect(error._tag).toBe('TextGenerationError')
      expect(error.detail).toMatch(/invalid terminal JSON envelope/i)
    }),
  )

  it.effect('rejects oversized stdout before decoding an envelope', () =>
    Effect.gen(function* ()
    {
      const tempDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), 'antigravity-text-generation-'),
      )
      const wrapper = makeAntigravityWrapper({
        dir: tempDir,
        stdout: 'x'.repeat(2 * 1024 * 1024 + 1),
      })
      const textGeneration = yield* makeAntigravityTextGeneration(
        decodeAntigravitySettings({ binaryPath: wrapper.binaryPath }),
        { PATH: process.env.PATH ?? '' },
      )

      const error = yield* Effect.flip(textGeneration.generateCommitMessage(commitInput('default')))
      expect(error._tag).toBe('TextGenerationError')
      expect(error.detail).toMatch(/stdout exceeded the 2097152-byte limit/i)
    }),
  )

  it.effect('rejects attachments before attempting to spawn agy', () =>
    Effect.gen(function* ()
    {
      const textGeneration = yield* makeAntigravityTextGeneration(
        decodeAntigravitySettings({ binaryPath: '/definitely/missing/agy' }),
        { PATH: process.env.PATH ?? '' },
      )

      const error = yield* Effect.flip(
        textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: 'Name this thread from the screenshot.',
          attachments: [
            {
              type: 'image',
              id: 'antigravity-image-1',
              name: 'screenshot.png',
              mimeType: 'image/png',
              sizeBytes: 42,
            },
          ],
          modelSelection: createModelSelection(ProviderInstanceId.make('antigravity'), 'default'),
        }),
      )
      expect(error._tag).toBe('TextGenerationError')
      expect(error.operation).toBe('generateThreadTitle')
      expect(error.detail).toMatch(/supports text input only/i)
    }),
  )
})
