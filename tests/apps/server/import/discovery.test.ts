// tests/apps/server/import/discovery.test.ts
// verifies transcript discovery across file and acp source layouts
// @effect-diagnostics nodeBuiltinImport:off globalErrorInEffectFailure:off

import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  DEFAULT_SERVER_SETTINGS,
  IMPORT_SCAN_MAX_CANDIDATES,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
  ThreadId,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import type { AcpImportCatalogLoadResult } from "../../../../apps/server/src/import/acpImport.ts";
import { ImportDiscoveryDeps, make } from "../../../../apps/server/src/import/discovery.ts";
import { IMPORT_SCAN_MAX_TRAVERSAL_ENTRIES } from "../../../../apps/server/src/import/resourceLimits.ts";

const temporaryPaths: string[] = [];
const fixtureRoot = NodePath.resolve(NodeURL.fileURLToPath(new URL("./fixtures", import.meta.url)));
const CODEX = ProviderDriverKind.make("codex");
const CURSOR = ProviderDriverKind.make("cursor");
const CODEX_DEFAULT = ProviderInstanceId.make("codex");
const CLAUDE_DEFAULT = ProviderInstanceId.make("claudeAgent");
const OPENCODE_DEFAULT = ProviderInstanceId.make("opencode");
const DISCOVERY_PATH = "/usr/bin:/bin";

function codexSessionContent(nativeSessionId: string, paddingChars = 0): string {
  return [
    `{"timestamp":"2026-02-03T00:00:00Z","type":"session_meta","payload":{"id":"${nativeSessionId}","cwd":"/workspace/import-fairness"}}`,
    `{"timestamp":"2026-02-03T00:00:01Z","type":"event_msg","payload":{"type":"user_message","message":"${nativeSessionId}"}}`,
    " ".repeat(paddingChars),
  ].join("\n");
}

function loadedCursorSession(
  providerInstanceId: ProviderInstanceId,
  nativeSessionId: string,
  text: string,
): Extract<AcpImportCatalogLoadResult, { readonly error: null }> {
  const sourcePath = `acp://cursor/${encodeURIComponent(
    providerInstanceId,
  )}/${encodeURIComponent(nativeSessionId)}`;
  return {
    descriptor: {
      driverKind: "cursor",
      providerInstanceId,
      source: "cursor-acp",
      sourcePath,
      nativeSessionId,
      cwd: "/workspace/import-fairness",
      title: nativeSessionId,
      updatedAt: "2026-02-03T00:00:02.000Z",
    },
    session: {
      meta: {
        source: "cursor-acp",
        sourcePath,
        contentHash: "a".repeat(64),
        nativeSessionId,
        cwd: "/workspace/import-fairness",
        gitBranch: null,
        model: "cursor-model",
        title: nativeSessionId,
        firstActivityAt: "2026-02-03T00:00:02.000Z",
        lastActivityAt: "2026-02-03T00:00:02.000Z",
      },
      records: [
        {
          kind: "message",
          role: "user",
          text,
          sourceIndex: 0,
          createdAt: "2026-02-03T00:00:02.000Z",
        },
      ],
      warnings: [],
    },
    error: null,
  };
}

function settingsWith(input: {
  readonly providerInstances?: ServerSettings["providerInstances"];
}): ServerSettings {
  return {
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: input.providerInstances ?? DEFAULT_SERVER_SETTINGS.providerInstances,
  };
}

function isolatedImportSettings(
  providerInstances: ServerSettings["providerInstances"],
): ServerSettings {
  return {
    ...DEFAULT_SERVER_SETTINGS,
    providers: {
      codex: {
        ...DEFAULT_SERVER_SETTINGS.providers.codex,
        enabled: false,
      },
      claudeAgent: {
        ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent,
        enabled: false,
      },
      cursor: {
        ...DEFAULT_SERVER_SETTINGS.providers.cursor,
        enabled: false,
      },
      grok: {
        ...DEFAULT_SERVER_SETTINGS.providers.grok,
        enabled: false,
      },
      opencode: {
        ...DEFAULT_SERVER_SETTINGS.providers.opencode,
        enabled: false,
      },
    },
    providerInstances,
  };
}

async function temporaryHome(): Promise<string> {
  const path = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "456code-import-discovery-"));
  temporaryPaths.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => NodeFSP.rm(path, { recursive: true })));
});

describe("ImportDiscovery", () => {
  it.effect("finds supported layouts, enriches candidates, and ignores zero-message sessions", () =>
    Effect.gen(function* () {
      const homePath = yield* Effect.promise(() => temporaryHome());
      const codexDirectory = NodePath.join(homePath, ".codex", "sessions", "2026", "02", "03");
      const claudeDirectory = NodePath.join(homePath, ".claude", "projects", "repo");
      const claudeSessionId = "123e4567-e89b-42d3-a456-426614174000";
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(codexDirectory, { recursive: true });
        await NodeFSP.mkdir(claudeDirectory, { recursive: true });
        await NodeFSP.cp(
          NodePath.join(fixtureRoot, "codex-rollout-basic.jsonl"),
          NodePath.join(codexDirectory, "rollout-2026-01-01T00-00-00-codex-session-1.jsonl"),
        );
        const claudeFixture = await NodeFSP.readFile(
          NodePath.join(fixtureRoot, "claude-session-basic.jsonl"),
          "utf8",
        );
        await NodeFSP.writeFile(
          NodePath.join(claudeDirectory, `${claudeSessionId}.jsonl`),
          claudeFixture.replaceAll("123e4567-e89b-12d3-a456-426614174000", claudeSessionId),
        );
        await NodeFSP.writeFile(
          NodePath.join(codexDirectory, "rollout-empty.jsonl"),
          '{"timestamp":"2026-01-01T00:00:00Z","type":"session_meta","payload":{"id":"empty","cwd":"/empty"}}',
        );
      });

      const importedThreadId = ThreadId.make("already-imported");
      const projectId = ProjectId.make("matched-project");
      const alternateCodexId = ProviderInstanceId.make("codex_alternate");
      const discovery = yield* make.pipe(
        Effect.provideService(
          ImportDiscoveryDeps,
          ImportDiscoveryDeps.of({
            findThreadByContentHash: ({ nativeSessionId, providerInstanceId }) =>
              Effect.succeed(
                nativeSessionId === "codex-session-1" && providerInstanceId === alternateCodexId
                  ? {
                      threadId: importedThreadId,
                      providerInstanceId: alternateCodexId,
                      archived: true,
                    }
                  : null,
              ),
            findProjectByWorkspaceRoot: (root) =>
              Effect.succeed(root === "/workspace/latest" ? projectId : null),
            normalizeWorkspaceRoot: (root) => Effect.succeed(root),
            scanAcpSource: () => Effect.succeed([]),
          }),
        ),
      );

      const result = yield* discovery.scan(
        settingsWith({
          providerInstances: {
            [alternateCodexId]: {
              driver: CODEX,
              config: {},
            },
          },
        }),
        { environment: { PATH: DISCOVERY_PATH }, homePath, cwd: homePath },
      );

      expect(result.candidates).toHaveLength(2);
      expect(result.candidates.map((candidate) => candidate.source).toSorted()).toEqual([
        "claude-code",
        "codex-cli",
      ]);
      expect(result.candidates.find((candidate) => candidate.source === "codex-cli")).toMatchObject(
        {
          providerInstanceIds: [alternateCodexId, CODEX_DEFAULT],
          messageCount: 2,
          alreadyImportedThreadId: importedThreadId,
          alreadyImportedProviderInstanceId: alternateCodexId,
          alreadyImportedArchived: true,
          matchedProjectId: projectId,
          resumable: true,
        },
      );
      expect(
        result.candidates.find((candidate) => candidate.source === "claude-code"),
      ).toMatchObject({
        providerInstanceIds: [CLAUDE_DEFAULT],
        messageCount: 2,
        matchedProjectId: projectId,
        resumable: true,
      });
      expect(result.errors).toEqual([]);
    }),
  );

  it.effect("marks source/native identity mismatches as history-only candidates", () =>
    Effect.gen(function* () {
      const homePath = yield* Effect.promise(() => temporaryHome());
      const codexDirectory = NodePath.join(homePath, ".codex", "sessions", "2026", "02", "03");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(codexDirectory, { recursive: true });
        await NodeFSP.cp(
          NodePath.join(fixtureRoot, "codex-rollout-basic.jsonl"),
          NodePath.join(codexDirectory, "rollout-wrong-native-id.jsonl"),
        );
      });

      const discovery = yield* make.pipe(
        Effect.provideService(
          ImportDiscoveryDeps,
          ImportDiscoveryDeps.of({
            findThreadByContentHash: () => Effect.succeed(null),
            findProjectByWorkspaceRoot: () => Effect.succeed(null),
            normalizeWorkspaceRoot: (root) => Effect.succeed(root),
            scanAcpSource: () => Effect.succeed([]),
          }),
        ),
      );
      const result = yield* discovery.scan(DEFAULT_SERVER_SETTINGS, {
        environment: { PATH: DISCOVERY_PATH },
        homePath,
        cwd: homePath,
      });

      expect(result.errors).toEqual([]);
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]).toMatchObject({
        source: "codex-cli",
        nativeSessionId: "codex-session-1",
        resumable: false,
      });
    }),
  );

  it.effect("discovers OpenCode storage bundles through the configured data root", () =>
    Effect.gen(function* () {
      const homePath = yield* Effect.promise(() => temporaryHome());
      const dataRoot = NodePath.join(homePath, "xdg-data");
      const storageRoot = NodePath.join(dataRoot, "opencode", "storage");
      yield* Effect.promise(() =>
        NodeFSP.cp(NodePath.join(fixtureRoot, "opencode", "storage"), storageRoot, {
          recursive: true,
        }),
      );
      const projectId = ProjectId.make("opencode-project");
      const discovery = yield* make.pipe(
        Effect.provideService(
          ImportDiscoveryDeps,
          ImportDiscoveryDeps.of({
            findThreadByContentHash: () => Effect.succeed(null),
            findProjectByWorkspaceRoot: (root) =>
              Effect.succeed(root === "/workspace/opencode-fixture" ? projectId : null),
            normalizeWorkspaceRoot: (root) => Effect.succeed(root),
            scanAcpSource: () => Effect.succeed([]),
          }),
        ),
      );

      const result = yield* discovery.scan(DEFAULT_SERVER_SETTINGS, {
        environment: {
          HOME: homePath,
          PATH: DISCOVERY_PATH,
          XDG_DATA_HOME: dataRoot,
        },
        homePath,
        cwd: homePath,
      });

      expect(result.errors).toEqual([]);
      expect(result.candidates).toEqual([
        expect.objectContaining({
          source: "opencode",
          providerInstanceIds: [OPENCODE_DEFAULT],
          nativeSessionId: "ses_imported",
          title: "OpenCode import fixture",
          cwd: "/workspace/opencode-fixture",
          model: "openai/gpt-5.2",
          messageCount: 2,
          matchedProjectId: projectId,
          resumable: true,
        }),
      ]);
    }),
  );

  it.effect("keeps same-native ACP sessions distinct across exact provider instances", () =>
    Effect.gen(function* () {
      const homePath = yield* Effect.promise(() => temporaryHome());
      const firstCursorId = ProviderInstanceId.make("cursor_first");
      const secondCursorId = ProviderInstanceId.make("cursor_second");
      const nativeSessionId = "cursor/session 1";
      const contentHash = "a".repeat(64);
      const projectId = ProjectId.make("cursor-project");
      const importedThreadId = ThreadId.make("cursor-imported-thread");
      const settings: ServerSettings = {
        ...DEFAULT_SERVER_SETTINGS,
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          cursor: {
            ...DEFAULT_SERVER_SETTINGS.providers.cursor,
            enabled: false,
          },
          grok: {
            ...DEFAULT_SERVER_SETTINGS.providers.grok,
            enabled: false,
          },
        },
        providerInstances: {
          [firstCursorId]: {
            driver: CURSOR,
            config: { enabled: true },
          },
          [secondCursorId]: {
            driver: CURSOR,
            config: { enabled: true },
          },
        },
      };
      const discovery = yield* make.pipe(
        Effect.provideService(
          ImportDiscoveryDeps,
          ImportDiscoveryDeps.of({
            findThreadByContentHash: (lookup) =>
              Effect.succeed(
                lookup.contentHash === contentHash && lookup.providerInstanceId === firstCursorId
                  ? {
                      threadId: importedThreadId,
                      providerInstanceId: firstCursorId,
                      archived: false,
                    }
                  : null,
              ),
            findProjectByWorkspaceRoot: (root) =>
              Effect.succeed(root === "/workspace/cursor" ? projectId : null),
            normalizeWorkspaceRoot: (root) => Effect.succeed(root),
            scanAcpSource: (descriptor) =>
              Effect.sync(() => {
                const sourcePath = `acp://cursor/${encodeURIComponent(
                  descriptor.providerInstanceId,
                )}/${encodeURIComponent(nativeSessionId)}`;
                return [
                  {
                    descriptor: {
                      driverKind: "cursor",
                      providerInstanceId: descriptor.providerInstanceId,
                      source: "cursor-acp",
                      sourcePath,
                      nativeSessionId,
                      cwd: "/workspace/cursor",
                      title: "Cursor history",
                      updatedAt: "2026-01-01T00:00:01.000Z",
                    },
                    session: {
                      meta: {
                        source: "cursor-acp",
                        sourcePath,
                        contentHash,
                        nativeSessionId,
                        cwd: "/workspace/cursor",
                        gitBranch: null,
                        model: "cursor-model",
                        title: "Cursor history",
                        firstActivityAt: "2026-01-01T00:00:00.000Z",
                        lastActivityAt: "2026-01-01T00:00:00.000Z",
                      },
                      records: [
                        {
                          kind: "message",
                          role: "user",
                          text: `history from ${descriptor.source}`,
                          sourceIndex: 0,
                          createdAt: "2026-01-01T00:00:00.000Z",
                        },
                      ],
                      warnings: [],
                    },
                    error: null,
                  },
                ];
              }),
          }),
        ),
      );

      const result = yield* discovery.scan(settings, {
        environment: { HOME: homePath, PATH: DISCOVERY_PATH },
        homePath,
        cwd: homePath,
      });

      expect(result.errors).toEqual([]);
      expect(result.candidates).toEqual([
        {
          source: "cursor",
          sourcePath: `acp://cursor/${firstCursorId}/cursor%2Fsession%201`,
          providerInstanceIds: [firstCursorId],
          nativeSessionId,
          title: "Cursor history",
          cwd: "/workspace/cursor",
          gitBranch: null,
          model: "cursor-model",
          messageCount: 1,
          modifiedAt: "2026-01-01T00:00:01.000Z",
          alreadyImportedThreadId: importedThreadId,
          alreadyImportedProviderInstanceId: firstCursorId,
          alreadyImportedArchived: false,
          matchedProjectId: projectId,
          resumable: true,
        },
        {
          source: "cursor",
          sourcePath: `acp://cursor/${secondCursorId}/cursor%2Fsession%201`,
          providerInstanceIds: [secondCursorId],
          nativeSessionId,
          title: "Cursor history",
          cwd: "/workspace/cursor",
          gitBranch: null,
          model: "cursor-model",
          messageCount: 1,
          modifiedAt: "2026-01-01T00:00:01.000Z",
          alreadyImportedThreadId: null,
          alreadyImportedProviderInstanceId: null,
          alreadyImportedArchived: false,
          matchedProjectId: projectId,
          resumable: true,
        },
      ]);
    }),
  );

  it.effect("tolerates absent roots and records per-file parse failures", () =>
    Effect.gen(function* () {
      const homePath = yield* Effect.promise(() => temporaryHome());
      const claudeDirectory = NodePath.join(homePath, ".claude", "projects", "repo");
      const sourcePath = NodePath.join(
        claudeDirectory,
        "123e4567-e89b-42d3-a456-426614174001.jsonl",
      );
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(claudeDirectory, { recursive: true });
        const claudeFixture = await NodeFSP.readFile(
          NodePath.join(fixtureRoot, "claude-session-basic.jsonl"),
          "utf8",
        );
        await NodeFSP.writeFile(
          sourcePath,
          claudeFixture.replaceAll(
            "123e4567-e89b-12d3-a456-426614174000",
            "123e4567-e89b-42d3-a456-426614174001",
          ),
        );
      });

      const discovery = yield* make.pipe(
        Effect.provideService(
          ImportDiscoveryDeps,
          ImportDiscoveryDeps.of({
            findThreadByContentHash: () => Effect.fail(new Error("lookup failed")),
            findProjectByWorkspaceRoot: () => Effect.succeed(null),
            normalizeWorkspaceRoot: (root) => Effect.succeed(root),
            scanAcpSource: () => Effect.succeed([]),
          }),
        ),
      );
      const result = yield* discovery.scan(DEFAULT_SERVER_SETTINGS, {
        environment: { PATH: DISCOVERY_PATH },
        homePath,
        cwd: homePath,
      });
      const canonicalSourcePath = yield* Effect.promise(() => NodeFSP.realpath(sourcePath));

      expect(result.candidates).toEqual([]);
      expect(result.errors).toEqual([
        { sourcePath: canonicalSourcePath, message: "lookup failed" },
      ]);
    }),
  );

  it.effect("skips candidates larger than 25MB before reading or parsing them", () =>
    Effect.gen(function* () {
      const homePath = yield* Effect.promise(() => temporaryHome());
      const codexDirectory = NodePath.join(homePath, ".codex", "sessions", "2026", "02", "03");
      const sourcePath = NodePath.join(codexDirectory, "rollout-oversized.jsonl");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(codexDirectory, { recursive: true });
        await NodeFSP.writeFile(sourcePath, "");
        await NodeFSP.truncate(sourcePath, 25 * 1024 * 1024 + 1);
      });

      const discovery = yield* make.pipe(
        Effect.provideService(
          ImportDiscoveryDeps,
          ImportDiscoveryDeps.of({
            findThreadByContentHash: () => Effect.succeed(null),
            findProjectByWorkspaceRoot: () => Effect.succeed(null),
            normalizeWorkspaceRoot: (root) => Effect.succeed(root),
            scanAcpSource: () => Effect.succeed([]),
          }),
        ),
      );
      const result = yield* discovery.scan(DEFAULT_SERVER_SETTINGS, {
        environment: { PATH: DISCOVERY_PATH },
        homePath,
        cwd: homePath,
      });
      const canonicalSourcePath = yield* Effect.promise(() => NodeFSP.realpath(sourcePath));

      expect(result.candidates).toEqual([]);
      expect(result.errors).toEqual([
        {
          sourcePath: canonicalSourcePath,
          message: "skipped: file exceeds 25MB",
        },
      ]);
    }),
  );

  it.effect("keeps the newest files when discovery exceeds the candidate limit", () =>
    Effect.gen(function* () {
      const homePath = yield* Effect.promise(() => temporaryHome());
      const codexDirectory = NodePath.join(homePath, ".codex", "sessions", "2026", "02", "03");
      const oldestSessionId = `session-${IMPORT_SCAN_MAX_CANDIDATES}`;
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(codexDirectory, { recursive: true });
        for (let start = 0; start <= IMPORT_SCAN_MAX_CANDIDATES; start += 100) {
          await Promise.all(
            Array.from(
              {
                length: Math.min(100, IMPORT_SCAN_MAX_CANDIDATES + 1 - start),
              },
              async (_, offset) => {
                const index = start + offset;
                const nativeSessionId = `session-${index.toString().padStart(4, "0")}`;
                const sourcePath = NodePath.join(
                  codexDirectory,
                  `rollout-2026-02-03T00-00-00-${nativeSessionId}.jsonl`,
                );
                const content = [
                  `{"timestamp":"2026-02-03T00:00:00Z","type":"session_meta","payload":{"id":"${nativeSessionId}","cwd":"/workspace/import-limit"}}`,
                  `{"timestamp":"2026-02-03T00:00:01Z","type":"event_msg","payload":{"type":"user_message","message":"${nativeSessionId}"}}`,
                ].join("\n");
                await NodeFSP.writeFile(sourcePath, content);
                const modifiedAt =
                  nativeSessionId === oldestSessionId ? 1_700_000_000 : 1_700_000_001;
                await NodeFSP.utimes(sourcePath, modifiedAt, modifiedAt);
              },
            ),
          );
        }
      });

      const discovery = yield* make.pipe(
        Effect.provideService(
          ImportDiscoveryDeps,
          ImportDiscoveryDeps.of({
            findThreadByContentHash: () => Effect.succeed(null),
            findProjectByWorkspaceRoot: () => Effect.succeed(null),
            normalizeWorkspaceRoot: (root) => Effect.succeed(root),
            scanAcpSource: () => Effect.succeed([]),
          }),
        ),
      );
      const result = yield* discovery.scan(DEFAULT_SERVER_SETTINGS, {
        environment: { PATH: DISCOVERY_PATH },
        homePath,
        cwd: homePath,
      });

      expect(result.candidates).toHaveLength(IMPORT_SCAN_MAX_CANDIDATES);
      expect(
        result.candidates.some((candidate) => candidate.nativeSessionId === "session-0000"),
      ).toBe(true);
      expect(
        result.candidates.some((candidate) => candidate.nativeSessionId === oldestSessionId),
      ).toBe(false);
      expect(result.errors).toContainEqual({
        sourcePath: null,
        message: `scan truncated after ${IMPORT_SCAN_MAX_CANDIDATES} candidates`,
      });
    }),
  );

  it.effect(
    "preserves partial file results and ACP opportunity when one file root exhausts traversal",
    () =>
      Effect.gen(function* () {
        const homePath = yield* Effect.promise(() => temporaryHome());
        const codexDirectory = NodePath.join(homePath, ".codex", "sessions", "2026", "02", "03");
        const claudeDirectory = NodePath.join(homePath, ".claude", "projects", "repo");
        const claudeSessionId = "123e4567-e89b-42d3-a456-426614174099";
        const saturatedFileCount = Math.ceil(IMPORT_SCAN_MAX_TRAVERSAL_ENTRIES / 3) + 10;
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(codexDirectory, { recursive: true });
          await NodeFSP.mkdir(claudeDirectory, { recursive: true });
          for (let start = 0; start < saturatedFileCount; start += 100) {
            await Promise.all(
              Array.from(
                {
                  length: Math.min(100, saturatedFileCount - start),
                },
                (_, offset) => {
                  const index = start + offset;
                  const nativeSessionId = `fair-session-${index.toString().padStart(4, "0")}`;
                  return NodeFSP.writeFile(
                    NodePath.join(
                      codexDirectory,
                      `rollout-2026-02-03T00-00-00-${nativeSessionId}.jsonl`,
                    ),
                    [
                      `{"timestamp":"2026-02-03T00:00:00Z","type":"session_meta","payload":{"id":"${nativeSessionId}","cwd":"/workspace/import-fairness"}}`,
                      `{"timestamp":"2026-02-03T00:00:01Z","type":"event_msg","payload":{"type":"user_message","message":"${nativeSessionId}"}}`,
                    ].join("\n"),
                  );
                },
              ),
            );
          }
          const claudeFixture = await NodeFSP.readFile(
            NodePath.join(fixtureRoot, "claude-session-basic.jsonl"),
            "utf8",
          );
          await NodeFSP.writeFile(
            NodePath.join(claudeDirectory, `${claudeSessionId}.jsonl`),
            claudeFixture.replaceAll("123e4567-e89b-12d3-a456-426614174000", claudeSessionId),
          );
        });

        const cursorId = ProviderInstanceId.make("cursor_fairness");
        const settings: ServerSettings = {
          ...DEFAULT_SERVER_SETTINGS,
          providers: {
            ...DEFAULT_SERVER_SETTINGS.providers,
            cursor: {
              ...DEFAULT_SERVER_SETTINGS.providers.cursor,
              enabled: false,
            },
            grok: {
              ...DEFAULT_SERVER_SETTINGS.providers.grok,
              enabled: false,
            },
          },
          providerInstances: {
            [cursorId]: {
              driver: CURSOR,
              config: { enabled: true },
            },
          },
        };
        const acpScanLimits: number[] = [];
        const discovery = yield* make.pipe(
          Effect.provideService(
            ImportDiscoveryDeps,
            ImportDiscoveryDeps.of({
              findThreadByContentHash: () => Effect.succeed(null),
              findProjectByWorkspaceRoot: () => Effect.succeed(null),
              normalizeWorkspaceRoot: (root) => Effect.succeed(root),
              scanAcpSource: (descriptor, maximumSessionsToLoad) =>
                Effect.sync(() => {
                  acpScanLimits.push(maximumSessionsToLoad);
                  const nativeSessionId = "cursor-fair-session";
                  const sourcePath = `acp://cursor/${encodeURIComponent(
                    descriptor.providerInstanceId,
                  )}/${encodeURIComponent(nativeSessionId)}`;
                  return [
                    {
                      descriptor: {
                        driverKind: "cursor",
                        providerInstanceId: descriptor.providerInstanceId,
                        source: "cursor-acp",
                        sourcePath,
                        nativeSessionId,
                        cwd: "/workspace/import-fairness",
                        title: "Cursor fair candidate",
                        updatedAt: "2026-02-03T00:00:02.000Z",
                      },
                      session: {
                        meta: {
                          source: "cursor-acp",
                          sourcePath,
                          contentHash: "a".repeat(64),
                          nativeSessionId,
                          cwd: "/workspace/import-fairness",
                          gitBranch: null,
                          model: "cursor-model",
                          title: "Cursor fair candidate",
                          firstActivityAt: "2026-02-03T00:00:02.000Z",
                          lastActivityAt: "2026-02-03T00:00:02.000Z",
                        },
                        records: [
                          {
                            kind: "message",
                            role: "user",
                            text: "ACP candidate",
                            sourceIndex: 0,
                            createdAt: "2026-02-03T00:00:02.000Z",
                          },
                        ],
                        warnings: [],
                      },
                      error: null,
                    },
                  ];
                }),
            }),
          ),
        );

        const result = yield* discovery.scan(settings, {
          environment: { HOME: homePath, PATH: DISCOVERY_PATH },
          homePath,
          cwd: homePath,
        });

        expect(result.candidates).toHaveLength(IMPORT_SCAN_MAX_CANDIDATES);
        expect(result.candidates.some((candidate) => candidate.source === "codex-cli")).toBe(true);
        expect(result.candidates.some((candidate) => candidate.source === "claude-code")).toBe(
          true,
        );
        expect(
          result.candidates.some(
            (candidate) =>
              candidate.source === "cursor" && candidate.providerInstanceIds.includes(cursorId),
          ),
        ).toBe(true);
        expect(acpScanLimits).toHaveLength(1);
        expect(acpScanLimits[0]).toBeGreaterThan(0);
        expect(result.errors).toContainEqual({
          sourcePath: null,
          message: `scan traversal truncated within the ${IMPORT_SCAN_MAX_TRAVERSAL_ENTRIES}-entry global budget for 1 source root; partial results may omit sessions not reached within a root's fair share`,
        });
        expect(result.errors).toContainEqual({
          sourcePath: null,
          message: `scan truncated after ${IMPORT_SCAN_MAX_CANDIDATES} candidates`,
        });
      }),
    30_000,
  );

  it.effect("keeps later file roots eligible when an earlier root exhausts its byte share", () =>
    Effect.gen(function* () {
      const homePath = yield* Effect.promise(() => temporaryHome());
      const firstCodexHome = NodePath.join(homePath, "codex-first");
      const laterCodexHome = NodePath.join(homePath, "codex-later");
      const firstDirectory = NodePath.join(firstCodexHome, "sessions", "2026", "02", "03");
      const laterDirectory = NodePath.join(laterCodexHome, "sessions", "2026", "02", "03");
      const firstSmallPath = NodePath.join(firstDirectory, "rollout-first-small.jsonl");
      const firstLargePath = NodePath.join(firstDirectory, "rollout-first-large.jsonl");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(firstDirectory, { recursive: true });
        await NodeFSP.mkdir(laterDirectory, { recursive: true });
        await Promise.all([
          NodeFSP.writeFile(firstSmallPath, codexSessionContent("first-small", 600)),
          NodeFSP.writeFile(firstLargePath, codexSessionContent("first-large", 2_200)),
          NodeFSP.writeFile(
            NodePath.join(laterDirectory, "rollout-later.jsonl"),
            codexSessionContent("later"),
          ),
        ]);
        await Promise.all([
          NodeFSP.utimes(firstSmallPath, 1_700_000_003, 1_700_000_003),
          NodeFSP.utimes(firstLargePath, 1_700_000_001, 1_700_000_001),
        ]);
      });

      const laterCodexId = ProviderInstanceId.make("codex_later");
      const cursorId = ProviderInstanceId.make("cursor_byte_class");
      const settings = isolatedImportSettings({
        [CODEX_DEFAULT]: {
          driver: CODEX,
          enabled: true,
          config: { homePath: firstCodexHome },
        },
        [laterCodexId]: {
          driver: CODEX,
          enabled: true,
          config: { homePath: laterCodexHome },
        },
        [cursorId]: {
          driver: CURSOR,
          enabled: true,
          config: {},
        },
      });
      const discovery = yield* make.pipe(
        Effect.provideService(
          ImportDiscoveryDeps,
          ImportDiscoveryDeps.of({
            findThreadByContentHash: () => Effect.succeed(null),
            findProjectByWorkspaceRoot: () => Effect.succeed(null),
            normalizeWorkspaceRoot: (root) => Effect.succeed(root),
            scanAcpSource: () => Effect.succeed([]),
            resourceLimits: { maximumScanBytes: 8_192 },
          }),
        ),
      );

      const result = yield* discovery.scan(settings, {
        environment: { HOME: homePath, PATH: DISCOVERY_PATH },
        homePath,
        cwd: homePath,
      });

      expect(result.candidates).toHaveLength(2);
      expect(result.candidates.map((candidate) => candidate.providerInstanceIds[0])).toEqual(
        expect.arrayContaining([CODEX_DEFAULT, laterCodexId]),
      );
      expect(result.candidates.map((candidate) => candidate.nativeSessionId)).toEqual(
        expect.arrayContaining(["first-small", "later"]),
      );
      expect(
        result.errors.some(
          (issue) =>
            issue.sourcePath?.endsWith("rollout-first-large.jsonl") === true &&
            issue.message.includes("byte budget exceeded"),
        ),
      ).toBe(true);
    }),
  );

  it.effect("keeps ACP descriptor byte shares independent while admitting later providers", () =>
    Effect.gen(function* () {
      const homePath = yield* Effect.promise(() => temporaryHome());
      const firstCursorId = ProviderInstanceId.make("cursor_bytes_first");
      const laterCursorId = ProviderInstanceId.make("cursor_bytes_later");
      const firstSession = loadedCursorSession(firstCursorId, "first-one", "x".repeat(600));
      const rejectedSession = loadedCursorSession(firstCursorId, "first-two", "x".repeat(600));
      const laterSession = loadedCursorSession(laterCursorId, "later", "x".repeat(600));

      const descriptorByteLimits: Array<{
        readonly catalog: number;
        readonly normalized: number;
        readonly replayConnection: number;
        readonly replaySession: number;
      }> = [];
      const discovery = yield* make.pipe(
        Effect.provideService(
          ImportDiscoveryDeps,
          ImportDiscoveryDeps.of({
            findThreadByContentHash: () => Effect.succeed(null),
            findProjectByWorkspaceRoot: () => Effect.succeed(null),
            normalizeWorkspaceRoot: (root) => Effect.succeed(root),
            scanAcpSource: (descriptor) =>
              Effect.sync(() => {
                descriptorByteLimits.push({
                  catalog: descriptor.connection.policy?.maxCatalogBytes ?? -1,
                  normalized: descriptor.connection.policy?.maxNormalizedBytesPerConnection ?? -1,
                  replayConnection: descriptor.connection.policy?.maxReplayBytesPerConnection ?? -1,
                  replaySession: descriptor.connection.policy?.maxReplayBytesPerSession ?? -1,
                });
                return descriptor.providerInstanceId === firstCursorId
                  ? [firstSession, rejectedSession]
                  : [laterSession];
              }),
            resourceLimits: { maximumScanBytes: 8_192 },
          }),
        ),
      );
      const result = yield* discovery.scan(
        isolatedImportSettings({
          [firstCursorId]: {
            driver: CURSOR,
            enabled: true,
            config: {},
          },
          [laterCursorId]: {
            driver: CURSOR,
            enabled: true,
            config: {},
          },
        }),
        {
          environment: { HOME: homePath, PATH: DISCOVERY_PATH },
          homePath,
          cwd: homePath,
        },
      );

      expect(result.candidates.map((candidate) => candidate.providerInstanceIds[0])).toEqual(
        expect.arrayContaining([firstCursorId, laterCursorId]),
      );
      expect(
        result.errors.some(
          (issue) =>
            issue.sourcePath === rejectedSession.descriptor.sourcePath &&
            issue.message.includes("normalized byte budget exceeded (1536 bytes maximum)"),
        ),
      ).toBe(true);
      expect(descriptorByteLimits).toHaveLength(2);
      expect(descriptorByteLimits[0]).toEqual({
        catalog: 1_024,
        normalized: 1_536,
        replayConnection: 1_536,
        replaySession: 1_536,
      });
      for (const limits of descriptorByteLimits) {
        expect(limits.catalog + limits.replayConnection + limits.normalized).toBeLessThanOrEqual(
          8_192,
        );
        expect(limits.replaySession).toBeLessThanOrEqual(limits.replayConnection);
      }
    }),
  );

  it.effect("times out one ACP descriptor while preserving file and later ACP results", () =>
    Effect.gen(function* () {
      const homePath = yield* Effect.promise(() => temporaryHome());
      const codexHome = NodePath.join(homePath, "codex-timeout");
      const codexDirectory = NodePath.join(codexHome, "sessions", "2026", "02", "03");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(codexDirectory, { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(codexDirectory, "rollout-file-result.jsonl"),
          codexSessionContent("file-result"),
        );
      });

      const firstCursorId = ProviderInstanceId.make("cursor_timeout_first");
      const laterCursorId = ProviderInstanceId.make("cursor_timeout_later");
      const firstScanStarted = yield* Deferred.make<void>();
      const discovery = yield* make.pipe(
        Effect.provideService(
          ImportDiscoveryDeps,
          ImportDiscoveryDeps.of({
            findThreadByContentHash: () => Effect.succeed(null),
            findProjectByWorkspaceRoot: () => Effect.succeed(null),
            normalizeWorkspaceRoot: (root) => Effect.succeed(root),
            scanAcpSource: (descriptor) =>
              descriptor.providerInstanceId === firstCursorId
                ? Deferred.succeed(firstScanStarted, undefined).pipe(Effect.andThen(Effect.never))
                : Effect.succeed([
                    loadedCursorSession(laterCursorId, "later-after-timeout", "later result"),
                  ]),
            resourceLimits: {
              maximumScanBytes: 8_192,
              acpScanPhaseTimeoutMs: 100,
            },
          }),
        ),
      );
      const scanFiber = yield* discovery
        .scan(
          isolatedImportSettings({
            [CODEX_DEFAULT]: {
              driver: CODEX,
              enabled: true,
              config: { homePath: codexHome },
            },
            [firstCursorId]: {
              driver: CURSOR,
              enabled: true,
              config: {},
            },
            [laterCursorId]: {
              driver: CURSOR,
              enabled: true,
              config: {},
            },
          }),
          {
            environment: { HOME: homePath, PATH: DISCOVERY_PATH },
            homePath,
            cwd: homePath,
          },
        )
        .pipe(Effect.forkScoped);

      yield* Deferred.await(firstScanStarted);
      yield* TestClock.adjust("50 millis");
      const result = yield* Fiber.join(scanFiber);

      expect(result.candidates.map((candidate) => candidate.providerInstanceIds[0])).toEqual(
        expect.arrayContaining([CODEX_DEFAULT, laterCursorId]),
      );
      expect(
        result.candidates.some((candidate) =>
          candidate.providerInstanceIds.includes(firstCursorId),
        ),
      ).toBe(false);
      expect(result.errors).toContainEqual({
        sourcePath: null,
        message: `scan timed out after 50ms for cursor sessions for provider instance '${firstCursorId}'`,
      });
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.effect("times out ACP result processing before scanning the next descriptor", () =>
    Effect.gen(function* () {
      const homePath = yield* Effect.promise(() => temporaryHome());
      const firstCursorId = ProviderInstanceId.make("cursor_processing_timeout_first");
      const laterCursorId = ProviderInstanceId.make("cursor_processing_timeout_later");
      const blockedLookupStarted = yield* Deferred.make<void>();
      let projectLookupCount = 0;
      const discovery = yield* make.pipe(
        Effect.provideService(
          ImportDiscoveryDeps,
          ImportDiscoveryDeps.of({
            findThreadByContentHash: () => Effect.succeed(null),
            findProjectByWorkspaceRoot: () =>
              Effect.suspend(() => {
                projectLookupCount += 1;
                return projectLookupCount === 1
                  ? Deferred.succeed(blockedLookupStarted, undefined).pipe(
                      Effect.andThen(Effect.never),
                    )
                  : Effect.succeed(null);
              }),
            normalizeWorkspaceRoot: (root) => Effect.succeed(root),
            scanAcpSource: (descriptor) =>
              Effect.succeed([
                loadedCursorSession(
                  descriptor.providerInstanceId,
                  descriptor.providerInstanceId === firstCursorId
                    ? "blocked-processing"
                    : "later-after-processing-timeout",
                  descriptor.providerInstanceId === firstCursorId
                    ? "blocked result"
                    : "later result",
                ),
              ]),
            resourceLimits: {
              maximumScanBytes: 8_192,
              scanTimeoutMs: 200,
              acpScanPhaseTimeoutMs: 100,
            },
          }),
        ),
      );
      const scanFiber = yield* discovery
        .scan(
          isolatedImportSettings({
            [firstCursorId]: {
              driver: CURSOR,
              enabled: true,
              config: {},
            },
            [laterCursorId]: {
              driver: CURSOR,
              enabled: true,
              config: {},
            },
          }),
          {
            environment: { HOME: homePath, PATH: DISCOVERY_PATH },
            homePath,
            cwd: homePath,
          },
        )
        .pipe(Effect.forkScoped);

      yield* Deferred.await(blockedLookupStarted);
      yield* TestClock.adjust("50 millis");
      const result = yield* Fiber.join(scanFiber);

      expect(result.candidates).toEqual([
        expect.objectContaining({
          source: "cursor",
          nativeSessionId: "later-after-processing-timeout",
          providerInstanceIds: [laterCursorId],
        }),
      ]);
      expect(result.errors).toContainEqual({
        sourcePath: null,
        message: `scan timed out after 50ms for cursor sessions for provider instance '${firstCursorId}'`,
      });
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.effect("returns completed candidates when a file-root processing deadline expires", () =>
    Effect.gen(function* () {
      const homePath = yield* Effect.promise(() => temporaryHome());
      const codexHome = NodePath.join(homePath, "codex-outer-timeout");
      const codexDirectory = NodePath.join(codexHome, "sessions", "2026", "02", "03");
      const completedPath = NodePath.join(codexDirectory, "rollout-completed.jsonl");
      const blockedPath = NodePath.join(codexDirectory, "rollout-blocked.jsonl");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(codexDirectory, { recursive: true });
        await Promise.all([
          NodeFSP.writeFile(completedPath, codexSessionContent("completed-before-timeout")),
          NodeFSP.writeFile(blockedPath, codexSessionContent("blocked-at-timeout")),
        ]);
        await Promise.all([
          NodeFSP.utimes(completedPath, 1_700_000_002, 1_700_000_002),
          NodeFSP.utimes(blockedPath, 1_700_000_001, 1_700_000_001),
        ]);
      });

      const blockedLookupStarted = yield* Deferred.make<void>();
      let projectLookupCount = 0;
      const discovery = yield* make.pipe(
        Effect.provideService(
          ImportDiscoveryDeps,
          ImportDiscoveryDeps.of({
            findThreadByContentHash: () => Effect.succeed(null),
            findProjectByWorkspaceRoot: () =>
              Effect.suspend(() => {
                projectLookupCount += 1;
                return projectLookupCount === 1
                  ? Effect.succeed(null)
                  : Deferred.succeed(blockedLookupStarted, undefined).pipe(
                      Effect.andThen(Effect.never),
                    );
              }),
            normalizeWorkspaceRoot: (root) => Effect.succeed(root),
            scanAcpSource: () => Effect.succeed([]),
            resourceLimits: {
              scanTimeoutMs: 100,
            },
          }),
        ),
      );
      const scanFiber = yield* discovery
        .scan(
          isolatedImportSettings({
            [CODEX_DEFAULT]: {
              driver: CODEX,
              enabled: true,
              config: { homePath: codexHome },
            },
          }),
          {
            environment: { HOME: homePath, PATH: DISCOVERY_PATH },
            homePath,
            cwd: homePath,
          },
        )
        .pipe(Effect.forkScoped);

      yield* Deferred.await(blockedLookupStarted);
      yield* TestClock.adjust("45 millis");
      const result = yield* Fiber.join(scanFiber);

      expect(result.candidates.map((candidate) => candidate.nativeSessionId)).toEqual([
        "completed-before-timeout",
      ]);
      expect(
        result.errors.some(
          (issue) =>
            issue.sourcePath?.endsWith("/codex-outer-timeout/sessions") === true &&
            issue.message === "file-source candidate processing timed out after 45ms",
        ),
      ).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.effect("reserves catalog and ACP time when a file candidate blocks", () =>
    Effect.gen(function* () {
      const homePath = yield* Effect.promise(() => temporaryHome());
      const codexHome = NodePath.join(homePath, "codex-blocked-before-acp");
      const codexDirectory = NodePath.join(codexHome, "sessions", "2026", "02", "03");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(codexDirectory, { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(codexDirectory, "rollout-blocked.jsonl"),
          codexSessionContent("blocked-file"),
        );
      });

      const cursorId = ProviderInstanceId.make("cursor_after_blocked_file");
      const blockedLookupStarted = yield* Deferred.make<void>();
      let projectLookupCount = 0;
      const discovery = yield* make.pipe(
        Effect.provideService(
          ImportDiscoveryDeps,
          ImportDiscoveryDeps.of({
            findThreadByContentHash: () => Effect.succeed(null),
            findProjectByWorkspaceRoot: () =>
              Effect.suspend(() => {
                projectLookupCount += 1;
                return projectLookupCount === 1
                  ? Deferred.succeed(blockedLookupStarted, undefined).pipe(
                      Effect.andThen(Effect.never),
                    )
                  : Effect.succeed(null);
              }),
            normalizeWorkspaceRoot: (root) => Effect.succeed(root),
            scanAcpSource: () =>
              Effect.succeed([
                loadedCursorSession(cursorId, "acp-after-blocked-file", "ACP still scanned"),
              ]),
            resourceLimits: {
              maximumScanBytes: 8_192,
              scanTimeoutMs: 200,
              acpScanPhaseTimeoutMs: 100,
            },
          }),
        ),
      );
      const scanFiber = yield* discovery
        .scan(
          isolatedImportSettings({
            [CODEX_DEFAULT]: {
              driver: CODEX,
              enabled: true,
              config: { homePath: codexHome },
            },
            [cursorId]: {
              driver: CURSOR,
              enabled: true,
              config: {},
            },
          }),
          {
            environment: { HOME: homePath, PATH: DISCOVERY_PATH },
            homePath,
            cwd: homePath,
          },
        )
        .pipe(Effect.forkScoped);

      yield* Deferred.await(blockedLookupStarted);
      yield* TestClock.adjust("40 millis");
      const result = yield* Fiber.join(scanFiber);

      expect(result.candidates).toEqual([
        expect.objectContaining({
          source: "cursor",
          nativeSessionId: "acp-after-blocked-file",
          providerInstanceIds: [cursorId],
        }),
      ]);
      expect(
        result.errors.some(
          (issue) =>
            issue.sourcePath?.endsWith("/codex-blocked-before-acp/sessions") === true &&
            issue.message === "file-source candidate processing timed out after 40ms",
        ),
      ).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.effect(
    "shares one process-wide scan gate across service instances and releases on interrupt",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const homePath = yield* Effect.promise(() => temporaryHome());
          const cursorId = ProviderInstanceId.make("cursor_overlap");
          const firstScanStarted = yield* Deferred.make<void>();
          let scanCallCount = 0;
          const deps = ImportDiscoveryDeps.of({
            findThreadByContentHash: () => Effect.succeed(null),
            findProjectByWorkspaceRoot: () => Effect.succeed(null),
            normalizeWorkspaceRoot: (root) => Effect.succeed(root),
            scanAcpSource: () =>
              Effect.suspend(() => {
                scanCallCount += 1;
                return scanCallCount === 1
                  ? Deferred.succeed(firstScanStarted, undefined).pipe(Effect.andThen(Effect.never))
                  : Effect.succeed([]);
              }),
          });
          const firstDiscovery = yield* make.pipe(Effect.provideService(ImportDiscoveryDeps, deps));
          const secondDiscovery = yield* make.pipe(
            Effect.provideService(ImportDiscoveryDeps, deps),
          );
          const settings = isolatedImportSettings({
            [cursorId]: {
              driver: CURSOR,
              enabled: true,
              config: {},
            },
          });
          const scanOptions = {
            environment: { HOME: homePath, PATH: DISCOVERY_PATH },
            homePath,
            cwd: homePath,
          };

          const firstFiber = yield* firstDiscovery
            .scan(settings, scanOptions)
            .pipe(Effect.forkScoped);
          yield* Deferred.await(firstScanStarted);
          const overlappingResult = yield* secondDiscovery.scan(settings, scanOptions);

          expect(overlappingResult.candidates).toEqual([]);
          expect(overlappingResult.errors).toEqual([
            {
              sourcePath: null,
              message: "scan skipped because another import scan is already in progress",
            },
          ]);
          expect(scanCallCount).toBe(1);

          yield* Fiber.interrupt(firstFiber);
          const resultAfterInterrupt = yield* secondDiscovery.scan(settings, scanOptions);

          expect(resultAfterInterrupt.errors).toEqual([]);
          expect(scanCallCount).toBe(2);
        }),
      ),
  );
});
