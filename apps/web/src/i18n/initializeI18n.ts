import { initializeGTSPA } from "gt-react";

import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "./locales";

// 456code ships English only (gt.config.json lists no locales), so no catalog is bundled.
async function loadTranslations(): Promise<unknown> {
  return {};
}

/** Sets up GT's singletons. `onLocaleRequest` receives GT's own locale changes. */
export function initializeI18n(onLocaleRequest: (locale: string) => void): void {
  void initializeGTSPA({
    defaultLocale: DEFAULT_LOCALE,
    locales: [...SUPPORTED_LOCALES],
    locale: DEFAULT_LOCALE,
    loadTranslations,
    // GT's default drops a catalog from its cache after 60 s; call-time `m()` reads that cache.
    cacheExpiryTime: null,
    _reload: (state) => onLocaleRequest(state.locale),
  });
}
