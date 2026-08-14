// packages/cartographer-core/src/store/paths.ts
// artifact path helpers under <root>/.cartographer/

import * as NodePath from 'node:path'

export const DEFAULT_OUT_DIR = '.cartographer'

export function outDirPath(root: string, outDir?: string): string
{
  return NodePath.resolve(root, outDir ?? DEFAULT_OUT_DIR)
}

export function graphJsonPath(root: string, outDir?: string): string
{
  return NodePath.join(outDirPath(root, outDir), 'graph.json')
}

export function atlasIndexPath(root: string, outDir?: string): string
{
  return NodePath.join(outDirPath(root, outDir), 'atlas-index.json')
}

export function patchesDirPath(root: string, outDir?: string): string
{
  return NodePath.join(outDirPath(root, outDir), 'patches')
}

export function architectureReportPath(root: string, outDir?: string): string
{
  return NodePath.join(outDirPath(root, outDir), 'architecture.md')
}

export function prSummaryPath(root: string, outDir?: string): string
{
  return NodePath.join(outDirPath(root, outDir), 'pr-summary.md')
}

export function prDiffPath(root: string, outDir?: string): string
{
  return NodePath.join(outDirPath(root, outDir), 'pr-diff.json')
}
