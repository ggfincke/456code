// tests/packages/contracts/provider.test.ts
// verify provider session start input behavior

import { describe, expect, it } from 'vite-plus/test'
import * as Schema from 'effect/Schema'

import {
  ProviderEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
} from '../../../packages/contracts/src/provider.ts'

const decodeProviderSessionStartInput = Schema.decodeUnknownSync(ProviderSessionStartInput)
const decodeProviderSendTurnInput = Schema.decodeUnknownSync(ProviderSendTurnInput)
const decodeProviderSession = Schema.decodeUnknownSync(ProviderSession)
const decodeProviderEvent = Schema.decodeUnknownSync(ProviderEvent)

function getOptionValue(
  options: ReadonlyArray<{ id: string; value: unknown }> | undefined,
  id: string,
): unknown
{
  return options?.find((option) => option.id === id)?.value
}

describe('ProviderSessionStartInput', () =>
{
  it('accepts codex-compatible payloads', () =>
  {
    const parsed = decodeProviderSessionStartInput({
      threadId: 'thread-1',
      provider: 'codex',
      cwd: '/tmp/workspace',
      modelSelection: {
        provider: 'codex',
        model: 'gpt-5.3-codex',
        options: [
          { id: 'reasoningEffort', value: 'high' },
          { id: 'fastMode', value: true },
        ],
      },
      runtimeMode: 'full-access',
    })
    expect(parsed.runtimeMode).toBe('full-access')
    expect(parsed.provider).toBe('codex')
    expect(parsed.modelSelection?.instanceId).toBe('codex')
    expect(parsed.modelSelection?.model).toBe('gpt-5.3-codex')
    expect(getOptionValue(parsed.modelSelection?.options, 'reasoningEffort')).toBe('high')
    expect(getOptionValue(parsed.modelSelection?.options, 'fastMode')).toBe(true)
  })

  it('rejects payloads without runtime mode', () =>
  {
    expect(() =>
      decodeProviderSessionStartInput({
        threadId: 'thread-1',
        provider: 'codex',
      }),
    ).toThrow()
  })

  it('accepts fork-provided driver kinds as branded slugs', () =>
  {
    const parsed = decodeProviderSessionStartInput({
      threadId: 'thread-1',
      provider: 'ollama',
      providerInstanceId: 'ollama_local',
      cwd: '/tmp/workspace',
      runtimeMode: 'full-access',
      modelSelection: {
        instanceId: 'ollama_local',
        model: 'llama3.3',
      },
    })

    expect(parsed.provider).toBe('ollama')
    expect(parsed.providerInstanceId).toBe('ollama_local')
    expect(parsed.modelSelection?.instanceId).toBe('ollama_local')
  })
})

describe('ProviderSendTurnInput', () =>
{
  it('accepts claude modelSelection including ultrathink', () =>
  {
    const parsed = decodeProviderSendTurnInput({
      threadId: 'thread-1',
      modelSelection: {
        provider: 'claudeAgent',
        model: 'claude-sonnet-4-6',
        options: [
          { id: 'effort', value: 'ultrathink' },
          { id: 'fastMode', value: true },
        ],
      },
    })

    expect(parsed.modelSelection?.instanceId).toBe('claudeAgent')
    expect(getOptionValue(parsed.modelSelection?.options, 'effort')).toBe('ultrathink')
    expect(getOptionValue(parsed.modelSelection?.options, 'fastMode')).toBe(true)
  })
})

describe('providerInstanceId routing key (slice-2 invariant)', () =>
{
  it('decodes a ProviderSessionStartInput without providerInstanceId (legacy producer)', () =>
  {
    const parsed = decodeProviderSessionStartInput({
      threadId: 'thread-1',
      provider: 'codex',
      runtimeMode: 'full-access',
    })
    expect(parsed.providerInstanceId).toBeUndefined()
  })

  it('decodes a ProviderSessionStartInput with providerInstanceId (post-migration producer)', () =>
  {
    const parsed = decodeProviderSessionStartInput({
      threadId: 'thread-1',
      provider: 'codex',
      providerInstanceId: 'codex_personal',
      runtimeMode: 'full-access',
    })
    expect(parsed.providerInstanceId).toBe('codex_personal')
  })

  it('propagates providerInstanceId through ProviderSession decode', () =>
  {
    const session = decodeProviderSession({
      provider: 'codex',
      providerInstanceId: 'codex_work',
      status: 'ready',
      runtimeMode: 'full-access',
      threadId: 'thread-1',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    })
    expect(session.providerInstanceId).toBe('codex_work')
  })

  it('decodes ProviderSession for fork-provided driver kinds', () =>
  {
    const session = decodeProviderSession({
      provider: 'ollama',
      providerInstanceId: 'ollama_local',
      status: 'ready',
      runtimeMode: 'full-access',
      threadId: 'thread-1',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    })

    expect(session.provider).toBe('ollama')
    expect(session.providerInstanceId).toBe('ollama_local')
  })

  it('decodes a ProviderEvent carrying both legacy provider and new instance routing', () =>
  {
    const event = decodeProviderEvent({
      id: 'event-1',
      kind: 'notification',
      provider: 'codex',
      providerInstanceId: 'codex_personal',
      threadId: 'thread-1',
      createdAt: '2024-01-01T00:00:00Z',
      method: 'session.created',
    })
    expect(event.provider).toBe('codex')
    expect(event.providerInstanceId).toBe('codex_personal')
  })

  it('rejects providerInstanceId values that fail the slug pattern (defense in depth)', () =>
  {
    expect(() =>
      decodeProviderSessionStartInput({
        threadId: 'thread-1',
        provider: 'codex',
        providerInstanceId: '1bad',
        runtimeMode: 'full-access',
      }),
    ).toThrow()
  })
})
