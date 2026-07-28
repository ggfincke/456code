// tests/apps/server/proposal/ProposalService.test.ts
// verifies exact immutable proposals without mutating the user worktree or index
// @effect-diagnostics nodeBuiltinImport:off

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import type * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeUtil from "node:util";

import { it } from "@effect/vitest";
import {
  EnvironmentId,
  PROPOSAL_MAX_FILE_BYTES,
  PROPOSAL_MAX_TOTAL_CONTENT_BYTES,
  ProjectId,
  ProposalError,
  ProposalId,
  ProposalRevisionId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect } from "vite-plus/test";

import { SqlitePersistenceMemory } from "../../../../apps/server/src/persistence/Layers/Sqlite.ts";
import * as ProposalGitEngine from "../../../../apps/server/src/proposal/ProposalGitEngine.ts";
import * as ProposalRepository from "../../../../apps/server/src/proposal/ProposalRepository.ts";
import * as ProposalService from "../../../../apps/server/src/proposal/ProposalService.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const TestLayer = ProposalService.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory));

async function git(cwd: string, args: ReadonlyArray<string>): Promise<string> {
  const result = await execFile("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  return result.stdout.trim();
}

async function gitExitCode(cwd: string, args: ReadonlyArray<string>): Promise<number> {
  try {
    await git(cwd, args);
    return 0;
  } catch (cause) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      typeof cause.code === "number"
    ) {
      return cause.code;
    }
    throw cause;
  }
}

function gitBytes(cwd: string, args: ReadonlyArray<string>): Buffer {
  return NodeChildProcess.execFileSync("git", ["-C", cwd, ...args], {
    maxBuffer: 20 * 1024 * 1024,
  });
}

async function proposalRefFiles(cwd: string): Promise<ReadonlyArray<string>> {
  const refsRoot = NodePath.join(cwd, ".git", "refs", "t3", "proposals");
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries: ReadonlyArray<NodeFS.Dirent>;
    try {
      entries = await NodeFSP.readdir(directory, { withFileTypes: true });
    } catch (cause) {
      if (
        typeof cause === "object" &&
        cause !== null &&
        "code" in cause &&
        cause.code === "ENOENT"
      ) {
        return;
      }
      throw cause;
    }
    for (const entry of entries) {
      const absolutePath = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile()) {
        files.push(absolutePath);
      }
    }
  };
  await visit(refsRoot);
  return files.toSorted();
}

async function initializeRepository(prefix: string): Promise<string> {
  const cwd = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix));
  await git(cwd, ["init"]);
  await git(cwd, ["config", "user.email", "proposal-test@example.com"]);
  await git(cwd, ["config", "user.name", "Proposal Test"]);
  await NodeFSP.writeFile(NodePath.join(cwd, ".gitignore"), "*.ignored\n");
  await NodeFSP.writeFile(NodePath.join(cwd, "modify.txt"), "committed\n");
  await NodeFSP.writeFile(NodePath.join(cwd, "delete.txt"), "delete-only\n");
  await NodeFSP.writeFile(NodePath.join(cwd, "rename.txt"), "rename-only\n");
  await git(cwd, ["add", "."]);
  await git(cwd, ["commit", "-m", "initial"]);
  return cwd;
}

function sha256(value: string | Uint8Array): string {
  return NodeCrypto.createHash("sha256").update(value).digest("hex");
}

const scope = {
  environmentId: EnvironmentId.make("environment-proposal-test"),
  projectId: ProjectId.make("project-proposal-test"),
  sourceThreadId: ThreadId.make("thread-proposal-test"),
  producer: {
    providerSessionId: "provider-session-proposal-test",
    providerInstanceId: ProviderInstanceId.make("codex-test"),
  },
} as const;

it.layer(TestLayer)("ProposalService", (it) => {
  describe("admission bounds", () => {
    it.effect("rejects cumulative typed content before Git writes submitted blobs", () =>
      Effect.gen(function* () {
        const cwd = yield* Effect.acquireRelease(
          Effect.promise(() => initializeRepository("456code-proposal-admission-")),
          (directory) =>
            Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })).pipe(
              Effect.ignore,
            ),
        );
        const service = yield* ProposalService.ProposalService;
        const objectsBefore = yield* Effect.promise(() => git(cwd, ["count-objects", "-v"]));
        const fullFile = "x".repeat(PROPOSAL_MAX_FILE_BYTES);
        const operations = Array.from(
          { length: PROPOSAL_MAX_TOTAL_CONTENT_BYTES / PROPOSAL_MAX_FILE_BYTES },
          (_, index) => ({
            _tag: "add" as const,
            path: `bounded-${index}.txt`,
            content: { encoding: "utf8" as const, data: fullFile },
          }),
        );
        operations.push({
          _tag: "add",
          path: "over-limit.txt",
          content: { encoding: "utf8", data: "!" },
        });

        const rejected = yield* service
          .upsert({
            ...scope,
            proposalId: ProposalId.make("proposal-cumulative-admission"),
            cwd,
            changes: { _tag: "typed", operations },
          })
          .pipe(Effect.flip);

        expect(rejected.code).toBe("limit-exceeded");
        expect(rejected.detail).toContain(
          `Typed proposal content is ${PROPOSAL_MAX_TOTAL_CONTENT_BYTES + 1} bytes`,
        );
        expect(yield* Effect.promise(() => git(cwd, ["count-objects", "-v"]))).toBe(objectsBefore);
        expect(yield* Effect.promise(() => git(cwd, ["for-each-ref", "refs/t3/proposals"]))).toBe(
          "",
        );
      }),
    );
  });

  describe("interruption cleanup", () => {
    it.effect("deletes retained refs when persistence is interrupted", () =>
      Effect.gen(function* () {
        const cwd = yield* Effect.acquireRelease(
          Effect.promise(() => initializeRepository("456code-proposal-interruption-")),
          (directory) =>
            Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })).pipe(
              Effect.ignore,
            ),
        );
        const gitEngine = yield* ProposalGitEngine.make;
        const unsupportedRepositoryCall = () => Effect.die("unexpected repository call");
        const hangingRepository = ProposalRepository.ProposalRepository.of({
          append: () => Effect.never,
          list: unsupportedRepositoryCall,
          get: () =>
            new ProposalError({
              operation: "ProposalService.test.hangingRepository.get",
              code: "not-found",
              detail: "The interrupted proposal was not committed.",
              proposalId: ProposalId.make("proposal-interrupted-append"),
            }),
          findLatestByPlan: unsupportedRepositoryCall,
          readBlob: unsupportedRepositoryCall,
        });
        const service = yield* ProposalService.make.pipe(
          Effect.provideService(ProposalGitEngine.ProposalGitEngine, gitEngine),
          Effect.provideService(ProposalRepository.ProposalRepository, hangingRepository),
        );
        const upsertFiber = yield* service
          .upsert({
            ...scope,
            proposalId: ProposalId.make("proposal-interrupted-append"),
            cwd,
            changes: {
              _tag: "typed",
              operations: [
                {
                  _tag: "add",
                  path: "interrupted.txt",
                  content: { encoding: "utf8", data: "never-persisted\n" },
                },
              ],
            },
          })
          .pipe(Effect.forkScoped);

        let retainedRefs: ReadonlyArray<string> = [];
        for (let attempt = 0; attempt < 200; attempt += 1) {
          retainedRefs = yield* Effect.promise(() => proposalRefFiles(cwd));
          if (retainedRefs.length === 2) break;
          yield* Effect.promise(() => NodeTimersPromises.setTimeout(10));
        }
        expect(retainedRefs).toHaveLength(2);

        yield* Fiber.interrupt(upsertFiber);

        expect(yield* Effect.promise(() => proposalRefFiles(cwd))).toEqual([]);
      }),
    );

    it.effect("rolls back persistence before deleting refs on readback failure", () =>
      Effect.gen(function* () {
        const cwd = yield* Effect.acquireRelease(
          Effect.promise(() => initializeRepository("456code-proposal-readback-")),
          (directory) =>
            Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })).pipe(
              Effect.ignore,
            ),
        );
        const proposalId = ProposalId.make("proposal-readback-rollback");
        const realGitEngine = yield* ProposalGitEngine.make;
        const prepared = yield* realGitEngine.prepare({
          cwd,
          proposalId,
          revisionId: ProposalRevisionId.make("revision-readback-rollback"),
          changes: {
            _tag: "typed",
            operations: [
              {
                _tag: "add",
                path: "readback.txt",
                content: { encoding: "utf8", data: "must-roll-back\n" },
              },
            ],
          },
        });
        const corruptingGitEngine = ProposalGitEngine.ProposalGitEngine.of({
          prepare: () =>
            Effect.succeed({
              ...prepared,
              manifestJson: `${prepared.manifestJson} `,
            }),
          deleteRetainedRefs: realGitEngine.deleteRetainedRefs,
        });
        const repository = yield* ProposalRepository.make;
        const service = yield* ProposalService.make.pipe(
          Effect.provideService(ProposalGitEngine.ProposalGitEngine, corruptingGitEngine),
          Effect.provideService(ProposalRepository.ProposalRepository, repository),
        );
        const sql = yield* SqlClient.SqlClient;

        const rejected = yield* service
          .upsert({
            ...scope,
            proposalId,
            cwd,
            changes: {
              _tag: "typed",
              operations: [
                {
                  _tag: "add",
                  path: "ignored-by-test-engine.txt",
                  content: { encoding: "utf8", data: "ignored\n" },
                },
              ],
            },
          })
          .pipe(Effect.flip);

        expect(rejected.code).toBe("persistence-failed");
        expect(rejected.detail).toContain("content hash check");
        const proposalRows = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM proposals WHERE proposal_id = ${proposalId}
        `;
        const revisionRows = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM proposal_revisions WHERE proposal_id = ${proposalId}
        `;
        expect(proposalRows[0]?.count).toBe(0);
        expect(revisionRows[0]?.count).toBe(0);
        expect(yield* Effect.promise(() => proposalRefFiles(cwd))).toEqual([]);
      }),
    );
  });

  describe("immutable exact revisions", () => {
    it.effect("normalizes typed and unified inputs while preserving user state", () =>
      Effect.gen(function* () {
        const cwd = yield* Effect.acquireRelease(
          Effect.promise(() => initializeRepository("456code-proposal-service-")),
          (directory) =>
            Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })).pipe(
              Effect.ignore,
            ),
        );
        const service = yield* ProposalService.ProposalService;
        const sql = yield* SqlClient.SqlClient;

        yield* Effect.promise(async () => {
          await NodeFSP.writeFile(NodePath.join(cwd, "modify.txt"), "staged-only\n");
          await git(cwd, ["add", "modify.txt"]);
          await NodeFSP.writeFile(NodePath.join(cwd, "modify.txt"), "working-tree\n");
          await NodeFSP.writeFile(NodePath.join(cwd, "untracked.txt"), "untracked-only\n");
          await NodeFSP.writeFile(NodePath.join(cwd, "secret.ignored"), "ignored-only\n");
        });

        const indexPath = NodePath.join(cwd, ".git", "index");
        const indexBefore = yield* Effect.promise(() => NodeFSP.readFile(indexPath));
        const statusBefore = yield* Effect.promise(() =>
          git(cwd, ["status", "--porcelain=v1", "-z"]),
        );
        const cachedDiffBefore = yield* Effect.promise(() =>
          git(cwd, ["diff", "--cached", "--binary"]),
        );
        const proposalId = ProposalId.make("proposal-exact-integrity");
        const narrativeMdx = [
          "# Exact proposal",
          "",
          '<FileReference path="modify.txt" />',
          "",
        ].join("\n");

        const first = yield* service.upsert({
          ...scope,
          proposalId,
          cwd,
          planId: "plan-exact-integrity",
          narrativeMdx,
          changes: {
            _tag: "typed",
            operations: [
              {
                _tag: "modify",
                path: "modify.txt",
                beforeSha256: sha256("working-tree\n") as never,
                content: { encoding: "utf8", data: "proposed-change\n" },
              },
              {
                _tag: "delete",
                path: "delete.txt",
                beforeSha256: sha256("delete-only\n") as never,
              },
              {
                _tag: "rename",
                fromPath: "rename.txt",
                toPath: "moved.txt",
                beforeSha256: sha256("rename-only\n") as never,
              },
              {
                _tag: "add",
                path: "added.txt",
                content: { encoding: "utf8", data: "added-only\n" },
              },
            ],
          },
        });

        const indexAfter = yield* Effect.promise(() => NodeFSP.readFile(indexPath));
        expect(indexAfter.equals(indexBefore)).toBe(true);
        expect(
          yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(cwd, "modify.txt"), "utf8")),
        ).toBe("working-tree\n");
        expect(
          yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(cwd, "delete.txt"), "utf8")),
        ).toBe("delete-only\n");
        expect(
          yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(cwd, "rename.txt"), "utf8")),
        ).toBe("rename-only\n");
        expect(
          yield* Effect.promise(() =>
            NodeFSP.access(NodePath.join(cwd, "added.txt")).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false);
        expect(yield* Effect.promise(() => git(cwd, ["status", "--porcelain=v1", "-z"]))).toBe(
          statusBefore,
        );
        expect(yield* Effect.promise(() => git(cwd, ["diff", "--cached", "--binary"]))).toBe(
          cachedDiffBefore,
        );

        expect(first.revision).toBe(1);
        expect(first.narrativeSha256).toBe(sha256(narrativeMdx));
        expect(first.narrativeByteLength).toBe(Buffer.byteLength(narrativeMdx, "utf8"));
        expect(yield* service.narrative({ proposalId, revision: 1 })).toEqual({
          proposalId,
          revisionId: first.revisionId,
          revision: 1,
          source: narrativeMdx,
          sourceSha256: sha256(narrativeMdx),
        });
        expect(first.manifest.operations.map((operation) => operation._tag).toSorted()).toEqual([
          "add",
          "delete",
          "modify",
          "rename",
        ]);
        expect(first.baseSnapshot.policy.staging).toBe("flattened");
        expect(
          yield* Effect.promise(() =>
            git(cwd, ["show", `${first.baseSnapshot.workingTreeOid}:modify.txt`]),
          ),
        ).toBe("working-tree");
        expect(
          yield* Effect.promise(() =>
            git(cwd, ["show", `${first.baseSnapshot.workingTreeOid}:untracked.txt`]),
          ),
        ).toBe("untracked-only");
        expect(
          yield* Effect.promise(() =>
            gitExitCode(cwd, [
              "cat-file",
              "-e",
              `${first.baseSnapshot.workingTreeOid}:secret.ignored`,
            ]),
          ),
        ).not.toBe(0);
        expect(
          yield* Effect.promise(() =>
            git(cwd, ["rev-parse", `${first.baseSnapshot.retainedRef}^{tree}`]),
          ),
        ).toBe(first.baseSnapshot.workingTreeOid);
        expect(
          yield* Effect.promise(() =>
            git(cwd, ["rev-parse", `${first.proposedRetainedRef}^{tree}`]),
          ),
        ).toBe(first.proposedTreeOid);

        const firstDiff = yield* service.diff({ proposalId, revision: 1 });
        expect(firstDiff.diff).toContain("diff --git a/modify.txt b/modify.txt");
        expect(firstDiff.diff).toContain("diff --git a/rename.txt b/moved.txt");
        expect(firstDiff.diff).toMatch(/^index [0-9a-f]{40,64}\.\.[0-9a-f]{40,64}/m);
        expect(firstDiff.diffSha256).toBe(sha256(firstDiff.diff));

        const second = yield* service.upsert({
          ...scope,
          proposalId,
          cwd,
          planId: "plan-exact-integrity",
          changes: {
            _tag: "unified-diff",
            diff: [
              "diff --git a/modify.txt b/modify.txt",
              "--- a/modify.txt",
              "+++ b/modify.txt",
              "@@ -1 +1 @@",
              "-working-tree",
              "+second-proposal",
              "",
            ].join("\n"),
          },
        });

        expect(second.revision).toBe(2);
        expect(second.manifest.operations).toHaveLength(1);
        expect(second.manifest.operations[0]?._tag).toBe("modify");
        const stored = yield* service.get({ proposalId });
        expect(stored.proposal.latestRevision).toBe(2);
        expect(stored.revisions.map((revision) => revision.revision)).toEqual([1, 2]);
        expect(stored.revisions[0]).toEqual(first);
        expect((yield* service.diff({ proposalId, revision: 2 })).diff).toContain(
          "+second-proposal",
        );
        expect(yield* service.narrative({ proposalId, revision: 2 })).toBeNull();
        expect(
          (yield* service.findLatestByPlan({
            sourceThreadId: scope.sourceThreadId,
            planId: "plan-exact-integrity",
          }))?.revision.revision,
        ).toBe(2);

        const rejected = yield* service
          .upsert({
            ...scope,
            proposalId,
            cwd,
            changes: {
              _tag: "typed",
              operations: [
                {
                  _tag: "modify",
                  path: "modify.txt",
                  beforeSha256: "0".repeat(64) as never,
                  content: { encoding: "utf8", data: "must-not-apply\n" },
                },
              ],
            },
          })
          .pipe(Effect.flip);
        expect(rejected.code).toBe("before-hash-mismatch");
        expect((yield* service.get({ proposalId })).proposal.latestRevision).toBe(2);
        expect((yield* Effect.promise(() => NodeFSP.readFile(indexPath))).equals(indexBefore)).toBe(
          true,
        );

        yield* sql`
          UPDATE proposal_revisions
          SET manifest_json = '{"version":"v1","operations":[],"operationCount":0,"changedFileCount":0,"changedContentBytes":0}'
          WHERE revision_id = ${first.revisionId}
        `;
        const corrupted = yield* service.get({ proposalId }).pipe(Effect.flip);
        expect(corrupted.code).toBe("persistence-failed");
        expect(corrupted.detail).toContain("failed its content hash check");
      }),
    );
  });

  describe("snapshot policy", () => {
    it.effect("captures raw working-tree bytes without invoking required Git filters", () =>
      Effect.gen(function* () {
        const cwd = yield* Effect.acquireRelease(
          Effect.promise(() => initializeRepository("456code-proposal-raw-bytes-")),
          (directory) =>
            Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })).pipe(
              Effect.ignore,
            ),
        );
        const service = yield* ProposalService.ProposalService;
        const rawBase = Buffer.from("working\r\nbytes\r\n");
        const rawProposed = Buffer.from("proposed\r\nbytes\r\n");

        yield* Effect.promise(async () => {
          await NodeFSP.writeFile(
            NodePath.join(cwd, ".gitattributes"),
            "filtered.txt filter=sentinel text eol=crlf\n",
          );
          await NodeFSP.writeFile(NodePath.join(cwd, "filtered.txt"), "committed\n");
          await git(cwd, ["add", ".gitattributes", "filtered.txt"]);
          await git(cwd, ["commit", "-m", "add filtered fixture"]);
          await git(cwd, ["config", "filter.sentinel.clean", "false"]);
          await git(cwd, ["config", "filter.sentinel.smudge", "false"]);
          await git(cwd, ["config", "filter.sentinel.required", "true"]);
          await NodeFSP.writeFile(NodePath.join(cwd, "filtered.txt"), rawBase);
        });

        const indexPath = NodePath.join(cwd, ".git", "index");
        const indexBefore = yield* Effect.promise(() => NodeFSP.readFile(indexPath));
        const revision = yield* service.upsert({
          ...scope,
          proposalId: ProposalId.make("proposal-raw-working-tree-bytes"),
          cwd,
          changes: {
            _tag: "typed",
            operations: [
              {
                _tag: "modify",
                path: "filtered.txt",
                beforeSha256: sha256(rawBase) as never,
                content: {
                  encoding: "base64",
                  data: rawProposed.toString("base64"),
                },
              },
            ],
          },
        });

        expect(
          gitBytes(cwd, [
            "cat-file",
            "blob",
            `${revision.baseSnapshot.workingTreeOid}:filtered.txt`,
          ]),
        ).toEqual(rawBase);
        expect(
          gitBytes(cwd, ["cat-file", "blob", `${revision.proposedTreeOid}:filtered.txt`]),
        ).toEqual(rawProposed);
        expect(yield* Effect.promise(() => NodeFSP.readFile(indexPath))).toEqual(indexBefore);
        expect(
          yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(cwd, "filtered.txt"))),
        ).toEqual(rawBase);
      }),
    );

    it.effect("rejects a dirty submodule before retaining or persisting a revision", () =>
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() =>
            NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "456code-submodule-")),
          ),
          (directory) =>
            Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })).pipe(
              Effect.ignore,
            ),
        );
        const child = NodePath.join(root, "child");
        const parent = NodePath.join(root, "parent");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(child);
          await git(child, ["init"]);
          await git(child, ["config", "user.email", "proposal-test@example.com"]);
          await git(child, ["config", "user.name", "Proposal Test"]);
          await NodeFSP.writeFile(NodePath.join(child, "child.txt"), "clean\n");
          await git(child, ["add", "."]);
          await git(child, ["commit", "-m", "child"]);

          await NodeFSP.mkdir(parent);
          await git(parent, ["init"]);
          await git(parent, ["config", "user.email", "proposal-test@example.com"]);
          await git(parent, ["config", "user.name", "Proposal Test"]);
          await NodeFSP.writeFile(NodePath.join(parent, "README.md"), "parent\n");
          await git(parent, ["add", "."]);
          await git(parent, ["commit", "-m", "parent"]);
          await git(parent, ["-c", "protocol.file.allow=always", "submodule", "add", child, "sub"]);
          await git(parent, ["commit", "-am", "add submodule"]);
          await NodeFSP.writeFile(NodePath.join(parent, "sub", "child.txt"), "dirty\n");
        });

        const service = yield* ProposalService.ProposalService;
        const rejected = yield* service
          .upsert({
            ...scope,
            proposalId: ProposalId.make("proposal-dirty-submodule"),
            cwd: parent,
            changes: {
              _tag: "typed",
              operations: [
                {
                  _tag: "add",
                  path: "added.txt",
                  content: { encoding: "utf8", data: "never-created\n" },
                },
              ],
            },
          })
          .pipe(Effect.flip);

        expect(rejected.code).toBe("dirty-submodule");
      }),
    );

    it.effect(
      "rejects unified patches whose retained tree contains an unsupported type change",
      () =>
        Effect.gen(function* () {
          const cwd = yield* Effect.acquireRelease(
            Effect.promise(() => initializeRepository("456code-proposal-type-change-")),
            (directory) =>
              Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })).pipe(
                Effect.ignore,
              ),
          );
          const unifiedDiff = yield* Effect.promise(async () => {
            const target = NodePath.join(cwd, "modify.txt");
            await NodeFSP.unlink(target);
            await NodeFSP.symlink("delete.txt", target);
            const diff = await git(cwd, ["diff", "--binary", "--full-index", "--", "modify.txt"]);
            await git(cwd, ["restore", "--source=HEAD", "--worktree", "--", "modify.txt"]);
            return `${diff}\n`;
          });
          const service = yield* ProposalService.ProposalService;
          const rejected = yield* service
            .upsert({
              ...scope,
              proposalId: ProposalId.make("proposal-unsupported-type-change"),
              cwd,
              changes: { _tag: "unified-diff", diff: unifiedDiff },
            })
            .pipe(Effect.flip);

          expect(rejected.code).toBe("unsupported-file-mode");
        }),
    );
  });
});
