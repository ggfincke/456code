// packages/cartographer-core/src/cli/commands/blastRadius.ts
// compute upstream/downstream blast radius for a target

import { buildGraph, computeBlastRadius, DEFAULT_MAX_DEPTH } from '../../analyze/index.js'
import { hasGraph, loadGraph } from '../../store/index.js'
import { graphBuildOptions, parseDirection, parsePositiveInt, type CliValues } from '../lib/args.js'

export const runBlastRadius = async (root: string, values: CliValues): Promise<void> =>
{
  if (!values.target)
  {
    throw new Error('blast-radius requires --target <file[#export]>')
  }
  const direction = parseDirection(values.direction)
  const maxDepth = values['max-depth']
    ? parsePositiveInt(values['max-depth'], '--max-depth')
    : DEFAULT_MAX_DEPTH
  const graph = hasGraph(root, values.out)
    ? loadGraph(root, values.out)
    : await buildGraph(graphBuildOptions(root, values))
  const result = computeBlastRadius(graph, values.target, direction, maxDepth)
  console.log(JSON.stringify(result, null, 2))
}
