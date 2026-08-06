// apps/web/src/components/chat/orchestrate-plan/parse.ts
// parse orchestrate plan payloads and build approval reply grammar

import type {
  OrchestratePlanDecision,
  OrchestratePlanRevision,
  OrchestratePlanStageOverride,
  ProviderInstanceId,
  EnvironmentId,
} from '@t3tools/contracts'

import type { AppModelOption } from '../../../modelSelection'
import type { ProviderInstanceEntry } from '../../../providerInstances'
import type { OrchestrateStageSelection } from './orchestratePlanStore'

export interface OrchestratePlanStage
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

export interface OrchestratePlanResponse
{
  readonly runId: OrchestratePlanRevision['runId']
  readonly revision: number
  readonly decision: OrchestratePlanDecision
  readonly stageOverrides?: ReadonlyArray<OrchestratePlanStageOverride>
  readonly maxWorkers?: number
  readonly note?: string
}

/**
 * Callbacks and model-catalog data the chat view supplies so plan cards can
 * edit stage bindings with the app's regular model picker and send responses.
 */
export interface OrchestratePlanActions
{
  environmentId: EnvironmentId
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>
  orchestratePlans: ReadonlyArray<OrchestratePlanRevision>
  onApprove: (reply: string) => Promise<boolean>
  onRespond: (response: OrchestratePlanResponse) => Promise<boolean>
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
export interface PlanRow
{
  rowKey: string
  stage: OrchestratePlanStage
  // display-only marker for plans that repeat a stage id across waves
  occurrence: number | null
}

export function buildPlanRows(stages: ReadonlyArray<OrchestratePlanStage>): PlanRow[]
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
export function groupRowsByPhase(
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
export function planContentText(plan: OrchestratePlan): string
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

export function latestPersistedRevision(
  revisions: ReadonlyArray<OrchestratePlanRevision>,
  runId: string | null,
): OrchestratePlanRevision | null
{
  if (runId === null) return null
  let latest: OrchestratePlanRevision | null = null
  for (const revision of revisions)
  {
    if (revision.runId === runId && (latest === null || revision.revision > latest.revision))
    {
      latest = revision
    }
  }
  return latest
}

export function persistedRevisionToPlan(revision: OrchestratePlanRevision): OrchestratePlan
{
  return {
    workflow: revision.workflow,
    task: revision.task,
    stages: revision.stages.map((stage) => ({
      id: stage.id,
      provider: stage.provider,
      model: stage.model ?? '',
      ...(stage.effort === undefined ? {} : { effort: stage.effort }),
      mode: stage.mode,
      workers: stage.workers,
      scope: stage.scope ?? '',
      ...(stage.phase === undefined ? {} : { phase: stage.phase }),
    })),
    totalWorkers: revision.totalWorkers,
    maxWorkers: revision.maxWorkers,
    runId: revision.runId,
    validationError: null,
  }
}

// harnesses the worker broker can launch directly; models picked from other
// providers are sent model-only and the orchestrator resolves the harness
export const BROKER_PROVIDERS = new Set(['codex', 'cursor', 'coral'])

export function initialSelection(
  stage: OrchestratePlanStage,
  entries: ReadonlyArray<ProviderInstanceEntry>,
): OrchestrateStageSelection
{
  const entry =
    entries.find((candidate) => candidate.driverKind === stage.provider) ?? entries[0] ?? null
  return { provider: stage.provider, model: stage.model, instanceId: entry?.instanceId ?? null }
}

export function buildPersistedStageOverrides(
  plan: OrchestratePlan,
  options: {
    readonly selections: Readonly<Record<string, OrchestrateStageSelection>>
    readonly efforts: Readonly<Record<string, string>>
    readonly workers: Readonly<Record<string, number>>
    readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>
  },
): OrchestratePlanStageOverride[]
{
  const overrides: OrchestratePlanStageOverride[] = []
  for (const { rowKey, stage } of buildPlanRows(plan.stages))
  {
    const selection = options.selections[rowKey] ?? initialSelection(stage, options.instanceEntries)
    const effort = options.efforts[rowKey] ?? stage.effort ?? ''
    const workers = options.workers[rowKey] ?? stage.workers
    const override: {
      stageId: string
      provider?: string
      model?: string
      effort?: string
      workers?: number
    } = { stageId: stage.id }

    if (selection.provider !== stage.provider) override.provider = selection.provider
    if (selection.model !== stage.model && selection.model !== '') override.model = selection.model
    if (effort !== (stage.effort ?? '') && effort !== '') override.effort = effort
    if (workers !== stage.workers) override.workers = workers
    if (
      override.provider !== undefined ||
      override.model !== undefined ||
      override.effort !== undefined ||
      override.workers !== undefined
    )
    {
      overrides.push(override)
    }
  }
  return overrides
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
