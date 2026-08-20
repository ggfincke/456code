// tests/apps/web/components/threadActionMenu.logic.test.ts
// verifies refined thread action menu grouping and capability gates

import { describe, expect, it } from 'vite-plus/test'

import { buildThreadActionMenuItems } from '../../../../apps/web/src/components/threadActionMenu.logic'

describe('buildThreadActionMenuItems', () =>
{
  it('groups copy actions and preserves supported lifecycle actions', () =>
  {
    const items = buildThreadActionMenuItems({
      branch: 'feature/menu',
      isPinned: false,
      isSettled: false,
      isSnoozed: false,
      canSnoozeNow: true,
      isRegeneratingTitle: false,
      isRunning: true,
      supports: {
        settlement: true,
        snooze: true,
        pinning: false,
        titleRegeneration: false,
      },
      snoozePresets: [],
    })

    expect(items.map((item) => item.id)).toEqual([
      'new-thread-on-branch',
      'settle',
      'snooze',
      'rename',
      'mark-unread',
      'copy',
      'archive',
      'delete',
    ])
    expect(items.find((item) => item.id === 'copy')?.children?.map((item) => item.id)).toEqual([
      'copy-path',
      'copy-branch',
      'copy-thread-id',
    ])
    expect(items.find((item) => item.id === 'archive')).toMatchObject({
      disabled: true,
      icon: 'archive',
      separatorBefore: true,
    })
  })
})
