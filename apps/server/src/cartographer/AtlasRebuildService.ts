// apps/server/src/cartographer/AtlasRebuildService.ts
// serializes and atomically publishes standing project atlas rebuilds

// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDateInEffect:off

import * as NodeCrypto from 'node:crypto'
import * as NodeFSP from 'node:fs/promises'
import * as NodePath from 'node:path'

import {
  ATLAS_INDEX_SCHEMA_VERSION,
  graphContentDigest,
  parseAtlasIndex,
  type AtlasIndex,
  type SourceGraphDigest,
} from '@t3tools/cartographer-core/server'
import { CartographerError, ProjectId } from '@t3tools/contracts'
import * as Context from 'effect/Context'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'
import * as Semaphore from 'effect/Semaphore'

import * as ServerConfig from '../config.ts'
import { architectureAtlasPublicationDuration, withMetrics } from '../observability/Metrics.ts'
import * as CartographerAnalyzer from './CartographerAnalyzer.ts'

export const PROJECT_ATLAS_METADATA_FILENAME = '.project-atlas.json'
export const PROJECT_ATLAS_PUBLISH_MARKER_FILENAME = '.publish.json'
const PROJECT_ID_PATH_SEGMENT = /^[A-Za-z0-9_-]{1,160}$/u
const GENERATION_PATTERN = /^[a-f0-9]{64}$/u
const PROJECT_ATLAS_INDEX_MAX_BYTES = 64 * 1024 * 1024

const ProjectAtlasMetadataSchema = Schema.Struct({
  version: Schema.Literal(2),
  projectId: ProjectId,
  workspaceRoot: Schema.String,
  analyzerFingerprint: Schema.String,
  generation: Schema.String,
  graphDigest: Schema.String,
  indexSchemaVersion: Schema.Literal(ATLAS_INDEX_SCHEMA_VERSION),
  indexSha256: Schema.String,
  indexByteLength: Schema.Number,
  builtAt: Schema.String,
})

export type ProjectAtlasMetadata = typeof ProjectAtlasMetadataSchema.Type

const ProjectAtlasPublishMarkerSchema = Schema.Struct({
  version: Schema.Literal(1),
  projectId: ProjectId,
  targetName: Schema.String,
  stagingName: Schema.String,
  backupName: Schema.String,
})

type ProjectAtlasPublishMarker = typeof ProjectAtlasPublishMarkerSchema.Type

const decodeJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)
const decodeMetadata = Schema.decodeUnknownSync(ProjectAtlasMetadataSchema, {
  onExcessProperty: 'error',
})
const decodeMarker = Schema.decodeUnknownSync(ProjectAtlasPublishMarkerSchema, {
  onExcessProperty: 'error',
})

export interface ProjectAtlasBuildRequest
{
  readonly projectId: ProjectId
  readonly root: string
  readonly requestRevision: number
  readonly withPublicationPermit: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | CartographerError, R>
}

export interface RetainedProjectAtlasTarget
{
  readonly projectId: ProjectId
  readonly root: string
  readonly outDir: string
  readonly graphPath: string
  readonly generation: string
  readonly builtAt: string
}

export interface RetainedProjectAtlasIndexTarget
{
  readonly projectId: ProjectId
  readonly root: string
  readonly outDir: string
  readonly graphPath: string
  readonly generation: string
  readonly graphDigest: SourceGraphDigest
  readonly builtAt: string
  readonly index: AtlasIndex
}

export interface AtlasRebuildServiceShape
{
  readonly request: (
    input: ProjectAtlasBuildRequest,
  ) => Effect.Effect<ProjectAtlasMetadata, CartographerError>
  readonly withStablePublication: <A, E, R>(
    projectId: ProjectId,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
  readonly retainLastGood: (
    projectId: ProjectId,
  ) => Effect.Effect<RetainedProjectAtlasTarget | null, never, Scope.Scope>
  readonly retainPublishedIndex: (
    projectId: ProjectId,
    generation?: string,
  ) => Effect.Effect<RetainedProjectAtlasIndexTarget | null, never, Scope.Scope>
  readonly invalidate: (projectId: ProjectId, throughRevision?: number) => Effect.Effect<void>
}

export class AtlasRebuildService extends Context.Service<
  AtlasRebuildService,
  AtlasRebuildServiceShape
>()('456code/cartographer/AtlasRebuildService')
{}

export interface AtlasRebuildAnalyzer
{
  readonly buildProjectAtlas: (
    input: CartographerAnalyzer.ProjectAtlasBuildInput,
  ) => Effect.Effect<CartographerAnalyzer.ProjectAtlasBuildResult, CartographerError>
}

export type AtlasArtifactsDisposer = (root: string, outDir: string) => Promise<void>

export interface AtlasRebuildServiceOptions
{
  readonly stateDir: string
  readonly analyzer: AtlasRebuildAnalyzer
  readonly disposeAtlasArtifacts?: AtlasArtifactsDisposer
  // test hook exposes the exact publication boundaries without replacing filesystem semantics
  readonly publicationHook?: (
    step:
      | 'staging-complete'
      | 'target-backed-up'
      | 'target-published'
      | 'marker-removed'
      | 'backup-removed',
    paths: { readonly target: string; readonly staging: string; readonly backup: string },
  ) => Promise<void>
  readonly now?: () => number
}

interface ActiveBuild
{
  requestedRoot: string
  requestRevision: number
  withPublicationPermit: ProjectAtlasBuildRequest['withPublicationPermit']
  dirty: boolean
  readonly controller: AbortController
  readonly completion: Deferred.Deferred<ProjectAtlasMetadata, CartographerError>
  fiber: Fiber.Fiber<void, never> | null
}

function publicError(message: string): CartographerError
{
  return new CartographerError({ failure: 'context_start_failed', message })
}

function pathSegment(value: string): string
{
  if (!PROJECT_ID_PATH_SEGMENT.test(value))
  {
    throw new Error('Project id is not a safe artifact path segment')
  }
  return value
}

export function projectAtlasDirectory(stateDir: string, projectId: ProjectId): string
{
  return NodePath.join(stateDir, 'cartographer', 'projects', pathSegment(projectId))
}

async function regularFile(path: string): Promise<boolean>
{
  try
  {
    const stat = await NodeFSP.lstat(path)
    return stat.isFile() && !stat.isSymbolicLink()
  }
  catch
  {
    return false
  }
}

async function directoryExists(path: string): Promise<boolean>
{
  try
  {
    const stat = await NodeFSP.lstat(path)
    return stat.isDirectory() && !stat.isSymbolicLink()
  }
  catch
  {
    return false
  }
}

async function removeDirectory(path: string): Promise<void>
{
  await NodeFSP.rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 })
}

async function recoverIncompleteStaging(
  projectsRoot: string,
  stagingName: string,
): Promise<boolean>
{
  const match = /^\.([A-Za-z0-9_-]+)\.staging-([a-f0-9]+)$/u.exec(stagingName)
  if (match === null) return false
  const projectId = match[1]!
  const suffix = match[2]!
  const staging = NodePath.join(projectsRoot, stagingName)
  const target = NodePath.join(projectsRoot, projectId)
  const backup = NodePath.join(projectsRoot, `.${projectId}.backup-${suffix}`)
  if (!(await directoryExists(target)) && (await directoryExists(backup)))
  {
    await NodeFSP.rename(backup, target)
  }
  await removeDirectory(staging)
  if (await directoryExists(target)) await removeDirectory(backup)
  return true
}

async function recoverOrphanedBackup(projectsRoot: string, backupName: string): Promise<boolean>
{
  const match = /^\.([A-Za-z0-9_-]+)\.backup-([a-f0-9]+)$/u.exec(backupName)
  if (match === null) return false
  const target = NodePath.join(projectsRoot, match[1]!)
  const backup = NodePath.join(projectsRoot, backupName)
  if (await directoryExists(target))
  {
    await removeDirectory(backup)
  }
  else
  {
    await NodeFSP.rename(backup, target)
  }
  return true
}

async function readMetadata(path: string): Promise<ProjectAtlasMetadata | null>
{
  try
  {
    const metadata = decodeMetadata(decodeJson(await NodeFSP.readFile(path, 'utf8')))
    if (
      metadata.analyzerFingerprint.length === 0 ||
      metadata.workspaceRoot.length === 0 ||
      !GENERATION_PATTERN.test(metadata.generation)
    )
    {
      return null
    }
    return metadata
  }
  catch
  {
    return null
  }
}

async function readMarker(path: string): Promise<ProjectAtlasPublishMarker | null>
{
  try
  {
    const marker = decodeMarker(decodeJson(await NodeFSP.readFile(path, 'utf8')))
    if (
      marker.targetName !== marker.projectId ||
      !marker.stagingName.startsWith(`.${marker.projectId}.staging-`) ||
      !marker.backupName.startsWith(`.${marker.projectId}.backup-`)
    )
    {
      return null
    }
    for (const segment of [marker.targetName, marker.stagingName, marker.backupName])
    {
      pathSegment(segment.replace(/^\./u, '').split('.staging-')[0]!.split('.backup-')[0]!)
      if (NodePath.basename(segment) !== segment)
      {
        return null
      }
    }
    return marker
  }
  catch
  {
    return null
  }
}

async function isCompletePublishedAtlas(target: string, projectId: ProjectId): Promise<boolean>
{
  const metadata = await readMetadata(NodePath.join(target, PROJECT_ATLAS_METADATA_FILENAME))
  if (metadata === null || metadata.projectId !== projectId) return false
  try
  {
    const artifacts = await verifyProjectAtlasArtifacts(target)
    return (
      artifacts.generation === metadata.generation &&
      artifacts.graphDigest === metadata.graphDigest &&
      artifacts.indexSchemaVersion === metadata.indexSchemaVersion &&
      artifacts.indexSha256 === metadata.indexSha256 &&
      artifacts.indexByteLength === metadata.indexByteLength
    )
  }
  catch
  {
    return false
  }
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void>
{
  const temporaryPath = `${path}.tmp-${NodeCrypto.randomBytes(8).toString('hex')}`
  await NodeFSP.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    flag: 'wx',
  })
  await NodeFSP.rename(temporaryPath, path)
}

export async function verifyProjectAtlasArtifacts(outDir: string): Promise<{
  readonly generation: string
  readonly generatedAt: string
  readonly graphDigest: SourceGraphDigest
  readonly indexSchemaVersion: typeof ATLAS_INDEX_SCHEMA_VERSION
  readonly indexSha256: string
  readonly indexByteLength: number
}>
{
  const graphPath = NodePath.join(outDir, 'graph.json')
  const indexPath = NodePath.join(outDir, 'atlas-index.json')
  if (!(await regularFile(graphPath)) || !(await regularFile(indexPath)))
  {
    throw new Error('Repository Map artifacts are incomplete')
  }
  const [graphBytes, indexBytes] = await Promise.all([
    NodeFSP.readFile(graphPath),
    NodeFSP.readFile(indexPath),
  ])
  const graph = decodeJson(graphBytes.toString('utf8'))
  const index = decodeJson(indexBytes.toString('utf8'))
  const parsedIndex = parseAtlasIndex(index)
  if (
    typeof graph !== 'object' ||
    graph === null ||
    !('generatedAt' in graph) ||
    typeof graph.generatedAt !== 'string' ||
    typeof index !== 'object' ||
    index === null ||
    !('sourceGeneratedAt' in index) ||
    index.sourceGeneratedAt !== graph.generatedAt ||
    !('sourceGraphDigest' in index) ||
    index.sourceGraphDigest !== graphContentDigest(graphBytes)
  )
  {
    throw new Error('Repository Map graph and index generations do not match')
  }
  const graphDigest = graphContentDigest(graphBytes)
  return {
    generation: NodeCrypto.createHash('sha256').update(graphBytes).digest('hex'),
    generatedAt: graph.generatedAt,
    graphDigest,
    indexSchemaVersion: parsedIndex.version,
    indexSha256: NodeCrypto.createHash('sha256').update(indexBytes).digest('hex'),
    indexByteLength: indexBytes.byteLength,
  }
}

export async function loadReusableProjectAtlas(input: {
  readonly projectId: ProjectId
  readonly root: string
  readonly outDir: string
  readonly analyzerFingerprint: string
}): Promise<ProjectAtlasMetadata | null>
{
  const metadata = await readMetadata(NodePath.join(input.outDir, PROJECT_ATLAS_METADATA_FILENAME))
  if (
    metadata === null ||
    metadata.projectId !== input.projectId ||
    metadata.workspaceRoot !== input.root ||
    metadata.analyzerFingerprint !== input.analyzerFingerprint ||
    metadata.indexSchemaVersion !== ATLAS_INDEX_SCHEMA_VERSION
  )
  {
    return null
  }
  try
  {
    const artifacts = await verifyProjectAtlasArtifacts(input.outDir)
    return artifacts.generation === metadata.generation &&
      artifacts.graphDigest === metadata.graphDigest &&
      artifacts.indexSchemaVersion === metadata.indexSchemaVersion &&
      artifacts.indexSha256 === metadata.indexSha256 &&
      artifacts.indexByteLength === metadata.indexByteLength
      ? metadata
      : null
  }
  catch
  {
    return null
  }
}

async function loadLastGoodProjectAtlas(
  stateDir: string,
  projectId: ProjectId,
): Promise<RetainedProjectAtlasTarget | null>
{
  try
  {
    const outDir = projectAtlasDirectory(stateDir, projectId)
    if (!(await directoryExists(outDir))) return null
    const metadata = await readMetadata(NodePath.join(outDir, PROJECT_ATLAS_METADATA_FILENAME))
    if (
      metadata === null ||
      metadata.projectId !== projectId ||
      !NodePath.isAbsolute(metadata.workspaceRoot) ||
      metadata.builtAt.length === 0
    )
    {
      return null
    }
    const [root, artifacts] = await Promise.all([
      NodeFSP.realpath(metadata.workspaceRoot),
      verifyProjectAtlasArtifacts(outDir),
    ])
    if (
      root !== metadata.workspaceRoot ||
      artifacts.generation !== metadata.generation ||
      artifacts.graphDigest !== metadata.graphDigest ||
      artifacts.indexSchemaVersion !== metadata.indexSchemaVersion ||
      artifacts.indexSha256 !== metadata.indexSha256 ||
      artifacts.indexByteLength !== metadata.indexByteLength
    )
    {
      return null
    }
    return {
      projectId,
      root,
      outDir,
      graphPath: NodePath.join(outDir, 'graph.json'),
      generation: metadata.generation,
      builtAt: metadata.builtAt,
    }
  }
  catch
  {
    return null
  }
}

async function loadPublishedProjectAtlasIndex(
  stateDir: string,
  projectId: ProjectId,
  requestedGeneration?: string,
): Promise<RetainedProjectAtlasIndexTarget | null>
{
  try
  {
    const outDir = projectAtlasDirectory(stateDir, projectId)
    if (!(await directoryExists(outDir))) return null
    const metadata = await readMetadata(NodePath.join(outDir, PROJECT_ATLAS_METADATA_FILENAME))
    if (
      metadata === null ||
      metadata.projectId !== projectId ||
      (requestedGeneration !== undefined && metadata.generation !== requestedGeneration) ||
      !NodePath.isAbsolute(metadata.workspaceRoot) ||
      !/^sha256:[0-9a-f]{64}$/u.test(metadata.graphDigest) ||
      !/^[0-9a-f]{64}$/u.test(metadata.indexSha256) ||
      !Number.isSafeInteger(metadata.indexByteLength) ||
      metadata.indexByteLength < 1 ||
      metadata.indexByteLength > PROJECT_ATLAS_INDEX_MAX_BYTES
    )
    {
      return null
    }
    const root = await NodeFSP.realpath(metadata.workspaceRoot)
    if (root !== metadata.workspaceRoot) return null
    const indexPath = NodePath.join(outDir, 'atlas-index.json')
    if (!(await regularFile(indexPath))) return null
    const indexStat = await NodeFSP.lstat(indexPath)
    if (
      !indexStat.isFile() ||
      indexStat.isSymbolicLink() ||
      indexStat.size !== metadata.indexByteLength
    )
    {
      return null
    }
    const indexBytes = await NodeFSP.readFile(indexPath)
    if (
      indexBytes.byteLength !== metadata.indexByteLength ||
      NodeCrypto.createHash('sha256').update(indexBytes).digest('hex') !== metadata.indexSha256
    )
    {
      return null
    }
    const index = parseAtlasIndex(decodeJson(indexBytes.toString('utf8')))
    if (
      index.sourceGraphDigest !== metadata.graphDigest ||
      index.version !== metadata.indexSchemaVersion
    )
      return null
    return {
      projectId,
      root,
      outDir,
      graphPath: NodePath.join(outDir, 'graph.json'),
      generation: metadata.generation,
      graphDigest: metadata.graphDigest as SourceGraphDigest,
      builtAt: metadata.builtAt,
      index,
    }
  }
  catch
  {
    return null
  }
}

export async function recoverInterruptedProjectAtlasPublications(
  projectsRoot: string,
): Promise<number>
{
  await NodeFSP.mkdir(projectsRoot, { recursive: true })
  const entries = await NodeFSP.readdir(projectsRoot, { withFileTypes: true })
  let recovered = 0
  for (const entry of entries)
  {
    if (!entry.isDirectory()) continue
    const directory = NodePath.join(projectsRoot, entry.name)
    const markerPath = NodePath.join(directory, PROJECT_ATLAS_PUBLISH_MARKER_FILENAME)
    if (!(await regularFile(markerPath)))
    {
      if (await recoverIncompleteStaging(projectsRoot, entry.name))
      {
        recovered += 1
      }
      continue
    }
    const marker = await readMarker(markerPath)
    if (marker === null)
    {
      if (await recoverIncompleteStaging(projectsRoot, entry.name))
      {
        recovered += 1
      }
      continue
    }

    const target = NodePath.join(projectsRoot, marker.targetName)
    const staging = NodePath.join(projectsRoot, marker.stagingName)
    const backup = NodePath.join(projectsRoot, marker.backupName)
    if (entry.name === marker.targetName)
    {
      if (await isCompletePublishedAtlas(target, marker.projectId))
      {
        await NodeFSP.rm(markerPath, { force: true })
        await removeDirectory(backup)
      }
      else if (await directoryExists(backup))
      {
        await removeDirectory(target)
        await NodeFSP.rename(backup, target)
      }
      else
      {
        await removeDirectory(target)
      }
      recovered += 1
      continue
    }

    if (entry.name === marker.stagingName)
    {
      if (await directoryExists(target))
      {
        await removeDirectory(staging)
        await removeDirectory(backup)
      }
      else if (await directoryExists(backup))
      {
        await NodeFSP.rename(backup, target)
        await removeDirectory(staging)
      }
      else
      {
        await removeDirectory(staging)
      }
      recovered += 1
    }
  }
  const remaining = await NodeFSP.readdir(projectsRoot, { withFileTypes: true })
  for (const entry of remaining)
  {
    if (entry.isDirectory() && (await recoverOrphanedBackup(projectsRoot, entry.name)))
    {
      recovered += 1
    }
  }
  return recovered
}

export const make = Effect.fn('AtlasRebuildService.make')(function* (
  options: AtlasRebuildServiceOptions,
)
{
  const now = options.now ?? Date.now
  const projectsRoot = NodePath.join(options.stateDir, 'cartographer', 'projects')
  const serviceScope = yield* Scope.Scope
  const activeBuilds = new Map<ProjectId, ActiveBuild>()
  const locks = new Map<ProjectId, Semaphore.Semaphore>()
  const publicationLocks = new Map<ProjectId, Semaphore.Semaphore>()
  const disposeAtlasArtifacts: AtlasArtifactsDisposer =
    options.disposeAtlasArtifacts ??
    (async (root, outDir) =>
    {
      const core = await import('@t3tools/cartographer-core/server')
      await core.disposeAtlasArtifacts(root, outDir)
    })

  yield* Effect.tryPromise({
    try: () => recoverInterruptedProjectAtlasPublications(projectsRoot),
    catch: () => publicError('Interrupted Repository Map publication recovery failed.'),
  })

  const lockForProject = Effect.fn('AtlasRebuildService.lockForProject')(function* (
    projectId: ProjectId,
  )
  {
    const existing = locks.get(projectId)
    if (existing) return existing
    const created = yield* Semaphore.make(1)
    const raced = locks.get(projectId)
    if (raced) return raced
    locks.set(projectId, created)
    return created
  })

  const publicationLockForProject = Effect.fn('AtlasRebuildService.publicationLockForProject')(
    function* (projectId: ProjectId)
    {
      const existing = publicationLocks.get(projectId)
      if (existing) return existing
      const created = yield* Semaphore.make(1)
      const raced = publicationLocks.get(projectId)
      if (raced) return raced
      publicationLocks.set(projectId, created)
      return created
    },
  )

  const buildOnce = Effect.fn('AtlasRebuildService.buildOnce')(function* (
    projectId: ProjectId,
    root: string,
    signal: AbortSignal,
    withPublicationPermit: ProjectAtlasBuildRequest['withPublicationPermit'],
  )
  {
    const target = projectAtlasDirectory(options.stateDir, projectId)
    const suffix = NodeCrypto.randomBytes(8).toString('hex')
    const stagingName = `.${projectId}.staging-${suffix}`
    const backupName = `.${projectId}.backup-${suffix}`
    const staging = NodePath.join(projectsRoot, stagingName)
    const backup = NodePath.join(projectsRoot, backupName)
    const marker: ProjectAtlasPublishMarker = {
      version: 1,
      projectId,
      targetName: projectId,
      stagingName,
      backupName,
    }
    let movedOld = false
    let movedNew = false
    let publicationCommitted = false

    return yield* Effect.tryPromise({
      try: async () =>
      {
        await NodeFSP.mkdir(projectsRoot, { recursive: true })
        await NodeFSP.mkdir(staging, { recursive: false })
        await writeJsonAtomically(
          NodePath.join(staging, PROJECT_ATLAS_PUBLISH_MARKER_FILENAME),
          marker,
        )
      },
      catch: () => publicError('Repository Map staging storage could not be created.'),
    }).pipe(
      Effect.andThen(
        Effect.gen(function* ()
        {
          const result = yield* options.analyzer.buildProjectAtlas({
            root,
            outDir: staging,
            signal,
          })
          if (result.fingerprint.length === 0)
          {
            return yield* publicError('Repository Map analyzer identity was unavailable.')
          }
          yield* Effect.tryPromise({
            try: () => NodeFSP.rm(NodePath.join(staging, 'graph.db'), { force: true }),
            catch: () => publicError('Repository Map snapshot history could not be removed.'),
          })
          const artifacts = yield* Effect.tryPromise({
            try: () => verifyProjectAtlasArtifacts(staging),
            catch: () => publicError('Repository Map staging artifacts failed verification.'),
          })
          const metadata: ProjectAtlasMetadata = {
            version: 2,
            projectId,
            workspaceRoot: root,
            analyzerFingerprint: result.fingerprint,
            generation: artifacts.generation,
            graphDigest: artifacts.graphDigest,
            indexSchemaVersion: ATLAS_INDEX_SCHEMA_VERSION,
            indexSha256: artifacts.indexSha256,
            indexByteLength: artifacts.indexByteLength,
            builtAt: new Date(now()).toISOString(),
          }

          yield* Effect.tryPromise({
            try: async () =>
            {
              await writeJsonAtomically(
                NodePath.join(staging, PROJECT_ATLAS_METADATA_FILENAME),
                metadata,
              )
              await options.publicationHook?.('staging-complete', { target, staging, backup })
            },
            catch: () => publicError('Repository Map staging metadata could not be written.'),
          })

          const publicationLock = yield* publicationLockForProject(projectId)
          yield* Effect.uninterruptible(
            withPublicationPermit(
              publicationLock.withPermit(
                Effect.tryPromise({
                  try: async () =>
                  {
                    try
                    {
                      // crash windows: while staging, the old target stays complete; after backing up
                      // the old target, recovery restores it; after publishing staging, the new target
                      // is already metadata-complete and its marker removes the backup; after marker
                      // removal, orphan-backup recovery deletes the backup; after backup removal, the
                      // self-complete new target is the only remaining directory.
                      if (await directoryExists(target))
                      {
                        const previous = await readMetadata(
                          NodePath.join(target, PROJECT_ATLAS_METADATA_FILENAME),
                        )
                        await disposeAtlasArtifacts(previous?.workspaceRoot ?? root, target)
                        await NodeFSP.rename(target, backup)
                        movedOld = true
                        await options.publicationHook?.('target-backed-up', {
                          target,
                          staging,
                          backup,
                        })
                      }
                      await NodeFSP.rename(staging, target)
                      movedNew = true
                      await options.publicationHook?.('target-published', {
                        target,
                        staging,
                        backup,
                      })
                      await NodeFSP.rm(
                        NodePath.join(target, PROJECT_ATLAS_PUBLISH_MARKER_FILENAME),
                        {
                          force: true,
                        },
                      )
                      publicationCommitted = true
                      await options.publicationHook?.('marker-removed', { target, staging, backup })
                      await removeDirectory(backup)
                      await options.publicationHook?.('backup-removed', { target, staging, backup })
                    }
                    catch (cause)
                    {
                      if (publicationCommitted) throw cause
                      if (movedNew) await removeDirectory(target)
                      if (movedOld && (await directoryExists(backup)))
                      {
                        await NodeFSP.rename(backup, target)
                      }
                      throw cause
                    }
                  },
                  catch: () =>
                    publicError('Repository Map publication failed; the last good build was kept.'),
                }),
              ),
            ),
          )
          return metadata
        }),
      ),
      Effect.ensuring(
        Effect.tryPromise({
          try: async () =>
          {
            if (!movedNew) await removeDirectory(staging)
          },
          catch: () => publicError('Repository Map staging cleanup failed.'),
        }).pipe(Effect.ignore),
      ),
    )
  })

  const runBuildLoop = Effect.fn('AtlasRebuildService.runBuildLoop')(function* (
    projectId: ProjectId,
    active: ActiveBuild,
  )
  {
    return yield* Effect.gen(function* ()
    {
      let completed: ProjectAtlasMetadata | null = null
      let failure: CartographerError | null = null
      do
      {
        active.dirty = false
        const root = active.requestedRoot
        const withPublicationPermit = active.withPublicationPermit
        const exit = yield* Effect.exit(
          buildOnce(projectId, root, active.controller.signal, withPublicationPermit).pipe(
            withMetrics({ timer: architectureAtlasPublicationDuration }),
          ),
        )
        if (exit._tag === 'Success')
        {
          completed = exit.value
          failure = null
        }
        else
        {
          failure = publicError(
            'Repository Map rebuild failed; the last good build remains available.',
          )
        }
      } while (active.dirty && !active.controller.signal.aborted)

      if (failure !== null || completed === null)
      {
        activeBuilds.delete(projectId)
        yield* Deferred.fail(
          active.completion,
          failure ?? publicError('Repository Map rebuild stopped.'),
        )
      }
      else
      {
        activeBuilds.delete(projectId)
        yield* Deferred.succeed(active.completion, completed)
      }
    }).pipe(Effect.ensuring(Effect.sync(() => activeBuilds.delete(projectId))))
  })

  const request: AtlasRebuildServiceShape['request'] = Effect.fn('AtlasRebuildService.request')(
    function* (input)
    {
      const root = yield* Effect.tryPromise({
        try: () => NodeFSP.realpath(input.root),
        catch: () => publicError('The Repository Map workspace root is unavailable.'),
      })
      const lock = yield* lockForProject(input.projectId)
      const completion = yield* lock.withPermit(
        Effect.gen(function* ()
        {
          const existing = activeBuilds.get(input.projectId)
          if (existing)
          {
            if (input.requestRevision >= existing.requestRevision)
            {
              existing.requestedRoot = root
              existing.requestRevision = input.requestRevision
              existing.withPublicationPermit = input.withPublicationPermit
              existing.dirty = true
            }
            return existing.completion
          }
          const created: ActiveBuild = {
            requestedRoot: root,
            requestRevision: input.requestRevision,
            withPublicationPermit: input.withPublicationPermit,
            dirty: false,
            controller: new AbortController(),
            completion: yield* Deferred.make<ProjectAtlasMetadata, CartographerError>(),
            fiber: null,
          }
          activeBuilds.set(input.projectId, created)
          created.fiber = yield* Effect.forkIn(runBuildLoop(input.projectId, created), serviceScope)
          return created.completion
        }),
      )
      return yield* Deferred.await(completion)
    },
  )

  const withStablePublication: AtlasRebuildServiceShape['withStablePublication'] = (
    projectId,
    effect,
  ) => Effect.flatMap(publicationLockForProject(projectId), (lock) => lock.withPermit(effect))

  const retainLastGood: AtlasRebuildServiceShape['retainLastGood'] = (projectId) =>
    Effect.acquireRelease(
      Effect.gen(function* ()
      {
        const lock = yield* publicationLockForProject(projectId)
        yield* lock.take(1)
        return lock
      }),
      (lock) => lock.release(1).pipe(Effect.asVoid),
    ).pipe(
      Effect.flatMap(() =>
        Effect.promise(() => loadLastGoodProjectAtlas(options.stateDir, projectId)),
      ),
    )

  const retainPublishedIndex: AtlasRebuildServiceShape['retainPublishedIndex'] = (
    projectId,
    generation,
  ) =>
    Effect.acquireRelease(
      Effect.gen(function* ()
      {
        const lock = yield* publicationLockForProject(projectId)
        yield* lock.take(1)
        return lock
      }),
      (lock) => lock.release(1).pipe(Effect.asVoid),
    ).pipe(
      Effect.flatMap(() =>
        Effect.promise(() =>
          loadPublishedProjectAtlasIndex(options.stateDir, projectId, generation),
        ),
      ),
    )

  const invalidate: AtlasRebuildServiceShape['invalidate'] = (projectId, throughRevision) =>
    Effect.gen(function* ()
    {
      const lock = yield* lockForProject(projectId)
      yield* lock.withPermit(
        Effect.gen(function* ()
        {
          const active = activeBuilds.get(projectId)
          if (active === undefined) return
          if (throughRevision !== undefined && active.requestRevision > throughRevision) return
          active.controller.abort()
          if (active.fiber !== null) yield* Fiber.interrupt(active.fiber).pipe(Effect.ignore)
          yield* Deferred.fail(
            active.completion,
            publicError('Repository Map rebuild was invalidated by a project lifecycle change.'),
          ).pipe(Effect.ignore)
          activeBuilds.delete(projectId)
        }),
      )
    })

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* ()
    {
      for (const active of activeBuilds.values()) active.controller.abort()
      yield* Effect.forEach(
        [...activeBuilds.values()],
        (active) =>
          Effect.suspend(() =>
            active.fiber === null ? Effect.void : Fiber.interrupt(active.fiber).pipe(Effect.ignore),
          ),
        { discard: true },
      )
    }),
  )

  return AtlasRebuildService.of({
    request,
    withStablePublication,
    retainLastGood,
    retainPublishedIndex,
    invalidate,
  })
})

export const layer = Layer.effect(
  AtlasRebuildService,
  Effect.gen(function* ()
  {
    const config = yield* ServerConfig.ServerConfig
    const analyzer = yield* CartographerAnalyzer.CartographerAnalyzer
    return yield* make({ stateDir: config.stateDir, analyzer })
  }),
)
