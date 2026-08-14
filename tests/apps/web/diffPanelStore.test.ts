// tests/apps/web/diffPanelStore.test.ts
// verify diff panel store behavior

import { scopeThreadRef } from '@t3tools/client-runtime/environment'
import { EnvironmentId, ThreadId, TurnId } from '@t3tools/contracts'
import { beforeEach, describe, expect, it } from 'vite-plus/test'

import {
  selectThreadDiffPanelSelection,
  useDiffPanelStore,
} from '../../../apps/web/src/diffPanelStore'

const THREAD_REF = scopeThreadRef(EnvironmentId.make('environment-1'), ThreadId.make('thread-1'))

describe('diffPanelStore', () =>
{
  beforeEach(() =>
    useDiffPanelStore.setState({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
      requestedViewByThreadKey: {},
      diffRenderMode: 'stacked',
    }),
  )

  it('keeps the selected render mode in panel and persisted state', async () =>
  {
    useDiffPanelStore.getState().setDiffRenderMode('split')

    expect(useDiffPanelStore.getState().diffRenderMode).toBe('split')
    expect(
      useDiffPanelStore.persist.getOptions().partialize?.(useDiffPanelStore.getState()),
    ).toMatchObject({ diffRenderMode: 'split' })

    const { name, storage } = useDiffPanelStore.persist.getOptions()
    if (!name) throw new Error('Expected diff panel persistence to have a storage name')
    const persisted = await storage?.getItem(name)
    expect(persisted?.state).toMatchObject({ diffRenderMode: 'split' })

    useDiffPanelStore.setState({ diffRenderMode: 'stacked' })
    if (persisted) await storage?.setItem(name, persisted)
    await useDiffPanelStore.persist.rehydrate()

    expect(useDiffPanelStore.getState().diffRenderMode).toBe('split')
  })

  it.each([
    ['legacy state without a render mode', {}],
    ['state with a malformed render mode', { diffRenderMode: 'side-by-side' }],
  ])('defaults %s to stacked rendering', (_label, persistedFields) =>
  {
    const merge = useDiffPanelStore.persist.getOptions().merge
    if (!merge) throw new Error('Expected diff panel persistence to define a merge function')

    const currentState = useDiffPanelStore.getState()
    const merged = merge(
      {
        byThreadKey: currentState.byThreadKey,
        branchBaseRefByThreadKey: currentState.branchBaseRefByThreadKey,
        ...persistedFields,
      },
      currentState,
    ) as typeof currentState

    expect(merged.diffRenderMode).toBe('stacked')
    expect(merged.setDiffRenderMode).toBe(currentState.setDiffRenderMode)
  })

  it('defaults each thread to branch changes when the working tree is clean', () =>
  {
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: 'branch', baseRef: null })
  })

  it('defaults each thread to working changes when the working tree is dirty', () =>
  {
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF, true),
    ).toEqual({ kind: 'unstaged' })
  })

  it('preserves an explicit scope selection when the working tree state changes', () =>
  {
    useDiffPanelStore.getState().selectGitScope(THREAD_REF, 'branch')

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF, true),
    ).toEqual({ kind: 'branch', baseRef: null })
  })

  it('clears incompatible selection fields when changing scopes', () =>
  {
    const store = useDiffPanelStore.getState()
    store.selectTurn(THREAD_REF, TurnId.make('turn-1'), 'src/app.ts')
    store.selectGitScope(THREAD_REF, 'unstaged')

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: 'unstaged' })

    useDiffPanelStore.getState().selectBranchBaseRef(THREAD_REF, ' origin/main ')
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: 'branch', baseRef: 'origin/main' })
  })

  it('increments the reveal request when opening the same turn file again', () =>
  {
    const turnId = TurnId.make('turn-1')
    useDiffPanelStore.getState().selectTurn(THREAD_REF, turnId, 'src/app.ts')
    useDiffPanelStore.getState().selectTurn(THREAD_REF, turnId, 'src/app.ts')

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: 'turn', turnId, filePath: 'src/app.ts', revealRequestId: 2 })
  })

  it('restores the selected branch base after visiting another scope', () =>
  {
    useDiffPanelStore.getState().selectBranchBaseRef(THREAD_REF, 'origin/main')
    useDiffPanelStore.getState().selectGitScope(THREAD_REF, 'unstaged')
    useDiffPanelStore.getState().selectGitScope(THREAD_REF, 'branch')

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: 'branch', baseRef: 'origin/main' })
  })

  it('persists a payload-free run scope that remains bound to the current execution', () =>
  {
    useDiffPanelStore.getState().selectGitScope(THREAD_REF, 'run')

    const partialize = useDiffPanelStore.persist.getOptions().partialize
    expect(partialize).toBeTypeOf('function')
    expect(partialize!(useDiffPanelStore.getState())).toMatchObject({
      byThreadKey: expect.objectContaining({
        'environment-1:thread-1': { kind: 'run' },
      }),
    })

    // a new exact current execution needs no selection rewrite or stored run id
    useDiffPanelStore.getState().reconcileRunSelection(THREAD_REF, true)
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: 'run' })
  })

  it('reconciles a missing turn selection to the latest available turn', () =>
  {
    const missingTurnId = TurnId.make('turn-missing')
    const latestTurnId = TurnId.make('turn-latest')
    useDiffPanelStore.getState().selectTurn(THREAD_REF, missingTurnId, 'src/app.ts')
    useDiffPanelStore.getState().reconcileTurnSelection(THREAD_REF, [latestTurnId])

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({
      kind: 'turn',
      turnId: latestTurnId,
      filePath: 'src/app.ts',
      revealRequestId: 1,
    })
  })

  it('consumes architecture view requests once by exact request id', () =>
  {
    const store = useDiffPanelStore.getState()
    store.requestView(THREAD_REF, 'architecture')
    const firstRequest = Object.values(useDiffPanelStore.getState().requestedViewByThreadKey)[0]
    expect(firstRequest?.view).toBe('architecture')

    useDiffPanelStore.getState().requestView(THREAD_REF, 'changes')
    useDiffPanelStore.getState().consumeRequestedView(THREAD_REF, firstRequest!.requestId)
    const currentRequest = Object.values(useDiffPanelStore.getState().requestedViewByThreadKey)[0]
    expect(currentRequest?.view).toBe('changes')

    useDiffPanelStore.getState().consumeRequestedView(THREAD_REF, currentRequest!.requestId)
    expect(useDiffPanelStore.getState().requestedViewByThreadKey).toEqual({})
  })

  it('keeps view requests transient and removes them with thread state', () =>
  {
    useDiffPanelStore.getState().requestView(THREAD_REF, 'architecture')

    const partialize = useDiffPanelStore.persist.getOptions().partialize
    expect(partialize).toBeTypeOf('function')
    expect(partialize!(useDiffPanelStore.getState())).not.toHaveProperty('requestedViewByThreadKey')

    useDiffPanelStore.getState().removeThread(THREAD_REF)
    expect(useDiffPanelStore.getState().requestedViewByThreadKey).toEqual({})
  })
})
