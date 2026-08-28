// apps/web/src/components/chat/composer/ChatComposer.tsx
// renders composer input, provider controls, and guarded submission actions
import type {
  ApprovalRequestId,
  CollaborationMode,
  EnvironmentId,
  ModelSelection,
  ProviderApprovalDecision,
  ResolvedKeybindingsConfig,
  RuntimeMode,
  ScopedThreadRef,
  ServerProvider,
  ThreadId,
  TurnId,
} from '@t3tools/contracts'
import {
  CONSERVATIVE_PROVIDER_RUNTIME_CAPABILITIES,
  isProviderSendTurnSupportedImageMimeType,
  normalizeCollaborationMode,
  ProviderDriverKind,
  ProviderInstanceId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from '@t3tools/contracts'
import type { EnvironmentConnectionPresentation } from '@t3tools/client-runtime/connection'
import { serializeComposerFileLink } from '@t3tools/shared/composerTrigger'
import { createModelSelection, normalizeModelSlug } from '@t3tools/shared/model'
import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  clampCollapsedComposerCursor,
  type ComposerTrigger,
  collapseExpandedComposerCursor,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  replaceTextRange,
  resolveComposerSlashCommandMode,
  shouldSubmitComposerOnEnter,
} from '../../../composer-logic'
import { DISCONNECTED_COMPOSER_PLACEHOLDER } from '../../../composerPlaceholder'
import { deriveComposerSendState, readFileAsDataUrl, threadHasStarted } from '../../ChatView.logic'
import {
  dataTransferHasComposerMention,
  makeComposerMentionDragHandlers,
} from './composerMentionDrag'
import {
  type ComposerImageAttachment,
  type DraftId,
  type PersistedComposerImageAttachment,
  hydrateImagesFromPersisted,
  useComposerDraftStore,
  useComposerThreadDraft,
  useEffectiveComposerModelState,
} from '../../../composerDraftStore'
import {
  EMPTY_PROMPT_STASH_QUEUE,
  MAX_STASH_ENTRIES_PER_QUEUE,
  partitionStashAttachments,
  promptStashScopeKey,
  usePromptStashStore,
  type PromptStashEntry,
} from '../../../promptStashStore'
import { ComposerStashBadge } from './ComposerStashBadge'
import { ComposerStashMenu } from './ComposerStashMenu'
import {
  compressImageForStash,
  isHeicImageFile,
  prepareImageForAttachment,
} from '../../../lib/imageCompression'
import { isCommandPaletteOpen } from '../../../commandPaletteBus'
import { getTerminalFocusOwner } from '../../../lib/terminalFocus'
import { resolveShortcutCommand, shortcutLabelForCommand } from '../../../keybindings'
import {
  type TerminalContextDraft,
  type TerminalContextSelection,
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  insertInlineTerminalContextPlaceholder,
  removeInlineTerminalContextPlaceholder,
} from '../../../lib/terminalContext'
import {
  type ComposerProviderSwitchState,
  describeModelSwitchCacheCost,
} from '../../../providerSwitchPresentation'
import { useComposerPathSearch } from '../../../lib/composerPathSearchState'
import { type ElementContextDraft } from '../../../lib/elementContext'
import { ComposerPendingElementContexts } from './ComposerPendingElementContexts'
import { ComposerPendingArchitectureContexts } from './ComposerPendingArchitectureContexts'
import { ComposerPendingReviewComments } from './ComposerPendingReviewComments'
import { ComposerPreviewAnnotationCards } from './ComposerPreviewAnnotationCards'
import {
  shouldUseCompactComposerPrimaryActions,
  shouldUseCompactComposerFooter,
} from '../../composerFooterLayout'
import { type ComposerPromptEditorHandle, ComposerPromptEditor } from '../../ComposerPromptEditor'
import { ProviderModelPicker } from '../model-picker/ProviderModelPicker'
import { type ComposerCommandItem, ComposerCommandMenu } from './ComposerCommandMenu'
import { ComposerCommandMenuLayer } from './ComposerCommandMenuLayer'
import { ComposerFooterModeControls } from './ComposerFooterModeControls'
import { ComposerFooterPrimaryActions } from './ComposerFooterPrimaryActions'
import {
  extendReplacementRangeForTrailingSpace,
  isInsideComposerFloatingLayer,
  syncTerminalContextsByIds,
  terminalContextIdListsEqual,
} from './composerShellHelpers'
import {
  resolvePendingInputPromptSync,
  type PendingInputPromptIdentity,
} from './pendingInputPromptSync'
import { ComposerPendingApprovalActions } from './ComposerPendingApprovalActions'
import { CompactComposerControlsMenu } from './CompactComposerControlsMenu'
import {
  ComposerPrimaryActions,
  resolveCollapsedMobilePendingActions,
} from './ComposerPrimaryActions'
import { ComposerPendingApprovalPanel } from './ComposerPendingApprovalPanel'
import { ComposerPendingUserInputPanel } from './ComposerPendingUserInputPanel'
import { ComposerPlanFollowUpBanner } from './ComposerPlanFollowUpBanner'
import { resolveComposerMenuActiveItemId } from './composerMenuHighlight'
import {
  getComposerPromptInjectionState,
  getComposerProviderState,
  renderProviderTraitsMenuContent,
  renderProviderTraitsPicker,
} from './composerProviderState'
import { buildExpandedImagePreview, type ExpandedImagePreview } from '../ExpandedImagePreview'
import { basenameOfPath } from '../../../pierre-icons'
import { cn, randomUUID } from '~/lib/utils'
import { Separator } from '../../ui/separator'
import { getProviderInputLengthValidationMessage } from './composerSubmission'

import { Button } from '../../ui/button'
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from '../../ui/alert-dialog'
import { Tooltip, TooltipPopup, TooltipTrigger } from '../../ui/tooltip'
import { toastManager } from '../../ui/toast'
import { ArrowRightLeftIcon, CircleAlertIcon, TriangleAlertIcon, XIcon } from 'lucide-react'
import { proposedPlanTitle, type PlanImplementVariant } from '../../../proposedPlan'
import { getProviderDisplayName } from '../../../providerModels'
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  NO_PROVIDER_MODEL_SELECTION,
  resolveProviderDriverKindForInstanceSelection,
  resolveSelectableProviderInstanceEntry,
  sortProviderInstanceEntries,
  type ProviderInstanceEntry,
} from '../../../providerInstances'
import { type AppModelOption, getAppModelOptionsForInstance } from '../../../modelSelection'
import type { UnifiedSettings } from '@t3tools/contracts/settings'
import type { SessionPhase, Thread } from '../../../types'
import type { PendingUserInputDraftAnswer } from '../../../pendingUserInput'
import type { PendingApproval, PendingUserInput } from '../../../session-logic'
import { formatProviderDisplayName } from '../../../lib/contextWindow'
import { selectThreadContextWindowSnapshot } from './composerContextWindow'
import { formatProviderSkillDisplayName } from '../../../providerSkillPresentation'
import { searchProviderSkills } from '../../../providerSkillSearch'
import { buildComposerSlashMenuItems, composerSkillInsertionText } from './composerSlashMenuItems'
import {
  blockUnknownComposerSlashCommand,
  shouldConfirmCompactComposerSlashCommand,
} from './composerSlashCommandValidation'
import { useMediaQuery } from '../../../hooks/useMediaQuery'
import { useEnvironmentQuery } from '../../../state/query'
import { workersEnvironment } from '../../../state/workers'
import * as Option from 'effect/Option'

// readiness input literal -> the readiness atom family keys on its JSON form
const WORKERS_READINESS_INPUT = {}

import { runtimeModeForSend, type ChatComposerHandle } from './chatComposerHandle'

export type { ChatComposerHandle }

// props

export interface ChatComposerProps
{
  composerDraftTarget: ScopedThreadRef | DraftId
  environmentId: EnvironmentId
  routeKind: 'server' | 'draft'
  routeThreadRef: ScopedThreadRef
  draftId: DraftId | null

  // thread context
  activeThreadId: ThreadId | null
  activeThreadEnvironmentId: EnvironmentId | undefined
  activeThread: Thread | undefined
  isServerThread: boolean
  isLocalDraftThread: boolean
  forceExpandedOnMobile: boolean
  projectSelectionRequired: boolean

  // session phase
  phase: SessionPhase
  isConnecting: boolean
  isSendBusy: boolean
  sendDisabledReason: string | null
  // non-null only while this thread has a provider switch in flight
  providerSwitch: ComposerProviderSwitchState | null
  isPreparingWorktree: boolean
  importContinuationSendBlocked: boolean
  environmentUnavailable: {
    readonly label: string
    readonly connection: EnvironmentConnectionPresentation
  } | null

  // pending approvals / inputs
  activePendingApproval: PendingApproval | null
  pendingApprovals: PendingApproval[]
  pendingUserInputs: PendingUserInput[]
  activePendingProgress: {
    questionIndex: number
    isLastQuestion: boolean
    canAdvance: boolean
    customAnswer: string
    activeQuestion: { id: string; multiSelect?: boolean | undefined } | null
  } | null
  activePendingResolvedAnswers: Record<string, unknown> | null
  activePendingIsResponding: boolean
  activePendingDraftAnswers: Record<string, PendingUserInputDraftAnswer>
  activePendingQuestionIndex: number
  respondingRequestIds: ApprovalRequestId[]

  // plan
  showPlanFollowUpPrompt: boolean
  activeProposedPlan: Thread['proposedPlans'][number] | null
  activePlan: { turnId?: TurnId } | null
  sidebarProposedPlan: { turnId?: TurnId } | null
  planSidebarLabel: string
  planSidebarOpen: boolean

  // mode
  runtimeMode: RuntimeMode
  collaborationMode: CollaborationMode

  // provider / model
  lockedProvider: ProviderDriverKind | null
  providerStatuses: ServerProvider[]
  activeProjectDefaultModelSelection: ModelSelection | null | undefined
  activeThreadModelSelection: ModelSelection | null | undefined

  // context window
  activeThreadActivities: Thread['activities'] | undefined

  // misc
  resolvedTheme: 'light' | 'dark'
  settings: UnifiedSettings
  keybindings: ResolvedKeybindingsConfig
  terminalOpen: boolean
  gitCwd: string | null

  // refs the parent needs kept in sync
  promptRef: React.RefObject<string>
  composerImagesRef: React.RefObject<ComposerImageAttachment[]>
  composerTerminalContextsRef: React.RefObject<TerminalContextDraft[]>
  composerElementContextsRef: React.RefObject<ElementContextDraft[]>
  composerRef: React.RefObject<ChatComposerHandle | null>

  // callbacks
  onSend: (e?: { preventDefault: () => void }) => void
  onSendProviderSlashCommand: (command: string) => void
  onInterrupt: () => void
  onImplementPlanWithOrchestrate: () => void
  onImplementPlanInNewThread: (variant?: PlanImplementVariant) => void
  onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>
  onSelectActivePendingUserInputOption: (questionId: string, optionLabel: string) => void
  onAdvanceActivePendingUserInput: () => void
  onPreviousActivePendingUserInputQuestion: () => void
  onChangeActivePendingUserInputCustomAnswer: (
    questionId: string,
    value: string,
    nextCursor: number,
    expandedCursor: number,
    cursorAdjacentToMention: boolean,
  ) => void

  onProviderModelSelect: (instanceId: ProviderInstanceId, model: string) => void
  getModelDisabledReason: (instanceId: ProviderInstanceId, model: string) => string | null
  toggleInteractionMode: () => void
  handleRuntimeModeChange: (mode: RuntimeMode) => void
  handleInteractionModeChange: (mode: CollaborationMode) => void
  togglePlanSidebar: () => void

  focusComposer: () => void
  scheduleComposerFocus: () => void
  setThreadError: (threadId: ThreadId | null, error: string | null) => void
  onExpandImage: (preview: ExpandedImagePreview) => void
}

// component

export const ChatComposer = memo(function ChatComposer(props: ChatComposerProps)
{
  const {
    composerDraftTarget,
    environmentId,
    routeKind,
    routeThreadRef,
    draftId,
    activeThreadId,
    activeThread,
    forceExpandedOnMobile,
    projectSelectionRequired,
    phase,
    isConnecting,
    isSendBusy,
    sendDisabledReason,
    providerSwitch,
    isPreparingWorktree,
    importContinuationSendBlocked,
    environmentUnavailable,
    activePendingApproval,
    pendingApprovals,
    pendingUserInputs,
    activePendingProgress,
    activePendingResolvedAnswers,
    activePendingIsResponding,
    activePendingDraftAnswers,
    activePendingQuestionIndex,
    respondingRequestIds,
    showPlanFollowUpPrompt,
    activeProposedPlan,
    activePlan,
    sidebarProposedPlan,
    planSidebarLabel,
    planSidebarOpen,
    runtimeMode,
    collaborationMode,
    lockedProvider,
    providerStatuses,
    activeProjectDefaultModelSelection,
    activeThreadModelSelection,
    activeThreadActivities,
    resolvedTheme,
    settings,
    keybindings,
    terminalOpen,
    gitCwd,
    promptRef,
    composerRef,
    composerImagesRef,
    composerTerminalContextsRef,
    composerElementContextsRef,
    onSend,
    onSendProviderSlashCommand,
    onInterrupt,
    onImplementPlanWithOrchestrate,
    onImplementPlanInNewThread,
    onRespondToApproval,
    onSelectActivePendingUserInputOption,
    onAdvanceActivePendingUserInput,
    onPreviousActivePendingUserInputQuestion,
    onChangeActivePendingUserInputCustomAnswer,
    onProviderModelSelect,
    getModelDisabledReason,
    toggleInteractionMode,
    handleRuntimeModeChange,
    handleInteractionModeChange,
    togglePlanSidebar,
    focusComposer,
    scheduleComposerFocus,
    setThreadError,
    onExpandImage,
  } = props
  // store subscriptions (prompt / images / terminal contexts)
  const composerDraft = useComposerThreadDraft(composerDraftTarget)
  const prompt = composerDraft.prompt
  const composerImages = composerDraft.images
  const composerTerminalContexts = composerDraft.terminalContexts
  const composerElementContexts = composerDraft.elementContexts
  const composerPreviewAnnotations = composerDraft.previewAnnotations
  const composerArchitectureContexts = composerDraft.architectureContexts
  const composerReviewComments = composerDraft.reviewComments
  const nonPersistedComposerImageIds = composerDraft.nonPersistedImageIds

  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt)
  const addComposerDraftImage = useComposerDraftStore((store) => store.addImage)
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages)
  const removeComposerDraftImage = useComposerDraftStore((store) => store.removeImage)
  const insertComposerDraftTerminalContext = useComposerDraftStore(
    (store) => store.insertTerminalContext,
  )
  const removeComposerDraftTerminalContext = useComposerDraftStore(
    (store) => store.removeTerminalContext,
  )
  const setComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.setTerminalContexts,
  )
  const removeComposerDraftElementContext = useComposerDraftStore(
    (store) => store.removeElementContext,
  )
  const removeComposerDraftPreviewAnnotation = useComposerDraftStore(
    (store) => store.removePreviewAnnotation,
  )
  const removeComposerDraftArchitectureContext = useComposerDraftStore(
    (store) => store.removeArchitectureContext,
  )
  const removeComposerDraftReviewComment = useComposerDraftStore(
    (store) => store.removeReviewComment,
  )
  const clearComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.clearPersistedAttachments,
  )
  const clearComposerDraftPromptAndImages = useComposerDraftStore(
    (store) => store.clearComposerPromptAndImages,
  )
  const setComposerDraftModelSelection = useComposerDraftStore((store) => store.setModelSelection)
  const syncComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.syncPersistedAttachments,
  )
  const getComposerDraft = useComposerDraftStore((store) => store.getComposerDraft)

  // model state
  // instance-aware projection of the wire provider list. One entry per
  // configured instance (default built-in + any custom `providerInstances.*`),
  // sorted default-first per driver kind for a stable picker order.
  const providerInstanceEntries = useMemo<ReadonlyArray<ProviderInstanceEntry>>(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providerStatuses), settings),
      ),
    [providerStatuses, settings],
  )
  const selectedProviderByThreadId = composerDraft.activeProvider ?? null
  const threadProvider =
    activeThread?.session?.providerInstanceId ??
    activeThreadModelSelection?.instanceId ??
    activeProjectDefaultModelSelection?.instanceId ??
    null
  const explicitSelectedInstanceId = selectedProviderByThreadId ?? threadProvider

  const unlockedSelectedProvider =
    resolveProviderDriverKindForInstanceSelection(
      providerInstanceEntries,
      providerStatuses,
      explicitSelectedInstanceId,
    ) ??
    providerInstanceEntries[0]?.driverKind ??
    ProviderDriverKind.make('unconfigured')
  const requestedDriverKind: ProviderDriverKind = lockedProvider ?? unlockedSelectedProvider
  const lockedContinuationGroupKey = useMemo((): string | null =>
  {
    if (!lockedProvider || !activeThread) return null
    const lockedInstanceId =
      activeThread.session?.providerInstanceId ?? activeThreadModelSelection?.instanceId
    if (!lockedInstanceId) return null
    return (
      providerInstanceEntries.find((entry) => entry.instanceId === lockedInstanceId)
        ?.continuationGroupKey ?? null
    )
  }, [
    activeThread,
    activeThreadModelSelection?.instanceId,
    lockedProvider,
    providerInstanceEntries,
  ])
  const switchableThreadProviderInstanceId =
    lockedProvider === null && threadHasStarted(activeThread)
      ? (activeThread?.modelSelection.instanceId ?? null)
      : null

  // resolve which configured instance the composer is currently targeting.
  // priority:
  //   1. The composer draft's `activeProvider` — the user's unsaved pick
  //      from the model picker (must win, otherwise the UI appears to
  //      ignore picker selections).
  //   2. Thread's persisted instance id (server-side saved selection).
  //   3. Project default's instance id.
  //   4. First enabled entry matching the current driver kind.
  //   5. First enabled entry overall / default instance for the kind.
  //
  const selectedInstanceId = useMemo<ProviderInstanceId>(() =>
  {
    const candidates: Array<string | null | undefined> = [
      composerDraft.activeProvider,
      activeThread?.session?.providerInstanceId,
      activeThreadModelSelection?.instanceId,
      activeProjectDefaultModelSelection?.instanceId,
    ]
    for (const candidate of candidates)
    {
      if (!candidate) continue
      const match = providerInstanceEntries.find(
        (entry) => entry.instanceId === candidate && entry.enabled && entry.isAvailable,
      )
      if (match)
      {
        // when locked to a specific driver kind, ignore persisted instance
        // ids from a different kind or continuation group.
        if (lockedProvider && match.driverKind !== lockedProvider) continue
        if (
          lockedContinuationGroupKey &&
          match.continuationGroupKey !== lockedContinuationGroupKey
        )
        {
          continue
        }
        return match.instanceId
      }
    }
    const compatibleEntries = providerInstanceEntries.filter(
      (entry) =>
        (!lockedProvider || entry.driverKind === lockedProvider) &&
        (!lockedContinuationGroupKey || entry.continuationGroupKey === lockedContinuationGroupKey),
    )
    const requestedDriverEntries = compatibleEntries.filter(
      (entry) => entry.driverKind === requestedDriverKind,
    )
    return (
      resolveSelectableProviderInstanceEntry(requestedDriverEntries, undefined)?.instanceId ??
      resolveSelectableProviderInstanceEntry(compatibleEntries, undefined)?.instanceId ??
      NO_PROVIDER_MODEL_SELECTION.instanceId
    )
  }, [
    activeProjectDefaultModelSelection?.instanceId,
    activeThread?.session?.providerInstanceId,
    activeThreadModelSelection?.instanceId,
    composerDraft.activeProvider,
    lockedContinuationGroupKey,
    lockedProvider,
    providerInstanceEntries,
    requestedDriverKind,
  ])

  // resolve the active instance's snapshot by `instanceId` so a custom
  // instance gets its own slash commands, skills, and model list — not
  // the first snapshot for the same driver kind.
  const selectedProviderEntry = useMemo(
    () => providerInstanceEntries.find((entry) => entry.instanceId === selectedInstanceId),
    [providerInstanceEntries, selectedInstanceId],
  )
  const noProviderAvailable = selectedProviderEntry === undefined
  // the driver kind follows the instance that will actually run the turn,
  // which can differ from the persisted selection when that selection is
  // disabled.
  const selectedProvider: ProviderDriverKind =
    selectedProviderEntry?.driverKind ?? requestedDriverKind

  const { modelOptions: composerModelOptions, selectedModel } = useEffectiveComposerModelState({
    threadRef: composerDraftTarget,
    providers: providerStatuses,
    selectedProvider,
    selectedInstanceId,
    threadModelSelection: activeThreadModelSelection,
    projectModelSelection: activeProjectDefaultModelSelection,
    settings,
  })
  const selectedProviderStatus = useMemo(
    () => selectedProviderEntry?.snapshot ?? null,
    [selectedProviderEntry],
  )
  const selectedProviderCapabilities =
    selectedProviderStatus?.capabilities ?? CONSERVATIVE_PROVIDER_RUNTIME_CAPABILITIES
  const supportsImageAttachments =
    selectedProviderCapabilities.supportedAttachmentTypes.includes('image')
  const orchestrateMode =
    collaborationMode.orchestrate &&
    selectedProviderCapabilities.orchestrateInstructionDelivery !== 'unsupported' &&
    selectedProviderCapabilities.orchestrateBaseModes.includes(collaborationMode.baseMode)
  const providerSkills = useMemo(
    () =>
      (selectedProviderStatus?.skills ?? []).filter(
        (skill) => skill.name.toLowerCase() !== 'orchestrate',
      ),
    [selectedProviderStatus],
  )
  // readiness explains orchestrate mode and plan handoff availability
  const workersReadinessQuery = useEnvironmentQuery(
    orchestrateMode || showPlanFollowUpPrompt
      ? workersEnvironment.readiness({ environmentId, input: WORKERS_READINESS_INPUT })
      : null,
  )
  const workersReadiness = workersReadinessQuery.data
  const workersNotReadyMessage = useMemo(() =>
  {
    if (workersReadiness === null) return null
    if (workersReadiness.brokerConfigured && workersReadiness.stateDirExists) return null
    const message = Option.getOrNull(workersReadiness.message)
    if (message !== null && message.trim() !== '') return message
    return workersReadiness.brokerConfigured
      ? `Worker-broker state dir is missing: ${workersReadiness.stateDir}`
      : 'The worker broker is not configured for this environment.'
  }, [workersReadiness])
  const brokerNotReadyMessage = orchestrateMode ? workersNotReadyMessage : null
  const planOrchestrateNotReadyMessage = showPlanFollowUpPrompt ? workersNotReadyMessage : null
  const activeTurnInputDisabledReason =
    phase === 'running' && selectedProviderCapabilities.activeTurnInput === 'unsupported'
      ? 'Wait for the active provider turn to finish before sending another message.'
      : null
  const unsupportedAttachmentReason =
    !supportsImageAttachments && composerImages.length > 0
      ? 'Remove image attachments before sending with this provider.'
      : null
  const effectiveSendDisabledReason =
    sendDisabledReason ??
    unsupportedAttachmentReason ??
    activeTurnInputDisabledReason ??
    brokerNotReadyMessage
  const isSendDisabled = effectiveSendDisabledReason !== null
  const selectedProviderModels = useMemo<ReadonlyArray<ServerProvider['models'][number]>>(
    () => selectedProviderEntry?.models ?? [],
    [selectedProviderEntry],
  )

  const composerPromptInjectionState = useMemo(
    () => getComposerPromptInjectionState(prompt),
    [prompt],
  )
  const composerProviderState = useMemo(
    () =>
      getComposerProviderState({
        provider: selectedProvider,
        model: selectedModel,
        models: selectedProviderModels,
        promptInjectionState: composerPromptInjectionState,
        modelOptions: composerModelOptions?.[selectedInstanceId],
      }),
    [
      composerModelOptions,
      composerPromptInjectionState,
      selectedInstanceId,
      selectedModel,
      selectedProvider,
      selectedProviderModels,
    ],
  )

  const selectedPromptEffort = composerProviderState.promptEffort
  const selectedModelOptionsForDispatch = composerProviderState.modelOptionsForDispatch
  const composerProviderControls = useMemo(
    () => ({
      showInteractionModeToggle:
        selectedProviderStatus?.showInteractionModeToggle !== false &&
        selectedProviderCapabilities.supportedInteractionModes.includes('plan'),
      showOrchestrate:
        selectedProviderCapabilities.orchestrateInstructionDelivery !== 'unsupported' &&
        selectedProviderCapabilities.orchestrateBaseModes.includes(collaborationMode.baseMode),
      supportedRuntimeModes: selectedProviderCapabilities.supportedRuntimeModes,
    }),
    [
      collaborationMode.baseMode,
      selectedProviderCapabilities,
      selectedProviderStatus?.showInteractionModeToggle,
    ],
  )
  // footer already displays a supported mode; persist it so the next draft matches send
  useEffect(() =>
  {
    const nextMode = runtimeModeForSend(
      runtimeMode,
      selectedProviderCapabilities.supportedRuntimeModes,
    )
    if (nextMode === runtimeMode) return
    handleRuntimeModeChange(nextMode)
  }, [handleRuntimeModeChange, runtimeMode, selectedProviderCapabilities.supportedRuntimeModes])
  const handleComposerModeChange = useCallback(
    (mode: 'build' | 'plan') =>
    {
      void handleInteractionModeChange(
        normalizeCollaborationMode(
          mode === 'build' ? 'default' : 'plan',
          collaborationMode.orchestrate,
        ),
      )
    },
    [collaborationMode.orchestrate, handleInteractionModeChange],
  )
  const handleComposerOrchestrateChange = useCallback(
    (enabled: boolean) =>
    {
      void handleInteractionModeChange(
        normalizeCollaborationMode(collaborationMode.baseMode, enabled),
      )
    },
    [collaborationMode.baseMode, handleInteractionModeChange],
  )
  const selectedModelSelection = useMemo<ModelSelection>(
    () => createModelSelection(selectedInstanceId, selectedModel, selectedModelOptionsForDispatch),
    [selectedInstanceId, selectedModel, selectedModelOptionsForDispatch],
  )
  const selectedModelForPicker = selectedModel
  // instance-keyed option list so the picker can show each configured
  // instance (built-in + custom) as a first-class sidebar entry. The
  // options are server-reported models plus that exact instance's
  // configured custom models; selected slugs are not injected into lists.
  const modelOptionsByInstance = useMemo<
    ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>
  >(() =>
  {
    const out = new Map<ProviderInstanceId, ReadonlyArray<AppModelOption>>()
    for (const entry of providerInstanceEntries)
    {
      out.set(entry.instanceId, getAppModelOptionsForInstance(settings, entry))
    }
    return out
  }, [providerInstanceEntries, settings])
  const selectedModelForPickerWithCustomFallback = useMemo(() =>
  {
    const currentOptions = modelOptionsByInstance.get(selectedInstanceId) ?? []
    return currentOptions.some((option) => option.slug === selectedModelForPicker)
      ? selectedModelForPicker
      : (normalizeModelSlug(selectedModelForPicker, selectedProvider) ?? selectedModelForPicker)
  }, [modelOptionsByInstance, selectedInstanceId, selectedModelForPicker, selectedProvider])

  // context window
  // the meter is labelled with the instance the composer is targeting, so the
  // snapshot it renders has to come from that same instance — a thread that
  // switched providers still carries the old instance's activities.
  const activeContextWindow = useMemo(
    () =>
      selectThreadContextWindowSnapshot({
        activities: activeThreadActivities ?? [],
        currentProviderInstanceId:
          selectedProviderEntry?.instanceId ?? activeThreadModelSelection?.instanceId ?? null,
      }),
    [activeThreadActivities, activeThreadModelSelection?.instanceId, selectedProviderEntry],
  )
  // a same-instance model change keeps this thread's resident context and makes
  // the next turn re-read it against a cold, model-scoped prompt cache.
  //
  // * only the 'current' snapshot state is used: 'previous-provider' and
  //   'unavailable' belong to a torn-down session, so their numbers do not
  //   describe what the new model would re-read.
  // * a provider that requires a new thread for a model change (Grok) already
  //   disables its rows mid-thread, so the hint would sit above a dead list.
  const modelSwitchCacheHint = useMemo(() =>
  {
    if (selectedProviderEntry?.snapshot.requiresNewThreadForModelChange === true)
    {
      return null
    }
    return describeModelSwitchCacheCost({
      hasStarted: threadHasStarted(activeThread),
      usedTokens:
        activeContextWindow.state === 'current' ? activeContextWindow.snapshot.usedTokens : null,
    })
  }, [activeContextWindow, activeThread, selectedProviderEntry])
  const activeThreadProviderDisplayName = useMemo(() =>
  {
    if (!activeThreadModelSelection) return null
    const entry = providerStatuses.find(
      (p) => p.instanceId === activeThreadModelSelection.instanceId,
    )
    if (entry)
    {
      return getProviderDisplayName(providerStatuses, entry.driver)
    }
    return formatProviderDisplayName(activeThreadModelSelection.instanceId)
  }, [providerStatuses, activeThreadModelSelection])
  const usageProviderDisplayName =
    selectedProviderEntry?.displayName ?? activeThreadProviderDisplayName

  // composer-local state
  const [composerCursor, setComposerCursor] = useState(() =>
    collapseExpandedComposerCursor(prompt, prompt.length),
  )
  const [composerTrigger, setComposerTrigger] = useState<ComposerTrigger | null>(() =>
    detectComposerTrigger(prompt, prompt.length),
  )
  const [composerHighlightedItemId, setComposerHighlightedItemId] = useState<string | null>(null)
  const [composerHighlightedSearchKey, setComposerHighlightedSearchKey] = useState<string | null>(
    null,
  )
  const [isDragOverComposer, setIsDragOverComposer] = useState(false)
  const [isComposerFooterCompact, setIsComposerFooterCompact] = useState(false)
  const [isComposerPrimaryActionsCompact, setIsComposerPrimaryActionsCompact] = useState(false)
  const [isComposerModelPickerOpen, setIsComposerModelPickerOpen] = useState(false)
  const [isComposerFocused, setIsComposerFocused] = useState(false)
  const [providerInputSubmissionError, setProviderInputSubmissionError] = useState<string | null>(
    null,
  )
  const [composerMenuAnchor, setComposerMenuAnchor] = useState<HTMLDivElement | null>(null)
  const [isStashMenuOpen, setIsStashMenuOpen] = useState(false)
  const [compactConfirmationSource, setCompactConfirmationSource] = useState<
    'composer' | 'usage-meter' | null
  >(null)
  const [stashPulse, setStashPulse] = useState<{ key: number; active: boolean }>({
    key: 0,
    active: false,
  })
  const isMobileViewport = useMediaQuery('max-sm')
  const isComposerCollapsedMobile = isMobileViewport && !forceExpandedOnMobile && !isComposerFocused

  // refs
  const composerEditorRef = useRef<ComposerPromptEditorHandle>(null)
  const composerFormRef = useRef<HTMLFormElement>(null)
  const composerSurfaceRef = useRef<HTMLDivElement>(null)
  const providerInputRejectedRef = useRef(false)
  const composerSelectLockRef = useRef(false)
  const composerMenuOpenRef = useRef(false)
  const composerMenuItemsRef = useRef<ComposerCommandItem[]>([])
  const activeComposerMenuItemRef = useRef<ComposerCommandItem | null>(null)
  const composerBlurFrameRef = useRef<number | null>(null)
  const mobileComposerExpandFrameRef = useRef<number | null>(null)
  const mobileComposerExpandReleaseFrameRef = useRef<number | null>(null)
  const mobileComposerExpandInFlightRef = useRef(false)
  const stashPulseKeyRef = useRef(0)
  const stashPulseTimeoutRef = useRef<number | null>(null)
  // snapshots currently being encoded, keyed by target+prompt+image ids.
  // keyed rather than boolean so a genuinely different prompt (or a different
  // thread) can still be stashed while an earlier encode is running.
  const stashInFlightRef = useRef<Set<string>>(new Set())
  // reserve attachment slots per thread while pasted images compress
  const pendingImageCompressionsRef = useRef<Map<ThreadId, number>>(new Map())

  // derived: composer send state
  const composerSendState = useMemo(
    () =>
      deriveComposerSendState({
        prompt,
        imageCount: composerImages.length,
        terminalContexts: composerTerminalContexts,
        elementContextCount:
          composerElementContexts.length +
          composerPreviewAnnotations.length +
          composerArchitectureContexts.length +
          composerReviewComments.length,
      }),
    [
      composerElementContexts.length,
      composerArchitectureContexts.length,
      composerImages.length,
      composerPreviewAnnotations.length,
      composerReviewComments.length,
      composerTerminalContexts,
      prompt,
    ],
  )
  const providerSupportsCompact =
    selectedProviderStatus?.slashCommands.some(
      (command) => command.name.toLowerCase() === 'compact',
    ) ?? false

  const requestCompactNow = useCallback(() =>
  {
    setCompactConfirmationSource('usage-meter')
  }, [])

  const confirmCompactNow = useCallback(() =>
  {
    const source = compactConfirmationSource
    if (source === null)
    {
      return
    }
    setCompactConfirmationSource(null)
    if (source === 'composer')
    {
      onSend()
      return
    }
    onSendProviderSlashCommand('/compact')
  }, [compactConfirmationSource, onSend, onSendProviderSlashCommand])

  // derived: composer trigger / menu
  const composerTriggerKind = composerTrigger?.kind ?? null
  const pathTriggerQuery = composerTrigger?.kind === 'path' ? composerTrigger.query : ''
  const isPathTrigger = composerTriggerKind === 'path'
  const workspaceEntries = useComposerPathSearch({
    environmentId,
    cwd: isPathTrigger ? gitCwd : null,
    query: isPathTrigger ? pathTriggerQuery : null,
  })

  const composerMenuItems = useMemo<ComposerCommandItem[]>(() =>
  {
    if (!composerTrigger) return []
    if (composerTrigger.kind === 'path')
    {
      return workspaceEntries.entries.map((entry) => ({
        id: `path:${entry.kind}:${entry.path}`,
        type: 'path',
        path: entry.path,
        pathKind: entry.kind,
        label: basenameOfPath(entry.path),
        description: entry.path.slice(0, Math.max(0, entry.path.lastIndexOf('/'))),
      }))
    }
    if (composerTrigger.kind === 'slash-command')
    {
      const builtInItems: Array<Extract<ComposerCommandItem, { type: 'slash-command' }>> = [
        {
          id: 'slash:model',
          type: 'slash-command' as const,
          command: 'model',
          label: '/model',
          description: 'Switch response model for this thread',
        },
      ]
      if (composerProviderControls.showInteractionModeToggle)
      {
        builtInItems.push({
          id: 'slash:plan',
          type: 'slash-command',
          command: 'plan',
          label: '/plan',
          description: 'Switch to Plan and keep the Orchestrate setting',
        })
      }
      if (composerProviderControls.showOrchestrate)
      {
        builtInItems.push({
          id: 'slash:orchestrate',
          type: 'slash-command',
          command: 'orchestrate',
          label: '/orchestrate',
          description: 'Enable Orchestrate and keep the current mode',
        })
      }
      builtInItems.push({
        id: 'slash:default',
        type: 'slash-command',
        command: 'default',
        label: '/default',
        description: 'Reset to Build with Orchestrate off',
      })
      return buildComposerSlashMenuItems({
        provider: selectedProvider,
        query: composerTrigger.query,
        builtInItems,
        slashCommands: selectedProviderStatus?.slashCommands ?? [],
        skills: providerSkills,
      })
    }
    if (composerTrigger.kind === 'skill')
    {
      return searchProviderSkills(providerSkills, composerTrigger.query).map((skill) => ({
        id: `skill:${selectedProvider}:${skill.name}`,
        type: 'skill' as const,
        provider: selectedProvider,
        skill,
        label: formatProviderSkillDisplayName(skill),
        description:
          skill.shortDescription ??
          skill.description ??
          (skill.scope ? `${skill.scope} skill` : 'Run provider skill'),
      }))
    }
    return []
  }, [
    composerTrigger,
    composerProviderControls,
    providerSkills,
    selectedProvider,
    selectedProviderStatus,
    workspaceEntries.entries,
  ])

  const composerMenuOpen = Boolean(composerTrigger)
  const composerMenuSearchKey = composerTrigger
    ? `${composerTrigger.kind}:${composerTrigger.query.trim().toLowerCase()}`
    : null
  const activeComposerMenuItem = useMemo(() =>
  {
    const activeItemId = resolveComposerMenuActiveItemId({
      items: composerMenuItems,
      highlightedItemId: composerHighlightedItemId,
      currentSearchKey: composerMenuSearchKey,
      highlightedSearchKey: composerHighlightedSearchKey,
    })
    return composerMenuItems.find((item) => item.id === activeItemId) ?? null
  }, [
    composerHighlightedItemId,
    composerHighlightedSearchKey,
    composerMenuItems,
    composerMenuSearchKey,
  ])

  composerMenuOpenRef.current = composerMenuOpen
  composerMenuItemsRef.current = composerMenuItems
  activeComposerMenuItemRef.current = activeComposerMenuItem

  const nonPersistedComposerImageIdSet = useMemo(
    () => new Set(nonPersistedComposerImageIds),
    [nonPersistedComposerImageIds],
  )

  const isComposerApprovalState = activePendingApproval !== null
  const activePendingUserInput = pendingUserInputs[0] ?? null
  const hasComposerHeader =
    isComposerApprovalState ||
    pendingUserInputs.length > 0 ||
    (showPlanFollowUpPrompt && activeProposedPlan !== null)
  const showCollapsedMobilePromptRow =
    isComposerCollapsedMobile && !isComposerApprovalState && pendingUserInputs.length === 0

  const composerFooterHasWideActions = showPlanFollowUpPrompt || activePendingProgress !== null
  const showPlanSidebarToggle = Boolean(activePlan || sidebarProposedPlan || planSidebarOpen)
  const composerFooterActionLayoutKey = useMemo(() =>
  {
    if (activePendingProgress)
    {
      return `pending:${activePendingProgress.questionIndex}:${activePendingProgress.isLastQuestion}:${activePendingIsResponding}`
    }
    if (phase === 'running')
    {
      return 'running'
    }
    if (showPlanFollowUpPrompt)
    {
      return prompt.trim().length > 0 ? 'plan:refine' : 'plan:implement'
    }
    return `idle:${composerSendState.hasSendableContent}:${isSendBusy}:${isConnecting}:${isPreparingWorktree}`
  }, [
    activePendingIsResponding,
    activePendingProgress,
    composerSendState.hasSendableContent,
    isConnecting,
    isPreparingWorktree,
    isSendBusy,
    phase,
    prompt,
    showPlanFollowUpPrompt,
  ])

  const isComposerMenuLoading =
    composerTriggerKind === 'path' && pathTriggerQuery.length > 0 && workspaceEntries.isPending
  const composerMenuEmptyState = useMemo(() =>
  {
    if (composerTriggerKind === 'skill')
    {
      return 'No skills found. Try / to browse provider commands.'
    }
    return composerTriggerKind === 'path' ? 'No matching files or folders.' : 'No matching command.'
  }, [composerTriggerKind])

  // provider traits UI
  const setPromptFromTraits = useCallback(
    (nextPrompt: string) =>
    {
      if (nextPrompt === promptRef.current)
      {
        scheduleComposerFocus()
        return
      }
      promptRef.current = nextPrompt
      setComposerDraftPrompt(composerDraftTarget, nextPrompt)
      const nextCursor = collapseExpandedComposerCursor(nextPrompt, nextPrompt.length)
      setComposerCursor(nextCursor)
      setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length))
      scheduleComposerFocus()
    },
    [composerDraftTarget, promptRef, scheduleComposerFocus, setComposerDraftPrompt],
  )

  const providerTraitsMenuContent = renderProviderTraitsMenuContent({
    provider: selectedProvider,
    instanceId: selectedInstanceId,
    ...(routeKind === 'server' ? { threadRef: routeThreadRef } : {}),
    ...(routeKind === 'draft' && draftId ? { draftId } : {}),
    model: selectedModel,
    models: selectedProviderModels,
    modelOptions: composerModelOptions?.[selectedInstanceId],
    prompt,
    onPromptChange: setPromptFromTraits,
  })
  const providerTraitsPicker = renderProviderTraitsPicker({
    provider: selectedProvider,
    instanceId: selectedInstanceId,
    ...(routeKind === 'server' ? { threadRef: routeThreadRef } : {}),
    ...(routeKind === 'draft' && draftId ? { draftId } : {}),
    model: selectedModel,
    models: selectedProviderModels,
    modelOptions: composerModelOptions?.[selectedInstanceId],
    prompt,
    onPromptChange: setPromptFromTraits,
  })
  const pendingPrimaryAction = useMemo(
    () =>
      activePendingProgress
        ? {
            questionIndex: activePendingProgress.questionIndex,
            isLastQuestion: activePendingProgress.isLastQuestion,
            canAdvance: activePendingProgress.canAdvance,
            isResponding: activePendingIsResponding,
            isComplete: Boolean(activePendingResolvedAnswers),
          }
        : null,
    [activePendingIsResponding, activePendingProgress, activePendingResolvedAnswers],
  )
  const isTurnRunning = phase === 'running' && providerSwitch?.hidesRunningTurn !== true
  const collapsedMobilePendingActions = resolveCollapsedMobilePendingActions(
    pendingPrimaryAction,
    activePendingProgress?.activeQuestion?.multiSelect === true,
    isTurnRunning,
  )
  const collapsedComposerPrimaryActionDisabled =
    phase === 'running' ||
    isSendBusy ||
    isSendDisabled ||
    isConnecting ||
    (noProviderAvailable && !importContinuationSendBlocked) ||
    projectSelectionRequired ||
    environmentUnavailable !== null ||
    !composerSendState.hasSendableContent
  const collapsedComposerPrimaryActionLabel = 'Send message'
  const showMobilePendingAnswerActions =
    isMobileViewport && !isComposerCollapsedMobile && pendingPrimaryAction !== null

  // prompt helpers
  const setPrompt = useCallback(
    (nextPrompt: string) =>
    {
      setComposerDraftPrompt(composerDraftTarget, nextPrompt)
    },
    [composerDraftTarget, setComposerDraftPrompt],
  )

  const addComposerImage = useCallback(
    (image: ComposerImageAttachment) =>
    {
      addComposerDraftImage(composerDraftTarget, image)
    },
    [composerDraftTarget, addComposerDraftImage],
  )

  const addComposerImagesToDraft = useCallback(
    (images: ComposerImageAttachment[]) =>
    {
      addComposerDraftImages(composerDraftTarget, images)
    },
    [composerDraftTarget, addComposerDraftImages],
  )

  const removeComposerImageFromDraft = useCallback(
    (imageId: string) =>
    {
      removeComposerDraftImage(composerDraftTarget, imageId)
    },
    [composerDraftTarget, removeComposerDraftImage],
  )

  const removeComposerTerminalContextFromDraft = useCallback(
    (contextId: string) =>
    {
      const contextIndex = composerTerminalContexts.findIndex((context) => context.id === contextId)
      if (contextIndex < 0) return
      const removal = removeInlineTerminalContextPlaceholder(promptRef.current, contextIndex)
      promptRef.current = removal.prompt
      setPrompt(removal.prompt)
      removeComposerDraftTerminalContext(composerDraftTarget, contextId)
      const nextCursor = collapseExpandedComposerCursor(removal.prompt, removal.cursor)
      setComposerCursor(nextCursor)
      setComposerTrigger(detectComposerTrigger(removal.prompt, removal.cursor))
    },
    [
      composerDraftTarget,
      composerTerminalContexts,
      promptRef,
      removeComposerDraftTerminalContext,
      setPrompt,
    ],
  )

  // sync refs back to parent
  useEffect(() =>
  {
    promptRef.current = prompt
    setComposerCursor((existing) => clampCollapsedComposerCursor(prompt, existing))
  }, [prompt, promptRef])

  useEffect(() =>
  {
    composerImagesRef.current = composerImages
  }, [composerImages, composerImagesRef])

  useEffect(() =>
  {
    composerTerminalContextsRef.current = composerTerminalContexts
  }, [composerTerminalContexts, composerTerminalContextsRef])

  useEffect(() =>
  {
    composerElementContextsRef.current = composerElementContexts
  }, [composerElementContexts, composerElementContextsRef])

  // a failed preflight remains visible until an input that contributes to the
  // final provider text changes; the next submit will validate the whole text.
  useEffect(() =>
  {
    setProviderInputSubmissionError(null)
  }, [
    activeProposedPlan?.planMarkdown,
    collaborationMode.baseMode,
    collaborationMode.orchestrate,
    composerElementContexts,
    composerImages,
    composerPreviewAnnotations,
    composerReviewComments,
    composerTerminalContexts,
    draftId,
    prompt,
    selectedModel,
    selectedPromptEffort,
    selectedProvider,
  ])

  // composer menu highlight sync
  useEffect(() =>
  {
    if (!composerMenuOpen)
    {
      setComposerHighlightedItemId(null)
      setComposerHighlightedSearchKey(null)
      return
    }
    const nextActiveItemId = resolveComposerMenuActiveItemId({
      items: composerMenuItems,
      highlightedItemId: composerHighlightedItemId,
      currentSearchKey: composerMenuSearchKey,
      highlightedSearchKey: composerHighlightedSearchKey,
    })
    setComposerHighlightedItemId((existing) =>
      existing === nextActiveItemId ? existing : nextActiveItemId,
    )
    setComposerHighlightedSearchKey((existing) =>
      existing === composerMenuSearchKey ? existing : composerMenuSearchKey,
    )
  }, [
    composerHighlightedItemId,
    composerHighlightedSearchKey,
    composerMenuItems,
    composerMenuOpen,
    composerMenuSearchKey,
  ])

  const lastSyncedPendingInputRef = useRef<PendingInputPromptIdentity | null>(null)

  useEffect(() =>
  {
    const nextCustomAnswer = activePendingProgress?.customAnswer
    const nextIdentity = {
      requestId: activePendingUserInput?.requestId ?? null,
      questionId: activePendingProgress?.activeQuestion?.id ?? null,
    }
    const sync = resolvePendingInputPromptSync({
      draftPrompt: prompt,
      currentPrompt: promptRef.current,
      pendingCustomAnswer: typeof nextCustomAnswer === 'string' ? nextCustomAnswer : null,
      pendingIdentity: nextIdentity,
      previousIdentity: lastSyncedPendingInputRef.current,
    })
    if (!sync)
    {
      return
    }

    lastSyncedPendingInputRef.current = sync.nextIdentity
    promptRef.current = sync.nextPrompt
    const nextCursor = collapseExpandedComposerCursor(sync.nextPrompt, sync.nextPrompt.length)
    setComposerCursor(nextCursor)
    setComposerTrigger(
      detectComposerTrigger(
        sync.nextPrompt,
        expandCollapsedComposerCursor(sync.nextPrompt, nextCursor),
      ),
    )
    setComposerHighlightedItemId(null)
  }, [
    activePendingProgress?.customAnswer,
    activePendingProgress?.activeQuestion?.id,
    activePendingUserInput?.requestId,
    prompt,
    promptRef,
  ])

  // reset compositor state on thread/draft change
  useEffect(() =>
  {
    setComposerHighlightedItemId(null)
    setComposerCursor(collapseExpandedComposerCursor(promptRef.current, promptRef.current.length))
    setComposerTrigger(detectComposerTrigger(promptRef.current, promptRef.current.length))
    setIsDragOverComposer(false)
  }, [draftId, activeThreadId, promptRef])

  // footer compact layout observation
  useLayoutEffect(() =>
  {
    const composerForm = composerFormRef.current
    if (!composerForm) return
    const measureComposerFormWidth = () => composerForm.clientWidth
    const measureFooterCompactness = () =>
    {
      const composerFormWidth = measureComposerFormWidth()
      const footerCompact = shouldUseCompactComposerFooter(composerFormWidth, {
        hasWideActions: composerFooterHasWideActions,
      })
      const primaryActionsCompact =
        footerCompact &&
        shouldUseCompactComposerPrimaryActions(composerFormWidth, {
          hasWideActions: composerFooterHasWideActions,
        })
      return {
        primaryActionsCompact,
        footerCompact,
      }
    }

    const initialCompactness = measureFooterCompactness()
    setIsComposerPrimaryActionsCompact(initialCompactness.primaryActionsCompact)
    setIsComposerFooterCompact(initialCompactness.footerCompact)
    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(() =>
    {
      const nextCompactness = measureFooterCompactness()
      setIsComposerPrimaryActionsCompact((previous) =>
        previous === nextCompactness.primaryActionsCompact
          ? previous
          : nextCompactness.primaryActionsCompact,
      )
      setIsComposerFooterCompact((previous) =>
        previous === nextCompactness.footerCompact ? previous : nextCompactness.footerCompact,
      )
    })

    observer.observe(composerForm)
    return () =>
    {
      observer.disconnect()
    }
  }, [activeThreadId, composerFooterActionLayoutKey, composerFooterHasWideActions])

  // image persist effect
  useEffect(() =>
  {
    let cancelled = false
    void (async () =>
    {
      if (composerImages.length === 0)
      {
        clearComposerDraftPersistedAttachments(composerDraftTarget)
        return
      }
      const getPersistedAttachmentsForThread = () =>
        getComposerDraft(composerDraftTarget)?.persistedAttachments ?? []
      try
      {
        const currentPersistedAttachments = getPersistedAttachmentsForThread()
        const existingPersistedById = new Map(
          currentPersistedAttachments.map((attachment) => [attachment.id, attachment]),
        )
        const stagedAttachmentById = new Map<string, PersistedComposerImageAttachment>()
        await Promise.all(
          composerImages.map(async (image) =>
          {
            try
            {
              const dataUrl = await readFileAsDataUrl(image.file)
              stagedAttachmentById.set(image.id, {
                id: image.id,
                name: image.name,
                mimeType: image.mimeType,
                sizeBytes: image.sizeBytes,
                dataUrl,
              })
            }
            catch
            {
              const existingPersisted = existingPersistedById.get(image.id)
              if (existingPersisted)
              {
                stagedAttachmentById.set(image.id, existingPersisted)
              }
            }
          }),
        )
        const serialized = Array.from(stagedAttachmentById.values())
        if (cancelled) return
        syncComposerDraftPersistedAttachments(composerDraftTarget, serialized)
      }
      catch
      {
        const currentImageIds = new Set(composerImages.map((image) => image.id))
        const fallbackPersistedAttachments = getPersistedAttachmentsForThread()
        const fallbackPersistedIds: Array<string> = []
        for (const attachment of fallbackPersistedAttachments)
        {
          if (currentImageIds.has(attachment.id))
          {
            fallbackPersistedIds.push(attachment.id)
          }
        }
        const fallbackPersistedIdSet = new Set(fallbackPersistedIds)
        const fallbackAttachments = fallbackPersistedAttachments.filter((attachment) =>
          fallbackPersistedIdSet.has(attachment.id),
        )
        if (cancelled) return
        syncComposerDraftPersistedAttachments(composerDraftTarget, fallbackAttachments)
      }
    })()
    return () =>
    {
      cancelled = true
    }
  }, [
    composerDraftTarget,
    clearComposerDraftPersistedAttachments,
    composerImages,
    getComposerDraft,
    syncComposerDraftPersistedAttachments,
  ])

  // callbacks: prompt change
  const onPromptChange = useCallback(
    (
      nextPrompt: string,
      nextCursor: number,
      expandedCursor: number,
      cursorAdjacentToMention: boolean,
      terminalContextIds: string[],
    ) =>
    {
      if (activePendingProgress?.activeQuestion && pendingUserInputs.length > 0)
      {
        setComposerCursor(nextCursor)
        setComposerTrigger(
          cursorAdjacentToMention ? null : detectComposerTrigger(nextPrompt, expandedCursor),
        )
        onChangeActivePendingUserInputCustomAnswer(
          activePendingProgress.activeQuestion.id,
          nextPrompt,
          nextCursor,
          expandedCursor,
          cursorAdjacentToMention,
        )
        return
      }
      promptRef.current = nextPrompt
      setPrompt(nextPrompt)
      if (!terminalContextIdListsEqual(composerTerminalContexts, terminalContextIds))
      {
        setComposerDraftTerminalContexts(
          composerDraftTarget,
          syncTerminalContextsByIds(composerTerminalContexts, terminalContextIds),
        )
      }
      setComposerCursor(nextCursor)
      setComposerTrigger(
        cursorAdjacentToMention ? null : detectComposerTrigger(nextPrompt, expandedCursor),
      )
    },
    [
      activePendingProgress?.activeQuestion,
      pendingUserInputs.length,
      onChangeActivePendingUserInputCustomAnswer,
      promptRef,
      setPrompt,
      composerDraftTarget,
      composerTerminalContexts,
      setComposerDraftTerminalContexts,
    ],
  )

  // callbacks: prompt replacement / menu
  const applyPromptReplacement = useCallback(
    (
      rangeStart: number,
      rangeEnd: number,
      replacement: string,
      options?: { expectedText?: string; focusEditorAfterReplace?: boolean },
    ): boolean =>
    {
      const currentText = promptRef.current
      const safeStart = Math.max(0, Math.min(currentText.length, rangeStart))
      const safeEnd = Math.max(safeStart, Math.min(currentText.length, rangeEnd))
      if (
        options?.expectedText !== undefined &&
        currentText.slice(safeStart, safeEnd) !== options.expectedText
      )
      {
        return false
      }
      const next = replaceTextRange(promptRef.current, rangeStart, rangeEnd, replacement)
      const nextCursor = collapseExpandedComposerCursor(next.text, next.cursor)
      const nextExpandedCursor = expandCollapsedComposerCursor(next.text, nextCursor)
      promptRef.current = next.text
      const activePendingQuestion = activePendingProgress?.activeQuestion
      if (activePendingQuestion && activePendingUserInput)
      {
        onChangeActivePendingUserInputCustomAnswer(
          activePendingQuestion.id,
          next.text,
          nextCursor,
          nextExpandedCursor,
          false,
        )
      }
      else
      {
        setPrompt(next.text)
      }
      setComposerCursor(nextCursor)
      setComposerTrigger(detectComposerTrigger(next.text, nextExpandedCursor))
      if (options?.focusEditorAfterReplace !== false)
      {
        window.requestAnimationFrame(() =>
        {
          composerEditorRef.current?.focusAt(nextCursor)
        })
      }
      return true
    },
    [
      activePendingProgress?.activeQuestion,
      activePendingUserInput,
      onChangeActivePendingUserInputCustomAnswer,
      promptRef,
      setPrompt,
    ],
  )

  const readComposerSnapshot = useCallback((): {
    value: string
    cursor: number
    expandedCursor: number
    terminalContextIds: string[]
  } =>
  {
    const editorSnapshot = composerEditorRef.current?.readSnapshot()
    if (editorSnapshot)
    {
      return editorSnapshot
    }
    return {
      value: promptRef.current,
      cursor: composerCursor,
      expandedCursor: expandCollapsedComposerCursor(promptRef.current, composerCursor),
      terminalContextIds: composerTerminalContexts.map((context) => context.id),
    }
  }, [composerCursor, composerTerminalContexts, promptRef])

  const resolveActiveComposerTrigger = useCallback((): {
    snapshot: { value: string; cursor: number; expandedCursor: number }
    trigger: ComposerTrigger | null
  } =>
  {
    const snapshot = readComposerSnapshot()
    return {
      snapshot,
      trigger: detectComposerTrigger(snapshot.value, snapshot.expandedCursor),
    }
  }, [readComposerSnapshot])

  const onSelectComposerItem = useCallback(
    (item: ComposerCommandItem) =>
    {
      if (composerSelectLockRef.current) return
      composerSelectLockRef.current = true
      window.requestAnimationFrame(() =>
      {
        composerSelectLockRef.current = false
      })
      const { snapshot, trigger } = resolveActiveComposerTrigger()
      if (!trigger) return
      if (item.type === 'path')
      {
        const replacement = `${serializeComposerFileLink(item.path)} `
        const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
          snapshot.value,
          trigger.rangeEnd,
          replacement,
        )
        const applied = applyPromptReplacement(
          trigger.rangeStart,
          replacementRangeEnd,
          replacement,
          { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
        )
        if (applied)
        {
          setComposerHighlightedItemId(null)
        }
        return
      }
      if (item.type === 'slash-command')
      {
        if (item.command === 'model')
        {
          const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, '', {
            expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
            focusEditorAfterReplace: false,
          })
          if (applied)
          {
            setComposerHighlightedItemId(null)
            setIsComposerModelPickerOpen(true)
          }
          return
        }
        if (
          (item.command === 'plan' && !composerProviderControls.showInteractionModeToggle) ||
          (item.command === 'orchestrate' && !composerProviderControls.showOrchestrate)
        )
        {
          return
        }
        void handleInteractionModeChange(
          resolveComposerSlashCommandMode(collaborationMode, item.command),
        )
        const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, '', {
          expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
        })
        if (applied)
        {
          setComposerHighlightedItemId(null)
        }
        return
      }
      if (item.type === 'provider-slash-command')
      {
        const replacement = `/${item.command.name} `
        const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
          snapshot.value,
          trigger.rangeEnd,
          replacement,
        )
        const applied = applyPromptReplacement(
          trigger.rangeStart,
          replacementRangeEnd,
          replacement,
          { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
        )
        if (applied)
        {
          setComposerHighlightedItemId(null)
        }
        return
      }
      if (item.type === 'skill')
      {
        const replacement = composerSkillInsertionText(item.skill.name)
        const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
          snapshot.value,
          trigger.rangeEnd,
          replacement,
        )
        const applied = applyPromptReplacement(
          trigger.rangeStart,
          replacementRangeEnd,
          replacement,
          { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
        )
        if (applied)
        {
          setComposerHighlightedItemId(null)
        }
        return
      }
    },
    [
      applyPromptReplacement,
      collaborationMode,
      composerProviderControls,
      handleInteractionModeChange,
      resolveActiveComposerTrigger,
    ],
  )

  const onComposerMenuItemHighlighted = useCallback(
    (itemId: string | null) =>
    {
      setComposerHighlightedItemId(itemId)
      setComposerHighlightedSearchKey(composerMenuSearchKey)
    },
    [composerMenuSearchKey],
  )

  const nudgeComposerMenuHighlight = useCallback(
    (key: 'ArrowDown' | 'ArrowUp') =>
    {
      if (composerMenuItems.length === 0) return
      const highlightedIndex = composerMenuItems.findIndex(
        (item) => item.id === composerHighlightedItemId,
      )
      const normalizedIndex =
        highlightedIndex >= 0 ? highlightedIndex : key === 'ArrowDown' ? -1 : 0
      const offset = key === 'ArrowDown' ? 1 : -1
      const nextIndex =
        (normalizedIndex + offset + composerMenuItems.length) % composerMenuItems.length
      const nextItem = composerMenuItems[nextIndex]
      setComposerHighlightedItemId(nextItem?.id ?? null)
    },
    [composerHighlightedItemId, composerMenuItems],
  )

  const blurMobileComposerAfterSend = useCallback(() =>
  {
    if (!isMobileViewport) return
    if (composerBlurFrameRef.current !== null)
    {
      window.cancelAnimationFrame(composerBlurFrameRef.current)
      composerBlurFrameRef.current = null
    }
    const activeElement = document.activeElement
    if (activeElement instanceof HTMLElement)
    {
      activeElement.blur()
    }
    setIsComposerFocused(false)
  }, [isMobileViewport])

  const shouldBlurMobileComposerOnSubmit = useCallback(() =>
  {
    if (!isMobileViewport) return false
    if (
      isSendBusy ||
      isSendDisabled ||
      isConnecting ||
      (noProviderAvailable && !importContinuationSendBlocked) ||
      environmentUnavailable !== null ||
      phase === 'running'
    )
    {
      return false
    }
    if (activePendingProgress)
    {
      return activePendingProgress.isLastQuestion && Boolean(activePendingResolvedAnswers)
    }
    return showPlanFollowUpPrompt || composerSendState.hasSendableContent
  }, [
    activePendingProgress,
    activePendingResolvedAnswers,
    composerSendState.hasSendableContent,
    environmentUnavailable,
    isConnecting,
    importContinuationSendBlocked,
    isMobileViewport,
    isSendBusy,
    isSendDisabled,
    noProviderAvailable,
    phase,
    showPlanFollowUpPrompt,
  ])

  const submitComposer = useCallback(
    (event?: { preventDefault: () => void }) =>
    {
      if ((noProviderAvailable && !importContinuationSendBlocked) || isSendDisabled)
      {
        event?.preventDefault()
        return
      }
      // prevent a send from stranding an image in the next draft
      if (activeThreadId && (pendingImageCompressionsRef.current.get(activeThreadId) ?? 0) > 0)
      {
        event?.preventDefault()
        toastManager.add({
          type: 'info',
          title: 'Still compressing a pasted image.',
          description: 'Send again once its thumbnail appears.',
        })
        return
      }
      if (blockUnknownComposerSlashCommand(prompt, selectedProviderStatus?.slashCommands ?? []))
      {
        event?.preventDefault()
        return
      }
      if (
        shouldConfirmCompactComposerSlashCommand({
          text: prompt,
          providerSlashCommands: selectedProviderStatus?.slashCommands ?? [],
          hasAttachmentsOrContext:
            composerImages.length > 0 ||
            composerSendState.sendableTerminalContexts.length > 0 ||
            composerElementContexts.length > 0 ||
            composerPreviewAnnotations.length > 0 ||
            composerArchitectureContexts.length > 0 ||
            composerReviewComments.length > 0,
        })
      )
      {
        event?.preventDefault()
        setCompactConfirmationSource('composer')
        return
      }
      providerInputRejectedRef.current = false
      onSend(event)
      if (providerInputRejectedRef.current)
      {
        return
      }
      if (shouldBlurMobileComposerOnSubmit())
      {
        blurMobileComposerAfterSend()
      }
    },
    [
      activeThreadId,
      blurMobileComposerAfterSend,
      importContinuationSendBlocked,
      composerElementContexts.length,
      composerArchitectureContexts.length,
      composerImages.length,
      composerPreviewAnnotations.length,
      composerReviewComments.length,
      composerSendState.sendableTerminalContexts.length,
      isSendDisabled,
      noProviderAvailable,
      onSend,
      prompt,
      selectedProviderStatus,
      shouldBlurMobileComposerOnSubmit,
    ],
  )
  const expandMobileComposer = useCallback(() =>
  {
    if (composerBlurFrameRef.current !== null)
    {
      window.cancelAnimationFrame(composerBlurFrameRef.current)
      composerBlurFrameRef.current = null
    }
    if (mobileComposerExpandFrameRef.current !== null)
    {
      window.cancelAnimationFrame(mobileComposerExpandFrameRef.current)
    }
    if (mobileComposerExpandReleaseFrameRef.current !== null)
    {
      window.cancelAnimationFrame(mobileComposerExpandReleaseFrameRef.current)
    }
    mobileComposerExpandInFlightRef.current = true
    setIsComposerFocused(true)
    mobileComposerExpandFrameRef.current = window.requestAnimationFrame(() =>
    {
      mobileComposerExpandFrameRef.current = null
      composerEditorRef.current?.focusAtEnd()
      mobileComposerExpandReleaseFrameRef.current = window.requestAnimationFrame(() =>
      {
        mobileComposerExpandReleaseFrameRef.current = null
        mobileComposerExpandInFlightRef.current = false
      })
    })
  }, [])

  // callbacks: command key
  const onComposerCommandKey = (
    key: 'ArrowDown' | 'ArrowUp' | 'Enter' | 'Tab',
    event: KeyboardEvent,
  ) =>
  {
    if (key === 'Tab' && event.shiftKey)
    {
      toggleInteractionMode()
      return true
    }
    const { trigger } = resolveActiveComposerTrigger()
    const menuIsActive = composerMenuOpenRef.current || trigger !== null
    if (menuIsActive)
    {
      const currentItems = composerMenuItemsRef.current
      const selectedItem = activeComposerMenuItemRef.current ?? currentItems[0]
      if (key === 'ArrowDown' && currentItems.length > 0)
      {
        nudgeComposerMenuHighlight('ArrowDown')
        return true
      }
      if (key === 'ArrowUp' && currentItems.length > 0)
      {
        nudgeComposerMenuHighlight('ArrowUp')
        return true
      }
      if ((key === 'Enter' || key === 'Tab') && selectedItem)
      {
        onSelectComposerItem(selectedItem)
        return true
      }
    }
    if (
      key === 'Enter' &&
      shouldSubmitComposerOnEnter({ isMobileViewport, shiftKey: event.shiftKey })
    )
    {
      submitComposer()
      return true
    }
    return false
  }

  // prompt stash (⌘S)
  const stashScopeInstanceId = noProviderAvailable ? null : selectedInstanceId
  const stashScope = promptStashScopeKey(stashScopeInstanceId)
  const stashQueue = usePromptStashStore(
    (state) => state.queuesByScopeKey[stashScope] ?? EMPTY_PROMPT_STASH_QUEUE,
  )
  const stashOtherScopesCount = usePromptStashStore((state) =>
    Object.entries(state.queuesByScopeKey).reduce(
      (total, [key, queue]) => (key === stashScope ? total : total + queue.length),
      0,
    ),
  )
  const stashEntryToQueue = usePromptStashStore((state) => state.stashEntry)
  const takeStashEntry = usePromptStashStore((state) => state.takeEntry)
  const finalizeStashEntryImages = usePromptStashStore((state) => state.finalizeEntryImages)
  const stashProviderLabel = noProviderAvailable
    ? 'No provider'
    : getProviderDisplayName(providerStatuses, selectedProvider)

  useEffect(() =>
  {
    return () =>
    {
      if (stashPulseTimeoutRef.current !== null)
      {
        window.clearTimeout(stashPulseTimeoutRef.current)
      }
    }
  }, [])

  // briefly highlight the badge so the save registers without a flourish.
  const pulseStashBadge = useCallback(() =>
  {
    stashPulseKeyRef.current += 1
    setStashPulse({ key: stashPulseKeyRef.current, active: true })
    if (stashPulseTimeoutRef.current !== null)
    {
      window.clearTimeout(stashPulseTimeoutRef.current)
    }
    stashPulseTimeoutRef.current = window.setTimeout(() =>
    {
      stashPulseTimeoutRef.current = null
      setStashPulse((current) => ({ ...current, active: false }))
    }, 1200)
  }, [])

  const restoreStashEntry = useCallback(
    (entry: PromptStashEntry) =>
    {
      // remove first so a double activation (click + Enter) can't restore twice.
      const { entry: taken, durable } = takeStashEntry(
        promptStashScopeKey(entry.providerInstanceId),
        entry.id,
      )
      if (!taken) return
      if (!durable)
      {
        toastManager.add({
          type: 'warning',
          title: 'Restored prompt may reappear in the stash',
          description:
            'Browser storage rejected the update, so this entry could still be there after a reload.',
          data: { hideCopyButton: true },
        })
      }
      setIsStashMenuOpen(false)

      const currentPrompt = promptRef.current
      // an image-only stash must not append blank lines to whatever is
      // already in the composer.
      const nextPrompt =
        entry.prompt.length === 0
          ? currentPrompt
          : currentPrompt.trim().length
            ? `${currentPrompt.replace(/\s+$/, '')}\n\n${entry.prompt}`
            : entry.prompt
      const promptChanged = nextPrompt !== currentPrompt
      if (promptChanged)
      {
        promptRef.current = nextPrompt
        setComposerDraftPrompt(composerDraftTarget, nextPrompt)
        setComposerCursor(collapseExpandedComposerCursor(nextPrompt, nextPrompt.length))
        setComposerTrigger(null)
      }

      let unrestoredImageNames: string[] = []
      if (entry.attachments.length > 0)
      {
        const existingIds = new Set(composerImagesRef.current.map((image) => image.id))
        // the draft store also dedupes by mimeType+sizeBytes+name, so filter
        // on the same key here. Counting a duplicate against capacity would
        // burn a slot the store then refuses to fill, pushing a genuinely
        // unique image into the overflow list for nothing.
        const existingDedupKeys = new Set(
          composerImagesRef.current.map(
            (image) => `${image.mimeType}${image.sizeBytes}${image.name}`,
          ),
        )
        const capacity = Math.max(
          0,
          PROVIDER_SEND_TURN_MAX_ATTACHMENTS - composerImagesRef.current.length,
        )
        const pending = entry.attachments.filter(
          (attachment) =>
            !existingIds.has(attachment.id) &&
            !existingDedupKeys.has(
              `${attachment.mimeType}${attachment.sizeBytes}${attachment.name}`,
            ),
        )
        // anything past the attachment limit cannot be restored. The entry is
        // already out of the queue, so report the overflow by name instead of
        // discarding it silently.
        unrestoredImageNames = pending.slice(capacity).map((attachment) => attachment.name)
        const restoredImages = hydrateImagesFromPersisted(pending.slice(0, capacity))
        if (restoredImages.length > 0)
        {
          addComposerDraftImages(composerDraftTarget, restoredImages)
        }
      }

      const restorableSelection =
        entry.modelSelection &&
        providerInstanceEntries.some(
          (candidate) =>
            candidate.instanceId === entry.modelSelection?.instanceId &&
            candidate.enabled &&
            candidate.isAvailable,
        )
          ? entry.modelSelection
          : null
      if (restorableSelection)
      {
        setComposerDraftModelSelection(composerDraftTarget, restorableSelection, {
          replaceOptions: true,
        })
      }

      // each cause gets its own sentence so "too large" is never blamed for a
      // file that actually failed to decode, or for one the composer simply
      // had no room to take back.
      const missingImageReasons: string[] = []
      if (entry.droppedImageNames.length > 0)
      {
        missingImageReasons.push(
          `${entry.droppedImageNames.join(', ')} exceeded the stash size limit when this prompt was saved.`,
        )
      }
      if (entry.unreadableImageNames && entry.unreadableImageNames.length > 0)
      {
        missingImageReasons.push(
          `${entry.unreadableImageNames.join(', ')} could not be read when this prompt was saved.`,
        )
      }
      if (unrestoredImageNames.length > 0)
      {
        missingImageReasons.push(
          `${unrestoredImageNames.join(', ')} could not be restored: the composer is at its ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS}-image limit.`,
        )
      }
      if (missingImageReasons.length > 0)
      {
        toastManager.add({
          type: 'warning',
          title: 'Some images were not restored',
          description: missingImageReasons.join(' '),
        })
      }

      // only yank the caret to the end when text was actually inserted;
      // restoring images alone should leave the user where they were typing.
      if (promptChanged)
      {
        window.requestAnimationFrame(() =>
        {
          composerEditorRef.current?.focusAtEnd()
        })
      }
    },
    [
      addComposerDraftImages,
      composerDraftTarget,
      composerImagesRef,
      promptRef,
      providerInstanceEntries,
      setComposerDraftModelSelection,
      setComposerDraftPrompt,
      takeStashEntry,
    ],
  )

  const deleteStashEntry = useCallback(
    (entry: PromptStashEntry) =>
    {
      const { durable } = takeStashEntry(promptStashScopeKey(entry.providerInstanceId), entry.id)
      if (!durable)
      {
        toastManager.add({
          type: 'warning',
          title: 'Stash entry may come back',
          description:
            'Browser storage rejected the delete, so this prompt could reappear after a reload.',
          data: { hideCopyButton: true },
        })
      }
    },
    [takeStashEntry],
  )

  const stashCurrentPrompt = useCallback(async () =>
  {
    // terminal-context placeholders reference live sessions the stash can't
    // round-trip, so they are stripped from the stashed prompt.
    const prompt = promptRef.current.split(INLINE_TERMINAL_CONTEXT_PLACEHOLDER).join('').trim()
    const images = [...composerImagesRef.current]
    if (prompt.length === 0 && images.length === 0)
    {
      setIsStashMenuOpen((open) => !open)
      return
    }
    // a repeat ⌘S on the *same* still-unencoded snapshot would stash it
    // twice. Guard on the snapshot itself rather than a bare boolean: once
    // the composer has been cleared the user can type something genuinely
    // new (or switch threads) while encoding continues, and that deserves its
    // own entry.
    const snapshotKey = `${String(composerDraftTarget)}${prompt}${images
      .map((image) => image.id)
      .join(',')}`
    if (stashInFlightRef.current.has(snapshotKey)) return
    stashInFlightRef.current.add(snapshotKey)

    const stashTarget = composerDraftTarget
    const entryId = randomUUID()
    const scopeKey = promptStashScopeKey(stashScopeInstanceId)
    try
    {
      // persist the text-only entry *first*, then clear. Ordering matters in
      // both directions: writing before clearing means a crash or closed tab
      // mid-encode still leaves the prompt recoverable, while clearing before
      // the async image work means edits typed during encoding are not wiped.
      // images are appended to the stored entry as they finish encoding.
      const { evicted, durable } = stashEntryToQueue({
        id: entryId,
        createdAt: new Date().toISOString(),
        prompt,
        attachments: [],
        providerInstanceId: stashScopeInstanceId,
        modelSelection: noProviderAvailable ? null : selectedModelSelection,
        droppedImageNames: [],
        unreadableImageNames: [],
        pendingImageCount: images.length,
      })

      // clearing the composer is only safe once the entry is durable. If the
      // write was rejected (quota, blocked storage) the store has already
      // rolled itself back, so leave the composer untouched rather than
      // making it the second casualty of a reload.
      if (!durable)
      {
        toastManager.add({
          type: 'error',
          title: 'Could not stash this prompt',
          description:
            'Browser storage rejected the write, so the composer was left as-is. Free up site data and try again.',
          data: { hideCopyButton: true },
        })
        return
      }

      // only the prompt and images are cleared — terminal/element contexts,
      // preview annotations, and review comments are not stashable, so
      // destroying them here would be unrecoverable.
      promptRef.current = ''
      clearComposerDraftPromptAndImages(stashTarget)
      setComposerCursor(0)
      setComposerTrigger(null)
      pulseStashBadge()

      if (evicted)
      {
        toastManager.add({
          type: 'warning',
          title: 'Oldest stashed prompt discarded',
          description: `The ${stashProviderLabel} stash holds ${MAX_STASH_ENTRIES_PER_QUEUE} prompts; the oldest was removed to make room.`,
          data: { hideCopyButton: true },
        })
      }

      // images are re-encoded for the stash rather than stored verbatim: the
      // composer allows up to 10MB per image, but localStorage gives the whole
      // origin ~5MB. Only the stashed copy shrinks; the live attachment (and
      // anything sent without stashing) keeps the original file.
      const candidateAttachments: PersistedComposerImageAttachment[] = []
      const oversizedImageNames: string[] = []
      const unreadableImageNames: string[] = []
      for (const image of images)
      {
        const result = await compressImageForStash(image.file)
        if (!result.ok)
        {
          // "too large" and "could not be read" are distinct outcomes; the
          // menu and restore toast report them separately.
          ;(result.reason === 'too-large' ? oversizedImageNames : unreadableImageNames).push(
            image.name,
          )
          continue
        }
        candidateAttachments.push({
          id: image.id,
          name: image.name,
          mimeType: result.image.mimeType,
          sizeBytes: result.image.sizeBytes,
          dataUrl: result.image.dataUrl,
        })
      }
      const { kept, droppedNames } = partitionStashAttachments(candidateAttachments)

      const { attached, durable: imagesDurable } = finalizeStashEntryImages(scopeKey, entryId, {
        attachments: kept,
        droppedImageNames: [...oversizedImageNames, ...droppedNames],
        unreadableImageNames,
      })
      if (attached)
      {
        // the second phase can be rejected on its own: the text-only entry
        // fit, but adding image payloads pushed past the quota. Disk would
        // then still hold the phase-one entry with pendingImageCount set,
        // which reads as an orphan after reload — so say so now.
        if (!imagesDurable && images.length > 0)
        {
          toastManager.add({
            type: 'warning',
            title: 'Stashed images were not saved',
            description:
              'The prompt was stashed, but browser storage rejected its images. They will be missing if you reload.',
            data: { hideCopyButton: true },
          })
        }
      }
      else if (kept.length > 0)
      {
        // the entry was restored or deleted before its images finished
        // encoding, so they have nowhere to land. Say so rather than letting
        // them evaporate.
        toastManager.add({
          type: 'warning',
          title: 'Stashed images did not attach',
          description: `That prompt was restored or deleted before ${kept.length} image${kept.length === 1 ? '' : 's'} finished saving. Re-attach ${kept.length === 1 ? 'it' : 'them'} if you still need ${kept.length === 1 ? 'it' : 'them'}.`,
          data: { hideCopyButton: true },
        })
      }
    }
    finally
    {
      // must clear on every path: a throw that left this set would wedge this
      // snapshot's ⌘S until the composer remounts.
      stashInFlightRef.current.delete(snapshotKey)
    }
  }, [
    clearComposerDraftPromptAndImages,
    composerDraftTarget,
    composerImagesRef,
    finalizeStashEntryImages,
    noProviderAvailable,
    promptRef,
    pulseStashBadge,
    selectedModelSelection,
    stashEntryToQueue,
    stashProviderLabel,
    stashScopeInstanceId,
  ])

  const toggleStashMenu = useCallback(() =>
  {
    setIsStashMenuOpen((open) => !open)
  }, [])

  // close the stash menu whenever the trigger-driven command menu opens so
  // the two popovers never stack in the same layer, and when the user
  // resumes typing (the menu is a transient picker, not a panel).
  useEffect(() =>
  {
    if (composerMenuOpen)
    {
      setIsStashMenuOpen(false)
    }
  }, [composerMenuOpen])
  useEffect(() =>
  {
    setIsStashMenuOpen(false)
  }, [prompt])

  useEffect(() =>
  {
    const handler = (event: globalThis.KeyboardEvent) =>
    {
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: getTerminalFocusOwner() !== null,
          terminalOpen,
          modelPickerOpen: isComposerModelPickerOpen,
        },
      })
      if (command !== 'composer.stash') return
      // always claim the shortcut so the browser save dialog never opens,
      // even when the composer is in a state that can't stash.
      event.preventDefault()
      event.stopPropagation()
      if (
        isCommandPaletteOpen() ||
        isComposerApprovalState ||
        pendingUserInputs.length > 0 ||
        projectSelectionRequired ||
        activePendingProgress !== null
      )
      {
        return
      }
      void stashCurrentPrompt()
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [
    activePendingProgress,
    isComposerApprovalState,
    isComposerModelPickerOpen,
    keybindings,
    pendingUserInputs.length,
    projectSelectionRequired,
    stashCurrentPrompt,
    terminalOpen,
  ])

  // callbacks: images
  const addComposerImages = async (files: File[]) =>
  {
    if (!activeThreadId || files.length === 0) return
    if (!supportsImageAttachments)
    {
      setThreadError(activeThreadId, 'This provider does not support image attachments.')
      return
    }
    if (pendingUserInputs.length > 0)
    {
      toastManager.add({
        type: 'error',
        title: 'Attach images after answering plan questions.',
      })
      return
    }
    // keep async compression attached to the thread where the paste occurred
    const threadId = activeThreadId

    // reserve slots before awaiting so concurrent pastes share the limit
    const pendingCount = pendingImageCompressionsRef.current.get(threadId) ?? 0
    let reservedCount = composerImagesRef.current.length + pendingCount
    const acceptedFiles: File[] = []
    let error: string | null = null
    for (const file of files)
    {
      const isHeic = isHeicImageFile(file)
      if (!file.type.startsWith('image/') && !isHeic)
      {
        error = `Unsupported file type for '${file.name}'. Please attach image files only.`
        continue
      }
      if (!isHeic && !isProviderSendTurnSupportedImageMimeType(file.type))
      {
        error = `'${file.name}' is not a supported image type. Attach GIF, HEIC, HEIF, JPEG, PNG, or WebP images.`
        continue
      }
      if (reservedCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS)
      {
        error = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} images per message.`
        break
      }
      acceptedFiles.push(file)
      reservedCount += 1
    }
    setThreadError(threadId, error)
    if (acceptedFiles.length === 0) return

    pendingImageCompressionsRef.current.set(threadId, pendingCount + acceptedFiles.length)
    try
    {
      const nextImages: ComposerImageAttachment[] = []
      let compressionError: string | null = null
      for (const file of acceptedFiles)
      {
        // heic converts first; ordinary supported images keep the existing pass-through path
        const compressed = await prepareImageForAttachment(file, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)
        if (!compressed.ok)
        {
          compressionError =
            compressed.reason === 'unreadable'
              ? `'${file.name}' could not be read as an image.`
              : `'${file.name}' is too large to attach, even after compression.`
          continue
        }
        const attachmentFile = compressed.file
        const previewUrl = URL.createObjectURL(attachmentFile)
        nextImages.push({
          type: 'image',
          id: randomUUID(),
          name: attachmentFile.name || 'image',
          mimeType: attachmentFile.type,
          sizeBytes: attachmentFile.size,
          previewUrl,
          file: attachmentFile,
        })
      }
      if (nextImages.length === 1 && nextImages[0])
      {
        addComposerImage(nextImages[0])
      }
      else if (nextImages.length > 1)
      {
        addComposerImagesToDraft(nextImages)
      }
      // do not clear errors that overlapping work may have written
      if (compressionError !== null)
      {
        setThreadError(threadId, compressionError)
      }
    }
    finally
    {
      const remaining =
        (pendingImageCompressionsRef.current.get(threadId) ?? 0) - acceptedFiles.length
      if (remaining > 0)
      {
        pendingImageCompressionsRef.current.set(threadId, remaining)
      }
      else
      {
        pendingImageCompressionsRef.current.delete(threadId)
      }
    }
  }

  const removeComposerImage = (imageId: string) =>
  {
    removeComposerImageFromDraft(imageId)
  }

  // callbacks: paste / drag
  const onComposerPaste = (event: React.ClipboardEvent<HTMLElement>) =>
  {
    const files = Array.from(event.clipboardData.files)
    if (files.length === 0) return
    const imageFiles = files.filter(
      (file) => file.type.startsWith('image/') || isHeicImageFile(file),
    )
    if (imageFiles.length === 0) return
    event.preventDefault()
    void addComposerImages(imageFiles)
  }

  const insertComposerTextAtEnd = (
    text: string,
    options?: { ensureLeadingBoundary?: boolean },
  ): boolean =>
  {
    if (
      text.length === 0 ||
      isConnecting ||
      isComposerApprovalState ||
      pendingUserInputs.length > 0 ||
      projectSelectionRequired
    )
    {
      return false
    }
    const prompt = promptRef.current
    const needsLeadingSpace =
      (options?.ensureLeadingBoundary ?? false) && prompt.length > 0 && !/\s$/.test(prompt)
    return applyPromptReplacement(
      prompt.length,
      prompt.length,
      needsLeadingSpace ? ` ${text}` : text,
    )
  }

  // file-tree drags land as mentions. Handled in the capture phase so the
  // editor never sees the drop; the load-bearing rules (native stop, "move"
  // effect, no eager focus) live in makeComposerMentionDragHandlers.
  const composerMentionDragHandlers = makeComposerMentionDragHandlers({
    insertMentionAtEnd: (text) => insertComposerTextAtEnd(text, { ensureLeadingBoundary: true }),
    setDragActive: setIsDragOverComposer,
    onInsertRejected: () =>
    {
      toastManager.add({
        type: 'error',
        title: 'Unable to add to chat',
        description: 'The composer is busy; try again once it is ready.',
      })
    },
  })

  const onComposerMentionDragLeaveCapture = (event: React.DragEvent<HTMLDivElement>) =>
  {
    if (!dataTransferHasComposerMention(event.dataTransfer.types)) return
    event.stopPropagation()
    const nextTarget = event.relatedTarget
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return
    setIsDragOverComposer(false)
  }

  // a cancelled drag (Escape) can end without a dragleave on the hovered
  // target, which would leave the drop highlight stuck. dragend always fires
  // on the in-page drag source and bubbles to window, so it is the reset of
  // last resort while the highlight is up.
  useEffect(() =>
  {
    if (!isDragOverComposer) return
    const onWindowDragEnd = () =>
    {
      setIsDragOverComposer(false)
    }
    window.addEventListener('dragend', onWindowDragEnd)
    return () => window.removeEventListener('dragend', onWindowDragEnd)
  }, [isDragOverComposer])
  const handleInterruptPrimaryAction = useCallback(() =>
  {
    void onInterrupt()
  }, [onInterrupt])
  const handleImplementPlanInNewThreadPrimaryAction = useCallback(() =>
  {
    void onImplementPlanInNewThread()
  }, [onImplementPlanInNewThread])
  const handleImplementPlanWithOrchestratePrimaryAction = useCallback(() =>
  {
    void onImplementPlanWithOrchestrate()
  }, [onImplementPlanWithOrchestrate])
  const handleImplementPlanWithOrchestrateInNewThreadPrimaryAction = useCallback(() =>
  {
    void onImplementPlanInNewThread('orchestrate')
  }, [onImplementPlanInNewThread])
  const scheduleComposerCollapseCheck = useCallback(() =>
  {
    if (!isMobileViewport)
    {
      return
    }
    if (mobileComposerExpandInFlightRef.current)
    {
      return
    }
    if (composerBlurFrameRef.current !== null)
    {
      window.cancelAnimationFrame(composerBlurFrameRef.current)
    }
    composerBlurFrameRef.current = window.requestAnimationFrame(() =>
    {
      composerBlurFrameRef.current = null
      if (mobileComposerExpandInFlightRef.current)
      {
        return
      }
      const composerSurface = composerSurfaceRef.current
      const activeElement = document.activeElement
      if (activeElement instanceof Element && isInsideComposerFloatingLayer(activeElement))
      {
        return
      }
      if (
        composerSurface &&
        activeElement instanceof Node &&
        composerSurface.contains(activeElement)
      )
      {
        return
      }
      setIsComposerFocused(false)
    })
  }, [isMobileViewport])

  useEffect(() =>
  {
    return () =>
    {
      if (composerBlurFrameRef.current !== null)
      {
        window.cancelAnimationFrame(composerBlurFrameRef.current)
      }
      if (mobileComposerExpandFrameRef.current !== null)
      {
        window.cancelAnimationFrame(mobileComposerExpandFrameRef.current)
      }
      if (mobileComposerExpandReleaseFrameRef.current !== null)
      {
        window.cancelAnimationFrame(mobileComposerExpandReleaseFrameRef.current)
      }
    }
  }, [])

  // imperative handle
  useImperativeHandle(
    composerRef,
    () => ({
      focusAtEnd: () =>
      {
        composerEditorRef.current?.focusAtEnd()
      },
      focusAt: (cursor: number) =>
      {
        composerEditorRef.current?.focusAt(cursor)
      },
      addDroppedFiles: (files: File[]) =>
      {
        if (isSendBusy || isConnecting || providerSwitch !== null || !supportsImageAttachments)
          return
        void addComposerImages(files)
        focusComposer()
      },
      insertTextAtEnd: insertComposerTextAtEnd,
      openModelPicker: () =>
      {
        setIsComposerModelPickerOpen(true)
      },
      toggleModelPicker: () =>
      {
        setIsComposerModelPickerOpen((open) => !open)
      },
      isModelPickerOpen: () => isComposerModelPickerOpen,
      readSnapshot: () =>
      {
        return readComposerSnapshot()
      },
      resetCursorState: (options?: {
        cursor?: number
        prompt?: string
        detectTrigger?: boolean
      }) =>
      {
        const promptForState = options?.prompt ?? promptRef.current
        const cursor = clampCollapsedComposerCursor(promptForState, options?.cursor ?? 0)
        setComposerHighlightedItemId(null)
        setComposerCursor(cursor)
        setComposerTrigger(
          options?.detectTrigger
            ? detectComposerTrigger(
                promptForState,
                expandCollapsedComposerCursor(promptForState, cursor),
              )
            : null,
        )
      },
      addTerminalContext: (selection: TerminalContextSelection) =>
      {
        if (!activeThread) return
        const snapshot = composerEditorRef.current?.readSnapshot() ?? {
          value: promptRef.current,
          cursor: composerCursor,
          expandedCursor: expandCollapsedComposerCursor(promptRef.current, composerCursor),
          terminalContextIds: composerTerminalContexts.map((context) => context.id),
        }
        const insertion = insertInlineTerminalContextPlaceholder(
          snapshot.value,
          snapshot.expandedCursor,
        )
        const nextCollapsedCursor = collapseExpandedComposerCursor(
          insertion.prompt,
          insertion.cursor,
        )
        const inserted = insertComposerDraftTerminalContext(
          composerDraftTarget,
          insertion.prompt,
          {
            id: randomUUID(),
            threadId: activeThread.id,
            createdAt: new Date().toISOString(),
            ...selection,
          },
          insertion.contextIndex,
        )
        if (!inserted) return
        promptRef.current = insertion.prompt
        setComposerCursor(nextCollapsedCursor)
        setComposerTrigger(detectComposerTrigger(insertion.prompt, insertion.cursor))
        window.requestAnimationFrame(() =>
        {
          composerEditorRef.current?.focusAt(nextCollapsedCursor)
        })
      },
      validateProviderInput: (providerInput: string) =>
      {
        const validationMessage = getProviderInputLengthValidationMessage(providerInput)
        providerInputRejectedRef.current = validationMessage !== null
        setProviderInputSubmissionError(validationMessage)
        return validationMessage === null
      },
      getSendContext: () => ({
        prompt: promptRef.current,
        images: composerImagesRef.current,
        terminalContexts: composerTerminalContextsRef.current,
        elementContexts: composerElementContextsRef.current,
        previewAnnotations: composerPreviewAnnotations,
        architectureContexts: composerArchitectureContexts,
        reviewComments: composerReviewComments,
        selectedPromptEffort,
        selectedModelOptionsForDispatch,
        selectedModelSelection,
        providerAvailable: !noProviderAvailable,
        selectedProvider,
        selectedModel,
        selectedProviderModels,
        selectedProviderSlashCommands: selectedProviderStatus?.slashCommands ?? [],
        selectedProviderCapabilities,
        runtimeMode: runtimeModeForSend(
          runtimeMode,
          selectedProviderCapabilities.supportedRuntimeModes,
        ),
      }),
    }),
    [
      activeThread,
      addComposerImages,
      composerDraftTarget,
      composerCursor,
      composerTerminalContexts,
      focusComposer,
      insertComposerDraftTerminalContext,
      isSendBusy,
      promptRef,
      providerSwitch,
      composerImagesRef,
      composerTerminalContextsRef,
      composerElementContextsRef,
      composerPreviewAnnotations,
      composerArchitectureContexts,
      composerReviewComments,
      isConnecting,
      isComposerApprovalState,
      pendingUserInputs.length,
      projectSelectionRequired,
      applyPromptReplacement,
      isComposerModelPickerOpen,
      readComposerSnapshot,
      selectedModel,
      selectedModelOptionsForDispatch,
      selectedModelSelection,
      noProviderAvailable,
      selectedPromptEffort,
      selectedProvider,
      selectedProviderModels,
      selectedProviderStatus,
      runtimeMode,
      selectedProviderCapabilities,
    ],
  )

  // render
  return (
    <form
      ref={composerFormRef}
      onSubmit={submitComposer}
      className="mx-auto w-full min-w-0 max-w-3xl"
      data-chat-composer-form="true"
    >
      <div
        className={cn(
          'group rounded-[22px] p-px transition-colors duration-200',
          composerProviderState.composerFrameClassName,
        )}
        onDragEnterCapture={composerMentionDragHandlers.onDragEnter}
        onDragOverCapture={composerMentionDragHandlers.onDragOver}
        onDragLeaveCapture={onComposerMentionDragLeaveCapture}
        onDropCapture={composerMentionDragHandlers.onDrop}
      >
        <div
          ref={composerSurfaceRef}
          data-chat-composer-mobile-collapsed={isComposerCollapsedMobile ? 'true' : 'false'}
          className={cn(
            'rounded-[20px] transition-[background-color] duration-200',
            isDragOverComposer ? 'bg-accent/45 ring-1 ring-primary/70' : null,
            projectSelectionRequired ? 'opacity-75' : null,
            composerProviderState.composerSurfaceClassName,
          )}
          onFocusCapture={(event) =>
          {
            const activeElement = event.target
            if (
              isComposerCollapsedMobile &&
              activeElement instanceof HTMLElement &&
              activeElement.closest('[data-chat-composer-collapsed-controls="true"]')
            )
            {
              return
            }
            if (composerBlurFrameRef.current !== null)
            {
              window.cancelAnimationFrame(composerBlurFrameRef.current)
              composerBlurFrameRef.current = null
            }
            setIsComposerFocused(true)
          }}
          onBlurCapture={() =>
          {
            scheduleComposerCollapseCheck()
          }}
        >
          {!isComposerCollapsedMobile &&
            (activePendingApproval ? (
              <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
                <ComposerPendingApprovalPanel
                  approval={activePendingApproval}
                  pendingCount={pendingApprovals.length}
                />
              </div>
            ) : pendingUserInputs.length > 0 ? (
              <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
                <ComposerPendingUserInputPanel
                  pendingUserInputs={pendingUserInputs}
                  respondingRequestIds={respondingRequestIds}
                  answers={activePendingDraftAnswers}
                  questionIndex={activePendingQuestionIndex}
                  onToggleOption={onSelectActivePendingUserInputOption}
                  onAdvance={onAdvanceActivePendingUserInput}
                />
              </div>
            ) : showPlanFollowUpPrompt && activeProposedPlan ? (
              <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
                <ComposerPlanFollowUpBanner
                  key={activeProposedPlan.id}
                  planTitle={proposedPlanTitle(activeProposedPlan.planMarkdown) ?? null}
                />
              </div>
            ) : null)}

          {isComposerCollapsedMobile && activePendingApproval ? (
            <div
              className="rounded-t-[19px] border-b border-border/65 bg-muted/20"
              data-chat-composer-collapsed-controls="true"
            >
              <ComposerPendingApprovalPanel
                approval={activePendingApproval}
                pendingCount={pendingApprovals.length}
              />
              <div className="flex flex-wrap items-center justify-end gap-2 px-3 pb-3 sm:px-4">
                <ComposerPendingApprovalActions
                  requestId={activePendingApproval.requestId}
                  isResponding={respondingRequestIds.includes(activePendingApproval.requestId)}
                  onRespondToApproval={onRespondToApproval}
                  options={activePendingApproval.options}
                />
              </div>
            </div>
          ) : isComposerCollapsedMobile && pendingUserInputs.length > 0 ? (
            <div
              className="rounded-t-[19px] border-b border-border/65 bg-muted/20"
              data-chat-composer-collapsed-controls="true"
            >
              <ComposerPendingUserInputPanel
                pendingUserInputs={pendingUserInputs}
                respondingRequestIds={respondingRequestIds}
                answers={activePendingDraftAnswers}
                questionIndex={activePendingQuestionIndex}
                onToggleOption={onSelectActivePendingUserInputOption}
                onAdvance={onAdvanceActivePendingUserInput}
              />
              <div className="px-3 pb-3 sm:px-4">
                <div
                  data-chat-composer-mobile-pending-compact="true"
                  className={cn(
                    'flex min-w-0 items-center gap-2 rounded-lg border border-border/55 bg-background/55 p-1.5 pl-3 transition-colors hover:bg-background/80',
                    !activePendingProgress?.activeQuestion?.multiSelect && 'p-0',
                  )}
                >
                  <button
                    type="button"
                    className={cn(
                      'min-w-0 flex-1 truncate bg-transparent py-1.5 text-left text-sm',
                      activePendingProgress?.customAnswer
                        ? 'text-foreground'
                        : 'text-muted-foreground/60',
                      !activePendingProgress?.activeQuestion?.multiSelect && 'px-3 py-2',
                    )}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={expandMobileComposer}
                    aria-label="Write custom answer"
                  >
                    {activePendingProgress?.customAnswer || 'Write custom answer'}
                  </button>
                  {collapsedMobilePendingActions.visible ? (
                    <ComposerPrimaryActions
                      compact
                      pendingAction={collapsedMobilePendingActions.pendingAction}
                      isRunning={isTurnRunning}
                      showPlanFollowUpPrompt={false}
                      promptHasText={false}
                      isSendBusy={isSendBusy}
                      sendDisabledReason={effectiveSendDisabledReason}
                      isConnecting={isConnecting}
                      isEnvironmentUnavailable={
                        environmentUnavailable !== null ||
                        (noProviderAvailable && !importContinuationSendBlocked) ||
                        projectSelectionRequired
                      }
                      isPreparingWorktree={false}
                      hasSendableContent={false}
                      preserveComposerFocusOnPointerDown
                      showOrchestrate={composerProviderControls.showOrchestrate}
                      onPreviousPendingQuestion={onPreviousActivePendingUserInputQuestion}
                      onInterrupt={handleInterruptPrimaryAction}
                      onImplementPlanWithOrchestrate={
                        handleImplementPlanWithOrchestratePrimaryAction
                      }
                      onImplementPlanInNewThread={handleImplementPlanInNewThreadPrimaryAction}
                      onImplementPlanWithOrchestrateInNewThread={
                        handleImplementPlanWithOrchestrateInNewThreadPrimaryAction
                      }
                      orchestrateReadinessMessage={planOrchestrateNotReadyMessage}
                    />
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}

          {showCollapsedMobilePromptRow ? (
            <div className="flex items-center justify-between gap-2 px-3 py-2">
              <button
                type="button"
                className={cn(
                  'min-w-0 flex-1 truncate bg-transparent p-0 text-left text-[14px] focus:outline-none',
                  (activePendingProgress ? activePendingProgress.customAnswer : prompt.trim())
                    ? 'text-foreground'
                    : 'text-muted-foreground/35',
                )}
                onPointerDown={(event) => event.preventDefault()}
                onClick={expandMobileComposer}
                aria-label="Expand composer"
              >
                {activePendingProgress
                  ? activePendingProgress.customAnswer ||
                    'Type your own answer, or leave this blank to use the selected option'
                  : prompt.trim() ||
                    (noProviderAvailable
                      ? importContinuationSendBlocked
                        ? 'Review the imported session notice before sending'
                        : 'Enable a provider in Settings'
                      : 'Ask anything...')}
              </button>
              <button
                type="button"
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/90 text-primary-foreground disabled:opacity-30"
                disabled={collapsedComposerPrimaryActionDisabled}
                aria-label={collapsedComposerPrimaryActionLabel}
                onPointerDown={(event) => event.preventDefault()}
                onClick={(event) =>
                  {
                  event.stopPropagation()
                  submitComposer()
                }}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M8 3L8 13M8 3L4 7M8 3L12 7"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>
          ) : null}

          <div
            ref={setComposerMenuAnchor}
            className={cn(
              'relative px-3 pb-2 sm:px-4',
              hasComposerHeader ? 'pt-2.5 sm:pt-3' : 'pt-3.5 sm:pt-4',
              isComposerCollapsedMobile && 'hidden',
            )}
          >
            <ComposerStashBadge
              count={stashQueue.length}
              pulseKey={stashPulse.key}
              pulsing={stashPulse.active}
              menuOpen={isStashMenuOpen}
              onToggleMenu={toggleStashMenu}
            />

            {isStashMenuOpen && !composerMenuOpen && !isComposerApprovalState && (
              <ComposerCommandMenuLayer anchor={composerMenuAnchor}>
                <ComposerStashMenu
                  entries={stashQueue}
                  stashShortcutLabel={shortcutLabelForCommand(keybindings, 'composer.stash', {
                    context: {
                      terminalFocus: false,
                      terminalOpen,
                      modelPickerOpen: false,
                    },
                  })}
                  providerLabel={stashProviderLabel}
                  otherScopesCount={stashOtherScopesCount}
                  onRestore={restoreStashEntry}
                  onDelete={deleteStashEntry}
                  onClose={() => setIsStashMenuOpen(false)}
                />
              </ComposerCommandMenuLayer>
            )}

            {composerMenuOpen && !isComposerApprovalState && (
              <ComposerCommandMenuLayer anchor={composerMenuAnchor}>
                <ComposerCommandMenu
                  items={composerMenuItems}
                  resolvedTheme={resolvedTheme}
                  isLoading={isComposerMenuLoading}
                  triggerKind={composerTriggerKind}
                  groupSlashCommandSections={
                    composerTrigger?.kind === 'slash-command' &&
                    composerTrigger.query.trim().length === 0
                  }
                  emptyStateText={composerMenuEmptyState}
                  activeItemId={activeComposerMenuItem?.id ?? null}
                  onHighlightedItemChange={onComposerMenuItemHighlighted}
                  onSelect={onSelectComposerItem}
                />
              </ComposerCommandMenuLayer>
            )}

            {!isComposerCollapsedMobile &&
              !isComposerApprovalState &&
              pendingUserInputs.length === 0 &&
              composerPreviewAnnotations.length > 0 && (
                <ComposerPreviewAnnotationCards
                  annotations={composerPreviewAnnotations}
                  images={composerImages}
                  onRemove={(annotationId) =>
                    removeComposerDraftPreviewAnnotation(composerDraftTarget, annotationId)
                  }
                  onExpandImage={(imageId) =>
                  {
                    const preview = buildExpandedImagePreview(composerImages, imageId)
                    if (preview) onExpandImage(preview)
                  }}
                  className="mb-3"
                />
              )}

            {!isComposerCollapsedMobile &&
              !isComposerApprovalState &&
              pendingUserInputs.length === 0 &&
              composerArchitectureContexts.length > 0 && (
                <ComposerPendingArchitectureContexts
                  className="mb-3"
                  contexts={composerArchitectureContexts}
                  onRemove={(contextId) =>
                    removeComposerDraftArchitectureContext(composerDraftTarget, contextId)
                  }
                />
              )}

            {!isComposerCollapsedMobile &&
              !isComposerApprovalState &&
              pendingUserInputs.length === 0 &&
              composerReviewComments.length > 0 && (
                <ComposerPendingReviewComments
                  comments={composerReviewComments}
                  onRemove={(commentId) =>
                    removeComposerDraftReviewComment(composerDraftTarget, commentId)
                  }
                  className="mb-3"
                />
              )}

            {!isComposerCollapsedMobile &&
              !isComposerApprovalState &&
              pendingUserInputs.length === 0 &&
              composerElementContexts.length > 0 && (
                <ComposerPendingElementContexts
                  contexts={composerElementContexts}
                  onRemove={(contextId) =>
                    removeComposerDraftElementContext(composerDraftTarget, contextId)
                  }
                  className="mb-3"
                />
              )}

            {!isComposerCollapsedMobile &&
              !isComposerApprovalState &&
              pendingUserInputs.length === 0 &&
              composerImages.some(
                (image) =>
                  !composerPreviewAnnotations.some((annotation) => annotation.id === image.id),
              ) && (
                <div className="mb-3 flex flex-wrap gap-2">
                  {composerImages
                    .filter(
                      (image) =>
                        !composerPreviewAnnotations.some(
                          (annotation) => annotation.id === image.id,
                        ),
                    )
                    .map((image) => (
                      <div
                        key={image.id}
                        className="relative h-16 w-16 overflow-hidden rounded-lg border border-border/80 bg-background"
                      >
                        {image.previewUrl ? (
                          <button
                            type="button"
                            className="h-full w-full cursor-zoom-in"
                            aria-label={`Preview ${image.name}`}
                            onClick={() =>
                              {
                              const preview = buildExpandedImagePreview(composerImages, image.id)
                              if (!preview) return
                              onExpandImage(preview)
                            }}
                          >
                            <img
                              src={image.previewUrl}
                              alt={image.name}
                              className="h-full w-full object-cover"
                            />
                          </button>
                        ) : (
                          <div className="flex h-full w-full items-center justify-center px-1 text-center text-[10px] text-muted-foreground/70">
                            {image.name}
                          </div>
                        )}
                        {nonPersistedComposerImageIdSet.has(image.id) && (
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <span
                                  role="img"
                                  aria-label="Draft attachment may not persist"
                                  className="absolute left-1 top-1 inline-flex items-center justify-center rounded bg-background/85 p-0.5 text-amber-600"
                                >
                                  <CircleAlertIcon className="size-3" />
                                </span>
                              }
                            />
                            <TooltipPopup
                              side="top"
                              className="max-w-64 whitespace-normal leading-tight"
                            >
                              Draft attachment could not be saved locally and may be lost on
                              navigation.
                            </TooltipPopup>
                          </Tooltip>
                        )}
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="absolute right-1 top-1 bg-background/80 hover:bg-background/90"
                          onClick={() => removeComposerImage(image.id)}
                          aria-label={`Remove ${image.name}`}
                        >
                          <XIcon />
                        </Button>
                      </div>
                    ))}
                </div>
              )}

            <div className="relative">
              <ComposerPromptEditor
                editorRef={composerEditorRef}
                value={
                  isComposerApprovalState
                    ? ''
                    : activePendingProgress
                      ? activePendingProgress.customAnswer
                      : prompt
                }
                cursor={composerCursor}
                terminalContexts={
                  !isComposerApprovalState && pendingUserInputs.length === 0
                    ? composerTerminalContexts
                    : []
                }
                skills={selectedProviderStatus?.skills ?? []}
                {...(showMobilePendingAnswerActions ? { className: 'max-sm:pb-11' } : {})}
                onRemoveTerminalContext={removeComposerTerminalContextFromDraft}
                onChange={onPromptChange}
                onCommandKeyDown={onComposerCommandKey}
                onPaste={onComposerPaste}
                placeholder={
                  isComposerApprovalState
                    ? (activePendingApproval?.detail ?? 'Resolve this approval request to continue')
                    : activePendingProgress
                      ? 'Type your own answer, or leave this blank to use the selected option'
                      : showPlanFollowUpPrompt && activeProposedPlan
                        ? 'Add feedback to refine the plan, or leave this blank to implement it'
                        : projectSelectionRequired
                          ? 'Choose a project above to start a thread'
                          : noProviderAvailable
                            ? importContinuationSendBlocked
                              ? 'Review the imported session notice before sending'
                              : 'Enable a provider in Settings to send a message'
                            : phase === 'disconnected'
                              ? DISCONNECTED_COMPOSER_PLACEHOLDER
                              : 'Ask anything, @tag files/folders, $use skills, or / for commands'
                }
                disabled={isConnecting || isComposerApprovalState || projectSelectionRequired}
              />
              {showMobilePendingAnswerActions ? (
                <div
                  data-chat-composer-mobile-pending-actions="true"
                  className="absolute bottom-0 right-0 flex justify-end"
                >
                  <ComposerPrimaryActions
                    compact
                    pendingAction={pendingPrimaryAction}
                    isRunning={isTurnRunning}
                    showPlanFollowUpPrompt={false}
                    promptHasText={false}
                    isSendBusy={isSendBusy}
                    sendDisabledReason={effectiveSendDisabledReason}
                    isConnecting={isConnecting}
                    isEnvironmentUnavailable={
                      environmentUnavailable !== null ||
                      (noProviderAvailable && !importContinuationSendBlocked) ||
                      projectSelectionRequired
                    }
                    isPreparingWorktree={false}
                    hasSendableContent={false}
                    preserveComposerFocusOnPointerDown
                    showOrchestrate={composerProviderControls.showOrchestrate}
                    onPreviousPendingQuestion={onPreviousActivePendingUserInputQuestion}
                    onInterrupt={handleInterruptPrimaryAction}
                    onImplementPlanWithOrchestrate={handleImplementPlanWithOrchestratePrimaryAction}
                    onImplementPlanInNewThread={handleImplementPlanInNewThreadPrimaryAction}
                    onImplementPlanWithOrchestrateInNewThread={
                      handleImplementPlanWithOrchestrateInNewThreadPrimaryAction
                    }
                    orchestrateReadinessMessage={planOrchestrateNotReadyMessage}
                  />
                </div>
              ) : null}
            </div>
          </div>

          {providerInputSubmissionError ? (
            <p
              role="alert"
              data-chat-composer-validation="prompt-length"
              className="px-3 pb-2 text-xs text-destructive sm:px-4"
            >
              {providerInputSubmissionError}
            </p>
          ) : null}

          {/* Bottom toolbar */}
          {isComposerCollapsedMobile ? null : activePendingApproval ? (
            <div className="flex flex-wrap items-center justify-end gap-2 px-2.5 pb-2.5 sm:px-3 sm:pb-3">
              <ComposerPendingApprovalActions
                requestId={activePendingApproval.requestId}
                isResponding={respondingRequestIds.includes(activePendingApproval.requestId)}
                onRespondToApproval={onRespondToApproval}
                options={activePendingApproval.options}
              />
            </div>
          ) : (
            <div
              data-chat-composer-footer="true"
              data-chat-composer-footer-compact={isComposerFooterCompact ? 'true' : 'false'}
              className={cn(
                'flex min-w-0 flex-nowrap items-center justify-between gap-2 overflow-visible px-2.5 pb-2.5 sm:px-3 sm:pb-3',
                pendingUserInputs.length > 0 && 'pt-2',
                isComposerFooterCompact ? 'gap-1.5' : 'gap-2 sm:gap-0',
                showMobilePendingAnswerActions && 'hidden sm:flex',
              )}
            >
              <div className="-m-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {noProviderAvailable ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled
                    data-chat-provider-unavailable="true"
                    className="shrink-0 gap-2 px-2 text-muted-foreground/70 sm:px-3"
                  >
                    <CircleAlertIcon className="size-4" />
                    No provider available
                  </Button>
                ) : (
                  <ProviderModelPicker
                    compact={isComposerFooterCompact}
                    activeInstanceId={selectedInstanceId}
                    model={selectedModelForPickerWithCustomFallback}
                    lockedProvider={lockedProvider}
                    lockedContinuationGroupKey={lockedContinuationGroupKey}
                    instanceEntries={providerInstanceEntries}
                    keybindings={keybindings}
                    modelOptionsByInstance={modelOptionsByInstance}
                    switchableThreadProviderInstanceId={switchableThreadProviderInstanceId}
                    modelSwitchCacheHint={modelSwitchCacheHint}
                    terminalOpen={terminalOpen}
                    disabled={providerSwitch !== null}
                    open={isComposerModelPickerOpen}
                    {...(composerProviderState.modelPickerIconClassName
                      ? {
                          activeProviderIconClassName:
                            composerProviderState.modelPickerIconClassName,
                        }
                      : {})}
                    onOpenChange={(open) =>
                      {
                      setIsComposerModelPickerOpen(open)
                    }}
                    getModelDisabledReason={getModelDisabledReason}
                    onInstanceModelChange={onProviderModelSelect}
                  />
                )}

                {isComposerFooterCompact ? (
                  <CompactComposerControlsMenu
                    activePlan={showPlanSidebarToggle}
                    collaborationMode={collaborationMode}
                    planSidebarLabel={planSidebarLabel}
                    planSidebarOpen={planSidebarOpen}
                    runtimeMode={runtimeMode}
                    showOrchestrate={composerProviderControls.showOrchestrate}
                    showPlanMode={composerProviderControls.showInteractionModeToggle}
                    supportedRuntimeModes={composerProviderControls.supportedRuntimeModes}
                    traitsMenuContent={providerTraitsMenuContent}
                    onInteractionModeChange={handleComposerModeChange}
                    onOrchestrateChange={handleComposerOrchestrateChange}
                    onTogglePlanSidebar={togglePlanSidebar}
                    onRuntimeModeChange={handleRuntimeModeChange}
                  />
                ) : (
                  <>
                    {providerTraitsPicker ? (
                      <>
                        <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
                        {providerTraitsPicker}
                      </>
                    ) : null}
                    <ComposerFooterModeControls
                      showPlanMode={composerProviderControls.showInteractionModeToggle}
                      showOrchestrate={composerProviderControls.showOrchestrate}
                      supportedRuntimeModes={composerProviderControls.supportedRuntimeModes}
                      collaborationMode={collaborationMode}
                      runtimeMode={runtimeMode}
                      showPlanToggle={showPlanSidebarToggle}
                      planSidebarLabel={planSidebarLabel}
                      planSidebarOpen={planSidebarOpen}
                      onInteractionModeChange={handleComposerModeChange}
                      onOrchestrateChange={handleComposerOrchestrateChange}
                      onRuntimeModeChange={handleRuntimeModeChange}
                      onTogglePlanSidebar={togglePlanSidebar}
                    />
                  </>
                )}

                {providerSwitch === null ? null : (
                  <span
                    role="status"
                    data-chat-provider-switch-notice="true"
                    title={providerSwitch.notice}
                    className="flex min-w-0 shrink-0 items-center gap-1.5 rounded-md bg-muted/60 px-2 py-1 text-muted-foreground text-xs"
                  >
                    <ArrowRightLeftIcon aria-hidden="true" className="size-3.5 shrink-0" />
                    <span className="max-w-56 truncate">{providerSwitch.notice}</span>
                  </span>
                )}

                {brokerNotReadyMessage === null ? null : (
                  <span
                    role="status"
                    data-chat-orchestrate-broker-warning="true"
                    title={brokerNotReadyMessage}
                    className="flex min-w-0 shrink-0 items-center gap-1.5 rounded-md bg-amber-500/10 px-2 py-1 text-amber-700 text-xs dark:text-amber-400"
                  >
                    <TriangleAlertIcon aria-hidden="true" className="size-3.5 shrink-0" />
                    <span className="max-w-56 truncate">{brokerNotReadyMessage}</span>
                  </span>
                )}
              </div>

              {/* Right side: send / stop button */}
              <div
                data-chat-composer-actions="right"
                data-chat-composer-primary-actions-compact={
                  isComposerPrimaryActionsCompact ? 'true' : 'false'
                }
                className="flex shrink-0 flex-nowrap items-center justify-end gap-2"
              >
                <ComposerFooterPrimaryActions
                  compact={isComposerPrimaryActionsCompact}
                  activeContextWindow={activeContextWindow}
                  accountUsage={selectedProviderStatus?.accountUsage}
                  usageProviderDisplayName={usageProviderDisplayName}
                  canCompactNow={providerSupportsCompact}
                  pendingAction={pendingPrimaryAction}
                  isRunning={isTurnRunning}
                  showPlanFollowUpPrompt={pendingUserInputs.length === 0 && showPlanFollowUpPrompt}
                  promptHasText={prompt.trim().length > 0}
                  isSendBusy={isSendBusy}
                  sendDisabledReason={effectiveSendDisabledReason}
                  isConnecting={isConnecting}
                  isEnvironmentUnavailable={
                    environmentUnavailable !== null ||
                    (noProviderAvailable && !importContinuationSendBlocked) ||
                    projectSelectionRequired
                  }
                  isPreparingWorktree={isPreparingWorktree}
                  hasSendableContent={composerSendState.hasSendableContent}
                  showOrchestrate={composerProviderControls.showOrchestrate}
                  preserveComposerFocusOnPointerDown={isMobileViewport}
                  onPreviousPendingQuestion={onPreviousActivePendingUserInputQuestion}
                  onInterrupt={handleInterruptPrimaryAction}
                  onImplementPlanWithOrchestrate={handleImplementPlanWithOrchestratePrimaryAction}
                  onImplementPlanInNewThread={handleImplementPlanInNewThreadPrimaryAction}
                  onImplementPlanWithOrchestrateInNewThread={
                    handleImplementPlanWithOrchestrateInNewThreadPrimaryAction
                  }
                  orchestrateReadinessMessage={planOrchestrateNotReadyMessage}
                  onCompactNow={requestCompactNow}
                />
              </div>
            </div>
          )}
        </div>
      </div>
      <AlertDialog
        open={compactConfirmationSource !== null}
        onOpenChange={(open) =>
        {
          if (!open)
          {
            setCompactConfirmationSource(null)
          }
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Compact this conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              Compaction summarizes the conversation to free context space. Some detail may be lost,
              and this cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button onClick={confirmCompactNow}>Compact now</Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </form>
  )
})
