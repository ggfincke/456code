// tests/apps/server/provider/Layers/OpenCodeProvider.test.ts
// verify open code provider behavior

import * as NodeAssert from 'node:assert/strict'

import * as NodeServices from '@effect/platform-node/NodeServices'
import { it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { beforeEach } from 'vite-plus/test'

import { OpenCodeSettings } from '@t3tools/contracts'
import { ServerConfig } from '../../../../../apps/server/src/config.ts'
import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  type OpenCodeRuntimeShape,
} from '../../../../../apps/server/src/provider/opencodeRuntime.ts'
import { checkOpenCodeProviderStatus } from '../../../../../apps/server/src/provider/Layers/OpenCodeProvider.ts'
import { OpenCodeServerOwner } from '../../../../../apps/server/src/provider/OpenCodeServerOwner.ts'
import type { OpenCodeInventory } from '../../../../../apps/server/src/provider/opencodeRuntime.ts'
const decodeOpenCodeSettings = Schema.decodeSync(OpenCodeSettings)

const DEFAULT_VERSION_STDOUT = 'opencode 1.14.19\n'

// the legacy `OpenCodeProviderLive` Layer + `OpenCodeProvider` service tag
// are deleted. The snapshot-producing logic they wrapped now lives in the
// standalone `checkOpenCodeProviderStatus(settings, cwd)` Effect, which
// drivers call directly when building their per-instance snapshot
// `ServerProviderShape`. Tests mirror that shape: build a settings payload,
// invoke the check, assert on the returned snapshot.

const runtimeMock = {
  state: {
    runVersionError: null as Error | null,
    versionStdout: DEFAULT_VERSION_STDOUT,
    inventoryError: null as Error | null,
    ownerBorrows: 0,
    cliInventoryCalls: 0,
    connections: [] as Array<Parameters<OpenCodeRuntimeShape['connectToOpenCodeServer']>[0]>,
    clients: [] as Array<Parameters<OpenCodeRuntimeShape['createOpenCodeSdkClient']>[0]>,
    inventory: {
      providerList: { connected: [] as string[], all: [] as unknown[], default: {} },
      agents: [] as unknown[],
      skills: [] as unknown[],
    } as unknown,
  },
  reset()
  {
    this.state.runVersionError = null
    this.state.versionStdout = DEFAULT_VERSION_STDOUT
    this.state.inventoryError = null
    this.state.ownerBorrows = 0
    this.state.cliInventoryCalls = 0
    this.state.connections.length = 0
    this.state.clients.length = 0
    this.state.inventory = {
      providerList: { connected: [], all: [] as unknown[], default: {} },
      agents: [] as unknown[],
      skills: [] as unknown[],
    }
  },
}

const OpenCodeRuntimeTestDouble: OpenCodeRuntimeShape = {
  startOpenCodeServerProcess: () =>
    Effect.succeed({
      url: 'http://127.0.0.1:4301',
      version: '1.15.13',
      isRunning: Effect.succeed(true),
      exitCode: Effect.never,
    }),
  connectToOpenCodeServer: (input) =>
    Effect.sync(() =>
    {
      runtimeMock.state.connections.push(input)
      return {
        url: input.serverUrl ?? 'http://127.0.0.1:4301',
        version: '1.15.13',
        ...(input.serverPassword !== undefined ? { serverPassword: input.serverPassword } : {}),
        exitCode: null,
        external: Boolean(input.serverUrl),
      }
    }),
  runOpenCodeCommand: () =>
    runtimeMock.state.runVersionError
      ? Effect.fail(
          new OpenCodeRuntimeError({
            operation: 'runOpenCodeCommand',
            detail: runtimeMock.state.runVersionError.message,
            cause: runtimeMock.state.runVersionError,
          }),
        )
      : Effect.succeed({ stdout: runtimeMock.state.versionStdout, stderr: '', code: 0 }),
  createOpenCodeSdkClient: (input) =>
  {
    runtimeMock.state.clients.push(input)
    return {} as unknown as ReturnType<OpenCodeRuntimeShape['createOpenCodeSdkClient']>
  },
  loadOpenCodeInventory: () =>
    runtimeMock.state.inventoryError
      ? Effect.fail(
          new OpenCodeRuntimeError({
            operation: 'loadOpenCodeInventory',
            detail: runtimeMock.state.inventoryError.message,
            cause: runtimeMock.state.inventoryError,
          }),
        )
      : Effect.succeed(runtimeMock.state.inventory as OpenCodeInventory),
  loadInventoryFromCli: () =>
    Effect.sync(() =>
    {
      runtimeMock.state.cliInventoryCalls += 1
      return runtimeMock.state.inventory as OpenCodeInventory
    }),
}

beforeEach(() =>
{
  runtimeMock.reset()
})

const testLayer = Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble).pipe(
  Layer.merge(
    Layer.succeed(OpenCodeServerOwner, {
      withServer: (use) =>
        Effect.suspend(() =>
        {
          runtimeMock.state.ownerBorrows += 1
          return use({
            url: 'http://127.0.0.1:4301',
            serverPassword: 'local-password',
            version: '1.15.13',
            isRunning: Effect.succeed(true),
            exitCode: Effect.never,
          })
        }),
    }),
  ),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
  Layer.provideMerge(NodeServices.layer),
)

const makeOpenCodeSettings = (overrides?: Partial<OpenCodeSettings>): OpenCodeSettings =>
  decodeOpenCodeSettings({
    enabled: true,
    binaryPath: 'opencode',
    serverUrl: '',
    serverPassword: '',
    customModels: [],
    ...overrides,
  })

it.layer(testLayer)('checkOpenCodeProviderStatus', (it) =>
{
  it.effect('shows a codex-style missing binary message', () =>
    Effect.gen(function* ()
    {
      runtimeMock.state.runVersionError = new Error('spawn opencode ENOENT')
      const snapshot = yield* checkOpenCodeProviderStatus(makeOpenCodeSettings(), process.cwd())

      NodeAssert.equal(snapshot.status, 'error')
      NodeAssert.equal(snapshot.installed, false)
      NodeAssert.equal(runtimeMock.state.ownerBorrows, 0)
      NodeAssert.equal(
        snapshot.message,
        'OpenCode CLI (`opencode`) is not installed or not on PATH.',
      )
    }),
  )

  it.effect('hides generic Effect.tryPromise text for local CLI probe failures', () =>
    Effect.gen(function* ()
    {
      runtimeMock.state.runVersionError = new Error('An error occurred in Effect.tryPromise')
      const snapshot = yield* checkOpenCodeProviderStatus(makeOpenCodeSettings(), process.cwd())

      NodeAssert.equal(snapshot.status, 'error')
      NodeAssert.equal(snapshot.installed, true)
      NodeAssert.equal(snapshot.message, 'Failed to execute OpenCode CLI health check.')
    }),
  )

  it.effect('emits OpenCode variant defaults so trait picker can resolve a visible selection', () =>
    Effect.gen(function* ()
    {
      runtimeMock.state.inventory = {
        providerList: {
          connected: ['openai'],
          all: [
            {
              id: 'openai',
              name: 'OpenAI',
              models: {
                'gpt-5.4': {
                  id: 'gpt-5.4',
                  name: 'GPT-5.4',
                  variants: {
                    none: {},
                    low: {},
                    medium: {},
                    high: {},
                    xhigh: {},
                  },
                },
              },
            },
          ],
          default: {},
        },
        agents: [
          { name: 'build', hidden: false, mode: 'primary' },
          { name: 'plan', hidden: false, mode: 'primary' },
        ],
        skills: [],
      }

      const snapshot = yield* checkOpenCodeProviderStatus(makeOpenCodeSettings(), process.cwd())
      const model = snapshot.models.find((entry) => entry.slug === 'openai/gpt-5.4')

      NodeAssert.ok(model)
      const variantDescriptor = model.capabilities?.optionDescriptors?.find(
        (descriptor) => descriptor.id === 'variant' && descriptor.type === 'select',
      )
      NodeAssert.ok(variantDescriptor && variantDescriptor.type === 'select')
      NodeAssert.equal(
        variantDescriptor.options.find((option) => option.isDefault === true)?.id,
        'medium',
      )
      const agentDescriptor = model.capabilities?.optionDescriptors?.find(
        (descriptor) => descriptor.id === 'agent' && descriptor.type === 'select',
      )
      NodeAssert.ok(agentDescriptor && agentDescriptor.type === 'select')
      NodeAssert.equal(
        agentDescriptor.options.find((option) => option.isDefault === true)?.id,
        'build',
      )
    }),
  )

  it.effect(
    'loads local inventory through the shared owner with its verified version and password',
    () =>
      Effect.gen(function* ()
      {
        const snapshot = yield* checkOpenCodeProviderStatus(makeOpenCodeSettings(), process.cwd())

        NodeAssert.equal(snapshot.version, '1.15.13')
        NodeAssert.equal(runtimeMock.state.ownerBorrows, 1)
        NodeAssert.equal(runtimeMock.state.cliInventoryCalls, 0)
        NodeAssert.deepEqual(runtimeMock.state.connections, [])
        NodeAssert.deepEqual(runtimeMock.state.clients, [
          {
            baseUrl: 'http://127.0.0.1:4301',
            directory: process.cwd(),
            serverPassword: 'local-password',
          },
        ])
      }),
  )

  it.effect('publishes only valid discovered skills', () =>
    Effect.gen(function* ()
    {
      runtimeMock.state.inventory = {
        providerList: { connected: [], all: [], default: {} },
        agents: [],
        skills: [
          {
            name: ' review-pr ',
            description: ' Review a pull request. ',
            location: ' /tmp/review-pr/SKILL.md ',
          },
          { name: 'missing-path', description: 'Ignored' },
        ],
      }

      const snapshot = yield* checkOpenCodeProviderStatus(makeOpenCodeSettings(), process.cwd())

      NodeAssert.deepEqual(snapshot.skills, [
        {
          name: 'review-pr',
          description: 'Review a pull request.',
          shortDescription: 'Review a pull request.',
          path: '/tmp/review-pr/SKILL.md',
          enabled: true,
        },
      ])
    }),
  )

  it.effect('reports local model inventory failures without treating them as empty', () =>
    Effect.gen(function* ()
    {
      runtimeMock.state.inventoryError = new Error('plugin inventory ENOENT')
      const snapshot = yield* checkOpenCodeProviderStatus(makeOpenCodeSettings(), process.cwd())

      NodeAssert.equal(snapshot.status, 'error')
      NodeAssert.equal(snapshot.installed, true)
      NodeAssert.equal(snapshot.models.length, 0)
      NodeAssert.equal(
        snapshot.message,
        'Failed to load OpenCode provider inventory: plugin inventory ENOENT',
      )
    }),
  )
})

it.layer(testLayer)('checkOpenCodeProviderStatus with configured server URL', (it) =>
{
  it.effect('surfaces a friendly auth error for configured servers', () =>
    Effect.gen(function* ()
    {
      runtimeMock.state.inventoryError = new Error('401 Unauthorized')
      const snapshot = yield* checkOpenCodeProviderStatus(
        makeOpenCodeSettings({
          serverUrl: 'http://127.0.0.1:9999',
          serverPassword: 'secret-password',
        }),
        process.cwd(),
      )

      NodeAssert.equal(snapshot.status, 'error')
      NodeAssert.equal(snapshot.installed, true)
      NodeAssert.equal(runtimeMock.state.ownerBorrows, 0)
      NodeAssert.deepEqual(runtimeMock.state.connections, [
        {
          binaryPath: 'opencode',
          directory: process.cwd(),
          serverUrl: 'http://127.0.0.1:9999',
          serverPassword: 'secret-password',
        },
      ])
      NodeAssert.equal(
        snapshot.message,
        'OpenCode server rejected authentication. Check the server URL and password.',
      )
    }),
  )

  it.effect('surfaces a friendly connection error for configured servers', () =>
    Effect.gen(function* ()
    {
      runtimeMock.state.inventoryError = new Error(
        'fetch failed: connect ECONNREFUSED 127.0.0.1:9999',
      )
      const snapshot = yield* checkOpenCodeProviderStatus(
        makeOpenCodeSettings({
          serverUrl: 'http://127.0.0.1:9999',
          serverPassword: 'secret-password',
        }),
        process.cwd(),
      )

      NodeAssert.equal(snapshot.status, 'error')
      NodeAssert.equal(snapshot.installed, true)
      NodeAssert.equal(
        snapshot.message,
        "Couldn't reach the configured OpenCode server at http://127.0.0.1:9999. Check that the server is running and the URL is correct.",
      )
    }),
  )
})
