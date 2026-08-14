// packages/cartographer-core/src/cli/lib/comparison.ts
// build & compare the current graph against its selected baseline

import { buildGraph, diffGraphs, type GraphDiff } from '../../analyze/index.js'
import { loadSnapshot } from '../../store/index.js'
import type { CartographerGraph } from '../../contracts/types.js'
import { graphBuildOptions, loadBaseline, parsePositiveInt, type CliValues } from './args.js'

interface GraphComparison
{
  base: CartographerGraph
  head: CartographerGraph
  diff: GraphDiff
}

export const compareGraphs = async (root: string, values: CliValues): Promise<GraphComparison> =>
{
  const base = values.base
    ? loadSnapshot(root, parsePositiveInt(values.base, '--base'), values.out)
    : loadBaseline(root, values.out)
  const head = await buildGraph(graphBuildOptions(root, values, base.scope))
  return { base, head, diff: diffGraphs(base, head) }
}
