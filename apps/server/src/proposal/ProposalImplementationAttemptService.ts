// apps/server/src/proposal/ProposalImplementationAttemptService.ts
// records and classifies exact proposal implementation attempts
// @effect-diagnostics nodeBuiltinImport:off

import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ImplementationAttempt,
  ImplementationAttemptId,
  type ImplementationAttemptOutcome,
  type OrchestrationProposedPlanId,
  type Proposal,
  type ProposalId,
  type ProposalNormalizedOperation,
  type ProposalRepositoryIdentity,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ProcessRunner from "../processRunner.ts";
import {
  captureExactGitSnapshot,
  EXACT_GIT_SNAPSHOT_MAX_BYTE_COUNT,
  EXACT_GIT_SNAPSHOT_MAX_FILE_COUNT,
} from "../vcs/ExactGitSnapshot.ts";
import { ProposalService } from "./ProposalService.ts";

const GIT_TIMEOUT = "30 seconds";
const GIT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

interface AttemptRow {
  readonly attemptId: string;
  readonly proposalId: string;
  readonly revisionId: string;
  readonly revision: number;
  readonly sourceThreadId: string;
  readonly implementationThreadId: string;
  readonly implementationTurnId: string;
  readonly planId: string;
  readonly baselineTreeOid: string;
  readonly actualTreeOid: string | null;
  readonly outcome: string;
  readonly matchedOperationCount: number;
  readonly intendedOperationCount: number;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

interface SourcePlanRow {
  readonly sourceThreadId: string | null;
  readonly planId: string | null;
  readonly requestedAt: string;
}

export interface ActualTreeEntry {
  readonly oid: string;
  readonly mode: string;
}

export interface ImplementationAttemptClassification {
  readonly outcome: Exclude<ImplementationAttemptOutcome, "pending">;
  readonly matchedOperationCount: number;
  readonly intendedOperationCount: number;
}

export interface BeginImplementationAttemptInput {
  readonly implementationThreadId: ThreadId;
  readonly implementationTurnId: TurnId;
  readonly cwd: string;
  readonly baselineCheckpointRef?: string;
  readonly sourceProposedPlan?: {
    readonly threadId: ThreadId;
    readonly planId: OrchestrationProposedPlanId;
  };
  readonly createdAt: string;
}

export interface CompleteImplementationAttemptInput {
  readonly implementationThreadId: ThreadId;
  readonly implementationTurnId: TurnId;
  readonly cwd: string;
  readonly actualCheckpointRef: string;
  readonly completedAt: string;
}

export interface LatestImplementationAttemptInput {
  readonly sourceThreadId: ThreadId;
  readonly proposalId: ProposalId;
  readonly revision?: number;
}

export class ProposalImplementationAttemptError extends Schema.TaggedErrorClass<ProposalImplementationAttemptError>()(
  "ProposalImplementationAttemptError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

const isProposalImplementationAttemptError = Schema.is(ProposalImplementationAttemptError);

function attemptError(
  operation: string,
  cause: unknown,
  fallback: string,
): ProposalImplementationAttemptError {
  return isProposalImplementationAttemptError(cause)
    ? cause
    : new ProposalImplementationAttemptError({
        operation,
        detail: cause instanceof Error ? cause.message : fallback,
        cause,
      });
}

function matchingBlobEntry(
  entry: ActualTreeEntry | undefined,
  blob: Extract<ProposalNormalizedOperation, { readonly after: unknown }>["after"],
): boolean {
  return entry?.oid === blob.gitBlobOid && entry.mode === blob.mode;
}

function operationTransitionIsRealized(
  operation: ProposalNormalizedOperation,
  baselineEntries: ReadonlyMap<string, ActualTreeEntry>,
  actualEntries: ReadonlyMap<string, ActualTreeEntry>,
): boolean {
  switch (operation._tag) {
    case "add":
      return (
        !baselineEntries.has(operation.path) &&
        matchingBlobEntry(actualEntries.get(operation.path), operation.after)
      );
    case "modify":
      return (
        matchingBlobEntry(baselineEntries.get(operation.path), operation.before) &&
        matchingBlobEntry(actualEntries.get(operation.path), operation.after)
      );
    case "delete":
      return (
        matchingBlobEntry(baselineEntries.get(operation.path), operation.before) &&
        !actualEntries.has(operation.path)
      );
    case "rename":
      return (
        matchingBlobEntry(baselineEntries.get(operation.fromPath), operation.before) &&
        !baselineEntries.has(operation.toPath) &&
        matchingBlobEntry(actualEntries.get(operation.toPath), operation.after) &&
        !actualEntries.has(operation.fromPath)
      );
  }
}

export function classifyImplementationAttempt(input: {
  readonly proposedTreeOid: string;
  readonly actualTreeOid: string;
  readonly operations: ReadonlyArray<ProposalNormalizedOperation>;
  readonly baselineEntries: ReadonlyMap<string, ActualTreeEntry>;
  readonly actualEntries: ReadonlyMap<string, ActualTreeEntry>;
}): ImplementationAttemptClassification {
  const intendedOperationCount = input.operations.length;
  const matchedOperationCount = input.operations.reduce(
    (count, operation) =>
      count +
      (operationTransitionIsRealized(operation, input.baselineEntries, input.actualEntries)
        ? 1
        : 0),
    0,
  );
  return {
    outcome:
      input.actualTreeOid === input.proposedTreeOid &&
      matchedOperationCount === intendedOperationCount
        ? "matched"
        : matchedOperationCount > 0
          ? "partial"
          : "divergent",
    matchedOperationCount,
    intendedOperationCount,
  };
}

const decodeAttempt = Schema.decodeUnknownEffect(ImplementationAttempt);

function decodeAttemptRow(
  row: AttemptRow,
): Effect.Effect<ImplementationAttempt, ProposalImplementationAttemptError> {
  return decodeAttempt(row).pipe(
    Effect.mapError(
      (cause) =>
        new ProposalImplementationAttemptError({
          operation: "ProposalImplementationAttemptService.decode",
          detail: cause.message,
          cause,
        }),
    ),
  );
}

function parseTreeEntries(
  value: string,
): Effect.Effect<ReadonlyMap<string, ActualTreeEntry>, ProposalImplementationAttemptError> {
  return Effect.try({
    try: () => {
      const entries = new Map<string, ActualTreeEntry>();
      for (const record of value.split("\0")) {
        if (!record) continue;
        const match = /^(\d{6}) (?:blob|commit|tree) ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(record);
        if (!match?.[1] || !match[2] || !match[3]) {
          throw new Error("git ls-tree returned an unsupported tree entry.");
        }
        entries.set(match[3], {
          mode: match[1] as ActualTreeEntry["mode"],
          oid: match[2],
        });
      }
      return entries;
    },
    catch: (cause) =>
      attemptError(
        "ProposalImplementationAttemptService.parseTreeEntries",
        cause,
        "Could not parse the actual checkpoint tree.",
      ),
  });
}

function repositoryIdentityMatches(
  actual: ProposalRepositoryIdentity,
  expected: ProposalRepositoryIdentity,
): boolean {
  if (actual._tag !== expected._tag || actual.canonicalKey !== expected.canonicalKey) {
    return false;
  }
  return (
    actual._tag === "local-git" ||
    (expected._tag === "git-remote" &&
      actual.remoteName === expected.remoteName &&
      actual.remoteUrl === expected.remoteUrl)
  );
}

export class ProposalImplementationAttemptService extends Context.Service<
  ProposalImplementationAttemptService,
  {
    readonly begin: (
      input: BeginImplementationAttemptInput,
    ) => Effect.Effect<ImplementationAttempt | null, ProposalImplementationAttemptError>;
    readonly complete: (
      input: CompleteImplementationAttemptInput,
    ) => Effect.Effect<ImplementationAttempt | null, ProposalImplementationAttemptError>;
    readonly latestForProposal: (
      input: LatestImplementationAttemptInput,
    ) => Effect.Effect<ImplementationAttempt | null, ProposalImplementationAttemptError>;
  }
>()("456code/proposal/ProposalImplementationAttemptService") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const proposalService = yield* ProposalService;
  const processRunner = yield* ProcessRunner.ProcessRunner;

  const runGit = Effect.fn("ProposalImplementationAttemptService.runGit")(function* (
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    env?: NodeJS.ProcessEnv,
  ) {
    const result = yield* processRunner
      .run({
        command: "git",
        args: ["-C", cwd, ...args],
        cwd,
        timeout: GIT_TIMEOUT,
        maxOutputBytes: GIT_MAX_OUTPUT_BYTES,
        ...(env === undefined ? {} : { env }),
      })
      .pipe(
        Effect.mapError((cause) =>
          attemptError(operation, cause, "Could not execute Git for proposal comparison."),
        ),
      );
    if (result.code !== 0) {
      return yield* new ProposalImplementationAttemptError({
        operation,
        detail: result.stderr.trim() || `git exited with code ${String(result.code)}.`,
      });
    }
    return result.stdout;
  });

  const resolveTree = (cwd: string, treeish: string) =>
    runGit("ProposalImplementationAttemptService.resolveTree", cwd, [
      "rev-parse",
      "--verify",
      `${treeish}^{tree}`,
    ]).pipe(Effect.map((stdout) => stdout.trim()));

  const verifyProposalWorktree = Effect.fn(
    "ProposalImplementationAttemptService.verifyProposalWorktree",
  )(function* (cwd: string, proposal: Proposal) {
    const rootPath = yield* runGit(
      "ProposalImplementationAttemptService.verifyProposalWorktree",
      cwd,
      ["rev-parse", "--show-toplevel"],
    ).pipe(Effect.map((stdout) => stdout.trim()));
    const gitDirOutput = yield* runGit(
      "ProposalImplementationAttemptService.verifyProposalWorktree",
      rootPath,
      ["rev-parse", "--git-dir"],
    ).pipe(Effect.map((stdout) => stdout.trim()));
    const gitCommonDirOutput = yield* runGit(
      "ProposalImplementationAttemptService.verifyProposalWorktree",
      rootPath,
      ["rev-parse", "--git-common-dir"],
    ).pipe(Effect.map((stdout) => stdout.trim()));
    const worktree = {
      rootPath,
      gitDir: NodePath.resolve(rootPath, gitDirOutput),
      gitCommonDir: NodePath.resolve(rootPath, gitCommonDirOutput),
    };

    const remoteNames = yield* runGit(
      "ProposalImplementationAttemptService.verifyProposalWorktree",
      rootPath,
      ["remote"],
    ).pipe(
      Effect.map((stdout) =>
        stdout
          .split("\n")
          .map((name) => name.trim())
          .filter(Boolean)
          .toSorted(),
      ),
    );
    const remoteName = remoteNames.includes("upstream")
      ? "upstream"
      : remoteNames.includes("origin")
        ? "origin"
        : remoteNames[0];
    let repository: ProposalRepositoryIdentity;
    if (remoteName === undefined) {
      repository = {
        _tag: "local-git",
        canonicalKey: `local-git:${NodeCrypto.createHash("sha256")
          .update(worktree.gitCommonDir)
          .digest("hex")}`,
      };
    } else {
      const remoteUrl = (yield* runGit(
        "ProposalImplementationAttemptService.verifyProposalWorktree",
        rootPath,
        ["remote", "get-url", remoteName],
      )).trim();
      repository = {
        _tag: "git-remote",
        canonicalKey: normalizeGitRemoteUrl(remoteUrl),
        remoteName,
        remoteUrl,
      };
    }

    if (
      !repositoryIdentityMatches(repository, proposal.repository) ||
      worktree.rootPath !== proposal.worktree.rootPath ||
      worktree.gitDir !== proposal.worktree.gitDir ||
      worktree.gitCommonDir !== proposal.worktree.gitCommonDir
    ) {
      return yield* new ProposalImplementationAttemptError({
        operation: "ProposalImplementationAttemptService.verifyProposalWorktree",
        detail:
          "The implementation cwd does not match the proposal's persisted repository and worktree identity.",
      });
    }

    const submoduleRows = yield* runGit(
      "ProposalImplementationAttemptService.verifyProposalWorktree",
      proposal.worktree.rootPath,
      ["ls-files", "--stage", "-z"],
    );
    const submodulePaths = submoduleRows
      .split("\0")
      .flatMap((record) => /^160000 [0-9a-f]{40,64} \d\t([\s\S]+)$/.exec(record)?.[1] ?? []);
    if (submodulePaths.length > 0) {
      const submoduleStatus = yield* runGit(
        "ProposalImplementationAttemptService.verifyProposalWorktree",
        proposal.worktree.rootPath,
        [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
          "--ignore-submodules=none",
          "--",
          ...submodulePaths,
        ],
      );
      if (submoduleStatus.length > 0) {
        return yield* new ProposalImplementationAttemptError({
          operation: "ProposalImplementationAttemptService.verifyProposalWorktree",
          detail: "Dirty submodules are unsupported by proposal snapshot policy v1.",
        });
      }
    }
  });

  const snapshotWorkingTree = Effect.fn("ProposalImplementationAttemptService.snapshotWorkingTree")(
    function* (cwd: string) {
      const tempDirectory = yield* Effect.tryPromise({
        try: () => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "456code-attempt-")),
        catch: (cause) =>
          attemptError(
            "ProposalImplementationAttemptService.snapshotWorkingTree",
            cause,
            "Could not create isolated Git index storage.",
          ),
      });
      const cleanup = Effect.tryPromise({
        try: () => NodeFSP.rm(tempDirectory, { recursive: true, force: true }),
        catch: () => undefined,
      }).pipe(Effect.ignore);
      return yield* Effect.tryPromise({
        try: (signal) =>
          captureExactGitSnapshot({
            repositoryRoot: cwd,
            indexPath: NodePath.join(tempDirectory, "index"),
            signal,
            limits: {
              maxFileCount: EXACT_GIT_SNAPSHOT_MAX_FILE_COUNT,
              maxByteCount: EXACT_GIT_SNAPSHOT_MAX_BYTE_COUNT,
            },
          }),
        catch: (cause) =>
          attemptError(
            "ProposalImplementationAttemptService.snapshotWorkingTree",
            cause,
            "Could not capture the exact implementation worktree.",
          ),
      }).pipe(
        Effect.flatMap((snapshot) =>
          snapshot.headOid === null
            ? new ProposalImplementationAttemptError({
                operation: "ProposalImplementationAttemptService.snapshotWorkingTree",
                detail: "Implementation snapshots require an existing HEAD commit.",
              })
            : Effect.succeed(snapshot.treeOid),
        ),
        Effect.ensuring(cleanup),
      );
    },
  );

  const findExisting = Effect.fn("ProposalImplementationAttemptService.findExisting")(function* (
    implementationThreadId: ThreadId,
    implementationTurnId: TurnId,
  ) {
    const rows = yield* sql<AttemptRow>`
        SELECT
          attempt_id AS "attemptId",
          proposal_id AS "proposalId",
          revision_id AS "revisionId",
          revision,
          source_thread_id AS "sourceThreadId",
          implementation_thread_id AS "implementationThreadId",
          implementation_turn_id AS "implementationTurnId",
          plan_id AS "planId",
          baseline_tree_oid AS "baselineTreeOid",
          actual_tree_oid AS "actualTreeOid",
          outcome,
          matched_operation_count AS "matchedOperationCount",
          intended_operation_count AS "intendedOperationCount",
          created_at AS "createdAt",
          completed_at AS "completedAt"
        FROM proposal_implementation_attempts
        WHERE implementation_thread_id = ${implementationThreadId}
          AND implementation_turn_id = ${implementationTurnId}
        LIMIT 1
      `.pipe(
      Effect.mapError((cause) =>
        attemptError(
          "ProposalImplementationAttemptService.findExisting",
          cause,
          "Could not read the implementation attempt.",
        ),
      ),
    );
    return rows[0] ? yield* decodeAttemptRow(rows[0]) : null;
  });

  const resolveSourcePlan = Effect.fn("ProposalImplementationAttemptService.resolveSourcePlan")(
    function* (input: BeginImplementationAttemptInput) {
      if (input.sourceProposedPlan !== undefined) {
        return {
          sourceThreadId: input.sourceProposedPlan.threadId,
          planId: input.sourceProposedPlan.planId,
          requestedAt: input.createdAt,
        };
      }
      const rows = yield* sql<SourcePlanRow>`
        SELECT
          source_proposed_plan_thread_id AS "sourceThreadId",
          source_proposed_plan_id AS "planId",
          requested_at AS "requestedAt"
        FROM projection_turns
        WHERE thread_id = ${input.implementationThreadId}
          AND turn_id = ${input.implementationTurnId}
        LIMIT 1
      `.pipe(
        Effect.mapError((cause) =>
          attemptError(
            "ProposalImplementationAttemptService.resolveSourcePlan",
            cause,
            "Could not resolve the implementation turn's source proposal.",
          ),
        ),
      );
      const source = rows[0];
      return source?.sourceThreadId && source.planId
        ? {
            sourceThreadId: source.sourceThreadId as ThreadId,
            planId: source.planId as OrchestrationProposedPlanId,
            requestedAt: source.requestedAt,
          }
        : null;
    },
  );

  const begin: ProposalImplementationAttemptService["Service"]["begin"] = Effect.fn(
    "ProposalImplementationAttemptService.begin",
  )(function* (input) {
    const existing = yield* findExisting(input.implementationThreadId, input.implementationTurnId);
    if (existing) {
      return existing;
    }

    const source = yield* resolveSourcePlan(input);
    if (!source) {
      return null;
    }
    const linked = yield* proposalService
      .findLatestByPlan({
        sourceThreadId: source.sourceThreadId,
        planId: source.planId,
        createdAtOrBefore: source.requestedAt,
      })
      .pipe(
        Effect.mapError((cause) =>
          attemptError(
            "ProposalImplementationAttemptService.begin",
            cause,
            "Could not resolve the proposal revision linked to this plan.",
          ),
        ),
      );
    if (!linked) {
      return null;
    }

    yield* verifyProposalWorktree(input.cwd, linked.proposal);
    const verifiedCwd = linked.proposal.worktree.rootPath;
    const baselineTreeOid =
      input.baselineCheckpointRef === undefined
        ? yield* snapshotWorkingTree(verifiedCwd)
        : yield* resolveTree(verifiedCwd, input.baselineCheckpointRef);
    const attemptId = ImplementationAttemptId.make(
      `implementation-attempt-${NodeCrypto.randomUUID()}`,
    );
    yield* sql`
      INSERT INTO proposal_implementation_attempts (
        attempt_id,
        proposal_id,
        revision_id,
        revision,
        source_thread_id,
        implementation_thread_id,
        implementation_turn_id,
        plan_id,
        baseline_tree_oid,
        actual_tree_oid,
        outcome,
        matched_operation_count,
        intended_operation_count,
        created_at,
        completed_at
      )
      VALUES (
        ${attemptId},
        ${linked.proposal.proposalId},
        ${linked.revision.revisionId},
        ${linked.revision.revision},
        ${source.sourceThreadId},
        ${input.implementationThreadId},
        ${input.implementationTurnId},
        ${source.planId},
        ${baselineTreeOid},
        NULL,
        'pending',
        0,
        ${linked.revision.manifest.operationCount},
        ${source.requestedAt},
        NULL
      )
      ON CONFLICT(implementation_thread_id, implementation_turn_id) DO NOTHING
    `.pipe(
      Effect.mapError((cause) =>
        attemptError(
          "ProposalImplementationAttemptService.begin",
          cause,
          "Could not persist the implementation attempt.",
        ),
      ),
    );
    return yield* findExisting(input.implementationThreadId, input.implementationTurnId);
  });

  const complete: ProposalImplementationAttemptService["Service"]["complete"] = Effect.fn(
    "ProposalImplementationAttemptService.complete",
  )(function* (input) {
    const existing = yield* findExisting(input.implementationThreadId, input.implementationTurnId);
    if (!existing || existing.outcome !== "pending") {
      return existing;
    }

    const linked = yield* proposalService
      .get({
        proposalId: existing.proposalId,
        revision: existing.revision,
      })
      .pipe(
        Effect.mapError((cause) =>
          attemptError(
            "ProposalImplementationAttemptService.complete",
            cause,
            "Could not read the consumed proposal revision.",
          ),
        ),
      );
    yield* verifyProposalWorktree(input.cwd, linked.proposal);
    const verifiedCwd = linked.proposal.worktree.rootPath;
    const actualTreeOid = yield* resolveTree(verifiedCwd, input.actualCheckpointRef);
    const paths = Array.from(
      new Set(
        linked.revision.manifest.operations.flatMap((operation) =>
          operation._tag === "rename" ? [operation.fromPath, operation.toPath] : [operation.path],
        ),
      ),
    );
    const [baselineTreeOutput, actualTreeOutput] =
      paths.length === 0
        ? ["", ""]
        : yield* Effect.all([
            runGit(
              "ProposalImplementationAttemptService.complete",
              verifiedCwd,
              ["ls-tree", "-z", existing.baselineTreeOid, "--", ...paths],
              {
                GIT_LITERAL_PATHSPECS: "1",
              },
            ),
            runGit(
              "ProposalImplementationAttemptService.complete",
              verifiedCwd,
              ["ls-tree", "-z", actualTreeOid, "--", ...paths],
              {
                GIT_LITERAL_PATHSPECS: "1",
              },
            ),
          ]);
    const baselineEntries = yield* parseTreeEntries(baselineTreeOutput);
    const actualEntries = yield* parseTreeEntries(actualTreeOutput);
    const classification = classifyImplementationAttempt({
      proposedTreeOid: linked.revision.proposedTreeOid,
      actualTreeOid,
      operations: linked.revision.manifest.operations,
      baselineEntries,
      actualEntries,
    });

    yield* sql`
      UPDATE proposal_implementation_attempts
      SET
        actual_tree_oid = ${actualTreeOid},
        outcome = ${classification.outcome},
        matched_operation_count = ${classification.matchedOperationCount},
        intended_operation_count = ${classification.intendedOperationCount},
        completed_at = ${input.completedAt}
      WHERE implementation_thread_id = ${input.implementationThreadId}
        AND implementation_turn_id = ${input.implementationTurnId}
        AND outcome = 'pending'
    `.pipe(
      Effect.mapError((cause) =>
        attemptError(
          "ProposalImplementationAttemptService.complete",
          cause,
          "Could not complete the implementation attempt.",
        ),
      ),
    );
    return yield* findExisting(input.implementationThreadId, input.implementationTurnId);
  });

  const latestForProposal: ProposalImplementationAttemptService["Service"]["latestForProposal"] =
    Effect.fn("ProposalImplementationAttemptService.latestForProposal")(function* (input) {
      const rows = yield* sql<AttemptRow>`
        SELECT
          attempt_id AS "attemptId",
          proposal_id AS "proposalId",
          revision_id AS "revisionId",
          revision,
          source_thread_id AS "sourceThreadId",
          implementation_thread_id AS "implementationThreadId",
          implementation_turn_id AS "implementationTurnId",
          plan_id AS "planId",
          baseline_tree_oid AS "baselineTreeOid",
          actual_tree_oid AS "actualTreeOid",
          outcome,
          matched_operation_count AS "matchedOperationCount",
          intended_operation_count AS "intendedOperationCount",
          created_at AS "createdAt",
          completed_at AS "completedAt"
        FROM proposal_implementation_attempts
        WHERE source_thread_id = ${input.sourceThreadId}
          AND proposal_id = ${input.proposalId}
          ${input.revision === undefined ? sql.unsafe("") : sql`AND revision = ${input.revision}`}
        ORDER BY created_at DESC, attempt_id DESC
        LIMIT 1
      `.pipe(
        Effect.mapError((cause) =>
          attemptError(
            "ProposalImplementationAttemptService.latestForProposal",
            cause,
            "Could not read the latest proposal implementation attempt.",
          ),
        ),
      );
      return rows[0] ? yield* decodeAttemptRow(rows[0]) : null;
    });

  return ProposalImplementationAttemptService.of({ begin, complete, latestForProposal });
});

export const layer = Layer.effect(ProposalImplementationAttemptService, make);
