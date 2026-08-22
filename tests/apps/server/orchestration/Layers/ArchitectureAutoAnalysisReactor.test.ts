// tests/apps/server/orchestration/Layers/ArchitectureAutoAnalysisReactor.test.ts
// verifies durable automatic architecture analysis admission and execution policy

// @effect-diagnostics anyUnknownInErrorContext:off - durable definitions intentionally classify heterogeneous failures

import {
  CheckpointRef,
  CommandId,
  DiffAnalysisError,
  DiffAnalysisId,
  EventId,
  MessageId,
  NonNegativeInt,
  type OrchestrationEvent,
  ProjectId,
  ThreadId,
  TurnId,
  type ArchitectureAutoAnalysis,
  type DiffAnalysisGeneration,
} from '@t3tools/contracts'
import { it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { describe, expect } from 'vite-plus/test'

import {
  type DiffAnalysisTargetInput,
  DiffAnalysisService,
} from '../../../../../apps/server/src/cartographer/DiffAnalysisService.ts'
import {
  ARCHITECTURE_AUTO_ANALYSIS_REACTOR_ID,
  makeArchitectureAutoAnalysisReactor,
} from '../../../../../apps/server/src/orchestration/Layers/ArchitectureAutoAnalysisReactor.ts'
import {
  DurableReactorRunner,
  type DurableReactorDefinition,
  type ReactorEffectResult,
} from '../../../../../apps/server/src/orchestration/Services/DurableReactorRunner.ts'
import {
  ProjectionSnapshotQuery,
  type ProjectionThreadCheckpointContext,
} from '../../../../../apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts'
import {
  type ReactorActionDraft,
  type ReactorActionRecord,
  OrchestrationReactorDelivery,
  type ReactorProgress,
} from '../../../../../apps/server/src/persistence/Services/OrchestrationReactorDelivery.ts'
import {
  layerTest as ServerSettingsTestLayer,
  ServerSettingsService,
} from '../../../../../apps/server/src/serverSettings.ts'
import { makeProjectionSnapshotQueryStub } from '../../projectionSnapshotQueryTestHelpers.ts'

const NOW = '2026-08-07T12:00:00.000Z'
const threadId = ThreadId.make('thread-architecture-auto-analysis')
const projectId = ProjectId.make('project-architecture-auto-analysis')
const Outcome = Schema.fromJsonString(Schema.Struct({ result: Schema.String }))
const ActionTarget = Schema.fromJsonString(Schema.Tuple([ThreadId, TurnId, NonNegativeInt]))
const decodeOutcome = Schema.decodeUnknownSync(Outcome)
const encodeActionTarget = Schema.encodeSync(ActionTarget)

type TurnDiffEvent = Extract<OrchestrationEvent, { type: 'thread.turn-diff-completed' }>

interface HarnessState
{
  definition: DurableReactorDefinition | null
  context: Option.Option<ProjectionThreadCheckpointContext>
  existingProgress: Option.Option<ReactorProgress>
  ensureMode: 'durable' | 'shadow'
  snapshotSequence: number
  snapshotReads: number
  progressInputs: Array<{
    readonly initialSequence: number
    readonly mode: string
  }>
  modeChanges: Array<string>
  requests: Array<DiffAnalysisTargetInput>
  requestFailure: DiffAnalysisError | null
  requestState: DiffAnalysisGeneration['state']
}

function checkpointContext(
  checkpoints: ProjectionThreadCheckpointContext['checkpoints'],
): ProjectionThreadCheckpointContext
{
  return {
    threadId,
    projectId,
    workspaceRoot: '/workspace/project',
    worktreePath: '/workspace/worktrees/thread-architecture-auto-analysis',
    checkpoints,
  }
}

function checkpoint(
  checkpointTurnCount: number,
  status: 'ready' | 'missing' | 'error' = 'ready',
): ProjectionThreadCheckpointContext['checkpoints'][number]
{
  return {
    turnId: TurnId.make(`turn-architecture-auto-${checkpointTurnCount}`),
    checkpointTurnCount,
    checkpointRef: CheckpointRef.make(
      `refs/t3/checkpoints/architecture-auto/${checkpointTurnCount}`,
    ),
    status,
    files: [],
    assistantMessageId: MessageId.make(`message-architecture-auto-${checkpointTurnCount}`),
    completedAt: NOW,
  }
}

function turnDiffEvent(
  input: {
    readonly sequence?: number
    readonly checkpointTurnCount?: number
    readonly status?: 'ready' | 'missing' | 'error'
    readonly files?: ReadonlyArray<{
      readonly path: string
      readonly kind: string
      readonly additions: number
      readonly deletions: number
    }>
  } = {},
): TurnDiffEvent
{
  const sequence = input.sequence ?? 11
  const checkpointTurnCount = input.checkpointTurnCount ?? 4
  return {
    sequence,
    eventId: EventId.make(`event-architecture-auto-${sequence}`),
    aggregateKind: 'thread',
    aggregateId: threadId,
    type: 'thread.turn-diff-completed',
    occurredAt: NOW,
    commandId: CommandId.make(`command-architecture-auto-${sequence}`),
    causationEventId: null,
    correlationId: CommandId.make(`command-architecture-auto-${sequence}`),
    metadata: {},
    payload: {
      threadId,
      turnId: TurnId.make(`turn-architecture-auto-${checkpointTurnCount}`),
      checkpointTurnCount,
      checkpointRef: CheckpointRef.make(
        `refs/t3/checkpoints/architecture-auto/${checkpointTurnCount}`,
      ),
      status: input.status ?? 'ready',
      files: input.files ?? [],
      assistantMessageId: MessageId.make(`message-architecture-auto-${checkpointTurnCount}`),
      completedAt: NOW,
    },
  }
}

function generation(state: DiffAnalysisGeneration['state']): DiffAnalysisGeneration
{
  return {
    version: 1,
    diffAnalysisId: DiffAnalysisId.make('diff-architecture-auto-analysis'),
    sourceKind: 'checkpoint',
    state,
    baseTreeOid: 'a'.repeat(40),
    headTreeOid: 'b'.repeat(40),
    analyzerVersion: 'cartographer-test',
    analysisPolicyVersion: 'diff-analysis-v1',
    sourceCurrent: true,
    baseGraphArtifact: null,
    headGraphArtifact: null,
    impactArtifact: null,
    impactProjectionArtifact: null,
    artifactByteLength: 0,
    errorCode: null,
    createdAt: NOW,
    updatedAt: NOW,
    lastAccessedAt: NOW,
  }
}

function progress(initialSequence: number, mode: 'durable' | 'shadow'): ReactorProgress
{
  return {
    reactorId: ARCHITECTURE_AUTO_ANALYSIS_REACTOR_ID,
    operationVersion: 1,
    mode,
    cursorSequence: initialSequence,
    shadowCursorSequence: initialSequence,
    highWaterSequence: null,
    blockedSequence: null,
    activeOwnerId: null,
    ownerEpoch: 0,
    lastError: null,
    updatedAt: NOW,
  }
}

function makeState(): HarnessState
{
  return {
    definition: null,
    context: Option.some(checkpointContext([checkpoint(4)])),
    existingProgress: Option.none(),
    ensureMode: 'durable',
    snapshotSequence: 73,
    snapshotReads: 0,
    progressInputs: [],
    modeChanges: [],
    requests: [],
    requestFailure: null,
    requestState: 'queued',
  }
}

function makeHarnessLayer(state: HarnessState, initialSetting: ArchitectureAutoAnalysis = 'auto')
{
  return Layer.mergeAll(
    Layer.mock(OrchestrationReactorDelivery)({
      getProgress: () => Effect.succeed(state.existingProgress),
      ensureProgress: (input) =>
        Effect.sync(() =>
        {
          state.progressInputs.push({
            initialSequence: input.initialSequence,
            mode: input.mode,
          })
          return progress(input.initialSequence, state.ensureMode)
        }),
      setMode: (input) =>
        Effect.sync(() =>
        {
          state.modeChanges.push(input.mode)
          return progress(0, input.mode === 'shadow' ? 'shadow' : 'durable')
        }),
    }),
    Layer.mock(DurableReactorRunner)({
      start: (definition) =>
        Effect.sync(() =>
        {
          state.definition = definition
        }),
      drain: () => Effect.void,
    }),
    Layer.succeed(
      ProjectionSnapshotQuery,
      makeProjectionSnapshotQueryStub({
        getSnapshotSequence: () =>
          Effect.sync(() =>
          {
            state.snapshotReads += 1
            return { snapshotSequence: state.snapshotSequence }
          }),
        getThreadCheckpointContext: () => Effect.succeed(state.context),
      }),
    ),
    ServerSettingsTestLayer({ architectureAutoAnalysis: initialSetting }),
    Layer.mock(DiffAnalysisService)({
      request: (input) =>
        Effect.suspend(() =>
        {
          state.requests.push(input)
          return state.requestFailure === null
            ? Effect.succeed(generation(state.requestState))
            : Effect.fail(state.requestFailure)
        }),
    }),
  )
}

function requireDefinition(state: HarnessState): DurableReactorDefinition
{
  if (state.definition === null)
  {
    throw new Error('reactor definition was not registered')
  }
  return state.definition
}

function actionFromDraft(
  event: OrchestrationEvent,
  draft: ReactorActionDraft,
): ReactorActionRecord
{
  return {
    actionId: 'architecture-auto-analysis-action',
    reactorId: ARCHITECTURE_AUTO_ANALYSIS_REACTOR_ID,
    sourceSequence: event.sequence,
    sourceEventId: event.eventId,
    outputIndex: draft.outputIndex,
    effectKind: draft.effectKind,
    targetKind: draft.targetKind,
    targetId: draft.targetId,
    operationVersion: 1,
    payloadJson: draft.payloadJson,
    status: 'leased',
    attemptCount: 1,
    availableAt: NOW,
    leaseOwner: 'architecture-auto-analysis-test',
    leaseEpoch: 1,
    leaseExpiresAt: NOW,
    lastError: null,
    outcomeJson: null,
  }
}

function resultName(result: ReactorEffectResult): string
{
  if (result.resultJson === undefined)
  {
    throw new Error('reactor result did not include an outcome')
  }
  return decodeOutcome(result.resultJson).result
}

const plannedAction = Effect.fn('ArchitectureAutoAnalysisReactorTest.plannedAction')(function* (
  definition: DurableReactorDefinition,
  event: OrchestrationEvent,
)
{
  const actions = yield* definition.plan(event)
  const draft = actions[0]
  if (draft === undefined)
  {
    return yield* Effect.die('ready checkpoint event did not plan an action')
  }
  return actionFromDraft(event, draft)
})

describe('ArchitectureAutoAnalysisReactor', () =>
{
  it.effect('plans only ready checkpoint events, including empty file summaries', () =>
  {
    const state = makeState()
    return Effect.scoped(
      Effect.gen(function* ()
      {
        const reactor = yield* makeArchitectureAutoAnalysisReactor
        yield* reactor.start()
        const definition = requireDefinition(state)
        const ready = turnDiffEvent({ files: [] })
        const actions = yield* definition.plan(ready)
        const replayedActions = yield* definition.plan(ready)

        expect(actions).toHaveLength(1)
        expect(replayedActions).toEqual(actions)
        expect(actions[0]).toMatchObject({
          outputIndex: 0,
          effectKind: 'architecture.diff-analysis.request',
          targetKind: 'thread-turn-checkpoint',
          targetId: encodeActionTarget([threadId, ready.payload.turnId, 4]),
        })
        expect(yield* definition.plan(turnDiffEvent({ status: 'missing' }))).toEqual([])
        expect(yield* definition.plan(turnDiffEvent({ status: 'error' }))).toEqual([])
      }).pipe(Effect.provide(makeHarnessLayer(state))),
    )
  })

  it.effect('seeds a first installation at the current snapshot without backfill', () =>
  {
    const state = makeState()
    state.snapshotSequence = 419
    return Effect.scoped(
      Effect.gen(function* ()
      {
        const reactor = yield* makeArchitectureAutoAnalysisReactor
        yield* reactor.start()

        expect(state.snapshotReads).toBe(1)
        expect(state.progressInputs).toEqual([{ initialSequence: 419, mode: 'durable' }])
        expect(requireDefinition(state).reactorId).toBe(ARCHITECTURE_AUTO_ANALYSIS_REACTOR_ID)
      }).pipe(Effect.provide(makeHarnessLayer(state))),
    )
  })

  it.effect('preserves existing progress and retains the shadow-to-durable cutover', () =>
  {
    const state = makeState()
    state.existingProgress = Option.some(progress(211, 'shadow'))
    state.ensureMode = 'shadow'
    return Effect.scoped(
      Effect.gen(function* ()
      {
        const reactor = yield* makeArchitectureAutoAnalysisReactor
        yield* reactor.start()

        expect(state.snapshotReads).toBe(0)
        expect(state.progressInputs).toEqual([{ initialSequence: 0, mode: 'durable' }])
        expect(state.modeChanges).toEqual(['durable'])
      }).pipe(Effect.provide(makeHarnessLayer(state))),
    )
  })

  it.effect('honors execution-time setting changes and deleted threads as terminal no-ops', () =>
  {
    const state = makeState()
    return Effect.scoped(
      Effect.gen(function* ()
      {
        const reactor = yield* makeArchitectureAutoAnalysisReactor
        const settings = yield* ServerSettingsService
        yield* reactor.start()
        const definition = requireDefinition(state)
        const action = yield* plannedAction(definition, turnDiffEvent())

        yield* settings.updateSettings({ architectureAutoAnalysis: 'on-demand' })
        const disabled = yield* definition.execute(action)
        expect(resultName(disabled)).toBe('setting-not-auto')
        expect(state.requests).toEqual([])

        yield* settings.updateSettings({ architectureAutoAnalysis: 'auto' })
        state.context = Option.none()
        const deleted = yield* definition.execute(action)
        expect(resultName(deleted)).toBe('thread-deleted')
        expect(state.requests).toEqual([])
      }).pipe(Effect.provide(makeHarnessLayer(state))),
    )
  })

  it.effect(
    'supersedes older ready checkpoints and requests the exact adjacent pair otherwise',
    () =>
    {
      const state = makeState()
      return Effect.scoped(
        Effect.gen(function* ()
        {
          const reactor = yield* makeArchitectureAutoAnalysisReactor
          yield* reactor.start()
          const definition = requireDefinition(state)
          const event = turnDiffEvent({ checkpointTurnCount: 4 })
          const action = yield* plannedAction(definition, event)

          state.context = Option.some(checkpointContext([checkpoint(4), checkpoint(5)]))
          const superseded = yield* definition.execute(action)
          expect(resultName(superseded)).toBe('superseded')
          expect(state.requests).toEqual([])

          state.context = Option.some(
            checkpointContext([
              {
                ...checkpoint(4),
                checkpointRef: CheckpointRef.make('refs/t3/checkpoints/architecture-auto/stale'),
              },
            ]),
          )
          const missing = yield* definition.execute(action)
          expect(resultName(missing)).toBe('checkpoint-ref-missing')
          expect(state.requests).toEqual([])

          state.context = Option.some(checkpointContext([checkpoint(4), checkpoint(9, 'error')]))
          const requested = yield* definition.execute(action)
          expect(resultName(requested)).toBe('requested')
          expect(state.requests).toEqual([
            {
              workspaceRoot: '/workspace/worktrees/thread-architecture-auto-analysis',
              source: {
                sourceKind: 'checkpoint',
                threadId,
                fromTurnCount: 3,
                toTurnCount: 4,
              },
            },
          ])

          state.requestState = 'ready'
          const cached = yield* definition.execute(action)
          expect(resultName(cached)).toBe('cache-hit')
        }).pipe(Effect.provide(makeHarnessLayer(state))),
      )
    },
  )

  it.effect(
    'terminalizes expected source failures, retries transients, and poisons bad payloads',
    () =>
    {
      const state = makeState()
      return Effect.scoped(
        Effect.gen(function* ()
        {
          const reactor = yield* makeArchitectureAutoAnalysisReactor
          yield* reactor.start()
          const definition = requireDefinition(state)
          const action = yield* plannedAction(definition, turnDiffEvent())

          for (const expected of [
            ['checkpoint-ref-missing', 'checkpoint-ref-missing'],
            ['thread-not-found', 'thread-deleted'],
            ['not-git-repository', 'non-git'],
            ['unsupported', 'not-ready'],
          ] as const)
          {
            state.requestFailure = new DiffAnalysisError({
              code: expected[0],
              message: `expected ${expected[0]} failure`,
            })
            const result = yield* definition.execute(action)
            expect(resultName(result)).toBe(expected[1])
          }

          state.requestFailure = new DiffAnalysisError({
            code: 'persistence-failed',
            message: 'temporary persistence failure',
          })
          const transient = yield* definition.execute(action).pipe(Effect.flip)
          expect(definition.classify(transient, action)).toBe('retryable')

          state.requestFailure = new DiffAnalysisError({
            code: 'invalid-source',
            message: 'permanent invalid source',
          })
          const permanent = yield* definition.execute(action).pipe(Effect.flip)
          expect(definition.classify(permanent, action)).toBe('manual')

          const invalidAction = { ...action, payloadJson: 'not-json' }
          const invalidPayload = yield* definition.execute(invalidAction).pipe(Effect.flip)
          expect(definition.classify(invalidPayload, invalidAction)).toBe('poison')
        }).pipe(Effect.provide(makeHarnessLayer(state))),
      )
    },
  )
})
