// apps/server/src/vcs/ExactGitSnapshotGit.ts
// run bounded git subprocesses for exact snapshots

// @effect-diagnostics nodeBuiltinImport:off globalTimers:off

import * as NodeChildProcess from 'node:child_process'

export type ExactGitSnapshotErrorCode =
  | 'cancelled'
  | 'cleanup-failed'
  | 'dirty-submodule'
  | 'git-failed'
  | 'invalid-input'
  | 'limit-exceeded'
  | 'unsupported-entry'
  | 'verification-failed'

export class ExactGitSnapshotError extends Error
{
  readonly code: ExactGitSnapshotErrorCode

  constructor(code: ExactGitSnapshotErrorCode, message: string, options?: ErrorOptions)
  {
    super(message, options)
    this.name = 'ExactGitSnapshotError'
    this.code = code
  }
}

export const GIT_TIMEOUT_MS = 30_000
export const GIT_LISTING_MAX_BYTES = 64 * 1024 * 1024
export const GIT_STDERR_MAX_BYTES = 64 * 1024
export const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u

export function exactError(
  code: ExactGitSnapshotErrorCode,
  message: string,
  cause?: unknown,
): ExactGitSnapshotError
{
  return new ExactGitSnapshotError(code, message, cause === undefined ? undefined : { cause })
}

export interface GitResult
{
  readonly exitCode: number
  readonly stdout: Buffer
  readonly stderr: Buffer
}

export interface GitOptions
{
  readonly allowNonZeroExit?: boolean
  readonly env?: NodeJS.ProcessEnv
  readonly stdin?: Buffer
  readonly maxStdoutBytes?: number
}

export function throwIfCancelled(signal: AbortSignal): void
{
  if (signal.aborted)
  {
    throw exactError('cancelled', 'Exact Git snapshot operation was cancelled.')
  }
}

export function gitEnvironment(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv
{
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_LITERAL_PATHSPECS: '1',
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    LANG: 'C',
    LC_ALL: 'C',
    ...overrides,
  }
  if (overrides?.GIT_INDEX_FILE === undefined)
  {
    delete environment.GIT_INDEX_FILE
  }
  return environment
}

export function runGit(
  cwd: string,
  args: ReadonlyArray<string>,
  signal: AbortSignal,
  options: GitOptions = {},
): Promise<GitResult>
{
  throwIfCancelled(signal)
  const maxStdoutBytes = options.maxStdoutBytes ?? GIT_LISTING_MAX_BYTES

  return new Promise((resolve, reject) =>
  {
    let child: NodeChildProcess.ChildProcessWithoutNullStreams
    try
    {
      child = NodeChildProcess.spawn('git', ['-C', cwd, ...args], {
        env: gitEnvironment(options.env),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    }
    catch (cause)
    {
      reject(exactError('git-failed', `Could not start git ${args[0] ?? 'command'}.`, cause))
      return
    }

    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let terminalError: ExactGitSnapshotError | null = null
    let settled = false

    const stop = (error: ExactGitSnapshotError) =>
    {
      terminalError ??= error
      child.kill('SIGKILL')
    }
    const abort = () =>
    {
      stop(exactError('cancelled', 'Exact Git snapshot operation was cancelled.'))
    }
    const timeout = setTimeout(() =>
    {
      stop(exactError('git-failed', `git ${args[0] ?? 'command'} timed out.`))
    }, GIT_TIMEOUT_MS)

    signal.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk: Buffer) =>
    {
      stdoutBytes += chunk.byteLength
      if (stdoutBytes > maxStdoutBytes)
      {
        stop(exactError('git-failed', `git ${args[0] ?? 'command'} exceeded its bounded output.`))
        return
      }
      stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) =>
    {
      stderrBytes += chunk.byteLength
      if (stderrBytes > GIT_STDERR_MAX_BYTES)
      {
        stop(
          exactError(
            'git-failed',
            `git ${args[0] ?? 'command'} exceeded its bounded error output.`,
          ),
        )
        return
      }
      stderr.push(chunk)
    })
    child.on('error', (cause) =>
    {
      stop(exactError('git-failed', `Could not run git ${args[0] ?? 'command'}.`, cause))
    })
    child.stdin.on('error', (cause: NodeJS.ErrnoException) =>
    {
      if (cause.code !== 'EPIPE')
      {
        stop(exactError('git-failed', `Could not write to git ${args[0] ?? 'command'}.`, cause))
      }
    })
    child.on('close', (code) =>
    {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      if (terminalError !== null)
      {
        reject(terminalError)
        return
      }
      if (code === null)
      {
        reject(exactError('git-failed', `git ${args[0] ?? 'command'} returned no exit code.`))
        return
      }
      if (code !== 0 && options.allowNonZeroExit !== true)
      {
        const detail = Buffer.concat(stderr).toString('utf8').trim()
        reject(
          exactError(
            'git-failed',
            detail.length > 0
              ? `git ${args[0] ?? 'command'} failed: ${detail}`
              : `git ${args[0] ?? 'command'} failed with exit code ${String(code)}.`,
          ),
        )
        return
      }
      resolve({
        exitCode: code,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      })
    })

    if (signal.aborted) abort()
    child.stdin.end(options.stdin)
  })
}

export function trimLineBreak(buffer: Buffer): string
{
  return buffer.toString('utf8').replace(/\r?\n$/u, '')
}
