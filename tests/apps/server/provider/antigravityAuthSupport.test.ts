// tests/apps/server/provider/antigravityAuthSupport.test.ts
// verify personal OAuth profile isolation and private authorization URL interception

// @effect-diagnostics nodeBuiltinImport:off - the EPIPE regression runs the captured helper directly.
import * as NodeChildProcess from 'node:child_process'

import * as NodeServices from '@effect/platform-node/NodeServices'
import { describe, expect, it } from '@effect/vitest'
import { ProviderInstanceId } from '@t3tools/contracts'
import { HostProcessPlatform } from '@t3tools/shared/hostProcess'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import * as ChildProcess from 'effect/unstable/process/ChildProcess'
import * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner'

import {
  ANTIGRAVITY_AUTH_BROWSER_MARKER,
  ANTIGRAVITY_AUTH_STDOUT_PREFIX,
  ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE,
  type AntigravityProfile,
  antigravityProfileSettings,
  buildAntigravityAcpSpawnInput,
  makeAntigravityStderrHandler,
  makeAntigravityStdoutTransform,
  parseAntigravityAuthorizationUrl,
  prepareAntigravityProfile,
  resolveAntigravityProfileDirectory,
} from '../../../../apps/server/src/provider/antigravityAuthSupport.ts'

const authorizationUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?response_type=code' +
  '&client_id=test-client&redirect_uri=http%3A%2F%2F127.0.0.1%3A46353%2F' +
  '&state=test-opaque-state&code_challenge=test-challenge&code_challenge_method=S256'
const authLine = `${ANTIGRAVITY_AUTH_STDOUT_PREFIX}${authorizationUrl}\n`
const encode = (text: string) => new TextEncoder().encode(text)
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown))
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

describe('antigravityAuthSupport process environment', () =>
{
  const profile: AntigravityProfile = {
    platform: 'linux',
    geminiHome: '/456code/userdata/providers/antigravity/profile',
    acpDirectory: '/456code/userdata/providers/antigravity/profile/antigravity-acp',
    tokenPath: '/456code/userdata/providers/antigravity/profile/antigravity-acp/acp_token.json',
    browserCommand: 'verified-browser-helper',
  }

  it('scrubs inherited auth state and launches only the exact executable and harness pair', () =>
  {
    const baseEnv = {
      HOME: '/home/developer',
      PATH: '/usr/bin',
      GEMINI_API_KEY: 'do-not-use-api-billing',
      google_api_key: 'case-insensitive-key',
      GOOGLE_APPLICATION_CREDENTIALS: '/credentials.json',
      GOOGLE_CLOUD_PROJECT: 'do-not-use-project',
      GOOGLE_CLOUD_LOCATION: 'do-not-use-location',
      GOOGLE_CLOUD_QUOTA_PROJECT: 'do-not-use-quota',
      GOOGLE_GENAI_USE_VERTEXAI: 'true',
      GCLOUD_PROJECT: 'do-not-use-gcloud-project',
      CLOUDSDK_CORE_PROJECT: 'do-not-use-cloud-sdk-project',
      AGY_ACP_CCPA_PROJECT: 'do-not-use-consumer-project',
      AGY_ACP_ENABLE_OAUTH: '0',
      GEMINI_HOME: '/shared-home',
      AGY_ACP_FORCE_FILE_STORAGE: '0',
      ANTIGRAVITY_HARNESS_PATH: '/wrong/harness',
      BROWSER: 'open-real-browser',
      PYTHONUNBUFFERED: '0',
      ELECTRON_RUN_AS_NODE: '0',
      CUSTOM_SETTING: 'keep-this',
    }
    const original = { ...baseEnv }
    const spawn = buildAntigravityAcpSpawnInput({
      installation: { executablePath: '/release/acp', harnessPath: '/release/harness' },
      profile,
      cwd: '/project',
      baseEnv,
    })

    expect(baseEnv).toEqual(original)
    expect(spawn).toEqual({
      command: '/release/acp',
      args: ['--uid='],
      cwd: '/project',
      extendEnv: false,
      env: {
        HOME: '/home/developer',
        PATH: '/usr/bin',
        CUSTOM_SETTING: 'keep-this',
        GEMINI_HOME: profile.geminiHome,
        AGY_ACP_FORCE_FILE_STORAGE: '1',
        ANTIGRAVITY_HARNESS_PATH: '/release/harness',
        BROWSER: profile.browserCommand,
        PYTHONUNBUFFERED: '1',
        ELECTRON_RUN_AS_NODE: '1',
      },
    })
    expect(decodeJson(antigravityProfileSettings())).toEqual({
      auth: { type: 'oauth-personal' },
    })
  })

  it('hashes raw instance IDs into stable case-preserving isolation boundaries', () =>
  {
    const lower = resolveAntigravityProfileDirectory(
      '/userdata',
      ProviderInstanceId.make('antigravity'),
    )
    const upper = resolveAntigravityProfileDirectory(
      '/userdata',
      ProviderInstanceId.make('Antigravity'),
    )
    expect(lower.toLowerCase()).not.toBe(upper.toLowerCase())
    expect(
      resolveAntigravityProfileDirectory('/userdata', ProviderInstanceId.make('antigravity')),
    ).toBe(lower)
  })
})

describe('antigravityAuthSupport authorization URL', () =>
{
  it.effect('accepts only the official Google flow and its owned loopback target', () =>
    Effect.gen(function* ()
    {
      expect(yield* parseAntigravityAuthorizationUrl(authorizationUrl)).toEqual({
        authorizationUrl,
        redirectUri: 'http://127.0.0.1:46353/',
        state: 'test-opaque-state',
      })

      const invalidUrls = [
        authorizationUrl.replace('https:', 'http:'),
        authorizationUrl.replace('accounts.google.com', 'accounts.google.com.example.invalid'),
        authorizationUrl.replace('accounts.google.com', 'secret@accounts.google.com'),
        authorizationUrl.replace('/o/oauth2/v2/auth', '/another-path'),
        `${authorizationUrl}#secret-fragment`,
        `${authorizationUrl}&state=another-state`,
        authorizationUrl.replace('test-opaque-state', ''),
        authorizationUrl.replace('test-opaque-state', 'opaque%0astate'),
        authorizationUrl.replace('127.0.0.1', 'localhost'),
        authorizationUrl.replace('127.0.0.1', '169.254.169.254'),
        authorizationUrl.replace('46353', '80'),
        authorizationUrl.replace('46353', '70000'),
        authorizationUrl.replace('46353%2F', '46353%2Fother'),
        authorizationUrl.replace('response_type=code', 'response_type=token'),
        'not a URL containing secret-code',
      ]
      for (const invalidUrl of invalidUrls)
      {
        const result = yield* parseAntigravityAuthorizationUrl(invalidUrl).pipe(Effect.result)
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isSuccess(result))
        {
          continue
        }
        const encoded = encodeUnknownJson(result.failure)
        expect(encoded).not.toContain('test-opaque-state')
        expect(encoded).not.toContain('secret-code')
        expect(encoded).not.toContain(invalidUrl)
      }
    }),
  )
})

describe('antigravityAuthSupport native URL interception', () =>
{
  it.effect('removes fragmented auth lines from stdout without changing protocol bytes', () =>
    Effect.gen(function* ()
    {
      const urls: Array<string> = []
      const jsonBefore = '{"jsonrpc":"2.0","id":1,"result":{}}\r\n'
      const jsonAfter = '{"jsonrpc":"2.0","id":2,"result":{"text":"café"}}\n'
      const chunks = [
        encode(`${jsonBefore}${ANTIGRAVITY_AUTH_STDOUT_PREFIX.slice(0, 7)}`),
        encode(ANTIGRAVITY_AUTH_STDOUT_PREFIX.slice(7)),
        encode(authorizationUrl.slice(0, 40)),
        encode(`${authorizationUrl.slice(40)}\r`),
        encode(`\n${jsonAfter}`),
      ]
      const result = yield* makeAntigravityStdoutTransform({
        onAuthorizationUrl: (url) => Effect.sync(() => void urls.push(url)),
      })(Stream.fromIterable(chunks)).pipe(Stream.decodeText(), Stream.mkString)
      expect(result).toBe(`${jsonBefore}${jsonAfter}`)
      expect(urls).toEqual([authorizationUrl])
    }),
  )

  it.effect('returns only a redacted sign-in-required failure when no flow owns stdout', () =>
    Effect.gen(function* ()
    {
      const result = yield* makeAntigravityStdoutTransform()(Stream.make(encode(authLine))).pipe(
        Stream.runDrain,
        Effect.result,
      )
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isSuccess(result))
      {
        return
      }
      expect(result.failure).toMatchObject({
        _tag: 'AcpTransportError',
        detail: ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE,
      })
      expect(encodeUnknownJson(result.failure)).not.toContain(authorizationUrl)
      expect(encodeUnknownJson(result.failure)).not.toContain('test-opaque-state')
    }),
  )

  it.effect('intercepts both 1.1.1 native stderr and verified browser-helper URLs', () =>
    Effect.gen(function* ()
    {
      const urls: Array<string> = []
      const nativeLine = `${ANTIGRAVITY_AUTH_STDOUT_PREFIX}${authorizationUrl}\r\n`
      const helperLine = `${ANTIGRAVITY_AUTH_BROWSER_MARKER}${encodeUnknownJson(authorizationUrl)}\n`
      const handleStderr = makeAntigravityStderrHandler({
        onAuthorizationUrl: (url) => Effect.sync(() => void urls.push(url)),
      })
      yield* handleStderr(`unlogged native text\n${nativeLine.slice(0, 40)}`)
      yield* handleStderr(`${nativeLine.slice(40)}${helperLine.slice(0, 29)}`)
      yield* handleStderr(`${helperLine.slice(29)}more unlogged text\n`)
      yield* handleStderr(
        `${ANTIGRAVITY_AUTH_BROWSER_MARKER}${encodeUnknownJson('https://example.com')}\n`,
      )
      expect(urls).toEqual([authorizationUrl, authorizationUrl])
    }),
  )
})

it.layer(NodeServices.layer)('antigravityAuthSupport profile preparation', (it) =>
{
  it.effect('preflights the browser helper and preserves only a private personal profile', () =>
    Effect.gen(function* ()
    {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const temporaryDirectory = yield* fs.makeTempDirectoryScoped()
      const userHome = path.join(temporaryDirectory, 'user-home')
      const userSkillDirectories = [
        path.join(userHome, '.gemini', 'config', 'skills'),
        path.join(userHome, '.gemini', 'antigravity-cli', 'skills'),
      ] as const
      for (const directory of userSkillDirectories)
      {
        yield* fs.makeDirectory(directory, { recursive: true })
      }
      const profile = yield* prepareAntigravityProfile({
        profileDirectory: path.join(temporaryDirectory, 'profile'),
        userHome,
        baseEnv: {
          PATH: process.env.PATH,
          GOOGLE_API_KEY: 'ambient-secret',
          BROWSER: 'open-real-browser',
        },
      })

      expect(yield* fs.exists(profile.acpDirectory)).toBe(true)
      expect(yield* fs.exists(profile.tokenPath)).toBe(false)
      expect(
        decodeJson(yield* fs.readFileString(path.join(profile.acpDirectory, 'settings.json'))),
      ).toEqual({ auth: { type: 'oauth-personal' } })
      expect(yield* fs.realPath(path.join(profile.geminiHome, 'config', 'skills'))).toBe(
        yield* fs.realPath(userSkillDirectories[0]),
      )
      expect(yield* fs.realPath(path.join(profile.geminiHome, 'antigravity-cli', 'skills'))).toBe(
        yield* fs.realPath(userSkillDirectories[1]),
      )
      if ((yield* HostProcessPlatform) !== 'win32')
      {
        expect((yield* fs.stat(profile.geminiHome)).mode & 0o777).toBe(0o700)
        expect((yield* fs.stat(profile.acpDirectory)).mode & 0o777).toBe(0o700)
        expect(
          (yield* fs.stat(path.join(profile.acpDirectory, 'settings.json'))).mode & 0o777,
        ).toBe(0o600)
      }

      yield* fs.writeFileString(profile.tokenPath, 'synthetic-token-fixture')
      yield* prepareAntigravityProfile({ profileDirectory: profile.geminiHome, userHome })
      expect(yield* fs.readFileString(profile.tokenPath)).toBe('synthetic-token-fixture')

      const preservedProfile = path.join(temporaryDirectory, 'preserved-profile')
      const preservedSkills = path.join(preservedProfile, 'config', 'skills')
      yield* fs.makeDirectory(preservedSkills, { recursive: true })
      yield* fs.writeFileString(path.join(preservedSkills, 'local-skill.md'), 'preserve me')
      yield* prepareAntigravityProfile({ profileDirectory: preservedProfile, userHome })
      expect(yield* fs.readFileString(path.join(preservedSkills, 'local-skill.md'))).toBe(
        'preserve me',
      )
    }),
  )

  it.effect('keeps the helper successful when cancellation closes stderr', () =>
    Effect.gen(function* ()
    {
      const fs = yield* FileSystem.FileSystem
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const temporaryDirectory = yield* fs.makeTempDirectoryScoped()
      let helperCommand: ChildProcess.StandardCommand | undefined
      yield* prepareAntigravityProfile({ profileDirectory: temporaryDirectory }).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) =>
          {
            if (ChildProcess.isStandardCommand(command))
            {
              helperCommand = command
            }
            return spawner.spawn(command)
          }),
        ),
      )
      if (!helperCommand)
      {
        return yield* Effect.die('Expected the browser preflight helper command.')
      }
      const command = helperCommand
      const child = yield* Effect.acquireRelease(
        Effect.sync(() =>
          NodeChildProcess.spawn(command.command, command.args, {
            env: { ...command.options.env },
            stdio: ['ignore', 'ignore', 'pipe'],
          }),
        ),
        (process) => Effect.sync(() => void process.kill()),
      )
      child.stderr?.destroy()
      const exitCode = yield* Effect.promise(
        () =>
          new Promise<number | null>((resolve, reject) =>
          {
            child.once('error', reject)
            child.once('exit', resolve)
          }),
      )
      expect(exitCode).toBe(0)
    }),
  )
})
