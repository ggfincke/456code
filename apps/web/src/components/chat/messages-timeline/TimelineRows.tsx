// apps/web/src/components/chat/messages-timeline/TimelineRows.tsx
// renders timeline message, work, plan, and fold rows
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
  createContext,
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
import {
  extractTrailingElementContexts,
  type ParsedElementContextEntry,
} from '~/lib/elementContext'
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
  workEntryIndicatesToolFailure,
  workEntryIndicatesToolNeutralStatus,
  workEntryIndicatesToolSuccess,
  workLogEntryIsToolLike,
} from '../../../session-logic'
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
} from '../MessagesTimeline.logic'
import type { OrchestratePlanActions } from '../OrchestratePlanCard'
import { ProposedPlanCard } from '../ProposedPlanCard'
import { ProviderInstanceIcon } from '../ProviderInstanceIcon'
import { TerminalContextInlineChip } from '../TerminalContextInlineChip'

import { formatWorkspaceRelativePath } from '../../../filePathDisplay'
import {
  buildReviewCommentRenderablePatch,
  formatReviewCommentFence,
  parseReviewCommentMessageSegments,
  type ReviewCommentContext,
} from '../../../reviewCommentContext'
import { SkillInlineText } from '../SkillInlineText'
import {
  buildInlineTerminalContextText,
  formatInlineTerminalContextLabel,
  textContainsInlineTerminalContextLabels,
} from '../userMessageTerminalContexts'

export interface TimelineRowSharedState
{
  timestampFormat: TimestampFormat
  routeThreadKey: string
  threadRef: ScopedThreadRef | null
  markdownCwd: string | undefined
  resolvedTheme: 'light' | 'dark'
  workspaceRoot: string | undefined
  skills: ReadonlyArray<Pick<ServerProviderSkill, 'name' | 'displayName'>>
  activeThreadEnvironmentId: EnvironmentId
  onRevertUserMessage: (messageId: MessageId) => void
  onImageExpand: (preview: ExpandedImagePreview) => void
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void
  onToggleTurnFold: (turnId: TurnId) => void
  onToggleWorkGroup: (groupId: string, anchorElement?: HTMLElement) => void
  orchestratePlanActions?: OrchestratePlanActions | undefined
}

export interface TimelineRowActivityState
{
  isWorking: boolean
  isRevertingCheckpoint: boolean
  activeTurnInProgress: boolean
  latestTurnId: TurnId | null
}

const TimelineRowCtx = createContext<TimelineRowSharedState>(null!)
const TimelineRowActivityCtx = createContext<TimelineRowActivityState>(null!)

type TimelineEntry = ReturnType<typeof deriveTimelineEntries>[number]
type TimelineMessage = Extract<TimelineEntry, { kind: 'message' }>['message']
type TimelineWorkEntry = Extract<MessagesTimelineRow, { kind: 'work' }>['groupedEntries'][number]
type TimelineRow = MessagesTimelineRow

const TimelineRowContent = memo(function TimelineRowContent({ row }: { row: TimelineRow })
{
  return (
    <div
      className={cn(
        // commentary (non-terminal assistant) rows carry no metadata row, so
        // they sit closer to the work that follows them.
        (row.kind === 'message' && row.message.role === 'assistant' && !row.showAssistantMeta) ||
          row.kind === 'work' ||
          row.kind === 'work-toggle'
          ? 'pb-2'
          : 'pb-4',
        row.kind === 'message' && row.message.role === 'assistant' ? 'group/assistant' : null,
      )}
      data-timeline-row-id={row.id}
      data-timeline-row-kind={row.kind}
      data-message-id={row.kind === 'message' ? row.message.id : undefined}
      data-message-role={row.kind === 'message' ? row.message.role : undefined}
    >
      {row.kind === 'work' ? <WorkGroupSection groupedEntries={row.groupedEntries} /> : null}
      {row.kind === 'work-toggle' ? <WorkGroupToggleTimelineRow row={row} /> : null}
      {row.kind === 'turn-fold' ? <TurnFoldTimelineRow row={row} /> : null}
      {row.kind === 'message' && row.message.role === 'user' ? <UserTimelineRow row={row} /> : null}
      {row.kind === 'message' && row.message.role === 'assistant' ? (
        <AssistantTimelineRow row={row} />
      ) : null}
      {row.kind === 'proposed-plan' ? <ProposedPlanTimelineRow row={row} /> : null}
      {row.kind === 'provider-switch' ? <ProviderSwitchTimelineRow row={row} /> : null}
      {row.kind === 'working' ? <WorkingTimelineRow row={row} /> : null}
    </div>
  )
})

function UserTimelineRow({ row }: { row: Extract<TimelineRow, { kind: 'message' }> })
{
  const ctx = use(TimelineRowCtx)
  const userImages = row.message.attachments ?? []
  const displayedUserMessage = deriveDisplayedUserMessageState(row.message.text)
  const terminalContexts = displayedUserMessage.contexts
  const previewAnnotations: ParsedPreviewAnnotation[] = []
  let visibleText = displayedUserMessage.visibleText
  while (true)
  {
    const extracted = extractTrailingPreviewAnnotation(visibleText)
    if (!extracted.annotation) break
    previewAnnotations.unshift(extracted.annotation)
    visibleText = extracted.promptText
  }
  const elementContextState = extractTrailingElementContexts(visibleText)
  const elementContexts = [...displayedUserMessage.elementContexts, ...elementContextState.contexts]
  const previewImages = userImages.filter((image) => image.name.startsWith('preview-annotation-'))
  const regularImages = userImages.filter((image) => !image.name.startsWith('preview-annotation-'))
  const canRevertAgentWork = typeof row.revertTurnCount === 'number'

  return (
    <div className="group flex flex-col items-end gap-1">
      <div className="relative max-w-[80%] rounded-2xl bg-accent p-3">
        {regularImages.length > 0 && (
          <div className="mb-2 grid max-w-[420px] grid-cols-2 gap-2">
            {regularImages.map((image: NonNullable<TimelineMessage['attachments']>[number]) => (
              <div
                key={image.id}
                className="overflow-hidden rounded-lg border border-border/80 bg-background/70"
              >
                {image.previewUrl ? (
                  <button
                    type="button"
                    className="h-full w-full cursor-zoom-in"
                    aria-label={`Preview ${image.name}`}
                    onClick={() =>
                      {
                      const preview = buildExpandedImagePreview(regularImages, image.id)
                      if (!preview) return
                      ctx.onImageExpand(preview)
                    }}
                  >
                    <img
                      src={image.previewUrl}
                      alt={image.name}
                      className="block h-auto max-h-[220px] w-full object-cover"
                    />
                  </button>
                ) : (
                  <div className="flex min-h-[72px] items-center justify-center px-2 py-3 text-center text-[11px] text-muted-foreground/70">
                    {image.name}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {previewAnnotations.map((annotation, index) => (
          <UserMessagePreviewAnnotationCard
            key={annotation.id}
            annotation={annotation}
            image={previewImages[index] ?? null}
          />
        ))}
        {elementContexts.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {elementContexts.map((context) => (
              <UserMessageElementContextChip
                key={`${context.header}:${context.body}`}
                context={context}
              />
            ))}
          </div>
        ) : null}
        <CollapsibleUserMessageBody
          text={elementContextState.promptText}
          terminalContexts={terminalContexts}
          skills={ctx.skills}
          markdownCwd={ctx.markdownCwd}
        />
      </div>
      <div className="flex w-full max-w-[80%] items-center justify-end pe-1 text-xs tabular-nums opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
        <div className="flex shrink-0 items-center gap-2">
          <Tooltip>
            <TooltipTrigger render={<p className="text-muted-foreground text-xs tabular-nums" />}>
              {formatShortTimestamp(row.message.createdAt, ctx.timestampFormat)}
            </TooltipTrigger>
            <TooltipPopup>
              {formatChatTimestampTooltip(row.message.createdAt, ctx.timestampFormat)}
            </TooltipPopup>
          </Tooltip>
          <div className="flex items-center gap-0.5">
            {canRevertAgentWork && <RevertUserMessageButton messageId={row.message.id} />}
            {displayedUserMessage.copyText && (
              <MessageCopyButton text={displayedUserMessage.copyText} variant="ghost" />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function RevertUserMessageButton({ messageId }: { messageId: MessageId })
{
  const ctx = use(TimelineRowCtx)
  const activity = use(TimelineRowActivityCtx)

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={activity.isRevertingCheckpoint || activity.isWorking}
            onClick={() => ctx.onRevertUserMessage(messageId)}
            aria-label="Revert to this message"
          />
        }
      >
        <Undo2Icon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">Revert to this message</TooltipPopup>
    </Tooltip>
  )
}

function TurnFoldTimelineRow({ row }: { row: Extract<TimelineRow, { kind: 'turn-fold' }> })
{
  const ctx = use(TimelineRowCtx)
  const Icon = row.expanded ? ChevronDownIcon : ChevronRightIcon

  return (
    <div className="border-b border-border/60 pb-2 pt-1">
      <button
        type="button"
        aria-expanded={row.expanded}
        data-scroll-anchor-ignore
        onClick={() => ctx.onToggleTurnFold(row.turnId)}
        className="flex cursor-pointer select-none items-center gap-1 rounded-md px-1 text-xs text-muted-foreground tabular-nums transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      >
        <span>{row.label}</span>
        <Icon className="size-3.5" />
      </button>
    </div>
  )
}

function AssistantTimelineRow({ row }: { row: Extract<TimelineRow, { kind: 'message' }> })
{
  const ctx = use(TimelineRowCtx)
  const messageText = row.message.text || (row.message.streaming ? '' : '(empty response)')

  return (
    <>
      <div className="relative min-w-0 px-1 py-0.5">
        <ChatMarkdown
          text={messageText}
          cwd={ctx.markdownCwd}
          threadRef={ctx.threadRef ?? undefined}
          isStreaming={Boolean(row.message.streaming)}
          skills={ctx.skills}
          orchestratePlanActions={ctx.orchestratePlanActions}
        />
        <AssistantChangedFilesSection
          turnSummary={row.assistantTurnDiffSummary}
          routeThreadKey={ctx.routeThreadKey}
          resolvedTheme={ctx.resolvedTheme}
          onOpenTurnDiff={ctx.onOpenTurnDiff}
        />
        {row.showAssistantMeta ? (
          <div className="mt-1.5 flex items-center gap-2 text-xs tabular-nums opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover/assistant:opacity-100">
            <AssistantCopyButton row={row} />
            {!row.message.streaming && (
              <Tooltip>
                <TooltipTrigger
                  render={<p className="text-muted-foreground text-xs tabular-nums" />}
                >
                  {formatShortTimestamp(row.message.updatedAt, ctx.timestampFormat)}
                </TooltipTrigger>
                <TooltipPopup>
                  {formatChatTimestampTooltip(row.message.updatedAt, ctx.timestampFormat)}
                </TooltipPopup>
              </Tooltip>
            )}
          </div>
        ) : null}
      </div>
    </>
  )
}

function AssistantCopyButton({ row }: { row: Extract<TimelineRow, { kind: 'message' }> })
{
  const assistantCopyState = resolveAssistantMessageCopyState({
    text: row.message.text ?? null,
    showCopyButton: row.showAssistantCopyButton,
    streaming: row.assistantCopyStreaming,
  })

  if (!assistantCopyState.visible)
  {
    return null
  }

  return <MessageCopyButton text={assistantCopyState.text ?? ''} variant="ghost" />
}

function ProposedPlanTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: 'proposed-plan' }>
})
{
  const ctx = use(TimelineRowCtx)

  return (
    <div className="min-w-0 px-1 py-0.5">
      <ProposedPlanCard
        planId={row.proposedPlan.id}
        planMarkdown={row.proposedPlan.planMarkdown}
        environmentId={ctx.activeThreadEnvironmentId}
        threadRef={ctx.threadRef ?? undefined}
        cwd={ctx.markdownCwd}
        workspaceRoot={ctx.workspaceRoot}
      />
    </div>
  )
}

function ProviderSwitchPartyIcon({ party }: { party: ProviderSwitchTimelineParty })
{
  if (party.driverKind === null)
  {
    return null
  }

  return (
    <ProviderInstanceIcon
      driverKind={party.driverKind}
      displayName={party.displayName}
      className="size-3.5"
      iconClassName="size-3.5"
    />
  )
}

// provider switch outcomes read as thread boundaries, so they reuse the
// turn-fold divider rule rather than work-log row styling.
function ProviderSwitchTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: 'provider-switch' }>
})
{
  const [expanded, setExpanded] = useState(false)
  const event = row.event
  const failed = event.status === 'failed'
  const detail = failed ? event.detail : null
  const canExpand = detail !== null

  const rowToggleProps = canExpand
    ? {
        role: 'button' as const,
        tabIndex: 0 as const,
        'aria-expanded': expanded,
        onClick: () => setExpanded((value) => !value),
        onKeyDown: (e: KeyboardEvent<HTMLDivElement>) =>
          {
          if (e.key === 'Enter' || e.key === ' ')
            {
            e.preventDefault()
            setExpanded((value) => !value)
          }
        },
      }
    : {}

  return (
    <div
      className={cn('border-b pb-2 pt-1', failed ? 'border-destructive/40' : 'border-border/60')}
    >
      <div
        className={cn(
          'flex select-none items-center gap-1.5 rounded-md px-1 py-0.5 text-xs',
          failed ? 'text-destructive' : 'text-muted-foreground',
          canExpand &&
            'cursor-pointer transition-colors hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70',
        )}
        {...rowToggleProps}
      >
        {failed ? (
          <CircleAlertIcon aria-hidden className="size-3.5 shrink-0" />
        ) : (
          // the row label already names both parties, so the glyph pair (which
          // falls back to initials text) stays out of the accessible name
          <span aria-hidden className="flex shrink-0 items-center gap-1">
            {event.from ? <ProviderSwitchPartyIcon party={event.from} /> : null}
            <ArrowRightIcon aria-hidden className="size-3 shrink-0 text-muted-foreground/60" />
            {event.to ? <ProviderSwitchPartyIcon party={event.to} /> : null}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate">{event.label}</span>
        {canExpand ? (
          <ChevronDownIcon
            aria-hidden
            className={cn(
              'size-3 shrink-0 opacity-70 transition-transform duration-200',
              expanded && 'rotate-180',
            )}
          />
        ) : null}
      </div>
      {expanded && detail ? (
        <div className="mt-1 ms-7 cursor-default border-s border-border/45 ps-3 pt-0.5">
          <pre className="max-h-64 cursor-text overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted-foreground select-text">
            {detail}
          </pre>
        </div>
      ) : null}
    </div>
  )
}

function WorkingTimelineRow({ row }: { row: Extract<TimelineRow, { kind: 'working' }> })
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
const WorkGroupSection = memo(function WorkGroupSection({
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

function WorkGroupToggleTimelineRow({
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
const AssistantChangedFilesSection = memo(function AssistantChangedFilesSection({
  turnSummary,
  routeThreadKey,
  resolvedTheme,
  onOpenTurnDiff,
}: {
  turnSummary: TurnDiffSummary | undefined
  routeThreadKey: string
  resolvedTheme: 'light' | 'dark'
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void
})
{
  if (!turnSummary) return null
  const checkpointFiles = turnSummary.files
  if (checkpointFiles.length === 0) return null

  return (
    <AssistantChangedFilesSectionInner
      turnSummary={turnSummary}
      checkpointFiles={checkpointFiles}
      routeThreadKey={routeThreadKey}
      resolvedTheme={resolvedTheme}
      onOpenTurnDiff={onOpenTurnDiff}
    />
  )
})

// inner component that only mounts when there are actual changed files,
//  so the store subscription is unconditional (no hooks after early return).
function AssistantChangedFilesSectionInner({
  turnSummary,
  checkpointFiles,
  routeThreadKey,
  resolvedTheme,
  onOpenTurnDiff,
}: {
  turnSummary: TurnDiffSummary
  checkpointFiles: TurnDiffSummary['files']
  routeThreadKey: string
  resolvedTheme: 'light' | 'dark'
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void
})
{
  const activity = use(TimelineRowActivityCtx)
  const isLatestTurn = activity.latestTurnId === turnSummary.turnId
  const persistedExpanded = useUiStateStore(
    (store) => store.threadChangedFilesExpandedById[routeThreadKey]?.[turnSummary.turnId],
  )
  const setExpanded = useUiStateStore((store) => store.setThreadChangedFilesExpanded)
  const [autoExpanded] = useState(() => shouldAutoExpandChangedFiles(checkpointFiles, isLatestTurn))
  const [allDirectoriesExpanded, setAllDirectoriesExpanded] = useState(autoExpanded)
  const expanded = persistedExpanded ?? (isLatestTurn && autoExpanded)

  return (
    <ChangedFilesCard
      turnId={turnSummary.turnId}
      files={checkpointFiles}
      expanded={expanded}
      showCompactPreview={isLatestTurn}
      allDirectoriesExpanded={allDirectoriesExpanded}
      resolvedTheme={resolvedTheme}
      onExpandedChange={(nextExpanded) =>
        setExpanded(routeThreadKey, turnSummary.turnId, nextExpanded)
      }
      onToggleAllDirectories={() => setAllDirectoriesExpanded((current) => !current)}
      onOpenTurnDiff={onOpenTurnDiff}
    />
  )
}

// leaf components

const UserMessageTerminalContextInlineLabel = memo(
  function UserMessageTerminalContextInlineLabel(props: { context: ParsedTerminalContextEntry })
  {
    const tooltipText =
      props.context.body.length > 0
        ? `${props.context.header}\n${props.context.body}`
        : props.context.header

    return <TerminalContextInlineChip label={props.context.header} tooltipText={tooltipText} />
  },
)

const UserMessageElementContextChip = memo(function UserMessageElementContextChip(props: {
  context: ParsedElementContextEntry
})
{
  const tooltipText = props.context.body
    ? `${props.context.header}\n${props.context.body}`
    : props.context.header
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/70 bg-background/70 px-1.5 py-0.5 text-xs text-foreground/85">
            <MousePointerClickIcon className="size-3 shrink-0" />
            <span className="truncate">{props.context.header}</span>
          </span>
        }
      />
      <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap leading-tight">
        {tooltipText}
      </TooltipPopup>
    </Tooltip>
  )
})

function UserMessagePreviewAnnotationCard(props: {
  annotation: ParsedPreviewAnnotation
  image: NonNullable<TimelineMessage['attachments']>[number] | null
})
{
  const ctx = use(TimelineRowCtx)
  return (
    <div className="mb-2 flex max-w-full items-center overflow-hidden rounded-lg border border-border/70 bg-background/70">
      {props.image?.previewUrl ? (
        <button
          type="button"
          className="size-14 shrink-0 cursor-zoom-in overflow-hidden border-r border-border/70 bg-muted"
          aria-label={`Preview ${props.image.name}`}
          onClick={() =>
            {
            if (!props.image) return
            const preview = buildExpandedImagePreview([props.image], props.image.id)
            if (preview) ctx.onImageExpand(preview)
          }}
        >
          <img
            src={props.image.previewUrl}
            alt="Annotated preview crop"
            className="size-full object-cover"
          />
        </button>
      ) : null}
      <div className="min-w-0 px-2.5 py-2">
        {props.annotation.comment ? (
          <div className="max-w-80 truncate text-xs font-medium text-foreground/90">
            {props.annotation.comment}
          </div>
        ) : null}
        <div
          className={cn(
            'flex items-center gap-2 text-[10px] text-muted-foreground',
            props.annotation.comment && 'mt-1',
          )}
        >
          {props.annotation.targetSummary ? (
            <span className="truncate">{props.annotation.targetSummary}</span>
          ) : null}
          {props.annotation.styleChanges.length > 0 ? (
            <span className="inline-flex shrink-0 items-center gap-1">
              <PaintbrushIcon className="size-3" />
              {props.annotation.styleChanges.length}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  )
}

const MAX_COLLAPSED_USER_MESSAGE_LINES = 8
const MAX_COLLAPSED_USER_MESSAGE_LENGTH = 600
const COLLAPSED_USER_MESSAGE_FADE_HEIGHT_REM = 1.75
const COLLAPSED_USER_MESSAGE_FADE_MASK = `linear-gradient(to bottom, black calc(100% - ${COLLAPSED_USER_MESSAGE_FADE_HEIGHT_REM}rem), transparent)`

function shouldCollapseUserMessage(text: string): boolean
{
  if (text.trim().length === 0)
  {
    return false
  }

  return (
    text.length > MAX_COLLAPSED_USER_MESSAGE_LENGTH ||
    text.split('\n').length > MAX_COLLAPSED_USER_MESSAGE_LINES
  )
}

const CollapsibleUserMessageBody = memo(function CollapsibleUserMessageBody(props: {
  text: string
  terminalContexts: ParsedTerminalContextEntry[]
  skills: ReadonlyArray<Pick<ServerProviderSkill, 'name' | 'displayName'>>
  markdownCwd: string | undefined
  footer?: ReactNode
})
{
  const [expanded, setExpanded] = useState(false)
  const hasVisibleBody = props.text.trim().length > 0 || props.terminalContexts.length > 0
  const canCollapse = hasVisibleBody && shouldCollapseUserMessage(props.text)
  const isCollapsed = canCollapse && !expanded

  return (
    <div>
      {hasVisibleBody ? (
        <div
          className={cn('relative', isCollapsed && 'max-h-44 overflow-hidden')}
          data-user-message-body="true"
          data-user-message-collapsed={isCollapsed ? 'true' : 'false'}
          data-user-message-collapsible={canCollapse ? 'true' : 'false'}
          data-user-message-fade={isCollapsed ? 'true' : 'false'}
          style={
            isCollapsed
              ? {
                  WebkitMaskImage: COLLAPSED_USER_MESSAGE_FADE_MASK,
                  maskImage: COLLAPSED_USER_MESSAGE_FADE_MASK,
                }
              : undefined
          }
        >
          <UserMessageBody
            text={props.text}
            terminalContexts={props.terminalContexts}
            skills={props.skills}
            markdownCwd={props.markdownCwd}
          />
        </div>
      ) : null}
      {canCollapse || props.footer ? (
        <div
          className={cn(
            'mt-1.5 flex items-center gap-2',
            canCollapse && props.footer ? 'justify-between' : 'justify-end',
          )}
          data-user-message-footer="true"
        >
          {canCollapse ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              aria-expanded={expanded}
              data-scroll-anchor-ignore
              onClick={() => setExpanded((value) => !value)}
              className="-ml-1 h-6 rounded-md px-1.5 text-xs text-muted-foreground/72 hover:bg-muted/55 hover:text-foreground/85"
            >
              {expanded ? 'Show less' : 'Show full message'}
            </Button>
          ) : null}
          {props.footer ? (
            <div className="ml-auto flex items-center gap-2">{props.footer}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
})

const UserMessageBody = memo(function UserMessageBody(props: {
  text: string
  terminalContexts: ParsedTerminalContextEntry[]
  skills: ReadonlyArray<Pick<ServerProviderSkill, 'name' | 'displayName'>>
  markdownCwd: string | undefined
})
{
  const ctx = use(TimelineRowCtx)
  const renderInlineMarkdownSegment = (text: string, key: string) =>
  {
    const leadingWhitespace = /^\s+/.exec(text)?.[0] ?? ''
    const textWithoutLeadingWhitespace = text.slice(leadingWhitespace.length)
    const trailingWhitespace = /\s+$/.exec(textWithoutLeadingWhitespace)?.[0] ?? ''
    const content = textWithoutLeadingWhitespace.slice(
      0,
      textWithoutLeadingWhitespace.length - trailingWhitespace.length,
    )

    return (
      <Fragment key={key}>
        {leadingWhitespace ? <span aria-hidden="true">{leadingWhitespace}</span> : null}
        {content ? (
          <ChatMarkdown
            text={content}
            cwd={props.markdownCwd}
            threadRef={ctx.threadRef ?? undefined}
            skills={props.skills}
            className="text-foreground"
            lineBreaks
          />
        ) : null}
        {trailingWhitespace ? <span aria-hidden="true">{trailingWhitespace}</span> : null}
      </Fragment>
    )
  }

  const reviewCommentSegments = parseReviewCommentMessageSegments(props.text)
  if (reviewCommentSegments.some((segment) => segment.kind === 'review-comment'))
  {
    return (
      <div className="space-y-3 text-sm leading-relaxed text-foreground">
        {reviewCommentSegments.map((segment) =>
          segment.kind === 'text' ? (
            segment.text.trim().length > 0 ? (
              <div key={segment.id} className="wrap-break-word">
                <ChatMarkdown
                  text={segment.text.trim()}
                  cwd={props.markdownCwd}
                  threadRef={ctx.threadRef ?? undefined}
                  skills={props.skills}
                  className="text-foreground"
                  lineBreaks
                />
              </div>
            ) : null
          ) : (
            <UserMessageReviewCommentCard key={segment.comment.id} comment={segment.comment} />
          ),
        )}
      </div>
    )
  }

  if (props.terminalContexts.length > 0)
  {
    const hasEmbeddedInlineLabels = textContainsInlineTerminalContextLabels(
      props.text,
      props.terminalContexts,
    )
    const inlinePrefix = buildInlineTerminalContextText(props.terminalContexts)
    const inlineNodes: ReactNode[] = []

    if (hasEmbeddedInlineLabels)
    {
      let cursor = 0

      for (const context of props.terminalContexts)
      {
        const label = formatInlineTerminalContextLabel(context.header)
        const matchIndex = props.text.indexOf(label, cursor)
        if (matchIndex === -1)
        {
          inlineNodes.length = 0
          break
        }
        if (matchIndex > cursor)
        {
          inlineNodes.push(
            renderInlineMarkdownSegment(
              props.text.slice(cursor, matchIndex),
              `user-terminal-context-inline-before:${context.header}:${cursor}`,
            ),
          )
        }
        inlineNodes.push(
          <UserMessageTerminalContextInlineLabel
            key={`user-terminal-context-inline:${context.header}`}
            context={context}
          />,
        )
        cursor = matchIndex + label.length
      }

      if (inlineNodes.length > 0)
      {
        if (cursor < props.text.length)
        {
          inlineNodes.push(
            renderInlineMarkdownSegment(
              props.text.slice(cursor),
              `user-message-terminal-context-inline-rest:${cursor}`,
            ),
          )
        }

        return (
          <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
            {inlineNodes}
          </div>
        )
      }
    }

    for (const context of props.terminalContexts)
    {
      inlineNodes.push(
        <UserMessageTerminalContextInlineLabel
          key={`user-terminal-context-inline:${context.header}`}
          context={context}
        />,
      )
      inlineNodes.push(
        <span key={`user-terminal-context-inline-space:${context.header}`} aria-hidden="true">
          {' '}
        </span>,
      )
    }

    if (props.text.length > 0)
    {
      inlineNodes.push(
        <ChatMarkdown
          key="user-message-terminal-context-inline-text"
          text={props.text}
          cwd={props.markdownCwd}
          threadRef={ctx.threadRef ?? undefined}
          skills={props.skills}
          className="text-foreground"
          lineBreaks
        />,
      )
    }
    else if (inlinePrefix.length === 0)
    {
      return null
    }

    return (
      <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
        {inlineNodes}
      </div>
    )
  }

  if (props.text.length === 0)
  {
    return null
  }

  return (
    <ChatMarkdown
      text={props.text}
      cwd={props.markdownCwd}
      threadRef={ctx.threadRef ?? undefined}
      skills={props.skills}
      className="text-foreground"
      lineBreaks
    />
  )
})

function UserMessageReviewCommentCard({ comment }: { comment: ReviewCommentContext })
{
  const ctx = use(TimelineRowCtx)
  const syntaxThemeName = useSyntaxThemeName()
  const fenceLanguage = comment.fenceLanguage ?? 'diff'
  const renderablePatch = getRenderablePatch(
    buildReviewCommentRenderablePatch(comment),
    `review-comment:${comment.id}`,
  )

  return (
    <div className="space-y-2 rounded-lg border border-border/70 bg-background/70 p-3">
      <div className="space-y-1">
        <div className="text-xs font-medium text-foreground">
          {formatWorkspaceRelativePath(comment.filePath, ctx.workspaceRoot)}
        </div>
        <div className="text-[11px] text-muted-foreground">
          {comment.sectionTitle} · {comment.rangeLabel}
        </div>
      </div>
      {comment.text.length > 0 && (
        <div className="whitespace-pre-wrap wrap-break-word text-sm">
          <SkillInlineText text={comment.text} skills={ctx.skills} />
        </div>
      )}
      {fenceLanguage !== 'diff' && comment.diff.trim().length > 0 && (
        <ChatMarkdown
          text={formatReviewCommentFence(fenceLanguage, comment.diff)}
          cwd={ctx.markdownCwd}
          threadRef={ctx.threadRef ?? undefined}
          skills={ctx.skills}
          className="text-foreground"
        />
      )}
      {renderablePatch?.kind === 'files' &&
        renderablePatch.files.map((fileDiff) => (
          <FileDiff
            key={resolveFileDiffPath(fileDiff)}
            fileDiff={fileDiff}
            options={{
              collapsed: false,
              diffStyle: 'unified',
              theme: syntaxThemeName,
            }}
          />
        ))}
      {renderablePatch?.kind === 'raw' && (
        <pre className="overflow-x-auto rounded-md bg-muted/40 p-2 text-xs">
          {renderablePatch.text}
        </pre>
      )}
    </div>
  )
}

// pure helpers

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
  const showWarningIndicator = workEntry.sourceActivityKind === 'runtime.warning'
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

export { TimelineRowActivityCtx, TimelineRowContent, TimelineRowCtx }
