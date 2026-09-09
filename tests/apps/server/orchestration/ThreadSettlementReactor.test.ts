// tests/apps/server/orchestration/ThreadSettlementReactor.test.ts
// protect serialized settlement sweeps, settings wakeups, and live-task exclusion

import {
  DEFAULT_SERVER_SETTINGS,
  OrchestrationShellSnapshot,
  ProviderInstanceId,
  ProviderDriverKind,
  ThreadId,
} from '@t3tools/contracts'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, it } from '@effect/vitest'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as PubSub from 'effect/PubSub'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import * as TestClock from 'effect/testing/TestClock'

import { GitManager } from '../../../../apps/server/src/git/GitManager.ts'
import { ProviderService } from '../../../../apps/server/src/provider/Services/ProviderService.ts'
import { ProviderBackgroundTaskRegistry } from '../../../../apps/server/src/provider/Services/ProviderBackgroundTaskRegistry.ts'
import { ServerSettingsService } from '../../../../apps/server/src/serverSettings.ts'
import { OrchestrationEngineService } from '../../../../apps/server/src/orchestration/Services/OrchestrationEngine.ts'
import { ProjectionSnapshotQuery } from '../../../../apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts'
import { makeThreadSettlementReactor } from '../../../../apps/server/src/orchestration/ThreadSettlementReactor.ts'

const THREAD = ThreadId.make('thread-settlement')
const OLD = '1969-12-01T00:00:00.000Z'
const snapshot = Schema.decodeSync(OrchestrationShellSnapshot)({
  snapshotSequence: 7,
  updatedAt: OLD,
  projects: [
    {
      id: 'project-settlement',
      title: 'Settlement',
      workspaceRoot: '/tmp/settlement',
      defaultModelSelection: null,
      scripts: [],
      createdAt: OLD,
      updatedAt: OLD,
    },
  ],
  threads: [
    {
      id: THREAD,
      projectId: 'project-settlement',
      title: 'Settlement',
      modelSelection: { instanceId: 'codex', model: 'gpt-5.4' },
      runtimeMode: 'full-access',
      branch: 'feature',
      worktreePath: null,
      latestTurn: null,
      createdAt: OLD,
      updatedAt: OLD,
      session: null,
      latestUserMessageAt: OLD,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    },
  ],
})

it.effect('serializes concurrent sweeps and excludes exact-generation live background work', () =>
  Effect.gen(function* ()
  {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let lookups = 0
    let active = 0
    let maxActive = 0
    let liveTask = false
    let disabled = false
    const dispatched: string[] = []
    const layer = Layer.mergeAll(
      Layer.mock(ProjectionSnapshotQuery)({ getShellSnapshot: () => Effect.succeed(snapshot) }),
      Layer.mock(OrchestrationEngineService)({
        dispatch: (command) =>
          Effect.sync(() =>
          {
            dispatched.push(command.type)
            return { sequence: 8 }
          }),
      }),
      Layer.mock(ServerSettingsService)({
        getSettings: Effect.sync(() =>
          disabled
            ? {
                ...DEFAULT_SERVER_SETTINGS,
                sidebarAutoSettleAfterDays: null,
                sidebarAutoSettleOnMerge: false,
              }
            : DEFAULT_SERVER_SETTINGS,
        ),
      }),
      Layer.mock(ProviderService)({
        listSessions: () => Effect.succeed([]),
        captureSessionIdentities: () =>
          Effect.succeed([
            {
              provider: ProviderDriverKind.make('codex'),
              providerInstanceId: ProviderInstanceId.make('codex'),
              threadId: THREAD,
              sessionGeneration: 1,
              createdAt: OLD,
            },
          ]),
      }),
      Layer.mock(ProviderBackgroundTaskRegistry)({
        hasLiveTasks: () => Effect.sync(() => liveTask),
      }),
      Layer.mock(GitManager)({
        branchPullRequest: () =>
          Effect.gen(function* ()
          {
            active += 1
            lookups += 1
            maxActive = Math.max(maxActive, active)
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
            active -= 1
            return null
          }),
      }),
    )
    yield* Effect.gen(function* ()
    {
      const reactor = yield* makeThreadSettlementReactor
      const first = yield* reactor.sweep().pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      const second = yield* reactor.sweep().pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      assert.equal(lookups, 1)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      assert.equal(maxActive, 1)
      assert.equal(dispatched.length, 2)
      disabled = true
      const previousLookups = lookups
      yield* reactor.sweep()
      assert.equal(lookups, previousLookups)
      disabled = false
      liveTask = true
      yield* reactor.sweep()
      assert.equal(dispatched.length, 2)
    }).pipe(Effect.provide(layer))
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.effect('sweeps on startup, a minute tick, and policy changes without preference migration', () =>
  Effect.gen(function* ()
  {
    const changes = yield* PubSub.unbounded<typeof DEFAULT_SERVER_SETTINGS>()
    const signals = yield* Effect.all([
      Deferred.make<void>(),
      Deferred.make<void>(),
      Deferred.make<void>(),
    ])
    let dispatchCount = 0
    const layer = Layer.mergeAll(
      Layer.mock(ProjectionSnapshotQuery)({ getShellSnapshot: () => Effect.succeed(snapshot) }),
      Layer.mock(OrchestrationEngineService)({
        dispatch: () =>
          Effect.gen(function* ()
          {
            const signal = signals[dispatchCount++]
            if (signal !== undefined) yield* Deferred.succeed(signal, undefined)
            return { sequence: 8 }
          }),
      }),
      Layer.mock(ServerSettingsService)({
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        streamCurrentAndChanges: Stream.concat(
          Stream.make(DEFAULT_SERVER_SETTINGS),
          Stream.fromPubSub(changes),
        ),
      }),
      Layer.mock(ProviderService)({
        listSessions: () => Effect.succeed([]),
        captureSessionIdentities: () => Effect.succeed([]),
      }),
      Layer.mock(ProviderBackgroundTaskRegistry)({ hasLiveTasks: () => Effect.succeed(false) }),
      Layer.mock(GitManager)({ branchPullRequest: () => Effect.succeed(null) }),
    )
    yield* Effect.gen(function* ()
    {
      const reactor = yield* makeThreadSettlementReactor
      yield* reactor.start()
      yield* Deferred.await(signals[0]!)
      yield* TestClock.adjust('1 minute')
      yield* Deferred.await(signals[1]!)
      yield* PubSub.publish(changes, {
        ...DEFAULT_SERVER_SETTINGS,
        sidebarAutoSettleOnMerge: false,
      })
      yield* Deferred.await(signals[2]!)
      assert.equal(dispatchCount, 3)
    }).pipe(Effect.provide(layer))
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)
