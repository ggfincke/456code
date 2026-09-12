import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const execute = NodeUtil.promisify(NodeChildProcess.execFile);
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const MAX_FILES = 8_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const INCLUDED = /(?:\.(?:[cm]?[jt]sx?|json|ya?ml)|(?:^|\/)\.cartographer[^/]*)$/i;
const EXCLUDED = /(?:^|\/)(?:node_modules|\.git|\.repos|dist|build|out|coverage)(?:\/|$)/;
export const digest = (content: string | Uint8Array): string =>
  NodeCrypto.createHash("sha256").update(content).digest("hex");

export async function git(root: string, args: readonly string[]): Promise<string> {
  const result = await execute("git", ["--no-optional-locks", "-C", root, ...args], {
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    encoding: "utf8",
  });
  return result.stdout;
}

export function safePath(value: string): string {
  if (
    !value ||
    value.includes("\\") ||
    value.includes("\0") ||
    NodePath.posix.isAbsolute(value) ||
    value.split("/").some((part) => part === ".." || part === "." || part === "")
  ) {
    throw new Error("Invalid analysis source NodePath.");
  }
  return value;
}

export interface CapturedTree {
  readonly root: string;
  readonly identity: string;
  readonly head: string;
  readonly files: Readonly<Record<string, string>>;
}

export async function resolveCommit(root: string, ref: string): Promise<string> {
  if (!ref || ref.startsWith("-") || ref.length > 256)
    throw new Error("Invalid Git comparison ref.");
  return (await git(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim();
}

async function readTree(root: string, ref?: string): Promise<CapturedTree> {
  root = await NodeFSP.realpath(root);
  const head = await resolveCommit(root, ref ?? "HEAD");
  const archived = new Map<string, { oid: string; size: number }>();
  if (ref) {
    for (const entry of (await git(root, ["ls-tree", "-r", "-l", "-z", head])).split("\0")) {
      const match = /^(100[0-7]{3}) blob ([a-f0-9]+) +([0-9]+)\t([\s\S]+)$/.exec(entry);
      if (match && INCLUDED.test(match[4]!) && !EXCLUDED.test(match[4]!)) {
        archived.set(match[4]!, { oid: match[2]!, size: Number(match[3]) });
      }
    }
  }
  const names = ref
    ? [...archived.keys()]
    : (await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]))
        .split("\0")
        .filter((name) => name && INCLUDED.test(name) && !EXCLUDED.test(name));
  const unique = [...new Set(names)].sort();
  if (unique.length > MAX_FILES) throw new Error(`Analysis exceeds the ${MAX_FILES}-file limit.`);
  let archivedBytes: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let archiveOffset = 0;
  if (ref && unique.length) {
    let bytes = 0;
    for (const file of archived.values()) {
      if (file.size > MAX_FILE_BYTES || (bytes += file.size) > MAX_TOTAL_BYTES) {
        throw new Error("Analysis exceeds its source-byte limit.");
      }
    }
    const batch = execute("git", ["--no-optional-locks", "-C", root, "cat-file", "--batch"], {
      timeout: 30_000,
      maxBuffer: MAX_TOTAL_BYTES + MAX_FILES * 128,
      encoding: "buffer",
    });
    batch.child.stdin?.end(unique.map((name) => archived.get(name)!.oid).join("\n") + "\n");
    archivedBytes = (await batch).stdout;
  }
  const files: Record<string, string> = Object.create(null);
  let total = 0;
  for (const name of unique) {
    safePath(name);
    let content: string;
    if (ref) {
      const start = archivedBytes.indexOf(10, archiveOffset) + 1;
      const end = start + archived.get(name)!.size;
      if (start <= archiveOffset || end >= archivedBytes.length)
        throw new Error("Incomplete Git source capture.");
      content = utf8.decode(archivedBytes.subarray(start, end));
      archiveOffset = end + 1;
    } else {
      const absolute = NodePath.join(root, name);
      let stat;
      try {
        stat = await NodeFSP.lstat(absolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!stat.isFile()) continue;
      const canonical = await NodeFSP.realpath(absolute);
      if (!canonical.startsWith(`${root}${NodePath.sep}`))
        throw new Error("Analysis source escaped its worktree.");
      if (stat.size > MAX_FILE_BYTES) throw new Error(`Analysis source is too large: ${name}`);
      content = utf8.decode(await NodeFSP.readFile(absolute));
    }
    const size = Buffer.byteLength(content);
    if (size > MAX_FILE_BYTES || (total += size) > MAX_TOTAL_BYTES) {
      throw new Error("Analysis exceeds its source-byte limit.");
    }
    if (content.includes("\0")) continue;
    files[name] = content;
  }
  const identity = digest(JSON.stringify([root, head, Object.entries(files)]));
  return { root, head, identity, files };
}

export async function captureTree(root: string, ref?: string): Promise<CapturedTree> {
  const first = await readTree(root, ref);
  if (ref) return first;
  const second = await readTree(root);
  if (first.identity !== second.identity) {
    throw new Error("The worktree changed during capture. Wait for writes to finish and refresh.");
  }
  return first;
}

export async function materialize(tree: CapturedTree, directory: string): Promise<void> {
  for (const [name, content] of Object.entries(tree.files)) {
    const absolute = NodePath.join(directory, safePath(name));
    await NodeFSP.mkdir(NodePath.dirname(absolute), { recursive: true });
    await NodeFSP.writeFile(absolute, content, { flag: "wx" });
  }
}
