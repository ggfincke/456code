// tests/apps/server/persistence/Errors.test.ts
// verify errors behavior

import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import { classifySqliteError, SqlError } from 'effect/unstable/sql/SqlError'

import * as NodeSqliteClient from '../../../../apps/server/src/persistence/NodeSqliteClient.ts'
import {
  PersistenceDecodeError,
  PersistenceSqlError,
  toPersistenceSqlError,
  toPersistenceSqlOrDecodeError,
} from '../../../../apps/server/src/persistence/Errors.ts'

const decodeRuntimePayload = Schema.decodeUnknownEffect(
  Schema.Struct({
    runtimePayload: Schema.Struct({
      attempt: Schema.Number,
    }),
  }),
)

it('keeps SQL operation context without a tautological detail', () =>
{
  const error = new PersistenceSqlError({
    operation: 'AuthSessionRepository.list:query',
    cause: new Error('database unavailable'),
  })

  assert.equal(error.detail, undefined)
  assert.equal(error.message, 'SQL error in AuthSessionRepository.list:query')
})

it.effect('names a real SQLite condition without copying query data', () =>
  Effect.gen(function* ()
  {
    const sql = yield* SqlClient.SqlClient
    const payload = 'sql-private-sentinel'
    yield* sql`CREATE TABLE error_test (private_column TEXT PRIMARY KEY)`
    yield* sql`INSERT INTO error_test VALUES (${payload})`
    const cause = yield* Effect.flip(sql`INSERT INTO error_test VALUES (${payload})`)
    const error = toPersistenceSqlError('OrchestrationCommandReceiptRepository.upsert:query', {
      threadId: 'thread-sql-condition',
    })(cause)

    assert.equal(error.detail, 'SQLITE(1555) constraint failed')
    assert.deepStrictEqual(error.correlation, { threadId: 'thread-sql-condition' })
    assert.equal(error.cause, cause)
    assert.notInclude(error.message, payload)
    assert.notInclude(error.message, 'private_column')
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
)

it('reads the condition through a wrapping driver error', () =>
{
  const driver = Object.assign(new Error('locked'), {
    errcode: 5,
    errstr: 'database is locked',
  })
  const error = toPersistenceSqlError('AuthSessionRepository.list:query')(
    new Error('Failed to prepare statement', { cause: driver }),
  )

  assert.equal(error.detail, 'SQLITE(5) database is locked')
})

it.each([{ errno: 1555, code: 'SQLITE_CONSTRAINT_PRIMARYKEY' }, { errno: 1 }])(
  'names Bun SQLite condition $errno through the SQL error wrapper',
  (condition) =>
  {
    const driver = Object.assign(new Error('bun-sql-private-sentinel'), {
      name: 'SQLiteError',
      ...condition,
    })
    const cause = new SqlError({ reason: classifySqliteError(driver) })
    const error = toPersistenceSqlError('AuthSessionRepository.create:query')(cause)

    assert.equal(
      error.message,
      `SQL error in AuthSessionRepository.create:query: SQLITE(${condition.errno})`,
    )
    assert.equal(error.cause, cause)
  },
)

it.each([
  new Error('unhelpful'),
  Object.assign(new Error('file not found'), { errno: -2, code: 'ENOENT' }),
])('omits a detail for a cause it cannot categorize (%#)', (cause) =>
{
  const error = toPersistenceSqlError('AuthSessionRepository.list:query')(cause)

  assert.equal(error.detail, undefined)
  assert.equal(error.message, 'SQL error in AuthSessionRepository.list:query')
})

it.effect('summarizes a schema cause by issue tag instead of by rejected value', () =>
  Effect.gen(function* ()
  {
    const rejectedPayload = 'sql-mapper-secret-sentinel'
    const cause = yield* Effect.flip(
      decodeRuntimePayload({ runtimePayload: { attempt: rejectedPayload } }),
    )
    const error = toPersistenceSqlError('ProviderSessionRuntimeRepository.list:query')(cause)

    assert.ok(error.detail !== undefined)
    assert.include(error.detail, 'InvalidType')
    assert.notInclude(error.message, rejectedPayload)
  }),
)

it('preserves correlation through the unified SQL mapper', () =>
{
  const driver = Object.assign(new Error('private driver detail'), {
    errcode: 5,
    errstr: 'database is locked',
  })
  const cause = new Error('wrapper detail', { cause: driver })
  const error = toPersistenceSqlOrDecodeError(
    'ProviderSessionRuntimeRepository.upsert:query',
    'ProviderSessionRuntimeRepository.upsert:decodeRows',
    { threadId: 'thread-correlated-condition' },
  )(cause)

  assert.instanceOf(error, PersistenceSqlError)
  assert.equal(error.detail, 'SQLITE(5) database is locked')
  assert.deepStrictEqual(error.correlation, { threadId: 'thread-correlated-condition' })
  assert.equal(error.cause, cause)
  assert.notInclude(error.message, 'private driver detail')
  assert.notInclude(error.message, 'wrapper detail')
})

it.effect('maps schema errors without copying rejected payloads into diagnostics', () =>
  Effect.gen(function* ()
  {
    const rejectedPayload = 'runtime-payload-secret-sentinel'
    const cause = yield* Effect.flip(
      decodeRuntimePayload({
        runtimePayload: {
          attempt: rejectedPayload,
        },
      }),
    )
    const error = PersistenceDecodeError.fromSchemaError(
      'ProviderSessionRuntimeRepository.list:decodeRows',
      cause,
    )

    assert.equal(error.operation, 'ProviderSessionRuntimeRepository.list:decodeRows')
    assert.equal(error.cause, cause)
    assert.notInclude(error.issue, rejectedPayload)
    assert.notInclude(error.message, rejectedPayload)
    assert.include(error.issue, 'InvalidType')
  }),
)
