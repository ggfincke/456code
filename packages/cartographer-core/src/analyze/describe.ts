// packages/cartographer-core/src/analyze/describe.ts
// per-file descriptions: header comment first, annotation sidecar fallback

import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import { contentHash, type AnnotationEntry } from './annotations.js'

const MAX_HEADER_LINES = 15
const MAX_DESCRIPTION_LENGTH = 160

// directives & metadata that never count as a description
const SKIP_LINE =
  /^(eslint|@ts-|ts-check|ts-nocheck|prettier|biome|@jest|@vitest|jshint|jslint|istanbul|c8 |v8 |sourceMappingURL|noinspection)/i
const LEGAL_LINE = /copyright|licen[cs]e|spdx|all rights reserved|@author/i
const JSDOC_TAG = /^@\w+/

export interface FileDescription
{
  description: string
  // where the description came from
  source: 'header' | 'annotation-sidecar'
  // true -> sidecar annotation whose content hash no longer matches
  stale?: true
  // true -> the header's path line doesn't match the file's actual path
  headerPathStale?: true
}

// read every module & resolve its description, keyed by source path
export function buildDescriptionTable(
  root: string,
  moduleIds: string[],
  annotations: Map<string, AnnotationEntry> = new Map(),
): Map<string, FileDescription>
{
  const table = new Map<string, FileDescription>()
  for (const id of moduleIds)
  {
    let text: string
    try
    {
      text = NodeFS.readFileSync(NodePath.resolve(root, id), 'utf-8')
    }
    catch
    {
      // unreadable file -> no description
      continue
    }
    const fromHeader = parseHeaderDescription(text, id)
    if (fromHeader)
    {
      table.set(id, {
        description: fromHeader.description,
        source: 'header',
        ...(fromHeader.headerPathStale ? { headerPathStale: true } : {}),
      })
      continue
    }
    const annotation = annotations.get(id)
    if (annotation)
    {
      table.set(id, {
        description: annotation.description,
        source: 'annotation-sidecar',
        ...(annotation.hash === contentHash(text) ? {} : { stale: true }),
      })
    }
  }
  return table
}

interface HeaderDescription
{
  description: string
  headerPathStale?: true
}

// header = leading comment block (// or /* */) before any code, after shebang
function parseHeaderDescription(text: string, fileId: string): HeaderDescription | undefined
{
  const lines = text.split('\n', MAX_HEADER_LINES).map((l) => l.trimEnd())
  let index = 0
  if (lines[index]?.startsWith('#!'))
  {
    index += 1
  }
  while (lines[index]?.trim() === '')
  {
    index += 1
  }
  const first = lines[index]?.trimStart()
  if (first === undefined)
  {
    return undefined
  }

  let raw: string[]
  if (first.startsWith('//'))
  {
    raw = []
    while (lines[index]?.trimStart().startsWith('//'))
    {
      raw.push(lines[index]!.trimStart().replace(/^\/\/+\s?/, ''))
      index += 1
    }
  }
  else if (first.startsWith('/*'))
  {
    raw = []
    let closed = false
    while (index < lines.length && !closed)
    {
      const sourceLine = lines[index]
      if (sourceLine === undefined)
      {
        break
      }
      let line = sourceLine.trimStart().replace(/^\/\*+\s?/, '')
      const end = line.indexOf('*/')
      if (end >= 0)
      {
        line = line.slice(0, end)
        closed = true
      }
      raw.push(line.replace(/^\*+\s?/, ''))
      index += 1
    }
  }
  else
  {
    return undefined
  }

  const parts: string[] = []
  let headerPathStale: true | undefined
  let sawContent = false
  for (const entry of raw)
  {
    const line = entry.trim()
    if (line === '' || SKIP_LINE.test(line) || LEGAL_LINE.test(line) || JSDOC_TAG.test(line))
    {
      continue
    }
    // the header's first content line is its own-path line whenever it is
    // path-shaped -> never prose, & stale when it no longer matches the file
    if (!sawContent)
    {
      sawContent = true
      if (isPathShaped(line))
      {
        if (!isPathLine(line, fileId))
        {
          headerPathStale = true
        }
        continue
      }
    }
    if (isPathLine(line, fileId))
    {
      continue
    }
    parts.push(line)
  }
  if (parts.length === 0)
  {
    return undefined
  }
  const joined = parts.join(' ')
  const description =
    joined.length > MAX_DESCRIPTION_LENGTH
      ? `${joined.slice(0, MAX_DESCRIPTION_LENGTH - 3)}...`
      : joined
  return {
    description,
    ...(headerPathStale ? { headerPathStale } : {}),
  }
}

// path-shaped = looks like a file path (no spaces, a slash or dot extension)
// & not a url; checked only against the header's first content line
function isPathShaped(line: string): boolean
{
  if (line.includes(' ') || line.includes('://'))
  {
    return false
  }
  return line.includes('/') || /\.\w+$/.test(line)
}

function canonicalRepoPath(path: string): string | undefined
{
  if (path.includes(' '))
  {
    return undefined
  }
  let normalized = path.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized))
  {
    return undefined
  }
  for (let index = 0; index < normalized.length; index += 1)
  {
    if (normalized.charCodeAt(index) < 0x20)
    {
      return undefined
    }
  }
  if (normalized.startsWith('./'))
  {
    normalized = normalized.slice(2)
  }
  if (
    normalized === '' ||
    normalized.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  )
  {
    return undefined
  }
  return normalized
}

// path line = the exact normalized repo-relative file reference
function isPathLine(line: string, fileId: string): boolean
{
  const path = canonicalRepoPath(line)
  return path !== undefined && path === canonicalRepoPath(fileId)
}
