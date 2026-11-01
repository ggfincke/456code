// scripts/mobile-showcase.config.ts
// configures local mobile screenshot devices, themes, and output
import {
  MOBILE_DEFAULT_THEME_ID,
  MOBILE_THEME_IDS,
  type MobileThemeId,
} from "@t3tools/shared/themePalettes";

import { SHOWCASE_SCENES, type ShowcaseScene } from "./mobile-showcase-environment.ts";

export { SHOWCASE_SCENES };
export type { ShowcaseScene };

export type ShowcaseAppearance = "light" | "dark";

export const SHOWCASE_THEMES = MOBILE_THEME_IDS;
const DEFAULT_SHOWCASE_THEME = MOBILE_DEFAULT_THEME_ID;
export type ShowcaseTheme = MobileThemeId;

export interface ShowcaseStoreAssetSpec {
  readonly store: "apple";
  readonly directory: string;
  readonly width: number;
  readonly height: number;
  readonly minimumUploadCount: number;
  readonly maximumUploadCount: number;
}

export interface ShowcaseIosDevice {
  readonly id: string;
  readonly platform: "ios";
  readonly simulator: string;
  readonly simulatorDeviceType?: string;
  readonly appearance: ShowcaseAppearance;
  readonly theme: ShowcaseTheme;
  readonly orientation?: "portrait" | "landscape";
  readonly fold?: "closed" | "open";
  readonly scenes: ReadonlyArray<ShowcaseScene>;
  readonly storeAsset: ShowcaseStoreAssetSpec;
}

export type ShowcaseDevice = ShowcaseIosDevice;

export interface ShowcaseConfig {
  readonly outputDirectory: string;
  readonly metroPort: number;
  readonly settleDelayMs: number;
  readonly devices: ReadonlyArray<ShowcaseDevice>;
}

const config: ShowcaseConfig = {
  outputDirectory: "artifacts/app-store/screenshots",
  // A dedicated port prevents captures from attaching to another dev server's bundle.
  metroPort: 8199,
  settleDelayMs: 2_500,
  devices: [
    {
      id: "iphone-6.9",
      platform: "ios",
      simulator: "T3 Showcase iPhone 17 Pro Max",
      simulatorDeviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max",
      appearance: "dark",
      theme: DEFAULT_SHOWCASE_THEME,
      scenes: ["thread", "terminal", "review", "threads", "environments"],
      storeAsset: {
        store: "apple",
        directory: "apple/iphone-6.9",
        width: 1320,
        height: 2868,
        minimumUploadCount: 1,
        maximumUploadCount: 10,
      },
    },
    {
      id: "iphone-6.5",
      platform: "ios",
      simulator: "T3 Showcase iPhone 14 Plus",
      simulatorDeviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-14-Plus",
      appearance: "dark",
      theme: DEFAULT_SHOWCASE_THEME,
      scenes: ["thread", "terminal", "review", "threads", "environments"],
      storeAsset: {
        store: "apple",
        directory: "apple/iphone-6.5",
        width: 1284,
        height: 2778,
        minimumUploadCount: 1,
        maximumUploadCount: 10,
      },
    },
    ...(["closed", "open"] as const).map((fold): ShowcaseIosDevice => ({
      id: `iphone-duo-${fold}`,
      platform: "ios",
      simulator: `T3 Showcase iPhone Duo ${fold}`,
      simulatorDeviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo",
      appearance: "dark",
      theme: DEFAULT_SHOWCASE_THEME,
      orientation: fold === "closed" ? "portrait" : "landscape",
      fold,
      // Both poses share one ten-image App Store slot.
      scenes: ["thread", "terminal", "review", "threads", "environments"],
      storeAsset: {
        store: "apple",
        directory: `apple/iphone-duo-${fold}`,
        width: fold === "closed" ? 1398 : 2853,
        height: fold === "closed" ? 2034 : 2007,
        minimumUploadCount: 1,
        maximumUploadCount: 5,
      },
    })),
    {
      id: "ipad-13",
      platform: "ios",
      simulator: "iPad Pro 13-inch (M5)",
      simulatorDeviceType: "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5-16GB",
      appearance: "dark",
      theme: DEFAULT_SHOWCASE_THEME,
      orientation: "landscape",
      // Lock screens ignore app rotation; headless landscape captures would be sideways.
      scenes: ["thread", "terminal", "review", "threads", "environments"],
      storeAsset: {
        store: "apple",
        directory: "apple/ipad-13",
        width: 2752,
        height: 2064,
        minimumUploadCount: 1,
        maximumUploadCount: 10,
      },
    },
  ],
};

export default config;
