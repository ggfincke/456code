// apps/server/src/persistence/Migrations.ts
// assembles ordered database migrations

// MigrationsLive - Migration runner with inline loader
//
// uses Migrator.make with fromRecord to define migrations inline.
// all migrations are statically imported - no dynamic file system loading.
//
// migrations run automatically when the MigrationLayer is provided,
// ensuring the database schema is always up-to-date before the application starts.

import * as Migrator from 'effect/unstable/sql/Migrator'
import * as Layer from 'effect/Layer'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

// import all migrations statically
import Migration0001 from './Migrations/001_OrchestrationEvents.ts'
import Migration0002 from './Migrations/002_OrchestrationCommandReceipts.ts'
import Migration0003 from './Migrations/003_CheckpointDiffBlobs.ts'
import Migration0004 from './Migrations/004_ProviderSessionRuntime.ts'
import Migration0005 from './Migrations/005_Projections.ts'
import Migration0006 from './Migrations/006_ProjectionThreadSessionRuntimeModeColumns.ts'
import Migration0007 from './Migrations/007_ProjectionThreadMessageAttachments.ts'
import Migration0008 from './Migrations/008_ProjectionThreadActivitySequence.ts'
import Migration0009 from './Migrations/009_ProviderSessionRuntimeMode.ts'
import Migration0010 from './Migrations/010_ProjectionThreadsRuntimeMode.ts'
import Migration0011 from './Migrations/011_OrchestrationThreadCreatedRuntimeMode.ts'
import Migration0012 from './Migrations/012_ProjectionThreadsInteractionMode.ts'
import Migration0013 from './Migrations/013_ProjectionThreadProposedPlans.ts'
import Migration0014 from './Migrations/014_ProjectionThreadProposedPlanImplementation.ts'
import Migration0015 from './Migrations/015_ProjectionTurnsSourceProposedPlan.ts'
import Migration0016 from './Migrations/016_CanonicalizeModelSelections.ts'
import Migration0017 from './Migrations/017_ProjectionThreadsArchivedAt.ts'
import Migration0018 from './Migrations/018_ProjectionThreadsArchivedAtIndex.ts'
import Migration0019 from './Migrations/019_ProjectionSnapshotLookupIndexes.ts'
import Migration0020 from './Migrations/020_AuthAccessManagement.ts'
import Migration0021 from './Migrations/021_AuthSessionClientMetadata.ts'
import Migration0022 from './Migrations/022_AuthSessionLastConnectedAt.ts'
import Migration0023 from './Migrations/023_ProjectionThreadShellSummary.ts'
import Migration0024 from './Migrations/024_BackfillProjectionThreadShellSummary.ts'
import Migration0025 from './Migrations/025_CleanupInvalidProjectionPendingApprovals.ts'
import Migration0026 from './Migrations/026_CanonicalizeModelSelectionOptions.ts'
import Migration0027 from './Migrations/027_ProviderSessionRuntimeInstanceId.ts'
import Migration0028 from './Migrations/028_ProjectionThreadSessionInstanceId.ts'
import Migration0029 from './Migrations/029_ProjectionThreadDetailOrderingIndexes.ts'
import Migration0030 from './Migrations/030_ProjectionThreadShellArchiveIndexes.ts'
import Migration0031 from './Migrations/031_AuthAuthorizationScopes.ts'
import Migration0032 from './Migrations/032_AuthPairingProofKeyThumbprint.ts'
import Migration0033 from './Migrations/033_ProjectionThreadsSettled.ts'
import Migration0034 from './Migrations/034_ProjectionThreadsSnoozed.ts'
import Migration0035 from './Migrations/035_ProjectionThreadsOrigin.ts'
import Migration0036 from './Migrations/036_ProjectionThreadCommandActivityIndexes.ts'
import Migration0037 from './Migrations/037_Proposals.ts'
import Migration0038 from './Migrations/038_ProposalGenerations.ts'
import Migration0039 from './Migrations/039_ProposalImplementationAttempts.ts'
import Migration0040 from './Migrations/040_ProjectionThreadsPendingHandoff.ts'
import Migration0041 from './Migrations/041_RepairProjectionPendingUserInputCounts.ts'
import Migration0042 from './Migrations/042_ProjectionThreadsProviderSwitch.ts'
import Migration0045 from './Migrations/045_OrchestrationReactorDelivery.ts'
import Migration0044 from './Migrations/044_ImportReplacementIntents.ts'
import Migration0043 from './Migrations/043_ProposalRetainedRefAttempts.ts'
import Migration0046 from './Migrations/046_AttachmentLifecycle.ts'
import Migration0047 from './Migrations/047_PendingApprovalOutcome.ts'
import Migration0048 from './Migrations/048_CheckpointRevertOperations.ts'
import Migration0049 from './Migrations/049_OrchestrationCommandReceiptErrorCode.ts'
import Migration0050 from './Migrations/050_AttachmentLifecycleGenerations.ts'
import Migration0051 from './Migrations/051_ProjectionThreadOrchestratePlans.ts'
import Migration0052 from './Migrations/052_ProjectionThreadsInteractionOrchestrate.ts'
import Migration0053 from './Migrations/053_ProposalOrchestratePlanLinks.ts'
import Migration0054 from './Migrations/054_ProjectionThreadOrchestratePlanLeadModel.ts'
import Migration0055 from './Migrations/055_ProjectionThreadsOrchestrateIntegration.ts'
import Migration0059 from './Migrations/059_DiffAnalysisGenerations.ts'
import Migration0060 from './Migrations/060_RuntimeRecoveryAudit.ts'
import Migration0061 from './Migrations/061_ProviderRuntimeInbox.ts'
import Migration0062 from './Migrations/062_CheckpointCaptureIdentity.ts'
import Migration0063 from './Migrations/063_OrchestrateRunExecutions.ts'
import Migration0064 from './Migrations/064_ProjectionThreadArchiveGeneration.ts'
import Migration0065 from './Migrations/065_CheckpointRevertProviderGeneration.ts'
import Migration0066 from './Migrations/066_ProviderRuntimeInboxProviderKind.ts'
import Migration0067 from './Migrations/067_CheckpointRevertRequestedFence.ts'
import Migration0068 from './Migrations/068_ProjectionThreadOrchestratePlanArchitecturePaths.ts'
import Migration0069 from './Migrations/069_HealOrchestratePlanRespondFailure.ts'
import Migration0070 from './Migrations/070_NativeArchitectureViews.ts'

// migration loader with all migrations defined inline.
//
// key format: "{id}_{name}" where:
// - id: numeric migration ID (determines execution order)
// - name: descriptive name for the migration
//
// uses Migrator.fromRecord which parses the key format and
// returns migrations sorted by ID.
export const migrationEntries = [
  [1, 'OrchestrationEvents', Migration0001],
  [2, 'OrchestrationCommandReceipts', Migration0002],
  [3, 'CheckpointDiffBlobs', Migration0003],
  [4, 'ProviderSessionRuntime', Migration0004],
  [5, 'Projections', Migration0005],
  [6, 'ProjectionThreadSessionRuntimeModeColumns', Migration0006],
  [7, 'ProjectionThreadMessageAttachments', Migration0007],
  [8, 'ProjectionThreadActivitySequence', Migration0008],
  [9, 'ProviderSessionRuntimeMode', Migration0009],
  [10, 'ProjectionThreadsRuntimeMode', Migration0010],
  [11, 'OrchestrationThreadCreatedRuntimeMode', Migration0011],
  [12, 'ProjectionThreadsInteractionMode', Migration0012],
  [13, 'ProjectionThreadProposedPlans', Migration0013],
  [14, 'ProjectionThreadProposedPlanImplementation', Migration0014],
  [15, 'ProjectionTurnsSourceProposedPlan', Migration0015],
  [16, 'CanonicalizeModelSelections', Migration0016],
  [17, 'ProjectionThreadsArchivedAt', Migration0017],
  [18, 'ProjectionThreadsArchivedAtIndex', Migration0018],
  [19, 'ProjectionSnapshotLookupIndexes', Migration0019],
  [20, 'AuthAccessManagement', Migration0020],
  [21, 'AuthSessionClientMetadata', Migration0021],
  [22, 'AuthSessionLastConnectedAt', Migration0022],
  [23, 'ProjectionThreadShellSummary', Migration0023],
  [24, 'BackfillProjectionThreadShellSummary', Migration0024],
  [25, 'CleanupInvalidProjectionPendingApprovals', Migration0025],
  [26, 'CanonicalizeModelSelectionOptions', Migration0026],
  [27, 'ProviderSessionRuntimeInstanceId', Migration0027],
  [28, 'ProjectionThreadSessionInstanceId', Migration0028],
  [29, 'ProjectionThreadDetailOrderingIndexes', Migration0029],
  [30, 'ProjectionThreadShellArchiveIndexes', Migration0030],
  [31, 'AuthAuthorizationScopes', Migration0031],
  [32, 'AuthPairingProofKeyThumbprint', Migration0032],
  [33, 'ProjectionThreadsSettled', Migration0033],
  [34, 'ProjectionThreadsSnoozed', Migration0034],
  [35, 'ProjectionThreadsOrigin', Migration0035],
  [36, 'ProjectionThreadCommandActivityIndexes', Migration0036],
  [37, 'Proposals', Migration0037],
  [38, 'ProposalGenerations', Migration0038],
  [39, 'ProposalImplementationAttempts', Migration0039],
  [40, 'ProjectionThreadsPendingHandoff', Migration0040],
  [41, 'RepairProjectionPendingUserInputCounts', Migration0041],
  [42, 'ProjectionThreadsProviderSwitch', Migration0042],
  [45, 'OrchestrationReactorDelivery', Migration0045],
  [44, 'ImportReplacementIntents', Migration0044],
  [43, 'ProposalRetainedRefAttempts', Migration0043],
  [46, 'AttachmentLifecycle', Migration0046],
  [47, 'PendingApprovalOutcome', Migration0047],
  [48, 'CheckpointRevertOperations', Migration0048],
  [49, 'OrchestrationCommandReceiptErrorCode', Migration0049],
  [50, 'AttachmentLifecycleGenerations', Migration0050],
  [51, 'ProjectionThreadOrchestratePlans', Migration0051],
  [52, 'ProjectionThreadsInteractionOrchestrate', Migration0052],
  [53, 'ProposalOrchestratePlanLinks', Migration0053],
  [54, 'ProjectionThreadOrchestratePlanLeadModel', Migration0054],
  [55, 'ProjectionThreadsOrchestrateIntegration', Migration0055],
  [59, 'DiffAnalysisGenerations', Migration0059],
  [60, 'RuntimeRecoveryAudit', Migration0060],
  [61, 'ProviderRuntimeInbox', Migration0061],
  [62, 'CheckpointCaptureIdentity', Migration0062],
  [63, 'OrchestrateRunExecutions', Migration0063],
  [64, 'ProjectionThreadArchiveGeneration', Migration0064],
  [65, 'CheckpointRevertProviderGeneration', Migration0065],
  [66, 'ProviderRuntimeInboxProviderKind', Migration0066],
  [67, 'CheckpointRevertRequestedFence', Migration0067],
  [68, 'ProjectionThreadOrchestratePlanArchitecturePaths', Migration0068],
  [69, 'HealOrchestratePlanRespondFailure', Migration0069],
  [70, 'NativeArchitectureViews', Migration0070],
] as const

export interface MigrationIdentity
{
  readonly id: number
  readonly name: string
}

export class MigrationLineageError extends Schema.TaggedErrorClass<MigrationLineageError>()(
  'MigrationLineageError',
  {
    reason: Schema.Literals([
      'duplicate-manifest-id',
      'duplicate-manifest-name',
      'duplicate-ledger-id',
      'unknown-ledger-id',
      'ledger-name-mismatch',
      'historical-schema-mismatch',
      'historical-row-59-collision',
    ]),
    detail: Schema.String,
    migrationId: Schema.optional(Schema.Int),
    expectedName: Schema.optional(Schema.String),
    actualName: Schema.optional(Schema.String),
  },
)
{
  override get message(): string
  {
    return `Migration lineage validation failed: ${this.detail}`
  }
}

export const currentMigrationManifest: ReadonlyArray<MigrationIdentity> = migrationEntries.map(
  ([id, name]) => ({ id, name }),
)

export const validateMigrationLineage = Effect.fn('validateMigrationLineage')(function* (input: {
  readonly manifest?: ReadonlyArray<MigrationIdentity> | undefined
  readonly applied: ReadonlyArray<MigrationIdentity>
})
{
  const manifest = input.manifest ?? currentMigrationManifest
  const manifestById = new Map<number, string>()
  const manifestNames = new Set<string>()
  for (const identity of manifest)
  {
    if (manifestById.has(identity.id))
    {
      return yield* new MigrationLineageError({
        reason: 'duplicate-manifest-id',
        detail: `current manifest contains migration id ${identity.id} more than once`,
        migrationId: identity.id,
        expectedName: manifestById.get(identity.id),
        actualName: identity.name,
      })
    }
    if (manifestNames.has(identity.name))
    {
      return yield* new MigrationLineageError({
        reason: 'duplicate-manifest-name',
        detail: `current manifest contains migration name ${identity.name} more than once`,
        actualName: identity.name,
      })
    }
    manifestById.set(identity.id, identity.name)
    manifestNames.add(identity.name)
  }

  const appliedIds = new Set<number>()
  for (const identity of input.applied)
  {
    if (appliedIds.has(identity.id))
    {
      return yield* new MigrationLineageError({
        reason: 'duplicate-ledger-id',
        detail: `database ledger contains migration id ${identity.id} more than once`,
        migrationId: identity.id,
        actualName: identity.name,
      })
    }
    appliedIds.add(identity.id)

    const expectedName = manifestById.get(identity.id)
    if (expectedName === undefined)
    {
      return yield* new MigrationLineageError({
        reason: 'unknown-ledger-id',
        detail: `database contains migration ${identity.id}_${identity.name}, which is absent from this binary's full manifest`,
        migrationId: identity.id,
        actualName: identity.name,
      })
    }
    if (expectedName !== identity.name)
    {
      return yield* new MigrationLineageError({
        reason: 'ledger-name-mismatch',
        detail: `database contains ${identity.id}_${identity.name}; this binary requires ${identity.id}_${expectedName}`,
        migrationId: identity.id,
        expectedName,
        actualName: identity.name,
      })
    }
  }
})

export const makeMigrationLoader = (throughId?: number) =>
  Migrator.fromRecord(
    Object.fromEntries(
      migrationEntries
        .filter(([id]) => throughId === undefined || id <= throughId)
        .map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  )

// migrator run function - no schema dumping needed
// uses the base Migrator.make without platform dependencies
const run = Migrator.make({})

export interface RunMigrationsOptions
{
  readonly toMigrationInclusive?: number | undefined
}

interface SqliteTableColumn
{
  readonly cid: number
  readonly name: string
  readonly type: string
  readonly notnull: number
  readonly dflt_value: string | null
  readonly pk: number
}

interface SqliteIndex
{
  readonly name: string
  readonly unique: number
  readonly origin: string
  readonly partial: number
}

const expectedHistoricalDiffColumns: ReadonlyArray<Omit<SqliteTableColumn, 'cid'>> = [
  { name: 'diff_analysis_id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 1 },
  { name: 'environment_id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
  { name: 'repository_key', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
  { name: 'base_tree_oid', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
  { name: 'head_tree_oid', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
  { name: 'base_analyzer_ref', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
  { name: 'head_analyzer_ref', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
  { name: 'analyzer_version', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
  { name: 'analysis_policy_version', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
  { name: 'config_digest', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
  { name: 'scope_digest', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
  { name: 'tsconfig_digest', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
  { name: 'source_descriptor_json', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
  { name: 'state', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
  { name: 'artifact_root', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
  { name: 'head_root_path', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
  { name: 'base_graph_path', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
  { name: 'head_graph_path', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
  { name: 'impact_path', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
  { name: 'artifact_byte_length', type: 'INTEGER', notnull: 1, dflt_value: '0', pk: 0 },
  { name: 'error_code', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
  { name: 'created_at', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
  { name: 'updated_at', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
  { name: 'last_accessed_at', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
]

const expectedDiffIdentityColumns = [
  'environment_id',
  'repository_key',
  'base_tree_oid',
  'head_tree_oid',
  'analyzer_version',
  'analysis_policy_version',
  'config_digest',
  'scope_digest',
  'tsconfig_digest',
] as const

const expectedDiffIndexes = new Map([
  [
    'idx_diff_analysis_generations_repository_lru',
    ['environment_id', 'repository_key', 'last_accessed_at', 'diff_analysis_id'],
  ],
  ['idx_diff_analysis_generations_global_lru', ['last_accessed_at', 'diff_analysis_id']],
  ['idx_diff_analysis_generations_terminal_cutoff', ['updated_at', 'diff_analysis_id']],
] as const)

const normalizeSql = (value: string): string =>
  value
    .toLowerCase()
    .replaceAll(/\s/g, '')
    .replaceAll('"', '')
    .replaceAll('`', '')
    .replaceAll('[', '')
    .replaceAll(']', '')

const expectedHistoricalDiffTableSql = normalizeSql(`
  CREATE TABLE diff_analysis_generations (
    diff_analysis_id TEXT PRIMARY KEY,
    environment_id TEXT NOT NULL,
    repository_key TEXT NOT NULL,
    base_tree_oid TEXT NOT NULL,
    head_tree_oid TEXT NOT NULL,
    base_analyzer_ref TEXT NOT NULL,
    head_analyzer_ref TEXT NOT NULL,
    analyzer_version TEXT NOT NULL,
    analysis_policy_version TEXT NOT NULL,
    config_digest TEXT NOT NULL,
    scope_digest TEXT NOT NULL,
    tsconfig_digest TEXT NOT NULL,
    source_descriptor_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK(
      state IN (
        'queued',
        'preparing',
        'analyzing',
        'ready',
        'failed',
        'cancelled',
        'abandoned'
      )
    ),
    artifact_root TEXT NOT NULL,
    head_root_path TEXT,
    base_graph_path TEXT,
    head_graph_path TEXT,
    impact_path TEXT,
    artifact_byte_length INTEGER NOT NULL DEFAULT 0 CHECK(artifact_byte_length >= 0),
    error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_accessed_at TEXT NOT NULL,
    UNIQUE (
      environment_id,
      repository_key,
      base_tree_oid,
      head_tree_oid,
      analyzer_version,
      analysis_policy_version,
      config_digest,
      scope_digest,
      tsconfig_digest
    )
  )
`)

const sameStringArray = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index])

const sameHistoricalColumns = (actual: ReadonlyArray<Omit<SqliteTableColumn, 'cid'>>): boolean =>
  actual.length === expectedHistoricalDiffColumns.length &&
  actual.every((column, index) =>
  {
    const expected = expectedHistoricalDiffColumns[index]
    return (
      expected !== undefined &&
      column.name === expected.name &&
      column.type === expected.type &&
      column.notnull === expected.notnull &&
      column.dflt_value === expected.dflt_value &&
      column.pk === expected.pk
    )
  })

const historicalSchemaMismatch = (detail: string) =>
  new MigrationLineageError({
    reason: 'historical-schema-mismatch',
    detail,
    migrationId: 52,
    expectedName: 'ProjectionThreadsInteractionOrchestrate',
    actualName: 'DiffAnalysisGenerations',
  })

const readAppliedMigrationIdentities = Effect.fn('readAppliedMigrationIdentities')(function* ()
{
  const sql = yield* SqlClient.SqlClient
  return yield* sql<MigrationIdentity>`
    SELECT migration_id AS id, name
    FROM effect_sql_migrations
    ORDER BY migration_id
  `
})

const verifyHistoricalDiffSchema = Effect.fn('verifyHistoricalDiffSchema')(function* ()
{
  const sql = yield* SqlClient.SqlClient
  const columns = yield* sql<SqliteTableColumn>`PRAGMA table_info(diff_analysis_generations)`
  const actualColumns = columns.map(({ name, type, notnull, dflt_value, pk }) => ({
    name,
    type: type.toUpperCase(),
    notnull,
    dflt_value,
    pk,
  }))
  if (!sameHistoricalColumns(actualColumns))
  {
    return yield* historicalSchemaMismatch(
      'historical 52 ledger row does not have the exact DiffAnalysisGenerations column signature',
    )
  }

  const tableDefinition = yield* sql<{ readonly sql: string }>`
    SELECT sql
    FROM sqlite_master
    WHERE type = 'table' AND name = 'diff_analysis_generations'
  `
  const normalizedTableSql = normalizeSql(tableDefinition[0]?.sql ?? '')
  if (normalizedTableSql !== expectedHistoricalDiffTableSql)
  {
    return yield* historicalSchemaMismatch(
      'historical 52 diff table definition differs from the exact known lineage',
    )
  }

  const indexes = yield* sql<SqliteIndex>`PRAGMA index_list(diff_analysis_generations)`
  if (indexes.length !== 5)
  {
    return yield* historicalSchemaMismatch(
      `historical 52 diff table has ${indexes.length} indexes instead of the expected 5`,
    )
  }

  const identityIndexes = indexes.filter((index) => index.origin === 'u')
  if (identityIndexes.length !== 1 || identityIndexes[0]?.unique !== 1)
  {
    return yield* historicalSchemaMismatch(
      'historical 52 diff table does not have exactly one unique cache-identity index',
    )
  }
  const identityColumns = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM pragma_index_info(${identityIndexes[0]!.name})
    ORDER BY seqno
  `
  if (
    !sameStringArray(
      identityColumns.map((column) => column.name),
      expectedDiffIdentityColumns,
    )
  )
  {
    return yield* historicalSchemaMismatch(
      'historical 52 diff table has an unknown cache-identity index signature',
    )
  }

  for (const [name, expectedColumns] of expectedDiffIndexes)
  {
    const index = indexes.find((candidate) => candidate.name === name)
    if (index === undefined || index.unique !== 0 || index.origin !== 'c' || index.partial !== 1)
    {
      return yield* historicalSchemaMismatch(
        `historical 52 diff index ${name} is missing or changed`,
      )
    }
    const indexColumns = yield* sql<{ readonly name: string }>`
      SELECT name
      FROM pragma_index_info(${name})
      ORDER BY seqno
    `
    if (
      !sameStringArray(
        indexColumns.map((column) => column.name),
        expectedColumns,
      )
    )
    {
      return yield* historicalSchemaMismatch(`historical 52 diff index ${name} has changed columns`)
    }
    const indexDefinition = yield* sql<{ readonly sql: string }>`
      SELECT sql
      FROM sqlite_master
      WHERE type = 'index' AND name = ${name}
    `
    const predicate = name.endsWith('_terminal_cutoff')
      ? "wherestatein('failed','cancelled','abandoned')"
      : "wherestate='ready'"
    if (!normalizeSql(indexDefinition[0]?.sql ?? '').includes(predicate))
    {
      return yield* historicalSchemaMismatch(`historical 52 diff index ${name} has changed policy`)
    }
  }
})

const verifyCanonicalInteractionColumn = Effect.fn('verifyCanonicalInteractionColumn')(function* (
  required: boolean,
)
{
  const sql = yield* SqlClient.SqlClient
  const projectionTables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projection_threads'
  `
  if (projectionTables.length !== 1)
  {
    return yield* historicalSchemaMismatch(
      'historical 52 lineage is missing the projection_threads prerequisite',
    )
  }
  const columns = yield* sql<SqliteTableColumn>`PRAGMA table_info(projection_threads)`
  const interactionColumns = columns.filter((column) => column.name === 'interaction_orchestrate')
  if (interactionColumns.length === 0 && !required) return
  const column = interactionColumns[0]
  if (
    interactionColumns.length !== 1 ||
    column?.type.toUpperCase() !== 'INTEGER' ||
    column.notnull !== 1 ||
    column.dflt_value !== '0' ||
    column.pk !== 0
  )
  {
    return yield* historicalSchemaMismatch(
      'projection_threads interaction_orchestrate column is missing or has an unknown signature',
    )
  }
})

const reconcileHistoricalMigration052 = Effect.fn('reconcileHistoricalMigration052')(function* (
  applied: ReadonlyArray<MigrationIdentity>,
)
{
  const historical052 = applied.find(
    (identity) => identity.id === 52 && identity.name === 'DiffAnalysisGenerations',
  )
  if (historical052 === undefined) return false

  const row59 = applied.find((identity) => identity.id === 59)
  if (row59 !== undefined && row59.name !== 'DiffAnalysisGenerations')
  {
    return yield* new MigrationLineageError({
      reason: 'historical-row-59-collision',
      detail: `historical 52 lineage has occupied migration 59_${row59.name}; expected 59_DiffAnalysisGenerations`,
      migrationId: 59,
      expectedName: 'DiffAnalysisGenerations',
      actualName: row59.name,
    })
  }

  yield* verifyHistoricalDiffSchema()
  yield* verifyCanonicalInteractionColumn(false)
  yield* Migration0059
  yield* verifyHistoricalDiffSchema()
  yield* verifyCanonicalInteractionColumn(true)

  const sql = yield* SqlClient.SqlClient
  yield* sql`
    UPDATE effect_sql_migrations
    SET name = 'ProjectionThreadsInteractionOrchestrate'
    WHERE migration_id = 52 AND name = 'DiffAnalysisGenerations'
  `
  if (row59 === undefined)
  {
    yield* sql`
      INSERT INTO effect_sql_migrations (migration_id, name)
      VALUES (59, 'DiffAnalysisGenerations')
    `
  }

  yield* Effect.logWarning('Reconciled schema-proven historical migration lineage').pipe(
    Effect.annotateLogs({
      previousIdentity: '52_DiffAnalysisGenerations',
      canonicalIdentities: [
        '52_ProjectionThreadsInteractionOrchestrate',
        '59_DiffAnalysisGenerations',
      ],
    }),
  )
  return true
})

// ! the upstream migrator selects work by high-water mark: it skips every id
// <= the newest recorded migration. An id introduced *below* that mark - a
// number backfilled while a database had already recorded a later one - is
// therefore skipped permanently, and silently. Fresh databases never show it
// (they start at 0 and apply the whole sorted set), so tests stay green while
// long-lived installs drift. Two ids reached a live database that way before
// this guard existed. Gaps are filled here, ascending, before the forward
// pass so a backfilled migration still lands exactly once.
const backfillSkippedMigrations = Effect.fn('backfillSkippedMigrations')(function* (
  toMigrationInclusive?: number,
)
{
  const sql = yield* SqlClient.SqlClient
  const trackingTable = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `
  // a fresh database has no ledger yet, so the forward pass owns everything
  if (trackingTable.length === 0) return []

  const appliedRows = yield* sql<{ readonly migration_id: number }>`
    SELECT migration_id FROM effect_sql_migrations
  `
  if (appliedRows.length === 0) return []

  const applied = new Set(appliedRows.map((row) => row.migration_id))
  const highWaterMark = Math.max(...applied)
  const gaps = migrationEntries
    .filter(
      ([id]) =>
        id < highWaterMark &&
        !applied.has(id) &&
        (toMigrationInclusive === undefined || id <= toMigrationInclusive),
    )
    .toSorted(([leftId], [rightId]) => leftId - rightId)
  if (gaps.length === 0) return []

  for (const [id, name, migration] of gaps)
  {
    yield* sql.withTransaction(
      Effect.gen(function* ()
      {
        yield* migration
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`
      }),
    )
  }

  yield* Effect.logWarning('Applied migrations skipped by the high-water mark').pipe(
    Effect.annotateLogs({
      migrations: gaps.map(([id, name]) => `${id}_${name}`),
      highWaterMark,
    }),
  )
  return gaps.map(([id, name]) => [id, name] as const)
})

// run all pending migrations.
//
// creates the migrations tracking table (effect_sql_migrations) if it doesn't exist,
// fills any ids the high-water mark would skip, then runs everything newer.
//
// returns array of [id, name] tuples for migrations that were run.
//
// @returns Effect containing array of executed migrations
export const runMigrations = Effect.fn('runMigrations')(function* ({
  toMigrationInclusive,
}: RunMigrationsOptions = {})
{
  // validate the full binary manifest before touching a database so duplicate
  // identities cannot create an ambiguous ledger even in bounded test runs.
  yield* validateMigrationLineage({ applied: [] })

  const sql = yield* SqlClient.SqlClient
  yield* sql`PRAGMA busy_timeout = 60000`
  yield* sql`
    CREATE TABLE IF NOT EXISTS effect_sql_migrations (
      migration_id integer PRIMARY KEY NOT NULL,
      created_at datetime NOT NULL DEFAULT current_timestamp,
      name VARCHAR(255) NOT NULL
    )
  `

  return yield* sql.withTransaction(
    Effect.gen(function* ()
    {
      // acquire SQLite's write lock before reading the migration ledger
      yield* sql`
        UPDATE effect_sql_migrations
        SET name = name
        WHERE migration_id = (SELECT MAX(migration_id) FROM effect_sql_migrations)
      `

      const appliedBeforeReconciliation = yield* readAppliedMigrationIdentities()
      yield* reconcileHistoricalMigration052(appliedBeforeReconciliation)
      const applied = yield* readAppliedMigrationIdentities()
      yield* validateMigrationLineage({ applied })

      const backfilled = yield* backfillSkippedMigrations(toMigrationInclusive)
      const forward = yield* run({ loader: makeMigrationLoader(toMigrationInclusive) })
      const executedMigrations = [...backfilled, ...forward]
      const migrations = executedMigrations.map(([id, name]) => `${id}_${name}`)
      yield* migrations.length === 0
        ? Effect.logDebug('Database schema is current')
        : Effect.log('Migrations ran successfully').pipe(Effect.annotateLogs({ migrations }))
      return executedMigrations
    }),
  )
})

// layer that runs migrations when the layer is built.
//
// use this to ensure migrations run before your application starts.
// migrations are run automatically - no separate script is needed.
//
// @example
// ```typescript
// import { MigrationsLive } from "@acme/db/Migrations"
// import * as SqliteClient from "@acme/db/SqliteClient"
//
// // Migrations run automatically when SqliteClient is provided
// const AppLayer = MigrationsLive.pipe(
//   Layer.provideMerge(SqliteClient.layer({ filename: "database.sqlite" }))
// )
// ```
export const MigrationsLive = Layer.effectDiscard(runMigrations())
