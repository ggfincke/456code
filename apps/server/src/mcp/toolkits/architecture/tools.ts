// apps/server/src/mcp/toolkits/architecture/tools.ts
// declares bounded architecture query and ephemeral patch tools

import {
  ArchitectureBlastRadiusInput,
  ArchitectureBlastRadiusResult,
  ArchitectureGraphDiffInput,
  ArchitectureGraphDiffResult,
  ArchitectureProposePatchInput,
  ArchitectureProposePatchResult,
  ArchitectureToolError,
} from '@t3tools/contracts'
import * as Schema from 'effect/Schema'
import { Tool, Toolkit } from 'effect/unstable/ai'

import * as ArchitectureQueryService from '../../../cartographer/ArchitectureQueryService.ts'
import * as McpInvocationContext from '../../McpInvocationContext.ts'

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ArchitectureQueryService.ArchitectureQueryService,
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

export const ArchitectureToolkit = Toolkit.make(
  ArchitectureBlastRadiusTool,
  ArchitectureGraphDiffTool,
  ArchitectureProposePatchTool,
)
