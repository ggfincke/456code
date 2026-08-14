// apps/server/src/cartographer/DiffAnalysisService.ts
// resolves exact git comparisons and manages cached cartographer diff analyses

// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off

import * as NodeCrypto from 'node:crypto'
import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeProcess from 'node:process'

import {
  DiffAnalysisId,
  type DiffAnalysisError,
  type DiffAnalysisErrorCode,
  type DiffAnalysisGeneration,
  type DiffAnalysisSource,
} from '@t3tools/contracts'
import { parseGraphDiff, type GraphDiff } from '@t3tools/cartographer-core/server'
import { normalizeGitRemoteUrl } from '@t3tools/shared/git'
import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Ref from 'effect/Ref'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'
import * as Semaphore from 'effect/Semaphore'

import * as ServerConfig from '../config.ts'
import * as ServerEnvironment from '../environment/ServerEnvironment.ts'
import * as ProjectionSnapshotQuery from '../orchestration/Services/ProjectionSnapshotQuery.ts'
import { architectureComparisonGenerationDuration, withMetrics } from '../observability/Metrics.ts'
import * as DiffAnalysisGenerations from '../persistence/Services/DiffAnalysisGenerations.ts'
import { checkpointRefForThreadTurn } from '../checkpointing/Utils.ts'
import {
  captureExactGitSnapshot,
  EXACT_GIT_SNAPSHOT_MAX_BYTE_COUNT,
  EXACT_GIT_SNAPSHOT_MAX_FILE_COUNT,
  ExactGitSnapshotError,
  materializeExactGitTree,
} from '../vcs/ExactGitSnapshot.ts'
import * as GitVcsDriver from '../vcs/GitVcsDriver.ts'
import * as CartographerAnalyzer from './CartographerAnalyzer.ts'

export const DIFF_ANALYSIS_POLICY_VERSION = 'diff-analysis-v1'

const DIFF_ANALYSIS_TERMINAL_OBSERVATION_MS = 5 * 60 * 1_000
const DIFF_ANALYSIS_REPOSITORY_CAP_BYTES = 512 * 1024 * 1024
const DIFF_ANALYSIS_GLOBAL_CAP_BYTES = 2 * 1024 * 1024 * 1024
const DIFF_ANALYSIS_MAX_ARTIFACT_BYTES = 128 * 1024 * 1024
const DIFF_ANALYSIS_GIT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const DIFF_ANALYSIS_MAINTENANCE_INTERVAL = '1 minute'
const DIFF_ANALYSIS_ORPHAN_SWEEP_MAX_DIRECTORIES = 256
const DIFF_ANALYSIS_ORPHAN_SWEEP_BUDGET_MS = 250
export const DIFF_ANALYSIS_ORPHAN_SWEEP_GRACE_MS = 24 * 60 * 60 * 1_000
const SHA256_HEX = /^[0-9a-f]{64}$/u
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u
const DIFF_ANALYSIS_ROOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const SYNTHETIC_COMMIT_MESSAGE = '456code diff analysis tree'
const SYNTHETIC_COMMIT_DATE = '1970-01-01T00:00:00 +0000'

interface AnalyzerManifest
{
  readonly type: 'cartographer.analysis-ready'
  readonly version: 1
  readonly analyzerVersion: string
  readonly baseGraph: 'base.graph.json'
  readonly proposedGraph: 'proposed.graph.json'
  readonly impact: 'impact.json'
}

export interface DiffAnalysisOrphanSweepOptions
{
  readonly protectedIds: ReadonlySet<string>
  readonly cursor?: string
  readonly maxDirectories?: number
  readonly budgetMs?: number
  readonly graceMs?: number
  readonly now?: () => number
  readonly removeRoot?: (artifactRoot: string) => Promise<void>
}

export interface DiffAnalysisOrphanSweepFailure
{
  readonly artifactRoot: string
  readonly cause: unknown
}

export interface DiffAnalysisOrphanSweepReport
{
  readonly examined: number
  readonly removed: number
  readonly nextCursor: string | undefined
  readonly failures: ReadonlyArray<DiffAnalysisOrphanSweepFailure>
}

const AnalyzerManifestSchema = Schema.Struct({
  type: Schema.Literal('cartographer.analysis-ready'),
  version: Schema.Literal(1),
  analyzerVersion: Schema.String,
  baseGraph: Schema.Literal('base.graph.json'),
  proposedGraph: Schema.Literal('proposed.graph.json'),
  impact: Schema.Literal('impact.json'),
})
const decodeAnalyzerManifest = Schema.decodeUnknownSync(AnalyzerManifestSchema, {
  onExcessProperty: 'error',
})
const decodeJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)

type NormalizedSource =
  | {
      readonly _tag: 'checkpoint'
      readonly threadId: string
      readonly fromTurnCount: number
      readonly toTurnCount: number
    }
  | {
      readonly _tag: 'review'
      readonly cwd: string
      readonly kind: 'working-tree' | 'branch-range'
      readonly baseRef?: string
    }
  | {
      readonly _tag: 'treePair'
      readonly cwd: string
      readonly baseTreeOid: string
      readonly headTreeOid: string
    }
  | {
      readonly _tag: 'commitPair'
      readonly cwd: string
      readonly baseCommitOid: string
      readonly headCommitOid: string
    }

interface ResolvedRepository
{
  readonly root: string
  readonly repositoryKey: string
}

interface ResolvedSourceTrees
{
  readonly cwd: string
  readonly repositoryKey: string
  readonly source: DiffAnalysisSource
  readonly baseTreeOid: string
  readonly headTreeOid: string
  readonly baseAnalyzerRef: string
  readonly headAnalyzerRef: string
}

interface ResolvedDiffSource
  extends DiffAnalysisGenerations.DiffAnalysisCacheIdentity, ResolvedSourceTrees
  {}

export interface ReadyDiffAnalysisTarget
{
  readonly generation: DiffAnalysisGeneration
  readonly repositoryKey: string
  readonly headRoot: string
  readonly baseGraphPath: string
  readonly headGraphPath: string
  readonly impactPath: string
}

export interface ReadyDiffAnalysisImpactTarget
{
  readonly generation: DiffAnalysisGeneration
  readonly diff: GraphDiff | null
  readonly impactDigest: string
  readonly legacy: boolean
  readonly repositoryRoot: string
  readonly baseTreeOid: string
  readonly headTreeOid: string
  readonly baseGraphDigest: string
  readonly headGraphDigest: string
  readonly baseRoot: string | null
  readonly headRoot: string
}

// reads are addressed by target identity so an auto-computed analysis is
// observable without ever having been handed back an id
export interface DiffAnalysisTargetInput
{
  readonly workspaceRoot: string
  readonly source: DiffAnalysisSource
  readonly diffAnalysisId?: DiffAnalysisId
}

export interface RetainReadyDiffAnalysisInput
{
  readonly workspaceRoot: string
  readonly diffAnalysisId: DiffAnalysisId
}

export interface RetainReadyDiffAnalysisImpactInput extends RetainReadyDiffAnalysisInput
{
  readonly sourceSide?: 'base' | 'head'
}

export interface InspectDiffAnalysisInput
{
  readonly workspaceRoot: string
  readonly diffAnalysisId: DiffAnalysisId
}

export interface DiffAnalysisServiceShape
{
  readonly request: (
    input: DiffAnalysisTargetInput,
  ) => Effect.Effect<DiffAnalysisGeneration, DiffAnalysisError>
  readonly get: (
    input: DiffAnalysisTargetInput,
  ) => Effect.Effect<DiffAnalysisGeneration, DiffAnalysisError>
  readonly getById: (
    input: InspectDiffAnalysisInput,
  ) => Effect.Effect<DiffAnalysisGeneration, DiffAnalysisError>
  // open is operate-scoped and always follows a request/get, so it stays
  // id-addressed; only the read path needs target identity
  readonly retainReadyTarget: (
    input: RetainReadyDiffAnalysisInput,
  ) => Effect.Effect<ReadyDiffAnalysisTarget, DiffAnalysisError, Scope.Scope>
  readonly retainReadyImpactTarget: (
    input: RetainReadyDiffAnalysisImpactInput,
  ) => Effect.Effect<ReadyDiffAnalysisImpactTarget, DiffAnalysisError, Scope.Scope>
}

export class DiffAnalysisService extends Context.Service<
  DiffAnalysisService,
  DiffAnalysisServiceShape
>()('456code/cartographer/DiffAnalysisService')
{}

class DiffAnalysisFailure extends Data.TaggedError('DiffAnalysisError')<{
  readonly code: DiffAnalysisErrorCode
  readonly message: string
}>
{}

class DiffAnalysisCleanupError extends Data.TaggedError('DiffAnalysisCleanupError')<{
  readonly cause: unknown
}>
{}

function fail(
  code: DiffAnalysisErrorCode,
  message: string,
): Effect.Effect<never, DiffAnalysisError>
{
  return Effect.fail(new DiffAnalysisFailure({ code, message }) as DiffAnalysisError)
}

function sha256(value: string | Uint8Array): string
{
  return NodeCrypto.createHash('sha256').update(value).digest('hex')
}

function decodeManifest(stdout: string): AnalyzerManifest | null
{
  const line = stdout
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0)
  if (!line) return null
  try
  {
    return decodeAnalyzerManifest(decodeJson(line))
  }
  catch
  {
    return null
  }
}

function artifactObject(bytes: Uint8Array): Record<string, unknown> | null
{
  try
  {
    const value = decodeJson(Buffer.from(bytes).toString('utf8'))
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  }
  catch
  {
    return null
  }
}

function impactArtifactMatches(
  bytes: Uint8Array,
  expectedBaseGitRef: string,
  expectedHeadGitRef: string,
): boolean
{
  const value = artifactObject(bytes)
  if (value?.baseGitRef !== expectedBaseGitRef || value.headGitRef !== expectedHeadGitRef)
  {
    return false
  }
  try
  {
    parseGraphDiff(value)
    return true
  }
  catch
  {
    return false
  }
}

function impactLabelsMatch(
  bytes: Uint8Array,
  expectedBaseGitRef: string,
  expectedHeadGitRef: string,
): boolean
{
  const value = artifactObject(bytes)
  return value?.baseGitRef === expectedBaseGitRef && value.headGitRef === expectedHeadGitRef
}

// stem `impact` is labels-only; native `impact.graph-diff-v1` still requires GraphDiff
function impactStemMatches(
  bytes: Uint8Array,
  fileName: string,
  expectedBaseGitRef: string,
  expectedHeadGitRef: string,
): boolean
{
  return fileName.startsWith('impact.graph-diff-v1.')
    ? impactArtifactMatches(bytes, expectedBaseGitRef, expectedHeadGitRef)
    : impactLabelsMatch(bytes, expectedBaseGitRef, expectedHeadGitRef)
}

// the contract source is a discriminated union; normalization only trims and
// lowercases identity-bearing fields so cache keys stay stable
function normalizeSource(source: DiffAnalysisSource): NormalizedSource
{
  switch (source.sourceKind)
  {
    case 'checkpoint':
      return {
        _tag: 'checkpoint',
        threadId: source.threadId,
        fromTurnCount: source.fromTurnCount,
        toTurnCount: source.toTurnCount,
      }
    case 'review':
      return {
        _tag: 'review',
        cwd: source.cwd,
        kind: source.kind,
        ...(source.baseRef === undefined ? {} : { baseRef: source.baseRef }),
      }
    case 'tree-pair':
      return {
        _tag: 'treePair',
        cwd: source.cwd,
        baseTreeOid: source.baseTreeOid.toLowerCase(),
        headTreeOid: source.headTreeOid.toLowerCase(),
      }
    case 'commit-pair':
      return {
        _tag: 'commitPair',
        cwd: source.cwd,
        baseCommitOid: source.baseCommitOid.toLowerCase(),
        headCommitOid: source.headCommitOid.toLowerCase(),
      }
  }
}

function sourceDescriptorMatches(left: DiffAnalysisSource, right: DiffAnalysisSource): boolean
{
  const normalizedLeft = normalizeSource(left)
  const normalizedRight = normalizeSource(right)
  if (normalizedLeft._tag !== normalizedRight._tag) return false
  switch (normalizedLeft._tag)
  {
    case 'checkpoint':
      return (
        normalizedRight._tag === 'checkpoint' &&
        normalizedLeft.threadId === normalizedRight.threadId &&
        normalizedLeft.fromTurnCount === normalizedRight.fromTurnCount &&
        normalizedLeft.toTurnCount === normalizedRight.toTurnCount
      )
    case 'review':
      return (
        normalizedRight._tag === 'review' &&
        normalizedLeft.kind === normalizedRight.kind &&
        normalizedLeft.baseRef === normalizedRight.baseRef
      )
    case 'treePair':
      return (
        normalizedRight._tag === 'treePair' &&
        normalizedLeft.baseTreeOid === normalizedRight.baseTreeOid &&
        normalizedLeft.headTreeOid === normalizedRight.headTreeOid
      )
    case 'commitPair':
      return (
        normalizedRight._tag === 'commitPair' &&
        normalizedLeft.baseCommitOid === normalizedRight.baseCommitOid &&
        normalizedLeft.headCommitOid === normalizedRight.headCommitOid
      )
  }
}

function publicGeneration(
  row: DiffAnalysisGenerations.DiffAnalysisGenerationRecord,
  sourceCurrent: boolean,
): DiffAnalysisGeneration
{
  return {
    version: 1,
    diffAnalysisId: row.diffAnalysisId,
    sourceKind: row.source.sourceKind,
    state: row.state,
    baseTreeOid: row.baseTreeOid,
    headTreeOid: row.headTreeOid,
    analyzerVersion: row.analyzerVersion,
    analysisPolicyVersion: row.analysisPolicyVersion,
    sourceCurrent,
    baseGraphArtifact:
      row.baseGraphPath === null ? null : `diff-analysis:${row.diffAnalysisId}:base-graph`,
    headGraphArtifact:
      row.headGraphPath === null ? null : `diff-analysis:${row.diffAnalysisId}:head-graph`,
    impactArtifact: row.impactPath === null ? null : `diff-analysis:${row.diffAnalysisId}:impact`,
    artifactByteLength: row.artifactByteLength,
    errorCode: row.errorCode,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastAccessedAt: row.lastAccessedAt,
  }
}

async function digestMaterializedRoot(root: string): Promise<string>
{
  const digest = NodeCrypto.createHash('sha256')
  let entryCount = 0
  let contentBytes = 0

  const visit = async (directory: string, relativeDirectory: string): Promise<void> =>
  {
    const entries = await NodeFSP.readdir(directory, { withFileTypes: true })
    entries.sort((left, right) =>
      Buffer.compare(Buffer.from(left.name, 'utf8'), Buffer.from(right.name, 'utf8')),
    )
    for (const entry of entries)
    {
      entryCount += 1
      if (entryCount > EXACT_GIT_SNAPSHOT_MAX_FILE_COUNT * 2)
      {
        throw new Error('materialized diff tree has too many entries')
      }
      const relativePath =
        relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`
      const absolutePath = NodePath.join(directory, entry.name)
      const info = await NodeFSP.lstat(absolutePath)
      const pathBytes = Buffer.from(relativePath, 'utf8')
      let kind: string
      let mode: string
      let payload = new Uint8Array()
      if (info.isDirectory())
      {
        kind = 'directory'
        mode = '040000'
      }
      else if (info.isFile())
      {
        kind = 'file'
        mode = info.mode & 0o111 ? '100755' : '100644'
        payload = await NodeFSP.readFile(absolutePath)
      }
      else if (info.isSymbolicLink())
      {
        kind = 'symlink'
        mode = '120000'
        payload = await NodeFSP.readlink(absolutePath, { encoding: 'buffer' })
      }
      else
      {
        throw new Error(`materialized diff tree contains a special entry at '${relativePath}'`)
      }
      contentBytes += payload.byteLength
      if (contentBytes > EXACT_GIT_SNAPSHOT_MAX_BYTE_COUNT)
      {
        throw new Error('materialized diff tree is too large')
      }
      digest.update(`${kind}\0${mode}\0${pathBytes.byteLength}\0`)
      digest.update(pathBytes)
      digest.update(`\0${payload.byteLength}\0`)
      digest.update(payload)
      if (info.isDirectory()) await visit(absolutePath, relativePath)
    }
  }

  await visit(root, '')
  return digest.digest('hex')
}

async function assertManagedAnalysesRoot(analysesRoot: string): Promise<void>
{
  await NodeFSP.mkdir(analysesRoot, { recursive: true })
  const stat = await NodeFSP.lstat(analysesRoot)
  if (!stat.isDirectory() || stat.isSymbolicLink())
  {
    throw new Error('diff analysis storage root is not a managed directory')
  }
}

// reconciles only aged direct children and carries a cursor across bounded periodic passes
export async function reconcileOrphanedDiffAnalysisRoots(
  analysesRoot: string,
  options: DiffAnalysisOrphanSweepOptions,
): Promise<DiffAnalysisOrphanSweepReport>
{
  const resolvedRoot = NodePath.resolve(analysesRoot)
  const maxDirectories = options.maxDirectories ?? DIFF_ANALYSIS_ORPHAN_SWEEP_MAX_DIRECTORIES
  const budgetMs = options.budgetMs ?? DIFF_ANALYSIS_ORPHAN_SWEEP_BUDGET_MS
  const graceMs = options.graceMs ?? DIFF_ANALYSIS_ORPHAN_SWEEP_GRACE_MS
  const now = options.now ?? Date.now
  const removeRoot =
    options.removeRoot ??
    ((artifactRoot: string) =>
      NodeFSP.rm(artifactRoot, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 25,
      }))

  await assertManagedAnalysesRoot(resolvedRoot)
  const directories = (await NodeFSP.readdir(resolvedRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && DIFF_ANALYSIS_ROOT_ID.test(entry.name))
    .toSorted((left, right) => left.name.localeCompare(right.name))
  const cursor = options.cursor
  const nextIndex =
    cursor === undefined
      ? 0
      : directories.findIndex((entry) => entry.name.localeCompare(cursor) > 0)
  // a removed/end cursor wraps immediately; insertions before it are picked up on this pass
  const startIndex = nextIndex < 0 ? 0 : nextIndex

  const startedAt = now()
  const failures: DiffAnalysisOrphanSweepFailure[] = []
  let examined = 0
  let removed = 0
  let index = startIndex
  let lastExamined: string | undefined
  while (index < directories.length && examined < maxDirectories && now() - startedAt < budgetMs)
  {
    const entry = directories[index]!
    index += 1
    examined += 1
    lastExamined = entry.name
    if (options.protectedIds.has(entry.name))
    {
      continue
    }

    const artifactRoot = NodePath.resolve(NodePath.join(resolvedRoot, entry.name))
    const relative = NodePath.relative(resolvedRoot, artifactRoot)
    if (relative.startsWith('..') || NodePath.isAbsolute(relative))
    {
      continue
    }
    let stat: Awaited<ReturnType<typeof NodeFSP.lstat>>
    try
    {
      stat = await NodeFSP.lstat(artifactRoot)
    }
    catch (cause)
    {
      failures.push({ artifactRoot, cause })
      continue
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || now() - stat.mtimeMs < graceMs)
    {
      continue
    }
    try
    {
      await removeRoot(artifactRoot)
      removed += 1
    }
    catch (cause)
    {
      failures.push({ artifactRoot, cause })
    }
  }

  return {
    examined,
    removed,
    nextCursor: index < directories.length ? lastExamined : undefined,
    failures,
  }
}

export const make = Effect.gen(function* ()
{
  const analyzer = yield* CartographerAnalyzer.CartographerAnalyzer
  const config = yield* ServerConfig.ServerConfig
  const environment = yield* ServerEnvironment.ServerEnvironment
  const projection = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery
  const repository = yield* DiffAnalysisGenerations.DiffAnalysisGenerationRepository
  const git = yield* GitVcsDriver.GitVcsDriver
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const serviceClosing = yield* Ref.make(false)
  const serviceLifecycle = yield* Semaphore.make(1)
  const workerScope = yield* Effect.acquireRelease(Scope.make('sequential'), (scope) =>
    serviceLifecycle.withPermit(
      Effect.gen(function* ()
      {
        yield* Ref.set(serviceClosing, true)
        // let runnable workers settle at their cancellation boundary before closing their scope
        yield* Effect.yieldNow
        yield* Scope.close(scope, Exit.void)
      }),
    ),
  )
  const leases = yield* Ref.make(new Map<string, number>())
  const orphanSweepCursor = yield* Ref.make<string | undefined>(undefined)
  const analysesRoot = path.resolve(path.join(config.stateDir, 'cartographer', 'diff-analyses'))

  const persistenceFailure = (operation: string) => () =>
    fail('persistence-failed', `${operation} could not persist diff analysis state.`)

  const cleanupArtifactRoot = (artifactRoot: string) =>
  {
    const resolved = path.resolve(artifactRoot)
    if (!resolved.startsWith(`${analysesRoot}${path.sep}`)) return Effect.void
    return Effect.tryPromise({
      try: async () =>
      {
        await assertManagedAnalysesRoot(analysesRoot)
        await NodeFSP.rm(resolved, { recursive: true, force: true, maxRetries: 3 })
      },
      catch: (cause) => new DiffAnalysisCleanupError({ cause }),
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning('diff analysis artifact cleanup failed; reconciliation will retry', {
          artifactRoot: resolved,
          cause: error.cause,
        }),
      ),
    )
  }

  const canonicalizePath = (value: string) =>
  {
    const resolved = path.resolve(value)
    return fileSystem.realPath(resolved).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
        {
          if (cause.reason._tag === 'NotFound') return Effect.succeed(resolved)
          return fail('invalid-source', 'The diff analysis workspace path could not be resolved.')
        },
      }),
    )
  }

  const isWithinRoot = (candidate: string, root: string) =>
  {
    const relative = path.relative(root, candidate)
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  }

  const assertWorkspaceBoundCwd = Effect.fn('DiffAnalysisService.assertWorkspaceBoundCwd')(
    function* (cwd: string)
    {
      const [candidate, workspaceRoot, worktreesRoot] = yield* Effect.all([
        canonicalizePath(cwd),
        canonicalizePath(config.cwd),
        canonicalizePath(config.worktreesDir),
      ])
      if (isWithinRoot(candidate, workspaceRoot) || isWithinRoot(candidate, worktreesRoot))
      {
        return candidate
      }
      return yield* fail(
        'invalid-source',
        'Diff analysis cwd must stay within the configured workspace roots.',
      )
    },
  )

  const runGit = Effect.fn('DiffAnalysisService.runGit')(function* (
    cwd: string,
    args: ReadonlyArray<string>,
    options: {
      readonly allowNonZeroExit?: boolean
      readonly env?: NodeJS.ProcessEnv
      readonly stdin?: string
    } = {},
  )
  {
    return yield* git
      .execute({
        operation: 'DiffAnalysisService.git',
        cwd,
        args,
        ...(options.allowNonZeroExit ? { allowNonZeroExit: true } : {}),
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
        timeoutMs: 30_000,
        maxOutputBytes: DIFF_ANALYSIS_GIT_MAX_OUTPUT_BYTES,
      })
      .pipe(
        withMetrics({ timer: architectureComparisonGenerationDuration }),
        Effect.mapError(
          () =>
            new DiffAnalysisFailure({
              code: 'repository-identity-failed',
              message: 'Git could not resolve the diff analysis source.',
            }) as DiffAnalysisError,
        ),
      )
  })

  const resolveRepository = Effect.fn('DiffAnalysisService.resolveRepository')(function* (
    cwd: string,
  )
  {
    const rootResult = yield* runGit(cwd, ['rev-parse', '--show-toplevel'], {
      allowNonZeroExit: true,
    })
    const root = rootResult.stdout.trim()
    if (rootResult.exitCode !== 0 || root.length === 0)
    {
      return yield* fail('not-git-repository', 'Diff analysis requires a Git worktree.')
    }
    const commonDir = (yield* runGit(root, ['rev-parse', '--git-common-dir'])).stdout.trim()
    const resolvedCommonDir = path.resolve(root, commonDir)
    const remoteNames = (yield* runGit(root, ['remote'], { allowNonZeroExit: true })).stdout
      .split('\n')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .toSorted()
    const remoteName = remoteNames.includes('upstream')
      ? 'upstream'
      : remoteNames.includes('origin')
        ? 'origin'
        : remoteNames[0]
    if (remoteName)
    {
      const remoteUrl = (yield* runGit(root, ['remote', 'get-url', remoteName])).stdout.trim()
      return { root, repositoryKey: normalizeGitRemoteUrl(remoteUrl) } satisfies ResolvedRepository
    }
    return {
      root,
      repositoryKey: `local-git:${sha256(resolvedCommonDir)}`,
    } satisfies ResolvedRepository
  })

  const verifyTreeOid = Effect.fn('DiffAnalysisService.verifyTreeOid')(function* (
    cwd: string,
    treeOid: string,
  )
  {
    if (!GIT_OBJECT_ID.test(treeOid))
    {
      return yield* fail('tree-object-missing', 'A diff tree OID is invalid.')
    }
    const result = yield* runGit(cwd, ['cat-file', '-t', treeOid], { allowNonZeroExit: true })
    if (result.exitCode !== 0 || result.stdout.trim() !== 'tree')
    {
      return yield* fail(
        'tree-object-missing',
        'A requested diff tree does not exist in the repository.',
      )
    }
    return treeOid
  })

  const syntheticCommit = Effect.fn('DiffAnalysisService.syntheticCommit')(function* (
    cwd: string,
    treeOid: string,
  )
  {
    const result = yield* runGit(cwd, ['commit-tree', treeOid, '-m', SYNTHETIC_COMMIT_MESSAGE], {
      env: {
        ...NodeProcess.env,
        GIT_AUTHOR_NAME: '456code',
        GIT_AUTHOR_EMAIL: '456code@users.noreply.github.com',
        GIT_COMMITTER_NAME: '456code',
        GIT_COMMITTER_EMAIL: '456code@users.noreply.github.com',
        GIT_AUTHOR_DATE: SYNTHETIC_COMMIT_DATE,
        GIT_COMMITTER_DATE: SYNTHETIC_COMMIT_DATE,
      },
    })
    const commitOid = result.stdout.trim()
    if (!GIT_OBJECT_ID.test(commitOid))
    {
      return yield* fail(
        'materialization-failed',
        'Git did not create a deterministic comparison commit.',
      )
    }
    return commitOid
  })

  const treeDigests = Effect.fn('DiffAnalysisService.treeDigests')(function* (
    cwd: string,
    baseTreeOid: string,
    headTreeOid: string,
  )
  {
    const readCandidates = Effect.fn('DiffAnalysisService.readDigestCandidates')(function* (
      role: 'base' | 'head',
      treeOid: string,
    )
    {
      const output = yield* runGit(cwd, ['ls-tree', '-z', treeOid], {
        env: { ...NodeProcess.env, GIT_LITERAL_PATHSPECS: '1' },
      })
      return output.stdout.split('\0').flatMap((record) =>
      {
        const match = /^\d+ blob ([0-9a-f]{40,64})\t([^/]+)$/u.exec(record)
        if (!match) return []
        const candidatePath = match[2]!
        if (
          candidatePath !== '.cartographer.json' &&
          candidatePath !== '.cartographer.annotations.json' &&
          !/^tsconfig.*\.json$/u.test(candidatePath)
        )
        {
          return []
        }
        return [{ role, path: candidatePath, oid: match[1]! }]
      })
    })
    const candidates = (yield* Effect.all([
      readCandidates('base', baseTreeOid),
      readCandidates('head', headTreeOid),
    ])).flat()
    const digestFor = (predicate: (candidatePath: string) => boolean) =>
      sha256(
        candidates
          .filter((candidate) => predicate(candidate.path))
          .map((candidate) => `${candidate.role}:${candidate.path}\0${candidate.oid}`)
          .toSorted()
          .join('\0'),
      )
    return {
      configDigest: digestFor((candidatePath) => candidatePath === '.cartographer.json'),
      scopeDigest: digestFor((candidatePath) => candidatePath === '.cartographer.annotations.json'),
      tsconfigDigest: digestFor((candidatePath) => /^tsconfig.*\.json$/u.test(candidatePath)),
    }
  })

  const resolveCheckpointSource = Effect.fn('DiffAnalysisService.resolveCheckpointSource')(
    function* (
      source: DiffAnalysisSource,
      normalized: Extract<NormalizedSource, { _tag: 'checkpoint' }>,
    )
    {
      const context = yield* projection
        .getThreadCheckpointContext(normalized.threadId as never)
        .pipe(
          Effect.mapError(
            () =>
              new DiffAnalysisFailure({
                code: 'persistence-failed',
                message: 'Checkpoint context could not be read.',
              }) as DiffAnalysisError,
          ),
        )
      if (Option.isNone(context))
      {
        return yield* fail('thread-not-found', 'The checkpoint source thread was not found.')
      }
      const cwd = context.value.worktreePath ?? context.value.workspaceRoot
      const resolvedRepository = yield* resolveRepository(cwd)
      const resolveRef = Effect.fn('DiffAnalysisService.resolveCheckpointRef')(function* (
        turnCount: number,
      )
      {
        const checkpointRef = checkpointRefForThreadTurn(normalized.threadId as never, turnCount)
        const result = yield* runGit(
          cwd,
          ['rev-parse', '--verify', '--quiet', `${checkpointRef}^{commit}`],
          {
            allowNonZeroExit: true,
          },
        )
        const commitOid = result.stdout.trim()
        if (result.exitCode !== 0 || !GIT_OBJECT_ID.test(commitOid))
        {
          return yield* fail(
            'checkpoint-ref-missing',
            `Checkpoint ref for turn ${turnCount} is no longer available.`,
          )
        }
        const treeOid = (yield* runGit(cwd, [
          'rev-parse',
          '--verify',
          `${commitOid}^{tree}`,
        ])).stdout.trim()
        return { commitOid, treeOid }
      })
      const [base, head] = yield* Effect.all([
        resolveRef(normalized.fromTurnCount),
        resolveRef(normalized.toTurnCount),
      ])
      return {
        cwd: resolvedRepository.root,
        repositoryKey: resolvedRepository.repositoryKey,
        source,
        baseTreeOid: base.treeOid,
        headTreeOid: head.treeOid,
        baseAnalyzerRef: base.commitOid,
        headAnalyzerRef: head.commitOid,
      }
    },
  )

  const captureWorkingTree = Effect.fn('DiffAnalysisService.captureWorkingTree')(function* (
    cwd: string,
  )
  {
    return yield* Effect.tryPromise({
      try: async (signal) =>
      {
        const temporaryRoot = await NodeFSP.mkdtemp(
          NodePath.join(NodeOS.tmpdir(), '456code-diff-analysis-index-'),
        )
        try
        {
          return await captureExactGitSnapshot({
            repositoryRoot: cwd,
            indexPath: NodePath.join(temporaryRoot, 'index'),
            signal,
            limits: {
              maxFileCount: EXACT_GIT_SNAPSHOT_MAX_FILE_COUNT,
              maxByteCount: EXACT_GIT_SNAPSHOT_MAX_BYTE_COUNT,
            },
          })
        }
        finally
        {
          await NodeFSP.rm(temporaryRoot, { recursive: true, force: true })
        }
      },
      catch: (cause) =>
      {
        const code: DiffAnalysisErrorCode =
          cause instanceof ExactGitSnapshotError
            ? cause.code === 'limit-exceeded'
              ? 'limit-exceeded'
              : cause.code === 'dirty-submodule'
                ? 'dirty-submodule'
                : cause.code === 'unsupported-entry'
                  ? 'unsupported'
                  : 'materialization-failed'
            : 'materialization-failed'
        return new DiffAnalysisFailure({
          code,
          message: 'The working tree could not be captured exactly.',
        }) as DiffAnalysisError
      },
    })
  })

  const resolveReviewSource = Effect.fn('DiffAnalysisService.resolveReviewSource')(function* (
    source: DiffAnalysisSource,
    normalized: Extract<NormalizedSource, { _tag: 'review' }>,
  )
  {
    const boundedCwd = yield* assertWorkspaceBoundCwd(normalized.cwd)
    const resolvedRepository = yield* resolveRepository(boundedCwd)
    if (normalized.kind === 'branch-range')
    {
      if (normalized.baseRef !== undefined)
      {
        const baseRef = yield* runGit(
          resolvedRepository.root,
          ['rev-parse', '--verify', '--quiet', `${normalized.baseRef}^{commit}`],
          { allowNonZeroExit: true },
        )
        if (baseRef.exitCode !== 0)
        {
          return yield* fail('base-ref-missing', 'The branch-range base ref was not found.')
        }
      }
      const range = yield* git
        .resolveBranchRange({
          cwd: resolvedRepository.root,
          ...(normalized.baseRef === undefined ? {} : { baseRef: normalized.baseRef }),
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new DiffAnalysisFailure({
                code:
                  error.operation === 'GitVcsDriver.resolveBranchRange.baseRef'
                    ? 'base-ref-missing'
                    : 'merge-base-missing',
                message: 'The branch-range merge base could not be resolved.',
              }) as DiffAnalysisError,
          ),
        )
      return {
        cwd: resolvedRepository.root,
        repositoryKey: resolvedRepository.repositoryKey,
        source,
        baseTreeOid: range.baseTreeOid,
        headTreeOid: range.headTreeOid,
        baseAnalyzerRef: range.mergeBaseCommitOid,
        headAnalyzerRef: range.headCommitOid,
      }
    }

    const snapshot = yield* captureWorkingTree(resolvedRepository.root)
    let baseTreeOid: string
    let baseAnalyzerRef: string
    if (snapshot.headOid === null)
    {
      baseTreeOid = (yield* runGit(resolvedRepository.root, ['mktree'], {
        stdin: '',
      })).stdout.trim()
      baseAnalyzerRef = yield* syntheticCommit(resolvedRepository.root, baseTreeOid)
    }
    else
    {
      baseAnalyzerRef = snapshot.headOid
      baseTreeOid = (yield* runGit(resolvedRepository.root, [
        'rev-parse',
        '--verify',
        `${snapshot.headOid}^{tree}`,
      ])).stdout.trim()
    }
    return {
      cwd: resolvedRepository.root,
      repositoryKey: resolvedRepository.repositoryKey,
      source,
      baseTreeOid,
      headTreeOid: snapshot.treeOid,
      baseAnalyzerRef,
      headAnalyzerRef: yield* syntheticCommit(resolvedRepository.root, snapshot.treeOid),
    }
  })

  const resolveTreePairSource = Effect.fn('DiffAnalysisService.resolveTreePairSource')(function* (
    source: DiffAnalysisSource,
    normalized: Extract<NormalizedSource, { _tag: 'treePair' }>,
  )
  {
    const boundedCwd = yield* assertWorkspaceBoundCwd(normalized.cwd)
    const resolvedRepository = yield* resolveRepository(boundedCwd)
    const [baseTreeOid, headTreeOid] = yield* Effect.all([
      verifyTreeOid(resolvedRepository.root, normalized.baseTreeOid),
      verifyTreeOid(resolvedRepository.root, normalized.headTreeOid),
    ])
    const [baseAnalyzerRef, headAnalyzerRef] = yield* Effect.all([
      syntheticCommit(resolvedRepository.root, baseTreeOid),
      syntheticCommit(resolvedRepository.root, headTreeOid),
    ])
    return {
      cwd: resolvedRepository.root,
      repositoryKey: resolvedRepository.repositoryKey,
      source,
      baseTreeOid,
      headTreeOid,
      baseAnalyzerRef,
      headAnalyzerRef,
    }
  })

  const resolveCommitPairSource = Effect.fn('DiffAnalysisService.resolveCommitPairSource')(
    function* (
      source: DiffAnalysisSource,
      normalized: Extract<NormalizedSource, { _tag: 'commitPair' }>,
    )
    {
      const boundedCwd = yield* assertWorkspaceBoundCwd(normalized.cwd)
      const resolvedRepository = yield* resolveRepository(boundedCwd)
      const resolveCommit = Effect.fn('DiffAnalysisService.resolveCommitPairCommit')(function* (
        commitOid: string,
      )
      {
        if (!GIT_OBJECT_ID.test(commitOid))
        {
          return yield* fail('tree-object-missing', 'A diff commit OID is invalid.')
        }
        const commit = yield* runGit(
          resolvedRepository.root,
          ['rev-parse', '--verify', '--quiet', `${commitOid}^{commit}`],
          { allowNonZeroExit: true },
        )
        if (commit.exitCode !== 0 || commit.stdout.trim() !== commitOid)
        {
          return yield* fail(
            'tree-object-missing',
            'A requested diff commit does not exist in the repository.',
          )
        }
        const treeOid = (yield* runGit(resolvedRepository.root, [
          'rev-parse',
          '--verify',
          `${commitOid}^{tree}`,
        ])).stdout.trim()
        return { commitOid, treeOid }
      })
      const [base, head] = yield* Effect.all([
        resolveCommit(normalized.baseCommitOid),
        resolveCommit(normalized.headCommitOid),
      ])
      return {
        cwd: resolvedRepository.root,
        repositoryKey: resolvedRepository.repositoryKey,
        source,
        baseTreeOid: base.treeOid,
        headTreeOid: head.treeOid,
        baseAnalyzerRef: base.commitOid,
        headAnalyzerRef: head.commitOid,
      }
    },
  )

  const resolveSource = Effect.fn('DiffAnalysisService.resolveSource')(function* (
    source: DiffAnalysisSource,
  )
  {
    const normalized = normalizeSource(source)
    let resolved: ResolvedSourceTrees
    if (normalized._tag === 'checkpoint')
    {
      resolved = yield* resolveCheckpointSource(source, normalized)
    }
    else if (normalized._tag === 'review')
    {
      resolved = yield* resolveReviewSource(source, normalized)
    }
    else if (normalized._tag === 'treePair')
    {
      resolved = yield* resolveTreePairSource(source, normalized)
    }
    else
    {
      resolved = yield* resolveCommitPairSource(source, normalized)
    }
    const identity = yield* analyzer.identify.pipe(
      Effect.mapError(
        () =>
          new DiffAnalysisFailure({
            code: 'unsupported',
            message: 'Cartographer analysis is unavailable.',
          }) as DiffAnalysisError,
      ),
    )
    const digests = yield* treeDigests(resolved.cwd, resolved.baseTreeOid, resolved.headTreeOid)
    return {
      ...resolved,
      environmentId: yield* environment.getEnvironmentId,
      analyzerVersion: identity.fingerprint,
      analysisPolicyVersion: DIFF_ANALYSIS_POLICY_VERSION,
      ...digests,
    } satisfies ResolvedDiffSource
  })

  const authorizeRepository = Effect.fn('DiffAnalysisService.authorizeRepository')(function* (
    workspaceRoot: string,
    repositoryKey: string,
  )
  {
    const ownerRepository = yield* resolveRepository(workspaceRoot)
    if (ownerRepository.repositoryKey !== repositoryKey)
    {
      return yield* fail(
        'repository-out-of-scope',
        'The diff analysis repository does not belong to this owner.',
      )
    }
  })

  const resolveAuthorizedSource = Effect.fn('DiffAnalysisService.resolveAuthorizedSource')(
    function* (input: DiffAnalysisTargetInput)
    {
      const resolved = yield* resolveSource(input.source)
      yield* authorizeRepository(input.workspaceRoot, resolved.repositoryKey)
      return resolved
    },
  )

  const authorizeStoredRow = Effect.fn('DiffAnalysisService.authorizeStoredRow')(function* (
    workspaceRoot: string,
    row: DiffAnalysisGenerations.DiffAnalysisGenerationRecord,
  )
  {
    if (row.environmentId !== (yield* environment.getEnvironmentId))
    {
      return yield* fail('repository-out-of-scope', 'Diff analysis was not found.')
    }
    const ownerRepository = yield* resolveRepository(workspaceRoot)
    if (ownerRepository.repositoryKey !== row.repositoryKey)
    {
      return yield* fail(
        'repository-out-of-scope',
        'The diff analysis repository does not belong to this owner.',
      )
    }
    return ownerRepository
  })

  const updateRow = Effect.fn('DiffAnalysisService.updateRow')(function* (
    row: DiffAnalysisGenerations.DiffAnalysisGenerationRecord,
    patch: Partial<
      Pick<
        DiffAnalysisGenerations.DiffAnalysisGenerationRecord,
        | 'state'
        | 'headRootPath'
        | 'baseGraphPath'
        | 'headGraphPath'
        | 'impactPath'
        | 'artifactByteLength'
        | 'errorCode'
      >
    >,
  )
  {
    const updatedAt = DateTime.formatIso(yield* DateTime.now)
    const next = { ...row, ...patch, updatedAt }
    return yield* repository
      .update({
        diffAnalysisId: next.diffAnalysisId,
        state: next.state,
        headRootPath: next.headRootPath,
        baseGraphPath: next.baseGraphPath,
        headGraphPath: next.headGraphPath,
        impactPath: next.impactPath,
        artifactByteLength: next.artifactByteLength,
        errorCode: next.errorCode,
        updatedAt,
      })
      .pipe(Effect.catch(persistenceFailure('DiffAnalysisService.updateRow')))
  })

  const materializeTree = Effect.fn('DiffAnalysisService.materializeTree')(function* (
    cwd: string,
    treeOid: string,
    destination: string,
  )
  {
    return yield* Effect.tryPromise({
      try: (signal) =>
        materializeExactGitTree({
          repositoryRoot: cwd,
          treeOid,
          destinationRoot: destination,
          signal,
          limits: {
            maxFileCount: EXACT_GIT_SNAPSHOT_MAX_FILE_COUNT,
            maxByteCount: EXACT_GIT_SNAPSHOT_MAX_BYTE_COUNT,
          },
        }),
      catch: (cause) =>
        new DiffAnalysisFailure({
          code:
            cause instanceof ExactGitSnapshotError && cause.code === 'limit-exceeded'
              ? 'limit-exceeded'
              : 'materialization-failed',
          message: 'An exact diff tree could not be materialized.',
        }) as DiffAnalysisError,
    })
  })

  const sealArtifact = Effect.fn('DiffAnalysisService.sealArtifact')(function* (
    artifactRoot: string,
    sourcePath: string,
    stem: string,
    identityMatches: (bytes: Uint8Array) => boolean,
    rootDigest?: string,
  )
  {
    const artifact = yield* Effect.tryPromise({
      try: async () =>
      {
        const info = await NodeFSP.lstat(sourcePath)
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          info.size > DIFF_ANALYSIS_MAX_ARTIFACT_BYTES
        )
        {
          throw new Error('diff artifact is not a bounded regular file')
        }
        const bytes = await NodeFSP.readFile(sourcePath)
        if (bytes.byteLength !== info.size) throw new Error('diff artifact changed during sealing')
        return { bytes, digest: sha256(bytes) }
      },
      catch: () =>
        new DiffAnalysisFailure({
          code: 'artifact-invalid',
          message: 'Cartographer did not produce every required diff artifact.',
        }) as DiffAnalysisError,
    })
    if (!identityMatches(artifact.bytes))
    {
      return yield* fail(
        'artifact-invalid',
        'Cartographer artifacts do not match the requested comparison labels.',
      )
    }
    const sealedPath = path.join(
      artifactRoot,
      `${stem}.${artifact.digest}${rootDigest === undefined ? '' : `.${rootDigest}`}.json`,
    )
    yield* Effect.tryPromise({
      try: () => NodeFSP.rename(sourcePath, sealedPath),
      catch: () =>
        new DiffAnalysisFailure({
          code: 'artifact-invalid',
          message: 'A diff artifact could not be sealed.',
        }) as DiffAnalysisError,
    })
    return { path: sealedPath, byteLength: artifact.bytes.byteLength }
  })

  const deleteRowBeforeRoot = Effect.fn('DiffAnalysisService.deleteRowBeforeRoot')(function* (
    row: DiffAnalysisGenerations.DiffAnalysisGenerationRecord,
  )
  {
    const claimed = yield* Ref.modify(leases, (current) =>
    {
      const count = current.get(row.diffAnalysisId) ?? 0
      if (count !== 0) return [false, current] as const
      const next = new Map(current)
      next.set(row.diffAnalysisId, -1)
      return [true, next] as const
    })
    if (!claimed) return false
    return yield* Effect.gen(function* ()
    {
      const deleted = yield* repository
        .deleteIfUnchanged({
          diffAnalysisId: row.diffAnalysisId,
          state: row.state,
          updatedAt: row.updatedAt,
          lastAccessedAt: row.lastAccessedAt,
        })
        .pipe(Effect.catch(persistenceFailure('DiffAnalysisService.deleteRow')))
      if (deleted) yield* cleanupArtifactRoot(row.artifactRoot)
      return deleted
    }).pipe(
      Effect.ensuring(
        Ref.update(leases, (current) =>
        {
          const next = new Map(current)
          if (next.get(row.diffAnalysisId) === -1) next.delete(row.diffAnalysisId)
          return next
        }),
      ),
    )
  })

  const evictToCap = Effect.fn('DiffAnalysisService.evictToCap')(function* (
    rows: ReadonlyArray<DiffAnalysisGenerations.DiffAnalysisGenerationRecord>,
    cap: number,
  )
  {
    let retainedBytes = rows.reduce((total, row) => total + row.artifactByteLength, 0)
    for (const row of rows)
    {
      if (retainedBytes <= cap) break
      if (yield* deleteRowBeforeRoot(row)) retainedBytes -= row.artifactByteLength
    }
  })

  const runRetention = Effect.fn('DiffAnalysisService.runRetention')(function* ()
  {
    const now = yield* DateTime.now
    const cutoff = DateTime.formatIso(
      DateTime.makeUnsafe(DateTime.toEpochMillis(now) - DIFF_ANALYSIS_TERMINAL_OBSERVATION_MS),
    )
    const expired = yield* repository
      .listTerminalBefore({ cutoff })
      .pipe(Effect.catch(persistenceFailure('DiffAnalysisService.listExpired')))
    yield* Effect.forEach(expired, deleteRowBeforeRoot, { discard: true })

    const ready = yield* repository
      .listReadyGlobalLru()
      .pipe(Effect.catch(persistenceFailure('DiffAnalysisService.listReady')))
    const repositoryKeys = new Map<string, { environmentId: string; repositoryKey: string }>()
    for (const row of ready)
    {
      repositoryKeys.set(`${row.environmentId}\0${row.repositoryKey}`, {
        environmentId: row.environmentId,
        repositoryKey: row.repositoryKey,
      })
    }
    for (const identity of repositoryKeys.values())
    {
      const rows = yield* repository
        .listReadyByRepositoryLru(identity)
        .pipe(Effect.catch(persistenceFailure('DiffAnalysisService.listRepositoryReady')))
      yield* evictToCap(rows, DIFF_ANALYSIS_REPOSITORY_CAP_BYTES)
    }
    const globalRows = yield* repository
      .listReadyGlobalLru()
      .pipe(Effect.catch(persistenceFailure('DiffAnalysisService.listGlobalReady')))
    yield* evictToCap(globalRows, DIFF_ANALYSIS_GLOBAL_CAP_BYTES)
  })

  const reconcileOrphanRoots = Effect.fn('DiffAnalysisService.reconcileOrphanRoots')(function* ()
  {
    const [persistedIds, leaseCounts, cursor] = yield* Effect.all([
      repository
        .listAllIds()
        .pipe(Effect.catch(persistenceFailure('DiffAnalysisService.listPersistedIds'))),
      Ref.get(leases),
      Ref.get(orphanSweepCursor),
    ])
    const protectedIds = new Set<string>(persistedIds)
    for (const diffAnalysisId of leaseCounts.keys())
    {
      protectedIds.add(diffAnalysisId)
    }
    const report = yield* Effect.tryPromise({
      try: () =>
        reconcileOrphanedDiffAnalysisRoots(analysesRoot, {
          protectedIds,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      catch: (cause) => new DiffAnalysisCleanupError({ cause }),
    })
    yield* Ref.set(orphanSweepCursor, report.nextCursor)
    yield* Effect.forEach(
      report.failures,
      (failure) =>
        Effect.logWarning('diff analysis orphan cleanup failed; a later pass will retry', {
          artifactRoot: failure.artifactRoot,
          cause: failure.cause,
        }),
      { discard: true },
    )
  })

  const runMaintenance = Effect.fn('DiffAnalysisService.runMaintenance')(function* ()
  {
    yield* runRetention().pipe(
      Effect.catch((error) => Effect.logWarning('diff analysis retention failed', { error })),
    )
    yield* reconcileOrphanRoots().pipe(
      Effect.catch((error) => Effect.logWarning('diff analysis orphan sweep failed', { error })),
    )
  })

  const runGeneration = Effect.fn('DiffAnalysisService.runGeneration')(function* (
    initial: DiffAnalysisGenerations.DiffAnalysisGenerationRecord,
    resolved: ResolvedDiffSource,
  )
  {
    let row = yield* updateRow(initial, { state: 'preparing' })
    const baseRoot = path.join(row.artifactRoot, 'base')
    const headRoot = path.join(row.artifactRoot, 'head')
    // materializeExactGitTree requires an existing destination directory, so
    // both tree roots are created alongside the artifact root
    yield* Effect.tryPromise({
      try: async () =>
      {
        await NodeFSP.mkdir(row.artifactRoot, { recursive: true })
        await NodeFSP.mkdir(baseRoot, { recursive: true })
        await NodeFSP.mkdir(headRoot, { recursive: true })
      },
      catch: () =>
        new DiffAnalysisFailure({
          code: 'materialization-failed',
          message: 'Diff analysis storage could not be created.',
        }) as DiffAnalysisError,
    })
    const baseMaterialization = yield* materializeTree(resolved.cwd, resolved.baseTreeOid, baseRoot)
    const headMaterialization = yield* materializeTree(resolved.cwd, resolved.headTreeOid, headRoot)
    row = yield* updateRow(row, { state: 'analyzing' })

    // analyzeTrees acquires the single CartographerAnalyzer-owned build permit.
    // its comparison input has no AbortSignal, so cancellation is intentionally omitted.
    const analysis = yield* analyzer
      .analyzeTrees({
        baseRoot,
        proposedRoot: headRoot,
        outDir: row.artifactRoot,
        baseRef: resolved.baseAnalyzerRef,
        proposedRef: resolved.headAnalyzerRef,
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new DiffAnalysisFailure({
              code: error.failure === 'unsupported' ? 'unsupported' : 'analysis-failed',
              message:
                error.failure === 'unsupported'
                  ? 'Cartographer analysis is unavailable.'
                  : 'Cartographer diff analysis failed.',
            }) as DiffAnalysisError,
        ),
      )
    const manifest = decodeManifest(analysis.process.stdout)
    if (manifest === null || manifest.analyzerVersion !== analysis.fingerprint)
    {
      return yield* fail(
        'analysis-manifest-invalid',
        'Cartographer returned an invalid diff analysis manifest.',
      )
    }
    const [baseRootDigest, headRootDigest] = yield* Effect.tryPromise({
      try: () => Promise.all([digestMaterializedRoot(baseRoot), digestMaterializedRoot(headRoot)]),
      catch: () =>
        new DiffAnalysisFailure({
          code: 'materialization-failed',
          message: 'The retained diff trees could not be sealed.',
        }) as DiffAnalysisError,
    })
    const graphMatches = (expectedRef: string) => (bytes: Uint8Array) =>
    {
      const value = artifactObject(bytes)
      return value?.repoRoot === '.' && value.gitRef === expectedRef
    }
    const baseGraph = yield* sealArtifact(
      row.artifactRoot,
      path.join(row.artifactRoot, manifest.baseGraph),
      'base.graph',
      graphMatches(resolved.baseAnalyzerRef),
      baseRootDigest,
    )
    const headGraph = yield* sealArtifact(
      row.artifactRoot,
      path.join(row.artifactRoot, manifest.proposedGraph),
      'head.graph',
      graphMatches(resolved.headAnalyzerRef),
      headRootDigest,
    )
    const impact = yield* sealArtifact(
      row.artifactRoot,
      path.join(row.artifactRoot, manifest.impact),
      'impact.graph-diff-v1',
      (bytes) => impactArtifactMatches(bytes, resolved.baseAnalyzerRef, resolved.headAnalyzerRef),
    )
    const artifactByteLength =
      baseMaterialization.byteCount +
      headMaterialization.byteCount +
      baseGraph.byteLength +
      headGraph.byteLength +
      impact.byteLength
    if (
      !Number.isSafeInteger(artifactByteLength) ||
      artifactByteLength > DIFF_ANALYSIS_REPOSITORY_CAP_BYTES
    )
    {
      return yield* fail(
        'limit-exceeded',
        'The retained diff analysis exceeds the per-repository cache cap.',
      )
    }
    yield* updateRow(row, {
      state: 'ready',
      headRootPath: headRoot,
      baseGraphPath: baseGraph.path,
      headGraphPath: headGraph.path,
      impactPath: impact.path,
      artifactByteLength,
      errorCode: null,
    })
  })

  const startGeneration = Effect.fn('DiffAnalysisService.startGeneration')(function* (
    row: DiffAnalysisGenerations.DiffAnalysisGenerationRecord,
    resolved: ResolvedDiffSource,
  )
  {
    const logTerminalUpdateFailure = (
      state: 'cancelled' | 'abandoned' | 'failed',
      error: DiffAnalysisError,
    ) =>
      Effect.logError('diff analysis terminal update failed', {
        diffAnalysisId: row.diffAnalysisId,
        state,
        errorCode: error.code,
        detail: error.message,
      })
    const work = runGeneration(row, resolved).pipe(
      Effect.onInterrupt(() =>
        Effect.gen(function* ()
        {
          const closing = yield* Ref.get(serviceClosing)
          const state = closing ? 'abandoned' : 'cancelled'
          yield* cleanupArtifactRoot(row.artifactRoot)
          yield* updateRow(row, {
            state,
            errorCode: closing ? 'server-restarted' : 'request-cancelled',
          }).pipe(Effect.catch((error) => logTerminalUpdateFailure(state, error)))
        }),
      ),
      Effect.catch((error) =>
        Effect.gen(function* ()
        {
          yield* cleanupArtifactRoot(row.artifactRoot)
          yield* updateRow(row, {
            state: 'failed',
            errorCode: error.code,
          }).pipe(Effect.catch((updateError) => logTerminalUpdateFailure('failed', updateError)))
        }),
      ),
      Effect.andThen(runRetention().pipe(Effect.ignore)),
    )
    yield* Effect.forkScoped(work).pipe(Effect.provideService(Scope.Scope, workerScope))
  })

  // resolving a source captures the whole working tree and fingerprints the analyzer, so a caller
  // that already holds a resolution for this row's source passes it in rather than paying twice
  const sourceIsCurrent = Effect.fn('DiffAnalysisService.sourceIsCurrent')(function* (
    row: DiffAnalysisGenerations.DiffAnalysisGenerationRecord,
    preresolved?: ResolvedDiffSource,
  )
  {
    if (normalizeSource(row.source)._tag === 'treePair') return true
    const matchesRow = (resolved: ResolvedDiffSource) =>
      resolved.repositoryKey === row.repositoryKey &&
      resolved.baseTreeOid === row.baseTreeOid &&
      resolved.headTreeOid === row.headTreeOid
    if (preresolved !== undefined) return matchesRow(preresolved)
    return yield* resolveSource(row.source).pipe(
      Effect.map(matchesRow),
      Effect.orElseSucceed(() => false),
    )
  })

  const admitRequest = Effect.fn('DiffAnalysisService.admitRequest')(function* (
    input: DiffAnalysisTargetInput,
    resolved: ResolvedDiffSource,
  )
  {
    if (yield* Ref.get(serviceClosing))
    {
      return yield* fail('server-restarted', 'The server is restarting; retry diff analysis.')
    }
    const diffAnalysisId = DiffAnalysisId.make(NodeCrypto.randomUUID())
    const createdAt = DateTime.formatIso(yield* DateTime.now)
    const row: DiffAnalysisGenerations.DiffAnalysisGenerationRecord = {
      diffAnalysisId,
      environmentId: resolved.environmentId,
      repositoryKey: resolved.repositoryKey,
      baseTreeOid: resolved.baseTreeOid,
      headTreeOid: resolved.headTreeOid,
      baseAnalyzerRef: resolved.baseAnalyzerRef,
      headAnalyzerRef: resolved.headAnalyzerRef,
      analyzerVersion: resolved.analyzerVersion,
      analysisPolicyVersion: resolved.analysisPolicyVersion,
      configDigest: resolved.configDigest,
      scopeDigest: resolved.scopeDigest,
      tsconfigDigest: resolved.tsconfigDigest,
      source: input.source,
      state: 'queued',
      artifactRoot: path.join(analysesRoot, diffAnalysisId),
      headRootPath: null,
      baseGraphPath: null,
      headGraphPath: null,
      impactPath: null,
      artifactByteLength: 0,
      errorCode: null,
      createdAt,
      updatedAt: createdAt,
      lastAccessedAt: createdAt,
    }
    const admission = yield* repository
      .admit(row)
      .pipe(Effect.catch(persistenceFailure('DiffAnalysisService.request')))
    if (admission.inserted) yield* startGeneration(admission.row, resolved)
    else
    {
      const retried = yield* repository
        .retryTerminal({ diffAnalysisId: admission.row.diffAnalysisId, updatedAt: createdAt })
        .pipe(Effect.catch(persistenceFailure('DiffAnalysisService.request.retry')))
      if (Option.isSome(retried))
      {
        yield* startGeneration(retried.value, resolved)
        return publicGeneration(retried.value, true)
      }
      const lastAccessedAt = yield* repository
        .touch({ diffAnalysisId: admission.row.diffAnalysisId, lastAccessedAt: createdAt })
        .pipe(Effect.catch(persistenceFailure('DiffAnalysisService.request.touch')))
      // the touch above already moved this row, so report what the store now holds, matching
      // get/getById rather than echoing the pre-touch read
      return publicGeneration({ ...admission.row, lastAccessedAt }, true)
    }
    return publicGeneration(admission.row, true)
  })

  const request: DiffAnalysisServiceShape['request'] = Effect.fn('DiffAnalysisService.request')(
    function* (input)
    {
      const resolved = yield* resolveAuthorizedSource(input)
      return yield* serviceLifecycle.withPermit(admitRequest(input, resolved))
    },
  )

  const readRow = Effect.fn('DiffAnalysisService.readRow')(function* (
    diffAnalysisId: DiffAnalysisId,
  )
  {
    const row = yield* repository
      .getById({ diffAnalysisId })
      .pipe(Effect.catch(persistenceFailure('DiffAnalysisService.get')))
    if (Option.isNone(row))
    {
      return yield* fail('invalid-source', 'Diff analysis was not found.')
    }
    return row.value
  })

  // id reads preserve the first-writer source descriptor so superseded
  // generations can report sourceCurrent:false without opening an id probe
  const readRowByTarget = Effect.fn('DiffAnalysisService.readRowByTarget')(function* (
    input: DiffAnalysisTargetInput,
  )
  {
    if (input.diffAnalysisId !== undefined)
    {
      const row = yield* readRow(input.diffAnalysisId)
      if (!sourceDescriptorMatches(row.source, input.source))
      {
        return yield* fail('invalid-source', 'Diff analysis was not found.')
      }
      yield* authorizeStoredRow(input.workspaceRoot, row)
      // an id read never resolves the source, so currency still has to be established separately
      return { row, resolved: null }
    }

    const resolved = yield* resolveAuthorizedSource(input)
    const identity: DiffAnalysisGenerations.DiffAnalysisCacheIdentity = {
      environmentId: resolved.environmentId,
      repositoryKey: resolved.repositoryKey,
      baseTreeOid: resolved.baseTreeOid,
      headTreeOid: resolved.headTreeOid,
      analyzerVersion: resolved.analyzerVersion,
      analysisPolicyVersion: resolved.analysisPolicyVersion,
      configDigest: resolved.configDigest,
      scopeDigest: resolved.scopeDigest,
      tsconfigDigest: resolved.tsconfigDigest,
    }
    const found = yield* repository
      .getByIdentity(identity)
      .pipe(Effect.catch(persistenceFailure('DiffAnalysisService.readRowByTarget')))
    if (Option.isNone(found))
    {
      return yield* fail('invalid-source', 'Diff analysis was not found.')
    }
    // the row was looked up by this exact resolution, so it carries the row's current identity
    return { row: found.value, resolved }
  })

  const get: DiffAnalysisServiceShape['get'] = Effect.fn('DiffAnalysisService.get')(
    function* (input)
    {
      const { row, resolved } = yield* readRowByTarget(input)
      const now = DateTime.formatIso(yield* DateTime.now)
      const lastAccessedAt = yield* repository
        .touch({ diffAnalysisId: row.diffAnalysisId, lastAccessedAt: now })
        .pipe(Effect.catch(persistenceFailure('DiffAnalysisService.touch')))
      return publicGeneration(
        { ...row, lastAccessedAt },
        yield* sourceIsCurrent(row, resolved ?? undefined),
      )
    },
  )

  const getById: DiffAnalysisServiceShape['getById'] = Effect.fn('DiffAnalysisService.getById')(
    function* (input)
    {
      const row = yield* readRow(input.diffAnalysisId)
      yield* authorizeStoredRow(input.workspaceRoot, row).pipe(
        Effect.catch((error) =>
          error.code === 'repository-out-of-scope'
            ? fail('invalid-source', 'Diff analysis was not found.')
            : Effect.fail(error),
        ),
      )
      const now = DateTime.formatIso(yield* DateTime.now)
      const lastAccessedAt = yield* repository
        .touch({ diffAnalysisId: row.diffAnalysisId, lastAccessedAt: now })
        .pipe(Effect.catch(persistenceFailure('DiffAnalysisService.getById.touch')))
      return publicGeneration({ ...row, lastAccessedAt }, yield* sourceIsCurrent(row))
    },
  )

  const verifyRetainedRoot = Effect.fn('DiffAnalysisService.verifyRetainedRoot')(function* (
    row: DiffAnalysisGenerations.DiffAnalysisGenerationRecord,
    rootPath: string,
    expectedName: 'base' | 'head',
    expectedDigest?: string,
  )
  {
    const resolvedRoot = path.resolve(rootPath)
    const expectedRoot = path.resolve(path.join(row.artifactRoot, expectedName))
    if (resolvedRoot !== expectedRoot)
    {
      return yield* fail(
        'artifact-invalid',
        `The retained diff ${expectedName} root path is invalid.`,
      )
    }
    const info = yield* Effect.tryPromise({
      try: () => NodeFSP.lstat(resolvedRoot),
      catch: () =>
        new DiffAnalysisFailure({
          code: 'artifact-invalid',
          message: `The retained diff ${expectedName} root could not be read.`,
        }) as DiffAnalysisError,
    })
    if (!info.isDirectory() || info.isSymbolicLink())
    {
      return yield* fail('artifact-invalid', `The retained diff ${expectedName} root is invalid.`)
    }
    if (expectedDigest !== undefined)
    {
      const actualDigest = yield* Effect.tryPromise({
        try: () => digestMaterializedRoot(resolvedRoot),
        catch: () =>
          new DiffAnalysisFailure({
            code: 'artifact-invalid',
            message: `The retained diff ${expectedName} root could not be verified.`,
          }) as DiffAnalysisError,
      })
      if (!SHA256_HEX.test(expectedDigest) || actualDigest !== expectedDigest)
      {
        return yield* fail(
          'artifact-invalid',
          `The retained diff ${expectedName} root identity is invalid.`,
        )
      }
    }
    return resolvedRoot
  })

  const verifyReadyTarget = Effect.fn('DiffAnalysisService.verifyReadyTarget')(function* (
    row: DiffAnalysisGenerations.DiffAnalysisGenerationRecord,
  )
  {
    if (
      row.state !== 'ready' ||
      row.headRootPath === null ||
      row.baseGraphPath === null ||
      row.headGraphPath === null ||
      row.impactPath === null
    )
    {
      return yield* fail('invalid-source', 'Ready diff analysis was not found.')
    }
    const verifyArtifact = Effect.fn('DiffAnalysisService.verifyArtifact')(function* (
      artifactPath: string,
      pattern: RegExp,
      identityMatches: (bytes: Uint8Array) => boolean,
    )
    {
      const match = pattern.exec(path.basename(artifactPath))
      if (path.dirname(path.resolve(artifactPath)) !== path.resolve(row.artifactRoot) || !match)
      {
        return yield* fail('artifact-invalid', 'A sealed diff analysis artifact name is invalid.')
      }
      const bytes = yield* Effect.tryPromise({
        try: async () =>
        {
          const info = await NodeFSP.lstat(artifactPath)
          if (!info.isFile() || info.isSymbolicLink()) throw new Error('not a regular file')
          return NodeFSP.readFile(artifactPath)
        },
        catch: () =>
          new DiffAnalysisFailure({
            code: 'artifact-invalid',
            message: 'A sealed diff analysis artifact could not be read.',
          }) as DiffAnalysisError,
      })
      if (sha256(bytes) !== match[1] || !identityMatches(bytes))
      {
        return yield* fail(
          'artifact-invalid',
          'A sealed diff analysis artifact identity is invalid.',
        )
      }
      return { bytes, match }
    })
    const base = yield* verifyArtifact(
      row.baseGraphPath,
      /^base\.graph\.([0-9a-f]{64})(?:\.([0-9a-f]{64}))?\.json$/u,
      (bytes) =>
      {
        const value = artifactObject(bytes)
        return value?.repoRoot === '.' && value.gitRef === row.baseAnalyzerRef
      },
    )
    const head = yield* verifyArtifact(
      row.headGraphPath,
      /^head\.graph\.([0-9a-f]{64})\.([0-9a-f]{64})\.json$/u,
      (bytes) =>
      {
        const value = artifactObject(bytes)
        return value?.repoRoot === '.' && value.gitRef === row.headAnalyzerRef
      },
    )
    const impactPath = row.impactPath
    const impact = yield* verifyArtifact(
      impactPath,
      /^impact(?:\.graph-diff-v1)?\.([0-9a-f]{64})\.json$/u,
      (bytes) =>
        impactStemMatches(
          bytes,
          path.basename(impactPath),
          row.baseAnalyzerRef,
          row.headAnalyzerRef,
        ),
    )
    if (
      artifactObject(base.bytes)?.gitRef !== row.baseAnalyzerRef ||
      artifactObject(head.bytes)?.gitRef !== row.headAnalyzerRef ||
      artifactObject(impact.bytes)?.baseGitRef !== row.baseAnalyzerRef
    )
    {
      return yield* fail('artifact-invalid', 'The sealed diff analysis labels are inconsistent.')
    }
    if (base.match[2] !== undefined)
    {
      yield* verifyRetainedRoot(row, path.join(row.artifactRoot, 'base'), 'base', base.match[2])
    }
    const headRootPath = yield* verifyRetainedRoot(
      row,
      row.headRootPath,
      'head',
      head.match[2] ?? '',
    )
    return {
      generation: publicGeneration(row, true),
      repositoryKey: row.repositoryKey,
      headRoot: headRootPath,
      baseGraphPath: row.baseGraphPath,
      headGraphPath: row.headGraphPath,
      impactPath: row.impactPath,
    } satisfies ReadyDiffAnalysisTarget
  })

  const releaseLease = (diffAnalysisId: DiffAnalysisId) =>
    Ref.update(leases, (current) =>
    {
      const next = new Map(current)
      const count = next.get(diffAnalysisId) ?? 0
      if (count <= 1) next.delete(diffAnalysisId)
      else next.set(diffAnalysisId, count - 1)
      return next
    })

  const verifyReadyImpactTarget = Effect.fn('DiffAnalysisService.verifyReadyImpactTarget')(
    function* (
      row: DiffAnalysisGenerations.DiffAnalysisGenerationRecord,
      repositoryRoot: string,
      sourceSide?: 'base' | 'head',
    )
    {
      if (
        row.state !== 'ready' ||
        row.headRootPath === null ||
        row.baseGraphPath === null ||
        row.headGraphPath === null ||
        row.impactPath === null
      )
      {
        return yield* fail('invalid-source', 'Ready diff analysis was not found.')
      }
      const impactPath = row.impactPath
      const match = /^(impact(?:\.graph-diff-v1)?)\.([0-9a-f]{64})\.json$/u.exec(
        path.basename(impactPath),
      )
      if (
        path.dirname(path.resolve(impactPath)) !== path.resolve(row.artifactRoot) ||
        match === null
      )
      {
        return yield* fail('artifact-invalid', 'The sealed diff impact name is invalid.')
      }
      const bytes = yield* Effect.tryPromise({
        try: async () =>
        {
          const info = await NodeFSP.lstat(impactPath)
          if (!info.isFile() || info.isSymbolicLink()) throw new Error('not a regular file')
          return NodeFSP.readFile(impactPath)
        },
        catch: () =>
          new DiffAnalysisFailure({
            code: 'artifact-invalid',
            message: 'The sealed diff impact could not be read.',
          }) as DiffAnalysisError,
      })
      if (
        sha256(bytes) !== match[2] ||
        !impactStemMatches(
          bytes,
          path.basename(impactPath),
          row.baseAnalyzerRef,
          row.headAnalyzerRef,
        )
      )
      {
        return yield* fail('artifact-invalid', 'The sealed diff impact identity is invalid.')
      }
      const baseGraph = /^base\.graph\.([0-9a-f]{64})(?:\.([0-9a-f]{64}))?\.json$/u.exec(
        path.basename(row.baseGraphPath),
      )
      const headGraph = /^head\.graph\.([0-9a-f]{64})\.([0-9a-f]{64})\.json$/u.exec(
        path.basename(row.headGraphPath),
      )
      if (
        baseGraph === null ||
        headGraph === null ||
        path.dirname(path.resolve(row.baseGraphPath)) !== path.resolve(row.artifactRoot) ||
        path.dirname(path.resolve(row.headGraphPath)) !== path.resolve(row.artifactRoot)
      )
      {
        return yield* fail('artifact-invalid', 'The sealed diff graph identity is invalid.')
      }
      const baseRoot =
        baseGraph[2] === undefined
          ? null
          : yield* verifyRetainedRoot(
              row,
              path.join(row.artifactRoot, 'base'),
              'base',
              sourceSide === 'base' ? baseGraph[2] : undefined,
            )
      if (sourceSide === 'base' && baseRoot === null)
      {
        return yield* fail(
          'invalid-source',
          'The retained diff analysis predates immutable base source retention.',
        )
      }
      const headRoot = yield* verifyRetainedRoot(
        row,
        row.headRootPath,
        'head',
        sourceSide === 'head' ? (headGraph[2] ?? '') : undefined,
      )
      let diff: GraphDiff | null = null
      try
      {
        diff = parseGraphDiff(artifactObject(bytes))
      }
      catch
      {
        if (match[1] !== 'impact')
        {
          return yield* fail('artifact-invalid', 'The sealed diff impact could not be decoded.')
        }
      }
      return {
        generation: publicGeneration(row, true),
        diff,
        impactDigest: `sha256:${match[2]}`,
        legacy: match[1] === 'impact',
        repositoryRoot,
        baseTreeOid: row.baseTreeOid,
        headTreeOid: row.headTreeOid,
        baseGraphDigest: `sha256:${baseGraph[1]}`,
        headGraphDigest: `sha256:${headGraph[1]}`,
        baseRoot,
        headRoot,
      } satisfies ReadyDiffAnalysisImpactTarget
    },
  )

  const retainReadyTarget: DiffAnalysisServiceShape['retainReadyTarget'] = (input) =>
    Effect.acquireRelease(
      Effect.gen(function* ()
      {
        const row = yield* readRow(input.diffAnalysisId)
        yield* authorizeStoredRow(input.workspaceRoot, row)
        if (row.state !== 'ready')
        {
          return yield* fail('invalid-source', 'Ready diff analysis was not found.')
        }
        let liveRoot: string | null = null
        if (row.source.sourceKind === 'review' && row.source.kind === 'working-tree')
        {
          const liveCwd = yield* assertWorkspaceBoundCwd(row.source.cwd)
          const liveRepository = yield* resolveRepository(liveCwd)
          if (liveRepository.repositoryKey !== row.repositoryKey)
          {
            return yield* fail(
              'repository-out-of-scope',
              'The working-tree diff source no longer belongs to its recorded repository.',
            )
          }
          liveRoot = liveRepository.root
        }
        const retained = yield* Ref.modify(leases, (current) =>
        {
          const count = current.get(input.diffAnalysisId) ?? 0
          if (count < 0) return [false, current] as const
          const next = new Map(current)
          next.set(input.diffAnalysisId, count + 1)
          return [true, next] as const
        })
        if (!retained)
        {
          return yield* fail('invalid-source', 'Ready diff analysis was being evicted.')
        }
        const target = yield* verifyReadyTarget(row).pipe(
          Effect.onError(() => releaseLease(input.diffAnalysisId)),
        )
        const lastAccessedAt = yield* repository
          .touch({
            diffAnalysisId: input.diffAnalysisId,
            lastAccessedAt: DateTime.formatIso(yield* DateTime.now),
          })
          .pipe(
            Effect.catch(persistenceFailure('DiffAnalysisService.retainReadyTarget')),
            Effect.onError(() => releaseLease(input.diffAnalysisId)),
          )
        return {
          ...target,
          generation: { ...target.generation, lastAccessedAt },
          headRoot: liveRoot ?? target.headRoot,
        }
      }),
      (target) => releaseLease(target.generation.diffAnalysisId),
    )

  const retainReadyImpactTarget: DiffAnalysisServiceShape['retainReadyImpactTarget'] = (input) =>
    Effect.acquireRelease(
      Effect.gen(function* ()
      {
        const row = yield* readRow(input.diffAnalysisId)
        const repositoryRoot = (yield* authorizeStoredRow(input.workspaceRoot, row)).root
        if (row.state !== 'ready')
        {
          return yield* fail('invalid-source', 'Ready diff analysis was not found.')
        }
        const retained = yield* Ref.modify(leases, (current) =>
        {
          const count = current.get(input.diffAnalysisId) ?? 0
          if (count < 0) return [false, current] as const
          const next = new Map(current)
          next.set(input.diffAnalysisId, count + 1)
          return [true, next] as const
        })
        if (!retained)
        {
          return yield* fail('invalid-source', 'Ready diff analysis was being evicted.')
        }
        const target = yield* verifyReadyImpactTarget(row, repositoryRoot, input.sourceSide).pipe(
          Effect.onError(() => releaseLease(input.diffAnalysisId)),
        )
        const lastAccessedAt = yield* repository
          .touch({
            diffAnalysisId: input.diffAnalysisId,
            lastAccessedAt: DateTime.formatIso(yield* DateTime.now),
          })
          .pipe(
            Effect.catch(persistenceFailure('DiffAnalysisService.retainReadyImpactTarget')),
            Effect.onError(() => releaseLease(input.diffAnalysisId)),
          )
        return {
          ...target,
          generation: { ...target.generation, lastAccessedAt },
        }
      }),
      (target) => releaseLease(target.generation.diffAnalysisId),
    )

  const startupAt = DateTime.formatIso(yield* DateTime.now)
  const abandoned = yield* repository
    .abandonActive(startupAt)
    .pipe(Effect.catch(persistenceFailure('DiffAnalysisService.abandonStartup')))
  yield* Effect.forEach(abandoned, (row) => cleanupArtifactRoot(row.artifactRoot), {
    concurrency: 4,
    discard: true,
  })
  // the first pass runs inside the fiber rather than inline: maintenance scans the cache and its
  // artifact trees, which does not need to finish before the layer can serve
  yield* Effect.forkScoped(
    Effect.suspend(() => runMaintenance()).pipe(
      Effect.andThen(Effect.sleep(DIFF_ANALYSIS_MAINTENANCE_INTERVAL)),
      Effect.forever,
    ),
  ).pipe(Effect.provideService(Scope.Scope, workerScope))

  return DiffAnalysisService.of({
    request,
    get,
    getById,
    retainReadyTarget,
    retainReadyImpactTarget,
  })
})

export const layer = Layer.effect(DiffAnalysisService, make)
