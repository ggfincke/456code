// packages/cartographer-core/src/mcp/server.ts
// defines the importable Cartographer MCP server and its public tools

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  aggregateGroupEdges,
  applyAnnotations,
  boundApiChanges,
  boundList as bounded,
  boundPatchValidation,
  buildGraph,
  computeBlastRadius,
  DEFAULT_MAX_DEPTH,
  diffGraphs,
  fileDegrees,
  formatDiffSummary,
  graphGroups,
  impactedFileCount,
  MAX_PATCH_EVALUATION_EDGES,
  MAX_PATCH_EVALUATION_NODES,
  MAX_PATCH_EVALUATION_WORK,
  MAX_PATCH_OPS,
  parseGraphPatch,
  PATCH_SCHEMA_VERSION,
  projectBoundedApiChanges,
  TSCONFIG_DISCOVERY_DESC,
  evaluatePatch,
  type PatchValidation,
} from '../analyze/index.js'
import { emitArchitectureMarkdown } from '../emit/index.js'
import { ensureOutDir, writeFileNoFollow } from '../store/artifactFs.js'
import {
  architectureReportPath,
  hasGraph,
  listPatchPage,
  listSnapshots,
  loadGraph,
  loadPatch,
  loadSnapshot,
  patchArtifactPath,
  patchNodeResolver,
  proposalStaleness,
  recordSnapshot,
  saveGraph,
  savePatch,
  workingTreeState,
} from '../store/index.js'
import { runBuildPipeline } from '../store/pipeline.js'
import type { GraphDiff } from '../analyze/diff.js'
import type { CartographerGraph } from '../contracts/types.js'

const server = new McpServer({
  name: 'cartographer',
  version: '0.1.0',
})

const analyzeRoot = z.string().describe('Absolute path to the repository root to analyze.')

const analyzeTsconfig = z.string().optional().describe(TSCONFIG_DISCOVERY_DESC)

// --- graph_repo ---------------------------------------------------------------

server.tool(
  'graph_repo',
  'Build the TS/JS imports graph for a repository via dependency-cruiser. Writes graph.json (nodes w/ exported symbols, edges w/ imported symbol names, groups, metrics) to <root>/.cartographer/ & returns a structured summary: file/import/export counts, cycles, orphans, fan-in/fan-out hotspots, plus a block-level rollup (named groups from .cartographer.json or folder heuristic, w/ cross-block import counts) — usually the best starting point for architecture questions. Per-file export lists live in graph.json nodes[].exports; per-edge imported names in edges[].symbols. Optionally also emits architecture.md (frontmatter, metrics tables, Mermaid diagrams). Call this first — blast_radius reuses the saved graph & accepts file#export targets.',
  {
    root: analyzeRoot,
    scope: z
      .string()
      .optional()
      .describe("Directory under root to graph, relative to root. Default: 'src'."),
    tsconfig: analyzeTsconfig,
    emitReport: z
      .boolean()
      .optional()
      .describe('Also write architecture.md next to graph.json. Default: false.'),
  },
  async (args) =>
  {
    try
    {
      const {
        graph,
        graphPath: graphJsonPath,
        snapshotId,
      } = await runBuildPipeline({
        root: args.root,
        ...(args.scope === undefined ? {} : { scope: args.scope }),
        ...(args.tsconfig === undefined ? {} : { tsconfig: args.tsconfig }),
        snapshot: true,
      })
      let reportPath: string | undefined
      if (args.emitReport)
      {
        ensureOutDir(args.root)
        reportPath = architectureReportPath(args.root)
        writeFileNoFollow(reportPath, emitArchitectureMarkdown(graph))
      }
      return jsonResult({
        graphJsonPath,
        snapshotId,
        ...(reportPath ? { reportPath } : {}),
        ...summarize(graph),
      })
    }
    catch (err)
    {
      return errorResult('graph_repo', err)
    }
  },
)

// --- graph_diff -----------------------------------------------------------------

server.tool(
  'graph_diff',
  'Compare a baseline graph against a fresh build of the current working tree. Baseline is the saved graph.json by default, or a historical snapshot when baseSnapshotId is set. Returns added/removed files & imports (move-explained churn excluded), detected file moves (movedNodes pairs + dir-level moveFlows + the movedEdges count of imports that just followed moves), public API changes (per-file added/removed exports; each removed export has brokenConsumers listing only head-graph files that still import it), & a one-line drift summary. Requires a prior graph_repo call (or CLI build) to establish the baseline. Pass save: true to promote the fresh build to the new baseline after diffing.',
  {
    root: analyzeRoot,
    scope: z
      .string()
      .optional()
      .describe('Directory under root to graph. Default: the baseline scope.'),
    tsconfig: analyzeTsconfig,
    baseSnapshotId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Diff against this snapshot from graph.db instead of the saved graph.json. Get ids from list_snapshots.',
      ),
    save: z
      .boolean()
      .optional()
      .describe('Overwrite the saved baseline w/ the fresh build. Default: false.'),
  },
  async (args) =>
  {
    try
    {
      if (!args.baseSnapshotId && !hasGraph(args.root))
      {
        return errorResult('graph_diff', new Error('no baseline graph -> call graph_repo first'))
      }
      const base = args.baseSnapshotId
        ? loadSnapshot(args.root, args.baseSnapshotId)
        : loadGraph(args.root)
      const head = await buildGraph({
        root: args.root,
        scope: args.scope ?? base.scope,
        ...(args.tsconfig === undefined ? {} : { tsconfig: args.tsconfig }),
      })
      const diff = diffGraphs(base, head)
      let snapshotId: number | undefined
      if (args.save)
      {
        saveGraph(head, args.root)
        snapshotId = recordSnapshot(head, args.root)
      }
      return jsonResult({
        summary: formatDiffSummary(diff),
        ...(snapshotId ? { snapshotId } : {}),
        ...boundedDiff(diff),
      })
    }
    catch (err)
    {
      return errorResult('graph_diff', err)
    }
  },
)

// --- list_snapshots -------------------------------------------------------------

server.tool(
  'list_snapshots',
  'List the snapshot history recorded in <root>/.cartographer/graph.db — id, timestamp, git ref, file/import/cycle counts per snapshot. Use ids w/ graph_diff baseSnapshotId to measure drift over time.',
  {
    root: analyzeRoot,
  },
  async (args) =>
  {
    try
    {
      return jsonResult({ snapshots: listSnapshots(args.root) })
    }
    catch (err)
    {
      return errorResult('list_snapshots', err)
    }
  },
)

// --- blast_radius ---------------------------------------------------------------

server.tool(
  'blast_radius',
  'List the files impacted by a change to one file — or one exported symbol — from the saved imports graph (builds it on demand when missing). Returns upstream (files that import the target, directly or transitively — the change ripple) & downstream (files the target imports). Target is a path relative to the repo root, optionally narrowed w/ #exportName (e.g. src/auth/session.ts#refreshToken) so only consumers actually importing that export seed the ripple — the way to answer "what depends on this exported function?". Symbol targets report precision symbol-first-hop: hops past the direct consumers are file-level.',
  {
    root: analyzeRoot,
    target: z
      .string()
      .describe(
        "File to analyze, relative to root, w/ optional #export (e.g. 'src/auth/session.ts' or 'src/auth/session.ts#refreshToken').",
      ),
    direction: z
      .enum(['both', 'upstream', 'downstream'])
      .optional()
      .describe("Traversal direction. Default: 'both'."),
    maxDepth: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(`Max traversal depth. Default: ${DEFAULT_MAX_DEPTH}.`),
    scope: z
      .string()
      .optional()
      .describe("Directory to graph when no saved graph exists. Default: 'src'."),
    tsconfig: analyzeTsconfig,
  },
  async (args) =>
  {
    try
    {
      const graph = hasGraph(args.root)
        ? loadGraph(args.root)
        : await buildGraph({
            root: args.root,
            ...(args.scope === undefined ? {} : { scope: args.scope }),
            ...(args.tsconfig === undefined ? {} : { tsconfig: args.tsconfig }),
          })
      const result = computeBlastRadius(graph, args.target, args.direction, args.maxDepth)
      const upstream = bounded(result.upstream, MCP_LIST_CAPS.blastPaths)
      const downstream = bounded(result.downstream, MCP_LIST_CAPS.blastPaths)
      return jsonResult({
        ...result,
        upstream: upstream.items,
        downstream: downstream.items,
        totals: {
          upstream: upstream.total,
          downstream: downstream.total,
          omitted: upstream.omitted + downstream.omitted,
        },
        impactedCount: impactedFileCount(result),
        graphGeneratedAt: graph.generatedAt,
        ...(upstream.omitted || downstream.omitted
          ? {
              note: 'path lists are capped; use `cartographer blast-radius` or graph.json for full evidence',
            }
          : {}),
      })
    }
    catch (err)
    {
      return errorResult('blast_radius', err)
    }
  },
)

// --- annotate_files -------------------------------------------------------------

server.tool(
  'annotate_files',
  'Write one-line descriptions for files that have no header comment into the <root>/.cartographer.annotations.json sidecar, keyed by content hash so they go stale (& get flagged) when the file changes. Descriptions surface in the atlas, graph.json nodes[].description, & graph_repo output. A file-header comment always wins over an annotation, so prefer fixing headers in repos you control; use this for repos w/o a header convention. Find files needing work via graph_repo (describedFiles vs files) or `cartographer annotate <root>` (pending & stale lists). Rebuild the graph afterward to pick annotations up.',
  {
    root: z.string().describe('Absolute path to the repository root to annotate.'),
    annotations: z
      .record(z.string(), z.string())
      .describe(
        'Map of file path (relative to root, e.g. "src/auth/session.ts") -> one-line description (imperative, <=160 chars).',
      ),
  },
  async (args) =>
  {
    try
    {
      return jsonResult({ ...applyAnnotations(args.root, args.annotations) })
    }
    catch (err)
    {
      return errorResult('annotate_files', err)
    }
  },
)

// --- propose_patch --------------------------------------------------------------

const patchPathField = (what: string): z.ZodString =>
  z.string().describe(`${what}, relative to the repo root.`)

const patchOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('add_file'),
    path: patchPathField('File the proposal creates'),
    description: z.string().optional().describe('One-line purpose.'),
    exports: z
      .array(z.string())
      .optional()
      .describe('Exported symbol names the file would provide.'),
    note: z.string().optional().describe('Rationale shown beside the op.'),
  }),
  z.object({
    op: z.literal('remove_file'),
    path: patchPathField('File the proposal deletes'),
    note: z.string().optional(),
  }),
  z.object({
    op: z.literal('move_file'),
    from: patchPathField('Current path'),
    to: patchPathField('Proposed path'),
    note: z.string().optional(),
  }),
  z.object({
    op: z.literal('add_import'),
    from: patchPathField('Importing file'),
    to: patchPathField('Imported file'),
    symbols: z.array(z.string()).optional().describe('Imported symbol names.'),
    typeOnly: z.literal(true).optional().describe('Set when the import is compile-time only.'),
    note: z.string().optional(),
  }),
  z.object({
    op: z.literal('remove_import'),
    from: patchPathField('Importing file'),
    to: patchPathField('Imported file'),
    note: z.string().optional(),
  }),
])

server.tool(
  'propose_patch',
  `Propose a structural change plan (a graph patch) w/o touching any source: add/remove/move files & add/remove imports as a flat op list, applied in order (later ops may reference paths earlier ops created). Writes the proposal to <root>/.cartographer/patches/<id>.json for later review through the artifact, CLI, or MCP. Returns the patch id, a drift summary, per-op semantic issues (unknown paths, duplicate adds, ...), & structural validation against the current graph: cycles the plan would create (w/ an example path), block boundaries that go from zero imports to some, & files left orphaned. Evaluation is refused above ${MAX_PATCH_EVALUATION_NODES.toLocaleString('en-US')} nodes, ${MAX_PATCH_EVALUATION_EDGES.toLocaleString('en-US')} edges, or ${MAX_PATCH_EVALUATION_WORK.toLocaleString('en-US')} work units; a refusal writes no proposal. Requires a saved graph -> call graph_repo first. Use list_patches to enumerate existing proposals.`,
  {
    root: analyzeRoot,
    name: z.string().max(120).describe('Short display name for the proposal.'),
    description: z.string().optional().describe('Prose rationale for the plan as a whole.'),
    author: z.string().optional().describe("Free-form author tag, e.g. 'agent:claude'."),
    ops: z
      .array(patchOpSchema)
      .min(1)
      .max(MAX_PATCH_OPS)
      .describe('Ordered mutations; applied sequentially.'),
  },
  async (args) =>
  {
    try
    {
      if (!hasGraph(args.root))
      {
        return errorResult('propose_patch', new Error('no graph -> call graph_repo first'))
      }
      const base = loadGraph(args.root)
      const patch = parseGraphPatch({
        version: PATCH_SCHEMA_VERSION,
        meta: {
          name: args.name,
          ...(args.description ? { description: args.description } : {}),
          ...(args.author ? { author: args.author } : {}),
          createdAt: new Date().toISOString(),
          baseline: {
            generatedAt: base.generatedAt,
            ...(base.gitRef ? { gitRef: base.gitRef } : {}),
          },
        },
        ops: args.ops,
      })
      const evaluation = evaluatePatch(base, patch, patchNodeResolver(args.root))
      const saved = savePatch(args.root, patch)
      const staleness = proposalStaleness(patch.meta.baseline, base, workingTreeState(args.root))
      const issues = bounded(evaluation.applied.issues, MCP_LIST_CAPS.patchIssues)
      return jsonResult({
        patchId: saved.id,
        patchPath: saved.path,
        summary: formatDiffSummary(evaluation.diff),
        issues: issues.items,
        issueTotals: {
          total: issues.total,
          errors: evaluation.applied.issues.filter((issue) => issue.severity === 'error').length,
          omitted: issues.omitted,
        },
        validation: mcpPatchValidation(evaluation.validation),
        staleness,
        note: 'use get_patch to inspect the saved plan against the current graph',
      })
    }
    catch (err)
    {
      return errorResult('propose_patch', err)
    }
  },
)

// --- get_patch ------------------------------------------------------------------

server.tool(
  'get_patch',
  `Read one stored graph-patch proposal, returning up to the first 200 ordered ops (w/ exact total/omitted counts), per-op apply issues, & structural validation against the CURRENT graph (cycles created, boundaries going 0 -> N, orphans). The response includes patchPath for the complete local JSON artifact. Evaluation is refused above ${MAX_PATCH_EVALUATION_NODES.toLocaleString('en-US')} nodes, ${MAX_PATCH_EVALUATION_EDGES.toLocaleString('en-US')} edges, or ${MAX_PATCH_EVALUATION_WORK.toLocaleString('en-US')} work units; list_patches and the stored artifact remain available. Use after list_patches to review a human- or agent-authored plan, or to re-check one of your own proposals after the graph changed. Ops apply in order; an op flagged w/ an error issue was skipped.`,
  {
    root: analyzeRoot,
    id: z.string().describe('Patch id from list_patches or propose_patch.'),
  },
  async (args) =>
  {
    try
    {
      if (!hasGraph(args.root))
      {
        return errorResult('get_patch', new Error('no graph -> call graph_repo first'))
      }
      const patch = loadPatch(args.root, args.id)
      const base = loadGraph(args.root)
      const evaluation = evaluatePatch(base, patch, patchNodeResolver(args.root))
      const ops = bounded(patch.ops, MCP_LIST_CAPS.patchOps)
      const issues = bounded(evaluation.applied.issues, MCP_LIST_CAPS.patchIssues)
      const patchPath = patchArtifactPath(args.root, args.id)
      const staleness = proposalStaleness(patch.meta.baseline, base, workingTreeState(args.root))
      return jsonResult({
        id: args.id,
        patchPath,
        meta: patch.meta,
        summary: formatDiffSummary(evaluation.diff),
        ops: ops.items,
        opTotals: { total: ops.total, omitted: ops.omitted },
        issues: issues.items,
        issueTotals: {
          total: issues.total,
          errors: evaluation.applied.issues.filter((issue) => issue.severity === 'error').length,
          omitted: issues.omitted,
        },
        validation: mcpPatchValidation(evaluation.validation),
        staleness,
        graphGeneratedAt: base.generatedAt,
        ...(base.gitRef ? { graphGitRef: base.gitRef } : {}),
        ...(ops.omitted > 0
          ? {
              opsNote: `returned the first ${ops.items.length} ordered ops; read ${patchPath} for all ${ops.total}`,
            }
          : {}),
        ...(staleness.stale
          ? {
              note: `proposal staleness: ${staleness.reasons.join(', ')}; findings reflect the current graph`,
            }
          : {}),
      })
    }
    catch (err)
    {
      return errorResult('get_patch', err)
    }
  },
)

// --- list_patches ---------------------------------------------------------------

server.tool(
  'list_patches',
  'Page through stored graph-patch proposals under <root>/.cartographer/patches/ in deterministic createdAt-desc/id-asc order — id, name, author, baseline, shared staleness reasons & per-kind op counts (invalid files surface w/ their parse error). Every page has exact total/returned/omitted/remaining counts, patchesPath for the full local catalog, & an opaque nextCursor when more remain.',
  {
    root: analyzeRoot,
    limit: z
      .number()
      .int()
      .positive()
      .max(50)
      .optional()
      .describe('Entries per page. Default/max: 50.'),
    cursor: z.string().max(1024).optional().describe('Opaque nextCursor from the preceding page.'),
  },
  async (args) =>
  {
    try
    {
      const graph = hasGraph(args.root) ? loadGraph(args.root) : undefined
      const workingTree = graph ? workingTreeState(args.root, 0) : undefined
      const graphMetadata = graph
        ? (() =>
          {
            return {
              graphGeneratedAt: graph.generatedAt,
              ...(graph.gitRef ? { graphGitRef: graph.gitRef } : {}),
            }
          })()
        : {}
      const page = listPatchPage(args.root, args.limit ?? 50, args.cursor)
      return jsonResult({
        ...page,
        patches: graph
          ? page.patches.map((patch) => ({
              ...patch,
              staleness: proposalStaleness(patch.baseline, graph, workingTree),
            }))
          : page.patches,
        ...graphMetadata,
      })
    }
    catch (err)
    {
      return errorResult('list_patches', err)
    }
  },
)

// --- helpers ----------------------------------------------------------------

// MCP responses feed model context windows -> every evidence list is bounded
// w/ exact totals & omission counts; full data stays in graph.json (F25)
const MCP_LIST_CAPS = {
  blocks: 60,
  blockImports: 120,
  diffEntries: 200,
  apiChanges: 100,
  apiExportsPerFile: 50,
  apiConsumersPerExport: 25,
  blastPaths: 400,
  patchIssues: 100,
  patchFindings: 50,
  patchOps: 200,
} as const

function mcpPatchValidation(validation: PatchValidation): Record<string, unknown>
{
  const bounded = boundPatchValidation(validation, {
    cycles: MCP_LIST_CAPS.patchFindings,
    newBoundaries: MCP_LIST_CAPS.patchFindings,
    orphans: MCP_LIST_CAPS.patchFindings,
  })
  return {
    totals: bounded.totals,
    cycles: bounded.cycles.items,
    newBoundaries: bounded.newBoundaries.items,
    orphans: bounded.orphans.items,
  }
}

function summarize(graph: CartographerGraph): Record<string, unknown>
{
  const { fanIn, fanOut } = fileDegrees(graph.edges)
  const top = (map: Map<string, number>): Array<Record<string, unknown>> =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([file, count]) => ({ file, count }))

  let exportedSymbols = 0
  let describedFiles = 0
  // repo-wide marker totals across config, file-level & export-attached markers
  const markers = { todo: 0, warning: 0, question: 0, important: 0 }
  for (const marker of graph.markers ?? [])
  {
    markers[marker.kind] += 1
  }
  for (const node of graph.nodes)
  {
    exportedSymbols += node.exports?.length ?? 0
    if (node.description !== undefined)
    {
      describedFiles += 1
    }
    for (const marker of node.markers ?? [])
    {
      markers[marker.kind] += 1
    }
    for (const symbol of node.exports ?? [])
    {
      for (const marker of symbol.markers ?? [])
      {
        markers[marker.kind] += 1
      }
    }
  }

  // largest blocks & heaviest cross-block edges first; exact totals retained
  const blocks = bounded(
    [...graphGroups(graph)].sort((a, b) => b.fileCount - a.fileCount || a.id.localeCompare(b.id)),
    MCP_LIST_CAPS.blocks,
  )
  const blockImports = bounded(aggregateGroupEdges(graph), MCP_LIST_CAPS.blockImports)
  return {
    repoRoot: graph.repoRoot,
    scope: graph.scope,
    gitRef: graph.gitRef,
    files: graph.nodes.length,
    imports: graph.edges.length,
    exportedSymbols,
    describedFiles,
    markers,
    metrics: graph.metrics,
    blocks: blocks.items,
    blockImports: blockImports.items,
    blockTotals: {
      blocks: blocks.total,
      omittedBlocks: blocks.omitted,
      blockImports: blockImports.total,
      omittedBlockImports: blockImports.omitted,
    },
    topFanIn: top(fanIn),
    topFanOut: top(fanOut),
    ...(blocks.omitted || blockImports.omitted
      ? { note: 'lists are capped; full evidence lives in graph.json' }
      : {}),
  }
}

// bounded diff payload sharing the HTTP diff's exact-totals discipline
function boundedDiff(diff: GraphDiff): Record<string, unknown>
{
  const addedNodes = bounded(diff.addedNodes, MCP_LIST_CAPS.diffEntries)
  const removedNodes = bounded(diff.removedNodes, MCP_LIST_CAPS.diffEntries)
  const addedEdges = bounded(diff.addedEdges, MCP_LIST_CAPS.diffEntries)
  const removedEdges = bounded(diff.removedEdges, MCP_LIST_CAPS.diffEntries)
  const movedNodes = bounded(diff.movedNodes, MCP_LIST_CAPS.diffEntries)
  const moveFlows = bounded(diff.moveFlows, MCP_LIST_CAPS.diffEntries)
  const newViolations = bounded(diff.newViolations, MCP_LIST_CAPS.diffEntries)
  const resolvedViolations = bounded(diff.resolvedViolations, MCP_LIST_CAPS.diffEntries)
  const apiChanges = boundApiChanges(diff.apiChanges, {
    files: MCP_LIST_CAPS.apiChanges,
    exportsPerFile: MCP_LIST_CAPS.apiExportsPerFile,
    consumersPerExport: MCP_LIST_CAPS.apiConsumersPerExport,
  })
  const omitted =
    addedNodes.omitted +
    removedNodes.omitted +
    addedEdges.omitted +
    removedEdges.omitted +
    movedNodes.omitted +
    moveFlows.omitted +
    newViolations.omitted +
    resolvedViolations.omitted +
    apiChanges.omitted.total
  return {
    baseGeneratedAt: diff.baseGeneratedAt,
    headGeneratedAt: diff.headGeneratedAt,
    ...(diff.baseGitRef ? { baseGitRef: diff.baseGitRef } : {}),
    ...(diff.headGitRef ? { headGitRef: diff.headGitRef } : {}),
    changed: diff.changed,
    addedNodes: addedNodes.items,
    removedNodes: removedNodes.items,
    addedEdges: addedEdges.items,
    removedEdges: removedEdges.items,
    movedNodes: movedNodes.items,
    moveFlows: moveFlows.items,
    movedEdges: diff.movedEdges,
    newViolations: newViolations.items,
    resolvedViolations: resolvedViolations.items,
    apiChanges: projectBoundedApiChanges(apiChanges),
    totals: {
      addedNodes: addedNodes.total,
      removedNodes: removedNodes.total,
      addedEdges: addedEdges.total,
      removedEdges: removedEdges.total,
      movedNodes: movedNodes.total,
      moveFlows: moveFlows.total,
      newViolations: newViolations.total,
      resolvedViolations: resolvedViolations.total,
      apiChanges: apiChanges.totals.files,
      apiExports: apiChanges.totals.exports,
      apiConsumers: apiChanges.totals.consumers,
      omitted,
    },
    ...(omitted > 0
      ? {
          note: 'diff lists are capped; rerun `cartographer diff` for full output',
        }
      : {}),
  }
}

function jsonResult(payload: Record<string, unknown>): {
  content: Array<{ type: 'text'; text: string }>
}
{
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  }
}

function errorResult(
  tool: string,
  err: unknown,
): {
  isError: true
  content: Array<{ type: 'text'; text: string }>
}
{
  const message = err instanceof Error ? err.message : String(err)
  return {
    isError: true,
    content: [{ type: 'text', text: `${tool} failed: ${message}` }],
  }
}

export { server as mcpServer }
