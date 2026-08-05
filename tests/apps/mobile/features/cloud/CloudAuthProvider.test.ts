// tests/apps/mobile/features/cloud/CloudAuthProvider.test.ts
// verify cloud auth provider relay account isolation behavior

import { managedRelaySessionAtom } from '@t3tools/client-runtime/relay'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { appAtomRegistry } from '../../../../../apps/mobile/src/state/atom-registry'
import {
  activateCloudRelayAccount,
  deactivateCloudRelayAccount,
} from '../../../../../apps/mobile/src/features/cloud/CloudAuthProvider'
import { setAgentAwarenessRelayTokenProvider } from '../../../../../apps/mobile/src/features/agent-awareness/remoteRegistration'

vi.mock('@clerk/expo', () => ({
  ClerkProvider: vi.fn(),
  useAuth: vi.fn(),
}))

vi.mock('@clerk/expo/token-cache', () => ({
  tokenCache: {},
}))

vi.mock('../../../../../apps/mobile/src/lib/runtime', () => ({
  runtime: {
    runPromiseExit: vi.fn(),
  },
}))

vi.mock('../../../../../apps/mobile/src/connection/catalog', () => ({
  environmentCatalog: {
    removeRelayEnvironments: {},
  },
}))

vi.mock('../../../../../apps/mobile/src/features/cloud/publicConfig', () => ({
  resolveCloudPublicConfig: vi.fn(() => ({
    clerk: { publishableKey: null },
    relay: { url: null },
  })),
  resolveRelayClerkTokenOptions: vi.fn(),
}))

vi.mock('../../../../../apps/mobile/src/features/agent-awareness/remoteRegistration', () => ({
  setAgentAwarenessRelayTokenProvider: vi.fn(),
  unregisterAgentAwarenessDeviceForCurrentUser: vi.fn(),
}))

afterEach(() =>
{
  deactivateCloudRelayAccount()
  vi.clearAllMocks()
})

describe('CloudAuthProvider relay account isolation', () =>
{
  it('clears relay and agent-awareness credentials before cleanup can fail', async () =>
  {
    const tokenProvider = async () => 'account-1-token'
    activateCloudRelayAccount('account-1', tokenProvider)
    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe('account-1')

    deactivateCloudRelayAccount()
    const cleanup = Promise.reject(new Error('Persistence removal failed.')).catch(() => undefined)

    expect(appAtomRegistry.get(managedRelaySessionAtom)).toBeNull()
    expect(vi.mocked(setAgentAwarenessRelayTokenProvider)).toHaveBeenLastCalledWith(null)
    await cleanup
  })
})
