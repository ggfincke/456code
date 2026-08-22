// apps/server/src/proposal/ProposalGenerationService.ts
// runs bounded exact cartographer analysis for retained proposal trees

// @effect-diagnostics nodeBuiltinImport:off

import * as NodeCrypto from 'node:crypto'
import * as NodeFSP from 'node:fs/promises'

import {
  CartographerError,
  ProposalGeneration,
  ProposalGenerationError,
  ProposalGenerationId,
  type ProposalGenerationGetInput,
  type ProposalGenerationLatestInput,
  type ProposalGenerationStartInput,
  type ProposalId,
  type ProposalRevision,
  type ProposalRevisionId,
} from '@t3tools/contracts'
import {
  parseGraphDiff,
  parseVerifiedImpactProjection,
  type GraphDiff,
  type VerifiedImpactProjectionArtifact,
} from '@t3tools/cartographer-core/server'
import * as Context from 'effect/Context'
import * as Crypto from 'effect/Crypto'
import * as Data from 'effect/Data'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Ref from 'effect/Ref'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'
import * as Semaphore from 'effect/Semaphore'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import * as SqlSchema from 'effect/unstable/sql/SqlSchema'

import * as ArchitectureAdmissionRepository from '../architecture/ArchitectureAdmissionRepository.ts'
import * as ServerConfig from '../config.ts'
import * as CartographerAnalyzer from '../cartographer/CartographerAnalyzer.ts'
import * as ProcessRunner from '../process/processRunner.ts'
import { architectureComparisonGenerationDuration, withMetrics } from '../observability/Metrics.ts'
import {
  captureExactGitSnapshot,
  EXACT_GIT_SNAPSHOT_MAX_BYTE_COUNT,
  EXACT_GIT_SNAPSHOT_MAX_FILE_COUNT,
} from '../vcs/ExactGitSnapshot.ts'
import { materializeExactGitTreeIntoCache } from '../vcs/ExactGitCacheMaterialization.ts'
import * as ProposalService from './ProposalService.ts'

const GENERATION_MAX_REPOSITORY_FILES = EXACT_GIT_SNAPSHOT_MAX_FILE_COUNT
const GENERATION_MAX_REPOSITORY_BYTES = EXACT_GIT_SNAPSHOT_MAX_BYTE_COUNT
const GENERATION_MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024
const GENERATION_MAX_ARTIFACT_BYTES = 128 * 1024 * 1024
const GENERATION_GLOBAL_CONCURRENCY = 2
const GENERATION_RETENTION_GRACE_MS = 24 * 60 * 60 * 1_000
const SHA256_HEX = /^[0-9a-f]{64}$/u
const isProposalGenerationError = Schema.is(ProposalGenerationError)

const GenerationRow = Schema.Struct({
  generationId: ProposalGenerationId,
  proposalId: Schema.String,
  revisionId: Schema.String,
  revision: Schema.Int,
  threadId: Schema.String,
  state: Schema.Literals([
    'queued',
    'preparing',
    'analyzing',
    'ready',
    'failed',
    'cancelled',
    'abandoned',
  ]),
  authority: Schema.Literals(['authoritative', 'estimated']),
  workspaceSnapshotTreeOid: Schema.String,
  analyzerVersion: Schema.String,
  artifactRoot: Schema.String,
  baseGraphPath: Schema.NullOr(Schema.String),
  proposedGraphPath: Schema.NullOr(Schema.String),
  impactPath: Schema.NullOr(Schema.String),
  impactProjectionPath: Schema.NullOr(Schema.String),
  architectureAdmissionKey: Schema.NullOr(Schema.String),
  errorCode: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
})
type GenerationRow = typeof GenerationRow.Type

const GenerationIdRequest = Schema.Struct({ generationId: ProposalGenerationId })
const LatestRequest = Schema.Struct({
  proposalId: Schema.String,
  revision: Schema.Int,
})
const LatestExactRequest = Schema.Struct({
  proposalId: Schema.String,
  threadId: Schema.String,
  revisionId: Schema.String,
  analyzerVersion: Schema.String,
  architectureAdmissionKey: Schema.String,
})
const LatestAdmissionRequest = Schema.Struct({
  admissionKey: Schema.String,
  threadId: Schema.String,
  proposalId: Schema.String,
  revisionId: Schema.String,
})
const GenerationUpdate = Schema.Struct({
  generationId: ProposalGenerationId,
  state: GenerationRow.fields.state,
  analyzerVersion: Schema.String,
  baseGraphPath: Schema.NullOr(Schema.String),
  proposedGraphPath: Schema.NullOr(Schema.String),
  impactPath: Schema.NullOr(Schema.String),
  impactProjectionPath: Schema.NullOr(Schema.String),
  errorCode: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
})

interface AnalyzerManifest
{
  readonly type: 'cartographer.analysis-ready'
  readonly version: 2
  readonly analyzerVersion: string
  readonly baseGraph: 'base.graph.json'
  readonly proposedGraph: 'proposed.graph.json'
  readonly impact: 'impact.json'
  readonly impactProjection: 'impact-projection.json'
}

export interface ProposalGenerationArchitectureTarget
{
  readonly generation: ProposalGeneration
  readonly proposedRoot: string
  readonly baseGraphPath: string
  readonly proposedGraphPath: string
  readonly impactPath: string
  readonly impactProjectionPath: string
}

export interface ProposalGenerationImpactTarget
{
  readonly diff: GraphDiff
  readonly projection: VerifiedImpactProjectionArtifact
  readonly impactDigest: string
  readonly impactProjectionDigest: string
  readonly repositoryRoot: string
  readonly baseTreeOid: string
  readonly proposedTreeOid: string
  readonly baseGraphDigest: string
  readonly proposedGraphDigest: string
}

interface ActiveGeneration
{
  readonly fiber: Fiber.Fiber<void, never>
  readonly row: GenerationRow
  readonly cancellation: {
    state: 'cancelled' | 'abandoned'
    errorCode: string
  }
}

interface SealedArtifactIdentity
{
  readonly artifactSha256: string
  readonly sourceSha256?: string
}

class ProposalGenerationRetentionError extends Data.TaggedError(
  'ProposalGenerationRetentionError',
)<{
  readonly cause: unknown
}>
{}

function sha256(bytes: Uint8Array): string
{
  return NodeCrypto.createHash('sha256').update(bytes).digest('hex')
}

function artifactObject(bytes: Uint8Array): Record<string, unknown> | null
{
  try
  {
    const value: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'))
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  }
  catch
  {
    return null
  }
}

function graphArtifactMatches(bytes: Uint8Array, expectedGitRef: string): boolean
{
  return artifactObject(bytes)?.gitRef === expectedGitRef
}

function impactArtifactMatches(
  bytes: Uint8Array,
  expectedBaseGitRef: string,
  expectedProposedGitRef: string,
): boolean
{
  const value = artifactObject(bytes)
  if (value?.baseGitRef !== expectedBaseGitRef || value.headGitRef !== expectedProposedGitRef)
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

function parseSealedArtifactName(
  fileName: string,
  stem: string,
  includesSourceIdentity: boolean,
): SealedArtifactIdentity | null
{
  const prefix = `${stem}.`
  const suffix = '.json'
  if (!fileName.startsWith(prefix) || !fileName.endsWith(suffix)) return null
  const identities = fileName.slice(prefix.length, -suffix.length).split('.')
  if (
    identities.length !== (includesSourceIdentity ? 2 : 1) ||
    identities.some((identity) => !SHA256_HEX.test(identity))
  )
  {
    return null
  }
  return {
    artifactSha256: identities[0]!,
    ...(includesSourceIdentity ? { sourceSha256: identities[1]! } : {}),
  }
}

async function digestMaterializedRoot(root: string): Promise<string>
{
  const digest = NodeCrypto.createHash('sha256')
  let entryCount = 0
  let contentBytes = 0

  const add = (kind: string, relativePath: string, mode: string, content?: Uint8Array) =>
  {
    const pathBytes = Buffer.from(relativePath, 'utf8')
    const payload = content ?? new Uint8Array()
    digest.update(kind)
    digest.update('\0')
    digest.update(mode)
    digest.update('\0')
    digest.update(String(pathBytes.byteLength))
    digest.update('\0')
    digest.update(pathBytes)
    digest.update('\0')
    digest.update(String(payload.byteLength))
    digest.update('\0')
    digest.update(payload)
  }

  const visit = async (directory: string, relativeDirectory: string): Promise<void> =>
  {
    const entries = await NodeFSP.readdir(directory, { withFileTypes: true })
    entries.sort((left, right) =>
      Buffer.compare(Buffer.from(left.name, 'utf8'), Buffer.from(right.name, 'utf8')),
    )
    for (const entry of entries)
    {
      entryCount += 1
      if (entryCount > GENERATION_MAX_REPOSITORY_FILES * 2)
      {
        throw new Error('materialized proposal tree has too many entries')
      }
      const relativePath =
        relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`
      const absolutePath = `${directory}/${entry.name}`
      const info = await NodeFSP.lstat(absolutePath)
      if (info.isDirectory())
      {
        add('directory', relativePath, '040000')
        await visit(absolutePath, relativePath)
        continue
      }
      if (info.isFile())
      {
        if (info.size > GENERATION_MAX_REPOSITORY_BYTES - contentBytes)
        {
          throw new Error('materialized proposal tree is too large')
        }
        const bytes = await NodeFSP.readFile(absolutePath)
        contentBytes += bytes.byteLength
        add('file', relativePath, info.mode & 0o111 ? '100755' : '100644', bytes)
        continue
      }
      if (info.isSymbolicLink())
      {
        const target = await NodeFSP.readlink(absolutePath, { encoding: 'buffer' })
        if (target.byteLength > GENERATION_MAX_REPOSITORY_BYTES - contentBytes)
        {
          throw new Error('materialized proposal tree is too large')
        }
        contentBytes += target.byteLength
        add('symlink', relativePath, '120000', target)
        continue
      }
      throw new Error(`materialized proposal tree contains a special entry at '${relativePath}'`)
    }
  }

  await visit(root, '')
  return digest.digest('hex')
}

export class ProposalGenerationService extends Context.Service<
  ProposalGenerationService,
  {
    readonly startAdmitted: (
      input: ProposalGenerationStartInput & {
        readonly revision: number
        readonly revisionId: ProposalRevisionId
        readonly analyzerFingerprint: string
        readonly admissionKey: string
        readonly leaseFence: ArchitectureAdmissionRepository.ArchitectureAdmissionLeaseFence
        readonly forceNewAttempt?: boolean
      },
    ) => Effect.Effect<
      ProposalGeneration,
      ProposalGenerationError | import('@t3tools/contracts').ProposalError
    >
    readonly get: (
      input: ProposalGenerationGetInput,
    ) => Effect.Effect<ProposalGeneration, ProposalGenerationError>
    readonly latest: (
      input: ProposalGenerationLatestInput,
    ) => Effect.Effect<ProposalGeneration | null, ProposalGenerationError>
    readonly latestAdmitted: (input: {
      readonly admissionKey: string
      readonly threadId: string
      readonly proposalId: string
      readonly revisionId: string
    }) => Effect.Effect<
      Pick<ProposalGeneration, 'generationId' | 'state' | 'errorCode'> | null,
      ProposalGenerationError
    >
    readonly resolveArchitectureTarget: (
      threadId: string,
      generationId: ProposalGenerationId,
    ) => Effect.Effect<ProposalGenerationArchitectureTarget, CartographerError>
    readonly resolveImpactTarget: (
      threadId: string,
      generationId: ProposalGenerationId,
    ) => Effect.Effect<ProposalGenerationImpactTarget, CartographerError>
    readonly cancelThread: (threadId: string) => Effect.Effect<void, ProposalGenerationError>
  }
>()('456code/proposal/ProposalGenerationService')
{}

function generationError(
  failure: ProposalGenerationError['failure'],
  message: string,
): ProposalGenerationError
{
  return new ProposalGenerationError({ failure, message })
}

function analyzerGenerationError(error: CartographerError): ProposalGenerationError
{
  if (error.failure === 'unsupported')
  {
    return generationError('unsupported', 'Architecture analysis is unavailable.')
  }
  if (error.failure === 'context_start_failed' || error.failure === 'snapshot_failed')
  {
    return generationError('process-failed', 'Architecture analysis could not start or complete.')
  }
  return generationError(
    'analysis-failed',
    'Architecture analysis could not prove the requested proposal authority.',
  )
}

function cartographerError(
  failure: CartographerError['failure'],
  message: string,
): CartographerError
{
  return new CartographerError({ failure, message })
}

function artifactReadError(cause: unknown): ProposalGenerationError
{
  const missing =
    typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT'
  return missing
    ? generationError(
        'analysis-failed',
        'Architecture analysis did not retain the declared artifact.',
      )
    : generationError('io-failed', 'An architecture analysis artifact could not be read.')
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
    const value: unknown = JSON.parse(line)
    if (
      typeof value !== 'object' ||
      value === null ||
      !('type' in value) ||
      value.type !== 'cartographer.analysis-ready' ||
      !('version' in value) ||
      value.version !== 2 ||
      !('analyzerVersion' in value) ||
      typeof value.analyzerVersion !== 'string' ||
      value.analyzerVersion.length === 0 ||
      !('baseGraph' in value) ||
      value.baseGraph !== 'base.graph.json' ||
      !('proposedGraph' in value) ||
      value.proposedGraph !== 'proposed.graph.json' ||
      !('impact' in value) ||
      value.impact !== 'impact.json' ||
      !('impactProjection' in value) ||
      value.impactProjection !== 'impact-projection.json'
    )
    {
      return null
    }
    return value as AnalyzerManifest
  }
  catch
  {
    return null
  }
}

function impactProjectionArtifactMatches(
  bytes: Uint8Array,
  expectedBaseGitRef: string,
  expectedProposedGitRef: string,
  expectedBaseGraphDigest: string,
  expectedProposedGraphDigest: string,
  expectedRawImpactDigest: string,
  expectedAnalyzerFingerprint: string,
  implementationChangedFileCount: number,
): boolean
{
  try
  {
    const projection = parseVerifiedImpactProjection(artifactObject(bytes))
    return (
      projection.baseGitRef === expectedBaseGitRef &&
      projection.headGitRef === expectedProposedGitRef &&
      projection.baseGraphDigest === expectedBaseGraphDigest &&
      projection.headGraphDigest === expectedProposedGraphDigest &&
      projection.rawImpactDigest === expectedRawImpactDigest &&
      projection.analyzerFingerprint === expectedAnalyzerFingerprint &&
      projection.implementationChangedFileCount === implementationChangedFileCount
    )
  }
  catch
  {
    return false
  }
}

function artifactReference(generationId: ProposalGenerationId, kind: string): string
{
  return `proposal-generation:${generationId}:${kind}`
}

function publicGeneration(
  row: GenerationRow,
  freshness: ProposalGeneration['freshness'],
): ProposalGeneration
{
  return {
    generationId: row.generationId,
    proposalId: row.proposalId as ProposalGeneration['proposalId'],
    revisionId: row.revisionId as ProposalGeneration['revisionId'],
    revision: row.revision,
    threadId: row.threadId as ProposalGeneration['threadId'],
    state: row.state,
    authority: row.authority,
    freshness,
    workspaceSnapshotTreeOid: row.workspaceSnapshotTreeOid,
    analyzerVersion: row.analyzerVersion,
    baseGraphArtifact:
      row.baseGraphPath === null ? null : artifactReference(row.generationId, 'base-graph'),
    proposedGraphArtifact:
      row.proposedGraphPath === null ? null : artifactReference(row.generationId, 'proposed-graph'),
    impactArtifact: row.impactPath === null ? null : artifactReference(row.generationId, 'impact'),
    impactProjectionArtifact:
      row.impactProjectionPath === null
        ? null
        : artifactReference(row.generationId, 'impact-projection'),
    errorCode: row.errorCode,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export const make = Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient
  const architectureAdmissions =
    yield* ArchitectureAdmissionRepository.ArchitectureAdmissionRepository
  const proposalService = yield* ProposalService.ProposalService
  const cartographerAnalyzer = yield* CartographerAnalyzer.CartographerAnalyzer
  const processRunner = yield* ProcessRunner.ProcessRunner
  const config = yield* ServerConfig.ServerConfig
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const crypto = yield* Crypto.Crypto
  const activeFibers = yield* Ref.make(new Map<string, ActiveGeneration>())
  // registration and explicit cancellation linearize before restart closes workers
  const serviceClosing = yield* Ref.make(false)
  const serviceLifecycle = yield* Semaphore.make(1)
  const workerScope = yield* Effect.acquireRelease(Scope.make('sequential'), (scope) =>
    serviceLifecycle.withPermit(
      Effect.gen(function* ()
      {
        yield* Ref.set(serviceClosing, true)
        for (const active of (yield* Ref.get(activeFibers)).values())
        {
          active.cancellation.state = 'abandoned'
          active.cancellation.errorCode = 'server-restarted'
        }
        yield* Scope.close(scope, Exit.void)
      }),
    ),
  )
  const concurrency = yield* Semaphore.make(GENERATION_GLOBAL_CONCURRENCY)
  const threadLocks = new Map<string, Semaphore.Semaphore>()
  const deletedThreads = new Set<string>()

  const lockForThread = Effect.fn('ProposalGenerationService.lockForThread')(function* (
    threadId: string,
  )
  {
    const existing = threadLocks.get(threadId)
    if (existing) return existing
    const created = yield* Semaphore.make(1)
    const raced = threadLocks.get(threadId)
    if (raced) return raced
    threadLocks.set(threadId, created)
    return created
  })

  const insertRow = SqlSchema.void({
    Request: GenerationRow,
    execute: (row) => sql`
      INSERT INTO proposal_generations (
        generation_id,
        proposal_id,
        revision_id,
        revision,
        thread_id,
        state,
        authority,
        workspace_snapshot_tree_oid,
        analyzer_version,
        artifact_root,
        base_graph_path,
        proposed_graph_path,
        impact_path,
        impact_projection_path,
        architecture_admission_key,
        error_code,
        created_at,
        updated_at
      )
      VALUES (
        ${row.generationId},
        ${row.proposalId},
        ${row.revisionId},
        ${row.revision},
        ${row.threadId},
        ${row.state},
        ${row.authority},
        ${row.workspaceSnapshotTreeOid},
        ${row.analyzerVersion},
        ${row.artifactRoot},
        ${row.baseGraphPath},
        ${row.proposedGraphPath},
        ${row.impactPath},
        ${row.impactProjectionPath},
        ${row.architectureAdmissionKey},
        ${row.errorCode},
        ${row.createdAt},
        ${row.updatedAt}
      )
    `,
  })
  const updateRow = SqlSchema.void({
    Request: GenerationUpdate,
    execute: (row) => sql`
      UPDATE proposal_generations
      SET
        state = ${row.state},
        analyzer_version = ${row.analyzerVersion},
        base_graph_path = ${row.baseGraphPath},
        proposed_graph_path = ${row.proposedGraphPath},
        impact_path = ${row.impactPath},
        impact_projection_path = ${row.impactProjectionPath},
        error_code = ${row.errorCode},
        updated_at = ${row.updatedAt}
      WHERE generation_id = ${row.generationId}
    `,
  })
  const getRow = SqlSchema.findOneOption({
    Request: GenerationIdRequest,
    Result: GenerationRow,
    execute: ({ generationId }) => sql`
      SELECT
        generation_id AS "generationId",
        proposal_id AS "proposalId",
        revision_id AS "revisionId",
        revision,
        thread_id AS "threadId",
        state,
        authority,
        workspace_snapshot_tree_oid AS "workspaceSnapshotTreeOid",
        analyzer_version AS "analyzerVersion",
        artifact_root AS "artifactRoot",
        base_graph_path AS "baseGraphPath",
        proposed_graph_path AS "proposedGraphPath",
        impact_path AS "impactPath",
        impact_projection_path AS "impactProjectionPath",
        architecture_admission_key AS "architectureAdmissionKey",
        error_code AS "errorCode",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM proposal_generations
      WHERE generation_id = ${generationId}
    `,
  })
  const latestRow = SqlSchema.findOneOption({
    Request: LatestRequest,
    Result: GenerationRow,
    execute: ({ proposalId, revision }) => sql`
      SELECT
        generation_id AS "generationId",
        proposal_id AS "proposalId",
        revision_id AS "revisionId",
        revision,
        thread_id AS "threadId",
        state,
        authority,
        workspace_snapshot_tree_oid AS "workspaceSnapshotTreeOid",
        analyzer_version AS "analyzerVersion",
        artifact_root AS "artifactRoot",
        base_graph_path AS "baseGraphPath",
        proposed_graph_path AS "proposedGraphPath",
        impact_path AS "impactPath",
        impact_projection_path AS "impactProjectionPath",
        architecture_admission_key AS "architectureAdmissionKey",
        error_code AS "errorCode",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM proposal_generations
      WHERE proposal_id = ${proposalId}
        AND revision = ${revision}
        AND architecture_admission_key IS NOT NULL
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `,
  })
  const latestExactRow = SqlSchema.findOneOption({
    Request: LatestExactRequest,
    Result: GenerationRow,
    execute: ({
      proposalId,
      threadId,
      revisionId,
      analyzerVersion,
      architectureAdmissionKey,
    }) => sql`
      SELECT
        generation_id AS "generationId",
        proposal_id AS "proposalId",
        revision_id AS "revisionId",
        revision,
        thread_id AS "threadId",
        state,
        authority,
        workspace_snapshot_tree_oid AS "workspaceSnapshotTreeOid",
        analyzer_version AS "analyzerVersion",
        artifact_root AS "artifactRoot",
        base_graph_path AS "baseGraphPath",
        proposed_graph_path AS "proposedGraphPath",
        impact_path AS "impactPath",
        impact_projection_path AS "impactProjectionPath",
        architecture_admission_key AS "architectureAdmissionKey",
        error_code AS "errorCode",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM proposal_generations
      WHERE proposal_id = ${proposalId}
        AND thread_id = ${threadId}
        AND revision_id = ${revisionId}
        AND analyzer_version = ${analyzerVersion}
        AND architecture_admission_key = ${architectureAdmissionKey}
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `,
  })
  const latestAdmissionRow = SqlSchema.findOneOption({
    Request: LatestAdmissionRequest,
    Result: GenerationRow,
    execute: ({ admissionKey, threadId, proposalId, revisionId }) => sql`
      SELECT
        generation_id AS "generationId",
        proposal_id AS "proposalId",
        revision_id AS "revisionId",
        revision,
        thread_id AS "threadId",
        state,
        authority,
        workspace_snapshot_tree_oid AS "workspaceSnapshotTreeOid",
        analyzer_version AS "analyzerVersion",
        artifact_root AS "artifactRoot",
        base_graph_path AS "baseGraphPath",
        proposed_graph_path AS "proposedGraphPath",
        impact_path AS "impactPath",
        impact_projection_path AS "impactProjectionPath",
        architecture_admission_key AS "architectureAdmissionKey",
        error_code AS "errorCode",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM proposal_generations
      WHERE architecture_admission_key = ${admissionKey}
        AND thread_id = ${threadId}
        AND proposal_id = ${proposalId}
        AND revision_id = ${revisionId}
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `,
  })

  const sqlFailure = (operation: string) => () =>
    generationError('persistence-failed', `${operation} could not persist proposal analysis state.`)

  const requireActiveAdmissionLease = Effect.fn(
    'ProposalGenerationService.requireActiveAdmissionLease',
  )(function* (
    fence: ArchitectureAdmissionRepository.ArchitectureAdmissionLeaseFence,
    admissionKey: string,
  )
  {
    const active = yield* architectureAdmissions
      .assertLeaseActive(fence, admissionKey)
      .pipe(Effect.mapError(sqlFailure('ProposalGenerationService.assertAdmissionLease')))
    if (!active)
    {
      return yield* generationError(
        'scope-mismatch',
        'The durable proposal analysis admission lease is no longer active.',
      )
    }
  })

  const generationsRoot = path.resolve(path.join(config.stateDir, 'cartographer', 'generations'))
  const cleanupArtifactRoot = (artifactRoot: string) =>
  {
    const resolved = path.resolve(artifactRoot)
    if (!resolved.startsWith(`${generationsRoot}${path.sep}`))
    {
      return Effect.void
    }
    return fileSystem.remove(resolved, { recursive: true, force: true }).pipe(Effect.ignore)
  }

  const sealArtifact = Effect.fn('ProposalGenerationService.sealArtifact')(function* (
    artifactRoot: string,
    sourcePath: string,
    stem: string,
    identityMatches: (bytes: Uint8Array) => boolean,
    sourceSha256?: string,
  )
  {
    const info = yield* Effect.tryPromise({
      try: () => NodeFSP.lstat(sourcePath),
      catch: artifactReadError,
    })
    if (!info.isFile() || info.size > GENERATION_MAX_ARTIFACT_BYTES)
    {
      return yield* generationError(
        'analysis-failed',
        'Architecture analysis did not produce a bounded regular artifact.',
      )
    }
    const bytes = yield* Effect.tryPromise({
      try: () => NodeFSP.readFile(sourcePath),
      catch: artifactReadError,
    })
    if (bytes.byteLength !== info.size)
    {
      return yield* generationError(
        'analysis-failed',
        'An architecture analysis artifact changed while it was being sealed.',
      )
    }
    const artifact = { bytes, sha256: sha256(bytes) }
    if (!identityMatches(artifact.bytes))
    {
      return yield* generationError(
        'analysis-failed',
        'Architecture analysis artifacts did not match the requested proposal identities.',
      )
    }
    const sealedPath = path.join(
      artifactRoot,
      `${stem}.${artifact.sha256}${sourceSha256 === undefined ? '' : `.${sourceSha256}`}.json`,
    )
    yield* fileSystem
      .rename(sourcePath, sealedPath)
      .pipe(
        Effect.mapError((cause) =>
          typeof cause === 'object' &&
          cause !== null &&
          'reason' in cause &&
          typeof cause.reason === 'object' &&
          cause.reason !== null &&
          '_tag' in cause.reason &&
          cause.reason._tag === 'NotFound'
            ? generationError(
                'analysis-failed',
                'Architecture analysis artifacts disappeared before they could be sealed.',
              )
            : generationError('io-failed', 'Architecture analysis artifacts could not be sealed.'),
        ),
      )
    return { path: sealedPath, byteLength: artifact.bytes.byteLength, sha256: artifact.sha256 }
  })

  const verifySealedArtifact = Effect.fn('ProposalGenerationService.verifySealedArtifact')(
    function* (
      artifactRoot: string,
      artifactPath: string,
      stem: string,
      includesSourceIdentity: boolean,
      identityMatches: (bytes: Uint8Array) => boolean,
    )
    {
      const resolvedRoot = path.resolve(artifactRoot)
      const resolvedPath = path.resolve(artifactPath)
      const encoded =
        path.dirname(resolvedPath) === resolvedRoot
          ? parseSealedArtifactName(path.basename(resolvedPath), stem, includesSourceIdentity)
          : null
      if (encoded === null)
      {
        return yield* cartographerError(
          'generation_not_found',
          'Proposal analysis artifact identity could not be verified.',
        )
      }
      const bytes = yield* Effect.tryPromise({
        try: async () =>
        {
          const info = await NodeFSP.lstat(resolvedPath)
          if (!info.isFile() || info.size > GENERATION_MAX_ARTIFACT_BYTES)
          {
            throw new Error('analysis artifact is not a bounded regular file')
          }
          const content = await NodeFSP.readFile(resolvedPath)
          if (content.byteLength !== info.size)
          {
            throw new Error('analysis artifact changed while it was being verified')
          }
          return content
        },
        catch: () =>
          cartographerError(
            'generation_not_found',
            'Proposal analysis artifact identity could not be verified.',
          ),
      })
      if (sha256(bytes) !== encoded.artifactSha256 || !identityMatches(bytes))
      {
        return yield* cartographerError(
          'generation_not_found',
          'Proposal analysis artifact identity could not be verified.',
        )
      }
      return { path: resolvedPath, byteLength: bytes.byteLength, bytes, ...encoded }
    },
  )

  const restartCleanupArtifactRows = yield* sql<{ readonly artifactRoot: string }>`
    SELECT artifact_root AS "artifactRoot"
    FROM proposal_generations
    WHERE state IN ('queued', 'preparing', 'analyzing')
      OR (state = 'abandoned' AND error_code = 'server-restarted')
  `.pipe(Effect.mapError(sqlFailure('ProposalGenerationService.readStartupArtifacts')))
  yield* sql`
    UPDATE proposal_generations
    SET
      state = 'abandoned',
      error_code = 'server-restarted',
      updated_at = ${DateTime.formatIso(yield* DateTime.now)}
    WHERE state IN ('queued', 'preparing', 'analyzing')
  `.pipe(Effect.mapError(sqlFailure('ProposalGenerationService.abandonStartup')))
  yield* Effect.forEach(
    restartCleanupArtifactRows,
    (row) => cleanupArtifactRoot(row.artifactRoot),
    {
      concurrency: 4,
      discard: true,
    },
  )

  const retentionNow = yield* DateTime.now
  const retentionCutoffMs = DateTime.toEpochMillis(retentionNow) - GENERATION_RETENTION_GRACE_MS
  const retentionCutoff = DateTime.formatIso(DateTime.makeUnsafe(retentionCutoffMs))
  const expiredRows = yield* sql<{
    readonly generationId: ProposalGenerationId
    readonly artifactRoot: string
  }>`
    SELECT
      generation_id AS "generationId",
      artifact_root AS "artifactRoot"
    FROM proposal_generations AS candidate
    WHERE candidate.updated_at < ${retentionCutoff}
      AND NOT (
        (
          candidate.state = 'ready'
          AND candidate.rowid = (
            SELECT retained.rowid
            FROM proposal_generations AS retained
            WHERE retained.revision_id = candidate.revision_id
              AND retained.state = 'ready'
            ORDER BY retained.created_at DESC, retained.rowid DESC
            LIMIT 1
          )
        )
        OR (
          candidate.state = 'abandoned'
          AND candidate.error_code = 'server-restarted'
          AND candidate.rowid = (
            SELECT retained.rowid
            FROM proposal_generations AS retained
            WHERE retained.revision_id = candidate.revision_id
              AND retained.state = 'abandoned'
              AND retained.error_code = 'server-restarted'
            ORDER BY retained.created_at DESC, retained.rowid DESC
            LIMIT 1
          )
        )
      )
    ORDER BY candidate.created_at, candidate.rowid
  `.pipe(Effect.mapError(sqlFailure('ProposalGenerationService.readRetentionCandidates')))
  yield* Effect.forEach(
    expiredRows,
    (row) =>
      sql`
        DELETE FROM proposal_generations
        WHERE generation_id = ${row.generationId}
      `.pipe(Effect.mapError(sqlFailure('ProposalGenerationService.deleteExpiredGeneration'))),
    { discard: true },
  )
  yield* Effect.forEach(expiredRows, (row) => cleanupArtifactRoot(row.artifactRoot), {
    concurrency: 4,
    discard: true,
  })

  const retainedArtifactRows = yield* sql<{ readonly artifactRoot: string }>`
    SELECT artifact_root AS "artifactRoot"
    FROM proposal_generations
  `.pipe(Effect.mapError(sqlFailure('ProposalGenerationService.readRetainedArtifacts')))
  const retainedArtifactRoots = new Set(
    retainedArtifactRows.map((row) => path.resolve(row.artifactRoot)),
  )
  yield* Effect.tryPromise({
    try: async () =>
    {
      await NodeFSP.mkdir(generationsRoot, { recursive: true })
      const entries = await NodeFSP.readdir(generationsRoot, { withFileTypes: true })
      const orphanRoots: string[] = []
      for (const entry of entries)
      {
        if (!entry.isDirectory()) continue
        const artifactRoot = path.resolve(path.join(generationsRoot, entry.name))
        if (retainedArtifactRoots.has(artifactRoot)) continue
        const stat = await NodeFSP.stat(artifactRoot)
        if (stat.mtimeMs <= retentionCutoffMs)
        {
          orphanRoots.push(artifactRoot)
        }
      }
      return orphanRoots
    },
    catch: (cause) => new ProposalGenerationRetentionError({ cause }),
  }).pipe(
    Effect.flatMap((orphanRoots) =>
      Effect.forEach(orphanRoots, cleanupArtifactRoot, { concurrency: 4, discard: true }),
    ),
    Effect.catch((cause) =>
      Effect.logWarning('proposal generation orphan sweep failed', {
        cause,
        generationsRoot,
      }),
    ),
  )

  const runGit = Effect.fn('ProposalGenerationService.runGit')(function* (
    cwd: string,
    args: ReadonlyArray<string>,
    env?: NodeJS.ProcessEnv,
    nonzeroFailure: 'process-failed' | 'materialization-failed' = 'process-failed',
  )
  {
    const result = yield* processRunner
      .run({
        command: 'git',
        args: ['-C', cwd, ...args],
        env,
        timeout: 30_000,
        maxOutputBytes: GENERATION_MAX_PROCESS_OUTPUT_BYTES,
      })
      .pipe(
        Effect.mapError(() =>
          generationError('process-failed', 'Git tree materialization process failed.'),
        ),
      )
    if (result.code !== 0)
    {
      return yield* generationError(
        nonzeroFailure,
        nonzeroFailure === 'materialization-failed'
          ? 'A retained proposal tree is no longer available.'
          : 'Git tree materialization process failed.',
      )
    }
    return result.stdout.trim()
  })

  const materializeTree = Effect.fn('ProposalGenerationService.materializeTree')(function* (
    cwd: string,
    retainedRef: string,
    expectedTreeOid: string,
    destination: string,
  )
  {
    yield* fileSystem.makeDirectory(destination, { recursive: true }).pipe(
      Effect.uninterruptible,
      Effect.mapError(() =>
        generationError('io-failed', 'Proposal tree storage could not be created.'),
      ),
    )
    const resolvedTreeOid = yield* runGit(
      cwd,
      ['rev-parse', '--verify', `${retainedRef}^{tree}`],
      undefined,
      'materialization-failed',
    )
    if (resolvedTreeOid !== expectedTreeOid)
    {
      return yield* generationError(
        'materialization-failed',
        'A retained proposal tree no longer matches its persisted revision identity.',
      )
    }
    yield* Effect.tryPromise({
      try: (signal) =>
        materializeExactGitTreeIntoCache({
          repositoryRoot: cwd,
          treeOid: resolvedTreeOid,
          cacheRoot: path.dirname(destination),
          destinationRoot: destination,
          signal,
          limits: {
            maxFileCount: GENERATION_MAX_REPOSITORY_FILES,
            maxByteCount: GENERATION_MAX_REPOSITORY_BYTES,
          },
        }),
      catch: () => generationError('io-failed', 'Git tree materialization failed.'),
    })
  })

  const hasDirtySubmodules = Effect.fn('ProposalGenerationService.hasDirtySubmodules')(function* (
    cwd: string,
  )
  {
    const submoduleRows = yield* runGit(cwd, ['ls-files', '--stage', '-z'])
    const submodulePaths = submoduleRows
      .split('\0')
      .flatMap((record) => /^160000 [0-9a-f]{40,64} \d\t([\s\S]+)$/u.exec(record)?.[1] ?? [])
    if (submodulePaths.length === 0) return false
    const submoduleStatus = yield* runGit(cwd, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--ignore-submodules=none',
      '--',
      ...submodulePaths,
    ])
    return submoduleStatus.length > 0
  })

  const snapshotCurrent = Effect.fn('ProposalGenerationService.snapshotCurrent')(function* (
    cwd: string,
    artifactRoot: string,
  )
  {
    if (yield* hasDirtySubmodules(cwd))
    {
      return yield* generationError(
        'materialization-failed',
        'Dirty submodules are unsupported by proposal snapshot policy v1.',
      )
    }
    const indexPath = path.join(artifactRoot, `freshness-${yield* crypto.randomUUIDv4}`)
    const snapshot = yield* Effect.tryPromise({
      try: (signal) =>
        captureExactGitSnapshot({
          repositoryRoot: cwd,
          indexPath,
          signal,
          limits: {
            maxFileCount: GENERATION_MAX_REPOSITORY_FILES,
            maxByteCount: GENERATION_MAX_REPOSITORY_BYTES,
          },
        }),
      catch: () => generationError('io-failed', 'Git worktree snapshot capture failed.'),
    })
    if (snapshot.headOid === null)
    {
      return yield* generationError(
        'materialization-failed',
        'Proposal snapshots require a repository with an existing HEAD commit.',
      )
    }
    return { headCommitOid: snapshot.headOid, treeOid: snapshot.treeOid }
  })

  const readInternal = Effect.fn('ProposalGenerationService.readInternal')(function* (
    generationId: ProposalGenerationId,
  )
  {
    const row = yield* getRow({ generationId }).pipe(
      Effect.mapError(sqlFailure('ProposalGenerationService.get')),
    )
    if (Option.isNone(row))
    {
      return yield* generationError('not-found', 'Proposal analysis generation was not found.')
    }
    return row.value
  })

  const deriveFreshness = Effect.fn('ProposalGenerationService.deriveFreshness')(function* (
    row: GenerationRow,
  )
  {
    if (row.state !== 'ready') return 'fresh' as const
    const selected = yield* proposalService
      .get({
        proposalId: row.proposalId as ProposalId,
        revision: row.revision,
      })
      .pipe(
        Effect.mapError(() =>
          generationError('not-found', 'The proposal revision for this generation was not found.'),
        ),
      )
    const current = yield* snapshotCurrent(
      selected.proposal.worktree.rootPath,
      row.artifactRoot,
    ).pipe(Effect.option)
    if (Option.isNone(current)) return 'worktree-changed' as const
    if (current.value.headCommitOid !== selected.revision.baseSnapshot.headCommitOid)
    {
      return 'base-changed' as const
    }
    if (current.value.treeOid !== selected.revision.baseSnapshot.workingTreeOid)
    {
      return 'worktree-changed' as const
    }
    const analyzer = yield* cartographerAnalyzer.identify.pipe(Effect.option)
    if (Option.isNone(analyzer) || analyzer.value.fingerprint !== row.analyzerVersion)
    {
      return 'analyzer-changed' as const
    }
    return 'fresh' as const
  })

  const updateGeneration = (
    row: GenerationRow,
    patch: Partial<
      Pick<
        GenerationRow,
        | 'state'
        | 'analyzerVersion'
        | 'baseGraphPath'
        | 'proposedGraphPath'
        | 'impactPath'
        | 'impactProjectionPath'
        | 'errorCode'
      >
    >,
  ) =>
    Effect.gen(function* ()
    {
      const updatedAt = DateTime.formatIso(yield* DateTime.now)
      const next: GenerationRow = { ...row, ...patch, updatedAt }
      yield* updateRow({
        generationId: next.generationId,
        state: next.state,
        analyzerVersion: next.analyzerVersion,
        baseGraphPath: next.baseGraphPath,
        proposedGraphPath: next.proposedGraphPath,
        impactPath: next.impactPath,
        impactProjectionPath: next.impactProjectionPath,
        errorCode: next.errorCode,
        updatedAt,
      }).pipe(Effect.mapError(sqlFailure('ProposalGenerationService.update')))
      return next
    })

  const runGeneration = Effect.fn('ProposalGenerationService.runGeneration')(function* (
    initial: GenerationRow,
    revision: ProposalRevision,
    cwd: string,
  )
  {
    let row = yield* updateGeneration(initial, { state: 'preparing' })
    const baseRoot = path.join(row.artifactRoot, 'base')
    const proposedRoot = path.join(row.artifactRoot, 'proposed')
    yield* fileSystem.makeDirectory(row.artifactRoot, { recursive: true }).pipe(
      Effect.uninterruptible,
      Effect.mapError(() =>
        generationError('io-failed', 'Proposal analysis storage could not be created.'),
      ),
    )
    yield* materializeTree(
      cwd,
      revision.baseSnapshot.retainedRef,
      revision.baseSnapshot.workingTreeOid,
      baseRoot,
    )
    yield* materializeTree(
      cwd,
      revision.proposedRetainedRef,
      revision.proposedTreeOid,
      proposedRoot,
    )
    row = yield* updateGeneration(row, { state: 'analyzing' })

    const analysis = yield* cartographerAnalyzer
      .analyzeTrees({
        baseRoot,
        proposedRoot,
        outDir: row.artifactRoot,
        baseRef: revision.baseSnapshot.workingTreeOid,
        proposedRef: revision.proposedTreeOid,
        implementationChangedFileCount: revision.manifest.changedFileCount,
      })
      .pipe(
        withMetrics({ timer: architectureComparisonGenerationDuration }),
        Effect.mapError(analyzerGenerationError),
      )
    if (analysis.process.code !== 0)
    {
      return yield* generationError('process-failed', 'Architecture analysis failed.')
    }
    const manifest = decodeManifest(analysis.process.stdout)
    if (!manifest)
    {
      return yield* generationError(
        'analysis-failed',
        'Architecture analysis returned an invalid manifest.',
      )
    }
    if (manifest.analyzerVersion !== analysis.fingerprint)
    {
      return yield* generationError(
        'analysis-failed',
        'Architecture analyzer identity did not match the launched executable.',
      )
    }
    const proposedSourceSha256 = yield* Effect.tryPromise({
      try: () => digestMaterializedRoot(proposedRoot),
      catch: () =>
        generationError(
          'io-failed',
          'The materialized proposed tree identity could not be sealed.',
        ),
    })
    const baseGraph = yield* sealArtifact(
      row.artifactRoot,
      path.join(row.artifactRoot, manifest.baseGraph),
      'base.graph',
      (bytes) => graphArtifactMatches(bytes, revision.baseSnapshot.workingTreeOid),
    )
    const proposedGraph = yield* sealArtifact(
      row.artifactRoot,
      path.join(row.artifactRoot, manifest.proposedGraph),
      'proposed.graph',
      (bytes) => graphArtifactMatches(bytes, revision.proposedTreeOid),
      proposedSourceSha256,
    )
    const impact = yield* sealArtifact(
      row.artifactRoot,
      path.join(row.artifactRoot, manifest.impact),
      'impact.graph-diff-v1',
      (bytes) =>
        impactArtifactMatches(
          bytes,
          revision.baseSnapshot.workingTreeOid,
          revision.proposedTreeOid,
        ),
    )
    const impactProjection = yield* sealArtifact(
      row.artifactRoot,
      path.join(row.artifactRoot, manifest.impactProjection),
      'impact.projection-v1',
      (bytes) =>
        impactProjectionArtifactMatches(
          bytes,
          revision.baseSnapshot.workingTreeOid,
          revision.proposedTreeOid,
          `sha256:${baseGraph.sha256}`,
          `sha256:${proposedGraph.sha256}`,
          `sha256:${impact.sha256}`,
          analysis.fingerprint,
          revision.manifest.changedFileCount,
        ),
    )
    const artifactBytes =
      baseGraph.byteLength +
      proposedGraph.byteLength +
      impact.byteLength +
      impactProjection.byteLength
    if (!Number.isSafeInteger(artifactBytes) || artifactBytes > GENERATION_MAX_ARTIFACT_BYTES)
    {
      return yield* generationError(
        'limit-exceeded',
        'Architecture analysis artifacts exceed the configured output limit.',
      )
    }
    yield* updateGeneration(row, {
      state: 'ready',
      analyzerVersion: analysis.fingerprint,
      baseGraphPath: baseGraph.path,
      proposedGraphPath: proposedGraph.path,
      impactPath: impact.path,
      impactProjectionPath: impactProjection.path,
      errorCode: null,
    })
  })

  const deletedThreadError = () =>
    generationError('scope-mismatch', 'Proposal analysis cannot start for a deleted thread.')

  const closingServiceError = () =>
    generationError('process-failed', 'Proposal analysis cannot start while the server restarts.')

  const prepareStart = Effect.fn('ProposalGenerationService.prepareStart')(function* (
    input: ProposalGenerationStartInput,
    exactRevisionId: ProposalRevisionId,
  )
  {
    if (deletedThreads.has(input.threadId))
    {
      return yield* deletedThreadError()
    }
    const selected = yield* proposalService.get({
      proposalId: input.proposalId,
      ...(input.revision === undefined ? {} : { revision: input.revision }),
    })
    if (selected.proposal.sourceThreadId !== input.threadId)
    {
      return yield* generationError(
        'scope-mismatch',
        'The proposal does not belong to this source thread.',
      )
    }
    if (selected.revision.revisionId !== exactRevisionId)
    {
      return yield* generationError(
        'scope-mismatch',
        'The admitted proposal revision no longer matches its exact revision identity.',
      )
    }
    if (
      selected.revision.baseSnapshot.fileCount > GENERATION_MAX_REPOSITORY_FILES ||
      selected.revision.baseSnapshot.byteCount > GENERATION_MAX_REPOSITORY_BYTES
    )
    {
      return yield* generationError(
        'limit-exceeded',
        'The captured repository exceeds the exact analysis limits.',
      )
    }
    const analyzer = yield* cartographerAnalyzer.identify.pipe(
      Effect.mapError(analyzerGenerationError),
    )
    if (deletedThreads.has(input.threadId))
    {
      return yield* deletedThreadError()
    }
    return { selected, analyzer }
  })

  const startUnlocked = Effect.fn('ProposalGenerationService.startUnlocked')(function* (
    input: ProposalGenerationStartInput,
    admission: Effect.Success<ReturnType<typeof prepareStart>>,
    architectureAdmissionKey: string,
    leaseFence: ArchitectureAdmissionRepository.ArchitectureAdmissionLeaseFence,
  )
  {
    if (yield* Ref.get(serviceClosing))
    {
      return yield* closingServiceError()
    }
    if (deletedThreads.has(input.threadId))
    {
      return yield* deletedThreadError()
    }
    const { selected, analyzer } = admission
    const generationId = ProposalGenerationId.make(
      yield* crypto.randomUUIDv4.pipe(
        Effect.mapError(() =>
          generationError('persistence-failed', 'A proposal generation ID could not be created.'),
        ),
      ),
    )
    const createdAt = DateTime.formatIso(yield* DateTime.now)
    const artifactRoot = path.join(config.stateDir, 'cartographer', 'generations', generationId)
    const row: GenerationRow = {
      generationId,
      proposalId: selected.proposal.proposalId,
      revisionId: selected.revision.revisionId,
      revision: selected.revision.revision,
      threadId: input.threadId,
      state: 'queued',
      authority: 'authoritative',
      workspaceSnapshotTreeOid: selected.revision.baseSnapshot.workingTreeOid,
      analyzerVersion: analyzer.fingerprint,
      artifactRoot,
      baseGraphPath: null,
      proposedGraphPath: null,
      impactPath: null,
      impactProjectionPath: null,
      architectureAdmissionKey,
      errorCode: null,
      createdAt,
      updatedAt: createdAt,
    }
    const insertGeneration = insertRow(row).pipe(
      Effect.mapError(sqlFailure('ProposalGenerationService.insert')),
    )
    yield* sql
      .withTransaction(
        Effect.gen(function* ()
        {
          yield* requireActiveAdmissionLease(leaseFence, architectureAdmissionKey)
          yield* insertGeneration
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          isProposalGenerationError(cause)
            ? cause
            : sqlFailure('ProposalGenerationService.insert')(),
        ),
      )
    if (deletedThreads.has(input.threadId))
    {
      yield* updateGeneration(row, {
        state: 'cancelled',
        errorCode: 'thread-deleted',
      }).pipe(Effect.ignore)
      return yield* deletedThreadError()
    }

    const activeKey = input.threadId
    const currentFibers = yield* Ref.get(activeFibers)
    const previous = currentFibers.get(activeKey)
    if (previous)
    {
      previous.cancellation.state = 'cancelled'
      previous.cancellation.errorCode = 'superseded'
      yield* Fiber.interrupt(previous.fiber)
      const previousExit = yield* Fiber.await(previous.fiber)
      if (Exit.isFailure(previousExit))
      {
        yield* cleanupArtifactRoot(previous.row.artifactRoot)
        yield* updateGeneration(previous.row, {
          state: 'cancelled',
          errorCode: previous.cancellation.errorCode,
        }).pipe(Effect.ignore)
      }
    }
    if (deletedThreads.has(input.threadId))
    {
      yield* updateGeneration(row, {
        state: 'cancelled',
        errorCode: 'thread-deleted',
      }).pipe(Effect.ignore)
      return yield* deletedThreadError()
    }
    const cancellation: ActiveGeneration['cancellation'] = {
      state: 'cancelled',
      errorCode: 'superseded',
    }
    const work = concurrency
      .withPermit(runGeneration(row, selected.revision, selected.proposal.worktree.rootPath))
      .pipe(
        Effect.onInterrupt(() =>
          Effect.gen(function* ()
          {
            const closing = yield* Ref.get(serviceClosing)
            yield* cleanupArtifactRoot(row.artifactRoot)
            yield* updateGeneration(row, {
              state: closing ? 'abandoned' : cancellation.state,
              errorCode: closing ? 'server-restarted' : cancellation.errorCode,
            }).pipe(Effect.ignore)
          }),
        ),
        Effect.catch((error) =>
          Effect.gen(function* ()
          {
            yield* cleanupArtifactRoot(row.artifactRoot)
            yield* updateGeneration(row, {
              state: 'failed',
              errorCode: error.failure,
            }).pipe(Effect.ignore)
          }),
        ),
        Effect.ensuring(
          Ref.update(activeFibers, (fibers) =>
          {
            const next = new Map(fibers)
            next.delete(activeKey)
            return next
          }),
        ),
      )
    const fiber = yield* work.pipe(Effect.forkIn(workerScope))
    yield* Ref.update(activeFibers, (fibers) =>
    {
      const next = new Map(fibers)
      next.set(activeKey, { fiber, row, cancellation })
      return next
    })
    if (deletedThreads.has(input.threadId))
    {
      cancellation.errorCode = 'thread-deleted'
      cancellation.state = 'cancelled'
      yield* Fiber.interrupt(fiber)
      const interrupted = yield* Fiber.await(fiber)
      if (Exit.isFailure(interrupted))
      {
        yield* cleanupArtifactRoot(row.artifactRoot)
        yield* updateGeneration(row, {
          state: cancellation.state,
          errorCode: cancellation.errorCode,
        }).pipe(Effect.ignore)
      }
      return yield* deletedThreadError()
    }
    return publicGeneration(row, 'fresh')
  })

  const startAdmitted: ProposalGenerationService['Service']['startAdmitted'] = Effect.fn(
    'ProposalGenerationService.startAdmitted',
  )(function* (input)
  {
    const admission = yield* prepareStart(input, input.revisionId)
    const lock = yield* lockForThread(input.threadId)
    return yield* lock.withPermit(
      serviceLifecycle.withPermit(
        Effect.gen(function* ()
        {
          if (input.analyzerFingerprint !== admission.analyzer.fingerprint)
          {
            return yield* generationError(
              'analysis-failed',
              'The admitted analyzer fingerprint is no longer available.',
            )
          }
          yield* requireActiveAdmissionLease(input.leaseFence, input.admissionKey)
          const existing = yield* latestExactRow({
            proposalId: admission.selected.proposal.proposalId,
            threadId: input.threadId,
            revisionId: input.revisionId,
            analyzerVersion: admission.analyzer.fingerprint,
            architectureAdmissionKey: input.admissionKey,
          }).pipe(Effect.mapError(sqlFailure('ProposalGenerationService.readAdmittedGeneration')))
          if (
            Option.isSome(existing) &&
            (['queued', 'preparing', 'analyzing'].includes(existing.value.state) ||
              (!input.forceNewAttempt && existing.value.state === 'ready'))
          )
          {
            return publicGeneration(existing.value, yield* deriveFreshness(existing.value))
          }
          return yield* startUnlocked(input, admission, input.admissionKey, input.leaseFence)
        }),
      ),
    )
  })

  const cancelThread: ProposalGenerationService['Service']['cancelThread'] = (threadId) =>
    Effect.sync(() => deletedThreads.add(threadId)).pipe(
      Effect.andThen(
        Effect.flatMap(lockForThread(threadId), (lock) =>
          lock.withPermit(
            serviceLifecycle.withPermit(
              Effect.gen(function* ()
              {
                const active = (yield* Ref.get(activeFibers)).get(threadId)
                if (active)
                {
                  active.cancellation.errorCode = 'thread-deleted'
                  active.cancellation.state = 'cancelled'
                  yield* Fiber.interrupt(active.fiber)
                  const activeExit = yield* Fiber.await(active.fiber)
                  if (Exit.isFailure(activeExit))
                  {
                    yield* cleanupArtifactRoot(active.row.artifactRoot)
                    yield* updateGeneration(active.row, {
                      state: active.cancellation.state,
                      errorCode: active.cancellation.errorCode,
                    }).pipe(Effect.ignore)
                  }
                }
                yield* sql`
                  UPDATE proposal_generations
                  SET
                    state = 'cancelled',
                    error_code = 'thread-deleted',
                    updated_at = ${DateTime.formatIso(yield* DateTime.now)}
                  WHERE thread_id = ${threadId}
                    AND state IN ('queued', 'preparing', 'analyzing')
                `.pipe(
                  Effect.mapError(sqlFailure('ProposalGenerationService.cancelThreadGenerations')),
                )
              }),
            ),
          ),
        ),
      ),
    )

  const get: ProposalGenerationService['Service']['get'] = Effect.fn(
    'ProposalGenerationService.get',
  )(function* (input)
  {
    const row = yield* readInternal(input.generationId)
    if (row.threadId !== input.threadId)
    {
      return yield* generationError(
        'scope-mismatch',
        'The proposal generation does not belong to this thread.',
      )
    }
    return publicGeneration(row, yield* deriveFreshness(row))
  })

  const latest: ProposalGenerationService['Service']['latest'] = Effect.fn(
    'ProposalGenerationService.latest',
  )(function* (input)
  {
    const selected = yield* proposalService
      .get({
        proposalId: input.proposalId,
        ...(input.revision === undefined ? {} : { revision: input.revision }),
      })
      .pipe(
        Effect.mapError(() => generationError('not-found', 'The proposal revision was not found.')),
      )
    if (selected.proposal.sourceThreadId !== input.threadId)
    {
      return yield* generationError(
        'scope-mismatch',
        'The proposal does not belong to this source thread.',
      )
    }
    const row = yield* latestRow({
      proposalId: input.proposalId,
      revision: selected.revision.revision,
    }).pipe(Effect.mapError(sqlFailure('ProposalGenerationService.latest')))
    if (Option.isNone(row)) return null
    return publicGeneration(row.value, yield* deriveFreshness(row.value))
  })

  const latestAdmitted: ProposalGenerationService['Service']['latestAdmitted'] = Effect.fn(
    'ProposalGenerationService.latestAdmitted',
  )(function* (input)
  {
    const row = yield* latestAdmissionRow(input).pipe(
      Effect.mapError(sqlFailure('ProposalGenerationService.latestAdmitted')),
    )
    if (Option.isNone(row)) return null
    return {
      generationId: row.value.generationId,
      state: row.value.state,
      errorCode: row.value.errorCode,
    }
  })

  const resolveArchitectureTarget: ProposalGenerationService['Service']['resolveArchitectureTarget'] =
    Effect.fn('ProposalGenerationService.resolveArchitectureTarget')(
      function* (threadId, generationId)
      {
        const row = yield* readInternal(generationId).pipe(
          Effect.mapError(() =>
            cartographerError('generation_not_found', 'Proposal generation was not found.'),
          ),
        )
        if (
          row.threadId !== threadId ||
          row.state !== 'ready' ||
          row.baseGraphPath === null ||
          row.proposedGraphPath === null ||
          row.impactPath === null ||
          row.impactProjectionPath === null
        )
        {
          return yield* cartographerError(
            'generation_not_found',
            'A ready proposal generation was not found for this thread.',
          )
        }
        const selected = yield* proposalService
          .get({
            proposalId: row.proposalId as ProposalId,
            revision: row.revision,
          })
          .pipe(
            Effect.mapError(() =>
              cartographerError(
                'generation_not_found',
                'The proposal revision for this generation could not be verified.',
              ),
            ),
          )
        if (
          selected.proposal.sourceThreadId !== threadId ||
          selected.revision.revisionId !== row.revisionId ||
          selected.revision.baseSnapshot.workingTreeOid !== row.workspaceSnapshotTreeOid
        )
        {
          return yield* cartographerError(
            'generation_not_found',
            'The proposal revision for this generation could not be verified.',
          )
        }
        const verifyRetainedTree = Effect.fn(
          'ProposalGenerationService.resolveArchitectureTarget.verifyRetainedTree',
        )(function* (retainedRef: string, expectedTreeOid: string)
        {
          const resolvedTreeOid = yield* runGit(selected.proposal.worktree.rootPath, [
            'rev-parse',
            '--verify',
            `${retainedRef}^{tree}`,
          ]).pipe(
            Effect.mapError(() =>
              cartographerError(
                'generation_not_found',
                'A retained proposal tree no longer matches its persisted revision identity.',
              ),
            ),
          )
          if (resolvedTreeOid !== expectedTreeOid)
          {
            return yield* cartographerError(
              'generation_not_found',
              'A retained proposal tree no longer matches its persisted revision identity.',
            )
          }
        })
        yield* verifyRetainedTree(
          selected.revision.baseSnapshot.retainedRef,
          selected.revision.baseSnapshot.workingTreeOid,
        )
        yield* verifyRetainedTree(
          selected.revision.proposedRetainedRef,
          selected.revision.proposedTreeOid,
        )
        const baseGraph = yield* verifySealedArtifact(
          row.artifactRoot,
          row.baseGraphPath,
          'base.graph',
          false,
          (bytes) => graphArtifactMatches(bytes, selected.revision.baseSnapshot.workingTreeOid),
        )
        const proposedGraph = yield* verifySealedArtifact(
          row.artifactRoot,
          row.proposedGraphPath,
          'proposed.graph',
          true,
          (bytes) => graphArtifactMatches(bytes, selected.revision.proposedTreeOid),
        )
        const impact = yield* verifySealedArtifact(
          row.artifactRoot,
          row.impactPath,
          'impact.graph-diff-v1',
          false,
          (bytes) =>
            impactArtifactMatches(
              bytes,
              selected.revision.baseSnapshot.workingTreeOid,
              selected.revision.proposedTreeOid,
            ),
        )
        const impactProjection = yield* verifySealedArtifact(
          row.artifactRoot,
          row.impactProjectionPath,
          'impact.projection-v1',
          false,
          (bytes) =>
            impactProjectionArtifactMatches(
              bytes,
              selected.revision.baseSnapshot.workingTreeOid,
              selected.revision.proposedTreeOid,
              `sha256:${baseGraph.artifactSha256}`,
              `sha256:${proposedGraph.artifactSha256}`,
              `sha256:${impact.artifactSha256}`,
              row.analyzerVersion,
              selected.revision.manifest.changedFileCount,
            ),
        )
        if (
          impactProjection.byteLength > 2 * 1024 * 1024 ||
          baseGraph.byteLength +
            proposedGraph.byteLength +
            impact.byteLength +
            impactProjection.byteLength >
            GENERATION_MAX_ARTIFACT_BYTES
        )
        {
          return yield* cartographerError(
            'generation_not_found',
            'Proposal analysis artifact identity could not be verified.',
          )
        }
        const proposedRoot = path.join(row.artifactRoot, 'proposed')
        const actualSourceSha256 = yield* Effect.tryPromise({
          try: () => digestMaterializedRoot(proposedRoot),
          catch: () =>
            cartographerError(
              'generation_not_found',
              'The materialized proposed tree identity could not be verified.',
            ),
        })
        if (
          proposedGraph.sourceSha256 === undefined ||
          actualSourceSha256 !== proposedGraph.sourceSha256
        )
        {
          return yield* cartographerError(
            'generation_not_found',
            'The materialized proposed tree identity could not be verified.',
          )
        }
        return {
          generation: publicGeneration(
            row,
            yield* deriveFreshness(row).pipe(
              Effect.mapError(() =>
                cartographerError(
                  'generation_not_found',
                  'Proposal generation freshness could not be verified.',
                ),
              ),
            ),
          ),
          proposedRoot,
          baseGraphPath: baseGraph.path,
          proposedGraphPath: proposedGraph.path,
          impactPath: impact.path,
          impactProjectionPath: impactProjection.path,
        }
      },
    )

  const resolveImpactTarget: ProposalGenerationService['Service']['resolveImpactTarget'] =
    Effect.fn('ProposalGenerationService.resolveImpactTarget')(function* (threadId, generationId)
    {
      const row = yield* readInternal(generationId).pipe(
        Effect.mapError(() =>
          cartographerError('generation_not_found', 'Proposal generation was not found.'),
        ),
      )
      if (
        row.threadId !== threadId ||
        row.state !== 'ready' ||
        row.baseGraphPath === null ||
        row.proposedGraphPath === null ||
        row.impactPath === null ||
        row.impactProjectionPath === null
      )
      {
        return yield* cartographerError(
          'generation_not_found',
          'A ready proposal generation was not found for this thread.',
        )
      }
      const selected = yield* proposalService
        .get({
          proposalId: row.proposalId as ProposalId,
          revision: row.revision,
        })
        .pipe(
          Effect.mapError(() =>
            cartographerError(
              'generation_not_found',
              'The proposal revision for this generation could not be verified.',
            ),
          ),
        )
      if (
        selected.proposal.sourceThreadId !== threadId ||
        selected.revision.revisionId !== row.revisionId ||
        selected.revision.baseSnapshot.workingTreeOid !== row.workspaceSnapshotTreeOid
      )
      {
        return yield* cartographerError(
          'generation_not_found',
          'The proposal revision for this generation could not be verified.',
        )
      }
      const verifyRetainedTree = Effect.fn(
        'ProposalGenerationService.resolveImpactTarget.verifyRetainedTree',
      )(function* (retainedRef: string, expectedTreeOid: string)
      {
        const resolvedTreeOid = yield* runGit(selected.proposal.worktree.rootPath, [
          'rev-parse',
          '--verify',
          `${retainedRef}^{tree}`,
        ]).pipe(
          Effect.mapError(() =>
            cartographerError(
              'generation_not_found',
              'A retained proposal tree no longer matches its persisted revision identity.',
            ),
          ),
        )
        if (resolvedTreeOid !== expectedTreeOid)
        {
          return yield* cartographerError(
            'generation_not_found',
            'A retained proposal tree no longer matches its persisted revision identity.',
          )
        }
      })
      yield* verifyRetainedTree(
        selected.revision.baseSnapshot.retainedRef,
        selected.revision.baseSnapshot.workingTreeOid,
      )
      yield* verifyRetainedTree(
        selected.revision.proposedRetainedRef,
        selected.revision.proposedTreeOid,
      )
      const impact = yield* verifySealedArtifact(
        row.artifactRoot,
        row.impactPath,
        'impact.graph-diff-v1',
        false,
        (bytes) =>
          impactArtifactMatches(
            bytes,
            selected.revision.baseSnapshot.workingTreeOid,
            selected.revision.proposedTreeOid,
          ),
      )
      const baseGraph = parseSealedArtifactName(
        path.basename(row.baseGraphPath),
        'base.graph',
        false,
      )
      const proposedGraph = parseSealedArtifactName(
        path.basename(row.proposedGraphPath),
        'proposed.graph',
        true,
      )
      if (baseGraph === null || proposedGraph === null)
      {
        return yield* cartographerError(
          'generation_not_found',
          'Proposal graph identity could not be verified.',
        )
      }
      if (
        path.dirname(path.resolve(row.baseGraphPath)) !== path.resolve(row.artifactRoot) ||
        path.dirname(path.resolve(row.proposedGraphPath)) !== path.resolve(row.artifactRoot)
      )
      {
        return yield* cartographerError(
          'generation_not_found',
          'Proposal graph containment could not be verified.',
        )
      }
      let diff: GraphDiff
      try
      {
        diff = parseGraphDiff(artifactObject(impact.bytes))
      }
      catch
      {
        return yield* cartographerError(
          'generation_not_found',
          'Proposal impact artifact could not be decoded.',
        )
      }
      const verified = yield* verifySealedArtifact(
        row.artifactRoot,
        row.impactProjectionPath,
        'impact.projection-v1',
        false,
        (bytes) =>
          impactProjectionArtifactMatches(
            bytes,
            selected.revision.baseSnapshot.workingTreeOid,
            selected.revision.proposedTreeOid,
            `sha256:${baseGraph.artifactSha256}`,
            `sha256:${proposedGraph.artifactSha256}`,
            `sha256:${impact.artifactSha256}`,
            row.analyzerVersion,
            selected.revision.manifest.changedFileCount,
          ),
      )
      if (verified.byteLength > 2 * 1024 * 1024)
      {
        return yield* cartographerError(
          'generation_not_found',
          'Proposal impact projection exceeds its bounded transport size.',
        )
      }
      let projection: VerifiedImpactProjectionArtifact
      try
      {
        projection = parseVerifiedImpactProjection(artifactObject(verified.bytes))
      }
      catch
      {
        return yield* cartographerError(
          'generation_not_found',
          'Proposal impact projection could not be decoded.',
        )
      }
      return {
        diff,
        projection,
        impactDigest: `sha256:${impact.artifactSha256}`,
        impactProjectionDigest: `sha256:${verified.artifactSha256}`,
        repositoryRoot: selected.proposal.worktree.rootPath,
        baseTreeOid: selected.revision.baseSnapshot.workingTreeOid,
        proposedTreeOid: selected.revision.proposedTreeOid,
        baseGraphDigest: `sha256:${baseGraph.artifactSha256}`,
        proposedGraphDigest: `sha256:${proposedGraph.artifactSha256}`,
      }
    })

  return ProposalGenerationService.of({
    startAdmitted,
    get,
    latest,
    latestAdmitted,
    resolveArchitectureTarget,
    resolveImpactTarget,
    cancelThread,
  })
})

export const layer = Layer.effect(ProposalGenerationService, make).pipe(
  Layer.provideMerge(ArchitectureAdmissionRepository.layer),
)
