// tests/apps/mobile/lib/adaptive-navigation.test.ts
// verify is base thread route behavior

import { describe, expect, it } from 'vite-plus/test'

import {
  isBaseThreadRoute,
  resolveFileSelectionNavigationAction,
  resolveThreadSelectionNavigationAction,
} from '../../../../apps/mobile/src/lib/adaptive-navigation'

describe('isBaseThreadRoute', () =>
{
  it('recognizes only the thread detail route', () =>
  {
    expect(isBaseThreadRoute('/threads/environment/thread')).toBe(true)
    expect(isBaseThreadRoute('/threads/environment/thread/')).toBe(true)
    expect(isBaseThreadRoute('/threads/environment/thread/files')).toBe(false)
    expect(isBaseThreadRoute('/threads/environment/thread/review')).toBe(false)
  })
})

describe('resolveThreadSelectionNavigationAction', () =>
{
  it.each([
    [true, '/threads/environment/thread', 'set-params'],
    [true, '/threads/environment/thread/files/path', 'replace'],
    [true, '/', 'push'],
    [false, '/threads/environment/thread', 'push'],
  ] as const)('usesSplitView=%s pathname=%s → %s', (usesSplitView, pathname, expected) =>
  {
    expect(resolveThreadSelectionNavigationAction({ usesSplitView, pathname })).toBe(expected)
  })
})

describe('resolveFileSelectionNavigationAction', () =>
{
  it.each([
    [true, 'replace'],
    [false, 'push'],
  ] as const)('persistent inspector=%s → %s', (hasPersistentFileInspector, expected) =>
  {
    expect(resolveFileSelectionNavigationAction({ hasPersistentFileInspector })).toBe(expected)
  })
})
