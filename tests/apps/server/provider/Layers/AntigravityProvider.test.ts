// tests/apps/server/provider/Layers/AntigravityProvider.test.ts
// verifies Antigravity degraded discovery and opaque model defaults

import * as NodeServices from '@effect/platform-node/NodeServices'
import { AntigravitySettings, ProviderDriverKind } from '@t3tools/contracts'
import { it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'
import { expect } from 'vite-plus/test'

import {
  buildInitialAntigravityProviderSnapshot,
  checkAntigravityProviderStatus,
  DEFAULT_ANTIGRAVITY_MODEL,
  validateAntigravityAgent,
} from '../../../../../apps/server/src/provider/Layers/AntigravityProvider.ts'
import { providerCapabilitiesForDriver } from '../../../../../apps/server/src/provider/providerCapabilities.ts'

const decodeSettings = Schema.decodeSync(AntigravitySettings)
const decodeStringArray = Schema.decodeUnknownSync(Schema.Array(Schema.String))

it.effect('is disabled by default and falls back to the app model alias', () =>
  Effect.gen(function* ()
  {
    const snapshot = yield* buildInitialAntigravityProviderSnapshot(decodeSettings({}))
    expect(DEFAULT_ANTIGRAVITY_MODEL).toBe('default')
    expect(snapshot.models.map((model) => model.slug)).toEqual(['default'])
    expect(snapshot.enabled).toBe(false)
    expect(snapshot.status).toBe('disabled')
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
