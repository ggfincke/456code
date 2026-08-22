// apps/server/src/cartographer/ArchitectureQueryService.ts
// resolves authorized published graphs for bounded architecture agent queries

// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFSP from 'node:fs/promises'
import * as NodePath from 'node:path'
import * as NodeCrypto from 'node:crypto'

import {
  ARCHITECTURE_API_CONSUMER_LIMIT,
  ARCHITECTURE_API_EXPORT_LIMIT,
  ARCHITECTURE_API_FILE_LIMIT,
  ARCHITECTURE_BLAST_PATH_LIMIT,
  ARCHITECTURE_PATCH_BOUNDARY_LIMIT,
  ARCHITECTURE_PATCH_CYCLE_LIMIT,
  ARCHITECTURE_PATCH_ISSUE_LIMIT,
  ARCHITECTURE_PATCH_MAX_BYTES,
  ARCHITECTURE_PATCH_ORPHAN_LIMIT,
  ARCHITECTURE_RESULT_LIST_LIMIT,
  ArchitectureToolError,
  type ArchitectureBlastRadiusInput,
  type ArchitectureBlastRadiusResult,
  type ArchitectureComparisonSelector,
  type ArchitectureFileApiChange,
  type ArchitectureGraphDiffResult,
  type ArchitectureGraphProjection,
  type ArchitectureGraphProjectionSemanticLevel,
  type ArchitectureImpactDescriptor,
  type ArchitectureImpactPlannedCandidate,
  type ArchitectureImpactProjectionRequest,
  type ArchitectureImpactProjectionResult,
  type ArchitectureImpactVerifiedCandidate,
  type ArchitectureStandingSource,
  type ArchitectureStandingAnchor,
  type ArchitecturePlannedImpactPlanIdentity,
  type PlannedImpactMaterializedProjection,
  type Proposal,
  type ProposalRevision,
  type ArchitectureGraphMetadata,
  type ArchitectureGraphSelector,
  type ArchitecturePatchContextSelector,
  type ArchitecturePatchGraphDiffResult,
  type ArchitecturePatchStaleness,
  type ArchitectureProposePatchInput,
  type ArchitectureProposePatchResult,
  type ArchitectureRecoveryAction,
  type ArchitectureToolErrorCode,
  type EnvironmentId,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type ThreadId,
  type TurnId,
} from '@t3tools/contracts'
import {
  boundApiChanges,
  boundList,
  boundPatchValidation,
  ContextQueryError,
  evaluatePatch,
  formatDiffSummary,
  loadContextQuery,
  parseGraphPatch,
  patchNodeResolver,
  PatchEvaluationLimitError,
  PatchSizeError,
  proposalStaleness,
  queryContextDiff,
  queryContextImpact,
  serializePatch,
  workingTreeState,
  type ContextQueryGraph,
  type GraphDiff,
  type VerifiedImpactProjectionArtifact,
} from '@t3tools/cartographer-core/server'
import * as Context from 'effect/Context'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import type * as Scope from 'effect/Scope'

import * as ServerEnvironment from '../environment/ServerEnvironment.ts'
import * as PlannedImpactService from '../architecture/PlannedImpactService.ts'
import * as ProjectAtlasStatusBroadcaster from './ProjectAtlasStatusBroadcaster.ts'
import {
  architectureImpactReadDuration,
  architectureGraphViewErrorMetricAttributes,
  architectureGraphViewMetricAttributes,
  architectureGraphViewsTotal,
  architecturePatchEvaluationDuration,
  increment,
  withMetrics,
} from '../observability/Metrics.ts'
import * as ProjectionSnapshotQuery from '../orchestration/Services/ProjectionSnapshotQuery.ts'
import * as ProposalGenerationService from '../proposal/ProposalGenerationService.ts'
import * as ProposalService from '../proposal/ProposalService.ts'
import * as AtlasRebuildService from './AtlasRebuildService.ts'
import * as CurrentWorktreeArchitectureService from './CurrentWorktreeArchitectureService.ts'
import * as DiffAnalysisService from './DiffAnalysisService.ts'
import {
  resolveImpactStandingAnchors,
  unavailableImpactStandingAnchors,
} from './architectureStandingAnchors.ts'

const ARCHITECTURE_GRAPH_CACHE_MAX_ENTRIES = 4
const ARCHITECTURE_GRAPH_CACHE_MAX_BYTES = 128 * 1024 * 1024

export interface ArchitectureQueryAuthority
{
  readonly environmentId: EnvironmentId
  readonly threadId: ThreadId
  readonly activeTurnId?: TurnId
}

export interface ResolvedArchitectureContext
{
  readonly root: string
  readonly outDir: string
  readonly graphPath: string
  readonly liveRoot?: string
}

interface AuthorizedThreadContext
{
  readonly environmentId: EnvironmentId
  readonly thread: OrchestrationThread
  readonly project: OrchestrationProjectShell
  readonly workspaceRoot: string
}

interface LinkedProposal
{
  readonly proposal: Proposal
  readonly revision: ProposalRevision
}

interface ResolvedGraphPair
{
  readonly base: ResolvedArchitectureContext
  readonly head: ResolvedArchitectureContext
  readonly impactPath: string
}

interface GraphFileStamp
{
  readonly ino: bigint
  readonly mtimeNs: bigint
  readonly size: bigint
}

interface GraphCacheEntry
{
  readonly context: ContextQueryGraph
  readonly serializedBytes: number
}

export interface ArchitectureQueryServiceOptions
{
  readonly loadGraph?: (graphPath: string) => ContextQueryGraph
}

export interface ResolvedArchitectureBlastTarget
{
  readonly context: ResolvedArchitectureContext
  readonly recovery: ArchitectureRecoveryAction
}

export interface ArchitectureQueryServiceShape
{
  readonly resolveContext: (
    authority: ArchitectureQueryAuthority,
    selector: ArchitectureGraphSelector | ArchitecturePatchContextSelector,
  ) => Effect.Effect<ResolvedArchitectureContext, ArchitectureToolError, Scope.Scope>
  readonly blastRadius: (
    authority: ArchitectureQueryAuthority,
    input: ArchitectureBlastRadiusInput,
    resolvedTarget?: ResolvedArchitectureBlastTarget,
  ) => Effect.Effect<ArchitectureBlastRadiusResult, ArchitectureToolError>
  readonly graphDiff: (
    authority: ArchitectureQueryAuthority,
    input: { readonly comparison: ArchitectureComparisonSelector },
  ) => Effect.Effect<ArchitectureGraphDiffResult, ArchitectureToolError>
  readonly architectureImpactProjection: (
    authority: ArchitectureQueryAuthority,
    input: ArchitectureImpactProjectionRequest,
  ) => Effect.Effect<ArchitectureImpactProjectionResult, ArchitectureToolError>
  readonly proposePatch: (
    authority: ArchitectureQueryAuthority,
    input: ArchitectureProposePatchInput,
  ) => Effect.Effect<ArchitectureProposePatchResult, ArchitectureToolError>
}

export class ArchitectureQueryService extends Context.Service<
  ArchitectureQueryService,
  ArchitectureQueryServiceShape
>()('456code/cartographer/ArchitectureQueryService')
{}

function architectureError(
  operation: string,
  code: ArchitectureToolErrorCode,
  detail: string,
  options?:
    | { readonly recovery: ArchitectureRecoveryAction }
    | {
        readonly limit: {
          readonly kind: 'bytes' | 'nodes' | 'edges' | 'work'
          readonly scope: 'patch' | 'base' | 'head' | 'evaluation'
          readonly actual: number
          readonly limit: number
        }
      },
): ArchitectureToolError
{
  return new ArchitectureToolError({
    operation,
    code,
    detail,
    ...(options === undefined ? {} : options),
  })
}

function graphMetadata(context: ContextQueryGraph): ArchitectureGraphMetadata
{
  return {
    generatedAt: context.graph.generatedAt,
    ...(context.graph.gitRef === undefined ? {} : { gitRef: context.graph.gitRef }),
  }
}

function bounded<T>(items: readonly T[], limit: number)
{
  return boundList(items, limit)
}

function projectApiChanges(
  diff: GraphDiff,
): Pick<ArchitectureGraphDiffResult, 'apiChanges' | 'apiTotals'>
{
  const evidence = boundApiChanges(diff.apiChanges, {
    files: ARCHITECTURE_API_FILE_LIMIT,
    exportsPerFile: ARCHITECTURE_API_EXPORT_LIMIT,
    consumersPerExport: ARCHITECTURE_API_CONSUMER_LIMIT,
  })
  const originals = new Map(diff.apiChanges.map((change) => [change.file, change]))
  const items = evidence.files.map((file): ArchitectureFileApiChange =>
  {
    const original = originals.get(file.file)
    if (original === undefined)
    {
      throw new Error(`Bounded API evidence lost source file '${file.file}'.`)
    }
    const projectExport = (
      entry: (typeof file.addedExports)[number],
    ): ArchitectureFileApiChange['addedExports']['items'][number] => ({
      name: entry.item.name,
      ...(entry.item.typeOnly === undefined ? {} : { typeOnly: entry.item.typeOnly }),
      ...(entry.item.brokenConsumers === undefined
        ? {}
        : {
            brokenConsumers: {
              items: entry.item.brokenConsumers,
              total: entry.totalConsumers,
              omitted: entry.omittedConsumers,
            },
          }),
    })
    const addedExports = file.addedExports.map(projectExport)
    const removedExports = file.removedExports.map(projectExport)
    return {
      file: file.file,
      addedExports: {
        items: addedExports,
        total: original.addedExports.length,
        omitted: original.addedExports.length - addedExports.length,
      },
      removedExports: {
        items: removedExports,
        total: original.removedExports.length,
        omitted: original.removedExports.length - removedExports.length,
      },
    }
  })
  return {
    apiChanges: {
      items,
      total: diff.apiChanges.length,
      omitted: diff.apiChanges.length - items.length,
    },
    apiTotals: {
      files: evidence.totals.files,
      addedExports: evidence.totals.addedExports,
      removedExports: evidence.totals.removedExports,
      brokenConsumers: evidence.totals.consumers,
    },
  }
}

function projectGraphDiff(diff: GraphDiff, patchEvaluation: false): ArchitectureGraphDiffResult
function projectGraphDiff(diff: GraphDiff, patchEvaluation: true): ArchitecturePatchGraphDiffResult
function projectGraphDiff(
  diff: GraphDiff,
  patchEvaluation: boolean,
): ArchitectureGraphDiffResult | ArchitecturePatchGraphDiffResult
{
  const fields = {
    version: 1 as const,
    summary: formatDiffSummary(diff),
    base: {
      generatedAt: diff.baseGeneratedAt,
      ...(diff.baseGitRef === undefined ? {} : { gitRef: diff.baseGitRef }),
    },
    head: {
      generatedAt: diff.headGeneratedAt,
      ...(diff.headGitRef === undefined ? {} : { gitRef: diff.headGitRef }),
    },
    changed: diff.changed,
    addedNodes: bounded(diff.addedNodes, ARCHITECTURE_RESULT_LIST_LIMIT),
    removedNodes: bounded(diff.removedNodes, ARCHITECTURE_RESULT_LIST_LIMIT),
    addedEdges: bounded(diff.addedEdges, ARCHITECTURE_RESULT_LIST_LIMIT),
    removedEdges: bounded(diff.removedEdges, ARCHITECTURE_RESULT_LIST_LIMIT),
    movedNodes: bounded(diff.movedNodes, ARCHITECTURE_RESULT_LIST_LIMIT),
    moveFlows: bounded(diff.moveFlows, ARCHITECTURE_RESULT_LIST_LIMIT),
    movedEdges: diff.movedEdges,
    newViolations: bounded(diff.newViolations, ARCHITECTURE_RESULT_LIST_LIMIT),
    resolvedViolations: bounded(diff.resolvedViolations, ARCHITECTURE_RESULT_LIST_LIMIT),
  }
  return patchEvaluation
    ? {
        ...fields,
        apiChanges: { items: [], total: 0, omitted: 0 },
      }
    : {
        ...fields,
        ...projectApiChanges(diff),
      }
}

function stampEquals(left: GraphFileStamp, right: GraphFileStamp): boolean
{
  return left.ino === right.ino && left.mtimeNs === right.mtimeNs && left.size === right.size
}

function stampKey(path: string, stamp: GraphFileStamp): string
{
  return `${path}\u0000${stamp.ino}\u0000${stamp.mtimeNs}\u0000${stamp.size}`
}

function recoveryForSelector(
  selector: ArchitectureGraphSelector | ArchitecturePatchContextSelector,
): ArchitectureRecoveryAction
{
  switch (selector.kind)
  {
    case 'current-thread-worktree':
      return 'prepare_current_worktree_architecture'
    case 'proposal-generation':
      return 'complete_proposal_analysis'
    case 'standing-project':
      return 'build_project_atlas'
    case 'diff-analysis':
      return 'complete_diff_analysis'
  }
}

function contextNotReady(
  operation: string,
  selector: ArchitectureGraphSelector | ArchitecturePatchContextSelector,
): ArchitectureToolError
{
  return architectureError(
    operation,
    'context-not-ready',
    'The selected architecture context is not ready or is no longer retained.',
    { recovery: recoveryForSelector(selector) },
  )
}

function projectionDigest(value: unknown): string
{
  return NodeCrypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
}

function exactProjectionCount(total: number, returned: number)
{
  return { total, returned, omitted: total - returned }
}

function projectionTreatment(state: 'added' | 'removed' | 'affected' | 'context')
{
  switch (state)
  {
    case 'added':
      return { stateLabel: 'Added' as const, badge: 'plus' as const, stroke: 'solid' as const }
    case 'removed':
      return { stateLabel: 'Removed' as const, badge: 'minus' as const, stroke: 'dashed' as const }
    case 'affected':
      return {
        stateLabel: 'Affected' as const,
        badge: 'affected' as const,
        stroke: 'double' as const,
      }
    case 'context':
      return { stateLabel: 'Context' as const, badge: 'context' as const, stroke: 'muted' as const }
  }
}

function plannedSemanticLevel(value: string): ArchitectureGraphProjectionSemanticLevel
{
  const normalized = value.trim().toLowerCase()
  if (normalized === 'system' || normalized === 'systems') return 'systems'
  if (
    normalized === 'block' ||
    normalized === 'blocks' ||
    normalized === 'component' ||
    normalized === 'module' ||
    normalized === 'service'
  )
    return 'blocks'
  if (
    normalized === 'dir' ||
    normalized === 'directory' ||
    normalized === 'package' ||
    normalized === 'folder'
  )
    return 'dirs'
  return 'files'
}

function plannedProjectionLevel(
  projection: PlannedImpactMaterializedProjection,
): ArchitectureGraphProjectionSemanticLevel
{
  const levels = new Set(projection.nodes.map((node) => plannedSemanticLevel(node.semanticLevel)))
  if (levels.has('systems')) return 'systems'
  if (levels.has('blocks')) return 'blocks'
  if (levels.has('dirs')) return 'dirs'
  return 'files'
}

function projectPlannedImpact(input: {
  stored: PlannedImpactService.PlannedImpactStored
  projection: PlannedImpactMaterializedProjection
  planState: 'active' | 'superseded' | 'reverted'
  newerProjectionId?: string
}): ArchitectureGraphProjection
{
  const level = plannedProjectionLevel(input.projection)
  const publication = input.stored.publication
  const source = {
    kind: 'planned-impact' as const,
    environmentId: publication.environmentId,
    projectId: publication.projectId,
    threadId: publication.sourceThreadId,
    plan: publication.plan,
    publication: {
      publicationId: publication.publicationId,
      publicationRevision: publication.publicationRevision,
      contentDigest: publication.contentDigest,
    },
    projection: {
      projectionId: input.projection.projectionId,
      projectionRevision: input.projection.projectionRevision,
      materialization: input.projection.materialization,
    },
  }
  const nodeEvidence = new Map(
    input.projection.nodes.map((node) => [
      node.id,
      `planned-evidence:${projectionDigest(['node', node.id])}`,
    ]),
  )
  const edgeEvidence = new Map(
    input.projection.edges.map((edge) => [
      edge.id,
      `planned-evidence:${projectionDigest(['edge', edge.id])}`,
    ]),
  )
  const evidence = [
    ...input.projection.nodes.map((node) => ({
      id: nodeEvidence.get(node.id)!,
      kind: 'planned' as const,
      state: node.state,
      label: node.description ?? node.label,
      paths: [...new Set(node.pathHints)].slice(0, 25),
    })),
    ...input.projection.edges.map((edge) => ({
      id: edgeEvidence.get(edge.id)!,
      kind: 'planned' as const,
      state: edge.state,
      label: edge.rationale ?? `${edge.relationshipKind} relationship`,
      paths: [...new Set(edge.pathHints)].slice(0, 25),
    })),
  ]
  const nodes = input.projection.nodes.map((node) => ({
    id: node.id,
    label: node.label,
    semanticLevel: plannedSemanticLevel(node.semanticLevel),
    ...(node.pathHints.length === 1 ? { relativePath: node.pathHints[0]! } : {}),
    position: node.position,
    tintKey: node.tintKey,
    state: node.state,
    ...projectionTreatment(node.state),
    fileCount: node.pathHints.length,
    inbound: input.projection.edges.filter((edge) => edge.to === node.id).length,
    outbound: input.projection.edges.filter((edge) => edge.from === node.id).length,
    affectedConsumerCount: 0,
    evidenceRefs: [nodeEvidence.get(node.id)!],
  }))
  const edges = input.projection.edges.map((edge) => ({
    id: edge.id,
    from: edge.from,
    to: edge.to,
    relationshipKind: edge.relationshipKind,
    weight: edge.weight ?? 1,
    state: edge.state,
    stateLabel: projectionTreatment(edge.state).stateLabel,
    stroke: projectionTreatment(edge.state).stroke,
    evidenceRefs: [edgeEvidence.get(edge.id)!],
  }))
  const standingSource: ArchitectureStandingSource | undefined =
    input.projection.standingSource === undefined
      ? undefined
      : {
          kind: 'standing-project-generation',
          projectId: input.projection.standingSource.projectId,
          generationId: input.projection.standingSource.generationId as never,
          side: 'analyzed',
          graphDigest: input.projection.standingSource.graphDigest as never,
        }
  const nodeIdByLocalId = new Map(input.projection.nodes.map((node) => [node.localId, node.id]))
  const edgeIdByLocalId = new Map(input.projection.edges.map((edge) => [edge.localId, edge.id]))
  const anchors: ArchitectureStandingAnchor[] =
    standingSource === undefined
      ? []
      : (input.projection.standingAnchors ?? []).flatMap((anchor) =>
        {
          const selectionId =
            anchor.selectionKind === 'object'
              ? nodeIdByLocalId.get(anchor.localId)
              : edgeIdByLocalId.get(anchor.localId)
          if (selectionId === undefined) return []
          return [
            {
              selectionId,
              status: anchor.status,
              source: standingSource,
              lens: anchor.lens,
              candidateIds: [...anchor.candidateIds],
              candidateCount: { ...anchor.candidateCount },
              ...(anchor.focusId === undefined ? {} : { focusId: anchor.focusId }),
              ...(anchor.nearestId === undefined ? {} : { nearestId: anchor.nearestId }),
              disclosure: anchor.disclosure,
            },
          ]
        })
  const claimedNodes = publication.claims.omissions.changedObjects
  const claimedEdges = publication.claims.omissions.relationships
  const claimedPaths = publication.claims.omissions.pathHints
  return {
    projectionVersion: 1,
    projectionId: input.projection.projectionId,
    projectionRevision: input.projection.projectionRevision,
    kind: 'impact-diff',
    authority: 'planned',
    resultState: input.projection.resultState,
    freshness:
      input.planState === 'reverted'
        ? 'reverted'
        : input.planState === 'superseded'
          ? 'stale'
          : 'fresh',
    generatedAt: input.projection.createdAt,
    publishedAt: publication.createdAt,
    source,
    lens: level === 'systems' || level === 'blocks' ? 'architecture' : 'structure',
    semanticLevel: level,
    breadcrumbs: [],
    layoutVersion: 'planned-impact-v1',
    totals: {
      nodes: exactProjectionCount(claimedNodes.total, nodes.length),
      edges: exactProjectionCount(claimedEdges.total, edges.length),
      evidence: exactProjectionCount(claimedNodes.total + claimedEdges.total, evidence.length),
      changedFiles: exactProjectionCount(claimedPaths.total, publication.claims.pathHints.length),
    },
    nodes,
    edges,
    evidence,
    anchors,
    ...(input.newerProjectionId === undefined
      ? {}
      : { newerProjectionId: input.newerProjectionId }),
  }
}

function projectVerifiedImpact(input: {
  artifact: VerifiedImpactProjectionArtifact
  source: ArchitectureImpactVerifiedCandidate['source']
  projectionId: string
  freshness: ArchitectureImpactVerifiedCandidate['freshness']
  publishedAt: string
}): ArchitectureGraphProjection
{
  return {
    projectionVersion: 1,
    projectionId: input.projectionId,
    projectionRevision: 1,
    kind: 'impact-diff',
    authority: 'verified',
    resultState: input.artifact.resultState,
    freshness: input.freshness,
    generatedAt: input.artifact.generatedAt,
    publishedAt: input.publishedAt,
    source: input.source,
    lens: input.artifact.lens,
    semanticLevel: input.artifact.semanticLevel,
    breadcrumbs: input.artifact.breadcrumbs,
    layoutVersion: input.artifact.layoutVersion,
    totals: input.artifact.totals,
    nodes: input.artifact.nodes,
    edges: input.artifact.edges,
    evidence: input.artifact.evidence,
    anchors: [],
  }
}

function descriptorIdentity(
  input: Omit<ArchitectureImpactDescriptor, 'descriptorId' | 'resolvedAt'>,
): string
{
  return projectionDigest(input)
}

function descriptorVersionIdentity(descriptor: ArchitectureImpactDescriptor): string
{
  const plannedCandidate =
    descriptor.plannedCandidate === undefined
      ? undefined
      : (({ freshness: _freshness, ...candidate }) => candidate)(descriptor.plannedCandidate)
  const verifiedCandidate =
    descriptor.verifiedCandidate === undefined
      ? undefined
      : (({ freshness: _freshness, ...candidate }) => candidate)(descriptor.verifiedCandidate)
  return projectionDigest({
    ...(plannedCandidate === undefined ? {} : { plannedCandidate }),
    ...(verifiedCandidate === undefined ? {} : { verifiedCandidate }),
    defaultAuthority: descriptor.defaultAuthority,
  })
}

export const make = (options: ArchitectureQueryServiceOptions = {}) =>
  Effect.gen(function* ()
  {
    const environment = yield* ServerEnvironment.ServerEnvironment
    const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery
    const currentWorktrees =
      yield* CurrentWorktreeArchitectureService.CurrentWorktreeArchitectureService
    const projectAtlases = yield* AtlasRebuildService.AtlasRebuildService
    const projectStatus = yield* ProjectAtlasStatusBroadcaster.ProjectAtlasStatusBroadcaster
    const plannedImpacts = yield* PlannedImpactService.PlannedImpactService
    const proposals = yield* ProposalService.ProposalService
    const proposalGenerations = yield* ProposalGenerationService.ProposalGenerationService
    const diffAnalyses = yield* DiffAnalysisService.DiffAnalysisService
    const graphLoader = options.loadGraph ?? loadContextQuery
    const graphCache = new Map<string, GraphCacheEntry>()
    let graphCacheBytes = 0

    const pinCurrentStandingSource = Effect.fn('ArchitectureQueryService.pinCurrentStandingSource')(
      function* (authorized: AuthorizedThreadContext)
      {
        const retained = yield* Effect.scoped(
          projectAtlases.retainPublishedIndex(authorized.thread.projectId),
        )
        if (retained === null) return undefined
        return {
          kind: 'standing-project-generation' as const,
          projectId: authorized.thread.projectId,
          generationId: retained.generation as never,
          side: 'analyzed' as const,
          graphDigest: retained.graphDigest as never,
        } satisfies ArchitectureStandingSource
      },
    )

    const attachImpactStandingAnchors = Effect.fn(
      'ArchitectureQueryService.attachImpactStandingAnchors',
    )(function* (
      projection: ArchitectureGraphProjection,
      standingSource: ArchitectureStandingSource | undefined,
    )
    {
      if (standingSource === undefined || projection.resultState === 'no-impact') return projection
      const retained = yield* Effect.scoped(
        projectAtlases.retainPublishedIndex(standingSource.projectId, standingSource.generationId),
      )
      if (retained === null || retained.graphDigest !== standingSource.graphDigest)
      {
        return {
          ...projection,
          anchors: unavailableImpactStandingAnchors({ source: standingSource, projection }),
        }
      }
      const status = yield* projectStatus.getStatus(standingSource.projectId)
      const stale =
        status.source === null ||
        status.source.projectId !== standingSource.projectId ||
        status.source.kind !== standingSource.kind ||
        status.source.side !== standingSource.side ||
        status.source.generationId !== standingSource.generationId ||
        status.source.graphDigest !== standingSource.graphDigest
      if (projection.anchors.length > 0)
      {
        return stale
          ? {
              ...projection,
              anchors: projection.anchors.map((anchor) => ({
                ...anchor,
                status: 'stale' as const,
                disclosure: `This anchor stays pinned to an older Repository Map generation. ${anchor.disclosure}`,
              })),
            }
          : projection
      }
      return {
        ...projection,
        anchors: resolveImpactStandingAnchors({
          index: retained.index,
          source: standingSource,
          projection,
          stale,
        }),
      }
    })

    const requireProjectedRoot = Effect.fn('ArchitectureQueryService.requireProjectedRoot')(
      function* (
        projectedRoot: string,
        retainedRoot: string,
        operation: string,
        selector: ArchitectureGraphSelector | ArchitecturePatchContextSelector,
      )
      {
        const canonicalProjectedRoot = yield* Effect.tryPromise({
          try: () => NodeFSP.realpath(projectedRoot),
          catch: () => contextNotReady(operation, selector),
        })
        if (canonicalProjectedRoot !== retainedRoot)
        {
          return yield* contextNotReady(operation, selector)
        }
      },
    )

    const resolveAuthority = Effect.fn('ArchitectureQueryService.resolveAuthority')(function* (
      authority: ArchitectureQueryAuthority,
      operation: string,
    )
    {
      if (authority.environmentId !== (yield* environment.getEnvironmentId))
      {
        return yield* architectureError(
          operation,
          'identity-mismatch',
          'The authenticated environment does not match this server.',
        )
      }
      const threadOption = yield* projections
        .getThreadDetailById(authority.threadId)
        .pipe(
          Effect.mapError(() =>
            architectureError(
              operation,
              'persistence-failed',
              'The authenticated source thread could not be resolved.',
            ),
          ),
        )
      if (Option.isNone(threadOption))
      {
        return yield* architectureError(
          operation,
          'not-found',
          'The authenticated source thread is not active.',
        )
      }
      const thread = threadOption.value
      const projectOption = yield* projections
        .getProjectShellById(thread.projectId)
        .pipe(
          Effect.mapError(() =>
            architectureError(
              operation,
              'persistence-failed',
              'The authenticated source project could not be resolved.',
            ),
          ),
        )
      if (Option.isNone(projectOption))
      {
        return yield* architectureError(
          operation,
          'not-found',
          'The authenticated source project is not active.',
        )
      }
      const project = projectOption.value
      return {
        environmentId: authority.environmentId,
        thread,
        project,
        workspaceRoot: thread.worktreePath ?? project.workspaceRoot,
      } satisfies AuthorizedThreadContext
    })

    const projectedPlanState = (
      authorized: AuthorizedThreadContext,
      plan: ArchitecturePlannedImpactPlanIdentity,
    ): 'active' | 'superseded' | 'reverted' =>
    {
      if (plan._tag === 'plan')
      {
        return authorized.thread.proposedPlans.some((entry) => entry.id === plan.planId)
          ? 'active'
          : 'reverted'
      }
      const revision = authorized.thread.orchestratePlans.find(
        (entry) => entry.runId === plan.runId && entry.revision === plan.revision,
      )
      if (revision === undefined || revision.status === 'rejected') return 'reverted'
      return revision.status === 'superseded' ? 'superseded' : 'active'
    }

    const proposalForPlan = Effect.fn('ArchitectureQueryService.proposalForPlan')(function* (
      authorized: AuthorizedThreadContext,
      plan: ArchitecturePlannedImpactPlanIdentity,
      operation: string,
    )
    {
      return yield* (
        plan._tag === 'plan'
          ? proposals.findLatestByPlan({
              sourceThreadId: authorized.thread.id,
              planId: plan.planId,
            })
          : proposals.findByOrchestrateRevision({
              sourceThreadId: authorized.thread.id,
              runId: plan.runId,
              revision: plan.revision,
            })
      ).pipe(
        Effect.mapError(() =>
          architectureError(
            operation,
            'persistence-failed',
            'The proposal linked to this plan could not be resolved.',
          ),
        ),
      )
    })

    const plannedForPlan = Effect.fn('ArchitectureQueryService.plannedForPlan')(function* (
      authorized: AuthorizedThreadContext,
      plan: ArchitecturePlannedImpactPlanIdentity,
      linkedProposal: LinkedProposal | null,
      operation: string,
    )
    {
      const pinned = linkedProposal?.revision.plannedImpactRef
      const stored =
        pinned === undefined
          ? yield* plannedImpacts.findLatestForAuthority({
              environmentId: authorized.environmentId,
              projectId: authorized.thread.projectId,
              sourceThreadId: authorized.thread.id,
              plan,
            })
          : yield* plannedImpacts.get(pinned.publicationId)
      if (stored === null) return null
      if (
        stored.publication.environmentId !== authorized.environmentId ||
        stored.publication.projectId !== authorized.thread.projectId ||
        stored.publication.sourceThreadId !== authorized.thread.id ||
        PlannedImpactService.architecturePlanIdentityKey(stored.publication.plan) !==
          PlannedImpactService.architecturePlanIdentityKey(plan) ||
        (pinned !== undefined &&
          (stored.publication.publicationRevision !== pinned.publicationRevision ||
            stored.publication.contentDigest !== pinned.contentDigest))
      )
      {
        return yield* architectureError(
          operation,
          'invalid-publication',
          'The proposal-linked Planned Impact publication failed exact authority validation.',
        )
      }
      const projection = stored.projections.at(-1)
      if (projection === undefined)
      {
        return yield* architectureError(
          operation,
          'invalid-publication',
          'The exact Planned Impact publication has no materialized projection.',
        )
      }
      const state = projectedPlanState(authorized, plan)
      const candidate: ArchitectureImpactPlannedCandidate = {
        authority: 'planned',
        source: {
          kind: 'planned-impact',
          environmentId: stored.publication.environmentId,
          projectId: stored.publication.projectId,
          threadId: stored.publication.sourceThreadId,
          plan: stored.publication.plan,
          publication: {
            publicationId: stored.publication.publicationId,
            publicationRevision: stored.publication.publicationRevision,
            contentDigest: stored.publication.contentDigest,
          },
          projection: {
            projectionId: projection.projectionId,
            projectionRevision: projection.projectionRevision,
            materialization: projection.materialization,
          },
        },
        projectionId: projection.projectionId,
        projectionRevision: projection.projectionRevision,
        resultState: projection.resultState,
        freshness: state === 'reverted' ? 'reverted' : state === 'superseded' ? 'stale' : 'fresh',
        generatedAt: projection.createdAt,
        publishedAt: stored.publication.createdAt,
      }
      return candidate
    })

    const verifiedForProposal = Effect.fn('ArchitectureQueryService.verifiedForProposal')(
      function* (
        authorized: AuthorizedThreadContext,
        linkedProposal: LinkedProposal,
        operation: string,
      )
      {
        const generation = yield* proposalGenerations
          .latest({
            threadId: authorized.thread.id,
            proposalId: linkedProposal.proposal.proposalId,
            revision: linkedProposal.revision.revision,
          })
          .pipe(
            Effect.mapError(() =>
              architectureError(
                operation,
                'persistence-failed',
                'The proposal-linked Verified generation could not be resolved.',
              ),
            ),
          )
        if (generation === null || generation.state !== 'ready') return null
        const target = yield* proposalGenerations
          .resolveImpactTarget(authorized.thread.id, generation.generationId)
          .pipe(
            Effect.mapError(() =>
              contextNotReady(operation, {
                kind: 'proposal-generation',
                generationId: generation.generationId,
                graph: 'base',
              }),
            ),
          )
        const source: ArchitectureImpactVerifiedCandidate['source'] = {
          kind: 'verified-proposal-impact',
          threadId: authorized.thread.id,
          generationId: generation.generationId,
          proposalId: generation.proposalId,
          revisionId: generation.revisionId,
          baseTreeOid: target.baseTreeOid as never,
          headTreeOid: target.proposedTreeOid as never,
          baseGraphDigest: target.baseGraphDigest as never,
          headGraphDigest: target.proposedGraphDigest as never,
          projectionDigest: target.impactProjectionDigest as never,
        }
        const standingSource = yield* pinCurrentStandingSource(authorized)
        return {
          authority: 'verified' as const,
          source,
          projectionId: `verified:${target.impactProjectionDigest.slice('sha256:'.length)}`,
          projectionRevision: 1,
          projectionDigest: target.impactProjectionDigest as never,
          resultState: target.projection.resultState,
          freshness: generation.freshness === 'fresh' ? ('fresh' as const) : ('stale' as const),
          generatedAt: target.projection.generatedAt,
          publishedAt: generation.updatedAt,
          ...(standingSource === undefined ? {} : { standingSource }),
        } satisfies ArchitectureImpactVerifiedCandidate
      },
    )

    const verifiedForComparison = Effect.fn('ArchitectureQueryService.verifiedForComparison')(
      function* (
        authorized: AuthorizedThreadContext,
        comparison: ArchitectureComparisonSelector,
        operation: string,
      )
      {
        if (comparison.kind === 'proposal-generation')
        {
          const generation = yield* proposalGenerations
            .get({ threadId: authorized.thread.id, generationId: comparison.generationId })
            .pipe(
              Effect.mapError(() =>
                contextNotReady(operation, {
                  kind: 'proposal-generation',
                  generationId: comparison.generationId,
                  graph: 'base',
                }),
              ),
            )
          if (generation.state !== 'ready')
            return yield* contextNotReady(operation, {
              kind: 'proposal-generation',
              generationId: comparison.generationId,
              graph: 'base',
            })
          const target = yield* proposalGenerations
            .resolveImpactTarget(authorized.thread.id, comparison.generationId)
            .pipe(
              Effect.mapError(() =>
                contextNotReady(operation, {
                  kind: 'proposal-generation',
                  generationId: comparison.generationId,
                  graph: 'base',
                }),
              ),
            )
          const standingSource = yield* pinCurrentStandingSource(authorized)
          return {
            authority: 'verified' as const,
            source: {
              kind: 'verified-proposal-impact' as const,
              threadId: authorized.thread.id,
              generationId: generation.generationId,
              proposalId: generation.proposalId,
              revisionId: generation.revisionId,
              baseTreeOid: target.baseTreeOid as never,
              headTreeOid: target.proposedTreeOid as never,
              baseGraphDigest: target.baseGraphDigest as never,
              headGraphDigest: target.proposedGraphDigest as never,
              projectionDigest: target.impactProjectionDigest as never,
            },
            projectionId: `verified:${target.impactProjectionDigest.slice('sha256:'.length)}`,
            projectionRevision: 1,
            projectionDigest: target.impactProjectionDigest as never,
            resultState: target.projection.resultState,
            freshness: generation.freshness === 'fresh' ? ('fresh' as const) : ('stale' as const),
            generatedAt: target.projection.generatedAt,
            publishedAt: generation.updatedAt,
            ...(standingSource === undefined ? {} : { standingSource }),
          } satisfies ArchitectureImpactVerifiedCandidate
        }
        const target = yield* diffAnalyses
          .retainReadyImpactTarget({
            workspaceRoot:
              authorized.thread.orchestrateRunExecution?.repositoryRoot ?? authorized.workspaceRoot,
            diffAnalysisId: comparison.diffAnalysisId,
          })
          .pipe(
            Effect.mapError(() =>
              contextNotReady(operation, {
                kind: 'diff-analysis',
                diffAnalysisId: comparison.diffAnalysisId,
                graph: 'base',
              }),
            ),
          )
        const standingSource = yield* pinCurrentStandingSource(authorized)
        return {
          authority: 'verified' as const,
          source: {
            kind: 'verified-diff-impact' as const,
            threadId: authorized.thread.id,
            diffAnalysisId: comparison.diffAnalysisId,
            baseTreeOid: target.baseTreeOid as never,
            headTreeOid: target.headTreeOid as never,
            baseGraphDigest: target.baseGraphDigest as never,
            headGraphDigest: target.headGraphDigest as never,
            projectionDigest: target.impactProjectionDigest as never,
          },
          projectionId: `verified:${target.impactProjectionDigest.slice('sha256:'.length)}`,
          projectionRevision: 1,
          projectionDigest: target.impactProjectionDigest as never,
          resultState: target.projection.resultState,
          freshness: target.generation.sourceCurrent ? ('fresh' as const) : ('stale' as const),
          generatedAt: target.projection.generatedAt,
          publishedAt: target.generation.updatedAt,
          ...(standingSource === undefined ? {} : { standingSource }),
        } satisfies ArchitectureImpactVerifiedCandidate
      },
    )

    const makeDescriptor = Effect.fn('ArchitectureQueryService.makeDescriptor')(function* (input: {
      readonly authorized: AuthorizedThreadContext
      readonly target: ArchitectureImpactDescriptor['target']
      readonly plannedCandidate?: ArchitectureImpactPlannedCandidate
      readonly verifiedCandidate?: ArchitectureImpactVerifiedCandidate
    })
    {
      if (input.plannedCandidate === undefined && input.verifiedCandidate === undefined)
      {
        return yield* architectureError(
          'architecture_impact_projection',
          'target-not-found',
          'No exact Planned or Verified Impact projection exists for this target.',
        )
      }
      const resolvedAt = DateTime.formatIso(yield* DateTime.now)
      const defaultAuthority =
        input.verifiedCandidate === undefined ? ('planned' as const) : ('verified' as const)
      const identity = {
        version: 1 as const,
        threadId: input.authorized.thread.id,
        projectId: input.authorized.thread.projectId,
        target: input.target,
        ...(input.plannedCandidate === undefined
          ? {}
          : { plannedCandidate: input.plannedCandidate }),
        ...(input.verifiedCandidate === undefined
          ? {}
          : { verifiedCandidate: input.verifiedCandidate }),
        defaultAuthority,
      }
      return {
        ...identity,
        descriptorId: descriptorIdentity(identity),
        resolvedAt,
      } satisfies ArchitectureImpactDescriptor
    })

    const resolvePlanDescriptor = Effect.fn('ArchitectureQueryService.resolvePlanDescriptor')(
      function* (
        authorized: AuthorizedThreadContext,
        plan: ArchitecturePlannedImpactPlanIdentity,
        operation: string,
      )
      {
        const planState = projectedPlanState(authorized, plan)
        if (planState === 'reverted') return null
        const linkedProposal = yield* proposalForPlan(authorized, plan, operation)
        const [plannedCandidate, verifiedCandidate] = yield* Effect.all([
          plannedForPlan(authorized, plan, linkedProposal, operation),
          linkedProposal === null
            ? Effect.succeed(null)
            : verifiedForProposal(authorized, linkedProposal, operation),
        ])
        if (plannedCandidate === null && verifiedCandidate === null) return null
        const planVerifiedCandidate =
          verifiedCandidate === null
            ? null
            : {
                ...verifiedCandidate,
                freshness:
                  planState === 'superseded' ? ('stale' as const) : verifiedCandidate.freshness,
              }
        return yield* makeDescriptor({
          authorized,
          target: { kind: 'plan', plan, state: planState },
          ...(plannedCandidate === null ? {} : { plannedCandidate }),
          ...(planVerifiedCandidate === null ? {} : { verifiedCandidate: planVerifiedCandidate }),
        })
      },
    )

    const descriptorIdentityMatches = (descriptor: ArchitectureImpactDescriptor): boolean =>
    {
      const identity = {
        version: descriptor.version,
        threadId: descriptor.threadId,
        projectId: descriptor.projectId,
        target: descriptor.target,
        ...(descriptor.plannedCandidate === undefined
          ? {}
          : { plannedCandidate: descriptor.plannedCandidate }),
        ...(descriptor.verifiedCandidate === undefined
          ? {}
          : { verifiedCandidate: descriptor.verifiedCandidate }),
        defaultAuthority: descriptor.defaultAuthority,
      }
      return descriptor.descriptorId === descriptorIdentity(identity)
    }

    const readExactDescriptor = Effect.fn('ArchitectureQueryService.readExactDescriptor')(
      function* (
        authorized: AuthorizedThreadContext,
        descriptor: ArchitectureImpactDescriptor,
        requestedAuthority: 'planned' | 'verified' | undefined,
        operation: string,
      )
      {
        if (
          descriptor.threadId !== authorized.thread.id ||
          descriptor.projectId !== authorized.thread.projectId ||
          !descriptorIdentityMatches(descriptor)
        )
        {
          return yield* architectureError(
            operation,
            'identity-mismatch',
            'The exact Impact descriptor does not match the authenticated thread and project.',
          )
        }
        const selectedAuthority = requestedAuthority ?? descriptor.defaultAuthority
        const latestDescriptor =
          descriptor.target.kind === 'plan'
            ? yield* resolvePlanDescriptor(authorized, descriptor.target.plan, operation).pipe(
                Effect.orElseSucceed(() => null),
              )
            : null
        const newerDescriptorId =
          latestDescriptor !== null &&
          descriptorVersionIdentity(latestDescriptor) !== descriptorVersionIdentity(descriptor)
            ? latestDescriptor.descriptorId
            : undefined
        const returnedDescriptor =
          newerDescriptorId === undefined ? descriptor : { ...descriptor, newerDescriptorId }
        if (selectedAuthority === 'planned')
        {
          const candidate = descriptor.plannedCandidate
          if (candidate === undefined)
          {
            return yield* architectureError(
              operation,
              'target-not-found',
              'This exact Impact descriptor has no Planned authority candidate.',
            )
          }
          const stored = yield* plannedImpacts.get(candidate.source.publication.publicationId)
          if (
            descriptor.target.kind !== 'plan' ||
            PlannedImpactService.architecturePlanIdentityKey(descriptor.target.plan) !==
              PlannedImpactService.architecturePlanIdentityKey(candidate.source.plan) ||
            candidate.source.environmentId !== stored.publication.environmentId ||
            candidate.source.projectId !== stored.publication.projectId ||
            candidate.source.threadId !== stored.publication.sourceThreadId ||
            stored.publication.environmentId !== authorized.environmentId ||
            stored.publication.projectId !== authorized.thread.projectId ||
            stored.publication.sourceThreadId !== authorized.thread.id ||
            stored.publication.publicationRevision !==
              candidate.source.publication.publicationRevision ||
            stored.publication.contentDigest !== candidate.source.publication.contentDigest ||
            PlannedImpactService.architecturePlanIdentityKey(stored.publication.plan) !==
              PlannedImpactService.architecturePlanIdentityKey(candidate.source.plan) ||
            candidate.projectionId !== candidate.source.projection.projectionId ||
            candidate.projectionRevision !== candidate.source.projection.projectionRevision
          )
          {
            return yield* architectureError(
              operation,
              'identity-mismatch',
              'The exact Planned Impact publication no longer matches its descriptor.',
            )
          }
          const projection = stored.projections.find(
            (item) =>
              item.projectionId === candidate.source.projection.projectionId &&
              item.projectionRevision === candidate.source.projection.projectionRevision &&
              item.materialization === candidate.source.projection.materialization,
          )
          if (projection === undefined)
          {
            return yield* architectureError(
              operation,
              'target-not-found',
              'The exact Planned Impact projection is no longer available.',
            )
          }
          if (
            candidate.resultState !== projection.resultState ||
            candidate.generatedAt !== projection.createdAt ||
            candidate.publishedAt !== stored.publication.createdAt
          )
          {
            return yield* architectureError(
              operation,
              'identity-mismatch',
              'The exact Planned Impact candidate metadata does not match its stored projection.',
            )
          }
          const state = projectedPlanState(authorized, descriptor.target.plan)
          const newer = stored.projections.at(-1)
          const graph = projectPlannedImpact({
            stored,
            projection,
            planState: state,
            ...(newer === undefined || newer.projectionId === projection.projectionId
              ? {}
              : { newerProjectionId: newer.projectionId }),
          })
          const standingSource: ArchitectureStandingSource | undefined =
            projection.standingSource === undefined
              ? undefined
              : {
                  kind: 'standing-project-generation',
                  projectId: projection.standingSource.projectId,
                  generationId: projection.standingSource.generationId as never,
                  side: 'analyzed',
                  graphDigest: projection.standingSource.graphDigest as never,
                }
          const anchoredGraph = yield* attachImpactStandingAnchors(graph, standingSource)
          return {
            version: 1 as const,
            descriptor: returnedDescriptor,
            selectedAuthority,
            projection: anchoredGraph,
            ...(newerDescriptorId === undefined ? {} : { newerDescriptorId }),
          } satisfies ArchitectureImpactProjectionResult
        }
        const candidate = descriptor.verifiedCandidate
        if (candidate === undefined)
        {
          return yield* architectureError(
            operation,
            'target-not-found',
            'This exact Impact descriptor has no Verified authority candidate.',
          )
        }
        if (descriptor.target.kind === 'comparison')
        {
          const comparison = descriptor.target.comparison
          const targetMatches =
            (comparison.kind === 'proposal-generation' &&
              candidate.source.kind === 'verified-proposal-impact' &&
              comparison.generationId === candidate.source.generationId) ||
            (comparison.kind === 'diff-analysis' &&
              candidate.source.kind === 'verified-diff-impact' &&
              comparison.diffAnalysisId === candidate.source.diffAnalysisId)
          if (!targetMatches)
          {
            return yield* architectureError(
              operation,
              'identity-mismatch',
              'The exact Verified projection does not match its comparison target.',
            )
          }
        }
        else
        {
          const linkedProposal = yield* proposalForPlan(
            authorized,
            descriptor.target.plan,
            operation,
          )
          if (
            linkedProposal === null ||
            candidate.source.kind !== 'verified-proposal-impact' ||
            candidate.source.proposalId !== linkedProposal.proposal.proposalId ||
            candidate.source.revisionId !== linkedProposal.revision.revisionId
          )
          {
            return yield* architectureError(
              operation,
              'identity-mismatch',
              'The exact Verified projection does not match the proposal revision linked to this plan.',
            )
          }
        }
        if (candidate.source.kind === 'verified-proposal-impact')
        {
          const source = candidate.source
          const generation = yield* proposalGenerations
            .get({ threadId: authorized.thread.id, generationId: source.generationId })
            .pipe(
              Effect.mapError(() =>
                contextNotReady(operation, {
                  kind: 'proposal-generation',
                  generationId: source.generationId,
                  graph: 'base',
                }),
              ),
            )
          const target = yield* proposalGenerations
            .resolveImpactTarget(authorized.thread.id, source.generationId)
            .pipe(
              Effect.mapError(() =>
                contextNotReady(operation, {
                  kind: 'proposal-generation',
                  generationId: source.generationId,
                  graph: 'base',
                }),
              ),
            )
          if (
            generation.proposalId !== source.proposalId ||
            generation.revisionId !== source.revisionId ||
            target.baseTreeOid !== source.baseTreeOid ||
            target.proposedTreeOid !== source.headTreeOid ||
            target.baseGraphDigest !== source.baseGraphDigest ||
            target.proposedGraphDigest !== source.headGraphDigest ||
            target.impactProjectionDigest !== source.projectionDigest ||
            candidate.projectionDigest !== source.projectionDigest ||
            candidate.projectionId !==
              `verified:${source.projectionDigest.slice('sha256:'.length)}` ||
            candidate.projectionRevision !== 1 ||
            candidate.resultState !== target.projection.resultState ||
            candidate.generatedAt !== target.projection.generatedAt ||
            candidate.publishedAt !== generation.updatedAt
          )
          {
            return yield* architectureError(
              operation,
              'identity-mismatch',
              'The exact Verified proposal projection failed sealed identity validation.',
            )
          }
          const graph = projectVerifiedImpact({
            artifact: target.projection,
            source,
            projectionId: candidate.projectionId,
            freshness:
              descriptor.target.kind === 'plan' &&
              projectedPlanState(authorized, descriptor.target.plan) === 'reverted'
                ? 'reverted'
                : generation.freshness === 'fresh'
                  ? 'fresh'
                  : 'stale',
            publishedAt: generation.updatedAt,
          })
          const anchoredGraph = yield* attachImpactStandingAnchors(graph, candidate.standingSource)
          return {
            version: 1 as const,
            descriptor: returnedDescriptor,
            selectedAuthority,
            projection: anchoredGraph,
            ...(newerDescriptorId === undefined ? {} : { newerDescriptorId }),
          } satisfies ArchitectureImpactProjectionResult
        }
        const source = candidate.source
        const target = yield* diffAnalyses
          .retainReadyImpactTarget({
            workspaceRoot:
              authorized.thread.orchestrateRunExecution?.repositoryRoot ?? authorized.workspaceRoot,
            diffAnalysisId: source.diffAnalysisId,
          })
          .pipe(
            Effect.mapError(() =>
              contextNotReady(operation, {
                kind: 'diff-analysis',
                diffAnalysisId: source.diffAnalysisId,
                graph: 'base',
              }),
            ),
          )
        if (
          target.baseTreeOid !== source.baseTreeOid ||
          target.headTreeOid !== source.headTreeOid ||
          target.baseGraphDigest !== source.baseGraphDigest ||
          target.headGraphDigest !== source.headGraphDigest ||
          target.impactProjectionDigest !== source.projectionDigest ||
          candidate.projectionDigest !== source.projectionDigest ||
          candidate.projectionId !==
            `verified:${source.projectionDigest.slice('sha256:'.length)}` ||
          candidate.projectionRevision !== 1 ||
          candidate.resultState !== target.projection.resultState ||
          candidate.generatedAt !== target.projection.generatedAt ||
          candidate.publishedAt !== target.generation.updatedAt
        )
        {
          return yield* architectureError(
            operation,
            'identity-mismatch',
            'The exact Verified comparison projection failed sealed identity validation.',
          )
        }
        const graph = projectVerifiedImpact({
          artifact: target.projection,
          source,
          projectionId: candidate.projectionId,
          freshness: target.generation.sourceCurrent ? 'fresh' : 'stale',
          publishedAt: target.generation.updatedAt,
        })
        const anchoredGraph = yield* attachImpactStandingAnchors(graph, candidate.standingSource)
        return {
          version: 1 as const,
          descriptor: returnedDescriptor,
          selectedAuthority,
          projection: anchoredGraph,
          ...(newerDescriptorId === undefined ? {} : { newerDescriptorId }),
        } satisfies ArchitectureImpactProjectionResult
      },
    )

    const resolveProposalTarget = Effect.fn('ArchitectureQueryService.resolveProposalTarget')(
      function* (
        authorized: AuthorizedThreadContext,
        generationId: Extract<
          ArchitectureGraphSelector,
          { kind: 'proposal-generation' }
        >['generationId'],
        operation: string,
      )
      {
        const generation = yield* proposalGenerations
          .get({ threadId: authorized.thread.id, generationId })
          .pipe(
            Effect.mapError((error) =>
            {
              if (error.failure === 'persistence-failed')
              {
                return architectureError(
                  operation,
                  'persistence-failed',
                  'The proposal architecture generation could not be read.',
                )
              }
              if (error.failure === 'unsupported')
              {
                return architectureError(
                  operation,
                  'unsupported',
                  'Proposal architecture analysis is unavailable.',
                )
              }
              return architectureError(
                operation,
                'not-found',
                'The proposal architecture generation was not found for this thread.',
              )
            }),
          )
        if (generation.state !== 'ready')
        {
          return yield* contextNotReady(operation, {
            kind: 'proposal-generation',
            generationId,
            graph: 'base',
          })
        }
        return yield* proposalGenerations
          .resolveArchitectureTarget(authorized.thread.id, generationId)
          .pipe(
            Effect.mapError(() =>
              contextNotReady(operation, {
                kind: 'proposal-generation',
                generationId,
                graph: 'base',
              }),
            ),
          )
      },
    )

    const resolveDiffTarget = Effect.fn('ArchitectureQueryService.resolveDiffTarget')(function* (
      authorized: AuthorizedThreadContext,
      diffAnalysisId: Extract<
        ArchitectureGraphSelector,
        { kind: 'diff-analysis' }
      >['diffAnalysisId'],
      operation: string,
    )
    {
      const workspaceRoot =
        authorized.thread.orchestrateRunExecution?.repositoryRoot ?? authorized.workspaceRoot
      const generation = yield* diffAnalyses.getById({ workspaceRoot, diffAnalysisId }).pipe(
        Effect.mapError((error) =>
        {
          if (error.code === 'persistence-failed')
          {
            return architectureError(
              operation,
              'persistence-failed',
              'The diff architecture analysis could not be read.',
            )
          }
          if (error.code === 'unsupported')
          {
            return architectureError(
              operation,
              'unsupported',
              'Diff architecture analysis is unavailable.',
            )
          }
          return architectureError(
            operation,
            'not-found',
            'The diff architecture analysis was not found for this workspace.',
          )
        }),
      )
      if (generation.state !== 'ready')
      {
        return yield* contextNotReady(operation, {
          kind: 'diff-analysis',
          diffAnalysisId,
          graph: 'base',
        })
      }
      return yield* diffAnalyses.retainReadyTarget({ workspaceRoot, diffAnalysisId }).pipe(
        Effect.mapError((error) =>
        {
          if (error.code === 'persistence-failed')
          {
            return architectureError(
              operation,
              'persistence-failed',
              'The ready diff architecture analysis could not be retained.',
            )
          }
          if (error.code === 'unsupported')
          {
            return architectureError(
              operation,
              'unsupported',
              'Diff architecture analysis is unavailable.',
            )
          }
          return contextNotReady(operation, {
            kind: 'diff-analysis',
            diffAnalysisId,
            graph: 'base',
          })
        }),
      )
    })

    const resolveContextForAuthorized = Effect.fn(
      'ArchitectureQueryService.resolveContextForAuthorized',
    )(function* (
      authorized: AuthorizedThreadContext,
      selector: ArchitectureGraphSelector | ArchitecturePatchContextSelector,
      operation: string,
    )
    {
      switch (selector.kind)
      {
        case 'current-thread-worktree':
        {
          const target = yield* currentWorktrees
            .retainThreadTarget(authorized.thread.id)
            .pipe(Effect.mapError(() => contextNotReady(operation, selector)))
          if (target.liveRoot === undefined)
          {
            return yield* contextNotReady(operation, selector)
          }
          yield* requireProjectedRoot(
            authorized.workspaceRoot,
            target.liveRoot,
            operation,
            selector,
          )
          return target
        }
        case 'proposal-generation':
        {
          const target = yield* resolveProposalTarget(authorized, selector.generationId, operation)
          const graphPath =
            selector.graph === 'base' ? target.baseGraphPath : target.proposedGraphPath
          return {
            root: target.proposedRoot,
            outDir: NodePath.dirname(graphPath),
            graphPath,
          }
        }
        case 'standing-project':
        {
          const target = yield* projectAtlases.retainLastGood(authorized.project.id)
          if (target === null)
          {
            return yield* contextNotReady(operation, selector)
          }
          yield* requireProjectedRoot(
            authorized.project.workspaceRoot,
            target.root,
            operation,
            selector,
          )
          return {
            root: target.root,
            outDir: target.outDir,
            graphPath: target.graphPath,
            liveRoot: target.root,
          }
        }
        case 'diff-analysis':
        {
          const target = yield* resolveDiffTarget(authorized, selector.diffAnalysisId, operation)
          const graphPath = selector.graph === 'base' ? target.baseGraphPath : target.headGraphPath
          return {
            root: target.headRoot,
            outDir: NodePath.dirname(graphPath),
            graphPath,
          }
        }
      }
    })

    const resolveContext: ArchitectureQueryServiceShape['resolveContext'] = Effect.fn(
      'ArchitectureQueryService.resolveContext',
    )(function* (authority, selector)
    {
      const operation = 'architecture.resolve_context'
      const authorized = yield* resolveAuthority(authority, operation)
      return yield* resolveContextForAuthorized(authorized, selector, operation)
    })

    const resolveComparison = Effect.fn('ArchitectureQueryService.resolveComparison')(function* (
      authority: ArchitectureQueryAuthority,
      selector: ArchitectureComparisonSelector,
      operation: string,
    )
    {
      const authorized = yield* resolveAuthority(authority, operation)
      switch (selector.kind)
      {
        case 'proposal-generation':
        {
          const target = yield* resolveProposalTarget(authorized, selector.generationId, operation)
          return {
            base: {
              root: target.proposedRoot,
              outDir: NodePath.dirname(target.baseGraphPath),
              graphPath: target.baseGraphPath,
            },
            head: {
              root: target.proposedRoot,
              outDir: NodePath.dirname(target.proposedGraphPath),
              graphPath: target.proposedGraphPath,
            },
            impactPath: target.impactPath,
          } satisfies ResolvedGraphPair
        }
        case 'diff-analysis':
        {
          const target = yield* resolveDiffTarget(authorized, selector.diffAnalysisId, operation)
          return {
            base: {
              root: target.headRoot,
              outDir: NodePath.dirname(target.baseGraphPath),
              graphPath: target.baseGraphPath,
            },
            head: {
              root: target.headRoot,
              outDir: NodePath.dirname(target.headGraphPath),
              graphPath: target.headGraphPath,
            },
            impactPath: target.impactPath,
          } satisfies ResolvedGraphPair
        }
      }
    })

    const readGraphFile = Effect.fn('ArchitectureQueryService.readGraphFile')(function* (
      context: ResolvedArchitectureContext,
      recovery: ArchitectureRecoveryAction,
      operation: string,
      attempt: 0 | 1 = 0,
    ): Effect.fn.Return<ContextQueryGraph, ArchitectureToolError>
    {
      const readFileIdentity = Effect.tryPromise({
        try: async () =>
        {
          const canonicalPath = await NodeFSP.realpath(context.graphPath)
          const stat = await NodeFSP.stat(canonicalPath, { bigint: true })
          if (!stat.isFile())
          {
            throw new Error('Published architecture graph is not a regular file.')
          }
          return {
            canonicalPath,
            stamp: { ino: stat.ino, mtimeNs: stat.mtimeNs, size: stat.size },
          }
        },
        catch: (cause) =>
        {
          const code = (cause as NodeJS.ErrnoException).code
          return code === 'ENOENT'
            ? architectureError(
                operation,
                'context-not-ready',
                'The selected architecture graph is no longer retained.',
                { recovery },
              )
            : architectureError(
                operation,
                'evaluation-failed',
                'The selected architecture graph could not be inspected.',
              )
        },
      })
      const before = yield* readFileIdentity
      const key = stampKey(before.canonicalPath, before.stamp)
      const cached = graphCache.get(key)
      if (cached !== undefined)
      {
        graphCache.delete(key)
        graphCache.set(key, cached)
        return cached.context
      }

      const loaded = yield* Effect.try({
        try: () => graphLoader(before.canonicalPath),
        catch: (cause) =>
        {
          if (cause instanceof ContextQueryError)
          {
            switch (cause.code)
            {
              case 'graph-not-found':
                return architectureError(
                  operation,
                  'context-not-ready',
                  'The selected architecture graph is no longer retained.',
                  { recovery },
                )
              case 'unsupported-version':
                return architectureError(operation, 'unsupported', cause.message)
              case 'target-not-found':
                return architectureError(operation, 'target-not-found', cause.message)
              case 'graph-read-failed':
              case 'graph-invalid':
                return architectureError(operation, 'evaluation-failed', cause.message)
            }
          }
          return architectureError(
            operation,
            'evaluation-failed',
            'The selected architecture graph could not be loaded.',
          )
        },
      })
      const after = yield* readFileIdentity
      if (after.canonicalPath !== before.canonicalPath || !stampEquals(after.stamp, before.stamp))
      {
        if (attempt === 0)
        {
          return yield* readGraphFile(context, recovery, operation, 1)
        }
        return yield* architectureError(
          operation,
          'evaluation-failed',
          'The selected architecture graph changed while it was being loaded.',
        )
      }

      const serializedBytes =
        after.stamp.size <= BigInt(Number.MAX_SAFE_INTEGER)
          ? Number(after.stamp.size)
          : ARCHITECTURE_GRAPH_CACHE_MAX_BYTES + 1
      const entry = { context: loaded, serializedBytes } satisfies GraphCacheEntry
      const concurrent = graphCache.get(key)
      if (concurrent !== undefined)
      {
        graphCacheBytes -= concurrent.serializedBytes
        graphCache.delete(key)
      }
      graphCache.set(key, entry)
      graphCacheBytes += serializedBytes
      while (
        graphCache.size > ARCHITECTURE_GRAPH_CACHE_MAX_ENTRIES ||
        graphCacheBytes > ARCHITECTURE_GRAPH_CACHE_MAX_BYTES
      )
      {
        const oldestKey = graphCache.keys().next().value
        if (oldestKey === undefined) break
        const oldest = graphCache.get(oldestKey)
        graphCache.delete(oldestKey)
        graphCacheBytes -= oldest?.serializedBytes ?? 0
      }
      return loaded
    })

    const blastRadius: ArchitectureQueryServiceShape['blastRadius'] = Effect.fn(
      'ArchitectureQueryService.blastRadius',
    )(function* (authority, input, resolvedTarget)
    {
      const operation = 'architecture_blast_radius'
      return yield* Effect.scoped(
        Effect.gen(function* ()
        {
          const authorized = yield* resolveAuthority(authority, operation)
          const context =
            resolvedTarget?.context ??
            (yield* resolveContextForAuthorized(authorized, input.context, operation))
          const graph = yield* readGraphFile(
            context,
            resolvedTarget?.recovery ?? recoveryForSelector(input.context),
            operation,
          )
          const impact = yield* Effect.try({
            try: () =>
              queryContextImpact(graph, {
                target: input.target,
                ...(input.direction === undefined ? {} : { direction: input.direction }),
                ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth }),
                limitPerDirection: ARCHITECTURE_BLAST_PATH_LIMIT,
              }),
            catch: (cause) =>
              cause instanceof ContextQueryError && cause.code === 'target-not-found'
                ? architectureError(operation, 'target-not-found', cause.message)
                : architectureError(
                    operation,
                    'evaluation-failed',
                    'The architecture impact query failed.',
                  ),
          })
          return {
            version: 1 as const,
            graph: graphMetadata(graph),
            target: impact.target,
            ...(impact.symbol === undefined ? {} : { symbol: impact.symbol }),
            precision: impact.precision,
            direction: impact.direction,
            maxDepth: impact.maxDepth,
            upstream: impact.upstream,
            downstream: impact.downstream,
            impactedFileCount: impact.impactedFileCount,
          }
        }),
      )
    })

    const graphDiff: ArchitectureQueryServiceShape['graphDiff'] = Effect.fn(
      'ArchitectureQueryService.graphDiff',
    )(function* (authority, input)
    {
      const operation = 'architecture_graph_diff'
      return yield* Effect.scoped(
        Effect.gen(function* ()
        {
          const pair = yield* resolveComparison(authority, input.comparison, operation)
          const recovery =
            input.comparison.kind === 'proposal-generation'
              ? 'complete_proposal_analysis'
              : 'complete_diff_analysis'
          const [base, head] = yield* Effect.all([
            readGraphFile(pair.base, recovery, operation),
            readGraphFile(pair.head, recovery, operation),
          ])
          const diff = yield* Effect.try({
            try: () => queryContextDiff(base, head),
            catch: () =>
              architectureError(
                operation,
                'evaluation-failed',
                'The architecture graph comparison failed.',
              ),
          })
          return projectGraphDiff(diff, false)
        }),
      )
    })

    const architectureImpactProjection: ArchitectureQueryServiceShape['architectureImpactProjection'] =
      Effect.fn('ArchitectureQueryService.architectureImpactProjection')(
        function* (authority, input)
        {
          const operation = 'architecture_impact_projection'
          const result = yield* Effect.scoped(
            Effect.gen(function* ()
            {
              const authorized = yield* resolveAuthority(authority, operation)
              if (input.kind === 'read-exact')
              {
                return yield* readExactDescriptor(
                  authorized,
                  input.descriptor,
                  input.authority,
                  operation,
                )
              }
              if (input.threadId !== authority.threadId)
              {
                return yield* architectureError(
                  operation,
                  'identity-mismatch',
                  'The requested Impact thread does not match the authenticated thread.',
                )
              }
              if (input.kind === 'resolve-comparison')
              {
                const verifiedCandidate = yield* verifiedForComparison(
                  authorized,
                  input.comparison,
                  operation,
                )
                const descriptor = yield* makeDescriptor({
                  authorized,
                  target: { kind: 'comparison', comparison: input.comparison },
                  verifiedCandidate,
                })
                return yield* readExactDescriptor(authorized, descriptor, undefined, operation)
              }
              const descriptor = yield* resolvePlanDescriptor(authorized, input.plan, operation)
              if (descriptor === null)
              {
                return yield* architectureError(
                  operation,
                  'target-not-found',
                  'No exact Planned or Verified Impact projection exists for this plan.',
                )
              }
              return yield* readExactDescriptor(authorized, descriptor, undefined, operation)
            }),
          ).pipe(
            withMetrics({ timer: architectureImpactReadDuration }),
            Effect.tapError((error) =>
              increment(
                architectureGraphViewsTotal,
                architectureGraphViewErrorMetricAttributes(error.code),
              ),
            ),
          )
          yield* increment(
            architectureGraphViewsTotal,
            architectureGraphViewMetricAttributes(result.projection),
          )
          return result
        },
      )

    const requireActiveTurn = Effect.fn('ArchitectureQueryService.requireActiveTurn')(function* (
      authority: ArchitectureQueryAuthority,
      authorized: AuthorizedThreadContext,
      operation: string,
    )
    {
      if (
        authority.activeTurnId === undefined ||
        authorized.thread.session?.status !== 'running' ||
        authorized.thread.session.activeTurnId !== authority.activeTurnId ||
        authorized.thread.latestTurn?.state !== 'running' ||
        authorized.thread.latestTurn.turnId !== authority.activeTurnId
      )
      {
        return yield* architectureError(
          operation,
          'identity-mismatch',
          "The authenticated turn does not match the thread's active projected turn.",
        )
      }
    })

    const proposePatch: ArchitectureQueryServiceShape['proposePatch'] = Effect.fn(
      'ArchitectureQueryService.proposePatch',
    )(function* (authority, input)
    {
      const operation = 'architecture_propose_patch'
      return yield* Effect.scoped(
        Effect.gen(function* ()
        {
          const authorized = yield* resolveAuthority(authority, operation)
          yield* requireActiveTurn(authority, authorized, operation)
          const context = yield* resolveContextForAuthorized(authorized, input.context, operation)
          const graph = yield* readGraphFile(context, recoveryForSelector(input.context), operation)
          const createdAt = DateTime.formatIso(yield* DateTime.now)
          const patch = yield* Effect.try({
            try: () =>
              parseGraphPatch({
                version: 1,
                meta: {
                  name: 'Ephemeral architecture proposal',
                  description: 'Bounded structural evaluation generated by 456code.',
                  author: '456code architecture tool',
                  createdAt,
                  baseline: graphMetadata(graph),
                },
                ops: input.ops,
              }),
            catch: (cause) =>
              architectureError(
                operation,
                'invalid-patch',
                cause instanceof Error ? cause.message : 'The architecture patch is invalid.',
              ),
          })
          yield* Effect.try({
            try: () => serializePatch(patch),
            catch: (cause) =>
              cause instanceof PatchSizeError
                ? architectureError(operation, 'limit-exceeded', cause.message, {
                    limit: {
                      kind: 'bytes',
                      scope: 'patch',
                      actual: cause.bytes,
                      limit: ARCHITECTURE_PATCH_MAX_BYTES,
                    },
                  })
                : architectureError(
                    operation,
                    'evaluation-failed',
                    'The canonical architecture patch could not be serialized.',
                  ),
          })
          const resolver = yield* Effect.try({
            try: () => patchNodeResolver(context.root),
            catch: () =>
              architectureError(
                operation,
                'evaluation-failed',
                'The repository architecture configuration could not be loaded.',
              ),
          })
          const evaluation = yield* Effect.try({
            try: () => evaluatePatch(graph.graph, patch, resolver),
            catch: (cause) =>
              cause instanceof PatchEvaluationLimitError
                ? architectureError(operation, 'limit-exceeded', cause.message, {
                    limit: {
                      kind: cause.kind,
                      scope: cause.scope,
                      actual: cause.actual,
                      limit: cause.limit,
                    },
                  })
                : architectureError(
                    operation,
                    'evaluation-failed',
                    'The architecture patch evaluation failed.',
                  ),
          }).pipe(withMetrics({ timer: architecturePatchEvaluationDuration }))
          const issues = bounded(evaluation.applied.issues, ARCHITECTURE_PATCH_ISSUE_LIMIT)
          const boundedValidation = boundPatchValidation(evaluation.validation, {
            cycles: ARCHITECTURE_PATCH_CYCLE_LIMIT,
            newBoundaries: ARCHITECTURE_PATCH_BOUNDARY_LIMIT,
            orphans: ARCHITECTURE_PATCH_ORPHAN_LIMIT,
          })
          const workingTree =
            context.liveRoot === undefined ? undefined : workingTreeState(context.liveRoot)
          const staleness = proposalStaleness(
            patch.meta.baseline,
            graph.graph,
            workingTree,
          ) satisfies ArchitecturePatchStaleness
          return {
            version: 1 as const,
            summary: formatDiffSummary(evaluation.diff),
            issues,
            issueTotals: {
              errors: evaluation.applied.issues.filter((issue) => issue.severity === 'error')
                .length,
              warnings: evaluation.applied.issues.filter((issue) => issue.severity === 'warning')
                .length,
            },
            validation: {
              cycles: {
                items: boundedValidation.cycles.items.map((cycle) => ({
                  from: cycle.from,
                  to: cycle.to,
                  path: {
                    items: cycle.path.slice(0, ARCHITECTURE_RESULT_LIST_LIMIT),
                    total: cycle.path.length + (cycle.pathOmitted ?? 0),
                    omitted:
                      cycle.path.length +
                      (cycle.pathOmitted ?? 0) -
                      Math.min(cycle.path.length, ARCHITECTURE_RESULT_LIST_LIMIT),
                  },
                })),
                total: boundedValidation.cycles.total,
                omitted: boundedValidation.cycles.omitted,
              },
              newBoundaries: {
                items: boundedValidation.newBoundaries.items.map((boundary) => ({
                  from: boundary.from,
                  to: boundary.to,
                  baseCount: boundary.baseCount,
                  headCount: boundary.headCount,
                  sample: {
                    items: boundary.sample.slice(0, ARCHITECTURE_RESULT_LIST_LIMIT),
                    total: boundary.headCount,
                    omitted:
                      boundary.headCount -
                      Math.min(boundary.sample.length, ARCHITECTURE_RESULT_LIST_LIMIT),
                  },
                })),
                total: boundedValidation.newBoundaries.total,
                omitted: boundedValidation.newBoundaries.omitted,
              },
              orphans: boundedValidation.orphans,
            },
            diff: projectGraphDiff(evaluation.diff, true),
            staleness,
          }
        }),
      )
    })

    return ArchitectureQueryService.of({
      resolveContext,
      blastRadius,
      graphDiff,
      architectureImpactProjection,
      proposePatch,
    })
  })

export const layer = Layer.effect(ArchitectureQueryService, make())
