// apps/web/src/fincke/ModelPickerLimitsLine.tsx
// the shown provider's limit windows under the model picker search, one line or a row per pool
import type { EnvironmentId, ServerProviderUsageWindow } from "@t3tools/contracts";
import { finckeLimitPools } from "@t3tools/shared/fincke-limit-pools";
import { remainingPercent } from "@t3tools/shared/usageLimits";
import { Fragment, useState } from "react";

import { ProviderInstanceIcon } from "../components/chat/ProviderInstanceIcon";
import type { ProviderInstanceEntry } from "../providerInstances";
import { compactResetsIn, limitToneColor, useProviderLimitWindows } from "./providerLimits";

const DIM_TEXT = { color: "var(--fincke-dim, var(--muted-foreground))" };

function LimitWindowItem({
  window,
  shortName,
  now,
}: {
  readonly window: ServerProviderUsageWindow;
  readonly shortName?: string;
  readonly now: number;
}) {
  const remaining = remainingPercent(window);
  const resetsIn = compactResetsIn(window, now);
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      {shortName === undefined ? (
        <span>{window.label}</span>
      ) : (
        <>
          <span className="sr-only">{window.label}</span>
          <span aria-hidden>{shortName}</span>
        </>
      )}
      <span className="font-medium" style={{ color: limitToneColor(remaining) }}>
        {remaining}%<span className="sr-only"> left</span>
      </span>
      {resetsIn ? (
        <span style={DIM_TEXT}>
          <span aria-hidden>· </span>
          <span className="sr-only">resets in </span>
          {resetsIn}
        </span>
      ) : null}
    </span>
  );
}

export function ModelPickerLimitsLine({
  environmentId,
  entry,
  instanceEntries,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly entry: ProviderInstanceEntry;
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
}) {
  // the picker mounts on open, so the reset countdowns read as of opening
  const [now] = useState(() => Date.now());
  const windows = useProviderLimitWindows({
    environmentId,
    instanceId: entry.instanceId,
    instanceEntries,
    now,
  });
  if (windows.length === 0) return null;
  const icon = (
    <ProviderInstanceIcon
      driverKind={entry.driverKind}
      displayName={entry.displayName}
      accentColor={entry.accentColor}
      acpRegistryAgentId={entry.acpRegistryAgentId}
      acpRegistryIconUrl={entry.acpRegistryIconUrl}
      className="size-3.5"
      iconClassName="size-3.5"
    />
  );
  const pools = finckeLimitPools(windows);
  if (pools) {
    return (
      <div
        className="grid w-fit shrink-0 items-center gap-x-3 gap-y-0.5 px-3 pt-1.5 pb-1 text-xs text-muted-foreground tabular-nums"
        style={{ gridTemplateColumns: `repeat(${pools[0]!.cells.length + 2}, auto)` }}
      >
        {pools.map((pool, row) => (
          <Fragment key={pool.name}>
            {row === 0 ? icon : <span />}
            <span aria-hidden className="whitespace-nowrap">
              {pool.name}
            </span>
            {pool.cells.map((cell) =>
              cell.window ? (
                <LimitWindowItem
                  key={cell.column}
                  window={cell.window}
                  shortName={cell.shortName}
                  now={now}
                />
              ) : (
                <span key={cell.column} />
              ),
            )}
          </Fragment>
        ))}
      </div>
    );
  }
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-0.5 px-3 pt-1.5 pb-1 text-xs text-muted-foreground tabular-nums">
      {icon}
      {windows.map((window, index) => (
        <Fragment key={window.id}>
          {index > 0 ? (
            <span aria-hidden style={DIM_TEXT}>
              |
            </span>
          ) : null}
          <LimitWindowItem window={window} now={now} />
        </Fragment>
      ))}
    </div>
  );
}
