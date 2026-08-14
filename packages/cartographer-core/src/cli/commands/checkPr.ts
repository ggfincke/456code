// packages/cartographer-core/src/cli/commands/checkPr.ts
// emit pr-summary markdown against baseline

import { formatPrSummary } from '../../emit/index.js'
import { ensureOutDir, writeFileAtomic, writeFileNoFollow } from '../../store/artifactFs.js'
import { prDiffPath, prSummaryPath } from '../../store/index.js'
import type { GraphDiff } from '../../analyze/index.js'
import type { CliValues } from '../lib/args.js'
import { compareGraphs } from '../lib/comparison.js'

export function writeCheckPrArtifacts(
  root: string,
  outDir: string | undefined,
  diff: GraphDiff,
  summary: string,
): { diffPath: string; summaryPath: string }
{
  ensureOutDir(root, outDir)
  const diffPath = prDiffPath(root, outDir)
  const summaryPath = prSummaryPath(root, outDir)
  writeFileAtomic(diffPath, `${JSON.stringify(diff, null, 2)}\n`)
  writeFileNoFollow(summaryPath, summary)
  return { diffPath, summaryPath }
}

export const runCheckPr = async (root: string, values: CliValues): Promise<void> =>
{
  const { base, head, diff } = await compareGraphs(root, values)
  const summary = formatPrSummary(diff, base, head)
  const { diffPath, summaryPath } = writeCheckPrArtifacts(root, values.out, diff, summary)
  process.stdout.write(summary)
  console.error(`full diff -> ${diffPath}`)
  console.error(`summary -> ${summaryPath}`)
  process.exitCode = diff.newViolations.some((violation) => violation.severity === 'error') ? 1 : 0
}
