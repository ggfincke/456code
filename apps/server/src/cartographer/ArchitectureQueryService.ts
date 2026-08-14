// apps/server/src/cartographer/ArchitectureQueryService.ts
// resolves authorized published graphs for bounded architecture agent queries

// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFSP from 'node:fs/promises'
import * as NodePath from 'node:path'

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
  type ArchitectureImpactResult,
  type ArchitectureImpactResultV2,
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
} from '@t3tools/cartographer-core/server'
import * as Context from 'effect/Context'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import type * as Scope from 'effect/Scope'

import * as ServerEnvironment from '../environment/ServerEnvironment.ts'
import {
  architectureImpactReadDuration,
  architecturePatchEvaluationDuration,
  withMetrics,
} from '../observability/Metrics.ts'
import * as ProjectionSnapshotQuery from '../orchestration/Services/ProjectionSnapshotQuery.ts'
import * as ProposalGenerationService from '../proposal/ProposalGenerationService.ts'
import * as AtlasRebuildService from './AtlasRebuildService.ts'
import * as CurrentWorktreeArchitectureService from './CurrentWorktreeArchitectureService.ts'
import * as DiffAnalysisService from './DiffAnalysisService.ts'

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
  readonly thread: OrchestrationThread
  readonly project: OrchestrationProjectShell
  readonly workspaceRoot: string
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
  readonly architectureImpact: (
    authority: ArchitectureQueryAuthority,
    input: { readonly comparison: ArchitectureComparisonSelector },
  ) => Effect.Effect<ArchitectureImpactResult, ArchitectureToolError>
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

export const make = (options: ArchitectureQueryServiceOptions = {}) =>
  Effect.gen(function* ()
  {
    const environment = yield* ServerEnvironment.ServerEnvironment
    const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery
    const currentWorktrees =
      yield* CurrentWorktreeArchitectureService.CurrentWorktreeArchitectureService
    const projectAtlases = yield* AtlasRebuildService.AtlasRebuildService
    const proposalGenerations = yield* ProposalGenerationService.ProposalGenerationService
    const diffAnalyses = yield* DiffAnalysisService.DiffAnalysisService
    const graphLoader = options.loadGraph ?? loadContextQuery
    const graphCache = new Map<string, GraphCacheEntry>()
    let graphCacheBytes = 0

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
        thread,
        project,
        workspaceRoot: thread.worktreePath ?? project.workspaceRoot,
      } satisfies AuthorizedThreadContext
    })

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

    const architectureImpact: ArchitectureQueryServiceShape['architectureImpact'] = Effect.fn(
      'ArchitectureQueryService.architectureImpact',
    )(function* (authority, input)
    {
      const operation = 'architecture_impact'
      return yield* Effect.scoped(
        Effect.gen(function* ()
        {
          const authorized = yield* resolveAuthority(authority, operation)
          let diff: GraphDiff | null
          let impactDigest: string
          let sources: Pick<ArchitectureImpactResultV2, 'baseSource' | 'headSource'>
          if (input.comparison.kind === 'proposal-generation')
          {
            const comparison = input.comparison
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
            diff = target.diff
            impactDigest = target.impactDigest
            sources = {
              baseSource: {
                kind: 'proposal-generation',
                threadId: authorized.thread.id,
                generationId: comparison.generationId,
                side: 'base',
                graphDigest: target.baseGraphDigest,
              },
              headSource: {
                kind: 'proposal-generation',
                threadId: authorized.thread.id,
                generationId: comparison.generationId,
                side: 'proposed',
                graphDigest: target.proposedGraphDigest,
              },
            }
          }
          else
          {
            const comparison = input.comparison
            const target = yield* diffAnalyses
              .retainReadyImpactTarget({
                workspaceRoot:
                  authorized.thread.orchestrateRunExecution?.repositoryRoot ??
                  authorized.workspaceRoot,
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
            diff = target.diff
            impactDigest = target.impactDigest
            sources = {
              baseSource: {
                kind: 'diff-analysis',
                threadId: authorized.thread.id,
                diffAnalysisId: comparison.diffAnalysisId,
                side: 'base',
                graphDigest: target.baseGraphDigest,
              },
              headSource: {
                kind: 'diff-analysis',
                threadId: authorized.thread.id,
                diffAnalysisId: comparison.diffAnalysisId,
                side: 'head',
                graphDigest: target.headGraphDigest,
              },
            }
          }
          const projected =
            diff === null ? yield* graphDiff(authority, input) : projectGraphDiff(diff, false)
          return {
            ...projected,
            version: 2 as const,
            comparison: input.comparison,
            impactDigest,
            ...sources,
          }
        }),
      ).pipe(withMetrics({ timer: architectureImpactReadDuration }))
    })

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
      architectureImpact,
      proposePatch,
    })
  })

export const layer = Layer.effect(ArchitectureQueryService, make())
