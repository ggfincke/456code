// apps/server/src/vcs/ExactGitSnapshot.ts
// captures and materializes bounded Git trees without content filters
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off

import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeFSP from 'node:fs/promises'
import * as NodePath from 'node:path'

export const EXACT_GIT_SNAPSHOT_MAX_FILE_COUNT = 25_000
export const EXACT_GIT_SNAPSHOT_MAX_BYTE_COUNT = 256 * 1024 * 1024

const GIT_TIMEOUT_MS = 30_000
const GIT_LISTING_MAX_BYTES = 64 * 1024 * 1024
const GIT_STDERR_MAX_BYTES = 64 * 1024
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u
const ALLOWED_INDEX_MODES = new Set(['100644', '100755', '120000', '160000'])
const REGULAR_MODES = new Set(['100644', '100755'])
const fatalUtf8Decoder = new TextDecoder('utf-8', { fatal: true })

export type ExactGitSnapshotErrorCode =
  | 'cancelled'
  | 'cleanup-failed'
  | 'dirty-submodule'
  | 'git-failed'
  | 'invalid-input'
  | 'limit-exceeded'
  | 'unsupported-entry'

export class ExactGitSnapshotError extends Error
{
  readonly code: ExactGitSnapshotErrorCode

  constructor(code: ExactGitSnapshotErrorCode, message: string, options?: ErrorOptions)
  {
    super(message, options)
    this.name = 'ExactGitSnapshotError'
    this.code = code
  }
}

export interface ExactGitSnapshotLimits
{
  readonly maxFileCount: number
  readonly maxByteCount: number
}

export interface CaptureExactGitSnapshotInput
{
  readonly repositoryRoot: string
  readonly indexPath: string
  readonly signal: AbortSignal
  readonly limits?: ExactGitSnapshotLimits
}

export interface ExactGitSnapshot
{
  readonly treeOid: string
  readonly headOid: string | null
  readonly fileCount: number
  readonly byteCount: number
}

export interface MaterializeExactGitTreeInput
{
  readonly repositoryRoot: string
  readonly treeOid: string
  readonly destinationRoot: string
  readonly signal: AbortSignal
  readonly limits?: ExactGitSnapshotLimits
}

export interface ExactGitTreeMaterialization
{
  readonly rootPath: string
  readonly fileCount: number
  readonly byteCount: number
}

export interface RestoreExactGitTreeInput
{
  readonly repositoryRoot: string
  readonly treeOid: string
  readonly signal: AbortSignal
  readonly limits?: ExactGitSnapshotLimits
}

export interface ExactGitTreeRestore
{
  readonly treeOid: string
  readonly fileCount: number
  readonly byteCount: number
}

interface GitResult
{
  readonly exitCode: number
  readonly stdout: Buffer
  readonly stderr: Buffer
}

interface GitOptions
{
  readonly allowNonZeroExit?: boolean
  readonly env?: NodeJS.ProcessEnv
  readonly stdin?: Buffer
  readonly maxStdoutBytes?: number
}

interface GitTreeEntry
{
  readonly mode: string
  readonly type: 'blob' | 'commit'
  readonly oid: string
  readonly path: string
}

interface IndexEntry
{
  readonly mode: string
  readonly oid: string
  readonly stage: number
  readonly path: string
}

interface SnapshotCandidate
{
  readonly path: string
  head?: GitTreeEntry
  index?: IndexEntry
  untracked: boolean
}

interface SnapshotEntry
{
  readonly path: string
  readonly mode: string
  readonly content?: Buffer
  readonly existingOid?: string
}

interface MaterializedTreeEntry
{
  readonly path: string
  readonly mode: string
  readonly type: 'blob' | 'commit'
  readonly oid: string
  readonly size: number
}

interface LoadedExactGitTree
{
  readonly entries: ReadonlyArray<MaterializedTreeEntry>
  readonly blobs: ReadonlyMap<string, Buffer>
  readonly fileCount: number
  readonly byteCount: number
}

function exactError(
  code: ExactGitSnapshotErrorCode,
  message: string,
  cause?: unknown,
): ExactGitSnapshotError
{
  return new ExactGitSnapshotError(code, message, cause === undefined ? undefined : { cause })
}

function throwIfCancelled(signal: AbortSignal): void
{
  if (signal.aborted)
  {
    throw exactError('cancelled', 'Exact Git snapshot operation was cancelled.')
  }
}

function gitEnvironment(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv
{
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_LITERAL_PATHSPECS: '1',
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    LANG: 'C',
    LC_ALL: 'C',
    ...overrides,
  }
  if (overrides?.GIT_INDEX_FILE === undefined)
  {
    delete environment.GIT_INDEX_FILE
  }
  return environment
}

function runGit(
  cwd: string,
  args: ReadonlyArray<string>,
  signal: AbortSignal,
  options: GitOptions = {},
): Promise<GitResult>
{
  throwIfCancelled(signal)
  const maxStdoutBytes = options.maxStdoutBytes ?? GIT_LISTING_MAX_BYTES

  return new Promise((resolve, reject) =>
  {
    let child: NodeChildProcess.ChildProcessWithoutNullStreams
    try
    {
      child = NodeChildProcess.spawn('git', ['-C', cwd, ...args], {
        env: gitEnvironment(options.env),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    }
    catch (cause)
    {
      reject(exactError('git-failed', `Could not start git ${args[0] ?? 'command'}.`, cause))
      return
    }

    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let terminalError: ExactGitSnapshotError | null = null
    let settled = false

    const stop = (error: ExactGitSnapshotError) =>
    {
      terminalError ??= error
      child.kill('SIGKILL')
    }
    const abort = () =>
    {
      stop(exactError('cancelled', 'Exact Git snapshot operation was cancelled.'))
    }
    const timeout = setTimeout(() =>
    {
      stop(exactError('git-failed', `git ${args[0] ?? 'command'} timed out.`))
    }, GIT_TIMEOUT_MS)

    signal.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk: Buffer) =>
    {
      stdoutBytes += chunk.byteLength
      if (stdoutBytes > maxStdoutBytes)
      {
        stop(exactError('git-failed', `git ${args[0] ?? 'command'} exceeded its bounded output.`))
        return
      }
      stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) =>
    {
      stderrBytes += chunk.byteLength
      if (stderrBytes > GIT_STDERR_MAX_BYTES)
      {
        stop(
          exactError(
            'git-failed',
            `git ${args[0] ?? 'command'} exceeded its bounded error output.`,
          ),
        )
        return
      }
      stderr.push(chunk)
    })
    child.on('error', (cause) =>
    {
      stop(exactError('git-failed', `Could not run git ${args[0] ?? 'command'}.`, cause))
    })
    child.stdin.on('error', (cause: NodeJS.ErrnoException) =>
    {
      if (cause.code !== 'EPIPE')
      {
        stop(exactError('git-failed', `Could not write to git ${args[0] ?? 'command'}.`, cause))
      }
    })
    child.on('close', (code) =>
    {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      if (terminalError !== null)
      {
        reject(terminalError)
        return
      }
      if (code === null)
      {
        reject(exactError('git-failed', `git ${args[0] ?? 'command'} returned no exit code.`))
        return
      }
      if (code !== 0 && options.allowNonZeroExit !== true)
      {
        const detail = Buffer.concat(stderr).toString('utf8').trim()
        reject(
          exactError(
            'git-failed',
            detail.length > 0
              ? `git ${args[0] ?? 'command'} failed: ${detail}`
              : `git ${args[0] ?? 'command'} failed with exit code ${String(code)}.`,
          ),
        )
        return
      }
      resolve({
        exitCode: code,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      })
    })

    if (signal.aborted) abort()
    child.stdin.end(options.stdin)
  })
}

function trimLineBreak(buffer: Buffer): string
{
  return buffer.toString('utf8').replace(/\r?\n$/u, '')
}

function nulRecords(buffer: Buffer, label: string): ReadonlyArray<Buffer>
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

function decodePath(bytes: Buffer): string
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

function validateGitPath(path: string): void
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

function parseHeadTree(buffer: Buffer): ReadonlyArray<GitTreeEntry>
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

function parseIndex(buffer: Buffer): ReadonlyArray<IndexEntry>
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

function validatedLimits(limits: ExactGitSnapshotLimits | undefined): ExactGitSnapshotLimits
{
  const selected = limits ?? {
    maxFileCount: EXACT_GIT_SNAPSHOT_MAX_FILE_COUNT,
    maxByteCount: EXACT_GIT_SNAPSHOT_MAX_BYTE_COUNT,
  }
  if (
    !Number.isSafeInteger(selected.maxFileCount) ||
    selected.maxFileCount < 0 ||
    selected.maxFileCount > EXACT_GIT_SNAPSHOT_MAX_FILE_COUNT ||
    !Number.isSafeInteger(selected.maxByteCount) ||
    selected.maxByteCount < 0 ||
    selected.maxByteCount > EXACT_GIT_SNAPSHOT_MAX_BYTE_COUNT
  )
  {
    throw exactError(
      'invalid-input',
      `Exact Git limits must be non-negative integers no larger than ${EXACT_GIT_SNAPSHOT_MAX_FILE_COUNT} files and ${EXACT_GIT_SNAPSHOT_MAX_BYTE_COUNT} bytes.`,
    )
  }
  return selected
}

function isWithin(parent: string, candidate: string): boolean
{
  const relative = NodePath.relative(parent, candidate)
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${NodePath.sep}`) &&
      !NodePath.isAbsolute(relative))
  )
}

async function canonicalDirectory(path: string, label: string): Promise<string>
{
  if (!NodePath.isAbsolute(path))
  {
    throw exactError('invalid-input', `${label} must be an absolute path.`)
  }
  let stat: NodeFS.Stats
  try
  {
    stat = await NodeFSP.lstat(path)
  }
  catch (cause)
  {
    throw exactError('invalid-input', `${label} must be an existing directory.`, cause)
  }
  if (stat.isSymbolicLink() || !stat.isDirectory())
  {
    throw exactError('invalid-input', `${label} must be a real directory, not a symlink.`)
  }
  return NodeFSP.realpath(path)
}

async function validateRepositoryRoot(requestedRoot: string, signal: AbortSignal): Promise<string>
{
  const repositoryRoot = await canonicalDirectory(requestedRoot, 'Repository root')
  const discovered = trimLineBreak(
    (
      await runGit(repositoryRoot, ['rev-parse', '--show-toplevel'], signal, {
        maxStdoutBytes: 16 * 1024,
      })
    ).stdout,
  )
  let canonicalDiscovered: string
  try
  {
    canonicalDiscovered = await NodeFSP.realpath(discovered)
  }
  catch (cause)
  {
    throw exactError('invalid-input', 'Git returned an invalid repository root.', cause)
  }
  if (canonicalDiscovered !== repositoryRoot)
  {
    throw exactError('invalid-input', 'Exact Git snapshots require the worktree root.')
  }
  return repositoryRoot
}

async function pathExists(path: string): Promise<boolean>
{
  return NodeFSP.lstat(path).then(
    () => true,
    (cause: NodeJS.ErrnoException) =>
    {
      if (cause.code === 'ENOENT') return false
      throw cause
    },
  )
}

async function claimIndexPath(indexPath: string): Promise<string>
{
  if (!NodePath.isAbsolute(indexPath))
  {
    throw exactError('invalid-input', 'Temporary index path must be absolute.')
  }
  const parent = await canonicalDirectory(NodePath.dirname(indexPath), 'Temporary index parent')
  const resolved = NodePath.join(parent, NodePath.basename(indexPath))
  if ((await pathExists(resolved)) || (await pathExists(`${resolved}.lock`)))
  {
    throw exactError('invalid-input', 'Temporary index path must not already exist.')
  }
  return resolved
}

async function cleanupIndex(indexPath: string): Promise<void>
{
  try
  {
    await NodeFSP.rm(indexPath, { force: true })
    await NodeFSP.rm(`${indexPath}.lock`, { force: true })
  }
  catch (cause)
  {
    throw exactError('cleanup-failed', 'Could not remove the temporary Git index.', cause)
  }
}

function addCandidate(candidates: Map<string, SnapshotCandidate>, path: string): SnapshotCandidate
{
  const existing = candidates.get(path)
  if (existing !== undefined) return existing
  const candidate: SnapshotCandidate = { path, untracked: false }
  candidates.set(path, candidate)
  return candidate
}

function assertNoDirtySubmodules(status: Buffer): void
{
  for (const record of nulRecords(status, 'repository status'))
  {
    const prefix = record.toString('utf8')
    const fields = prefix.split(' ')
    if (
      (fields[0] === '1' || fields[0] === '2' || fields[0] === 'u') &&
      fields[2]?.startsWith('S')
    )
    {
      throw exactError(
        'dirty-submodule',
        'Changed or dirty submodules are unsupported by exact snapshot policy.',
      )
    }
  }
}

async function readRegularFile(path: string, stat: NodeFS.Stats): Promise<Buffer>
{
  const noFollow = 'O_NOFOLLOW' in NodeFS.constants ? NodeFS.constants.O_NOFOLLOW : 0
  let handle: NodeFSP.FileHandle
  try
  {
    handle = await NodeFSP.open(path, NodeFS.constants.O_RDONLY | noFollow)
  }
  catch (cause)
  {
    throw exactError(
      'unsupported-entry',
      `Snapshot source '${path}' could not be opened without following links.`,
      cause,
    )
  }
  try
  {
    const before = await handle.stat()
    if (
      !before.isFile() ||
      before.dev !== stat.dev ||
      before.ino !== stat.ino ||
      before.size !== stat.size
    )
    {
      throw exactError('unsupported-entry', `Snapshot source '${path}' changed during capture.`)
    }
    const content = await handle.readFile()
    const after = await handle.stat()
    if (
      content.byteLength !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
    {
      throw exactError('unsupported-entry', `Snapshot source '${path}' changed during capture.`)
    }
    return content
  }
  finally
  {
    await handle.close()
  }
}

function assertWithinLimits(
  fileCount: number,
  byteCount: number,
  limits: ExactGitSnapshotLimits,
): void
{
  if (fileCount > limits.maxFileCount)
  {
    throw exactError(
      'limit-exceeded',
      `Exact Git tree exceeds the ${limits.maxFileCount}-file limit.`,
    )
  }
  if (!Number.isSafeInteger(byteCount) || byteCount > limits.maxByteCount)
  {
    throw exactError(
      'limit-exceeded',
      `Exact Git tree exceeds the ${limits.maxByteCount}-byte limit.`,
    )
  }
}

async function collectSnapshotEntries(
  repositoryRoot: string,
  headOid: string | null,
  signal: AbortSignal,
  limits: ExactGitSnapshotLimits,
): Promise<ReadonlyArray<SnapshotEntry>>
{
  const [headTreeResult, indexResult, untrackedResult] = await Promise.all([
    headOid === null
      ? Promise.resolve({
          exitCode: 0,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
        })
      : runGit(repositoryRoot, ['ls-tree', '-r', '-z', '--full-tree', headOid], signal),
    runGit(repositoryRoot, ['ls-files', '--stage', '-z'], signal),
    runGit(repositoryRoot, ['ls-files', '--others', '--exclude-standard', '-z'], signal),
  ])
  const headEntries = parseHeadTree(headTreeResult.stdout)
  const indexEntries = parseIndex(indexResult.stdout)
  const untrackedPaths = nulRecords(untrackedResult.stdout, 'untracked entries').map(decodePath)
  const candidates = new Map<string, SnapshotCandidate>()

  for (const entry of headEntries)
  {
    const candidate = addCandidate(candidates, entry.path)
    candidate.head = entry
  }
  for (const entry of indexEntries)
  {
    if (entry.stage !== 0)
    {
      throw exactError(
        'unsupported-entry',
        'Unmerged index entries are unsupported by exact snapshot policy.',
      )
    }
    const candidate = addCandidate(candidates, entry.path)
    candidate.index = entry
  }
  for (const path of untrackedPaths)
  {
    addCandidate(candidates, path).untracked = true
  }

  const hasSubmodules = [...candidates.values()].some(
    (candidate) => candidate.head?.mode === '160000' || candidate.index?.mode === '160000',
  )
  if (hasSubmodules)
  {
    const status = await runGit(
      repositoryRoot,
      ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=none'],
      signal,
    )
    assertNoDirtySubmodules(status.stdout)
  }

  const sortedCandidates = [...candidates.values()].sort((left, right) =>
    Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8')),
  )
  const candidateDirectories = new Set<string>()
  for (const candidate of sortedCandidates)
  {
    const segments = candidate.path.split('/')
    for (let index = 1; index < segments.length; index += 1)
    {
      candidateDirectories.add(segments.slice(0, index).join('/'))
    }
  }
  const entries: SnapshotEntry[] = []
  let byteCount = 0

  for (const candidate of sortedCandidates)
  {
    throwIfCancelled(signal)
    const absolutePath = NodePath.join(repositoryRoot, ...candidate.path.split('/'))
    let stat: NodeFS.Stats
    try
    {
      stat = await NodeFSP.lstat(absolutePath)
    }
    catch (cause)
    {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw exactError(
        'unsupported-entry',
        `Snapshot source '${candidate.path}' could not be inspected.`,
        cause,
      )
    }

    if (stat.isDirectory())
    {
      const gitlink =
        candidate.head?.mode === '160000' && candidate.head.type === 'commit'
          ? candidate.head
          : undefined
      if (gitlink !== undefined)
      {
        entries.push({
          path: candidate.path,
          mode: '160000',
          existingOid: gitlink.oid,
        })
      }
      else
      {
        if (candidate.untracked && !candidateDirectories.has(candidate.path))
        {
          throw exactError(
            'unsupported-entry',
            `Untracked directory '${candidate.path}' is not a regular file.`,
          )
        }
      }
    }
    else if (stat.isFile())
    {
      const nextByteCount = byteCount + stat.size
      assertWithinLimits(entries.length + 1, nextByteCount, limits)
      const content = await readRegularFile(absolutePath, stat)
      byteCount = nextByteCount
      entries.push({
        path: candidate.path,
        mode: stat.mode & 0o111 ? '100755' : '100644',
        content,
      })
    }
    else if (stat.isSymbolicLink())
    {
      let content: Buffer
      try
      {
        content = await NodeFSP.readlink(absolutePath, { encoding: 'buffer' })
      }
      catch (cause)
      {
        throw exactError(
          'unsupported-entry',
          `Symlink '${candidate.path}' changed during capture.`,
          cause,
        )
      }
      const nextByteCount = byteCount + content.byteLength
      assertWithinLimits(entries.length + 1, nextByteCount, limits)
      byteCount = nextByteCount
      entries.push({
        path: candidate.path,
        mode: '120000',
        content,
      })
    }
    else
    {
      throw exactError(
        'unsupported-entry',
        `Snapshot source '${candidate.path}' is a special filesystem entry.`,
      )
    }

    assertWithinLimits(entries.length, byteCount, limits)
  }

  return entries
}

function buildFastImportInput(entries: ReadonlyArray<SnapshotEntry>): {
  readonly input: Buffer
  readonly entriesWithContent: ReadonlyArray<SnapshotEntry>
}
{
  const entriesWithContent = entries.filter(
    (entry): entry is SnapshotEntry & { readonly content: Buffer } => entry.content !== undefined,
  )
  const parts: Buffer[] = []
  for (const [index, entry] of entriesWithContent.entries())
  {
    parts.push(
      Buffer.from(`blob\nmark :${index + 1}\ndata ${entry.content.byteLength}\n`, 'ascii'),
      entry.content,
      Buffer.from('\n', 'ascii'),
    )
  }
  for (const index of entriesWithContent.keys())
  {
    parts.push(Buffer.from(`get-mark :${index + 1}\n`, 'ascii'))
  }
  parts.push(Buffer.from('done\n', 'ascii'))
  return { input: Buffer.concat(parts), entriesWithContent }
}

async function writeSnapshotObjects(
  repositoryRoot: string,
  entries: ReadonlyArray<SnapshotEntry>,
  signal: AbortSignal,
): Promise<Map<SnapshotEntry, string>>
{
  const { input, entriesWithContent } = buildFastImportInput(entries)
  const objectIds = new Map<SnapshotEntry, string>()
  if (entriesWithContent.length === 0) return objectIds

  const result = await runGit(repositoryRoot, ['fast-import', '--quiet', '--done'], signal, {
    stdin: input,
    maxStdoutBytes: entriesWithContent.length * 65 + 1_024,
  })
  const lines = result.stdout.toString('ascii').trim().split('\n').filter(Boolean)
  if (lines.length !== entriesWithContent.length || lines.some((line) => !OBJECT_ID.test(line)))
  {
    throw exactError('git-failed', 'Git did not return every imported blob identity.')
  }
  for (const [index, entry] of entriesWithContent.entries())
  {
    objectIds.set(entry, lines[index]!)
  }
  return objectIds
}

function buildIndexInput(
  entries: ReadonlyArray<SnapshotEntry>,
  importedObjectIds: ReadonlyMap<SnapshotEntry, string>,
): Buffer
{
  return Buffer.concat(
    entries.map((entry) =>
    {
      const oid = entry.existingOid ?? importedObjectIds.get(entry)
      if (oid === undefined || !OBJECT_ID.test(oid))
      {
        throw exactError('git-failed', `Git object identity is missing for '${entry.path}'.`)
      }
      return Buffer.from(`${entry.mode} ${oid}\t${entry.path}\0`, 'utf8')
    }),
  )
}

async function captureWithClaimedIndex(
  repositoryRoot: string,
  indexPath: string,
  signal: AbortSignal,
  limits: ExactGitSnapshotLimits,
): Promise<ExactGitSnapshot>
{
  const headResult = await runGit(
    repositoryRoot,
    ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'],
    signal,
    {
      allowNonZeroExit: true,
      maxStdoutBytes: 256,
    },
  )
  const headOid = headResult.exitCode === 0 ? trimLineBreak(headResult.stdout) : null
  if (headOid !== null && !OBJECT_ID.test(headOid))
  {
    throw exactError('git-failed', 'Git did not return a valid HEAD commit identity.')
  }

  const entries = await collectSnapshotEntries(repositoryRoot, headOid, signal, limits)
  const byteCount = entries.reduce((total, entry) => total + (entry.content?.byteLength ?? 0), 0)
  assertWithinLimits(entries.length, byteCount, limits)
  throwIfCancelled(signal)

  const indexEnvironment: NodeJS.ProcessEnv = {
    GIT_INDEX_FILE: indexPath,
    GIT_LITERAL_PATHSPECS: '1',
  }
  await runGit(repositoryRoot, ['read-tree', '--empty'], signal, {
    env: indexEnvironment,
    maxStdoutBytes: 1_024,
  })
  const importedObjectIds = await writeSnapshotObjects(repositoryRoot, entries, signal)
  if (entries.length > 0)
  {
    await runGit(repositoryRoot, ['update-index', '-z', '--index-info'], signal, {
      env: indexEnvironment,
      stdin: buildIndexInput(entries, importedObjectIds),
      maxStdoutBytes: 1_024,
    })
  }
  const treeOid = trimLineBreak(
    (
      await runGit(repositoryRoot, ['write-tree'], signal, {
        env: indexEnvironment,
        maxStdoutBytes: 256,
      })
    ).stdout,
  )
  if (!OBJECT_ID.test(treeOid))
  {
    throw exactError('git-failed', 'Git did not return a valid captured tree identity.')
  }
  return {
    treeOid,
    headOid,
    fileCount: entries.length,
    byteCount,
  }
}

export async function captureExactGitSnapshot(
  input: CaptureExactGitSnapshotInput,
): Promise<ExactGitSnapshot>
{
  const limits = validatedLimits(input.limits)
  throwIfCancelled(input.signal)
  const repositoryRoot = await validateRepositoryRoot(input.repositoryRoot, input.signal)
  const indexPath = await claimIndexPath(input.indexPath)

  let result: ExactGitSnapshot | null = null
  let operationFailure: unknown = null
  try
  {
    result = await captureWithClaimedIndex(repositoryRoot, indexPath, input.signal, limits)
  }
  catch (cause)
  {
    operationFailure =
      cause instanceof ExactGitSnapshotError
        ? cause
        : input.signal.aborted
          ? exactError('cancelled', 'Exact Git snapshot operation was cancelled.', cause)
          : exactError('git-failed', 'Exact Git snapshot capture failed.', cause)
  }

  let cleanupFailure: unknown = null
  try
  {
    await cleanupIndex(indexPath)
  }
  catch (cause)
  {
    cleanupFailure = cause
  }
  if (cleanupFailure !== null)
  {
    throw operationFailure === null
      ? cleanupFailure
      : exactError(
          'cleanup-failed',
          'Exact Git snapshot failed and its temporary index could not be removed.',
          cleanupFailure,
        )
  }
  if (operationFailure !== null) throw operationFailure
  if (result === null)
  {
    throw exactError('git-failed', 'Exact Git snapshot capture returned no result.')
  }
  return result
}

function parseMaterializedTree(buffer: Buffer): ReadonlyArray<MaterializedTreeEntry>
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

function validateMaterializedEntries(
  entries: ReadonlyArray<MaterializedTreeEntry>,
  limits: ExactGitSnapshotLimits,
): { readonly fileCount: number; readonly byteCount: number }
{
  const paths = new Set<string>()
  const leaves = new Set<string>()
  let byteCount = 0
  for (const entry of entries)
  {
    if (paths.has(entry.path))
    {
      throw exactError('unsupported-entry', `Git tree repeats path '${entry.path}'.`)
    }
    paths.add(entry.path)
    if (entry.type === 'blob') leaves.add(entry.path)
    byteCount += entry.size
    assertWithinLimits(paths.size, byteCount, limits)
  }
  for (const path of paths)
  {
    const segments = path.split('/')
    for (let index = 1; index < segments.length; index += 1)
    {
      const parent = segments.slice(0, index).join('/')
      if (leaves.has(parent))
      {
        throw exactError(
          'unsupported-entry',
          `Git tree places '${path}' below non-directory '${parent}'.`,
        )
      }
    }
  }
  return { fileCount: paths.size, byteCount }
}

async function readTreeBlobs(
  repositoryRoot: string,
  entries: ReadonlyArray<MaterializedTreeEntry>,
  byteCount: number,
  signal: AbortSignal,
): Promise<ReadonlyMap<string, Buffer>>
{
  const uniqueObjectIds = [
    ...new Set(entries.filter((entry) => entry.type === 'blob').map((entry) => entry.oid)),
  ]
  if (uniqueObjectIds.length === 0) return new Map()
  const input = Buffer.from(`${uniqueObjectIds.join('\n')}\n`, 'ascii')
  const result = await runGit(repositoryRoot, ['cat-file', '--batch'], signal, {
    stdin: input,
    maxStdoutBytes: byteCount + uniqueObjectIds.length * 128 + 1_024,
  })
  const blobs = new Map<string, Buffer>()
  let offset = 0

  for (const requestedOid of uniqueObjectIds)
  {
    const headerEnd = result.stdout.indexOf(0x0a, offset)
    if (headerEnd < 0)
    {
      throw exactError('git-failed', 'Git returned a malformed batch object header.')
    }
    const header = result.stdout.subarray(offset, headerEnd).toString('ascii')
    const match = /^([0-9a-f]{40}(?:[0-9a-f]{24})?) blob ([0-9]+)$/u.exec(header)
    if (!match?.[1] || !match[2] || match[1] !== requestedOid)
    {
      throw exactError('git-failed', 'Git returned an unexpected batch object.')
    }
    const size = Number(match[2])
    const contentStart = headerEnd + 1
    const contentEnd = contentStart + size
    if (
      !Number.isSafeInteger(size) ||
      contentEnd >= result.stdout.byteLength ||
      result.stdout[contentEnd] !== 0x0a
    )
    {
      throw exactError('git-failed', 'Git returned malformed batch object content.')
    }
    blobs.set(requestedOid, Buffer.from(result.stdout.subarray(contentStart, contentEnd)))
    offset = contentEnd + 1
  }
  if (offset !== result.stdout.byteLength)
  {
    throw exactError('git-failed', 'Git returned trailing batch object data.')
  }
  return blobs
}

async function loadExactGitTree(
  repositoryRoot: string,
  treeOid: string,
  signal: AbortSignal,
  limits: ExactGitSnapshotLimits,
): Promise<LoadedExactGitTree>
{
  const objectType = trimLineBreak(
    (
      await runGit(repositoryRoot, ['cat-file', '-t', treeOid], signal, {
        maxStdoutBytes: 64,
      })
    ).stdout,
  )
  if (objectType !== 'tree')
  {
    throw exactError('invalid-input', 'Exact Git operation requires a Git tree object ID.')
  }
  const listing = await runGit(
    repositoryRoot,
    ['ls-tree', '-r', '-l', '-z', '--full-tree', treeOid],
    signal,
  )
  const entries = parseMaterializedTree(listing.stdout)
  const bounds = validateMaterializedEntries(entries, limits)
  throwIfCancelled(signal)
  const blobs = await readTreeBlobs(repositoryRoot, entries, bounds.byteCount, signal)
  return {
    entries,
    blobs,
    fileCount: bounds.fileCount,
    byteCount: bounds.byteCount,
  }
}

async function validateDestination(
  repositoryRoot: string,
  destinationRoot: string,
): Promise<string>
{
  const destination = await canonicalDirectory(destinationRoot, 'Materialization destination')
  if (isWithin(repositoryRoot, destination))
  {
    throw exactError(
      'invalid-input',
      'Materialization destination must be outside the repository worktree.',
    )
  }
  const contents = await NodeFSP.readdir(destination)
  if (contents.length > 0)
  {
    throw exactError('invalid-input', 'Materialization destination must be empty.')
  }
  return destination
}

function destinationPath(root: string, relativePath: string): string
{
  const resolved = NodePath.resolve(root, ...relativePath.split('/'))
  if (!isWithin(root, resolved) || resolved === root)
  {
    throw exactError('unsupported-entry', `Git path '${relativePath}' escapes its destination.`)
  }
  return resolved
}

async function writeExclusiveFile(
  path: string,
  content: Buffer,
  executable: boolean,
): Promise<void>
{
  const noFollow = 'O_NOFOLLOW' in NodeFS.constants ? NodeFS.constants.O_NOFOLLOW : 0
  const mode = executable ? 0o755 : 0o644
  let handle: NodeFSP.FileHandle
  try
  {
    handle = await NodeFSP.open(
      path,
      NodeFS.constants.O_WRONLY | NodeFS.constants.O_CREAT | NodeFS.constants.O_EXCL | noFollow,
      mode,
    )
  }
  catch (cause)
  {
    throw exactError('invalid-input', `Could not create materialized file '${path}'.`, cause)
  }
  try
  {
    await handle.writeFile(content)
    await handle.chmod(mode)
  }
  finally
  {
    await handle.close()
  }
}

async function writeMaterializedTree(
  destinationRoot: string,
  entries: ReadonlyArray<MaterializedTreeEntry>,
  blobs: ReadonlyMap<string, Buffer>,
  signal: AbortSignal,
  allowExistingDirectories = false,
): Promise<void>
{
  const directories = new Set<string>()
  for (const entry of entries)
  {
    const segments = entry.path.split('/')
    for (let index = 1; index < segments.length; index += 1)
    {
      directories.add(segments.slice(0, index).join('/'))
    }
    if (entry.type === 'commit') directories.add(entry.path)
  }
  const sortedDirectories = [...directories].sort((left, right) =>
  {
    const depth = left.split('/').length - right.split('/').length
    return depth !== 0
      ? depth
      : Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
  })
  for (const directory of sortedDirectories)
  {
    throwIfCancelled(signal)
    const path = destinationPath(destinationRoot, directory)
    try
    {
      await NodeFSP.mkdir(path, { mode: 0o755 })
    }
    catch (cause)
    {
      if (allowExistingDirectories && (cause as NodeJS.ErrnoException).code === 'EEXIST')
      {
        const stat = await NodeFSP.lstat(path)
        if (stat.isDirectory() && !stat.isSymbolicLink()) continue
      }
      throw exactError(
        'invalid-input',
        `Could not create materialized directory '${directory}'.`,
        cause,
      )
    }
  }

  for (const entry of entries)
  {
    if (entry.type === 'commit') continue
    throwIfCancelled(signal)
    const content = blobs.get(entry.oid)
    if (content === undefined || content.byteLength !== entry.size)
    {
      throw exactError('git-failed', `Git blob content is missing for '${entry.path}'.`)
    }
    const path = destinationPath(destinationRoot, entry.path)
    if (entry.mode === '120000')
    {
      if (content.byteLength === 0 || content.includes(0))
      {
        throw exactError('unsupported-entry', `Git symlink '${entry.path}' has an invalid target.`)
      }
      try
      {
        await NodeFSP.symlink(content, path)
      }
      catch (cause)
      {
        throw exactError(
          'invalid-input',
          `Could not create materialized symlink '${entry.path}'.`,
          cause,
        )
      }
    }
    else
    {
      await writeExclusiveFile(path, content, entry.mode === '100755')
    }
  }
}

function pathParents(path: string): ReadonlyArray<string>
{
  const segments = path.split('/')
  const parents: string[] = []
  for (let index = 1; index < segments.length; index += 1)
  {
    parents.push(segments.slice(0, index).join('/'))
  }
  return parents
}

function assertIgnoredPathsDoNotObstruct(
  ignoredPaths: ReadonlyArray<string>,
  targetEntries: ReadonlyArray<MaterializedTreeEntry>,
): void
{
  const targetLeaves = new Set(
    targetEntries.filter((entry) => entry.type === 'blob').map((entry) => entry.path),
  )
  const targetDirectories = new Set<string>()
  for (const entry of targetEntries)
  {
    for (const parent of pathParents(entry.path)) targetDirectories.add(parent)
    if (entry.type === 'commit') targetDirectories.add(entry.path)
  }

  for (const ignoredPath of ignoredPaths)
  {
    if (
      targetDirectories.has(ignoredPath) ||
      [ignoredPath, ...pathParents(ignoredPath)].some((path) => targetLeaves.has(path))
    )
    {
      throw exactError(
        'unsupported-entry',
        `Ignored path '${ignoredPath}' obstructs exact worktree restore.`,
      )
    }
  }
}

interface RestoreInventory
{
  readonly removableLeaves: ReadonlyArray<string>
  readonly pruneDirectories: ReadonlyArray<string>
}

async function collectRestoreInventory(
  repositoryRoot: string,
  targetEntries: ReadonlyArray<MaterializedTreeEntry>,
  signal: AbortSignal,
): Promise<RestoreInventory>
{
  const [indexResult, untrackedResult, ignoredResult] = await Promise.all([
    runGit(repositoryRoot, ['ls-files', '--stage', '-z'], signal),
    runGit(repositoryRoot, ['ls-files', '--others', '--exclude-standard', '-z'], signal),
    runGit(
      repositoryRoot,
      ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'],
      signal,
    ),
  ])
  const indexEntries = parseIndex(indexResult.stdout)
  if (indexEntries.some((entry) => entry.stage !== 0))
  {
    throw exactError(
      'unsupported-entry',
      'Unmerged index entries are unsupported by exact restore policy.',
    )
  }
  const untrackedPaths = nulRecords(untrackedResult.stdout, 'untracked restore entries').map(
    decodePath,
  )
  const ignoredPaths = nulRecords(ignoredResult.stdout, 'ignored restore entries').map(decodePath)
  assertIgnoredPathsDoNotObstruct(ignoredPaths, targetEntries)

  const indexGitlinks = indexEntries.filter((entry) => entry.mode === '160000')
  if (indexGitlinks.length > 0)
  {
    const status = await runGit(
      repositoryRoot,
      ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=none'],
      signal,
    )
    assertNoDirtySubmodules(status.stdout)
    const targetByPath = new Map(targetEntries.map((entry) => [entry.path, entry]))
    for (const gitlink of indexGitlinks)
    {
      const target = targetByPath.get(gitlink.path)
      if (target?.type !== 'commit' || target.mode !== '160000' || target.oid !== gitlink.oid)
      {
        throw exactError(
          'unsupported-entry',
          `Gitlink '${gitlink.path}' cannot be changed by exact worktree restore.`,
        )
      }
    }
  }

  const indexByPath = new Map(indexEntries.map((entry) => [entry.path, entry]))
  const currentPaths = new Set([...indexEntries.map((entry) => entry.path), ...untrackedPaths])
  const removableLeaves = new Set<string>()
  const pruneDirectories = new Set<string>()

  for (const path of currentPaths)
  {
    throwIfCancelled(signal)
    const absolutePath = destinationPath(repositoryRoot, path)
    let stat: NodeFS.Stats
    try
    {
      stat = await NodeFSP.lstat(absolutePath)
    }
    catch (cause)
    {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw exactError(
        'unsupported-entry',
        `Current worktree path '${path}' could not be inspected.`,
        cause,
      )
    }
    if (stat.isDirectory() && indexByPath.get(path)?.mode === '160000')
    {
      continue
    }
    if (stat.isFile() || stat.isSymbolicLink())
    {
      removableLeaves.add(path)
      for (const parent of pathParents(path)) pruneDirectories.add(parent)
      continue
    }
    if (stat.isDirectory())
    {
      pruneDirectories.add(path)
      for (const parent of pathParents(path)) pruneDirectories.add(parent)
      continue
    }
    throw exactError(
      'unsupported-entry',
      `Current worktree path '${path}' is a special filesystem entry.`,
    )
  }

  for (const entry of targetEntries)
  {
    if (entry.type !== 'blob') continue
    const absolutePath = destinationPath(repositoryRoot, entry.path)
    let stat: NodeFS.Stats
    try
    {
      stat = await NodeFSP.lstat(absolutePath)
    }
    catch (cause)
    {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw exactError(
        'unsupported-entry',
        `Restore target '${entry.path}' could not be inspected.`,
        cause,
      )
    }
    if (stat.isDirectory())
    {
      pruneDirectories.add(entry.path)
    }
    else if ((stat.isFile() || stat.isSymbolicLink()) && !removableLeaves.has(entry.path))
    {
      throw exactError(
        'unsupported-entry',
        `Existing path '${entry.path}' obstructs exact worktree restore.`,
      )
    }
    else if (!stat.isFile() && !stat.isSymbolicLink())
    {
      throw exactError(
        'unsupported-entry',
        `Restore target '${entry.path}' is a special filesystem entry.`,
      )
    }
  }

  return {
    removableLeaves: [...removableLeaves].sort((left, right) =>
      Buffer.compare(Buffer.from(right, 'utf8'), Buffer.from(left, 'utf8')),
    ),
    pruneDirectories: [...pruneDirectories].sort((left, right) =>
    {
      const depth = right.split('/').length - left.split('/').length
      return depth !== 0
        ? depth
        : Buffer.compare(Buffer.from(right, 'utf8'), Buffer.from(left, 'utf8'))
    }),
  }
}

async function clearRestoreInventory(
  repositoryRoot: string,
  inventory: RestoreInventory,
  signal: AbortSignal,
): Promise<void>
{
  for (const path of inventory.removableLeaves)
  {
    throwIfCancelled(signal)
    const absolutePath = destinationPath(repositoryRoot, path)
    let stat: NodeFS.Stats
    try
    {
      stat = await NodeFSP.lstat(absolutePath)
    }
    catch (cause)
    {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw exactError(
        'unsupported-entry',
        `Current worktree path '${path}' changed before restore.`,
        cause,
      )
    }
    if (!stat.isFile() && !stat.isSymbolicLink())
    {
      throw exactError(
        'unsupported-entry',
        `Current worktree path '${path}' changed before restore.`,
      )
    }
    await NodeFSP.unlink(absolutePath)
  }

  for (const directory of inventory.pruneDirectories)
  {
    throwIfCancelled(signal)
    try
    {
      await NodeFSP.rmdir(destinationPath(repositoryRoot, directory))
    }
    catch (cause)
    {
      const code = (cause as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST')
      {
        throw exactError(
          'unsupported-entry',
          `Current worktree directory '${directory}' could not be pruned.`,
          cause,
        )
      }
    }
  }
}

export async function restoreExactGitTree(
  input: RestoreExactGitTreeInput,
): Promise<ExactGitTreeRestore>
{
  const limits = validatedLimits(input.limits)
  throwIfCancelled(input.signal)
  if (!OBJECT_ID.test(input.treeOid))
  {
    throw exactError('invalid-input', 'Restore requires a full Git tree object ID.')
  }
  const repositoryRoot = await validateRepositoryRoot(input.repositoryRoot, input.signal)

  try
  {
    const loaded = await loadExactGitTree(repositoryRoot, input.treeOid, input.signal, limits)
    const inventory = await collectRestoreInventory(repositoryRoot, loaded.entries, input.signal)
    throwIfCancelled(input.signal)
    await clearRestoreInventory(repositoryRoot, inventory, input.signal)
    await writeMaterializedTree(repositoryRoot, loaded.entries, loaded.blobs, input.signal, true)
    return {
      treeOid: input.treeOid,
      fileCount: loaded.fileCount,
      byteCount: loaded.byteCount,
    }
  }
  catch (cause)
  {
    if (cause instanceof ExactGitSnapshotError) throw cause
    if (input.signal.aborted)
    {
      throw exactError('cancelled', 'Exact Git snapshot operation was cancelled.', cause)
    }
    throw exactError('git-failed', 'Exact Git worktree restore failed.', cause)
  }
}

export async function materializeExactGitTree(
  input: MaterializeExactGitTreeInput,
): Promise<ExactGitTreeMaterialization>
{
  const limits = validatedLimits(input.limits)
  throwIfCancelled(input.signal)
  if (!OBJECT_ID.test(input.treeOid))
  {
    throw exactError('invalid-input', 'Materialization requires a full Git tree object ID.')
  }
  const repositoryRoot = await validateRepositoryRoot(input.repositoryRoot, input.signal)
  const destinationRoot = await validateDestination(repositoryRoot, input.destinationRoot)

  try
  {
    const loaded = await loadExactGitTree(repositoryRoot, input.treeOid, input.signal, limits)
    throwIfCancelled(input.signal)
    await writeMaterializedTree(destinationRoot, loaded.entries, loaded.blobs, input.signal)
    return {
      rootPath: destinationRoot,
      fileCount: loaded.fileCount,
      byteCount: loaded.byteCount,
    }
  }
  catch (cause)
  {
    if (cause instanceof ExactGitSnapshotError) throw cause
    if (input.signal.aborted)
    {
      throw exactError('cancelled', 'Exact Git snapshot operation was cancelled.', cause)
    }
    throw exactError('git-failed', 'Exact Git tree materialization failed.', cause)
  }
}
