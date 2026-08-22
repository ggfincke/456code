// packages/cartographer-core/src/analyze/impactProjectionCodec.ts
// strictly decodes sealed semantic impact projection artifacts

import * as NodeCrypto from 'node:crypto'

import { z } from 'zod'

import {
  IMPACT_PROJECTION_EDGE_LIMIT,
  IMPACT_PROJECTION_EVIDENCE_LIMIT,
  IMPACT_PROJECTION_EVIDENCE_PATH_LIMIT,
  IMPACT_PROJECTION_LAYOUT_VERSION,
  IMPACT_PROJECTION_NODE_LIMIT,
  IMPACT_PROJECTION_SCHEMA_VERSION,
  type VerifiedImpactProjectionArtifact,
} from './impactProjection.js'

const RelativePathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      !value.includes('\0') &&
      value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
    'expected a repository-relative POSIX path',
  )

const SafeNonNegativeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .refine(Number.isSafeInteger, 'expected a safe nonnegative integer')
const SafePositiveIntegerSchema = z
  .number()
  .int()
  .positive()
  .refine(Number.isSafeInteger, 'expected a safe positive integer')

const CountSchema = z
  .object({
    total: SafeNonNegativeIntegerSchema,
    returned: SafeNonNegativeIntegerSchema,
    omitted: SafeNonNegativeIntegerSchema,
  })
  .strict()
  .refine((value) => value.total === value.returned + value.omitted, 'invalid exact count')

const PositionSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
  })
  .strict()

const StateSchema = z.enum(['added', 'removed', 'affected', 'context'])
const ChangedStateSchema = z.enum(['added', 'removed', 'affected'])
const LevelSchema = z.enum(['systems', 'blocks', 'dirs', 'files'])
const EvidencePathRefSchema = z
  .object({
    path: RelativePathSchema,
    side: z.enum(['base', 'head']),
  })
  .strict()

function semanticIdMatches(id: string, level: z.infer<typeof LevelSchema>): boolean
{
  if (id.includes('\0')) return false
  switch (level)
  {
    case 'systems':
      return id.startsWith('systems:') && id.length > 'systems:'.length
    case 'blocks':
      return id.startsWith('blocks:') && id.length > 'blocks:'.length
    case 'dirs':
    {
      if (!id.startsWith('dirs:')) return false
      const path = id.slice('dirs:'.length)
      return path === '.' || RelativePathSchema.safeParse(path).success
    }
    case 'files':
      return RelativePathSchema.safeParse(id).success
  }
}

function expectedParent(id: string, level: z.infer<typeof LevelSchema>): string | undefined
{
  if (level === 'systems') return undefined
  if (level === 'blocks') return undefined
  if (level === 'files')
  {
    const slash = id.lastIndexOf('/')
    return `dirs:${slash <= 0 ? '.' : id.slice(0, slash)}`
  }
  const path = id.slice('dirs:'.length)
  if (path === '.') return undefined
  const slash = path.lastIndexOf('/')
  return `dirs:${slash < 0 ? '.' : path.slice(0, slash)}`
}

function edgeId(from: string, to: string): string
{
  const digest = NodeCrypto.createHash('sha256')
  for (const value of [from, to, 'imports'])
  {
    digest.update(value)
    digest.update('\0')
  }
  return `edge:${digest.digest('hex')}`
}

function unique(values: readonly string[]): boolean
{
  return new Set(values).size === values.length
}

const EvidenceSchema = z
  .object({
    id: z.string().regex(/^evidence:[0-9a-f]{64}$/u),
    kind: z.enum(['file', 'relationship', 'api', 'violation', 'move']),
    state: ChangedStateSchema,
    label: z.string().min(1).max(4_000),
    paths: z
      .array(RelativePathSchema)
      .max(IMPACT_PROJECTION_EVIDENCE_PATH_LIMIT)
      .refine(unique, 'duplicate evidence path'),
    pathRefs: z
      .array(EvidencePathRefSchema)
      .max(IMPACT_PROJECTION_EVIDENCE_PATH_LIMIT * 2)
      .optional(),
  })
  .strict()
  .superRefine((value, context) =>
  {
    if (value.pathRefs === undefined) return
    const paths = new Set(value.paths)
    const refKeys = value.pathRefs.map((ref) => `${ref.side}\0${ref.path}`)
    if (!unique(refKeys))
    {
      context.addIssue({ code: 'custom', message: 'duplicate evidence path reference' })
    }
    if (value.pathRefs.some((ref) => !paths.has(ref.path)))
    {
      context.addIssue({ code: 'custom', message: 'evidence path reference is not returned' })
    }
    const referenced = new Set(value.pathRefs.map((ref) => ref.path))
    if (value.paths.some((path) => !referenced.has(path)))
    {
      context.addIssue({ code: 'custom', message: 'evidence path has no immutable source side' })
    }
  })

const NodeSchema = z
  .object({
    id: z.string().min(1).max(1_280),
    label: z.string().min(1).max(4_000),
    semanticLevel: LevelSchema,
    parentId: z.string().min(1).max(1_280).optional(),
    relativePath: RelativePathSchema.optional(),
    position: PositionSchema,
    tintKey: z.string().regex(/^[0-9a-f]{12}$/u),
    state: StateSchema,
    stateLabel: z.enum(['Added', 'Removed', 'Affected', 'Context']),
    badge: z.enum(['plus', 'minus', 'affected', 'context']),
    stroke: z.enum(['solid', 'dashed', 'double', 'muted']),
    fileCount: SafeNonNegativeIntegerSchema,
    inbound: SafeNonNegativeIntegerSchema,
    outbound: SafeNonNegativeIntegerSchema,
    affectedConsumerCount: SafeNonNegativeIntegerSchema,
    evidenceRefs: z
      .array(z.string().regex(/^evidence:[0-9a-f]{64}$/u))
      .max(IMPACT_PROJECTION_EVIDENCE_LIMIT)
      .refine(unique, 'duplicate node evidence reference'),
  })
  .strict()

const EdgeSchema = z
  .object({
    id: z.string().regex(/^edge:[0-9a-f]{64}$/u),
    from: z.string().min(1).max(1_280),
    to: z.string().min(1).max(1_280),
    relationshipKind: z.literal('imports'),
    weight: SafePositiveIntegerSchema,
    state: StateSchema,
    stateLabel: z.enum(['Added', 'Removed', 'Affected', 'Context']),
    stroke: z.enum(['solid', 'dashed', 'double', 'muted']),
    evidenceRefs: z
      .array(z.string().regex(/^evidence:[0-9a-f]{64}$/u))
      .max(IMPACT_PROJECTION_EVIDENCE_LIMIT)
      .refine(unique, 'duplicate edge evidence reference'),
  })
  .strict()

const BreadcrumbSchema = z
  .object({
    id: z.string().min(1).max(1_280),
    label: z.string().min(1).max(4_000),
    level: LevelSchema,
  })
  .strict()

const ArtifactSchema = z
  .object({
    version: z.literal(IMPACT_PROJECTION_SCHEMA_VERSION),
    kind: z.literal('impact-diff'),
    authority: z.literal('verified'),
    resultState: z.enum(['graph', 'no-impact']),
    generatedAt: z.string().datetime({ offset: true }),
    analyzerFingerprint: z
      .string()
      .regex(
        /^(?:sha256:[0-9a-f]{64}|@t3tools\/cartographer-core@[^\s:]+:dist-sha256:[0-9a-f]{64})$/u,
      ),
    baseGitRef: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u),
    headGitRef: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u),
    baseGraphDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    headGraphDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    rawImpactDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    implementationChangedFileCount: SafeNonNegativeIntegerSchema,
    lens: z.enum(['architecture', 'structure']),
    semanticLevel: LevelSchema,
    breadcrumbs: z.array(BreadcrumbSchema).max(32),
    layoutVersion: z.literal(IMPACT_PROJECTION_LAYOUT_VERSION),
    totals: z
      .object({
        nodes: CountSchema,
        edges: CountSchema,
        evidence: CountSchema,
        changedFiles: CountSchema,
      })
      .strict(),
    nodes: z.array(NodeSchema).max(IMPACT_PROJECTION_NODE_LIMIT),
    edges: z.array(EdgeSchema).max(IMPACT_PROJECTION_EDGE_LIMIT),
    evidence: z.array(EvidenceSchema).max(IMPACT_PROJECTION_EVIDENCE_LIMIT),
  })
  .strict()
  .superRefine((value, context) =>
  {
    const nodeIds = new Set(value.nodes.map((node) => node.id))
    const edgeIds = new Set(value.edges.map((edge) => edge.id))
    const evidenceIds = new Set(value.evidence.map((evidence) => evidence.id))
    if (nodeIds.size !== value.nodes.length)
      context.addIssue({ code: 'custom', message: 'duplicate node identity' })
    if (edgeIds.size !== value.edges.length)
      context.addIssue({ code: 'custom', message: 'duplicate edge identity' })
    if (evidenceIds.size !== value.evidence.length)
      context.addIssue({ code: 'custom', message: 'duplicate evidence identity' })
    if (
      value.totals.nodes.returned !== value.nodes.length ||
      value.totals.edges.returned !== value.edges.length ||
      value.totals.evidence.returned !== value.evidence.length ||
      value.totals.changedFiles.total !== value.implementationChangedFileCount ||
      value.totals.changedFiles.returned !== 0
    )
    {
      context.addIssue({ code: 'custom', message: 'returned arrays do not match exact totals' })
    }
    if (
      value.edges.some(
        (edge) =>
          !nodeIds.has(edge.from) ||
          !nodeIds.has(edge.to) ||
          edge.id !== edgeId(edge.from, edge.to) ||
          edge.evidenceRefs.some((ref) => !evidenceIds.has(ref)),
      ) ||
      value.nodes.some(
        (node) =>
          node.semanticLevel !== value.semanticLevel ||
          node.evidenceRefs.some((ref) => !evidenceIds.has(ref)) ||
          !semanticIdMatches(node.id, node.semanticLevel),
      )
    )
    {
      context.addIssue({ code: 'custom', message: 'projection cross-reference is missing' })
    }
    if (
      value.nodes.some((node) =>
      {
        const expected = expectedParent(node.id, node.semanticLevel)
        if (node.semanticLevel === 'blocks')
        {
          if (node.parentId === undefined || !semanticIdMatches(node.parentId, 'systems'))
            return true
        }
        else if (node.parentId !== expected)
        {
          return true
        }
        if (
          (node.semanticLevel === 'systems' || node.semanticLevel === 'blocks') &&
          node.relativePath !== undefined
        )
        {
          return true
        }
        if (node.semanticLevel === 'files' && node.relativePath !== node.id) return true
        if (
          node.semanticLevel === 'dirs' &&
          node.id !== 'dirs:.' &&
          node.relativePath !== node.id.slice('dirs:'.length)
        )
        {
          return true
        }
        return node.state === 'context'
          ? node.evidenceRefs.length > 0
          : node.evidenceRefs.length === 0 && value.totals.evidence.omitted === 0
      }) ||
      value.edges.some((edge) =>
      {
        const from = value.nodes.find((node) => node.id === edge.from)
        const to = value.nodes.find((node) => node.id === edge.to)
        return (
          from?.semanticLevel !== value.semanticLevel || to?.semanticLevel !== value.semanticLevel
        )
      })
    )
    {
      context.addIssue({ code: 'custom', message: 'semantic hierarchy or identity is invalid' })
    }
    const expectedTreatment = {
      added: ['Added', 'plus', 'solid'],
      removed: ['Removed', 'minus', 'dashed'],
      affected: ['Affected', 'affected', 'double'],
      context: ['Context', 'context', 'muted'],
    } as const
    if (
      value.nodes.some((node) =>
      {
        const expected = expectedTreatment[node.state]
        return (
          node.stateLabel !== expected[0] ||
          node.badge !== expected[1] ||
          node.stroke !== expected[2]
        )
      }) ||
      value.edges.some((edge) =>
      {
        const expected = expectedTreatment[edge.state]
        return edge.stateLabel !== expected[0] || edge.stroke !== expected[2]
      })
    )
    {
      context.addIssue({ code: 'custom', message: 'text and stroke treatment do not match state' })
    }
    if (
      (value.semanticLevel === 'systems' || value.semanticLevel === 'blocks') !==
      (value.lens === 'architecture')
    )
    {
      context.addIssue({ code: 'custom', message: 'lens does not match semantic level' })
    }
    const breadcrumbIds = new Set<string>()
    const breadcrumbOrder = { systems: 0, blocks: 1, dirs: 2, files: 3 } as const
    let priorLevel = -1
    for (const breadcrumb of value.breadcrumbs)
    {
      const order = breadcrumbOrder[breadcrumb.level]
      if (
        breadcrumbIds.has(breadcrumb.id) ||
        !semanticIdMatches(breadcrumb.id, breadcrumb.level) ||
        order < priorLevel ||
        order > breadcrumbOrder[value.semanticLevel]
      )
      {
        context.addIssue({ code: 'custom', message: 'breadcrumb continuity is invalid' })
        break
      }
      breadcrumbIds.add(breadcrumb.id)
      priorLevel = order
    }
    if (
      value.resultState === 'no-impact' &&
      (value.nodes.length > 0 ||
        value.edges.length > 0 ||
        value.evidence.length > 0 ||
        value.totals.nodes.total > 0 ||
        value.totals.edges.total > 0 ||
        value.totals.evidence.total > 0)
    )
    {
      context.addIssue({ code: 'custom', message: 'no-impact projection contains graph evidence' })
    }
    if (value.resultState === 'graph' && value.nodes.length === 0)
    {
      context.addIssue({ code: 'custom', message: 'graph projection has no returned nodes' })
    }
  })

export function parseVerifiedImpactProjection(value: unknown): VerifiedImpactProjectionArtifact
{
  return ArtifactSchema.parse(value) as VerifiedImpactProjectionArtifact
}
