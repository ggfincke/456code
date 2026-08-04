// tests/apps/web/filePathDisplay.test.ts
// verify format workspace relative path behavior

import { describe, expect, it } from 'vite-plus/test'

import { formatWorkspaceRelativePath } from '../../../apps/web/src/filePathDisplay'

describe('formatWorkspaceRelativePath', () =>
{
  it('prefixes relative paths with the workspace root label', () =>
  {
    expect(
      formatWorkspaceRelativePath(
        'apps/web/src/session-logic.ts:501',
        'C:/Users/mike/dev-stuff/t3code',
      ),
    ).toBe('t3code/apps/web/src/session-logic.ts:501')
  })

  it('keeps paths already rooted at the workspace label stable', () =>
  {
    expect(
      formatWorkspaceRelativePath(
        't3code/apps/web/src/session-logic.ts:501',
        'C:/Users/mike/dev-stuff/t3code',
      ),
    ).toBe('t3code/apps/web/src/session-logic.ts:501')
  })

  it('preserves columns when present', () =>
  {
    expect(
      formatWorkspaceRelativePath(
        '/C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts:501:9',
        'C:/Users/mike/dev-stuff/t3code',
      ),
    ).toBe('t3code/apps/web/src/session-logic.ts:501:9')
  })
})
