// tests/apps/mobile/state/threads/use-thread-provider-switch.test.ts
// verifies confirmed provider switches reset runtime mode safely

import { describe, expect, it, vi } from 'vite-plus/test'

vi.mock('react-native', () => ({
  Alert: { alert: vi.fn() },
}))
vi.mock('../../../../../apps/mobile/src/state/entities', () => ({}))
vi.mock('../../../../../apps/mobile/src/state/use-remote-environment-registry', () => ({}))
vi.mock('../../../../../apps/mobile/src/state/threads/use-thread-detail', () => ({}))
vi.mock('../../../../../apps/mobile/src/state/threads/use-thread-selection', () => ({}))
vi.mock('../../../../../apps/mobile/src/state/threads/threads', () => ({}))

import { resolveConfirmedProviderSwitchDraftSettings } from '../../../../../apps/mobile/src/state/threads/use-thread-provider-switch'

describe('confirmed provider switch draft settings', () =>
{
  it('applies the target provider default runtime mode only to the confirmed dispatch update', () =>
  {
    expect(
      resolveConfirmedProviderSwitchDraftSettings({
        defaultRuntimeMode: 'auto-accept-edits',
      }),
    ).toEqual({
      modelSelection: undefined,
      runtimeMode: 'auto-accept-edits',
    })
  })

  it('does not invent a runtime mode when the target has no declared default', () =>
  {
    expect(resolveConfirmedProviderSwitchDraftSettings(undefined)).toEqual({
      modelSelection: undefined,
    })
  })
})
