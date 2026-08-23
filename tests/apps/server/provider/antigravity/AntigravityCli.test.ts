// tests/apps/server/provider/antigravity/AntigravityCli.test.ts
// protects antigravity command arguments and strict stream parsing

import { describe, expect, it } from '@effect/vitest'

import {
  ANTIGRAVITY_MINIMUM_VERSION,
  AntigravityResumeCursor,
  buildAntigravityLaunchArgs,
  buildAntigravityOneShotArgs,
  isAntigravityVersionSupported,
  parseAntigravityDiscoveryOutput,
  parseAntigravityStreamLine,
} from '../../../../../apps/server/src/provider/antigravity/AntigravityCli.ts'
import * as Schema from 'effect/Schema'

const isAntigravityResumeCursor = Schema.is(AntigravityResumeCursor)

describe('AntigravityCli', () =>
{
  it('pins the persistent stream flags and runtime mode mapping', () =>
  {
    expect(buildAntigravityLaunchArgs({ runtimeMode: 'auto-accept-edits', sandbox: true })).toEqual(
      [
        '--mode',
        'accept-edits',
        '--sandbox',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
      ],
    )
    expect(
      buildAntigravityLaunchArgs({
        runtimeMode: 'auto-accept-edits',
        sandbox: true,
        conversationId: 'conv-1',
        model: 'opaque-model',
        agent: 'worker',
      }),
    ).toEqual([
      '--conversation',
      'conv-1',
      '--model',
      'opaque-model',
      '--agent',
      'worker',
      '--mode',
      'accept-edits',
      '--sandbox',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
    ])
    expect(buildAntigravityLaunchArgs({ runtimeMode: 'full-access', sandbox: true })).toEqual([
      '--dangerously-skip-permissions',
      '--sandbox',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
    ])
  })

  it('requires the minimum version and preserves opaque discovery ids', () =>
  {
    expect(ANTIGRAVITY_MINIMUM_VERSION).toBe('1.1.15')
    expect(isAntigravityVersionSupported('1.1.15')).toBe(true)
    expect(isAntigravityVersionSupported('1.1.14')).toBe(false)
    expect(isAntigravityVersionSupported('1.1.15-beta.1')).toBe(false)
    expect(
      parseAntigravityDiscoveryOutput(
        'Discovering models...\n{"command":{"data":{"models":[{"id":" model-x "},{"id":"model-x"},{"id":"model-y"}]}}}',
        'models',
      ),
    ).toEqual(['model-x', 'model-y'])
    expect(parseAntigravityDiscoveryOutput('{"unexpected":true}', 'models')).toBeUndefined()
  })

  it('maps known events, ignores unknown events, and rejects malformed lines', () =>
  {
    const step = {
      event: 'step_update',
      step_update: {
        conversation_id: 'conv-1',
        step_index: 0,
        state: 'ACTIVE',
        step_type: 'agent_response',
        text_delta: 'hello',
      },
    }
    expect(parseAntigravityStreamLine(JSON.stringify(step))).toEqual({
      kind: 'known',
      message: { kind: 'step_update', value: step },
    })
    const forwardCompatibleStep = {
      event: 'step_update',
      step_update: {
        conversation_id: 'conv-1',
        step_index: 1,
        state: 'DONE',
        step_type: 'system_message',
        future_metadata: { retained: true },
      },
    }
    expect(parseAntigravityStreamLine(JSON.stringify(forwardCompatibleStep))).toEqual({
      kind: 'known',
      message: { kind: 'step_update', value: forwardCompatibleStep },
    })
    expect(parseAntigravityStreamLine('{"event":"future_event"}')).toEqual({
      kind: 'unknown',
      event: 'future_event',
    })
    expect(parseAntigravityStreamLine('{bad').kind).toBe('malformed')
    expect(
      parseAntigravityStreamLine(
        JSON.stringify({
          event: 'result',
          result: { conversation_id: 'conv-1', status: 'SUCCESS' },
        }),
      ).kind,
    ).toBe('malformed')
    expect(
      parseAntigravityStreamLine(
        JSON.stringify({
          event: 'result',
          result: {
            conversation_id: '',
            status: 'ERROR',
            response: '',
            error: 'invalid model selection',
          },
        }),
      ),
    ).toEqual({
      kind: 'known',
      message: {
        kind: 'result',
        value: {
          event: 'result',
          result: {
            conversation_id: '',
            status: 'ERROR',
            response: '',
            error: 'invalid model selection',
          },
        },
      },
    })
    expect(
      parseAntigravityStreamLine(
        JSON.stringify({
          event: 'result',
          result: { status: 'INVALID', response: '', error: 'invalid agent' },
        }),
      ).kind,
    ).toBe('known')
    expect(
      parseAntigravityStreamLine(
        JSON.stringify({
          event: 'result',
          result: { conversation_id: '', status: 'SUCCESS', response: 'ok' },
        }),
      ).kind,
    ).toBe('malformed')
    expect(
      parseAntigravityStreamLine(
        JSON.stringify({
          event: 'result',
          result: {
            conversation_id: 'conv-1',
            status: 'SUCCESS',
            response: 'ok',
            usage: { total_tokens: -1 },
          },
        }),
      ).kind,
    ).toBe('malformed')
    expect(
      buildAntigravityOneShotArgs({ prompt: 'hello', model: 'default', sandbox: true }),
    ).toEqual(['-p', 'hello', '--output-format', 'json', '--sandbox'])
    expect(
      buildAntigravityOneShotArgs({ prompt: 'hello', model: 'opaque-model', sandbox: false }),
    ).toEqual(['-p', 'hello', '--output-format', 'json', '--model', 'opaque-model'])
  })

  it('accepts a versioned exact-id cursor with an optional cumulative usage baseline', () =>
  {
    expect(
      isAntigravityResumeCursor({
        schemaVersion: 2,
        conversationId: 'conv-1',
        binding: {
          workspace: '/workspace',
          executable: 'agy',
          model: 'default',
          agent: '',
          runtimeMode: 'auto-accept-edits',
          sandbox: true,
        },
        cumulativeUsage: { input: 10, output: 5, total: 15, durationMs: 100, turns: 1 },
      }),
    ).toBe(true)
    expect(isAntigravityResumeCursor({ schemaVersion: 2, conversationId: '' })).toBe(false)
    expect(
      isAntigravityResumeCursor({
        schemaVersion: 2,
        conversationId: 'conv-1',
        binding: {
          workspace: '/workspace',
          executable: 'agy',
          model: 'default',
          agent: '',
          runtimeMode: 'auto-accept-edits',
          sandbox: true,
        },
        cumulativeUsage: { total: -1 },
      }),
    ).toBe(false)
  })
})
