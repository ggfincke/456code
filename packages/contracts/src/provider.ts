// packages/contracts/src/provider.ts
// define provider contracts

import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { TrimmedNonEmptyString } from './baseSchemas.ts'
import {
  ApprovalRequestId,
  EventId,
  IsoDateTime,
  ProviderItemId,
  ThreadId,
  TurnId,
} from './baseSchemas.ts'
import {
  ChatAttachment,
  ModelSelection,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProviderApprovalDecision,
  ProviderApprovalPolicy,
  ProviderInteractionMode,
  ProviderRequestKind,
  ProviderSandboxMode,
  ProviderUserInputAnswers,
  RuntimeMode,
} from './orchestration.ts'
import { ProviderInstanceId, ProviderDriverKind } from './providerInstance.ts'

export const ProviderSessionModelSwitchMode = Schema.Literals(['in-session', 'unsupported'])
export type ProviderSessionModelSwitchMode = typeof ProviderSessionModelSwitchMode.Type

export const ProviderActiveTurnInputMode = Schema.Literals(['supported', 'unsupported'])
export type ProviderActiveTurnInputMode = typeof ProviderActiveTurnInputMode.Type

export const ProviderConversationRollbackMode = Schema.Literals(['exact', 'unsupported'])
export type ProviderConversationRollbackMode = typeof ProviderConversationRollbackMode.Type

export const ProviderOrchestrateInstructionDelivery = Schema.Literals([
  'native',
  'prompt-prefix',
  'unsupported',
])
export type ProviderOrchestrateInstructionDelivery =
  typeof ProviderOrchestrateInstructionDelivery.Type

export const ProviderBaseInteractionMode = Schema.Literals(['default', 'plan'])
export type ProviderBaseInteractionMode = typeof ProviderBaseInteractionMode.Type

const SupportedProviderInteractionModes = Schema.NonEmptyArray(ProviderBaseInteractionMode).check(
  Schema.makeFilter(
    (modes) =>
      modes.includes('default') || 'Provider interaction capabilities must include default mode.',
  ),
)

const SupportedProviderRuntimeModes = Schema.NonEmptyArray(RuntimeMode)

export const CONSERVATIVE_PROVIDER_RUNTIME_CAPABILITIES = {
  sessionModelSwitch: 'unsupported',
  supportedInteractionModes: ['default'],
  supportedRuntimeModes: ['approval-required'],
  activeTurnInput: 'unsupported',
  conversationRollback: 'unsupported',
  orchestrateInstructionDelivery: 'unsupported',
  orchestrateBaseModes: [],
} as const

export const ProviderRuntimeCapabilities = Schema.Struct({
  sessionModelSwitch: ProviderSessionModelSwitchMode.pipe(
    Schema.withDecodingDefault(Effect.succeed('unsupported' as const)),
  ),
  supportedInteractionModes: SupportedProviderInteractionModes.pipe(
    Schema.withDecodingDefault(Effect.succeed(['default'] as const)),
  ),
  supportedRuntimeModes: SupportedProviderRuntimeModes.pipe(
    Schema.withDecodingDefault(Effect.succeed(['approval-required'] as const)),
  ),
  activeTurnInput: ProviderActiveTurnInputMode.pipe(
    Schema.withDecodingDefault(Effect.succeed('unsupported' as const)),
  ),
  conversationRollback: ProviderConversationRollbackMode.pipe(
    Schema.withDecodingDefault(Effect.succeed('unsupported' as const)),
  ),
  orchestrateInstructionDelivery: ProviderOrchestrateInstructionDelivery.pipe(
    Schema.withDecodingDefault(Effect.succeed('unsupported' as const)),
  ),
  orchestrateBaseModes: Schema.Array(ProviderBaseInteractionMode).pipe(
    Schema.withDecodingDefault(Effect.succeed([] as const)),
  ),
}).check(
  Schema.makeFilter(
    (capabilities) =>
      capabilities.orchestrateInstructionDelivery === 'unsupported'
        ? capabilities.orchestrateBaseModes.length === 0 ||
          'Unsupported orchestrate delivery must advertise no orchestrate base modes.'
        : (capabilities.orchestrateBaseModes.length > 0 &&
            capabilities.orchestrateBaseModes.every((mode) =>
              capabilities.supportedInteractionModes.includes(mode),
            )) ||
          'Orchestrate base modes must be non-empty and supported interaction modes.',
  ),
)
export type ProviderRuntimeCapabilities = typeof ProviderRuntimeCapabilities.Type

const ProviderSessionStatus = Schema.Literals(['connecting', 'ready', 'running', 'error', 'closed'])

export const ProviderSession = Schema.Struct({
  provider: ProviderDriverKind,
  // optional during the driver/instance migration. Once every producer
  // populates it (post-slice-4), routing flips to instance-id-only and the
  // legacy `provider` field is removed.
  providerInstanceId: Schema.optional(ProviderInstanceId),
  status: ProviderSessionStatus,
  runtimeMode: RuntimeMode,
  cwd: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  threadId: ThreadId,
  resumeCursor: Schema.optional(Schema.Unknown),
  activeTurnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastError: Schema.optional(TrimmedNonEmptyString),
})
export type ProviderSession = typeof ProviderSession.Type

export const ProviderSessionStartInput = Schema.Struct({
  threadId: ThreadId,
  provider: Schema.optional(ProviderDriverKind),
  // see ProviderSession for the migration story.
  providerInstanceId: Schema.optional(ProviderInstanceId),
  cwd: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  resumeCursor: Schema.optional(Schema.Unknown),
  approvalPolicy: Schema.optional(ProviderApprovalPolicy),
  sandboxMode: Schema.optional(ProviderSandboxMode),
  runtimeMode: RuntimeMode,
})
export type ProviderSessionStartInput = typeof ProviderSessionStartInput.Type

export const ProviderSendTurnInput = Schema.Struct({
  threadId: ThreadId,
  input: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  ),
  attachments: Schema.optional(
    Schema.Array(ChatAttachment).check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
  ),
  modelSelection: Schema.optional(ModelSelection),
  interactionMode: Schema.optional(ProviderInteractionMode),
  orchestrate: Schema.optional(Schema.Boolean),
})
export type ProviderSendTurnInput = typeof ProviderSendTurnInput.Type

export const ProviderTurnStartResult = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  resumeCursor: Schema.optional(Schema.Unknown),
})
export type ProviderTurnStartResult = typeof ProviderTurnStartResult.Type

export const ProviderInterruptTurnInput = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
})
export type ProviderInterruptTurnInput = typeof ProviderInterruptTurnInput.Type

export const ProviderStopSessionInput = Schema.Struct({
  threadId: ThreadId,
  expectedProviderInstanceId: Schema.optional(ProviderInstanceId),
})
export type ProviderStopSessionInput = typeof ProviderStopSessionInput.Type

export const ProviderRespondToRequestInput = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
})
export type ProviderRespondToRequestInput = typeof ProviderRespondToRequestInput.Type

export const ProviderRespondToUserInputInput = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
})
export type ProviderRespondToUserInputInput = typeof ProviderRespondToUserInputInput.Type

const ProviderEventKind = Schema.Literals(['session', 'notification', 'request', 'error'])

export const ProviderEvent = Schema.Struct({
  id: EventId,
  kind: ProviderEventKind,
  provider: ProviderDriverKind,
  // see ProviderSession for the migration story.
  providerInstanceId: Schema.optional(ProviderInstanceId),
  threadId: ThreadId,
  createdAt: IsoDateTime,
  method: TrimmedNonEmptyString,
  message: Schema.optional(TrimmedNonEmptyString),
  turnId: Schema.optional(TurnId),
  itemId: Schema.optional(ProviderItemId),
  requestId: Schema.optional(ApprovalRequestId),
  requestKind: Schema.optional(ProviderRequestKind),
  textDelta: Schema.optional(Schema.String),
  payload: Schema.optional(Schema.Unknown),
})
export type ProviderEvent = typeof ProviderEvent.Type
