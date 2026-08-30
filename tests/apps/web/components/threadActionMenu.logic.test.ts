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

  it('offers pin when supported and the thread is not pinned', () =>
  {
    const items = buildThreadActionMenuItems({
      branch: null,
      isPinned: false,
      isSettled: false,
      isSnoozed: false,
      canSnoozeNow: false,
      isRegeneratingTitle: false,
      isRunning: false,
      supports: {
        settlement: false,
        snooze: false,
        pinning: true,
        titleRegeneration: false,
      },
      snoozePresets: [],
    })

    expect(items[0]).toMatchObject({ id: 'pin', label: 'Pin thread', icon: 'pin' })
  })

  it('offers unpin for a pinned thread', () =>
  {
    const items = buildThreadActionMenuItems({
      branch: null,
      isPinned: true,
      isSettled: false,
      isSnoozed: false,
      canSnoozeNow: false,
      isRegeneratingTitle: false,
      isRunning: false,
      supports: {
        settlement: false,
        snooze: false,
        pinning: true,
        titleRegeneration: false,
      },
      snoozePresets: [],
    })

    expect(items[0]).toMatchObject({ id: 'unpin', label: 'Unpin thread', icon: 'pin-off' })
  })
})
