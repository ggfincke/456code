// apps/web/src/threadSelectionStore.ts
// manage thread selection state

// supports Cmd/Ctrl+Click (toggle individual), Shift+Click (range select),
// and bulk actions on the selected set.
import { create } from 'zustand'

export interface ThreadSelectionState
{
  // currently selected scoped thread keys.
  selectedThreadKeys: ReadonlySet<string>
  // the scoped thread key that anchors shift-click range selection.
  anchorThreadKey: string | null
}

interface ThreadSelectionStore extends ThreadSelectionState
{
  // toggle a single scoped thread key in the selection (Cmd/Ctrl+Click).
  toggleThread: (threadKey: string) => void
  // select a range of threads (Shift+Click).
  // requires the ordered list of scoped thread keys within the same project
  // so the store can compute which threads fall between anchor and target.
  rangeSelectTo: (threadKey: string, orderedThreadKeys: readonly string[]) => void
  // clear all selection state.
  clearSelection: () => void
  // remove specific scoped thread keys from the selection (e.g. after deletion).
  removeFromSelection: (threadKeys: readonly string[]) => void
  // set the anchor thread without adding it to the selection (e.g. on plain-click navigate).
  setAnchor: (threadKey: string) => void
  // check if any threads are selected.
  hasSelection: () => boolean
}

const EMPTY_SET = new Set<string>()

export const useThreadSelectionStore = create<ThreadSelectionStore>((set, get) => ({
  selectedThreadKeys: EMPTY_SET,
  anchorThreadKey: null,

  toggleThread: (threadKey) =>
  {
    set((state) =>
    {
      const next = new Set(state.selectedThreadKeys)
      if (next.has(threadKey))
      {
        next.delete(threadKey)
      }
      else
      {
        next.add(threadKey)
      }
      return {
        selectedThreadKeys: next,
        anchorThreadKey: next.has(threadKey) ? threadKey : state.anchorThreadKey,
      }
    })
  },

  rangeSelectTo: (threadKey, orderedThreadKeys) =>
  {
    set((state) =>
    {
      const anchor = state.anchorThreadKey
      if (anchor === null)
      {
        // no anchor yet — treat as a single toggle
        const next = new Set(state.selectedThreadKeys)
        next.add(threadKey)
        return { selectedThreadKeys: next, anchorThreadKey: threadKey }
      }

      const anchorIndex = orderedThreadKeys.indexOf(anchor)
      const targetIndex = orderedThreadKeys.indexOf(threadKey)
      if (anchorIndex === -1 || targetIndex === -1)
      {
        // anchor or target not in this list (different project?) — fallback to toggle
        const next = new Set(state.selectedThreadKeys)
        next.add(threadKey)
        return { selectedThreadKeys: next, anchorThreadKey: threadKey }
      }

      const start = Math.min(anchorIndex, targetIndex)
      const end = Math.max(anchorIndex, targetIndex)
      const next = new Set(state.selectedThreadKeys)
      for (let i = start; i <= end; i++)
      {
        const key = orderedThreadKeys[i]
        if (key !== undefined)
        {
          next.add(key)
        }
      }
      // keep anchor stable so subsequent shift-clicks extend from the same point
      return { selectedThreadKeys: next, anchorThreadKey: anchor }
    })
  },

  clearSelection: () =>
  {
    const state = get()
    if (state.selectedThreadKeys.size === 0 && state.anchorThreadKey === null) return
    set({ selectedThreadKeys: EMPTY_SET, anchorThreadKey: null })
  },

  setAnchor: (threadKey) =>
  {
    if (get().anchorThreadKey === threadKey) return
    set({ anchorThreadKey: threadKey })
  },

  removeFromSelection: (threadKeys) =>
  {
    set((state) =>
    {
      const toRemove = new Set(threadKeys)
      let changed = false
      const next = new Set<string>()
      for (const key of state.selectedThreadKeys)
      {
        if (toRemove.has(key))
        {
          changed = true
        }
        else
        {
          next.add(key)
        }
      }
      if (!changed) return state
      const newAnchor =
        state.anchorThreadKey !== null && toRemove.has(state.anchorThreadKey)
          ? null
          : state.anchorThreadKey
      return { selectedThreadKeys: next, anchorThreadKey: newAnchor }
    })
  },

  hasSelection: () => get().selectedThreadKeys.size > 0,
}))
