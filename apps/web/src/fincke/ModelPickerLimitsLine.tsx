// apps/web/src/fincke/ModelPickerLimitsLine.tsx
// one line of the shown provider's limit windows under the model picker search
import type { EnvironmentId } from "@t3tools/contracts";
import { remainingPercent } from "@t3tools/shared/usageLimits";
import { Fragment, useState } from "react";

import { ProviderInstanceIcon } from "../components/chat/ProviderInstanceIcon";
import type { ProviderInstanceEntry } from "../providerInstances";
import { compactResetsIn, limitToneColor, useProviderLimitWindows } from "./providerLimits";

const DIM_TEXT = { color: "var(--fincke-dim, var(--muted-foreground))" };

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
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-0.5 px-3 pt-1.5 pb-1 text-xs text-muted-foreground tabular-nums">
      <ProviderInstanceIcon
        driverKind={entry.driverKind}
        displayName={entry.displayName}
        accentColor={entry.accentColor}
        acpRegistryAgentId={entry.acpRegistryAgentId}
        acpRegistryIconUrl={entry.acpRegistryIconUrl}
        className="size-3.5"
        iconClassName="size-3.5"
      />
      {windows.map((window, index) => {
        const remaining = remainingPercent(window);
        const resetsIn = compactResetsIn(window, now);
        return (
          <Fragment key={window.id}>
            {index > 0 ? (
              <span aria-hidden style={DIM_TEXT}>
                |
              </span>
            ) : null}
            <span className="inline-flex items-center gap-1 whitespace-nowrap">
              <span>{window.label}</span>
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
          </Fragment>
        );
      })}
    </div>
  );
}
