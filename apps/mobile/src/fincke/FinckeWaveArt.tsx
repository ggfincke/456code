// apps/mobile/src/fincke/FinckeWaveArt.tsx
// renders the shared fincke ribbons in native svg

import Svg, { Path, Rect } from "react-native-svg";
import {
  FINCKE_WAVE_BACK,
  FINCKE_WAVE_BUTTON_FIELD,
  FINCKE_WAVE_FIELD,
  FINCKE_WAVE_FRONT,
  FINCKE_WAVE_HIGHLIGHT_OFFSET,
  waveViewBox,
} from "@t3tools/shared/fincke-wave";

// fincke.dev's --bg, the field the ribbons sit on
export const FINCKE_WAVE_FIELD_COLOR = "#0f111a";

// `slice` keeps the ribbon's proportions in a box narrower than the field (a phone column
// under a tall header) by cropping its far end instead of thickening the ribbons
export function FinckeWaveArt({
  compact = false,
  slice = false,
}: {
  readonly compact?: boolean;
  readonly slice?: boolean;
}) {
  const field = compact ? FINCKE_WAVE_BUTTON_FIELD : FINCKE_WAVE_FIELD;
  const base = compact ? "#80cbc4" : FINCKE_WAVE_FIELD_COLOR;
  const wave = compact ? "#c6e8e4" : "#80cbc4";

  return (
    <Svg
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      height="100%"
      width="100%"
      preserveAspectRatio={slice ? "xMinYMid slice" : "none"}
      viewBox={waveViewBox(field)}
    >
      <Rect {...field} fill={base} />
      <Path d={FINCKE_WAVE_BACK} fill="#508f8a" />
      <Path d={FINCKE_WAVE_FRONT} fill={wave} />
      <Path
        d={FINCKE_WAVE_FRONT}
        transform={`translate(0 ${FINCKE_WAVE_HIGHLIGHT_OFFSET})`}
        fill={compact ? "#edf9f6" : "#b7e4dd"}
      />
    </Svg>
  );
}
