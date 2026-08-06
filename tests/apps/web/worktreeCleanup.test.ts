// tests/apps/web/worktreeCleanup.test.ts
// verifies worktree cleanup state transitions

import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from '@t3tools/contracts'
import { describe, expect, it } from 'vite-plus/test'

import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type Thread,
} from '../../../apps/web/src/types'
import {
  formatWorktreePathForDisplay,
  getOrphanedWorktreePathForThread,
} from '../../../apps/web/src/worktreeCleanup'

const localEnvironmentId = EnvironmentId.make('environment-local')

function makeThread(overrides: Partial<Thread> = {}): Thread
{
  return {
    id: ThreadId.make('thread-1'),
    environmentId: localEnvironmentId,
    projectId: ProjectId.make('project-1'),
    title: 'Thread',
    modelSelection: {
      instanceId: ProviderInstanceId.make('codex'),
      model: 'gpt-5.3-codex',
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    checkpoints: [],
    activities: [],
    proposedPlans: [],
    orchestratePlans: [],
    createdAt: '2026-02-13T00:00:00.000Z',
    updatedAt: '2026-02-13T00:00:00.000Z',
    archivedAt: null,
    origin: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    latestTurn: null,
    providerSwitch: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  }
}

describe('getOrphanedWorktreePathForThread', () =>
{
  it('returns null when the target thread does not exist', () =>
  {
    const result = getOrphanedWorktreePathForThread([], ThreadId.make('missing-thread'))
    expect(result).toBeNull()
  })

  it('returns null when the target thread has no worktree', () =>
  {
    const threads = [makeThread()]
    const result = getOrphanedWorktreePathForThread(threads, ThreadId.make('thread-1'))
    expect(result).toBeNull()
  })

  it('returns the path when no other thread links to that worktree', () =>
  {
    const threads = [makeThread({ worktreePath: '/tmp/repo/worktrees/feature-a' })]
    const result = getOrphanedWorktreePathForThread(threads, ThreadId.make('thread-1'))
    expect(result).toBe('/tmp/repo/worktrees/feature-a')
  })

  it('returns null when another thread links to the same worktree', () =>
  {
    const threads = [
      makeThread({
        id: ThreadId.make('thread-1'),
        worktreePath: '/tmp/repo/worktrees/feature-a',
      }),
      makeThread({
        id: ThreadId.make('thread-2'),
        worktreePath: '/tmp/repo/worktrees/feature-a',
      }),
    ]
    const result = getOrphanedWorktreePathForThread(threads, ThreadId.make('thread-1'))
    expect(result).toBeNull()
  })

  it('ignores threads linked to different worktrees', () =>
  {
    const threads = [
      makeThread({
        id: ThreadId.make('thread-1'),
        worktreePath: '/tmp/repo/worktrees/feature-a',
      }),
      makeThread({
        id: ThreadId.make('thread-2'),
        worktreePath: '/tmp/repo/worktrees/feature-b',
      }),
    ]
    const result = getOrphanedWorktreePathForThread(threads, ThreadId.make('thread-1'))
    expect(result).toBe('/tmp/repo/worktrees/feature-a')
  })
})

describe('formatWorktreePathForDisplay', () =>
{
  it.each([
    {
      label: 'unix-like paths',
      path: '/Users/julius/.456code/worktrees/t3code-mvp/t3code-4e609bb8',
      expected: 't3code-4e609bb8',
    },
    {
      label: 'windows separators',
      path: 'C:\\Users\\julius\\.456code\\worktrees\\t3code-mvp\\t3code-4e609bb8',
      expected: 't3code-4e609bb8',
    },
  ])('shows only the last path segment for $label', ({ path, expected }) =>
  {
    expect(formatWorktreePathForDisplay(path)).toBe(expected)
  })
})
