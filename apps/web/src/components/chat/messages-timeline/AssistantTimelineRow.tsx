// apps/web/src/components/chat/messages-timeline/AssistantTimelineRow.tsx
// render assistant message rows and changed-files sections

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

export function AssistantTimelineRow({ row }: { row: Extract<TimelineRow, { kind: 'message' }> })
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
