// tests/apps/server/recovery/RuntimeRecoveryAuditPersistence.test.ts
// verifies recovery audit history survives a real sqlite layer restart

import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { RuntimeRecoveryPersistenceLive } from '../../../../apps/server/src/persistence/Layers/RuntimeRecovery.ts'
import { makeSqlitePersistenceLive } from '../../../../apps/server/src/persistence/Layers/Sqlite.ts'
import { RuntimeRecoveryPersistence } from '../../../../apps/server/src/persistence/Services/RuntimeRecovery.ts'
import { makeTestServerStorageLeaseLayer } from '../support/serverStorageLease.ts'

const originalAt = '2026-08-09T00:00:00.000Z'
const recoveredAt = '2026-08-09T00:01:00.000Z'

it.effect('persists audit history across a disk-backed runtime restart', () =>
  Effect.gen(function* ()
  {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: 'runtime-recovery-audit-' })
    const dbPath = path.join(baseDir, 'state.sqlite')
    const makeDiskLayer = () =>
      RuntimeRecoveryPersistenceLive.pipe(
        Layer.provideMerge(
          makeSqlitePersistenceLive(dbPath).pipe(
            Layer.provideMerge(makeTestServerStorageLeaseLayer(baseDir)),
          ),
        ),
      )

    yield* Effect.gen(function* ()
    {
      const sql = yield* SqlClient.SqlClient
      const recovery = yield* RuntimeRecoveryPersistence
      yield* sql`
        INSERT INTO orchestration_reactor_progress (
          reactor_id,
          operation_version,
          mode,
          cursor_sequence,
          shadow_cursor_sequence,
          blocked_sequence,
          updated_at
        )
        VALUES ('architecture-auto-analysis', 1, 'durable', 0, 0, 1, ${originalAt})
      `
      yield* sql`
        INSERT INTO orchestration_reactor_actions (
          action_id,
          reactor_id,
          source_sequence,
          source_event_id,
          output_index,
          effect_kind,
          target_kind,
          target_id,
          operation_version,
          payload_json,
          status,
          available_at,
          created_at,
          updated_at
        )
        VALUES (
          'disk-action',
          'architecture-auto-analysis',
          1,
          'disk-event',
          0,
          'architecture.diff-analysis.request',
          'thread-turn-checkpoint',
          'disk-target',
          1,
          '{}',
          'manual',
          ${originalAt},
          ${originalAt},
          ${originalAt}
        )
      `
      yield* recovery.recoverReactorAction({
        actionId: 'disk-action',
        expectedReactorId: 'architecture-auto-analysis',
        expectedEffectKind: 'architecture.diff-analysis.request',
        expectedOperationVersion: 1,
        expectedStatus: 'manual',
        expectedUpdatedAt: originalAt,
        action: 'retry',
        actor: { sessionId: 'disk-session', subject: 'disk-operator' },
        reason: 'restart persistence proof',
        auditId: 'disk-audit',
        now: recoveredAt,
      })
    }).pipe(Effect.provide(makeDiskLayer()))

    const audits = yield* Effect.gen(function* ()
    {
      const recovery = yield* RuntimeRecoveryPersistence
      return yield* recovery.listAudit({
        subjectKind: 'reactor-action',
        subjectId: 'disk-action',
        limit: 100,
      })
    }).pipe(Effect.provide(makeDiskLayer()))

    assert.equal(audits.length, 1)
    assert.equal(audits[0]?.auditId, 'disk-audit')
    assert.equal(audits[0]?.reason, 'restart persistence proof')
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)
