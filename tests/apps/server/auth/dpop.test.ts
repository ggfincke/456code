// tests/apps/server/auth/dpop.test.ts
// verifies DPoP replay error mapping and expiry pruning
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";

import * as ServerSecretStore from "../../../../apps/server/src/auth/ServerSecretStore.ts";
import {
  mapDpopReplayStoreError,
  pruneExpiredDpopReplayRecords,
} from "../../../../apps/server/src/auth/dpop.ts";

const storeFailure = (tag: "AlreadyExists" | "PermissionDenied") =>
  new ServerSecretStore.SecretStorePersistError({
    resource: "DPoP proof",
    cause: PlatformError.systemError({
      _tag: tag,
      module: "FileSystem",
      method: "open",
      pathOrDescriptor: "dpop-proof.bin",
    }),
  });

describe("pruneExpiredDpopReplayRecords", () => {
  it.effect("removes proofs outside the validity window and retains current proofs", () => {
    const records = new Map([
      ["dpop-proof-expired", new TextEncoder().encode("iat=699")],
      ["dpop-proof-boundary", new TextEncoder().encode("iat=700")],
      ["dpop-proof-current", new TextEncoder().encode("iat=999")],
      ["dpop-proof-malformed", new TextEncoder().encode("iat=invalid")],
      ["session-signing-key", new Uint8Array([1, 2, 3])],
    ]);
    const removed: string[] = [];
    const secretStore = ServerSecretStore.ServerSecretStore.of({
      get: (name) => {
        const value = records.get(name);
        return Effect.succeed(value === undefined ? Option.none() : Option.some(value));
      },
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
      listNames: (prefix) =>
        Effect.succeed([...records.keys()].filter((name) => name.startsWith(prefix))),
      remove: (name) =>
        Effect.sync(() => {
          records.delete(name);
          removed.push(name);
        }),
    });

    return pruneExpiredDpopReplayRecords(secretStore, 1_000).pipe(
      Effect.map(() => {
        expect(removed).toEqual(["dpop-proof-expired"]);
        expect([...records.keys()]).toEqual([
          "dpop-proof-boundary",
          "dpop-proof-current",
          "dpop-proof-malformed",
          "session-signing-key",
        ]);
      }),
    );
  });
});

describe("mapDpopReplayStoreError", () => {
  it("reports replay conflicts as invalid credentials", () => {
    const cause = storeFailure("AlreadyExists");
    const error = mapDpopReplayStoreError(cause);

    expect(error._tag).toBe("ServerAuthInvalidCredentialError");
    if (error._tag === "ServerAuthInvalidCredentialError") {
      expect(error.cause).toBe(cause);
    }
  });

  it("reports replay-store availability failures as internal errors", () => {
    const error = mapDpopReplayStoreError(storeFailure("PermissionDenied"));

    expect(error._tag).toBe("ServerAuthDpopReplayStateRecordError");
    if (error._tag === "ServerAuthDpopReplayStateRecordError") {
      expect(error.message).toBe("Failed to record DPoP proof replay state.");
    }
  });
});
