// apps/web/src/fincke/useFinckeOcean.ts
// reports whether fincke ocean is the rendered theme so restructured fork components stay out of other themes
import { useSyncExternalStore } from "react";

// css can scope colors, but a different component structure needs the answer in render
function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme-id"],
  });
  return () => observer.disconnect();
}

function isFinckeOcean(): boolean {
  return document.documentElement.dataset.themeId === "fincke-ocean";
}

export function useFinckeOcean(): boolean {
  return useSyncExternalStore(subscribe, isFinckeOcean, () => false);
}
