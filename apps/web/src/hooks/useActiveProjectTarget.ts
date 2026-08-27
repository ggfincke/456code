// apps/web/src/hooks/useActiveProjectTarget.ts
// resolve the active task workspace for project search and file navigation

import { scopeProjectRef, scopeThreadRef } from '@t3tools/client-runtime/environment'
import type { EnvironmentId, ScopedThreadRef } from '@t3tools/contracts'

import { useProject } from '../state/entities'
import { useHandleNewThread } from './useHandleNewThread'

export interface ActiveProjectTarget
{
  readonly environmentId: EnvironmentId
  readonly cwd: string
  readonly projectName: string
  readonly threadRef: ScopedThreadRef
}

export function useActiveProjectTarget(): ActiveProjectTarget | null
{
  const { activeDraftThread, activeThread } = useHandleNewThread()
  const thread = activeThread ?? activeDraftThread
  const threadId = activeThread?.id ?? activeDraftThread?.threadId
  const project = useProject(
    thread ? scopeProjectRef(thread.environmentId, thread.projectId) : null,
  )
  // worktree ownership follows the active task, including pre-thread drafts
  const cwd = thread?.worktreePath ?? project?.workspaceRoot
  if (!thread || !threadId || !project || !cwd) return null
  return {
    environmentId: project.environmentId,
    cwd,
    projectName: project.title,
    threadRef: scopeThreadRef(thread.environmentId, threadId),
  }
}
