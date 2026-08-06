// packages/ssh/src/tunnelProcess.ts
// owns local SSH tunnel process spawn, readiness, and loopback URL checks

import type { DesktopSshEnvironmentTarget } from '@t3tools/contracts'
import {
  describeReadinessCause,
  waitForHttpReady as waitForHttpReadyShared,
} from '@t3tools/shared/httpReadiness'
import * as NetService from '@t3tools/shared/Net'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'
import { HttpClient } from 'effect/unstable/http'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'

import { buildSshChildEnvironment, type SshAuthOptions } from './auth.ts'
import {
  baseSshArgs,
  buildSshHostSpecEffect,
  collectProcessOutput,
  resolveSshCommand,
} from './command.ts'
import {
  SshCommandError,
  SshHttpBridgeError,
  SshInvalidTargetError,
  SshReadinessError,
} from './errors.ts'
import { SSH_READY_PROBE_TIMEOUT_MS } from './remoteScripts.ts'
import { readRemoteServerLogTail, sshTargetLogFields } from './remoteRuntime.ts'

export { describeReadinessCause }

export const SSH_READY_TIMEOUT_MS = 20_000
export const TUNNEL_SHUTDOWN_TIMEOUT_MS = 2_000

export interface SshTunnelEntry
{
  readonly key: string
  readonly target: DesktopSshEnvironmentTarget
  readonly remotePort: number
  readonly remoteServerKind: 'external' | 'managed' | null
  readonly localPort: number
  readonly httpBaseUrl: string
  readonly wsBaseUrl: string
  readonly process: ChildProcessSpawner.ChildProcessHandle
  readonly scope: Scope.Scope
}

export function normalizeSshErrorMessage(stderr: string, fallbackMessage: string): string
{
  const cleaned = stderr.trim()
  return cleaned.length > 0 ? cleaned : fallbackMessage
}

export const waitForHttpReady = (input: {
  readonly baseUrl: string
  readonly timeoutMs?: number
  readonly intervalMs?: number
  readonly probeTimeoutMs?: number
  readonly path?: string
}): Effect.Effect<void, SshReadinessError, HttpClient.HttpClient> =>
  waitForHttpReadyShared({
    baseUrl: input.baseUrl,
    ...(input.path === undefined ? {} : { path: input.path }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.intervalMs === undefined ? {} : { intervalMs: input.intervalMs }),
    probeTimeoutMs: input.probeTimeoutMs ?? SSH_READY_PROBE_TIMEOUT_MS,
    makeError: ({ requestUrl, probeTimeoutMs, cause }) =>
    {
      if (typeof cause === 'object' && cause !== null && 'kind' in cause)
      {
        const kind = (cause as { readonly kind?: unknown }).kind
        if (kind === 'probe-timeout')
        {
          return new SshReadinessError({
            message: `Backend readiness probe exceeded ${probeTimeoutMs}ms at ${requestUrl}.`,
            cause,
          })
        }
        if (kind === 'overall-timeout')
        {
          const overall = cause as unknown as {
            readonly baseUrl: string
            readonly timeoutMs: number
            readonly lastFailure: unknown
          }
          return new SshReadinessError({
            message: `Timed out waiting ${overall.timeoutMs}ms for backend readiness at ${overall.baseUrl}.`,
            cause: overall.lastFailure,
          })
        }
      }
      return new SshReadinessError({
        message: `Backend readiness probe failed at ${requestUrl}.`,
        cause,
      })
    },
  })

function isLoopbackHostname(hostname: string): boolean
{
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1')
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost'
}

export const resolveLoopbackSshHttpBaseUrl = Effect.fn('ssh/tunnel.resolveLoopbackSshHttpBaseUrl')(
  function* (rawHttpBaseUrl: unknown): Effect.fn.Return<string, SshHttpBridgeError>
  {
    return yield* Effect.try({
      try: () =>
      {
        if (typeof rawHttpBaseUrl !== 'string' || rawHttpBaseUrl.trim().length === 0)
        {
          throw new Error('Invalid SSH forwarded http base URL.')
        }
        const baseUrl = new URL(rawHttpBaseUrl)
        if (!isLoopbackHostname(baseUrl.hostname))
        {
          throw new Error('SSH desktop bridge only supports loopback forwarded URLs.')
        }
        return baseUrl.toString()
      },
      catch: (cause) =>
        new SshHttpBridgeError({
          message: cause instanceof Error ? cause.message : 'Invalid SSH forwarded http base URL.',
          cause,
        }),
    })
  },
)

export const reserveLocalTunnelPort = Effect.fn('ssh/tunnel.reserveLocalTunnelPort')(function* ()
{
  const net = yield* NetService.NetService
  return yield* net.reserveLoopbackPort()
})

export const startSshTunnel = Effect.fn('ssh/tunnel.startSshTunnel')(function* (input: {
  readonly key: string
  readonly resolvedTarget: DesktopSshEnvironmentTarget
  readonly remotePort: number
  readonly localPort: number
  readonly httpBaseUrl: string
  readonly wsBaseUrl: string
  readonly authOptions: SshAuthOptions
  readonly remoteServerKind: 'external' | 'managed' | null
}): Effect.fn.Return<
  SshTunnelEntry,
  SshCommandError | SshInvalidTargetError | SshReadinessError,
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | NetService.NetService
  | Scope.Scope
>
{
  const hostSpec = yield* buildSshHostSpecEffect(input.resolvedTarget)
  const childEnvironment = yield* buildSshChildEnvironment({
    ...(input.authOptions.authSecret === undefined
      ? {}
      : { authSecret: input.authOptions.authSecret }),
    ...(input.authOptions.interactiveAuth === undefined
      ? {}
      : { interactiveAuth: input.authOptions.interactiveAuth }),
  }).pipe(
    Effect.mapError(
      (cause) =>
        new SshCommandError({
          command: ['ssh'],
          exitCode: null,
          stderr: '',
          message: 'Failed to prepare SSH authentication helpers.',
          cause,
        }),
    ),
  )
  const args = [
    ...baseSshArgs(input.resolvedTarget, {
      batchMode: input.authOptions.batchMode ?? 'no',
    }),
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    '-n',
    '-N',
    '-L',
    `${input.localPort}:127.0.0.1:${input.remotePort}`,
    hostSpec,
  ]
  const sshCommand = yield* resolveSshCommand
  const tunnelCommand = [sshCommand, ...args]
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const scope = yield* Scope.Scope
  yield* Effect.logDebug('ssh.tunnel.spawn.start', {
    ...sshTargetLogFields(input.resolvedTarget),
    command: tunnelCommand,
    localPort: input.localPort,
    remotePort: input.remotePort,
    remoteServerKind: input.remoteServerKind,
    httpBaseUrl: input.httpBaseUrl,
  })
  const child = yield* spawner
    .spawn(
      ChildProcess.make(sshCommand, args, {
        env: childEnvironment,
        extendEnv: true,
        stdin: {
          stream: Stream.empty,
          endOnDone: true,
        },
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new SshCommandError({
            command: tunnelCommand,
            exitCode: null,
            stderr: '',
            message:
              cause instanceof Error
                ? cause.message
                : `Failed to spawn SSH tunnel for ${input.resolvedTarget.alias}.`,
            cause,
          }),
      ),
    )
  yield* Effect.logDebug('ssh.tunnel.spawn.succeeded', {
    ...sshTargetLogFields(input.resolvedTarget),
    command: tunnelCommand,
    pid: child.pid,
    localPort: input.localPort,
    remotePort: input.remotePort,
    httpBaseUrl: input.httpBaseUrl,
  })
  const tunnelEntry: SshTunnelEntry = {
    key: input.key,
    target: input.resolvedTarget,
    remotePort: input.remotePort,
    remoteServerKind: input.remoteServerKind,
    localPort: input.localPort,
    httpBaseUrl: input.httpBaseUrl,
    wsBaseUrl: input.wsBaseUrl,
    process: child,
    scope,
  }
  const exitFailure = Effect.all(
    [collectProcessOutput(child.stderr), child.exitCode.pipe(Effect.map(Number))],
    { concurrency: 'unbounded' },
  ).pipe(
    Effect.mapError(
      (cause) =>
        new SshCommandError({
          command: tunnelCommand,
          exitCode: null,
          stderr: '',
          message:
            cause instanceof Error
              ? cause.message
              : `Failed to monitor SSH tunnel for ${input.resolvedTarget.alias}.`,
          cause,
        }),
    ),
    Effect.flatMap(([stderr, exitCode]) =>
    {
      const error = new SshCommandError({
        command: tunnelCommand,
        exitCode,
        stderr,
        message: normalizeSshErrorMessage(
          stderr,
          `SSH tunnel exited unexpectedly for ${input.resolvedTarget.alias} (exit ${exitCode}).`,
        ),
      })
      return Effect.logWarning('ssh.tunnel.process.exited', {
        ...sshTargetLogFields(input.resolvedTarget),
        command: tunnelCommand,
        pid: child.pid,
        localPort: input.localPort,
        remotePort: input.remotePort,
        httpBaseUrl: input.httpBaseUrl,
        exitCode,
        stderr,
      }).pipe(Effect.andThen(Effect.fail(error)))
    }),
  )
  yield* Effect.raceFirst(
    waitForHttpReady({
      baseUrl: input.httpBaseUrl,
      timeoutMs: SSH_READY_TIMEOUT_MS,
    }),
    exitFailure,
  ).pipe(
    Effect.tap(() =>
      Effect.logInfo('ssh.tunnel.ready', {
        ...sshTargetLogFields(input.resolvedTarget),
        command: tunnelCommand,
        pid: child.pid,
        localPort: input.localPort,
        remotePort: input.remotePort,
        httpBaseUrl: input.httpBaseUrl,
      }),
    ),
    Effect.tapError((cause) =>
      Effect.gen(function* ()
      {
        const net = yield* NetService.NetService
        const processRunningExit = yield* Effect.exit(child.isRunning)
        const localPortAvailableExit = yield* Effect.exit(
          net.canListenOnHost(input.localPort, '127.0.0.1'),
        )
        const remoteLogTailExit = yield* Effect.exit(
          readRemoteServerLogTail(input.resolvedTarget, input.authOptions),
        )
        const processRunning = Exit.isSuccess(processRunningExit) ? processRunningExit.value : null
        const localPortAvailable = Exit.isSuccess(localPortAvailableExit)
          ? localPortAvailableExit.value
          : null
        const remoteLogTail = Exit.isSuccess(remoteLogTailExit)
          ? remoteLogTailExit.value || null
          : null
        yield* Effect.logWarning('ssh.tunnel.ready.failed', {
          ...sshTargetLogFields(input.resolvedTarget),
          command: tunnelCommand,
          pid: child.pid,
          processRunning,
          ...(Exit.isSuccess(processRunningExit)
            ? {}
            : { processRunningError: processRunningExit.cause }),
          localPort: input.localPort,
          localPortListening: localPortAvailable === null ? null : !localPortAvailable,
          remotePort: input.remotePort,
          httpBaseUrl: input.httpBaseUrl,
          ...(Exit.isSuccess(localPortAvailableExit)
            ? {}
            : { localPortProbeError: localPortAvailableExit.cause }),
          ...(remoteLogTail === null ? {} : { remoteLogTail }),
          ...(Exit.isSuccess(remoteLogTailExit)
            ? {}
            : { remoteLogTailError: remoteLogTailExit.cause }),
          cause,
        })
      }),
    ),
    Effect.onExit((exit) =>
      Exit.isSuccess(exit)
        ? Effect.void
        : child
            .kill({
              killSignal: 'SIGTERM',
              forceKillAfter: TUNNEL_SHUTDOWN_TIMEOUT_MS,
            })
            .pipe(Effect.ignore),
    ),
  )
  return tunnelEntry
})
