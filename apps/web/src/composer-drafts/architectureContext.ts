// apps/web/src/composer-drafts/architectureContext.ts
// owns bounded draft-only architecture concern snapshots and prompt transport

import {
  ArchitectureGraphProjectionExactCount,
  ArchitectureGraphProjectionSource,
  ArchitectureRelativePath,
  ArchitectureStandingAnchor,
  EnvironmentId,
  ThreadId,
  type ArchitectureGraphProjection,
  type ArchitectureGraphProjectionEdge,
  type ArchitectureGraphProjectionEvidence,
  type ArchitectureGraphProjectionNode,
} from '@t3tools/contracts'
import * as Schema from 'effect/Schema'

export const ARCHITECTURE_CONCERN_CONTEXT_LIMIT = 12
export const ARCHITECTURE_CONCERN_CONTEXT_MAX_BYTES = 32 * 1024
export const ARCHITECTURE_CONCERN_CONTEXT_TOTAL_MAX_BYTES = 128 * 1024
export const ARCHITECTURE_CONCERN_EVIDENCE_LIMIT = 24

const ARCHITECTURE_CONCERN_TEXT_LIMIT = 1_000
const ARCHITECTURE_CONCERN_ID_LIMIT = 1_280

const ArchitectureConcernId = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(ARCHITECTURE_CONCERN_ID_LIMIT),
)
const ArchitectureConcernText = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(ARCHITECTURE_CONCERN_TEXT_LIMIT),
)
const ArchitectureConcernState = Schema.Literals(['added', 'removed', 'affected', 'context'])
const ArchitectureConcernStateLabel = Schema.Literals(['Added', 'Removed', 'Affected', 'Context'])

function canonicalize(value: unknown): unknown
{
  if (Array.isArray(value))
  {
    return value.map(canonicalize)
  }
  if (value !== null && typeof value === 'object')
  {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    )
  }
  return value
}

function canonicalStringify(value: unknown): string
{
  return JSON.stringify(canonicalize(value))
}

function byteLength(value: string): number
{
  return new TextEncoder().encode(value).byteLength
}

function truncateText(value: string, limit = ARCHITECTURE_CONCERN_TEXT_LIMIT): string
{
  const normalized = value.trim()
  if (normalized.length <= limit) return normalized
  return `${normalized.slice(0, Math.max(0, limit - 1))}…`
}

function randomContextId(): string
{
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
  return `architecture:${Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')}`
}

const ArchitectureConcernNodeSelection = Schema.Struct({
  kind: Schema.Literal('node'),
  id: ArchitectureConcernId,
  label: ArchitectureConcernText,
  semanticLevel: Schema.Literals(['systems', 'blocks', 'dirs', 'files']),
  relativePath: Schema.optionalKey(ArchitectureRelativePath),
  state: ArchitectureConcernState,
  stateLabel: ArchitectureConcernStateLabel,
  fileCount: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  affectedConsumerCount: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
})

const ArchitectureConcernEdgeSelection = Schema.Struct({
  kind: Schema.Literal('edge'),
  id: ArchitectureConcernId,
  relationshipKind: ArchitectureConcernText,
  from: ArchitectureConcernId,
  to: ArchitectureConcernId,
  state: ArchitectureConcernState,
  stateLabel: ArchitectureConcernStateLabel,
  weight: Schema.Finite.check(Schema.isGreaterThan(0)),
})

export const ArchitectureConcernSelection = Schema.Union([
  ArchitectureConcernNodeSelection,
  ArchitectureConcernEdgeSelection,
])
export type ArchitectureConcernSelection = typeof ArchitectureConcernSelection.Type

const ArchitectureConcernEvidence = Schema.Struct({
  id: ArchitectureConcernId,
  kind: Schema.Literals(['file', 'relationship', 'api', 'violation', 'move', 'planned']),
  state: Schema.Literals(['added', 'removed', 'affected']),
  label: ArchitectureConcernText,
  paths: Schema.Array(ArchitectureRelativePath).check(Schema.isMaxLength(25)),
})

const ArchitectureConcernResource = Schema.Struct({
  kind: Schema.Literals(['repository-map', 'impact-diff']),
  projectionId: ArchitectureConcernId,
  projectionRevision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
})

const ArchitectureConcernOmissions = Schema.Struct({
  nodes: ArchitectureGraphProjectionExactCount,
  edges: ArchitectureGraphProjectionExactCount,
  evidence: ArchitectureGraphProjectionExactCount,
  changedFiles: ArchitectureGraphProjectionExactCount,
  selectionEvidence: ArchitectureGraphProjectionExactCount,
})

const ArchitectureConcernContextBase = Schema.Struct({
  version: Schema.Literal(1),
  id: ArchitectureConcernId,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  resource: ArchitectureConcernResource,
  authority: Schema.Literals(['standing', 'planned', 'verified']),
  authorityRef: ArchitectureGraphProjectionSource,
  selection: ArchitectureConcernSelection,
  anchor: Schema.optionalKey(ArchitectureStandingAnchor),
  evidence: Schema.Array(ArchitectureConcernEvidence).check(
    Schema.isMaxLength(ARCHITECTURE_CONCERN_EVIDENCE_LIMIT),
  ),
  freshness: Schema.Literals(['fresh', 'dirty', 'stale', 'reverted']),
  resultState: Schema.Literal('graph'),
  omissions: ArchitectureConcernOmissions,
  capturedAt: Schema.String.check(Schema.isNonEmpty()),
  dedupeKey: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(ARCHITECTURE_CONCERN_CONTEXT_MAX_BYTES),
  ),
})

export const ArchitectureConcernContextSchema = ArchitectureConcernContextBase.check(
  Schema.makeFilter((context) =>
  {
    const authority =
      context.authorityRef.kind === 'planned-impact'
        ? 'planned'
        : context.authorityRef.kind === 'standing-project-generation'
          ? 'standing'
          : 'verified'
    if (authority !== context.authority)
    {
      return 'Architecture concern authority must match its exact source.'
    }
    if (context.anchor !== undefined && context.anchor.selectionId !== context.selection.id)
    {
      return 'Architecture concern anchor must refer to the selected object.'
    }
    return (
      architectureConcernDedupKey(context) === context.dedupeKey ||
      'Architecture concern dedupe identity must be canonical.'
    )
  }),
)
export type ArchitectureConcernContext = typeof ArchitectureConcernContextSchema.Type

export type ArchitectureConcernGraphSelection =
  | { readonly kind: 'node'; readonly node: ArchitectureGraphProjectionNode }
  | { readonly kind: 'edge'; readonly edge: ArchitectureGraphProjectionEdge }

export type ArchitectureConcernAddResult = 'added' | 'duplicate' | 'limit' | 'invalid'

const decodeArchitectureConcernContext = Schema.decodeUnknownSync(
  ArchitectureConcernContextSchema,
  { onExcessProperty: 'error' },
)

export function architectureConcernDedupKey(
  context: Pick<
    ArchitectureConcernContext,
    'resource' | 'authority' | 'authorityRef' | 'selection'
  >,
): string
{
  return canonicalStringify({
    resource: context.resource,
    authority: context.authority,
    authorityRef: context.authorityRef,
    selectionId: context.selection.id,
  })
}

function normalizeEvidence(
  evidence: ReadonlyArray<ArchitectureGraphProjectionEvidence>,
): ArchitectureConcernContext['evidence']
{
  const stateOrder: Record<ArchitectureGraphProjectionEvidence['state'], number> = {
    added: 0,
    removed: 1,
    affected: 2,
  }
  return [...evidence]
    .sort((left, right) => stateOrder[left.state] - stateOrder[right.state])
    .slice(0, ARCHITECTURE_CONCERN_EVIDENCE_LIMIT)
    .map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      state: entry.state,
      label: truncateText(entry.label),
      paths: [...entry.paths],
    }))
}

function concernSelection(
  selection: ArchitectureConcernGraphSelection,
): ArchitectureConcernSelection
{
  if (selection.kind === 'node')
  {
    return {
      kind: 'node',
      id: selection.node.id,
      label: truncateText(selection.node.label),
      semanticLevel: selection.node.semanticLevel,
      ...(selection.node.relativePath === undefined
        ? {}
        : { relativePath: selection.node.relativePath }),
      state: selection.node.state,
      stateLabel: selection.node.stateLabel,
      fileCount: selection.node.fileCount,
      affectedConsumerCount: selection.node.affectedConsumerCount,
    }
  }
  return {
    kind: 'edge',
    id: selection.edge.id,
    relationshipKind: truncateText(selection.edge.relationshipKind),
    from: selection.edge.from,
    to: selection.edge.to,
    state: selection.edge.state,
    stateLabel: selection.edge.stateLabel,
    weight: selection.edge.weight,
  }
}

function selectedEvidenceRefs(selection: ArchitectureConcernGraphSelection): readonly string[]
{
  return selection.kind === 'node' ? selection.node.evidenceRefs : selection.edge.evidenceRefs
}

export function createArchitectureConcernContext(input: {
  readonly environmentId: EnvironmentId
  readonly threadId: ThreadId
  readonly projection: ArchitectureGraphProjection
  readonly selection: ArchitectureConcernGraphSelection
  readonly capturedAt?: string | undefined
}): ArchitectureConcernContext | null
{
  if (input.projection.resultState !== 'graph') return null
  const evidenceRefs = selectedEvidenceRefs(input.selection)
  const evidenceById = new Map(input.projection.evidence.map((entry) => [entry.id, entry] as const))
  const referencedEvidence = evidenceRefs.flatMap((reference) =>
  {
    const evidence = evidenceById.get(reference)
    return evidence === undefined ? [] : [evidence]
  })
  let evidence = normalizeEvidence(referencedEvidence)
  const selection = concernSelection(input.selection)
  const sourceAnchor = input.projection.anchors.find(
    (candidate) => candidate.selectionId === selection.id,
  )
  const anchor =
    sourceAnchor === undefined
      ? undefined
      : {
          ...sourceAnchor,
          candidateIds: [...sourceAnchor.candidateIds],
          candidateCount: { ...sourceAnchor.candidateCount },
          disclosure: truncateText(sourceAnchor.disclosure),
        }
  const resource = {
    kind: input.projection.kind,
    projectionId: input.projection.projectionId,
    projectionRevision: input.projection.projectionRevision,
  } as const
  const base = {
    version: 1 as const,
    id: randomContextId(),
    environmentId: input.environmentId,
    threadId: input.threadId,
    resource,
    authority: input.projection.authority,
    authorityRef: input.projection.source,
    selection,
    ...(anchor === undefined ? {} : { anchor }),
    freshness: input.projection.freshness,
    resultState: 'graph' as const,
    capturedAt: input.capturedAt ?? new Date().toISOString(),
  }
  const dedupeKey = architectureConcernDedupKey(base)
  const buildContext = (
    currentEvidence: ArchitectureConcernContext['evidence'],
  ): ArchitectureConcernContext =>
  {
    return {
      ...base,
      evidence: currentEvidence,
      omissions: {
        ...input.projection.totals,
        selectionEvidence: {
          total: evidenceRefs.length,
          returned: currentEvidence.length,
          omitted: Math.max(0, evidenceRefs.length - currentEvidence.length),
        },
      },
      dedupeKey,
    }
  }
  let context = buildContext(evidence)

  while (
    evidence.length > 0 &&
    byteLength(canonicalStringify(context)) > ARCHITECTURE_CONCERN_CONTEXT_MAX_BYTES
  )
  {
    evidence = evidence.slice(0, -1)
    context = buildContext(evidence)
  }
  return normalizeArchitectureConcernContext(context)
}

export function normalizeArchitectureConcernContext(
  value: unknown,
): ArchitectureConcernContext | null
{
  try
  {
    const decoded = decodeArchitectureConcernContext(value)
    const canonical = canonicalStringify(decoded)
    if (byteLength(canonical) > ARCHITECTURE_CONCERN_CONTEXT_MAX_BYTES) return null
    return JSON.parse(canonical) as ArchitectureConcernContext
  }
  catch
  {
    return null
  }
}

export function normalizeArchitectureConcernContexts(value: unknown): ArchitectureConcernContext[]
{
  if (!Array.isArray(value)) return []
  const contexts: ArchitectureConcernContext[] = []
  const dedupeKeys = new Set<string>()
  let totalBytes = 0
  for (const candidate of value)
  {
    const context = normalizeArchitectureConcernContext(candidate)
    if (context === null || dedupeKeys.has(context.dedupeKey)) continue
    const contextBytes = byteLength(canonicalStringify(context))
    if (
      contexts.length >= ARCHITECTURE_CONCERN_CONTEXT_LIMIT ||
      totalBytes + contextBytes > ARCHITECTURE_CONCERN_CONTEXT_TOTAL_MAX_BYTES
    )
    {
      continue
    }
    contexts.push(context)
    dedupeKeys.add(context.dedupeKey)
    totalBytes += contextBytes
  }
  return contexts
}

function quoteArchitectureContext(context: ArchitectureConcernContext): string
{
  const canonical = canonicalStringify(context)
  return JSON.stringify(canonical)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')
}

export function buildArchitectureContextBlock(context: ArchitectureConcernContext): string
{
  return [
    '<architecture_context>',
    quoteArchitectureContext(context),
    '</architecture_context>',
  ].join('\n')
}

export function appendArchitectureContextsToPrompt(
  prompt: string,
  contexts: ReadonlyArray<ArchitectureConcernContext>,
): string
{
  return normalizeArchitectureConcernContexts(contexts).reduce((text, context) =>
  {
    const block = buildArchitectureContextBlock(context)
    const trimmed = text.trim()
    return trimmed.length > 0 ? `${trimmed}\n\n${block}` : block
  }, prompt)
}

const TRAILING_ARCHITECTURE_CONTEXT_PATTERN =
  /\n*<architecture_context>\n((?:(?!<architecture_context>)[\s\S])*)\n<\/architecture_context>\s*$/u

export function extractTrailingArchitectureContext(prompt: string): {
  readonly promptText: string
  readonly context: ArchitectureConcernContext | null
}
{
  const match = TRAILING_ARCHITECTURE_CONTEXT_PATTERN.exec(prompt)
  if (!match) return { promptText: prompt, context: null }
  try
  {
    const quoted = JSON.parse((match[1] ?? '').trim())
    if (typeof quoted !== 'string') return { promptText: prompt, context: null }
    const context = normalizeArchitectureConcernContext(JSON.parse(quoted))
    if (context === null) return { promptText: prompt, context: null }
    return {
      promptText: prompt.slice(0, match.index).replace(/\n+$/u, ''),
      context,
    }
  }
  catch
  {
    return { promptText: prompt, context: null }
  }
}

export function formatArchitectureConcernLabel(context: ArchitectureConcernContext): string
{
  return context.selection.kind === 'node'
    ? context.selection.label
    : context.selection.relationshipKind
}

export function formatArchitectureConcernAuthority(context: ArchitectureConcernContext): string
{
  switch (context.authority)
  {
    case 'planned':
      return 'Planned Impact'
    case 'verified':
      return 'Verified Impact'
    case 'standing':
      return 'Repository Map'
  }
}

export function formatArchitectureConcernTooltip(context: ArchitectureConcernContext): string
{
  const lines = [
    formatArchitectureConcernLabel(context),
    `${formatArchitectureConcernAuthority(context)} · ${context.selection.stateLabel} · ${context.freshness}`,
  ]
  if (context.anchor)
  {
    lines.push(`${context.anchor.status}: ${context.anchor.disclosure}`)
  }
  if (context.evidence.length > 0)
  {
    lines.push('')
    lines.push(...context.evidence.slice(0, 4).map((evidence) => evidence.label))
    if (context.evidence.length > 4)
    {
      lines.push(`+${context.evidence.length - 4} more evidence references`)
    }
  }
  if (context.omissions.selectionEvidence.omitted > 0)
  {
    lines.push(`${context.omissions.selectionEvidence.omitted} evidence references omitted`)
  }
  return lines.join('\n')
}
