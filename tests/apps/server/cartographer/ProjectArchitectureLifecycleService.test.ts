// tests/apps/server/cartographer/ProjectArchitectureLifecycleService.test.ts
// verifies standing-project binding fences, rebuild status, retention, and artifact cleanup

// @effect-diagnostics nodeBuiltinImport:off

import * as NodeBuffer from 'node:buffer'
import * as NodeCrypto from 'node:crypto'
import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'

import { expect, it } from '@effect/vitest'
import { ATLAS_INDEX_SCHEMA_VERSION, graphContentDigest } from '@t3tools/cartographer-core/server'
import { ProjectId } from '@t3tools/contracts'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Option from 'effect/Option'
import * as Semaphore from 'effect/Semaphore'
import * as Stream from 'effect/Stream'
import { describe } from 'vite-plus/test'

import {
  PROJECT_ATLAS_METADATA_FILENAME,
  projectAtlasDirectory,
  type ProjectAtlasMetadata,
} from '../../../../apps/server/src/cartographer/AtlasRebuildService.ts'
import { make } from '../../../../apps/server/src/cartographer/ProjectArchitectureLifecycleService.ts'
import * as ProjectAtlasStatusBroadcaster from '../../../../apps/server/src/cartographer/ProjectAtlasStatusBroadcaster.ts'

const projectId = ProjectId.make('project-architecture-lifecycle')

async function makeTemporaryRoot(prefix: string): Promise<string>
{
  return NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix))
}

async function writeProjectBuild(input: {
  readonly stateDir: string
  readonly projectId: ProjectId
  readonly root: string
  readonly revision: number
  readonly analyzerFingerprint?: string
}): Promise<ProjectAtlasMetadata>
{
  const outDir = projectAtlasDirectory(input.stateDir, input.projectId)
  const builtAt = `2026-08-09T12:00:0${input.revision}.000Z`
  const graphBytes = NodeBuffer.Buffer.from(
    `${JSON.stringify({ generatedAt: builtAt, revision: input.revision })}\n`,
  )
  const graphDigest = graphContentDigest(graphBytes)
  const indexBytes = NodeBuffer.Buffer.from(
    `${JSON.stringify({
      version: ATLAS_INDEX_SCHEMA_VERSION,
      sourceGeneratedAt: builtAt,
      sourceGraphDigest: graphDigest,
      repo: { root: outDir, name: 'fixture', scope: '.', mode: 'imports' },
      counts: {
        files: 0,
        imports: 0,
        systems: 0,
        blocks: 0,
        dirs: 0,
        indexedSystems: 0,
        indexedBlocks: 0,
        indexedDirs: 0,
      },
      systemSource: 'inferred',
      units: { systems: [], blocks: [], dirs: [] },
      edges: { systems: [], blocks: [], dirs: [] },
      edgeCounts: {
        systems: { total: 0, indexed: 0, omitted: 0 },
        blocks: { total: 0, indexed: 0, omitted: 0 },
        dirs: { total: 0, indexed: 0, omitted: 0 },
      },
      scopes: [],
      health: {
        cycles: 0,
        orphans: 0,
        violatingImports: 0,
        violatedRules: 0,
        ruleTotal: 0,
      },
      files: [],
    })}\n`,
  )
  const metadata: ProjectAtlasMetadata = {
    version: 2,
    projectId: input.projectId,
    workspaceRoot: input.root,
    analyzerFingerprint: input.analyzerFingerprint ?? 'analyzer-v1',
    generation: NodeCrypto.createHash('sha256').update(graphBytes).digest('hex'),
    graphDigest,
    indexSchemaVersion: ATLAS_INDEX_SCHEMA_VERSION,
    indexSha256: NodeCrypto.createHash('sha256').update(indexBytes).digest('hex'),
    indexByteLength: indexBytes.byteLength,
    builtAt,
  }
  await NodeFSP.mkdir(outDir, { recursive: true })
  await Promise.all([
    NodeFSP.writeFile(NodePath.join(outDir, 'graph.json'), graphBytes),
    NodeFSP.writeFile(NodePath.join(outDir, 'atlas-index.json'), indexBytes),
    NodeFSP.writeFile(
      NodePath.join(outDir, PROJECT_ATLAS_METADATA_FILENAME),
      `${JSON.stringify(metadata)}\n`,
    ),
  ])
  return metadata
}

describe('ProjectArchitectureLifecycleService', () =>
{
  it.effect('owns rebuild epochs, root transitions, retained status, and deletion cleanup', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const stateDir = yield* Effect.promise(() =>
          makeTemporaryRoot('456code-project-architecture-state-'),
        )
        const rootOne = yield* Effect.promise(() =>
          makeTemporaryRoot('456code-project-architecture-root-one-'),
        )
        const rootTwo = yield* Effect.promise(() =>
          makeTemporaryRoot('456code-project-architecture-root-two-'),
        )
        const canonicalRootOne = yield* Effect.promise(() => NodeFSP.realpath(rootOne))
        const canonicalRootTwo = yield* Effect.promise(() => NodeFSP.realpath(rootTwo))
        yield* Effect.addFinalizer(() =>
          Effect.promise(() =>
            Promise.all(
              [stateDir, rootOne, rootTwo].map((path) =>
                NodeFSP.rm(path, { recursive: true, force: true }),
              ),
            ),
          ).pipe(Effect.asVoid),
        )

        const requests: Array<{ readonly root: string; readonly revision: number }> = []
        const invalidations: Array<number | undefined> = []
        const disposals: Array<{ readonly root: string; readonly outDir: string }> = []
        const statuses = yield* ProjectAtlasStatusBroadcaster.make
        const service = yield* make({
          stateDir,
          analyzer: {
            identify: Effect.succeed({ cliPath: '/cartographer', fingerprint: 'analyzer-v1' }),
          },
          projectStatusBroadcaster: statuses,
          disposeArchitectureArtifacts: (root, outDir) =>
          {
            disposals.push({ root, outDir })
            return Promise.resolve()
          },
          projectRebuilder: {
            withStablePublication: (_projectId, effect) => effect,
            invalidate: (_projectId, throughRevision) =>
              Effect.sync(() =>
              {
                invalidations.push(throughRevision)
              }),
            request: (input) =>
              Effect.gen(function* ()
              {
                requests.push({ root: input.root, revision: input.requestRevision })
                return yield* Effect.promise(() =>
                  writeProjectBuild({
                    stateDir,
                    projectId: input.projectId,
                    root: input.root,
                    revision: input.requestRevision,
                  }),
                )
              }),
          },
        })
        yield* Effect.addFinalizer(() => service.closeAll)

        const initial = yield* service.ensureProject({ projectId, workspaceRoot: rootOne })
        expect(initial).toMatchObject({
          root: canonicalRootOne,
          generation: expect.stringMatching(/^[a-f0-9]{64}$/u),
          graphDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        })
        expect(yield* statuses.getStatus(projectId)).toMatchObject({
          state: 'ready',
          source: {
            kind: 'standing-project-generation',
            projectId,
            generationId: initial.generation,
            side: 'analyzed',
            graphDigest: initial.graphDigest,
          },
          freshness: { dirty: false },
        })

        const retentionFiber = yield* Stream.runHead(service.projectRetentionChanges).pipe(
          Effect.forkChild,
        )
        yield* Effect.yieldNow
        yield* service.retainProjectStatus(projectId)
        const retained = yield* Fiber.join(retentionFiber)
        expect(Option.getOrNull(retained)).toEqual({
          projectId,
          retained: true,
          root: canonicalRootOne,
        })
        expect(yield* service.hasRetainedProjectContext(projectId)).toBe(true)
        yield* service.releaseProjectStatus(projectId)
        expect(yield* service.hasRetainedProjectContext(projectId)).toBe(false)

        const rebuilt = yield* service.rebuildProject({ projectId, workspaceRoot: rootOne })
        expect(rebuilt.generation).not.toBe(initial.generation)
        const wrongRoot = yield* service
          .rebuildProject({ projectId, workspaceRoot: rootTwo })
          .pipe(Effect.flip)
        expect(wrongRoot.failure).toBe('workspace_context_not_found')

        yield* service.invalidateProjectMetadata(projectId, rootTwo)
        expect(yield* service.getProjectSnapshot(projectId)).toBeNull()
        expect(yield* statuses.getStatus(projectId)).toMatchObject({
          state: 'idle',
          source: null,
          freshness: { dirty: true },
        })
        const rebound = yield* service.ensureProject({ projectId, workspaceRoot: rootTwo })
        expect(rebound).toMatchObject({
          root: canonicalRootTwo,
          generation: expect.stringMatching(/^[a-f0-9]{64}$/u),
          graphDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        })
        expect(requests).toEqual([
          { root: canonicalRootOne, revision: 1 },
          { root: canonicalRootOne, revision: 2 },
          { root: canonicalRootTwo, revision: 4 },
        ])
        expect(invalidations).toEqual([3])
        expect(disposals).toEqual([
          {
            root: canonicalRootOne,
            outDir: projectAtlasDirectory(stateDir, projectId),
          },
        ])

        const outDir = projectAtlasDirectory(stateDir, projectId)
        yield* Effect.promise(() => NodeFSP.mkdir(outDir, { recursive: true }))
        yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(outDir, 'sentinel'), 'owned\n'))
        yield* service.closeProject(projectId)
        expect(yield* service.isProjectDeleted(projectId)).toBe(true)
        expect(invalidations).toEqual([3, 5])
        expect(disposals).toHaveLength(2)
        yield* service.deleteProjectArtifacts(projectId)
        expect(yield* Effect.promise(() => NodeFSP.stat(outDir).catch(() => null))).toBeNull()
        expect(yield* statuses.getStatus(projectId)).toMatchObject({
          state: 'idle',
          source: null,
        })
      }),
    ),
  )

  it.effect('fences publication and disposes retained artifacts during shutdown', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const stateDir = yield* Effect.promise(() =>
          makeTemporaryRoot('456code-project-architecture-shutdown-state-'),
        )
        const workspaceRoot = yield* Effect.promise(() =>
          makeTemporaryRoot('456code-project-architecture-shutdown-root-'),
        )
        const canonicalRoot = yield* Effect.promise(() => NodeFSP.realpath(workspaceRoot))
        yield* Effect.addFinalizer(() =>
          Effect.promise(() =>
            Promise.all(
              [stateDir, workspaceRoot].map((path) =>
                NodeFSP.rm(path, { recursive: true, force: true }),
              ),
            ),
          ).pipe(Effect.asVoid),
        )
        yield* Effect.promise(() =>
          writeProjectBuild({
            stateDir,
            projectId,
            root: canonicalRoot,
            revision: 1,
          }),
        )

        const invalidations: Array<number | undefined> = []
        const disposals: Array<{ readonly root: string; readonly outDir: string }> = []
        const service = yield* make({
          stateDir,
          analyzer: {
            identify: Effect.succeed({ cliPath: '/cartographer', fingerprint: 'analyzer-v1' }),
          },
          disposeArchitectureArtifacts: (root, outDir) =>
          {
            disposals.push({ root, outDir })
            return Promise.resolve()
          },
          projectRebuilder: {
            request: () => Effect.die(new Error('rebuild was not expected')),
            withStablePublication: (_projectId, effect) => effect,
            invalidate: (_projectId, throughRevision) =>
              Effect.sync(() =>
              {
                invalidations.push(throughRevision)
              }),
          },
        })

        const snapshot = yield* service.ensureProject({ projectId, workspaceRoot })
        yield* service.closeAll
        yield* service.closeAll

        expect(snapshot.graphDigest).toMatch(/^sha256:[a-f0-9]{64}$/u)
        expect(invalidations).toEqual([1])
        expect(disposals).toEqual([
          {
            root: canonicalRoot,
            outDir: projectAtlasDirectory(stateDir, projectId),
          },
        ])
        const closed = yield* service.ensureProject({ projectId, workspaceRoot }).pipe(Effect.flip)
        expect(closed.failure).toBe('context_start_failed')
      }),
    ),
  )

  it.effect('returns the newest sealed authority when an older rebuild completes late', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const stateDir = yield* Effect.promise(() =>
          makeTemporaryRoot('456code-project-architecture-authority-state-'),
        )
        const workspaceRoot = yield* Effect.promise(() =>
          makeTemporaryRoot('456code-project-architecture-authority-root-'),
        )
        yield* Effect.addFinalizer(() =>
          Effect.promise(() =>
            Promise.all(
              [stateDir, workspaceRoot].map((path) =>
                NodeFSP.rm(path, { recursive: true, force: true }),
              ),
            ),
          ).pipe(Effect.asVoid),
        )

        const publicationLock = yield* Semaphore.make(1)
        const olderPublished = yield* Deferred.make<void>()
        const releaseOlderReturn = yield* Deferred.make<void>()
        const publications: ProjectAtlasMetadata[] = []
        const statuses = yield* ProjectAtlasStatusBroadcaster.make
        let buildCount = 0
        const service = yield* make({
          stateDir,
          analyzer: {
            identify: Effect.succeed({ cliPath: '/cartographer', fingerprint: 'analyzer-v1' }),
          },
          projectStatusBroadcaster: statuses,
          disposeArchitectureArtifacts: async () => undefined,
          projectRebuilder: {
            request: Effect.fn('TestProjectRebuilder.authorityRequest')(function* (input)
            {
              buildCount += 1
              const build = buildCount
              const metadata = yield* input.withPublicationPermit(
                publicationLock.withPermit(
                  Effect.promise(() =>
                    writeProjectBuild({
                      stateDir,
                      projectId: input.projectId,
                      root: input.root,
                      revision: build,
                    }),
                  ),
                ),
              )
              publications.push(metadata)
              if (build === 2)
              {
                yield* Deferred.succeed(olderPublished, undefined)
                yield* Deferred.await(releaseOlderReturn)
              }
              return metadata
            }),
            withStablePublication: (_projectId, effect) => publicationLock.withPermit(effect),
            invalidate: () => Effect.void,
          },
        })
        yield* Effect.addFinalizer(() => service.closeAll)

        yield* service.ensureProject({ projectId, workspaceRoot })
        const older = yield* service
          .rebuildProject({ projectId, workspaceRoot })
          .pipe(Effect.forkChild)
        yield* Deferred.await(olderPublished)
        const newest = yield* service.rebuildProject({ projectId, workspaceRoot })
        yield* Deferred.succeed(releaseOlderReturn, undefined)
        const delayed = yield* Fiber.join(older)
        const snapshot = yield* service.getProjectSnapshot(projectId)
        const latestPublication = publications.at(-1)
        if (latestPublication?.version !== 2)
        {
          return yield* Effect.die('latest project publication was not sealed')
        }

        expect(buildCount).toBe(3)
        expect(newest).toMatchObject({
          generation: latestPublication.generation,
          graphDigest: latestPublication.graphDigest,
        })
        expect(delayed).toMatchObject({
          generation: latestPublication.generation,
          graphDigest: latestPublication.graphDigest,
        })
        expect(snapshot).toMatchObject({
          generation: latestPublication.generation,
          graphDigest: latestPublication.graphDigest,
        })
        expect(yield* statuses.getStatus(projectId)).toMatchObject({
          state: 'ready',
          source: {
            kind: 'standing-project-generation',
            projectId,
            generationId: latestPublication.generation,
            side: 'analyzed',
            graphDigest: latestPublication.graphDigest,
          },
          freshness: { builtAt: latestPublication.builtAt, dirty: false },
          lastBuildError: null,
        })
      }),
    ),
  )

  it.effect('uses the published analyzer identity and settles failed verification', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const stateDir = yield* Effect.promise(() =>
          makeTemporaryRoot('456code-project-architecture-fingerprint-state-'),
        )
        const workspaceRoot = yield* Effect.promise(() =>
          makeTemporaryRoot('456code-project-architecture-fingerprint-root-'),
        )
        yield* Effect.addFinalizer(() =>
          Effect.promise(() =>
            Promise.all(
              [stateDir, workspaceRoot].map((path) =>
                NodeFSP.rm(path, { recursive: true, force: true }),
              ),
            ),
          ).pipe(Effect.asVoid),
        )

        const statuses = yield* ProjectAtlasStatusBroadcaster.make
        let buildCount = 0
        const service = yield* make({
          stateDir,
          analyzer: {
            identify: Effect.succeed({ cliPath: '/cartographer', fingerprint: 'analyzer-v1' }),
          },
          projectStatusBroadcaster: statuses,
          disposeArchitectureArtifacts: async () => undefined,
          projectRebuilder: {
            request: Effect.fn('TestProjectRebuilder.fingerprintRequest')(function* (input)
            {
              buildCount += 1
              const metadata = yield* Effect.promise(() =>
                writeProjectBuild({
                  stateDir,
                  projectId: input.projectId,
                  root: input.root,
                  revision: buildCount,
                  analyzerFingerprint: `analyzer-v${buildCount + 1}`,
                }),
              )
              if (buildCount === 2)
              {
                yield* Effect.promise(() =>
                  NodeFSP.rm(
                    NodePath.join(
                      projectAtlasDirectory(stateDir, input.projectId),
                      'atlas-index.json',
                    ),
                  ),
                )
              }
              return metadata
            }),
            withStablePublication: (_projectId, effect) => effect,
            invalidate: () => Effect.void,
          },
        })
        yield* Effect.addFinalizer(() => service.closeAll)

        const initial = yield* service.ensureProject({ projectId, workspaceRoot })
        expect(buildCount).toBe(1)
        expect(yield* statuses.getStatus(projectId)).toMatchObject({
          state: 'ready',
          source: { generationId: initial.generation },
          freshness: { dirty: false },
        })

        const failed = yield* service.rebuildProject({ projectId, workspaceRoot }).pipe(Effect.flip)
        expect(failed.failure).toBe('context_start_failed')
        expect(yield* statuses.getStatus(projectId)).toMatchObject({
          state: 'error',
          source: { generationId: initial.generation },
          freshness: { dirty: true },
          lastBuildError:
            'Project architecture was published but failed verification; the last good build remains available.',
        })
      }),
    ),
  )
})
