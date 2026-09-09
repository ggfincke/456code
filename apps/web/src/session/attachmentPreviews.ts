// apps/web/src/session/attachmentPreviews.ts
// defer signed attachment previews to mounted timeline rows

import type { AssetResource } from '@t3tools/contracts'

import {
  isFileAttachment,
  isImageAttachment,
  type ChatAttachment,
  type ChatMessage,
} from '../types'

type AttachmentResource = Extract<AssetResource, { readonly _tag: 'attachment' }>
const EMPTY_ATTACHMENT_RESOURCES = Object.freeze<ReadonlyArray<AttachmentResource>>([])

export function selectMessageAttachmentResources(
  attachments: ChatMessage['attachments'],
): ReadonlyArray<AttachmentResource>
{
  const resources = new Map<string, AttachmentResource>()
  for (const attachment of attachments ?? [])
  {
    if (!isImageAttachment(attachment) && !isFileAttachment(attachment)) continue
    if (attachment.previewUrl?.startsWith('blob:') || attachment.previewUrl?.startsWith('data:'))
    {
      continue
    }
    resources.set(attachment.id, {
      _tag: 'attachment',
      attachmentId: attachment.id,
      ...(isFileAttachment(attachment)
        ? { fileName: attachment.name, mimeType: attachment.mimeType }
        : {}),
    })
  }
  return resources.size === 0 ? EMPTY_ATTACHMENT_RESOURCES : [...resources.values()]
}

// handoffs need server URLs even while their source row is unmounted.
export function selectHandoffImageResources(
  messages: ReadonlyArray<ChatMessage> | undefined,
  handoffs: Readonly<Record<string, ReadonlyArray<string>>>,
): ReadonlyArray<AttachmentResource>
{
  if (Object.keys(handoffs).length === 0) return EMPTY_ATTACHMENT_RESOURCES
  const attachmentIds = new Set<string>()
  for (const message of messages ?? [])
  {
    if (message.role !== 'user' || !handoffs[message.id]?.length) continue
    for (const attachment of message.attachments ?? [])
    {
      if (isImageAttachment(attachment)) attachmentIds.add(attachment.id)
    }
  }
  return attachmentIds.size === 0
    ? EMPTY_ATTACHMENT_RESOURCES
    : Array.from(attachmentIds, (attachmentId) => ({ _tag: 'attachment', attachmentId }))
}

export function createMessageAttachmentPreviewProjector()
{
  const attachmentsBySource = new WeakMap<
    ReadonlyArray<ChatAttachment>,
    ReadonlyArray<ChatAttachment>
  >()
  const messagesBySource = new WeakMap<ChatMessage, ChatMessage>()
  return (
    message: ChatMessage,
    previewUrlFor: (attachment: ChatAttachment) => string | undefined,
  ): ChatMessage =>
  {
    const source = message.attachments
    if (!source || source.length === 0) return message
    const previous = attachmentsBySource.get(source) ?? source
    let changed: ChatAttachment[] | undefined
    let hasOverrides = false
    for (const [index, attachment] of source.entries())
    {
      const previewUrl = previewUrlFor(attachment)
      const sourceUrl = 'previewUrl' in attachment ? attachment.previewUrl : undefined
      const previousAttachment = previous[index]!
      const previousUrl =
        'previewUrl' in previousAttachment ? previousAttachment.previewUrl : undefined
      const next =
        !previewUrl || previewUrl === sourceUrl
          ? attachment
          : previewUrl === previousUrl
            ? previousAttachment
            : { ...attachment, previewUrl }
      hasOverrides ||= next !== attachment
      if (next !== previousAttachment)
      {
        changed ??= previous.slice()
        changed[index] = next
      }
    }
    const attachments = hasOverrides ? (changed ?? previous) : source
    attachmentsBySource.set(source, attachments)
    if (attachments === source)
    {
      messagesBySource.delete(message)
      return message
    }
    const previousMessage = messagesBySource.get(message)
    if (previousMessage?.attachments === attachments) return previousMessage
    const result = { ...message, attachments }
    messagesBySource.set(message, result)
    return result
  }
}
