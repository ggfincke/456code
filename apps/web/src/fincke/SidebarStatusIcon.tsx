// apps/web/src/fincke/SidebarStatusIcon.tsx
// static status glyphs for the compact sidebar rows
import type { ThreadStatusPill } from "../components/Sidebar.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/utils";

export type SidebarStatusKind = "working" | "attention" | "failed" | "unread" | "plan";

export function sidebarStatusKindForPill(label: ThreadStatusPill["label"]): SidebarStatusKind {
  switch (label) {
    case "Working":
    case "Connecting":
    case "Waiting":
      return "working";
    case "Pending Approval":
    case "Awaiting Input":
      return "attention";
    case "Failed":
      return "failed";
    case "Plan Ready":
      return "plan";
    case "Completed":
      return "unread";
  }
}

// glyphs draw in currentColor so the caller's status color class (theme-aware)
// decides the hue. the working ring is a fixed arc on purpose: a spinning ring
// per running thread repaints the sidebar every frame
function StatusGlyph({ kind }: { kind: SidebarStatusKind }) {
  switch (kind) {
    case "working":
      return (
        <svg viewBox="0 0 16 16" fill="none" aria-hidden className="size-[13px]">
          <circle
            cx="8"
            cy="8"
            r="5.5"
            stroke="currentColor"
            strokeOpacity="0.25"
            strokeWidth="2"
          />
          <path
            d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      );
    case "attention":
      return (
        <svg viewBox="0 0 16 16" fill="none" aria-hidden className="size-[13px]">
          <circle cx="8" cy="8" r="6" fill="currentColor" fillOpacity="0.15" />
          <path d="M8 4.8v3.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="8" cy="11" r="1" fill="currentColor" />
        </svg>
      );
    case "failed":
      return (
        <svg viewBox="0 0 16 16" fill="none" aria-hidden className="size-[13px]">
          <circle cx="8" cy="8" r="6" fill="currentColor" fillOpacity="0.15" />
          <path
            d="m5.8 5.8 4.4 4.4m0-4.4-4.4 4.4"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
          />
        </svg>
      );
    case "unread":
    case "plan":
      return <span aria-hidden className="size-1.5 rounded-full bg-current" />;
  }
}

const STATUS_SLOT_CLASS = "inline-flex size-3.5 shrink-0 items-center justify-center";

// for rows that already explain status in their own hover card
export function SidebarStatusGlyph({
  kind,
  label,
  colorClass,
}: {
  kind: SidebarStatusKind;
  label: string;
  colorClass: string;
}) {
  return (
    <span role="img" aria-label={label} className={cn(STATUS_SLOT_CLASS, colorClass)}>
      <StatusGlyph kind={kind} />
    </span>
  );
}

export function SidebarStatusIcon({
  kind,
  label,
  colorClass,
}: {
  kind: SidebarStatusKind;
  label: string;
  colorClass: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span role="img" aria-label={label} className={cn(STATUS_SLOT_CLASS, colorClass)} />
        }
      >
        <StatusGlyph kind={kind} />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
