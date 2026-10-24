// apps/mobile/src/features/threads/ComposerCommandPopover.tsx
// groups native command browsing while preserving ranked search results

import {
  resolveProviderSkillSourceKind,
  type ProviderSkillSourceKind,
} from "@t3tools/client-runtime/providerSkills";
import type {
  PullRequestContextMetadata,
  ScopedThreadRef,
  ServerProviderSkill,
  ServerProviderSlashCommand,
} from "@t3tools/contracts";
import type { ComposerTriggerKind } from "@t3tools/shared/composerTrigger";
import { memo } from "react";
import { Pressable, ScrollView, StyleSheet, View, type ViewStyle } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { GlassSurface } from "../../components/ui/GlassSurface";
import { PierreEntryIcon } from "../../components/PierreEntryIcon";
import { pullRequestStatus } from "../pull-requests/pullRequestStatus";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
export type ComposerCommandItem =
  | {
      readonly id: string;
      readonly type: "pull-request";
      readonly pullRequest: PullRequestContextMetadata;
      readonly label: string;
      readonly description: string;
    }
  | {
      readonly id: string;
      readonly type: "path";
      readonly path: string;
      readonly kind: "file" | "directory";
      readonly label: string;
      readonly description: string;
    }
  | {
      readonly id: string;
      readonly type: "thread";
      readonly thread: ScopedThreadRef;
      readonly label: string;
      readonly description: string;
    }
  | {
      readonly id: string;
      readonly type: "slash-command";
      readonly command: string;
      readonly label: string;
      readonly description: string;
    }
  | {
      readonly id: string;
      readonly type: "provider-slash-command";
      readonly command: ServerProviderSlashCommand;
      readonly label: string;
      readonly description: string;
    }
  | {
      readonly id: string;
      readonly type: "skill";
      readonly skill: ServerProviderSkill;
      readonly label: string;
      readonly description: string;
    };

interface ComposerCommandPopoverProps {
  readonly items: ReadonlyArray<ComposerCommandItem>;
  readonly triggerKind: ComposerTriggerKind | null;
  readonly query: string;
  readonly isLoading: boolean;
  readonly error?: string | null;
  readonly onSelect: (item: ComposerCommandItem) => void;
}

function PopoverSurface(props: { readonly children: React.ReactNode; readonly style?: ViewStyle }) {
  const baseStyle: ViewStyle = {
    borderRadius: 16,
    overflow: "hidden",
    ...props.style,
  };

  return (
    <GlassSurface
      glassEffectStyle="clear"
      tintColorClassName="accent-glass-surface"
      style={baseStyle}
    >
      {props.children}
    </GlassSurface>
  );
}

const SKILL_SOURCE_SYMBOL_BY_KIND: Record<ProviderSkillSourceKind, AppSymbolName> = {
  app: "square.grid.2x2",
  repo: "folder",
  project: "folder",
  personal: "person.crop.circle",
  system: "gearshape",
  other: "cube",
};

function itemIcon(item: ComposerCommandItem): AppSymbolName | null {
  switch (item.type) {
    case "pull-request":
      return pullRequestStatus(item.pullRequest).icon;
    case "slash-command":
    case "provider-slash-command":
      return "terminal";
    case "skill":
      return SKILL_SOURCE_SYMBOL_BY_KIND[resolveProviderSkillSourceKind(item.skill)];
    case "path":
      return null;
    case "thread":
      return "text.bubble";
  }
}

function groupLabel(triggerKind: ComposerTriggerKind | null): string | null {
  switch (triggerKind) {
    case "pull-request":
      return "Pull requests";
    case "slash-command":
      return "Commands";
    case "skill":
      return "Skills";
    case "path":
      return "Files";
    default:
      return null;
  }
}

function emptyText(triggerKind: ComposerTriggerKind | null, isLoading: boolean): string {
  if (isLoading) {
    return triggerKind === "path" ? "Searching files…" : "Loading…";
  }
  switch (triggerKind) {
    case "pull-request":
      return "No matching pull requests.";
    case "path":
      return "No matching files or folders.";
    case "skill":
      return "No skills found.";
    case "slash-command":
      return "No matching commands.";
    default:
      return "No results.";
  }
}

type SlashSection = "Commands" | "Skills" | "Plugins";

function slashSection(item: ComposerCommandItem): SlashSection {
  const name =
    item.type === "provider-slash-command"
      ? item.command.name
      : item.type === "skill"
        ? item.skill.name
        : item.type === "slash-command"
          ? item.command
          : "";
  if (/^[^\s:]+:\S/u.test(name)) return "Plugins";
  if (item.type === "skill") {
    return resolveProviderSkillSourceKind(item.skill) === "app" ? "Plugins" : "Skills";
  }
  return "Commands";
}

const OCEAN_SECTION_COLORS: Record<SlashSection, string> = {
  Commands: "#c792ea",
  Skills: "#82aaff",
  Plugins: "#ffcb6b",
};

const CommandRow = memo(function CommandRow(props: {
  readonly item: ComposerCommandItem;
  readonly onPress: () => void;
  readonly isLast: boolean;
  readonly isSlashSkill: boolean;
  readonly color?: string;
}) {
  const iconName = itemIcon(props.item);

  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onPress}
      className="min-h-11 flex-row items-center gap-2.5 border-border px-3.5 py-2.5 active:opacity-60"
      style={{ borderBottomWidth: props.isLast ? 0 : StyleSheet.hairlineWidth }}
    >
      {props.item.type === "path" ? (
        <PierreEntryIcon path={props.item.path} kind={props.item.kind} size={16} />
      ) : iconName ? (
        <SymbolView
          name={iconName}
          size={14}
          tintColor={props.color}
          tintColorClassName={
            props.color
              ? undefined
              : props.item.type === "pull-request"
                ? pullRequestStatus(props.item.pullRequest).tint
                : "accent-icon-subtle"
          }
          type="monochrome"
        />
      ) : null}
      <Text
        className="min-w-0 shrink text-base font-t3-medium text-foreground"
        style={{ color: props.color, maxWidth: props.item.description ? "65%" : "100%" }}
        numberOfLines={1}
      >
        {props.isSlashSkill && props.item.type === "skill" ? (
          <>
            <Text className="text-foreground-muted">skill:</Text>
            {props.item.skill.name}
          </>
        ) : (
          props.item.label
        )}
      </Text>
      {props.item.description ? (
        <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
          {props.item.description}
        </Text>
      ) : null}
    </Pressable>
  );
});

export const ComposerCommandPopover = memo(function ComposerCommandPopover(
  props: ComposerCommandPopoverProps,
) {
  const label = groupLabel(props.triggerKind);
  const { themeId } = useAppearancePreferences();
  const slash = props.triggerKind === "slash-command";
  const browse = slash && props.query.trim().replace(/^\/+/, "") === "";
  const sections: ReadonlyArray<{
    readonly label: string | null;
    readonly items: ReadonlyArray<ComposerCommandItem>;
  }> = browse
    ? (["Commands", "Skills", "Plugins"] as const)
        .map((section) => ({
          label: section,
          items: props.items.filter((item) => slashSection(item) === section),
        }))
        .filter((section) => section.items.length > 0)
    : [{ label: null, items: props.items }];

  return (
    <PopoverSurface>
      {label && !browse ? (
        <View className="px-3.5 pt-2.5 pb-1">
          <Text className="text-3xs font-t3-bold tracking-[0.8px] uppercase text-foreground-muted">
            {label}
          </Text>
        </View>
      ) : null}
      {props.items.length > 0 ? (
        <ScrollView
          className="max-h-[180px]"
          keyboardShouldPersistTaps="always"
          showsVerticalScrollIndicator={false}
        >
          {sections.map((section) => (
            <View key={section.label ?? "results"}>
              {section.label ? (
                <Text
                  accessibilityRole="header"
                  className="px-3.5 pb-1 pt-2.5 text-3xs font-t3-bold uppercase tracking-[0.8px] text-foreground-muted"
                >
                  {section.label}
                </Text>
              ) : null}
              {section.items.map((item, index) => (
                <CommandRow
                  key={item.id}
                  item={item}
                  onPress={() => props.onSelect(item)}
                  isLast={index === section.items.length - 1}
                  isSlashSkill={props.triggerKind === "slash-command" && item.type === "skill"}
                  color={
                    slash && themeId === "fincke-ocean"
                      ? OCEAN_SECTION_COLORS[slashSection(item)]
                      : undefined
                  }
                />
              ))}
            </View>
          ))}
        </ScrollView>
      ) : (
        <View className="px-3.5 py-2.5">
          <Text className="text-xs text-foreground-tertiary">
            {props.error ?? emptyText(props.triggerKind, props.isLoading)}
          </Text>
        </View>
      )}
    </PopoverSurface>
  );
});
