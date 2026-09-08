// apps/server/src/mcp/toolkits/preview/handlers.ts
// expose preview standard toolkit handlers live

import * as Effect from 'effect/Effect'
import * as DateTime from 'effect/DateTime'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import {
  CommandId,
  MessageId,
  PREVIEW_RECORDING_STOP_TIMEOUT_MS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PreviewAutomationRecordingDesktopUpdateRequiredError,
  PreviewAutomationRecordingTransferArtifact,
  PreviewAutomationRecordingTransferError,
  type PreviewAutomationOperation,
  type PreviewAutomationRecordingArtifact,
  type PreviewAutomationRecordingStatus,
  type PreviewAutomationResizeResult,
  type PreviewAutomationSetColorSchemeResult,
  type PreviewAutomationSnapshot,
  type PreviewAutomationStatus,
  type PreviewTabId,
  type ThreadId,
} from '@t3tools/contracts'

import {
  deriveAttachmentStagingKey,
  parseAttachmentFileExtension,
  parsePendingAttachmentId,
  toSafeThreadAttachmentSegment,
} from '../../../attachments/attachmentStore.ts'
import { processManagedAttachmentFile } from '../../../attachments/attachmentFiles.ts'
import { resolveAttachmentRelativePath } from '../../../attachments/attachmentPaths.ts'
import { deletePendingAttachment } from '../../../assets/AttachmentUpload.ts'
import * as ServerConfig from '../../../config.ts'
import * as ProjectionSnapshotQuery from '../../../orchestration/Services/ProjectionSnapshotQuery.ts'
import { AttachmentLifecycleRepository } from '../../../persistence/Services/AttachmentLifecycle.ts'
import { ProviderService } from '../../../provider/Services/ProviderService.ts'
import * as McpInvocationContext from '../../McpInvocationContext.ts'
import * as PreviewAutomationBroker from '../../PreviewAutomationBroker.ts'
import { PreviewSnapshotToolkit, PreviewStandardToolkit, PreviewToolkit } from './tools.ts'

const invoke = Effect.fn('PreviewToolkit.invoke')(function* <A>(
  operation: PreviewAutomationOperation,
  input: unknown,
  timeoutMs?: number,
  tabId?: PreviewTabId,
): Effect.fn.Return<
  A,
  import('@t3tools/contracts').PreviewAutomationError,
  McpInvocationContext.McpInvocationContext | PreviewAutomationBroker.PreviewAutomationBroker
>
{
  const scope = yield* McpInvocationContext.requireMcpCapability('preview')
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker
  return yield* broker.invoke<A>({
    scope,
    operation,
    input,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(tabId === undefined ? {} : { tabId }),
  })
})

const invokeTargeted = <A>(
  operation: PreviewAutomationOperation,
  input: {
    readonly tabId?: PreviewTabId | undefined
    readonly [key: string]: unknown
  },
  timeoutMs?: number,
) =>
{
  const { tabId, ...operationInput } = input
  return invoke<A>(operation, operationInput, timeoutMs, tabId)
}

const decodeRecordingTransferArtifact = Schema.decodeUnknownEffect(
  PreviewAutomationRecordingTransferArtifact,
)

export const claimPreviewRecording = Effect.fn('PreviewToolkit.claimRecording')(function* (
  scope: McpInvocationContext.McpInvocationScope,
  response: unknown,
)
{
  const threadId = scope.threadId
  const artifact = yield* decodeRecordingTransferArtifact(response).pipe(
    Effect.mapError(
      (cause) =>
        new PreviewAutomationRecordingTransferError({
          threadId,
          cause,
        }),
    ),
  )
  if (artifact.uploadedAttachmentId === undefined)
  {
    return yield* new PreviewAutomationRecordingDesktopUpdateRequiredError({ threadId })
  }
  const uploadedAttachmentId = artifact.uploadedAttachmentId

  const pending = parsePendingAttachmentId(artifact.uploadedAttachmentId)
  const match =
    /^pending-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-file-([a-z0-9]{1,10})$/.exec(
      artifact.uploadedAttachmentId,
    )
  const extension = parseAttachmentFileExtension(artifact.uploadedAttachmentId)
  const threadSegment = toSafeThreadAttachmentSegment(threadId)
  if (
    pending?.type !== 'file' ||
    match === null ||
    extension === null ||
    extension !== `.${match[2]}` ||
    threadSegment === null
  )
  {
    return yield* new PreviewAutomationRecordingTransferError({ threadId })
  }

  const finalId = `${threadSegment}-${match[1]}-${match[2]}`
  if (
    !Number.isSafeInteger(artifact.sizeBytes) ||
    artifact.sizeBytes <= 0 ||
    artifact.sizeBytes > PROVIDER_SEND_TURN_MAX_FILE_BYTES ||
    scope.providerSessionGeneration === undefined
  )
  {
    return yield* new PreviewAutomationRecordingTransferError({ threadId })
  }

  const config = yield* ServerConfig.ServerConfig
  const pendingRelativePath = `${artifact.uploadedAttachmentId}${extension}`
  const finalRelativePath = `${finalId}${extension}`
  const finalPath = resolveAttachmentRelativePath({
    attachmentsDir: config.attachmentsDir,
    relativePath: finalRelativePath,
  })
  if (finalPath === null)
  {
    return yield* new PreviewAutomationRecordingTransferError({ threadId })
  }

  const providerService = yield* ProviderService
  const projection = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery
  const attachmentLifecycle = yield* AttachmentLifecycleRepository
  const requireCurrentOwner = Effect.fn('PreviewToolkit.requireCurrentRecordingOwner')(
    function* ()
    {
      const identity = yield* providerService.captureSessionIdentity({
        threadId,
        expectedProviderInstanceId: scope.providerInstanceId,
      })
      if (
        Option.isNone(identity) ||
        identity.value.threadId !== threadId ||
        identity.value.providerInstanceId !== scope.providerInstanceId ||
        identity.value.sessionGeneration !== scope.providerSessionGeneration
      )
      {
        return yield* new PreviewAutomationRecordingTransferError({ threadId })
      }
      const thread = yield* projection.getThreadDetailSnapshot(threadId)
      if (Option.isNone(thread))
      {
        return yield* new PreviewAutomationRecordingTransferError({ threadId })
      }
      return thread.value.snapshotSequence
    },
  )
  yield* requireCurrentOwner().pipe(
    Effect.mapError((cause) => new PreviewAutomationRecordingTransferError({ threadId, cause })),
  )

  const commandId = CommandId.make(`preview-recording:${threadSegment}:${match[1]}`)
  const messageId = MessageId.make(`preview-recording:${match[1]}`)
  const stagingKey = deriveAttachmentStagingKey({ commandId, messageId, attachmentIndex: 0 })
  const now = DateTime.formatIso(yield* DateTime.now)

  yield* attachmentLifecycle
    .withCommandPermit(
      commandId,
      Effect.gen(function* ()
      {
        const existing = yield* attachmentLifecycle.getByStagingKey(stagingKey)
        if (Option.isSome(existing) && existing.value.state === 'owned')
        {
          if (
            existing.value.threadId !== threadId ||
            existing.value.attachmentId !== finalId ||
            existing.value.relativePath !== finalRelativePath ||
            existing.value.mimeType !== artifact.mimeType ||
            existing.value.byteCount !== artifact.sizeBytes
          )
          {
            return yield* new PreviewAutomationRecordingTransferError({ threadId })
          }
          const digest = yield* processManagedAttachmentFile({
            attachmentsDir: config.attachmentsDir,
            relativePath: finalRelativePath,
            expectedSize: artifact.sizeBytes,
          })
          if (digest !== existing.value.contentDigest)
          {
            return yield* new PreviewAutomationRecordingTransferError({ threadId })
          }
          yield* requireCurrentOwner()
          return
        }

        const contentDigest = yield* processManagedAttachmentFile({
          attachmentsDir: config.attachmentsDir,
          relativePath: pendingRelativePath,
          expectedSize: artifact.sizeBytes,
        })
        const row = yield* attachmentLifecycle.stage({
          stagingKey,
          commandId,
          threadId,
          messageId,
          attachmentIndex: 0,
          attachmentId: finalId,
          stagingRelativePath: `.staging/${stagingKey}/${finalRelativePath}`,
          relativePath: finalRelativePath,
          mimeType: artifact.mimeType,
          byteCount: artifact.sizeBytes,
          contentDigest,
          now,
        })

        if (row.state !== 'owned')
        {
          const copiedDigest = yield* processManagedAttachmentFile({
            attachmentsDir: config.attachmentsDir,
            relativePath: pendingRelativePath,
            expectedSize: artifact.sizeBytes,
            copyTo: finalRelativePath,
          }).pipe(
            // a prior interrupted claim may have published the immutable target.
            Effect.catch(() =>
              processManagedAttachmentFile({
                attachmentsDir: config.attachmentsDir,
                relativePath: finalRelativePath,
                expectedSize: artifact.sizeBytes,
              }),
            ),
          )
          if (copiedDigest !== contentDigest)
          {
            return yield* new PreviewAutomationRecordingTransferError({ threadId })
          }
          yield* attachmentLifecycle.markPromoted({ stagingKey, now })
        }

        const owner = yield* requireCurrentOwner()
        yield* attachmentLifecycle.associateAccepted({
          commandId,
          ownerSequence: owner,
          ownerEventType: 'preview.recording-transferred',
          now,
        })
        yield* deletePendingAttachment(uploadedAttachmentId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning('unable to remove claimed preview recording upload', {
              attachmentId: artifact.uploadedAttachmentId,
              cause,
            }),
          ),
        )
      }).pipe(
        Effect.onError(() =>
          attachmentLifecycle
            .markDispatchFailure({
              commandId,
              reason: 'preview_recording_transfer_failed',
              now,
            })
            .pipe(Effect.ignore),
        ),
      ),
    )
    .pipe(
      Effect.mapError((cause) => new PreviewAutomationRecordingTransferError({ threadId, cause })),
    )

  const { uploadedAttachmentId: _uploadedAttachmentId, ...recording } = artifact
  return {
    ...recording,
    id: finalId,
    path: finalPath,
  } satisfies PreviewAutomationRecordingArtifact
})

const handlers = {
  preview_status: (input) => invokeTargeted<PreviewAutomationStatus>('status', input ?? {}),
  preview_open: (input) =>
    invokeTargeted<PreviewAutomationStatus>('open', {
      ...input,
      reuseExistingTab: input.reuseExistingTab ?? true,
    }),
  preview_navigate: (input) =>
    invokeTargeted<PreviewAutomationStatus>('navigate', input, input.timeoutMs),
  preview_resize: (input) =>
    invokeTargeted<PreviewAutomationResizeResult>('resize', input, input.timeoutMs),
  preview_set_appearance: (input) =>
    invokeTargeted<PreviewAutomationSetColorSchemeResult>('setColorScheme', input),
  preview_snapshot: (input) =>
  {
    // output selection is MCP-only; the browser still produces a complete snapshot
    const { includeImage: _includeImage, ...operationInput } = input ?? {}
    return invokeTargeted<PreviewAutomationSnapshot>('snapshot', operationInput)
  },
  preview_click: (input) =>
    invokeTargeted<void>('click', input, input.timeoutMs).pipe(Effect.as({})),
  preview_type: (input) => invokeTargeted<void>('type', input, input.timeoutMs).pipe(Effect.as({})),
  preview_press: (input) => invokeTargeted<void>('press', input).pipe(Effect.as({})),
  preview_scroll: (input) => invokeTargeted<void>('scroll', input).pipe(Effect.as({})),
  preview_evaluate: (input) =>
    invokeTargeted<unknown>('evaluate', input).pipe(
      Effect.map((result) => ({ value: result ?? null })),
    ),
  preview_wait_for: (input) =>
    invokeTargeted<void>('waitFor', input, input.timeoutMs).pipe(Effect.as({})),
  preview_recording_start: (input) =>
    invokeTargeted<PreviewAutomationRecordingStatus>('recordingStart', input ?? {}),
  preview_recording_stop: (input) =>
    Effect.gen(function* ()
    {
      const scope = yield* McpInvocationContext.requireMcpCapability('preview')
      const response = yield* invokeTargeted<unknown>(
        'recordingStop',
        { ...input, transferToEnvironment: true },
        PREVIEW_RECORDING_STOP_TIMEOUT_MS,
      )
      return yield* claimPreviewRecording(scope, response)
    }),
} satisfies Parameters<typeof PreviewToolkit.toLayer>[0]

const { preview_snapshot, ...standardHandlers } = handlers

export const PreviewStandardToolkitHandlersLive = PreviewStandardToolkit.toLayer(standardHandlers)

export const PreviewSnapshotToolkitHandlersLive = PreviewSnapshotToolkit.toLayer({
  preview_snapshot,
})

export const PreviewToolkitHandlersLive = PreviewToolkit.toLayer(handlers)
