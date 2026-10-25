// apps/mobile/src/lib/mobileThemeRuntime.test.ts
// appearance runtime registration and transition contracts
import { describe, expect, it } from "vite-plus/test";

import {
  createMobileThemeRuntimeOperations,
  getMobileUniwindThemeName,
  type MobileThemeRuntimeState,
} from "./mobileThemeRuntime";

const initialState: MobileThemeRuntimeState = {
  baseFontSize: 16,
  themeAppearance: "light",
  themeMode: "system",
};

describe("mobileThemeRuntime", () => {
  it("registers only Ocean's dark appearance for runtime text updates", () => {
    expect(getMobileUniwindThemeName("fincke-ocean", "dark")).toBe("fincke-ocean-dark");
    const operations = createMobileThemeRuntimeOperations(null, initialState);
    expect(operations).toContainEqual(
      expect.objectContaining({ kind: "update-text-variables", themeName: "fincke-ocean-dark" }),
    );
    expect(operations).not.toContainEqual(
      expect.objectContaining({ themeName: "fincke-ocean-light" }),
    );
  });
  it("lets system appearance changes flow through the root ScopedTheme only", () => {
    const operations = createMobileThemeRuntimeOperations(initialState, {
      ...initialState,
      themeAppearance: "dark",
    });

    expect(operations).toEqual([]);
  });
});
