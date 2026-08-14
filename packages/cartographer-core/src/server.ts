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
export { disposeAtlasArtifacts } from './store/disposeAtlasArtifacts.js'
export { graphContentDigest, queryAtlasFiles, queryAtlasIndex } from './store/atlasIndex.js'
export { parseAtlasIndex } from './contracts/atlasIndexCodec.js'
export type {
  AtlasIndex,
  AtlasIndexEdge,
  AtlasIndexFile,
  AtlasIndexLevel,
  AtlasIndexScopeSummary,
  AtlasIndexUnit,
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
