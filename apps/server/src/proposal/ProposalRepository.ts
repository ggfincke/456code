// apps/server/src/proposal/ProposalRepository.ts
// persists proposal identities, immutable revisions, and content-addressed blobs
// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off

import * as NodeCrypto from 'node:crypto'

import {
  PROPOSAL_SNAPSHOT_POLICY_V1,
  Proposal,
  ProposalError,
  ProposalRepositoryIdentity,
  ProposalRevision,
  ProposalRevisionManifest,
  ProposalSnapshotPolicy,
  type EnvironmentId,
  type OrchestrationProposedPlanId,
  type ProjectId,
  type ProposalId,
  type ProposalListInput,
  type ProposalProducerIdentity,
  type ProposalRevisionId,
  type ProposalSha256,
  type ThreadId,
} from '@t3tools/contracts'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import type { PreparedProposalRevision, ProposalContentBlob } from './ProposalGitEngine.ts'

interface ProposalRow
{
  readonly proposalId: string
  readonly environmentId: string
  readonly projectId: string
  readonly sourceThreadId: string
  readonly producerSessionId: string
  readonly producerInstanceId: string
  readonly repositoryIdentityJson: string
  readonly worktreeRootPath: string
  readonly worktreeGitDir: string
  readonly worktreeGitCommonDir: string
  readonly latestRevision: number
  readonly createdAt: string
  readonly updatedAt: string
}

interface ProposalRevisionRow
{
  readonly revisionId: string
  readonly proposalId: string
  readonly revision: number
  readonly headCommitOid: string
  readonly baseTreeOid: string
  readonly baseRetainedRef: string
  readonly baseFileCount: number
  readonly baseByteCount: number
  readonly snapshotPolicyJson: string
  readonly proposedTreeOid: string
  readonly proposedRetainedRef: string
  readonly manifestJson: string
  readonly manifestSha256: string
  readonly diffSha256: string
  readonly diffByteLength: number
  readonly narrativeSha256: string | null
  readonly narrativeByteLength: number | null
  readonly planId: string | null
  readonly planMarkdownSha256: string | null
  readonly createdAt: string
}

export interface AppendProposalRevisionInput
{
  readonly proposalId: ProposalId
  readonly revisionId: ProposalRevisionId
  readonly environmentId: EnvironmentId
  readonly projectId: ProjectId
  readonly sourceThreadId: ThreadId
  readonly producer: ProposalProducerIdentity
  readonly prepared: PreparedProposalRevision
  readonly narrative?: ProposalContentBlob
  readonly planId?: OrchestrationProposedPlanId
  readonly planMarkdownSha256?: ProposalSha256
  readonly createdAt: string
}

function proposalError(
  operation: string,
  code: ConstructorParameters<typeof ProposalError>[0]['code'],
  detail: string,
  proposalId?: ProposalId,
): ProposalError
{
  return new ProposalError({
    operation,
    code,
    detail,
    ...(proposalId === undefined ? {} : { proposalId }),
  })
}

function isProposalError(cause: unknown): cause is ProposalError
{
  return (
    typeof cause === 'object' && cause !== null && '_tag' in cause && cause._tag === 'ProposalError'
  )
}

function persistenceError(
  operation: string,
  cause: unknown,
  proposalId?: ProposalId,
): ProposalError
{
  if (isProposalError(cause)) return cause
  return proposalError(
    operation,
    'persistence-failed',
    cause instanceof Error ? cause.message : 'Proposal persistence failed.',
    proposalId,
  )
}

function parseStoredJson(
  json: string,
  operation: string,
  proposalId?: ProposalId,
): Effect.Effect<unknown, ProposalError>
{
  return Effect.try({
    try: () => JSON.parse(json) as unknown,
    catch: (cause) =>
      proposalError(
        operation,
        'persistence-failed',
        cause instanceof Error ? cause.message : 'Stored proposal JSON is invalid.',
        proposalId,
      ),
  })
}

const decodeRepositoryIdentity = Schema.decodeUnknownEffect(ProposalRepositoryIdentity)
const decodeProposal = Schema.decodeUnknownEffect(Proposal)
const decodeSnapshotPolicy = Schema.decodeUnknownEffect(ProposalSnapshotPolicy)
const decodeRevisionManifest = Schema.decodeUnknownEffect(ProposalRevisionManifest)
const decodeRevision = Schema.decodeUnknownEffect(ProposalRevision)

function decodeProposalRow(row: ProposalRow)
{
  return Effect.gen(function* ()
  {
    const repositoryJson = yield* parseStoredJson(
      row.repositoryIdentityJson,
      'ProposalRepository.decodeProposal',
      row.proposalId as ProposalId,
    )
    const repository = yield* decodeRepositoryIdentity(repositoryJson).pipe(
      Effect.mapError((cause) =>
        proposalError(
          'ProposalRepository.decodeProposal',
          'persistence-failed',
          cause.message,
          row.proposalId as ProposalId,
        ),
      ),
    )
    return yield* decodeProposal({
      proposalId: row.proposalId,
      environmentId: row.environmentId,
      projectId: row.projectId,
      sourceThreadId: row.sourceThreadId,
      producer: {
        providerSessionId: row.producerSessionId,
        providerInstanceId: row.producerInstanceId,
      },
      repository,
      worktree: {
        rootPath: row.worktreeRootPath,
        gitDir: row.worktreeGitDir,
        gitCommonDir: row.worktreeGitCommonDir,
      },
      latestRevision: row.latestRevision,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }).pipe(
      Effect.mapError((cause) =>
        proposalError(
          'ProposalRepository.decodeProposal',
          'persistence-failed',
          cause.message,
          row.proposalId as ProposalId,
        ),
      ),
    )
  })
}

function decodeRevisionRow(row: ProposalRevisionRow)
{
  return Effect.gen(function* ()
  {
    const policyJson = yield* parseStoredJson(
      row.snapshotPolicyJson,
      'ProposalRepository.decodeRevision',
      row.proposalId as ProposalId,
    )
    const policy = yield* decodeSnapshotPolicy(policyJson).pipe(
      Effect.mapError((cause) =>
        proposalError(
          'ProposalRepository.decodeRevision',
          'persistence-failed',
          cause.message,
          row.proposalId as ProposalId,
        ),
      ),
    )
    const manifestJson = yield* parseStoredJson(
      row.manifestJson,
      'ProposalRepository.decodeRevision',
      row.proposalId as ProposalId,
    )
    const actualManifestSha256 = NodeCrypto.createHash('sha256')
      .update(row.manifestJson, 'utf8')
      .digest('hex')
    if (actualManifestSha256 !== row.manifestSha256)
    {
      return yield* proposalError(
        'ProposalRepository.decodeRevision',
        'persistence-failed',
        `Stored proposal manifest '${row.manifestSha256}' failed its content hash check.`,
        row.proposalId as ProposalId,
      )
    }
    const manifest = yield* decodeRevisionManifest(manifestJson).pipe(
      Effect.mapError((cause) =>
        proposalError(
          'ProposalRepository.decodeRevision',
          'persistence-failed',
          cause.message,
          row.proposalId as ProposalId,
        ),
      ),
    )
    return yield* decodeRevision({
      proposalId: row.proposalId,
      revisionId: row.revisionId,
      revision: row.revision,
      baseSnapshot: {
        headCommitOid: row.headCommitOid,
        workingTreeOid: row.baseTreeOid,
        retainedRef: row.baseRetainedRef,
        fileCount: row.baseFileCount,
        byteCount: row.baseByteCount,
        policy,
      },
      proposedTreeOid: row.proposedTreeOid,
      proposedRetainedRef: row.proposedRetainedRef,
      manifest,
      manifestSha256: row.manifestSha256,
      diffSha256: row.diffSha256,
      diffByteLength: row.diffByteLength,
      ...(row.narrativeSha256 === null ? {} : { narrativeSha256: row.narrativeSha256 }),
      ...(row.narrativeByteLength === null ? {} : { narrativeByteLength: row.narrativeByteLength }),
      ...(row.planId === null ? {} : { planId: row.planId }),
      ...(row.planMarkdownSha256 === null ? {} : { planMarkdownSha256: row.planMarkdownSha256 }),
      createdAt: row.createdAt,
    }).pipe(
      Effect.mapError((cause) =>
        proposalError(
          'ProposalRepository.decodeRevision',
          'persistence-failed',
          cause.message,
          row.proposalId as ProposalId,
        ),
      ),
    )
  })
}

const proposalSelect = `
  SELECT
    p.proposal_id AS "proposalId",
    p.environment_id AS "environmentId",
    p.project_id AS "projectId",
    p.source_thread_id AS "sourceThreadId",
    p.producer_session_id AS "producerSessionId",
    p.producer_instance_id AS "producerInstanceId",
    p.repository_identity_json AS "repositoryIdentityJson",
    p.worktree_root_path AS "worktreeRootPath",
    p.worktree_git_dir AS "worktreeGitDir",
    p.worktree_git_common_dir AS "worktreeGitCommonDir",
    MAX(r.revision) AS "latestRevision",
    p.created_at AS "createdAt",
    p.updated_at AS "updatedAt"
  FROM proposals p
  JOIN proposal_revisions r ON r.proposal_id = p.proposal_id
`

const revisionSelect = `
  SELECT
    revision_id AS "revisionId",
    proposal_id AS "proposalId",
    revision,
    head_commit_oid AS "headCommitOid",
    base_tree_oid AS "baseTreeOid",
    base_retained_ref AS "baseRetainedRef",
    base_file_count AS "baseFileCount",
    base_byte_count AS "baseByteCount",
    snapshot_policy_json AS "snapshotPolicyJson",
    proposed_tree_oid AS "proposedTreeOid",
    proposed_retained_ref AS "proposedRetainedRef",
    manifest_json AS "manifestJson",
    manifest_sha256 AS "manifestSha256",
    diff_sha256 AS "diffSha256",
    diff_byte_length AS "diffByteLength",
    narrative_sha256 AS "narrativeSha256",
    narrative_byte_length AS "narrativeByteLength",
    plan_id AS "planId",
    plan_markdown_sha256 AS "planMarkdownSha256",
    created_at AS "createdAt"
  FROM proposal_revisions
`

export class ProposalRepository extends Context.Service<
  ProposalRepository,
  {
    readonly append: (
      input: AppendProposalRevisionInput,
    ) => Effect.Effect<
      { readonly proposal: Proposal; readonly revision: ProposalRevision },
      ProposalError
    >
    readonly list: (
      input: ProposalListInput,
    ) => Effect.Effect<ReadonlyArray<Proposal>, ProposalError>
    readonly get: (
      proposalId: ProposalId,
    ) => Effect.Effect<
      { readonly proposal: Proposal; readonly revisions: ReadonlyArray<ProposalRevision> },
      ProposalError
    >
    readonly findLatestByPlan: (input: {
      readonly sourceThreadId: ThreadId
      readonly planId: OrchestrationProposedPlanId
      readonly createdAtOrBefore?: string
    }) => Effect.Effect<
      { readonly proposal: Proposal; readonly revision: ProposalRevision } | null,
      ProposalError
    >
    readonly readBlob: (
      sha256: ProposalSha256,
      proposalId: ProposalId,
    ) => Effect.Effect<Uint8Array, ProposalError>
  }
>()('456code/proposal/ProposalRepository')
{}

export const make = Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient

  const append: ProposalRepository['Service']['append'] = Effect.fn('ProposalRepository.append')(
    function* (input)
    {
      const repositoryJson = JSON.stringify(input.prepared.repository)
      const snapshotPolicyJson = JSON.stringify(PROPOSAL_SNAPSHOT_POLICY_V1)
      const stored = yield* sql
        .withTransaction(
          Effect.gen(function* ()
          {
            yield* sql`
            INSERT INTO proposals (
              proposal_id,
              environment_id,
              project_id,
              source_thread_id,
              producer_session_id,
              producer_instance_id,
              repository_identity_json,
              worktree_root_path,
              worktree_git_dir,
              worktree_git_common_dir,
              created_at,
              updated_at
            )
            VALUES (
              ${input.proposalId},
              ${input.environmentId},
              ${input.projectId},
              ${input.sourceThreadId},
              ${input.producer.providerSessionId},
              ${input.producer.providerInstanceId},
              ${repositoryJson},
              ${input.prepared.worktree.rootPath},
              ${input.prepared.worktree.gitDir},
              ${input.prepared.worktree.gitCommonDir},
              ${input.createdAt},
              ${input.createdAt}
            )
            ON CONFLICT(proposal_id) DO NOTHING
          `

            const identityRows = yield* sql<{
              readonly environmentId: string
              readonly projectId: string
              readonly sourceThreadId: string
              readonly producerSessionId: string
              readonly producerInstanceId: string
              readonly repositoryIdentityJson: string
              readonly worktreeRootPath: string
              readonly worktreeGitDir: string
              readonly worktreeGitCommonDir: string
            }>`
            SELECT
              environment_id AS "environmentId",
              project_id AS "projectId",
              source_thread_id AS "sourceThreadId",
              producer_session_id AS "producerSessionId",
              producer_instance_id AS "producerInstanceId",
              repository_identity_json AS "repositoryIdentityJson",
              worktree_root_path AS "worktreeRootPath",
              worktree_git_dir AS "worktreeGitDir",
              worktree_git_common_dir AS "worktreeGitCommonDir"
            FROM proposals
            WHERE proposal_id = ${input.proposalId}
          `
            const identity = identityRows[0]
            if (
              !identity ||
              identity.environmentId !== input.environmentId ||
              identity.projectId !== input.projectId ||
              identity.sourceThreadId !== input.sourceThreadId ||
              identity.producerSessionId !== input.producer.providerSessionId ||
              identity.producerInstanceId !== input.producer.providerInstanceId ||
              identity.repositoryIdentityJson !== repositoryJson ||
              identity.worktreeRootPath !== input.prepared.worktree.rootPath ||
              identity.worktreeGitDir !== input.prepared.worktree.gitDir ||
              identity.worktreeGitCommonDir !== input.prepared.worktree.gitCommonDir
            )
            {
              return yield* proposalError(
                'ProposalRepository.append',
                'identity-mismatch',
                'An existing proposal cannot change its scope, producer, repository, or worktree identity.',
                input.proposalId,
              )
            }

            for (const blob of input.prepared.blobs)
            {
              yield* sql`
              INSERT INTO proposal_blobs (sha256, content, byte_length, created_at)
              VALUES (${blob.sha256}, ${blob.content}, ${blob.content.byteLength}, ${input.createdAt})
              ON CONFLICT(sha256) DO NOTHING
            `
            }
            if (input.narrative !== undefined)
            {
              yield* sql`
              INSERT INTO proposal_blobs (sha256, content, byte_length, created_at)
              VALUES (
                ${input.narrative.sha256},
                ${input.narrative.content},
                ${input.narrative.content.byteLength},
                ${input.createdAt}
              )
              ON CONFLICT(sha256) DO NOTHING
            `
            }

            const revisionRows = yield* sql<{ readonly revision: number }>`
            SELECT COALESCE(MAX(revision), 0) + 1 AS revision
            FROM proposal_revisions
            WHERE proposal_id = ${input.proposalId}
          `
            const revision = revisionRows[0]?.revision
            if (!revision || revision < 1)
            {
              return yield* proposalError(
                'ProposalRepository.append',
                'persistence-failed',
                'Could not allocate the next immutable proposal revision.',
                input.proposalId,
              )
            }

            yield* sql`
            INSERT INTO proposal_revisions (
              revision_id,
              proposal_id,
              revision,
              head_commit_oid,
              base_tree_oid,
              base_retained_ref,
              base_file_count,
              base_byte_count,
              snapshot_policy_json,
              proposed_tree_oid,
              proposed_retained_ref,
              manifest_json,
              manifest_sha256,
              diff_sha256,
              diff_byte_length,
              narrative_sha256,
              narrative_byte_length,
              plan_id,
              plan_markdown_sha256,
              created_at
            )
            VALUES (
              ${input.revisionId},
              ${input.proposalId},
              ${revision},
              ${input.prepared.headCommitOid},
              ${input.prepared.baseTreeOid},
              ${input.prepared.baseRetainedRef},
              ${input.prepared.baseFileCount},
              ${input.prepared.baseByteCount},
              ${snapshotPolicyJson},
              ${input.prepared.proposedTreeOid},
              ${input.prepared.proposedRetainedRef},
              ${input.prepared.manifestJson},
              ${input.prepared.manifestSha256},
              ${input.prepared.diffSha256},
              ${Buffer.byteLength(input.prepared.diff, 'utf8')},
              ${input.narrative?.sha256 ?? null},
              ${input.narrative?.content.byteLength ?? null},
              ${input.planId ?? null},
              ${input.planMarkdownSha256 ?? null},
              ${input.createdAt}
            )
          `
            yield* sql`
            UPDATE proposals
            SET updated_at = ${input.createdAt}
            WHERE proposal_id = ${input.proposalId}
          `
            const rows = yield* sql<ProposalRow>`
            ${sql.unsafe(proposalSelect)}
            WHERE p.proposal_id = ${input.proposalId}
            GROUP BY p.proposal_id
          `
            const storedRevisionRows = yield* sql<ProposalRevisionRow>`
            ${sql.unsafe(revisionSelect)}
            WHERE proposal_id = ${input.proposalId}
              AND revision = ${revision}
          `
            const proposalRow = rows[0]
            const revisionRow = storedRevisionRows[0]
            if (!proposalRow || !revisionRow)
            {
              return yield* proposalError(
                'ProposalRepository.append',
                'persistence-failed',
                'Stored proposal revision could not be read back.',
                input.proposalId,
              )
            }
            return {
              proposal: yield* decodeProposalRow(proposalRow),
              revision: yield* decodeRevisionRow(revisionRow),
            }
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            persistenceError('ProposalRepository.append', cause, input.proposalId),
          ),
        )
      return stored
    },
  )

  const list: ProposalRepository['Service']['list'] = Effect.fn('ProposalRepository.list')(
    function* (input)
    {
      const rows = yield* sql<ProposalRow>`
      ${sql.unsafe(proposalSelect)}
      WHERE p.environment_id = ${input.environmentId}
        AND p.project_id = ${input.projectId}
        ${
          input.sourceThreadId === undefined
            ? sql.unsafe('')
            : sql`AND p.source_thread_id = ${input.sourceThreadId}`
        }
      GROUP BY p.proposal_id
      ORDER BY p.updated_at DESC, p.proposal_id ASC
    `.pipe(Effect.mapError((cause) => persistenceError('ProposalRepository.list', cause)))
      return yield* Effect.forEach(rows, decodeProposalRow)
    },
  )

  const get: ProposalRepository['Service']['get'] = Effect.fn('ProposalRepository.get')(
    function* (proposalId)
    {
      const rows = yield* sql<ProposalRow>`
      ${sql.unsafe(proposalSelect)}
      WHERE p.proposal_id = ${proposalId}
      GROUP BY p.proposal_id
    `.pipe(
        Effect.mapError((cause) => persistenceError('ProposalRepository.get', cause, proposalId)),
      )
      const proposalRow = rows[0]
      if (!proposalRow)
      {
        return yield* proposalError(
          'ProposalRepository.get',
          'not-found',
          `Proposal '${proposalId}' does not exist.`,
          proposalId,
        )
      }
      const revisionRows = yield* sql<ProposalRevisionRow>`
      ${sql.unsafe(revisionSelect)}
      WHERE proposal_id = ${proposalId}
      ORDER BY revision ASC
    `.pipe(
        Effect.mapError((cause) => persistenceError('ProposalRepository.get', cause, proposalId)),
      )
      return {
        proposal: yield* decodeProposalRow(proposalRow),
        revisions: yield* Effect.forEach(revisionRows, decodeRevisionRow),
      }
    },
  )

  const readBlob: ProposalRepository['Service']['readBlob'] = Effect.fn(
    'ProposalRepository.readBlob',
  )(function* (sha256, proposalId)
  {
    const rows = yield* sql<{ readonly content: Uint8Array }>`
      SELECT content
      FROM proposal_blobs
      WHERE sha256 = ${sha256}
    `.pipe(
      Effect.mapError((cause) =>
        persistenceError('ProposalRepository.readBlob', cause, proposalId),
      ),
    )
    const content = rows[0]?.content
    if (!content)
    {
      return yield* proposalError(
        'ProposalRepository.readBlob',
        'persistence-failed',
        `Content-addressed blob '${sha256}' is missing.`,
        proposalId,
      )
    }
    return content
  })

  const findLatestByPlan: ProposalRepository['Service']['findLatestByPlan'] = Effect.fn(
    'ProposalRepository.findLatestByPlan',
  )(function* (input)
  {
    const targetRows = yield* sql<{
      readonly proposalId: string
      readonly revision: number
    }>`
      SELECT
        revisions.proposal_id AS "proposalId",
        revisions.revision
      FROM proposal_revisions revisions
      JOIN proposals proposal ON proposal.proposal_id = revisions.proposal_id
      WHERE proposal.source_thread_id = ${input.sourceThreadId}
        AND revisions.plan_id = ${input.planId}
        ${
          input.createdAtOrBefore === undefined
            ? sql.unsafe('')
            : sql`AND revisions.created_at <= ${input.createdAtOrBefore}`
        }
      ORDER BY revisions.created_at DESC, revisions.revision DESC, revisions.revision_id DESC
      LIMIT 1
    `.pipe(
      Effect.mapError((cause) => persistenceError('ProposalRepository.findLatestByPlan', cause)),
    )
    const target = targetRows[0]
    if (!target) return null
    const stored = yield* get(target.proposalId as ProposalId)
    const revision = stored.revisions.find((candidate) => candidate.revision === target.revision)
    if (!revision)
    {
      return yield* proposalError(
        'ProposalRepository.findLatestByPlan',
        'persistence-failed',
        'The selected plan-linked proposal revision could not be read back.',
        target.proposalId as ProposalId,
      )
    }
    return { proposal: stored.proposal, revision }
  })

  return ProposalRepository.of({ append, list, get, findLatestByPlan, readBlob })
})

export const layer = Layer.effect(ProposalRepository, make)
