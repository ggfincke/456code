// tests/apps/mobile/features/settings/provider-setup-state.test.ts
// verify mobile Antigravity setup and transition state

import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationSession,
  type ServerProvider,
} from '@t3tools/contracts'
import { describe, expect, it } from 'vite-plus/test'

import {
  antigravityInstancePatch,
  providerNeedsSetup,
  readAntigravityOfficialRuntime,
  resolveLegacyAntigravityTransition,
} from '../../../../../apps/mobile/src/features/settings/provider-setup-state'

const instanceId = ProviderInstanceId.make('antigravity')

function antigravityProvider(): ServerProvider
{
  return {
    instanceId,
    driver: ProviderDriverKind.make('antigravity'),
    displayName: 'Antigravity',
    enabled: true,
    installed: false,
    version: null,
    status: 'warning',
    auth: { status: 'unauthenticated' },
    setup: { canAuthenticate: true, canInstall: true },
    checkedAt: '2026-09-08T12:00:00.000Z',
    models: [],
    slashCommands: [],
    skills: [],
  }
}

describe('mobile Antigravity setup state', () =>
{
  it('promotes the legacy slot without dropping legacy config', () =>
  {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        antigravity: {
          ...DEFAULT_SERVER_SETTINGS.providers.antigravity,
          binaryPath: 'agy-custom',
          agent: 'legacy-agent',
          sandbox: false,
        },
      },
    }
    const patch = antigravityInstancePatch(settings, antigravityProvider(), {
      officialRuntime: { mode: 'custom', executablePath: '/opt/antigravity-acp' },
    })

    expect(patch?.providerInstances?.[instanceId]?.config).toMatchObject({
      binaryPath: 'agy-custom',
      agent: 'legacy-agent',
      sandbox: false,
      officialRuntime: { mode: 'custom', executablePath: '/opt/antigravity-acp' },
    })
    expect(readAntigravityOfficialRuntime(patch?.providerInstances?.[instanceId]?.config)).toEqual({
      mode: 'custom',
      executablePath: '/opt/antigravity-acp',
    })
    expect(providerNeedsSetup(antigravityProvider())).toBe(true)
  })

  it('exposes a fresh transition only for a projected legacy binding', () =>
  {
    const session = {
      threadId: ThreadId.make('thread-1'),
      status: 'idle',
      providerName: 'Antigravity',
      providerInstanceId: instanceId,
      runtimeMode: 'full-access',
      activeTurnId: null,
      lastError: null,
      continuationIncompatibility: {
        currentSource: 'antigravity.stream-json',
        requiredSource: 'antigravity.official-acp',
        bindingGeneration: 'binding-7',
      },
      updatedAt: '2026-09-08T12:00:00.000Z',
    } satisfies OrchestrationSession

    expect(resolveLegacyAntigravityTransition(session)).toEqual({
      bindingGeneration: 'binding-7',
    })
    const { continuationIncompatibility: _omitted, ...compatibleSession } = session
    expect(resolveLegacyAntigravityTransition(compatibleSession)).toBeNull()
  })
})
