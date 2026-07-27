// tests/apps/server/import/continuation.test.ts
// verifies imported session continuation resolution and persisted binding shapes

import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import {
  IMPORT_RESULT_MESSAGE_MAX_CHARS,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type ProviderDriverKind as ProviderDriverKindType,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { describe } from "vite-plus/test";

import {
  IMPORT_CONTINUATION_PRESERVED_BINDING_REASON,
  type ContinuationRequest,
} from "../../../../apps/server/src/import/continuationContract.ts";
import {
  ImportContinuationDepError,
  makeImportContinuation,
  type ImportContinuationFactoryDeps,
  type ResolvedContinuationInstance,
} from "../../../../apps/server/src/import/continuation.ts";
import type { ImportedSessionMeta } from "../../../../apps/server/src/import/types.ts";
import type { ProviderRuntimeBinding } from "../../../../apps/server/src/provider/Services/ProviderSessionDirectory.ts";

const THREAD_ID = ThreadId.make("imported-thread");
const CODEX_INSTANCE_ID = ProviderInstanceId.make("codex-work");
const CLAUDE_INSTANCE_ID = ProviderInstanceId.make("claude-work");
const OPENCODE_INSTANCE_ID = ProviderInstanceId.make("opencode-work");
const CURSOR_INSTANCE_ID = ProviderInstanceId.make("cursor-work");
const CLAUDE_SESSION_ID = "123e4567-e89b-12d3-a456-426614174000";

function continuationIdentity(driverKind: string, instanceId: ProviderInstanceId) {
  const driver = ProviderDriverKind.make(driverKind);
  return {
    driverKind: driver,
    continuationKey: `${driver}:instance:${instanceId}`,
  };
}

function driverForSource(source: ImportedSessionMeta["source"]): string {
  switch (source) {
    case "codex-cli":
      return "codex";
    case "claude-code":
      return "claudeAgent";
    case "opencode":
      return "opencode";
    case "cursor":
      return "cursor";
    case "grok":
      return "grok";
  }
}

function makeMeta(overrides: Partial<ImportedSessionMeta> = {}): ImportedSessionMeta {
  return {
    source: "codex-cli",
    sourcePath:
      "/provider-home/sessions/2026/01/01/rollout-2026-01-01T00-00-00-native-session.jsonl",
    contentHash: "content-hash",
    nativeSessionId: "native-session",
    cwd: "/workspace/project",
    gitBranch: null,
    model: "gpt-5.4",
    title: null,
    firstActivityAt: null,
    lastActivityAt: null,
    ...overrides,
  };
}

function makeRequest(
  meta: ImportedSessionMeta,
  providerInstanceId: ProviderInstanceId = CODEX_INSTANCE_ID,
  selection: ModelSelection = {
    instanceId: providerInstanceId,
    model: "gpt-5.4",
  },
): ContinuationRequest {
  return {
    threadId: THREAD_ID,
    meta,
    providerInstanceId,
    modelSelection: selection,
    runtimeMode: "approval-required",
  };
}

function makeHarness(overrides: Partial<ImportContinuationFactoryDeps> = {}) {
  const resolutions: Array<{
    driverKind: ProviderDriverKindType;
    instanceId: ProviderInstanceId;
  }> = [];
  const bindings: ProviderRuntimeBinding[] = [];
  let currentBinding: ProviderRuntimeBinding | null = null;
  const deps: ImportContinuationFactoryDeps = {
    resolveInstance: (driverKind, instanceId) => {
      resolutions.push({ driverKind, instanceId });
      const resolved: ResolvedContinuationInstance = {
        instanceId,
        continuationIdentity: continuationIdentity(driverKind, instanceId),
      };
      return Effect.succeed(resolved);
    },
    verifySource: ({ source, providerInstanceId }) =>
      Effect.succeed(continuationIdentity(driverForSource(source), providerInstanceId)),
    getBinding: () => Effect.succeed(currentBinding),
    upsert: (binding) =>
      Effect.sync(() => {
        bindings.push(binding);
        currentBinding = binding;
      }),
    ...overrides,
  };
  return {
    continuation: makeImportContinuation(deps),
    resolutions,
    bindings,
  };
}

describe("makeImportContinuation", () => {
  it.effect("passes the exact requested instance to resolution", () =>
    Effect.gen(function* () {
      const harness = makeHarness();

      yield* harness.continuation.bind(
        makeRequest(makeMeta(), ProviderInstanceId.make("codex-explicit")),
      );

      NodeAssert.deepStrictEqual(harness.resolutions, [
        {
          driverKind: ProviderDriverKind.make("codex"),
          instanceId: ProviderInstanceId.make("codex-explicit"),
        },
      ]);
    }),
  );

  it.effect("returns a history-only outcome when no matching instance exists", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        resolveInstance: () => Effect.succeed(null),
      });

      const outcome = yield* harness.continuation.bind(makeRequest(makeMeta()));

      NodeAssert.deepStrictEqual(outcome, {
        state: "history-only",
        providerInstanceId: CODEX_INSTANCE_ID,
        continuationIdentity: null,
        reason: `provider instance '${CODEX_INSTANCE_ID}' is not available for codex`,
      });
      NodeAssert.deepStrictEqual(harness.bindings, []);
    }),
  );

  it.effect("rejects a Codex rollout without a native session id", () =>
    Effect.gen(function* () {
      let verifySourceCalled = false;
      const harness = makeHarness({
        verifySource: ({ source, providerInstanceId }) =>
          Effect.sync(() => {
            verifySourceCalled = true;
          }).pipe(Effect.as(continuationIdentity(driverForSource(source), providerInstanceId))),
      });

      const outcome = yield* harness.continuation.bind(
        makeRequest(makeMeta({ nativeSessionId: null })),
      );

      NodeAssert.deepStrictEqual(outcome, {
        state: "history-only",
        providerInstanceId: CODEX_INSTANCE_ID,
        continuationIdentity: continuationIdentity("codex", CODEX_INSTANCE_ID),
        reason: "rollout has no session id",
      });
      NodeAssert.equal(verifySourceCalled, false);
      NodeAssert.deepStrictEqual(harness.bindings, []);
    }),
  );

  it.effect("turns missing rollout files into a history-only outcome", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        verifySource: () =>
          Effect.fail(new ImportContinuationDepError({ message: "rollout file missing" })),
      });

      const outcome = yield* harness.continuation.bind(makeRequest(makeMeta()));

      NodeAssert.deepStrictEqual(outcome, {
        state: "history-only",
        providerInstanceId: CODEX_INSTANCE_ID,
        continuationIdentity: continuationIdentity("codex", CODEX_INSTANCE_ID),
        reason: "rollout file missing",
      });
      NodeAssert.deepStrictEqual(harness.bindings, []);
    }),
  );

  it.effect("rejects a catalog source identity that differs from the live route", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        verifySource: () =>
          Effect.succeed({
            driverKind: ProviderDriverKind.make("codex"),
            continuationKey: "codex:file:v1:catalog-source",
          }),
      });

      const outcome = yield* harness.continuation.bind(makeRequest(makeMeta()));

      NodeAssert.deepStrictEqual(outcome, {
        state: "history-only",
        providerInstanceId: CODEX_INSTANCE_ID,
        continuationIdentity: continuationIdentity("codex", CODEX_INSTANCE_ID),
        reason: `provider instance '${CODEX_INSTANCE_ID}' no longer targets the imported continuation source`,
      });
      NodeAssert.deepStrictEqual(harness.bindings, []);
    }),
  );

  it.effect("preserves the prior marker when binding state cannot be read", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        getBinding: () =>
          Effect.fail(new ImportContinuationDepError({ message: "binding read failed" })),
      });

      const outcome = yield* harness.continuation.bind(makeRequest(makeMeta()));

      NodeAssert.deepStrictEqual(outcome, {
        state: "history-only",
        providerInstanceId: CODEX_INSTANCE_ID,
        continuationIdentity: null,
        reason:
          "the thread already has a newer or different provider binding; that binding was preserved",
      });
      NodeAssert.deepStrictEqual(harness.resolutions, []);
      NodeAssert.deepStrictEqual(harness.bindings, []);
    }),
  );

  it.effect("refuses a Codex cursor that does not match the rollout filename", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const outcome = yield* harness.continuation.bind(
        makeRequest(
          makeMeta({
            sourcePath:
              "/provider-home/sessions/2026/01/01/rollout-2026-01-01T00-00-00-other-session.jsonl",
          }),
        ),
      );

      NodeAssert.deepStrictEqual(outcome, {
        state: "history-only",
        providerInstanceId: CODEX_INSTANCE_ID,
        continuationIdentity: continuationIdentity("codex", CODEX_INSTANCE_ID),
        reason: "codex session id does not match the rollout filename",
      });
      NodeAssert.deepStrictEqual(harness.bindings, []);
    }),
  );

  it.effect("persists the verified Codex cursor and exact model selection", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const outcome = yield* harness.continuation.bind(makeRequest(makeMeta()));

      NodeAssert.deepStrictEqual(outcome, {
        state: "verified",
        providerInstanceId: CODEX_INSTANCE_ID,
        continuationIdentity: continuationIdentity("codex", CODEX_INSTANCE_ID),
        reason: null,
      });
      NodeAssert.deepStrictEqual(harness.bindings, [
        {
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: CODEX_INSTANCE_ID,
          adapterKey: ProviderDriverKind.make("codex"),
          status: "stopped",
          runtimeMode: "approval-required",
          resumeCursor: { threadId: "native-session", requireExisting: true },
          runtimePayload: {
            cwd: "/workspace/project",
            modelSelection: {
              instanceId: CODEX_INSTANCE_ID,
              model: "gpt-5.4",
            },
            continuationIdentity: continuationIdentity("codex", CODEX_INSTANCE_ID),
          },
        },
      ]);
    }),
  );

  it.effect("preserves an existing imported binding across an exact rebind", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const request = makeRequest(makeMeta());

      const first = yield* harness.continuation.bind(request);
      const second = yield* harness.continuation.bind(request);

      NodeAssert.deepStrictEqual(first, {
        state: "verified",
        providerInstanceId: CODEX_INSTANCE_ID,
        continuationIdentity: continuationIdentity("codex", CODEX_INSTANCE_ID),
        reason: null,
      });
      NodeAssert.deepStrictEqual(second, first);
      NodeAssert.equal(harness.bindings.length, 1);
    }),
  );

  it.effect("refreshes a pristine stopped binding when its runtime payload changes", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const originalRequest = makeRequest(makeMeta());
      const refreshedRequest = makeRequest(
        makeMeta({
          cwd: "/workspace/project-renamed",
          model: "gpt-5.5",
        }),
        CODEX_INSTANCE_ID,
        {
          instanceId: CODEX_INSTANCE_ID,
          model: "gpt-5.5",
        },
      );

      yield* harness.continuation.bind(originalRequest);
      const refreshed = yield* harness.continuation.bind(refreshedRequest);

      NodeAssert.deepStrictEqual(refreshed, {
        state: "verified",
        providerInstanceId: CODEX_INSTANCE_ID,
        continuationIdentity: continuationIdentity("codex", CODEX_INSTANCE_ID),
        reason: null,
      });
      NodeAssert.equal(harness.bindings.length, 2);
      NodeAssert.deepStrictEqual(harness.bindings[1]?.runtimePayload, {
        cwd: "/workspace/project-renamed",
        modelSelection: {
          instanceId: CODEX_INSTANCE_ID,
          model: "gpt-5.5",
        },
        continuationIdentity: continuationIdentity("codex", CODEX_INSTANCE_ID),
      });
    }),
  );

  it.effect("preserves a matching binding when re-verification fails", () =>
    Effect.gen(function* () {
      let failVerification = false;
      const harness = makeHarness({
        verifySource: ({ source, providerInstanceId }) =>
          failVerification
            ? Effect.fail(
                new ImportContinuationDepError({
                  message: "source disappeared during re-verification",
                }),
              )
            : Effect.succeed(continuationIdentity(driverForSource(source), providerInstanceId)),
      });
      const request = makeRequest(makeMeta());

      yield* harness.continuation.bind(request);
      failVerification = true;
      const outcome = yield* harness.continuation.bind(request);

      NodeAssert.deepStrictEqual(outcome, {
        state: "history-only",
        providerInstanceId: CODEX_INSTANCE_ID,
        continuationIdentity: continuationIdentity("codex", CODEX_INSTANCE_ID),
        reason:
          "the thread already has a newer or different provider binding; that binding was preserved",
      });
      NodeAssert.equal(harness.bindings.length, 1);
    }),
  );

  it.effect("preserves a binding as history-only while its exact provider is unavailable", () =>
    Effect.gen(function* () {
      let providerAvailable = true;
      const harness = makeHarness({
        resolveInstance: (_driverKind, instanceId) =>
          Effect.succeed(
            providerAvailable
              ? {
                  instanceId,
                  continuationIdentity: continuationIdentity("codex", instanceId),
                }
              : null,
          ),
      });
      const request = makeRequest(makeMeta());

      const first = yield* harness.continuation.bind(request);
      providerAvailable = false;
      const duringOutage = yield* harness.continuation.bind(request);

      NodeAssert.deepStrictEqual(first, {
        state: "verified",
        providerInstanceId: CODEX_INSTANCE_ID,
        continuationIdentity: continuationIdentity("codex", CODEX_INSTANCE_ID),
        reason: null,
      });
      NodeAssert.deepStrictEqual(duringOutage, {
        state: "history-only",
        providerInstanceId: CODEX_INSTANCE_ID,
        continuationIdentity: continuationIdentity("codex", CODEX_INSTANCE_ID),
        reason: IMPORT_CONTINUATION_PRESERVED_BINDING_REASON,
      });
      NodeAssert.equal(harness.bindings.length, 1);
    }),
  );

  it.effect("never overwrites a newer provider binding during re-import", () =>
    Effect.gen(function* () {
      let upsertCalled = false;
      const harness = makeHarness({
        getBinding: () =>
          Effect.succeed({
            threadId: THREAD_ID,
            provider: ProviderDriverKind.make("opencode"),
            providerInstanceId: OPENCODE_INSTANCE_ID,
            adapterKey: ProviderDriverKind.make("opencode"),
            status: "stopped",
            runtimeMode: "full-access",
            resumeCursor: {
              schemaVersion: 1,
              sessionId: "ses_newer",
              requireExisting: true,
            },
            runtimePayload: {
              cwd: "/workspace/project",
            },
          }),
        upsert: () =>
          Effect.sync(() => {
            upsertCalled = true;
          }),
      });

      const outcome = yield* harness.continuation.bind(makeRequest(makeMeta()));

      NodeAssert.deepStrictEqual(outcome, {
        state: "history-only",
        providerInstanceId: CODEX_INSTANCE_ID,
        continuationIdentity: null,
        reason:
          "the thread already has a newer or different provider binding; that binding was preserved",
      });
      NodeAssert.equal(upsertCalled, false);
    }),
  );

  it.effect("refuses a model selection targeting another instance", () =>
    Effect.gen(function* () {
      const harness = makeHarness();

      const otherInstance = ProviderInstanceId.make("codex-other");
      const outcome = yield* harness.continuation.bind(
        makeRequest(makeMeta(), CODEX_INSTANCE_ID, {
          instanceId: otherInstance,
          model: "gpt-5.4",
        }),
      );

      NodeAssert.deepStrictEqual(outcome, {
        state: "history-only",
        providerInstanceId: CODEX_INSTANCE_ID,
        continuationIdentity: continuationIdentity("codex", CODEX_INSTANCE_ID),
        reason: `model selection targets '${otherInstance}', expected '${CODEX_INSTANCE_ID}'`,
      });
      NodeAssert.deepStrictEqual(harness.bindings, []);
    }),
  );

  it.effect("rejects Claude resume ids that do not match the adapter UUID rule", () =>
    Effect.gen(function* () {
      const harness = makeHarness();

      const outcome = yield* harness.continuation.bind(
        makeRequest(
          makeMeta({
            source: "claude-code",
            sourcePath:
              "/provider-home/projects/workspace/00000000-0000-0000-0000-000000000000.jsonl",
            nativeSessionId: "00000000-0000-0000-0000-000000000000",
          }),
          CLAUDE_INSTANCE_ID,
          {
            instanceId: CLAUDE_INSTANCE_ID,
            model: "claude-opus-4-1",
          },
        ),
      );

      NodeAssert.deepStrictEqual(outcome, {
        state: "history-only",
        providerInstanceId: CLAUDE_INSTANCE_ID,
        continuationIdentity: continuationIdentity("claudeAgent", CLAUDE_INSTANCE_ID),
        reason: "claude session id is not a uuid",
      });
      NodeAssert.deepStrictEqual(harness.bindings, []);
    }),
  );

  it.effect("persists the Claude resume cursor and runtime payload", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const outcome = yield* harness.continuation.bind(
        makeRequest(
          makeMeta({
            source: "claude-code",
            sourcePath: `/provider-home/projects/workspace/${CLAUDE_SESSION_ID}.jsonl`,
            nativeSessionId: CLAUDE_SESSION_ID,
            model: "claude-opus-4-1",
          }),
          CLAUDE_INSTANCE_ID,
          {
            instanceId: CLAUDE_INSTANCE_ID,
            model: "claude-opus-4-1",
          },
        ),
      );

      NodeAssert.deepStrictEqual(outcome, {
        state: "verified",
        providerInstanceId: CLAUDE_INSTANCE_ID,
        continuationIdentity: continuationIdentity("claudeAgent", CLAUDE_INSTANCE_ID),
        reason: null,
      });
      NodeAssert.deepStrictEqual(harness.bindings, [
        {
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: CLAUDE_INSTANCE_ID,
          adapterKey: ProviderDriverKind.make("claudeAgent"),
          status: "stopped",
          runtimeMode: "approval-required",
          resumeCursor: {
            threadId: THREAD_ID,
            resume: CLAUDE_SESSION_ID,
          },
          runtimePayload: {
            cwd: "/workspace/project",
            modelSelection: {
              instanceId: CLAUDE_INSTANCE_ID,
              model: "claude-opus-4-1",
            },
            continuationIdentity: continuationIdentity("claudeAgent", CLAUDE_INSTANCE_ID),
          },
        },
      ]);
    }),
  );

  it.effect("refuses a Claude cursor that does not match the transcript filename", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const outcome = yield* harness.continuation.bind(
        makeRequest(
          makeMeta({
            source: "claude-code",
            sourcePath:
              "/provider-home/projects/workspace/123e4567-e89b-12d3-a456-426614174001.jsonl",
            nativeSessionId: CLAUDE_SESSION_ID,
          }),
          CLAUDE_INSTANCE_ID,
          {
            instanceId: CLAUDE_INSTANCE_ID,
            model: "claude-opus-4-1",
          },
        ),
      );

      NodeAssert.deepStrictEqual(outcome, {
        state: "history-only",
        providerInstanceId: CLAUDE_INSTANCE_ID,
        continuationIdentity: continuationIdentity("claudeAgent", CLAUDE_INSTANCE_ID),
        reason: "claude session id does not match the transcript filename",
      });
      NodeAssert.deepStrictEqual(harness.bindings, []);
    }),
  );

  it.effect("persists a fail-closed OpenCode resume cursor", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const outcome = yield* harness.continuation.bind(
        makeRequest(
          makeMeta({
            source: "opencode",
            sourcePath: "/provider-data/opencode/storage/session/project/ses_imported.json",
            nativeSessionId: "ses_imported",
            model: "openai/gpt-5.2",
          }),
          OPENCODE_INSTANCE_ID,
          {
            instanceId: OPENCODE_INSTANCE_ID,
            model: "openai/gpt-5.2",
          },
        ),
      );

      NodeAssert.deepStrictEqual(outcome, {
        state: "verified",
        providerInstanceId: OPENCODE_INSTANCE_ID,
        continuationIdentity: continuationIdentity("opencode", OPENCODE_INSTANCE_ID),
        reason: null,
      });
      NodeAssert.deepStrictEqual(harness.bindings, [
        {
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("opencode"),
          providerInstanceId: OPENCODE_INSTANCE_ID,
          adapterKey: ProviderDriverKind.make("opencode"),
          status: "stopped",
          runtimeMode: "approval-required",
          resumeCursor: {
            schemaVersion: 1,
            sessionId: "ses_imported",
            requireExisting: true,
          },
          runtimePayload: {
            cwd: "/workspace/project",
            modelSelection: {
              instanceId: OPENCODE_INSTANCE_ID,
              model: "openai/gpt-5.2",
            },
            continuationIdentity: continuationIdentity("opencode", OPENCODE_INSTANCE_ID),
          },
        },
      ]);
    }),
  );

  it.effect("refuses an ACP source path that does not match its native session id", () =>
    Effect.gen(function* () {
      let verifySourceCalled = false;
      const harness = makeHarness({
        verifySource: ({ source, providerInstanceId }) =>
          Effect.sync(() => {
            verifySourceCalled = true;
          }).pipe(Effect.as(continuationIdentity(driverForSource(source), providerInstanceId))),
      });
      const outcome = yield* harness.continuation.bind(
        makeRequest(
          makeMeta({
            source: "cursor",
            sourcePath: "acp://cursor/different-session",
            nativeSessionId: "native-session",
            model: "cursor-model",
          }),
          CURSOR_INSTANCE_ID,
          {
            instanceId: CURSOR_INSTANCE_ID,
            model: "cursor-model",
          },
        ),
      );

      NodeAssert.deepStrictEqual(outcome, {
        state: "history-only",
        providerInstanceId: CURSOR_INSTANCE_ID,
        continuationIdentity: continuationIdentity("cursor", CURSOR_INSTANCE_ID),
        reason: "cursor session id does not match the ACP source path",
      });
      NodeAssert.equal(verifySourceCalled, false);
      NodeAssert.deepStrictEqual(harness.bindings, []);
    }),
  );

  it.effect("bounds dependency failure reasons before returning them", () =>
    Effect.gen(function* () {
      const persistenceHarness = makeHarness({
        upsert: () =>
          Effect.fail(new ImportContinuationDepError({ message: "binding write failed" })),
      });
      const persistenceOutcome = yield* persistenceHarness.continuation.bind(
        makeRequest(makeMeta()),
      );
      NodeAssert.deepStrictEqual(persistenceOutcome, {
        state: "history-only",
        providerInstanceId: CODEX_INSTANCE_ID,
        continuationIdentity: continuationIdentity("codex", CODEX_INSTANCE_ID),
        reason: "binding write failed",
      });

      const oversizedReason = "x".repeat(IMPORT_RESULT_MESSAGE_MAX_CHARS + 500);
      const boundedHarness = makeHarness({
        upsert: () => Effect.fail(new ImportContinuationDepError({ message: oversizedReason })),
      });

      const outcome = yield* boundedHarness.continuation.bind(makeRequest(makeMeta()));

      NodeAssert.equal(outcome.state, "history-only");
      if (outcome.state !== "history-only") return;
      NodeAssert.equal(outcome.reason.length, IMPORT_RESULT_MESSAGE_MAX_CHARS);
      NodeAssert.equal(outcome.reason.endsWith("…"), true);
    }),
  );
});
