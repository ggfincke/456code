// packages/ssh/src/tunnel.ts
// owns remote runtime leases and local ssh tunnel lifecycles

import type {
  DesktopSshEnvironmentBootstrap,
  DesktopSshEnvironmentTarget,
} from '@t3tools/contracts'
import * as Context from 'effect/Context'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as FileSystem from 'effect/FileSystem'
import * as FiberMap from 'effect/FiberMap'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import * as Scope from 'effect/Scope'
import { ChildProcessSpawner } from 'effect/unstable/process'

import { resolveSshTarget, targetConnectionKey } from './command.ts'
import { SshCommandError } from './errors.ts'
import type { RemoteT3RunnerOptions } from './remoteScripts.ts'
import {
  issueRemotePairingToken,
  launchOrReuseRemoteServer,
  resolvedRemoteRuntimeKey,
  sshRunnerLogFields,
  sshTargetLogFields,
  stopRemoteServer,
} from './remoteRuntime.ts'
import {
  makeSshAuthRunner,
  type SshEnvironmentEffectContext,
  type SshEnvironmentEffectError,
} from './tunnelAuth.ts'
import {
  reserveLocalTunnelPort,
  startSshTunnel,
  type SshTunnelEntry,
  TUNNEL_SHUTDOWN_TIMEOUT_MS,
  waitForHttpReady,
} from './tunnelProcess.ts'

export {
  buildRemoteLaunchScript,
  buildRemoteNodeEnvScript,
  buildRemotePairingScript,
  buildRemoteStopScript,
  buildRemoteT3RunnerScript,
  DEFAULT_REMOTE_PORT,
  REMOTE_LAUNCH_SCRIPT,
  REMOTE_NODE_ENV_SCRIPT,
  REMOTE_PAIRING_SCRIPT,
  REMOTE_PICK_PORT_SCRIPT,
  REMOTE_RUNNER_SCRIPT,
  REMOTE_STOP_SCRIPT,
  REMOTE_WAIT_READY_SCRIPT,
  type RemoteT3RunnerOptions,
} from './remoteScripts.ts'

export {
  issueRemotePairingToken,
  launchOrReuseRemoteServer,
  stopRemoteServer,
} from './remoteRuntime.ts'

export {
  describeReadinessCause,
  normalizeSshErrorMessage,
  resolveLoopbackSshHttpBaseUrl,
  waitForHttpReady,
} from './tunnelProcess.ts'

export interface SshEnvironmentManagerOptions
{
  readonly resolveCliPackageSpec?: () => string
  readonly resolveCliRunner?: Effect.Effect<RemoteT3RunnerOptions>
}

interface RemoteRuntimeLease
{
  readonly ownerTarget: DesktopSshEnvironmentTarget | null
  readonly ownerTunnelKey: string | null
  readonly tunnelKeys: Set<string>
}

interface RemoteRuntimeLaunch
{
  readonly remotePort: number
  readonly remoteServerKind: 'external' | 'managed' | null
}

interface PendingRemoteRuntimeLaunch
{
  readonly deferred: Deferred.Deferred<RemoteRuntimeLaunch, SshEnvironmentEffectError>
  readonly ownerTunnelKey: string
}

function makeSshTunnelCancelledError(target: DesktopSshEnvironmentTarget): SshCommandError
{
  return new SshCommandError({
    command: ['ssh'],
    exitCode: null,
    stderr: '',
    message: `SSH environment connection was cancelled for ${target.alias || target.hostname}.`,
  })
}

export interface SshEnvironmentManagerShape
{
  readonly ensureEnvironment: (
    target: DesktopSshEnvironmentTarget,
    options?: { readonly issuePairingToken?: boolean },
  ) => Effect.Effect<
    DesktopSshEnvironmentBootstrap,
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext
  >
  readonly disconnectEnvironment: (
    target: DesktopSshEnvironmentTarget,
  ) => Effect.Effect<void, SshEnvironmentEffectError, SshEnvironmentEffectContext>
}

const makeSshEnvironmentManager = Effect.fn('ssh/tunnel.SshEnvironmentManager.make')(function* (
  options: SshEnvironmentManagerOptions = {},
): Effect.fn.Return<SshEnvironmentManagerShape, never, Scope.Scope>
{
  const managerScope = yield* Scope.Scope
  const tunnels = new Map<string, SshTunnelEntry>()
  const remoteRuntimeLeases = new Map<string, RemoteRuntimeLease>()
  const pendingRemoteRuntimeLaunches = new Map<string, PendingRemoteRuntimeLaunch>()
  const pendingTunnelEntries = new Map<
    string,
    Deferred.Deferred<SshTunnelEntry, SshEnvironmentEffectError>
  >()
  const pendingTunnelCreators = yield* FiberMap.make<
    string,
    SshTunnelEntry,
    SshEnvironmentEffectError
  >()
  const cancellingTunnelKeys = new Set<string>()
  const activeDisconnects = new Map<string, Deferred.Deferred<void, SshEnvironmentEffectError>>()
  const authSecrets = new Map<string, string>()

  const closeTunnelEntry = Effect.fn('ssh/tunnel.closeTunnelEntry')(function* (
    entry: SshTunnelEntry,
  )
  {
    yield* Effect.logDebug('ssh.tunnel.close.start', {
      ...sshTargetLogFields(entry.target),
      key: entry.key,
      localPort: entry.localPort,
      remotePort: entry.remotePort,
    })
    yield* Scope.close(entry.scope, Exit.void).pipe(Effect.ignore)
    yield* Effect.logInfo('ssh.tunnel.close.succeeded', {
      ...sshTargetLogFields(entry.target),
      key: entry.key,
      localPort: entry.localPort,
      remotePort: entry.remotePort,
    })
  })

  const cancelPendingTunnelEntry = Effect.fn('ssh/tunnel.cancelPendingTunnelEntry')(function* (
    key: string,
    target: DesktopSshEnvironmentTarget,
  )
  {
    const pending = pendingTunnelEntries.get(key)
    if (!pending)
    {
      return
    }
    cancellingTunnelKeys.add(key)
    const runtimeKey = resolvedRemoteRuntimeKey(target)
    const pendingLaunch = pendingRemoteRuntimeLaunches.get(runtimeKey)
    const lease = remoteRuntimeLeases.get(runtimeKey)
    if (pendingLaunch?.ownerTunnelKey === key && lease !== undefined && lease.tunnelKeys.size > 1)
    {
      yield* Effect.exit(Deferred.await(pendingLaunch.deferred))
    }
    yield* FiberMap.remove(pendingTunnelCreators, key)
    pendingTunnelEntries.delete(key)
    cancellingTunnelKeys.delete(key)
    yield* Deferred.fail(pending, makeSshTunnelCancelledError(target)).pipe(Effect.ignore)
  })

  const releaseRemoteRuntimeLease = Effect.fn('ssh/tunnel.releaseRemoteRuntimeLease')(function* (
    runtimeKey: string,
    tunnelKey: string,
  )
  {
    const lease = remoteRuntimeLeases.get(runtimeKey)
    if (!lease || !lease.tunnelKeys.delete(tunnelKey) || lease.tunnelKeys.size > 0)
    {
      return
    }
    remoteRuntimeLeases.delete(runtimeKey)
    if (lease.ownerTarget === null || lease.ownerTunnelKey === null)
    {
      return
    }
    const authSecret = authSecrets.get(lease.ownerTunnelKey) ?? null
    yield* stopRemoteServer(
      lease.ownerTarget,
      authSecret === null
        ? {
            batchMode: 'yes',
            interactiveAuth: false,
          }
        : {
            authSecret,
            batchMode: 'no',
            interactiveAuth: true,
          },
    ).pipe(Effect.ignore)
  })

  yield* Scope.addFinalizer(
    managerScope,
    FiberMap.clear(pendingTunnelCreators).pipe(
      Effect.andThen(
        Effect.sync(() => [...tunnels.values()]).pipe(
          Effect.flatMap((entries) =>
            Effect.forEach(entries, closeTunnelEntry, { concurrency: 'unbounded' }),
          ),
        ),
      ),
      Effect.ignore,
    ),
  )

  const { runWithSshAuth } = makeSshAuthRunner(authSecrets)

  const launchSharedRemoteRuntime = Effect.fn('ssh/tunnel.launchSharedRemoteRuntime')(
    function* (input: {
      readonly runtimeKey: string
      readonly tunnelKey: string
      readonly target: DesktopSshEnvironmentTarget
      readonly runner?: RemoteT3RunnerOptions
    }): Effect.fn.Return<
      RemoteRuntimeLaunch,
      SshEnvironmentEffectError,
      SshEnvironmentEffectContext
    >
    {
      const pending = pendingRemoteRuntimeLaunches.get(input.runtimeKey)
      if (pending)
      {
        return yield* Deferred.await(pending.deferred)
      }

      const deferred = Deferred.makeUnsafe<RemoteRuntimeLaunch, SshEnvironmentEffectError>()
      const pendingLaunch = { deferred, ownerTunnelKey: input.tunnelKey }
      pendingRemoteRuntimeLaunches.set(input.runtimeKey, pendingLaunch)
      return yield* runWithSshAuth({
        key: input.tunnelKey,
        target: input.target,
        operation: (authOptions) =>
          launchOrReuseRemoteServer(input.target, authOptions, input.runner),
      }).pipe(
        Effect.onExit((exit) =>
          Effect.suspend(() =>
          {
            if (pendingRemoteRuntimeLaunches.get(input.runtimeKey) !== pendingLaunch)
            {
              return Effect.void
            }
            pendingRemoteRuntimeLaunches.delete(input.runtimeKey)
            if (Exit.isSuccess(exit) && exit.value.remoteServerKind === 'managed')
            {
              const lease = remoteRuntimeLeases.get(input.runtimeKey)
              if (lease && lease.ownerTarget === null)
              {
                remoteRuntimeLeases.set(input.runtimeKey, {
                  ownerTarget: input.target,
                  ownerTunnelKey: input.tunnelKey,
                  tunnelKeys: lease.tunnelKeys,
                })
              }
            }
            return Deferred.done(deferred, exit)
          }),
        ),
      )
    },
  )

  const createTunnelEntry = Effect.fn('ssh/tunnel.ensureTunnelEntry.create')(function* (input: {
    readonly key: string
    readonly resolvedTarget: DesktopSshEnvironmentTarget
    readonly runner?: RemoteT3RunnerOptions
  }): Effect.fn.Return<SshTunnelEntry, SshEnvironmentEffectError, SshEnvironmentEffectContext>
  {
    const entryScope = yield* Scope.make('sequential')
    return yield* Effect.gen(function* ()
    {
      yield* Effect.logDebug('ssh.environment.tunnel.create.start', {
        ...sshTargetLogFields(input.resolvedTarget),
        ...sshRunnerLogFields(input.runner),
        key: input.key,
      })
      const runtimeKey = resolvedRemoteRuntimeKey(input.resolvedTarget)
      const spawnerService = yield* ChildProcessSpawner.ChildProcessSpawner
      const fileSystemService = yield* FileSystem.FileSystem
      const pathService = yield* Path.Path
      yield* Scope.addFinalizer(
        entryScope,
        releaseRemoteRuntimeLease(runtimeKey, input.key).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawnerService),
          Effect.provideService(FileSystem.FileSystem, fileSystemService),
          Effect.provideService(Path.Path, pathService),
        ),
      )
      const existingLease = remoteRuntimeLeases.get(runtimeKey)
      if (existingLease)
      {
        existingLease.tunnelKeys.add(input.key)
      }
      else
      {
        remoteRuntimeLeases.set(runtimeKey, {
          ownerTarget: null,
          ownerTunnelKey: null,
          tunnelKeys: new Set([input.key]),
        })
      }
      const remoteLaunch = yield* launchSharedRemoteRuntime({
        runtimeKey,
        tunnelKey: input.key,
        target: input.resolvedTarget,
        ...(input.runner === undefined ? {} : { runner: input.runner }),
      })
      const remotePort = remoteLaunch.remotePort
      yield* Effect.logDebug('ssh.environment.remotePort.ready', {
        ...sshTargetLogFields(input.resolvedTarget),
        key: input.key,
        remotePort,
        remoteServerKind: remoteLaunch.remoteServerKind,
      })
      const localPort = yield* reserveLocalTunnelPort()
      const httpBaseUrl = `http://127.0.0.1:${localPort}/`
      const wsBaseUrl = `ws://127.0.0.1:${localPort}/`
      yield* Effect.logDebug('ssh.environment.localPort.reserved', {
        ...sshTargetLogFields(input.resolvedTarget),
        key: input.key,
        localPort,
        remotePort,
      })
      const tunnelEntry = yield* runWithSshAuth({
        key: input.key,
        target: input.resolvedTarget,
        operation: (authOptions) =>
          startSshTunnel({
            key: input.key,
            resolvedTarget: input.resolvedTarget,
            remotePort,
            localPort,
            httpBaseUrl,
            wsBaseUrl,
            authOptions,
            remoteServerKind: remoteLaunch.remoteServerKind,
          }).pipe(Effect.provideService(Scope.Scope, entryScope)),
      })
      tunnels.set(input.key, tunnelEntry)
      yield* Scope.addFinalizer(
        entryScope,
        Effect.gen(function* ()
        {
          if (tunnels.get(tunnelEntry.key) !== tunnelEntry)
          {
            return
          }
          yield* Effect.logDebug('ssh.environment.tunnel.finalizer.start', {
            ...sshTargetLogFields(tunnelEntry.target),
            key: tunnelEntry.key,
            localPort: tunnelEntry.localPort,
            remotePort: tunnelEntry.remotePort,
          })
          tunnels.delete(tunnelEntry.key)
          yield* tunnelEntry.process
            .kill({
              killSignal: 'SIGTERM',
              forceKillAfter: TUNNEL_SHUTDOWN_TIMEOUT_MS,
            })
            .pipe(Effect.ignore)
          yield* Effect.logDebug('ssh.environment.tunnel.finalizer.succeeded', {
            ...sshTargetLogFields(tunnelEntry.target),
            key: tunnelEntry.key,
            localPort: tunnelEntry.localPort,
            remotePort: tunnelEntry.remotePort,
          })
        }).pipe(Effect.ignore),
      )
      yield* Effect.logDebug('ssh.environment.tunnel.create.succeeded', {
        ...sshTargetLogFields(input.resolvedTarget),
        key: input.key,
        localPort,
        remotePort,
      })
      return tunnelEntry
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit) ? Effect.void : Scope.close(entryScope, exit).pipe(Effect.ignore),
      ),
    )
  })

  const ensureTunnelEntry = Effect.fn('ssh/tunnel.ensureTunnelEntry')(function* (
    key: string,
    resolvedTarget: DesktopSshEnvironmentTarget,
    runner?: RemoteT3RunnerOptions,
  ): Effect.fn.Return<SshTunnelEntry, SshEnvironmentEffectError, SshEnvironmentEffectContext>
  {
    let entry = tunnels.get(key) ?? null

    if (entry !== null)
    {
      yield* Effect.logDebug('ssh.environment.tunnel.existing.check', {
        ...sshTargetLogFields(resolvedTarget),
        key,
        localPort: entry.localPort,
        remotePort: entry.remotePort,
      })
      const readinessExit = yield* Effect.exit(
        waitForHttpReady({ baseUrl: entry.httpBaseUrl, timeoutMs: 2_000 }),
      )
      if (Exit.isSuccess(readinessExit))
      {
        if (tunnels.get(key) === entry && !activeDisconnects.has(key))
        {
          yield* Effect.logDebug('ssh.environment.tunnel.reused', {
            ...sshTargetLogFields(resolvedTarget),
            key,
            localPort: entry.localPort,
            remotePort: entry.remotePort,
          })
          if (tunnels.get(key) !== entry || activeDisconnects.has(key))
          {
            return yield* makeSshTunnelCancelledError(resolvedTarget)
          }
          return entry
        }
        return yield* makeSshTunnelCancelledError(resolvedTarget)
      }
      yield* Effect.logWarning('ssh.environment.tunnel.existing.stale', {
        ...sshTargetLogFields(resolvedTarget),
        key,
        localPort: entry.localPort,
        remotePort: entry.remotePort,
        cause: readinessExit.cause,
      })
      yield* closeTunnelEntry(entry)
      yield* cancelPendingTunnelEntry(key, resolvedTarget)
      entry = null
    }

    const pending = pendingTunnelEntries.get(key)
    if (pending)
    {
      yield* Effect.logDebug('ssh.environment.tunnel.pending.await', {
        ...sshTargetLogFields(resolvedTarget),
        key,
      })
      return yield* Deferred.await(pending)
    }

    const deferred = Deferred.makeUnsafe<SshTunnelEntry, SshEnvironmentEffectError>()
    pendingTunnelEntries.set(key, deferred)

    const creator = createTunnelEntry({
      key,
      resolvedTarget,
      ...(runner === undefined ? {} : { runner }),
    }).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning('ssh.environment.tunnel.create.failed', {
          ...sshTargetLogFields(resolvedTarget),
          key,
          cause,
        }),
      ),
      Effect.onExit((exit) =>
        Effect.suspend(() =>
        {
          if (cancellingTunnelKeys.has(key))
          {
            return Exit.isSuccess(exit) ? closeTunnelEntry(exit.value) : Effect.void
          }
          if (pendingTunnelEntries.get(key) !== deferred)
          {
            return Effect.void
          }
          pendingTunnelEntries.delete(key)
          return Deferred.done(deferred, exit)
        }),
      ),
    )
    yield* FiberMap.run(pendingTunnelCreators, key, creator)
    return yield* Deferred.await(deferred)
  })

  const ensureEnvironment = Effect.fn('ssh/tunnel.ensureEnvironment')(function* (
    target: DesktopSshEnvironmentTarget,
    requestOptions?: { readonly issuePairingToken?: boolean },
  ): Effect.fn.Return<
    DesktopSshEnvironmentBootstrap,
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext
  >
  {
    yield* Effect.logInfo('ssh.environment.ensure.start', {
      ...sshTargetLogFields(target),
      issuePairingToken: requestOptions?.issuePairingToken === true,
    })
    const baseResolved = yield* resolveSshTarget(target.alias || target.hostname)
    const resolvedTarget: DesktopSshEnvironmentTarget = {
      ...baseResolved,
      ...(target.username !== null ? { username: target.username } : {}),
      ...(target.port !== null ? { port: target.port } : {}),
    }
    const key = targetConnectionKey(resolvedTarget)
    yield* Effect.logDebug('ssh.environment.target.resolved', {
      ...sshTargetLogFields(resolvedTarget),
      key,
    })
    const packageSpec = options.resolveCliPackageSpec?.()
    const runner =
      options.resolveCliRunner === undefined
        ? packageSpec === undefined
          ? undefined
          : { packageSpec }
        : yield* options.resolveCliRunner
    yield* Effect.logDebug('ssh.environment.runner.resolved', {
      ...sshTargetLogFields(resolvedTarget),
      ...sshRunnerLogFields(runner),
      key,
    })
    const activeDisconnect = activeDisconnects.get(key)
    if (activeDisconnect)
    {
      yield* Deferred.await(activeDisconnect)
    }
    const entry = yield* ensureTunnelEntry(key, resolvedTarget, runner)

    const pairingResult = requestOptions?.issuePairingToken
      ? yield* runWithSshAuth({
          key,
          target: entry.target,
          operation: (authOptions) => issueRemotePairingToken(entry.target, authOptions, runner),
        })
      : null
    const pairingToken = pairingResult?.credential ?? null

    yield* Effect.logInfo('ssh.environment.ensure.succeeded', {
      ...sshTargetLogFields(entry.target),
      key,
      localPort: entry.localPort,
      remotePort: entry.remotePort,
      remoteServerKind: entry.remoteServerKind,
      issuedPairingToken: pairingToken !== null,
    })
    if (tunnels.get(key) !== entry || activeDisconnects.has(key))
    {
      return yield* makeSshTunnelCancelledError(resolvedTarget)
    }
    return {
      target: entry.target,
      httpBaseUrl: entry.httpBaseUrl,
      wsBaseUrl: entry.wsBaseUrl,
      pairingToken,
      remotePort: entry.remotePort,
      ...(entry.remoteServerKind ? { remoteServerKind: entry.remoteServerKind } : {}),
    }
  })

  const disconnectEnvironment = Effect.fn('ssh/tunnel.disconnectEnvironment')(function* (
    target: DesktopSshEnvironmentTarget,
  ): Effect.fn.Return<void, SshEnvironmentEffectError, SshEnvironmentEffectContext>
  {
    yield* Effect.logInfo('ssh.environment.disconnect.start', sshTargetLogFields(target))
    const baseResolved = yield* resolveSshTarget(target.alias || target.hostname)
    const resolvedTarget: DesktopSshEnvironmentTarget = {
      ...baseResolved,
      ...(target.username !== null ? { username: target.username } : {}),
      ...(target.port !== null ? { port: target.port } : {}),
    }
    const key = targetConnectionKey(resolvedTarget)
    const existingDisconnect = activeDisconnects.get(key)
    if (existingDisconnect)
    {
      return yield* Deferred.await(existingDisconnect)
    }
    const disconnect = Deferred.makeUnsafe<void, SshEnvironmentEffectError>()
    activeDisconnects.set(key, disconnect)
    return yield* Effect.gen(function* ()
    {
      const entry = tunnels.get(key) ?? null
      const hadPendingTunnel = pendingTunnelEntries.has(key)
      yield* Effect.logDebug('ssh.environment.disconnect.targetResolved', {
        ...sshTargetLogFields(resolvedTarget),
        key,
        hasTunnel: entry !== null,
        hasPendingTunnel: hadPendingTunnel,
      })
      if (entry !== null)
      {
        yield* closeTunnelEntry(entry)
      }
      yield* cancelPendingTunnelEntry(key, resolvedTarget)
      if (entry === null && !hadPendingTunnel)
      {
        yield* runWithSshAuth({
          key,
          target: resolvedTarget,
          operation: (authOptions) => stopRemoteServer(resolvedTarget, authOptions),
        })
      }
      yield* Effect.logInfo('ssh.environment.disconnect.succeeded', {
        ...sshTargetLogFields(resolvedTarget),
        key,
      })
    }).pipe(
      Effect.onExit((exit) =>
        Effect.sync(() =>
        {
          if (activeDisconnects.get(key) === disconnect)
          {
            activeDisconnects.delete(key)
          }
          Deferred.doneUnsafe(disconnect, exit)
        }),
      ),
    )
  })

  return SshEnvironmentManager.of({ ensureEnvironment, disconnectEnvironment })
})

/**
 * Manages remote runtimes and local SSH tunnels for environment connections.
 *
 * @effect-expect-leaking ChildProcessSpawner | FileSystem | HttpClient | NetService | Path | SshPasswordPrompt
 */
export class SshEnvironmentManager extends Context.Service<
  SshEnvironmentManager,
  SshEnvironmentManagerShape
>()('@t3tools/ssh/tunnel/SshEnvironmentManager')
{
  static readonly layer = (options: SshEnvironmentManagerOptions = {}) =>
    Layer.effect(SshEnvironmentManager, makeSshEnvironmentManager(options))
}
