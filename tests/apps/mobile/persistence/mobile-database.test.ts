// tests/apps/mobile/persistence/mobile-database.test.ts
// verifies mobile sqlite migrations and cleanup-intent persistence

import { describe, expect, it } from '@effect/vitest'
import { EnvironmentId } from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import { vi } from 'vite-plus/test'

const openDatabaseAsync = vi.hoisted(() => vi.fn())

vi.mock('expo-sqlite', () => ({ openDatabaseAsync }))

import {
  decodeLegacyCacheRecord,
  make,
} from '../../../../apps/mobile/src/persistence/mobile-database'

interface CleanupRow
{
  environmentId: string
  schemaVersion: number
  generation: number
  requestedAtEpochMs: number
  cacheState: 'pending' | 'complete'
  outboxState: 'pending' | 'complete'
  draftsState: 'pending' | 'complete'
  attempts: number
  nextAttemptAtEpochMs: number
  lastAttemptAtEpochMs: number | null
  lastError: string | null
}

function fakeDatabase()
{
  const rows = new Map<string, CleanupRow>()
  const migrations: Array<string> = []
  const database = {
    closeAsync: async () => undefined,
    execAsync: async (sql: string) =>
    {
      migrations.push(sql)
    },
    getFirstAsync: async (sql: string, ...params: ReadonlyArray<unknown>) =>
    {
      if (sql.includes('PRAGMA user_version'))
      {
        return { user_version: 2 }
      }
      if (sql.includes('INSERT INTO environment_cleanup_intents'))
      {
        const environmentId = String(params[0])
        const generation = (rows.get(environmentId)?.generation ?? 0) + 1
        rows.set(environmentId, {
          environmentId,
          schemaVersion: Number(params[1]),
          generation,
          requestedAtEpochMs: Number(params[2]),
          cacheState: 'pending',
          outboxState: 'pending',
          draftsState: 'pending',
          attempts: 0,
          nextAttemptAtEpochMs: Number(params[3]),
          lastAttemptAtEpochMs: null,
          lastError: null,
        })
        return { generation }
      }
      return null
    },
    getAllAsync: async (sql: string) =>
    {
      if (sql.includes('PRAGMA table_info'))
      {
        return [{ name: 'generation' }]
      }
      return sql.includes('environment_cleanup_intents') ? [...rows.values()] : []
    },
    withExclusiveTransactionAsync: async (
      run: (transaction: { execAsync: (sql: string) => Promise<void> }) => Promise<void>,
    ) => run({ execAsync: database.execAsync }),
    runAsync: async (sql: string, ...params: ReadonlyArray<unknown>) =>
    {
      if (sql.includes("SET cache_state = 'complete'"))
      {
        const row = matchingRow(params[0], params[1])
        if (row) rows.set(row.environmentId, { ...row, cacheState: 'complete' })
      }
      else if (sql.includes("SET outbox_state = 'complete'"))
      {
        const row = matchingRow(params[0], params[1])
        if (row) rows.set(row.environmentId, { ...row, outboxState: 'complete' })
      }
      else if (sql.includes("SET drafts_state = 'complete'"))
      {
        const row = matchingRow(params[0], params[1])
        if (row) rows.set(row.environmentId, { ...row, draftsState: 'complete' })
      }
      else if (sql.includes('SET attempts = ?'))
      {
        const row = matchingRow(params[4], params[5])
        if (row)
        {
          rows.set(row.environmentId, {
            ...row,
            attempts: Number(params[0]),
            lastAttemptAtEpochMs: Number(params[1]),
            nextAttemptAtEpochMs: Number(params[2]),
            lastError: params[3] === null ? null : String(params[3]),
          })
        }
      }
      else if (sql.includes('DELETE FROM environment_cleanup_intents'))
      {
        const row = matchingRow(params[0], params[1])
        if (
          row?.cacheState === 'complete' &&
          row.outboxState === 'complete' &&
          row.draftsState === 'complete'
        )
        {
          rows.delete(row.environmentId)
        }
      }
      return { changes: 1 }
    },
  }
  // the cleanup statements are all scoped to one environment and one removal
  // generation; a stale generation matches nothing.
  function matchingRow(environmentId: unknown, generation: unknown): CleanupRow | undefined
  {
    const row = rows.get(String(environmentId))
    return row?.generation === Number(generation) ? row : undefined
  }
  return { database, migrations, rows }
}

describe('mobile database', () =>
{
  it.effect('keeps acquisition failures typed on database operations', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        openDatabaseAsync.mockRejectedValueOnce(new Error('SQLite unavailable'))

        const database = yield* make
        const result = yield* Effect.result(database.loadPreferencesJson)
        const cleanupResult = yield* Effect.result(
          database.prepareEnvironmentCleanup(EnvironmentId.make('environment-1'), 1_000),
        )

        expect(result).toMatchObject({
          _tag: 'Failure',
          failure: { _tag: 'MobileDatabaseError', operation: 'open' },
        })
        expect(cleanupResult).toMatchObject({
          _tag: 'Failure',
          failure: { _tag: 'MobileDatabaseError', operation: 'open' },
        })
      }),
    ),
  )

  it('maps legacy thread records to their SQLite identity', () =>
  {
    const payload = JSON.stringify({
      schemaVersion: 2,
      environmentId: 'environment-1',
      threadId: 'thread-1',
      snapshot: {},
    })

    expect(decodeLegacyCacheRecord('connection-thread-snapshots', payload)).toEqual({
      environmentId: 'environment-1',
      kind: 'thread',
      cacheKey: 'thread-1',
      schemaVersion: 2,
      payload,
    })
  })

  it('preserves the old shell payload for schema decoding after migration', () =>
  {
    const payload = JSON.stringify({
      schemaVersion: 1,
      environmentId: 'environment-1',
      snapshotReceivedAt: '2026-07-01T00:00:00.000Z',
      snapshot: {},
    })

    expect(decodeLegacyCacheRecord('shell-snapshots', payload)).toEqual({
      environmentId: 'environment-1',
      kind: 'shell',
      cacheKey: 'snapshot',
      schemaVersion: 1,
      payload,
    })
  })

  it('skips malformed legacy records', () =>
  {
    expect(decodeLegacyCacheRecord('connection-vcs-refs', '{not-json')).toBeNull()
    expect(
      decodeLegacyCacheRecord(
        'connection-vcs-refs',
        JSON.stringify({ schemaVersion: 1, environmentId: 'environment-1' }),
      ),
    ).toBeNull()
  })

  it.effect('creates the cleanup-intent table in the exclusive migration', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const fake = fakeDatabase()
        openDatabaseAsync.mockResolvedValueOnce(fake.database)

        yield* make

        expect(fake.migrations.join('\n')).toContain(
          'CREATE TABLE IF NOT EXISTS environment_cleanup_intents',
        )
      }),
    ),
  )

  it.effect('round-trips cleanup intent state and prunes only after all resources complete', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const fake = fakeDatabase()
        openDatabaseAsync.mockResolvedValueOnce(fake.database)
        const database = yield* make
        const environmentId = EnvironmentId.make('environment-1')

        const generation = yield* database.prepareEnvironmentCleanup(environmentId, 1_000)
        expect(generation).toBe(1)
        yield* database.markEnvironmentCleanupResourceComplete(environmentId, 'cache', generation)
        yield* database.pruneCompletedEnvironmentCleanupIntent(environmentId, generation)
        expect(yield* database.loadEnvironmentCleanupIntents).toEqual([
          {
            environmentId,
            schemaVersion: 2,
            generation: 1,
            requestedAtEpochMs: 1_000,
            cacheState: 'complete',
            outboxState: 'pending',
            draftsState: 'pending',
            attempts: 0,
            nextAttemptAtEpochMs: 1_000,
            lastAttemptAtEpochMs: null,
            lastError: null,
          },
        ])

        yield* database.markEnvironmentCleanupResourceComplete(environmentId, 'outbox', generation)
        yield* database.recordEnvironmentCleanupAttempt(
          environmentId,
          generation,
          1,
          2_000,
          62_000,
          'draft write failed',
        )
        expect((yield* database.loadEnvironmentCleanupIntents)[0]).toMatchObject({
          attempts: 1,
          lastAttemptAtEpochMs: 2_000,
          nextAttemptAtEpochMs: 62_000,
          lastError: 'draft write failed',
        })
        // a completion from the previous removal cannot finish this one
        yield* database.markEnvironmentCleanupResourceComplete(
          environmentId,
          'drafts',
          generation - 1,
        )
        expect((yield* database.loadEnvironmentCleanupIntents)[0]?.draftsState).toBe('pending')
        yield* database.markEnvironmentCleanupResourceComplete(environmentId, 'drafts', generation)

        // the prune never landed, so the all-complete row outlived its removal:
        // a later removal of the same environment re-arms it as a new generation
        const rearmed = yield* database.prepareEnvironmentCleanup(environmentId, 3_000)
        expect(rearmed).toBe(generation + 1)
        expect(yield* database.loadEnvironmentCleanupIntents).toMatchObject([
          {
            generation: rearmed,
            requestedAtEpochMs: 3_000,
            cacheState: 'pending',
            outboxState: 'pending',
            draftsState: 'pending',
            attempts: 0,
            nextAttemptAtEpochMs: 3_000,
            lastError: null,
          },
        ])

        for (const resource of ['cache', 'outbox', 'drafts'] as const)
        {
          yield* database.markEnvironmentCleanupResourceComplete(environmentId, resource, rearmed)
        }
        yield* database.pruneCompletedEnvironmentCleanupIntent(environmentId, rearmed)
        expect(yield* database.loadEnvironmentCleanupIntents).toEqual([])
      }),
    ),
  )

  it.effect('isolates cleanup rows by exact primary key', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const fake = fakeDatabase()
        openDatabaseAsync.mockResolvedValueOnce(fake.database)
        const database = yield* make
        const first = EnvironmentId.make('environment-1')
        const tenth = EnvironmentId.make('environment-10')

        const firstGeneration = yield* database.prepareEnvironmentCleanup(first, 1_000)
        yield* database.prepareEnvironmentCleanup(tenth, 2_000)
        yield* database.markEnvironmentCleanupResourceComplete(first, 'cache', firstGeneration)

        expect(fake.rows.get(first)?.cacheState).toBe('complete')
        expect(fake.rows.get(tenth)?.cacheState).toBe('pending')
      }),
    ),
  )
})
