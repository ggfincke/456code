// apps/mobile/src/fincke/FinckeListHeader.tsx
// full-bleed ocean wave band behind the list's title, plus an optional controls row

import { useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { FINCKE_WAVE_FIELD_COLOR, FinckeWaveArt } from "./FinckeWaveArt";

// the band below the native title row, close to desktop's h-20 sidebar header
const BAND_HEIGHT = 72;
// field color above the band, so pulling the list past its top keeps revealing the wave's field
const OVERSCROLL_FIELD = 600;
// like desktop's stage fade, the band stays solid and only its last stretch blends into the list
const FADE_HEIGHT = 24;

export function FinckeListHeader(props: {
  // how far the band reaches up behind the native header (the list's top inset)
  readonly pullUp?: number;
  // the list's horizontal content padding, cancelled so the band spans the column
  readonly bleedLeft?: number;
  readonly bleedRight?: number;
  // the list surface the band fades into
  readonly surface?: "drawer" | "screen";
  readonly children?: ReactNode;
}) {
  const { themeId, themeVariables } = useAppearancePreferences();
  const [size, setSize] = useState<{ readonly width: number; readonly height: number } | null>(
    null,
  );
  const pullUp = props.pullUp ?? 0;
  const fadeTo = themeVariables[props.surface === "screen" ? "--color-screen" : "--color-drawer"];
  const band =
    themeId === "fincke-ocean" ? (
      <View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        onLayout={(event) => {
          const { width, height } = event.nativeEvent.layout;
          setSize((current) =>
            current?.width === width && current.height === height ? current : { width, height },
          );
        }}
        style={{
          height: pullUp + BAND_HEIGHT,
          marginTop: -pullUp,
          marginLeft: -(props.bleedLeft ?? 0),
          marginRight: -(props.bleedRight ?? 0),
          overflow: "hidden",
        }}
      >
        {/* * react-native-svg keeps the pixels it drew at an earlier size when its view grows,
            which shows as a stale, seamed strip of the wave. the band resizes after mount (the
            header inset lands late, folding changes the width), so the art draws only at a
            measured size and remounts whole when it changes */}
        {size ? (
          <View key={`${size.width}x${size.height}`} style={StyleSheet.absoluteFill}>
            <FinckeWaveArt slice />
            {/* RN has no mask-image, so an overlay does desktop's stage fade */}
            <Svg
              style={{ position: "absolute", left: 0, bottom: 0 }}
              width={size.width}
              height={FADE_HEIGHT}
            >
              <Defs>
                <LinearGradient id="fincke-band-fade" x1="0" y1="0" x2="0" y2="1">
                  <Stop offset="0" stopColor={fadeTo} stopOpacity={0} />
                  <Stop offset="1" stopColor={fadeTo} stopOpacity={1} />
                </LinearGradient>
              </Defs>
              <Rect
                x="0"
                y="0"
                width={size.width}
                height={FADE_HEIGHT}
                fill="url(#fincke-band-fade)"
              />
            </Svg>
          </View>
        ) : null}
      </View>
    ) : null;
  if (band === null && props.children === undefined) return null;
  return (
    <View>
      {band === null ? null : (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: -pullUp - OVERSCROLL_FIELD,
            height: OVERSCROLL_FIELD,
            left: -(props.bleedLeft ?? 0),
            right: -(props.bleedRight ?? 0),
            backgroundColor: FINCKE_WAVE_FIELD_COLOR,
          }}
        />
      )}
      {band}
      {props.children}
    </View>
  );
}
