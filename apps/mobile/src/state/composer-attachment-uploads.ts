// apps/mobile/src/state/composer-attachment-uploads.ts
// uploads mobile composer images without blocking navigation or queued sends

import { useAtomValue } from '@effect/atom-react'
import {
  deletePendingAttachmentUpload,
  runAttachmentUploadCycle,
} from '@t3tools/client-runtime/state/attachments'
import {
  PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES,
  type EnvironmentId,
} from '@t3tools/contracts'
import * as Option from 'effect/Option'
import { Atom } from 'effect/unstable/reactivity'
import { useEffect, useRef } from 'react'

import {
  composerAttachmentUploadKey,
  createComposerAttachmentUploadQueue,
  type ComposerAttachmentUploadState,
} from '../lib/composerAttachmentUploadQueue'
import type { DraftComposerImageAttachment } from '../lib/composerImages'
import { scopedKeyEnvironmentId } from '../lib/scopedEntities'
import { uuidv4 } from '../lib/uuid'
import { appAtomRegistry } from './atom-registry'
import { attachmentEnvironment } from './attachments'
import { useServerConfigs } from './entities'
import { environmentSession } from './session'
import { flattenQueuedThreadMessages } from './threads/thread-outbox-model'
import { threadOutboxManager, updateThreadOutboxMessage } from './threads/thread-outbox'
import { composerDraftsAtom, setComposerDraftAttachmentUpload } from './threads/use-composer-drafts'
import { useThreadOutboxMessages } from './threads/use-thread-outbox'
import { useRemoteConnectionStatus } from './use-remote-environment-registry'

export {
  composerAttachmentUploadBlockReason,
  composerAttachmentsStillUploading,
} from '../lib/composerAttachmentUploadQueue'

export const composerAttachmentUploadsAtom = Atom.make<
  Readonly<Record<string, ComposerAttachmentUploadState>>
>({}).pipe(Atom.keepAlive, Atom.withLabel('mobile:composer-attachment-uploads'))

const uploadStateAtom = Atom.family((key: string) =>
  Atom.map(composerAttachmentUploadsAtom, (states) => states[key]),
)
let uploadQueue: ReturnType<typeof createComposerAttachmentUploadQueue> | null = null

export function useComposerAttachmentUploadState(
  environmentId: EnvironmentId | undefined,
  attachmentId: string,
): ComposerAttachmentUploadState | undefined
{
  return useAtomValue(
    uploadStateAtom(environmentId ? composerAttachmentUploadKey(environmentId, attachmentId) : ''),
  )
}

export function retryComposerAttachmentUpload(
  environmentId: EnvironmentId,
  attachmentId: string,
): void
{
  uploadQueue?.retry(environmentId, attachmentId)
}

async function uploadImage(
  environmentId: EnvironmentId,
  attachment: DraftComposerImageAttachment,
  signal: AbortSignal,
  onProgress: (progress: number) => void,
): Promise<string>
{
  const mimeType = PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES.find(
    (supported) => supported === attachment.mimeType.toLowerCase(),
  )
  if (mimeType === undefined) throw new Error(`Unsupported image format: ${attachment.mimeType}`)
  const result = await runAttachmentUploadCycle({
    registry: appAtomRegistry,
    createUploadUrl: attachmentEnvironment.createUploadUrl,
    remove: attachmentEnvironment.remove,
    environmentId,
    upload: {
      type: 'image',
      name: attachment.name,
      mimeType,
      sizeBytes: attachment.sizeBytes,
    },
    resolveHttpBaseUrl: () =>
    {
      const prepared = appAtomRegistry.get(
        environmentSession.preparedConnectionValueAtom(environmentId),
      )
      return Option.isSome(prepared) ? prepared.value.httpBaseUrl : null
    },
    onMinted: () => (signal.aborted ? 'cancel' : 'continue'),
    transport: (url) =>
    {
      const controller = new AbortController()
      const abort = () => controller.abort()
      signal.addEventListener('abort', abort, { once: true })
      const done = (async () =>
      {
        const { File, Paths, UploadType } = await import('expo-file-system')
        const file = new File(Paths.cache, `code456-upload-${uuidv4()}`)
        try
        {
          file.create({ overwrite: true })
          file.write(attachment.dataUrl.slice(attachment.dataUrl.indexOf(',') + 1), {
            encoding: 'base64',
          })
          const response = await file.upload(url, {
            httpMethod: 'POST',
            uploadType: UploadType.BINARY_CONTENT,
            headers: { 'Content-Type': attachment.mimeType },
            signal: controller.signal,
            onProgress: ({ bytesSent, totalBytes }) =>
            {
              if (totalBytes > 0) onProgress(bytesSent / totalBytes)
            },
          })
          if (response.status < 200 || response.status >= 300)
          {
            throw new Error(`Upload failed for '${attachment.name}' (${response.status}).`)
          }
        }
        finally
        {
          signal.removeEventListener('abort', abort)
          if (file.exists) file.delete()
        }
      })()
      return { done, abort }
    },
  })
  if (result.status !== 'uploaded')
  {
    if (result.status === 'failed' && result.attachmentId)
    {
      deletePendingAttachmentUpload({
        registry: appAtomRegistry,
        remove: attachmentEnvironment.remove,
        environmentId,
        attachmentId: result.attachmentId,
      })
    }
    throw result.status === 'failed'
      ? result.error
      : new Error(`Upload cancelled for '${attachment.name}'.`)
  }
  return result.attachmentId
}

export function useComposerAttachmentUploadWorker(): void
{
  const drafts = useAtomValue(composerDraftsAtom)
  const queuedMessages = useThreadOutboxMessages()
  const serverConfigs = useServerConfigs()
  const { connectedEnvironments } = useRemoteConnectionStatus()
  const queueRef = useRef<ReturnType<typeof createComposerAttachmentUploadQueue> | null>(null)

  useEffect(() =>
  {
    const queue = createComposerAttachmentUploadQueue({
      onChange: (states) => appAtomRegistry.set(composerAttachmentUploadsAtom, states),
      upload: async ({ environmentId, attachment }, signal, onProgress) =>
      {
        if (
          attachment.uploadEnvironmentId === environmentId &&
          attachment.uploadedAttachmentId !== undefined
        )
        {
          return true
        }
        const attachmentId = await uploadImage(environmentId, attachment, signal, onProgress)
        let retained = false
        const queued = flattenQueuedThreadMessages(
          appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
        )
        const queuedEnvironmentByPendingDraftKey = new Map<string, EnvironmentId>(
          queued.map(
            (message) => [`pending-task:${message.messageId}`, message.environmentId] as const,
          ),
        )
        for (const [draftKey, draft] of Object.entries(appAtomRegistry.get(composerDraftsAtom)))
        {
          const draftEnvironmentId = draftKey.startsWith('new-task:')
            ? scopedKeyEnvironmentId(draftKey.slice('new-task:'.length))
            : draftKey.startsWith('pending-task:')
              ? (queuedEnvironmentByPendingDraftKey.get(draftKey) ?? null)
              : scopedKeyEnvironmentId(draftKey)
          if (
            draftEnvironmentId === environmentId &&
            draft.attachments.some((candidate) => candidate.id === attachment.id)
          )
          {
            retained =
              setComposerDraftAttachmentUpload(
                draftKey,
                attachment.id,
                environmentId,
                attachmentId,
              ) || retained
          }
        }
        for (const message of flattenQueuedThreadMessages(
          appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
        ))
        {
          if (
            message.environmentId !== environmentId ||
            !message.attachments.some((candidate) => candidate.id === attachment.id)
          )
          {
            continue
          }
          retained =
            (await updateThreadOutboxMessage({
              ...message,
              attachments: message.attachments.map((candidate) =>
                candidate.id === attachment.id
                  ? {
                      ...candidate,
                      uploadEnvironmentId: environmentId,
                      uploadedAttachmentId: attachmentId,
                    }
                  : candidate,
              ),
            })) || retained
        }
        return retained
      },
    })
    queueRef.current = queue
    uploadQueue = queue
    return () =>
    {
      queue.dispose()
      if (uploadQueue === queue) uploadQueue = null
      queueRef.current = null
    }
  }, [])

  useEffect(() =>
  {
    const connected = new Set(
      connectedEnvironments
        .filter((environment) => environment.connectionState === 'connected')
        .map((environment) => environment.environmentId),
    )
    const queued = flattenQueuedThreadMessages(queuedMessages)
    const queuedEnvironmentByPendingDraftKey = new Map<string, EnvironmentId>(
      queued.map(
        (message) => [`pending-task:${message.messageId}`, message.environmentId] as const,
      ),
    )
    const requests = [
      ...Object.entries(drafts).flatMap(([draftKey, draft]) =>
      {
        const environmentId = draftKey.startsWith('new-task:')
          ? scopedKeyEnvironmentId(draftKey.slice('new-task:'.length))
          : draftKey.startsWith('pending-task:')
            ? (queuedEnvironmentByPendingDraftKey.get(draftKey) ?? null)
            : scopedKeyEnvironmentId(draftKey)
        if (!environmentId || !connected.has(environmentId)) return []
        return draft.attachments.map((attachment) => ({
          environmentId,
          attachment,
        }))
      }),
      ...queued.flatMap((message) =>
        connected.has(message.environmentId)
          ? message.attachments.map((attachment) => ({
              environmentId: message.environmentId,
              attachment,
            }))
          : [],
      ),
    ].filter(
      ({ environmentId }) =>
        serverConfigs.get(environmentId)?.environment.capabilities.attachmentUploads === true,
    )
    queueRef.current?.sync(requests)
  }, [connectedEnvironments, drafts, queuedMessages, serverConfigs])
}
