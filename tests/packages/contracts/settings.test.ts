// tests/packages/contracts/settings.test.ts
// verifies settings schema defaults and patches
import { describe, expect, it } from 'vite-plus/test'
import * as Schema from 'effect/Schema'

import {
  ProviderDriverKind,
  ProviderInstanceId,
} from '../../../packages/contracts/src/providerInstance.ts'
import {
  ClientSettingsSchema,
  ClientSettingsPatch,
  defaultEnabledForDriver,
  resolveProviderInstanceEnabled,
  ServerSettings,
  ServerSettingsPatch,
} from '../../../packages/contracts/src/settings.ts'

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema)
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch)
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings)
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch)
const encodeServerSettings = Schema.encodeSync(ServerSettings)

describe('ClientSettings word wrap', () =>
{
  it('defaults word wrap on and ignores obsolete wrapping preferences', () =>
  {
    expect(decodeClientSettings({}).wordWrap).toBe(true)

    const decoded = decodeClientSettings({
      chatWordWrap: false,
      diffWordWrap: false,
    })

    expect(decoded.wordWrap).toBe(true)
    expect(decoded).not.toHaveProperty('chatWordWrap')
    expect(decoded).not.toHaveProperty('diffWordWrap')
  })
})

describe('ClientSettings browser defaults', () =>
{
  it('decodes defaults and accepts one bounded preferences patch', () =>
  {
    const settings = decodeClientSettings({})
    expect(settings.browserDefaultViewport).toEqual({ _tag: 'fill' })
    expect(settings.browserDefaultZoomFactor).toBe(1)
    expect(settings.browserDefaultAppearance).toBe('system')
    expect(settings.browserAutoShowFloatingPreview).toBe(true)

    expect(
      decodeClientSettingsPatch({
        browserDefaultViewport: {
          _tag: 'preset',
          width: 1024,
          height: 600,
          presetId: 'nest-hub',
        },
        browserDefaultZoomFactor: 1.25,
        browserDefaultAppearance: 'dark',
        browserAutoShowFloatingPreview: false,
      }),
    ).toEqual({
      browserDefaultViewport: {
        _tag: 'preset',
        width: 1024,
        height: 600,
        presetId: 'nest-hub',
      },
      browserDefaultZoomFactor: 1.25,
      browserDefaultAppearance: 'dark',
      browserAutoShowFloatingPreview: false,
    })
  })
})

describe('ClientSettings glass opacity', () =>
{
  it('defaults to a readable translucent surface', () =>
  {
    expect(decodeClientSettings({}).glassOpacity).toBe(80)
  })

  it.each([
    { value: 39, valid: false },
    { value: 101, valid: false },
    { value: 72.5, valid: false },
    { value: 40, valid: true },
    { value: 100, valid: true },
  ])('$valid ? accepts : rejects glass opacity $value', ({ value, valid }) =>
  {
    if (valid)
    {
      expect(decodeClientSettings({ glassOpacity: value }).glassOpacity).toBe(value)
      expect(decodeClientSettingsPatch({ glassOpacity: value }).glassOpacity).toBe(value)
      return
    }
    expect(() => decodeClientSettings({ glassOpacity: value })).toThrow()
    expect(() => decodeClientSettingsPatch({ glassOpacity: value })).toThrow()
  })
})

describe('ClientSettings sidebar v2', () =>
{
  it('keeps unpin confirmation opt-in and patchable', () =>
  {
    expect(decodeClientSettings({}).confirmThreadUnpin).toBe(false)
    expect(decodeClientSettingsPatch({ confirmThreadUnpin: true })).toEqual({
      confirmThreadUnpin: true,
    })
    expect(() => decodeClientSettingsPatch({ confirmThreadUnpin: 'yes' })).toThrow()
  })

  it('defaults the beta off with a three-day threshold and merged-PR settling on', () =>
  {
    const settings = decodeClientSettings({})
    expect(settings.sidebarV2Enabled).toBe(false)
    expect(settings.sidebarAutoSettleAfterDays).toBe(3)
    expect(settings.sidebarAutoSettleOnMerge).toBe(true)
    expect(decodeClientSettingsPatch({ sidebarAutoSettleOnMerge: false })).toEqual({
      sidebarAutoSettleOnMerge: false,
    })
  })

  it.each([
    {
      label: 'allows disabling auto-settle',
      value: null,
      expectValid: true,
      expected: null,
    },
    {
      label: 'rejects threshold below minimum',
      value: -1,
      expectValid: false,
      expected: undefined,
    },
    {
      label: 'rejects threshold above maximum',
      value: 91,
      expectValid: false,
      expected: undefined,
    },
  ])('$label', ({ value, expectValid, expected }) =>
  {
    if (expectValid)
    {
      expect(
        decodeClientSettings({ sidebarAutoSettleAfterDays: value }).sidebarAutoSettleAfterDays,
      ).toBe(expected)
      return
    }
    expect(() => decodeClientSettings({ sidebarAutoSettleAfterDays: value })).toThrow()
    expect(() => decodeClientSettingsPatch({ sidebarAutoSettleAfterDays: value })).toThrow()
  })
})

describe('ServerSettings.providerInstances (slice-2 invariant)', () =>
{
  it('decodes a fully empty config (legacy on-disk shape) without complaint', () =>
  {
    const decoded = decodeServerSettings({})
    expect(decoded.providerInstances).toEqual({})
    // legacy `providers` struct is still hydrated with its per-driver defaults
    // so existing call sites keep working through the migration.
    expect(decoded.providers.codex.enabled).toBe(true)
    expect(decoded.providers.coral).toEqual({
      enabled: false,
      binaryPath: 'coral',
      ollamaHost: 'http://localhost:11434',
      homePath: '',
    })
  })
})

describe('ServerSettings provider access defaults', () =>
{
  it('enables cursor by default while grok and opencode stay opt-in', () =>
  {
    const settings = decodeServerSettings({})
    expect(settings.providers.codex.enabled).toBe(true)
    expect(settings.providers.claudeAgent.enabled).toBe(true)
    expect(settings.providers.cursor.enabled).toBe(true)
    expect(settings.providers.grok.enabled).toBe(false)
    expect(settings.providers.gemini.enabled).toBe(false)
    expect(settings.providers.antigravity).toEqual({
      enabled: false,
      binaryPath: 'agy',
      agent: '',
      sandbox: true,
      customModels: [],
    })
    expect(settings.providers.opencode.enabled).toBe(false)
    expect(settings.enableAgentBrowserAccess).toBe(true)
    expect(decodeServerSettingsPatch({ enableAgentBrowserAccess: false })).toMatchObject({
      enableAgentBrowserAccess: false,
    })

    expect(defaultEnabledForDriver(ProviderDriverKind.make('cursor'))).toBe(true)
    const grok = ProviderDriverKind.make('grok')
    expect(defaultEnabledForDriver(grok)).toBe(false)
    expect(resolveProviderInstanceEnabled({ driver: grok, config: {} })).toBe(false)
    expect(resolveProviderInstanceEnabled({ driver: grok, enabled: true, config: {} })).toBe(true)
    expect(
      resolveProviderInstanceEnabled({ driver: grok, enabled: true, config: { enabled: false } }),
    ).toBe(false)
    const gemini = ProviderDriverKind.make('gemini')
    expect(defaultEnabledForDriver(gemini)).toBe(false)
    expect(resolveProviderInstanceEnabled({ driver: gemini, config: {} })).toBe(false)
    expect(resolveProviderInstanceEnabled({ driver: gemini, enabled: true, config: {} })).toBe(true)
  })
})

describe('ServerSettings worktree defaults', () =>
{
  it('defaults start-from-origin on and accepts updates', () =>
  {
    expect(decodeServerSettings({}).newWorktreesStartFromOrigin).toBe(true)
    expect(
      decodeServerSettingsPatch({ newWorktreesStartFromOrigin: false }).newWorktreesStartFromOrigin,
    ).toBe(false)
  })
})

describe('ServerSettings architecture analysis', () =>
{
  it('defaults legacy configs to on-demand analysis', () =>
  {
    expect(decodeServerSettings({}).architectureAutoAnalysis).toBe('on-demand')
  })

  it.each(['off', 'on-demand', 'auto'] as const)(
    'accepts the %s mode in settings and patches',
    (mode) =>
    {
      expect(
        decodeServerSettings({ architectureAutoAnalysis: mode }).architectureAutoAnalysis,
      ).toBe(mode)
      expect(
        decodeServerSettingsPatch({ architectureAutoAnalysis: mode }).architectureAutoAnalysis,
      ).toBe(mode)
    },
  )

  it('rejects architecture analysis modes outside the frozen contract', () =>
  {
    expect(() => decodeServerSettings({ architectureAutoAnalysis: 'manual' })).toThrow()
    expect(() => decodeServerSettingsPatch({ architectureAutoAnalysis: 'manual' })).toThrow()
  })
})

describe('ServerSettings.sourceControlWritingStyle', () =>
{
  it('defaults all style settings for legacy configs', () =>
  {
    const settings = decodeServerSettings({})

    expect(settings.sourceControlWritingStyle).toEqual({
      mode: 'repo_conventions',
      customInstructions: '',
      followChangeRequestTemplates: true,
    })
    expect(settings.sourceControlWriterModelSelection).toBeNull()
  })

  it('trims partial style updates', () =>
  {
    const patch = decodeServerSettingsPatch({
      sourceControlWritingStyle: {
        mode: 'custom',
        customInstructions: '  Prefer concise wording.  ',
      },
    })

    expect(patch.sourceControlWritingStyle).toEqual({
      mode: 'custom',
      customInstructions: 'Prefer concise wording.',
    })
  })
})

describe('ServerSettingsPatch.providerInstances', () =>
{
  it('treats providerInstances as an optional whole-map replacement', () =>
  {
    const patch = decodeServerSettingsPatch({})
    expect(patch.providerInstances).toBeUndefined()

    const replacement = decodeServerSettingsPatch({
      providerInstances: {
        codex_personal: { driver: 'codex', config: { homePath: '~/.codex' } },
        ollama_local: {
          driver: 'ollama',
          config: { endpoint: 'http://localhost:11434' },
        },
      },
    })
    expect(replacement.providerInstances).toBeDefined()
    expect(replacement.providerInstances?.[ProviderInstanceId.make('codex_personal')]?.driver).toBe(
      'codex',
    )
    // fork/unknown drivers must survive whole-map replacement patches opaquely.
    expect(replacement.providerInstances?.[ProviderInstanceId.make('ollama_local')]?.driver).toBe(
      'ollama',
    )
  })
})

describe('ServerSettingsPatch string normalization', () =>
{
  it('trims string settings while decoding patches', () =>
  {
    const patch = decodeServerSettingsPatch({
      addProjectBaseDirectory: '  ~/Development  ',
      textGenerationModelSelection: { model: '  gpt-5.4-mini  ' },
      observability: {
        otlpTracesUrl: '  http://localhost:4318/v1/traces  ',
      },
      providers: {
        codex: {
          binaryPath: '  /opt/homebrew/bin/codex  ',
          homePath: '  ~/.codex  ',
          launchArgs: '  --strict-config --enable foo  ',
        },
      },
      providerInstances: {
        codex_personal: {
          driver: '  codex  ',
          displayName: '  Codex Personal  ',
          config: { homePath: '  ~/.codex-personal  ' },
        },
      },
    })

    expect(patch.addProjectBaseDirectory).toBe('~/Development')
    expect(patch.textGenerationModelSelection?.model).toBe('gpt-5.4-mini')
    expect(patch.observability?.otlpTracesUrl).toBe('http://localhost:4318/v1/traces')
    expect(patch.providers?.codex?.binaryPath).toBe('/opt/homebrew/bin/codex')
    expect(patch.providers?.codex?.homePath).toBe('~/.codex')
    expect(patch.providers?.codex?.launchArgs).toBe('--strict-config --enable foo')
    expect(patch.providerInstances?.[ProviderInstanceId.make('codex_personal')]?.driver).toBe(
      'codex',
    )
    expect(patch.providerInstances?.[ProviderInstanceId.make('codex_personal')]?.displayName).toBe(
      'Codex Personal',
    )
    expect(patch.providerInstances?.[ProviderInstanceId.make('codex_personal')]?.config).toEqual({
      homePath: '  ~/.codex-personal  ',
    })
  })

  it('trims encoded server settings values before validation', () =>
  {
    const defaultSettings = decodeServerSettings({})
    const encoded = encodeServerSettings({
      ...defaultSettings,
      addProjectBaseDirectory: '  ~/Development  ',
      providers: {
        ...defaultSettings.providers,
        codex: {
          ...defaultSettings.providers.codex,
          binaryPath: '  /opt/homebrew/bin/codex  ',
          launchArgs: '  --strict-config  ',
        },
      },
    })

    expect(encoded.addProjectBaseDirectory).toBe('~/Development')
    expect(encoded.providers?.codex?.binaryPath).toBe('/opt/homebrew/bin/codex')
    expect(encoded.providers?.codex?.launchArgs).toBe('--strict-config')
  })
})
