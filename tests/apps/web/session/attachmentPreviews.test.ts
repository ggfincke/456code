// tests/apps/web/session/attachmentPreviews.test.ts
// verify mounted-row attachment preview projection

import { MessageId } from '@t3tools/contracts'
import { describe, expect, it } from '@effect/vitest'

import {
  createMessageAttachmentPreviewProjector,
  selectHandoffImageResources,
  selectMessageAttachmentResources,
} from '../../../../apps/web/src/session/attachmentPreviews'
import type { ChatMessage } from '../../../../apps/web/src/types'

function userMessage(attachments: NonNullable<ChatMessage['attachments']>): ChatMessage
{
  return {
    id: MessageId.make('message-1'),
    role: 'user',
    text: 'attached',
    turnId: null,
    streaming: false,
    createdAt: '2026-09-09T12:00:00.000Z',
    updatedAt: '2026-09-09T12:00:00.000Z',
    attachments,
  }
}

describe('attachment preview deferral', () =>
{
  it('requests only server-backed previews for a mounted row', () =>
  {
    const message = userMessage([
      {
        type: 'image',
        id: 'image-1',
        name: 'one.png',
        mimeType: 'image/png',
        sizeBytes: 10,
        previewUrl: 'blob:local',
      },
      { type: 'image', id: 'image-2', name: 'two.png', mimeType: 'image/png', sizeBytes: 10 },
      {
        type: 'file',
        id: 'file-1',
        name: 'notes.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 10,
      },
    ])

    expect(selectMessageAttachmentResources(message.attachments)).toEqual([
      { _tag: 'attachment', attachmentId: 'image-2' },
      {
        _tag: 'attachment',
        attachmentId: 'file-1',
        fileName: 'notes.pdf',
        mimeType: 'application/pdf',
      },
    ])
  })

  it('keeps handoff image requests available outside mounted rows', () =>
  {
    const message = userMessage([
      { type: 'image', id: 'image-1', name: 'one.png', mimeType: 'image/png', sizeBytes: 10 },
    ])

    expect(selectHandoffImageResources([message], { [message.id]: ['blob:local'] })).toEqual([
      { _tag: 'attachment', attachmentId: 'image-1' },
    ])
  })

  it('preserves projected identities while a signed URL is unchanged', () =>
  {
    const source = userMessage([
      { type: 'image', id: 'image-1', name: 'one.png', mimeType: 'image/png', sizeBytes: 10 },
    ])
    const project = createMessageAttachmentPreviewProjector()
    const first = project(source, () => 'https://signed.test/image-1')
    const second = project(source, () => 'https://signed.test/image-1')

    expect(first).toBe(second)
    expect(first.attachments?.[0]).toMatchObject({ previewUrl: 'https://signed.test/image-1' })
  })
})
