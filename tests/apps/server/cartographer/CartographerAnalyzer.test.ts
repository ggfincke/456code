// tests/apps/server/cartographer/CartographerAnalyzer.test.ts
// verifies workspace CLI resolution, serialization, and typed analyzer failures

// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeProcess from 'node:process'

import { it } from '@effect/vitest'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import { afterEach, describe, expect } from 'vite-plus/test'

import * as CartographerAnalyzer from '../../../../apps/server/src/cartographer/CartographerAnalyzer.ts'
import * as ProcessRunner from '../../../../apps/server/src/process/processRunner.ts'

const temporaryRoots = new Set<string>()

async function makePackage(
  options: {
    readonly includeCli?: boolean
  } = {},
): Promise<{
  readonly packageJsonPath: string
  readonly cliPath: string
}>
{
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), '456code-analyzer-package-'))
  temporaryRoots.add(root)
  const cliPath = NodePath.join(root, 'dist', 'cli', 'index.js')
  await NodeFSP.mkdir(NodePath.dirname(cliPath), { recursive: true })
  if (options.includeCli !== false)
  {
    await NodeFSP.writeFile(cliPath, 'process.exit(0)\n')
  }
  await NodeFSP.writeFile(NodePath.join(root, 'dist', 'runtime.js'), 'runtime-v1\n')
  const packageJsonPath = NodePath.join(root, 'package.json')
  await NodeFSP.writeFile(
    packageJsonPath,
    JSON.stringify({
      name: '@t3tools/cartographer-core',
      version: '0.1.0-test',
      bin: { cartographer: './dist/cli/index.js' },
    }),
  )
  return { packageJsonPath, cliPath }
}

const successOutput = {
  stdout: '',
  stderr: '',
  code: 0 as never,
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
} satisfies ProcessRunner.ProcessRunOutput

const analyzerLayer = (
  packageJsonPath: string,
  run: ProcessRunner.ProcessRunner['Service']['run'],
) =>
  Layer.effect(
    CartographerAnalyzer.CartographerAnalyzer,
    CartographerAnalyzer.make({ resolvePackageJson: () => packageJsonPath }),
  ).pipe(
    Layer.provide(
      Layer.succeed(ProcessRunner.ProcessRunner, ProcessRunner.ProcessRunner.of({ run })),
    ),
  )

afterEach(async () =>
{
  await Promise.all(
    [...temporaryRoots].map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  )
  temporaryRoots.clear()
})

describe('CartographerAnalyzer', () =>
{
  it.effect('advertises native architecture only when the CLI is present', () =>
    Effect.gen(function* ()
    {
      const cliOnly = yield* Effect.promise(() => makePackage())
      const missingCli = yield* Effect.promise(() => makePackage({ includeCli: false }))

      expect(
        yield* CartographerAnalyzer.workspaceDistributionCapabilities({
          resolvePackageJson: () => cliOnly.packageJsonPath,
        }),
      ).toEqual({ architectureImpact: true })
      expect(
        yield* CartographerAnalyzer.workspaceDistributionCapabilities({
          resolvePackageJson: () => missingCli.packageJsonPath,
        }),
      ).toEqual({ architectureImpact: false })
    }),
  )

  it.effect('serializes workspace CLI analysis child lifetimes', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const fixture = yield* Effect.promise(() => makePackage())
        const firstEntered = yield* Deferred.make<void>()
        const secondEntered = yield* Deferred.make<void>()
        const releaseFirst = yield* Deferred.make<void>()
        const calls: ProcessRunner.ProcessRunInput[] = []
        let callCount = 0
        const run: ProcessRunner.ProcessRunner['Service']['run'] = (input) =>
          Effect.gen(function* ()
          {
            calls.push(input)
            callCount += 1
            if (callCount === 1)
            {
              yield* Deferred.succeed(firstEntered, undefined)
              yield* Deferred.await(releaseFirst)
            }
            else
            {
              yield* Deferred.succeed(secondEntered, undefined)
            }
            return successOutput
          })
        const analyzer = yield* CartographerAnalyzer.CartographerAnalyzer.pipe(
          Effect.provide(analyzerLayer(fixture.packageJsonPath, run)),
        )
        const first = yield* analyzer
          .prepareCurrentWorktree({
            root: '/captured/worktree',
            outDir: '/current-worktrees/current/artifacts',
            signal: new AbortController().signal,
          })
          .pipe(Effect.forkChild)
        yield* Deferred.await(firstEntered)
        const second = yield* analyzer
          .analyzeTrees({
            baseRoot: '/generations/base',
            proposedRoot: '/generations/proposed',
            outDir: '/generations/output',
            baseRef: '1'.repeat(40),
            proposedRef: '2'.repeat(40),
          })
          .pipe(Effect.forkChild)

        yield* Effect.yieldNow
        expect(Option.isNone(yield* Deferred.poll(secondEntered))).toBe(true)
        yield* Deferred.succeed(releaseFirst, undefined)
        yield* Fiber.join(first)
        const comparison = yield* Fiber.join(second)

        expect(comparison.fingerprint).toMatch(
          /^@t3tools\/cartographer-core@0\.1\.0-test:dist-sha256:[0-9a-f]{64}$/u,
        )
        expect(calls).toHaveLength(2)
        const cliPath = yield* Effect.promise(() => NodeFSP.realpath(fixture.cliPath))
        expect(calls[0]?.command).toBe(NodeProcess.execPath)
        expect(calls[0]?.args[0]).toBe(cliPath)
        expect(calls[0]?.args).toContain('build')
        expect(calls[0]?.cwd).toBe('/captured/worktree')
        expect(calls[1]?.command).toBe(NodeProcess.execPath)
        expect(calls[1]?.args[0]).toBe(cliPath)
        expect(calls[1]?.args).toContain('analyze-trees')
        expect(calls[1]?.args).toContain(comparison.fingerprint)
        expect(calls[1]?.cwd).toBe('/generations/output')
      }),
    ),
  )

  it.effect('reports a missing workspace dist as unsupported without failing layer creation', () =>
    Effect.gen(function* ()
    {
      const fixture = yield* Effect.promise(() => makePackage({ includeCli: false }))
      const analyzer = yield* CartographerAnalyzer.make({
        resolvePackageJson: () => fixture.packageJsonPath,
      }).pipe(
        Effect.provideService(
          ProcessRunner.ProcessRunner,
          ProcessRunner.ProcessRunner.of({ run: () => Effect.succeed(successOutput) }),
        ),
      )
      const failure = yield* analyzer.identify.pipe(Effect.flip)

      expect(failure._tag).toBe('CartographerError')
      expect(failure.failure).toBe('unsupported')
    }),
  )

  it.effect('builds standing project artifacts from the live project cwd', () =>
    Effect.gen(function* ()
    {
      const fixture = yield* Effect.promise(() => makePackage())
      const calls: ProcessRunner.ProcessRunInput[] = []
      const analyzer = yield* CartographerAnalyzer.make({
        resolvePackageJson: () => fixture.packageJsonPath,
      }).pipe(
        Effect.provideService(
          ProcessRunner.ProcessRunner,
          ProcessRunner.ProcessRunner.of({
            run: (input) =>
              Effect.sync(() =>
              {
                calls.push(input)
                return successOutput
              }),
          }),
        ),
      )
      const result = yield* analyzer.buildProjectAtlas({
        root: '/live/project',
        outDir: '/state/cartographer/projects/.project.staging',
        signal: new AbortController().signal,
      })

      expect(result.fingerprint).toMatch(/dist-sha256:[0-9a-f]{64}$/u)
      expect(calls).toHaveLength(1)
      const cliPath = yield* Effect.promise(() => NodeFSP.realpath(fixture.cliPath))
      expect(calls[0]?.command).toBe(NodeProcess.execPath)
      expect(calls[0]?.args[0]).toBe(cliPath)
      expect(calls[0]?.args).toContain('build')
      expect(calls[0]?.cwd).toBe('/live/project')
    }),
  )

  it.effect('maps spawn and nonzero build failures to atlas-neutral error codes', () =>
    Effect.gen(function* ()
    {
      const fixture = yield* Effect.promise(() => makePackage())
      const spawnFailure = new ProcessRunner.ProcessSpawnError({
        command: NodeProcess.execPath,
        argumentCount: 7,
        cause: new Error('spawn failed'),
      })
      const failedToSpawn = yield* CartographerAnalyzer.make({
        resolvePackageJson: () => fixture.packageJsonPath,
      }).pipe(
        Effect.provideService(
          ProcessRunner.ProcessRunner,
          ProcessRunner.ProcessRunner.of({ run: () => Effect.fail(spawnFailure) }),
        ),
      )
      const spawnError = yield* failedToSpawn
        .prepareCurrentWorktree({
          root: '/captured/worktree',
          outDir: '/current-worktrees/current/artifacts',
          signal: new AbortController().signal,
        })
        .pipe(Effect.flip)
      expect(spawnError.failure).toBe('context_start_failed')

      const nonzero = yield* CartographerAnalyzer.make({
        resolvePackageJson: () => fixture.packageJsonPath,
      }).pipe(
        Effect.provideService(
          ProcessRunner.ProcessRunner,
          ProcessRunner.ProcessRunner.of({
            run: () => Effect.succeed({ ...successOutput, code: 1 as never }),
          }),
        ),
      )
      const buildError = yield* nonzero
        .prepareCurrentWorktree({
          root: '/captured/worktree',
          outDir: '/current-worktrees/current/artifacts',
          signal: new AbortController().signal,
        })
        .pipe(Effect.flip)
      expect(buildError.failure).toBe('snapshot_failed')
    }),
  )
})
