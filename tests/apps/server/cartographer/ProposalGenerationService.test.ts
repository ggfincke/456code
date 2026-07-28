// tests/apps/server/cartographer/ProposalGenerationService.test.ts
// verifies exact bounded proposal-tree analysis and visible lifecycle freshness
// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeUtil from "node:util";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProposalGenerationId,
  ProposalId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect } from "vite-plus/test";

import * as ServerConfig from "../../../../apps/server/src/config.ts";
import { SqlitePersistenceMemory } from "../../../../apps/server/src/persistence/Layers/Sqlite.ts";
import * as ProcessRunner from "../../../../apps/server/src/processRunner.ts";
import * as ProposalGenerationService from "../../../../apps/server/src/proposal/ProposalGenerationService.ts";
import * as ProposalService from "../../../../apps/server/src/proposal/ProposalService.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

async function git(cwd: string, args: ReadonlyArray<string>): Promise<string> {
  const result = await execFile("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  return result.stdout.trim();
}

async function initializeRepository(): Promise<string> {
  const cwd = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "456code-proposal-generation-workspace-"),
  );
  await git(cwd, ["init"]);
  await git(cwd, ["config", "user.email", "generation-test@example.com"]);
  await git(cwd, ["config", "user.name", "Generation Test"]);
  const submoduleRoot = NodePath.join(cwd, "submodule");
  await NodeFSP.mkdir(submoduleRoot);
  await git(submoduleRoot, ["init"]);
  await git(submoduleRoot, ["config", "user.email", "generation-test@example.com"]);
  await git(submoduleRoot, ["config", "user.name", "Generation Test"]);
  await NodeFSP.writeFile(NodePath.join(submoduleRoot, "nested.txt"), "submodule-base\n");
  await git(submoduleRoot, ["add", "."]);
  await git(submoduleRoot, ["commit", "-m", "submodule initial"]);
  await NodeFSP.writeFile(
    NodePath.join(cwd, ".gitattributes"),
    "target.txt filter=sentinel text eol=crlf\n",
  );
  await NodeFSP.writeFile(NodePath.join(cwd, "target.txt"), "committed-base\n");
  await git(cwd, ["add", "."]);
  await git(cwd, ["commit", "-m", "initial"]);
  await git(cwd, ["config", "filter.sentinel.clean", "false"]);
  await git(cwd, ["config", "filter.sentinel.smudge", "false"]);
  await git(cwd, ["config", "filter.sentinel.required", "true"]);
  await NodeFSP.writeFile(NodePath.join(cwd, "target.txt"), Buffer.from("working-base\r\n"));
  return cwd;
}

function useEnvironment(values: Readonly<Record<string, string>>) {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const previous = new Map<string, string | undefined>();
      for (const [name, value] of Object.entries(values)) {
        previous.set(name, process.env[name]);
        process.env[name] = value;
      }
      return previous;
    }),
    (previous) =>
      Effect.sync(() => {
        for (const [name, value] of previous) {
          if (value === undefined) {
            delete process.env[name];
          } else {
            process.env[name] = value;
          }
        }
      }),
  );
}

function sha256(value: string | Uint8Array): string {
  return NodeCrypto.createHash("sha256").update(value).digest("hex");
}

async function pathExists(path: string): Promise<boolean> {
  return NodeFSP.access(path).then(
    () => true,
    () => false,
  );
}

async function fingerprintDist(distRoot: string): Promise<string> {
  const entries = (await NodeFSP.readdir(distRoot, { recursive: true })).sort();
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const absolutePath = NodePath.join(distRoot, entry);
    if (!(await NodeFSP.stat(absolutePath)).isFile()) continue;
    const bytes = await NodeFSP.readFile(absolutePath);
    const normalizedPath = entry.split(NodePath.sep).join("/");
    parts.push(Buffer.from(`${normalizedPath}\0${bytes.byteLength}\0`, "utf8"), bytes);
  }
  return `sha256:${sha256(Buffer.concat(parts))}`;
}

describe("ProposalGenerationService", () => {
  it.effect("analyzes retained trees, terminalizes superseded work, and reports drift", () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* Effect.promise(initializeRepository);
      const baseDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "456code-proposal-generation-state-")),
      );
      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          Promise.all([
            NodeFSP.rm(workspaceRoot, { recursive: true, force: true }),
            NodeFSP.rm(baseDir, { recursive: true, force: true }),
          ]),
        ).pipe(Effect.ignore),
      );

      const analyzerDistRoot = NodePath.join(baseDir, "cartographer", "dist");
      const analyzerPath = NodePath.join(analyzerDistRoot, "cli", "index.js");
      const analyzerDependencyPath = NodePath.join(analyzerDistRoot, "runtime.js");
      const badIdentityMarker = NodePath.join(baseDir, "report-bad-analyzer-identity");
      const analyzerLifecycleLog = NodePath.join(baseDir, "analyzer-lifecycle.ndjson");
      const analyzerSource = [
        'import { access, appendFile, readFile, writeFile } from "node:fs/promises"',
        'import { setTimeout as delay } from "node:timers/promises"',
        "const args = process.argv.slice(2)",
        "if (args[0] !== 'analyze-trees') process.exit(64)",
        "const baseRoot = args[1]",
        "const proposedRoot = args[2]",
        "const flag = (name) => args[args.indexOf(name) + 1]",
        "const out = flag('--out')",
        "const analyzerVersion = flag('--analyzer-version')",
        "const lifecycleLog = process.env.T3_TEST_CARTOGRAPHER_ANALYZER_LOG",
        "await appendFile(lifecycleLog, `${JSON.stringify({ event: 'start', out })}\\n`)",
        "await delay(Number(process.env.T3_TEST_CARTOGRAPHER_ANALYZER_DELAY_MS || 0))",
        "const badIdentity = await access(process.env.T3_TEST_CARTOGRAPHER_BAD_IDENTITY_FILE).then(() => true, () => false)",
        "const baseContent = await readFile(`${baseRoot}/target.txt`, 'utf8')",
        "const proposedContent = await readFile(`${proposedRoot}/target.txt`, 'utf8')",
        "await writeFile(`${out}/base.graph.json`, JSON.stringify({ content: baseContent, gitRef: flag('--base-ref') }))",
        "await writeFile(`${out}/proposed.graph.json`, JSON.stringify({ content: proposedContent, gitRef: flag('--proposed-ref') }))",
        "await writeFile(`${out}/impact.json`, JSON.stringify({ baseGitRef: flag('--base-ref'), headGitRef: flag('--proposed-ref'), changed: baseContent !== proposedContent }))",
        "await appendFile(lifecycleLog, `${JSON.stringify({ event: 'end', out })}\\n`)",
        "console.log(JSON.stringify({",
        "  type: 'cartographer.analysis-ready',",
        "  version: 1,",
        "  analyzerVersion: badIdentity ? 'sha256:wrong-analyzer' : analyzerVersion,",
        "  baseGraph: 'base.graph.json',",
        "  proposedGraph: 'proposed.graph.json',",
        "  impact: 'impact.json'",
        "}))",
        "",
      ].join("\n");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.dirname(analyzerPath), { recursive: true });
        await Promise.all([
          NodeFSP.writeFile(analyzerPath, analyzerSource),
          NodeFSP.writeFile(analyzerDependencyPath, "runtime-v1\n"),
        ]);
      });
      yield* useEnvironment({
        T3CODE_CARTOGRAPHER_CLI: analyzerPath,
        T3_TEST_CARTOGRAPHER_ANALYZER_LOG: analyzerLifecycleLog,
        T3_TEST_CARTOGRAPHER_BAD_IDENTITY_FILE: badIdentityMarker,
        T3_TEST_CARTOGRAPHER_ANALYZER_DELAY_MS: "350",
      });

      const TestLayer = ProposalGenerationService.layer.pipe(
        Layer.provideMerge(ProposalService.layer),
        Layer.provideMerge(ProcessRunner.layer),
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provideMerge(ServerConfig.layerTest(workspaceRoot, baseDir)),
        Layer.provideMerge(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        const proposals = yield* ProposalService.ProposalService;
        const generations = yield* ProposalGenerationService.ProposalGenerationService;
        const sql = yield* SqlClient.SqlClient;
        const config = yield* ServerConfig.ServerConfig;
        const threadId = ThreadId.make("thread-generation-exact");
        const proposalId = ProposalId.make("proposal-generation-exact");
        const revision = yield* proposals.upsert({
          proposalId,
          environmentId: EnvironmentId.make("environment-generation-exact"),
          projectId: ProjectId.make("project-generation-exact"),
          sourceThreadId: threadId,
          producer: {
            providerSessionId: "provider-session-generation-exact",
            providerInstanceId: ProviderInstanceId.make("codex-generation"),
          },
          cwd: workspaceRoot,
          changes: {
            _tag: "typed",
            operations: [
              {
                _tag: "modify",
                path: "target.txt",
                beforeSha256: sha256("working-base\r\n") as never,
                content: { encoding: "utf8", data: "proposed-exact\r\n" },
              },
            ],
          },
        });

        const first = yield* generations.start({ threadId, proposalId, revision: 1 });
        expect(first.state).toBe("queued");
        const second = yield* generations.start({ threadId, proposalId, revision: 1 });
        expect(second.state).toBe("queued");

        const waitForTerminal = Effect.fn("ProposalGenerationService.test.waitForTerminal")(
          function* (generationThreadId: ThreadId, generationId: ProposalGenerationId) {
            for (let attempt = 0; attempt < 240; attempt += 1) {
              const generation = yield* generations.get({
                threadId: generationThreadId,
                generationId,
              });
              if (
                generation.state === "ready" ||
                generation.state === "failed" ||
                generation.state === "cancelled" ||
                generation.state === "abandoned"
              ) {
                return generation;
              }
              yield* Effect.promise(() => NodeTimersPromises.setTimeout(25));
            }
            return yield* Effect.die(`generation ${generationId} did not terminate`);
          },
        );

        const ready = yield* waitForTerminal(threadId, second.generationId);
        expect(ready.state).toBe("ready");
        expect(ready.authority).toBe("authoritative");
        expect(ready.freshness).toBe("fresh");
        expect(ready.workspaceSnapshotTreeOid).toBe(revision.baseSnapshot.workingTreeOid);
        expect(ready.analyzerVersion).toBe(
          yield* Effect.promise(() => fingerprintDist(analyzerDistRoot)),
        );
        expect(ready.baseGraphArtifact).toBeTruthy();
        expect(ready.proposedGraphArtifact).toBeTruthy();
        expect(ready.impactArtifact).toBeTruthy();

        const superseded = yield* waitForTerminal(threadId, first.generationId);
        expect(superseded.state).toBe("cancelled");
        expect(superseded.errorCode).toBe("superseded");
        const supersededArtifactRoot = NodePath.join(
          config.stateDir,
          "cartographer",
          "generations",
          first.generationId,
        );
        expect(yield* Effect.promise(() => pathExists(supersededArtifactRoot))).toBe(false);
        expect((yield* generations.latest({ threadId, proposalId }))?.generationId).toBe(
          second.generationId,
        );

        const artifactRoot = NodePath.join(
          config.stateDir,
          "cartographer",
          "generations",
          second.generationId,
        );
        const embedTarget = yield* generations.resolveEmbedTarget(threadId, second.generationId);
        expect(embedTarget.proposedRoot).toBe(NodePath.join(artifactRoot, "proposed"));
        expect(NodePath.basename(embedTarget.baseGraphPath)).toMatch(
          /^base\.graph\.[0-9a-f]{64}\.json$/u,
        );
        expect(NodePath.basename(embedTarget.proposedGraphPath)).toMatch(
          /^proposed\.graph\.[0-9a-f]{64}\.[0-9a-f]{64}\.json$/u,
        );
        expect(NodePath.basename(embedTarget.impactPath)).toMatch(/^impact\.[0-9a-f]{64}\.json$/u);
        const baseGraph = JSON.parse(
          yield* Effect.promise(() => NodeFSP.readFile(embedTarget.baseGraphPath, "utf8")),
        ) as { readonly content: string; readonly gitRef: string };
        const proposedGraph = JSON.parse(
          yield* Effect.promise(() => NodeFSP.readFile(embedTarget.proposedGraphPath, "utf8")),
        ) as { readonly content: string; readonly gitRef: string };
        expect(baseGraph).toEqual({
          content: "working-base\r\n",
          gitRef: revision.baseSnapshot.workingTreeOid,
        });
        expect(proposedGraph).toEqual({
          content: "proposed-exact\r\n",
          gitRef: revision.proposedTreeOid,
        });
        expect(
          yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(artifactRoot, "proposed", "target.txt"), "utf8"),
          ),
        ).toBe("proposed-exact\r\n");
        const originalBaseGraphBytes = yield* Effect.promise(() =>
          NodeFSP.readFile(embedTarget.baseGraphPath),
        );
        yield* Effect.promise(() =>
          NodeFSP.writeFile(embedTarget.baseGraphPath, '{"gitRef":"tampered"}'),
        );
        expect(
          (yield* generations.resolveEmbedTarget(threadId, second.generationId).pipe(Effect.flip))
            .failure,
        ).toBe("generation_not_found");
        yield* Effect.promise(() =>
          NodeFSP.writeFile(embedTarget.baseGraphPath, originalBaseGraphBytes),
        );

        const proposedTargetPath = NodePath.join(artifactRoot, "proposed", "target.txt");
        yield* Effect.promise(() => NodeFSP.writeFile(proposedTargetPath, "tampered-root\n"));
        expect(
          (yield* generations.resolveEmbedTarget(threadId, second.generationId).pipe(Effect.flip))
            .failure,
        ).toBe("generation_not_found");
        yield* Effect.promise(() =>
          NodeFSP.writeFile(proposedTargetPath, Buffer.from("proposed-exact\r\n")),
        );
        expect(
          (yield* generations.resolveEmbedTarget(threadId, second.generationId)).generation
            .generationId,
        ).toBe(second.generationId);

        const proposedRetainedCommitOid = yield* Effect.promise(() =>
          git(workspaceRoot, ["rev-parse", revision.proposedRetainedRef]),
        );
        const baseRetainedCommitOid = yield* Effect.promise(() =>
          git(workspaceRoot, ["rev-parse", revision.baseSnapshot.retainedRef]),
        );
        yield* Effect.promise(() =>
          git(workspaceRoot, ["update-ref", revision.proposedRetainedRef, baseRetainedCommitOid]),
        );
        expect(
          (yield* generations.resolveEmbedTarget(threadId, second.generationId).pipe(Effect.flip))
            .failure,
        ).toBe("generation_not_found");
        const movedRefGeneration = yield* generations.start({
          threadId,
          proposalId,
          revision: 1,
        });
        const movedRefFailure = yield* waitForTerminal(threadId, movedRefGeneration.generationId);
        yield* Effect.promise(() =>
          git(workspaceRoot, [
            "update-ref",
            revision.proposedRetainedRef,
            proposedRetainedCommitOid,
          ]),
        );
        expect(movedRefFailure.state).toBe("failed");
        expect(movedRefFailure.errorCode).toBe("materialization-failed");
        expect(
          yield* Effect.promise(() =>
            pathExists(
              NodePath.join(
                config.stateDir,
                "cartographer",
                "generations",
                movedRefGeneration.generationId,
              ),
            ),
          ),
        ).toBe(false);

        const relativeCliFailure = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* useEnvironment({
              T3CODE_CARTOGRAPHER_CLI: "relative/cartographer/dist/cli/index.js",
            });
            return yield* generations
              .start({
                threadId,
                proposalId,
                revision: 1,
              })
              .pipe(Effect.flip);
          }),
        );
        expect(relativeCliFailure._tag).toBe("ProposalGenerationError");
        if (relativeCliFailure._tag === "ProposalGenerationError") {
          expect(relativeCliFailure.failure).toBe("unsupported");
        }

        const relativeNodeFailure = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* useEnvironment({
              T3CODE_CARTOGRAPHER_CLI: analyzerPath,
              T3CODE_CARTOGRAPHER_NODE: "./node",
            });
            return yield* generations
              .start({
                threadId,
                proposalId,
                revision: 1,
              })
              .pipe(Effect.flip);
          }),
        );
        expect(relativeNodeFailure._tag).toBe("ProposalGenerationError");
        if (relativeNodeFailure._tag === "ProposalGenerationError") {
          expect(relativeNodeFailure.failure).toBe("unsupported");
        }

        yield* Effect.promise(() => NodeFSP.writeFile(badIdentityMarker, ""));
        const failedGeneration = yield* generations.start({
          threadId,
          proposalId,
          revision: 1,
        });
        const failed = yield* waitForTerminal(threadId, failedGeneration.generationId);
        yield* Effect.promise(() => NodeFSP.rm(badIdentityMarker, { force: true }));
        expect(failed.state).toBe("failed");
        expect(failed.errorCode).toBe("analysis-failed");
        expect(
          yield* Effect.promise(() =>
            pathExists(
              NodePath.join(
                config.stateDir,
                "cartographer",
                "generations",
                failedGeneration.generationId,
              ),
            ),
          ),
        ).toBe(false);
        expect(yield* Effect.promise(() => pathExists(artifactRoot))).toBe(true);

        const deletionRaceThreadId = ThreadId.make("thread-generation-deletion-race");
        const deletionRaceProposalId = ProposalId.make("proposal-generation-deletion-race");
        yield* proposals.upsert({
          proposalId: deletionRaceProposalId,
          environmentId: EnvironmentId.make("environment-generation-exact"),
          projectId: ProjectId.make("project-generation-exact"),
          sourceThreadId: deletionRaceThreadId,
          producer: {
            providerSessionId: "provider-session-generation-deletion-race",
            providerInstanceId: ProviderInstanceId.make("codex-generation"),
          },
          cwd: workspaceRoot,
          changes: {
            _tag: "typed",
            operations: [
              {
                _tag: "modify",
                path: "target.txt",
                beforeSha256: sha256("working-base\r\n") as never,
                content: { encoding: "utf8", data: "proposed-deletion-race\r\n" },
              },
            ],
          },
        });
        const racingStart = yield* generations
          .start({
            threadId: deletionRaceThreadId,
            proposalId: deletionRaceProposalId,
            revision: 1,
          })
          .pipe(
            Effect.match({
              onFailure: (error) => ({ _tag: "failure" as const, error }),
              onSuccess: (generation) => ({ _tag: "success" as const, generation }),
            }),
            Effect.forkScoped,
          );
        yield* generations.cancelThread(deletionRaceThreadId);
        const racingStartResult = yield* Fiber.join(racingStart);
        if (racingStartResult._tag === "success") {
          const cancelled = yield* waitForTerminal(
            deletionRaceThreadId,
            racingStartResult.generation.generationId,
          );
          expect(cancelled.state).toBe("cancelled");
          expect(cancelled.errorCode).toBe("thread-deleted");
        } else {
          expect(racingStartResult.error._tag).toBe("ProposalGenerationError");
          if (racingStartResult.error._tag === "ProposalGenerationError") {
            expect(racingStartResult.error.failure).toBe("scope-mismatch");
          }
        }
        const racingRows = yield* sql<{ readonly state: string }>`
          SELECT state
          FROM proposal_generations
          WHERE thread_id = ${deletionRaceThreadId}
        `;
        expect(racingRows.every((row) => row.state === "cancelled" || row.state === "failed")).toBe(
          true,
        );
        const racingRestart = yield* generations
          .start({
            threadId: deletionRaceThreadId,
            proposalId: deletionRaceProposalId,
            revision: 1,
          })
          .pipe(Effect.flip);
        expect(racingRestart._tag).toBe("ProposalGenerationError");

        const deletionGeneration = yield* generations.start({
          threadId,
          proposalId,
          revision: 1,
        });
        yield* generations.cancelThread(threadId);
        const deletionCancelled = yield* waitForTerminal(threadId, deletionGeneration.generationId);
        expect(deletionCancelled.state).toBe("cancelled");
        expect(deletionCancelled.errorCode).toBe("thread-deleted");
        expect(
          yield* Effect.promise(() =>
            pathExists(
              NodePath.join(
                config.stateDir,
                "cartographer",
                "generations",
                deletionGeneration.generationId,
              ),
            ),
          ),
        ).toBe(false);
        const deletedThreadRestart = yield* generations
          .start({ threadId, proposalId, revision: 1 })
          .pipe(Effect.flip);
        expect(deletedThreadRestart._tag).toBe("ProposalGenerationError");
        if (deletedThreadRestart._tag !== "ProposalGenerationError") {
          return yield* Effect.die("deleted generation restart returned the wrong error type");
        }
        expect(deletedThreadRestart.failure).toBe("scope-mismatch");

        yield* Effect.promise(() => NodeFSP.writeFile(analyzerDependencyPath, "runtime-v2\n"));
        expect(
          (yield* generations.get({ threadId, generationId: second.generationId })).freshness,
        ).toBe("analyzer-changed");
        yield* Effect.promise(() => NodeFSP.writeFile(analyzerDependencyPath, "runtime-v1\n"));

        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(workspaceRoot, "submodule", "nested.txt"),
            "submodule-drift\n",
          ),
        );
        expect(
          (yield* generations.get({ threadId, generationId: second.generationId })).freshness,
        ).toBe("worktree-changed");
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(workspaceRoot, "submodule", "nested.txt"),
            "submodule-base\n",
          ),
        );

        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(workspaceRoot, "target.txt"),
            Buffer.from("worktree-drift\r\n"),
          ),
        );
        expect(
          (yield* generations.get({ threadId, generationId: second.generationId })).freshness,
        ).toBe("worktree-changed");
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(workspaceRoot, "target.txt"),
            Buffer.from("working-base\r\n"),
          ),
        );

        yield* Effect.promise(() =>
          git(workspaceRoot, ["commit", "--allow-empty", "-m", "move head"]),
        );
        expect(
          (yield* generations.get({ threadId, generationId: second.generationId })).freshness,
        ).toBe("base-changed");

        const concurrencyInputs: Array<{
          readonly threadId: ThreadId;
          readonly proposalId: ProposalId;
        }> = [];
        for (let index = 0; index < 3; index += 1) {
          const concurrentThreadId = ThreadId.make(`thread-generation-concurrency-${index}`);
          const concurrentProposalId = ProposalId.make(`proposal-generation-concurrency-${index}`);
          yield* proposals.upsert({
            proposalId: concurrentProposalId,
            environmentId: EnvironmentId.make("environment-generation-exact"),
            projectId: ProjectId.make("project-generation-exact"),
            sourceThreadId: concurrentThreadId,
            producer: {
              providerSessionId: `provider-session-generation-concurrency-${index}`,
              providerInstanceId: ProviderInstanceId.make("codex-generation"),
            },
            cwd: workspaceRoot,
            changes: {
              _tag: "typed",
              operations: [
                {
                  _tag: "modify",
                  path: "target.txt",
                  beforeSha256: sha256("working-base\r\n") as never,
                  content: {
                    encoding: "utf8",
                    data: `proposed-concurrent-${index}\r\n`,
                  },
                },
              ],
            },
          });
          concurrencyInputs.push({
            threadId: concurrentThreadId,
            proposalId: concurrentProposalId,
          });
        }
        yield* Effect.promise(() => NodeFSP.writeFile(analyzerLifecycleLog, ""));
        const concurrentStarts = yield* Effect.all(
          concurrencyInputs.map((input) =>
            generations.start({
              threadId: input.threadId,
              proposalId: input.proposalId,
              revision: 1,
            }),
          ),
          { concurrency: "unbounded" },
        );
        const concurrentTerminals = yield* Effect.all(
          concurrentStarts.map((generation, index) =>
            waitForTerminal(concurrencyInputs[index]!.threadId, generation.generationId),
          ),
          { concurrency: "unbounded" },
        );
        expect(concurrentTerminals.map((generation) => generation.state)).toEqual([
          "ready",
          "ready",
          "ready",
        ]);
        const analyzerLifecycle = (yield* Effect.promise(() =>
          NodeFSP.readFile(analyzerLifecycleLog, "utf8"),
        ))
          .trim()
          .split("\n")
          .map(
            (line) =>
              JSON.parse(line) as {
                readonly event: "start" | "end";
                readonly out: string;
              },
          );
        let activeAnalyzerCount = 0;
        let maximumAnalyzerCount = 0;
        for (const event of analyzerLifecycle) {
          activeAnalyzerCount += event.event === "start" ? 1 : -1;
          maximumAnalyzerCount = Math.max(maximumAnalyzerCount, activeAnalyzerCount);
          expect(activeAnalyzerCount).toBeGreaterThanOrEqual(0);
        }
        expect(maximumAnalyzerCount).toBe(2);
        expect(activeAnalyzerCount).toBe(0);

        const abandonedId = ProposalGenerationId.make("generation-startup-abandoned");
        const abandonedArtifactRoot = NodePath.join(
          config.stateDir,
          "cartographer",
          "generations",
          abandonedId,
        );
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(abandonedArtifactRoot, { recursive: true });
          await NodeFSP.writeFile(NodePath.join(abandonedArtifactRoot, "partial.json"), "{}");
        });
        const createdAt = "2026-07-27T20:00:00.000Z";
        yield* sql`
          INSERT INTO proposal_generations (
            generation_id,
            proposal_id,
            revision_id,
            revision,
            thread_id,
            state,
            authority,
            workspace_snapshot_tree_oid,
            analyzer_version,
            artifact_root,
            base_graph_path,
            proposed_graph_path,
            impact_path,
            error_code,
            created_at,
            updated_at
          )
          VALUES (
            ${abandonedId},
            ${proposalId},
            ${revision.revisionId},
            ${revision.revision},
            ${threadId},
            'analyzing',
            'authoritative',
            ${revision.baseSnapshot.workingTreeOid},
            ${ready.analyzerVersion},
            ${abandonedArtifactRoot},
            NULL,
            NULL,
            NULL,
            NULL,
            ${createdAt},
            ${createdAt}
          )
        `;
        const recovered = yield* ProposalGenerationService.make;
        const abandoned = yield* recovered.get({ threadId, generationId: abandonedId });
        expect(abandoned.state).toBe("abandoned");
        expect(abandoned.errorCode).toBe("server-restarted");
        expect(yield* Effect.promise(() => pathExists(abandonedArtifactRoot))).toBe(false);
        expect(yield* Effect.promise(() => pathExists(artifactRoot))).toBe(true);
      }).pipe(Effect.provide(TestLayer));
    }),
  );
});
