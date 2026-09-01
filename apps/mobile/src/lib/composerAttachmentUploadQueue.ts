// apps/mobile/src/lib/composerAttachmentUploadQueue.ts
// schedules bounded mobile composer image uploads

import type { EnvironmentId, ServerConfig } from '@t3tools/contracts'

import type { DraftComposerImageAttachment } from './composerImages'

export interface ComposerAttachmentUploadRequest
{
  readonly environmentId: EnvironmentId
  readonly attachment: DraftComposerImageAttachment
}

export type ComposerAttachmentUploadState =
  | { readonly status: 'uploading'; readonly progress: number }
  | { readonly status: 'ready' }
  | { readonly status: 'failed'; readonly reason: string }

export function composerAttachmentUploadKey(
  environmentId: EnvironmentId,
  attachmentId: string,
): string
{
  return `${environmentId}:${attachmentId}`
}

type UploadServerConfig = Pick<ServerConfig, 'environment'>

export function composerAttachmentUploadBlockReason(input: {
  readonly environmentId: EnvironmentId
  readonly attachments: ReadonlyArray<DraftComposerImageAttachment>
  readonly serverConfig: UploadServerConfig | null | undefined
  readonly states: Readonly<Record<string, ComposerAttachmentUploadState>>
}): string | null
{
  if (input.serverConfig?.environment.capabilities.attachmentUploads !== true) return null
  for (const attachment of input.attachments)
  {
    const state = input.states[composerAttachmentUploadKey(input.environmentId, attachment.id)]
    if (state?.status === 'failed') return 'Retry or remove the failed attachment'
    if (state?.status !== 'ready') return 'Attachment still uploading'
  }
  return null
}

export function createComposerAttachmentUploadQueue(options: {
  readonly upload: (
    request: ComposerAttachmentUploadRequest,
    signal: AbortSignal,
    onProgress: (progress: number) => void,
  ) => Promise<boolean>
  readonly onChange: (states: Readonly<Record<string, ComposerAttachmentUploadState>>) => void
})
{
  const jobs = new Map<
    string,
    { readonly controller: AbortController; readonly done: Promise<void> }
  >()
  let desired = new Map<string, ComposerAttachmentUploadRequest>()
  let states: Readonly<Record<string, ComposerAttachmentUploadState>> = {}
  let disposed = false

  const setState = (key: string, state: ComposerAttachmentUploadState | undefined) =>
  {
    const next = { ...states }
    if (state) next[key] = state
    else delete next[key]
    states = next
    options.onChange(states)
  }

  const pump = () =>
  {
    if (disposed) return
    for (const [key, request] of desired)
    {
      if (jobs.size >= 3) return
      if (jobs.has(key) || states[key]?.status === 'ready' || states[key]?.status === 'failed')
      {
        continue
      }
      const controller = new AbortController()
      setState(key, { status: 'uploading', progress: 0 })
      const done = Promise.resolve()
        .then(() =>
          options.upload(request, controller.signal, (progress) =>
          {
            if (controller.signal.aborted) return
            setState(key, {
              status: 'uploading',
              progress: Math.floor(Math.max(0, Math.min(1, progress)) * 20) / 20,
            })
          }),
        )
        .then((persisted) =>
        {
          if (!controller.signal.aborted && desired.has(key))
          {
            setState(key, persisted ? { status: 'ready' } : undefined)
          }
        })
        .catch((error: unknown) =>
        {
          if (!controller.signal.aborted && desired.has(key))
          {
            setState(key, {
              status: 'failed',
              reason: error instanceof Error ? error.message : 'Upload failed. Tap to retry.',
            })
          }
        })
        .finally(() =>
        {
          jobs.delete(key)
          pump()
        })
      jobs.set(key, { controller, done })
    }
  }

  return {
    sync(requests: ReadonlyArray<ComposerAttachmentUploadRequest>): void
    {
      if (disposed) return
      desired = new Map(
        requests.map((request) => [
          composerAttachmentUploadKey(request.environmentId, request.attachment.id),
          request,
        ]),
      )
      for (const [key, job] of jobs)
      {
        if (!desired.has(key)) job.controller.abort()
      }
      for (const key of Object.keys(states))
      {
        if (!desired.has(key)) setState(key, undefined)
      }
      pump()
    },
    retry(environmentId: EnvironmentId, attachmentId: string): void
    {
      const key = composerAttachmentUploadKey(environmentId, attachmentId)
      if (states[key]?.status !== 'failed') return
      setState(key, undefined)
      pump()
    },
    async settled(): Promise<void>
    {
      while (jobs.size > 0)
      {
        await Promise.all([...jobs.values()].map((job) => job.done))
      }
    },
    dispose(): void
    {
      disposed = true
      desired.clear()
      for (const job of jobs.values()) job.controller.abort()
      states = {}
      options.onChange(states)
    },
  }
}
