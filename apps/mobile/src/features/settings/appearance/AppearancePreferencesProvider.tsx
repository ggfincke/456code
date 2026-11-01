// apps/mobile/src/features/settings/appearance/AppearancePreferencesProvider.tsx
// appearance preferences and native theme synchronization
import { createContext, startTransition, use, useMemo, type ReactNode } from "react";
import { Appearance, Platform, useColorScheme } from "react-native";

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Atom, AsyncResult } from "effect/reactivity";

import { ScopedTheme, ScopedVariables, Uniwind } from "uniwind";

import {
  resolveAppearance,
  resolveAppearancePreferences,
  type ResolvedAppearance,
} from "../../../lib/appearancePreferences";
import { appAtomRegistry } from "../../../state/atom-registry";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../../state/preferences";
import type { Preferences } from "../../../persistence/mobile-preferences";
import { getMobileThemeRuntimeVariables } from "../../../lib/mobileThemeVariables";
import type { MobileThemeVariables } from "../../../lib/mobileTheme";
import {
  createMobileThemePairPatch,
  createMobileDarkThemeActivationPatch,
  createMobileThemeSelectionPatch,
  normalizeMobileThemeMode,
  resolveMobileThemeIds,
  type MobileThemeAppearance,
  type MobileThemeId,
  type MobileThemeIds,
  type MobileThemeMode,
} from "../../../lib/mobileTheme";
import {
  createMobileThemeRuntimeOperations,
  getMobileUniwindThemeName,
  type MobileThemeRuntimeState,
} from "../../../lib/mobileThemeRuntime";

interface AppearancePreferencesContextValue {
  readonly appearance: ResolvedAppearance;
  readonly themeId: MobileThemeId;
  readonly themeIds: MobileThemeIds;
  readonly themeMode: MobileThemeMode;
  readonly themeAppearance: MobileThemeAppearance;
  readonly themeVariables: MobileThemeVariables;
  readonly themeVariablesByAppearance: Readonly<
    Record<MobileThemeAppearance, MobileThemeVariables>
  >;
  readonly isReady: boolean;
  readonly setThemeIdForAppearance: (
    appearance: MobileThemeAppearance,
    value: MobileThemeId,
  ) => void;
  readonly setThemeIdForBothAppearances: (value: MobileThemeId) => void;
  readonly activateDarkTheme: (value: MobileThemeId) => void;
  readonly setThemeMode: (value: MobileThemeMode) => void;
  readonly setBaseFontSize: (value: number) => void;
  readonly setTerminalFontSize: (value: number | null) => void;
  readonly setCodeFontSize: (value: number | null) => void;
  readonly setCodeWordBreak: (value: boolean) => void;
  readonly mathRenderingEnabled: boolean;
  readonly sidebarProjectFolderTint: boolean;
  readonly setSidebarProjectFolderTint: (value: boolean) => void;
  readonly setMathRenderingEnabled: (value: boolean) => void;
}

const AppearancePreferencesContext = createContext<AppearancePreferencesContextValue | null>(null);

function storedPreferencesOf<E>(result: AsyncResult.AsyncResult<Preferences, E>) {
  return AsyncResult.isSuccess(result) ? result.value : null;
}

function resolveThemeVariablesByAppearance(
  themeIds: MobileThemeIds,
): Readonly<Record<MobileThemeAppearance, MobileThemeVariables>> {
  return {
    light: getMobileThemeRuntimeVariables(themeIds.light, "light", Platform.OS),
    dark: getMobileThemeRuntimeVariables(themeIds.dark, "dark", Platform.OS),
  };
}

/** The appearance whose theme is on screen, read from the native scheme. */
export function resolveThemeAppearance(stored: Preferences | null): MobileThemeAppearance {
  const themeMode = normalizeMobileThemeMode(stored?.themeMode);
  if (themeMode !== "system") return themeMode;
  return Appearance.getColorScheme() === "dark" ? "dark" : "light";
}

function runtimeStateFor(stored: Preferences | null): MobileThemeRuntimeState {
  return {
    baseFontSize: resolveAppearancePreferences(stored).baseFontSize,
    themeMode: normalizeMobileThemeMode(stored?.themeMode),
    themeAppearance: resolveThemeAppearance(stored),
  };
}

const themeRuntimeStateAtom = Atom.make((get) =>
  runtimeStateFor(storedPreferencesOf(get(mobilePreferencesAtom))),
).pipe(
  Atom.withEquality(
    (left: MobileThemeRuntimeState, right: MobileThemeRuntimeState) =>
      left.baseFontSize === right.baseFontSize &&
      left.themeMode === right.themeMode &&
      left.themeAppearance === right.themeAppearance,
  ),
);

// Native appearance and Uniwind text variables are process-global, so the
// last applied state is too. Setters apply ahead of the preference write so the
// first frame after a change already uses it; the atom subscription then sees
// no difference.
let appliedRuntimeState: MobileThemeRuntimeState | null = null;

function applyThemeRuntime(next: MobileThemeRuntimeState) {
  for (const operation of createMobileThemeRuntimeOperations(appliedRuntimeState, next)) {
    if (operation.kind === "update-text-variables") {
      Uniwind.updateCSSVariables(operation.themeName, operation.variables);
      continue;
    }
    if (operation.kind === "set-appearance-mode") {
      Appearance.setColorScheme(
        operation.themeMode === "system" ? "unspecified" : operation.appearance,
      );
    }
  }
  appliedRuntimeState = next;
}

function currentRuntimeState() {
  return appliedRuntimeState ?? appAtomRegistry.get(themeRuntimeStateAtom);
}

/** App-lifetime: applies theme preferences to the native runtime. */
export function installAppearanceRuntime(): () => void {
  return appAtomRegistry.subscribe(themeRuntimeStateAtom, applyThemeRuntime, {
    immediate: true,
  });
}

export function AppearancePreferencesProvider(props: { readonly children: ReactNode }) {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const systemColorScheme = useColorScheme() === "dark" ? "dark" : "light";
  const storedPreferences = AsyncResult.isSuccess(preferencesResult)
    ? preferencesResult.value
    : null;
  const preferences = useMemo(
    () => resolveAppearancePreferences(storedPreferences),
    [storedPreferences],
  );
  const themeMode = normalizeMobileThemeMode(storedPreferences?.themeMode);
  const themeAppearance = themeMode === "system" ? systemColorScheme : themeMode;
  const resolvedThemeIds = resolveMobileThemeIds(storedPreferences ?? {});
  const themeIds = useMemo<MobileThemeIds>(
    () => ({ light: resolvedThemeIds.light, dark: resolvedThemeIds.dark }),
    [resolvedThemeIds.dark, resolvedThemeIds.light],
  );
  const themeId = themeIds[themeAppearance];
  const themeVariablesByAppearance = resolveThemeVariablesByAppearance(themeIds);
  const themeVariables = themeVariablesByAppearance[themeAppearance];
  const activeThemeName = getMobileUniwindThemeName(themeId, themeAppearance);
  const { baseFontSize, codeFontSize, codeWordBreak, terminalFontSize } = preferences;
  const appearance = useMemo(
    () => resolveAppearance({ baseFontSize, codeFontSize, codeWordBreak, terminalFontSize }),
    [baseFontSize, codeFontSize, codeWordBreak, terminalFontSize],
  );
  const isReady = AsyncResult.isSuccess(preferencesResult);
  const updatePreferences = (patch: Partial<Preferences>) => {
    startTransition(() => savePreferences(patch));
  };

  const updateThemePreferences = (patch: Partial<Preferences>) => {
    savePreferences(patch);
  };

  const setThemeIdForAppearance = (appearance: MobileThemeAppearance, value: MobileThemeId) => {
    // Read at call time: a second pick before the next render must build on
    // the first one's optimistic write.
    const selected = resolveMobileThemeIds(
      storedPreferencesOf(appAtomRegistry.get(mobilePreferencesAtom)) ?? {},
    );
    updateThemePreferences(
      createMobileThemeSelectionPatch(selected, themeAppearance, appearance, value),
    );
  };

  const setThemeIdForBothAppearances = (value: MobileThemeId) => {
    updateThemePreferences(
      createMobileThemePairPatch(
        value,
        resolveMobileThemeIds(
          storedPreferencesOf(appAtomRegistry.get(mobilePreferencesAtom)) ?? {},
        ),
      ),
    );
  };

  const setThemeMode = (value: MobileThemeMode) => {
    const current = currentRuntimeState();

    // Clear forced appearance before publishing System so useColorScheme batches the system palette into the preference commit.
    if (value === "system") {
      Appearance.setColorScheme("unspecified");
    }
    const nextAppearance =
      value === "system" ? (Appearance.getColorScheme() === "dark" ? "dark" : "light") : value;
    const next = {
      ...current,
      themeAppearance: nextAppearance,
      themeMode: value,
    };

    if (value === "system") {
      appliedRuntimeState = next;
    } else {
      applyThemeRuntime(next);
    }
    updateThemePreferences({ themeMode: value });
  };

  const setBaseFontSize = (value: number) => {
    applyThemeRuntime({ ...currentRuntimeState(), baseFontSize: value });
    updatePreferences({ baseFontSize: value });
  };

  const setTerminalFontSize = (value: number | null) => {
    updatePreferences({ terminalFontSize: value });
  };

  const setCodeFontSize = (value: number | null) => {
    updatePreferences({ codeFontSize: value });
  };

  const setCodeWordBreak = (value: boolean) => {
    updatePreferences({ codeWordBreak: value });
  };

  const mathRenderingEnabled = storedPreferences?.mathRenderingEnabled === true;
  const setMathRenderingEnabled = (value: boolean) =>
    updatePreferences({ mathRenderingEnabled: value });

  const sidebarProjectFolderTint = storedPreferences?.sidebarProjectFolderTint === true;
  const setSidebarProjectFolderTint = (value: boolean) =>
    updatePreferences({ sidebarProjectFolderTint: value });
  const activateDarkTheme = (value: MobileThemeId) => {
    const selected = resolveMobileThemeIds(
      storedPreferencesOf(appAtomRegistry.get(mobilePreferencesAtom)) ?? {},
    );
    const patch = createMobileDarkThemeActivationPatch(selected, value);
    applyThemeRuntime({ ...currentRuntimeState(), themeAppearance: "dark", themeMode: "dark" });
    updateThemePreferences(patch);
  };

  const value = useMemo(
    (): AppearancePreferencesContextValue => ({
      appearance,
      themeId,
      themeIds,
      themeMode,
      themeAppearance,
      themeVariables,
      themeVariablesByAppearance,
      isReady,
      setThemeIdForAppearance,
      setThemeIdForBothAppearances,
      activateDarkTheme,
      setThemeMode,
      setBaseFontSize,
      setTerminalFontSize,
      setCodeFontSize,
      setCodeWordBreak,
      mathRenderingEnabled,
      sidebarProjectFolderTint,
      setSidebarProjectFolderTint,
      setMathRenderingEnabled,
    }),
    [
      appearance,
      themeId,
      themeIds,
      themeMode,
      themeAppearance,
      themeVariables,
      themeVariablesByAppearance,
      isReady,
      setThemeIdForAppearance,
      setThemeIdForBothAppearances,
      activateDarkTheme,
      setThemeMode,
      setBaseFontSize,
      setTerminalFontSize,
      setCodeFontSize,
      setCodeWordBreak,
      mathRenderingEnabled,
      sidebarProjectFolderTint,
      setSidebarProjectFolderTint,
      setMathRenderingEnabled,
    ],
  );

  return (
    <AppearancePreferencesContext.Provider value={value}>
      <ScopedTheme theme={activeThemeName}>
        <ScopedVariables variables={themeVariables}>{props.children}</ScopedVariables>
      </ScopedTheme>
    </AppearancePreferencesContext.Provider>
  );
}

export function useAppearancePreferences(): AppearancePreferencesContextValue {
  const context = use(AppearancePreferencesContext);
  if (!context) {
    throw new Error("useAppearancePreferences must be used within AppearancePreferencesProvider");
  }
  return context;
}
