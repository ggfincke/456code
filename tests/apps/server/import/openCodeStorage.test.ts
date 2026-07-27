// tests/apps/server/import/openCodeStorage.test.ts
// verifies opencode storage filesystem and resource boundaries
// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { loadOpenCodeSessionFromMetadata } from "../../../../apps/server/src/import/openCodeStorage.ts";
import { IMPORT_SCAN_MAX_TRAVERSAL_ENTRIES } from "../../../../apps/server/src/import/resourceLimits.ts";

const fixtureRoot = NodePath.resolve(NodeURL.fileURLToPath(new URL("./fixtures", import.meta.url)));
const temporaryPaths: string[] = [];

async function temporaryStorage(): Promise<string> {
  const temporaryRoot = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "456code-opencode-storage-"),
  );
  temporaryPaths.push(temporaryRoot);
  const storageRoot = NodePath.join(temporaryRoot, "storage");
  await NodeFSP.cp(NodePath.join(fixtureRoot, "opencode", "storage"), storageRoot, {
    recursive: true,
  });
  return storageRoot;
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => NodeFSP.rm(path, { recursive: true, force: true })),
  );
});

describe("OpenCode storage resource limits", () => {
  it.effect(
    "counts non-JSON entries against the default import traversal limit",
    () =>
      Effect.gen(function* () {
        const storageRoot = yield* Effect.promise(() => temporaryStorage());
        const messageDirectory = NodePath.join(storageRoot, "message", "ses_imported");
        const canonicalMessageDirectory = yield* Effect.promise(() =>
          NodeFSP.realpath(messageDirectory),
        );
        yield* Effect.promise(async () => {
          for (let start = 0; start < IMPORT_SCAN_MAX_TRAVERSAL_ENTRIES; start += 250) {
            await Promise.all(
              Array.from(
                {
                  length: Math.min(250, IMPORT_SCAN_MAX_TRAVERSAL_ENTRIES - start),
                },
                (_, offset) =>
                  NodeFSP.writeFile(
                    NodePath.join(
                      messageDirectory,
                      `ignored-${(start + offset).toString().padStart(5, "0")}.txt`,
                    ),
                    "",
                  ),
              ),
            );
          }
        });

        const sourcePath = NodePath.join(
          storageRoot,
          "session",
          "prj_fixture",
          "ses_imported.json",
        );
        const result = yield* loadOpenCodeSessionFromMetadata(sourcePath).pipe(Effect.result);

        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure).toMatchObject({
            operation: "discover",
            sourcePath: canonicalMessageDirectory,
            detail: `OpenCode traversal exceeds ${IMPORT_SCAN_MAX_TRAVERSAL_ENTRIES} filesystem entries`,
          });
        }
      }),
    30_000,
  );
});
