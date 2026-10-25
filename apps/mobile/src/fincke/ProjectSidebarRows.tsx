// apps/mobile/src/fincke/ProjectSidebarRows.tsx
// project header & show-more rows for the projects sidebar view

import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { memo } from "react";
import { Pressable, View } from "react-native";

import { ProjectFavicon } from "../components/ProjectFavicon";
import { SymbolView } from "../components/ui/AppSymbol";
import { AppText as Text } from "../components/ui/AppText";
import type { MobileThemeVariables } from "../lib/mobileTheme";
import type { FinckeProjectHeaderItem, FinckeProjectMoreItem } from "./project-sidebar";
import { SidebarStatusGlyph, sidebarStatusColor } from "./SidebarStatusGlyph";

export const FinckeProjectHeaderRow = memo(function FinckeProjectHeaderRow(props: {
  readonly item: FinckeProjectHeaderItem;
  readonly ocean: boolean;
  readonly theme: MobileThemeVariables;
  readonly onToggle: (scopeKey: string) => void;
  readonly onNewThread: (project: EnvironmentProject) => void;
}) {
  const { item } = props;
  return (
    <View className="mt-1 h-[34px] flex-row items-center">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={item.title}
        accessibilityState={{ expanded: !item.collapsed }}
        accessibilityHint={`${item.collapsed ? "Shows" : "Hides"} this project's threads.`}
        className="h-full min-w-0 flex-1 flex-row items-center gap-2 rounded-lg pl-1.5 pr-1"
        onPress={() => props.onToggle(item.scopeKey)}
        style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
      >
        <View style={{ transform: [{ rotate: item.collapsed ? "0deg" : "90deg" }] }}>
          <SymbolView
            name="chevron.right"
            size={9}
            tintColorClassName="accent-drawer-foreground-muted"
            type="monochrome"
            weight="semibold"
          />
        </View>
        <ProjectFavicon
          environmentId={item.project.environmentId}
          faviconPath={item.project.faviconPath}
          projectIcon={item.project.projectIcon}
          projectId={item.project.id}
          open={!item.collapsed}
          size={15}
          projectTitle={item.title}
          workspaceRoot={item.project.workspaceRoot}
        />
        <Text
          className="min-w-0 flex-1 text-[14px] font-t3-medium text-drawer-foreground"
          numberOfLines={1}
        >
          {item.title}
        </Text>
        {item.status ? (
          <SidebarStatusGlyph
            status={item.status}
            color={sidebarStatusColor(item.status.tone, props.ocean, props.theme)}
          />
        ) : null}
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`New thread in ${item.title}`}
        className="h-full w-9 items-center justify-center"
        onPress={() => props.onNewThread(item.project)}
        style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
      >
        <SymbolView
          name="square.and.pencil"
          size={13}
          tintColorClassName="accent-drawer-foreground-muted"
          type="monochrome"
        />
      </Pressable>
    </View>
  );
});

export const FinckeProjectMoreRow = memo(function FinckeProjectMoreRow(props: {
  readonly item: FinckeProjectMoreItem;
  readonly onToggle: (scopeKey: string) => void;
}) {
  const { item } = props;
  return (
    <Pressable
      accessibilityRole="button"
      className="h-[30px] justify-center pl-8"
      onPress={() => props.onToggle(item.scopeKey)}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <Text className="text-xs text-drawer-foreground-muted">
        {item.expanded ? "Show less" : `Show more (${item.hiddenCount})`}
      </Text>
    </Pressable>
  );
});
