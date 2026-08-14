// tests/apps/server/recovery/RuntimeRecoveryAdmin.test.ts
// verifies allowlisted redaction and fail-closed effect recovery policy

import {
  RuntimeRecoveryCheckpointListResult,
  RuntimeRecoveryPageCursor,
  RuntimeRecoveryReactorDetail,
  RuntimeRecoveryReactorListResult,
} from '@t3tools/contracts'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { RuntimeRecoveryPersistenceLive } from '../../../../apps/server/src/persistence/Layers/RuntimeRecovery.ts'
import { SqlitePersistenceMemory } from '../../../../apps/server/src/persistence/Layers/Sqlite.ts'
import { RuntimeRecoveryPersistence } from '../../../../apps/server/src/persistence/Services/RuntimeRecovery.ts'
import {
  RuntimeRecoveryAdmin,
  RuntimeRecoveryAdminLive,
} from '../../../../apps/server/src/recovery/RuntimeRecoveryAdmin.ts'
import { RuntimeRecoveryPolicyRegistryLive } from '../../../../apps/server/src/recovery/RuntimeRecoveryPolicy.ts'

const infrastructureLayer = Layer.mergeAll(
  RuntimeRecoveryPersistenceLive,
  RuntimeRecoveryPolicyRegistryLive,
).pipe(Layer.provideMerge(SqlitePersistenceMemory))
const recoveryLayer = Layer.mergeAll(
  infrastructureLayer,
  RuntimeRecoveryAdminLive.pipe(Layer.provide(infrastructureLayer)),
)
const layer = it.layer(recoveryLayer)

const originalAt = '2026-08-09T00:00:00.000Z'
const encodeReactorList = Schema.encodeSync(Schema.fromJsonString(RuntimeRecoveryReactorListResult))
const encodeCheckpointList = Schema.encodeSync(
  Schema.fromJsonString(RuntimeRecoveryCheckpointListResult),
)
const encodeReactorDetail = Schema.encodeSync(Schema.fromJsonString(RuntimeRecoveryReactorDetail))

const insertProgress = (
  sql: SqlClient.SqlClient,
  reactorId: string,
  blockedSequence: number,
) => sql`
  INSERT OR IGNORE INTO orchestration_reactor_progress (
    reactor_id,
    operation_version,
    mode,
    cursor_sequence,
    shadow_cursor_sequence,
    blocked_sequence,
    updated_at
  )
  VALUES (${reactorId}, 1, 'durable', 0, 0, ${blockedSequence}, ${originalAt})
`

const insertBlockedAction = (
  sql: SqlClient.SqlClient,
  input: {
    readonly actionId: string
    readonly reactorId: string
    readonly sourceSequence: number
    readonly effectKind: string
    readonly operationVersion?: number
    readonly status: 'manual' | 'unknown'
  },
) => sql`
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
    outcome_json,
    last_error,
    created_at,
    updated_at
  )
  VALUES (
    ${input.actionId},
    ${input.reactorId},
    ${input.sourceSequence},
    ${`event-${input.actionId}`},
    0,
    ${input.effectKind},
    'thread-turn-checkpoint',
    ${`target-${input.actionId}`},
    ${input.operationVersion ?? 1},
    '{"credential":"payload-secret","prompt":"private prompt"}',
    ${input.status},
    ${originalAt},
    '{"provider":"outcome-secret"}',
    'raw-error-secret',
    ${originalAt},
    ${originalAt}
  )
`

layer('RuntimeRecoveryAdmin', (it) =>
{
  it.effect(
    'redacts diagnostics and leaves undefined effects and manual checkpoints read-only',
    () =>
      Effect.gen(function* ()
      {
        const sql = yield* SqlClient.SqlClient
        const admin = yield* RuntimeRecoveryAdmin
        const persistence = yield* RuntimeRecoveryPersistence
        yield* insertProgress(sql, 'architecture-auto-analysis', 1)
        yield* insertProgress(sql, 'provider-command', 5)
        yield* insertProgress(sql, 'provider-runtime-ingestion', 9)
        yield* insertBlockedAction(sql, {
          actionId: 'architecture-manual',
          reactorId: 'architecture-auto-analysis',
          sourceSequence: 1,
          effectKind: 'architecture.diff-analysis.request',
          status: 'manual',
        })
        yield* insertBlockedAction(sql, {
          actionId: 'provider-unknown',
          reactorId: 'provider-command',
          sourceSequence: 5,
          effectKind: 'thread.turn-start-requested',
          status: 'unknown',
        })
        yield* insertBlockedAction(sql, {
          actionId: 'provider-runtime-unknown',
          reactorId: 'provider-runtime-ingestion',
          sourceSequence: 9,
          effectKind: 'provider.runtime-event.consume',
          status: 'unknown',
        })
        yield* insertBlockedAction(sql, {
          actionId: 'architecture-wrong-reactor',
          reactorId: 'provider-command',
          sourceSequence: 6,
          effectKind: 'architecture.diff-analysis.request',
          status: 'manual',
        })
        yield* insertBlockedAction(sql, {
          actionId: 'architecture-wrong-version',
          reactorId: 'architecture-auto-analysis',
          sourceSequence: 2,
          effectKind: 'architecture.diff-analysis.request',
          operationVersion: 2,
          status: 'manual',
        })
        yield* sql`
        INSERT INTO checkpoint_revert_operations (
          operation_id,
          thread_id,
          target_ref,
          target_turn_count,
          request_source_sequence,
          provider_inbox_high_water,
          cwd,
          checkpoint_capture_root,
          repository_common_dir,
          checkpoint_commit_oid,
          phase,
          attempt_count,
          last_error,
          provider_outcome,
          provider_outcome_json,
          manual_resume_phase,
          created_at,
          updated_at
        )
        VALUES (
          'checkpoint-manual',
          'thread-checkpoint',
          'refs/t3/checkpoint/4',
          4,
          40,
          8,
          '/secret/workspace/path',
          '/secret/capture/root',
          '/secret/repository/common-dir',
          '0123456789abcdef0123456789abcdef01234567',
          'manual-required',
          2,
          'checkpoint-error-secret',
          'manual-unknown',
          '{"provider":"checkpoint-outcome-secret"}',
          'provider-outcome-recorded',
          ${originalAt},
          ${originalAt}
        )
      `
        yield* sql`
          INSERT INTO checkpoint_revert_operations (
            operation_id,
            thread_id,
            target_ref,
            target_turn_count,
            request_source_sequence,
            provider_inbox_high_water,
            cwd,
            phase,
            manual_resume_phase,
            created_at,
            updated_at
          )
          VALUES (
            'checkpoint-legacy',
            'thread-legacy',
            'refs/t3/checkpoint/0',
            0,
            41,
            8,
            '/secret/legacy/path',
            'manual-required',
            NULL,
            ${originalAt},
            ${originalAt}
          )
        `
        yield* sql`
          INSERT INTO checkpoint_revert_operations (
            operation_id,
            thread_id,
            target_ref,
            target_turn_count,
            request_source_sequence,
            provider_inbox_high_water,
            phase,
            created_at,
            updated_at
          )
          VALUES (
            'checkpoint-requested',
            'thread-requested',
            'refs/t3/checkpoint/1',
            1,
            42,
            8,
            'requested',
            ${originalAt},
            ${originalAt}
          )
        `

        const reactorList = yield* admin.listReactorActions()
        const architecture = reactorList.items.find(
          (item) => item.actionId === 'architecture-manual',
        )
        const provider = reactorList.items.find((item) => item.actionId === 'provider-unknown')
        const providerRuntime = reactorList.items.find(
          (item) => item.actionId === 'provider-runtime-unknown',
        )
        const wrongReactor = reactorList.items.find(
          (item) => item.actionId === 'architecture-wrong-reactor',
        )
        const wrongVersion = reactorList.items.find(
          (item) => item.actionId === 'architecture-wrong-version',
        )
        assert.deepStrictEqual(
          architecture?.allowedActions.map((candidate) => candidate.action),
          ['retry'],
        )
        assert.deepStrictEqual(provider?.allowedActions, [])
        assert.deepStrictEqual(providerRuntime?.allowedActions, [])
        assert.include(providerRuntime?.summary ?? '', 'durable provider runtime event consumer')
        assert.deepStrictEqual(wrongReactor?.allowedActions, [])
        assert.deepStrictEqual(wrongVersion?.allowedActions, [])
        const encodedReactors = encodeReactorList(reactorList)
        for (const secret of [
          'payload-secret',
          'private prompt',
          'outcome-secret',
          'raw-error-secret',
          'payloadJson',
          'outcomeJson',
          'lastError',
        ])
        {
          assert.notInclude(encodedReactors, secret)
        }

        const checkpoints = yield* admin.listCheckpointReverts()
        assert.equal(checkpoints.items.length, 3)
        const recordedCheckpoint = checkpoints.items.find(
          (item) => item.operationId === 'checkpoint-manual',
        )
        const legacyCheckpoint = checkpoints.items.find(
          (item) => item.operationId === 'checkpoint-legacy',
        )
        const requestedCheckpoint = checkpoints.items.find(
          (item) => item.operationId === 'checkpoint-requested',
        )
        assert.deepStrictEqual(recordedCheckpoint?.allowedActions, [])
        assert.deepStrictEqual(recordedCheckpoint?.identityEvidence, {
          captureRoot: 'present',
          repositoryCommonDir: 'present',
          commitOid: 'present',
        })
        assert.isNull(legacyCheckpoint?.manualResumePhase)
        assert.deepStrictEqual(legacyCheckpoint?.identityEvidence, {
          captureRoot: 'missing',
          repositoryCommonDir: 'missing',
          commitOid: 'missing',
        })
        assert.deepStrictEqual(legacyCheckpoint?.allowedActions, [])
        assert.equal(requestedCheckpoint?.phase, 'requested')
        assert.include(requestedCheckpoint?.summary ?? '', 'awaiting owner replay')
        assert.deepStrictEqual(requestedCheckpoint?.allowedActions, [])
        const encodedCheckpoints = encodeCheckpointList(checkpoints)
        for (const secret of [
          '/secret/workspace/path',
          '/secret/legacy/path',
          '/secret/capture/root',
          '/secret/repository/common-dir',
          '0123456789abcdef0123456789abcdef01234567',
          'checkpoint-error-secret',
          'checkpoint-outcome-secret',
        ])
        {
          assert.notInclude(encodedCheckpoints, secret)
        }

        const denied = yield* admin
          .recoverReactorAction({
            actionId: 'provider-unknown',
            mutation: {
              action: 'retry',
              expectedStatus: 'unknown',
              expectedUpdatedAt: originalAt,
              confirmation: 'retry-owner-declared-idempotent',
              reason: 'operator guessed',
            },
            actor: { sessionId: 'recovery-session', subject: 'recovery-operator' },
          })
          .pipe(Effect.flip)
        assert.equal(denied._tag, 'RuntimeRecoveryPolicyDeniedError')
        if (denied._tag === 'RuntimeRecoveryPolicyDeniedError')
        {
          assert.equal(denied.reason, 'effect-not-declared')
        }
        assert.deepStrictEqual(
          yield* persistence.listAudit({
            subjectKind: 'reactor-action',
            subjectId: 'provider-unknown',
            limit: 100,
          }),
          [],
        )

        for (const actionId of ['architecture-wrong-reactor', 'architecture-wrong-version'])
        {
          const identityDenied = yield* admin
            .recoverReactorAction({
              actionId,
              mutation: {
                action: 'retry',
                expectedStatus: 'manual',
                expectedUpdatedAt: originalAt,
                confirmation: 'retry-owner-declared-idempotent',
                reason: 'must not inherit another owner policy',
              },
              actor: { sessionId: 'recovery-session', subject: 'recovery-operator' },
            })
            .pipe(Effect.flip)
          assert.equal(identityDenied._tag, 'RuntimeRecoveryPolicyDeniedError')
        }
      }),
  )

  it.effect('allows the declared architecture retry and returns its immutable audit', () =>
    Effect.gen(function* ()
    {
      const sql = yield* SqlClient.SqlClient
      const admin = yield* RuntimeRecoveryAdmin
      yield* insertProgress(sql, 'architecture-auto-analysis', 1)
      yield* insertBlockedAction(sql, {
        actionId: 'architecture-retry',
        reactorId: 'architecture-auto-analysis',
        sourceSequence: 1,
        effectKind: 'architecture.diff-analysis.request',
        status: 'manual',
      })

      const detail = yield* admin.recoverReactorAction({
        actionId: 'architecture-retry',
        mutation: {
          action: 'retry',
          expectedStatus: 'manual',
          expectedUpdatedAt: originalAt,
          confirmation: 'retry-owner-declared-idempotent',
          reason: 'transient dependency repaired',
        },
        actor: { sessionId: 'recovery-session', subject: 'recovery-operator' },
      })

      assert.equal(detail.diagnostic.status, 'pending')
      assert.equal(detail.diagnostic.operationVersion, 1)
      assert.deepStrictEqual(detail.diagnostic.allowedActions, [])
      assert.equal(detail.audits.length, 1)
      assert.isFalse(detail.auditsTruncated)
      assert.match(detail.audits[0]?.actorSessionDigest ?? '', /^sha256:[a-f0-9]{64}$/)
      assert.match(detail.audits[0]?.actorSubjectDigest ?? '', /^sha256:[a-f0-9]{64}$/)
      assert.equal(detail.audits[0]?.reactorId, 'architecture-auto-analysis')
      assert.equal(detail.audits[0]?.operationVersion, 1)
      assert.equal(detail.audits[0]?.action, 'retry')
      assert.match(detail.audits[0]?.reasonDigest ?? '', /^sha256:[a-f0-9]{64}$/)
      const encoded = encodeReactorDetail(detail)
      for (const secret of [
        'recovery-session',
        'recovery-operator',
        'transient dependency repaired',
      ])
      {
        assert.notInclude(encoded, secret)
      }

      const reread = yield* admin.getReactorAction('architecture-retry')
      assert.equal(reread.diagnostic.status, 'pending')
      assert.equal(reread.audits.length, 1)

      yield* sql`
        UPDATE orchestration_reactor_actions
        SET status = 'succeeded', updated_at = '2026-08-09T00:02:00.000Z'
        WHERE action_id = 'architecture-retry'
      `
      const completed = yield* admin.getReactorAction('architecture-retry')
      assert.equal(completed.diagnostic.status, 'succeeded')
      assert.include(completed.diagnostic.summary, 'audited retry')
      assert.include(encodeReactorDetail(completed), 'succeeded')

      yield* insertBlockedAction(sql, {
        actionId: 'unrelated-completed',
        reactorId: 'architecture-auto-analysis',
        sourceSequence: 2,
        effectKind: 'architecture.diff-analysis.request',
        status: 'manual',
      })
      yield* sql`
        UPDATE orchestration_reactor_actions
        SET status = 'succeeded', updated_at = '2026-08-09T00:02:00.000Z'
        WHERE action_id = 'unrelated-completed'
      `
      const unrelated = yield* admin.getReactorAction('unrelated-completed').pipe(Effect.flip)
      assert.equal(unrelated._tag, 'RuntimeRecoveryAdminNotFoundError')
    }),
  )

  it.effect(
    'pages identical-timestamp action and checkpoint blockers without duplicates or gaps',
    () =>
      Effect.gen(function* ()
      {
        const sql = yield* SqlClient.SqlClient
        const admin = yield* RuntimeRecoveryAdmin
        yield* sql`
        UPDATE orchestration_reactor_actions
        SET status = 'resolved'
        WHERE status IN ('unknown', 'poison', 'manual')
      `
        yield* sql`
        UPDATE checkpoint_revert_operations
        SET phase = CASE phase WHEN 'requested' THEN 'aborted' ELSE 'completed' END
        WHERE phase IN ('requested', 'manual-required')
      `
        yield* insertProgress(sql, 'pagination-reactor', 1)

        const expectedActionIds: string[] = []
        const expectedOperationIds: string[] = []
        for (let index = 0; index < 101; index += 1)
        {
          const suffix = String(index).padStart(3, '0')
          const actionId = `page-action-${suffix}`
          const operationId = `page-checkpoint-${suffix}`
          expectedActionIds.push(actionId)
          expectedOperationIds.push(operationId)
          yield* insertBlockedAction(sql, {
            actionId,
            reactorId: 'pagination-reactor',
            sourceSequence: 1,
            effectKind: 'pagination.effect',
            status: 'manual',
          })
          yield* sql`
          INSERT INTO checkpoint_revert_operations (
            operation_id,
            thread_id,
            target_ref,
            target_turn_count,
            request_source_sequence,
            provider_inbox_high_water,
            cwd,
            phase,
            created_at,
            updated_at
          )
          VALUES (
            ${operationId},
            ${`thread-${suffix}`},
            ${`refs/t3/checkpoint/${suffix}`},
            ${index},
            ${index + 1},
            0,
            ${`/redacted/${suffix}`},
            'manual-required',
            ${originalAt},
            ${originalAt}
          )
        `
        }

        const actionPageOne = yield* admin.listReactorActions()
        assert.equal(actionPageOne.items.length, 100)
        assert.isTrue(actionPageOne.truncated)
        assert.isNotNull(actionPageOne.nextCursor)
        if (actionPageOne.nextCursor === null) return yield* Effect.die('missing action cursor')
        const actionPageTwo = yield* admin.listReactorActions({
          cursor: actionPageOne.nextCursor,
        })
        assert.deepStrictEqual(
          [...actionPageOne.items, ...actionPageTwo.items].map((item) => item.actionId),
          expectedActionIds,
        )
        assert.isFalse(actionPageTwo.truncated)
        assert.isNull(actionPageTwo.nextCursor)

        const checkpointPageOne = yield* admin.listCheckpointReverts()
        assert.equal(checkpointPageOne.items.length, 100)
        assert.isTrue(checkpointPageOne.truncated)
        assert.isNotNull(checkpointPageOne.nextCursor)
        if (checkpointPageOne.nextCursor === null)
        {
          return yield* Effect.die('missing checkpoint cursor')
        }
        const checkpointPageTwo = yield* admin.listCheckpointReverts({
          cursor: checkpointPageOne.nextCursor,
        })
        assert.deepStrictEqual(
          [...checkpointPageOne.items, ...checkpointPageTwo.items].map((item) => item.operationId),
          expectedOperationIds,
        )
        assert.isFalse(checkpointPageTwo.truncated)
        assert.isNull(checkpointPageTwo.nextCursor)

        const malformed = yield* admin
          .listReactorActions({ cursor: RuntimeRecoveryPageCursor.make('not-a-cursor') })
          .pipe(Effect.flip)
        assert.equal(malformed._tag, 'RuntimeRecoveryAdminInvalidCursorError')
        const wrongList = yield* admin
          .listCheckpointReverts({ cursor: actionPageOne.nextCursor })
          .pipe(Effect.flip)
        assert.equal(wrongList._tag, 'RuntimeRecoveryAdminInvalidCursorError')
      }),
  )
})
