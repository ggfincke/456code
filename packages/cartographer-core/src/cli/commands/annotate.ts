// packages/cartographer-core/src/cli/commands/annotate.ts
// report undescribed/stale files, or write agent-supplied descriptions

import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import { applyAnnotations, buildGraph, hashFile } from '../../analyze/index.js'
import { graphBuildOptions, type CliValues } from '../lib/args.js'

export const runAnnotate = async (root: string, values: CliValues): Promise<void> =>
{
  const fromJson = values['from-json']
  if (fromJson !== undefined)
  {
    const raw =
      fromJson === '-'
        ? NodeFS.readFileSync(0, 'utf-8')
        : NodeFS.readFileSync(NodePath.resolve(root, fromJson), 'utf-8')
    const supplied = JSON.parse(raw) as Record<string, unknown>
    console.log(JSON.stringify(applyAnnotations(root, supplied), null, 2))
    return
  }

  const graph = await buildGraph(graphBuildOptions(root, values))
  const pending = graph.nodes
    .filter((node) => node.description === undefined)
    .map((node) => ({
      file: node.id,
      hash: hashFile(root, node.id),
      exports: (node.exports ?? []).map((e) => e.name),
    }))
  const stale = graph.nodes
    .filter((node) => node.descriptionStale)
    .map((node) => ({
      file: node.id,
      hash: hashFile(root, node.id),
      current: node.description,
    }))
  console.log(
    JSON.stringify(
      {
        files: graph.nodes.length,
        described: graph.nodes.filter((n) => n.description !== undefined).length,
        pending,
        stale,
      },
      null,
      2,
    ),
  )
}
