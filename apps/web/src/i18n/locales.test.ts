import { describe, expect, it } from "vite-plus/test";

import { resolveWebLocaleSelection } from "./locales";

describe("resolveWebLocaleSelection", () => {
  it.each([
    ["system", ["en-GB"], "en", undefined],
    ["system", ["zh-TW", "en-GB"], "en", undefined],
    ["en", ["en-GB"], "en", undefined],
    ["en", ["de-DE"], "en", "en"],
    ["de", ["de-DE"], "en", undefined],
  ] as const)("%s with browser languages %j", (language, browserLocales, catalog, formatting) => {
    expect(resolveWebLocaleSelection(language, browserLocales)).toEqual({
      catalogLocale: catalog,
      formattingLocale: formatting,
    });
  });
});
