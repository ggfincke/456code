// apps/server/src/provider/Services/ProviderService.ts
// defines the cross-provider session and turn orchestration interface

// ProviderService - Service interface for provider sessions, turns, and checkpoints.
//
// acts as the cross-provider facade used by transports (WebSocket/RPC). It
// resolves provider adapters through `ProviderAdapterRegistry`, routes
// session-scoped calls via `ProviderSessionDirectory`, and exposes one unified
// provider event stream to callers.
//
// uses Effect `Context.Service` for dependency injection and returns typed
// domain errors for validation, session, codex, and checkpoint workflows.
//
// @module ProviderService
import type {
  ProviderContinuationIdentity,
  ProviderDriverKind,
  ProviderInterruptTurnInput,
  ProviderInstanceId,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  ThreadId,
  ProviderTurnStartResult,
} from '@t3tools/contracts'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type * as Option from 'effect/Option'
import type * as Stream from 'effect/Stream'

import type {
  ProviderRuntimeInboxSession,
  ProviderRuntimeSessionIdentity,
} from '../../persistence/Services/ProviderRuntimeInbox.ts'
import type { ProviderServiceError } from '../Errors.ts'
import type { ProviderAdapterCapabilities, ProviderEffectContext } from './ProviderAdapter.ts'
import type { ProviderInstanceRoutingInfo } from './ProviderAdapterRegistry.ts'

export type { ProviderEffectContext } from './ProviderAdapter.ts'

/**
 * Immutable routing identity that the selected provider adapter must satisfy.
 */
export interface ProviderRoutingAuthority
{
  readonly provider: ProviderDriverKind
  readonly providerInstanceId: ProviderInstanceId
  readonly continuationIdentity: ProviderContinuationIdentity | null
}

export interface ProviderSessionIdentityCapture extends ProviderRuntimeSessionIdentity
{
  readonly createdAt: string
}

/**
 * ProviderServiceShape - Service API for provider session and turn orchestration.
 */
export interface ProviderServiceShape
{
  // start a provider session.
  readonly startSession: (
    threadId: ThreadId,
    input: ProviderSessionStartInput,
    routingAuthority?: ProviderRoutingAuthority,
    context?: ProviderEffectContext,
  ) => Effect.Effect<ProviderSession, ProviderServiceError>

  // send a provider turn.
  readonly sendTurn: (
    input: ProviderSendTurnInput,
    routingAuthority?: ProviderRoutingAuthority,
    context?: ProviderEffectContext,
  ) => Effect.Effect<ProviderTurnStartResult, ProviderServiceError>

  // interrupt a running provider turn.
  readonly interruptTurn: (
    input: ProviderInterruptTurnInput,
    context?: ProviderEffectContext,
  ) => Effect.Effect<void, ProviderServiceError>

  // respond to a provider approval request.
  readonly respondToRequest: (
    input: ProviderRespondToRequestInput,
    context?: ProviderEffectContext,
  ) => Effect.Effect<void, ProviderServiceError>

  // respond to a provider structured user-input request.
  readonly respondToUserInput: (
    input: ProviderRespondToUserInputInput,
    context?: ProviderEffectContext,
  ) => Effect.Effect<void, ProviderServiceError>

  // stop a provider session.
  readonly stopSession: (
    input: ProviderStopSessionInput,
    context?: ProviderEffectContext,
  ) => Effect.Effect<void, ProviderServiceError>

  // capture the exact durable provider generation for lifecycle-safe cleanup.
  readonly captureSessionIdentity: (input: {
    readonly threadId: ThreadId
    readonly expectedProviderInstanceId?: ProviderInstanceId
  }) => Effect.Effect<Option.Option<ProviderSessionIdentityCapture>, ProviderServiceError>

  // capture every durable provider generation still open for a thread.
  readonly captureSessionIdentities: (input?: {
    readonly threadId?: ThreadId
  }) => Effect.Effect<ReadonlyArray<ProviderSessionIdentityCapture>, ProviderServiceError>

  // confirm that an identity still names the currently open provider generation.
  readonly matchesSessionIdentity: (
    identity: ProviderRuntimeSessionIdentity,
  ) => Effect.Effect<boolean, ProviderServiceError>

  // read the persisted state and exact terminal sequence for one generation.
  readonly getSessionIdentityState: (
    identity: ProviderRuntimeSessionIdentity,
  ) => Effect.Effect<Option.Option<ProviderRuntimeInboxSession>, ProviderServiceError>

  // stop only while the captured provider generation remains current.
  readonly stopSessionIfExact: (
    identity: ProviderRuntimeSessionIdentity,
    context?: ProviderEffectContext,
  ) => Effect.Effect<boolean, ProviderServiceError>

  // return the persisted handoff fence that both durable consumers must drain.
  readonly getAdmissionHandoffHighWater: Effect.Effect<number | null, ProviderServiceError>

  // reopen canonical admission only after both durable consumers prove the fence.
  readonly resumeAdmissionAfterHandoff: Effect.Effect<void, ProviderServiceError>

  // stop admission sources and return the last durably admitted sequence.
  readonly shutdown: Effect.Effect<number, ProviderServiceError>

  // list active provider sessions.
  //
  // aggregates runtime session lists from all registered adapters.
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>

  // read capabilities for the adapter bound to a configured provider instance.
  readonly getCapabilities: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderAdapterCapabilities, ProviderServiceError>

  readonly getInstanceInfo: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderInstanceRoutingInfo, ProviderServiceError>

  readonly hasRecoverableSession?: (
    threadId: ThreadId,
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<boolean, ProviderServiceError>

  // roll back provider conversation state by a number of turns.
  readonly rollbackConversation: (
    input: {
      readonly threadId: ThreadId
      readonly numTurns: number
      readonly expectedProviderInstanceId: ProviderInstanceId
    },
    context?: ProviderEffectContext,
  ) => Effect.Effect<void, ProviderServiceError>

  // roll back only while the captured provider generation remains current.
  readonly rollbackConversationIfExact: (
    input: {
      readonly identity: ProviderRuntimeSessionIdentity
      readonly numTurns: number
    },
    context?: ProviderEffectContext,
  ) => Effect.Effect<boolean, ProviderServiceError>

  // read the provider-native turn count while the captured generation is exact.
  readonly getConversationTurnCountIfExact: (
    identity: ProviderRuntimeSessionIdentity,
  ) => Effect.Effect<Option.Option<number>, ProviderServiceError>

  // canonical provider runtime event stream.
  //
  // fan-out is owned by ProviderService (not by a standalone event-bus service).
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>
}

/**
 * ProviderService - Service tag for provider orchestration.
 */
export class ProviderService extends Context.Service<ProviderService, ProviderServiceShape>()(
  '456code/provider/Services/ProviderService',
)
{}
