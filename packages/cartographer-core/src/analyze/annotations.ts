// packages/cartographer-core/src/analyze/annotations.ts
// llm-written description sidecar, content-hash keyed for staleness

import * as NodeCrypto from 'node:crypto'
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'

const ANNOTATIONS_FILE = '.cartographer.annotations.json'
// documented sidecar contract: one line, at most this many characters
const DESCRIPTION_MAX_LENGTH = 160

export interface AnnotationEntry
{
  description: string
  // contentHash() of the file at annotation time
  hash: string
}

export interface ApplyAnnotationsResult
{
  annotationsPath: string
  written: number
  missing: string[]
  // keys/descriptions violating the containment or one-line/160-char contract
  invalid: string[]
}

interface RepositoryIdentity
{
  path: string
  device: number
  inode: number
}

function annotationsPath(root: string): string
{
  return NodePath.join(root, ANNOTATIONS_FILE)
}

function repositoryIdentity(root: string): RepositoryIdentity
{
  const path = NodeFS.realpathSync(NodePath.resolve(root))
  const stat = NodeFS.lstatSync(path)
  if (!stat.isDirectory())
  {
    throw new Error(`annotation root is not a directory: ${path}`)
  }
  return { path, device: stat.dev, inode: stat.ino }
}

// a replacement at the same path is a different repository for this apply
function assertRepositoryIdentity(identity: RepositoryIdentity): void
{
  let stat
  try
  {
    stat = NodeFS.lstatSync(identity.path)
  }
  catch
  {
    throw new Error(`repository root changed during annotation apply: ${identity.path}`)
  }
  if (!stat.isDirectory() || stat.dev !== identity.device || stat.ino !== identity.inode)
  {
    throw new Error(`repository root changed during annotation apply: ${identity.path}`)
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown>
{
  if (typeof value !== 'object' || value === null || Array.isArray(value))
  {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function entryPath(file: string): string
{
  return `files[${JSON.stringify(file)}]`
}

function invalidAnnotation(path: string, message: string): never
{
  throw new Error(`invalid ${ANNOTATIONS_FILE}: ${path} ${message}`)
}

function fileKeyIssue(file: string): string | undefined
{
  if (
    file === '' ||
    NodePath.isAbsolute(file) ||
    /^[A-Za-z]:[\\/]/.test(file) ||
    file.startsWith('\\\\') ||
    file.includes('\\')
  )
  {
    return 'must be a repo-relative POSIX path'
  }
  if (file.split('/').some((segment) => segment === '' || segment === '.' || segment === '..'))
  {
    return 'must not contain empty, ".", or ".." segments'
  }
  for (let index = 0; index < file.length; index += 1)
  {
    if (file.charCodeAt(index) < 0x20)
    {
      return 'must not contain control characters'
    }
  }
  return undefined
}

function ownDataValue(object: Record<string, unknown>, field: string, path: string): unknown
{
  const descriptor = Object.getOwnPropertyDescriptor(object, field)
  if (!descriptor || !('value' in descriptor))
  {
    return invalidAnnotation(`${path}.${field}`, 'must be an own data property')
  }
  return descriptor.value
}

function descriptionIssue(value: unknown, requireTrimmed: boolean): string | undefined
{
  if (typeof value !== 'string')
  {
    return 'must be a string'
  }
  const trimmed = value.trim()
  if (trimmed === '')
  {
    return 'must not be blank'
  }
  if (/[\r\n\u2028\u2029]/.test(value))
  {
    return 'must be a single line'
  }
  if (trimmed.length > DESCRIPTION_MAX_LENGTH)
  {
    return `must be at most ${DESCRIPTION_MAX_LENGTH} characters`
  }
  if (requireTrimmed && value !== trimmed)
  {
    return 'must not have leading or trailing whitespace'
  }
  return undefined
}

function validateAnnotationEntry(value: unknown, path: string): AnnotationEntry
{
  if (!isPlainObject(value))
  {
    return invalidAnnotation(path, 'must be an object')
  }
  const description = ownDataValue(value, 'description', path)
  const descriptionProblem = descriptionIssue(description, true)
  if (descriptionProblem)
  {
    return invalidAnnotation(`${path}.description`, descriptionProblem)
  }
  const hash = ownDataValue(value, 'hash', path)
  if (typeof hash !== 'string' || !/^[0-9a-f]{12}$/.test(hash))
  {
    return invalidAnnotation(`${path}.hash`, 'must be exactly 12 lowercase hexadecimal characters')
  }
  return { description: description as string, hash }
}

export function contentHash(text: string): string
{
  return NodeCrypto.createHash('sha1').update(text).digest('hex').slice(0, 12)
}

export function hashFile(root: string, file: string): string
{
  return contentHash(NodeFS.readFileSync(NodePath.resolve(root, file), 'utf-8'))
}

export function loadAnnotations(root: string): Map<string, AnnotationEntry>
{
  const path = annotationsPath(root)
  if (!NodeFS.existsSync(path))
  {
    return new Map()
  }
  let parsed: unknown
  try
  {
    parsed = JSON.parse(NodeFS.readFileSync(path, 'utf-8'))
  }
  catch (err)
  {
    throw new Error(`invalid ${ANNOTATIONS_FILE}: ${err instanceof Error ? err.message : err}`, {
      cause: err,
    })
  }
  if (!isPlainObject(parsed))
  {
    return invalidAnnotation('$', 'must be an object')
  }
  if (parsed.files !== undefined && !isPlainObject(parsed.files))
  {
    return invalidAnnotation('files', 'must be an object when present')
  }
  const files = parsed.files ?? {}
  const table = new Map<string, AnnotationEntry>()
  for (const [file, entry] of Object.entries(files))
  {
    const keyProblem = fileKeyIssue(file)
    if (keyProblem)
    {
      invalidAnnotation(entryPath(file), keyProblem)
    }
    table.set(file, validateAnnotationEntry(entry, entryPath(file)))
  }
  return table
}

// resolve a supplied key to a regular file beneath the canonical root;
// undefined -> escaping/absolute/non-regular targets never get read or hashed
function containedRegularFile(canonicalRoot: string, file: string): string | undefined
{
  if (file.includes('\u0000') || NodePath.isAbsolute(file))
  {
    return undefined
  }
  const abs = NodePath.resolve(canonicalRoot, file)
  if (abs !== canonicalRoot && !abs.startsWith(canonicalRoot + NodePath.sep))
  {
    return undefined
  }
  let stat
  try
  {
    // lstat -> a symlink key is rejected instead of followed
    stat = NodeFS.lstatSync(abs)
  }
  catch
  {
    return undefined
  }
  if (!stat.isFile())
  {
    return undefined
  }
  // realpath -> a symlinked parent dir (e.g. src -> /outside) can't escape
  let real
  try
  {
    real = NodeFS.realpathSync(abs)
  }
  catch
  {
    return undefined
  }
  if (real !== canonicalRoot && !real.startsWith(canonicalRoot + NodePath.sep))
  {
    return undefined
  }
  return real
}

export function applyAnnotations(
  root: string,
  supplied: Record<string, unknown>,
): ApplyAnnotationsResult
{
  if (!isPlainObject(supplied))
  {
    throw new Error('invalid annotations input: $ must be an object')
  }
  // one apply operation stays bound to the repository identity it opened
  const identity = repositoryIdentity(root)
  const canonicalRoot = identity.path
  const table = loadAnnotations(canonicalRoot)
  assertRepositoryIdentity(identity)
  let written = 0
  const missing: string[] = []
  const invalid: string[] = []
  for (const [file, description] of Object.entries(supplied))
  {
    assertRepositoryIdentity(identity)
    if (fileKeyIssue(file) || descriptionIssue(description, false))
    {
      invalid.push(file)
      continue
    }
    const path = containedRegularFile(canonicalRoot, file)
    if (!path)
    {
      // distinguish a plain missing repo file from a contract violation
      const abs = NodePath.resolve(canonicalRoot, file)
      const contained =
        !NodePath.isAbsolute(file) &&
        !file.includes('\u0000') &&
        (abs === canonicalRoot || abs.startsWith(canonicalRoot + NodePath.sep))
      if (contained && !NodeFS.existsSync(abs))
      {
        missing.push(file)
      }
      else
      {
        invalid.push(file)
      }
      continue
    }
    assertRepositoryIdentity(identity)
    const text = NodeFS.readFileSync(path, 'utf-8')
    assertRepositoryIdentity(identity)
    const entry = validateAnnotationEntry(
      {
        description: (description as string).trim(),
        hash: contentHash(text),
      },
      entryPath(file),
    )
    table.set(file, {
      description: entry.description,
      hash: entry.hash,
    })
    written += 1
  }
  assertRepositoryIdentity(identity)
  const resultPath = saveAnnotations(canonicalRoot, table)
  assertRepositoryIdentity(identity)
  return {
    annotationsPath: resultPath,
    written,
    missing,
    invalid,
  }
}

export function saveAnnotations(root: string, table: Map<string, AnnotationEntry>): string
{
  const entries = [...table.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([file, entry]) =>
    {
      const keyProblem = fileKeyIssue(file)
      if (keyProblem)
      {
        invalidAnnotation(entryPath(file), keyProblem)
      }
      return [file, validateAnnotationEntry(entry, entryPath(file))] as const
    })
  const files = Object.create(null) as Record<string, AnnotationEntry>
  for (const [file, entry] of entries)
  {
    files[file] = entry
  }
  const path = annotationsPath(root)
  writeFileNoFollowLocal(path, `${JSON.stringify({ files }, null, 2)}\n`)
  return path
}

// no-follow write -> a repo-committed sidecar symlink can't redirect the save
function writeFileNoFollowLocal(path: string, data: string): void
{
  let stat
  try
  {
    stat = NodeFS.lstatSync(path)
  }
  catch
  {
    stat = undefined
  }
  if (stat?.isSymbolicLink())
  {
    throw new Error(
      `refusing to write ${ANNOTATIONS_FILE}: ${path} is a symlink -> remove it first`,
    )
  }
  const noFollow = 'O_NOFOLLOW' in NodeFS.constants ? NodeFS.constants.O_NOFOLLOW : 0
  const flags =
    NodeFS.constants.O_WRONLY | NodeFS.constants.O_CREAT | NodeFS.constants.O_TRUNC | noFollow
  const fd = NodeFS.openSync(path, flags, 0o644)
  try
  {
    NodeFS.writeSync(fd, data)
  }
  finally
  {
    NodeFS.closeSync(fd)
  }
}
