// apps/server/src/provider/antigravityAuthSupport.ts
// isolate personal Google OAuth profiles and intercept native auth URLs

// @effect-diagnostics nodeBuiltinImport:off - these helpers need synchronous hashing and path handling.
import * as NodeCrypto from 'node:crypto'
import * as NodeFSP from 'node:fs/promises'
import * as NodePath from 'node:path'

import type { ProviderInstanceId } from '@t3tools/contracts'
import { HostProcessExecutablePath, HostProcessPlatform } from '@t3tools/shared/hostProcess'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import type * as PlatformError from 'effect/PlatformError'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import * as ChildProcess from 'effect/unstable/process/ChildProcess'
import * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner'
import * as AcpErrors from 'effect-acp/errors'

import { collectUint8StreamText } from '../stream/collectUint8StreamText.ts'
import type { AcpSpawnInput } from './acp/AcpSessionRuntime.ts'
import {
  antigravityUserSkillDirectories,
  resolveAntigravityUserHome,
} from './Drivers/AntigravitySkills.ts'

export const ANTIGRAVITY_AUTH_STDOUT_PREFIX =
  'Open the following link to authenticate the ACP server: '
export const ANTIGRAVITY_AUTH_BROWSER_MARKER = '__456CODE_ANTIGRAVITY_AUTH_URL__'
export const ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE =
  'Sign in to Antigravity in Settings before you continue.'

const maxAuthorizationUrlLength = 16_384
const maxBrowserHelperLineLength =
  Math.max(ANTIGRAVITY_AUTH_BROWSER_MARKER.length, ANTIGRAVITY_AUTH_STDOUT_PREFIX.length) +
  maxAuthorizationUrlLength +
  2
const maxStdoutLineBytes = 16 * 1024 * 1024
const authPrefixBytes = new TextEncoder().encode(ANTIGRAVITY_AUTH_STDOUT_PREFIX)
const decodeUrl = Schema.decodeUnknownEffect(Schema.URLFromString)
const decodeBrowserHelperUrl = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.String))
const ProfileSettingsFile = Schema.Struct({
  auth: Schema.Struct({ type: Schema.Literal('oauth-personal') }),
})
const encodeProfileSettings = Schema.encodeSync(Schema.fromJsonString(ProfileSettingsFile))
const isAcpRequestError = Schema.is(AcpErrors.AcpRequestError)
const isAcpTransportError = Schema.is(AcpErrors.AcpTransportError)

// python splits BROWSER on the host path separator before parsing quotes.
// this source contains neither separator and exits successfully on EPIPE so no OS browser fallback runs.
const browserHelperSource =
  `process.stderr.on("error",()=>process.exit(0)).write(` +
  `"${ANTIGRAVITY_AUTH_BROWSER_MARKER}"+JSON.stringify(process.argv[1])+"\\n",` +
  `()=>process.exit(0))`
const browserPreflightUrl = 'https://example.invalid/456code-antigravity-browser-preflight'

const removedEnvironmentKeys = new Set([
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_CLOUD_QUOTA_PROJECT',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GCLOUD_PROJECT',
  'CLOUDSDK_CORE_PROJECT',
  'AGY_ACP_CCPA_PROJECT',
  'AGY_ACP_ENABLE_OAUTH',
  'GEMINI_HOME',
  'AGY_ACP_FORCE_FILE_STORAGE',
  'ANTIGRAVITY_HARNESS_PATH',
  'BROWSER',
  'PYTHONUNBUFFERED',
  'ELECTRON_RUN_AS_NODE',
])

/** A private filesystem profile and verified browser interception command. */
export interface AntigravityProfile
{
  readonly platform: NodeJS.Platform
  readonly geminiHome: string
  readonly acpDirectory: string
  readonly tokenPath: string
  readonly browserCommand: string
}

/** The validated public portion of one personal OAuth request. */
export interface AntigravityAuthorizationUrl
{
  readonly authorizationUrl: string
  readonly redirectUri: string
  readonly state: string
}

function authSupportError(detail: string): AcpErrors.AcpTransportError
{
  return new AcpErrors.AcpTransportError({ detail, cause: undefined })
}

export function isAntigravitySignInRequiredError(error: unknown): boolean
{
  return (
    (isAcpRequestError(error) && error.code === -32000) ||
    (isAcpTransportError(error) && error.detail === ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE)
  )
}

// raw instance IDs are hashed so case-sensitive IDs stay distinct on every filesystem.
export function resolveAntigravityProfileDirectory(
  stateDir: string,
  instanceId: ProviderInstanceId,
): string
{
  const directoryName = NodeCrypto.createHash('sha256').update(instanceId).digest('hex')
  return NodePath.join(stateDir, 'providers', 'antigravity', directoryName)
}

function quoteBrowserArgument(value: string): string
{
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function antigravityEnvironment(
  profile: AntigravityProfile,
  baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv
{
  const environment: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(baseEnv))
  {
    // windows treats keys as case-insensitive, so scrub aliases on every platform.
    if (!removedEnvironmentKeys.has(key.toUpperCase()))
    {
      environment[key] = value
    }
  }
  return {
    ...environment,
    GEMINI_HOME: profile.geminiHome,
    AGY_ACP_FORCE_FILE_STORAGE: '1',
    BROWSER: profile.browserCommand,
    PYTHONUNBUFFERED: '1',
    ELECTRON_RUN_AS_NODE: '1',
  }
}

export function antigravityProfileSettings(): string
{
  return `${encodeProfileSettings({ auth: { type: 'oauth-personal' } })}\n`
}

// link only the two native user-skill roots back to ~/.gemini; credentials and config stay private
const linkAntigravityUserSkills = Effect.fn('linkAntigravityUserSkills')(function* (input: {
  readonly profileDirectory: string
  readonly userHome: string
  readonly platform: NodeJS.Platform
}): Effect.fn.Return<void, never, FileSystem.FileSystem | Path.Path>
{
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const links = antigravityUserSkillDirectories(path, input.profileDirectory)
  const targets = antigravityUserSkillDirectories(path, path.join(input.userHome, '.gemini'))
  for (const [link, target] of [
    [links[0], targets[0]],
    [links[1], targets[1]],
  ] as const)
  {
    yield* Effect.gen(function* ()
    {
      const existing = yield* fs.readLink(link).pipe(
        Effect.map((value): string | undefined => path.resolve(path.dirname(link), value)),
        Effect.catch((error) =>
          error.reason._tag === 'NotFound' ? Effect.succeed(undefined) : Effect.fail(error),
        ),
      )
      if (existing === target) return
      if (existing !== undefined)
      {
        yield* fs.remove(link)
      }
      yield* fs.makeDirectory(path.dirname(link), { recursive: true })
      yield* Effect.tryPromise(() =>
        NodeFSP.symlink(target, link, input.platform === 'win32' ? 'junction' : 'dir'),
      )
    }).pipe(
      // any refusal leaves the isolated profile usable and never replaces real content
      Effect.catch((error) =>
        Effect.logWarning('Antigravity user skills are not linked into the profile.', {
          link,
          target,
          error,
        }),
      ),
    )
  }
})

// prepare an isolated profile without reading or copying Google credentials.
export const prepareAntigravityProfile = Effect.fn('prepareAntigravityProfile')(function* (input: {
  readonly profileDirectory: string
  readonly baseEnv?: NodeJS.ProcessEnv
  readonly runtimeExecutablePath?: string
  readonly platform?: NodeJS.Platform
  readonly userHome?: string
})
{
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const platform = input.platform ?? (yield* HostProcessPlatform)
  const userHome =
    input.userHome ?? resolveAntigravityUserHome(platform, input.baseEnv ?? process.env)
  const runtimeExecutablePath = input.runtimeExecutablePath ?? (yield* HostProcessExecutablePath)
  const helperExecutable =
    platform === 'win32' ? runtimeExecutablePath.replaceAll('\\', '/') : runtimeExecutablePath
  const browserArguments = [helperExecutable, '-e', browserHelperSource, '--', '%s']
  const browserCommand = browserArguments.map(quoteBrowserArgument).join(' ')
  if (
    browserCommand.includes(platform === 'win32' ? ';' : ':') ||
    helperExecutable.includes('\r') ||
    helperExecutable.includes('\n') ||
    helperExecutable.includes('\0') ||
    helperExecutable.includes('%s')
  )
  {
    return yield* authSupportError(
      'The 456code runtime path cannot safely suppress Antigravity browser launches.',
    )
  }

  const geminiHome = path.resolve(input.profileDirectory)
  const acpDirectory = path.join(geminiHome, 'antigravity-acp')
  const profile: AntigravityProfile = {
    platform,
    geminiHome,
    acpDirectory,
    tokenPath: path.join(acpDirectory, 'acp_token.json'),
    browserCommand,
  }
  const environment = antigravityEnvironment(profile, input.baseEnv ?? process.env)

  yield* Effect.gen(function* ()
  {
    const child = yield* spawner.spawn(
      ChildProcess.make(helperExecutable, ['-e', browserHelperSource, '--', browserPreflightUrl], {
        env: environment,
        extendEnv: false,
        shell: false,
      }),
    )
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectUint8StreamText({ stream: child.stdout, maxBytes: 4_096 }),
        collectUint8StreamText({ stream: child.stderr, maxBytes: 4_096 }),
        child.exitCode,
      ],
      { concurrency: 'unbounded' },
    )
    if (
      Number(exitCode) !== 0 ||
      stdout.bytes !== 0 ||
      stdout.truncated ||
      stderr.truncated ||
      stderr.text !== `${ANTIGRAVITY_AUTH_BROWSER_MARKER}"${browserPreflightUrl}"\n`
    )
    {
      return yield* authSupportError('Antigravity browser suppression could not be verified.')
    }
  }).pipe(
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: '5 seconds',
      orElse: () =>
        Effect.fail(authSupportError('Antigravity browser suppression verification timed out.')),
    }),
    Effect.mapError((error) =>
      error._tag === 'AcpTransportError'
        ? error
        : authSupportError('Antigravity browser suppression could not be verified.'),
    ),
  )

  for (const directory of [geminiHome, acpDirectory])
  {
    yield* fs
      .makeDirectory(directory, { recursive: true, mode: 0o700 })
      .pipe(
        Effect.mapError(() =>
          authSupportError('The Antigravity profile directory could not be created.'),
        ),
      )
    if (platform !== 'win32')
    {
      yield* fs
        .chmod(directory, 0o700)
        .pipe(
          Effect.mapError(() =>
            authSupportError('The Antigravity profile directory permissions could not be set.'),
          ),
        )
    }
  }

  const settingsPath = path.join(acpDirectory, 'settings.json')
  yield* fs
    .writeFileString(settingsPath, antigravityProfileSettings(), { mode: 0o600 })
    .pipe(
      Effect.mapError(() =>
        authSupportError('The Antigravity profile settings could not be written.'),
      ),
    )
  if (platform !== 'win32')
  {
    yield* fs
      .chmod(settingsPath, 0o600)
      .pipe(
        Effect.mapError(() =>
          authSupportError('The Antigravity profile settings permissions could not be set.'),
        ),
      )
  }
  yield* linkAntigravityUserSkills({ profileDirectory: geminiHome, userHome, platform })
  return profile
})

export function buildAntigravityAcpSpawnInput(input: {
  readonly installation: {
    readonly executablePath: string
    readonly harnessPath: string
  }
  readonly profile: AntigravityProfile
  readonly cwd: string
  readonly baseEnv?: NodeJS.ProcessEnv
}): AcpSpawnInput
{
  return {
    command: input.installation.executablePath,
    args: input.profile.platform === 'linux' ? ['--uid='] : [],
    cwd: input.cwd,
    env: {
      ...antigravityEnvironment(input.profile, input.baseEnv ?? process.env),
      ANTIGRAVITY_HARNESS_PATH: input.installation.harnessPath,
    },
    extendEnv: false,
  }
}

// parse only the public authorization request and never inspect the token file.
export const parseAntigravityAuthorizationUrl = Effect.fn('parseAntigravityAuthorizationUrl')(
  function* (
    authorizationUrl: string,
  ): Effect.fn.Return<AntigravityAuthorizationUrl, AcpErrors.AcpError>
  {
    const invalidUrl = () => authSupportError('Antigravity returned an invalid Google sign-in URL.')
    if (authorizationUrl.length > maxAuthorizationUrlLength || /\s/.test(authorizationUrl))
    {
      return yield* invalidUrl()
    }
    const url = yield* decodeUrl(authorizationUrl).pipe(Effect.mapError(invalidUrl))
    const state = url.searchParams.get('state')
    const redirectUri = url.searchParams.get('redirect_uri')
    if (
      url.origin !== 'https://accounts.google.com' ||
      url.pathname !== '/o/oauth2/v2/auth' ||
      url.username !== '' ||
      url.password !== '' ||
      url.hash !== '' ||
      url.searchParams.getAll('state').length !== 1 ||
      url.searchParams.getAll('redirect_uri').length !== 1 ||
      url.searchParams.getAll('response_type').length !== 1 ||
      url.searchParams.get('response_type') !== 'code' ||
      state === null ||
      state.length === 0 ||
      state.length > 512 ||
      /\s/.test(state) ||
      redirectUri === null ||
      !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/$/.test(redirectUri)
    )
    {
      return yield* invalidUrl()
    }
    const redirect = yield* decodeUrl(redirectUri).pipe(Effect.mapError(invalidUrl))
    const port = Number(redirect.port)
    if (!Number.isSafeInteger(port) || port < 1_024 || port > 65_535)
    {
      return yield* invalidUrl()
    }
    return { authorizationUrl, redirectUri, state }
  },
)

export function makeAntigravityStdoutTransform(
  input: {
    readonly onAuthorizationUrl?: (
      authorizationUrl: string,
    ) => Effect.Effect<void, AcpErrors.AcpError>
  } = {},
)
{
  const handleLine = Effect.fn('antigravityAuthSupport.handleStdoutLine')(function* (
    line: Uint8Array,
  )
  {
    if (!authPrefixBytes.every((byte, index) => line[index] === byte))
    {
      return [line]
    }
    const message = new TextDecoder().decode(line).replace(/\r?\n$/, '')
    const request = yield* parseAntigravityAuthorizationUrl(
      message.slice(ANTIGRAVITY_AUTH_STDOUT_PREFIX.length),
    )
    if (!input.onAuthorizationUrl)
    {
      return yield* authSupportError(ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE)
    }
    yield* input.onAuthorizationUrl(request.authorizationUrl)
    return []
  })

  return (
    stdout: ChildProcessSpawner.ChildProcessHandle['stdout'],
  ): Stream.Stream<Uint8Array, PlatformError.PlatformError | AcpErrors.AcpError> =>
    Stream.suspend(() =>
    {
      let pending: Array<Uint8Array> = []
      let pendingBytes = 0
      const finishLine = () =>
      {
        const line = Buffer.concat(pending, pendingBytes)
        pending = []
        pendingBytes = 0
        return line
      }
      return stdout.pipe(
        Stream.mapEffect(
          Effect.fn('antigravityAuthSupport.splitStdoutLines')(function* (chunk: Uint8Array)
          {
            const lines: Array<Uint8Array> = []
            let offset = 0
            while (offset < chunk.byteLength)
            {
              const newline = chunk.indexOf(10, offset)
              const end = newline === -1 ? chunk.byteLength : newline + 1
              const part = chunk.subarray(offset, end)
              if (pendingBytes + part.byteLength > maxStdoutLineBytes)
              {
                return yield* authSupportError(
                  'Antigravity sent a protocol line that is too large.',
                )
              }
              pending.push(part)
              pendingBytes += part.byteLength
              if (newline !== -1)
              {
                lines.push(finishLine())
              }
              offset = end
            }
            return lines
          }),
        ),
        Stream.flatMap(Stream.fromIterable),
        Stream.concat(
          Stream.suspend(() => (pendingBytes > 0 ? Stream.succeed(finishLine()) : Stream.empty)),
        ),
        Stream.mapEffect(handleLine),
        Stream.flatMap(Stream.fromIterable),
      )
    })
}

// consume all native stderr so authorization URLs and fragments never reach logs.
export function makeAntigravityStderrHandler(
  input: {
    readonly onAuthorizationUrl?: (
      authorizationUrl: string,
    ) => Effect.Effect<void, AcpErrors.AcpError>
  } = {},
)
{
  let pending = ''
  const handleLine = (line: string) =>
  {
    const message = line.endsWith('\r') ? line.slice(0, -1) : line
    if (message.length > maxBrowserHelperLineLength)
    {
      return Effect.void
    }
    const url = message.startsWith(ANTIGRAVITY_AUTH_STDOUT_PREFIX)
      ? Effect.succeed(message.slice(ANTIGRAVITY_AUTH_STDOUT_PREFIX.length))
      : message.startsWith(ANTIGRAVITY_AUTH_BROWSER_MARKER)
        ? decodeBrowserHelperUrl(message.slice(ANTIGRAVITY_AUTH_BROWSER_MARKER.length))
        : undefined
    if (url === undefined)
    {
      return Effect.void
    }
    return url.pipe(
      Effect.flatMap(parseAntigravityAuthorizationUrl),
      Effect.matchEffect({
        onFailure: () => Effect.void,
        onSuccess: (request) =>
          input.onAuthorizationUrl
            ? input.onAuthorizationUrl(request.authorizationUrl)
            : Effect.fail(authSupportError(ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE)),
      }),
    )
  }

  return Effect.fn('antigravityAuthSupport.handleStderr')(function* (text: string)
  {
    const lines = `${pending}${text}`.split('\n')
    pending = lines.pop() ?? ''
    if (pending.length > maxBrowserHelperLineLength)
    {
      pending = ''
    }
    yield* Effect.forEach(lines, handleLine, { discard: true })
  })
}
