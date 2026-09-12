import { useId } from "react";

// Original fincke.dev ribbon geometry, cropped to the opening S.
const FINCKE_WAVE_FIELD = { x: 0, y: -26, width: 470, height: 150 } as const;

// same opening S, cropped tighter for the ~40px composer button, which has no text to clear.
const FINCKE_WAVE_BUTTON_FIELD = { x: 40, y: -20, width: 420, height: 142 } as const;

type FinckeWaveField = typeof FINCKE_WAVE_FIELD | typeof FINCKE_WAVE_BUTTON_FIELD;

function waveViewBox(field: FinckeWaveField): string {
  return `${field.x} ${field.y} ${field.width} ${field.height}`;
}

const FINCKE_WAVE_BACK =
  "M462 101.335C228.6 101.335 143.4 28.1958 0 28.1958V58.6706C96 58.6706 253.8 131.81 462 131.81C670.2 131.81 869.4 101.335 960 101.335C1084.8 101.335 1330.2 144 1440 144V113.525C1330.2 113.525 1084.8 70.8605 960 70.8605C867 70.8605 624.6 101.335 462 101.335Z";

const FINCKE_WAVE_FRONT =
  "M462 72.5035C228.6 72.5035 143.4 0 0 0V30.2098C96 30.2098 253.8 102.713 462 102.713C670.2 102.713 869.4 72.5035 960 72.5035C1084.8 72.5035 1330.2 114.797 1440 114.797V84.5874C1330.2 84.5874 1084.8 42.2937 960 42.2937C867 42.2937 624.6 72.5035 462 72.5035Z";

export function FinckeWaveArt({ compact = false }: { compact?: boolean }) {
  const idPrefix = useId().replaceAll(":", "");
  const backId = `${idPrefix}-stage-alpha-back`;
  const frontId = `${idPrefix}-stage-alpha-front`;
  const field = compact ? FINCKE_WAVE_BUTTON_FIELD : FINCKE_WAVE_FIELD;

  return (
    <svg
      className="stage-wave h-full w-full"
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
          <stop offset="0.1" style={{ stopColor: "var(--primary)" }} />
          <stop offset="0.9" style={{ stopColor: "var(--sidebar)" }} stopOpacity="0.15" />
        </linearGradient>
        <linearGradient
          id={frontId}
          x1="721.524"
          y1="0.00950815"
          x2="718.433"
          y2="247.71"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="1" style={{ stopColor: "var(--primary)" }} />
        </linearGradient>
      </defs>

      <rect {...field} style={{ fill: "var(--sidebar)" }} />
      <path d={FINCKE_WAVE_BACK} fill={`url(#${backId})`} />
      <path d={FINCKE_WAVE_FRONT} fill={`url(#${frontId})`} />
    </svg>
  );
}
