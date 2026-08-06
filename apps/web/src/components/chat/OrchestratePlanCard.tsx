// apps/web/src/components/chat/OrchestratePlanCard.tsx
// renders an editable orchestration plan approval card
import type {
  EnvironmentId,
  ProviderInstanceId,
  WorkersJobStatus,
  WorkersJobSummary,
  WorkersListInput,
} from '@t3tools/contracts'
import * as Option from 'effect/Option'
import { ChevronDownIcon, ExternalLinkIcon, XIcon } from 'lucide-react'
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'

import { cn } from '../../lib/utils'
import type { AppModelOption } from '../../modelSelection'
import type { ProviderInstanceEntry } from '../../providerInstances'
import { getProviderModelCapabilities } from '../../providerModels'
import { useEnvironmentQuery } from '../../state/query'
import { workersEnvironment } from '../../state/workers'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Menu, MenuGroup, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from '../ui/menu'
import { Popover, PopoverPopup, PopoverTrigger } from '../ui/popover'
import { Tooltip, TooltipPopup, TooltipTrigger } from '../ui/tooltip'
import { ModelPickerContent } from './ModelPickerContent'
import {
  createOrchestratePlanCardStateKey,
  hashOrchestratePlanText,
  isOrchestratePlanCardSuperseded,
  isOrchestratePlanRevisionStarted,
  markOrchestratePlanRevisionStarted,
  type OrchestratePlanEmissionOrder,
  type OrchestrateStageSelection,
  readOrchestratePlanCardState,
  registerOrchestratePlanCard,
  setOrchestratePlanCardStatus,
  setOrchestratePlanMaxWorkers,
  setOrchestrateStageEffort,
  setOrchestrateStageSelection,
  subscribeOrchestratePlanStore,
} from './orchestratePlanStore'
import { ProviderInstanceIcon } from './ProviderInstanceIcon'
import { getTriggerDisplayModelName } from './providerIconUtils'

interface OrchestratePlanStage
{
  id: string
  provider: string
  model: string
  effort?: string
  mode: 'read' | 'edit'
  workers: number
  scope: string
  phase?: string
}

export interface OrchestratePlan
{
  workflow: string
  task: string
  stages: OrchestratePlanStage[]
  totalWorkers: number
  maxWorkers: number
  runId?: string
  validationError: string | null
}

/**
 * Callbacks and model-catalog data the chat view supplies so plan cards can
 * edit stage bindings with the app's regular model picker and send replies.
 */
export interface OrchestratePlanActions
{
  environmentId: EnvironmentId
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>
  onApprove: (reply: string) => Promise<boolean>
  onEditInChat: (reply: string) => void
  onOpenRun?: ((runId: string) => void) | undefined
}

function isRecord(value: unknown): value is Record<string, unknown>
{
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonNegativeInteger(value: unknown): value is number
{
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function valueType(value: unknown): string
{
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

// emitters are language models -> be liberal on descriptive fields, strict on
// the safety-critical ones (mode, worker counts, model identity)
function toScopeText(value: unknown): string | null
{
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.every((item) => typeof item === 'string'))
  {
    return value.join('; ')
  }
  return null
}

type OrchestratePlanStageParseResult =
  { status: 'success'; stage: OrchestratePlanStage } | { status: 'error'; diagnostic: string }

function parseStage(value: unknown, index: number): OrchestratePlanStageParseResult
{
  const path = `stages[${index}]`
  if (!isRecord(value))
  {
    return {
      status: 'error',
      diagnostic: `${path} must be an object (got ${valueType(value)})`,
    }
  }
  if (value.id === undefined)
  {
    return { status: 'error', diagnostic: `missing ${path}.id` }
  }
  if (typeof value.id !== 'string')
  {
    return {
      status: 'error',
      diagnostic: `${path}.id must be a string (got ${valueType(value.id)})`,
    }
  }
  if (value.provider === undefined)
  {
    return { status: 'error', diagnostic: `missing ${path}.provider` }
  }
  if (typeof value.provider !== 'string')
  {
    return {
      status: 'error',
      diagnostic: `${path}.provider must be a string (got ${valueType(value.provider)})`,
    }
  }
  if (value.model !== null && value.model !== undefined && typeof value.model !== 'string')
  {
    return {
      status: 'error',
      diagnostic: `${path}.model must be a string or null (got ${valueType(value.model)})`,
    }
  }
  if (value.mode === undefined)
  {
    return { status: 'error', diagnostic: `missing ${path}.mode` }
  }
  if (value.mode !== 'read' && value.mode !== 'edit')
  {
    return {
      status: 'error',
      diagnostic: `${path}.mode must be "read" or "edit" (got ${valueType(value.mode)})`,
    }
  }
  if (value.workers === undefined)
  {
    return { status: 'error', diagnostic: `missing ${path}.workers` }
  }
  if (typeof value.workers !== 'number' || !Number.isSafeInteger(value.workers))
  {
    return {
      status: 'error',
      diagnostic: `${path}.workers must be an integer (got ${valueType(value.workers)})`,
    }
  }
  if (value.workers < 0)
  {
    return {
      status: 'error',
      diagnostic: `${path}.workers must be non-negative (got ${value.workers})`,
    }
  }
  const scope = toScopeText(value.scope) ?? ''

  return {
    status: 'success',
    stage: {
      id: value.id,
      provider: value.provider,
      // null/absent model -> provider default; shown as an empty picker state
      model: typeof value.model === 'string' ? value.model : '',
      ...(typeof value.effort === 'string' && value.effort !== '' ? { effort: value.effort } : {}),
      mode: value.mode,
      workers: value.workers,
      scope,
      ...(typeof value.phase === 'string' && value.phase !== '' ? { phase: value.phase } : {}),
    },
  }
}

// positional row keys keep malformed duplicate stages independently readable
// while their parse error blocks every approval path
interface PlanRow
{
  rowKey: string
  stage: OrchestratePlanStage
  // display-only marker for plans that repeat a stage id across waves
  occurrence: number | null
}

function buildPlanRows(stages: ReadonlyArray<OrchestratePlanStage>): PlanRow[]
{
  const totals = new Map<string, number>()
  for (const stage of stages)
  {
    totals.set(stage.id, (totals.get(stage.id) ?? 0) + 1)
  }
  const seen = new Map<string, number>()
  return stages.map((stage, index) =>
  {
    const position = (seen.get(stage.id) ?? 0) + 1
    seen.set(stage.id, position)
    return {
      rowKey: `${index}:${stage.id}`,
      stage,
      occurrence: (totals.get(stage.id) ?? 1) > 1 ? position : null,
    }
  })
}

// rows grouped by their optional phase label in first-appearance order;
// a plan without phases renders as one unlabeled group
function groupRowsByPhase(
  rows: ReadonlyArray<PlanRow>,
): Array<{ phase: string | null; rows: PlanRow[] }>
{
  const groups: Array<{ phase: string | null; rows: PlanRow[] }> = []
  for (const row of rows)
  {
    const phase = row.stage.phase ?? null
    const last = groups.at(-1)
    if (last !== undefined && last.phase === phase)
    {
      last.rows.push(row)
    }
    else
    {
      const existing = groups.find((group) => group.phase === phase && phase !== null)
      if (existing !== undefined)
      {
        existing.rows.push(row)
      }
      else
      {
        groups.push({ phase, rows: [row] })
      }
    }
  }
  return groups
}

export type OrchestratePlanParseResult =
  | { status: 'success'; plan: OrchestratePlan }
  | { status: 'error'; diagnostic: string }
  | { status: 'incomplete' }

export function parseOrchestratePlanResult(
  value: string,
  complete = true,
): OrchestratePlanParseResult
{
  const invalid = (diagnostic: string): OrchestratePlanParseResult =>
    complete ? { status: 'error', diagnostic } : { status: 'incomplete' }

  let parsed: unknown
  try
  {
    parsed = JSON.parse(value)
  }
  catch (error)
  {
    const message =
      error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error)
    return invalid(`invalid JSON: ${message}`)
  }

  if (!isRecord(parsed))
  {
    return invalid(`plan must be an object (got ${valueType(parsed)})`)
  }
  if (parsed.workflow === undefined)
  {
    return invalid('missing workflow')
  }
  if (typeof parsed.workflow !== 'string')
  {
    return invalid(`workflow must be a string (got ${valueType(parsed.workflow)})`)
  }
  if (parsed.stages === undefined)
  {
    return invalid('missing stages')
  }
  if (!Array.isArray(parsed.stages))
  {
    return invalid(`stages must be an array (got ${valueType(parsed.stages)})`)
  }
  if (parsed.stages.length === 0)
  {
    return invalid('stages must contain at least one stage')
  }

  const stages: OrchestratePlanStage[] = []
  for (const [index, value] of parsed.stages.entries())
  {
    const stageResult = parseStage(value, index)
    if (stageResult.status === 'error')
    {
      return invalid(stageResult.diagnostic)
    }
    stages.push(stageResult.stage)
  }

  const stageIds = new Set<string>()
  const duplicateStageId = stages.find((stage) =>
  {
    if (stageIds.has(stage.id)) return true
    stageIds.add(stage.id)
    return false
  })?.id

  const workerSum = stages.reduce((sum, stage) => sum + stage.workers, 0)
  const totalWorkers = isNonNegativeInteger(parsed.totalWorkers) ? parsed.totalWorkers : workerSum
  const maxWorkers = isNonNegativeInteger(parsed.maxWorkers) ? parsed.maxWorkers : totalWorkers

  return {
    status: 'success',
    plan: {
      workflow: parsed.workflow,
      task: typeof parsed.task === 'string' ? parsed.task : '',
      stages,
      totalWorkers,
      maxWorkers,
      ...(typeof parsed.runId === 'string' && parsed.runId !== '' ? { runId: parsed.runId } : {}),
      validationError:
        duplicateStageId === undefined
          ? null
          : `Duplicate stage ID "${duplicateStageId}". Stage IDs must be unique before approval.`,
    },
  }
}

export function parseOrchestratePlan(value: string): OrchestratePlan | null
{
  const result = parseOrchestratePlanResult(value)
  return result.status === 'success' ? result.plan : null
}

// canonical text distinguishes content revisions within one streamed message
function planContentText(plan: OrchestratePlan): string
{
  return JSON.stringify([
    plan.workflow,
    plan.task,
    plan.totalWorkers,
    plan.maxWorkers,
    plan.runId ?? '',
    plan.stages.map((stage) => [
      stage.id,
      stage.provider,
      stage.model,
      stage.effort ?? '',
      stage.mode,
      stage.workers,
      stage.scope,
      stage.phase ?? '',
    ]),
  ])
}

// harnesses the worker broker can launch directly; models picked from other
// providers are sent model-only and the orchestrator resolves the harness
const BROKER_PROVIDERS = new Set(['codex', 'cursor', 'coral'])

function initialSelection(
  stage: OrchestratePlanStage,
  entries: ReadonlyArray<ProviderInstanceEntry>,
): OrchestrateStageSelection
{
  const entry =
    entries.find((candidate) => candidate.driverKind === stage.provider) ?? entries[0] ?? null
  return { provider: stage.provider, model: stage.model, instanceId: entry?.instanceId ?? null }
}

export function buildOrchestrateApprovalReply(
  plan: OrchestratePlan,
  options: {
    readonly selections?: Readonly<Record<string, OrchestrateStageSelection>>
    readonly efforts?: Readonly<Record<string, string>>
    readonly maxWorkers?: number
  } = {},
): string
{
  const rows = buildPlanRows(plan.stages)
  const selections = options.selections ?? {}
  const efforts = options.efforts ?? {}
  const maxWorkers = options.maxWorkers ?? plan.maxWorkers
  const tokens: string[] = []
  // name the plan the approval belongs to so a thread with several plans
  // correlates each approval to its own run
  if (plan.runId !== undefined && plan.runId !== '')
  {
    tokens.push(`run=${plan.runId}`)
  }
  for (const { rowKey, stage } of rows)
  {
    const selection = selections[rowKey] ?? initialSelection(stage, [])
    const effort = efforts[rowKey] ?? stage.effort ?? ''
    if (selection.model === '')
    {
      // the grammar cannot express model-less overrides beyond the provider
      if (selection.provider !== stage.provider)
      {
        tokens.push(`${stage.id}=${selection.provider}`)
      }
      continue
    }
    const changed =
      selection.provider !== stage.provider ||
      selection.model !== stage.model ||
      effort !== (stage.effort ?? '')
    if (changed)
    {
      // keep the effort segment whenever one is set so a model edit does not
      // silently drop the plan's effort back to defaults
      const effortSegment = effort !== '' ? `:${effort}` : ''
      // model-only token when no launchable harness is known -> the
      // orchestrator routes the model to a provider at the gate
      tokens.push(
        BROKER_PROVIDERS.has(selection.provider)
          ? `${stage.id}=${selection.provider}:${selection.model}${effortSegment}`
          : `${stage.id}=${selection.model}${effortSegment}`,
      )
    }
  }
  if (maxWorkers !== plan.maxWorkers)
  {
    tokens.push(`max-workers=${maxWorkers}`)
  }
  return tokens.length === 0 ? 'approve' : `approve ${tokens.join(' ')}`
}

interface OrchestratePlanTimelineIdentity
{
  readonly revisionKey: string
  readonly order: OrchestratePlanEmissionOrder
}

function resolvePlanTimelineIdentity(
  element: HTMLElement,
  contentKey: string,
): OrchestratePlanTimelineIdentity | null
{
  const messageElement = element.closest<HTMLElement>('[data-message-id]')
  const listItem = element.closest<HTMLElement>('[data-index]')
  const messageIndexText = listItem?.dataset.index
  if (
    messageElement === null ||
    messageIndexText === undefined ||
    !/^\d+$/.test(messageIndexText)
  )
  {
    return null
  }

  const messageId = messageElement.dataset.messageId
  const messageIndex = Number(messageIndexText)
  const planIndex = [
    ...messageElement.querySelectorAll<HTMLElement>('[data-orchestrate-plan]'),
  ].indexOf(element)
  if (
    messageId === undefined ||
    messageId === '' ||
    !Number.isSafeInteger(messageIndex) ||
    planIndex < 0
  )
  {
    return null
  }

  return {
    revisionKey: `${messageId}:${planIndex}:${contentKey}`,
    order: { messageIndex, planIndex },
  }
}

const TERMINAL_STATUSES: ReadonlySet<WorkersJobStatus> = new Set([
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
function partitionJobsByRow(
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
function StageStatusCell({
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
function StageScopeLines({ scope }: { scope: string })
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
function resolveStageModelOption(
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
function resolveEffortOptions(
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

function StageEffortPicker({
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

function StageModelPicker({
  rowLabel,
  selection,
  actions,
  disabled,
  open,
  onOpenChange,
  onSelect,
  onClear,
}: {
  rowLabel: string
  selection: OrchestrateStageSelection
  actions: OrchestratePlanActions
  disabled: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (instanceId: ProviderInstanceId, model: string) => void
  onClear: () => void
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
      {isDefault ? null : (
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

export function OrchestratePlanCard({
  plan,
  actions,
}: {
  plan: OrchestratePlan
  actions: OrchestratePlanActions
})
{
  const rows = useMemo(() => buildPlanRows(plan.stages), [plan.stages])
  const contentKey = useMemo(() => hashOrchestratePlanText(planContentText(plan)), [plan])
  const runId = plan.runId ?? null
  const [timelineIdentity, setTimelineIdentity] = useState<OrchestratePlanTimelineIdentity | null>(
    null,
  )
  const revisionKey = timelineIdentity?.revisionKey ?? `content:${contentKey}`
  const draftKey = createOrchestratePlanCardStateKey(runId, revisionKey)

  const registerCardElement = useCallback(
    (element: HTMLElement | null) =>
    {
      if (element === null) return
      const identity = resolvePlanTimelineIdentity(element, contentKey)
      if (identity === null) return
      setTimelineIdentity((current) =>
        current?.revisionKey === identity.revisionKey &&
        current.order.messageIndex === identity.order.messageIndex &&
        current.order.planIndex === identity.order.planIndex
          ? current
          : identity,
      )
      if (runId !== null)
      {
        registerOrchestratePlanCard(runId, identity.revisionKey, identity.order)
      }
    },
    [contentKey, runId],
  )

  const cardState = useSyncExternalStore(subscribeOrchestratePlanStore, () =>
    readOrchestratePlanCardState(draftKey),
  )
  const superseded = useSyncExternalStore(subscribeOrchestratePlanStore, () =>
    runId === null
      ? false
      : isOrchestratePlanCardSuperseded(runId, revisionKey, timelineIdentity?.order),
  )
  const startedRevision = useSyncExternalStore(subscribeOrchestratePlanStore, () =>
    runId === null ? false : isOrchestratePlanRevisionStarted(runId, revisionKey),
  )

  const [openRowKey, setOpenRowKey] = useState<string | null>(null)
  const maxWorkers = cardState.maxWorkers ?? plan.maxWorkers
  const status = cardState.status

  // live run status: jobs carrying this plan's runId identify the launched
  // run, which also marks the plan approved across reloads; the query is
  // stream-backed, so the card never polls
  const workersInput = useMemo<WorkersListInput>(
    () => (runId === null ? {} : { run: runId }),
    [runId],
  )
  const workersQuery = useEnvironmentQuery(
    runId === null
      ? null
      : workersEnvironment.list({ environmentId: actions.environmentId, input: workersInput }),
  )
  const workersData = workersQuery.data
  const runJobs = useMemo(() =>
  {
    if (runId === null) return [] as WorkersJobSummary[]
    return (workersData?.jobs ?? []).filter((job) => Option.getOrNull(job.run) === runId)
  }, [runId, workersData])
  const jobsByRow = useMemo(() => partitionJobsByRow(rows, runJobs), [rows, runJobs])

  const plannedTotal = Math.max(
    plan.totalWorkers,
    rows.reduce((sum, row) => sum + row.stage.workers, 0),
  )
  const runStarted = runJobs.length > 0
  const revisionStarted = runStarted && startedRevision
  const runActive = runJobs.some((job) => !TERMINAL_STATUSES.has(job.status))
  const finishedCount = runJobs.filter((job) => TERMINAL_STATUSES.has(job.status)).length
  const failedCount = runJobs.filter(
    (job) => job.status === 'failed' || job.status === 'rejected',
  ).length
  // failures with an intact patch are recoverable work, not lost work
  const salvageableCount = runJobs.filter(
    (job) =>
      (job.status === 'failed' || job.status === 'rejected') &&
      Option.getOrNull(job.hasPatch) === true,
  ).length
  const notLaunchedCount = Math.max(0, plannedTotal - runJobs.length)
  // a run with workers still to launch is not finished, however quiet the
  // broker's job list looks right now
  const runFinished = revisionStarted && notLaunchedCount === 0 && !runActive

  const disabled =
    superseded ||
    plan.validationError !== null ||
    status === 'sending' ||
    status === 'sent' ||
    revisionStarted
  const maxWorkersValid = Number.isSafeInteger(maxWorkers) && maxWorkers >= 1
  const reply = buildOrchestrateApprovalReply(plan, {
    selections: cardState.selections,
    efforts: cardState.efforts,
    maxWorkers,
  })

  const handleApprove = async () =>
  {
    setOrchestratePlanCardStatus(draftKey, 'sending')
    let didSend = false
    let failure: string | null = null
    try
    {
      didSend = await actions.onApprove(reply)
      if (!didSend) failure = 'The approval was not sent. Try again.'
    }
    catch (error)
    {
      failure = error instanceof Error ? error.message : 'The approval could not be sent.'
    }
    finally
    {
      if (didSend && runId !== null)
      {
        markOrchestratePlanRevisionStarted(runId, revisionKey)
      }
      // sending always clears, so a failed send leaves the card usable
      setOrchestratePlanCardStatus(draftKey, didSend ? 'sent' : 'idle', failure)
    }
  }

  // the reply only moves to the composer -> nothing was approved and the card
  // stays interactive
  const handleEditInChat = () =>
  {
    actions.onEditInChat(reply)
    setOrchestratePlanCardStatus(draftKey, 'editing')
  }

  const rowGroups = groupRowsByPhase(rows)
  const hasPhases = rowGroups.some((group) => group.phase !== null)
  const openRunAction = runId !== null && actions.onOpenRun !== undefined ? actions.onOpenRun : null

  return (
    <section
      ref={registerCardElement}
      data-orchestrate-plan="true"
      data-orchestrate-plan-superseded={superseded ? 'true' : 'false'}
      // break out halfway between the prose measure (100%) and the timeline
      // container's full width (100cqw minus gutter); tracks side panels and
      // never drops below the prose measure
      className={cn(
        'relative left-1/2 my-3 w-[max(100%,calc(50%+50cqw-1.5rem))] -translate-x-1/2 overflow-hidden rounded-lg border border-border bg-card text-foreground shadow-sm',
        superseded && 'opacity-60',
      )}
    >
      <header className="border-b border-border bg-muted/30 px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-semibold text-sm">{plan.workflow}</h3>
          {superseded ? (
            <Badge variant="secondary" size="sm">
              Superseded
            </Badge>
          ) : null}
        </div>
        {plan.task === '' ? null : (
          <p className="mt-0.5 text-muted-foreground text-xs">{plan.task}</p>
        )}
      </header>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead className="bg-muted/20 text-left text-muted-foreground">
            <tr>
              {[
                'Stage',
                'Model',
                'Effort',
                'Access',
                'Workers',
                ...(revisionStarted ? ['Status'] : []),
              ].map((label) => (
                // w-px floors each control column at its natural nowrap width so
                // the unsized trailing column absorbs all slack without inflating
                // the table past its container
                <th
                  key={label}
                  className="w-px whitespace-nowrap border-b border-border px-2 py-1.5 font-medium"
                >
                  {label}
                </th>
              ))}
              <th aria-hidden className="border-b border-border" />
            </tr>
          </thead>
          <tbody>
            {rowGroups.map((group, groupIndex) => [
              hasPhases ? (
                <tr
                  key={`phase-${group.phase ?? groupIndex}`}
                  className="border-b border-border/70"
                >
                  <td colSpan={revisionStarted ? 7 : 6} className="bg-muted/25 px-3 py-2">
                    <span className="flex items-center gap-2">
                      <span className="h-3.5 w-1 shrink-0 rounded-full bg-blue-400/70" />
                      <span className="font-semibold text-[11px] text-foreground uppercase tracking-wider">
                        {group.phase ?? 'other'}
                      </span>
                      <span className="rounded bg-muted px-1.5 py-0.5 font-medium tabular-nums text-[11px] text-muted-foreground">
                        {group.rows.reduce((sum, row) => sum + row.stage.workers, 0)} worker
                        {group.rows.reduce((sum, row) => sum + row.stage.workers, 0) === 1
                          ? ''
                          : 's'}
                      </span>
                    </span>
                  </td>
                </tr>
              ) : null,
              ...group.rows.map(({ rowKey, stage, occurrence }) =>
              {
                const selection =
                  cardState.selections[rowKey] ?? initialSelection(stage, actions.instanceEntries)
                // invalid duplicate rows remain distinguishable while the
                // parser's validation error blocks approval
                const rowLabel = occurrence === null ? stage.id : `${stage.id} #${occurrence}`
                // resolve the model this row actually displays so the effort menu
                // reads that model's reasoning tiers, defaults included
                const entryForStage =
                  actions.instanceEntries.find(
                    (entry) => entry.instanceId === selection.instanceId,
                  ) ?? null
                const stageModelOptions =
                  entryForStage === null
                    ? []
                    : (actions.modelOptionsByInstance.get(entryForStage.instanceId) ?? [])
                const resolvedModel = resolveStageModelOption(
                  entryForStage,
                  stageModelOptions,
                  selection.model,
                )
                return [
                  <tr
                    key={rowKey}
                    className={cn(
                      'align-top',
                      stage.scope === '' && 'border-b border-border/70 last:border-b-0',
                    )}
                  >
                    <td className="whitespace-nowrap px-2 py-2 font-mono">{rowLabel}</td>
                    <td className="whitespace-nowrap px-2 py-2">
                      <StageModelPicker
                        rowLabel={rowLabel}
                        selection={selection}
                        actions={actions}
                        disabled={disabled}
                        open={openRowKey === rowKey}
                        onOpenChange={(next) => setOpenRowKey(next ? rowKey : null)}
                        onSelect={(instanceId, model) =>
                        {
                          const entry = actions.instanceEntries.find(
                            (candidate) => candidate.instanceId === instanceId,
                          )
                          const provider =
                            entry === undefined ? selection.provider : entry.driverKind
                          setOrchestrateStageSelection(draftKey, rowKey, {
                            provider,
                            model,
                            instanceId,
                          })
                        }}
                        onClear={() =>
                          setOrchestrateStageSelection(
                            draftKey,
                            rowKey,
                            initialSelection({ ...stage, model: '' }, actions.instanceEntries),
                          )
                        }
                      />
                    </td>
                    <td className="whitespace-nowrap px-2 py-2">
                      <StageEffortPicker
                        rowLabel={rowLabel}
                        value={cardState.efforts[rowKey] ?? stage.effort ?? ''}
                        options={resolveEffortOptions(
                          entryForStage,
                          resolvedModel?.slug ?? selection.model,
                        )}
                        disabled={disabled}
                        onChange={(value) => setOrchestrateStageEffort(draftKey, rowKey, value)}
                      />
                    </td>
                    <td className="whitespace-nowrap px-2 py-2">
                      <span
                        className={cn(
                          'inline-flex rounded px-1.5 py-0.5 font-medium',
                          stage.mode === 'edit'
                            ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                            : 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
                        )}
                      >
                        {stage.mode}
                      </span>
                    </td>
                    <td className="px-2 py-2 tabular-nums">{stage.workers}</td>
                    {revisionStarted ? (
                      <td className="whitespace-nowrap px-2 py-2">
                        <StageStatusCell
                          jobs={jobsByRow.get(rowKey) ?? []}
                          planned={stage.workers}
                        />
                      </td>
                    ) : null}
                    <td aria-hidden />
                  </tr>,
                  stage.scope === '' ? null : (
                    <tr
                      key={`${rowKey}-scope`}
                      className="border-b border-border/70 last:border-b-0"
                    >
                      <td colSpan={revisionStarted ? 7 : 6} className="px-2 pt-0 pb-2.5">
                        <StageScopeLines scope={stage.scope} />
                      </td>
                    </tr>
                  ),
                ]
              }),
            ])}
          </tbody>
        </table>
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-muted/20 px-4 py-2.5">
        <div className="flex items-center gap-4 text-xs">
          <span>
            Total workers: <strong>{plannedTotal}</strong>
          </span>
          <label className="flex items-center gap-2">
            Max workers
            <input
              type="number"
              min={1}
              step={1}
              value={maxWorkers}
              disabled={disabled}
              onChange={(event) =>
                setOrchestratePlanMaxWorkers(draftKey, event.currentTarget.valueAsNumber)
              }
              className="h-7 w-16 rounded-md border border-input bg-background px-2 text-right tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            />
          </label>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {revisionStarted ? (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {runFinished ? null : (
                <span
                  aria-hidden="true"
                  className="size-2 shrink-0 animate-pulse rounded-full bg-sky-500"
                />
              )}
              <span>
                {finishedCount} of {plannedTotal} planned worker
                {plannedTotal === 1 ? '' : 's'} finished
              </span>
              {notLaunchedCount > 0 ? (
                <span className="text-muted-foreground">{notLaunchedCount} not launched yet</span>
              ) : null}
              {failedCount > 0 ? (
                <span className="font-medium text-red-600 dark:text-red-400">
                  {failedCount} failed
                  {salvageableCount > 0 ? (
                    <span className="font-normal text-amber-600 dark:text-amber-400">
                      {' '}
                      · {salvageableCount} salvageable
                    </span>
                  ) : null}
                </span>
              ) : null}
            </div>
          ) : superseded ? (
            <span className="text-muted-foreground text-xs">
              Superseded by a newer plan for this run
            </span>
          ) : (
            <>
              {plan.validationError === null && cardState.error === null ? null : (
                <span role="alert" className="text-red-600 text-xs dark:text-red-400">
                  {plan.validationError ?? cardState.error}
                </span>
              )}
              {status === 'editing' ? (
                <span className="text-muted-foreground text-xs">
                  Reply moved to the composer — edit and send it there
                </span>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled || !maxWorkersValid}
                onClick={handleEditInChat}
              >
                Edit in chat
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={disabled || !maxWorkersValid}
                onClick={() => void handleApprove()}
              >
                {status === 'sending'
                  ? 'Approving…'
                  : status === 'sent'
                    ? 'Sent'
                    : cardState.error === null
                      ? 'Approve'
                      : 'Retry approval'}
              </Button>
            </>
          )}
          {openRunAction === null || runId === null ? null : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => openRunAction(runId)}
            >
              <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
              Open run
            </Button>
          )}
        </div>
      </footer>
    </section>
  )
}
