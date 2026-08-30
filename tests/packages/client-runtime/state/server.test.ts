// tests/packages/client-runtime/state/server.test.ts
// covers server query state behavior

import {
  EnvironmentId,
  type EnvironmentTheme,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ServerLifecycleWelcomePayload,
  WS_METHODS,
} from '@t3tools/contracts'
import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Queue from 'effect/Queue'
import * as Stream from 'effect/Stream'
import * as SubscriptionRef from 'effect/SubscriptionRef'

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from '../../../../packages/client-runtime/src/connection/model.ts'
import * as EnvironmentSupervisor from '../../../../packages/client-runtime/src/connection/supervisor.ts'
import * as Persistence from '../../../../packages/client-runtime/src/platform/persistence.ts'
import type { WsRpcProtocolClient } from '../../../../packages/client-runtime/src/rpc/protocol.ts'
import type { RpcSession } from '../../../../packages/client-runtime/src/rpc/session.ts'
import {
  applyServerConfigProjection,
  makeEnvironmentServerConfigState,
  projectServerWelcome,
  resolveServerConfigValue,
  type ServerConfigProjection,
} from '../../../../packages/client-runtime/src/state/server.ts'

const CONFIG = {
  environment: { environmentId: EnvironmentId.make('environment-1'), capabilities: {} },
  availableEditors: [],
  issues: [],
  keybindings: {},
  keybindingsConfigPath: null,
  observability: null,
  providers: [],
  settings: {},
} as unknown as ServerConfig

const snapshotEvent = (config: ServerConfig): ServerConfigStreamEvent => ({
  version: 1,
  type: 'snapshot',
  config,
})

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make('environment-1'),
  label: 'Test environment',
  httpBaseUrl: 'https://environment.example.test',
  wsBaseUrl: 'wss://environment.example.test',
})

function session(client: WsRpcProtocolClient): RpcSession
{
  return {
    client,
    initialConfig: Effect.succeed(CONFIG),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  }
}

describe('server state projection', () =>
{
  it('applies every config category to the projected snapshot', () =>
  {
    const snapshot = applyServerConfigProjection(Option.none(), {
      version: 1,
      type: 'snapshot',
      config: CONFIG,
    })
    const settings = {
      ...CONFIG.settings,
      architectureAutoAnalysis: 'auto',
    } as ServerConfig['settings']
    const projected = applyServerConfigProjection(snapshot, {
      version: 1,
      type: 'settingsUpdated',
      payload: { settings },
    })

    const result = Option.getOrThrow(projected)
    expect(result.config.settings).toBe(settings)
    expect(result.config.settings.architectureAutoAnalysis).toBe('auto')
    expect(result.latestEvent.type).toBe('settingsUpdated')
  })

  it('retains welcome when a ready event follows in the same stream chunk', () =>
  {
    const welcome = {
      environment: {} as ServerLifecycleWelcomePayload['environment'],
      cwd: '/repo',
      projectName: 'repo',
    } as ServerLifecycleWelcomePayload
    const [afterWelcome] = projectServerWelcome(Option.none(), {
      type: 'welcome',
      payload: welcome,
    })
    const [afterReady, emitted] = projectServerWelcome(afterWelcome, {
      type: 'ready',
      payload: {},
    })

    expect(Option.getOrThrow(afterReady)).toBe(welcome)
    expect(emitted).toEqual([])
  })

  it('prefers an active session config over cache until a live event arrives', () =>
  {
    const cached = { ...CONFIG, settings: { source: 'cache' } } as unknown as ServerConfig
    const initial = { ...CONFIG, settings: { source: 'session' } } as unknown as ServerConfig
    const live = { ...CONFIG, settings: { source: 'live' } } as unknown as ServerConfig

    expect(
      resolveServerConfigValue(
        {
          config: cached,
          latestEvent: snapshotEvent(cached),
          source: 'cache',
        },
        initial,
      ),
    ).toBe(initial)
    expect(
      resolveServerConfigValue(
        {
          config: live,
          latestEvent: snapshotEvent(live),
          source: 'live',
        },
        initial,
      ),
    ).toBe(live)
  })

  it.effect('starts from cached configuration and persists the live projection', () =>
    Effect.gen(function* ()
    {
      const events = yield* Queue.unbounded<ServerConfigStreamEvent>()
      const subscriptionInputs: unknown[] = []
      const client = {
        [WS_METHODS.subscribeServerConfig]: (input: unknown) =>
        {
          subscriptionInputs.push(input)
          return Stream.fromQueue(events)
        },
      } as unknown as WsRpcProtocolClient
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.some(session(client))),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor['Service'])
      const savedConfigs = yield* Queue.unbounded<ServerConfig>()
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeed(Option.none()),
        saveShell: () => Effect.void,
        loadThread: () => Effect.succeed(Option.none()),
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        loadServerConfig: () => Effect.succeed(Option.some(CONFIG)),
        saveServerConfig: (_environmentId, config) => Queue.offer(savedConfigs, config),
        loadVcsRefs: () => Effect.succeed(Option.none()),
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      })

      yield* Effect.scoped(
        Effect.gen(function* ()
        {
          const state = yield* makeEnvironmentServerConfigState().pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
            Effect.provideService(Persistence.EnvironmentCacheStore, cache),
          )
          expect(Option.getOrThrow(yield* SubscriptionRef.get(state)).config).toBe(CONFIG)

          const providers: ServerConfig['providers'] = []
          yield* Queue.offer(events, {
            version: 1,
            type: 'providerStatuses',
            payload: { providers },
          })
          const projected = yield* SubscriptionRef.changes(state).pipe(
            Stream.filter((value) =>
              Option.match(value, {
                onNone: () => false,
                onSome: (projection) => projection.latestEvent.type === 'providerStatuses',
              }),
            ),
            Stream.runHead,
          )
          expect(Option.getOrThrow(Option.getOrThrow(projected)).config.providers).toBe(providers)
        }),
      )

      expect((yield* Queue.take(savedConfigs)).providers).toEqual([])
      expect(subscriptionInputs).toEqual([{}])
    }),
  )

  it.effect('does not rewrite cached configuration when no live update arrives', () =>
    Effect.gen(function* ()
    {
      const client = {
        [WS_METHODS.subscribeServerConfig]: () => Stream.empty,
      } as unknown as WsRpcProtocolClient
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.some(session(client))),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor['Service'])
      const savedConfigs = yield* Queue.unbounded<ServerConfig>()
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeed(Option.none()),
        saveShell: () => Effect.void,
        loadThread: () => Effect.succeed(Option.none()),
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        loadServerConfig: () => Effect.succeed(Option.some(CONFIG)),
        saveServerConfig: (_environmentId, config) => Queue.offer(savedConfigs, config),
        loadVcsRefs: () => Effect.succeed(Option.none()),
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      })

      yield* Effect.scoped(
        makeEnvironmentServerConfigState().pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.provideService(Persistence.EnvironmentCacheStore, cache),
        ),
      )

      expect(yield* Queue.poll(savedConfigs)).toEqual(Option.none())
    }),
  )

  it.effect('retains live themes across session replacement without persisting them', () =>
    Effect.gen(function* ()
    {
      const theme: EnvironmentTheme = {
        id: 'published',
        name: 'Published',
        appearance: 'dark',
        canvas: '#111',
        accent: '#abcdef',
      }
      const config: ServerConfig = {
        ...CONFIG,
        environment: {
          ...CONFIG.environment,
          capabilities: { ...CONFIG.environment.capabilities, environmentThemes: true },
        },
      }
      const firstEvents = yield* Queue.unbounded<ServerConfigStreamEvent>()
      const secondEvents = yield* Queue.unbounded<ServerConfigStreamEvent>()
      const inputs: unknown[] = []
      const makeClient = (events: Queue.Queue<ServerConfigStreamEvent>) =>
        ({
          [WS_METHODS.subscribeServerConfig]: (input: unknown) =>
          {
            inputs.push(input)
            return Stream.fromQueue(events)
          },
        }) as unknown as WsRpcProtocolClient
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.some(session(makeClient(firstEvents)))),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      })
      let cacheLoads = 0
      const saved: ServerConfig[] = []
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeed(Option.none()),
        saveShell: () => Effect.void,
        loadThread: () => Effect.succeed(Option.none()),
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        loadServerConfig: () =>
          Effect.sync(() =>
          {
            cacheLoads += 1
            return Option.some({ ...config, environmentThemes: [theme] })
          }),
        saveServerConfig: (_id, value) =>
          Effect.sync(() =>
          {
            saved.push(value)
          }),
        loadVcsRefs: () => Effect.succeed(Option.none()),
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      })
      yield* Effect.scoped(
        Effect.gen(function* ()
        {
          const state = yield* makeEnvironmentServerConfigState(true).pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
            Effect.provideService(Persistence.EnvironmentCacheStore, cache),
          )
          expect(
            Option.getOrThrow(yield* SubscriptionRef.get(state)).config.environmentThemes,
          ).toBeUndefined()
          const waitForEvent = (event: ServerConfigStreamEvent) =>
            SubscriptionRef.changes(state).pipe(
              Stream.filter((value) => Option.isSome(value) && value.value.latestEvent === event),
              Stream.runHead,
            )
          yield* Queue.offer(firstEvents, snapshotEvent(config))
          const published: ServerConfigStreamEvent = {
            version: 1,
            type: 'environmentThemesUpdated',
            payload: { themes: [theme] },
          }
          yield* Queue.offer(firstEvents, published)
          yield* waitForEvent(published)
          yield* SubscriptionRef.set(supervisor.session, Option.none())
          expect(
            Option.getOrThrow(yield* SubscriptionRef.get(state)).config.environmentThemes,
          ).toEqual([theme])
          yield* SubscriptionRef.set(
            supervisor.session,
            Option.some(session(makeClient(secondEvents))),
          )
          const reconnect = snapshotEvent(config)
          yield* Queue.offer(secondEvents, reconnect)
          yield* waitForEvent(reconnect)
          expect(
            Option.getOrThrow(yield* SubscriptionRef.get(state)).config.environmentThemes,
          ).toEqual([theme])
          const cleared: ServerConfigStreamEvent = {
            version: 1,
            type: 'environmentThemesUpdated',
            payload: { themes: [] },
          }
          yield* Queue.offer(secondEvents, cleared)
          yield* waitForEvent(cleared)
          expect(
            Option.getOrThrow(yield* SubscriptionRef.get(state)).config.environmentThemes,
          ).toBeUndefined()
          yield* Queue.offer(secondEvents, published)
          yield* waitForEvent(published)
        }),
      )
      expect(cacheLoads).toBe(1)
      expect(inputs).toEqual([{ environmentThemes: true }, { environmentThemes: true }])
      expect(saved.length).toBeGreaterThan(0)
      expect(saved.every((value) => value.environmentThemes === undefined)).toBe(true)
      expect(saved.at(-1)?.providers).toEqual(config.providers)
    }),
  )

  it('does not carry themes from cache, another environment, or a server that lost support', () =>
  {
    const theme: EnvironmentTheme = {
      id: 'published',
      name: 'Published',
      appearance: 'dark',
      canvas: '#111',
      accent: '#abc',
    }
    const config: ServerConfig = {
      ...CONFIG,
      environment: {
        ...CONFIG.environment,
        capabilities: { ...CONFIG.environment.capabilities, environmentThemes: true },
      },
      environmentThemes: [theme],
    }
    const current = { config, source: 'live' as const, latestEvent: snapshotEvent(config) }
    const themesAfter = (previous: ServerConfigProjection, next: ServerConfig) =>
      Option.getOrThrow(applyServerConfigProjection(Option.some(previous), snapshotEvent(next)))
        .config.environmentThemes
    expect(themesAfter(current, CONFIG)).toBeUndefined()
    expect(
      themesAfter(current, {
        ...config,
        environment: { ...config.environment, environmentId: EnvironmentId.make('other') },
      }),
    ).toBeUndefined()
    expect(
      Option.getOrThrow(
        applyServerConfigProjection(
          Option.some({ ...current, source: 'cache' }),
          snapshotEvent(config),
        ),
      ).config.environmentThemes,
    ).toBeUndefined()
  })
})
