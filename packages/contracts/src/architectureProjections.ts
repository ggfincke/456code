// packages/contracts/src/architectureProjections.ts
// defines generation-bound native architecture projection transports

import * as Schema from 'effect/Schema'

import {
  GitRefString,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from './baseSchemas.ts'
import { DiffAnalysisId, ProposalGenerationId } from './cartographer.ts'
import { ArchitectureRelativePath } from './architecturePath.ts'
import {
  ARCHITECTURE_BLAST_PATH_LIMIT,
  ArchitectureComparisonSelector,
  ArchitectureGraphDiffResult,
} from './architectureTools.ts'

export const ARCHITECTURE_PROJECTION_UNIT_LIMIT = 200
export const ARCHITECTURE_PROJECTION_EDGE_LIMIT = 400
export const ARCHITECTURE_PROJECTION_FILE_LIMIT = 100
export const ARCHITECTURE_SOURCE_MAX_BYTES = 2 * 1024 * 1024

export const ArchitectureGenerationId = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isPattern(/^[0-9a-f]{64}$/u),
)
export type ArchitectureGenerationId = typeof ArchitectureGenerationId.Type

export const ArchitectureGraphDigest = Schema.String.check(
  Schema.isPattern(/^sha256:[0-9a-f]{64}$/u),
)
export type ArchitectureGraphDigest = typeof ArchitectureGraphDigest.Type

export const ArchitectureSourceDigest = Schema.String.check(
  Schema.isPattern(/^sha256:[0-9a-f]{64}$/u),
)
export type ArchitectureSourceDigest = typeof ArchitectureSourceDigest.Type

export { ArchitectureRelativePath }

export const ArchitectureProposalSource = Schema.Struct({
  kind: Schema.Literal('proposal-generation'),
  threadId: ThreadId,
  generationId: ProposalGenerationId,
  side: Schema.Literals(['base', 'proposed']),
  graphDigest: ArchitectureGraphDigest,
})
export type ArchitectureProposalSource = typeof ArchitectureProposalSource.Type

export const ArchitectureDiffSource = Schema.Struct({
  kind: Schema.Literal('diff-analysis'),
  threadId: ThreadId,
  diffAnalysisId: DiffAnalysisId,
  side: Schema.Literals(['base', 'head']),
  graphDigest: ArchitectureGraphDigest,
})
export type ArchitectureDiffSource = typeof ArchitectureDiffSource.Type

export const ArchitectureStandingSource = Schema.Struct({
  kind: Schema.Literal('standing-project-generation'),
  projectId: ProjectId,
  generationId: ArchitectureGenerationId,
  side: Schema.Literal('analyzed'),
  graphDigest: ArchitectureGraphDigest,
})
export type ArchitectureStandingSource = typeof ArchitectureStandingSource.Type

export const ArchitectureProjectionSource = Schema.Union([
  ArchitectureProposalSource,
  ArchitectureDiffSource,
  ArchitectureStandingSource,
])
export type ArchitectureProjectionSource = typeof ArchitectureProjectionSource.Type

export const CartographerEnsureProjectArchitectureInput = Schema.Struct({
  projectId: ProjectId,
})
export type CartographerEnsureProjectArchitectureInput =
  typeof CartographerEnsureProjectArchitectureInput.Type

export const CartographerSubscribeProjectAtlasStatusInput = Schema.Struct({
  projectId: ProjectId,
})
export type CartographerSubscribeProjectAtlasStatusInput =
  typeof CartographerSubscribeProjectAtlasStatusInput.Type

export const ProjectAtlasStatus = Schema.Struct({
  state: Schema.Literals(['idle', 'building', 'ready', 'error']),
  source: Schema.NullOr(ArchitectureStandingSource),
  freshness: Schema.Struct({
    builtAt: Schema.NullOr(IsoDateTime),
    dirty: Schema.Boolean,
  }),
  lastBuildError: Schema.NullOr(TrimmedNonEmptyString),
})
export type ProjectAtlasStatus = typeof ProjectAtlasStatus.Type

export const ArchitectureImpactResultV2 = Schema.Struct({
  ...ArchitectureGraphDiffResult.fields,
  version: Schema.Literal(2),
  comparison: ArchitectureComparisonSelector,
  impactDigest: ArchitectureSourceDigest,
  baseSource: Schema.Union([ArchitectureProposalSource, ArchitectureDiffSource]),
  headSource: Schema.Union([ArchitectureProposalSource, ArchitectureDiffSource]),
})
export type ArchitectureImpactResultV2 = typeof ArchitectureImpactResultV2.Type

export const ArchitectureImpactResult = Schema.Union([
  ArchitectureGraphDiffResult,
  ArchitectureImpactResultV2,
])
export type ArchitectureImpactResult = typeof ArchitectureImpactResult.Type

export const ArchitectureProjectionLevel = Schema.Literals(['systems', 'blocks', 'dirs'])
export type ArchitectureProjectionLevel = typeof ArchitectureProjectionLevel.Type

export const ArchitectureProjectionCount = Schema.Struct({
  total: NonNegativeInt,
  indexed: NonNegativeInt,
  returned: NonNegativeInt,
  omitted: NonNegativeInt,
}).check(
  Schema.makeFilter(
    (value) =>
      (value.total === value.indexed + value.omitted && value.returned <= value.indexed) ||
      'Projection totals must preserve exact indexed and omitted counts.',
  ),
)
export type ArchitectureProjectionCount = typeof ArchitectureProjectionCount.Type

export const ArchitectureProjectionPosition = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
})

export const ArchitectureProjectionUnit = Schema.Struct({
  id: Schema.String.check(Schema.isNonEmpty()),
  key: Schema.String.check(Schema.isNonEmpty()),
  level: ArchitectureProjectionLevel,
  label: Schema.String.check(Schema.isNonEmpty()),
  description: Schema.optionalKey(Schema.String),
  parent: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty())),
  source: Schema.optionalKey(Schema.Literals(['authored', 'fallback', 'inferred'])),
  fileCount: NonNegativeInt,
  inbound: NonNegativeInt,
  outbound: NonNegativeInt,
  position: ArchitectureProjectionPosition,
})
export type ArchitectureProjectionUnit = typeof ArchitectureProjectionUnit.Type

export const ArchitectureProjectionEdge = Schema.Struct({
  from: Schema.String.check(Schema.isNonEmpty()),
  to: Schema.String.check(Schema.isNonEmpty()),
  weight: PositiveInt,
})
export type ArchitectureProjectionEdge = typeof ArchitectureProjectionEdge.Type

export const ArchitectureProjectionFile = Schema.Struct({
  id: ArchitectureRelativePath,
  label: Schema.String.check(Schema.isNonEmpty()),
  description: Schema.optionalKey(Schema.String),
  system: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty())),
  block: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty())),
  dir: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty())),
  fanIn: NonNegativeInt,
  fanOut: NonNegativeInt,
})
export type ArchitectureProjectionFile = typeof ArchitectureProjectionFile.Type

const ArchitectureProjectionUnits = Schema.Array(ArchitectureProjectionUnit).check(
  Schema.isMaxLength(ARCHITECTURE_PROJECTION_UNIT_LIMIT),
)
const ArchitectureProjectionEdges = Schema.Array(ArchitectureProjectionEdge).check(
  Schema.isMaxLength(ARCHITECTURE_PROJECTION_EDGE_LIMIT),
)
const ArchitectureProjectionFiles = Schema.Array(ArchitectureProjectionFile).check(
  Schema.isMaxLength(ARCHITECTURE_PROJECTION_FILE_LIMIT),
)

export const ArchitectureRepositoryCounts = Schema.Struct({
  files: NonNegativeInt,
  imports: NonNegativeInt,
  systems: NonNegativeInt,
  blocks: NonNegativeInt,
  dirs: NonNegativeInt,
})

export const ArchitectureRepositoryHealth = Schema.Struct({
  cycles: NonNegativeInt,
  orphans: NonNegativeInt,
  violatingImports: NonNegativeInt,
  violatedRules: NonNegativeInt,
  ruleTotal: NonNegativeInt,
}).check(
  Schema.makeFilter(
    (value) =>
      value.violatedRules <= value.ruleTotal ||
      'Violated rule count cannot exceed the exact rule total.',
  ),
)

export const CartographerGetRepositoryMapInput = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  generationId: Schema.optionalKey(ArchitectureGenerationId),
})
export type CartographerGetRepositoryMapInput = typeof CartographerGetRepositoryMapInput.Type

export const CartographerGetRepositoryMapResult = Schema.Struct({
  version: Schema.Literal(1),
  source: ArchitectureStandingSource,
  builtAt: IsoDateTime,
  dirty: Schema.Boolean,
  repo: Schema.Struct({
    name: Schema.String.check(Schema.isNonEmpty()),
    scope: Schema.String.check(Schema.isNonEmpty()),
    gitRef: Schema.optionalKey(GitRefString),
  }),
  counts: ArchitectureRepositoryCounts,
  health: ArchitectureRepositoryHealth,
  level: Schema.Literals(['systems', 'blocks']),
  systemSource: Schema.Literals(['authored', 'inferred']),
  units: ArchitectureProjectionUnits,
  unitCount: ArchitectureProjectionCount,
  edges: ArchitectureProjectionEdges,
  edgeCount: ArchitectureProjectionCount,
})
export type CartographerGetRepositoryMapResult = typeof CartographerGetRepositoryMapResult.Type

export const ArchitectureScopeSelector = Schema.Struct({
  level: Schema.Literals(['systems', 'blocks', 'dirs']),
  id: Schema.String.check(Schema.isNonEmpty()),
})
export type ArchitectureScopeSelector = typeof ArchitectureScopeSelector.Type

export const CartographerGetArchitectureScopeInput = Schema.Struct({
  threadId: ThreadId,
  source: ArchitectureStandingSource,
  scope: ArchitectureScopeSelector,
  cursor: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty())),
  limit: Schema.optionalKey(PositiveInt),
  fileCursor: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty())),
  fileLimit: Schema.optionalKey(PositiveInt),
})
export type CartographerGetArchitectureScopeInput =
  typeof CartographerGetArchitectureScopeInput.Type

export const CartographerGetArchitectureScopeResult = Schema.Struct({
  version: Schema.Literal(1),
  source: ArchitectureStandingSource,
  scope: ArchitectureScopeSelector,
  childLevel: Schema.Literals(['blocks', 'dirs']),
  children: ArchitectureProjectionUnits,
  childCount: ArchitectureProjectionCount,
  nextCursor: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty())),
  edges: ArchitectureProjectionEdges,
  edgeCount: ArchitectureProjectionCount,
  files: ArchitectureProjectionFiles,
  fileCount: ArchitectureProjectionCount,
  nextFileCursor: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty())),
})
export type CartographerGetArchitectureScopeResult =
  typeof CartographerGetArchitectureScopeResult.Type

export const CartographerGetArchitectureNeighborhoodInput = Schema.Struct({
  threadId: ThreadId,
  source: ArchitectureProjectionSource,
  target: ArchitectureRelativePath,
  direction: Schema.Literals(['upstream', 'downstream', 'both']),
  maxDepth: PositiveInt,
})
export type CartographerGetArchitectureNeighborhoodInput =
  typeof CartographerGetArchitectureNeighborhoodInput.Type

export const ArchitectureNeighborhoodFiles = Schema.Struct({
  items: Schema.Array(ArchitectureRelativePath).check(
    Schema.isMaxLength(ARCHITECTURE_BLAST_PATH_LIMIT),
  ),
  total: NonNegativeInt,
  omitted: NonNegativeInt,
}).check(
  Schema.makeFilter(
    (value) =>
      value.total === value.items.length + value.omitted ||
      'Neighborhood total must equal returned files plus omitted files.',
  ),
)

export const CartographerGetArchitectureNeighborhoodResult = Schema.Struct({
  version: Schema.Literal(1),
  source: ArchitectureProjectionSource,
  target: ArchitectureRelativePath,
  direction: Schema.Literals(['upstream', 'downstream', 'both']),
  maxDepth: PositiveInt,
  upstream: ArchitectureNeighborhoodFiles,
  downstream: ArchitectureNeighborhoodFiles,
  impactedFileCount: NonNegativeInt,
})
export type CartographerGetArchitectureNeighborhoodResult =
  typeof CartographerGetArchitectureNeighborhoodResult.Type

export const CartographerGetArchitectureSourceInput = Schema.Struct({
  threadId: ThreadId,
  source: Schema.Union([ArchitectureProposalSource, ArchitectureDiffSource]),
  relativePath: ArchitectureRelativePath,
})
export type CartographerGetArchitectureSourceInput =
  typeof CartographerGetArchitectureSourceInput.Type

export const CartographerGetArchitectureSourceResult = Schema.Struct({
  version: Schema.Literal(1),
  source: Schema.Union([ArchitectureProposalSource, ArchitectureDiffSource]),
  relativePath: ArchitectureRelativePath,
  sourceDigest: ArchitectureSourceDigest,
  content: Schema.String.check(
    Schema.makeFilter((value) =>
      new TextEncoder().encode(value).byteLength <= ARCHITECTURE_SOURCE_MAX_BYTES
        ? true
        : `Architecture source is limited to ${ARCHITECTURE_SOURCE_MAX_BYTES} bytes.`,
    ),
  ),
})
export type CartographerGetArchitectureSourceResult =
  typeof CartographerGetArchitectureSourceResult.Type

export const ArchitecturePathScopeChip = Schema.Struct({
  role: Schema.Literals(['touched', 'context']),
  level: Schema.Literals(['systems', 'blocks']),
  id: Schema.String.check(Schema.isNonEmpty()),
  key: Schema.String.check(Schema.isNonEmpty()),
  label: Schema.String.check(Schema.isNonEmpty()),
})
export type ArchitecturePathScopeChip = typeof ArchitecturePathScopeChip.Type

export const CartographerGetArchitecturePathScopeInput = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  paths: Schema.Array(ArchitectureRelativePath).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(ARCHITECTURE_BLAST_PATH_LIMIT),
  ),
  generationId: Schema.optionalKey(ArchitectureGenerationId),
})
export type CartographerGetArchitecturePathScopeInput =
  typeof CartographerGetArchitecturePathScopeInput.Type

export const CartographerGetArchitecturePathScopeResult = Schema.Struct({
  version: Schema.Literal(1),
  source: ArchitectureStandingSource,
  chips: Schema.Array(ArchitecturePathScopeChip).check(
    Schema.isMaxLength(ARCHITECTURE_PROJECTION_UNIT_LIMIT),
  ),
})
export type CartographerGetArchitecturePathScopeResult =
  typeof CartographerGetArchitecturePathScopeResult.Type
