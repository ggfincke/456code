// apps/web/src/components/chat/useChatDispatchController.ts
// coordinates draft promotion, send/retry, interruption, and provider handoff

import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from '@t3tools/client-runtime/state/runtime'
import { scopedThreadKey, scopeThreadRef } from '@t3tools/client-runtime/environment'
import {
  DEFAULT_MODEL,
  type EnvironmentId,
  type MessageId,
  type ModelSelection,
  type PreviewAnnotationPayload,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ScopedThreadRef,
  type ServerProvider,
  type ThreadId,
  type ThreadImportContinuationConsent,
} from '@t3tools/contracts'
import type { UnifiedSettings } from '@t3tools/contracts/settings'
import { createModelSelection } from '@t3tools/shared/model'
import { truncate } from '@t3tools/shared/String'
import { buildTemporaryWorktreeBranchName } from '@t3tools/shared/git'
import {
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { flushSync } from 'react-dom'

import {
  buildExpiredTerminalContextToastCopy,
  buildThreadTurnInterruptInput,
  chatActionErrorMessage,
  cloneComposerImageForRetry,
  deriveComposerSendState,
  formatOutgoingPrompt,
  getStartedThreadModelChangeBlockReason,
  getStartedThreadProviderSwitchBlockReason,
  handleImportContinuationSendBlock,
  IMAGE_ONLY_BOOTSTRAP_PROMPT,
  readFileAsDataUrl,
  revokeUserMessagePreviewUrls,
  shouldReconcileComposerDraftModelSelection,
  shouldRestoreComposerDraftAfterSendFailure,
  threadHasStarted,
  type LocalThreadErrorEntry,
  type UserSetComposerModelSelection,
} from '../ChatView.logic'
import {
  collapseExpandedComposerCursor,
  parseLegacyOrchestrateInvocation,
  parseStandaloneComposerSlashCommand,
} from '~/composer-logic'
import type { ComposerImageAttachment, DraftId, DraftThreadEnvMode } from '~/composerDraftStore'
import { useComposerDraftStore } from '~/composerDraftStore'

type ComposerThreadTarget = ScopedThreadRef | DraftId
import {
  appendElementContextsToPrompt,
  formatElementContextLabel,
  type ElementContextDraft,
} from '~/lib/elementContext'
import { appendPreviewAnnotationPrompt } from '~/lib/previewAnnotation'
import {
  appendTerminalContextsToPrompt,
  formatTerminalContextLabel,
  type TerminalContextDraft,
} from '~/lib/terminalContext'
import { appendReviewCommentsToPrompt, type ReviewCommentContext } from '~/reviewCommentContext'
import { resolveAppModelSelectionForInstance } from '~/modelSelection'
import { newMessageId, randomHex } from '~/lib/utils'
import { deriveProviderInstanceEntries } from '~/providerInstances'
import {
  canApplyProviderSwitchRetry,
  formatProviderSwitchFailureToastDescription,
  formatProviderSwitchSendBlockedNotice,
  formatProviderSwitchTargetLabel,
  reconcileProviderSwitchAnnouncements,
  resolveProviderSwitchRetryTarget,
  type ComposerProviderSwitchState,
  type ProviderSwitchAnnouncementState,
  type ProviderSwitchInstanceResolver,
  type ProviderSwitchTimelineEvent,
} from '~/providerSwitchPresentation'
import type { PendingUserInputProgress } from '~/pendingUserInput'
import type { LatestProposedPlanState } from '~/session-logic'
import { type ChatMessage, type Project, type SessionPhase, type Thread } from '~/types'
import { stackedThreadToast, toastManager } from '../ui/toast'
import type { ChatComposerHandle } from './chatComposerHandle'
import type { TimelineScrollMode } from './messages-timeline/timelineScrollAnchoring'
import { resolvePlanFollowUpSubmission } from '~/proposedPlan'

// keep the payload structural so ChatView's atom command remains assignable
type UpdateThreadMetadataMutation = (input: {
  readonly environmentId: EnvironmentId
  readonly input: {
    readonly threadId: ThreadId
    readonly title: string
  }
}) => Promise<AtomCommandResult<unknown, unknown>>

type StartThreadTurnMutation = (input: {
  readonly environmentId: EnvironmentId
  readonly input: {
    readonly threadId: ThreadId
    readonly message: {
      readonly messageId: MessageId
      readonly role: 'user'
      readonly text: string
      readonly attachments: ReadonlyArray<{
        readonly type: 'image'
        readonly name: string
        readonly mimeType: string
        readonly sizeBytes: number
        readonly dataUrl: string
      }>
    }
    readonly modelSelection: ModelSelection
    readonly titleSeed: string
    readonly runtimeMode: RuntimeMode
    readonly interactionMode: ProviderInteractionMode
    readonly bootstrap?: {
      readonly createThread?: {
        readonly projectId: Project['id']
        readonly title: string
        readonly modelSelection: ModelSelection
        readonly runtimeMode: RuntimeMode
        readonly interactionMode: ProviderInteractionMode
        readonly branch: string | null
        readonly worktreePath: string | null
        readonly createdAt: string
      }
      readonly prepareWorktree?: {
        readonly projectCwd: string
        readonly baseBranch: string
        readonly branch: string
        readonly startFromOrigin?: true
      }
      readonly runSetupScript?: true
    }
    readonly importContinuationConsent?: ThreadImportContinuationConsent
    readonly createdAt: string
  }
}) => Promise<AtomCommandResult<unknown, unknown>>

// explicit send/retry ports for runSend — named fields only, not a context bag;
// thread identity stays on the controller input so send cannot diverge
export interface ChatSendPorts
{
  readonly activeEnvironmentUnavailable: boolean
  readonly activePendingProgress: PendingUserInputProgress | null
  readonly activeProject: Project | null | undefined
  readonly activeProposedPlan: LatestProposedPlanState | null
  readonly activeThreadBranch: string | null
  readonly activeThreadKey: string | null
  readonly activeTimelineAnchorIndexRef: MutableRefObject<number | null>
  readonly addComposerDraftImages: (
    target: ComposerThreadTarget,
    images: ComposerImageAttachment[],
  ) => void
  readonly anchorUserScrollGenerationRef: MutableRefObject<number>
  readonly beginLocalDispatch: (options?: { preparingWorktree?: boolean }) => void
  readonly captureDraftHeroComposerRect: () => void
  readonly clearComposerDraftContent: (target: ComposerThreadTarget) => void
  readonly composerDraftOwnerKey: string
  readonly composerDraftOwnerKeyRef: MutableRefObject<string>
  readonly composerDraftTarget: ComposerThreadTarget
  readonly composerElementContextsRef: MutableRefObject<ElementContextDraft[]>
  readonly composerImagesRef: MutableRefObject<ComposerImageAttachment[]>
  readonly composerRef: RefObject<ChatComposerHandle | null>
  readonly composerTerminalContextsRef: MutableRefObject<TerminalContextDraft[]>
  readonly focusImportContinuationBanner: () => void
  readonly handleInteractionModeChange: (mode: ProviderInteractionMode) => void
  readonly importContinuationConsent: ThreadImportContinuationConsent | null | undefined
  readonly importContinuationSendBlocked: boolean
  readonly interactionMode: ProviderInteractionMode
  readonly isAtEndRef: MutableRefObject<boolean>
  readonly isConnecting: boolean
  readonly isDraftHeroState: boolean
  readonly isLocalDraftThread: boolean
  readonly isServerThread: boolean
  readonly liveFollowUserScrollGenerationRef: MutableRefObject<number | null>
  readonly localCheckoutBranchMismatch: { readonly currentBranch: string } | null
  readonly onAdvanceActivePendingUserInput: () => void
  readonly onSubmitPlanFollowUp: (input: {
    text: string
    interactionMode: 'default' | 'plan'
  }) => Promise<boolean>
  readonly pendingTimelineAnchorRef: MutableRefObject<MessageId | null>
  readonly persistThreadSettingsForNextTurn: (input: {
    threadId: ThreadId
    createdAt: string
    modelSelection?: ModelSelection
    branch?: string
    runtimeMode: RuntimeMode
    interactionMode: ProviderInteractionMode
  }) => Promise<AtomCommandResult<void, unknown>>
  readonly promptRef: MutableRefObject<string>
  readonly resetLocalDispatch: () => void
  readonly runMobileComposerTransition: (update: () => void) => Promise<void>
  readonly runtimeMode: RuntimeMode
  readonly sendEnvMode: DraftThreadEnvMode
  readonly sendInFlightRef: MutableRefObject<boolean>
  readonly setComposerDraftElementContexts: (
    target: ComposerThreadTarget,
    contexts: ElementContextDraft[],
  ) => void
  readonly setComposerDraftPreviewAnnotations: (
    target: ComposerThreadTarget,
    annotations: PreviewAnnotationPayload[],
  ) => void
  readonly setComposerDraftPrompt: (target: ComposerThreadTarget, prompt: string) => void
  readonly setComposerDraftReviewComments: (
    target: ComposerThreadTarget,
    comments: ReviewCommentContext[],
  ) => void
  readonly setComposerDraftTerminalContexts: (
    target: ComposerThreadTarget,
    contexts: TerminalContextDraft[],
  ) => void
  readonly setDockedDraftHeroThreadKey: Dispatch<SetStateAction<string | null>>
  readonly setOptimisticUserMessages: Dispatch<SetStateAction<ChatMessage[]>>
  readonly setShowScrollToBottom: Dispatch<SetStateAction<boolean>>
  readonly setTimelineAnchor: Dispatch<
    SetStateAction<{ threadKey: string | null; messageId: MessageId | null }>
  >
  readonly showPlanFollowUpPrompt: boolean
  // runSend only cancels; keep the port narrow so Debouncer generics stay out
  readonly showScrollDebouncer: MutableRefObject<{ cancel: () => void }>
  readonly startFromOrigin: boolean
  readonly startThreadTurn: StartThreadTurnMutation
  readonly threadDetailLoading: boolean
  readonly timelineScrollModeRef: MutableRefObject<TimelineScrollMode>
  readonly updateThreadMetadata: UpdateThreadMetadataMutation
}

interface UseDraftErrorPromotionInput
{
  readonly activeServerThread: Thread | null
  readonly draftId: string | null
  readonly localDraftErrorsByDraftId: Readonly<Record<string, LocalThreadErrorEntry | undefined>>
  readonly routeThreadKey: string
  readonly setLocalDraftErrorsByDraftId: Dispatch<
    SetStateAction<Record<string, LocalThreadErrorEntry>>
  >
  readonly setLocalServerErrorsByThreadKey: Dispatch<
    SetStateAction<Record<string, LocalThreadErrorEntry>>
  >
}

// keep the error-key migration at the same render position as the route
// promotion state that triggers it
export function useDraftErrorPromotion(input: UseDraftErrorPromotionInput): void
{
  const {
    activeServerThread,
    draftId,
    localDraftErrorsByDraftId,
    routeThreadKey,
    setLocalDraftErrorsByDraftId,
    setLocalServerErrorsByThreadKey,
  } = input

  useEffect(() =>
  {
    if (!activeServerThread || !draftId)
    {
      return
    }
    const pendingDraftEntry = localDraftErrorsByDraftId[draftId]
    if (pendingDraftEntry === undefined)
    {
      return
    }
    setLocalDraftErrorsByDraftId((existing) =>
    {
      if (existing[draftId] === undefined)
      {
        return existing
      }
      const next = { ...existing }
      delete next[draftId]
      return next
    })
    setLocalServerErrorsByThreadKey((existing) =>
    {
      const currentEntry = existing[routeThreadKey]
      if (
        currentEntry !== undefined &&
        (currentEntry.at > pendingDraftEntry.at ||
          currentEntry.message === pendingDraftEntry.message)
      )
      {
        return existing
      }
      return {
        ...existing,
        [routeThreadKey]: pendingDraftEntry,
      }
    })
  }, [
    activeServerThread,
    draftId,
    localDraftErrorsByDraftId,
    routeThreadKey,
    setLocalDraftErrorsByDraftId,
    setLocalServerErrorsByThreadKey,
  ])
}

interface ProviderSwitchConfirmation
{
  readonly environmentId: EnvironmentId
  readonly threadId: ThreadId
  readonly targetModelSelection: ModelSelection
  // configured instance name plus the model it will run, so the dialog names
  // the same target the pill and the outcome do
  readonly targetLabel: string
  readonly expectedCurrentInstanceId: ProviderInstanceId
}

type InterruptThreadTurnMutation = (input: {
  readonly environmentId: EnvironmentId
  readonly input: ReturnType<typeof buildThreadTurnInterruptInput>
}) => Promise<AtomCommandResult<unknown, unknown>>

type SwitchThreadProviderMutation = (input: {
  readonly environmentId: EnvironmentId
  readonly input: {
    readonly threadId: ThreadId
    readonly targetModelSelection: ModelSelection
    readonly expectedCurrentInstanceId: ProviderInstanceId
  }
}) => Promise<AtomCommandResult<unknown, unknown>>

interface UseChatDispatchControllerInput
{
  readonly activeLatestTurnRunning: boolean
  readonly activeThread: Thread | null
  readonly composerModelSelection: ModelSelection | null
  readonly environmentId: EnvironmentId
  readonly interruptThreadTurn: InterruptThreadTurnMutation
  readonly isSendBusy: boolean
  readonly lockedProvider: ProviderDriverKind | null
  readonly pendingApprovalCount: number
  readonly pendingUserInputCount: number
  readonly phase: SessionPhase
  readonly providerStatuses: readonly ServerProvider[]
  readonly providerSwitchTimelineEvents: readonly ProviderSwitchTimelineEvent[]
  readonly resolveProviderSwitchInstance: ProviderSwitchInstanceResolver
  readonly routeKind: 'draft' | 'server'
  readonly routeThreadKey: string
  readonly routeThreadRef: ScopedThreadRef
  readonly scheduleComposerFocus: () => void
  // send/retry coordination ports — explicit named fields only
  readonly send: ChatSendPorts
  readonly setComposerDraftModelSelection: (
    threadRef: ScopedThreadRef,
    modelSelection: ModelSelection,
    opts?: { readonly replaceOptions?: boolean },
  ) => void
  readonly setStickyComposerModelSelection: (modelSelection: ModelSelection) => void
  readonly setThreadError: (threadId: ThreadId | null, error: string | null) => void
  readonly settings: UnifiedSettings
  readonly switchThreadProvider: SwitchThreadProviderMutation
  // true only once the thread detail is live; a cached or syncing snapshot can
  // still be missing switch outcomes
  readonly threadDetailSynchronized: boolean
  readonly verifiedImportProviderInstanceId: ProviderInstanceId | null
}

export function useChatDispatchController(input: UseChatDispatchControllerInput)
{
  const {
    activeLatestTurnRunning,
    activeThread,
    composerModelSelection,
    environmentId,
    interruptThreadTurn,
    isSendBusy,
    lockedProvider,
    pendingApprovalCount,
    pendingUserInputCount,
    phase,
    providerStatuses,
    providerSwitchTimelineEvents,
    resolveProviderSwitchInstance,
    routeKind,
    routeThreadKey,
    routeThreadRef,
    scheduleComposerFocus,
    send,
    setComposerDraftModelSelection,
    setStickyComposerModelSelection,
    setThreadError,
    settings,
    switchThreadProvider,
    threadDetailSynchronized,
    verifiedImportProviderInstanceId,
  } = input
  const [providerSwitchConfirmation, setProviderSwitchConfirmation] =
    useState<ProviderSwitchConfirmation | null>(null)
  const [switchingProviderThreadKey, setSwitchingProviderThreadKey] = useState<string | null>(null)
  const isSwitchingProvider = switchingProviderThreadKey === routeThreadKey

  const activeProviderSwitch = activeThread?.providerSwitch ?? null
  const activeProviderSwitchTarget = activeProviderSwitch
    ? resolveProviderSwitchInstance(activeProviderSwitch.targetInstanceId)
    : null
  const activeProviderSwitchTargetLabel = activeProviderSwitch
    ? formatProviderSwitchTargetLabel({
        instanceId: activeProviderSwitch.targetInstanceId,
        displayName: activeProviderSwitchTarget?.displayName,
        model: activeProviderSwitch.targetModel,
      })
    : null
  const composerProviderSwitch = useMemo<ComposerProviderSwitchState | null>(
    () =>
      activeProviderSwitch
        ? {
            notice: formatProviderSwitchSendBlockedNotice(activeProviderSwitchTargetLabel),
            // a switch keeps the session "running" while it compacts, but
            // there is no turn behind it to stop
            hidesRunningTurn: !activeLatestTurnRunning,
          }
        : null,
    [activeLatestTurnRunning, activeProviderSwitch, activeProviderSwitchTargetLabel],
  )

  const providerSwitchBlockReason = getStartedThreadProviderSwitchBlockReason({
    isSwitchingProvider: isSwitchingProvider || activeProviderSwitch !== null,
    isTurnRunning: phase === 'running' || isSendBusy,
    hasPendingApproval: pendingApprovalCount > 0,
    hasPendingUserInput: pendingUserInputCount > 0,
  })
  const currentProviderInstanceId = activeThread
    ? activeThread.pendingHandoff
      ? activeThread.modelSelection.instanceId
      : (activeThread.session?.providerInstanceId ?? activeThread.modelSelection.instanceId)
    : null

  const getModelDisabledReason = useCallback(
    (instanceId: ProviderInstanceId, model: string): string | null =>
    {
      if (!activeThread)
      {
        return null
      }
      if (
        verifiedImportProviderInstanceId !== null &&
        instanceId !== verifiedImportProviderInstanceId
      )
      {
        return 'This imported session is locked to its verified provider instance until its first native turn.'
      }
      if (threadHasStarted(activeThread) && instanceId !== activeThread.modelSelection.instanceId)
      {
        return providerSwitchBlockReason
      }
      const reason = getStartedThreadModelChangeBlockReason({
        providers: providerStatuses,
        hasStartedSession: activeThread.session !== null,
        currentModelSelection: activeThread.modelSelection,
        currentProviderInstanceId,
        nextModelSelection: { instanceId, model },
      })
      return reason ? `${reason.description} Start a new thread to use this model.` : null
    },
    [
      activeThread,
      currentProviderInstanceId,
      providerStatuses,
      providerSwitchBlockReason,
      verifiedImportProviderInstanceId,
    ],
  )

  // the pick the user last made through the picker, with the projection it
  // superseded. The reconciliation effect reads it to tell a fresh user choice
  // from a draft that merely went stale.
  const userSetComposerSelectionRef = useRef<UserSetComposerModelSelection | null>(null)

  // `replaceOptions` marks a complete snapshot of the selection: the projection
  // is the whole truth, so options it no longer carries must go. A picker change
  // is model-only and keeps preserving the draft's existing options.
  const applyComposerModelSelection = useCallback(
    (
      threadRef: ScopedThreadRef,
      nextModelSelection: ModelSelection,
      opts?: { readonly replaceOptions?: boolean },
    ) =>
    {
      setComposerDraftModelSelection(threadRef, nextModelSelection, opts)
      setStickyComposerModelSelection(nextModelSelection)
    },
    [setComposerDraftModelSelection, setStickyComposerModelSelection],
  )

  const onProviderModelSelect = useCallback(
    (instanceId: ProviderInstanceId, model: string) =>
    {
      if (!activeThread) return
      if (
        verifiedImportProviderInstanceId !== null &&
        instanceId !== verifiedImportProviderInstanceId
      )
      {
        scheduleComposerFocus()
        return
      }
      // resolve against the exact configured instance so custom provider
      // models never collapse into the built-in default
      const entry = providerStatuses.find((snapshot) => snapshot.instanceId === instanceId)
      if (!entry)
      {
        scheduleComposerFocus()
        return
      }
      const resolvedDriverKind = entry.driver
      if (
        lockedProvider !== null &&
        resolvedDriverKind !== null &&
        resolvedDriverKind !== lockedProvider
      )
      {
        scheduleComposerFocus()
        return
      }
      if (lockedProvider !== null && activeThread.session?.providerInstanceId)
      {
        const currentEntry = providerStatuses.find(
          (snapshot) => snapshot.instanceId === activeThread.session?.providerInstanceId,
        )
        if (
          currentEntry?.continuation?.groupKey &&
          entry.continuation?.groupKey &&
          currentEntry.continuation.groupKey !== entry.continuation.groupKey
        )
        {
          scheduleComposerFocus()
          return
        }
      }
      const resolvedModel = resolveAppModelSelectionForInstance(
        instanceId,
        settings,
        providerStatuses,
        model,
      )
      if (!resolvedModel)
      {
        scheduleComposerFocus()
        return
      }
      const nextModelSelection: ModelSelection = {
        instanceId,
        model: resolvedModel,
      }
      if (threadHasStarted(activeThread) && instanceId !== activeThread.modelSelection.instanceId)
      {
        if (providerSwitchBlockReason)
        {
          toastManager.add({
            type: 'warning',
            title: 'Provider switch unavailable',
            description: providerSwitchBlockReason,
          })
          scheduleComposerFocus()
          return
        }
        setProviderSwitchConfirmation({
          environmentId: activeThread.environmentId,
          threadId: activeThread.id,
          targetModelSelection: nextModelSelection,
          targetLabel: formatProviderSwitchTargetLabel({
            instanceId,
            displayName:
              deriveProviderInstanceEntries([entry])[0]?.displayName ?? entry.displayName,
            model: nextModelSelection.model,
          }),
          expectedCurrentInstanceId:
            currentProviderInstanceId ?? activeThread.modelSelection.instanceId,
        })
        return
      }
      const modelChangeBlockReason = getStartedThreadModelChangeBlockReason({
        providers: providerStatuses,
        hasStartedSession: activeThread.session !== null,
        currentModelSelection: activeThread.modelSelection,
        currentProviderInstanceId,
        nextModelSelection,
      })
      if (modelChangeBlockReason)
      {
        toastManager.add({
          type: 'warning',
          title: modelChangeBlockReason.title,
          description: modelChangeBlockReason.description,
        })
        scheduleComposerFocus()
        return
      }
      const targetThreadRef = scopeThreadRef(activeThread.environmentId, activeThread.id)
      // record the projection this pick replaced so the reconciliation effect
      // does not hand the thread back its older selection
      userSetComposerSelectionRef.current = {
        threadKey: scopedThreadKey(targetThreadRef),
        selection: nextModelSelection,
        supersededProjection: activeThread.modelSelection,
      }
      applyComposerModelSelection(targetThreadRef, nextModelSelection)
      scheduleComposerFocus()
    },
    [
      activeThread,
      applyComposerModelSelection,
      currentProviderInstanceId,
      lockedProvider,
      providerSwitchBlockReason,
      providerStatuses,
      scheduleComposerFocus,
      settings,
      verifiedImportProviderInstanceId,
    ],
  )

  const confirmProviderSwitch = useCallback(async () =>
  {
    const confirmation = providerSwitchConfirmation
    if (!confirmation || isSwitchingProvider)
    {
      return
    }
    const targetThreadRef = scopeThreadRef(confirmation.environmentId, confirmation.threadId)
    const targetThreadKey = scopedThreadKey(targetThreadRef)
    const targetProvider = providerStatuses.find(
      (provider) => provider.instanceId === confirmation.targetModelSelection.instanceId,
    )
    if (!targetProvider)
    {
      setProviderSwitchConfirmation(null)
      toastManager.add({
        type: 'error',
        title: 'Could not switch provider',
        description: 'The selected provider instance is no longer available.',
      })
      return
    }

    setSwitchingProviderThreadKey(targetThreadKey)
    const result = await switchThreadProvider({
      environmentId: confirmation.environmentId,
      input: {
        threadId: confirmation.threadId,
        targetModelSelection: confirmation.targetModelSelection,
        expectedCurrentInstanceId: confirmation.expectedCurrentInstanceId,
      },
    })
    // acceptance only queues the switch; the composer follows the server's
    // projected selection once the handoff completes
    if (result._tag !== 'Success' && !isAtomCommandInterrupted(result))
    {
      const error = squashAtomCommandFailure(result)
      toastManager.add(
        stackedThreadToast({
          type: 'error',
          title: 'Could not switch provider',
          description: chatActionErrorMessage(error),
        }),
      )
    }
    setProviderSwitchConfirmation((current) => (current === confirmation ? null : current))
    setSwitchingProviderThreadKey((current) => (current === targetThreadKey ? null : current))
    scheduleComposerFocus()
  }, [
    isSwitchingProvider,
    providerStatuses,
    providerSwitchConfirmation,
    scheduleComposerFocus,
    switchThreadProvider,
  ])

  const inFlightProviderSwitchTargetRef = useRef<{
    threadKey: string
    instanceId: ProviderInstanceId
    model: string | null
  } | null>(null)
  useEffect(() =>
  {
    if (activeProviderSwitch === null)
    {
      return
    }
    inFlightProviderSwitchTargetRef.current = {
      threadKey: routeThreadKey,
      instanceId: activeProviderSwitch.targetInstanceId,
      model: activeProviderSwitch.targetModel,
    }
  }, [activeProviderSwitch, routeThreadKey])

  // the retry runs long after its toast was built, so it dispatches through the
  // current selection handler. That handler re-reads the live switch block
  // reason, which keeps a retry from racing ahead of the failed projection
  // clearing this thread's providerSwitch marker.
  const onProviderModelSelectRef = useRef(onProviderModelSelect)
  useEffect(() =>
  {
    onProviderModelSelectRef.current = onProviderModelSelect
  }, [onProviderModelSelect])

  // the same handler is bound to whatever thread the route currently shows, so
  // the retry also needs the live route key to compare its captured one against
  const routeThreadKeyRef = useRef(routeThreadKey)
  useEffect(() =>
  {
    routeThreadKeyRef.current = routeThreadKey
  }, [routeThreadKey])

  // seed existing outcomes on first synchronized view so history never replays
  // as a toast
  const providerSwitchAnnouncementsRef = useRef<ProviderSwitchAnnouncementState | null>(null)
  useEffect(() =>
  {
    const decision = reconcileProviderSwitchAnnouncements({
      events: providerSwitchTimelineEvents,
      state: providerSwitchAnnouncementsRef.current,
      synchronized: threadDetailSynchronized,
      threadKey: routeThreadKey,
    })
    providerSwitchAnnouncementsRef.current = decision.state
    // the outcome belongs to the thread that was on screen when it landed;
    // scoping the toast to that ref keeps it out of every other thread's view
    const announcedThreadKey = routeThreadKey
    const announcedThreadRef = routeThreadRef
    for (const event of decision.announce)
    {
      if (event.status === 'completed')
      {
        toastManager.add(
          stackedThreadToast({
            type: 'success',
            title: 'Provider switched',
            description: event.label,
            data: { threadRef: announcedThreadRef },
          }),
        )
        continue
      }
      const retryTarget = resolveProviderSwitchRetryTarget({
        event,
        fallback: inFlightProviderSwitchTargetRef.current,
        threadKey: announcedThreadKey,
      })
      inFlightProviderSwitchTargetRef.current = null
      toastManager.add(
        stackedThreadToast({
          type: 'error',
          title: 'Provider switch failed',
          description: formatProviderSwitchFailureToastDescription({
            reasonCode: event.reasonCode,
            targetLabel: event.targetLabel,
          }),
          data: { threadRef: announcedThreadRef },
          ...(retryTarget
            ? {
                actionProps: {
                  children: 'Try again',
                  onClick: () =>
                    {
                    if (
                      !canApplyProviderSwitchRetry({
                        announcedThreadKey,
                        routeThreadKey: routeThreadKeyRef.current,
                      })
                    )
                      {
                      return
                    }
                    onProviderModelSelectRef.current(
                      retryTarget.instanceId,
                      retryTarget.model ?? '',
                    )
                  },
                },
              }
            : {}),
        }),
      )
    }
  }, [providerSwitchTimelineEvents, routeThreadKey, routeThreadRef, threadDetailSynchronized])

  const lastSyncedThreadSelectionRef = useRef<{
    threadKey: string
    selection: ModelSelection
  } | null>(null)
  const activeThreadProjectedSelection =
    routeKind === 'server' ? (activeThread?.modelSelection ?? null) : null
  const activeThreadHasStarted = routeKind === 'server' && threadHasStarted(activeThread)
  useEffect(() =>
  {
    if (activeThreadProjectedSelection === null)
    {
      lastSyncedThreadSelectionRef.current = null
      userSetComposerSelectionRef.current = null
      return
    }
    const previous = lastSyncedThreadSelectionRef.current
    lastSyncedThreadSelectionRef.current = {
      threadKey: routeThreadKey,
      selection: activeThreadProjectedSelection,
    }
    if (
      !shouldReconcileComposerDraftModelSelection({
        composerSelection: composerModelSelection,
        hasStarted: activeThreadHasStarted,
        previousProjection: previous,
        projectedSelection: activeThreadProjectedSelection,
        threadKey: routeThreadKey,
        userSetSelection: userSetComposerSelectionRef.current,
      })
    )
    {
      return
    }
    const provider = providerStatuses.find(
      (snapshot) => snapshot.instanceId === activeThreadProjectedSelection.instanceId,
    )
    if (!provider)
    {
      return
    }
    // the projection won this round, so the pick it replaced is spent
    userSetComposerSelectionRef.current = null
    applyComposerModelSelection(routeThreadRef, activeThreadProjectedSelection, {
      replaceOptions: true,
    })
  }, [
    activeThreadHasStarted,
    activeThreadProjectedSelection,
    applyComposerModelSelection,
    composerModelSelection,
    providerStatuses,
    routeThreadKey,
    routeThreadRef,
  ])

  const onInterrupt = useCallback(async () =>
  {
    if (!activeThread) return
    const result = await interruptThreadTurn({
      environmentId,
      input: buildThreadTurnInterruptInput(activeThread),
    })
    if (result._tag === 'Failure' && !isAtomCommandInterrupted(result))
    {
      const error = squashAtomCommandFailure(result)
      setThreadError(
        activeThread.id,
        chatActionErrorMessage(error, 'Failed to interrupt the current turn.'),
      )
    }
  }, [activeThread, environmentId, interruptThreadTurn, setThreadError])

  const onProviderSwitchConfirmationOpenChange = useCallback(
    (open: boolean) =>
    {
      if (!open && !isSwitchingProvider)
      {
        setProviderSwitchConfirmation(null)
      }
    },
    [isSwitchingProvider],
  )

  // ordered send/retry interaction; ports carry ChatView-owned refs/setters
  const runSend = async (
    e?: { preventDefault: () => void },
    options: { bypassPlanFollowUp?: boolean } = {},
  ): Promise<boolean> =>
  {
    e?.preventDefault()
    if (
      !activeThread ||
      isSendBusy ||
      send.isConnecting ||
      send.threadDetailLoading ||
      send.activeEnvironmentUnavailable ||
      send.sendInFlightRef.current
    )
      return false
    if (
      handleImportContinuationSendBlock(
        send.importContinuationSendBlocked,
        send.focusImportContinuationBanner,
      )
    )
    {
      return false
    }
    if (send.activePendingProgress)
    {
      send.onAdvanceActivePendingUserInput()
      return false
    }
    const sendCtx = send.composerRef.current?.getSendContext()
    if (!sendCtx?.providerAvailable) return false
    const {
      images: composerImages,
      terminalContexts: composerTerminalContexts,
      elementContexts: composerElementContexts,
      previewAnnotations: composerPreviewAnnotations,
      reviewComments: composerReviewComments,
      selectedProvider: ctxSelectedProvider,
      selectedModel: ctxSelectedModel,
      selectedProviderModels: ctxSelectedProviderModels,
      selectedPromptEffort: ctxSelectedPromptEffort,
      selectedModelSelection: ctxSelectedModelSelection,
    } = sendCtx
    const composerDraftOwnerKeyForSend = send.composerDraftOwnerKey
    const legacyOrchestrateInvocation = parseLegacyOrchestrateInvocation(send.promptRef.current)
    const interactionModeForSend =
      legacyOrchestrateInvocation === null ? send.interactionMode : 'orchestrate'
    if (legacyOrchestrateInvocation !== null)
    {
      send.handleInteractionModeChange('orchestrate')
    }
    const promptForSend = legacyOrchestrateInvocation?.prompt ?? send.promptRef.current
    const {
      trimmedPrompt: trimmed,
      sendableTerminalContexts: sendableComposerTerminalContexts,
      expiredTerminalContextCount,
      hasSendableContent,
    } = deriveComposerSendState({
      prompt: promptForSend,
      imageCount: composerImages.length,
      terminalContexts: composerTerminalContexts,
      elementContextCount:
        composerElementContexts.length +
        composerPreviewAnnotations.length +
        composerReviewComments.length,
    })
    if (!options.bypassPlanFollowUp && send.showPlanFollowUpPrompt && send.activeProposedPlan)
    {
      const draftPromptForRetry = send.promptRef.current
      const followUp = resolvePlanFollowUpSubmission({
        draftText: trimmed,
        planMarkdown: send.activeProposedPlan.planMarkdown,
      })
      send.promptRef.current = ''
      send.clearComposerDraftContent(send.composerDraftTarget)
      send.composerRef.current?.resetCursorState()
      const sent = await send.onSubmitPlanFollowUp({
        text: followUp.text,
        interactionMode: followUp.interactionMode,
      })
      if (!sent)
      {
        const retryDraft = useComposerDraftStore
          .getState()
          .getComposerDraft(send.composerDraftTarget)
        if ((retryDraft?.prompt.length ?? 0) === 0)
        {
          send.setComposerDraftPrompt(send.composerDraftTarget, draftPromptForRetry)
        }
        if (
          send.composerDraftOwnerKeyRef.current === composerDraftOwnerKeyForSend &&
          send.promptRef.current.length === 0
        )
        {
          send.promptRef.current = draftPromptForRetry
          send.composerRef.current?.resetCursorState({
            cursor: collapseExpandedComposerCursor(draftPromptForRetry, draftPromptForRetry.length),
            prompt: draftPromptForRetry,
            detectTrigger: true,
          })
        }
      }
      return false
    }
    const standaloneSlashCommand =
      composerImages.length === 0 &&
      sendableComposerTerminalContexts.length === 0 &&
      composerElementContexts.length === 0 &&
      composerPreviewAnnotations.length === 0 &&
      composerReviewComments.length === 0
        ? parseStandaloneComposerSlashCommand(trimmed)
        : null
    if (standaloneSlashCommand)
    {
      send.handleInteractionModeChange(standaloneSlashCommand)
      send.promptRef.current = ''
      send.clearComposerDraftContent(send.composerDraftTarget)
      send.composerRef.current?.resetCursorState()
      return false
    }
    if (legacyOrchestrateInvocation !== null && !hasSendableContent)
    {
      send.promptRef.current = ''
      send.clearComposerDraftContent(send.composerDraftTarget)
      send.composerRef.current?.resetCursorState()
      return false
    }
    if (!hasSendableContent)
    {
      if (expiredTerminalContextCount > 0)
      {
        const toastCopy = buildExpiredTerminalContextToastCopy(expiredTerminalContextCount, 'empty')
        toastManager.add(
          stackedThreadToast({
            type: 'warning',
            title: toastCopy.title,
            description: toastCopy.description,
          }),
        )
      }
      return false
    }
    if (!send.activeProject)
    {
      toastManager.add(
        stackedThreadToast({
          type: 'warning',
          title: 'Choose a project first',
          description: 'This draft no longer points to an available project.',
        }),
      )
      return false
    }
    const activeProject = send.activeProject
    const threadIdForSend = activeThread.id
    const isFirstMessage = !send.isServerThread || activeThread.messages.length === 0
    const baseBranchForWorktree =
      isFirstMessage && send.sendEnvMode === 'worktree' && !activeThread.worktreePath
        ? send.activeThreadBranch
        : null

    // in worktree mode, require an explicit base branch so we don't silently
    // fall back to local execution when branch selection is missing.
    const shouldCreateWorktree =
      isFirstMessage && send.sendEnvMode === 'worktree' && !activeThread.worktreePath
    if (shouldCreateWorktree && !send.activeThreadBranch)
    {
      setThreadError(threadIdForSend, 'Select a base branch before sending in New worktree mode.')
      return false
    }

    send.sendInFlightRef.current = true
    if (send.isDraftHeroState && send.activeThreadKey)
    {
      let resolveDockStarted: (() => void) | undefined
      const dockStarted = new Promise<void>((resolve) =>
      {
        resolveDockStarted = resolve
      })
      const dockTransition = send.runMobileComposerTransition(() =>
      {
        flushSync(() =>
        {
          send.captureDraftHeroComposerRect()
          send.setDockedDraftHeroThreadKey(send.activeThreadKey)
        })
        resolveDockStarted?.()
      })
      void dockTransition.catch(() => resolveDockStarted?.())
      await dockStarted
    }
    send.beginLocalDispatch({ preparingWorktree: Boolean(baseBranchForWorktree) })

    const composerImagesSnapshot = [...composerImages]
    const composerTerminalContextsSnapshot = [...sendableComposerTerminalContexts]
    const composerElementContextsSnapshot = [...composerElementContexts]
    const composerPreviewAnnotationsSnapshot = [...composerPreviewAnnotations]
    const composerReviewCommentsSnapshot: ReviewCommentContext[] = [...composerReviewComments]
    // this append order is the exact inverse of the TimelineRows peel order;
    // reordering only one side leaves raw context blocks visible (megacore U-125)
    const messageTextWithContexts = appendElementContextsToPrompt(
      appendTerminalContextsToPrompt(promptForSend, composerTerminalContextsSnapshot),
      composerElementContextsSnapshot,
    )
    const messageTextWithPreviewAnnotations = composerPreviewAnnotationsSnapshot.reduce(
      (text, annotation) => appendPreviewAnnotationPrompt(text, annotation),
      messageTextWithContexts,
    )
    const messageTextForSend = appendReviewCommentsToPrompt(
      messageTextWithPreviewAnnotations,
      composerReviewCommentsSnapshot,
    )
    const messageIdForSend = newMessageId()
    const messageCreatedAt = new Date().toISOString()
    const outgoingMessageText = formatOutgoingPrompt({
      provider: ctxSelectedProvider,
      model: ctxSelectedModel,
      models: ctxSelectedProviderModels,
      effort: ctxSelectedPromptEffort,
      text: messageTextForSend || IMAGE_ONLY_BOOTSTRAP_PROMPT,
    })
    const turnAttachmentsPromise = Promise.all(
      composerImagesSnapshot.map(async (image) => ({
        type: 'image' as const,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        dataUrl: await readFileAsDataUrl(image.file),
      })),
    )
    const optimisticAttachments = composerImagesSnapshot.map((image) => ({
      type: 'image' as const,
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      previewUrl: image.previewUrl,
    }))
    // sending always returns to the live edge. The new row becomes the
    // anchored end-space target so it lands near the top while the response
    // streams into the reserved space below it.
    send.isAtEndRef.current = true
    send.timelineScrollModeRef.current = 'anchoring-new-turn'
    send.liveFollowUserScrollGenerationRef.current = send.anchorUserScrollGenerationRef.current
    send.pendingTimelineAnchorRef.current = messageIdForSend
    send.activeTimelineAnchorIndexRef.current = null
    send.showScrollDebouncer.current.cancel()
    send.setShowScrollToBottom(false)
    send.setTimelineAnchor({
      threadKey: scopedThreadKey(scopeThreadRef(activeThread.environmentId, threadIdForSend)),
      messageId: messageIdForSend,
    })
    send.setOptimisticUserMessages((existing) => [
      ...existing,
      {
        id: messageIdForSend,
        role: 'user',
        text: outgoingMessageText,
        ...(optimisticAttachments.length > 0 ? { attachments: optimisticAttachments } : {}),
        turnId: null,
        createdAt: messageCreatedAt,
        updatedAt: messageCreatedAt,
        streaming: false,
      },
    ])
    setThreadError(threadIdForSend, null)
    if (expiredTerminalContextCount > 0)
    {
      const toastCopy = buildExpiredTerminalContextToastCopy(expiredTerminalContextCount, 'omitted')
      toastManager.add(
        stackedThreadToast({
          type: 'warning',
          title: toastCopy.title,
          description: toastCopy.description,
        }),
      )
    }
    send.promptRef.current = ''
    send.clearComposerDraftContent(send.composerDraftTarget)
    send.composerRef.current?.resetCursorState()

    let firstComposerImageName: string | null = null
    if (composerImagesSnapshot.length > 0)
    {
      const firstComposerImage = composerImagesSnapshot[0]
      if (firstComposerImage)
      {
        firstComposerImageName = firstComposerImage.name
      }
    }
    let titleSeed = trimmed
    if (!titleSeed)
    {
      if (firstComposerImageName)
      {
        titleSeed = `Image: ${firstComposerImageName}`
      }
      else if (composerTerminalContextsSnapshot.length > 0)
      {
        titleSeed = formatTerminalContextLabel(composerTerminalContextsSnapshot[0]!)
      }
      else if (composerElementContextsSnapshot.length > 0)
      {
        titleSeed = formatElementContextLabel(composerElementContextsSnapshot[0]!)
      }
      else
      {
        titleSeed = 'New thread'
      }
    }
    const title = truncate(titleSeed)
    const threadCreateModelSelection = createModelSelection(
      ctxSelectedModelSelection.instanceId,
      ctxSelectedModel || activeProject.defaultModelSelection?.model || DEFAULT_MODEL,
      ctxSelectedModelSelection.options,
    )

    let failure: AtomCommandResult<unknown, unknown> | null = null
    // auto-title from first message
    if (isFirstMessage && send.isServerThread)
    {
      const titleResult = await send.updateThreadMetadata({
        environmentId,
        input: {
          threadId: threadIdForSend,
          title,
        },
      })
      if (titleResult._tag === 'Failure')
      {
        failure = titleResult
      }
    }

    if (failure === null && send.isServerThread)
    {
      const settingsResult = await send.persistThreadSettingsForNextTurn({
        threadId: threadIdForSend,
        createdAt: messageCreatedAt,
        ...(ctxSelectedModel ? { modelSelection: ctxSelectedModelSelection } : {}),
        ...(send.localCheckoutBranchMismatch
          ? { branch: send.localCheckoutBranchMismatch.currentBranch }
          : {}),
        runtimeMode: send.runtimeMode,
        interactionMode: interactionModeForSend,
      })
      if (settingsResult._tag === 'Failure')
      {
        failure = settingsResult
      }
    }

    const turnAttachmentsResult = await settlePromise(() => turnAttachmentsPromise)
    if (failure === null && turnAttachmentsResult._tag === 'Failure')
    {
      failure = turnAttachmentsResult
    }

    let turnStartSucceeded = false
    if (failure === null && turnAttachmentsResult._tag === 'Success')
    {
      const bootstrap =
        send.isLocalDraftThread || baseBranchForWorktree
          ? {
              ...(send.isLocalDraftThread
                ? {
                    createThread: {
                      projectId: activeProject.id,
                      title,
                      modelSelection: threadCreateModelSelection,
                      runtimeMode: send.runtimeMode,
                      interactionMode: interactionModeForSend,
                      branch: send.activeThreadBranch,
                      worktreePath: activeThread.worktreePath,
                      createdAt: activeThread.createdAt,
                    },
                  }
                : {}),
              ...(baseBranchForWorktree
                ? {
                    prepareWorktree: {
                      projectCwd: activeProject.workspaceRoot,
                      baseBranch: baseBranchForWorktree,
                      branch: buildTemporaryWorktreeBranchName(randomHex),
                      ...(send.startFromOrigin ? { startFromOrigin: true as const } : {}),
                    },
                    runSetupScript: true as const,
                  }
                : {}),
            }
          : undefined
      send.beginLocalDispatch({ preparingWorktree: false })
      const startResult = await send.startThreadTurn({
        environmentId,
        input: {
          threadId: threadIdForSend,
          message: {
            messageId: messageIdForSend,
            role: 'user',
            text: outgoingMessageText,
            attachments: turnAttachmentsResult.value,
          },
          modelSelection: ctxSelectedModelSelection,
          titleSeed: title,
          runtimeMode: send.runtimeMode,
          interactionMode: interactionModeForSend,
          ...(bootstrap ? { bootstrap } : {}),
          ...(send.importContinuationConsent
            ? { importContinuationConsent: send.importContinuationConsent }
            : {}),
          createdAt: messageCreatedAt,
        },
      })
      if (startResult._tag === 'Failure')
      {
        failure = startResult
      }
      else
      {
        turnStartSucceeded = true
      }
    }

    if (failure !== null)
    {
      const retryDraft = useComposerDraftStore.getState().getComposerDraft(send.composerDraftTarget)
      const retryDraftIsEmpty =
        retryDraft === null ||
        (retryDraft.prompt.length === 0 &&
          retryDraft.images.length === 0 &&
          retryDraft.terminalContexts.length === 0 &&
          retryDraft.elementContexts.length === 0 &&
          retryDraft.previewAnnotations.length === 0 &&
          retryDraft.reviewComments.length === 0)
      const composerOwnerIsCurrent =
        send.composerDraftOwnerKeyRef.current === composerDraftOwnerKeyForSend
      if (
        shouldRestoreComposerDraftAfterSendFailure({
          retryDraftIsEmpty,
          composerOwnerIsCurrent,
          promptEmpty: send.promptRef.current.length === 0,
          imagesEmpty: send.composerImagesRef.current.length === 0,
          terminalContextsEmpty: send.composerTerminalContextsRef.current.length === 0,
          elementContextsEmpty: send.composerElementContextsRef.current.length === 0,
        })
      )
      {
        send.setOptimisticUserMessages((existing) =>
        {
          const removed = existing.filter((message) => message.id === messageIdForSend)
          for (const message of removed)
          {
            revokeUserMessagePreviewUrls(message)
          }
          const next = existing.filter((message) => message.id !== messageIdForSend)
          return next.length === existing.length ? existing : next
        })
        const retryComposerImages = composerImagesSnapshot.map(cloneComposerImageForRetry)
        send.setComposerDraftPrompt(send.composerDraftTarget, promptForSend)
        send.addComposerDraftImages(send.composerDraftTarget, retryComposerImages)
        send.setComposerDraftTerminalContexts(
          send.composerDraftTarget,
          composerTerminalContextsSnapshot,
        )
        send.setComposerDraftElementContexts(
          send.composerDraftTarget,
          composerElementContextsSnapshot,
        )
        send.setComposerDraftPreviewAnnotations(
          send.composerDraftTarget,
          composerPreviewAnnotationsSnapshot,
        )
        send.setComposerDraftReviewComments(
          send.composerDraftTarget,
          composerReviewCommentsSnapshot,
        )
        if (composerOwnerIsCurrent)
        {
          send.promptRef.current = promptForSend
          send.composerImagesRef.current = retryComposerImages
          send.composerTerminalContextsRef.current = composerTerminalContextsSnapshot
          send.composerElementContextsRef.current = composerElementContextsSnapshot
          send.composerRef.current?.resetCursorState({
            cursor: collapseExpandedComposerCursor(promptForSend, promptForSend.length),
            prompt: promptForSend,
            detectTrigger: true,
          })
        }
      }
      if (!isAtomCommandInterrupted(failure))
      {
        const error = squashAtomCommandFailure(failure)
        setThreadError(
          threadIdForSend,
          error instanceof Error ? error.message : 'Failed to send message.',
        )
      }
    }
    send.sendInFlightRef.current = false
    if (!turnStartSucceeded)
    {
      send.setDockedDraftHeroThreadKey((currentThreadKey) =>
        currentThreadKey === send.activeThreadKey ? null : currentThreadKey,
      )
      send.resetLocalDispatch()
    }
    return turnStartSucceeded
  }
  const runSendRef = useRef(runSend)
  runSendRef.current = runSend
  const dispatchSend = useCallback(
    (
      e?: { preventDefault: () => void },
      options?: { bypassPlanFollowUp?: boolean },
    ): Promise<boolean> => runSendRef.current(e, options),
    [],
  )
  const onSend = useCallback(
    (e?: { preventDefault: () => void }): Promise<boolean> => dispatchSend(e),
    [dispatchSend],
  )

  return {
    activeProviderSwitch,
    activeProviderSwitchTarget,
    activeProviderSwitchTargetLabel,
    composerProviderSwitch,
    confirmProviderSwitch,
    dispatchSend,
    getModelDisabledReason,
    isSwitchingProvider,
    onInterrupt,
    onProviderModelSelect,
    onProviderSwitchConfirmationOpenChange,
    onSend,
    providerSwitchConfirmation,
  }
}
