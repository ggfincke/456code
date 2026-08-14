// apps/mobile/src/state/threads/run-worktree.ts
// resolves the current authoritative run root with bounded legacy fallback

import type { OrchestrateRunExecution } from '@t3tools/contracts'

export function resolveCurrentRunWorktreePath(input: {
  readonly shellExecution: OrchestrateRunExecution | null | undefined
  readonly detailExecution: OrchestrateRunExecution | null | undefined
  readonly shellLegacyPath: string | null | undefined
  readonly detailLegacyPath: string | null | undefined
}): string | null
{
  if (input.shellExecution !== undefined)
  {
    if (input.shellExecution !== null)
    {
      return input.shellExecution.availability === 'available'
        ? input.shellExecution.integrationRoot
        : null
    }
    return input.shellLegacyPath ?? null
  }
  if (input.detailExecution != null)
  {
    return input.detailExecution.availability === 'available'
      ? input.detailExecution.integrationRoot
      : null
  }
  return input.shellLegacyPath ?? input.detailLegacyPath ?? null
}
