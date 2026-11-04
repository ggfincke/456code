// apps/web/src/fincke/FinckeWordmark.tsx
// renders the brand as fincke.dev's mono wordmark w/ the leading digits in the wave accent
import "@fontsource-variable/jetbrains-mono/wght.css";

import { APP_BASE_NAME } from "../branding";

import "./waveBackdrop.css";

const [, DIGITS = "", REST = APP_BASE_NAME] = /^(\d*)(.*)$/.exec(APP_BASE_NAME) ?? [];

export function FinckeWordmark() {
  return (
    <span data-fincke-wordmark className="truncate">
      <span data-fincke-wordmark-digits>{DIGITS}</span>
      {REST}
    </span>
  );
}
