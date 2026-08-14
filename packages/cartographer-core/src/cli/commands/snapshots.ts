// packages/cartographer-core/src/cli/commands/snapshots.ts
// list recorded graph snapshots

import { listSnapshots } from '../../store/index.js'
import type { CliValues } from '../lib/args.js'

export const runSnapshots = (root: string, values: CliValues): void =>
{
  const snapshots = listSnapshots(root, values.out)
  if (snapshots.length === 0)
  {
    console.log('no snapshots -> run `cartographer build` first')
    return
  }
  for (const s of snapshots)
  {
    console.log(
      `#${s.id}  ${s.createdAt}  ${s.gitRef ?? '-------'}  ` +
        `${s.nodes} files, ${s.edges} imports, ${s.cycles} cycles  (${s.scope})`,
    )
  }
}
