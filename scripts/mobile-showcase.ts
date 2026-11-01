#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - Host-side simulator automation uses Node subprocess and timing APIs directly.

import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

import { PNG } from "pngjs";

import showcaseConfig, {
  type ShowcaseAppearance,
  type ShowcaseConfig,
  type ShowcaseDevice,
  type ShowcaseIosDevice,
  type ShowcaseStoreAssetSpec,
  SHOWCASE_SCENES,
  type ShowcaseScene,
  SHOWCASE_THEMES,
  type ShowcaseTheme,
} from "./mobile-showcase.config.ts";
import {
  SHOWCASE_ENVIRONMENTS,
  SHOWCASE_PROJECTS,
  seedShowcaseEnvironment,
} from "./mobile-showcase-environment.ts";

const REPO_ROOT = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const MOBILE_ROOT = NodePath.join(REPO_ROOT, "apps/mobile");
const APP_ID = "com.t3tools.t3code";
// Manifest flags update expo-dev-launcher preferences before loading, hiding dev chrome in captures.
const DEV_CLIENT_LAUNCH_FLAGS = "disableOnboarding=1&disableFab=1&disableAutoLaunch=1";
const IOS_READY_FILENAME = "T3ShowcaseReadyScene";
const SERVER_HOST = "0.0.0.0";
const IOS_SIMULATOR_ARCH = NodeProcess.arch === "arm64" ? "arm64" : "x86_64";
const IOS_APP_PATH = NodePath.join(
  MOBILE_ROOT,
  ".showcase/ios-derived-data/Build/Products/Debug-iphonesimulator/T3Code.app",
);
const MOBILE_BUILD_ENV = {
  ...NodeProcess.env,
  APP_VARIANT: "production",
  EXPO_NO_GIT_STATUS: "1",
  // iPad self-rotation needs the capture build's fullscreen mode (app.config.ts).
  T3_SHOWCASE_CAPTURE_BUILD: "1",
  NODE_ENV: "development",
};

interface CliOptions {
  readonly platforms: ReadonlySet<ShowcaseDevice["platform"]>;
  readonly deviceIds: ReadonlySet<string>;
  readonly scenes: ReadonlySet<ShowcaseScene>;
  readonly appearances: ReadonlySet<ShowcaseAppearance>;
  readonly themes: ReadonlySet<ShowcaseTheme>;
  readonly skipBuild: boolean;
  readonly skipMetro: boolean;
  readonly keepRunning: boolean;
  readonly validateOnly: boolean;
  readonly list: boolean;
}

export interface ShowcaseCapture {
  readonly device: ShowcaseDevice;
  readonly scenes: ReadonlyArray<ShowcaseScene>;
  readonly appearance: ShowcaseAppearance;
  readonly theme: ShowcaseTheme;
}

interface IosCaptureCleanup {
  readonly udid: string;
  readonly startedByRunner: boolean;
  readonly createdByRunner: boolean;
}

interface NetworkAddress {
  readonly address: string;
  readonly family: string;
  readonly internal: boolean;
}

export function selectLanIpv4Address(addresses: ReadonlyArray<NetworkAddress>): string | null {
  return (
    addresses.find(
      ({ address, family, internal }) =>
        family === "IPv4" && !internal && !address.startsWith("169.254."),
    )?.address ?? null
  );
}

function lanIpv4Address(): string {
  const address = selectLanIpv4Address(
    Object.values(NodeOS.networkInterfaces()).flatMap((addresses) => addresses ?? []),
  );
  if (!address) {
    throw new Error("No LAN IPv4 address is available for the iOS Simulator to reach Metro.");
  }
  return address;
}

export interface PngMetadata {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly colorType: number;
  readonly hasAlpha: boolean;
}

export function readPngMetadata(bytes: Uint8Array): PngMetadata {
  const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.byteLength < 26 || !pngSignature.every((value, index) => bytes[index] === value)) {
    throw new Error("Captured file is not a valid PNG.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const colorType = view.getUint8(25);
  return {
    width: view.getUint32(16),
    height: view.getUint32(20),
    bitDepth: view.getUint8(24),
    colorType,
    hasAlpha: colorType === 4 || colorType === 6,
  };
}

export function readPngDimensions(bytes: Uint8Array): {
  readonly width: number;
  readonly height: number;
} {
  const { width, height } = readPngMetadata(bytes);
  return { width, height };
}

export function normalizeStorePng(bytes: Uint8Array): Buffer {
  const png = PNG.sync.read(Buffer.from(bytes));
  return PNG.sync.write(png, {
    bitDepth: 8,
    colorType: 2,
    inputColorType: 6,
    inputHasAlpha: true,
  });
}

export function validateStoreAsset(
  spec: ShowcaseStoreAssetSpec,
  bytes: Uint8Array,
  label = "Screenshot",
): PngMetadata {
  const metadata = readPngMetadata(bytes);
  if (metadata.width !== spec.width || metadata.height !== spec.height) {
    throw new Error(
      `${label} is ${metadata.width}×${metadata.height}; ${spec.store} requires ${spec.width}×${spec.height}.`,
    );
  }
  if (metadata.bitDepth !== 8 || metadata.colorType !== 2 || metadata.hasAlpha) {
    throw new Error(
      `${label} must be an 8-bit, 24-bit RGB PNG without alpha (found bit depth ${metadata.bitDepth}, color type ${metadata.colorType}).`,
    );
  }
  return metadata;
}

export function validateStoreAssetCount(
  spec: ShowcaseStoreAssetSpec,
  count: number,
  requireMinimum: boolean,
): void {
  if (count > spec.maximumUploadCount) {
    throw new Error(
      `${spec.directory} contains ${count} screenshots; ${spec.store} allows at most ${spec.maximumUploadCount}.`,
    );
  }
  if (requireMinimum && count < spec.minimumUploadCount) {
    throw new Error(
      `${spec.directory} contains ${count} screenshots; ${spec.store} requires at least ${spec.minimumUploadCount}.`,
    );
  }
}

export function showcaseCaptureDirectory(
  outputDirectory: string,
  capture: Pick<ShowcaseCapture, "device" | "appearance" | "theme">,
): string {
  return NodePath.join(
    outputDirectory,
    capture.device.storeAsset.directory,
    capture.appearance,
    capture.theme,
  );
}

async function finalizeCapture(destination: string, device: ShowcaseDevice): Promise<void> {
  const normalized = normalizeStorePng(await NodeFSP.readFile(destination));
  await NodeFSP.writeFile(destination, normalized);
  const metadata = validateStoreAsset(
    device.storeAsset,
    normalized,
    NodePath.basename(destination),
  );
  NodeProcess.stdout.write(
    `Captured ${NodePath.relative(REPO_ROOT, destination)} (${metadata.width}×${metadata.height}, 24-bit RGB, validated for ${device.storeAsset.store})\n`,
  );
}

async function validateCaptureSet(
  capture: ShowcaseCapture,
  outputDirectory: string,
  requireMinimum: boolean,
): Promise<void> {
  const directory = showcaseCaptureDirectory(outputDirectory, capture);
  const files = (await NodeFSP.readdir(directory)).filter((file) => file.endsWith(".png")).sort();
  const expectedFiles = capture.scenes.map((scene) => `${scene}.png`).sort();
  const missingFiles = expectedFiles.filter((file) => !files.includes(file));
  if (missingFiles.length > 0) {
    throw new Error(`${capture.device.id} is missing ${missingFiles.join(", ")} in ${directory}.`);
  }
  validateStoreAssetCount(capture.device.storeAsset, files.length, requireMinimum);
  for (const file of files) {
    const bytes = await NodeFSP.readFile(NodePath.join(directory, file));
    validateStoreAsset(capture.device.storeAsset, bytes, `${capture.device.id}/${file}`);
  }
  NodeProcess.stdout.write(
    `Validated ${files.length} upload-ready ${capture.device.storeAsset.store} screenshots in ${NodePath.relative(REPO_ROOT, directory)}/\n`,
  );
}

function argumentValue(args: ReadonlyArray<string>, index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

export function parseShowcaseCliArgs(args: ReadonlyArray<string>): CliOptions {
  const platforms = new Set<ShowcaseDevice["platform"]>();
  const deviceIds = new Set<string>();
  const scenes = new Set<ShowcaseScene>();
  const appearances = new Set<ShowcaseAppearance>();
  const themes = new Set<ShowcaseTheme>();
  let skipBuild = false;
  let skipMetro = false;
  let keepRunning = false;
  let validateOnly = false;
  let list = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--platform") {
      const value = argumentValue(args, index, argument);
      if (value !== "ios" && value !== "all") {
        throw new Error(`Unsupported platform '${value}'. Use ios or all.`);
      }
      platforms.add("ios");
      index += 1;
    } else if (argument === "--device") {
      deviceIds.add(argumentValue(args, index, argument));
      index += 1;
    } else if (argument === "--scene") {
      const value = argumentValue(args, index, argument);
      if (!SHOWCASE_SCENES.includes(value as ShowcaseScene)) {
        throw new Error(`Unsupported scene '${value}'. Use ${SHOWCASE_SCENES.join(", ")}.`);
      }
      scenes.add(value as ShowcaseScene);
      index += 1;
    } else if (argument === "--appearance") {
      const value = argumentValue(args, index, argument);
      if (value !== "light" && value !== "dark" && value !== "both") {
        throw new Error(`Unsupported appearance '${value}'. Use light, dark, or both.`);
      }
      if (value === "both") {
        appearances.add("light");
        appearances.add("dark");
      } else {
        appearances.add(value);
      }
      index += 1;
    } else if (argument === "--theme") {
      const value = argumentValue(args, index, argument);
      if (value === "all") {
        for (const theme of SHOWCASE_THEMES) themes.add(theme);
      } else if (SHOWCASE_THEMES.some((theme) => theme === value)) {
        themes.add(value as ShowcaseTheme);
      } else {
        // Unknown themes silently use the default palette; reject mislabeled captures.
        throw new Error(`Unsupported theme '${value}'. Use ${SHOWCASE_THEMES.join(", ")}, or all.`);
      }
      index += 1;
    } else if (argument === "--skip-build") {
      skipBuild = true;
    } else if (argument === "--skip-metro") {
      skipMetro = true;
    } else if (argument === "--keep-running") {
      keepRunning = true;
    } else if (argument === "--validate-only") {
      validateOnly = true;
    } else if (argument === "--list") {
      list = true;
    } else if (argument === "--help" || argument === "-h") {
      list = true;
    } else {
      throw new Error(`Unknown option '${argument}'.`);
    }
  }

  return {
    platforms,
    deviceIds,
    scenes,
    appearances,
    themes,
    skipBuild,
    skipMetro,
    keepRunning,
    validateOnly,
    list,
  };
}

export function planShowcaseCaptures(
  config: ShowcaseConfig,
  options: Pick<CliOptions, "platforms" | "deviceIds" | "scenes" | "appearances" | "themes">,
): ReadonlyArray<ShowcaseCapture> {
  const captures = config.devices
    .filter((device) => options.platforms.size === 0 || options.platforms.has(device.platform))
    .filter((device) => options.deviceIds.size === 0 || options.deviceIds.has(device.id))
    .flatMap((device) => {
      const appearances =
        options.appearances.size === 0 ? [device.appearance] : options.appearances;
      const themes = options.themes.size === 0 ? [device.theme] : options.themes;
      return [...appearances].flatMap((appearance) =>
        [...themes].map((theme) => ({
          device,
          appearance,
          theme,
          scenes:
            options.scenes.size === 0
              ? device.scenes
              : device.scenes.filter((scene) => options.scenes.has(scene)),
        })),
      );
    })
    .filter((capture) => capture.scenes.length > 0);

  const knownDeviceIds = new Set(config.devices.map((device) => device.id));
  for (const id of options.deviceIds) {
    if (!knownDeviceIds.has(id)) {
      throw new Error(`Unknown device '${id}'. Run with --list to see configured devices.`);
    }
  }
  if (captures.length === 0) {
    throw new Error("No captures match the selected platform, device, and scene filters.");
  }
  return captures;
}

function printUsage(config: ShowcaseConfig): void {
  NodeProcess.stdout.write(`App screenshot showcase

Usage:
  pnpm --filter @t3tools/mobile screenshots [options]

Options:
  --platform ios|all         Capture one platform (repeatable)
  --device <id>              Capture one configured device (repeatable)
  --scene <name>             Capture one scene (repeatable)
  --appearance light|dark|both
                             Override the configured appearance
  --theme <id>|all           Override the configured palette (repeatable)
  --skip-build               Reuse the existing simulator app
  --skip-metro               Reuse an already running showcase Metro server
  --keep-running             Leave devices and Metro running after capture
  --validate-only            Validate existing upload assets without capturing
  --list                     Print this help and the configured matrix

Scenes: ${SHOWCASE_SCENES.join(", ")}
Themes: ${SHOWCASE_THEMES.join(", ")}

Configured devices:
${config.devices
  .map((device) => {
    return `  ${device.id.padEnd(18)} ${device.platform.padEnd(8)} ${device.simulator} -> ${device.storeAsset.directory}/{light|dark}/<theme> (${device.storeAsset.width}×${device.storeAsset.height}, default ${device.appearance} ${device.theme}) [${device.scenes.join(", ")}]`;
  })
  .join("\n")}
`);
}

function spawnProcess(
  command: string,
  args: ReadonlyArray<string>,
  options: NodeChildProcess.SpawnOptions = {},
): NodeChildProcess.ChildProcess {
  return NodeChildProcess.spawn(command, args, {
    cwd: REPO_ROOT,
    env: NodeProcess.env,
    stdio: "inherit",
    ...options,
  });
}

async function runCommand(
  command: string,
  args: ReadonlyArray<string>,
  options: NodeChildProcess.SpawnOptions = {},
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawnProcess(command, args, options);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `${command} ${args.join(" ")} failed ${signal ? `with signal ${signal}` : `with code ${String(code)}`}.`,
          ),
        );
      }
    });
  });
}

async function commandOutput(
  command: string,
  args: ReadonlyArray<string>,
  options: NodeChildProcess.ExecFileOptions = {},
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    NodeChildProcess.execFile(
      command,
      [...args],
      { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, ...options },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(String(stdout));
      },
    );
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function stopProcess(child: NodeChildProcess.ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  child.kill("SIGTERM");
  await Promise.race([exited, delay(5_000)]);
  if (child.exitCode !== null || child.signalCode !== null) return;

  child.kill("SIGKILL");
  await Promise.race([exited, delay(1_000)]);
}

export async function waitForPort(
  port: number,
  label = "Process",
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = NodeNet.createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
      socket.setTimeout(500, () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (open) return;
    await delay(500);
  }
  throw new Error(`${label} did not begin listening on port ${port} within ${timeoutMs}ms.`);
}

async function waitForFileContent(
  filePath: string,
  label: string,
  timeoutMs = 60_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const content = await NodeFSP.readFile(filePath, "utf8").then(
      (value) => value.trim(),
      () => "",
    );
    if (content) return content;
    await delay(250);
  }
  throw new Error(`${label} was not written to ${filePath} within ${timeoutMs}ms.`);
}

export async function reserveAvailablePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a local port for the showcase environment."));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function createShowcaseShell(baseDir: string): Promise<string> {
  const shellPath = NodePath.join(baseDir, "showcase-shell");
  await NodeFSP.writeFile(
    shellPath,
    `#!/bin/sh
if [ "$1" = "-ilc" ] || [ "$1" = "-lic" ]; then
  exec /bin/sh -c "$2"
fi
exec /bin/cat
`,
    { mode: 0o755 },
  );
  return shellPath;
}

async function createShowcaseLabelProbe(baseDir: string, label: string): Promise<string> {
  const binDirectory = NodePath.join(baseDir, "showcase-bin");
  await NodeFSP.mkdir(binDirectory, { recursive: true });
  const probeScript = `#!/bin/sh
if [ "$1" = "--get" ] && [ "$2" = "ComputerName" ]; then
  printf '%s\\n' ${JSON.stringify(label)}
  exit 0
fi
if [ "$1" = "--pretty" ]; then
  printf '%s\\n' ${JSON.stringify(label)}
  exit 0
fi
exit 1
`;
  await Promise.all(
    ["scutil", "hostnamectl"].map((executable) =>
      NodeFSP.writeFile(NodePath.join(binDirectory, executable), probeScript, { mode: 0o755 }),
    ),
  );
  return binDirectory;
}

function startShowcaseServer(
  baseDir: string,
  workspaceRoot: string,
  port: number,
  shellPath: string,
  labelProbeDirectory: string,
): NodeChildProcess.ChildProcess {
  return spawnProcess(
    "node",
    [
      "apps/server/src/bin.ts",
      "serve",
      "--host",
      SERVER_HOST,
      "--port",
      String(port),
      "--base-dir",
      baseDir,
      "--no-browser",
      "--log-level",
      "error",
      workspaceRoot,
    ],
    {
      env: {
        ...NodeProcess.env,
        PATH: `${labelProbeDirectory}:${NodeProcess.env.PATH ?? ""}`,
        SHELL: shellPath,
      },
    },
  );
}

export interface ShowcaseEnvironment {
  readonly baseDir: string;
  readonly environmentId: string;
  readonly label: string;
  readonly port: number;
}

/** Boot one seeded fixture server per showcase environment; `track` receives every spawned server. */
export async function startShowcaseEnvironments(
  rootDir: string,
  track: (server: NodeChildProcess.ChildProcess) => void,
  environments: ReadonlyArray<(typeof SHOWCASE_ENVIRONMENTS)[number]> = SHOWCASE_ENVIRONMENTS,
): Promise<ShowcaseEnvironment[]> {
  const started: ShowcaseEnvironment[] = [];
  for (const environment of environments) {
    const projectId = environment.projectIds[0];
    const project = SHOWCASE_PROJECTS.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error(`Showcase environment '${environment.id}' has no project.`);

    const baseDir = NodePath.join(rootDir, "environments", environment.id);
    const workspaceRoot = NodePath.join(baseDir, "workspace", project.directory);
    const port = await reserveAvailablePort();
    await NodeFSP.mkdir(workspaceRoot, { recursive: true });
    const shellPath = await createShowcaseShell(baseDir);
    const labelProbeDirectory = await createShowcaseLabelProbe(baseDir, environment.label);
    const server = startShowcaseServer(
      baseDir,
      workspaceRoot,
      port,
      shellPath,
      labelProbeDirectory,
    );
    track(server);
    await waitForPort(port, `${environment.label} server`);
    await seedShowcaseEnvironment({ baseDir, projectIds: environment.projectIds });
    // Legacy fixture threads are imported into V2 during server startup.
    await stopProcess(server);
    const seededServer = startShowcaseServer(
      baseDir,
      workspaceRoot,
      port,
      shellPath,
      labelProbeDirectory,
    );
    track(seededServer);
    await waitForPort(port, `${environment.label} seeded server`);
    // The server begins listening before the ServerEnvironment layer
    // persists the environment id, so poll rather than read once.
    const environmentId = await waitForFileContent(
      NodePath.join(baseDir, "userdata", "environment-id"),
      `${environment.label} environment id`,
    );
    started.push({ baseDir, environmentId, label: environment.label, port });
  }
  return started;
}

export function parsePairingCredentialOutput(output: string): string {
  const jsonStart = output.indexOf("{");
  const jsonEnd = output.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd < jsonStart) {
    throw new Error("Pairing credential command did not return JSON.");
  }
  const parsed = JSON.parse(output.slice(jsonStart, jsonEnd + 1)) as {
    readonly credential?: unknown;
  };
  if (typeof parsed.credential !== "string" || parsed.credential.length === 0) {
    throw new Error("Pairing credential command returned no credential.");
  }
  return parsed.credential;
}

export async function issuePairingCredential(baseDir: string): Promise<string> {
  const output = await commandOutput(
    "node",
    ["apps/server/src/bin.ts", "auth", "pairing", "create", "--base-dir", baseDir, "--json"],
    { env: { ...NodeProcess.env, NO_COLOR: "1" } },
  );
  return parsePairingCredentialOutput(output);
}

export function buildShowcasePairingUrl(host: string, port: number, credential: string): string {
  const url = new URL(`http://${host}:${port}/`);
  url.hash = new URLSearchParams([["token", credential]]).toString();
  return url.toString();
}

function startMetro(config: ShowcaseConfig): NodeChildProcess.ChildProcess {
  return spawnProcess(
    "pnpm",
    ["exec", "expo", "start", "--dev-client", "--port", String(config.metroPort)],
    {
      cwd: MOBILE_ROOT,
      env: {
        ...MOBILE_BUILD_ENV,
        EXPO_PUBLIC_SHOWCASE: "1",
      },
    },
  );
}

async function warmMetroBundle(
  platform: ShowcaseDevice["platform"],
  host: string,
  config: ShowcaseConfig,
): Promise<void> {
  const url = `http://${host}:${config.metroPort}/apps/mobile/index.bundle?platform=${platform}&dev=true&minify=false`;
  await runCommand("curl", ["--fail", "--silent", "--show-error", "--output", "/dev/null", url]);
}

async function buildIos(): Promise<string> {
  const derivedData = NodePath.join(MOBILE_ROOT, ".showcase/ios-derived-data");
  await runCommand("pnpm", ["exec", "expo", "prebuild", "--clean", "--platform", "ios"], {
    cwd: MOBILE_ROOT,
    env: MOBILE_BUILD_ENV,
  });
  await runCommand(
    "xcodebuild",
    [
      "-workspace",
      NodePath.join(MOBILE_ROOT, "ios/T3Code.xcworkspace"),
      "-scheme",
      "T3Code",
      "-configuration",
      "Debug",
      "-sdk",
      "iphonesimulator",
      "-derivedDataPath",
      derivedData,
      "-quiet",
      `ARCHS=${IOS_SIMULATOR_ARCH}`,
      "ONLY_ACTIVE_ARCH=YES",
      "build",
    ],
    { cwd: MOBILE_ROOT, env: MOBILE_BUILD_ENV },
  );
  return IOS_APP_PATH;
}

async function existingArtifact(path: string): Promise<string | null> {
  return await NodeFSP.access(path).then(
    () => path,
    () => null,
  );
}

interface SimctlDevice {
  readonly name: string;
  readonly udid: string;
  readonly state: "Booted" | "Shutdown" | string;
  readonly isAvailable: boolean;
}

async function findIosSimulator(name: string): Promise<SimctlDevice | null> {
  const parsed = JSON.parse(
    await commandOutput("xcrun", ["simctl", "list", "devices", "available", "-j"]),
  ) as {
    readonly devices: Readonly<Record<string, ReadonlyArray<SimctlDevice>>>;
  };
  const candidates = Object.entries(parsed.devices)
    .filter(([runtime]) => runtime.includes("iOS"))
    .flatMap(([, devices]) => devices)
    .filter((device) => device.isAvailable && device.name === name);
  return candidates.at(-1) ?? null;
}

async function ensureIosSimulator(device: ShowcaseIosDevice): Promise<{
  readonly simulator: SimctlDevice;
  readonly createdByRunner: boolean;
}> {
  const existing = await findIosSimulator(device.simulator);
  if (existing) return { simulator: existing, createdByRunner: false };
  if (!device.simulatorDeviceType) {
    throw new Error(
      `iOS simulator '${device.simulator}' is not installed and has no simulatorDeviceType configured.`,
    );
  }
  const udid = (
    await commandOutput("xcrun", ["simctl", "create", device.simulator, device.simulatorDeviceType])
  ).trim();
  if (!udid) throw new Error(`Could not create iOS simulator '${device.simulator}'.`);
  return {
    simulator: {
      name: device.simulator,
      udid,
      state: "Shutdown",
      isAvailable: true,
    },
    createdByRunner: true,
  };
}

async function iosSimulatorDataPath(udid: string): Promise<string> {
  const parsed = JSON.parse(await commandOutput("xcrun", ["simctl", "list", "devices", "-j"])) as {
    readonly devices: Readonly<
      Record<string, ReadonlyArray<SimctlDevice & { readonly dataPath: string }>>
    >;
  };
  const dataPath = Object.values(parsed.devices)
    .flat()
    .find((device) => device.udid === udid)?.dataPath;
  if (!dataPath) throw new Error(`Could not resolve the data path of iOS simulator ${udid}.`);
  return dataPath;
}

// Apple Intelligence posts persistent first-boot banners; mark readiness and clear queued CoreFollowUp notices.
async function suppressIosSystemFollowUps(udid: string): Promise<void> {
  const dataPath = await iosSimulatorDataPath(udid);
  const preferences = NodePath.join(dataPath, "Library/Preferences");
  await NodeFSP.mkdir(preferences, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(preferences, "com.apple.generativeexperiences.corefollowup.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>DateOfLastAppleIntelligenceReadinessCFU</key>
\t<date>2020-01-01T00:00:00Z</date>
</dict>
</plist>
`,
  );
  await NodeFSP.rm(NodePath.join(dataPath, "Library/CoreFollowUp"), {
    recursive: true,
    force: true,
  });
}

async function normalizeIosSimulator(appearance: ShowcaseAppearance, udid: string): Promise<void> {
  await runCommand("xcrun", ["simctl", "ui", udid, "appearance", appearance]);
  // Disable always-on dimming so lock-screen wake can distinguish off from fully lit.
  await runCommand("xcrun", [
    "simctl",
    "spawn",
    udid,
    "defaults",
    "write",
    "com.apple.springboard",
    "SBEnableAlwaysOn",
    "-bool",
    "false",
  ]);
  await runCommand("xcrun", [
    "simctl",
    "status_bar",
    udid,
    "override",
    "--time",
    "9:41",
    "--batteryState",
    "charged",
    "--batteryLevel",
    "100",
    "--wifiBars",
    "3",
    "--cellularBars",
    "4",
  ]);
}

// iPadOS 26 windowing forces fullscreen apps into portrait, defeating capture-build rotation.
async function ensureIosFullScreenAppsMode(udid: string): Promise<void> {
  const current = await commandOutput("xcrun", [
    "simctl",
    "spawn",
    udid,
    "defaults",
    "read",
    "com.apple.springboard",
    "SBChamoisWindowingEnabled",
  ]).catch(() => "");
  if (current.trim() === "0") return;
  // Fresh devices honor the Settings toggle only when all three keys are written.
  for (const key of [
    "SBChamoisWindowingEnabled",
    "SBMedusaMultitaskingEnabled",
    "SBFlexibleWindowingPreviouslyEnabledAutomaticStageCreation",
  ]) {
    await runCommand("xcrun", [
      "simctl",
      "spawn",
      udid,
      "defaults",
      "write",
      "com.apple.springboard",
      key,
      "-bool",
      "false",
    ]);
  }
  // New simulators require a reboot, not just SpringBoard restart, before windowing settings take effect.
  await runCommand("xcrun", ["simctl", "shutdown", udid]);
  await runCommand("xcrun", ["simctl", "boot", udid]);
  await runCommand("xcrun", ["simctl", "bootstatus", udid, "-b"]);
  const applied = await commandOutput("xcrun", [
    "simctl",
    "spawn",
    udid,
    "defaults",
    "read",
    "com.apple.springboard",
    "SBChamoisWindowingEnabled",
  ]).catch(() => "");
  if (applied.trim() !== "0") {
    throw new Error(`Simulator ${udid} did not switch to Full Screen Apps mode.`);
  }
}

async function iosAppContainer(udid: string): Promise<string> {
  return (
    await commandOutput("xcrun", ["simctl", "get_app_container", udid, APP_ID, "data"])
  ).trim();
}

async function waitForIosShowcaseScene(
  udid: string,
  scene: ShowcaseScene,
  timeoutMs = 90_000,
): Promise<void> {
  const readyPath = NodePath.join(
    await iosAppContainer(udid),
    "Library/Caches",
    IOS_READY_FILENAME,
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const readyScene = await NodeFSP.readFile(readyPath, "utf8").catch(() => "");
    if (readyScene.trim() === scene) return;
    await delay(500);
  }
  throw new Error(`iOS showcase scene '${scene}' did not render within ${timeoutMs}ms.`);
}

async function captureIos(
  capture: ShowcaseCapture & { readonly device: ShowcaseIosDevice },
  appPath: string | null,
  outputDirectory: string,
  config: ShowcaseConfig,
  metroHost: string,
  pairingUrls: ReadonlyArray<string>,
  registerCleanup: (cleanup: IosCaptureCleanup) => void,
): Promise<void> {
  const { simulator, createdByRunner } = await ensureIosSimulator(capture.device);
  const startedByRunner = simulator.state !== "Booted";
  registerCleanup({ udid: simulator.udid, startedByRunner, createdByRunner });
  if (!startedByRunner) {
    await runCommand("xcrun", ["simctl", "shutdown", simulator.udid]);
  }
  await suppressIosSystemFollowUps(simulator.udid);
  await runCommand("xcrun", ["simctl", "boot", simulator.udid]);
  await runCommand("xcrun", ["simctl", "bootstatus", simulator.udid, "-b"]);
  if (capture.device.orientation === "landscape") {
    await ensureIosFullScreenAppsMode(simulator.udid);
  }
  if (capture.device.fold) {
    const command = NodeProcess.env.AGENT_DEVICE_PATH ?? "agent-device";
    const target = [
      "--platform",
      "ios",
      "--udid",
      simulator.udid,
      "--session",
      `showcase-${simulator.udid}`,
    ];
    await runCommand(command, ["open", ...target]);
    try {
      await runCommand(command, ["fold", capture.device.fold, ...target]);
    } finally {
      await runCommand(command, ["close", ...target]);
    }
  }
  await normalizeIosSimulator(capture.appearance, simulator.udid);
  if (appPath) {
    await runCommand("xcrun", ["simctl", "uninstall", simulator.udid, APP_ID]).catch(
      () => undefined,
    );
    await runCommand("xcrun", ["simctl", "install", simulator.udid, appPath]);
  }

  const metroUrl = `http://${metroHost}:${config.metroPort}?${DEV_CLIENT_LAUNCH_FLAGS}`;
  const scenePath = NodePath.join(
    await iosAppContainer(simulator.udid),
    "Library/Caches/T3ShowcaseScene",
  );
  const readyPath = NodePath.join(
    await iosAppContainer(simulator.udid),
    "Library/Caches",
    IOS_READY_FILENAME,
  );
  const firstScene = capture.scenes[0] ?? "threads";
  const launchShowcaseApp = async (terminateRunningProcess: boolean) => {
    await runCommand("xcrun", [
      "simctl",
      "launch",
      ...(terminateRunningProcess ? ["--terminate-running-process"] : []),
      simulator.udid,
      APP_ID,
      "--initialUrl",
      metroUrl,
      "--showcasePairingUrl",
      JSON.stringify(pairingUrls),
      "--showcaseScene",
      firstScene,
      "--showcaseTheme",
      capture.theme,
      // Simulator rotation UI scripting needs Accessibility permission unavailable on CI.
      "--showcaseOrientation",
      capture.device.orientation ?? "portrait",
    ]);
  };
  await NodeFSP.rm(readyPath, { force: true });
  await NodeFSP.writeFile(scenePath, firstScene);
  await launchShowcaseApp(false);
  for (const [sceneIndex, scene] of capture.scenes.entries()) {
    if (sceneIndex > 0) await NodeFSP.rm(readyPath, { force: true });
    await NodeFSP.writeFile(scenePath, scene);
    const waitForScene = (timeoutMs?: number) =>
      waitForIosShowcaseScene(simulator.udid, scene, timeoutMs);
    if (sceneIndex === 0) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const isLastAttempt = attempt === 1;
        try {
          // A fresh Expo build can spend over 30 s applying a bundled update; killing it returns to the launcher.
          await waitForScene(120_000);
          break;
        } catch (error) {
          if (isLastAttempt) throw error;
          await launchShowcaseApp(true);
        }
      }
    } else {
      await waitForScene();
    }
    await delay(scene === "review" ? Math.max(config.settleDelayMs, 8_000) : config.settleDelayMs);
    const destination = NodePath.join(
      showcaseCaptureDirectory(outputDirectory, capture),
      `${scene}.png`,
    );
    await runCommand("xcrun", [
      "simctl",
      "io",
      simulator.udid,
      "screenshot",
      ...(capture.device.fold ? ["--display", capture.device.fold === "closed" ? "1" : "3"] : []),
      destination,
    ]);
    if (capture.device.orientation === "landscape") {
      // Headless displays stay portrait despite app rotation; post-rotate only captures still in portrait.
      const { width, height } = readPngDimensions(await NodeFSP.readFile(destination));
      if (height > width) {
        await runCommand("sips", ["--rotate", capture.device.fold ? "90" : "270", destination]);
      }
    }
    await finalizeCapture(destination, capture.device);
  }
}

async function main(): Promise<void> {
  const options = parseShowcaseCliArgs(NodeProcess.argv.slice(2));
  if (options.list) {
    printUsage(showcaseConfig);
    return;
  }
  const captures = planShowcaseCaptures(showcaseConfig, options);
  const outputDirectory = NodePath.resolve(REPO_ROOT, showcaseConfig.outputDirectory);
  if (options.validateOnly) {
    for (const capture of captures) {
      await validateCaptureSet(
        capture,
        outputDirectory,
        capture.scenes.length === capture.device.scenes.length,
      );
    }
    return;
  }
  const hasIos = captures.some((capture) => capture.device.platform === "ios");
  const metroHost = hasIos ? lanIpv4Address() : "127.0.0.1";
  await NodeFSP.mkdir(outputDirectory, { recursive: true });
  for (const capture of captures) {
    const directory = showcaseCaptureDirectory(outputDirectory, capture);
    await NodeFSP.rm(directory, { recursive: true, force: true });
    await NodeFSP.mkdir(directory, { recursive: true });
  }

  const showcaseRootDir = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "t3-mobile-showcase-"),
  );
  const showcaseServers: NodeChildProcess.ChildProcess[] = [];
  const showcaseEnvironments: ShowcaseEnvironment[] = [];
  let metro: NodeChildProcess.ChildProcess | null = null;
  const iosCleanups: IosCaptureCleanup[] = [];

  try {
    showcaseEnvironments.push(
      ...(await startShowcaseEnvironments(showcaseRootDir, (server) =>
        showcaseServers.push(server),
      )),
    );

    if (!options.skipMetro) {
      metro = startMetro(showcaseConfig);
      await waitForPort(showcaseConfig.metroPort, "Metro");
      if (hasIos) await warmMetroBundle("ios", metroHost, showcaseConfig);
    }

    const iosAppPath = hasIos
      ? options.skipBuild
        ? await existingArtifact(IOS_APP_PATH)
        : await buildIos()
      : null;
    for (const capture of captures) {
      const pairingHost = "127.0.0.1";
      const pairingUrls = await Promise.all(
        showcaseEnvironments.map(async (environment) => {
          const credential = await issuePairingCredential(environment.baseDir);
          return buildShowcasePairingUrl(pairingHost, environment.port, credential);
        }),
      );
      await captureIos(
        capture as ShowcaseCapture & { readonly device: ShowcaseIosDevice },
        iosAppPath,
        outputDirectory,
        showcaseConfig,
        metroHost,
        pairingUrls,
        (cleanup) => iosCleanups.push(cleanup),
      );
      await validateCaptureSet(
        capture,
        outputDirectory,
        capture.scenes.length === capture.device.scenes.length,
      );
    }

    NodeProcess.stdout.write(
      `\nDone. Upload-ready screenshots are in ${NodePath.relative(REPO_ROOT, outputDirectory)}/apple/.\n`,
    );
    if (options.keepRunning) {
      const serverSummary = showcaseEnvironments
        .map((environment) => `${environment.label}:${environment.port}`)
        .join(", ");
      NodeProcess.stdout.write(
        `Showcase environments kept at ${showcaseRootDir} (${serverSummary}).\n`,
      );
    }
  } finally {
    if (options.keepRunning) {
      metro?.unref();
      for (const server of showcaseServers) server.unref();
    } else {
      for (const cleanup of iosCleanups) {
        if (cleanup.startedByRunner || cleanup.createdByRunner) {
          await runCommand("xcrun", ["simctl", "shutdown", cleanup.udid]).catch(() => undefined);
        }
        if (cleanup.createdByRunner) {
          await runCommand("xcrun", ["simctl", "delete", cleanup.udid]).catch(() => undefined);
        }
      }
      await Promise.all([
        ...(metro ? [stopProcess(metro)] : []),
        ...showcaseServers.map((server) => stopProcess(server)),
      ]);
      await NodeFSP.rm(showcaseRootDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  }
}

if (import.meta.main) {
  void main().catch((error: unknown) => {
    NodeProcess.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    NodeProcess.exit(1);
  });
}
