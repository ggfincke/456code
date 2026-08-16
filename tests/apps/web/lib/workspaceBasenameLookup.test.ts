// tests/apps/web/lib/workspaceBasenameLookup.test.ts
// verify safe bare-filename resolution through workspace search results

import { describe, expect, it } from 'vite-plus/test'

import {
  needsWorkspaceBasenameLookup,
  pickWorkspaceBasenameMatch,
  resolveWorkspaceFileActionTarget,
  resolveWorkspaceFilePrimaryAction,
} from '../../../../apps/web/src/lib/workspaceBasenameLookup'

describe('workspace basename lookup', () =>
{
  it('searches only bare filenames', () =>
  {
    expect(needsWorkspaceBasenameLookup('ChatView.tsx')).toBe(true)
    expect(needsWorkspaceBasenameLookup('apps/web/ChatView.tsx')).toBe(false)
    expect(needsWorkspaceBasenameLookup('apps\\web\\ChatView.tsx')).toBe(false)
  })

  it('prefers exact file matches and rejects ambiguous folded matches', () =>
  {
    const entries = [
      { path: 'src/Foo.ts', kind: 'file' as const },
      { path: 'src/foo.ts', kind: 'file' as const },
      { path: 'src/foo.ts/foo.ts', kind: 'directory' as const },
    ]

    expect(pickWorkspaceBasenameMatch('foo.ts', entries)).toBe('src/foo.ts')
    expect(pickWorkspaceBasenameMatch('FOO.ts', entries)).toBeNull()
  })

  it('resolves a bare preview target before routing and ignores an older lookup', async () =>
  {
    let finishFirstSearch: (
      entries: ReadonlyArray<{ path: string; kind: 'file' }>,
    ) => void = () =>
    {}
    const firstSearch = new Promise<ReadonlyArray<{ path: string; kind: 'file' }>>((resolve) =>
    {
      finishFirstSearch = resolve
    })
    const firstAction = resolveWorkspaceFilePrimaryAction({
      resolveTarget: () =>
        resolveWorkspaceFileActionTarget({
          source: {
            filePath: '/repo/index.html',
            targetPath: '/repo/index.html',
            workspaceRelativePath: 'index.html',
          },
          cwd: '/repo',
          searchEntries: () => firstSearch,
        }),
      hasThreadContext: true,
      canOpenInBrowser: (path) => path.endsWith('.html') || path.endsWith('.pdf'),
    })
    const newestAction = resolveWorkspaceFilePrimaryAction({
      resolveTarget: () =>
        resolveWorkspaceFileActionTarget({
          source: {
            filePath: '/repo/report.pdf',
            targetPath: '/repo/report.pdf',
            workspaceRelativePath: 'report.pdf',
          },
          cwd: '/repo',
          searchEntries: async () => [{ path: 'docs/report.pdf', kind: 'file' }],
        }),
      hasThreadContext: true,
      canOpenInBrowser: (path) => path.endsWith('.html') || path.endsWith('.pdf'),
    })

    await expect(newestAction).resolves.toEqual({
      kind: 'browser',
      filePath: '/repo/docs/report.pdf',
    })
    finishFirstSearch([{ path: 'stale/index.html', kind: 'file' }])
    await expect(firstAction).resolves.toBeNull()
  })
})
