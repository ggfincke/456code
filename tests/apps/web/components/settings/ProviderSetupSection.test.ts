// tests/apps/web/components/settings/ProviderSetupSection.test.ts
// verify Antigravity runtime settings helpers

import { describe, expect, it, vi } from 'vite-plus/test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from '@t3tools/contracts'

import {
  readAntigravityOfficialRuntime,
  ProviderSetupSection,
  withAntigravityOfficialRuntime,
} from '../../../../../apps/web/src/components/settings/ProviderSetupSection'

const installation = vi.hoisted(() => ({
  phase: 'extracting',
  message: 'Extracting Antigravity.',
  operationId: null,
}))
vi.mock('../../../../../apps/web/src/state/query', () => ({
  useEnvironmentQuery: (query: unknown) => ({ data: query ? installation : null, error: null }),
}))

describe('ProviderSetupSection runtime settings', () =>
{
  it('announces duplicate install status once while retaining a distinct runtime detail', () =>
  {
    const instanceId = ProviderInstanceId.make('antigravity')
    const provider: ServerProvider = {
      instanceId,
      driver: ProviderDriverKind.make('antigravity'),
      enabled: true,
      installed: false,
      version: null,
      status: 'error',
      auth: { status: 'unauthenticated' },
      checkedAt: '2026-09-09T12:00:00.000Z',
      models: [],
      slashCommands: [],
      skills: [],
      setup: { canInstall: true, canAuthenticate: true },
    }
    const render = () =>
      renderToStaticMarkup(
        createElement(ProviderSetupSection, {
          environmentId: EnvironmentId.make('environment-test'),
          environmentLabel: 'Test host',
          instanceId,
          provider,
          config: {},
          enabled: true,
          onEnable: () => undefined,
          onConfigChange: () => undefined,
        }),
      )
    expect(render().match(/Extracting Antigravity\./g)).toHaveLength(1)
    installation.message = 'Validating the downloaded signature.'
    const distinct = render()
    expect(distinct.match(/Extracting Antigravity\./g)).toHaveLength(1)
    expect(distinct).toContain(installation.message)
    installation.message = 'Extracting Antigravity.'
  })
  it('defaults missing and malformed runtime settings to managed mode', () =>
  {
    expect(readAntigravityOfficialRuntime(undefined)).toEqual({ mode: 'managed' })
    expect(readAntigravityOfficialRuntime({ officialRuntime: { mode: 'custom' } })).toEqual({
      mode: 'managed',
    })
  })

  it('preserves legacy settings while selecting a trimmed custom executable', () =>
  {
    const config = withAntigravityOfficialRuntime(
      { binaryPath: 'agy', agent: 'legacy', sandbox: true },
      { mode: 'custom', executablePath: '/opt/antigravity-acp' },
    )

    expect(config).toEqual({
      binaryPath: 'agy',
      agent: 'legacy',
      sandbox: true,
      officialRuntime: { mode: 'custom', executablePath: '/opt/antigravity-acp' },
    })
    expect(readAntigravityOfficialRuntime(config)).toEqual({
      mode: 'custom',
      executablePath: '/opt/antigravity-acp',
    })
  })
})
