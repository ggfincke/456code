// apps/server/src/diagnostics/ProcessDiagnostics.ts
// parse posix process rows

import type {
  ServerProcessDiagnosticsEntry,
  ServerProcessDiagnosticsResult,
  ServerProcessSignal,
  ServerSignalProcessResult,
} from '@t3tools/contracts'
import { HostProcessPlatform } from '@t3tools/shared/hostProcess'
import * as Context from 'effect/Context'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import * as ProcessRunner from '../processRunner.ts'

export interface ProcessRow
{
  readonly pid: number
  readonly ppid: number
  readonly pgid: number | null
  readonly status: string
  readonly cpuPercent: number
  readonly rssBytes: number
  readonly elapsed: string
  readonly command: string
}

const PROCESS_QUERY_TIMEOUT_MS = 1_000
const POSIX_PROCESS_QUERY_COMMAND = 'pid=,ppid=,pgid=,stat=,pcpu=,rss=,etime=,command='
const PROCESS_QUERY_MAX_OUTPUT_BYTES = 2 * 1024 * 1024

export class ProcessDiagnostics extends Context.Service<
  ProcessDiagnostics,
  {
    readonly read: Effect.Effect<ServerProcessDiagnosticsResult>
    readonly signal: (input: {
      readonly pid: number
      readonly signal: ServerProcessSignal
    }) => Effect.Effect<ServerSignalProcessResult>
  }
>()('456code/diagnostics/ProcessDiagnostics')
{}

class ProcessDiagnosticsQueryTimeoutError extends Schema.TaggedErrorClass<ProcessDiagnosticsQueryTimeoutError>()(
  'ProcessDiagnosticsQueryTimeoutError',
  {
    command: Schema.String,
    argCount: Schema.Number,
    cwd: Schema.String,
    timeoutMillis: Schema.Number,
  },
)
{
  override get message(): string
  {
    return `Process diagnostics query '${this.command}' timed out after ${this.timeoutMillis}ms in '${this.cwd}'.`
  }
}

class ProcessDiagnosticsQueryFailedError extends Schema.TaggedErrorClass<ProcessDiagnosticsQueryFailedError>()(
  'ProcessDiagnosticsQueryFailedError',
  {
    command: Schema.String,
    argCount: Schema.Number,
    cwd: Schema.String,
    exitCode: Schema.optional(Schema.Number),
    stdoutBytes: Schema.optional(Schema.Number),
    stderrBytes: Schema.optional(Schema.Number),
    stdoutTruncated: Schema.optional(Schema.Boolean),
    stderrTruncated: Schema.optional(Schema.Boolean),
    cause: Schema.optional(Schema.Defect()),
  },
)
{
  override get message(): string
  {
    const exitCode = this.exitCode === undefined ? '' : ` with exit code ${this.exitCode}`
    return `Process diagnostics query '${this.command}' failed${exitCode} in '${this.cwd}'.`
  }
}

class ProcessDiagnosticsServerProcessSignalError extends Schema.TaggedErrorClass<ProcessDiagnosticsServerProcessSignalError>()(
  'ProcessDiagnosticsServerProcessSignalError',
  { pid: Schema.Number },
)
{
  override get message(): string
  {
    return 'Refusing to signal the 456code server process.'
  }
}

class ProcessDiagnosticsNotDescendantError extends Schema.TaggedErrorClass<ProcessDiagnosticsNotDescendantError>()(
  'ProcessDiagnosticsNotDescendantError',
  {
    pid: Schema.Number,
    serverPid: Schema.Number,
  },
)
{
  override get message(): string
  {
    return `Process ${this.pid} is not a live descendant of the 456code server.`
  }
}

class ProcessDiagnosticsSignalFailedError extends Schema.TaggedErrorClass<ProcessDiagnosticsSignalFailedError>()(
  'ProcessDiagnosticsSignalFailedError',
  {
    pid: Schema.Number,
    signal: Schema.String,
    cause: Schema.Defect(),
  },
)
{
  override get message(): string
  {
    return `Failed to signal process ${this.pid} with ${this.signal}.`
  }
}

const ProcessDiagnosticsQueryError = Schema.Union([
  ProcessDiagnosticsQueryTimeoutError,
  ProcessDiagnosticsQueryFailedError,
])
type ProcessDiagnosticsQueryError = typeof ProcessDiagnosticsQueryError.Type

const ProcessDiagnosticsError = Schema.Union([
  ProcessDiagnosticsQueryError,
  ProcessDiagnosticsServerProcessSignalError,
  ProcessDiagnosticsNotDescendantError,
  ProcessDiagnosticsSignalFailedError,
])
type ProcessDiagnosticsError = typeof ProcessDiagnosticsError.Type

function parsePositiveInt(value: string): number | null
{
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function parseNonNegativeInt(value: string): number | null
{
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null
}

function parseNumber(value: string): number | null
{
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function parsePosixProcessRows(output: string): ReadonlyArray<ProcessRow>
{
  const rows: ProcessRow[] = []
  const rowPattern =
    /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+([+-]?(?:\d+\.?\d*|\.\d+))\s+(\d+)\s+(\S+)\s+(.+)$/

  for (const line of output.split(/\r?\n/))
  {
    if (line.trim().length === 0) continue

    const match = rowPattern.exec(line)
    if (!match) continue

    const pidText = match[1]
    const ppidText = match[2]
    const pgidText = match[3]
    const status = match[4]
    const cpuText = match[5]
    const rssText = match[6]
    const elapsed = match[7]
    const command = match[8]
    if (
      pidText === undefined ||
      ppidText === undefined ||
      pgidText === undefined ||
      status === undefined ||
      cpuText === undefined ||
      rssText === undefined ||
      elapsed === undefined ||
      command === undefined
    )
    {
      continue
    }

    const pid = parsePositiveInt(pidText)
    const ppid = parseNonNegativeInt(ppidText)
    const pgid = Number.parseInt(pgidText, 10)
    const cpuPercent = parseNumber(cpuText)
    const rssKiB = parseNonNegativeInt(rssText)
    if (
      pid === null ||
      ppid === null ||
      !Number.isInteger(pgid) ||
      cpuPercent === null ||
      rssKiB === null ||
      !status ||
      !elapsed ||
      !command
    )
    {
      continue
    }

    rows.push({
      pid,
      ppid,
      pgid,
      status,
      cpuPercent,
      rssBytes: rssKiB * 1024,
      elapsed,
      command,
    })
  }

  return rows
}

function normalizeWindowsProcessRow(value: unknown): ProcessRow | null
{
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const pid = typeof record.ProcessId === 'number' ? record.ProcessId : null
  const ppid = typeof record.ParentProcessId === 'number' ? record.ParentProcessId : null
  const commandLine =
    typeof record.CommandLine === 'string' && record.CommandLine.trim().length > 0
      ? record.CommandLine
      : typeof record.Name === 'string'
        ? record.Name
        : null
  const workingSet =
    typeof record.WorkingSetSize === 'number' && Number.isFinite(record.WorkingSetSize)
      ? Math.max(0, Math.round(record.WorkingSetSize))
      : 0
  const cpuPercent =
    typeof record.PercentProcessorTime === 'number' && Number.isFinite(record.PercentProcessorTime)
      ? Math.max(0, record.PercentProcessorTime)
      : 0

  if (!pid || pid <= 0 || ppid === null || ppid < 0 || !commandLine) return null
  return {
    pid,
    ppid,
    pgid: null,
    status: typeof record.Status === 'string' && record.Status.length > 0 ? record.Status : 'Live',
    cpuPercent,
    rssBytes: workingSet,
    elapsed: '',
    command: commandLine,
  }
}

function parseWindowsProcessRows(output: string): ReadonlyArray<ProcessRow>
{
  if (output.trim().length === 0) return []
  try
  {
    const parsed = JSON.parse(output) as unknown
    const records = Array.isArray(parsed) ? parsed : [parsed]
    return records.flatMap((record) =>
    {
      const row = normalizeWindowsProcessRow(record)
      return row ? [row] : []
    })
  }
  catch
  {
    return []
  }
}

export function buildDescendantEntries(
  rows: ReadonlyArray<ProcessRow>,
  serverPid: number,
): ReadonlyArray<ServerProcessDiagnosticsEntry>
{
  const childrenByParent = new Map<number, ProcessRow[]>()
  for (const row of rows)
  {
    const children = childrenByParent.get(row.ppid) ?? []
    children.push(row)
    childrenByParent.set(row.ppid, children)
  }

  const entries: ServerProcessDiagnosticsEntry[] = []
  const visited = new Set<number>()
  const stack = [...(childrenByParent.get(serverPid) ?? [])]
    .toSorted((left, right) => left.pid - right.pid)
    .map((row) => ({ row, depth: 0 }))

  while (stack.length > 0)
  {
    const item = stack.shift()
    if (!item || visited.has(item.row.pid)) continue
    visited.add(item.row.pid)

    const children = [...(childrenByParent.get(item.row.pid) ?? [])].toSorted(
      (left, right) => left.pid - right.pid,
    )
    entries.push({
      pid: item.row.pid,
      ppid: item.row.ppid,
      pgid: Option.fromNullishOr(item.row.pgid),
      status: item.row.status,
      cpuPercent: item.row.cpuPercent,
      rssBytes: item.row.rssBytes,
      elapsed: item.row.elapsed || 'n/a',
      command: item.row.command,
      depth: item.depth,
      childPids: children.map((child) => child.pid),
    })

    stack.unshift(...children.map((row) => ({ row, depth: item.depth + 1 })))
  }

  return entries
}

export function isDiagnosticsQueryProcess(row: ProcessRow, serverPid: number): boolean
{
  if (row.ppid !== serverPid) return false

  const command = row.command.trim()
  return (
    /(?:^|[/\\])ps\s+-axo\s+pid=,ppid=,pgid=,stat=,pcpu=,rss=,etime=,command=/.test(command) ||
    (/\bpowershell(?:\.exe)?\b/i.test(command) &&
      /\bGet-CimInstance\s+Win32_Process\b/i.test(command))
  )
}

function makeResult(input: {
  readonly serverPid: number
  readonly rows: ReadonlyArray<ProcessRow>
  readonly readAt: DateTime.Utc
  readonly error?: string
}): ServerProcessDiagnosticsResult
{
  const readAt = input.readAt
  const rows = input.rows.filter((row) => !isDiagnosticsQueryProcess(row, input.serverPid))
  const processes = buildDescendantEntries(rows, input.serverPid)
  const totalRssBytes = processes.reduce((total, process) => total + process.rssBytes, 0)
  const totalCpuPercent = processes.reduce((total, process) => total + process.cpuPercent, 0)

  return {
    serverPid: input.serverPid,
    readAt,
    processCount: processes.length,
    totalRssBytes,
    totalCpuPercent,
    processes,
    error: input.error ? Option.some({ message: input.error }) : Option.none(),
  }
}

interface ProcessOutput
{
  readonly cwd: string
  readonly exitCode: number | null
  readonly stdout: string
  readonly stdoutBytes: number
  readonly stdoutTruncated: boolean
  readonly stderr: string
  readonly stderrBytes: number
  readonly stderrTruncated: boolean
}

const runProcess = Effect.fn('runProcess')(function* (input: {
  readonly command: string
  readonly args: ReadonlyArray<string>
})
{
  const cwd = process.cwd()
  const processRunner = yield* ProcessRunner.ProcessRunner
  return yield* processRunner
    .run({
      command: input.command,
      args: input.args,
      cwd,
      timeout: PROCESS_QUERY_TIMEOUT_MS,
      maxOutputBytes: PROCESS_QUERY_MAX_OUTPUT_BYTES,
      outputMode: 'truncate',
      truncatedMarker: '\n\n[truncated]',
    })
    .pipe(
      Effect.map(
        (result) =>
          ({
            cwd,
            exitCode: result.code === null ? null : Number(result.code),
            stdout: result.stdout,
            stdoutBytes: Buffer.byteLength(result.stdout),
            stdoutTruncated: result.stdoutTruncated,
            stderr: result.stderr,
            stderrBytes: Buffer.byteLength(result.stderr),
            stderrTruncated: result.stderrTruncated,
          }) satisfies ProcessOutput,
      ),
      Effect.mapError((cause) =>
        cause._tag === 'ProcessTimeoutError'
          ? new ProcessDiagnosticsQueryTimeoutError({
              command: input.command,
              argCount: input.args.length,
              cwd,
              timeoutMillis: PROCESS_QUERY_TIMEOUT_MS,
            })
          : new ProcessDiagnosticsQueryFailedError({
              command: input.command,
              argCount: input.args.length,
              cwd,
              cause,
            }),
      ),
    )
})

function readPosixProcessRows(): Effect.Effect<
  ReadonlyArray<ProcessRow>,
  ProcessDiagnosticsQueryError,
  ProcessRunner.ProcessRunner
>
{
  return runProcess({
    command: 'ps',
    args: ['-axo', POSIX_PROCESS_QUERY_COMMAND],
  }).pipe(
    Effect.flatMap((result) =>
      result.exitCode !== 0
        ? Effect.fail(
            new ProcessDiagnosticsQueryFailedError({
              command: 'ps',
              argCount: 2,
              cwd: result.cwd,
              ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
              stdoutBytes: result.stdoutBytes,
              stderrBytes: result.stderrBytes,
              stdoutTruncated: result.stdoutTruncated,
              stderrTruncated: result.stderrTruncated,
            }),
          )
        : Effect.succeed(parsePosixProcessRows(result.stdout)),
    ),
  )
}

function readWindowsProcessRows(): Effect.Effect<
  ReadonlyArray<ProcessRow>,
  ProcessDiagnosticsQueryError,
  ProcessRunner.ProcessRunner
>
{
  const command = [
    '$processes = Get-CimInstance Win32_Process | ForEach-Object {',
    '$perf = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -Filter "IDProcess = $($_.ProcessId)" -ErrorAction SilentlyContinue;',
    '[pscustomobject]@{ ProcessId = $_.ProcessId; ParentProcessId = $_.ParentProcessId; Name = $_.Name; CommandLine = $_.CommandLine; Status = $_.Status; WorkingSetSize = $_.WorkingSetSize; PercentProcessorTime = if ($perf) { $perf.PercentProcessorTime } else { 0 } }',
    '};',
    '$processes | ConvertTo-Json -Compress -Depth 3',
  ].join(' ')

  return runProcess({
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-Command', command],
  }).pipe(
    Effect.flatMap((result) =>
      result.exitCode !== 0
        ? Effect.fail(
            new ProcessDiagnosticsQueryFailedError({
              command: 'powershell.exe',
              argCount: 4,
              cwd: result.cwd,
              ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
              stdoutBytes: result.stdoutBytes,
              stderrBytes: result.stderrBytes,
              stdoutTruncated: result.stdoutTruncated,
              stderrTruncated: result.stderrTruncated,
            }),
          )
        : Effect.succeed(parseWindowsProcessRows(result.stdout)),
    ),
  )
}

export const readProcessRowsWithRunner = Effect.gen(function* ()
{
  const platform = yield* HostProcessPlatform
  return yield* platform === 'win32' ? readWindowsProcessRows() : readPosixProcessRows()
})

export const readProcessRows = readProcessRowsWithRunner.pipe(Effect.provide(ProcessRunner.layer))

export function aggregateProcessDiagnostics(input: {
  readonly serverPid: number
  readonly rows: ReadonlyArray<ProcessRow>
  readonly readAt: DateTime.Utc
}): ServerProcessDiagnosticsResult
{
  return makeResult(input)
}

function assertDescendantPid(
  pid: number,
): Effect.Effect<void, ProcessDiagnosticsError, ProcessRunner.ProcessRunner>
{
  if (pid === process.pid)
  {
    return Effect.fail(
      new ProcessDiagnosticsServerProcessSignalError({
        pid,
      }),
    )
  }

  return readProcessRowsWithRunner.pipe(
    Effect.flatMap((rows) =>
    {
      const filteredRows = rows.filter((row) => !isDiagnosticsQueryProcess(row, process.pid))
      const descendant = buildDescendantEntries(filteredRows, process.pid).some(
        (entry) => entry.pid === pid,
      )
      return descendant
        ? Effect.void
        : Effect.fail(
            new ProcessDiagnosticsNotDescendantError({
              pid,
              serverPid: process.pid,
            }),
          )
    }),
  )
}

export const make = Effect.gen(function* ()
{
  const processRunner = yield* ProcessRunner.ProcessRunner

  const read: ProcessDiagnostics['Service']['read'] = Effect.gen(function* ()
  {
    const readAt = yield* DateTime.now
    const rows = yield* readProcessRowsWithRunner.pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
    )
    return makeResult({ serverPid: process.pid, rows, readAt })
  }).pipe(
    Effect.catch((error: ProcessDiagnosticsQueryError) =>
      DateTime.now.pipe(
        Effect.map((readAt) =>
          makeResult({ serverPid: process.pid, rows: [], readAt, error: error.message }),
        ),
      ),
    ),
  )

  const signal: ProcessDiagnostics['Service']['signal'] = Effect.fn('ProcessDiagnostics.signal')(
    function* (input)
    {
      return yield* assertDescendantPid(input.pid).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
        Effect.flatMap(() =>
          Effect.try({
            try: () =>
            {
              process.kill(input.pid, input.signal)
              return {
                pid: input.pid,
                signal: input.signal,
                signaled: true,
                message: Option.none(),
              }
            },
            catch: (cause) =>
              new ProcessDiagnosticsSignalFailedError({
                pid: input.pid,
                signal: input.signal,
                cause,
              }),
          }),
        ),
        Effect.catch((error: ProcessDiagnosticsError) =>
          Effect.succeed({
            pid: input.pid,
            signal: input.signal,
            signaled: false,
            message: Option.some(error.message),
          }),
        ),
      )
    },
  )

  return ProcessDiagnostics.of({ read, signal })
})

export const layer = Layer.effect(ProcessDiagnostics, make).pipe(Layer.provide(ProcessRunner.layer))
