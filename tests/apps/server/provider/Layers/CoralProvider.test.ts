// tests/apps/server/provider/Layers/CoralProvider.test.ts
// verify Coral provider status from version probes and fallback models

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'

import * as NodeServices from '@effect/platform-node/NodeServices'
import { describe, expect, it } from '@effect/vitest'
import { CoralSettings } from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import {
  buildInitialCoralProviderSnapshot,
  checkCoralProviderStatus,
} from '../../../../../apps/server/src/provider/Layers/CoralProvider.ts'

const decodeCoralSettings = Schema.decodeSync(CoralSettings)

async function makeCoralVersionWrapper(): Promise<string>
{
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'coral-provider-probe-'))
  const wrapperPath = NodePath.join(dir, 'coral')
  await NodeFSP.writeFile(
    wrapperPath,
    [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then',
      '  printf "coral 0.1.0\\n"',
      '  exit 0',
      'fi',
      'printf "unexpected acp spawn\\n" >&2',
      'exit 2',
      '',
    ].join('\n'),
    'utf8',
  )
  await NodeFSP.chmod(wrapperPath, 0o755)
  return wrapperPath
}

describe('buildInitialCoralProviderSnapshot', () =>
{
  it.effect('is disabled by default and reports authentication as not applicable', () =>
    Effect.gen(function* ()
    {
      const snapshot = yield* buildInitialCoralProviderSnapshot(decodeCoralSettings({}))
      expect(snapshot.enabled).toBe(false)
      expect(snapshot.status).toBe('disabled')
      expect(snapshot.auth.status).toBe('not-applicable')
      expect(snapshot.badgeLabel).toBe('Early Access')
      expect(snapshot.models.map((model) => model.slug)).toEqual(['qwen3.8:27b-mlx'])
    }),
  )
})

describe('checkCoralProviderStatus', () =>
{
  it.effect('reports a missing executable without probing Ollama directly', () =>
    checkCoralProviderStatus(
      decodeCoralSettings({
        enabled: true,
        binaryPath: '/definitely/not/installed/coral',
      }),
    ).pipe(
      Effect.tap((snapshot) =>
        Effect.sync(() =>
        {
          expect(snapshot.installed).toBe(false)
          expect(snapshot.status).toBe('error')
          expect(snapshot.auth.status).toBe('not-applicable')
        }),
      ),
      Effect.provide(NodeServices.layer),
    ),
  )

  it.effect('uses configured fallback models after a successful version probe', () =>
    Effect.gen(function* ()
    {
      const binaryPath = yield* Effect.promise(makeCoralVersionWrapper)
      const snapshot = yield* checkCoralProviderStatus(
        decodeCoralSettings({
          enabled: true,
          binaryPath,
          ollamaHost: 'http://127.0.0.1:11434/',
        }),
      )
      expect(snapshot.status).toBe('ready')
      expect(snapshot.version).toBe('0.1.0')
      expect(snapshot.auth.status).toBe('not-applicable')
      expect(snapshot.models.map((model) => model.slug)).toEqual(['qwen3.8:27b-mlx'])
      expect(snapshot.capabilities?.sessionModelSwitch).toBe('in-session')
      expect(snapshot.capabilities?.orchestrateInstructionDelivery).toBe('unsupported')
    }).pipe(Effect.provide(NodeServices.layer)),
  )
})
