// apps/mobile/src/fincke/FinckeListHeader.tsx
// static ocean artwork inside existing native list content

import { View } from "react-native";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { FinckeWaveArt } from "./FinckeWaveArt";

export function FinckeListHeader() {
  const { themeId } = useAppearancePreferences();
  if (themeId !== "fincke-ocean") return null;
  return (
    <View
      className="mx-3 mb-3 mt-1 h-20 overflow-hidden rounded-xl"
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <FinckeWaveArt />
    </View>
  );
}
