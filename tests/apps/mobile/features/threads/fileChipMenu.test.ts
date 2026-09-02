// tests/apps/mobile/features/threads/fileChipMenu.test.ts
// verify safe file-chip context actions

import { describe, expect, it } from 'vite-plus/test'

import {
  fileChipMenu,
  resolveFileChipTarget,
} from '../../../../../apps/mobile/src/features/threads/fileChipMenu'

describe('resolveFileChipTarget', () =>
{
  it('resolves file links without allowing workspace escapes', () =>
  {
    expect(resolveFileChipTarget('src/app.ts:12', '/repo')).toEqual({
      fullPath: '/repo/src/app.ts',
      relativePath: 'src/app.ts',
    })
    expect(resolveFileChipTarget('/tmp/report.md', '/repo')).toEqual({
      fullPath: '/tmp/report.md',
    })
    expect(resolveFileChipTarget('../other/file.ts', '/repo')).toBeNull()
    expect(resolveFileChipTarget('https://example.com/app.ts', '/repo')).toBeNull()
  })
})

describe('fileChipMenu', () =>
{
  it('offers only actions supported by the resolved target', () =>
  {
    expect(fileChipMenu({ relativePath: 'src/app.ts' })).toEqual({
      title: 'src/app.ts',
      actions: [
        { id: 'copy-relative-path', title: 'Copy relative path' },
        { id: 'open-file', title: 'Open in file viewer' },
      ],
    })
  })
})
