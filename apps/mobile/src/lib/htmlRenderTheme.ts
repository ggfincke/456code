import { HTML_RENDER_DEFAULT_FONTS, htmlRenderTheme } from "@t3tools/shared/htmlRender";

import {
  getMobileThemeColors,
  nativeColors,
  type MobileThemeAppearance,
  type MobileThemeId,
  type MobileThemeVariables,
} from "./mobileTheme";

/** WebViews cannot load bundled app fonts; use system stacks. */
export function mobileHtmlRenderTheme(input: {
  readonly themeId: MobileThemeId;
  readonly appearance: MobileThemeAppearance;
  readonly variables: MobileThemeVariables;
  readonly platform: string;
}) {
  const { variables: v } = input;
  const palette = getMobileThemeColors(input.themeId, input.appearance);
  const colors = nativeColors(palette);
  const canvas = v[input.platform === "android" ? "--color-thread-canvas" : "--color-screen"];
  return htmlRenderTheme({ ...colors, canvas }, input.appearance, HTML_RENDER_DEFAULT_FONTS);
}
