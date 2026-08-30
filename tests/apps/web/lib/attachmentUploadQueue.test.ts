// tests/apps/web/lib/attachmentUploadQueue.test.ts
// verify bounded uploads and durable environment-scoped ownership
import { scopeThreadRef } from '@t3tools/client-runtime/environment'
import { EnvironmentId, ThreadId } from '@t3tools/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import {
  composerFileNeedsReattach,
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
} from '../../../../apps/web/src/composerDraftStore'

const mocks = vi.hoisted(() => ({
  createAssetUrl: vi.fn(),
  createUploadUrl: Symbol('create-upload-url'),
  executeAtomQuery: vi.fn(),
  removeUpload: Symbol('remove-upload'),
  runAtomCommand: vi.fn(),
  readPreparedConnection: vi.fn(),
}))

vi.mock('@t3tools/client-runtime/state/runtime', () => ({
  executeAtomQuery: mocks.executeAtomQuery,
  runAtomCommand: mocks.runAtomCommand,
  squashAtomCommandFailure: (result: { readonly error: unknown }) => result.error,
}))

vi.mock('../../../../apps/web/src/rpc/atomRegistry', () => ({ appAtomRegistry: {} }))

vi.mock('../../../../apps/web/src/state/assets', () => ({
  assetEnvironment: { createUrl: mocks.createAssetUrl },
}))

vi.mock('../../../../apps/web/src/state/attachments', () => ({
  attachmentEnvironment: {
    createUploadUrl: mocks.createUploadUrl,
    remove: mocks.removeUpload,
  },
}))

vi.mock('../../../../apps/web/src/state/session', () => ({
  readPreparedConnection: mocks.readPreparedConnection,
}))

import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  readAttachmentUpload,
  releaseAttachmentUpload,
  releaseDraftAttachment,
  retryAttachmentUpload,
  startAttachmentUpload,
  useAttachmentUploadStore,
} from '../../../../apps/web/src/lib/attachmentUploadQueue'

type ProgressListener = (event: {
  readonly lengthComputable: boolean
  readonly loaded: number
  readonly total: number
}) => void

class TestXmlHttpRequest
{
  static requests: TestXmlHttpRequest[] = []

  status = 0
  timeout = 0
  method: string | null = null
  url: string | null = null
  readonly headers = new Map<string, string>()
  readonly listeners = new Map<string, () => void>()
  progressListener: ProgressListener | null = null

  readonly upload = {
    addEventListener: (_event: string, listener: ProgressListener) =>
    {
      this.progressListener = listener
    },
  }

  constructor()
  {
    TestXmlHttpRequest.requests.push(this)
  }

  open(method: string, url: string): void
  {
    this.method = method
    this.url = url
  }

  setRequestHeader(name: string, value: string): void
  {
    this.headers.set(name, value)
  }

  addEventListener(event: string, listener: () => void): void
  {
    this.listeners.set(event, listener)
  }

  send(): void
  {}

  abort(): void
  {
    this.listeners.get('abort')?.()
  }

  progress(loaded: number, total: number): void
  {
    this.progressListener?.({ lengthComputable: true, loaded, total })
  }

  complete(status = 204): void
  {
    this.status = status
    this.listeners.get('load')?.()
  }
}

const firstEnvironment = EnvironmentId.make('environment-1')
const secondEnvironment = EnvironmentId.make('environment-2')

function makeImage(id: string): ComposerImageAttachment
{
  const file = new File([new Uint8Array([1, 2, 3])], `${id}.png`, { type: 'image/png' })
  return {
    type: 'image',
    id,
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    previewUrl: `blob:${id}`,
    file,
  }
}

function makeFile(id: string): ComposerFileAttachment
{
  const file = new File([new Uint8Array([1, 2, 3])], `${id}.pdf`, {
    type: 'application/pdf',
  })
  return {
    type: 'file',
    id,
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    file,
  }
}

describe('attachmentUploadQueue', () =>
{
  it('waits for command readiness before minting a hydrated image upload on reload', async () =>
  {
    const image = makeImage('reload-image')
    startAttachmentUpload({ environmentId: firstEnvironment, image, environmentReady: false })
    expect(mocks.runAtomCommand).not.toHaveBeenCalled()
    expect(readAttachmentUpload(image.id)).toBeUndefined()
    startAttachmentUpload({ environmentId: firstEnvironment, image, environmentReady: true })
    await vi.waitFor(() => expect(TestXmlHttpRequest.requests).toHaveLength(1))
    TestXmlHttpRequest.requests[0]!.complete()
    await awaitAttachmentUploads([image.id])
    expect(readAttachmentUpload(image.id)).toMatchObject({
      status: 'ready',
      environmentId: firstEnvironment,
    })
  })

  beforeEach(() =>
  {
    TestXmlHttpRequest.requests = []
    mocks.createAssetUrl.mockReset()
    mocks.createAssetUrl.mockImplementation((target: unknown) => target)
    mocks.executeAtomQuery.mockReset()
    mocks.executeAtomQuery.mockResolvedValue({ _tag: 'Success', value: {} })
    mocks.runAtomCommand.mockReset()
    mocks.readPreparedConnection.mockReset()
    mocks.readPreparedConnection.mockReturnValue({ httpBaseUrl: 'https://environment.test/' })
    mocks.runAtomCommand.mockImplementation(
      async (
        _registry: unknown,
        command: unknown,
        target: {
          readonly environmentId: EnvironmentId
          readonly input: { readonly name?: string }
        },
      ) =>
      {
        if (command === mocks.createUploadUrl)
        {
          const attachmentId = `pending-${target.environmentId}-${target.input.name}`
          return {
            _tag: 'Success',
            value: {
              attachmentId,
              relativeUrl: `/api/attachments/upload/${attachmentId}`,
              expiresAt: 1,
            },
          }
        }
        return { _tag: 'Success', value: undefined }
      },
    )
    vi.stubGlobal('XMLHttpRequest', TestXmlHttpRequest)
  })

  afterEach(() =>
  {
    for (const imageId of Object.keys(useAttachmentUploadStore.getState().uploadsByImageId))
    {
      releaseAttachmentUpload(imageId)
    }
    vi.unstubAllGlobals()
  })

  it('bounds each environment to three transfers and releases cancelled queued work', async () =>
  {
    const images = Array.from({ length: 5 }, (_, index) => makeImage(`bounded-${index}`))
    for (const image of images) startAttachmentUpload({ environmentId: firstEnvironment, image })
    await vi.waitFor(() => expect(TestXmlHttpRequest.requests).toHaveLength(3))
    releaseAttachmentUpload(images[4]!.id)
    TestXmlHttpRequest.requests[0]!.complete()
    await vi.waitFor(() => expect(TestXmlHttpRequest.requests).toHaveLength(4))
    for (const request of TestXmlHttpRequest.requests.slice(1)) request.complete()
    await awaitAttachmentUploads(images.map((image) => image.id))
    expect(
      getUploadedAttachments({ environmentId: firstEnvironment, images: images.slice(0, 4) }),
    ).toHaveLength(4)
    expect(readAttachmentUpload(images[4]!.id)).toBeUndefined()
  })

  it('retains the only hydrated server copy on transient verification and reattaches only on definite absence', async () =>
  {
    const target = scopeThreadRef(firstEnvironment, ThreadId.make('hydrated-thread'))
    const file = {
      ...makeFile('hydrated'),
      file: null,
      uploadedAttachmentId: 'saved-copy',
      uploadEnvironmentId: firstEnvironment,
    }
    useComposerDraftStore.getState().addFiles(target, [file])
    mocks.executeAtomQuery.mockResolvedValueOnce({ _tag: 'Failure', error: new Error('offline') })
    startAttachmentUpload({ environmentId: firstEnvironment, image: file, draftTarget: target })
    await awaitAttachmentUploads([file.id])
    expect(readAttachmentUpload(file.id)).toMatchObject({ status: 'failed' })
    expect(
      useComposerDraftStore.getState().getComposerDraft(target)?.files[0]?.uploadedAttachmentId,
    ).toBe('saved-copy')
    expect(mocks.runAtomCommand).not.toHaveBeenCalled()
    mocks.executeAtomQuery.mockResolvedValueOnce({
      _tag: 'Failure',
      error: { _tag: 'AssetAttachmentNotFoundError' },
    })
    retryAttachmentUpload({ environmentId: firstEnvironment, image: file, draftTarget: target })
    await awaitAttachmentUploads([file.id])
    expect(
      composerFileNeedsReattach(
        useComposerDraftStore.getState().getComposerDraft(target)!.files[0]!,
      ),
    ).toBe(true)
    expect(mocks.executeAtomQuery).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ refresh: true }),
    )
    expect(mocks.runAtomCommand).not.toHaveBeenCalled()
    useComposerDraftStore.getState().clearDraftThread(target)
  })

  it('freshly verifies a previous environment after a failed switch instead of resurrecting its ready ID', async () =>
  {
    const file = makeFile('returning')
    startAttachmentUpload({ environmentId: firstEnvironment, image: file })
    await vi.waitFor(() => expect(TestXmlHttpRequest.requests).toHaveLength(1))
    TestXmlHttpRequest.requests[0]!.complete()
    await awaitAttachmentUploads([file.id])
    startAttachmentUpload({ environmentId: secondEnvironment, image: file })
    await vi.waitFor(() => expect(TestXmlHttpRequest.requests).toHaveLength(2))
    TestXmlHttpRequest.requests[1]!.complete(500)
    await awaitAttachmentUploads([file.id])
    mocks.executeAtomQuery.mockResolvedValueOnce({ _tag: 'Failure', error: new Error('temporary') })
    startAttachmentUpload({ environmentId: firstEnvironment, image: file })
    await awaitAttachmentUploads([file.id])
    expect(mocks.executeAtomQuery).toHaveBeenCalledTimes(1)
    expect(readAttachmentUpload(file.id)).toMatchObject({
      status: 'failed',
      environmentId: firstEnvironment,
    })
    mocks.executeAtomQuery.mockResolvedValueOnce({
      _tag: 'Failure',
      error: { _tag: 'AssetAttachmentNotFoundError' },
    })
    retryAttachmentUpload({ environmentId: firstEnvironment, image: file })
    await vi.waitFor(() => expect(TestXmlHttpRequest.requests).toHaveLength(3))
    expect(mocks.executeAtomQuery).toHaveBeenCalledTimes(2)
    TestXmlHttpRequest.requests[2]!.complete()
    await awaitAttachmentUploads([file.id])
    expect(readAttachmentUpload(file.id)).toMatchObject({
      status: 'ready',
      environmentId: firstEnvironment,
    })
  })

  it('persists completion on the moved draft owner and releases the hydrated upload on discard', async () =>
  {
    const source = scopeThreadRef(firstEnvironment, ThreadId.make('move-source'))
    const target = scopeThreadRef(firstEnvironment, ThreadId.make('move-target'))
    const file = makeFile('moving')
    useComposerDraftStore.getState().addFiles(source, [file])
    startAttachmentUpload({ environmentId: firstEnvironment, image: file, draftTarget: source })
    await vi.waitFor(() => expect(TestXmlHttpRequest.requests).toHaveLength(1))
    useComposerDraftStore.getState().moveComposerPromptAndImages(source, target)
    TestXmlHttpRequest.requests[0]!.complete()
    await awaitAttachmentUploads([file.id])
    const moved = useComposerDraftStore.getState().getComposerDraft(target)!.files[0]!
    expect(moved.uploadEnvironmentId).toBe(firstEnvironment)
    expect(moved.uploadedAttachmentId).toContain('moving.pdf')
    releaseDraftAttachment({ ...moved, file: null })
    expect(mocks.runAtomCommand).toHaveBeenCalledWith(
      expect.anything(),
      mocks.removeUpload,
      {
        environmentId: firstEnvironment,
        input: { attachmentId: moved.uploadedAttachmentId },
      },
      expect.anything(),
    )
    useComposerDraftStore.getState().clearDraftThread(source)
    useComposerDraftStore.getState().clearDraftThread(target)
  })
})
