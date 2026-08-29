// apps/mobile/src/features/layout/native-mail-search-toolbar.ts
// create native mail search toolbar item

import type { HeaderBarButtonMailSearchToolbarItem } from 'react-native-screens'

type NativeMailSearchToolbarInput = Omit<
  HeaderBarButtonMailSearchToolbarItem,
  'type' | 'useFallbackSearchField'
>

// builds the patched react-native-screens Mail-style bottom search toolbar.
//
// keeping this behind an app-level helper makes the RNS patch an explicit
// layout primitive instead of a per-screen object literal.
export function createNativeMailSearchToolbarItem(
  input: NativeMailSearchToolbarInput,
): HeaderBarButtonMailSearchToolbarItem
{
  return {
    placeholder: 'Search',
    ...input,
    type: 'mailSearchToolbar',
    useFallbackSearchField: true,
  }
}
