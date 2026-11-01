// apps/mobile/src/widgets/DenseWidgetCoordinator.tsx
// publishes foreground activity snapshots without keeping a client alive

import { useAtomValue } from "@effect/atom-react";
import { requireOptionalNativeModule } from "expo";
import * as Linking from "expo-linking";
import { Atom } from "effect/reactivity";
import { useEffect, useRef } from "react";
import { Platform } from "react-native";

import { environmentCatalog } from "../connection/catalog";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { isAppActive, subscribeAppState } from "../lib/appState";
import { environmentPresentations } from "../state/presentation";
import { environmentShell } from "../state/shell";
import {
  environmentThreadDetails,
  environmentThreadShells,
  threadEnvironment,
} from "../state/threads";
import { buildDenseWidgetData, denseAttentionThreads } from "./denseWidgetSnapshot";
import { publishDenseWidget } from "./publishDenseWidget";
import { createWidgetTheme } from "./widgetTheme";

const hostsAtom = Atom.make((get) => {
  const presentations = get(environmentPresentations.presentationsWithProvidersAtom);
  return [...presentations]
    .filter(([, presentation]) => presentation.entry.enabled)
    .map(([id, presentation]) => ({
      id,
      label: presentation.entry.target.label,
      live:
        presentation.connection.phase === "connected" &&
        get(environmentShell.stateValueAtom(id)).status === "live",
    }));
}).pipe(Atom.withEquality((a, b) => JSON.stringify(a) === JSON.stringify(b)));

const projectsAtom = Atom.make((get) =>
  get(hostsAtom).flatMap((host) =>
    (get(threadEnvironment.snapshotAtom(host.id))?.projects ?? []).map(
      (project) => [`${host.id}:${project.id}`, project.title] as const,
    ),
  ),
).pipe(Atom.withEquality((a, b) => JSON.stringify(a) === JSON.stringify(b)));

// Shell streaming must not republish an unchanged widget timeline.
const dataAtom = Atom.make((get) => {
  const threads = get(environmentThreadShells.quietThreadShellsAtom);
  const hosts = get(hostsAtom);
  const projects = new Map(get(projectsAtom));
  const presentations = get(environmentPresentations.presentationsWithProvidersAtom);
  // Only the two visible requests need conversation details; the roster uses shell summaries.
  const requests = new Map(
    denseAttentionThreads(threads)
      .slice(0, 2)
      .map((thread) => [
        `${thread.environmentId}:${thread.id}`,
        get(
          environmentThreadDetails.pendingRequestsAtom({
            environmentId: thread.environmentId,
            threadId: thread.id,
          }),
        ),
      ]),
  );
  return buildDenseWidgetData({
    threads,
    hosts,
    requests,
    presentations,
    projectTitle: (thread) =>
      projects.get(`${thread.environmentId}:${thread.projectId}`) ?? "Project",
    threadUrl: (thread) =>
      Linking.createURL(
        `threads/${encodeURIComponent(thread.environmentId)}/${encodeURIComponent(thread.id)}`,
      ),
    url: Linking.createURL(""),
    usageUrl: Linking.createURL("settings/usage", { queryParams: { tab: "limits" } }),
  });
}).pipe(Atom.withEquality((a, b) => JSON.stringify(a) === JSON.stringify(b)));

function IosDenseWidgetCoordinator() {
  const data = useAtomValue(dataAtom);
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const { themeMode, themeVariablesByAppearance, isReady } = useAppearancePreferences();
  const lastLiveAt = useRef(0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes native widget timelines and refreshes their observation time while foregrounded
  useEffect(() => {
    if (!catalog.isReady || !isReady || !requireOptionalNativeModule("ExpoWidgets")) return;
    let disposed = false;
    let publishing = false;
    const publish = () => {
      if (disposed || publishing || !isAppActive()) return;
      publishing = true;
      const now = Date.now();
      if (data.live) lastLiveAt.current = now;
      void Promise.resolve()
        .then(() =>
          publishDenseWidget({
            ...data,
            checkedAt: lastLiveAt.current,
            expiresAt: lastLiveAt.current + 2 * 60_000,
            theme: createWidgetTheme(themeMode, themeVariablesByAppearance),
          }),
        )
        .catch((error: unknown) => {
          console.warn("Could not update Dense widget", error);
        })
        .then(() => {
          publishing = false;
        });
    };
    publish();
    const unsubscribe = subscribeAppState(() => publish());
    const timer = setInterval(publish, 60_000);
    return () => {
      disposed = true;
      unsubscribe();
      clearInterval(timer);
    };
  }, [catalog.isReady, isReady, data, themeMode, themeVariablesByAppearance]);
  return null;
}

export function DenseWidgetCoordinator() {
  return Platform.OS === "ios" ? <IosDenseWidgetCoordinator /> : null;
}
