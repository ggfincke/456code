// packages/cartographer-core/scripts/patchPerformanceAcceptance.mjs
// guards evaluator correctness and throughput on a deterministic hard dag

import * as NodePerfHooks from 'node:perf_hooks'
import {
  MAX_PATCH_EVALUATION_EDGES,
  MAX_PATCH_EVALUATION_NODES,
  evaluatePatch,
} from '../dist/analyze/patchEvaluation.js'
import { PATCH_SCHEMA_VERSION } from '../dist/analyze/patch.js'
import { GRAPH_SCHEMA_VERSION } from '../dist/contracts/types.js'

const sourceCount = 2_000
const coreCount = 48_000
const warmupRuns = 1
const measuredRuns = 5
const medianLimitMs = 500
const maxLimitMs = 1_000

const sourceIds = Array.from(
  { length: sourceCount },
  (_, index) => `src/source/s${String(index).padStart(4, '0')}.ts`,
)
const coreIds = Array.from(
  { length: coreCount },
  (_, index) => `src/core/c${String(index).padStart(5, '0')}.ts`,
)
const nodes = [...sourceIds, ...coreIds].map((id) => ({
  id,
  kind: 'file',
  label: id.slice(id.lastIndexOf('/') + 1),
  group: 'src',
}))
const edges = Array.from({ length: coreCount - 1 }, (_, index) => ({
  id: `e${index}`,
  from: coreIds[index],
  to: coreIds[index + 1],
  kind: 'imports',
}))
const patch = {
  version: PATCH_SCHEMA_VERSION,
  meta: {
    name: '50k/2k evaluator acceptance',
    createdAt: '2026-01-02T00:00:00.000Z',
  },
  ops: sourceIds.map((from) => ({
    op: 'add_import',
    from,
    to: coreIds[0],
  })),
}
const graph = {
  version: GRAPH_SCHEMA_VERSION,
  repoRoot: '/patch-performance-acceptance',
  mode: 'imports',
  generatedAt: '2026-01-01T00:00:00.000Z',
  scope: 'src',
  nodes,
  edges,
  metrics: {
    cycles: 0,
    orphans: sourceCount,
    maxFanIn: 1,
    maxFanOut: 1,
  },
}

if (nodes.length !== MAX_PATCH_EVALUATION_NODES)
{
  throw new Error(`fixture has ${nodes.length} nodes`)
}
if (edges.length + patch.ops.length > MAX_PATCH_EVALUATION_EDGES)
{
  throw new Error('fixture exceeds the evaluator edge ceiling')
}

function runEvaluation()
{
  const started = NodePerfHooks.performance.now()
  const evaluation = evaluatePatch(graph, patch, () => ({ group: 'src' }))
  const elapsed = NodePerfHooks.performance.now() - started
  if (
    evaluation.applied.issues.length !== 0 ||
    evaluation.diff.addedEdges.length !== sourceCount ||
    evaluation.head.nodes.length !== nodes.length ||
    evaluation.head.edges.length !== edges.length + sourceCount ||
    evaluation.validation.totals.cycles !== 0 ||
    evaluation.validation.totals.newBoundaries !== 0 ||
    evaluation.validation.totals.orphans !== 0
  )
  {
    throw new Error(
      `fixture semantics changed: ${JSON.stringify({
        issues: evaluation.applied.issues.length,
        addedEdges: evaluation.diff.addedEdges.length,
        headNodes: evaluation.head.nodes.length,
        headEdges: evaluation.head.edges.length,
        validation: evaluation.validation.totals,
      })}`,
    )
  }
  return elapsed
}

for (let run = 0; run < warmupRuns; run += 1)
{
  runEvaluation()
}

const samples = Array.from({ length: measuredRuns }, () => runEvaluation())
const ordered = [...samples].sort((a, b) => a - b)
const median = ordered[Math.floor(ordered.length / 2)]
const maximum = Math.max(...samples)
const summary = {
  fixture: {
    nodes: nodes.length,
    baseEdges: edges.length,
    operations: patch.ops.length,
  },
  warmupRuns,
  samplesMs: samples.map((sample) => Number(sample.toFixed(2))),
  medianMs: Number(median.toFixed(2)),
  maxMs: Number(maximum.toFixed(2)),
  limitsMs: { median: medianLimitMs, max: maxLimitMs },
}

if (median > medianLimitMs || maximum > maxLimitMs)
{
  throw new Error(
    `patch evaluator exceeded its budget: median ${median.toFixed(2)} ms, ` +
      `max ${maximum.toFixed(2)} ms`,
  )
}

console.log(JSON.stringify(summary))
