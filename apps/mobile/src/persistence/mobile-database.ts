// apps/mobile/src/persistence/mobile-database.ts
// manages the mobile sqlite persistence layer

import type { EnvironmentOwnedDataResource } from '@t3tools/client-runtime/platform'
import type { EnvironmentId } from '@t3tools/contracts'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import type { SQLiteDatabase } from 'expo-sqlite'

const DATABASE_NAME = 'code456-client.db'
const DATABASE_SCHEMA_VERSION = 2
// version 2 added the removal generation; rows written by version 1 are read
// back with the generation the column default gives them.
const ENVIRONMENT_CLEANUP_SCHEMA_VERSION = 2
const INITIAL_ENVIRONMENT_CLEANUP_GENERATION = 1
const LEGACY_CACHE_DIRECTORIES = [
  'connection-shell-snapshots',
  'shell-snapshots',
  'connection-thread-snapshots',
  'connection-server-configs',
  'connection-vcs-refs',
] as const

export const ClientCacheKind = Schema.Literals(['shell', 'thread', 'server-config', 'vcs-refs'])
export type ClientCacheKind = typeof ClientCacheKind.Type

export interface ClientCacheSummaryRow
{
  readonly environmentId: EnvironmentId
  readonly kind: ClientCacheKind
  readonly recordCount: number
  readonly payloadBytes: number
}

export interface StoredPreferencesJson
{
  readonly payload: string
  readonly updatedAt: number
}

export type EnvironmentCleanupResourceState = 'pending' | 'complete'

const StoredEnvironmentCleanupSchemaVersion = Schema.Literals([
  1,
  ENVIRONMENT_CLEANUP_SCHEMA_VERSION,
])

export interface StoredEnvironmentCleanupIntent
{
  readonly environmentId: EnvironmentId
  readonly schemaVersion: typeof StoredEnvironmentCleanupSchemaVersion.Type
  // one removal of this environment's owned data. Re-arming a row starts the
  // next generation so a completion from the previous removal is rejected.
  readonly generation: number
  readonly requestedAtEpochMs: number
  readonly cacheState: EnvironmentCleanupResourceState
  readonly outboxState: EnvironmentCleanupResourceState
  readonly draftsState: EnvironmentCleanupResourceState
  readonly attempts: number
  readonly nextAttemptAtEpochMs: number
  readonly lastAttemptAtEpochMs: number | null
  readonly lastError: string | null
}

const ClientCacheSummaryRows = Schema.Array(
  Schema.Struct({
    environmentId: Schema.String,
    kind: ClientCacheKind,
    recordCount: Schema.Number,
    payloadBytes: Schema.Number,
  }),
)

const StoredEnvironmentCleanupIntents = Schema.Array(
  Schema.Struct({
    environmentId: Schema.String,
    schemaVersion: StoredEnvironmentCleanupSchemaVersion,
    generation: Schema.Number,
    requestedAtEpochMs: Schema.Number,
    cacheState: Schema.Literals(['pending', 'complete']),
    outboxState: Schema.Literals(['pending', 'complete']),
    draftsState: Schema.Literals(['pending', 'complete']),
    attempts: Schema.Number,
    nextAttemptAtEpochMs: Schema.Number,
    lastAttemptAtEpochMs: Schema.NullOr(Schema.Number),
    lastError: Schema.NullOr(Schema.String),
  }),
)

const MobileDatabaseOperation = Schema.Literals([
  'open',
  'migrate',
  'load-cache',
  'save-cache',
  'remove-cache',
  'clear-cache-kind',
  'clear-environment-cache',
  'clear-all-caches',
  'inspect-caches',
  'load-preferences',
  'save-preferences',
  'load-environment-cleanup-intents',
  'prepare-environment-cleanup',
  'mark-environment-cleanup-resource',
  'record-environment-cleanup-attempt',
  'prune-environment-cleanup-intent',
])

export class MobileDatabaseError extends Schema.TaggedErrorClass<MobileDatabaseError>()(
  'MobileDatabaseError',
  {
    operation: MobileDatabaseOperation,
    cause: Schema.Defect(),
  },
)
{
  override get message(): string
  {
    return `Mobile database operation failed: ${this.operation}.`
  }
}

function databaseError(operation: typeof MobileDatabaseOperation.Type)
{
  return (cause: unknown) => new MobileDatabaseError({ operation, cause })
}

interface LegacyCacheRecord
{
  readonly environmentId: string
  readonly kind: ClientCacheKind
  readonly cacheKey: string
  readonly schemaVersion: number
  readonly payload: string
}

function objectRecord(value: unknown): Record<string, unknown> | null
{
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

export function decodeLegacyCacheRecord(
  directoryName: (typeof LEGACY_CACHE_DIRECTORIES)[number],
  payload: string,
): LegacyCacheRecord | null
{
  let parsed: Record<string, unknown> | null
  try
  {
    parsed = objectRecord(JSON.parse(payload))
  }
  catch
  {
    return null
  }
  if (
    parsed === null ||
    typeof parsed.environmentId !== 'string' ||
    typeof parsed.schemaVersion !== 'number'
  )
  {
    return null
  }

  switch (directoryName)
  {
    case 'connection-shell-snapshots':
    case 'shell-snapshots':
      return {
        environmentId: parsed.environmentId,
        kind: 'shell',
        cacheKey: 'snapshot',
        schemaVersion: parsed.schemaVersion,
        payload,
      }
    case 'connection-thread-snapshots':
      return typeof parsed.threadId === 'string'
        ? {
            environmentId: parsed.environmentId,
            kind: 'thread',
            cacheKey: parsed.threadId,
            schemaVersion: parsed.schemaVersion,
            payload,
          }
        : null
    case 'connection-server-configs':
      return {
        environmentId: parsed.environmentId,
        kind: 'server-config',
        cacheKey: 'config',
        schemaVersion: parsed.schemaVersion,
        payload,
      }
    case 'connection-vcs-refs':
      return typeof parsed.cwd === 'string'
        ? {
            environmentId: parsed.environmentId,
            kind: 'vcs-refs',
            cacheKey: parsed.cwd,
            schemaVersion: parsed.schemaVersion,
            payload,
          }
        : null
  }
}

async function migrateLegacyFileCaches(database: SQLiteDatabase): Promise<boolean>
{
  try
  {
    const { Directory, File, Paths } = await import('expo-file-system')
    let complete = true
    const listFiles = (
      directory: InstanceType<typeof Directory>,
    ): Array<InstanceType<typeof File>> =>
      directory.list().flatMap((entry) => (entry instanceof File ? [entry] : listFiles(entry)))

    for (const directoryName of LEGACY_CACHE_DIRECTORIES)
    {
      try
      {
        const directory = new Directory(Paths.document, directoryName)
        if (!directory.exists) continue
        for (const file of listFiles(directory))
        {
          const payload = await file.text()
          const record = decodeLegacyCacheRecord(directoryName, payload)
          if (record === null) continue
          await database.runAsync(
            `INSERT INTO client_cache
              (environment_id, kind, cache_key, schema_version, payload, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (environment_id, kind, cache_key) DO NOTHING`,
            record.environmentId,
            record.kind,
            record.cacheKey,
            record.schemaVersion,
            record.payload,
            Date.now(),
          )
        }
        directory.delete()
      }
      catch (cause)
      {
        complete = false
        console.warn(`[mobile-database] could not migrate legacy cache ${directoryName}`, cause)
      }
    }
    return complete
  }
  catch (cause)
  {
    console.warn('[mobile-database] could not load legacy cache migration', cause)
    return false
  }
}

export class MobileDatabase extends Context.Service<
  MobileDatabase,
  {
    readonly loadCache: (
      environmentId: EnvironmentId,
      kind: ClientCacheKind,
      cacheKey: string,
    ) => Effect.Effect<Option.Option<string>, MobileDatabaseError>
    readonly saveCache: (
      environmentId: EnvironmentId,
      kind: ClientCacheKind,
      cacheKey: string,
      schemaVersion: number,
      payload: string,
    ) => Effect.Effect<void, MobileDatabaseError>
    readonly removeCache: (
      environmentId: EnvironmentId,
      kind: ClientCacheKind,
      cacheKey: string,
    ) => Effect.Effect<void, MobileDatabaseError>
    readonly clearCacheKind: (
      environmentId: EnvironmentId,
      kind: ClientCacheKind,
    ) => Effect.Effect<void, MobileDatabaseError>
    readonly clearEnvironmentCache: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<void, MobileDatabaseError>
    readonly clearAllCaches: Effect.Effect<void, MobileDatabaseError>
    readonly inspectCaches: Effect.Effect<ReadonlyArray<ClientCacheSummaryRow>, MobileDatabaseError>
    readonly loadPreferencesJson: Effect.Effect<
      Option.Option<StoredPreferencesJson>,
      MobileDatabaseError
    >
    readonly savePreferencesJson: (
      payload: string,
      updatedAt: number,
    ) => Effect.Effect<void, MobileDatabaseError>
    readonly loadEnvironmentCleanupIntents: Effect.Effect<
      ReadonlyArray<StoredEnvironmentCleanupIntent>,
      MobileDatabaseError
    >
    // resolves to the removal generation the intent now belongs to; every later
    // write for that removal has to carry it.
    readonly prepareEnvironmentCleanup: (
      environmentId: EnvironmentId,
      requestedAtEpochMs: number,
    ) => Effect.Effect<number, MobileDatabaseError>
    readonly markEnvironmentCleanupResourceComplete: (
      environmentId: EnvironmentId,
      resource: EnvironmentOwnedDataResource,
      generation: number,
    ) => Effect.Effect<void, MobileDatabaseError>
    readonly recordEnvironmentCleanupAttempt: (
      environmentId: EnvironmentId,
      generation: number,
      attempts: number,
      attemptedAtEpochMs: number,
      nextAttemptAtEpochMs: number,
      lastError: string | null,
    ) => Effect.Effect<void, MobileDatabaseError>
    readonly pruneCompletedEnvironmentCleanupIntent: (
      environmentId: EnvironmentId,
      generation: number,
    ) => Effect.Effect<void, MobileDatabaseError>
  }
>()('@t3tools/mobile/persistence/MobileDatabase')
{}

const makeAvailable = Effect.gen(function* ()
{
  const database = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async () =>
      {
        const SQLite = await import('expo-sqlite')
        return SQLite.openDatabaseAsync(DATABASE_NAME)
      },
      catch: databaseError('open'),
    }),
    (openDatabase) => Effect.promise(() => openDatabase.closeAsync()).pipe(Effect.ignore),
  )

  yield* Effect.tryPromise({
    try: async () =>
    {
      await database.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
      const schema = await database.getFirstAsync<{ readonly user_version: number }>(
        'PRAGMA user_version',
      )
      await database.withExclusiveTransactionAsync(async (transaction) =>
      {
        await transaction.execAsync(`
              CREATE TABLE IF NOT EXISTS client_cache (
                environment_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                cache_key TEXT NOT NULL,
                schema_version INTEGER NOT NULL,
                payload TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (environment_id, kind, cache_key)
              ) WITHOUT ROWID;

              CREATE INDEX IF NOT EXISTS client_cache_environment_updated
                ON client_cache (environment_id, updated_at DESC);

              CREATE TABLE IF NOT EXISTS client_preferences (
                singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
                payload TEXT NOT NULL,
                updated_at INTEGER NOT NULL
              );

              CREATE TABLE IF NOT EXISTS environment_cleanup_intents (
                environment_id TEXT PRIMARY KEY NOT NULL,
                schema_version INTEGER NOT NULL,
                generation INTEGER NOT NULL DEFAULT ${INITIAL_ENVIRONMENT_CLEANUP_GENERATION},
                requested_at_epoch_ms INTEGER NOT NULL,
                cache_state TEXT NOT NULL CHECK (cache_state IN ('pending', 'complete')),
                outbox_state TEXT NOT NULL CHECK (outbox_state IN ('pending', 'complete')),
                drafts_state TEXT NOT NULL CHECK (drafts_state IN ('pending', 'complete')),
                attempts INTEGER NOT NULL,
                next_attempt_at_epoch_ms INTEGER NOT NULL,
                last_attempt_at_epoch_ms INTEGER,
                last_error TEXT
              ) WITHOUT ROWID;
            `)
      })
      // a database created before the removal generation existed keeps its
      // table, so the column is added separately. SQLite has no "ADD COLUMN IF
      // NOT EXISTS", and the create above owns the shape of fresh databases.
      const cleanupColumns = await database.getAllAsync<{ readonly name: string }>(
        'PRAGMA table_info(environment_cleanup_intents)',
      )
      if (!cleanupColumns.some((column) => column.name === 'generation'))
      {
        await database.execAsync(
          `ALTER TABLE environment_cleanup_intents
             ADD COLUMN generation INTEGER NOT NULL DEFAULT ${INITIAL_ENVIRONMENT_CLEANUP_GENERATION};`,
        )
      }
      if ((schema?.user_version ?? 0) < DATABASE_SCHEMA_VERSION)
      {
        const migrated = await migrateLegacyFileCaches(database)
        if (migrated)
        {
          await database.execAsync(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION};`)
        }
      }
    },
    catch: databaseError('migrate'),
  })

  return MobileDatabase.of({
    loadCache: Effect.fn('MobileDatabase.loadCache')((environmentId, kind, cacheKey) =>
      Effect.tryPromise({
        try: () =>
          database.getFirstAsync<{ readonly payload: string }>(
            `SELECT payload
                     FROM client_cache
                     WHERE environment_id = ? AND kind = ? AND cache_key = ?`,
            environmentId,
            kind,
            cacheKey,
          ),
        catch: databaseError('load-cache'),
      }).pipe(Effect.map((row) => Option.fromNullishOr(row?.payload))),
    ),
    saveCache: Effect.fn('MobileDatabase.saveCache')(
      (environmentId, kind, cacheKey, schemaVersion, payload) =>
        Effect.tryPromise({
          try: () =>
            database.runAsync(
              `INSERT INTO client_cache
                      (environment_id, kind, cache_key, schema_version, payload, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?)
                     ON CONFLICT (environment_id, kind, cache_key) DO UPDATE SET
                       schema_version = excluded.schema_version,
                       payload = excluded.payload,
                       updated_at = excluded.updated_at`,
              environmentId,
              kind,
              cacheKey,
              schemaVersion,
              payload,
              Date.now(),
            ),
          catch: databaseError('save-cache'),
        }).pipe(Effect.asVoid),
    ),
    removeCache: Effect.fn('MobileDatabase.removeCache')((environmentId, kind, cacheKey) =>
      Effect.tryPromise({
        try: () =>
          database.runAsync(
            `DELETE FROM client_cache
                     WHERE environment_id = ? AND kind = ? AND cache_key = ?`,
            environmentId,
            kind,
            cacheKey,
          ),
        catch: databaseError('remove-cache'),
      }).pipe(Effect.asVoid),
    ),
    clearCacheKind: Effect.fn('MobileDatabase.clearCacheKind')((environmentId, kind) =>
      Effect.tryPromise({
        try: () =>
          database.runAsync(
            'DELETE FROM client_cache WHERE environment_id = ? AND kind = ?',
            environmentId,
            kind,
          ),
        catch: databaseError('clear-cache-kind'),
      }).pipe(Effect.asVoid),
    ),
    clearEnvironmentCache: Effect.fn('MobileDatabase.clearEnvironmentCache')((environmentId) =>
      Effect.tryPromise({
        try: () =>
          database.runAsync('DELETE FROM client_cache WHERE environment_id = ?', environmentId),
        catch: databaseError('clear-environment-cache'),
      }).pipe(Effect.asVoid),
    ),
    clearAllCaches: Effect.tryPromise({
      try: () => database.runAsync('DELETE FROM client_cache'),
      catch: databaseError('clear-all-caches'),
    }).pipe(Effect.asVoid),
    inspectCaches: Effect.tryPromise({
      try: () =>
        database.getAllAsync<unknown>(`
                SELECT
                  environment_id AS environmentId,
                  kind,
                  COUNT(*) AS recordCount,
                  COALESCE(SUM(LENGTH(CAST(payload AS BLOB))), 0) AS payloadBytes
                FROM client_cache
                GROUP BY environment_id, kind
                ORDER BY environment_id, kind
              `),
      catch: databaseError('inspect-caches'),
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ClientCacheSummaryRows)),
      Effect.mapError(databaseError('inspect-caches')),
      Effect.map((rows): ReadonlyArray<ClientCacheSummaryRow> =>
        rows.map((row) => ({
          environmentId: row.environmentId as EnvironmentId,
          kind: row.kind,
          recordCount: row.recordCount,
          payloadBytes: row.payloadBytes,
        })),
      ),
    ),
    loadPreferencesJson: Effect.tryPromise({
      try: () =>
        database.getFirstAsync<StoredPreferencesJson>(
          `SELECT payload, updated_at AS updatedAt
                 FROM client_preferences
                 WHERE singleton = 1`,
        ),
      catch: databaseError('load-preferences'),
    }).pipe(Effect.map(Option.fromNullishOr)),
    savePreferencesJson: Effect.fn('MobileDatabase.savePreferencesJson')((payload, updatedAt) =>
      Effect.tryPromise({
        try: () =>
          database.runAsync(
            `INSERT INTO client_preferences (singleton, payload, updated_at)
                   VALUES (1, ?, ?)
                   ON CONFLICT (singleton) DO UPDATE SET
                     payload = excluded.payload,
                     updated_at = excluded.updated_at`,
            payload,
            updatedAt,
          ),
        catch: databaseError('save-preferences'),
      }).pipe(Effect.asVoid),
    ),
    loadEnvironmentCleanupIntents: Effect.tryPromise({
      try: () =>
        database.getAllAsync<unknown>(`
          SELECT
            environment_id AS environmentId,
            schema_version AS schemaVersion,
            generation,
            requested_at_epoch_ms AS requestedAtEpochMs,
            cache_state AS cacheState,
            outbox_state AS outboxState,
            drafts_state AS draftsState,
            attempts,
            next_attempt_at_epoch_ms AS nextAttemptAtEpochMs,
            last_attempt_at_epoch_ms AS lastAttemptAtEpochMs,
            last_error AS lastError
          FROM environment_cleanup_intents
          ORDER BY requested_at_epoch_ms, environment_id
        `),
      catch: databaseError('load-environment-cleanup-intents'),
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(StoredEnvironmentCleanupIntents)),
      Effect.mapError(databaseError('load-environment-cleanup-intents')),
      Effect.map((intents) =>
        intents.map((intent) => ({
          ...intent,
          environmentId: intent.environmentId as EnvironmentId,
        })),
      ),
    ),
    // re-arms an existing row instead of leaving it as it stands: a row whose
    // prune failed is all-complete, and a later removal of the same environment
    // has to start a fresh generation with every resource pending again.
    prepareEnvironmentCleanup: Effect.fn('MobileDatabase.prepareEnvironmentCleanup')(
      (environmentId, requestedAtEpochMs) =>
        Effect.tryPromise({
          try: () =>
            database.getFirstAsync<{ readonly generation: number }>(
              `INSERT INTO environment_cleanup_intents
                (environment_id, schema_version, generation, requested_at_epoch_ms,
                 cache_state, outbox_state, drafts_state, attempts,
                 next_attempt_at_epoch_ms, last_attempt_at_epoch_ms, last_error)
               VALUES (?, ?, ${INITIAL_ENVIRONMENT_CLEANUP_GENERATION}, ?,
                       'pending', 'pending', 'pending', 0, ?, NULL, NULL)
               ON CONFLICT (environment_id) DO UPDATE SET
                 schema_version = excluded.schema_version,
                 generation = environment_cleanup_intents.generation + 1,
                 requested_at_epoch_ms = excluded.requested_at_epoch_ms,
                 cache_state = 'pending',
                 outbox_state = 'pending',
                 drafts_state = 'pending',
                 attempts = 0,
                 next_attempt_at_epoch_ms = excluded.next_attempt_at_epoch_ms,
                 last_attempt_at_epoch_ms = NULL,
                 last_error = NULL
               RETURNING generation`,
              environmentId,
              ENVIRONMENT_CLEANUP_SCHEMA_VERSION,
              requestedAtEpochMs,
              requestedAtEpochMs,
            ),
          catch: databaseError('prepare-environment-cleanup'),
        }).pipe(Effect.map((row) => row?.generation ?? INITIAL_ENVIRONMENT_CLEANUP_GENERATION)),
    ),
    markEnvironmentCleanupResourceComplete: Effect.fn(
      'MobileDatabase.markEnvironmentCleanupResourceComplete',
    )((environmentId, resource, generation) =>
    {
      const column = {
        cache: 'cache_state',
        outbox: 'outbox_state',
        drafts: 'drafts_state',
      } satisfies Record<EnvironmentOwnedDataResource, string>
      return Effect.tryPromise({
        try: () =>
          database.runAsync(
            `UPDATE environment_cleanup_intents SET ${column[resource]} = 'complete'
             WHERE environment_id = ? AND generation = ?`,
            environmentId,
            generation,
          ),
        catch: databaseError('mark-environment-cleanup-resource'),
      }).pipe(Effect.asVoid)
    }),
    recordEnvironmentCleanupAttempt: Effect.fn('MobileDatabase.recordEnvironmentCleanupAttempt')(
      (environmentId, generation, attempts, attemptedAtEpochMs, nextAttemptAtEpochMs, lastError) =>
        Effect.tryPromise({
          try: () =>
            database.runAsync(
              `UPDATE environment_cleanup_intents
             SET attempts = ?, last_attempt_at_epoch_ms = ?,
                 next_attempt_at_epoch_ms = ?, last_error = ?
             WHERE environment_id = ? AND generation = ?`,
              attempts,
              attemptedAtEpochMs,
              nextAttemptAtEpochMs,
              lastError,
              environmentId,
              generation,
            ),
          catch: databaseError('record-environment-cleanup-attempt'),
        }).pipe(Effect.asVoid),
    ),
    pruneCompletedEnvironmentCleanupIntent: Effect.fn(
      'MobileDatabase.pruneCompletedEnvironmentCleanupIntent',
    )((environmentId, generation) =>
      Effect.tryPromise({
        try: () =>
          database.runAsync(
            `DELETE FROM environment_cleanup_intents
             WHERE environment_id = ?
               AND generation = ?
               AND cache_state = 'complete'
               AND outbox_state = 'complete'
               AND drafts_state = 'complete'`,
            environmentId,
            generation,
          ),
        catch: databaseError('prune-environment-cleanup-intent'),
      }).pipe(Effect.asVoid),
    ),
  })
})

function makeUnavailable(error: MobileDatabaseError): MobileDatabase['Service']
{
  const fail = Effect.fail(error)
  return MobileDatabase.of({
    loadCache: () => fail,
    saveCache: () => fail,
    removeCache: () => fail,
    clearCacheKind: () => fail,
    clearEnvironmentCache: () => fail,
    clearAllCaches: fail,
    inspectCaches: fail,
    loadPreferencesJson: fail,
    savePreferencesJson: () => fail,
    loadEnvironmentCleanupIntents: fail,
    prepareEnvironmentCleanup: () => fail,
    markEnvironmentCleanupResourceComplete: () => fail,
    recordEnvironmentCleanupAttempt: () => fail,
    pruneCompletedEnvironmentCleanupIntent: () => fail,
  })
}

export const make = Effect.result(makeAvailable).pipe(
  Effect.map((result) =>
    result._tag === 'Success' ? result.success : makeUnavailable(result.failure),
  ),
)

export const layer = Layer.effect(MobileDatabase, make)
