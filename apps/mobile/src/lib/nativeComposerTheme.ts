// apps/mobile/src/lib/nativeComposerTheme.ts
// resolves native composer text and optional selection colors

import { flattenThemeColor, type MobileThemeVariables } from "./mobileTheme";

// native chip parsers need opaque hex instead of css rgba or platform-specific alpha order.
export function createNativeComposerTheme(theme: MobileThemeVariables, selectionAccent?: string) {
  const surface = flattenThemeColor(theme["--color-composer-surface"], theme["--color-screen"]);
  return {
    text: flattenThemeColor(theme["--color-foreground"], surface),
    placeholder: flattenThemeColor(theme["--color-placeholder"], surface),
    ...(selectionAccent ? { selection: flattenThemeColor(selectionAccent, surface) } : {}),
  };
}
