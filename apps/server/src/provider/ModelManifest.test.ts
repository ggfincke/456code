import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as ModelCatalog from "@t3tools/provider-core/server/ModelCatalog";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ModelManifest from "./ModelManifest.ts";

describe("resolveProviderCatalog", () => {
  it.each([
    { releasedAt: "2026-01-01", now: "2026-01-01T00:00:00Z", badge: "new" },
    { releasedAt: "2026-01-01", now: "2026-01-07T23:59:59.999Z", badge: "new" },
    { releasedAt: "2026-01-01", now: "2026-01-08T00:00:00Z", badge: undefined },
    { releasedAt: "2026-01-01", now: "2026-02-01T00:00:00Z", badge: undefined },
    { releasedAt: "2026-01-02T00:00:00Z", now: "2026-01-01T00:00:00Z", badge: undefined },
    { releasedAt: undefined, now: "2026-01-01T00:00:00Z", badge: undefined },
    { releasedAt: "invalid", now: "2026-01-01T00:00:00Z", badge: undefined },
  ])("derives the new badge from releasedAt=$releasedAt at $now", ({ releasedAt, now, badge }) => {
    const manifest: ModelManifest.ModelManifestData = {
      version: 1,
      currentModels: {},
      providers: {
        synthetic: {
          profiles: {},
          models: [
            {
              slug: "model-next",
              name: "Model Next",
              status: "current",
              ...(releasedAt === undefined ? {} : { releasedAt }),
            },
            {
              slug: "model-legacy",
              name: "Model Legacy",
              status: "legacy",
              releasedAt: now,
            },
          ],
        },
      },
    };
    const catalog = ModelManifest.resolveProviderCatalog(
      manifest,
      ProviderDriverKind.make("synthetic"),
      Date.parse(now),
    );
    assert.strictEqual(catalog?.models[0]?.badge, badge);
    assert.strictEqual(catalog?.models[1]?.badge, undefined);
  });

  it.effect("expires badges when rereading a cached manifest without a refresh", () => {
    const manifest: ModelManifest.ModelManifestData = {
      version: 1,
      currentModels: {},
      providers: {
        synthetic: {
          profiles: {},
          models: [
            {
              slug: "model-next",
              name: "Model Next",
              status: "current",
              releasedAt: "1970-01-01T00:00:00Z",
            },
          ],
        },
      },
    };
    return Effect.gen(function* () {
      const service = yield* ModelCatalog.ModelCatalog;
      const readCatalog = service.current(ProviderDriverKind.make("synthetic"));
      assert.strictEqual((yield* readCatalog)?.models[0]?.badge, "new");
      yield* TestClock.adjust("7 days");
      assert.strictEqual((yield* readCatalog)?.models[0]?.badge, undefined);
    }).pipe(
      Effect.provide(
        ModelManifest.layerModelCatalog.pipe(
          Layer.provide(
            Layer.succeed(ModelManifest.ModelManifest, {
              current: Effect.succeed(manifest),
              refresh: Effect.die("Catalog reads must not refresh the manifest"),
              forceRefresh: Effect.die("Catalog reads must not refresh the manifest"),
              refreshInBackground: Effect.die("Catalog reads must not refresh the manifest"),
            }),
          ),
        ),
      ),
    );
  });

  it("rejects invalid catalog references", () => {
    const invalidCatalog = (input: {
      readonly models: NonNullable<ModelManifest.ModelManifestData["providers"]>[string]["models"];
      readonly defaultChat?: string;
    }): ModelManifest.ModelManifestData => ({
      version: 1,
      currentModels: {},
      providers: {
        synthetic: {
          ...(input.defaultChat ? { defaults: { chat: input.defaultChat } } : {}),
          profiles: {},
          models: input.models,
        },
      },
    });

    for (const invalid of [
      invalidCatalog({
        models: [
          { slug: "duplicate", name: "First", status: "current" },
          { slug: "duplicate", name: "Second", status: "current" },
        ],
      }),
      invalidCatalog({
        models: [
          {
            slug: "missing-profile",
            name: "Missing Profile",
            status: "current",
            profile: "missing",
          },
        ],
      }),
      invalidCatalog({
        models: [{ slug: "present", name: "Present", status: "current" }],
        defaultChat: "absent",
      }),
    ]) {
      assert.isNull(
        ModelManifest.resolveProviderCatalog(invalid, ProviderDriverKind.make("synthetic")),
      );
    }
  });
});
