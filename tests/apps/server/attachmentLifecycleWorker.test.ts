// tests/apps/server/attachmentLifecycleWorker.test.ts
// verifies bounded durable attachment cleanup and path safety

import * as NodeServices from '@effect/platform-node/NodeServices'
import { CommandId, MessageId, ThreadId } from '@t3tools/contracts'
import { assert, it } from '@effect/vitest'
import * as Deferred from 'effect/Deferred'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import * as TestClock from 'effect/testing/TestClock'

import { ServerConfig } from '../../../apps/server/src/config.ts'
import {
  ATTACHMENT_CLEANUP_GRACE,
  ATTACHMENT_CLEANUP_MAX_ATTEMPTS,
  AttachmentCleanupReactorLive,
  makeAttachmentCleanupReactor,
} from '../../../apps/server/src/orchestration/Layers/AttachmentCleanupReactor.ts'
import { AttachmentCleanupReactor } from '../../../apps/server/src/orchestration/Services/AttachmentCleanupReactor.ts'
import { SqlitePersistenceMemory } from '../../../apps/server/src/persistence/Layers/Sqlite.ts'
import AttachmentLifecycleMigration from '../../../apps/server/src/persistence/Migrations/046_AttachmentLifecycle.ts'
import { AttachmentLifecycleRepository } from '../../../apps/server/src/persistence/Services/AttachmentLifecycle.ts'

const EPOCH = '1970-01-01T00:00:00.000Z'
const AFTER_GRACE_MS = Duration.toMillis(ATTACHMENT_CLEANUP_GRACE) + 1

const AttachmentLifecyclePersistenceMemory = Layer.effectDiscard(AttachmentLifecycleMigration).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
)

const TestLayer = AttachmentCleanupReactorLive.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: 't3-attachment-cleanup-' })),
  Layer.provideMerge(AttachmentLifecyclePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
)

const stagingKey = (digit: string): string => digit.repeat(64)

const stageOwnedAttachment = Effect.fn('stageOwnedAttachment')(function* (input: {
  readonly key: string
  readonly commandId: string
  readonly threadId: string
  readonly messageId: string
  readonly attachmentId: string
  readonly relativePath: string
  readonly ownerSequence: number
})
{
  const repository = yield* AttachmentLifecycleRepository
  yield* repository.stage({
    stagingKey: input.key,
    commandId: CommandId.make(input.commandId),
    threadId: ThreadId.make(input.threadId),
    messageId: MessageId.make(input.messageId),
    attachmentIndex: 0,
    attachmentId: input.attachmentId,
    stagingRelativePath: `.staging/${input.key}/${input.relativePath}`,
    relativePath: input.relativePath,
    mimeType: 'image/png',
    byteCount: 4,
    contentDigest: input.key,
    now: EPOCH,
  })
  yield* repository.associateAccepted({
    commandId: CommandId.make(input.commandId),
    ownerSequence: input.ownerSequence,
    ownerEventType: 'thread.message-sent',
    now: EPOCH,
  })
})

const writeAttachment = Effect.fn('writeAttachment')(function* (
  relativePath: string,
  contents = 'data',
)
{
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const { attachmentsDir } = yield* ServerConfig
  const absolutePath = path.join(attachmentsDir, relativePath)
  yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true })
  yield* fileSystem.writeFileString(absolutePath, contents)
  return absolutePath
})

const pathExists = Effect.fn('pathExists')(function* (absolutePath: string)
{
  const fileSystem = yield* FileSystem.FileSystem
  return yield* fileSystem.exists(absolutePath)
})

it.layer(TestLayer)('AttachmentCleanupReactor', (it) =>
{
  it.effect('claims, verifies, and deletes an exact tracked attachment path', () =>
    Effect.gen(function* ()
    {
      const reactor = yield* AttachmentCleanupReactor
      const repository = yield* AttachmentLifecycleRepository
      const attachmentId = 'thread-happy-00000000-0000-4000-8000-000000000001'
      const relativePath = `${attachmentId}.png`
      yield* stageOwnedAttachment({
        key: stagingKey('1'),
        commandId: 'command-happy',
        threadId: 'thread-happy',
        messageId: 'message-happy',
        attachmentId,
        relativePath,
        ownerSequence: 1,
      })
      const absolutePath = yield* writeAttachment(relativePath)
      yield* repository.enqueuePathCleanup({
        cleanupKey: 'cleanup-happy',
        stagingKey: null,
        relativePath,
        stagingRelativePath: null,
        reason: 'test projection removal',
        sourceSequence: 2,
        now: EPOCH,
      })

      yield* TestClock.setTime(AFTER_GRACE_MS)
      yield* reactor.drain

      assert.isFalse(yield* pathExists(absolutePath))
      const diagnostics = yield* repository.listDiagnostics()
      assert.equal(
        diagnostics.cleanup.find((row) => row.cleanupKey === 'cleanup-happy')?.state,
        'complete',
      )
    }),
  )

  it.effect('completes an already-absent exact target idempotently', () =>
    Effect.gen(function* ()
    {
      const reactor = yield* AttachmentCleanupReactor
      const repository = yield* AttachmentLifecycleRepository
      const attachmentId = 'thread-absent-00000000-0000-4000-8000-000000000002'
      const relativePath = `${attachmentId}.png`
      yield* stageOwnedAttachment({
        key: stagingKey('2'),
        commandId: 'command-absent',
        threadId: 'thread-absent',
        messageId: 'message-absent',
        attachmentId,
        relativePath,
        ownerSequence: 1,
      })
      yield* repository.enqueuePathCleanup({
        cleanupKey: 'cleanup-absent',
        stagingKey: null,
        relativePath,
        stagingRelativePath: null,
        reason: 'test absent removal',
        sourceSequence: 2,
        now: EPOCH,
      })

      yield* TestClock.setTime(AFTER_GRACE_MS)
      yield* reactor.drain
      yield* reactor.drain

      const diagnostics = yield* repository.listDiagnostics()
      const cleanup = diagnostics.cleanup.find((row) => row.cleanupKey === 'cleanup-absent')
      assert.equal(cleanup?.state, 'complete')
      assert.equal(cleanup?.attemptCount, 0)
    }),
  )

  it.effect('never deletes traversal, sentinel, nested, or user-lookalike paths', () =>
    Effect.gen(function* ()
    {
      const reactor = yield* AttachmentCleanupReactor
      const repository = yield* AttachmentLifecycleRepository
      const path = yield* Path.Path
      const { attachmentsDir } = yield* ServerConfig
      const parentSentinel = path.join(path.dirname(attachmentsDir), 'sentinel.txt')
      const rootSentinel = yield* writeAttachment('sentinel.txt', 'sentinel')
      const nestedPath = yield* writeAttachment(
        'nested/thread-safe-00000000-0000-4000-8000-000000000003.png',
      )
      const lookalikePath = yield* writeAttachment('thread-safe-not-a-uuid.png')
      const ownedAttachmentId = 'thread-owned-00000000-0000-4000-8000-000000000008'
      const ownedRelativePath = `${ownedAttachmentId}.png`
      yield* stageOwnedAttachment({
        key: stagingKey('6'),
        commandId: 'command-owned',
        threadId: 'thread-owned',
        messageId: 'message-owned',
        attachmentId: ownedAttachmentId,
        relativePath: ownedRelativePath,
        ownerSequence: 5,
      })
      const ownedPath = yield* writeAttachment(ownedRelativePath, 'owned')
      const fileSystem = yield* FileSystem.FileSystem
      yield* fileSystem.writeFileString(parentSentinel, 'parent-sentinel')

      const unsafePaths = [
        '../sentinel.txt',
        'sentinel.txt',
        'nested/thread-safe-00000000-0000-4000-8000-000000000003.png',
        'thread-safe-not-a-uuid.png',
      ]
      yield* Effect.forEach(
        unsafePaths,
        (relativePath, index) =>
          repository.enqueuePathCleanup({
            cleanupKey: `cleanup-unsafe-${index}`,
            stagingKey: null,
            relativePath,
            stagingRelativePath: null,
            reason: 'test unsafe path',
            sourceSequence: 2,
            now: EPOCH,
          }),
        { concurrency: 1 },
      )
      yield* repository.enqueuePathCleanup({
        cleanupKey: 'cleanup-still-owned',
        stagingKey: null,
        relativePath: ownedRelativePath,
        stagingRelativePath: null,
        reason: 'test durable owner gate',
        sourceSequence: 5,
        now: EPOCH,
      })

      yield* TestClock.setTime(AFTER_GRACE_MS)
      yield* reactor.drain

      assert.isTrue(yield* pathExists(parentSentinel))
      assert.isTrue(yield* pathExists(rootSentinel))
      assert.isTrue(yield* pathExists(nestedPath))
      assert.isTrue(yield* pathExists(lookalikePath))
      assert.isTrue(yield* pathExists(ownedPath))
      const diagnostics = yield* repository.listDiagnostics()
      assert.equal(
        diagnostics.cleanup.find((row) => row.cleanupKey === 'cleanup-still-owned')?.state,
        'complete',
      )
      for (let index = 0; index < unsafePaths.length; index += 1)
      {
        assert.equal(
          diagnostics.cleanup.find((row) => row.cleanupKey === `cleanup-unsafe-${index}`)?.state,
          'pending',
        )
      }
    }),
  )

  it.effect('defers the first deletion until the grace period expires', () =>
    Effect.gen(function* ()
    {
      const reactor = yield* AttachmentCleanupReactor
      const repository = yield* AttachmentLifecycleRepository
      const attachmentId = 'thread-grace-00000000-0000-4000-8000-000000000004'
      const relativePath = `${attachmentId}.png`
      yield* stageOwnedAttachment({
        key: stagingKey('3'),
        commandId: 'command-grace',
        threadId: 'thread-grace',
        messageId: 'message-grace',
        attachmentId,
        relativePath,
        ownerSequence: 1,
      })
      const absolutePath = yield* writeAttachment(relativePath)
      yield* repository.enqueuePathCleanup({
        cleanupKey: 'cleanup-grace',
        stagingKey: null,
        relativePath,
        stagingRelativePath: null,
        reason: 'test grace',
        sourceSequence: 2,
        now: EPOCH,
      })

      yield* TestClock.setTime(Duration.toMillis(ATTACHMENT_CLEANUP_GRACE) - 1)
      yield* reactor.drain
      assert.isTrue(yield* pathExists(absolutePath))

      yield* TestClock.setTime(Duration.toMillis(ATTACHMENT_CLEANUP_GRACE))
      yield* reactor.drain
      assert.isFalse(yield* pathExists(absolutePath))
    }),
  )

  it.effect('retries with backoff and poisons at the bounded attempt limit', () =>
    Effect.gen(function* ()
    {
      const reactor = yield* AttachmentCleanupReactor
      const repository = yield* AttachmentLifecycleRepository
      yield* repository.enqueuePathCleanup({
        cleanupKey: 'cleanup-poison',
        stagingKey: null,
        relativePath: '../never-delete.txt',
        stagingRelativePath: null,
        reason: 'test poison',
        sourceSequence: 2,
        now: EPOCH,
      })

      let nowMs = AFTER_GRACE_MS
      for (let attempt = 0; attempt < ATTACHMENT_CLEANUP_MAX_ATTEMPTS; attempt += 1)
      {
        yield* TestClock.setTime(nowMs)
        yield* reactor.drain
        const diagnostics = yield* repository.listDiagnostics()
        const cleanup = diagnostics.cleanup.find((row) => row.cleanupKey === 'cleanup-poison')
        assert.equal(cleanup?.attemptCount, attempt + 1)
        if (attempt + 1 < ATTACHMENT_CLEANUP_MAX_ATTEMPTS)
        {
          assert.equal(cleanup?.state, 'pending')
          const nextAttemptMs = Date.parse(cleanup?.nextAttemptAt ?? EPOCH)
          assert.equal(
            nextAttemptMs - nowMs,
            Math.min(Duration.toMillis(Duration.minutes(1)) * 2 ** attempt, 15 * 60_000),
          )
          nowMs = nextAttemptMs
        }
      }

      const diagnostics = yield* repository.listDiagnostics()
      const cleanup = diagnostics.cleanup.find((row) => row.cleanupKey === 'cleanup-poison')
      assert.equal(cleanup?.state, 'poison')
      assert.isNotNull(cleanup?.lastError ?? null)
    }),
  )

  it.effect('recovers an expired running lease during startup', () =>
    Effect.gen(function* ()
    {
      const reactor = yield* AttachmentCleanupReactor
      const repository = yield* AttachmentLifecycleRepository
      const sql = yield* SqlClient.SqlClient
      const attachmentId = 'thread-lease-00000000-0000-4000-8000-000000000005'
      const relativePath = `${attachmentId}.png`
      yield* stageOwnedAttachment({
        key: stagingKey('4'),
        commandId: 'command-lease',
        threadId: 'thread-lease',
        messageId: 'message-lease',
        attachmentId,
        relativePath,
        ownerSequence: 1,
      })
      const absolutePath = yield* writeAttachment(relativePath)
      yield* repository.enqueuePathCleanup({
        cleanupKey: 'cleanup-lease',
        stagingKey: null,
        relativePath,
        stagingRelativePath: null,
        reason: 'test lease recovery',
        sourceSequence: 2,
        now: EPOCH,
      })
      yield* sql`
        UPDATE attachment_cleanup
        SET
          state = 'running',
          lease_expires_at = '1970-01-01T00:17:00.000Z',
          updated_at = '1970-01-01T00:16:00.000Z'
        WHERE cleanup_key = 'cleanup-lease'
      `

      const staleKey = stagingKey('5')
      const staleAttachmentId = 'thread-stale-00000000-0000-4000-8000-000000000007'
      const staleRelativePath = `${staleAttachmentId}.png`
      const staleStagingRelativePath = `.staging/${staleKey}/${staleRelativePath}`
      yield* repository.stage({
        stagingKey: staleKey,
        commandId: CommandId.make('command-stale'),
        threadId: ThreadId.make('thread-stale'),
        messageId: MessageId.make('message-stale'),
        attachmentIndex: 0,
        attachmentId: staleAttachmentId,
        stagingRelativePath: staleStagingRelativePath,
        relativePath: staleRelativePath,
        mimeType: 'image/png',
        byteCount: 4,
        contentDigest: staleKey,
        now: EPOCH,
      })
      const staleAbsolutePath = yield* writeAttachment(staleRelativePath)
      const staleStagingAbsolutePath = yield* writeAttachment(staleStagingRelativePath)

      yield* TestClock.setTime(Duration.toMillis(Duration.minutes(18)))
      yield* reactor.start()

      assert.isFalse(yield* pathExists(absolutePath))
      assert.isFalse(yield* pathExists(staleAbsolutePath))
      assert.isFalse(yield* pathExists(staleStagingAbsolutePath))
      const diagnostics = yield* repository.listDiagnostics()
      assert.equal(
        diagnostics.cleanup.find((row) => row.cleanupKey === 'cleanup-lease')?.state,
        'complete',
      )
      assert.equal(
        diagnostics.cleanup.find((row) => row.cleanupKey === `reconcile:${staleKey}`)?.state,
        'complete',
      )
    }),
  )

  it.effect('fences deletion before restaging a claimed generation', () =>
    Effect.gen(function* ()
    {
      const repository = yield* AttachmentLifecycleRepository
      const fileSystem = yield* FileSystem.FileSystem
      const key = stagingKey('7')
      const attachmentId = 'thread-race-00000000-0000-4000-8000-000000000009'
      const relativePath = `${attachmentId}.png`
      const stagingRelativePath = `.staging/${key}/${relativePath}`
      const input = {
        stagingKey: key,
        commandId: CommandId.make('command-race'),
        threadId: ThreadId.make('thread-race'),
        messageId: MessageId.make('message-race'),
        attachmentIndex: 0,
        attachmentId,
        stagingRelativePath,
        relativePath,
        mimeType: 'image/png',
        byteCount: 8,
        contentDigest: key,
        now: EPOCH,
      }
      yield* repository.stage(input)
      const absolutePath = yield* writeAttachment(relativePath, 'old-data')
      const stagingAbsolutePath = yield* writeAttachment(stagingRelativePath, 'old-data')
      yield* repository.markDispatchFailure({
        commandId: input.commandId,
        reason: 'test restage race',
        now: EPOCH,
      })

      const fenceReached = yield* Deferred.make<void>()
      const releaseFence = yield* Deferred.make<void>()
      const observedRepository = AttachmentLifecycleRepository.of({
        ...repository,
        getByRelativePath: (targetRelativePath) =>
          repository.getByRelativePath(targetRelativePath).pipe(
            Effect.tap(() => Deferred.succeed(fenceReached, undefined)),
            Effect.tap(() => Deferred.await(releaseFence)),
          ),
      })
      const reactor = yield* makeAttachmentCleanupReactor.pipe(
        Effect.provideService(AttachmentLifecycleRepository, observedRepository),
      )

      yield* TestClock.setTime(AFTER_GRACE_MS)
      const drainFiber = yield* reactor.drain.pipe(Effect.forkScoped)
      yield* Deferred.await(fenceReached)
      const restageFiber = yield* repository
        .stage({ ...input, now: '1970-01-01T00:16:00.000Z' })
        .pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      assert.isUndefined(restageFiber.pollUnsafe())

      yield* Deferred.succeed(releaseFence, undefined)
      yield* Fiber.join(drainFiber)
      const restaged = yield* Fiber.join(restageFiber)
      assert.equal(restaged.generation, 1)
      assert.equal(restaged.state, 'staged')

      yield* writeAttachment(relativePath, 'new-data')
      yield* writeAttachment(stagingRelativePath, 'new-data')
      yield* reactor.drain

      assert.isTrue(yield* pathExists(absolutePath))
      assert.isTrue(yield* pathExists(stagingAbsolutePath))
      assert.equal(yield* fileSystem.readFileString(absolutePath), 'new-data')
      const diagnostics = yield* repository.listDiagnostics()
      assert.equal(
        diagnostics.cleanup.find((row) => row.cleanupKey === `attachment:${key}`)?.state,
        'complete',
      )
      assert.equal(diagnostics.staging.find((row) => row.stagingKey === key)?.generation, 1)
    }),
  )

  it.effect('reports legacy managed-looking files for manual review without deleting them', () =>
    Effect.gen(function* ()
    {
      const reactor = yield* AttachmentCleanupReactor
      const repository = yield* AttachmentLifecycleRepository
      const relativePath = 'thread-legacy-00000000-0000-4000-8000-000000000006.png'
      const absolutePath = yield* writeAttachment(relativePath, 'legacy')

      yield* TestClock.setTime(AFTER_GRACE_MS)
      yield* reactor.start()
      yield* reactor.start()

      assert.isTrue(yield* pathExists(absolutePath))
      const diagnostics = yield* repository.listDiagnostics()
      const manualRows = diagnostics.cleanup.filter(
        (row) => row.cleanupKey === `manual:legacy:${relativePath}`,
      )
      assert.equal(manualRows.length, 1)
      assert.equal(manualRows[0]?.state, 'manual')
    }),
  )
})
