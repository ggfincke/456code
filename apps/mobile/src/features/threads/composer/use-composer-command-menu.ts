// apps/mobile/src/features/threads/composer/use-composer-command-menu.ts
// share command discovery and cursor-safe insertion across mobile task composers

import type {
  CollaborationMode,
  EnvironmentId,
  ModelSelection,
  ServerProvider,
} from '@t3tools/contracts'
import { detectComposerTrigger, replaceTextRange } from '@t3tools/shared/composerTrigger'
import { useCallback, useEffect, useMemo, useState } from 'react'

import type { ComposerEditorSelection } from '../../../components/ComposerEditor'
import type { ModelOption } from '../../../lib/modelOptions'
import { useComposerPathSearch } from '../../../state/use-composer-path-search'
import type { ComposerCommandItem } from './ComposerCommandPopover'
import { buildMobileComposerCommandItems, composerCommandReplacement } from './composerCommandItems'

export function useComposerCommandMenu({
  draftMessage,
  environmentId,
  projectCwd,
  selectedProviderStatus,
  modelOptions,
  interactionMode,
  hasThread,
  enabled = true,
  onChangeDraftMessage,
  onUpdateInteractionMode,
  onUpdateModelSelection,
}: {
  readonly draftMessage: string
  readonly environmentId: EnvironmentId | null
  readonly projectCwd: string | null
  readonly selectedProviderStatus: ServerProvider | null
  readonly modelOptions: ReadonlyArray<ModelOption>
  readonly interactionMode: CollaborationMode
  readonly hasThread: boolean
  readonly enabled?: boolean
  readonly onChangeDraftMessage: (value: string) => void
  readonly onUpdateInteractionMode: (mode: CollaborationMode) => void
  readonly onUpdateModelSelection: (selection: ModelSelection) => void
})
{
  const [selection, setSelection] = useState(() => ({
    start: draftMessage.length,
    end: draftMessage.length,
  }))
  const onSelectionChange = useCallback((nextSelection: ComposerEditorSelection) =>
  {
    setSelection(nextSelection)
  }, [])
  useEffect(() =>
  {
    const end = draftMessage.length
    setSelection((current) =>
    {
      const start = Math.min(current.start, end)
      const selectionEnd = Math.min(current.end, end)
      return start === current.start && selectionEnd === current.end
        ? current
        : { start, end: selectionEnd }
    })
  }, [draftMessage.length])

  const trigger = useMemo(() =>
  {
    if (!enabled || selection.start !== selection.end) return null
    return detectComposerTrigger(draftMessage, selection.end)
  }, [draftMessage, enabled, selection])
  const pathSearch = useComposerPathSearch({
    environmentId,
    cwd: trigger?.kind === 'path' ? projectCwd : null,
    query: trigger?.kind === 'path' ? trigger.query : null,
  })
  const items = useMemo(
    () =>
      buildMobileComposerCommandItems({
        trigger,
        selectedProviderStatus,
        modelOptions,
        interactionMode,
        hasThread,
        pathEntries: pathSearch.entries,
      }),
    [hasThread, interactionMode, modelOptions, pathSearch.entries, selectedProviderStatus, trigger],
  )

  const onSelect = useCallback(
    (item: ComposerCommandItem) =>
    {
      if (!trigger || !items.some((candidate) => candidate.id === item.id)) return
      const changesInteraction =
        item.type === 'slash-command' &&
        (item.command === 'plan' || item.command === 'orchestrate' || item.command === 'default')
      const replacement =
        item.type === 'model' || changesInteraction ? '' : composerCommandReplacement(item)
      const result = replaceTextRange(
        draftMessage,
        trigger.rangeStart,
        trigger.rangeEnd,
        replacement,
      )
      setSelection({ start: result.cursor, end: result.cursor })
      onChangeDraftMessage(result.text)

      if (item.type === 'model')
      {
        onUpdateModelSelection(item.selection)
      }
      else if (changesInteraction)
      {
        onUpdateInteractionMode(
          item.command === 'default'
            ? { baseMode: 'default', orchestrate: false }
            : item.command === 'plan'
              ? { ...interactionMode, baseMode: 'plan' }
              : { ...interactionMode, orchestrate: true },
        )
      }
    },
    [
      draftMessage,
      interactionMode,
      items,
      onChangeDraftMessage,
      onUpdateInteractionMode,
      onUpdateModelSelection,
      trigger,
    ],
  )

  return { selection, onSelectionChange, trigger, items, isLoading: pathSearch.isPending, onSelect }
}
