// apps/server/src/mcp/toolkits/proposal/tools.ts
// declares the authenticated immutable proposal preview tool

import {
  PreviewAutomationUnavailableError,
  ProjectReadMdxDocumentError,
  ProposalError,
  ProposalPreviewUpsertInput,
  ProposalRevision,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProposalService from "../../../proposal/ProposalService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  ProposalService.ProposalService,
];

export const ProposalPreviewUpsertTool = Tool.make("proposal_preview_upsert", {
  description:
    "Create an immutable exact proposal revision for the authenticated active turn's persisted plan from bounded typed file operations without changing the user's worktree. The authenticated MCP session supplies the environment, project, source thread, provider identity, worktree root, and plan identity; do not pass those values. An optional narrative is compiled through the closed SafeDocument MDX policy.",
  parameters: ProposalPreviewUpsertInput,
  success: ProposalRevision,
  failure: Schema.Union([
    PreviewAutomationUnavailableError,
    ProjectReadMdxDocumentError,
    ProposalError,
  ]),
  dependencies,
})
  .annotate(Tool.Title, "Upsert proposal preview")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const ProposalToolkit = Toolkit.make(ProposalPreviewUpsertTool);
