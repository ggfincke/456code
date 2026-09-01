// tests/apps/mobile/lib/composerAttachmentUploadQueue.test.ts
// verify bounded composer attachment upload scheduling

import { EnvironmentId } from '@t3tools/contracts'
import { describe, expect, it } from 'vite-plus/test'

import {
  composerAttachmentUploadKey,
  createComposerAttachmentUploadQueue,
} from '../../../../apps/mobile/src/lib/composerAttachmentUploadQueue'
import type { DraftComposerImageAttachment } from '../../../../apps/mobile/src/lib/composerImages'

const environmentId = EnvironmentId.make('environment-a')

function attachment(id: string): DraftComposerImageAttachment
{
  return {
    id,
    type: 'image',
    name: `${id}.png`,
    mimeType: 'image/png',
    sizeBytes: 1,
    dataUrl: 'data:image/png;base64,AA==',
    previewUri: 'data:image/png;base64,AA==',
  }
}

describe('createComposerAttachmentUploadQueue', () =>
{
  it('bounds concurrent uploads and starts the next desired attachment after completion', async () =>
  {
    let active = 0
    let peak = 0
    let started = 0
    let nextStarted!: () => void
    const fourthStarted = new Promise<void>((resolve) =>
    {
      nextStarted = resolve
    })
    const releases: Array<() => void> = []
    const queue = createComposerAttachmentUploadQueue({
      onChange: () => undefined,
      upload: async () =>
      {
        active += 1
        if (++started === 4) nextStarted()
        peak = Math.max(peak, active)
        await new Promise<void>((resolve) => releases.push(resolve))
        active -= 1
        return true
      },
    })

    queue.sync(
      ['one', 'two', 'three', 'four'].map((id) => ({
        environmentId,
        attachment: attachment(id),
      })),
    )
    await Promise.resolve()
    expect(active).toBe(3)
    expect(peak).toBe(3)

    releases.shift()?.()
    await fourthStarted
    expect(active).toBe(3)
    expect(peak).toBe(3)
    releases.splice(0).forEach((release) => release())
    await queue.settled()
    queue.dispose()
  })

  it('keeps identical draft attachment ids isolated by environment', () =>
  {
    expect(composerAttachmentUploadKey(environmentId, 'same')).not.toBe(
      composerAttachmentUploadKey(EnvironmentId.make('environment-b'), 'same'),
    )
  })
})
