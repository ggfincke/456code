// apps/mobile/src/lib/nativeComposerTheme.test.ts
// protects native composer color conversion and default selection behavior

import { describe, expect, it } from "vite-plus/test";

import { getMobileThemeVariables } from "./mobileTheme";
import { createNativeComposerTheme } from "./nativeComposerTheme";

describe("native composer colors", () => {
  it("preserves native selection defaults unless an accent is supplied", () => {
    const colors = getMobileThemeVariables("t3-code", "dark");
    expect(createNativeComposerTheme(colors)).not.toHaveProperty("selection");
    expect(createNativeComposerTheme(colors, "#80cbc4").selection).toBe("#80cbc4");
  });

  it("flattens Material You alpha colors over the composer rather than falling back to defaults", () => {
    const theme = createNativeComposerTheme({
      ...getMobileThemeVariables("t3-code", "light"),
      "--color-screen": "#ffffffff",
      "--color-composer-surface": "#ffffffff",
      "--color-placeholder": "#0000009e",
    });
    expect(theme.placeholder).toBe("#616161");
  });
});
