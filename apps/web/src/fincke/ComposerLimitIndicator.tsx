// apps/web/src/fincke/ComposerLimitIndicator.tsx
// a static ring beside the composer model chip, shown only while the provider's tightest limit runs low
import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { formatResetsIn, remainingPercent } from "@t3tools/shared/usageLimits";
import { useState } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { usePrimarySettings } from "../hooks/useSettings";
import type { ProviderInstanceEntry } from "../providerInstances";
import { formatUpcomingTimestamp } from "../timestampFormat";
import {
  isLimitLow,
  limitToneColor,
  tightestWindow,
  useProviderLimitWindows,
} from "./providerLimits";

const RING_RADIUS = 5;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

export function ComposerLimitIndicator({
  environmentId,
  instanceId,
  instanceEntries,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
}) {
  // the clock only stamps the report, so which window is tightest never waits on a tick
  const [now] = useState(() => Date.now());
  const window = tightestWindow(
    useProviderLimitWindows({ environmentId, instanceId, instanceEntries, now }),
  );
  if (window === null) return null;
  const remaining = remainingPercent(window);
  if (!isLimitLow(remaining)) return null;
  const color = limitToneColor(remaining);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={`${window.label}: ${remaining}% left`}
            data-composer-limit-indicator
            className="inline-flex shrink-0 cursor-default items-center gap-1 text-xs font-medium tabular-nums"
            style={{ color }}
          />
        }
      >
        <svg aria-hidden viewBox="0 0 14 14" className="size-3.5 -rotate-90">
          <circle
            cx="7"
            cy="7"
            r={RING_RADIUS}
            fill="none"
            stroke="currentColor"
            strokeOpacity={0.2}
            strokeWidth="2"
          />
          {remaining > 0 ? (
            <circle
              cx="7"
              cy="7"
              r={RING_RADIUS}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeDasharray={`${(RING_LENGTH * remaining) / 100} ${RING_LENGTH}`}
            />
          ) : null}
        </svg>
        {remaining}%
      </TooltipTrigger>
      <TooltipPopup side="top">
        <LimitTooltipBody window={window} remaining={remaining} />
      </TooltipPopup>
    </Tooltip>
  );
}

// the popup mounts on open, so its countdown reads the clock at hover time
function LimitTooltipBody({
  window,
  remaining,
}: {
  readonly window: ServerProviderUsageWindow;
  readonly remaining: number;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const [now] = useState(() => Date.now());
  const resetsIn = formatResetsIn(window, now);
  const resetsAt = window.resetsAt
    ? formatUpcomingTimestamp(window.resetsAt, timestampFormat, now)
    : null;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-foreground">
        {window.label}: {remaining}% left
      </span>
      {resetsAt ? (
        <span className="text-muted-foreground">
          Resets {resetsAt}
          {resetsIn ? ` · ${resetsIn}` : ""}
        </span>
      ) : null}
    </div>
  );
}
