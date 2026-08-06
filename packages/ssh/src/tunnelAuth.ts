// packages/ssh/src/tunnelAuth.ts
// retries SSH operations with interactive password prompts

import type { DesktopSshEnvironmentTarget } from '@t3tools/contracts'
import * as NetService from '@t3tools/shared/Net'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import { HttpClient } from 'effect/unstable/http'
import { ChildProcessSpawner } from 'effect/unstable/process'

import { type SshAuthOptions, SshPasswordPrompt, isSshAuthFailure } from './auth.ts'
import { buildSshHostSpecEffect } from './command.ts'
import {
  SshCommandError,
  SshInvalidTargetError,
  SshLaunchError,
  SshPairingError,
  SshPasswordPromptError,
  SshReadinessError,
} from './errors.ts'
import { sshTargetLogFields } from './remoteRuntime.ts'

export type SshEnvironmentEffectContext =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | NetService.NetService
  | SshPasswordPrompt

export type SshEnvironmentEffectError =
  | SshCommandError
  | SshInvalidTargetError
  | SshLaunchError
  | SshPairingError
  | SshReadinessError
  | SshPasswordPromptError
  | NetService.NetError

export interface SshAuthOperationInput<T>
{
  readonly key: string
  readonly target: DesktopSshEnvironmentTarget
  readonly operation: (
    authOptions: SshAuthOptions,
  ) => Effect.Effect<T, SshEnvironmentEffectError, SshEnvironmentEffectContext>
}

export interface SshAuthAttemptInput<T> extends SshAuthOperationInput<T>
{
  readonly promptCount: number
  readonly authSecret: string | null
}

export interface SshAuthRunner
{
  readonly runWithSshAuth: <T>(
    input: SshAuthOperationInput<T>,
  ) => Effect.Effect<T, SshEnvironmentEffectError, SshEnvironmentEffectContext>
}

export const makeSshAuthRunner = (authSecrets: Map<string, string>): SshAuthRunner =>
{
  const promptForPassword = Effect.fn('ssh/tunnel.promptForPassword')(function* (
    target: DesktopSshEnvironmentTarget,
    attempt: number,
  ): Effect.fn.Return<string, SshInvalidTargetError | SshPasswordPromptError, SshPasswordPrompt>
  {
    const promptService = yield* SshPasswordPrompt
    const hostSpec = yield* buildSshHostSpecEffect(target)
    if (!promptService.isAvailable)
    {
      yield* Effect.logWarning('ssh.auth.passwordPrompt.unavailable', {
        ...sshTargetLogFields(target),
        attempt,
      })
      return yield* new SshPasswordPromptError({
        message: `SSH authentication failed for ${hostSpec}.`,
      })
    }

    yield* Effect.logInfo('ssh.auth.passwordPrompt.request', {
      ...sshTargetLogFields(target),
      attempt,
    })
    const password = yield* promptService.request({
      attempt,
      destination: target.alias.trim() || target.hostname.trim(),
      username: target.username,
      prompt: `Enter the SSH password for ${hostSpec}.`,
    })
    if (password === null)
    {
      yield* Effect.logWarning('ssh.auth.passwordPrompt.cancelled', {
        ...sshTargetLogFields(target),
        attempt,
      })
      return yield* new SshPasswordPromptError({
        message: `SSH authentication cancelled for ${hostSpec}.`,
      })
    }
    yield* Effect.logInfo('ssh.auth.passwordPrompt.received', {
      ...sshTargetLogFields(target),
      attempt,
    })
    return password
  })

  const handleSshAuthFailure = Effect.fn('ssh/tunnel.runWithSshAuthAttempt.handleFailure')(
    function* <T>(
      input: SshAuthAttemptInput<T> & {
        readonly error: SshEnvironmentEffectError
      },
    ): Effect.fn.Return<T, SshEnvironmentEffectError, SshEnvironmentEffectContext>
    {
      if (!isSshAuthFailure(input.error))
      {
        return yield* input.error
      }

      yield* Effect.logWarning('ssh.auth.failed', {
        ...sshTargetLogFields(input.target),
        key: input.key,
        promptCount: input.promptCount,
        cause: input.error,
      })
      const promptService = yield* SshPasswordPrompt
      if (!promptService.isAvailable)
      {
        return yield* input.error
      }
      if (input.authSecret !== null)
      {
        authSecrets.delete(input.key)
      }
      if (input.promptCount >= 2)
      {
        return yield* input.error
      }

      const nextPromptCount = input.promptCount + 1
      const nextAuthSecret = yield* promptForPassword(input.target, nextPromptCount)
      authSecrets.set(input.key, nextAuthSecret)
      return yield* runWithSshAuthAttempt({
        ...input,
        promptCount: nextPromptCount,
        authSecret: nextAuthSecret,
      })
    },
  )

  const runWithSshAuthAttempt = Effect.fn('ssh/tunnel.runWithSshAuthAttempt')(function* <T>(
    input: SshAuthAttemptInput<T>,
  ): Effect.fn.Return<T, SshEnvironmentEffectError, SshEnvironmentEffectContext>
  {
    const promptService = yield* SshPasswordPrompt
    const authOptions =
      input.authSecret === null
        ? {
            batchMode: promptService.isAvailable ? ('yes' as const) : ('no' as const),
            interactiveAuth: !promptService.isAvailable,
          }
        : {
            authSecret: input.authSecret,
            batchMode: 'no' as const,
            interactiveAuth: true,
          }

    return yield* input
      .operation(authOptions)
      .pipe(Effect.catch((error) => handleSshAuthFailure({ ...input, error })))
  })

  const runWithSshAuth = Effect.fn('ssh/tunnel.runWithSshAuth')(function* <T>(
    input: SshAuthOperationInput<T>,
  ): Effect.fn.Return<T, SshEnvironmentEffectError, SshEnvironmentEffectContext>
  {
    return yield* runWithSshAuthAttempt({
      ...input,
      promptCount: 0,
      authSecret: authSecrets.get(input.key) ?? null,
    })
  })

  return { runWithSshAuth }
}
