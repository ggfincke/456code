export { fileDegrees } from "./degrees.js";
export {
  buildGraph,
  DEFAULT_SCOPE,
  TSCONFIG_DISCOVERY_DESC,
  type BuildGraphOptions,
} from "./graph.js";
export {
  computeBlastRadius,
  DEFAULT_MAX_DEPTH,
  impactedFileCount,
  type BlastDirection,
} from "./blast-radius.js";
export { createGraphRelationIndex, type GraphRelationIndex } from "./graphRelations.js";
export {
  computeImpactProfile,
  type BoundedImpactItems,
  type ImpactProfile,
  type ImpactProfileInput,
} from "./impactProfile.js";
export {
  boundApiChanges,
  boundList,
  projectBoundedApiChanges,
  type BoundedExportEvidence,
} from "./evidenceBounds.js";
export {
  diffGraphs,
  formatDiffSummary,
  summarizeApiChanges,
  type ExportChange,
  type GraphDiff,
  type ViolationDelta,
} from "./diff.js";
export { parseGraphDiff } from "./diffCodec.js";
export {
  buildVerifiedImpactProjection,
  IMPACT_PROJECTION_EDGE_LIMIT,
  IMPACT_PROJECTION_EVIDENCE_LIMIT,
  IMPACT_PROJECTION_LAYOUT_VERSION,
  IMPACT_PROJECTION_NODE_LIMIT,
  IMPACT_PROJECTION_SCHEMA_VERSION,
  type BuildVerifiedImpactProjectionInput,
  type ImpactProjectionEdge,
  type ImpactProjectionEvidence,
  type ImpactProjectionLevel,
  type ImpactProjectionNode,
  type ImpactProjectionState,
  type VerifiedImpactProjectionArtifact,
} from "./impactProjection.js";
export { parseVerifiedImpactProjection } from "./impactProjectionCodec.js";
export {
  buildSemanticSnapshot,
  directoryOf,
  directoryPrefixes,
  parentDirectory,
  semanticEdgeKey,
  semanticUnitId,
  type SemanticDirectoryScopeEdge,
  type SemanticEdge,
  type SemanticLevel,
  type SemanticSnapshot,
  type SemanticUnit,
} from "./semanticMembership.js";
export { formatEdgeEndpoints, type EdgeEndpoints } from "./edgeIdentity.js";
export { aggregateGroupEdges, graphGroups } from "./aggregate.js";
export { applyAnnotations, hashFile } from "./annotations.js";
