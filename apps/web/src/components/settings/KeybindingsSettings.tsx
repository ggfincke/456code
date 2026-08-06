// apps/web/src/components/settings/KeybindingsSettings.tsx
// render keybindings settings

import { FileJsonIcon, InfoIcon, PlusIcon, SearchIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  type KeybindingCommand,
  type ServerRemoveKeybindingInput,
  type ServerUpsertKeybindingInput,
} from '@t3tools/contracts'
import { useAtomValue } from '@effect/atom-react'
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from '@t3tools/client-runtime/state/runtime'

import { isElectron } from '../../env'
import { useOpenInPreferredEditor } from '../../lib/editorPreferences'
import { cn } from '../../lib/utils'
import {
  primaryServerAvailableEditorsAtom,
  primaryServerKeybindingsAtom,
  primaryServerKeybindingsConfigPathAtom,
  serverEnvironment,
} from '../../state/server'
import { usePrimaryEnvironment } from '../../state/environments'
import { Button } from '../ui/button'
import { ScrollArea } from '../ui/scroll-area'
import { toastManager } from '../ui/toast'
import { Tooltip, TooltipPopup, TooltipTrigger } from '../ui/tooltip'
import {
  buildKeybindingRows,
  buildKeybindingCommandOptions,
  buildWhenVariableOptions,
  type KeybindingRow,
} from './KeybindingsSettings.logic'
import { SettingsPageContainer, SettingsSection } from './settingsLayout'
import { useAtomCommand } from '../../state/use-atom-command'
import { ExpandableHeaderSearch } from './keybindings/whenExpression'
import {
  KeybindingTableRow,
  NewKeybindingTableRow,
  rowKeybindingTarget,
} from './keybindings/tableRows'

export function KeybindingsSettingsPanel()
{
  const keybindings = useAtomValue(primaryServerKeybindingsAtom)
  const keybindingsConfigPath = useAtomValue(primaryServerKeybindingsConfigPathAtom)
  const availableEditors = useAtomValue(primaryServerAvailableEditorsAtom)
  const primaryEnvironment = usePrimaryEnvironment()
  const upsertKeybinding = useAtomCommand(serverEnvironment.upsertKeybinding, {
    reportFailure: false,
  })
  const removeKeybindingMutation = useAtomCommand(serverEnvironment.removeKeybinding, {
    reportFailure: false,
  })
  const openInPreferredEditor = useOpenInPreferredEditor(
    primaryEnvironment?.environmentId ?? null,
    availableEditors,
  )
  const [query, setQuery] = useState('')
  const [isSearchOpen, setIsSearchOpen] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [savingCommand, setSavingCommand] = useState<KeybindingCommand | null>(null)
  const [isAddingBinding, setIsAddingBinding] = useState(false)
  const rows = useMemo(() => buildKeybindingRows(keybindings, query), [keybindings, query])
  const commandOptions = useMemo(() => buildKeybindingCommandOptions(keybindings), [keybindings])
  const whenVariables = useMemo(() => buildWhenVariableOptions(), [])

  useEffect(() =>
  {
    const handleKeyDown = (event: globalThis.KeyboardEvent) =>
    {
      const isMod = event.metaKey || event.ctrlKey
      if (!isMod || event.altKey || event.key.toLowerCase() !== 'f') return

      const target = event.target
      if (
        target !== searchInputRef.current &&
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      )
      {
        return
      }

      event.preventDefault()
      setIsSearchOpen(true)
      requestAnimationFrame(() =>
      {
        searchInputRef.current?.focus()
        searchInputRef.current?.select()
      })
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const openKeybindingsFile = useCallback(() =>
  {
    if (!keybindingsConfigPath) return
    void (async () =>
    {
      const result = await openInPreferredEditor(keybindingsConfigPath)
      if (result._tag === 'Success' || isAtomCommandInterrupted(result))
      {
        return
      }
      const error = squashAtomCommandFailure(result)
      toastManager.add({
        title: 'Unable to open keybindings file',
        description:
          error instanceof Error ? error.message : 'The keybindings file was not opened.',
        type: 'error',
      })
    })()
  }, [keybindingsConfigPath, openInPreferredEditor])

  const saveKeybinding = useCallback(
    (input: ServerUpsertKeybindingInput) =>
    {
      if (!primaryEnvironment) return
      setSavingCommand(input.command)
      const payload: ServerUpsertKeybindingInput = {
        command: input.command,
        key: input.key.trim(),
        ...(input.when?.trim() ? { when: input.when.trim() } : {}),
        ...(input.replace ? { replace: input.replace } : {}),
      }
      void (async () =>
      {
        const result = await upsertKeybinding({
          environmentId: primaryEnvironment.environmentId,
          input: payload,
        })
        setSavingCommand(null)
        if (result._tag === 'Success')
        {
          setIsAddingBinding(false)
          return
        }
        if (!isAtomCommandInterrupted(result))
        {
          const error = squashAtomCommandFailure(result)
          toastManager.add({
            title: 'Unable to save keybinding',
            description: error instanceof Error ? error.message : 'The keybinding was not saved.',
            type: 'error',
          })
        }
      })()
    },
    [primaryEnvironment, upsertKeybinding],
  )

  const removeKeybinding = useCallback(
    (row: KeybindingRow) =>
    {
      if (!primaryEnvironment) return
      setSavingCommand(row.command)
      void (async () =>
      {
        const result = await removeKeybindingMutation({
          environmentId: primaryEnvironment.environmentId,
          input: rowKeybindingTarget(row),
        })
        setSavingCommand(null)
        if (result._tag === 'Failure' && !isAtomCommandInterrupted(result))
        {
          const error = squashAtomCommandFailure(result)
          toastManager.add({
            title: 'Unable to remove keybinding',
            description: error instanceof Error ? error.message : 'The keybinding was not removed.',
            type: 'error',
          })
        }
      })()
    },
    [primaryEnvironment, removeKeybindingMutation],
  )

  const resetKeybinding = useCallback(
    (row: KeybindingRow) =>
    {
      if (!row.defaultKey) return
      saveKeybinding({
        command: row.command,
        key: row.defaultKey,
        when: row.defaultWhen.trim().length > 0 ? row.defaultWhen : undefined,
        replace: {
          command: row.command,
          key: row.key,
          ...(row.when.trim().length > 0 ? { when: row.when } : {}),
        },
      })
    },
    [saveKeybinding],
  )

  const bindingsCount = (
    <span className="text-[11px] text-muted-foreground">
      {rows.length + (isAddingBinding ? 1 : 0)}{' '}
      {rows.length + (isAddingBinding ? 1 : 0) === 1 ? 'binding' : 'bindings'}
    </span>
  )

  return (
    <SettingsPageContainer className="max-w-5xl">
      <SettingsSection
        title="Keybindings"
        headerAction={
          <div className="flex items-center gap-1.5">
            <ExpandableHeaderSearch
              query={query}
              onChange={setQuery}
              isOpen={isSearchOpen}
              onOpenChange={setIsSearchOpen}
              inputRef={searchInputRef}
              collapsedAccessory={bindingsCount}
            />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                    onClick={() => setIsAddingBinding(true)}
                    aria-label="Add keybinding"
                  >
                    <PlusIcon className="size-3" />
                  </Button>
                }
              />
              <TooltipPopup side="top">Add keybinding</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                    disabled={!keybindingsConfigPath}
                    onClick={openKeybindingsFile}
                    aria-label="Open keybindings.json"
                  >
                    <FileJsonIcon className="size-3" />
                  </Button>
                }
              />
              <TooltipPopup side="top">Open keybindings.json</TooltipPopup>
            </Tooltip>
          </div>
        }
      >
        {!isElectron ? (
          <div className="flex items-start gap-2 border-b border-warning/20 bg-warning/5 px-3 py-2.5 text-[12px] leading-relaxed text-muted-foreground sm:px-4">
            <InfoIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
            <p>
              Some shortcuts may be claimed by the browser before 456code sees them. Use the desktop
              app for better keybinding support.
            </p>
          </div>
        ) : null}

        <ScrollArea
          chainVerticalScroll
          scrollFade
          hideScrollbars
          className="w-full max-w-full rounded-none"
        >
          <div className="grid min-w-[680px] grid-cols-[minmax(190px,1.1fr)_minmax(220px,0.85fr)_minmax(210px,1fr)_60px] border-b border-border/70 bg-muted/25 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
            <div>Command</div>
            <div>Keybinding</div>
            <div>When</div>
            <div>Status</div>
          </div>
          <div className="min-w-[680px] divide-y divide-border/60">
            {isAddingBinding ? (
              <NewKeybindingTableRow
                commandOptions={commandOptions}
                allRows={rows}
                variables={whenVariables}
                isSaving={savingCommand !== null}
                onSave={saveKeybinding}
                onCancel={() => setIsAddingBinding(false)}
              />
            ) : null}
            {rows.map((row) => (
              <KeybindingTableRow
                key={row.id}
                row={row}
                allRows={rows}
                variables={whenVariables}
                isSaving={savingCommand === row.command}
                onSave={saveKeybinding}
                onReset={resetKeybinding}
                onRemove={removeKeybinding}
              />
            ))}
            {rows.length === 0 && !isAddingBinding ? (
              <div className="px-4 py-12 text-center text-sm text-muted-foreground">
                No keybindings match your search.
              </div>
            ) : null}
          </div>
        </ScrollArea>
      </SettingsSection>
    </SettingsPageContainer>
  )
}
