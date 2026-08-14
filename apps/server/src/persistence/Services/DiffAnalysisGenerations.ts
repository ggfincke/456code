// apps/server/src/persistence/Services/DiffAnalysisGenerations.ts
// defines persistence operations for cached diff analysis generations

import {
  DiffAnalysisErrorCode,
  DiffAnalysisId,
  DiffAnalysisSource,
  DiffAnalysisState,
} from '@t3tools/contracts'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import type { ProjectionRepositoryError } from '../Errors.ts'

export const DiffAnalysisCacheIdentity = Schema.Struct({
  environmentId: Schema.String,
  repositoryKey: Schema.String,
  baseTreeOid: Schema.String,
  headTreeOid: Schema.String,
  analyzerVersion: Schema.String,
  analysisPolicyVersion: Schema.String,
  configDigest: Schema.String,
  scopeDigest: Schema.String,
  tsconfigDigest: Schema.String,
})
export type DiffAnalysisCacheIdentity = typeof DiffAnalysisCacheIdentity.Type

export const DiffAnalysisGenerationRecord = Schema.Struct({
  diffAnalysisId: DiffAnalysisId,
  ...DiffAnalysisCacheIdentity.fields,
  baseAnalyzerRef: Schema.String,
  headAnalyzerRef: Schema.String,
  source: DiffAnalysisSource,
  state: DiffAnalysisState,
  artifactRoot: Schema.String,
  headRootPath: Schema.NullOr(Schema.String),
  baseGraphPath: Schema.NullOr(Schema.String),
  headGraphPath: Schema.NullOr(Schema.String),
  impactPath: Schema.NullOr(Schema.String),
  artifactByteLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  errorCode: Schema.NullOr(DiffAnalysisErrorCode),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  lastAccessedAt: Schema.String,
})
export type DiffAnalysisGenerationRecord = typeof DiffAnalysisGenerationRecord.Type

export interface DiffAnalysisGenerationAdmission
{
  readonly row: DiffAnalysisGenerationRecord
  readonly inserted: boolean
}

export const DiffAnalysisGenerationUpdate = Schema.Struct({
  diffAnalysisId: DiffAnalysisId,
  state: DiffAnalysisState,
  headRootPath: Schema.NullOr(Schema.String),
  baseGraphPath: Schema.NullOr(Schema.String),
  headGraphPath: Schema.NullOr(Schema.String),
  impactPath: Schema.NullOr(Schema.String),
  artifactByteLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  errorCode: Schema.NullOr(DiffAnalysisErrorCode),
  updatedAt: Schema.String,
})
export type DiffAnalysisGenerationUpdate = typeof DiffAnalysisGenerationUpdate.Type

export const DiffAnalysisGenerationIdInput = Schema.Struct({
  diffAnalysisId: DiffAnalysisId,
})

export const DiffAnalysisGenerationTouchInput = Schema.Struct({
  diffAnalysisId: DiffAnalysisId,
  lastAccessedAt: Schema.String,
})

export const DiffAnalysisGenerationConditionalDeleteInput = Schema.Struct({
  diffAnalysisId: DiffAnalysisId,
  state: DiffAnalysisState,
  updatedAt: Schema.String,
  lastAccessedAt: Schema.String,
})

export const DiffAnalysisGenerationRetryInput = Schema.Struct({
  diffAnalysisId: DiffAnalysisId,
  updatedAt: Schema.String,
})

export const DiffAnalysisGenerationRepositoryInput = Schema.Struct({
  environmentId: Schema.String,
  repositoryKey: Schema.String,
})

export const DiffAnalysisGenerationCutoffInput = Schema.Struct({
  cutoff: Schema.String,
})

/**
 * Persistence API for atomic cache admission, lifecycle changes, and LRU scans.
 */
export interface DiffAnalysisGenerationRepositoryShape
{
  readonly admit: (
    row: DiffAnalysisGenerationRecord,
  ) => Effect.Effect<DiffAnalysisGenerationAdmission, ProjectionRepositoryError>
  readonly getById: (
    input: typeof DiffAnalysisGenerationIdInput.Type,
  ) => Effect.Effect<Option.Option<DiffAnalysisGenerationRecord>, ProjectionRepositoryError>
  readonly getByIdentity: (
    identity: DiffAnalysisCacheIdentity,
  ) => Effect.Effect<Option.Option<DiffAnalysisGenerationRecord>, ProjectionRepositoryError>
  readonly update: (
    input: DiffAnalysisGenerationUpdate,
  ) => Effect.Effect<DiffAnalysisGenerationRecord, ProjectionRepositoryError>
  readonly touch: (
    input: typeof DiffAnalysisGenerationTouchInput.Type,
  ) => Effect.Effect<string, ProjectionRepositoryError>
  readonly retryTerminal: (
    input: typeof DiffAnalysisGenerationRetryInput.Type,
  ) => Effect.Effect<Option.Option<DiffAnalysisGenerationRecord>, ProjectionRepositoryError>
  readonly abandonActive: (
    updatedAt: string,
  ) => Effect.Effect<ReadonlyArray<DiffAnalysisGenerationRecord>, ProjectionRepositoryError>
  readonly listTerminalBefore: (
    input: typeof DiffAnalysisGenerationCutoffInput.Type,
  ) => Effect.Effect<ReadonlyArray<DiffAnalysisGenerationRecord>, ProjectionRepositoryError>
  readonly listReadyByRepositoryLru: (
    input: typeof DiffAnalysisGenerationRepositoryInput.Type,
  ) => Effect.Effect<ReadonlyArray<DiffAnalysisGenerationRecord>, ProjectionRepositoryError>
  readonly listReadyGlobalLru: () => Effect.Effect<
    ReadonlyArray<DiffAnalysisGenerationRecord>,
    ProjectionRepositoryError
  >
  readonly listAllIds: () => Effect.Effect<ReadonlyArray<DiffAnalysisId>, ProjectionRepositoryError>
  readonly deleteIfUnchanged: (
    input: typeof DiffAnalysisGenerationConditionalDeleteInput.Type,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>
}

export class DiffAnalysisGenerationRepository extends Context.Service<
  DiffAnalysisGenerationRepository,
  DiffAnalysisGenerationRepositoryShape
>()('456code/persistence/Services/DiffAnalysisGenerations/DiffAnalysisGenerationRepository')
{}
