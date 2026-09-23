// tests/apps/server/textGeneration/CoralTextGeneration.test.ts
// protects coral title context and refinement across the real cli boundary

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { CoralSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { makeCoralTextGeneration } from "../../../../apps/server/src/textGeneration/CoralTextGeneration.ts";
import { writeFakeCli } from "../../../../apps/server/src/testUtils/fakeCli.ts";

it.effect("forwards title context and preserves refinement from a real child process", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "coral-title-" });
    const promptFile = `${dir}/received-prompt`;
    const binaryPath = writeFakeCli({
      directory: dir,
      name: "coral-title",
      env: { CORAL_TEST_PROMPT: promptFile },
      source: `
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
writeFileSync(process.env.CORAL_TEST_PROMPT, readFileSync(args[args.indexOf("--prompt-file") + 1]));
console.log(JSON.stringify({ version: 1, status: "completed", response: JSON.stringify({ title: "Repair title context", needsRefinement: true }) }));
`,
    });
    const settings = yield* Schema.decodeUnknownEffect(CoralSettings)({
      enabled: true,
      binaryPath,
    });
    const service = yield* makeCoralTextGeneration(settings);
    const result = yield* service.generateThreadTitle({
      cwd: dir,
      message: "Fix the linked issue",
      linkedContext: "Issue 42: preserve task title context",
      previousTitle: "Investigate unresolved link",
      modelSelection: { instanceId: ProviderInstanceId.make("coral-test"), model: "fixture" },
    });
    const prompt = yield* fs.readFileString(promptFile);
    expect(prompt).toContain("Issue 42: preserve task title context");
    expect(prompt).toContain("Investigate unresolved link");
    expect(result).toEqual({ title: "Repair title context", needsRefinement: true });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), TestClock.withLive),
);
