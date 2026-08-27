// tests/apps/web/hooks/useActiveProjectTarget.test.ts
// protect worktree-first search targeting for server tasks and drafts

import { EnvironmentId, ProjectId, ThreadId } from '@t3tools/contracts'
import { expect, it, vi } from 'vite-plus/test'

const mocks = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
  project: {} as Record<string, unknown>,
}))
vi.mock('../../../../apps/web/src/hooks/useHandleNewThread', () => ({
  useHandleNewThread: () => mocks.current,
}))
vi.mock('../../../../apps/web/src/state/entities', () => ({
  useProject: () => mocks.project,
}))

import { useActiveProjectTarget } from '../../../../apps/web/src/hooks/useActiveProjectTarget'

it('uses the active task or draft worktree and only falls back to the project root', () =>
{
  const environmentId = EnvironmentId.make('remote')
  const projectId = ProjectId.make('project')
  const threadId = ThreadId.make('thread')
  mocks.project = { environmentId, id: projectId, workspaceRoot: '/repo', title: 'Repo' }
  mocks.current = {
    activeThread: { environmentId, projectId, id: threadId, worktreePath: '/repo-worker' },
    activeDraftThread: null,
  }
  expect(useActiveProjectTarget()).toMatchObject({
    cwd: '/repo-worker',
    environmentId,
    threadRef: { environmentId, threadId },
  })
  mocks.current = {
    activeThread: null,
    activeDraftThread: { environmentId, projectId, threadId, worktreePath: '/draft-worker' },
  }
  expect(useActiveProjectTarget()?.cwd).toBe('/draft-worker')
  mocks.current = {
    activeThread: { environmentId, projectId, id: threadId, worktreePath: null },
    activeDraftThread: null,
  }
  expect(useActiveProjectTarget()?.cwd).toBe('/repo')
  mocks.current = { activeThread: null, activeDraftThread: null }
  expect(useActiveProjectTarget()).toBeNull()
})
