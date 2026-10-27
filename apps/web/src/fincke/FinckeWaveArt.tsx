// apps/web/src/fincke/FinckeWaveArt.tsx
// renders fincke's ribbon geometry with the active theme
import {
  FINCKE_WAVE_SIDEBAR_FIELD,
  FINCKE_WAVE_BUTTON_FIELD,
  FINCKE_WAVE_BACK,
  FINCKE_WAVE_FRONT,
  FINCKE_WAVE_HIGHLIGHT_OFFSET,
  waveViewBox,
} from "@t3tools/shared/fincke-wave";

import "./waveBackdrop.css";

export function FinckeWaveArt({ compact = false }: { compact?: boolean }) {
  const field = compact ? FINCKE_WAVE_BUTTON_FIELD : FINCKE_WAVE_SIDEBAR_FIELD;
  // fincke ocean paints fincke.dev's own colors (teal ribbons on the ocean field, light
  // waves on teal for the send button); other themes keep their accent on the sidebar color
  const base = compact
    ? "var(--fincke-send-base, var(--sidebar))"
    : "var(--fincke-wave-field, var(--sidebar))";
  const wave = compact
    ? "var(--fincke-send-wave, var(--primary))"
    : "var(--fincke-wave-accent, var(--primary))";
  const back = compact
    ? "var(--fincke-send-back, color-mix(in srgb, var(--primary) 65%, var(--sidebar)))"
    : "var(--fincke-wave-back, color-mix(in srgb, var(--primary) 65%, var(--sidebar)))";
  const highlight = compact
    ? "var(--fincke-send-highlight, color-mix(in srgb, var(--primary) 55%, white))"
    : "var(--fincke-wave-highlight, color-mix(in srgb, var(--primary) 55%, white))";

  return (
    <svg
      data-stage-art="fincke"
      className="h-full w-full"
      fill="none"
      preserveAspectRatio="none"
      viewBox={waveViewBox(field)}
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect {...field} style={{ fill: base }} />
      <path d={FINCKE_WAVE_BACK} style={{ fill: back }} />
      <path d={FINCKE_WAVE_FRONT} style={{ fill: wave }} />
      <path
        d={FINCKE_WAVE_FRONT}
        transform={`translate(0 ${FINCKE_WAVE_HIGHLIGHT_OFFSET})`}
        style={{ fill: highlight }}
      />
    </svg>
  );
}
