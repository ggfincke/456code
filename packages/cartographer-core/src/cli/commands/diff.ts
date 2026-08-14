// packages/cartographer-core/src/cli/commands/diff.ts
// compare head graph against baseline snapshot

import { formatDiffSummary } from '../../analyze/index.js'
import { recordSnapshot, saveGraph } from '../../store/index.js'
import type { CliValues } from '../lib/args.js'
import { compareGraphs } from '../lib/comparison.js'

export const runDiff = async (root: string, values: CliValues): Promise<void> =>
{
  const { head, diff } = await compareGraphs(root, values)
  console.log(formatDiffSummary(diff))
  if (diff.changed)
  {
    console.log(JSON.stringify(diff, null, 2))
  }
  if (values.save)
  {
    const snapshotId = recordSnapshot(head, root, values.out)
    console.log(`baseline -> ${saveGraph(head, root, values.out)} (snapshot #${snapshotId})`)
  }
  process.exitCode = diff.changed ? 1 : 0
}
