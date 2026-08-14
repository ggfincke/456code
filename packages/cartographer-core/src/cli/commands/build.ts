// packages/cartographer-core/src/cli/commands/build.ts
// build graph, optional history snapshot & optional markdown report

import { runBuildPipeline } from '../../store/pipeline.js'
import { graphBuildOptions, type CliValues } from '../lib/args.js'
import { logSummary, warnUnignoredArtifacts, writeReport } from '../lib/artifacts.js'

export const runBuild = async (root: string, values: CliValues): Promise<void> =>
{
  const { graph, graphPath, snapshotId } = await runBuildPipeline({
    ...graphBuildOptions(root, values),
    ...(values.out === undefined ? {} : { outDir: values.out }),
    snapshot: values['no-history'] !== true,
  })
  console.log(
    `graph -> ${graphPath}${snapshotId === undefined ? '' : ` (snapshot #${snapshotId})`}`,
  )
  logSummary(graph)
  warnUnignoredArtifacts(root, values.out)
  if (values.report)
  {
    console.log(`report -> ${writeReport(graph, root, values.out)}`)
  }
}
