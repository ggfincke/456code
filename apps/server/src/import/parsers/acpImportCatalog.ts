// apps/server/src/import/parsers/acpImportCatalog.ts
// lists and scans replayable ACP session catalogs

// @effect-diagnostics nodeBuiltinImport:off globalDate:off

import * as NodePath from 'node:path'

import * as Effect from 'effect/Effect'
import * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner'
import type * as EffectAcpSchema from 'effect-acp/schema'

import {
  boundedImportError,
  connectAcpImportClient,
  jsonByteLength,
  makeAcpImportSourcePath,
  mapProtocolError,
  normalizeOptionalText,
  normalizeOptionalTimestamp,
  requireCatalogCapabilities,
  sourceForDriver,
  withAcpImportTimeout,
} from './acpImportConnection.ts'
import {
  boundedReplayText,
  compareStrings,
  cwdFieldMaxBytes,
  metadataFieldMaxBytes,
  textEncoder,
} from './acpImportRedact.ts'
import type {
  AcpImportCatalogEntry,
  AcpImportConnectionOptions,
  AcpImportDriverKind,
  ConnectedAcpImportClient,
} from './acpImportTypes.ts'
import { AcpImportError } from './acpImportTypes.ts'

export function hasUnsafeCatalogCharacters(value: string): boolean
{
  for (const character of value)
  {
    const codePoint = character.codePointAt(0) ?? 0
    if (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x061c ||
      (codePoint >= 0x200e && codePoint <= 0x200f) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    )
    {
      return true
    }
  }
  return false
}

export function catalogEntry(
  driverKind: AcpImportDriverKind,
  providerInstanceId: string,
  info: EffectAcpSchema.SessionInfo,
): AcpImportCatalogEntry
{
  if (info.sessionId.trim().length === 0)
  {
    throw new AcpImportError('invalid-source', 'ACP session/list returned an empty session id.')
  }
  if (hasUnsafeCatalogCharacters(info.sessionId))
  {
    throw new AcpImportError(
      'invalid-source',
      'ACP session/list returned a session id containing unsafe control or bidirectional characters.',
    )
  }
  if (textEncoder.encode(info.sessionId).byteLength > metadataFieldMaxBytes)
  {
    throw new AcpImportError(
      'invalid-source',
      `ACP session/list returned a session id longer than ${metadataFieldMaxBytes} bytes.`,
    )
  }
  if (hasUnsafeCatalogCharacters(info.cwd))
  {
    throw new AcpImportError(
      'invalid-source',
      'ACP session/list returned a cwd containing unsafe control or bidirectional characters.',
    )
  }
  if (info.cwd.trim().length === 0 || !NodePath.isAbsolute(info.cwd))
  {
    throw new AcpImportError(
      'invalid-source',
      `ACP session/list returned a non-absolute cwd for session '${info.sessionId}'.`,
    )
  }
  if (textEncoder.encode(info.cwd).byteLength > cwdFieldMaxBytes)
  {
    throw new AcpImportError(
      'invalid-source',
      `ACP session/list returned a cwd longer than ${cwdFieldMaxBytes} bytes.`,
    )
  }
  const normalizedTitle = normalizeOptionalText(info.title)
  return {
    driverKind,
    providerInstanceId,
    source: sourceForDriver(driverKind),
    sourcePath: makeAcpImportSourcePath(driverKind, providerInstanceId, info.sessionId),
    nativeSessionId: info.sessionId,
    cwd: info.cwd,
    title:
      normalizedTitle === null ? null : boundedReplayText(normalizedTitle, metadataFieldMaxBytes),
    updatedAt: normalizeOptionalTimestamp(info.updatedAt),
  }
}

export const listConnectedAcpImportSessions = (
  connection: ConnectedAcpImportClient,
  driverKind: AcpImportDriverKind,
  providerInstanceId: string,
): Effect.Effect<ReadonlyArray<AcpImportCatalogEntry>, AcpImportError> =>
  Effect.gen(function* ()
  {
    yield* Effect.try({
      try: () => requireCatalogCapabilities(connection.initializeResult, 'list'),
      catch: (cause) => boundedImportError('unsupported-list', cause),
    })

    const entries: AcpImportCatalogEntry[] = []
    const seenCursors = new Set<string>()
    const seenSessionIds = new Set<string>()
    let cursor: string | undefined
    let pageCount = 0
    let sessionCount = 0
    let catalogByteCount = 0

    while (true)
    {
      pageCount += 1
      if (pageCount > connection.policy.maxPages)
      {
        return yield* Effect.fail(
          new AcpImportError(
            'limit-exceeded',
            `ACP session/list exceeded the ${connection.policy.maxPages}-page catalog limit.`,
          ),
        )
      }
      const response = yield* withAcpImportTimeout(
        connection.client.agent
          .listSessions(cursor === undefined ? {} : { cursor })
          .pipe(Effect.mapError(mapProtocolError('list-failed', 'ACP session/list failed'))),
        connection.policy.listPageTimeoutMs,
        'ACP session/list page',
      )
      sessionCount += response.sessions.length
      catalogByteCount += jsonByteLength(response)
      if (
        sessionCount > connection.policy.maxSessions ||
        catalogByteCount > connection.policy.maxCatalogBytes
      )
      {
        return yield* Effect.fail(
          new AcpImportError(
            'limit-exceeded',
            'ACP session/list exceeded the configured session or byte limit.',
          ),
        )
      }
      for (const info of response.sessions)
      {
        const entry = yield* Effect.try({
          try: () => catalogEntry(driverKind, providerInstanceId, info),
          catch: (cause) => boundedImportError('invalid-source', cause),
        })
        if (seenSessionIds.has(entry.nativeSessionId))
        {
          return yield* Effect.fail(
            new AcpImportError(
              'invalid-pagination',
              `ACP session/list returned duplicate session '${entry.nativeSessionId}'.`,
            ),
          )
        }
        seenSessionIds.add(entry.nativeSessionId)
        entries.push(entry)
      }

      const nextCursor = response.nextCursor == null ? undefined : response.nextCursor
      if (nextCursor === undefined)
      {
        break
      }
      if (seenCursors.has(nextCursor))
      {
        return yield* Effect.fail(
          new AcpImportError(
            'invalid-pagination',
            `ACP session/list repeated pagination cursor '${nextCursor}'.`,
          ),
        )
      }
      seenCursors.add(nextCursor)
      cursor = nextCursor
    }

    return entries.sort(
      (left, right) =>
        compareStrings(right.updatedAt ?? '', left.updatedAt ?? '') ||
        compareStrings(left.nativeSessionId, right.nativeSessionId),
    )
  })

export const scanAcpImportCatalog = (
  options: AcpImportConnectionOptions,
): Effect.Effect<
  ReadonlyArray<AcpImportCatalogEntry>,
  AcpImportError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.scoped(
    connectAcpImportClient(options).pipe(
      Effect.flatMap((connection) =>
        listConnectedAcpImportSessions(connection, options.driverKind, options.providerInstanceId),
      ),
    ),
  ).pipe(Effect.mapError((error) => boundedImportError('list-failed', error)))
