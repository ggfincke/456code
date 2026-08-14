// packages/cartographer-core/src/analyze/patchEvaluation.ts
// canonical patch application, synthetic head, diff & validation evaluation

import type { CartographerGraph } from '../contracts/types.js'
import {
  applyPatch,
  patchHeadGraph,
  patchToDiff,
  validatePatchStructure,
  type GraphPatch,
  type PatchApplyResult,
  type PatchNodeResolver,
  type PatchValidation,
} from './patch.js'
import type { GraphDiff } from './diff.js'

export const MAX_PATCH_EVALUATION_NODES = 50_000
export const MAX_PATCH_EVALUATION_EDGES = 100_000
export const MAX_PATCH_EVALUATION_WORK = 3_000_000

export type PatchEvaluationLimitKind = 'nodes' | 'edges' | 'work'

export class PatchEvaluationLimitError extends Error
{
  readonly code = 'PATCH_EVALUATION_LIMIT'
  readonly kind: PatchEvaluationLimitKind
  readonly actual: number
  readonly limit: number
  readonly scope: 'base' | 'head' | 'evaluation'

  constructor(
    kind: PatchEvaluationLimitKind,
    actual: number,
    limit: number,
    scope: 'base' | 'head' | 'evaluation',
  )
  {
    const subject = kind === 'work' ? 'work units' : kind
    super(
      `patch evaluation refused: ${scope} has ${actual.toLocaleString('en-US')} ${subject}; ` +
        `maximum is ${limit.toLocaleString('en-US')}`,
    )
    this.kind = kind
    this.actual = actual
    this.limit = limit
    this.scope = scope
  }
}

class PatchEvaluationBudget
{
  used = 0

  consume(amount: number): void
  {
    this.used += amount
    if (this.used > MAX_PATCH_EVALUATION_WORK)
    {
      throw new PatchEvaluationLimitError(
        'work',
        this.used,
        MAX_PATCH_EVALUATION_WORK,
        'evaluation',
      )
    }
  }
}

function assertGraphSize(
  scope: 'base' | 'head',
  graph: Pick<CartographerGraph, 'nodes' | 'edges'>,
): void
{
  if (graph.nodes.length > MAX_PATCH_EVALUATION_NODES)
  {
    throw new PatchEvaluationLimitError(
      'nodes',
      graph.nodes.length,
      MAX_PATCH_EVALUATION_NODES,
      scope,
    )
  }
  if (graph.edges.length > MAX_PATCH_EVALUATION_EDGES)
  {
    throw new PatchEvaluationLimitError(
      'edges',
      graph.edges.length,
      MAX_PATCH_EVALUATION_EDGES,
      scope,
    )
  }
}

export interface PatchEvaluation
{
  applied: PatchApplyResult
  head: CartographerGraph
  diff: GraphDiff
  validation: PatchValidation
}

export function evaluatePatch(
  base: CartographerGraph,
  patch: GraphPatch,
  resolver: PatchNodeResolver,
): PatchEvaluation
{
  assertGraphSize('base', base)
  const budget = new PatchEvaluationBudget()
  budget.consume(base.nodes.length + base.edges.length + patch.ops.length)
  const applied = applyPatch(base, patch, resolver, {
    consumeWork: (amount) => budget.consume(amount),
  })
  const head = patchHeadGraph(base, patch, applied)
  assertGraphSize('head', head)
  budget.consume(head.nodes.length + head.edges.length)
  return {
    applied,
    head,
    diff: patchToDiff(base, applied, head),
    validation: validatePatchStructure(base, head, applied.originByPath),
  }
}
