// tests/apps/mobile/features/threads/sidebar/use-thread-list-v2-state.test.tsx
// verify active arrangement remains available when the legacy list is visible

// @vitest-environment happy-dom

import { act, useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from '@t3tools/contracts'
import type { EnvironmentThreadShell } from '@t3tools/client-runtime/state/shell'
import { expect, it, vi } from 'vite-plus/test'

const fixture = vi.hoisted(() => ({ configs: new Map(), reorder: vi.fn() }))
vi.mock('@effect/atom-react', () => ({ useAtomValue: () => fixture.configs }))
vi.mock('../../../../../../apps/mobile/src/state/server', () => ({
  environmentServerConfigsAtom: {},
}))
vi.mock('../../../../../../apps/mobile/src/state/threads', () => ({
  threadEnvironment: { reorderActive: {} },
}))
vi.mock('../../../../../../apps/mobile/src/state/use-atom-command', () => ({
  useAtomCommand: () => fixture.reorder,
}))
vi.mock('../../../../../../apps/mobile/src/lib/useNowMinute', () => ({
  useNowMinute: () => '2026-09-09T16:00',
}))

import { useThreadListV2State } from '../../../../../../apps/mobile/src/features/threads/sidebar/use-thread-list-v2-state'

it('opens and reorders the canonical active section from legacy mode without changing its visible layout', async () =>
{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const environmentId = EnvironmentId.make('remote')
  fixture.configs.set(environmentId, {
    environment: { capabilities: { threadActiveReorder: true } },
  })
  fixture.reorder.mockResolvedValue({ _tag: 'Success' })
  const threads: readonly EnvironmentThreadShell[] = ['first', 'second'].map((id, index) => ({
    id: ThreadId.make(id),
    environmentId,
    projectId: ProjectId.make('project'),
    title: id,
    activeOrderKey: index === 0 ? 'h' : 't',
    providerSwitch: null,
    origin: null,
    modelSelection: { instanceId: ProviderInstanceId.make('codex'), model: 'gpt-5.4' },
    runtimeMode: 'full-access',
    interactionMode: 'default',
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: '2026-09-09T16:00:00.000Z',
    updatedAt: '2026-09-09T16:00:00.000Z',
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  }))
  let state: ReturnType<typeof useThreadListV2State>
  function Probe()
  {
    const current = useThreadListV2State({
      enabled: false,
      threads,
      environmentId: null,
      projectRefs: null,
      projectScopeKey: null,
      searchQuery: '',
      autoSettleOnMerge: false,
    })
    useLayoutEffect(() =>
    {
      state = current
    })
    return null
  }
  const root = createRoot(document.createElement('div'))
  try
  {
    await act(async () => root.render(<Probe />))
    expect(state!.layout.items).toEqual([])
    expect(state!.arrangeableThreads.map((thread) => thread.id)).toEqual(['first', 'second'])
    await act(async () => state!.openArrangement(threads[0]!))
    expect(state!.arrangementThreads).toEqual(threads)
    await act(async () => state!.moveActiveThread(threads[1]!, 'up'))
    expect(fixture.reorder).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { threadId: threads[1]!.id, orderKey: expect.any(String) },
    })
    expect(state!.layout.items).toEqual([])
  }
  finally
  {
    await act(async () => root.unmount())
    vi.unstubAllGlobals()
  }
})
