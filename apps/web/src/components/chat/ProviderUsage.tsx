// apps/web/src/components/chat/ProviderUsage.tsx
// renders shared provider-account usage details and compact picker summaries
import type {
  ServerProviderAccountUsage,
  ServerProviderAccountUsageWindow,
} from "@t3tools/contracts";
import {
  DEFAULT_PROVIDER_USAGE_DISPLAY_MODE,
  type ProviderUsageDisplayMode,
} from "@t3tools/contracts/settings";
import { ExternalLinkIcon } from "lucide-react";

import { cn } from "~/lib/utils";

const usageTimestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function providerUsagePercentLeft(window: ServerProviderAccountUsageWindow): number {
  return Math.max(0, Math.min(100, 100 - window.usedPercent));
}

export function formatProviderUsagePercentLeft(window: ServerProviderAccountUsageWindow): string {
  return formatProviderUsagePercent(window, "percent-left");
}

export function formatProviderUsagePercent(
  window: ServerProviderAccountUsageWindow,
  displayMode: ProviderUsageDisplayMode,
): string {
  const percentage =
    displayMode === "percent-used" ? window.usedPercent : providerUsagePercentLeft(window);
  const value =
    percentage < 10 ? percentage.toFixed(1).replace(/\.0$/u, "") : String(Math.round(percentage));
  return `${value}% ${displayMode === "percent-used" ? "used" : "left"}`;
}

export function isProviderUsageWindowDanger(window: ServerProviderAccountUsageWindow): boolean {
  return providerUsagePercentLeft(window) <= 10;
}

function usageWindowDurationMinutes(label: string): number | null {
  const normalized = label.trim().toLowerCase();
  if (normalized === "week") return 7 * 24 * 60;
  if (normalized === "month") return 30 * 24 * 60;

  const duration = /^(\d+(?:\.\d+)?)\s*([hdw])$/u.exec(normalized);
  if (!duration) return null;
  const value = Number(duration[1]);
  if (!Number.isFinite(value)) return null;
  switch (duration[2]) {
    case "h":
      return value * 60;
    case "d":
      return value * 24 * 60;
    case "w":
      return value * 7 * 24 * 60;
    default:
      return null;
  }
}

export function selectCompactProviderUsageWindows(
  windows: ReadonlyArray<ServerProviderAccountUsageWindow>,
): ReadonlyArray<ServerProviderAccountUsageWindow> {
  const aggregateWindows = windows.filter((window) => window.scopeLabel === undefined);
  if (aggregateWindows.length <= 2) return aggregateWindows;

  const ranked = aggregateWindows
    .map((window, index) => ({
      window,
      index,
      duration: usageWindowDurationMinutes(window.label),
    }))
    .toSorted((left, right) => {
      if (left.duration === null && right.duration === null) return left.index - right.index;
      if (left.duration === null) return 1;
      if (right.duration === null) return -1;
      return left.duration - right.duration || left.index - right.index;
    });
  const shortest = ranked[0]?.window;
  const longest = ranked.at(-1)?.window;
  if (!shortest) return [];
  if (!longest || longest.id === shortest.id) return [shortest];
  return [shortest, longest];
}

export function shouldShowProviderUsageStrip(input: {
  usage: ServerProviderAccountUsage | undefined;
  selectedInstanceId: string;
  isSearching: boolean;
}): boolean {
  return (
    input.usage !== undefined && input.selectedInstanceId !== "favorites" && !input.isSearching
  );
}

function formatProviderUsageTimestamp(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : usageTimestampFormatter.format(parsed);
}

function safeExternalUsageUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function ExternalUsageLink(props: { dashboardUrl: string; compact?: boolean }) {
  const dashboardUrl = safeExternalUsageUrl(props.dashboardUrl);
  if (!dashboardUrl) {
    return <span className="text-muted-foreground/65">Usage dashboard unavailable</span>;
  }
  return (
    <a
      href={dashboardUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "inline-flex items-center gap-1 font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline",
        "focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        props.compact ? "text-[11px]" : "text-xs",
      )}
    >
      View Cursor usage
      <ExternalLinkIcon className="size-3" aria-hidden="true" />
    </a>
  );
}

function AvailableUsageDetails(props: {
  usage: Extract<ServerProviderAccountUsage, { status: "available" }>;
  displayMode: ProviderUsageDisplayMode;
}) {
  return (
    <div className="flex flex-col gap-3">
      {props.usage.windows.map((window) => {
        const danger = isProviderUsageWindowDanger(window);
        const resetLabel = window.resetsAt
          ? `Resets ${formatProviderUsageTimestamp(window.resetsAt)}`
          : "Reset time unavailable";
        return (
          <div key={window.id} className="flex flex-col gap-1.5">
            <div className="flex items-start justify-between gap-3 text-xs">
              <div className="min-w-0 text-muted-foreground">
                <span className="font-medium text-foreground/90">{window.label}</span>
                {window.scopeLabel ? (
                  <span className="ml-1.5 text-[11px] text-muted-foreground/70">
                    {window.scopeLabel}
                  </span>
                ) : null}
              </div>
              <span
                className={cn(
                  "shrink-0 font-medium tabular-nums",
                  danger ? "text-destructive" : "text-muted-foreground",
                )}
              >
                {formatProviderUsagePercent(window, props.displayMode)}
              </span>
            </div>
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(window.usedPercent)}
              aria-label={`${window.label}${window.scopeLabel ? ` ${window.scopeLabel}` : ""}: ${Math.round(window.usedPercent)}% used, ${formatProviderUsagePercentLeft(window)}`}
            >
              <div
                className={cn(
                  "h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none",
                  danger ? "bg-destructive" : "bg-muted-foreground/60",
                )}
                style={{ width: `${window.usedPercent}%` }}
              />
            </div>
            <div className="text-[10px] leading-4 text-muted-foreground/55">{resetLabel}</div>
          </div>
        );
      })}
      <div className="text-[10px] leading-4 text-muted-foreground/50">
        Updated {formatProviderUsageTimestamp(props.usage.observedAt)}
      </div>
    </div>
  );
}

export function ProviderUsageDetails(props: {
  usage: ServerProviderAccountUsage;
  displayMode?: ProviderUsageDisplayMode;
}) {
  const displayMode = props.displayMode ?? DEFAULT_PROVIDER_USAGE_DISPLAY_MODE;
  switch (props.usage.status) {
    case "available":
      return <AvailableUsageDetails usage={props.usage} displayMode={displayMode} />;
    case "external":
      return (
        <div className="flex flex-col gap-1.5 text-xs text-muted-foreground/70">
          <span>Monthly usage is managed on Cursor&apos;s dashboard.</span>
          <ExternalUsageLink dashboardUrl={props.usage.dashboardUrl} />
        </div>
      );
    case "notApplicable":
    case "unavailable":
      return (
        <div className="flex flex-col gap-1 text-xs leading-5 text-muted-foreground/70">
          <span>{props.usage.message}</span>
          {props.usage.observedAt ? (
            <span className="text-[10px] text-muted-foreground/50">
              Updated {formatProviderUsageTimestamp(props.usage.observedAt)}
            </span>
          ) : null}
        </div>
      );
  }
}

export function ProviderUsageStrip(props: {
  usage: ServerProviderAccountUsage;
  displayMode?: ProviderUsageDisplayMode;
}) {
  const displayMode = props.displayMode ?? DEFAULT_PROVIDER_USAGE_DISPLAY_MODE;
  if (props.usage.status === "available") {
    const windows = selectCompactProviderUsageWindows(props.usage.windows);
    if (windows.length === 0) return null;
    return (
      <div
        className="flex min-h-8 items-center gap-2 overflow-hidden border-b border-border/55 px-4 py-1.5 text-[11px]"
        data-model-picker-usage="available"
        aria-label="Provider plan usage"
      >
        <span className="shrink-0 text-muted-foreground/50">Usage</span>
        <span className="min-w-0 truncate font-medium text-muted-foreground/85">
          {windows.map((window, index) => (
            <span key={window.id}>
              {index > 0 ? <span className="mx-1.5 text-muted-foreground/35">·</span> : null}
              <span>{window.label}</span>
              <span
                className={cn("ml-1", isProviderUsageWindowDanger(window) && "text-destructive")}
              >
                {formatProviderUsagePercent(window, displayMode)}
              </span>
            </span>
          ))}
        </span>
      </div>
    );
  }

  if (props.usage.status === "external") {
    return (
      <div
        className="flex min-h-8 items-center border-b border-border/55 px-4 py-1.5"
        data-model-picker-usage="external"
      >
        <ExternalUsageLink dashboardUrl={props.usage.dashboardUrl} compact />
      </div>
    );
  }

  return (
    <div
      className="flex min-h-8 items-center overflow-hidden border-b border-border/55 px-4 py-1.5 text-[11px] text-muted-foreground/60"
      data-model-picker-usage={props.usage.status}
      title={props.usage.message}
    >
      <span className="truncate">{props.usage.message}</span>
    </div>
  );
}
