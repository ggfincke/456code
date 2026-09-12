export const ATLAS_INDEX_QUERY_LIMIT = 50;

export interface SnapshotMeta {
  id: number;
  createdAt: string;
  gitRef?: string;
  scope: string;
  nodes: number;
  edges: number;
  cycles: number;
}

// live repo state beside the stored graph; omitted when git is unavailable
export interface WorkingTreeMeta {
  gitRef: string;
  dirty: boolean;
}
