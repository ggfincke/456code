// apps/web/src/components/chat/messages-timeline/WorkTimelineRows.tsx
// render working indicators and expandable work-group timeline rows

import { FileDiff } from '@pierre/diffs/react'
import {
  type EnvironmentId,
  type MessageId,
  type ScopedThreadRef,
  type ServerProviderSkill,
  type TurnId,
} from '@t3tools/contracts'
import { type TimestampFormat } from '@t3tools/contracts/settings'
import {
  ArrowRightIcon,
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  EyeIcon,
  GlobeIcon,
  HammerIcon,
  MessageCircleIcon,
  MinusIcon,
  MousePointerClickIcon,
  PaintbrushIcon,
  SquarePenIcon,
  TerminalIcon,
  Undo2Icon,
  WrenchIcon,
  XIcon,
  ZapIcon,
} from 'lucide-react'
import {
  Fragment,
  memo,
  use,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { type ParsedElementContextEntry } from '~/lib/elementContext'
import {
  extractTrailingPreviewAnnotation,
  type ParsedPreviewAnnotation,
} from '~/lib/previewAnnotation'
import {
  deriveDisplayedUserMessageState,
  type ParsedTerminalContextEntry,
} from '~/lib/terminalContext'
import { cn } from '~/lib/utils'
import { useUiStateStore } from '~/uiStateStore'
import { useSyntaxThemeName } from '../../../hooks/useSyntaxThemeName'
import { getRenderablePatch, resolveFileDiffPath } from '../../../lib/diffRendering'
import { type ProviderSwitchTimelineParty } from '../../../providerSwitchPresentation'
import {
  deriveTimelineEntries,
  formatDuration,
  workEntryIndicatesToolFailure,
  workEntryIndicatesToolNeutralStatus,
  workEntryIndicatesToolSuccess,
  workLogEntryIsToolLike,
} from '../../../session-logic'
import { workEntryIndicatesToolRunning, workEntryRunningSince } from '../../../session/worklog'
import { formatChatTimestampTooltip, formatShortTimestamp } from '../../../timestampFormat'
import { type TurnDiffSummary } from '../../../types'
import ChatMarkdown from '../../ChatMarkdown'
import { Button } from '../../ui/button'
import { Tooltip, TooltipPopup, TooltipTrigger } from '../../ui/tooltip'
import { shouldAutoExpandChangedFiles } from '../changedFilesPresentation'
import { ChangedFilesCard } from '../ChangedFilesTree'
import { buildExpandedImagePreview, ExpandedImagePreview } from '../ExpandedImagePreview'
import { MessageCopyButton } from '../MessageCopyButton'
import {
  normalizeCompactToolLabel,
  resolveAssistantMessageCopyState,
  type MessagesTimelineRow,
} from './MessagesTimeline.logic'
import type { OrchestratePlanActions } from '../OrchestratePlanCard'
import { ProposedPlanCard } from '../ProposedPlanCard'
import { ProviderInstanceIcon } from '../ProviderInstanceIcon'
import { TerminalContextInlineChip } from '../TerminalContextInlineChip'
import { formatWorkspaceRelativePath } from '../../../lib/filePathDisplay'
import {
  buildReviewCommentRenderablePatch,
  formatReviewCommentFence,
  formatReviewCommentContext,
  parseReviewCommentMessageSegments,
  type ReviewCommentContext,
} from '../../../reviewCommentContext'
import { SkillInlineText } from '../SkillInlineText'
import {
  buildInlineTerminalContextText,
  formatInlineTerminalContextLabel,
  textContainsInlineTerminalContextLabels,
} from '../userMessageTerminalContexts'
import {
  TimelineRowActivityCtx,
  TimelineRowCtx,
  type TimelineRow,
  type TimelineWorkEntry,
} from './timelineRowContext'

export function WorkingTimelineRow({ row }: { row: Extract<TimelineRow, { kind: 'working' }> })
{
  return (
    <div className="py-0.5 pl-1.5">
      <div className="flex items-center gap-2 pt-1 text-[11px] text-muted-foreground/70 tabular-nums">
        <span className="inline-flex items-center gap-[3px]">
          <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-status-pulse" />
          <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-status-pulse [animation-delay:200ms]" />
          <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-status-pulse [animation-delay:400ms]" />
        </span>
        <span>
          {row.createdAt ? (
            <>
              Working for <WorkingTimer createdAt={row.createdAt} />
            </>
          ) : (
            'Working...'
          )}
        </span>
      </div>
    </div>
  )
}

// self-ticking labels — update their own text nodes so elapsed-time display
// does not create a React commit every second while a response is streaming.

// live "Working for Xs" label.
function WorkingTimer({ createdAt }: { createdAt: string })
{
  const textRef = useRef<HTMLSpanElement>(null)
  const initialText = formatWorkingTimerNow(createdAt)

  useEffect(() =>
  {
    const updateText = () =>
    {
      if (textRef.current)
      {
        textRef.current.textContent = formatWorkingTimerNow(createdAt)
      }
    }
    updateText()
    const id = setInterval(updateText, 1000)
    return () => clearInterval(id)
  }, [createdAt])

  return (
    <span ref={textRef} className="tabular-nums">
      {initialText}
    </span>
  )
}

// extracted row sections — own their state / store subscriptions so changes
// re-render only the affected row, not the entire list.

// renders one or more already-derived work log rows. Overflow expansion is modeled as LegendList data.
export const WorkGroupSection = memo(function WorkGroupSection({
  groupedEntries,
}: {
  groupedEntries: Extract<MessagesTimelineRow, { kind: 'work' }>['groupedEntries']
})
{
  const { workspaceRoot } = use(TimelineRowCtx)
  const nonEmptyEntries = useMemo(
    () => groupedEntries.filter((entry) => !workEntryIndicatesToolNeutralStatus(entry)),
    [groupedEntries],
  )
  const onlyToolEntries = nonEmptyEntries.every((entry) => workLogEntryIsToolLike(entry))
  const groupLabel = onlyToolEntries
    ? nonEmptyEntries.length === 1
      ? '1 tool call'
      : `${nonEmptyEntries.length} tool calls`
    : 'Work Log'

  if (nonEmptyEntries.length === 0) return null

  return (
    <section className="-mx-1 space-y-0.5 px-1 py-0.5" aria-label={groupLabel}>
      {!onlyToolEntries && (
        <p className="px-0.5 pb-0.5 font-medium text-[11px] text-muted-foreground/65">
          {groupLabel}
        </p>
      )}
      <div className="space-y-px">
        {nonEmptyEntries.map((workEntry) => (
          <SimpleWorkEntryRow
            key={workEntry.id}
            workEntry={workEntry}
            workspaceRoot={workspaceRoot}
          />
        ))}
      </div>
    </section>
  )
})

export function WorkGroupToggleTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: 'work-toggle' }>
})
{
  const ctx = use(TimelineRowCtx)
  const labelNoun = row.onlyToolEntries
    ? row.hiddenCount === 1
      ? 'tool call'
      : 'tool calls'
    : row.hiddenCount === 1
      ? 'log entry'
      : 'log entries'

  return (
    <button
      type="button"
      className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-0.5 py-0.5 text-left text-[12px] leading-5 transition-colors duration-150 hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      aria-expanded={row.expanded}
      onClick={(event) =>
      {
        const anchorElement =
          event.currentTarget.closest<HTMLElement>('[data-timeline-row-id]') ?? event.currentTarget
        ctx.onToggleWorkGroup(row.groupId, anchorElement)
      }}
    >
      <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground/65">
        <ChevronDownIcon
          className={cn(
            'size-3.5 shrink-0 opacity-70 transition-transform duration-200',
            row.expanded && 'rotate-180',
          )}
        />
      </span>
      {row.expanded ? (
        <span className="font-medium text-foreground/82">
          Show fewer {row.onlyToolEntries ? 'tool calls' : 'log entries'}
        </span>
      ) : (
        <span className="font-medium text-foreground/82">
          +{row.hiddenCount} previous {labelNoun}
        </span>
      )}
    </button>
  )
}

// subscribes directly to the UI state store for expand/collapse state,
//  so toggling re-renders only this component — not the entire list.

function formatWorkingTimer(startIso: string, endIso: string): string | null
{
  const startedAtMs = Date.parse(startIso)
  const endedAtMs = Date.parse(endIso)
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs))
  {
    return null
  }

  const elapsedSeconds = Math.max(0, Math.floor((endedAtMs - startedAtMs) / 1000))
  if (elapsedSeconds < 60)
  {
    return `${elapsedSeconds}s`
  }

  const hours = Math.floor(elapsedSeconds / 3600)
  const minutes = Math.floor((elapsedSeconds % 3600) / 60)
  const seconds = elapsedSeconds % 60

  if (hours > 0)
  {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  }

  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
}

function formatWorkingTimerNow(startIso: string): string
{
  return formatWorkingTimer(startIso, new Date().toISOString()) ?? '0s'
}

type WorkEntryIconName =
  | 'bot'
  | 'check'
  | 'circle-alert'
  | 'eye'
  | 'globe'
  | 'hammer'
  | 'message-circle'
  | 'square-pen'
  | 'terminal'
  | 'wrench'
  | 'x'
  | 'zap'

function WorkEntryIconSvg({ name, className }: { name: WorkEntryIconName; className: string })
{
  switch (name)
  {
    case 'bot':
      return <BotIcon className={className} aria-hidden />
    case 'check':
      return <CheckIcon className={className} aria-hidden />
    case 'circle-alert':
      return <CircleAlertIcon className={className} aria-hidden />
    case 'eye':
      return <EyeIcon className={className} aria-hidden />
    case 'globe':
      return <GlobeIcon className={className} aria-hidden />
    case 'hammer':
      return <HammerIcon className={className} aria-hidden />
    case 'message-circle':
      return <MessageCircleIcon className={className} aria-hidden />
    case 'square-pen':
      return <SquarePenIcon className={className} aria-hidden />
    case 'terminal':
      return <TerminalIcon className={className} aria-hidden />
    case 'wrench':
      return <WrenchIcon className={className} aria-hidden />
    case 'x':
      return <XIcon className={className} aria-hidden />
    case 'zap':
      return <ZapIcon className={className} aria-hidden />
  }
}

function workToneIcon(tone: TimelineWorkEntry['tone']): {
  iconName: WorkEntryIconName
  className: string
}
{
  if (tone === 'error')
  {
    return {
      iconName: 'circle-alert',
      className: 'text-foreground/92',
    }
  }
  if (tone === 'thinking')
  {
    return {
      iconName: 'bot',
      className: 'text-foreground/92',
    }
  }
  if (tone === 'info')
  {
    return {
      iconName: 'check',
      className: 'text-muted-foreground',
    }
  }
  return {
    iconName: 'zap',
    className: 'text-foreground/92',
  }
}

function workEntryPreview(
  workEntry: Pick<TimelineWorkEntry, 'detail' | 'command' | 'changedFiles'>,
  workspaceRoot: string | undefined,
)
{
  if (workEntry.command) return workEntry.command
  if (workEntry.detail) return workEntry.detail
  if ((workEntry.changedFiles?.length ?? 0) === 0) return null
  const [firstPath] = workEntry.changedFiles ?? []
  if (!firstPath) return null
  const displayPath = formatWorkspaceRelativePath(firstPath, workspaceRoot)
  return workEntry.changedFiles!.length === 1
    ? displayPath
    : `${displayPath} +${workEntry.changedFiles!.length - 1} more`
}

function workEntryRawCommand(
  workEntry: Pick<TimelineWorkEntry, 'command' | 'rawCommand'>,
): string | null
{
  const rawCommand = workEntry.rawCommand?.trim()
  if (!rawCommand || !workEntry.command)
  {
    return null
  }
  return rawCommand === workEntry.command.trim() ? null : rawCommand
}

function buildToolCallExpandedBody(
  workEntry: TimelineWorkEntry,
  workspaceRoot: string | undefined,
): string | null
{
  const blocks: string[] = []
  if (workEntry.itemType === 'mcp_tool_call' && workEntry.toolData !== undefined)
  {
    blocks.push(`MCP call\n${JSON.stringify(workEntry.toolData, null, 2)}`)
  }
  const raw = workEntryRawCommand(workEntry)
  if (raw?.trim())
  {
    blocks.push(raw.trim())
  }
  else if (workEntry.command?.trim())
  {
    blocks.push(workEntry.command.trim())
  }
  if (workEntry.detail?.trim())
  {
    blocks.push(workEntry.detail.trim())
  }
  const changedFiles = workEntry.changedFiles ?? []
  if (changedFiles.length > 0)
  {
    blocks.push(
      changedFiles
        .map((filePath) => formatWorkspaceRelativePath(filePath, workspaceRoot))
        .join('\n'),
    )
  }
  return blocks.length > 0 ? blocks.join('\n\n') : null
}

function workEntryIconName(workEntry: TimelineWorkEntry): WorkEntryIconName
{
  if (
    workEntry.sourceActivityKind === 'user-input.requested' ||
    workEntry.sourceActivityKind === 'user-input.resolved'
  )
  {
    return 'message-circle'
  }
  // a compaction is the runtime working on itself, not a tool call. give both halves of the
  // pair the same mark so the start row and the finished row read as one event
  if (
    workEntry.sourceActivityKind === 'context-compaction' ||
    workEntry.sourceActivityKind === 'context-compaction.started'
  )
  {
    return 'zap'
  }
  if (workEntry.requestKind === 'command') return 'terminal'
  if (workEntry.requestKind === 'file-read') return 'eye'
  if (workEntry.requestKind === 'file-change') return 'square-pen'

  if (workEntry.itemType === 'command_execution' || workEntry.command)
  {
    return 'terminal'
  }
  if (workEntry.itemType === 'file_change' || (workEntry.changedFiles?.length ?? 0) > 0)
  {
    return 'square-pen'
  }
  if (workEntry.itemType === 'web_search') return 'globe'
  if (workEntry.itemType === 'image_view') return 'eye'

  switch (workEntry.itemType)
  {
    case 'mcp_tool_call':
      return 'wrench'
    case 'dynamic_tool_call':
    case 'collab_agent_tool_call':
      return 'hammer'
  }

  return workToneIcon(workEntry.tone).iconName
}

function capitalizePhrase(value: string): string
{
  const trimmed = value.trim()
  if (trimmed.length === 0)
  {
    return value
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`
}

function toolWorkEntryHeading(workEntry: TimelineWorkEntry): string
{
  if (!workEntry.toolTitle)
  {
    return capitalizePhrase(normalizeCompactToolLabel(workEntry.label))
  }
  return capitalizePhrase(normalizeCompactToolLabel(workEntry.toolTitle))
}

function formatTokenCount(totalTokens: number): string
{
  if (totalTokens < 1_000)
  {
    return `${totalTokens} tok`
  }
  if (totalTokens < 1_000_000)
  {
    const compact = (totalTokens / 1_000).toFixed(totalTokens < 100_000 ? 1 : 0)
    return `${compact.replace(/\.0$/, '')}k tok`
  }
  const compact = (totalTokens / 1_000_000).toFixed(totalTokens < 100_000_000 ? 1 : 0)
  return `${compact.replace(/\.0$/, '')}m tok`
}

// model / tokens / tool count / duration / live last-tool line under subagent rows
function taskMetadataParts(workEntry: TimelineWorkEntry): string[]
{
  if (!workEntry.taskId)
  {
    return []
  }
  const parts: string[] = []
  if (workEntry.model) parts.push(workEntry.model)
  if (workEntry.totalTokens !== undefined) parts.push(formatTokenCount(workEntry.totalTokens))
  if (workEntry.toolUses !== undefined)
  {
    parts.push(`${workEntry.toolUses} ${workEntry.toolUses === 1 ? 'tool' : 'tools'}`)
  }
  if (workEntry.durationMs !== undefined) parts.push(formatDuration(workEntry.durationMs))
  if (workEntry.toolLifecycleStatus === 'inProgress' && workEntry.lastToolName)
  {
    parts.push(workEntry.lastToolName)
  }
  return parts
}

const stopRowToggle = (e: { stopPropagation: () => void }) => e.stopPropagation()

const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: {
  workEntry: TimelineWorkEntry
  workspaceRoot: string | undefined
})
{
  const { workEntry, workspaceRoot } = props
  const activity = use(TimelineRowActivityCtx)
  const [expanded, setExpanded] = useState(false)
  const iconConfig = workToneIcon(workEntry.tone)
  // an approaching plan limit is the one warning that has to survive being skimmed, so it gets
  // the same destructive treatment runtime.warning already has instead of blending into info rows
  const showWarningIndicator =
    workEntry.sourceActivityKind === 'runtime.warning' ||
    workEntry.sourceActivityKind === 'account.rate-limit.warning'
  const entryIconName = showWarningIndicator ? 'x' : workEntryIconName(workEntry)
  const heading = toolWorkEntryHeading(workEntry)
  const rawPreview = workEntryPreview(workEntry, workspaceRoot)
  const preview =
    rawPreview &&
    normalizeCompactToolLabel(rawPreview).toLowerCase() ===
      normalizeCompactToolLabel(heading).toLowerCase()
      ? null
      : rawPreview
  const displayText = preview ? `${heading} - ${preview}` : heading
  const metadataParts = taskMetadataParts(workEntry)
  const expandedBody = buildToolCallExpandedBody(workEntry, workspaceRoot)
  const canExpand = expandedBody !== null
  const showFailedIndicator = workEntryIndicatesToolFailure(workEntry)
  const showDestructiveRowStyle =
    showFailedIndicator &&
    (workEntry.sourceActivityKind === 'runtime.error' || !workLogEntryIsToolLike(workEntry))
  const iconWrapperClass = cn(
    'flex size-5 shrink-0 items-center justify-center',
    showWarningIndicator
      ? 'text-destructive'
      : showDestructiveRowStyle
        ? 'text-destructive'
        : workEntry.tone === 'tool' || showFailedIndicator
          ? 'text-muted-foreground/65'
          : iconConfig.className,
  )
  const headingClass = showWarningIndicator
    ? 'font-medium text-warning'
    : showDestructiveRowStyle
      ? 'font-medium text-destructive'
      : 'font-medium text-foreground/82'
  const turnSettled = !activity.activeTurnInProgress
  // a running row is never neutral, so it can never be upgraded to the check
  // below: a tool the turn abandoned mid-flight must not read as completed
  const showRunningIndicator = workEntryIndicatesToolRunning(workEntry)
  const runningSince =
    showRunningIndicator && !turnSettled ? workEntryRunningSince(workEntry) : null
  const showNeutralIndicator = !turnSettled && workEntryIndicatesToolNeutralStatus(workEntry)
  const showSuccessIndicator =
    workEntryIndicatesToolSuccess(workEntry) ||
    (turnSettled && workEntryIndicatesToolNeutralStatus(workEntry))
  const rowToggleProps = canExpand
    ? {
        role: 'button' as const,
        tabIndex: 0 as const,
        'aria-label': displayText,
        onClick: () => setExpanded((v) => !v),
        onKeyDown: (e: KeyboardEvent<HTMLDivElement>) =>
          {
          if (e.key === 'Enter' || e.key === ' ')
            {
            e.preventDefault()
            setExpanded((v) => !v)
          }
        },
      }
    : {}

  return (
    <div
      className={cn(
        'flex flex-col rounded-md px-0.5 py-0.5 transition-colors',
        canExpand &&
          'cursor-pointer hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70',
      )}
      {...rowToggleProps}
    >
      <div className="flex select-none items-center gap-1.5 transition-[opacity,translate] duration-200">
        <span className={iconWrapperClass}>
          <WorkEntryIconSvg
            name={entryIconName}
            className="block size-3.5 shrink-0 stroke-[1.8] opacity-80"
          />
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <div className="min-w-0 flex-1 overflow-hidden">
            <p className="flex min-w-0 w-full items-baseline gap-1.5 text-[12px] leading-5">
              <span className={cn('min-w-0 shrink truncate', headingClass)}>{heading}</span>
              {preview && (
                <span className="min-w-0 flex-1 truncate text-muted-foreground/55">{preview}</span>
              )}
            </p>
            {metadataParts.length > 0 || runningSince ? (
              <p className="truncate text-[11px] leading-4 text-muted-foreground/55">
                {metadataParts.length > 0 ? metadataParts.join(' · ') : null}
                {metadataParts.length > 0 && runningSince ? ' · ' : null}
                {runningSince ? (
                  <>
                    Running for <WorkingTimer createdAt={runningSince} />
                  </>
                ) : null}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-px text-muted-foreground/55">
            <span
              className="flex size-4 shrink-0 items-center justify-center"
              aria-hidden={!canExpand}
            >
              {canExpand ? (
                <ChevronDownIcon
                  className={cn(
                    'size-3 shrink-0 opacity-70 transition-transform duration-200',
                    expanded && 'rotate-180',
                  )}
                  aria-hidden
                />
              ) : null}
            </span>
            <span className="flex size-4 shrink-0 items-center justify-center">
              {showFailedIndicator ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span
                        className="flex size-4 items-center justify-center"
                        aria-label="Tool call failed"
                      />
                    }
                  >
                    <XIcon className="block size-3 shrink-0 text-destructive" aria-hidden />
                  </TooltipTrigger>
                  <TooltipPopup>Failed</TooltipPopup>
                </Tooltip>
              ) : showRunningIndicator ? (
                <Tooltip>
                  <TooltipTrigger
                    render={<span className="flex size-4 items-center justify-center" />}
                  >
                    {turnSettled ? (
                      <MinusIcon className="block size-3 shrink-0 opacity-70" aria-hidden />
                    ) : (
                      <span className="inline-flex items-center gap-[2px]">
                        <span className="h-1 w-1 rounded-full bg-current opacity-60 animate-status-pulse" />
                        <span className="h-1 w-1 rounded-full bg-current opacity-60 animate-status-pulse [animation-delay:220ms]" />
                      </span>
                    )}
                  </TooltipTrigger>
                  <TooltipPopup>{turnSettled ? 'Interrupted' : 'Running'}</TooltipPopup>
                </Tooltip>
              ) : showSuccessIndicator ? (
                <Tooltip>
                  <TooltipTrigger
                    render={<span className="flex size-4 items-center justify-center" />}
                  >
                    <span className="inline-flex size-4 items-center justify-center">
                      <CheckIcon
                        className="block size-3 shrink-0 stroke-current"
                        stroke="currentColor"
                        aria-hidden
                      />
                    </span>
                  </TooltipTrigger>
                  <TooltipPopup>Completed</TooltipPopup>
                </Tooltip>
              ) : showNeutralIndicator ? (
                <Tooltip>
                  <TooltipTrigger
                    render={<span className="flex size-4 items-center justify-center" />}
                  >
                    <MinusIcon className="block size-3 shrink-0 opacity-70" aria-hidden />
                  </TooltipTrigger>
                  <TooltipPopup>Empty</TooltipPopup>
                </Tooltip>
              ) : null}
            </span>
          </div>
        </div>
      </div>
      {expanded && canExpand && expandedBody ? (
        <div
          className="mt-1 ms-7 cursor-default border-s border-border/45 ps-3 pt-0.5"
          onClick={stopRowToggle}
          onPointerDown={stopRowToggle}
        >
          <pre className="max-h-64 cursor-text overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted-foreground select-text">
            {expandedBody}
          </pre>
        </div>
      ) : null}
    </div>
  )
})
