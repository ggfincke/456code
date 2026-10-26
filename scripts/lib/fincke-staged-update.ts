// scripts/lib/fincke-staged-update.ts
// layout & manifest the local release stager writes and the desktop updater reads

// staged builds live under the app's home, e.g. ~/.456code-thin/updates/linux/manifest.json
export const STAGED_UPDATES_DIR = "updates";
export const STAGED_UPDATE_MANIFEST = "manifest.json";

export type StagedUpdatePlatform = "linux" | "mac";

/**
 * One staged build. `artifact` is relative to the platform directory: an AppImage file on
 * Linux, an unpacked `.app` bundle on macOS.
 */
export interface StagedUpdateManifest {
  readonly version: string;
  readonly commit: string;
  readonly builtAt: string;
  readonly artifact: string;
}

export function stagedUpdatePlatform(platform: NodeJS.Platform): StagedUpdatePlatform | null {
  if (platform === "linux") return "linux";
  if (platform === "darwin") return "mac";
  return null;
}

// staged builds number themselves 0.1.<main commit count>, so plain numeric x.y.z is enough
const RELEASE_VERSION = /^\d+\.\d+\.\d+$/;

export function isReleaseVersion(version: string): boolean {
  return RELEASE_VERSION.test(version);
}

// negative when a < b; prerelease or malformed versions never compare as newer
export function compareReleaseVersions(a: string, b: string): number {
  if (!isReleaseVersion(a) || !isReleaseVersion(b)) return 0;
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

// the artifact must stay inside the platform dir, since the installer moves it into place
export function parseStagedUpdateManifest(raw: string): StagedUpdateManifest | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { version, commit, builtAt, artifact } = value as Record<string, unknown>;
  if (
    typeof version !== "string" ||
    !isReleaseVersion(version) ||
    typeof commit !== "string" ||
    !/^[0-9a-f]{40}$/.test(commit) ||
    typeof builtAt !== "string" ||
    typeof artifact !== "string" ||
    artifact.length === 0 ||
    artifact.includes("/") ||
    artifact.includes("\\") ||
    artifact === "." ||
    artifact === ".."
  ) {
    return null;
  }
  return { version, commit, builtAt, artifact };
}
