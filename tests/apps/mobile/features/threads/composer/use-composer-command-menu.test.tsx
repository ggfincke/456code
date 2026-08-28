// tests/apps/mobile/features/threads/composer/use-composer-command-menu.test.tsx
// verify draft command locks and suppress paths from a previous workspace

// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  CONSERVATIVE_PROVIDER_RUNTIME_CAPABILITIES,
  EnvironmentId,
  ProviderInstanceId,
  type ServerProvider,
} from '@t3tools/contracts'
import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test'

const mocks = vi.hoisted(() => ({
  searchEntries: vi.fn((input: unknown) => input),
  data: { entries: [{ path: 'old.ts', kind: 'file' as const }], truncated: false },
  onChangeDraftMessage: vi.fn(),
  onUpdateInteractionMode: vi.fn(),
  onUpdateModelSelection: vi.fn(),
}))
vi.mock('../../../../../../apps/mobile/src/state/projects', () => ({
  projectEnvironment: { searchEntries: mocks.searchEntries },
}))
vi.mock('../../../../../../apps/mobile/src/state/query', () => ({
  useEnvironmentQuery: (atom: unknown) => ({
    data: atom === null ? null : mocks.data,
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
}))

import { useComposerCommandMenu } from '../../../../../../apps/mobile/src/features/threads/composer/use-composer-command-menu'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const environmentId = EnvironmentId.make('remote')
const provider = {
  capabilities: {
    ...CONSERVATIVE_PROVIDER_RUNTIME_CAPABILITIES,
    supportedInteractionModes: ['default', 'plan'],
    orchestrateInstructionDelivery: 'prompt-prefix',
    orchestrateBaseModes: ['default', 'plan'],
  },
} as unknown as ServerProvider
const modelSelection = {
  instanceId: ProviderInstanceId.make('opencode-work'),
  model: 'github-copilot/claude',
  options: [{ id: 'reasoningEffort', value: 'high' }],
}
const modelOptions = [
  {
    key: 'opencode-work:github-copilot/claude',
    label: 'Claude',
    subtitle: 'GitHub Copilot',
    providerKey: 'opencode-work',
    providerLabel: 'OpenCode Work',
    providerDriver: 'opencode',
    isDefault: true,
    capabilities: null,
    selection: modelSelection,
  },
]
let root: Root
let menu: ReturnType<typeof useComposerCommandMenu>

function Probe(props: {
  readonly draftMessage: string
  readonly enabled?: boolean
  readonly environmentId?: EnvironmentId | null
  readonly cwd?: string | null
})
{
  menu = useComposerCommandMenu({
    draftMessage: props.draftMessage,
    enabled: props.enabled,
    environmentId: props.environmentId === undefined ? environmentId : props.environmentId,
    projectCwd: props.cwd === undefined ? '/project-one' : props.cwd,
    selectedProviderStatus: provider,
    interactionMode: { baseMode: 'default', orchestrate: true },
    modelOptions,
    hasThread: false,
    onChangeDraftMessage: mocks.onChangeDraftMessage,
    onUpdateInteractionMode: mocks.onUpdateInteractionMode,
    onUpdateModelSelection: mocks.onUpdateModelSelection,
  })
  return null
}

beforeEach(() =>
{
  vi.useFakeTimers()
  vi.clearAllMocks()
  mocks.data = { entries: [{ path: 'old.ts', kind: 'file' }], truncated: false }
  root = createRoot(document.createElement('div'))
})
afterEach(() =>
{
  act(() => root.unmount())
  vi.useRealTimers()
})

it('locks command mutations during incoming-share transfer and retains mode state and model routing', () =>
{
  act(() => root.render(<Probe draftMessage="/plan" />))
  const plan = menu.items.find((item) => item.id === 'cmd:plan')!
  act(() => root.render(<Probe draftMessage="/plan" enabled={false} />))
  expect(menu.trigger).toBeNull()
  expect(menu.items).toEqual([])
  act(() => menu.onSelect(plan))
  expect(mocks.onChangeDraftMessage).not.toHaveBeenCalled()
  expect(mocks.onUpdateInteractionMode).not.toHaveBeenCalled()

  act(() => root.render(<Probe draftMessage="/plan" />))
  act(() => menu.onSelect(plan))
  expect(mocks.onChangeDraftMessage).toHaveBeenLastCalledWith('')
  expect(mocks.onUpdateInteractionMode).toHaveBeenLastCalledWith({
    baseMode: 'plan',
    orchestrate: true,
  })
  expect(menu.selection).toEqual({ start: 0, end: 0 })

  const prefix = '/model copilot'
  act(() => root.render(<Probe draftMessage={`${prefix} keep this context`} />))
  act(() => menu.onSelectionChange({ start: prefix.length, end: prefix.length }))
  expect(menu.items).toHaveLength(1)
  act(() => menu.onSelect(menu.items[0]!))
  expect(mocks.onUpdateModelSelection).toHaveBeenLastCalledWith(modelSelection)
  expect(mocks.onChangeDraftMessage).toHaveBeenLastCalledWith(' keep this context')
  expect(menu.selection).toEqual({ start: 0, end: 0 })
})

it('hides old paths while the workspace or environment changes with the same query', () =>
{
  act(() => root.render(<Probe draftMessage="@src" />))
  expect(menu.items.map((item) => item.id)).toEqual(['path:old.ts'])
  const oldItem = menu.items[0]!
  act(() => root.render(<Probe draftMessage="@src" cwd="/project-two" />))
  expect(menu.items).toEqual([])
  expect(menu.isLoading).toBe(true)
  act(() => menu.onSelect(oldItem))
  expect(mocks.onChangeDraftMessage).not.toHaveBeenCalled()

  mocks.data = { entries: [{ path: 'new.ts', kind: 'file' }], truncated: false }
  act(() => vi.advanceTimersByTime(200))
  expect(menu.items.map((item) => item.id)).toEqual(['path:new.ts'])
  expect(mocks.searchEntries).toHaveBeenLastCalledWith({
    environmentId,
    input: { cwd: '/project-two', query: 'src', limit: 20 },
  })
  act(() =>
    root.render(
      <Probe draftMessage="@src" cwd="/project-two" environmentId={EnvironmentId.make('other')} />,
    ),
  )
  expect(menu.items).toEqual([])
  expect(menu.isLoading).toBe(true)
  act(() => vi.advanceTimersByTime(200))
  act(() => root.render(<Probe draftMessage="@src" cwd={null} environmentId={null} />))
  expect(menu.items).toEqual([])
})
