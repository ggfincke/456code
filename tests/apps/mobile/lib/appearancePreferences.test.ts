import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_BASE_FONT_SIZE,
  deriveCodeFontSize,
  deriveTerminalFontSize,
  normalizeBaseFontSize,
  normalizeCodeFontSize,
  resolveAppearance,
  resolveAppearancePreferences,
  stepBaseFontSize,
  stepCodeFontSize,
  stepTerminalFontSize,
} from "../../../../apps/mobile/src/lib/appearancePreferences";

describe("appearancePreferences", () => {
  it("resolves defaults for empty stored preferences", () => {
    expect(resolveAppearancePreferences({})).toEqual({
      baseFontSize: DEFAULT_BASE_FONT_SIZE,
      terminalFontSize: null,
      codeFontSize: null,
      codeWordBreak: false,
    });
  });

  it("migrates the legacy markdownFontSize key to baseFontSize", () => {
    expect(resolveAppearancePreferences({ markdownFontSize: 18 }).baseFontSize).toBe(18);
    expect(
      resolveAppearancePreferences({ baseFontSize: 16, markdownFontSize: 18 }).baseFontSize,
    ).toBe(16);
  });

  it("keeps explicit overrides and treats missing values as automatic", () => {
    const preferences = resolveAppearancePreferences({ terminalFontSize: 12, codeFontSize: 14 });
    expect(preferences.terminalFontSize).toBe(12);
    expect(preferences.codeFontSize).toBe(14);
    expect(resolveAppearancePreferences({ terminalFontSize: null }).terminalFontSize).toBe(null);
  });

  it("derives terminal and code sizes from the base size when not overridden", () => {
    const appearance = resolveAppearance(resolveAppearancePreferences({ baseFontSize: 15 }));
    expect(appearance.terminalFontSize).toBe(10);
    expect(appearance.codeFontSize).toBe(11);
    expect(appearance.isTerminalFontSizeCustom).toBe(false);
    expect(appearance.isCodeFontSizeCustom).toBe(false);

    const scaled = resolveAppearance(resolveAppearancePreferences({ baseFontSize: 22 }));
    expect(scaled.terminalFontSize).toBe(deriveTerminalFontSize(22));
    expect(scaled.codeFontSize).toBe(deriveCodeFontSize(22));
    expect(scaled.terminalFontSize).toBeGreaterThan(10);
    expect(scaled.codeFontSize).toBeGreaterThan(11);
  });

  it("applies explicit overrides over derived values", () => {
    const appearance = resolveAppearance(
      resolveAppearancePreferences({ baseFontSize: 22, terminalFontSize: 8, codeFontSize: 9 }),
    );
    expect(appearance.terminalFontSize).toBe(8);
    expect(appearance.codeFontSize).toBe(9);
    expect(appearance.isTerminalFontSizeCustom).toBe(true);
    expect(appearance.isCodeFontSizeCustom).toBe(true);
  });

  it("clamps base and code font sizes", () => {
    expect(normalizeBaseFontSize(4)).toBe(11);
    expect(normalizeBaseFontSize(30)).toBe(22);
    expect(normalizeCodeFontSize(4)).toBe(8);
    expect(normalizeCodeFontSize(30)).toBe(18);
  });

  it("steps font sizes within bounds", () => {
    expect(stepTerminalFontSize(6, -1)).toBe(6);
    expect(stepBaseFontSize(11, -1)).toBe(11);
    expect(stepCodeFontSize(8, -1)).toBe(8);
    expect(stepBaseFontSize(15, 1)).toBe(16);
  });
});
