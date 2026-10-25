// apps/mobile/src/fincke/SidebarThreadRowContent.tsx
// compact sidebar row bodies: desktop's two-line activity row, one-line settled & project rows

import {
  formatWorkingDurationLabel,
  resolveThreadWorkingStartedAt,
} from "@t3tools/client-runtime/state/models";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ReactNode } from "react";
import { View } from "react-native";

import { SymbolView } from "../components/ui/AppSymbol";
import { AppText as Text } from "../components/ui/AppText";
import { cn } from "../lib/cn";
import type { MobileThemeVariables } from "../lib/mobileTheme";
import { useVisibleSecondClock } from "../features/threads/use-visible-second-clock";
import { SidebarStatusGlyph, sidebarStatusColor, type SidebarStatus } from "./SidebarStatusGlyph";

export type SidebarRowLayout = "activity" | "project";

// fincke.dev's teal, muted & dim; other themes keep their drawer roles
const OCEAN_ACCENT = "#80cbc4";
const OCEAN_MUTED = "#8f93a2";
const OCEAN_DIM = "#4b526d";
const OCEAN_EMPHASIS = "#ffffff";

function WorkingDuration(props: { readonly startedAt: string | null }) {
  const startedAtMs = Date.parse(props.startedAt ?? "");
  const nowMs = useVisibleSecondClock(Number.isFinite(startedAtMs));
  if (!Number.isFinite(startedAtMs)) return null;
  return formatWorkingDurationLabel(nowMs - startedAtMs);
}

// the open thread gets a straight inset bar over the selected wash, like desktop
export function SidebarSelectionBar(props: {
  readonly ocean: boolean;
  readonly theme: MobileThemeVariables;
}) {
  return (
    <View
      pointerEvents="none"
      className="absolute bottom-1.5 left-0 top-1.5 w-0.5 rounded-full"
      style={{ backgroundColor: props.ocean ? OCEAN_ACCENT : props.theme["--color-primary"] }}
    />
  );
}

export function SidebarThreadRowContent(props: {
  readonly layout: SidebarRowLayout;
  readonly thread: EnvironmentThreadShell;
  readonly projectTitle: string | null;
  readonly selected: boolean;
  readonly recede: boolean;
  readonly emphasized: boolean;
  readonly ocean: boolean;
  readonly theme: MobileThemeVariables;
  readonly status: SidebarStatus | null;
  readonly timeLabel: string;
  readonly pinned: boolean;
  // desktop's one-line settled row, led by the project icon
  readonly slim?: boolean;
  readonly projectIcon?: ReactNode;
  // ahead of the project name on line two, e.g. the machine of a project-less thread
  readonly metaLeading?: ReactNode;
  // replaces the status glyph, e.g. the dismissable Woke badge
  readonly statusSlot?: ReactNode;
  readonly leading?: ReactNode;
  readonly trailing?: ReactNode;
  readonly footer?: ReactNode;
}) {
  const { ocean, theme, status } = props;
  const titleClassName = props.selected
    ? "text-thread-selected-foreground"
    : props.recede
      ? "text-drawer-foreground-muted"
      : "text-drawer-foreground";
  const titleColor = ocean
    ? props.selected
      ? OCEAN_ACCENT
      : props.emphasized && !props.recede
        ? OCEAN_EMPHASIS
        : undefined
    : undefined;
  const pin = props.pinned ? (
    <SymbolView
      name="pin"
      size={10}
      tintColorClassName="accent-drawer-foreground-muted"
      type="monochrome"
    />
  ) : null;
  const statusGlyph =
    props.statusSlot ??
    (status ? (
      <SidebarStatusGlyph status={status} color={sidebarStatusColor(status.tone, ocean, theme)} />
    ) : null);
  const title = (
    <Text
      className={cn("min-w-0 flex-1 text-[14px]", titleClassName)}
      numberOfLines={1}
      style={titleColor ? { color: titleColor } : undefined}
    >
      {props.thread.title}
    </Text>
  );

  if (props.layout === "activity" && props.slim) {
    return (
      <View className="relative">
        {props.selected ? <SidebarSelectionBar ocean={ocean} theme={theme} /> : null}
        <View className="h-9 flex-row items-center gap-2.5 px-2.5">
          {props.projectIcon ? (
            <View style={{ opacity: props.selected ? 1 : 0.4 }}>{props.projectIcon}</View>
          ) : null}
          {title}
          {pin}
          {props.leading}
          {props.trailing}
          {props.statusSlot ?? (
            <Text className="min-w-8 text-right text-xs tabular-nums text-drawer-foreground-muted">
              {props.timeLabel}
            </Text>
          )}
        </View>
        {props.footer ? <View className="pb-1.5 pl-[42px] pr-2.5">{props.footer}</View> : null}
      </View>
    );
  }

  if (props.layout === "project") {
    return (
      <View className="relative">
        {props.selected ? <SidebarSelectionBar ocean={ocean} theme={theme} /> : null}
        <View className="h-[34px] flex-row items-center gap-1.5 pl-8 pr-2.5">
          {pin}
          {title}
          {props.leading}
          {statusGlyph ?? (
            <Text className="text-[11px] tabular-nums text-drawer-foreground-muted">
              {props.timeLabel}
            </Text>
          )}
        </View>
        {props.footer ? <View className="pb-1.5 pl-8 pr-2.5">{props.footer}</View> : null}
      </View>
    );
  }

  // line one carries the glyph instead of a status label, so the working
  // duration (or the usual relative time) moves to line two
  const timeText =
    status?.tone === "working" ? (
      <WorkingDuration startedAt={resolveThreadWorkingStartedAt(props.thread)} />
    ) : status?.tone === "waiting" ? (
      <WorkingDuration startedAt={props.thread.latestRun?.completedAt ?? null} />
    ) : (
      props.timeLabel
    );
  return (
    <View className="relative px-2.5 py-1.5">
      {props.selected ? <SidebarSelectionBar ocean={ocean} theme={theme} /> : null}
      <View className="h-5 flex-row items-center gap-1.5">
        {pin}
        {title}
        {props.leading}
        {statusGlyph}
      </View>
      <View className="mt-0.5 h-4 flex-row items-center gap-1.5">
        {props.metaLeading}
        <Text
          className="min-w-0 flex-1 text-xs tabular-nums text-drawer-foreground-muted"
          numberOfLines={1}
          style={ocean ? { color: OCEAN_DIM } : undefined}
        >
          {props.projectTitle ? (
            <Text
              className="text-xs text-drawer-foreground-muted"
              style={ocean ? { color: OCEAN_MUTED } : undefined}
            >
              {props.projectTitle}
            </Text>
          ) : null}
          {props.projectTitle && timeText ? " · " : null}
          {timeText}
        </Text>
        {props.trailing}
      </View>
      {props.footer ? <View className="mt-1">{props.footer}</View> : null}
    </View>
  );
}

// unsent drafts & queued tasks use the same compact shapes, marked by a pencil or clock
export function SidebarPendingRowContent(props: {
  readonly layout: SidebarRowLayout;
  readonly title: string;
  readonly projectTitle: string | null;
  readonly draft: boolean;
  readonly selected: boolean;
  readonly ocean: boolean;
  readonly theme: MobileThemeVariables;
}) {
  const marker = (
    <SymbolView
      name={props.draft ? "square.and.pencil" : "clock"}
      size={11}
      tintColorClassName={
        props.draft ? "accent-adaptive-amber-700-300" : "accent-drawer-foreground-muted"
      }
      type="monochrome"
    />
  );
  const title = (
    <Text
      className={cn(
        "min-w-0 flex-1 text-[14px]",
        props.selected ? "text-thread-selected-foreground" : "text-drawer-foreground",
      )}
      numberOfLines={1}
      style={props.ocean && props.selected ? { color: OCEAN_ACCENT } : undefined}
    >
      {props.title}
    </Text>
  );
  const stateLabel = props.draft ? "Draft" : "Sends on reconnect";

  if (props.layout === "project") {
    return (
      <View className="relative">
        {props.selected ? <SidebarSelectionBar ocean={props.ocean} theme={props.theme} /> : null}
        <View className="h-[34px] flex-row items-center gap-1.5 pl-8 pr-2.5">
          {title}
          {marker}
        </View>
      </View>
    );
  }
  return (
    <View className="relative px-2.5 py-1.5">
      {props.selected ? <SidebarSelectionBar ocean={props.ocean} theme={props.theme} /> : null}
      <View className="h-5 flex-row items-center gap-1.5">
        {title}
        {marker}
      </View>
      <Text className="mt-0.5 h-4 text-xs text-drawer-foreground-muted" numberOfLines={1}>
        {props.projectTitle ? (
          <Text
            className="text-xs text-drawer-foreground-muted"
            style={props.ocean ? { color: OCEAN_MUTED } : undefined}
          >
            {props.projectTitle}
          </Text>
        ) : null}
        {props.projectTitle ? " · " : null}
        {stateLabel}
      </Text>
    </View>
  );
}
