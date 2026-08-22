// apps/web/src/components/architecture/architectureImpactSelection.ts
// fences Impact Diff responses to the exact plan or comparison requested by a client surface

import type {
  ArchitectureComparisonSelector,
  ArchitectureImpactProjectionResult,
  ArchitecturePlannedImpactPlanIdentity,
  ProjectId,
  ThreadId,
} from '@t3tools/contracts'

function planIdentityMatches(
  left: ArchitecturePlannedImpactPlanIdentity,
  right: ArchitecturePlannedImpactPlanIdentity,
): boolean
{
  if (left._tag !== right._tag) return false
  if (left._tag === 'plan')
  {
    return right._tag === 'plan' && left.planId === right.planId
  }
  return (
    right._tag === 'orchestrate' && left.runId === right.runId && left.revision === right.revision
  )
}

function comparisonMatches(
  left: ArchitectureComparisonSelector,
  right: ArchitectureComparisonSelector,
): boolean
{
  if (left.kind !== right.kind) return false
  return left.kind === 'proposal-generation'
    ? right.kind === 'proposal-generation' && left.generationId === right.generationId
    : right.kind === 'diff-analysis' && left.diffAnalysisId === right.diffAnalysisId
}

interface ExactImpactExpectation
{
  readonly threadId: ThreadId
  readonly projectId?: ProjectId | null | undefined
}

export function selectExactPlanImpactProjection(
  result: ArchitectureImpactProjectionResult | null,
  expected: ExactImpactExpectation & {
    readonly plan: ArchitecturePlannedImpactPlanIdentity
  },
): ArchitectureImpactProjectionResult | null
{
  const target = result?.descriptor.target
  return result !== null &&
    result.descriptor.threadId === expected.threadId &&
    (expected.projectId == null || result.descriptor.projectId === expected.projectId) &&
    target?.kind === 'plan' &&
    planIdentityMatches(target.plan, expected.plan)
    ? result
    : null
}

export function selectExactComparisonImpactProjection(
  result: ArchitectureImpactProjectionResult | null,
  expected: ExactImpactExpectation & {
    readonly comparison: ArchitectureComparisonSelector
  },
): ArchitectureImpactProjectionResult | null
{
  const target = result?.descriptor.target
  return result !== null &&
    result.descriptor.threadId === expected.threadId &&
    (expected.projectId == null || result.descriptor.projectId === expected.projectId) &&
    target?.kind === 'comparison' &&
    comparisonMatches(target.comparison, expected.comparison)
    ? result
    : null
}
