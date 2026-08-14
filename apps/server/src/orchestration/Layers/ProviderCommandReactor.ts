// apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
// executes persisted provider intents against provider runtimes
import {
  type ChatAttachment,
  CommandId,
  EventId,
  ModelSelection,
  OrchestrationEvent,
  type OrchestrationPendingHandoff,
  OrchestrationProjectShell,
  OrchestrationThread,
  ProviderContinuationIdentity,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInteractionMode,
  normalizeCollaborationMode,
  toWireInteractionMode,
  type OrchestrationSession,
  type OrchestrationThreadActivity,
  ThreadId,
  type ThreadOrchestratePlanResponseRequestedPayload,
  ProviderSession,
  type RuntimeMode,
  type ThreadImportContinuationAuthority,
  type TurnId,
} from '@t3tools/contracts'
import { isTemporaryWorktreeBranch } from '@t3tools/shared/git'
import { buildGeneratedWorktreeBranchName } from './ProviderCommandWorktree.ts'
import { stableStringify } from '@t3tools/shared/relaySigning'
import * as Cache from 'effect/Cache'
import * as Cause from 'effect/Cause'
import * as Crypto from 'effect/Crypto'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Equal from 'effect/Equal'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import * as CheckpointStore from '../../checkpointing/CheckpointStore.ts'
import { CheckpointIdentityResolver } from '../../checkpointing/CheckpointIdentity.ts'
import { checkpointRefForThreadTurn, resolveThreadWorkspaceCwd } from '../../checkpointing/Utils.ts'
import { increment, orchestrationEventsProcessedTotal } from '../../observability/Metrics.ts'
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  ProviderInstanceNotFoundError,
  ProviderSessionNotFoundError,
  ProviderUnsupportedError,
  ProviderValidationError,
} from '../../provider/Errors.ts'
import type { ProviderServiceError } from '../../provider/Errors.ts'
import {
  HiddenTurnAwaitError,
  hasPendingHiddenTurnForThread,
  sendTurnAndAwait,
} from '../../provider/HiddenTurnRegistry.ts'
import { TextGeneration } from '../../textGeneration/TextGeneration.ts'
import {
  ProviderService,
  type ProviderEffectContext,
  type ProviderServiceShape,
} from '../../provider/Services/ProviderService.ts'
import type { ProviderAdapterCapabilities } from '../../provider/Services/ProviderAdapter.ts'
import type { ProviderInstanceRoutingInfo } from '../../provider/Services/ProviderAdapterRegistry.ts'
import { ProviderRegistry } from '../../provider/Services/ProviderRegistry.ts'
import { OrchestrationEngineService } from '../Services/OrchestrationEngine.ts'
import { ProjectionSnapshotQuery } from '../Services/ProjectionSnapshotQuery.ts'
import {
  makeReactorActionId,
  OrchestrationReactorDelivery,
  type ReactorActionDraft,
} from '../../persistence/Services/OrchestrationReactorDelivery.ts'
import { ReactorDeliveryError } from '../../persistence/Errors.ts'
import {
  DurableReactorRunner,
  type DurableReactorDefinition,
} from '../Services/DurableReactorRunner.ts'
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from '../Services/ProviderCommandReactor.ts'
import {
  resolveSourceControlWriterModelSelection,
  ServerSettingsService,
} from '../../serverSettings.ts'
import { VcsStatusBroadcaster } from '../../vcs/VcsStatusBroadcaster.ts'
import { GitWorkflowService } from '../../git/GitWorkflowService.ts'
import {
  PROVIDER_SWITCH_COMPACTION_PROMPT,
  resolveProviderSwitchCompactionModel,
} from './ProviderSwitchPolicy.ts'
import { DurableReactorInfrastructureLive } from './OrchestrationReactor.ts'

const isProviderAdapterSessionClosedError = Schema.is(ProviderAdapterSessionClosedError)
const isProviderAdapterSessionNotFoundError = Schema.is(ProviderAdapterSessionNotFoundError)
const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError)
const isProviderAdapterValidationError = Schema.is(ProviderAdapterValidationError)
const isProviderDriverKind = Schema.is(ProviderDriverKind)
const isProviderInstanceNotFoundError = Schema.is(ProviderInstanceNotFoundError)
const isProviderSessionNotFoundError = Schema.is(ProviderSessionNotFoundError)
const isProviderUnsupportedError = Schema.is(ProviderUnsupportedError)
const isProviderValidationError = Schema.is(ProviderValidationError)

type ProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | 'thread.runtime-mode-set'
      | 'thread.provider-switch-requested'
      | 'thread.turn-start-requested'
      | 'thread.turn-interrupt-requested'
      | 'thread.approval-response-requested'
      | 'thread.user-input-response-requested'
      | 'thread.orchestrate-plan-response-requested'
      | 'thread.session-stop-requested'
  }
>

type ProviderSwitchFailureReasonCode =
  | 'compaction-timeout'
  | 'compaction-failed'
  | 'target-unavailable'
  | 'stale-instance'
  | 'internal-error'
  | 'interrupted-by-restart'

function escapeXmlAttribute(value: string): string
{
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

// canonical envelope the orchestrator model reads in place of reply-grammar text
export function buildOrchestratePlanResponseEnvelope(
  payload: ThreadOrchestratePlanResponseRequestedPayload,
): string
{
  const body = {
    ...(payload.stageOverrides !== undefined
      ? {
          stageOverrides: payload.stageOverrides.map((stage) => ({
            stageId: stage.stageId,
            ...(stage.provider !== undefined ? { provider: stage.provider } : {}),
            ...(stage.model !== undefined ? { model: stage.model } : {}),
            ...(stage.effort !== undefined ? { effort: stage.effort } : {}),
            ...(stage.workers !== undefined ? { workers: stage.workers } : {}),
          })),
        }
      : {}),
    ...(payload.maxWorkers !== undefined ? { maxWorkers: payload.maxWorkers } : {}),
    ...(payload.note !== undefined ? { note: payload.note } : {}),
  }
  return `<orchestrate_plan_response run="${escapeXmlAttribute(payload.runId)}" revision="${payload.revision}" decision="${payload.decision}">\n${JSON.stringify(body)}\n</orchestrate_plan_response>`
}

function toNonEmptyProviderInput(value: string | undefined): string | undefined
{
  const normalized = value?.trim()
  return normalized && normalized.length > 0 ? normalized : undefined
}

const PROVIDER_HANDOFF_DELIVERED_ACTIVITY_KIND = 'provider.handoff.delivered'

type ProviderHandoffDeliveryMarker = {
  readonly handoffKey: string
  readonly providerSessionIdentity: string
}

function providerSessionIdentity(
  session: ProviderSession,
  continuationIdentity?: ProviderContinuationIdentity,
): string
{
  const cursor = session.resumeCursor
  let stableCursor: unknown = cursor
  if (typeof cursor === 'object' && cursor !== null && !Array.isArray(cursor))
  {
    const record = cursor as Record<string, unknown>
    stableCursor =
      ['sessionId', 'resume', 'threadId', 'conversationId', 'id']
        .map((key) => record[key])
        .find((value) => typeof value === 'string' && value.length > 0) ?? cursor
  }
  const sessionKey = stableCursor ?? { createdAt: session.createdAt }
  return stableStringify({
    continuation: continuationIdentity ?? {
      driverKind: session.provider,
      continuationKey: session.provider,
    },
    sessionKey,
  })
}

function isProviderHandoffDeliveryMarker(value: unknown): value is ProviderHandoffDeliveryMarker
{
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === PROVIDER_HANDOFF_DELIVERED_ACTIVITY_KIND &&
    'handoffKey' in value &&
    typeof value.handoffKey === 'string' &&
    'providerSessionIdentity' in value &&
    typeof value.providerSessionIdentity === 'string'
  )
}

export function prepareProviderInputWithHandoff(input: {
  readonly messageText: string | undefined
  readonly pendingHandoff: OrchestrationPendingHandoff | null | undefined
  readonly activities: ReadonlyArray<Pick<OrchestrationThreadActivity, 'kind' | 'payload'>>
  readonly session: ProviderSession | undefined
  readonly continuationIdentity?: ProviderContinuationIdentity
}): {
  readonly providerInput: string | undefined
  readonly deliveryMarker: ProviderHandoffDeliveryMarker | undefined
}
{
  const normalizedInput = toNonEmptyProviderInput(input.messageText)
  const handoffText = input.pendingHandoff?.text.trim()
  if (!handoffText)
  {
    return { providerInput: normalizedInput, deliveryMarker: undefined }
  }

  const deliveryMarker =
    input.session === undefined
      ? undefined
      : {
          handoffKey: stableStringify(input.pendingHandoff),
          providerSessionIdentity: providerSessionIdentity(
            input.session,
            input.continuationIdentity,
          ),
        }
  const wasDelivered =
    deliveryMarker !== undefined &&
    input.activities.some(
      (activity) =>
        activity.kind === PROVIDER_HANDOFF_DELIVERED_ACTIVITY_KIND &&
        isProviderHandoffDeliveryMarker(activity.payload) &&
        activity.payload.handoffKey === deliveryMarker.handoffKey &&
        activity.payload.providerSessionIdentity === deliveryMarker.providerSessionIdentity,
    )
  if (wasDelivered)
  {
    return { providerInput: normalizedInput, deliveryMarker: undefined }
  }

  const handoffSource = String(
    input.pendingHandoff?.fromModel ?? input.pendingHandoff?.fromInstanceId ?? 'prior-provider',
  )
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
  const handoffBlock = `<prior-conversation-handoff from="${handoffSource}">\n${handoffText}\n</prior-conversation-handoff>`
  return {
    providerInput: `${handoffBlock}${normalizedInput ? `\n\n${normalizedInput}` : ''}`,
    deliveryMarker,
  }
}

function mapProviderSessionStatusToOrchestrationStatus(
  status: 'connecting' | 'ready' | 'running' | 'error' | 'closed',
): OrchestrationSession['status']
{
  switch (status)
  {
    case 'connecting':
      return 'starting'
    case 'running':
      return 'running'
    case 'error':
      return 'error'
    case 'closed':
      return 'stopped'
    case 'ready':
    default:
      return 'ready'
  }
}

const DEFAULT_RUNTIME_MODE: RuntimeMode = 'full-access'
const DEFAULT_THREAD_TITLE = 'New thread'
const REACTOR_ID = 'provider-command' as const
const OPERATION_VERSION = 1

interface PlannedProviderEnvironment
{
  readonly thread: OrchestrationThread | null
  readonly project: OrchestrationProjectShell | null
  readonly runtimeSessions: ReadonlyArray<ProviderSession>
  readonly providerSnapshots: ReadonlyArray<PlannedProviderSnapshot>
  readonly instanceInfoById: Readonly<Record<string, ProviderInstanceRoutingInfo>>
  readonly capabilitiesById: Readonly<Record<string, ProviderAdapterCapabilities>>
  readonly recoverableById: Readonly<Record<string, boolean>>
  readonly providerSwitchPlanningError?: string
  readonly rememberedModelSelection: ModelSelection | null
  readonly workspaceCwd: string | null
  readonly titleGenerationCwd: string
  readonly hiddenTurnPending: boolean
  readonly branchModelSelection: ModelSelection | null
  readonly titleModelSelection: ModelSelection | null
}

interface PlannedProviderSnapshot
{
  readonly instanceId: ProviderInstanceId
  readonly models: ReadonlyArray<{ readonly slug: string }>
  readonly requiresNewThreadForModelChange?: boolean | undefined
}

const ProviderActionPayloadSchema = Schema.fromJsonString(
  Schema.Struct({
    event: OrchestrationEvent,
    environment: Schema.NullOr(
      Schema.Struct({
        thread: Schema.NullOr(OrchestrationThread),
        project: Schema.NullOr(OrchestrationProjectShell),
        runtimeSessions: Schema.Array(ProviderSession),
        providerSnapshots: Schema.Array(
          Schema.Struct({
            instanceId: ProviderInstanceId,
            models: Schema.Array(Schema.Struct({ slug: Schema.String })),
            requiresNewThreadForModelChange: Schema.optional(Schema.Boolean),
          }),
        ),
        instanceInfoById: Schema.Record(
          Schema.String,
          Schema.Struct({
            instanceId: ProviderInstanceId,
            driverKind: ProviderDriverKind,
            displayName: Schema.optional(Schema.String),
            accentColor: Schema.optional(Schema.String),
            enabled: Schema.Boolean,
            continuationIdentity: ProviderContinuationIdentity,
            continuationUnavailableReason: Schema.optional(Schema.String),
          }),
        ),
        capabilitiesById: Schema.Record(
          Schema.String,
          Schema.Struct({
            sessionModelSwitch: Schema.Literals(['in-session', 'unsupported']),
          }),
        ),
        recoverableById: Schema.Record(Schema.String, Schema.Boolean),
        providerSwitchPlanningError: Schema.optional(Schema.String),
        rememberedModelSelection: Schema.NullOr(ModelSelection),
        workspaceCwd: Schema.NullOr(Schema.String),
        titleGenerationCwd: Schema.String,
        hiddenTurnPending: Schema.Boolean,
        branchModelSelection: Schema.NullOr(ModelSelection),
        titleModelSelection: Schema.NullOr(ModelSelection),
      }),
    ),
    planningFailure: Schema.optional(Schema.String),
    compensationOfActionId: Schema.optional(Schema.String),
  }),
)
const encodeProviderActionPayload = Schema.encodeEffect(ProviderActionPayloadSchema)
const decodeProviderActionPayload = Schema.decodeUnknownEffect(ProviderActionPayloadSchema)

class ProviderCommandPayloadError extends Schema.TaggedErrorClass<ProviderCommandPayloadError>()(
  'ProviderCommandPayloadError',
  { detail: Schema.String },
)
{}

const isProviderCommandPayloadError = Schema.is(ProviderCommandPayloadError)

class ProviderSwitchCompensationReadError extends Schema.TaggedErrorClass<ProviderSwitchCompensationReadError>()(
  'ProviderSwitchCompensationReadError',
  { threadId: ThreadId },
)
{}

function isProviderIntentEvent(event: OrchestrationEvent): event is ProviderIntentEvent
{
  return (
    event.type === 'thread.runtime-mode-set' ||
    event.type === 'thread.provider-switch-requested' ||
    event.type === 'thread.turn-start-requested' ||
    event.type === 'thread.turn-interrupt-requested' ||
    event.type === 'thread.approval-response-requested' ||
    event.type === 'thread.user-input-response-requested' ||
    event.type === 'thread.orchestrate-plan-response-requested' ||
    event.type === 'thread.session-stop-requested'
  )
}

export function providerErrorLabel(value: string | undefined): string
{
  const normalized = value?.trim()
  return normalized && normalized.length > 0 ? normalized : 'unknown'
}

export function providerErrorLabelFromInstanceHint(input: {
  readonly instanceId?: string | undefined
  readonly modelSelectionInstanceId?: string | undefined
  readonly sessionProvider?: string | undefined
}): string
{
  return providerErrorLabel(
    input.instanceId ?? input.modelSelectionInstanceId ?? input.sessionProvider,
  )
}

function canReplaceThreadTitle(currentTitle: string, titleSeed?: string): boolean
{
  const trimmedCurrentTitle = currentTitle.trim()
  if (trimmedCurrentTitle === DEFAULT_THREAD_TITLE)
  {
    return true
  }

  const trimmedTitleSeed = titleSeed?.trim()
  return trimmedTitleSeed !== undefined && trimmedTitleSeed.length > 0
    ? trimmedCurrentTitle === trimmedTitleSeed
    : false
}

function findProviderAdapterRequestError(
  cause: Cause.Cause<unknown>,
): ProviderAdapterRequestError | undefined
{
  const failReason = cause.reasons.find(Cause.isFailReason)
  return isProviderAdapterRequestError(failReason?.error) ? failReason.error : undefined
}

function isUnknownPendingApprovalRequestError(cause: Cause.Cause<unknown>): boolean
{
  const error = findProviderAdapterRequestError(cause)
  if (error)
  {
    const detail = error.detail.toLowerCase()
    return (
      detail.includes('unknown pending approval request') ||
      detail.includes('unknown pending permission request') ||
      detail.includes('expired pending approval request') ||
      detail.includes('approval request expired')
    )
  }
  const message = Cause.pretty(cause).toLowerCase()
  return (
    message.includes('unknown pending approval request') ||
    message.includes('unknown pending permission request') ||
    message.includes('expired pending approval request') ||
    message.includes('approval request expired')
  )
}

function isUnknownPendingUserInputRequestError(cause: Cause.Cause<unknown>): boolean
{
  const error = findProviderAdapterRequestError(cause)
  if (error)
  {
    const detail = error.detail.toLowerCase()
    return (
      detail.includes('unknown pending user-input request') ||
      detail.includes('unknown pending user input request') ||
      detail.includes('unknown pending codex user input request')
    )
  }
  const message = Cause.pretty(cause).toLowerCase()
  return (
    message.includes('unknown pending user-input request') ||
    message.includes('unknown pending user input request') ||
    message.includes('unknown pending codex user input request')
  )
}

function stalePendingRequestDetail(
  requestKind: 'approval' | 'user-input',
  requestId: string,
): string
{
  return `Stale pending ${requestKind} request: ${requestId}. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.`
}

const make = Effect.gen(function* ()
{
  const crypto = yield* Crypto.Crypto
  const delivery = yield* OrchestrationReactorDelivery
  const durableRunner = yield* DurableReactorRunner
  const orchestrationEngine = yield* OrchestrationEngineService
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery
  const providerService = yield* ProviderService
  const providerRegistry = yield* ProviderRegistry
  const checkpointStore = yield* CheckpointStore.CheckpointStore
  const checkpointIdentity = yield* CheckpointIdentityResolver
  const gitWorkflow = yield* GitWorkflowService
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster
  const textGeneration = yield* TextGeneration
  const serverSettingsService = yield* ServerSettingsService
  let activeActionId: string | undefined
  let activeEffectContext: ProviderEffectContext | undefined
  let activeEnvironment: PlannedProviderEnvironment | undefined
  let providerInvocationMayHaveBeenReceived = false
  let unknownProviderFailureDetail: string | undefined
  // per-action call counter keeps repeated tags distinct while staying
  // deterministic on replay: the same execution order yields the same ids, so
  // receipt dedupe suppresses exactly the follow-ups that already committed
  let activeActionCommandSeq = 0
  const reactorCommandId = (actionId: string, tag: string, callIndex: number) =>
    CommandId.make(`server:${tag}:${callIndex}:reactor-action:${actionId}`)
  const serverCommandId = (tag: string) =>
    activeActionId === undefined
      ? crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)))
      : Effect.sync(() => reactorCommandId(activeActionId!, tag, activeActionCommandSeq++))
  const serverEventId = () => crypto.randomUUIDv4.pipe(Effect.map(EventId.make))

  const threadModelSelections = new Map<string, ModelSelection>()

  const requireActiveEnvironment = (): PlannedProviderEnvironment =>
  {
    if (activeEnvironment === undefined)
    {
      throw new ProviderCommandPayloadError({
        detail: 'Provider command execution is missing its planned environment.',
      })
    }
    return activeEnvironment
  }

  const getPlannedInstanceInfo = (
    instanceId: string,
  ): Effect.Effect<ProviderInstanceRoutingInfo, ProviderInstanceNotFoundError> =>
  {
    const info = requireActiveEnvironment().instanceInfoById[instanceId]
    return info === undefined
      ? Effect.fail(
          new ProviderInstanceNotFoundError({
            instanceId,
          }),
        )
      : Effect.succeed(info)
  }

  const getPlannedCapabilities = (
    instanceId: string,
  ): Effect.Effect<ProviderAdapterCapabilities, ProviderInstanceNotFoundError> =>
  {
    const capabilities = requireActiveEnvironment().capabilitiesById[instanceId]
    return capabilities === undefined
      ? Effect.fail(
          new ProviderInstanceNotFoundError({
            instanceId,
          }),
        )
      : Effect.succeed(capabilities)
  }

  const isDeterminateProviderFailure = (cause: Cause.Cause<unknown>): boolean =>
  {
    const failure = cause.reasons.find(Cause.isFailReason)?.error
    if (
      isProviderValidationError(failure) ||
      isProviderAdapterValidationError(failure) ||
      isProviderSessionNotFoundError(failure) ||
      isProviderAdapterSessionNotFoundError(failure) ||
      isProviderAdapterSessionClosedError(failure) ||
      isProviderUnsupportedError(failure) ||
      isProviderInstanceNotFoundError(failure)
    )
    {
      return true
    }
    if (isProviderAdapterRequestError(failure))
    {
      return (
        isUnknownPendingApprovalRequestError(cause) || isUnknownPendingUserInputRequestError(cause)
      )
    }
    return false
  }

  // trackIndeterminate: false exempts an invocation from the recovered-but-
  // ambiguous 'unknown' classification. session starts opt out: a failed
  // thread.start leaves no turn in flight, the recovery path settles the
  // session error exactly as the legacy reactor did, and a session that
  // secretly started anyway is reconciled by runtime ingestion -- blocking
  // the lane would strand routine startup failures behind operator resolves
  const invokeProvider = <A>(
    effect: Effect.Effect<A, ProviderServiceError>,
    options?: { readonly trackIndeterminate?: boolean },
  ) =>
    Effect.sync(() =>
    {
      // the opt-out covers both signals: leaving the may-have-been-received
      // flag set would still classify the action 'unknown' further up, which
      // is the same lane-blocking failure the opt-out exists to prevent. the
      // flag is sticky, so any other tracked call in the action still sets it
      if (options?.trackIndeterminate !== false)
      {
        providerInvocationMayHaveBeenReceived = true
      }
    }).pipe(
      Effect.andThen(effect),
      Effect.tapCause((cause) =>
        Effect.sync(() =>
        {
          if (options?.trackIndeterminate !== false && !isDeterminateProviderFailure(cause))
          {
            unknownProviderFailureDetail = formatFailureDetail(cause)
          }
        }),
      ),
    )

  const providerServiceWithEffectContext = (): ProviderServiceShape => ({
    ...providerService,
    startSession: (threadId, input, routingAuthority) =>
      invokeProvider(
        providerService.startSession(threadId, input, routingAuthority, activeEffectContext),
        { trackIndeterminate: false },
      ),
    sendTurn: (input, routingAuthority) =>
      invokeProvider(providerService.sendTurn(input, routingAuthority, activeEffectContext)),
    interruptTurn: (input) =>
      invokeProvider(providerService.interruptTurn(input, activeEffectContext)),
    respondToRequest: (input) =>
      invokeProvider(providerService.respondToRequest(input, activeEffectContext)),
    respondToUserInput: (input) =>
      invokeProvider(providerService.respondToUserInput(input, activeEffectContext)),
    stopSession: (input) => invokeProvider(providerService.stopSession(input, activeEffectContext)),
    rollbackConversation: (input) =>
      invokeProvider(providerService.rollbackConversation(input, activeEffectContext)),
  })

  const appendProviderFailureActivity = (input: {
    readonly threadId: ThreadId
    readonly kind:
      | 'provider.turn.start.failed'
      | 'provider.turn.interrupt.failed'
      | 'provider.approval.respond.failed'
      | 'provider.user-input.respond.failed'
      | 'provider.orchestrate-plan.respond.failed'
      | 'provider.session.stop.failed'
    readonly summary: string
    readonly detail: string
    readonly turnId: TurnId | null
    readonly createdAt: string
    readonly requestId?: string
    readonly approvalOutcome?: {
      readonly requestId: string
      readonly status: 'stale-terminal' | 'unknown'
      readonly requestedDecision: 'accept' | 'acceptForSession' | 'decline' | 'cancel'
      readonly detail: string
      readonly actionId?: string
      readonly updatedAt: string
    }
  }) =>
    Effect.all({
      commandId: serverCommandId('provider-failure-activity'),
      eventId: serverEventId(),
    }).pipe(
      Effect.flatMap(({ commandId, eventId }) =>
        orchestrationEngine.dispatch({
          type: 'thread.activity.append',
          commandId,
          threadId: input.threadId,
          activity: {
            id: eventId,
            tone: 'error',
            kind: input.kind,
            summary: input.summary,
            payload: {
              detail: input.detail,
              ...(input.requestId ? { requestId: input.requestId } : {}),
              ...(input.approvalOutcome === undefined
                ? {}
                : { approvalOutcome: input.approvalOutcome }),
            },
            turnId: input.turnId,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    )

  const appendProviderHandoffDeliveredActivity = (input: {
    readonly threadId: ThreadId
    readonly marker: ProviderHandoffDeliveryMarker
    readonly createdAt: string
  }) =>
    Effect.all({
      commandId: serverCommandId('provider-handoff-delivered'),
      eventId: serverEventId(),
    }).pipe(
      Effect.flatMap(({ commandId, eventId }) =>
        orchestrationEngine.dispatch({
          type: 'thread.activity.append',
          commandId,
          threadId: input.threadId,
          activity: {
            id: eventId,
            tone: 'info',
            kind: PROVIDER_HANDOFF_DELIVERED_ACTIVITY_KIND,
            summary: 'Provider handoff delivered',
            payload: {
              type: PROVIDER_HANDOFF_DELIVERED_ACTIVITY_KIND,
              ...input.marker,
            },
            turnId: null,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    )

  const appendApprovalAcceptedActivity = (input: {
    readonly thread: OrchestrationThread
    readonly requestId: string
    readonly decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel'
    readonly createdAt: string
  }) =>
    Effect.all({
      commandId: serverCommandId('provider-approval-accepted'),
      eventId: serverEventId(),
    }).pipe(
      Effect.flatMap(({ commandId, eventId }) =>
      {
        const actionId = activeActionId
        const acceptanceEvidence = {
          ...(input.thread.session?.providerName === null ||
          input.thread.session?.providerName === undefined
            ? {}
            : { provider: input.thread.session.providerName }),
          providerRequestId: input.requestId,
        }
        return orchestrationEngine.dispatch({
          type: 'thread.activity.append',
          commandId,
          threadId: input.thread.id,
          activity: {
            id: eventId,
            tone: 'approval',
            kind: 'approval.resolved',
            summary: 'Approval accepted by provider',
            payload: {
              requestId: input.requestId,
              decision: input.decision,
              requestedDecision: input.decision,
              ...(actionId === undefined ? {} : { actionId }),
              acceptanceEvidence,
              approvalOutcome: {
                requestId: input.requestId,
                status: 'accepted',
                requestedDecision: input.decision,
                decision: input.decision,
                ...(actionId === undefined ? {} : { actionId }),
                acceptanceEvidence,
                updatedAt: input.createdAt,
              },
            },
            turnId: null,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        })
      }),
    )

  const formatFailureDetail = (cause: Cause.Cause<unknown>): string =>
  {
    const failReason = cause.reasons.find(Cause.isFailReason)
    const providerError = isProviderAdapterRequestError(failReason?.error)
      ? failReason.error
      : undefined
    if (providerError)
    {
      return providerError.detail
    }
    return Cause.pretty(cause)
  }

  const progressProviderSwitch = (input: {
    readonly threadId: ThreadId
    readonly requestId?: EventId
    readonly expectedRequestedAt?: string
    readonly phase: 'compacting' | 'finalizing'
  }) =>
    serverCommandId('provider-switch-progress').pipe(
      Effect.flatMap((commandId) =>
        orchestrationEngine.dispatch({
          type: 'thread.provider.switch.progress',
          commandId,
          threadId: input.threadId,
          ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
          ...(input.expectedRequestedAt === undefined
            ? {}
            : { expectedRequestedAt: input.expectedRequestedAt }),
          phase: input.phase,
        }),
      ),
    )

  const failProviderSwitch = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId
    readonly requestId?: EventId
    readonly expectedRequestedAt?: string
    readonly sourceModelSelection?: ModelSelection
    readonly targetModelSelection?: ModelSelection
    readonly reasonCode: ProviderSwitchFailureReasonCode
    readonly detail: string
  })
  {
    yield* orchestrationEngine.dispatch({
      type: 'thread.provider.switch.fail',
      commandId: yield* serverCommandId('provider-switch-failed'),
      threadId: input.threadId,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      ...(input.expectedRequestedAt === undefined
        ? {}
        : { expectedRequestedAt: input.expectedRequestedAt }),
      ...(input.sourceModelSelection === undefined
        ? {}
        : { sourceModelSelection: input.sourceModelSelection }),
      ...(input.targetModelSelection === undefined
        ? {}
        : { targetModelSelection: input.targetModelSelection }),
      reasonCode: input.reasonCode,
      detail: input.detail,
    })
  })

  const setThreadSession = (input: {
    readonly threadId: ThreadId
    readonly session: OrchestrationSession
    readonly createdAt: string
  }) =>
    serverCommandId('provider-session-set').pipe(
      Effect.flatMap((commandId) =>
        orchestrationEngine.dispatch({
          type: 'thread.session.set',
          commandId,
          threadId: input.threadId,
          session: input.session,
          createdAt: input.createdAt,
        }),
      ),
    )

  const setThreadSessionErrorOnTurnStartFailure = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId
    readonly detail: string
    readonly createdAt: string
  })
  {
    const thread = yield* resolveThread(input.threadId)
    if (!thread)
    {
      return
    }
    const session = thread.session
    yield* setThreadSession({
      threadId: input.threadId,
      session: {
        ...(session ?? {
          threadId: input.threadId,
          providerName: null,
          providerInstanceId: thread.modelSelection.instanceId,
          runtimeMode: thread.runtimeMode,
        }),
        status: session?.status === 'stopped' ? 'stopped' : 'error',
        activeTurnId: null,
        lastError: input.detail,
        updatedAt: input.createdAt,
      },
      createdAt: input.createdAt,
    })
  })

  const resolveThread = Effect.fnUntraced(function* (threadId: ThreadId)
  {
    const thread = requireActiveEnvironment().thread
    return thread?.id === threadId ? thread : undefined
  })

  const scheduleProviderSwitchCleanup = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId
    readonly sourceInstanceId: ProviderInstanceId
  })
  {
    const effectContext = activeEffectContext
    yield* Effect.gen(function* ()
    {
      const runtimeSessions = yield* providerService.listSessions()
      const hasLiveOutgoingSession = runtimeSessions.some(
        (session) =>
          session.threadId === input.threadId &&
          session.providerInstanceId === input.sourceInstanceId &&
          session.status !== 'closed',
      )
      const hasRecoverableOutgoingSession =
        providerService.hasRecoverableSession === undefined
          ? false
          : yield* providerService.hasRecoverableSession(input.threadId, input.sourceInstanceId)
      if (hasLiveOutgoingSession || hasRecoverableOutgoingSession)
      {
        yield* providerService.stopSession(
          {
            threadId: input.threadId,
            expectedProviderInstanceId: input.sourceInstanceId,
          },
          effectContext,
        )
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning('provider switch cleanup failed after terminalization', {
          threadId: input.threadId,
          sourceInstanceId: input.sourceInstanceId,
          cause: Cause.pretty(cause),
        }),
      ),
      Effect.forkDetach({ startImmediately: true }),
    )
  })

  const failProviderSwitchAndRepair = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId
    readonly requestId?: EventId
    readonly expectedRequestedAt?: string
    readonly sourceModelSelection?: ModelSelection
    readonly targetModelSelection?: ModelSelection
    readonly reasonCode: ProviderSwitchFailureReasonCode
    readonly detail: string
  })
  {
    const sourceInstanceId =
      input.sourceModelSelection?.instanceId ?? activeEnvironment?.thread?.modelSelection.instanceId
    yield* failProviderSwitch(input)
    if (sourceInstanceId !== undefined)
    {
      yield* scheduleProviderSwitchCleanup({
        threadId: input.threadId,
        sourceInstanceId,
      })
    }
  })

  const rejectStartedThreadModelChangeIfRequired = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId
    readonly currentModelSelection: ModelSelection
    readonly requestedModelSelection: ModelSelection | undefined
  })
  {
    const requestedModelSelection = input.requestedModelSelection
    if (
      requestedModelSelection === undefined ||
      (input.currentModelSelection.instanceId === requestedModelSelection.instanceId &&
        input.currentModelSelection.model === requestedModelSelection.model)
    )
    {
      return
    }
    const providers = requireActiveEnvironment().providerSnapshots
    const requiresNewThread =
      providers.find((snapshot) => snapshot.instanceId === input.currentModelSelection.instanceId)
        ?.requiresNewThreadForModelChange === true ||
      providers.find((snapshot) => snapshot.instanceId === requestedModelSelection.instanceId)
        ?.requiresNewThreadForModelChange === true
    if (!requiresNewThread)
    {
      return
    }
    return yield* new ProviderAdapterRequestError({
      provider: providerErrorLabelFromInstanceHint({
        instanceId: String(requestedModelSelection.instanceId),
        modelSelectionInstanceId: String(input.currentModelSelection.instanceId),
      }),
      method: 'thread.turn.start',
      detail: `Thread '${input.threadId}' cannot switch models after the conversation has started. Start a new thread to use '${requestedModelSelection.model}'.`,
    })
  })

  const ensureSessionForThread = Effect.fn('ensureSessionForThread')(function* (
    threadId: ThreadId,
    createdAt: string,
    options?: {
      readonly importContinuationAuthority?: ThreadImportContinuationAuthority
      readonly modelSelection?: ModelSelection
      readonly pendingTurnStart?: boolean
    },
  )
  {
    const thread = yield* resolveThread(threadId)
    if (!thread)
    {
      return yield* Effect.die(new Error(`Thread '${threadId}' was not found in read model.`))
    }

    const desiredRuntimeMode = thread.runtimeMode
    const requestedModelSelection = options?.modelSelection
    const resolveActiveSession = (threadId: ThreadId) =>
      Effect.succeed(
        requireActiveEnvironment().runtimeSessions.find((session) => session.threadId === threadId),
      )

    const activeSession = yield* resolveActiveSession(threadId)
    const activeThreadSession =
      thread.session !== null && thread.session.status !== 'stopped' && activeSession
        ? thread.session
        : null
    if (
      activeThreadSession !== null &&
      activeSession !== undefined &&
      (activeThreadSession.providerInstanceId === undefined ||
        activeSession.providerInstanceId === undefined)
    )
    {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(activeThreadSession.providerName ?? undefined),
        method: 'thread.turn.start',
        detail: `Thread '${threadId}' has an active provider session without a provider instance id.`,
      })
    }
    const currentInstanceId =
      activeThreadSession !== null &&
      activeSession !== undefined &&
      activeSession.providerInstanceId !== undefined
        ? activeSession.providerInstanceId
        : thread.modelSelection.instanceId
    const desiredModelSelection = requestedModelSelection ?? thread.modelSelection
    const desiredInstanceId = desiredModelSelection.instanceId
    const currentInfo = yield* getPlannedInstanceInfo(currentInstanceId).pipe(
      Effect.mapError(
        () =>
          new ProviderAdapterRequestError({
            provider: providerErrorLabelFromInstanceHint({
              instanceId: String(currentInstanceId),
              modelSelectionInstanceId: String(thread.modelSelection.instanceId),
              sessionProvider: thread.session?.providerName ?? undefined,
            }),
            method: 'thread.turn.start',
            detail: `Thread '${threadId}' references unknown provider instance '${currentInstanceId}'. The instance is not configured in this build.`,
          }),
      ),
    )
    const desiredInfo = yield* getPlannedInstanceInfo(desiredInstanceId).pipe(
      Effect.mapError(
        () =>
          new ProviderAdapterRequestError({
            provider: providerErrorLabelFromInstanceHint({
              instanceId: String(desiredModelSelection.instanceId),
            }),
            method: 'thread.turn.start',
            detail: `Requested provider instance '${desiredInstanceId}' is not configured in this build.`,
          }),
      ),
    )
    const desiredDriverKind = desiredInfo.driverKind
    if (!isProviderDriverKind(desiredDriverKind))
    {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(String(desiredDriverKind)),
        method: 'thread.turn.start',
        detail: `Requested provider instance '${desiredInstanceId}' uses unknown provider driver '${desiredDriverKind}'. The driver is not installed in this build.`,
      })
    }
    const importContinuationAuthority = options?.importContinuationAuthority
    if (
      importContinuationAuthority !== undefined &&
      (desiredInstanceId !== importContinuationAuthority.targetProviderInstanceId ||
        desiredDriverKind !== importContinuationAuthority.driverKind ||
        importContinuationAuthority.continuationIdentity === null ||
        desiredInfo.continuationIdentity.driverKind !==
          importContinuationAuthority.continuationIdentity.driverKind ||
        desiredInfo.continuationIdentity.continuationKey !==
          importContinuationAuthority.continuationIdentity.continuationKey)
    )
    {
      return yield* new ProviderAdapterRequestError({
        provider: importContinuationAuthority.driverKind,
        method: 'thread.turn.start',
        detail: `Imported thread '${threadId}' no longer resolves to its authorized provider continuation source.`,
      })
    }
    const preferredProvider: ProviderDriverKind =
      importContinuationAuthority?.driverKind ?? desiredDriverKind
    const revalidateImportContinuationAuthority = Effect.fn(
      'revalidateImportContinuationAuthority',
    )(function* ()
    {
      if (importContinuationAuthority === undefined)
      {
        return
      }
      const currentInfo = yield* getPlannedInstanceInfo(
        importContinuationAuthority.targetProviderInstanceId,
      )
      const authorityIdentity = importContinuationAuthority.continuationIdentity
      if (
        authorityIdentity !== null &&
        currentInfo.driverKind === importContinuationAuthority.driverKind &&
        currentInfo.continuationIdentity.driverKind === authorityIdentity.driverKind &&
        currentInfo.continuationIdentity.continuationKey === authorityIdentity.continuationKey
      )
      {
        return
      }
      return yield* new ProviderAdapterRequestError({
        provider: importContinuationAuthority.driverKind,
        method: 'thread.turn.start',
        detail: `Imported thread '${threadId}' no longer resolves to its authorized provider continuation source.`,
      })
    })
    if (options?.pendingTurnStart === true && thread.session?.status !== 'running')
    {
      yield* setThreadSession({
        threadId,
        session: {
          threadId,
          status: 'starting',
          providerName: activeSession?.provider ?? preferredProvider,
          providerInstanceId: activeSession?.providerInstanceId ?? desiredInstanceId,
          runtimeMode: desiredRuntimeMode,
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      })
    }
    if (activeThreadSession !== null)
    {
      yield* rejectStartedThreadModelChangeIfRequired({
        threadId,
        currentModelSelection:
          activeSession?.model !== undefined
            ? {
                ...thread.modelSelection,
                instanceId: currentInstanceId,
                model: activeSession.model,
              }
            : thread.modelSelection,
        requestedModelSelection,
      })
    }
    if (
      thread.session !== null &&
      requestedModelSelection !== undefined &&
      requestedModelSelection.instanceId !== currentInstanceId
    )
    {
      if (currentInfo.driverKind !== desiredInfo.driverKind)
      {
        return yield* new ProviderAdapterRequestError({
          provider: preferredProvider,
          method: 'thread.turn.start',
          detail: `Thread '${threadId}' is bound to driver '${currentInfo.driverKind}' and cannot switch to '${desiredInfo.driverKind}'.`,
        })
      }
      if (
        currentInfo.continuationIdentity.continuationKey !==
        desiredInfo.continuationIdentity.continuationKey
      )
      {
        return yield* new ProviderAdapterRequestError({
          provider: preferredProvider,
          method: 'thread.turn.start',
          detail: `Thread '${threadId}' cannot switch from instance '${currentInstanceId}' to '${desiredInstanceId}' because their provider resume state is incompatible.`,
        })
      }
    }
    const effectiveCwd = requireActiveEnvironment().workspaceCwd ?? undefined

    const startProviderSession = (input?: {
      readonly resumeCursor?: unknown
      readonly provider?: ProviderDriverKind
    }) =>
      Effect.gen(function* ()
      {
        yield* revalidateImportContinuationAuthority()
        return yield* invokeProvider(
          providerService.startSession(
            threadId,
            {
              threadId,
              provider: preferredProvider,
              providerInstanceId: desiredInstanceId,
              ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
              modelSelection: desiredModelSelection,
              ...(input?.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
              runtimeMode: desiredRuntimeMode,
            },
            importContinuationAuthority === undefined
              ? undefined
              : {
                  provider: importContinuationAuthority.driverKind,
                  providerInstanceId: importContinuationAuthority.targetProviderInstanceId,
                  continuationIdentity: importContinuationAuthority.continuationIdentity,
                },
            activeEffectContext,
          ),
          { trackIndeterminate: false },
        )
      })

    const bindSessionToThread = (session: ProviderSession) =>
      Effect.gen(function* ()
      {
        if (session.providerInstanceId === undefined)
        {
          return yield* new ProviderAdapterRequestError({
            provider: providerErrorLabel(session.provider),
            method: 'thread.turn.start',
            detail: `Provider session '${session.threadId}' started without a provider instance id.`,
          })
        }
        yield* setThreadSession({
          threadId,
          session: {
            threadId,
            status:
              options?.pendingTurnStart === true && session.status === 'ready'
                ? 'starting'
                : mapProviderSessionStatusToOrchestrationStatus(session.status),
            providerName: session.provider,
            providerInstanceId: session.providerInstanceId,
            runtimeMode: desiredRuntimeMode,
            // provider turn ids are not orchestration turn ids.
            activeTurnId: null,
            lastError: session.lastError ?? null,
            updatedAt: session.updatedAt,
          },
          createdAt,
        })
      })

    const existingSessionThreadId =
      thread.session && thread.session.status !== 'stopped' && activeSession ? thread.id : null
    if (existingSessionThreadId && activeSession !== undefined)
    {
      const runtimeModeChanged = thread.runtimeMode !== thread.session?.runtimeMode
      const cwdChanged = effectiveCwd !== activeSession?.cwd
      const sessionModelSwitch = (yield* getPlannedCapabilities(desiredInstanceId))
        .sessionModelSwitch
      const modelChanged =
        requestedModelSelection !== undefined &&
        requestedModelSelection.model !== activeSession?.model
      const instanceChanged =
        requestedModelSelection !== undefined &&
        activeSession?.providerInstanceId !== requestedModelSelection.instanceId
      const shouldRestartForModelChange = modelChanged && sessionModelSwitch === 'unsupported'
      const previousModelSelection =
        requireActiveEnvironment().rememberedModelSelection ?? undefined
      const shouldRestartForModelSelectionChange =
        preferredProvider === 'claudeAgent' &&
        requestedModelSelection !== undefined &&
        !Equal.equals(previousModelSelection, requestedModelSelection)

      if (
        !runtimeModeChanged &&
        !cwdChanged &&
        !instanceChanged &&
        !shouldRestartForModelChange &&
        !shouldRestartForModelSelectionChange
      )
      {
        return activeSession
      }

      const resumeCursor = shouldRestartForModelChange
        ? undefined
        : (activeSession?.resumeCursor ?? undefined)
      yield* Effect.logInfo('provider command reactor restarting provider session', {
        threadId,
        existingSessionThreadId,
        currentProvider: activeSession?.provider,
        currentInstanceId,
        desiredInstanceId,
        desiredProvider: desiredModelSelection.instanceId,
        currentRuntimeMode: thread.session?.runtimeMode,
        desiredRuntimeMode: thread.runtimeMode,
        runtimeModeChanged,
        previousCwd: activeSession?.cwd,
        desiredCwd: effectiveCwd,
        cwdChanged,
        modelChanged,
        instanceChanged,
        shouldRestartForModelChange,
        shouldRestartForModelSelectionChange,
        hasResumeCursor: resumeCursor !== undefined,
      })
      const restartedSession = yield* startProviderSession(
        resumeCursor !== undefined ? { resumeCursor } : undefined,
      )
      yield* Effect.logInfo('provider command reactor restarted provider session', {
        threadId,
        previousSessionId: existingSessionThreadId,
        restartedSessionThreadId: restartedSession.threadId,
        provider: restartedSession.provider,
        runtimeMode: restartedSession.runtimeMode,
        cwd: restartedSession.cwd,
      })
      yield* bindSessionToThread(restartedSession)
      return restartedSession
    }

    const startedSession = yield* startProviderSession(undefined)
    yield* bindSessionToThread(startedSession)
    return startedSession
  })

  const buildSendTurnRequestForThread = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId
    readonly messageText: string
    readonly attachments?: ReadonlyArray<ChatAttachment>
    readonly importContinuationAuthority?: ThreadImportContinuationAuthority
    readonly modelSelection?: ModelSelection
    readonly interactionMode?: ProviderInteractionMode
    readonly orchestrate?: boolean
    readonly createdAt: string
  })
  {
    const thread = yield* resolveThread(input.threadId)
    if (!thread)
    {
      return yield* Effect.die(new Error(`Thread '${input.threadId}' was not found in read model.`))
    }
    // a turn sent during compaction would steer into the hidden turn on
    // steering adapters and be silently swallowed; fail it visibly instead
    if (requireActiveEnvironment().hiddenTurnPending)
    {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabelFromInstanceHint({
          instanceId: String(thread.modelSelection.instanceId),
        }),
        method: 'thread.turn.start',
        detail: `Thread '${input.threadId}' is switching providers; wait for the switch to finish and send the message again.`,
      })
    }
    const activeSession = yield* ensureSessionForThread(input.threadId, input.createdAt, {
      ...(input.importContinuationAuthority !== undefined
        ? { importContinuationAuthority: input.importContinuationAuthority }
        : {}),
      ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      pendingTurnStart: true,
    })
    if (input.modelSelection !== undefined)
    {
      threadModelSelections.set(input.threadId, input.modelSelection)
    }
    const normalizedAttachments = input.attachments ?? []
    const preparedInput = prepareProviderInputWithHandoff({
      messageText: input.messageText,
      pendingHandoff: thread.pendingHandoff,
      activities: thread.activities,
      session: activeSession,
      ...(activeSession?.providerInstanceId === undefined
        ? {}
        : {
            continuationIdentity: (yield* getPlannedInstanceInfo(activeSession.providerInstanceId))
              .continuationIdentity,
          }),
    })
    const sessionModelSwitch =
      activeSession === undefined
        ? 'in-session'
        : activeSession.providerInstanceId === undefined
          ? yield* new ProviderAdapterRequestError({
              provider: providerErrorLabel(activeSession.provider),
              method: 'thread.turn.start',
              detail: `Active provider session '${activeSession.threadId}' is missing a provider instance id.`,
            })
          : (yield* getPlannedCapabilities(activeSession.providerInstanceId)).sessionModelSwitch
    const requestedModelSelection =
      input.modelSelection ??
      requireActiveEnvironment().rememberedModelSelection ??
      thread.modelSelection
    const modelForTurn =
      sessionModelSwitch === 'unsupported' && input.modelSelection === undefined
        ? activeSession?.model !== undefined
          ? {
              ...requestedModelSelection,
              model: activeSession.model,
            }
          : requestedModelSelection
        : input.modelSelection
    const collaborationMode = normalizeCollaborationMode(
      input.interactionMode ?? thread.interactionMode,
      input.orchestrate ?? thread.orchestrate,
    )

    return {
      request: {
        threadId: input.threadId,
        ...(preparedInput.providerInput ? { input: preparedInput.providerInput } : {}),
        ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
        ...(modelForTurn !== undefined ? { modelSelection: modelForTurn } : {}),
        ...toWireInteractionMode(collaborationMode),
      },
      ...(preparedInput.deliveryMarker !== undefined
        ? { handoffDeliveryMarker: preparedInput.deliveryMarker }
        : {}),
    }
  })

  const maybeGenerateAndRenameWorktreeBranchForFirstTurn = Effect.fn(
    'maybeGenerateAndRenameWorktreeBranchForFirstTurn',
  )(function* (input: {
    readonly threadId: ThreadId
    readonly sourceSequence: number
    readonly branch: string | null
    readonly worktreePath: string | null
    readonly messageText: string
    readonly attachments?: ReadonlyArray<ChatAttachment>
  })
  {
    if (!input.branch || !input.worktreePath)
    {
      return
    }
    if (!isTemporaryWorktreeBranch(input.branch))
    {
      return
    }

    const oldBranch = input.branch
    const cwd = input.worktreePath
    const attachments = input.attachments ?? []
    yield* Effect.gen(function* ()
    {
      const modelSelection = requireActiveEnvironment().branchModelSelection
      if (modelSelection === null) return

      const generated = yield* textGeneration.generateBranchName({
        cwd,
        message: input.messageText,
        ...(attachments.length > 0 ? { attachments } : {}),
        modelSelection,
      })
      if (!generated) return

      const targetBranch = buildGeneratedWorktreeBranchName(generated.branch)
      if (targetBranch === oldBranch) return

      const renamed = yield* gitWorkflow.renameBranch({ cwd, oldBranch, newBranch: targetBranch })
      yield* orchestrationEngine.dispatchInternal(
        {
          type: 'thread.meta.update',
          commandId: yield* serverCommandId('worktree-branch-rename'),
          threadId: input.threadId,
          branch: renamed.branch,
          worktreePath: cwd,
        },
        {
          sourceKind: 'domain-event',
          sourceSequence: input.sourceSequence,
        },
      )
      yield* vcsStatusBroadcaster.refreshStatus(cwd).pipe(Effect.ignoreCause({ log: true }))
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning('provider command reactor failed to generate or rename worktree branch', {
          threadId: input.threadId,
          cwd,
          oldBranch,
          cause: Cause.pretty(cause),
        }),
      ),
    )
  })

  const maybeGenerateThreadTitleForFirstTurn = Effect.fn('maybeGenerateThreadTitleForFirstTurn')(
    function* (input: {
      readonly threadId: ThreadId
      readonly sourceSequence: number
      readonly cwd: string
      readonly messageText: string
      readonly attachments?: ReadonlyArray<ChatAttachment>
      readonly titleSeed?: string
    })
    {
      const attachments = input.attachments ?? []
      yield* Effect.gen(function* ()
      {
        const modelSelection = requireActiveEnvironment().titleModelSelection
        if (modelSelection === null) return

        const generated = yield* textGeneration.generateThreadTitle({
          cwd: input.cwd,
          message: input.messageText,
          ...(attachments.length > 0 ? { attachments } : {}),
          modelSelection,
        })
        if (!generated) return

        const thread = yield* resolveThread(input.threadId)
        if (!thread) return
        if (!canReplaceThreadTitle(thread.title, input.titleSeed))
        {
          return
        }

        yield* orchestrationEngine.dispatchInternal(
          {
            type: 'thread.meta.update',
            commandId: yield* serverCommandId('thread-title-rename'),
            threadId: input.threadId,
            title: generated.title,
          },
          {
            sourceKind: 'domain-event',
            sourceSequence: input.sourceSequence,
          },
        )
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning('provider command reactor failed to generate or rename thread title', {
            threadId: input.threadId,
            cwd: input.cwd,
            cause: Cause.pretty(cause),
          }),
        ),
      )
    },
  )

  const processTurnStartRequested = Effect.fn('processTurnStartRequested')(function* (
    event: Extract<ProviderIntentEvent, { type: 'thread.turn-start-requested' }>,
  )
  {
    const thread = yield* resolveThread(event.payload.threadId)
    if (!thread)
    {
      return
    }

    const message = thread.messages.find((entry) => entry.id === event.payload.messageId)
    if (!message || message.role !== 'user')
    {
      yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: 'provider.turn.start.failed',
        summary: 'Provider turn start failed',
        detail: `User message '${event.payload.messageId}' was not found for turn start request.`,
        turnId: null,
        createdAt: event.payload.createdAt,
      })
      return
    }

    const handleTurnStartFailure = (cause: Cause.Cause<unknown>) =>
    {
      if (Cause.hasInterruptsOnly(cause))
      {
        return Effect.void
      }
      const detail = formatFailureDetail(cause)
      return setThreadSessionErrorOnTurnStartFailure({
        threadId: event.payload.threadId,
        detail,
        createdAt: event.payload.createdAt,
      }).pipe(
        Effect.flatMap(() =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: 'provider.turn.start.failed',
            summary: 'Provider turn start failed',
            detail,
            turnId: null,
            createdAt: event.payload.createdAt,
          }),
        ),
        Effect.asVoid,
      )
    }

    const recoverTurnStartFailure = (cause: Cause.Cause<unknown>) =>
      handleTurnStartFailure(cause).pipe(
        Effect.catchCause((recoveryCause) =>
          Effect.logWarning('provider command reactor failed to recover turn start failure', {
            eventType: event.type,
            threadId: event.payload.threadId,
            cause: Cause.pretty(recoveryCause),
            originalCause: Cause.pretty(cause),
          }),
        ),
      )

    const sendTurnRequest = yield* buildSendTurnRequestForThread({
      threadId: event.payload.threadId,
      messageText: message.text,
      ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
      ...(event.payload.importContinuationAuthority !== undefined
        ? { importContinuationAuthority: event.payload.importContinuationAuthority }
        : {}),
      ...(event.payload.modelSelection !== undefined
        ? { modelSelection: event.payload.modelSelection }
        : {}),
      interactionMode: event.payload.interactionMode,
      ...(event.payload.orchestrate !== undefined
        ? { orchestrate: event.payload.orchestrate }
        : {}),
      createdAt: event.payload.createdAt,
    }).pipe(
      Effect.map(Option.some),
      Effect.catchCause((cause) => handleTurnStartFailure(cause).pipe(Effect.as(Option.none()))),
    )

    if (Option.isNone(sendTurnRequest))
    {
      return
    }

    const delivered = yield* invokeProvider(
      providerService.sendTurn(
        sendTurnRequest.value.request,
        event.payload.importContinuationAuthority === undefined
          ? undefined
          : {
              provider: event.payload.importContinuationAuthority.driverKind,
              providerInstanceId:
                event.payload.importContinuationAuthority.targetProviderInstanceId,
              continuationIdentity: event.payload.importContinuationAuthority.continuationIdentity,
            },
        activeEffectContext,
      ),
    ).pipe(
      Effect.as(true),
      Effect.catchCause((cause) => recoverTurnStartFailure(cause).pipe(Effect.as(false))),
    )
    if (!delivered || sendTurnRequest.value.handoffDeliveryMarker === undefined)
    {
      return
    }

    yield* appendProviderHandoffDeliveredActivity({
      threadId: event.payload.threadId,
      marker: sendTurnRequest.value.handoffDeliveryMarker,
      createdAt: event.payload.createdAt,
    })
  })

  const processTurnInterruptRequested = Effect.fn('processTurnInterruptRequested')(function* (
    event: Extract<ProviderIntentEvent, { type: 'thread.turn-interrupt-requested' }>,
  )
  {
    const thread = yield* resolveThread(event.payload.threadId)
    if (!thread)
    {
      return
    }
    const hasSession = thread.session && thread.session.status !== 'stopped'
    if (!hasSession)
    {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: 'provider.turn.interrupt.failed',
        summary: 'Provider turn interrupt failed',
        detail: 'No active provider session is bound to this thread.',
        turnId: event.payload.turnId ?? null,
        createdAt: event.payload.createdAt,
      })
    }

    // orchestration turn ids are not provider turn ids, so interrupt by session.
    yield* invokeProvider(
      providerService.interruptTurn({ threadId: event.payload.threadId }, activeEffectContext),
    )
  })

  const isCurrentProviderSwitchRequest = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: 'thread.provider-switch-requested' }>,
  )
  {
    const thread = Option.getOrUndefined(
      yield* projectionSnapshotQuery.getThreadShellById(event.payload.threadId),
    )
    return (
      thread?.providerSwitch !== null &&
      thread?.providerSwitch !== undefined &&
      (thread.providerSwitch.requestId === event.eventId ||
        (thread.providerSwitch.requestId === undefined &&
          thread.providerSwitch.requestedAt === event.occurredAt)) &&
      thread.providerSwitch.targetInstanceId === event.payload.targetModelSelection.instanceId &&
      thread.providerSwitch.targetModel === event.payload.targetModelSelection.model
    )
  })

  const processProviderSwitchRequested = Effect.fn('processProviderSwitchRequested')(function* (
    event: Extract<ProviderIntentEvent, { type: 'thread.provider-switch-requested' }>,
  )
  {
    const failSwitch = (reasonCode: ProviderSwitchFailureReasonCode, detail: string) =>
      failProviderSwitchAndRepair({
        threadId: event.payload.threadId,
        ...(event.payload.sourceModelSelection === undefined
          ? { expectedRequestedAt: event.occurredAt }
          : {
              requestId: event.eventId,
              sourceModelSelection: event.payload.sourceModelSelection,
            }),
        targetModelSelection: event.payload.targetModelSelection,
        reasonCode,
        detail,
      })

    if (!(yield* isCurrentProviderSwitchRequest(event)))
    {
      return
    }
    const planningError = requireActiveEnvironment().providerSwitchPlanningError
    if (planningError !== undefined)
    {
      yield* failSwitch('internal-error', planningError)
      return
    }

    const resolvedThread = yield* resolveThread(event.payload.threadId).pipe(
      Effect.map((thread) => ({ resolved: true as const, thread })),
      Effect.catchCause((cause) =>
        failSwitch('internal-error', formatFailureDetail(cause)).pipe(
          Effect.as({ resolved: false as const }),
        ),
      ),
    )
    if (!resolvedThread.resolved)
    {
      return
    }
    const thread = resolvedThread.thread
    if (!thread)
    {
      yield* failSwitch(
        'internal-error',
        `Thread '${event.payload.threadId}' is unavailable while its provider switch is running.`,
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning('provider command reactor failed to record missing switch thread', {
            threadId: event.payload.threadId,
            cause: Cause.pretty(cause),
          }),
        ),
      )
      return
    }

    if (
      event.payload.expectedCurrentInstanceId !== null &&
      event.payload.expectedCurrentInstanceId !== thread.modelSelection.instanceId
    )
    {
      yield* failSwitch(
        'stale-instance',
        `Thread '${thread.id}' is no longer bound to expected provider instance '${event.payload.expectedCurrentInstanceId}'.`,
      )
      return
    }
    if (event.payload.targetModelSelection.instanceId === thread.modelSelection.instanceId)
    {
      yield* failSwitch(
        'stale-instance',
        `Thread '${thread.id}' is already bound to the requested provider.`,
      )
      return
    }

    const runtimeSession = requireActiveEnvironment().runtimeSessions.find(
      (session) => session.threadId === thread.id,
    )
    const projectedSessionHasActiveTurn =
      thread.session?.status === 'starting' ||
      (thread.session?.status === 'running' && thread.session.activeTurnId !== null)
    const hasActiveTurn =
      thread.latestTurn?.state === 'running' ||
      projectedSessionHasActiveTurn ||
      thread.session?.activeTurnId != null ||
      runtimeSession?.status === 'connecting' ||
      runtimeSession?.status === 'running' ||
      runtimeSession?.activeTurnId !== undefined
    if (hasActiveTurn)
    {
      yield* failSwitch(
        'internal-error',
        `Thread '${thread.id}' has an active turn and cannot switch providers.`,
      )
      return
    }

    const targetInfo = yield* getPlannedInstanceInfo(
      event.payload.targetModelSelection.instanceId,
    ).pipe(
      Effect.map(Option.some),
      Effect.catchCause((cause) =>
        failSwitch('target-unavailable', formatFailureDetail(cause)).pipe(Effect.as(Option.none())),
      ),
    )
    if (Option.isNone(targetInfo))
    {
      return
    }
    if (!targetInfo.value.enabled)
    {
      yield* failSwitch(
        'target-unavailable',
        `Provider instance '${event.payload.targetModelSelection.instanceId}' is disabled in 456code settings.`,
      )
      return
    }

    const outgoingInstanceId = thread.modelSelection.instanceId
    if (runtimeSession !== undefined && runtimeSession.providerInstanceId !== outgoingInstanceId)
    {
      yield* failSwitch(
        'stale-instance',
        `Thread '${thread.id}' has a live session on provider instance '${runtimeSession.providerInstanceId ?? 'unknown'}', not '${outgoingInstanceId}'.`,
      )
      return
    }
    const hasLiveOutgoingSession =
      runtimeSession?.providerInstanceId === outgoingInstanceId &&
      runtimeSession.status !== 'closed'
    const hasRecoverableOutgoingSession =
      requireActiveEnvironment().recoverableById[outgoingInstanceId] ?? false

    const completeSwitch = Effect.fn('completeProviderSwitch')(function* (handoffText: string)
    {
      yield* orchestrationEngine.dispatch({
        type: 'thread.provider.switch.complete',
        commandId: yield* serverCommandId('provider-switch-complete'),
        threadId: thread.id,
        ...(event.payload.sourceModelSelection === undefined
          ? { expectedRequestedAt: event.occurredAt }
          : { requestId: event.eventId }),
        sourceModelSelection: thread.modelSelection,
        modelSelection: event.payload.targetModelSelection,
        fromInstanceId: outgoingInstanceId,
        fromModel: thread.modelSelection.model,
        handoffText,
      })
      threadModelSelections.set(thread.id, event.payload.targetModelSelection)
      yield* scheduleProviderSwitchCleanup({
        threadId: thread.id,
        sourceInstanceId: outgoingInstanceId,
      })
    })

    if (!hasLiveOutgoingSession && !hasRecoverableOutgoingSession)
    {
      yield* completeSwitch('').pipe(
        Effect.catchCause((cause) => failSwitch('internal-error', formatFailureDetail(cause))),
      )
      return
    }

    const compactedHandoff = yield* Effect.gen(function* ()
    {
      const outgoingInfo = yield* getPlannedInstanceInfo(outgoingInstanceId)
      const ensuredSession = yield* ensureSessionForThread(thread.id, event.occurredAt, {
        modelSelection: thread.modelSelection,
      })

      const providerSnapshots = requireActiveEnvironment().providerSnapshots
      const outgoingSnapshot = providerSnapshots.find(
        (snapshot) => snapshot.instanceId === outgoingInstanceId,
      )
      const compactionModel = resolveProviderSwitchCompactionModel({
        driverKind: outgoingInfo.driverKind,
        currentModel: ensuredSession?.model ?? thread.modelSelection.model,
        availableModels: outgoingSnapshot?.models.map((model) => model.slug) ?? [],
      })
      yield* progressProviderSwitch({
        threadId: thread.id,
        ...(event.payload.sourceModelSelection === undefined
          ? { expectedRequestedAt: event.occurredAt }
          : { requestId: event.eventId }),
        phase: 'compacting',
      })
      const hiddenTurn = yield* sendTurnAndAwait(providerServiceWithEffectContext(), {
        providerInstanceId: outgoingInstanceId,
        request: {
          threadId: thread.id,
          input: PROVIDER_SWITCH_COMPACTION_PROMPT,
          modelSelection: {
            ...thread.modelSelection,
            model: compactionModel,
          },
          interactionMode: 'default',
        },
      })
      const handoffText = hiddenTurn.text.trim()
      if (hiddenTurn.terminalState !== 'completed')
      {
        return yield* new HiddenTurnAwaitError({
          threadId: thread.id,
          detail: `Provider handoff turn ended with state '${hiddenTurn.terminalState}'.`,
        })
      }
      if (handoffText.length === 0)
      {
        return yield* new HiddenTurnAwaitError({
          threadId: thread.id,
          detail: 'Provider handoff turn completed without a handoff summary.',
        })
      }
      return handoffText
    }).pipe(
      Effect.map(Option.some),
      Effect.catchCause((cause) =>
        failSwitch(
          cause.reasons.some(
            (reason) =>
              Cause.isFailReason(reason) &&
              reason.error instanceof HiddenTurnAwaitError &&
              reason.error.detail.includes('timed out'),
          )
            ? 'compaction-timeout'
            : 'compaction-failed',
          formatFailureDetail(cause),
        ).pipe(Effect.as(Option.none())),
      ),
    )
    if (Option.isNone(compactedHandoff))
    {
      return
    }

    const progressedToFinalizing = yield* progressProviderSwitch({
      threadId: thread.id,
      ...(event.payload.sourceModelSelection === undefined
        ? { expectedRequestedAt: event.occurredAt }
        : { requestId: event.eventId }),
      phase: 'finalizing',
    }).pipe(
      Effect.as(true),
      Effect.catchCause((cause) =>
        failSwitch('internal-error', formatFailureDetail(cause)).pipe(Effect.as(false)),
      ),
    )
    if (!progressedToFinalizing)
    {
      return
    }

    yield* completeSwitch(compactedHandoff.value).pipe(
      Effect.catchCause((cause) => failSwitch('internal-error', formatFailureDetail(cause))),
    )
  })

  const processApprovalResponseRequested = Effect.fn('processApprovalResponseRequested')(function* (
    event: Extract<ProviderIntentEvent, { type: 'thread.approval-response-requested' }>,
  )
  {
    const thread = yield* resolveThread(event.payload.threadId)
    if (!thread)
    {
      return
    }
    const hasSession = thread.session && thread.session.status !== 'stopped'
    if (!hasSession)
    {
      const detail = 'No active provider session is bound to this thread.'
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: 'provider.approval.respond.failed',
        summary: 'Provider approval response failed',
        detail,
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.requestId,
        approvalOutcome: {
          requestId: event.payload.requestId,
          status: 'stale-terminal',
          requestedDecision: event.payload.decision,
          detail,
          ...(activeActionId === undefined ? {} : { actionId: activeActionId }),
          updatedAt: event.payload.createdAt,
        },
      })
    }

    yield* invokeProvider(
      providerService.respondToRequest(
        {
          threadId: event.payload.threadId,
          requestId: event.payload.requestId,
          decision: event.payload.decision,
        },
        activeEffectContext,
      ),
    ).pipe(
      Effect.andThen(
        appendApprovalAcceptedActivity({
          thread,
          requestId: event.payload.requestId,
          decision: event.payload.decision,
          createdAt: event.payload.createdAt,
        }),
      ),
      Effect.catchCause((cause) =>
      {
        const staleTerminal = isUnknownPendingApprovalRequestError(cause)
        const detail = staleTerminal
          ? stalePendingRequestDetail('approval', event.payload.requestId)
          : formatFailureDetail(cause)
        return appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: 'provider.approval.respond.failed',
          summary: 'Provider approval response failed',
          detail,
          turnId: null,
          createdAt: event.payload.createdAt,
          requestId: event.payload.requestId,
          approvalOutcome: {
            requestId: event.payload.requestId,
            status: staleTerminal ? 'stale-terminal' : 'unknown',
            requestedDecision: event.payload.decision,
            detail,
            ...(activeActionId === undefined ? {} : { actionId: activeActionId }),
            updatedAt: event.payload.createdAt,
          },
        })
      }),
    )
  })

  const processUserInputResponseRequested = Effect.fn('processUserInputResponseRequested')(
    function* (
      event: Extract<ProviderIntentEvent, { type: 'thread.user-input-response-requested' }>,
    )
    {
      const thread = yield* resolveThread(event.payload.threadId)
      if (!thread)
      {
        return
      }
      const hasSession = thread.session && thread.session.status !== 'stopped'
      if (!hasSession)
      {
        return yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: 'provider.user-input.respond.failed',
          summary: 'Provider user input response failed',
          detail: 'No active provider session is bound to this thread.',
          turnId: null,
          createdAt: event.payload.createdAt,
          requestId: event.payload.requestId,
        })
      }

      yield* invokeProvider(
        providerService.respondToUserInput(
          {
            threadId: event.payload.threadId,
            requestId: event.payload.requestId,
            answers: event.payload.answers,
          },
          activeEffectContext,
        ),
      ).pipe(
        Effect.catchCause((cause) =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: 'provider.user-input.respond.failed',
            summary: 'Provider user input response failed',
            detail: isUnknownPendingUserInputRequestError(cause)
              ? stalePendingRequestDetail('user-input', event.payload.requestId)
              : Cause.pretty(cause),
            turnId: null,
            createdAt: event.payload.createdAt,
            requestId: event.payload.requestId,
          }),
        ),
      )
    },
  )

  const processOrchestratePlanResponseRequested = Effect.fn(
    'processOrchestratePlanResponseRequested',
  )(function* (
    event: Extract<ProviderIntentEvent, { type: 'thread.orchestrate-plan-response-requested' }>,
  )
  {
    const thread = yield* resolveThread(event.payload.threadId)
    if (!thread)
    {
      return
    }
    const hasSession = thread.session && thread.session.status !== 'stopped'
    if (!hasSession)
    {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: 'provider.orchestrate-plan.respond.failed',
        summary: 'Provider orchestrate plan response failed',
        detail: 'No active provider session is bound to this thread.',
        turnId: null,
        createdAt: event.payload.createdAt,
      })
    }

    const collaborationMode = normalizeCollaborationMode(thread.interactionMode, thread.orchestrate)
    yield* buildSendTurnRequestForThread({
      threadId: event.payload.threadId,
      messageText: buildOrchestratePlanResponseEnvelope(event.payload),
      ...toWireInteractionMode({ ...collaborationMode, orchestrate: true }),
      createdAt: event.payload.createdAt,
    }).pipe(
      Effect.flatMap((built) =>
        invokeProvider(
          providerService.sendTurn(built.request, undefined, activeEffectContext),
        ).pipe(
          Effect.flatMap(() =>
            built.handoffDeliveryMarker === undefined
              ? Effect.void
              : appendProviderHandoffDeliveredActivity({
                  threadId: event.payload.threadId,
                  marker: built.handoffDeliveryMarker,
                  createdAt: event.payload.createdAt,
                }),
          ),
        ),
      ),
      Effect.catchCause((cause) =>
        appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: 'provider.orchestrate-plan.respond.failed',
          summary: 'Provider orchestrate plan response failed',
          detail: Cause.pretty(cause),
          turnId: null,
          createdAt: event.payload.createdAt,
        }),
      ),
    )
  })

  const processSessionStopRequested = Effect.fn('processSessionStopRequested')(function* (
    event: Extract<ProviderIntentEvent, { type: 'thread.session-stop-requested' }>,
  )
  {
    const thread = yield* resolveThread(event.payload.threadId)
    if (!thread)
    {
      return
    }

    const now = event.payload.createdAt
    if (thread.session && thread.session.status !== 'stopped')
    {
      const stopped = yield* invokeProvider(
        providerService.stopSession(
          {
            threadId: thread.id,
            ...(thread.session.providerInstanceId === undefined
              ? {}
              : { expectedProviderInstanceId: thread.session.providerInstanceId }),
          },
          activeEffectContext,
        ),
      ).pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          appendProviderFailureActivity({
            threadId: thread.id,
            kind: 'provider.session.stop.failed',
            summary: 'Provider session stop failed',
            detail: formatFailureDetail(cause),
            turnId: null,
            createdAt: now,
          }).pipe(Effect.as(false)),
        ),
      )
      if (!stopped)
      {
        yield* setThreadSession({
          threadId: thread.id,
          session: {
            ...thread.session,
            updatedAt: now,
          },
          createdAt: now,
        })
        return
      }
    }

    yield* setThreadSession({
      threadId: thread.id,
      session: {
        threadId: thread.id,
        status: 'stopped',
        providerName: thread.session?.providerName ?? null,
        ...(thread.session?.providerInstanceId !== undefined
          ? { providerInstanceId: thread.session.providerInstanceId }
          : {}),
        runtimeMode: thread.session?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        activeTurnId: null,
        lastError: thread.session?.lastError ?? null,
        updatedAt: now,
      },
      createdAt: now,
    })
  })

  const processDomainEvent = Effect.fn('processDomainEvent')(function* (
    event: ProviderIntentEvent,
  )
  {
    yield* Effect.annotateCurrentSpan({
      'orchestration.event_type': event.type,
      'orchestration.thread_id': event.payload.threadId,
      ...(event.commandId ? { 'orchestration.command_id': event.commandId } : {}),
    })
    yield* increment(orchestrationEventsProcessedTotal, {
      eventType: event.type,
    })
    switch (event.type)
    {
      case 'thread.runtime-mode-set':
      {
        const thread = yield* resolveThread(event.payload.threadId)
        if (!thread?.session || thread.session.status === 'stopped')
        {
          return
        }
        const cachedModelSelection =
          requireActiveEnvironment().rememberedModelSelection ?? undefined
        yield* ensureSessionForThread(
          event.payload.threadId,
          event.occurredAt,
          cachedModelSelection !== undefined ? { modelSelection: cachedModelSelection } : {},
        )
        return
      }
      case 'thread.turn-start-requested':
        yield* processTurnStartRequested(event)
        return
      case 'thread.provider-switch-requested':
        yield* processProviderSwitchRequested(event)
        return
      case 'thread.turn-interrupt-requested':
        yield* processTurnInterruptRequested(event)
        return
      case 'thread.approval-response-requested':
        yield* processApprovalResponseRequested(event)
        return
      case 'thread.user-input-response-requested':
        yield* processUserInputResponseRequested(event)
        return
      case 'thread.orchestrate-plan-response-requested':
        yield* processOrchestratePlanResponseRequested(event)
        return
      case 'thread.session-stop-requested':
        yield* processSessionStopRequested(event)
        return
    }
  })

  // publish the pre-turn snapshot at the provider boundary so neither the
  // provider session nor the turn can mutate workspace bytes first
  const ensurePreTurnBaselineBeforeProvider = Effect.fn('ensurePreTurnBaselineBeforeProvider')(
    function* (capturedAt: string)
    {
      const environment = requireActiveEnvironment()
      const thread = environment.thread
      if (thread === null || (thread.origin !== null && thread.latestTurn === null))
      {
        return
      }

      const checkpointCwd =
        environment.workspaceCwd ??
        environment.runtimeSessions.find((session) => session.threadId === thread.id)?.cwd
      if (!checkpointCwd || !(yield* checkpointStore.isGitRepository(checkpointCwd)))
      {
        return
      }

      const currentTurnCount = thread.checkpoints.reduce(
        (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
        0,
      )
      const checkpointRef = checkpointRefForThreadTurn(thread.id, currentTurnCount)
      const baselineExists = yield* checkpointStore.hasCheckpointRef({
        cwd: checkpointCwd,
        checkpointRef,
      })
      let publishedCommitOid: string | undefined
      if (!baselineExists)
      {
        // the ref is the reusable half of the transaction. retries publish only
        // when absent, but always replay the deterministic domain record below.
        const publication = yield* checkpointStore.captureCheckpoint({
          cwd: checkpointCwd,
          checkpointRef,
          expected: { kind: 'absent' },
        })
        if (publication.outcome === 'published')
        {
          publishedCommitOid = publication.commitOid
        }
      }

      // the event is committed before provider invocation so turn zero has the
      // same durable root/common-dir/OID evidence as every completed turn
      const identity = yield* checkpointIdentity.resolveCapture({
        cwd: checkpointCwd,
        checkpointRef,
        checkpointTurnCount: currentTurnCount,
        ...(publishedCommitOid === undefined ? {} : { expectedCommitOid: publishedCommitOid }),
      })
      yield* orchestrationEngine.dispatch({
        type: 'thread.checkpoint.baseline.record',
        commandId: yield* serverCommandId('checkpoint-baseline-record'),
        threadId: thread.id,
        checkpointTurnCount: currentTurnCount,
        checkpointRef,
        checkpointCaptureRoot: identity.checkpointCaptureRoot,
        checkpointRepositoryCommonDir: identity.checkpointRepositoryCommonDir,
        checkpointCommitOid: identity.checkpointCommitOid,
        capturedAt,
        createdAt: capturedAt,
      })
    },
  )

  const compensateProviderSwitch = Effect.fn('compensateProviderSwitch')(function* (input: {
    readonly event: Extract<ProviderIntentEvent, { type: 'thread.provider-switch-requested' }>
    readonly detail: string
    readonly originalActionId?: string
  })
  {
    const thread = Option.getOrUndefined(
      yield* projectionSnapshotQuery.getThreadShellById(input.event.payload.threadId),
    )
    if (thread === undefined)
    {
      return yield* new ProviderSwitchCompensationReadError({
        threadId: input.event.payload.threadId,
      })
    }
    const providerSwitch = thread?.providerSwitch
    const ownsRequest =
      providerSwitch !== null &&
      providerSwitch !== undefined &&
      (providerSwitch.requestId === input.event.eventId ||
        (providerSwitch.requestId === undefined &&
          providerSwitch.requestedAt === input.event.occurredAt))

    if (ownsRequest)
    {
      const sourceModelSelection =
        providerSwitch.sourceModelSelection ??
        input.event.payload.sourceModelSelection ??
        thread.modelSelection
      const targetModelSelection =
        providerSwitch.targetModel === null
          ? undefined
          : {
              instanceId: providerSwitch.targetInstanceId,
              model: providerSwitch.targetModel,
            }
      yield* failProviderSwitchAndRepair({
        threadId: thread.id,
        ...(providerSwitch.requestId === undefined
          ? { expectedRequestedAt: providerSwitch.requestedAt }
          : { requestId: providerSwitch.requestId }),
        sourceModelSelection,
        ...(targetModelSelection === undefined ? {} : { targetModelSelection }),
        reasonCode: 'internal-error',
        detail: input.detail,
      })
    }

    if (input.originalActionId !== undefined)
    {
      yield* delivery.resolve({
        actionId: input.originalActionId,
        resolution: 'skip',
        operator: 'provider-switch-compensation',
        detail: input.detail,
        now: DateTime.formatIso(yield* DateTime.now),
      })
    }
  })

  const planEnvironment = Effect.fn('ProviderCommandReactor.planEnvironment')(function* (
    event: ProviderIntentEvent,
  )
  {
    const thread = Option.getOrNull(
      yield* projectionSnapshotQuery.getThreadDetailById(event.payload.threadId),
    )
    const requiresRuntimeSnapshot =
      event.type === 'thread.runtime-mode-set' ||
      event.type === 'thread.turn-start-requested' ||
      event.type === 'thread.provider-switch-requested'
    const project =
      thread === null || !requiresRuntimeSnapshot
        ? null
        : Option.getOrNull(yield* projectionSnapshotQuery.getProjectShellById(thread.projectId))
    const runtimeSessions = requiresRuntimeSnapshot ? yield* providerService.listSessions() : []
    const providerSnapshots = requiresRuntimeSnapshot ? yield* providerRegistry.getProviders : []
    const instanceIds = new Set<string>()
    if (thread !== null)
    {
      instanceIds.add(thread.modelSelection.instanceId)
      if (thread.session?.providerInstanceId !== undefined)
      {
        instanceIds.add(thread.session.providerInstanceId)
      }
    }
    for (const session of runtimeSessions)
    {
      if (session.providerInstanceId !== undefined)
      {
        instanceIds.add(session.providerInstanceId)
      }
    }
    if (event.type === 'thread.turn-start-requested')
    {
      if (event.payload.modelSelection !== undefined)
      {
        instanceIds.add(event.payload.modelSelection.instanceId)
      }
      if (event.payload.importContinuationAuthority !== undefined)
      {
        instanceIds.add(event.payload.importContinuationAuthority.targetProviderInstanceId)
      }
    }
    if (event.type === 'thread.provider-switch-requested')
    {
      instanceIds.add(event.payload.targetModelSelection.instanceId)
    }

    const instanceInfoById: Record<string, ProviderInstanceRoutingInfo> = {}
    const capabilitiesById: Record<string, ProviderAdapterCapabilities> = {}
    if (requiresRuntimeSnapshot)
    {
      yield* Effect.forEach(
        instanceIds,
        (instanceId) =>
          Effect.all({
            info: providerService
              .getInstanceInfo(ProviderInstanceId.make(instanceId))
              .pipe(Effect.option),
            capabilities: providerService
              .getCapabilities(ProviderInstanceId.make(instanceId))
              .pipe(Effect.option),
          }).pipe(
            Effect.tap(({ info, capabilities }) =>
              Effect.sync(() =>
              {
                if (Option.isSome(info))
                {
                  instanceInfoById[instanceId] = info.value
                }
                if (Option.isSome(capabilities))
                {
                  capabilitiesById[instanceId] = capabilities.value
                }
              }),
            ),
          ),
        { discard: true },
      )
    }

    const recoverableById: Record<string, boolean> = {}
    let providerSwitchPlanningError: string | undefined
    if (
      event.type === 'thread.provider-switch-requested' &&
      thread !== null &&
      providerService.hasRecoverableSession !== undefined
    )
    {
      const outgoingInstanceId = thread.modelSelection.instanceId
      const recoverable = yield* Effect.exit(
        providerService.hasRecoverableSession(thread.id, outgoingInstanceId),
      )
      if (recoverable._tag === 'Success')
      {
        recoverableById[outgoingInstanceId] = recoverable.value
      }
      else
      {
        providerSwitchPlanningError = formatFailureDetail(recoverable.cause)
      }
    }

    let branchModelSelection: ModelSelection | null = null
    let titleModelSelection: ModelSelection | null = null
    const workspaceCwd =
      thread === null
        ? null
        : (resolveThreadWorkspaceCwd({
            thread,
            projects: project === null ? [] : [project],
          }) ?? null)
    const titleGenerationCwd = workspaceCwd ?? process.cwd()
    if (event.type === 'thread.turn-start-requested' && thread !== null)
    {
      const isFirstUserMessage =
        thread.messages.filter((message) => message.role === 'user').length === 1
      if (isFirstUserMessage)
      {
        const needsBranchGeneration =
          thread.branch !== null &&
          thread.worktreePath !== null &&
          isTemporaryWorktreeBranch(thread.branch)
        const needsTitleGeneration = canReplaceThreadTitle(thread.title, event.payload.titleSeed)
        if (needsBranchGeneration || needsTitleGeneration)
        {
          const settings = yield* serverSettingsService.getSettings.pipe(Effect.option)
          if (Option.isSome(settings))
          {
            branchModelSelection = needsBranchGeneration
              ? settings.value.sourceControlWriterModelSelection === null
                ? settings.value.textGenerationModelSelection
                : resolveSourceControlWriterModelSelection(settings.value, providerSnapshots)
              : null
            titleModelSelection = needsTitleGeneration
              ? settings.value.textGenerationModelSelection
              : null
          }
        }
      }
    }

    return {
      thread,
      project,
      runtimeSessions,
      providerSnapshots,
      instanceInfoById,
      capabilitiesById,
      recoverableById,
      ...(providerSwitchPlanningError === undefined ? {} : { providerSwitchPlanningError }),
      rememberedModelSelection: threadModelSelections.get(event.payload.threadId) ?? null,
      workspaceCwd,
      titleGenerationCwd,
      hiddenTurnPending:
        event.type === 'thread.turn-start-requested' &&
        hasPendingHiddenTurnForThread(event.payload.threadId),
      branchModelSelection,
      titleModelSelection,
    } satisfies PlannedProviderEnvironment
  })

  const definition: DurableReactorDefinition = {
    reactorId: REACTOR_ID,
    operationVersion: OPERATION_VERSION,
    plan: (event) =>
    {
      if (!isProviderIntentEvent(event))
      {
        return Effect.succeed([])
      }
      return planEnvironment(event).pipe(
        Effect.flatMap((environment) =>
        {
          const compensationOfActionId =
            event.type === 'thread.provider-switch-requested'
              ? makeReactorActionId({
                  reactorId: REACTOR_ID,
                  sourceSequence: event.sequence,
                  sourceEventId: event.eventId,
                  outputIndex: 0,
                  effectKind: event.type,
                  targetKind: 'thread',
                  targetId: event.payload.threadId,
                  operationVersion: OPERATION_VERSION,
                })
              : undefined
          return encodeProviderActionPayload({
            event,
            environment,
            ...(compensationOfActionId === undefined ? {} : { compensationOfActionId }),
          }).pipe(
            Effect.map((payloadJson) =>
            {
              const drafts: ReactorActionDraft[] = [
                {
                  outputIndex: 0,
                  effectKind: event.type,
                  targetKind: 'thread',
                  targetId: event.payload.threadId,
                  payloadJson,
                },
              ]
              if (event.type === 'thread.provider-switch-requested')
              {
                drafts.push({
                  outputIndex: 1,
                  effectKind: 'thread.provider.switch.compensate',
                  targetKind: 'thread',
                  targetId: event.payload.threadId,
                  payloadJson,
                })
                return drafts
              }
              if (event.type !== 'thread.turn-start-requested' || environment.thread === null)
              {
                return drafts
              }
              const message = environment.thread.messages.find(
                (entry) => entry.id === event.payload.messageId && entry.role === 'user',
              )
              const isFirstUserMessage =
                environment.thread.messages.filter((entry) => entry.role === 'user').length === 1
              if (message === undefined || !isFirstUserMessage)
              {
                return drafts
              }
              if (
                environment.thread.branch !== null &&
                environment.thread.worktreePath !== null &&
                isTemporaryWorktreeBranch(environment.thread.branch)
              )
              {
                drafts.push({
                  outputIndex: drafts.length,
                  effectKind: 'first-turn.worktree-branch.generate',
                  targetKind: 'thread',
                  targetId: event.payload.threadId,
                  payloadJson,
                })
              }
              if (canReplaceThreadTitle(environment.thread.title, event.payload.titleSeed))
              {
                drafts.push({
                  outputIndex: drafts.length,
                  effectKind: 'first-turn.thread-title.generate',
                  targetKind: 'thread',
                  targetId: event.payload.threadId,
                  payloadJson,
                })
              }
              return drafts
            }),
          )
        }),
        Effect.catchCause((cause) =>
          event.type !== 'thread.provider-switch-requested'
            ? Effect.failCause(cause)
            : encodeProviderActionPayload({
                event,
                environment: null,
                planningFailure: formatFailureDetail(cause),
              }).pipe(
                Effect.map(
                  (payloadJson) =>
                    [
                      {
                        outputIndex: 0,
                        effectKind: 'thread.provider.switch.compensate',
                        targetKind: 'thread',
                        targetId: event.payload.threadId,
                        payloadJson,
                      },
                    ] satisfies ReactorActionDraft[],
                ),
              ),
        ),
      )
    },
    execute: Effect.fn('ProviderCommandReactor.execute')(function* (action)
    {
      const decoded = yield* decodeProviderActionPayload(action.payloadJson)
      if (!isProviderIntentEvent(decoded.event))
      {
        return yield* new ProviderCommandPayloadError({
          detail: `Action ${action.actionId} does not contain a provider intent event.`,
        })
      }
      const providerEvent = decoded.event as ProviderIntentEvent
      const isPrimaryEffect = providerEvent.type === action.effectKind
      const isProviderSwitchCompensation =
        providerEvent.type === 'thread.provider-switch-requested' &&
        action.effectKind === 'thread.provider.switch.compensate'
      const isFirstTurnFollowUp =
        providerEvent.type === 'thread.turn-start-requested' &&
        (action.effectKind === 'first-turn.worktree-branch.generate' ||
          action.effectKind === 'first-turn.thread-title.generate')
      if (
        providerEvent.payload.threadId !== action.targetId ||
        (!isPrimaryEffect && !isFirstTurnFollowUp && !isProviderSwitchCompensation)
      )
      {
        return yield* new ProviderCommandPayloadError({
          detail: `Action ${action.actionId} does not match its provider event target.`,
        })
      }

      activeActionId = action.actionId
      activeActionCommandSeq = 0
      activeEffectContext = {
        actionId: action.actionId,
        idempotencyKey: action.actionId,
        sourceSequence: action.sourceSequence,
        operationVersion: action.operationVersion,
      }
      activeEnvironment =
        decoded.environment === null
          ? undefined
          : (decoded.environment as PlannedProviderEnvironment)
      providerInvocationMayHaveBeenReceived = false
      unknownProviderFailureDetail = undefined
      const actionEffect = Effect.gen(function* ()
      {
        if (isProviderSwitchCompensation)
        {
          return yield* compensateProviderSwitch({
            event: providerEvent,
            detail:
              decoded.planningFailure ??
              'Provider switch action did not reach a determinate terminal outcome.',
            ...(decoded.compensationOfActionId === undefined
              ? {}
              : { originalActionId: decoded.compensationOfActionId }),
          })
        }
        if (isPrimaryEffect)
        {
          if (providerEvent.type === 'thread.turn-start-requested')
          {
            yield* ensurePreTurnBaselineBeforeProvider(providerEvent.payload.createdAt)
          }
          return yield* processDomainEvent(providerEvent)
        }
        if (
          providerEvent.type !== 'thread.turn-start-requested' ||
          activeEnvironment?.thread === null ||
          activeEnvironment?.thread === undefined
        )
        {
          return yield* new ProviderCommandPayloadError({
            detail: `Action ${action.actionId} is missing its first-turn snapshot.`,
          })
        }
        const thread = activeEnvironment.thread
        const message = thread.messages.find(
          (entry) => entry.id === providerEvent.payload.messageId && entry.role === 'user',
        )
        if (message === undefined)
        {
          return yield* new ProviderCommandPayloadError({
            detail: `Action ${action.actionId} is missing its first-turn user message.`,
          })
        }
        if (action.effectKind === 'first-turn.worktree-branch.generate')
        {
          return yield* maybeGenerateAndRenameWorktreeBranchForFirstTurn({
            threadId: thread.id,
            sourceSequence: providerEvent.sequence,
            branch: thread.branch,
            worktreePath: thread.worktreePath,
            messageText: message.text,
            ...(message.attachments === undefined ? {} : { attachments: message.attachments }),
          })
        }
        return yield* maybeGenerateThreadTitleForFirstTurn({
          threadId: thread.id,
          sourceSequence: providerEvent.sequence,
          cwd: activeEnvironment.titleGenerationCwd,
          messageText: message.text,
          ...(message.attachments === undefined ? {} : { attachments: message.attachments }),
          ...(providerEvent.payload.titleSeed === undefined
            ? {}
            : { titleSeed: providerEvent.payload.titleSeed }),
        })
      })
      let execution = yield* Effect.exit(actionEffect)
      let unknownDetail = unknownProviderFailureDetail
      const mayHaveBeenReceived = providerInvocationMayHaveBeenReceived
      let providerSwitchFallbackFailed = false
      if (
        isPrimaryEffect &&
        providerEvent.type === 'thread.provider-switch-requested' &&
        (execution._tag === 'Failure' || unknownDetail !== undefined)
      )
      {
        const detail =
          unknownDetail ??
          (execution._tag === 'Failure'
            ? formatFailureDetail(execution.cause)
            : 'Provider switch execution failed without a terminal outcome.')
        const fallback = yield* Effect.exit(
          compensateProviderSwitch({ event: providerEvent, detail }),
        )
        if (fallback._tag === 'Success')
        {
          execution = fallback
          unknownDetail = undefined
        }
        else
        {
          execution = fallback
          unknownDetail = undefined
          providerSwitchFallbackFailed = true
        }
      }
      activeActionId = undefined
      activeEffectContext = undefined
      activeEnvironment = undefined
      providerInvocationMayHaveBeenReceived = false
      unknownProviderFailureDetail = undefined

      if (providerSwitchFallbackFailed && execution._tag === 'Failure')
      {
        return yield* Effect.failCause(execution.cause)
      }
      if (unknownDetail !== undefined)
      {
        return { status: 'unknown' as const, detail: unknownDetail }
      }
      if (execution._tag === 'Success')
      {
        return { status: 'succeeded' as const }
      }
      const cause = execution.cause
      if (Cause.hasInterruptsOnly(cause))
      {
        return yield* Effect.failCause(cause)
      }
      if (isDeterminateProviderFailure(cause))
      {
        yield* Effect.logWarning(
          'provider command reactor handled determinate provider rejection',
          {
            eventType: providerEvent.type,
            threadId: providerEvent.payload.threadId,
            cause: Cause.pretty(cause),
          },
        )
        return { status: 'succeeded' as const }
      }
      if (mayHaveBeenReceived)
      {
        return {
          status: 'unknown' as const,
          detail: formatFailureDetail(cause),
        }
      }
      return yield* Effect.failCause(cause)
    }),
    classify: (cause) =>
      Schema.isSchemaError(cause) || isProviderCommandPayloadError(cause) ? 'poison' : 'retryable',
    onLeaseExpiry: 'unknown',
  }

  const reconcileInterruptedProviderSwitches = Effect.fn('reconcileInterruptedProviderSwitches')(
    function* (reconciledAt: string)
    {
      const readModel = yield* projectionSnapshotQuery.getCommandReadModel()
      yield* Effect.forEach(
        readModel.threads,
        (thread) =>
          Effect.gen(function* ()
          {
            const providerSwitch = thread.providerSwitch
            if (providerSwitch === null)
            {
              return
            }
            const reconciliationKey = stableStringify({
              threadId: thread.id,
              requestedAt: providerSwitch.requestedAt,
              requestId: providerSwitch.requestId ?? null,
              targetInstanceId: providerSwitch.targetInstanceId,
              targetModel: providerSwitch.targetModel,
            })
            const requestId = providerSwitch.requestId
            const sourceModelSelection =
              providerSwitch.sourceModelSelection ?? thread.modelSelection
            const targetModelSelection =
              providerSwitch.targetModel === null
                ? undefined
                : {
                    instanceId: providerSwitch.targetInstanceId,
                    model: providerSwitch.targetModel,
                  }
            yield* orchestrationEngine.dispatch({
              type: 'thread.provider.switch.fail',
              commandId: CommandId.make(
                `server:provider-switch-restart-failed:${reconciliationKey}`,
              ),
              threadId: thread.id,
              ...(requestId === undefined
                ? { expectedRequestedAt: providerSwitch.requestedAt }
                : { requestId }),
              sourceModelSelection,
              ...(targetModelSelection === undefined ? {} : { targetModelSelection }),
              reasonCode: 'interrupted-by-restart',
              detail: `Provider switch was interrupted by a server restart during '${providerSwitch.phase}'.`,
            })
            yield* scheduleProviderSwitchCleanup({
              threadId: thread.id,
              sourceInstanceId: sourceModelSelection.instanceId,
            })
            if (
              providerSwitch.requestId !== undefined &&
              providerSwitch.requestSequence !== undefined
            )
            {
              for (const action of [
                { outputIndex: 0, effectKind: 'thread.provider-switch-requested' },
                { outputIndex: 1, effectKind: 'thread.provider.switch.compensate' },
              ] as const)
              {
                yield* delivery.skipStale({
                  actionId: makeReactorActionId({
                    reactorId: REACTOR_ID,
                    sourceSequence: providerSwitch.requestSequence,
                    sourceEventId: providerSwitch.requestId,
                    outputIndex: action.outputIndex,
                    effectKind: action.effectKind,
                    targetKind: 'thread',
                    targetId: thread.id,
                    operationVersion: OPERATION_VERSION,
                  }),
                  sourceEventId: providerSwitch.requestId,
                  operator: 'provider-switch-startup-reconciliation',
                  detail: 'provider switch was terminalized during startup reconciliation',
                  now: reconciledAt,
                })
              }
            }
            else
            {
              for (const effectKind of [
                'thread.provider-switch-requested',
                'thread.provider.switch.compensate',
              ])
              {
                yield* delivery.skipStaleByTarget({
                  reactorId: REACTOR_ID,
                  targetKind: 'thread',
                  targetId: thread.id,
                  effectKind,
                  operator: 'provider-switch-startup-reconciliation',
                  detail: 'legacy provider switch was terminalized during startup reconciliation',
                  now: reconciledAt,
                })
              }
            }
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning('provider switch startup reconciliation failed for thread', {
                threadId: thread.id,
                cause: Cause.pretty(cause),
              }),
            ),
          ),
        { concurrency: 1, discard: true },
      )
    },
  )

  const start: ProviderCommandReactorShape['start'] = Effect.fn('start')(function* ()
  {
    const startedAt = DateTime.formatIso(yield* DateTime.now)
    const existingProgress = yield* delivery.getProgress(REACTOR_ID)
    const initialSequence = Option.isSome(existingProgress)
      ? 0
      : (yield* projectionSnapshotQuery.getSnapshotSequence().pipe(
          Effect.mapError(
            (cause) =>
              new ReactorDeliveryError({
                operation: 'ProviderCommandReactor.start:initialSequence',
                cause,
              }),
          ),
        )).snapshotSequence
    const progress = yield* delivery.ensureProgress({
      reactorId: REACTOR_ID,
      operationVersion: OPERATION_VERSION,
      initialSequence,
      mode: 'durable',
      now: startedAt,
    })
    if (progress.mode === 'shadow')
    {
      yield* delivery.setMode({
        reactorId: REACTOR_ID,
        mode: 'durable',
        ownerId: `${REACTOR_ID}:cutover`,
        now: startedAt,
      })
    }
    yield* reconcileInterruptedProviderSwitches(startedAt).pipe(
      Effect.mapError(
        (cause) =>
          new ReactorDeliveryError({
            operation: 'ProviderCommandReactor.start:reconcileProviderSwitches',
            cause,
          }),
      ),
    )
    yield* durableRunner.start(definition)
  })

  return {
    start,
    drain: durableRunner.drain(REACTOR_ID),
  } satisfies ProviderCommandReactorShape
})

export const ProviderCommandReactorLive = Layer.effect(ProviderCommandReactor, make).pipe(
  Layer.provideMerge(DurableReactorInfrastructureLive),
)
