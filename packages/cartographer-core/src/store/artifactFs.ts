// packages/cartographer-core/src/store/artifactFs.ts
// symlink-safe artifact dir resolution & no-follow write primitives

import * as NodeCrypto from 'node:crypto'
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import { DEFAULT_OUT_DIR, outDirPath } from './paths.js'

// ! repos are untrusted input: a committed `.cartographer` symlink must not
// ! redirect artifact writes outside the analyzed repository (F02)
export function ensureOutDir(root: string, outDir?: string): string
{
  const dir = outDirPath(root, outDir)
  assertNotSymlink(dir, 'artifact directory')
  NodeFS.mkdirSync(dir, { recursive: true })
  if (outDir === undefined || outDir === DEFAULT_OUT_DIR)
  {
    const realRoot = NodeFS.realpathSync(NodePath.resolve(root))
    const expected = NodePath.join(realRoot, DEFAULT_OUT_DIR)
    if (NodeFS.realpathSync(dir) !== expected)
    {
      throw new Error(
        `refusing to write artifacts: ${dir} resolves outside ${realRoot} ` +
          '(symlinked path component) -> remove the symlink or pass --out',
      )
    }
  }
  return dir
}

export function assertNotSymlink(path: string, what: string): void
{
  let stat
  try
  {
    stat = NodeFS.lstatSync(path)
  }
  catch
  {
    return
  }
  if (stat.isSymbolicLink())
  {
    throw new Error(`refusing to write ${what}: ${path} is a symlink -> remove it first`)
  }
}

function writeComplete(fd: number, path: string, data: string): void
{
  const bytes = Buffer.from(data)
  let offset = 0
  while (offset < bytes.length)
  {
    const written = NodeFS.writeSync(fd, bytes, offset, bytes.length - offset, offset)
    if (written === 0)
    {
      throw new Error(`could not finish writing ${path}`)
    }
    offset += written
  }
}

// overwrite in place w/o following a symlinked final target
export function writeFileNoFollow(path: string, data: string): void
{
  assertNotSymlink(path, 'artifact file')
  const noFollow = 'O_NOFOLLOW' in NodeFS.constants ? NodeFS.constants.O_NOFOLLOW : 0
  const flags =
    NodeFS.constants.O_WRONLY | NodeFS.constants.O_CREAT | NodeFS.constants.O_TRUNC | noFollow
  const fd = NodeFS.openSync(path, flags, 0o644)
  try
  {
    writeComplete(fd, path, data)
  }
  finally
  {
    NodeFS.closeSync(fd)
  }
}

// exclusive temp write + rename -> atomic publish that replaces (not follows)
// a symlinked final target; unique temp names survive concurrent writers
export function writeFileAtomic(path: string, data: string): void
{
  const tempPath = `${path}.${process.pid}.${NodeCrypto.randomBytes(4).toString('hex')}.tmp`
  let fd: number | undefined
  let ownsTemp = false
  try
  {
    fd = NodeFS.openSync(
      tempPath,
      NodeFS.constants.O_WRONLY | NodeFS.constants.O_CREAT | NodeFS.constants.O_EXCL,
      0o644,
    )
    ownsTemp = true
    writeComplete(fd, tempPath, data)
    const completedFd = fd
    fd = undefined
    NodeFS.closeSync(completedFd)
    NodeFS.renameSync(tempPath, path)
    ownsTemp = false
  }
  finally
  {
    try
    {
      if (fd !== undefined)
      {
        NodeFS.closeSync(fd)
      }
    }
    finally
    {
      if (ownsTemp)
      {
        NodeFS.rmSync(tempPath, { force: true })
      }
    }
  }
}

// publish a complete inode only when the final path is still unclaimed
export function tryWriteFileAtomicExclusive(path: string, data: string): boolean
{
  const tempPath = `${path}.${process.pid}.${NodeCrypto.randomBytes(4).toString('hex')}.tmp`
  let fd: number | undefined
  let ownsTemp = false
  try
  {
    fd = NodeFS.openSync(
      tempPath,
      NodeFS.constants.O_WRONLY | NodeFS.constants.O_CREAT | NodeFS.constants.O_EXCL,
      0o644,
    )
    ownsTemp = true
    writeComplete(fd, tempPath, data)
    const completedFd = fd
    fd = undefined
    NodeFS.closeSync(completedFd)

    try
    {
      NodeFS.linkSync(tempPath, path)
      return true
    }
    catch (error)
    {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      {
        return false
      }
      throw error
    }
  }
  finally
  {
    try
    {
      if (fd !== undefined)
      {
        NodeFS.closeSync(fd)
      }
    }
    finally
    {
      if (ownsTemp)
      {
        NodeFS.rmSync(tempPath, { force: true })
      }
    }
  }
}
