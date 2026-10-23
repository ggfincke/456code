// apps/web/src/fincke/providerLimits.ts
// reads one provider instance's limit windows & picks ocean colors by how much is left
import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerProviderUsageWindow,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import {
  collectProviderUsageLimits,
  formatDuration,
  limitsNotice,
  remainingPercent,
} from "@t3tools/shared/usageLimits";

import type { ProviderInstanceEntry } from "../providerInstances";
import { useEnvironment } from "../state/environments";

const EMPTY_SOURCES: UsageLimitSourceSnapshots = [];

type LimitTone = "ok" | "low" | "critical";

function limitTone(remaining: number): LimitTone {
  if (remaining <= 10) return "critical";
  return remaining <= 25 ? "low" : "ok";
}

export function isLimitLow(remaining: number): boolean {
  return limitTone(remaining) !== "ok";
}

const TONE_ACCENT: Record<LimitTone, string> = { ok: "teal", low: "yellow", critical: "red" };

// new ui outside fincke ocean falls back to the theme's own status tokens
const TONE_FALLBACK: Record<LimitTone, string> = {
  ok: "var(--foreground)",
  low: "var(--warning)",
  critical: "var(--destructive)",
};

export function limitToneColor(remaining: number): string {
  const tone = limitTone(remaining);
  return `var(--fincke-${TONE_ACCENT[tone]}, ${TONE_FALLBACK[tone]})`;
}

// usage page bars keep their provider color unless fincke ocean defines the accents
export function limitBarColor(remaining: number, brandColor: string): string {
  return `var(--fincke-${TONE_ACCENT[limitTone(remaining)]}, ${brandColor})`;
}

export function compactResetsIn(window: ServerProviderUsageWindow, now: number): string | null {
  const at = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
  return Number.isFinite(at) ? formatDuration(at - now) : null;
}

/**
 * The instance's windows from the snapshot /usage-limits already reads, so the picker and composer
 * never poll on their own. An instance sharing a login with another can be merged into that
 * instance's row, so the first readable account stands in when it has no row of its own.
 */
export function useProviderLimitWindows(input: {
  readonly environmentId: EnvironmentId | null;
  readonly instanceId: ProviderInstanceId;
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly now: number;
}): ReadonlyArray<ServerProviderUsageWindow> {
  const sources = useEnvironment(input.environmentId)?.serverConfig?.usageLimitSources;
  const report = collectProviderUsageLimits(
    input.instanceId,
    input.instanceEntries.map((entry) => entry.snapshot),
    sources ?? EMPTY_SOURCES,
    input.now,
  );
  const readable = report?.accounts.filter((account) => limitsNotice(account.limits) === null);
  const account =
    readable?.find((account) => account.instanceId === input.instanceId) ?? readable?.[0];
  return account?.limits.windows ?? [];
}

export function tightestWindow(
  windows: ReadonlyArray<ServerProviderUsageWindow>,
): ServerProviderUsageWindow | null {
  let tightest: ServerProviderUsageWindow | null = null;
  for (const window of windows) {
    if (tightest === null || remainingPercent(window) < remainingPercent(tightest)) {
      tightest = window;
    }
  }
  return tightest;
}
