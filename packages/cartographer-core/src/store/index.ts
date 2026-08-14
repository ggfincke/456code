// packages/cartographer-core/src/store/index.ts
// graph json load/save + path helpers + snapshot history

import * as NodeFS from 'node:fs'
import { assertGraphVersion } from '../contracts/types.js'
import type { CartographerGraph } from '../contracts/types.js'
import { ensureOutDir, writeFileAtomic } from './artifactFs.js'
import { buildAtlasIndex, graphContentDigest, saveAtlasIndex } from './atlasIndex.js'
import { normalizeGraphJson } from './graphJson.js'
import { graphJsonPath } from './paths.js'

export {
  architectureReportPath,
  DEFAULT_OUT_DIR,
  graphJsonPath,
  prDiffPath,
  prSummaryPath,
} from './paths.js'
export {
  getSnapshotMeta,
  listSnapshotPage,
  listSnapshots,
  loadSnapshot,
  recordSnapshot,
  SnapshotArtifactUnavailableError,
  SnapshotCapabilityError,
  type SnapshotAccessOptions,
} from './snapshots.js'
export { proposalStaleness } from './proposalStaleness.js'
export { workingTreeState } from './workingTree.js'
export {
  listPatchPage,
  listPatches,
  loadPatch,
  patchArtifactPath,
  patchNodeResolver,
  PatchSizeError,
  savePatch,
  serializePatch,
} from './patches.js'

export function saveGraph(graph: CartographerGraph, root: string, outDir?: string): string
{
  ensureOutDir(root, outDir)
  const path = graphJsonPath(root, outDir)
  const normalized = normalizeGraphJson(graph)
  const graphBytes = `${JSON.stringify(normalized, null, 2)}\n`
  writeFileAtomic(path, graphBytes)
  saveAtlasIndex(buildAtlasIndex(normalized, graphContentDigest(graphBytes), root), root, outDir)
  return path
}

export function loadGraph(root: string, outDir?: string): CartographerGraph
{
  const path = graphJsonPath(root, outDir)
  if (!NodeFS.existsSync(path))
  {
    throw new Error(`no graph at ${path} -> run \`cartographer build\` first`)
  }
  const graph = JSON.parse(NodeFS.readFileSync(path, 'utf-8')) as CartographerGraph
  assertGraphVersion(graph.version, path)
  return normalizeGraphJson(graph)
}

export function hasGraph(root: string, outDir?: string): boolean
{
  return NodeFS.existsSync(graphJsonPath(root, outDir))
}
