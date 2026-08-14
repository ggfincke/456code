// packages/cartographer-core/src/contracts/types.ts
// shared graph json types for the current report schema

// syntactic declaration kind; absent for re-exports we don't resolve
export type ExportKind =
  'fn' | 'const' | 'class' | 'interface' | 'type' | 'enum' | 'namespace' | 'default'

// structured comment marker kinds: * important, ! warning, ? question, TODO
export type MarkerKind = 'important' | 'warning' | 'question' | 'todo'

// one structured marker line lifted out of comment prose
export interface CommentMarker
{
  kind: MarkerKind
  text: string
  // parsed from TODO(scope):; absent for bare TODO & the other kinds
  scope?: string
}

// one doc-comment tag line, e.g. "@deprecated use bar" -> name + value
export interface DocTag
{
  name: string
  value?: string
}

// a /** */ block doc attached to a declaration
export interface BlockDocumentation
{
  text: string
  // 'python-docstring' reserved for a future language-aware analyzer path
  syntax: 'tsdoc' | 'jsdoc' | 'python-docstring'
  tags?: DocTag[]
}

// plain-comment prose; a record (not a bare string) so source references
// can be added additively later
export interface CommentNote
{
  text: string
}

export interface ExportSymbol
{
  name: string
  // true -> interface/type alias/export type, compile-time only
  typeOnly?: boolean
  // true -> re-exported from another module, not declared here
  reExport?: boolean
  // declaration kind; present only for locally-declared exports
  kind?: ExportKind
  // one-line syntactic signature (declaration header, no body)
  signature?: string
  // declaration source text (capped); absent for re-exports
  def?: string
  // attached /** */ block doc, w/ tag lines captured instead of dropped
  documentation?: BlockDocumentation
  // attached plain-comment prose (marker & directive lines excluded)
  comments?: CommentNote[]
  // markers found in the attached comment run; each marker in a file lives
  // either here or in GraphNode.markers, never both
  markers?: CommentMarker[]
}

export interface GraphNode
{
  id: string
  kind: 'file'
  label: string
  group: string
  // optional authored system from the first matching config rule
  system?: string
  // absent when symbol extraction could not read this file
  exports?: ExportSymbol[]
  // one-liner from the file header comment or the annotations sidecar
  description?: string
  // true -> sidecar annotation whose content hash no longer matches
  descriptionStale?: true
  // where `description` came from; absent -> no description resolved
  descriptionSource?: 'header' | 'annotation-sidecar'
  // true -> the header's path line no longer matches the file's actual path
  // (file moved or renamed w/o updating the header)
  headerPathStale?: true
  // markers outside any exported declaration's attached comment run; see
  // the exactly-once invariant on ExportSymbol.markers
  markers?: CommentMarker[]
}

export interface GraphRule
{
  id: string
  from: string
  to: string
  verdict: 'forbid' | 'allow-only'
  // canonical array; readers accept the legacy authored string on input
  allowVia?: string[]
  severity: 'error' | 'warn' | 'info'
  why?: string
  enforcedBy?: {
    mechanism: string
    file?: string
    line?: number
    rule?: string
    // stamped at build time by citation verification; fileHash is the cited
    // file's content hash, so the citation ages out when that file changes
    status?: 'verified' | 'citation-missing' | 'citation-not-found'
    fileHash?: string
  }
  generated?: boolean
}

export interface GraphJourneyStop
{
  at: string
  title: string
  timing: 'immediate' | 'transaction' | 'deferred'
  why?: string
  // bounded file-id evidence for the authored glob; absent -> stale
  resolved?: string[]
  // exact build-time match count, incl. ids omitted from `resolved`
  resolvedTotal?: number
  // true -> the authored `at` matched no file in this graph
  stale?: true
  // static-import path to the PREVIOUS stop's nearest resolved file;
  // absent w/o hopDepthExceeded -> no static path (runtime/HTTP/worker boundary)
  hopDistance?: number
  hopVia?: string[]
  // true -> bounded search could not prove whether a deeper static path exists
  hopDepthExceeded?: true
}

export interface GraphJourney
{
  id: string
  title: string
  why?: string
  stops: GraphJourneyStop[]
}

// an authored process entry point (browser, worker, CLI, MCP server, ...)
// re-verified against this build; roots are authored because no static pass
// sees them -> a worker entry hangs off new Worker(new URL())
export interface GraphRuntime
{
  key: string
  label: string
  roots: string[]
  // bounded file-id evidence for the authored root globs
  resolved?: string[]
  // exact build-time match count, incl. ids omitted from `resolved`
  resolvedTotal?: number
  // true -> no root glob matched a file in this graph
  stale?: true
}

export interface GraphEdge
{
  id: string
  from: string
  to: string
  kind: 'imports'
  dynamic?: boolean
  // exported names the importer pulls; absent -> unknown (namespace/dynamic)
  symbols?: string[]
  // true -> the whole import is compile-time only (import type / all type-only
  // specifiers / type-only namespace); absent -> runtime or unknown boundary
  typeOnly?: true
  // subset of `symbols` imported w/ per-specifier `type` modality;
  // absent -> none or unknown
  typeSymbols?: string[]
  // authored or generated dependency rule ids violated by this import
  violations?: string[]
}

export interface GraphGroup
{
  id: string
  label: string
  description?: string
  fileCount: number
}

export interface GraphSystem
{
  id: string
  label: string
  description?: string
  fileCount: number
  source: 'authored' | 'fallback'
  // authored layering rank; lower = higher in the stack, absent = unranked
  rank?: number
}

export interface CoChangePair
{
  a: string
  b: string
  // commits touching both files
  count: number
  // count / min(changes a, changes b), 0-1
  strength: number
}

export interface GraphMetrics
{
  cycles: number
  orphans: number
  maxFanIn: number
  maxFanOut: number
}

// current graph.json schema version; v4 uses structured comment evidence only
export const GRAPH_SCHEMA_VERSION = 4

// every graph read path accepts only the current contract
export function assertGraphVersion(version: unknown, source: string): void
{
  if (version === GRAPH_SCHEMA_VERSION)
  {
    return
  }
  throw new Error(
    `${source} uses graph schema version ${String(version)}; ` +
      `this build requires version ${GRAPH_SCHEMA_VERSION} -> rebuild the graph`,
  )
}

export interface CartographerGraph
{
  version: typeof GRAPH_SCHEMA_VERSION
  repoRoot: string
  mode: 'imports'
  generatedAt: string
  gitRef?: string
  scope: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  groups: GraphGroup[]
  // build-time configuration staleness uses the existing marker vocabulary
  markers?: CommentMarker[]
  // authored system summaries; absent when no system rules resolve
  systems?: GraphSystem[]
  // authored & generated dependency rules evaluated while building this graph
  rules?: GraphRule[]
  // authored lifecycle narratives verified against this graph;
  // absent when no journeys are authored
  journeys?: GraphJourney[]
  // authored process entry points resolved against this graph;
  // absent when no runtimes are authored
  runtimes?: GraphRuntime[]
  // git co-change coupling pairs; absent outside git or when no pairs qualify
  coChanges?: CoChangePair[]
  metrics: GraphMetrics
}

export type AtlasIndexLevel = 'systems' | 'blocks' | 'dirs'

export interface AtlasIndexPositionHint
{
  x: number
  y: number
}

export interface AtlasIndexUnit
{
  id: string
  key: string
  level: AtlasIndexLevel
  label: string
  description?: string
  parent?: string
  source?: 'authored' | 'fallback' | 'inferred'
  fileCount: number
  inbound: number
  outbound: number
  visibilityRank: number
  order: number
  position: AtlasIndexPositionHint
}

export interface AtlasIndexEdge
{
  from: string
  to: string
  weight: number
}

export interface AtlasIndexEdgeCount
{
  total: number
  indexed: number
  omitted: number
}

export interface AtlasIndexScopeSummary
{
  parent: string
  childLevel: 'blocks' | 'dirs'
  children: AtlasIndexEdgeCount
  edges: AtlasIndexEdgeCount
}

export interface AtlasIndexHealth
{
  cycles: number
  orphans: number
  violatingImports: number
  violatedRules: number
  ruleTotal: number
}

export interface AtlasIndexFile
{
  id: string
  label: string
  description?: string
  system?: string
  block?: string
  dir?: string
  fanIn: number
  fanOut: number
  visibilityRank: number
}

export interface AtlasIndexCounts
{
  files: number
  imports: number
  systems: number
  blocks: number
  dirs: number
  indexedSystems: number
  indexedBlocks: number
  indexedDirs: number
}

// current derived navigation artifact schema
export const ATLAS_INDEX_SCHEMA_VERSION = 5

export type SourceGraphDigest = `sha256:${string}`

export interface AtlasIndex
{
  version: typeof ATLAS_INDEX_SCHEMA_VERSION
  sourceGeneratedAt: string
  sourceGraphDigest: SourceGraphDigest
  repo: {
    root: string
    name: string
    scope: string
    mode: 'imports'
    gitRef?: string
  }
  counts: AtlasIndexCounts
  systemSource: 'authored' | 'inferred'
  units: Record<AtlasIndexLevel, AtlasIndexUnit[]>
  edges: Record<AtlasIndexLevel, AtlasIndexEdge[]>
  edgeCounts: Record<AtlasIndexLevel, AtlasIndexEdgeCount>
  scopes: AtlasIndexScopeSummary[]
  health: AtlasIndexHealth
  files: AtlasIndexFile[]
}

export type AtlasIndexSummary = Omit<AtlasIndex, 'files'> & {
  topFiles: AtlasIndexFile[]
}

export interface AtlasIndexQuery
{
  level: AtlasIndexLevel
  parent?: string
  cursor?: string
  limit?: number
}

export interface AtlasIndexFileQuery
{
  parent?: { level: AtlasIndexLevel; id: string }
  search?: string
  cursor?: string
  limit?: number
}

export interface AtlasIndexPage<T>
{
  items: T[]
  total: number
  nextCursor?: string
}
