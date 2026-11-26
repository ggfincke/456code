// packages/shared/src/fincke-limit-pools.ts
// groups a provider's limit windows into pool rows for the web picker & the native sheet
import type { ServerProviderUsageWindow } from "@t3tools/contracts";

const LABEL_SEPARATOR = " · ";

const WINDOW_PART: Record<ServerProviderUsageWindow["kind"], RegExp | null> = {
  session: /^(session|\d+[- ]?(hour|hr|h))$/i,
  weekly: /^weekly$/i,
  monthly: /^monthly$/i,
  other: null,
};

/** Splits a `pool · window` label by the window's kind, so window-first labels split too. */
function splitLabel(window: ServerProviderUsageWindow) {
  const parts = window.label.split(LABEL_SEPARATOR);
  if (parts.length < 2) return null;
  const pattern = WINDOW_PART[window.kind];
  // labels without a known window word put the window part last
  const index = pattern ? parts.findIndex((part) => pattern.test(part)) : parts.length - 1;
  if (index < 0) return null;
  const pool = parts.filter((_, partIndex) => partIndex !== index).join(LABEL_SEPARATOR);
  return { pool: pool.replace(/\s*\([^)]*\)$/, "") || pool, windowPart: parts[index]! };
}

function shortWindowName(window: ServerProviderUsageWindow, windowPart: string): string {
  switch (window.kind) {
    case "session": {
      const mins = window.windowDurationMins;
      if (!mins) return "5h";
      return mins % 60 === 0 ? `${mins / 60}h` : `${mins}m`;
    }
    case "weekly":
      return "wk";
    case "monthly":
      return "mo";
    case "other":
      return windowPart;
  }
}

/**
 * Pool rows when every window names a pool and there are at least two pools, else null.
 * Cells line up by short window name across rows; `window` is null where a pool lacks one.
 */
export function finckeLimitPools(windows: ReadonlyArray<ServerProviderUsageWindow>) {
  const columns: string[] = [];
  const pools: Array<{ name: string; cells: Array<ServerProviderUsageWindow | undefined> }> = [];
  for (const window of windows) {
    const split = splitLabel(window);
    if (!split) return null;
    const shortName = shortWindowName(window, split.windowPart);
    let pool = pools.find((candidate) => candidate.name === split.pool);
    if (!pool) {
      pool = { name: split.pool, cells: [] };
      pools.push(pool);
    }
    const target = pool;
    let column = columns.findIndex((name, index) => name === shortName && !target.cells[index]);
    if (column < 0) column = columns.push(shortName) - 1;
    target.cells[column] = window;
  }
  if (pools.length < 2) return null;
  return pools.map((pool) => ({
    name: pool.name,
    cells: columns.map((shortName, index) => ({
      column: `${shortName}-${index}`,
      shortName,
      window: pool.cells[index] ?? null,
    })),
  }));
}
