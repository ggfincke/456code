// tests/apps/server/provider/AntigravityInstallation.test.ts
// verify bounded Antigravity runtime installation, activation, and leases

import * as NodeServices from '@effect/platform-node/NodeServices'
import { expect, it } from '@effect/vitest'
import { HostProcessArchitecture, HostProcessPlatform } from '@t3tools/shared/hostProcess'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as PlatformError from 'effect/PlatformError'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'
import { HttpClient, HttpClientResponse } from 'effect/unstable/http'
import * as NodeCrypto from 'node:crypto'

import {
  AntigravityInstallationError,
  makeAntigravityInstallation,
  type AntigravityExecutable,
  type AntigravityInstallation,
  type AntigravityInstallationOptions,
} from '../../../../apps/server/src/provider/AntigravityInstallation.ts'
import type { AntigravityReleaseAsset } from '../../../../apps/server/src/provider/antigravityRelease.ts'

const serverContents = 'antigravity runtime\n'
const harnessContents = 'local harness\n'
const previousReleaseId = '1'.repeat(64)
const previousVersion = 'fixture-old'
const encodeJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

// these tiny ZIP fixtures include intentional traversal and symlink metadata.
const zipFixtures = {
  complete:
    'UEsDBBQAAAAIAAAAIl1zEy/oFAAAABQAAAASAAAAYWd5X2FjcF9zZXJ2ZXIucGFyS8wryUwvSizLLKlUKCoFcnJTuQBQSwMEFAAAAAgAAAAiXV9yAykQAAAADgAAABUAAABsb2NhbGhhcm5lc3NfZXh0ZXJuYWzLyU9OzFHISCzKSy0u5gIAUEsBAhQDFAAAAAgAAAAiXXMTL+gUAAAAFAAAABIAAAAAAAAAAAAAAO2BAAAAAGFneV9hY3Bfc2VydmVyLnBhclBLAQIUAxQAAAAIAAAAIl1fcgMpEAAAAA4AAAAVAAAAAAAAAAAAAADtgUQAAABsb2NhbGhhcm5lc3NfZXh0ZXJuYWxQSwUGAAAAAAIAAgCDAAAAhwAAAAAA',
  missingHarness:
    'UEsDBBQAAAAIAAAAIl1zEy/oFAAAABQAAAASAAAAYWd5X2FjcF9zZXJ2ZXIucGFyS8wryUwvSizLLKlUKCoFcnJTuQBQSwECFAMUAAAACAAAACJdcxMv6BQAAAAUAAAAEgAAAAAAAAAAAAAA7YEAAAAAYWd5X2FjcF9zZXJ2ZXIucGFyUEsFBgAAAAABAAEAQAAAAEQAAAAAAA==',
  duplicate:
    'UEsDBBQAAAAIAAAAIl1zEy/oFAAAABQAAAASAAAAYWd5X2FjcF9zZXJ2ZXIucGFyS8wryUwvSizLLKlUKCoFcnJTuQBQSwMEFAAAAAgAAAAiXXMTL+gUAAAAFAAAABIAAABhZ3lfYWNwX3NlcnZlci5wYXJLzCvJTC9KLMssqVQoKgVyclO5AFBLAQIUAxQAAAAIAAAAIl1zEy/oFAAAABQAAAASAAAAAAAAAAAAAADtgQAAAABhZ3lfYWNwX3NlcnZlci5wYXJQSwECFAMUAAAACAAAACJdcxMv6BQAAAAUAAAAEgAAAAAAAAAAAAAA7YFEAAAAYWd5X2FjcF9zZXJ2ZXIucGFyUEsFBgAAAAACAAIAgAAAAIgAAAAAAA==',
  traversal:
    'UEsDBBQAAAAIAAAAIl1zEy/oFAAAABQAAAAVAAAALi5cYWd5X2FjcF9zZXJ2ZXIucGFyS8wryUwvSizLLKlUKCoFcnJTuQBQSwMEFAAAAAgAAAAiXV9yAykQAAAADgAAABUAAABsb2NhbGhhcm5lc3NfZXh0ZXJuYWzLyU9OzFHISCzKSy0u5gIAUEsBAhQDFAAAAAgAAAAiXXMTL+gUAAAAFAAAABUAAAAAAAAAAAAAAO2BAAAAAC4uXGFneV9hY3Bfc2VydmVyLnBhclBLAQIUAxQAAAAIAAAAIl1fcgMpEAAAAA4AAAAVAAAAAAAAAAAAAADtgUcAAABsb2NhbGhhcm5lc3NfZXh0ZXJuYWxQSwUGAAAAAAIAAgCGAAAAigAAAAAA',
  symlink:
    'UEsDBBQAAAAIAAAAIl1zEy/oFAAAABQAAAASAAAAYWd5X2FjcF9zZXJ2ZXIucGFyS8wryUwvSizLLKlUKCoFcnJTuQBQSwMEFAAAAAgAAAAiXV9yAykQAAAADgAAABUAAABsb2NhbGhhcm5lc3NfZXh0ZXJuYWzLyU9OzFHISCzKSy0u5gIAUEsBAhQDFAAAAAgAAAAiXXMTL+gUAAAAFAAAABIAAAAAAAAAAAAAAO2BAAAAAGFneV9hY3Bfc2VydmVyLnBhclBLAQIUAxQAAAAIAAAAIl1fcgMpEAAAAA4AAAAVAAAAAAAAAAAAAAD/oUQAAABsb2NhbGhhcm5lc3NfZXh0ZXJuYWxQSwUGAAAAAAIAAgCDAAAAhwAAAAAA',
  oversizedMember:
    'UEsDBBQAAAAIAAAAIl0WGThFFQAAABUAAAASAAAAYWd5X2FjcF9zZXJ2ZXIucGFyS8wryUwvSizLLKlUKCoFcnJTuSoAUEsDBBQAAAAIAAAAIl1fcgMpEAAAAA4AAAAVAAAAbG9jYWxoYXJuZXNzX2V4dGVybmFsy8lPTsxRyEgsykstLuYCAFBLAQIUAxQAAAAIAAAAIl0WGThFFQAAABUAAAASAAAAAAAAAAAAAADtgQAAAABhZ3lfYWNwX3NlcnZlci5wYXJQSwECFAMUAAAACAAAACJdX3IDKRAAAAAOAAAAFQAAAAAAAAAAAAAA7YFFAAAAbG9jYWxoYXJuZXNzX2V4dGVybmFsUEsFBgAAAAACAAIAgwAAAIgAAAAAAA==',
  windows:
    'UEsDBBQAAAAIAAAAIl1zEy/oFAAAABQAAAASAAAAYWd5X2FjcF9zZXJ2ZXIuZXhlS8wryUwvSizLLKlUKCoFcnJTuQBQSwMEFAAAAAgAAAAiXV9yAykQAAAADgAAABkAAABsb2NhbGhhcm5lc3NfZXh0ZXJuYWwuZXhly8lPTsxRyEgsykstLuYCAFBLAQIUAxQAAAAIAAAAIl1zEy/oFAAAABQAAAASAAAAAAAAAAAAAADtgQAAAABhZ3lfYWNwX3NlcnZlci5leGVQSwECFAMUAAAACAAAACJdX3IDKRAAAAAOAAAAGQAAAAAAAAAAAAAA7YFEAAAAbG9jYWxoYXJuZXNzX2V4dGVybmFsLmV4ZVBLBQYAAAAAAgACAIcAAACLAAAAAAA=',
}

// install mechanics are identical, while executable-bit checks must match the host filesystem.
const hostPlatform: NodeJS.Platform =
  HostProcessPlatform.defaultValue() === 'win32' ? 'win32' : 'linux'
const completeArchive = Buffer.from(
  hostPlatform === 'win32' ? zipFixtures.windows : zipFixtures.complete,
  'base64',
)
const executableName = hostPlatform === 'win32' ? 'agy_acp_server.exe' : 'agy_acp_server.par'
const harnessName = hostPlatform === 'win32' ? 'localharness_external.exe' : 'localharness_external'

function releaseAsset(
  archive: Uint8Array = completeArchive,
  platform: NodeJS.Platform = hostPlatform,
): AntigravityReleaseAsset
{
  return {
    version: 'fixture-new',
    url: 'https://dl.google.com/antigravity-test.zip',
    sha256: NodeCrypto.createHash('sha256').update(archive).digest('hex'),
    archiveBytes: archive.byteLength,
    executable: {
      name: platform === 'win32' ? 'agy_acp_server.exe' : 'agy_acp_server.par',
      bytes: Buffer.byteLength(serverContents),
    },
    harness: {
      name: platform === 'win32' ? 'localharness_external.exe' : 'localharness_external',
      bytes: Buffer.byteLength(harnessContents),
    },
  }
}

const writeRelease = Effect.fn('test.writeAntigravityRelease')(function* (
  managedDirectory: string,
  asset: AntigravityReleaseAsset,
  active = true,
)
{
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = path.join(managedDirectory, 'versions', asset.sha256)
  yield* fs.makeDirectory(directory, { recursive: true })
  yield* fs.writeFileString(path.join(directory, asset.executable.name), serverContents, {
    mode: 0o755,
  })
  yield* fs.writeFileString(path.join(directory, asset.harness.name), harnessContents, {
    mode: 0o755,
  })
  yield* fs.writeFileString(
    path.join(directory, '.install-complete.json'),
    encodeJsonString({
      releaseId: asset.sha256,
      version: asset.version,
      executable: asset.executable,
      harness: asset.harness,
    }),
  )
  if (active)
  {
    yield* fs.writeFileString(
      path.join(managedDirectory, 'active.json'),
      encodeJsonString({ releaseId: asset.sha256 }),
    )
  }
})

interface HarnessOptions
{
  readonly baseDir?: string
  readonly asset?: AntigravityReleaseAsset | null
  readonly archive?: Buffer
  readonly body?: Stream.Stream<Uint8Array>
  readonly platform?: NodeJS.Platform
  readonly previous?: boolean
  readonly fileSystem?: FileSystem.FileSystem
  readonly validate?: AntigravityInstallationOptions['validate']
}

const makeHarness = Effect.fn('test.makeAntigravityInstallation')(function* (
  options: HarnessOptions = {},
)
{
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const baseDir =
    options.baseDir ?? (yield* fs.makeTempDirectoryScoped({ prefix: '456code-agy-test-' }))
  const platform = options.platform ?? hostPlatform
  const archive = options.archive ?? completeArchive
  const asset = options.asset === undefined ? releaseAsset(archive, platform) : options.asset
  const managedDirectory = path.join(baseDir, 'tools', 'antigravity-acp', `${platform}-x64`)
  if (options.previous)
  {
    yield* writeRelease(managedDirectory, {
      ...releaseAsset(archive, platform),
      sha256: previousReleaseId,
      version: previousVersion,
    })
  }
  const stagingReleased = yield* Deferred.make<void>()
  const requests: Array<string> = []
  const validations: Array<{
    executable: AntigravityExecutable
    expectedVersion: string
  }> = []
  const installationFs = options.fileSystem ?? fs
  const trackedFs = FileSystem.FileSystem.of({
    ...installationFs,
    makeTempDirectoryScoped: (settings) =>
      settings?.prefix === '.install-'
        ? Effect.acquireRelease(installationFs.makeTempDirectory(settings), (directory) =>
            fs
              .remove(directory, { recursive: true, force: true })
              .pipe(Effect.orDie, Effect.andThen(Deferred.succeed(stagingReleased, undefined))),
          )
        : installationFs.makeTempDirectoryScoped(settings),
  })
  const installation = yield* makeAntigravityInstallation({
    baseDir,
    releaseAsset: asset,
    validate: (input) =>
      Effect.sync(() => validations.push(input)).pipe(
        Effect.andThen(options.validate?.(input) ?? Effect.void),
      ),
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, trackedFs),
    Effect.provideService(HostProcessPlatform, platform),
    Effect.provideService(HostProcessArchitecture, 'x64'),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() =>
        {
          requests.push(request.url)
          const response = HttpClientResponse.fromWeb(request, new Response(null))
          return Object.defineProperty(response, 'stream', {
            value:
              options.body ??
              Stream.make(
                archive.subarray(0, 31),
                archive.subarray(31, 149),
                archive.subarray(149),
              ),
          })
        }),
      ),
    ),
  )
  return { installation, fs, path, baseDir, requests, validations, stagingReleased }
})

const terminalState = (installation: AntigravityInstallation['Service']) =>
  installation.changes.pipe(
    Stream.filter((state) => ['succeeded', 'failed', 'cancelled'].includes(state.phase)),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  )

const expectPreviousRelease = Effect.fn('test.expectPreviousAntigravityRelease')(function* (
  installation: AntigravityInstallation['Service'],
)
{
  const selected = yield* installation.resolve()
  expect(selected).toMatchObject({ source: 'managed', version: previousVersion })
  expect((yield* installation.state).installedVersion).toBe(previousVersion)
})

it.layer(NodeServices.layer)('AntigravityInstallation', (it) =>
{
  it.effect('validates the exact extracted pair before atomically activating it', () =>
    Effect.gen(function* ()
    {
      const enteredValidation = yield* Deferred.make<void>()
      const finishValidation = yield* Deferred.make<void>()
      const { installation, fs, path, validations, stagingReleased } = yield* makeHarness({
        previous: true,
        validate: () =>
          Deferred.succeed(enteredValidation, undefined).pipe(
            Effect.andThen(Deferred.await(finishValidation)),
          ),
      })
      const started = yield* installation.start
      yield* Deferred.await(enteredValidation)
      yield* expectPreviousRelease(installation)

      const validation = validations[0]
      if (!validation)
      {
        return yield* Effect.die('Expected runtime validation.')
      }
      expect(validation.expectedVersion).toBe('fixture-new')
      expect(yield* fs.readFileString(validation.executable.executablePath)).toBe(serverContents)
      expect(yield* fs.readFileString(validation.executable.harnessPath)).toBe(harnessContents)
      if (hostPlatform !== 'win32')
      {
        expect((yield* fs.stat(validation.executable.executablePath)).mode & 0o111).not.toBe(0)
        expect((yield* fs.stat(validation.executable.harnessPath)).mode & 0o111).not.toBe(0)
      }

      yield* Deferred.succeed(finishValidation, undefined)
      expect(yield* terminalState(installation)).toMatchObject({
        operationId: started.operationId,
        phase: 'succeeded',
        downloadedBytes: completeArchive.byteLength,
        installedVersion: 'fixture-new',
      })
      yield* Deferred.await(stagingReleased)
      const selected = yield* installation.resolve()
      expect(selected).toMatchObject({ source: 'managed', version: 'fixture-new' })
      expect(path.dirname(selected.executablePath)).toBe(path.dirname(selected.harnessPath))
      expect(yield* fs.readDirectory(path.join(installation.managedDirectory, 'versions'))).toEqual(
        expect.arrayContaining([previousReleaseId, releaseAsset().sha256]),
      )
    }),
  )
})
