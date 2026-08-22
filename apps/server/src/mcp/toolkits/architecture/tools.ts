// apps/server/src/mcp/toolkits/architecture/tools.ts
// declares bounded architecture query and ephemeral patch tools

import {
  ArchitectureBlastRadiusInput,
  ArchitectureBlastRadiusResult,
  ArchitectureGraphDiffInput,
  ArchitectureGraphDiffResult,
  ArchitecturePlanImpactUpsertInput,
  ArchitecturePlanImpactUpsertResult,
  ArchitectureProposePatchInput,
  ArchitectureProposePatchResult,
  ArchitectureToolError,
} from '@t3tools/contracts'
import * as Schema from 'effect/Schema'
import { Tool, Toolkit } from 'effect/unstable/ai'

import * as ArchitectureQueryService from '../../../cartographer/ArchitectureQueryService.ts'
import * as PlannedImpactService from '../../../architecture/PlannedImpactService.ts'
import * as McpInvocationContext from '../../McpInvocationContext.ts'
import * as ProjectionSnapshotQuery from '../../../orchestration/Services/ProjectionSnapshotQuery.ts'

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ArchitectureQueryService.ArchitectureQueryService,
  PlannedImpactService.PlannedImpactService,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
]

// encoded annotations survive provider JSON projection for transformed contract fields
const ArchitectureBlastRadiusParameters = Schema.Struct({
  context: ArchitectureBlastRadiusInput.fields.context.pipe(
    Schema.annotateEncoded({
      description: 'Already-analyzed graph to query; authority is derived from the MCP invocation.',
    }),
  ),
  target: ArchitectureBlastRadiusInput.fields.target.pipe(
    Schema.annotateEncoded({
      description:
        'Repository-relative file path, optionally followed by #exportName for symbol-first-hop precision.',
    }),
  ),
  direction: ArchitectureBlastRadiusInput.fields.direction.pipe(
    Schema.annotateEncoded({
      description: "Traversal direction. Defaults to 'both'.",
    }),
  ),
  maxDepth: ArchitectureBlastRadiusInput.fields.maxDepth.pipe(
    Schema.annotateEncoded({
      description: 'Maximum import traversal depth. Defaults to 4.',
    }),
  ),
})

const ArchitectureGraphDiffParameters = Schema.Struct({
  comparison: ArchitectureGraphDiffInput.fields.comparison.pipe(
    Schema.annotateEncoded({
      description: 'Proposal or diff-analysis identity whose two graphs resolve atomically.',
    }),
  ),
})

const ArchitectureProposePatchParameters = Schema.Struct({
  context: ArchitectureProposePatchInput.fields.context.pipe(
    Schema.annotateEncoded({
      description:
        'Current-worktree or standing-project graph to evaluate without editing or persisting.',
    }),
  ),
  ops: ArchitectureProposePatchInput.fields.ops.pipe(
    Schema.annotateEncoded({
      description:
        'Ordered GraphPatch v1 operations. Later operations may reference paths created earlier.',
    }),
  ),
})

const ArchitecturePlanImpactUpsertParameters = Schema.Struct({
  version: ArchitecturePlanImpactUpsertInput.fields.version.pipe(
    Schema.annotateEncoded({ description: 'Planned Impact publication format version; use 1.' }),
  ),
  summary: ArchitecturePlanImpactUpsertInput.fields.summary.pipe(
    Schema.annotateEncoded({
      description: 'Concise provider interpretation for this Planned Impact publication.',
    }),
  ),
  outcome: ArchitecturePlanImpactUpsertInput.fields.outcome.pipe(
    Schema.annotateEncoded({
      description: "Explicit 'changed' or confirmed 'no-impact' architecture outcome.",
    }),
  ),
  changedObjects: ArchitecturePlanImpactUpsertInput.fields.changedObjects.pipe(
    Schema.annotateEncoded({
      description: 'Up to 60 changed architecture objects identified by publication-local IDs.',
    }),
  ),
  relationships: ArchitecturePlanImpactUpsertInput.fields.relationships.pipe(
    Schema.annotateEncoded({
      description: 'Up to 120 relationships whose endpoints use publication-local object IDs.',
    }),
  ),
  pathHints: ArchitecturePlanImpactUpsertInput.fields.pathHints.pipe(
    Schema.annotateEncoded({
      description: 'Up to 100 repository-relative POSIX path hints; these are not trusted IDs.',
    }),
  ),
  rationale: ArchitecturePlanImpactUpsertInput.fields.rationale.pipe(
    Schema.annotateEncoded({
      description: 'Optional bounded reasoning that explains the provider interpretation.',
    }),
  ),
  omissions: ArchitecturePlanImpactUpsertInput.fields.omissions.pipe(
    Schema.annotateEncoded({
      description: 'Exact returned, total, and omitted counts plus an optional bounded note.',
    }),
  ),
  orchestratePlan: ArchitecturePlanImpactUpsertInput.fields.orchestratePlan.pipe(
    Schema.annotateEncoded({
      description: 'Exact tool-sourced Orchestrate run and revision selector; omit for Plan mode.',
    }),
  ),
})

export const ArchitectureBlastRadiusTool = Tool.make('architecture_blast_radius', {
  description:
    'Query the bounded upstream and downstream dependency impact of one repository-relative file or file#export target in an authorized, already-analyzed architecture graph. Select a current-thread-worktree, standing-project, completed proposal-generation, or completed diff-analysis graph through context. This never starts or refreshes analysis. MCP authentication supplies environment, thread, project, filesystem root, graph path, and context authority; do not pass those fields.',
  parameters: ArchitectureBlastRadiusParameters,
  success: ArchitectureBlastRadiusResult,
  failure: ArchitectureToolError,
  failureMode: 'return',
  dependencies,
})
  .annotate(Tool.Title, 'Query architecture blast radius')
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)

export const ArchitectureGraphDiffTool = Tool.make('architecture_graph_diff', {
  description:
    'Compare the paired graphs from one authorized, already-completed proposal generation or diff analysis. The comparison identity resolves both sides atomically and cannot address arbitrary graph pairs. Results include bounded node, edge, move, API, and architecture-rule evidence. This never starts or refreshes analysis, and MCP authentication supplies all environment, thread, project, root, and graph-path authority.',
  parameters: ArchitectureGraphDiffParameters,
  success: ArchitectureGraphDiffResult,
  failure: ArchitectureToolError,
  failureMode: 'return',
  dependencies,
})
  .annotate(Tool.Title, 'Compare architecture graphs')
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)

export const ArchitectureProposePatchTool = Tool.make('architecture_propose_patch', {
  description:
    'Evaluate 1 to 2,000 ordered GraphPatch v1 operations ephemerally against the authorized current-thread-worktree or standing-project graph. Operations are add_file, remove_file, move_file, add_import, and remove_import. Paths must be repository-relative POSIX paths without backslashes, absolute prefixes, empty segments, dot segments, or parent segments; typeOnly may be omitted or true. The canonical patch is limited to 1 MiB. Skipped operations are returned as bounded issues, and an all-skipped patch is still a successful evaluation. This requires the authenticated active turn but never edits the worktree, persists a proposal, or starts architecture analysis.',
  parameters: ArchitectureProposePatchParameters,
  success: ArchitectureProposePatchResult,
  failure: ArchitectureToolError,
  failureMode: 'return',
  dependencies,
})
  .annotate(Tool.Title, 'Evaluate architecture patch')
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false)

export const ArchitecturePlanImpactUpsertTool = Tool.make('architecture_plan_impact_upsert', {
  description:
    'Publish one bounded Planned Impact interpretation for the authenticated active Plan or exact tool-sourced Orchestrate revision. Publish this before proposal_preview_upsert when concrete file operations exist and before the final plan. Objects and relationships use publication-local IDs; path hints must be repository-relative POSIX paths. The server derives and verifies environment, project, thread, turn, provider, filesystem, plan, Repository Map, and graph authority. Never pass trusted project, graph, generation, digest, root, or standing semantic IDs. Identical retries are idempotent; changed interpretations append immutable publication revisions. Planned interpretation is never Verified evidence.',
  parameters: ArchitecturePlanImpactUpsertParameters,
  success: ArchitecturePlanImpactUpsertResult,
  failure: ArchitectureToolError,
  failureMode: 'return',
  dependencies,
})
  .annotate(Tool.Title, 'Publish Planned Impact')
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)

export const ArchitectureToolkit = Toolkit.make(
  ArchitectureBlastRadiusTool,
  ArchitectureGraphDiffTool,
  ArchitectureProposePatchTool,
  ArchitecturePlanImpactUpsertTool,
)
