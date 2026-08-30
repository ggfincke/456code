// tests/packages/client-runtime/state/attachments.test.ts
// verify signed upload origin and fresh persisted attachment checks

import {
  EnvironmentId,
  type AttachmentCreateUploadUrlInput,
  type AttachmentDeleteInput,
} from '@t3tools/contracts'
import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { Atom, AtomRegistry } from 'effect/unstable/reactivity'
import { createRuntimeCommand } from '../../../../packages/client-runtime/src/state/runtime.ts'
import {
  resolveAttachmentUploadUrl,
  runAttachmentUploadCycle,
  verifyPersistedAttachmentUpload,
} from '../../../../packages/client-runtime/src/state/attachments.ts'

const environmentId = EnvironmentId.make('upload-test')

describe('attachment upload boundaries', () =>
{
  it('binds signed targets to the selected HTTP origin', () =>
  {
    expect(resolveAttachmentUploadUrl('https://selected.test/base', '/upload?signed=yes')).toBe(
      'https://selected.test/upload?signed=yes',
    )
    for (const target of [
      'https://other.test/upload',
      '//other.test/upload',
      'http://selected.test/upload',
      'https://user:pass@selected.test/upload',
      'file:///tmp/upload',
    ])
    {
      expect(resolveAttachmentUploadUrl('https://selected.test', target)).toBeNull()
    }
  })

  it('rejects redirected upload authority before bytes and cleans a mint cancelled by its owner', async () =>
  {
    const registry = AtomRegistry.make()
    const runtime = Atom.runtime(Layer.empty)
    const deleted: string[] = []
    let transfers = 0
    const createUploadUrl = createRuntimeCommand(runtime, {
      label: 'test.upload.mint',
      execute: (_: { environmentId: EnvironmentId; input: AttachmentCreateUploadUrlInput }) =>
        Effect.succeed({
          attachmentId: 'pending-id',
          relativeUrl: 'https://other.test/upload',
          expiresAt: 1_788_091_200_000,
        }),
    })
    const remove = createRuntimeCommand(runtime, {
      label: 'test.upload.remove',
      execute: (target: { environmentId: EnvironmentId; input: AttachmentDeleteInput }) =>
        Effect.sync(() =>
        {
          deleted.push(target.input.attachmentId)
        }),
    })
    const input = {
      registry,
      createUploadUrl,
      remove,
      environmentId,
      upload: {
        type: 'file' as const,
        name: 'notes.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 3,
      },
      resolveHttpBaseUrl: () => 'https://selected.test',
      transport: () =>
      {
        transfers += 1
        return { done: Promise.resolve(), abort: () =>
        {} }
      },
    }
    expect(await runAttachmentUploadCycle(input)).toMatchObject({
      status: 'failed',
      step: 'resolve-url',
      attachmentId: 'pending-id',
    })
    expect(transfers).toBe(0)
    expect(deleted).toEqual([])
    expect(await runAttachmentUploadCycle({ ...input, onMinted: () => 'cancel' })).toMatchObject({
      status: 'cancelled',
    })
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(deleted).toEqual(['pending-id'])
    registry.dispose()
  })

  it('refreshes a cached verification and distinguishes transient failure from missing bytes', async () =>
  {
    const registry = AtomRegistry.make()
    let failure: unknown = null
    let queries = 0
    const atom = Atom.make(
      Effect.suspend(() =>
      {
        queries += 1
        return failure === null ? Effect.succeed({ relativeUrl: '/asset' }) : Effect.fail(failure)
      }),
    )
    const unmount = registry.mount(atom)
    const input = { registry, createAssetUrl: () => atom, environmentId, attachmentId: 'persisted' }
    expect(await verifyPersistedAttachmentUpload(input)).toEqual({ status: 'verified' })
    const firstQueries = queries
    failure = new Error('temporarily offline')
    expect(await verifyPersistedAttachmentUpload(input)).toMatchObject({
      status: 'failed',
      error: failure,
    })
    expect(queries).toBeGreaterThan(firstQueries)
    failure = { _tag: 'AssetAttachmentNotFoundError' }
    expect(await verifyPersistedAttachmentUpload(input)).toEqual({ status: 'missing' })
    unmount()
    registry.dispose()
  })
})
