// tests/apps/server/import/sourceCatalog.test.ts
// verifies configured transcript roots, provider compatibility, and canonical containment
// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import {
  codexSessionTitleForSource,
  groupImportFileSourceDescriptors,
  readResolvedImportSourceFile,
  resolveAcpImportSourceCatalog,
  resolveImportSourcePath,
  resolveSourceCatalog,
} from "../../../../apps/server/src/import/sourceCatalog.ts";
import { makeImportByteBudget } from "../../../../apps/server/src/import/resourceLimits.ts";
import { fileContinuationIdentity } from "../../../../apps/server/src/provider/continuationIdentity.ts";

const CODEX = ProviderDriverKind.make("codex");
const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CURSOR = ProviderDriverKind.make("cursor");
const GROK = ProviderDriverKind.make("grok");
const OPENCODE = ProviderDriverKind.make("opencode");
const CODEX_DEFAULT = ProviderInstanceId.make("codex");
const CLAUDE_DEFAULT = ProviderInstanceId.make("claudeAgent");
const OPENCODE_DEFAULT = ProviderInstanceId.make("opencode");
const temporaryPaths: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "456code-source-catalog-"));
  temporaryPaths.push(path);
  return path;
}

function settingsWith(input: {
  readonly codex?: Partial<ServerSettings["providers"]["codex"]>;
  readonly claude?: Partial<ServerSettings["providers"]["claudeAgent"]>;
  readonly opencode?: Partial<ServerSettings["providers"]["opencode"]>;
  readonly providerInstances?: ServerSettings["providerInstances"];
}): ServerSettings {
  return {
    ...DEFAULT_SERVER_SETTINGS,
    providers: {
      ...DEFAULT_SERVER_SETTINGS.providers,
      codex: {
        ...DEFAULT_SERVER_SETTINGS.providers.codex,
        ...input.codex,
      },
      claudeAgent: {
        ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent,
        ...input.claude,
      },
      opencode: {
        ...DEFAULT_SERVER_SETTINGS.providers.opencode,
        ...input.opencode,
      },
    },
    providerInstances: input.providerInstances ?? DEFAULT_SERVER_SETTINGS.providerInstances,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => NodeFSP.rm(path, { recursive: true, force: true })),
  );
});

describe("resolveSourceCatalog", () => {
  it.effect("resolves legacy Codex and Claude defaults from HOME", () =>
    Effect.gen(function* () {
      const homePath = yield* Effect.promise(() => temporaryDirectory());
      const catalog = yield* resolveSourceCatalog(DEFAULT_SERVER_SETTINGS, {
        environment: {},
        homePath,
        cwd: homePath,
      });

      expect(catalog.errors).toEqual([]);
      expect(catalog.descriptors).toEqual([
        {
          source: "codex-cli",
          driverKind: CODEX,
          providerInstanceId: CODEX_DEFAULT,
          scanRoot: NodePath.join(homePath, ".codex", "sessions"),
          continuationIdentity: fileContinuationIdentity(
            CODEX,
            NodePath.join(homePath, ".codex", "sessions"),
          ),
        },
        {
          source: "codex-cli",
          driverKind: CODEX,
          providerInstanceId: CODEX_DEFAULT,
          scanRoot: NodePath.join(homePath, ".codex", "archived_sessions"),
          layout: "codex-archive",
          continuationIdentity: fileContinuationIdentity(
            CODEX,
            NodePath.join(homePath, ".codex", "sessions"),
          ),
        },
        {
          source: "claude-code",
          driverKind: CLAUDE,
          providerInstanceId: CLAUDE_DEFAULT,
          scanRoot: NodePath.join(homePath, ".claude", "projects"),
          continuationIdentity: fileContinuationIdentity(
            CLAUDE,
            NodePath.join(homePath, ".claude", "projects"),
          ),
        },
        {
          source: "opencode",
          driverKind: OPENCODE,
          providerInstanceId: OPENCODE_DEFAULT,
          scanRoot: NodePath.join(homePath, ".local", "share", "opencode", "storage", "session"),
          continuationIdentity: fileContinuationIdentity(
            OPENCODE,
            NodePath.join(homePath, ".local", "share", "opencode", "storage", "session"),
          ),
        },
      ]);
    }),
  );

  it.effect("uses a custom direct Codex home before environment fallbacks", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => temporaryDirectory());
      const configuredHome = NodePath.join(root, "configured-codex");
      const catalog = yield* resolveSourceCatalog(
        settingsWith({
          codex: { homePath: configuredHome },
        }),
        {
          environment: {
            CODEX_HOME: NodePath.join(root, "environment-codex"),
            HOME: NodePath.join(root, "home"),
          },
          cwd: root,
        },
      );

      expect(
        catalog.descriptors.find((descriptor) => descriptor.providerInstanceId === CODEX_DEFAULT),
      ).toMatchObject({
        scanRoot: NodePath.join(configuredHome, "sessions"),
      });
    }),
  );

  it.effect("loads canonical Codex thread names for only their configured source root", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => temporaryDirectory());
      const configuredHome = NodePath.join(root, "configured-codex");
      const sessionsRoot = NodePath.join(configuredHome, "sessions");
      const nativeSessionId = "019fab93-1234-7abc-8def-1234567890ab";
      const administrativeSessionId = "019fab93-5678-7abc-8def-1234567890ab";
      yield* Effect.promise(() => NodeFSP.mkdir(sessionsRoot, { recursive: true }));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(configuredHome, "session_index.jsonl"),
          [
            `{"id":"${nativeSessionId}","thread_name":"Canonical import title"}`,
            `{"id":"${administrativeSessionId}","thread_name":"<command-name>/clear</command-name>"}`,
            "",
          ].join("\n"),
        ),
      );

      const catalog = yield* resolveSourceCatalog(
        settingsWith({ codex: { homePath: configuredHome } }),
        { environment: {}, homePath: root, cwd: root },
      );
      const canonicalSessionsRoot = yield* Effect.promise(() => NodeFSP.realpath(sessionsRoot));
      const sourcePath = NodePath.join(
        canonicalSessionsRoot,
        "2026",
        "07",
        "29",
        `rollout-2026-07-29T10-00-00-${nativeSessionId}.jsonl`,
      );

      expect(codexSessionTitleForSource(catalog.descriptors, sourcePath, nativeSessionId)).toBe(
        "Canonical import title",
      );
      expect(
        codexSessionTitleForSource(catalog.descriptors, sourcePath, administrativeSessionId),
      ).toBeNull();
      expect(
        codexSessionTitleForSource(
          catalog.descriptors,
          NodePath.join(root, "different-codex", "sessions", NodePath.basename(sourcePath)),
          nativeSessionId,
        ),
      ).toBeNull();
    }),
  );

  it.effect("does not advertise disabled file-backed provider roots", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => temporaryDirectory());
      const disabledInstanceId = ProviderInstanceId.make("disabled_codex");
      const catalog = yield* resolveSourceCatalog(
        settingsWith({
          codex: { enabled: false },
          providerInstances: {
            [disabledInstanceId]: {
              driver: CODEX,
              enabled: false,
              config: { enabled: true, homePath: NodePath.join(root, "disabled") },
            },
          },
        }),
        { environment: {}, homePath: root, cwd: root },
      );

      expect(catalog.descriptors.some((descriptor) => descriptor.source === "codex-cli")).toBe(
        false,
      );
    }),
  );

  it.effect("fails closed for OpenCode instances using an external server URL", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => temporaryDirectory());
      const catalog = yield* resolveSourceCatalog(
        settingsWith({
          opencode: { serverUrl: "https://opencode.example.test" },
        }),
        { environment: {}, homePath: root, cwd: root },
      );

      expect(catalog.descriptors.some((descriptor) => descriptor.source === "opencode")).toBe(
        false,
      );
      expect(catalog.errors).toContainEqual({
        sourcePath: null,
        message:
          "OpenCode import is unavailable for provider instance 'opencode' because an external server URL does not prove ownership of local transcript storage",
      });
    }),
  );

  it.effect("honors per-instance Claude config, CLAUDE_CONFIG_DIR, and HOME precedence", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => temporaryDirectory());
      const configuredHome = NodePath.join(root, "configured-claude");
      const environmentHome = NodePath.join(root, "environment-claude");
      const fallbackHome = NodePath.join(root, "instance-home");
      const configuredId = ProviderInstanceId.make("claude_configured");
      const environmentId = ProviderInstanceId.make("claude_environment");
      const fallbackId = ProviderInstanceId.make("claude_home");
      const catalog = yield* resolveSourceCatalog(
        settingsWith({
          providerInstances: {
            [CLAUDE_DEFAULT]: {
              driver: CLAUDE,
              environment: [
                {
                  name: "CLAUDE_CONFIG_DIR",
                  value: environmentHome,
                  sensitive: false,
                },
              ],
              config: { homePath: configuredHome },
            },
            [configuredId]: {
              driver: CLAUDE,
              environment: [
                {
                  name: "CLAUDE_CONFIG_DIR",
                  value: environmentHome,
                  sensitive: false,
                },
              ],
              config: { homePath: configuredHome },
            },
            [environmentId]: {
              driver: CLAUDE,
              environment: [
                {
                  name: "CLAUDE_CONFIG_DIR",
                  value: environmentHome,
                  sensitive: false,
                },
              ],
              config: {},
            },
            [fallbackId]: {
              driver: CLAUDE,
              environment: [
                {
                  name: "HOME",
                  value: fallbackHome,
                  sensitive: false,
                },
              ],
              config: {},
            },
          },
        }),
        {
          environment: { HOME: NodePath.join(root, "base-home") },
          cwd: root,
        },
      );

      const rootsById = Object.fromEntries(
        catalog.descriptors
          .filter((descriptor) => descriptor.source === "claude-code")
          .map((descriptor) => [descriptor.providerInstanceId, descriptor.scanRoot]),
      );
      expect(rootsById).toMatchObject({
        claudeAgent: NodePath.join(configuredHome, "projects"),
        claude_configured: NodePath.join(configuredHome, "projects"),
        claude_environment: NodePath.join(environmentHome, "projects"),
        claude_home: NodePath.join(fallbackHome, ".claude", "projects"),
      });
    }),
  );

  it.effect("keeps multiple instances while an explicit default replaces its legacy mirror", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => temporaryDirectory());
      const legacyHome = NodePath.join(root, "legacy");
      const explicitHome = NodePath.join(root, "explicit");
      const workHome = NodePath.join(root, "work");
      const workId = ProviderInstanceId.make("codex_work");
      const catalog = yield* resolveSourceCatalog(
        settingsWith({
          codex: { homePath: legacyHome },
          providerInstances: {
            [CODEX_DEFAULT]: {
              driver: CODEX,
              displayName: "Personal",
              config: { homePath: explicitHome },
            },
            [workId]: {
              driver: CODEX,
              displayName: "Work",
              environment: [
                {
                  name: "CODEX_HOME",
                  value: workHome,
                  sensitive: false,
                },
              ],
              config: {},
            },
          },
        }),
        { environment: {}, homePath: root, cwd: root },
      );

      expect(
        catalog.descriptors
          .filter(
            (descriptor) =>
              descriptor.source === "codex-cli" && descriptor.layout !== "codex-archive",
          )
          .map(({ providerInstanceId, scanRoot, displayName }) => ({
            providerInstanceId,
            scanRoot,
            displayName,
          })),
      ).toEqual([
        {
          providerInstanceId: CODEX_DEFAULT,
          scanRoot: NodePath.join(explicitHome, "sessions"),
          displayName: "Personal",
        },
        {
          providerInstanceId: workId,
          scanRoot: NodePath.join(workHome, "sessions"),
          displayName: "Work",
        },
      ]);
      expect(
        catalog.descriptors.some((descriptor) => descriptor.scanRoot.includes(legacyHome)),
      ).toBe(false);
    }),
  );

  it.effect(
    "groups direct and shadow Codex instances by their shared canonical sessions root",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => temporaryDirectory());
        const sharedHome = NodePath.join(root, ".codex");
        const shadowHome = NodePath.join(root, "shadow");
        const sessionsRoot = NodePath.join(sharedHome, "sessions");
        yield* Effect.promise(() => NodeFSP.mkdir(sessionsRoot, { recursive: true }));
        const shadowId = ProviderInstanceId.make("codex_shadow");
        const catalog = yield* resolveSourceCatalog(
          settingsWith({
            providerInstances: {
              [shadowId]: {
                driver: CODEX,
                environment: [
                  {
                    name: "CODEX_HOME",
                    value: NodePath.join(root, "environment-codex"),
                    sensitive: false,
                  },
                  {
                    name: "HOME",
                    value: NodePath.join(root, "instance-home"),
                    sensitive: false,
                  },
                ],
                config: {
                  shadowHomePath: shadowHome,
                },
              },
            },
          }),
          { environment: {}, homePath: root, cwd: root },
        );
        const codexGroups = groupImportFileSourceDescriptors(catalog.descriptors).filter(
          (group) => group.source === "codex-cli" && group.layout !== "codex-archive",
        );

        expect(codexGroups).toEqual([
          {
            source: "codex-cli",
            driverKind: CODEX,
            scanRoot: yield* Effect.promise(() => NodeFSP.realpath(sessionsRoot)),
            providerInstanceIds: [shadowId, CODEX_DEFAULT],
          },
        ]);
        expect(codexGroups[0]?.scanRoot).not.toContain(shadowHome);
      }),
  );

  it.effect("reports malformed instance configs and import-root resolution errors", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => temporaryDirectory());
      const loopHome = NodePath.join(root, "loop-home");
      yield* Effect.promise(() => NodeFSP.symlink("loop-home", loopHome));
      const loopId = ProviderInstanceId.make("codex_loop");
      const catalog = yield* resolveSourceCatalog(
        settingsWith({
          providerInstances: {
            [CODEX_DEFAULT]: {
              driver: CODEX,
              config: { homePath: 42 },
            },
            [loopId]: {
              driver: CODEX,
              config: { homePath: loopHome },
            },
          },
        }),
        { environment: {}, homePath: root, cwd: root },
      );

      expect(catalog.errors).toHaveLength(2);
      expect(catalog.errors.map((error) => error.message)).toEqual([
        expect.stringContaining("invalid config for provider instance 'codex'"),
        expect.stringContaining("failed to resolve import root"),
      ]);
      expect(
        catalog.descriptors.some((descriptor) => descriptor.providerInstanceId === CODEX_DEFAULT),
      ).toBe(false);
      expect(
        catalog.descriptors.some((descriptor) => descriptor.providerInstanceId === loopId),
      ).toBe(false);
    }),
  );

  it.effect(
    "times out one canonical root independently while preserving later roots in source order",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => temporaryDirectory());
        const blockedId = ProviderInstanceId.make("codex_blocked_root");
        const laterId = ProviderInstanceId.make("codex_later_root");
        const finalId = ProviderInstanceId.make("codex_final_root");
        const blockedHome = NodePath.join(root, "blocked-home");
        const laterHome = NodePath.join(root, "later-home");
        const finalHome = NodePath.join(root, "final-home");
        const blockedRoot = NodePath.join(blockedHome, "sessions");
        const attemptedPaths: string[] = [];
        let signalBlockedResolutionStarted: () => void;
        const blockedResolutionStarted = new Promise<void>((resolve) => {
          signalBlockedResolutionStarted = resolve;
        });
        let signalLaterResolutionsStarted: () => void;
        const laterResolutionsStarted = new Promise<void>((resolve) => {
          signalLaterResolutionsStarted = resolve;
        });
        let laterResolutionCount = 0;
        const catalogFiber = yield* resolveSourceCatalog(
          settingsWith({
            codex: { enabled: false },
            claude: { enabled: false },
            opencode: { enabled: false },
            providerInstances: {
              [blockedId]: {
                driver: CODEX,
                config: { homePath: blockedHome },
              },
              [laterId]: {
                driver: CODEX,
                config: { homePath: laterHome },
              },
              [finalId]: {
                driver: CODEX,
                config: { homePath: finalHome },
              },
            },
          }),
          {
            environment: {},
            homePath: root,
            cwd: root,
            rootResolutionTimeoutMs: 50,
            resolveRealPath: (path) => {
              attemptedPaths.push(path);
              if (path === blockedRoot) {
                signalBlockedResolutionStarted();
                return new Promise<string>(() => {});
              }
              laterResolutionCount += 1;
              if (laterResolutionCount === 2) {
                signalLaterResolutionsStarted();
              }
              return Promise.resolve(path);
            },
          },
        ).pipe(Effect.forkScoped);

        yield* Effect.promise(() => blockedResolutionStarted);
        yield* Effect.promise(() => laterResolutionsStarted);
        expect(attemptedPaths).toEqual([
          blockedRoot,
          NodePath.join(laterHome, "sessions"),
          NodePath.join(finalHome, "sessions"),
          NodePath.join(laterHome, "archived_sessions"),
          NodePath.join(finalHome, "archived_sessions"),
        ]);
        yield* TestClock.adjust("50 millis");
        const catalog = yield* Fiber.join(catalogFiber);

        expect(catalog.descriptors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              providerInstanceId: laterId,
              scanRoot: NodePath.join(laterHome, "sessions"),
            }),
            expect.objectContaining({
              providerInstanceId: laterId,
              scanRoot: NodePath.join(laterHome, "archived_sessions"),
              layout: "codex-archive",
            }),
            expect.objectContaining({
              providerInstanceId: finalId,
              scanRoot: NodePath.join(finalHome, "sessions"),
            }),
            expect.objectContaining({
              providerInstanceId: finalId,
              scanRoot: NodePath.join(finalHome, "archived_sessions"),
              layout: "codex-archive",
            }),
          ]),
        );
        expect(catalog.errors).toEqual([
          {
            sourcePath: blockedRoot,
            message: "timed out resolving import root after 50ms",
          },
        ]);
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );
});

describe("resolveAcpImportSourceCatalog", () => {
  it.effect("resolves only enabled Cursor and Grok instances with exact launch settings", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => temporaryDirectory());
      const cursorId = ProviderInstanceId.make("cursor_work");
      const grokId = ProviderInstanceId.make("grok_work");
      const disabledCursorId = ProviderInstanceId.make("cursor_disabled");
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
            displayName: "Cursor Work",
            environment: [
              {
                name: "CURSOR_IMPORT_TOKEN",
                value: "cursor-secret",
                sensitive: true,
              },
            ],
            config: {
              enabled: true,
              binaryPath: "/opt/cursor-agent",
              apiEndpoint: "https://cursor.example.test",
            },
          },
          [grokId]: {
            driver: GROK,
            displayName: "Grok Work",
            environment: [
              {
                name: "XAI_API_KEY",
                value: "grok-secret",
                sensitive: true,
              },
            ],
            config: {
              enabled: true,
              binaryPath: "/opt/grok",
            },
          },
          [disabledCursorId]: {
            driver: CURSOR,
            enabled: false,
            config: {
              enabled: true,
              binaryPath: "/opt/disabled-cursor",
            },
          },
        },
      };

      const catalog = yield* resolveAcpImportSourceCatalog(settings, {
        environment: { HOME: root },
        homePath: root,
        cwd: root,
      });

      expect(catalog.errors).toEqual([]);
      expect(catalog.descriptors).toHaveLength(2);
      expect(catalog.descriptors).toEqual([
        expect.objectContaining({
          source: "cursor",
          driverKind: CURSOR,
          providerInstanceId: cursorId,
          displayName: "Cursor Work",
          connection: expect.objectContaining({
            driverKind: "cursor",
            cwd: NodePath.resolve(root),
            binaryPath: "/opt/cursor-agent",
            apiEndpoint: "https://cursor.example.test",
            environment: expect.objectContaining({
              HOME: root,
              CURSOR_IMPORT_TOKEN: "cursor-secret",
            }),
          }),
        }),
        expect.objectContaining({
          source: "grok",
          driverKind: GROK,
          providerInstanceId: grokId,
          displayName: "Grok Work",
          connection: expect.objectContaining({
            driverKind: "grok",
            cwd: NodePath.resolve(root),
            binaryPath: "/opt/grok",
            environment: expect.objectContaining({
              HOME: root,
              XAI_API_KEY: "grok-secret",
            }),
          }),
        }),
      ]);
      expect(
        catalog.descriptors.some(
          (descriptor) => descriptor.providerInstanceId === disabledCursorId,
        ),
      ).toBe(false);
    }),
  );

  it.effect("rejects cwd-sensitive ACP executable routes", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => temporaryDirectory());
      const cursorId = ProviderInstanceId.make("cursor_relative");
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
            config: {
              enabled: true,
              binaryPath: "./cursor-agent",
            },
          },
        },
      };

      const catalog = yield* resolveAcpImportSourceCatalog(settings, {
        environment: { HOME: root, PATH: "/usr/bin:/bin" },
        cwd: root,
      });

      expect(catalog.descriptors).toEqual([]);
      expect(catalog.errors).toEqual([
        {
          sourcePath: null,
          message: expect.stringContaining("relative to each thread working directory"),
        },
      ]);
    }),
  );

  it.effect("shares Windows environment canonicalization across catalog launch and identity", () =>
    Effect.gen(function* () {
      const cursorId = ProviderInstanceId.make("cursor_windows");
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
            environment: [
              {
                name: "path",
                value: ".\\node_modules\\.bin;C:\\Windows\\System32",
                sensitive: false,
              },
              {
                name: "custom_account_token",
                value: "configured-account",
                sensitive: true,
              },
            ],
            config: {
              enabled: true,
              binaryPath: "cursor-agent",
            },
          },
        },
      };

      const catalog = yield* resolveAcpImportSourceCatalog(settings, {
        environment: {
          Path: "C:\\inherited-bin",
          CUSTOM_ACCOUNT_TOKEN: "inherited-account",
        },
        cwd: "C:\\server\\workspace",
      }).pipe(Effect.provideService(HostProcessPlatform, "win32"));

      expect(catalog.errors).toEqual([]);
      expect(catalog.descriptors).toHaveLength(1);
      expect(catalog.descriptors[0]?.connection.environment).toEqual({
        CUSTOM_ACCOUNT_TOKEN: "configured-account",
        PATH: "C:\\server\\workspace\\node_modules\\.bin;C:\\Windows\\System32",
      });
      expect(catalog.descriptors[0]?.continuationIdentity.continuationKey).not.toContain(
        "configured-account",
      );
    }),
  );
});

describe("resolveImportSourcePath", () => {
  it.effect("accepts a symlinked root and returns every compatible provider instance", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => temporaryDirectory());
      const realSessions = NodePath.join(root, "real", "sessions");
      const realSessionDay = NodePath.join(realSessions, "2026", "01", "01");
      const aliasHome = NodePath.join(root, "alias-home");
      const sourcePath = NodePath.join(
        aliasHome,
        "sessions",
        "2026",
        "01",
        "01",
        "rollout-session.jsonl",
      );
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(realSessionDay, { recursive: true });
        await NodeFSP.mkdir(aliasHome, { recursive: true });
        await NodeFSP.writeFile(NodePath.join(realSessionDay, "rollout-session.jsonl"), "{}");
        await NodeFSP.symlink(realSessions, NodePath.join(aliasHome, "sessions"));
      });
      const otherId = ProviderInstanceId.make("codex_other");
      const catalog = yield* resolveSourceCatalog(
        settingsWith({
          codex: { homePath: aliasHome },
          providerInstances: {
            [otherId]: {
              driver: CODEX,
              config: { homePath: aliasHome },
            },
          },
        }),
        { environment: {}, homePath: root, cwd: root },
      );

      const resolved = yield* resolveImportSourcePath(catalog.descriptors, "codex-cli", sourcePath);
      const canonicalPath = yield* Effect.promise(() => NodeFSP.realpath(sourcePath));
      const canonicalRoot = yield* Effect.promise(() => NodeFSP.realpath(realSessions));
      const fileStat = yield* Effect.promise(() => NodeFSP.stat(canonicalPath, { bigint: true }));
      const rootStat = yield* Effect.promise(() => NodeFSP.stat(canonicalRoot, { bigint: true }));
      expect(resolved).toEqual({
        canonicalPath,
        providerInstanceIds: [otherId, CODEX_DEFAULT],
        validation: {
          canonicalPath,
          fileIdentity: {
            device: fileStat.dev,
            inode: fileStat.ino,
          },
          roots: [
            {
              canonicalPath: canonicalRoot,
              identity: {
                device: rootStat.dev,
                inode: rootStat.ino,
              },
            },
          ],
        },
      });
    }),
  );

  it.effect("rejects a source symlink that escapes its configured root", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => temporaryDirectory());
      const codexHome = NodePath.join(root, "codex");
      const sessionsRoot = NodePath.join(codexHome, "sessions");
      const outsidePath = NodePath.join(root, "outside.jsonl");
      const sourcePath = NodePath.join(sessionsRoot, "rollout-escape.jsonl");
      const directoryPath = NodePath.join(sessionsRoot, "rollout-directory.jsonl");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(sessionsRoot, { recursive: true });
        await NodeFSP.writeFile(outsidePath, "{}");
        await NodeFSP.symlink(outsidePath, sourcePath);
        await NodeFSP.mkdir(directoryPath);
      });
      const catalog = yield* resolveSourceCatalog(
        settingsWith({ codex: { homePath: codexHome } }),
        { environment: {}, homePath: root, cwd: root },
      );

      const result = yield* resolveImportSourcePath(
        catalog.descriptors,
        "codex-cli",
        sourcePath,
      ).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.message).toContain(
          "canonical file path is outside every configured import root",
        );
      }

      const directoryResult = yield* resolveImportSourcePath(
        catalog.descriptors,
        "codex-cli",
        directoryPath,
      ).pipe(Effect.result);
      expect(directoryResult._tag).toBe("Failure");
      if (directoryResult._tag === "Failure") {
        expect(directoryResult.failure.message).toContain("is not a regular file");
      }
    }),
  );

  it.effect("rejects a final-component replacement after source authorization", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => temporaryDirectory());
      const codexHome = NodePath.join(root, "codex");
      const sessionsRoot = NodePath.join(codexHome, "sessions");
      const dayRoot = NodePath.join(sessionsRoot, "2026", "01", "01");
      const sourcePath = NodePath.join(dayRoot, "rollout-session.jsonl");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(dayRoot, { recursive: true });
        await NodeFSP.writeFile(sourcePath, '{"authorized":true}');
      });
      const catalog = yield* resolveSourceCatalog(
        settingsWith({ codex: { homePath: codexHome } }),
        { environment: {}, homePath: root, cwd: root },
      );
      const trusted = yield* resolveImportSourcePath(catalog.descriptors, "codex-cli", sourcePath);

      yield* Effect.promise(async () => {
        await NodeFSP.rename(sourcePath, `${sourcePath}.authorized`);
        await NodeFSP.writeFile(sourcePath, '{"replacement":true}');
      });
      const result = yield* readResolvedImportSourceFile(trusted, makeImportByteBudget(1_024)).pipe(
        Effect.result,
      );

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.reason).toBe("file changed after its import path was authorized");
      }
    }),
  );

  it.effect("rejects an ancestor symlink swap even when it still reaches the authorized file", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => temporaryDirectory());
      const codexHome = NodePath.join(root, "codex");
      const sessionsRoot = NodePath.join(codexHome, "sessions");
      const relocatedSessionsRoot = NodePath.join(codexHome, "sessions-relocated");
      const dayRoot = NodePath.join(sessionsRoot, "2026", "01", "01");
      const sourcePath = NodePath.join(dayRoot, "rollout-session.jsonl");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(dayRoot, { recursive: true });
        await NodeFSP.writeFile(sourcePath, '{"authorized":true}');
      });
      const catalog = yield* resolveSourceCatalog(
        settingsWith({ codex: { homePath: codexHome } }),
        { environment: {}, homePath: root, cwd: root },
      );
      const trusted = yield* resolveImportSourcePath(catalog.descriptors, "codex-cli", sourcePath);

      yield* Effect.promise(async () => {
        await NodeFSP.rename(sessionsRoot, relocatedSessionsRoot);
        await NodeFSP.symlink(relocatedSessionsRoot, sessionsRoot);
      });
      const result = yield* readResolvedImportSourceFile(trusted, makeImportByteBudget(1_024)).pipe(
        Effect.result,
      );

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.reason).toBe("path changed after its import path was authorized");
      }
    }),
  );

  it.effect(
    "rejects an import root replacement even when it preserves the authorized file inode",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => temporaryDirectory());
        const codexHome = NodePath.join(root, "codex");
        const sessionsRoot = NodePath.join(codexHome, "sessions");
        const relocatedSessionsRoot = NodePath.join(codexHome, "sessions-relocated");
        const relativeSourcePath = NodePath.join("2026", "01", "01", "rollout-session.jsonl");
        const sourcePath = NodePath.join(sessionsRoot, relativeSourcePath);
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(NodePath.dirname(sourcePath), { recursive: true });
          await NodeFSP.writeFile(sourcePath, '{"authorized":true}');
        });
        const catalog = yield* resolveSourceCatalog(
          settingsWith({ codex: { homePath: codexHome } }),
          { environment: {}, homePath: root, cwd: root },
        );
        const trusted = yield* resolveImportSourcePath(
          catalog.descriptors,
          "codex-cli",
          sourcePath,
        );

        yield* Effect.promise(async () => {
          await NodeFSP.rename(sessionsRoot, relocatedSessionsRoot);
          await NodeFSP.mkdir(NodePath.dirname(sourcePath), { recursive: true });
          await NodeFSP.link(NodePath.join(relocatedSessionsRoot, relativeSourcePath), sourcePath);
        });
        const result = yield* readResolvedImportSourceFile(
          trusted,
          makeImportByteBudget(1_024),
        ).pipe(Effect.result);

        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure.reason).toBe(
            "configured import root changed after the source was authorized",
          );
        }
      }),
  );

  it.effect("rejects regular files that do not use a recognized transcript layout", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => temporaryDirectory());
      const sessionsRoot = NodePath.join(root, "codex", "sessions");
      const sourcePath = NodePath.join(sessionsRoot, "notes.jsonl");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(sessionsRoot, { recursive: true });
        await NodeFSP.writeFile(sourcePath, "{}");
      });
      const catalog = yield* resolveSourceCatalog(
        settingsWith({ codex: { homePath: NodePath.join(root, "codex") } }),
        { environment: {}, homePath: root, cwd: root },
      );

      const result = yield* resolveImportSourcePath(
        catalog.descriptors,
        "codex-cli",
        sourcePath,
      ).pipe(Effect.result);

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.reason).toBe(
          "the file does not use a recognized session transcript layout",
        );
      }
    }),
  );

  it.effect("authorizes flat Codex archives and rejects Claude child transcript layouts", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => temporaryDirectory());
      const codexHome = NodePath.join(root, "codex");
      const sessionsRoot = NodePath.join(codexHome, "sessions");
      const archiveRoot = NodePath.join(codexHome, "archived_sessions");
      const archivedSession = NodePath.join(archiveRoot, "rollout-archived.jsonl");
      const nestedArchive = NodePath.join(archiveRoot, "nested", "rollout-impostor.jsonl");
      const claudeHome = NodePath.join(root, "claude");
      const projectRoot = NodePath.join(claudeHome, "projects", "project");
      const parentSessionId = "123e4567-e89b-42d3-a456-426614174000";
      const subagentsRoot = NodePath.join(projectRoot, parentSessionId, "subagents");
      const directAgent = NodePath.join(subagentsRoot, "agent-direct_1.jsonl");
      const workflowAgent = NodePath.join(
        subagentsRoot,
        "workflows",
        "wf_123-test",
        "agent-workflow_1.jsonl",
      );
      const rejectedPaths = [
        nestedArchive,
        directAgent,
        workflowAgent,
        NodePath.join(subagentsRoot, "journal.jsonl"),
        NodePath.join(subagentsRoot, "nested", "agent-extra.jsonl"),
        NodePath.join(subagentsRoot, "workflows", "wf_123-test", "journal.jsonl"),
        NodePath.join(subagentsRoot, "workflows", "wf_123-test", "nested", "agent-extra.jsonl"),
        NodePath.join(projectRoot, "not-a-session-id", "subagents", "agent-impostor.jsonl"),
      ];
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(sessionsRoot, { recursive: true });
        for (const path of [archivedSession, ...rejectedPaths]) {
          await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
          await NodeFSP.writeFile(path, "{}");
        }
      });
      const catalog = yield* resolveSourceCatalog(
        settingsWith({
          codex: { homePath: codexHome },
          claude: { homePath: claudeHome },
        }),
        { environment: {}, homePath: root, cwd: root },
      );

      const activeCodex = catalog.descriptors.find(
        (descriptor) => descriptor.source === "codex-cli" && descriptor.layout !== "codex-archive",
      );
      const archivedCodex = catalog.descriptors.find(
        (descriptor) => descriptor.layout === "codex-archive",
      );
      expect(archivedCodex).toMatchObject({
        scanRoot: yield* Effect.promise(() => NodeFSP.realpath(archiveRoot)),
        continuationIdentity: activeCodex?.continuationIdentity,
      });

      const resolvedArchive = yield* resolveImportSourcePath(
        catalog.descriptors,
        "codex-cli",
        archivedSession,
      );
      expect(resolvedArchive.providerInstanceIds).toEqual([CODEX_DEFAULT]);

      for (const path of rejectedPaths) {
        const source = path.startsWith(archiveRoot) ? "codex-cli" : "claude-code";
        const result = yield* resolveImportSourcePath(catalog.descriptors, source, path).pipe(
          Effect.result,
        );
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure.reason).toBe(
            "the file does not use a recognized session transcript layout",
          );
        }
      }
    }),
  );
});
