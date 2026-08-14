// apps/web/src/components/diffs/runDiffQueryPolicy.ts
// selects exact or legacy run diff transport without discarding retained execution identity

export type RunDiffQueryKind = 'exact' | 'legacy' | null

export function resolveRunDiffQueryKind(input: {
  readonly isRunScope: boolean
  readonly usesExactRunExecution: boolean
  readonly hasActiveThread: boolean
  readonly hasActiveThreadId: boolean
  readonly hasActiveRunExecution: boolean
  readonly isCurrentPathGitRepository: boolean
}): RunDiffQueryKind
{
  if (!input.isRunScope || !input.hasActiveThread)
  {
    return null
  }
  if (input.usesExactRunExecution)
  {
    return input.hasActiveRunExecution ? 'exact' : null
  }
  return input.hasActiveThreadId && input.isCurrentPathGitRepository ? 'legacy' : null
}
