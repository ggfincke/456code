// tests/apps/server/orchestration/Layers/ThreadDeletionReactor.test.ts
// verifies durable ordered thread deletion cleanup and replay

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from '@t3tools/contracts'
import { it } from '@effect/vitest'
import * as NodeServices from '@effect/platform-node/NodeServices'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import * as TestClock from 'effect/testing/TestClock'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import { describe, expect } from 'vite-plus/test'

import { CartographerEmbedBroker } from '../../../../../apps/server/src/cartographer/CartographerEmbedBroker.ts'
import { ThreadDeletionReactorLive } from '../../../../../apps/server/src/orchestration/Layers/ThreadDeletionReactor.ts'
import { OrchestrationEngineLive } from '../../../../../apps/server/src/orchestration/Layers/OrchestrationEngine.ts'
import { OrchestrationProjectionPipelineLive } from '../../../../../apps/server/src/orchestration/Layers/ProjectionPipeline.ts'
import { ServerConfig } from '../../../../../apps/server/src/config.ts'
import { OrchestrationProjectionSnapshotQueryLive } from '../../../../../apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts'
import { OrchestrationEngineService } from '../../../../../apps/server/src/orchestration/Services/OrchestrationEngine.ts'
import { ThreadDeletionReactor } from '../../../../../apps/server/src/orchestration/Services/ThreadDeletionReactor.ts'
import { OrchestrationCommandReceiptRepositoryLive } from '../../../../../apps/server/src/persistence/Layers/OrchestrationCommandReceipts.ts'
import { OrchestrationEventStoreLive } from '../../../../../apps/server/src/persistence/Layers/OrchestrationEventStore.ts'
import { SqlitePersistenceMemory } from '../../../../../apps/server/src/persistence/Layers/Sqlite.ts'
import { OrchestrationReactorDelivery } from '../../../../../apps/server/src/persistence/Services/OrchestrationReactorDelivery.ts'
import { AttachmentLifecycleRepositoryLive } from '../../../../../apps/server/src/persistence/Layers/AttachmentLifecycle.ts'
import { CheckpointRevertOperationsLive } from '../../../../../apps/server/src/persistence/Layers/CheckpointRevertOperations.ts'
import { ProposalGenerationService } from '../../../../../apps/server/src/proposal/ProposalGenerationService.ts'
import {
  ProviderService,
  type ProviderServiceShape,
} from '../../../../../apps/server/src/provider/Services/ProviderService.ts'
import * as RepositoryIdentityResolver from '../../../../../apps/server/src/project/RepositoryIdentityResolver.ts'
import * as TerminalManager from '../../../../../apps/server/src/terminal/Manager.ts'

const FIXTURE_TIME = '2026-01-01T00:00:00.000Z'
const FIXTURE_TIME_MS = Date.parse(FIXTURE_TIME)
const threadId = ThreadId.make('thread-deletion-reactor-test')

class CleanupFailure extends Schema.TaggedErrorClass<CleanupFailure>()('CleanupFailure', {
  operation: Schema.String,
})
{}

interface HarnessState
{
  readonly calls: Array<string>
  cancellationFails: boolean
}

const unsupported = <A>() =>
  Effect.die(new Error('Unsupported provider call in test')) as Effect.Effect<A, never>

function makeLayer(state: HarnessState)
{
  const orchestrationLayer = OrchestrationEngineLive.pipe(
    // provideMerge so the reactor can also read the snapshot sequence when it
    // seeds its durable cursor
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(AttachmentLifecycleRepositoryLive),
    Layer.provideMerge(CheckpointRevertOperationsLive),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: 't3-thread-deletion-test-' })),
  )
  const providerService: ProviderServiceShape = {
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    interruptTurn: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () =>
      Effect.sync(() =>
      {
        state.calls.push('provider-session')
      }),
    listSessions: () => Effect.succeed([]),
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: 'in-session' }),
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
    get streamEvents()
    {
      return Stream.empty
    },
  }

  return ThreadDeletionReactorLive.pipe(
    Layer.provideMerge(orchestrationLayer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(Layer.succeed(ProviderService, providerService)),
    Layer.provideMerge(
      Layer.mock(ProposalGenerationService)({
        // the live service declares a never-failing channel; this mock keeps
        // the runtime failure the reactor must survive and erases the type
        cancelThread: (() =>
          Effect.suspend(() =>
          {
            state.calls.push('proposal-generation')
            return state.cancellationFails
              ? Effect.fail(new CleanupFailure({ operation: 'cancelThread' }))
              : Effect.void
          })) as unknown as (threadId: string) => Effect.Effect<void>,
      }),
    ),
    Layer.provideMerge(
      Layer.mock(CartographerEmbedBroker)({
        closeThread: () =>
          Effect.sync(() =>
          {
            state.calls.push('cartographer-embed')
          }),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(TerminalManager.TerminalManager)({
        close: () =>
          Effect.sync(() =>
          {
            state.calls.push('terminals')
          }),
      }),
    ),
  )
}

const seedThread = Effect.fn('seedThread')(function* (
  engine: OrchestrationEngineService['Service'],
)
{
  yield* engine.dispatch({
    type: 'project.create',
    commandId: CommandId.make('cmd-thread-deletion-project'),
    projectId: ProjectId.make('thread-deletion-project'),
    title: 'Thread deletion project',
    workspaceRoot: '/tmp/thread-deletion-project',
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make('codex'),
      model: 'gpt-5-codex',
    },
    createdAt: FIXTURE_TIME,
  })
  yield* engine.dispatch({
    type: 'thread.create',
    commandId: CommandId.make('cmd-thread-deletion-create'),
    threadId,
    projectId: ProjectId.make('thread-deletion-project'),
    title: 'Thread deletion',
    modelSelection: {
      instanceId: ProviderInstanceId.make('codex'),
      model: 'gpt-5-codex',
    },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: 'approval-required',
    branch: null,
    worktreePath: null,
    createdAt: FIXTURE_TIME,
  })
})

const deleteThread = (engine: OrchestrationEngineService['Service']) =>
  engine.dispatch({
    type: 'thread.delete',
    commandId: CommandId.make('cmd-thread-deletion-delete'),
    threadId,
  })

const readActionRows = Effect.fn('readActionRows')(function* ()
{
  const sql = yield* SqlClient.SqlClient
  return yield* sql<{
    readonly outputIndex: number
    readonly status: string
    readonly attemptCount: number
  }>`
    SELECT
      output_index AS "outputIndex",
      status,
      attempt_count AS "attemptCount"
    FROM orchestration_reactor_actions
    WHERE reactor_id = 'thread-deletion'
    ORDER BY output_index ASC
  `
})

const readCursor = Effect.fn('readCursor')(function* ()
{
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{ readonly cursorSequence: number }>`
    SELECT cursor_sequence AS "cursorSequence"
    FROM orchestration_reactor_progress
    WHERE reactor_id = 'thread-deletion'
  `
  return rows[0]?.cursorSequence
})

describe('ThreadDeletionReactor', () =>
{
  it.effect('persists cancellation failure as retryable and resumes in order', () =>
  {
    const state: HarnessState = { calls: [], cancellationFails: true }
    return Effect.scoped(
      Effect.gen(function* ()
      {
        yield* TestClock.setTime(FIXTURE_TIME_MS)
        const engine = yield* OrchestrationEngineService
        const reactor = yield* ThreadDeletionReactor
        yield* reactor.start()
        yield* seedThread(engine)
        yield* deleteThread(engine)
        yield* reactor.drain

        expect(yield* readActionRows()).toEqual([
          { outputIndex: 0, status: 'retryable', attemptCount: 1 },
          { outputIndex: 1, status: 'pending', attemptCount: 0 },
          { outputIndex: 2, status: 'pending', attemptCount: 0 },
          { outputIndex: 3, status: 'pending', attemptCount: 0 },
        ])
        expect(yield* readCursor()).toBe(2)

        state.cancellationFails = false
        yield* TestClock.adjust('1 second')
        yield* reactor.drain

        expect((yield* readActionRows()).map((row) => row.status)).toEqual([
          'succeeded',
          'succeeded',
          'succeeded',
          'succeeded',
        ])
        expect(state.calls).toEqual([
          'proposal-generation',
          'proposal-generation',
          'cartographer-embed',
          'provider-session',
          'terminals',
        ])
        expect(yield* readCursor()).toBe(3)
      }).pipe(Effect.provide(makeLayer(state))),
    )
  })

  it.effect('replays a deletion appended before start', () =>
  {
    const state: HarnessState = { calls: [], cancellationFails: false }
    return Effect.scoped(
      Effect.gen(function* ()
      {
        yield* TestClock.setTime(FIXTURE_TIME_MS)
        const engine = yield* OrchestrationEngineService
        const reactor = yield* ThreadDeletionReactor
        // a reactor that has run before: its cursor already exists, so an event
        // appended while it was stopped is still owed delivery. without this the
        // first-ever start seeds at the current snapshot and skips history,
        // which is what keeps an upgrade from replaying old deletions
        const delivery = yield* OrchestrationReactorDelivery
        yield* delivery.ensureProgress({
          reactorId: 'thread-deletion',
          operationVersion: 1,
          initialSequence: 0,
          mode: 'durable',
          now: FIXTURE_TIME,
        })
        yield* seedThread(engine)
        yield* deleteThread(engine)

        yield* reactor.start()

        expect(state.calls).toEqual([
          'proposal-generation',
          'cartographer-embed',
          'provider-session',
          'terminals',
        ])
        expect(yield* readCursor()).toBe(3)
      }).pipe(Effect.provide(makeLayer(state))),
    )
  })

  it.effect('does not repeat completed cleanup on duplicate delivery', () =>
  {
    const state: HarnessState = { calls: [], cancellationFails: false }
    return Effect.scoped(
      Effect.gen(function* ()
      {
        yield* TestClock.setTime(FIXTURE_TIME_MS)
        const engine = yield* OrchestrationEngineService
        const reactor = yield* ThreadDeletionReactor
        yield* reactor.start()
        yield* seedThread(engine)
        yield* deleteThread(engine)
        yield* reactor.drain
        yield* deleteThread(engine)
        yield* reactor.drain

        expect(state.calls).toEqual([
          'proposal-generation',
          'cartographer-embed',
          'provider-session',
          'terminals',
        ])
        expect((yield* readActionRows()).every((row) => row.attemptCount === 1)).toBe(true)
      }).pipe(Effect.provide(makeLayer(state))),
    )
  })
})
