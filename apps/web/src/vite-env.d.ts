// apps/web/src/vite-env.d.ts
// declares public web build settings

/// <reference types="vite-plus/client" />

import type { DesktopBridge } from "@t3tools/contracts";

interface ImportMetaEnv {
  readonly VITE_HTTP_URL: string;
  readonly VITE_WS_URL: string;
  readonly VITE_HOSTED_APP_URL: string;
  readonly VITE_HOSTED_APP_CHANNEL: string;
  readonly VITE_RELEASE_CHANNEL: string;
  readonly T3CODE_DESKTOP_UPDATE_REPOSITORY: string;
  readonly APP_VERSION: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare global {
  interface Window {
    desktopBridge?: DesktopBridge;
  }
}
