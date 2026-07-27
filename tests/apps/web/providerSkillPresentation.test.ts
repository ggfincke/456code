import { describe, expect, it } from "vite-plus/test";

import { formatProviderSkillInstallSource } from "../../../apps/web/src/providerSkillPresentation";

describe("formatProviderSkillInstallSource", () => {
  it("marks plugin-backed skills as app installs", () => {
    expect(
      formatProviderSkillInstallSource({
        path: "/Users/julius/.codex/plugins/cache/openai-curated/github/skills/gh-fix-ci/SKILL.md",
        scope: "user",
      }),
    ).toBe("App");
  });
});
