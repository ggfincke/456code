// tests/apps/server/attachments/attachmentStore.test.ts
// verifies managed attachment identity and path helpers

// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'

import { describe, expect, it } from 'vite-plus/test'

import {
  attachmentContentDigest,
  attachmentStagingRelativePath,
  createAttachmentId,
  deriveAttachmentStagingKey,
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentStagingPath,
  resolveAttachmentPathById,
} from '../../../../apps/server/src/attachments/attachmentStore.ts'

describe('attachmentStore', () =>
{
  it('derives deterministic staging keys with index separation', () =>
  {
    const input = { commandId: 'command', messageId: 'message', attachmentIndex: 0 }
    expect(deriveAttachmentStagingKey(input)).toBe(
      '2012ea8219a35b9e2b604dcf1116410c692c91b48d0e63022d6ec5faca459865',
    )
    expect(deriveAttachmentStagingKey(input)).not.toBe(
      deriveAttachmentStagingKey({ ...input, attachmentIndex: 1 }),
    )
    expect(attachmentContentDigest(Uint8Array.from([1, 2, 3]))).toHaveLength(64)
  })

  it('resolves staging files beneath the managed staging directory', () =>
  {
    const stagingKey = deriveAttachmentStagingKey({
      commandId: 'command',
      messageId: 'message',
      attachmentIndex: 0,
    })
    const attachment = {
      type: 'image' as const,
      id: 'thread-1-00000000-0000-4000-8000-000000000001',
      name: 'image.png',
      mimeType: 'image/png',
      sizeBytes: 3,
    }
    const relativePath = attachmentStagingRelativePath({ stagingKey, attachment })
    expect(relativePath).toBe(
      `.staging/${stagingKey}/thread-1-00000000-0000-4000-8000-000000000001.png`,
    )
    expect(
      resolveAttachmentStagingPath({
        attachmentsDir: '/tmp/attachments',
        stagingKey,
        attachment,
      }),
    ).toBe(NodePath.join('/tmp/attachments', relativePath))
    expect(
      resolveAttachmentStagingPath({
        attachmentsDir: '/tmp/attachments',
        stagingKey: '../escape',
        attachment,
      }),
    ).toBeNull()
  })

  it.each([
    {
      name: 'sanitizes unsafe thread ids',
      createFrom: 'thread.folder/unsafe space',
      expectedSegment: /^[a-z0-9_-]+$/i,
      forbidden: ['.', '%', '/'] as const,
    },
    {
      name: 'lowercases created thread segments',
      createFrom: 'Thread.Foo',
      expectedSegment: 'thread-foo',
      forbidden: [] as const,
    },
  ])('$name', ({ createFrom, expectedSegment, forbidden }) =>
  {
    const attachmentId = createAttachmentId(createFrom)
    expect(attachmentId).toBeTruthy()
    if (!attachmentId)
    {
      return
    }
    const threadSegment = parseThreadSegmentFromAttachmentId(attachmentId)
    if (typeof expectedSegment === 'string')
    {
      expect(threadSegment).toBe(expectedSegment)
    }
    else
    {
      expect(threadSegment).toMatch(expectedSegment)
    }
    for (const token of forbidden)
    {
      expect(threadSegment).not.toContain(token)
    }
  })

  it('parses exact thread segments from attachment ids without prefix collisions', () =>
  {
    expect(parseThreadSegmentFromAttachmentId('foo-00000000-0000-4000-8000-000000000001')).toBe(
      'foo',
    )
    expect(parseThreadSegmentFromAttachmentId('foo-bar-00000000-0000-4000-8000-000000000002')).toBe(
      'foo-bar',
    )
  })

  it('resolves attachment path by id using the extension that exists on disk', () =>
  {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), 't3code-attachment-store-'),
    )
    try
    {
      const attachmentId = 'thread-1-attachment'
      const pngPath = NodePath.join(attachmentsDir, `${attachmentId}.png`)
      NodeFS.writeFileSync(pngPath, Buffer.from('hello'))

      const resolved = resolveAttachmentPathById({
        attachmentsDir,
        attachmentId,
      })
      expect(resolved).toBe(pngPath)
    }
    finally
    {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true })
    }
  })

  it('returns null when no attachment file exists for the id', () =>
  {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), 't3code-attachment-store-'),
    )
    try
    {
      const resolved = resolveAttachmentPathById({
        attachmentsDir,
        attachmentId: 'thread-1-missing',
      })
      expect(resolved).toBeNull()
    }
    finally
    {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true })
    }
  })
})
