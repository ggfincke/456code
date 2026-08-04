// apps/server/src/proposal/ProposalGitEngine.ts
// captures exact Git snapshots and builds retained proposed trees in isolation

// @effect-diagnostics nodeBuiltinImport:off globalTimers:off preferSchemaOverJson:off

import * as NodeChildProcess from 'node:child_process'
import * as NodeCrypto from 'node:crypto'
import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'

import {
  PROPOSAL_MAX_DIFF_OUTPUT_BYTES,
  PROPOSAL_MAX_FILE_BYTES,
  PROPOSAL_MAX_OPERATIONS,
  PROPOSAL_MAX_TOTAL_CONTENT_BYTES,
  PROPOSAL_MAX_UNIFIED_DIFF_BYTES,
  ProposalError,
  type ProposalBlobReference,
  type ProposalChangeInput,
  type ProposalId,
  type ProposalNormalizedOperation,
  type ProposalRepositoryIdentity,
  type ProposalRevisionId,
  type ProposalRevisionManifest,
  type ProposalSha256,
  type ProposalWorktreeIdentity,
} from '@t3tools/contracts'
import { normalizeGitRemoteUrl } from '@t3tools/shared/git'
import * as Context from 'effect/Context'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'

import {
  captureExactGitSnapshot,
  EXACT_GIT_SNAPSHOT_MAX_BYTE_COUNT,
  EXACT_GIT_SNAPSHOT_MAX_FILE_COUNT,
  ExactGitSnapshotError,
} from '../vcs/ExactGitSnapshot.ts'
import * as ProposalRetainedRefAttemptStore from './ProposalRetainedRefAttemptStore.ts'

const GIT_TIMEOUT_MS = 30_000
const GIT_DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const GIT_MAX_STDERR_BYTES = 1024 * 1024
const REGULAR_FILE_MODES = new Set(['100644', '100755'])
const PROPOSAL_RETAINED_REF_PREFIX = 'refs/t3/proposals'
const PROPOSAL_BASE_RETAINED_REF = /^refs\/t3\/proposals\/([0-9a-f]{64})\/base$/u
const PROPOSAL_PROPOSED_RETAINED_REF = /^refs\/t3\/proposals\/([0-9a-f]{64})\/proposed$/u

interface GitResult
{
  readonly exitCode: number
  readonly stdout: Buffer
  readonly stderr: Buffer
}

interface GitInput
{
  readonly cwd: string
  readonly args: ReadonlyArray<string>
  readonly env?: NodeJS.ProcessEnv
  readonly stdin?: Buffer | string
  readonly allowNonZeroExit?: boolean
  readonly maxOutputBytes?: number
}

interface TreeEntry
{
  readonly path: string
  readonly mode: string
  readonly oid: string
}

export interface ProposalContentBlob
{
  readonly sha256: ProposalSha256
  readonly content: Uint8Array
}

export interface PreparedProposalRevision
{
  readonly repository: ProposalRepositoryIdentity
  readonly worktree: ProposalWorktreeIdentity
  readonly headCommitOid: string
  readonly baseTreeOid: string
  readonly baseRetainedRef: string
  readonly baseFileCount: number
  readonly baseByteCount: number
  readonly proposedTreeOid: string
  readonly proposedRetainedRef: string
  readonly manifest: ProposalRevisionManifest
  readonly manifestJson: string
  readonly manifestSha256: ProposalSha256
  readonly diff: string
  readonly diffSha256: ProposalSha256
  readonly blobs: ReadonlyArray<ProposalContentBlob>
}

export interface PrepareProposalRevisionInput
{
  readonly cwd: string
  readonly proposalId: ProposalId
  readonly revisionId: ProposalRevisionId
  readonly changes: ProposalChangeInput
}

function proposalError(
  operation: string,
  code: ConstructorParameters<typeof ProposalError>[0]['code'],
  detail: string,
  fields: {
    readonly proposalId?: ProposalId
    readonly path?: string
  } = {},
): ProposalError
{
  return new ProposalError({
    operation,
    code,
    detail,
    ...(fields.proposalId === undefined ? {} : { proposalId: fields.proposalId }),
    ...(fields.path === undefined ? {} : { path: fields.path as never }),
  })
}

function runGitProcess(input: GitInput, signal: AbortSignal): Promise<GitResult>
{
  return new Promise((resolve, reject) =>
  {
    const child = NodeChildProcess.spawn('git', ['-C', input.cwd, ...input.args], {
      env: { ...process.env, ...input.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    let timeout: NodeJS.Timeout | undefined
    const maxOutputBytes = input.maxOutputBytes ?? GIT_DEFAULT_MAX_OUTPUT_BYTES

    const finish = (action: () => void) =>
    {
      if (settled) return
      settled = true
      if (timeout !== undefined) clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      action()
    }

    const abort = () =>
    {
      child.kill('SIGKILL')
      finish(() => reject(new Error('git command was interrupted')))
    }

    timeout = setTimeout(() =>
    {
      child.kill('SIGKILL')
      finish(() => reject(new Error(`git timed out after ${GIT_TIMEOUT_MS}ms`)))
    }, GIT_TIMEOUT_MS)

    signal.addEventListener('abort', abort, { once: true })
    child.once('error', (cause) => finish(() => reject(cause)))
    child.stdin.on('error', () =>
    {
      // process exit and stderr carry the useful Git failure
    })
    child.stdout.on('data', (chunk: Buffer) =>
    {
      stdoutBytes += chunk.byteLength
      if (stdoutBytes > maxOutputBytes)
      {
        child.kill('SIGKILL')
        finish(() => reject(new Error(`git stdout exceeded ${maxOutputBytes} bytes`)))
        return
      }
      stdoutChunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) =>
    {
      stderrBytes += chunk.byteLength
      if (stderrBytes > GIT_MAX_STDERR_BYTES)
      {
        child.kill('SIGKILL')
        finish(() => reject(new Error(`git stderr exceeded ${GIT_MAX_STDERR_BYTES} bytes`)))
        return
      }
      stderrChunks.push(chunk)
    })
    child.once('close', (code) =>
    {
      const exitCode = code ?? 1
      const stdout = Buffer.concat(stdoutChunks)
      const stderr = Buffer.concat(stderrChunks)
      if (exitCode !== 0 && input.allowNonZeroExit !== true)
      {
        const detail = stderr.toString('utf8').trim() || `git exited with code ${exitCode}`
        finish(() => reject(new Error(detail)))
        return
      }
      finish(() => resolve({ exitCode, stdout, stderr }))
    })

    if (input.stdin === undefined)
    {
      child.stdin.end()
    }
    else
    {
      child.stdin.end(input.stdin)
    }
    if (signal.aborted) abort()
  })
}

function runGit(input: GitInput, operation: string)
{
  return Effect.tryPromise({
    try: (signal) => runGitProcess(input, signal),
    catch: (cause) =>
      proposalError(
        operation,
        'git-failed',
        cause instanceof Error ? cause.message : 'Git command failed.',
      ),
  })
}

function gitText(input: GitInput, operation: string)
{
  return runGit(input, operation).pipe(
    Effect.map((result) => result.stdout.toString('utf8').trim()),
  )
}

function sha256(content: Uint8Array | string): ProposalSha256
{
  return NodeCrypto.createHash('sha256').update(content).digest('hex') as ProposalSha256
}

export function proposalRetainedRefPairToken(
  baseRetainedRef: string,
  proposedRetainedRef: string,
): string | null
{
  const baseMatch = PROPOSAL_BASE_RETAINED_REF.exec(baseRetainedRef)
  const proposedMatch = PROPOSAL_PROPOSED_RETAINED_REF.exec(proposedRetainedRef)
  return baseMatch?.[1] !== undefined && baseMatch[1] === proposedMatch?.[1] ? baseMatch[1] : null
}

export const enumerateProposalRetainedRefs = Effect.fn(
  'ProposalGitEngine.enumerateProposalRetainedRefs',
)(function* (gitCommonDir: string, maxRefs: number)
{
  const result = yield* runGit(
    {
      cwd: gitCommonDir,
      args: [
        `--git-dir=${gitCommonDir}`,
        'for-each-ref',
        `--count=${Math.max(0, maxRefs)}`,
        '--format=%(refname)',
        PROPOSAL_RETAINED_REF_PREFIX,
      ],
      maxOutputBytes: Math.max(1024, maxRefs * 256),
    },
    'ProposalGitEngine.enumerateProposalRetainedRefs',
  )
  return result.stdout
    .toString('utf8')
    .split('\n')
    .map((refName) => refName.trim())
    .filter(Boolean)
})

function validateProposalPath(
  value: string,
  operation: string,
): Effect.Effect<string, ProposalError>
{
  const normalized = NodePath.posix.normalize(value)
  const segments = value.split('/')
  if (
    value.length === 0 ||
    value.startsWith('/') ||
    value.startsWith('-') ||
    value.includes('\\') ||
    value.includes('\0') ||
    normalized !== value ||
    segments.includes('.') ||
    segments.includes('..') ||
    segments.includes('.git')
  )
  {
    return Effect.fail(
      proposalError(
        operation,
        'invalid-path',
        `Proposal path '${value}' is not repository-relative.`,
        {
          path: value,
        },
      ),
    )
  }
  return Effect.succeed(value)
}

function decodeContent(
  content: { readonly encoding: 'utf8' | 'base64'; readonly data: string },
  operation: string,
  proposalPath: string,
): Effect.Effect<Buffer, ProposalError>
{
  return Effect.gen(function* ()
  {
    let bytes: Buffer
    if (content.encoding === 'utf8')
    {
      bytes = Buffer.from(content.data, 'utf8')
    }
    else
    {
      const compact = content.data.replace(/\s+/g, '')
      if (
        compact.length === 0 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)
      )
      {
        return yield* proposalError(
          operation,
          'invalid-patch',
          `Base64 content for '${proposalPath}' is malformed.`,
          { path: proposalPath },
        )
      }
      bytes = Buffer.from(compact, 'base64')
    }
    if (bytes.byteLength > PROPOSAL_MAX_FILE_BYTES)
    {
      return yield* proposalError(
        operation,
        'limit-exceeded',
        `'${proposalPath}' is ${bytes.byteLength} bytes; the per-file limit is ${PROPOSAL_MAX_FILE_BYTES}.`,
        { path: proposalPath },
      )
    }
    return bytes
  })
}

function parseIndexEntry(stdout: Buffer, expectedPath: string): TreeEntry | null
{
  const records = stdout.toString('utf8').split('\0').filter(Boolean)
  for (const record of records)
  {
    const match = /^(\d{6}) ([0-9a-f]{40,64}) 0\t([\s\S]+)$/.exec(record)
    if (match?.[1] && match[2] && match[3] === expectedPath)
    {
      return { mode: match[1], oid: match[2], path: match[3] }
    }
  }
  return null
}

function parseTreeEntry(stdout: Buffer, expectedPath: string): TreeEntry | null
{
  const records = stdout.toString('utf8').split('\0').filter(Boolean)
  for (const record of records)
  {
    const match = /^(\d{6}) (?:blob|commit) ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(record)
    if (match?.[1] && match[2] && match[3] === expectedPath)
    {
      return { mode: match[1], oid: match[2], path: match[3] }
    }
  }
  return null
}

function parseChangedPaths(stdout: Buffer): {
  readonly changes: ReadonlyArray<
    | { readonly _tag: 'single'; readonly status: 'A' | 'M' | 'D'; readonly path: string }
    | { readonly _tag: 'rename'; readonly fromPath: string; readonly toPath: string }
  >
  readonly unsupportedStatuses: ReadonlyArray<string>
}
{
  const fields = stdout.toString('utf8').split('\0')
  const changes: Array<
    | { readonly _tag: 'single'; readonly status: 'A' | 'M' | 'D'; readonly path: string }
    | { readonly _tag: 'rename'; readonly fromPath: string; readonly toPath: string }
  > = []
  const unsupportedStatuses: string[] = []
  for (let index = 0; index < fields.length;)
  {
    const status = fields[index++]
    if (!status) break
    if (status.startsWith('R') || status.startsWith('C'))
    {
      const fromPath = fields[index++]
      const toPath = fields[index++]
      if (status.startsWith('R') && fromPath && toPath)
      {
        changes.push({ _tag: 'rename', fromPath, toPath })
      }
      else
      {
        unsupportedStatuses.push(status)
      }
      continue
    }
    const proposalPath = fields[index++]
    const kind = status[0]
    if (proposalPath && (kind === 'A' || kind === 'M' || kind === 'D'))
    {
      changes.push({ _tag: 'single', status: kind, path: proposalPath })
    }
    else if (proposalPath && kind === 'T')
    {
      // inspect both tree entries below so unsupported modes fail explicitly
      changes.push({ _tag: 'single', status: 'M', path: proposalPath })
    }
    else
    {
      unsupportedStatuses.push(status)
    }
  }
  return { changes, unsupportedStatuses }
}

export class ProposalGitEngine extends Context.Service<
  ProposalGitEngine,
  {
    readonly prepare: (
      input: PrepareProposalRevisionInput,
    ) => Effect.Effect<PreparedProposalRevision, ProposalError>
    readonly deleteRetainedRefs: (
      input: Pick<PreparedProposalRevision, 'baseRetainedRef' | 'proposedRetainedRef'> & {
        readonly cwd: string
      },
    ) => Effect.Effect<void>
  }
>()('456code/proposal/ProposalGitEngine')
{}

export const make = Effect.gen(function* ()
{
  const attemptStore = yield* ProposalRetainedRefAttemptStore.ProposalRetainedRefAttemptStore
  const prepare: ProposalGitEngine['Service']['prepare'] = Effect.fn('ProposalGitEngine.prepare')(
    function* (input)
    {
      const operation = 'ProposalGitEngine.prepare'
      const decodedTypedContent = new Map<number, Buffer>()
      if (input.changes._tag === 'typed')
      {
        if (input.changes.operations.length > PROPOSAL_MAX_OPERATIONS)
        {
          return yield* proposalError(
            operation,
            'limit-exceeded',
            `A proposal may contain at most ${PROPOSAL_MAX_OPERATIONS} typed operations.`,
          )
        }
        let submittedContentBytes = 0
        for (const [changeIndex, change] of input.changes.operations.entries())
        {
          const submitted =
            change._tag === 'add' || change._tag === 'modify'
              ? { content: change.content, path: change.path }
              : change._tag === 'rename' && change.content !== undefined
                ? { content: change.content, path: change.toPath }
                : null
          if (submitted === null) continue
          const content = yield* decodeContent(submitted.content, operation, submitted.path)
          const nextContentBytes = submittedContentBytes + content.byteLength
          if (nextContentBytes > PROPOSAL_MAX_TOTAL_CONTENT_BYTES)
          {
            return yield* proposalError(
              operation,
              'limit-exceeded',
              `Typed proposal content is ${nextContentBytes} bytes; the limit is ${PROPOSAL_MAX_TOTAL_CONTENT_BYTES}.`,
            )
          }
          submittedContentBytes = nextContentBytes
          decodedTypedContent.set(changeIndex, content)
        }
      }
      else
      {
        const diffBytes = Buffer.byteLength(input.changes.diff, 'utf8')
        if (diffBytes === 0)
        {
          return yield* proposalError(operation, 'empty-change', 'Unified diff input is empty.')
        }
        if (diffBytes > PROPOSAL_MAX_UNIFIED_DIFF_BYTES)
        {
          return yield* proposalError(
            operation,
            'limit-exceeded',
            `Unified diff is ${diffBytes} bytes; the limit is ${PROPOSAL_MAX_UNIFIED_DIFF_BYTES}.`,
          )
        }
      }

      const repoResult = yield* runGit(
        {
          cwd: input.cwd,
          args: ['rev-parse', '--show-toplevel'],
          allowNonZeroExit: true,
        },
        operation,
      )
      if (repoResult.exitCode !== 0)
      {
        return yield* proposalError(
          operation,
          'not-git-repository',
          `'${input.cwd}' is not inside a Git worktree.`,
          { proposalId: input.proposalId },
        )
      }
      const rootPath = repoResult.stdout.toString('utf8').trim()
      if (rootPath.length === 0)
      {
        return yield* proposalError(
          operation,
          'not-git-repository',
          'Git returned no worktree root.',
        )
      }

      const headResult = yield* runGit(
        {
          cwd: rootPath,
          args: ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'],
          allowNonZeroExit: true,
        },
        operation,
      )
      if (headResult.exitCode !== 0)
      {
        return yield* proposalError(
          operation,
          'missing-head',
          'Proposal snapshots require a repository with an existing HEAD commit.',
          { proposalId: input.proposalId },
        )
      }
      const headCommitOid = headResult.stdout.toString('utf8').trim()

      const gitDirOutput = yield* gitText(
        { cwd: rootPath, args: ['rev-parse', '--git-dir'] },
        operation,
      )
      const gitCommonDirOutput = yield* gitText(
        { cwd: rootPath, args: ['rev-parse', '--git-common-dir'] },
        operation,
      )
      const worktree: ProposalWorktreeIdentity = {
        rootPath,
        gitDir: NodePath.resolve(rootPath, gitDirOutput),
        gitCommonDir: NodePath.resolve(rootPath, gitCommonDirOutput),
      }

      const remoteNamesOutput = yield* gitText(
        { cwd: rootPath, args: ['remote'], allowNonZeroExit: true },
        operation,
      )
      const remoteNames = remoteNamesOutput
        .split('\n')
        .map((name) => name.trim())
        .filter(Boolean)
        .toSorted()
      const remoteName = remoteNames.includes('upstream')
        ? 'upstream'
        : remoteNames.includes('origin')
          ? 'origin'
          : remoteNames[0]
      let repository: ProposalRepositoryIdentity
      if (remoteName)
      {
        const remoteUrl = yield* gitText(
          { cwd: rootPath, args: ['remote', 'get-url', remoteName] },
          operation,
        )
        repository = {
          _tag: 'git-remote',
          canonicalKey: normalizeGitRemoteUrl(remoteUrl),
          remoteName,
          remoteUrl,
        }
      }
      else
      {
        repository = {
          _tag: 'local-git',
          canonicalKey: `local-git:${sha256(worktree.gitCommonDir)}`,
        }
      }

      const submoduleRows = yield* runGit(
        { cwd: rootPath, args: ['ls-files', '--stage', '-z'] },
        operation,
      )
      const submodulePaths = submoduleRows.stdout
        .toString('utf8')
        .split('\0')
        .flatMap((record) =>
        {
          const match = /^160000 [0-9a-f]{40,64} \d\t([\s\S]+)$/.exec(record)
          return match?.[1] ? [match[1]] : []
        })
      if (submodulePaths.length > 0)
      {
        const submoduleStatus = yield* runGit(
          {
            cwd: rootPath,
            args: [
              'status',
              '--porcelain=v1',
              '-z',
              '--untracked-files=all',
              '--ignore-submodules=none',
              '--',
              ...submodulePaths,
            ],
          },
          operation,
        )
        if (submoduleStatus.stdout.byteLength > 0)
        {
          return yield* proposalError(
            operation,
            'dirty-submodule',
            'Dirty submodules are unsupported by proposal snapshot policy v1.',
            { proposalId: input.proposalId },
          )
        }
      }

      const tempDirectory = yield* Effect.tryPromise({
        try: () => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), '456code-proposal-')),
        catch: (cause) =>
          proposalError(
            operation,
            'git-failed',
            cause instanceof Error ? cause.message : 'Could not create proposal temp storage.',
          ),
      })
      const indexPath = NodePath.join(tempDirectory, 'index')
      const indexEnv: NodeJS.ProcessEnv = {
        GIT_INDEX_FILE: indexPath,
        GIT_LITERAL_PATHSPECS: '1',
      }
      const refToken = sha256(`${input.proposalId}\0${input.revisionId}`)
      const baseRetainedRef = `refs/t3/proposals/${refToken}/base`
      const proposedRetainedRef = `refs/t3/proposals/${refToken}/proposed`
      const contentBlobs = new Map<string, ProposalContentBlob>()

      const result = yield* Effect.gen(function* ()
      {
        const captured = yield* Effect.tryPromise({
          try: (signal) =>
            captureExactGitSnapshot({
              repositoryRoot: rootPath,
              indexPath,
              signal,
              limits: {
                maxFileCount: EXACT_GIT_SNAPSHOT_MAX_FILE_COUNT,
                maxByteCount: EXACT_GIT_SNAPSHOT_MAX_BYTE_COUNT,
              },
            }),
          catch: (cause) =>
          {
            if (cause instanceof ExactGitSnapshotError)
            {
              const code =
                cause.code === 'limit-exceeded'
                  ? 'limit-exceeded'
                  : cause.code === 'dirty-submodule'
                    ? 'dirty-submodule'
                    : cause.code === 'unsupported-entry'
                      ? 'unsupported-file-mode'
                      : 'git-failed'
              return proposalError(operation, code, cause.message, {
                proposalId: input.proposalId,
              })
            }
            return proposalError(
              operation,
              'git-failed',
              'Could not capture the exact working tree.',
              { proposalId: input.proposalId },
            )
          },
        })
        if (captured.headOid !== headCommitOid)
        {
          return yield* proposalError(
            operation,
            'identity-mismatch',
            'HEAD changed while the proposal snapshot was being captured.',
            { proposalId: input.proposalId },
          )
        }
        const baseTreeOid = captured.treeOid
        const baseFileCount = captured.fileCount
        const baseByteCount = captured.byteCount
        yield* runGit({ cwd: rootPath, args: ['read-tree', baseTreeOid], env: indexEnv }, operation)

        if (input.changes._tag === 'typed')
        {
          const touchedPaths = new Set<string>()

          const readIndexEntry = Effect.fn('ProposalGitEngine.readIndexEntry')(function* (
            proposalPath: string,
          )
          {
            const output = yield* runGit(
              {
                cwd: rootPath,
                args: ['ls-files', '--stage', '-z', '--', proposalPath],
                env: indexEnv,
              },
              operation,
            )
            return parseIndexEntry(output.stdout, proposalPath)
          })
          const readBlob = (oid: string) =>
            runGit(
              {
                cwd: rootPath,
                args: ['cat-file', 'blob', oid],
                maxOutputBytes: PROPOSAL_MAX_FILE_BYTES + 1,
              },
              operation,
            ).pipe(Effect.map((output) => output.stdout))
          const writeBlob = Effect.fn('ProposalGitEngine.writeBlob')(function* (content: Buffer)
          {
            return yield* gitText(
              {
                cwd: rootPath,
                args: ['hash-object', '-w', '--stdin'],
                stdin: content,
              },
              operation,
            )
          })
          const verifyExisting = Effect.fn('ProposalGitEngine.verifyExisting')(function* (
            proposalPath: string,
            expectedSha256: string,
          )
          {
            const entry = yield* readIndexEntry(proposalPath)
            if (!entry)
            {
              return yield* proposalError(
                operation,
                'path-missing',
                `'${proposalPath}' does not exist in the captured base snapshot.`,
                { path: proposalPath },
              )
            }
            if (!REGULAR_FILE_MODES.has(entry.mode))
            {
              return yield* proposalError(
                operation,
                'unsupported-file-mode',
                `'${proposalPath}' has unsupported Git mode ${entry.mode}.`,
                { path: proposalPath },
              )
            }
            const existing = yield* readBlob(entry.oid)
            const actualSha256 = sha256(existing)
            if (actualSha256 !== expectedSha256)
            {
              return yield* proposalError(
                operation,
                'before-hash-mismatch',
                `'${proposalPath}' changed: expected ${expectedSha256}, captured ${actualSha256}.`,
                { path: proposalPath },
              )
            }
            return { entry, existing }
          })
          const registerPath = (proposalPath: string) =>
            Effect.gen(function* ()
            {
              yield* validateProposalPath(proposalPath, operation)
              if (touchedPaths.has(proposalPath))
              {
                return yield* proposalError(
                  operation,
                  'invalid-path',
                  `'${proposalPath}' is targeted more than once in one revision.`,
                  { path: proposalPath },
                )
              }
              touchedPaths.add(proposalPath)
            })

          for (const [changeIndex, change] of input.changes.operations.entries())
          {
            if (change._tag === 'add')
            {
              yield* registerPath(change.path)
              if ((yield* readIndexEntry(change.path)) !== null)
              {
                return yield* proposalError(
                  operation,
                  'path-exists',
                  `'${change.path}' already exists in the captured base snapshot.`,
                  { path: change.path },
                )
              }
              const content = decodedTypedContent.get(changeIndex)!
              const oid = yield* writeBlob(content)
              const mode = change.executable === true ? '100755' : '100644'
              yield* runGit(
                {
                  cwd: rootPath,
                  args: ['update-index', '--add', '--cacheinfo', `${mode},${oid},${change.path}`],
                  env: indexEnv,
                },
                operation,
              )
              continue
            }

            if (change._tag === 'modify')
            {
              yield* registerPath(change.path)
              const { entry } = yield* verifyExisting(change.path, change.beforeSha256)
              const content = decodedTypedContent.get(changeIndex)!
              const oid = yield* writeBlob(content)
              const mode =
                change.executable === undefined
                  ? entry.mode
                  : change.executable
                    ? '100755'
                    : '100644'
              yield* runGit(
                {
                  cwd: rootPath,
                  args: ['update-index', '--add', '--cacheinfo', `${mode},${oid},${change.path}`],
                  env: indexEnv,
                },
                operation,
              )
              continue
            }

            if (change._tag === 'delete')
            {
              yield* registerPath(change.path)
              yield* verifyExisting(change.path, change.beforeSha256)
              yield* runGit(
                {
                  cwd: rootPath,
                  args: ['update-index', '--force-remove', '--', change.path],
                  env: indexEnv,
                },
                operation,
              )
              continue
            }

            yield* registerPath(change.fromPath)
            yield* registerPath(change.toPath)
            const { entry, existing } = yield* verifyExisting(change.fromPath, change.beforeSha256)
            if ((yield* readIndexEntry(change.toPath)) !== null)
            {
              return yield* proposalError(
                operation,
                'path-exists',
                `'${change.toPath}' already exists in the captured base snapshot.`,
                { path: change.toPath },
              )
            }
            const content =
              change.content === undefined ? existing : decodedTypedContent.get(changeIndex)!
            const oid = yield* writeBlob(content)
            const mode =
              change.executable === undefined ? entry.mode : change.executable ? '100755' : '100644'
            yield* runGit(
              {
                cwd: rootPath,
                args: ['update-index', '--force-remove', '--', change.fromPath],
                env: indexEnv,
              },
              operation,
            )
            yield* runGit(
              {
                cwd: rootPath,
                args: ['update-index', '--add', '--cacheinfo', `${mode},${oid},${change.toPath}`],
                env: indexEnv,
              },
              operation,
            )
          }
        }
        else
        {
          const applyResult = yield* runGit(
            {
              cwd: rootPath,
              args: ['apply', '--cached', '--binary', '--whitespace=nowarn', '--'],
              env: indexEnv,
              stdin: input.changes.diff,
              allowNonZeroExit: true,
            },
            operation,
          )
          if (applyResult.exitCode !== 0)
          {
            return yield* proposalError(
              operation,
              'invalid-patch',
              applyResult.stderr.toString('utf8').trim() || 'Unified diff did not apply.',
            )
          }
        }

        const proposedTreeOid = yield* gitText(
          { cwd: rootPath, args: ['write-tree'], env: indexEnv },
          operation,
        )
        if (proposedTreeOid === baseTreeOid)
        {
          return yield* proposalError(
            operation,
            'empty-change',
            'Proposal does not change the captured base tree.',
          )
        }

        const changedPathOutput = yield* runGit(
          {
            cwd: rootPath,
            args: [
              'diff',
              '--name-status',
              '-z',
              '--find-renames=50%',
              '--no-ext-diff',
              '--no-textconv',
              baseTreeOid,
              proposedTreeOid,
              '--',
            ],
            maxOutputBytes: PROPOSAL_MAX_OPERATIONS * 2 * 1_024 + 32 * 1_024,
          },
          operation,
        )
        const parsedChangedPaths = parseChangedPaths(changedPathOutput.stdout)
        if (parsedChangedPaths.unsupportedStatuses.length > 0)
        {
          return yield* proposalError(
            operation,
            'invalid-patch',
            `Git returned unsupported proposal change status '${parsedChangedPaths.unsupportedStatuses[0]}'.`,
          )
        }
        const changedPaths = parsedChangedPaths.changes
        if (changedPaths.length === 0)
        {
          return yield* proposalError(
            operation,
            'empty-change',
            'Git found no normalized proposal operations.',
          )
        }
        if (changedPaths.length > PROPOSAL_MAX_OPERATIONS)
        {
          return yield* proposalError(
            operation,
            'limit-exceeded',
            `Normalized proposal contains ${changedPaths.length} operations; the limit is ${PROPOSAL_MAX_OPERATIONS}.`,
          )
        }

        const readTreeEntry = Effect.fn('ProposalGitEngine.readTreeEntry')(function* (
          treeOid: string,
          proposalPath: string,
        )
        {
          yield* validateProposalPath(proposalPath, operation)
          const output = yield* runGit(
            {
              cwd: rootPath,
              args: ['ls-tree', '-z', treeOid, '--', proposalPath],
              env: { GIT_LITERAL_PATHSPECS: '1' },
            },
            operation,
          )
          return parseTreeEntry(output.stdout, proposalPath)
        })
        const makeBlobReference = Effect.fn('ProposalGitEngine.makeBlobReference')(function* (
          entry: TreeEntry,
        )
        {
          if (!REGULAR_FILE_MODES.has(entry.mode))
          {
            return yield* proposalError(
              operation,
              'unsupported-file-mode',
              `'${entry.path}' has unsupported Git mode ${entry.mode}.`,
              { path: entry.path },
            )
          }
          const output = yield* runGit(
            {
              cwd: rootPath,
              args: ['cat-file', 'blob', entry.oid],
              maxOutputBytes: PROPOSAL_MAX_FILE_BYTES + 1,
            },
            operation,
          )
          if (output.stdout.byteLength > PROPOSAL_MAX_FILE_BYTES)
          {
            return yield* proposalError(
              operation,
              'limit-exceeded',
              `'${entry.path}' is ${output.stdout.byteLength} bytes; the per-file limit is ${PROPOSAL_MAX_FILE_BYTES}.`,
              { path: entry.path },
            )
          }
          const contentSha256 = sha256(output.stdout)
          contentBlobs.set(contentSha256, {
            sha256: contentSha256,
            content: output.stdout,
          })
          return {
            sha256: contentSha256,
            byteLength: output.stdout.byteLength,
            gitBlobOid: entry.oid,
            mode: entry.mode,
          } as ProposalBlobReference
        })

        const normalizedOperations: ProposalNormalizedOperation[] = []
        let changedContentBytes = 0
        for (const change of changedPaths)
        {
          if (change._tag === 'rename')
          {
            const beforeEntry = yield* readTreeEntry(baseTreeOid, change.fromPath)
            const afterEntry = yield* readTreeEntry(proposedTreeOid, change.toPath)
            if (!beforeEntry || !afterEntry)
            {
              return yield* proposalError(
                operation,
                'git-failed',
                `Git rename '${change.fromPath}' -> '${change.toPath}' has incomplete tree entries.`,
              )
            }
            const before = yield* makeBlobReference(beforeEntry)
            const after = yield* makeBlobReference(afterEntry)
            changedContentBytes += after.byteLength
            normalizedOperations.push({
              _tag: 'rename',
              fromPath: change.fromPath,
              toPath: change.toPath,
              before,
              after,
            })
            continue
          }

          if (change.status === 'A')
          {
            const afterEntry = yield* readTreeEntry(proposedTreeOid, change.path)
            if (!afterEntry)
            {
              return yield* proposalError(
                operation,
                'git-failed',
                `Added path '${change.path}' is missing from the proposed tree.`,
              )
            }
            const after = yield* makeBlobReference(afterEntry)
            changedContentBytes += after.byteLength
            normalizedOperations.push({ _tag: 'add', path: change.path, after })
            continue
          }

          if (change.status === 'D')
          {
            const beforeEntry = yield* readTreeEntry(baseTreeOid, change.path)
            if (!beforeEntry)
            {
              return yield* proposalError(
                operation,
                'git-failed',
                `Deleted path '${change.path}' is missing from the base tree.`,
              )
            }
            const before = yield* makeBlobReference(beforeEntry)
            changedContentBytes += before.byteLength
            normalizedOperations.push({ _tag: 'delete', path: change.path, before })
            continue
          }

          const beforeEntry = yield* readTreeEntry(baseTreeOid, change.path)
          const afterEntry = yield* readTreeEntry(proposedTreeOid, change.path)
          if (!beforeEntry || !afterEntry)
          {
            return yield* proposalError(
              operation,
              'git-failed',
              `Modified path '${change.path}' has incomplete tree entries.`,
            )
          }
          const before = yield* makeBlobReference(beforeEntry)
          const after = yield* makeBlobReference(afterEntry)
          changedContentBytes += after.byteLength
          normalizedOperations.push({ _tag: 'modify', path: change.path, before, after })
        }
        if (changedContentBytes > PROPOSAL_MAX_TOTAL_CONTENT_BYTES)
        {
          return yield* proposalError(
            operation,
            'limit-exceeded',
            `Normalized proposal content is ${changedContentBytes} bytes; the limit is ${PROPOSAL_MAX_TOTAL_CONTENT_BYTES}.`,
          )
        }

        const manifest: ProposalRevisionManifest = {
          version: 'v1',
          operations: normalizedOperations,
          operationCount: normalizedOperations.length,
          changedFileCount: normalizedOperations.length,
          changedContentBytes,
        }
        const manifestJson = JSON.stringify(manifest)
        const manifestBytes = Buffer.from(manifestJson, 'utf8')
        const manifestSha256 = sha256(manifestBytes)
        contentBlobs.set(manifestSha256, { sha256: manifestSha256, content: manifestBytes })

        const diffOutput = yield* runGit(
          {
            cwd: rootPath,
            args: [
              'diff',
              '--binary',
              '--full-index',
              '--patch',
              '--no-color',
              '--no-ext-diff',
              '--no-textconv',
              baseTreeOid,
              proposedTreeOid,
              '--',
            ],
            maxOutputBytes: PROPOSAL_MAX_DIFF_OUTPUT_BYTES,
          },
          operation,
        )
        const diff = diffOutput.stdout.toString('utf8')
        const diffSha256 = sha256(diffOutput.stdout)
        contentBlobs.set(diffSha256, { sha256: diffSha256, content: diffOutput.stdout })

        const commitEnv: NodeJS.ProcessEnv = {
          GIT_AUTHOR_NAME: '456code',
          GIT_AUTHOR_EMAIL: '456code@users.noreply.github.com',
          GIT_COMMITTER_NAME: '456code',
          GIT_COMMITTER_EMAIL: '456code@users.noreply.github.com',
        }
        const baseCommitOid = yield* gitText(
          {
            cwd: rootPath,
            args: [
              'commit-tree',
              baseTreeOid,
              '-p',
              headCommitOid,
              '-m',
              `456code proposal base ${input.revisionId}`,
            ],
            env: commitEnv,
          },
          operation,
        )
        const proposedCommitOid = yield* gitText(
          {
            cwd: rootPath,
            args: [
              'commit-tree',
              proposedTreeOid,
              '-p',
              baseCommitOid,
              '-m',
              `456code proposal revision ${input.revisionId}`,
            ],
            env: commitEnv,
          },
          operation,
        )
        yield* attemptStore
          .register({
            refToken,
            gitCommonDir: worktree.gitCommonDir,
            baseRef: baseRetainedRef,
            proposedRef: proposedRetainedRef,
            createdAt: DateTime.formatIso(yield* DateTime.now),
          })
          .pipe(
            Effect.mapError((cause) =>
              proposalError(
                operation,
                'persistence-failed',
                `Could not register retained refs before creation: ${cause.message}`,
                { proposalId: input.proposalId },
              ),
            ),
          )
        yield* runGit(
          {
            cwd: rootPath,
            args: ['update-ref', '--stdin'],
            stdin: [
              'start',
              `update ${baseRetainedRef} ${baseCommitOid}`,
              `update ${proposedRetainedRef} ${proposedCommitOid}`,
              'prepare',
              'commit',
              '',
            ].join('\n'),
          },
          operation,
        )

        return {
          repository,
          worktree,
          headCommitOid,
          baseTreeOid,
          baseRetainedRef,
          baseFileCount,
          baseByteCount,
          proposedTreeOid,
          proposedRetainedRef,
          manifest,
          manifestJson,
          manifestSha256,
          diff,
          diffSha256,
          blobs: [...contentBlobs.values()],
        } satisfies PreparedProposalRevision
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit)
            ? Effect.all(
                [baseRetainedRef, proposedRetainedRef].map((refName) =>
                  runGit(
                    {
                      cwd: rootPath,
                      args: ['update-ref', '-d', refName],
                      allowNonZeroExit: true,
                    },
                    'ProposalGitEngine.prepare.cleanupRetainedRefs',
                  ).pipe(Effect.ignore),
                ),
                { concurrency: 2, discard: true },
              ).pipe(Effect.andThen(attemptStore.remove(refToken).pipe(Effect.ignore)))
            : Effect.void,
        ),
        Effect.ensuring(
          Effect.promise(() => NodeFSP.rm(tempDirectory, { recursive: true, force: true })).pipe(
            Effect.ignore,
          ),
        ),
      )

      return result
    },
  )

  const deleteRetainedRefs: ProposalGitEngine['Service']['deleteRetainedRefs'] = (input) =>
  {
    if (proposalRetainedRefPairToken(input.baseRetainedRef, input.proposedRetainedRef) === null)
    {
      return Effect.logWarning('refusing to delete an invalid proposal retained-ref pair', {
        baseRetainedRef: input.baseRetainedRef,
        proposedRetainedRef: input.proposedRetainedRef,
      })
    }
    return Effect.all(
      [input.baseRetainedRef, input.proposedRetainedRef].map((refName) =>
        runGit(
          {
            cwd: input.cwd,
            args: ['update-ref', '-d', refName],
            allowNonZeroExit: true,
          },
          'ProposalGitEngine.deleteRetainedRefs',
        ).pipe(Effect.ignore),
      ),
      { concurrency: 2, discard: true },
    )
  }

  return ProposalGitEngine.of({ prepare, deleteRetainedRefs })
})

export const layer = Layer.effect(ProposalGitEngine, make)
