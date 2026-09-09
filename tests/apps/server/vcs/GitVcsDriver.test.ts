// tests/apps/server/vcs/GitVcsDriver.test.ts
// verify git vcs driver behavior

import * as NodeServices from '@effect/platform-node/NodeServices'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import * as PlatformError from 'effect/PlatformError'
import * as Schema from 'effect/Schema'
import { ChildProcessSpawner } from 'effect/unstable/process'
import { assert, it } from '@effect/vitest'

import {
  CheckpointRef,
  GitCommandError,
  VcsProcessExitError,
  VcsUnsupportedOperationError,
} from '@t3tools/contracts'
import * as ServerConfig from '../../../../apps/server/src/config.ts'
import * as GitVcsDriver from '../../../../apps/server/src/vcs/GitVcsDriver.ts'
import * as VcsProcess from '../../../../apps/server/src/vcs/VcsProcess.ts'
import { runVcsDriverContractSuite } from '../../../../apps/server/src/vcs/testing/VcsDriverContractHarness.ts'

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: 't3-git-vcs-contract-',
})
const GitContractLayer = Layer.mergeAll(GitVcsDriver.vcsLayer, GitVcsDriver.layer).pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
)
const isVcsProcessExitError = Schema.is(VcsProcessExitError)
const isVcsUnsupportedOperationError = Schema.is(VcsUnsupportedOperationError)

const runGit = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* ()
  {
    const driver = yield* GitVcsDriver.GitVcsDriver
    yield* driver.execute({
      operation: 'GitVcsDriver.contract.git',
      cwd,
      args,
      timeoutMs: 10_000,
    })
  })

type GitContractError = GitCommandError | PlatformError.PlatformError

runVcsDriverContractSuite<GitVcsDriver.GitVcsDriver, GitContractError>({
  name: 'Git',
  kind: 'git',
  layer: GitContractLayer,
  fixture: {
    createRepo: (cwd) =>
      Effect.gen(function* ()
      {
        yield* runGit(cwd, ['init'])
        yield* runGit(cwd, ['config', 'user.email', 'test@test.com'])
        yield* runGit(cwd, ['config', 'user.name', 'Test'])
      }),
    writeFile: (cwd, relativePath, contents) =>
      Effect.gen(function* ()
      {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const absolutePath = path.join(cwd, relativePath)
        yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true })
        yield* fileSystem.writeFileString(absolutePath, contents)
      }),
    trackFile: (cwd, relativePath) => runGit(cwd, ['add', relativePath]),
    commit: (cwd, message) => runGit(cwd, ['commit', '-m', message]),
    ignorePath: (cwd, pattern) =>
      Effect.gen(function* ()
      {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        yield* fileSystem.writeFileString(path.join(cwd, '.gitignore'), `${pattern}\n`)
      }),
  },
})

it.effect('GitVcsDriver forwards execute env to the VCS process', () =>
{
  let observedEnv: NodeJS.ProcessEnv | undefined
  let observedAppendTruncationMarker: boolean | undefined
  let observedOutputMode: VcsProcess.VcsProcessInput['outputMode']

  return Effect.gen(function* ()
  {
    const driver = yield* GitVcsDriver.makeVcsDriverShape()

    yield* driver.execute({
      operation: 'GitVcsDriver.test.env',
      cwd: '/repo',
      args: ['status'],
      env: {
        GIT_INDEX_FILE: '/tmp/t3-index',
      },
      appendTruncationMarker: true,
      outputMode: 'error',
    })

    assert.deepStrictEqual(observedEnv, {
      GIT_INDEX_FILE: '/tmp/t3-index',
    })
    assert.strictEqual(observedAppendTruncationMarker, true)
    assert.strictEqual(observedOutputMode, 'error')
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(VcsProcess.VcsProcess)({
          run: (input) =>
            Effect.sync(() =>
            {
              observedEnv = input.env
              observedAppendTruncationMarker = input.appendTruncationMarker
              observedOutputMode = input.outputMode
              return {
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdout: '',
                stderr: '',
                stdoutTruncated: false,
                stderrTruncated: false,
              }
            }),
        }),
      ),
    ),
  )
})

it.effect('GitVcsDriver distinguishes exact snapshot policy refusals from capture failures', () =>
  Effect.gen(function* ()
  {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const repositoryRoot = yield* fileSystem.makeTempDirectoryScoped({
      prefix: 't3-git-vcs-checkpoint-policy-',
    })
    const childRoot = yield* fileSystem.makeTempDirectoryScoped({
      prefix: 't3-git-vcs-checkpoint-child-',
    })

    yield* runGit(childRoot, ['init'])
    yield* runGit(childRoot, ['config', 'user.email', 'test@test.com'])
    yield* runGit(childRoot, ['config', 'user.name', 'Test'])
    yield* fileSystem.writeFileString(path.join(childRoot, 'source.txt'), 'initial\n')
    yield* runGit(childRoot, ['add', 'source.txt'])
    yield* runGit(childRoot, ['commit', '-m', 'Initial child'])

    yield* runGit(repositoryRoot, ['init'])
    yield* runGit(repositoryRoot, ['config', 'user.email', 'test@test.com'])
    yield* runGit(repositoryRoot, ['config', 'user.name', 'Test'])
    yield* runGit(repositoryRoot, [
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      childRoot,
      'modules/child',
    ])
    yield* runGit(repositoryRoot, ['commit', '-m', 'Track child'])
    yield* fileSystem.writeFileString(
      path.join(repositoryRoot, 'modules', 'child', 'source.txt'),
      'dirty\n',
    )

    const driver = yield* GitVcsDriver.makeVcsDriverShape()
    const unsupported = yield* driver.checkpoints
      .captureCheckpoint({
        cwd: repositoryRoot,
        checkpointRef: CheckpointRef.make('refs/t3/checkpoints/test/unsupported'),
      })
      .pipe(Effect.flip)
    assert.ok(isVcsUnsupportedOperationError(unsupported))
    assert.match(unsupported.detail, /submodules are unsupported/u)

    yield* runGit(path.join(repositoryRoot, 'modules', 'child'), ['checkout', '--', 'source.txt'])

    const unreadablePath = path.join(repositoryRoot, 'unreadable.txt')
    yield* fileSystem.writeFileString(unreadablePath, 'unreadable\n')
    yield* runGit(repositoryRoot, ['add', 'unreadable.txt'])
    yield* runGit(repositoryRoot, ['commit', '-m', 'Track unreadable file'])
    const operationalFailure = yield* fileSystem.chmod(unreadablePath, 0o000).pipe(
      Effect.andThen(
        driver.checkpoints
          .captureCheckpoint({
            cwd: repositoryRoot,
            checkpointRef: CheckpointRef.make('refs/t3/checkpoints/test/operational-failure'),
          })
          .pipe(Effect.flip),
      ),
      Effect.ensuring(fileSystem.chmod(unreadablePath, 0o600).pipe(Effect.ignore)),
    )
    assert.ok(isVcsProcessExitError(operationalFailure))
    assert.match(operationalFailure.detail, /could not be opened without following links/u)

    const conflictPath = path.join(repositoryRoot, 'conflict.txt')
    yield* fileSystem.writeFileString(conflictPath, 'base\n')
    yield* runGit(repositoryRoot, ['add', 'conflict.txt'])
    yield* runGit(repositoryRoot, ['commit', '-m', 'Add conflict base'])
    yield* runGit(repositoryRoot, ['branch', 'snapshot-base'])
    yield* runGit(repositoryRoot, ['checkout', '-b', 'snapshot-side'])
    yield* fileSystem.writeFileString(conflictPath, 'side\n')
    yield* runGit(repositoryRoot, ['commit', '-am', 'Change conflict on side'])
    yield* runGit(repositoryRoot, ['checkout', 'snapshot-base'])
    yield* fileSystem.writeFileString(conflictPath, 'base branch\n')
    yield* runGit(repositoryRoot, ['commit', '-am', 'Change conflict on base'])
    yield* driver
      .execute({
        operation: 'GitVcsDriver.contract.git',
        cwd: repositoryRoot,
        args: ['merge', '--no-edit', 'snapshot-side'],
        timeoutMs: 10_000,
      })
      .pipe(Effect.flip)
    const structuralRefusal = yield* driver.checkpoints
      .captureCheckpoint({
        cwd: repositoryRoot,
        checkpointRef: CheckpointRef.make('refs/t3/checkpoints/test/structural-refusal'),
      })
      .pipe(Effect.flip)
    assert.ok(isVcsUnsupportedOperationError(structuralRefusal))
    assert.match(structuralRefusal.detail, /Unmerged index entries are unsupported/u)

    yield* fileSystem.writeFileString(path.join(repositoryRoot, '.git', 'index'), 'invalid')
    const processFailure = yield* driver.checkpoints
      .captureCheckpoint({
        cwd: repositoryRoot,
        checkpointRef: CheckpointRef.make('refs/t3/checkpoints/test/process-failure'),
      })
      .pipe(Effect.flip)
    assert.ok(isVcsProcessExitError(processFailure))
    assert.strictEqual(processFailure.command, 'capture exact Git snapshot')
  }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
)
