// apps/server/src/provider/continuationIdentity.ts
// derives non-secret identities for provider-owned continuation sources
// @effect-diagnostics nodeBuiltinImport:off

import * as NodeBuffer from "node:buffer";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type {
  ClaudeSettings,
  CodexSettings,
  OpenCodeSettings,
  ProviderContinuationIdentity,
  ProviderDriverKind,
  ProviderInstanceEnvironment,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  HOST_PATH_PLATFORM,
  normalizeProviderProcessEnvironment,
} from "./ProviderInstanceEnvironment.ts";

interface RootResolutionOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly homePath?: string;
  readonly cwd?: string;
}

interface AcpContinuationRoute {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}

const CURSOR_SOURCE_ENVIRONMENT_NAMES = [
  "AGENT_CLI_CREDENTIAL_STORE",
  "CURSOR_API_ENDPOINT",
  "CURSOR_API_KEY",
  "CURSOR_AUTH_TOKEN",
  "CURSOR_CONFIG_DIR",
  "CURSOR_DATA_DIR",
  "HOME",
  "PATH",
  "PATHEXT",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
] as const;

const GROK_SOURCE_ENVIRONMENT_NAMES = [
  "GROK_AUTH_PROVIDER_COMMAND",
  "GROK_CLI_CHAT_PROXY_BASE_URL",
  "GROK_HOME",
  "GROK_MODELS_BASE_URL",
  "GROK_OAUTH2_REFERRER",
  "GROK_OIDC_CLIENT_ID",
  "GROK_OIDC_ISSUER",
  "GROK_XAI_API_BASE_URL",
  "HOME",
  "PATH",
  "PATHEXT",
  "XAI_API_KEY",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
] as const;

const ACP_PATH_SOURCE_ENVIRONMENT_NAMES = new Set([
  "CURSOR_CONFIG_DIR",
  "CURSOR_DATA_DIR",
  "GROK_HOME",
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
]);

const ACP_EXECUTABLE_SOURCE_ENVIRONMENT_NAMES = new Set(["GROK_AUTH_PROVIDER_COMMAND"]);

function nonEmptyEnvironmentValue(environment: NodeJS.ProcessEnv, name: string): string | null {
  const value = environment[name]?.trim() ?? "";
  return value.length > 0 ? value : null;
}

function resolveHomePath(options: RootResolutionOptions): string {
  const cwd = NodePath.resolve(options.cwd ?? process.cwd());
  const environment = options.environment ?? process.env;
  const configuredHome = nonEmptyEnvironmentValue(environment, "HOME");
  return NodePath.resolve(cwd, configuredHome || options.homePath?.trim() || NodeOS.homedir());
}

function resolveHostHomePath(options: RootResolutionOptions): string {
  const cwd = NodePath.resolve(options.cwd ?? process.cwd());
  return NodePath.resolve(cwd, options.homePath?.trim() || NodeOS.homedir());
}

function expandHome(value: string, homePath: string): string {
  if (value === "~") return homePath;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return NodePath.join(homePath, value.slice(2));
  }
  return value;
}

function resolveConfiguredPath(value: string, options: RootResolutionOptions): string {
  const cwd = NodePath.resolve(options.cwd ?? process.cwd());
  const homePath = resolveHostHomePath(options);
  return NodePath.resolve(cwd, expandHome(value, homePath));
}

export function resolveCodexSharedHomePath(
  config: Pick<CodexSettings, "homePath" | "shadowHomePath">,
  options: RootResolutionOptions = {},
): string {
  const configuredHome = config.homePath.trim();
  if (configuredHome.length > 0) {
    return resolveConfiguredPath(configuredHome, options);
  }
  const homePath = resolveHostHomePath(options);
  if (config.shadowHomePath.trim().length > 0) {
    return NodePath.join(homePath, ".codex");
  }
  const environment = options.environment ?? process.env;
  const environmentHome = nonEmptyEnvironmentValue(environment, "CODEX_HOME");
  return environmentHome === null
    ? NodePath.join(homePath, ".codex")
    : NodePath.resolve(options.cwd ?? process.cwd(), environmentHome);
}

export function resolveCodexSessionsRoot(
  config: Pick<CodexSettings, "homePath" | "shadowHomePath">,
  options: RootResolutionOptions = {},
): string {
  return NodePath.join(resolveCodexSharedHomePath(config, options), "sessions");
}

export function resolveClaudeConfigRoot(
  config: Pick<ClaudeSettings, "homePath">,
  options: RootResolutionOptions = {},
): string {
  const configuredHome = config.homePath.trim();
  if (configuredHome.length > 0) {
    return resolveConfiguredPath(configuredHome, options);
  }
  const environment = options.environment ?? process.env;
  const environmentHome = nonEmptyEnvironmentValue(environment, "CLAUDE_CONFIG_DIR");
  return environmentHome === null
    ? NodePath.join(resolveHomePath(options), ".claude")
    : NodePath.resolve(options.cwd ?? process.cwd(), environmentHome);
}

export function resolveClaudeProjectsRoot(
  config: Pick<ClaudeSettings, "homePath">,
  options: RootResolutionOptions = {},
): string {
  return NodePath.join(resolveClaudeConfigRoot(config, options), "projects");
}

export function resolveOpenCodeStorageRoot(options: RootResolutionOptions = {}): string {
  const environment = options.environment ?? process.env;
  const cwd = NodePath.resolve(options.cwd ?? process.cwd());
  const xdgDataHome = nonEmptyEnvironmentValue(environment, "XDG_DATA_HOME");
  const configuredHome = nonEmptyEnvironmentValue(environment, "HOME");
  const fallbackHome = options.homePath?.trim();
  const dataHome =
    xdgDataHome !== null
      ? NodePath.resolve(cwd, xdgDataHome)
      : NodePath.join(
          configuredHome !== null
            ? NodePath.resolve(cwd, configuredHome)
            : fallbackHome
              ? NodePath.resolve(cwd, fallbackHome)
              : NodeOS.homedir(),
          ".local",
          "share",
        );
  return NodePath.join(dataHome, "opencode", "storage");
}

export function resolveOpenCodeSessionsRoot(options: RootResolutionOptions = {}): string {
  return NodePath.join(resolveOpenCodeStorageRoot(options), "session");
}

export function normalizeOpenCodeRuntimeEnvironment(
  environment: NodeJS.ProcessEnv,
  options: Pick<RootResolutionOptions, "cwd" | "homePath"> = {},
): NodeJS.ProcessEnv {
  const storageRoot = resolveOpenCodeStorageRoot({
    environment,
    ...options,
  });
  return {
    ...environment,
    XDG_DATA_HOME: NodePath.dirname(NodePath.dirname(storageRoot)),
  };
}

export function normalizeAcpRuntimeEnvironment(
  environment: NodeJS.ProcessEnv,
  cwd: string,
  platform: NodeJS.Platform = HOST_PATH_PLATFORM,
): NodeJS.ProcessEnv {
  const normalizedEnvironment = normalizeProviderProcessEnvironment(environment, platform);
  const pathValue = normalizedEnvironment.PATH;
  if (pathValue === undefined) {
    return normalizedEnvironment;
  }
  const pathApi = platform === "win32" ? NodePath.win32 : NodePath.posix;
  const absoluteCwd = pathApi.resolve(cwd);
  return {
    ...normalizedEnvironment,
    PATH: pathValue
      .split(pathApi.delimiter)
      .map((entry) => pathApi.resolve(absoluteCwd, entry))
      .join(pathApi.delimiter),
  };
}

function updateLengthPrefixed(hash: NodeCrypto.Hash, value: string): void {
  const bytes = NodeBuffer.Buffer.from(value, "utf8");
  hash.update(String(bytes.byteLength));
  hash.update(":");
  hash.update(bytes);
}

function continuationIdentityFromFields(
  driverKind: ProviderDriverKind,
  sourceKind: "acp" | "file" | "server",
  fields: ReadonlyArray<string>,
): ProviderContinuationIdentity {
  const hash = NodeCrypto.createHash("sha256");
  for (const field of [driverKind, sourceKind, ...fields]) {
    updateLengthPrefixed(hash, field);
  }
  return {
    driverKind,
    continuationKey: `${driverKind}:${sourceKind}:v1:${hash.digest("hex")}`,
  };
}

export function fileContinuationIdentity(
  driverKind: ProviderDriverKind,
  canonicalRoot: string,
): ProviderContinuationIdentity {
  return continuationIdentityFromFields(driverKind, "file", [NodePath.resolve(canonicalRoot)]);
}

export const canonicalFileContinuationIdentity = Effect.fn("canonicalFileContinuationIdentity")(
  function* (
    driverKind: ProviderDriverKind,
    root: string,
  ): Effect.fn.Return<ProviderContinuationIdentity, never, FileSystem.FileSystem> {
    const fileSystem = yield* FileSystem.FileSystem;
    const normalizedRoot = NodePath.resolve(root);
    const canonicalRoot = yield* fileSystem
      .realPath(normalizedRoot)
      .pipe(Effect.orElseSucceed(() => normalizedRoot));
    return fileContinuationIdentity(driverKind, canonicalRoot);
  },
);

function canonicalExternalServerUrl(serverUrl: string): string {
  const trimmed = serverUrl.trim();
  try {
    const url = new URL(trimmed);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

export function openCodeContinuationIdentity(
  driverKind: ProviderDriverKind,
  config: Pick<OpenCodeSettings, "serverUrl">,
  canonicalLocalSessionsRoot: string,
): ProviderContinuationIdentity {
  const serverUrl = config.serverUrl.trim();
  return serverUrl.length === 0
    ? fileContinuationIdentity(driverKind, canonicalLocalSessionsRoot)
    : continuationIdentityFromFields(driverKind, "server", [canonicalExternalServerUrl(serverUrl)]);
}

export const resolveOpenCodeContinuationIdentity = Effect.fn("resolveOpenCodeContinuationIdentity")(
  function* (
    driverKind: ProviderDriverKind,
    config: Pick<OpenCodeSettings, "serverUrl">,
    options: RootResolutionOptions = {},
  ): Effect.fn.Return<ProviderContinuationIdentity, never, FileSystem.FileSystem> {
    if (config.serverUrl.trim().length > 0) {
      return openCodeContinuationIdentity(driverKind, config, "");
    }
    return yield* canonicalFileContinuationIdentity(
      driverKind,
      resolveOpenCodeSessionsRoot(options),
    );
  },
);

export function acpContinuationIdentity(
  driverKind: ProviderDriverKind,
  route: AcpContinuationRoute,
): ProviderContinuationIdentity {
  const environmentEntries = Object.entries(route.env ?? {})
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return continuationIdentityFromFields(driverKind, "acp", [
    "command",
    route.command,
    "args",
    String(route.args.length),
    ...route.args,
    "env",
    String(environmentEntries.length),
    ...environmentEntries.flatMap(([name, value]) => [name, value]),
  ]);
}

function isPathLikeCommand(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

function isSimpleExecutableToken(command: string): boolean {
  return /^[A-Za-z0-9_./\\:@%+=,-]+$/.test(command);
}

export function acpContinuationRouteIssue(
  route: AcpContinuationRoute,
  platform: NodeJS.Platform = HOST_PATH_PLATFORM,
): string | null {
  const pathApi = platform === "win32" ? NodePath.win32 : NodePath.posix;
  const command = route.command.trim();
  if (command.length === 0) {
    return "the ACP executable command is empty";
  }
  if (isPathLikeCommand(command) && !pathApi.isAbsolute(command)) {
    return `the ACP executable '${command}' is relative to each thread working directory`;
  }

  const environment = normalizeProviderProcessEnvironment(route.env ?? {}, platform);
  for (const [name, rawValue] of Object.entries(environment)) {
    const value = rawValue?.trim() ?? "";
    if (
      ACP_PATH_SOURCE_ENVIRONMENT_NAMES.has(name) &&
      value.length > 0 &&
      !pathApi.isAbsolute(value)
    ) {
      return `the ACP source selector '${name}' is relative to each thread working directory`;
    }
    if (
      ACP_EXECUTABLE_SOURCE_ENVIRONMENT_NAMES.has(name) &&
      value.length > 0 &&
      !isSimpleExecutableToken(value)
    ) {
      return `the ACP executable selector '${name}' contains shell syntax or arguments`;
    }
    if (
      ACP_EXECUTABLE_SOURCE_ENVIRONMENT_NAMES.has(name) &&
      value.length > 0 &&
      isPathLikeCommand(value) &&
      !pathApi.isAbsolute(value)
    ) {
      return `the ACP executable selector '${name}' is relative to each thread working directory`;
    }
  }

  const usesBareExecutable =
    !isPathLikeCommand(command) ||
    Object.entries(environment).some(
      ([name, rawValue]) =>
        ACP_EXECUTABLE_SOURCE_ENVIRONMENT_NAMES.has(name) &&
        (rawValue?.trim().length ?? 0) > 0 &&
        !isPathLikeCommand(rawValue?.trim() ?? ""),
    );
  if (usesBareExecutable) {
    const pathValue = environment.PATH;
    if (pathValue === undefined || pathValue.trim().length === 0) {
      return `the bare ACP executable '${command}' has no explicit PATH source boundary`;
    }
    const relativeEntry = pathValue
      .split(pathApi.delimiter)
      .find((entry) => entry.length === 0 || !pathApi.isAbsolute(entry));
    if (relativeEntry !== undefined) {
      return `the bare ACP executable '${command}' uses a cwd-sensitive PATH entry`;
    }
  }

  return null;
}

async function canonicalizeExistingPath(path: string, platform: NodeJS.Platform): Promise<string> {
  const pathApi = platform === "win32" ? NodePath.win32 : NodePath.posix;
  const normalized = pathApi.resolve(path);
  try {
    return await NodeFSP.realpath(normalized);
  } catch {
    return normalized;
  }
}

async function canonicalizeAcpCommand(
  command: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<string> {
  const pathApi = platform === "win32" ? NodePath.win32 : NodePath.posix;
  if (isPathLikeCommand(command)) {
    return canonicalizeExistingPath(command, platform);
  }

  const pathEntries = (environment.PATH ?? "").split(pathApi.delimiter);
  const executableExtensions =
    platform === "win32" && pathApi.extname(command).length === 0
      ? (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .filter((extension) => extension.length > 0)
      : [""];
  for (const pathEntry of pathEntries) {
    if (!pathApi.isAbsolute(pathEntry)) {
      continue;
    }
    for (const extension of executableExtensions) {
      const candidate = pathApi.join(pathEntry, `${command}${extension}`);
      try {
        await NodeFSP.access(candidate, NodeFS.constants.X_OK);
        return await canonicalizeExistingPath(candidate, platform);
      } catch {
        // keep searching in executable resolution order
      }
    }
  }
  return command;
}

async function canonicalizeAcpEnvironment(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<NodeJS.ProcessEnv> {
  const pathApi = platform === "win32" ? NodePath.win32 : NodePath.posix;
  const normalizedEnvironment = normalizeProviderProcessEnvironment(environment, platform);
  const canonicalEnvironment: NodeJS.ProcessEnv = {};
  for (const [name, rawValue] of Object.entries(normalizedEnvironment)) {
    if (rawValue === undefined) {
      continue;
    }
    if (name === "PATH") {
      canonicalEnvironment[name] = (
        await Promise.all(
          rawValue
            .split(pathApi.delimiter)
            .map((entry) =>
              pathApi.isAbsolute(entry)
                ? canonicalizeExistingPath(entry, platform)
                : Promise.resolve(entry),
            ),
        )
      ).join(pathApi.delimiter);
      continue;
    }
    if (ACP_EXECUTABLE_SOURCE_ENVIRONMENT_NAMES.has(name) && rawValue.trim().length > 0) {
      canonicalEnvironment[name] = await canonicalizeAcpCommand(
        rawValue.trim(),
        normalizedEnvironment,
        platform,
      );
      continue;
    }
    canonicalEnvironment[name] =
      ACP_PATH_SOURCE_ENVIRONMENT_NAMES.has(name) && pathApi.isAbsolute(rawValue)
        ? await canonicalizeExistingPath(rawValue, platform)
        : rawValue;
  }
  return canonicalEnvironment;
}

export const resolveAcpContinuationIdentity = Effect.fn("resolveAcpContinuationIdentity")(
  function* (
    driverKind: ProviderDriverKind,
    route: AcpContinuationRoute,
  ): Effect.fn.Return<ProviderContinuationIdentity> {
    const environment = route.env ?? {};
    const platform = yield* HostProcessPlatform;
    const [command, canonicalEnvironment] = yield* Effect.promise(() =>
      Promise.all([
        canonicalizeAcpCommand(route.command, environment, platform),
        canonicalizeAcpEnvironment(environment, platform),
      ]),
    );
    return acpContinuationIdentity(driverKind, {
      command,
      args: route.args,
      env: canonicalEnvironment,
    });
  },
);

export function acpContinuationEnvironment(
  driverKind: ProviderDriverKind,
  mergedEnvironment: NodeJS.ProcessEnv,
  instanceEnvironment: ProviderInstanceEnvironment | undefined,
): NodeJS.ProcessEnv {
  const sourceNames =
    driverKind === "cursor"
      ? CURSOR_SOURCE_ENVIRONMENT_NAMES
      : driverKind === "grok"
        ? GROK_SOURCE_ENVIRONMENT_NAMES
        : [];
  const environment: NodeJS.ProcessEnv = {};
  for (const variable of instanceEnvironment ?? []) {
    environment[variable.name] = variable.value;
  }
  for (const name of sourceNames) {
    const value = mergedEnvironment[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  return environment;
}
