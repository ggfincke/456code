// apps/server/src/import/parsers/acpImportLoad.ts
// loads ACP sessions over a connected import agent

// @effect-diagnostics nodeBuiltinImport:off globalDate:off

import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner'
import type * as EffectAcpSchema from 'effect-acp/schema'

import { syntheticLoadSessionResponseFromInitialize } from '../../provider/acp/AcpRuntimeModel.ts'
import {
  boundedImportError,
  connectAcpImportClient,
  mapProtocolError,
  parseAcpImportSourcePath,
  requireCatalogCapabilities,
  resolveAcpImportPolicy,
  retainNormalizedSession,
  withAcpImportTimeout,
} from './acpImportConnection.ts'
import { listConnectedAcpImportSessions } from './acpImportCatalog.ts'
import { normalizeAcpSessionReplay } from './acpImportNormalize.ts'
import type {
  AcpImportBatchLoadResult,
  AcpImportCatalogEntry,
  AcpImportCatalogLoadResult,
  AcpImportConnectionOptions,
  AcpImportedSession,
  ConnectedAcpImportClient,
  ReplayCapture,
} from './acpImportTypes.ts'
import { AcpImportError } from './acpImportTypes.ts'

export function failedBatchResult(
  sourcePath: string,
  error: AcpImportError,
  consumedWireBytes = 0,
): AcpImportBatchLoadResult
{
  return {
    sourcePath,
    descriptor: null,
    session: null,
    error: boundedImportError(error.code, error),
    consumedWireBytes,
  }
}

export function finalizeBatchResults(
  sourcePaths: ReadonlyArray<string>,
  completedResults: ReadonlyArray<AcpImportBatchLoadResult | undefined>,
): ReadonlyArray<AcpImportBatchLoadResult>
{
  return sourcePaths.map(
    (sourcePath, index) =>
      completedResults[index] ??
      failedBatchResult(
        sourcePath,
        new AcpImportError('load-failed', 'ACP batch load did not produce a result.'),
      ),
  )
}

const waitForReplayIdle = (
  connection: ConnectedAcpImportClient,
  capture: ReplayCapture,
): Effect.Effect<EffectAcpSchema.LoadSessionResponse, AcpImportError> =>
  Effect.gen(function* ()
  {
    while (true)
    {
      if (capture.limitError !== undefined)
      {
        return yield* Effect.fail(capture.limitError)
      }
      const nowMs = yield* Clock.currentTimeMillis
      if (
        capture.lastMatchingActivityAtMs !== undefined &&
        nowMs - capture.lastMatchingActivityAtMs >= connection.policy.hangingReplayIdleMs
      )
      {
        return syntheticLoadSessionResponseFromInitialize(connection.initializeResult)
      }
      yield* Effect.sleep(Math.min(25, connection.policy.hangingReplayIdleMs))
    }
  })

const waitForPostResponseReplay = (
  connection: ConnectedAcpImportClient,
  capture: ReplayCapture,
): Effect.Effect<void, AcpImportError> =>
  Effect.sleep(connection.policy.postResponseReplayGraceMs).pipe(
    Effect.flatMap(() =>
      capture.limitError === undefined ? Effect.void : Effect.fail(capture.limitError),
    ),
  )

export const loadConnectedAcpImportSession = (
  connection: ConnectedAcpImportClient,
  descriptor: AcpImportCatalogEntry,
): Effect.Effect<AcpImportedSession, AcpImportError> =>
  Effect.gen(function* ()
  {
    yield* Effect.try({
      try: () => requireCatalogCapabilities(connection.initializeResult, 'load'),
      catch: (cause) => boundedImportError('unsupported-load', cause),
    })
    const capture = yield* Effect.try({
      try: () => connection.replayRouter.begin(descriptor.nativeSessionId),
      catch: (cause) => boundedImportError('load-failed', cause),
    })

    return yield* Effect.gen(function* ()
    {
      const responseSettlement = yield* withAcpImportTimeout(
        Effect.raceFirst(
          connection.client.agent
            .loadSession({
              sessionId: descriptor.nativeSessionId,
              cwd: descriptor.cwd,
              mcpServers: [],
            })
            .pipe(
              Effect.mapError(mapProtocolError('load-failed', 'ACP session/load failed')),
              Effect.map((response) => ({ _tag: 'response' as const, response })),
            ),
          waitForReplayIdle(connection, capture).pipe(
            Effect.map((response) => ({ _tag: 'replay-idle' as const, response })),
          ),
        ),
        connection.policy.loadTimeoutMs,
        'ACP session/load',
      )
      if (responseSettlement._tag === 'response')
      {
        yield* waitForPostResponseReplay(connection, capture)
      }
      const snapshot = yield* Effect.try({
        try: () => connection.replayRouter.finish(capture),
        catch: (cause) => boundedImportError('load-failed', cause),
      })
      return normalizeAcpSessionReplay({
        descriptor,
        notifications: snapshot.notifications,
        loadResponse: responseSettlement.response,
        foreignNotificationCount: snapshot.foreignNotificationCount,
      })
    }).pipe(
      Effect.ensuring(
        Effect.sync(() =>
        {
          connection.replayRouter.abort(capture)
        }),
      ),
    )
  })

export const loadAcpImportSessionsBatch = (
  options: AcpImportConnectionOptions,
  sourcePaths: ReadonlyArray<string>,
): Effect.Effect<
  ReadonlyArray<AcpImportBatchLoadResult>,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.suspend(() =>
  {
    const policy = resolveAcpImportPolicy(options.policy)
    const normalizedByteBudget = { consumedBytes: 0 }
    const requestedSourcePaths = [...sourcePaths]
    const attemptedSourcePaths = requestedSourcePaths.slice(0, policy.maxSessions)
    const completedResults: Array<AcpImportBatchLoadResult | undefined> = Array.from({
      length: requestedSourcePaths.length,
    })
    for (let index = attemptedSourcePaths.length; index < requestedSourcePaths.length; index += 1)
    {
      const sourcePath = requestedSourcePaths[index]!
      completedResults[index] = failedBatchResult(
        sourcePath,
        new AcpImportError(
          'limit-exceeded',
          `ACP batch request exceeded the configured ${policy.maxSessions}-session limit; this source was not loaded.`,
        ),
      )
    }

    const parsedRequests = attemptedSourcePaths.flatMap((sourcePath, index) =>
    {
      try
      {
        return [
          {
            sourcePath,
            index,
            parsed: parseAcpImportSourcePath(
              sourcePath,
              options.driverKind,
              options.providerInstanceId,
            ),
          },
        ]
      }
      catch (cause)
      {
        completedResults[index] = failedBatchResult(
          sourcePath,
          boundedImportError('invalid-source', cause),
        )
        return []
      }
    })
    if (parsedRequests.length === 0)
    {
      return Effect.succeed(finalizeBatchResults(requestedSourcePaths, completedResults))
    }

    const batch = Effect.scoped(
      Effect.gen(function* ()
      {
        const connection = yield* connectAcpImportClient(options)
        const catalog = yield* listConnectedAcpImportSessions(
          connection,
          options.driverKind,
          options.providerInstanceId,
        )
        const catalogBySourcePath = new Map(catalog.map((entry) => [entry.sourcePath, entry]))
        let attributedWireBytes = 0

        for (const request of parsedRequests)
        {
          const { index, parsed, sourcePath } = request
          const descriptor = catalogBySourcePath.get(sourcePath)
          let result: AcpImportBatchLoadResult
          if (descriptor === undefined || descriptor.nativeSessionId !== parsed.nativeSessionId)
          {
            result = failedBatchResult(
              sourcePath,
              new AcpImportError(
                'invalid-source',
                `ACP session '${parsed.nativeSessionId}' is no longer present in session/list.`,
              ),
            )
          }
          else
          {
            result = yield* loadConnectedAcpImportSession(connection, descriptor).pipe(
              Effect.flatMap((session) =>
                Effect.try({
                  try: () => retainNormalizedSession(policy, normalizedByteBudget, session),
                  catch: (cause) => boundedImportError('limit-exceeded', cause),
                }),
              ),
              Effect.match({
                onFailure: (error) => ({
                  sourcePath,
                  descriptor,
                  session: null,
                  error: boundedImportError(error.code, error),
                }),
                onSuccess: (session) => ({
                  sourcePath,
                  descriptor,
                  session,
                  error: null,
                }),
              }),
            )
          }
          const totalWireBytes = yield* connection.client.raw.incomingConnectionBytes
          const consumedWireBytes = Math.max(0, totalWireBytes - attributedWireBytes)
          attributedWireBytes = totalWireBytes
          completedResults[index] = { ...result, consumedWireBytes }
        }
      }),
    ).pipe(
      Effect.catch((error) =>
        Effect.sync(() =>
        {
          for (const [index, sourcePath] of attemptedSourcePaths.entries())
          {
            if (completedResults[index] !== undefined)
            {
              continue
            }
            completedResults[index] = failedBatchResult(sourcePath, error)
          }
        }),
      ),
    )

    return batch.pipe(
      Effect.timeoutOption(policy.batchLoadTimeoutMs),
      Effect.map((completion) =>
      {
        if (Option.isNone(completion))
        {
          const timeout = new AcpImportError(
            'timeout',
            `ACP batch load timed out after ${policy.batchLoadTimeoutMs}ms.`,
          )
          for (const [index, sourcePath] of attemptedSourcePaths.entries())
          {
            if (completedResults[index] !== undefined)
            {
              continue
            }
            completedResults[index] = failedBatchResult(sourcePath, timeout)
          }
        }
        return finalizeBatchResults(requestedSourcePaths, completedResults)
      }),
    )
  })

export const loadAcpImportSession = (
  options: AcpImportConnectionOptions,
  sourcePath: string,
): Effect.Effect<AcpImportedSession, AcpImportError, ChildProcessSpawner.ChildProcessSpawner> =>
  loadAcpImportSessionsBatch(options, [sourcePath]).pipe(
    Effect.flatMap((results) =>
    {
      const result = results[0]
      if (result?.session !== null && result?.session !== undefined)
      {
        return Effect.succeed(result.session)
      }
      return Effect.fail(
        result?.error ?? new AcpImportError('load-failed', 'ACP batch load returned no result.'),
      )
    }),
  )

export const scanAndLoadAcpImportCatalog = (
  options: AcpImportConnectionOptions,
  maximumSessionsToLoad = Number.POSITIVE_INFINITY,
): Effect.Effect<
  ReadonlyArray<AcpImportCatalogLoadResult>,
  AcpImportError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.suspend(() =>
  {
    const policy = resolveAcpImportPolicy(options.policy)
    const normalizedByteBudget = { consumedBytes: 0 }
    return Effect.scoped(
      Effect.gen(function* ()
      {
        const connection = yield* connectAcpImportClient(options)
        const catalog = yield* listConnectedAcpImportSessions(
          connection,
          options.driverKind,
          options.providerInstanceId,
        )
        const boundedCatalog = catalog.slice(0, Math.max(0, Math.floor(maximumSessionsToLoad)))
        let attributedWireBytes = 0
        return yield* Effect.forEach(
          boundedCatalog,
          (descriptor) =>
            Effect.gen(function* ()
            {
              const result: AcpImportCatalogLoadResult = yield* loadConnectedAcpImportSession(
                connection,
                descriptor,
              ).pipe(
                Effect.flatMap((session) =>
                  Effect.try({
                    try: () => retainNormalizedSession(policy, normalizedByteBudget, session),
                    catch: (cause) => boundedImportError('limit-exceeded', cause),
                  }),
                ),
                Effect.match({
                  onFailure: (error) => ({
                    descriptor,
                    session: null,
                    error: boundedImportError(error.code, error),
                  }),
                  onSuccess: (session) => ({
                    descriptor,
                    session,
                    error: null,
                  }),
                }),
              )
              const totalWireBytes = yield* connection.client.raw.incomingConnectionBytes
              const consumedWireBytes = Math.max(0, totalWireBytes - attributedWireBytes)
              attributedWireBytes = totalWireBytes
              return { ...result, consumedWireBytes }
            }),
          { concurrency: 1 },
        )
      }),
    ).pipe(Effect.mapError((error) => boundedImportError('list-failed', error)))
  })
