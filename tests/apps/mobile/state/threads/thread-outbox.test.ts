// tests/apps/mobile/state/threads/thread-outbox.test.ts
// verifies durable queued-message persistence and delivery decisions

import { describe, expect, it } from '@effect/vitest'
import type {
  SetThreadInteractionModeInput,
  StartThreadTurnInput,
} from '@t3tools/client-runtime/operations'
import type { EnvironmentThreadShell } from '@t3tools/client-runtime/state/shell'
import {
  CommandId,
  EnvironmentId,
  MessageId,
  OrchestrationDispatchCommandError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
} from '@t3tools/contracts'
import * as Cause from 'effect/Cause'
import { AsyncResult, AtomRegistry } from 'effect/unstable/reactivity'
import { vi } from 'vite-plus/test'

import type { DraftComposerImageAttachment } from '../../../../../apps/mobile/src/lib/composerImages'

// keep this state-level suite independent of Expo's native module loader.
vi.mock('../../../../../apps/mobile/src/lib/composerImages', () => ({
  toUploadChatImageAttachments: (attachments: ReadonlyArray<DraftComposerImageAttachment>) =>
    attachments.map((attachment) => ({
      type: attachment.type,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      dataUrl: attachment.dataUrl,
    })),
}))

import {
  decodeQueuedThreadMessage,
  encodeQueuedThreadMessage,
  groupQueuedThreadMessages,
  isQueuedThreadCreationSendable,
  modelSelectionsEqual,
  requiresWebImportContinuation,
  resolveThreadOutboxDeliveryAction,
  resolveThreadOutboxFailureAction,
  resolveQueuedThreadSettings,
  shouldRetryThreadOutboxDelivery,
  threadOutboxRetryDelayMs,
  type QueuedThreadMessage,
} from '../../../../../apps/mobile/src/state/threads/thread-outbox-model'
import {
  createThreadOutboxManager,
  ThreadOutboxManagerError,
} from '../../../../../apps/mobile/src/state/threads/thread-outbox-manager'
import type { ThreadOutboxStorage } from '../../../../../apps/mobile/src/state/threads/thread-outbox-storage'
import {
  drainExistingQueuedThreadMessage,
  drainQueuedThreadCreation,
  type ExistingThreadOutboxState,
} from '../../../../../apps/mobile/src/state/threads/thread-outbox-delivery'
import { threadDetailToShell } from '../../../../../apps/mobile/src/state/threads/thread-shell-fallback'

function queuedMessage(input: {
  readonly environmentId?: string
  readonly threadId?: string
  readonly messageId: string
  readonly createdAt: string
}): QueuedThreadMessage
{
  return {
    environmentId: EnvironmentId.make(input.environmentId ?? 'environment-1'),
    threadId: ThreadId.make(input.threadId ?? 'thread-1'),
    messageId: MessageId.make(input.messageId),
    commandId: CommandId.make(`command-${input.messageId}`),
    text: input.messageId,
    attachments: [],
    createdAt: input.createdAt,
  }
}

function threadShell(
  input: {
    readonly modelInstanceId?: string
    readonly model?: string
    readonly providerSwitch?: EnvironmentThreadShell['providerSwitch']
    readonly started?: boolean
  } = {},
): EnvironmentThreadShell
{
  return {
    environmentId: EnvironmentId.make('environment-1'),
    id: ThreadId.make('thread-1'),
    projectId: ProjectId.make('project-1'),
    title: 'Thread',
    modelSelection: {
      instanceId: ProviderInstanceId.make(input.modelInstanceId ?? 'provider-current'),
      model: input.model ?? 'gpt-current',
    },
    runtimeMode: 'full-access',
    interactionMode: 'default',
    branch: null,
    worktreePath: null,
    latestTurn: input.started
      ? {
          turnId: TurnId.make('turn-1'),
          state: 'completed',
          requestedAt: '2026-08-02T10:00:00.000Z',
          startedAt: '2026-08-02T10:00:01.000Z',
          completedAt: '2026-08-02T10:00:02.000Z',
          assistantMessageId: null,
        }
      : null,
    providerSwitch: input.providerSwitch ?? null,
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-02T10:00:02.000Z',
    archivedAt: null,
    origin: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    session: null,
    latestUserMessageAt: input.started ? '2026-08-02T10:00:00.000Z' : null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  }
}

describe('thread outbox', () =>
{
  it('groups messages by scoped thread and preserves creation order', () =>
  {
    const later = queuedMessage({
      messageId: 'message-2',
      createdAt: '2026-06-08T10:00:02.000Z',
    })
    const earlier = queuedMessage({
      messageId: 'message-1',
      createdAt: '2026-06-08T10:00:01.000Z',
    })

    expect(groupQueuedThreadMessages([later, earlier])).toEqual({
      'environment-1:thread-1': [earlier, later],
    })
  })

  it('decodes the persisted schema and rejects incomplete messages', () =>
  {
    const message = queuedMessage({
      messageId: 'message-1',
      createdAt: '2026-06-08T10:00:01.000Z',
    })

    expect(
      decodeQueuedThreadMessage({
        schemaVersion: 1,
        ...message,
      }),
    ).toEqual(message)
    expect(() =>
      decodeQueuedThreadMessage({
        schemaVersion: 1,
        environmentId: 'environment-1',
      }),
    ).toThrow()
  })

  it('persists the exact selector snapshot while remaining compatible with v1 messages', () =>
  {
    const legacyMessage = queuedMessage({
      messageId: 'message-1',
      createdAt: '2026-06-08T10:00:01.000Z',
    })
    const selectedMessage = {
      ...legacyMessage,
      modelSelection: {
        instanceId: ProviderInstanceId.make('codex'),
        model: 'gpt-5.4',
        options: [{ id: 'reasoningEffort', value: 'xhigh' }],
      },
      runtimeMode: 'approval-required',
      runtimeModeAcknowledgements: ['antigravity-full-access-v1'],
      interactionMode: 'plan',
      orchestrate: true,
    } satisfies QueuedThreadMessage

    expect(decodeQueuedThreadMessage(encodeQueuedThreadMessage(selectedMessage))).toEqual(
      selectedMessage,
    )
    expect(
      resolveQueuedThreadSettings(
        legacyMessage,
        {
          modelSelection: selectedMessage.modelSelection,
          runtimeMode: selectedMessage.runtimeMode,
          interactionMode: selectedMessage.interactionMode,
          orchestrate: selectedMessage.orchestrate,
        },
        false,
      ),
    ).toEqual({
      modelSelection: selectedMessage.modelSelection,
      runtimeMode: selectedMessage.runtimeMode,
      interactionMode: selectedMessage.interactionMode,
      orchestrate: selectedMessage.orchestrate,
    })

    expect(
      decodeQueuedThreadMessage({
        schemaVersion: 1,
        ...legacyMessage,
        interactionMode: 'orchestrate',
      }),
    ).toMatchObject({ interactionMode: 'default', orchestrate: true })
  })

  it('round-trips persisted delivery state while decoding schema versions one through five', () =>
  {
    const message = {
      ...queuedMessage({
        messageId: 'message-1',
        createdAt: '2026-06-08T10:00:01.000Z',
      }),
      deliveryAttemptCount: 2,
      settingsSyncAttemptCount: 1,
      turnStartCreatedAt: '2026-08-02T12:00:00.000Z',
    } satisfies QueuedThreadMessage

    expect(decodeQueuedThreadMessage(encodeQueuedThreadMessage(message))).toEqual(message)
    for (const schemaVersion of [1, 2, 3, 4, 5])
    {
      expect(
        decodeQueuedThreadMessage({
          schemaVersion,
          ...queuedMessage({
            messageId: `legacy-${schemaVersion}`,
            createdAt: '2026-06-08T10:00:01.000Z',
          }),
        }),
      ).toMatchObject({ messageId: `legacy-${schemaVersion}` })
    }
  })

  it('adopts the started thread provider when draining across a provider switch', () =>
  {
    const message = {
      ...queuedMessage({
        messageId: 'message-1',
        createdAt: '2026-06-08T10:00:01.000Z',
      }),
      modelSelection: {
        instanceId: ProviderInstanceId.make('provider-before-switch'),
        model: 'gpt-5.4',
      },
      runtimeMode: 'approval-required',
      interactionMode: 'plan',
    } satisfies QueuedThreadMessage
    const currentModelSelection = {
      instanceId: ProviderInstanceId.make('provider-after-switch'),
      model: 'gpt-5.5',
    } as const

    const settings = resolveQueuedThreadSettings(
      message,
      {
        modelSelection: currentModelSelection,
        runtimeMode: 'full-access',
        interactionMode: 'default',
      },
      true,
    )

    expect(settings).toEqual({
      modelSelection: currentModelSelection,
      runtimeMode: message.runtimeMode,
      interactionMode: message.interactionMode,
      orchestrate: false,
    })
    expect(modelSelectionsEqual(settings.modelSelection, currentModelSelection)).toBe(true)
  })

  it('omits model selection for a started thread and persists a fresh turn timestamp', async () =>
  {
    const message = {
      ...queuedMessage({
        messageId: 'message-1',
        createdAt: '2026-06-08T10:00:01.000Z',
      }),
      modelSelection: {
        instanceId: ProviderInstanceId.make('provider-before-switch'),
        model: 'gpt-before-switch',
      },
      runtimeMode: 'full-access',
      interactionMode: 'default',
      orchestrate: true,
      turnStartCreatedAt: '2026-06-08T10:00:02.000Z',
    } satisfies QueuedThreadMessage
    const thread = threadShell({
      modelInstanceId: 'provider-after-switch',
      model: 'gpt-after-switch',
      started: true,
    })
    let persisted = message as QueuedThreadMessage
    const startInputs: Array<{
      readonly environmentId: EnvironmentId
      readonly input: StartThreadTurnInput
    }> = []
    const interactionInputs: Array<{
      readonly environmentId: EnvironmentId
      readonly input: SetThreadInteractionModeInput
    }> = []
    let metadataUpdateCount = 0
    let removeCount = 0

    const outcome = await drainExistingQueuedThreadMessage({
      message,
      initialState: { thread, shellStatus: 'live', environmentConnected: true },
      confirmQueued: async () => true,
      readState: () => ({ thread, shellStatus: 'live', environmentConnected: true }),
      update: async (updated) =>
      {
        persisted = updated
        return true
      },
      remove: async () =>
      {
        removeCount += 1
      },
      now: () => '2026-08-02T12:00:00.000Z',
      updateThreadMetadata: async () =>
      {
        metadataUpdateCount += 1
        return AsyncResult.success({ sequence: 1 })
      },
      setThreadRuntimeMode: async () => AsyncResult.success({ sequence: 1 }),
      setThreadInteractionMode: async (input) =>
      {
        interactionInputs.push(input)
        return AsyncResult.success({ sequence: 1 })
      },
      startTurn: async (input) =>
      {
        startInputs.push(input)
        return AsyncResult.success({ sequence: 1 })
      },
    })

    expect(outcome).toEqual({ kind: 'complete' })
    expect(metadataUpdateCount).toBe(0)
    expect(removeCount).toBe(1)
    expect(persisted.turnStartCreatedAt).toBe('2026-08-02T12:00:00.000Z')
    expect(startInputs).toHaveLength(1)
    expect(interactionInputs).toHaveLength(1)
    expect(interactionInputs[0]?.input).toMatchObject({
      interactionMode: 'orchestrate',
      orchestrate: true,
    })
    expect(startInputs[0]?.input).toMatchObject({
      commandId: message.commandId,
      threadId: message.threadId,
      createdAt: '2026-08-02T12:00:00.000Z',
      message: {
        messageId: message.messageId,
        text: message.text,
      },
      interactionMode: 'orchestrate',
      orchestrate: true,
    })
    expect(startInputs[0]?.input).not.toHaveProperty('modelSelection')
  })

  it('rechecks live switch-free shell state after durable confirmation and timestamp storage', async () =>
  {
    const message = queuedMessage({
      messageId: 'message-1',
      createdAt: '2026-06-08T10:00:01.000Z',
    })
    const clearThread = threadShell()
    const switchingThread = threadShell({
      providerSwitch: {
        phase: 'compacting',
        targetInstanceId: ProviderInstanceId.make('provider-next'),
        targetModel: 'gpt-next',
        requestedAt: '2026-08-02T11:59:59.000Z',
      },
    })
    let state: ExistingThreadOutboxState = {
      thread: clearThread,
      shellStatus: 'live',
      environmentConnected: true,
    }
    let startCount = 0
    let updateCount = 0
    const commonCommands = {
      updateThreadMetadata: async () => AsyncResult.success({ sequence: 1 }),
      setThreadRuntimeMode: async () => AsyncResult.success({ sequence: 1 }),
      setThreadInteractionMode: async () => AsyncResult.success({ sequence: 1 }),
      startTurn: async () =>
      {
        startCount += 1
        return AsyncResult.success({ sequence: 1 })
      },
    }

    const duringConfirmation = await drainExistingQueuedThreadMessage({
      message,
      initialState: state,
      confirmQueued: async () =>
      {
        state = {
          thread: switchingThread,
          shellStatus: 'synchronizing',
          environmentConnected: true,
        }
        return true
      },
      readState: () => state,
      update: async () =>
      {
        updateCount += 1
        return true
      },
      remove: async () => undefined,
      now: () => '2026-08-02T12:00:00.000Z',
      ...commonCommands,
    })
    expect(duringConfirmation).toEqual({ kind: 'wait' })
    expect(startCount).toBe(0)
    expect(updateCount).toBe(0)

    state = {
      thread: clearThread,
      shellStatus: 'live',
      environmentConnected: true,
    }
    const duringTimestampWrite = await drainExistingQueuedThreadMessage({
      message,
      initialState: state,
      confirmQueued: async () => true,
      readState: () => state,
      update: async () =>
      {
        updateCount += 1
        state = {
          thread: switchingThread,
          shellStatus: 'live',
          environmentConnected: true,
        }
        return true
      },
      remove: async () => undefined,
      now: () => '2026-08-02T12:00:00.000Z',
      ...commonCommands,
    })
    expect(duringTimestampWrite).toEqual({ kind: 'wait' })
    expect(startCount).toBe(0)
    expect(updateCount).toBe(1)
  })

  it('retains and durably accounts for a rejected turn timestamp write', async () =>
  {
    const message = queuedMessage({
      messageId: 'message-1',
      createdAt: '2026-06-08T10:00:01.000Z',
    })
    let persisted = message
    const thread = threadShell()
    let updateCount = 0
    let startCount = 0

    const outcome = await drainExistingQueuedThreadMessage({
      message,
      initialState: { thread, shellStatus: 'live', environmentConnected: true },
      confirmQueued: async () => true,
      readState: () => ({ thread, shellStatus: 'live', environmentConnected: true }),
      update: async (updated) =>
      {
        updateCount += 1
        if (updateCount === 1)
        {
          throw new Error('timestamp write rejected')
        }
        persisted = updated
        return true
      },
      remove: async () => undefined,
      now: () => '2026-08-02T12:00:00.000Z',
      updateThreadMetadata: async () => AsyncResult.success({ sequence: 1 }),
      setThreadRuntimeMode: async () => AsyncResult.success({ sequence: 1 }),
      setThreadInteractionMode: async () => AsyncResult.success({ sequence: 1 }),
      startTurn: async () =>
      {
        startCount += 1
        return AsyncResult.success({ sequence: 1 })
      },
      warn: () => undefined,
    })

    expect(outcome).toEqual({ kind: 'retry', attempt: 1 })
    expect(updateCount).toBe(2)
    expect(startCount).toBe(0)
    expect(persisted.deliveryAttemptCount).toBe(1)
    expect(persisted.turnStartCreatedAt).toBeUndefined()
  })

  it('waits when creation synchronization begins during durable confirmation', async () =>
  {
    const message = {
      ...queuedMessage({
        messageId: 'message-1',
        createdAt: '2026-06-08T10:00:01.000Z',
      }),
      modelSelection: threadShell().modelSelection,
      creation: {
        projectId: ProjectId.make('project-1'),
        workspaceMode: 'local' as const,
        branch: null,
        worktreePath: null,
      },
    }
    let state: ExistingThreadOutboxState = {
      thread: undefined,
      shellStatus: 'live',
      environmentConnected: true,
    }
    let sendCount = 0

    const outcome = await drainQueuedThreadCreation({
      message,
      initialState: state,
      confirmQueued: async () =>
      {
        state = { ...state, shellStatus: 'synchronizing' }
        return true
      },
      readState: () => state,
      send: async () =>
      {
        sendCount += 1
        return AsyncResult.success({ sequence: 1 })
      },
      update: async () => true,
      remove: async () => undefined,
    })

    expect(outcome).toEqual({ kind: 'wait' })
    expect(sendCount).toBe(0)
  })

  it('rechecks provider switch state after each accepted settings command', async () =>
  {
    const message = {
      ...queuedMessage({
        messageId: 'message-1',
        createdAt: '2026-06-08T10:00:01.000Z',
      }),
      modelSelection: {
        instanceId: ProviderInstanceId.make('provider-current'),
        model: 'gpt-queued',
      },
      runtimeMode: 'approval-required' as const,
      interactionMode: 'plan' as const,
    }
    const thread = threadShell({ started: true })
    const switchingThread = threadShell({
      started: true,
      providerSwitch: {
        phase: 'compacting',
        targetInstanceId: ProviderInstanceId.make('provider-next'),
        targetModel: 'gpt-next',
        requestedAt: '2026-08-02T11:59:59.000Z',
      },
    })
    let state: ExistingThreadOutboxState = {
      thread,
      shellStatus: 'live',
      environmentConnected: true,
    }
    let runtimeCount = 0
    let interactionCount = 0
    let startCount = 0

    const outcome = await drainExistingQueuedThreadMessage({
      message,
      initialState: state,
      confirmQueued: async () => true,
      readState: () => state,
      update: async () => true,
      remove: async () => undefined,
      now: () => '2026-08-02T12:00:00.000Z',
      updateThreadMetadata: async () =>
      {
        state = {
          thread: switchingThread,
          shellStatus: 'synchronizing',
          environmentConnected: true,
        }
        return AsyncResult.success({ sequence: 1 })
      },
      setThreadRuntimeMode: async () =>
      {
        runtimeCount += 1
        return AsyncResult.success({ sequence: 1 })
      },
      setThreadInteractionMode: async () =>
      {
        interactionCount += 1
        return AsyncResult.success({ sequence: 1 })
      },
      startTurn: async () =>
      {
        startCount += 1
        return AsyncResult.success({ sequence: 1 })
      },
    })

    expect(outcome).toEqual({ kind: 'wait' })
    expect(runtimeCount).toBe(0)
    expect(interactionCount).toBe(0)
    expect(startCount).toBe(0)
  })

  it('persists a fresh command id after a switch rejection and sends on retry', async () =>
  {
    const message = queuedMessage({
      messageId: 'message-1',
      createdAt: '2026-06-08T10:00:01.000Z',
    })
    let persisted = message
    const thread = threadShell()
    let removeCount = 0
    const commandIds: CommandId[] = []
    const switchError = new OrchestrationDispatchCommandError({
      message: 'Provider switch is in progress',
      code: 'turn-start-during-switch',
    })
    let startAttempt = 0
    const drain = () =>
      drainExistingQueuedThreadMessage({
        message: persisted,
        initialState: { thread, shellStatus: 'live', environmentConnected: true },
        confirmQueued: async () => true,
        readState: () => ({ thread, shellStatus: 'live', environmentConnected: true }),
        update: async (updated) =>
        {
          persisted = updated
          return true
        },
        remove: async () =>
        {
          removeCount += 1
        },
        now: () => `2026-08-02T12:00:0${startAttempt}.000Z`,
        updateThreadMetadata: async () => AsyncResult.success({ sequence: 1 }),
        setThreadRuntimeMode: async () => AsyncResult.success({ sequence: 1 }),
        setThreadInteractionMode: async () => AsyncResult.success({ sequence: 1 }),
        startTurn: async ({ input }) =>
        {
          commandIds.push(input.commandId ?? CommandId.make('missing'))
          startAttempt += 1
          return startAttempt === 1
            ? AsyncResult.failure(Cause.fail(switchError))
            : AsyncResult.success({ sequence: 2 })
        },
        warn: () => undefined,
      })

    await expect(drain()).resolves.toEqual({ kind: 'wait' })
    expect(removeCount).toBe(0)
    expect(persisted.commandId).not.toBe(message.commandId)
    persisted = decodeQueuedThreadMessage(encodeQueuedThreadMessage(persisted))

    await expect(drain()).resolves.toEqual({ kind: 'complete' })
    expect(removeCount).toBe(1)
    expect(commandIds).toEqual([message.commandId, persisted.commandId])
    expect(persisted.failure).toBeUndefined()
  })

  it('rotates after restart when the original switch rejection receipt is replayed', async () =>
  {
    const message = queuedMessage({
      messageId: 'message-switch-restart',
      createdAt: '2026-06-08T10:00:01.000Z',
    })
    let persisted = message
    let allowRotationWrite = false
    let removeCount = 0
    let startAttempt = 0
    const commandIds: CommandId[] = []
    const switchError = new OrchestrationDispatchCommandError({
      message: 'Provider switch is in progress',
      code: 'turn-start-during-switch',
    })
    const thread = threadShell()
    const drain = () =>
      drainExistingQueuedThreadMessage({
        message: persisted,
        initialState: { thread, shellStatus: 'live', environmentConnected: true },
        confirmQueued: async () => true,
        readState: () => ({ thread, shellStatus: 'live', environmentConnected: true }),
        update: async (updated) =>
        {
          if (updated.commandId !== message.commandId && !allowRotationWrite)
          {
            throw new Error('simulated storage outage during command id rotation')
          }
          persisted = updated
          return true
        },
        remove: async () =>
        {
          removeCount += 1
        },
        now: () => `2026-08-02T12:00:0${startAttempt}.000Z`,
        updateThreadMetadata: async () => AsyncResult.success({ sequence: 1 }),
        setThreadRuntimeMode: async () => AsyncResult.success({ sequence: 1 }),
        setThreadInteractionMode: async () => AsyncResult.success({ sequence: 1 }),
        startTurn: async ({ input }) =>
        {
          commandIds.push(input.commandId ?? CommandId.make('missing'))
          startAttempt += 1
          return startAttempt <= 2
            ? AsyncResult.failure(Cause.fail(switchError))
            : AsyncResult.success({ sequence: 2 })
        },
        warn: () => undefined,
      })

    await expect(drain()).resolves.toEqual({ kind: 'retry', attempt: 1 })
    expect(persisted.commandId).toBe(message.commandId)

    persisted = decodeQueuedThreadMessage(encodeQueuedThreadMessage(persisted))
    allowRotationWrite = true
    await expect(drain()).resolves.toEqual({ kind: 'wait' })
    expect(persisted.commandId).not.toBe(message.commandId)

    persisted = decodeQueuedThreadMessage(encodeQueuedThreadMessage(persisted))
    await expect(drain()).resolves.toEqual({ kind: 'complete' })
    expect(removeCount).toBe(1)
    expect(commandIds).toEqual([message.commandId, message.commandId, persisted.commandId])
  })

  it('compares model options as part of the queued settings change', () =>
  {
    const base = {
      instanceId: ProviderInstanceId.make('codex'),
      model: 'gpt-5.4',
      options: [{ id: 'reasoningEffort', value: 'medium' }],
    } as const

    expect(modelSelectionsEqual(base, base)).toBe(true)
    expect(
      modelSelectionsEqual(base, {
        ...base,
        options: [{ id: 'reasoningEffort', value: 'xhigh' }],
      }),
    ).toBe(false)
  })

  it('holds imported first-turn messages until web continuation consent completes', () =>
  {
    const importedOrigin = {
      kind: 'imported' as const,
      source: 'codex-cli' as const,
      sourcePath: '/tmp/imported.jsonl',
      contentHash: 'content-hash',
      nativeSessionId: 'native-session',
      providerInstanceId: ProviderInstanceId.make('codex'),
      importedAt: '2026-07-26T00:00:00.000Z',
    }

    expect(
      requiresWebImportContinuation({
        origin: importedOrigin,
        latestTurn: null,
      }),
    ).toBe(true)
    expect(
      requiresWebImportContinuation({
        origin: importedOrigin,
        latestTurn: {
          turnId: TurnId.make('turn-1'),
          state: 'completed',
          requestedAt: '2026-07-26T00:00:01.000Z',
          startedAt: '2026-07-26T00:00:02.000Z',
          completedAt: '2026-07-26T00:00:03.000Z',
          assistantMessageId: null,
        },
      }),
    ).toBe(false)
    expect(
      requiresWebImportContinuation({
        origin: null,
        latestTurn: null,
      }),
    ).toBe(false)
  })

  it('backs off queued delivery retries and caps them at sixteen seconds', () =>
  {
    expect([1, 2, 3, 4, 5, 6].map(threadOutboxRetryDelayMs)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 16_000,
    ])
  })

  it('serializes mutations even when an earlier mutation is slower', async () =>
  {
    const registry = AtomRegistry.make()
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => [],
        write: async () => undefined,
        remove: async () => undefined,
      },
    })
    const order: string[] = []
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>((resolve) =>
    {
      releaseFirst = resolve
    })

    const first = manager.serialize(async () =>
    {
      order.push('first:start')
      await firstBlocked
      order.push('first:end')
    })
    const second = manager.serialize(async () =>
    {
      order.push('second')
    })

    await Promise.resolve()
    expect(order).toEqual(['first:start'])
    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(['first:start', 'first:end', 'second'])
    registry.dispose()
  })

  it('holds the mutation queue while persisted messages are loading', async () =>
  {
    const registry = AtomRegistry.make()
    const message = queuedMessage({
      messageId: 'message-1',
      createdAt: '2026-06-08T10:00:01.000Z',
    })
    const stored = new Map([[message.messageId, message]])
    let loadCalls = 0
    let removeCalls = 0
    let releaseInitialLoad!: () => void
    const initialLoadBlocked = new Promise<void>((resolve) =>
    {
      releaseInitialLoad = resolve
    })
    const storage: ThreadOutboxStorage = {
      load: async () =>
      {
        loadCalls += 1
        if (loadCalls === 1)
        {
          await initialLoadBlocked
        }
        return [...stored.values()]
      },
      write: async () => undefined,
      remove: async (candidate) =>
      {
        removeCalls += 1
        stored.delete(candidate.messageId)
      },
    }
    const manager = createThreadOutboxManager({ registry, storage })

    const loading = manager.load()
    await Promise.resolve()
    const clearing = manager.clearEnvironment(message.environmentId)
    await Promise.resolve()
    await Promise.resolve()

    expect(loadCalls).toBe(1)
    expect(removeCalls).toBe(0)

    releaseInitialLoad()
    await Promise.all([loading, clearing])
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({})
    registry.dispose()
  })

  it('reports structured load failures and permits a retry', async () =>
  {
    const registry = AtomRegistry.make()
    const loadCause = new Error('storage unavailable')
    const warnings: Array<{ message: string; error: unknown }> = []
    let loadCalls = 0
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () =>
        {
          loadCalls += 1
          if (loadCalls === 1) throw loadCause
          return []
        },
        write: async () => undefined,
        remove: async () => undefined,
      },
      warn: (message, error) => warnings.push({ message, error }),
    })

    await manager.load()
    expect(warnings).toEqual([
      {
        message: '[thread-outbox] failed to load persisted messages',
        error: new ThreadOutboxManagerError({
          operation: 'load',
          environmentId: null,
          threadId: null,
          messageId: null,
          cause: loadCause,
        }),
      },
    ])

    await manager.load()
    expect(loadCalls).toBe(2)
    registry.dispose()
  })

  it('automatically retries the initial outbox load with bounded backoff', async () =>
  {
    vi.useFakeTimers()
    const registry = AtomRegistry.make()
    let loadCalls = 0
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () =>
        {
          loadCalls += 1
          if (loadCalls === 1)
          {
            throw new Error('storage unavailable')
          }
          return []
        },
        write: async () => undefined,
        remove: async () => undefined,
      },
      warn: () => undefined,
    })

    try
    {
      await manager.load()
      expect(loadCalls).toBe(1)
      await vi.advanceTimersByTimeAsync(999)
      expect(loadCalls).toBe(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(loadCalls).toBe(2)
    }
    finally
    {
      registry.dispose()
      vi.useRealTimers()
    }
  })

  it('reports environment cleanup incomplete when persisted loading fails', async () =>
  {
    const registry = AtomRegistry.make()
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () =>
        {
          throw new Error('storage unavailable')
        },
        write: async () => undefined,
        remove: async () => undefined,
      },
      warn: () => undefined,
    })

    await expect(manager.clearEnvironment(EnvironmentId.make('environment-1'))).resolves.toEqual({
      complete: false,
      remainingMessageCount: 0,
    })
    registry.dispose()
  })

  it('keeps failed environment removals and completes only after none remain', async () =>
  {
    const registry = AtomRegistry.make()
    const first = queuedMessage({
      messageId: 'message-1',
      createdAt: '2026-06-08T10:00:01.000Z',
    })
    const second = queuedMessage({
      messageId: 'message-2',
      createdAt: '2026-06-08T10:00:02.000Z',
    })
    const retained = queuedMessage({
      environmentId: 'environment-10',
      messageId: 'message-1',
      createdAt: '2026-06-08T10:00:03.000Z',
    })
    const stored = new Map([
      [`${first.environmentId}:${first.messageId}`, first],
      [`${second.environmentId}:${second.messageId}`, second],
      [`${retained.environmentId}:${retained.messageId}`, retained],
    ])
    let failSecond = true
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => [...stored.values()],
        write: async () => undefined,
        remove: async (message) =>
        {
          if (message.messageId === second.messageId && failSecond)
          {
            throw new Error('remove failed')
          }
          stored.delete(`${message.environmentId}:${message.messageId}`)
        },
      },
      warn: () => undefined,
    })

    await expect(manager.clearEnvironment(first.environmentId)).resolves.toEqual({
      complete: false,
      remainingMessageCount: 1,
    })
    expect(stored.has(`${retained.environmentId}:${retained.messageId}`)).toBe(true)

    failSecond = false
    await expect(manager.clearEnvironment(first.environmentId)).resolves.toEqual({
      complete: true,
      remainingMessageCount: 0,
    })
    expect([...stored.values()]).toEqual([retained])
    registry.dispose()
  })

  it('keeps atom state aligned with durable writes and removals', async () =>
  {
    const registry = AtomRegistry.make()
    const stored = new Map<MessageId, QueuedThreadMessage>()
    const removalCause = new Error('remove failed')
    let failRemoval = true
    const storage: ThreadOutboxStorage = {
      load: async () => [...stored.values()],
      write: async (message) =>
      {
        stored.set(message.messageId, message)
      },
      remove: async (message) =>
      {
        if (failRemoval)
        {
          throw removalCause
        }
        stored.delete(message.messageId)
      },
    }
    const manager = createThreadOutboxManager({ registry, storage })
    const message = queuedMessage({
      messageId: 'message-1',
      createdAt: '2026-06-08T10:00:01.000Z',
    })

    await manager.enqueue(message)
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      'environment-1:thread-1': [message],
    })

    await expect(manager.remove(message)).rejects.toEqual(
      new ThreadOutboxManagerError({
        operation: 'remove',
        environmentId: message.environmentId,
        threadId: message.threadId,
        messageId: message.messageId,
        cause: removalCause,
      }),
    )
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      'environment-1:thread-1': [message],
    })

    failRemoval = false
    await manager.remove(message)
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({})
    registry.dispose()
  })

  it('publishes an enqueued message before the durable write resolves', async () =>
  {
    const registry = AtomRegistry.make()
    let releaseWrite!: () => void
    const writeBlocked = new Promise<void>((resolve) =>
    {
      releaseWrite = resolve
    })
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => [],
        write: async () => writeBlocked,
        remove: async () => undefined,
      },
    })
    const message = queuedMessage({
      messageId: 'message-1',
      createdAt: '2026-06-08T10:00:01.000Z',
    })

    const enqueueing = manager.enqueue(message)
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      'environment-1:thread-1': [message],
    })

    releaseWrite()
    await enqueueing
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      'environment-1:thread-1': [message],
    })
    registry.dispose()
  })

  it('rolls an enqueued message back out when the durable write fails', async () =>
  {
    const registry = AtomRegistry.make()
    const writeCause = new Error('disk full')
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => [],
        write: async () =>
        {
          throw writeCause
        },
        remove: async () => undefined,
      },
    })
    const message = queuedMessage({
      messageId: 'message-1',
      createdAt: '2026-06-08T10:00:01.000Z',
    })

    await expect(manager.enqueue(message)).rejects.toEqual(
      new ThreadOutboxManagerError({
        operation: 'enqueue',
        environmentId: message.environmentId,
        threadId: message.threadId,
        messageId: message.messageId,
        cause: writeCause,
      }),
    )
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({})
    registry.dispose()
  })

  it("keeps a same-id retry queued when the first attempt's write fails", async () =>
  {
    const registry = AtomRegistry.make()
    let failNextWrite = true
    let releaseFirstWrite!: () => void
    const firstWriteBlocked = new Promise<void>((resolve) =>
    {
      releaseFirstWrite = resolve
    })
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => [],
        write: async () =>
        {
          if (failNextWrite)
          {
            failNextWrite = false
            await firstWriteBlocked
            throw new Error('disk full')
          }
        },
        remove: async () => undefined,
      },
    })
    const message = queuedMessage({
      messageId: 'message-1',
      createdAt: '2026-06-08T10:00:01.000Z',
    })
    const retried = { ...message, text: 'retried' }

    const first = manager.enqueue(message)
    const second = manager.enqueue(retried)
    releaseFirstWrite()
    await expect(first).rejects.toBeInstanceOf(ThreadOutboxManagerError)
    await second

    // preserve the retry that replaced the failed first attempt
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      'environment-1:thread-1': [retried],
    })
    await expect(manager.confirmQueued(retried)).resolves.toBe(true)
    await expect(manager.confirmQueued(message)).resolves.toBe(false)
    registry.dispose()
  })

  it('replaces an existing message when an enqueue retry uses the same id', async () =>
  {
    const registry = AtomRegistry.make()
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => [],
        write: async () => undefined,
        remove: async () => undefined,
      },
    })
    const message = queuedMessage({
      messageId: 'message-1',
      createdAt: '2026-06-08T10:00:01.000Z',
    })
    const retried = { ...message, text: 'retried' }

    await manager.enqueue(message)
    await manager.enqueue(retried)

    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      'environment-1:thread-1': [retried],
    })
    registry.dispose()
  })

  it('updates a queued message in place but never resurrects a removed one', async () =>
  {
    const registry = AtomRegistry.make()
    const stored = new Map<MessageId, QueuedThreadMessage>()
    const storage: ThreadOutboxStorage = {
      load: async () => [...stored.values()],
      write: async (message) =>
      {
        stored.set(message.messageId, message)
      },
      remove: async (message) =>
      {
        stored.delete(message.messageId)
      },
    }
    const manager = createThreadOutboxManager({ registry, storage })
    const message = queuedMessage({
      messageId: 'message-1',
      createdAt: '2026-06-08T10:00:01.000Z',
    })

    await manager.enqueue(message)
    const edited = { ...message, text: 'edited' }
    await expect(manager.update(edited)).resolves.toBe(true)
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      'environment-1:thread-1': [edited],
    })
    expect(stored.get(message.messageId)).toEqual(edited)

    await manager.remove(edited)
    await expect(manager.update({ ...message, text: 'stale flush' })).resolves.toBe(false)
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({})
    expect(stored.size).toBe(0)
    registry.dispose()
  })

  it('only fails a missing-thread message after shell synchronization is live', () =>
  {
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: false,
        threadExists: false,
        shellStatus: 'synchronizing',
        environmentConnected: true,
        threadBusy: false,
        providerSwitchActive: false,
      }),
    ).toBe('wait')
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: false,
        threadExists: false,
        shellStatus: 'live',
        environmentConnected: true,
        threadBusy: false,
        providerSwitchActive: false,
      }),
    ).toBe('fail')
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: false,
        threadExists: true,
        shellStatus: 'live',
        environmentConnected: true,
        threadBusy: false,
        providerSwitchActive: false,
      }),
    ).toBe('send')
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: false,
        threadExists: true,
        shellStatus: 'live',
        environmentConnected: true,
        threadBusy: false,
        providerSwitchActive: true,
      }),
    ).toBe('wait')
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: false,
        threadExists: true,
        shellStatus: 'cached',
        environmentConnected: true,
        threadBusy: false,
        providerSwitchActive: false,
      }),
    ).toBe('wait')
  })

  it('sends queued creations once connected and live, removing already-created ones', () =>
  {
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: true,
        threadExists: false,
        shellStatus: 'cached',
        environmentConnected: false,
        threadBusy: false,
        providerSwitchActive: false,
      }),
    ).toBe('wait')
    // connected but not yet synchronized: a previously delivered creation may
    // simply not be visible yet — sending now could duplicate the thread.
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: true,
        threadExists: false,
        shellStatus: 'synchronizing',
        environmentConnected: true,
        threadBusy: false,
        providerSwitchActive: false,
      }),
    ).toBe('wait')
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: true,
        threadExists: false,
        shellStatus: 'live',
        environmentConnected: true,
        threadBusy: false,
        providerSwitchActive: false,
      }),
    ).toBe('send')
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: true,
        threadExists: true,
        shellStatus: 'live',
        environmentConnected: true,
        threadBusy: true,
        providerSwitchActive: false,
      }),
    ).toBe('remove')
  })

  it('round-trips queued creations and gates incomplete ones from sending', () =>
  {
    const base = queuedMessage({
      messageId: 'message-1',
      createdAt: '2026-06-08T10:00:01.000Z',
    })
    const creationMessage = {
      ...base,
      modelSelection: {
        instanceId: ProviderInstanceId.make('codex'),
        model: 'gpt-5.4',
      },
      creation: {
        projectId: ProjectId.make('project-1'),
        workspaceMode: 'worktree',
        branch: 'main',
        worktreePath: null,
        startFromOrigin: true,
      },
    } satisfies QueuedThreadMessage

    expect(decodeQueuedThreadMessage(encodeQueuedThreadMessage(creationMessage))).toEqual(
      creationMessage,
    )
    expect(isQueuedThreadCreationSendable(creationMessage)).toBe(true)
    expect(
      isQueuedThreadCreationSendable({
        ...creationMessage,
        creation: { ...creationMessage.creation, branch: null },
      }),
    ).toBe(false)
    expect(
      isQueuedThreadCreationSendable({
        ...creationMessage,
        creation: { ...creationMessage.creation, branch: '' },
      }),
    ).toBe(false)
    expect(isQueuedThreadCreationSendable({ ...creationMessage, modelSelection: undefined })).toBe(
      false,
    )
    expect(isQueuedThreadCreationSendable(base)).toBe(false)
  })

  it('retries transport failures but drops deterministic command failures', () =>
  {
    expect(shouldRetryThreadOutboxDelivery(new Error('Socket is not connected'))).toBe(true)
    expect(
      shouldRetryThreadOutboxDelivery({
        _tag: 'ConnectionTransientError',
        message: 'temporarily unavailable',
      }),
    ).toBe(true)
    expect(shouldRetryThreadOutboxDelivery(new Error('Thread no longer exists'))).toBe(false)
  })

  it('bounds settings synchronization retries before retaining a failed queued message', () =>
  {
    const deterministicFailure = new Error('Thread no longer exists')

    expect(
      resolveThreadOutboxFailureAction({
        stage: 'settings-sync',
        error: deterministicFailure,
        interrupted: false,
        attempt: 1,
      }),
    ).toBe('retry')
    expect(
      resolveThreadOutboxFailureAction({
        stage: 'settings-sync',
        error: deterministicFailure,
        interrupted: false,
        attempt: 3,
      }),
    ).toBe('fail')
    expect(
      resolveThreadOutboxFailureAction({
        stage: 'start-turn',
        error: deterministicFailure,
        interrupted: false,
        attempt: 1,
      }),
    ).toBe('fail')
    expect(
      resolveThreadOutboxFailureAction({
        stage: 'start-turn',
        error: new Error('Socket is not connected'),
        interrupted: false,
        attempt: 3,
      }),
    ).toBe('fail')
    expect(
      resolveThreadOutboxFailureAction({
        stage: 'start-turn',
        error: new Error('interrupted'),
        interrupted: true,
        attempt: 3,
      }),
    ).toBe('fail')
  })

  it('persists a deterministic turn rejection as a visible failed item', async () =>
  {
    let persisted = queuedMessage({
      messageId: 'message-1',
      createdAt: '2026-06-08T10:00:01.000Z',
    })
    const thread = threadShell()
    let removeCount = 0

    const outcome = await drainExistingQueuedThreadMessage({
      message: persisted,
      initialState: { thread, shellStatus: 'live', environmentConnected: true },
      confirmQueued: async () => true,
      readState: () => ({ thread, shellStatus: 'live', environmentConnected: true }),
      update: async (updated) =>
      {
        persisted = updated
        return true
      },
      remove: async () =>
      {
        removeCount += 1
      },
      now: () => '2026-08-02T12:00:00.000Z',
      updateThreadMetadata: async () => AsyncResult.success({ sequence: 1 }),
      setThreadRuntimeMode: async () => AsyncResult.success({ sequence: 1 }),
      setThreadInteractionMode: async () => AsyncResult.success({ sequence: 1 }),
      startTurn: async () => AsyncResult.failure(Cause.fail(new Error('Thread no longer exists'))),
      warn: () => undefined,
    })

    expect(outcome).toEqual({ kind: 'complete' })
    expect(removeCount).toBe(0)
    expect(persisted.deliveryAttemptCount).toBe(1)
    expect(persisted.failure?.reason).toBe('Thread no longer exists')
  })

  it('persists and bounds transport failures into the durable visible failure state', async () =>
  {
    let persisted: QueuedThreadMessage = queuedMessage({
      messageId: 'message-1',
      createdAt: '2026-06-08T10:00:01.000Z',
    })
    const thread = threadShell()
    let removeCount = 0
    const transientError = { _tag: 'ConnectionTransientError', message: 'offline' }

    for (let attempt = 1; attempt <= 3; attempt += 1)
    {
      const outcome = await drainExistingQueuedThreadMessage({
        message: persisted,
        initialState: { thread, shellStatus: 'live', environmentConnected: true },
        confirmQueued: async () => true,
        readState: () => ({ thread, shellStatus: 'live', environmentConnected: true }),
        update: async (updated) =>
        {
          persisted = updated
          return true
        },
        remove: async () =>
        {
          removeCount += 1
        },
        now: () => '2026-08-02T12:00:00.000Z',
        updateThreadMetadata: async () => AsyncResult.success({ sequence: 1 }),
        setThreadRuntimeMode: async () => AsyncResult.success({ sequence: 1 }),
        setThreadInteractionMode: async () => AsyncResult.success({ sequence: 1 }),
        startTurn: async () => AsyncResult.failure(Cause.fail(transientError)),
        warn: () => undefined,
      })

      expect(outcome).toEqual(attempt < 3 ? { kind: 'retry', attempt } : { kind: 'complete' })
      persisted = decodeQueuedThreadMessage(encodeQueuedThreadMessage(persisted))
    }

    expect(removeCount).toBe(0)
    expect(persisted.deliveryAttemptCount).toBe(3)
    expect(persisted.failure?.reason).toBe('offline')
  })

  it('persists settings attempts across restarts and stops before starting a turn', async () =>
  {
    let persisted: QueuedThreadMessage = {
      ...queuedMessage({
        messageId: 'message-1',
        createdAt: '2026-06-08T10:00:01.000Z',
      }),
      modelSelection: {
        instanceId: ProviderInstanceId.make('provider-current'),
        model: 'gpt-queued',
      },
    }
    const thread = threadShell({ started: true })
    let metadataUpdateCount = 0
    let startCount = 0

    for (let attempt = 1; attempt <= 3; attempt += 1)
    {
      const outcome = await drainExistingQueuedThreadMessage({
        message: persisted,
        initialState: { thread, shellStatus: 'live', environmentConnected: true },
        confirmQueued: async () => true,
        readState: () => ({ thread, shellStatus: 'live', environmentConnected: true }),
        update: async (updated) =>
        {
          persisted = updated
          return true
        },
        remove: async () => undefined,
        now: () => '2026-08-02T12:00:00.000Z',
        updateThreadMetadata: async () =>
        {
          metadataUpdateCount += 1
          return AsyncResult.failure(Cause.fail(new Error('settings rejected')))
        },
        setThreadRuntimeMode: async () => AsyncResult.success({ sequence: 1 }),
        setThreadInteractionMode: async () => AsyncResult.success({ sequence: 1 }),
        startTurn: async () =>
        {
          startCount += 1
          return AsyncResult.success({ sequence: 1 })
        },
        warn: () => undefined,
      })

      expect(outcome).toEqual(attempt < 3 ? { kind: 'retry', attempt } : { kind: 'complete' })
      persisted = decodeQueuedThreadMessage(encodeQueuedThreadMessage(persisted))
    }

    expect(metadataUpdateCount).toBe(3)
    expect(startCount).toBe(0)
    expect(persisted.settingsSyncAttemptCount).toBe(3)
    expect(persisted.failure?.reason).toBe('settings rejected')
  })

  it('preserves a background provider switch in the detail-to-shell fallback', () =>
  {
    const switchState = {
      phase: 'finalizing' as const,
      targetInstanceId: ProviderInstanceId.make('provider-next'),
      targetModel: 'gpt-next',
      requestedAt: '2026-08-02T12:00:00.000Z',
    }
    const { environmentId: _, ...shell } = threadShell({ providerSwitch: switchState })
    const detail = {
      ...shell,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      orchestratePlans: [],
      activities: [],
      checkpoints: [],
    } satisfies OrchestrationThread

    expect(threadDetailToShell(EnvironmentId.make('environment-1'), detail).providerSwitch).toEqual(
      switchState,
    )
  })
})
