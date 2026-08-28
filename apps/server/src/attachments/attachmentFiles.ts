// apps/server/src/attachments/attachmentFiles.ts
// verify and stream managed attachment files without following symlinks

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from 'node:fs'
import * as NodeFSP from 'node:fs/promises'
import * as NodePath from 'node:path'
import * as NodeCrypto from 'node:crypto'
import * as Effect from 'effect/Effect'
import * as Data from 'effect/Data'

import { resolveAttachmentRelativePath } from './attachmentPaths.ts'

class ManagedAttachmentFileError extends Data.TaggedError('ManagedAttachmentFileError')<{
  readonly cause: unknown
}>
{}

export function isSafeManagedPath(
  input: { attachmentsDir: string; relativePath: string },
  allowMissing = false,
): boolean
{
  const target = resolveAttachmentRelativePath(input)
  if (
    !target ||
    input.relativePath !==
      NodePath.relative(NodePath.resolve(input.attachmentsDir), target)
        .split(NodePath.sep)
        .join('/')
  )
    return false
  let current = NodePath.resolve(input.attachmentsDir)
  try
  {
    const root = NodeFS.lstatSync(current)
    if (!root.isDirectory() || root.isSymbolicLink()) return false
    for (const part of input.relativePath.split('/'))
    {
      current = NodePath.join(current, part)
      try
      {
        if (NodeFS.lstatSync(current).isSymbolicLink()) return false
      }
      catch (cause)
      {
        if (allowMissing && (cause as NodeJS.ErrnoException).code === 'ENOENT') return true
        return false
      }
    }
    return true
  }
  catch
  {
    return false
  }
}

export function inspectManagedFile(input: {
  attachmentsDir: string
  relativePath: string
}): { path: string; sizeBytes: number; mtimeMs: number } | null
{
  if (!isSafeManagedPath(input)) return null
  const path = resolveAttachmentRelativePath(input)!
  try
  {
    const stat = NodeFS.lstatSync(path)
    return stat.isFile() && Number.isSafeInteger(stat.size)
      ? { path, sizeBytes: stat.size, mtimeMs: stat.mtimeMs }
      : null
  }
  catch
  {
    return null
  }
}

// one fixed buffer bounds generic-file hashing and copying regardless of attachment count
export const processManagedAttachmentFile = (input: {
  readonly attachmentsDir: string
  readonly relativePath: string
  readonly expectedSize: number
  readonly copyTo?: string
}) =>
  Effect.tryPromise({
    try: async (signal) =>
    {
      const source = inspectManagedFile(input)
      if (!source || source.sizeBytes !== input.expectedSize)
        throw new Error('Managed attachment size or path is invalid.')
      const sourceHandle = await NodeFSP.open(
        source.path,
        NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
      )
      let destination: NodeFSP.FileHandle | undefined
      let digest: string | undefined
      let closeError: unknown
      try
      {
        if (input.copyTo !== undefined)
        {
          const target = { attachmentsDir: input.attachmentsDir, relativePath: input.copyTo }
          if (!isSafeManagedPath(target, true))
            throw new Error('Unsafe attachment copy destination.')
          const targetPath = resolveAttachmentRelativePath(target)!
          await NodeFSP.mkdir(NodePath.dirname(targetPath), { recursive: true })
          if (!isSafeManagedPath(target, true))
            throw new Error('Unsafe attachment copy destination.')
          destination = await NodeFSP.open(
            targetPath,
            NodeFS.constants.O_WRONLY |
              NodeFS.constants.O_CREAT |
              NodeFS.constants.O_EXCL |
              NodeFS.constants.O_NOFOLLOW,
            0o600,
          )
        }
        const stat = await sourceHandle.stat()
        if (!stat.isFile() || stat.size !== input.expectedSize)
          throw new Error('Attachment changed before reading.')
        const hash = NodeCrypto.createHash('sha256')
        const buffer = Buffer.allocUnsafe(64 * 1024)
        let total = 0
        for (;;)
        {
          signal.throwIfAborted()
          const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, null)
          if (bytesRead === 0) break
          total += bytesRead
          if (total > input.expectedSize) throw new Error('Attachment grew while reading.')
          hash.update(buffer.subarray(0, bytesRead))
          if (destination)
          {
            let offset = 0
            while (offset < bytesRead)
            {
              const result = await destination.write(buffer, offset, bytesRead - offset)
              if (result.bytesWritten === 0) throw new Error('Attachment copy made no progress.')
              offset += result.bytesWritten
            }
          }
        }
        if (total !== input.expectedSize) throw new Error('Attachment changed while reading.')
        digest = hash.digest('hex')
      }
      finally
      {
        try
        {
          await destination?.close()
        }
        catch (cause)
        {
          closeError = cause
        }
        try
        {
          await sourceHandle.close()
        }
        catch (cause)
        {
          closeError ??= cause
        }
      }
      if (closeError !== undefined) throw closeError
      return digest!
    },
    catch: (cause) => new ManagedAttachmentFileError({ cause }),
  })
