// packages/cartographer-core/src/store/disposeAtlasArtifacts.ts
// release in-process state associated with one architecture artifact directory

import { disposeAtlasIndexCache } from './atlasIndex.js'
import { disposePatchCatalogCache } from './patches.js'
import { disposeWorkingTreeCache } from './workingTree.js'

export function disposeAtlasArtifacts(root: string, outDir?: string): Promise<void>
{
  disposeWorkingTreeCache(root)
  disposeAtlasIndexCache(root, outDir)
  disposePatchCatalogCache(root, outDir)
  return Promise.resolve()
}
