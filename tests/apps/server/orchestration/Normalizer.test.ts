// tests/apps/server/orchestration/Normalizer.test.ts
// verifies client orchestration command canonicalization and provenance stripping
import * as NodeServices from '@effect/platform-node/NodeServices'
import { it } from '@effect/vitest'
import {
  CommandId,
  type ClientOrchestrationCommand,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ThreadOrigin,
} from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as PlatformError from 'effect/PlatformError'
import * as Path from 'effect/Path'
import { describe, expect } from 'vite-plus/test'

import { ServerConfig } from '../../../../apps/server/src/config.ts'
import {
  resolveAttachmentPath,
  resolveAttachmentStagingPath,
} from '../../../../apps/server/src/attachmentStore.ts'
import {
  canonicalizeClientCommandTimestamps,
  normalizeDispatchCommand,
} from '../../../../apps/server/src/orchestration/Normalizer.ts'
import { AttachmentLifecycleRepositoryLive } from '../../../../apps/server/src/persistence/Layers/AttachmentLifecycle.ts'
import { SqlitePersistenceMemory } from '../../../../apps/server/src/persistence/Layers/Sqlite.ts'
import { AttachmentLifecycleRepository } from '../../../../apps/server/src/persistence/Services/AttachmentLifecycle.ts'
import * as WorkspacePaths from '../../../../apps/server/src/workspace/WorkspacePaths.ts'

const clientCreatedAt = '2031-01-01T00:00:00.000Z'
const serverReceivedAt = '2026-07-18T00:00:00.000Z'
const forgedOrigin: ThreadOrigin = {
  kind: 'imported',
  source: 'codex-cli',
  sourcePath: '/tmp/forged-session.jsonl',
  contentHash: 'forged-content-hash',
  nativeSessionId: 'forged-native-session',
  providerInstanceId: ProviderInstanceId.make('codex'),
  importedAt: clientCreatedAt,
}

const normalizerTestLayer = Layer.empty.pipe(
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), {
      prefix: 't3-normalizer-test-',
    }),
  ),
  Layer.provideMerge(
    AttachmentLifecycleRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
  ),
  Layer.provideMerge(NodeServices.layer),
)

const makeThreadCreateCommand = (origin?: ThreadOrigin): ClientOrchestrationCommand =>
{
  const command = {
    type: 'thread.create',
    commandId: CommandId.make('command-thread-create'),
    threadId: ThreadId.make('thread-1'),
    projectId: ProjectId.make('project-1'),
    title: 'Client-created thread',
    modelSelection: {
      instanceId: ProviderInstanceId.make('codex'),
      model: 'gpt-5.4',
    },
    runtimeMode: 'full-access',
    interactionMode: 'default',
    branch: null,
    worktreePath: null,
    ...(origin === undefined ? {} : { origin }),
    createdAt: clientCreatedAt,
  } as const
  return command as ClientOrchestrationCommand
}

const makeTurnStartCommand = (input?: {
  readonly commandId?: string
  readonly messageId?: string
  readonly dataUrl?: string
}): ClientOrchestrationCommand => ({
  type: 'thread.turn.start',
  commandId: CommandId.make(input?.commandId ?? 'command-attachment'),
  threadId: ThreadId.make('thread-attachment'),
  message: {
    messageId: MessageId.make(input?.messageId ?? 'message-attachment'),
    role: 'user',
    text: 'inspect image',
    attachments: [
      {
        type: 'image',
        name: 'image.png',
        mimeType: 'image/png',
        sizeBytes: 4,
        dataUrl: input?.dataUrl ?? 'data:image/png;base64,AQIDBA==',
      },
    ],
  },
  runtimeMode: 'full-access',
  interactionMode: 'default',
  createdAt: clientCreatedAt,
})

describe('canonicalizeClientCommandTimestamps', () =>
{
  it('replaces a client command timestamp with the server receipt timestamp', () =>
  {
    const command: ClientOrchestrationCommand = {
      type: 'project.create',
      commandId: CommandId.make('command-1'),
      projectId: ProjectId.make('project-1'),
      title: 'Clock-safe project',
      workspaceRoot: '/tmp/clock-safe-project',
      createdAt: clientCreatedAt,
    }

    expect(canonicalizeClientCommandTimestamps(command, serverReceivedAt)).toEqual({
      ...command,
      createdAt: serverReceivedAt,
    })
  })

  it('replaces both timestamps when the first turn bootstraps a thread', () =>
  {
    const command: ClientOrchestrationCommand = {
      type: 'thread.turn.start',
      commandId: CommandId.make('command-2'),
      threadId: ThreadId.make('thread-1'),
      message: {
        messageId: MessageId.make('message-1'),
        role: 'user',
        text: 'Start a thread',
        attachments: [],
      },
      runtimeMode: 'full-access',
      interactionMode: 'default',
      bootstrap: {
        createThread: {
          projectId: ProjectId.make('project-1'),
          title: 'Clock-safe thread',
          modelSelection: {
            instanceId: ProviderInstanceId.make('codex'),
            model: 'gpt-5.4',
          },
          runtimeMode: 'full-access',
          interactionMode: 'default',
          branch: null,
          worktreePath: null,
          createdAt: clientCreatedAt,
        },
      },
      createdAt: clientCreatedAt,
    }

    const result = canonicalizeClientCommandTimestamps(command, serverReceivedAt)

    expect(result.type).toBe('thread.turn.start')
    if (result.type !== 'thread.turn.start')
    {
      throw new Error('Expected a thread.turn.start command')
    }
    expect(result.createdAt).toBe(serverReceivedAt)
    expect(result.bootstrap?.createThread?.createdAt).toBe(serverReceivedAt)
  })
})

it.layer(normalizerTestLayer)('normalizeDispatchCommand', (it) =>
{
  it.effect('nulls forged provenance and replaces client timestamps on thread.create', () =>
    Effect.gen(function* ()
    {
      const forged = yield* normalizeDispatchCommand(makeThreadCreateCommand(forgedOrigin))
      expect(forged.type).toBe('thread.create')
      if (forged.type !== 'thread.create')
      {
        throw new Error('Expected a thread.create command')
      }
      expect(forged.origin).toBeNull()

      const command = makeThreadCreateCommand()
      const result = yield* normalizeDispatchCommand(command)
      expect(result).toEqual({
        ...command,
        origin: null,
        createdAt: expect.any(String),
      })
      if (result.type !== 'thread.create')
      {
        throw new Error('Expected a thread.create command')
      }
      expect(result.createdAt).not.toBe(clientCreatedAt)
    }),
  )

  it.effect('commits staging before writing and reuses attachment identity on retry', () =>
    Effect.gen(function* ()
    {
      const repository = yield* AttachmentLifecycleRepository
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const events: string[] = []
      const observedRepository = AttachmentLifecycleRepository.of({
        ...repository,
        stage: (input) =>
          repository.stage(input).pipe(Effect.tap(() => Effect.sync(() => events.push('stage')))),
      })
      const observedFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        writeFile: (filePath, data, options) =>
          Effect.sync(() => events.push(`write:${filePath}`)).pipe(
            Effect.andThen(fileSystem.writeFile(filePath, data, options)),
          ),
      })

      const command = makeTurnStartCommand()
      const first = yield* normalizeDispatchCommand(command).pipe(
        Effect.provideService(AttachmentLifecycleRepository, observedRepository),
        Effect.provideService(FileSystem.FileSystem, observedFileSystem),
      )
      expect(events[0]).toBe('stage')
      expect(events.some((event) => event.startsWith('write:'))).toBe(true)

      const second = yield* normalizeDispatchCommand(command)
      expect(first.type).toBe('thread.turn.start')
      expect(second.type).toBe('thread.turn.start')
      if (first.type === 'thread.turn.start' && second.type === 'thread.turn.start')
      {
        expect(second.message.attachments[0]?.id).toBe(first.message.attachments[0]?.id)
        const attachment = first.message.attachments[0]
        const rows = yield* repository.getByCommandId(command.commandId)
        const config = yield* ServerConfig
        if (attachment && rows[0])
        {
          const finalPath = resolveAttachmentPath({
            attachmentsDir: config.attachmentsDir,
            attachment,
          })
          const stagingPath = resolveAttachmentStagingPath({
            attachmentsDir: config.attachmentsDir,
            stagingKey: rows[0].stagingKey,
            attachment,
          })
          expect(finalPath).not.toBeNull()
          expect(stagingPath).not.toBeNull()
          if (finalPath && stagingPath)
          {
            yield* fileSystem.remove(stagingPath, { force: true })
            yield* normalizeDispatchCommand(command)
            expect(yield* fileSystem.exists(finalPath)).toBe(true)
            expect(yield* fileSystem.exists(stagingPath)).toBe(false)

            yield* fileSystem.makeDirectory(path.dirname(stagingPath), { recursive: true })
            yield* fileSystem.writeFile(stagingPath, Uint8Array.from([1, 2, 3, 4]))
            yield* fileSystem.remove(finalPath, { force: true })
            yield* normalizeDispatchCommand(command)
            expect(yield* fileSystem.exists(finalPath)).toBe(true)
            expect(yield* fileSystem.exists(stagingPath)).toBe(true)

            yield* normalizeDispatchCommand(command)
            expect(yield* fileSystem.exists(finalPath)).toBe(true)
            expect(yield* fileSystem.exists(stagingPath)).toBe(true)
          }
        }
      }
    }),
  )

  it.effect('validates every attachment before any filesystem write', () =>
    Effect.gen(function* ()
    {
      const fileSystem = yield* FileSystem.FileSystem
      let writes = 0
      const observedFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        writeFile: (filePath, data, options) =>
        {
          writes += 1
          return fileSystem.writeFile(filePath, data, options)
        },
      })
      const exit = yield* Effect.exit(
        normalizeDispatchCommand(makeTurnStartCommand({ dataUrl: 'not-a-data-url' })).pipe(
          Effect.provideService(FileSystem.FileSystem, observedFileSystem),
        ),
      )
      expect(exit._tag).toBe('Failure')
      expect(writes).toBe(0)
    }),
  )

  it.effect('records cleanup intent and removes partial files after a write fault', () =>
    Effect.gen(function* ()
    {
      const repository = yield* AttachmentLifecycleRepository
      const fileSystem = yield* FileSystem.FileSystem
      let failed = false
      const failure = PlatformError.systemError({
        _tag: 'UnexpectedEof',
        module: 'FileSystem',
        method: 'writeFile',
        pathOrDescriptor: 'attachment',
      })
      const failingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        writeFile: (filePath, data, options) =>
          failed
            ? fileSystem.writeFile(filePath, data, options)
            : fileSystem.writeFile(filePath, data, options).pipe(
                Effect.andThen(
                  Effect.sync(() =>
                    {
                    failed = true
                  }),
                ),
                Effect.andThen(Effect.fail(failure)),
              ),
      })
      const command = makeTurnStartCommand({
        commandId: 'command-partial-write',
        messageId: 'message-partial-write',
      })
      const exit = yield* Effect.exit(
        normalizeDispatchCommand(command).pipe(
          Effect.provideService(FileSystem.FileSystem, failingFileSystem),
        ),
      )
      expect(exit._tag).toBe('Failure')
      const rows = yield* repository.getByCommandId(command.commandId)
      expect(rows[0]?.state).toBe('cleanup_pending')
      const diagnostics = yield* repository.listDiagnostics()
      expect(
        diagnostics.cleanup.some((cleanup) => cleanup.stagingKey === rows[0]?.stagingKey),
      ).toBe(true)
      if (rows[0])
      {
        const config = yield* ServerConfig
        const finalPath = resolveAttachmentPath({
          attachmentsDir: config.attachmentsDir,
          attachment: {
            type: 'image',
            id: rows[0].attachmentId,
            name: 'image.png',
            mimeType: rows[0].mimeType,
            sizeBytes: rows[0].byteCount,
          },
        })
        const stagingPath = resolveAttachmentStagingPath({
          attachmentsDir: config.attachmentsDir,
          stagingKey: rows[0].stagingKey,
          attachment: {
            type: 'image',
            id: rows[0].attachmentId,
            name: 'image.png',
            mimeType: rows[0].mimeType,
            sizeBytes: rows[0].byteCount,
          },
        })
        expect(finalPath).not.toBeNull()
        expect(stagingPath).not.toBeNull()
        if (stagingPath)
        {
          expect(yield* fileSystem.exists(stagingPath)).toBe(false)
        }
        if (finalPath)
        {
          expect(yield* fileSystem.exists(finalPath)).toBe(false)
        }
      }
    }),
  )

  it.effect('records cleanup intent for directory and promotion faults', () =>
    Effect.gen(function* ()
    {
      const repository = yield* AttachmentLifecycleRepository
      const fileSystem = yield* FileSystem.FileSystem
      const failure = PlatformError.systemError({
        _tag: 'PermissionDenied',
        module: 'FileSystem',
        method: 'attachmentLifecycle',
        pathOrDescriptor: 'attachment',
      })
      const directoryFailure = FileSystem.FileSystem.of({
        ...fileSystem,
        makeDirectory: () => Effect.fail(failure),
      })
      const promotionFailure = FileSystem.FileSystem.of({
        ...fileSystem,
        copyFile: () => Effect.fail(failure),
      })
      const cases = [
        {
          command: makeTurnStartCommand({
            commandId: 'command-directory-fault',
            messageId: 'message-directory-fault',
          }),
          fileSystem: directoryFailure,
        },
        {
          command: makeTurnStartCommand({
            commandId: 'command-promotion-fault',
            messageId: 'message-promotion-fault',
          }),
          fileSystem: promotionFailure,
        },
      ]

      yield* Effect.forEach(
        cases,
        ({ command, fileSystem: failingFileSystem }) =>
          Effect.gen(function* ()
          {
            const exit = yield* Effect.exit(
              normalizeDispatchCommand(command).pipe(
                Effect.provideService(FileSystem.FileSystem, failingFileSystem),
              ),
            )
            expect(exit._tag).toBe('Failure')
            const rows = yield* repository.getByCommandId(command.commandId)
            expect(rows[0]?.state).toBe('cleanup_pending')
            const diagnostics = yield* repository.listDiagnostics()
            expect(diagnostics.cleanup.some((row) => row.stagingKey === rows[0]?.stagingKey)).toBe(
              true,
            )
          }),
        { concurrency: 1, discard: true },
      )
    }),
  )
})
