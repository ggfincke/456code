// tests/apps/server/textGeneration/GeminiTextGeneration.test.ts
// verify isolated Gemini headless text generation honors the selected model

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'

import * as NodeServices from '@effect/platform-node/NodeServices'
import { it } from '@effect/vitest'
import { GeminiSettings, ProviderInstanceId } from '@t3tools/contracts'
import { createModelSelection } from '@t3tools/shared/model'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { expect } from 'vite-plus/test'

import { makeGeminiTextGeneration } from '../../../../apps/server/src/textGeneration/GeminiTextGeneration.ts'

const decodeGeminiSettings = Schema.decodeSync(GeminiSettings)

function shellSingleQuote(value: string): string
{
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function makeGeminiWrapper(input: { readonly dir: string; readonly response: unknown }): {
  readonly argsPath: string
  readonly binaryPath: string
  readonly envPath: string
}
{
  const argsPath = NodePath.join(input.dir, 'args.txt')
  const binaryPath = NodePath.join(input.dir, 'gemini')
  const envPath = NodePath.join(input.dir, 'env.txt')
  const envelope = JSON.stringify({ response: JSON.stringify(input.response) })
  NodeFS.writeFileSync(
    binaryPath,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$@" > ${shellSingleQuote(argsPath)}`,
      `printf '%s\\n' "${'$'}{GEMINI_API_KEY-unset}" "${'$'}{GOOGLE_API_KEY-unset}" > ${shellSingleQuote(envPath)}`,
      `printf '%s\\n' ${shellSingleQuote(envelope)}`,
      '',
    ].join('\n'),
    'utf8',
  )
  NodeFS.chmodSync(binaryPath, 0o755)
  return { argsPath, binaryPath, envPath }
}

it.layer(NodeServices.layer)('GeminiTextGeneration', (it) =>
{
  it.effect('passes the selected model to the headless Gemini process', () =>
    Effect.gen(function* ()
    {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'gemini-text-generation-'))
      const wrapper = makeGeminiWrapper({
        dir: tempDir,
        response: {
          subject: 'Honor the Gemini model',
          body: 'Pass the selected model to the headless process.',
        },
      })
      const textGeneration = yield* makeGeminiTextGeneration(
        decodeGeminiSettings({ binaryPath: wrapper.binaryPath }),
        { PATH: process.env.PATH },
      )

      const generated = yield* textGeneration.generateCommitMessage({
        cwd: tempDir,
        branch: 'feature/gemini',
        stagedSummary: 'M apps/server/src/textGeneration/GeminiTextGeneration.ts',
        stagedPatch: 'diff --git a/GeminiTextGeneration.ts b/GeminiTextGeneration.ts',
        modelSelection: createModelSelection(ProviderInstanceId.make('gemini'), 'flash'),
      })

      expect(generated).toEqual({
        subject: 'Honor the Gemini model',
        body: 'Pass the selected model to the headless process.',
      })
      const args = NodeFS.readFileSync(wrapper.argsPath, 'utf8').trim().split('\n')
      expect(args[0]).toBe('--prompt')
      expect(args.slice(1, -4).join('\n')).toContain('Staged patch:')
      expect(args.slice(-4)).toEqual(['--model', 'flash', '--output-format', 'json'])
    }),
  )

  it.effect('preserves an explicitly configured API key and strips the ambient Google key', () =>
    Effect.gen(function* ()
    {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'gemini-text-generation-'))
      const wrapper = makeGeminiWrapper({
        dir: tempDir,
        response: {
          subject: 'Use the configured key',
          body: 'Keep the instance-scoped credential only.',
        },
      })
      const originalGeminiApiKey = process.env.GEMINI_API_KEY
      const originalGoogleApiKey = process.env.GOOGLE_API_KEY
      process.env.GEMINI_API_KEY = 'ambient-gemini-key'
      process.env.GOOGLE_API_KEY = 'ambient-google-key'
      try
      {
        const textGeneration = yield* makeGeminiTextGeneration(
          decodeGeminiSettings({ binaryPath: wrapper.binaryPath }),
          {
            PATH: process.env.PATH,
            GEMINI_API_KEY: 'configured-gemini-key',
          },
          { apiKeyConfigured: true },
        )

        yield* textGeneration.generateCommitMessage({
          cwd: tempDir,
          branch: 'feature/gemini-auth',
          stagedSummary: 'M apps/server/src/provider/Drivers/GeminiDriver.ts',
          stagedPatch: 'diff --git a/GeminiDriver.ts b/GeminiDriver.ts',
          modelSelection: createModelSelection(ProviderInstanceId.make('gemini'), 'flash'),
        })

        expect(NodeFS.readFileSync(wrapper.envPath, 'utf8').trim().split('\n')).toEqual([
          'configured-gemini-key',
          'unset',
        ])
      }
      finally
      {
        if (originalGeminiApiKey === undefined) delete process.env.GEMINI_API_KEY
        else process.env.GEMINI_API_KEY = originalGeminiApiKey
        if (originalGoogleApiKey === undefined) delete process.env.GOOGLE_API_KEY
        else process.env.GOOGLE_API_KEY = originalGoogleApiKey
      }
    }),
  )
})
