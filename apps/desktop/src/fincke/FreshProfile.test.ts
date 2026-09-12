import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { seedFreshProfile } from "./FreshProfile.ts";

it.effect("seeds only a fresh profile and preserves subsequent user choices", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const settings = path.join(dir, "settings.json");
    yield* seedFreshProfile(dir);
    const original = yield* fs.readFileString(settings);
    expect(original).toContain('"defaultTheme":"fincke-ocean"');
    yield* fs.writeFileString(settings, '{"defaultTheme":"grove"}');
    yield* seedFreshProfile(dir);
    expect(yield* fs.readFileString(settings)).toBe('{"defaultTheme":"grove"}');
    yield* fs.remove(settings);
    yield* fs.writeFileString(path.join(dir, "state.sqlite"), "existing");
    yield* seedFreshProfile(dir);
    expect(yield* fs.exists(settings)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
