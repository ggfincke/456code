// tests/apps/server/persistence/NodeSqliteClient.test.ts
// verify node sqlite client behavior

import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import * as SqliteClient from '../../../../apps/server/src/persistence/NodeSqliteClient.ts'

const layer = it.layer(SqliteClient.layerMemory())

layer('NodeSqliteClient', (it) =>
{
  it.effect('returns a typed failure when an unprepared statement cannot be prepared', () =>
    Effect.gen(function* ()
    {
      const sql = yield* SqlClient.SqlClient
      const error = yield* Effect.flip(sql.unsafe('SELECT FROM').unprepared)

      assert.equal(error._tag, 'SqlError')
      assert.equal(error.reason.operation, 'prepare')
    }),
  )
})

it.effect('returns a typed failure when the database cannot be opened', () =>
  Effect.gen(function* ()
  {
    const error = yield* Effect.flip(
      Layer.build(SqliteClient.layer({ filename: '\0' })).pipe(Effect.scoped),
    )

    assert.equal(error._tag, 'SqlError')
    assert.equal(error.reason.operation, 'open')
  }),
)
