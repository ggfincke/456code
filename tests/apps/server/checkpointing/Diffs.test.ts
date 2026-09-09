// tests/apps/server/checkpointing/Diffs.test.ts
// verify git numstat parsing for checkpoint file summaries

import { describe, expect, it } from 'vite-plus/test'

import { parseTurnDiffFilesFromNumstat } from '../../../../apps/server/src/checkpointing/Diffs.ts'

describe('parseTurnDiffFilesFromNumstat', () =>
{
  it('sorts files and preserves text and binary counts', () =>
  {
    const numstat = ['0\t2\tsrc/b.ts', '2\t1\ta.txt', '-\t-\timage.png', ''].join('\0')
    expect(parseTurnDiffFilesFromNumstat(numstat)).toEqual([
      { path: 'a.txt', additions: 2, deletions: 1 },
      { path: 'image.png', additions: 0, deletions: 0 },
      { path: 'src/b.ts', additions: 0, deletions: 2 },
    ])
  })

  it('uses destination paths for NUL-delimited renames and copies', () =>
  {
    const numstat = [
      '0\t0\t',
      'src/old.ts',
      'src/new.ts',
      '2\t1\t',
      'src/source.ts',
      'src/copied.ts',
      '',
    ].join('\0')

    expect(parseTurnDiffFilesFromNumstat(numstat)).toEqual([
      { path: 'src/copied.ts', additions: 2, deletions: 1 },
      { path: 'src/new.ts', additions: 0, deletions: 0 },
    ])
  })

  it('preserves Unicode, tabs, line endings, and spaces in paths', () =>
  {
    const path = ' café\tline\r\nname.txt '
    expect(parseTurnDiffFilesFromNumstat(`3\t2\t\0old\tname\n.txt\0${path}\0`)).toEqual([
      { path, additions: 3, deletions: 2 },
    ])
  })
})
