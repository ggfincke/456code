// apps/web/src/fincke/FinckeWaveArt.tsx
// renders fincke's ribbon geometry with the active theme
import { useId } from "react";
import {
  FINCKE_WAVE_FIELD,
  FINCKE_WAVE_BUTTON_FIELD,
  FINCKE_WAVE_BACK,
  FINCKE_WAVE_FRONT,
  waveViewBox,
} from "@t3tools/shared/fincke-wave";

import "./waveBackdrop.css";

export function FinckeWaveArt({ compact = false }: { compact?: boolean }) {
  const idPrefix = useId().replaceAll(":", "");
  const backId = `${idPrefix}-stage-alpha-back`;
  const frontId = `${idPrefix}-stage-alpha-front`;
  const field = compact ? FINCKE_WAVE_BUTTON_FIELD : FINCKE_WAVE_FIELD;
  // fincke ocean paints fincke.dev's own colors (teal ribbons on the ocean field, light
  // waves on teal for the send button); other themes keep their accent on the sidebar color
  const base = compact
    ? "var(--fincke-send-base, var(--sidebar))"
    : "var(--fincke-wave-field, var(--sidebar))";
  const wave = compact
    ? "var(--fincke-send-wave, var(--primary))"
    : "var(--fincke-wave-accent, var(--primary))";

  return (
    <svg
      data-stage-art="fincke"
      className="h-full w-full"
      fill="none"
      preserveAspectRatio="none"
      viewBox={waveViewBox(field)}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient
          id={backId}
          x1="721.524"
          y1="0.0119269"
          x2="716.661"
          y2="310.697"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0.1" style={{ stopColor: wave }} />
          <stop offset="0.9" style={{ stopColor: base }} stopOpacity="0.15" />
        </linearGradient>
        <linearGradient
          id={frontId}
          x1="721.524"
          y1="0.00950815"
          x2="718.433"
          y2="247.71"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="1" style={{ stopColor: wave }} />
        </linearGradient>
      </defs>

      <rect {...field} style={{ fill: base }} />
      <path d={FINCKE_WAVE_BACK} fill={`url(#${backId})`} />
      <path d={FINCKE_WAVE_FRONT} fill={`url(#${frontId})`} />
    </svg>
  );
}
