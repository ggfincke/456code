// packages/shared/src/fincke-wave.ts
// shares fincke ribbon geometry between web and native svg renderers

// original fincke.dev ribbon geometry, cropped so the whole opening S fits the header band:
// it enters at the top-left & leaves on the right, under the brand
export const FINCKE_WAVE_FIELD = { x: 0, y: -6, width: 470, height: 124 } as const;

// web's sidebar puts the brand level with the toggle at the top right, so its crop starts
// higher to drop the wave until the pale highlight clears that row. native keeps the original
// crop since its title & view toggle already sit clear of the ribbons there
export const FINCKE_WAVE_SIDEBAR_FIELD = { ...FINCKE_WAVE_FIELD, y: -23 } as const;

// same opening S, cropped tighter for the ~40px composer button, which has no text to clear.
// the taller crop leaves room for the highlight ribbon above the front one
export const FINCKE_WAVE_BUTTON_FIELD = { x: 40, y: -34.5, width: 420, height: 172.5 } as const;

// the third, palest ribbon is the front ribbon raised by this much
export const FINCKE_WAVE_HIGHLIGHT_OFFSET = -28.5;

type FinckeWaveField =
  | typeof FINCKE_WAVE_FIELD
  | typeof FINCKE_WAVE_SIDEBAR_FIELD
  | typeof FINCKE_WAVE_BUTTON_FIELD;

export function waveViewBox(field: FinckeWaveField): string {
  return `${field.x} ${field.y} ${field.width} ${field.height}`;
}

export const FINCKE_WAVE_BACK =
  "M462 101.335C228.6 101.335 143.4 28.1958 0 28.1958V58.6706C96 58.6706 253.8 131.81 462 131.81C670.2 131.81 869.4 101.335 960 101.335C1084.8 101.335 1330.2 144 1440 144V113.525C1330.2 113.525 1084.8 70.8605 960 70.8605C867 70.8605 624.6 101.335 462 101.335Z";

export const FINCKE_WAVE_FRONT =
  "M462 72.5035C228.6 72.5035 143.4 0 0 0V30.2098C96 30.2098 253.8 102.713 462 102.713C670.2 102.713 869.4 72.5035 960 72.5035C1084.8 72.5035 1330.2 114.797 1440 114.797V84.5874C1330.2 84.5874 1084.8 42.2937 960 42.2937C867 42.2937 624.6 72.5035 462 72.5035Z";
