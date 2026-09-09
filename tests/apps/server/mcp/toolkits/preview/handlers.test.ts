// tests/apps/server/mcp/toolkits/preview/handlers.test.ts
// verify preview recording transfer claims

import * as NodeServices from '@effect/platform-node/NodeServices'
import { expect, it } from '@effect/vitest'
import { EnvironmentId, ProviderDriverKind, ProviderInstanceId, ThreadId } from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'

import * as ServerConfig from '../../../../../../apps/server/src/config.ts'
import { createPendingAttachmentId } from '../../../../../../apps/server/src/attachments/attachmentStore.ts'
import { claimPreviewRecording } from '../../../../../../apps/server/src/mcp/toolkits/preview/handlers.ts'
import type { McpInvocationScope } from '../../../../../../apps/server/src/mcp/McpInvocationContext.ts'
import { AttachmentLifecycleRepositoryLive } from '../../../../../../apps/server/src/persistence/Layers/AttachmentLifecycle.ts'
import { SqlitePersistenceMemory } from '../../../../../../apps/server/src/persistence/Layers/Sqlite.ts'
import { AttachmentLifecycleRepository } from '../../../../../../apps/server/src/persistence/Services/AttachmentLifecycle.ts'
import * as ProjectionSnapshotQuery from '../../../../../../apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts'
import { ProviderService } from '../../../../../../apps/server/src/provider/Services/ProviderService.ts'

const state = {
  threadActive: true,
  providerSessionGeneration: 7,
  snapshotSequence: 41,
}
const threadId = ThreadId.make('thread-1')
const providerInstanceId = ProviderInstanceId.make('provider-1')
const invocationScope: McpInvocationScope = {
  environmentId: EnvironmentId.make('environment-1'),
  threadId,
  providerSessionId: 'provider-session-1',
  providerInstanceId,
  providerSessionGeneration: 7,
  capabilities: new Set(['preview']),
  issuedAt: 0,
}

const recordingTestLayer = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), { prefix: 't3-preview-recording-' }),
  AttachmentLifecycleRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
  Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
    getThreadDetailSnapshot: () =>
      Effect.succeed(
        state.threadActive
          ? Option.some({ snapshotSequence: state.snapshotSequence, thread: {} as never })
          : Option.none(),
      ),
  }),
  Layer.mock(ProviderService)({
    captureSessionIdentity: () =>
      Effect.succeed(
        state.threadActive
          ? Option.some({
              provider: ProviderDriverKind.make('codex'),
              providerInstanceId,
              threadId,
              sessionGeneration: state.providerSessionGeneration,
              createdAt: '2026-09-07T00:00:00.000Z',
            })
          : Option.none(),
      ),
  }),
).pipe(Layer.provideMerge(NodeServices.layer))

it.effect('claims one completed recording for its requesting thread exactly once', () =>
  Effect.gen(function* ()
  {
    state.threadActive = true
    state.providerSessionGeneration = 7
    state.snapshotSequence = 41
    const config = yield* ServerConfig.ServerConfig
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const lifecycle = yield* AttachmentLifecycleRepository
    const uploadedAttachmentId = createPendingAttachmentId('file', '.webm')
    const pendingPath = path.join(config.attachmentsDir, `${uploadedAttachmentId}.webm`)
    yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true })
    yield* fileSystem.writeFileString(pendingPath, 'video!')
    const response = {
      id: 'desktop-recording',
      tabId: 'tab-1',
      path: '/desktop/recording.webm',
      mimeType: 'video/webm',
      sizeBytes: 6,
      createdAt: '2026-09-07T00:00:00.000Z',
      uploadedAttachmentId,
    }

    const claim = claimPreviewRecording(invocationScope, response)
    const [first, second] = yield* Effect.all([claim, claim], { concurrency: 'unbounded' })

    expect(first).toEqual(second)
    expect(first.id).toMatch(/^thread-1-[0-9a-f-]+-webm$/)
    expect(first.path).not.toBe(response.path)
    expect(yield* fileSystem.exists(first.path)).toBe(true)
    expect(yield* fileSystem.exists(pendingPath)).toBe(false)
    const owned = yield* lifecycle.getByThreadId(threadId)
    expect(owned).toHaveLength(1)
    expect(owned[0]).toMatchObject({
      state: 'owned',
      ownerSequence: 41,
      ownerEventType: 'preview.recording-transferred',
    })

    // a repeated claim after service reconstruction reuses the durable owner.
    expect(yield* claim).toEqual(first)
    expect(yield* lifecycle.getByThreadId(threadId)).toHaveLength(1)

    const wrongThread = yield* claimPreviewRecording(
      { ...invocationScope, threadId: ThreadId.make('thread-2') },
      response,
    ).pipe(Effect.result)
    expect(wrongThread._tag).toBe('Failure')
    const traversal = yield* claimPreviewRecording(invocationScope, {
      ...response,
      uploadedAttachmentId: `../${uploadedAttachmentId}`,
    }).pipe(Effect.result)
    expect(traversal._tag).toBe('Failure')

    // a deleted/recreated thread cannot accept an old provider generation.
    state.providerSessionGeneration = 8
    const staleOwner = yield* claim.pipe(Effect.result)
    expect(staleOwner._tag).toBe('Failure')
    expect(yield* lifecycle.getByThreadId(threadId)).toHaveLength(1)
  }).pipe(Effect.provide(recordingTestLayer)),
)

it.effect('rejects incomplete and legacy recording transfer responses', () =>
  Effect.gen(function* ()
  {
    state.threadActive = true
    state.providerSessionGeneration = 7
    const config = yield* ServerConfig.ServerConfig
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const uploadedAttachmentId = createPendingAttachmentId('file', '.webm')
    const pendingPath = path.join(config.attachmentsDir, `${uploadedAttachmentId}.webm`)
    yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true })
    yield* fileSystem.writeFileString(pendingPath, 'video!')
    const incomplete = yield* claimPreviewRecording(invocationScope, {
      id: 'desktop-recording',
      tabId: 'tab-1',
      path: '/desktop/recording.webm',
      mimeType: 'video/webm',
      sizeBytes: 5,
      createdAt: '2026-09-07T00:00:00.000Z',
      uploadedAttachmentId,
    }).pipe(Effect.result)
    expect(incomplete._tag).toBe('Failure')
    expect(yield* fileSystem.exists(pendingPath)).toBe(true)

    const legacy = yield* claimPreviewRecording(invocationScope, {
      id: 'desktop-recording',
      tabId: 'tab-1',
      path: '/desktop/recording.webm',
      mimeType: 'video/webm',
      sizeBytes: 6,
      createdAt: '2026-09-07T00:00:00.000Z',
    }).pipe(Effect.result)
    expect(legacy._tag).toBe('Failure')
    if (legacy._tag === 'Failure')
    {
      expect(legacy.failure._tag).toBe('PreviewAutomationRecordingDesktopUpdateRequiredError')
    }
  }).pipe(Effect.provide(recordingTestLayer)),
)

it.effect('rejects a deleted pending upload and never follows an upload symlink', () =>
  Effect.gen(function* ()
  {
    state.threadActive = true
    state.providerSessionGeneration = 7
    const config = yield* ServerConfig.ServerConfig
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const uploadedAttachmentId = createPendingAttachmentId('file', '.webm')
    const pendingPath = path.join(config.attachmentsDir, `${uploadedAttachmentId}.webm`)
    const outsidePath = path.join(config.attachmentsDir, 'outside.webm')
    yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true })
    const response = {
      id: 'desktop-recording',
      tabId: 'tab-1',
      path: '/desktop/recording.webm',
      mimeType: 'video/webm',
      sizeBytes: 6,
      createdAt: '2026-09-07T00:00:00.000Z',
      uploadedAttachmentId,
    }

    expect((yield* claimPreviewRecording(invocationScope, response).pipe(Effect.result))._tag).toBe(
      'Failure',
    )
    yield* fileSystem.writeFileString(outsidePath, 'video!')
    yield* fileSystem.symlink(outsidePath, pendingPath)
    expect((yield* claimPreviewRecording(invocationScope, response).pipe(Effect.result))._tag).toBe(
      'Failure',
    )
    expect(yield* fileSystem.readFileString(outsidePath)).toBe('video!')
  }).pipe(Effect.provide(recordingTestLayer)),
)
