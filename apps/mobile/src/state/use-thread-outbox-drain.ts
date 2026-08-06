// apps/mobile/src/state/use-thread-outbox-drain.ts
// drains durable queued messages when authoritative thread state permits

import { useAtomValue } from '@effect/atom-react'
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from '@t3tools/client-runtime/state/shell'
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type MessageId,
} from '@t3tools/contracts'
import { buildTemporaryWorktreeBranchName } from '@t3tools/shared/git'
import { Atom } from 'effect/unstable/reactivity'
import { useCallback, useEffect, useRef, useState } from 'react'

import { scopedThreadKey } from '../lib/scopedEntities'
import { buildProjectThreadStartTurnInput } from '../lib/projectThreadStartTurn'
import { randomHex } from '../lib/uuid'
import { appAtomRegistry } from './atom-registry'
import { useProjects, useThreadShells } from './entities'
import {
  confirmThreadOutboxMessageQueued,
  ensureThreadOutboxLoaded,
  removeThreadOutboxMessage,
  updateThreadOutboxMessage,
} from './thread-outbox'
import {
  isQueuedThreadCreationSendable,
  requiresWebImportContinuation,
  resolveThreadOutboxDeliveryAction,
  threadOutboxRetryDelayMs,
  type QueuedThreadCreation,
  type QueuedThreadMessage,
} from './thread-outbox-model'
import {
  drainExistingQueuedThreadMessage,
  drainQueuedThreadCreation,
  type ThreadOutboxDrainOutcome,
} from './thread-outbox-delivery'
import { environmentPresentations } from './presentation'
import { environmentShell } from './shell'
import { environmentThreadShells, threadEnvironment } from './threads'
import { useAtomCommand } from './use-atom-command'
import {
  editingQueuedMessageIdsAtom,
  useThreadOutboxMessages,
  useThreadOutboxShellStatuses,
} from './use-thread-outbox'
import { useRemoteConnectionStatus } from './use-remote-environment-registry'

export const dispatchingQueuedMessageIdAtom = Atom.make<MessageId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel('mobile:thread-outbox:dispatching-message-id'),
)

function beginDispatchingQueuedMessage(queuedMessageId: MessageId): void
{
  appAtomRegistry.set(dispatchingQueuedMessageIdAtom, queuedMessageId)
}

function finishDispatchingQueuedMessage(queuedMessageId: MessageId): void
{
  const current = appAtomRegistry.get(dispatchingQueuedMessageIdAtom)
  appAtomRegistry.set(dispatchingQueuedMessageIdAtom, current === queuedMessageId ? null : current)
}

function findThread(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  message: QueuedThreadMessage,
): EnvironmentThreadShell | undefined
{
  return threads.find(
    (candidate) =>
      candidate.environmentId === message.environmentId && candidate.id === message.threadId,
  )
}

function findCreationProject(
  projects: ReadonlyArray<EnvironmentProject>,
  message: QueuedThreadMessage,
): EnvironmentProject | undefined
{
  return projects.find(
    (candidate) =>
      candidate.environmentId === message.environmentId &&
      candidate.id === message.creation?.projectId,
  )
}

function isEnvironmentConnected(environmentId: QueuedThreadMessage['environmentId']): boolean
{
  return (
    appAtomRegistry.get(environmentPresentations.presentationsAtom).get(environmentId)?.connection
      .phase === 'connected'
  )
}

export function useThreadOutboxDrain(): void
{
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false })
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  })
  const setThreadRuntimeMode = useAtomCommand(threadEnvironment.setRuntimeMode, {
    reportFailure: false,
  })
  const setThreadInteractionMode = useAtomCommand(threadEnvironment.setInteractionMode, {
    reportFailure: false,
  })
  const dispatchingQueuedMessageId = useAtomValue(dispatchingQueuedMessageIdAtom)
  const editingQueuedMessageIds = useAtomValue(editingQueuedMessageIdsAtom)
  const queuedMessagesByThreadKey = useThreadOutboxMessages()
  const shellStatuses = useThreadOutboxShellStatuses()
  const threads = useThreadShells()
  const projects = useProjects()
  const { connectedEnvironments } = useRemoteConnectionStatus()
  const [retryTick, setRetryTick] = useState(0)
  const retryNotBeforeRef = useRef(new Map<MessageId, number>())
  const retryTimersRef = useRef(new Map<MessageId, ReturnType<typeof setTimeout>>())

  useEffect(() =>
  {
    ensureThreadOutboxLoaded()
    return () =>
    {
      for (const timer of retryTimersRef.current.values())
      {
        clearTimeout(timer)
      }
      retryTimersRef.current.clear()
    }
  }, [])

  const startQueuedCreation = useCallback(
    async (
      queuedMessage: QueuedThreadMessage & {
        readonly modelSelection: NonNullable<QueuedThreadMessage['modelSelection']>
      },
      creation: QueuedThreadCreation,
      projectCwd: string,
    ) =>
    {
      const modelSelection = queuedMessage.modelSelection
      const deliveryResult = await startTurn({
        environmentId: queuedMessage.environmentId,
        input: buildProjectThreadStartTurnInput({
          projectId: creation.projectId,
          projectCwd,
          threadId: queuedMessage.threadId,
          commandId: queuedMessage.commandId,
          messageId: queuedMessage.messageId,
          createdAt: queuedMessage.createdAt,
          text: queuedMessage.text.trim(),
          attachments: queuedMessage.attachments,
          modelSelection,
          runtimeMode: queuedMessage.runtimeMode ?? DEFAULT_RUNTIME_MODE,
          interactionMode: queuedMessage.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
          workspaceMode: creation.workspaceMode,
          branch: creation.branch,
          worktreePath: creation.worktreePath,
          startFromOrigin: creation.startFromOrigin ?? false,
          worktreeBranchName: buildTemporaryWorktreeBranchName(randomHex),
        }),
      })
      return deliveryResult
    },
    [startTurn],
  )

  useEffect(() =>
  {
    if (dispatchingQueuedMessageId !== null)
    {
      return
    }

    for (const [threadKey, queuedMessages] of Object.entries(queuedMessagesByThreadKey))
    {
      // a message that exhausted delivery is set aside, not left blocking the
      // queue: later messages keep draining, and one that cannot be delivered
      // either records its own durable failure instead of inheriting this one.
      const nextQueuedMessage = queuedMessages.find((message) => message.failure === undefined)
      if (!nextQueuedMessage)
      {
        continue
      }
      if (editingQueuedMessageIds[nextQueuedMessage.messageId])
      {
        continue
      }
      if ((retryNotBeforeRef.current.get(nextQueuedMessage.messageId) ?? 0) > Date.now())
      {
        continue
      }

      const thread = findThread(threads, nextQueuedMessage)
      if (thread && scopedThreadKey(thread.environmentId, thread.id) !== threadKey)
      {
        continue
      }

      const creation = nextQueuedMessage.creation
      if (creation === undefined && requiresWebImportContinuation(thread))
      {
        continue
      }
      const environment = connectedEnvironments.find(
        (candidate) => candidate.environmentId === nextQueuedMessage.environmentId,
      )
      const shellStatus = shellStatuses.get(nextQueuedMessage.environmentId) ?? 'empty'
      const deliveryAction = resolveThreadOutboxDeliveryAction({
        isCreation: creation !== undefined,
        threadExists: thread !== undefined,
        shellStatus,
        environmentConnected: environment?.connectionState === 'connected',
        threadBusy: thread?.session?.status === 'running' || thread?.session?.status === 'starting',
        providerSwitchActive: thread !== undefined && thread.providerSwitch !== null,
      })
      if (deliveryAction === 'wait')
      {
        continue
      }
      // the live project shell is preferred for the workspace path, with the
      // snapshot taken at enqueue time as the fallback so a task never dies
      // just because its project shell is not loaded.
      const creationProjectCwd =
        creation !== undefined
          ? (findCreationProject(projects, nextQueuedMessage)?.workspaceRoot ??
            creation.projectCwd ??
            null)
          : null
      const sendableCreationMessage =
        creation !== undefined && isQueuedThreadCreationSendable(nextQueuedMessage)
          ? nextQueuedMessage
          : null
      // an incomplete pending task (e.g. worktree mode without a branch) stays
      // queued until the user finishes it in the editor.
      if (deliveryAction === 'send' && creation !== undefined)
      {
        if (sendableCreationMessage === null)
        {
          continue
        }
        if (creationProjectCwd === null && shellStatus !== 'live')
        {
          continue
        }
      }

      beginDispatchingQueuedMessage(nextQueuedMessage.messageId)
      const delivery: Promise<ThreadOutboxDrainOutcome> =
        creation === undefined
          ? drainExistingQueuedThreadMessage({
              message: nextQueuedMessage,
              initialState: {
                thread,
                shellStatus,
                environmentConnected: environment?.connectionState === 'connected',
              },
              confirmQueued: async (message) =>
                (await confirmThreadOutboxMessageQueued(message)) &&
                !appAtomRegistry.get(editingQueuedMessageIdsAtom)[message.messageId],
              readState: () => ({
                thread: findThread(
                  appAtomRegistry.get(environmentThreadShells.threadShellsAtom),
                  nextQueuedMessage,
                ),
                shellStatus: appAtomRegistry.get(
                  environmentShell.stateValueAtom(nextQueuedMessage.environmentId),
                ).status,
                environmentConnected: isEnvironmentConnected(nextQueuedMessage.environmentId),
              }),
              update: updateThreadOutboxMessage,
              remove: removeThreadOutboxMessage,
              now: () => new Date().toISOString(),
              updateThreadMetadata,
              setThreadRuntimeMode,
              setThreadInteractionMode,
              startTurn,
            })
          : drainQueuedThreadCreation({
              message: nextQueuedMessage,
              initialState: {
                thread,
                shellStatus,
                environmentConnected: environment?.connectionState === 'connected',
              },
              confirmQueued: async (message) =>
                (await confirmThreadOutboxMessageQueued(message)) &&
                !appAtomRegistry.get(editingQueuedMessageIdsAtom)[message.messageId],
              readState: () => ({
                thread: findThread(
                  appAtomRegistry.get(environmentThreadShells.threadShellsAtom),
                  nextQueuedMessage,
                ),
                shellStatus: appAtomRegistry.get(
                  environmentShell.stateValueAtom(nextQueuedMessage.environmentId),
                ).status,
                environmentConnected: isEnvironmentConnected(nextQueuedMessage.environmentId),
              }),
              ...(creationProjectCwd !== null && sendableCreationMessage !== null
                ? {
                    send: () =>
                      startQueuedCreation(sendableCreationMessage, creation, creationProjectCwd),
                  }
                : {}),
              sendUnavailableReason:
                'The project workspace for this queued thread is no longer available.',
              update: updateThreadOutboxMessage,
              remove: removeThreadOutboxMessage,
            })
      void delivery
        .then((outcome) =>
        {
          if (outcome.kind === 'complete')
          {
            retryNotBeforeRef.current.delete(nextQueuedMessage.messageId)
            const pendingTimer = retryTimersRef.current.get(nextQueuedMessage.messageId)
            if (pendingTimer !== undefined)
            {
              clearTimeout(pendingTimer)
              retryTimersRef.current.delete(nextQueuedMessage.messageId)
            }
            return
          }

          const retryAttempt = outcome.kind === 'retry' ? outcome.attempt : 1
          const retryDelayMs = threadOutboxRetryDelayMs(retryAttempt)
          retryNotBeforeRef.current.set(nextQueuedMessage.messageId, Date.now() + retryDelayMs)
          const pendingTimer = retryTimersRef.current.get(nextQueuedMessage.messageId)
          if (pendingTimer !== undefined)
          {
            clearTimeout(pendingTimer)
          }
          const retryTimer = setTimeout(() =>
          {
            retryTimersRef.current.delete(nextQueuedMessage.messageId)
            setRetryTick((current) => current + 1)
          }, retryDelayMs)
          retryTimersRef.current.set(nextQueuedMessage.messageId, retryTimer)
        })
        .finally(() =>
        {
          finishDispatchingQueuedMessage(nextQueuedMessage.messageId)
        })
      return
    }
  }, [
    connectedEnvironments,
    dispatchingQueuedMessageId,
    editingQueuedMessageIds,
    projects,
    queuedMessagesByThreadKey,
    retryTick,
    startQueuedCreation,
    setThreadInteractionMode,
    setThreadRuntimeMode,
    shellStatuses,
    startTurn,
    threads,
    updateThreadMetadata,
  ])
}
