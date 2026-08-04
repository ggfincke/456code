// tests/apps/server/provider/continuationIdentity.test.ts
// verifies provider continuation keys track exact sources without exposing secrets

import * as NodeServices from '@effect/platform-node/NodeServices'
import { describe, expect, it } from '@effect/vitest'
import { ProviderDriverKind, ProviderInstanceEnvironmentVariableName } from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'

import { buildCursorAcpSpawnInput } from '../../../../apps/server/src/provider/acp/CursorAcpSupport.ts'
import { buildGrokAcpSpawnInput } from '../../../../apps/server/src/provider/acp/GrokAcpSupport.ts'
import {
  acpContinuationEnvironment,
  acpContinuationIdentity,
  acpContinuationRouteIssue,
  canonicalFileContinuationIdentity,
  fileContinuationIdentity,
  normalizeAcpRuntimeEnvironment,
  normalizeOpenCodeRuntimeEnvironment,
  openCodeContinuationIdentity,
  resolveClaudeProjectsRoot,
  resolveAcpContinuationIdentity,
  resolveCodexSessionsRoot,
  resolveOpenCodeSessionsRoot,
} from '../../../../apps/server/src/provider/continuationIdentity.ts'

const CODEX = ProviderDriverKind.make('codex')
const CLAUDE = ProviderDriverKind.make('claudeAgent')
const CURSOR = ProviderDriverKind.make('cursor')
const GROK = ProviderDriverKind.make('grok')
const OPENCODE = ProviderDriverKind.make('opencode')

it.layer(NodeServices.layer)('provider continuation identity', (it) =>
{
  describe('file-backed sources', () =>
  {
    it.effect('changes each driver key when its canonical transcript root changes', () =>
      Effect.sync(() =>
      {
        const codexA = resolveCodexSessionsRoot(
          { homePath: '/accounts/a/.codex', shadowHomePath: '' },
          { environment: {}, cwd: '/' },
        )
        const codexB = resolveCodexSessionsRoot(
          { homePath: '/accounts/b/.codex', shadowHomePath: '' },
          { environment: {}, cwd: '/' },
        )
        const claudeA = resolveClaudeProjectsRoot(
          { homePath: '/accounts/a/.claude' },
          { environment: {}, cwd: '/' },
        )
        const claudeB = resolveClaudeProjectsRoot(
          { homePath: '/accounts/b/.claude' },
          { environment: {}, cwd: '/' },
        )
        const openCodeA = resolveOpenCodeSessionsRoot({
          environment: { XDG_DATA_HOME: '/accounts/a/data' },
        })
        const openCodeB = resolveOpenCodeSessionsRoot({
          environment: { XDG_DATA_HOME: '/accounts/b/data' },
        })

        expect(fileContinuationIdentity(CODEX, codexA)).not.toEqual(
          fileContinuationIdentity(CODEX, codexB),
        )
        expect(fileContinuationIdentity(CLAUDE, claudeA)).not.toEqual(
          fileContinuationIdentity(CLAUDE, claudeB),
        )
        expect(openCodeContinuationIdentity(OPENCODE, { serverUrl: '' }, openCodeA)).not.toEqual(
          openCodeContinuationIdentity(OPENCODE, { serverUrl: '' }, openCodeB),
        )
      }),
    )

    it.effect('re-resolves a live symlink before each route use', () =>
      Effect.gen(function* ()
      {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: 'provider-continuation-source-',
        })
        const firstTarget = path.join(root, 'first')
        const secondTarget = path.join(root, 'second')
        const activeRoot = path.join(root, 'active')
        yield* fileSystem.makeDirectory(firstTarget)
        yield* fileSystem.makeDirectory(secondTarget)
        yield* fileSystem.symlink(firstTarget, activeRoot)
        const resolveIdentity = canonicalFileContinuationIdentity(CODEX, activeRoot)

        const first = yield* resolveIdentity
        yield* fileSystem.remove(activeRoot)
        yield* fileSystem.symlink(secondTarget, activeRoot)
        const second = yield* resolveIdentity

        expect(first).not.toEqual(second)
        expect(first.continuationKey).not.toContain(firstTarget)
        expect(second.continuationKey).not.toContain(secondTarget)
      }),
    )

    it.effect('binds external OpenCode continuation to the canonical server boundary', () =>
      Effect.sync(() =>
      {
        const first = openCodeContinuationIdentity(
          OPENCODE,
          { serverUrl: 'HTTPS://Example.COM:443/api/?token=secret#fragment' },
          '',
        )
        const sameBoundary = openCodeContinuationIdentity(
          OPENCODE,
          { serverUrl: 'https://example.com/api' },
          '',
        )
        const otherBoundary = openCodeContinuationIdentity(
          OPENCODE,
          { serverUrl: 'https://example.com/other' },
          '',
        )

        expect(first).toEqual(sameBoundary)
        expect(first).not.toEqual(otherBoundary)
        expect(first.continuationKey).not.toContain('secret')
        expect(first.continuationKey).not.toContain('example.com')
      }),
    )

    it.effect('pins local OpenCode runtime data to the same absolute storage boundary', () =>
      Effect.gen(function* ()
      {
        const path = yield* Path.Path
        const cwd = '/server/workspace'
        const environment = {
          HOME: '.relative-home',
          XDG_DATA_HOME: '.relative-data',
        }
        const normalized = normalizeOpenCodeRuntimeEnvironment(environment, { cwd })

        expect(path.isAbsolute(normalized.XDG_DATA_HOME ?? '')).toBe(true)
        expect(normalized.XDG_DATA_HOME).toBe(path.join(cwd, '.relative-data'))
        expect(
          resolveOpenCodeSessionsRoot({
            environment: normalized,
            cwd,
          }),
        ).toBe(
          resolveOpenCodeSessionsRoot({
            environment,
            cwd,
          }),
        )
      }),
    )
  })

  describe('ACP sources', () =>
  {
    const explicitSecretName = ProviderInstanceEnvironmentVariableName.make('CUSTOM_ACCOUNT_TOKEN')
    const explicitSecretA = [
      { name: explicitSecretName, value: 'cursor-secret-a', sensitive: true },
    ]
    const explicitSecretB = [
      { name: explicitSecretName, value: 'cursor-secret-b', sensitive: true },
    ]

    const cursorIdentity = (
      endpoint: string,
      environment: NodeJS.ProcessEnv,
      explicitEnvironment = explicitSecretA,
      cwd = '/workspace/a',
    ) =>
    {
      const route = buildCursorAcpSpawnInput(
        {
          binaryPath: 'cursor-agent',
          apiEndpoint: endpoint,
        },
        cwd,
        environment,
      )
      return acpContinuationIdentity(CURSOR, {
        command: route.command,
        args: route.args,
        env: acpContinuationEnvironment(CURSOR, route.env ?? {}, explicitEnvironment),
      })
    }

    const grokIdentity = (environment: NodeJS.ProcessEnv, cwd = '/workspace/a') =>
    {
      const route = buildGrokAcpSpawnInput(
        {
          binaryPath: 'grok',
        },
        cwd,
        environment,
      )
      return acpContinuationIdentity(GROK, {
        command: route.command,
        args: route.args,
        env: acpContinuationEnvironment(GROK, route.env ?? {}, undefined),
      })
    }

    it.effect('frames route sections so args cannot collide with environment pairs', () =>
      Effect.sync(() =>
      {
        const argsOnly = acpContinuationIdentity(CURSOR, {
          command: 'cursor-agent',
          args: ['A', 'B', 'C'],
          env: {},
        })
        const argsAndEnvironment = acpContinuationIdentity(CURSOR, {
          command: 'cursor-agent',
          args: ['A'],
          env: { B: 'C' },
        })

        expect(argsOnly).not.toEqual(argsAndEnvironment)
      }),
    )

    it.effect('distinguishes bare commands and rejects cwd-sensitive executable routes', () =>
      Effect.sync(() =>
      {
        const bareRoute = {
          command: 'cursor-agent',
          args: ['acp'],
          env: { PATH: '/usr/bin:/bin' },
        } as const
        const relativeCommandRoute = {
          ...bareRoute,
          command: './cursor-agent',
        }
        const relativePathRoute = {
          ...bareRoute,
          env: { PATH: './tools:/usr/bin' },
        }

        expect(acpContinuationIdentity(CURSOR, bareRoute)).not.toEqual(
          acpContinuationIdentity(CURSOR, relativeCommandRoute),
        )
        expect(acpContinuationRouteIssue(bareRoute)).toBeNull()
        expect(acpContinuationRouteIssue(relativeCommandRoute)).toContain(
          'relative to each thread working directory',
        )
        expect(acpContinuationRouteIssue(relativePathRoute)).toContain('cwd-sensitive PATH entry')
        const normalizedRoute = {
          ...relativePathRoute,
          env: normalizeAcpRuntimeEnvironment(relativePathRoute.env, '/server/workspace'),
        }
        expect(normalizedRoute.env.PATH).toBe('/server/workspace/tools:/usr/bin')
        expect(acpContinuationRouteIssue(normalizedRoute)).toBeNull()
      }),
    )

    it.effect('canonicalizes Windows env keys and pins configured PATH entries', () =>
      Effect.sync(() =>
      {
        const normalized = normalizeAcpRuntimeEnvironment(
          {
            Path: 'relative-bin;C:\\Windows',
            pathext: '.COM;.EXE',
            custom_token: 'account-b',
          },
          'C:\\project',
          'win32',
        )

        expect(normalized).toEqual({
          CUSTOM_TOKEN: 'account-b',
          PATH: 'C:\\project\\relative-bin;C:\\Windows',
          PATHEXT: '.COM;.EXE',
        })
        expect(
          acpContinuationRouteIssue(
            {
              command: 'cursor-agent',
              args: ['acp'],
              env: normalized,
            },
            'win32',
          ),
        ).toBeNull()
        expect(
          acpContinuationRouteIssue(
            {
              command: 'cursor-agent',
              args: ['acp'],
              env: {
                home: '.account',
                Path: 'C:\\tools',
              },
            },
            'win32',
          ),
        ).toContain("ACP source selector 'HOME'")
      }),
    )

    it.effect('re-resolves ACP executable and source-selector symlinks', () =>
      Effect.gen(function* ()
      {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: 'acp-continuation-source-',
        })
        const firstTarget = path.join(root, 'first')
        const secondTarget = path.join(root, 'second')
        const activeHome = path.join(root, 'active-home')
        const firstCommand = path.join(root, 'cursor-agent-first')
        const secondCommand = path.join(root, 'cursor-agent-second')
        const activeCommand = path.join(root, 'cursor-agent')
        yield* fileSystem.makeDirectory(firstTarget)
        yield* fileSystem.makeDirectory(secondTarget)
        yield* fileSystem.writeFileString(firstCommand, 'first')
        yield* fileSystem.writeFileString(secondCommand, 'second')
        yield* fileSystem.symlink(firstTarget, activeHome)
        yield* fileSystem.symlink(firstCommand, activeCommand)
        const resolveIdentity = resolveAcpContinuationIdentity(CURSOR, {
          command: activeCommand,
          args: ['acp'],
          env: {
            HOME: activeHome,
            PATH: '/usr/bin:/bin',
          },
        })

        const first = yield* resolveIdentity
        yield* fileSystem.remove(activeHome)
        yield* fileSystem.remove(activeCommand)
        yield* fileSystem.symlink(secondTarget, activeHome)
        yield* fileSystem.symlink(secondCommand, activeCommand)
        const second = yield* resolveIdentity

        expect(first).not.toEqual(second)
        expect(first.continuationKey).not.toContain(firstTarget)
        expect(first.continuationKey).not.toContain(firstCommand)
        expect(second.continuationKey).not.toContain(secondTarget)
        expect(second.continuationKey).not.toContain(secondCommand)
      }),
    )

    it.effect('skips non-executable PATH entries when resolving a bare ACP command', () =>
      Effect.gen(function* ()
      {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: 'acp-path-resolution-',
        })
        const firstBin = path.join(root, 'first-bin')
        const secondBin = path.join(root, 'second-bin')
        const firstExecutable = path.join(root, 'first-executable')
        const secondExecutable = path.join(root, 'second-executable')
        const activeExecutable = path.join(secondBin, 'auditcmd')
        yield* fileSystem.makeDirectory(firstBin)
        yield* fileSystem.makeDirectory(secondBin)
        yield* fileSystem.writeFileString(path.join(firstBin, 'auditcmd'), 'not executable')
        yield* fileSystem.writeFileString(firstExecutable, '#!/bin/sh\n')
        yield* fileSystem.writeFileString(secondExecutable, '#!/bin/sh\n')
        yield* fileSystem.chmod(firstExecutable, 0o755)
        yield* fileSystem.chmod(secondExecutable, 0o755)
        yield* fileSystem.symlink(firstExecutable, activeExecutable)
        const resolveIdentity = resolveAcpContinuationIdentity(CURSOR, {
          command: 'auditcmd',
          args: ['acp'],
          env: { PATH: `${firstBin}:${secondBin}` },
        })

        const first = yield* resolveIdentity
        yield* fileSystem.remove(activeExecutable)
        yield* fileSystem.symlink(secondExecutable, activeExecutable)
        const second = yield* resolveIdentity

        expect(first).not.toEqual(second)
      }),
    )

    it.effect('re-resolves Grok auth-provider executables and rejects relative selectors', () =>
      Effect.gen(function* ()
      {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: 'grok-auth-provider-source-',
        })
        const firstExecutable = path.join(root, 'auth-first')
        const secondExecutable = path.join(root, 'auth-second')
        const activeExecutable = path.join(root, 'auth-provider')
        yield* fileSystem.writeFileString(firstExecutable, '#!/bin/sh\n')
        yield* fileSystem.writeFileString(secondExecutable, '#!/bin/sh\n')
        yield* fileSystem.chmod(firstExecutable, 0o755)
        yield* fileSystem.chmod(secondExecutable, 0o755)
        yield* fileSystem.symlink(firstExecutable, activeExecutable)
        const route = {
          command: '/usr/bin/true',
          args: ['agent', 'stdio'],
          env: {
            PATH: '/usr/bin:/bin',
            GROK_AUTH_PROVIDER_COMMAND: activeExecutable,
          },
        } as const
        const resolveIdentity = resolveAcpContinuationIdentity(GROK, route)

        const first = yield* resolveIdentity
        yield* fileSystem.remove(activeExecutable)
        yield* fileSystem.symlink(secondExecutable, activeExecutable)
        const second = yield* resolveIdentity

        expect(first).not.toEqual(second)
        expect(
          acpContinuationRouteIssue({
            ...route,
            env: {
              ...route.env,
              GROK_AUTH_PROVIDER_COMMAND: './auth-provider',
            },
          }),
        ).toContain('relative to each thread working directory')
        expect(
          acpContinuationRouteIssue({
            ...route,
            env: {
              ...route.env,
              GROK_AUTH_PROVIDER_COMMAND: `${activeExecutable} --tenant A`,
            },
          }),
        ).toContain('contains shell syntax or arguments')
      }),
    )

    it.effect('tracks Cursor route selectors but ignores incidental env and cwd', () =>
      Effect.sync(() =>
      {
        const baseEnvironment = {
          HOME: '/accounts/cursor',
          PATH: '/tools/a',
          CURSOR_API_KEY: 'cursor-api-secret',
          TERM_SESSION_ID: 'terminal-a',
          SHLVL: '1',
        }
        const first = cursorIdentity('https://cursor.example/a', baseEnvironment)
        const incidentalChange = cursorIdentity(
          'https://cursor.example/a',
          { ...baseEnvironment, TERM_SESSION_ID: 'terminal-b', SHLVL: '9' },
          explicitSecretA,
          '/workspace/b',
        )

        expect(first).toEqual(incidentalChange)
        expect(first).not.toEqual(cursorIdentity('https://cursor.example/b', baseEnvironment))
        expect(first).not.toEqual(
          cursorIdentity('https://cursor.example/a', {
            ...baseEnvironment,
            PATH: '/tools/b',
          }),
        )
        expect(first).not.toEqual(
          cursorIdentity('https://cursor.example/a', baseEnvironment, explicitSecretB),
        )
        expect(first.continuationKey).not.toContain('cursor-api-secret')
        expect(first.continuationKey).not.toContain('cursor-secret-a')
      }),
    )

    it.effect('tracks Grok account and executable selectors without exposing them', () =>
      Effect.sync(() =>
      {
        const baseEnvironment = {
          HOME: '/accounts/grok',
          PATH: '/tools/a',
          XAI_API_KEY: 'grok-api-secret-a',
          TMPDIR: '/tmp/one',
        }
        const first = grokIdentity(baseEnvironment)
        const incidentalChange = grokIdentity(
          { ...baseEnvironment, TMPDIR: '/tmp/two' },
          '/workspace/b',
        )

        expect(first).toEqual(incidentalChange)
        expect(first).not.toEqual(
          grokIdentity({ ...baseEnvironment, XAI_API_KEY: 'grok-api-secret-b' }),
        )
        expect(first).not.toEqual(grokIdentity({ ...baseEnvironment, PATH: '/tools/b' }))
        expect(first.continuationKey).not.toContain('grok-api-secret-a')
        expect(first.continuationKey).not.toContain('/tools/a')
      }),
    )
  })
})
