// tests/apps/server/orchestration/Layers/ThreadArchiveReactor.test.ts
// verifies durable generation-fenced archive cleanup and replay

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  NonNegativeInt,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from '@t3tools/contracts'
import { it } from '@effect/vitest'
import * as NodeServices from '@effect/platform-node/NodeServices'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import * as TestClock from 'effect/testing/TestClock'
import { describe, expect } from 'vite-plus/test'

import { ServerConfig } from '../../../../../apps/server/src/config.ts'
import { OrchestrationEngineWithArchivePermitLive } from '../../../../../apps/server/src/orchestration/Layers/OrchestrationEngine.ts'
import { OrchestrationProjectionPipelineLive } from '../../../../../apps/server/src/orchestration/Layers/ProjectionPipeline.ts'
import { OrchestrationProjectionSnapshotQueryLive } from '../../../../../apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts'
import { ThreadArchiveReactorLive } from '../../../../../apps/server/src/orchestration/Layers/ThreadArchiveReactor.ts'
import { ThreadArchiveLifecyclePermitLive } from '../../../../../apps/server/src/orchestration/Layers/ThreadArchiveLifecyclePermit.ts'
import { OrchestrationEngineService } from '../../../../../apps/server/src/orchestration/Services/OrchestrationEngine.ts'
import { ThreadArchiveReactor } from '../../../../../apps/server/src/orchestration/Services/ThreadArchiveReactor.ts'
import { OrchestrationCommandReceiptRepositoryLive } from '../../../../../apps/server/src/persistence/Layers/OrchestrationCommandReceipts.ts'
import { OrchestrationEventStoreLive } from '../../../../../apps/server/src/persistence/Layers/OrchestrationEventStore.ts'
import { ProjectionThreadRepositoryLive } from '../../../../../apps/server/src/persistence/Layers/ProjectionThreads.ts'
import { ProviderRuntimeInboxLive } from '../../../../../apps/server/src/persistence/Layers/ProviderRuntimeInbox.ts'
import { SqlitePersistenceMemory } from '../../../../../apps/server/src/persistence/Layers/Sqlite.ts'
import { OrchestrationReactorDelivery } from '../../../../../apps/server/src/persistence/Services/OrchestrationReactorDelivery.ts'
import {
  ProviderService,
  type ProviderServiceShape,
  type ProviderSessionIdentityCapture,
} from '../../../../../apps/server/src/provider/Services/ProviderService.ts'
import { CODEX_PROVIDER_CAPABILITIES } from '../../../../../apps/server/src/provider/providerCapabilities.ts'
import * as RepositoryIdentityResolver from '../../../../../apps/server/src/project/RepositoryIdentityResolver.ts'
import { RuntimeRecoveryPolicyRegistry } from '../../../../../apps/server/src/recovery/RuntimeRecoveryPolicy.ts'
import { RuntimeRecoveryPolicyRegistryLive } from '../../../../../apps/server/src/recovery/RuntimeRecoveryPolicy.ts'
import * as TerminalManager from '../../../../../apps/server/src/terminal/Manager.ts'
import { AttachmentLifecycleRepositoryLive } from '../../../../../apps/server/src/persistence/Layers/AttachmentLifecycle.ts'
import { CheckpointRevertOperationsLive } from '../../../../../apps/server/src/persistence/Layers/CheckpointRevertOperations.ts'
import { expectedProviderGenerationStopKeys } from '../../support/threadLifecycleGenerationClose.ts'

const ARCHIVE_TIME = '2026-08-09T12:00:00.000Z'
const BEFORE_ARCHIVE = '2026-08-09T11:59:59.000Z'
const CLOCK_ROLLBACK_RESOURCE_TIME = '2026-08-09T12:00:01.000Z'
const threadId = ThreadId.make('thread-archive-reactor-test')
const providerKind = ProviderDriverKind.make('codex')
const providerInstanceId = ProviderInstanceId.make('codex')
const decodeArchiveActionPayload = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      threadId: ThreadId,
      archiveGeneration: NonNegativeInt,
      archivedAt: Schema.String,
      providerIdentity: Schema.NullOr(
        Schema.Struct({
          provider: ProviderDriverKind,
          providerInstanceId: ProviderInstanceId,
          threadId: ThreadId,
          sessionGeneration: NonNegativeInt,
          createdAt: Schema.String,
        }),
      ),
      providerIdentities: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            provider: ProviderDriverKind,
            providerInstanceId: ProviderInstanceId,
            threadId: ThreadId,
            sessionGeneration: NonNegativeInt,
            createdAt: Schema.String,
          }),
        ),
      ),
      terminalIdentities: Schema.Array(
        Schema.Struct({
          threadId: ThreadId,
          terminalId: Schema.String,
          lifecycleId: Schema.String,
          startedAt: Schema.String,
        }),
      ),
    }),
  ),
)
const decodeArchiveActionId = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Tuple([
      Schema.Literal('thread-archive'),
      NonNegativeInt,
      NonNegativeInt,
      Schema.Literal('thread.archive.cleanup-exact'),
      Schema.Literal('thread-archive-generation'),
      Schema.String,
      NonNegativeInt,
    ]),
  ),
)

interface HarnessState
{
  providerIdentities: ProviderSessionIdentityCapture[]
  providerIdentitiesAddedAfterPlan: ProviderSessionIdentityCapture[]
  terminalIdentities: TerminalManager.TerminalLifecycleIdentity[]
  providerStopFailures: number
  terminalStopFailures: number
  providerStopGate: {
    readonly started: Deferred.Deferred<void>
    readonly release: Deferred.Deferred<void>
  } | null
  readonly providerStops: string[]
  readonly terminalStops: string[]
}

const unsupported = <A>() =>
  Effect.die(new Error('Unsupported provider call in archive reactor test')) as Effect.Effect<
    A,
    never
  >

function sameProviderIdentity(
  left: ProviderSessionIdentityCapture,
  right: Parameters<ProviderServiceShape['stopSessionIfExact']>[0],
): boolean
{
  return (
    left.provider === right.provider &&
    left.providerInstanceId === right.providerInstanceId &&
    left.threadId === right.threadId &&
    left.sessionGeneration === right.sessionGeneration
  )
}

function sameTerminalIdentity(
  left: TerminalManager.TerminalLifecycleIdentity,
  right: TerminalManager.TerminalLifecycleIdentity,
): boolean
{
  return (
    left.threadId === right.threadId &&
    left.terminalId === right.terminalId &&
    left.lifecycleId === right.lifecycleId &&
    left.startedAt === right.startedAt
  )
}

function makeLayer(state: HarnessState)
{
  const persistence = Layer.fresh(SqlitePersistenceMemory)
  const archiveLifecyclePermit = Layer.fresh(ThreadArchiveLifecyclePermitLive)
  const orchestrationLayer = OrchestrationEngineWithArchivePermitLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(AttachmentLifecycleRepositoryLive),
    Layer.provideMerge(CheckpointRevertOperationsLive),
    Layer.provideMerge(ProviderRuntimeInboxLive),
    Layer.provide(persistence),
    Layer.provide(archiveLifecyclePermit),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: 't3-thread-archive-test-' })),
  )
  const providerService: ProviderServiceShape = {
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    interruptTurn: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () => unsupported(),
    captureSessionIdentity: (input) =>
      Effect.succeed(
        Option.fromNullishOr(
          state.providerIdentities.find(
            (identity) =>
              identity.threadId === input.threadId &&
              (input.expectedProviderInstanceId === undefined ||
                identity.providerInstanceId === input.expectedProviderInstanceId),
          ),
        ),
      ),
    captureSessionIdentities: (input) =>
      Effect.sync(() =>
      {
        const captured = state.providerIdentities.filter(
          (identity) => input?.threadId === undefined || identity.threadId === input.threadId,
        )
        if (state.providerIdentitiesAddedAfterPlan.length > 0)
        {
          state.providerIdentities.push(...state.providerIdentitiesAddedAfterPlan)
          state.providerIdentitiesAddedAfterPlan = []
        }
        return captured
      }),
    getSessionIdentityState: () => Effect.succeed(Option.none()),
    matchesSessionIdentity: (identity) =>
      Effect.succeed(
        state.providerIdentities.some((current) => sameProviderIdentity(current, identity)),
      ),
    stopSessionIfExact: (identity) =>
      Effect.suspend(() =>
        Effect.gen(function* ()
        {
          state.providerStops.push(
            `${identity.providerInstanceId}:${identity.threadId}:${identity.sessionGeneration}`,
          )
          if (state.providerStopGate !== null)
          {
            yield* Deferred.succeed(state.providerStopGate.started, undefined)
            yield* Deferred.await(state.providerStopGate.release)
          }
          if (state.providerStopFailures > 0)
          {
            state.providerStopFailures -= 1
            return yield* Effect.die(new Error('simulated provider exact-stop failure'))
          }
          const identityIndex = state.providerIdentities.findIndex((current) =>
            sameProviderIdentity(current, identity),
          )
          if (identityIndex === -1)
          {
            return false
          }
          state.providerIdentities.splice(identityIndex, 1)
          return true
        }),
      ),
    getAdmissionHandoffHighWater: Effect.succeed(null),
    resumeAdmissionAfterHandoff: Effect.void,
    shutdown: Effect.succeed(0),
    listSessions: () => Effect.succeed([]),
    getCapabilities: () => Effect.succeed(CODEX_PROVIDER_CAPABILITIES),
    getInstanceInfo: (instanceId) =>
    {
      const driverKind = ProviderDriverKind.make(String(instanceId))
      return Effect.succeed({
        instanceId,
        driverKind,
        displayName: undefined,
        enabled: true,
        continuationIdentity: {
          driverKind,
          continuationKey: `${driverKind}:instance:${instanceId}`,
        },
      })
    },
    rollbackConversation: () => unsupported(),
    rollbackConversationIfExact: () => Effect.succeed(false),
    getConversationTurnCountIfExact: () => Effect.succeed(Option.none()),
    get streamEvents()
    {
      return Stream.empty
    },
  }

  return ThreadArchiveReactorLive.pipe(
    Layer.provideMerge(orchestrationLayer),
    Layer.provideMerge(archiveLifecyclePermit),
    Layer.provideMerge(ProjectionThreadRepositoryLive.pipe(Layer.provide(persistence))),
    Layer.provideMerge(persistence),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(Layer.succeed(ProviderService, providerService)),
    Layer.provideMerge(
      Layer.mock(TerminalManager.TerminalManager)({
        captureLifecycleIdentities: (input) =>
          Effect.succeed(
            state.terminalIdentities
              .filter((identity) => identity.threadId === input.threadId)
              .toSorted((left, right) => left.terminalId.localeCompare(right.terminalId)),
          ),
        closeIfExact: (identity) =>
          Effect.suspend(() =>
          {
            state.terminalStops.push(`${identity.terminalId}:${identity.lifecycleId}`)
            if (state.terminalStopFailures > 0)
            {
              state.terminalStopFailures -= 1
              return Effect.die(new Error('simulated terminal exact-close failure'))
            }
            const index = state.terminalIdentities.findIndex((current) =>
              sameTerminalIdentity(current, identity),
            )
            if (index === -1)
            {
              return Effect.succeed(false)
            }
            state.terminalIdentities.splice(index, 1)
            return Effect.succeed(true)
          }),
      }),
    ),
    Layer.provideMerge(RuntimeRecoveryPolicyRegistryLive),
  )
}

const seedThread = Effect.fn('seedArchiveThread')(function* (
  engine: OrchestrationEngineService['Service'],
)
{
  yield* engine.dispatch({
    type: 'project.create',
    commandId: CommandId.make('cmd-archive-project'),
    projectId: ProjectId.make('archive-project'),
    title: 'Archive project',
    workspaceRoot: '/tmp/archive-project',
    defaultModelSelection: { instanceId: providerInstanceId, model: 'gpt-5-codex' },
    createdAt: ARCHIVE_TIME,
  })
  yield* engine.dispatch({
    type: 'thread.create',
    commandId: CommandId.make('cmd-archive-thread'),
    threadId,
    projectId: ProjectId.make('archive-project'),
    title: 'Archive thread',
    modelSelection: { instanceId: providerInstanceId, model: 'gpt-5-codex' },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: 'approval-required',
    branch: null,
    worktreePath: null,
    createdAt: ARCHIVE_TIME,
  })
})

const archiveThread = (engine: OrchestrationEngineService['Service'], commandId: string) =>
  engine.dispatch({
    type: 'thread.archive',
    commandId: CommandId.make(commandId),
    threadId,
  })

const readActions = Effect.fn('readArchiveActions')(function* ()
{
  const sql = yield* SqlClient.SqlClient
  return yield* sql<{
    readonly actionId: string
    readonly sourceSequence: number
    readonly outputIndex: number
    readonly effectKind: string
    readonly targetKind: string
    readonly targetId: string
    readonly payloadJson: string
    readonly status: string
    readonly attemptCount: number
    readonly operationVersion: number
  }>`
    SELECT
      action_id AS "actionId",
      source_sequence AS "sourceSequence",
      output_index AS "outputIndex",
      effect_kind AS "effectKind",
      target_kind AS "targetKind",
      target_id AS "targetId",
      payload_json AS "payloadJson",
      status,
      attempt_count AS "attemptCount",
      operation_version AS "operationVersion"
    FROM orchestration_reactor_actions
    WHERE reactor_id = 'thread-archive'
    ORDER BY source_sequence ASC, output_index ASC
  `
})

function makeState(): HarnessState
{
  return {
    providerIdentities: [
      {
        provider: providerKind,
        providerInstanceId,
        threadId,
        sessionGeneration: 1,
        createdAt: BEFORE_ARCHIVE,
      },
    ],
    providerIdentitiesAddedAfterPlan: [],
    terminalIdentities: [
      {
        threadId,
        terminalId: 'default',
        lifecycleId: 'terminal-lifecycle-1',
        startedAt: BEFORE_ARCHIVE,
      },
      {
        threadId,
        terminalId: 'sidecar',
        lifecycleId: 'terminal-lifecycle-sidecar-1',
        startedAt: BEFORE_ARCHIVE,
      },
    ],
    providerStopFailures: 0,
    terminalStopFailures: 0,
    providerStopGate: null,
    providerStops: [],
    terminalStops: [],
  }
}

describe('ThreadArchiveReactor', () =>
{
  it.effect('starts at the current snapshot without guessing historical cleanup identities', () =>
  {
    const state = makeState()
    return Effect.scoped(
      Effect.gen(function* ()
      {
        yield* TestClock.setTime(Date.parse(ARCHIVE_TIME))
        const engine = yield* OrchestrationEngineService
        const reactor = yield* ThreadArchiveReactor
        yield* seedThread(engine)
        yield* archiveThread(engine, 'cmd-archive-before-cutover')

        yield* reactor.start()
        yield* reactor.drain

        expect(yield* readActions()).toEqual([])
        expect(state.providerIdentities).toHaveLength(1)
        expect(state.terminalIdentities).toHaveLength(2)

        yield* engine.dispatch({
          type: 'thread.unarchive',
          commandId: CommandId.make('cmd-unarchive-after-cutover'),
          threadId,
        })
        yield* TestClock.adjust('1 second')
        yield* archiveThread(engine, 'cmd-archive-after-cutover')
        yield* reactor.drain

        const actions = yield* readActions()
        expect(
          actions.map((action) => decodeArchiveActionPayload(action.payloadJson).archiveGeneration),
        ).toEqual([2])
        expect(state.providerStops).toHaveLength(1)
        expect(state.terminalStops).toHaveLength(2)
      }).pipe(Effect.provide(makeLayer(state))),
    )
  })

  it.effect('replays pre-archive identities despite a backward wall clock', () =>
  {
    const state = makeState()
    state.providerIdentities = [
      {
        provider: providerKind,
        providerInstanceId,
        threadId,
        sessionGeneration: 1,
        createdAt: CLOCK_ROLLBACK_RESOURCE_TIME,
      },
    ]
    state.terminalIdentities = state.terminalIdentities.map((identity) => ({
      ...identity,
      startedAt: CLOCK_ROLLBACK_RESOURCE_TIME,
    }))
    return Effect.scoped(
      Effect.gen(function* ()
      {
        yield* TestClock.setTime(Date.parse(ARCHIVE_TIME))
        const engine = yield* OrchestrationEngineService
        const reactor = yield* ThreadArchiveReactor
        const delivery = yield* OrchestrationReactorDelivery
        yield* delivery.ensureProgress({
          reactorId: 'thread-archive',
          operationVersion: 1,
          initialSequence: 0,
          mode: 'durable',
          now: ARCHIVE_TIME,
        })
        yield* seedThread(engine)
        yield* archiveThread(engine, 'cmd-archive-first')

        yield* reactor.start()
        yield* reactor.drain
        yield* reactor.drain

        const actions = yield* readActions()
        expect(
          actions.map(({ effectKind, status, attemptCount }) => ({
            effectKind,
            status,
            attemptCount,
          })),
        ).toEqual([
          {
            effectKind: 'thread.archive.cleanup-exact',
            status: 'succeeded',
            attemptCount: 1,
          },
        ])
        expect(actions.every((action) => action.targetId.endsWith(',1]'))).toBe(true)
        const action = actions[0]
        expect(action).toBeDefined()
        if (!action) return
        expect(decodeArchiveActionId(action.actionId)).toEqual([
          'thread-archive',
          action.sourceSequence,
          action.outputIndex,
          action.effectKind,
          action.targetKind,
          action.targetId,
          action.operationVersion,
        ])
        expect(decodeArchiveActionPayload(action.payloadJson)).toEqual({
          threadId,
          archiveGeneration: 1,
          archivedAt: ARCHIVE_TIME,
          providerIdentity: {
            provider: providerKind,
            providerInstanceId,
            threadId,
            sessionGeneration: 1,
            createdAt: CLOCK_ROLLBACK_RESOURCE_TIME,
          },
          providerIdentities: [
            {
              provider: providerKind,
              providerInstanceId,
              threadId,
              sessionGeneration: 1,
              createdAt: CLOCK_ROLLBACK_RESOURCE_TIME,
            },
          ],
          terminalIdentities: [
            {
              threadId,
              terminalId: 'default',
              lifecycleId: 'terminal-lifecycle-1',
              startedAt: CLOCK_ROLLBACK_RESOURCE_TIME,
            },
            {
              threadId,
              terminalId: 'sidecar',
              lifecycleId: 'terminal-lifecycle-sidecar-1',
              startedAt: CLOCK_ROLLBACK_RESOURCE_TIME,
            },
          ],
        })
        expect(state.providerStops).toHaveLength(1)
        expect(state.terminalStops).toHaveLength(2)
      }).pipe(Effect.provide(makeLayer(state))),
    )
  })

  it.effect('stops every planned and newly-open provider generation exactly', () =>
  {
    const state = makeState()
    const plannedClaude = {
      provider: ProviderDriverKind.make('claudeAgent'),
      providerInstanceId: ProviderInstanceId.make('claude'),
      threadId,
      sessionGeneration: 4,
      createdAt: BEFORE_ARCHIVE,
    }
    const lateCursor = {
      provider: ProviderDriverKind.make('cursor'),
      providerInstanceId: ProviderInstanceId.make('cursor'),
      threadId,
      sessionGeneration: 7,
      createdAt: ARCHIVE_TIME,
    }
    state.providerIdentities.push(plannedClaude)
    state.providerIdentitiesAddedAfterPlan = [lateCursor]
    return Effect.scoped(
      Effect.gen(function* ()
      {
        yield* TestClock.setTime(Date.parse(ARCHIVE_TIME))
        const engine = yield* OrchestrationEngineService
        const reactor = yield* ThreadArchiveReactor
        yield* reactor.start()
        yield* seedThread(engine)
        yield* archiveThread(engine, 'cmd-archive-all-provider-generations')
        yield* reactor.drain

        const action = (yield* readActions())[0]
        expect(action?.status).toBe('succeeded')
        expect(
          action === undefined
            ? []
            : decodeArchiveActionPayload(action.payloadJson).providerIdentities?.map(
                (identity) => `${identity.providerInstanceId}:${identity.sessionGeneration}`,
              ),
        ).toEqual(['codex:1', 'claude:4'])
        expect(state.providerStops).toEqual(
          expectedProviderGenerationStopKeys([
            { providerInstanceId, threadId, sessionGeneration: 1 },
            plannedClaude,
            lateCursor,
          ]),
        )
        expect(state.providerIdentities).toEqual([])
      }).pipe(Effect.provide(makeLayer(state))),
    )
  })

  it.effect('fences unarchive replacements and closes only the next archive generation', () =>
  {
    const state = makeState()
    state.providerStopFailures = 1
    return Effect.scoped(
      Effect.gen(function* ()
      {
        yield* TestClock.setTime(Date.parse(ARCHIVE_TIME))
        const engine = yield* OrchestrationEngineService
        const reactor = yield* ThreadArchiveReactor
        yield* reactor.start()
        yield* seedThread(engine)
        yield* archiveThread(engine, 'cmd-archive-generation-1')
        yield* reactor.drain

        yield* TestClock.adjust('1 second')
        yield* engine.dispatch({
          type: 'thread.unarchive',
          commandId: CommandId.make('cmd-unarchive-generation-1'),
          threadId,
        })
        state.providerIdentities = [
          {
            provider: providerKind,
            providerInstanceId,
            threadId,
            sessionGeneration: 2,
            createdAt: '2026-08-09T12:00:01.000Z',
          },
        ]
        state.terminalIdentities = [
          {
            threadId,
            terminalId: 'default',
            lifecycleId: 'terminal-lifecycle-2',
            startedAt: '2026-08-09T12:00:01.000Z',
          },
        ]
        yield* TestClock.adjust('1 second')
        yield* archiveThread(engine, 'cmd-archive-generation-2')
        yield* reactor.drain

        const actions = yield* readActions()
        expect(
          actions.map((action) => decodeArchiveActionPayload(action.payloadJson).archiveGeneration),
        ).toEqual([1, 2])
        expect(actions.every((action) => action.status === 'succeeded')).toBe(true)
        expect(state.providerStops).toEqual([
          'codex:thread-archive-reactor-test:1',
          'codex:thread-archive-reactor-test:2',
        ])
        expect(state.terminalStops).toEqual(['default:terminal-lifecycle-2'])
      }).pipe(Effect.provide(makeLayer(state))),
    )
  })

  it.effect('holds unarchive commit behind exact cleanup for the same thread', () =>
  {
    const state = makeState()
    return Effect.scoped(
      Effect.gen(function* ()
      {
        state.providerStopGate = {
          started: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        }
        yield* TestClock.setTime(Date.parse(ARCHIVE_TIME))
        const engine = yield* OrchestrationEngineService
        const reactor = yield* ThreadArchiveReactor
        yield* reactor.start()
        yield* seedThread(engine)
        yield* archiveThread(engine, 'cmd-archive-interleaving')
        yield* Deferred.await(state.providerStopGate.started)

        const unarchive = yield* Effect.forkChild(
          engine.dispatch({
            type: 'thread.unarchive',
            commandId: CommandId.make('cmd-unarchive-interleaving'),
            threadId,
          }),
        )
        yield* Effect.yieldNow
        expect(unarchive.pollUnsafe()).toBeUndefined()

        yield* Deferred.succeed(state.providerStopGate.release, undefined)
        yield* Fiber.join(unarchive)
        yield* reactor.drain

        expect(state.providerIdentities).toEqual([])
        expect(state.terminalIdentities).toEqual([])
        expect(state.providerStops).toEqual(['codex:thread-archive-reactor-test:1'])
      }).pipe(Effect.provide(makeLayer(state))),
    )
  })

  it.effect('surfaces partial exact-close exhaustion as read-only manual recovery', () =>
  {
    const state = makeState()
    state.terminalStopFailures = 20
    return Effect.scoped(
      Effect.gen(function* ()
      {
        yield* TestClock.setTime(Date.parse(ARCHIVE_TIME))
        const engine = yield* OrchestrationEngineService
        const reactor = yield* ThreadArchiveReactor
        const policy = yield* RuntimeRecoveryPolicyRegistry
        yield* reactor.start()
        yield* seedThread(engine)
        yield* archiveThread(engine, 'cmd-archive-partial-failure')
        yield* reactor.drain
        for (let attempt = 1; attempt < 8; attempt += 1)
        {
          yield* TestClock.adjust('5 minutes')
          yield* reactor.drain
        }

        const actions = yield* readActions()
        expect(
          actions.map(({ effectKind, status, attemptCount }) => ({
            effectKind,
            status,
            attemptCount,
          })),
        ).toEqual([
          {
            effectKind: 'thread.archive.cleanup-exact',
            status: 'manual',
            attemptCount: 8,
          },
        ])
        expect(
          policy.describe({
            reactorId: 'thread-archive',
            effectKind: 'thread.archive.cleanup-exact',
            operationVersion: 1,
            status: 'manual',
          }).allowedActions,
        ).toEqual([])
      }).pipe(Effect.provide(makeLayer(state))),
    )
  })
})
