// packages/contracts/src/architectureTools.ts
// defines bounded architecture query and ephemeral patch contracts

import * as Schema from 'effect/Schema'

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from './baseSchemas.ts'
import { DiffAnalysisId, ProposalGenerationId } from './cartographer.ts'

export const ARCHITECTURE_RESULT_LIST_LIMIT = 200
export const ARCHITECTURE_API_FILE_LIMIT = 100
export const ARCHITECTURE_API_EXPORT_LIMIT = 50
export const ARCHITECTURE_API_CONSUMER_LIMIT = 25
export const ARCHITECTURE_BLAST_PATH_LIMIT = 400
export const ARCHITECTURE_PATCH_ISSUE_LIMIT = 200
export const ARCHITECTURE_PATCH_CYCLE_LIMIT = 20
export const ARCHITECTURE_PATCH_BOUNDARY_LIMIT = 50
export const ARCHITECTURE_PATCH_ORPHAN_LIMIT = 200

export const ARCHITECTURE_PATCH_MAX_OPS = 2_000
export const ARCHITECTURE_PATCH_MAX_BYTES = 1_048_576
export const ARCHITECTURE_PATCH_MAX_PATH_LENGTH = 512
export const ARCHITECTURE_PATCH_MAX_DESCRIPTION_LENGTH = 2_000
export const ARCHITECTURE_PATCH_MAX_NOTE_LENGTH = 500
export const ARCHITECTURE_PATCH_MAX_EXPORTS = 200
export const ARCHITECTURE_PATCH_MAX_SYMBOLS = 200
export const ARCHITECTURE_PATCH_MAX_NAME_LENGTH = 200
export const ARCHITECTURE_BLAST_TARGET_MAX_LENGTH =
  ARCHITECTURE_PATCH_MAX_PATH_LENGTH + 1 + ARCHITECTURE_PATCH_MAX_NAME_LENGTH

const ArchitectureValueString = Schema.String.check(Schema.isNonEmpty())
const ArchitectureVersion = Schema.Literal(1)

export const ArchitectureBoundedList = <S extends Schema.Top>(item: S, maximumItems: number) =>
  Schema.Struct({
    items: Schema.Array(item).check(Schema.isMaxLength(maximumItems)),
    total: NonNegativeInt,
    omitted: NonNegativeInt,
  }).check(
    Schema.makeFilter(
      (value) =>
        value.total === value.items.length + value.omitted ||
        'total must equal the number of returned items plus omitted.',
    ),
  )

export const ArchitectureGraphSelector = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('current-thread-worktree').annotate({
      description: 'Uses the prepared architecture for the current thread worktree.',
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal('proposal-generation').annotate({
      description: 'Uses one side of an already-completed proposal analysis.',
    }),
    generationId: ProposalGenerationId.annotate({
      description: 'Proposal generation identity owned by the current thread.',
    }),
    graph: Schema.Literals(['base', 'proposed']).annotate({
      description: 'Selects the base or proposed graph from the proposal generation.',
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal('standing-project').annotate({
      description: 'Uses the last-good published architecture for the current thread project.',
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal('diff-analysis').annotate({
      description: 'Uses one side of an already-completed diff analysis.',
    }),
    diffAnalysisId: DiffAnalysisId.annotate({
      description: 'Diff analysis identity authorized for the current thread workspace.',
    }),
    graph: Schema.Literals(['base', 'head']).annotate({
      description: 'Selects the base or head graph from the diff analysis.',
    }),
  }),
]).annotate({
  description:
    'Selects one already-analyzed architecture graph without accepting caller-supplied filesystem or authority fields.',
})
export type ArchitectureGraphSelector = typeof ArchitectureGraphSelector.Type

export const ArchitectureComparisonSelector = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('proposal-generation').annotate({
      description: 'Compares the base and proposed graphs from one proposal generation.',
    }),
    generationId: ProposalGenerationId.annotate({
      description: 'Proposal generation identity owned by the current thread.',
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal('diff-analysis').annotate({
      description: 'Compares the base and head graphs from one diff analysis.',
    }),
    diffAnalysisId: DiffAnalysisId.annotate({
      description: 'Diff analysis identity authorized for the current thread workspace.',
    }),
  }),
]).annotate({
  description: 'Selects one atomic, already-analyzed graph pair for comparison.',
})
export type ArchitectureComparisonSelector = typeof ArchitectureComparisonSelector.Type

export const ArchitecturePatchContextSelector = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('current-thread-worktree').annotate({
      description: 'Evaluates against the prepared architecture for the current worktree.',
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal('standing-project').annotate({
      description:
        'Evaluates against the last-good published architecture for the current project.',
    }),
  }),
]).annotate({
  description:
    'Selects an authorized current or standing-project graph for ephemeral patch evaluation.',
})
export type ArchitecturePatchContextSelector = typeof ArchitecturePatchContextSelector.Type

export const ArchitectureBlastDirection = Schema.Literals(['upstream', 'downstream', 'both'])
export type ArchitectureBlastDirection = typeof ArchitectureBlastDirection.Type

function relativePosixPathIssue(path: string): string | null
{
  if (path.startsWith('/') || path.includes('\\'))
  {
    return 'Paths must be repository-relative POSIX paths.'
  }
  if (path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..'))
  {
    return 'Paths must not contain empty, dot, or parent segments.'
  }
  for (let index = 0; index < path.length; index += 1)
  {
    if (path.charCodeAt(index) < 0x20)
    {
      return 'Paths must not contain control characters.'
    }
  }
  return null
}

const relativePosixPathFilter = Schema.makeFilter<string>(
  (path) => relativePosixPathIssue(path) ?? true,
)

const ArchitectureBlastTarget = Schema.String.check(
  Schema.makeFilter((target) =>
  {
    if (target !== target.trim())
    {
      return 'Architecture targets must not contain leading or trailing whitespace.'
    }
    const separator = target.indexOf('#')
    const path = separator === -1 ? target : target.slice(0, separator)
    const symbol = separator === -1 ? undefined : target.slice(separator + 1)
    const pathIssue = relativePosixPathIssue(path)
    if (pathIssue !== null)
    {
      return pathIssue
    }
    if (path.length > ARCHITECTURE_PATCH_MAX_PATH_LENGTH)
    {
      return `Architecture target paths are limited to ${ARCHITECTURE_PATCH_MAX_PATH_LENGTH} characters.`
    }
    if (
      symbol !== undefined &&
      (symbol.length === 0 ||
        symbol.length > ARCHITECTURE_PATCH_MAX_NAME_LENGTH ||
        symbol.includes('#'))
    )
    {
      return `Architecture target exports must contain 1 to ${ARCHITECTURE_PATCH_MAX_NAME_LENGTH} characters.`
    }
    return true
  }),
  Schema.isNonEmpty(),
  Schema.isMaxLength(ARCHITECTURE_BLAST_TARGET_MAX_LENGTH),
)

export const ArchitectureBlastRadiusInput = Schema.Struct({
  context: ArchitectureGraphSelector.annotate({
    description: 'Already-analyzed graph to query; authority is derived from the MCP invocation.',
  }),
  target: ArchitectureBlastTarget.annotate({
    description:
      'Repository-relative file path, optionally followed by #exportName for symbol-first-hop precision.',
  }),
  direction: Schema.optionalKey(ArchitectureBlastDirection).annotate({
    description: "Traversal direction. Defaults to 'both'.",
  }),
  maxDepth: Schema.optionalKey(PositiveInt).annotate({
    description: 'Maximum import traversal depth. Defaults to 4.',
  }),
}).annotate({
  description: 'Queries bounded dependency impact from an already-analyzed architecture graph.',
})
export type ArchitectureBlastRadiusInput = typeof ArchitectureBlastRadiusInput.Type

export const ArchitectureGraphDiffInput = Schema.Struct({
  comparison: ArchitectureComparisonSelector.annotate({
    description: 'Proposal or diff-analysis identity whose two graphs must be resolved atomically.',
  }),
}).annotate({
  description: 'Compares the paired graphs from one authorized completed analysis.',
})
export type ArchitectureGraphDiffInput = typeof ArchitectureGraphDiffInput.Type

export const ArchitectureImpactInput = Schema.Struct({
  threadId: ThreadId,
  comparison: ArchitectureComparisonSelector.annotate({
    description: 'Proposal or diff-analysis identity whose two graphs must be resolved atomically.',
  }),
}).annotate({
  description: 'Requests native architecture impact for one thread-authorized graph comparison.',
})
export type ArchitectureImpactInput = typeof ArchitectureImpactInput.Type

export const ArchitecturePatchPath = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(ARCHITECTURE_PATCH_MAX_PATH_LENGTH),
  relativePosixPathFilter,
)
export type ArchitecturePatchPath = typeof ArchitecturePatchPath.Type

const ArchitecturePatchDescription = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(ARCHITECTURE_PATCH_MAX_DESCRIPTION_LENGTH),
)
const ArchitecturePatchNote = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(ARCHITECTURE_PATCH_MAX_NOTE_LENGTH),
)
const ArchitecturePatchName = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(ARCHITECTURE_PATCH_MAX_NAME_LENGTH),
)
const ArchitecturePatchExports = Schema.Array(ArchitecturePatchName).check(
  Schema.isMaxLength(ARCHITECTURE_PATCH_MAX_EXPORTS),
)
const ArchitecturePatchSymbols = Schema.Array(ArchitecturePatchName).check(
  Schema.isMaxLength(ARCHITECTURE_PATCH_MAX_SYMBOLS),
)

export const ArchitectureAddFilePatchOp = Schema.Struct({
  op: Schema.Literal('add_file').annotate({
    description: 'Adds a hypothetical file node.',
  }),
  path: ArchitecturePatchPath.annotate({
    description: 'Repository-relative POSIX path for the hypothetical file.',
  }),
  description: Schema.optionalKey(ArchitecturePatchDescription).annotate({
    description: 'Optional file description for the hypothetical node.',
  }),
  exports: Schema.optionalKey(ArchitecturePatchExports).annotate({
    description: 'Optional exported symbol names for the hypothetical file.',
  }),
  note: Schema.optionalKey(ArchitecturePatchNote).annotate({
    description: 'Optional rationale for this operation.',
  }),
})
export type ArchitectureAddFilePatchOp = typeof ArchitectureAddFilePatchOp.Type

export const ArchitectureRemoveFilePatchOp = Schema.Struct({
  op: Schema.Literal('remove_file').annotate({
    description: 'Removes a hypothetical file node and its incident imports.',
  }),
  path: ArchitecturePatchPath.annotate({
    description: 'Repository-relative POSIX path of the file to remove.',
  }),
  note: Schema.optionalKey(ArchitecturePatchNote).annotate({
    description: 'Optional rationale for this operation.',
  }),
})
export type ArchitectureRemoveFilePatchOp = typeof ArchitectureRemoveFilePatchOp.Type

export const ArchitectureMoveFilePatchOp = Schema.Struct({
  op: Schema.Literal('move_file').annotate({
    description: 'Moves a hypothetical file node and retargets its incident imports.',
  }),
  from: ArchitecturePatchPath.annotate({
    description: 'Existing repository-relative POSIX path.',
  }),
  to: ArchitecturePatchPath.annotate({
    description: 'New repository-relative POSIX path.',
  }),
  note: Schema.optionalKey(ArchitecturePatchNote).annotate({
    description: 'Optional rationale for this operation.',
  }),
})
export type ArchitectureMoveFilePatchOp = typeof ArchitectureMoveFilePatchOp.Type

export const ArchitectureAddImportPatchOp = Schema.Struct({
  op: Schema.Literal('add_import').annotate({
    description: 'Adds a hypothetical import edge.',
  }),
  from: ArchitecturePatchPath.annotate({
    description: 'Repository-relative path of the importing file.',
  }),
  to: ArchitecturePatchPath.annotate({
    description: 'Repository-relative path of the imported file.',
  }),
  symbols: Schema.optionalKey(ArchitecturePatchSymbols).annotate({
    description: 'Optional imported symbol names.',
  }),
  typeOnly: Schema.optionalKey(Schema.Literal(true)).annotate({
    description: 'Present only as true when the whole import is type-only.',
  }),
  note: Schema.optionalKey(ArchitecturePatchNote).annotate({
    description: 'Optional rationale for this operation.',
  }),
})
export type ArchitectureAddImportPatchOp = typeof ArchitectureAddImportPatchOp.Type

export const ArchitectureRemoveImportPatchOp = Schema.Struct({
  op: Schema.Literal('remove_import').annotate({
    description: 'Removes a hypothetical import edge.',
  }),
  from: ArchitecturePatchPath.annotate({
    description: 'Repository-relative path of the importing file.',
  }),
  to: ArchitecturePatchPath.annotate({
    description: 'Repository-relative path of the imported file.',
  }),
  note: Schema.optionalKey(ArchitecturePatchNote).annotate({
    description: 'Optional rationale for this operation.',
  }),
})
export type ArchitectureRemoveImportPatchOp = typeof ArchitectureRemoveImportPatchOp.Type

export const ArchitecturePatchOp = Schema.Union([
  ArchitectureAddFilePatchOp,
  ArchitectureRemoveFilePatchOp,
  ArchitectureMoveFilePatchOp,
  ArchitectureAddImportPatchOp,
  ArchitectureRemoveImportPatchOp,
])
export type ArchitecturePatchOp = typeof ArchitecturePatchOp.Type

export const ArchitectureProposePatchInput = Schema.Struct({
  context: ArchitecturePatchContextSelector.annotate({
    description:
      'Current-worktree or standing-project graph to evaluate without editing or persisting.',
  }),
  ops: Schema.Array(ArchitecturePatchOp)
    .check(Schema.isMinLength(1), Schema.isMaxLength(ARCHITECTURE_PATCH_MAX_OPS))
    .annotate({
      description:
        'Ordered GraphPatch v1 operations. Later operations may reference paths created earlier.',
    }),
}).annotate({
  description:
    'Evaluates a bounded GraphPatch v1 ephemerally against an authorized published graph.',
})
export type ArchitectureProposePatchInput = typeof ArchitectureProposePatchInput.Type

export const ArchitectureGraphMetadata = Schema.Struct({
  generatedAt: IsoDateTime,
  gitRef: Schema.optionalKey(TrimmedNonEmptyString),
})
export type ArchitectureGraphMetadata = typeof ArchitectureGraphMetadata.Type

export const ArchitectureBlastRadiusResult = Schema.Struct({
  version: ArchitectureVersion,
  graph: ArchitectureGraphMetadata,
  target: ArchitectureValueString,
  symbol: Schema.optionalKey(ArchitectureValueString),
  precision: Schema.Literals(['file', 'symbol-first-hop']),
  direction: ArchitectureBlastDirection,
  maxDepth: PositiveInt,
  upstream: ArchitectureBoundedList(ArchitectureValueString, ARCHITECTURE_BLAST_PATH_LIMIT),
  downstream: ArchitectureBoundedList(ArchitectureValueString, ARCHITECTURE_BLAST_PATH_LIMIT),
  impactedFileCount: NonNegativeInt,
})
export type ArchitectureBlastRadiusResult = typeof ArchitectureBlastRadiusResult.Type

export const ArchitectureEdgeEndpoints = Schema.Struct({
  from: ArchitectureValueString,
  to: ArchitectureValueString,
})
export type ArchitectureEdgeEndpoints = typeof ArchitectureEdgeEndpoints.Type

export const ArchitectureMoveFlow = Schema.Struct({
  from: ArchitectureValueString,
  to: ArchitectureValueString,
  count: PositiveInt,
})
export type ArchitectureMoveFlow = typeof ArchitectureMoveFlow.Type

export const ArchitectureViolationDelta = Schema.Struct({
  from: ArchitectureValueString,
  to: ArchitectureValueString,
  rule: ArchitectureValueString,
  severity: Schema.Literals(['error', 'warn', 'info']),
})
export type ArchitectureViolationDelta = typeof ArchitectureViolationDelta.Type

export const ArchitectureExportChange = Schema.Struct({
  name: ArchitectureValueString,
  typeOnly: Schema.optionalKey(Schema.Boolean),
  brokenConsumers: Schema.optionalKey(
    ArchitectureBoundedList(ArchitectureValueString, ARCHITECTURE_API_CONSUMER_LIMIT),
  ),
})
export type ArchitectureExportChange = typeof ArchitectureExportChange.Type

export const ArchitectureFileApiChange = Schema.Struct({
  file: ArchitectureValueString,
  addedExports: ArchitectureBoundedList(ArchitectureExportChange, ARCHITECTURE_API_EXPORT_LIMIT),
  removedExports: ArchitectureBoundedList(ArchitectureExportChange, ARCHITECTURE_API_EXPORT_LIMIT),
}).check(
  Schema.makeFilter(
    (value) =>
      value.addedExports.items.length + value.removedExports.items.length <=
        ARCHITECTURE_API_EXPORT_LIMIT ||
      `At most ${ARCHITECTURE_API_EXPORT_LIMIT} combined exports may be returned per file.`,
  ),
)
export type ArchitectureFileApiChange = typeof ArchitectureFileApiChange.Type

const ArchitectureGraphDiffFields = {
  version: ArchitectureVersion,
  summary: TrimmedNonEmptyString,
  base: ArchitectureGraphMetadata,
  head: ArchitectureGraphMetadata,
  changed: Schema.Boolean,
  addedNodes: ArchitectureBoundedList(ArchitectureValueString, ARCHITECTURE_RESULT_LIST_LIMIT),
  removedNodes: ArchitectureBoundedList(ArchitectureValueString, ARCHITECTURE_RESULT_LIST_LIMIT),
  addedEdges: ArchitectureBoundedList(ArchitectureEdgeEndpoints, ARCHITECTURE_RESULT_LIST_LIMIT),
  removedEdges: ArchitectureBoundedList(ArchitectureEdgeEndpoints, ARCHITECTURE_RESULT_LIST_LIMIT),
  movedNodes: ArchitectureBoundedList(ArchitectureEdgeEndpoints, ARCHITECTURE_RESULT_LIST_LIMIT),
  moveFlows: ArchitectureBoundedList(ArchitectureMoveFlow, ARCHITECTURE_RESULT_LIST_LIMIT),
  movedEdges: NonNegativeInt,
  apiChanges: ArchitectureBoundedList(ArchitectureFileApiChange, ARCHITECTURE_API_FILE_LIMIT),
  newViolations: ArchitectureBoundedList(
    ArchitectureViolationDelta,
    ARCHITECTURE_RESULT_LIST_LIMIT,
  ),
  resolvedViolations: ArchitectureBoundedList(
    ArchitectureViolationDelta,
    ARCHITECTURE_RESULT_LIST_LIMIT,
  ),
} as const

export const ArchitectureGraphDiffResult = Schema.Struct({
  ...ArchitectureGraphDiffFields,
  apiTotals: Schema.Struct({
    files: NonNegativeInt,
    addedExports: NonNegativeInt,
    removedExports: NonNegativeInt,
    brokenConsumers: NonNegativeInt,
  }),
})
export type ArchitectureGraphDiffResult = typeof ArchitectureGraphDiffResult.Type

const ArchitectureEmptyApiChanges = ArchitectureBoundedList(ArchitectureFileApiChange, 0).check(
  Schema.makeFilter(
    (value) =>
      (value.total === 0 && value.omitted === 0) ||
      'Patch evaluation never reports inferred API changes.',
  ),
)

export const ArchitecturePatchGraphDiffResult = Schema.Struct({
  ...ArchitectureGraphDiffFields,
  apiChanges: ArchitectureEmptyApiChanges,
})
export type ArchitecturePatchGraphDiffResult = typeof ArchitecturePatchGraphDiffResult.Type

export const ArchitecturePatchIssue = Schema.Struct({
  opIndex: NonNegativeInt,
  severity: Schema.Literals(['error', 'warning']),
  message: TrimmedNonEmptyString,
})
export type ArchitecturePatchIssue = typeof ArchitecturePatchIssue.Type

export const ArchitecturePatchCycle = Schema.Struct({
  from: ArchitectureValueString,
  to: ArchitectureValueString,
  path: ArchitectureBoundedList(ArchitectureValueString, ARCHITECTURE_RESULT_LIST_LIMIT),
})
export type ArchitecturePatchCycle = typeof ArchitecturePatchCycle.Type

export const ArchitecturePatchBoundary = Schema.Struct({
  from: ArchitectureValueString,
  to: ArchitectureValueString,
  baseCount: NonNegativeInt,
  headCount: PositiveInt,
  sample: ArchitectureBoundedList(ArchitectureEdgeEndpoints, ARCHITECTURE_RESULT_LIST_LIMIT),
}).check(
  Schema.makeFilter(
    (value) =>
      value.sample.total === value.headCount ||
      'Boundary sample total must equal the exact head edge count.',
  ),
)
export type ArchitecturePatchBoundary = typeof ArchitecturePatchBoundary.Type

export const ArchitecturePatchOrphan = Schema.Struct({
  file: ArchitectureValueString,
  kind: Schema.Literals(['becomes-orphan', 'added-unconnected']),
})
export type ArchitecturePatchOrphan = typeof ArchitecturePatchOrphan.Type

export const ArchitecturePatchValidation = Schema.Struct({
  cycles: ArchitectureBoundedList(ArchitecturePatchCycle, ARCHITECTURE_PATCH_CYCLE_LIMIT),
  newBoundaries: ArchitectureBoundedList(
    ArchitecturePatchBoundary,
    ARCHITECTURE_PATCH_BOUNDARY_LIMIT,
  ),
  orphans: ArchitectureBoundedList(ArchitecturePatchOrphan, ARCHITECTURE_PATCH_ORPHAN_LIMIT),
})
export type ArchitecturePatchValidation = typeof ArchitecturePatchValidation.Type

export const ArchitecturePatchStalenessReason = Schema.Literals([
  'generation-mismatch',
  'ref-mismatch',
  'dirty-tree',
])
export type ArchitecturePatchStalenessReason = typeof ArchitecturePatchStalenessReason.Type

export const ArchitecturePatchBaseline = Schema.Struct({
  generatedAt: Schema.optionalKey(IsoDateTime),
  gitRef: Schema.optionalKey(TrimmedNonEmptyString),
})
export type ArchitecturePatchBaseline = typeof ArchitecturePatchBaseline.Type

export const ArchitectureWorkingTreeState = Schema.Struct({
  gitRef: TrimmedNonEmptyString,
  dirty: Schema.Boolean,
})
export type ArchitectureWorkingTreeState = typeof ArchitectureWorkingTreeState.Type

export const ArchitecturePatchStaleness = Schema.Struct({
  stale: Schema.Boolean,
  reasons: Schema.Array(ArchitecturePatchStalenessReason).check(Schema.isMaxLength(3)),
  baseline: Schema.optionalKey(ArchitecturePatchBaseline),
  graph: ArchitectureGraphMetadata,
  workingTree: Schema.optionalKey(ArchitectureWorkingTreeState),
}).check(
  Schema.makeFilter(
    (value) =>
      value.stale === value.reasons.length > 0 ||
      'Staleness must match whether one or more reasons are present.',
  ),
)
export type ArchitecturePatchStaleness = typeof ArchitecturePatchStaleness.Type

export const ArchitectureProposePatchResult = Schema.Struct({
  version: ArchitectureVersion,
  summary: TrimmedNonEmptyString,
  issues: ArchitectureBoundedList(ArchitecturePatchIssue, ARCHITECTURE_PATCH_ISSUE_LIMIT),
  issueTotals: Schema.Struct({
    errors: NonNegativeInt,
    warnings: NonNegativeInt,
  }),
  validation: ArchitecturePatchValidation,
  diff: ArchitecturePatchGraphDiffResult,
  staleness: ArchitecturePatchStaleness,
}).check(
  Schema.makeFilter(
    (value) =>
      value.issueTotals.errors + value.issueTotals.warnings === value.issues.total ||
      'Issue severity totals must equal the exact issue total.',
  ),
)
export type ArchitectureProposePatchResult = typeof ArchitectureProposePatchResult.Type

export const ArchitectureToolErrorCode = Schema.Literals([
  'capability-unavailable',
  'identity-mismatch',
  'not-found',
  'context-not-ready',
  'target-not-found',
  'unsupported',
  'invalid-patch',
  'limit-exceeded',
  'evaluation-failed',
  'persistence-failed',
])
export type ArchitectureToolErrorCode = typeof ArchitectureToolErrorCode.Type

export const ArchitectureRecoveryAction = Schema.Literals([
  'prepare_current_worktree_architecture',
  'complete_proposal_analysis',
  'build_project_atlas',
  'complete_diff_analysis',
])
export type ArchitectureRecoveryAction = typeof ArchitectureRecoveryAction.Type

export const ArchitectureLimit = Schema.Struct({
  kind: Schema.Literals(['bytes', 'nodes', 'edges', 'work']),
  scope: Schema.Literals(['patch', 'base', 'head', 'evaluation', 'source']),
  actual: NonNegativeInt,
  limit: NonNegativeInt,
})
export type ArchitectureLimit = typeof ArchitectureLimit.Type

const ArchitectureToolErrorFields = Schema.Struct({
  operation: TrimmedNonEmptyString,
  code: ArchitectureToolErrorCode,
  detail: TrimmedNonEmptyString,
  recovery: Schema.optionalKey(ArchitectureRecoveryAction),
  limit: Schema.optionalKey(ArchitectureLimit),
}).check(
  Schema.makeFilter((value) =>
  {
    if (value.code === 'context-not-ready')
    {
      return (
        (value.recovery !== undefined && value.limit === undefined) ||
        'context-not-ready requires recovery and forbids limit details.'
      )
    }
    if (value.code === 'limit-exceeded')
    {
      return (
        (value.limit !== undefined && value.recovery === undefined) ||
        'limit-exceeded requires limit details and forbids recovery.'
      )
    }
    return (
      (value.recovery === undefined && value.limit === undefined) ||
      'Only context-not-ready may carry recovery and only limit-exceeded may carry limits.'
    )
  }),
)

export class ArchitectureToolError extends Schema.TaggedErrorClass<ArchitectureToolError>()(
  'ArchitectureToolError',
  ArchitectureToolErrorFields,
)
{
  override get message(): string
  {
    return `${this.operation}: ${this.detail}`
  }
}
