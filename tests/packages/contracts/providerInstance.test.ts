// tests/packages/contracts/providerInstance.test.ts
// verifies provider instance schema and continuation identity contracts
import { describe, expect, it } from 'vite-plus/test'
import * as Schema from 'effect/Schema'

import {
  ProviderDriverKind,
  ProviderInstanceConfig,
  ProviderInstanceConfigMap,
  ProviderInstanceId,
  ProviderInstanceRef,
} from '../../../packages/contracts/src/providerInstance.ts'

const decodeProviderDriverKind = Schema.decodeUnknownSync(ProviderDriverKind)
const decodeProviderInstanceId = Schema.decodeUnknownSync(ProviderInstanceId)
const decodeProviderInstanceRef = Schema.decodeUnknownSync(ProviderInstanceRef)
const decodeProviderInstanceConfig = Schema.decodeUnknownSync(ProviderInstanceConfig)
const decodeProviderInstanceConfigMap = Schema.decodeUnknownSync(ProviderInstanceConfigMap)

describe('provider slug validation (shared by driver + instance ids)', () =>
{
  const schemas = [
    { schemaName: 'ProviderInstanceId', decode: decodeProviderInstanceId },
    { schemaName: 'ProviderDriverKind', decode: decodeProviderDriverKind },
  ] as const

  it.each(
    schemas.flatMap(({ schemaName, decode }) =>
      [
        { label: 'accepts codex_work', value: 'codex_work', expectValid: true },
        { label: 'rejects empty string', value: '', expectValid: false },
        { label: 'rejects leading digit', value: '1codex', expectValid: false },
        { label: 'rejects whitespace inside', value: 'codex personal', expectValid: false },
      ].map((row) => ({ schemaName, decode, ...row })),
    ),
  )('$schemaName $label', ({ decode, value, expectValid }) =>
  {
    if (expectValid)
    {
      expect(decode(value)).toBe(value)
    }
    else
    {
      expect(() => decode(value)).toThrow()
    }
  })

  it('trims surrounding whitespace before validating', () =>
  {
    for (const { decode } of schemas)
    {
      expect(decode('  codex_work  ')).toBe('codex_work')
    }
  })

  it('rejects ids longer than 64 characters', () =>
  {
    const tooLong = 'a'.repeat(65)
    const justRight = 'a'.repeat(64)
    for (const { decode } of schemas)
    {
      expect(() => decode(tooLong)).toThrow()
      expect(decode(justRight)).toBe(justRight)
    }
  })
})

describe('ProviderInstanceRef', () =>
{
  it('decodes a driver ref', () =>
  {
    const ref = decodeProviderInstanceRef({
      instanceId: 'codex_work',
      driver: 'codex',
    })
    expect(ref.instanceId).toBe('codex_work')
    expect(ref.driver).toBe('codex')
  })

  it('rejects refs whose driver field is not a valid slug', () =>
  {
    expect(() =>
      decodeProviderInstanceRef({
        instanceId: 'codex',
        driver: '1nope',
      }),
    ).toThrow()
  })
})

describe('ProviderInstanceConfig', () =>
{
  it('accepts a minimal config envelope for a driver', () =>
  {
    const decoded = decodeProviderInstanceConfig({ driver: 'codex' })
    expect(decoded.driver).toBe('codex')
    expect(decoded.displayName).toBeUndefined()
    expect(decoded.enabled).toBeUndefined()
    expect(decoded.config).toBeUndefined()
  })

  it('preserves driver-opaque config payloads verbatim', () =>
  {
    const opaqueConfig = { homePath: '~/.codex_personal', binaryPath: 'codex' }
    const decoded = decodeProviderInstanceConfig({
      driver: 'codex',
      displayName: 'Codex (personal)',
      accentColor: '#dc2626',
      enabled: true,
      config: opaqueConfig,
    })
    expect(decoded.displayName).toBe('Codex (personal)')
    expect(decoded.accentColor).toBe('#dc2626')
    expect(decoded.enabled).toBe(true)
    expect(decoded.config).toEqual(opaqueConfig)
  })

  it('trims provider instance envelope fields', () =>
  {
    const decoded = decodeProviderInstanceConfig({
      driver: '  codex  ',
      displayName: '  Codex Personal  ',
      accentColor: '  #dc2626  ',
      environment: [{ name: '  OPENROUTER_API_KEY  ', value: '  sk-or-test  ' }],
    })

    expect(decoded).toMatchObject({
      driver: 'codex',
      displayName: 'Codex Personal',
      accentColor: '#dc2626',
      environment: [{ name: 'OPENROUTER_API_KEY', value: '  sk-or-test  ' }],
    })
  })

  it('decodes generic environment variables on the instance envelope', () =>
  {
    const decoded = decodeProviderInstanceConfig({
      driver: 'claudeAgent',
      environment: [
        { name: 'ANTHROPIC_BASE_URL', value: 'https://openrouter.ai/api', sensitive: false },
        { name: 'OPENROUTER_API_KEY', value: 'sk-or-test', sensitive: true },
        { name: 'ANTHROPIC_API_KEY', value: '', sensitive: false },
      ],
    })

    expect(decoded.environment).toEqual([
      { name: 'ANTHROPIC_BASE_URL', value: 'https://openrouter.ai/api', sensitive: false },
      { name: 'OPENROUTER_API_KEY', value: 'sk-or-test', sensitive: true },
      { name: 'ANTHROPIC_API_KEY', value: '', sensitive: false },
    ])
  })

  it('rejects invalid environment variable names', () =>
  {
    expect(() =>
      decodeProviderInstanceConfig({
        driver: 'codex',
        environment: [{ name: 'HAS-DASH', value: 'x', sensitive: false }],
      }),
    ).toThrow()
  })

  it('decodes envelopes that name an unknown driver and preserves their config opaquely', () =>
  {
    const opaqueConfig = { someUnknownKnob: 42, model: 'llama3' }
    const decoded = decodeProviderInstanceConfig({
      driver: 'ollama',
      displayName: 'Ollama',
      enabled: true,
      config: opaqueConfig,
    })
    expect(decoded.driver).toBe('ollama')
    expect(decoded.config).toEqual(opaqueConfig)
  })

  it('rejects a blank displayName (must be trimmed non-empty)', () =>
  {
    expect(() => decodeProviderInstanceConfig({ driver: 'codex', displayName: '   ' })).toThrow()
  })

  it('rejects driver values that do not satisfy the slug pattern', () =>
  {
    expect(() => decodeProviderInstanceConfig({ driver: '' })).toThrow()
    expect(() => decodeProviderInstanceConfig({ driver: 'has spaces' })).toThrow()
  })
})

describe('ProviderInstanceConfigMap', () =>
{
  it('decodes a multi-instance map mixing first-party and fork drivers', () =>
  {
    const decoded = decodeProviderInstanceConfigMap({
      codex_personal: {
        driver: 'codex',
        displayName: 'Codex (personal)',
        config: { homePath: '~/.codex_personal' },
      },
      codex_work: {
        driver: 'codex',
        config: { homePath: '~/.codex_work' },
      },
      claudeAgent: { driver: 'claudeAgent' },
      ollama_local: { driver: 'ollama', config: { endpoint: 'http://localhost:11434' } },
    })
    expect(new Set(Object.keys(decoded))).toEqual(
      new Set(['claudeAgent', 'codex_personal', 'codex_work', 'ollama_local']),
    )
    expect(decoded[ProviderInstanceId.make('codex_personal')]?.driver).toBe('codex')
    expect(decoded[ProviderInstanceId.make('codex_work')]?.config).toEqual({
      homePath: '~/.codex_work',
    })
    expect(decoded[ProviderInstanceId.make('ollama_local')]?.driver).toBe('ollama')
  })

  it('rejects keys that fail the instance-id pattern', () =>
  {
    expect(() =>
      decodeProviderInstanceConfigMap({
        '1codex': { driver: 'codex' },
      }),
    ).toThrow()
  })
})
