import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Keyboard, View } from "react-native";
import { CommonActions, StackActions, useNavigation } from "@react-navigation/native";
import { AsyncResult } from "effect/reactivity";
import { requireOptionalNativeModule } from "expo";

import { useConnectionController } from "../connection/useConnectionController";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import type { MobileThemeId } from "../../lib/mobileTheme";
import { useProjects, useThreadShells } from "../../state/entities";
import { enqueueThreadOutboxMessage } from "../../state/thread-outbox";
import { holdEditingQueuedMessage } from "../../state/use-thread-outbox";
import { useWorkspaceState } from "../../state/workspace";
import {
  applyNativeShowcaseOrientation,
  getNativeShowcaseOrientation,
  getNativeShowcasePairingUrls,
  getNativeShowcaseScene,
  getNativeShowcaseTheme,
  markNativeShowcaseReady,
  type ShowcaseScene,
} from "./nativeShowcaseScene";
import {
  buildShowcasePendingTasks,
  SHOWCASE_PENDING_TASK_DEFINITIONS,
} from "./showcasePendingTasks";
import { retryShowcaseOperation } from "./showcaseRetry";
import {
  clearShowcaseRenderSignal,
  getShowcaseRenderSignal,
  isShowcaseNativeContentReady,
  subscribeToShowcaseRenderSignal,
} from "./showcaseRenderSignal";
import { openSettings } from "../settings/settings-navigation";
import { selectWorkspaceDetail } from "../workspace/workspace-detail-selection";

const SHOWCASE_ENABLED = process.env.EXPO_PUBLIC_SHOWCASE === "1";
const SHOWCASE_THREAD_ID = "remote-command-center";

function sceneFromPathname(pathname: string): ShowcaseScene | null {
  const routePath = pathname.split(/[?#]/u, 1)[0] ?? pathname;
  if (routePath === "/settings" || routePath.endsWith("/settings/environments")) {
    return "environments";
  }
  if (routePath.endsWith("/terminal")) return "terminal";
  if (routePath.endsWith("/review")) return "review";
  if (routePath.startsWith("/threads/")) return "thread";
  if (routePath === "/") return "threads";
  return null;
}

export function ShowcaseCaptureCoordinator(props: { readonly pathname: string }) {
  if (!SHOWCASE_ENABLED) return null;
  return <EnabledShowcaseCaptureCoordinator pathname={props.pathname} />;
}

function EnabledShowcaseCaptureCoordinator(props: { readonly pathname: string }) {
  const navigation = useNavigation();
  useEffect(() => {
    const menu = requireOptionalNativeModule<{
      closeMenu(): void;
      setToolsButtonVisible(visible: boolean): void;
    }>("ExpoDevMenu");
    // The dev menu can open after bundle loading and block orientation requests.
    const timer = setInterval(() => {
      menu?.closeMenu();
      menu?.setToolsButtonVisible(false);
    }, 1_000);
    return () => clearInterval(timer);
  }, []);
  const { connectPairingUrl } = useConnectionController();
  const {
    isReady: appearancePreferencesReady,
    themeId,
    themeIds,
    setThemeIdForBothAppearances,
  } = useAppearancePreferences();
  const workspace = useWorkspaceState();
  const projects = useProjects();
  const threads = useThreadShells();
  const attemptedPairingRef = useRef(new Set<string>());
  const seededPendingTaskIdsRef = useRef(new Set<string>());
  const [pairingUrls, setPairingUrls] = useState<ReadonlyArray<string>>([]);
  const [pendingTasksReady, setPendingTasksReady] = useState(false);
  const [requestedScene, setRequestedScene] = useState<ShowcaseScene | null>(null);
  const [requestedTheme, setRequestedTheme] = useState<MobileThemeId | null>(null);
  const [themeRequestSettled, setThemeRequestSettled] = useState(false);
  const [readyScene, setReadyScene] = useState<ShowcaseScene | null>(null);
  const [orientationSettled, setOrientationSettled] = useState(false);
  const requestedSceneRef = useRef<ShowcaseScene | null>(null);
  const renderSignal = useSyncExternalStore(
    subscribeToShowcaseRenderSignal,
    getShowcaseRenderSignal,
    getShowcaseRenderSignal,
  );

  useEffect(() => {
    if (pairingUrls.length > 0) return;

    const readLaunchRequest = () => {
      const values = getNativeShowcasePairingUrls();
      if (values.length === 0) return;
      setRequestedTheme(getNativeShowcaseTheme());
      setThemeRequestSettled(true);
      setPairingUrls(values);
    };
    readLaunchRequest();
    const interval = setInterval(readLaunchRequest, 250);
    return () => clearInterval(interval);
  }, [pairingUrls.length]);

  useEffect(() => {
    if (orientationSettled) return;
    const orientation = getNativeShowcaseOrientation();
    if (orientation === null) {
      // oxlint-disable-next-line react/set-state-in-effect -- Capture readiness follows the native orientation change.
      setOrientationSettled(true);
      return;
    }

    let cancelled = false;
    void retryShowcaseOperation(async () => applyNativeShowcaseOrientation(orientation), {
      isCancelled: () => cancelled,
    }).then((applied) => {
      if (!cancelled && applied) setOrientationSettled(true);
    });
    return () => {
      cancelled = true;
    };
  }, [orientationSettled]);

  useEffect(() => {
    const readRequestedScene = () => {
      const value = getNativeShowcaseScene();
      if (!value || requestedSceneRef.current === value) return;
      requestedSceneRef.current = value;
      // Draws belong to their scene request; revisiting review must wait for its new surface.
      clearShowcaseRenderSignal();
      setRequestedScene(value);
    };
    readRequestedScene();
    const interval = setInterval(readRequestedScene, 250);
    return () => clearInterval(interval);
  }, []);

  const themeApplied =
    requestedTheme === null
      ? themeRequestSettled
      : themeIds.light === requestedTheme && themeIds.dark === requestedTheme;

  useEffect(() => {
    if (requestedTheme === null || themeApplied || !appearancePreferencesReady) {
      return;
    }
    setThemeIdForBothAppearances(requestedTheme);
  }, [appearancePreferencesReady, requestedTheme, setThemeIdForBothAppearances, themeApplied]);

  useEffect(() => {
    if (pairingUrls.length === 0) return;
    let cancelled = false;
    void (async () => {
      await Promise.all(
        pairingUrls.map(async (pairingUrl) => {
          if (cancelled || attemptedPairingRef.current.has(pairingUrl)) return;
          const paired = await retryShowcaseOperation(
            async () => AsyncResult.isSuccess(await connectPairingUrl(pairingUrl)),
            { isCancelled: () => cancelled },
          );
          if (paired) attemptedPairingRef.current.add(pairingUrl);
        }),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [connectPairingUrl, pairingUrls]);

  const scene = sceneFromPathname(props.pathname);
  const hasServerFixture =
    workspace.state.hasReadyEnvironment &&
    workspace.environments.length >= 3 &&
    projects.length >= 3 &&
    threads.some((thread) => String(thread.id) === SHOWCASE_THREAD_ID);
  const hasFixture = hasServerFixture && pendingTasksReady;
  const showcaseThread = threads.find((thread) => String(thread.id) === SHOWCASE_THREAD_ID);

  useEffect(() => {
    if (!hasServerFixture || pendingTasksReady) return;

    const pendingTasks = buildShowcasePendingTasks(projects, Date.now());
    if (pendingTasks.length !== SHOWCASE_PENDING_TASK_DEFINITIONS.length) return;

    let cancelled = false;
    for (const task of pendingTasks) holdEditingQueuedMessage(task.messageId);
    void (async () => {
      const results = await Promise.all(
        pendingTasks.map(async (task) => {
          const messageId = String(task.messageId);
          if (seededPendingTaskIdsRef.current.has(messageId)) return true;
          const seeded = await retryShowcaseOperation(
            async () => {
              await enqueueThreadOutboxMessage(task);
              return true;
            },
            { isCancelled: () => cancelled },
          );
          if (seeded) seededPendingTaskIdsRef.current.add(messageId);
          return seeded;
        }),
      );
      if (!cancelled && results.every(Boolean)) setPendingTasksReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [hasServerFixture, pendingTasksReady, projects]);

  useEffect(() => {
    if (requestedScene === null || !hasFixture || !showcaseThread) return;
    if (scene === requestedScene) return;

    const params = {
      environmentId: String(showcaseThread.environmentId),
      threadId: SHOWCASE_THREAD_ID,
    };
    if (requestedScene === "threads") {
      navigation.dispatch(StackActions.popToTop());
      return;
    }
    if (requestedScene === "environments") {
      openSettings(navigation, "SettingsEnvironments");
    } else if (requestedScene === "terminal") {
      navigation.dispatch(
        CommonActions.navigate("ThreadTerminal", { ...params, terminalId: "term-1" }),
      );
    } else if (requestedScene === "review") {
      navigation.dispatch(CommonActions.navigate("ThreadReview", params));
    } else {
      navigation.dispatch(selectWorkspaceDetail({ name: "Thread", params }));
    }
  }, [hasFixture, navigation, requestedScene, scene, showcaseThread]);

  useEffect(() => {
    if (
      scene === null ||
      requestedScene === null ||
      scene !== requestedScene ||
      !hasFixture ||
      !orientationSettled ||
      !themeApplied ||
      !isShowcaseNativeContentReady({ scene, themeId, renderSignal })
    ) {
      // oxlint-disable-next-line react/set-state-in-effect -- Capture readiness clears while the scene, fixture, or native content is not ready.
      setReadyScene(null);
      return;
    }
    if (scene === "terminal") Keyboard.dismiss();

    let renderFrame: number | null = null;
    let readyFrame: number | null = null;
    const settleTimer = setTimeout(() => {
      renderFrame = requestAnimationFrame(() => {
        readyFrame = requestAnimationFrame(() => {
          markNativeShowcaseReady(scene);
          setReadyScene(scene);
        });
      });
    }, 500);
    return () => {
      clearTimeout(settleTimer);
      if (renderFrame !== null) cancelAnimationFrame(renderFrame);
      if (readyFrame !== null) cancelAnimationFrame(readyFrame);
    };
  }, [hasFixture, orientationSettled, renderSignal, requestedScene, scene, themeApplied, themeId]);

  if (readyScene === null) return null;

  return (
    <View
      pointerEvents="none"
      testID={`showcase-ready-${readyScene}`}
      style={{ position: "absolute", width: 1, height: 1, opacity: 0.01 }}
    />
  );
}
