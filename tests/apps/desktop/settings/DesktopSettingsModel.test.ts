// tests/apps/desktop/settings/DesktopSettingsModel.test.ts
// verify desktop settings model behavior

import { assert, describe, it } from '@effect/vitest'

import * as DesktopSettingsModel from '../../../../apps/desktop/src/settings/DesktopSettingsModel.ts'

describe('DesktopSettingsModel', () =>
{
  it('resolves stable and nightly defaults without changing other settings', () =>
  {
    const stableDefaults = {
      mainWindowBounds: null,
      mainWindowMaximized: false,
      serverExposureMode: 'local-only',
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
      updateChannel: 'latest',
      updateChannelConfiguredByUser: false,
      wslBackendEnabled: false,
      wslDistro: null,
      wslOnly: false,
    } satisfies DesktopSettingsModel.DesktopSettings

    assert.deepEqual(DesktopSettingsModel.DEFAULT_DESKTOP_SETTINGS, stableDefaults)
    assert.deepEqual(DesktopSettingsModel.resolveDefaultDesktopSettings('0.0.28'), stableDefaults)
    assert.deepEqual(
      DesktopSettingsModel.resolveDefaultDesktopSettings('0.0.28-nightly.20260809.1'),
      {
        ...stableDefaults,
        updateChannel: 'nightly',
      },
    )
  })

  it('normalizes settings inputs through the shared domain rules', () =>
  {
    const validBounds = { x: -1200, y: 40, width: 840, height: 620 }
    assert.deepEqual(DesktopSettingsModel.normalizeMainWindowBounds(validBounds), validBounds)
    assert.isNull(DesktopSettingsModel.normalizeMainWindowBounds({ ...validBounds, width: 839 }))
    assert.equal(DesktopSettingsModel.normalizeTailscaleServePort(8443), 8443)
    assert.equal(DesktopSettingsModel.normalizeTailscaleServePort(0), 443)
    assert.equal(DesktopSettingsModel.normalizeWslDistro('Ubuntu-22.04'), 'Ubuntu-22.04')
    assert.isNull(DesktopSettingsModel.normalizeWslDistro('bad/name'))
  })
})
