import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { ServerSelfUpdate } from "../cloud/selfUpdate.ts";
import { layer } from "./ReleaseUpdates.ts";

it.effect("rejects both update paths before progress or handoff", () =>
  Effect.gen(function* () {
    const updates = yield* ServerSelfUpdate;
    const forbidden = Effect.die("An isolated replacement cannot start an update handoff.");
    const operations = [
      updates.update(
        { targetVersion: "0.0.40" },
        () => forbidden,
        () => forbidden,
      ),
      updates.commitDesktopUpdate("verification", () => forbidden),
    ];
    for (const operation of operations) {
      const result = yield* Effect.result(operation);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure.reason).toContain("Updates are disabled");
    }
  }).pipe(Effect.provide(layer)),
);
