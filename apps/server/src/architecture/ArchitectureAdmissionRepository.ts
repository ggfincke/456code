// apps/server/src/architecture/ArchitectureAdmissionRepository.ts
// persists fenced leases for server-owned architecture analysis work

// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off

import * as NodeCrypto from 'node:crypto'

import {
  ArchitectureAnalysisAdmissionId,
  ArchitectureAnalysisAdmissionState,
  ArchitecturePlannedImpactDigest,
  EnvironmentId,
  NonNegativeInt,
  PlannedImpactPublicationId,
  PositiveInt,
  ProjectId,
  ProposalId,
  ProposalRevisionId,
  ThreadId,
  TrimmedNonEmptyString,
} from '@t3tools/contracts'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { PersistenceSqlError, toPersistenceSqlError } from '../persistence/Errors.ts'

export const PlannedAnchorAdmissionTarget = Schema.TaggedStruct('planned-anchor', {
  version: Schema.Literal(1),
  publicationId: PlannedImpactPublicationId,
  publicationRevision: PositiveInt,
  contentDigest: ArchitecturePlannedImpactDigest,
  environmentId: EnvironmentId,
  projectId: ProjectId,
  threadId: ThreadId,
  workspaceRoot: TrimmedNonEmptyString,
})
export type PlannedAnchorAdmissionTarget = typeof PlannedAnchorAdmissionTarget.Type

export const ProposalVerifiedAdmissionTarget = Schema.TaggedStruct('proposal-verified', {
  version: Schema.Literal(1),
  threadId: ThreadId,
  proposalId: ProposalId,
  revisionId: ProposalRevisionId,
  revision: PositiveInt,
  analyzerFingerprint: TrimmedNonEmptyString,
})
export type ProposalVerifiedAdmissionTarget = typeof ProposalVerifiedAdmissionTarget.Type

export const ArchitectureAdmissionTarget = Schema.Union([
  PlannedAnchorAdmissionTarget,
  ProposalVerifiedAdmissionTarget,
])
export type ArchitectureAdmissionTarget = typeof ArchitectureAdmissionTarget.Type

export const ArchitectureAdmission = Schema.Struct({
  admissionId: ArchitectureAnalysisAdmissionId,
  kind: Schema.Literals(['planned-anchor', 'proposal-verified']),
  admissionKey: TrimmedNonEmptyString,
  target: ArchitectureAdmissionTarget,
  state: ArchitectureAnalysisAdmissionState,
  attemptCount: NonNegativeInt,
  leaseOwner: Schema.NullOr(Schema.String),
  leaseEpoch: NonNegativeInt,
  leaseExpiresAt: Schema.NullOr(Schema.String),
  nextAttemptAt: Schema.NullOr(Schema.String),
  lastErrorClass: Schema.NullOr(Schema.String),
  lastErrorCode: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
})
export type ArchitectureAdmission = typeof ArchitectureAdmission.Type

export interface ArchitectureAdmissionLeaseFence
{
  readonly admissionId: ArchitectureAnalysisAdmissionId
  readonly ownerId: string
  readonly leaseEpoch: number
}

interface ArchitectureAdmissionRow
{
  readonly admissionId: string
  readonly kind: 'planned-anchor' | 'proposal-verified'
  readonly admissionKey: string
  readonly targetJson: string
  readonly state: ArchitectureAnalysisAdmissionState
  readonly attemptCount: number
  readonly leaseOwner: string | null
  readonly leaseEpoch: number
  readonly leaseExpiresAt: string | null
  readonly nextAttemptAt: string | null
  readonly lastErrorClass: string | null
  readonly lastErrorCode: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

export interface EnqueueArchitectureAdmissionInput
{
  readonly admissionKey: string
  readonly target: ArchitectureAdmissionTarget
  readonly state?: 'queued' | 'complete'
  readonly now: string
}

export interface ArchitectureAdmissionKindCounts
{
  readonly plannedAnchor: number
  readonly proposalVerified: number
}

const admissionColumns = `
  admission_id AS "admissionId",
  kind,
  admission_key AS "admissionKey",
  target_json AS "targetJson",
  state,
  attempt_count AS "attemptCount",
  lease_owner AS "leaseOwner",
  lease_epoch AS "leaseEpoch",
  lease_expires_at AS "leaseExpiresAt",
  next_attempt_at AS "nextAttemptAt",
  last_error_class AS "lastErrorClass",
  last_error_code AS "lastErrorCode",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`

const decodeTarget = Schema.decodeUnknownEffect(ArchitectureAdmissionTarget, {
  onExcessProperty: 'error',
})
const decodeAdmission = Schema.decodeUnknownEffect(ArchitectureAdmission, {
  onExcessProperty: 'error',
})

function decodeRow(
  row: ArchitectureAdmissionRow,
): Effect.Effect<ArchitectureAdmission, PersistenceSqlError>
{
  return Effect.gen(function* ()
  {
    const parsed = yield* Effect.try({
      try: () => JSON.parse(row.targetJson) as unknown,
      catch: (cause) =>
        new PersistenceSqlError({
          operation: 'ArchitectureAdmissionRepository.decodeTarget',
          detail: 'Stored architecture admission target JSON is invalid.',
          cause,
        }),
    })
    const target = yield* decodeTarget(parsed).pipe(
      Effect.mapError(
        (cause) =>
          new PersistenceSqlError({
            operation: 'ArchitectureAdmissionRepository.decodeTarget',
            detail: 'Stored architecture admission target failed strict decoding.',
            cause,
          }),
      ),
    )
    if (target._tag !== row.kind)
    {
      return yield* new PersistenceSqlError({
        operation: 'ArchitectureAdmissionRepository.decodeTarget',
        detail: 'Stored architecture admission kind does not match its exact target tag.',
      })
    }
    const { targetJson: _targetJson, ...admissionRow } = row
    return yield* decodeAdmission({
      ...admissionRow,
      admissionId: ArchitectureAnalysisAdmissionId.make(row.admissionId),
      target,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new PersistenceSqlError({
            operation: 'ArchitectureAdmissionRepository.decodeAdmission',
            detail: 'Stored architecture admission row failed strict decoding.',
            cause,
          }),
      ),
    )
  })
}

function countAdmissionKinds(
  rows: ReadonlyArray<Pick<ArchitectureAdmissionRow, 'kind'>>,
): ArchitectureAdmissionKindCounts
{
  return {
    plannedAnchor: rows.filter((row) => row.kind === 'planned-anchor').length,
    proposalVerified: rows.filter((row) => row.kind === 'proposal-verified').length,
  }
}

export interface ArchitectureAdmissionRepositoryShape
{
  readonly enqueue: (
    input: EnqueueArchitectureAdmissionInput,
  ) => Effect.Effect<
    { readonly admission: ArchitectureAdmission; readonly reused: boolean },
    PersistenceSqlError
  >
  readonly recoverExpired: (
    now: string,
  ) => Effect.Effect<ArchitectureAdmissionKindCounts, PersistenceSqlError>
  readonly claimDue: (input: {
    readonly ownerId: string
    readonly now: string
    readonly leaseExpiresAt: string
    readonly limit: number
  }) => Effect.Effect<ReadonlyArray<ArchitectureAdmission>, PersistenceSqlError>
  readonly renew: (input: {
    readonly admissionId: ArchitectureAnalysisAdmissionId
    readonly ownerId: string
    readonly leaseEpoch: number
    readonly leaseExpiresAt: string
    readonly now: string
  }) => Effect.Effect<boolean, PersistenceSqlError>
  readonly complete: (input: {
    readonly admissionId: ArchitectureAnalysisAdmissionId
    readonly ownerId: string
    readonly leaseEpoch: number
    readonly now: string
  }) => Effect.Effect<boolean, PersistenceSqlError>
  readonly retry: (input: {
    readonly admissionId: ArchitectureAnalysisAdmissionId
    readonly ownerId: string
    readonly leaseEpoch: number
    readonly nextAttemptAt: string
    readonly errorClass: string
    readonly errorCode: string
    readonly now: string
  }) => Effect.Effect<boolean, PersistenceSqlError>
  readonly failTerminal: (input: {
    readonly admissionId: ArchitectureAnalysisAdmissionId
    readonly ownerId: string
    readonly leaseEpoch: number
    readonly errorClass: string
    readonly errorCode: string
    readonly now: string
  }) => Effect.Effect<boolean, PersistenceSqlError>
  readonly requeue: (input: {
    readonly admissionKey: string
    readonly now: string
  }) => Effect.Effect<boolean, PersistenceSqlError>
  readonly requeueCompletedAfterRestart: (input: {
    readonly admissionKey: string
    readonly now: string
  }) => Effect.Effect<boolean, PersistenceSqlError>
  readonly requeueForExplicitRetry: (input: {
    readonly admissionKey: string
    readonly now: string
  }) => Effect.Effect<boolean, PersistenceSqlError>
  readonly leaseForExplicitStart: (input: {
    readonly admissionKey: string
    readonly ownerId: string
    readonly leaseExpiresAt: string
    readonly now: string
  }) => Effect.Effect<ArchitectureAdmission | null, PersistenceSqlError>
  readonly releaseExplicitStart: (input: {
    readonly admissionId: ArchitectureAnalysisAdmissionId
    readonly ownerId: string
    readonly leaseEpoch: number
    readonly now: string
  }) => Effect.Effect<boolean, PersistenceSqlError>
  readonly findProposal: (input: {
    readonly threadId: ThreadId
    readonly proposalId: ProposalId
    readonly revisionId: ProposalRevisionId
  }) => Effect.Effect<ArchitectureAdmission | null, PersistenceSqlError>
  readonly listCompletedProposals: Effect.Effect<
    ReadonlyArray<ArchitectureAdmission>,
    PersistenceSqlError
  >
  readonly assertLeaseActive: (
    fence: ArchitectureAdmissionLeaseFence,
    admissionKey: string,
  ) => Effect.Effect<boolean, PersistenceSqlError>
  readonly isThreadDeleted: (threadId: ThreadId) => Effect.Effect<boolean, PersistenceSqlError>
  readonly cancelThread: (input: {
    readonly threadId: ThreadId
    readonly now: string
  }) => Effect.Effect<ArchitectureAdmissionKindCounts, PersistenceSqlError>
  readonly list: Effect.Effect<ReadonlyArray<ArchitectureAdmission>, PersistenceSqlError>
}

export class ArchitectureAdmissionRepository extends Context.Service<
  ArchitectureAdmissionRepository,
  ArchitectureAdmissionRepositoryShape
>()('456code/architecture/ArchitectureAdmissionRepository')
{}

export const make = Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient

  const readByKey = Effect.fn('ArchitectureAdmissionRepository.readByKey')(function* (
    admissionKey: string,
  )
  {
    const rows = yield* sql<ArchitectureAdmissionRow>`
      SELECT ${sql.unsafe(admissionColumns)}
      FROM architecture_analysis_admissions
      WHERE admission_key = ${admissionKey}
      LIMIT 1
    `.pipe(Effect.mapError(toPersistenceSqlError('ArchitectureAdmissionRepository.readByKey')))
    const row = rows[0]
    return row === undefined ? null : yield* decodeRow(row)
  })

  const enqueue: ArchitectureAdmissionRepositoryShape['enqueue'] = Effect.fn(
    'ArchitectureAdmissionRepository.enqueue',
  )(function* (input)
  {
    const targetJson = JSON.stringify(input.target)
    if (Buffer.byteLength(targetJson, 'utf8') > 65_536)
    {
      return yield* new PersistenceSqlError({
        operation: 'ArchitectureAdmissionRepository.enqueue',
        detail: 'The exact architecture admission target exceeds 65536 UTF-8 bytes.',
      })
    }
    const admissionId = ArchitectureAnalysisAdmissionId.make(
      `architecture-admission-${NodeCrypto.createHash('sha256')
        .update(input.admissionKey, 'utf8')
        .digest('hex')}`,
    )
    const inserted = yield* sql<ArchitectureAdmissionRow>`
      INSERT INTO architecture_analysis_admissions (
        admission_id,
        kind,
        admission_key,
        target_json,
        state,
        created_at,
        updated_at
      )
      VALUES (
        ${admissionId},
        ${input.target._tag},
        ${input.admissionKey},
        ${targetJson},
        ${input.state ?? 'queued'},
        ${input.now},
        ${input.now}
      )
      ON CONFLICT(admission_key) DO NOTHING
      RETURNING ${sql.unsafe(admissionColumns)}
    `.pipe(Effect.mapError(toPersistenceSqlError('ArchitectureAdmissionRepository.enqueue')))
    if (inserted[0] !== undefined)
    {
      return { admission: yield* decodeRow(inserted[0]), reused: false }
    }
    const existing = yield* readByKey(input.admissionKey)
    if (
      existing === null ||
      existing.kind !== input.target._tag ||
      JSON.stringify(existing.target) !== targetJson
    )
    {
      return yield* new PersistenceSqlError({
        operation: 'ArchitectureAdmissionRepository.enqueue',
        detail: 'An admission key was reused with a different exact target.',
      })
    }
    return { admission: existing, reused: true }
  })

  const recoverExpired: ArchitectureAdmissionRepositoryShape['recoverExpired'] = (now) =>
    sql<{ readonly kind: ArchitectureAdmission['kind'] }>`
      UPDATE architecture_analysis_admissions
      SET
        state = 'queued',
        lease_owner = NULL,
        lease_expires_at = NULL,
        next_attempt_at = NULL,
        last_error_class = 'recovery',
        last_error_code = 'expired-lease',
        updated_at = ${now}
      WHERE state = 'leased'
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= ${now}
      RETURNING kind
    `.pipe(
      Effect.map(countAdmissionKinds),
      Effect.mapError(toPersistenceSqlError('ArchitectureAdmissionRepository.recoverExpired')),
    )

  const claimDue: ArchitectureAdmissionRepositoryShape['claimDue'] = Effect.fn(
    'ArchitectureAdmissionRepository.claimDue',
  )(function* (input)
  {
    const rows = yield* sql<ArchitectureAdmissionRow>`
      UPDATE architecture_analysis_admissions
      SET
        state = 'leased',
        attempt_count = attempt_count + 1,
        lease_owner = ${input.ownerId},
        lease_epoch = lease_epoch + 1,
        lease_expires_at = ${input.leaseExpiresAt},
        next_attempt_at = NULL,
        updated_at = ${input.now}
      WHERE admission_id IN (
        SELECT admission_id
        FROM architecture_analysis_admissions
        WHERE state = 'queued'
          OR (state = 'retry-wait' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ${input.now})
        ORDER BY created_at, admission_id
        LIMIT ${input.limit}
      )
      RETURNING ${sql.unsafe(admissionColumns)}
    `.pipe(Effect.mapError(toPersistenceSqlError('ArchitectureAdmissionRepository.claimDue')))
    return yield* Effect.forEach(rows, decodeRow)
  })

  const renew: ArchitectureAdmissionRepositoryShape['renew'] = (input) =>
    sql<{ readonly admissionId: string }>`
      UPDATE architecture_analysis_admissions
      SET lease_expires_at = ${input.leaseExpiresAt}, updated_at = ${input.now}
      WHERE admission_id = ${input.admissionId}
        AND state = 'leased'
        AND lease_owner = ${input.ownerId}
        AND lease_epoch = ${input.leaseEpoch}
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at > ${input.now}
      RETURNING admission_id AS "admissionId"
    `.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(toPersistenceSqlError('ArchitectureAdmissionRepository.renew')),
    )

  const complete: ArchitectureAdmissionRepositoryShape['complete'] = (input) =>
    sql<{ readonly admissionId: string }>`
      UPDATE architecture_analysis_admissions
      SET
        state = 'complete',
        lease_owner = NULL,
        lease_expires_at = NULL,
        next_attempt_at = NULL,
        last_error_class = NULL,
        last_error_code = NULL,
        updated_at = ${input.now}
      WHERE admission_id = ${input.admissionId}
        AND state = 'leased'
        AND lease_owner = ${input.ownerId}
        AND lease_epoch = ${input.leaseEpoch}
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at > ${input.now}
      RETURNING admission_id AS "admissionId"
    `.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(toPersistenceSqlError('ArchitectureAdmissionRepository.complete')),
    )

  const retry: ArchitectureAdmissionRepositoryShape['retry'] = (input) =>
    sql<{ readonly admissionId: string }>`
      UPDATE architecture_analysis_admissions
      SET
        state = 'retry-wait',
        lease_owner = NULL,
        lease_expires_at = NULL,
        next_attempt_at = ${input.nextAttemptAt},
        last_error_class = ${input.errorClass},
        last_error_code = ${input.errorCode},
        updated_at = ${input.now}
      WHERE admission_id = ${input.admissionId}
        AND state = 'leased'
        AND lease_owner = ${input.ownerId}
        AND lease_epoch = ${input.leaseEpoch}
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at > ${input.now}
      RETURNING admission_id AS "admissionId"
    `.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(toPersistenceSqlError('ArchitectureAdmissionRepository.retry')),
    )

  const failTerminal: ArchitectureAdmissionRepositoryShape['failTerminal'] = (input) =>
    sql<{ readonly admissionId: string }>`
      UPDATE architecture_analysis_admissions
      SET
        state = 'terminal-failed',
        lease_owner = NULL,
        lease_expires_at = NULL,
        next_attempt_at = NULL,
        last_error_class = ${input.errorClass},
        last_error_code = ${input.errorCode},
        updated_at = ${input.now}
      WHERE admission_id = ${input.admissionId}
        AND state = 'leased'
        AND lease_owner = ${input.ownerId}
        AND lease_epoch = ${input.leaseEpoch}
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at > ${input.now}
      RETURNING admission_id AS "admissionId"
    `.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(toPersistenceSqlError('ArchitectureAdmissionRepository.failTerminal')),
    )

  const requeue: ArchitectureAdmissionRepositoryShape['requeue'] = Effect.fn(
    'ArchitectureAdmissionRepository.requeue',
  )(function* (input)
  {
    const rows = yield* sql<{ readonly admissionId: string }>`
      UPDATE architecture_analysis_admissions
      SET
        state = 'queued',
        next_attempt_at = NULL,
        last_error_class = NULL,
        last_error_code = NULL,
        updated_at = ${input.now}
      WHERE admission_key = ${input.admissionKey}
        AND state IN ('retry-wait', 'terminal-failed')
      RETURNING admission_id AS "admissionId"
    `.pipe(Effect.mapError(toPersistenceSqlError('ArchitectureAdmissionRepository.requeue')))
    return rows.length === 1
  })

  const requeueCompletedAfterRestart: ArchitectureAdmissionRepositoryShape['requeueCompletedAfterRestart'] =
    (input) =>
      sql<{ readonly admissionId: string }>`
        UPDATE architecture_analysis_admissions
        SET
          state = 'queued',
          attempt_count = 0,
          next_attempt_at = NULL,
          last_error_class = 'recovery',
          last_error_code = 'generation-server-restarted',
          updated_at = ${input.now}
        WHERE admission_key = ${input.admissionKey}
          AND state = 'complete'
        RETURNING admission_id AS "admissionId"
      `.pipe(
        Effect.map((rows) => rows.length === 1),
        Effect.mapError(
          toPersistenceSqlError('ArchitectureAdmissionRepository.requeueCompletedAfterRestart'),
        ),
      )

  const requeueForExplicitRetry: ArchitectureAdmissionRepositoryShape['requeueForExplicitRetry'] = (
    input,
  ) =>
    sql<{ readonly admissionId: string }>`
        UPDATE architecture_analysis_admissions
        SET
          state = 'queued',
          attempt_count = 0,
          next_attempt_at = NULL,
          last_error_class = NULL,
          last_error_code = NULL,
          updated_at = ${input.now}
        WHERE admission_key = ${input.admissionKey}
          AND state IN ('complete', 'retry-wait', 'terminal-failed')
        RETURNING admission_id AS "admissionId"
      `.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(
        toPersistenceSqlError('ArchitectureAdmissionRepository.requeueForExplicitRetry'),
      ),
    )

  const leaseForExplicitStart: ArchitectureAdmissionRepositoryShape['leaseForExplicitStart'] =
    Effect.fn('ArchitectureAdmissionRepository.leaseForExplicitStart')(function* (input)
    {
      const rows = yield* sql<ArchitectureAdmissionRow>`
        UPDATE architecture_analysis_admissions
        SET
          state = 'leased',
          lease_owner = ${input.ownerId},
          lease_epoch = lease_epoch + 1,
          lease_expires_at = ${input.leaseExpiresAt},
          updated_at = ${input.now}
        WHERE admission_key = ${input.admissionKey}
          AND state = 'queued'
        RETURNING ${sql.unsafe(admissionColumns)}
      `.pipe(
        Effect.mapError(
          toPersistenceSqlError('ArchitectureAdmissionRepository.leaseForExplicitStart'),
        ),
      )
      return rows[0] === undefined ? null : yield* decodeRow(rows[0])
    })

  const releaseExplicitStart: ArchitectureAdmissionRepositoryShape['releaseExplicitStart'] = (
    input,
  ) =>
    sql<{ readonly admissionId: string }>`
      UPDATE architecture_analysis_admissions
      SET
        state = 'queued',
        lease_owner = NULL,
        lease_expires_at = NULL,
        updated_at = ${input.now}
      WHERE admission_id = ${input.admissionId}
        AND state = 'leased'
        AND lease_owner = ${input.ownerId}
        AND lease_epoch = ${input.leaseEpoch}
      RETURNING admission_id AS "admissionId"
    `.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(
        toPersistenceSqlError('ArchitectureAdmissionRepository.releaseExplicitStart'),
      ),
    )

  const findProposal: ArchitectureAdmissionRepositoryShape['findProposal'] = Effect.fn(
    'ArchitectureAdmissionRepository.findProposal',
  )(function* (input)
  {
    const rows = yield* sql<ArchitectureAdmissionRow>`
      SELECT ${sql.unsafe(admissionColumns)}
      FROM architecture_analysis_admissions
      WHERE kind = 'proposal-verified'
        AND json_extract(target_json, '$.threadId') = ${input.threadId}
        AND json_extract(target_json, '$.proposalId') = ${input.proposalId}
        AND json_extract(target_json, '$.revisionId') = ${input.revisionId}
      ORDER BY created_at DESC, admission_id DESC
      LIMIT 1
    `.pipe(Effect.mapError(toPersistenceSqlError('ArchitectureAdmissionRepository.findProposal')))
    return rows[0] === undefined ? null : yield* decodeRow(rows[0])
  })

  const listCompletedProposals: ArchitectureAdmissionRepositoryShape['listCompletedProposals'] =
    Effect.gen(function* ()
    {
      const rows = yield* sql<ArchitectureAdmissionRow>`
        SELECT ${sql.unsafe(admissionColumns)}
        FROM architecture_analysis_admissions
        WHERE kind = 'proposal-verified'
          AND state = 'complete'
        ORDER BY created_at, admission_id
      `.pipe(
        Effect.mapError(
          toPersistenceSqlError('ArchitectureAdmissionRepository.listCompletedProposals'),
        ),
      )
      return yield* Effect.forEach(rows, decodeRow)
    })

  const assertLeaseActive: ArchitectureAdmissionRepositoryShape['assertLeaseActive'] = (
    fence,
    admissionKey,
  ) =>
    sql<{ readonly admissionId: string }>`
      SELECT admission_id AS "admissionId"
      FROM architecture_analysis_admissions
      WHERE admission_id = ${fence.admissionId}
        AND admission_key = ${admissionKey}
        AND state = 'leased'
        AND lease_owner = ${fence.ownerId}
        AND lease_epoch = ${fence.leaseEpoch}
        AND lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      LIMIT 1
    `.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(toPersistenceSqlError('ArchitectureAdmissionRepository.assertLeaseActive')),
    )

  const isThreadDeleted: ArchitectureAdmissionRepositoryShape['isThreadDeleted'] = (threadId) =>
    sql<{ readonly deleted: number }>`
      SELECT CASE WHEN EXISTS (
        SELECT 1
        FROM projection_threads
        WHERE thread_id = ${threadId}
          AND deleted_at IS NULL
      ) THEN 0 ELSE 1 END AS "deleted"
    `.pipe(
      Effect.map((rows) => rows[0]?.deleted !== 0),
      Effect.mapError(toPersistenceSqlError('ArchitectureAdmissionRepository.isThreadDeleted')),
    )

  const cancelThread: ArchitectureAdmissionRepositoryShape['cancelThread'] = (input) =>
    sql<{ readonly kind: ArchitectureAdmission['kind'] }>`
      UPDATE architecture_analysis_admissions
      SET
        state = 'cancelled',
        lease_owner = NULL,
        lease_expires_at = NULL,
        next_attempt_at = NULL,
        last_error_class = 'lifecycle',
        last_error_code = 'thread-deleted',
        updated_at = ${input.now}
      WHERE state IN ('queued', 'leased', 'retry-wait')
        AND json_extract(target_json, '$.threadId') = ${input.threadId}
      RETURNING kind
    `.pipe(
      Effect.map(countAdmissionKinds),
      Effect.mapError(toPersistenceSqlError('ArchitectureAdmissionRepository.cancelThread')),
    )

  const list: ArchitectureAdmissionRepositoryShape['list'] = Effect.gen(function* ()
  {
    const rows = yield* sql<ArchitectureAdmissionRow>`
      SELECT ${sql.unsafe(admissionColumns)}
      FROM architecture_analysis_admissions
      ORDER BY created_at, admission_id
    `.pipe(Effect.mapError(toPersistenceSqlError('ArchitectureAdmissionRepository.list')))
    return yield* Effect.forEach(rows, decodeRow)
  })

  return ArchitectureAdmissionRepository.of({
    enqueue,
    recoverExpired,
    claimDue,
    renew,
    complete,
    retry,
    failTerminal,
    requeue,
    requeueCompletedAfterRestart,
    requeueForExplicitRetry,
    leaseForExplicitStart,
    releaseExplicitStart,
    findProposal,
    listCompletedProposals,
    assertLeaseActive,
    isThreadDeleted,
    cancelThread,
    list,
  })
})

export const layer = Layer.effect(ArchitectureAdmissionRepository, make)
