// apps/web/src/components/diffs/runDiffAnalysisPolicy.ts
// resolves the repository anchor for run architecture analysis

export function resolveRunDiffAnalysisCwd(input: {
  readonly usesExactRunExecution: boolean
  readonly executionRepositoryRoot: string | null | undefined
  readonly activeCwd: string | null
}): string | null
{
  return input.usesExactRunExecution ? (input.executionRepositoryRoot ?? null) : input.activeCwd
}
