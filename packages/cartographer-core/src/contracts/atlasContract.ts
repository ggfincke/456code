// packages/cartographer-core/src/contracts/atlasContract.ts
// shared architecture metadata and query limits

export const ATLAS_INDEX_QUERY_LIMIT = 50

export interface SnapshotMeta
{
  id: number
  createdAt: string
  gitRef?: string
  scope: string
  nodes: number
  edges: number
  cycles: number
}

// live repo state beside the stored graph; omitted when git is unavailable
export interface WorkingTreeMeta
{
  gitRef: string
  dirty: boolean
}

export interface ProposalBaselineMeta
{
  generatedAt?: string
  gitRef?: string
}

export type ProposalStalenessReason = 'generation-mismatch' | 'ref-mismatch' | 'dirty-tree'

// one backend-produced verdict shared by proposal list/detail surfaces
export interface ProposalStalenessMeta
{
  stale: boolean
  reasons: ProposalStalenessReason[]
  baseline?: ProposalBaselineMeta
  graph: { generatedAt: string; gitRef?: string }
  workingTree?: WorkingTreeMeta
}

export interface PatchOpTotals
{
  addFiles: number
  removeFiles: number
  moves: number
  addImports: number
  removeImports: number
}

// one stored proposal in the patch listing; invalid files stay
// visible (hand-dropped JSON deserves a diagnosable row, not silence)
export interface PatchListEntry
{
  id: string
  name?: string
  description?: string
  author?: string
  createdAt?: string
  baseline?: ProposalBaselineMeta
  opTotals?: PatchOpTotals
  invalid?: { message: string }
  staleness?: ProposalStalenessMeta
}
