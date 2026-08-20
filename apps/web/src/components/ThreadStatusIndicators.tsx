// apps/web/src/components/ThreadStatusIndicators.tsx
// derives and renders thread status indicators
import {
  scopeProjectRef,
  scopedThreadKey,
  scopeThreadRef,
} from '@t3tools/client-runtime/environment'
import type { VcsStatusResult } from '@t3tools/contracts'
import { Atom } from 'effect/unstable/reactivity'
import { CloudIcon, FolderGit2Icon, GitPullRequestIcon, TerminalIcon } from 'lucide-react'
import { useMemo } from 'react'
import { appAtomRegistry } from '../rpc/atomRegistry'
import { useEnvironment, usePrimaryEnvironmentId } from '../state/environments'
import { useProject } from '../state/entities'
import { useEnvironmentQuery } from '../state/query'
import { useThreadRunningTerminalIds } from '../state/terminalSessions'
import { vcsEnvironment } from '../state/vcs'
import { useUiStateStore } from '../uiStateStore'
import { resolveChangeRequestPresentation } from '../lib/sourceControlPresentation'
import { resolveThreadStatusPill, type ThreadStatusPill } from './Sidebar.logic'
import type { SidebarThreadSummary } from '../types'
import { formatWorktreePathForDisplay } from '../worktreeCleanup'
import { Tooltip, TooltipPopup, TooltipTrigger } from './ui/tooltip'

export interface PrStatusIndicator
{
  label: string
  colorClass: string
  tooltip: string
  tooltipLead: string
  tooltipTitle: string
  url: string
}

export interface TerminalStatusIndicator
{
  label: 'Terminal process running'
  colorClass: string
  pulse: boolean
}

export type ThreadPr = VcsStatusResult['pr']

export function settledPrHoverColorClass(state: NonNullable<ThreadPr>['state']): string
{
  switch (state)
  {
    case 'open':
      return 'group-hover/v2-row:text-emerald-600 dark:group-hover/v2-row:text-emerald-300/90'
    case 'merged':
      return 'group-hover/v2-row:text-violet-600 dark:group-hover/v2-row:text-violet-300/90'
    case 'closed':
      return 'group-hover/v2-row:text-red-600 dark:group-hover/v2-row:text-red-300/90'
  }
}

export function prStatusIndicator(
  pr: ThreadPr,
  provider: VcsStatusResult['sourceControlProvider'] | null | undefined,
): PrStatusIndicator | null
{
  function formatPrState(state: NonNullable<ThreadPr>['state']): string
  {
    return state.charAt(0).toUpperCase() + state.slice(1)
  }

  function formatPrStatusLead(pr: NonNullable<ThreadPr>, changeRequestShortName: string): string
  {
    return `${changeRequestShortName} #${pr.number} - ${formatPrState(pr.state)}`
  }
  if (!pr) return null
  const presentation = resolveChangeRequestPresentation(provider)

  const tooltipLead = formatPrStatusLead(pr, presentation.shortName)
  const tooltip = `${tooltipLead}: ${pr.title}`

  if (pr.state === 'open')
  {
    return {
      label: `${presentation.shortName} open`,
      colorClass: 'text-emerald-600 dark:text-emerald-300/90',
      tooltip,
      tooltipLead,
      tooltipTitle: pr.title,
      url: pr.url,
    }
  }
  if (pr.state === 'closed')
  {
    return {
      label: `${presentation.shortName} closed`,
      colorClass: 'text-red-600 dark:text-red-300/90',
      tooltip,
      tooltipLead,
      tooltipTitle: pr.title,
      url: pr.url,
    }
  }
  if (pr.state === 'merged')
  {
    return {
      label: `${presentation.shortName} merged`,
      colorClass: 'text-violet-600 dark:text-violet-300/90',
      tooltip,
      tooltipLead,
      tooltipTitle: pr.title,
      url: pr.url,
    }
  }
  return null
}

export function ChangeRequestStatusIcon({ className }: { className?: string })
{
  return <GitPullRequestIcon className={className} />
}

export function PrStatusTooltipContent({ status }: { status: PrStatusIndicator })
{
  return (
    <span className="flex max-w-[min(34rem,calc(100vw-2rem))] items-stretch overflow-hidden whitespace-nowrap">
      <span className="shrink-0 pr-2 font-medium">{status.tooltipLead}</span>
      <span className="min-h-4 shrink-0 border-border/70 border-l" aria-hidden="true" />
      <span className="min-w-0 truncate pl-2">{status.tooltipTitle}</span>
    </span>
  )
}

export function resolveThreadPr(input: {
  threadBranch: string | null
  gitStatus: VcsStatusResult | null
}): ThreadPr | null
{
  const { threadBranch, gitStatus } = input
  if (gitStatus === null)
  {
    return null
  }

  if (threadBranch === null || gitStatus.refName !== threadBranch)
  {
    return null
  }

  return gitStatus.pr ?? null
}

export type TerminalThreadPr = NonNullable<ThreadPr> & { readonly state: 'merged' | 'closed' }

// parent-held terminal PR metadata survives row and sidebar remounts.
export interface ThreadChangeRequestSnapshot
{
  readonly branch: string
  readonly pr: TerminalThreadPr
  readonly sourceControlProvider: VcsStatusResult['sourceControlProvider'] | undefined
}

export interface TerminalChangeRequestObservation
{
  readonly branch: string
  readonly state: 'closed' | 'merged'
  readonly updatedAt: string | null | undefined
  readonly retainOnBranchMismatch: boolean
}

export const threadChangeRequestSnapshotsAtom = Atom.make<
  ReadonlyMap<string, ThreadChangeRequestSnapshot>
>(new Map()).pipe(Atom.keepAlive, Atom.withLabel('sidebar:thread-change-request-snapshots'))

// only the shared local checkout borrows retained metadata; a pruned adopted
// root has already fallen back to local, while a pending or live root has not.
export function canRetainTerminalThreadPr(input: {
  readonly worktreePath: string | null
  readonly orchestrateRunWorktreePath: string | null
  readonly orchestrateRunWorktreeIsNotRepository: boolean
}): boolean
{
  return (
    input.worktreePath === null &&
    (input.orchestrateRunWorktreePath === null || input.orchestrateRunWorktreeIsNotRepository)
  )
}

function isTerminalThreadPr(pr: NonNullable<ThreadPr>): pr is TerminalThreadPr
{
  return pr.state === 'merged' || pr.state === 'closed'
}

// undefined preserves parent state while VCS reloads; null is authoritative clear.
export function nextTerminalChangeRequestObservation(input: {
  readonly threadBranch: string | null
  readonly gitStatus: VcsStatusResult | null
  readonly displayedPr: ThreadPr
  readonly retainOnBranchMismatch: boolean
}): TerminalChangeRequestObservation | null | undefined
{
  if (input.threadBranch === null) return null
  if (input.gitStatus === null) return undefined
  if (input.displayedPr === null || !isTerminalThreadPr(input.displayedPr)) return null
  return {
    branch: input.threadBranch,
    state: input.displayedPr.state,
    updatedAt: input.displayedPr.updatedAt,
    retainOnBranchMismatch: input.retainOnBranchMismatch,
  }
}

function sourceControlProvidersEqual(
  left: VcsStatusResult['sourceControlProvider'] | undefined,
  right: VcsStatusResult['sourceControlProvider'] | undefined,
): boolean
{
  if (left === right) return true
  if (left == null || right == null) return left == null && right == null
  return left.kind === right.kind && left.name === right.name && left.baseUrl === right.baseUrl
}

export function threadChangeRequestSnapshotsEqual(
  left: ThreadChangeRequestSnapshot,
  right: ThreadChangeRequestSnapshot,
): boolean
{
  return (
    left.branch === right.branch &&
    left.pr.number === right.pr.number &&
    left.pr.title === right.pr.title &&
    left.pr.url === right.pr.url &&
    left.pr.baseRef === right.pr.baseRef &&
    left.pr.headRef === right.pr.headRef &&
    left.pr.state === right.pr.state &&
    left.pr.updatedAt === right.pr.updatedAt &&
    sourceControlProvidersEqual(left.sourceControlProvider, right.sourceControlProvider)
  )
}

export function setThreadChangeRequestSnapshot(
  threadKey: string,
  snapshot: ThreadChangeRequestSnapshot | null,
): void
{
  appAtomRegistry.modify(threadChangeRequestSnapshotsAtom, (current) =>
  {
    const existing = current.get(threadKey)
    if (snapshot === null)
    {
      if (existing === undefined) return [false, current]
      const next = new Map(current)
      next.delete(threadKey)
      return [true, next]
    }
    if (existing !== undefined && threadChangeRequestSnapshotsEqual(existing, snapshot))
    {
      return [false, current]
    }
    const next = new Map(current)
    next.set(threadKey, snapshot)
    return [true, next]
  })
}

// undefined preserves the cache; null clears it; snapshots contain terminal PRs only.
export function nextThreadChangeRequestSnapshot(input: {
  readonly threadBranch: string | null
  readonly gitStatus: VcsStatusResult | null
  readonly snapshot: ThreadChangeRequestSnapshot | null | undefined
  readonly retainTerminalOnBranchMismatch: boolean
}): ThreadChangeRequestSnapshot | null | undefined
{
  const { threadBranch, gitStatus, snapshot, retainTerminalOnBranchMismatch } = input
  if (threadBranch === null) return null
  if (gitStatus === null) return undefined

  // local thread metadata follows the shared checkout. Once it diverges from
  // the captured branch, keep the terminal PR and ignore that checkout's PR.
  if (
    retainTerminalOnBranchMismatch &&
    snapshot !== null &&
    snapshot !== undefined &&
    snapshot.branch !== threadBranch
  )
  {
    return undefined
  }
  if (gitStatus.refName !== threadBranch)
  {
    return retainTerminalOnBranchMismatch && snapshot != null ? undefined : null
  }
  if (gitStatus.pr === null || gitStatus.pr === undefined)
  {
    return retainTerminalOnBranchMismatch && snapshot != null ? undefined : null
  }
  if (!isTerminalThreadPr(gitStatus.pr)) return null
  return {
    branch: threadBranch,
    pr: gitStatus.pr,
    sourceControlProvider: gitStatus.sourceControlProvider,
  }
}

export function resolveDisplayedThreadPr(input: {
  readonly threadBranch: string | null
  readonly gitStatus: VcsStatusResult | null
  readonly snapshot: ThreadChangeRequestSnapshot | null | undefined
  readonly retainTerminalOnBranchMismatch: boolean
}): ThreadPr | null
{
  const { threadBranch, gitStatus, snapshot, retainTerminalOnBranchMismatch } = input
  if (threadBranch === null) return null

  // a metadata move marks a local checkout change; the cached terminal PR
  // remains this thread's PR and the new branch's PR is unrelated.
  if (retainTerminalOnBranchMismatch && snapshot != null && snapshot.branch !== threadBranch)
  {
    return snapshot.pr
  }
  if (gitStatus !== null && gitStatus.refName === threadBranch && gitStatus.pr != null)
  {
    return gitStatus.pr
  }
  return retainTerminalOnBranchMismatch && snapshot != null ? snapshot.pr : null
}

export function resolveDisplayedThreadPrProvider(input: {
  readonly threadBranch: string | null
  readonly gitStatus: VcsStatusResult | null
  readonly snapshot: ThreadChangeRequestSnapshot | null | undefined
  readonly retainTerminalOnBranchMismatch: boolean
}): VcsStatusResult['sourceControlProvider'] | undefined
{
  const { threadBranch, gitStatus, snapshot, retainTerminalOnBranchMismatch } = input
  if (threadBranch === null) return undefined
  if (retainTerminalOnBranchMismatch && snapshot != null && snapshot.branch !== threadBranch)
  {
    return snapshot.sourceControlProvider
  }
  if (gitStatus !== null && gitStatus.refName === threadBranch && gitStatus.pr != null)
  {
    return gitStatus.sourceControlProvider
  }
  return retainTerminalOnBranchMismatch && snapshot != null
    ? snapshot.sourceControlProvider
    : undefined
}

export function terminalStatusFromRunningIds(
  runningTerminalIds: ReadonlyArray<string>,
): TerminalStatusIndicator | null
{
  if (runningTerminalIds.length === 0)
  {
    return null
  }
  return {
    label: 'Terminal process running',
    colorClass: 'text-teal-600 dark:text-teal-300/90',
    pulse: true,
  }
}

export function ThreadWorktreeIndicator({
  thread,
}: {
  thread: Pick<SidebarThreadSummary, 'id' | 'branch' | 'worktreePath'>
})
{
  const worktreePath = thread.worktreePath?.trim()
  if (!worktreePath)
  {
    return null
  }

  const displayPath = formatWorktreePathForDisplay(worktreePath)
  const tooltip = thread.branch
    ? `Worktree: ${displayPath} (${thread.branch})`
    : `Worktree: ${displayPath}`

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={tooltip}
            data-testid={`thread-worktree-${thread.id}`}
            className="inline-flex items-center justify-center"
          />
        }
      >
        <FolderGit2Icon className="size-3 text-muted-foreground/40" />
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  )
}

export function ThreadStatusLabel({
  status,
  compact = false,
}: {
  status: ThreadStatusPill
  compact?: boolean
})
{
  if (compact)
  {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              aria-label={status.label}
              className={`inline-flex size-3.5 shrink-0 items-center justify-center ${status.colorClass}`}
            />
          }
        >
          <span
            className={`size-[9px] rounded-full ${status.dotClass} ${
              status.pulse ? 'animate-status-pulse' : ''
            }`}
          />
        </TooltipTrigger>
        <TooltipPopup side="top">{status.label}</TooltipPopup>
      </Tooltip>
    )
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={status.label}
            className={`inline-flex items-center gap-1 text-[10px] ${status.colorClass}`}
          />
        }
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${status.dotClass} ${
            status.pulse ? 'animate-status-pulse' : ''
          }`}
        />
        <span className="hidden md:inline">{status.label}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">{status.label}</TooltipPopup>
    </Tooltip>
  )
}

// non-interactive leading status icons for a thread row in compact contexts
// like the command palette. Shows the change request state icon (if present) and the
// thread status dot, matching the sidebar's leading indicators.
export function ThreadRowLeadingStatus({ thread }: { thread: SidebarThreadSummary })
{
  const threadRef = scopeThreadRef(thread.environmentId, thread.id)
  const lastVisitedAt = useUiStateStore(
    (state) => state.threadLastVisitedAtById[scopedThreadKey(threadRef)],
  )
  const threadProject = useProject(
    useMemo(
      () => scopeProjectRef(thread.environmentId, thread.projectId),
      [thread.environmentId, thread.projectId],
    ),
  )
  const threadProjectCwd = threadProject?.workspaceRoot ?? null
  const gitCwd = thread.worktreePath ?? threadProjectCwd
  const gitStatus = useEnvironmentQuery(
    (thread.branch != null || thread.worktreePath !== null) && gitCwd !== null
      ? vcsEnvironment.status({
          environmentId: thread.environmentId,
          input: { cwd: gitCwd },
        })
      : null,
  )
  const pr = resolveThreadPr({
    threadBranch: thread.branch,
    gitStatus: gitStatus.data,
  })
  const prStatus = prStatusIndicator(pr, gitStatus.data?.sourceControlProvider)
  const threadStatus = resolveThreadStatusPill({
    thread: {
      ...thread,
      lastVisitedAt,
    },
  })

  if (!prStatus && !threadStatus)
  {
    return null
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {prStatus ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                aria-label={prStatus.tooltip}
                className={`inline-flex items-center justify-center ${prStatus.colorClass}`}
              />
            }
          >
            <ChangeRequestStatusIcon className="size-3" />
          </TooltipTrigger>
          <TooltipPopup side="top">
            <PrStatusTooltipContent status={prStatus} />
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {threadStatus ? <ThreadStatusLabel status={threadStatus} /> : null}
    </span>
  )
}

// non-interactive trailing status icons for a thread row in compact contexts
// like the command palette. Shows a terminal-running indicator and a remote
// environment indicator, matching the sidebar's trailing indicators.
export function ThreadRowTrailingStatus({ thread }: { thread: SidebarThreadSummary })
{
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: thread.environmentId,
    threadId: thread.id,
  })
  const environment = useEnvironment(thread.environmentId)
  const primaryEnvironmentId = usePrimaryEnvironmentId()
  const isRemoteThread =
    primaryEnvironmentId !== null && thread.environmentId !== primaryEnvironmentId
  const remoteEnvLabel = environment?.label ?? null
  const threadEnvironmentLabel = isRemoteThread ? (remoteEnvLabel ?? 'Remote') : null
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds)

  if (!terminalStatus && !isRemoteThread)
  {
    return null
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {terminalStatus ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                role="img"
                aria-label={terminalStatus.label}
                className={`inline-flex items-center justify-center ${terminalStatus.colorClass}`}
              />
            }
          >
            <TerminalIcon
              className={`size-3 ${terminalStatus.pulse ? 'animate-status-pulse' : ''}`}
            />
          </TooltipTrigger>
          <TooltipPopup side="top">{terminalStatus.label}</TooltipPopup>
        </Tooltip>
      ) : null}
      {isRemoteThread ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                aria-label={threadEnvironmentLabel ?? 'Remote'}
                className="inline-flex items-center justify-center"
              />
            }
          >
            <CloudIcon className="size-3 text-muted-foreground/60" />
          </TooltipTrigger>
          <TooltipPopup side="top">{threadEnvironmentLabel}</TooltipPopup>
        </Tooltip>
      ) : null}
    </span>
  )
}
