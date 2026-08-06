// apps/server/src/vcs/ExactGitSnapshotParse.ts
// decode git tree/index listings for exact snapshots

// @effect-diagnostics nodeBuiltinImport:off

import * as NodePath from 'node:path'

import { exactError } from './ExactGitSnapshotGit.ts'

export const ALLOWED_INDEX_MODES = new Set(['100644', '100755', '120000', '160000'])
export const REGULAR_MODES = new Set(['100644', '100755'])
const fatalUtf8Decoder = new TextDecoder('utf-8', { fatal: true })

export interface GitTreeEntry
{
  readonly mode: string
  readonly type: 'blob' | 'commit'
  readonly oid: string
  readonly path: string
}

export interface IndexEntry
{
  readonly mode: string
  readonly oid: string
  readonly stage: number
  readonly path: string
}
export interface MaterializedTreeEntry
{
  readonly path: string
  readonly mode: string
  readonly type: 'blob' | 'commit'
  readonly oid: string
  readonly size: number
}

export function nulRecords(buffer: Buffer, label: string): ReadonlyArray<Buffer>
{
  if (buffer.byteLength === 0) return []
  if (buffer.at(-1) !== 0)
  {
    throw exactError('git-failed', `Git returned malformed ${label}.`)
  }

  const records: Buffer[] = []
  let offset = 0
  while (offset < buffer.byteLength)
  {
    const end = buffer.indexOf(0, offset)
    if (end < 0)
    {
      throw exactError('git-failed', `Git returned malformed ${label}.`)
    }
    if (end > offset) records.push(buffer.subarray(offset, end))
    offset = end + 1
  }
  return records
}

export function decodePath(bytes: Buffer): string
{
  let path: string
  try
  {
    path = fatalUtf8Decoder.decode(bytes)
  }
  catch (cause)
  {
    throw exactError(
      'unsupported-entry',
      'Git paths must be valid UTF-8 for exact snapshot materialization.',
      cause,
    )
  }
  validateGitPath(path)
  return path
}

export function validateGitPath(path: string): void
{
  const segments = path.split('/')
  const hasControlCharacter = [...path].some((character) =>
  {
    const codePoint = character.codePointAt(0)!
    return codePoint <= 0x1f || codePoint === 0x7f
  })
  if (
    path.length === 0 ||
    path.includes('\\') ||
    path.startsWith('/') ||
    /^[A-Za-z]:/u.test(path) ||
    hasControlCharacter ||
    NodePath.isAbsolute(path) ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        segment.toLowerCase() === '.git',
    )
  )
  {
    throw exactError('unsupported-entry', `Git path '${path}' is unsafe to materialize.`)
  }
}

export function parseHeadTree(buffer: Buffer): ReadonlyArray<GitTreeEntry>
{
  return nulRecords(buffer, 'HEAD tree entries').map((record) =>
  {
    const separator = record.indexOf(0x09)
    if (separator < 0)
    {
      throw exactError('git-failed', 'Git returned a malformed HEAD tree entry.')
    }
    const metadata = record.subarray(0, separator).toString('ascii')
    const match = /^([0-9]{6}) (blob|commit) ([0-9a-f]{40}(?:[0-9a-f]{24})?)$/u.exec(metadata)
    if (
      !match?.[1] ||
      !match[2] ||
      !match[3] ||
      !ALLOWED_INDEX_MODES.has(match[1]) ||
      (match[2] === 'commit' && match[1] !== '160000') ||
      (match[2] === 'blob' && match[1] === '160000')
    )
    {
      throw exactError('unsupported-entry', 'The repository contains an unsupported Git entry.')
    }
    return {
      mode: match[1],
      type: match[2] as 'blob' | 'commit',
      oid: match[3],
      path: decodePath(record.subarray(separator + 1)),
    }
  })
}

export function parseIndex(buffer: Buffer): ReadonlyArray<IndexEntry>
{
  return nulRecords(buffer, 'index entries').map((record) =>
  {
    const separator = record.indexOf(0x09)
    if (separator < 0)
    {
      throw exactError('git-failed', 'Git returned a malformed index entry.')
    }
    const metadata = record.subarray(0, separator).toString('ascii')
    const match = /^([0-9]{6}) ([0-9a-f]{40}(?:[0-9a-f]{24})?) ([0-3])$/u.exec(metadata)
    if (!match?.[1] || !match[2] || !match[3] || !ALLOWED_INDEX_MODES.has(match[1]))
    {
      throw exactError('unsupported-entry', 'The repository index has an unsupported entry.')
    }
    return {
      mode: match[1],
      oid: match[2],
      stage: Number(match[3]),
      path: decodePath(record.subarray(separator + 1)),
    }
  })
}

export function parseMaterializedTree(buffer: Buffer): ReadonlyArray<MaterializedTreeEntry>
{
  return nulRecords(buffer, 'tree listing').map((record) =>
  {
    const separator = record.indexOf(0x09)
    if (separator < 0)
    {
      throw exactError('git-failed', 'Git returned a malformed tree entry.')
    }
    const metadata = record.subarray(0, separator).toString('ascii')
    const match = /^([0-9]{6}) (blob|commit) ([0-9a-f]{40}(?:[0-9a-f]{24})?)\s+([0-9]+|-)$/u.exec(
      metadata,
    )
    if (!match?.[1] || !match[2] || !match[3] || !match[4])
    {
      throw exactError('git-failed', 'Git returned a malformed tree entry.')
    }
    const mode = match[1]
    const type = match[2] as 'blob' | 'commit'
    if (
      (type === 'blob' && !REGULAR_MODES.has(mode) && mode !== '120000') ||
      (type === 'commit' && mode !== '160000')
    )
    {
      throw exactError('unsupported-entry', 'The Git tree contains an unsupported entry.')
    }
    const size = match[4] === '-' ? 0 : Number(match[4])
    if (!Number.isSafeInteger(size) || size < 0)
    {
      throw exactError('git-failed', 'Git returned an invalid tree entry size.')
    }
    return {
      mode,
      type,
      oid: match[3],
      size,
      path: decodePath(record.subarray(separator + 1)),
    }
  })
}
