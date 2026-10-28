// apps/mobile/src/fincke/SidebarStatusGlyph.tsx
// static status glyphs for the compact sidebar rows, matching desktop's

import { View } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";

import type { MobileThemeVariables } from "../lib/mobileTheme";
import type { ThreadListV2Status } from "../features/threads/threadListV2";

export type SidebarStatusTone = Exclude<ThreadListV2Status, "ready"> | "done";
type SidebarGlyphKind = "working" | "attention" | "failed" | "dot";

export interface SidebarStatus {
  readonly tone: SidebarStatusTone;
  readonly label: string;
}

const STATUS_LABEL: Record<SidebarStatusTone, string> = {
  working: "Working",
  waiting: "Waiting",
  approval: "Approval",
  input: "Input",
  limited: "Limited",
  failed: "Failed",
  done: "Done",
};

// collapsed project rows show their most urgent thread, like desktop's project status
const STATUS_PRIORITY: Record<SidebarStatusTone, number> = {
  approval: 6,
  input: 5,
  failed: 4,
  limited: 4,
  working: 3,
  waiting: 2,
  done: 1,
};

export function resolveSidebarStatus(
  status: ThreadListV2Status,
  unread: boolean,
  goalActive = false,
): SidebarStatus | null {
  if (status === "ready") return unread ? { tone: "done", label: STATUS_LABEL.done } : null;
  return {
    tone: status,
    label: status === "working" && goalActive ? "Goal" : STATUS_LABEL[status],
  };
}

export function mostUrgentSidebarStatus(
  statuses: ReadonlyArray<SidebarStatus | null>,
): SidebarStatus | null {
  let urgent: SidebarStatus | null = null;
  for (const status of statuses) {
    if (status && (urgent === null || STATUS_PRIORITY[status.tone] > STATUS_PRIORITY[urgent.tone]))
      urgent = status;
  }
  return urgent;
}

// fincke ocean takes the material palette; other themes keep their own role colors
const OCEAN_STATUS_COLOR: Record<SidebarStatusTone, string> = {
  working: "#80cbc4",
  waiting: "#80cbc4",
  approval: "#ffcb6b",
  input: "#ffcb6b",
  limited: "#f78c6c",
  failed: "#f07178",
  done: "#82aaff",
};

export function sidebarStatusColor(
  tone: SidebarStatusTone,
  ocean: boolean,
  theme: MobileThemeVariables,
): string {
  if (ocean) return OCEAN_STATUS_COLOR[tone];
  switch (tone) {
    case "working":
      return theme["--color-primary"];
    case "waiting":
      return theme["--color-foreground-muted"];
    case "approval":
    case "input":
    case "limited":
      return theme["--color-warning-foreground"];
    case "failed":
      return theme["--color-danger-foreground"];
    case "done":
      return theme["--color-update-foreground"];
  }
}

function glyphKind(tone: SidebarStatusTone): SidebarGlyphKind {
  switch (tone) {
    case "working":
    case "waiting":
      return "working";
    case "approval":
    case "input":
      return "attention";
    case "limited":
    case "failed":
      return "failed";
    case "done":
      return "dot";
  }
}

// the working ring is a fixed arc on purpose: a spinning ring per running
// thread would repaint the sidebar every frame
export function SidebarStatusGlyph(props: {
  readonly status: SidebarStatus;
  readonly color: string;
}) {
  const kind = glyphKind(props.status.tone);
  return (
    <View
      accessible
      accessibilityLabel={props.status.label}
      className="size-3.5 items-center justify-center"
    >
      {kind === "dot" ? (
        <View className="size-1.5 rounded-full" style={{ backgroundColor: props.color }} />
      ) : (
        <Svg width={13} height={13} viewBox="0 0 16 16" fill="none">
          {kind === "working" ? (
            <>
              <Circle
                cx={8}
                cy={8}
                r={5.5}
                stroke={props.color}
                strokeOpacity={0.25}
                strokeWidth={2}
              />
              <Path
                d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5"
                stroke={props.color}
                strokeWidth={2}
                strokeLinecap="round"
              />
            </>
          ) : kind === "attention" ? (
            <>
              <Circle cx={8} cy={8} r={6} fill={props.color} fillOpacity={0.15} />
              <Path d="M8 4.8v3.6" stroke={props.color} strokeWidth={1.8} strokeLinecap="round" />
              <Circle cx={8} cy={11} r={1} fill={props.color} />
            </>
          ) : (
            <>
              <Circle cx={8} cy={8} r={6} fill={props.color} fillOpacity={0.15} />
              <Path
                d="m5.8 5.8 4.4 4.4m0-4.4-4.4 4.4"
                stroke={props.color}
                strokeWidth={1.7}
                strokeLinecap="round"
              />
            </>
          )}
        </Svg>
      )}
    </View>
  );
}
