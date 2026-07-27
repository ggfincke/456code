// tests/apps/server/import/acpImport.test.ts
// verifies ACP catalog pagination, capability gates, and replay normalization
// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off

import * as NodeBuffer from "node:buffer";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import {
  AcpImportError,
  loadAcpImportSession,
  loadAcpImportSessionsBatch,
  makeAcpImportSourcePath,
  normalizeAcpSessionReplay,
  parseAcpImportSourcePath,
  scanAcpImportCatalog,
  scanAndLoadAcpImportCatalog,
} from "../../../../apps/server/src/import/acpImport.ts";
import {
  IMPORT_NORMALIZED_SESSION_MAX_BYTES,
  IMPORT_NORMALIZED_SESSION_MAX_RECORDS,
} from "../../../../apps/server/src/import/resourceLimits.ts";
import type * as EffectAcpSchema from "effect-acp/schema";

const currentDirectory = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(currentDirectory, "fixtures/acp-import-agent.ts");

async function makeAgentWrapper(options?: {
  readonly capabilityMode?: string;
  readonly behavior?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly ignoreSigterm?: boolean;
  readonly wrapperPidLogPath?: string;
  readonly spawnLogPath?: string;
}): Promise<string> {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "acp-import-agent-"));
  const wrapperPath = NodePath.join(directory, "acp-import-agent");
  const environment: Record<string, string> = {
    T3_ACP_IMPORT_CAPABILITIES: options?.capabilityMode ?? "all",
    T3_ACP_IMPORT_BEHAVIOR: options?.behavior ?? "normal",
    ...options?.environment,
  };
  const exports = Object.entries(environment)
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const pidLogCommand =
    environment.T3_ACP_PID_LOG_PATH === undefined
      ? ""
      : `printf '%s' "$$" > ${JSON.stringify(environment.T3_ACP_PID_LOG_PATH)}`;
  const spawnLogCommand =
    options?.spawnLogPath === undefined
      ? ""
      : `printf 'spawn\\n' >> ${JSON.stringify(options.spawnLogPath)}`;
  const wrapperPidLogCommand =
    options?.wrapperPidLogPath === undefined
      ? ""
      : `printf '%s' "$$" > ${JSON.stringify(options.wrapperPidLogPath)}`;
  const launchCommand =
    options?.ignoreSigterm === true
      ? `trap '' TERM
${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)} "$@" <&0 &
fixture_pid=$!
wait "$fixture_pid" || true
while :; do sleep 60; done`
      : `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)} "$@"`;
  await NodeFSP.writeFile(
    wrapperPath,
    `#!/bin/sh
${exports}
${pidLogCommand}
${spawnLogCommand}
${wrapperPidLogCommand}
${launchCommand}
`,
    "utf8",
  );
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

async function makeProtocolAgentWrapper(options: {
  readonly sessionId: string;
  readonly cwd: string;
  readonly title: string | null;
  readonly model: string;
  readonly failOperation?: "initialize" | "authenticate" | "session/list" | "session/load";
  readonly failureMessage?: string;
}): Promise<string> {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "acp-protocol-agent-"));
  const agentPath = NodePath.join(directory, "agent.mjs");
  const wrapperPath = NodePath.join(directory, "acp-protocol-agent");
  const configuration = JSON.stringify(options);
  await NodeFSP.writeFile(
    agentPath,
    `const configuration = ${configuration};
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const succeed = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id) => {
  const error = {
    code: -32603,
    message: configuration.failureMessage ?? "ACP fixture failure",
  };
  send({
    jsonrpc: "2.0",
    id,
    error: {
      _tag: "Cause",
      code: error.code,
      message: error.message,
      data: [{ _tag: "Fail", error }],
    },
  });
};
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  const lines = input.split("\\n");
  input = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const request = JSON.parse(line);
    if (request.method === configuration.failOperation) {
      fail(request.id);
      continue;
    }
    if (request.method === "initialize") {
      succeed(request.id, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { list: {} },
        },
        agentInfo: { name: "ACP protocol test agent", version: "0.0.0" },
      });
      continue;
    }
    if (request.method === "authenticate") {
      succeed(request.id, {});
      continue;
    }
    if (request.method === "session/list") {
      succeed(request.id, {
        sessions: [{
          sessionId: configuration.sessionId,
          cwd: configuration.cwd,
          ...(configuration.title === null ? {} : { title: configuration.title }),
        }],
      });
      continue;
    }
    if (request.method === "session/load") {
      succeed(request.id, {
        models: {
          currentModelId: configuration.model,
          availableModels: [{ modelId: configuration.model, name: "Test model" }],
        },
      });
      continue;
    }
    fail(request.id);
  }
});
`,
    "utf8",
  );
  await NodeFSP.writeFile(
    wrapperPath,
    `#!/bin/sh
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(agentPath)}
`,
    "utf8",
  );
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

function waitForFileContent(filePath: string, attempts = 80): Effect.Effect<string> {
  const readAttempt = (remainingAttempts: number): Effect.Effect<string> =>
    Effect.gen(function* () {
      if (remainingAttempts <= 0) {
        return yield* Effect.die(new Error(`Timed out waiting for file content at ${filePath}`));
      }
      const raw = yield* Effect.tryPromise(() => NodeFSP.readFile(filePath, "utf8")).pipe(
        Effect.orElseSucceed(() => ""),
      );
      if (raw.trim().length > 0) {
        return raw;
      }
      yield* Effect.sleep("25 millis");
      return yield* readAttempt(remainingAttempts - 1);
    });
  return readAttempt(attempts);
}

function waitForProcessExit(pid: number, attempts = 80): Effect.Effect<void> {
  const waitAttempt = (remainingAttempts: number): Effect.Effect<void> =>
    Effect.gen(function* () {
      const running = yield* Effect.sync(() => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      });
      if (!running) {
        return;
      }
      if (remainingAttempts <= 0) {
        return yield* Effect.die(new Error(`Timed out waiting for ACP fixture process ${pid}`));
      }
      yield* Effect.sleep("25 millis");
      return yield* waitAttempt(remainingAttempts - 1);
    });
  return waitAttempt(attempts);
}

const acpImportLayer = Layer.mergeAll(NodeServices.layer);
const cursorProviderInstanceId = "cursor-provider-instance";
const grokProviderInstanceId = "grok-provider-instance";

function assertSafeImportError(
  error: AcpImportError,
  expectedCode: AcpImportError["code"],
  secrets: ReadonlyArray<string>,
): void {
  assert.equal(error.code, expectedCode);
  assert.isAtMost(NodeBuffer.Buffer.byteLength(error.message, "utf8"), 1_024);
  assert.include(error.message, "[REDACTED]");
  assert.equal(error.cause, undefined);
  for (const secret of secrets) {
    assert.notInclude(error.message, secret);
    assert.notInclude(JSON.stringify(error), secret);
  }
}

function hasUnsafeCatalogCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x061c ||
      (codePoint >= 0x200e && codePoint <= 0x200f) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    );
  });
}

it.layer(acpImportLayer)("ACP session import", (it) => {
  it.effect("follows session/list pagination and returns a deterministic catalog", () =>
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() => makeAgentWrapper());
      const entries = yield* scanAcpImportCatalog({
        driverKind: "cursor",
        providerInstanceId: cursorProviderInstanceId,
        cwd: process.cwd(),
        binaryPath,
      });

      assert.deepStrictEqual(
        entries.map((entry) => ({
          id: entry.nativeSessionId,
          cwd: entry.cwd,
          title: entry.title,
          updatedAt: entry.updatedAt,
          providerInstanceId: entry.providerInstanceId,
          sourcePath: entry.sourcePath,
        })),
        [
          {
            id: "acp-session-second",
            cwd: "/workspace/second",
            title: "Second session",
            updatedAt: "2026-02-03T04:05:07.000Z",
            providerInstanceId: cursorProviderInstanceId,
            sourcePath: "acp://cursor/cursor-provider-instance/acp-session-second",
          },
          {
            id: "acp-session-first",
            cwd: "/workspace/first",
            title: "First session",
            updatedAt: "2026-02-03T04:05:06.000Z",
            providerInstanceId: cursorProviderInstanceId,
            sourcePath: "acp://cursor/cursor-provider-instance/acp-session-first",
          },
        ],
      );
    }).pipe(TestClock.withLive),
  );

  it.effect("accepts exact shared metadata and cwd byte boundaries", () =>
    Effect.gen(function* () {
      const nativeSessionId = "é".repeat(256);
      const cwd = `/${"é".repeat(2_047)}a`;
      const title = "é".repeat(256);
      const model = "界".repeat(170) + "ab";
      const binaryPath = yield* Effect.promise(() =>
        makeProtocolAgentWrapper({
          sessionId: nativeSessionId,
          cwd,
          title,
          model,
        }),
      );
      const options = {
        driverKind: "cursor" as const,
        providerInstanceId: cursorProviderInstanceId,
        cwd: process.cwd(),
        binaryPath,
      };

      const [entry] = yield* scanAcpImportCatalog(options);
      assert.equal(NodeBuffer.Buffer.byteLength(entry?.nativeSessionId ?? "", "utf8"), 512);
      assert.equal(NodeBuffer.Buffer.byteLength(entry?.cwd ?? "", "utf8"), 4_096);
      assert.equal(NodeBuffer.Buffer.byteLength(entry?.title ?? "", "utf8"), 512);

      const imported = yield* loadAcpImportSession(
        options,
        makeAcpImportSourcePath("cursor", cursorProviderInstanceId, nativeSessionId),
      );
      assert.equal(NodeBuffer.Buffer.byteLength(imported.meta.model ?? "", "utf8"), 512);
      assert.equal(imported.meta.nativeSessionId, nativeSessionId);
      assert.equal(imported.meta.cwd, cwd);
      assert.equal(imported.meta.title, title);
      assert.equal(imported.meta.model, model);
    }).pipe(TestClock.withLive),
  );

  it.effect("rejects over-bound catalog identity and cwd fields", () =>
    Effect.gen(function* () {
      const cases = [
        {
          sessionId: `${"é".repeat(256)}a`,
          cwd: "/workspace",
          expectedDetail: "session id longer than 512 bytes",
        },
        {
          sessionId: "acp-session-overlong-cwd",
          cwd: `/${"é".repeat(2_048)}`,
          expectedDetail: "cwd longer than 4096 bytes",
        },
      ];

      for (const testCase of cases) {
        const binaryPath = yield* Effect.promise(() =>
          makeProtocolAgentWrapper({
            sessionId: testCase.sessionId,
            cwd: testCase.cwd,
            title: null,
            model: "test-model",
          }),
        );
        const error = yield* Effect.flip(
          scanAcpImportCatalog({
            driverKind: "cursor",
            providerInstanceId: cursorProviderInstanceId,
            cwd: process.cwd(),
            binaryPath,
          }),
        );

        assert.equal(error.code, "invalid-source");
        assert.include(error.message, testCase.expectedDetail);
        assert.isAtMost(NodeBuffer.Buffer.byteLength(error.message, "utf8"), 1_024);
      }
    }).pipe(TestClock.withLive),
  );

  it.effect("rejects C0, C1, and bidirectional controls from catalog identity and cwd fields", () =>
    Effect.gen(function* () {
      // Representative charset samples: C0 NUL in session id, C1 NEL in cwd, bidi RLO in session id.
      const cases = [
        {
          sessionId: "unsafe\u0000session",
          cwd: "/workspace",
          expectedDetail: "session id containing unsafe control or bidirectional characters",
        },
        {
          sessionId: "unsafe-c1-cwd",
          cwd: "/workspace/\u0085spoof",
          expectedDetail: "cwd containing unsafe control or bidirectional characters",
        },
        {
          sessionId: "unsafe\u202esession",
          cwd: "/workspace",
          expectedDetail: "session id containing unsafe control or bidirectional characters",
        },
      ];

      for (const testCase of cases) {
        const binaryPath = yield* Effect.promise(() =>
          makeProtocolAgentWrapper({
            sessionId: testCase.sessionId,
            cwd: testCase.cwd,
            title: null,
            model: "test-model",
          }),
        );
        const options = {
          driverKind: "cursor" as const,
          providerInstanceId: cursorProviderInstanceId,
          cwd: process.cwd(),
          binaryPath,
        };
        const scanError = yield* Effect.flip(scanAcpImportCatalog(options));
        const scanAndLoadError = yield* Effect.flip(scanAndLoadAcpImportCatalog(options));

        for (const error of [scanError, scanAndLoadError]) {
          assert.equal(error.code, "invalid-source");
          assert.include(error.message, testCase.expectedDetail);
          assert.isFalse(hasUnsafeCatalogCharacter(error.message));
        }
      }
    }).pipe(TestClock.withLive),
  );

  it.effect("truncates over-bound catalog title and replay model metadata", () =>
    Effect.gen(function* () {
      const nativeSessionId = "acp-session-overlong-metadata";
      const binaryPath = yield* Effect.promise(() =>
        makeProtocolAgentWrapper({
          sessionId: nativeSessionId,
          cwd: "/workspace",
          title: "é".repeat(257),
          model: "界".repeat(171),
        }),
      );
      const options = {
        driverKind: "cursor" as const,
        providerInstanceId: cursorProviderInstanceId,
        cwd: process.cwd(),
        binaryPath,
      };

      const [entry] = yield* scanAcpImportCatalog(options);
      assert.isAtMost(NodeBuffer.Buffer.byteLength(entry?.title ?? "", "utf8"), 512);
      assert.match(entry?.title ?? "", /…$/u);

      const imported = yield* loadAcpImportSession(
        options,
        makeAcpImportSourcePath("cursor", cursorProviderInstanceId, nativeSessionId),
      );
      assert.isAtMost(NodeBuffer.Buffer.byteLength(imported.meta.model ?? "", "utf8"), 512);
      assert.match(imported.meta.model ?? "", /…$/u);
    }).pipe(TestClock.withLive),
  );

  it.effect("redacts and bounds agent list and load failures at scan and batch boundaries", () =>
    Effect.gen(function* () {
      // List path: scan + scanAndLoad + batch, with wire-byte growth.
      {
        const privateJsonToken = "private-list-json-token";
        const privateXaiApiKey = "private-list-xai-api-key";
        const privateAccessToken = "private-list-access-token";
        const privatePassword = "private-list-password";
        const privateAwsSecretAccessKey = "private-list-aws-secret-access-key";
        const privateSecretAccessKey = "private-list-secret-access-key";
        const privatePrivateKey = "private-list-private-key";
        const privateCookie = "private-list-cookie";
        const privateSetCookie = "private-list-set-cookie";
        const privateCredential = "private-list-credential";
        const nativeSessionId = "acp-session-list-error";
        const binaryPath = yield* Effect.promise(() =>
          makeProtocolAgentWrapper({
            sessionId: nativeSessionId,
            cwd: "/workspace",
            title: null,
            model: "test-model",
            failOperation: "session/list",
            failureMessage: `{"token":"${privateJsonToken}","AWS_SECRET_ACCESS_KEY":"${privateAwsSecretAccessKey}","private_key":"${privatePrivateKey}","Cookie":"${privateCookie}","safe_token_count":3,"safe_status":"visible"}; secret_access_key=${privateSecretAccessKey}; Set-Cookie=${privateSetCookie}; credential=${privateCredential}; XAI_API_KEY=${privateXaiApiKey}; access_token='${privateAccessToken}'; password=${privatePassword}; ${"界".repeat(1_000)}`,
          }),
        );
        const wireUsage = { consumedBytes: 0 };
        const options = {
          driverKind: "cursor" as const,
          providerInstanceId: cursorProviderInstanceId,
          cwd: process.cwd(),
          binaryPath,
          wireUsage,
        };
        const sourcePath = makeAcpImportSourcePath(
          "cursor",
          cursorProviderInstanceId,
          nativeSessionId,
        );
        const secrets = [
          privateJsonToken,
          privateXaiApiKey,
          privateAccessToken,
          privatePassword,
          privateAwsSecretAccessKey,
          privateSecretAccessKey,
          privatePrivateKey,
          privateCookie,
          privateSetCookie,
          privateCredential,
        ];

        const scanError = yield* Effect.flip(scanAcpImportCatalog(options));
        const scanWireBytes = wireUsage.consumedBytes;
        const scanAndLoadError = yield* Effect.flip(scanAndLoadAcpImportCatalog(options));
        const scanAndLoadWireBytes = wireUsage.consumedBytes;
        const [batchResult] = yield* loadAcpImportSessionsBatch(options, [sourcePath]);

        for (const error of [scanError, scanAndLoadError, batchResult!.error!]) {
          assertSafeImportError(error, "list-failed", secrets);
          assert.include(error.message, "safe_token_count");
          assert.include(error.message, "safe_status");
        }
        assert.isAbove(scanWireBytes, 0);
        assert.isAbove(scanAndLoadWireBytes, scanWireBytes);
        assert.isAbove(wireUsage.consumedBytes, scanAndLoadWireBytes);
      }

      // Load path: scanAndLoad + batch (catalog succeeds; load fails).
      {
        const privateAuthorization = "private-load-authorization";
        const privateOpenAiApiKey = "private-load-openai-api-key";
        const privateAccessToken = "private-load-access-token";
        const privatePassword = "private-load-password";
        const nativeSessionId = "acp-session-load-error";
        const binaryPath = yield* Effect.promise(() =>
          makeProtocolAgentWrapper({
            sessionId: nativeSessionId,
            cwd: "/workspace",
            title: "Load error",
            model: "test-model",
            failOperation: "session/load",
            failureMessage: `Authorization: Bearer ${privateAuthorization}; {"OPENAI_API_KEY":"${privateOpenAiApiKey}","safe_status":"visible"}; access_token=${privateAccessToken}; password=${privatePassword}; ${"界".repeat(1_000)}`,
          }),
        );
        const options = {
          driverKind: "cursor" as const,
          providerInstanceId: cursorProviderInstanceId,
          cwd: process.cwd(),
          binaryPath,
        };
        const sourcePath = makeAcpImportSourcePath(
          "cursor",
          cursorProviderInstanceId,
          nativeSessionId,
        );
        const secrets = [
          privateAuthorization,
          privateOpenAiApiKey,
          privateAccessToken,
          privatePassword,
        ];

        const [scanResult] = yield* scanAndLoadAcpImportCatalog(options);
        const [batchResult] = yield* loadAcpImportSessionsBatch(options, [sourcePath]);

        for (const error of [scanResult!.error!, batchResult!.error!]) {
          assertSafeImportError(error, "load-failed", secrets);
          assert.include(error.message, "safe_status");
        }
      }
    }).pipe(TestClock.withLive),
  );

  it.effect("bounds replay loading to the remaining global scan capacity", () =>
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() => makeAgentWrapper());
      const loaded = yield* scanAndLoadAcpImportCatalog(
        {
          driverKind: "cursor",
          providerInstanceId: cursorProviderInstanceId,
          cwd: process.cwd(),
          binaryPath,
        },
        1,
      );

      assert.lengthOf(loaded, 1);
      assert.equal(loaded[0]?.descriptor.nativeSessionId, "acp-session-second");
      assert.equal(loaded[0]?.error, null);
    }).pipe(TestClock.withLive),
  );

  it.effect("reports wire usage when a successful catalog is empty", () =>
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() =>
        makeAgentWrapper({ behavior: "empty-catalog" }),
      );
      const wireUsage = { consumedBytes: 0 };
      const loaded = yield* scanAndLoadAcpImportCatalog({
        driverKind: "cursor",
        providerInstanceId: cursorProviderInstanceId,
        cwd: process.cwd(),
        binaryPath,
        wireUsage,
      });

      assert.deepStrictEqual(loaded, []);
      assert.isAbove(wireUsage.consumedBytes, 0);
    }).pipe(TestClock.withLive),
  );

  it.effect("batch-loads selected sessions through one provider connection and catalog", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "acp-import-batch-")),
      );
      const spawnLogPath = NodePath.join(directory, "spawns.log");
      const binaryPath = yield* Effect.promise(() => makeAgentWrapper({ spawnLogPath }));
      const sourcePaths = ["acp-session-first", "acp-session-second"].map((sessionId) =>
        makeAcpImportSourcePath("cursor", cursorProviderInstanceId, sessionId),
      );

      const results = yield* loadAcpImportSessionsBatch(
        {
          driverKind: "cursor",
          providerInstanceId: cursorProviderInstanceId,
          cwd: process.cwd(),
          binaryPath,
        },
        sourcePaths,
      );

      assert.deepStrictEqual(
        results.map((result) => ({
          sourcePath: result.sourcePath,
          nativeSessionId: result.session?.meta.nativeSessionId,
          error: result.error?.code ?? null,
        })),
        [
          {
            sourcePath: sourcePaths[0]!,
            nativeSessionId: "acp-session-first",
            error: null,
          },
          {
            sourcePath: sourcePaths[1]!,
            nativeSessionId: "acp-session-second",
            error: null,
          },
        ],
      );
      const spawnLog = yield* Effect.promise(() => NodeFSP.readFile(spawnLogPath, "utf8"));
      assert.deepStrictEqual(spawnLog.trim().split("\n"), ["spawn"]);
    }).pipe(TestClock.withLive),
  );

  it.effect("returns an ordered limit error for every source omitted by the batch cap", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "acp-import-batch-cap-")),
      );
      const spawnLogPath = NodePath.join(directory, "spawns.log");
      const binaryPath = yield* Effect.promise(() =>
        makeAgentWrapper({ behavior: "opaque-identifiers", spawnLogPath }),
      );
      const sourcePaths = [
        makeAcpImportSourcePath("cursor", cursorProviderInstanceId, " session/%opaque? "),
        makeAcpImportSourcePath("cursor", cursorProviderInstanceId, "acp-session-second"),
        "not-an-acp-source",
      ];

      const results = yield* loadAcpImportSessionsBatch(
        {
          driverKind: "cursor",
          providerInstanceId: cursorProviderInstanceId,
          cwd: process.cwd(),
          binaryPath,
          policy: { maxSessions: 1 },
        },
        sourcePaths,
      );

      assert.deepStrictEqual(
        results.map((result) => ({
          sourcePath: result.sourcePath,
          nativeSessionId: result.session?.meta.nativeSessionId ?? null,
          error: result.error?.code ?? null,
        })),
        [
          {
            sourcePath: sourcePaths[0]!,
            nativeSessionId: " session/%opaque? ",
            error: null,
          },
          {
            sourcePath: sourcePaths[1]!,
            nativeSessionId: null,
            error: "limit-exceeded",
          },
          {
            sourcePath: sourcePaths[2]!,
            nativeSessionId: null,
            error: "limit-exceeded",
          },
        ],
      );
      for (const result of results.slice(1)) {
        assert.equal(result.descriptor, null);
        assert.isAtMost(NodeBuffer.Buffer.byteLength(result.error?.message ?? "", "utf8"), 1_024);
      }
      const spawnLog = yield* Effect.promise(() => NodeFSP.readFile(spawnLogPath, "utf8"));
      assert.deepStrictEqual(spawnLog.trim().split("\n"), ["spawn"]);
    }).pipe(TestClock.withLive),
  );

  it.effect("isolates mutable batch state across repeated execution of one Effect value", () =>
    Effect.gen(function* () {
      const sourcePaths = ["invalid-first", "invalid-omitted"];
      const reusableEffect = loadAcpImportSessionsBatch(
        {
          driverKind: "cursor",
          providerInstanceId: cursorProviderInstanceId,
          cwd: process.cwd(),
          binaryPath: "/must-not-spawn-for-invalid-batch",
          policy: { maxSessions: 1 },
        },
        sourcePaths,
      );
      const first = yield* reusableEffect;
      const firstSnapshot = first.map((result) => ({
        sourcePath: result.sourcePath,
        errorCode: result.error?.code ?? null,
        errorMessage: result.error?.message ?? null,
      }));
      for (const result of first) {
        if (result.error !== null) {
          result.error.message = "mutated after first execution";
        }
      }

      const second = yield* reusableEffect;

      assert.deepStrictEqual(
        second.map((result) => ({
          sourcePath: result.sourcePath,
          errorCode: result.error?.code ?? null,
          errorMessage: result.error?.message ?? null,
        })),
        firstSnapshot,
      );
      assert.deepStrictEqual(
        second.map((result) => result.error?.code),
        ["invalid-source", "limit-exceeded"],
      );
      assert.notStrictEqual(second, first);
      assert.notStrictEqual(second[0], first[0]);
      assert.notStrictEqual(second[0]?.error, first[0]?.error);
      assert.notStrictEqual(second[1], first[1]);
      assert.notStrictEqual(second[1]?.error, first[1]?.error);
    }),
  );

  it.effect("bounds a batch deadline and closes its shared ACP process", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "acp-import-batch-timeout-")),
      );
      const pidLogPath = NodePath.join(directory, "pid.log");
      const binaryPath = yield* Effect.promise(() =>
        makeAgentWrapper({
          behavior: "hang-load-no-replay",
          environment: { T3_ACP_PID_LOG_PATH: pidLogPath },
        }),
      );
      const sourcePaths = [
        makeAcpImportSourcePath("cursor", "different-provider-instance", "acp-session-first"),
        makeAcpImportSourcePath("cursor", cursorProviderInstanceId, "acp-session-second"),
      ];

      const results = yield* loadAcpImportSessionsBatch(
        {
          driverKind: "cursor",
          providerInstanceId: cursorProviderInstanceId,
          cwd: process.cwd(),
          binaryPath,
          policy: {
            batchLoadTimeoutMs: 150,
            loadTimeoutMs: 5_000,
          },
        },
        sourcePaths,
      );

      assert.deepStrictEqual(
        results.map((result) => result.error?.code),
        ["invalid-source", "timeout"],
      );
      const pid = Number(yield* waitForFileContent(pidLogPath));
      assert.isTrue(Number.isSafeInteger(pid));
      yield* waitForProcessExit(pid);
    }).pipe(TestClock.withLive),
  );

  it.effect("bounds oversized agent stdout and closes its scoped ACP process", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "acp-import-frame-limit-")),
      );
      const pidLogPath = NodePath.join(directory, "pid.log");
      const exitLogPath = NodePath.join(directory, "exit.log");
      const binaryPath = yield* Effect.promise(() =>
        makeAgentWrapper({
          behavior: "oversized-list-frame",
          environment: {
            T3_ACP_EXIT_LOG_PATH: exitLogPath,
            T3_ACP_PID_LOG_PATH: pidLogPath,
          },
        }),
      );

      const error = yield* Effect.flip(
        scanAcpImportCatalog({
          driverKind: "cursor",
          providerInstanceId: cursorProviderInstanceId,
          cwd: process.cwd(),
          binaryPath,
          policy: {
            maxCatalogBytes: 1_024,
            maxReplayBytesPerConnection: 1_024,
          },
        }),
      );

      assert.equal(error.code, "list-failed");
      assert.include(error.message, "call-rpc failed for method session/list");
      assert.isAtMost(NodeBuffer.Buffer.byteLength(error.message, "utf8"), 1_024);
      assert.equal(error.cause, undefined);
      assert.notInclude(error.message, "PRIVATE_OVERSIZED_ACP_FRAME");
      assert.notInclude(JSON.stringify(error), "PRIVATE_OVERSIZED_ACP_FRAME");

      const pid = Number(yield* waitForFileContent(pidLogPath));
      assert.isTrue(Number.isSafeInteger(pid));
      yield* waitForProcessExit(pid);
      const exitLog = yield* Effect.promise(() => NodeFSP.readFile(exitLogPath, "utf8"));
      assert.include(exitLog, "SIGTERM");
      assert.include(exitLog, "exit:0");
    }).pipe(TestClock.withLive),
  );

  it.effect("allows catalog and replay shares to compose under the derived wire ceiling", () =>
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() =>
        makeAgentWrapper({ behavior: "aggregate-budget-components" }),
      );
      const wireUsage = { consumedBytes: 0 };
      const [result] = yield* loadAcpImportSessionsBatch(
        {
          driverKind: "cursor",
          providerInstanceId: cursorProviderInstanceId,
          cwd: process.cwd(),
          binaryPath,
          wireUsage,
          policy: {
            maxCatalogBytes: 4_096,
            maxReplayBytesPerConnection: 4_096,
            maxReplayBytesPerSession: 4_096,
          },
        },
        [makeAcpImportSourcePath("cursor", cursorProviderInstanceId, "acp-session-second")],
      );

      assert.equal(result?.error, null);
      assert.include(
        result?.session?.records.find((record) => record.kind === "message")?.text ?? "",
        "replay-",
      );
      assert.isAbove(result?.consumedWireBytes ?? 0, 4_096);
      assert.isAtMost(result?.consumedWireBytes ?? Number.POSITIVE_INFINITY, 8_192);
      assert.equal(wireUsage.consumedBytes, result?.consumedWireBytes);
    }).pipe(TestClock.withLive),
  );

  it.effect("bounds cumulative agent stdout and closes its scoped ACP process", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "acp-import-wire-limit-")),
      );
      const pidLogPath = NodePath.join(directory, "pid.log");
      const exitLogPath = NodePath.join(directory, "exit.log");
      const binaryPath = yield* Effect.promise(() =>
        makeAgentWrapper({
          behavior: "cumulative-wire-overflow",
          environment: {
            T3_ACP_EXIT_LOG_PATH: exitLogPath,
            T3_ACP_PID_LOG_PATH: pidLogPath,
          },
        }),
      );
      const wireUsage = { consumedBytes: 0 };

      const [result] = yield* loadAcpImportSessionsBatch(
        {
          driverKind: "cursor",
          providerInstanceId: cursorProviderInstanceId,
          cwd: process.cwd(),
          binaryPath,
          wireUsage,
          policy: {
            maxCatalogBytes: 4_096,
            maxReplayBytesPerConnection: 60 * 1_024,
            maxReplayBytesPerSession: 1_000_000,
          },
        },
        [makeAcpImportSourcePath("cursor", cursorProviderInstanceId, "acp-session-second")],
      );

      assert.equal(result?.error?.code, "load-failed");
      assert.isAtMost(result?.consumedWireBytes ?? Number.POSITIVE_INFINITY, 64 * 1_024);
      assert.equal(wireUsage.consumedBytes, 64 * 1_024);
      assert.notInclude(JSON.stringify(result), "PRIVATE_CUMULATIVE_WIRE_SECRET");
      const pid = Number(yield* waitForFileContent(pidLogPath));
      assert.isTrue(Number.isSafeInteger(pid));
      yield* waitForProcessExit(pid);
      const exitLog = yield* Effect.promise(() => NodeFSP.readFile(exitLogPath, "utf8"));
      assert.include(exitLog, "SIGTERM");
      assert.include(exitLog, "exit:0");
    }).pipe(TestClock.withLive),
  );

  it.effect("drains large provider stderr without retaining its contents", () =>
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() =>
        makeAgentWrapper({ behavior: "stderr-flood" }),
      );
      const imported = yield* loadAcpImportSession(
        {
          driverKind: "cursor",
          providerInstanceId: cursorProviderInstanceId,
          cwd: process.cwd(),
          binaryPath,
        },
        makeAcpImportSourcePath("cursor", cursorProviderInstanceId, "acp-session-second"),
      );

      assert.include(
        imported.records
          .filter((record) => record.kind === "message")
          .map((record) => record.text)
          .join("\n"),
        "done",
      );
      assert.notInclude(JSON.stringify(imported), "PRIVATE_ACP_STDERR_SECRET");
    }).pipe(TestClock.withLive),
  );

  it.effect("force-kills a timed-out ACP process that ignores SIGTERM", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "acp-import-force-kill-")),
      );
      const wrapperPidLogPath = NodePath.join(directory, "wrapper-pid.log");
      const fixturePidLogPath = NodePath.join(directory, "fixture-pid.log");
      const binaryPath = yield* Effect.promise(() =>
        makeAgentWrapper({
          behavior: "hang-load-no-replay",
          ignoreSigterm: true,
          wrapperPidLogPath,
          environment: { T3_ACP_PID_LOG_PATH: fixturePidLogPath },
        }),
      );
      const startedAt = yield* Clock.currentTimeMillis;
      const results = yield* loadAcpImportSessionsBatch(
        {
          driverKind: "cursor",
          providerInstanceId: cursorProviderInstanceId,
          cwd: process.cwd(),
          binaryPath,
          policy: {
            batchLoadTimeoutMs: 150,
            loadTimeoutMs: 5_000,
            shutdownGraceMs: 75,
          },
        },
        [makeAcpImportSourcePath("cursor", cursorProviderInstanceId, "acp-session-second")],
      );
      const finishedAt = yield* Clock.currentTimeMillis;

      assert.equal(results[0]?.error?.code, "timeout");
      assert.isBelow(finishedAt - startedAt, 2_000);
      const wrapperPid = Number(yield* waitForFileContent(wrapperPidLogPath));
      const fixturePid = Number(yield* waitForFileContent(fixturePidLogPath));
      assert.isTrue(Number.isSafeInteger(wrapperPid));
      assert.isTrue(Number.isSafeInteger(fixturePid));
      yield* waitForProcessExit(wrapperPid);
      yield* waitForProcessExit(fixturePid);
    }).pipe(TestClock.withLive),
  );

  it.effect("surfaces missing list and load capabilities as honest source errors", () =>
    Effect.gen(function* () {
      const missingListBinary = yield* Effect.promise(() =>
        makeAgentWrapper({ capabilityMode: "missing-list" }),
      );
      const missingListError = yield* Effect.flip(
        scanAcpImportCatalog({
          driverKind: "cursor",
          providerInstanceId: cursorProviderInstanceId,
          cwd: process.cwd(),
          binaryPath: missingListBinary,
        }),
      );
      assert.equal(missingListError.code, "unsupported-list");

      const missingLoadBinary = yield* Effect.promise(() =>
        makeAgentWrapper({ capabilityMode: "missing-load" }),
      );
      const missingLoadError = yield* Effect.flip(
        loadAcpImportSession(
          {
            driverKind: "grok",
            providerInstanceId: grokProviderInstanceId,
            cwd: process.cwd(),
            binaryPath: missingLoadBinary,
          },
          makeAcpImportSourcePath("grok", grokProviderInstanceId, "acp-session-second"),
        ),
      );
      assert.equal(missingLoadError.code, "unsupported-load");
    }).pipe(TestClock.withLive),
  );

  it.effect("normalizes replay order without leaking attachment or tool payloads", () =>
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() => makeAgentWrapper());
      const options = {
        driverKind: "cursor" as const,
        providerInstanceId: cursorProviderInstanceId,
        cwd: process.cwd(),
        binaryPath,
      };
      const sourcePath = makeAcpImportSourcePath(
        "cursor",
        cursorProviderInstanceId,
        "acp-session-second",
      );
      const first = yield* loadAcpImportSession(options, sourcePath);
      const second = yield* loadAcpImportSession(options, sourcePath);

      assert.equal(first.meta.contentHash, second.meta.contentHash);
      assert.equal(first.meta.model, "acp-test-model");
      assert.deepStrictEqual(
        first.records.map((record) =>
          record.kind === "message"
            ? `${record.kind}:${record.role}:${record.text}`
            : `${record.kind}:${record.activityKind}:${record.summary}`,
        ),
        [
          "message:user:hello world",
          "activity:task.progress:thinking carefully",
          "activity:tool.completed:Searched files",
          "activity:task.completed:Omitted 2 attachments from imported ACP history",
          "message:assistant:done",
        ],
      );
      for (let index = 1; index < first.records.length; index += 1) {
        assert.isAbove(
          Date.parse(first.records[index]!.createdAt),
          Date.parse(first.records[index - 1]!.createdAt),
        );
      }
      const serialized = JSON.stringify(first);
      for (const secret of [
        "private-image-bytes",
        "/private/attachment.png",
        "private-tool-input",
        "/private/tool-output.txt",
        "foreign private text",
      ]) {
        assert.notInclude(serialized, secret);
      }
      assert.include(first.warnings, "ignored replay updates for a different ACP session");
      assert.include(first.warnings, "attachment contents were omitted from ACP session replay");
    }).pipe(TestClock.withLive),
  );

  it.effect("preserves thought boundaries and canonicalizes plan, tool, and omission history", () =>
    Effect.sync(() => {
      const nativeSessionId = "fidelity-session";
      const sourcePath = makeAcpImportSourcePath(
        "cursor",
        cursorProviderInstanceId,
        nativeSessionId,
      );
      const descriptor = {
        driverKind: "cursor",
        providerInstanceId: cursorProviderInstanceId,
        source: "cursor-acp",
        sourcePath,
        nativeSessionId,
        cwd: "/workspace/fidelity",
        title: "Fidelity session",
        updatedAt: null,
      } as const;
      const notifications = [
        {
          sessionId: nativeSessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            messageId: "thought-one",
            content: { type: "text", text: "First thought line\n" },
          },
        },
        {
          sessionId: nativeSessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            messageId: "thought-one",
            content: { type: "text", text: "second line" },
          },
        },
        {
          sessionId: nativeSessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            messageId: "thought-two",
            content: { type: "text", text: "Second thought\nwith separate detail" },
          },
        },
        {
          sessionId: nativeSessionId,
          update: {
            sessionUpdate: "plan",
            entries: [
              { content: "Inspect ACP history", priority: "high", status: "completed" },
              { content: "Import safely", priority: "medium", status: "in_progress" },
            ],
          },
        },
        {
          sessionId: nativeSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "failed-tool",
            title: "Terminal",
            kind: "execute",
            status: "pending",
            rawInput: {
              command: ["node", "scripts/check.mjs", "--token=private-command-token"],
              secret: "private-raw-input",
            },
            rawOutput: { secret: "private-initial-output" },
          },
        },
        {
          sessionId: nativeSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "failed-tool",
            status: "failed",
            rawOutput: { secret: "private-final-output" },
            content: [
              {
                type: "content",
                content: {
                  type: "text",
                  text: "token=private-output-token\nfull failure reason",
                },
              },
              {
                type: "content",
                content: {
                  type: "image",
                  data: "private-image-data",
                  mimeType: "image/png",
                  uri: "file:///private/failure.png",
                },
              },
            ],
            locations: [
              { path: "/workspace/fidelity/scripts/check.mjs", line: 12 },
              { path: "/workspace/fidelity/package.json" },
            ],
          },
        },
        {
          sessionId: nativeSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "unfinished-tool",
            title: "Still inspecting",
            kind: "read",
            status: "in_progress",
            rawInput: { secret: "private-unfinished-input" },
            content: [
              {
                type: "content",
                content: {
                  type: "resource_link",
                  name: "private-resource",
                  uri: "file:///private/resource.txt",
                },
              },
            ],
          },
        },
        {
          sessionId: nativeSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "answer",
            content: { type: "text", text: "Done on line one\nand line two." },
          },
        },
      ] satisfies ReadonlyArray<EffectAcpSchema.SessionNotification>;

      const imported = normalizeAcpSessionReplay({
        descriptor,
        notifications,
        loadResponse: {},
      });
      const thoughts = imported.records.filter(
        (record) => record.kind === "activity" && record.activityKind === "task.progress",
      );
      assert.lengthOf(thoughts, 2);
      assert.deepStrictEqual(
        thoughts.map((record) => (record.kind === "activity" ? record.payload.detail : null)),
        ["First thought line\nsecond line", "Second thought\nwith separate detail"],
      );

      const plan = imported.records.find(
        (record) => record.kind === "activity" && record.activityKind === "turn.plan.updated",
      );
      assert.deepStrictEqual(plan?.kind === "activity" ? plan.payload.plan : null, [
        { step: "Inspect ACP history", status: "completed" },
        { step: "Import safely", status: "inProgress" },
      ]);

      const failedTool = imported.records.find(
        (record) =>
          record.kind === "activity" &&
          record.activityKind === "tool.completed" &&
          record.tone === "error",
      );
      assert.equal(failedTool?.kind === "activity" ? failedTool.summary : null, "Ran command");
      assert.deepStrictEqual(failedTool?.kind === "activity" ? failedTool.payload : null, {
        itemType: "command_execution",
        title: "Ran command",
        status: "failed",
        detail: "token=[REDACTED]\nfull failure reason",
        data: {
          toolCallId: "failed-tool",
          kind: "execute",
          command: "node scripts/check.mjs --token=[REDACTED]",
          item: {
            input: {
              command: ["node", "scripts/check.mjs", "--token=[REDACTED]"],
              secret: "[REDACTED]",
            },
            command: "node scripts/check.mjs --token=[REDACTED]",
            result: {
              content: "token=[REDACTED]\nfull failure reason",
            },
          },
          rawInput: {
            command: ["node", "scripts/check.mjs", "--token=[REDACTED]"],
            secret: "[REDACTED]",
          },
          rawOutput: {
            secret: "[REDACTED]",
          },
          locations: [
            { path: "/workspace/fidelity/scripts/check.mjs", line: 12 },
            { path: "/workspace/fidelity/package.json" },
          ],
        },
      });

      assert.include(
        imported.records.map((record) => (record.kind === "activity" ? record.summary : "")),
        "Omitted 1 unfinished tool activity from imported ACP history",
      );
      assert.equal(
        imported.records.find((record) => record.kind === "message")?.text,
        "Done on line one\nand line two.",
      );
      const serialized = JSON.stringify(imported);
      for (const secret of [
        "private-raw-input",
        "private-command-token",
        "private-output-token",
        "private-initial-output",
        "private-final-output",
        "private-image-data",
        "file:///private/failure.png",
        "private-unfinished-input",
        "file:///private/resource.txt",
      ]) {
        assert.notInclude(serialized, secret);
      }
    }),
  );

  it.effect("derives stable undated record and marker timestamps across clock advancement", () =>
    Effect.gen(function* () {
      const nativeSessionId = "undated-session";
      const descriptor = {
        driverKind: "cursor",
        providerInstanceId: cursorProviderInstanceId,
        source: "cursor-acp",
        sourcePath: makeAcpImportSourcePath("cursor", cursorProviderInstanceId, nativeSessionId),
        nativeSessionId,
        cwd: "/workspace/undated",
        title: null,
        updatedAt: null,
      } as const;
      const notifications = [
        {
          sessionId: nativeSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "unfinished-tool",
            title: "Inspecting",
            kind: "read",
            status: "in_progress",
            rawInput: { path: "/workspace/undated/file.ts" },
          },
        },
        {
          sessionId: nativeSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "message",
            content: { type: "text", text: "stable content" },
          },
        },
      ] satisfies ReadonlyArray<EffectAcpSchema.SessionNotification>;
      const clockBefore = yield* Clock.currentTimeMillis;
      const first = normalizeAcpSessionReplay({
        descriptor,
        notifications,
        loadResponse: {},
      });
      yield* TestClock.adjust("1 hour");
      const clockAfter = yield* Clock.currentTimeMillis;
      const second = normalizeAcpSessionReplay({
        descriptor,
        notifications,
        loadResponse: {},
      });

      assert.isAbove(clockAfter, clockBefore);
      assert.equal(first.meta.contentHash, second.meta.contentHash);
      assert.deepStrictEqual(first.records, second.records);
      assert.deepStrictEqual(first.meta, second.meta);
      assert.notMatch(first.records[0]?.createdAt ?? "", /^1970-/);
      assert.equal(
        first.records.find(
          (record) =>
            record.kind === "activity" && typeof record.payload.unfinishedToolCount === "number",
        )?.createdAt,
        second.records.find(
          (record) =>
            record.kind === "activity" && typeof record.payload.unfinishedToolCount === "number",
        )?.createdAt,
      );
    }),
  );

  it.effect("redacts credential-shaped structured tool keys without hiding safe key controls", () =>
    Effect.sync(() => {
      const nativeSessionId = "structured-credential-session";
      const descriptor = {
        driverKind: "cursor",
        providerInstanceId: cursorProviderInstanceId,
        source: "cursor-acp",
        sourcePath: makeAcpImportSourcePath("cursor", cursorProviderInstanceId, nativeSessionId),
        nativeSessionId,
        cwd: "/workspace/structured-credential",
        title: "Structured credential session",
        updatedAt: null,
      } as const;
      const secrets = {
        awsSecretAccessKey: "private-structured-aws-secret-access-key",
        secretAccessKey: "private-structured-secret-access-key",
        privateKey: "private-structured-private-key",
        cookie: "private-structured-cookie",
        setCookie: "private-structured-set-cookie",
        credential: "private-structured-credential",
        outputCookie: "private-structured-output-cookie",
        outputSetCookie: "private-structured-output-set-cookie",
        outputCredential: "private-structured-output-credential",
        cookies: "private-structured-cookies",
        cookieJar: "private-structured-cookie-jar",
      };
      const imported = normalizeAcpSessionReplay({
        descriptor,
        notifications: [
          {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "structured-credential-tool",
              title: "Inspect credentials",
              kind: "read",
              status: "completed",
              rawInput: {
                AWS_SECRET_ACCESS_KEY: secrets.awsSecretAccessKey,
                secret_access_key: secrets.secretAccessKey,
                private_key: secrets.privateKey,
                Cookie: secrets.cookie,
                "Set-Cookie": secrets.setCookie,
                client_credential: secrets.credential,
                cookies: [{ name: "session", value: secrets.cookies }],
                cookieJar: { session: secrets.cookieJar },
                authorization_status: "configured",
                safe_cookie_count: 2,
                safe_token_count: 3,
                safe_status: "visible",
                monkey: "visible-monkey",
                public_key: "visible-public-key",
              },
              rawOutput: {
                headers: {
                  Cookie: secrets.outputCookie,
                  "Set-Cookie": secrets.outputSetCookie,
                },
                service_credential: secrets.outputCredential,
                safe_token_count: 4,
                safe_status: "visible-output",
                monkey: "visible-output-monkey",
                public_key: "visible-output-public-key",
              },
            },
          },
          {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              messageId: "answer",
              content: { type: "text", text: "done" },
            },
          },
        ],
        loadResponse: {},
      });
      const tool = imported.records.find(
        (record) => record.kind === "activity" && record.activityKind === "tool.completed",
      );
      assert.equal(tool?.kind, "activity");
      if (tool?.kind !== "activity") {
        return;
      }
      const data = tool.payload.data as Record<string, unknown>;
      const rawInput = data.rawInput as Record<string, unknown>;
      const rawOutput = data.rawOutput as Record<string, unknown>;

      assert.deepStrictEqual(rawInput, {
        AWS_SECRET_ACCESS_KEY: "[REDACTED]",
        Cookie: "[REDACTED]",
        "Set-Cookie": "[REDACTED]",
        authorization_status: "configured",
        client_credential: "[REDACTED]",
        cookieJar: "[REDACTED]",
        cookies: "[REDACTED]",
        monkey: "visible-monkey",
        private_key: "[REDACTED]",
        public_key: "visible-public-key",
        safe_status: "visible",
        safe_cookie_count: 2,
        safe_token_count: 3,
        secret_access_key: "[REDACTED]",
      });
      assert.deepStrictEqual(rawOutput, {
        headers: {
          Cookie: "[REDACTED]",
          "Set-Cookie": "[REDACTED]",
        },
        monkey: "visible-output-monkey",
        public_key: "visible-output-public-key",
        safe_status: "visible-output",
        safe_token_count: 4,
        service_credential: "[REDACTED]",
      });
      const serialized = JSON.stringify(imported);
      for (const secret of Object.values(secrets)) {
        assert.notInclude(serialized, secret);
      }
    }),
  );

  it.effect("redacts credential assignments and quoted JSON while preserving safe labels", () =>
    Effect.sync(() => {
      const nativeSessionId = "string-credential-session";
      const descriptor = {
        driverKind: "cursor",
        providerInstanceId: cursorProviderInstanceId,
        source: "cursor-acp",
        sourcePath: makeAcpImportSourcePath("cursor", cursorProviderInstanceId, nativeSessionId),
        nativeSessionId,
        cwd: "/workspace/string-credential",
        title: "String credential session",
        updatedAt: null,
      } as const;
      const secrets = {
        awsSecretAccessKey: "private-string-aws-secret-access-key",
        secretAccessKey: "private-string-secret-access-key",
        privateKey: "private-string-private-key",
        cookie: "private-string-cookie",
        laterCookie: "private-string-later-cookie",
        setCookie: "private-string-set-cookie",
        laterSetCookie: "private-string-later-set-cookie",
        credential: "private-string-credential",
        basicAuthorization: "private-string-basic-authorization",
        digestUsername: "private-string-digest-username",
        digestResponse: "private-string-digest-response",
      };
      const imported = normalizeAcpSessionReplay({
        descriptor,
        notifications: [
          {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "string-credential-tool",
              title: "Inspect credential strings",
              kind: "read",
              status: "completed",
              rawInput: `safe_token_count=3; safe_cookie_count=2; authorization_status=ready; safe_status=visible; monkey=visible-monkey; public_key=visible-public-key
AWS_SECRET_ACCESS_KEY=${secrets.awsSecretAccessKey}; secret_access_key='${secrets.secretAccessKey}'; private_key=${secrets.privateKey}; credential=${secrets.credential}
Authorization: Basic ${secrets.basicAuthorization}
Proxy-Authorization: Digest username="${secrets.digestUsername}", realm="test", response="${secrets.digestResponse}"
Cookie=session=${secrets.cookie}; csrf=${secrets.laterCookie}
Set-Cookie=session=${secrets.setCookie}; Path=/; refresh=${secrets.laterSetCookie}`,
              rawOutput: `{"AWS_SECRET_ACCESS_KEY":"${secrets.awsSecretAccessKey}","secret_access_key":"${secrets.secretAccessKey}","private_key":"${secrets.privateKey}","Authorization":"Basic ${secrets.basicAuthorization}","Cookie":"session=${secrets.cookie}; csrf=${secrets.laterCookie}","Set-Cookie":"session=${secrets.setCookie}; refresh=${secrets.laterSetCookie}","credential":"${secrets.credential}","safe_token_count":4,"safe_cookie_count":3,"authorization_status":"visible-auth","safe_status":"visible-output","monkey":"visible-output-monkey","public_key":"visible-output-public-key"}`,
            },
          },
          {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              messageId: "answer",
              content: { type: "text", text: "done" },
            },
          },
        ],
        loadResponse: {},
      });
      const tool = imported.records.find(
        (record) => record.kind === "activity" && record.activityKind === "tool.completed",
      );
      assert.equal(tool?.kind, "activity");
      if (tool?.kind !== "activity") {
        return;
      }
      const data = tool.payload.data as Record<string, unknown>;
      const rawInput = String(data.rawInput);
      const rawOutput = String(data.rawOutput);

      for (const label of [
        "AWS_SECRET_ACCESS_KEY=[REDACTED]",
        "secret_access_key=[REDACTED]",
        "private_key=[REDACTED]",
        "Cookie=[REDACTED]",
        "Set-Cookie=[REDACTED]",
        "credential=[REDACTED]",
        "Authorization: [REDACTED]",
        "Proxy-Authorization: [REDACTED]",
      ]) {
        assert.include(rawInput, label);
      }
      for (const safeValue of [
        "safe_token_count=3",
        "safe_cookie_count=2",
        "authorization_status=ready",
        "safe_status=visible",
        "monkey=visible-monkey",
        "public_key=visible-public-key",
      ]) {
        assert.include(rawInput, safeValue);
      }
      for (const label of [
        '"AWS_SECRET_ACCESS_KEY":[REDACTED]',
        '"secret_access_key":[REDACTED]',
        '"private_key":[REDACTED]',
        '"Cookie":[REDACTED]',
        '"Set-Cookie":[REDACTED]',
        '"credential":[REDACTED]',
        '"Authorization":[REDACTED]',
      ]) {
        assert.include(rawOutput, label);
      }
      for (const safeValue of [
        '"safe_token_count":4',
        '"safe_cookie_count":3',
        '"authorization_status":"visible-auth"',
        '"safe_status":"visible-output"',
        '"monkey":"visible-output-monkey"',
        '"public_key":"visible-output-public-key"',
      ]) {
        assert.include(rawOutput, safeValue);
      }
      const serialized = JSON.stringify(imported);
      for (const secret of Object.values(secrets)) {
        assert.notInclude(serialized, secret);
      }
    }),
  );

  it.effect("preserves arbitrary raw tool detail within redacted display budgets", () =>
    Effect.sync(() => {
      const nativeSessionId = "raw-tool-session";
      const descriptor = {
        driverKind: "cursor",
        providerInstanceId: cursorProviderInstanceId,
        source: "cursor-acp",
        sourcePath: makeAcpImportSourcePath("cursor", cursorProviderInstanceId, nativeSessionId),
        nativeSessionId,
        cwd: "/workspace/raw-tool",
        title: "Raw tool session",
        updatedAt: null,
      } as const;
      const imported = normalizeAcpSessionReplay({
        descriptor,
        notifications: [
          {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "tool\u009btoken=private-tool-id",
              title: "Read file",
              kind: "read",
              status: "completed",
              rawInput: {
                path: "/workspace/token=private-path-secret\u009b31m/file.ts",
                query: "needle",
                authorization: "Bearer private-authorization",
                nested: [{ value: "preserved" }],
                oversized: "x".repeat(300_000),
              },
              rawOutput: {
                stdout: "token=private-output-token\nraw-only output",
                metadata: {
                  password: "private-password",
                  arbitrary: [1, true, { value: "kept" }],
                },
              },
              locations: [
                {
                  path: "/workspace/token=private-location-secret\u009b31m/file.ts",
                  line: 4,
                },
              ],
            },
          },
          {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              messageId: "answer",
              content: { type: "text", text: "done" },
            },
          },
        ],
        loadResponse: {},
      });
      const tool = imported.records.find(
        (record) => record.kind === "activity" && record.activityKind === "tool.completed",
      );
      assert.equal(tool?.kind, "activity");
      if (tool?.kind !== "activity") {
        return;
      }
      const data = tool.payload.data as Record<string, unknown>;
      const item = data.item as Record<string, unknown>;
      const rawInput = data.rawInput as Record<string, unknown>;
      const rawOutput = data.rawOutput as Record<string, unknown>;

      assert.equal(tool.payload.detail, "token=[REDACTED]\nraw-only output");
      assert.match(String(data.toolCallId), /^acp-tool-[0-9a-f]{32}$/u);
      assert.deepStrictEqual(item.input, rawInput);
      assert.deepStrictEqual(item.result, {
        content: "token=[REDACTED]\nraw-only output",
      });
      assert.equal(rawInput.path, "/workspace/token=[REDACTED]");
      assert.equal(rawInput.authorization, "[REDACTED]");
      assert.deepStrictEqual(rawInput.nested, [{ value: "preserved" }]);
      assert.isBelow(String(rawInput.oversized).length, 300_000);
      assert.equal(rawOutput.stdout, "token=[REDACTED]\nraw-only output");
      assert.deepStrictEqual(rawOutput.metadata, {
        arbitrary: [1, true, { value: "kept" }],
        password: "[REDACTED]",
      });
      assert.deepStrictEqual(data.locations, [{ path: "/workspace/token=[REDACTED]", line: 4 }]);
      assert.isAtMost(NodeBuffer.Buffer.byteLength(JSON.stringify(rawInput), "utf8"), 256 * 1024);
      assert.isAtMost(NodeBuffer.Buffer.byteLength(JSON.stringify(rawOutput), "utf8"), 256 * 1024);
      const serialized = JSON.stringify(imported);
      for (const secret of [
        "private-tool-id",
        "private-path-secret",
        "private-authorization",
        "private-output-token",
        "private-password",
        "private-location-secret",
        "\u009b",
      ]) {
        assert.notInclude(serialized, secret);
      }
    }),
  );

  it.effect("bounds large tool fields and never scans content or locations beyond item caps", () =>
    Effect.sync(() => {
      const nativeSessionId = "bounded-tool-collections";
      const content = Array.from(
        { length: 501 },
        (_, index): EffectAcpSchema.ToolCallContent => ({
          type: "content",
          content: {
            type: "text",
            text:
              index === 0
                ? `token=private-large-content-secret ${"x".repeat(4 * 1_024 * 1_024)}`
                : `unretained-${index}`,
          },
        }),
      );
      Object.defineProperty(content, 500, {
        get: () => {
          throw new Error("tool content scanned past its configured item limit");
        },
      });
      const locations = Array.from(
        { length: 101 },
        (_, index): EffectAcpSchema.ToolCallLocation => ({
          path:
            index === 0
              ? `/workspace/token=private-large-location-secret/${"y".repeat(2 * 1_024 * 1_024)}`
              : `/workspace/file-${index}.ts`,
          line: index,
        }),
      );
      Object.defineProperty(locations, 100, {
        get: () => {
          throw new Error("tool locations scanned past their configured item limit");
        },
      });
      const imported = normalizeAcpSessionReplay({
        descriptor: {
          driverKind: "cursor",
          providerInstanceId: cursorProviderInstanceId,
          source: "cursor-acp",
          sourcePath: makeAcpImportSourcePath("cursor", cursorProviderInstanceId, nativeSessionId),
          nativeSessionId,
          cwd: "/workspace",
          title: "Bounded tool collections",
          updatedAt: null,
        },
        notifications: [
          {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "bounded-tool",
              title: "Bound tool data",
              kind: "read",
              status: "completed",
              content,
              locations,
            },
          },
        ],
        loadResponse: {},
      });
      const tool = imported.records.find(
        (record) => record.kind === "activity" && record.activityKind === "tool.completed",
      );
      assert.equal(tool?.kind, "activity");
      if (tool?.kind !== "activity") {
        return;
      }
      const data = tool.payload.data as Record<string, unknown>;
      const retainedLocations = data.locations as ReadonlyArray<{ readonly path: string }>;
      assert.isAtMost(NodeBuffer.Buffer.byteLength(String(tool.payload.detail), "utf8"), 1_048_576);
      assert.equal(data.omittedContentItemCount, 500);
      assert.equal(data.omittedLocationCount, 1);
      assert.lengthOf(retainedLocations, 100);
      assert.isAtMost(
        NodeBuffer.Buffer.byteLength(retainedLocations[0]?.path ?? "", "utf8"),
        4_096,
      );
      assert.include(
        imported.warnings,
        "tool content items beyond bounded replay limits were omitted",
      );
      assert.include(
        imported.warnings,
        "tool locations beyond bounded replay limits or without unique paths were omitted",
      );
      const serialized = JSON.stringify(imported);
      assert.notInclude(serialized, "private-large-content-secret");
      assert.notInclude(serialized, "private-large-location-secret");
    }),
  );

  it.effect("retains a deterministic bounded raw-tool key set before reading values", () =>
    Effect.sync(() => {
      const nativeSessionId = "bounded-raw-tool-keys";
      const rawInput: Record<string, unknown> = {};
      for (let index = 1_999; index >= 0; index -= 1) {
        rawInput[`field-${String(index).padStart(4, "0")}`] = index;
      }
      Object.defineProperty(rawInput, "zzzz-never-read", {
        enumerable: true,
        get: () => {
          throw new Error("raw tool sanitizer read a value outside its bounded key set");
        },
      });
      const imported = normalizeAcpSessionReplay({
        descriptor: {
          driverKind: "cursor",
          providerInstanceId: cursorProviderInstanceId,
          source: "cursor-acp",
          sourcePath: makeAcpImportSourcePath("cursor", cursorProviderInstanceId, nativeSessionId),
          nativeSessionId,
          cwd: "/workspace",
          title: "Bounded raw tool keys",
          updatedAt: null,
        },
        notifications: [
          {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "bounded-raw-keys",
              title: "Bound raw keys",
              kind: "read",
              status: "completed",
              rawInput,
            },
          },
        ],
        loadResponse: {},
      });
      const tool = imported.records.find(
        (record) => record.kind === "activity" && record.activityKind === "tool.completed",
      );
      const data =
        tool?.kind === "activity" ? (tool.payload.data as Record<string, unknown>) : undefined;
      const retained = data?.rawInput as Record<string, unknown>;
      assert.equal(retained["field-0000"], 0);
      assert.equal(retained["field-0499"], 499);
      assert.isFalse(Object.hasOwn(retained, "field-0500"));
      assert.isFalse(Object.hasOwn(retained, "zzzz-never-read"));
      assert.equal(retained._t3ImportOmittedFields, 1_501);
    }),
  );

  it.effect("caps normalized records during replay construction with an omission marker", () =>
    Effect.sync(() => {
      const nativeSessionId = "record-cap-session";
      const overflowCount = 10;
      const imported = normalizeAcpSessionReplay({
        descriptor: {
          driverKind: "cursor",
          providerInstanceId: cursorProviderInstanceId,
          source: "cursor-acp",
          sourcePath: makeAcpImportSourcePath("cursor", cursorProviderInstanceId, nativeSessionId),
          nativeSessionId,
          cwd: "/workspace",
          title: "Record cap",
          updatedAt: null,
        },
        notifications: Array.from(
          { length: IMPORT_NORMALIZED_SESSION_MAX_RECORDS + overflowCount },
          (): EffectAcpSchema.SessionNotification => ({
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: "plan",
              entries: [],
            },
          }),
        ),
        loadResponse: {},
      });

      assert.lengthOf(imported.records, IMPORT_NORMALIZED_SESSION_MAX_RECORDS);
      const marker = imported.records.at(-1);
      assert.equal(marker?.kind, "activity");
      assert.deepInclude(marker?.kind === "activity" ? marker.payload : {}, {
        omittedRecordCount: overflowCount + 1,
        normalizedRecordLimit: IMPORT_NORMALIZED_SESSION_MAX_RECORDS,
      });
      assert.include(
        imported.warnings,
        "records beyond the normalized session limit were omitted from ACP replay",
      );
    }),
  );

  it.effect("caps amplified normalized tool records during replay construction", () =>
    Effect.sync(() => {
      const nativeSessionId = "normalized-byte-cap-session";
      const toolTextBytes = 1_048_560;
      const amplifiedCopiesPerTool = 3;
      const notificationCount =
        Math.ceil(IMPORT_NORMALIZED_SESSION_MAX_BYTES / (toolTextBytes * amplifiedCopiesPerTool)) +
        2;
      const imported = normalizeAcpSessionReplay({
        descriptor: {
          driverKind: "cursor",
          providerInstanceId: cursorProviderInstanceId,
          source: "cursor-acp",
          sourcePath: makeAcpImportSourcePath("cursor", cursorProviderInstanceId, nativeSessionId),
          nativeSessionId,
          cwd: "/workspace",
          title: "Normalized byte cap",
          updatedAt: null,
        },
        notifications: Array.from(
          { length: notificationCount },
          (_, index): EffectAcpSchema.SessionNotification => ({
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: `large-tool-${index}`,
              title: `Large tool ${index}`,
              kind: "read",
              status: "completed",
              content: [
                {
                  type: "content",
                  content: {
                    type: "text",
                    text: `tool-${index}-${"z".repeat(toolTextBytes)}`,
                  },
                },
              ],
            },
          }),
        ),
        loadResponse: {},
      });

      assert.isAtMost(
        NodeBuffer.Buffer.byteLength(JSON.stringify(imported), "utf8"),
        IMPORT_NORMALIZED_SESSION_MAX_BYTES,
      );
      const marker = imported.records.at(-1);
      assert.equal(marker?.kind, "activity");
      assert.equal(
        marker?.kind === "activity" ? marker.payload.normalizedByteLimit : undefined,
        IMPORT_NORMALIZED_SESSION_MAX_BYTES,
      );
      assert.isAbove(
        Number(marker?.kind === "activity" ? marker.payload.omittedRecordCount : 0),
        0,
      );
      assert.include(
        imported.warnings,
        "records beyond the normalized session limit were omitted from ACP replay",
      );
    }),
  );

  it.effect("charges timestamp overhead while bounding many medium normalized records", () =>
    Effect.sync(() => {
      const nativeSessionId = "timestamped-byte-cap-session";
      const mediumDetail = "m".repeat(768);
      const imported = normalizeAcpSessionReplay({
        descriptor: {
          driverKind: "cursor",
          providerInstanceId: cursorProviderInstanceId,
          source: "cursor-acp",
          sourcePath: makeAcpImportSourcePath("cursor", cursorProviderInstanceId, nativeSessionId),
          nativeSessionId,
          cwd: "/workspace",
          title: "Timestamped byte cap",
          updatedAt: null,
        },
        notifications: Array.from(
          { length: 30_000 },
          (_, index): EffectAcpSchema.SessionNotification => ({
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: "plan",
              entries: [
                {
                  content: `Step ${index}: ${mediumDetail}`,
                  priority: "medium",
                  status: "pending",
                },
              ],
            },
          }),
        ),
        loadResponse: {},
      });

      assert.isAtMost(imported.records.length, IMPORT_NORMALIZED_SESSION_MAX_RECORDS);
      assert.isAtMost(
        NodeBuffer.Buffer.byteLength(JSON.stringify(imported), "utf8"),
        IMPORT_NORMALIZED_SESSION_MAX_BYTES,
      );
      const marker = imported.records.at(-1);
      assert.equal(marker?.kind, "activity");
      assert.isAbove(
        Number(marker?.kind === "activity" ? marker.payload.omittedRecordCount : 0),
        0,
      );
      assert.include(
        imported.warnings,
        "records beyond the normalized session limit were omitted from ACP replay",
      );
    }),
  );

  it.effect("bounds a hung ACP load and closes its process", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "acp-import-timeout-")),
      );
      const pidLogPath = NodePath.join(directory, "pid.log");
      const binaryPath = yield* Effect.promise(() =>
        makeAgentWrapper({
          behavior: "hang-load-no-replay",
          environment: { T3_ACP_PID_LOG_PATH: pidLogPath },
        }),
      );
      const options = {
        driverKind: "cursor" as const,
        providerInstanceId: cursorProviderInstanceId,
        cwd: process.cwd(),
        binaryPath,
        policy: {
          initializeTimeoutMs: 150,
          authenticateTimeoutMs: 150,
          listPageTimeoutMs: 150,
          loadTimeoutMs: 150,
        },
      };
      const error = yield* Effect.flip(
        loadAcpImportSession(
          options,
          makeAcpImportSourcePath("cursor", cursorProviderInstanceId, "acp-session-second"),
        ),
      );

      assert.equal(error.code, "timeout");
      const pid = Number(yield* waitForFileContent(pidLogPath));
      assert.isTrue(Number.isSafeInteger(pid));
      yield* waitForProcessExit(pid);
    }).pipe(TestClock.withLive),
  );

  it.effect("accepts hanging and just-after-response replay delivery", () =>
    Effect.gen(function* () {
      const hangingBinary = yield* Effect.promise(() =>
        makeAgentWrapper({ behavior: "hanging-replay" }),
      );
      const hangingSession = yield* loadAcpImportSession(
        {
          driverKind: "cursor",
          providerInstanceId: cursorProviderInstanceId,
          cwd: process.cwd(),
          binaryPath: hangingBinary,
          policy: {
            hangingReplayIdleMs: 40,
            loadTimeoutMs: 1_000,
          },
        },
        makeAcpImportSourcePath("cursor", cursorProviderInstanceId, "acp-session-second"),
      );
      assert.equal(hangingSession.meta.model, "acp-test-model");
      assert.deepStrictEqual(
        hangingSession.records.map((record) => (record.kind === "message" ? record.text : null)),
        ["replayed while load stayed pending"],
      );

      const lateBinary = yield* Effect.promise(() => makeAgentWrapper({ behavior: "late-replay" }));
      const lateSession = yield* loadAcpImportSession(
        {
          driverKind: "cursor",
          providerInstanceId: cursorProviderInstanceId,
          cwd: process.cwd(),
          binaryPath: lateBinary,
          policy: {
            postResponseReplayGraceMs: 80,
            loadTimeoutMs: 1_000,
          },
        },
        makeAcpImportSourcePath("cursor", cursorProviderInstanceId, "acp-session-second"),
      );
      assert.deepStrictEqual(
        lateSession.records.map((record) => (record.kind === "message" ? record.text : null)),
        ["before after"],
      );
    }).pipe(TestClock.withLive),
  );

  it.effect("enforces catalog page, session, byte, and replay quotas", () =>
    Effect.gen(function* () {
      const catalogCases = [
        { behavior: "infinite-pagination", policy: { maxPages: 2 } },
        { behavior: "normal", policy: { maxSessions: 1 } },
        { behavior: "normal", policy: { maxCatalogBytes: 1 } },
      ] as const;
      for (const catalogCase of catalogCases) {
        const binaryPath = yield* Effect.promise(() =>
          makeAgentWrapper({ behavior: catalogCase.behavior }),
        );
        const error = yield* Effect.flip(
          scanAcpImportCatalog({
            driverKind: "cursor",
            providerInstanceId: cursorProviderInstanceId,
            cwd: process.cwd(),
            binaryPath,
            policy: catalogCase.policy,
          }),
        );
        assert.equal(error.code, "limit-exceeded");
      }

      for (const policy of [
        { maxReplayNotificationsPerSession: 2 },
        { maxReplayBytesPerSession: 1 },
        { maxNormalizedBytesPerConnection: 1 },
      ]) {
        const binaryPath = yield* Effect.promise(() =>
          makeAgentWrapper({ behavior: "replay-overflow" }),
        );
        const error = yield* Effect.flip(
          loadAcpImportSession(
            {
              driverKind: "cursor",
              providerInstanceId: cursorProviderInstanceId,
              cwd: process.cwd(),
              binaryPath,
              policy,
            },
            makeAcpImportSourcePath("cursor", cursorProviderInstanceId, "acp-session-second"),
          ),
        );
        assert.equal(error.code, "limit-exceeded");
      }
    }).pipe(TestClock.withLive),
  );

  it.effect("preserves opaque identifiers and rejects non-absolute catalog cwd values", () =>
    Effect.gen(function* () {
      const opaqueSessionId = " session/%opaque? ";
      const opaqueProviderInstanceId = " provider/%opaque? ";
      const opaqueSourcePath = makeAcpImportSourcePath(
        "cursor",
        opaqueProviderInstanceId,
        opaqueSessionId,
      );
      assert.deepStrictEqual(parseAcpImportSourcePath(opaqueSourcePath), {
        driverKind: "cursor",
        providerInstanceId: opaqueProviderInstanceId,
        nativeSessionId: opaqueSessionId,
      });
      const opaqueBinary = yield* Effect.promise(() =>
        makeAgentWrapper({ behavior: "opaque-identifiers" }),
      );
      const imported = yield* loadAcpImportSession(
        {
          driverKind: "cursor",
          providerInstanceId: cursorProviderInstanceId,
          cwd: process.cwd(),
          binaryPath: opaqueBinary,
        },
        makeAcpImportSourcePath("cursor", cursorProviderInstanceId, opaqueSessionId),
      );
      assert.equal(imported.meta.nativeSessionId, opaqueSessionId);
      assert.equal(
        imported.meta.sourcePath,
        makeAcpImportSourcePath("cursor", cursorProviderInstanceId, opaqueSessionId),
      );
      const otherProviderSourcePath = makeAcpImportSourcePath(
        "cursor",
        "other-provider-instance",
        opaqueSessionId,
      );
      assert.notEqual(imported.meta.sourcePath, otherProviderSourcePath);
      const [wrongProviderResult] = yield* loadAcpImportSessionsBatch(
        {
          driverKind: "cursor",
          providerInstanceId: cursorProviderInstanceId,
          cwd: process.cwd(),
          binaryPath: opaqueBinary,
        },
        [otherProviderSourcePath],
      );
      assert.equal(wrongProviderResult?.error?.code, "invalid-source");
      assert.include(wrongProviderResult?.error?.message ?? "", "provider instance");

      const invalidCwdBinary = yield* Effect.promise(() =>
        makeAgentWrapper({ behavior: "relative-cwd" }),
      );
      const invalidCwdError = yield* Effect.flip(
        scanAcpImportCatalog({
          driverKind: "cursor",
          providerInstanceId: cursorProviderInstanceId,
          cwd: process.cwd(),
          binaryPath: invalidCwdBinary,
        }),
      );
      assert.equal(invalidCwdError.code, "invalid-source");
      assert.include(invalidCwdError.message, "non-absolute cwd");
    }).pipe(TestClock.withLive),
  );

  it.effect("keeps metadata-interleaved chunks whole and omits unfinished tools", () =>
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() =>
        makeAgentWrapper({ behavior: "semantic-replay" }),
      );
      const imported = yield* loadAcpImportSession(
        {
          driverKind: "cursor",
          providerInstanceId: cursorProviderInstanceId,
          cwd: process.cwd(),
          binaryPath,
        },
        makeAcpImportSourcePath("cursor", cursorProviderInstanceId, "acp-session-second"),
      );

      assert.deepStrictEqual(
        imported.records.map((record) =>
          record.kind === "message"
            ? `${record.kind}:${record.role}:${record.text}`
            : `${record.kind}:${record.activityKind}:${record.summary}`,
        ),
        [
          "message:assistant:hello world",
          "activity:task.completed:Omitted 1 unfinished tool activity from imported ACP history",
        ],
      );
      assert.include(
        imported.warnings,
        "unfinished tool activities were omitted from ACP session replay",
      );
      assert.notInclude(JSON.stringify(imported), "unfinished-private-input");
    }).pipe(TestClock.withLive),
  );
});
