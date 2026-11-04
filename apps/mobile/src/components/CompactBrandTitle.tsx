// apps/mobile/src/components/CompactBrandTitle.tsx
// presents native 456code branding and build stage

import { NATIVE_WORKSPACE_COLUMNS_SUPPORTED } from "../native/NativeWorkspaceColumns";
import { JetBrainsMono_700Bold } from "@expo-google-fonts/jetbrains-mono/700Bold";
import Constants from "expo-constants";
import { useFonts } from "expo-font";
import type { NativeStackNavigationOptions } from "@react-navigation/native-stack";
import { useState } from "react";
import { Platform, Text as RNText, View } from "react-native";

import { AppText as Text } from "./ui/AppText";
import { IPAD_HOME_TITLE_OFFSET } from "../lib/layoutMetrics";
import { resolveMobileStageLabel } from "../lib/mobileBranding";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { useFinckeWaveBrandShown } from "../fincke/wave-brand";

const BRAND_MAX_FONT_SCALE = 1.4;
// fincke: loaded at runtime rather than embedded by the expo-font plugin, so the wordmark
// ships over ota without changing the native fingerprint
const WORDMARK_FONT = "JetBrainsMono-Bold";
const WORDMARK_ACCENT = "#80cbc4";

export function brandTitleOffset(): number {
  if (Platform.OS !== "ios") return 0;
  return Platform.isPad && !NATIVE_WORKSPACE_COLUMNS_SUPPORTED ? IPAD_HOME_TITLE_OFFSET : 0;
}

export function CompactBrandTitle(
  props: {
    readonly allowFontScaling?: boolean;
    readonly accessibilityLabel?: string;
    /** Fills the row and hides the stage badge when the full title does not fit. */
    readonly fit?: boolean;
    /** fincke: drawn under the ocean wave instead of in the native title row. */
    readonly wave?: boolean;
  } = {},
) {
  const stageLabel = resolveMobileStageLabel(Constants.expoConfig?.extra?.appVariant);
  // fincke: the ocean wave sits behind the title, so it reads white as on desktop
  const ocean = useAppearancePreferences().themeId === "fincke-ocean";
  const [wordmarkFontLoaded] = useFonts({ [WORDMARK_FONT]: JetBrainsMono_700Bold });
  // matches desktop's mono wordmark over the wave, w/ the leading digits in the ribbon teal
  const wordmark = ocean && wordmarkFontLoaded;
  // the native title row sits on the ribbons, so the brand moves under them while a band shows
  // it. it stays laid out but unseen, since an empty title view makes uikit fall back to the tab
  const steppedAside = useFinckeWaveBrandShown() && ocean && !props.wave;
  const titleOffset = props.wave ? 0 : brandTitleOffset();
  const [availableWidth, setAvailableWidth] = useState<number | null>(null);
  // Measured only while the badge shows, so hiding it does not make it look like it fits.
  const [fullWidth, setFullWidth] = useState<number | null>(null);
  const showStage =
    !props.fit || availableWidth === null || fullWidth === null || fullWidth <= availableWidth;

  const title = (
    <View
      onLayout={
        props.fit && showStage ? (event) => setFullWidth(event.nativeEvent.layout.width) : undefined
      }
      aria-level={1}
      accessibilityLabel={props.accessibilityLabel ?? "456code, Threads"}
      accessible={!steppedAside}
      accessibilityElementsHidden={steppedAside}
      importantForAccessibility={steppedAside ? "no-hide-descendants" : "auto"}
      role="heading"
      className="flex-row items-center gap-1.5"
      style={[
        { marginLeft: titleOffset },
        Platform.OS === "android" && { gap: 5.25 },
        props.fit && { flexShrink: 0 },
        steppedAside && { opacity: 0 },
      ]}
    >
      <Text
        allowFontScaling={props.allowFontScaling}
        maxFontSizeMultiplier={BRAND_MAX_FONT_SCALE}
        numberOfLines={1}
        className={wordmark ? "text-foreground-muted" : "font-t3-medium text-foreground-muted"}
        style={{
          fontSize: 21,
          letterSpacing: -0.5,
          ...(ocean ? { color: "#ffffff" } : null),
          ...(wordmark ? { fontFamily: WORDMARK_FONT, letterSpacing: -0.4 } : null),
        }}
      >
        {/* plain rn text inherits the wordmark font, where AppText would reset it to dm sans */}
        {wordmark ? <RNText style={{ color: WORDMARK_ACCENT }}>456</RNText> : "456"}
        code
      </Text>
      {showStage ? (
        <View
          className="rounded-full bg-subtle px-1.5 py-0.5"
          style={
            Platform.OS === "android"
              ? { paddingHorizontal: 5.25, paddingVertical: 1.75 }
              : undefined
          }
        >
          <Text
            allowFontScaling={props.allowFontScaling}
            maxFontSizeMultiplier={BRAND_MAX_FONT_SCALE}
            numberOfLines={1}
            className="font-t3-bold text-foreground-muted uppercase"
            style={{ fontSize: 9, letterSpacing: 0.9 }}
          >
            {stageLabel}
          </Text>
        </View>
      ) : null}
    </View>
  );

  return props.fit ? (
    <View
      className="min-w-0 flex-1 flex-row items-center"
      onLayout={(event) => setAvailableWidth(event.nativeEvent.layout.width)}
    >
      {title}
    </View>
  ) : (
    title
  );
}

function renderCompactBrandTitle() {
  return <CompactBrandTitle allowFontScaling={Platform.OS === "ios"} />;
}

export function getCompactBrandHeaderOptions(
  fallbackTitleStyle?: NativeStackNavigationOptions["headerTitleStyle"],
): NativeStackNavigationOptions {
  return {
    headerTitle: renderCompactBrandTitle,
    headerTitleStyle: fallbackTitleStyle,
    title: "Threads",
    unstable_headerLeftItems: undefined,
  };
}
