// apps/web/src/fincke/geistFonts.ts
// makes geist the default ui & code face on linux while macos, ios & windows keep their system fonts
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./geistFonts.css";

import { isMacPlatform } from "@t3tools/shared/keybindings";

const GEIST_SANS = '"Geist Variable"';
const GEIST_MONO = '"Geist Mono Variable"';

// chromium on linux maps -apple-system & BlinkMacSystemFont to the fontconfig
// default (liberation sans here), so geist has to lead the stack, not trail it
function platformUsesGeist(): boolean {
  if (typeof navigator === "undefined") return false;
  return !isMacPlatform(navigator.platform) && !/^win/i.test(navigator.platform);
}

export function withGeistSans(stack: string): string {
  return platformUsesGeist() ? `${GEIST_SANS}, ${stack}` : stack;
}

export function withGeistMono(stack: string): string {
  return platformUsesGeist() ? `${GEIST_MONO}, ${stack}` : stack;
}

// the css default stacks key off this attribute; loading both faces up front
// keeps settings labels & terminal cell metrics from measuring a fallback
export function applyGeistFontDefaults(): void {
  if (typeof document === "undefined" || !platformUsesGeist()) return;
  document.documentElement.dataset.finckeFonts = "geist";
  void Promise.all([
    document.fonts.load(`400 16px ${GEIST_SANS}`),
    document.fonts.load(`400 16px ${GEIST_MONO}`),
  ]).catch(() => {});
}
