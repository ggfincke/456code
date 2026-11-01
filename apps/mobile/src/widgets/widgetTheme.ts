// apps/mobile/src/widgets/widgetTheme.ts
// maps app colors to native widget palettes
import {
  flattenThemeColor,
  themeColorWithAlpha,
  type MobileThemeMode,
  type MobileThemeVariables,
} from "../lib/mobileTheme";

export interface WidgetPalette {
  background: string;
  foreground: string;
  secondary: string;
  accent: string;
  track: string;
  danger: string;
  info?: string;
  warning?: string;
  attentionSurface?: string;
  surface?: string;
  accentSurface?: string;
  dangerSurface?: string;
  infoSurface?: string;
}

export interface WidgetTheme {
  mode: MobileThemeMode;
  light: WidgetPalette;
  dark: WidgetPalette;
}

export function createWidgetTheme(
  mode: MobileThemeMode,
  palettes: Readonly<Record<"light" | "dark", MobileThemeVariables>>,
): WidgetTheme {
  const palette = (variables: MobileThemeVariables) => {
    const tint = (color: string, alpha: number) =>
      flattenThemeColor(themeColorWithAlpha(color, alpha), variables["--color-card"]);
    // like the app: the page background behind raised card surfaces
    return {
      background: variables["--color-screen"],
      foreground: variables["--color-foreground"],
      secondary: variables["--color-foreground-secondary"],
      accent: variables["--color-primary"],
      // Surface tokens can coincide; a foreground blend keeps the unfilled track visible.
      track: flattenThemeColor(
        themeColorWithAlpha(variables["--color-foreground"], 0.16),
        variables["--color-card"],
      ),
      danger: variables["--color-danger-foreground"],
      info: variables["--color-update-foreground"],
      warning: variables["--color-warning-foreground"],
      attentionSurface: tint(variables["--color-warning-foreground"], 0.12),
      surface: variables["--color-grouped-card"],
      accentSurface: tint(variables["--color-primary"], 0.16),
      dangerSurface: tint(variables["--color-danger-foreground"], 0.16),
      infoSurface: tint(variables["--color-update-foreground"], 0.16),
    };
  };
  return { mode, light: palette(palettes.light), dark: palette(palettes.dark) };
}
