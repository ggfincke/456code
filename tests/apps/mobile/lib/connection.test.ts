// tests/apps/mobile/lib/connection.test.ts
// verify mobile remote connection records behavior

import { describe, expect, it, vi } from 'vite-plus/test'

import {
  isRelayManagedConnection,
  authClientMetadata,
  redactPairingCredential,
} from '../../../../apps/mobile/src/lib/connection'

vi.mock('../../../../apps/mobile/src/lib/runtime', () => ({
  runtime: {
    runPromise: vi.fn(),
  },
}))

vi.mock('react-native', () => ({
  Platform: {
    OS: 'ios',
  },
}))

describe('mobile remote connection records', () =>
{
  it('identifies mobile token exchanges for authorized-client presentation', () =>
  {
    expect(authClientMetadata()).toEqual({
      label: '456code Mobile',
      deviceType: 'mobile',
      os: 'iOS',
    })
  })

  it('removes one-time bootstrap credentials before persisting pairing URLs', () =>
  {
    expect(redactPairingCredential('https://desktop.example/#token=bootstrap-token')).toBe(
      'https://desktop.example/',
    )
    expect(redactPairingCredential('https://desktop.example/?token=bootstrap-token')).toBe(
      'https://desktop.example/',
    )
  })

  it('removes hosted pairing credentials while keeping the advertised host', () =>
  {
    expect(
      redactPairingCredential(
        'https://app.t3.codes/pair?host=https%3A%2F%2Fdesktop.example&token=bootstrap-token&label=Desktop',
      ),
    ).toBe('https://app.t3.codes/pair?host=https%3A%2F%2Fdesktop.example&label=Desktop')
  })

  it('keeps existing DPoP tunnel records read-only after upgrading', () =>
  {
    expect(isRelayManagedConnection({ relayManaged: true })).toBe(true)
    expect(isRelayManagedConnection({ authenticationMethod: 'dpop' })).toBe(true)
    expect(isRelayManagedConnection({ authenticationMethod: 'bearer' })).toBe(false)
  })
})
