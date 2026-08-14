// apps/web/src/workers/workersPanel.logic.ts
// pure derivations for the workers right-panel surface

import type {
  WorkersFailureClass,
  WorkersJobOutcome,
  WorkersJobChange,
  WorkersJobStatus,
  WorkersJobSummary,
  WorkersOutcomeCounts,
  WorkersRunSummary,
  WorkersScopeViolationDetail,
  WorkersVerificationRun,
  WorkersVerificationSummary,
} from '@t3tools/contracts'
import * as Option from 'effect/Option'

import { formatDuration } from '~/session-logic'

export type WorkerStatusBadgeVariant =
  'default' | 'destructive' | 'error' | 'info' | 'outline' | 'secondary' | 'success' | 'warning'

export interface WorkerJobOutcomeFields
{
  readonly hasPatch?: Option.Option<boolean>
}

export interface WorkerJobOutcomeView
{
  readonly label: 'Patch available'
  readonly variant: 'success'
}

// only the broker's explicit patch signal establishes this positive outcome;
// legacy records and changed-file counts do not imply that a patch exists
export function workerJobOutcomeView(job: WorkerJobOutcomeFields): WorkerJobOutcomeView | null
{
  if (Option.getOrNull(job.hasPatch ?? Option.none<boolean>()) !== true) return null
  return { label: 'Patch available', variant: 'success' }
}

const JOB_OUTCOME_LABELS: Record<WorkersJobOutcome, string> = {
  succeeded: 'Succeeded',
  'worker-failed': 'Worker failed',
  'environment-blocked': 'Environment blocked',
  'baseline-broken': 'Baseline broken',
  'rejected-scope': 'Rejected scope',
  superseded: 'Superseded',
  cancelled: 'Cancelled',
  'broker-fault': 'Broker fault',
}

const JOB_OUTCOME_VARIANTS: Record<WorkersJobOutcome, WorkerStatusBadgeVariant> = {
  succeeded: 'success',
  'worker-failed': 'error',
  'environment-blocked': 'warning',
  'baseline-broken': 'warning',
  'rejected-scope': 'destructive',
  superseded: 'secondary',
  cancelled: 'warning',
  'broker-fault': 'error',
}

export interface WorkerEvidenceOutcomeView
{
  readonly outcome: WorkersJobOutcome
  readonly label: string
  readonly inferred: boolean
  readonly variant: WorkerStatusBadgeVariant
}

function inferredJobOutcome(job: WorkersJobSummary): WorkersJobOutcome | null
{
  if (Option.getOrNull(job.cancelReason) === 'superseded') return 'superseded'

  if (job.status === 'failed' || job.status === 'rejected')
  {
    switch (Option.getOrNull(job.failureClass))
    {
      case 'environment':
      case 'verification-unusable':
        return 'environment-blocked'
      case 'baseline-broken':
        return 'baseline-broken'
      case 'broker_fault':
        return 'broker-fault'
      case 'scope':
        return 'rejected-scope'
      case 'model':
      case 'verification':
      case 'verification-failed':
      case 'unknown':
      case null:
        return job.status === 'rejected' ? 'rejected-scope' : 'worker-failed'
    }
  }

  switch (job.status)
  {
    case 'completed':
      return 'succeeded'
    case 'cancelled':
      return 'cancelled'
    case 'queued':
    case 'running':
    case 'unknown':
      return null
  }
  return null
}

// explicit broker evidence wins; only legacy records fall back to status taxonomy
export function workerEvidenceOutcomeView(
  job: WorkersJobSummary,
): WorkerEvidenceOutcomeView | null
{
  const explicit = Option.getOrNull(job.outcome)
  const outcome = explicit ?? inferredJobOutcome(job)
  if (outcome === null) return null
  const inferred = explicit === null
  return {
    outcome,
    label: `${JOB_OUTCOME_LABELS[outcome]}${inferred ? ' (inferred)' : ''}`,
    inferred,
    variant: JOB_OUTCOME_VARIANTS[outcome],
  }
}

export interface WorkerRunOutcomePart
{
  readonly key: WorkersJobOutcome | 'patch-available'
  readonly count: number
  readonly inferredCount: number
  readonly label: string
}

export interface WorkerRunOutcomeSummaryView
{
  readonly label: string
  readonly parts: readonly WorkerRunOutcomePart[]
}

const RUN_OUTCOME_ORDER: readonly (WorkersJobOutcome | 'patch-available')[] = [
  'worker-failed',
  'environment-blocked',
  'baseline-broken',
  'rejected-scope',
  'broker-fault',
  'succeeded',
  'patch-available',
  'superseded',
  'cancelled',
]

// one derivation owns the outcome-first line on panel and plan surfaces
export function workerRunOutcomeSummaryView(
  jobs: readonly WorkersJobSummary[],
  rollup: WorkersOutcomeCounts = {},
): WorkerRunOutcomeSummaryView | null
{
  const counts = new Map<WorkersJobOutcome, { count: number; inferredCount: number }>()
  let patchCount = 0
  for (const job of jobs)
  {
    const outcome = workerEvidenceOutcomeView(job)
    if (outcome !== null)
    {
      const current = counts.get(outcome.outcome) ?? { count: 0, inferredCount: 0 }
      current.count += 1
      if (outcome.inferred) current.inferredCount += 1
      counts.set(outcome.outcome, current)
    }
    if (workerJobOutcomeView(job) !== null) patchCount += 1
  }
  if (jobs.length === 0)
  {
    for (const outcome of RUN_OUTCOME_ORDER)
    {
      if (outcome === 'patch-available') continue
      const count = rollup[outcome]
      if (count !== undefined && count > 0) counts.set(outcome, { count, inferredCount: 0 })
    }
  }

  const parts: WorkerRunOutcomePart[] = []
  for (const outcome of RUN_OUTCOME_ORDER)
  {
    if (outcome === 'patch-available')
    {
      if (patchCount > 0)
      {
        parts.push({
          key: 'patch-available',
          count: patchCount,
          inferredCount: 0,
          label: `${patchCount} patch available`,
        })
      }
      continue
    }
    const count = counts.get(outcome)
    if (count === undefined) continue
    const inference =
      count.inferredCount === 0
        ? ''
        : count.inferredCount === count.count
          ? ' (inferred)'
          : ` (${count.inferredCount} inferred)`
    parts.push({
      key: outcome,
      count: count.count,
      inferredCount: count.inferredCount,
      label: `${count.count} ${outcome}${inference}`,
    })
  }

  return parts.length === 0 ? null : { label: parts.map((part) => part.label).join(' · '), parts }
}

// every broker status gets its own tint so a scan of the table separates
// terminal failures from in-flight work without reading the label
export function workerStatusBadgeVariant(status: WorkersJobStatus): WorkerStatusBadgeVariant
{
  switch (status)
  {
    case 'completed':
      return 'success'
    case 'failed':
      return 'error'
    case 'rejected':
      return 'destructive'
    case 'running':
      return 'info'
    case 'queued':
      return 'secondary'
    case 'cancelled':
      return 'warning'
    case 'unknown':
      return 'outline'
  }
}

export interface WorkerVerificationView
{
  readonly label: string
  readonly failed: boolean
}

// "passed/total" with a failure flag; timed-out runs count as failures because
// the broker records them separately from hard failures
export function workerVerificationView(
  verification: Option.Option<WorkersVerificationSummary>,
): WorkerVerificationView | null
{
  const summary = Option.getOrNull(verification)
  if (summary === null) return null
  return {
    label: `${summary.passed}/${summary.total}`,
    failed: summary.failed > 0 || summary.timedOut > 0,
  }
}

const FAILURE_CLASS_LABELS: Record<WorkersFailureClass, string> = {
  environment: 'Environment',
  model: 'Model',
  broker_fault: 'Broker fault',
  scope: 'Scope',
  verification: 'Verification',
  'baseline-broken': 'Baseline broken',
  'verification-failed': 'Verification failed',
  'verification-unusable': 'Verification unusable',
  unknown: 'Unclassified',
}

export interface WorkerFailureView
{
  readonly label: string
  readonly evidence: string | null
}

// first nonzero exit code is the one that failed the job
function firstFailedExitCode(codes: ReadonlyArray<Option.Option<number>>): number | null
{
  for (const code of codes)
  {
    const value = Option.getOrNull(code)
    if (value !== null && value !== 0) return value
  }
  return null
}

// failure evidence stays diagnostic; an intact patch is a separate positive outcome
export function workerFailureView(job: WorkersJobSummary): WorkerFailureView | null
{
  const failureClass = Option.getOrNull(job.failureClass)
  if (failureClass === null) return null
  const hasPatch = Option.getOrNull(job.hasPatch ?? Option.none<boolean>())
  const parts: string[] = []
  if (hasPatch === false) parts.push('no patch')
  const changed = Option.getOrNull(job.changedFileCount)
  if (changed !== null && changed > 0) parts.push(`${changed} file${changed === 1 ? '' : 's'}`)
  const exitCode = firstFailedExitCode(job.verificationExitCodes)
  if (exitCode !== null) parts.push(`verify exit ${exitCode}`)
  return {
    label: FAILURE_CLASS_LABELS[failureClass],
    evidence: parts.length === 0 ? null : parts.join(' · '),
  }
}

// failure classes remain diagnostic context after the positive outcomes are summarized
export function workerRunFailureBreakdown(jobs: readonly WorkersJobSummary[]): string | null
{
  const failed = jobs.filter(
    (job) =>
      Option.isSome(job.failureClass) && workerEvidenceOutcomeView(job)?.outcome !== 'superseded',
  )
  if (failed.length === 0) return null
  const byClass = new Map<WorkersFailureClass, number>()
  for (const job of failed)
  {
    const failureClass = Option.getOrElse(job.failureClass, () => 'unknown' as const)
    byClass.set(failureClass, (byClass.get(failureClass) ?? 0) + 1)
  }
  const parts: string[] = []
  for (const [failureClass, count] of byClass)
  {
    parts.push(`${count} ${FAILURE_CLASS_LABELS[failureClass].toLowerCase()}`)
  }
  return parts.join(' · ')
}

export interface WorkerVerificationRunEntry
{
  readonly key: string
  readonly run: WorkersVerificationRun
}

// the same command can be run more than once per job, so keys carry an
// occurrence suffix instead of leaning on the array index
export function workerVerificationRunEntries(
  runs: readonly WorkersVerificationRun[],
): readonly WorkerVerificationRunEntry[]
{
  const occurrences = new Map<string, number>()
  return runs.map((run) =>
  {
    const occurrence = occurrences.get(run.command) ?? 0
    occurrences.set(run.command, occurrence + 1)
    return { key: `${run.command}#${occurrence}`, run }
  })
}

export function workerElapsedLabel(elapsedMs: Option.Option<number>): string | null
{
  const value = Option.getOrNull(elapsedMs)
  return value === null ? null : formatDuration(value)
}

// unknown stays active so a newer broker status cannot make the UI claim work is finished
export function workerJobIsActive(status: WorkersJobStatus): boolean
{
  return status === 'running' || status === 'queued' || status === 'unknown'
}

export type WorkerJobElapsedFields = Pick<
  WorkersJobSummary,
  'status' | 'elapsedMs' | 'startedAt' | 'createdAt'
>

// the caller's clock is the panel's shared minute timer, so a running span is only ever
// known to the minute; hours roll up so a long job does not read as a three-digit minute
function minuteSpanLabel(spanMs: number): string
{
  const minutes = Math.floor(spanMs / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`
}

// every span measured against that clock shares one vocabulary, so nothing still in
// flight ever claims a precision the minute timer cannot back
function clockSpanLabel(spanMs: number): string
{
  if (spanMs === 0) return 'just started'
  return spanMs < 60_000 ? 'under a minute so far' : `${minuteSpanLabel(spanMs)} so far`
}

// the broker only records elapsedMs once a job settles, so a live job counts from its own
// start against the caller's clock instead of rendering a dash; the recorded span keeps
// its measured precision while the clock-derived one stays minute-honest
export function workerJobElapsedLabel(job: WorkerJobElapsedFields, nowMs: number): string | null
{
  const settled = workerElapsedLabel(job.elapsedMs)
  if (!workerJobIsActive(job.status)) return settled

  const start =
    timestampMs(Option.getOrNull(job.startedAt)) ?? timestampMs(Option.getOrNull(job.createdAt))
  if (start === null) return settled

  return clockSpanLabel(Math.max(0, nowMs - start))
}

export interface WorkerJobPresentation
{
  readonly status: WorkersJobStatus
  readonly live: boolean
  readonly elapsedLabel: string | null
}

// the job detail RPC only refreshes every 30s while the jobs list is a live subscription,
// so a job that settled in between keeps reading as Running in the detail payload; status
// & timing are taken from whichever record has already settled, preferring the live list
// when both agree, and the rest of the detail payload is left untouched
export function workerJobPresentation(
  detail: WorkerJobElapsedFields,
  summary: WorkerJobElapsedFields | null,
  nowMs: number,
): WorkerJobPresentation
{
  const source =
    summary === null
      ? detail
      : !workerJobIsActive(summary.status)
        ? summary
        : !workerJobIsActive(detail.status)
          ? detail
          : summary

  return {
    status: source.status,
    live: workerJobIsActive(source.status),
    elapsedLabel: workerJobElapsedLabel(source, nowMs),
  }
}

export function repoBasename(repoPath: string): string
{
  const trimmed = repoPath.replace(/\/+$/, '')
  const separator = trimmed.lastIndexOf('/')
  return separator >= 0 ? trimmed.slice(separator + 1) : trimmed
}

export function shortSha(sha: string): string
{
  return sha.length > 10 ? sha.slice(0, 10) : sha
}

function timestampMs(iso: string | null): number | null
{
  if (iso === null) return null
  const parsed = Date.parse(iso)
  return Number.isFinite(parsed) ? parsed : null
}

// model & effort only exist on records the broker wrote with them, so they are read
// as optional on top of the summary shape a detail record also satisfies
export interface WorkerModelFields
{
  readonly model?: Option.Option<string>
  readonly effort?: Option.Option<string>
}

// "model · effort", collapsing to whichever half the record carries
export function workerModelLabel(job: WorkersJobSummary & WorkerModelFields): string | null
{
  const model = Option.getOrNull(job.model ?? Option.none<string>())
  const effort = Option.getOrNull(job.effort ?? Option.none<string>())
  if (model === null) return effort
  return effort === null ? model : `${model} · ${effort}`
}

export interface WorkerStageGroup
{
  readonly key: string
  readonly stage: string | null
  readonly workflow: string | null
  readonly jobs: readonly WorkersJobSummary[]
}

// groups come out in plan order of first appearance (oldest job wins the slot) while
// jobs inside a group stay newest-first to match the flat list; stage-less jobs fall
// into a trailing "other" bucket
export function workerStageGroups(jobs: readonly WorkersJobSummary[]): readonly WorkerStageGroup[]
{
  interface MutableGroup
  {
    key: string
    stage: string | null
    workflow: string | null
    jobs: WorkersJobSummary[]
  }

  const groups = new Map<string, MutableGroup>()
  const other: MutableGroup = { key: 'other', stage: null, workflow: null, jobs: [] }
  for (const job of jobs.toReversed())
  {
    const stage = Option.getOrNull(job.stage)
    if (stage === null)
    {
      other.jobs.unshift(job)
      continue
    }

    const workflow = Option.getOrNull(job.workflow)
    const key = `${workflow ?? ''}\u0000${stage}`
    const group = groups.get(key)
    if (group === undefined)
    {
      groups.set(key, { key, stage, workflow, jobs: [job] })
    }
    else
    {
      group.jobs.unshift(job)
    }
  }

  return other.jobs.length === 0 ? [...groups.values()] : [...groups.values(), other]
}

export function workerJobsHaveStages(jobs: readonly WorkersJobSummary[]): boolean
{
  return jobs.some((job) => Option.isSome(job.stage))
}

export interface WorkerRunJobRow
{
  readonly job: WorkersJobSummary
  readonly priorAttempts: readonly WorkersJobSummary[]
}

function jobIsExplicitlySuperseded(job: WorkersJobSummary): boolean
{
  return (
    job.status === 'cancelled' &&
    (Option.getOrNull(job.outcome) === 'superseded' ||
      Option.getOrNull(job.cancelReason) === 'superseded')
  )
}

// only broker links connect attempts; ordering and timestamps never imply supersession
export function workerRunJobRows(jobs: readonly WorkersJobSummary[]): readonly WorkerRunJobRow[]
{
  const byId = new Map(jobs.map((job) => [job.jobId, job]))
  const relaunches = new Map<string, WorkersJobSummary[]>()
  for (const job of jobs)
  {
    const priorId = Option.getOrNull(job.relaunchOf)
    if (priorId === null) continue
    const matches = relaunches.get(priorId)
    if (matches === undefined) relaunches.set(priorId, [job])
    else matches.push(job)
  }

  const successorByPrior = new Map<string, string>()
  for (const job of jobs)
  {
    if (!jobIsExplicitlySuperseded(job)) continue
    const forwardId = Option.getOrNull(job.supersededBy)
    if (forwardId !== null && forwardId !== job.jobId && byId.has(forwardId))
    {
      successorByPrior.set(job.jobId, forwardId)
      continue
    }
    const linkedRelaunches = relaunches.get(job.jobId) ?? []
    const linkedRelaunch = linkedRelaunches[0]
    if (linkedRelaunches.length === 1 && linkedRelaunch !== undefined)
    {
      successorByPrior.set(job.jobId, linkedRelaunch.jobId)
    }
  }

  // discard cyclic evidence instead of hiding every row in a malformed chain
  for (const priorId of Array.from(successorByPrior.keys()))
  {
    const visited = new Set<string>([priorId])
    let current = successorByPrior.get(priorId)
    while (current !== undefined)
    {
      if (visited.has(current))
      {
        for (const cycleId of visited) successorByPrior.delete(cycleId)
        break
      }
      visited.add(current)
      current = successorByPrior.get(current)
    }
  }

  const priorsBySuccessor = new Map<string, WorkersJobSummary[]>()
  for (const [priorId, successorId] of successorByPrior)
  {
    const prior = byId.get(priorId)
    if (prior === undefined) continue
    const priors = priorsBySuccessor.get(successorId)
    if (priors === undefined) priorsBySuccessor.set(successorId, [prior])
    else priors.push(prior)
  }

  const collectPriors = (jobId: string, visited: Set<string>): WorkersJobSummary[] =>
  {
    const direct = priorsBySuccessor.get(jobId) ?? []
    const collected: WorkersJobSummary[] = []
    for (const prior of direct)
    {
      if (visited.has(prior.jobId)) continue
      visited.add(prior.jobId)
      collected.push(prior, ...collectPriors(prior.jobId, visited))
    }
    return collected
  }

  return jobs.flatMap((job) =>
    successorByPrior.has(job.jobId)
      ? []
      : [{ job, priorAttempts: collectPriors(job.jobId, new Set([job.jobId])) }],
  )
}

export interface WorkerScopeViolationFields
{
  readonly scopeViolationDetails?: Option.Option<ReadonlyArray<WorkersScopeViolationDetail>>
  readonly scopeViolations?: ReadonlyArray<string>
}

export interface WorkerScopeViolationItem
{
  readonly path: string
  readonly phase: WorkersScopeViolationDetail['phase'] | null
}

export interface WorkerScopeViolationGroup
{
  readonly key: string
  readonly label: string
  readonly legacy: boolean
  readonly items: readonly WorkerScopeViolationItem[]
}

// structured warnings group by root cause; legacy strings stay visibly ungrouped
export function workerScopeViolationGroups(
  fields: WorkerScopeViolationFields,
): readonly WorkerScopeViolationGroup[]
{
  const details = Option.getOrNull(
    fields.scopeViolationDetails ?? Option.none<ReadonlyArray<WorkersScopeViolationDetail>>(),
  )
  if (details !== null && details.length > 0)
  {
    const groups = new Map<string, WorkerScopeViolationItem[]>()
    for (const detail of details)
    {
      const root = detail.root.trim()
      const nearestAllowed = Option.getOrNull(detail.nearestAllowed)
      const key = root === '' ? (nearestAllowed ?? 'ungrouped') : root
      const items = groups.get(key)
      const item = { path: detail.path, phase: detail.phase }
      if (items === undefined) groups.set(key, [item])
      else items.push(item)
    }
    return [...groups].map(([key, items]) => ({ key, label: key, legacy: false, items }))
  }

  const legacy = fields.scopeViolations ?? []
  return legacy.length === 0
    ? []
    : [
        {
          key: 'ungrouped (legacy)',
          label: 'ungrouped (legacy)',
          legacy: true,
          items: legacy.map((path) => ({ path, phase: null })),
        },
      ]
}

export interface WorkerRunStatusChip
{
  readonly status: WorkersJobStatus
  readonly count: number
  readonly variant: WorkerStatusBadgeVariant
}

// in-flight statuses lead so a glance at a row answers "is this run still moving?"
const RUN_CHIP_STATUSES = [
  'running',
  'queued',
  'completed',
  'failed',
  'rejected',
  'cancelled',
  'unknown',
] as const

export type WorkerRunCounts = {
  readonly [Status in (typeof RUN_CHIP_STATUSES)[number]]: number
}

// shared by run rows & per-stage rollups; zero-count statuses are dropped so a clean
// run reads as one chip instead of six
export function workerRunStatusChips(counts: WorkerRunCounts): readonly WorkerRunStatusChip[]
{
  return RUN_CHIP_STATUSES.flatMap((status) =>
    counts[status] === 0
      ? []
      : [{ status, count: counts[status], variant: workerStatusBadgeVariant(status) }],
  )
}

// a stage group can span workflows, so its chips are counted off the grouped jobs
// rather than looked up in the run's stage rollups
export function workerStageCounts(jobs: readonly WorkersJobSummary[]): WorkerRunCounts
{
  const counts = {
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
    rejected: 0,
    cancelled: 0,
    unknown: 0,
  }
  for (const job of jobs)
  {
    counts[job.status] += 1
  }
  return counts
}

export function workerRunIsSettled(counts: WorkerRunCounts): boolean
{
  return !RUN_CHIP_STATUSES.some((status) => workerJobIsActive(status) && counts[status] > 0)
}

// a settled run spans two recorded timestamps, so it keeps their measured precision; any
// other run is still ending against the caller's minute clock & reads minute-honest,
// matching how a live job states its own elapsed
export function workerRunSpanLabel(run: WorkersRunSummary, nowMs: number): string | null
{
  const start = timestampMs(Option.getOrNull(run.firstCreatedAt))
  if (start === null) return null
  const completed = timestampMs(Option.getOrNull(run.lastCompletedAt))
  if (workerRunIsSettled(run) && completed !== null)
  {
    return formatDuration(Math.max(0, completed - start))
  }
  return clockSpanLabel(Math.max(0, nowMs - start))
}

function runOrderKey(run: WorkersRunSummary): number
{
  return (
    timestampMs(Option.getOrNull(run.firstCreatedAt)) ??
    timestampMs(Option.getOrNull(run.lastCompletedAt)) ??
    0
  )
}

// newest first, with the run id as a stable tiebreaker for records the broker wrote
// without timestamps
export function sortWorkerRunsNewestFirst(
  runs: readonly WorkersRunSummary[],
): readonly WorkersRunSummary[]
{
  return [...runs].sort((left, right) =>
  {
    const delta = runOrderKey(right) - runOrderKey(left)
    return delta === 0 ? right.run.localeCompare(left.run) : delta
  })
}

export interface WorkerPatchFileEntry
{
  readonly path: string
  readonly status: string | null
}

// the broker records per-file change statuses separately from the flat changed-file
// list; statuses win & the flat list backfills anything they missed
export function workerPatchFileEntries(job: {
  readonly changes: readonly WorkersJobChange[]
  readonly changedFiles: readonly string[]
}): readonly WorkerPatchFileEntry[]
{
  const seen = new Set<string>()
  const entries: WorkerPatchFileEntry[] = []
  for (const change of job.changes)
  {
    for (const path of change.paths)
    {
      if (seen.has(path)) continue
      seen.add(path)
      entries.push({ path, status: change.status })
    }
  }
  for (const path of job.changedFiles)
  {
    if (seen.has(path)) continue
    seen.add(path)
    entries.push({ path, status: null })
  }
  return entries
}

export interface WorkerPatchClipboard
{
  readonly label: string
  readonly text: string
}

// patch contents never cross the wire, so the copy affordance hands over the broker's
// patch file path when there is one & the per-file listing otherwise
export function workerPatchClipboard(job: {
  readonly patchPath: Option.Option<string>
  readonly changes: readonly WorkersJobChange[]
  readonly changedFiles: readonly string[]
}): WorkerPatchClipboard | null
{
  const patchPath = Option.getOrNull(job.patchPath)
  if (patchPath !== null) return { label: 'Copy patch path', text: patchPath }

  const entries = workerPatchFileEntries(job)
  if (entries.length === 0) return null
  return {
    label: 'Copy file list',
    text: entries
      .map((entry) => (entry.status === null ? entry.path : `${entry.status}\t${entry.path}`))
      .join('\n'),
  }
}
