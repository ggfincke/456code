// tests/packages/contracts/environmentTheme.test.ts
// verify bounded published palettes and opt-in wire compatibility

import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vite-plus/test'
import {
  EnvironmentTheme,
  EnvironmentThemeFile,
  EnvironmentThemeId,
  ServerConfigStreamEvent,
} from '../../../packages/contracts/src/server.ts'
import { ExecutionEnvironmentCapabilities } from '../../../packages/contracts/src/environment.ts'
import { ServerSettings, ServerSettingsPatch } from '../../../packages/contracts/src/settings.ts'
import { WsSubscribeServerConfigRpc } from '../../../packages/contracts/src/rpc.ts'

const decodeFile = Schema.decodeUnknownSync(EnvironmentThemeFile)
const decodeTheme = Schema.decodeUnknownSync(EnvironmentTheme)
const isThemeId = Schema.is(EnvironmentThemeId)
const isThemeFile = Schema.is(EnvironmentThemeFile)
const decodeSubscription = Schema.decodeUnknownSync(WsSubscribeServerConfigRpc.payloadSchema)
const decodeCapabilities = Schema.decodeUnknownSync(ExecutionEnvironmentCapabilities)
const decodeSettings = Schema.decodeUnknownSync(ServerSettings)
const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch)
const decodeEvent = Schema.decodeUnknownSync(ServerConfigStreamEvent)

describe('environment themes', () =>
{
  it('preserves bounded future roles without accepting unsafe identities or malformed colors', () =>
  {
    const file = {
      version: 1,
      name: 'Nightfall',
      appearance: 'dark',
      colors: { futureRole: 'oklch(0.5 0.1 120)' },
      variants: { light: { canvas: '#fff' } },
    }
    expect(decodeFile({ ...file, id: 'ignored' })).toEqual(file)
    expect(decodeTheme({ ...file, id: 'nightfall' }).id).toBe('nightfall')
    for (const id of ['system', 'light', 'dark', 'ocean', '../other', 'a'.repeat(49)])
      expect(isThemeId(id)).toBe(false)
    expect(isThemeFile({ ...file, colors: { validRole: 'x'.repeat(65) } })).toBe(false)
    expect(isThemeFile({ ...file, canvas: 'url(https://example.com)' })).toBe(false)
    expect(isThemeFile({ ...file, name: 'x'.repeat(49) })).toBe(false)
  })

  it('keeps legacy subscriptions valid and theme defaults out of generic patches', () =>
  {
    expect(decodeSubscription({})).toEqual({})
    expect(
      decodeSubscription({
        environmentThemes: true,
      }),
    ).toEqual({ environmentThemes: true })
    expect(decodeCapabilities({}).environmentThemes).toBeUndefined()
    const settings = decodeSettings({})
    expect([settings.defaultTheme, settings.defaultThemeSetAt]).toEqual(['', ''])
    expect(
      decodePatch({
        defaultTheme: 'ocean',
        defaultThemeSetAt: 'generation',
      }),
    ).toEqual({})
    expect(
      decodeEvent({
        version: 1,
        type: 'environmentThemesUpdated',
        payload: { themes: [] },
      }),
    ).toEqual({ version: 1, type: 'environmentThemesUpdated', payload: { themes: [] } })
  })
})
