// apps/mobile/src/fincke/ProviderLimitsLine.tsx
// a provider's limit windows under its thread settings header, one line or a row per pool

import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { finckeLimitPools } from "@t3tools/shared/fincke-limit-pools";
import { collectProviderUsageLimits, remainingPercent } from "@t3tools/shared/usageLimits";
import { formatDuration, limitsNotice } from "@t3tools/shared/usageLimitsCopy";
import { Fragment, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../components/ui/AppText";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { environmentServerConfigsAtom } from "../state/server";

// desktop's tones: low at 25% left, critical at 10%
function toneColor(remaining: number, ocean: boolean, theme: Record<string, string>): string {
  if (remaining <= 10) return ocean ? "#f07178" : theme["--color-danger-foreground"]!;
  if (remaining <= 25) return ocean ? "#ffcb6b" : theme["--color-warning-foreground"]!;
  return ocean ? "#80cbc4" : theme["--color-foreground"]!;
}

function LimitWindowText(props: {
  readonly window: ServerProviderUsageWindow;
  readonly name: string;
  readonly now: number;
  readonly color: string;
  readonly numberOfLines?: number;
}) {
  const remaining = remainingPercent(props.window);
  const resetsAt =
    props.window.resetsAt === undefined ? Number.NaN : Date.parse(props.window.resetsAt);
  return (
    <Text
      className="text-xs tabular-nums text-foreground-muted"
      numberOfLines={props.numberOfLines}
      accessibilityLabel={`${props.window.label}: ${remaining}% left${
        Number.isFinite(resetsAt) ? `, resets in ${formatDuration(resetsAt - props.now)}` : ""
      }`}
    >
      {props.name}{" "}
      <Text className="text-xs font-t3-medium" style={{ color: props.color }}>
        {remaining}%
      </Text>
      {Number.isFinite(resetsAt) ? (
        <Text className="text-xs text-foreground-tertiary">
          {" · "}
          {formatDuration(resetsAt - props.now)}
        </Text>
      ) : null}
    </Text>
  );
}

export function ProviderLimitsLine(props: {
  readonly environmentId: EnvironmentId | null;
  readonly instanceId: string;
}) {
  const { themeId, themeVariables } = useAppearancePreferences();
  const configs = useAtomValue(environmentServerConfigsAtom);
  // the sheet mounts on open, so reset countdowns read as of opening, like desktop's picker
  const [now] = useState(() => Date.now());
  const config = props.environmentId ? configs.get(props.environmentId) : undefined;
  if (!config) return null;
  const instanceId = props.instanceId as ProviderInstanceId;
  // reads the snapshot the server already pushes, so the sheet never polls on its own
  const report = collectProviderUsageLimits(
    instanceId,
    config.providers,
    config.usageLimitSources ?? [],
    now,
  );
  // an instance sharing a login can be merged into another's row, so the first readable
  // account stands in when it has none of its own
  const readable = report?.accounts.filter((account) => limitsNotice(account.limits) === null);
  const account = readable?.find((account) => account.instanceId === instanceId) ?? readable?.[0];
  const windows = account?.limits.windows.filter((window) => Number.isFinite(window.usedPercent));
  if (!windows || windows.length === 0) return null;
  const ocean = themeId === "fincke-ocean";
  const colorFor = (window: ServerProviderUsageWindow) =>
    toneColor(remainingPercent(window), ocean, themeVariables);
  const pools = finckeLimitPools(windows);
  if (pools) {
    // column-major so pool names and windows line up without measuring text
    return (
      <View className="mx-4 flex-row gap-x-3 px-1 pb-1.5">
        <View>
          {pools.map((pool) => (
            <Text
              key={pool.name}
              className="text-xs text-foreground-muted"
              numberOfLines={1}
              accessibilityElementsHidden
            >
              {pool.name}
            </Text>
          ))}
        </View>
        {pools[0]!.cells.map(({ column }, index) => (
          <View key={column}>
            {pools.map((pool) => {
              const cell = pool.cells[index]!;
              return cell.window ? (
                <LimitWindowText
                  key={pool.name}
                  window={cell.window}
                  name={cell.shortName}
                  now={now}
                  color={colorFor(cell.window)}
                  numberOfLines={1}
                />
              ) : (
                <Text key={pool.name} className="text-xs" accessibilityElementsHidden>
                  {" "}
                </Text>
              );
            })}
          </View>
        ))}
      </View>
    );
  }

  return (
    <View className="mx-4 flex-row flex-wrap items-center gap-x-2 px-1 pb-1.5">
      {windows.map((window, index) => (
        <Fragment key={window.id}>
          {index > 0 ? (
            <Text className="text-xs text-foreground-tertiary" accessibilityElementsHidden>
              |
            </Text>
          ) : null}
          <LimitWindowText window={window} name={window.label} now={now} color={colorFor(window)} />
        </Fragment>
      ))}
    </View>
  );
}
