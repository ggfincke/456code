import type { NativeStackHeaderItem } from "@react-navigation/native-stack";

import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";

type NativeHeaderIcon = NonNullable<Extract<NativeStackHeaderItem, { type: "button" }>["icon"]>;

function sfSymbolIcon(name: string): NativeHeaderIcon {
  return { type: "sfSymbol", name: name as never };
}

// the thread filter lives in the sidebar's button row, under the search bar, like web
export function createSidebarHeaderItems(input: {
  readonly onOpenSettings: () => void;
}): NativeStackHeaderItem[] {
  return [
    withNativeGlassHeaderItem({
      type: "button",
      axisBehavior: "horizontalOnly",
      label: "Settings",
      accessibilityLabel: "Open settings",
      icon: sfSymbolIcon("gearshape"),
      onPress: input.onOpenSettings,
    }),
  ];
}
