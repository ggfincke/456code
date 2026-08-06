// apps/web/src/components/chat/orchestrate-plan/stagePickers.tsx
// stage status chips and model/effort pickers for orchestrate plan cards

import type { ProviderInstanceId, WorkersJobStatus, WorkersJobSummary } from '@t3tools/contracts'
import * as Option from 'effect/Option'
import { ChevronDownIcon, XIcon } from 'lucide-react'
import { useMemo } from 'react'

import { cn } from '../../../lib/utils'
import type { AppModelOption } from '../../../modelSelection'
import type { ProviderInstanceEntry } from '../../../providerInstances'
import { getProviderModelCapabilities } from '../../../providerModels'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import {
  Menu,
  MenuGroup,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from '../../ui/menu'
import { Popover, PopoverPopup, PopoverTrigger } from '../../ui/popover'
import { Tooltip, TooltipPopup, TooltipTrigger } from '../../ui/tooltip'
import { ModelPickerContent } from '../model-picker/ModelPickerContent'
import { ProviderInstanceIcon } from '../ProviderInstanceIcon'
import { getTriggerDisplayModelName } from '../providerIconUtils'
import type { OrchestrateStageSelection } from './orchestratePlanStore'
import { type OrchestratePlanActions, type OrchestratePlanStage, type PlanRow } from './parse'

export const TERMINAL_STATUSES: ReadonlySet<WorkersJobStatus> = new Set([
  'completed',
  'failed',
  'rejected',
  'cancelled',
])

// per-status chip styling for the live run column
const STATUS_CHIP_CLASSES: Record<WorkersJobStatus, string> = {
  queued: 'bg-muted text-muted-foreground',
  running: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  completed: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  failed: 'bg-red-500/15 text-red-700 dark:text-red-300',
  rejected: 'bg-red-500/15 text-red-700 dark:text-red-300',
  cancelled: 'bg-muted text-muted-foreground line-through',
  unknown: 'bg-muted text-muted-foreground',
}

// broker jobs carry the stage id, so rows repeating an id split that id's jobs
// in row order by planned worker count; the last such row absorbs any extras
export function partitionJobsByRow(
  rows: ReadonlyArray<PlanRow>,
  jobs: ReadonlyArray<WorkersJobSummary>,
): Map<string, ReadonlyArray<WorkersJobSummary>>
{
  const jobsByStage = new Map<string, WorkersJobSummary[]>()
  for (const job of jobs)
  {
    const stageId = Option.getOrNull(job.stage)
    if (stageId === null) continue
    const bucket = jobsByStage.get(stageId)
    if (bucket === undefined)
    {
      jobsByStage.set(stageId, [job])
    }
    else
    {
      bucket.push(job)
    }
  }

  const rowsByStage = new Map<string, PlanRow[]>()
  for (const row of rows)
  {
    const bucket = rowsByStage.get(row.stage.id)
    if (bucket === undefined)
    {
      rowsByStage.set(row.stage.id, [row])
    }
    else
    {
      bucket.push(row)
    }
  }

  const byRow = new Map<string, ReadonlyArray<WorkersJobSummary>>()
  for (const [stageId, stageRows] of rowsByStage)
  {
    const stageJobs = jobsByStage.get(stageId) ?? []
    let cursor = 0
    stageRows.forEach((row, position) =>
    {
      const remaining = Math.max(0, stageJobs.length - cursor)
      const take =
        position === stageRows.length - 1 ? remaining : Math.min(row.stage.workers, remaining)
      byRow.set(row.rowKey, stageJobs.slice(cursor, cursor + take))
      cursor += take
    })
  }
  return byRow
}

// observed jobs against the row's planned worker count; workers that have not
// launched yet stay visible as pending instead of reading as complete
export function StageStatusCell({
  jobs,
  planned,
}: {
  jobs: ReadonlyArray<WorkersJobSummary>
  planned: number
})
{
  const counts = new Map<WorkersJobStatus, number>()
  for (const job of jobs)
  {
    counts.set(job.status, (counts.get(job.status) ?? 0) + 1)
  }
  const pending = Math.max(0, planned - jobs.length)
  return (
    <span className="flex items-center gap-1 whitespace-nowrap">
      <span className="tabular-nums text-muted-foreground">
        {jobs.length}/{planned}
      </span>
      {[...counts.entries()].map(([status, count]) =>
      {
        const chipClassName = cn(
          'inline-flex rounded px-1.5 py-0.5 font-medium',
          STATUS_CHIP_CLASSES[status],
        )
        const label = `${count > 1 ? `${count} ` : ''}${status}`
        if (status !== 'failed' && status !== 'rejected')
        {
          return (
            <span key={status} className={chipClassName}>
              {label}
            </span>
          )
        }
        // failure chips explain themselves on hover
        const failedJobs = jobs.filter((job) => job.status === status)
        return (
          <Tooltip key={status}>
            <TooltipTrigger render={<span className={cn(chipClassName, 'cursor-help')} />}>
              {label}
            </TooltipTrigger>
            <TooltipPopup side="top" className="max-w-80">
              <div className="space-y-2 text-xs">
                {failedJobs.map((job) => (
                  <div key={job.jobId} className="space-y-0.5">
                    <p className="font-mono text-[11px] text-muted-foreground">
                      {job.jobId.length > 20 ? `…${job.jobId.slice(-16)}` : job.jobId}
                    </p>
                    <p className="font-medium">
                      {job.provider}
                      {Option.isSome(job.model) ? `:${job.model.value}` : ''}
                      {Option.isSome(job.elapsedMs)
                        ? ` · ${Math.round(job.elapsedMs.value / 1000)}s`
                        : ''}
                    </p>
                    {Option.isSome(job.failureClass) ? (
                      <p className="text-muted-foreground">
                        {job.failureClass.value.replace('_', ' ')}
                        {Option.getOrNull(job.hasPatch) === true
                          ? ' · patch available — salvage before relaunching'
                          : Option.getOrNull(job.hasPatch) === false
                            ? ' · no patch'
                            : ''}
                      </p>
                    ) : null}
                    <p className="break-words text-muted-foreground">
                      {Option.getOrNull(job.error) ??
                        'no error recorded — open the worker in the panel for logs'}
                    </p>
                  </div>
                ))}
              </div>
            </TooltipPopup>
          </Tooltip>
        )
      })}
      {pending > 0 ? (
        <span className="inline-flex rounded bg-muted px-1.5 py-0.5 font-medium text-muted-foreground">
          {pending} pending
        </span>
      ) : null}
    </span>
  )
}

// scope renders as stacked package lines under the stage row instead of a
// table column; semicolons delimit packages, so the table never widens
export function StageScopeLines({ scope }: { scope: string })
{
  if (scope === '') return null
  const lines = scope
    .split(/;\s+/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  return (
    <ul className="ms-1 space-y-1.5 border-border/60 border-s ps-3">
      {lines.map((line, index) =>
      {
        // packages are conventionally labelled "A ..." or "(A) ..."; lift that
        // letter into a badge so waves scan as a list of subagent packages
        const labelled = /^\(?([A-Z])\)?[.:]?\s+(.+)$/s.exec(line)
        const letter = labelled?.[1] ?? null
        const rest = labelled?.[2] ?? line
        // "title — detail" lines keep the task pronounced and the file list quiet
        const split = /^(.*?)\s+[—–]\s+(.+)$/s.exec(rest)
        const title = split?.[1] ?? rest
        const detail = split?.[2] ?? null
        return (
          <li key={index} className="min-w-0 break-words">
            <span className="block">
              {letter !== null ? (
                <span className="me-1.5 inline-flex h-4 w-4 items-center justify-center rounded bg-muted align-[-2px] font-mono font-semibold text-[10px] text-foreground/80">
                  {letter}
                </span>
              ) : null}
              <span className="font-medium text-foreground/90">{title}</span>
            </span>
            {detail === null ? null : (
              // the detail tail (usually a file list) drops to its own line,
              // aligned under the title rather than the letter badge
              <span className={cn('mt-0.5 block text-muted-foreground', letter !== null && 'ms-6')}>
                {detail}
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

// broker-accepted effort tiers, used when the model exposes no reasoning
// descriptor; the broker rejects values outside this set
const FALLBACK_EFFORT_OPTIONS: ReadonlyArray<{
  id: string
  label: string
  isDefault?: boolean | undefined
}> = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra High' },
  { id: 'max', label: 'Max' },
  { id: 'ultra', label: 'Ultra' },
]

const BROKER_EFFORTS: ReadonlySet<string> = new Set([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
])

// the catalog option a stage resolves to: its picked model, or the
// instance default when the stage is left on provider defaults
export function resolveStageModelOption(
  entry: ProviderInstanceEntry | null,
  options: ReadonlyArray<AppModelOption>,
  model: string,
): AppModelOption | undefined
{
  if (entry === null) return undefined
  return model === ''
    ? (options.find((option) => option.isDefault) ?? options[0])
    : options.find((option) => option.slug === model)
}

// reasoning tiers the resolved model actually supports; kept unfiltered so
// the model's own default still resolves, with broker support flagged
export function resolveEffortOptions(
  entry: ProviderInstanceEntry | null,
  modelSlug: string,
): ReadonlyArray<{ id: string; label: string; isDefault?: boolean | undefined }>
{
  if (entry === null || modelSlug === '') return FALLBACK_EFFORT_OPTIONS
  const descriptor = getProviderModelCapabilities(
    entry.models,
    modelSlug,
    entry.driverKind,
  ).optionDescriptors?.find(
    (candidate) => candidate.id === 'reasoningEffort' && candidate.type === 'select',
  )
  const options = descriptor?.type === 'select' ? descriptor.options : []
  return options.length > 0 ? options : FALLBACK_EFFORT_OPTIONS
}

export function StageEffortPicker({
  rowLabel,
  value,
  options,
  disabled,
  onChange,
}: {
  rowLabel: string
  value: string
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean | undefined }>
  disabled: boolean
  onChange: (value: string) => void
})
{
  const isDefault = value === ''
  // an unset effort resolves to the model's default tier -> show its label
  const resolved = isDefault
    ? options.find((option) => option.isDefault === true)
    : options.find((option) => option.id === value)
  const label = resolved?.label ?? (isDefault ? 'default' : value)
  const unresolvedDefault = isDefault && resolved === undefined

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            aria-label={`Effort for stage ${rowLabel}`}
            className="h-7 min-w-0 justify-between gap-1.5 px-2 font-normal"
          />
        }
      >
        <span
          className={cn('min-w-0 truncate', unresolvedDefault && 'text-muted-foreground italic')}
        >
          {label}
        </span>
        <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuGroup>
          <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">
            Reasoning
          </div>
          <MenuRadioGroup value={value} onValueChange={onChange}>
            {options.map((option) => (
              <MenuRadioItem
                key={option.id}
                value={option.id}
                hideIndicator
                // tiers outside the broker's enum would be rejected at launch
                disabled={!BROKER_EFFORTS.has(option.id)}
              >
                <span className="flex w-full min-w-0 items-center justify-between gap-3">
                  <span className="min-w-0 truncate">{option.label}</span>
                  {option.isDefault === true ? (
                    <Badge variant="secondary" size="sm">
                      Default
                    </Badge>
                  ) : null}
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  )
}

export function StageModelPicker({
  rowLabel,
  selection,
  actions,
  disabled,
  open,
  onOpenChange,
  onSelect,
  onClear,
  allowClear,
}: {
  rowLabel: string
  selection: OrchestrateStageSelection
  actions: OrchestratePlanActions
  disabled: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (instanceId: ProviderInstanceId, model: string) => void
  onClear: () => void
  allowClear: boolean
})
{
  const activeEntry =
    actions.instanceEntries.find((entry) => entry.instanceId === selection.instanceId) ?? null
  const options =
    selection.instanceId === null
      ? []
      : (actions.modelOptionsByInstance.get(selection.instanceId) ?? [])
  const isDefault = selection.model === ''
  // an unset model resolves to the instance's default -> show its real name
  // like the composer trigger does, instead of a "provider default" label
  const selectedOption = resolveStageModelOption(activeEntry, options, selection.model)
  const label =
    selectedOption !== undefined
      ? getTriggerDisplayModelName(selectedOption)
      : isDefault
        ? 'provider default'
        : selection.model

  if (activeEntry === null)
  {
    // no matching app provider instance -> stay honest with a plain read-only slug
    return (
      <span className="font-mono text-muted-foreground">
        {isDefault ? 'default' : selection.model}
      </span>
    )
  }

  return (
    <span className="flex items-center gap-1">
      <Popover
        open={open}
        onOpenChange={(next) =>
        {
          if (disabled)
          {
            onOpenChange(false)
            return
          }
          onOpenChange(next)
        }}
      >
        <PopoverTrigger
          render={
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              aria-label={`Model for stage ${rowLabel}`}
              className="h-7 min-w-0 max-w-48 justify-between gap-1.5 px-2 font-normal"
            />
          }
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <ProviderInstanceIcon
              driverKind={activeEntry.driverKind}
              displayName={activeEntry.displayName}
              accentColor={activeEntry.accentColor}
              className="size-4 shrink-0"
              iconClassName="size-3.5"
            />
            <span
              className={cn(
                'min-w-0 truncate',
                selectedOption === undefined && isDefault && 'text-muted-foreground italic',
              )}
            >
              {label}
            </span>
          </span>
          <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
        </PopoverTrigger>
        <PopoverPopup
          align="start"
          className="border-0 bg-transparent p-0 shadow-none before:hidden [-webkit-backdrop-filter:none]! [--viewport-inline-padding:0] [backdrop-filter:none]!"
          viewportClassName="rounded-lg !overflow-hidden p-0"
        >
          <ModelPickerContent
            activeInstanceId={activeEntry.instanceId}
            model={selection.model !== '' ? selection.model : (selectedOption?.slug ?? '')}
            lockedProvider={null}
            lockedContinuationGroupKey={null}
            instanceEntries={actions.instanceEntries}
            modelOptionsByInstance={actions.modelOptionsByInstance}
            terminalOpen={false}
            onRequestClose={() => onOpenChange(false)}
            onInstanceModelChange={(instanceId, model) =>
            {
              onSelect(instanceId, model)
              onOpenChange(false)
            }}
          />
        </PopoverPopup>
      </Popover>
      {isDefault || !allowClear ? null : (
        <Button
          size="icon"
          variant="ghost"
          disabled={disabled}
          aria-label={`Reset stage ${rowLabel} model to provider default`}
          className="size-6 shrink-0 text-muted-foreground"
          onClick={onClear}
        >
          <XIcon className="size-3" />
        </Button>
      )}
    </span>
  )
}
