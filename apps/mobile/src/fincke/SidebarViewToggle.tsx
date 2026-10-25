// apps/mobile/src/fincke/SidebarViewToggle.tsx
// sidebar row buttons, incl. the one that flips between the projects & activity views

import { Pressable } from "react-native";

import { SymbolView, type AppSymbolName } from "../components/ui/AppSymbol";
import type { MobileThemeVariables } from "../lib/mobileTheme";

const OCEAN_ACCENT = "#80cbc4";

// leave onPress unset when a Menu wraps the button, since the menu owns the tap
export function SidebarRowButton(props: {
  readonly icon: AppSymbolName;
  readonly label: string;
  readonly accent?: string;
  readonly onPress?: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      className="size-8 items-center justify-center rounded-lg"
      onPress={props.onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <SymbolView
        name={props.icon}
        size={15}
        tintColor={props.accent}
        tintColorClassName={props.accent ? undefined : "accent-drawer-foreground-muted"}
        type="monochrome"
      />
    </Pressable>
  );
}

// one button showing the current view in the accent color, matching web's search-row toggle
export function SidebarViewToggle(props: {
  readonly projectsView: boolean;
  readonly onChange: (projectsView: boolean) => void;
  readonly ocean: boolean;
  readonly theme: MobileThemeVariables;
}) {
  return (
    <SidebarRowButton
      icon={props.projectsView ? { ios: "list.bullet.indent", android: "folder" } : "bell.badge"}
      label={props.projectsView ? "Switch to Activity view" : "Switch to Projects view"}
      accent={props.ocean ? OCEAN_ACCENT : props.theme["--color-primary"]}
      onPress={() => props.onChange(!props.projectsView)}
    />
  );
}
