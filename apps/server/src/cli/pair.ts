// apps/server/src/cli/pair.ts
// verify a running local server and request a standard-client pairing credential

import * as NodeNet from 'node:net'
import * as NodeOS from 'node:os'

import {
  AuthPairingCredentialResult,
  AuthStandardClientScopes,
  EnvironmentId,
  EnvironmentStorageOwnerTokenHeaderName,
  ExecutionEnvironmentDescriptor,
} from '@t3tools/contracts'
import * as Config from 'effect/Config'
import * as Console from 'effect/Console'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'
import { Command, Flag } from 'effect/unstable/cli'
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from 'effect/unstable/http'

import { deriveServerPaths, type ServerDerivedPaths } from '../config.ts'
import { resolveBaseDir } from '../os-jank.ts'
import { PersistedServerRuntimeState } from '../serverRuntimeState.ts'
import {
  incumbentProcessLiveness,
  SERVER_STORAGE_LEASE_FILE,
  ServerStorageLeaseOwner,
} from '../serverStorageLease.ts'
import {
  buildPairingUrl,
  formatHostForUrl,
  isLoopbackHost,
  isWildcardHost,
  renderTerminalQrCode,
  resolveHeadlessConnectionString,
} from '../startupAccess.ts'
import { baseDirFlag } from './config.ts'

const PROBE_TIMEOUT = '2500 millis'
const DEV_STATE_VARIANT = new URL('http://localhost')
const decodeRuntimeState = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PersistedServerRuntimeState),
)
const decodeLeaseOwner = Schema.decodeUnknownEffect(Schema.fromJsonString(ServerStorageLeaseOwner))
const decodeEnvironmentId = Schema.decodeUnknownEffect(EnvironmentId)
const decodeUrl = Schema.decodeUnknownEffect(Schema.URLFromString)

export class PairCommandError extends Schema.TaggedErrorClass<PairCommandError>()(
  'PairCommandError',
  {
    message: Schema.String,
  },
)
{}

interface PairTarget
{
  readonly baseDir: string
  readonly paths: ServerDerivedPaths
  readonly variant: 'userdata' | 'dev'
  readonly state: PersistedServerRuntimeState
  readonly origin: string
  readonly environmentId: EnvironmentId
  readonly stateContents: string
  readonly leasePath: string
  readonly leaseContents: string
}

// only literal loopback addresses may receive the local storage-owner capability
const loopbackOrigin = (state: PersistedServerRuntimeState): string | undefined =>
{
  try
  {
    const url = new URL(state.origin)
    const configuredHost =
      state.host && !isWildcardHost(state.host) ? formatHostForUrl(state.host) : '127.0.0.1'
    if (url.origin !== new URL(`http://${configuredHost}:${state.port}`).origin) return undefined
    const host = url.hostname
    const loopback =
      host === 'localhost' ||
      host === '[::1]' ||
      (NodeNet.isIP(host) === 4 && host.startsWith('127.'))
    if (
      !loopback ||
      url.protocol !== 'http:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      !Number.isSafeInteger(state.port) ||
      state.port < 1 ||
      state.port > 65535 ||
      Number(url.port || '80') !== state.port
    )
      return undefined
    // avoid DNS resolution even for the localhost alias
    if (host === 'localhost') url.hostname = '127.0.0.1'
    return url.origin
  }
  catch
  {
    return undefined
  }
}

const resolvePairBases = Effect.fn('pair.resolvePairBases')(function* (
  explicitBaseDir: string | undefined,
  cwd: string,
)
{
  if (explicitBaseDir !== undefined) return [yield* resolveBaseDir(explicitBaseDir)]
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const bases: Array<string> = []
  let directory = path.resolve(cwd)
  while (true)
  {
    if (yield* fs.exists(path.join(directory, '.git')))
    {
      bases.push(path.join(directory, '.t3'), path.join(directory, '.456code'))
      break
    }
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  const envHome = yield* Config.string('T3CODE_HOME').pipe(Config.option)
  bases.push(yield* resolveBaseDir(Option.getOrUndefined(envHome)))
  return [...new Set(bases)]
})

const readPairTarget = Effect.fn('pair.readPairTarget')(
  function* (baseDir: string, paths: ServerDerivedPaths, variant: PairTarget['variant'])
  {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const canonicalBaseDir = yield* fs.realPath(baseDir)
    const leasePath = path.join(canonicalBaseDir, SERVER_STORAGE_LEASE_FILE)
    const stateContents = yield* fs.readFileString(paths.serverRuntimeStatePath)
    const leaseContents = yield* fs.readFileString(leasePath)
    const state = yield* decodeRuntimeState(stateContents)
    const owner = yield* decodeLeaseOwner(leaseContents)
    const environmentId = yield* decodeEnvironmentId(
      (yield* fs.readFileString(paths.environmentIdPath)).trim(),
    )
    const origin = loopbackOrigin(state)
    if (
      origin === undefined ||
      owner.canonicalBaseDir !== canonicalBaseDir ||
      owner.hostname !== NodeOS.hostname() ||
      owner.pid !== state.pid ||
      !state.storageLeaseToken ||
      owner.token !== state.storageLeaseToken ||
      !Number.isFinite(Date.parse(owner.processStartedAt)) ||
      !Number.isFinite(Date.parse(state.startedAt)) ||
      Date.parse(owner.processStartedAt) > Date.parse(state.startedAt) ||
      (yield* incumbentProcessLiveness(owner)) !== 'alive'
    )
    {
      return yield* new PairCommandError({
        message:
          'The selected server runtime is stale, mismatched, or not listening on loopback. Restart that server before pairing.',
      })
    }
    return {
      baseDir: canonicalBaseDir,
      paths,
      variant,
      state,
      origin,
      environmentId,
      stateContents,
      leasePath,
      leaseContents,
    } satisfies PairTarget
  },
  Effect.mapError(
    () =>
      new PairCommandError({
        message:
          'Cannot verify the selected local server runtime and storage owner. Restart that server before pairing.',
      }),
  ),
)

export const discoverPairTarget = Effect.fn('pair.discoverPairTarget')(function* (
  options: { readonly baseDir?: string; readonly cwd?: string } = {},
)
{
  const fs = yield* FileSystem.FileSystem
  const bases = yield* resolvePairBases(options.baseDir, options.cwd ?? process.cwd())
  for (const baseDir of bases)
  {
    for (const variant of ['userdata', 'dev'] as const)
    {
      const paths = yield* deriveServerPaths(
        baseDir,
        variant === 'dev' ? DEV_STATE_VARIANT : undefined,
      )
      if (!(yield* fs.exists(paths.serverRuntimeStatePath))) continue
      // present metadata selects the target; a stale selection never falls through to another server
      return yield* readPairTarget(baseDir, paths, variant)
    }
  }
  return yield* new PairCommandError({
    message: 'No running 456code server found. Start one or pass its --base-dir.',
  })
})

const assertTargetUnchanged = Effect.fn('pair.assertTargetUnchanged')(function* (
  target: PairTarget,
)
{
  const current = yield* readPairTarget(target.baseDir, target.paths, target.variant)
  if (
    current.stateContents !== target.stateContents ||
    current.leaseContents !== target.leaseContents ||
    current.environmentId !== target.environmentId
  )
  {
    return yield* new PairCommandError({
      message: 'The selected server changed during pairing. Run the command again.',
    })
  }
})

export const formatPairOutput = (input: {
  readonly label: string
  readonly baseUrl: string
  readonly issued: AuthPairingCredentialResult
}): string =>
{
  const pairingUrl = buildPairingUrl(input.baseUrl, input.issued.credential)
  return [
    `Pairing with ${input.label}.`,
    `Pairing URL: ${pairingUrl}`,
    `Expires: ${DateTime.formatIso(input.issued.expiresAt)}`,
    '',
    renderTerminalQrCode(pairingUrl),
    ...(isLoopbackHost(new URL(input.baseUrl).hostname)
      ? [
          '',
          'This URL is reachable only from this machine. Use --base-url for an existing reachable web origin.',
        ]
      : []),
    '',
  ].join('\n')
}

export const runPairCommand = Effect.fn('pair.runPairCommand')(function* (
  options: {
    readonly baseDir?: string
    readonly cwd?: string
    readonly baseUrl?: URL
    readonly label?: string
  } = {},
)
{
  const target = yield* discoverPairTarget(options)
  const client = yield* HttpClient.HttpClient
  const descriptor = yield* client.get(`${target.origin}/.well-known/t3/environment`).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(ExecutionEnvironmentDescriptor)),
    Effect.timeout(PROBE_TIMEOUT),
    Effect.mapError(
      () =>
        new PairCommandError({
          message: 'The selected local server did not return a valid environment descriptor.',
        }),
    ),
  )
  if (descriptor.environmentId !== target.environmentId)
  {
    return yield* new PairCommandError({
      message:
        'The server at the recorded port belongs to a different environment. No credential was issued.',
    })
  }
  if (target.variant === 'dev' && !target.state.devUrl && !options.baseUrl)
  {
    return yield* new PairCommandError({
      message:
        'This dev runtime does not record its web URL. Pass --base-url with its current web origin, or restart the server.',
    })
  }
  const displayUrl =
    options.baseUrl?.toString() ??
    target.state.devUrl ??
    resolveHeadlessConnectionString(target.state.host, target.state.port)
  const baseUrl = yield* decodeUrl(displayUrl).pipe(
    Effect.mapError(
      () =>
        new PairCommandError({
          message:
            'The pairing web URL is invalid. Pass --base-url with its current HTTP(S) origin.',
        }),
    ),
  )
  if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password)
  {
    return yield* new PairCommandError({
      message: 'The pairing web URL must use HTTP(S) without embedded credentials.',
    })
  }
  yield* assertTargetUnchanged(target)
  const issued = yield* HttpClientRequest.post(`${target.origin}/api/auth/pairing-token`).pipe(
    HttpClientRequest.setHeader(
      EnvironmentStorageOwnerTokenHeaderName,
      target.state.storageLeaseToken!,
    ),
    HttpClientRequest.bodyJsonUnsafe({
      scopes: AuthStandardClientScopes,
      label: options.label ?? '456code pair',
    }),
    client.execute,
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(AuthPairingCredentialResult)),
    Effect.timeout(PROBE_TIMEOUT),
    Effect.mapError(
      () =>
        new PairCommandError({
          message:
            'The local server rejected pairing issuance. Verify that it supports local-owner pairing, then retry.',
        }),
    ),
  )
  return formatPairOutput({ label: descriptor.label, baseUrl: baseUrl.toString(), issued })
})

export const pairHttpClientLayer = FetchHttpClient.layer.pipe(
  Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { redirect: 'error' })),
)

export const pairCommand = Command.make('pair', {
  baseDir: baseDirFlag,
  baseUrl: Flag.string('base-url').pipe(
    Flag.withSchema(Schema.URLFromString),
    Flag.withDescription(
      'Existing web origin for the printed pairing URL; never used for credential issuance.',
    ),
    Flag.optional,
  ),
  label: Flag.string('label').pipe(
    Flag.withDescription('Label for the new pairing credential.'),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription('Pair with a verified running local server and print a QR code.'),
  Command.withHandler((flags) =>
    runPairCommand({
      ...(Option.isSome(flags.baseDir) ? { baseDir: flags.baseDir.value } : {}),
      ...(Option.isSome(flags.baseUrl) ? { baseUrl: flags.baseUrl.value } : {}),
      ...(Option.isSome(flags.label) ? { label: flags.label.value } : {}),
    }).pipe(Effect.flatMap(Console.log), Effect.provide(pairHttpClientLayer)),
  ),
)
