// apps/server/src/proposal/ProposalRetainedRefAttemptStore.ts
// persists owner-local proposal retained-ref attempt lifecycles

import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import * as SqlSchema from 'effect/unstable/sql/SqlSchema'

import { type PersistenceSqlError, toPersistenceSqlError } from '../persistence/Errors.ts'

export const ProposalRetainedRefAttempt = Schema.Struct({
  refToken: Schema.String,
  gitCommonDir: Schema.String,
  baseRef: Schema.String,
  proposedRef: Schema.String,
  createdAt: Schema.String,
  durableAt: Schema.NullOr(Schema.String),
})
export type ProposalRetainedRefAttempt = typeof ProposalRetainedRefAttempt.Type

export const RegisterProposalRetainedRefAttempt = Schema.Struct({
  refToken: Schema.String,
  gitCommonDir: Schema.String,
  baseRef: Schema.String,
  proposedRef: Schema.String,
  createdAt: Schema.String,
})
export type RegisterProposalRetainedRefAttempt = typeof RegisterProposalRetainedRefAttempt.Type

const RefTokenRequest = Schema.Struct({ refToken: Schema.String })
const FinalizeRequest = Schema.Struct({
  refToken: Schema.String,
  durableAt: Schema.String,
})

export class ProposalRetainedRefAttemptStore extends Context.Service<
  ProposalRetainedRefAttemptStore,
  {
    readonly register: (
      input: RegisterProposalRetainedRefAttempt,
    ) => Effect.Effect<void, PersistenceSqlError>
    readonly finalize: (input: {
      readonly refToken: string
      readonly durableAt: string
    }) => Effect.Effect<void, PersistenceSqlError>
    readonly remove: (refToken: string) => Effect.Effect<void, PersistenceSqlError>
    readonly list: Effect.Effect<ReadonlyArray<ProposalRetainedRefAttempt>, PersistenceSqlError>
  }
>()('456code/proposal/ProposalRetainedRefAttemptStore')
{}

export const make = Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient

  const registerRow = SqlSchema.void({
    Request: RegisterProposalRetainedRefAttempt,
    execute: (input) => sql`
      INSERT INTO proposal_retained_ref_attempts (
        ref_token,
        git_common_dir,
        base_ref,
        proposed_ref,
        created_at,
        durable_at
      )
      VALUES (
        ${input.refToken},
        ${input.gitCommonDir},
        ${input.baseRef},
        ${input.proposedRef},
        ${input.createdAt},
        NULL
      )
    `,
  })
  const finalizeRow = SqlSchema.void({
    Request: FinalizeRequest,
    execute: (input) => sql`
      UPDATE proposal_retained_ref_attempts
      SET durable_at = ${input.durableAt}
      WHERE ref_token = ${input.refToken}
    `,
  })
  const removeRow = SqlSchema.void({
    Request: RefTokenRequest,
    execute: (input) => sql`
      DELETE FROM proposal_retained_ref_attempts
      WHERE ref_token = ${input.refToken}
    `,
  })
  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProposalRetainedRefAttempt,
    execute: () => sql`
      SELECT
        ref_token AS "refToken",
        git_common_dir AS "gitCommonDir",
        base_ref AS "baseRef",
        proposed_ref AS "proposedRef",
        created_at AS "createdAt",
        durable_at AS "durableAt"
      FROM proposal_retained_ref_attempts
      ORDER BY created_at ASC, ref_token ASC
    `,
  })

  return ProposalRetainedRefAttemptStore.of({
    register: (input) =>
      registerRow(input).pipe(
        Effect.mapError(toPersistenceSqlError('ProposalRetainedRefAttemptStore.register')),
      ),
    finalize: (input) =>
      finalizeRow(input).pipe(
        Effect.mapError(toPersistenceSqlError('ProposalRetainedRefAttemptStore.finalize')),
      ),
    remove: (refToken) =>
      removeRow({ refToken }).pipe(
        Effect.mapError(toPersistenceSqlError('ProposalRetainedRefAttemptStore.remove')),
      ),
    list: listRows(undefined).pipe(
      Effect.mapError(toPersistenceSqlError('ProposalRetainedRefAttemptStore.list')),
    ),
  })
})

export const layer = Layer.effect(ProposalRetainedRefAttemptStore, make)
