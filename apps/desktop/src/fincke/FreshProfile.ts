import { EnvironmentThemeFile } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import palette from "../../../../assets/fincke/fincke-ocean.json" with { type: "json" };
import { DesktopEnvironment } from "../app/DesktopEnvironment.ts";
import { isFinckeDesktop } from "./build.ts";

const encodePalette = Schema.encodeEffect(Schema.fromJsonString(EnvironmentThemeFile));
const decodePalette = Schema.decodeUnknownEffect(EnvironmentThemeFile);
const encodeSettings = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      defaultTheme: Schema.String,
      defaultThemeSetAt: Schema.String,
    }),
  ),
);

export const seedFreshProfile = Effect.fn("fincke.seedFreshProfile")(function* (stateDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settings = path.join(stateDir, "settings.json");
  // Existing settings or conversations make this an established profile, even if it has no theme.
  if ((yield* fs.exists(settings)) || (yield* fs.exists(path.join(stateDir, "state.sqlite"))))
    return;
  const themes = path.join(stateDir, "themes");
  yield* fs.makeDirectory(themes, { recursive: true });
  yield* fs
    .writeFileString(
      path.join(themes, "fincke-ocean.json"),
      yield* encodePalette(yield* decodePalette(palette)),
      { flag: "wx" },
    )
    .pipe(Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.void));
  const now = yield* DateTime.now;
  yield* fs
    .writeFileString(
      settings,
      yield* encodeSettings({
        defaultTheme: "fincke-ocean",
        defaultThemeSetAt: DateTime.formatIso(now),
      }),
      { flag: "wx" },
    )
    .pipe(Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.void));
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!isFinckeDesktop) return;
    const environment = yield* DesktopEnvironment;
    yield* seedFreshProfile(environment.stateDir);
  }),
);
