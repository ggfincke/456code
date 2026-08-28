// apps/server/src/attachments/attachmentStore.ts
// derives and resolves managed attachment identities and paths

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from 'node:crypto'
import * as NodePath from 'node:path'
import * as Effect from 'effect/Effect'

import type { ChatAttachment } from '@t3tools/contracts'

import {
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from './attachmentPaths.ts'
import { inferImageExtension, SAFE_IMAGE_FILE_EXTENSIONS } from './imageMime.ts'
import { inspectManagedFile } from './attachmentFiles.ts'

const ATTACHMENT_FILENAME_EXTENSIONS = [...SAFE_IMAGE_FILE_EXTENSIONS, '.bin']
const ATTACHMENT_ID_THREAD_SEGMENT_MAX_CHARS = 80
const ATTACHMENT_ID_THREAD_SEGMENT_PATTERN = '[a-z0-9_]+(?:-[a-z0-9_]+)*'
const ATTACHMENT_ID_UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const ATTACHMENT_ID_PATTERN = new RegExp(
  `^(${ATTACHMENT_ID_THREAD_SEGMENT_PATTERN})-(${ATTACHMENT_ID_UUID_PATTERN})(?:-([a-z0-9]{1,10}))?$`,
  'i',
)
const ATTACHMENT_STAGING_KEY_PATTERN = /^[0-9a-f]{64}$/
const PENDING_ID_PATTERN = new RegExp(
  `^pending-(${ATTACHMENT_ID_UUID_PATTERN})-(image|file)-([a-z0-9]{1,10})$`,
)
export const PENDING_ATTACHMENT_MAX_AGE_MS = 24 * 60 * 60 * 1000
export const PARTIAL_UPLOAD_MAX_AGE_MS = 60 * 60 * 1000

export function attachmentFileExtension(fileName: string): string
{
  const extension = NodePath.extname(fileName).toLowerCase()
  return extension !== '.part' && /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : '.bin'
}

export function createPendingAttachmentId(type: 'image' | 'file', extension: string): string
{
  return `pending-${NodeCrypto.randomUUID()}-${type}-${extension.replace(/^\./, '')}`
}

export function parsePendingAttachmentId(
  id: string,
): { type: 'image' | 'file'; extension: string } | null
{
  const match = PENDING_ID_PATTERN.exec(id)
  if (!match || match[3] === 'part') return null
  const type = match[2] as 'image' | 'file'
  const extension = `.${match[3]}`
  if (type === 'image' && !['.gif', '.jpg', '.jpeg', '.png', '.webp'].includes(extension))
    return null
  return { type, extension }
}

export function parsePendingAttachmentRelativePath(
  relativePath: string,
): { attachmentId: string; partial: boolean } | null
{
  const match = new RegExp(
    `^(pending-${ATTACHMENT_ID_UUID_PATTERN}-(?:image|file)-[a-z0-9]{1,10})(\\.[a-z0-9]{1,10})(?:\\.${ATTACHMENT_ID_UUID_PATTERN}\\.part)?$`,
  ).exec(relativePath)
  if (!match) return null
  const parsed = parsePendingAttachmentId(match[1]!)
  return parsed?.extension === match[2]
    ? { attachmentId: match[1]!, partial: relativePath.endsWith('.part') }
    : null
}

export function pendingSourceRelativePath(
  stagingKey: string,
  stagingRelativePath: string,
): string | null
{
  if (!ATTACHMENT_STAGING_KEY_PATTERN.test(stagingKey)) return null
  const prefix = `.staging/${stagingKey}/pending-upload/`
  if (!stagingRelativePath.startsWith(prefix)) return null
  const relativePath = stagingRelativePath.slice(prefix.length)
  const parsed = parsePendingAttachmentRelativePath(relativePath)
  return parsed && !parsed.partial ? relativePath : null
}

export function parseAttachmentFileExtension(id: string): string | null
{
  const pending = parsePendingAttachmentId(id)
  if (pending) return pending.type === 'file' ? pending.extension : null
  const extension = ATTACHMENT_ID_PATTERN.exec(id)?.[3]
  return extension && extension !== 'part' ? `.${extension.toLowerCase()}` : null
}

export function deriveAttachmentStagingKey(input: {
  readonly commandId: string
  readonly messageId: string
  readonly attachmentIndex: number
}): string
{
  return NodeCrypto.createHash('sha256')
    .update(input.commandId)
    .update('\0')
    .update(input.messageId)
    .update('\0')
    .update(String(input.attachmentIndex))
    .digest('hex')
}

export function attachmentContentDigest(bytes: Uint8Array): string
{
  return NodeCrypto.createHash('sha256').update(bytes).digest('hex')
}

export function toSafeThreadAttachmentSegment(threadId: string): string | null
{
  const segment = threadId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, ATTACHMENT_ID_THREAD_SEGMENT_MAX_CHARS)
    .replace(/[-_]+$/g, '')
  if (segment.length === 0)
  {
    return null
  }
  return segment
}

export function createAttachmentId(threadId: string, extension?: string): string | null
{
  const threadSegment = toSafeThreadAttachmentSegment(threadId)
  if (!threadSegment)
  {
    return null
  }
  return `${threadSegment}-${NodeCrypto.randomUUID()}${extension ? `-${attachmentFileExtension(`file${extension}`).slice(1)}` : ''}`
}

export function parseThreadSegmentFromAttachmentId(attachmentId: string): string | null
{
  const normalizedId = normalizeAttachmentRelativePath(attachmentId)
  if (!normalizedId || normalizedId.includes('/') || normalizedId.includes('.'))
  {
    return null
  }
  const match = normalizedId.match(ATTACHMENT_ID_PATTERN)
  if (!match)
  {
    return null
  }
  return match[1]?.toLowerCase() ?? null
}

export function attachmentRelativePath(attachment: ChatAttachment): string | null
{
  const pending = parsePendingAttachmentId(attachment.id)
  if (pending)
  {
    const extension =
      attachment.type === 'image'
        ? inferImageExtension({ mimeType: attachment.mimeType, fileName: attachment.name })
        : attachmentFileExtension(attachment.name)
    return attachment.type === pending.type && extension === pending.extension
      ? `${attachment.id}${extension}`
      : null
  }
  if (!/^[a-zA-Z0-9_-]{1,256}$/.test(attachment.id)) return null
  switch (attachment.type)
  {
    case 'image':
    {
      if (parseAttachmentFileExtension(attachment.id)) return null
      const extension = inferImageExtension({
        mimeType: attachment.mimeType,
        fileName: attachment.name,
      })
      return `${attachment.id}${extension}`
    }
    case 'file':
    {
      const extension = attachmentFileExtension(attachment.name)
      return parseAttachmentFileExtension(attachment.id) === extension
        ? `${attachment.id}${extension}`
        : null
    }
    default:
      return null
  }
}

export function attachmentStagingRelativePath(input: {
  readonly stagingKey: string
  readonly attachment: ChatAttachment
  readonly pendingRelativePath?: string
}): string | null
{
  const relativePath = attachmentRelativePath(input.attachment)
  if (!relativePath) return null
  if (input.pendingRelativePath !== undefined)
  {
    const stagingPath = `.staging/${input.stagingKey}/pending-upload/${input.pendingRelativePath}`
    return pendingSourceRelativePath(input.stagingKey, stagingPath) === input.pendingRelativePath
      ? stagingPath
      : null
  }
  return `.staging/${input.stagingKey}/${relativePath}`
}

export function resolveAttachmentStagingPath(input: {
  readonly attachmentsDir: string
  readonly stagingKey: string
  readonly attachment: ChatAttachment
  readonly pendingRelativePath?: string
}): string | null
{
  if (!ATTACHMENT_STAGING_KEY_PATTERN.test(input.stagingKey))
  {
    return null
  }
  const relativePath = attachmentStagingRelativePath(input)
  if (!relativePath) return null
  return resolveAttachmentRelativePath({
    attachmentsDir: input.attachmentsDir,
    relativePath,
  })
}

export function resolveAttachmentPath(input: {
  readonly attachmentsDir: string
  readonly attachment: ChatAttachment
}): string | null
{
  const relativePath = attachmentRelativePath(input.attachment)
  if (!relativePath) return null
  return resolveAttachmentRelativePath({
    attachmentsDir: input.attachmentsDir,
    relativePath,
  })
}

export function resolveAttachmentPathById(input: {
  readonly attachmentsDir: string
  readonly attachmentId: string
}): string | null
{
  const normalizedId = normalizeAttachmentRelativePath(input.attachmentId)
  if (!normalizedId || normalizedId.includes('/') || normalizedId.includes('.'))
  {
    return null
  }
  const pending = parsePendingAttachmentId(normalizedId)
  if (!pending && !/^[a-zA-Z0-9_-]{1,256}$/.test(normalizedId)) return null
  const fixedExtension = pending?.extension ?? parseAttachmentFileExtension(normalizedId)
  if (fixedExtension)
  {
    const relativePath = `${normalizedId}${fixedExtension}`
    return inspectManagedFile({ attachmentsDir: input.attachmentsDir, relativePath })?.path ?? null
  }
  for (const extension of ATTACHMENT_FILENAME_EXTENSIONS)
  {
    const maybePath = resolveAttachmentRelativePath({
      attachmentsDir: input.attachmentsDir,
      relativePath: `${normalizedId}${extension}`,
    })
    if (
      maybePath &&
      inspectManagedFile({
        attachmentsDir: input.attachmentsDir,
        relativePath: `${normalizedId}${extension}`,
      })
    )
    {
      return maybePath
    }
  }
  return null
}

export const inspectManagedAttachmentFile = (input: {
  readonly attachmentsDir: string
  readonly attachment: ChatAttachment
}) =>
  Effect.sync(() =>
  {
    const relativePath = attachmentRelativePath(input.attachment)
    return relativePath
      ? inspectManagedFile({ attachmentsDir: input.attachmentsDir, relativePath })
      : null
  })

export function parseAttachmentIdFromRelativePath(relativePath: string): string | null
{
  const normalized = normalizeAttachmentRelativePath(relativePath)
  if (!normalized || normalized.includes('/'))
  {
    return null
  }
  const extensionIndex = normalized.lastIndexOf('.')
  if (extensionIndex <= 0)
  {
    return null
  }
  const id = normalized.slice(0, extensionIndex)
  return id.length > 0 && !id.includes('.') ? id : null
}
