// apps/server/src/cartographer/ArchitectureProjectionService.ts
// serves generation-bound bounded architecture projections to native clients

// @effect-diagnostics nodeBuiltinImport:off

import * as NodeChildProcess from 'node:child_process'
import * as NodeCrypto from 'node:crypto'
import * as NodeFSP from 'node:fs/promises'
import * as NodePath from 'node:path'

import {
  ARCHITECTURE_SOURCE_MAX_BYTES,
  ArchitectureToolError,
  type ArchitectureGraphProjection,
  type ArchitectureGraphProjectionBreadcrumb,
  type ArchitectureGraphProjectionNode,
  type ArchitectureLimit,
  type ArchitectureRecoveryAction,
  type ArchitectureStandingSource,
  type ProjectAtlasStatus,
  type ArchitectureToolErrorCode,
  type CartographerGetArchitectureScopeInput,
  type CartographerGetArchitectureSourceInput,
  type CartographerGetArchitectureSourceResult,
  type CartographerGetRepositoryMapInput,
  type OrchestrationProjectShell,
  type OrchestrationThread,
} from '@t3tools/contracts'
import {
  type AtlasIndexFile,
  type AtlasIndexFileCrosswalk,
  type AtlasIndexStructureDirectory,
  type AtlasIndexUnit,
  type AtlasIndexV6,
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
  architectureGraphViewErrorMetricAttributes,
  architectureGraphViewMetricAttributes,
  architectureGraphViewsTotal,
  architectureProjectionReadDuration,
  increment,
  withMetrics,
} from '../observability/Metrics.ts'
import * as ProposalGenerationService from '../proposal/ProposalGenerationService.ts'
import type * as ArchitectureQueryService from './ArchitectureQueryService.ts'
import * as AtlasRebuildService from './AtlasRebuildService.ts'
import { resolveStandingCrossLensAnchors } from './architectureStandingAnchors.ts'
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
  ) => Effect.Effect<ArchitectureGraphProjection, ArchitectureToolError>
  readonly architectureScope: (
    authority: ArchitectureQueryService.ArchitectureQueryAuthority,
    input: CartographerGetArchitectureScopeInput,
  ) => Effect.Effect<ArchitectureGraphProjection, ArchitectureToolError>
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

function standingTint(id: string): string
{
  return NodeCrypto.createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 12)
}

function standingEdgeId(from: string, to: string): string
{
  const hash = NodeCrypto.createHash('sha256')
  for (const value of [from, to, 'imports'])
  {
    hash.update(value)
    hash.update('\0')
  }
  return `edge:${hash.digest('hex')}`
}

function standingUnitNode(unit: AtlasIndexUnit): ArchitectureGraphProjectionNode
{
  return {
    id: unit.id,
    label: unit.label,
    semanticLevel: unit.level,
    ...(unit.parent === undefined ? {} : { parentId: unit.parent }),
    ...(unit.level === 'dirs' && unit.key !== '.' ? { relativePath: unit.key as never } : {}),
    position: unit.position,
    tintKey: standingTint(unit.id),
    state: 'context',
    stateLabel: 'Context',
    badge: 'context',
    stroke: 'muted',
    fileCount: unit.fileCount,
    inbound: unit.inbound,
    outbound: unit.outbound,
    affectedConsumerCount: 0,
    evidenceRefs: [],
  }
}

function standingDirectoryNode(
  directory: AtlasIndexStructureDirectory,
): ArchitectureGraphProjectionNode
{
  return {
    id: directory.id,
    label: directory.label,
    semanticLevel: 'dirs',
    ...(directory.parentId === undefined ? {} : { parentId: directory.parentId }),
    ...(directory.key === '.' ? {} : { relativePath: directory.key as never }),
    position: directory.position,
    tintKey: standingTint(directory.id),
    state: 'context',
    stateLabel: 'Context',
    badge: 'context',
    stroke: 'muted',
    fileCount: directory.descendantFileCount,
    inbound: directory.inbound,
    outbound: directory.outbound,
    affectedConsumerCount: 0,
    evidenceRefs: [],
  }
}

function standingFileNode(
  file: AtlasIndexFile,
  membership: AtlasIndexFileCrosswalk,
  parentId = membership.directoryId,
): ArchitectureGraphProjectionNode
{
  return {
    id: file.id,
    label: file.label,
    semanticLevel: 'files',
    parentId,
    relativePath: file.id as never,
    position: membership.position,
    tintKey: standingTint(file.id),
    state: 'context',
    stateLabel: 'Context',
    badge: 'context',
    stroke: 'muted',
    fileCount: 1,
    inbound: file.fanIn,
    outbound: file.fanOut,
    affectedConsumerCount: 0,
    evidenceRefs: [],
  }
}

function standingProjection(input: {
  index: AtlasIndexV6
  source: ArchitectureStandingSource
  builtAt: string
  generatedAt: string
  freshness: ArchitectureGraphProjection['freshness']
  lens: 'architecture' | 'structure'
  semanticLevel: ArchitectureGraphProjection['semanticLevel']
  scopeKey: string
  breadcrumbs: ArchitectureGraphProjectionBreadcrumb[]
  nodes: ArchitectureGraphProjectionNode[]
  totalNodes: number
  edges: ReadonlyArray<{ readonly from: string; readonly to: string; readonly weight: number }>
  totalEdges: number
}): ArchitectureGraphProjection
{
  const nodes = input.nodes.slice(0, 60)
  const nodeIds = new Set(nodes.map((node) => node.id))
  const edges = input.edges
    .filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))
    .slice(0, 120)
    .map((edge) => ({
      id: standingEdgeId(edge.from, edge.to),
      from: edge.from,
      to: edge.to,
      relationshipKind: 'imports',
      weight: edge.weight,
      state: 'context' as const,
      stateLabel: 'Context' as const,
      stroke: 'muted' as const,
      evidenceRefs: [],
    }))
  const projection: ArchitectureGraphProjection = {
    projectionVersion: 1,
    projectionId: `standing:${input.source.generationId}:${input.lens}:${input.scopeKey}`,
    projectionRevision: 1,
    kind: 'repository-map',
    authority: 'standing',
    resultState: 'graph',
    freshness: input.freshness,
    generatedAt: input.generatedAt,
    publishedAt: input.builtAt,
    source: input.source,
    repository: {
      name: input.index.repo.name,
      scope: input.index.repo.scope,
      ...(input.index.repo.gitRef === undefined ? {} : { gitRef: input.index.repo.gitRef }),
    },
    lens: input.lens,
    semanticLevel: input.semanticLevel,
    breadcrumbs: input.breadcrumbs,
    layoutVersion: 'repository-map-v2',
    totals: {
      nodes: {
        total: input.totalNodes,
        returned: nodes.length,
        omitted: input.totalNodes - nodes.length,
      },
      edges: {
        total: input.totalEdges,
        returned: edges.length,
        omitted: input.totalEdges - edges.length,
      },
      evidence: { total: 0, returned: 0, omitted: 0 },
      changedFiles: { total: 0, returned: 0, omitted: 0 },
    },
    nodes,
    edges,
    evidence: [],
    anchors: [],
  }
  return {
    ...projection,
    anchors: resolveStandingCrossLensAnchors({
      index: input.index,
      source: input.source,
      lens: input.lens,
      projection,
      stale: input.freshness === 'stale',
    }),
  }
}

function standingFreshness(
  source: ArchitectureStandingSource,
  status: ProjectAtlasStatus,
): ArchitectureGraphProjection['freshness']
{
  if (
    status.source === null ||
    status.source.projectId !== source.projectId ||
    status.source.kind !== source.kind ||
    status.source.side !== source.side ||
    status.source.generationId !== source.generationId ||
    status.source.graphDigest !== source.graphDigest
  )
  {
    return 'stale'
  }
  return status.freshness.dirty ? 'dirty' : 'fresh'
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
          'The requested sealed Repository Map generation is not available.',
          'build_project_atlas',
        )
      }
      if (graphDigest !== undefined && target.graphDigest !== graphDigest)
      {
        return yield* architectureError(
          operation,
          'identity-mismatch',
          'The requested Repository Map graph digest does not match its generation.',
        )
      }
      return target
    },
  )

  const repositoryMapProjection = Effect.fn(
    'ArchitectureProjectionService.repositoryMapProjection',
  )(function* (
    authority: ArchitectureQueryService.ArchitectureQueryAuthority,
    input: CartographerGetRepositoryMapInput,
  )
  {
    const operation = 'architecture_repository_map'
    const authorized = yield* resolveAuthority(authority, operation)
    const target = yield* retainStandingIndex(
      authorized,
      input.projectId,
      input.generationId,
      undefined,
      operation,
    )
    const source = sourceIdentity(input.projectId, target.generation, target.graphDigest)
    const status = yield* projectStatus.getStatus(input.projectId)
    const index = target.index
    if (input.focusIds !== undefined && input.focusIds.length > 0)
    {
      const memberships = new Map(
        index.crosswalks.files.map((membership) => [membership.fileId, membership]),
      )
      const nodes = input.focusIds.flatMap((id) =>
      {
        if (input.lens === 'architecture')
        {
          const unit = [...index.units.systems, ...index.units.blocks].find(
            (candidate) => candidate.id === id,
          )
          if (unit !== undefined) return [standingUnitNode(unit)]
          const file = index.files.find((candidate) => candidate.id === id)
          const membership = memberships.get(id)
          return file === undefined || membership === undefined
            ? []
            : [standingFileNode(file, membership, membership.blockId)]
        }
        const directory = index.structure.directories.find((candidate) => candidate.id === id)
        if (directory !== undefined) return [standingDirectoryNode(directory)]
        const file = index.files.find((candidate) => candidate.id === id)
        const membership = memberships.get(id)
        return file === undefined || membership === undefined
          ? []
          : [standingFileNode(file, membership)]
      })
      if (nodes.length !== input.focusIds.length)
      {
        return yield* architectureError(
          operation,
          'target-not-found',
          'One or more exact Repository Map anchor candidates are absent from this generation.',
        )
      }
      const nodeIds = new Set(nodes.map((node) => node.id))
      const level = nodes[0]!.semanticLevel
      const sourceEdges =
        input.lens === 'structure'
          ? level === 'files'
            ? index.structure.fileEdges
            : index.structure.edges
          : level === 'systems' || level === 'blocks'
            ? index.edges[level]
            : index.structure.fileEdges
      const edges = sourceEdges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))
      return standingProjection({
        index,
        source,
        builtAt: target.builtAt,
        generatedAt: index.sourceGeneratedAt,
        freshness: standingFreshness(source, status),
        lens: input.lens,
        semanticLevel: level,
        scopeKey: `focus:${standingTint(input.focusIds.join('\0'))}`,
        breadcrumbs: [],
        nodes,
        totalNodes: nodes.length,
        edges,
        totalEdges: edges.length,
      })
    }
    if (input.lens === 'architecture')
    {
      const level: 'systems' | 'blocks' = index.counts.systems > 0 ? 'systems' : 'blocks'
      const exactTotal = level === 'systems' ? index.counts.systems : index.counts.blocks
      return standingProjection({
        index,
        source,
        builtAt: target.builtAt,
        generatedAt: index.sourceGeneratedAt,
        freshness: standingFreshness(source, status),
        lens: 'architecture',
        semanticLevel: level,
        scopeKey: 'root',
        breadcrumbs: [],
        nodes: index.units[level].map(standingUnitNode),
        totalNodes: exactTotal,
        edges: index.edges[level],
        totalEdges: index.edgeCounts[level].total,
      })
    }
    const root = index.structure.directories.find(
      (directory) => directory.id === index.structure.rootId,
    )!
    const directoryIds = new Set(root.childDirectoryIds)
    const fileIds = new Set(root.directFileIds)
    const membershipByFile = new Map(
      index.crosswalks.files.map((membership) => [membership.fileId, membership]),
    )
    const nodes = [
      ...index.structure.directories
        .filter((directory) => directoryIds.has(directory.id))
        .map(standingDirectoryNode),
      ...index.files
        .filter((file) => fileIds.has(file.id))
        .map((file) => standingFileNode(file, membershipByFile.get(file.id)!)),
    ]
    const edges = index.structure.edges.filter((edge) => edge.parent === root.id)
    return standingProjection({
      index,
      source,
      builtAt: target.builtAt,
      generatedAt: index.sourceGeneratedAt,
      freshness: standingFreshness(source, status),
      lens: 'structure',
      semanticLevel: root.childDirectoryIds.length > 0 ? 'dirs' : 'files',
      scopeKey: root.id,
      breadcrumbs: [],
      nodes,
      totalNodes: root.childDirectoryIds.length + root.directFileIds.length,
      edges,
      totalEdges: edges.length,
    })
  })

  const architectureBreadcrumbs = (
    index: AtlasIndexV6,
    scopeId: string,
  ): ArchitectureGraphProjectionBreadcrumb[] =>
  {
    const system = index.units.systems.find((unit) => unit.id === scopeId)
    if (system !== undefined) return [{ id: system.id, label: system.label, level: 'systems' }]
    const block = index.units.blocks.find((unit) => unit.id === scopeId)
    if (block !== undefined)
    {
      const parent = index.units.systems.find((unit) => unit.id === block.parent)
      return [
        ...(parent === undefined
          ? []
          : [{ id: parent.id, label: parent.label, level: 'systems' as const }]),
        { id: block.id, label: block.label, level: 'blocks' },
      ]
    }
    const file = index.files.find((item) => item.id === scopeId)
    if (file === undefined) return []
    const membership = index.crosswalks.files.find((item) => item.fileId === file.id)
    const blockUnit = index.units.blocks.find((unit) => unit.id === membership?.blockId)
    const systemUnit = index.units.systems.find((unit) => unit.id === membership?.systemId)
    return [
      ...(systemUnit === undefined
        ? []
        : [{ id: systemUnit.id, label: systemUnit.label, level: 'systems' as const }]),
      ...(blockUnit === undefined
        ? []
        : [{ id: blockUnit.id, label: blockUnit.label, level: 'blocks' as const }]),
      { id: file.id, label: file.label, level: 'files' },
    ]
  }

  const structureBreadcrumbs = (
    index: AtlasIndexV6,
    scopeId: string,
  ): ArchitectureGraphProjectionBreadcrumb[] =>
  {
    const file = index.files.find((item) => item.id === scopeId)
    let directoryId =
      file === undefined
        ? scopeId
        : index.crosswalks.files.find((item) => item.fileId === file.id)?.directoryId
    const directories: ArchitectureGraphProjectionBreadcrumb[] = []
    while (directoryId !== undefined)
    {
      const directory = index.structure.directories.find((item) => item.id === directoryId)
      if (directory === undefined) break
      directories.unshift({ id: directory.id, label: directory.label, level: 'dirs' })
      directoryId = directory.parentId
    }
    return [
      ...directories,
      ...(file === undefined ? [] : [{ id: file.id, label: file.label, level: 'files' as const }]),
    ]
  }

  const architectureScopeProjection = Effect.fn(
    'ArchitectureProjectionService.architectureScopeProjection',
  )(function* (
    authority: ArchitectureQueryService.ArchitectureQueryAuthority,
    input: CartographerGetArchitectureScopeInput,
  )
  {
    const operation = 'architecture_scope'
    const authorized = yield* resolveAuthority(authority, operation)
    const target = yield* retainStandingIndex(
      authorized,
      input.source.projectId,
      input.source.generationId,
      input.source.graphDigest,
      operation,
    )
    const index = target.index
    const status = yield* projectStatus.getStatus(input.source.projectId)
    const membershipByFile = new Map(
      index.crosswalks.files.map((membership) => [membership.fileId, membership]),
    )
    if (input.lens === 'architecture')
    {
      if (input.scope.level === 'systems')
      {
        const parent = index.units.systems.find((unit) => unit.id === input.scope.id)
        if (parent === undefined)
        {
          return yield* architectureError(
            operation,
            'target-not-found',
            'The system was not found.',
          )
        }
        const units = index.units.blocks.filter((unit) => unit.parent === parent.id)
        const ids = new Set(units.map((unit) => unit.id))
        const edges = index.edges.blocks.filter((edge) => ids.has(edge.from) && ids.has(edge.to))
        const summary = index.scopes.find(
          (scope) => scope.parent === parent.id && scope.childLevel === 'blocks',
        )
        return standingProjection({
          index,
          source: input.source,
          builtAt: target.builtAt,
          generatedAt: index.sourceGeneratedAt,
          freshness: standingFreshness(input.source, status),
          lens: 'architecture',
          semanticLevel: 'blocks',
          scopeKey: parent.id,
          breadcrumbs: architectureBreadcrumbs(index, parent.id),
          nodes: units.map(standingUnitNode),
          totalNodes: summary?.children.total ?? units.length,
          edges,
          totalEdges: summary?.edges.total ?? edges.length,
        })
      }
      if (input.scope.level === 'blocks')
      {
        const parent = index.units.blocks.find((unit) => unit.id === input.scope.id)
        if (parent === undefined)
        {
          return yield* architectureError(operation, 'target-not-found', 'The block was not found.')
        }
        const memberships = index.crosswalks.files.filter(
          (membership) => membership.blockId === parent.id,
        )
        const ids = new Set(memberships.map((membership) => membership.fileId))
        const files = index.files.filter((file) => ids.has(file.id))
        const edges = index.structure.fileEdges.filter(
          (edge) => ids.has(edge.from) && ids.has(edge.to),
        )
        return standingProjection({
          index,
          source: input.source,
          builtAt: target.builtAt,
          generatedAt: index.sourceGeneratedAt,
          freshness: standingFreshness(input.source, status),
          lens: 'architecture',
          semanticLevel: 'files',
          scopeKey: parent.id,
          breadcrumbs: architectureBreadcrumbs(index, parent.id),
          nodes: files.map((file) =>
            standingFileNode(file, membershipByFile.get(file.id)!, parent.id),
          ),
          totalNodes: files.length,
          edges,
          totalEdges: edges.length,
        })
      }
      if (input.scope.level === 'files')
      {
        const file = index.files.find((item) => item.id === input.scope.id)
        const membership = membershipByFile.get(input.scope.id)
        if (file === undefined || membership === undefined)
        {
          return yield* architectureError(operation, 'target-not-found', 'The file was not found.')
        }
        return standingProjection({
          index,
          source: input.source,
          builtAt: target.builtAt,
          generatedAt: index.sourceGeneratedAt,
          freshness: standingFreshness(input.source, status),
          lens: 'architecture',
          semanticLevel: 'files',
          scopeKey: file.id,
          breadcrumbs: architectureBreadcrumbs(index, file.id),
          nodes: [standingFileNode(file, membership, membership.blockId)],
          totalNodes: 1,
          edges: [],
          totalEdges: 0,
        })
      }
      return yield* architectureError(
        operation,
        'identity-mismatch',
        'The Architecture lens accepts only systems, blocks, or files.',
      )
    }
    if (input.scope.level === 'files')
    {
      const file = index.files.find((item) => item.id === input.scope.id)
      const membership = membershipByFile.get(input.scope.id)
      if (file === undefined || membership === undefined)
      {
        return yield* architectureError(operation, 'target-not-found', 'The file was not found.')
      }
      return standingProjection({
        index,
        source: input.source,
        builtAt: target.builtAt,
        generatedAt: index.sourceGeneratedAt,
        freshness: standingFreshness(input.source, status),
        lens: 'structure',
        semanticLevel: 'files',
        scopeKey: file.id,
        breadcrumbs: structureBreadcrumbs(index, file.id),
        nodes: [standingFileNode(file, membership)],
        totalNodes: 1,
        edges: [],
        totalEdges: 0,
      })
    }
    if (input.scope.level !== 'dirs')
    {
      return yield* architectureError(
        operation,
        'identity-mismatch',
        'The Structure lens accepts only directories or files.',
      )
    }
    const parent = index.structure.directories.find((directory) => directory.id === input.scope.id)
    if (parent === undefined)
    {
      return yield* architectureError(operation, 'target-not-found', 'The directory was not found.')
    }
    const childIds = new Set(parent.childDirectoryIds)
    const fileIds = new Set(parent.directFileIds)
    const nodes = [
      ...index.structure.directories
        .filter((directory) => childIds.has(directory.id))
        .map(standingDirectoryNode),
      ...index.files
        .filter((file) => fileIds.has(file.id))
        .map((file) => standingFileNode(file, membershipByFile.get(file.id)!)),
    ]
    const edges = index.structure.edges.filter((edge) => edge.parent === parent.id)
    return standingProjection({
      index,
      source: input.source,
      builtAt: target.builtAt,
      generatedAt: index.sourceGeneratedAt,
      freshness: standingFreshness(input.source, status),
      lens: 'structure',
      semanticLevel: parent.childDirectoryIds.length > 0 ? 'dirs' : 'files',
      scopeKey: parent.id,
      breadcrumbs: structureBreadcrumbs(index, parent.id),
      nodes,
      totalNodes: parent.childDirectoryIds.length + parent.directFileIds.length,
      edges,
      totalEdges: edges.length,
    })
  })

  const repositoryMap: ArchitectureProjectionServiceShape['repositoryMap'] = Effect.fn(
    'ArchitectureProjectionService.repositoryMap',
  )(function* (authority, input)
  {
    const projection = yield* Effect.scoped(repositoryMapProjection(authority, input)).pipe(
      withMetrics({ timer: architectureProjectionReadDuration, attributes: { kind: 'map' } }),
      Effect.tapError((error) =>
        increment(
          architectureGraphViewsTotal,
          architectureGraphViewErrorMetricAttributes(error.code),
        ),
      ),
    )
    yield* increment(architectureGraphViewsTotal, architectureGraphViewMetricAttributes(projection))
    return projection
  })

  const architectureScope: ArchitectureProjectionServiceShape['architectureScope'] = Effect.fn(
    'ArchitectureProjectionService.architectureScope',
  )(function* (authority, input)
  {
    const projection = yield* Effect.scoped(architectureScopeProjection(authority, input)).pipe(
      withMetrics({ timer: architectureProjectionReadDuration, attributes: { kind: 'scope' } }),
      Effect.tapError((error) =>
        increment(
          architectureGraphViewsTotal,
          architectureGraphViewErrorMetricAttributes(error.code),
        ),
      ),
    )
    yield* increment(architectureGraphViewsTotal, architectureGraphViewMetricAttributes(projection))
    return projection
  })

  const verifySourceIdentity = Effect.fn('ArchitectureProjectionService.verifySourceIdentity')(
    function* (
      authorized: AuthorizedArchitectureProject,
      source: CartographerGetArchitectureSourceInput['source'],
      operation: string,
    ): Effect.fn.Return<
      | { readonly repositoryRoot: string; readonly treeOid: string }
      | {
          readonly retainedRoot: string
        },
      ArchitectureToolError,
      Scope.Scope
    >
    {
      switch (source.kind)
      {
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
          const digest =
            source.side === 'base' ? target.baseGraphDigest : target.proposedGraphDigest
          if (digest !== source.graphDigest)
          {
            return yield* architectureError(
              operation,
              'identity-mismatch',
              'The proposal graph digest does not match the retained generation.',
            )
          }
          return {
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
                authorized.thread.orchestrateRunExecution?.repositoryRoot ??
                authorized.workspaceRoot,
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
          const retainedRoot = source.side === 'base' ? target.baseRoot : target.headRoot
          return { retainedRoot }
        }
      }
    },
  )

  const architectureSource: ArchitectureProjectionServiceShape['architectureSource'] = Effect.fn(
    'ArchitectureProjectionService.architectureSource',
  )(function* (authority, input)
  {
    const operation = 'architecture_source'
    return yield* Effect.scoped(
      Effect.gen(function* ()
      {
        const authorized = yield* resolveAuthority(authority, operation)
        const verified = yield* verifySourceIdentity(authorized, input.source, operation)
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
    architectureSource,
  })
})

export const layer = Layer.effect(ArchitectureProjectionService, make)
