// apps/mobile/src/state/threads/thread-outbox-delivery.ts
// coordinates authoritative queued-turn dispatch and durable failures

import type {
  SetThreadInteractionModeInput,
  SetThreadRuntimeModeInput,
  StartThreadTurnInput,
  UpdateThreadMetadataInput,
} from '@t3tools/client-runtime/operations'
import type { AtomCommandResult } from '@t3tools/client-runtime/state/runtime'
import type {
  EnvironmentShellStatus,
  EnvironmentThreadShell,
} from '@t3tools/client-runtime/state/shell'
import {
  CommandId,
  normalizeCollaborationMode,
  toWireInteractionMode,
  type EnvironmentId,
} from '@t3tools/contracts'
import * as Cause from 'effect/Cause'
import { AsyncResult } from 'effect/unstable/reactivity'

import { toUploadChatImageAttachments } from '../../lib/composerImages'
import {
  describeThreadOutboxFailure,
  modelSelectionsEqual,
  resolveQueuedThreadSettings,
  resolveThreadOutboxDeliveryAction,
  resolveThreadOutboxFailureAction,
  type QueuedThreadMessage,
  type ThreadOutboxCommandStage,
} from './thread-outbox-model'

type EnvironmentCommand<Input> = (value: {
  readonly environmentId: EnvironmentId
  readonly input: Input
}) => Promise<AtomCommandResult<unknown, unknown>>

export interface ExistingThreadOutboxState
{
  readonly thread: EnvironmentThreadShell | undefined
  readonly shellStatus: EnvironmentShellStatus
  readonly environmentConnected: boolean
}

export interface ExistingThreadOutboxCommands
{
  readonly updateThreadMetadata: EnvironmentCommand<UpdateThreadMetadataInput>
  readonly setThreadRuntimeMode: EnvironmentCommand<SetThreadRuntimeModeInput>
  readonly setThreadInteractionMode: EnvironmentCommand<SetThreadInteractionModeInput>
  readonly startTurn: EnvironmentCommand<StartThreadTurnInput>
}

export type ThreadOutboxDrainOutcome =
  | { readonly kind: 'complete' }
  | { readonly kind: 'wait' }
  | { readonly kind: 'retry'; readonly attempt: number }

interface ExistingThreadOutboxDeliveryInput extends ExistingThreadOutboxCommands
{
  readonly message: QueuedThreadMessage
  readonly initialState: ExistingThreadOutboxState
  readonly confirmQueued: (message: QueuedThreadMessage) => Promise<boolean>
  readonly readState: () => ExistingThreadOutboxState
  readonly update: (message: QueuedThreadMessage) => Promise<boolean>
  readonly remove: (message: QueuedThreadMessage) => Promise<void>
  readonly now: () => string
  readonly warn?: (message: string, detail: unknown) => void
}

const COMPLETE: ThreadOutboxDrainOutcome = { kind: 'complete' }
const WAIT: ThreadOutboxDrainOutcome = { kind: 'wait' }

function threadHasStarted(thread: EnvironmentThreadShell): boolean
{
  return (
    thread.session !== null || thread.latestTurn !== null || thread.latestUserMessageAt !== null
  )
}

function settingsCommandId(message: QueuedThreadMessage, setting: string)
{
  return CommandId.make(`${message.commandId}:${setting}`)
}

function deliveryAction(state: ExistingThreadOutboxState)
{
  return resolveThreadOutboxDeliveryAction({
    isCreation: false,
    threadExists: state.thread !== undefined,
    shellStatus: state.shellStatus,
    environmentConnected: state.environmentConnected,
    threadBusy:
      state.thread?.session?.status === 'running' || state.thread?.session?.status === 'starting',
    providerSwitchActive: state.thread !== undefined && state.thread.providerSwitch !== null,
  })
}

async function removeQueuedMessage(
  message: QueuedThreadMessage,
  remove: (message: QueuedThreadMessage) => Promise<void>,
  warn: (message: string, detail: unknown) => void,
): Promise<ThreadOutboxDrainOutcome>
{
  try
  {
    await remove(message)
    return COMPLETE
  }
  catch (error)
  {
    warn('[thread-outbox] failed to remove queued message', {
      environmentId: message.environmentId,
      threadId: message.threadId,
      messageId: message.messageId,
      error,
    })
    return { kind: 'retry', attempt: Math.max(1, message.deliveryAttemptCount ?? 0) }
  }
}

async function handleCommandFailure(input: {
  readonly message: QueuedThreadMessage
  readonly result: AtomCommandResult<unknown, unknown>
  readonly stage: ThreadOutboxCommandStage
  readonly update: (message: QueuedThreadMessage) => Promise<boolean>
  readonly warn: (message: string, detail: unknown) => void
}): Promise<ThreadOutboxDrainOutcome | null>
{
  if (!AsyncResult.isFailure(input.result))
  {
    return null
  }

  const error = Cause.squash(input.result.cause)
  const attempt =
    (input.stage === 'settings-sync'
      ? input.message.settingsSyncAttemptCount
      : input.message.deliveryAttemptCount) ?? 0
  const nextAttempt = attempt + 1
  const action = resolveThreadOutboxFailureAction({
    stage: input.stage,
    error,
    interrupted: Cause.hasInterruptsOnly(input.result.cause),
    attempt: nextAttempt,
  })
  input.warn('[thread-outbox] queued message delivery failed', {
    environmentId: input.message.environmentId,
    threadId: input.message.threadId,
    messageId: input.message.messageId,
    stage: input.stage,
    cause: input.result.cause,
    action,
  })

  if (action === 'wait')
  {
    const rotatedMessage = {
      ...input.message,
      commandId: settingsCommandId(input.message, 'provider-switch-retry'),
    }
    try
    {
      return (await input.update(rotatedMessage)) ? WAIT : COMPLETE
    }
    catch (persistError)
    {
      return persistDeliveryUpdateFailure({
        message: rotatedMessage,
        attempt: (input.message.deliveryAttemptCount ?? 0) + 1,
        error: persistError,
        update: input.update,
        warn: input.warn,
      })
    }
  }

  const attemptedMessage = {
    ...input.message,
    ...(input.stage === 'settings-sync'
      ? { settingsSyncAttemptCount: nextAttempt }
      : { deliveryAttemptCount: nextAttempt }),
    ...(action === 'fail'
      ? { failure: { reason: describeThreadOutboxFailure(input.stage, error) } }
      : {}),
  }
  try
  {
    const updated = await input.update(attemptedMessage)
    return updated
      ? action === 'fail'
        ? COMPLETE
        : { kind: 'retry', attempt: nextAttempt }
      : COMPLETE
  }
  catch (persistError)
  {
    return persistDeliveryUpdateFailure({
      message: attemptedMessage,
      attempt: (input.message.deliveryAttemptCount ?? 0) + 1,
      error: persistError,
      update: input.update,
      warn: input.warn,
    })
  }
}

async function persistDeliveryUpdateFailure(input: {
  readonly message: QueuedThreadMessage
  readonly attempt: number
  readonly error: unknown
  readonly update: (message: QueuedThreadMessage) => Promise<boolean>
  readonly warn: (message: string, detail: unknown) => void
}): Promise<ThreadOutboxDrainOutcome>
{
  const nextAttempt = input.attempt
  const action = resolveThreadOutboxFailureAction({
    stage: 'start-turn',
    error: input.error,
    interrupted: true,
    attempt: nextAttempt,
  })
  const attemptedMessage = {
    ...input.message,
    deliveryAttemptCount: Math.max(input.message.deliveryAttemptCount ?? 0, nextAttempt),
    ...(action === 'fail'
      ? { failure: { reason: describeThreadOutboxFailure('start-turn', input.error) } }
      : {}),
  }
  input.warn('[thread-outbox] failed to persist queued message delivery state', {
    environmentId: input.message.environmentId,
    threadId: input.message.threadId,
    messageId: input.message.messageId,
    error: input.error,
    action,
  })
  try
  {
    const updated = await input.update(attemptedMessage)
    return updated
      ? action === 'fail'
        ? COMPLETE
        : { kind: 'retry', attempt: nextAttempt }
      : COMPLETE
  }
  catch (persistError)
  {
    input.warn('[thread-outbox] failed to persist queued message attempt', {
      environmentId: input.message.environmentId,
      threadId: input.message.threadId,
      messageId: input.message.messageId,
      error: persistError,
    })
    return { kind: 'retry', attempt: nextAttempt }
  }
}

async function persistQueuedThreadFailure(input: {
  readonly message: QueuedThreadMessage
  readonly reason: string
  readonly update: (message: QueuedThreadMessage) => Promise<boolean>
  readonly warn?: (message: string, detail: unknown) => void
}): Promise<ThreadOutboxDrainOutcome>
{
  const warn = input.warn ?? console.warn
  try
  {
    await input.update({
      ...input.message,
      failure: { reason: input.reason },
    })
    return COMPLETE
  }
  catch (error)
  {
    return persistDeliveryUpdateFailure({
      message: input.message,
      attempt: (input.message.deliveryAttemptCount ?? 0) + 1,
      error,
      update: input.update,
      warn,
    })
  }
}

type ExistingThreadStateResolution =
  | { readonly kind: 'send'; readonly thread: EnvironmentThreadShell }
  | { readonly kind: 'outcome'; readonly outcome: ThreadOutboxDrainOutcome }

async function resolveExistingThreadState(input: {
  readonly message: QueuedThreadMessage
  readonly state: ExistingThreadOutboxState
  readonly update: (message: QueuedThreadMessage) => Promise<boolean>
  readonly remove: (message: QueuedThreadMessage) => Promise<void>
  readonly warn: (message: string, detail: unknown) => void
}): Promise<ExistingThreadStateResolution>
{
  const action = deliveryAction(input.state)
  if (action === 'wait')
  {
    return { kind: 'outcome', outcome: WAIT }
  }
  if (action === 'remove')
  {
    return {
      kind: 'outcome',
      outcome: await removeQueuedMessage(input.message, input.remove, input.warn),
    }
  }
  if (action === 'fail')
  {
    return {
      kind: 'outcome',
      outcome: await persistQueuedThreadFailure({
        ...input,
        reason: 'The thread is no longer available.',
      }),
    }
  }
  return { kind: 'send', thread: input.state.thread as EnvironmentThreadShell }
}

async function sendQueuedMessage(input: {
  readonly message: QueuedThreadMessage
  readonly thread: EnvironmentThreadShell
  readonly readState: () => ExistingThreadOutboxState
  readonly now: () => string
  readonly commands: ExistingThreadOutboxCommands
  readonly update: (message: QueuedThreadMessage) => Promise<boolean>
  readonly remove: (message: QueuedThreadMessage) => Promise<void>
  readonly warn: (message: string, detail: unknown) => void
}): Promise<ThreadOutboxDrainOutcome>
{
  const { message, commands } = input
  const handleFailure = (
    result: AtomCommandResult<unknown, unknown>,
    stage: ThreadOutboxCommandStage,
  ) =>
    handleCommandFailure({
      message,
      result,
      stage,
      update: input.update,
      warn: input.warn,
    })
  const readReadyThread = () =>
    resolveExistingThreadState({
      message,
      state: input.readState(),
      update: input.update,
      remove: input.remove,
      warn: input.warn,
    })

  let currentThread = input.thread
  let settings = resolveQueuedThreadSettings(
    message,
    currentThread,
    threadHasStarted(currentThread),
  )

  if (!modelSelectionsEqual(settings.modelSelection, currentThread.modelSelection))
  {
    const result = await commands.updateThreadMetadata({
      environmentId: message.environmentId,
      input: {
        commandId: settingsCommandId(message, 'model-selection'),
        threadId: message.threadId,
        modelSelection: settings.modelSelection,
      },
    })
    const failure = await handleFailure(result, 'settings-sync')
    if (failure !== null)
    {
      return failure
    }
    const current = await readReadyThread()
    if (current.kind === 'outcome')
    {
      return current.outcome
    }
    currentThread = current.thread
    settings = resolveQueuedThreadSettings(message, currentThread, threadHasStarted(currentThread))
  }

  if (settings.runtimeMode !== currentThread.runtimeMode)
  {
    const result = await commands.setThreadRuntimeMode({
      environmentId: message.environmentId,
      input: {
        commandId: settingsCommandId(message, 'runtime-mode'),
        threadId: message.threadId,
        runtimeMode: settings.runtimeMode,
        createdAt: message.turnStartCreatedAt ?? message.createdAt,
      },
    })
    const failure = await handleFailure(result, 'settings-sync')
    if (failure !== null)
    {
      return failure
    }
    const current = await readReadyThread()
    if (current.kind === 'outcome')
    {
      return current.outcome
    }
    currentThread = current.thread
    settings = resolveQueuedThreadSettings(message, currentThread, threadHasStarted(currentThread))
  }

  const currentCollaborationMode = normalizeCollaborationMode(
    currentThread.interactionMode,
    currentThread.orchestrate,
  )
  if (
    settings.interactionMode !== currentCollaborationMode.baseMode ||
    settings.orchestrate !== currentCollaborationMode.orchestrate
  )
  {
    const wireInteractionMode = toWireInteractionMode(
      normalizeCollaborationMode(settings.interactionMode, settings.orchestrate),
    )
    const result = await commands.setThreadInteractionMode({
      environmentId: message.environmentId,
      input: {
        commandId: settingsCommandId(message, 'interaction-mode'),
        threadId: message.threadId,
        ...wireInteractionMode,
        createdAt: message.turnStartCreatedAt ?? message.createdAt,
      },
    })
    const failure = await handleFailure(result, 'settings-sync')
    if (failure !== null)
    {
      return failure
    }
    const current = await readReadyThread()
    if (current.kind === 'outcome')
    {
      return current.outcome
    }
  }

  const dispatchMessage = { ...message, turnStartCreatedAt: input.now() }
  try
  {
    if (!(await input.update(dispatchMessage)))
    {
      return COMPLETE
    }
  }
  catch (error)
  {
    return persistDeliveryUpdateFailure({
      message,
      attempt: (message.deliveryAttemptCount ?? 0) + 1,
      error,
      update: input.update,
      warn: input.warn,
    })
  }

  const dispatchState = await resolveExistingThreadState({
    message: dispatchMessage,
    state: input.readState(),
    update: input.update,
    remove: input.remove,
    warn: input.warn,
  })
  if (dispatchState.kind === 'outcome')
  {
    return dispatchState.outcome
  }
  const finalThread = dispatchState.thread
  const finalSettings = resolveQueuedThreadSettings(
    dispatchMessage,
    finalThread,
    threadHasStarted(finalThread),
  )
  const wireInteractionMode = toWireInteractionMode(
    normalizeCollaborationMode(finalSettings.interactionMode, finalSettings.orchestrate),
  )
  const result = await commands.startTurn({
    environmentId: message.environmentId,
    input: {
      commandId: dispatchMessage.commandId,
      threadId: dispatchMessage.threadId,
      message: {
        messageId: dispatchMessage.messageId,
        role: 'user',
        text: dispatchMessage.text,
        attachments: toUploadChatImageAttachments(dispatchMessage.attachments),
      },
      ...(threadHasStarted(finalThread) ? {} : { modelSelection: finalSettings.modelSelection }),
      runtimeMode: finalSettings.runtimeMode,
      ...((dispatchMessage.runtimeModeAcknowledgements?.length ?? 0) > 0
        ? { runtimeModeAcknowledgements: dispatchMessage.runtimeModeAcknowledgements }
        : {}),
      ...wireInteractionMode,
      createdAt: dispatchMessage.turnStartCreatedAt,
    },
  })
  const failure = await handleCommandFailure({
    message: dispatchMessage,
    result,
    stage: 'start-turn',
    update: input.update,
    warn: input.warn,
  })
  return failure ?? removeQueuedMessage(dispatchMessage, input.remove, input.warn)
}

export async function drainExistingQueuedThreadMessage(
  input: ExistingThreadOutboxDeliveryInput,
): Promise<ThreadOutboxDrainOutcome>
{
  const warn = input.warn ?? console.warn
  const initialAction = deliveryAction(input.initialState)
  if (initialAction === 'wait')
  {
    return WAIT
  }
  if (!(await input.confirmQueued(input.message)))
  {
    return COMPLETE
  }

  const message = input.message
  const current = await resolveExistingThreadState({
    message,
    state: input.readState(),
    update: input.update,
    remove: input.remove,
    warn,
  })
  if (current.kind === 'outcome')
  {
    return current.outcome
  }

  return sendQueuedMessage({
    message,
    thread: current.thread,
    readState: input.readState,
    now: input.now,
    commands: input,
    update: input.update,
    remove: input.remove,
    warn,
  })
}

export async function drainQueuedThreadCreation(input: {
  readonly message: QueuedThreadMessage
  readonly initialState: ExistingThreadOutboxState
  readonly confirmQueued: (message: QueuedThreadMessage) => Promise<boolean>
  readonly readState: () => ExistingThreadOutboxState
  readonly send?: () => Promise<AtomCommandResult<unknown, unknown>>
  readonly sendUnavailableReason?: string
  readonly update: (message: QueuedThreadMessage) => Promise<boolean>
  readonly remove: (message: QueuedThreadMessage) => Promise<void>
  readonly warn?: (message: string, detail: unknown) => void
}): Promise<ThreadOutboxDrainOutcome>
{
  const warn = input.warn ?? console.warn
  const actionForState = (state: ExistingThreadOutboxState) =>
    resolveThreadOutboxDeliveryAction({
      isCreation: true,
      threadExists: state.thread !== undefined,
      shellStatus: state.shellStatus,
      environmentConnected: state.environmentConnected,
      threadBusy:
        state.thread?.session?.status === 'running' || state.thread?.session?.status === 'starting',
      providerSwitchActive: state.thread !== undefined && state.thread.providerSwitch !== null,
    })

  if (actionForState(input.initialState) === 'wait')
  {
    return WAIT
  }
  if (!(await input.confirmQueued(input.message)))
  {
    return COMPLETE
  }

  const currentAction = actionForState(input.readState())
  if (currentAction === 'wait')
  {
    return WAIT
  }
  if (currentAction === 'remove')
  {
    return removeQueuedMessage(input.message, input.remove, warn)
  }
  if (currentAction === 'fail')
  {
    return persistQueuedThreadFailure({
      message: input.message,
      reason: 'The queued thread could not be created.',
      update: input.update,
      warn,
    })
  }

  if (input.send === undefined)
  {
    return persistQueuedThreadFailure({
      message: input.message,
      reason: input.sendUnavailableReason ?? 'The queued thread could not be created.',
      update: input.update,
      warn,
    })
  }

  const result = await input.send()
  return completeQueuedThreadCreation({
    message: input.message,
    result,
    update: input.update,
    remove: input.remove,
    warn,
  })
}

async function completeQueuedThreadCreation(input: {
  readonly message: QueuedThreadMessage
  readonly result: AtomCommandResult<unknown, unknown>
  readonly update: (message: QueuedThreadMessage) => Promise<boolean>
  readonly remove: (message: QueuedThreadMessage) => Promise<void>
  readonly warn?: (message: string, detail: unknown) => void
}): Promise<ThreadOutboxDrainOutcome>
{
  const warn = input.warn ?? console.warn
  const failure = await handleCommandFailure({
    message: input.message,
    result: input.result,
    stage: 'start-turn',
    update: input.update,
    warn,
  })
  return failure ?? removeQueuedMessage(input.message, input.remove, warn)
}
