// apps/web/src/components/SidebarV2.tsx
// renders project-grouped thread navigation and lifecycle shelves
import { useAtomValue } from '@effect/atom-react'
import { LegendList, type LegendListRef } from '@legendapp/list/react'
import {
  canSnooze,
  effectiveSettled,
  effectiveSnoozed,
  threadWokeAt,
} from '@t3tools/client-runtime/state/thread-settled'
import type { EnvironmentThreadShell } from '@t3tools/client-runtime/state/models'
import {
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from '@t3tools/client-runtime/environment'
import type { ScopedThreadRef, SidebarProjectGroupingMode } from '@t3tools/contracts'
import { resolveThreadChangeRoot } from '@t3tools/shared/threadChangeRoot'
import {
  AlarmClockIcon,
  AlarmClockOffIcon,
  BlocksIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  ClockIcon,
  CopyIcon,
  FolderIcon,
  FolderPlusIcon,
  GitBranchIcon,
  EllipsisIcon,
  MessageSquareIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  ServerIcon,
  SquarePenIcon,
  Trash2Icon,
  Undo2Icon,
} from 'lucide-react'
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { useParams, useRouter } from '@tanstack/react-router'

import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from '@t3tools/client-runtime/state/runtime'
import { isElectron } from '../env'
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  shouldShowThreadJumpHintsForModifiers,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from '../keybindings'
import { useShortcutModifierState } from '../lib/shortcutModifierState'
import { isTerminalFocused } from '../lib/terminalFocus'
import { useTerminalFocus } from '../hooks/useTerminalFocus'
import { isModelPickerOpen } from '../modelPickerVisibility'
import { selectThreadTerminalUiState, useTerminalUiStateStore } from '../terminalUiStateStore'
import { isMacPlatform } from '~/lib/utils'
import { useOpenPrLink } from '../lib/openPullRequestLink'
import { readLocalApi } from '../localApi'
import {
  deriveProjectGroupingOverrideKey,
  getProjectOrderKey,
  selectProjectGroupingSettings,
} from '../logicalProject'
import {
  buildSidebarProjectSnapshots,
  type SidebarProjectGroupMember,
  type SidebarProjectSnapshot,
} from '../lib/sidebarProjectGrouping'
import { legacyProjectCwdPreferenceKey, useUiStateStore } from '../uiStateStore'
import { useThreadSelectionStore } from '../threadSelectionStore'
import { useThreadActions } from '../hooks/useThreadActions'
import { useHandleNewThread } from '../hooks/useHandleNewThread'
import { openCommandPalette } from '../commandPaletteBus'
import { startNewThreadFromContext } from '../lib/chatThreadActions'
import { useClientSettings, useUpdateClientSettings } from '../hooks/useSettings'
import { useCopyToClipboard } from '../hooks/useCopyToClipboard'
import { useNowMinute } from '../hooks/useNowMinute'
import { useEnvironments, usePrimaryEnvironmentId } from '../state/environments'
import { useProjects, useThreadShells } from '../state/entities'
import { environmentServerConfigsAtom, primaryServerKeybindingsAtom } from '../state/server'
import { vcsEnvironment } from '../state/vcs'
import { threadEnvironment } from '../state/threads'
import { projectEnvironment } from '../state/projects'
import { useEnvironmentQuery } from '../state/query'
import { useAtomCommand } from '../state/use-atom-command'
import { buildThreadRouteParams, resolveThreadRouteTarget } from '../threadRoutes'
import { formatRelativeTimeLabel, parseTimestampDate } from '../timestampFormat'
import type { SidebarThreadSummary } from '../types'
import { importSourceDisplayName, importSourceDriverKind } from '../lib/importSourcePresentation'
import { cn } from '~/lib/utils'
import {
  estimateSidebarV2HeaderSize,
  formatWorkingDurationLabel,
  firstValidTimestampMs,
  hasUnseenCompletion,
  isImportedShelfThread,
  isTrailingDoubleClick,
  orderItemsByPreferredIds,
  resolveAdjacentThreadId,
  resolveSettledTimestamp,
  resolveSidebarV2LifecycleSection,
  resolveSidebarV2Status,
  resolveWorkingStartedAt,
  shouldNavigateAfterProjectRemoval,
  sortLogicalProjectsForSidebar,
  sortSettledThreadsForSidebarV2,
  sortThreadsForSidebarV2,
} from './Sidebar.logic'
import { resolveLocalCheckoutBranchMismatch } from './BranchToolbar.logic'
import { buildThreadActionMenuItems } from './threadActionMenu.logic'
import {
  canRetainTerminalThreadPr,
  nextThreadChangeRequestSnapshot,
  nextTerminalChangeRequestObservation,
  prStatusIndicator,
  resolveDisplayedThreadPr,
  resolveDisplayedThreadPrProvider,
  setThreadChangeRequestSnapshot,
  settledPrHoverColorClass,
  threadChangeRequestSnapshotsAtom,
  type TerminalChangeRequestObservation,
  type ThreadChangeRequestSnapshot,
} from './ThreadStatusIndicators'
import {
  resolveSnoozePresets,
  snoozeWakeDescription,
  snoozeWakeLabel,
  type SnoozePreset,
} from './Sidebar.snooze'
import { ProjectFavicon } from './ProjectFavicon'
import { ProviderInstanceIcon } from './chat/ProviderInstanceIcon'
import { getTriggerDisplayModelLabel } from './chat/providerIconUtils'
import {
  deriveProviderEntriesByEnvironment,
  shouldShowInstanceBadge,
  type ProviderInstanceEntry,
} from '../providerInstances'
import { stackedThreadToast, toastManager } from './ui/toast'
import { CommandDialogTrigger } from './ui/command'
import { Button } from './ui/button'
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from './ui/dialog'
import { Input } from './ui/input'
import { Kbd } from './ui/kbd'
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from './ui/menu'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from './ui/select'
import { SidebarContent, SidebarGroup, SidebarMenuButton, useSidebar } from './ui/sidebar'
import { SidebarChromeFooter, SidebarChromeHeader } from './sidebar/SidebarChrome'
import { Popover, PopoverPopup, PopoverTrigger } from './ui/popover'
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from './ui/tooltip'
import { useComposerDraftStore } from '../composerDraftStore'
import { useRightPanelStore } from '../rightPanelStore'
import { repositoryAtlasDisabledReason } from './architecture/architectureAvailability'

// settled-tail paging: recent history is the common lookup; the deep tail
// stays behind an explicit Show more.
const SETTLED_TAIL_INITIAL_COUNT = 10
const SETTLED_TAIL_PAGE_COUNT = 25
const SIDEBAR_V2_LIST_CONTENT_STYLE = { gap: 1 }
const SIDEBAR_V2_MAINTAIN_VISIBLE_CONTENT_POSITION = { data: true, size: false }
// stable fallback for threads whose environment has no resolved server config,
// so row props never churn a fresh Map per render.
const EMPTY_PROVIDER_ENTRIES: ReadonlyMap<string, ProviderInstanceEntry> = new Map()
type SidebarV2ThreadSection = 'pinned' | 'active' | 'imported' | 'snoozed' | 'settled'

type SidebarV2Shelf = Exclude<SidebarV2ThreadSection, 'pinned' | 'active'>

const PROJECT_GROUPING_MODE_LABELS: Record<SidebarProjectGroupingMode, string> = {
  repository: 'Group by repository',
  repository_path: 'Group by repository path',
  separate: 'Keep separate',
}

function ProjectArchitectureButton(props: {
  readonly member: SidebarProjectGroupMember
  readonly hasServerThread: boolean
  readonly activeEnvironmentId: string | null
  readonly activeProjectId: string | null
  readonly architectureCapability: boolean | null
  readonly onOpen: (member: SidebarProjectGroupMember) => void
})
{
  const exactProject =
    props.activeEnvironmentId === props.member.environmentId &&
    props.activeProjectId === props.member.id
  const disabledReason = repositoryAtlasDisabledReason({
    hasServerThread: props.hasServerThread,
    exactProject,
    capability: props.architectureCapability,
    environmentLabel: props.member.environmentLabel ?? undefined,
  })
  const available = disabledReason === null

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            aria-disabled={!available || undefined}
            className={cn(!available && 'cursor-not-allowed opacity-50')}
            onClick={() =>
            {
              if (available) props.onOpen(props.member)
            }}
          />
        }
      >
        <BlocksIcon />
        Repository Map
      </TooltipTrigger>
      <TooltipPopup side="top">
        {disabledReason ?? `Open the Repository Map for ${props.member.title}.`}
      </TooltipPopup>
    </Tooltip>
  )
}

function importedThreadListKey(thread: EnvironmentThreadShell): string
{
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
}

function SidebarV2ShelfHeader(props: {
  shelf: SidebarV2Shelf
  count: number
  expanded: boolean
  onToggle: () => void
})
{
  const isImported = props.shelf === 'imported'
  const isSnoozed = props.shelf === 'snoozed'
  const label =
    isImported || !props.expanded
      ? `${isImported ? 'Imported' : isSnoozed ? 'Snoozed' : 'Settled'} (${props.count})`
      : isSnoozed
        ? 'Snoozed'
        : 'Settled'

  return (
    <div role="listitem" data-thread-selection-safe className="list-none">
      <button
        type="button"
        onClick={props.onToggle}
        aria-expanded={props.expanded}
        data-testid={`sidebar-v2-${props.shelf}-shelf-toggle`}
        className={cn(
          'mb-1 mt-3 flex w-full cursor-pointer items-center gap-2 px-2.5 text-left',
          isImported && 'min-h-11 py-2',
        )}
      >
        <span
          className={cn(
            'text-xs font-medium',
            isImported
              ? 'min-w-0 wrap-break-word text-muted-foreground/60'
              : isSnoozed
                ? 'text-blue-600 dark:text-blue-400'
                : 'text-muted-foreground/50',
          )}
        >
          {label}
        </span>
        <span
          className={cn(
            'h-px flex-1',
            isImported
              ? 'bg-sidebar-border/60'
              : isSnoozed
                ? 'bg-blue-500/20 dark:bg-blue-400/15'
                : 'bg-sidebar-border/60',
          )}
        />
        <ChevronDownIcon
          aria-hidden
          className={cn(
            'size-3 transition-transform motion-reduce:transition-none',
            isImported
              ? 'text-muted-foreground/60'
              : isSnoozed
                ? 'text-blue-600 dark:text-blue-400'
                : 'text-muted-foreground/50',
            props.expanded && 'rotate-180',
          )}
        />
      </button>
    </div>
  )
}

function compactSidebarTimeLabel(label: string): string
{
  if (label === 'just now') return 'now'
  return label.endsWith(' ago') ? label.slice(0, -4) : label
}

function threadTimeLabel(thread: SidebarThreadSummary): string
{
  const timestamp = thread.latestUserMessageAt ?? thread.updatedAt
  return compactSidebarTimeLabel(formatRelativeTimeLabel(timestamp))
}

// settled rows read "how long ago did this wrap up", matching their sort
// key: both go through resolveSettledTimestamp so label and order can't
// disagree.
function settledTimeLabel(thread: SidebarThreadSummary): string
{
  const timestamp = resolveSettledTimestamp(thread)
  return timestamp === null ? '' : compactSidebarTimeLabel(formatRelativeTimeLabel(timestamp))
}

// floats at the row's right edge, vertically centered, while the jump
// modifier is held. An overlay pill instead of an inline slot: the hint
// must neither displace the status/time label (holding ⌘ used to blank
// out "Working") nor shift any layout when it appears. pointer-events-none
// so it never swallows clicks meant for the settle/un-settle buttons it
// can overlap.
function JumpHintBadge(props: { label: string })
{
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute right-1.5 top-1/2 z-10 inline-flex h-5 -translate-y-1/2 items-center rounded-full border border-border/80 bg-background/95 px-1.5 font-mono text-[10px] font-medium tracking-tight text-foreground shadow-sm"
    >
      {props.label}
    </span>
  )
}

// self-ticking so only this span re-renders each second, not the whole row.
function WorkingDuration(props: { startedAt: string | null })
{
  const startedMs = props.startedAt !== null ? Date.parse(props.startedAt) : Number.NaN
  const [, setTick] = useState(0)
  useEffect(() =>
  {
    if (Number.isNaN(startedMs)) return
    const id = window.setInterval(() => setTick((tick) => tick + 1), 1_000)
    return () => window.clearInterval(id)
  }, [startedMs])
  if (Number.isNaN(startedMs)) return null
  return <span className="tabular-nums">{formatWorkingDurationLabel(Date.now() - startedMs)}</span>
}

function SidebarV2ThreadTooltip({
  thread,
  projectTitle,
  projectCwd,
  environmentLabel,
  providerEntry,
  showInstanceBadge,
  modelInstanceId,
  modelLabel,
  branchMismatch,
}: {
  thread: SidebarThreadSummary
  projectTitle: string | null
  projectCwd: string | null
  environmentLabel: string | null
  providerEntry: ProviderInstanceEntry | null
  showInstanceBadge: boolean
  modelInstanceId: string
  modelLabel: string
  branchMismatch: {
    threadBranch: string
    currentBranch: string
  } | null
})
{
  const driverKind = providerEntry?.driverKind ?? null
  return (
    <TooltipPopup
      side="right"
      align="start"
      sideOffset={8}
      className="dropdown-glass max-w-80 border-0! text-left whitespace-normal shadow-lg/10 before:hidden dark:shadow-none"
      style={{
        background:
          'color-mix(in srgb, var(--popover) 18%, color-mix(in srgb, var(--popover) var(--glass-opacity), transparent))',
      }}
    >
      <div className="flex max-w-80 flex-col gap-2 p-2">
        <div className="whitespace-nowrap text-sm font-medium text-foreground">{thread.title}</div>
        <div className="grid gap-1.5 text-xs text-muted-foreground">
          {projectTitle ? (
            <div className="flex min-w-0 items-center gap-2">
              <ProjectFavicon
                environmentId={thread.environmentId}
                cwd={projectCwd ?? ''}
                className="size-4 shrink-0 stroke-muted-foreground"
              />
              <div className="min-w-0 wrap-break-word text-foreground/90">{projectTitle}</div>
            </div>
          ) : null}
          {environmentLabel ? (
            <div className="flex min-w-0 items-center gap-2">
              <ServerIcon className="size-4 shrink-0 stroke-muted-foreground" />
              <div className="min-w-0 wrap-break-word text-foreground/90">{environmentLabel}</div>
            </div>
          ) : null}
          {thread.branch ? (
            <div className="flex min-w-0 items-center gap-2">
              <GitBranchIcon className="size-4 shrink-0 stroke-muted-foreground" />
              <div className="min-w-0 wrap-break-word text-foreground/90">{thread.branch}</div>
            </div>
          ) : null}
          {branchMismatch ? (
            <div className="flex min-w-0 items-start gap-2 text-warning">
              <CircleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 stroke-current" />
              <div className="min-w-0 flex-1 wrap-break-word leading-5">
                You're currently checked out on another branch.
              </div>
            </div>
          ) : null}
          {driverKind ? (
            <div className="flex min-w-0 items-center gap-2">
              <ProviderInstanceIcon
                driverKind={driverKind}
                displayName={
                  providerEntry?.displayName ?? thread.session?.providerName ?? modelInstanceId
                }
                accentColor={providerEntry?.accentColor}
                showBadge={showInstanceBadge && providerEntry?.accentColor !== undefined}
                badgeContent="none"
                badgeClassName="h-2 min-w-2 px-0"
                iconClassName="size-4 shrink-0"
              />
              <div className="min-w-0 wrap-break-word text-foreground/90">
                {showInstanceBadge && providerEntry
                  ? `${modelLabel} · ${providerEntry.displayName}`
                  : modelLabel}
              </div>
            </div>
          ) : null}
          {thread.origin ? (
            <div className="flex min-w-0 items-center gap-2">
              <ProviderInstanceIcon
                driverKind={importSourceDriverKind(thread.origin.source)}
                displayName={importSourceDisplayName(thread.origin.source)}
                iconClassName="size-4"
              />
              <div className="min-w-0 wrap-break-word text-foreground/90">
                Imported from {importSourceDisplayName(thread.origin.source)}
              </div>
            </div>
          ) : null}
          {thread.origin?.originalWorkspaceRoot ? (
            <div className="flex min-w-0 items-center gap-2">
              <FolderIcon className="size-4 shrink-0 stroke-muted-foreground" aria-hidden />
              <div className="min-w-0 wrap-break-word text-foreground/90">
                Original workspace: {thread.origin.originalWorkspaceRoot}
              </div>
            </div>
          ) : null}
          {thread.session?.lastError ? (
            <div className="flex min-w-0 items-center gap-2 text-red-600 dark:text-red-400">
              <CircleAlertIcon className="size-4 shrink-0 stroke-current" />
              <div className="min-w-0 wrap-break-word">{thread.session.lastError}</div>
            </div>
          ) : null}
        </div>
      </div>
    </TooltipPopup>
  )
}

// hover entry point for snooze: a clock button opening the preset menu.
// controlled by the row (which also uses the open state to pin its hover
// actions while the menu is up).
function SnoozePopoverButton(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSnooze: (preset: SnoozePreset) => void
})
{
  const { open, onOpenChange, onSnooze } = props
  // presets resolve at open time so "In 1 hour" is relative to the click,
  // not to when the row mounted.
  const presets = useMemo(() => (open ? resolveSnoozePresets(new Date()) : []), [open])
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Snooze thread"
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            className="inline-flex h-full cursor-pointer items-center gap-0.5 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
          />
        }
      >
        <ClockIcon className="size-3" />
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" className="w-56" viewportClassName="p-1">
        {presets.map((preset) => (
          <button
            key={preset.id}
            type="button"
            onClick={(event) =>
            {
              event.stopPropagation()
              onOpenChange(false)
              onSnooze(preset)
            }}
            className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground/90 hover:bg-accent hover:text-foreground"
          >
            <span className="flex-1">{preset.label}</span>
            <span className="font-mono text-[10px] text-muted-foreground/60 tabular-nums">
              {preset.whenLabel}
            </span>
          </button>
        ))}
      </PopoverPopup>
    </Popover>
  )
}

const SidebarV2Row = memo(function SidebarV2Row(props: {
  thread: SidebarThreadSummary
  variant: 'card' | 'slim'
  // slim rows can expose one lifecycle action or stay informational
  variantAction: 'none' | 'settle' | 'unsettle' | 'unsnooze'
  // false on environments whose server predates thread.settle/unsettle:
  // the lifecycle affordances hide entirely rather than fail on click.
  settlementSupported: boolean
  // same contract for thread.snooze/unsnooze.
  snoozeSupported: boolean
  // pinned cards keep their lifecycle quick actions; pin/unpin stays in the menu.
  isPinned: boolean
  // compact wake countdown ("2h") for rows in the snoozed shelf.
  snoozeWakeLabelText: string | null
  // when a snooze ended (timer or early wake); drives the Woke pill until
  // the user visits the thread.
  wokeAt: string | null
  isActive: boolean
  jumpLabel: string | null
  currentEnvironmentId: string | null
  environmentLabel: string | null
  projectCwd: string | null
  projectTitle: string | null
  providerEntryByInstanceId: ReadonlyMap<string, ProviderInstanceEntry>
  onThreadClick: (event: ReactMouseEvent, threadRef: ScopedThreadRef) => void
  onThreadActivate: (threadRef: ScopedThreadRef) => void
  onStartRename: (threadRef: ScopedThreadRef, title: string) => void
  onRenameTitleChange: (title: string) => void
  onCommitRename: (threadRef: ScopedThreadRef, title: string, originalTitle: string) => void
  onCancelRename: () => void
  isRenaming: boolean
  renamingTitle: string
  onContextMenu: (threadRef: ScopedThreadRef, position: { x: number; y: number }) => void
  onSettle: (threadRef: ScopedThreadRef) => void
  onUnsettle: (threadRef: ScopedThreadRef) => void
  onSnooze: (threadRef: ScopedThreadRef, preset: SnoozePreset) => void
  onUnsnooze: (threadRef: ScopedThreadRef) => void
  changeRequestSnapshot: ThreadChangeRequestSnapshot | null
  onTerminalChangeRequestObservation:
    ((threadKey: string, observation: TerminalChangeRequestObservation | null) => void) | null
})
{
  const {
    isRenaming,
    changeRequestSnapshot,
    onTerminalChangeRequestObservation,
    onCancelRename,
    onCommitRename,
    onContextMenu,
    onRenameTitleChange,
    onSettle,
    onSnooze,
    onStartRename,
    onThreadActivate,
    onThreadClick,
    onUnsettle,
    onUnsnooze,
    renamingTitle,
    thread,
    variant,
    variantAction,
  } = props
  const threadRef = useMemo(
    () => scopeThreadRef(thread.environmentId, thread.id),
    [thread.environmentId, thread.id],
  )
  const threadKey = scopedThreadKey(threadRef)
  const lastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[threadKey])
  const isSelected = useThreadSelectionStore((state) => state.selectedThreadKeys.has(threadKey))
  const openPrLink = useOpenPrLink()

  // same semantics as v1 (never-visited counts as read): flipping the beta
  // flag must not light up every historical thread as unread.
  const isUnread = hasUnseenCompletion({ ...thread, lastVisitedAt })
  // subscribed per row rather than threaded down from the list: useNowMinute is
  // one module timer fanned out through useSyncExternalStore, so a row costs one
  // listener entry, while a prop from the list would re-render every row a tick.
  const nowMinute = useNowMinute()
  const nowMs = Date.parse(`${nowMinute}:00.000Z`)
  const status = resolveSidebarV2Status(thread, { nowMs })
  const approvalLifecycleStatus = thread.approvalOutcomes?.some(
    (outcome) => outcome.status === 'unknown',
  )
    ? 'unknown'
    : thread.approvalOutcomes?.some((outcome) => outcome.status === 'responding')
      ? 'responding'
      : null
  // a woken thread reappears at its original position (the sort is
  // deliberately static), so the pill has to carry the weight. Snoozing is
  // an explicit act, so unlike Done, a never-visited woke thread still
  // shows the pill; visiting clears it. An unparseable visit timestamp
  // counts as never-visited — corrupt local data must not eat the wake
  // signal.
  const lastVisitedDate = lastVisitedAt === undefined ? null : parseTimestampDate(lastVisitedAt)
  const wokeAtDate = props.wokeAt === null ? null : parseTimestampDate(props.wokeAt)
  const isWoke = wokeAtDate !== null && (lastVisitedDate === null || lastVisitedDate < wokeAtDate)
  // in-flight rows (working, or waiting on approval/input) fade as a whole:
  // there is nothing for the user to do yet, so prominence is reserved for
  // rows that need a human — done (unread), read-but-unsettled, failed, and
  // freshly woken. The status label keeps its hue, so waiting rows stay
  // findable. In-flight rows recede the same as read-ready ones (inbox-zero:
  // working threads aren't your problem yet) — only the colored status label
  // stands out.
  // 'stale' is deliberately NOT in-flight: the whole point of the state is that
  // the run may be dead, so the row must not recede like work that is merely
  // not your problem yet.
  const isInFlight = status === 'working' || status === 'approval' || status === 'input'
  const shouldRecede =
    (status === 'ready' || isInFlight) && !isUnread && !isWoke && !props.isActive && !isSelected
  // status hues follow the system-wide convention set by sidebar v1 and the
  // mobile Live Activity/widgets (amber approval, indigo input, sky working)
  // so a thread reads the same color everywhere it surfaces.
  const topStatus =
    status === 'stale'
      ? {
          label: 'Stalled',
          icon: null,
          className: 'text-amber-700 dark:text-amber-300',
        }
      : status === 'working'
        ? {
            label: 'Working',
            icon: 'working' as const,
            className:
              'animate-sidebar-working-text text-sky-600 motion-reduce:animate-none dark:text-sky-400',
          }
        : status === 'approval'
          ? {
              label:
                approvalLifecycleStatus === 'unknown'
                  ? 'Approval unknown'
                  : approvalLifecycleStatus === 'responding'
                    ? 'Approval pending'
                    : 'Approval',
              icon: null,
              className: 'text-amber-700 dark:text-amber-300',
            }
          : status === 'input'
            ? {
                label: 'Input',
                icon: null,
                className: 'text-indigo-600 dark:text-indigo-300',
              }
            : status === 'failed'
              ? {
                  label: 'Failed',
                  icon: null,
                  className: 'text-red-700 dark:text-red-300',
                }
              : isWoke
                ? {
                    label: 'Woke',
                    icon: 'woke' as const,
                    className: 'text-amber-700 dark:text-amber-300',
                  }
                : isUnread
                  ? {
                      label: 'Done',
                      icon: 'done' as const,
                      className: 'text-emerald-700 dark:text-emerald-300',
                    }
                  : null

  const runWorktreePath = thread.orchestrateRunWorktreePath ?? null
  // the adopted run worktree can be pruned while the thread sits idle, and the
  // server only releases the recorded path on that thread's next turn. this probe
  // is pinned to the adopted path instead of reusing gitStatus below, whose cwd
  // moves with the resolver and would flap between the two candidates forever
  // ! this cwd must stay pinned to runWorktreePath. point it at gitCwd, or derive
  // the flag below from the resolver's output, and it never settles: dead root ->
  // isRepo false -> the chain falls back -> live root -> isRepo true -> the flag
  // clears -> dead root again
  const runWorktreeStatus = useEnvironmentQuery(
    runWorktreePath === null
      ? null
      : vcsEnvironment.status({
          environmentId: thread.environmentId,
          input: { cwd: runWorktreePath },
        }),
  )
  // one derived answer to "is the adopted tree still there", so the gate and the
  // mismatch below agree with the root the status query actually read. while the
  // probe is pending data is null, so the adopted path is kept and the row settles
  // once rather than blinking
  const runWorktreeIsNotRepository = runWorktreeStatus.data?.isRepo === false
  const effectiveRunWorktreePath = runWorktreeIsNotRepository ? null : runWorktreePath
  // a pruned run worktree answers "not a git repository" rather than failing, so
  // trusting it would leave the row reporting a clean tree for work that is still
  // sitting in the thread's own checkout
  const gitCwd = resolveThreadChangeRoot({
    orchestrateRunWorktreePath: runWorktreePath,
    worktreePath: thread.worktreePath,
    workspaceRoot: props.projectCwd,
    orchestrateRunWorktreeIsNotRepository: runWorktreeIsNotRepository,
  })
  // the gate has to widen with the resolver. an orchestrate thread carries no
  // branch and no worktree of its own, so the old condition skipped the query
  // entirely and the row showed nothing at all while the run was committing.
  // it tracks what the two consumers below actually need, so once the adopted
  // tree is gone a branchless row skips a status call nothing could have read
  const gitStatus = useEnvironmentQuery(
    (thread.branch != null || thread.worktreePath !== null || effectiveRunWorktreePath !== null) &&
      gitCwd !== null
      ? vcsEnvironment.status({
          environmentId: thread.environmentId,
          input: { cwd: gitCwd },
        })
      : null,
  )
  // resolveLocalCheckoutBranchMismatch only fires for a local checkout with no
  // worktree, and it compares thread.branch against whatever branch gitCwd is on.
  // now that gitCwd can be the run's worktree, a null-worktree thread would read
  // the run's branch and raise a mismatch against its own — a badge that is pure
  // noise. treat a run worktree as a worktree, exactly like the thread's own, but
  // only for as long as it still resolves as one: currentGitBranch below is read
  // from the resolved root, so both inputs have to describe that same tree
  const branchMismatch = resolveLocalCheckoutBranchMismatch({
    effectiveEnvMode:
      thread.worktreePath === null && effectiveRunWorktreePath === null ? 'local' : 'worktree',
    activeWorktreePath: thread.worktreePath ?? effectiveRunWorktreePath,
    activeThreadBranch: thread.branch,
    currentGitBranch: gitStatus.data?.refName ?? null,
  })
  const retainTerminalOnBranchMismatch = canRetainTerminalThreadPr({
    worktreePath: thread.worktreePath,
    orchestrateRunWorktreePath: runWorktreePath,
    orchestrateRunWorktreeIsNotRepository: runWorktreeIsNotRepository,
  })
  const pr = resolveDisplayedThreadPr({
    threadBranch: thread.branch,
    gitStatus: gitStatus.data,
    snapshot: changeRequestSnapshot,
    retainTerminalOnBranchMismatch,
  })
  const prProvider = resolveDisplayedThreadPrProvider({
    threadBranch: thread.branch,
    gitStatus: gitStatus.data,
    snapshot: changeRequestSnapshot,
    retainTerminalOnBranchMismatch,
  })
  const prStatus = prStatusIndicator(pr, prProvider)
  const settledPrHoverClass = pr ? settledPrHoverColorClass(pr.state) : undefined
  useEffect(() =>
  {
    const nextSnapshot = nextThreadChangeRequestSnapshot({
      threadBranch: thread.branch,
      gitStatus: gitStatus.data,
      snapshot: changeRequestSnapshot,
      retainTerminalOnBranchMismatch,
    })
    if (nextSnapshot !== undefined)
    {
      setThreadChangeRequestSnapshot(threadKey, nextSnapshot)
    }
    const nextObservation = nextTerminalChangeRequestObservation({
      threadBranch: thread.branch,
      gitStatus: gitStatus.data,
      displayedPr: pr,
      retainOnBranchMismatch: retainTerminalOnBranchMismatch,
    })
    if (nextObservation !== undefined)
    {
      onTerminalChangeRequestObservation?.(threadKey, nextObservation)
    }
  }, [
    changeRequestSnapshot,
    gitStatus.data,
    onTerminalChangeRequestObservation,
    pr,
    retainTerminalOnBranchMismatch,
    thread.branch,
    threadKey,
  ])

  const modelInstanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId
  const providerEntry = props.providerEntryByInstanceId.get(modelInstanceId) ?? null
  const driverKind = providerEntry?.driverKind ?? null
  const showInstanceBadge =
    providerEntry !== null &&
    shouldShowInstanceBadge(providerEntry, props.providerEntryByInstanceId.values())
  const selectedModel = providerEntry?.models.find(
    (model) => model.slug === thread.modelSelection.model,
  )
  const modelLabel = selectedModel
    ? getTriggerDisplayModelLabel(selectedModel)
    : thread.modelSelection.model
  const importedSource =
    thread.origin === null
      ? null
      : {
          displayName: importSourceDisplayName(thread.origin.source),
          driverKind: importSourceDriverKind(thread.origin.source),
        }
  const importedSourceLabel =
    importedSource === null ? null : (
      <span className="inline-flex min-w-0 items-center gap-1">
        <ProviderInstanceIcon
          driverKind={importedSource.driverKind}
          displayName={importedSource.displayName}
          iconClassName="size-3"
        />
        <span className="truncate">Imported · {importedSource.displayName}</span>
      </span>
    )

  const isRemote =
    props.currentEnvironmentId !== null && thread.environmentId !== props.currentEnvironmentId

  const detailsTooltip = (
    <SidebarV2ThreadTooltip
      thread={thread}
      projectTitle={props.projectTitle}
      projectCwd={props.projectCwd}
      environmentLabel={props.environmentLabel}
      providerEntry={providerEntry}
      showInstanceBadge={showInstanceBadge}
      modelInstanceId={modelInstanceId}
      modelLabel={modelLabel}
      branchMismatch={branchMismatch}
    />
  )

  const handleClick = useCallback(
    (event: ReactMouseEvent) =>
    {
      onThreadClick(event, threadRef)
    },
    [onThreadClick, threadRef],
  )
  const handleContextMenu = useCallback(
    (event: ReactMouseEvent) =>
    {
      event.preventDefault()
      onContextMenu(threadRef, { x: event.clientX, y: event.clientY })
    },
    [onContextMenu, threadRef],
  )
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent) =>
    {
      if (event.target !== event.currentTarget) return
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      onThreadActivate(threadRef)
    },
    [onThreadActivate, threadRef],
  )
  const handleDoubleClick = useCallback(
    (event: ReactMouseEvent) =>
    {
      if (isRenaming || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      {
        return
      }
      if ((event.target as HTMLElement).closest('button, a, input')) return
      event.preventDefault()
      onStartRename(threadRef, thread.title)
    },
    [isRenaming, onStartRename, thread.title, threadRef],
  )
  const renameCommittedRef = useRef(false)
  useEffect(() =>
  {
    if (isRenaming) renameCommittedRef.current = false
  }, [isRenaming])
  const handleRenameKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) =>
    {
      event.stopPropagation()
      if (event.nativeEvent.isComposing || event.keyCode === 229) return
      if (event.key === 'Enter')
      {
        event.preventDefault()
        renameCommittedRef.current = true
        onCommitRename(threadRef, renamingTitle, thread.title)
      }
      else if (event.key === 'Escape')
      {
        event.preventDefault()
        renameCommittedRef.current = true
        onCancelRename()
      }
    },
    [onCancelRename, onCommitRename, renamingTitle, thread.title, threadRef],
  )
  const handleRenameBlur = useCallback(() =>
  {
    if (!renameCommittedRef.current)
    {
      onCommitRename(threadRef, renamingTitle, thread.title)
    }
  }, [onCommitRename, renamingTitle, thread.title, threadRef])
  const handleSettleClick = useCallback(
    (event: ReactMouseEvent) =>
    {
      event.preventDefault()
      event.stopPropagation()
      onSettle(threadRef)
    },
    [onSettle, threadRef],
  )
  const handleUnsettleClick = useCallback(
    (event: ReactMouseEvent) =>
    {
      event.preventDefault()
      event.stopPropagation()
      onUnsettle(threadRef)
    },
    [onUnsettle, threadRef],
  )
  const handleUnsnoozeClick = useCallback(
    (event: ReactMouseEvent) =>
    {
      event.preventDefault()
      event.stopPropagation()
      onUnsnooze(threadRef)
    },
    [onUnsnooze, threadRef],
  )
  const handleSnoozePreset = useCallback(
    (preset: SnoozePreset) =>
    {
      onSnooze(threadRef, preset)
    },
    [onSnooze, threadRef],
  )
  // while the snooze popover is open the pointer leaves the row, which
  // would fade the hover actions out from under the open menu; pin them.
  const [snoozeMenuOpenRaw, setSnoozeMenuOpen] = useState(false)
  // snooze is offered only where it can succeed: capability-gated and never
  // on blocked-on-you work or queued turns (the server rejects both).
  const showSnoozeButton =
    variantAction !== 'none' &&
    props.snoozeSupported &&
    canSnooze(thread, { now: new Date().toISOString() })
  // if the thread becomes blocked while the popover is open, the button
  // unmounts without firing onOpenChange(false). Deriving the flag keeps a
  // stale true from permanently hiding the status label / pinning the
  // hover actions, and the effect clears the raw state so the popover
  // doesn't resurrect if the button later remounts.
  const snoozeMenuOpen = snoozeMenuOpenRaw && showSnoozeButton
  useEffect(() =>
  {
    if (!showSnoozeButton) setSnoozeMenuOpen(false)
  }, [showSnoozeButton])
  const handlePrClick = useCallback(
    (event: ReactMouseEvent<HTMLElement>) =>
    {
      if (pr?.url) openPrLink(event, pr.url)
    },
    [openPrLink, pr],
  )

  // all Sidebar V2 rows share one surface model. Live threads used to look
  // like elevated cards while settled threads were plain rows, leaving neither
  // a useful hierarchy nor a reliable hover cue. Status now lives in the row
  // content; surface is reserved for interaction (hover, multi-select, route).
  const rowSurfaceClassName = cn(
    'group/v2-row relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none',
    props.isActive
      ? 'bg-sidebar-row-active text-sidebar-foreground'
      : isSelected
        ? 'bg-sidebar-row-selected text-sidebar-foreground'
        : shouldRecede
          ? 'text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground'
          : 'bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover',
    isInFlight &&
      !props.isActive &&
      !isSelected &&
      'opacity-70 transition-opacity hover:opacity-100',
  )

  const title = isRenaming ? (
    <input
      autoFocus
      value={renamingTitle}
      aria-label="Thread title"
      onChange={(event) => onRenameTitleChange(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={handleRenameKeyDown}
      onBlur={handleRenameBlur}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      className="min-w-0 flex-1 rounded-sm border border-input bg-card px-1 text-sm font-medium text-card-foreground outline-none focus:border-foreground"
    />
  ) : (
    <span
      className={cn(
        'min-w-0 flex-1 text-sm',
        shouldRecede ? 'font-normal' : 'font-medium',
        variant === 'card'
          ? cn(
              'truncate',
              isUnread || isWoke
                ? 'text-foreground'
                : shouldRecede
                  ? 'text-muted-foreground/80'
                  : status === 'failed'
                    ? 'text-foreground/95'
                    : 'text-foreground/90',
            )
          : cn(
              'truncate group-hover/v2-row:text-foreground',
              props.isActive || isWoke
                ? 'text-foreground'
                : isUnread
                  ? 'text-muted-foreground'
                  : 'text-muted-foreground/70',
            ),
      )}
    >
      {thread.title}
    </span>
  )

  const prBadge =
    prStatus && pr ? (
      <button
        type="button"
        onClick={handlePrClick}
        className={cn(
          'shrink-0 font-mono text-xs hover:underline',
          variant === 'slim' && variantAction === 'unsettle'
            ? props.isActive
              ? 'text-muted-foreground/70'
              : cn('text-muted-foreground/35 transition-colors', settledPrHoverClass)
            : prStatus.colorClass,
        )}
        aria-label={prStatus.tooltip}
      >
        #{pr.number}
      </button>
    ) : null

  if (variant === 'slim')
  {
    return (
      <div role="listitem" data-thread-item className="list-none">
        <Tooltip>
          <TooltipTrigger
            render={
              <div
                role="button"
                tabIndex={0}
                data-testid="sidebar-v2-row-slim"
                className={cn(
                  rowSurfaceClassName,
                  importedSource
                    ? 'flex min-h-12 items-center gap-2.5 px-2.5 py-1.5'
                    : 'flex h-9 items-center gap-2.5 px-2.5',
                )}
                onClick={handleClick}
                onDoubleClick={handleDoubleClick}
                onKeyDown={handleKeyDown}
                onContextMenu={handleContextMenu}
              />
            }
          >
            {/* Settled history recedes: dimmed favicon at rest, restored on
              hover so the tail stays scannable when you're hunting. */}
            <span
              className={cn(
                'shrink-0 transition-opacity',
                !props.isActive &&
                  'opacity-40 grayscale group-hover/v2-row:opacity-100 group-hover/v2-row:grayscale-0',
              )}
            >
              <ProjectFavicon
                environmentId={thread.environmentId}
                cwd={props.projectCwd ?? ''}
                className="size-4"
                fallbackIcon={MessageSquareIcon}
              />
            </span>
            {importedSource ? (
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0">{title}</div>
                <div className="mt-0.5 flex min-w-0 items-center text-[11px] leading-4 text-muted-foreground/65">
                  {importedSourceLabel}
                </div>
              </div>
            ) : (
              title
            )}
            {/* The PR badge stays outside the hover-fading slot: it must
              remain visible AND clickable while the row is hovered. Only
              the time/jump label yields to the settle affordance. */}
            {prBadge}
            <span className="group/v2-actions relative ml-auto flex h-6 min-w-8 shrink-0 items-center justify-end">
              <span className="inline-flex justify-end tabular-nums text-muted-foreground/55 group-focus-within/v2-actions:opacity-0 group-hover/v2-row:opacity-0">
                {variantAction === 'unsnooze' && props.snoozeWakeLabelText !== null ? (
                  // snoozed rows show when they come BACK, not when they were
                  // last touched — the return ticket is the row's whole story.
                  <span className="text-xs text-blue-600 tabular-nums dark:text-blue-400">
                    {props.snoozeWakeLabelText}
                  </span>
                ) : isWoke ? (
                  // a wake can land straight in the settled tail (e.g. PR
                  // merged while snoozed); the signal must survive the trip.
                  <span
                    role="status"
                    aria-label="Woke from snooze"
                    className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-300"
                  >
                    <AlarmClockIcon aria-hidden className="size-3" />
                    Woke
                  </span>
                ) : (
                  <span className="text-xs">
                    {variantAction === 'unsettle'
                      ? settledTimeLabel(thread)
                      : threadTimeLabel(thread)}
                  </span>
                )}
              </span>
              {variantAction === 'unsnooze' ? (
                !props.snoozeSupported ? null : (
                  <button
                    type="button"
                    aria-label="Wake thread now"
                    onClick={handleUnsnoozeClick}
                    className="absolute inset-y-0 right-0 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-2 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/v2-row:opacity-100"
                  >
                    <AlarmClockOffIcon className="size-3" />
                  </button>
                )
              ) : variantAction === 'none' || !props.settlementSupported ? null : variantAction ===
                'unsettle' ? (
                <button
                  type="button"
                  aria-label="Un-settle thread"
                  onClick={handleUnsettleClick}
                  className="absolute inset-y-0 right-0 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-2 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/v2-row:opacity-100"
                >
                  <Undo2Icon className="size-3" />
                </button>
              ) : (
                <button
                  type="button"
                  aria-label="Settle thread"
                  onClick={handleSettleClick}
                  className="absolute inset-y-0 right-0 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-2 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/v2-row:opacity-100"
                >
                  <CheckIcon className="size-3" />
                </button>
              )}
            </span>
            {props.jumpLabel ? <JumpHintBadge label={props.jumpLabel} /> : null}
          </TooltipTrigger>
          {detailsTooltip}
        </Tooltip>
      </div>
    )
  }

  const diff = latestTurnDiff(thread)

  return (
    <div role="listitem" data-thread-item className="list-none py-0.5">
      <Tooltip>
        <TooltipTrigger
          render={
            <div
              role="button"
              tabIndex={0}
              data-testid="sidebar-v2-row-card"
              className={rowSurfaceClassName}
              onClick={handleClick}
              onDoubleClick={handleDoubleClick}
              onKeyDown={handleKeyDown}
              onContextMenu={handleContextMenu}
            />
          }
        >
          <div className="relative z-10 h-[4.875rem] px-2.5 py-2">
            <div className="flex h-5 min-w-0 items-center gap-1.5">
              <ProjectFavicon
                environmentId={thread.environmentId}
                cwd={props.projectCwd ?? ''}
                className="size-4 shrink-0"
              />
              {props.projectTitle ? (
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate text-xs text-muted-foreground/85',
                    shouldRecede ? 'font-normal' : 'font-medium',
                  )}
                >
                  {props.projectTitle}
                </span>
              ) : (
                <span className="flex-1" />
              )}
              {props.isPinned ? (
                <PinIcon
                  aria-label="Pinned"
                  role="img"
                  className="size-3 shrink-0 text-muted-foreground/65"
                />
              ) : null}
              <span className="group/v2-actions relative ml-auto flex h-5 min-w-8 shrink-0 items-center justify-end pl-1 text-xs">
                {/* hidden status text must not intercept hover actions */}
                <span
                  className={cn(
                    'pointer-events-none tabular-nums text-muted-foreground/65 group-focus-within/v2-actions:opacity-0 group-hover/v2-row:opacity-0',
                    snoozeMenuOpen && 'opacity-0',
                  )}
                >
                  {topStatus ? (
                    <span
                      className={cn(
                        'inline-flex items-center gap-1 font-medium',
                        topStatus.className,
                      )}
                    >
                      {topStatus.icon === 'working' ? (
                        <CircleDashedIcon aria-hidden className="size-4 shrink-0" />
                      ) : topStatus.icon === 'done' ? (
                        <CircleCheckIcon aria-hidden className="size-4 shrink-0" />
                      ) : topStatus.icon === 'woke' ? (
                        <AlarmClockIcon aria-hidden className="size-4 shrink-0" />
                      ) : null}
                      {/* The label alone is the live region: a role="status"
                          wrapper around the ticking duration would make
                          screen readers announce every second. */}
                      <span role="status">{topStatus.label}</span>
                      {status === 'working' ? (
                        <span aria-hidden>
                          <WorkingDuration startedAt={resolveWorkingStartedAt(thread)} />
                        </span>
                      ) : null}
                    </span>
                  ) : (
                    threadTimeLabel(thread)
                  )}
                </span>
                {props.settlementSupported || showSnoozeButton ? (
                  <span
                    className={cn(
                      'absolute inset-y-0 right-0 flex items-stretch gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/v2-row:opacity-100',
                      snoozeMenuOpen && 'opacity-100',
                    )}
                  >
                    {showSnoozeButton ? (
                      <SnoozePopoverButton
                        open={snoozeMenuOpen}
                        onOpenChange={setSnoozeMenuOpen}
                        onSnooze={handleSnoozePreset}
                      />
                    ) : null}
                    {props.settlementSupported ? (
                      <button
                        type="button"
                        aria-label="Settle thread"
                        onClick={handleSettleClick}
                        className="inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-2 text-xs text-muted-foreground hover:text-foreground"
                      >
                        <CheckIcon className="size-3" />
                        Settle
                      </button>
                    ) : null}
                  </span>
                ) : null}
              </span>
            </div>
            <div className="mt-1 flex min-w-0">{title}</div>
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground/75">
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                {importedSourceLabel}
                {importedSourceLabel && thread.branch ? (
                  <span aria-hidden className="shrink-0 text-muted-foreground/35">
                    ·
                  </span>
                ) : null}
                {thread.branch ? (
                  <span className="min-w-0 truncate whitespace-nowrap">{thread.branch}</span>
                ) : importedSourceLabel ? null : (
                  <span className="flex-1" />
                )}
              </span>
              {prBadge}
              {diff ? (
                <span className="shrink-0 font-mono">
                  <span className="text-emerald-600 dark:text-emerald-400">+{diff.insertions}</span>{' '}
                  <span className="text-red-600 dark:text-red-400">−{diff.deletions}</span>
                </span>
              ) : null}
              <span
                aria-hidden
                className="pointer-events-none ml-auto inline-flex shrink-0 items-center gap-1"
              >
                {isRemote ? (
                  <span className="inline-flex shrink-0 items-center text-sidebar-muted-foreground/70">
                    <ServerIcon aria-hidden className="size-3.5" />
                  </span>
                ) : null}
                {driverKind ? (
                  <span className="inline-flex shrink-0 items-center">
                    <ProviderInstanceIcon
                      driverKind={driverKind}
                      displayName={
                        providerEntry?.displayName ??
                        thread.session?.providerName ??
                        modelInstanceId
                      }
                      accentColor={providerEntry?.accentColor}
                      showBadge={showInstanceBadge}
                      iconClassName="size-3.5 opacity-60"
                      badgeClassName="right-[-0.1875rem] bottom-[-0.1875rem] h-3 min-w-3 px-0.5 text-[7px]"
                    />
                  </span>
                ) : null}
              </span>
            </div>
          </div>
          {props.jumpLabel ? <JumpHintBadge label={props.jumpLabel} /> : null}
        </TooltipTrigger>
        {detailsTooltip}
      </Tooltip>
    </div>
  )
})

function latestTurnDiff(
  thread: SidebarThreadSummary,
): { insertions: number; deletions: number } | null
{
  // shells don't carry checkpoint summaries; diff stats render only when the
  // shell projection grows them. Kept as a seam so the row layout is ready.
  void thread
  return null
}

export default function SidebarV2()
{
  const projects = useProjects()
  const projectOrder = useUiStateStore((store) => store.projectOrder)
  const threads = useThreadShells()
  const router = useRouter()
  const { isMobile, setOpenMobile } = useSidebar()
  const keybindings = useAtomValue(primaryServerKeybindingsAtom)
  const autoSettleAfterDays = useClientSettings((s) => s.sidebarAutoSettleAfterDays)
  const autoSettleOnMerge = useClientSettings((s) => s.sidebarAutoSettleOnMerge)
  const confirmThreadArchive = useClientSettings((s) => s.confirmThreadArchive)
  const confirmThreadDelete = useClientSettings((s) => s.confirmThreadDelete)
  const sidebarProjectSortOrder = useClientSettings((s) => s.sidebarProjectSortOrder)
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings)
  const {
    archiveThread,
    settleThread,
    unsettleThread,
    snoozeThread,
    unsnoozeThread,
    pinThread,
    unpinThread,
    deleteThread,
  } = useThreadActions()
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  })
  const deleteProject = useAtomCommand(projectEnvironment.delete, {
    reportFailure: false,
  })
  const updateProject = useAtomCommand(projectEnvironment.update, {
    reportFailure: false,
  })
  const updateSettings = useUpdateClientSettings()
  const { copyToClipboard: copyProjectPath } = useCopyToClipboard<{ path: string }>({
    onCopy: ({ path }) =>
    {
      toastManager.add({
        type: 'success',
        title: 'Path copied',
        description: path,
      })
    },
    onError: (error) =>
    {
      toastManager.add(
        stackedThreadToast({
          type: 'error',
          title: 'Failed to copy path',
          description: error instanceof Error ? error.message : 'An error occurred.',
        }),
      )
    },
  })
  const { copyToClipboard: copyThreadValue } = useCopyToClipboard<{
    label: 'Path' | 'Branch' | 'Thread ID'
    value: string
  }>({
    onCopy: ({ label, value }) =>
    {
      toastManager.add({
        type: 'success',
        title: `${label} copied`,
        description: value,
      })
    },
    onError: (error) =>
    {
      toastManager.add(
        stackedThreadToast({
          type: 'error',
          title: 'Failed to copy thread value',
          description: error instanceof Error ? error.message : 'An error occurred.',
        }),
      )
    },
  })
  const [projectActionsTarget, setProjectActionsTarget] = useState<SidebarProjectSnapshot | null>(
    null,
  )
  const [projectScopeMenuOpen, setProjectScopeMenuOpen] = useState(false)
  const newThreadContext = useHandleNewThread()
  const openAddProjectCommandPalette = useCallback(
    () => openCommandPalette({ open: 'add-project' }),
    [],
  )
  const { environments } = useEnvironments()
  const primaryEnvironmentId = usePrimaryEnvironmentId()
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection)
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor)
  const toggleThreadSelection = useThreadSelectionStore((s) => s.toggleThread)
  const rangeSelectTo = useThreadSelectionStore((s) => s.rangeSelectTo)
  const markThreadUnread = useUiStateStore((s) => s.markThreadUnread)
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  })
  const routeThreadRef = routeTarget?.kind === 'server' ? routeTarget.threadRef : null
  const routeThreadKey = routeThreadRef ? scopedThreadKey(routeThreadRef) : null
  const routeTargetRef = useRef(routeTarget)
  routeTargetRef.current = routeTarget
  // post-settle navigation validates against the CURRENT route, not the one
  // captured when the settle started: if the user navigated elsewhere while
  // the command was in flight, completing it must not yank them away.
  const routeThreadKeyRef = useRef(routeThreadKey)
  routeThreadKeyRef.current = routeThreadKey

  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  )
  const orderedProjects = useMemo(
    () =>
      orderItemsByPreferredIds({
        items: projects,
        preferredIds: projectOrder,
        getId: getProjectOrderKey,
        getPreferenceIds: (project) => [
          getProjectOrderKey(project),
          legacyProjectCwdPreferenceKey(project.workspaceRoot),
        ],
      }),
    [projectOrder, projects],
  )
  const unsortedProjectGroups = useMemo(
    () =>
      buildSidebarProjectSnapshots({
        projects: sidebarProjectSortOrder === 'manual' ? orderedProjects : projects,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
        resolveEnvironmentLabel: (environmentId) => environmentLabelById.get(environmentId) ?? null,
      }),
    [
      environmentLabelById,
      orderedProjects,
      primaryEnvironmentId,
      projectGroupingSettings,
      projects,
      sidebarProjectSortOrder,
    ],
  )
  const projectGroups = useMemo(
    () => sortLogicalProjectsForSidebar(unsortedProjectGroups, threads, sidebarProjectSortOrder),
    [sidebarProjectSortOrder, threads, unsortedProjectGroups],
  )
  const projectCwdByKey = useMemo(
    () =>
      new Map(
        projects.map((project) => [
          `${project.environmentId}:${project.id}`,
          project.workspaceRoot,
        ]),
      ),
    [projects],
  )
  const projectDisplayNameByKey = useMemo(
    () =>
      new Map(
        projectGroups.flatMap((group) =>
          group.memberProjects.map(
            (project) => [`${project.environmentId}:${project.id}`, group.displayName] as const,
          ),
        ),
      ),
    [projectGroups],
  )

  // now is quantized to the minute so effectiveSettled memoization doesn't
  // churn on every render; auto-settle thresholds are day-granular anyway.
  const nowMinute = useNowMinute()
  // snooze wake times are second-precise, so classifying with the quantized
  // minute would hold a woken thread on the shelf for up to a minute. The
  // tick is a plain counter bumped exactly at the next wake boundary (armed
  // below, after the partition knows the boundary); the partition reads a
  // fresh clock whenever it recomputes.
  const [snoozeWakeTick, bumpSnoozeWakeTick] = useState(0)

  // terminal PR states stream in per-row because rows own the VCS probes;
  // pending remounts preserve, while authoritative open/no-PR results clear.
  const [terminalChangeRequestObservationByKey, setTerminalChangeRequestObservationByKey] =
    useState<ReadonlyMap<string, TerminalChangeRequestObservation>>(() => new Map())
  const handleTerminalChangeRequestObservation = useCallback(
    (threadKey: string, observation: TerminalChangeRequestObservation | null) =>
    {
      setTerminalChangeRequestObservationByKey((current) =>
      {
        const existing = current.get(threadKey)
        if (observation === null)
        {
          if (existing === undefined) return current
          const next = new Map(current)
          next.delete(threadKey)
          return next
        }
        if (
          existing?.state === observation.state &&
          existing.branch === observation.branch &&
          existing.updatedAt === observation.updatedAt &&
          existing.retainOnBranchMismatch === observation.retainOnBranchMismatch
        )
        {
          return current
        }
        const next = new Map(current)
        next.set(threadKey, observation)
        return next
      })
    },
    [],
  )
  const changeRequestSnapshotByKey = useAtomValue(threadChangeRequestSnapshotsAtom)

  // project scope: one menu above the list. Scoping filters the list without
  // making the header width depend on the number or length of project names.
  const [projectScopeKey, setProjectScopeKey] = useState<string | null>(null)
  const scopedProjectGroup = useMemo(
    () =>
      projectScopeKey === null
        ? null
        : (projectGroups.find((project) => project.projectKey === projectScopeKey) ?? null),
    [projectGroups, projectScopeKey],
  )
  const scopedProjectKeys = useMemo(
    () =>
      scopedProjectGroup === null
        ? null
        : new Set(
            scopedProjectGroup.memberProjectRefs.map(
              (projectRef) => `${projectRef.environmentId}:${projectRef.projectId}`,
            ),
          ),
    [scopedProjectGroup],
  )
  useEffect(() =>
  {
    if (projectScopeKey !== null && scopedProjectGroup === null)
    {
      setProjectScopeKey(null)
    }
  }, [projectScopeKey, scopedProjectGroup])
  // scope flips drop the selection: rows selected under the old scope may be
  // hidden now, and bulk actions must never count or touch invisible rows.
  useEffect(() =>
  {
    clearSelection()
  }, [clearSelection, projectScopeKey])

  const handleRemoveProjectMembers = useCallback(
    async (projectGroup: SidebarProjectSnapshot, members: readonly SidebarProjectGroupMember[]) =>
    {
      const api = readLocalApi()
      if (!api) return

      const memberKeys = new Set(members.map((member) => `${member.environmentId}:${member.id}`))
      const projectThreads = threads.filter((thread) =>
        memberKeys.has(`${thread.environmentId}:${thread.projectId}`),
      )
      const isWholeGroup = members.length === projectGroup.memberProjects.length
      const singleMember = members.length === 1 ? members[0]! : null
      const targetLabel = singleMember?.title ?? projectGroup.displayName
      const confirmed = await settlePromise(() =>
        api.dialogs.confirm(
          projectThreads.length > 0
            ? [
                `Remove project "${targetLabel}" and delete its ${projectThreads.length} thread${projectThreads.length === 1 ? '' : 's'}?`,
                ...(singleMember
                  ? [
                      `Path: ${singleMember.workspaceRoot}`,
                      ...(singleMember.environmentLabel
                        ? [`Environment: ${singleMember.environmentLabel}`]
                        : []),
                    ]
                  : [`This removes ${members.length} grouped project entries.`]),
                'This permanently clears conversation history for those threads.',
                isWholeGroup
                  ? 'This removes only the project entries, not the files on disk.'
                  : 'Other entries in this grouped project are unaffected.',
                'This action cannot be undone.',
              ].join('\n')
            : [
                `Remove project "${targetLabel}"?`,
                ...(singleMember
                  ? [
                      `Path: ${singleMember.workspaceRoot}`,
                      ...(singleMember.environmentLabel
                        ? [`Environment: ${singleMember.environmentLabel}`]
                        : []),
                    ]
                  : [`This removes ${members.length} grouped project entries.`]),
                isWholeGroup
                  ? 'This removes only the project entries, not the files on disk.'
                  : 'Other entries in this grouped project are unaffected.',
              ].join('\n'),
        ),
      )
      if (confirmed._tag === 'Failure' || !confirmed.value) return

      const draftStore = useComposerDraftStore.getState()
      let shouldNavigate = false
      for (const project of members)
      {
        const memberThreads = projectThreads.filter(
          (thread) =>
            thread.environmentId === project.environmentId && thread.projectId === project.id,
        )
        const projectRef = scopeProjectRef(project.environmentId, project.id)
        const projectDraftThread = draftStore.getDraftThreadByProjectRef(projectRef)
        const memberRemovalNeedsNavigation = shouldNavigateAfterProjectRemoval({
          routeTarget: routeTargetRef.current,
          projectThreads: memberThreads,
          projectDraftId: projectDraftThread?.draftId ?? null,
        })

        const result = await deleteProject({
          environmentId: project.environmentId,
          input: {
            projectId: project.id,
            ...(memberThreads.length > 0 ? { force: true } : {}),
          },
        })
        if (result._tag === 'Failure')
        {
          if (!isAtomCommandInterrupted(result))
          {
            const error = squashAtomCommandFailure(result)
            toastManager.add(
              stackedThreadToast({
                type: 'error',
                title: `Failed to remove "${project.title}"`,
                description: error instanceof Error ? error.message : 'An error occurred.',
              }),
            )
          }
          if (shouldNavigate)
          {
            void router.navigate({ to: '/' })
          }
          return
        }

        shouldNavigate ||= memberRemovalNeedsNavigation
        if (projectDraftThread)
        {
          draftStore.clearDraftThread(projectDraftThread.draftId)
        }
        draftStore.clearProjectDraftThreadId(projectRef)
      }

      if (shouldNavigate)
      {
        void router.navigate({ to: '/' })
      }
    },
    [deleteProject, router, threads],
  )

  const renameProjectMember = useCallback(
    async (member: SidebarProjectGroupMember, nextTitle: string) =>
    {
      const title = nextTitle.trim()
      if (!title)
      {
        toastManager.add({ type: 'warning', title: 'Project title cannot be empty' })
        return
      }
      if (title === member.title) return
      const result = await updateProject({
        environmentId: member.environmentId,
        input: { projectId: member.id, title },
      })
      if (result._tag === 'Failure' && !isAtomCommandInterrupted(result))
      {
        const error = squashAtomCommandFailure(result)
        toastManager.add(
          stackedThreadToast({
            type: 'error',
            title: 'Failed to rename project',
            description: error instanceof Error ? error.message : 'An error occurred.',
          }),
        )
      }
    },
    [updateProject],
  )

  const updateProjectGroupingPreference = useCallback(
    (member: SidebarProjectGroupMember, selection: SidebarProjectGroupingMode | 'inherit') =>
    {
      const overrideKey = deriveProjectGroupingOverrideKey(member)
      const nextOverrides = { ...projectGroupingSettings.sidebarProjectGroupingOverrides }
      if (selection === 'inherit')
      {
        delete nextOverrides[overrideKey]
      }
      else
      {
        nextOverrides[overrideKey] = selection
      }
      updateSettings({ sidebarProjectGroupingOverrides: nextOverrides })
    },
    [projectGroupingSettings.sidebarProjectGroupingOverrides, updateSettings],
  )

  const handleProjectActions = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>, projectGroup: SidebarProjectSnapshot) =>
    {
      event.preventDefault()
      event.stopPropagation()
      setProjectScopeMenuOpen(false)
      window.requestAnimationFrame(() => setProjectActionsTarget(projectGroup))
    },
    [],
  )

  // settled threads stay in the live shell stream (settled ≠ archived), so
  // the partition works directly off live shells: no archived-snapshot
  // merging, no optimistic holds. Archived threads remain hidden here —
  // archive keeps its original "remove from sidebar" meaning.
  const serverConfigs = useAtomValue(environmentServerConfigsAtom)
  // threads on non-primary environments resolve their provider entry from
  // their own environment's config: default instance ids are driver slugs,
  // so a flat map would collide across environments.
  const providerEntriesByEnvironment = useMemo(
    () =>
      deriveProviderEntriesByEnvironment(
        [...serverConfigs].map(([environmentId, config]) => [environmentId, config.providers]),
      ),
    [serverConfigs],
  )
  const hasArchitectureServerThread = newThreadContext.activeThread !== null
  const activeArchitectureEnvironmentId = newThreadContext.activeThread?.environmentId ?? null
  const activeArchitectureProjectId = newThreadContext.activeThread?.projectId ?? null
  const activeArchitectureThreadRef = newThreadContext.activeThread
    ? scopeThreadRef(newThreadContext.activeThread.environmentId, newThreadContext.activeThread.id)
    : null
  const handleOpenProjectArchitecture = useCallback(
    (member: SidebarProjectGroupMember) =>
    {
      if (
        activeArchitectureThreadRef === null ||
        activeArchitectureEnvironmentId !== member.environmentId ||
        activeArchitectureProjectId !== member.id ||
        serverConfigs.get(member.environmentId)?.environment.capabilities.architectureImpact !==
          true
      )
      {
        return
      }
      useRightPanelStore.getState().open(activeArchitectureThreadRef, 'repository-atlas-home')
      setProjectActionsTarget(null)
    },
    [
      activeArchitectureEnvironmentId,
      activeArchitectureProjectId,
      activeArchitectureThreadRef,
      serverConfigs,
    ],
  )
  const threadSections = useMemo(
    function partitionThreads()
    {
      const now = `${nowMinute}:00.000Z`
      // snooze classification uses a REAL clock, not the quantized minute:
      // wake times are second-precise and a woken thread must not linger on
      // the shelf for the rest of the minute. snoozeWakeTick re-runs this
      // memo exactly at the next wake boundary.
      void snoozeWakeTick
      const preciseNow = new Date().toISOString()
      const visible = threads.filter(
        (thread) =>
          thread.archivedAt === null &&
          (scopedProjectKeys === null ||
            scopedProjectKeys.has(`${thread.environmentId}:${thread.projectId}`)),
      )
      const pinned: EnvironmentThreadShell[] = []
      const active: EnvironmentThreadShell[] = []
      const imported: EnvironmentThreadShell[] = []
      const snoozed: EnvironmentThreadShell[] = []
      const settled: EnvironmentThreadShell[] = []
      for (const thread of visible)
      {
        if (isImportedShelfThread(thread))
        {
          imported.push(thread)
          continue
        }
        // threads on servers without the settlement capability (old server,
        // or descriptor not loaded yet) never classify as settled: the user
        // could neither un-settle nor pin them, so auto-settling them would
        // strand rows in a tail with no working affordances.
        const supportsSettlement =
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSettlement ===
          true
        const supportsSnooze =
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSnooze === true
        const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
        const snapshot = changeRequestSnapshotByKey.get(threadKey)
        const observation = terminalChangeRequestObservationByKey.get(threadKey)
        const observedTerminalChangeRequest =
          thread.branch !== null &&
          observation !== undefined &&
          (observation.retainOnBranchMismatch || observation.branch === thread.branch)
            ? { state: observation.state, updatedAt: observation.updatedAt }
            : null
        // raw adopted paths stay conservative until their row's pinned probe
        // proves the path is gone; that terminal-only observation then wins.
        const cachedTerminalChangeRequest =
          thread.branch !== null &&
          snapshot !== undefined &&
          thread.worktreePath === null &&
          thread.orchestrateRunWorktreePath == null
            ? { state: snapshot.pr.state, updatedAt: snapshot.pr.updatedAt }
            : null
        const changeRequest = observedTerminalChangeRequest ?? cachedTerminalChangeRequest
        const lifecycleSection = resolveSidebarV2LifecycleSection({
          snoozed: supportsSnooze && effectiveSnoozed(thread, { now: preciseNow }),
          pinned: thread.pinnedAt != null,
          settled:
            supportsSettlement &&
            effectiveSettled(thread, {
              now,
              autoSettleAfterDays,
              autoSettleOnMerge,
              changeRequest,
            }),
        })
        if (lifecycleSection === 'snoozed')
        {
          snoozed.push(thread)
        }
        else if (lifecycleSection === 'pinned')
        {
          pinned.push(thread)
        }
        else if (lifecycleSection === 'settled')
        {
          settled.push(thread)
        }
        else
        {
          active.push(thread)
        }
      }
      return {
        pinnedThreads: sortThreadsForSidebarV2(pinned),
        activeThreads: sortThreadsForSidebarV2(active),
        importedThreads: imported.toSorted(
          (left, right) =>
            right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
        ),
        // soonest wake first: "what comes back next" is the shelf's question.
        snoozedThreads: snoozed.toSorted(
          (left, right) =>
            firstValidTimestampMs(left.snoozedUntil ?? null) -
            firstValidTimestampMs(right.snoozedUntil ?? null),
        ),
        settledThreads: sortSettledThreadsForSidebarV2(settled),
        snoozeNow: preciseNow,
      }
    },
    [
      autoSettleAfterDays,
      autoSettleOnMerge,
      changeRequestSnapshotByKey,
      terminalChangeRequestObservationByKey,
      nowMinute,
      scopedProjectKeys,
      serverConfigs,
      snoozeWakeTick,
      threads,
    ],
  )
  const {
    pinnedThreads,
    activeThreads,
    importedThreads,
    snoozedThreads,
    settledThreads,
    snoozeNow,
  } = threadSections

  // arm a timeout for the earliest upcoming wake so the shelf empties the
  // moment a snooze expires instead of on the next minute tick. Sorted
  // soonest-first, so entry 0 is the boundary.
  useEffect(() =>
  {
    const nextWakeAtMs =
      snoozedThreads.length > 0 && snoozedThreads[0]?.snoozedUntil != null
        ? Date.parse(snoozedThreads[0].snoozedUntil)
        : Number.NaN
    if (Number.isNaN(nextWakeAtMs)) return
    // setTimeout delays are signed 32-bit: anything larger overflows and
    // fires immediately, turning a far-future wake (event-condition snoozes
    // synced from elsewhere) into a tight re-arm loop. Clamped, the timer
    // just re-arms every ~24.8 days until the wake is in range.
    const delayMs = Math.min(Math.max(0, nextWakeAtMs - Date.now()) + 50, 2_147_483_647)
    const id = window.setTimeout(() => bumpSnoozeWakeTick((tick) => tick + 1), delayMs)
    return () => window.clearTimeout(id)
  }, [snoozedThreads])

  // the settled tail renders in pages: history shouldn't dominate the
  // sidebar, and the common lookups are recent. Expansion resets when the
  // filter context changes so a scope/search flip never inherits a deep
  // page state.
  const [settledVisibleCount, setSettledVisibleCount] = useState(SETTLED_TAIL_INITIAL_COUNT)
  const settledResetKey = projectScopeKey ?? 'all'
  const lastSettledResetKeyRef = useRef(settledResetKey)
  if (lastSettledResetKeyRef.current !== settledResetKey)
  {
    lastSettledResetKeyRef.current = settledResetKey
    setSettledVisibleCount(SETTLED_TAIL_INITIAL_COUNT)
  }
  const visibleSettledThreads = useMemo(() =>
  {
    if (settledThreads.length <= settledVisibleCount) return settledThreads
    const visible = settledThreads.slice(0, settledVisibleCount)
    // the open thread must never hide under "Show more": navigating into a
    // deep settled thread (search, deep link) pulls its row into the visible
    // tail so the highlight and the un-settle affordance stay reachable.
    if (routeThreadKey !== null)
    {
      const routeThread = settledThreads
        .slice(settledVisibleCount)
        .find(
          (thread) =>
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeThreadKey,
        )
      if (routeThread !== undefined) visible.push(routeThread)
    }
    return visible
  }, [routeThreadKey, settledThreads, settledVisibleCount])
  const hiddenSettledCount = settledThreads.length - visibleSettledThreads.length
  const showMoreSettled = useCallback(
    () => setSettledVisibleCount((count) => count + SETTLED_TAIL_PAGE_COUNT),
    [],
  )
  const [settledShelfExpanded, setSettledShelfExpanded] = useState(true)
  const toggleSettledShelf = useCallback(() => setSettledShelfExpanded((value) => !value), [])
  const renderedSettledThreads = useMemo(() =>
  {
    if (settledShelfExpanded) return visibleSettledThreads
    if (routeThreadKey === null) return []
    const routeThread = visibleSettledThreads.find(
      (thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeThreadKey,
    )
    return routeThread === undefined ? [] : [routeThread]
  }, [routeThreadKey, settledShelfExpanded, visibleSettledThreads])

  // the snoozed shelf is collapsed by default: out of the way, never gone.
  // collapsed threads don't render (and so don't participate in jump
  // shortcuts or multi-select), matching the settled tail's paging model.
  const [snoozedShelfExpanded, setSnoozedShelfExpanded] = useState(false)
  const toggleSnoozedShelf = useCallback(() => setSnoozedShelfExpanded((value) => !value), [])
  const visibleSnoozedThreads = useMemo(() =>
  {
    if (snoozedShelfExpanded) return snoozedThreads
    // the open thread must never vanish behind the collapsed shelf: a
    // snoozed thread reached by route (deep link, open before snoozing
    // elsewhere) keeps its row — with highlight and wake affordance — same
    // exception the settled tail's "Show more" makes.
    if (routeThreadKey === null) return []
    const routeThread = snoozedThreads.find(
      (thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeThreadKey,
    )
    return routeThread === undefined ? [] : [routeThread]
  }, [routeThreadKey, snoozedShelfExpanded, snoozedThreads])

  const [importedShelfExpanded, setImportedShelfExpanded] = useState(false)
  const toggleImportedShelf = useCallback(() => setImportedShelfExpanded((value) => !value), [])
  const visibleImportedThreads = useMemo(() =>
  {
    if (importedShelfExpanded) return importedThreads
    if (routeThreadKey === null) return []
    const routeThread = importedThreads.find(
      (thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeThreadKey,
    )
    return routeThread === undefined ? [] : [routeThread]
  }, [importedShelfExpanded, importedThreads, routeThreadKey])

  const orderedThreads = useMemo(
    () => [
      ...pinnedThreads,
      ...activeThreads,
      ...visibleImportedThreads,
      ...visibleSnoozedThreads,
      ...renderedSettledThreads,
    ],
    [
      activeThreads,
      pinnedThreads,
      renderedSettledThreads,
      visibleImportedThreads,
      visibleSnoozedThreads,
    ],
  )
  const orderedThreadKeys = useMemo(
    () =>
      orderedThreads.map((thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      ),
    [orderedThreads],
  )
  // rows call back into the click handler without carrying the ordered list as
  // a prop — a fresh array identity per shell update would defeat every row's
  // memoization. The ref keeps shift-range-select working against the list as
  // rendered at click time.
  const orderedThreadKeysRef = useRef(orderedThreadKeys)
  orderedThreadKeysRef.current = orderedThreadKeys
  const threadByKey = useMemo(
    () =>
      new Map(
        orderedThreads.map(
          (thread) =>
            [scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread] as const,
        ),
      ),
    [orderedThreads],
  )
  // handlers read these through refs: depending on per-update Map/Set
  // identities would give every row a fresh callback prop on each shell
  // event and defeat row memoization during streaming.
  const threadByKeyRef = useRef(threadByKey)
  threadByKeyRef.current = threadByKey
  // handleNewThread is inherently unstable (depends on the projects list);
  // a ref keeps it out of attemptSettle's dependency array.
  const handleNewThreadRef = useRef(newThreadContext.handleNewThread)
  handleNewThreadRef.current = newThreadContext.handleNewThread
  const settledThreadKeys = useMemo(
    () =>
      new Set(
        settledThreads.map((thread) =>
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        ),
      ),
    [settledThreads],
  )
  const settledThreadKeysRef = useRef(settledThreadKeys)
  settledThreadKeysRef.current = settledThreadKeys
  const snoozedThreadKeys = useMemo(
    () =>
      new Set(
        snoozedThreads.map((thread) =>
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        ),
      ),
    [snoozedThreads],
  )
  const snoozedThreadKeysRef = useRef(snoozedThreadKeys)
  snoozedThreadKeysRef.current = snoozedThreadKeys

  const jumpLabelByKey = useMemo(() =>
  {
    const mapping = new Map<string, string>()
    for (const [index, threadKey] of orderedThreadKeys.entries())
    {
      const jumpCommand = threadJumpCommandForIndex(index)
      if (!jumpCommand) break
      const label = shortcutLabelForCommand(keybindings, jumpCommand)
      if (label) mapping.set(threadKey, label)
    }
    return mapping
  }, [keybindings, orderedThreadKeys])
  const [showJumpHints, setShowJumpHints] = useState(false)

  // settled threads are live shells, so opening one is plain navigation:
  // history stays readable without un-settling, and sending a message or
  // starting a session un-settles server-side.
  const navigateToThread = useCallback(
    (threadRef: ScopedThreadRef) =>
    {
      if (useThreadSelectionStore.getState().selectedThreadKeys.size > 0)
      {
        clearSelection()
      }
      setSelectionAnchor(scopedThreadKey(threadRef))
      if (isMobile)
      {
        setOpenMobile(false)
      }
      void router.navigate({
        to: '/$environmentId/$threadId',
        params: buildThreadRouteParams(threadRef),
      })
    },
    [clearSelection, isMobile, router, setOpenMobile, setSelectionAnchor],
  )

  const [renamingThreadKey, setRenamingThreadKey] = useState<string | null>(null)
  const [renamingTitle, setRenamingTitle] = useState('')
  const startThreadRename = useCallback((threadRef: ScopedThreadRef, title: string) =>
  {
    setRenamingThreadKey(scopedThreadKey(threadRef))
    setRenamingTitle(title)
  }, [])
  const cancelThreadRename = useCallback(() => setRenamingThreadKey(null), [])
  const commitThreadRename = useCallback(
    (threadRef: ScopedThreadRef, title: string, originalTitle: string) =>
    {
      void (async () =>
      {
        const trimmed = title.trim()
        setRenamingThreadKey(null)
        if (trimmed.length === 0)
        {
          toastManager.add({ type: 'warning', title: 'Thread title cannot be empty' })
          return
        }
        if (trimmed === originalTitle) return
        const result = await updateThreadMetadata({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, title: trimmed },
        })
        if (result._tag === 'Failure' && !isAtomCommandInterrupted(result))
        {
          const error = squashAtomCommandFailure(result)
          toastManager.add(
            stackedThreadToast({
              type: 'error',
              title: 'Failed to rename thread',
              description: error instanceof Error ? error.message : 'An error occurred.',
            }),
          )
        }
      })()
    },
    [updateThreadMetadata],
  )

  const handleThreadClick = useCallback(
    (event: ReactMouseEvent, threadRef: ScopedThreadRef) =>
    {
      const isMac = isMacPlatform(navigator.platform)
      const isModClick = isMac ? event.metaKey : event.ctrlKey
      const threadKey = scopedThreadKey(threadRef)
      if (isModClick)
      {
        event.preventDefault()
        toggleThreadSelection(threadKey)
        return
      }
      if (event.shiftKey)
      {
        event.preventDefault()
        rangeSelectTo(threadKey, orderedThreadKeysRef.current)
        return
      }
      if (isTrailingDoubleClick(event.detail))
      {
        return
      }
      navigateToThread(threadRef)
    },
    [navigateToThread, rangeSelectTo, toggleThreadSelection],
  )

  // a settle per thread at a time: double clicks and repeated menu picks
  // must not dispatch a second settle that fails and toasts a false error.
  const settlingThreadKeysRef = useRef(new Set<string>())
  // parking the thread you're looking at (settle or snooze) moves you
  // forward: the next remaining card (never a settled or snoozed row, never
  // one leaving in the same batch), or a fresh draft in this project when it
  // was the last active one. Callers snapshot the plan BEFORE the command
  // mutates the partition; background parks never navigate (null plan).
  const planForwardNavigation = useCallback(
    (threadKey: string, coParkingKeys?: ReadonlySet<string>): (() => void) | null =>
    {
      if (routeThreadKeyRef.current !== threadKey) return null
      const shell = threadByKeyRef.current.get(threadKey)
      const orderedKeys = orderedThreadKeysRef.current
      const settledKeys = settledThreadKeysRef.current
      const snoozedKeys = snoozedThreadKeysRef.current
      const currentIndex = orderedKeys.indexOf(threadKey)
      const nextCardKey =
        currentIndex === -1
          ? null
          : ([...orderedKeys.slice(currentIndex + 1), ...orderedKeys.slice(0, currentIndex)].find(
              (key) => !settledKeys.has(key) && !snoozedKeys.has(key) && !coParkingKeys?.has(key),
            ) ?? null)
      const nextThread = nextCardKey ? threadByKeyRef.current.get(nextCardKey) : null
      return nextThread
        ? () => navigateToThread(scopeThreadRef(nextThread.environmentId, nextThread.id))
        : shell
          ? () =>
              void handleNewThreadRef.current(scopeProjectRef(shell.environmentId, shell.projectId))
          : () => void router.navigate({ to: '/' })
    },
    [navigateToThread, router],
  )

  const attemptSettle = useCallback(
    (threadRef: ScopedThreadRef, opts: { coSettlingKeys?: ReadonlySet<string> } = {}) =>
    {
      void (async () =>
      {
        const threadKey = scopedThreadKey(threadRef)
        if (settlingThreadKeysRef.current.has(threadKey)) return
        settlingThreadKeysRef.current.add(threadKey)
        try
        {
          const navigateAfterSettle = planForwardNavigation(threadKey, opts.coSettlingKeys)
          const result = await settleThread(threadRef)
          if (result._tag === 'Failure')
          {
            // never navigate away from a thread that did not settle.
            if (!isAtomCommandInterrupted(result))
            {
              const error = squashAtomCommandFailure(result)
              toastManager.add(
                stackedThreadToast({
                  type: 'error',
                  title: 'Failed to settle thread',
                  description: error instanceof Error ? error.message : 'An error occurred.',
                }),
              )
            }
            return
          }
          // only move forward if the user is still on the settled thread —
          // a navigation made during the await wins over ours.
          if (routeThreadKeyRef.current === threadKey)
          {
            navigateAfterSettle?.()
          }
        }
        finally
        {
          settlingThreadKeysRef.current.delete(threadKey)
        }
      })()
    },
    [planForwardNavigation, settleThread],
  )
  const attemptUnsettle = useCallback(
    (threadRef: ScopedThreadRef) =>
    {
      void (async () =>
      {
        const result = await unsettleThread(threadRef)
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
      })()
    },
    [unsettleThread],
  )
  const attemptPin = useCallback(
    (threadRef: ScopedThreadRef) =>
    {
      void (async () =>
      {
        const result = await pinThread(threadRef)
        if (result._tag === 'Failure' && !isAtomCommandInterrupted(result))
        {
          const error = squashAtomCommandFailure(result)
          toastManager.add(
            stackedThreadToast({
              type: 'error',
              title: 'Failed to pin thread',
              description: error instanceof Error ? error.message : 'An error occurred.',
            }),
          )
        }
      })()
    },
    [pinThread],
  )
  const attemptUnpin = useCallback(
    (threadRef: ScopedThreadRef) =>
    {
      void (async () =>
      {
        const result = await unpinThread(threadRef)
        if (result._tag === 'Failure' && !isAtomCommandInterrupted(result))
        {
          const error = squashAtomCommandFailure(result)
          toastManager.add(
            stackedThreadToast({
              type: 'error',
              title: 'Failed to unpin thread',
              description: error instanceof Error ? error.message : 'An error occurred.',
            }),
          )
        }
      })()
    },
    [unpinThread],
  )
  const attemptUnsnooze = useCallback(
    (threadRef: ScopedThreadRef) =>
    {
      void (async () =>
      {
        const result = await unsnoozeThread(threadRef)
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
      })()
    },
    [unsnoozeThread],
  )
  // one snooze per thread at a time — same double-dispatch guard as settle.
  const snoozingThreadKeysRef = useRef(new Set<string>())
  const attemptSnooze = useCallback(
    (
      threadRef: ScopedThreadRef,
      preset: SnoozePreset,
      opts: { coSnoozingKeys?: ReadonlySet<string> } = {},
    ) =>
    {
      void (async () =>
      {
        const threadKey = scopedThreadKey(threadRef)
        if (snoozingThreadKeysRef.current.has(threadKey)) return
        snoozingThreadKeysRef.current.add(threadKey)
        try
        {
          // snoozing the open thread moves you forward, same as settle —
          // both park the thread you're done with for now.
          const navigateAfterSnooze = planForwardNavigation(threadKey, opts.coSnoozingKeys)
          const result = await snoozeThread(threadRef, preset.snoozedUntil)
          if (result._tag === 'Failure')
          {
            // never navigate away from a thread that did not snooze.
            if (!isAtomCommandInterrupted(result))
            {
              const error = squashAtomCommandFailure(result)
              toastManager.add(
                stackedThreadToast({
                  type: 'error',
                  title: 'Failed to snooze thread',
                  description: error instanceof Error ? error.message : 'An error occurred.',
                }),
              )
            }
            return
          }
          // snooze hides the row, so the toast is the only confirmation —
          // and the Undo is the escape hatch for a mis-click.
          toastManager.add(
            stackedThreadToast({
              type: 'success',
              title: `Snoozed until ${snoozeWakeDescription(preset.snoozedUntil, new Date())}`,
              timeout: 5_000,
              actionProps: {
                children: 'Undo',
                onClick: () => attemptUnsnooze(threadRef),
              },
            }),
          )
          // only move forward if the user is still on the snoozed thread —
          // a navigation made during the await wins over ours.
          if (routeThreadKeyRef.current === threadKey)
          {
            navigateAfterSnooze?.()
          }
        }
        finally
        {
          snoozingThreadKeysRef.current.delete(threadKey)
        }
      })()
    },
    [attemptUnsnooze, planForwardNavigation, snoozeThread],
  )

  const removeFromSelection = useThreadSelectionStore((s) => s.removeFromSelection)
  const handleMultiSelectContextMenu = useCallback(
    async (position: { x: number; y: number }) =>
    {
      const api = readLocalApi()
      if (!api) return
      // one exact actionable set: keys whose rows are actually rendered
      // right now. Selections can outlive their rows (settled-tail paging,
      // thread deletion elsewhere) and the menu labels must count only what
      // the actions will touch.
      const threadKeys = [...useThreadSelectionStore.getState().selectedThreadKeys].filter(
        (threadKey) => threadByKeyRef.current.has(threadKey),
      )
      if (threadKeys.length === 0) return
      const count = threadKeys.length
      // snooze (N) is offered when every selected thread can actually take
      // it — a mixed selection with blocked-on-you work would half-apply.
      const selectionNow = new Date().toISOString()
      const snoozableThreads = threadKeys.flatMap((threadKey) =>
      {
        const thread = threadByKeyRef.current.get(threadKey)
        return thread ? [thread] : []
      })
      const includesImportedShelfThread = snoozableThreads.some(isImportedShelfThread)
      const canSnoozeSelection = snoozableThreads.every(
        (thread) =>
          !isImportedShelfThread(thread) &&
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSnooze === true &&
          canSnooze(thread, { now: selectionNow }),
      )
      const snoozePresets = resolveSnoozePresets(new Date())
      const clicked = await settlePromise(() =>
        api.contextMenu.show(
          [
            ...(!includesImportedShelfThread ? [{ id: 'settle', label: `Settle (${count})` }] : []),
            ...(canSnoozeSelection
              ? [
                  {
                    id: 'snooze',
                    label: `Snooze (${count})`,
                    children: snoozePresets.map((preset) => ({
                      id: `snooze:${preset.id}`,
                      label: `${preset.label} (${preset.whenLabel})`,
                    })),
                  },
                ]
              : []),
            { id: 'mark-unread', label: `Mark unread (${count})` },
            { id: 'delete', label: `Delete (${count})`, destructive: true },
          ],
          position,
        ),
      )
      if (clicked._tag === 'Failure') return
      if (clicked.value?.startsWith('snooze:'))
      {
        const preset = snoozePresets.find((candidate) => `snooze:${candidate.id}` === clicked.value)
        if (preset)
        {
          // post-snooze navigation must skip threads snoozing in this same
          // batch — they are all leaving the card block together.
          const coSnoozingKeys = new Set(threadKeys)
          for (const thread of snoozableThreads)
          {
            attemptSnooze(scopeThreadRef(thread.environmentId, thread.id), preset, {
              coSnoozingKeys,
            })
          }
          clearSelection()
        }
        return
      }
      if (clicked.value === 'settle')
      {
        // post-settle navigation must skip threads settling in this same
        // batch — they are all leaving the card block together. Rows that
        // are already explicitly settled are skipped: nothing to do on a
        // valid mixed selection.
        const coSettlingKeys = new Set(threadKeys)
        for (const threadKey of threadKeys)
        {
          const thread = threadByKeyRef.current.get(threadKey)
          if (!thread || thread.settledOverride === 'settled') continue
          attemptSettle(scopeThreadRef(thread.environmentId, thread.id), { coSettlingKeys })
        }
        clearSelection()
        return
      }
      if (clicked.value === 'mark-unread')
      {
        for (const threadKey of threadKeys)
        {
          const thread = threadByKeyRef.current.get(threadKey)
          markThreadUnread(threadKey, thread?.latestTurn?.completedAt)
        }
        clearSelection()
        return
      }
      if (clicked.value !== 'delete') return
      if (confirmThreadDelete)
      {
        const confirmed = await settlePromise(() =>
          api.dialogs.confirm(
            [
              `Delete ${count} thread${count === 1 ? '' : 's'}?`,
              'This permanently clears conversation history for these threads.',
            ].join('\n'),
          ),
        )
        if (confirmed._tag === 'Failure' || !confirmed.value) return
      }
      // grown as deletions actually land, never seeded with the whole batch:
      // orphaned-worktree detection must only discount threads that are
      // really gone, or the first delete would treat still-alive batch mates
      // as deleted and remove a worktree they still point at.
      const deletedThreadKeys = new Set<string>()
      for (const threadKey of threadKeys)
      {
        const thread = threadByKeyRef.current.get(threadKey)
        if (!thread) continue
        const result = await deleteThread(scopeThreadRef(thread.environmentId, thread.id), {
          deletedThreadKeys,
        })
        if (result._tag === 'Failure')
        {
          if (!isAtomCommandInterrupted(result))
          {
            const error = squashAtomCommandFailure(result)
            toastManager.add(
              stackedThreadToast({
                type: 'error',
                title: 'Failed to delete threads',
                description: error instanceof Error ? error.message : 'An error occurred.',
              }),
            )
          }
          return
        }
        deletedThreadKeys.add(threadKey)
      }
      removeFromSelection(threadKeys)
    },
    [
      attemptSettle,
      attemptSnooze,
      clearSelection,
      confirmThreadDelete,
      deleteThread,
      markThreadUnread,
      removeFromSelection,
      serverConfigs,
    ],
  )

  const handleThreadContextMenu = useCallback(
    (threadRef: ScopedThreadRef, position: { x: number; y: number }) =>
    {
      void (async () =>
      {
        const api = readLocalApi()
        if (!api) return
        const threadKey = scopedThreadKey(threadRef)
        const selectionState = useThreadSelectionStore.getState()
        if (selectionState.hasSelection() && selectionState.selectedThreadKeys.has(threadKey))
        {
          await handleMultiSelectContextMenu(position)
          return
        }
        const thread = threadByKeyRef.current.get(threadKey)
        if (!thread) return
        const isImportedShelf = isImportedShelfThread(thread)
        // un-settle works on every settled row: for explicit settles it
        // clears the override, for auto-settled rows it pins the thread
        // active until real activity clears the pin. Environments without
        // the settlement capability get no lifecycle items at all.
        const supportsSettlement =
          !isImportedShelf &&
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSettlement ===
            true
        const supportsSnooze =
          !isImportedShelf &&
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSnooze === true
        const supportsPinning =
          !isImportedShelf &&
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadPinning === true
        const isSettled = settledThreadKeysRef.current.has(threadKey)
        const isSnoozed = snoozedThreadKeysRef.current.has(threadKey)
        const isPinned = thread.pinnedAt != null
        // presets resolve at menu-open time (same as the popover).
        const snoozePresets = resolveSnoozePresets(new Date())
        const threadWorkspacePath =
          thread.worktreePath ??
          projectCwdByKey.get(`${thread.environmentId}:${thread.projectId}`) ??
          null
        const clicked = await settlePromise(() =>
          api.contextMenu.show(
            buildThreadActionMenuItems({
              branch: thread.branch,
              isPinned,
              isSettled,
              isSnoozed,
              canSnoozeNow: canSnooze(thread, { now: new Date().toISOString() }),
              isRegeneratingTitle: false,
              isRunning:
                thread.session?.status === 'running' && thread.session.activeTurnId != null,
              supports: {
                settlement: supportsSettlement,
                snooze: supportsSnooze,
                pinning: supportsPinning,
                titleRegeneration: false,
              },
              snoozePresets,
            }),
            position,
          ),
        )
        if (clicked._tag === 'Failure') return
        if (clicked.value?.startsWith('snooze:'))
        {
          const preset = snoozePresets.find(
            (candidate) => `snooze:${candidate.id}` === clicked.value,
          )
          if (preset) attemptSnooze(threadRef, preset)
          return
        }
        switch (clicked.value)
        {
          case 'new-thread-on-branch':
          {
            // explicit branch carry-over: reuse the thread's worktree when it
            // has one, otherwise its branch on the local checkout.
            const result = await settlePromise(() =>
              handleNewThreadRef.current(scopeProjectRef(thread.environmentId, thread.projectId), {
                branch: thread.branch,
                worktreePath: thread.worktreePath,
                envMode: thread.worktreePath ? 'worktree' : 'local',
                startFromOrigin: false,
              }),
            )
            if (result._tag === 'Failure')
            {
              const error = squashAtomCommandFailure(result)
              toastManager.add(
                stackedThreadToast({
                  type: 'error',
                  title: 'Could not create thread',
                  description: error instanceof Error ? error.message : 'An error occurred.',
                }),
              )
            }
            return
          }
          case 'settle':
            attemptSettle(threadRef)
            return
          case 'unsettle':
            attemptUnsettle(threadRef)
            return
          case 'unsnooze':
            attemptUnsnooze(threadRef)
            return
          case 'pin':
            attemptPin(threadRef)
            return
          case 'unpin':
            attemptUnpin(threadRef)
            return
          case 'rename':
            startThreadRename(threadRef, thread.title)
            return
          case 'mark-unread':
            markThreadUnread(threadKey, thread.latestTurn?.completedAt)
            return
          case 'copy-path':
            if (threadWorkspacePath)
            {
              copyThreadValue(threadWorkspacePath, { label: 'Path', value: threadWorkspacePath })
            }
            return
          case 'copy-branch':
            if (thread.branch)
            {
              copyThreadValue(thread.branch, { label: 'Branch', value: thread.branch })
            }
            return
          case 'copy-thread-id':
            copyThreadValue(thread.id, { label: 'Thread ID', value: thread.id })
            return
          case 'archive':
          {
            if (confirmThreadArchive)
            {
              const confirmed = await settlePromise(() =>
                api.dialogs.confirm(`Archive thread "${thread.title}"?`),
              )
              if (confirmed._tag === 'Failure' || !confirmed.value) return
            }
            const result = await archiveThread(threadRef)
            if (result._tag === 'Failure' && !isAtomCommandInterrupted(result))
            {
              const error = squashAtomCommandFailure(result)
              toastManager.add(
                stackedThreadToast({
                  type: 'error',
                  title: 'Failed to archive thread',
                  description: error instanceof Error ? error.message : 'An error occurred.',
                }),
              )
            }
            return
          }
          case 'delete':
          {
            if (confirmThreadDelete)
            {
              const confirmed = await settlePromise(() =>
                api.dialogs.confirm(
                  [
                    `Delete thread "${thread.title}"?`,
                    'This permanently clears conversation history for this thread.',
                  ].join('\n'),
                ),
              )
              if (confirmed._tag === 'Failure' || !confirmed.value) return
            }
            const result = await deleteThread(threadRef)
            if (result._tag === 'Failure' && !isAtomCommandInterrupted(result))
            {
              const error = squashAtomCommandFailure(result)
              toastManager.add(
                stackedThreadToast({
                  type: 'error',
                  title: 'Failed to delete thread',
                  description: error instanceof Error ? error.message : 'An error occurred.',
                }),
              )
              return
            }
            return
          }
          default:
            return
        }
      })()
    },
    [
      attemptPin,
      attemptSettle,
      attemptSnooze,
      attemptUnpin,
      attemptUnsettle,
      attemptUnsnooze,
      archiveThread,
      confirmThreadArchive,
      confirmThreadDelete,
      copyThreadValue,
      deleteThread,
      handleMultiSelectContextMenu,
      markThreadUnread,
      projectCwdByKey,
      serverConfigs,
      startThreadRename,
    ],
  )

  // thread jump (cmd+1..9) and prev/next traversal reuse the same commands as
  // v1 — the keybinding layer is shared, only the ordered list differs.
  const routeTerminalOpen = useTerminalUiStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  )
  useEffect(() =>
  {
    const onWindowKeyDown = (event: KeyboardEvent) =>
    {
      if (event.defaultPrevented || event.repeat) return
      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen: routeTerminalOpen,
          modelPickerOpen: isModelPickerOpen(),
        },
      })
      const navigateToThreadKey = (targetThreadKey: string | null) =>
      {
        if (!targetThreadKey) return false
        const targetThread = threadByKey.get(targetThreadKey)
        if (!targetThread) return false
        event.preventDefault()
        event.stopPropagation()
        navigateToThread(scopeThreadRef(targetThread.environmentId, targetThread.id))
        return true
      }
      const traversalDirection = threadTraversalDirectionFromCommand(command)
      if (traversalDirection !== null)
      {
        navigateToThreadKey(
          resolveAdjacentThreadId({
            threadIds: orderedThreadKeys,
            currentThreadId: routeThreadKey,
            direction: traversalDirection,
          }),
        )
        return
      }
      const jumpIndex = threadJumpIndexFromCommand(command ?? '')
      if (jumpIndex === null) return
      navigateToThreadKey(orderedThreadKeys[jumpIndex] ?? null)
    }
    window.addEventListener('keydown', onWindowKeyDown)
    return () => window.removeEventListener('keydown', onWindowKeyDown)
  }, [
    keybindings,
    navigateToThread,
    orderedThreadKeys,
    routeTerminalOpen,
    routeThreadKey,
    threadByKey,
  ])

  // same predicate as v1: hints show only while the held modifiers exactly
  // match a thread-jump binding. Adding Shift (screenshots) or Alt no
  // longer matches ⌘1..9, so the overlay hides for chords like ⌘⇧4.
  const shortcutModifiers = useShortcutModifierState()
  const terminalFocused = useTerminalFocus()
  const shouldShowJumpHintsNow = shouldShowThreadJumpHintsForModifiers(
    shortcutModifiers,
    keybindings,
    {
      platform: navigator.platform,
      context: { terminalFocus: terminalFocused },
    },
  )
  useEffect(() =>
  {
    setShowJumpHints(shouldShowJumpHintsNow)
  }, [shouldShowJumpHintsNow])

  // LegendList owns the imported shelf's scroll viewport. Active and lifecycle
  // rows stay in its static header/footer so their PR subscriptions remain
  // mounted while only imported history is windowed.
  const renderThreadRow = useCallback(
    (thread: EnvironmentThreadShell, section: SidebarV2ThreadSection) =>
    {
      const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
      const isCard = section === 'active' || section === 'pinned'
      const rowVariant = isCard ? 'card' : 'slim'
      return (
        <SidebarV2Row
          key={`${threadKey}:${rowVariant}`}
          thread={thread}
          variant={rowVariant}
          variantAction={
            section === 'imported'
              ? 'none'
              : section === 'snoozed'
                ? 'unsnooze'
                : section === 'settled'
                  ? 'unsettle'
                  : 'settle'
          }
          settlementSupported={
            serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSettlement ===
            true
          }
          snoozeSupported={
            serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSnooze === true
          }
          isPinned={section === 'pinned'}
          snoozeWakeLabelText={
            section === 'snoozed' && thread.snoozedUntil != null
              ? snoozeWakeLabel(thread.snoozedUntil, new Date())
              : null
          }
          wokeAt={threadWokeAt(thread, { now: snoozeNow })}
          isActive={routeThreadKey === threadKey}
          jumpLabel={showJumpHints ? (jumpLabelByKey.get(threadKey) ?? null) : null}
          currentEnvironmentId={primaryEnvironmentId}
          environmentLabel={environmentLabelById.get(thread.environmentId) ?? null}
          projectCwd={projectCwdByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null}
          projectTitle={
            projectDisplayNameByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null
          }
          providerEntryByInstanceId={
            providerEntriesByEnvironment.get(thread.environmentId) ?? EMPTY_PROVIDER_ENTRIES
          }
          onThreadClick={handleThreadClick}
          onThreadActivate={navigateToThread}
          onStartRename={startThreadRename}
          onRenameTitleChange={setRenamingTitle}
          onCommitRename={commitThreadRename}
          onCancelRename={cancelThreadRename}
          isRenaming={renamingThreadKey === threadKey}
          renamingTitle={renamingThreadKey === threadKey ? renamingTitle : ''}
          onContextMenu={handleThreadContextMenu}
          onSettle={attemptSettle}
          onUnsettle={attemptUnsettle}
          onSnooze={attemptSnooze}
          onUnsnooze={attemptUnsnooze}
          changeRequestSnapshot={changeRequestSnapshotByKey.get(threadKey) ?? null}
          onTerminalChangeRequestObservation={
            section === 'imported' ? null : handleTerminalChangeRequestObservation
          }
        />
      )
    },
    [
      attemptSettle,
      attemptSnooze,
      attemptUnsettle,
      attemptUnsnooze,
      cancelThreadRename,
      commitThreadRename,
      changeRequestSnapshotByKey,
      environmentLabelById,
      handleTerminalChangeRequestObservation,
      handleThreadClick,
      handleThreadContextMenu,
      jumpLabelByKey,
      navigateToThread,
      primaryEnvironmentId,
      projectCwdByKey,
      projectDisplayNameByKey,
      providerEntriesByEnvironment,
      renamingThreadKey,
      renamingTitle,
      routeThreadKey,
      serverConfigs,
      setRenamingTitle,
      showJumpHints,
      snoozeNow,
      startThreadRename,
    ],
  )
  const renderImportedThread = useCallback(
    ({ item }: { item: EnvironmentThreadShell }) => renderThreadRow(item, 'imported'),
    [renderThreadRow],
  )
  const sidebarListHeader = useMemo(
    () => (
      <div role="presentation" className="flex flex-col gap-px">
        {pinnedThreads.map((thread) => renderThreadRow(thread, 'pinned'))}
        {pinnedThreads.length > 0 ? (
          <div
            aria-hidden
            data-testid="sidebar-v2-pinned-divider"
            className="mx-2.5 my-1.5 h-px bg-sidebar-border/60"
          />
        ) : null}
        {activeThreads.map((thread) => renderThreadRow(thread, 'active'))}
        {importedThreads.length > 0 ? (
          <SidebarV2ShelfHeader
            shelf="imported"
            count={importedThreads.length}
            expanded={importedShelfExpanded}
            onToggle={toggleImportedShelf}
          />
        ) : null}
      </div>
    ),
    [
      activeThreads,
      importedShelfExpanded,
      importedThreads.length,
      pinnedThreads,
      renderThreadRow,
      toggleImportedShelf,
    ],
  )
  const sidebarListFooter = useMemo(
    () => (
      <div role="presentation" className="flex flex-col gap-px">
        {snoozedThreads.length > 0 ? (
          <SidebarV2ShelfHeader
            shelf="snoozed"
            count={snoozedThreads.length}
            expanded={snoozedShelfExpanded}
            onToggle={toggleSnoozedShelf}
          />
        ) : null}
        {visibleSnoozedThreads.map((thread) => renderThreadRow(thread, 'snoozed'))}
        {settledThreads.length > 0 ? (
          <SidebarV2ShelfHeader
            shelf="settled"
            count={settledThreads.length}
            expanded={settledShelfExpanded}
            onToggle={toggleSettledShelf}
          />
        ) : null}
        {renderedSettledThreads.map((thread) => renderThreadRow(thread, 'settled'))}
        {settledShelfExpanded && hiddenSettledCount > 0 ? (
          <div role="listitem" className="list-none">
            <button
              type="button"
              onClick={showMoreSettled}
              className="mt-1 flex h-[30px] w-full min-w-0 items-center justify-center gap-1.5 overflow-hidden rounded-md border border-dashed border-border px-2 font-mono text-[11px] text-muted-foreground transition-colors hover:border-solid hover:border-input hover:bg-background/45 hover:text-foreground dark:border-white/15 dark:hover:border-white/30 dark:hover:bg-transparent"
            >
              <span className="shrink-0 whitespace-nowrap">
                Show {Math.min(hiddenSettledCount, SETTLED_TAIL_PAGE_COUNT)} more
              </span>
              {hiddenSettledCount > SETTLED_TAIL_PAGE_COUNT ? (
                <span className="min-w-0 truncate text-muted-foreground/50">
                  ({hiddenSettledCount} hidden)
                </span>
              ) : null}
            </button>
          </div>
        ) : null}
        {pinnedThreads.length +
          activeThreads.length +
          importedThreads.length +
          snoozedThreads.length +
          settledThreads.length ===
        0 ? (
          <div className="flex flex-col items-center gap-2 px-2 py-6 text-center text-xs text-muted-foreground/60">
            {projects.length === 0 ? (
              <>
                <span>No projects yet</span>
                <button
                  type="button"
                  onClick={openAddProjectCommandPalette}
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-sidebar-border px-2.5 py-1 text-[11px] font-medium text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                >
                  <PlusIcon className="size-3" />
                  Add project
                </button>
              </>
            ) : scopedProjectGroup ? (
              `No threads in ${scopedProjectGroup.displayName} yet`
            ) : (
              'No threads yet'
            )}
          </div>
        ) : null}
      </div>
    ),
    [
      activeThreads,
      hiddenSettledCount,
      importedThreads.length,
      openAddProjectCommandPalette,
      pinnedThreads.length,
      projects.length,
      renderedSettledThreads,
      renderThreadRow,
      scopedProjectGroup,
      settledShelfExpanded,
      settledThreads.length,
      showMoreSettled,
      snoozedShelfExpanded,
      snoozedThreads.length,
      toggleSettledShelf,
      toggleSnoozedShelf,
      visibleSnoozedThreads,
    ],
  )
  const sidebarListRef = useRef<LegendListRef | null>(null)
  const lastImportedRouteScrollRef = useRef<string | null>(null)
  useEffect(() =>
  {
    if (!importedShelfExpanded)
    {
      lastImportedRouteScrollRef.current = null
      return
    }
    if (routeThreadKey === null)
    {
      lastImportedRouteScrollRef.current = null
      return
    }
    const routeScrollKey = `${projectScopeKey ?? 'all'}:${routeThreadKey}`
    if (lastImportedRouteScrollRef.current === routeScrollKey) return
    const routeIndex = visibleImportedThreads.findIndex(
      (thread) => importedThreadListKey(thread) === routeThreadKey,
    )
    if (routeIndex < 0)
    {
      lastImportedRouteScrollRef.current = null
      return
    }
    lastImportedRouteScrollRef.current = routeScrollKey
    const list = sidebarListRef.current
    if (list === null) return
    const { start, end } = list.getState()
    if (routeIndex >= start && routeIndex <= end) return
    void list.scrollIndexIntoView({
      index: routeIndex,
      animated: false,
    })
  }, [importedShelfExpanded, projectScopeKey, routeThreadKey, visibleImportedThreads])

  // new thread defaults to the project you're in (active thread's project,
  // falling back to the top project) — same resolution the command palette
  // uses. The command palette already offers a "New thread in..." submenu
  // for multi-project setups.
  const handleNewThreadClick = useCallback(() =>
  {
    // one project: nothing to pick, create immediately.
    if (projectGroups.length <= 1)
    {
      if (isMobile) setOpenMobile(false)
      void startNewThreadFromContext({
        activeDraftThread: newThreadContext.activeDraftThread,
        activeThread: newThreadContext.activeThread ?? undefined,
        defaultProjectRef: newThreadContext.defaultProjectRef,
        handleNewThread: newThreadContext.handleNewThread,
      })
      return
    }
    if (isMobile) setOpenMobile(false)
    openCommandPalette({ open: 'new-thread-in' })
  }, [isMobile, newThreadContext, projectGroups.length, setOpenMobile])

  const commandPaletteShortcutLabel = shortcutLabelForCommand(keybindings, 'commandPalette.toggle')
  // same resolution as v1: prefer the local-thread binding, fall back to
  // chat.new, no platform gating — web users have working shortcuts too.
  const newThreadShortcutLabel =
    shortcutLabelForCommand(keybindings, 'chat.newLocal') ??
    shortcutLabelForCommand(keybindings, 'chat.new')
  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent className="h-full min-h-0 gap-0">
        <SidebarGroup className="px-2 pb-2 pt-3">
          <div className="flex items-center gap-1">
            <div className="min-w-0 flex-1">
              <CommandDialogTrigger
                render={
                  <SidebarMenuButton
                    size="sm"
                    type="button"
                    aria-label="Search threads and commands"
                    className="h-8 gap-2 rounded-md border-0 bg-transparent px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
                    data-testid="command-palette-trigger"
                  />
                }
              >
                <SearchIcon className="size-4 shrink-0 text-sidebar-muted-foreground/80" />
                <div className="flex-1 truncate text-left">Search</div>
                {commandPaletteShortcutLabel ? (
                  <Kbd className="h-4 min-w-0 rounded-sm bg-sidebar-control-surface px-1.5 text-[10px] text-sidebar-muted-foreground ring-1 ring-sidebar-border">
                    {commandPaletteShortcutLabel}
                  </Kbd>
                ) : null}
              </CommandDialogTrigger>
            </div>
            <div className="shrink-0">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <SidebarMenuButton
                      size="sm"
                      type="button"
                      className="relative size-8 justify-center rounded-md border-0 bg-transparent p-0 text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
                      onClick={handleNewThreadClick}
                      disabled={projects.length === 0}
                      aria-label="New thread"
                    />
                  }
                >
                  <SquarePenIcon className="size-4 shrink-0 text-sidebar-muted-foreground/80" />
                  <span
                    className="pointer-events-none absolute left-1/2 top-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
                    aria-hidden="true"
                  />
                </TooltipTrigger>
                <TooltipPopup side="right">
                  {newThreadShortcutLabel ? `New thread (${newThreadShortcutLabel})` : 'New thread'}
                </TooltipPopup>
              </Tooltip>
            </div>
          </div>
        </SidebarGroup>
        {projectGroups.length > 0 ? (
          <SidebarGroup className="px-2 pb-2 pt-0">
            <div className="flex items-center gap-1">
              <Menu open={projectScopeMenuOpen} onOpenChange={setProjectScopeMenuOpen}>
                <MenuTrigger
                  aria-label="Filter threads by project"
                  className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm font-medium text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
                >
                  {scopedProjectGroup ? (
                    <ProjectFavicon
                      environmentId={scopedProjectGroup.environmentId}
                      cwd={scopedProjectGroup.workspaceRoot}
                      className="size-4 shrink-0"
                    />
                  ) : (
                    <FolderIcon className="size-4 shrink-0 text-sidebar-muted-foreground/80" />
                  )}
                  <span className="min-w-0 flex-1 truncate">
                    {scopedProjectGroup?.displayName ?? 'All projects'}
                  </span>
                  <ChevronDownIcon className="size-4 shrink-0 text-sidebar-muted-foreground/70" />
                </MenuTrigger>
                <MenuPopup align="start" className="w-(--anchor-width)">
                  <MenuRadioGroup
                    value={projectScopeKey ?? 'all'}
                    onValueChange={(value) =>
                      setProjectScopeKey(value === 'all' ? null : (value as string))
                    }
                  >
                    <MenuRadioItem
                      value="all"
                      closeOnClick
                      className="h-8 min-h-8 px-1 py-0 text-sm font-medium [&>span:last-child]:flex [&>span:last-child]:min-w-0 [&>span:last-child]:items-center [&>span:last-child]:gap-2"
                    >
                      <FolderIcon className="size-4 shrink-0" />
                      <span className="min-w-0 truncate text-sm">All projects</span>
                    </MenuRadioItem>
                    {projectGroups.map((project) =>
                      {
                      const scopeKey = project.projectKey
                      return (
                        <MenuRadioItem
                          key={scopeKey}
                          value={scopeKey}
                          closeOnClick
                          className="h-8 min-h-8 px-1 py-0 text-sm font-medium [&>span:last-child]:flex [&>span:last-child]:min-w-0 [&>span:last-child]:items-center [&>span:last-child]:gap-2"
                        >
                          <ProjectFavicon
                            environmentId={project.environmentId}
                            cwd={project.workspaceRoot}
                            className="size-4 shrink-0"
                          />
                          <span className="min-w-0 truncate text-sm">{project.displayName}</span>
                          <button
                            type="button"
                            aria-label={`Project actions for ${project.displayName}`}
                            title={`Project actions for ${project.displayName}`}
                            className="ml-auto inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground/55 outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) =>
                              {
                              void handleProjectActions(event, project)
                            }}
                          >
                            <EllipsisIcon className="size-3.5" />
                          </button>
                        </MenuRadioItem>
                      )
                    })}
                  </MenuRadioGroup>
                </MenuPopup>
              </Menu>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <SidebarMenuButton
                      size="sm"
                      className="relative size-8 shrink-0 justify-center rounded-md bg-transparent p-0 text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
                      onClick={openAddProjectCommandPalette}
                      type="button"
                      aria-label="New project"
                    />
                  }
                >
                  <FolderPlusIcon className="size-4 shrink-0 text-sidebar-muted-foreground/80" />
                  <span
                    className="pointer-events-none absolute left-1/2 top-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
                    aria-hidden="true"
                  />
                </TooltipTrigger>
                <TooltipPopup side="right">New project</TooltipPopup>
              </Tooltip>
            </div>
          </SidebarGroup>
        ) : null}
        <SidebarGroup className="min-h-0 flex-1 overflow-hidden px-2 py-1">
          <TooltipProvider
            key="sidebar-thread-tooltips-150"
            delay={150}
            closeDelay={0}
            timeout={400}
          >
            <LegendList<EnvironmentThreadShell>
              ref={sidebarListRef}
              data={visibleImportedThreads}
              keyExtractor={importedThreadListKey}
              renderItem={renderImportedThread}
              extraData={renderThreadRow}
              estimatedItemSize={48}
              estimatedHeaderSize={estimateSidebarV2HeaderSize({
                activeThreadCount: activeThreads.length,
                pinnedThreadCount: pinnedThreads.length,
                hasImportedShelf: importedThreads.length > 0,
              })}
              drawDistance={480}
              recycleItems={false}
              maintainVisibleContentPosition={SIDEBAR_V2_MAINTAIN_VISIBLE_CONTENT_POSITION}
              ListHeaderComponent={sidebarListHeader}
              ListFooterComponent={sidebarListFooter}
              role="list"
              aria-label="Threads"
              className="h-full min-h-0 overflow-x-hidden overscroll-y-contain [scrollbar-gutter:stable]"
              contentContainerStyle={SIDEBAR_V2_LIST_CONTENT_STYLE}
            />
          </TooltipProvider>
        </SidebarGroup>
      </SidebarContent>
      <Dialog
        open={projectActionsTarget !== null}
        onOpenChange={(open) =>
        {
          if (!open) setProjectActionsTarget(null)
        }}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader className="gap-1.5">
            <DialogTitle className="text-balance">Project settings</DialogTitle>
            <DialogDescription>
              {projectActionsTarget && projectActionsTarget.memberProjects.length > 1
                ? `${projectActionsTarget.displayName} has an entry in each environment. Changes apply only to the entry you choose.`
                : `Manage ${projectActionsTarget?.displayName ?? 'this project'} in this environment.`}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="p-0">
            <div className="divide-y divide-border/60">
              {projectActionsTarget?.memberProjects.map((member) => (
                <section
                  key={member.physicalProjectKey}
                  className="flex min-w-0 flex-col gap-4 px-6 py-5 sm:gap-3 sm:py-4"
                >
                  <div className="flex min-w-0 items-start gap-3">
                    <ProjectFavicon
                      environmentId={member.environmentId}
                      cwd={member.workspaceRoot}
                      className="size-5 shrink-0 sm:size-4"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-1.5 text-base text-muted-foreground sm:text-sm">
                        <ServerIcon className="size-4 shrink-0 stroke-muted-foreground" />
                        <p className="min-w-0 truncate">
                          {member.environmentLabel ?? 'Current environment'}
                        </p>
                      </div>
                      <p
                        className="truncate font-mono text-base text-muted-foreground/72 sm:text-sm"
                        title={member.workspaceRoot}
                      >
                        {member.workspaceRoot}
                      </p>
                    </div>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2 sm:gap-3 sm:pl-7">
                    <label className="grid min-w-0 gap-1.5">
                      <span className="font-medium text-foreground">Project name</span>
                      <Input
                        key={`${member.physicalProjectKey}:${member.title}`}
                        size="sm"
                        aria-label={`Project name in ${member.environmentLabel ?? 'current environment'}`}
                        defaultValue={member.title}
                        onBlur={(event) =>
                        {
                          void renameProjectMember(member, event.currentTarget.value)
                        }}
                        onKeyDown={(event) =>
                        {
                          if (event.key === 'Enter') event.currentTarget.blur()
                        }}
                      />
                    </label>
                    <label className="grid min-w-0 gap-1.5">
                      <span className="font-medium text-foreground">Grouping rule</span>
                      <Select
                        value={
                          projectGroupingSettings.sidebarProjectGroupingOverrides?.[
                            deriveProjectGroupingOverrideKey(member)
                          ] ?? 'inherit'
                        }
                        onValueChange={(value) =>
                        {
                          if (
                            value === 'inherit' ||
                            value === 'repository' ||
                            value === 'repository_path' ||
                            value === 'separate'
                          )
                          {
                            updateProjectGroupingPreference(member, value)
                          }
                        }}
                      >
                        <SelectTrigger
                          size="sm"
                          className="w-full"
                          aria-label={`Grouping rule for ${member.environmentLabel ?? 'current environment'}`}
                        >
                          <SelectValue>
                            {(() =>
                            {
                              const selection =
                                projectGroupingSettings.sidebarProjectGroupingOverrides?.[
                                  deriveProjectGroupingOverrideKey(member)
                                ] ?? 'inherit'
                              return selection === 'inherit'
                                ? `Default (${PROJECT_GROUPING_MODE_LABELS[projectGroupingSettings.sidebarProjectGroupingMode]})`
                                : PROJECT_GROUPING_MODE_LABELS[selection]
                            })()}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectPopup align="start" alignItemWithTrigger={false}>
                          <SelectItem hideIndicator value="inherit">
                            Use global default
                          </SelectItem>
                          <SelectItem hideIndicator value="repository">
                            {PROJECT_GROUPING_MODE_LABELS.repository}
                          </SelectItem>
                          <SelectItem hideIndicator value="repository_path">
                            {PROJECT_GROUPING_MODE_LABELS.repository_path}
                          </SelectItem>
                          <SelectItem hideIndicator value="separate">
                            {PROJECT_GROUPING_MODE_LABELS.separate}
                          </SelectItem>
                        </SelectPopup>
                      </Select>
                    </label>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 sm:pl-7">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        copyProjectPath(member.workspaceRoot, { path: member.workspaceRoot })
                      }
                    >
                      <CopyIcon />
                      Copy path
                    </Button>
                    <ProjectArchitectureButton
                      member={member}
                      hasServerThread={hasArchitectureServerThread}
                      activeEnvironmentId={activeArchitectureEnvironmentId}
                      activeProjectId={activeArchitectureProjectId}
                      architectureCapability={
                        serverConfigs.get(member.environmentId) === undefined
                          ? null
                          : serverConfigs.get(member.environmentId)?.environment.capabilities
                              .architectureImpact === true
                      }
                      onOpen={handleOpenProjectArchitecture}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive-foreground hover:bg-destructive/8 hover:text-destructive-foreground sm:ml-auto"
                      onClick={() =>
                      {
                        const projectGroup = projectActionsTarget
                        if (!projectGroup) return
                        setProjectActionsTarget(null)
                        void handleRemoveProjectMembers(projectGroup, [member])
                      }}
                    >
                      <Trash2Icon />
                      Remove
                    </Button>
                  </div>
                </section>
              ))}
            </div>
            {projectActionsTarget && projectActionsTarget.memberProjects.length > 1 ? (
              <div className="flex flex-col gap-3 border-t border-border/60 bg-muted/32 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="text-base font-medium text-foreground sm:text-sm">
                    Remove this project everywhere
                  </p>
                  <p className="text-base text-pretty text-muted-foreground sm:text-sm">
                    Deletes all grouped entries and their conversation history.
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="destructive-outline"
                  className="shrink-0"
                  onClick={() =>
                    {
                    const projectGroup = projectActionsTarget
                    setProjectActionsTarget(null)
                    void handleRemoveProjectMembers(projectGroup, projectGroup.memberProjects)
                  }}
                >
                  <Trash2Icon />
                  Remove all entries
                </Button>
              </div>
            ) : null}
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button onClick={() => setProjectActionsTarget(null)}>Done</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <SidebarChromeFooter />
    </>
  )
}
