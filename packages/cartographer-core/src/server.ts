// packages/cartographer-core/src/server.ts
// node server integration facade

export { diffGraphs } from './analyze/diff.js'
export {
  boundApiChanges,
  boundList,
  boundPatchValidation,
  evaluatePatch,
  formatDiffSummary,
  parseGraphDiff,
  parseGraphPatch,
  PatchEvaluationLimitError,
  type GraphDiff,
} from './analyze/index.js'
export {
  IMPACT_PROJECTION_EDGE_LIMIT,
  IMPACT_PROJECTION_EVIDENCE_LIMIT,
  IMPACT_PROJECTION_LAYOUT_VERSION,
  IMPACT_PROJECTION_NODE_LIMIT,
  IMPACT_PROJECTION_SCHEMA_VERSION,
  parseVerifiedImpactProjection,
  type ImpactProjectionEdge,
  type ImpactProjectionEvidence,
  type ImpactProjectionLevel,
  type ImpactProjectionNode,
  type ImpactProjectionState,
  type VerifiedImpactProjectionArtifact,
} from './analyze/index.js'
export { disposeAtlasArtifacts } from './store/disposeAtlasArtifacts.js'
export {
  graphContentDigest,
  queryAtlasFiles,
  queryAtlasIndex,
  queryAtlasStructureDirectories,
  queryAtlasStructureEdges,
  queryAtlasStructureFiles,
} from './store/atlasIndex.js'
export { parseAtlasIndex } from './contracts/atlasIndexCodec.js'
export type {
  AtlasIndex,
  AtlasIndexCrosswalks,
  AtlasIndexDominantCrosswalk,
  AtlasIndexEdge,
  AtlasIndexFile,
  AtlasIndexFileCrosswalk,
  AtlasIndexLevel,
  AtlasIndexScopeSummary,
  AtlasIndexStructure,
  AtlasIndexStructureDirectory,
  AtlasIndexStructureEdge,
  AtlasIndexUnit,
  AtlasIndexV6,
  SourceGraphDigest,
} from './contracts/types.js'
export { ATLAS_INDEX_SCHEMA_VERSION } from './contracts/types.js'
export {
  patchNodeResolver,
  PatchSizeError,
  proposalStaleness,
  serializePatch,
  workingTreeState,
} from './store/index.js'
export {
  ContextQueryError,
  loadContextQuery,
  queryContextDiff,
  queryContextImpact,
  type ContextQueryGraph,
} from './query/index.js'
