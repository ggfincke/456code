// tests/apps/server/persistence/Layers/AttachmentLifecycle.test.ts
// verifies durable attachment staging, ownership, and cleanup transitions

import { assert, it } from '@effect/vitest'
import { CommandId, MessageId, ThreadId } from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'

import { dispatchWithAttachmentLifecycle } from '../../../../../apps/server/src/orchestration/dispatchWithAttachmentLifecycle.ts'
import { PersistenceSqlError } from '../../../../../apps/server/src/persistence/Errors.ts'
import { AttachmentLifecycleRepositoryLive } from '../../../../../apps/server/src/persistence/Layers/AttachmentLifecycle.ts'
import { SqlitePersistenceMemory } from '../../../../../apps/server/src/persistence/Layers/Sqlite.ts'
import { AttachmentLifecycleRepository } from '../../../../../apps/server/src/persistence/Services/AttachmentLifecycle.ts'

const now = '2026-08-02T00:00:00.000Z'
const later = '2026-08-02T00:01:00.000Z'
const makeStageInput = (suffix: string) => ({
  stagingKey: `staging-key-${suffix}`,
  commandId: CommandId.make(`command-attachment-${suffix}`),
  threadId: ThreadId.make('thread-attachment'),
  messageId: MessageId.make(`message-attachment-${suffix}`),
  attachmentIndex: 0,
  attachmentId: `thread-attachment-00000000-0000-4000-8000-0000000000${suffix}`,
  stagingRelativePath: `.staging/staging-key-${suffix}/attachment-${suffix}.png`,
  relativePath: `attachment-${suffix}.png`,
  mimeType: 'image/png',
  byteCount: 4,
  contentDigest: 'abcd',
  now,
})

const layer = it.layer(
  AttachmentLifecycleRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
)

layer('AttachmentLifecycleRepository', (it) =>
{
  it.effect('stages idempotently and fails closed when bytes change', () =>
    Effect.gen(function* ()
    {
      const repository = yield* AttachmentLifecycleRepository
      const input = makeStageInput('01')
      const first = yield* repository.stage(input)
      const repeated = yield* repository.stage(input)
      assert.strictEqual(first.attachmentId, repeated.attachmentId)

      const mismatch = yield* Effect.exit(
        repository.stage({ ...input, contentDigest: 'different' }),
      )
      assert.isTrue(mismatch._tag === 'Failure')
    }),
  )

  it.effect('associates accepted rows and preserves the supplied owner sequence', () =>
    Effect.gen(function* ()
    {
      const repository = yield* AttachmentLifecycleRepository
      const input = makeStageInput('02')
      yield* repository.stage(input)
      yield* repository.associateAccepted({
        commandId: input.commandId,
        ownerSequence: 17,
        ownerEventType: 'thread.message-sent',
        now: later,
      })
      const row = yield* repository.getByStagingKey(input.stagingKey)
      assert.isTrue(Option.isSome(row))
      if (Option.isSome(row))
      {
        assert.strictEqual(row.value.state, 'owned')
        assert.strictEqual(row.value.ownerSequence, 17)
      }
    }),
  )

  it.effect('records cleanup intent and advances claimed work through retry and poison', () =>
    Effect.gen(function* ()
    {
      const repository = yield* AttachmentLifecycleRepository
      const input = makeStageInput('03')
      yield* repository.stage(input)
      yield* repository.markDispatchFailure({
        commandId: input.commandId,
        reason: 'dispatch_failed',
        now,
      })
      const failed = yield* repository.getByStagingKey(input.stagingKey)
      assert.strictEqual(Option.getOrThrow(failed).state, 'cleanup_pending')

      const claimed = yield* repository.claimDue({ now, leaseExpiresAt: later, limit: 1 })
      assert.strictEqual(claimed.length, 1)
      assert.strictEqual(claimed[0]?.state, 'running')
      yield* repository.retry({
        cleanupKey: claimed[0]!.cleanupKey,
        stagingGeneration: claimed[0]!.stagingGeneration,
        error: 'temporary',
        nextAttemptAt: later,
        now,
      })

      const reclaimed = yield* repository.claimDue({
        now: later,
        leaseExpiresAt: '2026-08-02T00:02:00.000Z',
        limit: 1,
      })
      yield* repository.poison({
        cleanupKey: reclaimed[0]!.cleanupKey,
        stagingGeneration: reclaimed[0]!.stagingGeneration,
        error: 'permanent',
        now: later,
      })
      const diagnostics = yield* repository.listDiagnostics()
      assert.strictEqual(diagnostics.cleanup[0]?.state, 'poison')
      assert.strictEqual(diagnostics.cleanup[0]?.attemptCount, 2)
      assert.strictEqual(
        diagnostics.staging.find((row) => row.stagingKey === input.stagingKey)?.retryCount,
        2,
      )
    }),
  )

  it.effect('restaging supersedes a claimed cleanup generation', () =>
    Effect.gen(function* ()
    {
      const repository = yield* AttachmentLifecycleRepository
      const input = makeStageInput('06')
      yield* repository.stage(input)
      yield* repository.markDispatchFailure({
        commandId: input.commandId,
        reason: 'dispatch_failed',
        now,
      })
      const claimed = yield* repository.claimDue({ now, leaseExpiresAt: later, limit: 64 })
      const cleanupKey = `attachment:${input.stagingKey}`
      assert.isTrue(claimed.some((row) => row.cleanupKey === cleanupKey && row.state === 'running'))

      const restaged = yield* repository.stage({ ...input, now: later })
      assert.strictEqual(restaged.state, 'staged')
      assert.strictEqual(restaged.generation, 1)

      const diagnostics = yield* repository.listDiagnostics()
      const cleanup = diagnostics.cleanup.find((row) => row.cleanupKey === cleanupKey)
      assert.strictEqual(cleanup?.state, 'complete')
      assert.isNull(cleanup?.leaseExpiresAt ?? null)
      const reclaimed = yield* repository.claimDue({
        now: '2026-08-02T00:02:00.000Z',
        leaseExpiresAt: '2026-08-02T00:03:00.000Z',
        limit: 64,
      })
      assert.isFalse(reclaimed.some((row) => row.cleanupKey === cleanupKey))
    }),
  )

  it.effect('enqueues path and thread cleanup idempotently', () =>
    Effect.gen(function* ()
    {
      const repository = yield* AttachmentLifecycleRepository
      yield* repository.enqueuePathCleanup({
        cleanupKey: 'path-cleanup',
        stagingKey: null,
        relativePath: 'attachment.png',
        stagingRelativePath: null,
        reason: 'path_cleanup',
        sourceSequence: 5,
        now,
      })
      yield* repository.enqueueThreadCleanup({
        cleanupKey: 'thread-cleanup',
        threadId: ThreadId.make('thread-attachment'),
        threadSegment: 'thread-attachment',
        reason: 'thread_cleanup',
        sourceSequence: 6,
        now,
      })
      yield* repository.enqueueThreadCleanup({
        cleanupKey: 'thread-cleanup',
        threadId: ThreadId.make('thread-attachment'),
        threadSegment: 'thread-attachment',
        reason: 'thread_cleanup',
        sourceSequence: 6,
        now,
      })
      const diagnostics = yield* repository.listDiagnostics()
      assert.strictEqual(
        diagnostics.cleanup.filter((row) =>
          ['path-cleanup', 'thread-cleanup'].includes(row.cleanupKey),
        ).length,
        2,
      )
    }),
  )

  it.effect('records cleanup intent when normalized dispatch fails or is interrupted', () =>
    Effect.gen(function* ()
    {
      const repository = yield* AttachmentLifecycleRepository
      const failedCommandId = CommandId.make('command-wrapper-failed')
      const interruptedCommandId = CommandId.make('command-wrapper-interrupted')
      const baseInput = makeStageInput('05')
      const stageFor = (nextCommandId: CommandId) =>
        repository.stage({
          ...baseInput,
          stagingKey: `staging-${nextCommandId}`,
          commandId: nextCommandId,
          messageId: MessageId.make(`message-${nextCommandId}`),
          attachmentId: `attachment-${nextCommandId}`,
          stagingRelativePath: `.staging/${nextCommandId}/attachment.png`,
          relativePath: `attachment-${nextCommandId}.png`,
        })
      const commandFor = (nextCommandId: CommandId) => ({
        type: 'thread.turn.start' as const,
        commandId: nextCommandId,
        threadId: baseInput.threadId,
        message: {
          messageId: MessageId.make(`message-${nextCommandId}`),
          role: 'user' as const,
          text: 'attachment',
          attachments: [],
        },
        runtimeMode: 'full-access' as const,
        interactionMode: 'default' as const,
        createdAt: now,
      })

      yield* stageFor(failedCommandId)
      yield* Effect.exit(
        dispatchWithAttachmentLifecycle(
          commandFor(failedCommandId),
          Effect.fail(new PersistenceSqlError({ operation: 'test.dispatch', detail: 'rejected' })),
        ),
      )
      yield* stageFor(interruptedCommandId)
      yield* Effect.exit(
        dispatchWithAttachmentLifecycle(commandFor(interruptedCommandId), Effect.interrupt),
      )

      const failedRows = yield* repository.getByCommandId(failedCommandId)
      const interruptedRows = yield* repository.getByCommandId(interruptedCommandId)
      assert.strictEqual(failedRows[0]?.state, 'cleanup_pending')
      assert.strictEqual(interruptedRows[0]?.state, 'cleanup_pending')
      const diagnostics = yield* repository.listDiagnostics()
      assert.isTrue(diagnostics.cleanup.some((row) => row.reason === 'dispatch_failed_or_rejected'))
      assert.isTrue(diagnostics.cleanup.some((row) => row.reason === 'dispatch_interrupted'))
    }),
  )
})
