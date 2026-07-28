// tests/apps/server/vcs/ExactGitSnapshot.test.ts
// verifies raw bounded Git snapshots and filter-free tree materialization
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off

import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  captureExactGitSnapshot,
  materializeExactGitTree,
  restoreExactGitTree,
} from "../../../../apps/server/src/vcs/ExactGitSnapshot.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const temporaryRoots = new Set<string>();
const hasPosixPaths = NodePath.sep === "/";

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix));
  temporaryRoots.add(root);
  return root;
}

async function git(
  cwd: string,
  args: ReadonlyArray<string>,
  options: { readonly encoding?: "utf8" | "buffer" } = {},
): Promise<string | Buffer> {
  const encoding = options.encoding ?? "utf8";
  const result = await execFile("git", ["-C", cwd, ...args], {
    encoding: encoding === "buffer" ? "buffer" : "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout;
}

async function initializeRepository(): Promise<{
  readonly repositoryRoot: string;
  readonly filterMarker: string;
}> {
  const repositoryRoot = await temporaryRoot("456code-exact-git-workspace-");
  const supportRoot = await temporaryRoot("456code-exact-git-filter-");
  const filterMarker = NodePath.join(supportRoot, "filter-ran");
  const filter = NodePath.join(supportRoot, "filter.sh");
  await NodeFSP.writeFile(
    filter,
    ["#!/bin/sh", 'printf ran >> "$T3_EXACT_GIT_FILTER_MARKER"', "cat", ""].join("\n"),
    { mode: 0o755 },
  );
  await git(repositoryRoot, ["init"]);
  await git(repositoryRoot, ["config", "user.email", "exact-git@example.com"]);
  await git(repositoryRoot, ["config", "user.name", "Exact Git Test"]);
  await git(repositoryRoot, ["config", "filter.sentinel.clean", filter]);
  await git(repositoryRoot, ["config", "filter.sentinel.smudge", filter]);
  await NodeFSP.writeFile(
    NodePath.join(repositoryRoot, ".gitattributes"),
    "*.txt text eol=crlf\nfiltered.bin filter=sentinel\n",
  );
  await NodeFSP.writeFile(NodePath.join(repositoryRoot, ".gitignore"), "ignored.txt\n");
  await NodeFSP.writeFile(NodePath.join(repositoryRoot, "tracked.txt"), "committed\n");
  await NodeFSP.writeFile(NodePath.join(repositoryRoot, "filtered.bin"), "committed filter\n");
  await NodeFSP.writeFile(NodePath.join(repositoryRoot, "executable.sh"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  if (hasPosixPaths) {
    await NodeFSP.symlink("tracked.txt", NodePath.join(repositoryRoot, "tracked-link"));
  }

  const previousMarker = process.env.T3_EXACT_GIT_FILTER_MARKER;
  process.env.T3_EXACT_GIT_FILTER_MARKER = filterMarker;
  try {
    await git(repositoryRoot, ["add", "."]);
    await git(repositoryRoot, ["commit", "-m", "initial"]);
  } finally {
    if (previousMarker === undefined) {
      delete process.env.T3_EXACT_GIT_FILTER_MARKER;
    } else {
      process.env.T3_EXACT_GIT_FILTER_MARKER = previousMarker;
    }
  }
  await NodeFSP.rm(filterMarker, { force: true });
  return { repositoryRoot, filterMarker };
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (
      await NodeFSP.access(path).then(
        () => true,
        () => false,
      )
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

afterEach(async () => {
  await Promise.all(
    [...temporaryRoots].map((root) =>
      NodeFSP.rm(root, { force: true, recursive: true }).catch(() => undefined),
    ),
  );
  temporaryRoots.clear();
});

describe.sequential("ExactGitSnapshot", () => {
  it("captures and materializes current raw bytes without filters or index mutation", async () => {
    const { repositoryRoot, filterMarker } = await initializeRepository();
    const artifactRoot = await temporaryRoot("456code-exact-git-artifacts-");
    const destinationRoot = await temporaryRoot("456code-exact-git-materialized-");
    const indexPath = NodePath.join(artifactRoot, "snapshot.index");
    const userIndexPath = NodePath.join(repositoryRoot, ".git", "index");

    const previousMarker = process.env.T3_EXACT_GIT_FILTER_MARKER;
    process.env.T3_EXACT_GIT_FILTER_MARKER = filterMarker;
    try {
      await NodeFSP.writeFile(NodePath.join(repositoryRoot, "tracked.txt"), "staged\n");
      await git(repositoryRoot, ["add", "tracked.txt"]);
      await NodeFSP.rm(filterMarker, { force: true });
      await NodeFSP.writeFile(
        NodePath.join(repositoryRoot, "tracked.txt"),
        Buffer.from("captured\r\n", "utf8"),
      );
      await NodeFSP.writeFile(
        NodePath.join(repositoryRoot, "untracked.txt"),
        Buffer.from("untracked\r\n", "utf8"),
      );
      await NodeFSP.writeFile(NodePath.join(repositoryRoot, "ignored.txt"), "ignored\n");
      await NodeFSP.writeFile(NodePath.join(repositoryRoot, "filtered.bin"), "raw filter bytes\n");
      const indexBefore = await NodeFSP.readFile(userIndexPath);

      const snapshot = await captureExactGitSnapshot({
        repositoryRoot,
        indexPath,
        signal: new AbortController().signal,
      });
      const indexAfter = await NodeFSP.readFile(userIndexPath);
      const capturedTracked = (await git(
        repositoryRoot,
        ["cat-file", "blob", `${snapshot.treeOid}:tracked.txt`],
        { encoding: "buffer" },
      )) as Buffer;
      const capturedUntracked = (await git(
        repositoryRoot,
        ["cat-file", "blob", `${snapshot.treeOid}:untracked.txt`],
        { encoding: "buffer" },
      )) as Buffer;
      const capturedFiltered = (await git(
        repositoryRoot,
        ["cat-file", "blob", `${snapshot.treeOid}:filtered.bin`],
        { encoding: "buffer" },
      )) as Buffer;

      const materialized = await materializeExactGitTree({
        repositoryRoot,
        treeOid: snapshot.treeOid,
        destinationRoot,
        signal: new AbortController().signal,
      });

      expect(capturedTracked).toEqual(Buffer.from("captured\r\n"));
      expect(capturedUntracked).toEqual(Buffer.from("untracked\r\n"));
      expect(capturedFiltered).toEqual(Buffer.from("raw filter bytes\n"));
      expect(indexAfter).toEqual(indexBefore);
      expect(snapshot.headOid).toBe(
        ((await git(repositoryRoot, ["rev-parse", "HEAD"])) as string).trim(),
      );
      expect(snapshot.treeOid).toMatch(/^[0-9a-f]{40,64}$/u);
      expect(snapshot.fileCount).toBeGreaterThan(0);
      expect(snapshot.byteCount).toBeGreaterThan(0);
      expect(materialized).toEqual({
        rootPath: await NodeFSP.realpath(destinationRoot),
        fileCount: snapshot.fileCount,
        byteCount: snapshot.byteCount,
      });
      await expect(
        NodeFSP.readFile(NodePath.join(destinationRoot, "tracked.txt")),
      ).resolves.toEqual(Buffer.from("captured\r\n"));
      await expect(
        NodeFSP.readFile(NodePath.join(destinationRoot, "untracked.txt")),
      ).resolves.toEqual(Buffer.from("untracked\r\n"));
      await expect(
        NodeFSP.readFile(NodePath.join(destinationRoot, "filtered.bin")),
      ).resolves.toEqual(Buffer.from("raw filter bytes\n"));
      await expect(
        NodeFSP.access(NodePath.join(destinationRoot, "ignored.txt")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(NodeFSP.access(indexPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(NodeFSP.access(filterMarker)).rejects.toMatchObject({ code: "ENOENT" });

      const executableMode = (await NodeFSP.stat(NodePath.join(destinationRoot, "executable.sh")))
        .mode;
      expect(executableMode & 0o111).not.toBe(0);
      if (hasPosixPaths) {
        await expect(
          NodeFSP.readlink(NodePath.join(destinationRoot, "tracked-link")),
        ).resolves.toBe("tracked.txt");
      }
    } finally {
      if (previousMarker === undefined) {
        delete process.env.T3_EXACT_GIT_FILTER_MARKER;
      } else {
        process.env.T3_EXACT_GIT_FILTER_MARKER = previousMarker;
      }
    }
  });

  it("preflights byte limits before object or materialization writes", async () => {
    const { repositoryRoot } = await initializeRepository();
    const artifactRoot = await temporaryRoot("456code-exact-git-limit-artifacts-");
    const indexPath = NodePath.join(artifactRoot, "snapshot.index");
    const before = await git(repositoryRoot, ["count-objects", "-v"]);

    await expect(
      captureExactGitSnapshot({
        repositoryRoot,
        indexPath,
        signal: new AbortController().signal,
        limits: { maxFileCount: 25_000, maxByteCount: 1 },
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "limit-exceeded",
        name: "ExactGitSnapshotError",
      }),
    );
    expect(await git(repositoryRoot, ["count-objects", "-v"])).toBe(before);
    await expect(NodeFSP.access(indexPath)).rejects.toMatchObject({ code: "ENOENT" });

    const treeOid = ((await git(repositoryRoot, ["rev-parse", "HEAD^{tree}"])) as string).trim();
    const destinationRoot = await temporaryRoot("456code-exact-git-limit-destination-");
    await expect(
      materializeExactGitTree({
        repositoryRoot,
        treeOid,
        destinationRoot,
        signal: new AbortController().signal,
        limits: { maxFileCount: 25_000, maxByteCount: 1 },
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "limit-exceeded",
        name: "ExactGitSnapshotError",
      }),
    );
    await expect(NodeFSP.readdir(destinationRoot)).resolves.toEqual([]);
  });

  it("captures an unborn repository as an empty-HEAD current tree", async () => {
    const repositoryRoot = await temporaryRoot("456code-exact-git-unborn-");
    const artifactRoot = await temporaryRoot("456code-exact-git-unborn-artifacts-");
    const indexPath = NodePath.join(artifactRoot, "snapshot.index");
    await git(repositoryRoot, ["init"]);
    await NodeFSP.writeFile(NodePath.join(repositoryRoot, "new.txt"), "staged value\n");
    await git(repositoryRoot, ["add", "new.txt"]);
    await NodeFSP.writeFile(NodePath.join(repositoryRoot, "new.txt"), "current value\n");

    const snapshot = await captureExactGitSnapshot({
      repositoryRoot,
      indexPath,
      signal: new AbortController().signal,
    });

    expect(snapshot.headOid).toBeNull();
    expect(await git(repositoryRoot, ["cat-file", "blob", `${snapshot.treeOid}:new.txt`])).toBe(
      "current value\n",
    );
    await expect(NodeFSP.access(indexPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores raw bytes without filters while preserving ignored files", async () => {
    const repositoryRoot = await temporaryRoot("456code-exact-git-restore-");
    const artifactRoot = await temporaryRoot("456code-exact-git-restore-artifacts-");
    const supportRoot = await temporaryRoot("456code-exact-git-restore-filter-");
    const filterMarker = NodePath.join(supportRoot, "filter-ran");
    const filter = NodePath.join(supportRoot, "required-filter.sh");
    const indexPath = NodePath.join(artifactRoot, "snapshot.index");
    await NodeFSP.writeFile(
      filter,
      ["#!/bin/sh", 'printf ran >> "$T3_EXACT_GIT_FILTER_MARKER"', "exit 97", ""].join("\n"),
      { mode: 0o755 },
    );
    await git(repositoryRoot, ["init"]);
    await git(repositoryRoot, ["config", "user.email", "exact-restore@example.com"]);
    await git(repositoryRoot, ["config", "user.name", "Exact Restore Test"]);
    await NodeFSP.writeFile(
      NodePath.join(repositoryRoot, ".gitattributes"),
      "*.txt filter=required text eol=crlf\n",
    );
    await NodeFSP.writeFile(NodePath.join(repositoryRoot, ".gitignore"), "ignored.txt\n");
    await NodeFSP.writeFile(NodePath.join(repositoryRoot, "tracked.txt"), "committed\n");
    await git(repositoryRoot, ["add", "."]);
    await git(repositoryRoot, ["commit", "-m", "initial"]);
    await git(repositoryRoot, ["config", "filter.required.clean", filter]);
    await git(repositoryRoot, ["config", "filter.required.smudge", filter]);
    await git(repositoryRoot, ["config", "filter.required.required", "true"]);

    const previousMarker = process.env.T3_EXACT_GIT_FILTER_MARKER;
    process.env.T3_EXACT_GIT_FILTER_MARKER = filterMarker;
    try {
      const userIndexPath = NodePath.join(repositoryRoot, ".git", "index");
      const indexBefore = await NodeFSP.readFile(userIndexPath);
      await NodeFSP.writeFile(
        NodePath.join(repositoryRoot, "tracked.txt"),
        Buffer.from("target raw\r\n"),
      );
      const snapshot = await captureExactGitSnapshot({
        repositoryRoot,
        indexPath,
        signal: new AbortController().signal,
      });
      await NodeFSP.writeFile(NodePath.join(repositoryRoot, "tracked.txt"), "mutated\n");
      await NodeFSP.writeFile(NodePath.join(repositoryRoot, "extra.txt"), "remove me\n");
      await NodeFSP.writeFile(NodePath.join(repositoryRoot, "ignored.txt"), "preserve me\n");

      const restored = await restoreExactGitTree({
        repositoryRoot,
        treeOid: snapshot.treeOid,
        signal: new AbortController().signal,
      });

      expect(restored).toEqual({
        treeOid: snapshot.treeOid,
        fileCount: snapshot.fileCount,
        byteCount: snapshot.byteCount,
      });
      await expect(NodeFSP.readFile(NodePath.join(repositoryRoot, "tracked.txt"))).resolves.toEqual(
        Buffer.from("target raw\r\n"),
      );
      await expect(
        NodeFSP.access(NodePath.join(repositoryRoot, "extra.txt")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        NodeFSP.readFile(NodePath.join(repositoryRoot, "ignored.txt"), "utf8"),
      ).resolves.toBe("preserve me\n");
      await expect(NodeFSP.access(filterMarker)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(NodeFSP.readFile(userIndexPath)).resolves.toEqual(indexBefore);
    } finally {
      if (previousMarker === undefined) {
        delete process.env.T3_EXACT_GIT_FILTER_MARKER;
      } else {
        process.env.T3_EXACT_GIT_FILTER_MARKER = previousMarker;
      }
    }
  });

  it("admits clean gitlinks and rejects dirty submodules", async () => {
    const submoduleRoot = await temporaryRoot("456code-exact-git-submodule-");
    await git(submoduleRoot, ["init"]);
    await git(submoduleRoot, ["config", "user.email", "submodule@example.com"]);
    await git(submoduleRoot, ["config", "user.name", "Submodule Test"]);
    await NodeFSP.writeFile(NodePath.join(submoduleRoot, "source.txt"), "clean\n");
    await git(submoduleRoot, ["add", "."]);
    await git(submoduleRoot, ["commit", "-m", "initial"]);

    const repositoryRoot = await temporaryRoot("456code-exact-git-superproject-");
    const artifactRoot = await temporaryRoot("456code-exact-git-submodule-artifacts-");
    const destinationRoot = await temporaryRoot("456code-exact-git-submodule-materialized-");
    await git(repositoryRoot, ["init"]);
    await git(repositoryRoot, ["config", "user.email", "superproject@example.com"]);
    await git(repositoryRoot, ["config", "user.name", "Superproject Test"]);
    await git(repositoryRoot, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      submoduleRoot,
      "modules/child",
    ]);
    await git(repositoryRoot, ["commit", "-m", "add submodule"]);

    const snapshot = await captureExactGitSnapshot({
      repositoryRoot,
      indexPath: NodePath.join(artifactRoot, "clean.index"),
      signal: new AbortController().signal,
    });
    await materializeExactGitTree({
      repositoryRoot,
      treeOid: snapshot.treeOid,
      destinationRoot,
      signal: new AbortController().signal,
    });
    await expect(
      NodeFSP.readdir(NodePath.join(destinationRoot, "modules", "child")),
    ).resolves.toEqual([]);

    await NodeFSP.writeFile(
      NodePath.join(repositoryRoot, "modules", "child", "source.txt"),
      "dirty\n",
    );
    const dirtyIndexPath = NodePath.join(artifactRoot, "dirty.index");
    await expect(
      captureExactGitSnapshot({
        repositoryRoot,
        indexPath: dirtyIndexPath,
        signal: new AbortController().signal,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "dirty-submodule",
        name: "ExactGitSnapshotError",
      }),
    );
    await expect(NodeFSP.access(dirtyIndexPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.runIf(hasPosixPaths)(
    "cancels a bounded Git child and always removes its temporary index",
    async () => {
      const { repositoryRoot } = await initializeRepository();
      await NodeFSP.writeFile(NodePath.join(repositoryRoot, "tracked.txt"), "capture me\n");
      const artifactRoot = await temporaryRoot("456code-exact-git-cancel-artifacts-");
      const wrapperRoot = await temporaryRoot("456code-exact-git-wrapper-");
      const markerPath = NodePath.join(wrapperRoot, "fast-import-started");
      const indexPath = NodePath.join(artifactRoot, "snapshot.index");
      const realGit = (await execFile("which", ["git"], { encoding: "utf8" })).stdout.trim();
      const wrapperPath = NodePath.join(wrapperRoot, "git");
      await NodeFSP.writeFile(
        wrapperPath,
        [
          "#!/bin/sh",
          'if [ "$3" = "fast-import" ]; then',
          '  : > "$T3_EXACT_GIT_CANCEL_MARKER"',
          "  exec sleep 60",
          "fi",
          'exec "$T3_EXACT_GIT_REAL_GIT" "$@"',
          "",
        ].join("\n"),
        { mode: 0o755 },
      );

      const previousPath = process.env.PATH;
      const previousGit = process.env.T3_EXACT_GIT_REAL_GIT;
      const previousMarker = process.env.T3_EXACT_GIT_CANCEL_MARKER;
      process.env.PATH = `${wrapperRoot}${NodePath.delimiter}${previousPath ?? ""}`;
      process.env.T3_EXACT_GIT_REAL_GIT = realGit;
      process.env.T3_EXACT_GIT_CANCEL_MARKER = markerPath;
      const controller = new AbortController();
      try {
        const capture = captureExactGitSnapshot({
          repositoryRoot,
          indexPath,
          signal: controller.signal,
        });
        await waitForPath(markerPath);
        await expect(NodeFSP.access(indexPath)).resolves.toBeUndefined();
        controller.abort();

        await expect(capture).rejects.toEqual(
          expect.objectContaining({
            code: "cancelled",
            name: "ExactGitSnapshotError",
          }),
        );
        await expect(NodeFSP.access(indexPath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(NodeFSP.access(`${indexPath}.lock`)).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        if (previousPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = previousPath;
        }
        if (previousGit === undefined) {
          delete process.env.T3_EXACT_GIT_REAL_GIT;
        } else {
          process.env.T3_EXACT_GIT_REAL_GIT = previousGit;
        }
        if (previousMarker === undefined) {
          delete process.env.T3_EXACT_GIT_CANCEL_MARKER;
        } else {
          process.env.T3_EXACT_GIT_CANCEL_MARKER = previousMarker;
        }
      }
    },
  );
});
