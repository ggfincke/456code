// apps/server/src/orchestration/Services/OrchestrationEngine.ts
// define orchestration engine service contract

// owns command validation/dispatch and in-memory read-model updates backed by
// `OrchestrationEventStore` persistence. It does not own provider process
// management or transport concerns (e.g. websocket request parsing).
//
// uses Effect `Context.Service` for dependency injection. Command dispatch,
// replay, and unknown-input decoding all return typed domain errors.
//
// @module OrchestrationEngineService
import type { OrchestrationCommand, OrchestrationEvent } from '@t3tools/contracts'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type * as Stream from 'effect/Stream'

import type { OrchestrationDispatchError } from '../Errors.ts'
import type { OrchestrationEventStoreError } from '../../persistence/Errors.ts'

export type OrchestrationCausalSettlementCommand = Extract<
  OrchestrationCommand,
  { readonly type: 'thread.meta.update' }
>

export interface OrchestrationCausalSettlementAuthority
{
  readonly sourceKind: 'domain-event' | 'provider-runtime'
  readonly sourceSequence: number
}

/**
 * OrchestrationEngineShape - Service API for orchestration command and event flow.
 */
export interface OrchestrationEngineShape
{
  // replay persisted orchestration events from an exclusive sequence cursor.
  //
  // @param fromSequenceExclusive - Sequence cursor (exclusive).
  // @param limit - Maximum number of events to read. Defaults to the event
  //   store's page-bounded default; pass a higher value when the caller must
  //   read every event after the cursor (e.g. per-thread catch-up that filters
  //   a small subset out of a potentially larger global range).
  // @returns Stream containing ordered events.
  readonly readEvents: (
    fromSequenceExclusive: number,
    limit?: number,
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError, never>

  // dispatch a validated orchestration command.
  //
  // @param command - Valid orchestration command.
  // @returns Effect containing the sequence of the persisted event.
  //
  // dispatch is serialized through an internal queue and deduplicated via
  // command receipts.
  readonly dispatch: (
    command: OrchestrationCommand,
  ) => Effect.Effect<{ sequence: number }, OrchestrationDispatchError, never>

  // dispatch owner-internal metadata settlement that is causally older than a
  // checkpoint revert fence. This is not part of any transport contract.
  readonly dispatchInternal: (
    command: OrchestrationCausalSettlementCommand,
    authority: OrchestrationCausalSettlementAuthority,
  ) => Effect.Effect<{ sequence: number }, OrchestrationDispatchError, never>

  // stream persisted domain events in dispatch order.
  //
  // this is a hot runtime stream (new events only), not a historical replay.
  readonly streamDomainEvents: Stream.Stream<OrchestrationEvent>

  // stream live events for one aggregate without global PubSub fan-out.
  readonly streamDomainEventsForAggregate: (
    aggregateKind: OrchestrationEvent['aggregateKind'],
    aggregateId: OrchestrationEvent['aggregateId'],
  ) => Stream.Stream<OrchestrationEvent>

  // the latest sequence reflected in the engine's authoritative command read
  // model (0 if none). Used to gauge how far behind a resuming client is before
  // choosing between an incremental replay and a fresh projected snapshot.
  readonly latestSequence: Effect.Effect<number, never, never>
}

/**
 * OrchestrationEngineService - Service tag for orchestration engine access.
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const engine = yield* OrchestrationEngineService
 *   return yield* engine.dispatch(command)
 * })
 * ```
 */
export class OrchestrationEngineService extends Context.Service<
  OrchestrationEngineService,
  OrchestrationEngineShape
>()('456code/orchestration/Services/OrchestrationEngine/OrchestrationEngineService')
{}
