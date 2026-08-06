// apps/server/src/vcs/GitVcsDriver.ts
// implements Git-backed workspace, ref, worktree, commit, and checkpoint operations

// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'

import * as Context from 'effect/Context'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import { ChildProcessSpawner } from 'effect/unstable/process'

import {
  GitCommandError,
  VcsProcessExitError,
  type VcsSwitchRefInput,
  type VcsSwitchRefResult,
  type VcsCreateRefInput,
  type VcsCreateRefResult,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
  type VcsInitInput,
  type VcsListRefsInput,
  type VcsListRefsResult,
  type VcsPullResult,
  type VcsRemoveWorktreeInput,
  type VcsStatusInput,
  type VcsStatusResult,
  type VcsError,
} from '@t3tools/contracts'
import {
  applyStagedExactGitTreeRestore,
  captureExactGitSnapshot,
  EXACT_GIT_SNAPSHOT_MAX_BYTE_COUNT,
  EXACT_GIT_SNAPSHOT_MAX_FILE_COUNT,
  materializeExactGitTree,
  preflightExactGitTreeRestore,
  restoreExactGitTree,
  verifyExactGitTreeMaterialization,
  verifyExactGitTreeRestore,
  type ExactGitTreeRestore,
  type ExactGitTreeRestorePreflight,
  type ExactGitTreeVerification,
} from './ExactGitSnapshot.ts'
import { makeGitVcsDriverCore } from './GitVcsDriverCore.ts'
import * as VcsDriver from './VcsDriver.ts'
import * as VcsProcess from './VcsProcess.ts'

export interface ExecuteGitInput
{
  readonly operation: string
  readonly cwd: string
  readonly args: ReadonlyArray<string>
  readonly stdin?: string
  readonly env?: NodeJS.ProcessEnv
  readonly allowNonZeroExit?: boolean
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  readonly appendTruncationMarker?: boolean
  readonly progress?: ExecuteGitProgress
}

export interface ExecuteGitResult
{
  readonly exitCode: ChildProcessSpawner.ExitCode
  readonly stdout: string
  readonly stderr: string
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
}

export interface GitStatusDetails
{
  isRepo: boolean
  sourceControlProvider?: VcsStatusResult['sourceControlProvider']
  hasOriginRemote: boolean
  isDefaultBranch: boolean
  branch: string | null
  upstreamRef: string | null
  hasWorkingTreeChanges: boolean
  workingTree: VcsStatusResult['workingTree']
  hasUpstream: boolean
  aheadCount: number
  behindCount: number
  aheadOfDefaultCount: number
}

export interface GitRemoteStatusDetails
{
  isRepo: boolean
  isDefaultBranch: boolean
  branch: string | null
  upstreamRef: string | null
  hasUpstream: boolean
  aheadCount: number
  behindCount: number
  aheadOfDefaultCount: number
}

export interface GitPreparedCommitContext
{
  stagedSummary: string
  stagedPatch: string
}

export interface ExecuteGitProgress
{
  readonly onStdoutLine?: (line: string) => Effect.Effect<void, never>
  readonly onStderrLine?: (line: string) => Effect.Effect<void, never>
  readonly onHookStarted?: (hookName: string) => Effect.Effect<void, never>
  readonly onHookFinished?: (input: {
    hookName: string
    exitCode: number | null
    durationMs: number | null
  }) => Effect.Effect<void, never>
}

export interface GitCommitProgress
{
  readonly onOutputLine?: (input: {
    stream: 'stdout' | 'stderr'
    text: string
  }) => Effect.Effect<void, never>
  readonly onHookStarted?: (hookName: string) => Effect.Effect<void, never>
  readonly onHookFinished?: (input: {
    hookName: string
    exitCode: number | null
    durationMs: number | null
  }) => Effect.Effect<void, never>
}

export interface GitCommitOptions
{
  readonly timeoutMs?: number
  readonly progress?: GitCommitProgress
}

export interface GitPushResult
{
  status: 'pushed' | 'skipped_up_to_date'
  branch: string
  upstreamBranch?: string | undefined
  setUpstream?: boolean | undefined
}

export interface GitRangeContext
{
  commitSummary: string
  diffSummary: string
  diffPatch: string
}

export interface GitRenameBranchInput
{
  cwd: string
  oldBranch: string
  newBranch: string
}

export interface GitRenameBranchResult
{
  branch: string
}

export interface GitFetchPullRequestBranchInput
{
  cwd: string
  prNumber: number
  branch: string
}

export interface GitEnsureRemoteInput
{
  cwd: string
  preferredName: string
  url: string
}

export interface GitFetchRemoteBranchInput
{
  cwd: string
  remoteName: string
  remoteBranch: string
  localBranch: string
}

export interface GitFetchRemoteTrackingBranchInput
{
  cwd: string
  remoteName: string
  remoteBranch: string
}

export interface GitFetchRemoteInput
{
  cwd: string
  remoteName: string
}

export interface GitResolveRemoteTrackingCommitInput
{
  cwd: string
  refName: string
  fallbackRemoteName: string
}

export interface GitResolveRemoteTrackingCommitResult
{
  commitSha: string
  remoteRefName: string
}

export interface GitSetBranchUpstreamInput
{
  cwd: string
  branch: string
  remoteName: string
  remoteBranch: string
}

export interface GitRemoteStatusOptions
{
  readonly refreshUpstream?: boolean
}

export interface GitStageCheckpointTreeInput
{
  readonly cwd: string
  readonly ref: string
  readonly stagePath: string
}

export interface GitCheckpointRestoreInput
{
  readonly cwd: string
  readonly ref: string
}

export interface GitApplyStagedCheckpointRestoreInput extends GitCheckpointRestoreInput
{
  readonly stagePath: string
}

export interface GitStagedCheckpointOps
{
  readonly stageCheckpointTree: (
    input: GitStageCheckpointTreeInput,
  ) => Effect.Effect<ExactGitTreeVerification, VcsError>
  readonly verifyRestorePreconditions: (
    input: GitCheckpointRestoreInput,
  ) => Effect.Effect<ExactGitTreeRestorePreflight, VcsError>
  readonly applyStagedRestore: (
    input: GitApplyStagedCheckpointRestoreInput,
  ) => Effect.Effect<ExactGitTreeRestore, VcsError>
  readonly postVerifyRestore: (
    input: GitCheckpointRestoreInput,
  ) => Effect.Effect<ExactGitTreeVerification, VcsError>
}

export class GitVcsDriver extends Context.Service<
  GitVcsDriver,
  {
    readonly execute: (input: ExecuteGitInput) => Effect.Effect<ExecuteGitResult, GitCommandError>
    readonly status: (input: VcsStatusInput) => Effect.Effect<VcsStatusResult, GitCommandError>
    readonly statusDetails: (cwd: string) => Effect.Effect<GitStatusDetails, GitCommandError>
    readonly statusDetailsLocal: (cwd: string) => Effect.Effect<GitStatusDetails, GitCommandError>
    readonly statusDetailsRemote: (
      cwd: string,
      options?: GitRemoteStatusOptions,
    ) => Effect.Effect<GitRemoteStatusDetails, GitCommandError>
    readonly prepareCommitContext: (
      cwd: string,
      filePaths?: readonly string[],
    ) => Effect.Effect<GitPreparedCommitContext | null, GitCommandError>
    readonly commit: (
      cwd: string,
      subject: string,
      body: string,
      options?: GitCommitOptions,
    ) => Effect.Effect<{ commitSha: string }, GitCommandError>
    readonly pushCurrentBranch: (
      cwd: string,
      fallbackBranch: string | null,
      options?: { readonly remoteName?: string | null },
    ) => Effect.Effect<GitPushResult, GitCommandError>
    readonly readRangeContext: (
      cwd: string,
      baseRef: string,
    ) => Effect.Effect<GitRangeContext, GitCommandError>
    readonly getReviewDiffPreview: (
      input: ReviewDiffPreviewInput,
    ) => Effect.Effect<ReviewDiffPreviewResult, GitCommandError>
    readonly readConfigValue: (
      cwd: string,
      key: string,
    ) => Effect.Effect<string | null, GitCommandError>
    readonly listRefs: (
      input: VcsListRefsInput,
    ) => Effect.Effect<VcsListRefsResult, GitCommandError>
    readonly pullCurrentBranch: (cwd: string) => Effect.Effect<VcsPullResult, GitCommandError>
    readonly createWorktree: (
      input: VcsCreateWorktreeInput,
    ) => Effect.Effect<VcsCreateWorktreeResult, GitCommandError>
    readonly fetchPullRequestBranch: (
      input: GitFetchPullRequestBranchInput,
    ) => Effect.Effect<void, GitCommandError>
    readonly ensureRemote: (input: GitEnsureRemoteInput) => Effect.Effect<string, GitCommandError>
    readonly resolvePrimaryRemoteName: (cwd: string) => Effect.Effect<string, GitCommandError>
    readonly fetchRemote: (input: GitFetchRemoteInput) => Effect.Effect<void, GitCommandError>
    readonly resolveRemoteTrackingCommit: (
      input: GitResolveRemoteTrackingCommitInput,
    ) => Effect.Effect<GitResolveRemoteTrackingCommitResult, GitCommandError>
    readonly fetchRemoteBranch: (
      input: GitFetchRemoteBranchInput,
    ) => Effect.Effect<void, GitCommandError>
    readonly fetchRemoteTrackingBranch: (
      input: GitFetchRemoteTrackingBranchInput,
    ) => Effect.Effect<void, GitCommandError>
    readonly setBranchUpstream: (
      input: GitSetBranchUpstreamInput,
    ) => Effect.Effect<void, GitCommandError>
    readonly removeWorktree: (input: VcsRemoveWorktreeInput) => Effect.Effect<void, GitCommandError>
    readonly renameBranch: (
      input: GitRenameBranchInput,
    ) => Effect.Effect<GitRenameBranchResult, GitCommandError>
    readonly createRef: (
      input: VcsCreateRefInput,
    ) => Effect.Effect<VcsCreateRefResult, GitCommandError>
    readonly switchRef: (
      input: VcsSwitchRefInput,
    ) => Effect.Effect<VcsSwitchRefResult, GitCommandError>
    readonly initRepo: (input: VcsInitInput) => Effect.Effect<void, GitCommandError>
    readonly listLocalBranchNames: (cwd: string) => Effect.Effect<string[], GitCommandError>
  }
>()('456code/vcs/GitVcsDriver')
{}

const WORKSPACE_FILES_MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const GIT_CHECK_IGNORE_MAX_STDIN_BYTES = 256 * 1024
const CHECKPOINT_DIFF_MAX_OUTPUT_BYTES = 10_000_000
const WORKSPACE_GIT_HARDENED_CONFIG_ARGS = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.untrackedCache=false',
] as const

// git rejects a compare-and-swap by refusing the ref lock and naming the
// mismatch; any other nonzero exit is a real driver failure, not a lost race
const CHECKPOINT_REF_RACE_MARKERS = [
  'reference already exists',
  'but expected',
  'unable to resolve reference',
] as const

// `update-ref -d` already exits 0 for an absent ref, but ref backends report
// the miss differently, so treat an explicit "not there" as cleanup success
const CHECKPOINT_REF_ABSENT_MARKERS = [
  'unable to resolve reference',
  'no such ref',
  'does not exist',
] as const

function matchesGitRefMarker(stderr: string, markers: ReadonlyArray<string>): boolean
{
  const detail = stderr.toLowerCase()
  return markers.some((marker) => detail.includes(marker))
}

// builds the `update-ref --stdin` transaction that publishes a checkpoint
// commit only when the ref still matches the expectation the caller captured
// against: `create` for an absent ref, `update` w/ an expected old oid otherwise
function checkpointPublicationTransaction(
  checkpointRef: string,
  commitOid: string,
  expected: VcsDriver.VcsCheckpointRefExpectation,
): string
{
  const operation =
    expected.kind === 'absent'
      ? `create ${checkpointRef} ${commitOid}`
      : `update ${checkpointRef} ${commitOid} ${expected.commitOid}`
  return ['start', operation, 'prepare', 'commit', ''].join('\n')
}

const nowFreshness = Effect.fn('GitVcsDriver.nowFreshness')(function* ()
{
  const now = yield* DateTime.now
  return {
    source: 'live-local' as const,
    observedAt: now,
    expiresAt: Option.none(),
  }
})

function splitNullSeparatedPaths(input: string, truncated: boolean): string[]
{
  const parts = input.split('\0')
  if (parts.length === 0) return []

  if (truncated && parts[parts.length - 1]?.length)
  {
    parts.pop()
  }

  return parts.filter((value) => value.length > 0)
}

function chunkPathsForGitCheckIgnore(relativePaths: ReadonlyArray<string>): string[][]
{
  const chunks: string[][] = []
  let chunk: string[] = []
  let chunkBytes = 0

  for (const relativePath of relativePaths)
  {
    const relativePathBytes = Buffer.byteLength(relativePath) + 1
    if (chunk.length > 0 && chunkBytes + relativePathBytes > GIT_CHECK_IGNORE_MAX_STDIN_BYTES)
    {
      chunks.push(chunk)
      chunk = []
      chunkBytes = 0
    }

    chunk.push(relativePath)
    chunkBytes += relativePathBytes

    if (chunkBytes >= GIT_CHECK_IGNORE_MAX_STDIN_BYTES)
    {
      chunks.push(chunk)
      chunk = []
      chunkBytes = 0
    }
  }

  if (chunk.length > 0)
  {
    chunks.push(chunk)
  }

  return chunks
}

function parseGitRemoteVerboseOutput(
  output: string,
): Map<string, { url?: string; pushUrl?: string }>
{
  const remotes = new Map<string, { url?: string; pushUrl?: string }>()
  for (const line of output.split('\n'))
  {
    const trimmed = line.trim()
    if (trimmed.length === 0)
    {
      continue
    }

    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(trimmed)
    if (!match)
    {
      continue
    }

    const name = match[1]
    const url = match[2]
    const direction = match[3]
    if (!name || !url || !direction)
    {
      continue
    }
    const remote = remotes.get(name) ?? {}
    if (direction === 'fetch')
    {
      remote.url = url
    }
    else
    {
      remote.pushUrl = url
    }
    remotes.set(name, remote)
  }
  return remotes
}

const gitCommand = (
  process: VcsProcess.VcsProcess['Service'],
  operation: string,
  cwd: string,
  args: ReadonlyArray<string>,
  options?: {
    readonly stdin?: string
    readonly env?: NodeJS.ProcessEnv
    readonly allowNonZeroExit?: boolean
    readonly timeoutMs?: number
    readonly maxOutputBytes?: number
    readonly appendTruncationMarker?: boolean
  },
) =>
  process.run({
    operation,
    command: 'git',
    args: ['-C', cwd, ...args],
    cwd,
    spawnCwd: globalThis.process.cwd(),
    ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}),
    ...(options?.env !== undefined ? { env: options.env } : {}),
    ...(options?.allowNonZeroExit !== undefined
      ? { allowNonZeroExit: options.allowNonZeroExit }
      : {}),
    ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options?.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
    ...(options?.appendTruncationMarker !== undefined
      ? { appendTruncationMarker: options.appendTruncationMarker }
      : {}),
  })

export const makeVcsDriverShape = Effect.fn('makeGitVcsDriverShape')(function* ()
{
  const vcsProcess = yield* VcsProcess.VcsProcess
  const capabilities = {
    kind: 'git' as const,
    supportsWorktrees: true,
    supportsBookmarks: false,
    supportsAtomicSnapshot: false,
    supportsPushDefaultRemote: true,
    ignoreClassifier: 'native' as const,
  }

  const isInsideWorkTree: VcsDriver.VcsDriver['Service']['isInsideWorkTree'] = (cwd) =>
    gitCommand(
      vcsProcess,
      'GitVcsDriver.isInsideWorkTree',
      cwd,
      ['rev-parse', '--is-inside-work-tree'],
      {
        allowNonZeroExit: true,
        timeoutMs: 5_000,
        maxOutputBytes: 4_096,
      },
    ).pipe(Effect.map((result) => result.exitCode === 0 && result.stdout.trim() === 'true'))

  const execute: VcsDriver.VcsDriver['Service']['execute'] = (input) =>
    gitCommand(vcsProcess, input.operation, input.cwd, input.args, {
      ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
      ...(input.env !== undefined ? { env: input.env } : {}),
      ...(input.allowNonZeroExit !== undefined ? { allowNonZeroExit: input.allowNonZeroExit } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
      ...(input.appendTruncationMarker !== undefined
        ? { appendTruncationMarker: input.appendTruncationMarker }
        : {}),
    })

  const detectRepository: VcsDriver.VcsDriver['Service']['detectRepository'] = Effect.fn(
    'detectRepository',
  )(function* (cwd)
  {
    if (!(yield* isInsideWorkTree(cwd)))
    {
      return null
    }

    const root = yield* gitCommand(vcsProcess, 'GitVcsDriver.detectRepository.root', cwd, [
      'rev-parse',
      '--show-toplevel',
    ])
    const gitCommonDir = yield* gitCommand(
      vcsProcess,
      'GitVcsDriver.detectRepository.commonDir',
      cwd,
      ['rev-parse', '--git-common-dir'],
    ).pipe(Effect.orElseSucceed(() => null))

    return {
      kind: 'git' as const,
      rootPath: root.stdout.trim(),
      metadataPath: gitCommonDir?.stdout.trim() || null,
      freshness: yield* nowFreshness(),
    }
  })

  const listWorkspaceFiles: VcsDriver.VcsDriver['Service']['listWorkspaceFiles'] = (cwd) =>
    gitCommand(
      vcsProcess,
      'GitVcsDriver.listWorkspaceFiles',
      cwd,
      [
        ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        '-z',
      ],
      {
        allowNonZeroExit: true,
        timeoutMs: 20_000,
        maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
        appendTruncationMarker: true,
      },
    ).pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.gen(function* ()
            {
              const freshness = yield* nowFreshness()
              return {
                paths: splitNullSeparatedPaths(result.stdout, result.stdoutTruncated),
                truncated: result.stdoutTruncated,
                freshness,
              }
            })
          : Effect.fail(
              new VcsProcessExitError({
                operation: 'GitVcsDriver.listWorkspaceFiles',
                command: 'git ls-files',
                cwd,
                exitCode: result.exitCode,
                detail: result.stderr.trim() || 'git ls-files failed',
              }),
            ),
      ),
    )

  const listRemotes: VcsDriver.VcsDriver['Service']['listRemotes'] = Effect.fn('listRemotes')(
    function* (cwd)
    {
      const result = yield* gitCommand(
        vcsProcess,
        'GitVcsDriver.listRemotes',
        cwd,
        ['remote', '-v'],
        {
          allowNonZeroExit: true,
          timeoutMs: 5_000,
          maxOutputBytes: 64 * 1024,
        },
      )

      if (result.exitCode !== 0)
      {
        return yield* new VcsProcessExitError({
          operation: 'GitVcsDriver.listRemotes',
          command: 'git remote -v',
          cwd,
          exitCode: result.exitCode,
          detail: result.stderr.trim() || 'git remote -v failed',
        })
      }

      const parsed = parseGitRemoteVerboseOutput(result.stdout)
      const remotes = Array.from(parsed.entries()).flatMap(([name, remote]) =>
      {
        if (!remote.url)
        {
          return []
        }
        return [
          {
            name,
            url: remote.url,
            pushUrl: remote.pushUrl ? Option.some(remote.pushUrl) : Option.none(),
            isPrimary: name === 'origin',
          },
        ]
      })

      return {
        remotes,
        freshness: yield* nowFreshness(),
      }
    },
  )

  const filterIgnoredPaths: VcsDriver.VcsDriver['Service']['filterIgnoredPaths'] = Effect.fn(
    'filterIgnoredPaths',
  )(function* (cwd, relativePaths)
  {
    if (relativePaths.length === 0)
    {
      return relativePaths
    }

    const ignoredPaths = new Set<string>()
    const chunks = chunkPathsForGitCheckIgnore(relativePaths)

    for (const chunk of chunks)
    {
      const result = yield* gitCommand(
        vcsProcess,
        'GitVcsDriver.filterIgnoredPaths',
        cwd,
        [...WORKSPACE_GIT_HARDENED_CONFIG_ARGS, 'check-ignore', '--no-index', '-z', '--stdin'],
        {
          stdin: `${chunk.join('\0')}\0`,
          allowNonZeroExit: true,
          timeoutMs: 20_000,
          maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
          appendTruncationMarker: true,
        },
      )

      if (result.exitCode !== 0 && result.exitCode !== 1)
      {
        return yield* new VcsProcessExitError({
          operation: 'GitVcsDriver.filterIgnoredPaths',
          command: 'git check-ignore',
          cwd,
          exitCode: result.exitCode,
          detail: result.stderr.trim() || 'git check-ignore failed',
        })
      }

      for (const ignoredPath of splitNullSeparatedPaths(result.stdout, result.stdoutTruncated))
      {
        ignoredPaths.add(ignoredPath)
      }
    }

    if (ignoredPaths.size === 0)
    {
      return relativePaths
    }

    return relativePaths.filter((relativePath) => !ignoredPaths.has(relativePath))
  })

  const initRepository: VcsDriver.VcsDriver['Service']['initRepository'] = (input) =>
    gitCommand(vcsProcess, 'GitVcsDriver.initRepository', input.cwd, ['init'], {
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024,
    }).pipe(Effect.asVoid)

  const resolveHeadCommit = (cwd: string) =>
    execute({
      operation: 'GitVcsDriver.checkpoints.resolveHeadCommit',
      cwd,
      args: ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'],
      allowNonZeroExit: true,
    }).pipe(
      Effect.map((result) =>
      {
        if (result.exitCode !== 0)
        {
          return null
        }
        const commit = result.stdout.trim()
        return commit.length > 0 ? commit : null
      }),
    )

  const hasHeadCommit = (cwd: string) =>
    execute({
      operation: 'GitVcsDriver.checkpoints.hasHeadCommit',
      cwd,
      args: ['rev-parse', '--verify', 'HEAD'],
      allowNonZeroExit: true,
    }).pipe(Effect.map((result) => result.exitCode === 0))

  const resolveWorktreeRoot = (cwd: string) =>
    execute({
      operation: 'GitVcsDriver.checkpoints.resolveWorktreeRoot',
      cwd,
      args: ['rev-parse', '--show-toplevel'],
    }).pipe(
      Effect.flatMap((result) =>
      {
        const root = result.stdout.trim()
        return root.length > 0
          ? Effect.succeed(root)
          : new VcsProcessExitError({
              operation: 'GitVcsDriver.checkpoints.resolveWorktreeRoot',
              command: 'git rev-parse --show-toplevel',
              cwd,
              exitCode: 0,
              detail: 'git rev-parse returned no worktree root.',
            })
      }),
    )

  const resolveCheckpointCommit = (cwd: string, checkpointRef: string) =>
    execute({
      operation: 'GitVcsDriver.checkpoints.resolveCheckpointCommit',
      cwd,
      args: ['rev-parse', '--verify', '--quiet', `${checkpointRef}^{commit}`],
      allowNonZeroExit: true,
    }).pipe(
      Effect.map((result) =>
      {
        if (result.exitCode !== 0)
        {
          return null
        }
        const commit = result.stdout.trim()
        return commit.length > 0 ? commit : null
      }),
    )

  const resolveRequiredCheckpointTarget = Effect.fn(
    'GitVcsDriver.checkpoints.resolveRequiredCheckpointTarget',
  )(function* (cwd: string, checkpointRef: string, operation: string)
  {
    const commitOid = yield* resolveCheckpointCommit(cwd, checkpointRef)
    if (commitOid === null)
    {
      return yield* new VcsProcessExitError({
        operation,
        command: 'git rev-parse',
        cwd,
        exitCode: 1,
        detail: `Checkpoint ref '${checkpointRef}' is unavailable.`,
      })
    }
    const treeResult = yield* execute({
      operation,
      cwd,
      args: ['rev-parse', '--verify', `${commitOid}^{tree}`],
    })
    return {
      commitOid,
      treeOid: treeResult.stdout.trim(),
      worktreeRoot: yield* resolveWorktreeRoot(cwd),
    }
  })

  const exactCheckpointOperation = <A>(
    operation: string,
    cwd: string,
    command: string,
    run: (signal: AbortSignal) => Promise<A>,
  ): Effect.Effect<A, VcsError> =>
    Effect.tryPromise({
      try: run,
      catch: (cause) =>
        new VcsProcessExitError({
          operation,
          command,
          cwd,
          exitCode: 1,
          detail: cause instanceof Error ? cause.message : `${command} failed.`,
        }),
    })

  const checkpoints: VcsDriver.VcsCheckpointOps & GitStagedCheckpointOps = {
    captureCheckpoint: Effect.fn('GitVcsDriver.checkpoints.captureCheckpoint')(function* (input)
    {
      const operation = 'GitVcsDriver.checkpoints.captureCheckpoint'
      const worktreeRoot = yield* resolveWorktreeRoot(input.cwd)
      const tempDirectory = yield* Effect.tryPromise({
        try: () => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), '456code-checkpoint-')),
        catch: (cause) =>
          new VcsProcessExitError({
            operation,
            command: 'create checkpoint storage',
            cwd: input.cwd,
            exitCode: 1,
            detail:
              cause instanceof Error ? cause.message : 'Could not create exact checkpoint storage.',
          }),
      })
      const tempIndexPath = NodePath.join(tempDirectory, 'index')
      const commitEnv: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: '456code',
        GIT_AUTHOR_EMAIL: '456code@users.noreply.github.com',
        GIT_COMMITTER_NAME: '456code',
        GIT_COMMITTER_EMAIL: '456code@users.noreply.github.com',
      }

      const cleanupTempDirectory = Effect.tryPromise({
        try: () => NodeFSP.rm(tempDirectory, { force: true, recursive: true }),
        catch: () => undefined,
      }).pipe(Effect.ignore)

      return yield* Effect.gen(function* ()
      {
        // read the ref before snapshotting so an unqualified capture publishes
        // against the state it actually captured from
        const expected: VcsDriver.VcsCheckpointRefExpectation =
          input.expected ??
          (yield* resolveCheckpointCommit(input.cwd, input.checkpointRef).pipe(
            Effect.map((commitOid): VcsDriver.VcsCheckpointRefExpectation =>
              commitOid === null ? { kind: 'absent' } : { kind: 'commit', commitOid },
            ),
          ))

        const snapshot = yield* Effect.tryPromise({
          try: (signal) =>
            captureExactGitSnapshot({
              repositoryRoot: worktreeRoot,
              indexPath: tempIndexPath,
              signal,
              limits: {
                maxFileCount: EXACT_GIT_SNAPSHOT_MAX_FILE_COUNT,
                maxByteCount: EXACT_GIT_SNAPSHOT_MAX_BYTE_COUNT,
              },
            }),
          catch: (cause) =>
            new VcsProcessExitError({
              operation,
              command: 'capture exact Git snapshot',
              cwd: input.cwd,
              exitCode: 1,
              detail:
                cause instanceof Error ? cause.message : 'Exact Git checkpoint capture failed.',
            }),
        })

        const message = `t3 checkpoint ref=${input.checkpointRef}`
        const commitTreeResult = yield* execute({
          operation,
          cwd: input.cwd,
          args: ['commit-tree', snapshot.treeOid, '-m', message],
          env: commitEnv,
        })
        const commitOid = commitTreeResult.stdout.trim()
        if (commitOid.length === 0)
        {
          return yield* new VcsProcessExitError({
            operation,
            command: 'git commit-tree',
            cwd: input.cwd,
            exitCode: 0,
            detail: 'git commit-tree returned an empty commit oid.',
          })
        }

        const publication = yield* execute({
          operation,
          cwd: input.cwd,
          args: ['update-ref', '--stdin'],
          stdin: checkpointPublicationTransaction(input.checkpointRef, commitOid, expected),
          allowNonZeroExit: true,
        })
        if (publication.exitCode !== 0)
        {
          if (matchesGitRefMarker(publication.stderr, CHECKPOINT_REF_RACE_MARKERS))
          {
            return {
              outcome: 'lost-race',
              commitOid,
            } satisfies VcsDriver.VcsCaptureCheckpointResult
          }
          return yield* new VcsProcessExitError({
            operation,
            command: 'git update-ref --stdin',
            cwd: input.cwd,
            exitCode: publication.exitCode,
            detail:
              publication.stderr.trim() ||
              `Could not publish checkpoint ref '${input.checkpointRef}'.`,
          })
        }

        return { outcome: 'published', commitOid } satisfies VcsDriver.VcsCaptureCheckpointResult
      }).pipe(Effect.ensuring(cleanupTempDirectory))
    }),

    hasCheckpointRef: (input) =>
      resolveCheckpointCommit(input.cwd, input.checkpointRef).pipe(
        Effect.map((commit) => commit !== null),
      ),

    restoreCheckpoint: Effect.fn('GitVcsDriver.checkpoints.restoreCheckpoint')(function* (input)
    {
      const operation = 'GitVcsDriver.checkpoints.restoreCheckpoint'

      let commitOid = yield* resolveCheckpointCommit(input.cwd, input.checkpointRef)
      let usedHeadFallback = false

      if (!commitOid && input.fallbackToHead === true)
      {
        commitOid = yield* resolveHeadCommit(input.cwd)
        usedHeadFallback = commitOid !== null
      }

      if (!commitOid)
      {
        return false
      }

      if (usedHeadFallback)
      {
        yield* execute({
          operation,
          cwd: input.cwd,
          args: ['restore', '--source', commitOid, '--worktree', '--staged', '--', '.'],
        })
        yield* execute({
          operation,
          cwd: input.cwd,
          args: ['clean', '-fd', '--', '.'],
        })
      }
      else
      {
        const worktreeRoot = yield* resolveWorktreeRoot(input.cwd)
        const treeResult = yield* execute({
          operation,
          cwd: input.cwd,
          args: ['rev-parse', '--verify', `${commitOid}^{tree}`],
        })
        const treeOid = treeResult.stdout.trim()
        yield* Effect.tryPromise({
          try: (signal) =>
            restoreExactGitTree({
              repositoryRoot: worktreeRoot,
              treeOid,
              signal,
              limits: {
                maxFileCount: EXACT_GIT_SNAPSHOT_MAX_FILE_COUNT,
                maxByteCount: EXACT_GIT_SNAPSHOT_MAX_BYTE_COUNT,
              },
            }),
          catch: (cause) =>
            new VcsProcessExitError({
              operation,
              command: 'restore exact Git checkpoint',
              cwd: input.cwd,
              exitCode: 1,
              detail:
                cause instanceof Error ? cause.message : 'Exact Git checkpoint restore failed.',
            }),
        })
      }

      const headExists = yield* hasHeadCommit(input.cwd)
      if (headExists)
      {
        yield* execute({
          operation,
          cwd: input.cwd,
          args: usedHeadFallback ? ['reset', '--quiet', '--', '.'] : ['read-tree', 'HEAD'],
        })
      }
      else if (!usedHeadFallback)
      {
        yield* execute({
          operation,
          cwd: input.cwd,
          args: ['read-tree', commitOid],
        })
      }

      return true
    }),

    diffCheckpoints: Effect.fn('GitVcsDriver.checkpoints.diffCheckpoints')(function* (input)
    {
      const operation = 'GitVcsDriver.checkpoints.diffCheckpoints'
      yield* Effect.annotateCurrentSpan({
        'checkpoint.cwd': input.cwd,
        'checkpoint.from_ref': input.fromCheckpointRef,
        'checkpoint.to_ref': input.toCheckpointRef,
        'checkpoint.ignore_whitespace': input.ignoreWhitespace,
        'checkpoint.fallback_from_to_head': input.fallbackFromToHead,
      })

      let fromRevision: string = input.fromCheckpointRef
      if (input.fallbackFromToHead === true)
      {
        const resolvedFromCommit = yield* resolveCheckpointCommit(
          input.cwd,
          input.fromCheckpointRef,
        )
        if (resolvedFromCommit)
        {
          fromRevision = resolvedFromCommit
        }
        else
        {
          const headCommit = yield* resolveHeadCommit(input.cwd)
          if (!headCommit)
          {
            return yield* new VcsProcessExitError({
              operation,
              command: 'git diff',
              cwd: input.cwd,
              exitCode: 1,
              detail: 'Checkpoint ref is unavailable for diff operation.',
            })
          }
          fromRevision = headCommit
        }
      }

      const result = yield* execute({
        operation,
        cwd: input.cwd,
        args: [
          'diff',
          '--patch',
          '--no-color',
          '--no-ext-diff',
          '--no-textconv',
          ...(input.ignoreWhitespace ? ['--ignore-all-space'] : []),
          `${fromRevision}^{commit}`,
          `${input.toCheckpointRef}^{commit}`,
        ],
        allowNonZeroExit: true,
        maxOutputBytes: CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
      })

      if (result.exitCode !== 0)
      {
        return yield* new VcsProcessExitError({
          operation,
          command: 'git diff',
          cwd: input.cwd,
          exitCode: result.exitCode,
          detail: result.stderr.trim() || 'Checkpoint ref is unavailable for diff operation.',
        })
      }

      return result.stdout
    }),

    deleteCheckpointRefs: Effect.fn('GitVcsDriver.checkpoints.deleteCheckpointRefs')(
      function* (input)
      {
        const operation = 'GitVcsDriver.checkpoints.deleteCheckpointRefs'
        // a ref that survives deletion is stale state the caller must retry on,
        // so only an already-absent ref is allowed to pass
        yield* Effect.forEach(
          input.checkpointRefs,
          (checkpointRef) =>
            execute({
              operation,
              cwd: input.cwd,
              args: ['update-ref', '-d', checkpointRef],
              allowNonZeroExit: true,
            }).pipe(
              Effect.flatMap((result) =>
                result.exitCode === 0 ||
                matchesGitRefMarker(result.stderr, CHECKPOINT_REF_ABSENT_MARKERS)
                  ? Effect.void
                  : new VcsProcessExitError({
                      operation,
                      command: 'git update-ref -d',
                      cwd: input.cwd,
                      exitCode: result.exitCode,
                      detail:
                        result.stderr.trim() ||
                        `Could not delete checkpoint ref '${checkpointRef}'.`,
                    }),
              ),
            ),
          { discard: true },
        )
      },
    ),

    stageCheckpointTree: Effect.fn('GitVcsDriver.checkpoints.stageCheckpointTree')(
      function* (input)
      {
        const operation = 'GitVcsDriver.checkpoints.stageCheckpointTree'
        const target = yield* resolveRequiredCheckpointTarget(input.cwd, input.ref, operation)
        yield* exactCheckpointOperation(
          operation,
          input.cwd,
          'materialize exact Git checkpoint tree',
          (signal) =>
            materializeExactGitTree({
              repositoryRoot: target.worktreeRoot,
              treeOid: target.treeOid,
              destinationRoot: input.stagePath,
              signal,
            }),
        )
        return yield* exactCheckpointOperation(
          operation,
          input.cwd,
          'verify exact Git checkpoint stage',
          (signal) =>
            verifyExactGitTreeMaterialization({
              repositoryRoot: target.worktreeRoot,
              treeOid: target.treeOid,
              rootPath: input.stagePath,
              signal,
            }),
        )
      },
    ),

    verifyRestorePreconditions: Effect.fn('GitVcsDriver.checkpoints.verifyRestorePreconditions')(
      function* (input)
      {
        const operation = 'GitVcsDriver.checkpoints.verifyRestorePreconditions'
        const target = yield* resolveRequiredCheckpointTarget(input.cwd, input.ref, operation)
        return yield* exactCheckpointOperation(
          operation,
          input.cwd,
          'preflight exact Git checkpoint restore',
          (signal) =>
            preflightExactGitTreeRestore({
              repositoryRoot: target.worktreeRoot,
              treeOid: target.treeOid,
              signal,
            }),
        )
      },
    ),

    applyStagedRestore: Effect.fn('GitVcsDriver.checkpoints.applyStagedRestore')(function* (input)
    {
      const operation = 'GitVcsDriver.checkpoints.applyStagedRestore'
      const target = yield* resolveRequiredCheckpointTarget(input.cwd, input.ref, operation)
      const restored = yield* exactCheckpointOperation(
        operation,
        input.cwd,
        'apply staged exact Git checkpoint restore',
        (signal) =>
          applyStagedExactGitTreeRestore({
            repositoryRoot: target.worktreeRoot,
            treeOid: target.treeOid,
            stageRoot: input.stagePath,
            signal,
          }),
      )

      const headExists = yield* hasHeadCommit(input.cwd)
      yield* execute({
        operation,
        cwd: input.cwd,
        args: headExists ? ['read-tree', 'HEAD'] : ['read-tree', target.commitOid],
      })
      return restored
    }),

    postVerifyRestore: Effect.fn('GitVcsDriver.checkpoints.postVerifyRestore')(function* (input)
    {
      const operation = 'GitVcsDriver.checkpoints.postVerifyRestore'
      const target = yield* resolveRequiredCheckpointTarget(input.cwd, input.ref, operation)
      const verification = yield* exactCheckpointOperation(
        operation,
        input.cwd,
        'verify exact Git checkpoint restore',
        (signal) =>
          verifyExactGitTreeRestore({
            repositoryRoot: target.worktreeRoot,
            treeOid: target.treeOid,
            signal,
          }),
      )
      const unmerged = yield* execute({
        operation,
        cwd: input.cwd,
        args: ['ls-files', '--unmerged'],
      })
      if (unmerged.stdout.trim().length > 0)
      {
        return yield* new VcsProcessExitError({
          operation,
          command: 'git ls-files --unmerged',
          cwd: input.cwd,
          exitCode: 1,
          detail: 'Restored checkpoint index contains unmerged entries.',
        })
      }
      const headExists = yield* hasHeadCommit(input.cwd)
      const indexDiff = yield* execute({
        operation,
        cwd: input.cwd,
        args: headExists
          ? ['diff', '--cached', '--quiet', '--no-ext-diff', '--no-textconv', 'HEAD', '--']
          : [
              'diff',
              '--cached',
              '--quiet',
              '--no-ext-diff',
              '--no-textconv',
              target.commitOid,
              '--',
            ],
        allowNonZeroExit: true,
      })
      if (indexDiff.exitCode !== 0)
      {
        return yield* new VcsProcessExitError({
          operation,
          command: 'git diff --cached --quiet',
          cwd: input.cwd,
          exitCode: indexDiff.exitCode,
          detail: indexDiff.stderr.trim() || 'Restored checkpoint index does not match policy.',
        })
      }
      return verification
    }),
  }

  return {
    capabilities,
    execute,
    checkpoints,
    detectRepository,
    isInsideWorkTree,
    listWorkspaceFiles,
    listRemotes,
    filterIgnoredPaths,
    initRepository,
  }
})

export const makeVcsDriver = Effect.gen(function* ()
{
  const driver = yield* makeVcsDriverShape()
  return VcsDriver.VcsDriver.of(driver)
})

export const make = Effect.gen(function* ()
{
  const git = yield* makeGitVcsDriverCore()
  return GitVcsDriver.of(git)
})

export const vcsLayer = Layer.effect(VcsDriver.VcsDriver, makeVcsDriver)
export const layer = Layer.effect(GitVcsDriver, make)
