// apps/mobile/src/fincke/FinckeListHeader.tsx
// full-bleed ocean wave band behind the list's title, plus an optional controls row

import type { ReactNode } from "react";
import { View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { FinckeWaveArt } from "./FinckeWaveArt";

// the band below the native title row, close to desktop's h-20 sidebar header
const BAND_HEIGHT = 72;

export function FinckeListHeader(props: {
  // how far the band reaches up behind the native header (the list's top inset)
  readonly pullUp?: number;
  // the list's horizontal content padding, cancelled so the band spans the column
  readonly bleedLeft?: number;
  readonly bleedRight?: number;
  readonly children?: ReactNode;
}) {
  const { themeId, themeVariables } = useAppearancePreferences();
  const pullUp = props.pullUp ?? 0;
  const drawer = themeVariables["--color-drawer"];
  const band =
    themeId === "fincke-ocean" ? (
      <View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          height: pullUp + BAND_HEIGHT,
          marginTop: -pullUp,
          marginLeft: -(props.bleedLeft ?? 0),
          marginRight: -(props.bleedRight ?? 0),
          overflow: "hidden",
        }}
      >
        <FinckeWaveArt slice />
        {/* RN has no mask-image, so an overlay does desktop's stage fade: the band stays
            solid and blends into the drawer only along its bottom edge */}
        <Svg
          pointerEvents="none"
          style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: "35%" }}
          width="100%"
          height="100%"
          preserveAspectRatio="none"
        >
          <Defs>
            <LinearGradient id="fincke-band-fade" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={drawer} stopOpacity={0} />
              <Stop offset="1" stopColor={drawer} stopOpacity={1} />
            </LinearGradient>
          </Defs>
          <Rect x="0" y="0" width="100%" height="100%" fill="url(#fincke-band-fade)" />
        </Svg>
      </View>
    ) : null;
  if (band === null && props.children === undefined) return null;
  return (
    <View>
      {band}
      {props.children}
    </View>
  );
}
