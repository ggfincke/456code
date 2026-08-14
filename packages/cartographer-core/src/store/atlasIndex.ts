// packages/cartographer-core/src/store/atlasIndex.ts
// compact coarse atlas index derivation, persistence & bounded paging

export {
  ATLAS_INDEX_QUERY_LIMIT,
  ATLAS_INDEX_QUERY_LIMIT_MAX,
  ATLAS_INDEX_TOP_FILE_LIMIT,
} from './atlasIndex/constants.js'
export { buildAtlasIndex } from './atlasIndex/build.js'
export { graphContentDigest } from './atlasIndex/digest.js'
export {
  AtlasIndexUnavailableError,
  atlasIndexSummary,
  disposeAtlasIndexCache,
  ensureAtlasIndex,
  saveAtlasIndex,
  type EnsureAtlasIndexOptions,
} from './atlasIndex/persist.js'
export { queryAtlasFiles, queryAtlasIndex } from './atlasIndex/query.js'
