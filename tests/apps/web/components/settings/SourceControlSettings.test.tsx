// tests/apps/web/components/settings/SourceControlSettings.test.tsx
// verifies fallback discovery targeting and primary-only settings isolation
import { Children, isValidElement, type ReactElement } from 'react'
import * as Option from 'effect/Option'
import { EnvironmentId, type SourceControlDiscoveryResult } from '@t3tools/contracts'
import { expect, it, vi } from 'vite-plus/test'

interface TestEnvironment
{
  readonly environmentId: ReturnType<typeof EnvironmentId.make>
  readonly connection: {
    readonly phase: 'connected' | 'offline'
  }
}

const mocks = vi.hoisted(() => ({
  discovery: vi.fn(),
  discoveryAtom: { sentinel: 'source-control-discovery' },
  environments: [] as TestEnvironment[],
  primaryEnvironment: null as TestEnvironment | null,
  queryAtom: null as unknown,
  queryData: null as SourceControlDiscoveryResult | null,
  refresh: vi.fn(),
}))

vi.mock('../../../../../apps/web/src/state/environments', () => ({
  useEnvironments: () => ({ environments: mocks.environments }),
  usePrimaryEnvironment: () => mocks.primaryEnvironment,
}))

vi.mock('../../../../../apps/web/src/state/query', () => ({
  useEnvironmentQuery: (queryAtom: unknown) =>
  {
    mocks.queryAtom = queryAtom
    return {
      data: mocks.queryData,
      error: null,
      failure: null,
      isPending: false,
      hasSettled: true,
      refresh: mocks.refresh,
    }
  },
}))

vi.mock('../../../../../apps/web/src/state/sourceControl', () => ({
  sourceControlEnvironment: {
    discovery: (input: unknown) =>
    {
      mocks.discovery(input)
      return mocks.discoveryAtom
    },
  },
}))

import { ArchitectureAutoAnalysisSettings } from '../../../../../apps/web/src/components/settings/ArchitectureAutoAnalysisSettings'
import { SourceControlSettingsPanel } from '../../../../../apps/web/src/components/settings/SourceControlSettings'
import { SourceControlWritingSettingsSection } from '../../../../../apps/web/src/components/settings/SourceControlWritingSettings'

function collectElements(element: ReactElement): ReactElement[]
{
  const elements = [element]
  const props = element.props as { readonly children?: unknown }
  Children.forEach(props.children, (child) =>
  {
    if (isValidElement(child))
    {
      elements.push(...collectElements(child))
    }
  })
  return elements
}

it('scans the first connected fallback without exposing primary-only controls', () =>
{
  const disconnectedEnvironmentId = EnvironmentId.make('remote-disconnected')
  const connectedEnvironmentId = EnvironmentId.make('remote-connected')
  mocks.environments = [
    {
      environmentId: disconnectedEnvironmentId,
      connection: { phase: 'offline' },
    },
    {
      environmentId: connectedEnvironmentId,
      connection: { phase: 'connected' },
    },
  ]
  mocks.primaryEnvironment = null
  mocks.queryData = {
    versionControlSystems: [
      {
        kind: 'git',
        implemented: true,
        label: 'Git',
        status: 'available',
        version: Option.some('2.50.0'),
        installHint: 'Install Git',
        detail: Option.none(),
      },
    ],
    sourceControlProviders: [],
  }

  const elements = collectElements(SourceControlSettingsPanel())
  const gitRow = elements.find((element) =>
  {
    const props = element.props as { readonly item?: { readonly kind?: string } }
    return props.item?.kind === 'git'
  })

  expect(mocks.discovery).toHaveBeenCalledOnce()
  expect(mocks.discovery).toHaveBeenCalledWith({
    environmentId: connectedEnvironmentId,
    input: {},
  })
  expect(mocks.queryAtom).toBe(mocks.discoveryAtom)
  expect(gitRow).toBeDefined()
  expect((gitRow!.props as { readonly children?: unknown }).children).toBeUndefined()
  expect(elements.some((element) => element.type === ArchitectureAutoAnalysisSettings)).toBe(false)
  expect(elements.some((element) => element.type === SourceControlWritingSettingsSection)).toBe(
    false,
  )
})
