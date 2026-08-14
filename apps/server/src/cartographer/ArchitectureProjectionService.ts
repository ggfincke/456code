// apps/server/src/cartographer/ArchitectureProjectionService.ts
// serves generation-bound bounded architecture projections to native clients

// @effect-diagnostics nodeBuiltinImport:off

import * as NodeChildProcess from 'node:child_process'
import * as NodeCrypto from 'node:crypto'
import * as NodeFSP from 'node:fs/promises'
import * as NodePath from 'node:path'

import {
  ARCHITECTURE_PROJECTION_EDGE_LIMIT,
  ARCHITECTURE_PROJECTION_FILE_LIMIT,
  ARCHITECTURE_PROJECTION_UNIT_LIMIT,
  ARCHITECTURE_SOURCE_MAX_BYTES,
  ArchitectureToolError,
  type ArchitectureLimit,
  type ArchitectureProjectionCount,
  type ArchitectureProjectionEdge,
  type ArchitectureProjectionSource,
  type ArchitectureProjectionUnit,
  type ArchitectureRecoveryAction,
  type ArchitectureStandingSource,
  type ArchitectureToolErrorCode,
  type CartographerGetArchitectureNeighborhoodInput,
  type CartographerGetArchitectureNeighborhoodResult,
  type CartographerGetArchitecturePathScopeInput,
  type CartographerGetArchitecturePathScopeResult,
  type CartographerGetArchitectureScopeInput,
  type CartographerGetArchitectureScopeResult,
  type CartographerGetArchitectureSourceInput,
  type CartographerGetArchitectureSourceResult,
  type CartographerGetRepositoryMapInput,
  type CartographerGetRepositoryMapResult,
  type OrchestrationProjectShell,
  type OrchestrationThread,
} from '@t3tools/contracts'
import {
  queryAtlasFiles,
  queryAtlasIndex,
  type AtlasIndexEdge,
  type AtlasIndexFile,
  type AtlasIndexUnit,
} from '@t3tools/cartographer-core/server'
import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import type * as Scope from 'effect/Scope'

import * as ServerEnvironment from '../environment/ServerEnvironment.ts'
import * as ProjectionSnapshotQuery from '../orchestration/Services/ProjectionSnapshotQuery.ts'
import {
  architectureAtlasIndexReadDuration,
  architectureProjectionReadDuration,
  withMetrics,
} from '../observability/Metrics.ts'
import * as ProposalGenerationService from '../proposal/ProposalGenerationService.ts'
import * as ArchitectureQueryService from './ArchitectureQueryService.ts'
import * as AtlasRebuildService from './AtlasRebuildService.ts'
import { resolveArchitecturePathScope } from './architecturePathResolver.ts'
import * as DiffAnalysisService from './DiffAnalysisService.ts'
import * as ProjectAtlasStatusBroadcaster from './ProjectAtlasStatusBroadcaster.ts'

interface AuthorizedArchitectureProject
{
  readonly thread: OrchestrationThread
  readonly project: OrchestrationProjectShell
  readonly workspaceRoot: string
}

class ArchitectureSourceReadError extends Data.TaggedError('ArchitectureSourceReadError')<{
  readonly code: 'not-found' | 'too-large' | 'binary' | 'git-failed'
  readonly actualBytes?: number
}>
{}

export interface ArchitectureProjectionServiceShape
{
  readonly repositoryMap: (
    authority: ArchitectureQueryService.ArchitectureQueryAuthority,
    input: CartographerGetRepositoryMapInput,
  ) => Effect.Effect<CartographerGetRepositoryMapResult, ArchitectureToolError>
  readonly architectureScope: (
    authority: ArchitectureQueryService.ArchitectureQueryAuthority,
    input: CartographerGetArchitectureScopeInput,
  ) => Effect.Effect<CartographerGetArchitectureScopeResult, ArchitectureToolError>
  readonly architectureNeighborhood: (
    authority: ArchitectureQueryService.ArchitectureQueryAuthority,
    input: CartographerGetArchitectureNeighborhoodInput,
  ) => Effect.Effect<CartographerGetArchitectureNeighborhoodResult, ArchitectureToolError>
  readonly architecturePathScope: (
    authority: ArchitectureQueryService.ArchitectureQueryAuthority,
    input: CartographerGetArchitecturePathScopeInput,
  ) => Effect.Effect<CartographerGetArchitecturePathScopeResult, ArchitectureToolError>
  readonly architectureSource: (
    authority: ArchitectureQueryService.ArchitectureQueryAuthority,
    input: CartographerGetArchitectureSourceInput,
  ) => Effect.Effect<CartographerGetArchitectureSourceResult, ArchitectureToolError>
}

export class ArchitectureProjectionService extends Context.Service<
  ArchitectureProjectionService,
  ArchitectureProjectionServiceShape
>()('456code/cartographer/ArchitectureProjectionService')
{}

function architectureError(
  operation: string,
  code: ArchitectureToolErrorCode,
  detail: string,
  options?: ArchitectureRecoveryAction | { readonly limit: ArchitectureLimit },
): ArchitectureToolError
{
  return new ArchitectureToolError({
    operation,
    code,
    detail,
    ...(options === undefined ? {} : typeof options === 'string' ? { recovery: options } : options),
  })
}

function sourceIdentity(
  projectId: ArchitectureStandingSource['projectId'],
  generation: string,
  graphDigest: string,
): ArchitectureStandingSource
{
  return {
    kind: 'standing-project-generation',
    projectId,
    generationId: generation,
    side: 'analyzed',
    graphDigest,
  }
}

function projectionCount(
  total: number,
  indexed: number,
  returned: number,
): ArchitectureProjectionCount
{
  return {
    total,
    indexed,
    returned,
    omitted: total - indexed,
  }
}

function projectionUnit(unit: AtlasIndexUnit): ArchitectureProjectionUnit
{
  return {
    id: unit.id,
    key: unit.key,
    level: unit.level,
    label: unit.label,
    ...(unit.description === undefined ? {} : { description: unit.description }),
    ...(unit.parent === undefined ? {} : { parent: unit.parent }),
    ...(unit.source === undefined ? {} : { source: unit.source }),
    fileCount: unit.fileCount,
    inbound: unit.inbound,
    outbound: unit.outbound,
    position: unit.position,
  }
}

function projectionEdge(edge: AtlasIndexEdge): ArchitectureProjectionEdge
{
  return { from: edge.from, to: edge.to, weight: edge.weight }
}

function projectionFile(file: AtlasIndexFile)
{
  return {
    id: file.id,
    label: file.label,
    ...(file.description === undefined ? {} : { description: file.description }),
    ...(file.system === undefined ? {} : { system: file.system }),
    ...(file.block === undefined ? {} : { block: file.block }),
    ...(file.dir === undefined ? {} : { dir: file.dir }),
    fanIn: file.fanIn,
    fanOut: file.fanOut,
  }
}

function runGitBytes(
  repositoryRoot: string,
  args: ReadonlyArray<string>,
  maxBuffer: number,
  signal: AbortSignal,
): Promise<Buffer>
{
  return new Promise((resolve, reject) =>
  {
    NodeChildProcess.execFile(
      'git',
      ['-C', repositoryRoot, ...args],
      { encoding: null, maxBuffer, signal },
      (error, stdout) =>
      {
        if (error !== null)
        {
          reject(error)
          return
        }
        resolve(stdout)
      },
    )
  })
}

function decodeSourceText(bytes: Buffer)
{
  const content = bytes.toString('utf8')
  if (content.includes('\u0000') || !Buffer.from(content, 'utf8').equals(bytes))
  {
    throw new ArchitectureSourceReadError({ code: 'binary' })
  }
  return {
    content,
    digest: `sha256:${NodeCrypto.createHash('sha256').update(bytes).digest('hex')}` as const,
  }
}

const readGitText = Effect.fn('ArchitectureProjectionService.readGitText')(function* (
  repositoryRoot: string,
  treeOid: string,
  relativePath: string,
)
{
  const entry = yield* Effect.tryPromise({
    try: (signal) =>
      runGitBytes(
        repositoryRoot,
        ['--literal-pathspecs', 'ls-tree', '-z', '--full-tree', treeOid, '--', relativePath],
        64 * 1024,
        signal,
      ),
    catch: () => new ArchitectureSourceReadError({ code: 'git-failed' }),
  })
  const terminator = entry.indexOf(0)
  const separator = entry.indexOf(9)
  if (
    terminator !== entry.byteLength - 1 ||
    separator <= 0 ||
    !entry.subarray(separator + 1, terminator).equals(Buffer.from(relativePath, 'utf8'))
  )
  {
    return yield* new ArchitectureSourceReadError({ code: 'not-found' })
  }
  const match = /^([0-7]{6}) blob ([0-9a-f]{40}|[0-9a-f]{64})$/u.exec(
    entry.subarray(0, separator).toString('ascii'),
  )
  if (match === null)
  {
    return yield* new ArchitectureSourceReadError({ code: 'not-found' })
  }
  const blobOid = match[2]!
  const sizeBytes = yield* Effect.tryPromise({
    try: (signal) => runGitBytes(repositoryRoot, ['cat-file', '-s', blobOid], 128, signal),
    catch: () => new ArchitectureSourceReadError({ code: 'git-failed' }),
  })
  const byteLength = Number.parseInt(sizeBytes.toString('utf8').trim(), 10)
  if (!Number.isSafeInteger(byteLength) || byteLength < 0)
  {
    return yield* new ArchitectureSourceReadError({ code: 'git-failed' })
  }
  if (byteLength > ARCHITECTURE_SOURCE_MAX_BYTES)
  {
    return yield* new ArchitectureSourceReadError({ code: 'too-large', actualBytes: byteLength })
  }
  const bytes = yield* Effect.tryPromise({
    try: (signal) =>
      runGitBytes(
        repositoryRoot,
        ['cat-file', 'blob', blobOid],
        ARCHITECTURE_SOURCE_MAX_BYTES + 1,
        signal,
      ),
    catch: () => new ArchitectureSourceReadError({ code: 'git-failed' }),
  })
  if (bytes.byteLength !== byteLength)
  {
    return yield* new ArchitectureSourceReadError({ code: 'git-failed' })
  }
  return yield* Effect.try({
    try: () => decodeSourceText(bytes),
    catch: (error) => error as ArchitectureSourceReadError,
  })
})

const readRetainedText = Effect.fn('ArchitectureProjectionService.readRetainedText')(function* (
  retainedRoot: string,
  relativePath: string,
)
{
  const root = NodePath.resolve(retainedRoot)
  const segments = relativePath.split('/')
  const sourcePath = NodePath.resolve(root, ...segments)
  const relative = NodePath.relative(root, sourcePath)
  if (
    relative === '' ||
    relative.startsWith(`..${NodePath.sep}`) ||
    NodePath.isAbsolute(relative)
  )
  {
    return yield* new ArchitectureSourceReadError({ code: 'not-found' })
  }
  const rootInfo = yield* Effect.tryPromise({
    try: () => NodeFSP.lstat(root),
    catch: () => new ArchitectureSourceReadError({ code: 'git-failed' }),
  })
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
  {
    return yield* new ArchitectureSourceReadError({ code: 'git-failed' })
  }

  let currentPath = root
  let sourceInfo: Awaited<ReturnType<typeof NodeFSP.lstat>> | null = null
  for (const [index, segment] of segments.entries())
  {
    currentPath = NodePath.join(currentPath, segment)
    sourceInfo = yield* Effect.tryPromise({
      try: () => NodeFSP.lstat(currentPath),
      catch: (cause) =>
      {
        const code =
          typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined
        return new ArchitectureSourceReadError({
          code: code === 'ENOENT' || code === 'ENOTDIR' ? 'not-found' : 'git-failed',
        })
      },
    })
    if (index < segments.length - 1 && (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()))
    {
      return yield* new ArchitectureSourceReadError({ code: 'not-found' })
    }
  }
  if (sourceInfo === null || (!sourceInfo.isFile() && !sourceInfo.isSymbolicLink()))
  {
    return yield* new ArchitectureSourceReadError({ code: 'not-found' })
  }
  const finalSourceInfo = sourceInfo
  if (finalSourceInfo.isFile() && finalSourceInfo.size > ARCHITECTURE_SOURCE_MAX_BYTES)
  {
    return yield* new ArchitectureSourceReadError({
      code: 'too-large',
      actualBytes: finalSourceInfo.size,
    })
  }
  const bytes = yield* Effect.tryPromise({
    try: () =>
      finalSourceInfo.isSymbolicLink()
        ? NodeFSP.readlink(currentPath, { encoding: 'buffer' })
        : NodeFSP.readFile(currentPath),
    catch: () => new ArchitectureSourceReadError({ code: 'git-failed' }),
  })
  if (bytes.byteLength > ARCHITECTURE_SOURCE_MAX_BYTES)
  {
    return yield* new ArchitectureSourceReadError({
      code: 'too-large',
      actualBytes: bytes.byteLength,
    })
  }
  if (finalSourceInfo.isFile() && bytes.byteLength !== finalSourceInfo.size)
  {
    return yield* new ArchitectureSourceReadError({ code: 'git-failed' })
  }
  return yield* Effect.try({
    try: () => decodeSourceText(bytes),
    catch: (error) => error as ArchitectureSourceReadError,
  })
})

export const make = Effect.gen(function* ()
{
  const environment = yield* ServerEnvironment.ServerEnvironment
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery
  const projectAtlases = yield* AtlasRebuildService.AtlasRebuildService
  const projectStatus = yield* ProjectAtlasStatusBroadcaster.ProjectAtlasStatusBroadcaster
  const proposalGenerations = yield* ProposalGenerationService.ProposalGenerationService
  const diffAnalyses = yield* DiffAnalysisService.DiffAnalysisService
  const architectureQueries = yield* ArchitectureQueryService.ArchitectureQueryService

  const resolveAuthority = Effect.fn('ArchitectureProjectionService.resolveAuthority')(function* (
    authority: ArchitectureQueryService.ArchitectureQueryAuthority,
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
    const thread = yield* projections
      .getThreadDetailById(authority.threadId)
      .pipe(
        Effect.mapError(() =>
          architectureError(
            operation,
            'persistence-failed',
            'The source thread could not be read.',
          ),
        ),
      )
    if (Option.isNone(thread))
    {
      return yield* architectureError(operation, 'not-found', 'The source thread was not found.')
    }
    const project = yield* projections
      .getProjectShellById(thread.value.projectId)
      .pipe(
        Effect.mapError(() =>
          architectureError(
            operation,
            'persistence-failed',
            'The source project could not be read.',
          ),
        ),
      )
    if (Option.isNone(project))
    {
      return yield* architectureError(operation, 'not-found', 'The source project was not found.')
    }
    return {
      thread: thread.value,
      project: project.value,
      workspaceRoot: thread.value.worktreePath ?? project.value.workspaceRoot,
    } satisfies AuthorizedArchitectureProject
  })

  const retainStandingIndex = Effect.fn('ArchitectureProjectionService.retainStandingIndex')(
    function* (
      authorized: AuthorizedArchitectureProject,
      projectId: ArchitectureStandingSource['projectId'],
      generationId: string | undefined,
      graphDigest: string | undefined,
      operation: string,
    )
    {
      if (authorized.project.id !== projectId)
      {
        return yield* architectureError(
          operation,
          'identity-mismatch',
          'The requested architecture project does not match the authenticated thread.',
        )
      }
      const target = yield* projectAtlases
        .retainPublishedIndex(projectId, generationId)
        .pipe(withMetrics({ timer: architectureAtlasIndexReadDuration }))
      if (target === null)
      {
        return yield* architectureError(
          operation,
          'context-not-ready',
          'The requested sealed Repository Atlas generation is not available.',
          'build_project_atlas',
        )
      }
      if (graphDigest !== undefined && target.graphDigest !== graphDigest)
      {
        return yield* architectureError(
          operation,
          'identity-mismatch',
          'The requested Repository Atlas graph digest does not match its generation.',
        )
      }
      return target
    },
  )

  const repositoryMap: ArchitectureProjectionServiceShape['repositoryMap'] = Effect.fn(
    'ArchitectureProjectionService.repositoryMap',
  )(function* (authority, input)
  {
    const operation = 'architecture_repository_map'
    return yield* Effect.scoped(
      Effect.gen(function* ()
      {
        const authorized = yield* resolveAuthority(authority, operation)
        const target = yield* retainStandingIndex(
          authorized,
          input.projectId,
          input.generationId,
          undefined,
          operation,
        )
        const index = target.index
        const level: 'systems' | 'blocks' = index.counts.systems > 0 ? 'systems' : 'blocks'
        const units = index.units[level]
          .slice(0, ARCHITECTURE_PROJECTION_UNIT_LIMIT)
          .map(projectionUnit)
        const edges = index.edges[level]
          .slice(0, ARCHITECTURE_PROJECTION_EDGE_LIMIT)
          .map(projectionEdge)
        const status = yield* projectStatus.getStatus(input.projectId)
        const exactUnitTotal = level === 'systems' ? index.counts.systems : index.counts.blocks
        const exactEdge = index.edgeCounts[level]
        return {
          version: 1 as const,
          source: sourceIdentity(input.projectId, target.generation, target.graphDigest),
          builtAt: target.builtAt,
          dirty: status.freshness.dirty,
          repo: {
            name: index.repo.name,
            scope: index.repo.scope,
            ...(index.repo.gitRef === undefined ? {} : { gitRef: index.repo.gitRef }),
          },
          counts: {
            files: index.counts.files,
            imports: index.counts.imports,
            systems: index.counts.systems,
            blocks: index.counts.blocks,
            dirs: index.counts.dirs,
          },
          health: index.health,
          level,
          systemSource: index.systemSource,
          units,
          unitCount: projectionCount(exactUnitTotal, index.units[level].length, units.length),
          edges,
          edgeCount: projectionCount(exactEdge.total, exactEdge.indexed, edges.length),
        }
      }),
    ).pipe(withMetrics({ timer: architectureProjectionReadDuration, attributes: { kind: 'map' } }))
  })

  const architectureScope: ArchitectureProjectionServiceShape['architectureScope'] = Effect.fn(
    'ArchitectureProjectionService.architectureScope',
  )(function* (authority, input)
  {
    const operation = 'architecture_scope'
    return yield* Effect.scoped(
      Effect.gen(function* ()
      {
        const authorized = yield* resolveAuthority(authority, operation)
        const target = yield* retainStandingIndex(
          authorized,
          input.source.projectId,
          input.source.generationId,
          input.source.graphDigest,
          operation,
        )
        const index = target.index
        if (!index.units[input.scope.level].some((unit) => unit.id === input.scope.id))
        {
          return yield* architectureError(
            operation,
            'target-not-found',
            'The requested architecture scope is not indexed in this generation.',
          )
        }
        if (input.scope.level === 'dirs' && input.cursor !== undefined)
        {
          return yield* architectureError(
            operation,
            'identity-mismatch',
            'Directory scopes do not accept a child cursor.',
          )
        }
        const filePage = yield* Effect.try({
          try: () =>
            queryAtlasFiles(index, {
              parent: input.scope,
              ...(input.fileCursor === undefined ? {} : { cursor: input.fileCursor }),
              limit: Math.min(input.fileLimit ?? 50, ARCHITECTURE_PROJECTION_FILE_LIMIT),
            }),
          catch: () =>
            architectureError(operation, 'identity-mismatch', 'The file cursor is invalid.'),
        })
        if (input.scope.level === 'dirs')
        {
          return {
            version: 1 as const,
            source: input.source,
            scope: input.scope,
            childLevel: 'dirs' as const,
            children: [],
            childCount: projectionCount(0, 0, 0),
            edges: [],
            edgeCount: projectionCount(0, 0, 0),
            files: filePage.items.map(projectionFile),
            fileCount: projectionCount(filePage.total, filePage.total, filePage.items.length),
            ...(filePage.nextCursor === undefined ? {} : { nextFileCursor: filePage.nextCursor }),
          }
        }
        const childLevel: 'blocks' | 'dirs' = input.scope.level === 'systems' ? 'blocks' : 'dirs'
        const scope = index.scopes.find(
          (candidate) => candidate.parent === input.scope.id && candidate.childLevel === childLevel,
        )
        if (scope === undefined)
        {
          return yield* architectureError(
            operation,
            'target-not-found',
            'The requested architecture scope is not indexed in this generation.',
          )
        }
        const childPage = yield* Effect.try({
          try: () =>
            queryAtlasIndex(index, {
              level: childLevel,
              parent: input.scope.id,
              ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
              limit: Math.min(input.limit ?? 50, ARCHITECTURE_PROJECTION_FILE_LIMIT),
            }),
          catch: () =>
            architectureError(operation, 'identity-mismatch', 'The scope cursor is invalid.'),
        })
        const childIds = new Set(childPage.items.map((unit) => unit.id))
        const edges = index.edges[childLevel]
          .filter((edge) => childIds.has(edge.from) && childIds.has(edge.to))
          .slice(0, ARCHITECTURE_PROJECTION_EDGE_LIMIT)
          .map(projectionEdge)
        return {
          version: 1 as const,
          source: input.source,
          scope: input.scope,
          childLevel,
          children: childPage.items.map(projectionUnit),
          childCount: projectionCount(
            scope.children.total,
            scope.children.indexed,
            childPage.items.length,
          ),
          ...(childPage.nextCursor === undefined ? {} : { nextCursor: childPage.nextCursor }),
          edges,
          edgeCount: projectionCount(scope.edges.total, scope.edges.indexed, edges.length),
          files: filePage.items.map(projectionFile),
          fileCount: projectionCount(filePage.total, filePage.total, filePage.items.length),
          ...(filePage.nextCursor === undefined ? {} : { nextFileCursor: filePage.nextCursor }),
        }
      }),
    ).pipe(
      withMetrics({ timer: architectureProjectionReadDuration, attributes: { kind: 'scope' } }),
    )
  })

  const verifyGraphSource = Effect.fn('ArchitectureProjectionService.verifyGraphSource')(function* (
    authorized: AuthorizedArchitectureProject,
    source: ArchitectureProjectionSource,
    operation: string,
  ): Effect.fn.Return<
    | {
        readonly selector: Parameters<
          ArchitectureQueryService.ArchitectureQueryServiceShape['resolveContext']
        >[1]
      }
    | {
        readonly selector: Parameters<
          ArchitectureQueryService.ArchitectureQueryServiceShape['resolveContext']
        >[1]
        readonly resolvedTarget: ArchitectureQueryService.ResolvedArchitectureBlastTarget
      }
    | {
        readonly selector: Parameters<
          ArchitectureQueryService.ArchitectureQueryServiceShape['resolveContext']
        >[1]
        readonly repositoryRoot: string
        readonly treeOid: string
      }
    | {
        readonly selector: Parameters<
          ArchitectureQueryService.ArchitectureQueryServiceShape['resolveContext']
        >[1]
        readonly retainedRoot: string
      },
    ArchitectureToolError,
    Scope.Scope
  >
  {
    switch (source.kind)
    {
      case 'standing-project-generation':
      {
        const target = yield* retainStandingIndex(
          authorized,
          source.projectId,
          source.generationId,
          source.graphDigest,
          operation,
        )
        return {
          selector: { kind: 'standing-project' },
          resolvedTarget: {
            context: {
              root: target.root,
              outDir: target.outDir,
              graphPath: target.graphPath,
              liveRoot: target.root,
            },
            recovery: 'build_project_atlas' as const,
          },
        }
      }
      case 'proposal-generation':
      {
        if (source.threadId !== authorized.thread.id)
        {
          return yield* architectureError(
            operation,
            'identity-mismatch',
            'The proposal architecture source does not belong to this thread.',
          )
        }
        const target = yield* proposalGenerations
          .resolveImpactTarget(authorized.thread.id, source.generationId)
          .pipe(
            Effect.mapError(() =>
              architectureError(
                operation,
                'context-not-ready',
                'The proposal architecture source is no longer retained.',
                'complete_proposal_analysis',
              ),
            ),
          )
        const digest = source.side === 'base' ? target.baseGraphDigest : target.proposedGraphDigest
        if (digest !== source.graphDigest)
        {
          return yield* architectureError(
            operation,
            'identity-mismatch',
            'The proposal graph digest does not match the retained generation.',
          )
        }
        return {
          selector: {
            kind: 'proposal-generation',
            generationId: source.generationId,
            graph: source.side === 'base' ? 'base' : 'proposed',
          },
          repositoryRoot: target.repositoryRoot,
          treeOid: source.side === 'base' ? target.baseTreeOid : target.proposedTreeOid,
        }
      }
      case 'diff-analysis':
      {
        if (source.threadId !== authorized.thread.id)
        {
          return yield* architectureError(
            operation,
            'identity-mismatch',
            'The diff architecture source does not belong to this thread.',
          )
        }
        const target = yield* diffAnalyses
          .retainReadyImpactTarget({
            workspaceRoot:
              authorized.thread.orchestrateRunExecution?.repositoryRoot ?? authorized.workspaceRoot,
            diffAnalysisId: source.diffAnalysisId,
            ...(operation === 'architecture_source' ? { sourceSide: source.side } : {}),
          })
          .pipe(
            Effect.mapError(() =>
              architectureError(
                operation,
                'context-not-ready',
                'The diff architecture source is no longer retained.',
                'complete_diff_analysis',
              ),
            ),
          )
        const digest = source.side === 'base' ? target.baseGraphDigest : target.headGraphDigest
        if (digest !== source.graphDigest)
        {
          return yield* architectureError(
            operation,
            'identity-mismatch',
            'The diff graph digest does not match the retained analysis.',
          )
        }
        const selector = {
          kind: 'diff-analysis' as const,
          diffAnalysisId: source.diffAnalysisId,
          graph: source.side,
        }
        // neighborhood never reads the retained tree; historical base seals omit it
        if (operation !== 'architecture_source')
        {
          return { selector }
        }
        const retainedRoot = source.side === 'base' ? target.baseRoot : target.headRoot
        if (retainedRoot === null)
        {
          return yield* architectureError(
            operation,
            'context-not-ready',
            'The immutable diff source side is no longer retained.',
            'complete_diff_analysis',
          )
        }
        return {
          selector,
          retainedRoot,
        }
      }
    }
  })

  const architectureNeighborhood: ArchitectureProjectionServiceShape['architectureNeighborhood'] =
    Effect.fn('ArchitectureProjectionService.architectureNeighborhood')(
      function* (authority, input)
      {
        const operation = 'architecture_neighborhood'
        return yield* Effect.scoped(
          Effect.gen(function* ()
          {
            const authorized = yield* resolveAuthority(authority, operation)
            const verified = yield* verifyGraphSource(authorized, input.source, operation)
            const result = yield* architectureQueries.blastRadius(
              authority,
              {
                context: verified.selector,
                target: input.target,
                direction: input.direction,
                maxDepth: input.maxDepth,
              },
              'resolvedTarget' in verified ? verified.resolvedTarget : undefined,
            )
            return {
              version: 1 as const,
              source: input.source,
              target: input.target,
              direction: result.direction,
              maxDepth: result.maxDepth,
              upstream: result.upstream,
              downstream: result.downstream,
              impactedFileCount: result.impactedFileCount,
            }
          }),
        ).pipe(
          withMetrics({
            timer: architectureProjectionReadDuration,
            attributes: { kind: 'neighborhood' },
          }),
        )
      },
    )

  const architecturePathScope: ArchitectureProjectionServiceShape['architecturePathScope'] =
    Effect.fn('ArchitectureProjectionService.architecturePathScope')(function* (authority, input)
    {
      const operation = 'architecture_path_scope'
      return yield* Effect.scoped(
        Effect.gen(function* ()
        {
          const authorized = yield* resolveAuthority(authority, operation)
          const target = yield* retainStandingIndex(
            authorized,
            input.projectId,
            input.generationId,
            undefined,
            operation,
          )
          return {
            version: 1 as const,
            source: sourceIdentity(input.projectId, target.generation, target.graphDigest),
            chips: resolveArchitecturePathScope(target.index, input.paths),
          }
        }),
      ).pipe(
        withMetrics({
          timer: architectureProjectionReadDuration,
          attributes: { kind: 'path-scope' },
        }),
      )
    })

  const architectureSource: ArchitectureProjectionServiceShape['architectureSource'] = Effect.fn(
    'ArchitectureProjectionService.architectureSource',
  )(function* (authority, input)
  {
    const operation = 'architecture_source'
    return yield* Effect.scoped(
      Effect.gen(function* ()
      {
        const authorized = yield* resolveAuthority(authority, operation)
        const verified = yield* verifyGraphSource(authorized, input.source, operation)
        if (!('repositoryRoot' in verified) && !('retainedRoot' in verified))
        {
          return yield* architectureError(
            operation,
            'unsupported',
            'Standing Repository Atlas files open through the current workspace Files surface.',
          )
        }
        const sourceRead =
          'retainedRoot' in verified
            ? readRetainedText(verified.retainedRoot, input.relativePath)
            : readGitText(verified.repositoryRoot, verified.treeOid, input.relativePath)
        const source = yield* sourceRead.pipe(
          Effect.mapError((error) =>
          {
            switch (error.code)
            {
              case 'not-found':
                return architectureError(
                  operation,
                  'target-not-found',
                  'The immutable source file was not found in the selected tree.',
                )
              case 'too-large':
                return architectureError(
                  operation,
                  'limit-exceeded',
                  'The immutable source file exceeds the native source byte limit.',
                  {
                    limit: {
                      kind: 'bytes',
                      scope: 'source',
                      actual: error.actualBytes ?? ARCHITECTURE_SOURCE_MAX_BYTES + 1,
                      limit: ARCHITECTURE_SOURCE_MAX_BYTES,
                    },
                  },
                )
              case 'binary':
                return architectureError(
                  operation,
                  'unsupported',
                  'The selected immutable source is not UTF-8 text.',
                )
              case 'git-failed':
                return architectureError(
                  operation,
                  'evaluation-failed',
                  'The immutable Git source object could not be read.',
                )
            }
          }),
        )
        return {
          version: 1 as const,
          source: input.source,
          relativePath: input.relativePath,
          sourceDigest: source.digest,
          content: source.content,
        }
      }),
    ).pipe(
      withMetrics({ timer: architectureProjectionReadDuration, attributes: { kind: 'source' } }),
    )
  })

  return ArchitectureProjectionService.of({
    repositoryMap,
    architectureScope,
    architectureNeighborhood,
    architecturePathScope,
    architectureSource,
  })
})

export const layer = Layer.effect(ArchitectureProjectionService, make)
