// apps/mobile/src/fincke/FinckeListHeader.tsx
// full-bleed ocean wave band behind the list's title, plus an optional controls row

import { useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { FINCKE_WAVE_FIELD } from "@t3tools/shared/fincke-wave";

import { CompactBrandTitle } from "../components/CompactBrandTitle";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { FINCKE_WAVE_FIELD_COLOR, FinckeWaveArt } from "./FinckeWaveArt";
import { useShowFinckeWaveBrand } from "./wave-brand";

// the band below the native title row, close to desktop's sidebar header
export const BAND_HEIGHT = 72;
// the field's top 124 units fill pullUp + BAND_HEIGHT behind the title. the rest of the field,
// down past the back ribbon, hangs below at that same scale so the ribbons keep their thickness
const TITLE_UNITS = 124;

// how far the wave runs past BAND_HEIGHT for a band pulled up by `pullUp`
export function finckeWaveTail(pullUp: number) {
  return ((pullUp + BAND_HEIGHT) * (FINCKE_WAVE_FIELD.height - TITLE_UNITS)) / TITLE_UNITS;
}
// field y the brand's top sits at: just clear of the back ribbon's lower edge under the
// whole wordmark & stage badge, like desktop's sidebar
const BRAND_TOP_UNITS = 92;
// field color above the band, so pulling the list past its top keeps revealing the wave's field
const OVERSCROLL_FIELD = 600;

export function FinckeListHeader(props: {
  // how far the band reaches up behind the native header (the list's top inset)
  readonly pullUp?: number;
  // the list's horizontal content padding, cancelled so the band spans the column
  readonly bleedLeft?: number;
  readonly bleedRight?: number;
  // draws the brand under the wave, taking it from the native title row on top of the ribbons
  readonly showBrand?: boolean;
  readonly children?: ReactNode;
}) {
  const { themeId } = useAppearancePreferences();
  const [size, setSize] = useState<{ readonly width: number; readonly height: number } | null>(
    null,
  );
  const pullUp = props.pullUp ?? 0;
  const ocean = themeId === "fincke-ocean";
  useShowFinckeWaveBrand(ocean && props.showBrand === true);
  const band = ocean ? (
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
        height: pullUp + BAND_HEIGHT + finckeWaveTail(pullUp),
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
      {band !== null && props.showBrand && size ? (
        <View
          style={{
            position: "absolute",
            top: brandTop(size, pullUp),
            left: 16 - (props.bleedLeft ?? 0),
          }}
        >
          <CompactBrandTitle allowFontScaling={false} wave />
        </View>
      ) : null}
    </View>
  );
}

// the art slices the field to cover the band, so map field units through that same fit
function brandTop(size: { readonly width: number; readonly height: number }, pullUp: number) {
  const field = FINCKE_WAVE_FIELD;
  const scale = Math.max(size.width / field.width, size.height / field.height);
  const sliceOffset = (size.height - field.height * scale) / 2;
  return -pullUp + sliceOffset + (BRAND_TOP_UNITS - field.y) * scale;
}
