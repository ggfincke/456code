// packages/cartographer-core/src/store/proposalStaleness.ts
// canonical proposal-baseline verdict shared by every backend surface

import type {
  ProposalBaselineMeta,
  ProposalStalenessMeta,
  ProposalStalenessReason,
  WorkingTreeMeta,
} from '../contracts/atlasContract.js'

interface ProposalGraphMeta
{
  generatedAt: string
  gitRef?: string
}

// git abbreviations may have different configured lengths
export function gitRefsMatch(left: string, right: string): boolean
{
  const normalizedLeft = left.toLowerCase()
  const normalizedRight = right.toLowerCase()
  return normalizedLeft.startsWith(normalizedRight) || normalizedRight.startsWith(normalizedLeft)
}

function refsDisagree(refs: readonly string[]): boolean
{
  return refs.some((left, index) =>
    refs.slice(index + 1).some((right) => !gitRefsMatch(left, right)),
  )
}

export function proposalStaleness(
  baseline: ProposalBaselineMeta | undefined,
  graph: ProposalGraphMeta,
  workingTree?: WorkingTreeMeta,
): ProposalStalenessMeta
{
  const reasons: ProposalStalenessReason[] = []
  if (baseline?.generatedAt !== undefined && baseline.generatedAt !== graph.generatedAt)
  {
    reasons.push('generation-mismatch')
  }
  const refs = [baseline?.gitRef, graph.gitRef, workingTree?.gitRef].filter(
    (ref): ref is string => ref !== undefined,
  )
  if (refsDisagree(refs))
  {
    reasons.push('ref-mismatch')
  }
  if (workingTree?.dirty === true)
  {
    reasons.push('dirty-tree')
  }
  return {
    stale: reasons.length > 0,
    reasons,
    ...(baseline ? { baseline: { ...baseline } } : {}),
    graph: {
      generatedAt: graph.generatedAt,
      ...(graph.gitRef ? { gitRef: graph.gitRef } : {}),
    },
    ...(workingTree ? { workingTree: { ...workingTree } } : {}),
  }
}
