// apps/server/src/mcp/toolkits/proposal/handlers.ts
// derives proposal authority from MCP context and persists exact revisions

import { ProposalError, type ProposalId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { compileSafeDocumentSource } from "../../../mdx/WorkspaceMdxDocument.ts";
import { proposedPlanIdForTurn } from "../../../orchestration/proposedPlanIdentity.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProposalService from "../../../proposal/ProposalService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ProposalToolkit } from "./tools.ts";

function proposalError(
  operation: string,
  code: ConstructorParameters<typeof ProposalError>[0]["code"],
  detail: string,
  proposalId?: ProposalId,
): ProposalError {
  return new ProposalError({
    operation,
    code,
    detail,
    ...(proposalId === undefined ? {} : { proposalId }),
  });
}

const handlers = {
  proposal_preview_upsert: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("proposal");
      const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
      const proposals = yield* ProposalService.ProposalService;

      if (scope.activeTurnId === undefined) {
        return yield* proposalError(
          "proposal_preview_upsert.resolve_plan",
          "identity-mismatch",
          "The authenticated MCP session is not bound to an active provider turn.",
          input.proposalId,
        );
      }

      const threadOption = yield* snapshots
        .getThreadDetailById(scope.threadId)
        .pipe(
          Effect.mapError(() =>
            proposalError(
              "proposal_preview_upsert.resolve_thread",
              "persistence-failed",
              "The authenticated source thread could not be resolved.",
              input.proposalId,
            ),
          ),
        );
      if (Option.isNone(threadOption)) {
        return yield* proposalError(
          "proposal_preview_upsert.resolve_thread",
          "not-found",
          "The authenticated source thread is not active.",
          input.proposalId,
        );
      }
      const thread = threadOption.value;
      if (
        thread.session?.status !== "running" ||
        thread.session.activeTurnId !== scope.activeTurnId ||
        thread.latestTurn?.state !== "running" ||
        thread.latestTurn.turnId !== scope.activeTurnId
      ) {
        return yield* proposalError(
          "proposal_preview_upsert.resolve_plan",
          "identity-mismatch",
          "The authenticated MCP turn does not match the thread's active projected turn.",
          input.proposalId,
        );
      }
      if (thread.interactionMode !== "plan") {
        return yield* proposalError(
          "proposal_preview_upsert.resolve_plan",
          "identity-mismatch",
          "The authenticated MCP turn is not running in plan mode.",
          input.proposalId,
        );
      }
      const planId = proposedPlanIdForTurn(scope.threadId, scope.activeTurnId);

      const projectOption = yield* snapshots
        .getProjectShellById(thread.projectId)
        .pipe(
          Effect.mapError(() =>
            proposalError(
              "proposal_preview_upsert.resolve_project",
              "persistence-failed",
              "The authenticated source project could not be resolved.",
              input.proposalId,
            ),
          ),
        );
      if (Option.isNone(projectOption)) {
        return yield* proposalError(
          "proposal_preview_upsert.resolve_project",
          "not-found",
          "The authenticated source project is not active.",
          input.proposalId,
        );
      }

      if (input.narrativeMdx !== undefined) {
        yield* compileSafeDocumentSource({
          threadId: scope.threadId,
          relativePath: "proposal-narrative.mdx",
          source: input.narrativeMdx,
        });
      }

      return yield* proposals.upsert({
        ...(input.proposalId === undefined ? {} : { proposalId: input.proposalId }),
        environmentId: scope.environmentId,
        projectId: thread.projectId,
        sourceThreadId: scope.threadId,
        producer: {
          providerSessionId: scope.providerSessionId,
          providerInstanceId: scope.providerInstanceId,
        },
        cwd: thread.worktreePath ?? projectOption.value.workspaceRoot,
        changes: input.changes,
        ...(input.narrativeMdx === undefined ? {} : { narrativeMdx: input.narrativeMdx }),
        planId,
      });
    }),
} satisfies Parameters<typeof ProposalToolkit.toLayer>[0];

export const ProposalToolkitHandlersLive = ProposalToolkit.toLayer(handlers);
