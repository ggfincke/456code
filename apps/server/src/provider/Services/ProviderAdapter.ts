// apps/server/src/provider/Services/ProviderAdapter.ts
// define provider adapter service contract

// defines the provider-native session/protocol operations that `ProviderService`
// routes to after resolving the target provider. Implementations should focus
// on provider behavior only and avoid cross-provider orchestration concerns.
//
// @module ProviderAdapter
import type {
  ApprovalRequestId,
  ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderUserInputAnswers,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ThreadId,
  ProviderTurnStartResult,
  TurnId,
} from '@t3tools/contracts'
import type * as Effect from 'effect/Effect'
import type * as Stream from 'effect/Stream'

import type { McpProviderSessionConfig } from '../../mcp/McpProviderSession.ts'

export type ProviderSessionModelSwitchMode = 'in-session' | 'unsupported'

export interface ProviderEffectContext
{
  readonly actionId: string
  readonly idempotencyKey: string
  readonly sourceSequence: number
  readonly operationVersion: number
}

export type ProviderConversationRollbackMode = 'exact' | 'unsupported'

export interface ProviderAdapterCapabilities
{
  // declares whether changing the model on an existing session is supported.
  readonly sessionModelSwitch: ProviderSessionModelSwitchMode
  // declares whether rolling the conversation back to an earlier turn is
  // supported. every adapter implements rollbackThread today, so leaving this
  // undefined means "attempt it and classify the result"; an adapter that
  // cannot roll back declares 'unsupported' so checkpoint revert records the
  // divergence instead of silently leaving the conversation ahead of the tree
  readonly conversationRollback?: ProviderConversationRollbackMode
}

export interface ProviderThreadTurnSnapshot
{
  readonly id: TurnId
  readonly items: ReadonlyArray<unknown>
}

export interface ProviderThreadSnapshot
{
  readonly threadId: ThreadId
  readonly turns: ReadonlyArray<ProviderThreadTurnSnapshot>
}

export interface ProviderAdapterSessionStartInput extends ProviderSessionStartInput
{
  readonly mcp?: McpProviderSessionConfig
  readonly runtimeSessionBinding: ProviderAdapterRuntimeSessionBinding
}

export interface ProviderAdapterRuntimeSessionBinding
{
  readonly providerInstanceId: ProviderInstanceId
  readonly threadId: ThreadId
  readonly sessionGeneration: number
}

export interface ProviderAdapterRuntimeEvent
{
  readonly binding: ProviderAdapterRuntimeSessionBinding
  readonly event: ProviderRuntimeEvent
}

export interface ProviderAdapterShape<TError>
{
  // provider kind implemented by this adapter.
  readonly provider: ProviderDriverKind
  readonly capabilities: ProviderAdapterCapabilities

  // start a provider-backed session.
  readonly startSession: (
    input: ProviderAdapterSessionStartInput,
    context?: ProviderEffectContext,
  ) => Effect.Effect<ProviderSession, TError>

  // send a turn to an active provider session.
  readonly sendTurn: (
    input: ProviderSendTurnInput,
    context?: ProviderEffectContext,
  ) => Effect.Effect<ProviderTurnStartResult, TError>

  // interrupt an active turn.
  readonly interruptTurn: (
    threadId: ThreadId,
    turnId?: TurnId,
    context?: ProviderEffectContext,
  ) => Effect.Effect<void, TError>

  // respond to an interactive approval request.
  readonly respondToRequest: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
    context?: ProviderEffectContext,
  ) => Effect.Effect<void, TError>

  // respond to a structured user-input request.
  readonly respondToUserInput: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
    context?: ProviderEffectContext,
  ) => Effect.Effect<void, TError>

  // stop one provider session.
  readonly stopSession: (
    threadId: ThreadId,
    context?: ProviderEffectContext,
  ) => Effect.Effect<void, TError>

  // list currently active provider sessions for this adapter.
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>

  // check whether this adapter owns an active session id.
  readonly hasSession: (threadId: ThreadId) => Effect.Effect<boolean>

  // read the immutable durable generation captured by this exact adapter session.
  readonly getSessionRuntimeBinding: (
    threadId: ThreadId,
  ) => Effect.Effect<ProviderAdapterRuntimeSessionBinding | undefined>

  // read a provider thread snapshot.
  readonly readThread: (threadId: ThreadId) => Effect.Effect<ProviderThreadSnapshot, TError>

  // roll back a provider thread by N turns.
  readonly rollbackThread: (
    threadId: ThreadId,
    numTurns: number,
    context?: ProviderEffectContext,
  ) => Effect.Effect<ProviderThreadSnapshot, TError>

  // stop all sessions owned by this adapter.
  readonly stopAll: () => Effect.Effect<void, TError>

  // canonical runtime event stream emitted by this adapter.
  readonly streamEvents: Stream.Stream<ProviderAdapterRuntimeEvent>
}
