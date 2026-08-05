// apps/server/src/workers/WorkerBrokerStore.ts
// read-only reader for local worker-broker job records on disk

import type {
  WorkersActivityEntry,
  WorkersActivityInput,
  WorkersActivitySnapshot,
  WorkersFailureClass,
  WorkersGetJobInput,
  WorkersGetJobResult,
  WorkersGetRunInput,
  WorkersGetRunResult,
  WorkersJobChange,
  WorkersJobDetail,
  WorkersJobStatus,
  WorkersJobSummary,
  WorkersListInput,
  WorkersListResult,
  WorkersListRunsInput,
  WorkersListRunsResult,
  WorkersRunStageRollup,
  WorkersRunSummary,
  WorkersVerificationRun,
  WorkersVerificationSummary,
} from '@t3tools/contracts'
import { HostProcessEnvironment } from '@t3tools/shared/hostProcess'
import * as Context from 'effect/Context'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as PlatformError from 'effect/PlatformError'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import * as NodeOS from 'node:os'

/**
 * WorkerBrokerStore - Read-only view over the local worker-broker state directory.
 *
 * Never fails: every unavailable, corrupt, or unknown state is reported in-band
 * through the workers contract so the dashboard degrades instead of erroring.
 */
export class WorkerBrokerStore extends Context.Service<
  WorkerBrokerStore,
  {
    readonly list: (input: WorkersListInput) => Effect.Effect<WorkersListResult>
    readonly listRuns: (input: WorkersListRunsInput) => Effect.Effect<WorkersListRunsResult>
    readonly getJob: (input: WorkersGetJobInput) => Effect.Effect<WorkersGetJobResult>
    readonly getRun: (input: WorkersGetRunInput) => Effect.Effect<WorkersGetRunResult>
    readonly readActivity: (input: WorkersActivityInput) => Effect.Effect<WorkersActivitySnapshot>
    readonly jobsDir: string
  }
>()('456code/workers/WorkerBrokerStore')
{}

const SUPPORTED_SCHEMA_VERSION = 1
const MAX_ACTIVITY_BYTES = 256 * 1024
const MAX_ACTIVITY_ENTRIES = 200

// activity lines are arbitrary broker JSON, so they decode to unknown & are
// shaped by normalizeActivityRecord; a malformed line throws and is skipped
const decodeActivityLine = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

// lenient mirror of the broker's on-disk snake_case record; unknown keys are ignored
// and everything but the id is optional so partial or in-flight jobs still decode
const DiskJobChange = Schema.Struct({
  status: Schema.optional(Schema.String),
  paths: Schema.optional(Schema.Array(Schema.String)),
})

const DiskVerificationRun = Schema.Struct({
  command: Schema.optional(Schema.String),
  exit_code: Schema.optional(Schema.NullOr(Schema.Number)),
  timed_out: Schema.optional(Schema.NullOr(Schema.Boolean)),
  elapsed_ms: Schema.optional(Schema.NullOr(Schema.Number)),
})

const DiskJobRequest = Schema.Struct({
  provider: Schema.optional(Schema.String),
  mode: Schema.optional(Schema.String),
  repo: Schema.optional(Schema.String),
  task: Schema.optional(Schema.String),
  base_ref: Schema.optional(Schema.String),
  allowed_paths: Schema.optional(Schema.Array(Schema.String)),
  model: Schema.optional(Schema.String),
  effort: Schema.optional(Schema.String),
  stage: Schema.optional(Schema.String),
  workflow: Schema.optional(Schema.String),
  run: Schema.optional(Schema.String),
})

const DiskJobResult = Schema.Struct({
  status: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.String),
  mode: Schema.optional(Schema.String),
  repo: Schema.optional(Schema.String),
  base_ref: Schema.optional(Schema.String),
  base_sha: Schema.optional(Schema.String),
  head_sha: Schema.optional(Schema.String),
  branch: Schema.optional(Schema.String),
  worktree: Schema.optional(Schema.String),
  elapsed_ms: Schema.optional(Schema.NullOr(Schema.Number)),
  changed_files: Schema.optional(Schema.Array(Schema.String)),
  changes: Schema.optional(Schema.Array(DiskJobChange)),
  verification: Schema.optional(Schema.Array(DiskVerificationRun)),
  scope_violations: Schema.optional(Schema.Array(Schema.String)),
  summary: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  assumptions: Schema.optional(Schema.Array(Schema.String)),
  risks: Schema.optional(Schema.Array(Schema.String)),
  follow_ups: Schema.optional(Schema.Array(Schema.String)),
  patch_path: Schema.optional(Schema.String),
  failure_class: Schema.optional(Schema.String),
  process_exit_code: Schema.optional(Schema.NullOr(Schema.Number)),
  created_at: Schema.optional(Schema.String),
  started_at: Schema.optional(Schema.String),
  completed_at: Schema.optional(Schema.String),
})

type DiskJobResult = typeof DiskJobResult.Type

const DiskJobRecord = Schema.Struct({
  job_id: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  created_at: Schema.optional(Schema.String),
  started_at: Schema.optional(Schema.String),
  completed_at: Schema.optional(Schema.String),
  base_sha: Schema.optional(Schema.String),
  branch: Schema.optional(Schema.String),
  worktree: Schema.optional(Schema.String),
  error: Schema.optional(Schema.NullOr(Schema.String)),
  schema_version: Schema.optional(Schema.NullOr(Schema.Number)),
  request: Schema.optional(DiskJobRequest),
  result: Schema.optional(DiskJobResult),
})

type DiskJobRecord = typeof DiskJobRecord.Type

const decodeDiskJobRecordExit = Schema.decodeUnknownExit(Schema.fromJsonString(DiskJobRecord))

function toText(value: string | null | undefined): string | null
{
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function toTextOption(value: string | null | undefined): Option.Option<string>
{
  return Option.fromNullishOr(toText(value))
}

function toTextList(values: ReadonlyArray<string> | null | undefined): ReadonlyArray<string>
{
  if (!Array.isArray(values)) return []
  return values.flatMap((value) =>
  {
    const text = toText(value)
    return text === null ? [] : [text]
  })
}

function toInt(value: number | null | undefined): number | null
{
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null
}

function toNonNegativeInt(value: number | null | undefined): number | null
{
  const integer = toInt(value)
  return integer !== null && integer >= 0 ? integer : null
}

// broker statuses degrade to "unknown" so a newer broker cannot break the read model
function toJobStatus(value: string | null | undefined): WorkersJobStatus
{
  switch (toText(value))
  {
    case 'queued':
      return 'queued'
    case 'running':
      return 'running'
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'rejected':
      return 'rejected'
    case 'cancelled':
      return 'cancelled'
    default:
      return 'unknown'
  }
}

function toVerificationRuns(
  runs: DiskJobResult['verification'],
): ReadonlyArray<WorkersVerificationRun>
{
  if (!Array.isArray(runs)) return []
  return runs.flatMap((run) =>
  {
    const command = toText(run.command)
    if (command === null) return []
    return [
      {
        command,
        exitCode: Option.fromNullishOr(toInt(run.exit_code)),
        timedOut: run.timed_out === true,
        elapsedMs: Option.fromNullishOr(toNonNegativeInt(run.elapsed_ms)),
      },
    ]
  })
}

function toVerificationSummary(record: DiskJobRecord): Option.Option<WorkersVerificationSummary>
{
  const runs = record.result?.verification
  if (!Array.isArray(runs)) return Option.none()

  const total = runs.length
  let timedOut = 0
  let passed = 0
  for (const run of runs)
  {
    if (run.timed_out === true)
    {
      timedOut += 1
      continue
    }
    if (toInt(run.exit_code) === 0)
    {
      passed += 1
    }
  }
  return Option.some({ total, passed, failed: total - passed - timedOut, timedOut })
}

const FAILURE_CLASSES: ReadonlySet<string> = new Set([
  'environment',
  'model',
  'broker_fault',
  'scope',
  'verification',
])

// mirror the broker's failure taxonomy for terminal failures; legacy records
// and unrecognized values degrade to "unknown" rather than failing decode
function toFailureClass(record: DiskJobRecord): Option.Option<WorkersFailureClass>
{
  const status = toJobStatus(record.status ?? record.result?.status)
  if (status !== 'failed' && status !== 'rejected') return Option.none()
  const raw = toText(record.result?.failure_class)
  return Option.some(
    raw !== null && FAILURE_CLASSES.has(raw) ? (raw as WorkersFailureClass) : 'unknown',
  )
}

// patch presence is evidence of salvageable work; absent result blocks stay unknown
function toHasPatch(result: DiskJobResult | undefined): Option.Option<boolean>
{
  if (result === undefined) return Option.none()
  return Option.some(toText(result.patch_path) !== null)
}

function toVerificationExitCodes(
  runs: DiskJobResult['verification'],
): ReadonlyArray<Option.Option<number>>
{
  if (!Array.isArray(runs)) return []
  return runs.map((run) => Option.fromNullishOr(toInt(run.exit_code)))
}

function toJobChanges(changes: DiskJobResult['changes']): ReadonlyArray<WorkersJobChange>
{
  if (!Array.isArray(changes)) return []
  return changes.flatMap((change) =>
  {
    const status = toText(change.status)
    return status === null ? [] : [{ status, paths: toTextList(change.paths) }]
  })
}

// top-level fields win; the terminal result block is the fallback for jobs
// whose top level omits branch / base_sha / timestamps
function toJobSummary(jobId: string, record: DiskJobRecord): WorkersJobSummary
{
  const request = record.request
  const result = record.result
  return {
    jobId,
    status: toJobStatus(record.status ?? result?.status),
    provider: toText(request?.provider) ?? toText(result?.provider) ?? 'unknown',
    mode: toText(request?.mode) ?? toText(result?.mode) ?? 'unknown',
    repo: toText(request?.repo) ?? toText(result?.repo) ?? 'unknown',
    branch: toTextOption(record.branch ?? result?.branch),
    stage: toTextOption(request?.stage),
    workflow: toTextOption(request?.workflow),
    run: toTextOption(request?.run),
    model: toTextOption(request?.model),
    effort: toTextOption(request?.effort),
    error: toTextOption(record.error ?? result?.error),
    createdAt: toTextOption(record.created_at ?? result?.created_at),
    startedAt: toTextOption(record.started_at ?? result?.started_at),
    completedAt: toTextOption(record.completed_at ?? result?.completed_at),
    elapsedMs: Option.fromNullishOr(toNonNegativeInt(result?.elapsed_ms)),
    changedFileCount: Array.isArray(result?.changed_files)
      ? Option.some(toTextList(result.changed_files).length)
      : Option.none(),
    verification: toVerificationSummary(record),
    scopeViolationCount: toTextList(result?.scope_violations).length,
    failureClass: toFailureClass(record),
    hasPatch: toHasPatch(result),
    verificationExitCodes: toVerificationExitCodes(result?.verification),
  }
}

function toJobDetail(jobId: string, record: DiskJobRecord): WorkersJobDetail
{
  const request = record.request
  const result = record.result
  return {
    ...toJobSummary(jobId, record),
    task: toText(request?.task) ?? '',
    allowedPaths: toTextList(request?.allowed_paths),
    baseRef: toTextOption(request?.base_ref ?? result?.base_ref),
    baseSha: toTextOption(record.base_sha ?? result?.base_sha),
    headSha: toTextOption(result?.head_sha),
    worktree: toTextOption(record.worktree ?? result?.worktree),
    patchPath: toTextOption(result?.patch_path),
    summary: toTextOption(result?.summary),
    assumptions: toTextList(result?.assumptions),
    risks: toTextList(result?.risks),
    followUps: toTextList(result?.follow_ups),
    changedFiles: toTextList(result?.changed_files),
    changes: toJobChanges(result?.changes),
    verificationRuns: toVerificationRuns(result?.verification),
    scopeViolations: toTextList(result?.scope_violations),
    processExitCode: Option.fromNullishOr(toInt(result?.process_exit_code)),
  }
}

// newest first; records without a created_at timestamp sort last
function compareJobsNewestFirst(left: WorkersJobSummary, right: WorkersJobSummary): number
{
  const leftCreatedAt = Option.getOrUndefined(left.createdAt)
  const rightCreatedAt = Option.getOrUndefined(right.createdAt)
  if (leftCreatedAt === undefined && rightCreatedAt === undefined) return 0
  if (leftCreatedAt === undefined) return 1
  if (rightCreatedAt === undefined) return -1
  if (leftCreatedAt === rightCreatedAt) return 0
  return leftCreatedAt < rightCreatedAt ? 1 : -1
}

type RunCounts = {
  total: number
  queued: number
  running: number
  completed: number
  failed: number
  rejected: number
  cancelled: number
  unknown: number
}

type RunAccumulator = RunCounts & {
  run: string
  workflows: Set<string>
  firstCreatedAt: string | null
  lastCompletedAt: string | null
  stages: Map<string | null, RunCounts>
  scopeViolationCount: number
}

function emptyRunCounts(): RunCounts
{
  return {
    total: 0,
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
    rejected: 0,
    cancelled: 0,
    unknown: 0,
  }
}

function addJobToCounts(counts: RunCounts, status: WorkersJobStatus): void
{
  counts.total += 1
  counts[status] += 1
}

function aggregateRuns(jobs: ReadonlyArray<WorkersJobSummary>): WorkersRunSummary[]
{
  const runs = new Map<string, RunAccumulator>()

  for (const job of jobs)
  {
    const run = Option.getOrUndefined(job.run)
    if (run === undefined) continue

    let accumulator = runs.get(run)
    if (accumulator === undefined)
    {
      accumulator = {
        run,
        workflows: new Set(),
        firstCreatedAt: null,
        lastCompletedAt: null,
        stages: new Map(),
        scopeViolationCount: 0,
        ...emptyRunCounts(),
      }
      runs.set(run, accumulator)
    }

    addJobToCounts(accumulator, job.status)
    accumulator.scopeViolationCount += job.scopeViolationCount

    const workflow = Option.getOrUndefined(job.workflow)
    if (workflow !== undefined) accumulator.workflows.add(workflow)

    const createdAt = Option.getOrUndefined(job.createdAt)
    if (
      createdAt !== undefined &&
      (accumulator.firstCreatedAt === null || createdAt < accumulator.firstCreatedAt)
    )
    {
      accumulator.firstCreatedAt = createdAt
    }

    const completedAt = Option.getOrUndefined(job.completedAt)
    if (
      completedAt !== undefined &&
      (accumulator.lastCompletedAt === null || completedAt > accumulator.lastCompletedAt)
    )
    {
      accumulator.lastCompletedAt = completedAt
    }

    const stage = Option.getOrUndefined(job.stage) ?? null
    let stageCounts = accumulator.stages.get(stage)
    if (stageCounts === undefined)
    {
      stageCounts = emptyRunCounts()
      accumulator.stages.set(stage, stageCounts)
    }
    addJobToCounts(stageCounts, job.status)
  }

  return [...runs.values()]
    .map((run): WorkersRunSummary => ({
      run: run.run,
      workflows: [...run.workflows].toSorted(),
      firstCreatedAt: Option.fromNullishOr(run.firstCreatedAt),
      lastCompletedAt: Option.fromNullishOr(run.lastCompletedAt),
      total: run.total,
      queued: run.queued,
      running: run.running,
      completed: run.completed,
      failed: run.failed,
      rejected: run.rejected,
      cancelled: run.cancelled,
      unknown: run.unknown,
      stages: [...run.stages.entries()]
        .toSorted(([left], [right]) =>
        {
          if (left === null) return right === null ? 0 : -1
          if (right === null) return 1
          return left.localeCompare(right)
        })
        .map(([stage, counts]): WorkersRunStageRollup => ({
          stage: Option.fromNullishOr(stage),
          ...counts,
        })),
      scopeViolationCount: run.scopeViolationCount,
    }))
    .toSorted((left, right) =>
    {
      const leftCreatedAt = Option.getOrUndefined(left.firstCreatedAt)
      const rightCreatedAt = Option.getOrUndefined(right.firstCreatedAt)
      if (leftCreatedAt === rightCreatedAt) return left.run.localeCompare(right.run)
      if (leftCreatedAt === undefined) return 1
      if (rightCreatedAt === undefined) return -1
      return leftCreatedAt < rightCreatedAt ? 1 : -1
    })
}

// job ids address a directory under <stateDir>/jobs; anything that could escape
// it is rejected before it is ever joined into a path
export function isSafeJobId(jobId: string): boolean
{
  return (
    jobId.length > 0 &&
    !jobId.includes('/') &&
    !jobId.includes('\\') &&
    !jobId.includes('..') &&
    !jobId.startsWith('.')
  )
}

function isNotFoundError(error: PlatformError.PlatformError): boolean
{
  return error.reason._tag === 'NotFound'
}

function normalizeActivityRecord(
  value: unknown,
  previousSequence: number,
): WorkersActivityEntry | null
{
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.schema_version !== SUPPORTED_SCHEMA_VERSION) return null
  if (
    typeof record.sequence !== 'number' ||
    !Number.isSafeInteger(record.sequence) ||
    record.sequence <= 0 ||
    record.sequence <= previousSequence
  )
  {
    return null
  }
  if (
    typeof record.recorded_at !== 'string' ||
    record.recorded_at.trim().length === 0 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      record.recorded_at,
    ) ||
    Number.isNaN(Date.parse(record.recorded_at))
  )
  {
    return null
  }

  const base = { sequence: record.sequence, recordedAt: record.recorded_at }
  const status = record.status
  const validStatus = status === 'started' || status === 'completed' || status === 'failed'
  if (record.kind === 'phase')
  {
    const phase = record.phase
    const validPhase =
      phase === 'preparing' ||
      phase === 'working' ||
      phase === 'verifying' ||
      phase === 'finalizing'
    return validPhase && validStatus ? { ...base, kind: 'phase', phase, status } : null
  }
  if (record.kind === 'action')
  {
    return validStatus ? { ...base, kind: 'action', status } : null
  }
  if (record.kind === 'message' && typeof record.summary === 'string')
  {
    const summary = record.summary
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .trim()
      .slice(0, 1000)
    return summary.length > 0 ? { ...base, kind: 'message', summary } : null
  }
  return null
}

function resolveStateDir(environment: NodeJS.ProcessEnv, path: Path.Path): string
{
  const explicitHome = toText(environment.WORKER_BROKER_HOME)
  if (explicitHome !== null) return explicitHome
  const xdgStateHome = toText(environment.XDG_STATE_HOME)
  if (xdgStateHome !== null) return path.join(xdgStateHome, 'worker-broker')
  return path.join(NodeOS.homedir(), '.local', 'state', 'worker-broker')
}

type JobRecordOutcome =
  | { readonly _tag: 'Loaded'; readonly jobId: string; readonly record: DiskJobRecord }
  | { readonly _tag: 'Missing' }
  | { readonly _tag: 'Skipped'; readonly reason: string }

export const make = Effect.gen(function* ()
{
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  // env is fixed for the process lifetime, so the state dir is resolved once
  const environment = yield* HostProcessEnvironment
  const stateDir = resolveStateDir(environment, path)
  const jobsDir = path.join(stateDir, 'jobs')

  const stateDirExists = fileSystem
    .exists(stateDir)
    .pipe(Effect.orElseSucceed(() => false as boolean))

  const readJobRecord = Effect.fn('WorkerBrokerStore.readJobRecord')(function* (
    jobId: string,
  ): Effect.fn.Return<JobRecordOutcome>
  {
    const recordPath = path.join(jobsDir, jobId, 'job.json')
    const text = yield* fileSystem.readFileString(recordPath).pipe(Effect.result)
    if (Result.isFailure(text))
    {
      if (isNotFoundError(text.failure)) return { _tag: 'Missing' }
      return { _tag: 'Skipped', reason: `Failed to read job record '${recordPath}'.` }
    }

    const decoded = decodeDiskJobRecordExit(text.success)
    if (decoded._tag === 'Failure')
    {
      return { _tag: 'Skipped', reason: `Failed to parse job record '${recordPath}'.` }
    }

    const record = decoded.value
    const schemaVersion = toInt(record.schema_version) ?? SUPPORTED_SCHEMA_VERSION
    if (schemaVersion !== SUPPORTED_SCHEMA_VERSION)
    {
      return {
        _tag: 'Skipped',
        reason: `Unsupported worker-broker schema_version ${schemaVersion} in '${recordPath}'.`,
      }
    }

    return { _tag: 'Loaded', jobId: toText(record.job_id) ?? jobId, record }
  })

  const list: WorkerBrokerStore['Service']['list'] = Effect.fn('WorkerBrokerStore.list')(
    function* (input)
    {
      const readAt = DateTime.formatIso(yield* DateTime.now)
      if (!(yield* stateDirExists))
      {
        return {
          state: 'state-dir-missing',
          stateDir,
          readAt,
          jobs: [],
          skippedJobCount: 0,
          error: Option.none(),
        }
      }

      const entries = yield* fileSystem.readDirectory(jobsDir).pipe(Effect.result)
      if (Result.isFailure(entries))
      {
        // a missing jobs/ subdirectory just means the broker has not run yet
        if (isNotFoundError(entries.failure))
        {
          return {
            state: 'available',
            stateDir,
            readAt,
            jobs: [],
            skippedJobCount: 0,
            error: Option.none(),
          }
        }
        yield* Effect.logWarning('Failed to read worker-broker jobs directory.').pipe(
          Effect.annotateLogs({ jobsDir, causeTag: entries.failure.reason._tag }),
        )
        return {
          state: 'available',
          stateDir,
          readAt,
          jobs: [],
          skippedJobCount: 0,
          error: Option.some({ message: `Failed to read jobs directory '${jobsDir}'.` }),
        }
      }

      const outcomes = yield* Effect.all(
        entries.success
          .filter((entry) => isSafeJobId(entry))
          .map((entry) => readJobRecord(entry).pipe(Effect.result)),
        { concurrency: 1 },
      )

      const jobs: WorkersJobSummary[] = []
      let skippedJobCount = 0
      for (const outcome of outcomes)
      {
        if (Result.isFailure(outcome))
        {
          skippedJobCount += 1
          continue
        }
        if (outcome.success._tag === 'Loaded')
        {
          const job = toJobSummary(outcome.success.jobId, outcome.success.record)
          const jobRun = Option.getOrUndefined(job.run)
          if (input.run === undefined || jobRun === input.run.trim()) jobs.push(job)
          continue
        }
        if (outcome.success._tag === 'Skipped')
        {
          skippedJobCount += 1
          yield* Effect.logWarning('Skipped an unreadable worker-broker job record.').pipe(
            Effect.annotateLogs({ jobsDir, reason: outcome.success.reason }),
          )
        }
      }

      return {
        state: 'available',
        stateDir,
        readAt,
        jobs: jobs.toSorted(compareJobsNewestFirst),
        skippedJobCount,
        error: Option.none(),
      }
    },
  )

  const listRuns: WorkerBrokerStore['Service']['listRuns'] = Effect.fn(
    'WorkerBrokerStore.listRuns',
  )(function* (_input)
  {
    const snapshot = yield* list({})
    return {
      state: snapshot.state,
      stateDir: snapshot.stateDir,
      readAt: snapshot.readAt,
      runs: aggregateRuns(snapshot.jobs),
      skippedJobCount: snapshot.skippedJobCount,
      error: snapshot.error,
    }
  })

  const getJob: WorkerBrokerStore['Service']['getJob'] = Effect.fn('WorkerBrokerStore.getJob')(
    function* (input)
    {
      const readAt = DateTime.formatIso(yield* DateTime.now)
      const jobId = input.jobId.trim()
      if (!isSafeJobId(jobId))
      {
        return {
          readAt,
          job: Option.none(),
          error: Option.some({ message: 'The requested job id is not a valid job identifier.' }),
        }
      }

      if (!(yield* stateDirExists))
      {
        return {
          readAt,
          job: Option.none(),
          error: Option.some({
            message: `Worker-broker state directory '${stateDir}' was not found.`,
          }),
        }
      }

      const outcome = yield* readJobRecord(jobId)
      if (outcome._tag === 'Loaded')
      {
        return {
          readAt,
          job: Option.some(toJobDetail(outcome.jobId, outcome.record)),
          error: Option.none(),
        }
      }

      if (outcome._tag === 'Skipped')
      {
        yield* Effect.logWarning('Skipped an unreadable worker-broker job record.').pipe(
          Effect.annotateLogs({ jobsDir, reason: outcome.reason }),
        )
        return { readAt, job: Option.none(), error: Option.some({ message: outcome.reason }) }
      }

      return {
        readAt,
        job: Option.none(),
        error: Option.some({ message: `Worker-broker job '${jobId}' was not found.` }),
      }
    },
  )

  const getRun: WorkerBrokerStore['Service']['getRun'] = Effect.fn('WorkerBrokerStore.getRun')(
    function* (input)
    {
      const runName = input.run.trim()
      const snapshot = yield* list({ run: runName })
      const run = aggregateRuns(snapshot.jobs)[0]
      if (snapshot.state === 'state-dir-missing')
      {
        return {
          readAt: snapshot.readAt,
          run: Option.none(),
          jobs: [],
          error: Option.some({
            message: `Worker-broker state directory '${stateDir}' was not found.`,
          }),
        }
      }
      if (Option.isSome(snapshot.error))
      {
        return {
          readAt: snapshot.readAt,
          run: Option.none(),
          jobs: [],
          error: snapshot.error,
        }
      }
      if (run === undefined)
      {
        return {
          readAt: snapshot.readAt,
          run: Option.none(),
          jobs: [],
          error: Option.some({ message: `Worker-broker run '${runName}' was not found.` }),
        }
      }
      return {
        readAt: snapshot.readAt,
        run: Option.some(run),
        jobs: snapshot.jobs,
        error: Option.none(),
      }
    },
  )

  const readActivity: WorkerBrokerStore['Service']['readActivity'] = Effect.fn(
    'WorkerBrokerStore.readActivity',
  )(function* (input)
  {
    const readAt = DateTime.formatIso(yield* DateTime.now)
    const jobId = input.jobId.trim()
    const empty = (overrides?: Partial<WorkersActivitySnapshot>): WorkersActivitySnapshot => ({
      jobId: jobId.length > 0 ? jobId : 'invalid',
      readAt,
      entries: [],
      skippedEntryCount: 0,
      truncated: false,
      error: Option.none(),
      ...overrides,
    })
    if (!isSafeJobId(jobId))
    {
      return empty({
        error: Option.some({ message: 'The requested job id is not a valid job identifier.' }),
      })
    }

    const activityPath = path.join(jobsDir, jobId, 'activity.jsonl')
    const info = yield* fileSystem.stat(activityPath).pipe(Effect.result)
    if (Result.isFailure(info))
    {
      if (isNotFoundError(info.failure)) return empty()
      return empty({ error: Option.some({ message: 'Failed to read worker activity.' }) })
    }

    const size = BigInt(info.success.size)
    const maxBytes = BigInt(MAX_ACTIVITY_BYTES)
    const byteTruncated = size > maxBytes
    const offset = byteTruncated ? size - maxBytes : BigInt(0)
    let tailStartsAtRecordBoundary = true
    if (byteTruncated)
    {
      const precedingByte = yield* fileSystem
        .stream(activityPath, { offset: offset - BigInt(1), bytesToRead: BigInt(1) })
        .pipe(Stream.runHead, Effect.result)
      if (Result.isFailure(precedingByte))
      {
        return empty({ error: Option.some({ message: 'Failed to read worker activity.' }) })
      }
      tailStartsAtRecordBoundary = Option.match(precedingByte.success, {
        onNone: () => false,
        onSome: (chunk) => chunk[0] === 0x0a,
      })
    }
    const text = yield* fileSystem.stream(activityPath, { offset, bytesToRead: maxBytes }).pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => '',
        (acc, chunk) => acc + chunk,
      ),
      Effect.result,
    )
    if (Result.isFailure(text))
    {
      return empty({ error: Option.some({ message: 'Failed to read worker activity.' }) })
    }

    const lines = text.success.split(/\r?\n/)
    let skippedEntryCount = 0
    if (byteTruncated && !tailStartsAtRecordBoundary && lines.length > 0)
    {
      lines.shift()
      skippedEntryCount += 1
    }
    const entries: WorkersActivityEntry[] = []
    let previousSequence = 0
    for (const line of lines)
    {
      if (line.trim().length === 0) continue
      let parsed: unknown
      try
      {
        parsed = decodeActivityLine(line)
      }
      catch
      {
        skippedEntryCount += 1
        continue
      }
      const entry = normalizeActivityRecord(parsed, previousSequence)
      if (entry === null)
      {
        skippedEntryCount += 1
        continue
      }
      entries.push(entry)
      previousSequence = entry.sequence
    }

    const entryTruncated = entries.length > MAX_ACTIVITY_ENTRIES
    return empty({
      entries: entryTruncated ? entries.slice(-MAX_ACTIVITY_ENTRIES) : entries,
      skippedEntryCount,
      truncated: byteTruncated || entryTruncated,
    })
  })

  return WorkerBrokerStore.of({ list, listRuns, getJob, getRun, readActivity, jobsDir })
})

export const layer = Layer.effect(WorkerBrokerStore, make)
