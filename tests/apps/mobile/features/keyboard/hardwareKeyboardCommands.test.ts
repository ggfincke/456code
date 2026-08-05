// tests/apps/mobile/features/keyboard/hardwareKeyboardCommands.test.ts
// verify parse active thread path behavior

import { describe, expect, it } from 'vite-plus/test'

import { parseActiveThreadPath } from '../../../../../apps/mobile/src/features/keyboard/hardwareKeyboardCommands'

describe('parseActiveThreadPath', () =>
{
  it.each([
    [
      '/threads/environment-1/thread-1/files/src/index.ts',
      { environmentId: 'environment-1', threadId: 'thread-1' },
    ],
    [
      '/threads/local%20machine/thread%2Fone/review',
      { environmentId: 'local machine', threadId: 'thread/one' },
    ],
    ['/settings', null],
    ['/threads/environment-only', null],
    ['/threads/%E0%A4%A/thread-1', null],
  ])('parses %s', (pathname, expected) =>
  {
    expect(parseActiveThreadPath(pathname)).toEqual(expected)
  })
})
