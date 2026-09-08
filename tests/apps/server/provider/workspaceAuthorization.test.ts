// tests/apps/server/provider/workspaceAuthorization.test.ts
// verify exact provider workspace catalog authorization

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationShellSnapshot,
} from '@t3tools/contracts'
import { describe, expect, it } from 'vite-plus/test'

import { resolveAuthorizedProviderWorkspaceCwd } from '../../../../apps/server/src/provider/workspaceAuthorization.ts'

const shell = {
  projects: [
    {
      id: ProjectId.make('project-1'),
      title: 'Project',
      workspaceRoot: '/Users/test/Project',
      defaultModelSelection: null,
      scripts: [],
      createdAt: '2026-09-08T00:00:00.000Z',
      updatedAt: '2026-09-08T00:00:00.000Z',
    },
  ],
  threads: [
    {
      id: ThreadId.make('thread-1'),
      projectId: ProjectId.make('project-1'),
      title: 'Task',
      modelSelection: {
        instanceId: ProviderInstanceId.make('codex'),
        model: 'gpt-5',
      },
      runtimeMode: 'approval-required',
      interactionMode: 'default',
      branch: null,
      worktreePath: '/Users/test/Project Worktree',
      orchestrateRunWorktreePath: '/Users/test/Active Run Worktree',
      latestTurn: null,
      providerSwitch: null,
      createdAt: '2026-09-08T00:00:00.000Z',
      updatedAt: '2026-09-08T00:00:00.000Z',
      archivedAt: null,
      origin: null,
      settledOverride: null,
      settledAt: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
      session: null,
    },
  ],
} satisfies Pick<OrchestrationShellSnapshot, 'projects' | 'threads'>

const normalizePath = (value: string) =>
{
  const parts: string[] = []
  for (const part of value.split('/'))
  {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

describe('provider workspace authorization', () =>
{
  it('accepts only normalized exact project or worktree roots with read scope', () =>
  {
    expect(
      resolveAuthorizedProviderWorkspaceCwd({
        cwd: '/Users/test/Project/.',
        scopes: [AuthOrchestrationReadScope],
        shell,
        normalizePath,
      }),
    ).toBe('/Users/test/Project')
    expect(
      resolveAuthorizedProviderWorkspaceCwd({
        cwd: '/Users/test/Project Worktree',
        scopes: [AuthOrchestrationReadScope],
        shell,
        normalizePath,
      }),
    ).toBe('/Users/test/Project Worktree')
    expect(
      resolveAuthorizedProviderWorkspaceCwd({
        cwd: '/Users/test/Active Run Worktree',
        scopes: [AuthOrchestrationReadScope],
        shell,
        normalizePath,
      }),
    ).toBe('/Users/test/Active Run Worktree')
  })

  it('rejects descendants, POSIX case changes, and sessions without read scope', () =>
  {
    expect(
      resolveAuthorizedProviderWorkspaceCwd({
        cwd: '/Users/test/Project/packages/app',
        scopes: [AuthOrchestrationReadScope],
        shell,
        normalizePath,
      }),
    ).toBeNull()
    expect(
      resolveAuthorizedProviderWorkspaceCwd({
        cwd: '/Users/test/project',
        scopes: [AuthOrchestrationReadScope],
        shell,
        normalizePath,
      }),
    ).toBeNull()
    expect(
      resolveAuthorizedProviderWorkspaceCwd({
        cwd: '/Users/test/Project',
        scopes: [AuthOrchestrationOperateScope],
        shell,
        normalizePath,
      }),
    ).toBeNull()
  })
})
