// apps/web/src/stores/diffPanelStore.ts
// manage diff panel state

import { scopedThreadKey } from '@t3tools/client-runtime/environment'
import type { ScopedThreadRef, TurnId } from '@t3tools/contracts'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

import { resolveStorage } from '../lib/storage'

// the run scope carries no payload: exact clients bind it to the shell's current
// execution at read time, while legacy clients bind it to current path metadata
export type DiffPanelSelection =
  | { kind: 'branch'; baseRef: string | null }
  | { kind: 'unstaged' }
  | { kind: 'run' }
  | { kind: 'turn'; turnId: TurnId; filePath: string | null; revealRequestId: number }

export type DiffPanelGitScope = 'branch' | 'unstaged' | 'run'
export type DiffPanelView = 'changes' | 'architecture'
export type DiffRenderMode = 'stacked' | 'split'

export interface DiffPanelViewRequest
{
  readonly view: DiffPanelView
  readonly requestId: number
}

const DEFAULT_SELECTION: DiffPanelSelection = { kind: 'branch', baseRef: null }
const DEFAULT_WORKING_TREE_SELECTION: DiffPanelSelection = { kind: 'unstaged' }

interface DiffPanelStoreState
{
  byThreadKey: Record<string, DiffPanelSelection>
  branchBaseRefByThreadKey: Record<string, string | null>
  requestedViewByThreadKey: Record<string, DiffPanelViewRequest>
  diffRenderMode: DiffRenderMode
  setDiffRenderMode: (mode: DiffRenderMode) => void
  selectGitScope: (ref: ScopedThreadRef, scope: DiffPanelGitScope) => void
  selectBranchBaseRef: (ref: ScopedThreadRef, baseRef: string | null) => void
  selectTurn: (ref: ScopedThreadRef, turnId: TurnId, filePath?: string) => void
  reconcileTurnSelection: (ref: ScopedThreadRef, availableTurnIds: ReadonlyArray<TurnId>) => void
  reconcileRunSelection: (ref: ScopedThreadRef, hasRunScope: boolean) => void
  requestView: (ref: ScopedThreadRef, view: DiffPanelView) => void
  consumeRequestedView: (ref: ScopedThreadRef, requestId: number) => void
  removeThread: (ref: ScopedThreadRef) => void
}

function isRecord(value: unknown): value is Record<string, unknown>
{
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mergePersistedDiffPanelState(
  persistedState: unknown,
  currentState: DiffPanelStoreState,
): DiffPanelStoreState
{
  const persisted = isRecord(persistedState) ? persistedState : {}
  const diffRenderMode =
    persisted.diffRenderMode === 'stacked' || persisted.diffRenderMode === 'split'
      ? persisted.diffRenderMode
      : currentState.diffRenderMode

  return {
    ...currentState,
    ...(isRecord(persisted.byThreadKey)
      ? { byThreadKey: persisted.byThreadKey as DiffPanelStoreState['byThreadKey'] }
      : {}),
    ...(isRecord(persisted.branchBaseRefByThreadKey)
      ? {
          branchBaseRefByThreadKey:
            persisted.branchBaseRefByThreadKey as DiffPanelStoreState['branchBaseRefByThreadKey'],
        }
      : {}),
    diffRenderMode,
  }
}

let nextViewRequestId = 1

function normalizeBaseRef(baseRef: string | null): string | null
{
  const normalized = baseRef?.trim()
  return normalized ? normalized : null
}

export const useDiffPanelStore = create<DiffPanelStoreState>()(
  persist(
    (set) => ({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
      requestedViewByThreadKey: {},
      diffRenderMode: 'stacked',
      setDiffRenderMode: (diffRenderMode) => set({ diffRenderMode }),
      selectGitScope: (ref, scope) =>
        set((state) =>
        {
          const threadKey = scopedThreadKey(ref)
          const previous = state.byThreadKey[threadKey]
          const previousBaseRef =
            previous?.kind === 'branch'
              ? previous.baseRef
              : (state.branchBaseRefByThreadKey[threadKey] ?? null)
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]:
                scope === 'branch'
                  ? { kind: 'branch', baseRef: previousBaseRef }
                  : scope === 'run'
                    ? { kind: 'run' }
                    : { kind: 'unstaged' },
            },
            branchBaseRefByThreadKey:
              previous?.kind === 'branch'
                ? { ...state.branchBaseRefByThreadKey, [threadKey]: previous.baseRef }
                : state.branchBaseRefByThreadKey,
          }
        }),
      selectBranchBaseRef: (ref, baseRef) =>
        set((state) =>
        {
          const threadKey = scopedThreadKey(ref)
          const normalizedBaseRef = normalizeBaseRef(baseRef)
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: { kind: 'branch', baseRef: normalizedBaseRef },
            },
            branchBaseRefByThreadKey: {
              ...state.branchBaseRefByThreadKey,
              [threadKey]: normalizedBaseRef,
            },
          }
        }),
      selectTurn: (ref, turnId, filePath) =>
        set((state) =>
        {
          const threadKey = scopedThreadKey(ref)
          const previous = state.byThreadKey[threadKey]
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: {
                kind: 'turn',
                turnId,
                filePath: filePath?.trim() || null,
                revealRequestId: previous?.kind === 'turn' ? previous.revealRequestId + 1 : 1,
              },
            },
          }
        }),
      reconcileTurnSelection: (ref, availableTurnIds) =>
        set((state) =>
        {
          const threadKey = scopedThreadKey(ref)
          const previous = state.byThreadKey[threadKey]
          const latestTurnId = availableTurnIds[0]
          if (
            previous?.kind !== 'turn' ||
            latestTurnId === undefined ||
            availableTurnIds.includes(previous.turnId)
          )
          {
            return state
          }
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: { ...previous, turnId: latestTurnId },
            },
          }
        }),
      // exact current execution identity survives path prune; hasRunScope remains
      // true while its retained head is readable. legacy scope still disappears
      // with its adopted path, so restored stale selections fall back to branch
      reconcileRunSelection: (ref, hasRunScope) =>
        set((state) =>
        {
          const threadKey = scopedThreadKey(ref)
          const previous = state.byThreadKey[threadKey]
          if (previous?.kind !== 'run' || hasRunScope)
          {
            return state
          }
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: {
                kind: 'branch',
                baseRef: state.branchBaseRefByThreadKey[threadKey] ?? null,
              },
            },
          }
        }),
      requestView: (ref, view) =>
        set((state) => ({
          requestedViewByThreadKey: {
            ...state.requestedViewByThreadKey,
            [scopedThreadKey(ref)]: { view, requestId: nextViewRequestId++ },
          },
        })),
      consumeRequestedView: (ref, requestId) =>
        set((state) =>
        {
          const threadKey = scopedThreadKey(ref)
          if (state.requestedViewByThreadKey[threadKey]?.requestId !== requestId)
          {
            return state
          }
          const { [threadKey]: _removed, ...requestedViewByThreadKey } =
            state.requestedViewByThreadKey
          return { requestedViewByThreadKey }
        }),
      removeThread: (ref) =>
        set((state) =>
        {
          const threadKey = scopedThreadKey(ref)
          if (
            !(threadKey in state.byThreadKey) &&
            !(threadKey in state.branchBaseRefByThreadKey) &&
            !(threadKey in state.requestedViewByThreadKey)
          )
          {
            return state
          }
          const { [threadKey]: _removed, ...byThreadKey } = state.byThreadKey
          const { [threadKey]: _removedBaseRef, ...branchBaseRefByThreadKey } =
            state.branchBaseRefByThreadKey
          const { [threadKey]: _removedViewRequest, ...requestedViewByThreadKey } =
            state.requestedViewByThreadKey
          return { byThreadKey, branchBaseRefByThreadKey, requestedViewByThreadKey }
        }),
    }),
    {
      name: '456code:diff-panel-state:v1',
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== 'undefined' ? window.localStorage : undefined),
      ),
      merge: mergePersistedDiffPanelState,
      partialize: (state) => ({
        byThreadKey: state.byThreadKey,
        branchBaseRefByThreadKey: state.branchBaseRefByThreadKey,
        diffRenderMode: state.diffRenderMode,
      }),
    },
  ),
)

export function selectThreadDiffPanelSelection(
  byThreadKey: Record<string, DiffPanelSelection>,
  ref: ScopedThreadRef | null | undefined,
  hasWorkingTreeChanges = false,
): DiffPanelSelection
{
  if (!ref) return DEFAULT_SELECTION
  return (
    byThreadKey[scopedThreadKey(ref)] ??
    (hasWorkingTreeChanges ? DEFAULT_WORKING_TREE_SELECTION : DEFAULT_SELECTION)
  )
}

export function selectThreadDiffPanelViewRequest(
  requestedViewByThreadKey: Record<string, DiffPanelViewRequest>,
  ref: ScopedThreadRef | null | undefined,
): DiffPanelViewRequest | null
{
  return ref ? (requestedViewByThreadKey[scopedThreadKey(ref)] ?? null) : null
}
