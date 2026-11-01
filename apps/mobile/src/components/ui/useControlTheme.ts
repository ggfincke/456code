import { useAppearancePreferences } from "../../features/settings/appearance/AppearancePreferencesProvider";

export function useControlTheme() {
  const { themeId, themeAppearance, themeVariables, appearance } = useAppearancePreferences();
  return {
    themeId,
    colorScheme: themeAppearance,
    colors: themeVariables,
    fontSize: appearance.baseFontSize,
  };
}
