// apps/desktop/src/fincke/build.ts
// personal desktop build flag & identity
import { finckeDesktop } from "../../../../scripts/lib/fincke-desktop.ts";

// The personal desktop build is explicit; upstream unit tests retain their default identity.
declare const __FINCKE_DESKTOP__: boolean;
export const isFinckeDesktop = typeof __FINCKE_DESKTOP__ !== "undefined" && __FINCKE_DESKTOP__;

export { finckeDesktop };

// app name for user-visible copy; static so modules w/o DesktopEnvironment can read it
export const DESKTOP_APP_NAME = isFinckeDesktop ? finckeDesktop.name : "T3 Code";
