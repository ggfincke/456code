import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import * as Linking from "expo-linking";
import { useEffect } from "react";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { environmentCatalog } from "../connection/catalog";
import { environmentPresentations } from "../state/presentation";
import { publishSubscriptionUsage } from "./publishSubscriptionUsage";
import { buildSubscriptionUsageSnapshot } from "./subscriptionUsageSnapshot";
import { createWidgetTheme } from "./widgetTheme";

// Isolate quota changes from the much busier thread/config presentation stream.
const snapshotAtom = Atom.make((get) =>
  buildSubscriptionUsageSnapshot(
    get(environmentPresentations.presentationsWithProvidersAtom),
    Linking.createURL("settings/usage", { queryParams: { tab: "limits" } }),
    6,
  ),
).pipe(Atom.withEquality((a, b) => JSON.stringify(a) === JSON.stringify(b)));

export function SubscriptionUsageCoordinator() {
  const {
    themeMode,
    themeVariablesByAppearance,
    isReady: appearanceReady,
  } = useAppearancePreferences();
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const snapshot = useAtomValue(snapshotAtom);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes subscription usage and theme to the native home screen widget
  useEffect(() => {
    if (!catalog.isReady || !appearanceReady) return;
    void Promise.resolve()
      .then(() =>
        publishSubscriptionUsage({
          ...snapshot,
          theme: createWidgetTheme(themeMode, themeVariablesByAppearance),
        }),
      )
      .catch((error: unknown) => {
        console.warn("Could not update subscription usage widget", error);
      });
  }, [catalog.isReady, appearanceReady, snapshot, themeMode, themeVariablesByAppearance]);
  return null;
}
