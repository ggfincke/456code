// packages/cartographer-core/src/store/patches.ts
// graph patch (proposal) files under <root>/.cartographer/patches/

import * as NodeCrypto from 'node:crypto'
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import { loadConfig, otherSystemId, resolveGroup, resolveSystem } from '../analyze/config.js'
import {
  MAX_PATCH_BYTES,
  parseGraphPatch,
  type GraphPatch,
  type GraphPatchOp,
  type PatchNodeResolver,
} from '../analyze/patch.js'
import type { PatchListEntry, PatchOpTotals } from '../contracts/atlasContract.js'
import {
  assertNotSymlink,
  ensureOutDir,
  tryWriteFileAtomicExclusive,
  writeFileAtomic,
} from './artifactFs.js'
import { patchesDirPath } from './paths.js'
import { decodeCursorEnvelope, encodeCursorEnvelope, hashSignature } from './cursorCodec.js'

// filename stems (= patch ids) accepted from disk & query params; the
// gate runs before any path join, so ids can never traverse
export const SAFE_PATCH_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

const SLUG_MAX_LENGTH = 64
const PATCH_ID_RESERVATION_ATTEMPTS = 10_000
const PATCH_CATALOG_CACHE_CAP = 4
const PATCH_CURSOR_DOMAIN = 'patch-list'
const PATCH_CURSOR_MAX_LENGTH = 1024
const PATCH_CURSOR_MAX_BYTES = 512
const PATCH_CATALOG_SCAN_ATTEMPTS = 3

interface PatchCatalog
{
  dir: string
  rawRevision: string
  revision: string
  entries: PatchListEntry[]
}

interface PatchCursor
{
  domain: typeof PATCH_CURSOR_DOMAIN
  version: 1
  revision: string
  offset: number
  signature: string
}

export interface PatchPage
{
  patches: PatchListEntry[]
  total: number
  returned: number
  omitted: number
  remaining: number
  revision: string
  patchesPath: string
  nextCursor?: string
}

export class PatchCursorError extends Error
{
  readonly kind: 'invalid' | 'stale'

  constructor(kind: 'invalid' | 'stale')
  {
    super(
      kind === 'stale'
        ? 'patch cursor is stale; restart the listing'
        : 'patch cursor is invalid for this listing',
    )
    this.kind = kind
  }
}

const catalogCache = new Map<string, PatchCatalog>()

export class PatchSizeError extends Error
{
  readonly bytes: number

  constructor(bytes: number)
  {
    super(`patch is ${bytes} bytes; maximum is ${MAX_PATCH_BYTES}`)
    this.bytes = bytes
  }
}

export function patchOpTotals(ops: readonly GraphPatchOp[]): PatchOpTotals
{
  const totals: PatchOpTotals = {
    addFiles: 0,
    removeFiles: 0,
    moves: 0,
    addImports: 0,
    removeImports: 0,
  }
  for (const op of ops)
  {
    switch (op.op)
    {
      case 'add_file':
        totals.addFiles += 1
        break
      case 'remove_file':
        totals.removeFiles += 1
        break
      case 'move_file':
        totals.moves += 1
        break
      case 'add_import':
        totals.addImports += 1
        break
      case 'remove_import':
        totals.removeImports += 1
        break
    }
  }
  return totals
}

// group/system membership for files a patch proposes, mirroring the
// assignment buildGraph performs for real files
export function patchNodeResolver(root: string): PatchNodeResolver
{
  const config = loadConfig(root)
  const fallbackSystem = otherSystemId(config)
  return (path) =>
  {
    const system = resolveSystem(path, config)?.id ?? fallbackSystem
    return {
      group: resolveGroup(path, config).id,
      ...(system !== undefined ? { system } : {}),
    }
  }
}

function slugify(name: string): string
{
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH)
  return slug.length > 0 ? slug : 'patch'
}

function availablePatchId(slug: string, attempt: number): string
{
  if (attempt === 1)
  {
    return slug
  }
  const suffix = `-${attempt}`
  return `${slug.slice(0, SLUG_MAX_LENGTH - suffix.length)}${suffix}`
}

function patchFilePath(dir: string, id: string): string
{
  return NodePath.join(dir, `${id}.json`)
}

export function patchArtifactPath(root: string, id: string, outDir?: string): string
{
  if (!SAFE_PATCH_ID.test(id))
  {
    throw new Error(`invalid patch id: ${id}`)
  }
  return patchFilePath(patchesDirPath(root, outDir), id)
}

export function serializePatch(patch: GraphPatch): string
{
  const serialized = `${JSON.stringify(patch, null, 2)}\n`
  const bytes = Buffer.byteLength(serialized)
  if (bytes > MAX_PATCH_BYTES)
  {
    throw new PatchSizeError(bytes)
  }
  return serialized
}

function statEntry(path: string): { size: number; symlink: boolean; regular: boolean } | undefined
{
  try
  {
    const stat = NodeFS.lstatSync(path)
    return {
      size: stat.size,
      symlink: stat.isSymbolicLink(),
      regular: stat.isFile(),
    }
  }
  catch (error)
  {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
    {
      return undefined
    }
    throw error
  }
}

// no-follow bounded read keeps a raced file within the per-patch byte ceiling
function readPatchBytes(path: string): Buffer | undefined
{
  const before = statEntry(path)
  if (!before || before.symlink || !before.regular || before.size > MAX_PATCH_BYTES)
  {
    return undefined
  }
  const noFollow = 'O_NOFOLLOW' in NodeFS.constants ? NodeFS.constants.O_NOFOLLOW : 0
  let fd: number
  try
  {
    fd = NodeFS.openSync(path, NodeFS.constants.O_RDONLY | noFollow)
  }
  catch (error)
  {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ELOOP')
    {
      return undefined
    }
    throw error
  }
  try
  {
    const stat = NodeFS.fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_PATCH_BYTES)
    {
      return undefined
    }
    const bytes = Buffer.allocUnsafe(stat.size)
    let offset = 0
    while (offset < bytes.length)
    {
      const count = NodeFS.readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (count === 0)
      {
        break
      }
      offset += count
    }
    const extra = Buffer.allocUnsafe(1)
    if (NodeFS.readSync(fd, extra, 0, 1, offset) > 0)
    {
      return undefined
    }
    return offset === bytes.length ? bytes : bytes.subarray(0, offset)
  }
  finally
  {
    NodeFS.closeSync(fd)
  }
}

function scanPatchFiles(
  dir: string,
  parseEntries: boolean,
): {
  rawRevision: string
  entries?: PatchListEntry[]
}
{
  let names: string[]
  try
  {
    names = NodeFS.readdirSync(dir)
  }
  catch (error)
  {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
    {
      throw error
    }
    names = []
  }
  const entries: PatchListEntry[] | undefined = parseEntries ? [] : undefined
  const hash = NodeCrypto.createHash('sha256').update(`${PATCH_CURSOR_DOMAIN}\0raw\0`)
  for (const name of names.sort((a, b) => a.localeCompare(b)))
  {
    if (!name.endsWith('.json'))
    {
      continue
    }
    const id = name.slice(0, -'.json'.length)
    if (!SAFE_PATCH_ID.test(id))
    {
      continue
    }
    const bytes = readPatchBytes(patchFilePath(dir, id))
    if (bytes)
    {
      hash.update(`${id.length}:${id}:${bytes.length}:`)
      hash.update(bytes)
      entries?.push(parseCatalogEntry(id, bytes))
    }
  }
  return {
    rawRevision: hash.digest('base64url'),
    ...(entries === undefined ? {} : { entries }),
  }
}

function parseCatalogEntry(id: string, bytes: Buffer): PatchListEntry
{
  try
  {
    const patch = parseGraphPatch(JSON.parse(bytes.toString('utf-8')))
    return {
      id,
      name: patch.meta.name,
      ...(patch.meta.description !== undefined ? { description: patch.meta.description } : {}),
      ...(patch.meta.author !== undefined ? { author: patch.meta.author } : {}),
      createdAt: patch.meta.createdAt,
      ...(patch.meta.baseline !== undefined ? { baseline: patch.meta.baseline } : {}),
      opTotals: patchOpTotals(patch.ops),
    }
  }
  catch (err)
  {
    return {
      id,
      invalid: { message: err instanceof Error ? err.message : String(err) },
    }
  }
}

function clonePatchListEntry(entry: PatchListEntry): PatchListEntry
{
  return {
    ...entry,
    ...(entry.baseline ? { baseline: { ...entry.baseline } } : {}),
    ...(entry.opTotals ? { opTotals: { ...entry.opTotals } } : {}),
    ...(entry.invalid ? { invalid: { ...entry.invalid } } : {}),
  }
}

function catalogCacheKey(dir: string, rawRevision: string): string
{
  return `${dir}\0${rawRevision}`
}

function cacheCatalog(catalog: PatchCatalog): PatchCatalog
{
  const key = catalogCacheKey(catalog.dir, catalog.rawRevision)
  catalogCache.delete(key)
  catalogCache.set(key, catalog)
  while (catalogCache.size > PATCH_CATALOG_CACHE_CAP)
  {
    const oldest = catalogCache.keys().next().value as string | undefined
    if (oldest === undefined)
    {
      break
    }
    catalogCache.delete(oldest)
  }
  return catalog
}

function cachedCatalogByRevision(dir: string, revision: string): PatchCatalog | undefined
{
  for (const [key, catalog] of catalogCache)
  {
    if (catalog.dir === dir && catalog.revision === revision)
    {
      catalogCache.delete(key)
      catalogCache.set(key, catalog)
      return catalog
    }
  }
  return undefined
}

function loadCurrentPatchCatalog(root: string, outDir?: string): PatchCatalog
{
  const dir = patchesDirPath(root, outDir)
  for (let attempt = 0; attempt < PATCH_CATALOG_SCAN_ATTEMPTS; attempt += 1)
  {
    const first = scanPatchFiles(dir, false)
    const key = catalogCacheKey(dir, first.rawRevision)
    const cached = catalogCache.get(key)
    if (cached)
    {
      catalogCache.delete(key)
      catalogCache.set(key, cached)
      return cached
    }
    const second = scanPatchFiles(dir, true)
    if (second.rawRevision !== first.rawRevision)
    {
      continue
    }
    const entries = (second.entries ?? []).sort(
      (a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || a.id.localeCompare(b.id),
    )
    const revisionHash = NodeCrypto.createHash('sha256').update(
      `${PATCH_CURSOR_DOMAIN}\0catalog\0${dir}\0${first.rawRevision}\0`,
    )
    entries.forEach((entry, index) =>
    {
      revisionHash.update(`${index}:${entry.id.length}:${entry.id}:${entry.createdAt ?? ''}\0`)
    })
    return cacheCatalog({
      dir,
      rawRevision: first.rawRevision,
      revision: revisionHash.digest('base64url'),
      entries,
    })
  }
  throw new Error('patch catalog kept changing during the listing scan')
}

export function patchCatalogRevision(root: string, outDir?: string): string
{
  return loadCurrentPatchCatalog(root, outDir).revision
}

// query-binding integrity only; project/route guards remain the auth boundary
function cursorSignature(dir: string, revision: string, offset: number): string
{
  return hashSignature([PATCH_CURSOR_DOMAIN, '1', dir, revision, String(offset)])
}

function encodePatchCursor(catalog: PatchCatalog, offset: number): string
{
  return encodeCursorEnvelope<PatchCursor>({
    domain: PATCH_CURSOR_DOMAIN,
    version: 1,
    revision: catalog.revision,
    offset,
    signature: cursorSignature(catalog.dir, catalog.revision, offset),
  })
}

function decodePatchCursor(dir: string, cursor: string): PatchCursor
{
  if (
    cursor.length > PATCH_CURSOR_MAX_LENGTH ||
    Buffer.from(cursor, 'base64url').byteLength > PATCH_CURSOR_MAX_BYTES
  )
  {
    throw new PatchCursorError('invalid')
  }
  const value = decodeCursorEnvelope<PatchCursor>(cursor)
  const keys = value ? Object.keys(value).sort() : []
  if (
    !value ||
    keys.join(',') !== 'domain,offset,revision,signature,version' ||
    value.domain !== PATCH_CURSOR_DOMAIN ||
    value.version !== 1 ||
    typeof value.revision !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.revision) ||
    !Number.isSafeInteger(value.offset) ||
    value.offset! < 1 ||
    typeof value.signature !== 'string' ||
    !/^[A-Za-z0-9_-]{18}$/.test(value.signature) ||
    value.signature !== cursorSignature(dir, value.revision, value.offset!)
  )
  {
    throw new PatchCursorError('invalid')
  }
  return value as PatchCursor
}

export function listPatchPage(
  root: string,
  limit: number,
  cursor?: string,
  outDir?: string,
): PatchPage
{
  if (!Number.isSafeInteger(limit) || limit < 1)
  {
    throw new Error('patch page limit must be a safe positive integer')
  }
  const dir = patchesDirPath(root, outDir)
  const decoded = cursor ? decodePatchCursor(dir, cursor) : undefined
  let catalog = decoded ? cachedCatalogByRevision(dir, decoded.revision) : undefined
  if (!catalog)
  {
    catalog = loadCurrentPatchCatalog(root, outDir)
    if (decoded && decoded.revision !== catalog.revision)
    {
      throw new PatchCursorError('stale')
    }
  }
  const offset = decoded?.offset ?? 0
  if (offset >= catalog.entries.length && offset !== 0)
  {
    throw new PatchCursorError('invalid')
  }
  const patches = catalog.entries.slice(offset, offset + limit).map(clonePatchListEntry)
  const nextOffset = offset + patches.length
  const remaining = catalog.entries.length - nextOffset
  return {
    patches,
    total: catalog.entries.length,
    returned: patches.length,
    omitted: catalog.entries.length - patches.length,
    remaining,
    revision: catalog.revision,
    patchesPath: catalog.dir,
    ...(remaining > 0 ? { nextCursor: encodePatchCursor(catalog, nextOffset) } : {}),
  }
}

export function listPatches(root: string, outDir?: string): PatchListEntry[]
{
  return loadCurrentPatchCatalog(root, outDir).entries.map(clonePatchListEntry)
}

export function loadPatch(root: string, id: string, outDir?: string): GraphPatch
{
  if (!SAFE_PATCH_ID.test(id))
  {
    throw new Error(`invalid patch id: ${id}`)
  }
  const path = patchArtifactPath(root, id, outDir)
  const stat = statEntry(path)
  if (!stat)
  {
    throw new Error(`no patch at ${path}`)
  }
  if (stat.symlink)
  {
    throw new Error(`refusing to read ${path}: symlink`)
  }
  if (!stat.regular)
  {
    throw new Error(`refusing to read ${path}: not a regular file`)
  }
  if (stat.size > MAX_PATCH_BYTES)
  {
    throw new Error(`patch ${id} exceeds ${MAX_PATCH_BYTES} bytes`)
  }
  const bytes = readPatchBytes(path)
  if (!bytes)
  {
    throw new Error(`refusing to read ${path}: file changed during read`)
  }
  return parseGraphPatch(JSON.parse(bytes.toString('utf-8')))
}

export function savePatch(
  root: string,
  patch: GraphPatch,
  outDir?: string,
): { id: string; path: string }
{
  const serialized = serializePatch(patch)
  const dir = preparePatchesDir(root, outDir)
  const slug = slugify(patch.meta.name)
  for (let attempt = 1; attempt <= PATCH_ID_RESERVATION_ATTEMPTS; attempt += 1)
  {
    const id = availablePatchId(slug, attempt)
    const path = patchFilePath(dir, id)
    if (tryWriteFileAtomicExclusive(path, serialized))
    {
      return { id, path }
    }
  }
  throw new Error(`could not reserve a patch id after ${PATCH_ID_RESERVATION_ATTEMPTS} attempts`)
}

// write under a caller-chosen id (create or overwrite) -> the editor's
// save-in-place path; slug derivation & collision suffixing do not apply
export function savePatchAs(
  root: string,
  id: string,
  patch: GraphPatch,
  outDir?: string,
): { id: string; path: string }
{
  if (!SAFE_PATCH_ID.test(id))
  {
    throw new Error(`invalid patch id: ${id}`)
  }
  const serialized = serializePatch(patch)
  const dir = preparePatchesDir(root, outDir)
  const path = patchFilePath(dir, id)
  assertNotSymlink(path, 'patch file')
  writeFileAtomic(path, serialized)
  return { id, path }
}

function preparePatchesDir(root: string, outDir?: string): string
{
  ensureOutDir(root, outDir)
  const dir = patchesDirPath(root, outDir)
  assertNotSymlink(dir, 'patches directory')
  NodeFS.mkdirSync(dir, { recursive: true })
  return dir
}

// release catalog revisions associated with one artifact output directory
export function disposePatchCatalogCache(root: string, outDir?: string): void
{
  const dir = patchesDirPath(root, outDir)
  for (const [key, catalog] of catalogCache)
  {
    if (catalog.dir === dir)
    {
      catalogCache.delete(key)
    }
  }
}
