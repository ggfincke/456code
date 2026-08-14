// packages/cartographer-core/src/analyze/index.ts
// graph extraction barrel

export { fileDegrees } from './degrees.js'
export {
  buildGraph,
  DEFAULT_SCOPE,
  TSCONFIG_DISCOVERY_DESC,
  type BuildGraphOptions,
} from './graph.js'
export {
  computeBlastRadius,
  DEFAULT_MAX_DEPTH,
  impactedFileCount,
  type BlastDirection,
} from './blast-radius.js'
export { createGraphRelationIndex, type GraphRelationIndex } from './graphRelations.js'
export {
  computeImpactProfile,
  type BoundedImpactItems,
  type ImpactProfile,
  type ImpactProfileInput,
} from './impactProfile.js'
export {
  boundApiChanges,
  boundList,
  boundPatchValidation,
  projectBoundedApiChanges,
  type BoundedExportEvidence,
} from './evidenceBounds.js'
export {
  diffGraphs,
  formatDiffSummary,
  summarizeApiChanges,
  type ExportChange,
  type GraphDiff,
  type ViolationDelta,
} from './diff.js'
export { parseGraphDiff } from './diffCodec.js'
export { formatEdgeEndpoints, type EdgeEndpoints } from './edgeIdentity.js'
export {
  applyPatch,
  MAX_PATCH_OPS,
  parseGraphPatch,
  PATCH_SCHEMA_VERSION,
  patchToDiff,
  validatePatchStructure,
  type GraphPatch,
  type PatchApplyResult,
  type PatchNodeResolver,
  type PatchValidation,
} from './patch.js'
export {
  evaluatePatch,
  MAX_PATCH_EVALUATION_EDGES,
  MAX_PATCH_EVALUATION_NODES,
  MAX_PATCH_EVALUATION_WORK,
  PatchEvaluationLimitError,
} from './patchEvaluation.js'
export { aggregateGroupEdges, graphGroups } from './aggregate.js'
export { applyAnnotations, hashFile } from './annotations.js'
