// apps/web/src/components/preview/previewBridge.ts
// expose preview bridge

// resolved once at import time so React hooks don't pay for repeated
// `window.desktopBridge?.preview` lookups on every render. `null` on the web
// build where there's no Electron host.
export const previewBridge =
  typeof window === 'undefined' ? null : (window.desktopBridge?.preview ?? null)
