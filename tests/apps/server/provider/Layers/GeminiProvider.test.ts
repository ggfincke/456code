// tests/apps/server/provider/Layers/GeminiProvider.test.ts
// verify Gemini model defaults and in-session switching presentation

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'

import * as NodeServices from '@effect/platform-node/NodeServices'
import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  GeminiSettings,
  ProviderDriverKind,
} from '@t3tools/contracts'
import { it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { expect } from 'vite-plus/test'

import {
  buildInitialGeminiProviderSnapshot,
  checkGeminiProviderStatus,
  DEFAULT_GEMINI_MODEL,
} from '../../../../../apps/server/src/provider/Layers/GeminiProvider.ts'

const decodeGeminiSettings = Schema.decodeSync(GeminiSettings)

it.effect('uses stable CLI aliases and starts with model switching unadvertised', () =>
  Effect.gen(function* ()
  {
    const gemini = ProviderDriverKind.make('gemini')
    const snapshot = yield* buildInitialGeminiProviderSnapshot(decodeGeminiSettings({}))

    expect(DEFAULT_GEMINI_MODEL).toBe('auto')
    expect(DEFAULT_MODEL_BY_PROVIDER[gemini]).toBe(DEFAULT_GEMINI_MODEL)
    expect(DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[gemini]).toBe(DEFAULT_GEMINI_MODEL)
    expect(snapshot.models.map((model) => model.slug)).toEqual(['auto', 'flash', 'pro'])
    expect(snapshot.requiresNewThreadForModelChange).toBeUndefined()
    expect(snapshot.capabilities?.sessionModelSwitch).toBe('unsupported')
    expect(snapshot.accountUsage).toBeUndefined()
    const enabled = yield* buildInitialGeminiProviderSnapshot(
      decodeGeminiSettings({ enabled: true }),
    )
    expect(enabled.accountUsage).toEqual({
      status: 'unavailable',
      message:
        'Gemini account limits aren’t available through this integration. Check /stats in Gemini CLI.',
    })
  }),
)

it.layer(NodeServices.layer)('GeminiProviderLive', (it) =>
{
  it.effect('does not reintroduce ambient API keys for the version probe', () =>
    Effect.gen(function* ()
    {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'gemini-version-probe-'))
      const envPath = NodePath.join(tempDir, 'env.txt')
      const argsPath = NodePath.join(tempDir, 'args.txt')
      const binaryPath = NodePath.join(tempDir, 'gemini')
      NodeFS.writeFileSync(
        binaryPath,
        [
          '#!/bin/sh',
          `printf '%s\\n' "${'$'}{GEMINI_API_KEY-unset}" "${'$'}{GOOGLE_API_KEY-unset}" > '${envPath}'`,
          `printf '%s\\n' "$@" >> '${argsPath}'`,
          `printf '%s\\n' '1.2.3'`,
          '',
        ].join('\n'),
        'utf8',
      )
      NodeFS.chmodSync(binaryPath, 0o755)

      const originalGeminiApiKey = process.env.GEMINI_API_KEY
      const originalGoogleApiKey = process.env.GOOGLE_API_KEY
      process.env.GEMINI_API_KEY = 'ambient-gemini-key'
      process.env.GOOGLE_API_KEY = 'ambient-google-key'
      try
      {
        const snapshot = yield* checkGeminiProviderStatus(
          decodeGeminiSettings({ enabled: true, binaryPath }),
          { PATH: process.env.PATH },
        )
        expect(snapshot.version).toBe('1.2.3')
        expect(snapshot.accountUsage?.status).toBe('unavailable')
        expect(NodeFS.readFileSync(argsPath, 'utf8').trim().split('\n')).toEqual(['--version'])
        expect(NodeFS.readFileSync(envPath, 'utf8').trim().split('\n')).toEqual(['unset', 'unset'])
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
