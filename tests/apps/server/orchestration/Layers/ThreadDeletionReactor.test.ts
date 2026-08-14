// tests/apps/server/orchestration/Layers/ThreadDeletionReactor.test.ts
// verifies durable ordered thread deletion cleanup and replay

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  IsoDateTime,
  NonNegativeInt,
  OrchestrationEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from '@t3tools/contracts'
import { it } from '@effect/vitest'
import * as NodeServices from '@effect/platform-node/NodeServices'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import * as TestClock from 'effect/testing/TestClock'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import { describe, expect } from 'vite-plus/test'

import { CurrentWorktreeArchitectureService } from '../../../../../apps/server/src/cartographer/CurrentWorktreeArchitectureService.ts'
import { ThreadDeletionReactorLive } from '../../../../../apps/server/src/orchestration/Layers/ThreadDeletionReactor.ts'
import { OrchestrationEngineWithArchivePermitLive } from '../../../../../apps/server/src/orchestration/Layers/OrchestrationEngine.ts'
import { OrchestrationProjectionPipelineLive } from '../../../../../apps/server/src/orchestration/Layers/ProjectionPipeline.ts'
import { ThreadArchiveLifecyclePermitLive } from '../../../../../apps/server/src/orchestration/Layers/ThreadArchiveLifecyclePermit.ts'
import { ServerConfig } from '../../../../../apps/server/src/config.ts'
import { OrchestrationProjectionSnapshotQueryLive } from '../../../../../apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts'
import { OrchestrationEngineService } from '../../../../../apps/server/src/orchestration/Services/OrchestrationEngine.ts'
import { ThreadDeletionReactor } from '../../../../../apps/server/src/orchestration/Services/ThreadDeletionReactor.ts'
import { OrchestrationCommandReceiptRepositoryLive } from '../../../../../apps/server/src/persistence/Layers/OrchestrationCommandReceipts.ts'
import { OrchestrationEventStoreLive } from '../../../../../apps/server/src/persistence/Layers/OrchestrationEventStore.ts'
import { ProviderRuntimeInboxLive } from '../../../../../apps/server/src/persistence/Layers/ProviderRuntimeInbox.ts'
import { SqlitePersistenceMemory } from '../../../../../apps/server/src/persistence/Layers/Sqlite.ts'
import { OrchestrationReactorDelivery } from '../../../../../apps/server/src/persistence/Services/OrchestrationReactorDelivery.ts'
import { AttachmentLifecycleRepositoryLive } from '../../../../../apps/server/src/persistence/Layers/AttachmentLifecycle.ts'
import { CheckpointRevertOperationsLive } from '../../../../../apps/server/src/persistence/Layers/CheckpointRevertOperations.ts'
import { ProposalGenerationService } from '../../../../../apps/server/src/proposal/ProposalGenerationService.ts'
import {
  ProviderService,
  type ProviderSessionIdentityCapture,
  type ProviderServiceShape,
} from '../../../../../apps/server/src/provider/Services/ProviderService.ts'
import { CODEX_PROVIDER_CAPABILITIES } from '../../../../../apps/server/src/provider/providerCapabilities.ts'
import * as RepositoryIdentityResolver from '../../../../../apps/server/src/project/RepositoryIdentityResolver.ts'
import * as TerminalManager from '../../../../../apps/server/src/terminal/Manager.ts'
import { expectedProviderGenerationStopKeys } from '../../support/threadLifecycleGenerationClose.ts'

const FIXTURE_TIME = '2026-01-01T00:00:00.000Z'
const FIXTURE_TIME_MS = Date.parse(FIXTURE_TIME)
const threadId = ThreadId.make('thread-deletion-reactor-test')
const providerKind = ProviderDriverKind.make('codex')
const providerInstanceId = ProviderInstanceId.make('codex')
const ProviderDeletionIdentity = Schema.Struct({
  provider: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId,
  threadId: ThreadId,
  sessionGeneration: NonNegativeInt,
  createdAt: IsoDateTime,
})
const StoredProviderDeletionPayload = Schema.fromJsonString(
  Schema.Struct({
    event: OrchestrationEvent,
    providerIdentities: Schema.Array(ProviderDeletionIdentity),
  }),
)
const decodeProviderDeletionPayload = Schema.decodeUnknownSync(StoredProviderDeletionPayload)
const encodeProviderDeletionPayload = Schema.encodeSync(StoredProviderDeletionPayload)

class CleanupFailure extends Schema.TaggedErrorClass<CleanupFailure>()('CleanupFailure', {
  operation: Schema.String,
})
{}

interface HarnessState
{
  readonly calls: Array<string>
  readonly providerStops: string[]
  providerIdentities: ProviderSessionIdentityCapture[]
  providerIdentitiesAddedAfterPlan: ProviderSessionIdentityCapture[]
  cancellationFails: boolean
}

const unsupported = <A>() =>
  Effect.die(new Error('Unsupported provider call in test')) as Effect.Effect<A, never>

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

function makeState(cancellationFails: boolean): HarnessState
{
  return {
    calls: [],
    providerStops: [],
    providerIdentities: [
      {
        provider: providerKind,
        providerInstanceId,
        threadId,
        sessionGeneration: 1,
        createdAt: FIXTURE_TIME,
      },
    ],
    providerIdentitiesAddedAfterPlan: [],
    cancellationFails,
  }
}

function makeLayer(state: HarnessState)
{
  const persistence = Layer.fresh(SqlitePersistenceMemory)
  const archiveLifecyclePermit = Layer.fresh(ThreadArchiveLifecyclePermitLive)
  const orchestrationLayer = OrchestrationEngineWithArchivePermitLive.pipe(
    // provideMerge so the reactor can also read the snapshot sequence when it
    // seeds its durable cursor
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
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: 't3-thread-deletion-test-' })),
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
      Effect.sync(() =>
      {
        state.providerStops.push(
          `${identity.providerInstanceId}:${identity.threadId}:${identity.sessionGeneration}`,
        )
        const identityIndex = state.providerIdentities.findIndex((current) =>
          sameProviderIdentity(current, identity),
        )
        if (identityIndex === -1)
        {
          return false
        }
        state.providerIdentities.splice(identityIndex, 1)
        state.calls.push('provider-session')
        return true
      }),
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

  return ThreadDeletionReactorLive.pipe(
    Layer.provideMerge(orchestrationLayer),
    Layer.provideMerge(archiveLifecyclePermit),
    Layer.provideMerge(persistence),
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
      Layer.mock(CurrentWorktreeArchitectureService)({
        closeThread: () =>
          Effect.sync(() =>
          {
            state.calls.push('current-worktree-architecture')
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
    readonly effectKind: string
    readonly outputIndex: number
    readonly status: string
    readonly attemptCount: number
  }>`
    SELECT
      effect_kind AS "effectKind",
      output_index AS "outputIndex",
      status,
      attempt_count AS "attemptCount"
    FROM orchestration_reactor_actions
    WHERE reactor_id = 'thread-deletion'
    ORDER BY output_index ASC
  `
})

const seedLegacyEmbedAction = Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    UPDATE orchestration_reactor_actions
    SET effect_kind = 'cartographer-embed.close'
    WHERE reactor_id = 'thread-deletion'
      AND output_index = 1
  `
})

function rewriteProviderActionIdentities(
  rewrite: (
    identities: ReadonlyArray<ProviderSessionIdentityCapture>,
  ) => ReadonlyArray<ProviderSessionIdentityCapture>,
)
{
  return Effect.gen(function* ()
  {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ readonly payloadJson: string }>`
      SELECT payload_json AS "payloadJson"
      FROM orchestration_reactor_actions
      WHERE reactor_id = 'thread-deletion'
        AND effect_kind = 'provider-session.stop'
    `
    const row = rows[0]
    if (row === undefined)
    {
      return yield* Effect.die(new Error('Provider deletion action was not materialized.'))
    }
    const payload = decodeProviderDeletionPayload(row.payloadJson)
    const payloadJson = encodeProviderDeletionPayload({
      ...payload,
      providerIdentities: [...rewrite(payload.providerIdentities)],
    })
    yield* sql`
      UPDATE orchestration_reactor_actions
      SET payload_json = ${payloadJson}
      WHERE reactor_id = 'thread-deletion'
        AND effect_kind = 'provider-session.stop'
    `
  })
}

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
  it.effect('persists cancellation failure and replays a legacy embed cleanup in order', () =>
  {
    const state = makeState(true)
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
          {
            effectKind: 'proposal-generation.cancel',
            outputIndex: 0,
            status: 'retryable',
            attemptCount: 1,
          },
          {
            effectKind: 'current-worktree-architecture.close',
            outputIndex: 1,
            status: 'pending',
            attemptCount: 0,
          },
          {
            effectKind: 'provider-session.stop',
            outputIndex: 2,
            status: 'pending',
            attemptCount: 0,
          },
          {
            effectKind: 'terminal.close-and-delete-history',
            outputIndex: 3,
            status: 'pending',
            attemptCount: 0,
          },
        ])
        expect(yield* readCursor()).toBe(2)

        yield* seedLegacyEmbedAction
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
          'current-worktree-architecture',
          'provider-session',
          'terminals',
        ])
        expect(yield* readCursor()).toBe(3)
      }).pipe(Effect.provide(makeLayer(state))),
    )
  })

  it.effect('replays a deletion appended before start', () =>
  {
    const state = makeState(false)
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
          'current-worktree-architecture',
          'provider-session',
          'terminals',
        ])
        expect(yield* readCursor()).toBe(3)
      }).pipe(Effect.provide(makeLayer(state))),
    )
  })

  it.effect('stops every planned and newly-open provider generation exactly', () =>
  {
    const state = makeState(false)
    const plannedClaude = {
      provider: ProviderDriverKind.make('claudeAgent'),
      providerInstanceId: ProviderInstanceId.make('claude'),
      threadId,
      sessionGeneration: 3,
      createdAt: FIXTURE_TIME,
    }
    const lateCursor = {
      provider: ProviderDriverKind.make('cursor'),
      providerInstanceId: ProviderInstanceId.make('cursor'),
      threadId,
      sessionGeneration: 8,
      createdAt: FIXTURE_TIME,
    }
    state.providerIdentities.push(plannedClaude)
    state.providerIdentitiesAddedAfterPlan = [lateCursor]
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

        expect((yield* readActionRows()).every((row) => row.status === 'succeeded')).toBe(true)
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

  it.effect('poisons mismatched and duplicate provider cleanup identities', () =>
    Effect.forEach(
      [
        {
          label: 'mismatched',
          rewrite: (identities: ReadonlyArray<ProviderSessionIdentityCapture>) => [
            {
              ...identities[0]!,
              threadId: ThreadId.make('thread-deletion-payload-mismatch'),
            },
          ],
        },
        {
          label: 'duplicate',
          rewrite: (identities: ReadonlyArray<ProviderSessionIdentityCapture>) => [
            identities[0]!,
            identities[0]!,
          ],
        },
      ],
      (scenario) =>
      {
        const state = makeState(true)
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

            yield* rewriteProviderActionIdentities(scenario.rewrite)
            state.cancellationFails = false
            yield* TestClock.adjust('1 second')
            yield* reactor.drain

            expect(
              (yield* readActionRows()).find((row) => row.effectKind === 'provider-session.stop'),
              scenario.label,
            ).toMatchObject({ status: 'poison', attemptCount: 1 })
            expect(state.providerStops, scenario.label).toEqual([])
            expect(state.providerIdentities, scenario.label).toHaveLength(1)
          }).pipe(Effect.provide(makeLayer(state))),
        )
      },
      { discard: true },
    ),
  )

  it.effect('does not repeat completed cleanup on duplicate delivery', () =>
  {
    const state = makeState(false)
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
          'current-worktree-architecture',
          'provider-session',
          'terminals',
        ])
        expect((yield* readActionRows()).every((row) => row.attemptCount === 1)).toBe(true)
      }).pipe(Effect.provide(makeLayer(state))),
    )
  })
})
