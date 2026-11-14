// apps/mobile/src/fincke/EffortBars.tsx
// the effort chip's level bars & ocean level color, matching web's effort picker

import { finckeEffortBarHeights, finckeEffortBars } from "@t3tools/shared/fincke-effort-scale";
import { View } from "react-native";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { finckeEffortTint } from "./ocean-colors";

/** The level's ocean color; null on other themes, which keep their own accent. */
export function useEffortTint(levelId: string | null | undefined): string | null {
  const { themeId } = useAppearancePreferences();
  return themeId === "fincke-ocean" && levelId ? finckeEffortTint(levelId) : null;
}

export function EffortBars(props: {
  readonly levelIds: ReadonlyArray<string>;
  readonly levelId: string | null;
  readonly color: string;
  readonly height: number;
}) {
  const { count, filled } = finckeEffortBars(props.levelIds, props.levelId);
  const barWidth = props.height / 5;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="flex-row items-end"
      style={{ gap: barWidth / 2 }}
    >
      {finckeEffortBarHeights(count, props.height).map((height, index) => (
        <View
          key={height}
          style={{
            width: barWidth,
            height,
            borderRadius: barWidth / 2,
            backgroundColor: props.color,
            opacity: index < filled ? 1 : 0.25,
          }}
        />
      ))}
    </View>
  );
}
