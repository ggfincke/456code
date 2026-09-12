// The personal desktop build is explicit; upstream unit tests retain their default identity.
declare const __FINCKE_DESKTOP__: boolean;
export const isFinckeDesktop = typeof __FINCKE_DESKTOP__ !== "undefined" && __FINCKE_DESKTOP__;

export { finckeDesktop } from "../../../../scripts/lib/fincke-desktop.ts";
