// tests/apps/server/provider/Layers/AntigravityProvider.test.ts
// verifies Antigravity discovery, opaque model defaults, and isolated account quotas

import * as NodeServices from '@effect/platform-node/NodeServices'
import {
  AntigravitySettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from '@t3tools/contracts'
import { it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'
import { TestClock } from 'effect/testing'
import { expect } from 'vite-plus/test'

import {
  buildInitialAntigravityProviderSnapshot,
  checkAntigravityProviderStatus,
  DEFAULT_ANTIGRAVITY_MODEL,
  enrichAntigravitySnapshot,
  validateAntigravityAgent,
} from '../../../../../apps/server/src/provider/Layers/AntigravityProvider.ts'
import { providerCapabilitiesForDriver } from '../../../../../apps/server/src/provider/providerCapabilities.ts'

const decodeSettings = Schema.decodeSync(AntigravitySettings)
const decodeStringArray = Schema.decodeUnknownSync(Schema.Array(Schema.String))

const makeQuotaProbe = Effect.fn('makeQuotaProbe')(function* ()
{
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: 'antigravity-quota-' })
  const binaryPath = path.join(root, 'agy-quota.mjs')
  const argsPath = path.join(root, 'args.log')
  yield* fileSystem.writeFileString(argsPath, '')
  yield* fileSystem.writeFileString(
    binaryPath,
    `#!/usr/bin/env node
import fs from 'node:fs'
process.stdin.resume()
process.stdin.once('end', () => {
  fs.appendFileSync(process.env.AGY_ARGS, JSON.stringify({ args: process.argv.slice(2), account: process.env.AGY_QUOTA_ACCOUNT }) + '\\n')
  if (process.env.AGY_QUOTA_MODE === 'auth-error') {
    process.stderr.write('Authentication required')
    process.exitCode = 1
    return
  }
  if (process.env.AGY_QUOTA_MODE === 'malformed') {
    process.stdout.write('{invalid json')
    return
  }
  if (process.env.AGY_QUOTA_MODE === 'hang') {
    setInterval(() => {}, 1000)
    return
  }
  process.stdout.write(JSON.stringify({
    status: 'SUCCESS',
    command: {
      name: 'usage',
      data: {
        groups: [{
          name: 'Quota group',
          buckets: [{ id: 'week', window: 'weekly', remaining_fraction: Number(process.env.AGY_QUOTA_FRACTION) }],
        }],
      },
    },
  }))
})
`,
  )
  yield* fileSystem.chmod(binaryPath, 0o755)
  const settings = decodeSettings({ enabled: true, binaryPath })
  const snapshot: ServerProvider = {
    ...(yield* buildInitialAntigravityProviderSnapshot(settings)),
    instanceId: ProviderInstanceId.make('antigravity-quota'),
    driver: ProviderDriverKind.make('antigravity'),
    version: '1.1.22',
    status: 'ready',
  }
  return {
    settings,
    snapshot,
    argsPath,
    environment: { PATH: process.env.PATH, AGY_ARGS: argsPath },
  }
})

it.effect('is disabled by default and falls back to the app model alias', () =>
  Effect.gen(function* ()
  {
    const snapshot = yield* buildInitialAntigravityProviderSnapshot(decodeSettings({}))
    expect(DEFAULT_ANTIGRAVITY_MODEL).toBe('default')
    expect(snapshot.models.map((model) => model.slug)).toEqual(['default'])
    expect(snapshot.enabled).toBe(false)
    expect(snapshot.status).toBe('disabled')
    expect(snapshot.accountUsage).toBeUndefined()
    const enabled = yield* buildInitialAntigravityProviderSnapshot(
      decodeSettings({ enabled: true }),
    )
    expect(enabled.accountUsage).toEqual({
      status: 'unavailable',
      message: 'Checking Antigravity account limits...',
    })
    expect(snapshot.capabilities?.supportedAttachmentTypes).toEqual([])
    expect(providerCapabilitiesForDriver(ProviderDriverKind.make('antigravity'))).toMatchObject({
      defaultRuntimeMode: 'auto-accept-edits',
      supportedRuntimeModes: ['auto-accept-edits', 'full-access'],
      runtimeModeWarnings: [
        {
          id: 'antigravity-full-access-v1',
          mode: 'full-access',
          requiresAcknowledgement: true,
        },
      ],
    })
  }),
)

it('rejects only agents absent from a conclusive inventory', () =>
{
  expect(validateAntigravityAgent('worker', ['worker', 'reviewer'])).toBe('worker')
  expect(validateAntigravityAgent('worker', [])).toBeUndefined()
  expect(validateAntigravityAgent('worker', undefined)).toBe('worker')
})

it.layer(NodeServices.layer)('Antigravity provider discovery', (it) =>
{
  it.effect('reads quotas with closed stdin and the configured instance environment', () =>
    Effect.gen(function* ()
    {
      const probe = yield* makeQuotaProbe()
      const published: Array<ServerProvider> = []
      yield* Effect.forEach(
        [
          { account: 'first', fraction: '0.25' },
          { account: 'second', fraction: '0.75' },
        ],
        ({ account, fraction }) =>
          enrichAntigravitySnapshot({
            ...probe,
            snapshot: { ...probe.snapshot, instanceId: ProviderInstanceId.make(account) },
            environment: {
              ...probe.environment,
              AGY_QUOTA_ACCOUNT: account,
              AGY_QUOTA_FRACTION: fraction,
            },
            publishSnapshot: (snapshot) =>
              Effect.sync(() =>
              {
                published.push(snapshot)
              }),
          }),
      )
      expect(
        published.map((snapshot) => ({
          instanceId: snapshot.instanceId,
          status: snapshot.status,
          usedPercent:
            snapshot.accountUsage?.status === 'available'
              ? snapshot.accountUsage.windows[0]?.usedPercent
              : undefined,
        })),
      ).toEqual([
        { instanceId: 'first', status: 'ready', usedPercent: 75 },
        { instanceId: 'second', status: 'ready', usedPercent: 25 },
      ])
      const fileSystem = yield* FileSystem.FileSystem
      const invocations = (yield* fileSystem.readFileString(probe.argsPath))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(invocations).toEqual([
        { args: ['--output-format', 'json', '-p', '/usage'], account: 'first' },
        { args: ['--output-format', 'json', '-p', '/usage'], account: 'second' },
      ])
    }),
  )

  it.effect(
    'replaces stale quota readings after auth or output failures without changing readiness',
    () =>
      Effect.gen(function* ()
      {
        const probe = yield* makeQuotaProbe()
        const snapshot: ServerProvider = {
          ...probe.snapshot,
          accountUsage: {
            status: 'available',
            observedAt: '2026-08-01T00:00:00.000Z',
            windows: [{ id: 'old', label: 'Week', usedPercent: 50, resetsAt: null }],
          },
        }
        for (const mode of ['auth-error', 'malformed'])
        {
          const published: Array<ServerProvider> = []
          yield* enrichAntigravitySnapshot({
            ...probe,
            snapshot,
            environment: { ...probe.environment, AGY_QUOTA_MODE: mode },
            publishSnapshot: (next) =>
              Effect.sync(() =>
              {
                published.push(next)
              }),
          })
          expect(published).toEqual([
            {
              ...snapshot,
              accountUsage: {
                status: 'unavailable',
                observedAt: expect.any(String),
                message: expect.stringContaining('temporarily unavailable'),
              },
            },
          ])
        }
      }),
  )

  it.effect(
    'times out a quota process after four seconds without changing provider readiness',
    () =>
      Effect.gen(function* ()
      {
        const probe = yield* makeQuotaProbe()
        const published: Array<ServerProvider> = []
        const fiber = yield* enrichAntigravitySnapshot({
          ...probe,
          environment: { ...probe.environment, AGY_QUOTA_MODE: 'hang' },
          publishSnapshot: (snapshot) =>
            Effect.sync(() =>
            {
              published.push(snapshot)
            }),
        }).pipe(Effect.forkChild)
        yield* TestClock.adjust('4 seconds')
        yield* Fiber.join(fiber)
        expect(published).toMatchObject([
          { status: 'ready', accountUsage: { status: 'unavailable' } },
        ])
      }),
  )

  it.effect('does not run quota commands for disabled or incompatible providers', () =>
    Effect.gen(function* ()
    {
      const probe = yield* makeQuotaProbe()
      for (const snapshot of [
        { ...probe.snapshot, enabled: false, status: 'disabled' as const },
        { ...probe.snapshot, version: '1.1.10', status: 'error' as const },
      ])
      {
        yield* enrichAntigravitySnapshot({ ...probe, snapshot, publishSnapshot: () => Effect.void })
      }
      const fileSystem = yield* FileSystem.FileSystem
      expect(yield* fileSystem.readFileString(probe.argsPath)).toBe('')
    }),
  )

  it.effect('keeps opaque models and a configured agent when agent discovery degrades', () =>
    Effect.gen(function* ()
    {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: 'antigravity-provider-' })
      const binaryPath = path.join(root, 'agy-mock.mjs')
      const argsPath = path.join(root, 'args.log')
      yield* fileSystem.writeFileString(argsPath, '')
      yield* fileSystem.writeFileString(
        binaryPath,
        `#!/usr/bin/env node
import fs from 'node:fs'

const args = process.argv.slice(2)
fs.appendFileSync(process.env.AGY_ARGS, JSON.stringify(args) + '\\n')
if (args[0] === '--version') process.stdout.write((process.env.AGY_VERSION ?? '1.1.19') + '\\n')
else if (args[0] === '--help') process.stdout.write('--input-format stream-json --output-format stream-json\\n')
else if (args.at(-1) === 'models') {
  process.stdin.resume()
  process.stdin.once('end', () => process.stdout.write(JSON.stringify({ command: { data: { models: [{ id: 'opaque-z' }] } } })))
}
else if (args.at(-1) === 'agents' && process.env.AGY_AGENT_MODE === 'empty') process.stdout.write(JSON.stringify({ command: { data: { agents: [] } } }))
else if (args.at(-1) === 'agents') process.exit(1)
`,
      )
      yield* fileSystem.chmod(binaryPath, 0o755)
      const settings = decodeSettings({
        enabled: true,
        binaryPath,
        agent: 'worker',
        customModels: ['custom-opaque'],
      })
      const environment = {
        ...process.env,
        AGY_ARGS: argsPath,
        AGY_AGENT_MODE: 'fail',
      }

      const degraded = yield* checkAntigravityProviderStatus(settings, environment)
      expect(degraded.status).toBe('warning')
      expect(degraded.accountUsage).toEqual({
        status: 'unavailable',
        message: 'Checking Antigravity account limits...',
      })
      expect(degraded.message).toContain('discovery was unavailable')
      expect(degraded.models.map((model) => model.slug)).toEqual([
        'default',
        'opaque-z',
        'custom-opaque',
      ])

      const conclusive = yield* checkAntigravityProviderStatus(settings, {
        ...environment,
        AGY_AGENT_MODE: 'empty',
      })
      expect(conclusive.status).toBe('error')
      expect(conclusive.message).toContain("agent 'worker' is unavailable")

      const invocations = (yield* fileSystem.readFileString(argsPath))
        .trim()
        .split('\n')
        .map((line) => decodeStringArray(JSON.parse(line)))
      expect(invocations).toContainEqual(['--output-format', 'json', 'models'])
      expect(invocations).toContainEqual(['--output-format', 'json', 'agents'])
    }),
  )

  it.effect('rejects a prerelease at the stable minimum version', () =>
    Effect.gen(function* ()
    {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: 'antigravity-prerelease-' })
      const binaryPath = path.join(root, 'agy-mock.mjs')
      yield* fileSystem.writeFileString(
        binaryPath,
        `#!/usr/bin/env node
if (process.argv[2] === '--version') process.stdout.write('1.1.15-beta\\n')
`,
      )
      yield* fileSystem.chmod(binaryPath, 0o755)
      const settings = decodeSettings({ enabled: true, binaryPath })
      const snapshot = yield* checkAntigravityProviderStatus(settings, {
        PATH: process.env.PATH ?? '',
      })
      expect(snapshot.status).toBe('error')
      expect(snapshot.version).toBe('1.1.15-beta')
    }),
  )
})
