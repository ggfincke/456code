// apps/server/src/proposal/ProposalService.ts
// exposes immutable proposal revision creation and exact diff queries
// @effect-diagnostics nodeBuiltinImport:off globalDate:off

import * as NodeCrypto from "node:crypto";

import {
  PROPOSAL_MAX_NARRATIVE_MDX_BYTES,
  ProposalError,
  ProposalId,
  ProposalRevisionId,
  type EnvironmentId,
  type OrchestrationProposedPlanId,
  type ProjectId,
  type Proposal,
  type ProposalChangeInput,
  type ProposalDiffResult,
  type ProposalGetResult,
  type ProposalListInput,
  type ProposalListResult,
  type ProposalNarrativeResult,
  type ProposalProducerIdentity,
  type ProposalRevision,
  type ProposalRevisionSelector,
  type ProposalSha256,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as ProposalGitEngine from "./ProposalGitEngine.ts";
import * as ProposalRepository from "./ProposalRepository.ts";

export interface ProposalUpsertRequest {
  readonly proposalId?: ProposalId;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly sourceThreadId: ThreadId;
  readonly producer: ProposalProducerIdentity;
  readonly cwd: string;
  readonly changes: ProposalChangeInput;
  readonly narrativeMdx?: string;
  readonly planId?: OrchestrationProposedPlanId;
  readonly planMarkdownSha256?: ProposalSha256;
}

function proposalError(
  operation: string,
  code: ConstructorParameters<typeof ProposalError>[0]["code"],
  detail: string,
  proposalId: ProposalId,
): ProposalError {
  return new ProposalError({ operation, code, detail, proposalId });
}

function selectRevision(
  revisions: ReadonlyArray<ProposalRevision>,
  selector: ProposalRevisionSelector,
): Effect.Effect<ProposalRevision, ProposalError> {
  const selected =
    selector.revision === undefined
      ? revisions.at(-1)
      : revisions.find((revision) => revision.revision === selector.revision);
  return selected
    ? Effect.succeed(selected)
    : Effect.fail(
        proposalError(
          "ProposalService.selectRevision",
          "not-found",
          selector.revision === undefined
            ? `Proposal '${selector.proposalId}' has no revisions.`
            : `Proposal '${selector.proposalId}' has no revision ${selector.revision}.`,
          selector.proposalId,
        ),
      );
}

export class ProposalService extends Context.Service<
  ProposalService,
  {
    readonly upsert: (
      input: ProposalUpsertRequest,
    ) => Effect.Effect<ProposalRevision, ProposalError>;
    readonly list: (input: ProposalListInput) => Effect.Effect<ProposalListResult, ProposalError>;
    readonly get: (
      input: ProposalRevisionSelector,
    ) => Effect.Effect<ProposalGetResult, ProposalError>;
    readonly diff: (
      input: ProposalRevisionSelector,
    ) => Effect.Effect<ProposalDiffResult, ProposalError>;
    readonly narrative: (
      input: ProposalRevisionSelector,
    ) => Effect.Effect<ProposalNarrativeResult | null, ProposalError>;
    readonly findLatestByPlan: (input: {
      readonly sourceThreadId: ThreadId;
      readonly planId: OrchestrationProposedPlanId;
      readonly createdAtOrBefore?: string;
    }) => Effect.Effect<
      { readonly proposal: Proposal; readonly revision: ProposalRevision } | null,
      ProposalError
    >;
  }
>()("456code/proposal/ProposalService") {}

export const make = Effect.gen(function* () {
  const gitEngine = yield* ProposalGitEngine.ProposalGitEngine;
  const repository = yield* ProposalRepository.ProposalRepository;

  const upsert: ProposalService["Service"]["upsert"] = Effect.fn("ProposalService.upsert")(
    function* (input) {
      const proposalId = input.proposalId ?? ProposalId.make(`proposal-${NodeCrypto.randomUUID()}`);
      const revisionId = ProposalRevisionId.make(`revision-${NodeCrypto.randomUUID()}`);
      const narrative =
        input.narrativeMdx === undefined
          ? undefined
          : (() => {
              const content = Buffer.from(input.narrativeMdx, "utf8");
              return {
                sha256: NodeCrypto.createHash("sha256")
                  .update(content)
                  .digest("hex") as ProposalSha256,
                content,
              };
            })();
      if (
        narrative !== undefined &&
        narrative.content.byteLength > PROPOSAL_MAX_NARRATIVE_MDX_BYTES
      ) {
        return yield* proposalError(
          "ProposalService.upsert",
          "limit-exceeded",
          `Proposal narrative is ${narrative.content.byteLength} bytes; the limit is ${PROPOSAL_MAX_NARRATIVE_MDX_BYTES}.`,
          proposalId,
        );
      }
      const prepared = yield* gitEngine.prepare({
        cwd: input.cwd,
        proposalId,
        revisionId,
        changes: input.changes,
      });
      const deletePreparedRefs = gitEngine.deleteRetainedRefs({
        cwd: prepared.worktree.rootPath,
        baseRetainedRef: prepared.baseRetainedRef,
        proposedRetainedRef: prepared.proposedRetainedRef,
      });
      const deletePreparedRefsIfUncommitted = repository.get(proposalId).pipe(
        Effect.matchEffect({
          onFailure: (error) => (error.code === "not-found" ? deletePreparedRefs : Effect.void),
          onSuccess: (stored) =>
            stored.revisions.some((revision) => revision.revisionId === revisionId)
              ? Effect.void
              : deletePreparedRefs,
        }),
      );
      const stored = yield* repository
        .append({
          proposalId,
          revisionId,
          environmentId: input.environmentId,
          projectId: input.projectId,
          sourceThreadId: input.sourceThreadId,
          producer: input.producer,
          prepared,
          ...(narrative === undefined ? {} : { narrative }),
          ...(input.planId === undefined ? {} : { planId: input.planId }),
          ...(input.planMarkdownSha256 === undefined
            ? {}
            : { planMarkdownSha256: input.planMarkdownSha256 }),
          createdAt: DateTime.formatIso(yield* DateTime.now),
        })
        .pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit) ? deletePreparedRefsIfUncommitted : Effect.void,
          ),
        );
      return stored.revision;
    },
  );

  const list: ProposalService["Service"]["list"] = Effect.fn("ProposalService.list")(
    function* (input) {
      const proposals = yield* repository.list(input);
      return { proposals: [...proposals] };
    },
  );

  const get: ProposalService["Service"]["get"] = Effect.fn("ProposalService.get")(
    function* (input) {
      const stored = yield* repository.get(input.proposalId);
      const revision = yield* selectRevision(stored.revisions, input);
      return {
        proposal: stored.proposal,
        revision,
        revisions: [...stored.revisions],
      };
    },
  );

  const diff: ProposalService["Service"]["diff"] = Effect.fn("ProposalService.diff")(
    function* (input) {
      const stored = yield* repository.get(input.proposalId);
      const revision = yield* selectRevision(stored.revisions, input);
      const bytes = yield* repository.readBlob(revision.diffSha256, input.proposalId);
      const actualSha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
      if (actualSha256 !== revision.diffSha256) {
        return yield* proposalError(
          "ProposalService.diff",
          "persistence-failed",
          `Stored diff blob '${revision.diffSha256}' failed its content hash check.`,
          input.proposalId,
        );
      }
      return {
        proposalId: input.proposalId,
        revisionId: revision.revisionId,
        revision: revision.revision,
        diff: Buffer.from(bytes).toString("utf8"),
        diffSha256: revision.diffSha256,
      };
    },
  );

  const narrative: ProposalService["Service"]["narrative"] = Effect.fn("ProposalService.narrative")(
    function* (input) {
      const stored = yield* repository.get(input.proposalId);
      const revision = yield* selectRevision(stored.revisions, input);
      if (revision.narrativeSha256 === undefined && revision.narrativeByteLength === undefined) {
        return null;
      }
      if (revision.narrativeSha256 === undefined || revision.narrativeByteLength === undefined) {
        return yield* proposalError(
          "ProposalService.narrative",
          "persistence-failed",
          "Stored proposal narrative metadata is incomplete.",
          input.proposalId,
        );
      }
      const bytes = yield* repository.readBlob(revision.narrativeSha256, input.proposalId);
      const actualSha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
      if (
        actualSha256 !== revision.narrativeSha256 ||
        bytes.byteLength !== revision.narrativeByteLength
      ) {
        return yield* proposalError(
          "ProposalService.narrative",
          "persistence-failed",
          `Stored narrative blob '${revision.narrativeSha256}' failed its content integrity check.`,
          input.proposalId,
        );
      }
      return {
        proposalId: input.proposalId,
        revisionId: revision.revisionId,
        revision: revision.revision,
        source: Buffer.from(bytes).toString("utf8"),
        sourceSha256: revision.narrativeSha256,
      };
    },
  );

  const findLatestByPlan: ProposalService["Service"]["findLatestByPlan"] = (input) =>
    repository.findLatestByPlan(input);

  return ProposalService.of({ upsert, list, get, diff, narrative, findLatestByPlan });
});

export const layer = Layer.effect(ProposalService, make).pipe(
  Layer.provide(ProposalGitEngine.layer),
  Layer.provide(ProposalRepository.layer),
);
