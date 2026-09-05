// apps/server/src/ws/handlers/orchestrationThreadStreamHandlers.ts
// thread detail subscribe stream websocket rpc handlers

import {
  type OrchestrationEvent,
  OrchestrationGetSnapshotError,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadStreamItem,
  ORCHESTRATION_WS_METHODS,
  type WsRpcGroup,
} from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Queue from 'effect/Queue'
import * as Stream from 'effect/Stream'
import type * as RpcGroup from 'effect/unstable/rpc/RpcGroup'

import {
  projectActivityEvent,
  projectThreadDetailSnapshot,
} from '../../orchestration/ActivityPayloadProjection.ts'
import type * as OrchestrationEngine from '../../orchestration/Services/OrchestrationEngine.ts'
import type * as ProjectionSnapshotQuery from '../../orchestration/Services/ProjectionSnapshotQuery.ts'
import type { makeRpcAuthorization } from '../rpcAuthorization.ts'

type WsRpcHandlers = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof WsRpcGroup>>
type ThreadStreamRpcHandlers = Pick<WsRpcHandlers, typeof ORCHESTRATION_WS_METHODS.subscribeThread>

export interface OrchestrationThreadStreamHandlerDependencies
{
  readonly orchestrationEngine: OrchestrationEngine.OrchestrationEngineService['Service']
  readonly projectionSnapshotQuery: ProjectionSnapshotQuery.ProjectionSnapshotQuery['Service']
  readonly observeRpcStreamEffect: ReturnType<typeof makeRpcAuthorization>['observeRpcStreamEffect']
}

export function isThreadDetailEvent(event: OrchestrationEvent): event is Extract<
  OrchestrationEvent,
  {
    type:
      | 'thread.message-sent'
      | 'thread.proposed-plan-upserted'
      | 'thread.orchestrate-plan-upserted'
      | 'thread.orchestrate-plan-response-requested'
      | 'thread.orchestrate-run-execution-admitted'
      | 'thread.orchestrate-run-execution-updated'
      | 'thread.activity-appended'
      | 'thread.turn-diff-completed'
      | 'thread.reverted'
      | 'thread.session-set'
      | 'thread.provider-switch-requested'
      | 'thread.provider-switch-progressed'
      | 'thread.provider-switch-failed'
      | 'thread.provider-switched'
      | 'thread.handoff-cleared'
  }
>
{
  return (
    event.type === 'thread.message-sent' ||
    event.type === 'thread.proposed-plan-upserted' ||
    event.type === 'thread.orchestrate-plan-upserted' ||
    event.type === 'thread.orchestrate-plan-response-requested' ||
    event.type === 'thread.orchestrate-run-execution-admitted' ||
    event.type === 'thread.orchestrate-run-execution-updated' ||
    event.type === 'thread.activity-appended' ||
    event.type === 'thread.turn-diff-completed' ||
    event.type === 'thread.reverted' ||
    event.type === 'thread.session-set' ||
    event.type === 'thread.provider-switch-requested' ||
    event.type === 'thread.provider-switch-progressed' ||
    event.type === 'thread.provider-switch-failed' ||
    event.type === 'thread.provider-switched' ||
    event.type === 'thread.handoff-cleared'
  )
}

const THREAD_RESUME_MAX_EVENTS = 1_000
const ORCHESTRATION_REPLAY_PAYLOAD_BUDGET_BYTES = 8 * 1024 * 1024

export function makeOrchestrationThreadStreamHandlers({
  orchestrationEngine,
  projectionSnapshotQuery,
  observeRpcStreamEffect,
}: OrchestrationThreadStreamHandlerDependencies)
{
  return {
    [ORCHESTRATION_WS_METHODS.subscribeThread]: (input) =>
      observeRpcStreamEffect(
        ORCHESTRATION_WS_METHODS.subscribeThread,
        Effect.gen(function* ()
        {
          const isThisThreadDetailEvent = (event: OrchestrationEvent) =>
            event.aggregateKind === 'thread' &&
            event.aggregateId === input.threadId &&
            isThreadDetailEvent(event)

          const liveStream = orchestrationEngine.streamDomainEvents.pipe(
            Stream.filter(isThisThreadDetailEvent),
            Stream.map((event) => ({
              kind: 'event' as const,
              event: projectActivityEvent(event),
            })),
          )

          // attach live delivery before reading either replay or snapshot state.
          // otherwise an event published while the snapshot is loading is lost.
          const liveBuffer = yield* Queue.unbounded<OrchestrationThreadStreamItem>()
          yield* Effect.forkScoped(
            liveStream.pipe(Stream.runForEach((item) => Queue.offer(liveBuffer, item))),
            { startImmediately: true },
          )
          const bufferedLiveStream = Stream.fromQueue(liveBuffer)
          let replayOnMissingSnapshot:
            Stream.Stream<OrchestrationThreadStreamItem, OrchestrationGetSnapshotError> | undefined
          const loadSnapshot = projectionSnapshotQuery.getThreadDetailSnapshot(input.threadId).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationGetSnapshotError({
                  message: `Failed to load thread ${input.threadId}`,
                  cause,
                }),
            ),
          )
          const afterCatchUp =
            input.requestCompletionMarker === true
              ? Stream.concat(
                  Stream.fromEffect(
                    Queue.offer(liveBuffer, { kind: 'synchronized' as const }),
                  ).pipe(Stream.drain),
                  bufferedLiveStream,
                )
              : bufferedLiveStream
          const snapshotThenLive = (snapshot: OrchestrationThreadDetailSnapshot) =>
            Stream.concat(
              Stream.make({
                kind: 'snapshot' as const,
                snapshot: projectThreadDetailSnapshot(snapshot),
              }),
              afterCatchUp,
            )

          // when the client already loaded the snapshot over HTTP it passes
          // that snapshot's sequence, and we resume the live subscription by
          // replaying persisted events after it instead of re-sending the
          // (potentially multi-KB) snapshot frame over the socket.
          //
          // the live PubSub subscription must be attached *before* draining
          // the catch-up replay, otherwise events published during the replay
          // window are dropped (they are past the persisted tail the replay
          // read, but the live stream is not yet subscribed). So fork the
          // live stream into a buffer bound to this stream's scope, then emit
          // catch-up followed by the buffered/ongoing live events. Overlapping
          // events are deduped by sequence on the client.
          //
          // measure only this thread's rows and bound the catch-up at the head
          // captured before reading. Unrelated global traffic does not force a
          // reset, while stale or oversized selected ranges use a fresh detail
          // snapshot.
          if (input.afterSequence !== undefined)
          {
            const afterSequence = input.afterSequence
            const headSequence = yield* orchestrationEngine.latestSequence
            const range = {
              threadId: input.threadId,
              fromSequenceExclusive: afterSequence,
              toSequenceInclusive: headSequence,
            }
            const replayStats =
              afterSequence > headSequence
                ? null
                : yield* orchestrationEngine
                    .getThreadReplayStats({
                      ...range,
                      maxEvents: THREAD_RESUME_MAX_EVENTS,
                    })
                    .pipe(
                      Effect.mapError(
                        (cause) =>
                          new OrchestrationGetSnapshotError({
                            message: `Failed to measure thread ${input.threadId} replay range`,
                            cause,
                          }),
                      ),
                    )
            if (
              replayStats !== null &&
              replayStats.eventCount <= THREAD_RESUME_MAX_EVENTS &&
              replayStats.payloadBytes <= ORCHESTRATION_REPLAY_PAYLOAD_BUDGET_BYTES
            )
            {
              const catchUpStream = orchestrationEngine
                .readThreadEvents({ ...range, limit: THREAD_RESUME_MAX_EVENTS })
                .pipe(
                  Stream.filter(isThisThreadDetailEvent),
                  Stream.map((event) => ({
                    kind: 'event' as const,
                    event: projectActivityEvent(event),
                  })),
                  Stream.mapError(
                    (cause) =>
                      new OrchestrationGetSnapshotError({
                        message: `Failed to replay thread ${input.threadId} events`,
                        cause,
                      }),
                  ),
                )
              const replay = Stream.concat(catchUpStream, afterCatchUp)
              if (!replayStats.hasCreateEvent)
              {
                return replay
              }
              replayOnMissingSnapshot = replay
            }
          }

          const snapshot = yield* loadSnapshot

          if (Option.isNone(snapshot))
          {
            // a recreated thread may already be deleted. Preserve its bounded
            // replay so shell subscribers can apply the removal; oversized or
            // invalid ranges still fail because no safe snapshot exists.
            if (replayOnMissingSnapshot !== undefined)
            {
              return replayOnMissingSnapshot
            }
            return yield* new OrchestrationGetSnapshotError({
              message: `Thread ${input.threadId} was not found`,
              cause: input.threadId,
            })
          }
          return snapshotThenLive(snapshot.value)
        }),
        { 'rpc.aggregate': 'orchestration' },
      ),
  } satisfies ThreadStreamRpcHandlers
}
