// tests/apps/server/persistence/Layers/ImportReplacementIntents.test.ts
// verifies import replacement intent idempotence and phase transitions

import { CommandId, ProjectId, ThreadId } from '@t3tools/contracts'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'

import { ImportReplacementIntentRepositoryLive } from '../../../../../apps/server/src/persistence/Layers/ImportReplacementIntents.ts'
import { SqlitePersistenceMemory } from '../../../../../apps/server/src/persistence/Layers/Sqlite.ts'
import {
  ACTIVE_IMPORT_REPLACEMENT_VERSION,
  ImportReplacementIntentRepository,
  type ImportReplacementIntent,
} from '../../../../../apps/server/src/persistence/Services/ImportReplacementIntents.ts'

const layer = it.layer(
  ImportReplacementIntentRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
)

function intent(intentKey = 'intent-1'): ImportReplacementIntent
{
  const now = '2026-08-01T00:00:00.000Z'
  return {
    intentKey,
    source: 'codex-cli',
    sourcePath: '/tmp/source.jsonl',
    nativeSessionId: null,
    providerInstanceId: null,
    originalWorkspaceRoot: null,
    sourceVersion: 'source-version',
    replacementVersion: ACTIVE_IMPORT_REPLACEMENT_VERSION,
    sourceThreadId: ThreadId.make('source-thread'),
    sourceProjectId: ProjectId.make('project'),
    replacementThreadId: ThreadId.make('replacement-thread'),
    replacementProjectId: ProjectId.make('project'),
    replacementWorkspaceRoot: '/tmp/workspace',
    createCommandId: CommandId.make('create-command'),
    tombstoneCommandId: CommandId.make('tombstone-command'),
    expectedMessageCount: 1,
    expectedActivityCount: 0,
    expectedRecordFingerprint: 'fingerprint',
    phase: 'intent',
    threadEvidence: null,
    attachmentEvidence: null,
    indexEvidence: null,
    attemptCount: 0,
    lastError: null,
    retryAfter: null,
    createdAt: now,
    updatedAt: now,
    retiredAt: null,
  }
}

layer('ImportReplacementIntentRepository', (it) =>
{
  it.effect('inserts idempotently, compares phases, lists manual, and retires', () =>
    Effect.gen(function* ()
    {
      const repository = yield* ImportReplacementIntentRepository
      const row = intent()

      yield* repository.insertIfAbsent(row)
      yield* repository.insertIfAbsent({ ...row, expectedMessageCount: 99 })
      const duplicateIdentity = yield* Effect.result(
        repository.insertIfAbsent({ ...row, intentKey: 'different-intent-key' }),
      )
      assert.equal(duplicateIdentity._tag, 'Failure')
      const stored = yield* repository.getByIntentKey(row.intentKey)
      assert.equal(Option.getOrThrow(stored).expectedMessageCount, 1)

      const lostCas = yield* repository.casTransition({
        intentKey: row.intentKey,
        expectedPhase: 'creating',
        nextPhase: 'manual',
        threadEvidence: null,
        attachmentEvidence: null,
        indexEvidence: null,
        attemptCount: 3,
        lastError: 'manual review',
        retryAfter: null,
        updatedAt: row.updatedAt,
      })
      assert.isFalse(lostCas)
      assert.isTrue(
        yield* repository.casTransition({
          intentKey: row.intentKey,
          expectedPhase: 'intent',
          nextPhase: 'manual',
          threadEvidence: null,
          attachmentEvidence: null,
          indexEvidence: null,
          attemptCount: 3,
          lastError: 'manual review',
          retryAfter: null,
          updatedAt: row.updatedAt,
        }),
      )
      assert.equal((yield* repository.listOpen())[0]?.phase, 'manual')
      assert.isTrue(
        yield* repository.retire({
          intentKey: row.intentKey,
          expectedPhase: 'manual',
          retiredAt: '2026-08-01T00:01:00.000Z',
        }),
      )
      assert.deepEqual(yield* repository.listOpen(), [])
    }),
  )
})
