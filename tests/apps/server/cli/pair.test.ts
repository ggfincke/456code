// tests/apps/server/cli/pair.test.ts
// verify local pairing target ownership and secret-safe request routing

import * as NodeOS from 'node:os'
import * as NodePerfHooks from 'node:perf_hooks'

import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, it } from '@effect/vitest'
import {
  AuthStandardClientScopes,
  EnvironmentStorageOwnerTokenHeaderName,
} from '@t3tools/contracts'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import { FetchHttpClient } from 'effect/unstable/http'

import {
  discoverPairTarget,
  pairHttpClientLayer,
  PairCommandError,
  runPairCommand,
} from '../../../../apps/server/src/cli/pair.ts'
import { deriveServerPaths } from '../../../../apps/server/src/config.ts'
import { SERVER_STORAGE_LEASE_FILE } from '../../../../apps/server/src/serverStorageLease.ts'
import { renderTerminalQrCode } from '../../../../apps/server/src/startupAccess.ts'

const descriptor = {
  environmentId: 'pair-test-environment',
  label: 'Pair test server',
  platform: { os: 'darwin', arch: 'arm64' },
  serverVersion: '0.0.0',
  capabilities: {},
}

const writeRuntime = Effect.fn('writeRuntime')(function* (baseDir: string)
{
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  yield* fs.makeDirectory(baseDir, { recursive: true })
  const canonicalBaseDir = yield* fs.realPath(baseDir)
  const paths = yield* deriveServerPaths(canonicalBaseDir, undefined)
  yield* fs.makeDirectory(paths.stateDir, { recursive: true })
  const owner = {
    version: 1,
    token: 'test-local-owner-capability',
    pid: process.pid,
    hostname: NodeOS.hostname(),
    acquiredAt: new Date().toISOString(),
    processStartedAt: new Date(NodePerfHooks.performance.timeOrigin).toISOString(),
    canonicalBaseDir,
  }
  const state = {
    version: 1,
    pid: process.pid,
    port: 4971,
    host: '127.0.0.1',
    origin: 'http://127.0.0.1:4971',
    devUrl: 'https://web.test',
    startedAt: new Date().toISOString(),
    storageLeaseToken: owner.token,
  }
  const leasePath = path.join(canonicalBaseDir, SERVER_STORAGE_LEASE_FILE)
  yield* fs.writeFileString(leasePath, JSON.stringify(owner))
  yield* fs.writeFileString(paths.serverRuntimeStatePath, JSON.stringify(state))
  yield* fs.writeFileString(paths.environmentIdPath, descriptor.environmentId)
  return { baseDir: canonicalBaseDir, paths, leasePath, owner, state }
})

const fakeClientLayer = (
  fetch: (...args: Parameters<typeof globalThis.fetch>) => Promise<Response>,
) =>
  pairHttpClientLayer.pipe(
    Layer.provide(
      Layer.succeed(FetchHttpClient.Fetch, Object.assign(fetch, { preconnect: () => undefined })),
    ),
  )

it.layer(NodeServices.layer)('pair CLI', (it) =>
{
  it.effect('selects explicit home, then present worktree homes, then configured home', () =>
    Effect.gen(function* ()
    {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.makeTempDirectoryScoped({ prefix: 't3-pair-precedence-' })
      const repository = path.join(root, 'repo')
      yield* fs.makeDirectory(path.join(repository, '.git'), { recursive: true })
      const t3 = yield* writeRuntime(path.join(repository, '.t3'))
      const legacyLocal = yield* writeRuntime(path.join(repository, '.456code'))
      const configured = yield* writeRuntime(path.join(root, 'configured'))
      const provider = ConfigProvider.fromUnknown({ T3CODE_HOME: configured.baseDir })
      const discover = (baseDir?: string) =>
        discoverPairTarget({ cwd: repository, ...(baseDir === undefined ? {} : { baseDir }) }).pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, provider),
        )

      assert.equal((yield* discover(configured.baseDir)).baseDir, configured.baseDir)
      assert.equal((yield* discover()).baseDir, t3.baseDir)
      yield* fs.remove(t3.paths.serverRuntimeStatePath)
      assert.equal((yield* discover()).baseDir, legacyLocal.baseDir)
      yield* fs.remove(legacyLocal.paths.serverRuntimeStatePath)
      assert.equal((yield* discover()).baseDir, configured.baseDir)
    }),
  )

  it.effect(
    'fails closed on selected stale process and malformed metadata without leaking secrets',
    () =>
      Effect.gen(function* ()
      {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fs.makeTempDirectoryScoped({ prefix: 't3-pair-stale-' })
        yield* fs.makeDirectory(path.join(root, '.git'))
        const selected = yield* writeRuntime(path.join(root, '.t3'))
        const fallback = yield* writeRuntime(path.join(root, 'fallback'))
        const discover = discoverPairTarget({ cwd: root }).pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({ T3CODE_HOME: fallback.baseDir }),
          ),
        )
        // the PID is still alive, but its birth does not match the selected owner
        yield* fs.writeFileString(
          selected.leasePath,
          JSON.stringify({
            ...selected.owner,
            processStartedAt: '2000-01-01T00:00:00.000Z',
          }),
        )
        assert.instanceOf(yield* discover.pipe(Effect.flip), PairCommandError)
        yield* fs.writeFileString(selected.leasePath, JSON.stringify(selected.owner))
        yield* fs.writeFileString(
          selected.paths.serverRuntimeStatePath,
          JSON.stringify({ storageLeaseToken: selected.owner.token }),
        )
        const error = yield* discover.pipe(Effect.flip)
        assert.instanceOf(error, PairCommandError)
        assert.notInclude(JSON.stringify(error), selected.owner.token)
      }),
  )

  it.effect('rejects a different environment before sending the local-owner capability', () =>
    Effect.gen(function* ()
    {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ prefix: 't3-pair-wrong-server-' })
      const runtime = yield* writeRuntime(root)
      const requests: Array<{ url: string; headers: Headers }> = []
      const clientLayer = fakeClientLayer(async (input, init) =>
      {
        requests.push({ url: String(input), headers: new Headers(init?.headers) })
        return Response.json({ ...descriptor, environmentId: 'different-environment' })
      })
      const error = yield* runPairCommand({ baseDir: root }).pipe(
        Effect.provide(clientLayer),
        Effect.flip,
      )
      assert.instanceOf(error, PairCommandError)
      assert.equal(requests.length, 1)
      assert.equal(requests[0]?.url, `${runtime.state.origin}/.well-known/t3/environment`)
      assert.isFalse(requests[0]!.headers.has(EnvironmentStorageOwnerTokenHeaderName))
      assert.notInclude(JSON.stringify(error), runtime.owner.token)
    }),
  )

  it.effect(
    'issues only through loopback with redirects disabled and reuses QR/expiry output',
    () =>
      Effect.gen(function* ()
      {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({ prefix: 't3-pair-output-' })
        const runtime = yield* writeRuntime(root)
        const requests: Array<{ url: string; init: RequestInit | undefined }> = []
        const issued = {
          id: 'pair-link',
          credential: 'test-pairing-credential',
          expiresAt: '2026-08-27T15:00:00.000Z',
        }
        const clientLayer = fakeClientLayer(async (input, init) =>
        {
          requests.push({ url: String(input), init })
          return Response.json(init?.method === 'POST' ? issued : descriptor)
        })
        const output = yield* runPairCommand({
          baseDir: root,
          baseUrl: new URL('https://display.test'),
          label: 'test phone',
        }).pipe(Effect.provide(clientLayer))

        assert.equal(requests.length, 2)
        assert.deepStrictEqual(
          requests.map(({ url }) => url),
          [
            `${runtime.state.origin}/.well-known/t3/environment`,
            `${runtime.state.origin}/api/auth/pairing-token`,
          ],
        )
        assert.isTrue(requests.every(({ init }) => init?.redirect === 'error'))
        assert.equal(
          new Headers(requests[1]?.init?.headers).get(EnvironmentStorageOwnerTokenHeaderName),
          runtime.owner.token,
        )
        assert.deepStrictEqual(
          yield* Effect.promise(() => new Response(requests[1]?.init?.body).json()),
          {
            scopes: AuthStandardClientScopes,
            label: 'test phone',
          },
        )
        const pairingUrl = 'https://display.test/pair#token=test-pairing-credential'
        assert.include(output, `Pairing URL: ${pairingUrl}`)
        assert.include(output, `Expires: ${issued.expiresAt}`)
        assert.include(output, renderTerminalQrCode(pairingUrl))
        assert.notInclude(output, runtime.owner.token)
      }),
  )
})
