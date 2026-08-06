// apps/web/src/components/settings/keybindings/tableRows.tsx
// editable keybinding table rows and draft state

import { ChevronDownIcon, EllipsisIcon, PlusIcon, XIcon } from 'lucide-react'
import { type KeyboardEvent, useCallback, useEffect, useReducer, useRef, useState } from 'react'
import {
  type KeybindingCommand,
  type KeybindingWhenNode,
  type ServerRemoveKeybindingInput,
  type ServerUpsertKeybindingInput,
} from '@t3tools/contracts'

import { formatShortcutLabel } from '../../../keybindings'
import { cn } from '../../../lib/utils'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '../../ui/menu'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { Tooltip, TooltipPopup, TooltipTrigger } from '../../ui/tooltip'
import {
  buildKeybindingCommandOptions,
  commandLabel,
  keybindingConflictLabels,
  keybindingFromKeyboardEvent,
  parseWhenExpressionDraft,
  type KeybindingCommandOption,
  type KeybindingRow,
  type WhenVariableOption,
  whenAstToExpression,
} from '../KeybindingsSettings.logic'
import {
  KeybindingConflictWarning,
  KeybindingPill,
  UnknownWhenVariableWarning,
  WhenExpressionBuilder,
} from './whenExpression'

type KeybindingRowDraftState = {
  keyDraft: string
  whenDraft: KeybindingWhenNode | undefined
  isRecording: boolean
  isWhenDraftValid: boolean
}

export function createKeybindingRowDraft(row: KeybindingRow): KeybindingRowDraftState
{
  return {
    keyDraft: row.key,
    whenDraft: row.binding.whenAst,
    isRecording: false,
    isWhenDraftValid: true,
  }
}

export function keybindingRowDraftReducer(
  state: KeybindingRowDraftState,
  patch: Partial<KeybindingRowDraftState>,
): KeybindingRowDraftState
{
  return { ...state, ...patch }
}

export function rowKeybindingTarget(row: KeybindingRow): ServerRemoveKeybindingInput
{
  return {
    command: row.command,
    key: row.key,
    ...(row.when.trim().length > 0 ? { when: row.when } : {}),
  }
}

export function KeybindingTableRow({
  row,
  allRows,
  variables,
  isSaving,
  onSave,
  onReset,
  onRemove,
}: {
  row: KeybindingRow
  allRows: ReadonlyArray<KeybindingRow>
  variables: ReadonlyArray<WhenVariableOption>
  isSaving: boolean
  onSave: (input: ServerUpsertKeybindingInput) => void
  onReset: (row: KeybindingRow) => void
  onRemove: (row: KeybindingRow) => void
})
{
  const [draft, setDraft] = useReducer(keybindingRowDraftReducer, row, createKeybindingRowDraft)
  const { keyDraft, whenDraft, isRecording, isWhenDraftValid } = draft
  const whenDraftExpression = whenAstToExpression(whenDraft)
  const isDirty = keyDraft !== row.key || whenDraftExpression !== row.when
  const displayShortcut = formatShortcutLabel(row.binding.shortcut)
  const canReset = row.source === 'Custom' && row.defaultKey !== null
  const canRemove = row.source !== 'Default'
  const hasRowActions = canReset || canRemove
  const showPill = !isRecording && keyDraft === row.key && row.key.length > 0 && !isDirty
  const conflictLabels = keybindingConflictLabels(allRows, {
    rowId: row.id,
    key: keyDraft,
    when: whenDraftExpression,
  })

  const save = () =>
  {
    onSave({
      command: row.command,
      key: keyDraft,
      when: whenDraftExpression.trim().length > 0 ? whenDraftExpression : undefined,
      replace: rowKeybindingTarget(row),
    })
  }

  const captureKeybinding = (event: KeyboardEvent<HTMLInputElement>) =>
  {
    if (event.key === 'Tab') return
    event.preventDefault()
    if (event.key === 'Escape')
    {
      setDraft({ keyDraft: row.key, isRecording: false })
      return
    }
    const next = keybindingFromKeyboardEvent(event.nativeEvent, navigator.platform)
    if (!next) return
    setDraft({ keyDraft: next, isRecording: false })
  }

  return (
    <div className="grid grid-cols-[minmax(190px,1.1fr)_minmax(220px,0.85fr)_minmax(210px,1fr)_60px] items-center px-4 py-1.5 text-sm even:bg-muted/15 hover:bg-accent/40">
      <div className="min-w-0 pr-4">
        <div className="flex min-w-0 items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <div
                  aria-label={row.command}
                  className="truncate text-[13px] font-medium text-foreground"
                />
              }
            >
              {commandLabel(row.command)}
            </TooltipTrigger>
            <TooltipPopup side="top">{row.command}</TooltipPopup>
          </Tooltip>
        </div>
      </div>
      <div className="flex min-w-0 items-center gap-2 pr-4">
        {showPill ? (
          <button
            type="button"
            onClick={() => setDraft({ isRecording: true })}
            aria-label={`Edit shortcut for ${commandLabel(row.command)}`}
            className="group inline-flex h-7 items-center gap-1.5 rounded-md border border-transparent px-1.5 outline-none transition-colors hover:border-border/70 hover:bg-background focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24"
          >
            <KeybindingPill value={row.key} />
            <span className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/0 transition-opacity group-hover:text-muted-foreground/70 group-focus-visible:text-muted-foreground/70">
              Edit
            </span>
          </button>
        ) : (
          <Input
            data-keybinding-capture=""
            autoFocus={isRecording}
            aria-label={`Keybinding for ${commandLabel(row.command)}`}
            value={isRecording ? '' : keyDraft}
            placeholder={isRecording ? 'Press shortcut' : 'Unassigned'}
            className={cn(
              'h-7 w-44 rounded-md font-mono text-[12px] sm:h-7',
              isRecording && 'border-primary/70 bg-primary/5',
            )}
            onFocus={() => setDraft({ isRecording: true })}
            onBlur={() => setDraft({ isRecording: false })}
            onChange={(event) => setDraft({ keyDraft: event.currentTarget.value })}
            onKeyDown={captureKeybinding}
          />
        )}
        {isDirty ? (
          <Button
            size="xs"
            className="h-7 sm:h-7"
            disabled={isSaving || keyDraft.trim().length === 0 || !isWhenDraftValid}
            onClick={save}
          >
            {isSaving ? 'Saving' : 'Save'}
          </Button>
        ) : null}
      </div>
      <div className="pr-4">
        <Popover>
          <PopoverTrigger
            className={cn(
              'inline-flex h-7 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-2.5 text-left font-mono text-[12px] text-foreground shadow-xs/5 outline-none transition-colors hover:bg-accent focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24',
              !whenDraftExpression && 'text-muted-foreground',
            )}
            aria-label={`Edit when clause for ${commandLabel(row.command)}`}
          >
            <span className="truncate">{whenDraftExpression || 'Always'}</span>
            <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />
          </PopoverTrigger>
          <PopoverContent align="start" sideOffset={6}>
            <WhenExpressionBuilder
              value={whenDraft}
              variables={variables}
              onChange={(nextWhenDraft) => setDraft({ whenDraft: nextWhenDraft })}
              onValidityChange={(nextIsValid) => setDraft({ isWhenDraftValid: nextIsValid })}
            />
          </PopoverContent>
        </Popover>
      </div>
      <div className="flex items-center justify-end gap-1">
        <KeybindingConflictWarning labels={conflictLabels} />
        {hasRowActions ? (
          <Menu>
            <MenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="size-7 text-muted-foreground hover:text-foreground sm:size-7"
                  disabled={isSaving}
                  aria-label={`Actions for ${commandLabel(row.command)}`}
                />
              }
            >
              <EllipsisIcon className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="end" className="min-w-36">
              {canReset ? (
                <MenuItem disabled={isSaving} onClick={() => onReset(row)}>
                  Reset to default
                </MenuItem>
              ) : null}
              {canRemove ? (
                <MenuItem variant="destructive" disabled={isSaving} onClick={() => onRemove(row)}>
                  Remove
                </MenuItem>
              ) : null}
            </MenuPopup>
          </Menu>
        ) : null}
        <span className="sr-only">{displayShortcut}</span>
      </div>
    </div>
  )
}

export function NewKeybindingTableRow({
  commandOptions,
  allRows,
  variables,
  isSaving,
  onSave,
  onCancel,
}: {
  commandOptions: ReadonlyArray<KeybindingCommandOption>
  allRows: ReadonlyArray<KeybindingRow>
  variables: ReadonlyArray<WhenVariableOption>
  isSaving: boolean
  onSave: (input: ServerUpsertKeybindingInput) => void
  onCancel: () => void
})
{
  const [commandDraft, setCommandDraft] = useState<KeybindingCommand | ''>('')
  const [draft, setDraft] = useReducer(keybindingRowDraftReducer, {
    keyDraft: '',
    whenDraft: undefined,
    isRecording: false,
    isWhenDraftValid: true,
  })
  const { keyDraft, whenDraft, isRecording, isWhenDraftValid } = draft
  const whenDraftExpression = whenAstToExpression(whenDraft)
  const conflictLabels = keybindingConflictLabels(allRows, {
    rowId: 'new',
    key: keyDraft,
    when: whenDraftExpression,
  })
  const commandLabelText = commandDraft ? commandLabel(commandDraft) : 'new keybinding'

  const save = () =>
  {
    if (!commandDraft) return
    onSave({
      command: commandDraft,
      key: keyDraft,
      ...(whenDraftExpression.trim().length > 0 ? { when: whenDraftExpression } : {}),
    })
  }

  const captureKeybinding = (event: KeyboardEvent<HTMLInputElement>) =>
  {
    if (event.key === 'Tab') return
    event.preventDefault()
    if (event.key === 'Escape')
    {
      setDraft({ keyDraft: '', isRecording: false })
      return
    }
    const next = keybindingFromKeyboardEvent(event.nativeEvent, navigator.platform)
    if (!next) return
    setDraft({ keyDraft: next, isRecording: false })
  }

  return (
    <div className="grid grid-cols-[minmax(190px,1.1fr)_minmax(220px,0.85fr)_minmax(210px,1fr)_60px] items-center px-4 py-1.5 text-sm even:bg-muted/15 hover:bg-accent/40">
      <div className="min-w-0 pr-4">
        <Select
          value={commandDraft}
          onValueChange={(value) => setCommandDraft(value as KeybindingCommand)}
        >
          <SelectTrigger
            size="xs"
            className="h-7 min-h-7 w-full max-w-60 rounded-md text-xs sm:h-7"
          >
            <SelectValue placeholder="Command" />
          </SelectTrigger>
          <SelectContent
            alignItemWithTrigger={false}
            matchTriggerWidth={false}
            className="max-h-72 w-fit min-w-56"
          >
            {commandOptions.map((command) => (
              <SelectItem key={command} value={command} className="min-h-7 w-full py-1 text-[12px]">
                <span className="truncate">{commandLabel(command)}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex min-w-0 items-center gap-2 pr-4">
        <Input
          data-keybinding-capture=""
          aria-label={`Keybinding for ${commandLabelText}`}
          value={isRecording ? '' : keyDraft}
          placeholder={isRecording ? 'Press shortcut' : 'Unassigned'}
          className={cn(
            'h-7 w-44 rounded-md font-mono text-[12px] sm:h-7',
            isRecording && 'border-primary/70 bg-primary/5',
          )}
          onFocus={() => setDraft({ isRecording: true })}
          onBlur={() => setDraft({ isRecording: false })}
          onChange={(event) => setDraft({ keyDraft: event.currentTarget.value })}
          onKeyDown={captureKeybinding}
        />
        <Button
          size="xs"
          className="h-7 sm:h-7"
          disabled={isSaving || !commandDraft || keyDraft.trim().length === 0 || !isWhenDraftValid}
          onClick={save}
        >
          {isSaving ? 'Saving' : 'Save'}
        </Button>
      </div>
      <div className="pr-4">
        <Popover>
          <PopoverTrigger
            className={cn(
              'inline-flex h-7 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-2.5 text-left font-mono text-[12px] text-foreground shadow-xs/5 outline-none transition-colors hover:bg-accent focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24',
              !whenDraftExpression && 'text-muted-foreground',
            )}
            aria-label={`Edit when clause for ${commandLabelText}`}
          >
            <span className="truncate">{whenDraftExpression || 'Always'}</span>
            <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />
          </PopoverTrigger>
          <PopoverContent align="start" sideOffset={6}>
            <WhenExpressionBuilder
              value={whenDraft}
              variables={variables}
              onChange={(nextWhenDraft) => setDraft({ whenDraft: nextWhenDraft })}
              onValidityChange={(nextIsValid) => setDraft({ isWhenDraftValid: nextIsValid })}
            />
          </PopoverContent>
        </Popover>
      </div>
      <div className="flex items-center justify-end gap-1">
        <KeybindingConflictWarning labels={conflictLabels} />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-7 text-muted-foreground hover:text-foreground sm:size-7"
                disabled={isSaving}
                aria-label="Cancel new keybinding"
                onClick={onCancel}
              />
            }
          >
            <XIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">Cancel</TooltipPopup>
        </Tooltip>
      </div>
    </div>
  )
}
