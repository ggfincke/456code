// tests/apps/web/components/files/fileTreePathReconciliation.test.ts
// protect expanded and selected tree paths while agent edits alter neighboring files

import { FileTree } from '@pierre/trees'
import { expect, it } from 'vite-plus/test'

import { buildFileTreePathUpdates } from '../../../../../apps/web/src/components/files/fileTreePathReconciliation'

it('preserves surviving expansion and selection while removing and replacing paths', () =>
{
  const before = ['src/', 'src/keep.ts', 'old/', 'old/remove.ts', 'replace/']
  const after = ['src/', 'src/keep.ts', 'src/new.ts', 'replace']
  const tree = new FileTree({ paths: before, initialExpansion: 'closed' })
  try
  {
    const directory = tree.getItem('src/')
    if (!directory || !('expand' in directory)) throw new Error('expected src directory')
    directory.expand()
    tree.getItem('src/keep.ts')?.select()
    tree.focusPath('src/keep.ts')
    tree.batch(buildFileTreePathUpdates(before, after))
    expect(tree.getSelectedPaths()).toEqual(['src/keep.ts'])
    expect(tree.getFocusedPath()).toBe('src/keep.ts')
    expect(
      tree.getVisibleRows(0, tree.getVisibleCount()).find((row) => row.path === 'src/')?.isExpanded,
    ).toBe(true)
    expect(tree.getItem('src/new.ts')).not.toBeNull()
    expect(tree.getItem('old/remove.ts')).toBeNull()
    expect(tree.getItem('replace')?.isDirectory()).toBe(false)
    expect(buildFileTreePathUpdates(after, [...after])).toEqual([])
  }
  finally
  {
    tree.cleanUp()
  }
})
