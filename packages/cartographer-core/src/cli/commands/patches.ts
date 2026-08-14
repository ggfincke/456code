// packages/cartographer-core/src/cli/commands/patches.ts
// list stored graph-patch proposals

import {
  hasGraph,
  listPatches,
  loadGraph,
  proposalStaleness,
  workingTreeState,
} from '../../store/index.js'
import type { CliValues } from '../lib/args.js'

export const runPatches = (root: string, values: CliValues): void =>
{
  const patches = listPatches(root, values.out)
  if (patches.length === 0)
  {
    console.log('no proposals -> save one with the propose_patch MCP tool')
    return
  }
  const graph = hasGraph(root, values.out) ? loadGraph(root, values.out) : undefined
  const workingTree = graph ? workingTreeState(root) : undefined
  for (const patch of patches)
  {
    if (patch.invalid)
    {
      console.log(`${patch.id}  INVALID: ${patch.invalid.message}`)
      continue
    }
    const totals = patch.opTotals
    const ops = totals
      ? `+${totals.addFiles} -${totals.removeFiles} ~${totals.moves} ` +
        `imports +${totals.addImports}/-${totals.removeImports}`
      : ''
    const staleness = graph ? proposalStaleness(patch.baseline, graph, workingTree) : undefined
    const stale = staleness?.stale ? `  [stale: ${staleness.reasons.join(', ')}]` : ''
    console.log(
      `${patch.id}  ${patch.createdAt ?? ''}  ${patch.baseline?.gitRef ?? '-------'}  ` +
        `${ops}  ${patch.name ?? ''}${stale}`,
    )
  }
}
