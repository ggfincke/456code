// apps/web/src/components/chat/messages-timeline/UserTimelineRow.tsx
// render user message timeline rows and collapsible bodies

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
  NetworkIcon,
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
  extractTrailingArchitectureContext,
  formatArchitectureConcernAuthority,
  formatArchitectureConcernLabel,
  formatArchitectureConcernTooltip,
  type ArchitectureConcernContext,
} from '~/composer-drafts/architectureContext'
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
import { formatChatTimestampTooltip, formatDayAwareTimestamp } from '../../../timestampFormat'
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
  type TimelineMessage,
  type TimelineRow,
  type TimelineWorkEntry,
} from './timelineRowContext'

function splitTrailingReviewComments(value: string): {
  promptText: string
  comments: ReviewCommentContext[]
}
{
  const segments = parseReviewCommentMessageSegments(value)
  const firstCommentIndex = segments.findIndex((segment) => segment.kind === 'review-comment')
  if (firstCommentIndex === -1)
  {
    return { promptText: value, comments: [] }
  }

  const trailingSegments = segments.slice(firstCommentIndex)
  const hasTrailingText = trailingSegments.some(
    (segment) => segment.kind === 'text' && segment.text.trim().length > 0,
  )
  if (hasTrailingText)
  {
    return { promptText: value, comments: [] }
  }

  const promptText = segments
    .slice(0, firstCommentIndex)
    .flatMap((segment) => (segment.kind === 'text' ? [segment.text] : []))
    .join('')
  const comments = trailingSegments.flatMap((segment) =>
    segment.kind === 'review-comment' ? [segment.comment] : [],
  )
  return { promptText, comments }
}

export function UserTimelineRow({ row }: { row: Extract<TimelineRow, { kind: 'message' }> })
{
  const ctx = use(TimelineRowCtx)
  const userImages = row.message.attachments ?? []
  const reviewCommentState = splitTrailingReviewComments(row.message.text)
  const architectureContexts: ArchitectureConcernContext[] = []
  let promptWithoutArchitectureContexts = reviewCommentState.promptText
  while (true)
  {
    const extracted = extractTrailingArchitectureContext(promptWithoutArchitectureContexts)
    if (!extracted.context) break
    architectureContexts.unshift(extracted.context)
    promptWithoutArchitectureContexts = extracted.promptText
  }
  const previewAnnotations: ParsedPreviewAnnotation[] = []
  let promptWithoutPreviewAnnotations = promptWithoutArchitectureContexts
  while (true)
  {
    const extracted = extractTrailingPreviewAnnotation(promptWithoutPreviewAnnotations)
    if (!extracted.annotation) break
    previewAnnotations.unshift(extracted.annotation)
    promptWithoutPreviewAnnotations = extracted.promptText
  }
  const displayedUserMessage = deriveDisplayedUserMessageState(promptWithoutPreviewAnnotations)
  const terminalContexts = displayedUserMessage.contexts
  const elementContexts = displayedUserMessage.elementContexts
  const visibleText =
    reviewCommentState.comments.length === 0
      ? displayedUserMessage.visibleText
      : [
          displayedUserMessage.visibleText.trim(),
          ...reviewCommentState.comments.map(formatReviewCommentContext),
        ]
          .filter((text) => text.length > 0)
          .join('\n\n')
  const previewImages = userImages.filter((image) => image.name.startsWith('preview-annotation-'))
  const regularImages = userImages.filter((image) => !image.name.startsWith('preview-annotation-'))
  const canRevertAgentWork = ctx.canRevertConversation && typeof row.revertTurnCount === 'number'

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
        {architectureContexts.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {architectureContexts.map((context) => (
              <UserMessageArchitectureConcernChip key={context.id} context={context} />
            ))}
          </div>
        ) : null}
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
          text={visibleText}
          terminalContexts={terminalContexts}
          skills={ctx.skills}
          markdownCwd={ctx.markdownCwd}
        />
      </div>
      <div className="flex w-full max-w-[80%] items-center justify-end pe-1 text-xs tabular-nums opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
        <div className="flex shrink-0 items-center gap-2">
          <Tooltip>
            <TooltipTrigger render={<p className="text-muted-foreground text-xs tabular-nums" />}>
              {formatDayAwareTimestamp(row.message.createdAt, ctx.timestampFormat)}
            </TooltipTrigger>
            <TooltipPopup>
              {formatChatTimestampTooltip(row.message.createdAt, ctx.timestampFormat)}
            </TooltipPopup>
          </Tooltip>
          <div className="flex items-center gap-0.5">
            {canRevertAgentWork && <RevertUserMessageButton messageId={row.message.id} />}
            {row.message.text && <MessageCopyButton text={row.message.text} variant="ghost" />}
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

const UserMessageArchitectureConcernChip = memo(function UserMessageArchitectureConcernChip(props: {
  context: ArchitectureConcernContext
})
{
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/70 bg-background/70 px-1.5 py-0.5 text-xs text-foreground/85">
            <NetworkIcon aria-hidden="true" className="size-3 shrink-0" />
            <span className="truncate">{formatArchitectureConcernLabel(props.context)}</span>
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {formatArchitectureConcernAuthority(props.context)}
            </span>
          </span>
        }
      />
      <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap leading-tight">
        {formatArchitectureConcernTooltip(props.context)}
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
            parseRawHtml={false}
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
                  parseRawHtml={false}
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
          parseRawHtml={false}
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
      parseRawHtml={false}
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
          parseRawHtml={false}
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
