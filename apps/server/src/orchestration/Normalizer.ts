// apps/server/src/orchestration/Normalizer.ts
// canonicalizes and validates client orchestration commands before dispatch

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from 'node:crypto'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import {
  type ClientOrchestrationCommand,
  type IsoDateTime,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from '@t3tools/contracts'

import {
  attachmentContentDigest,
  attachmentRelativePath,
  attachmentStagingRelativePath,
  createAttachmentId,
  deriveAttachmentStagingKey,
  parsePendingAttachmentId,
  pendingSourceRelativePath,
  resolveAttachmentPath,
  resolveAttachmentStagingPath,
} from '../attachments/attachmentStore.ts'
import { isSafeManagedPath, processManagedAttachmentFile } from '../attachments/attachmentFiles.ts'
import { ServerConfig } from '../config.ts'
import { parseBase64DataUrl } from '../attachments/imageMime.ts'
import { AttachmentLifecycleRepository } from '../persistence/Services/AttachmentLifecycle.ts'
import * as WorkspacePaths from '../workspace/WorkspacePaths.ts'

export const canonicalizeClientCommandTimestamps = (
  command: ClientOrchestrationCommand,
  receivedAt: IsoDateTime,
): ClientOrchestrationCommand =>
{
  const canonicalCommand =
    'createdAt' in command
      ? {
          ...command,
          createdAt: receivedAt,
        }
      : command

  if (canonicalCommand.type !== 'thread.turn.start' || !canonicalCommand.bootstrap?.createThread)
  {
    return canonicalCommand
  }

  return {
    ...canonicalCommand,
    bootstrap: {
      ...canonicalCommand.bootstrap,
      createThread: {
        ...canonicalCommand.bootstrap.createThread,
        createdAt: receivedAt,
      },
    },
  }
}

const normalizeCommand = (command: ClientOrchestrationCommand) =>
  Effect.gen(function* ()
  {
    const receivedAt = DateTime.formatIso(yield* DateTime.now)
    const canonicalCommand = canonicalizeClientCommandTimestamps(command, receivedAt)
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const serverConfig = yield* ServerConfig
    const workspacePaths = yield* WorkspacePaths.WorkspacePaths

    const normalizeProjectWorkspaceRoot = (workspaceRoot: string) =>
      workspacePaths.normalizeWorkspaceRoot(workspaceRoot).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationDispatchCommandError({
              message: cause.message,
            }),
        ),
      )

    const normalizeProjectWorkspaceRootForCreate = (
      workspaceRoot: string,
      createIfMissing: boolean | undefined,
    ) =>
      workspacePaths
        .normalizeWorkspaceRoot(workspaceRoot, {
          createIfMissing: createIfMissing === true,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationDispatchCommandError({
                message: cause.message,
              }),
          ),
        )

    if (canonicalCommand.type === 'project.create')
    {
      return {
        ...canonicalCommand,
        workspaceRoot: yield* normalizeProjectWorkspaceRootForCreate(
          canonicalCommand.workspaceRoot,
          canonicalCommand.createWorkspaceRootIfMissing,
        ),
        createWorkspaceRootIfMissing: canonicalCommand.createWorkspaceRootIfMissing === true,
      } satisfies OrchestrationCommand
    }

    if (
      canonicalCommand.type === 'project.meta.update' &&
      canonicalCommand.workspaceRoot !== undefined
    )
    {
      return {
        ...canonicalCommand,
        workspaceRoot: yield* normalizeProjectWorkspaceRoot(canonicalCommand.workspaceRoot),
      } satisfies OrchestrationCommand
    }

    if (canonicalCommand.type === 'thread.create')
    {
      return {
        ...canonicalCommand,
        origin: null as never,
      } satisfies OrchestrationCommand
    }

    if (canonicalCommand.type !== 'thread.turn.start')
    {
      return canonicalCommand as OrchestrationCommand
    }

    const attachmentLifecycle = yield* AttachmentLifecycleRepository
    const sql = yield* SqlClient.SqlClient
    const preparedAttachments = yield* Effect.forEach(
      canonicalCommand.message.attachments,
      (attachment, attachmentIndex) =>
        Effect.gen(function* ()
        {
          const stagingKey = deriveAttachmentStagingKey({
            commandId: canonicalCommand.commandId,
            messageId: canonicalCommand.message.messageId,
            attachmentIndex,
          })
          if (!('dataUrl' in attachment))
          {
            const pending = parsePendingAttachmentId(attachment.id)
            const pendingRelativePath = attachmentRelativePath(attachment)
            if (!pending || pending.type !== attachment.type || !pendingRelativePath)
            {
              return yield* new OrchestrationDispatchCommandError({
                message: `Invalid uploaded attachment '${attachment.name}'.`,
              })
            }
            const existing = yield* attachmentLifecycle.getByStagingKey(stagingKey)
            const accepted =
              Option.isSome(existing) &&
              existing.value.state === 'owned' &&
              pendingSourceRelativePath(stagingKey, existing.value.stagingRelativePath) ===
                pendingRelativePath
                ? existing.value
                : null
            const contentDigest =
              accepted?.contentDigest ??
              (yield* processManagedAttachmentFile({
                attachmentsDir: serverConfig.attachmentsDir,
                relativePath: pendingRelativePath,
                expectedSize: attachment.sizeBytes,
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationDispatchCommandError({
                      message: `Uploaded attachment '${attachment.name}' is missing or invalid.`,
                      cause,
                    }),
                ),
              ))
            return {
              attachment,
              attachmentIndex,
              bytes: null,
              pendingRelativePath,
              contentDigest,
              mimeType: attachment.mimeType,
              sizeBytes: attachment.sizeBytes,
              stagingKey,
            }
          }
          const parsed = parseBase64DataUrl(attachment.dataUrl)
          if (!parsed || !parsed.mimeType.startsWith('image/'))
          {
            return yield* new OrchestrationDispatchCommandError({
              message: `Invalid image attachment payload for '${attachment.name}'.`,
            })
          }

          const bytes = Buffer.from(parsed.base64, 'base64')
          if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)
          {
            return yield* new OrchestrationDispatchCommandError({
              message: `Image attachment '${attachment.name}' is empty or too large.`,
            })
          }

          return {
            attachment,
            attachmentIndex,
            bytes,
            pendingRelativePath: undefined,
            sizeBytes: bytes.byteLength,
            contentDigest: attachmentContentDigest(bytes),
            mimeType: parsed.mimeType.toLowerCase(),
            stagingKey,
          }
        }),
      { concurrency: 1 },
    )

    const stagedAttachments = yield* Effect.forEach(
      preparedAttachments,
      (prepared) =>
        Effect.gen(function* ()
        {
          const existing = yield* attachmentLifecycle.getByStagingKey(prepared.stagingKey)
          const attachmentId = Option.isSome(existing)
            ? existing.value.attachmentId
            : createAttachmentId(
                canonicalCommand.threadId,
                prepared.attachment.type === 'file'
                  ? parsePendingAttachmentId(prepared.attachment.id)!.extension
                  : undefined,
              )
          if (!attachmentId)
          {
            return yield* new OrchestrationDispatchCommandError({
              message: 'Failed to create a safe attachment id.',
            })
          }

          const persistedAttachment = {
            type: prepared.attachment.type,
            id: attachmentId,
            name: prepared.attachment.name,
            mimeType: prepared.mimeType,
            sizeBytes: prepared.sizeBytes,
          }
          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment: persistedAttachment,
          })
          const stagingPath = resolveAttachmentStagingPath({
            attachmentsDir: serverConfig.attachmentsDir,
            stagingKey: prepared.stagingKey,
            attachment: persistedAttachment,
            ...(prepared.pendingRelativePath === undefined
              ? {}
              : { pendingRelativePath: prepared.pendingRelativePath }),
          })
          const relativePath = attachmentRelativePath(persistedAttachment)
          const stagingRelativePath = attachmentStagingRelativePath({
            stagingKey: prepared.stagingKey,
            attachment: persistedAttachment,
            ...(prepared.pendingRelativePath === undefined
              ? {}
              : { pendingRelativePath: prepared.pendingRelativePath }),
          })
          if (!attachmentPath || !stagingPath || !relativePath || !stagingRelativePath)
          {
            return yield* new OrchestrationDispatchCommandError({
              message: `Failed to resolve persisted path for '${prepared.attachment.name}'.`,
            })
          }

          const row = yield* attachmentLifecycle
            .stage({
              stagingKey: prepared.stagingKey,
              commandId: canonicalCommand.commandId,
              threadId: canonicalCommand.threadId,
              messageId: canonicalCommand.message.messageId,
              attachmentIndex: prepared.attachmentIndex,
              attachmentId,
              stagingRelativePath,
              relativePath,
              mimeType: prepared.mimeType,
              byteCount: prepared.sizeBytes,
              contentDigest: prepared.contentDigest,
              now: receivedAt,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationDispatchCommandError({
                    message: `Failed to stage attachment '${prepared.attachment.name}'.`,
                    cause,
                  }),
              ),
            )

          return {
            ...prepared,
            persistedAttachment,
            attachmentPath,
            stagingPath,
            relativePath,
            stagingRelativePath,
            row,
          }
        }),
      { concurrency: 1 },
    ).pipe(
      Effect.catch((cause) =>
        attachmentLifecycle
          .markDispatchFailure({
            commandId: canonicalCommand.commandId,
            reason: 'attachment_staging_failed',
            now: receivedAt,
          })
          .pipe(Effect.andThen(Effect.fail(cause))),
      ),
    )

    const fileMatches = (filePath: string, expectedDigest: string, expectedSize: number) =>
      fileSystem
        .exists(filePath)
        .pipe(
          Effect.flatMap((exists) =>
            exists
              ? fileSystem
                  .readFile(filePath)
                  .pipe(
                    Effect.map(
                      (contents) =>
                        contents.byteLength === expectedSize &&
                        attachmentContentDigest(contents) === expectedDigest,
                    ),
                  )
              : Effect.succeed(false),
          ),
        )

    const promoteAttachments = Effect.forEach(
      stagedAttachments,
      (staged) =>
        Effect.gen(function* ()
        {
          const current = yield* attachmentLifecycle.getByStagingKey(staged.stagingKey)
          if (Option.isNone(current) || current.value.generation !== staged.row.generation)
            return yield* new OrchestrationDispatchCommandError({
              message: 'Attachment staging generation changed before promotion.',
            })
          if (current.value.state === 'owned')
          {
            return
          }
          if (staged.pendingRelativePath !== undefined)
          {
            const matches = (relativePath: string) =>
              processManagedAttachmentFile({
                attachmentsDir: serverConfig.attachmentsDir,
                relativePath,
                expectedSize: staged.sizeBytes,
              }).pipe(
                Effect.map((digest) => digest === staged.contentDigest),
                Effect.orElseSucceed(() => false),
              )
            const copy = (from: string, to: string) =>
              Effect.gen(function* ()
              {
                if (
                  !isSafeManagedPath(
                    { attachmentsDir: serverConfig.attachmentsDir, relativePath: to },
                    true,
                  )
                )
                  return yield* new OrchestrationDispatchCommandError({
                    message: 'Unsafe attachment copy path.',
                  })
                const target = path.join(serverConfig.attachmentsDir, to)
                const workingRelativePath = `${staged.stagingRelativePath}.${NodeCrypto.randomUUID()}.part`
                const workingPath = path.join(serverConfig.attachmentsDir, workingRelativePath)
                yield* Effect.gen(function* ()
                {
                  const digest = yield* processManagedAttachmentFile({
                    attachmentsDir: serverConfig.attachmentsDir,
                    relativePath: from,
                    expectedSize: staged.sizeBytes,
                    copyTo: workingRelativePath,
                  })
                  if (digest !== staged.contentDigest)
                    return yield* new OrchestrationDispatchCommandError({
                      message: 'Uploaded attachment changed during staging.',
                    })
                  // only the short publication step shares the acceptance and cleanup transaction
                  yield* sql.withTransaction(
                    Effect.gen(function* ()
                    {
                      const latest = yield* attachmentLifecycle.getByStagingKey(staged.stagingKey)
                      if (
                        Option.isNone(latest) ||
                        latest.value.generation !== staged.row.generation
                      )
                        return yield* new OrchestrationDispatchCommandError({
                          message: 'Attachment staging generation changed during copy.',
                        })
                      if (latest.value.state === 'owned') return
                      if (latest.value.state !== 'staged')
                        return yield* new OrchestrationDispatchCommandError({
                          message: 'Attachment staging claim was rejected during copy.',
                        })
                      if (
                        !isSafeManagedPath(
                          { attachmentsDir: serverConfig.attachmentsDir, relativePath: to },
                          true,
                        )
                      )
                        return yield* new OrchestrationDispatchCommandError({
                          message: 'Unsafe attachment publication path.',
                        })
                      yield* fileSystem.rename(workingPath, target)
                    }),
                  )
                }).pipe(
                  Effect.ensuring(
                    fileSystem.remove(workingPath, { force: true }).pipe(Effect.ignore),
                  ),
                )
              })
            if (!(yield* matches(staged.relativePath)))
            {
              if (!(yield* matches(staged.stagingRelativePath)))
                yield* copy(staged.pendingRelativePath, staged.stagingRelativePath)
              yield* copy(staged.stagingRelativePath, staged.relativePath)
            }
            yield* attachmentLifecycle.markPromoted({
              stagingKey: staged.stagingKey,
              now: receivedAt,
            })
            return
          }
          if (yield* fileMatches(staged.attachmentPath, staged.contentDigest, staged.sizeBytes))
          {
            yield* attachmentLifecycle.markPromoted({
              stagingKey: staged.stagingKey,
              now: receivedAt,
            })
            return
          }

          yield* fileSystem.makeDirectory(path.dirname(staged.stagingPath), { recursive: true })
          if (!(yield* fileMatches(staged.stagingPath, staged.contentDigest, staged.sizeBytes)))
          {
            yield* fileSystem.writeFile(staged.stagingPath, staged.bytes!)
          }
          yield* fileSystem.makeDirectory(path.dirname(staged.attachmentPath), { recursive: true })
          yield* fileSystem.copyFile(staged.stagingPath, staged.attachmentPath)
          if (
            !(yield* fileMatches(staged.attachmentPath, staged.contentDigest, staged.sizeBytes))
          )
          {
            return yield* new OrchestrationDispatchCommandError({
              message: `Failed to verify persisted attachment '${staged.attachment.name}'.`,
            })
          }
          yield* attachmentLifecycle.markPromoted({
            stagingKey: staged.stagingKey,
            now: receivedAt,
          })
        }),
      { concurrency: 1, discard: true },
    )

    yield* promoteAttachments.pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationDispatchCommandError({
            message: 'Failed to persist one or more attachments.',
            cause,
          }),
      ),
      Effect.catch((cause) =>
        attachmentLifecycle
          .markDispatchFailure({
            commandId: canonicalCommand.commandId,
            reason: 'attachment_filesystem_failed',
            now: receivedAt,
          })
          .pipe(
            Effect.andThen(
              sql.withTransaction(
                Effect.forEach(
                  stagedAttachments,
                  (staged) =>
                    Effect.gen(function* ()
                    {
                      const current = yield* attachmentLifecycle.getByStagingKey(staged.stagingKey)
                      if (
                        Option.isNone(current) ||
                        current.value.state === 'owned' ||
                        current.value.generation !== staged.row.generation
                      )
                        return
                      yield* Effect.all([
                        fileSystem.remove(staged.stagingPath, { force: true }),
                        fileSystem.remove(staged.attachmentPath, { force: true }),
                      ]).pipe(Effect.ignore)
                    }),
                  { concurrency: 1, discard: true },
                ),
              ),
            ),
            Effect.andThen(Effect.fail(cause)),
          ),
      ),
    )

    return {
      ...canonicalCommand,
      message: {
        ...canonicalCommand.message,
        attachments: stagedAttachments.map((staged) => staged.persistedAttachment),
      },
    } satisfies OrchestrationCommand
  })

export const normalizeDispatchCommand = (command: ClientOrchestrationCommand) =>
  Effect.gen(function* ()
  {
    if (command.type !== 'thread.turn.start') return yield* normalizeCommand(command)
    const lifecycle = yield* AttachmentLifecycleRepository
    return yield* lifecycle.withCommandPermit(command.commandId, normalizeCommand(command))
  })
