// apps/mobile/src/fincke/ProviderLimitsLine.tsx
// one inline line of a provider's limit windows under its thread settings header

import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import {
  collectProviderUsageLimits,
  formatDuration,
  limitsNotice,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
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

  return (
    <View className="mx-4 flex-row flex-wrap items-center gap-x-2 px-1 pb-1.5">
      {windows.map((window, index) => {
        const remaining = remainingPercent(window);
        const resetsAt = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
        return (
          <Fragment key={window.id}>
            {index > 0 ? (
              <Text className="text-xs text-foreground-tertiary" accessibilityElementsHidden>
                |
              </Text>
            ) : null}
            <Text
              className="text-xs tabular-nums text-foreground-muted"
              accessibilityLabel={`${window.label}: ${remaining}% left${
                Number.isFinite(resetsAt) ? `, resets in ${formatDuration(resetsAt - now)}` : ""
              }`}
            >
              {window.label}{" "}
              <Text
                className="text-xs font-t3-medium"
                style={{ color: toneColor(remaining, ocean, themeVariables) }}
              >
                {remaining}%
              </Text>
              {Number.isFinite(resetsAt) ? (
                <Text className="text-xs text-foreground-tertiary">
                  {" · "}
                  {formatDuration(resetsAt - now)}
                </Text>
              ) : null}
            </Text>
          </Fragment>
        );
      })}
    </View>
  );
}
