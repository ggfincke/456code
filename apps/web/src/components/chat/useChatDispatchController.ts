// apps/web/src/components/chat/useChatDispatchController.ts
// coordinates draft promotion, send/retry, interruption, and provider handoff

import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from '@t3tools/client-runtime/state/runtime'
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from '@t3tools/client-runtime/environment'
import { wasBootstrapThreadDeleted } from '@t3tools/client-runtime/errors'
import {
  DEFAULT_MODEL,
  type CollaborationMode,
  type EnvironmentId,
  type MessageId,
  type ModelSelection,
  type PreviewAnnotationPayload,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type ProviderRuntimeModeWarning,
  type ProviderRuntimeModeWarningId,
  type RuntimeMode,
  type ScopedThreadRef,
  type ServerProvider,
  type ThreadId,
  type ThreadImportContinuationConsent,
} from '@t3tools/contracts'
import type { UnifiedSettings } from '@t3tools/contracts/settings'
import { isBareKnownProviderSlashCommand } from '@t3tools/shared/composerTrigger'
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
  isComposerProviderInstanceChange,
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
  resolveComposerDispatchMode,
  resolveComposerSlashCommandMode,
} from '~/composer-logic'
import type {
  ArchitectureConcernContext,
  ComposerImageAttachment,
  DraftId,
  DraftThreadEnvMode,
} from '~/composerDraftStore'
import { useComposerDraftStore } from '~/composerDraftStore'

type ComposerThreadTarget = ScopedThreadRef | DraftId
import {
  appendElementContextsToPrompt,
  formatElementContextLabel,
  type ElementContextDraft,
} from '~/lib/elementContext'
import { appendPreviewAnnotationPrompt } from '~/lib/previewAnnotation'
import {
  appendArchitectureContextsToPrompt,
  formatArchitectureConcernLabel,
} from '~/composer-drafts/architectureContext'
import {
  appendTerminalContextsToPrompt,
  formatTerminalContextLabel,
  type TerminalContextDraft,
} from '~/lib/terminalContext'
import { appendReviewCommentsToPrompt, type ReviewCommentContext } from '~/reviewCommentContext'
import { resolveAppModelSelectionForInstance } from '~/modelSelection'
import { newMessageId, newThreadId, randomHex } from '~/lib/utils'
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
import { blockUnknownComposerSlashCommand } from './composer/composerSlashCommandValidation'
import type { TimelineScrollMode } from './messages-timeline/timelineScrollAnchoring'
import { resolveRuntimeModeStartWarnings } from './runtimeModeWarnings'
import { resolvePlanFollowUpSubmission, type PlanImplementVariant } from '~/proposedPlan'

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
    readonly runtimeModeAcknowledgements?: ReadonlyArray<ProviderRuntimeModeWarningId>
    readonly interactionMode: ProviderInteractionMode
    readonly orchestrate: boolean
    readonly bootstrap?: {
      readonly createThread?: {
        readonly projectId: Project['id']
        readonly title: string
        readonly modelSelection: ModelSelection
        readonly runtimeMode: RuntimeMode
        readonly interactionMode: ProviderInteractionMode
        readonly orchestrate: boolean
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
  readonly handleInteractionModeChange: (mode: CollaborationMode) => void
  readonly importContinuationConsent: ThreadImportContinuationConsent | null | undefined
  readonly importContinuationSendBlocked: boolean
  readonly collaborationMode: CollaborationMode
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
    collaborationMode: CollaborationMode
    runtimeModeAcknowledgements?: ReadonlyArray<ProviderRuntimeModeWarningId>
  }) => Promise<boolean>
  readonly pendingTimelineAnchorRef: MutableRefObject<MessageId | null>
  readonly persistThreadSettingsForNextTurn: (input: {
    threadId: ThreadId
    createdAt: string
    modelSelection?: ModelSelection
    branch?: string
    runtimeMode: RuntimeMode
    collaborationMode: CollaborationMode
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
  readonly setComposerDraftArchitectureContexts: (
    target: ComposerThreadTarget,
    contexts: ArchitectureConcernContext[],
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
  readonly targetDefaultRuntimeMode?: RuntimeMode
}

interface RuntimeModeWarningConfirmation
{
  readonly environmentId: EnvironmentId
  readonly threadId: ThreadId
  readonly targetModelSelection: ModelSelection
  readonly runtimeMode: RuntimeMode
  readonly warning: ProviderRuntimeModeWarning
  readonly confirmedIds: ReadonlyArray<ProviderRuntimeModeWarningId>
  readonly sendOptions: ChatDispatchSendOptions
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
    opts?: { readonly replaceOptions?: boolean; readonly explicit?: boolean },
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

interface ChatDispatchSendOptions
{
  readonly bypassPlanFollowUp?: boolean
  readonly planImplementVariant?: PlanImplementVariant
  readonly providerSlashCommand?: string
  readonly runtimeModeAcknowledgements?: ReadonlyArray<ProviderRuntimeModeWarningId>
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
  const [runtimeModeWarningConfirmation, setRuntimeModeWarningConfirmation] =
    useState<RuntimeModeWarningConfirmation | null>(null)
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
      opts?: { readonly replaceOptions?: boolean; readonly explicit?: boolean },
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
          ...(entry.capabilities?.defaultRuntimeMode
            ? { targetDefaultRuntimeMode: entry.capabilities.defaultRuntimeMode }
            : {}),
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
      if (
        isComposerProviderInstanceChange({
          composerSelection: composerModelSelection,
          hasStarted: threadHasStarted(activeThread),
          nextInstanceId: instanceId,
          projectedSelection: activeThread.modelSelection,
        }) &&
        entry.capabilities?.defaultRuntimeMode
      )
      {
        useComposerDraftStore
          .getState()
          .setRuntimeMode(targetThreadRef, entry.capabilities.defaultRuntimeMode)
      }
      applyComposerModelSelection(targetThreadRef, nextModelSelection, { explicit: true })
      scheduleComposerFocus()
    },
    [
      activeThread,
      applyComposerModelSelection,
      currentProviderInstanceId,
      composerModelSelection,
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
    if (result._tag === 'Success' && confirmation.targetDefaultRuntimeMode)
    {
      useComposerDraftStore
        .getState()
        .setRuntimeMode(targetThreadRef, confirmation.targetDefaultRuntimeMode)
    }
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
    options: ChatDispatchSendOptions = {},
  ): Promise<boolean> =>
  {
    e?.preventDefault()
    const directProviderSlashCommand = options.providerSlashCommand?.trim() ?? null
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
      if (directProviderSlashCommand !== null)
      {
        return false
      }
      send.onAdvanceActivePendingUserInput()
      return false
    }
    const sendCtx = send.composerRef.current?.getSendContext()
    if (!sendCtx?.providerAvailable) return false
    const {
      images: sendContextComposerImages,
      terminalContexts: sendContextComposerTerminalContexts,
      elementContexts: sendContextComposerElementContexts,
      previewAnnotations: sendContextComposerPreviewAnnotations,
      architectureContexts: sendContextComposerArchitectureContexts,
      reviewComments: sendContextComposerReviewComments,
      selectedProvider: ctxSelectedProvider,
      selectedModel: ctxSelectedModel,
      selectedProviderModels: ctxSelectedProviderModels,
      selectedPromptEffort: ctxSelectedPromptEffort,
      selectedModelSelection: ctxSelectedModelSelection,
      selectedProviderSlashCommands: ctxSelectedProviderSlashCommands,
      selectedProviderCapabilities: ctxSelectedProviderCapabilities,
      runtimeMode: dispatchRuntimeMode,
    } = sendCtx
    const runtimeModeWarningResolution = resolveRuntimeModeStartWarnings({
      capabilities: ctxSelectedProviderCapabilities,
      confirmedIds: options.runtimeModeAcknowledgements ?? [],
      currentModelSelection: activeThread.modelSelection,
      session: activeThread.session,
      targetModelSelection: ctxSelectedModelSelection,
      runtimeMode: dispatchRuntimeMode,
    })
    if (runtimeModeWarningResolution.missingWarning !== null)
    {
      setRuntimeModeWarningConfirmation({
        environmentId: activeThread.environmentId,
        threadId: activeThread.id,
        targetModelSelection: ctxSelectedModelSelection,
        runtimeMode: dispatchRuntimeMode,
        warning: runtimeModeWarningResolution.missingWarning,
        confirmedIds: runtimeModeWarningResolution.acknowledgements,
        sendOptions: options,
      })
      return false
    }
    const promptForDispatch = directProviderSlashCommand ?? sendCtx.prompt
    if (
      directProviderSlashCommand !== null &&
      !isBareKnownProviderSlashCommand(directProviderSlashCommand, ctxSelectedProviderSlashCommands)
    )
    {
      return false
    }
    if (blockUnknownComposerSlashCommand(promptForDispatch, ctxSelectedProviderSlashCommands))
    {
      return false
    }
    const composerImages = directProviderSlashCommand === null ? sendContextComposerImages : []
    const composerTerminalContexts =
      directProviderSlashCommand === null ? sendContextComposerTerminalContexts : []
    const composerElementContexts =
      directProviderSlashCommand === null ? sendContextComposerElementContexts : []
    const composerPreviewAnnotations =
      directProviderSlashCommand === null ? sendContextComposerPreviewAnnotations : []
    const composerArchitectureContexts =
      directProviderSlashCommand === null ? sendContextComposerArchitectureContexts : []
    const composerReviewComments =
      directProviderSlashCommand === null ? sendContextComposerReviewComments : []
    const composerDraftOwnerKeyForSend = send.composerDraftOwnerKey
    const legacyOrchestrateInvocation = parseLegacyOrchestrateInvocation(promptForDispatch)
    const dispatchMode = resolveComposerDispatchMode(
      send.collaborationMode,
      legacyOrchestrateInvocation !== null,
    )
    const collaborationModeForSend = dispatchMode.collaborationMode
    if (legacyOrchestrateInvocation !== null)
    {
      send.handleInteractionModeChange(collaborationModeForSend)
    }
    const promptForSend = legacyOrchestrateInvocation?.prompt ?? promptForDispatch
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
        composerArchitectureContexts.length +
        composerReviewComments.length,
    })
    if (legacyOrchestrateInvocation !== null && !hasSendableContent)
    {
      send.promptRef.current = ''
      send.clearComposerDraftContent(send.composerDraftTarget)
      send.composerRef.current?.resetCursorState()
      return false
    }
    const standaloneSlashCommand =
      composerImages.length === 0 &&
      sendableComposerTerminalContexts.length === 0 &&
      composerElementContexts.length === 0 &&
      composerPreviewAnnotations.length === 0 &&
      composerArchitectureContexts.length === 0 &&
      composerReviewComments.length === 0
        ? parseStandaloneComposerSlashCommand(trimmed)
        : null
    if (standaloneSlashCommand)
    {
      send.handleInteractionModeChange(
        resolveComposerSlashCommandMode(send.collaborationMode, standaloneSlashCommand),
      )
      send.promptRef.current = ''
      send.clearComposerDraftContent(send.composerDraftTarget)
      send.composerRef.current?.resetCursorState()
      return false
    }
    if (
      directProviderSlashCommand === null &&
      !options.bypassPlanFollowUp &&
      send.showPlanFollowUpPrompt &&
      send.activeProposedPlan &&
      composerArchitectureContexts.length === 0
    )
    {
      const draftPromptForRetry = send.promptRef.current
      const followUp = resolvePlanFollowUpSubmission({
        draftText: trimmed,
        planMarkdown: send.activeProposedPlan.planMarkdown,
        currentMode: collaborationModeForSend,
        ...(options.planImplementVariant ? { implementVariant: options.planImplementVariant } : {}),
      })
      const outgoingFollowUpText = formatOutgoingPrompt({
        provider: ctxSelectedProvider,
        model: ctxSelectedModel,
        models: ctxSelectedProviderModels,
        effort: ctxSelectedPromptEffort,
        text: followUp.text.trim(),
      })
      if (send.composerRef.current?.validateProviderInput(outgoingFollowUpText) === false)
      {
        return false
      }
      send.promptRef.current = ''
      send.clearComposerDraftContent(send.composerDraftTarget)
      send.composerRef.current?.resetCursorState()
      const sent = await send.onSubmitPlanFollowUp({
        text: followUp.text,
        collaborationMode: followUp.collaborationMode,
        ...(runtimeModeWarningResolution.acknowledgements.length > 0
          ? {
              runtimeModeAcknowledgements: runtimeModeWarningResolution.acknowledgements,
            }
          : {}),
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

    const composerImagesSnapshot = [...composerImages]
    const composerTerminalContextsSnapshot = [...sendableComposerTerminalContexts]
    const composerElementContextsSnapshot = [...composerElementContexts]
    const composerPreviewAnnotationsSnapshot = [...composerPreviewAnnotations]
    const composerArchitectureContextsSnapshot = [...composerArchitectureContexts]
    const composerReviewCommentsSnapshot: ReviewCommentContext[] = [...composerReviewComments]
    const hasAttachmentsOrContext =
      composerImagesSnapshot.length > 0 ||
      composerTerminalContextsSnapshot.length > 0 ||
      composerElementContextsSnapshot.length > 0 ||
      composerPreviewAnnotationsSnapshot.length > 0 ||
      composerArchitectureContextsSnapshot.length > 0 ||
      composerReviewCommentsSnapshot.length > 0
    const isBareProviderSlashCommandForSend =
      !hasAttachmentsOrContext &&
      isBareKnownProviderSlashCommand(promptForSend, ctxSelectedProviderSlashCommands)
    let messageTextForSend = promptForSend.trim()
    // this append order is the exact inverse of the TimelineRows peel order;
    // reordering only one side leaves raw context blocks visible (megacore U-125)
    if (!isBareProviderSlashCommandForSend)
    {
      const messageTextWithContexts = appendElementContextsToPrompt(
        appendTerminalContextsToPrompt(promptForSend, composerTerminalContextsSnapshot),
        composerElementContextsSnapshot,
      )
      const messageTextWithPreviewAnnotations = composerPreviewAnnotationsSnapshot.reduce(
        (text, annotation) => appendPreviewAnnotationPrompt(text, annotation),
        messageTextWithContexts,
      )
      const messageTextWithArchitectureContexts = appendArchitectureContextsToPrompt(
        messageTextWithPreviewAnnotations,
        composerArchitectureContextsSnapshot,
      )
      messageTextForSend = appendReviewCommentsToPrompt(
        messageTextWithArchitectureContexts,
        composerReviewCommentsSnapshot,
      )
    }
    const outgoingMessageText = formatOutgoingPrompt({
      provider: ctxSelectedProvider,
      model: ctxSelectedModel,
      models: ctxSelectedProviderModels,
      effort: ctxSelectedPromptEffort,
      text: messageTextForSend || IMAGE_ONLY_BOOTSTRAP_PROMPT,
      providerSlashCommands: ctxSelectedProviderSlashCommands,
      hasAttachmentsOrContext,
    })
    if (send.composerRef.current?.validateProviderInput(outgoingMessageText) === false)
    {
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

    const messageIdForSend = newMessageId()
    const messageCreatedAt = new Date().toISOString()
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
    if (directProviderSlashCommand === null)
    {
      send.promptRef.current = ''
      send.clearComposerDraftContent(send.composerDraftTarget)
      send.composerRef.current?.resetCursorState()
    }

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
      else if (composerArchitectureContextsSnapshot.length > 0)
      {
        titleSeed = formatArchitectureConcernLabel(composerArchitectureContextsSnapshot[0]!)
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
        runtimeMode: dispatchRuntimeMode,
        collaborationMode: collaborationModeForSend,
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
                      runtimeMode: dispatchRuntimeMode,
                      interactionMode: dispatchMode.interactionMode,
                      orchestrate: dispatchMode.orchestrate,
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
          runtimeMode: dispatchRuntimeMode,
          ...(runtimeModeWarningResolution.acknowledgements.length > 0
            ? {
                runtimeModeAcknowledgements: runtimeModeWarningResolution.acknowledgements,
              }
            : {}),
          interactionMode: dispatchMode.interactionMode,
          orchestrate: dispatchMode.orchestrate,
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
      if (directProviderSlashCommand !== null)
      {
        send.setOptimisticUserMessages((existing) =>
          existing.filter((message) => message.id !== messageIdForSend),
        )
      }
      const retryDraft = useComposerDraftStore.getState().getComposerDraft(send.composerDraftTarget)
      const retryDraftIsEmpty =
        retryDraft === null ||
        (retryDraft.prompt.length === 0 &&
          retryDraft.images.length === 0 &&
          retryDraft.terminalContexts.length === 0 &&
          retryDraft.elementContexts.length === 0 &&
          retryDraft.previewAnnotations.length === 0 &&
          retryDraft.architectureContexts.length === 0 &&
          retryDraft.reviewComments.length === 0)
      const composerOwnerIsCurrent =
        send.composerDraftOwnerKeyRef.current === composerDraftOwnerKeyForSend
      if (
        directProviderSlashCommand === null &&
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
        send.setComposerDraftArchitectureContexts(
          send.composerDraftTarget,
          composerArchitectureContextsSnapshot,
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
        // the server rolled this bootstrap thread back; rotate the draft onto a
        // fresh thread id so retrying does not send into a deleted thread
        if (
          send.isLocalDraftThread &&
          typeof send.composerDraftTarget === 'string' &&
          wasBootstrapThreadDeleted(error)
        )
        {
          const failedDraftSession = useComposerDraftStore
            .getState()
            .getDraftSession(send.composerDraftTarget)
          if (failedDraftSession?.threadId === threadIdForSend)
          {
            useComposerDraftStore
              .getState()
              .setLogicalProjectDraftThreadId(
                failedDraftSession.logicalProjectKey,
                scopeProjectRef(failedDraftSession.environmentId, failedDraftSession.projectId),
                send.composerDraftTarget,
                {
                  threadId: newThreadId(),
                  createdAt: new Date().toISOString(),
                },
              )
          }
        }
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
    (e?: { preventDefault: () => void }, options?: ChatDispatchSendOptions): Promise<boolean> =>
      runSendRef.current(e, options),
    [],
  )
  const onSend = useCallback(
    (e?: { preventDefault: () => void }): Promise<boolean> => dispatchSend(e),
    [dispatchSend],
  )

  const confirmRuntimeModeWarning = useCallback((): void =>
  {
    const confirmation = runtimeModeWarningConfirmation
    const currentContext = send.composerRef.current?.getSendContext()
    if (
      confirmation === null ||
      activeThread === null ||
      currentContext === undefined ||
      activeThread.environmentId !== confirmation.environmentId ||
      activeThread.id !== confirmation.threadId ||
      currentContext.selectedModelSelection.instanceId !==
        confirmation.targetModelSelection.instanceId ||
      currentContext.selectedModelSelection.model !== confirmation.targetModelSelection.model ||
      currentContext.runtimeMode !== confirmation.runtimeMode
    )
    {
      setRuntimeModeWarningConfirmation(null)
      return
    }
    setRuntimeModeWarningConfirmation(null)
    void dispatchSend(undefined, {
      ...confirmation.sendOptions,
      runtimeModeAcknowledgements: [...confirmation.confirmedIds, confirmation.warning.id],
    })
  }, [activeThread, dispatchSend, runtimeModeWarningConfirmation, send.composerRef])

  const onRuntimeModeWarningConfirmationOpenChange = useCallback((open: boolean): void =>
  {
    if (!open)
    {
      setRuntimeModeWarningConfirmation(null)
    }
  }, [])

  return {
    activeProviderSwitch,
    activeProviderSwitchTarget,
    activeProviderSwitchTargetLabel,
    composerProviderSwitch,
    confirmProviderSwitch,
    confirmRuntimeModeWarning,
    dispatchSend,
    getModelDisabledReason,
    isSwitchingProvider,
    // the orchestrate plan card pins the lead's own binding as a row, and it
    // must agree with the composer mid-handoff instead of recomputing the rule
    leadProviderInstanceId: currentProviderInstanceId,
    onInterrupt,
    onProviderModelSelect,
    onProviderSwitchConfirmationOpenChange,
    onRuntimeModeWarningConfirmationOpenChange,
    onSend,
    providerSwitchConfirmation,
    runtimeModeWarningConfirmation,
  }
}
