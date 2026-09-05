// apps/server/src/persistence/Services/OrchestrationEventStore.ts
// manage orchestration event state

// owns durable append/replay access to the orchestration event stream. It does
// not reduce events into read models or apply command validation rules.
//
// uses Effect `Context.Service` for dependency injection and exposes typed
// persistence/decode errors for event append and replay operations.
//
// @module OrchestrationEventStore
import { OrchestrationEvent } from '@t3tools/contracts'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type * as Stream from 'effect/Stream'

import type { OrchestrationEventStoreError } from '../Errors.ts'

export interface OrchestrationAggregateReplayRange
{
  readonly aggregateKind: OrchestrationEvent['aggregateKind']
  readonly aggregateId: string
  readonly fromSequenceExclusive: number
  readonly toSequenceInclusive: number
}

export interface OrchestrationAggregateReplayStats
{
  readonly eventCount: number
  readonly payloadBytes: number
  // a creation in this range does not prove that the aggregate still exists
  readonly hasCreateEvent: boolean
}

/**
 * OrchestrationEventStoreShape - Service API for orchestration event persistence.
 */
export interface OrchestrationEventStoreShape
{
  // persist a new orchestration event.
  //
  // @param event - Event payload without sequence (assigned by storage).
  // @returns Effect containing the stored event with assigned sequence.
  //
  // actor kind is inferred from command/metadata before persistence.
  readonly append: (
    event: Omit<OrchestrationEvent, 'sequence'>,
  ) => Effect.Effect<OrchestrationEvent, OrchestrationEventStoreError>

  // persist an ordered event batch in one statement.
  readonly appendAll: (
    events: ReadonlyArray<Omit<OrchestrationEvent, 'sequence'>>,
  ) => Effect.Effect<ReadonlyArray<OrchestrationEvent>, OrchestrationEventStoreError>

  // replay events after the provided sequence.
  //
  // @param sequenceExclusive - Sequence cursor (exclusive).
  // @param limit - Maximum number of events to emit.
  // @returns Stream containing ordered events.
  //
  // reads in fixed-size pages and normalizes non-integer/negative limits.
  readonly readFromSequence: (
    sequenceExclusive: number,
    limit?: number,
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError>

  // replay one aggregate through a captured global head without decoding
  // payloads from unrelated streams
  readonly readAggregateRange: (
    input: OrchestrationAggregateReplayRange & { readonly limit?: number },
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError>

  // measure at most maxEvents + 1 rows without decoding payload bodies; the
  // extra row tells callers to use a snapshot rather than truncate the replay
  readonly getAggregateReplayStats: (
    input: OrchestrationAggregateReplayRange & { readonly maxEvents: number },
  ) => Effect.Effect<OrchestrationAggregateReplayStats, OrchestrationEventStoreError>

  // read all events from the beginning of the stream.
  //
  // @returns Stream containing all stored events.
  readonly readAll: () => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError>
}

/**
 * OrchestrationEventStore - Service tag for orchestration event persistence.
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const events = yield* OrchestrationEventStore
 *   return yield* Stream.runCollect(events.readAll())
 * })
 * ```
 */
export class OrchestrationEventStore extends Context.Service<
  OrchestrationEventStore,
  OrchestrationEventStoreShape
>()('456code/persistence/Services/OrchestrationEventStore')
{}
