// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalFetch:off - a timer runs this before any install, so only Node built-ins and globals exist.
// scripts/fincke-stage-update.ts
// builds the latest green origin/main desktop app & stages it for the in-app update button
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { finckeDesktop } from "./lib/fincke-desktop.ts";
import {
  STAGED_UPDATE_MANIFEST,
  STAGED_UPDATES_DIR,
  parseStagedUpdateManifest,
  stagedUpdatePlatform,
  type StagedUpdateManifest,
} from "./lib/fincke-staged-update.ts";

// the systemd timer (furnace) or LaunchAgent (Mac) runs this from the main checkout every
// 15 minutes. It only stages: the running app offers the build & installs it when asked.
const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";

const repoRoot = NodePath.dirname(import.meta.dirname);
// oxlint-disable-next-line t3code/no-global-process-runtime -- standalone timer script with no Effect runtime.
const hostPlatform = NodeOS.platform();
const platform = stagedUpdatePlatform(hostPlatform);
if (platform === null) {
  log(`staged updates are not supported on ${hostPlatform}`);
  process.exit(0);
}

const platformDir = NodePath.join(
  NodeOS.homedir(),
  finckeDesktop.home,
  STAGED_UPDATES_DIR,
  platform,
);
// a fixed sibling path so a crashed run's checkout is reused instead of piling up
const worktree = NodePath.join(NodePath.dirname(repoRoot), "456code-stage");
const lockPath = NodePath.join(platformDir, ".stage.lock");

function log(message: string): void {
  console.log(`[stage-update] ${new Date().toISOString()} ${message}`);
}

function run(command: string, args: ReadonlyArray<string>, cwd = repoRoot): string {
  return NodeChildProcess.execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

function runStreaming(
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  NodeChildProcess.execFileSync(command, args, { cwd, env, stdio: "inherit" });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// a build can outlast the 15 minute timer, so a live holder makes this tick a no-op
function acquireLock(): boolean {
  NodeFS.mkdirSync(platformDir, { recursive: true });
  try {
    NodeFS.writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx" });
    return true;
  } catch {
    const holder = Number.parseInt(NodeFS.readFileSync(lockPath, "utf8"), 10);
    if (Number.isInteger(holder) && isProcessAlive(holder)) return false;
    NodeFS.writeFileSync(lockPath, `${process.pid}\n`);
    return true;
  }
}

function readStagedManifest(): StagedUpdateManifest | null {
  try {
    return parseStagedUpdateManifest(
      NodeFS.readFileSync(NodePath.join(platformDir, STAGED_UPDATE_MANIFEST), "utf8"),
    );
  } catch {
    return null;
  }
}

function githubRepository(): string {
  const url = run("git", ["remote", "get-url", "origin"]);
  const match = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (!match?.[1]) throw new Error(`origin is not a GitHub repository: ${url}`);
  return match[1];
}

type CiState = "success" | "pending" | "failed";

// the repo is public, so this reads the API anonymously; gh's keychain token is locked
// to a LaunchAgent on macOS, and 4 calls an hour sits far under the anonymous limit
async function ciState(repository: string, commit: string): Promise<CiState> {
  const response = await fetch(
    `https://api.github.com/repos/${repository}/actions/runs?head_sha=${commit}&event=push`,
    { headers: { accept: "application/vnd.github+json" } },
  );
  if (!response.ok) throw new Error(`GitHub API answered ${response.status}`);
  const body = (await response.json()) as {
    readonly workflow_runs: ReadonlyArray<{
      readonly path: string;
      readonly status: string;
      readonly conclusion: string | null;
    }>;
  };
  const runs = body.workflow_runs.filter((entry) => entry.path === CI_WORKFLOW_PATH);
  if (runs.length === 0 || runs.some((entry) => entry.status !== "completed")) return "pending";
  return runs.every((entry) => entry.conclusion === "success") ? "success" : "failed";
}

// builds use the exact Node the commit pins, from mise's installs; a missing version fails
// loudly instead of downloading a runtime behind the user's back
function nodeBinDir(checkout: string): string {
  const packageJson = JSON.parse(
    NodeFS.readFileSync(NodePath.join(checkout, "package.json"), "utf8"),
  ) as { readonly engines?: { readonly node?: string } };
  const version = packageJson.engines?.node;
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("package.json does not pin an exact engines.node version");
  }
  const binDir = NodePath.join(
    NodeOS.homedir(),
    ".local",
    "share",
    "mise",
    "installs",
    "node",
    version,
    "bin",
  );
  if (!NodeFS.existsSync(NodePath.join(binDir, "node"))) {
    throw new Error(`node ${version} is not installed; run \`mise install node@${version}\``);
  }
  return binDir;
}

function removeWorktree(): void {
  const registered = run("git", ["worktree", "list", "--porcelain"])
    .split("\n")
    .some((line) => line === `worktree ${worktree}`);
  if (registered) run("git", ["worktree", "remove", "--force", worktree]);
  else NodeFS.rmSync(worktree, { recursive: true, force: true });
}

function findReleaseFile(releaseDir: string, extension: string): string {
  const match = NodeFS.readdirSync(releaseDir).find((name) => name.endsWith(extension));
  if (!match) throw new Error(`build produced no ${extension} in ${releaseDir}`);
  return NodePath.join(releaseDir, match);
}

function buildAndStage(commit: string, version: string): StagedUpdateManifest {
  removeWorktree();
  run("git", ["worktree", "add", "--detach", worktree, commit]);
  const nodeDir = nodeBinDir(worktree);
  const env = {
    ...process.env,
    PATH: [NodePath.join(worktree, "node_modules", ".bin"), nodeDir, process.env.PATH ?? ""].join(
      NodePath.delimiter,
    ),
  };
  // the fresh checkout has no node_modules yet, so install with the main checkout's vp
  runStreaming(
    NodePath.join(repoRoot, "node_modules", ".bin", "vp"),
    ["i", "--frozen-lockfile", "--", "--yes"],
    worktree,
    env,
  );
  runStreaming(
    NodePath.join(nodeDir, "node"),
    [
      "scripts/build-desktop-artifact.ts",
      "--platform",
      platform === "mac" ? "mac" : "linux",
      "--target",
      platform === "mac" ? "dmg" : "AppImage",
      "--arch",
      // oxlint-disable-next-line t3code/no-global-process-runtime -- standalone timer script with no Effect runtime.
      NodeOS.arch() === "arm64" ? "arm64" : "x64",
      "--build-version",
      version,
    ],
    worktree,
    env,
  );

  const releaseDir = NodePath.join(worktree, "release");
  const artifact = `456code-${version}${platform === "mac" ? ".app" : ".AppImage"}`;
  const stagedPath = NodePath.join(platformDir, artifact);
  NodeFS.rmSync(stagedPath, { recursive: true, force: true });
  if (platform === "mac") {
    // the dmg target also emits a zip, which ditto unpacks w/o mounting anything
    const unpackDir = NodePath.join(platformDir, `.unpack-${version}`);
    NodeFS.rmSync(unpackDir, { recursive: true, force: true });
    run("ditto", ["-x", "-k", findReleaseFile(releaseDir, ".zip"), unpackDir]);
    const app = NodeFS.readdirSync(unpackDir).find((name) => name.endsWith(".app"));
    if (!app) throw new Error("the mac zip holds no .app bundle");
    NodeFS.renameSync(NodePath.join(unpackDir, app), stagedPath);
    NodeFS.rmSync(unpackDir, { recursive: true, force: true });
  } else {
    const partial = `${stagedPath}.partial`;
    NodeFS.copyFileSync(findReleaseFile(releaseDir, ".AppImage"), partial);
    NodeFS.chmodSync(partial, 0o755);
    NodeFS.renameSync(partial, stagedPath);
  }
  return { version, commit, builtAt: new Date().toISOString(), artifact };
}

// the manifest is written last & atomically, so the app never offers a half-copied build
function publishManifest(manifest: StagedUpdateManifest): void {
  const manifestPath = NodePath.join(platformDir, STAGED_UPDATE_MANIFEST);
  NodeFS.writeFileSync(`${manifestPath}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`);
  NodeFS.renameSync(`${manifestPath}.tmp`, manifestPath);
  for (const name of NodeFS.readdirSync(platformDir)) {
    if (name === STAGED_UPDATE_MANIFEST || name === manifest.artifact || name === ".stage.lock") {
      continue;
    }
    NodeFS.rmSync(NodePath.join(platformDir, name), { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  if (!acquireLock()) {
    log("another staging run is still going");
    return;
  }
  try {
    run("git", ["fetch", "--quiet", "origin", "main"]);
    const commit = run("git", ["rev-parse", "origin/main"]);
    if (readStagedManifest()?.commit === commit) {
      log(`origin/main ${commit.slice(0, 9)} is already staged`);
      return;
    }
    const state = await ciState(githubRepository(), commit);
    if (state !== "success") {
      log(`waiting on CI for ${commit.slice(0, 9)} (${state})`);
      return;
    }
    // commit count only grows on main, so each staged build is newer than the last
    const version = `0.1.${run("git", ["rev-list", "--count", commit])}`;
    log(`staging ${version} from ${commit.slice(0, 9)}`);
    try {
      const manifest = buildAndStage(commit, version);
      publishManifest(manifest);
      log(`staged ${manifest.artifact}`);
    } finally {
      removeWorktree();
    }
  } finally {
    NodeFS.rmSync(lockPath, { force: true });
  }
}

await main();
