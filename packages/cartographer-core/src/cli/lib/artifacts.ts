// packages/cartographer-core/src/cli/lib/artifacts.ts
// report write helpers & graph summary logging

import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import { emitArchitectureMarkdown } from '../../emit/index.js'
import { ensureOutDir, writeFileNoFollow } from '../../store/artifactFs.js'
import { architectureReportPath, DEFAULT_OUT_DIR } from '../../store/index.js'
import type { CartographerGraph } from '../../contracts/types.js'
import type { CliValues } from './args.js'

export const writeReport = (graph: CartographerGraph, root: string, outDir?: string): string =>
{
  return writeReportSource(emitArchitectureMarkdown(graph), root, outDir)
}

export const writeReportSource = (reportSource: string, root: string, outDir?: string): string =>
{
  ensureOutDir(root, outDir)
  const path = architectureReportPath(root, outDir)
  writeFileNoFollow(path, reportSource)
  return path
}

export const writeArtifacts = (graph: CartographerGraph, root: string, values: CliValues): void =>
{
  if (values.report)
  {
    writeReport(graph, root, values.out)
  }
}

export const logSummary = (graph: CartographerGraph): void =>
{
  const m = graph.metrics
  const blocks = graph.groups.length
  console.log(
    `${graph.nodes.length} files, ${graph.edges.length} imports, ` +
      `${blocks} block${blocks === 1 ? '' : 's'} | ` +
      `cycles ${m.cycles}, orphans ${m.orphans}, ` +
      `max fan-in ${m.maxFanIn}, max fan-out ${m.maxFanOut}`,
  )
}

// warn once when a git repo hasn't ignored the artifact dir
// repos that track it on purpose (cartographer's own self-graph) stay quiet
export const warnUnignoredArtifacts = (root: string, outDir?: string): void =>
{
  if (outDir !== undefined && outDir !== DEFAULT_OUT_DIR)
  {
    return
  }
  const abs = NodePath.resolve(root)
  if (!NodeFS.existsSync(NodePath.join(abs, '.git')))
  {
    return
  }
  try
  {
    NodeChildProcess.execSync(`git check-ignore -q ${DEFAULT_OUT_DIR}`, {
      cwd: abs,
      stdio: 'ignore',
    })
  }
  catch
  {
    try
    {
      const tracked = NodeChildProcess.execSync(`git ls-files ${DEFAULT_OUT_DIR}`, {
        cwd: abs,
        encoding: 'utf-8',
      }).trim()
      if (tracked)
      {
        return
      }
    }
    catch
    {
      return
    }
    console.error(
      `warning: ${DEFAULT_OUT_DIR}/ is not gitignored in ${abs} -> add ` +
        `".cartographer/" (trailing slash keeps the root sidecars committable)`,
    )
  }
}
