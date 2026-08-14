// tests/apps/server/provider/acp/CoralAcpSupport.test.ts
// verify Coral ACP launch, inventory, and model-selection contracts

import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as EffectAcpErrors from 'effect-acp/errors'

import {
  applyCoralAcpModelSelection,
  buildCoralAcpEnvironment,
  buildCoralAcpSpawnInput,
  coralModelsFromSessionSetup,
  normalizeCoralOllamaHost,
} from '../../../../../apps/server/src/provider/acp/CoralAcpSupport.ts'

describe('CoralAcpSupport', () =>
{
  it('normalizes HTTP hosts and launches the exact baseline ACP command', () =>
  {
    expect(normalizeCoralOllamaHost(' https://ollama.internal:11434/ ')).toBe(
      'https://ollama.internal:11434',
    )
    expect(() => normalizeCoralOllamaHost('file:///tmp/ollama')).toThrow(/http or https/)
    expect(
      buildCoralAcpSpawnInput(
        {
          binaryPath: '/opt/coral/bin/coral',
          ollamaHost: 'http://127.0.0.1:11434/',
        },
        '/workspace',
        { PATH: '/usr/bin' },
        'gemma4:31b-mlx',
      ),
    ).toEqual({
      command: '/opt/coral/bin/coral',
      args: ['acp', '--host', 'http://127.0.0.1:11434', '--model', 'gemma4:31b-mlx'],
      cwd: '/workspace',
      env: { PATH: '/usr/bin' },
    })
  })

  it('sets CORAL_HOME only when explicitly configured', () =>
  {
    expect(buildCoralAcpEnvironment({ homePath: '' }, { PATH: '/usr/bin' })).toEqual({
      PATH: '/usr/bin',
    })
    expect(buildCoralAcpEnvironment({ homePath: '/tmp/coral-home' }, { PATH: '/usr/bin' })).toEqual(
      {
        PATH: '/usr/bin',
        CORAL_HOME: '/tmp/coral-home',
      },
    )
  })

  it('derives the ready inventory from the standard model config option', () =>
  {
    expect(
      coralModelsFromSessionSetup({
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'gemma4:31b-mlx',
            options: [
              { value: 'gemma4:31b-mlx', name: 'Gemma 4 31B' },
              { value: 'qwen3.6:35b', name: 'Qwen 3.6 35B' },
            ],
          },
        ],
      }),
    ).toEqual([
      { slug: 'gemma4:31b-mlx', name: 'Gemma 4 31B', isCurrent: true },
      { slug: 'qwen3.6:35b', name: 'Qwen 3.6 35B', isCurrent: false },
    ])
  })

  it.effect('switches models only when the requested model differs', () =>
    Effect.gen(function* ()
    {
      const calls: Array<string> = []
      const runtime = {
        setModel: (model: string) => Effect.sync(() => calls.push(model)).pipe(Effect.asVoid),
      }
      const unchanged = yield* applyCoralAcpModelSelection({
        runtime,
        currentModel: 'gemma4:31b-mlx',
        requestedModel: 'gemma4:31b-mlx',
        mapError: (cause: EffectAcpErrors.AcpError) => cause,
      })
      const changed = yield* applyCoralAcpModelSelection({
        runtime,
        currentModel: unchanged,
        requestedModel: 'qwen3.6:35b',
        mapError: (cause: EffectAcpErrors.AcpError) => cause,
      })
      expect(calls).toEqual(['qwen3.6:35b'])
      expect(changed).toBe('qwen3.6:35b')
    }),
  )
})
