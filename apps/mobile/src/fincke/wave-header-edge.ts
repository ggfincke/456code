// apps/mobile/src/fincke/wave-header-edge.ts
// tracks when the ocean wave has scrolled out from under the home header

import { createContext, createElement, useState, type ReactNode } from "react";

import { BAND_HEIGHT } from "./FinckeListHeader";

// true once the wave band has fully passed under the native title, so only rows can sit there
export const FinckeWaveClearedContext = createContext(false);

// at rest the band is the content under the title, where UIKit's top edge effect would cut a
// hard line through it. once the list scrolls a band's height, the next thing under the title is
// rows, which need that effect as their backing. offsets are measured from the resting position,
// and setting the same boolean bails out, so only a crossing re-renders
export function useFinckeWaveCleared(initialScrollOffset: number) {
  const [cleared, setCleared] = useState(() => initialScrollOffset >= BAND_HEIGHT);
  const track = (scrollOffset: number) => setCleared(scrollOffset >= BAND_HEIGHT);
  return { cleared, track };
}

// wraps the screen's returned tree as a call so the hook doesn't re-indent upstream's JSX
export function withFinckeWaveCleared(cleared: boolean, children: ReactNode) {
  return createElement(FinckeWaveClearedContext, { value: cleared }, children);
}
