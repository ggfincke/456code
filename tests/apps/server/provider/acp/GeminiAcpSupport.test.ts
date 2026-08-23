// tests/apps/server/provider/acp/GeminiAcpSupport.test.ts
// verify Gemini ACP launch, auth resolution, and model-selection contracts

import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as EffectAcpErrors from 'effect-acp/errors'

import {
  applyGeminiAcpModelSelection,
  buildGeminiAcpEnvironment,
  buildGeminiAcpSpawnInput,
  currentGeminiModelIdFromSessionSetup,
  geminiAcpModeIdForRuntimeMode,
  geminiAcpModeIdForTurn,
  geminiCapabilitiesFromSessionSetup,
  geminiModeSupportFromSessionSetup,
  geminiModelsFromSessionSetup,
  GEMINI_API_KEY_ENV,
  GEMINI_CLI_HOME_ENV,
  GOOGLE_API_KEY_ENV,
  resolveGeminiAuthMethodId,
} from '../../../../../apps/server/src/provider/acp/GeminiAcpSupport.ts'

describe('GeminiAcpSupport', () =>
{
  it('launches the exact baseline ACP command', () =>
  {
    expect(
      buildGeminiAcpSpawnInput({ binaryPath: '/opt/gemini/bin/gemini' }, '/workspace', {
        PATH: '/usr/bin',
      }),
    ).toEqual({
      command: '/opt/gemini/bin/gemini',
      args: ['--acp'],
      cwd: '/workspace',
      env: { PATH: '/usr/bin' },
      extendEnv: false,
    })
    expect(buildGeminiAcpSpawnInput(null, '/workspace').command).toBe('gemini')
  })

  it('isolates API-key env and strips ambient login keys', () =>
  {
    expect(
      buildGeminiAcpEnvironment({
        PATH: '/usr/bin',
        [GEMINI_API_KEY_ENV]: 'ambient',
        [GOOGLE_API_KEY_ENV]: 'ambient',
      }),
    ).toEqual({ PATH: '/usr/bin' })
    expect(
      buildGeminiAcpEnvironment(
        { PATH: '/usr/bin', [GEMINI_API_KEY_ENV]: 'key-123', [GOOGLE_API_KEY_ENV]: 'ambient' },
        { apiKeyConfigured: true, cliHome: '/state/gemini/one' },
      ),
    ).toEqual({
      PATH: '/usr/bin',
      [GEMINI_API_KEY_ENV]: 'key-123',
      [GEMINI_CLI_HOME_ENV]: '/state/gemini/one',
    })
    expect(
      buildGeminiAcpEnvironment(
        { PATH: '/usr/bin', [GEMINI_API_KEY_ENV]: 'ambient', [GOOGLE_API_KEY_ENV]: 'instance' },
        { explicitlyConfiguredApiKeyNames: new Set([GOOGLE_API_KEY_ENV]) },
      ),
    ).toEqual({ PATH: '/usr/bin', [GOOGLE_API_KEY_ENV]: 'instance' })
  })

  it('resolves api-key auth only for an instance-configured key', () =>
  {
    expect(
      resolveGeminiAuthMethodId({ environment: { [GEMINI_API_KEY_ENV]: 'ambient' } }),
    ).toBeUndefined()
    expect(
      resolveGeminiAuthMethodId({
        apiKeyConfigured: true,
        environment: { [GEMINI_API_KEY_ENV]: 'k' },
      }),
    ).toBe('gemini-api-key')
  })

  it('does not retain an empty ambient key', () =>
  {
    expect(buildGeminiAcpEnvironment({ PATH: '/usr/bin', [GEMINI_API_KEY_ENV]: '  ' })).toEqual({
      PATH: '/usr/bin',
    })
  })

  it('reads the current model from session setup inventory', () =>
  {
    expect(currentGeminiModelIdFromSessionSetup({ models: null })).toBeUndefined()
    expect(
      currentGeminiModelIdFromSessionSetup({
        models: { currentModelId: ' auto ' },
      }),
    ).toBe('auto')
  })

  it('normalizes the advertised dynamic model inventory', () =>
    expect(
      geminiModelsFromSessionSetup({
        models: {
          currentModelId: 'flash',
          availableModels: [
            { modelId: 'flash', name: 'Gemini Flash' },
            { modelId: 'flash', name: 'Duplicate' },
            { modelId: 'pro', name: 'Gemini Pro', description: 'reasoning' },
          ],
        },
      }),
    ).toEqual([
      { slug: 'flash', name: 'Gemini Flash', isCurrent: true },
      { slug: 'pro', name: 'Gemini Pro', description: 'reasoning', isCurrent: false },
    ]))

  it('maps only Gemini ACP advertised mode ids into provider capabilities', () =>
  {
    const setup = {
      modes: {
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'autoEdit', name: 'Auto Edit' },
          { id: 'yolo', name: 'YOLO' },
          { id: 'plan', name: 'Plan' },
          { id: 'future-mode', name: 'Future' },
        ],
      },
    }
    const support = geminiModeSupportFromSessionSetup(setup)

    expect(support.supportedRuntimeModes).toEqual([
      'approval-required',
      'auto-accept-edits',
      'full-access',
    ])
    expect(support.supportedInteractionModes).toEqual(['default', 'plan'])
    expect(geminiAcpModeIdForRuntimeMode('approval-required', support.availableModeIds)).toBe(
      'default',
    )
    expect(geminiAcpModeIdForRuntimeMode('auto-accept-edits', support.availableModeIds)).toBe(
      'autoEdit',
    )
    expect(geminiAcpModeIdForRuntimeMode('full-access', support.availableModeIds)).toBe('yolo')
    expect(
      geminiAcpModeIdForTurn({
        runtimeMode: 'full-access',
        interactionMode: 'plan',
        availableModeIds: support.availableModeIds,
      }),
    ).toBe('plan')
  })

  it('preserves conservative runtime modes when ACP omits its mode inventory', () =>
  {
    expect(
      geminiCapabilitiesFromSessionSetup(
        {
          defaultRuntimeMode: 'approval-required',
          sessionModelSwitch: 'unsupported',
          supportedInteractionModes: ['default'],
          supportedRuntimeModes: ['approval-required'],
          activeTurnInput: 'unsupported',
          conversationRollback: 'unsupported',
          orchestrateInstructionDelivery: 'prompt-prefix',
          orchestrateBaseModes: ['default'],
          runtimeModeWarnings: [],
          supportedAttachmentTypes: ['image'],
        },
        {},
      ),
    ).toMatchObject({
      defaultRuntimeMode: 'approval-required',
      supportedRuntimeModes: ['approval-required'],
      supportedInteractionModes: ['default'],
    })
  })

  it.effect('switches models only when the requested model differs', () =>
    Effect.gen(function* ()
    {
      const calls: Array<string> = []
      const runtime = {
        setSessionModel: (modelId: string) =>
          Effect.sync(() =>
          {
            calls.push(modelId)
            return {}
          }),
      }
      const unchanged = yield* applyGeminiAcpModelSelection({
        runtime,
        currentModelId: 'auto',
        requestedModelId: 'auto',
        mapError: (cause: EffectAcpErrors.AcpError) => cause,
      })
      const changed = yield* applyGeminiAcpModelSelection({
        runtime,
        currentModelId: unchanged,
        requestedModelId: 'pro',
        mapError: (cause: EffectAcpErrors.AcpError) => cause,
      })
      expect(calls).toEqual(['pro'])
      expect(changed).toBe('pro')

      const guarded = yield* applyGeminiAcpModelSelection({
        runtime,
        currentModelId: changed,
        requestedModelId: 'unknown',
        availableModelIds: new Set(['auto', 'pro']),
        mapError: (cause: EffectAcpErrors.AcpError) => cause,
      })
      expect(calls).toEqual(['pro'])
      expect(guarded).toBe('pro')
    }),
  )
})
