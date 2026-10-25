// apps/mobile/src/fincke/composer-controls.tsx
// touch controls for interaction mode, reasoning, and low usage

import type { ProviderInteractionMode } from "@t3tools/contracts";
import { Pressable, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { ComposerToolbarRow, ComposerToolbarScroller } from "../components/ComposerToolbar";
import { AppText as Text } from "../components/ui/AppText";
import { SymbolView } from "../components/ui/AppSymbol";
import { cn } from "../lib/cn";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";

function UsageRing({ remaining }: { readonly remaining: number }) {
  const { themeVariables } = useAppearancePreferences();
  const color =
    themeVariables[remaining <= 10 ? "--color-danger-foreground" : "--color-warning-foreground"];
  const length = 2 * Math.PI * 5;
  return (
    <Svg
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      width={14}
      height={14}
      viewBox="0 0 14 14"
    >
      <Circle cx={7} cy={7} r={5} fill="none" stroke={color} strokeOpacity={0.2} strokeWidth={2} />
      {remaining > 0 ? (
        <Circle
          cx={7}
          cy={7}
          r={5}
          fill="none"
          stroke={color}
          strokeWidth={2}
          strokeLinecap="round"
          strokeDasharray={`${(length * remaining) / 100} ${length}`}
          rotation={-90}
          origin="7,7"
        />
      ) : null}
    </Svg>
  );
}

export function ComposerControls(props: {
  readonly mode?: {
    readonly value: ProviderInteractionMode;
    readonly disabled: boolean;
    readonly onChange: (value: ProviderInteractionMode) => void;
  };
  readonly effort?: {
    readonly label: string;
    readonly disabled: boolean;
    readonly onPress: () => void;
  };
  readonly usage?: {
    readonly label: string;
    readonly remaining: number;
    readonly onPress: () => void;
  };
}) {
  if (!props.mode && !props.effort && !props.usage) return null;
  return (
    <ComposerToolbarRow
      paddingTop={0}
      paddingBottom={0}
      paddingHorizontal={4}
      style={{ minHeight: 44 }}
    >
      <ComposerToolbarScroller fadeSurface="sheet">
        {props.mode ? (
          <View
            className="flex-row items-center"
            accessibilityRole="radiogroup"
            accessibilityLabel="Interaction mode"
          >
            {(["default", "plan"] as const).map((mode) => {
              const selected = props.mode?.value === mode;
              return (
                <Pressable
                  key={mode}
                  accessibilityLabel={mode === "default" ? "Build mode" : "Plan mode"}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected, disabled: props.mode?.disabled }}
                  disabled={props.mode?.disabled}
                  className={cn(
                    "h-11 min-w-[64px] items-center justify-center rounded-xl px-3 active:opacity-60",
                    selected && "bg-primary/12",
                  )}
                  style={{
                    opacity: props.mode?.disabled ? 0.45 : 1,
                  }}
                  onPress={() => {
                    if (!selected) props.mode?.onChange(mode);
                  }}
                >
                  <Text
                    className={
                      selected
                        ? "text-sm font-t3-medium text-primary-text"
                        : "text-sm font-t3-medium text-foreground-muted"
                    }
                  >
                    {mode === "default" ? "Build" : "Plan"}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}
        {props.effort ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Reasoning effort, ${props.effort.label}`}
            accessibilityHint="Opens reasoning settings"
            accessibilityState={{ disabled: props.effort.disabled }}
            disabled={props.effort.disabled}
            onPress={props.effort.onPress}
            className="h-11 max-w-[220px] flex-row items-center gap-1.5 rounded-xl px-3 active:bg-subtle"
            style={{ opacity: props.effort.disabled ? 0.45 : 1 }}
          >
            <SymbolView
              name="brain"
              size={15}
              tintColorClassName="accent-primary-text"
              type="monochrome"
            />
            <Text
              className="shrink text-sm font-t3-medium text-foreground-secondary"
              numberOfLines={1}
            >
              {props.effort.label}
            </Text>
            <SymbolView
              name="chevron.down"
              size={10}
              tintColorClassName="accent-foreground-muted"
              type="monochrome"
            />
          </Pressable>
        ) : null}
        {props.usage ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${props.usage.label}: ${props.usage.remaining}% left`}
            accessibilityHint="Opens thread settings, which lists usage limits"
            onPress={props.usage.onPress}
            className="h-11 flex-row items-center gap-1.5 rounded-xl px-3 active:bg-subtle"
          >
            <UsageRing remaining={props.usage.remaining} />
            <Text
              className={
                props.usage.remaining <= 10
                  ? "text-sm font-t3-medium tabular-nums text-danger-foreground"
                  : "text-sm font-t3-medium tabular-nums text-warning-foreground"
              }
            >
              {props.usage.remaining}%
            </Text>
          </Pressable>
        ) : null}
      </ComposerToolbarScroller>
    </ComposerToolbarRow>
  );
}
