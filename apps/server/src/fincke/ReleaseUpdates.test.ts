// apps/server/src/fincke/ReleaseUpdates.test.ts
// verifies server updates only run through the hosting desktop app's staged build
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { ServerSelfUpdate } from "../cloud/selfUpdate.ts";
import { DesktopAppUpdate } from "../desktopUpdate/DesktopAppUpdate.ts";
import { layer } from "./ReleaseUpdates.ts";

const desktopAppUpdate = (available: boolean) =>
  Layer.succeed(DesktopAppUpdate, {
    available,
    run: () =>
      Effect.succeed({ targetVersion: "0.1.4321", method: "desktop-app" as const, updateId: "u1" }),
    commit: () => Effect.die("committed"),
  });

it.effect("rejects both update paths without a hosting desktop app", () =>
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
  }).pipe(Effect.provide(layer.pipe(Layer.provide(desktopAppUpdate(false))))),
);

it.effect("hands the update to the hosting desktop app", () =>
  Effect.gen(function* () {
    const updates = yield* ServerSelfUpdate;
    const result = yield* updates.update({ targetVersion: "0.1.4321" });
    expect(result).toEqual({ targetVersion: "0.1.4321", method: "desktop-app", updateId: "u1" });
  }).pipe(Effect.provide(layer.pipe(Layer.provide(desktopAppUpdate(true))))),
);
