// apps/mobile/src/features/threads/new-task/newTaskFlowHelpers.ts
// pure helpers for new-task flow workspace labels

import type { EnvironmentProject } from '@t3tools/client-runtime/state/shell'
import type { VcsRef } from '@t3tools/contracts'

export type WorkspaceMode = 'local' | 'worktree'

export const EMPTY_BRANCH_REFS: ReadonlyArray<VcsRef> = []

export function pendingTaskDraftKey(messageId: string): string
{
  return `pending-task:${messageId}`
}

export function normalizeSelectedWorktreePath(
  project: EnvironmentProject,
  branch: VcsRef,
): string | null
{
  if (!branch.worktreePath)
  {
    return null
  }

  return branch.worktreePath === project.workspaceRoot ? null : branch.worktreePath
}

export function branchBadgeLabel(input: {
  readonly branch: VcsRef
  readonly project: EnvironmentProject | null
}): string | null
{
  if (input.branch.current)
  {
    return 'current'
  }
  if (input.branch.worktreePath && input.branch.worktreePath !== input.project?.workspaceRoot)
  {
    return 'worktree'
  }
  if (input.branch.isDefault)
  {
    return 'default'
  }
  if (input.branch.isRemote)
  {
    return 'remote'
  }
  return null
}
