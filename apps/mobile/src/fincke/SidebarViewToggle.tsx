// apps/mobile/src/fincke/SidebarViewToggle.tsx
// two buttons that switch the sidebar between the projects & activity views

import { Pressable, View } from "react-native";

import { SymbolView, type AppSymbolName } from "../components/ui/AppSymbol";
import type { MobileThemeVariables } from "../lib/mobileTheme";

const OCEAN_ACCENT = "#80cbc4";

function ViewButton(props: {
  readonly icon: AppSymbolName;
  readonly label: string;
  readonly active: boolean;
  readonly accent: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ selected: props.active }}
      className="size-8 items-center justify-center overflow-hidden rounded-lg"
      onPress={props.onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      {/* theme colors are not always hex, so the accent wash is a layer, not an alpha suffix */}
      {props.active ? (
        <View
          className="absolute inset-0"
          style={{ backgroundColor: props.accent, opacity: 0.12 }}
        />
      ) : null}
      <SymbolView
        name={props.icon}
        size={15}
        tintColor={props.active ? props.accent : undefined}
        tintColorClassName={props.active ? undefined : "accent-drawer-foreground-muted"}
        type="monochrome"
      />
    </Pressable>
  );
}

export function SidebarViewToggle(props: {
  readonly projectsView: boolean;
  readonly onChange: (projectsView: boolean) => void;
  readonly ocean: boolean;
  readonly theme: MobileThemeVariables;
}) {
  const accent = props.ocean ? OCEAN_ACCENT : props.theme["--color-primary"];
  return (
    <View className="flex-row items-center gap-0.5">
      <ViewButton
        icon={{ ios: "list.bullet.indent", android: "folder" }}
        label="Projects view"
        active={props.projectsView}
        accent={accent}
        onPress={() => props.onChange(true)}
      />
      <ViewButton
        icon="bell.badge"
        label="Activity view"
        active={!props.projectsView}
        accent={accent}
        onPress={() => props.onChange(false)}
      />
    </View>
  );
}
