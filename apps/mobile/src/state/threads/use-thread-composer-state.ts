// apps/mobile/src/state/threads/use-thread-composer-state.ts
// manages mobile thread composer drafts and guarded message enqueueing
import { useAtomValue } from '@effect/atom-react'
import * as Option from 'effect/Option'
import { useCallback, useEffect, useMemo } from 'react'
import { Alert } from 'react-native'

import {
  CommandId,
  CONSERVATIVE_PROVIDER_RUNTIME_CAPABILITIES,
  MessageId,
  normalizeCollaborationMode,
  type CollaborationMode,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInteractionMode,
  type ProviderRuntimeCapabilities,
  type RuntimeMode,
  type ThreadId,
} from '@t3tools/contracts'
import { safeErrorLogAttributes } from '@t3tools/client-runtime/errors'
import { deriveActiveWorkStartedAt } from '@t3tools/shared/orchestrationTiming'

import { makeQueuedMessageMetadata } from '../../lib/commandMetadata'
import {
  convertPastedImagesToAttachments,
  pasteComposerClipboard,
  pickComposerImages,
} from '../../lib/composerImages'
import type { DraftComposerImageAttachment } from '../../lib/composerImages'
import { scopedThreadKey } from '../../lib/scopedEntities'
import {
  confirmProviderRuntimeModeWarnings,
  providerSessionNeedsRuntimeModeAcknowledgement,
} from '../../lib/providerRuntimeModeWarnings'
import { buildThreadFeed } from '../../lib/threadActivity'
import { appAtomRegistry } from '../atom-registry'
import { useEnvironmentServerConfig } from '../entities'
import {
  appendComposerDraftAttachments,
  appendComposerDraftText,
  clearComposerDraftContent,
  ComposerDraftPersistenceError,
  composerDraftsAtom,
  ensureComposerDraftsLoaded,
  getComposerDraftSnapshot,
  mergeComposerDraftContent,
  removeComposerDraftAttachment,
  setComposerDraftText,
  updateComposerDraftSettings,
  useComposerDraft,
  type ComposerDraft,
} from './use-composer-drafts'
import { setPendingConnectionError } from '../use-remote-environment-registry'
import { useSelectedThreadDetailState } from './use-thread-detail'
import { useThreadProviderSwitch } from './use-thread-provider-switch'
import { useThreadSelection } from './use-thread-selection'
import { enqueueThreadOutboxMessage, removeThreadOutboxMessage } from './thread-outbox'
import { requiresWebImportContinuation } from './thread-outbox-model'
import { readEnvironmentThreadState } from './threads'
import { useThreadOutboxMessages } from './use-thread-outbox'

function resolveComposerCollaborationMode(
  draft: Pick<ComposerDraft, 'interactionMode' | 'orchestrate'> | null | undefined,
  thread: { readonly interactionMode: ProviderInteractionMode; readonly orchestrate?: boolean },
): CollaborationMode
{
  if (draft?.interactionMode !== undefined)
  {
    return normalizeCollaborationMode(
      draft.interactionMode ?? thread.interactionMode,
      draft.orchestrate,
    )
  }
  return normalizeCollaborationMode(thread.interactionMode, thread.orchestrate)
}

export function resolveThreadComposerDispatchSettings(input: {
  readonly draft: Pick<
    ComposerDraft,
    'modelSelection' | 'runtimeMode' | 'interactionMode' | 'orchestrate'
  >
  readonly thread: {
    readonly modelSelection: ModelSelection
    readonly runtimeMode: RuntimeMode
    readonly interactionMode: ProviderInteractionMode
    readonly orchestrate?: boolean
  }
  readonly serverConfig: {
    readonly providers: ReadonlyArray<{
      readonly instanceId: ModelSelection['instanceId']
      readonly capabilities?: ProviderRuntimeCapabilities
    }>
  } | null
}): {
  readonly modelSelection: ModelSelection
  readonly runtimeMode: RuntimeMode
  readonly collaborationMode: CollaborationMode
}
{
  const modelSelection = input.draft.modelSelection ?? input.thread.modelSelection
  const capabilities =
    input.serverConfig?.providers.find(
      (provider) => provider.instanceId === modelSelection.instanceId,
    )?.capabilities ?? CONSERVATIVE_PROVIDER_RUNTIME_CAPABILITIES
  const requestedRuntimeMode = input.draft.runtimeMode ?? input.thread.runtimeMode
  const requestedCollaborationMode = resolveComposerCollaborationMode(input.draft, input.thread)
  const fallbackBaseMode = capabilities.supportedInteractionModes.includes('default')
    ? 'default'
    : 'plan'
  const collaborationMode = {
    baseMode: capabilities.supportedInteractionModes.includes(requestedCollaborationMode.baseMode)
      ? requestedCollaborationMode.baseMode
      : fallbackBaseMode,
    orchestrate:
      requestedCollaborationMode.orchestrate &&
      capabilities.orchestrateInstructionDelivery !== 'unsupported' &&
      capabilities.orchestrateBaseModes.includes(requestedCollaborationMode.baseMode),
  } satisfies CollaborationMode

  return {
    modelSelection,
    runtimeMode: capabilities.supportedRuntimeModes.includes(requestedRuntimeMode)
      ? requestedRuntimeMode
      : (capabilities.supportedRuntimeModes[0] ?? 'approval-required'),
    collaborationMode,
  }
}

export function modelSelectionChangeBlockedByCapabilities(input: {
  readonly threadStarted: boolean
  readonly currentModelSelection: ModelSelection
  readonly nextModelSelection: ModelSelection
  readonly capabilities: ProviderRuntimeCapabilities
}): string | null
{
  if (
    !input.threadStarted ||
    input.currentModelSelection.instanceId !== input.nextModelSelection.instanceId ||
    input.currentModelSelection.model === input.nextModelSelection.model
  )
  {
    return null
  }
  return input.capabilities.sessionModelSwitch === 'unsupported'
    ? 'This provider does not allow changing models after a thread has started.'
    : null
}

export function appendReviewCommentToDraft(input: {
  readonly environmentId: EnvironmentId
  readonly threadId: ThreadId
  readonly text: string
  readonly attachments?: ReadonlyArray<DraftComposerImageAttachment>
}): void
{
  const threadKey = scopedThreadKey(input.environmentId, input.threadId)
  const existing = appAtomRegistry.get(composerDraftsAtom)[threadKey]?.text ?? ''
  const separator = existing.trim().length > 0 && !existing.endsWith('\n') ? '\n\n' : ''
  setComposerDraftText(threadKey, `${existing}${separator}${input.text}`)
  if (input.attachments && input.attachments.length > 0)
  {
    appendComposerDraftAttachments(threadKey, input.attachments)
  }
}

export function useThreadDraftForThread(input: {
  readonly environmentId?: EnvironmentId
  readonly threadId?: ThreadId
})
{
  const threadKey =
    input.environmentId && input.threadId
      ? scopedThreadKey(input.environmentId, input.threadId)
      : null
  const draft = useComposerDraft(threadKey)

  return {
    draftMessage: draft.text,
    draftAttachments: draft.attachments,
  }
}

export function useThreadComposerState()
{
  const { selectedThread: selectedThreadShell } = useThreadSelection()
  const selectedThreadDetailState = useSelectedThreadDetailState()
  const selectedThreadDetail = Option.getOrNull(selectedThreadDetailState.data)
  const serverConfig = useEnvironmentServerConfig(selectedThreadShell?.environmentId ?? null)
  const composerDrafts = useAtomValue(composerDraftsAtom)
  const queuedMessagesByThreadKey = useThreadOutboxMessages()
  const providerSwitch = useThreadProviderSwitch()

  useEffect(() =>
  {
    ensureComposerDraftsLoaded()
  }, [])

  const selectedThreadKey = selectedThreadShell
    ? scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id)
    : null
  const selectedThreadQueuedMessages = useMemo(
    () => (selectedThreadKey ? (queuedMessagesByThreadKey[selectedThreadKey] ?? []) : []),
    [queuedMessagesByThreadKey, selectedThreadKey],
  )
  const selectedThreadFeed = useMemo(
    () => (selectedThreadDetail ? buildThreadFeed(selectedThreadDetail) : []),
    [selectedThreadDetail],
  )

  const selectedDraft = selectedThreadKey ? composerDrafts[selectedThreadKey] : null
  const draftMessage = selectedDraft?.text ?? ''
  const draftAttachments = selectedDraft?.attachments ?? []
  const selectedThreadQueueCount = selectedThreadQueuedMessages.length
  const selectedThreadFailedQueuedMessage = selectedThreadQueuedMessages.find(
    (message) => message.failure !== undefined,
  )
  const selectedThread = selectedThreadDetail ?? selectedThreadShell
  const modelSelection = selectedDraft?.modelSelection ?? selectedThread?.modelSelection ?? null
  const runtimeMode = selectedDraft?.runtimeMode ?? selectedThread?.runtimeMode ?? null
  const interactionMode = selectedThread
    ? resolveComposerCollaborationMode(selectedDraft, selectedThread)
    : null

  const selectedThreadSessionActivity = useMemo(() =>
  {
    const selectedThread = selectedThreadDetail ?? selectedThreadShell
    if (!selectedThread?.session)
    {
      return null
    }

    return {
      orchestrationStatus: selectedThread.session.status,
      activeTurnId: selectedThread.session.activeTurnId ?? undefined,
    }
  }, [selectedThreadDetail, selectedThreadShell])

  const activeWorkStartedAt = useMemo(() =>
  {
    const selectedThread = selectedThreadDetail ?? selectedThreadShell
    if (!selectedThread)
    {
      return null
    }

    return deriveActiveWorkStartedAt(selectedThread.latestTurn, selectedThreadSessionActivity, null)
  }, [selectedThreadDetail, selectedThreadSessionActivity, selectedThreadShell])

  // an in-flight switch is busy work the user cannot stop, so it queues sends
  // exactly like a running turn does.
  const activeThreadBusy =
    providerSwitch.active ||
    (!!selectedThread &&
      (selectedThread.session?.status === 'running' ||
        selectedThread.session?.status === 'starting'))
  const sendBlockedReason =
    selectedThreadDetailState.status === 'deleted'
      ? 'This thread was deleted.'
      : requiresWebImportContinuation(selectedThreadShell)
        ? 'Continue this imported session in the web app after reviewing its provider continuation.'
        : null

  const onSendMessage = useCallback(async () =>
  {
    if (!selectedThreadShell)
    {
      return null
    }
    if (sendBlockedReason !== null)
    {
      return null
    }
    if (
      readEnvironmentThreadState(selectedThreadShell.environmentId, selectedThreadShell.id)
        .status === 'deleted'
    )
    {
      return null
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id)
    const draft = getComposerDraftSnapshot(threadKey)
    const thread = selectedThreadDetail ?? selectedThreadShell
    const text = draft.text.trim()
    const attachments = draft.attachments
    if (text.length === 0 && attachments.length === 0)
    {
      return null
    }

    const metadata = makeQueuedMessageMetadata()
    const messageId = MessageId.make(metadata.messageId)
    const dispatchSettings = resolveThreadComposerDispatchSettings({
      draft,
      thread,
      serverConfig,
    })
    const providerCapabilities =
      serverConfig?.providers.find(
        (provider) => provider.instanceId === dispatchSettings.modelSelection.instanceId,
      )?.capabilities ?? CONSERVATIVE_PROVIDER_RUNTIME_CAPABILITIES
    if (
      attachments.length > 0 &&
      !providerCapabilities.supportedAttachmentTypes.includes('image')
    )
    {
      setPendingConnectionError('This provider does not support image attachments.')
      return null
    }
    const runtimeModeAcknowledgements = providerSessionNeedsRuntimeModeAcknowledgement({
      currentModelSelection: thread.modelSelection,
      session: thread.session,
      targetModelSelection: dispatchSettings.modelSelection,
      runtimeMode: dispatchSettings.runtimeMode,
    })
      ? await confirmProviderRuntimeModeWarnings(providerCapabilities, dispatchSettings.runtimeMode)
      : []
    if (runtimeModeAcknowledgements === null)
    {
      return null
    }
    // clear on optimistic enqueue and restore content if storage fails
    const enqueuePromise = enqueueThreadOutboxMessage({
      environmentId: selectedThreadShell.environmentId,
      threadId: selectedThreadShell.id,
      messageId,
      commandId: CommandId.make(metadata.commandId),
      text,
      attachments,
      modelSelection: dispatchSettings.modelSelection,
      runtimeMode: dispatchSettings.runtimeMode,
      ...(runtimeModeAcknowledgements.length > 0 ? { runtimeModeAcknowledgements } : {}),
      interactionMode: dispatchSettings.collaborationMode.baseMode,
      orchestrate: dispatchSettings.collaborationMode.orchestrate,
      createdAt: metadata.createdAt,
    })
    clearComposerDraftContent(threadKey)
    enqueuePromise.catch((error: unknown) =>
    {
      // append attachments uncapped so newer draft images cannot displace them
      void mergeComposerDraftContent(threadKey, { text, attachments: [] }).catch(
        (restoreError: unknown) =>
        {
          setPendingConnectionError(
            restoreError instanceof ComposerDraftPersistenceError
              ? restoreError.message
              : 'Failed to restore the queued message draft.',
          )
        },
      )
      appendComposerDraftAttachments(threadKey, attachments)
      setPendingConnectionError(
        error instanceof Error ? error.message : 'Failed to save the queued message.',
      )
    })
    return messageId
  }, [selectedThreadDetail, selectedThreadShell, sendBlockedReason, serverConfig])

  const onChangeDraftMessage = useCallback(
    (value: string) =>
    {
      if (!selectedThreadShell)
      {
        return
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id)
      setComposerDraftText(threadKey, value)
    },
    [selectedThreadShell],
  )

  const onPickDraftImages = useCallback(async () =>
  {
    if (!selectedThreadShell)
    {
      return
    }

    const capabilities =
      serverConfig?.providers.find((provider) => provider.instanceId === modelSelection?.instanceId)
        ?.capabilities ?? CONSERVATIVE_PROVIDER_RUNTIME_CAPABILITIES
    if (!capabilities.supportedAttachmentTypes.includes('image'))
    {
      setPendingConnectionError('This provider does not support image attachments.')
      return
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id)
    const result = await pickComposerImages({
      existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
    })
    if (result.images.length > 0)
    {
      appendComposerDraftAttachments(threadKey, result.images)
    }
    if (result.error)
    {
      setPendingConnectionError(result.error)
    }
  }, [composerDrafts, modelSelection?.instanceId, selectedThreadShell, serverConfig])

  const onPasteIntoDraft = useCallback(async () =>
  {
    if (!selectedThreadShell)
    {
      return
    }

    const capabilities =
      serverConfig?.providers.find((provider) => provider.instanceId === modelSelection?.instanceId)
        ?.capabilities ?? CONSERVATIVE_PROVIDER_RUNTIME_CAPABILITIES
    if (!capabilities.supportedAttachmentTypes.includes('image'))
    {
      setPendingConnectionError('This provider does not support image attachments.')
      return
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id)
    const result = await pasteComposerClipboard({
      existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
    })
    if (result.images.length > 0)
    {
      appendComposerDraftAttachments(threadKey, result.images)
    }
    if (result.text)
    {
      appendComposerDraftText(threadKey, result.text)
    }
    if (result.error)
    {
      setPendingConnectionError(result.error)
    }
  }, [composerDrafts, modelSelection?.instanceId, selectedThreadShell, serverConfig])

  const onNativePasteImages = useCallback(
    async (uris: ReadonlyArray<string>) =>
    {
      if (!selectedThreadShell || uris.length === 0)
      {
        return
      }

      const capabilities =
        serverConfig?.providers.find(
          (provider) => provider.instanceId === modelSelection?.instanceId,
        )?.capabilities ?? CONSERVATIVE_PROVIDER_RUNTIME_CAPABILITIES
      if (!capabilities.supportedAttachmentTypes.includes('image'))
      {
        setPendingConnectionError('This provider does not support image attachments.')
        return
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id)
      try
      {
        const images = await convertPastedImagesToAttachments({
          uris,
          existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
        })
        if (images.length > 0)
        {
          appendComposerDraftAttachments(threadKey, images)
        }
      }
      catch (error)
      {
        console.error('[native paste] error converting images', {
          environmentId: selectedThreadShell.environmentId,
          threadId: selectedThreadShell.id,
          uriCount: uris.length,
          ...safeErrorLogAttributes(error),
        })
      }
    },
    [composerDrafts, modelSelection?.instanceId, selectedThreadShell, serverConfig],
  )

  const onDiscardFailedQueuedMessage = useCallback(() =>
  {
    if (!selectedThreadFailedQueuedMessage)
    {
      return
    }
    Alert.alert(
      'Discard queued message?',
      'This message could not be sent and will be removed from the outbox.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Discard',
          style: 'destructive',
          onPress: () =>
          {
            void removeThreadOutboxMessage(selectedThreadFailedQueuedMessage).catch((error) =>
            {
              setPendingConnectionError(
                error instanceof Error
                  ? error.message
                  : 'The queued message could not be discarded.',
              )
            })
          },
        },
      ],
    )
  }, [selectedThreadFailedQueuedMessage])

  const onRemoveDraftImage = useCallback(
    (imageId: string) =>
    {
      if (!selectedThreadShell)
      {
        return
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id)
      removeComposerDraftAttachment(threadKey, imageId)
    },
    [selectedThreadShell],
  )

  // picking another provider instance on a started thread is a handoff, not a
  // draft edit: it goes through an explicit confirmation and switch command,
  // and the draft is left untouched either way.
  const onUpdateModelSelection = useCallback(
    (value: ModelSelection) =>
    {
      if (!selectedThreadKey)
      {
        return
      }
      const targetProviderCapabilities =
        serverConfig?.providers.find((provider) => provider.instanceId === value.instanceId)
          ?.capabilities ?? CONSERVATIVE_PROVIDER_RUNTIME_CAPABILITIES
      const threadStarted =
        (selectedThreadShell?.session !== null && selectedThreadShell?.session !== undefined) ||
        (selectedThreadShell?.latestTurn !== null &&
          selectedThreadShell?.latestTurn !== undefined) ||
        (selectedThreadShell?.latestUserMessageAt !== null &&
          selectedThreadShell?.latestUserMessageAt !== undefined)
      const modelChangeBlockReason = modelSelectionChangeBlockedByCapabilities({
        threadStarted,
        currentModelSelection: selectedThreadShell?.modelSelection ?? value,
        nextModelSelection: value,
        capabilities: targetProviderCapabilities,
      })
      if (modelChangeBlockReason !== null)
      {
        setPendingConnectionError(modelChangeBlockReason)
        return
      }
      if (providerSwitch.requestProviderSwitch(value))
      {
        return
      }
      const targetDefaultRuntimeMode = serverConfig?.providers.find(
        (provider) => provider.instanceId === value.instanceId,
      )?.capabilities?.defaultRuntimeMode
      updateComposerDraftSettings(selectedThreadKey, {
        modelSelection: value,
        ...(value.instanceId !== modelSelection?.instanceId &&
        targetDefaultRuntimeMode !== undefined
          ? { runtimeMode: targetDefaultRuntimeMode }
          : {}),
      })
    },
    [
      modelSelection?.instanceId,
      providerSwitch,
      selectedThreadKey,
      selectedThreadShell,
      serverConfig,
    ],
  )

  const onUpdateRuntimeMode = useCallback(
    (value: RuntimeMode) =>
    {
      if (!selectedThreadKey)
      {
        return
      }
      updateComposerDraftSettings(selectedThreadKey, { runtimeMode: value })
    },
    [selectedThreadKey],
  )

  const onUpdateInteractionMode = useCallback(
    (value: CollaborationMode) =>
    {
      if (!selectedThreadKey)
      {
        return
      }
      updateComposerDraftSettings(selectedThreadKey, {
        interactionMode: value.baseMode,
        orchestrate: value.orchestrate,
      })
    },
    [selectedThreadKey],
  )

  return {
    selectedThreadFeed,
    selectedThreadQueueCount,
    selectedThreadQueueFailureReason: selectedThreadFailedQueuedMessage?.failure?.reason ?? null,
    activeWorkStartedAt,
    draftMessage,
    draftAttachments,
    modelSelection,
    runtimeMode,
    interactionMode,
    activeThreadBusy,
    sendBlockedReason,
    providerSwitchActive: providerSwitch.active,
    providerSwitchNotice: providerSwitch.notice,
    onDismissProviderSwitchNotice: providerSwitch.onDismissNotice,
    onRetryProviderSwitch: providerSwitch.onRetry,
    onChangeDraftMessage,
    onPickDraftImages,
    onPasteIntoDraft,
    onNativePasteImages,
    onRemoveDraftImage,
    onSendMessage,
    onDiscardFailedQueuedMessage,
    onUpdateModelSelection,
    onUpdateRuntimeMode,
    onUpdateInteractionMode,
  }
}
