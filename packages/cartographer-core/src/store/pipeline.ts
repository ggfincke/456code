// packages/cartographer-core/src/store/pipeline.ts
// shared build pipeline: graph build + persist + optional history

import { buildGraph, type BuildGraphOptions } from '../analyze/index.js'
import type { CartographerGraph } from '../contracts/types.js'
import { saveGraph } from './index.js'
import { recordSnapshot } from './snapshots.js'

export interface BuildPipelineOptions extends BuildGraphOptions
{
  outDir?: string
  // record a graph.db history snapshot; watch rebuilds deliberately skip this
  snapshot?: boolean
}

export interface BuildPipelineResult
{
  graph: CartographerGraph
  graphPath: string
  snapshotId?: number
}

export async function runBuildPipeline(opts: BuildPipelineOptions): Promise<BuildPipelineResult>
{
  const graph = await buildGraph({
    root: opts.root,
    ...(opts.scope === undefined ? {} : { scope: opts.scope }),
    ...(opts.tsconfig === undefined ? {} : { tsconfig: opts.tsconfig }),
  })
  const graphPath = saveGraph(graph, opts.root, opts.outDir)
  const snapshotId = opts.snapshot ? recordSnapshot(graph, opts.root, opts.outDir) : undefined
  return {
    graph,
    graphPath,
    ...(snapshotId === undefined ? {} : { snapshotId }),
  }
}
