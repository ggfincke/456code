// apps/server/src/persistence/Services/ImportReplacementIntents.ts
// defines durable active import replacement intent records

import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from '@t3tools/contracts'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import type { ProjectionRepositoryError } from '../Errors.ts'

export const ACTIVE_IMPORT_REPLACEMENT_VERSION = 'active-replacement-v1' as const

export const ImportReplacementPhase = Schema.Literals([
  'intent',
  'creating',
  'importing',
  'verifying',
  'tombstoning',
  'reconciling',
  'manual',
  'retired',
])
export type ImportReplacementPhase = typeof ImportReplacementPhase.Type

export const ImportReplacementThreadEvidence = Schema.Struct({
  replacementThreadId: ThreadId,
  projectId: ProjectId,
  sourceVersion: Schema.String,
  messageCount: NonNegativeInt,
  activityCount: NonNegativeInt,
  snapshotSequence: NonNegativeInt,
  verifiedAt: IsoDateTime,
})
export type ImportReplacementThreadEvidence = typeof ImportReplacementThreadEvidence.Type

export const ImportReplacementAttachmentEvidence = Schema.Struct({
  replacementThreadId: ThreadId,
  expectedRelativePaths: Schema.Array(Schema.String),
  exactSetVerified: Schema.Boolean,
  sourceCleanupComplete: Schema.Boolean,
  verifiedAt: IsoDateTime,
})
export type ImportReplacementAttachmentEvidence = typeof ImportReplacementAttachmentEvidence.Type

export const ImportReplacementIndexEvidence = Schema.Struct({
  replacementThreadId: ThreadId,
  exactIdVisible: Schema.Boolean,
  sourceThreadVisible: Schema.Boolean,
  verifiedAt: IsoDateTime,
})
export type ImportReplacementIndexEvidence = typeof ImportReplacementIndexEvidence.Type

export const ImportReplacementIntent = Schema.Struct({
  intentKey: Schema.String,
  source: Schema.Literals(['codex-cli', 'claude-code', 'opencode', 'cursor', 'grok']),
  sourcePath: Schema.String,
  nativeSessionId: Schema.NullOr(Schema.String),
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  originalWorkspaceRoot: Schema.NullOr(Schema.String),
  sourceVersion: Schema.String,
  replacementVersion: Schema.String,
  sourceThreadId: ThreadId,
  sourceProjectId: ProjectId,
  replacementThreadId: ThreadId,
  replacementProjectId: ProjectId,
  replacementWorkspaceRoot: Schema.NullOr(Schema.String),
  createCommandId: CommandId,
  tombstoneCommandId: CommandId,
  expectedMessageCount: NonNegativeInt,
  expectedActivityCount: NonNegativeInt,
  expectedRecordFingerprint: Schema.String,
  phase: ImportReplacementPhase,
  threadEvidence: Schema.NullOr(ImportReplacementThreadEvidence),
  attachmentEvidence: Schema.NullOr(ImportReplacementAttachmentEvidence),
  indexEvidence: Schema.NullOr(ImportReplacementIndexEvidence),
  attemptCount: NonNegativeInt,
  lastError: Schema.NullOr(Schema.String),
  retryAfter: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  retiredAt: Schema.NullOr(IsoDateTime),
})
export type ImportReplacementIntent = typeof ImportReplacementIntent.Type

export const ImportReplacementSourceIdentity = Schema.Struct({
  source: ImportReplacementIntent.fields.source,
  sourcePath: Schema.String,
  nativeSessionId: Schema.NullOr(Schema.String),
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
})
export type ImportReplacementSourceIdentity = typeof ImportReplacementSourceIdentity.Type

export const ImportReplacementCasTransition = Schema.Struct({
  intentKey: Schema.String,
  expectedPhase: ImportReplacementPhase,
  nextPhase: ImportReplacementPhase,
  threadEvidence: Schema.NullOr(ImportReplacementThreadEvidence),
  attachmentEvidence: Schema.NullOr(ImportReplacementAttachmentEvidence),
  indexEvidence: Schema.NullOr(ImportReplacementIndexEvidence),
  attemptCount: NonNegativeInt,
  lastError: Schema.NullOr(Schema.String),
  retryAfter: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
})
export type ImportReplacementCasTransition = typeof ImportReplacementCasTransition.Type

export interface ImportReplacementIntentRepositoryShape
{
  readonly getByIntentKey: (
    intentKey: string,
  ) => Effect.Effect<Option.Option<ImportReplacementIntent>, ProjectionRepositoryError>
  readonly findOpenBySourceIdentity: (
    identity: ImportReplacementSourceIdentity,
  ) => Effect.Effect<Option.Option<ImportReplacementIntent>, ProjectionRepositoryError>
  readonly insertIfAbsent: (
    intent: ImportReplacementIntent,
  ) => Effect.Effect<ImportReplacementIntent, ProjectionRepositoryError>
  readonly casTransition: (
    transition: ImportReplacementCasTransition,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>
  readonly listOpen: () => Effect.Effect<
    ReadonlyArray<ImportReplacementIntent>,
    ProjectionRepositoryError
  >
  readonly retire: (input: {
    readonly intentKey: string
    readonly expectedPhase: ImportReplacementPhase
    readonly retiredAt: string
  }) => Effect.Effect<boolean, ProjectionRepositoryError>
}

export class ImportReplacementIntentRepository extends Context.Service<
  ImportReplacementIntentRepository,
  ImportReplacementIntentRepositoryShape
>()('456code/persistence/Services/ImportReplacementIntents/ImportReplacementIntentRepository')
{}
