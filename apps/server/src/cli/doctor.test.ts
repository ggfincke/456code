import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { runDoctor } from "./doctor.ts";
import { DatabaseMaintenance } from "../persistence/DatabaseMaintenance.ts";

it.effect("--fix reclaims space and keeps the V1 database, and --dry-run changes nothing", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const doctor = (dryRun: boolean) =>
      runDoctor("/test/statev2.sqlite", { fix: true, dryRun, interactive: false }).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            Layer.succeed(DatabaseMaintenance, {
              inspect: () =>
                Effect.succeed({
                  databaseBytes: 2000,
                  reclaimableBytes: 1000,
                  incrementalVacuumEnabled: false,
                  legacyDatabaseBytes: 4000,
                }),
              compact: () =>
                Effect.sync(() => {
                  calls.push("compact");
                  return {
                    beforeBytes: 2000,
                    afterBytes: 1000,
                    deletedEventCount: 1,
                    deletedReceiptCount: 0,
                  };
                }),
              removeLegacyDatabase: () => Effect.sync(() => calls.push("remove legacy")),
            }),
          ),
        ),
      );
    yield* doctor(true);
    assert.deepEqual(calls, []);
    yield* doctor(false);
    assert.deepEqual(calls, ["compact"]);
  }),
);
