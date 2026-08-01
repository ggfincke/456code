// tests/apps/server/provider/Layers/ProviderEventLoggers.test.ts
// verifies shared rotating sink ownership for live provider event loggers
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

const sinkState = vi.hoisted(() => ({
  paths: new Array<string>(),
  chunks: new Array<string>(),
}));

vi.mock("@t3tools/shared/logging", () => ({
  RotatingFileSink: class {
    constructor(options: { readonly filePath: string }) {
      sinkState.paths.push(options.filePath);
    }

    write(chunk: string | Buffer): void {
      sinkState.chunks.push(String(chunk));
    }
  },
}));

import { ServerConfig } from "../../../../../apps/server/src/config.ts";
import {
  ProviderEventLoggers,
  ProviderEventLoggersLive,
} from "../../../../../apps/server/src/provider/Layers/ProviderEventLoggers.ts";

it.effect("uses one rotating sink for native and canonical records in the same file", () =>
  Effect.gen(function* () {
    sinkState.paths.length = 0;
    sinkState.chunks.length = 0;
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-owner-"));
    const providerEventLogPath = NodePath.join(tempDir, "provider-events.ndjson");

    try {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const loggers = yield* ProviderEventLoggers;
          assert.exists(loggers.native);
          assert.exists(loggers.canonical);
          if (!loggers.native || !loggers.canonical) {
            return;
          }

          yield* loggers.native.write({ id: "native" }, null);
          yield* loggers.canonical.write({ id: "canonical" }, null);
        }).pipe(Effect.provide(ProviderEventLoggersLive)),
      ).pipe(
        Effect.provideService(
          ServerConfig,
          ServerConfig.of({ providerEventLogPath } as ServerConfig["Service"]),
        ),
      );

      assert.deepEqual(sinkState.paths, [NodePath.join(tempDir, "_global.log")]);
      assert.equal(sinkState.chunks.length, 1);
    } finally {
      NodeFS.rmSync(tempDir, { recursive: true, force: true });
    }
  }),
);
