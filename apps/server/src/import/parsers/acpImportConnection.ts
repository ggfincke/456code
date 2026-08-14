// apps/server/src/import/parsers/acpImportConnection.ts
// spawns and authenticates ACP import agent connections

// @effect-diagnostics nodeBuiltinImport:off globalDate:off

import * as NodeBuffer from 'node:buffer'

import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'
import * as ChildProcess from 'effect/unstable/process/ChildProcess'
import * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner'
import * as EffectAcpClient from 'effect-acp/client'
import type * as EffectAcpErrors from 'effect-acp/errors'
import type * as EffectAcpSchema from 'effect-acp/schema'
import { resolveSpawnCommand } from '@t3tools/shared/shell'

import { buildCursorAcpSpawnInput } from '../../provider/acp/CursorAcpSupport.ts'
import { buildGrokAcpSpawnInput } from '../../provider/acp/GrokAcpSupport.ts'
import {
  ACP_IMPORT_DEFAULT_CATALOG_MAX_BYTES,
  ACP_IMPORT_DEFAULT_NORMALIZED_CONNECTION_MAX_BYTES,
  ACP_IMPORT_DEFAULT_REPLAY_CONNECTION_MAX_BYTES,
  ACP_IMPORT_DEFAULT_REPLAY_SESSION_MAX_BYTES,
  IMPORT_NORMALIZED_SESSION_MAX_BYTES,
} from '../discovery/resourceLimits.ts'
import { boundedToolDisplayText, replayFailureMessageMaxBytes } from './acpImportRedact.ts'
import {
  AcpImportError,
  type AcpImportConnectionOptions,
  type AcpImportDriverKind,
  type AcpImportPolicy,
  type AcpImportSource,
  type AcpImportedSession,
  type AcpReplayRouter,
  type ConnectedAcpImportClient,
  type ReplayCapture,
  type ReplayCaptureSnapshot,
} from './acpImportTypes.ts'

const defaultAcpImportPolicy: AcpImportPolicy = {
  initializeTimeoutMs: 15_000,
  authenticateTimeoutMs: 15_000,
  listPageTimeoutMs: 15_000,
  loadTimeoutMs: 90_000,
  shutdownGraceMs: 1_000,
  postResponseReplayGraceMs: 100,
  hangingReplayIdleMs: 2_000,
  maxPages: 1_000,
  maxSessions: 10_000,
  maxCatalogBytes: ACP_IMPORT_DEFAULT_CATALOG_MAX_BYTES,
  maxReplayNotificationsPerSession: 100_000,
  maxReplayBytesPerSession: ACP_IMPORT_DEFAULT_REPLAY_SESSION_MAX_BYTES,
  maxReplayNotificationsPerConnection: 250_000,
  maxReplayBytesPerConnection: ACP_IMPORT_DEFAULT_REPLAY_CONNECTION_MAX_BYTES,
  maxNormalizedBytesPerConnection: ACP_IMPORT_DEFAULT_NORMALIZED_CONNECTION_MAX_BYTES,
  batchLoadTimeoutMs: 5 * 60_000,
}

export function positivePolicyValue(
  value: number | undefined,
  fallback: number,
  integer: boolean,
): number
{
  if (value === undefined || !Number.isFinite(value) || value <= 0)
  {
    return fallback
  }
  return integer ? Math.max(1, Math.floor(value)) : value
}

export function checkedByteSum(left: number, right: number): number
{
  return Math.min(Number.MAX_SAFE_INTEGER, left + right)
}

export function resolveAcpImportPolicy(overrides?: Partial<AcpImportPolicy>): AcpImportPolicy
{
  const maxCatalogBytes = positivePolicyValue(
    overrides?.maxCatalogBytes,
    defaultAcpImportPolicy.maxCatalogBytes,
    true,
  )
  const maxReplayBytesPerConnection = positivePolicyValue(
    overrides?.maxReplayBytesPerConnection,
    defaultAcpImportPolicy.maxReplayBytesPerConnection,
    true,
  )
  return {
    initializeTimeoutMs: positivePolicyValue(
      overrides?.initializeTimeoutMs,
      defaultAcpImportPolicy.initializeTimeoutMs,
      false,
    ),
    authenticateTimeoutMs: positivePolicyValue(
      overrides?.authenticateTimeoutMs,
      defaultAcpImportPolicy.authenticateTimeoutMs,
      false,
    ),
    listPageTimeoutMs: positivePolicyValue(
      overrides?.listPageTimeoutMs,
      defaultAcpImportPolicy.listPageTimeoutMs,
      false,
    ),
    loadTimeoutMs: positivePolicyValue(
      overrides?.loadTimeoutMs,
      defaultAcpImportPolicy.loadTimeoutMs,
      false,
    ),
    shutdownGraceMs: positivePolicyValue(
      overrides?.shutdownGraceMs,
      defaultAcpImportPolicy.shutdownGraceMs,
      false,
    ),
    postResponseReplayGraceMs: positivePolicyValue(
      overrides?.postResponseReplayGraceMs,
      defaultAcpImportPolicy.postResponseReplayGraceMs,
      false,
    ),
    hangingReplayIdleMs: positivePolicyValue(
      overrides?.hangingReplayIdleMs,
      defaultAcpImportPolicy.hangingReplayIdleMs,
      false,
    ),
    maxPages: positivePolicyValue(overrides?.maxPages, defaultAcpImportPolicy.maxPages, true),
    maxSessions: positivePolicyValue(
      overrides?.maxSessions,
      defaultAcpImportPolicy.maxSessions,
      true,
    ),
    maxCatalogBytes,
    maxReplayNotificationsPerSession: positivePolicyValue(
      overrides?.maxReplayNotificationsPerSession,
      defaultAcpImportPolicy.maxReplayNotificationsPerSession,
      true,
    ),
    maxReplayBytesPerSession: positivePolicyValue(
      overrides?.maxReplayBytesPerSession,
      defaultAcpImportPolicy.maxReplayBytesPerSession,
      true,
    ),
    maxReplayNotificationsPerConnection: positivePolicyValue(
      overrides?.maxReplayNotificationsPerConnection,
      defaultAcpImportPolicy.maxReplayNotificationsPerConnection,
      true,
    ),
    maxReplayBytesPerConnection,
    maxNormalizedBytesPerConnection: positivePolicyValue(
      overrides?.maxNormalizedBytesPerConnection,
      defaultAcpImportPolicy.maxNormalizedBytesPerConnection,
      true,
    ),
    batchLoadTimeoutMs: positivePolicyValue(
      overrides?.batchLoadTimeoutMs,
      defaultAcpImportPolicy.batchLoadTimeoutMs,
      false,
    ),
  }
}

export function jsonByteLength(value: unknown): number
{
  return NodeBuffer.Buffer.byteLength(JSON.stringify(value), 'utf8')
}

export function retainNormalizedSession(
  policy: AcpImportPolicy,
  budget: { consumedBytes: number },
  session: AcpImportedSession,
): AcpImportedSession
{
  const sessionBytes = jsonByteLength(session)
  if (sessionBytes > IMPORT_NORMALIZED_SESSION_MAX_BYTES)
  {
    throw new AcpImportError(
      'limit-exceeded',
      `ACP normalized session exceeded the configured ${IMPORT_NORMALIZED_SESSION_MAX_BYTES}-byte per-session limit.`,
    )
  }
  if (sessionBytes > policy.maxNormalizedBytesPerConnection - budget.consumedBytes)
  {
    throw new AcpImportError(
      'limit-exceeded',
      `ACP normalized session results exceeded the configured ${policy.maxNormalizedBytesPerConnection}-byte connection limit.`,
    )
  }
  budget.consumedBytes += sessionBytes
  return session
}

export function makeReplayRouter(policy: AcpImportPolicy): AcpReplayRouter
{
  let activeCapture: ReplayCapture | undefined
  let connectionNotificationCount = 0
  let connectionByteCount = 0
  let connectionLimitError: AcpImportError | undefined

  const begin = (sessionId: string): ReplayCapture =>
  {
    if (activeCapture !== undefined)
    {
      throw new AcpImportError(
        'load-failed',
        'ACP replay import does not support concurrent session/load calls on one connection.',
      )
    }
    if (connectionLimitError !== undefined)
    {
      throw connectionLimitError
    }
    const capture: ReplayCapture = {
      sessionId,
      notifications: [],
      notificationCount: 0,
      byteCount: 0,
      foreignNotificationCount: 0,
      lastMatchingActivityAtMs: undefined,
      limitError: undefined,
    }
    activeCapture = capture
    return capture
  }

  const route = (notification: EffectAcpSchema.SessionNotification, nowMs: number): void =>
  {
    const capture = activeCapture
    if (capture === undefined)
    {
      return
    }

    const notificationBytes = jsonByteLength(notification)
    capture.notificationCount += 1
    capture.byteCount += notificationBytes
    connectionNotificationCount += 1
    connectionByteCount += notificationBytes

    if (
      connectionNotificationCount > policy.maxReplayNotificationsPerConnection ||
      connectionByteCount > policy.maxReplayBytesPerConnection
    )
    {
      connectionLimitError ??= new AcpImportError(
        'limit-exceeded',
        'ACP replay exceeded the notification or byte limit for this connection.',
      )
      capture.limitError = connectionLimitError
      return
    }
    if (
      capture.notificationCount > policy.maxReplayNotificationsPerSession ||
      capture.byteCount > policy.maxReplayBytesPerSession
    )
    {
      capture.limitError ??= new AcpImportError(
        'limit-exceeded',
        `ACP replay for session '${capture.sessionId}' exceeded its notification or byte limit.`,
      )
      return
    }

    if (notification.sessionId !== capture.sessionId)
    {
      capture.foreignNotificationCount += 1
      return
    }
    capture.notifications.push(notification)
    capture.lastMatchingActivityAtMs = nowMs
  }

  const finish = (capture: ReplayCapture): ReplayCaptureSnapshot =>
  {
    if (activeCapture !== capture)
    {
      throw new AcpImportError('load-failed', 'ACP replay capture is no longer active.')
    }
    activeCapture = undefined
    if (capture.limitError !== undefined)
    {
      throw capture.limitError
    }
    return {
      notifications: capture.notifications,
      foreignNotificationCount: capture.foreignNotificationCount,
    }
  }

  const abort = (capture: ReplayCapture): void =>
  {
    if (activeCapture === capture)
    {
      activeCapture = undefined
    }
  }

  return { begin, finish, abort, route }
}

export function withAcpImportTimeout<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  timeoutMs: number,
  action: string,
): Effect.Effect<A, E | AcpImportError, R>
{
  return effect.pipe(
    Effect.timeoutOption(timeoutMs),
    Effect.flatMap((result) =>
      Option.match(result, {
        onNone: () =>
          Effect.fail(new AcpImportError('timeout', `${action} timed out after ${timeoutMs}ms.`)),
        onSome: Effect.succeed,
      }),
    ),
  )
}

export function sourceForDriver(driverKind: AcpImportDriverKind): AcpImportSource
{
  return driverKind === 'cursor' ? 'cursor-acp' : 'grok-acp'
}

export function makeAcpImportSourcePath(
  driverKind: AcpImportDriverKind,
  providerInstanceId: string,
  nativeSessionId: string,
): string
{
  if (providerInstanceId.trim().length === 0 || nativeSessionId.trim().length === 0)
  {
    throw new AcpImportError(
      'invalid-source',
      'ACP import source requires non-empty provider instance and session ids.',
    )
  }
  return `acp://${driverKind}/${encodeURIComponent(providerInstanceId)}/${encodeURIComponent(
    nativeSessionId,
  )}`
}

export function parseAcpImportSourcePath(
  sourcePath: string,
  expectedDriverKind?: AcpImportDriverKind,
  expectedProviderInstanceId?: string,
): {
  readonly driverKind: AcpImportDriverKind
  readonly providerInstanceId: string
  readonly nativeSessionId: string
}
{
  const match = /^acp:\/\/(cursor|grok)\/([^/?#]+)\/([^/?#]+)$/u.exec(sourcePath)
  if (match === null)
  {
    throw new AcpImportError('invalid-source', 'ACP import source has an unsupported driver.')
  }
  const driverKind = match[1] as AcpImportDriverKind
  if (expectedDriverKind !== undefined && driverKind !== expectedDriverKind)
  {
    throw new AcpImportError(
      'invalid-source',
      `ACP import source belongs to '${driverKind}', not '${expectedDriverKind}'.`,
    )
  }
  let providerInstanceId: string
  let nativeSessionId: string
  try
  {
    providerInstanceId = decodeURIComponent(match[2]!)
    nativeSessionId = decodeURIComponent(match[3]!)
  }
  catch (cause)
  {
    throw new AcpImportError(
      'invalid-source',
      'ACP import source has an invalid provider instance or session id.',
      { cause },
    )
  }
  if (providerInstanceId.trim().length === 0 || nativeSessionId.trim().length === 0)
  {
    throw new AcpImportError(
      'invalid-source',
      'ACP import source has an invalid provider instance or session id.',
    )
  }
  if (
    expectedProviderInstanceId !== undefined &&
    providerInstanceId !== expectedProviderInstanceId
  )
  {
    throw new AcpImportError(
      'invalid-source',
      `ACP import source belongs to provider instance '${providerInstanceId}', not '${expectedProviderInstanceId}'.`,
    )
  }
  return { driverKind, providerInstanceId, nativeSessionId }
}

export function buildSpawnInput(options: AcpImportConnectionOptions)
{
  if (options.driverKind === 'cursor')
  {
    return buildCursorAcpSpawnInput(
      {
        binaryPath: options.binaryPath ?? '',
        apiEndpoint: options.apiEndpoint ?? '',
      },
      options.cwd,
      options.environment,
    )
  }
  return buildGrokAcpSpawnInput(
    {
      binaryPath: options.binaryPath ?? '',
    },
    options.cwd,
    options.environment,
  )
}

export function authMethodId(options: AcpImportConnectionOptions): string
{
  if (options.driverKind === 'cursor')
  {
    return 'cursor_login'
  }
  return options.environment?.XAI_API_KEY?.trim() ? 'xai.api_key' : 'cached_token'
}

export function terminateAcpImportChild(
  child: ChildProcessSpawner.ChildProcessHandle,
  shutdownGraceMs: number,
): Effect.Effect<void>
{
  const forceKill = child
    .kill({ killSignal: 'SIGKILL' })
    .pipe(Effect.timeoutOption(shutdownGraceMs), Effect.asVoid, Effect.ignore)
  const gracefulThenForced = child.kill({ killSignal: 'SIGTERM' }).pipe(
    Effect.timeoutOption(shutdownGraceMs),
    Effect.flatMap((completion) => (Option.isSome(completion) ? Effect.void : forceKill)),
    Effect.catch(() => forceKill),
  )
  return child.isRunning.pipe(
    Effect.flatMap((isRunning) => (isRunning ? gracefulThenForced : Effect.void)),
    Effect.catch(() => forceKill),
  )
}

export const connectAcpImportClient = (
  options: AcpImportConnectionOptions,
): Effect.Effect<
  ConnectedAcpImportClient,
  AcpImportError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* ()
  {
    if (options.providerInstanceId.trim().length === 0)
    {
      return yield* Effect.fail(
        new AcpImportError('invalid-source', 'ACP provider instance id must not be empty.'),
      )
    }
    const policy = resolveAcpImportPolicy(options.policy)
    const wireUsage = options.wireUsage
    const initialWireUsageBytes =
      wireUsage === undefined ||
      !Number.isFinite(wireUsage.consumedBytes) ||
      wireUsage.consumedBytes < 0
        ? 0
        : Math.floor(wireUsage.consumedBytes)
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const scope = yield* Scope.Scope
    const spawn = buildSpawnInput(options)
    const resolved = yield* resolveSpawnCommand(
      spawn.command,
      spawn.args,
      spawn.env ? { env: spawn.env, extendEnv: true } : {},
    ).pipe(
      Effect.mapError(
        (cause) =>
          new AcpImportError('spawn-failed', `Could not resolve '${spawn.command}'.`, { cause }),
      ),
    )
    const child = yield* spawner
      .spawn(
        ChildProcess.make(resolved.command, resolved.args, {
          ...(spawn.cwd ? { cwd: spawn.cwd } : {}),
          ...(spawn.env ? { env: spawn.env, extendEnv: true } : {}),
          shell: resolved.shell,
          // the scoped spawner's finalizer waits for exit; use SIGKILL as its
          // last-resort signal after our graceful bounded finalizer runs
          killSignal: 'SIGKILL',
        }),
      )
      .pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.mapError(
          (cause) =>
            new AcpImportError('spawn-failed', `Could not start '${spawn.command}'.`, { cause }),
        ),
      )
    yield* Scope.addFinalizer(scope, terminateAcpImportChild(child, policy.shutdownGraceMs))
    yield* Stream.runDrain(child.stderr).pipe(Effect.ignore, Effect.forkScoped)
    const maximumIncomingBytesPerConnection = checkedByteSum(
      policy.maxCatalogBytes,
      policy.maxReplayBytesPerConnection,
    )
    const clientContext = yield* Layer.build(
      EffectAcpClient.layerChildProcess(child, {
        maximumIncomingConnectionBytes: maximumIncomingBytesPerConnection,
        maximumIncomingFrameBytes: maximumIncomingBytesPerConnection,
        maximumPendingNotifications: 0,
        maximumRetainedNotifications: 0,
        ...(wireUsage === undefined
          ? {}
          : {
              onIncomingConnectionBytes: (connectionBytes: number) =>
                {
                wireUsage.consumedBytes = checkedByteSum(initialWireUsageBytes, connectionBytes)
              },
            }),
      }),
    ).pipe(Effect.provideService(Scope.Scope, scope))
    const client = yield* EffectAcpClient.AcpClient.pipe(Effect.provide(clientContext))
    const replayRouter = makeReplayRouter(policy)

    // replay import must never leave an actionable request waiting on a user
    yield* client.handleRequestPermission(() =>
      Effect.succeed({ outcome: { outcome: 'cancelled' as const } }),
    )
    yield* client.handleElicitation(() => Effect.succeed({ action: 'cancel' as const }))
    yield* client.handleSessionUpdate((notification) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((nowMs) =>
          Effect.sync(() =>
          {
            replayRouter.route(notification, nowMs)
          }),
        ),
      ),
    )

    const initializeResult = yield* withAcpImportTimeout(
      client.agent
        .initialize({
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: 'code456-session-import', version: '0.0.0' },
        })
        .pipe(Effect.mapError(mapProtocolError('initialize-failed', 'ACP initialization failed'))),
      policy.initializeTimeoutMs,
      'ACP initialization',
    )
    yield* withAcpImportTimeout(
      client.agent
        .authenticate({ methodId: authMethodId(options) })
        .pipe(
          Effect.mapError(mapProtocolError('authenticate-failed', 'ACP authentication failed')),
        ),
      policy.authenticateTimeoutMs,
      'ACP authentication',
    )
    return { client, initializeResult, policy, replayRouter }
  })

export function requireCatalogCapabilities(
  initializeResult: EffectAcpSchema.InitializeResponse,
  operation: 'list' | 'load',
): void
{
  if (
    operation === 'list' &&
    initializeResult.agentCapabilities?.sessionCapabilities?.list == null
  )
  {
    throw new AcpImportError(
      'unsupported-list',
      'The ACP agent does not advertise session/list support.',
    )
  }
  if (operation === 'load' && initializeResult.agentCapabilities?.loadSession !== true)
  {
    throw new AcpImportError(
      'unsupported-load',
      'The ACP agent does not advertise replay-capable session/load support.',
    )
  }
}

export function normalizeOptionalText(value: string | null | undefined): string | null
{
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

export function normalizeOptionalTimestamp(value: string | null | undefined): string | null
{
  if (!value) return null
  const millis = Date.parse(value)
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null
}

export function errorMessage(cause: unknown): string
{
  return cause instanceof Error ? cause.message : String(cause)
}

export function boundedImportError(
  fallbackCode: AcpImportError['code'],
  cause: unknown,
  action?: string,
): AcpImportError
{
  const code = cause instanceof AcpImportError ? cause.code : fallbackCode
  const detail = errorMessage(cause)
  const rawMessage = action === undefined ? detail : `${action}: ${detail}`
  return new AcpImportError(code, boundedToolDisplayText(rawMessage, replayFailureMessageMaxBytes))
}

export function mapProtocolError(
  code: Extract<
    AcpImportError['code'],
    'initialize-failed' | 'authenticate-failed' | 'list-failed' | 'load-failed'
  >,
  action: string,
)
{
  return (cause: EffectAcpErrors.AcpError) => boundedImportError(code, cause, action)
}
