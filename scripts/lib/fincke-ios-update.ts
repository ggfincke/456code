// scripts/lib/fincke-ios-update.ts
// exports the iOS JS bundle & writes the Expo Updates manifest the server hands to the iPhone app

// @effect-diagnostics nodeBuiltinImport:off - the update stager runs before any install, so only Node built-ins exist.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

// the Expo Updates protocol v1 manifest body, inside each staged version dir
const IOS_EXPO_MANIFEST = "expo-manifest.json";

interface ExpoAsset {
  readonly hash: string;
  readonly key: string;
  readonly contentType: string;
  readonly fileExtension: string;
  readonly url: string;
}

interface ExportMetadata {
  readonly fileMetadata: {
    readonly ios?: {
      readonly bundle: string;
      readonly assets: ReadonlyArray<{ readonly path: string; readonly ext: string }>;
    };
  };
}

type PublicExpoConfig = Record<string, unknown> & {
  readonly updates?: { readonly url?: unknown };
  readonly extra?: Record<string, unknown>;
};

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ttf: "font/ttf",
  otf: "font/otf",
  json: "application/json",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  pdf: "application/pdf",
};

// * the env `vp run ios:release` builds the binary with; anything else that reaches the app
// config changes the fingerprint, and the binary would never accept these bundles
function releaseEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, APP_VARIANT: "production", EXPO_NO_GIT_STATUS: "1" };
}

function capture(
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  env: NodeJS.ProcessEnv,
) {
  return NodeChildProcess.execFileSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

function sha256(bytes: Buffer): Buffer {
  return NodeCrypto.createHash("sha256").update(bytes).digest();
}

// expo-updates checks `hash` against the downloaded file, as unpadded base64url sha256. The
// md5 `key` is metro's asset hash, which the binary's embedded assets use as their key, so the
// client skips downloading assets it already ships
function assetEntry(
  outputDir: string,
  relativePath: string,
  contentType: string,
  fileExtension: string,
  urlBase: string,
): ExpoAsset {
  const bytes = NodeFS.readFileSync(NodePath.join(outputDir, relativePath));
  return {
    hash: sha256(bytes).toString("base64url"),
    key: NodeCrypto.createHash("md5").update(bytes).digest("hex"),
    contentType,
    fileExtension,
    url: `${urlBase}/${relativePath}`,
  };
}

// a v4-shaped uuid from the commit & launch bundle, so re-staging the same build keeps its id
function updateId(commit: string, launchAssetHash: string): string {
  const bytes = sha256(Buffer.from(`${commit}:${launchAssetHash}`)).subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// asset urls are `<assets route>/<version>/<path in outputDir>`, so the stager must publish
// outputDir as the `<version>` dir
export function exportIosUpdate(options: {
  readonly mobileDir: string;
  readonly outputDir: string;
  readonly commit: string;
  readonly version: string;
  readonly createdAt: string;
  readonly env: NodeJS.ProcessEnv;
}): void {
  const { mobileDir, outputDir, commit, version, createdAt } = options;
  const env = releaseEnv(options.env);
  const bin = (name: string) => NodePath.join(mobileDir, "node_modules", ".bin", name);

  // the app config owns the update url, so the assets route is derived from it
  const expoClient = JSON.parse(
    capture(bin("expo"), ["config", "--type", "public", "--json"], mobileDir, env),
  ) as PublicExpoConfig;
  const manifestUrl = expoClient.updates?.url;
  if (typeof manifestUrl !== "string" || !manifestUrl.endsWith("/manifest")) {
    throw new Error(`app config updates.url must end in /manifest, got ${String(manifestUrl)}`);
  }
  const urlBase = `${manifestUrl.slice(0, -"/manifest".length)}/assets/${version}`;

  // the same resolver the native build phase runs, so the fingerprint policy matches the binary
  const resolved = capture(
    bin("expo-updates"),
    ["runtimeversion:resolve", "--platform", "ios"],
    mobileDir,
    env,
  );
  const runtimeVersion = (
    JSON.parse(resolved.split("\n").at(-1) ?? "") as { readonly runtimeVersion: unknown }
  ).runtimeVersion;
  if (typeof runtimeVersion !== "string" || runtimeVersion.length === 0) {
    throw new Error(`expo-updates resolved no iOS runtime version: ${String(runtimeVersion)}`);
  }

  NodeChildProcess.execFileSync(
    bin("expo"),
    ["export", "--platform", "ios", "--output-dir", outputDir],
    { cwd: mobileDir, env, stdio: ["ignore", "inherit", "inherit"] },
  );

  const metadata = JSON.parse(
    NodeFS.readFileSync(NodePath.join(outputDir, "metadata.json"), "utf8"),
  ) as ExportMetadata;
  const ios = metadata.fileMetadata.ios;
  if (!ios) throw new Error("expo export wrote no iOS entry in metadata.json");

  // ".bundle" matches Expo's reference server; the client only uses it to name its cache file
  const launchAsset = assetEntry(
    outputDir,
    ios.bundle,
    "application/javascript",
    ".bundle",
    urlBase,
  );
  const assets = ios.assets.map((asset) =>
    assetEntry(
      outputDir,
      asset.path,
      CONTENT_TYPES[asset.ext.toLowerCase()] ?? "application/octet-stream",
      `.${asset.ext}`,
      urlBase,
    ),
  );

  const manifest = {
    id: updateId(commit, launchAsset.hash),
    createdAt,
    runtimeVersion,
    launchAsset,
    assets,
    metadata: {},
    extra: { expoClient: { ...expoClient, extra: { ...expoClient.extra, finckeBuild: version } } },
  };
  NodeFS.writeFileSync(
    NodePath.join(outputDir, IOS_EXPO_MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}
