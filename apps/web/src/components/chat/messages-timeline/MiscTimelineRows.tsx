// apps/web/src/components/chat/messages-timeline/MiscTimelineRows.tsx
// render turn-fold, plan, provider-switch, and worker-verdict timeline rows

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

export function TurnFoldTimelineRow({ row }: { row: Extract<TimelineRow, { kind: 'turn-fold' }> })
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

export function ProposedPlanTimelineRow({
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
export function ProviderSwitchTimelineRow({
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

export function WorkerVerdictTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: 'worker-verdict' }>
})
{
  const { jobId, verdict } = row.workerVerdict
  const shortJobId = jobId.length > 12 ? `${jobId.slice(0, 12)}…` : jobId

  return (
    <div className="border-b border-border/60 px-1 pb-2 pt-1 text-xs">
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 text-[10px] text-muted-foreground">
          Verdict · <span className="font-mono">{shortJobId}</span>
        </span>
        <span className="min-w-0 flex-1 break-words text-foreground">{verdict}</span>
      </div>
    </div>
  )
}
