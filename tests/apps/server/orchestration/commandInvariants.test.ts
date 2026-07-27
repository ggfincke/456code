// tests/apps/server/orchestration/commandInvariants.test.ts
// verifies orchestration command invariants

import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";

import { requireNonNegativeInteger } from "../../../../apps/server/src/orchestration/commandInvariants.ts";

describe("commandInvariants", () => {
  it("requires non-negative integers", async () => {
    await Effect.runPromise(
      requireNonNegativeInteger({
        commandType: "thread.checkpoint.revert",
        field: "turnCount",
        value: 0,
      }),
    );

    await expect(
      Effect.runPromise(
        requireNonNegativeInteger({
          commandType: "thread.checkpoint.revert",
          field: "turnCount",
          value: -1,
        }),
      ),
    ).rejects.toThrow("greater than or equal to 0");
  });
});
