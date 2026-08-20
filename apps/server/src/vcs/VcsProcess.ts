// apps/server/src/vcs/VcsProcess.ts
// define vcs process input

import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Match from 'effect/Match'
import { ChildProcessSpawner } from 'effect/unstable/process'

import {
  type VcsError,
  VcsProcessExitError,
  type VcsProcessExitFailureKind,
  VcsProcessMissingExitCodeError,
  VcsProcessOutputLimitError,
  VcsProcessOutputReadError,
  VcsProcessSpawnError,
  VcsProcessStdinWriteError,
  VcsProcessTimeoutError,
} from '@t3tools/contracts'
import * as ProcessRunner from '../process/processRunner.ts'

export interface VcsProcessInput
{
  readonly operation: string
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly spawnCwd?: string
  readonly stdin?: string
  readonly env?: NodeJS.ProcessEnv
  readonly allowNonZeroExit?: boolean
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  readonly appendTruncationMarker?: boolean
}

export interface VcsProcessOutput
{
  readonly exitCode: ChildProcessSpawner.ExitCode
  readonly stdout: string
  readonly stderr: string
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
}

interface VcsProcessErrorContext
{
  readonly operation: string
  readonly command: string
  readonly cwd: string
  readonly argumentCount?: number
}

function makeVcsProcessSpawnError(
  context: VcsProcessErrorContext,
  error: { readonly cause: unknown },
): VcsProcessSpawnError
{
  return new VcsProcessSpawnError({ ...context, cause: error.cause })
}

function makeVcsProcessTimeoutError(
  context: VcsProcessErrorContext,
  error: { readonly timeoutMs: number },
): VcsProcessTimeoutError
{
  return new VcsProcessTimeoutError({ ...context, timeoutMs: error.timeoutMs })
}

function makeVcsProcessExitError(
  context: VcsProcessErrorContext,
  error: {
    readonly exitCode: number
    readonly stderr: string
    readonly stderrTruncated: boolean
  },
  failureKind: VcsProcessExitFailureKind,
): VcsProcessExitError
{
  const detail =
    failureKind === 'authentication'
      ? 'Authentication failed.'
      : failureKind === 'rate-limited'
        ? 'Provider API rate limit exceeded.'
        : failureKind === 'not-found'
          ? context.command === 'glab'
            ? 'Merge request not found.'
            : context.command === 'gh' || context.command === 'az'
              ? 'Pull request not found.'
              : 'VCS resource not found.'
          : 'Process exited with a non-zero status.'

  return new VcsProcessExitError({
    ...context,
    exitCode: error.exitCode,
    detail,
    failureKind,
    stderrLength: error.stderr.length,
    stderrTruncated: error.stderrTruncated,
  })
}

export class VcsProcess extends Context.Service<
  VcsProcess,
  {
    readonly run: (input: VcsProcessInput) => Effect.Effect<VcsProcessOutput, VcsError>
  }
>()('456code/vcs/VcsProcess')
{}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000
const OUTPUT_TRUNCATED_MARKER = '\n\n[truncated]'

const classifyNonZeroExit = (command: string, stderr: string): VcsProcessExitFailureKind =>
{
  const normalized = stderr.toLowerCase()

  if (
    normalized.includes('api rate limit') ||
    normalized.includes('rate limit exceeded') ||
    normalized.includes('secondary rate limit') ||
    normalized.includes('too many requests') ||
    normalized.includes('http 429')
  )
  {
    return 'rate-limited'
  }

  if (
    normalized.includes('authentication failed') ||
    normalized.includes('not logged in') ||
    normalized.includes('gh auth login') ||
    normalized.includes('glab auth login') ||
    normalized.includes('az devops login') ||
    normalized.includes('please run az login') ||
    normalized.includes('no oauth token') ||
    normalized.includes('unauthorized')
  )
  {
    return 'authentication'
  }

  if (
    (command === 'gh' &&
      (normalized.includes('could not resolve to a pullrequest') ||
        normalized.includes('repository.pullrequest') ||
        normalized.includes('no pull requests found for branch') ||
        normalized.includes('pull request not found'))) ||
    (command === 'glab' &&
      (normalized.includes('merge request not found') ||
        normalized.includes('not found') ||
        normalized.includes('404'))) ||
    (command === 'az' &&
      normalized.includes('pull request') &&
      (normalized.includes('not found') || normalized.includes('does not exist')))
  )
  {
    return 'not-found'
  }

  return 'command-failed'
}

export const make = Effect.gen(function* ()
{
  const processRunner = yield* ProcessRunner.ProcessRunner

  const run = Effect.fn('VcsProcess.run')(function* (input: VcsProcessInput)
  {
    const baseError = {
      operation: input.operation,
      command: input.command,
      cwd: input.cwd,
      argumentCount: input.args.length,
    }

    const result = yield* processRunner
      .run({
        command: input.command,
        args: input.args,
        cwd: input.cwd,
        ...(input.spawnCwd !== undefined ? { spawnCwd: input.spawnCwd } : {}),
        ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
        ...(input.env !== undefined ? { env: input.env } : {}),
        timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxOutputBytes: input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
        outputMode: 'truncate',
        truncatedMarker: input.appendTruncationMarker ? OUTPUT_TRUNCATED_MARKER : '',
        timeoutBehavior: 'error',
      })
      .pipe(
        Effect.mapError(
          Match.valueTags({
            ProcessSpawnError: (error) => makeVcsProcessSpawnError(baseError, error),
            ProcessOutputLimitError: (error) =>
              new VcsProcessOutputLimitError({
                ...baseError,
                stream: error.stream,
                maxBytes: error.maxBytes,
                observedBytes: error.observedBytes,
              }),
            ProcessTimeoutError: (error) => makeVcsProcessTimeoutError(baseError, error),
            ProcessStdinError: (error) =>
              new VcsProcessStdinWriteError({
                ...baseError,
                stdinBytes: error.stdinBytes,
                cause: error.cause,
              }),
            ProcessReadError: (error) =>
              new VcsProcessOutputReadError({
                ...baseError,
                stream: error.stream,
                cause: error.cause,
              }),
          }),
        ),
      )

    if (result.code === null)
    {
      return yield* new VcsProcessMissingExitCodeError(baseError)
    }

    if (!input.allowNonZeroExit && result.code !== 0)
    {
      return yield* makeVcsProcessExitError(
        baseError,
        {
          exitCode: result.code,
          stderr: result.stderr,
          stderrTruncated: result.stderrTruncated,
        },
        classifyNonZeroExit(input.command, result.stderr),
      )
    }

    return {
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
    } satisfies VcsProcessOutput
  })

  return VcsProcess.of({ run })
})

export const layer = Layer.effect(VcsProcess, make).pipe(Layer.provide(ProcessRunner.layer))
