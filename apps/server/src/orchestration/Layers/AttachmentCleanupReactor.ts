// apps/server/src/orchestration/Layers/AttachmentCleanupReactor.ts
// reconciles and removes durably unowned attachment files

import * as Clock from 'effect/Clock'
import * as DateTime from 'effect/DateTime'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schedule from 'effect/Schedule'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import {
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from '../../attachmentPaths.ts'
import {
  parseAttachmentIdFromRelativePath,
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from '../../attachmentStore.ts'
import { ServerConfig } from '../../config.ts'
import { toPersistenceSqlError } from '../../persistence/Errors.ts'
import { AttachmentLifecycleRepositoryLive } from '../../persistence/Layers/AttachmentLifecycle.ts'
import {
  type AttachmentCleanup,
  type AttachmentStaging,
  AttachmentLifecycleRepository,
} from '../../persistence/Services/AttachmentLifecycle.ts'
import {
  AttachmentCleanupDeliveryError,
  AttachmentCleanupReactor,
  type AttachmentCleanupReactorShape,
} from '../Services/AttachmentCleanupReactor.ts'

export const ATTACHMENT_CLEANUP_GRACE = Duration.minutes(15)
export const ATTACHMENT_CLEANUP_LEASE = Duration.minutes(2)
export const ATTACHMENT_CLEANUP_MAX_ATTEMPTS = 5
const ATTACHMENT_CLEANUP_BATCH_SIZE = 64
const ATTACHMENT_CLEANUP_POLL_INTERVAL = Duration.minutes(1)
const ATTACHMENT_CLEANUP_RETRY_BASE = Duration.minutes(1)
const ATTACHMENT_CLEANUP_RETRY_MAX = Duration.minutes(15)

const formatIsoMillis = (millis: number): string => DateTime.formatIso(DateTime.makeUnsafe(millis))

const deliveryError = (cleanupKey: string, message: string) =>
  new AttachmentCleanupDeliveryError({ cleanupKey, message })

function managedRootRelativePath(relativePath: string): string | null
{
  const normalized = normalizeAttachmentRelativePath(relativePath)
  if (normalized === null || normalized !== relativePath || normalized.includes('/'))
  {
    return null
  }
  const attachmentId = parseAttachmentIdFromRelativePath(normalized)
  if (attachmentId === null || parseThreadSegmentFromAttachmentId(attachmentId) === null)
  {
    return null
  }
  return normalized
}

function ownedByNewerOrSameProjection(
  row: AttachmentStaging,
  sourceSequence: number | null,
): boolean
{
  return (
    row.state === 'owned' &&
    (sourceSequence === null || row.ownerSequence === null || row.ownerSequence >= sourceSequence)
  )
}

function retryDelay(attemptCount: number): Duration.Duration
{
  const multiplier = 2 ** Math.max(0, attemptCount)
  return Duration.min(
    Duration.times(ATTACHMENT_CLEANUP_RETRY_BASE, multiplier),
    ATTACHMENT_CLEANUP_RETRY_MAX,
  )
}

export const makeAttachmentCleanupReactor = Effect.gen(function* ()
{
  const repository = yield* AttachmentLifecycleRepository
  const fileSystem = yield* FileSystem.FileSystem
  const sql = yield* SqlClient.SqlClient
  const serverConfig = yield* ServerConfig

  const statRegularFile = Effect.fn('AttachmentCleanupReactor.statRegularFile')(function* (
    cleanupKey: string,
    absolutePath: string,
  )
  {
    const targetExists = yield* fileSystem
      .exists(absolutePath)
      .pipe(Effect.mapError((cause) => deliveryError(cleanupKey, String(cause))))
    if (!targetExists)
    {
      return false
    }
    const fileInfo = yield* fileSystem
      .stat(absolutePath)
      .pipe(Effect.mapError((cause) => deliveryError(cleanupKey, String(cause))))
    if (fileInfo.type !== 'File')
    {
      return yield* deliveryError(cleanupKey, 'Cleanup target is not a regular file.')
    }
    return true
  })

  const removeRegularFile = Effect.fn('AttachmentCleanupReactor.removeRegularFile')(function* (
    cleanupKey: string,
    absolutePath: string,
  )
  {
    if (!(yield* statRegularFile(cleanupKey, absolutePath)))
    {
      return
    }
    yield* fileSystem
      .remove(absolutePath, { force: true })
      .pipe(Effect.mapError((cause) => deliveryError(cleanupKey, String(cause))))
  })

  const deferUntilGraceExpires = Effect.fn('AttachmentCleanupReactor.deferUntilGraceExpires')(
    function* (
      cleanupKey: string,
      stagingGeneration: number | null,
      graceExpiresAt: string,
      now: string,
    )
    {
      yield* sql`
      UPDATE attachment_cleanup
      SET
        state = 'pending',
        lease_expires_at = NULL,
        next_attempt_at = ${graceExpiresAt},
        updated_at = ${now}
      WHERE cleanup_key = ${cleanupKey}
        AND staging_generation IS ${stagingGeneration}
        AND (
          staging_key IS NULL
          OR EXISTS (
            SELECT 1
            FROM attachment_staging
            WHERE attachment_staging.staging_key = attachment_cleanup.staging_key
              AND attachment_staging.generation = ${stagingGeneration}
          )
        )
        AND state = 'running'
    `.pipe(
        Effect.mapError(toPersistenceSqlError('AttachmentCleanupReactor.deferUntilGraceExpires')),
      )
    },
  )

  const markManual = Effect.fn('AttachmentCleanupReactor.markManual')(function* (
    cleanupKey: string,
    stagingGeneration: number | null,
    reason: string,
    now: string,
  )
  {
    yield* sql`
      UPDATE attachment_cleanup
      SET
        state = 'manual',
        lease_expires_at = NULL,
        next_attempt_at = NULL,
        last_error = ${reason},
        updated_at = ${now}
      WHERE cleanup_key = ${cleanupKey}
        AND staging_generation IS ${stagingGeneration}
        AND (
          staging_key IS NULL
          OR EXISTS (
            SELECT 1
            FROM attachment_staging
            WHERE attachment_staging.staging_key = attachment_cleanup.staging_key
              AND attachment_staging.generation = ${stagingGeneration}
          )
        )
        AND state = 'running'
    `.pipe(Effect.mapError(toPersistenceSqlError('AttachmentCleanupReactor.markManual')))
  })

  const reconcileStagingRows = Effect.fn('AttachmentCleanupReactor.reconcileStagingRows')(
    function* (rows: ReadonlyArray<AttachmentStaging>, graceThresholdMs: number)
    {
      yield* Effect.forEach(
        rows,
        (row) =>
        {
          if (row.state === 'owned' || Date.parse(row.createdAt) > graceThresholdMs)
          {
            return Effect.void
          }
          return repository.enqueuePathCleanup({
            cleanupKey: `reconcile:${row.stagingKey}`,
            stagingKey: row.stagingKey,
            relativePath: row.relativePath,
            stagingRelativePath: row.stagingRelativePath,
            reason: 'startup reconciliation of unowned staged attachment',
            sourceSequence: row.ownerSequence,
            now: row.createdAt,
          })
        },
        { concurrency: 1 },
      )
    },
  )

  const reconcileLegacyFiles = Effect.fn('AttachmentCleanupReactor.reconcileLegacyFiles')(
    function* (rows: ReadonlyArray<AttachmentStaging>, now: string)
    {
      if (!(yield* fileSystem.exists(serverConfig.attachmentsDir)))
      {
        return
      }
      const trackedPaths = new Set(rows.map((row) => row.relativePath))
      const entries = yield* fileSystem.readDirectory(serverConfig.attachmentsDir, {
        recursive: false,
      })
      yield* Effect.forEach(
        entries,
        (entry) =>
        {
          const relativePath = managedRootRelativePath(entry)
          if (relativePath === null || trackedPaths.has(relativePath))
          {
            return Effect.void
          }
          const absolutePath = resolveAttachmentRelativePath({
            attachmentsDir: serverConfig.attachmentsDir,
            relativePath,
          })
          if (absolutePath === null)
          {
            return Effect.void
          }
          return statRegularFile(`manual:legacy:${relativePath}`, absolutePath).pipe(
            Effect.flatMap((isRegularFile) =>
              isRegularFile
                ? sql`
                  INSERT INTO attachment_cleanup (
                    cleanup_key,
                    target_kind,
                    relative_path,
                    reason,
                    state,
                    created_at,
                    updated_at
                  )
                  VALUES (
                    ${`manual:legacy:${relativePath}`},
                    'path',
                    ${relativePath},
                    'legacy untracked managed-looking attachment requires manual review',
                    'manual',
                    ${now},
                    ${now}
                  )
                  ON CONFLICT(cleanup_key) DO NOTHING
                `.pipe(
                    Effect.mapError(
                      toPersistenceSqlError('AttachmentCleanupReactor.reconcileLegacyFiles'),
                    ),
                  )
                : Effect.void,
            ),
            Effect.catchTag('AttachmentCleanupDeliveryError', () => Effect.void),
          )
        },
        { concurrency: 1 },
      )
    },
  )

  const reconcile = Effect.fn('AttachmentCleanupReactor.reconcile')(function* ()
  {
    const nowMs = yield* Clock.currentTimeMillis
    const now = formatIsoMillis(nowMs)
    const stagingRows = yield* repository.listStaging()
    yield* reconcileStagingRows(stagingRows, nowMs - Duration.toMillis(ATTACHMENT_CLEANUP_GRACE))
    yield* reconcileLegacyFiles(stagingRows, now)
  })

  const fenceClaim = Effect.fn('AttachmentCleanupReactor.fenceClaim')(function* (
    claim: AttachmentCleanup,
  )
  {
    const rows = yield* sql<{ readonly cleanupKey: string }>`
      UPDATE attachment_cleanup
      SET updated_at = updated_at
      WHERE cleanup_key = ${claim.cleanupKey}
        AND staging_generation IS ${claim.stagingGeneration}
        AND state = 'running'
      RETURNING cleanup_key AS "cleanupKey"
    `
    return rows.length === 1
  })

  const loadPathStagingRows = Effect.fn('AttachmentCleanupReactor.loadPathStagingRows')(function* (
    claim: AttachmentCleanup,
  )
  {
    const rows = new Map<string, AttachmentStaging>()
    if (claim.relativePath !== null)
    {
      const byRelativePath = yield* repository.getByRelativePath(claim.relativePath)
      if (Option.isSome(byRelativePath))
      {
        rows.set(byRelativePath.value.stagingKey, byRelativePath.value)
      }
    }
    if (claim.stagingKey !== null)
    {
      const byStagingKey = yield* repository.getByStagingKey(claim.stagingKey)
      if (Option.isSome(byStagingKey))
      {
        rows.set(byStagingKey.value.stagingKey, byStagingKey.value)
      }
    }
    return [...rows.values()]
  })

  const loadClaimStagingRows = Effect.fn('AttachmentCleanupReactor.loadClaimStagingRows')(
    function* (claim: AttachmentCleanup)
    {
      if (claim.targetKind === 'path')
      {
        return yield* loadPathStagingRows(claim)
      }
      return claim.threadId === null ? [] : yield* repository.getByThreadId(claim.threadId)
    },
  )

  const processPathClaim = Effect.fn('AttachmentCleanupReactor.processPathClaim')(function* (
    claim: AttachmentCleanup,
    stagingRows: ReadonlyArray<AttachmentStaging>,
  ): Effect.fn.Return<'complete' | 'manual', AttachmentCleanupDeliveryError>
  {
    const targets: Array<{ readonly relativePath: string; readonly row: AttachmentStaging }> = []

    if (claim.relativePath !== null)
    {
      const relativePath = managedRootRelativePath(claim.relativePath)
      if (relativePath === null)
      {
        return yield* deliveryError(claim.cleanupKey, 'Unsafe managed attachment path.')
      }
      const row = stagingRows.find((candidate) => candidate.relativePath === relativePath)
      const absolutePath = resolveAttachmentRelativePath({
        attachmentsDir: serverConfig.attachmentsDir,
        relativePath,
      })
      if (absolutePath === null)
      {
        return yield* deliveryError(claim.cleanupKey, 'Attachment path escaped its managed root.')
      }
      if (row === undefined)
      {
        if (yield* statRegularFile(claim.cleanupKey, absolutePath))
        {
          return 'manual' as const
        }
      }
      else
      {
        if (claim.stagingKey !== null && row.stagingKey !== claim.stagingKey)
        {
          return yield* deliveryError(
            claim.cleanupKey,
            'Managed path is not owned by the cleanup staging row.',
          )
        }
        targets.push({ relativePath, row })
      }
    }

    if (claim.stagingRelativePath !== null)
    {
      const row =
        claim.stagingKey === null
          ? undefined
          : stagingRows.find((candidate) => candidate.stagingKey === claim.stagingKey)
      const normalized = normalizeAttachmentRelativePath(claim.stagingRelativePath)
      if (
        row === undefined ||
        normalized === null ||
        normalized !== claim.stagingRelativePath ||
        normalized !== row.stagingRelativePath ||
        !normalized.startsWith(`.staging/${row.stagingKey}/`) ||
        managedRootRelativePath(normalized.slice(normalized.lastIndexOf('/') + 1)) === null
      )
      {
        return yield* deliveryError(claim.cleanupKey, 'Unsafe or unowned staging attachment path.')
      }
      targets.push({ relativePath: normalized, row })
    }

    for (const target of targets)
    {
      if (
        claim.stagingKey !== null &&
        (claim.stagingGeneration === null || target.row.generation !== claim.stagingGeneration)
      )
      {
        continue
      }
      if (ownedByNewerOrSameProjection(target.row, claim.sourceSequence))
      {
        continue
      }
      const absolutePath = resolveAttachmentRelativePath({
        attachmentsDir: serverConfig.attachmentsDir,
        relativePath: target.relativePath,
      })
      if (absolutePath === null)
      {
        return yield* deliveryError(claim.cleanupKey, 'Attachment path escaped its managed root.')
      }
      yield* removeRegularFile(claim.cleanupKey, absolutePath)
    }
    return 'complete' as const
  })

  const processThreadClaim = Effect.fn('AttachmentCleanupReactor.processThreadClaim')(function* (
    claim: AttachmentCleanup,
    stagingRows: ReadonlyArray<AttachmentStaging>,
  ): Effect.fn.Return<'complete', AttachmentCleanupDeliveryError>
  {
    if (claim.threadId === null || claim.threadSegment === null)
    {
      return yield* deliveryError(claim.cleanupKey, 'Thread cleanup identity is incomplete.')
    }
    const threadSegment = toSafeThreadAttachmentSegment(claim.threadId)
    if (threadSegment === null || threadSegment !== claim.threadSegment)
    {
      return yield* deliveryError(claim.cleanupKey, 'Unsafe thread cleanup identity.')
    }

    const threadRows = stagingRows.filter((row) => row.threadId === claim.threadId)
    for (const row of threadRows)
    {
      const relativePath = managedRootRelativePath(row.relativePath)
      const attachmentId =
        relativePath === null ? null : parseAttachmentIdFromRelativePath(relativePath)
      if (
        relativePath === null ||
        attachmentId === null ||
        parseThreadSegmentFromAttachmentId(attachmentId) !== threadSegment
      )
      {
        return yield* deliveryError(claim.cleanupKey, 'Tracked thread attachment path is unsafe.')
      }
      if (ownedByNewerOrSameProjection(row, claim.sourceSequence))
      {
        continue
      }
      if (row.state === 'staged')
      {
        continue
      }
      const absolutePath = resolveAttachmentRelativePath({
        attachmentsDir: serverConfig.attachmentsDir,
        relativePath,
      })
      if (absolutePath === null)
      {
        return yield* deliveryError(claim.cleanupKey, 'Thread attachment escaped its managed root.')
      }
      yield* removeRegularFile(claim.cleanupKey, absolutePath)
    }
    return 'complete' as const
  })

  const failClaim = Effect.fn('AttachmentCleanupReactor.failClaim')(function* (
    claim: AttachmentCleanup,
    cause: AttachmentCleanupDeliveryError,
    nowMs: number,
  )
  {
    const now = formatIsoMillis(nowMs)
    if (claim.attemptCount + 1 >= ATTACHMENT_CLEANUP_MAX_ATTEMPTS)
    {
      yield* repository.poison({
        cleanupKey: claim.cleanupKey,
        stagingGeneration: claim.stagingGeneration,
        error: cause.message,
        now,
      })
      return
    }
    yield* repository.retry({
      cleanupKey: claim.cleanupKey,
      stagingGeneration: claim.stagingGeneration,
      error: cause.message,
      nextAttemptAt: formatIsoMillis(nowMs + Duration.toMillis(retryDelay(claim.attemptCount))),
      now,
    })
  })

  const processClaim = Effect.fn('AttachmentCleanupReactor.processClaim')(function* (
    claim: AttachmentCleanup,
    nowMs: number,
  )
  {
    const now = formatIsoMillis(nowMs)
    const graceExpiresAtMs =
      Date.parse(claim.createdAt) + Duration.toMillis(ATTACHMENT_CLEANUP_GRACE)
    if (nowMs < graceExpiresAtMs)
    {
      yield* deferUntilGraceExpires(
        claim.cleanupKey,
        claim.stagingGeneration,
        formatIsoMillis(graceExpiresAtMs),
        now,
      )
      return
    }

    yield* sql
      .withTransaction(
        Effect.gen(function* ()
        {
          if (!(yield* fenceClaim(claim)))
          {
            return
          }
          const stagingRows = yield* loadClaimStagingRows(claim)
          const result = yield* (
            claim.targetKind === 'path'
              ? processPathClaim(claim, stagingRows)
              : processThreadClaim(claim, stagingRows)
          ).pipe(Effect.result)
          if (result._tag === 'Failure')
          {
            yield* failClaim(claim, result.failure, nowMs)
            return
          }
          if (result.success === 'manual')
          {
            yield* markManual(
              claim.cleanupKey,
              claim.stagingGeneration,
              'Untracked managed-looking attachment requires manual review.',
              now,
            )
            return
          }
          yield* repository.complete({
            cleanupKey: claim.cleanupKey,
            stagingGeneration: claim.stagingGeneration,
            now,
          })
        }),
      )
      .pipe(
        Effect.catchTag('SqlError', (cause) =>
          Effect.fail(
            toPersistenceSqlError('AttachmentCleanupReactor.processClaim:transaction')(cause),
          ),
        ),
      )
  })

  const drain: AttachmentCleanupReactorShape['drain'] = Effect.gen(function* ()
  {
    const nowMs = yield* Clock.currentTimeMillis
    const now = formatIsoMillis(nowMs)
    const claims = yield* repository.claimDue({
      now,
      leaseExpiresAt: formatIsoMillis(nowMs + Duration.toMillis(ATTACHMENT_CLEANUP_LEASE)),
      limit: ATTACHMENT_CLEANUP_BATCH_SIZE,
    })
    yield* Effect.forEach(claims, (claim) => processClaim(claim, nowMs), { concurrency: 1 })
  })

  const runSafely = <E>(effect: Effect.Effect<void, E>) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning('attachment cleanup reactor tick failed', { cause: String(cause) }),
      ),
    )

  const start: AttachmentCleanupReactorShape['start'] = Effect.fn('AttachmentCleanupReactor.start')(
    function* ()
    {
      yield* runSafely(reconcile().pipe(Effect.andThen(drain)))
      yield* Effect.forkScoped(
        runSafely(drain).pipe(Effect.repeat(Schedule.spaced(ATTACHMENT_CLEANUP_POLL_INTERVAL))),
      )
    },
  )

  return { start, drain } satisfies AttachmentCleanupReactorShape
})

export const AttachmentCleanupReactorLive = Layer.effect(
  AttachmentCleanupReactor,
  makeAttachmentCleanupReactor,
).pipe(Layer.provideMerge(AttachmentLifecycleRepositoryLive))
