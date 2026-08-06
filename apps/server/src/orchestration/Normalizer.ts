// apps/server/src/orchestration/Normalizer.ts
// canonicalizes and validates client orchestration commands before dispatch
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
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
  resolveAttachmentPath,
  resolveAttachmentStagingPath,
} from '../attachmentStore.ts'
import { ServerConfig } from '../config.ts'
import { parseBase64DataUrl } from '../imageMime.ts'
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

export const normalizeDispatchCommand = (command: ClientOrchestrationCommand) =>
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
    const preparedAttachments = yield* Effect.forEach(
      canonicalCommand.message.attachments,
      (attachment, attachmentIndex) =>
        Effect.gen(function* ()
        {
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
            contentDigest: attachmentContentDigest(bytes),
            mimeType: parsed.mimeType.toLowerCase(),
            stagingKey: deriveAttachmentStagingKey({
              commandId: canonicalCommand.commandId,
              messageId: canonicalCommand.message.messageId,
              attachmentIndex,
            }),
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
            : createAttachmentId(canonicalCommand.threadId)
          if (!attachmentId)
          {
            return yield* new OrchestrationDispatchCommandError({
              message: 'Failed to create a safe attachment id.',
            })
          }

          const persistedAttachment = {
            type: 'image' as const,
            id: attachmentId,
            name: prepared.attachment.name,
            mimeType: prepared.mimeType,
            sizeBytes: prepared.bytes.byteLength,
          }
          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment: persistedAttachment,
          })
          const stagingPath = resolveAttachmentStagingPath({
            attachmentsDir: serverConfig.attachmentsDir,
            stagingKey: prepared.stagingKey,
            attachment: persistedAttachment,
          })
          if (!attachmentPath || !stagingPath)
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
              stagingRelativePath: attachmentStagingRelativePath({
                stagingKey: prepared.stagingKey,
                attachment: persistedAttachment,
              }),
              relativePath: attachmentRelativePath(persistedAttachment),
              mimeType: prepared.mimeType,
              byteCount: prepared.bytes.byteLength,
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

          return { ...prepared, persistedAttachment, attachmentPath, stagingPath, row }
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
          if (staged.row.state === 'owned')
          {
            return
          }
          if (
            yield* fileMatches(staged.attachmentPath, staged.contentDigest, staged.bytes.byteLength)
          )
          {
            yield* attachmentLifecycle.markPromoted({
              stagingKey: staged.stagingKey,
              now: receivedAt,
            })
            return
          }

          yield* fileSystem.makeDirectory(path.dirname(staged.stagingPath), { recursive: true })
          if (
            !(yield* fileMatches(staged.stagingPath, staged.contentDigest, staged.bytes.byteLength))
          )
          {
            yield* fileSystem.writeFile(staged.stagingPath, staged.bytes)
          }
          yield* fileSystem.makeDirectory(path.dirname(staged.attachmentPath), { recursive: true })
          yield* fileSystem.copyFile(staged.stagingPath, staged.attachmentPath)
          if (
            !(yield* fileMatches(
              staged.attachmentPath,
              staged.contentDigest,
              staged.bytes.byteLength,
            ))
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
              Effect.forEach(
                stagedAttachments.filter((staged) => staged.row.state !== 'owned'),
                (staged) =>
                  Effect.all([
                    fileSystem.remove(staged.stagingPath, { force: true }),
                    fileSystem.remove(staged.attachmentPath, { force: true }),
                  ]).pipe(Effect.ignore),
                { concurrency: 1, discard: true },
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
