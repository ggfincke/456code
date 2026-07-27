// tests/apps/server/provider/Drivers/ClaudeHome.test.ts
// verifies Claude home, environment, cache, and continuation source resolution
import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  resolveClaudeHomePath,
} from "../../../../../apps/server/src/provider/Drivers/ClaudeHome.ts";
import {
  fileContinuationIdentity,
  resolveClaudeProjectsRoot,
} from "../../../../../apps/server/src/provider/continuationIdentity.ts";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect("uses the process home when no Claude home override is configured", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir());

        expect(yield* resolveClaudeHomePath({ homePath: "" })).toBe(resolved);
        expect(yield* makeClaudeEnvironment({ homePath: "" })).toBe(process.env);
      }),
    );

    it.effect("resolves configured Claude HOME and stamps continuation/cache keys with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        expect((yield* makeClaudeEnvironment({ homePath })).CLAUDE_CONFIG_DIR).toBe(resolved);
        expect(yield* makeClaudeContinuationGroupKey({ homePath })).toBe(
          fileContinuationIdentity(CLAUDE_DRIVER, resolveClaudeProjectsRoot({ homePath }))
            .continuationKey,
        );
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath })).toBe(
          `claude\0${resolved}\0`,
        );
      }),
    );

    it.effect("resolves relative runtime homes against the same configured cwd as identity", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const cwd = path.resolve("/server/workspace");

        expect(yield* resolveClaudeHomePath({ homePath: ".claude-work" }, cwd)).toBe(
          path.join(cwd, ".claude-work"),
        );
        expect(
          (yield* makeClaudeEnvironment(
            { homePath: "" },
            { CLAUDE_CONFIG_DIR: ".claude-env" },
            cwd,
          )).CLAUDE_CONFIG_DIR,
        ).toBe(path.join(cwd, ".claude-env"));
        expect((yield* makeClaudeEnvironment({ homePath: "" }, { HOME: ".home" }, cwd)).HOME).toBe(
          path.join(cwd, ".home"),
        );
      }),
    );

    it.effect("separates capability probes by cwd", () =>
      Effect.gen(function* () {
        const config = { binaryPath: "claude", homePath: "" };
        const first = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-a");
        const second = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-b");
        expect(first).not.toBe(second);
      }),
    );

    it.effect("keeps continuation compatible across instances with the same Claude HOME", () =>
      Effect.gen(function* () {
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" })).toBe(
          fileContinuationIdentity(CLAUDE_DRIVER, resolveClaudeProjectsRoot({ homePath: "" }))
            .continuationKey,
        );
      }),
    );
  });
});
