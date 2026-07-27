import { describe, expect, it } from "vite-plus/test";

import { supportsNativeLiquidGlass } from "../../../../apps/mobile/src/lib/native-glass-capability";

describe("supportsNativeLiquidGlass", () => {
  it.each([
    ["ios", true, true],
    ["ios", false, false],
    ["android", true, false],
    ["web", true, false],
  ] as const)("platform %s capability=%s → %s", (platform, capability, expected) => {
    expect(supportsNativeLiquidGlass(platform, capability)).toBe(expected);
  });
});
