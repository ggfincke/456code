// apps/web/src/components/ChatView.tsx
// renders thread timelines, composer state, and guarded provider dispatch
import {
  type ApprovalRequestId,
  type ArchitectureGraphProjection,
  type ArchitectureStandingAnchor,
  type CollaborationMode,
  defaultInstanceIdForDriver,
  type EnvironmentId,
  type MessageId,
  type ModelSelection,
  type ProjectScript,
  type ProjectId,
  type ProviderApprovalDecision,
  ProviderInstanceId,
  type ServerProvider,
  type ScopedThreadRef,
  type ThreadId,
  type TurnId,
  type KeybindingCommand,
  OrchestrationThreadActivity,
  ProviderDriverKind,
  RuntimeMode,
  TerminalOpenInput,
  normalizeCollaborationMode,
  toWireInteractionMode,
} from '@t3tools/contracts'
import {
  connectionStatusTitle,
  type EnvironmentConnectionPresentation,
} from '@t3tools/client-runtime/connection'
import {
  type RespondToThreadOrchestratePlanInput,
  respondToThreadOrchestratePlan,
} from '@t3tools/client-runtime/operations'
import { createEnvironmentCommand } from '@t3tools/client-runtime/state/runtime'
import { effectiveSettled, effectiveSnoozed } from '@t3tools/client-runtime/state/thread-settled'
import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from '@t3tools/client-runtime/environment'
import { CHAT_LIST_ANCHOR_OFFSET } from '@t3tools/shared/chatList'
import { projectScriptCwd, projectScriptRuntimeEnv } from '@t3tools/shared/projectScripts'
import { truncate } from '@t3tools/shared/String'
import {
  getTerminalLabel,
  nextTerminalId,
  resolveTerminalSessionLabel,
} from '@t3tools/shared/terminalLabels'
import { resolveThreadChangeRoot } from '@t3tools/shared/threadChangeRoot'
import { Debouncer } from '@tanstack/react-pacer'
import { useAtomValue } from '@effect/atom-react'
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { useShallow } from 'zustand/react/shallow'
import {
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from '@t3tools/client-runtime/state/runtime'
import * as Cause from 'effect/Cause'
import { AsyncResult } from 'effect/unstable/reactivity'
import { isElectron } from '../env'
import { readLocalApi } from '../localApi'
import { useDiffPanelStore } from '../diffPanelStore'
import {
  derivePendingApprovals,
  derivePendingUserInputs,
  derivePhase,
  deriveTimelineEntries,
  deriveActiveWorkStartedAt,
  deriveActivePlanState,
  findSidebarProposedPlan,
  findLatestProposedPlan,
  deriveWorkLogEntries,
  hasActionableProposedPlan,
  isLatestTurnSettled,
} from '../session-logic'
import { deriveWorkerVerdictMap } from '../session/worklog'
import { type LegendListRef } from '@legendapp/list/react'
import {
  getAnchoredTurnMetrics,
  type TimelineScrollMode,
} from './chat/messages-timeline/timelineScrollAnchoring'
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from '../pendingUserInput'
import { useUiStateStore } from '../uiStateStore'
import {
  buildPlanImplementationThreadTitle,
  buildPlanImplementationPrompt,
  ORCHESTRATE_PLAN_IMPLEMENTATION_PROMPT,
  type PlanImplementVariant,
} from '../proposedPlan'
import {
  DEFAULT_COLLABORATION_MODE,
  DEFAULT_RUNTIME_MODE,
  DEFAULT_THREAD_TERMINAL_ID,
  MAX_TERMINALS_PER_GROUP,
  type ChatMessage,
  type SessionPhase,
  type Thread,
  type TurnDiffSummary,
} from '../types'
import { useTheme } from '../hooks/useTheme'
import { useTurnDiffSummaries } from '../hooks/useTurnDiffSummaries'
import { isCommandPaletteOpen } from '../commandPaletteBus'
import { confirmTerminalClose, isTerminalCloseConfirmPending } from '../lib/terminalCloseConfirm'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from '../rightPanelLayout'
import {
  openWorkersPanel,
  selectActiveRightPanel,
  selectActiveRightPanelSurface,
  selectThreadRightPanelState,
  type RightPanelSurface,
  useRightPanelStore,
} from '../rightPanelStore'
import {
  createRepositoryAtlasSurface,
  type ArchitectureFileOpenTarget,
} from './architecture/architectureResourceIdentity'
import type { RepositoryMapFocusRequest } from './architecture/RepositoryMapProjectionSurface'
import { RepositoryAtlasBootstrap } from './architecture/RepositoryAtlasBootstrap'
import { isPreviewSupportedInRuntime, useThreadPreviewState } from '../previewStateStore'
import { registerFaviconProjectForThread } from '../browser/browserFaviconStore'
import { previewRuntimeTabId } from '../browser/previewRuntimeTabId'
import { getConfiguredPreviewUrls } from './preview/previewEmptyStateLogic'
import { makeWorkspaceFileDropHandlers } from './chat/workspaceFileDrop'
import { resolveAutoVisitTimestamp } from './Sidebar.logic'
import { RightPanelTabs } from './RightPanelTabs'
import { DiffWorkerPoolProvider } from './DiffWorkerPoolProvider'
import { BranchToolbar } from './BranchToolbar'
import { resolveShortcutCommand, shortcutLabelForCommand } from '../keybindings'
import PlanSidebar from './PlanSidebar'
import {
  AlarmClockIcon,
  ArrowRightLeftIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  GitBranchIcon,
  ImportIcon,
  PaperclipIcon,
  TriangleAlertIcon,
  WifiOffIcon,
} from 'lucide-react'
import { cn } from '~/lib/utils'
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from '~/lib/workspaceTitlebar'
import { stackedThreadToast, toastManager } from './ui/toast'
import { decodeProjectScriptKeybindingRule } from '~/lib/projectScriptKeybindings'
import { type NewProjectScriptInput } from './ProjectScriptsControl'
import {
  buildProjectScript,
  commandForProjectScript,
  nextProjectScriptId,
  projectScriptIdFromCommand,
} from '~/projectScripts'
import { newDraftId, newMessageId, newThreadId } from '~/lib/utils'
import { resolveSelectableProvider } from '../providerModels'
import { deriveProviderInstanceEntries, NO_PROVIDER_MODEL_SELECTION } from '../providerInstances'
import {
  deriveProviderSwitchTimelineEvents,
  describeProviderSwitchConfirmation,
  formatProviderSwitchTargetLabel,
  resolvePendingHandoffPresentation,
  type ProviderSwitchInstanceResolver,
} from '../providerSwitchPresentation'
import { useClientSettings, useEnvironmentSettings } from '../hooks/useSettings'
import { useNowMinute } from '../hooks/useNowMinute'
import { useNewThreadHandler } from '../hooks/useHandleNewThread'
import { type AppModelOption, getAppModelOptionsForInstance } from '../modelSelection'
import { getTerminalFocusOwner } from '../lib/terminalFocus'
import { resolveNewDraftStartFromOrigin } from '../lib/chatThreadActions'
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from '../logicalProject'
import { buildDraftThreadRouteParams } from '../threadRoutes'
import {
  createArchitectureConcernContext,
  type ArchitectureConcernGraphSelection,
  type ComposerImageAttachment,
  type DraftThreadEnvMode,
  useComposerDraftStore,
  type DraftId,
} from '../composerDraftStore'
import { type TerminalContextDraft, type TerminalContextSelection } from '../lib/terminalContext'
import { type ElementContextDraft } from '../lib/elementContext'
import { environmentCatalog } from '../connection/catalog'
import { connectionAtomRuntime } from '../connection/runtime'
import { selectThreadTerminalUiState, useTerminalUiStateStore } from '../terminalUiStateStore'
import { useKnownTerminalSessions, useThreadRunningTerminalIds } from '../state/terminalSessions'
import { projectEnvironment } from '../state/projects'
import { useEnvironmentQuery } from '../state/query'
import {
  primaryServerAvailableEditorsAtom,
  primaryServerKeybindingsAtom,
  primaryServerSettingsAtom,
  serverEnvironment,
} from '../state/server'
import { terminalEnvironment } from '../state/terminal'
import { threadEnvironment } from '../state/threads'
import { vcsEnvironment } from '../state/vcs'
import { useEnvironments, usePrimaryEnvironment } from '../state/environments'
import {
  useProject,
  useProjects,
  useThread,
  useThreadProposedPlans,
  useThreadRefs,
  useThreadShell,
} from '../state/entities'
import { environmentShell } from '../state/shell'
import { ChatComposer, type ChatComposerHandle } from './chat/composer/ChatComposer'
import { DraftHeroHeadline } from './chat/DraftHeroHeadline'
import { ExpandedImageDialog } from './chat/ExpandedImageDialog'
import { PullRequestThreadDialog } from './PullRequestThreadDialog'
import { MessagesTimeline } from './chat/messages-timeline/MessagesTimeline'
import type { OrchestratePlanResponse } from './chat/orchestrate-plan/OrchestratePlanCard'
import { ChatHeader } from './chat/ChatHeader'
import {
  PersistentThreadTerminalDrawer,
  PersistentThreadTerminalPanel,
} from './chat/PersistentThreadTerminals'
import { PanelLayoutControls, RightPanelMaximizeControl } from './chat/PanelLayoutControls'
import { type ExpandedImagePreview } from './chat/ExpandedImagePreview'
import { NoActiveThreadState } from './NoActiveThreadState'
import { resolveEffectiveEnvMode, resolveLocalCheckoutBranchMismatch } from './BranchToolbar.logic'
import {
  getProviderStatusBannerKey,
  ProviderStatusBanner,
  shouldPromoteThreadErrorToProviderReAuth,
  shouldShowProviderStatusBanner,
} from './chat/ProviderStatusBanner'
import {
  dismissThreadErrorBannerForSession,
  getThreadErrorBannerKey,
  isThreadErrorBannerDismissedForSession,
  shouldShowThreadErrorBanner,
  ThreadErrorBanner,
} from './chat/ThreadErrorBanner'
import {
  canRetainTerminalThreadPr,
  nextThreadChangeRequestSnapshot,
  resolveDisplayedThreadPr,
  setThreadChangeRequestSnapshot,
  threadChangeRequestSnapshotsAtom,
} from './ThreadStatusIndicators'
import {
  ComposerBannerStack,
  type ComposerBannerStackItem,
} from './chat/composer/ComposerBannerStack'
import { ProviderSwitchStatusPill } from './chat/ProviderSwitchStatusPill'
import { ThreadSyncStatusPill } from './chat/ThreadSyncStatusPill'
import {
  DRAFT_HERO_TRANSITION_ANIMATION_ID,
  DRAFT_HERO_TRANSITION_DURATION_MS,
  DRAFT_HERO_TRANSITION_EASING,
  MOBILE_COMPOSER_VIEW_TRANSITION_NAME,
  MOBILE_DRAFT_HEADLINE_VIEW_TRANSITION_NAME,
  runMobileComposerTransition,
} from './chat/draftHeroTransition'
import {
  MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  branchMismatchKey,
  buildLocalDraftThread,
  buildLoadingThreadFromShell,
  chatActionErrorMessage,
  collectUserMessageBlobPreviewUrls,
  createLocalDispatchSnapshot,
  dismissBranchMismatchForSession,
  hasEnvironmentReconnectWarningGraceElapsed,
  handleImportContinuationSendBlock,
  hasServerAcknowledgedLocalDispatch,
  importContinuationConsentToken,
  isImportContinuationSendBlocked,
  isBranchMismatchDismissedForSession,
  shouldShowBranchMismatchBanner,
  LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
  LastInvokedScriptByProjectSchema,
  type LocalDispatchSnapshot,
  type LocalThreadErrorEntry,
  PullRequestDialogState,
  deriveLockedProvider,
  formatOutgoingPrompt,
  reconcileMountedTerminalThreadIds,
  resolveImportContinuationBannerCopy,
  resolveImportContinuationGate,
  resolveImportContinuationProviderSnapshot,
  resolveThreadMetadataUpdateForNextTurn,
  resolveSendEnvMode,
  scheduleEnvironmentReconnectWarning,
  revokeBlobPreviewUrl,
  revokeUserMessagePreviewUrls,
  shouldWriteThreadErrorToCurrentServerThread,
  shouldSuppressTransientEnvironmentReconnectWarning,
  startNewThreadForProject,
  threadHasStarted,
  waitForStartedServerThread,
} from './ChatView.logic'
import type { ThreadSyncPhase } from '../threadSync'
import { useLocalStorage } from '~/hooks/useLocalStorage'
import { useComposerHandleContext } from '../composerHandleContext'
import { sanitizeThreadErrorMessage } from '~/rpc/transportError'
import { RightPanelSheet } from './RightPanelSheet'
import { previewEnvironment } from '../state/preview'
import { useAtomCommand } from '../state/use-atom-command'
import { Button } from './ui/button'
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from './ui/alert-dialog'
import { Tooltip, TooltipPopup, TooltipTrigger } from './ui/tooltip'
import { ServerUpdateAction } from './ServerUpdateAction'
import {
  buildVersionMismatchDismissalKey,
  dismissVersionMismatch,
  isVersionMismatchDismissed,
  resolveServerConfigVersionMismatch,
  resolveServerSelfUpdateCapability,
  serverUpdateGuidance,
} from '../versionSkew'
import { useAssetUrls } from '../assets/assetUrls'
import { importSourceDisplayName } from '../lib/importSourcePresentation'
import { useChatDispatchController, useDraftErrorPromotion } from './chat/useChatDispatchController'
import { useChatRightPanelController } from './chat/useChatRightPanelController'

const EMPTY_ACTIVITIES: OrchestrationThreadActivity[] = []
const EMPTY_PROVIDERS: ServerProvider[] = []
const EMPTY_PROVIDER_SKILLS: ServerProvider['skills'] = []
const EMPTY_PENDING_USER_INPUT_ANSWERS: Record<string, PendingUserInputDraftAnswer> = {}

// keeps typed plan-gate responses on the environment-scoped command path
const respondToOrchestratePlanCommand = createEnvironmentCommand(connectionAtomRuntime, {
  label: 'environment-data:commands:thread:respond-to-orchestrate-plan',
  execute: (input: RespondToThreadOrchestratePlanInput) => respondToThreadOrchestratePlan(input),
})

function useDraftHeroLayoutTransition(isDraftHeroState: boolean)
{
  const transitionGroupRef = useRef<HTMLDivElement | null>(null)
  const composerAnchorRef = useRef<HTMLDivElement | null>(null)
  const previousStateRef = useRef(isDraftHeroState)
  const previousComposerRectRef = useRef<DOMRect | null>(null)
  const animationRef = useRef<Animation | null>(null)
  const attachTransitionGroupRef = (element: HTMLDivElement | null) =>
  {
    transitionGroupRef.current = element
  }
  const attachComposerAnchorRef = (element: HTMLDivElement | null) =>
  {
    composerAnchorRef.current = element
  }
  const captureComposerRect = () =>
  {
    previousComposerRectRef.current = composerAnchorRef.current?.getBoundingClientRect() ?? null
  }

  useLayoutEffect(() =>
  {
    const transitionGroup = transitionGroupRef.current
    const nextComposerRect = composerAnchorRef.current?.getBoundingClientRect() ?? null
    const stateChanged = previousStateRef.current !== isDraftHeroState
    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const mobileComposerTransitionActive =
      typeof document !== 'undefined' &&
      document.documentElement.dataset.mobileComposerRouteTransition === 'true'

    animationRef.current?.cancel()
    animationRef.current = null

    const previousComposerRect = previousComposerRectRef.current
    if (
      stateChanged &&
      !prefersReducedMotion &&
      !mobileComposerTransitionActive &&
      transitionGroup &&
      previousComposerRect &&
      nextComposerRect &&
      typeof transitionGroup.animate === 'function'
    )
    {
      const translateX = previousComposerRect.left - nextComposerRect.left
      const translateY = previousComposerRect.top - nextComposerRect.top
      if (Math.abs(translateX) >= 0.5 || Math.abs(translateY) >= 0.5)
      {
        const animation = transitionGroup.animate(
          [
            { transform: `translate3d(${translateX}px, ${translateY}px, 0)` },
            { transform: 'translate3d(0, 0, 0)' },
          ],
          {
            duration: DRAFT_HERO_TRANSITION_DURATION_MS,
            easing: DRAFT_HERO_TRANSITION_EASING,
          },
        )
        animation.id = DRAFT_HERO_TRANSITION_ANIMATION_ID
        animationRef.current = animation
        void animation.finished
          .catch(() => undefined)
          .then(() =>
          {
            if (animationRef.current !== animation)
            {
              return
            }
            animationRef.current = null
          })
      }
    }

    previousStateRef.current = isDraftHeroState
    previousComposerRectRef.current = nextComposerRect
  }, [isDraftHeroState])

  return [attachTransitionGroupRef, attachComposerAnchorRef, captureComposerRect] as const
}
const PreviewPanel = lazy(() =>
  import('./preview/PreviewPanel').then((module) => ({ default: module.PreviewPanel })),
)
const DiffPanel = lazy(() => import('./DiffPanel'))
const WorkersPanel = lazy(() => import('../workers/WorkersPanel'))
const FilePreviewPanel = lazy(() => import('./files/FilePreviewPanel'))
const ConnectedExplorerPanel = lazy(() =>
  import('./explorer/ConnectedExplorerPanel').then((module) => ({
    default: module.ConnectedExplorerPanel,
  })),
)
const ConnectedArchitectureImpactSurface = lazy(() =>
  import('./architecture/ConnectedArchitectureImpactSurface').then((module) => ({
    default: module.ConnectedArchitectureImpactSurface,
  })),
)
const ArchitectureSourceFilePanel = lazy(() =>
  import('./architecture/ArchitectureSourceFilePanel').then((module) => ({
    default: module.ArchitectureSourceFilePanel,
  })),
)
const RepositoryAtlasSurface = lazy(() =>
  import('./architecture/RepositoryAtlasSurface').then((module) => ({
    default: module.RepositoryAtlasSurface,
  })),
)
const EMPTY_PENDING_FILE_SURFACE_IDS: ReadonlySet<string> = new Set()
const TYPE_TO_FOCUS_EDITABLE_SELECTOR = [
  'input',
  'textarea',
  'select',
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
  '[role="textbox"]',
].join(',')
const TYPE_TO_FOCUS_INTERACTIVE_SELECTOR = [
  'button',
  'a[href]',
  'summary',
  '[role="button"]',
  '[role="checkbox"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
].join(',')
const TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR = [
  '[data-slot="dialog"]',
  '[data-slot="menu-popup"]',
  '[data-slot="select-popup"]',
  '[data-slot="popover-popup"]',
  '[data-slot="combobox-popup"]',
  '[data-slot="autocomplete-popup"]',
].join(',')

type EnvironmentUnavailableState = {
  readonly environmentId: EnvironmentId
  readonly label: string
  readonly connection: EnvironmentConnectionPresentation
}

type ThreadPlanCatalogEntry = Pick<Thread, 'id' | 'proposedPlans'>

function eventPathContainsSelector(event: Event, selector: string): boolean
{
  const path = event.composedPath()
  if (path.length === 0 && event.target)
  {
    path.push(event.target)
  }
  return path.some((target) => target instanceof Element && target.closest(selector))
}

function shouldTypeToFocusComposer(event: KeyboardEvent): boolean
{
  if (event.defaultPrevented || event.isComposing) return false
  if (event.metaKey || event.ctrlKey || event.altKey) return false
  if (event.key.length !== 1) return false

  if (eventPathContainsSelector(event, TYPE_TO_FOCUS_EDITABLE_SELECTOR)) return false
  if (eventPathContainsSelector(event, TYPE_TO_FOCUS_INTERACTIVE_SELECTOR)) return false
  if (document.querySelector(TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR)) return false

  return true
}

const SCRIPT_TERMINAL_COLS = 120
const SCRIPT_TERMINAL_ROWS = 30

type ChatViewProps =
  | {
      environmentId: EnvironmentId
      threadId: ThreadId
      onDiffPanelOpen?: () => void
      reserveTitleBarControlInset?: boolean
      forceExpandedMobileComposer?: boolean
      threadSyncPhase?: ThreadSyncPhase | null
      routeKind: 'server'
      draftId?: never
    }
  | {
      environmentId: EnvironmentId
      threadId: ThreadId
      onDiffPanelOpen?: () => void
      reserveTitleBarControlInset?: boolean
      forceExpandedMobileComposer?: boolean
      threadSyncPhase?: never
      routeKind: 'draft'
      draftId: DraftId
    }

interface TerminalLaunchContext
{
  threadId: ThreadId
  cwd: string
  worktreePath: string | null
}

function useLocalDispatchState(input: {
  activeThread: Thread | undefined
  activeLatestTurn: Thread['latestTurn'] | null
  phase: SessionPhase
  activePendingApproval: ApprovalRequestId | null
  activePendingUserInput: ApprovalRequestId | null
  threadError: string | null | undefined
})
{
  const [localDispatch, setLocalDispatch] = useState<LocalDispatchSnapshot | null>(null)
  const latestUserMessageId =
    input.activeThread?.messages.findLast((message) => message.role === 'user')?.id ?? null

  const resetLocalDispatch = useCallback(() =>
  {
    setLocalDispatch(null)
  }, [])

  const serverAcknowledgedLocalDispatch = useMemo(
    () =>
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: input.phase,
        latestTurn: input.activeLatestTurn,
        latestUserMessageId,
        session: input.activeThread?.session ?? null,
        hasPendingApproval: input.activePendingApproval !== null,
        hasPendingUserInput: input.activePendingUserInput !== null,
        threadError: input.threadError,
      }),
    [
      input.activeLatestTurn,
      input.activePendingApproval,
      input.activePendingUserInput,
      input.activeThread?.session,
      input.phase,
      input.threadError,
      latestUserMessageId,
      localDispatch,
    ],
  )
  const activeLocalDispatch = serverAcknowledgedLocalDispatch ? null : localDispatch
  const beginLocalDispatch = useCallback(
    (options?: { preparingWorktree?: boolean }) =>
    {
      const preparingWorktree = Boolean(options?.preparingWorktree)
      setLocalDispatch((current) =>
      {
        const active = serverAcknowledgedLocalDispatch ? null : current
        if (active)
        {
          return active.preparingWorktree === preparingWorktree
            ? active
            : { ...active, preparingWorktree }
        }
        return createLocalDispatchSnapshot(input.activeThread, options)
      })
    },
    [input.activeThread, serverAcknowledgedLocalDispatch],
  )

  return {
    beginLocalDispatch,
    resetLocalDispatch,
    localDispatchStartedAt: activeLocalDispatch?.startedAt ?? null,
    isPreparingWorktree: activeLocalDispatch?.preparingWorktree ?? false,
    isSendBusy: activeLocalDispatch !== null,
  }
}

// drop the send-time anchored end space while keeping the thread scoping. that
// space holds a sent row near the top while its turn streams and keeps
// maintainScrollAtEnd switched off for as long as it is installed, so every
// manual return to the live edge must release the anchor too — otherwise the
// timeline settles into 'following-end' with nothing following anything.
function releaseChatTimelineAnchor<T extends { readonly messageId: MessageId | null }>(
  current: T,
): T
{
  return current.messageId === null ? current : { ...current, messageId: null }
}

function ChatViewContent(props: ChatViewProps)
{
  const {
    environmentId,
    threadId,
    routeKind,
    onDiffPanelOpen,
    reserveTitleBarControlInset = true,
    forceExpandedMobileComposer = false,
  } = props
  const draftId = routeKind === 'draft' ? props.draftId : null
  const threadSyncPhase = routeKind === 'server' ? (props.threadSyncPhase ?? null) : null
  const threadDetailLoading = threadSyncPhase === 'loading'
  // a null sync phase is the live detail; 'loading' and 'syncing' both mean the
  // snapshot can still be missing history
  const threadDetailSynchronized = routeKind === 'server' && threadSyncPhase === null
  const handleNewThread = useNewThreadHandler()
  const routeThreadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  )
  const routeThreadKey = useMemo(() => scopedThreadKey(routeThreadRef), [routeThreadRef])
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false })
  const upsertKeybinding = useAtomCommand(serverEnvironment.upsertKeybinding, {
    reportFailure: false,
  })
  const openTerminal = useAtomCommand(terminalEnvironment.open, 'terminal open')
  const writeTerminal = useAtomCommand(terminalEnvironment.write, 'terminal write')
  const closeTerminalMutation = useAtomCommand(terminalEnvironment.close, 'terminal close')
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false })
  const deleteThread = useAtomCommand(threadEnvironment.delete, { reportFailure: false })
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  })
  const switchGitRef = useAtomCommand(vcsEnvironment.switchRef, { reportFailure: false })
  const setThreadRuntimeMode = useAtomCommand(threadEnvironment.setRuntimeMode, {
    reportFailure: false,
  })
  const setThreadInteractionMode = useAtomCommand(threadEnvironment.setInteractionMode, {
    reportFailure: false,
  })
  const setThreadWorkerVerdict = useAtomCommand(
    threadEnvironment.setWorkerVerdict,
    'worker verdict',
  )
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false })
  const switchThreadProvider = useAtomCommand(threadEnvironment.switchProvider, {
    reportFailure: false,
  })
  const interruptThreadTurn = useAtomCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  })
  const respondToThreadApproval = useAtomCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  })
  const respondToThreadUserInput = useAtomCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  })
  const dispatchOrchestratePlanResponse = useAtomCommand(respondToOrchestratePlanCommand, {
    reportFailure: false,
  })
  const revertThreadCheckpoint = useAtomCommand(threadEnvironment.revertCheckpoint, {
    reportFailure: false,
  })
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false })
  const closePreview = useAtomCommand(previewEnvironment.close, 'preview close')
  const { environments } = useEnvironments()
  const primaryEnvironment = usePrimaryEnvironment()
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false })
  const environmentById = useMemo(
    () => new Map(environments.map((environment) => [environment.environmentId, environment])),
    [environments],
  )
  const composerDraftTarget: ScopedThreadRef | DraftId =
    routeKind === 'server' ? routeThreadRef : props.draftId
  const composerDraftOwnerKey =
    routeKind === 'server' ? `server:${routeThreadKey}` : `draft:${props.draftId}`
  const composerDraftOwnerKeyRef = useRef(composerDraftOwnerKey)
  composerDraftOwnerKeyRef.current = composerDraftOwnerKey
  const draftThread = useComposerDraftStore((store) =>
    routeKind === 'server'
      ? store.getDraftSessionByRef(routeThreadRef)
      : draftId
        ? store.getDraftSession(draftId)
        : null,
  )
  const routeServerThreadShell = useThreadShell(routeKind === 'server' ? routeThreadRef : null)
  const serverThread = useThread(routeThreadRef, { waitForShell: draftThread !== null })
  const loadingServerThread = useMemo(
    () =>
      threadDetailLoading && routeServerThreadShell
        ? buildLoadingThreadFromShell(routeServerThreadShell)
        : null,
    [routeServerThreadShell, threadDetailLoading],
  )
  const activeServerThread = serverThread ?? loadingServerThread
  const markThreadVisited = useUiStateStore((store) => store.markThreadVisited)
  const activeThreadLastVisitedAt = useUiStateStore(
    (store) => store.threadLastVisitedAtById[routeThreadKey],
  )
  const settings = useEnvironmentSettings(environmentId)
  // new-thread defaults live in the primary environment's settings.json (the
  // settings UI never writes to remote environments), so read them from the
  // primary server rather than the thread's environment.
  const primaryServerSettings = useAtomValue(primaryServerSettingsAtom)
  const setStickyComposerModelSelection = useComposerDraftStore(
    (store) => store.setStickyModelSelection,
  )
  const timestampFormat = settings.timestampFormat
  const autoOpenPlanSidebar = settings.autoOpenPlanSidebar
  const navigate = useNavigate()
  const { resolvedTheme } = useTheme()
  // granular store selectors — avoid subscribing to prompt changes.
  const composerRuntimeMode = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.runtimeMode ?? null,
  )
  const composerCollaborationMode = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.collaborationMode ?? null,
  )
  const composerActiveProvider = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.activeProvider ?? null,
  )
  // the complete draft selection (model and options, not just the instance) so
  // projection reconciliation can spot a stale selection on the same instance
  const composerModelSelection = useComposerDraftStore((store) =>
  {
    const draft = store.getComposerDraft(composerDraftTarget)
    const activeProvider = draft?.activeProvider ?? null
    return activeProvider ? (draft?.modelSelectionByProvider[activeProvider] ?? null) : null
  })
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt)
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages)
  const setComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.setTerminalContexts,
  )
  const setComposerDraftElementContexts = useComposerDraftStore((store) => store.setElementContexts)
  const setComposerDraftPreviewAnnotations = useComposerDraftStore(
    (store) => store.setPreviewAnnotations,
  )
  const setComposerDraftArchitectureContexts = useComposerDraftStore(
    (store) => store.setArchitectureContexts,
  )
  const addComposerDraftArchitectureContext = useComposerDraftStore(
    (store) => store.addArchitectureContext,
  )
  const setComposerDraftReviewComments = useComposerDraftStore((store) => store.setReviewComments)
  const setComposerDraftModelSelection = useComposerDraftStore((store) => store.setModelSelection)
  const setComposerDraftRuntimeMode = useComposerDraftStore((store) => store.setRuntimeMode)
  const setComposerDraftInteractionMode = useComposerDraftStore((store) => store.setInteractionMode)
  const clearComposerDraftContent = useComposerDraftStore((store) => store.clearComposerContent)
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext)
  const getDraftSessionByLogicalProjectKey = useComposerDraftStore(
    (store) => store.getDraftSessionByLogicalProjectKey,
  )
  const getDraftSession = useComposerDraftStore((store) => store.getDraftSession)
  const setLogicalProjectDraftThreadId = useComposerDraftStore(
    (store) => store.setLogicalProjectDraftThreadId,
  )
  const promptRef = useRef('')
  const composerImagesRef = useRef<ComposerImageAttachment[]>([])
  const composerTerminalContextsRef = useRef<TerminalContextDraft[]>([])
  const composerElementContextsRef = useRef<ElementContextDraft[]>([])
  const localComposerRef = useRef<ChatComposerHandle | null>(null)
  const composerRef = useComposerHandleContext() ?? localComposerRef
  const [isWorkspaceFileDragActive, setIsWorkspaceFileDragActive] = useState(false)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null)
  const [optimisticUserMessages, setOptimisticUserMessages] = useState<ChatMessage[]>([])
  const optimisticUserMessagesRef = useRef(optimisticUserMessages)
  optimisticUserMessagesRef.current = optimisticUserMessages
  const [localDraftErrorsByDraftId, setLocalDraftErrorsByDraftId] = useState<
    Record<string, LocalThreadErrorEntry>
  >({})
  const [localServerErrorsByThreadKey, setLocalServerErrorsByThreadKey] = useState<
    Record<string, LocalThreadErrorEntry>
  >({})
  const [isConnecting, _setIsConnecting] = useState(false)
  const [isRevertingCheckpoint, setIsRevertingCheckpoint] = useState(false)
  const [maximizedRightPanelThreadKey, setMaximizedRightPanelThreadKey] = useState<string | null>(
    null,
  )
  const [respondingRequestIds, setRespondingRequestIds] = useState<ApprovalRequestId[]>([])
  const [respondingUserInputRequestIds, setRespondingUserInputRequestIds] = useState<
    ApprovalRequestId[]
  >([])
  useEffect(() =>
  {
    setIsWorkspaceFileDragActive(false)
  }, [draftId, routeThreadKey])
  useEffect(() =>
  {
    if (!isWorkspaceFileDragActive) return
    const clearWorkspaceFileDrag = () => setIsWorkspaceFileDragActive(false)
    window.addEventListener('dragend', clearWorkspaceFileDrag)
    return () => window.removeEventListener('dragend', clearWorkspaceFileDrag)
  }, [isWorkspaceFileDragActive])
  const [pendingUserInputAnswersByRequestId, setPendingUserInputAnswersByRequestId] = useState<
    Record<string, Record<string, PendingUserInputDraftAnswer>>
  >({})
  const [pendingUserInputQuestionIndexByRequestId, setPendingUserInputQuestionIndexByRequestId] =
    useState<Record<string, number>>({})
  const shouldUsePlanSidebarSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY)
  // tracks whether the user explicitly dismissed the sidebar for the active turn.
  const planSidebarDismissedForTurnRef = useRef<string | null>(null)
  // when set, the thread-change reset effect will open the sidebar instead of closing it.
  // used by "Implement in a new thread" to carry the sidebar-open intent across navigation.
  const planSidebarOpenOnNextThreadRef = useRef(false)
  const [terminalFocusRequestId, setTerminalFocusRequestId] = useState(0)
  const [pullRequestDialogState, setPullRequestDialogState] =
    useState<PullRequestDialogState | null>(null)
  const [terminalUiLaunchContext, setTerminalUiLaunchContext] =
    useState<TerminalLaunchContext | null>(null)
  const [attachmentPreviewHandoffByMessageId, setAttachmentPreviewHandoffByMessageId] = useState<
    Record<string, string[]>
  >({})
  const [pendingServerThreadEnvMode, setPendingServerThreadEnvMode] =
    useState<DraftThreadEnvMode | null>(null)
  const [pendingServerThreadBranch, setPendingServerThreadBranch] = useState<string | null>()
  const [
    pendingServerThreadStartFromOriginByThreadId,
    setPendingServerThreadStartFromOriginByThreadId,
  ] = useState<Record<string, boolean>>({})
  const [lastInvokedScriptByProjectId, setLastInvokedScriptByProjectId] = useLocalStorage(
    LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
    {},
    LastInvokedScriptByProjectSchema,
  )
  const legendListRef = useRef<LegendListRef | null>(null)
  const [composerOverlayElement, setComposerOverlayElement] = useState<HTMLDivElement | null>(null)
  const [composerOverlayHeight, setComposerOverlayHeight] = useState(0)
  const isAtEndRef = useRef(true)
  const attachmentPreviewHandoffByMessageIdRef = useRef<Record<string, string[]>>({})
  const attachmentPreviewPromotionInFlightByMessageIdRef = useRef<Record<string, true>>({})
  const sendInFlightRef = useRef(false)
  const terminalUiOpenByThreadRef = useRef<Record<string, boolean>>({})

  useLayoutEffect(() =>
  {
    if (!composerOverlayElement) return

    const updateHeight = () =>
    {
      const nextHeight = Math.ceil(composerOverlayElement.getBoundingClientRect().height)
      if (nextHeight <= 0) return
      setComposerOverlayHeight((currentHeight) =>
        currentHeight === nextHeight ? currentHeight : nextHeight,
      )
    }

    updateHeight()
    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(updateHeight)
    observer.observe(composerOverlayElement)
    return () => observer.disconnect()
  }, [composerOverlayElement])

  const terminalUiState = useTerminalUiStateStore((state) =>
    selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef),
  )
  const openTerminalThreadKeys = useTerminalUiStateStore(
    useShallow((state) =>
      Object.entries(state.terminalUiStateByThreadKey).flatMap(
        ([nextThreadKey, nextTerminalUiState]) =>
          nextTerminalUiState.terminalOpen ? [nextThreadKey] : [],
      ),
    ),
  )
  const storeSetTerminalOpen = useTerminalUiStateStore((s) => s.setTerminalOpen)
  const storeEnsureTerminal = useTerminalUiStateStore((state) => state.ensureTerminal)
  const storeSplitTerminal = useTerminalUiStateStore((s) => s.splitTerminal)
  const storeSplitTerminalVertical = useTerminalUiStateStore((s) => s.splitTerminalVertical)
  const storeNewTerminal = useTerminalUiStateStore((s) => s.newTerminal)
  const storeSetActiveTerminal = useTerminalUiStateStore((s) => s.setActiveTerminal)
  const storeCloseTerminal = useTerminalUiStateStore((s) => s.closeTerminal)
  const serverThreadRefs = useThreadRefs()
  const serverThreadKeys = useMemo(() => serverThreadRefs.map(scopedThreadKey), [serverThreadRefs])
  const draftThreadsByThreadKey = useComposerDraftStore((store) => store.draftThreadsByThreadKey)
  const draftThreadKeys = useMemo(
    () =>
      Object.values(draftThreadsByThreadKey).map((draftThread) =>
        scopedThreadKey(scopeThreadRef(draftThread.environmentId, draftThread.threadId)),
      ),
    [draftThreadsByThreadKey],
  )
  const [mountedTerminalThreadKeys, setMountedTerminalThreadKeys] = useState<string[]>([])
  const mountedTerminalThreadRefs = useMemo(
    () =>
      mountedTerminalThreadKeys.flatMap((mountedThreadKey) =>
      {
        const mountedThreadRef = parseScopedThreadKey(mountedThreadKey)
        return mountedThreadRef ? [{ key: mountedThreadKey, threadRef: mountedThreadRef }] : []
      }),
    [mountedTerminalThreadKeys],
  )

  const fallbackDraftProjectRef = draftThread
    ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
    : null
  const fallbackDraftProject = useProject(fallbackDraftProjectRef)
  const localDraftError = activeServerThread
    ? null
    : ((draftId ? localDraftErrorsByDraftId[draftId]?.message : null) ?? null)
  const localServerError = localServerErrorsByThreadKey[routeThreadKey]?.message ?? null
  useDraftErrorPromotion({
    activeServerThread,
    draftId,
    localDraftErrorsByDraftId,
    routeThreadKey,
    setLocalDraftErrorsByDraftId,
    setLocalServerErrorsByThreadKey,
  })
  const localDraftThread = useMemo(
    () =>
      draftThread
        ? buildLocalDraftThread(
            threadId,
            draftThread,
            fallbackDraftProject?.defaultModelSelection ?? NO_PROVIDER_MODEL_SELECTION,
          )
        : undefined,
    [draftThread, fallbackDraftProject?.defaultModelSelection, threadId],
  )
  // promotion is data-driven: the draft route keeps rendering while the
  // server thread (same pre-allocated ref) starts, so live state must not
  // depend on which route is mounted.
  const isServerThread = activeServerThread !== null
  const activeThread = activeServerThread ?? localDraftThread
  const threadError = isServerThread
    ? (localServerError ?? activeServerThread?.session?.lastError ?? null)
    : localDraftError
  const threadErrorBannerKey = getThreadErrorBannerKey(routeThreadKey, threadError)
  const visibleThreadError = shouldShowThreadErrorBanner(
    routeThreadKey,
    threadError,
    isThreadErrorBannerDismissedForSession(threadErrorBannerKey),
  )
    ? threadError
    : null
  const [, setThreadErrorBannerDismissTick] = useState(0)
  const runtimeMode = composerRuntimeMode ?? activeThread?.runtimeMode ?? DEFAULT_RUNTIME_MODE
  const collaborationMode =
    composerCollaborationMode ??
    (activeThread
      ? normalizeCollaborationMode(activeThread.interactionMode, activeThread.orchestrate)
      : DEFAULT_COLLABORATION_MODE)
  const isLocalDraftThread = !isServerThread && localDraftThread !== undefined
  const canCheckoutPullRequestIntoThread = isLocalDraftThread
  const activeThreadId = activeThread?.id ?? null
  const activeThreadEnvironmentId = activeThread?.environmentId ?? null
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: activeThreadEnvironmentId,
    threadId: activeThreadId,
  })
  const activeThreadKnownSessionsRaw = useKnownTerminalSessions({
    environmentId: activeThreadEnvironmentId,
    threadId: activeThreadId,
  })
  const activeThreadKnownSessions = useMemo(() =>
  {
    if (activeThreadId === null)
    {
      return []
    }
    return activeThreadKnownSessionsRaw.filter(
      (session) => session.target.threadId === activeThreadId,
    )
  }, [activeThreadId, activeThreadKnownSessionsRaw])
  const activeServerOrderedTerminalIds = useMemo(
    () => activeThreadKnownSessions.map((session) => session.target.terminalId),
    [activeThreadKnownSessions],
  )
  const activeKnownTerminalIds = useMemo(
    () => [...new Set([...activeServerOrderedTerminalIds, ...terminalUiState.terminalIds])],
    [activeServerOrderedTerminalIds, terminalUiState.terminalIds],
  )
  const activeTerminalLabelsById = useMemo(() =>
  {
    const labels = new Map<string, string>()
    for (const session of activeThreadKnownSessions)
    {
      labels.set(
        session.target.terminalId,
        resolveTerminalSessionLabel(session.target.terminalId, session.state.summary),
      )
    }
    return labels
  }, [activeThreadKnownSessions])
  const activeThreadRef = useMemo(
    () =>
      activeThreadEnvironmentId !== null && activeThreadId !== null
        ? scopeThreadRef(activeThreadEnvironmentId, activeThreadId)
        : null,
    [activeThreadEnvironmentId, activeThreadId],
  )
  const activeThreadKey = activeThreadRef ? scopedThreadKey(activeThreadRef) : null
  const changeRequestSnapshotByKey = useAtomValue(threadChangeRequestSnapshotsAtom)
  const [timelineAnchor, setTimelineAnchor] = useState<{
    readonly threadKey: string | null
    readonly messageId: MessageId | null
  }>({ threadKey: activeThreadKey, messageId: null })
  if (timelineAnchor.threadKey !== activeThreadKey)
  {
    setTimelineAnchor({ threadKey: activeThreadKey, messageId: null })
  }
  const timelineAnchorMessageId = timelineAnchor.messageId
  const activeRightPanelKind = useRightPanelStore((state) =>
    selectActiveRightPanel(state.byThreadKey, activeThreadRef),
  )
  const diffOpen = activeRightPanelKind === 'diff'
  const rightPanelState = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, activeThreadRef),
  )
  const activeRightPanelSurface = useRightPanelStore((state) =>
    selectActiveRightPanelSurface(state.byThreadKey, activeThreadRef),
  )
  const activeFileSurface =
    activeRightPanelSurface?.kind === 'file' ? activeRightPanelSurface : null
  const activePreviewState = useThreadPreviewState(activeThreadRef)
  const activePreviewServerEpoch = activePreviewState.serverEpoch
  const resolvePreviewRuntimeTabId = useMemo(
    () =>
      activeThreadRef
        ? (tabId: string) => previewRuntimeTabId(activeThreadRef, activePreviewServerEpoch, tabId)
        : undefined,
    [activePreviewServerEpoch, activeThreadRef],
  )
  const panelTerminalIds = useMemo(
    () =>
      new Set(
        rightPanelState.surfaces.flatMap((surface) =>
          surface.kind === 'terminal' ? surface.terminalIds : [],
        ),
      ),
    [rightPanelState.surfaces],
  )
  const previewPanelOpen = activeRightPanelKind === 'preview' && isPreviewSupportedInRuntime()
  const rightPanelOpen = rightPanelState.isOpen
  const canMaximizeRightPanel = rightPanelOpen && !shouldUsePlanSidebarSheet
  const rightPanelMaximized =
    canMaximizeRightPanel && maximizedRightPanelThreadKey === routeThreadKey
  const inlineRightPanelOwnsTitleBar = rightPanelOpen && !shouldUsePlanSidebarSheet

  useEffect(() =>
  {
    if (!activeThreadRef) return
    useRightPanelStore
      .getState()
      .reconcileBrowserSurfaces(activeThreadRef, Object.keys(activePreviewState.sessions))
  }, [activePreviewState.sessions, activeThreadRef])

  const planSidebarOpen = activeRightPanelKind === 'plan'

  const existingOpenTerminalThreadKeys = useMemo(() =>
  {
    const existingThreadKeys = new Set<string>([...serverThreadKeys, ...draftThreadKeys])
    return openTerminalThreadKeys.filter((nextThreadKey) => existingThreadKeys.has(nextThreadKey))
  }, [draftThreadKeys, openTerminalThreadKeys, serverThreadKeys])
  const activeLatestTurn = activeThread?.latestTurn ?? null
  const [acceptedImportConsentToken, setAcceptedImportConsentToken] = useState<string | null>(null)
  const [importBlockedAnnouncementCount, setImportBlockedAnnouncementCount] = useState(0)
  const sourcePlanThreadRef = useMemo(() =>
  {
    const sourceThreadId = activeLatestTurn?.sourceProposedPlan?.threadId
    if (!activeThread || !sourceThreadId || sourceThreadId === activeThread.id)
    {
      return null
    }
    return scopeThreadRef(activeThread.environmentId, sourceThreadId)
  }, [activeLatestTurn?.sourceProposedPlan?.threadId, activeThread])
  const sourceThreadProposedPlans = useThreadProposedPlans(sourcePlanThreadRef)
  const threadPlanCatalog = useMemo<ThreadPlanCatalogEntry[]>(() =>
  {
    if (!activeThread)
    {
      return []
    }
    const entries: ThreadPlanCatalogEntry[] = [
      { id: activeThread.id, proposedPlans: activeThread.proposedPlans },
    ]
    if (sourcePlanThreadRef)
    {
      entries.push({
        id: sourcePlanThreadRef.threadId,
        proposedPlans: sourceThreadProposedPlans,
      })
    }
    return entries
  }, [activeThread, sourcePlanThreadRef, sourceThreadProposedPlans])
  useEffect(() =>
  {
    setMountedTerminalThreadKeys((currentThreadIds) =>
    {
      const nextThreadIds = reconcileMountedTerminalThreadIds({
        currentThreadIds,
        openThreadIds: existingOpenTerminalThreadKeys,
        activeThreadId: activeThreadKey,
        activeThreadTerminalOpen: Boolean(activeThreadKey && terminalUiState.terminalOpen),
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
      })
      return currentThreadIds.length === nextThreadIds.length &&
        currentThreadIds.every((nextThreadId, index) => nextThreadId === nextThreadIds[index])
        ? currentThreadIds
        : nextThreadIds
    })
  }, [activeThreadKey, existingOpenTerminalThreadKeys, terminalUiState.terminalOpen])
  const latestTurnSettled = isLatestTurnSettled(activeLatestTurn, activeThread?.session ?? null)
  const activeProjectRef = useMemo(
    () =>
      activeThread ? scopeProjectRef(activeThread.environmentId, activeThread.projectId) : null,
    [activeThread?.environmentId, activeThread?.projectId],
  )
  const activeProject = useProject(activeProjectRef)
  useEffect(() =>
  {
    if (!activeThreadRef || !activeProjectRef) return
    registerFaviconProjectForThread(activeThreadRef, activeProjectRef)
  }, [activeProjectRef, activeThreadRef])
  const handleNewThreadInActiveProject = useCallback(() =>
  {
    startNewThreadForProject(activeProjectRef, handleNewThread)
  }, [activeProjectRef, handleNewThread])
  const activeEnvironmentShell = useEnvironmentQuery(
    activeThread ? environmentShell.stateAtom(activeThread.environmentId) : null,
  )
  const activeEnvironmentBootstrapComplete = activeEnvironmentShell.data?.snapshot._tag === 'Some'
  const activeProjectKey = activeProject
    ? `${activeProject.environmentId}:${activeProject.workspaceRoot}`
    : null
  const [pendingFileSurfaceIdsByProject, setPendingFileSurfaceIdsByProject] = useState<
    ReadonlyMap<string, ReadonlySet<string>>
  >(() => new Map())
  const pendingFileSurfaceIds = activeProjectKey
    ? (pendingFileSurfaceIdsByProject.get(activeProjectKey) ?? EMPTY_PENDING_FILE_SURFACE_IDS)
    : EMPTY_PENDING_FILE_SURFACE_IDS
  const handleFilePendingChange = useCallback(
    (relativePath: string, pending: boolean) =>
    {
      if (!activeProjectKey) return
      setPendingFileSurfaceIdsByProject((currentByProject) =>
      {
        const current = currentByProject.get(activeProjectKey) ?? EMPTY_PENDING_FILE_SURFACE_IDS
        const surfaceId = `file:${relativePath}`
        if (current.has(surfaceId) === pending) return currentByProject
        const next = new Set(current)
        if (pending) next.add(surfaceId)
        else next.delete(surfaceId)
        const nextByProject = new Map(currentByProject)
        if (next.size === 0) nextByProject.delete(activeProjectKey)
        else nextByProject.set(activeProjectKey, next)
        return nextByProject
      })
    },
    [activeProjectKey],
  )
  const configuredPreviewUrls = useMemo(
    () => getConfiguredPreviewUrls(activeProject?.scripts),
    [activeProject?.scripts],
  )

  useEffect(() =>
  {
    if (!activeThreadRef || !activeEnvironmentBootstrapComplete) return
    useRightPanelStore.getState().reconcileFileSurfaces(activeThreadRef, activeProject !== null)
  }, [activeEnvironmentBootstrapComplete, activeProject, activeThreadRef])

  // compute the list of environments this logical project spans, used to
  // drive the environment picker in BranchToolbar.
  const allProjects = useProjects()
  const primaryEnvironmentId = primaryEnvironment?.environmentId ?? null
  const activeEnvironment =
    activeThread == null ? null : (environmentById.get(activeThread.environmentId) ?? null)
  const liveServerConfig = useAtomValue(
    serverEnvironment.configValueAtom(activeThread?.environmentId ?? primaryEnvironmentId),
  )
  const activeEnvironmentConnectionPhase = activeEnvironment?.connection.phase ?? 'available'
  const activeEnvironmentUnavailable =
    activeEnvironment !== null && activeEnvironmentConnectionPhase !== 'connected'
  const activeReconnectingEnvironmentId =
    activeEnvironmentConnectionPhase === 'connecting' ||
    activeEnvironmentConnectionPhase === 'reconnecting'
      ? (activeEnvironment?.environmentId ?? null)
      : null
  const [reconnectWarningGraceElapsedEnvironmentId, setReconnectWarningGraceElapsedEnvironmentId] =
    useState<EnvironmentId | null>(null)
  const reconnectWarningGraceElapsed = hasEnvironmentReconnectWarningGraceElapsed(
    activeReconnectingEnvironmentId,
    reconnectWarningGraceElapsedEnvironmentId,
  )
  useEffect(() =>
  {
    setReconnectWarningGraceElapsedEnvironmentId(null)
    if (activeReconnectingEnvironmentId === null)
    {
      return
    }
    return scheduleEnvironmentReconnectWarning(() =>
      setReconnectWarningGraceElapsedEnvironmentId(activeReconnectingEnvironmentId),
    )
  }, [activeReconnectingEnvironmentId])
  const activeEnvironmentUnavailableLabel = activeEnvironment?.label ?? null
  const activeEnvironmentUnavailableState = useMemo<EnvironmentUnavailableState | null>(() =>
  {
    if (!activeEnvironmentUnavailable || !activeEnvironmentUnavailableLabel || !activeEnvironment)
    {
      return null
    }

    return {
      environmentId: activeEnvironment.environmentId,
      label: activeEnvironmentUnavailableLabel,
      connection: activeEnvironment.connection,
    }
  }, [activeEnvironment, activeEnvironmentUnavailable, activeEnvironmentUnavailableLabel])
  const handleReconnectActiveEnvironment = useCallback(
    async (environmentId: EnvironmentId) =>
    {
      const result = await retryEnvironment(environmentId)
      if (result._tag === 'Failure' && !isAtomCommandInterrupted(result))
      {
        const error = squashAtomCommandFailure(result)
        toastManager.add(
          stackedThreadToast({
            type: 'error',
            title: 'Could not reconnect environment',
            description: error instanceof Error ? error.message : 'Failed to reconnect.',
          }),
        )
      }
    },
    [retryEnvironment],
  )
  const projectGroupingSettings = selectProjectGroupingSettings(settings)
  const logicalProjectEnvironments = useMemo(() =>
  {
    if (!activeProject) return []
    const logicalKey = deriveLogicalProjectKeyFromSettings(activeProject, projectGroupingSettings)
    const memberProjects = allProjects.filter(
      (p) => deriveLogicalProjectKeyFromSettings(p, projectGroupingSettings) === logicalKey,
    )
    const seen = new Set<string>()
    const envs: Array<{
      environmentId: EnvironmentId
      projectId: ProjectId
      label: string
      isPrimary: boolean
    }> = []
    for (const p of memberProjects)
    {
      if (seen.has(p.environmentId)) continue
      seen.add(p.environmentId)
      const isPrimary = p.environmentId === primaryEnvironmentId
      const label = environmentById.get(p.environmentId)?.label ?? p.environmentId
      envs.push({
        environmentId: p.environmentId,
        projectId: p.id,
        label,
        isPrimary,
      })
    }
    // sort: primary first, then alphabetical
    envs.sort((a, b) =>
    {
      if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1
      return a.label.localeCompare(b.label)
    })
    return envs
  }, [activeProject, allProjects, projectGroupingSettings, primaryEnvironmentId, environmentById])
  const hasMultipleEnvironments = logicalProjectEnvironments.length > 1

  const openPullRequestDialog = useCallback(
    (reference?: string) =>
    {
      if (!canCheckoutPullRequestIntoThread)
      {
        return
      }
      setPullRequestDialogState({
        initialReference: reference ?? null,
        key: Date.now(),
      })
    },
    [canCheckoutPullRequestIntoThread],
  )

  const closePullRequestDialog = useCallback(() =>
  {
    setPullRequestDialogState(null)
  }, [])

  const openOrReuseProjectDraftThread = useCallback(
    async (input: { branch: string; worktreePath: string | null; envMode: DraftThreadEnvMode }) =>
    {
      if (!activeProject)
      {
        throw new Error('No active project is available for this pull request.')
      }
      const activeProjectRef = scopeProjectRef(activeProject.environmentId, activeProject.id)
      const logicalProjectKey = deriveLogicalProjectKeyFromSettings(
        activeProject,
        projectGroupingSettings,
      )
      const storedDraftSession = getDraftSessionByLogicalProjectKey(logicalProjectKey)
      if (storedDraftSession)
      {
        setDraftThreadContext(storedDraftSession.draftId, input)
        setLogicalProjectDraftThreadId(
          logicalProjectKey,
          activeProjectRef,
          storedDraftSession.draftId,
          {
            threadId: storedDraftSession.threadId,
            ...input,
          },
        )
        if (routeKind !== 'draft' || draftId !== storedDraftSession.draftId)
        {
          await navigate({
            to: '/draft/$draftId',
            params: buildDraftThreadRouteParams(storedDraftSession.draftId),
          })
        }
        return storedDraftSession.threadId
      }

      const activeDraftSession = routeKind === 'draft' && draftId ? getDraftSession(draftId) : null
      if (
        !isServerThread &&
        activeDraftSession?.logicalProjectKey === logicalProjectKey &&
        draftId
      )
      {
        setDraftThreadContext(draftId, input)
        setLogicalProjectDraftThreadId(logicalProjectKey, activeProjectRef, draftId, {
          threadId: activeDraftSession.threadId,
          createdAt: activeDraftSession.createdAt,
          runtimeMode: activeDraftSession.runtimeMode,
          collaborationMode: activeDraftSession.collaborationMode,
          ...input,
        })
        return activeDraftSession.threadId
      }

      const nextDraftId = newDraftId()
      const nextThreadId = newThreadId()
      setLogicalProjectDraftThreadId(logicalProjectKey, activeProjectRef, nextDraftId, {
        threadId: nextThreadId,
        createdAt: new Date().toISOString(),
        runtimeMode: DEFAULT_RUNTIME_MODE,
        collaborationMode: DEFAULT_COLLABORATION_MODE,
        ...input,
      })
      await navigate({
        to: '/draft/$draftId',
        params: buildDraftThreadRouteParams(nextDraftId),
      })
      return nextThreadId
    },
    [
      activeProject,
      draftId,
      getDraftSession,
      getDraftSessionByLogicalProjectKey,
      isServerThread,
      navigate,
      projectGroupingSettings,
      routeKind,
      setDraftThreadContext,
      setLogicalProjectDraftThreadId,
    ],
  )

  const handlePreparedPullRequestThread = useCallback(
    async (input: { branch: string; worktreePath: string | null }) =>
    {
      await openOrReuseProjectDraftThread({
        branch: input.branch,
        worktreePath: input.worktreePath,
        envMode: input.worktreePath ? 'worktree' : 'local',
      })
    },
    [openOrReuseProjectDraftThread],
  )

  // this effect marked the routed-to thread visited whenever updatedAt advanced, and
  // turn.completed advances updatedAt -- so a completion was always already "seen" and the
  // completion pill could never fire for the thread you had open. withholding the mark while the
  // tab is backgrounded is what keeps that pill alive for a run nobody was watching, and the
  // visibility listener records the visit the moment the user actually comes back to it
  useEffect(() =>
  {
    if (!serverThread?.id) return

    const markVisitedIfWatching = () =>
    {
      const visitedAt = resolveAutoVisitTimestamp({
        threadUpdatedAt: serverThread.updatedAt,
        ...(activeThreadLastVisitedAt ? { lastVisitedAt: activeThreadLastVisitedAt } : {}),
        latestTurnCompletedAt: serverThread.latestTurn?.completedAt,
        documentVisible: document.visibilityState === 'visible',
      })
      if (visitedAt === null) return
      markThreadVisited(
        scopedThreadKey(scopeThreadRef(serverThread.environmentId, serverThread.id)),
        visitedAt,
      )
    }

    markVisitedIfWatching()
    document.addEventListener('visibilitychange', markVisitedIfWatching)
    return () => document.removeEventListener('visibilitychange', markVisitedIfWatching)
  }, [
    activeThreadLastVisitedAt,
    markThreadVisited,
    serverThread?.environmentId,
    serverThread?.id,
    serverThread?.latestTurn?.completedAt,
    serverThread?.updatedAt,
  ])

  const selectedProviderByThreadId = composerActiveProvider ?? null
  const threadProvider =
    activeThread?.modelSelection.instanceId ??
    activeProject?.defaultModelSelection?.instanceId ??
    null
  // once a thread selects an environment, never substitute the primary
  // environment's config while the selected environment is still loading.
  const serverConfig =
    liveServerConfig ??
    (activeThread
      ? (activeEnvironment?.serverConfig ?? null)
      : (primaryEnvironment?.serverConfig ?? null))
  const proposalPreviewAvailable = serverConfig?.environment.capabilities.proposalPreview === true
  const architectureImpactAvailable =
    serverConfig?.environment.capabilities.architectureImpact === true
  const versionMismatch = resolveServerConfigVersionMismatch(serverConfig)
  const versionMismatchDismissKey =
    versionMismatch && activeThread
      ? buildVersionMismatchDismissalKey(activeThread.environmentId, versionMismatch)
      : null
  const [dismissedVersionMismatchKey, setDismissedVersionMismatchKey] = useState<string | null>(
    null,
  )
  const versionMismatchDismissed =
    versionMismatchDismissKey === dismissedVersionMismatchKey ||
    isVersionMismatchDismissed(versionMismatchDismissKey)
  const showVersionMismatchBanner =
    versionMismatch !== null && versionMismatchDismissKey !== null && !versionMismatchDismissed
  const hasMultipleRegisteredEnvironments = environments.length > 1
  const versionMismatchServerLabel =
    hasMultipleRegisteredEnvironments && activeThread
      ? `${environmentById.get(activeThread.environmentId)?.label ?? serverConfig?.environment.label ?? activeThread.environmentId} server`
      : 'server'
  const versionMismatchEnvironmentId =
    versionMismatch && activeThread ? activeThread.environmentId : null
  const versionMismatchSelfUpdate = resolveServerSelfUpdateCapability(serverConfig)
  const systemComposerBannerItems = useMemo<ComposerBannerStackItem[]>(() =>
  {
    const items: ComposerBannerStackItem[] = []
    if (activeEnvironmentUnavailableState)
    {
      const connection = activeEnvironmentUnavailableState.connection
      const isReconnecting =
        connection.phase === 'connecting' || connection.phase === 'reconnecting'
      const suppressTransientReconnectWarning = shouldSuppressTransientEnvironmentReconnectWarning(
        isReconnecting,
        reconnectWarningGraceElapsed,
      )
      if (!suppressTransientReconnectWarning)
      {
        items.push({
          id: `environment-unavailable:${activeEnvironmentUnavailableState.environmentId}`,
          variant: connection.phase === 'error' ? 'error' : 'warning',
          icon: <WifiOffIcon />,
          title: `${activeEnvironmentUnavailableState.label}: ${connectionStatusTitle(connection)}`,
          description:
            connection.error ??
            'Reconnect this environment before sending messages or running actions.',
          actions: (
            <>
              <Button
                size="xs"
                disabled={isReconnecting}
                onClick={() =>
                  void handleReconnectActiveEnvironment(
                    activeEnvironmentUnavailableState.environmentId,
                  )
                }
              >
                {isReconnecting ? 'Reconnecting...' : 'Reconnect'}
              </Button>
              <Button
                size="xs"
                variant="outline"
                onClick={() => void navigate({ to: '/settings/connections' })}
              >
                Connections
              </Button>
            </>
          ),
        })
      }
    }
    if (
      showVersionMismatchBanner &&
      versionMismatch &&
      versionMismatchDismissKey &&
      versionMismatchEnvironmentId
    )
    {
      items.push({
        id: `version-mismatch:${versionMismatchDismissKey}`,
        variant: 'warning',
        icon: <TriangleAlertIcon />,
        title: 'Client and server versions differ',
        description: (
          <>
            Client {versionMismatch.clientVersion} is connected to {versionMismatchServerLabel}{' '}
            {versionMismatch.serverVersion}.{' '}
            {serverUpdateGuidance(versionMismatchSelfUpdate, versionMismatchServerLabel)}
          </>
        ),
        // the desktop-managed guidance is already the description; the action
        // slot would only repeat it.
        actions:
          versionMismatchSelfUpdate === 'desktop-managed' ? undefined : (
            <ServerUpdateAction
              environmentId={versionMismatchEnvironmentId}
              serverLabel={versionMismatchServerLabel}
              selfUpdate={versionMismatchSelfUpdate}
              targetVersion={versionMismatch.clientVersion}
            />
          ),
        dismissLabel: 'Dismiss version mismatch warning',
        onDismiss: () =>
        {
          dismissVersionMismatch(versionMismatchDismissKey)
          setDismissedVersionMismatchKey(versionMismatchDismissKey)
        },
      })
    }
    return items
  }, [
    activeEnvironmentUnavailableState,
    handleReconnectActiveEnvironment,
    navigate,
    reconnectWarningGraceElapsed,
    setDismissedVersionMismatchKey,
    showVersionMismatchBanner,
    versionMismatch,
    versionMismatchDismissKey,
    versionMismatchEnvironmentId,
    versionMismatchSelfUpdate,
    versionMismatchServerLabel,
  ])
  const providerStatuses = serverConfig?.providers ?? EMPTY_PROVIDERS
  const providerInstanceEntries = useMemo(
    () => deriveProviderInstanceEntries(providerStatuses),
    [providerStatuses],
  )
  // provider identity for the switch pill and the switch timeline dividers
  const resolveProviderSwitchInstance = useCallback<ProviderSwitchInstanceResolver>(
    (instanceId) =>
    {
      const entry = providerInstanceEntries.find((candidate) => candidate.instanceId === instanceId)
      return entry ? { driverKind: entry.driverKind, displayName: entry.displayName } : null
    },
    [providerInstanceEntries],
  )
  const importContinuationGate = useMemo(
    () =>
      resolveImportContinuationGate({
        thread: activeThread,
        providers: providerStatuses,
      }),
    [activeThread, providerStatuses],
  )
  const lockedProvider = deriveLockedProvider({
    thread: activeThread,
    selectedProvider: selectedProviderByThreadId,
    threadProvider,
    providers: providerStatuses,
    importContinuationGate,
  })
  const currentImportConsentToken = importContinuationConsentToken(
    routeThreadKey,
    importContinuationGate,
  )
  const importConsentGiven =
    currentImportConsentToken !== null && acceptedImportConsentToken === currentImportConsentToken
  const importContinuationConsent =
    importConsentGiven &&
    (importContinuationGate.state === 'verified' || importContinuationGate.state === 'history-only')
      ? importContinuationGate.consent
      : undefined
  const importContinuationSendBlocked = isImportContinuationSendBlocked(
    importContinuationGate,
    currentImportConsentToken,
    acceptedImportConsentToken,
  )
  const importProviderInstanceId =
    importContinuationGate.state === 'verified' || importContinuationGate.state === 'history-only'
      ? importContinuationGate.providerInstanceId
      : null
  const importProviderDriverKind =
    importContinuationGate.state === 'verified' || importContinuationGate.state === 'history-only'
      ? importContinuationGate.driverKind
      : null
  const importProviderContinuationIdentity =
    importContinuationGate.state === 'verified' || importContinuationGate.state === 'history-only'
      ? importContinuationGate.consent.continuation.continuationIdentity
      : null
  const importProviderSnapshot = useMemo(
    () =>
      resolveImportContinuationProviderSnapshot(
        providerStatuses,
        importProviderInstanceId,
        importProviderDriverKind,
        importProviderContinuationIdentity,
      ),
    [
      importProviderContinuationIdentity,
      importProviderDriverKind,
      importProviderInstanceId,
      providerStatuses,
    ],
  )
  const importProviderEntry = useMemo(
    () =>
      importProviderSnapshot === null
        ? null
        : (deriveProviderInstanceEntries([importProviderSnapshot])[0] ?? null),
    [importProviderSnapshot],
  )
  const importProviderDisplayName =
    importProviderEntry?.displayName ?? importProviderInstanceId ?? 'the configured provider'
  const composerProviderStatuses = useMemo(() =>
  {
    if (importContinuationGate.state === 'not-required')
    {
      return providerStatuses
    }
    if (importProviderInstanceId === null)
    {
      return EMPTY_PROVIDERS
    }
    return importProviderSnapshot === null ? EMPTY_PROVIDERS : [importProviderSnapshot]
  }, [
    importContinuationGate.state,
    importProviderInstanceId,
    importProviderSnapshot,
    providerStatuses,
  ])
  const verifiedImportProviderInstanceId =
    importContinuationGate.state === 'verified' ? importContinuationGate.providerInstanceId : null
  const focusImportContinuationBanner = useCallback(() =>
  {
    setImportBlockedAnnouncementCount((count) => count + 1)
    if (typeof document === 'undefined')
    {
      return
    }
    window.requestAnimationFrame(() =>
    {
      document
        .querySelector<HTMLElement>('[data-import-continuation-action="true"]')
        ?.focus({ preventScroll: true })
    })
  }, [])
  const unlockedSelectedProvider = resolveSelectableProvider(
    providerStatuses,
    selectedProviderByThreadId ?? threadProvider,
  )
  const selectedProvider: ProviderDriverKind = lockedProvider ?? unlockedSelectedProvider
  const phase = derivePhase(activeThread?.session ?? null)
  const threadActivities = activeThread?.activities ?? EMPTY_ACTIVITIES
  const workLogEntries = useMemo(() => deriveWorkLogEntries(threadActivities), [threadActivities])
  const workerVerdicts = useMemo(() => deriveWorkerVerdictMap(threadActivities), [threadActivities])
  const providerSwitchTimelineEvents = useMemo(
    () => deriveProviderSwitchTimelineEvents(threadActivities, resolveProviderSwitchInstance),
    [resolveProviderSwitchInstance, threadActivities],
  )
  // the summary a switch left behind is owned by the provider the thread now
  // targets, so the pill names that instance and reports only what the thread's
  // durable delivery record proves
  const pendingHandoffPresentation = useMemo(() =>
  {
    const handoff = activeThread?.pendingHandoff
    if (!activeThread || !handoff)
    {
      return null
    }
    const selection = activeThread.modelSelection
    return resolvePendingHandoffPresentation({
      handoff,
      activities: threadActivities,
      sentSinceHandoff: activeThread.messages.some(
        (message) => message.role === 'user' && message.createdAt >= handoff.createdAt,
      ),
      targetLabel: formatProviderSwitchTargetLabel({
        instanceId: selection.instanceId,
        displayName: resolveProviderSwitchInstance(selection.instanceId)?.displayName,
        model: selection.model,
      }),
    })
  }, [activeThread, resolveProviderSwitchInstance, threadActivities])
  const pendingApprovals = useMemo(
    () => derivePendingApprovals(threadActivities, activeThread?.approvalOutcomes),
    [activeThread?.approvalOutcomes, threadActivities],
  )
  const approvalResponseDisabledRequestIds = useMemo(() =>
  {
    const requestIds = new Set(respondingRequestIds)
    for (const approval of pendingApprovals)
    {
      if (approval.status === 'responding' || approval.status === 'unknown')
      {
        requestIds.add(approval.requestId)
      }
    }
    return [...requestIds]
  }, [pendingApprovals, respondingRequestIds])
  const pendingUserInputs = useMemo(
    () => derivePendingUserInputs(threadActivities),
    [threadActivities],
  )
  const activePendingUserInput = pendingUserInputs[0] ?? null
  const activePendingDraftAnswers = useMemo(
    () =>
      activePendingUserInput
        ? (pendingUserInputAnswersByRequestId[activePendingUserInput.requestId] ??
          EMPTY_PENDING_USER_INPUT_ANSWERS)
        : EMPTY_PENDING_USER_INPUT_ANSWERS,
    [activePendingUserInput, pendingUserInputAnswersByRequestId],
  )
  const activePendingQuestionIndex = activePendingUserInput
    ? (pendingUserInputQuestionIndexByRequestId[activePendingUserInput.requestId] ?? 0)
    : 0
  const activePendingProgress = useMemo(
    () =>
      activePendingUserInput
        ? derivePendingUserInputProgress(
            activePendingUserInput.questions,
            activePendingDraftAnswers,
            activePendingQuestionIndex,
          )
        : null,
    [activePendingDraftAnswers, activePendingQuestionIndex, activePendingUserInput],
  )
  const activePendingResolvedAnswers = useMemo(
    () =>
      activePendingUserInput
        ? buildPendingUserInputAnswers(activePendingUserInput.questions, activePendingDraftAnswers)
        : null,
    [activePendingDraftAnswers, activePendingUserInput],
  )
  const activePendingIsResponding = activePendingUserInput
    ? respondingUserInputRequestIds.includes(activePendingUserInput.requestId)
    : false
  const activeProposedPlan = useMemo(() =>
  {
    if (!latestTurnSettled)
    {
      return null
    }
    return findLatestProposedPlan(
      activeThread?.proposedPlans ?? [],
      activeLatestTurn?.turnId ?? null,
    )
  }, [activeLatestTurn?.turnId, activeThread?.proposedPlans, latestTurnSettled])
  const sidebarProposedPlan = useMemo(
    () =>
      findSidebarProposedPlan({
        threads: threadPlanCatalog,
        latestTurn: activeLatestTurn,
        latestTurnSettled,
        threadId: activeThread?.id ?? null,
      }),
    [activeLatestTurn, activeThread?.id, latestTurnSettled, threadPlanCatalog],
  )
  const activePlan = useMemo(
    () => deriveActivePlanState(threadActivities, activeLatestTurn?.turnId ?? undefined),
    [activeLatestTurn?.turnId, threadActivities],
  )
  const planSidebarLabel =
    sidebarProposedPlan || collaborationMode.baseMode === 'plan' ? 'Plan' : 'Tasks'
  const showPlanFollowUpPrompt =
    pendingUserInputs.length === 0 &&
    collaborationMode.baseMode === 'plan' &&
    latestTurnSettled &&
    hasActionableProposedPlan(activeProposedPlan)
  const activePendingApproval = pendingApprovals[0] ?? null
  const {
    beginLocalDispatch,
    resetLocalDispatch,
    localDispatchStartedAt,
    isPreparingWorktree,
    isSendBusy,
  } = useLocalDispatchState({
    activeThread,
    activeLatestTurn,
    phase,
    activePendingApproval: activePendingApproval?.requestId ?? null,
    activePendingUserInput: activePendingUserInput?.requestId ?? null,
    threadError,
  })
  const isWorking = phase === 'running' || isSendBusy || isConnecting || isRevertingCheckpoint
  const activeWorkStartedAt = deriveActiveWorkStartedAt(
    activeLatestTurn,
    activeThread?.session ?? null,
    localDispatchStartedAt,
  )
  useEffect(() =>
  {
    attachmentPreviewHandoffByMessageIdRef.current = attachmentPreviewHandoffByMessageId
  }, [attachmentPreviewHandoffByMessageId])
  const clearAttachmentPreviewHandoff = useCallback(
    (messageId: MessageId, previewUrls?: ReadonlyArray<string>) =>
    {
      delete attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId]
      const currentPreviewUrls =
        previewUrls ?? attachmentPreviewHandoffByMessageIdRef.current[messageId] ?? []
      setAttachmentPreviewHandoffByMessageId((existing) =>
      {
        if (!(messageId in existing))
        {
          return existing
        }
        const next = { ...existing }
        delete next[messageId]
        attachmentPreviewHandoffByMessageIdRef.current = next
        return next
      })
      for (const previewUrl of currentPreviewUrls)
      {
        revokeBlobPreviewUrl(previewUrl)
      }
    },
    [],
  )
  const clearAttachmentPreviewHandoffs = useCallback(() =>
  {
    attachmentPreviewPromotionInFlightByMessageIdRef.current = {}
    for (const previewUrls of Object.values(attachmentPreviewHandoffByMessageIdRef.current))
    {
      for (const previewUrl of previewUrls)
      {
        revokeBlobPreviewUrl(previewUrl)
      }
    }
    attachmentPreviewHandoffByMessageIdRef.current = {}
    setAttachmentPreviewHandoffByMessageId({})
  }, [])
  useEffect(() =>
  {
    return () =>
    {
      clearAttachmentPreviewHandoffs()
      for (const message of optimisticUserMessagesRef.current)
      {
        revokeUserMessagePreviewUrls(message)
      }
    }
  }, [clearAttachmentPreviewHandoffs])
  const handoffAttachmentPreviews = useCallback((messageId: MessageId, previewUrls: string[]) =>
  {
    if (previewUrls.length === 0) return

    const previousPreviewUrls = attachmentPreviewHandoffByMessageIdRef.current[messageId] ?? []
    const nextPreviewUrlSet = new Set(previewUrls)
    for (const previewUrl of previousPreviewUrls)
    {
      if (!nextPreviewUrlSet.has(previewUrl))
      {
        revokeBlobPreviewUrl(previewUrl)
      }
    }
    setAttachmentPreviewHandoffByMessageId((existing) =>
    {
      const next = {
        ...existing,
        [messageId]: previewUrls,
      }
      attachmentPreviewHandoffByMessageIdRef.current = next
      return next
    })
  }, [])
  const serverMessages = activeThread?.messages
  const serverAttachmentIds = useMemo(() =>
  {
    const attachmentIds = new Set<string>()
    for (const message of serverMessages ?? [])
    {
      for (const attachment of message.attachments ?? [])
      {
        attachmentIds.add(attachment.id)
      }
    }
    return [...attachmentIds]
  }, [serverMessages])
  const serverAttachmentResources = useMemo(
    () =>
      serverAttachmentIds.map((attachmentId) => ({
        _tag: 'attachment' as const,
        attachmentId,
      })),
    [serverAttachmentIds],
  )
  const serverAttachmentUrls = useAssetUrls(environmentId, serverAttachmentResources)
  const serverAttachmentUrlById = useMemo(
    () =>
      new Map(
        serverAttachmentIds.flatMap((attachmentId, index) =>
        {
          const url = serverAttachmentUrls[index]
          return url ? [[attachmentId, url] as const] : []
        }),
      ),
    [serverAttachmentIds, serverAttachmentUrls],
  )
  const displayServerMessages = useMemo<ReadonlyArray<ChatMessage>>(() =>
  {
    if (!serverMessages) return []
    return serverMessages.map((message) =>
    {
      if (!message.attachments || message.attachments.length === 0)
      {
        return message
      }
      return {
        ...message,
        attachments: message.attachments.map((attachment) =>
        {
          const previewUrl = serverAttachmentUrlById.get(attachment.id)
          return previewUrl ? { ...attachment, previewUrl } : attachment
        }),
      }
    })
  }, [serverAttachmentUrlById, serverMessages])
  useEffect(() =>
  {
    if (typeof Image === 'undefined' || displayServerMessages.length === 0)
    {
      return
    }

    const cleanups: Array<() => void> = []
    const userMessagesById = new Map<string, ChatMessage>(
      displayServerMessages
        .filter((message) => message.role === 'user')
        .map((message) => [String(message.id), message] as const),
    )

    for (const [messageId, handoffPreviewUrls] of Object.entries(
      attachmentPreviewHandoffByMessageId,
    ))
    {
      if (attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId])
      {
        continue
      }

      const serverMessage = userMessagesById.get(messageId)
      if (!serverMessage?.attachments || serverMessage.attachments.length === 0)
      {
        continue
      }

      const serverPreviewUrls = serverMessage.attachments.flatMap((attachment) =>
        attachment.type === 'image' && attachment.previewUrl ? [attachment.previewUrl] : [],
      )
      if (
        serverPreviewUrls.length === 0 ||
        serverPreviewUrls.length !== handoffPreviewUrls.length ||
        serverPreviewUrls.some((previewUrl) => previewUrl.startsWith('blob:'))
      )
      {
        continue
      }

      attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId] = true

      let cancelled = false
      const imageInstances: HTMLImageElement[] = []

      const preloadServerPreviews = Promise.all(
        serverPreviewUrls.map(
          (previewUrl) =>
            new Promise<void>((resolve, reject) =>
            {
              const image = new Image()
              imageInstances.push(image)
              const handleLoad = () => resolve()
              const handleError = () =>
                reject(new Error(`Failed to load server preview for ${messageId}.`))
              image.addEventListener('load', handleLoad, { once: true })
              image.addEventListener('error', handleError, { once: true })
              image.src = previewUrl
            }),
        ),
      )

      void preloadServerPreviews
        .then(() =>
        {
          if (cancelled)
          {
            return
          }
          clearAttachmentPreviewHandoff(messageId as MessageId, handoffPreviewUrls)
        })
        .catch(() =>
        {
          if (!cancelled)
          {
            delete attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId]
          }
        })

      cleanups.push(() =>
      {
        cancelled = true
        delete attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId]
        for (const image of imageInstances)
        {
          image.src = ''
        }
      })
    }

    return () =>
    {
      for (const cleanup of cleanups)
      {
        cleanup()
      }
    }
  }, [attachmentPreviewHandoffByMessageId, clearAttachmentPreviewHandoff, displayServerMessages])
  const timelineMessages = useMemo(() =>
  {
    const messages = displayServerMessages
    // copy only messages with changed attachment handoffs to preserve stable references
    const serverMessagesWithPreviewHandoff =
      Object.keys(attachmentPreviewHandoffByMessageId).length === 0
        ? messages
        : messages.map((message) =>
          {
            if (
              message.role !== 'user' ||
              !message.attachments ||
              message.attachments.length === 0
            )
              {
              return message
            }
            const handoffPreviewUrls = attachmentPreviewHandoffByMessageId[message.id]
            if (!handoffPreviewUrls || handoffPreviewUrls.length === 0)
              {
              return message
            }

            let changed = false
            let imageIndex = 0
            const attachments = message.attachments.map((attachment) =>
              {
              if (attachment.type !== 'image')
                {
                return attachment
              }
              const handoffPreviewUrl = handoffPreviewUrls[imageIndex]
              imageIndex += 1
              if (!handoffPreviewUrl || attachment.previewUrl === handoffPreviewUrl)
                {
                return attachment
              }
              changed = true
              return {
                ...attachment,
                previewUrl: handoffPreviewUrl,
              }
            })

            return changed ? { ...message, attachments } : message
          })

    if (optimisticUserMessages.length === 0)
    {
      return serverMessagesWithPreviewHandoff
    }
    const serverIds = new Set(serverMessagesWithPreviewHandoff.map((message) => message.id))
    const pendingMessages = optimisticUserMessages.filter((message) => !serverIds.has(message.id))
    if (pendingMessages.length === 0)
    {
      return serverMessagesWithPreviewHandoff
    }
    return [...serverMessagesWithPreviewHandoff, ...pendingMessages]
  }, [attachmentPreviewHandoffByMessageId, displayServerMessages, optimisticUserMessages])
  const timelineEntries = useMemo(
    () =>
      deriveTimelineEntries(
        timelineMessages,
        activeThread?.proposedPlans ?? [],
        workLogEntries,
        providerSwitchTimelineEvents,
        threadActivities,
        activeThread?.orchestratePlans ?? [],
      ),
    [
      activeThread?.orchestratePlans,
      activeThread?.proposedPlans,
      providerSwitchTimelineEvents,
      threadActivities,
      timelineMessages,
      workLogEntries,
    ],
  )
  const [dockedDraftHeroThreadKey, setDockedDraftHeroThreadKey] = useState<string | null>(null)
  const draftHeroDockRequested =
    activeThreadKey !== null && dockedDraftHeroThreadKey === activeThreadKey
  const isDraftHeroState =
    isLocalDraftThread && timelineEntries.length === 0 && !isWorking && !draftHeroDockRequested
  const [
    attachDraftHeroTransitionGroupRef,
    attachDraftHeroComposerAnchorRef,
    captureDraftHeroComposerRect,
  ] = useDraftHeroLayoutTransition(isDraftHeroState)
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread)
  const turnDiffSummaryByAssistantMessageId = useMemo(() =>
  {
    const byMessageId = new Map<MessageId, TurnDiffSummary>()
    for (const summary of turnDiffSummaries)
    {
      if (!summary.assistantMessageId) continue
      byMessageId.set(summary.assistantMessageId, summary)
    }
    return byMessageId
  }, [turnDiffSummaries])
  const revertTurnCountByUserMessageId = useMemo(() =>
  {
    const byUserMessageId = new Map<MessageId, number>()
    for (let index = 0; index < timelineEntries.length; index += 1)
    {
      const entry = timelineEntries[index]
      if (!entry || entry.kind !== 'message' || entry.message.role !== 'user')
      {
        continue
      }

      for (let nextIndex = index + 1; nextIndex < timelineEntries.length; nextIndex += 1)
      {
        const nextEntry = timelineEntries[nextIndex]
        if (!nextEntry || nextEntry.kind !== 'message')
        {
          continue
        }
        if (nextEntry.message.role === 'user')
        {
          break
        }
        const summary = turnDiffSummaryByAssistantMessageId.get(nextEntry.message.id)
        if (!summary)
        {
          continue
        }
        const turnCount =
          summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId]
        if (typeof turnCount !== 'number')
        {
          break
        }
        byUserMessageId.set(entry.message.id, Math.max(0, turnCount - 1))
        break
      }
    }

    return byUserMessageId
  }, [inferredCheckpointTurnCountByTurnId, timelineEntries, turnDiffSummaryByAssistantMessageId])

  const gitCwd = activeProject
    ? projectScriptCwd({
        project: { cwd: activeProject.workspaceRoot },
        worktreePath: activeThread?.worktreePath ?? null,
      })
    : null
  const activeRunWorktreePath = activeThread?.orchestrateRunWorktreePath ?? null
  // the adopted run worktree can be pruned while the thread sits idle, and the
  // server only releases the recorded path on that thread's next turn. this probe
  // is pinned to the adopted path instead of reusing gitStatusQuery below, whose
  // cwd moves with the resolver and would flap between the two candidates forever
  // ! this cwd must stay pinned to activeRunWorktreePath. point it at gitStatusCwd,
  // or derive the flag below from the resolver's output, and it never settles: dead
  // root -> isRepo false -> the chain falls back -> live root -> isRepo true -> the
  // flag clears -> dead root again
  const runWorktreeStatusQuery = useEnvironmentQuery(
    activeRunWorktreePath === null
      ? null
      : vcsEnvironment.status({
          environmentId,
          input: { cwd: activeRunWorktreePath },
        }),
  )
  // one derived answer to "is the adopted tree still there", so the branch
  // mismatch further down agrees with the root gitStatusQuery actually reads
  const runWorktreeIsNotRepository = runWorktreeStatusQuery.data?.isRepo === false
  const effectiveRunWorktreePath = runWorktreeIsNotRepository ? null : activeRunWorktreePath
  // gitCwd above stays where the user's editor, terminal and scripts open, which
  // is a question about execution. gitStatusCwd answers "where do this thread's
  // changes live", so it follows the run's integration worktree first — otherwise
  // the header reports a clean tree for a run that has been committing all day.
  // a pruned run worktree answers "not a git repository" rather than failing, so
  // trusting it would report exactly that same empty tree from the other side
  const gitStatusCwd =
    resolveThreadChangeRoot({
      orchestrateRunWorktreePath: activeRunWorktreePath,
      worktreePath: activeThread?.worktreePath ?? null,
      workspaceRoot: null,
      orchestrateRunWorktreeIsNotRepository: runWorktreeIsNotRepository,
    }) ?? gitCwd
  const gitStatusQuery = useEnvironmentQuery(
    gitStatusCwd === null
      ? null
      : vcsEnvironment.status({
          environmentId,
          input: { cwd: gitStatusCwd },
        }),
  )
  const keybindings = useAtomValue(primaryServerKeybindingsAtom)
  const availableEditors = useAtomValue(primaryServerAvailableEditorsAtom)
  // prefer an instance-id match so a custom Codex instance (e.g.
  // `codex_personal`) surfaces its own status/message in the banner rather
  // than the default Codex's. Falls back to first-match-by-kind when no
  // saved instance id is available or the instance no longer exists.
  const selectedProviderInstanceId =
    providerStatuses.find((status) => status.instanceId === selectedProviderByThreadId)
      ?.instanceId ?? null
  const activeProviderInstanceId =
    selectedProviderInstanceId ??
    activeThread?.session?.providerInstanceId ??
    activeThread?.modelSelection.instanceId ??
    activeProject?.defaultModelSelection?.instanceId ??
    null
  const activeProviderStatus = useMemo(() =>
  {
    if (activeProviderInstanceId)
    {
      return (
        providerStatuses.find((status) => status.instanceId === activeProviderInstanceId) ?? null
      )
    }
    const defaultInstanceId = defaultInstanceIdForDriver(selectedProvider)
    return providerStatuses.find((status) => status.instanceId === defaultInstanceId) ?? null
  }, [activeProviderInstanceId, providerStatuses, selectedProvider])
  // an auth failure that lands mid-thread arrives as a session error while the
  // provider probe still reads healthy, so promote it to the re-auth banner
  // instead of leaving it as one more generic thread error.
  const providerReAuthRequired = shouldPromoteThreadErrorToProviderReAuth(
    activeProviderStatus,
    visibleThreadError,
  )
  const providerStatusBannerKey = getProviderStatusBannerKey(
    activeProviderStatus,
    providerReAuthRequired,
  )
  const [dismissedProviderStatusBannerKey, setDismissedProviderStatusBannerKey] = useState<
    string | null
  >(null)
  useEffect(() =>
  {
    if (providerStatusBannerKey === null && dismissedProviderStatusBannerKey !== null)
    {
      setDismissedProviderStatusBannerKey(null)
    }
  }, [dismissedProviderStatusBannerKey, providerStatusBannerKey])
  const visibleProviderStatus = shouldShowProviderStatusBanner(
    activeProviderStatus,
    dismissedProviderStatusBannerKey,
    providerReAuthRequired,
  )
    ? activeProviderStatus
    : null
  // the promoted banner carries the raw error, so the generic one would only
  // repeat it; dismissing the promotion hands the error back.
  const promotedProviderAuthError = providerReAuthRequired && visibleProviderStatus !== null
  const hasTimelineTopBanner = Boolean(visibleThreadError) || visibleProviderStatus !== null
  const activeProjectCwd = activeProject?.workspaceRoot ?? null
  const activeThreadWorktreePath = activeThread?.worktreePath ?? null
  const activeWorkspaceRoot = activeThreadWorktreePath ?? activeProjectCwd ?? undefined
  const activeTerminalLaunchContext =
    terminalUiLaunchContext?.threadId === activeThreadId ? terminalUiLaunchContext : null
  // default true while loading to avoid toolbar flicker.
  const isGitRepo = gitStatusQuery.data?.isRepo ?? true
  const showComposerContextStrip = isGitRepo && activeProject !== null
  const initialDiffPanelGitScope =
    gitStatusQuery.data?.hasWorkingTreeChanges === true ? 'unstaged' : 'branch'
  const diffPanelGitStatusResolutionKey = gitStatusQuery.data ? 'resolved' : 'pending'
  const terminalShortcutLabelOptions = useMemo(
    () => ({
      context: {
        terminalFocus: true,
        terminalOpen: Boolean(terminalUiState.terminalOpen),
      },
    }),
    [terminalUiState.terminalOpen],
  )
  const splitTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, 'terminal.split', terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  )
  const splitTerminalVerticalShortcutLabel = useMemo(
    () =>
      shortcutLabelForCommand(keybindings, 'terminal.splitVertical', terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  )
  const newTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, 'terminal.new', terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  )
  const closeTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, 'terminal.close', terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  )
  const envLocked = Boolean(
    activeThread &&
    (activeThread.messages.length > 0 ||
      (activeThread.session !== null && activeThread.session.status !== 'stopped')),
  )

  // handle environment change for draft threads.  When the user picks a
  // different environment we update the draft context to point at the physical
  // project in that environment while keeping the same logical project.
  const onEnvironmentChange = useCallback(
    (nextEnvironmentId: EnvironmentId) =>
    {
      if (envLocked || !draftId) return
      const target = logicalProjectEnvironments.find(
        (env) => env.environmentId === nextEnvironmentId,
      )
      if (!target) return
      setDraftThreadContext(draftId, {
        projectRef: scopeProjectRef(target.environmentId, target.projectId),
      })
    },
    [draftId, envLocked, logicalProjectEnvironments, setDraftThreadContext],
  )

  const activeTerminalGroup =
    terminalUiState.terminalGroups.find(
      (group) => group.id === terminalUiState.activeTerminalGroupId,
    ) ??
    terminalUiState.terminalGroups.find((group) =>
      group.terminalIds.includes(terminalUiState.activeTerminalId),
    ) ??
    null
  const hasReachedSplitLimit =
    (activeTerminalGroup?.terminalIds.length ?? 0) >= MAX_TERMINALS_PER_GROUP
  const setThreadError = useCallback(
    (targetThreadId: ThreadId | null, error: string | null) =>
    {
      if (!targetThreadId) return
      const nextError = sanitizeThreadErrorMessage(error)
      const nextEntry: LocalThreadErrorEntry = { message: nextError, at: Date.now() }
      if (
        shouldWriteThreadErrorToCurrentServerThread({
          activeServerThread,
          routeThreadRef,
          targetThreadId,
        })
      )
      {
        setLocalServerErrorsByThreadKey((existing) =>
        {
          if ((existing[routeThreadKey]?.message ?? null) === nextError)
          {
            return existing
          }
          return {
            ...existing,
            [routeThreadKey]: nextEntry,
          }
        })
        return
      }
      const localDraftErrorKey = draftId ?? targetThreadId
      setLocalDraftErrorsByDraftId((existing) =>
      {
        if ((existing[localDraftErrorKey]?.message ?? null) === nextError)
        {
          return existing
        }
        return {
          ...existing,
          [localDraftErrorKey]: nextEntry,
        }
      })
    },
    [activeServerThread, draftId, routeThreadKey, routeThreadRef],
  )

  const focusComposer = useCallback(() =>
  {
    composerRef.current?.focusAtEnd()
  }, [composerRef])
  const scheduleComposerFocus = useCallback(() =>
  {
    window.requestAnimationFrame(() =>
    {
      focusComposer()
    })
  }, [focusComposer])
  const addTerminalContextToDraft = useCallback(
    (selection: TerminalContextSelection) =>
    {
      composerRef.current?.addTerminalContext(selection)
    },
    [composerRef],
  )
  const setTerminalOpen = useCallback(
    (open: boolean) =>
    {
      if (!activeThreadRef) return
      storeSetTerminalOpen(activeThreadRef, open)
    },
    [activeThreadRef, storeSetTerminalOpen],
  )
  const toggleTerminalVisibility = useCallback(() =>
  {
    if (!activeThreadRef) return
    const nextOpen = !terminalUiState.terminalOpen
    if (nextOpen && terminalUiState.terminalIds.length === 0)
    {
      if (!activeThreadId || !activeProject)
      {
        return
      }
      const cwdForOpen = gitCwd ?? activeProject.workspaceRoot
      if (!cwdForOpen)
      {
        return
      }
      const terminalId = nextTerminalId([...activeKnownTerminalIds, ...panelTerminalIds])
      storeEnsureTerminal(activeThreadRef, terminalId, { open: true })
      void openTerminal({
        environmentId,
        input: {
          threadId: activeThreadId,
          terminalId,
          cwd: cwdForOpen,
          ...(activeThreadWorktreePath != null ? { worktreePath: activeThreadWorktreePath } : {}),
          env: projectScriptRuntimeEnv({
            project: { cwd: activeProject.workspaceRoot },
            worktreePath: activeThreadWorktreePath,
          }),
        },
      })
      return
    }
    setTerminalOpen(nextOpen)
  }, [
    activeKnownTerminalIds,
    activeProject,
    activeThreadId,
    activeThreadRef,
    activeThreadWorktreePath,
    environmentId,
    gitCwd,
    openTerminal,
    panelTerminalIds,
    setTerminalOpen,
    storeEnsureTerminal,
    terminalUiState.terminalIds.length,
    terminalUiState.terminalOpen,
  ])
  const splitTerminal = useCallback(
    (direction: 'horizontal' | 'vertical' = 'horizontal') =>
    {
      if (!activeThreadRef || hasReachedSplitLimit || !activeThreadId || !activeProject)
      {
        return
      }
      const cwdForOpen = gitCwd ?? activeProject.workspaceRoot
      if (!cwdForOpen)
      {
        return
      }
      const terminalId = nextTerminalId(activeKnownTerminalIds)
      if (direction === 'vertical')
      {
        storeSplitTerminalVertical(activeThreadRef, terminalId)
      }
      else
      {
        storeSplitTerminal(activeThreadRef, terminalId)
      }
      setTerminalFocusRequestId((value) => value + 1)
      void openTerminal({
        environmentId,
        input: {
          threadId: activeThreadId,
          terminalId,
          cwd: cwdForOpen,
          ...(activeThreadWorktreePath != null ? { worktreePath: activeThreadWorktreePath } : {}),
          env: projectScriptRuntimeEnv({
            project: { cwd: activeProject.workspaceRoot },
            worktreePath: activeThreadWorktreePath,
          }),
        },
      })
    },
    [
      activeProject,
      activeKnownTerminalIds,
      activeThreadId,
      activeThreadRef,
      openTerminal,
      activeThreadWorktreePath,
      environmentId,
      gitCwd,
      hasReachedSplitLimit,
      storeSplitTerminal,
      storeSplitTerminalVertical,
    ],
  )
  const createNewTerminal = useCallback(() =>
  {
    if (!activeThreadRef || !activeThreadId || !activeProject)
    {
      return
    }
    const cwdForOpen = gitCwd ?? activeProject.workspaceRoot
    if (!cwdForOpen)
    {
      return
    }
    const terminalId = nextTerminalId(activeKnownTerminalIds)
    storeNewTerminal(activeThreadRef, terminalId)
    setTerminalFocusRequestId((value) => value + 1)
    void openTerminal({
      environmentId,
      input: {
        threadId: activeThreadId,
        terminalId,
        cwd: cwdForOpen,
        ...(activeThreadWorktreePath != null ? { worktreePath: activeThreadWorktreePath } : {}),
        env: projectScriptRuntimeEnv({
          project: { cwd: activeProject.workspaceRoot },
          worktreePath: activeThreadWorktreePath,
        }),
      },
    })
  }, [
    activeProject,
    activeKnownTerminalIds,
    activeThreadId,
    activeThreadRef,
    openTerminal,
    activeThreadWorktreePath,
    environmentId,
    gitCwd,
    storeNewTerminal,
  ])
  const closeTerminal = useCallback(
    (terminalId: string) =>
    {
      if (!activeThreadId || !activeThreadRef) return
      const fallbackExitWrite = () =>
        writeTerminal({
          environmentId,
          input: { threadId: activeThreadId, terminalId, data: 'exit\n' },
        })
      void (async () =>
      {
        const closeResult = await closeTerminalMutation({
          environmentId,
          input: {
            threadId: activeThreadId,
            terminalId,
            deleteHistory: true,
          },
        })
        if (closeResult._tag === 'Failure' && !isAtomCommandInterrupted(closeResult))
        {
          await fallbackExitWrite()
        }
      })()
      storeCloseTerminal(activeThreadRef, terminalId)
      setTerminalFocusRequestId((value) => value + 1)
    },
    [
      activeThreadId,
      activeThreadRef,
      closeTerminalMutation,
      environmentId,
      storeCloseTerminal,
      writeTerminal,
    ],
  )
  const runProjectScript = useCallback(
    async (
      script: ProjectScript,
      options?: {
        cwd?: string
        env?: Record<string, string>
        worktreePath?: string | null
        preferNewTerminal?: boolean
        rememberAsLastInvoked?: boolean
      },
    ) =>
    {
      if (!activeThreadId || !activeProject || !activeThread) return
      if (options?.rememberAsLastInvoked !== false)
      {
        setLastInvokedScriptByProjectId((current) =>
        {
          if (current[activeProject.id] === script.id) return current
          return { ...current, [activeProject.id]: script.id }
        })
      }
      const targetCwd = options?.cwd ?? gitCwd ?? activeProject.workspaceRoot
      const baseTerminalId =
        terminalUiState.activeTerminalId || activeKnownTerminalIds[0] || DEFAULT_THREAD_TERMINAL_ID
      const isBaseTerminalBusy = runningTerminalIds.includes(baseTerminalId)
      const wantsNewTerminal = Boolean(options?.preferNewTerminal) || isBaseTerminalBusy
      const shouldCreateNewTerminal = wantsNewTerminal
      const targetWorktreePath = options?.worktreePath ?? activeThread.worktreePath ?? null

      setTerminalUiLaunchContext({
        threadId: activeThreadId,
        cwd: targetCwd,
        worktreePath: targetWorktreePath,
      })
      setTerminalOpen(true)
      if (!activeThreadRef)
      {
        return
      }
      setTerminalFocusRequestId((value) => value + 1)

      const runtimeEnv = projectScriptRuntimeEnv({
        project: {
          cwd: activeProject.workspaceRoot,
        },
        worktreePath: targetWorktreePath,
        ...(options?.env ? { extraEnv: options.env } : {}),
      })
      const targetTerminalId = shouldCreateNewTerminal
        ? nextTerminalId(activeKnownTerminalIds)
        : baseTerminalId
      const openTerminalInput: TerminalOpenInput = shouldCreateNewTerminal
        ? {
            threadId: activeThreadId,
            terminalId: targetTerminalId,
            cwd: targetCwd,
            ...(targetWorktreePath !== null ? { worktreePath: targetWorktreePath } : {}),
            env: runtimeEnv,
            cols: SCRIPT_TERMINAL_COLS,
            rows: SCRIPT_TERMINAL_ROWS,
          }
        : {
            threadId: activeThreadId,
            terminalId: targetTerminalId,
            cwd: targetCwd,
            ...(targetWorktreePath !== null ? { worktreePath: targetWorktreePath } : {}),
            env: runtimeEnv,
          }

      if (shouldCreateNewTerminal)
      {
        storeNewTerminal(activeThreadRef, targetTerminalId)
      }
      else
      {
        storeSetActiveTerminal(activeThreadRef, targetTerminalId)
      }

      const openResult = await openTerminal({ environmentId, input: openTerminalInput })
      if (openResult._tag === 'Failure')
      {
        if (!isAtomCommandInterrupted(openResult))
        {
          const error = squashAtomCommandFailure(openResult)
          setThreadError(
            activeThreadId,
            error instanceof Error ? error.message : `Failed to run script "${script.name}".`,
          )
        }
        return
      }

      const writeResult = await writeTerminal({
        environmentId,
        input: {
          threadId: activeThreadId,
          terminalId: targetTerminalId,
          data: `${script.command}\r`,
        },
      })
      if (writeResult._tag === 'Failure' && !isAtomCommandInterrupted(writeResult))
      {
        const error = squashAtomCommandFailure(writeResult)
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : `Failed to run script "${script.name}".`,
        )
      }
    },
    [
      activeProject,
      activeThread,
      activeThreadId,
      activeThreadRef,
      gitCwd,
      setTerminalOpen,
      setThreadError,
      storeNewTerminal,
      storeSetActiveTerminal,
      setLastInvokedScriptByProjectId,
      environmentId,
      openTerminal,
      activeKnownTerminalIds,
      runningTerminalIds,
      terminalUiState.activeTerminalId,
      writeTerminal,
    ],
  )

  const persistProjectScripts = useCallback(
    async (input: {
      projectId: ProjectId
      projectCwd: string
      previousScripts: ReadonlyArray<ProjectScript>
      nextScripts: ReadonlyArray<ProjectScript>
      keybinding?: string | null
      keybindingCommand: KeybindingCommand
    }): Promise<AtomCommandResult<void, unknown>> =>
    {
      const updateResult = mapAtomCommandResult(
        await updateProject({
          environmentId,
          input: {
            projectId: input.projectId,
            scripts: input.nextScripts,
          },
        }),
        () => undefined,
      )
      if (updateResult._tag === 'Failure')
      {
        return updateResult
      }

      const keybindingRule = decodeProjectScriptKeybindingRule({
        keybinding: input.keybinding,
        command: input.keybindingCommand,
      })

      if (isElectron && keybindingRule)
      {
        return mapAtomCommandResult(
          await upsertKeybinding({
            environmentId,
            input: keybindingRule,
          }),
          () => undefined,
        )
      }
      return updateResult
    },
    [environmentId, updateProject, upsertKeybinding],
  )
  const saveProjectScript = useCallback(
    async (input: NewProjectScriptInput): Promise<AtomCommandResult<void, unknown>> =>
    {
      if (!activeProject)
      {
        return AsyncResult.success(undefined)
      }
      const nextId = nextProjectScriptId(
        input.name,
        activeProject.scripts.map((script) => script.id),
      )
      const nextScript = buildProjectScript(nextId, input)
      const nextScripts = input.runOnWorktreeCreate
        ? [
            ...activeProject.scripts.map((script) =>
              script.runOnWorktreeCreate ? { ...script, runOnWorktreeCreate: false } : script,
            ),
            nextScript,
          ]
        : [...activeProject.scripts, nextScript]

      return persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.workspaceRoot,
        previousScripts: activeProject.scripts,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(nextId),
      })
    },
    [activeProject, persistProjectScripts],
  )
  const updateProjectScript = useCallback(
    async (
      scriptId: string,
      input: NewProjectScriptInput,
    ): Promise<AtomCommandResult<void, unknown>> =>
    {
      if (!activeProject)
      {
        return AsyncResult.success(undefined)
      }
      const existingScript = activeProject.scripts.find((script) => script.id === scriptId)
      if (!existingScript)
      {
        return AsyncResult.failure(Cause.fail(new Error('Script not found.')))
      }

      const updatedScript = buildProjectScript(existingScript.id, input)
      const nextScripts = activeProject.scripts.map((script) =>
        script.id === scriptId
          ? updatedScript
          : input.runOnWorktreeCreate
            ? { ...script, runOnWorktreeCreate: false }
            : script,
      )

      return persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.workspaceRoot,
        previousScripts: activeProject.scripts,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(scriptId),
      })
    },
    [activeProject, persistProjectScripts],
  )
  const deleteProjectScript = useCallback(
    async (scriptId: string): Promise<AtomCommandResult<void, unknown>> =>
    {
      if (!activeProject)
      {
        return AsyncResult.success(undefined)
      }
      const nextScripts = activeProject.scripts.filter((script) => script.id !== scriptId)

      const deletedName = activeProject.scripts.find((s) => s.id === scriptId)?.name

      const result = await persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.workspaceRoot,
        previousScripts: activeProject.scripts,
        nextScripts,
        keybinding: null,
        keybindingCommand: commandForProjectScript(scriptId),
      })
      if (result._tag === 'Success')
      {
        toastManager.add({
          type: 'success',
          title: `Deleted action "${deletedName ?? 'Unknown'}"`,
        })
      }
      else if (!isAtomCommandInterrupted(result))
      {
        const error = squashAtomCommandFailure(result)
        toastManager.add(
          stackedThreadToast({
            type: 'error',
            title: 'Could not delete action',
            description: error instanceof Error ? error.message : 'An unexpected error occurred.',
          }),
        )
      }
      return result
    },
    [activeProject, persistProjectScripts],
  )

  const handleRuntimeModeChange = useCallback(
    (mode: RuntimeMode) =>
    {
      if (mode === runtimeMode) return
      setComposerDraftRuntimeMode(composerDraftTarget, mode)
      if (isLocalDraftThread)
      {
        setDraftThreadContext(composerDraftTarget, { runtimeMode: mode })
      }
      scheduleComposerFocus()
    },
    [
      isLocalDraftThread,
      runtimeMode,
      scheduleComposerFocus,
      composerDraftTarget,
      setComposerDraftRuntimeMode,
      setDraftThreadContext,
    ],
  )

  const handleInteractionModeChange = useCallback(
    (mode: CollaborationMode) =>
    {
      const normalizedMode = normalizeCollaborationMode(mode.baseMode, mode.orchestrate)
      if (
        normalizedMode.baseMode === collaborationMode.baseMode &&
        normalizedMode.orchestrate === collaborationMode.orchestrate
      )
      {
        scheduleComposerFocus()
        return
      }
      setComposerDraftInteractionMode(composerDraftTarget, normalizedMode)
      if (isLocalDraftThread)
      {
        setDraftThreadContext(composerDraftTarget, { collaborationMode: normalizedMode })
      }
      scheduleComposerFocus()
    },
    [
      collaborationMode,
      isLocalDraftThread,
      scheduleComposerFocus,
      composerDraftTarget,
      setComposerDraftInteractionMode,
      setDraftThreadContext,
    ],
  )
  const toggleInteractionMode = useCallback(() =>
  {
    handleInteractionModeChange(
      normalizeCollaborationMode(
        collaborationMode.baseMode === 'plan' ? 'default' : 'plan',
        collaborationMode.orchestrate,
      ),
    )
  }, [collaborationMode, handleInteractionModeChange])
  const dismissPlanSidebarForCurrentTurn = useCallback(() =>
  {
    planSidebarDismissedForTurnRef.current =
      activePlan?.turnId ?? sidebarProposedPlan?.turnId ?? '__dismissed__'
  }, [activePlan?.turnId, sidebarProposedPlan?.turnId])
  const resetPlanSidebarDismissal = useCallback(() =>
  {
    planSidebarDismissedForTurnRef.current = null
  }, [])
  const requestTerminalFocus = useCallback(() =>
  {
    setTerminalFocusRequestId((value) => value + 1)
  }, [])
  const explorerAvailable = activeProject !== null && isServerThread && proposalPreviewAvailable
  const repositoryAtlasAvailable =
    activeProject !== null && isServerThread && architectureImpactAvailable
  const {
    activatePanelTerminal,
    activateRightPanelSurface,
    addRepositoryAtlasSurface,
    addDiffSurface,
    addExplorerSurface,
    addFilesSurface,
    addTerminalSurface,
    addWorkersSurface,
    closeAllRightPanelSurfaces,
    closeOtherRightPanelSurfaces,
    closePanelTerminal: closePanelTerminalImmediately,
    closePlanSidebar,
    closePreviewPanel,
    closeRightPanelSurface: closeRightPanelSurfaceImmediately,
    closeRightPanelSurfacesToRight,
    copyRightPanelFilePath,
    createBrowserSurface,
    onToggleDiff,
    openFileSurface,
    splitPanelTerminal,
    splitPanelTerminalVertical,
    togglePlanSidebar,
    toggleRightPanel,
    toggleRightPanelMaximized,
  } = useChatRightPanelController({
    activeKnownTerminalIds,
    activePreviewTabId: activePreviewState.activeTabId,
    activePreviewSessions: activePreviewState.sessions,
    activeProjectWorkspaceRoot: activeProject?.workspaceRoot ?? null,
    activeRightPanelSurface,
    activeThreadRef,
    activeThreadWorktreePath,
    repositoryAtlasAvailable,
    canMaximizeRightPanel,
    closePreview,
    closeTerminal: closeTerminalMutation,
    diffOpen,
    dismissPlanSidebarForCurrentTurn,
    explorerAvailable,
    gitCwd,
    isGitRepo,
    isServerThread,
    onDiffPanelOpen,
    openPreview,
    openTerminal,
    panelTerminalIds,
    planSidebarOpen,
    previewPanelOpen,
    requestTerminalFocus,
    resetPlanSidebarDismissal,
    rightPanelOpen,
    rightPanelState,
    routeThreadKey,
    setMaximizedRightPanelThreadKey,
    storeCloseTerminal,
  })
  const requestCloseTerminal = useCallback(
    (terminalId: string) =>
    {
      const label = activeTerminalLabelsById.get(terminalId) ?? getTerminalLabel(terminalId)
      void confirmTerminalClose([label]).then((confirmed) =>
      {
        if (confirmed) closeTerminal(terminalId)
      })
    },
    [activeTerminalLabelsById, closeTerminal],
  )
  const requestClosePanelTerminal = useCallback(
    (terminalId: string) =>
    {
      const label = activeTerminalLabelsById.get(terminalId) ?? getTerminalLabel(terminalId)
      void confirmTerminalClose([label]).then((confirmed) =>
      {
        if (confirmed) closePanelTerminalImmediately(terminalId)
      })
    },
    [activeTerminalLabelsById, closePanelTerminalImmediately],
  )
  const closeRightPanelSurface = useCallback(
    (surface: RightPanelSurface) =>
    {
      if (surface.kind !== 'terminal')
      {
        closeRightPanelSurfaceImmediately(surface)
        return
      }
      const activeLabel =
        activeTerminalLabelsById.get(surface.activeTerminalId) ??
        getTerminalLabel(surface.activeTerminalId)
      const otherLabels = surface.terminalIds
        .filter((terminalId) => terminalId !== surface.activeTerminalId)
        .map(
          (terminalId) => activeTerminalLabelsById.get(terminalId) ?? getTerminalLabel(terminalId),
        )
      void confirmTerminalClose([activeLabel, ...otherLabels]).then((confirmed) =>
      {
        if (confirmed) closeRightPanelSurfaceImmediately(surface)
      })
    },
    [activeTerminalLabelsById, closeRightPanelSurfaceImmediately],
  )
  const architectureParentSurfaceId = activeRightPanelSurface?.id
  const [repositoryMapFocusRequest, setRepositoryMapFocusRequest] =
    useState<RepositoryMapFocusRequest | null>(null)
  const openArchitectureResourceFile = useCallback(
    (target: ArchitectureFileOpenTarget): void =>
    {
      if (!activeThreadRef) return
      const store = useRightPanelStore.getState()
      if (target.source.kind === 'standing-project-generation')
      {
        if (activeWorkspaceRoot === undefined) return
        store.openFile(activeThreadRef, target.relativePath, undefined, architectureParentSurfaceId)
        return
      }
      store.openArchitectureFile(
        activeThreadRef,
        target.source,
        target.relativePath,
        undefined,
        architectureParentSurfaceId,
      )
    },
    [activeThreadRef, activeWorkspaceRoot, architectureParentSurfaceId],
  )
  const openPlannedArchitecturePath = useCallback(
    (relativePath: string, line?: number): void =>
    {
      if (!activeThreadRef || activeWorkspaceRoot === undefined) return
      useRightPanelStore
        .getState()
        .openFile(activeThreadRef, relativePath, line, architectureParentSurfaceId)
    },
    [activeThreadRef, activeWorkspaceRoot, architectureParentSurfaceId],
  )
  const viewUpdatedRepositoryAtlas = useCallback(
    (target: Parameters<typeof createRepositoryAtlasSurface>[0]): void =>
    {
      if (!activeThreadRef) return
      useRightPanelStore
        .getState()
        .openArchitectureSurface(
          activeThreadRef,
          createRepositoryAtlasSurface(target),
          architectureParentSurfaceId,
        )
    },
    [activeThreadRef, architectureParentSurfaceId],
  )
  const viewArchitectureStandingAnchor = useCallback(
    (anchor: ArchitectureStandingAnchor): void =>
    {
      if (!activeThreadRef) return
      setRepositoryMapFocusRequest((current) => ({
        requestId: (current?.requestId ?? 0) + 1,
        anchor,
      }))
      useRightPanelStore
        .getState()
        .openArchitectureSurface(
          activeThreadRef,
          createRepositoryAtlasSurface(anchor.source),
          architectureParentSurfaceId,
        )
    },
    [activeThreadRef, architectureParentSurfaceId],
  )
  const addArchitectureConcernToComposer = useCallback(
    (
      projection: ArchitectureGraphProjection,
      selection: ArchitectureConcernGraphSelection,
    ): void =>
    {
      if (!activeThreadRef) return
      const context = createArchitectureConcernContext({
        environmentId: activeThreadRef.environmentId,
        threadId: activeThreadRef.threadId,
        projection,
        selection,
      })
      const result =
        context === null
          ? 'invalid'
          : addComposerDraftArchitectureContext(composerDraftTarget, context)
      if (result === 'added')
      {
        toastManager.add(
          stackedThreadToast({
            type: 'success',
            title: 'Architecture concern added',
            description: 'It stays local to this draft until you send the composer.',
          }),
        )
        return
      }
      if (result === 'duplicate')
      {
        toastManager.add(
          stackedThreadToast({
            type: 'info',
            title: 'Concern already in composer',
            description: 'The exact resource and selection are already attached.',
          }),
        )
        return
      }
      toastManager.add(
        stackedThreadToast({
          type: 'warning',
          title: result === 'limit' ? 'Architecture context limit reached' : 'Concern unavailable',
          description:
            result === 'limit'
              ? 'Remove an architecture concern before adding another.'
              : 'This selection could not produce a valid bounded draft context.',
        }),
      )
    },
    [activeThreadRef, addComposerDraftArchitectureContext, composerDraftTarget],
  )
  const persistThreadSettingsForNextTurn = useCallback(
    async (input: {
      threadId: ThreadId
      createdAt: string
      modelSelection?: ModelSelection
      branch?: string
      runtimeMode: RuntimeMode
      collaborationMode: CollaborationMode
    }): Promise<AtomCommandResult<void, unknown>> =>
    {
      if (!serverThread)
      {
        return AsyncResult.success(undefined)
      }

      let result: AtomCommandResult<void, unknown> = AsyncResult.success(undefined)
      const metadataUpdate = resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: serverThread.modelSelection,
        ...(input.modelSelection ? { nextModelSelection: input.modelSelection } : {}),
        currentBranch: serverThread.branch,
        ...(input.branch ? { nextBranch: input.branch } : {}),
      })
      if (metadataUpdate)
      {
        result = mapAtomCommandResult(
          await updateThreadMetadata({
            environmentId,
            input: {
              threadId: input.threadId,
              ...metadataUpdate,
            },
          }),
          () => undefined,
        )
        if (result._tag === 'Failure')
        {
          return result
        }
      }

      if (input.runtimeMode !== serverThread.runtimeMode)
      {
        result = mapAtomCommandResult(
          await setThreadRuntimeMode({
            environmentId,
            input: {
              threadId: input.threadId,
              runtimeMode: input.runtimeMode,
              createdAt: input.createdAt,
            },
          }),
          () => undefined,
        )
        if (result._tag === 'Failure')
        {
          return result
        }
      }

      const currentCollaborationMode = normalizeCollaborationMode(
        serverThread.interactionMode,
        serverThread.orchestrate,
      )
      if (
        input.collaborationMode.baseMode !== currentCollaborationMode.baseMode ||
        input.collaborationMode.orchestrate !== currentCollaborationMode.orchestrate
      )
      {
        const wireMode = toWireInteractionMode(input.collaborationMode)
        result = mapAtomCommandResult(
          await setThreadInteractionMode({
            environmentId,
            input: {
              threadId: input.threadId,
              interactionMode: wireMode.interactionMode,
              orchestrate: wireMode.orchestrate,
              createdAt: input.createdAt,
            },
          }),
          () => undefined,
        )
      }
      return result
    },
    [
      environmentId,
      serverThread,
      setThreadInteractionMode,
      setThreadRuntimeMode,
      updateThreadMetadata,
    ],
  )

  // debounce *showing* the scroll-to-bottom pill so it doesn't flash during
  // thread switches. LegendList fires scroll events with isAtEnd=false while
  // initialScrollAtEnd is settling; hiding is always immediate.
  const showScrollDebouncer = useRef(
    new Debouncer(() => setShowScrollToBottom(true), { wait: 150 }),
  )
  const timelineScrollModeRef = useRef<TimelineScrollMode>('following-end')
  const pendingTimelineAnchorRef = useRef<MessageId | null>(null)
  const positionedTimelineAnchorRef = useRef<MessageId | null>(null)
  const settledTimelineAnchorRef = useRef<MessageId | null>(null)
  const activeTimelineAnchorIndexRef = useRef<number | null>(null)
  const anchorUserScrollGenerationRef = useRef(0)
  const liveFollowUserScrollGenerationRef = useRef<number | null>(0)
  const pendingAnchorScrollRestoreRef = useRef<{
    readonly messageId: MessageId
    readonly offset: number
    readonly userScrollGeneration: number
  } | null>(null)
  const anchorScrollRestoreFrameRef = useRef<number | null>(null)
  const cancelTimelineLiveFollowForUserNavigation = useCallback(() =>
  {
    anchorUserScrollGenerationRef.current += 1
    timelineScrollModeRef.current = 'free-scrolling'
    liveFollowUserScrollGenerationRef.current = null
    pendingTimelineAnchorRef.current = null
    positionedTimelineAnchorRef.current = null
    settledTimelineAnchorRef.current = null
    activeTimelineAnchorIndexRef.current = null
    pendingAnchorScrollRestoreRef.current = null
    if (anchorScrollRestoreFrameRef.current !== null)
    {
      cancelAnimationFrame(anchorScrollRestoreFrameRef.current)
      anchorScrollRestoreFrameRef.current = null
    }
  }, [])
  const cancelTimelineLiveFollowForUserNavigationRef = useRef(
    cancelTimelineLiveFollowForUserNavigation,
  )
  useEffect(() =>
  {
    cancelTimelineLiveFollowForUserNavigationRef.current = cancelTimelineLiveFollowForUserNavigation
  }, [cancelTimelineLiveFollowForUserNavigation])
  const getActiveTimelineTurnMetrics = useCallback(
    (list?: LegendListRef | null) =>
    {
      const resolvedList = list ?? legendListRef.current
      const anchorIndex = activeTimelineAnchorIndexRef.current
      const state = resolvedList?.getState()
      if (!resolvedList || !state || anchorIndex === null)
      {
        return null
      }

      return getAnchoredTurnMetrics({
        state,
        anchorIndex,
        composerOverlayHeight,
        anchorOffset: CHAT_LIST_ANCHOR_OFFSET,
      })
    },
    [composerOverlayHeight],
  )
  const timelineRealContentOverflowsViewport = useCallback(
    (list?: LegendListRef | null) =>
    {
      const resolvedList = list ?? legendListRef.current
      const state = resolvedList?.getState()
      if (!resolvedList || !state || state.data.length === 0)
      {
        return false
      }

      const lastRowIndex = state.data.length - 1
      const lastRowTop = state.positionAtIndex(lastRowIndex)
      const lastRowHeight = state.sizeAtIndex(lastRowIndex)
      if (
        typeof lastRowTop !== 'number' ||
        typeof lastRowHeight !== 'number' ||
        !Number.isFinite(lastRowTop) ||
        !Number.isFinite(lastRowHeight)
      )
      {
        return false
      }

      const realContentBottom = lastRowTop + Math.max(1, lastRowHeight)
      const visibleScrollLength = Math.max(
        0,
        (state.scrollLength ?? 0) - composerOverlayHeight - CHAT_LIST_ANCHOR_OFFSET,
      )
      return realContentBottom > visibleScrollLength
    },
    [composerOverlayHeight],
  )

  // live-follow stays active after send/thread-open until an actual list scroll
  // gesture opts out.
  const scrollToEnd = useCallback((animated = false) =>
  {
    isAtEndRef.current = true
    timelineScrollModeRef.current = 'following-end'
    liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current
    pendingTimelineAnchorRef.current = null
    activeTimelineAnchorIndexRef.current = null
    setTimelineAnchor(releaseChatTimelineAnchor)
    showScrollDebouncer.current.cancel()
    setShowScrollToBottom(false)
    void legendListRef.current?.scrollToEnd?.({ animated })
  }, [])
  useEffect(() =>
  {
    let removeListeners: (() => void) | null = null
    const frame = requestAnimationFrame(() =>
    {
      const scrollNode = legendListRef.current?.getScrollableNode()
      if (!scrollNode)
      {
        return
      }
      const handleManualNavigation = () =>
      {
        cancelTimelineLiveFollowForUserNavigationRef.current()
      }
      scrollNode.addEventListener('wheel', handleManualNavigation, {
        passive: true,
      })
      scrollNode.addEventListener('touchmove', handleManualNavigation, {
        passive: true,
      })
      scrollNode.addEventListener('pointerdown', handleManualNavigation, {
        passive: true,
      })
      removeListeners = () =>
      {
        scrollNode.removeEventListener('wheel', handleManualNavigation)
        scrollNode.removeEventListener('touchmove', handleManualNavigation)
        scrollNode.removeEventListener('pointerdown', handleManualNavigation)
      }
    })

    return () =>
    {
      cancelAnimationFrame(frame)
      removeListeners?.()
    }
  }, [activeThread?.id])

  const onTimelineAnchorReady = useCallback((messageId: MessageId, anchorIndex: number) =>
  {
    if (pendingTimelineAnchorRef.current === messageId)
    {
      pendingTimelineAnchorRef.current = null
    }
    activeTimelineAnchorIndexRef.current = anchorIndex
    if (positionedTimelineAnchorRef.current === messageId)
    {
      return
    }
    positionedTimelineAnchorRef.current = messageId
    settledTimelineAnchorRef.current = null
    const positionAnchor = (remainingAttempts: number) =>
    {
      requestAnimationFrame(() =>
      {
        if (positionedTimelineAnchorRef.current !== messageId)
        {
          return
        }
        const list = legendListRef.current
        if (!list)
        {
          if (remainingAttempts > 0)
          {
            positionAnchor(remainingAttempts - 1)
          }
          return
        }
        const scrollNode = list.getScrollableNode()
        let finished = false
        const finishAnimatedPositioning = () =>
        {
          if (finished)
          {
            return
          }
          finished = true
          window.clearTimeout(fallbackTimer)
          scrollNode.removeEventListener('scrollend', finishAnimatedPositioning)
          if (positionedTimelineAnchorRef.current !== messageId)
          {
            return
          }
          const scrollOffset = list.getState().scroll
          void list.scrollToOffset({ offset: scrollOffset, animated: false })
          settledTimelineAnchorRef.current = messageId
        }
        const fallbackTimer = window.setTimeout(finishAnimatedPositioning, 750)
        scrollNode.addEventListener('scrollend', finishAnimatedPositioning, { once: true })
        void list.scrollToIndex({
          index: anchorIndex,
          animated: true,
          viewPosition: 0,
          viewOffset: CHAT_LIST_ANCHOR_OFFSET,
        })
      })
    }
    requestAnimationFrame(() => positionAnchor(12))
  }, [])
  const onTimelineAnchorSizeChanged = useCallback((messageId: MessageId) =>
  {
    if (settledTimelineAnchorRef.current !== messageId)
    {
      return
    }
    if (liveFollowUserScrollGenerationRef.current === anchorUserScrollGenerationRef.current)
    {
      return
    }
    const scrollOffset = legendListRef.current?.getState().scroll
    if (scrollOffset === undefined)
    {
      return
    }
    if (pendingAnchorScrollRestoreRef.current === null)
    {
      pendingAnchorScrollRestoreRef.current = {
        messageId,
        offset: scrollOffset,
        userScrollGeneration: anchorUserScrollGenerationRef.current,
      }
    }
    if (anchorScrollRestoreFrameRef.current !== null)
    {
      return
    }
    anchorScrollRestoreFrameRef.current = requestAnimationFrame(() =>
    {
      anchorScrollRestoreFrameRef.current = null
      const pending = pendingAnchorScrollRestoreRef.current
      pendingAnchorScrollRestoreRef.current = null
      if (
        pending &&
        settledTimelineAnchorRef.current === pending.messageId &&
        pending.userScrollGeneration === anchorUserScrollGenerationRef.current
      )
      {
        const list = legendListRef.current
        const currentScrollOffset = list?.getState().scroll
        if (
          typeof currentScrollOffset === 'number' &&
          Math.abs(currentScrollOffset - pending.offset) <= 2
        )
        {
          void list?.scrollToOffset({ offset: pending.offset, animated: false })
        }
      }
    })
  }, [])

  const onIsAtEndChange = useCallback((isAtEnd: boolean) =>
  {
    if (
      !isAtEnd &&
      liveFollowUserScrollGenerationRef.current === anchorUserScrollGenerationRef.current
    )
    {
      showScrollDebouncer.current.cancel()
      setShowScrollToBottom(false)
      return
    }
    if (isAtEndRef.current === isAtEnd) return
    isAtEndRef.current = isAtEnd
    if (isAtEnd)
    {
      timelineScrollModeRef.current = 'following-end'
      liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current
      // reachable only once manual navigation has already broken follow, so
      // the anchored turn framing is over: the user scrolled back to the live
      // edge and expects the stream to stick to it again, exactly like the
      // scroll-to-bottom pill.
      setTimelineAnchor(releaseChatTimelineAnchor)
      showScrollDebouncer.current.cancel()
      setShowScrollToBottom(false)
    }
    else
    {
      timelineScrollModeRef.current = 'free-scrolling'
      liveFollowUserScrollGenerationRef.current = null
      showScrollDebouncer.current.maybeExecute()
    }
  }, [])

  useEffect(() =>
  {
    if (!activeThread?.id)
    {
      return
    }
    if (liveFollowUserScrollGenerationRef.current !== anchorUserScrollGenerationRef.current)
    {
      return
    }

    let secondFrame: number | null = null
    const frame = requestAnimationFrame(() =>
    {
      secondFrame = requestAnimationFrame(() =>
      {
        if (liveFollowUserScrollGenerationRef.current !== anchorUserScrollGenerationRef.current)
        {
          return
        }
        if (pendingTimelineAnchorRef.current !== null)
        {
          return
        }
        if (
          positionedTimelineAnchorRef.current !== null &&
          settledTimelineAnchorRef.current !== positionedTimelineAnchorRef.current
        )
        {
          return
        }
        const list = legendListRef.current
        if (!list)
        {
          return
        }

        if (timelineScrollModeRef.current === 'anchoring-new-turn')
        {
          const metrics = getActiveTimelineTurnMetrics(list)
          if (!metrics)
          {
            return
          }
          if (metrics.scrollDeltaToRevealEnd <= 1)
          {
            return
          }

          const nextOffset = list.getState().scroll + metrics.scrollDeltaToRevealEnd
          void list.scrollToOffset({ offset: nextOffset, animated: false })
          return
        }

        if (timelineScrollModeRef.current !== 'following-end')
        {
          return
        }
        if (!timelineRealContentOverflowsViewport(list))
        {
          return
        }

        void list.scrollToEnd?.({ animated: false })
      })
    })

    return () =>
    {
      cancelAnimationFrame(frame)
      if (secondFrame !== null)
      {
        cancelAnimationFrame(secondFrame)
      }
    }
  }, [
    activeThread?.id,
    timelineEntries,
    getActiveTimelineTurnMetrics,
    timelineRealContentOverflowsViewport,
  ])

  useEffect(() =>
  {
    setPullRequestDialogState(null)
    isAtEndRef.current = true
    timelineScrollModeRef.current = 'following-end'
    liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current
    pendingTimelineAnchorRef.current = null
    positionedTimelineAnchorRef.current = null
    settledTimelineAnchorRef.current = null
    activeTimelineAnchorIndexRef.current = null
    showScrollDebouncer.current.cancel()
    setShowScrollToBottom(false)
    if (planSidebarOpenOnNextThreadRef.current)
    {
      planSidebarOpenOnNextThreadRef.current = false
      if (activeThreadRef)
      {
        useRightPanelStore.getState().open(activeThreadRef, 'plan')
      }
    }
    planSidebarDismissedForTurnRef.current = null
    // activeThreadRef resets transitively with the active thread.
  }, [activeThread?.id])

  // auto-open the plan sidebar when plan/todo steps arrive for the current turn.
  // don't auto-open for plans carried over from a previous turn (the user can open manually).
  useEffect(() =>
  {
    if (!autoOpenPlanSidebar) return
    if (!activePlan) return
    if (planSidebarOpen) return
    const latestTurnId = activeLatestTurn?.turnId ?? null
    if (latestTurnId && activePlan.turnId !== latestTurnId) return
    const turnKey = activePlan.turnId ?? sidebarProposedPlan?.turnId ?? '__dismissed__'
    if (planSidebarDismissedForTurnRef.current === turnKey) return
    if (activeThreadRef)
    {
      useRightPanelStore.getState().open(activeThreadRef, 'plan')
    }
  }, [
    activePlan,
    activeLatestTurn?.turnId,
    activeThreadRef,
    autoOpenPlanSidebar,
    planSidebarOpen,
    sidebarProposedPlan?.turnId,
  ])

  useEffect(() =>
  {
    setIsRevertingCheckpoint(false)
  }, [activeThread?.id])

  useEffect(() =>
  {
    if (!activeThread?.id || terminalUiState.terminalOpen) return
    const frame = window.requestAnimationFrame(() =>
    {
      focusComposer()
    })
    return () =>
    {
      window.cancelAnimationFrame(frame)
    }
  }, [activeThread?.id, focusComposer, terminalUiState.terminalOpen])

  useEffect(() =>
  {
    if (!activeThread?.id) return
    if (activeThread.messages.length === 0)
    {
      return
    }
    const serverIds = new Set(activeThread.messages.map((message) => message.id))
    const removedMessages = optimisticUserMessages.filter((message) => serverIds.has(message.id))
    if (removedMessages.length === 0)
    {
      return
    }
    const timer = window.setTimeout(() =>
    {
      setOptimisticUserMessages((existing) =>
        existing.filter((message) => !serverIds.has(message.id)),
      )
    }, 0)
    for (const removedMessage of removedMessages)
    {
      const previewUrls = collectUserMessageBlobPreviewUrls(removedMessage)
      if (previewUrls.length > 0)
      {
        handoffAttachmentPreviews(removedMessage.id, previewUrls)
        continue
      }
      revokeUserMessagePreviewUrls(removedMessage)
    }
    return () =>
    {
      window.clearTimeout(timer)
    }
  }, [activeThread?.id, activeThread?.messages, handoffAttachmentPreviews, optimisticUserMessages])

  useEffect(() =>
  {
    setOptimisticUserMessages((existing) =>
    {
      for (const message of existing)
      {
        revokeUserMessagePreviewUrls(message)
      }
      return []
    })
    resetLocalDispatch()
    setExpandedImage(null)
  }, [draftId, resetLocalDispatch, threadId])

  const closeExpandedImage = useCallback(() =>
  {
    setExpandedImage(null)
  }, [])

  const activeWorktreePath = activeThread?.worktreePath ?? null
  const derivedEnvMode: DraftThreadEnvMode = resolveEffectiveEnvMode({
    activeWorktreePath,
    hasServerThread: isServerThread,
    draftThreadEnvMode: isLocalDraftThread ? draftThread?.envMode : undefined,
  })
  const canOverrideServerThreadEnvMode = Boolean(
    isServerThread &&
    activeThread &&
    activeThread.messages.length === 0 &&
    activeThread.worktreePath === null &&
    !envLocked,
  )
  const envMode: DraftThreadEnvMode = canOverrideServerThreadEnvMode
    ? (pendingServerThreadEnvMode ?? draftThread?.envMode ?? derivedEnvMode)
    : derivedEnvMode
  const activeThreadBranch =
    canOverrideServerThreadEnvMode && pendingServerThreadBranch !== undefined
      ? pendingServerThreadBranch
      : (activeThread?.branch ?? null)
  const startFromOrigin = isLocalDraftThread
    ? (draftThread?.startFromOrigin ?? false)
    : canOverrideServerThreadEnvMode
      ? (pendingServerThreadStartFromOriginByThreadId[activeThread?.id ?? ''] ??
        primaryServerSettings.newWorktreesStartFromOrigin)
      : false
  const sendEnvMode = resolveSendEnvMode({
    requestedEnvMode: envMode,
    isGitRepo,
  })
  // currentGitBranch comes from gitStatusCwd, which follows the adopted run tree,
  // so the other two inputs have to describe that same tree. without folding the
  // run path in, an orchestrate thread with no worktree of its own reads 'local'
  // against the run's branch and gets a banner about a checkout it never made
  const localCheckoutBranchMismatch = useMemo(
    () =>
      isServerThread
        ? resolveLocalCheckoutBranchMismatch({
            effectiveEnvMode: effectiveRunWorktreePath === null ? envMode : 'worktree',
            activeWorktreePath: activeWorktreePath ?? effectiveRunWorktreePath,
            activeThreadBranch,
            currentGitBranch: gitStatusQuery.data?.refName ?? null,
          })
        : null,
    [
      activeThreadBranch,
      activeWorktreePath,
      effectiveRunWorktreePath,
      envMode,
      gitStatusQuery.data?.refName,
      isServerThread,
    ],
  )
  // settled state of the open thread, resolved exactly like the sidebar
  // partition (same shell, same capability gate, same PR auto-settle input)
  // so the banner and the sidebar row never disagree.
  const activeThreadShell = useThreadShell(isServerThread ? activeThreadRef : null)
  const autoSettleAfterDays = useClientSettings((settings) => settings.sidebarAutoSettleAfterDays)
  const autoSettleOnMerge = useClientSettings((settings) => settings.sidebarAutoSettleOnMerge)
  const activeThreadChangeRequestSnapshot =
    activeThreadKey === null ? undefined : changeRequestSnapshotByKey.get(activeThreadKey)
  const retainActiveTerminalPr = canRetainTerminalThreadPr({
    worktreePath: activeThread?.worktreePath ?? null,
    orchestrateRunWorktreePath: activeRunWorktreePath,
    orchestrateRunWorktreeIsNotRepository: runWorktreeIsNotRepository,
  })
  const activeThreadPr = resolveDisplayedThreadPr({
    threadBranch: activeThread?.branch ?? null,
    gitStatus: gitStatusQuery.data ?? null,
    snapshot: activeThreadChangeRequestSnapshot,
    retainTerminalOnBranchMismatch: retainActiveTerminalPr,
  })
  useEffect(() =>
  {
    if (activeThreadKey === null) return
    const nextSnapshot = nextThreadChangeRequestSnapshot({
      threadBranch: activeThread?.branch ?? null,
      gitStatus: gitStatusQuery.data ?? null,
      snapshot: activeThreadChangeRequestSnapshot,
      retainTerminalOnBranchMismatch: retainActiveTerminalPr,
    })
    if (nextSnapshot === undefined) return
    setThreadChangeRequestSnapshot(activeThreadKey, nextSnapshot)
  }, [
    activeThread?.branch,
    activeThreadChangeRequestSnapshot,
    activeThreadKey,
    gitStatusQuery.data,
    retainActiveTerminalPr,
  ])
  const supportsSettlement = serverConfig?.environment.capabilities.threadSettlement === true
  const supportsSnooze = serverConfig?.environment.capabilities.threadSnooze === true
  const nowMinute = useNowMinute()
  const activeThreadSnoozed =
    activeThreadShell !== null &&
    supportsSnooze &&
    effectiveSnoozed(activeThreadShell, { now: new Date().toISOString() })
  const [snoozeWakeTick, bumpSnoozeWakeTick] = useState(0)
  useEffect(() =>
  {
    void snoozeWakeTick
    if (!activeThreadSnoozed) return
    const wakeAtMs = Date.parse(activeThreadShell?.snoozedUntil ?? '')
    if (!Number.isFinite(wakeAtMs)) return
    const id = window.setTimeout(
      () => bumpSnoozeWakeTick((tick) => tick + 1),
      Math.min(Math.max(0, wakeAtMs - Date.now()) + 50, 2_147_483_647),
    )
    return () => window.clearTimeout(id)
  }, [activeThreadShell?.snoozedUntil, activeThreadSnoozed, snoozeWakeTick])
  const activeThreadSettled = useMemo(() =>
  {
    if (activeThreadShell === null || !supportsSettlement) return false
    const changeRequest =
      activeThreadPr === null
        ? null
        : { state: activeThreadPr.state, updatedAt: activeThreadPr.updatedAt }
    return effectiveSettled(activeThreadShell, {
      now: `${nowMinute}:00.000Z`,
      autoSettleAfterDays,
      autoSettleOnMerge,
      changeRequest,
    })
  }, [
    activeThreadPr?.state,
    activeThreadPr?.updatedAt,
    activeThreadShell,
    autoSettleAfterDays,
    autoSettleOnMerge,
    nowMinute,
    supportsSettlement,
  ])
  const unsettleThreadMutation = useAtomCommand(threadEnvironment.unsettle, {
    reportFailure: false,
  })
  // keyed by thread, not a boolean: the pending state must follow the thread
  // it belongs to across navigation, and a request resolving for thread A
  // must never clear (or re-enable) thread B's button.
  const [unsettlingThreadKey, setUnsettlingThreadKey] = useState<string | null>(null)
  const isUnsettling = unsettlingThreadKey !== null && unsettlingThreadKey === activeThreadKey
  const handleUnsettleActiveThread = useCallback(async () =>
  {
    if (!activeThreadRef) return
    const threadKey = scopedThreadKey(activeThreadRef)
    setUnsettlingThreadKey(threadKey)
    try
    {
      const result = await unsettleThreadMutation({
        environmentId: activeThreadRef.environmentId,
        input: { threadId: activeThreadRef.threadId, reason: 'user' },
      })
      if (result._tag === 'Failure' && !isAtomCommandInterrupted(result))
      {
        const error = squashAtomCommandFailure(result)
        toastManager.add(
          stackedThreadToast({
            type: 'error',
            title: 'Failed to un-settle thread',
            description: error instanceof Error ? error.message : 'An error occurred.',
          }),
        )
      }
    }
    finally
    {
      setUnsettlingThreadKey((current) => (current === threadKey ? null : current))
    }
  }, [activeThreadRef, unsettleThreadMutation])
  const unsnoozeThreadMutation = useAtomCommand(threadEnvironment.unsnooze, {
    reportFailure: false,
  })
  const [unsnoozingThreadKey, setUnsnoozingThreadKey] = useState<string | null>(null)
  const isUnsnoozing = unsnoozingThreadKey !== null && unsnoozingThreadKey === activeThreadKey
  const handleUnsnoozeActiveThread = useCallback(async () =>
  {
    if (!activeThreadRef) return
    const threadKey = scopedThreadKey(activeThreadRef)
    setUnsnoozingThreadKey(threadKey)
    try
    {
      const result = await unsnoozeThreadMutation({
        environmentId: activeThreadRef.environmentId,
        input: { threadId: activeThreadRef.threadId, reason: 'user' },
      })
      if (result._tag === 'Failure' && !isAtomCommandInterrupted(result))
      {
        const error = squashAtomCommandFailure(result)
        toastManager.add(
          stackedThreadToast({
            type: 'error',
            title: 'Failed to wake thread',
            description: error instanceof Error ? error.message : 'An error occurred.',
          }),
        )
      }
    }
    finally
    {
      setUnsnoozingThreadKey((current) => (current === threadKey ? null : current))
    }
  }, [activeThreadRef, unsnoozeThreadMutation])
  const [isRestoringThreadBranch, setIsRestoringThreadBranch] = useState(false)
  const [branchRestoreConfirmOpen, setBranchRestoreConfirmOpen] = useState(false)
  // once revealed for a given mismatch, the banner stays mounted until the
  // mismatch changes or resolves, so clearing the draft doesn't flicker it.
  const [revealedBranchMismatchKey, setRevealedBranchMismatchKey] = useState<string | null>(null)
  // dismissal lives in a module-level set (survives remounts); this tick just
  // forces a re-render so the banner leaves immediately.
  const [, setBranchMismatchDismissTick] = useState(0)
  const composerHasDraftContent = useComposerDraftStore((store) =>
  {
    const draft = store.getComposerDraft(composerDraftTarget)
    return Boolean(
      draft &&
      (draft.prompt.trim().length > 0 ||
        draft.images.length > 0 ||
        draft.terminalContexts.length > 0 ||
        draft.elementContexts.length > 0 ||
        draft.previewAnnotations.length > 0 ||
        draft.architectureContexts.length > 0 ||
        draft.reviewComments.length > 0),
    )
  })
  const activeBranchMismatchKey = branchMismatchKey(
    activeThread?.id ?? null,
    localCheckoutBranchMismatch,
  )
  const showBranchMismatchBanner = shouldShowBranchMismatchBanner({
    hasMismatch: localCheckoutBranchMismatch !== null,
    isDismissed: isBranchMismatchDismissedForSession(activeBranchMismatchKey),
    composerHasContent: composerHasDraftContent,
    wasShownForCurrentMismatch:
      revealedBranchMismatchKey !== null && revealedBranchMismatchKey === activeBranchMismatchKey,
  })
  useEffect(() =>
  {
    setRevealedBranchMismatchKey((revealed) =>
    {
      if (showBranchMismatchBanner)
      {
        return activeBranchMismatchKey
      }
      // hysteresis is scoped to an uninterrupted mismatch: reset when the
      // mismatch resolves or changes so a recurrence re-gates on intent.
      return revealed !== null && revealed !== activeBranchMismatchKey ? null : revealed
    })
  }, [activeBranchMismatchKey, showBranchMismatchBanner])
  const handleSwitchCheckoutToThread = useCallback(async () =>
  {
    if (
      !activeProjectCwd ||
      !activeThread ||
      !localCheckoutBranchMismatch ||
      isRestoringThreadBranch
    )
    {
      return
    }
    setIsRestoringThreadBranch(true)
    const checkoutResult = await switchGitRef({
      environmentId,
      input: {
        cwd: activeProjectCwd,
        refName: localCheckoutBranchMismatch.threadBranch,
      },
    })
    if (checkoutResult._tag === 'Failure')
    {
      setIsRestoringThreadBranch(false)
      if (!isAtomCommandInterrupted(checkoutResult))
      {
        toastManager.add(
          stackedThreadToast({
            type: 'error',
            title: 'Failed to switch checkout',
            description: chatActionErrorMessage(squashAtomCommandFailure(checkoutResult)),
          }),
        )
      }
      return
    }

    const nextBranch = checkoutResult.value.refName ?? localCheckoutBranchMismatch.threadBranch
    if (nextBranch !== activeThread.branch)
    {
      const updateResult = await updateThreadMetadata({
        environmentId,
        input: { threadId: activeThread.id, branch: nextBranch, worktreePath: null },
      })
      if (updateResult._tag === 'Failure')
      {
        setIsRestoringThreadBranch(false)
        if (!isAtomCommandInterrupted(updateResult))
        {
          toastManager.add(
            stackedThreadToast({
              type: 'error',
              title: 'Checkout switched, but the thread could not be updated',
              description: chatActionErrorMessage(squashAtomCommandFailure(updateResult)),
            }),
          )
        }
        gitStatusQuery.refresh()
        return
      }
    }
    gitStatusQuery.refresh()
    setIsRestoringThreadBranch(false)
    scheduleComposerFocus()
  }, [
    activeProjectCwd,
    activeThread,
    environmentId,
    gitStatusQuery,
    isRestoringThreadBranch,
    localCheckoutBranchMismatch,
    scheduleComposerFocus,
    switchGitRef,
    updateThreadMetadata,
  ])
  // the stack renders items[0] front-most and tucks the rest behind hover, so
  // ordering is priority: a blocking import decision stays focusable at the
  // front, followed by system banners, branch mismatch, and parked state.
  const parkedThreadBannerItem = useMemo<ComposerBannerStackItem | null>(() =>
  {
    if (!activeThreadSnoozed && !activeThreadSettled)
    {
      return null
    }
    const isSnoozed = activeThreadSnoozed
    return {
      id: `thread-${isSnoozed ? 'snoozed' : 'settled'}:${activeThread?.id ?? 'unknown'}`,
      variant: 'info',
      icon: isSnoozed ? <AlarmClockIcon /> : <CheckCircle2Icon />,
      title: `This thread is ${isSnoozed ? 'snoozed' : 'settled'}`,
      description: isSnoozed
        ? 'Sending a message wakes it and moves it back to Active in the sidebar.'
        : 'Sending a message moves it back to Active in the sidebar.',
      actions: (
        <Button
          size="xs"
          variant="outline"
          disabled={isSnoozed ? isUnsnoozing : isUnsettling}
          onClick={() =>
            void (isSnoozed ? handleUnsnoozeActiveThread() : handleUnsettleActiveThread())
          }
        >
          {isSnoozed
            ? isUnsnoozing
              ? 'Waking...'
              : 'Wake now'
            : isUnsettling
              ? 'Un-settling...'
              : 'Un-settle'}
        </Button>
      ),
    }
  }, [
    activeThread?.id,
    activeThreadSettled,
    activeThreadSnoozed,
    handleUnsnoozeActiveThread,
    handleUnsettleActiveThread,
    isUnsnoozing,
    isUnsettling,
  ])
  // a started thread stays bound to the instance that owns its session. When
  // that instance is disabled or removed the composer silently falls back to
  // another instance and the send fails inside the provider layer, so name the
  // binding and point at the switch flow before the user hits that.
  const unavailableBoundProviderBannerItem = useMemo<ComposerBannerStackItem | null>(() =>
  {
    // an empty snapshot list means the server config has not arrived yet, not
    // that every instance vanished.
    if (!activeThread || !threadHasStarted(activeThread) || providerStatuses.length === 0)
    {
      return null
    }
    const boundInstanceId =
      activeThread.session?.providerInstanceId ?? activeThread.modelSelection.instanceId
    const snapshot =
      providerStatuses.find((status) => status.instanceId === boundInstanceId) ?? null
    const entry = snapshot ? (deriveProviderInstanceEntries([snapshot])[0] ?? null) : null
    if (entry && entry.enabled && entry.isAvailable)
    {
      return null
    }
    const instanceName = entry?.displayName ?? boundInstanceId
    const reason = entry
      ? entry.enabled
        ? (snapshot?.unavailableReason ?? `${instanceName} is no longer available on this server.`)
        : `${instanceName} is disabled in provider settings.`
      : `${instanceName} is no longer configured on this server.`
    return {
      id: `bound-provider-unavailable:${activeThread.id}:${boundInstanceId}`,
      variant: 'error',
      icon: <TriangleAlertIcon />,
      title: `This thread is bound to ${instanceName}`,
      description: `${reason} Sending will fail until this thread switches to another provider.`,
      actions: (
        <Button size="xs" variant="outline" onClick={() => composerRef.current?.openModelPicker()}>
          Switch provider
        </Button>
      ),
    }
  }, [activeThread, composerRef, providerStatuses])
  const importConsentBannerItem = useMemo<ComposerBannerStackItem | null>(() =>
  {
    if (
      importContinuationGate.state === 'not-required' ||
      (importConsentGiven && importContinuationGate.providerState === 'ready')
    )
    {
      return null
    }

    const sourceName = activeThread?.origin
      ? importSourceDisplayName(activeThread.origin.source)
      : 'an external provider'
    const bannerCopy = resolveImportContinuationBannerCopy({
      gate: importContinuationGate,
      providerDisplayName: importProviderDisplayName,
      sourceName,
    })

    return {
      id: `import-consent:${routeThreadKey}`,
      variant: bannerCopy.isReady ? 'info' : 'warning',
      icon: <ImportIcon />,
      title: bannerCopy.title,
      description: bannerCopy.description,
      actions:
        bannerCopy.action === 'consent' && currentImportConsentToken !== null ? (
          <Button
            size="xs"
            variant="outline"
            data-import-continuation-action="true"
            onClick={() =>
              {
              setAcceptedImportConsentToken(currentImportConsentToken)
              scheduleComposerFocus()
            }}
          >
            {bannerCopy.actionLabel}
          </Button>
        ) : bannerCopy.action === 'import-settings' ? (
          <Button
            render={<Link to="/settings/import" data-import-continuation-action="true" />}
            size="xs"
            variant="outline"
          >
            {bannerCopy.actionLabel}
          </Button>
        ) : (
          <Button
            render={<Link to="/settings/providers" data-import-continuation-action="true" />}
            size="xs"
            variant="outline"
          >
            {bannerCopy.actionLabel}
          </Button>
        ),
    }
  }, [
    activeThread?.origin,
    currentImportConsentToken,
    importConsentGiven,
    importContinuationGate,
    importProviderDisplayName,
    routeThreadKey,
    scheduleComposerFocus,
  ])
  const handleRestoreThreadBranch = useCallback(() =>
  {
    if (gitStatusQuery.data?.hasWorkingTreeChanges)
    {
      setBranchRestoreConfirmOpen(true)
      return
    }
    void handleSwitchCheckoutToThread()
  }, [gitStatusQuery.data?.hasWorkingTreeChanges, handleSwitchCheckoutToThread])
  const composerBannerItems = useMemo<ComposerBannerStackItem[]>(() =>
  {
    const importConsentItems = importConsentBannerItem === null ? [] : [importConsentBannerItem]
    const boundProviderItems =
      unavailableBoundProviderBannerItem === null ? [] : [unavailableBoundProviderBannerItem]
    const parkedThreadItems = parkedThreadBannerItem === null ? [] : [parkedThreadBannerItem]
    if (!localCheckoutBranchMismatch || !showBranchMismatchBanner || !activeBranchMismatchKey)
    {
      return [
        ...importConsentItems,
        ...boundProviderItems,
        ...systemComposerBannerItems,
        ...parkedThreadItems,
      ]
    }
    return [
      ...importConsentItems,
      ...boundProviderItems,
      ...systemComposerBannerItems,
      {
        id: `branch-mismatch:${activeBranchMismatchKey}`,
        variant: 'info',
        icon: <GitBranchIcon />,
        title: (
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="shrink-0 font-normal text-muted-foreground">Branch changed — was</span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <code className="min-w-0 truncate font-medium text-foreground">
                    {localCheckoutBranchMismatch.threadBranch}
                  </code>
                }
              />
              <TooltipPopup side="top" className="max-w-80">
                This thread last ran on {localCheckoutBranchMismatch.threadBranch}. Sending will
                continue on {localCheckoutBranchMismatch.currentBranch}.
              </TooltipPopup>
            </Tooltip>
          </span>
        ),
        className: 'dark:shadow-none',
        actions: (
          <Button
            size="xs"
            variant="ghost"
            disabled={isRestoringThreadBranch}
            onClick={handleRestoreThreadBranch}
          >
            {isRestoringThreadBranch ? 'Restoring...' : 'Restore branch'}
          </Button>
        ),
        dismissLabel: 'Dismiss branch change notice',
        onDismiss: () =>
        {
          dismissBranchMismatchForSession(activeBranchMismatchKey)
          setBranchMismatchDismissTick((tick) => tick + 1)
        },
      },
      ...parkedThreadItems,
    ]
  }, [
    activeBranchMismatchKey,
    handleRestoreThreadBranch,
    importConsentBannerItem,
    isRestoringThreadBranch,
    localCheckoutBranchMismatch,
    parkedThreadBannerItem,
    showBranchMismatchBanner,
    systemComposerBannerItems,
    unavailableBoundProviderBannerItem,
  ])

  useEffect(() =>
  {
    setPendingServerThreadEnvMode(null)
    setPendingServerThreadBranch(undefined)
  }, [activeThread?.id])

  useEffect(() =>
  {
    if (canOverrideServerThreadEnvMode)
    {
      return
    }
    setPendingServerThreadEnvMode(null)
    setPendingServerThreadBranch(undefined)
  }, [canOverrideServerThreadEnvMode])

  useEffect(() =>
  {
    if (!activeThreadId)
    {
      setTerminalUiLaunchContext(null)
      return
    }
    setTerminalUiLaunchContext((current) =>
    {
      if (!current) return current
      if (current.threadId === activeThreadId) return current
      return null
    })
  }, [activeThreadId])

  useEffect(() =>
  {
    if (!activeThreadId || !activeProjectCwd)
    {
      return
    }
    setTerminalUiLaunchContext((current) =>
    {
      if (!current || current.threadId !== activeThreadId)
      {
        return current
      }
      const settledCwd = projectScriptCwd({
        project: { cwd: activeProjectCwd },
        worktreePath: activeThreadWorktreePath,
      })
      if (
        settledCwd === current.cwd &&
        (activeThreadWorktreePath ?? null) === current.worktreePath
      )
      {
        return null
      }
      return current
    })
  }, [activeProjectCwd, activeThreadId, activeThreadWorktreePath])

  useEffect(() =>
  {
    if (terminalUiState.terminalOpen)
    {
      return
    }
    setTerminalUiLaunchContext((current) => (current?.threadId === activeThreadId ? null : current))
  }, [activeThreadId, terminalUiState.terminalOpen])

  useEffect(() =>
  {
    if (!activeThreadKey) return
    const previous = terminalUiOpenByThreadRef.current[activeThreadKey] ?? false
    const current = Boolean(terminalUiState.terminalOpen)

    if (!previous && current)
    {
      terminalUiOpenByThreadRef.current[activeThreadKey] = current
      setTerminalFocusRequestId((value) => value + 1)
      return
    }
    else if (previous && !current)
    {
      terminalUiOpenByThreadRef.current[activeThreadKey] = current
      const frame = window.requestAnimationFrame(() =>
      {
        focusComposer()
      })
      return () =>
      {
        window.cancelAnimationFrame(frame)
      }
    }

    terminalUiOpenByThreadRef.current[activeThreadKey] = current
  }, [activeThreadKey, focusComposer, terminalUiState.terminalOpen])

  useEffect(() =>
  {
    const handler = (event: globalThis.KeyboardEvent) =>
    {
      if (!activeThreadId || isCommandPaletteOpen())
      {
        return
      }
      const terminalFocusOwner = getTerminalFocusOwner()
      if (event.defaultPrevented && terminalFocusOwner === null)
      {
        return
      }
      const shortcutContext = {
        terminalFocus: terminalFocusOwner !== null,
        terminalOpen: Boolean(terminalUiState.terminalOpen),
        modelPickerOpen: composerRef.current?.isModelPickerOpen() ?? false,
      }

      if (
        !shortcutContext.terminalFocus &&
        !shortcutContext.modelPickerOpen &&
        shouldTypeToFocusComposer(event)
      )
      {
        if (composerRef.current?.insertTextAtEnd(event.key))
        {
          event.preventDefault()
          event.stopPropagation()
          return
        }
      }

      const command = resolveShortcutCommand(event, keybindings, {
        context: shortcutContext,
      })
      if (!command) return

      if (command === 'terminal.toggle')
      {
        event.preventDefault()
        event.stopPropagation()
        toggleTerminalVisibility()
        return
      }

      if (command === 'rightPanel.toggle')
      {
        event.preventDefault()
        event.stopPropagation()
        toggleRightPanel()
        return
      }

      if (command === 'rightPanel.toggleMaximized')
      {
        event.preventDefault()
        event.stopPropagation()
        toggleRightPanelMaximized()
        return
      }

      if (command === 'terminal.split')
      {
        event.preventDefault()
        event.stopPropagation()
        if (terminalFocusOwner === 'right-panel')
        {
          splitPanelTerminal()
          return
        }
        if (!terminalUiState.terminalOpen)
        {
          setTerminalOpen(true)
        }
        splitTerminal()
        return
      }

      if (command === 'terminal.splitVertical')
      {
        event.preventDefault()
        event.stopPropagation()
        if (terminalFocusOwner === 'right-panel')
        {
          splitPanelTerminal('vertical')
          return
        }
        if (!terminalUiState.terminalOpen)
        {
          setTerminalOpen(true)
        }
        splitTerminal('vertical')
        return
      }

      if (command === 'terminal.close')
      {
        event.preventDefault()
        event.stopPropagation()
        if (isTerminalCloseConfirmPending()) return
        if (terminalFocusOwner === 'right-panel' && activeRightPanelSurface?.kind === 'terminal')
        {
          requestClosePanelTerminal(activeRightPanelSurface.activeTerminalId)
          return
        }
        if (!terminalUiState.terminalOpen) return
        requestCloseTerminal(terminalUiState.activeTerminalId)
        return
      }

      if (command === 'terminal.new')
      {
        event.preventDefault()
        event.stopPropagation()
        if (terminalFocusOwner === 'right-panel')
        {
          addTerminalSurface()
          return
        }
        if (!terminalUiState.terminalOpen)
        {
          setTerminalOpen(true)
        }
        createNewTerminal()
        return
      }

      if (command === 'diff.toggle')
      {
        event.preventDefault()
        event.stopPropagation()
        onToggleDiff()
        return
      }

      if (command === 'modelPicker.toggle')
      {
        event.preventDefault()
        event.stopPropagation()
        composerRef.current?.toggleModelPicker()
        return
      }

      const scriptId = projectScriptIdFromCommand(command)
      if (!scriptId || !activeProject) return
      const script = activeProject.scripts.find((entry) => entry.id === scriptId)
      if (!script) return
      event.preventDefault()
      event.stopPropagation()
      void runProjectScript(script)
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [
    activeProject,
    activeRightPanelSurface,
    addTerminalSurface,
    terminalUiState.terminalOpen,
    terminalUiState.activeTerminalId,
    activeThreadId,
    requestCloseTerminal,
    requestClosePanelTerminal,
    createNewTerminal,
    setTerminalOpen,
    runProjectScript,
    splitTerminal,
    splitPanelTerminal,
    keybindings,
    onToggleDiff,
    toggleRightPanel,
    toggleRightPanelMaximized,
    toggleTerminalVisibility,
    composerRef,
  ])

  const onRevertToTurnCount = useCallback(
    async (turnCount: number) =>
    {
      const localApi = readLocalApi()
      if (!localApi || !activeThread || isRevertingCheckpoint) return

      if (activeEnvironmentUnavailable && activeEnvironmentUnavailableLabel)
      {
        setThreadError(
          activeThread.id,
          `Reconnect ${activeEnvironmentUnavailableLabel} before reverting checkpoints.`,
        )
        return
      }
      if (phase === 'running' || isSendBusy || isConnecting)
      {
        setThreadError(activeThread.id, 'Interrupt the current turn before reverting checkpoints.')
        return
      }
      const confirmed = await localApi.dialogs.confirm(
        [
          `Revert this thread to checkpoint ${turnCount}?`,
          'This will discard newer messages and turn diffs in this thread.',
          'This action cannot be undone.',
        ].join('\n'),
      )
      if (!confirmed)
      {
        return
      }

      setIsRevertingCheckpoint(true)
      setThreadError(activeThread.id, null)
      const result = await revertThreadCheckpoint({
        environmentId,
        input: {
          threadId: activeThread.id,
          turnCount,
        },
      })
      if (result._tag === 'Failure' && !isAtomCommandInterrupted(result))
      {
        const error = squashAtomCommandFailure(result)
        setThreadError(
          activeThread.id,
          error instanceof Error ? error.message : 'Failed to revert thread state.',
        )
      }
      setIsRevertingCheckpoint(false)
    },
    [
      activeThread,
      activeEnvironmentUnavailable,
      activeEnvironmentUnavailableLabel,
      environmentId,
      isConnecting,
      isRevertingCheckpoint,
      isSendBusy,
      phase,
      revertThreadCheckpoint,
      setThreadError,
    ],
  )

  // the full catalog, same as the composer picker -> the user picks models;
  // mapping a model to a launchable harness is the orchestrator's job
  const orchestrateInstanceEntries = providerInstanceEntries

  const orchestrateModelOptions = useMemo(() =>
  {
    const options = new Map<ProviderInstanceId, ReadonlyArray<AppModelOption>>()
    for (const entry of orchestrateInstanceEntries)
    {
      options.set(entry.instanceId, getAppModelOptionsForInstance(settings, entry))
    }
    return options
  }, [orchestrateInstanceEntries, settings])

  const onEditOrchestratePlanInChat = useCallback(
    (reply: string) =>
    {
      // append instead of overwriting whatever the user already typed
      const currentDraft = promptRef.current
      const nextDraft =
        currentDraft.length === 0
          ? reply
          : currentDraft.endsWith('\n')
            ? `${currentDraft}${reply}`
            : `${currentDraft}\n${reply}`
      promptRef.current = nextDraft
      setComposerDraftPrompt(composerDraftTarget, nextDraft)
      composerRef.current?.resetCursorState({
        cursor: nextDraft.length,
        prompt: nextDraft,
        detectTrigger: true,
      })
      scheduleComposerFocus()
    },
    [composerDraftTarget, composerRef, scheduleComposerFocus, setComposerDraftPrompt],
  )

  const onRespondOrchestratePlan = useCallback(
    async (response: OrchestratePlanResponse): Promise<boolean> =>
    {
      if (activeThreadId === null) return false
      const result = await dispatchOrchestratePlanResponse({
        environmentId,
        input: {
          threadId: activeThreadId,
          ...response,
        },
      })
      if (result._tag === 'Failure' && !isAtomCommandInterrupted(result))
      {
        const error = squashAtomCommandFailure(result)
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : 'Failed to submit orchestrate plan response.',
        )
        return false
      }
      return result._tag === 'Success'
    },
    [activeThreadId, dispatchOrchestratePlanResponse, environmentId, setThreadError],
  )

  // the workers panel is the run surface; the card pins it to its own run
  const onOpenOrchestrateRun = useCallback(
    (runId: string) =>
    {
      if (!activeThreadRef) return
      openWorkersPanel(activeThreadRef, runId)
    },
    [activeThreadRef],
  )

  const onSaveWorkerVerdict = useCallback(
    (runId: string, jobId: string, verdict: string) =>
    {
      if (!isServerThread || activeThreadId === null)
      {
        return
      }
      void setThreadWorkerVerdict({
        environmentId,
        input: {
          threadId: activeThreadId,
          runId,
          jobId,
          verdict,
        },
      })
    },
    [activeThreadId, environmentId, isServerThread, setThreadWorkerVerdict],
  )

  const onRespondToApproval = useCallback(
    async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) =>
    {
      if (!activeThreadId) return
      const approval = pendingApprovals.find((candidate) => candidate.requestId === requestId)
      if (
        respondingRequestIds.includes(requestId) ||
        approval?.status === 'responding' ||
        approval?.status === 'unknown'
      )
      {
        return
      }

      setRespondingRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      )
      const result = await respondToThreadApproval({
        environmentId,
        input: {
          threadId: activeThreadId,
          requestId,
          decision,
        },
      })
      if (result._tag === 'Failure' && !isAtomCommandInterrupted(result))
      {
        const error = squashAtomCommandFailure(result)
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : 'Failed to submit approval decision.',
        )
      }
      setRespondingRequestIds((existing) => existing.filter((id) => id !== requestId))
      return result
    },
    [
      activeThreadId,
      environmentId,
      pendingApprovals,
      respondToThreadApproval,
      respondingRequestIds,
      setThreadError,
    ],
  )

  const onRespondToUserInput = useCallback(
    async (requestId: ApprovalRequestId, answers: Record<string, unknown>) =>
    {
      if (!activeThreadId) return

      setRespondingUserInputRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      )
      const result = await respondToThreadUserInput({
        environmentId,
        input: {
          threadId: activeThreadId,
          requestId,
          answers,
        },
      })
      if (result._tag === 'Failure' && !isAtomCommandInterrupted(result))
      {
        const error = squashAtomCommandFailure(result)
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : 'Failed to submit user input.',
        )
      }
      setRespondingUserInputRequestIds((existing) => existing.filter((id) => id !== requestId))
      return result
    },
    [activeThreadId, environmentId, respondToThreadUserInput, setThreadError],
  )

  const setActivePendingUserInputQuestionIndex = useCallback(
    (nextQuestionIndex: number) =>
    {
      if (!activePendingUserInput)
      {
        return
      }
      setPendingUserInputQuestionIndexByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: nextQuestionIndex,
      }))
    },
    [activePendingUserInput],
  )

  const onSelectActivePendingUserInputOption = useCallback(
    (questionId: string, optionLabel: string) =>
    {
      if (!activePendingUserInput)
      {
        return
      }
      setPendingUserInputAnswersByRequestId((existing) =>
      {
        const question =
          (activePendingProgress?.activeQuestion?.id === questionId
            ? activePendingProgress.activeQuestion
            : undefined) ??
          activePendingUserInput.questions.find((entry) => entry.id === questionId)
        if (!question)
        {
          return existing
        }

        return {
          ...existing,
          [activePendingUserInput.requestId]: {
            ...existing[activePendingUserInput.requestId],
            [questionId]: togglePendingUserInputOptionSelection(
              question,
              existing[activePendingUserInput.requestId]?.[questionId],
              optionLabel,
            ),
          },
        }
      })
      promptRef.current = ''
      composerRef.current?.resetCursorState({ cursor: 0 })
    },
    [activePendingProgress?.activeQuestion, activePendingUserInput, composerRef],
  )

  const onChangeActivePendingUserInputCustomAnswer = useCallback(
    (
      questionId: string,
      value: string,
      nextCursor: number,
      expandedCursor: number,
      _cursorAdjacentToMention: boolean,
    ) =>
    {
      if (!activePendingUserInput)
      {
        return
      }
      promptRef.current = value
      setPendingUserInputAnswersByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: {
          ...existing[activePendingUserInput.requestId],
          [questionId]: setPendingUserInputCustomAnswer(
            existing[activePendingUserInput.requestId]?.[questionId],
            value,
          ),
        },
      }))
      const snapshot = composerRef.current?.readSnapshot()
      if (
        snapshot?.value !== value ||
        snapshot.cursor !== nextCursor ||
        snapshot.expandedCursor !== expandedCursor
      )
      {
        composerRef.current?.focusAt(nextCursor)
      }
    },
    [activePendingUserInput, composerRef],
  )

  const onAdvanceActivePendingUserInput = useCallback(() =>
  {
    if (!activePendingUserInput || !activePendingProgress)
    {
      return
    }
    if (activePendingProgress.isLastQuestion)
    {
      if (activePendingResolvedAnswers)
      {
        void onRespondToUserInput(activePendingUserInput.requestId, activePendingResolvedAnswers)
      }
      return
    }
    setActivePendingUserInputQuestionIndex(activePendingProgress.questionIndex + 1)
  }, [
    activePendingProgress,
    activePendingResolvedAnswers,
    activePendingUserInput,
    onRespondToUserInput,
    setActivePendingUserInputQuestionIndex,
  ])

  const onPreviousActivePendingUserInputQuestion = useCallback(() =>
  {
    if (!activePendingProgress)
    {
      return
    }
    setActivePendingUserInputQuestionIndex(Math.max(activePendingProgress.questionIndex - 1, 0))
  }, [activePendingProgress, setActivePendingUserInputQuestionIndex])

  const onSubmitPlanFollowUp = useCallback(
    async ({
      text,
      collaborationMode: nextCollaborationMode,
    }: {
      text: string
      collaborationMode: CollaborationMode
    }): Promise<boolean> =>
    {
      if (
        !activeThread ||
        !isServerThread ||
        isSendBusy ||
        isConnecting ||
        sendInFlightRef.current
      )
      {
        return false
      }
      if (
        handleImportContinuationSendBlock(
          importContinuationSendBlocked,
          focusImportContinuationBanner,
        )
      )
      {
        return false
      }

      const trimmed = text.trim()
      if (!trimmed)
      {
        return false
      }
      const wireMode = toWireInteractionMode(nextCollaborationMode)

      const sendCtx = composerRef.current?.getSendContext()
      if (!sendCtx?.providerAvailable)
      {
        return false
      }
      const {
        selectedProvider: ctxSelectedProvider,
        selectedModel: ctxSelectedModel,
        selectedProviderModels: ctxSelectedProviderModels,
        selectedPromptEffort: ctxSelectedPromptEffort,
        selectedModelSelection: ctxSelectedModelSelection,
        runtimeMode: dispatchRuntimeMode,
      } = sendCtx

      const threadIdForSend = activeThread.id
      const messageIdForSend = newMessageId()
      const messageCreatedAt = new Date().toISOString()
      const outgoingMessageText = formatOutgoingPrompt({
        provider: ctxSelectedProvider,
        model: ctxSelectedModel,
        models: ctxSelectedProviderModels,
        effort: ctxSelectedPromptEffort,
        text: trimmed,
      })

      sendInFlightRef.current = true
      beginLocalDispatch({ preparingWorktree: false })
      setThreadError(threadIdForSend, null)

      // position this sent row once LegendList has measured the anchored tail.
      isAtEndRef.current = true
      timelineScrollModeRef.current = 'anchoring-new-turn'
      liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current
      pendingTimelineAnchorRef.current = messageIdForSend
      activeTimelineAnchorIndexRef.current = null
      showScrollDebouncer.current.cancel()
      setShowScrollToBottom(false)
      setTimelineAnchor({
        threadKey: scopedThreadKey(scopeThreadRef(activeThread.environmentId, threadIdForSend)),
        messageId: messageIdForSend,
      })

      setOptimisticUserMessages((existing) => [
        ...existing,
        {
          id: messageIdForSend,
          role: 'user',
          text: outgoingMessageText,
          turnId: null,
          createdAt: messageCreatedAt,
          updatedAt: messageCreatedAt,
          streaming: false,
        },
      ])

      const settingsResult = await persistThreadSettingsForNextTurn({
        threadId: threadIdForSend,
        createdAt: messageCreatedAt,
        modelSelection: ctxSelectedModelSelection,
        // ? sending while the banner is up rewrites thread.branch to whatever the
        // checkout happens to be on, so a thread that ran on feature/x is recorded
        // as a thread on main the moment its user sends from main. it may be the
        // behaviour people expect from the banner; it has never been decided
        ...(localCheckoutBranchMismatch
          ? { branch: localCheckoutBranchMismatch.currentBranch }
          : {}),
        runtimeMode: dispatchRuntimeMode,
        collaborationMode: nextCollaborationMode,
      })
      let failure: AtomCommandResult<unknown, unknown> | null =
        settingsResult._tag === 'Failure' ? settingsResult : null

      if (failure === null)
      {
        // keep the mode toggle and plan-follow-up banner in sync immediately
        // while the same-thread implementation turn is starting.
        setComposerDraftInteractionMode(
          scopeThreadRef(activeThread.environmentId, threadIdForSend),
          nextCollaborationMode,
        )

        const startResult = await startThreadTurn({
          environmentId,
          input: {
            threadId: threadIdForSend,
            message: {
              messageId: messageIdForSend,
              role: 'user',
              text: outgoingMessageText,
              attachments: [],
            },
            modelSelection: ctxSelectedModelSelection,
            titleSeed: activeThread.title,
            runtimeMode: dispatchRuntimeMode,
            interactionMode: wireMode.interactionMode,
            orchestrate: wireMode.orchestrate,
            ...(importContinuationConsent ? { importContinuationConsent } : {}),
            ...(nextCollaborationMode.baseMode !== 'plan' && activeProposedPlan
              ? {
                  sourceProposedPlan: {
                    threadId: activeThread.id,
                    planId: activeProposedPlan.id,
                  },
                }
              : {}),
            createdAt: messageCreatedAt,
          },
        })
        failure = startResult._tag === 'Failure' ? startResult : null
      }

      if (failure === null)
      {
        // optimistically open the plan sidebar when implementing (not refining).
        // "default" mode here means the agent is executing the plan, which produces
        // step-tracking activities that the sidebar will display.
        if (nextCollaborationMode.baseMode === 'default' && autoOpenPlanSidebar)
        {
          planSidebarDismissedForTurnRef.current = null
          if (activeThreadRef)
          {
            useRightPanelStore.getState().open(activeThreadRef, 'plan')
          }
        }
        sendInFlightRef.current = false
        return true
      }

      setOptimisticUserMessages((existing) =>
        existing.filter((message) => message.id !== messageIdForSend),
      )
      if (!isAtomCommandInterrupted(failure))
      {
        const error = squashAtomCommandFailure(failure)
        setThreadError(
          threadIdForSend,
          error instanceof Error ? error.message : 'Failed to send plan follow-up.',
        )
      }
      sendInFlightRef.current = false
      resetLocalDispatch()
      return false
    },
    [
      activeThread,
      activeProposedPlan,
      beginLocalDispatch,
      focusImportContinuationBanner,
      importContinuationConsent,
      importContinuationSendBlocked,
      isConnecting,
      isSendBusy,
      isServerThread,
      localCheckoutBranchMismatch,
      persistThreadSettingsForNextTurn,
      resetLocalDispatch,
      runtimeMode,
      setComposerDraftInteractionMode,
      setThreadError,
      startThreadTurn,
      autoOpenPlanSidebar,
      environmentId,
      composerRef,
    ],
  )

  const onImplementPlanInNewThread = useCallback(
    async (implementVariant?: PlanImplementVariant) =>
    {
      if (
        !activeThread ||
        !activeProject ||
        !activeProposedPlan ||
        !isServerThread ||
        isSendBusy ||
        isConnecting ||
        activeEnvironmentUnavailable ||
        sendInFlightRef.current
      )
      {
        return
      }

      const sendCtx = composerRef.current?.getSendContext()
      if (!sendCtx?.providerAvailable)
      {
        return
      }
      const {
        selectedProvider: ctxSelectedProvider,
        selectedModel: ctxSelectedModel,
        selectedProviderModels: ctxSelectedProviderModels,
        selectedPromptEffort: ctxSelectedPromptEffort,
        selectedModelSelection: ctxSelectedModelSelection,
        runtimeMode: dispatchRuntimeMode,
      } = sendCtx

      const createdAt = new Date().toISOString()
      const nextThreadId = newThreadId()
      const planMarkdown = activeProposedPlan.planMarkdown
      const implementationCollaborationMode = normalizeCollaborationMode(
        'default',
        implementVariant === 'orchestrate',
      )
      const implementationWireMode = toWireInteractionMode(implementationCollaborationMode)
      const implementationPrompt =
        implementVariant === 'orchestrate'
          ? ORCHESTRATE_PLAN_IMPLEMENTATION_PROMPT
          : buildPlanImplementationPrompt(planMarkdown)
      const outgoingImplementationPrompt = formatOutgoingPrompt({
        provider: ctxSelectedProvider,
        model: ctxSelectedModel,
        models: ctxSelectedProviderModels,
        effort: ctxSelectedPromptEffort,
        text: implementationPrompt,
      })
      if (composerRef.current?.validateProviderInput(outgoingImplementationPrompt) === false)
      {
        return
      }
      const nextThreadTitle = truncate(buildPlanImplementationThreadTitle(planMarkdown))
      const nextThreadModelSelection: ModelSelection = ctxSelectedModelSelection

      sendInFlightRef.current = true
      beginLocalDispatch({ preparingWorktree: false })
      const finish = () =>
      {
        sendInFlightRef.current = false
        resetLocalDispatch()
      }

      const createResult = await createThread({
        environmentId,
        input: {
          threadId: nextThreadId,
          projectId: activeProject.id,
          title: nextThreadTitle,
          modelSelection: nextThreadModelSelection,
          runtimeMode: dispatchRuntimeMode,
          interactionMode: implementationWireMode.interactionMode,
          orchestrate: implementationWireMode.orchestrate,
          branch: activeThreadBranch,
          worktreePath: activeThread.worktreePath,
          createdAt,
        },
      })
      let failure: AtomCommandResult<unknown, unknown> | null =
        createResult._tag === 'Failure' ? createResult : null
      let implementationPhase: 'created' | 'started' = 'created'

      if (failure === null)
      {
        const startResult = await startThreadTurn({
          environmentId,
          input: {
            threadId: nextThreadId,
            message: {
              messageId: newMessageId(),
              role: 'user',
              text: outgoingImplementationPrompt,
              attachments: [],
            },
            modelSelection: ctxSelectedModelSelection,
            titleSeed: nextThreadTitle,
            runtimeMode: dispatchRuntimeMode,
            interactionMode: implementationWireMode.interactionMode,
            orchestrate: implementationWireMode.orchestrate,
            sourceProposedPlan: {
              threadId: activeThread.id,
              planId: activeProposedPlan.id,
            },
            createdAt,
          },
        })
        failure = startResult._tag === 'Failure' ? startResult : null
        if (failure === null)
        {
          implementationPhase = 'started'
        }
      }

      if (failure === null)
      {
        const startedResult = await settlePromise(() =>
          waitForStartedServerThread(scopeThreadRef(activeThread.environmentId, nextThreadId)),
        )
        failure = startedResult._tag === 'Failure' ? startedResult : null
      }

      if (failure === null)
      {
        // signal that the plan sidebar should open on the new thread when enabled.
        planSidebarOpenOnNextThreadRef.current = autoOpenPlanSidebar
        const navigateResult = await settlePromise(() =>
          navigate({
            to: '/$environmentId/$threadId',
            params: {
              environmentId: activeThread.environmentId,
              threadId: nextThreadId,
            },
          }),
        )
        failure = navigateResult._tag === 'Failure' ? navigateResult : null
      }

      if (failure !== null)
      {
        if (implementationPhase !== 'started')
        {
          const cleanupResult = await deleteThread({
            environmentId,
            input: {
              threadId: nextThreadId,
            },
          })
          if (cleanupResult._tag === 'Failure' && !isAtomCommandInterrupted(cleanupResult))
          {
            console.warn(
              'Failed to clean up implementation thread after start failure.',
              squashAtomCommandFailure(cleanupResult),
            )
          }
        }
        if (!isAtomCommandInterrupted(failure))
        {
          const error = squashAtomCommandFailure(failure)
          toastManager.add(
            stackedThreadToast({
              type: 'error',
              title:
                implementationPhase === 'started'
                  ? 'Implementation started, but navigation failed'
                  : 'Could not start implementation thread',
              description:
                error instanceof Error
                  ? error.message
                  : implementationPhase === 'started'
                    ? 'Open the implementation thread from the sidebar.'
                    : 'An error occurred while creating the new thread.',
            }),
          )
        }
      }
      finish()
    },
    [
      activeProject,
      activeProposedPlan,
      activeThreadBranch,
      activeThread,
      beginLocalDispatch,
      activeEnvironmentUnavailable,
      createThread,
      deleteThread,
      isConnecting,
      isSendBusy,
      isServerThread,
      navigate,
      resetLocalDispatch,
      runtimeMode,
      startThreadTurn,
      autoOpenPlanSidebar,
      environmentId,
      composerRef,
    ],
  )

  const {
    activeProviderSwitch,
    activeProviderSwitchTarget,
    activeProviderSwitchTargetLabel,
    composerProviderSwitch,
    confirmProviderSwitch,
    dispatchSend,
    getModelDisabledReason,
    isSwitchingProvider,
    leadProviderInstanceId,
    onInterrupt,
    onProviderModelSelect,
    onProviderSwitchConfirmationOpenChange,
    onSend,
    providerSwitchConfirmation,
  } = useChatDispatchController({
    activeLatestTurnRunning: activeLatestTurn?.state === 'running',
    activeThread: activeThread ?? null,
    composerModelSelection,
    environmentId,
    interruptThreadTurn,
    isSendBusy,
    lockedProvider,
    pendingApprovalCount: pendingApprovals.length,
    pendingUserInputCount: pendingUserInputs.length,
    phase,
    providerStatuses,
    providerSwitchTimelineEvents,
    resolveProviderSwitchInstance,
    routeKind,
    routeThreadKey,
    routeThreadRef,
    scheduleComposerFocus,
    send: {
      activeEnvironmentUnavailable,
      activePendingProgress,
      activeProject,
      activeProposedPlan,
      activeThreadBranch,
      activeThreadKey,
      activeTimelineAnchorIndexRef,
      addComposerDraftImages,
      anchorUserScrollGenerationRef,
      beginLocalDispatch,
      captureDraftHeroComposerRect,
      clearComposerDraftContent,
      composerDraftOwnerKey,
      composerDraftOwnerKeyRef,
      composerDraftTarget,
      composerElementContextsRef,
      composerImagesRef,
      composerRef,
      composerTerminalContextsRef,
      focusImportContinuationBanner,
      handleInteractionModeChange,
      importContinuationConsent,
      importContinuationSendBlocked,
      collaborationMode,
      isAtEndRef,
      isConnecting,
      isDraftHeroState,
      isLocalDraftThread,
      isServerThread,
      liveFollowUserScrollGenerationRef,
      localCheckoutBranchMismatch,
      onAdvanceActivePendingUserInput,
      onSubmitPlanFollowUp,
      pendingTimelineAnchorRef,
      persistThreadSettingsForNextTurn,
      promptRef,
      resetLocalDispatch,
      runMobileComposerTransition,
      runtimeMode,
      sendEnvMode,
      sendInFlightRef,
      setComposerDraftElementContexts,
      setComposerDraftPreviewAnnotations,
      setComposerDraftArchitectureContexts,
      setComposerDraftPrompt,
      setComposerDraftReviewComments,
      setComposerDraftTerminalContexts,
      setDockedDraftHeroThreadKey,
      setOptimisticUserMessages,
      setShowScrollToBottom,
      setTimelineAnchor,
      showPlanFollowUpPrompt,
      showScrollDebouncer,
      startFromOrigin,
      startThreadTurn,
      threadDetailLoading,
      timelineScrollModeRef,
      updateThreadMetadata,
    },
    setComposerDraftModelSelection,
    setStickyComposerModelSelection,
    setThreadError,
    settings,
    switchThreadProvider,
    threadDetailSynchronized,
    verifiedImportProviderInstanceId,
  })

  const onImplementPlanWithOrchestrate = useCallback(() =>
  {
    void dispatchSend(undefined, { planImplementVariant: 'orchestrate' })
  }, [dispatchSend])

  const onApproveOrchestratePlan = useCallback(
    async (reply: string) =>
    {
      onEditOrchestratePlanInChat(reply)
      return dispatchSend(undefined, { bypassPlanFollowUp: true })
    },
    [dispatchSend, onEditOrchestratePlanInChat],
  )

  const onSendProviderSlashCommand = useCallback(
    (command: string) =>
    {
      void dispatchSend(undefined, { providerSlashCommand: command })
    },
    [dispatchSend],
  )

  // the workers panel reads a host-global broker, so this thread's own plan
  // revisions supply the durable run association that scopes it
  const threadRunIds = useMemo(
    () => [...new Set((activeThread?.orchestratePlans ?? []).map((plan) => plan.runId))],
    [activeThread?.orchestratePlans],
  )

  // the session's reasoning tier lives in the model selection's options array;
  // a non-string value is not a tier label, so it renders as no tier at all
  const leadEffort = useMemo(() =>
  {
    const raw = activeThread?.modelSelection.options?.find(
      (option) => option.id === 'reasoningEffort',
    )?.value
    return typeof raw === 'string' ? raw : ''
  }, [activeThread?.modelSelection])

  const orchestratePlanActions = useMemo(
    () => ({
      environmentId,
      threadRef: activeThreadRef,
      projectId: activeThread?.projectId ?? null,
      instanceEntries: orchestrateInstanceEntries,
      modelOptionsByInstance: orchestrateModelOptions,
      orchestratePlans: activeThread?.orchestratePlans ?? [],
      // the lead row shows the binding this session is actually running, so a
      // stage bound to the same model is visible before the plan is approved
      lead:
        activeThread === undefined || leadProviderInstanceId === null
          ? null
          : {
              provider:
                orchestrateInstanceEntries.find(
                  (entry) => entry.instanceId === leadProviderInstanceId,
                )?.driverKind ?? '',
              model: activeThread.modelSelection.model,
              instanceId: leadProviderInstanceId,
            },
      ...(leadEffort === '' ? {} : { leadEffort }),
      onApprove: onApproveOrchestratePlan,
      onRespond: onRespondOrchestratePlan,
      onEditInChat: onEditOrchestratePlanInChat,
      onLeadModelChange: onProviderModelSelect,
      onOpenRun: activeThreadRef ? onOpenOrchestrateRun : undefined,
    }),
    [
      activeThread,
      activeThreadRef,
      environmentId,
      leadEffort,
      leadProviderInstanceId,
      onApproveOrchestratePlan,
      onEditOrchestratePlanInChat,
      onOpenOrchestrateRun,
      onProviderModelSelect,
      onRespondOrchestratePlan,
      orchestrateInstanceEntries,
      orchestrateModelOptions,
    ],
  )

  // the dialog outlives its confirmation while it animates closed, so the copy
  // keeps a neutral target rather than flashing an empty name
  const providerSwitchConfirmationCopy = describeProviderSwitchConfirmation({
    targetLabel: providerSwitchConfirmation?.targetLabel ?? 'the selected provider',
  })

  const onEnvModeChange = useCallback(
    (mode: DraftThreadEnvMode) =>
    {
      if (canOverrideServerThreadEnvMode)
      {
        setPendingServerThreadEnvMode(mode)
        scheduleComposerFocus()
        return
      }
      if (isLocalDraftThread)
      {
        setDraftThreadContext(composerDraftTarget, {
          envMode: mode,
          startFromOrigin: resolveNewDraftStartFromOrigin({
            envMode: mode,
            newWorktreesStartFromOrigin: primaryServerSettings.newWorktreesStartFromOrigin,
          }),
          ...(mode === 'worktree' && draftThread?.worktreePath ? { worktreePath: null } : {}),
        })
      }
      scheduleComposerFocus()
    },
    [
      canOverrideServerThreadEnvMode,
      composerDraftTarget,
      draftThread?.worktreePath,
      isLocalDraftThread,
      primaryServerSettings.newWorktreesStartFromOrigin,
      setPendingServerThreadEnvMode,
      scheduleComposerFocus,
      setDraftThreadContext,
    ],
  )

  const onStartFromOriginChange = (nextStartFromOrigin: boolean) =>
  {
    if (canOverrideServerThreadEnvMode && activeThread)
    {
      setPendingServerThreadStartFromOriginByThreadId((current) =>
        current[activeThread.id] === nextStartFromOrigin
          ? current
          : { ...current, [activeThread.id]: nextStartFromOrigin },
      )
      return
    }
    if (isLocalDraftThread)
    {
      setDraftThreadContext(composerDraftTarget, {
        startFromOrigin: nextStartFromOrigin,
      })
    }
  }

  const onExpandTimelineImage = useCallback((preview: ExpandedImagePreview) =>
  {
    setExpandedImage(preview)
  }, [])
  const onOpenTurnDiff = useCallback(
    (turnId: TurnId, filePath?: string) =>
    {
      if (!isServerThread || !activeThreadRef) return
      useDiffPanelStore.getState().selectTurn(activeThreadRef, turnId, filePath)
      useRightPanelStore.getState().open(activeThreadRef, 'diff')
      onDiffPanelOpen?.()
    },
    [activeThreadRef, isServerThread, onDiffPanelOpen],
  )
  const onOpenRunDiff = useCallback(() =>
  {
    if (!isServerThread || !activeThreadRef) return
    useDiffPanelStore.getState().selectGitScope(activeThreadRef, 'run')
    useRightPanelStore.getState().open(activeThreadRef, 'diff')
    onDiffPanelOpen?.()
  }, [activeThreadRef, isServerThread, onDiffPanelOpen])
  // both the Map and the revert handler are read from refs at call-time so
  // the callback reference is fully stable and never busts context identity.
  const revertTurnCountRef = useRef(revertTurnCountByUserMessageId)
  revertTurnCountRef.current = revertTurnCountByUserMessageId
  const onRevertToTurnCountRef = useRef(onRevertToTurnCount)
  onRevertToTurnCountRef.current = onRevertToTurnCount
  const onRevertUserMessage = useCallback((messageId: MessageId) =>
  {
    const targetTurnCount = revertTurnCountRef.current.get(messageId)
    if (typeof targetTurnCount !== 'number')
    {
      return
    }
    void onRevertToTurnCountRef.current(targetTurnCount)
  }, [])

  // empty state: no active thread
  if (!activeThread)
  {
    return <NoActiveThreadState />
  }

  const panelToggleControls = (
    <PanelLayoutControls
      terminalAvailable={activeProject !== null}
      terminalOpen={terminalUiState.terminalOpen}
      terminalShortcutLabel={shortcutLabelForCommand(keybindings, 'terminal.toggle')}
      rightPanelAvailable={activeProject !== null}
      rightPanelOpen={rightPanelOpen}
      rightPanelShortcutLabel={shortcutLabelForCommand(keybindings, 'rightPanel.toggle')}
      onToggleTerminal={toggleTerminalVisibility}
      onToggleRightPanel={toggleRightPanel}
    />
  )
  const panelLayoutControls = (
    <div className="workspace-titlebar-controls z-50 mr-px gap-1 [-webkit-app-region:no-drag]">
      {rightPanelOpen && !shouldUsePlanSidebarSheet ? (
        <RightPanelMaximizeControl
          maximized={rightPanelMaximized}
          onToggle={toggleRightPanelMaximized}
        />
      ) : null}
      {panelToggleControls}
    </div>
  )
  const rightPanelContent = activeThreadRef ? (
    activeRightPanelSurface?.kind === 'preview' ? (
      <Suspense fallback={null}>
        <PreviewPanel
          mode="embedded"
          threadRef={activeThreadRef}
          tabId={activeRightPanelSurface.resourceId}
          configuredUrls={configuredPreviewUrls}
          visible
        />
      </Suspense>
    ) : activeRightPanelSurface?.kind === 'terminal' ? (
      <PersistentThreadTerminalPanel
        threadRef={activeThreadRef}
        surface={activeRightPanelSurface}
        launchContext={activeTerminalLaunchContext ?? null}
        focusRequestId={terminalFocusRequestId}
        keybindings={keybindings}
        onAddTerminalContext={addTerminalContextToDraft}
        onSplitTerminal={splitPanelTerminal}
        onSplitTerminalVertical={splitPanelTerminalVertical}
        onNewTerminal={addTerminalSurface}
        onActiveTerminalChange={activatePanelTerminal}
        onCloseTerminal={closePanelTerminalImmediately}
        splitShortcutLabel={splitTerminalShortcutLabel ?? undefined}
        splitVerticalShortcutLabel={splitTerminalVerticalShortcutLabel ?? undefined}
        newShortcutLabel={newTerminalShortcutLabel ?? undefined}
        closeShortcutLabel={closeTerminalShortcutLabel ?? undefined}
      />
    ) : activeRightPanelSurface?.kind === 'diff' ? (
      <Suspense fallback={null}>
        <DiffPanel
          key={`${activeThreadKey}:${diffPanelGitStatusResolutionKey}`}
          mode="embedded"
          composerDraftTarget={composerDraftTarget}
          initialGitScope={initialDiffPanelGitScope}
          onAddArchitectureConcern={addArchitectureConcernToComposer}
          onViewInRepositoryMap={viewArchitectureStandingAnchor}
        />
      </Suspense>
    ) : activeRightPanelSurface?.kind === 'workers' ? (
      <Suspense fallback={null}>
        <WorkersPanel
          environmentId={activeThreadRef.environmentId}
          threadId={isServerThread ? activeThreadRef.threadId : null}
          threadRunIds={threadRunIds}
          verdicts={workerVerdicts}
          onSaveVerdict={onSaveWorkerVerdict}
        />
      </Suspense>
    ) : activeRightPanelSurface?.kind === 'repository-atlas-home' ? (
      repositoryAtlasAvailable && activeThread ? (
        <RepositoryAtlasBootstrap projectId={activeThread.projectId} threadRef={activeThreadRef} />
      ) : (
        <div
          className="flex min-h-0 flex-1 items-center justify-center px-6 py-8 text-center text-xs text-muted-foreground"
          role="status"
        >
          Repository Map requires native architecture analysis for an open project.
        </div>
      )
    ) : activeRightPanelSurface?.kind === 'repository-atlas' ? (
      <Suspense
        fallback={
          <div
            className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground"
            role="status"
          >
            Loading Repository Map…
          </div>
        }
      >
        <RepositoryAtlasSurface
          environmentId={activeThreadRef.environmentId}
          focusRequest={
            repositoryMapFocusRequest !== null &&
            repositoryMapFocusRequest.anchor.source.generationId ===
              activeRightPanelSurface.target.generationId &&
            repositoryMapFocusRequest.anchor.source.graphDigest ===
              activeRightPanelSurface.target.graphDigest
              ? repositoryMapFocusRequest
              : undefined
          }
          target={activeRightPanelSurface.target}
          threadId={activeThreadRef.threadId}
          onAddConcern={addArchitectureConcernToComposer}
          onOpenFile={openArchitectureResourceFile}
          onViewUpdated={viewUpdatedRepositoryAtlas}
        />
      </Suspense>
    ) : activeRightPanelSurface?.kind === 'explorer' ? (
      <Suspense
        fallback={
          <div
            className="flex min-h-0 flex-1 items-center justify-center px-6 py-8 text-center text-xs text-muted-foreground"
            role="status"
          >
            Loading Proposal Review…
          </div>
        }
      >
        <ConnectedExplorerPanel
          threadRef={activeThreadRef}
          projectId={activeThread.projectId}
          target={activeRightPanelSurface.target}
          proposalPreviewAvailable={proposalPreviewAvailable}
          architectureImpactAvailable={architectureImpactAvailable}
          onOpenFile={openFileSurface}
        />
      </Suspense>
    ) : activeRightPanelSurface?.kind === 'architecture-impact' ? (
      <Suspense
        fallback={
          <div
            className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground"
            role="status"
          >
            Loading Impact Diff…
          </div>
        }
      >
        <ConnectedArchitectureImpactSurface
          threadRef={activeThreadRef}
          surface={activeRightPanelSurface}
          onAddConcern={addArchitectureConcernToComposer}
          onOpenPlannedPath={openPlannedArchitecturePath}
          onViewInRepositoryMap={viewArchitectureStandingAnchor}
        />
      </Suspense>
    ) : activeRightPanelSurface?.kind === 'plan' ? (
      <PlanSidebar
        activePlan={activePlan}
        activeProposedPlan={sidebarProposedPlan}
        label={planSidebarLabel}
        environmentId={environmentId}
        threadRef={activeThreadRef}
        markdownCwd={gitCwd ?? undefined}
        workspaceRoot={activeWorkspaceRoot}
        timestampFormat={timestampFormat}
        mode="embedded"
      />
    ) : activeRightPanelSurface?.kind === 'file' && activeRightPanelSurface.source ? (
      <Suspense
        fallback={
          <div
            className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground"
            role="status"
          >
            Loading immutable source…
          </div>
        }
      >
        <ArchitectureSourceFilePanel
          environmentId={activeThreadRef.environmentId}
          source={activeRightPanelSurface.source}
          relativePath={activeRightPanelSurface.relativePath}
          revealLine={activeRightPanelSurface.revealLine}
          revealRequestId={activeRightPanelSurface.revealRequestId}
        />
      </Suspense>
    ) : (activeRightPanelSurface?.kind === 'files' || activeRightPanelSurface?.kind === 'file') &&
      activeProject &&
      activeWorkspaceRoot ? (
      <Suspense fallback={null}>
        <FilePreviewPanel
          key={`${activeProject.environmentId}:${activeWorkspaceRoot}:${activeThreadRef.threadId}`}
          environmentId={activeProject.environmentId}
          cwd={activeWorkspaceRoot}
          projectName={activeProject.title}
          threadRef={activeThreadRef}
          composerDraftTarget={composerDraftTarget}
          keybindings={keybindings}
          availableEditors={availableEditors}
          relativePath={
            activeRightPanelSurface.kind === 'file' ? activeRightPanelSurface.relativePath : null
          }
          revealLine={activeFileSurface?.revealLine ?? null}
          revealRequestId={activeFileSurface?.revealRequestId ?? 0}
          onOpenFile={openFileSurface}
          onPendingChange={handleFilePendingChange}
        />
      </Suspense>
    ) : null
  ) : null

  const workspaceFileDropHandlers = makeWorkspaceFileDropHandlers({
    setDragActive: setIsWorkspaceFileDragActive,
    addFiles: (files) => composerRef.current?.addDroppedFiles(files),
  })

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background">
      {rightPanelOpen && !shouldUsePlanSidebarSheet ? panelLayoutControls : null}
      <div
        className={cn(
          'flex min-h-0 min-w-0 flex-col overflow-x-hidden',
          rightPanelMaximized ? 'w-0 flex-none' : 'flex-1',
        )}
        data-chat-column-maximized-away={rightPanelMaximized ? 'true' : 'false'}
      >
        {/* Top bar */}
        <header
          data-chat-header
          className={cn(
            'bg-background transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none',
            isElectron
              ? cn(
                  'workspace-topbar drag-region relative px-3 sm:px-5',
                  reserveTitleBarControlInset &&
                    !inlineRightPanelOwnsTitleBar &&
                    'wco:pr-[var(--workspace-native-controls-inset)]',
                )
              : 'workspace-topbar pl-[calc(env(safe-area-inset-left)+0.75rem)] pr-[calc(env(safe-area-inset-right)+0.75rem)] sm:pl-[calc(env(safe-area-inset-left)+1.25rem)] sm:pr-[calc(env(safe-area-inset-right)+1.25rem)]',
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        >
          {!rightPanelOpen ? panelLayoutControls : null}
          <ChatHeader
            activeThreadEnvironmentId={activeThread.environmentId}
            activeThreadId={activeThread.id}
            {...(routeKind === 'draft' && draftId ? { draftId } : {})}
            activeThreadTitle={activeThread.title}
            activeProjectName={activeProject?.title}
            activeProjectCwd={activeProject?.workspaceRoot ?? null}
            openInCwd={gitCwd}
            activeProjectScripts={activeProject?.scripts}
            preferredScriptId={
              activeProject ? (lastInvokedScriptByProjectId[activeProject.id] ?? null) : null
            }
            keybindings={keybindings}
            availableEditors={availableEditors}
            rightPanelOpen={rightPanelOpen}
            gitCwd={gitCwd}
            runBranch={
              runWorktreeIsNotRepository ? null : (activeThread?.orchestrateRunBranch ?? null)
            }
            onNewThreadInProject={handleNewThreadInActiveProject}
            onRunProjectScript={runProjectScript}
            onAddProjectScript={saveProjectScript}
            onUpdateProjectScript={updateProjectScript}
            onDeleteProjectScript={deleteProjectScript}
            onOpenRunDiff={onOpenRunDiff}
          />
        </header>

        <ThreadErrorBanner
          error={promotedProviderAuthError ? null : visibleThreadError}
          onDismiss={() =>
          {
            setThreadError(activeThread.id, null)
            dismissThreadErrorBannerForSession(threadErrorBannerKey)
            setThreadErrorBannerDismissTick((tick) => tick + 1)
          }}
        />
        {/* Main content area with optional plan sidebar */}
        <div className="flex min-h-0 min-w-0 flex-1">
          {/* Chat column */}
          <div
            className="relative flex min-h-0 min-w-0 flex-1 flex-col"
            data-chat-workspace-drop-target="true"
            onDragEnter={workspaceFileDropHandlers.onDragEnter}
            onDragOver={workspaceFileDropHandlers.onDragOver}
            onDragLeave={workspaceFileDropHandlers.onDragLeave}
            onDrop={workspaceFileDropHandlers.onDrop}
          >
            {isWorkspaceFileDragActive ? (
              <div
                className="pointer-events-none absolute inset-2 z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/60 bg-primary/[0.035]"
                data-chat-workspace-drop-overlay="true"
              >
                <div
                  role="status"
                  className="flex items-center gap-2 rounded-full border border-primary/25 bg-background/95 px-4 py-2.5 text-sm font-medium text-foreground shadow-lg"
                >
                  <PaperclipIcon className="size-4 text-primary" aria-hidden="true" />
                  Drop files to attach
                </div>
              </div>
            ) : null}
            {/* Provider status overlays the timeline without changing its content height. */}
            <div className="pointer-events-none absolute inset-x-0 top-0 z-20">
              <ProviderStatusBanner
                status={visibleProviderStatus}
                reAuthRequired={providerReAuthRequired}
                reAuthDetail={providerReAuthRequired ? visibleThreadError : null}
                onDismiss={() => setDismissedProviderStatusBannerKey(providerStatusBannerKey)}
              />
            </div>
            {/* Messages Wrapper */}
            <div className="relative flex min-h-0 flex-1 flex-col">
              {/* Messages — LegendList handles virtualization and scrolling internally */}
              <MessagesTimeline
                key={activeThread.id}
                isWorking={isWorking}
                activeTurnInProgress={isWorking || !latestTurnSettled}
                activeTurnStartedAt={activeWorkStartedAt}
                listRef={legendListRef}
                timelineEntries={timelineEntries}
                latestTurn={activeLatestTurn}
                runningTurnId={
                  activeThread.session?.status === 'running'
                    ? activeThread.session.activeTurnId
                    : null
                }
                turnDiffSummaryByAssistantMessageId={turnDiffSummaryByAssistantMessageId}
                activeThreadEnvironmentId={activeThread.environmentId}
                routeThreadKey={routeThreadKey}
                onOpenTurnDiff={onOpenTurnDiff}
                revertTurnCountByUserMessageId={revertTurnCountByUserMessageId}
                onRevertUserMessage={onRevertUserMessage}
                isRevertingCheckpoint={isRevertingCheckpoint}
                onImageExpand={onExpandTimelineImage}
                markdownCwd={gitCwd ?? undefined}
                resolvedTheme={resolvedTheme}
                timestampFormat={timestampFormat}
                workspaceRoot={activeWorkspaceRoot}
                skills={activeProviderStatus?.skills ?? EMPTY_PROVIDER_SKILLS}
                anchorMessageId={timelineAnchorMessageId}
                onAnchorReady={onTimelineAnchorReady}
                onAnchorSizeChanged={onTimelineAnchorSizeChanged}
                contentInsetEndAdjustment={composerOverlayHeight}
                onIsAtEndChange={onIsAtEndChange}
                onManualNavigation={cancelTimelineLiveFollowForUserNavigation}
                hideEmptyPlaceholder={isDraftHeroState || threadDetailLoading}
                topFadeEnabled={!hasTimelineTopBanner}
                orchestratePlanActions={orchestratePlanActions}
              />

              {/* scroll to end pill — shown when user has scrolled away from the live edge */}
              {showScrollToBottom && (
                <div
                  className="pointer-events-none absolute left-1/2 z-30 flex -translate-x-1/2 justify-center py-1.5"
                  style={{ bottom: composerOverlayHeight + 4 }}
                >
                  <button
                    type="button"
                    aria-label="Scroll to end"
                    title="Scroll to end"
                    onClick={() => scrollToEnd(true)}
                    className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-border/60 bg-card px-3 py-1 text-muted-foreground text-xs shadow-sm transition-colors hover:border-border hover:text-foreground hover:cursor-pointer"
                  >
                    <ChevronDownIcon className="size-3.5" />
                    Scroll to end
                  </button>
                </div>
              )}
            </div>

            {/* Input bar — centered hero while a draft has no messages, docked at the bottom otherwise */}
            <div
              ref={setComposerOverlayElement}
              data-chat-composer-overlay="true"
              className={
                isDraftHeroState
                  ? 'pointer-events-none absolute inset-0 z-20 flex items-center'
                  : 'pointer-events-none absolute inset-x-0 bottom-0 z-20 pt-1.5 sm:pt-2'
              }
            >
              <div
                ref={attachDraftHeroTransitionGroupRef}
                className="chat-composer-horizontal-inset w-full"
              >
                <div className="pointer-events-auto relative z-10">
                  <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
                    {importBlockedAnnouncementCount > 0 ? (
                      <span key={importBlockedAnnouncementCount}>
                        Sending is blocked. Review the imported session notice before continuing.
                      </span>
                    ) : null}
                  </div>
                  {isDraftHeroState ? (
                    <div className="absolute inset-x-0 bottom-full z-0">
                      <div
                        className="pb-8"
                        style={
                          forceExpandedMobileComposer
                            ? {
                                viewTransitionName: MOBILE_DRAFT_HEADLINE_VIEW_TRANSITION_NAME,
                              }
                            : undefined
                        }
                      >
                        <DraftHeroHeadline
                          activeProjectRef={activeProjectRef}
                          activeProjectTitle={activeProject?.title ?? null}
                        />
                      </div>
                      <ComposerBannerStack className="relative z-0" items={composerBannerItems} />
                    </div>
                  ) : (
                    <ComposerBannerStack className="relative z-0" items={composerBannerItems} />
                  )}
                  {threadSyncPhase && !activeEnvironmentUnavailable ? (
                    <ThreadSyncStatusPill phase={threadSyncPhase} />
                  ) : null}
                  {activeProviderSwitch && activeProviderSwitchTargetLabel ? (
                    <ProviderSwitchStatusPill
                      phase={activeProviderSwitch.phase}
                      targetLabel={activeProviderSwitchTargetLabel}
                      targetDriverKind={activeProviderSwitchTarget?.driverKind ?? null}
                      targetDisplayName={
                        activeProviderSwitchTarget?.displayName ??
                        activeProviderSwitch.targetInstanceId
                      }
                    />
                  ) : null}
                  {pendingHandoffPresentation ? (
                    <div
                      aria-label={pendingHandoffPresentation.label}
                      data-provider-handoff-delivery={pendingHandoffPresentation.delivery}
                      className="pointer-events-none mx-auto mb-2 flex w-fit max-w-full items-center gap-2 rounded-full border border-border/60 bg-card/95 px-3 py-1.5 text-foreground text-xs font-medium shadow-sm"
                      role="status"
                      title={pendingHandoffPresentation.label}
                    >
                      <ArrowRightLeftIcon
                        aria-hidden
                        className="size-3.5 shrink-0 text-muted-foreground"
                      />
                      <span className="truncate">{pendingHandoffPresentation.label}</span>
                    </div>
                  ) : null}
                  <div
                    className="relative"
                    style={
                      forceExpandedMobileComposer
                        ? { viewTransitionName: MOBILE_COMPOSER_VIEW_TRANSITION_NAME }
                        : undefined
                    }
                  >
                    <div
                      className={cn(
                        'chat-composer-glass-shell relative mx-auto w-full max-w-3xl',
                        showComposerContextStrip && 'chat-composer-glass-shell-with-context',
                      )}
                    >
                      <div className="chat-composer-glass-host relative z-10 w-full rounded-[22px]">
                        <div ref={attachDraftHeroComposerAnchorRef} className="relative z-10">
                          <ChatComposer
                            composerRef={composerRef}
                            composerDraftTarget={composerDraftTarget}
                            environmentId={environmentId}
                            routeKind={routeKind}
                            routeThreadRef={routeThreadRef}
                            draftId={draftId}
                            activeThreadId={activeThreadId}
                            activeThreadEnvironmentId={activeThread?.environmentId}
                            activeThread={activeThread}
                            isServerThread={isServerThread}
                            isLocalDraftThread={isLocalDraftThread}
                            forceExpandedOnMobile={forceExpandedMobileComposer && isDraftHeroState}
                            projectSelectionRequired={isLocalDraftThread && activeProject === null}
                            phase={phase}
                            isConnecting={isConnecting}
                            isSendBusy={isSendBusy}
                            sendDisabledReason={
                              composerProviderSwitch
                                ? composerProviderSwitch.notice
                                : threadDetailLoading
                                  ? 'Messages loading'
                                  : null
                            }
                            providerSwitch={composerProviderSwitch}
                            isPreparingWorktree={isPreparingWorktree}
                            importContinuationSendBlocked={importContinuationSendBlocked}
                            environmentUnavailable={activeEnvironmentUnavailableState}
                            activePendingApproval={activePendingApproval}
                            pendingApprovals={pendingApprovals}
                            pendingUserInputs={pendingUserInputs}
                            activePendingProgress={activePendingProgress}
                            activePendingResolvedAnswers={activePendingResolvedAnswers}
                            activePendingIsResponding={activePendingIsResponding}
                            activePendingDraftAnswers={activePendingDraftAnswers}
                            activePendingQuestionIndex={activePendingQuestionIndex}
                            respondingRequestIds={approvalResponseDisabledRequestIds}
                            showPlanFollowUpPrompt={showPlanFollowUpPrompt}
                            activeProposedPlan={activeProposedPlan}
                            activePlan={activePlan as { turnId?: TurnId } | null}
                            sidebarProposedPlan={sidebarProposedPlan as { turnId?: TurnId } | null}
                            planSidebarLabel={planSidebarLabel}
                            planSidebarOpen={planSidebarOpen}
                            runtimeMode={runtimeMode}
                            collaborationMode={collaborationMode}
                            lockedProvider={lockedProvider}
                            providerStatuses={composerProviderStatuses as ServerProvider[]}
                            activeProjectDefaultModelSelection={
                              activeProject?.defaultModelSelection
                            }
                            activeThreadModelSelection={activeThread?.modelSelection}
                            activeThreadActivities={activeThread?.activities}
                            resolvedTheme={resolvedTheme}
                            settings={settings}
                            keybindings={keybindings}
                            terminalOpen={Boolean(terminalUiState.terminalOpen)}
                            gitCwd={gitCwd}
                            promptRef={promptRef}
                            composerImagesRef={composerImagesRef}
                            composerTerminalContextsRef={composerTerminalContextsRef}
                            composerElementContextsRef={composerElementContextsRef}
                            onSend={onSend}
                            onSendProviderSlashCommand={onSendProviderSlashCommand}
                            onInterrupt={onInterrupt}
                            onImplementPlanWithOrchestrate={onImplementPlanWithOrchestrate}
                            onImplementPlanInNewThread={onImplementPlanInNewThread}
                            onRespondToApproval={onRespondToApproval}
                            onSelectActivePendingUserInputOption={
                              onSelectActivePendingUserInputOption
                            }
                            onAdvanceActivePendingUserInput={onAdvanceActivePendingUserInput}
                            onPreviousActivePendingUserInputQuestion={
                              onPreviousActivePendingUserInputQuestion
                            }
                            onChangeActivePendingUserInputCustomAnswer={
                              onChangeActivePendingUserInputCustomAnswer
                            }
                            onProviderModelSelect={onProviderModelSelect}
                            getModelDisabledReason={getModelDisabledReason}
                            toggleInteractionMode={toggleInteractionMode}
                            handleRuntimeModeChange={handleRuntimeModeChange}
                            handleInteractionModeChange={handleInteractionModeChange}
                            togglePlanSidebar={togglePlanSidebar}
                            focusComposer={focusComposer}
                            scheduleComposerFocus={scheduleComposerFocus}
                            setThreadError={setThreadError}
                            onExpandImage={onExpandTimelineImage}
                          />
                        </div>
                      </div>
                      <div className="min-h-0">
                        <div
                          data-terminal-open={terminalUiState.terminalOpen ? 'true' : undefined}
                          className="relative z-0"
                        >
                          {showComposerContextStrip && (
                            <div className="pointer-events-auto">
                              <BranchToolbar
                                environmentId={activeThread.environmentId}
                                threadId={activeThread.id}
                                {...(routeKind === 'draft' && draftId ? { draftId } : {})}
                                onEnvModeChange={onEnvModeChange}
                                startFromOrigin={startFromOrigin}
                                onStartFromOriginChange={onStartFromOriginChange}
                                {...(canOverrideServerThreadEnvMode
                                  ? { effectiveEnvModeOverride: envMode }
                                  : {})}
                                {...(canOverrideServerThreadEnvMode
                                  ? {
                                      activeThreadBranchOverride: activeThreadBranch,
                                      onActiveThreadBranchOverrideChange:
                                        setPendingServerThreadBranch,
                                    }
                                  : {})}
                                envLocked={envLocked}
                                onComposerFocusRequest={scheduleComposerFocus}
                                {...(canCheckoutPullRequestIntoThread
                                  ? { onCheckoutPullRequestRequest: openPullRequestDialog }
                                  : {})}
                                {...(hasMultipleEnvironments ? { onEnvironmentChange } : {})}
                                availableEnvironments={logicalProjectEnvironments}
                              />
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                    <div
                      aria-hidden
                      className="h-[calc(env(safe-area-inset-bottom)+1rem)] sm:h-[calc(env(safe-area-inset-bottom)+1.25rem)]"
                    />
                  </div>
                </div>
              </div>
            </div>

            <AlertDialog
              open={
                providerSwitchConfirmation?.environmentId === activeThread.environmentId &&
                providerSwitchConfirmation.threadId === activeThread.id
              }
              onOpenChange={onProviderSwitchConfirmationOpenChange}
            >
              <AlertDialogPopup>
                <AlertDialogHeader>
                  <AlertDialogTitle>{providerSwitchConfirmationCopy.title}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {providerSwitchConfirmationCopy.description}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogClose
                    render={<Button variant="outline" disabled={isSwitchingProvider} />}
                  >
                    Cancel
                  </AlertDialogClose>
                  <Button
                    variant="default"
                    disabled={isSwitchingProvider}
                    onClick={() => void confirmProviderSwitch()}
                  >
                    {isSwitchingProvider ? 'Switching...' : 'Switch provider'}
                  </Button>
                </AlertDialogFooter>
              </AlertDialogPopup>
            </AlertDialog>

            <AlertDialog open={branchRestoreConfirmOpen} onOpenChange={setBranchRestoreConfirmOpen}>
              <AlertDialogPopup>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    Switch to{' '}
                    <code className="font-medium">
                      {localCheckoutBranchMismatch?.threadBranch ?? ''}
                    </code>
                    ?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    You have uncommitted changes. They'll carry over to the other branch, or block
                    the switch if they conflict.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
                  <Button
                    variant="default"
                    onClick={() =>
                    {
                      setBranchRestoreConfirmOpen(false)
                      void handleSwitchCheckoutToThread()
                    }}
                  >
                    Switch branch
                  </Button>
                </AlertDialogFooter>
              </AlertDialogPopup>
            </AlertDialog>

            {pullRequestDialogState ? (
              <PullRequestThreadDialog
                key={pullRequestDialogState.key}
                open
                environmentId={activeThread.environmentId}
                threadId={activeThread.id}
                cwd={activeProject?.workspaceRoot ?? null}
                initialReference={pullRequestDialogState.initialReference}
                onOpenChange={(open) =>
                  {
                  if (!open)
                    {
                    closePullRequestDialog()
                  }
                }}
                onPrepared={handlePreparedPullRequestThread}
              />
            ) : null}
          </div>
          {/* end chat column */}
        </div>
        {/* end horizontal flex container */}

        {mountedTerminalThreadRefs.map(({ key: mountedThreadKey, threadRef: mountedThreadRef }) => (
          <PersistentThreadTerminalDrawer
            key={mountedThreadKey}
            threadRef={mountedThreadRef}
            threadId={mountedThreadRef.threadId}
            visible={mountedThreadKey === activeThreadKey && terminalUiState.terminalOpen}
            launchContext={
              mountedThreadKey === activeThreadKey ? (activeTerminalLaunchContext ?? null) : null
            }
            focusRequestId={mountedThreadKey === activeThreadKey ? terminalFocusRequestId : 0}
            splitShortcutLabel={splitTerminalShortcutLabel ?? undefined}
            splitVerticalShortcutLabel={splitTerminalVerticalShortcutLabel ?? undefined}
            newShortcutLabel={newTerminalShortcutLabel ?? undefined}
            closeShortcutLabel={closeTerminalShortcutLabel ?? undefined}
            keybindings={keybindings}
            onAddTerminalContext={addTerminalContextToDraft}
          />
        ))}
      </div>

      {!shouldUsePlanSidebarSheet && rightPanelOpen && activeThreadRef ? (
        <RightPanelTabs
          mode="inline"
          contextKey={scopedThreadKey(activeThreadRef)}
          maximized={rightPanelMaximized}
          surfaces={rightPanelState.surfaces}
          activeSurfaceId={activeRightPanelSurface?.id ?? null}
          pendingSurfaceIds={pendingFileSurfaceIds}
          previewSessions={activePreviewState.sessions}
          desktopByTabId={activePreviewState.desktopByTabId}
          previewRuntimeTabId={resolvePreviewRuntimeTabId}
          terminalLabelsById={activeTerminalLabelsById}
          onActivate={activateRightPanelSurface}
          onCloseSurface={closeRightPanelSurface}
          onCloseOtherSurfaces={closeOtherRightPanelSurfaces}
          onCloseSurfacesToRight={closeRightPanelSurfacesToRight}
          onCloseAllSurfaces={closeAllRightPanelSurfaces}
          onCopyFilePath={copyRightPanelFilePath}
          onAddBrowser={createBrowserSurface}
          onAddTerminal={addTerminalSurface}
          onAddDiff={addDiffSurface}
          onAddFiles={addFilesSurface}
          onAddWorkers={addWorkersSurface}
          onAddRepositoryAtlas={addRepositoryAtlasSurface}
          onAddExplorer={addExplorerSurface}
          browserAvailable={isPreviewSupportedInRuntime()}
          diffAvailable={isServerThread && isGitRepo}
          filesAvailable={activeProject !== null}
          repositoryAtlasAvailable={repositoryAtlasAvailable}
          explorerAvailable={explorerAvailable}
        >
          {rightPanelContent}
        </RightPanelTabs>
      ) : null}
      {shouldUsePlanSidebarSheet && rightPanelOpen && activeThreadRef ? (
        <RightPanelSheet open onClose={planSidebarOpen ? closePlanSidebar : closePreviewPanel}>
          <RightPanelTabs
            mode="sheet"
            contextKey={scopedThreadKey(activeThreadRef)}
            layoutControls={<div className="mr-px flex items-center">{panelToggleControls}</div>}
            surfaces={rightPanelState.surfaces}
            activeSurfaceId={activeRightPanelSurface?.id ?? null}
            pendingSurfaceIds={pendingFileSurfaceIds}
            previewSessions={activePreviewState.sessions}
            desktopByTabId={activePreviewState.desktopByTabId}
            previewRuntimeTabId={resolvePreviewRuntimeTabId}
            terminalLabelsById={activeTerminalLabelsById}
            onActivate={activateRightPanelSurface}
            onCloseSurface={closeRightPanelSurface}
            onCloseOtherSurfaces={closeOtherRightPanelSurfaces}
            onCloseSurfacesToRight={closeRightPanelSurfacesToRight}
            onCloseAllSurfaces={closeAllRightPanelSurfaces}
            onCopyFilePath={copyRightPanelFilePath}
            onAddBrowser={createBrowserSurface}
            onAddTerminal={addTerminalSurface}
            onAddDiff={addDiffSurface}
            onAddFiles={addFilesSurface}
            onAddWorkers={addWorkersSurface}
            onAddRepositoryAtlas={addRepositoryAtlasSurface}
            onAddExplorer={addExplorerSurface}
            browserAvailable={isPreviewSupportedInRuntime()}
            diffAvailable={isServerThread && isGitRepo}
            filesAvailable={activeProject !== null}
            repositoryAtlasAvailable={repositoryAtlasAvailable}
            explorerAvailable={explorerAvailable}
          >
            {rightPanelContent}
          </RightPanelTabs>
        </RightPanelSheet>
      ) : null}

      {expandedImage && (
        <ExpandedImageDialog
          key={`${expandedImage.images[expandedImage.index]?.src ?? 'image'}:${expandedImage.index}`}
          preview={expandedImage}
          onClose={closeExpandedImage}
        />
      )}
    </div>
  )
}

export default function ChatView(props: ChatViewProps)
{
  return (
    <DiffWorkerPoolProvider>
      <ChatViewContent {...props} />
    </DiffWorkerPoolProvider>
  )
}
