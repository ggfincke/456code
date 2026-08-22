// apps/server/src/proposal/ProposalRepository.ts
// persists proposal identities, immutable revisions, and content-addressed blobs

// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off

import * as NodeCrypto from 'node:crypto'

import {
  PROPOSAL_SNAPSHOT_POLICY_V1,
  OrchestratePlanRevision,
  Proposal,
  ProposalError,
  ProposalOrchestratePlanLink,
  ProposalRepositoryIdentity,
  ProposalRevision,
  ProposalRevisionManifest,
  ProposalSnapshotPolicy,
  type EnvironmentId,
  type OrchestrationProposedPlanId,
  type ProposalOrchestratePlanLookupInput,
  type ProposalOrchestratePlanLookupResult,
  type ProposalOrchestratePlanTarget,
  type ProjectId,
  type ProposalId,
  type ProposalListInput,
  type ProposalProducerIdentity,
  type ProposalRevisionId,
  type ProposalSha256,
  type PlannedImpactPublicationId,
  type ThreadId,
  type TurnId,
} from '@t3tools/contracts'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import type { PreparedProposalRevision, ProposalContentBlob } from './ProposalGitEngine.ts'
import * as ArchitectureAdmissionRepository from '../architecture/ArchitectureAdmissionRepository.ts'

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
  readonly plannedImpactPublicationId: string | null
  readonly plannedImpactPublicationRevision: number | null
  readonly plannedImpactContentDigest: string | null
  readonly createdAt: string
}

interface ProposalOrchestratePlanLookupRow
{
  readonly proposalId: string
  readonly proposalRevision: number
  readonly sourceThreadId: string
  readonly runId: string
  readonly orchestrateRevision: number
  readonly linkCreatedAt: string
  readonly turnId: string | null
  readonly workflow: string
  readonly task: string
  readonly stagesJson: string
  readonly totalWorkers: number
  readonly maxWorkers: number
  readonly source: string
  readonly status: string
  readonly planCreatedAt: string
  readonly planUpdatedAt: string
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
  readonly orchestratePlan?: ProposalOrchestratePlanTarget & {
    readonly turnId: TurnId
  }
  readonly verifiedAnalyzerFingerprint: string
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
const decodeOrchestratePlanLink = Schema.decodeUnknownEffect(ProposalOrchestratePlanLink)
const decodeOrchestratePlanRevision = Schema.decodeUnknownEffect(OrchestratePlanRevision)

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
    const plannedImpactFieldCount = [
      row.plannedImpactPublicationId,
      row.plannedImpactPublicationRevision,
      row.plannedImpactContentDigest,
    ].filter((value) => value !== null).length
    if (plannedImpactFieldCount !== 0 && plannedImpactFieldCount !== 3)
    {
      return yield* proposalError(
        'ProposalRepository.decodeRevision',
        'persistence-failed',
        'Stored proposal Planned Impact reference metadata is incomplete.',
        row.proposalId as ProposalId,
      )
    }
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
      ...(row.plannedImpactPublicationId === null ||
      row.plannedImpactPublicationRevision === null ||
      row.plannedImpactContentDigest === null
        ? {}
        : {
            plannedImpactRef: {
              publicationId: row.plannedImpactPublicationId as PlannedImpactPublicationId,
              publicationRevision: row.plannedImpactPublicationRevision,
              contentDigest: row.plannedImpactContentDigest,
            },
          }),
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
    revision.revision_id AS "revisionId",
    revision.proposal_id AS "proposalId",
    revision.revision,
    revision.head_commit_oid AS "headCommitOid",
    revision.base_tree_oid AS "baseTreeOid",
    revision.base_retained_ref AS "baseRetainedRef",
    revision.base_file_count AS "baseFileCount",
    revision.base_byte_count AS "baseByteCount",
    revision.snapshot_policy_json AS "snapshotPolicyJson",
    revision.proposed_tree_oid AS "proposedTreeOid",
    revision.proposed_retained_ref AS "proposedRetainedRef",
    revision.manifest_json AS "manifestJson",
    revision.manifest_sha256 AS "manifestSha256",
    revision.diff_sha256 AS "diffSha256",
    revision.diff_byte_length AS "diffByteLength",
    revision.narrative_sha256 AS "narrativeSha256",
    revision.narrative_byte_length AS "narrativeByteLength",
    revision.plan_id AS "planId",
    revision.plan_markdown_sha256 AS "planMarkdownSha256",
    planned.publication_id AS "plannedImpactPublicationId",
    planned.publication_revision AS "plannedImpactPublicationRevision",
    planned.content_digest AS "plannedImpactContentDigest",
    revision.created_at AS "createdAt"
  FROM proposal_revisions revision
  LEFT JOIN proposal_revision_planned_impacts planned
    ON planned.revision_id = revision.revision_id
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
    readonly findByOrchestrateRevision: (
      input: ProposalOrchestratePlanLookupInput,
    ) => Effect.Effect<ProposalOrchestratePlanLookupResult | null, ProposalError>
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
  const architectureAdmissions =
    yield* ArchitectureAdmissionRepository.ArchitectureAdmissionRepository

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

            if (input.orchestratePlan !== undefined)
            {
              const targetRows = yield* sql<{
                readonly turnId: string | null
                readonly source: string
                readonly interactionMode: string | null
                readonly sessionStatus: string | null
                readonly activeTurnId: string | null
                readonly latestTurnId: string | null
                readonly latestTurnState: string | null
              }>`
                SELECT
                  plan.turn_id AS "turnId",
                  plan.source,
                  thread.interaction_mode AS "interactionMode",
                  session.status AS "sessionStatus",
                  session.active_turn_id AS "activeTurnId",
                  thread.latest_turn_id AS "latestTurnId",
                  latest_turn.state AS "latestTurnState"
                FROM projection_thread_orchestrate_plans plan
                LEFT JOIN projection_threads thread
                  ON thread.thread_id = plan.thread_id
                LEFT JOIN projection_thread_sessions session
                  ON session.thread_id = plan.thread_id
                LEFT JOIN projection_turns latest_turn
                  ON latest_turn.thread_id = thread.thread_id
                  AND latest_turn.turn_id = thread.latest_turn_id
                WHERE plan.thread_id = ${input.sourceThreadId}
                  AND plan.run_id = ${input.orchestratePlan.runId}
                  AND plan.revision = ${input.orchestratePlan.revision}
                LIMIT 1
              `
              const target = targetRows[0]
              if (!target)
              {
                return yield* proposalError(
                  'ProposalRepository.append',
                  'not-found',
                  'The exact projected orchestrate-plan revision does not exist.',
                  input.proposalId,
                )
              }
              if (
                target.turnId !== input.orchestratePlan.turnId ||
                target.source !== 'tool' ||
                target.interactionMode !== 'orchestrate' ||
                target.sessionStatus !== 'running' ||
                target.activeTurnId !== input.orchestratePlan.turnId ||
                target.latestTurnId !== input.orchestratePlan.turnId ||
                target.latestTurnState !== 'running'
              )
              {
                return yield* proposalError(
                  'ProposalRepository.append',
                  'identity-mismatch',
                  'The orchestrate-plan revision must be tool-sourced from the active turn.',
                  input.proposalId,
                )
              }
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
            if (input.orchestratePlan !== undefined)
            {
              yield* sql`
                INSERT INTO proposal_orchestrate_plan_links (
                  proposal_id,
                  proposal_revision,
                  source_thread_id,
                  run_id,
                  orchestrate_revision,
                  created_at
                )
                VALUES (
                  ${input.proposalId},
                  ${revision},
                  ${input.sourceThreadId},
                  ${input.orchestratePlan.runId},
                  ${input.orchestratePlan.revision},
                  ${input.createdAt}
                )
              `
            }
            const planIdentityKey =
              input.planId !== undefined
                ? `plan:${input.planId}`
                : input.orchestratePlan !== undefined
                  ? `orchestrate:${input.orchestratePlan.runId}:${input.orchestratePlan.revision}`
                  : null
            if (planIdentityKey !== null)
            {
              const plannedRows = yield* sql<{
                readonly publicationId: string
                readonly publicationRevision: number
                readonly contentDigest: string
              }>`
                SELECT
                  publication_id AS "publicationId",
                  publication_revision AS "publicationRevision",
                  content_digest AS "contentDigest"
                FROM architecture_planned_impact_publications
                WHERE source_thread_id = ${input.sourceThreadId}
                  AND plan_identity_key = ${planIdentityKey}
                ORDER BY publication_revision DESC
                LIMIT 1
              `
              const planned = plannedRows[0]
              if (planned !== undefined)
              {
                yield* sql`
                  INSERT INTO proposal_revision_planned_impacts (
                    revision_id,
                    proposal_id,
                    proposal_revision,
                    publication_id,
                    publication_revision,
                    content_digest,
                    created_at
                  )
                  VALUES (
                    ${input.revisionId},
                    ${input.proposalId},
                    ${revision},
                    ${planned.publicationId},
                    ${planned.publicationRevision},
                    ${planned.contentDigest},
                    ${input.createdAt}
                  )
                `
              }
            }
            yield* architectureAdmissions.enqueue({
              admissionKey: `proposal-verified:${input.revisionId}:${input.verifiedAnalyzerFingerprint}`,
              target: {
                _tag: 'proposal-verified',
                version: 1,
                threadId: input.sourceThreadId,
                proposalId: input.proposalId,
                revisionId: input.revisionId,
                revision,
                analyzerFingerprint: input.verifiedAnalyzerFingerprint,
              },
              now: input.createdAt,
            })
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
            WHERE revision.proposal_id = ${input.proposalId}
              AND revision.revision = ${revision}
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
      WHERE revision.proposal_id = ${proposalId}
      ORDER BY revision.revision ASC
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

  const findByOrchestrateRevision: ProposalRepository['Service']['findByOrchestrateRevision'] =
    Effect.fn('ProposalRepository.findByOrchestrateRevision')(function* (input)
    {
      const rows = yield* sql<ProposalOrchestratePlanLookupRow>`
        SELECT
          link.proposal_id AS "proposalId",
          link.proposal_revision AS "proposalRevision",
          link.source_thread_id AS "sourceThreadId",
          link.run_id AS "runId",
          link.orchestrate_revision AS "orchestrateRevision",
          link.created_at AS "linkCreatedAt",
          plan.turn_id AS "turnId",
          plan.workflow,
          plan.task,
          plan.stages_json AS "stagesJson",
          plan.total_workers AS "totalWorkers",
          plan.max_workers AS "maxWorkers",
          plan.source,
          plan.status,
          plan.created_at AS "planCreatedAt",
          plan.updated_at AS "planUpdatedAt"
        FROM proposal_orchestrate_plan_links link
        JOIN projection_thread_orchestrate_plans plan
          ON plan.thread_id = link.source_thread_id
          AND plan.run_id = link.run_id
          AND plan.revision = link.orchestrate_revision
        WHERE link.source_thread_id = ${input.sourceThreadId}
          AND link.run_id = ${input.runId}
          AND link.orchestrate_revision = ${input.revision}
        LIMIT 1
      `.pipe(
        Effect.mapError((cause) =>
          persistenceError('ProposalRepository.findByOrchestrateRevision', cause),
        ),
      )
      const row = rows[0]
      if (!row) return null

      const stored = yield* get(row.proposalId as ProposalId)
      const revision = stored.revisions.find(
        (candidate) => candidate.revision === row.proposalRevision,
      )
      if (!revision)
      {
        return yield* proposalError(
          'ProposalRepository.findByOrchestrateRevision',
          'persistence-failed',
          'The linked proposal revision could not be read back.',
          row.proposalId as ProposalId,
        )
      }
      const stages = yield* parseStoredJson(
        row.stagesJson,
        'ProposalRepository.findByOrchestrateRevision',
        row.proposalId as ProposalId,
      )
      const link = yield* decodeOrchestratePlanLink({
        proposalId: row.proposalId,
        proposalRevision: row.proposalRevision,
        sourceThreadId: row.sourceThreadId,
        runId: row.runId,
        revision: row.orchestrateRevision,
        createdAt: row.linkCreatedAt,
      }).pipe(
        Effect.mapError((cause) =>
          proposalError(
            'ProposalRepository.findByOrchestrateRevision',
            'persistence-failed',
            cause.message,
            row.proposalId as ProposalId,
          ),
        ),
      )
      const orchestratePlan = yield* decodeOrchestratePlanRevision({
        runId: row.runId,
        revision: row.orchestrateRevision,
        turnId: row.turnId,
        workflow: row.workflow,
        task: row.task,
        stages,
        totalWorkers: row.totalWorkers,
        maxWorkers: row.maxWorkers,
        source: row.source,
        status: row.status,
        createdAt: row.planCreatedAt,
        updatedAt: row.planUpdatedAt,
      }).pipe(
        Effect.mapError((cause) =>
          proposalError(
            'ProposalRepository.findByOrchestrateRevision',
            'persistence-failed',
            cause.message,
            row.proposalId as ProposalId,
          ),
        ),
      )
      return { link, proposal: stored.proposal, revision, orchestratePlan }
    })

  return ProposalRepository.of({
    append,
    list,
    get,
    findLatestByPlan,
    findByOrchestrateRevision,
    readBlob,
  })
})

export const layer = Layer.effect(ProposalRepository, make).pipe(
  Layer.provide(ArchitectureAdmissionRepository.layer),
)
