import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { createBuildConfig } from "./build-desktop-artifact.ts";

it.effect("packages a separate app and protocol without any update publication target", () =>
  Effect.gen(function* () {
    for (const platform of ["mac", "linux", "win"] as const) {
      const config = yield* createBuildConfig(
        platform,
        platform === "mac" ? "dmg" : platform === "linux" ? "AppImage" : "nsis",
        "0.0.40",
        false,
        true,
        3000,
        undefined,
        false,
        "arm64",
        true,
      ).pipe(Effect.provide(NodeServices.layer));
      expect(config.appId).toBe("com.ggfincke.456code.thin");
      expect(config.productName).toBe("456code (Alpha)");
      expect(config.publish).toBeNull();
      expect((config[platform] as { protocols: unknown }).protocols).toEqual([
        { name: "456code", schemes: ["code456-thin", "code456-thin-dev"] },
      ]);
    }
  }),
);
