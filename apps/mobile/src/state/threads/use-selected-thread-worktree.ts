// apps/mobile/src/state/threads/use-selected-thread-worktree.ts
// manage selected thread worktree through a React hook

import { resolveThreadChangeRoot } from '@t3tools/shared/threadChangeRoot'
import { useMemo } from 'react'

import { useSelectedThreadDetail } from './use-thread-detail'
import { useThreadSelection } from './use-thread-selection'
import { useEnvironmentQuery } from '../query'
import { vcsEnvironment } from '../vcs'
import { resolvePreferredThreadWorktreePath } from '../../features/terminal/terminalLaunchContext'
import { resolveCurrentRunWorktreePath } from './run-worktree'

export function useSelectedThreadWorktree()
{
  const { selectedThread, selectedThreadProject } = useThreadSelection()
  const selectedThreadDetail = useSelectedThreadDetail()

  const selectedThreadWorktreePath = useMemo(
    () =>
      resolvePreferredThreadWorktreePath({
        threadShellWorktreePath: selectedThread?.worktreePath ?? null,
        threadDetailWorktreePath: selectedThreadDetail?.worktreePath ?? null,
      }),
    [selectedThread?.worktreePath, selectedThreadDetail?.worktreePath],
  )

  const adoptedRunWorktreePath = resolveCurrentRunWorktreePath({
    shellExecution: selectedThread?.orchestrateRunExecution,
    detailExecution: selectedThreadDetail?.orchestrateRunExecution,
    shellLegacyPath: selectedThread?.orchestrateRunWorktreePath,
    detailLegacyPath: selectedThreadDetail?.orchestrateRunWorktreePath,
  })

  // the adopted run worktree can be pruned while the thread sits idle, and the
  // server only releases the recorded path on that thread's next turn. the probe
  // is pinned to the adopted path rather than to selectedThreadCwd below, whose
  // value moves with the resolver and would flap between the two candidates
  // forever. this is the one place mobile reads the run root, so every sheet,
  // the files inspector and the git actions inherit the fallback from here
  const adoptedRunWorktreeStatus = useEnvironmentQuery(
    selectedThread === null || adoptedRunWorktreePath === null
      ? null
      : vcsEnvironment.status({
          environmentId: selectedThread.environmentId,
          input: { cwd: adoptedRunWorktreePath },
        }),
  )

  return {
    // selectedThreadWorktreePath stays the terminal's launch target: that answers
    // "where does the agent run", which is a different question. selectedThreadCwd
    // answers "where do this thread's changes live", so it follows the run's
    // integration worktree first. every mobile git sheet reads this one value, so
    // without the run root they all report a clean tree while the run's commits
    // sit in another worktree
    selectedThreadWorktreePath,
    // a pruned run worktree answers "not a git repository" rather than failing, so
    // trusting it would leave every sheet reporting no repository and the files
    // inspector rooted at a directory that no longer exists
    selectedThreadCwd: resolveThreadChangeRoot({
      orchestrateRunWorktreePath: adoptedRunWorktreePath,
      worktreePath: selectedThreadWorktreePath,
      workspaceRoot: selectedThreadProject?.workspaceRoot ?? null,
      orchestrateRunWorktreeIsNotRepository: adoptedRunWorktreeStatus.data?.isRepo === false,
    }),
  }
}
