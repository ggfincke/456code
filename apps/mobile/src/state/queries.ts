// apps/mobile/src/state/queries.ts
// manage thread detail view state

import type { EnvironmentId } from '@t3tools/contracts'
import { useMemo } from 'react'

import { orchestrationEnvironment } from './orchestration'
import { useEnvironmentQuery } from './query'
import { vcsEnvironment } from './vcs'
import { buildCheckpointDiffTargets, type CheckpointDiffTarget } from './queryTargets'

const VCS_REF_LIST_LIMIT = 100

export function useBranches(input: {
  readonly environmentId: EnvironmentId | null
  readonly cwd: string | null
  readonly query?: string | null
})
{
  const query = input.query?.trim() ?? ''
  return useEnvironmentQuery(
    input.environmentId !== null && input.cwd !== null
      ? vcsEnvironment.listRefs({
          environmentId: input.environmentId,
          input: {
            cwd: input.cwd,
            ...(query.length > 0 ? { query } : {}),
            limit: VCS_REF_LIST_LIMIT,
          },
        })
      : null,
  )
}

export function useCheckpointDiff(target: CheckpointDiffTarget)
{
  const targets = useMemo(
    () => buildCheckpointDiffTargets(target),
    [
      target.environmentId,
      target.fromTurnCount,
      target.ignoreWhitespace,
      target.threadId,
      target.toTurnCount,
    ],
  )
  const fullThread = useEnvironmentQuery(
    targets.fullThread === null
      ? null
      : orchestrationEnvironment.fullThreadDiff(targets.fullThread),
  )
  const turn = useEnvironmentQuery(
    targets.turn === null ? null : orchestrationEnvironment.turnDiff(targets.turn),
  )
  return targets.fullThread === null ? turn : fullThread
}
