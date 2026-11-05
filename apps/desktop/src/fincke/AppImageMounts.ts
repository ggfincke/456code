// apps/desktop/src/fincke/AppImageMounts.ts
// drops env entries that point into another AppImage instance's mount dir

const MOUNT_SEGMENT = /(?:^|\/)\.mount_[^/]+(?:\/|$)/u;
const PATH_LIKE_ENV_KEYS = [
  "PATH",
  "LD_LIBRARY_PATH",
  "XDG_DATA_DIRS",
  "GSETTINGS_SCHEMA_DIR",
] as const;

// a relaunch (ours or electron-updater's) inherits the old instance's /tmp/.mount_* entries.
// once that FUSE mount dies, PATH lookups through it fail w/ ENOTCONN instead of moving on,
// so spawning ssh or a provider CLI throws and can take the backend down at startup
export function isStaleAppImageMountEntry(entry: string, appDir: string | undefined): boolean {
  if (!MOUNT_SEGMENT.test(entry)) return false;
  const current = appDir?.replace(/\/+$/u, "");
  return !current || (entry !== current && !entry.startsWith(`${current}/`));
}

export function dropStaleAppImageMounts(env: NodeJS.ProcessEnv): void {
  for (const key of PATH_LIKE_ENV_KEYS) {
    const value = env[key];
    if (value === undefined) continue;
    const entries = value.split(":");
    const kept = entries.filter((entry) => !isStaleAppImageMountEntry(entry, env.APPDIR));
    if (kept.length === entries.length) continue;
    if (kept.some((entry) => entry.length > 0)) env[key] = kept.join(":");
    else delete env[key];
  }
}
