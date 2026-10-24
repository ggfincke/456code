// apps/mobile/src/fincke/FinckeWaveArt.tsx
// renders the shared fincke ribbons in native svg

import { useId } from "react";
import Svg, { Defs, LinearGradient, Path, Rect, Stop } from "react-native-svg";
import {
  FINCKE_WAVE_BACK,
  FINCKE_WAVE_BUTTON_FIELD,
  FINCKE_WAVE_FIELD,
  FINCKE_WAVE_FRONT,
  waveViewBox,
} from "@t3tools/shared/fincke-wave";

export function FinckeWaveArt({ compact = false }: { readonly compact?: boolean }) {
  const id = useId().replaceAll(":", "");
  const back = `${id}-back`;
  const field = compact ? FINCKE_WAVE_BUTTON_FIELD : FINCKE_WAVE_FIELD;
  const base = compact ? "#80cbc4" : "#0f111a";
  const wave = compact ? "#c6e8e4" : "#80cbc4";

  return (
    <Svg
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      height="100%"
      width="100%"
      preserveAspectRatio="none"
      viewBox={waveViewBox(field)}
    >
      <Defs>
        <LinearGradient
          id={back}
          x1="721.524"
          y1="0.0119269"
          x2="716.661"
          y2="310.697"
          gradientUnits="userSpaceOnUse"
        >
          <Stop offset="0.1" stopColor={wave} />
          <Stop offset="0.9" stopColor={base} stopOpacity={0.15} />
        </LinearGradient>
      </Defs>
      <Rect {...field} fill={base} />
      <Path d={FINCKE_WAVE_BACK} fill={`url(#${back})`} />
      <Path d={FINCKE_WAVE_FRONT} fill={wave} />
    </Svg>
  );
}
