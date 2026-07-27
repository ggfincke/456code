// tests/apps/server/provider/ProviderInstanceEnvironment.test.ts
// verifies provider environment merging across platform key semantics
import { describe, expect, it } from "vite-plus/test";

import {
  mergeProviderInstanceEnvironment,
  normalizeProviderProcessEnvironment,
} from "../../../../apps/server/src/provider/ProviderInstanceEnvironment.ts";

describe("mergeProviderInstanceEnvironment", () => {
  it("overrides inherited environment values and preserves empty strings", () => {
    expect(
      mergeProviderInstanceEnvironment(
        [
          { name: "OPENROUTER_API_KEY", value: "sk-or-test", sensitive: true },
          { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
        ],
        { ANTHROPIC_API_KEY: "inherited", PATH: "/bin" },
      ),
    ).toMatchObject({
      OPENROUTER_API_KEY: "sk-or-test",
      ANTHROPIC_API_KEY: "",
      PATH: "/bin",
    });
  });

  it("matches Windows child-process key deduplication and canonicalizes PATH names", () => {
    const merged = mergeProviderInstanceEnvironment(
      [
        { name: "CUSTOM_TOKEN", value: "account-b", sensitive: true },
        { name: "path", value: "configured-bin;C:\\Tools", sensitive: false },
      ],
      {
        Path: "relative-bin;C:\\Windows",
        PATHEXT: ".COM;.EXE",
        custom_token: "account-a",
      },
      "win32",
    );

    expect(merged).toEqual({
      CUSTOM_TOKEN: "account-b",
      PATH: "configured-bin;C:\\Tools",
      PATHEXT: ".COM;.EXE",
    });
    expect(
      normalizeProviderProcessEnvironment(
        {
          Path: "inherited",
          PATH: "explicit",
          pathext: ".cmd",
          PATHEXT: ".EXE",
        },
        "win32",
      ),
    ).toEqual({
      PATH: "explicit",
      PATHEXT: ".EXE",
    });
  });
});
