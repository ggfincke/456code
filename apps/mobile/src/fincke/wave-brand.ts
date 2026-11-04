// apps/mobile/src/fincke/wave-brand.ts
// tracks when a wave band shows the brand, so the native title above it steps aside

import { useEffect, useSyncExternalStore } from "react";

// a count, not a flag: duo & ipad layouts can mount the home list & sidebar bands together
let shownCount = 0;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function setShownCount(next: number) {
  shownCount = next;
  for (const listener of listeners) listener();
}

export function useFinckeWaveBrandShown(): boolean {
  return useSyncExternalStore(subscribe, () => shownCount > 0);
}

export function useShowFinckeWaveBrand(active: boolean) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes this band's brand to native header titles rendered outside its tree
  useEffect(() => {
    if (!active) return;
    setShownCount(shownCount + 1);
    return () => setShownCount(shownCount - 1);
  }, [active]);
}
