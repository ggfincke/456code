// tests/apps/server/textGeneration/CoralTextGeneration.test.ts
// verify isolated no-tool Coral exec text generation

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'

import * as NodeServices from '@effect/platform-node/NodeServices'
import { it } from '@effect/vitest'
import { CoralSettings, ProviderInstanceId } from '@t3tools/contracts'
import { createModelSelection } from '@t3tools/shared/model'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { expect } from 'vite-plus/test'

import { makeCoralTextGeneration } from '../../../../apps/server/src/textGeneration/CoralTextGeneration.ts'

const decodeCoralSettings = Schema.decodeSync(CoralSettings)

function shellSingleQuote(value: string): string
{
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function makeCoralExecWrapper(input: { readonly dir: string; readonly response: unknown }): {
  readonly argsPath: string
  readonly binaryPath: string
  readonly homePath: string
  readonly promptPath: string
}
{
  const binaryPath = NodePath.join(input.dir, 'coral')
  const argsPath = NodePath.join(input.dir, 'args.txt')
  const homePath = NodePath.join(input.dir, 'coral-home.txt')
  const promptPath = NodePath.join(input.dir, 'prompt.txt')
  const envelope = JSON.stringify({
    version: 1,
    run_id: 'coral-test-run',
    status: 'completed',
    model: 'qwen3.6:35b',
    response: JSON.stringify(input.response),
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  })
  NodeFS.writeFileSync(
    binaryPath,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$@" > ${shellSingleQuote(argsPath)}`,
      `printf '%s' "\${CORAL_HOME-}" > ${shellSingleQuote(homePath)}`,
      'prompt_file=""',
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "--prompt-file" ]; then',
      '    shift',
      '    prompt_file="$1"',
      '    break',
      '  fi',
      '  shift',
      'done',
      'if [ -z "$prompt_file" ]; then',
      '  printf "%s\\n" "missing --prompt-file" >&2',
      '  exit 12',
      'fi',
      `cat "$prompt_file" > ${shellSingleQuote(promptPath)}`,
      `printf '%s\\n' ${shellSingleQuote(envelope)}`,
      '',
    ].join('\n'),
    'utf8',
  )
  NodeFS.chmodSync(binaryPath, 0o755)
  return { argsPath, binaryPath, homePath, promptPath }
}

it.layer(NodeServices.layer)('CoralTextGeneration', (it) =>
{
  it.effect(
    'uses an independent no-tool ephemeral exec with exact host, model, cwd, and home',
    () =>
      Effect.gen(function* ()
      {
        const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'coral-text-generation-'))
        const configuredHome = NodePath.join(tempDir, 'configured-home')
        const wrapper = makeCoralExecWrapper({
          dir: tempDir,
          response: {
            subject: 'Add Coral text generation',
            body: 'Use an isolated no-tool exec path.',
          },
        })
        const textGeneration = yield* makeCoralTextGeneration(
          decodeCoralSettings({
            binaryPath: wrapper.binaryPath,
            homePath: configuredHome,
            ollamaHost: 'https://ollama.internal:11434/',
          }),
          { PATH: process.env.PATH },
        )

        const generated = yield* textGeneration.generateCommitMessage({
          cwd: tempDir,
          branch: 'feature/coral',
          stagedSummary: 'M apps/server/src/textGeneration/CoralTextGeneration.ts',
          stagedPatch: 'diff --git a/CoralTextGeneration.ts b/CoralTextGeneration.ts',
          modelSelection: createModelSelection(ProviderInstanceId.make('coral'), 'qwen3.6:35b'),
        })

        expect(generated).toEqual({
          subject: 'Add Coral text generation',
          body: 'Use an isolated no-tool exec path.',
        })
        const args = NodeFS.readFileSync(wrapper.argsPath, 'utf8').trim().split('\n')
        expect(args.slice(0, -1)).toEqual([
          'exec',
          '--permission-profile',
          'none',
          '--output-format',
          'json',
          '--ephemeral',
          '--no-mcp',
          '--host',
          'https://ollama.internal:11434',
          '--model',
          'qwen3.6:35b',
          '--cwd',
          tempDir,
          '--prompt-file',
        ])
        expect(args.at(-1)).toMatch(/456code-coral-/)
        expect(NodeFS.readFileSync(wrapper.homePath, 'utf8')).toBe(configuredHome)
        expect(NodeFS.readFileSync(wrapper.promptPath, 'utf8')).toContain('Staged patch:')
      }),
  )

  it.effect('rejects image context before attempting to spawn Coral', () =>
    Effect.gen(function* ()
    {
      const textGeneration = yield* makeCoralTextGeneration(
        decodeCoralSettings({ binaryPath: '/definitely/missing/coral' }),
      )
      const error = yield* Effect.flip(
        textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: 'Name the thread from this screenshot.',
          attachments: [
            {
              type: 'image',
              id: 'coral-image-1',
              name: 'screenshot.png',
              mimeType: 'image/png',
              sizeBytes: 42,
            },
          ],
          modelSelection: createModelSelection(ProviderInstanceId.make('coral'), 'gemma4:31b-mlx'),
        }),
      )

      expect(error._tag).toBe('TextGenerationError')
      expect(error.operation).toBe('generateThreadTitle')
      expect(error.detail).toMatch(/does not support attachments/i)
    }),
  )
})
