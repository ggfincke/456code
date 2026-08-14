// tests/apps/server/cartographer/AtlasRebuildService.test.ts
// verifies project atlas single-flight rebuilds, publication, recovery, and last-good retention

// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off

/* oxlint-disable 456code/no-manual-effect-runtime-in-tests -- the publication hook is a Promise-land callback fired mid-publication; launching the coordinated read there requires bridging back into the running Effect world with one runPromise */

import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'

import { it } from '@effect/vitest'
import { graphContentDigest } from '@t3tools/cartographer-core/server'
import { ProjectId } from '@t3tools/contracts'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Scope from 'effect/Scope'
import { afterEach, describe, expect } from 'vite-plus/test'

import {
  make,
  PROJECT_ATLAS_METADATA_FILENAME,
  PROJECT_ATLAS_PUBLISH_MARKER_FILENAME,
  projectAtlasDirectory,
  recoverInterruptedProjectAtlasPublications,
  verifyProjectAtlasArtifacts,
  type AtlasRebuildServiceShape,
  type ProjectAtlasBuildRequest,
} from '../../../../apps/server/src/cartographer/AtlasRebuildService.ts'

const temporaryRoots = new Set<string>()

async function makeTemporaryRoot(prefix: string): Promise<string>
{
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix))
  temporaryRoots.add(root)
  return root
}

async function writeBuild(outDir: string, build: number): Promise<void>
{
  const generatedAt = `2026-08-07T12:00:0${build}.000Z`
  const graphBytes = `${JSON.stringify({ generatedAt, build })}\n`
  const graphDigest = graphContentDigest(graphBytes)
  await Promise.all([
    NodeFSP.writeFile(NodePath.join(outDir, 'graph.json'), graphBytes),
    NodeFSP.writeFile(
      NodePath.join(outDir, 'atlas-index.json'),
      `${JSON.stringify({
        version: 5,
        sourceGeneratedAt: generatedAt,
        sourceGraphDigest: graphDigest,
        repo: {
          root: outDir,
          name: 'fixture',
          scope: '.',
          mode: 'imports',
        },
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
    ),
    NodeFSP.writeFile(NodePath.join(outDir, 'graph.db'), `database-${build}`),
  ])
}

function requestFor(
  projectId: ProjectId,
  root: string,
  requestRevision: number,
): ProjectAtlasBuildRequest
{
  return {
    projectId,
    root,
    requestRevision,
    withPublicationPermit: (effect) => effect,
  }
}

afterEach(async () =>
{
  await Promise.all(
    [...temporaryRoots].map((root) =>
      NodeFSP.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 }),
    ),
  )
  temporaryRoots.clear()
})

describe('AtlasRebuildService', () =>
{
  it.effect('runs one dirty rerun for a request that arrives during a build', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const [stateDir, root, staleRoot] = yield* Effect.promise(() =>
          Promise.all([
            makeTemporaryRoot('456code-project-atlas-state-'),
            makeTemporaryRoot('456code-project-atlas-root-'),
            makeTemporaryRoot('456code-project-atlas-stale-root-'),
          ]),
        )
        const firstStarted = yield* Deferred.make<void>()
        const releaseFirst = yield* Deferred.make<void>()
        let buildCount = 0
        const service = yield* make({
          stateDir,
          analyzer: {
            buildProjectAtlas: Effect.fn('TestProjectAnalyzer.build')(function* (input)
            {
              buildCount += 1
              const build = buildCount
              if (build === 1)
              {
                yield* Deferred.succeed(firstStarted, undefined)
                yield* Deferred.await(releaseFirst)
              }
              yield* Effect.promise(() => writeBuild(input.outDir, build))
              return { fingerprint: 'test-analyzer-v1' }
            }),
          },
          disposeAtlasArtifacts: () => Promise.resolve(),
          now: () => Date.UTC(2026, 7, 7, 12, 0, buildCount),
        })
        const projectId = ProjectId.make('project-single-flight')
        const first = yield* service.request(requestFor(projectId, root, 1)).pipe(Effect.forkChild)
        yield* Deferred.await(firstStarted)
        const second = yield* service.request(requestFor(projectId, root, 3)).pipe(Effect.forkChild)
        const stale = yield* service
          .request(requestFor(projectId, staleRoot, 2))
          .pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* Deferred.succeed(releaseFirst, undefined)
        const [firstResult, secondResult, staleResult] = yield* Effect.all([
          Fiber.join(first),
          Fiber.join(second),
          Fiber.join(stale),
        ])

        expect(buildCount).toBe(2)
        expect(firstResult.generation).toBe(secondResult.generation)
        expect(staleResult.generation).toBe(secondResult.generation)
        expect(secondResult.workspaceRoot).toBe(yield* Effect.promise(() => NodeFSP.realpath(root)))
        const target = projectAtlasDirectory(stateDir, projectId)
        expect(
          JSON.parse(
            yield* Effect.promise(() =>
              NodeFSP.readFile(NodePath.join(target, 'graph.json'), 'utf8'),
            ),
          ),
        ).toMatchObject({ build: 2 })
        expect(
          yield* Effect.promise(() =>
            NodeFSP.stat(NodePath.join(target, 'graph.db')).catch(() => null),
          ),
        ).toBeNull()
      }),
    ),
  )

  it.effect(
    'keeps the last good directory readable when a same-timestamp graph digest is rejected',
    () =>
      Effect.scoped(
        Effect.gen(function* ()
        {
          const [stateDir, root] = yield* Effect.promise(() =>
            Promise.all([
              makeTemporaryRoot('456code-project-atlas-last-good-'),
              makeTemporaryRoot('456code-project-atlas-live-root-'),
            ]),
          )
          const replacementStarted = yield* Deferred.make<void>()
          const releaseReplacement = yield* Deferred.make<void>()
          let buildCount = 0
          let failReplacement = false
          const service = yield* make({
            stateDir,
            analyzer: {
              buildProjectAtlas: Effect.fn('TestProjectAnalyzer.build')(function* (input)
              {
                buildCount += 1
                if (buildCount > 1)
                {
                  yield* Deferred.succeed(replacementStarted, undefined)
                  yield* Deferred.await(releaseReplacement)
                }
                yield* Effect.promise(() => writeBuild(input.outDir, buildCount))
                if (failReplacement)
                {
                  const generatedAt = `2026-08-07T12:00:0${buildCount}.000Z`
                  yield* Effect.promise(() =>
                    NodeFSP.writeFile(
                      NodePath.join(input.outDir, 'graph.json'),
                      `${JSON.stringify({ generatedAt, build: 200 })}\n`,
                    ),
                  )
                }
                return { fingerprint: 'test-analyzer-v1' }
              }),
            },
            disposeAtlasArtifacts: () => Promise.resolve(),
            now: () => Date.UTC(2026, 7, 7, 12, 0, buildCount),
          })
          const projectId = ProjectId.make('project-last-good')
          const first = yield* service.request(requestFor(projectId, root, 1))
          const target = projectAtlasDirectory(stateDir, projectId)
          failReplacement = true
          const replacement = yield* service
            .request(requestFor(projectId, root, 2))
            .pipe(Effect.forkChild)
          yield* Deferred.await(replacementStarted)

          expect(
            JSON.parse(
              yield* Effect.promise(() =>
                NodeFSP.readFile(NodePath.join(target, 'graph.json'), 'utf8'),
              ),
            ),
          ).toMatchObject({ build: 1 })
          yield* Deferred.succeed(releaseReplacement, undefined)
          yield* Fiber.join(replacement).pipe(Effect.flip)

          expect(
            (yield* Effect.promise(() => verifyProjectAtlasArtifacts(target))).generation,
          ).toBe(first.generation)
          expect(
            yield* Effect.promise(() =>
              NodeFSP.readdir(NodePath.dirname(target)).then((entries) =>
                entries.filter((entry) => entry.includes('.staging-')),
              ),
            ),
          ).toEqual([])
        }),
      ),
  )

  it.effect('retains a verified last-good generation across a replacement publication', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const [stateDir, root] = yield* Effect.promise(() =>
          Promise.all([
            makeTemporaryRoot('456code-project-atlas-retained-last-good-state-'),
            makeTemporaryRoot('456code-project-atlas-retained-last-good-root-'),
          ]),
        )
        const realRoot = yield* Effect.promise(() => NodeFSP.realpath(root))
        const replacementAnalyzed = yield* Deferred.make<void>()
        let buildCount = 0
        const service = yield* make({
          stateDir,
          analyzer: {
            buildProjectAtlas: Effect.fn('TestProjectAnalyzer.build')(function* (input)
            {
              buildCount += 1
              yield* Effect.promise(() => writeBuild(input.outDir, buildCount))
              if (buildCount === 2) yield* Deferred.succeed(replacementAnalyzed, undefined)
              return { fingerprint: 'test-analyzer-v1' }
            }),
          },
          disposeAtlasArtifacts: () => Promise.resolve(),
          now: () => Date.UTC(2026, 7, 7, 12, 0, buildCount),
        })
        const projectId = ProjectId.make('project-retained-last-good')
        const first = yield* service.request(requestFor(projectId, root, 1))
        const leaseScope = yield* Scope.make('sequential')
        yield* Effect.addFinalizer(() => Scope.close(leaseScope, Exit.void))
        const target = yield* service
          .retainLastGood(projectId)
          .pipe(Effect.provideService(Scope.Scope, leaseScope))
        expect(target).toEqual({
          projectId,
          root: realRoot,
          outDir: projectAtlasDirectory(stateDir, projectId),
          graphPath: NodePath.join(projectAtlasDirectory(stateDir, projectId), 'graph.json'),
          generation: first.generation,
          builtAt: first.builtAt,
        })

        const replacing = yield* service
          .request(requestFor(projectId, root, 2))
          .pipe(Effect.forkChild)
        yield* Deferred.await(replacementAnalyzed)
        yield* Effect.yieldNow
        expect(replacing.pollUnsafe()).toBeUndefined()
        expect(
          JSON.parse(yield* Effect.promise(() => NodeFSP.readFile(target!.graphPath, 'utf8'))),
        ).toMatchObject({ build: 1 })

        yield* Scope.close(leaseScope, Exit.void)
        const replacement = yield* Fiber.join(replacing)
        expect(replacement.generation).not.toBe(first.generation)
        expect(
          JSON.parse(yield* Effect.promise(() => NodeFSP.readFile(target!.graphPath, 'utf8'))),
        ).toMatchObject({ build: 2 })
      }),
    ),
  )

  it.effect('retains the sealed native index across a replacement publication', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const [stateDir, root] = yield* Effect.promise(() =>
          Promise.all([
            makeTemporaryRoot('456code-project-atlas-retained-index-state-'),
            makeTemporaryRoot('456code-project-atlas-retained-index-root-'),
          ]),
        )
        const replacementAnalyzed = yield* Deferred.make<void>()
        let buildCount = 0
        const service = yield* make({
          stateDir,
          analyzer: {
            buildProjectAtlas: Effect.fn('TestProjectAnalyzer.build')(function* (input)
            {
              buildCount += 1
              yield* Effect.promise(() => writeBuild(input.outDir, buildCount))
              if (buildCount === 2) yield* Deferred.succeed(replacementAnalyzed, undefined)
              return { fingerprint: 'test-analyzer-v1' }
            }),
          },
          disposeAtlasArtifacts: () => Promise.resolve(),
          now: () => Date.UTC(2026, 7, 7, 12, 0, buildCount),
        })
        const projectId = ProjectId.make('project-retained-native-index')
        const first = yield* service.request(requestFor(projectId, root, 1))
        const leaseScope = yield* Scope.make('sequential')
        yield* Effect.addFinalizer(() => Scope.close(leaseScope, Exit.void))
        const target = yield* service
          .retainPublishedIndex(projectId, first.generation)
          .pipe(Effect.provideService(Scope.Scope, leaseScope))
        expect(target).toMatchObject({
          projectId,
          generation: first.generation,
          index: { version: 5 },
        })

        const replacing = yield* service
          .request(requestFor(projectId, root, 2))
          .pipe(Effect.forkChild)
        yield* Deferred.await(replacementAnalyzed)
        yield* Effect.yieldNow
        expect(replacing.pollUnsafe()).toBeUndefined()
        expect(target?.generation).toBe(first.generation)

        yield* Scope.close(leaseScope, Exit.void)
        const replacement = yield* Fiber.join(replacing)
        expect(replacement.generation).not.toBe(first.generation)
      }),
    ),
  )

  it.effect('reads only a sealed v5 index and rejects wrong or tampered identities', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const [stateDir, root] = yield* Effect.promise(() =>
          Promise.all([
            makeTemporaryRoot('456code-project-atlas-native-index-state-'),
            makeTemporaryRoot('456code-project-atlas-native-index-root-'),
          ]),
        )
        const service = yield* make({
          stateDir,
          analyzer: {
            buildProjectAtlas: Effect.fn('TestProjectAnalyzer.build')(function* (input)
            {
              yield* Effect.promise(() => writeBuild(input.outDir, 1))
              return { fingerprint: 'test-analyzer-v1' }
            }),
          },
          disposeAtlasArtifacts: () => Promise.resolve(),
          now: () => Date.UTC(2026, 7, 7, 12, 0, 1),
        })
        const projectId = ProjectId.make('project-native-index-binding')
        const published = yield* service.request(requestFor(projectId, root, 1))
        const outDir = projectAtlasDirectory(stateDir, projectId)
        const metadata = JSON.parse(
          yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(outDir, PROJECT_ATLAS_METADATA_FILENAME), 'utf8'),
          ),
        )
        const indexStat = yield* Effect.promise(() =>
          NodeFSP.stat(NodePath.join(outDir, 'atlas-index.json')),
        )
        expect(metadata).toMatchObject({
          version: 2,
          projectId,
          generation: published.generation,
          indexSchemaVersion: 5,
          indexByteLength: indexStat.size,
        })
        expect(metadata.indexSha256).toMatch(/^[0-9a-f]{64}$/u)

        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(outDir, 'graph.json'), 'not a graph'),
        )
        const retained = yield* Effect.scoped(
          service.retainPublishedIndex(projectId, published.generation),
        )
        expect(retained).toMatchObject({
          generation: published.generation,
          graphDigest: metadata.graphDigest,
          index: { version: 5 },
        })
        expect(
          yield* Effect.scoped(service.retainPublishedIndex(projectId, 'f'.repeat(64))),
        ).toBeNull()

        yield* Effect.promise(() =>
          NodeFSP.appendFile(NodePath.join(outDir, 'atlas-index.json'), '\n'),
        )
        expect(
          yield* Effect.scoped(service.retainPublishedIndex(projectId, published.generation)),
        ).toBeNull()
      }),
    ),
  )

  it.effect('returns null for missing or incomplete last-good state without analyzing', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const [stateDir, root] = yield* Effect.promise(() =>
          Promise.all([
            makeTemporaryRoot('456code-project-atlas-last-good-invalid-state-'),
            makeTemporaryRoot('456code-project-atlas-last-good-invalid-root-'),
          ]),
        )
        const realRoot = yield* Effect.promise(() => NodeFSP.realpath(root))
        let analyzerCalls = 0
        const service = yield* make({
          stateDir,
          analyzer: {
            buildProjectAtlas: () =>
              Effect.sync(() =>
              {
                analyzerCalls += 1
                throw new Error('retainLastGood initiated a build')
              }),
          },
          disposeAtlasArtifacts: () => Promise.resolve(),
        })
        const projectId = ProjectId.make('project-last-good-invalid')
        expect(yield* Effect.scoped(service.retainLastGood(projectId))).toBeNull()

        const outDir = projectAtlasDirectory(stateDir, projectId)
        yield* Effect.promise(async () =>
        {
          await NodeFSP.mkdir(outDir, { recursive: true })
          await writeBuild(outDir, 1)
          const artifacts = await verifyProjectAtlasArtifacts(outDir)
          await NodeFSP.writeFile(
            NodePath.join(outDir, PROJECT_ATLAS_METADATA_FILENAME),
            `${JSON.stringify({
              version: 1,
              projectId,
              workspaceRoot: realRoot,
              analyzerFingerprint: 'test-analyzer-v1',
              generation: artifacts.generation,
              builtAt: '2026-08-07T12:00:01.000Z',
            })}\n`,
          )
        })
        expect(yield* Effect.scoped(service.retainLastGood(projectId))).toMatchObject({
          projectId,
          root: realRoot,
        })

        const metadataPath = NodePath.join(outDir, PROJECT_ATLAS_METADATA_FILENAME)
        const metadata = JSON.parse(
          yield* Effect.promise(() => NodeFSP.readFile(metadataPath, 'utf8')),
        )
        yield* Effect.promise(() =>
          NodeFSP.writeFile(metadataPath, `${JSON.stringify({ ...metadata, builtAt: '' })}\n`),
        )
        expect(yield* Effect.scoped(service.retainLastGood(projectId))).toBeNull()
        yield* Effect.promise(() =>
          NodeFSP.writeFile(metadataPath, `${JSON.stringify(metadata)}\n`),
        )
        yield* Effect.promise(() => NodeFSP.appendFile(NodePath.join(outDir, 'graph.json'), '\n'))
        expect(yield* Effect.scoped(service.retainLastGood(projectId))).toBeNull()
        expect(analyzerCalls).toBe(0)
      }),
    ),
  )

  it.effect('keeps every publication interleaving complete for coordinated readers', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const [stateDir, root] = yield* Effect.promise(() =>
          Promise.all([
            makeTemporaryRoot('456code-project-atlas-interleaving-state-'),
            makeTemporaryRoot('456code-project-atlas-interleaving-root-'),
          ]),
        )
        const projectId = ProjectId.make('project-publication-interleaving')
        const steps: string[] = []
        let buildCount = 0
        const serviceRef: { current: AtlasRebuildServiceShape | null } = { current: null }
        let coordinatedRead: Promise<number> | null = null
        let coordinatedReadSettled = false
        const service = yield* make({
          stateDir,
          analyzer: {
            buildProjectAtlas: (input) =>
              Effect.promise(async () =>
              {
                buildCount += 1
                await writeBuild(input.outDir, buildCount)
                return { fingerprint: 'test-analyzer-v1' }
              }),
          },
          disposeAtlasArtifacts: () => Promise.resolve(),
          publicationHook: async (step, paths) =>
          {
            if (buildCount === 1) return
            steps.push(step)
            if (step === 'staging-complete')
            {
              expect(
                JSON.parse(
                  await NodeFSP.readFile(
                    NodePath.join(paths.staging, PROJECT_ATLAS_METADATA_FILENAME),
                    'utf8',
                  ),
                ),
              ).toMatchObject({ projectId })
              expect(
                JSON.parse(
                  await NodeFSP.readFile(NodePath.join(paths.target, 'graph.json'), 'utf8'),
                ),
              ).toMatchObject({ build: 1 })
            }
            if (step === 'target-backed-up')
            {
              expect(await NodeFSP.stat(paths.target).catch(() => null)).toBeNull()
              if (serviceRef.current === null) throw new Error('service was not initialized')
              coordinatedRead = Effect.runPromise(
                serviceRef.current.withStablePublication(
                  projectId,
                  Effect.promise(() =>
                    NodeFSP.readFile(NodePath.join(paths.target, 'graph.json'), 'utf8').then(
                      (value) => JSON.parse(value).build as number,
                    ),
                  ),
                ),
              )
              void coordinatedRead.then(() =>
              {
                coordinatedReadSettled = true
              })
              await Promise.resolve()
              expect(coordinatedReadSettled).toBe(false)
            }
            if (
              step === 'target-published' ||
              step === 'marker-removed' ||
              step === 'backup-removed'
            )
            {
              expect(
                JSON.parse(
                  await NodeFSP.readFile(
                    NodePath.join(paths.target, PROJECT_ATLAS_METADATA_FILENAME),
                    'utf8',
                  ),
                ),
              ).toMatchObject({ projectId })
              expect(
                JSON.parse(
                  await NodeFSP.readFile(NodePath.join(paths.target, 'graph.json'), 'utf8'),
                ),
              ).toMatchObject({ build: 2 })
            }
          },
        })
        serviceRef.current = service

        yield* service.request(requestFor(projectId, root, 1))
        yield* service.request(requestFor(projectId, root, 2))
        expect(steps).toEqual([
          'staging-complete',
          'target-backed-up',
          'target-published',
          'marker-removed',
          'backup-removed',
        ])
        expect(coordinatedRead).not.toBeNull()
        expect(yield* Effect.promise(() => coordinatedRead ?? Promise.resolve(-1))).toBe(2)
      }),
    ),
  )

  it('discards an interrupted staging publication and preserves its last good target', async () =>
  {
    const stateDir = await makeTemporaryRoot('456code-project-atlas-recovery-')
    const projectsRoot = NodePath.join(stateDir, 'cartographer', 'projects')
    const projectId = ProjectId.make('project-recovery')
    const target = projectAtlasDirectory(stateDir, projectId)
    const stagingName = '.project-recovery.staging-deadbeef'
    const backupName = '.project-recovery.backup-deadbeef'
    const staging = NodePath.join(projectsRoot, stagingName)
    await Promise.all([
      NodeFSP.mkdir(target, { recursive: true }),
      NodeFSP.mkdir(staging, { recursive: true }),
    ])
    await NodeFSP.writeFile(NodePath.join(target, 'last-good'), 'kept')
    await NodeFSP.writeFile(
      NodePath.join(staging, PROJECT_ATLAS_PUBLISH_MARKER_FILENAME),
      JSON.stringify({
        version: 1,
        projectId,
        targetName: projectId,
        stagingName,
        backupName,
      }),
    )

    expect(await recoverInterruptedProjectAtlasPublications(projectsRoot)).toBe(1)
    expect(await NodeFSP.readFile(NodePath.join(target, 'last-good'), 'utf8')).toBe('kept')
    expect(await NodeFSP.stat(staging).catch(() => null)).toBeNull()
  })

  it('restores the last-good backup when an interrupted staging marker is incomplete', async () =>
  {
    const stateDir = await makeTemporaryRoot('456code-project-atlas-incomplete-recovery-')
    const projectsRoot = NodePath.join(stateDir, 'cartographer', 'projects')
    const projectId = ProjectId.make('project-incomplete-recovery')
    const target = projectAtlasDirectory(stateDir, projectId)
    const staging = NodePath.join(projectsRoot, '.project-incomplete-recovery.staging-deadbeef')
    const backup = NodePath.join(projectsRoot, '.project-incomplete-recovery.backup-deadbeef')
    await Promise.all([
      NodeFSP.mkdir(staging, { recursive: true }),
      NodeFSP.mkdir(backup, { recursive: true }),
    ])
    await NodeFSP.writeFile(NodePath.join(backup, 'last-good'), 'restored')

    expect(await recoverInterruptedProjectAtlasPublications(projectsRoot)).toBe(1)
    expect(await NodeFSP.readFile(NodePath.join(target, 'last-good'), 'utf8')).toBe('restored')
    expect(await NodeFSP.stat(staging).catch(() => null)).toBeNull()
    expect(await NodeFSP.stat(backup).catch(() => null)).toBeNull()
  })

  it('removes a backup orphaned after marker cleanup', async () =>
  {
    const stateDir = await makeTemporaryRoot('456code-project-atlas-orphan-backup-')
    const projectsRoot = NodePath.join(stateDir, 'cartographer', 'projects')
    const projectId = ProjectId.make('project-orphan-backup')
    const target = projectAtlasDirectory(stateDir, projectId)
    const backup = NodePath.join(projectsRoot, '.project-orphan-backup.backup-deadbeef')
    await Promise.all([
      NodeFSP.mkdir(target, { recursive: true }),
      NodeFSP.mkdir(backup, { recursive: true }),
    ])
    await NodeFSP.writeFile(NodePath.join(target, 'published'), 'new')
    await NodeFSP.writeFile(NodePath.join(backup, 'published'), 'old')

    expect(await recoverInterruptedProjectAtlasPublications(projectsRoot)).toBe(1)
    expect(await NodeFSP.readFile(NodePath.join(target, 'published'), 'utf8')).toBe('new')
    expect(await NodeFSP.stat(backup).catch(() => null)).toBeNull()
  })
})
