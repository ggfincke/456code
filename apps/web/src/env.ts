// apps/web/src/env.ts
// the preload script sets window.nativeApi via contextBridge before any web-app

// code executes, so this is reliable at module load time.
export const isElectron =
  typeof window !== 'undefined' &&
  (window.desktopBridge !== undefined || window.nativeApi !== undefined)
