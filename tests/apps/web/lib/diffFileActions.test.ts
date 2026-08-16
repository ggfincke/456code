// tests/apps/web/lib/diffFileActions.test.ts
// verify open diff file primary action behavior

import { scopeThreadRef } from '@t3tools/client-runtime/environment'
import { EnvironmentId, ThreadId } from '@t3tools/contracts'
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import {
  openDiffFilePrimaryAction,
  resolveDiffPathForWorkspace,
} from '../../../../apps/web/src/lib/diffFileActions'
import {
  selectThreadRightPanelState,
  useRightPanelStore,
} from '../../../../apps/web/src/rightPanelStore'

const THREAD_REF = scopeThreadRef(
  EnvironmentId.make('environment-local'),
  ThreadId.make('thread-1'),
)

describe('openDiffFilePrimaryAction', () =>
{
  beforeEach(() =>
  {
    useRightPanelStore.setState({ byThreadKey: {} })
  })

  it('opens diff files in the thread file viewer', () =>
  {
    const openInEditor = vi.fn()

    openDiffFilePrimaryAction({
      threadRef: THREAD_REF,
      filePath: 'apps/web/src/components/DiffPanel.tsx',
      activeCwd: '/repo/project',
      filePreviewCwd: '/repo/project',
      openInEditor,
    })

    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, THREAD_REF),
    ).toMatchObject({
      isOpen: true,
      activeSurfaceId: 'file:apps/web/src/components/DiffPanel.tsx',
    })
    expect(openInEditor).not.toHaveBeenCalled()
  })

  it('falls back to the editor without thread context', () =>
  {
    const openInEditor = vi.fn()

    openDiffFilePrimaryAction({
      threadRef: null,
      filePath: 'apps/web/src/components/DiffPanel.tsx',
      activeCwd: '/repo/project',
      openInEditor,
    })

    expect(openInEditor).toHaveBeenCalledWith('/repo/project/apps/web/src/components/DiffPanel.tsx')
  })

  it('opens repository-relative diff files inside a nested project', () =>
  {
    const openInEditor = vi.fn()

    openDiffFilePrimaryAction({
      threadRef: THREAD_REF,
      filePath: 'frontend/Dockerfile',
      activeCwd: '/repo/frontend',
      filePreviewCwd: '/repo/frontend',
      repositoryRoot: '/repo',
      openInEditor,
    })

    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, THREAD_REF),
    ).toMatchObject({
      isOpen: true,
      activeSurfaceId: 'file:Dockerfile',
    })
    expect(openInEditor).not.toHaveBeenCalled()
  })

  it('keeps an adopted run root paired with its path by opening the absolute file', () =>
  {
    const openInEditor = vi.fn()

    openDiffFilePrimaryAction({
      threadRef: THREAD_REF,
      filePath: 'src/run-output.ts',
      activeCwd: '/runs/orchestrate-1',
      filePreviewCwd: '/repo/project',
      openInEditor,
    })

    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, THREAD_REF),
    ).toMatchObject({ isOpen: false })
    expect(openInEditor).toHaveBeenCalledWith('/runs/orchestrate-1/src/run-output.ts')
  })

  it('handles Windows roots while rejecting paths outside the nested project', () =>
  {
    expect(
      resolveDiffPathForWorkspace({
        filePath: 'Frontend/src\\index.ts',
        workspaceRoot: 'C:\\repo\\frontend',
        repositoryRoot: 'C:\\repo',
      }),
    ).toBe('src/index.ts')
    expect(
      resolveDiffPathForWorkspace({
        filePath: 'backend/server.ts',
        workspaceRoot: '/repo/frontend',
        repositoryRoot: '/repo',
      }),
    ).toBeNull()
    expect(
      resolveDiffPathForWorkspace({
        filePath: 'frontend/../secret.ts',
        workspaceRoot: '/repo/frontend',
        repositoryRoot: '/repo',
      }),
    ).toBeNull()
  })

  it('interprets drive syntax and backslashes only for Windows workspaces', () =>
  {
    expect(
      resolveDiffPathForWorkspace({
        filePath: 'C:notes.txt',
        workspaceRoot: '/repo/project',
        repositoryRoot: '/repo/project',
      }),
    ).toBe('C:notes.txt')
    expect(
      resolveDiffPathForWorkspace({
        filePath: 'src\\literal-name.ts',
        workspaceRoot: '/repo/project',
        repositoryRoot: '/repo/project',
      }),
    ).toBe('src\\literal-name.ts')
    expect(
      resolveDiffPathForWorkspace({
        filePath: 'C:notes.txt',
        workspaceRoot: 'C:\\repo',
        repositoryRoot: 'C:\\repo',
      }),
    ).toBeNull()
    expect(
      resolveDiffPathForWorkspace({
        filePath: 'src\\..\\secret.ts',
        workspaceRoot: 'C:\\repo',
        repositoryRoot: 'C:\\repo',
      }),
    ).toBeNull()
  })
})
