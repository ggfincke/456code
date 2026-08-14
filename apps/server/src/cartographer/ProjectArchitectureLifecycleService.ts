// apps/server/src/cartographer/ProjectArchitectureLifecycleService.ts
// owns standing-project architecture binding, rebuild, retention, status, and cleanup

// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFSP from 'node:fs/promises'
import * as NodePath from 'node:path'

import {
  type ArchitectureStandingSource,
  CartographerError,
  type ProjectAtlasStatus,
  type ProjectId,
} from '@t3tools/contracts'
import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as PubSub from 'effect/PubSub'
import * as Semaphore from 'effect/Semaphore'
import * as Stream from 'effect/Stream'

import * as ServerConfig from '../config.ts'
import * as CartographerAnalyzer from './CartographerAnalyzer.ts'
import * as AtlasRebuildService from './AtlasRebuildService.ts'
import {
  loadReusableProjectAtlas,
  projectAtlasDirectory,
  PROJECT_ATLAS_METADATA_FILENAME,
  type ProjectAtlasMetadata,
} from './AtlasRebuildService.ts'
import * as ProjectAtlasStatusBroadcaster from './ProjectAtlasStatusBroadcaster.ts'

class ProjectArchitectureLifecycleFsError extends Data.TaggedError(
  'ProjectArchitectureLifecycleFsError',
)<{
  readonly cause: unknown
}>
{}

export interface ProjectArchitectureSnapshot
{
  readonly root: string
  readonly outDir: string
  readonly generation: ArchitectureStandingSource['generationId']
  readonly graphDigest: ArchitectureStandingSource['graphDigest']
  readonly builtAt: string
}

export interface ProjectArchitectureRetentionChange
{
  readonly projectId: ProjectId
  readonly retained: boolean
  readonly root: string | null
}

export interface EnsureProjectArchitectureInput
{
  readonly projectId: ProjectId
  readonly workspaceRoot: string
}

interface ProjectBindingState
{
  readonly canonicalRoot: string | null
  readonly epoch: number
  readonly publicationEpoch: number
  readonly deleted: boolean
}

interface ProjectBindingToken
{
  readonly projectId: ProjectId
  readonly canonicalRoot: string
  readonly epoch: number
}

interface ProjectBuildToken extends ProjectBindingToken
{
  readonly publicationEpoch: number
}

export interface ProjectArchitectureAnalyzer
{
  readonly identify: Effect.Effect<
    CartographerAnalyzer.CartographerAnalyzerIdentity,
    CartographerError
  >
}

export interface ProjectArchitectureRebuilder
{
  readonly request: (
    input: AtlasRebuildService.ProjectAtlasBuildRequest,
  ) => Effect.Effect<ProjectAtlasMetadata, CartographerError>
  readonly withStablePublication: <A, E, R>(
    projectId: ProjectId,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
  readonly invalidate: (projectId: ProjectId, throughRevision?: number) => Effect.Effect<void>
}

export interface ProjectArchitectureLifecycleServiceShape
{
  readonly ensureProject: (
    input: EnsureProjectArchitectureInput,
  ) => Effect.Effect<ProjectArchitectureSnapshot, CartographerError>
  readonly rebuildProject: (
    input: EnsureProjectArchitectureInput,
  ) => Effect.Effect<ProjectArchitectureSnapshot, CartographerError>
  readonly closeProject: (projectId: ProjectId) => Effect.Effect<void>
  readonly invalidateProjectMetadata: (
    projectId: ProjectId,
    workspaceRoot: string,
  ) => Effect.Effect<void, CartographerError>
  readonly deleteProjectArtifacts: (projectId: ProjectId) => Effect.Effect<void, CartographerError>
  readonly retainProjectStatus: (projectId: ProjectId) => Effect.Effect<void>
  readonly releaseProjectStatus: (projectId: ProjectId) => Effect.Effect<void>
  readonly hasRetainedProjectContext: (projectId: ProjectId) => Effect.Effect<boolean>
  readonly projectRetentionChanges: Stream.Stream<ProjectArchitectureRetentionChange>
  readonly getProjectSnapshot: (
    projectId: ProjectId,
  ) => Effect.Effect<ProjectArchitectureSnapshot | null>
  readonly isProjectDeleted: (projectId: ProjectId) => Effect.Effect<boolean>
  readonly closeAll: Effect.Effect<void>
}

export class ProjectArchitectureLifecycleService extends Context.Service<
  ProjectArchitectureLifecycleService,
  ProjectArchitectureLifecycleServiceShape
>()('456code/cartographer/ProjectArchitectureLifecycleService')
{}

export interface ProjectArchitectureLifecycleServiceOptions
{
  readonly stateDir: string
  readonly analyzer?: ProjectArchitectureAnalyzer
  readonly projectRebuilder: ProjectArchitectureRebuilder
  readonly projectStatusBroadcaster?: ProjectAtlasStatusBroadcaster.ProjectAtlasStatusBroadcasterShape
  readonly disposeArchitectureArtifacts?: (root: string, outDir: string) => Promise<void>
}

function publicError(failure: CartographerError['failure'], message: string): CartographerError
{
  return new CartographerError({ failure, message })
}

function bindingChanged(): CartographerError
{
  return publicError(
    'workspace_context_not_found',
    'The project workspace binding changed before the architecture operation completed.',
  )
}

function deletedProject(): CartographerError
{
  return publicError('context_start_failed', 'Project architecture is no longer available.')
}

function snapshotForMetadata(
  outDir: string,
  metadata: ProjectAtlasMetadata & { readonly version: 2 },
): ProjectArchitectureSnapshot
{
  return {
    root: metadata.workspaceRoot,
    outDir,
    generation: metadata.generation as ArchitectureStandingSource['generationId'],
    graphDigest: metadata.graphDigest as ArchitectureStandingSource['graphDigest'],
    builtAt: metadata.builtAt,
  }
}

function sourceForSnapshot(
  projectId: ProjectId,
  snapshot: ProjectArchitectureSnapshot,
): ArchitectureStandingSource
{
  return {
    kind: 'standing-project-generation',
    projectId,
    generationId: snapshot.generation,
    side: 'analyzed',
    graphDigest: snapshot.graphDigest,
  }
}

export const make = Effect.fn('ProjectArchitectureLifecycleService.make')(function* (
  options: ProjectArchitectureLifecycleServiceOptions,
)
{
  const bindings = new Map<ProjectId, ProjectBindingState>()
  const snapshots = new Map<ProjectId, ProjectArchitectureSnapshot>()
  const subscribers = new Map<ProjectId, number>()
  const locks = new Map<ProjectId, Semaphore.Semaphore>()
  const retentionChanges = yield* Effect.acquireRelease(
    PubSub.unbounded<ProjectArchitectureRetentionChange>(),
    PubSub.shutdown,
  )
  let closed = false

  const updateProjectStatus = options.projectStatusBroadcaster?.update
  const disposeArchitectureArtifacts =
    options.disposeArchitectureArtifacts ??
    (async (root: string, outDir: string) =>
    {
      const core = await import('@t3tools/cartographer-core/server')
      await core.disposeAtlasArtifacts(root, outDir)
    })

  const disposeSnapshot = (snapshot: ProjectArchitectureSnapshot | undefined) =>
    snapshot === undefined
      ? Effect.void
      : Effect.tryPromise({
          try: () => disposeArchitectureArtifacts(snapshot.root, snapshot.outDir),
          catch: (cause) => new ProjectArchitectureLifecycleFsError({ cause }),
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning('project architecture disposal failed', {
              cause,
              root: snapshot.root,
            }),
          ),
        )

  const lockForProject = Effect.fn('ProjectArchitectureLifecycleService.lockForProject')(function* (
    projectId: ProjectId,
  )
  {
    const existing = locks.get(projectId)
    if (existing !== undefined) return existing
    const created = yield* Semaphore.make(1)
    const raced = locks.get(projectId)
    if (raced !== undefined) return raced
    locks.set(projectId, created)
    return created
  })

  const publishRetention = (projectId: ProjectId) =>
    Effect.suspend(() =>
    {
      const snapshot = snapshots.get(projectId)
      const retained = snapshot !== undefined && (subscribers.get(projectId) ?? 0) > 0
      return PubSub.publish(retentionChanges, {
        projectId,
        retained,
        root: retained ? snapshot.root : null,
      }).pipe(Effect.asVoid)
    })

  const assertCurrentBinding = (token: ProjectBindingToken) =>
    Effect.suspend(() =>
    {
      const current = bindings.get(token.projectId)
      return current !== undefined &&
        !current.deleted &&
        current.canonicalRoot === token.canonicalRoot &&
        current.epoch === token.epoch
        ? Effect.void
        : Effect.fail(bindingChanged())
    })

  const captureProjectBinding = Effect.fn(
    'ProjectArchitectureLifecycleService.captureProjectBinding',
  )(function* (projectId: ProjectId, canonicalRoot: string)
  {
    const lock = yield* lockForProject(projectId)
    return yield* lock.withPermit(
      Effect.gen(function* ()
      {
        if (closed) return yield* deletedProject()
        const current = bindings.get(projectId)
        if (current?.deleted === true) return yield* deletedProject()
        if (current === undefined)
        {
          const created = {
            canonicalRoot,
            epoch: 1,
            publicationEpoch: 0,
            deleted: false,
          } as const
          bindings.set(projectId, created)
          return { projectId, canonicalRoot, epoch: created.epoch }
        }
        if (current.canonicalRoot !== canonicalRoot) return yield* bindingChanged()
        return { projectId, canonicalRoot, epoch: current.epoch }
      }),
    )
  })

  const withProjectBindingPermit = <A, E, R>(
    token: ProjectBuildToken,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | CartographerError, R> =>
    Effect.flatMap(lockForProject(token.projectId), (lock) =>
      lock.withPermit(
        Effect.gen(function* ()
        {
          yield* assertCurrentBinding(token)
          if (bindings.get(token.projectId)?.publicationEpoch !== token.publicationEpoch)
          {
            return yield* bindingChanged()
          }
          return yield* effect
        }),
      ),
    )

  const beginProjectBuild = Effect.fn('ProjectArchitectureLifecycleService.beginProjectBuild')(
    function* (token: ProjectBindingToken)
    {
      const lock = yield* lockForProject(token.projectId)
      return yield* lock.withPermit(
        Effect.gen(function* ()
        {
          yield* assertCurrentBinding(token)
          const current = bindings.get(token.projectId)
          if (current === undefined) return yield* bindingChanged()
          const publicationEpoch = current.publicationEpoch + 1
          bindings.set(token.projectId, { ...current, publicationEpoch })
          if (updateProjectStatus !== undefined)
          {
            yield* updateProjectStatus(token.projectId, (status) => ({
              ...status,
              state: 'building',
              freshness: { ...status.freshness, dirty: true },
              lastBuildError: null,
            }))
          }
          return { ...token, publicationEpoch }
        }),
      )
    },
  )

  const updateStatusForCurrentBuild = (
    token: ProjectBuildToken,
    update: (status: ProjectAtlasStatus) => ProjectAtlasStatus,
  ): Effect.Effect<void, CartographerError> =>
    Effect.flatMap(lockForProject(token.projectId), (lock) =>
      lock.withPermit(
        Effect.gen(function* ()
        {
          yield* assertCurrentBinding(token)
          if (bindings.get(token.projectId)?.publicationEpoch !== token.publicationEpoch)
          {
            return yield* bindingChanged()
          }
          if (updateProjectStatus !== undefined)
          {
            yield* updateProjectStatus(token.projectId, update)
          }
        }),
      ),
    )

  const markCurrentBuildFailed = (token: ProjectBuildToken, lastBuildError: string) =>
    updateStatusForCurrentBuild(token, (status) => ({
      ...status,
      state: 'error',
      freshness: { ...status.freshness, dirty: true },
      lastBuildError,
    })).pipe(Effect.ignore)

  const loadReusable = Effect.fn('ProjectArchitectureLifecycleService.loadReusable')(function* (
    token: ProjectBindingToken,
    analyzerFingerprint: string,
    publicationEpoch: number | null,
  )
  {
    const lock = yield* lockForProject(token.projectId)
    return yield* lock.withPermit(
      assertCurrentBinding(token).pipe(
        Effect.andThen(
          options.projectRebuilder.withStablePublication(
            token.projectId,
            Effect.gen(function* ()
            {
              const outDir = projectAtlasDirectory(options.stateDir, token.projectId)
              const metadata = yield* Effect.promise(() =>
                loadReusableProjectAtlas({
                  projectId: token.projectId,
                  root: token.canonicalRoot,
                  outDir,
                  analyzerFingerprint,
                }),
              )
              if (metadata === null || metadata.version !== 2) return null
              const snapshot = snapshotForMetadata(outDir, metadata)
              snapshots.set(token.projectId, snapshot)
              if (updateProjectStatus !== undefined)
              {
                yield* updateProjectStatus(token.projectId, (status) =>
                {
                  const authoritativeBuild =
                    publicationEpoch !== null &&
                    bindings.get(token.projectId)?.publicationEpoch === publicationEpoch
                  const preserveBuildState =
                    !authoritativeBuild && (status.state === 'building' || status.state === 'error')
                  return {
                    ...status,
                    state: preserveBuildState ? status.state : 'ready',
                    source: sourceForSnapshot(token.projectId, snapshot),
                    freshness: {
                      builtAt: snapshot.builtAt,
                      dirty: preserveBuildState ? status.freshness.dirty : false,
                    },
                    lastBuildError: preserveBuildState ? status.lastBuildError : null,
                  }
                })
              }
              yield* publishRetention(token.projectId)
              return snapshot
            }),
          ),
        ),
      ),
    )
  })

  const rebuildBoundProject = Effect.fn('ProjectArchitectureLifecycleService.rebuildBoundProject')(
    function* (token: ProjectBindingToken)
    {
      const buildToken = yield* beginProjectBuild(token)
      const rebuilt = yield* Effect.exit(
        options.projectRebuilder.request({
          projectId: token.projectId,
          root: token.canonicalRoot,
          requestRevision: buildToken.publicationEpoch,
          withPublicationPermit: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            withProjectBindingPermit(buildToken, effect),
        }),
      )
      if (rebuilt._tag === 'Failure')
      {
        yield* markCurrentBuildFailed(
          buildToken,
          'Project architecture rebuild failed; the last good build remains available.',
        )
        return yield* Effect.failCause(rebuilt.cause)
      }
      const committed = yield* Effect.exit(
        loadReusable(token, rebuilt.value.analyzerFingerprint, buildToken.publicationEpoch),
      )
      if (committed._tag === 'Failure')
      {
        yield* markCurrentBuildFailed(
          buildToken,
          'Project architecture was published but could not be loaded; the last good build remains available.',
        )
        return yield* Effect.failCause(committed.cause)
      }
      if (committed.value === null)
      {
        yield* markCurrentBuildFailed(
          buildToken,
          'Project architecture was published but failed verification; the last good build remains available.',
        )
        return yield* publicError(
          'context_start_failed',
          'Project architecture artifacts were not reusable after rebuilding.',
        )
      }
      return committed.value
    },
  )

  const resolveRoot = (workspaceRoot: string) =>
    Effect.tryPromise({
      try: () => NodeFSP.realpath(workspaceRoot),
      catch: () =>
        publicError('workspace_context_not_found', 'The project workspace is unavailable.'),
    })

  const ensureProject: ProjectArchitectureLifecycleServiceShape['ensureProject'] = (input) =>
    Effect.gen(function* ()
    {
      if (options.analyzer === undefined)
      {
        return yield* publicError('unsupported', 'Standing project architecture is unavailable.')
      }
      const root = yield* resolveRoot(input.workspaceRoot)
      const analyzer = yield* options.analyzer.identify
      const token = yield* captureProjectBinding(input.projectId, root)
      const reusable = yield* loadReusable(token, analyzer.fingerprint, null)
      return reusable ?? (yield* rebuildBoundProject(token))
    })

  const rebuildProject: ProjectArchitectureLifecycleServiceShape['rebuildProject'] = (input) =>
    Effect.gen(function* ()
    {
      if (options.analyzer === undefined)
      {
        return yield* publicError('unsupported', 'Standing project architecture is unavailable.')
      }
      const root = yield* resolveRoot(input.workspaceRoot)
      yield* options.analyzer.identify
      const token = yield* captureProjectBinding(input.projectId, root)
      return yield* rebuildBoundProject(token)
    })

  const closeProject: ProjectArchitectureLifecycleServiceShape['closeProject'] = (projectId) =>
    Effect.gen(function* ()
    {
      const lock = yield* lockForProject(projectId)
      const transition = yield* lock.withPermit(
        Effect.sync(() =>
        {
          const current = bindings.get(projectId)
          if (current?.deleted === true) return null
          const snapshot = snapshots.get(projectId)
          const publicationEpoch = (current?.publicationEpoch ?? 0) + 1
          bindings.set(projectId, {
            canonicalRoot: null,
            epoch: (current?.epoch ?? 0) + 1,
            publicationEpoch,
            deleted: true,
          })
          snapshots.delete(projectId)
          return { publicationEpoch, snapshot }
        }),
      )
      if (transition !== null)
      {
        yield* options.projectRebuilder.invalidate(projectId, transition.publicationEpoch)
        yield* options.projectRebuilder.withStablePublication(
          projectId,
          disposeSnapshot(transition.snapshot),
        )
      }
      if (updateProjectStatus !== undefined)
      {
        yield* updateProjectStatus(projectId, (status) => ({
          ...status,
          state: 'idle',
          source: null,
          freshness: { ...status.freshness, dirty: true },
        }))
      }
      yield* publishRetention(projectId)
    })

  const invalidateProjectMetadata: ProjectArchitectureLifecycleServiceShape['invalidateProjectMetadata'] =
    (projectId, workspaceRoot) =>
      Effect.gen(function* ()
      {
        const lock = yield* lockForProject(projectId)
        const transitionFence = yield* lock.withPermit(
          Effect.sync(() =>
          {
            const current = bindings.get(projectId)
            if (current?.deleted === true) return null
            const snapshot = snapshots.get(projectId)
            const transition = {
              epoch: (current?.epoch ?? 0) + 1,
              publicationEpoch: (current?.publicationEpoch ?? 0) + 1,
            }
            bindings.set(projectId, {
              canonicalRoot: null,
              ...transition,
              deleted: false,
            })
            snapshots.delete(projectId)
            return { ...transition, snapshot }
          }),
        )
        if (transitionFence === null) return
        const canonicalRoot = yield* Effect.exit(resolveRoot(workspaceRoot))
        const transitionIsCurrent = yield* lock.withPermit(
          Effect.sync(() =>
          {
            const current = bindings.get(projectId)
            return (
              current?.deleted === false &&
              current.canonicalRoot === null &&
              current.epoch === transitionFence.epoch
            )
          }),
        )
        if (!transitionIsCurrent) return
        yield* options.projectRebuilder.invalidate(projectId, transitionFence.publicationEpoch)
        const cleaned = yield* lock.withPermit(
          Effect.gen(function* ()
          {
            const current = bindings.get(projectId)
            if (
              current?.deleted !== false ||
              current.canonicalRoot !== null ||
              current.epoch !== transitionFence.epoch
            )
            {
              return false
            }
            yield* options.projectRebuilder.withStablePublication(
              projectId,
              disposeSnapshot(transitionFence.snapshot).pipe(
                Effect.andThen(
                  Effect.tryPromise({
                    try: () =>
                      NodeFSP.rm(
                        NodePath.join(
                          projectAtlasDirectory(options.stateDir, projectId),
                          PROJECT_ATLAS_METADATA_FILENAME,
                        ),
                        { force: true },
                      ),
                    catch: (cause) => new ProjectArchitectureLifecycleFsError({ cause }),
                  }).pipe(Effect.ignore),
                ),
              ),
            )
            bindings.set(projectId, {
              canonicalRoot: canonicalRoot._tag === 'Success' ? canonicalRoot.value : null,
              epoch: transitionFence.epoch,
              publicationEpoch: current.publicationEpoch,
              deleted: false,
            })
            if (updateProjectStatus !== undefined)
            {
              yield* updateProjectStatus(projectId, () => ({
                state: 'idle',
                source: null,
                freshness: { builtAt: null, dirty: true },
                lastBuildError: null,
              }))
            }
            yield* publishRetention(projectId)
            return true
          }),
        )
        if (!cleaned) return
        if (canonicalRoot._tag === 'Failure') return yield* Effect.failCause(canonicalRoot.cause)
      })

  const deleteProjectArtifacts: ProjectArchitectureLifecycleServiceShape['deleteProjectArtifacts'] =
    (projectId) =>
      Effect.gen(function* ()
      {
        yield* closeProject(projectId)
        const lock = yield* lockForProject(projectId)
        yield* lock.withPermit(
          options.projectRebuilder.withStablePublication(
            projectId,
            Effect.gen(function* ()
            {
              const outDir = yield* Effect.try({
                try: () => projectAtlasDirectory(options.stateDir, projectId),
                catch: () =>
                  publicError(
                    'context_start_failed',
                    'The project architecture artifact path is invalid.',
                  ),
              })
              yield* Effect.uninterruptible(
                Effect.tryPromise({
                  try: () =>
                    NodeFSP.rm(outDir, {
                      recursive: true,
                      force: true,
                      maxRetries: 3,
                      retryDelay: 25,
                    }),
                  catch: () =>
                    publicError(
                      'context_start_failed',
                      'Project architecture artifacts could not be deleted.',
                    ),
                }),
              )
              snapshots.delete(projectId)
              subscribers.delete(projectId)
              if (updateProjectStatus !== undefined)
              {
                yield* updateProjectStatus(projectId, () => ({
                  state: 'idle',
                  source: null,
                  freshness: { builtAt: null, dirty: true },
                  lastBuildError: null,
                }))
              }
            }),
          ),
        )
        yield* publishRetention(projectId)
      })

  const retainProjectStatus: ProjectArchitectureLifecycleServiceShape['retainProjectStatus'] = (
    projectId,
  ) =>
    Effect.flatMap(lockForProject(projectId), (lock) =>
      lock.withPermit(
        Effect.gen(function* ()
        {
          if (bindings.get(projectId)?.deleted === true) return
          subscribers.set(projectId, (subscribers.get(projectId) ?? 0) + 1)
          yield* publishRetention(projectId)
        }),
      ),
    )

  const releaseProjectStatus: ProjectArchitectureLifecycleServiceShape['releaseProjectStatus'] = (
    projectId,
  ) =>
    Effect.flatMap(lockForProject(projectId), (lock) =>
      lock.withPermit(
        Effect.gen(function* ()
        {
          const count = subscribers.get(projectId) ?? 0
          if (count <= 1) subscribers.delete(projectId)
          else subscribers.set(projectId, count - 1)
          yield* publishRetention(projectId)
        }),
      ),
    )

  const hasRetainedProjectContext: ProjectArchitectureLifecycleServiceShape['hasRetainedProjectContext'] =
    (projectId) =>
      Effect.flatMap(lockForProject(projectId), (lock) =>
        lock.withPermit(
          Effect.sync(
            () =>
              bindings.get(projectId)?.deleted !== true &&
              snapshots.has(projectId) &&
              (subscribers.get(projectId) ?? 0) > 0,
          ),
        ),
      )

  const getProjectSnapshot: ProjectArchitectureLifecycleServiceShape['getProjectSnapshot'] = (
    projectId,
  ) =>
    Effect.flatMap(lockForProject(projectId), (lock) =>
      lock.withPermit(
        Effect.sync(() =>
          bindings.get(projectId)?.deleted === true ? null : (snapshots.get(projectId) ?? null),
        ),
      ),
    )

  const isProjectDeleted: ProjectArchitectureLifecycleServiceShape['isProjectDeleted'] = (
    projectId,
  ) =>
    Effect.flatMap(lockForProject(projectId), (lock) =>
      lock.withPermit(Effect.sync(() => bindings.get(projectId)?.deleted === true)),
    )

  const closeAll: ProjectArchitectureLifecycleServiceShape['closeAll'] = Effect.gen(function* ()
  {
    if (closed) return
    closed = true
    const retained = [...snapshots.entries()].map(([projectId, snapshot]) => ({
      projectId,
      snapshot,
      publicationEpoch: (bindings.get(projectId)?.publicationEpoch ?? 0) + 1,
    }))
    bindings.clear()
    snapshots.clear()
    subscribers.clear()
    yield* Effect.forEach(
      retained,
      ({ projectId, publicationEpoch, snapshot }) =>
        options.projectRebuilder.invalidate(projectId, publicationEpoch).pipe(
          Effect.andThen(
            options.projectRebuilder.withStablePublication(projectId, disposeSnapshot(snapshot)),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning('project architecture shutdown cleanup failed', {
              cause,
              projectId,
            }),
          ),
        ),
      { concurrency: 'unbounded', discard: true },
    )
    locks.clear()
  })

  return ProjectArchitectureLifecycleService.of({
    ensureProject,
    rebuildProject,
    closeProject,
    invalidateProjectMetadata,
    deleteProjectArtifacts,
    retainProjectStatus,
    releaseProjectStatus,
    hasRetainedProjectContext,
    projectRetentionChanges: Stream.fromPubSub(retentionChanges),
    getProjectSnapshot,
    isProjectDeleted,
    closeAll,
  })
})

export const layer = Layer.effect(
  ProjectArchitectureLifecycleService,
  Effect.gen(function* ()
  {
    const config = yield* ServerConfig.ServerConfig
    const analyzer = yield* CartographerAnalyzer.CartographerAnalyzer
    const projectRebuilder = yield* AtlasRebuildService.AtlasRebuildService
    const projectStatusBroadcaster =
      yield* ProjectAtlasStatusBroadcaster.ProjectAtlasStatusBroadcaster
    return yield* Effect.acquireRelease(
      make({
        stateDir: config.stateDir,
        analyzer,
        projectRebuilder,
        projectStatusBroadcaster,
      }),
      (service) => service.closeAll,
    )
  }),
)
