// tests/apps/mobile/native/reactNativeScreensPatch.test.ts
// verify the iOS-only react-native-screens toolbar patch contract

import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import { describe, expect, it } from 'vite-plus/test'

const patch = NodeFS.readFileSync(
  NodePath.resolve(import.meta.dirname, '../../../../patches/react-native-screens@4.26.2.patch'),
  'utf8',
)

describe('react-native-screens iOS toolbar patch', () =>
{
  it('keeps independent placement caches and stable Mail search state', () =>
  {
    expect(patch).toContain('RNSAppliedLeadingHeaderItemsKey')
    expect(patch).toContain('RNSAppliedTrailingHeaderItemsKey')
    expect(patch).toContain('RNSAppliedCenterHeaderItemsKey')
    expect(patch).toContain('reuseMailSearchToolbar')
    expect(patch).toContain('RNSAppliedMailSearchToolbarConfigKey')
    expect(patch).toContain('setSearchEditingAppearance')
    expect(patch).toContain('navigationToolbarConfigs')
    expect(patch).toContain("prepareHeaderBarButtonItems(headerToolbarItems, 'toolbar')")
    expect(patch).toContain('mail-search-toolbar.text-change')
    expect(patch).toContain('mail-search-toolbar.keyboard-begin')
    expect(patch).toContain('mail-search-toolbar.keyboard-end')
    expect(patch).toContain('barButtonItemGroupsFromItems')
    expect(patch).toContain('if (items.count == 0)')
    expect(patch).toContain('items:@[ item ]')
  })

  it('contains no Android or custom header-subview identity hunks', () =>
  {
    expect(patch).not.toContain('diff --git a/android/')
    expect(patch).not.toContain('diff --git a/ios/RNSScreenStackHeaderSubview.mm')
    expect(patch).not.toContain('barButtonItemIdentifier')
  })
})
