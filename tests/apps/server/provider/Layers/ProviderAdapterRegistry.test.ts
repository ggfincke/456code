// tests/apps/server/provider/Layers/ProviderAdapterRegistry.test.ts
// verifies live provider adapter registry routing and refresh behavior
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ServerProvider,
} from '@t3tools/contracts'
import { it, assert, vi } from '@effect/vitest'

import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as PubSub from 'effect/PubSub'
import * as Stream from 'effect/Stream'

import type * as ClaudeAdapter from '../../../../../apps/server/src/provider/Services/ClaudeAdapter.ts'
import type * as CodexAdapter from '../../../../../apps/server/src/provider/Services/CodexAdapter.ts'
import type * as CursorAdapter from '../../../../../apps/server/src/provider/Services/CursorAdapter.ts'
import type * as OpenCodeAdapter from '../../../../../apps/server/src/provider/Services/OpenCodeAdapter.ts'
import * as ProviderAdapterRegistry from '../../../../../apps/server/src/provider/Services/ProviderAdapterRegistry.ts'
import * as ProviderInstanceRegistry from '../../../../../apps/server/src/provider/Services/ProviderInstanceRegistry.ts'
import type { ProviderInstance } from '../../../../../apps/server/src/provider/catalog/ProviderDriver.ts'
import { makeManualOnlyProviderMaintenanceCapabilities } from '../../../../../apps/server/src/provider/maintenance/providerMaintenance.ts'
import type * as TextGeneration from '../../../../../apps/server/src/textGeneration/TextGeneration.ts'
import * as ProviderAdapterRegistryLayer from '../../../../../apps/server/src/provider/Layers/ProviderAdapterRegistry.ts'
import * as NodeServices from '@effect/platform-node/NodeServices'

const CODEX_DRIVER = ProviderDriverKind.make('codex')
const CLAUDE_AGENT_DRIVER = ProviderDriverKind.make('claudeAgent')
const OPENCODE_DRIVER = ProviderDriverKind.make('opencode')
const CURSOR_DRIVER = ProviderDriverKind.make('cursor')
let currentClaudeContinuationKey = 'claudeAgent:instance:claudeAgent'

const fakeCodexAdapter: CodexAdapter.CodexAdapterShape = {
  provider: CODEX_DRIVER,
  capabilities: { sessionModelSwitch: 'in-session' },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  getSessionRuntimeBinding: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
}

const fakeClaudeAdapter: ClaudeAdapter.ClaudeAdapterShape = {
  provider: CLAUDE_AGENT_DRIVER,
  capabilities: { sessionModelSwitch: 'in-session' },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  getSessionRuntimeBinding: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
}

const fakeOpenCodeAdapter: OpenCodeAdapter.OpenCodeAdapterShape = {
  provider: OPENCODE_DRIVER,
  capabilities: { sessionModelSwitch: 'in-session' },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  getSessionRuntimeBinding: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
}

const fakeCursorAdapter: CursorAdapter.CursorAdapterShape = {
  provider: CURSOR_DRIVER,
  capabilities: { sessionModelSwitch: 'in-session' },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  getSessionRuntimeBinding: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
}

// ProviderAdapterRegistryLive is now a facade over ProviderInstanceRegistry —
// it walks `listInstances` once at boot and surfaces the default-instance
// adapter keyed by its driver kind. To test the facade we supply four fake
// instances whose `instanceId === defaultInstanceIdForDriver(driverKind)` so
// they pass the default-instance filter.
const makeFakeInstance = (
  driverKindString: 'codex' | 'claudeAgent' | 'cursor' | 'opencode',
  adapter: ProviderInstance['adapter'],
): ProviderInstance =>
{
  const driverKind = ProviderDriverKind.make(driverKindString)
  const continuationIdentity = {
    driverKind,
    continuationKey: `${driverKind}:instance:${defaultInstanceIdForDriver(driverKind)}`,
  }
  return {
    instanceId: defaultInstanceIdForDriver(driverKind),
    driverKind,
    continuationIdentity,
    resolveContinuationIdentity:
      driverKind === CLAUDE_AGENT_DRIVER
        ? Effect.sync(() => ({
            driverKind,
            continuationKey: currentClaudeContinuationKey,
          }))
        : Effect.succeed(continuationIdentity),
    displayName: undefined,
    enabled: true,
    snapshot: {
      maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
        provider: driverKind,
        packageName: null,
      }),
      getSnapshot: Effect.succeed({} as unknown as ServerProvider),
      refresh: Effect.succeed({} as unknown as ServerProvider),
      streamChanges: Stream.empty,
    },
    adapter,
    textGeneration: {} as unknown as TextGeneration.TextGeneration['Service'],
  }
}

const fakeInstances: ReadonlyArray<ProviderInstance> = [
  makeFakeInstance('codex', fakeCodexAdapter),
  makeFakeInstance('claudeAgent', fakeClaudeAdapter),
  makeFakeInstance('opencode', fakeOpenCodeAdapter),
  makeFakeInstance('cursor', fakeCursorAdapter),
]

const fakeInstanceRegistryLayer = Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
  getInstance: (instanceId) =>
    Effect.succeed(fakeInstances.find((instance) => instance.instanceId === instanceId)),
  listInstances: Effect.succeed(fakeInstances),
  listUnavailable: Effect.succeed([]),
  streamChanges: Stream.empty,
  // tests never drive changes through this fake; acquire a throwaway
  // subscription on an unused PubSub so the shape is satisfied.
  subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) => PubSub.subscribe(pubsub)),
})

const layer = Layer.mergeAll(
  Layer.provide(
    ProviderAdapterRegistryLayer.ProviderAdapterRegistryLive,
    fakeInstanceRegistryLayer,
  ),
  NodeServices.layer,
)

it.layer(layer)('ProviderAdapterRegistryLive', (it) =>
{
  it('resolves adapters and routing metadata from provider instances', () =>
    Effect.gen(function* ()
    {
      const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistry
      const claudeInstanceId = defaultInstanceIdForDriver(CLAUDE_AGENT_DRIVER)

      const adapter = yield* registry.getByInstance(claudeInstanceId)
      assert.strictEqual(adapter, fakeClaudeAdapter)

      const info = yield* registry.getInstanceInfo(claudeInstanceId)
      assert.deepStrictEqual(info, {
        instanceId: claudeInstanceId,
        driverKind: CLAUDE_AGENT_DRIVER,
        displayName: undefined,
        accentColor: undefined,
        enabled: true,
        continuationIdentity: {
          driverKind: CLAUDE_AGENT_DRIVER,
          continuationKey: 'claudeAgent:instance:claudeAgent',
        },
      })

      currentClaudeContinuationKey = 'claudeAgent:file:v1:reconfigured'
      const reconfiguredInfo = yield* registry.getInstanceInfo(claudeInstanceId)
      assert.strictEqual(
        reconfiguredInfo.continuationIdentity.continuationKey,
        currentClaudeContinuationKey,
      )

      const instances = yield* registry.listInstances()
      assert.deepStrictEqual(instances, [
        defaultInstanceIdForDriver(CODEX_DRIVER),
        claudeInstanceId,
        defaultInstanceIdForDriver(OPENCODE_DRIVER),
        defaultInstanceIdForDriver(CURSOR_DRIVER),
      ])

      const providers = yield* registry.listProviders()
      assert.deepStrictEqual(providers, [
        CODEX_DRIVER,
        CLAUDE_AGENT_DRIVER,
        OPENCODE_DRIVER,
        CURSOR_DRIVER,
      ])
    }))
})
