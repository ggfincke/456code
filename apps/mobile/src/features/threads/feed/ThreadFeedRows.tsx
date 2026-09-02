// apps/mobile/src/features/threads/feed/ThreadFeedRows.tsx
// renders mobile thread feed messages and activity rows

import { ChatImageAttachment, type EnvironmentId, type TurnId } from '@t3tools/contracts'
import * as Schema from 'effect/Schema'
import { formatElapsed } from '@t3tools/shared/orchestrationTiming'
import { memo, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Image, Pressable, View } from 'react-native'
import { TouchableOpacity } from 'react-native-gesture-handler'
import { Markdown } from 'react-native-nitro-markdown'
import Animated, { FadeIn, FadeInUp } from 'react-native-reanimated'
import { SymbolView, type AppSymbolName } from '../../../components/AppSymbol'
import {
  codexArtifactTemplatePresentationLabel,
  type CodexArtifactTemplate,
} from '@t3tools/client-runtime/codex-artifact-templates'
import {
  renderCodexFileCitationsAsMarkdown,
  splitCodexArtifactTemplateMarkdown,
} from '@t3tools/client-runtime/codex-markdown-directives'
import { renderAssistantCitationsAsText } from '@t3tools/shared/assistantCitations'
import {
  hasNativeSelectableMarkdownText,
  SelectableMarkdownText,
  type SelectableMarkdownSkill,
} from '../../../native/SelectableMarkdownText'

import { AppText as Text } from '../../../components/AppText'
import { CopyTextButton } from '../../../components/CopyTextButton'
import { cn } from '../../../lib/cn'
import { type ThreadFeedEntry } from '../../../lib/threadActivity'
import { useAssetUrl } from '../../../state/assets'
import { parseReviewCommentMessageSegments } from '../../review/reviewCommentSelection'
import { ThreadWorkGroupToggle, ThreadWorkLog } from '../thread-work-log'

import type { ThreadFeedProps } from '../ThreadFeed'
import { type MarkdownStyleSets, type ReviewCommentColors } from './feedMarkdown'
import { ReviewCommentCard } from './feedReviewCommentCard'

export type { MarkdownStyleSets, ReviewCommentColors } from './feedMarkdown'
export { useMarkdownStyles, useReviewCommentColors } from './feedMarkdown'

const MESSAGE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
})
const isImageAttachment = Schema.is(ChatImageAttachment)
function formatMessageTime(input: string): string
{
  const timestamp = Date.parse(input)
  if (Number.isNaN(timestamp))
  {
    return ''
  }
  return MESSAGE_TIME_FORMATTER.format(timestamp)
}

// entering animations must only play for rows born just now — LegendList
// remounts rows when they scroll back into view, and replaying an entrance for
// old content would be its own kind of jank.
const FRESH_ENTRY_WINDOW_MS = 3_000
function isFreshTimestamp(input: string): boolean
{
  const timestamp = Date.parse(input)
  return Number.isFinite(timestamp) && Date.now() - timestamp < FRESH_ENTRY_WINDOW_MS
}

function MessageAttachmentImage(props: {
  readonly environmentId: EnvironmentId
  readonly attachmentId: string
  readonly className: string
  readonly onPressImage: (uri: string, headers?: Record<string, string>) => void
})
{
  const asset = useAssetUrl(props.environmentId, {
    _tag: 'attachment',
    attachmentId: props.attachmentId,
  })

  if (asset._tag === 'Failure')
  {
    return (
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Retry attachment preview"
        className={`${props.className} items-center justify-center bg-subtle`}
        onPress={asset.retry}
      >
        <Text className="text-center text-xs text-foreground-muted">Tap to retry</Text>
      </TouchableOpacity>
    )
  }

  if (asset._tag !== 'Success')
  {
    return (
      <View className={`${props.className} items-center justify-center`}>
        <ActivityIndicator />
      </View>
    )
  }

  return (
    <TouchableOpacity activeOpacity={0.7} onPress={() => props.onPressImage(asset.url)}>
      <Image source={{ uri: asset.url }} className={props.className} resizeMode="cover" />
    </TouchableOpacity>
  )
}

const ARTIFACT_TEMPLATE_SYMBOL_BY_KIND: Record<
  CodexArtifactTemplate['artifactKind'],
  AppSymbolName
> = {
  document: 'doc.text',
  presentation: 'chart.bar.xaxis',
  spreadsheet: 'chart.bar.xaxis',
  site: 'safari',
  'google-docs': 'doc.text',
  'google-slides': 'chart.bar.xaxis',
  'google-sheets': 'chart.bar.xaxis',
  image: 'camera',
  email: 'text.bubble',
  slack: 'text.bubble',
}

function ArtifactTemplateCard(props: {
  readonly template: CodexArtifactTemplate
  readonly onUse?: ((template: CodexArtifactTemplate) => void) | undefined
})
{
  return (
    <View className="my-2 min-w-0 flex-row items-center gap-3 rounded-2xl border border-border bg-card px-3 py-3">
      <View className="relative h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-subtle">
        <SymbolView
          name={ARTIFACT_TEMPLATE_SYMBOL_BY_KIND[props.template.artifactKind]}
          size={20}
          tintColorClassName="accent-foreground-muted"
          type="monochrome"
        />
      </View>
      <View className="min-w-0 flex-1">
        <Text className="font-t3-bold text-sm text-foreground" numberOfLines={1}>
          {props.template.displayName}
        </Text>
        <Text className="text-xs text-foreground-muted">
          {codexArtifactTemplatePresentationLabel(props.template.artifactKind)}
        </Text>
      </View>
      {props.onUse ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Use ${props.template.displayName} template`}
          className="min-h-9 justify-center rounded-lg border border-border bg-subtle px-3 active:opacity-65"
          onPress={() => props.onUse?.(props.template)}
        >
          <Text className="font-t3-bold text-xs text-foreground">Use template</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

const AssistantMarkdownContent = memo(function AssistantMarkdownContent(props: {
  readonly markdown: string
  readonly markdownStyles: MarkdownStyleSets['assistant']
  readonly onLinkPress: (href: string) => void
  readonly onUseArtifactTemplate?: ((template: CodexArtifactTemplate) => void) | undefined
  readonly skills?: ReadonlyArray<SelectableMarkdownSkill> | undefined
})
{
  const segments = useMemo(
    () => splitCodexArtifactTemplateMarkdown(props.markdown),
    [props.markdown],
  )
  return segments.map((segment) =>
  {
    if (segment.kind === 'artifact-template')
    {
      return (
        <ArtifactTemplateCard
          key={`artifact-template:${segment.sourceOffset}`}
          template={segment.template}
          onUse={props.onUseArtifactTemplate}
        />
      )
    }
    if (segment.markdown.trim().length === 0) return null
    const markdown = renderCodexFileCitationsAsMarkdown(segment.markdown)
    return hasNativeSelectableMarkdownText() ? (
      <SelectableMarkdownText
        key={`markdown:${segment.sourceOffset}`}
        markdown={markdown}
        skills={props.skills}
        textStyle={props.markdownStyles.nativeTextStyle}
        onLinkPress={props.onLinkPress}
      />
    ) : (
      <Markdown
        key={`markdown:${segment.sourceOffset}`}
        options={{ gfm: true }}
        renderers={props.markdownStyles.renderers}

        styles={props.markdownStyles.styles}
        theme={props.markdownStyles.theme}
      >
        {markdown}
      </Markdown>
    )
  })
})

export function renderFeedEntry(
  info: { item: ThreadFeedEntry; index: number },
  props: Pick<ThreadFeedProps, 'environmentId' | 'onUseArtifactTemplate' | 'skills'> & {
    readonly copiedRowId: string | null
    readonly expandedWorkRows: Record<string, boolean>
    readonly terminalAssistantMessageIds: ReadonlySet<string>
    readonly unsettledTurnId: TurnId | null
    readonly onCopyWorkRow: (rowId: string, value: string) => void
    readonly onToggleWorkGroup: (groupId: string) => void
    readonly onToggleWorkRow: (rowId: string) => void
    readonly onToggleTurnFold: (turnId: TurnId) => void
    readonly onPressImage: (uri: string, headers?: Record<string, string>) => void
    readonly onMarkdownLinkPress: (href: string) => void
    readonly iconSubtleColor: string | import('react-native').ColorValue
    readonly userBubbleColor: string | import('react-native').ColorValue
    readonly markdownStyles: MarkdownStyleSets
    readonly reviewCommentColors: ReviewCommentColors
    readonly reviewCommentBubbleWidth: number
    readonly userBubbleMaxWidth: number
  },
)
{
  const entry = info.item
  const { markdownStyles, iconSubtleColor, userBubbleColor } = props

  if (entry.type === 'working')
  {
    return <WorkingTimelineRow startedAt={entry.createdAt} />
  }

  if (entry.type === 'turn-fold')
  {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: entry.expanded }}
        onPress={() => props.onToggleTurnFold(entry.turnId)}
        hitSlop={4}
        className="mb-3 min-h-11 flex-row items-center gap-2 border-b border-adaptive-neutral-200-a80-white-a8 px-2"
      >
        <Text className="font-sans-medium text-sm tabular-nums text-foreground-muted">
          {entry.label}
        </Text>
        <SymbolView
          name={entry.expanded ? 'chevron.down' : 'chevron.right'}
          size={15}
          tintColor={iconSubtleColor}
          type="monochrome"
        />
      </Pressable>
    )
  }

  if (entry.type === 'work-toggle')
  {
    return (
      <ThreadWorkGroupToggle
        expanded={entry.expanded}
        hiddenCount={entry.hiddenCount}
        iconSubtleColor={iconSubtleColor}
        onlyToolActivities={entry.onlyToolActivities}
        onToggle={() => props.onToggleWorkGroup(entry.groupId)}
      />
    )
  }

  if (entry.type === 'message')
  {
    const { message } = entry
    const isUser = message.role === 'user'
    const renderedText = renderAssistantCitationsAsText(message.text)
    const styles = isUser ? markdownStyles.user : markdownStyles.assistant
    const timestampLabel = formatMessageTime(isUser ? message.createdAt : message.updatedAt)
    const attachments = (message.attachments ?? []).filter(isImageAttachment)
    const hasReviewCommentContext = message.text.includes('<review_comment')
    const assistantTurnStillInProgress =
      message.role === 'assistant' &&
      props.unsettledTurnId !== null &&
      message.turnId === props.unsettledTurnId
    const showAssistantMeta =
      message.role === 'assistant' &&
      props.terminalAssistantMessageIds.has(message.id) &&
      !assistantTurnStillInProgress &&
      !message.streaming

    if (isUser)
    {
      const enterAnimated = isFreshTimestamp(message.createdAt)
      return (
        <Animated.View
          className="mb-5 items-end"
          {...(enterAnimated ? { entering: FadeInUp.duration(220) } : {})}
        >
          <View
            className="min-w-0 gap-2 rounded-[20px] px-3.5 py-2.5"
            style={{
              backgroundColor: userBubbleColor,
              maxWidth: props.userBubbleMaxWidth,
              ...(hasReviewCommentContext ? { width: props.reviewCommentBubbleWidth } : null),
            }}
          >
            {message.text.trim().length > 0 ? (
              <UserMessageContent
                text={renderedText}
                markdownStyles={styles}
                reviewCommentColors={props.reviewCommentColors}
                skills={props.skills}
                onLinkPress={props.onMarkdownLinkPress}
              />
            ) : null}
            {attachments.map((attachment) =>
            {
              return (
                <MessageAttachmentImage
                  key={attachment.id}
                  environmentId={props.environmentId}
                  attachmentId={attachment.id}
                  className="aspect-[1.3] w-full rounded-[14px] bg-white/15"
                  onPressImage={props.onPressImage}
                />
              )
            })}
          </View>
          <View className="mt-1 flex-row items-center justify-end gap-1 pr-0.5">
            <Text className="font-sans-medium text-xs tabular-nums text-adaptive-neutral-600-400">
              {timestampLabel}
            </Text>
            {message.text.trim().length > 0 ? (
              <CopyTextButton
                accessibilityLabel="Copy message"
                text={message.text}
                tintColor={iconSubtleColor}
                buttonSize={28}
                iconSize={13}
              />
            ) : null}
          </View>
        </Animated.View>
      )
    }

    // skip empty assistant messages (no text, no attachments) — they would
    // render as an orphaned timestamp and break adjacent activity-group merging.
    if (renderedText.trim().length === 0 && attachments.length === 0)
    {
      return null
    }

    const enterAnimated = isFreshTimestamp(message.createdAt)
    return (
      <Animated.View
        className={cn(showAssistantMeta ? 'mb-5 px-1' : 'mb-2 px-1')}
        {...(enterAnimated ? { entering: FadeIn.duration(220) } : {})}
      >
        {renderedText.trim().length > 0 ? (
          <AssistantMarkdownContent
            markdown={renderedText}
            markdownStyles={styles}
            onLinkPress={props.onMarkdownLinkPress}
            onUseArtifactTemplate={props.onUseArtifactTemplate}
            skills={props.skills}
          />
        ) : null}
        {attachments.map((attachment) =>
        {
          return (
            <MessageAttachmentImage
              key={attachment.id}
              environmentId={props.environmentId}
              attachmentId={attachment.id}
              className="mt-1.5 aspect-[1.3] w-full rounded-[18px] bg-adaptive-neutral-200-800"
              onPressImage={props.onPressImage}
            />
          )
        })}
        {showAssistantMeta ? (
          <View className="mt-1 flex-row items-center gap-1">
            <CopyTextButton
              accessibilityLabel="Copy message"
              text={renderedText}
              tintColor={iconSubtleColor}
              buttonSize={28}
              iconSize={13}
            />
            <Text className="font-sans-medium text-xs tabular-nums text-adaptive-neutral-600-400">
              {timestampLabel}
            </Text>
          </View>
        ) : null}
      </Animated.View>
    )
  }

  return (
    <ThreadWorkLog
      activities={entry.activities}
      copiedRowId={props.copiedRowId}
      expandedRows={props.expandedWorkRows}
      iconSubtleColor={iconSubtleColor}
      onCopyRow={props.onCopyWorkRow}
      onToggleRow={props.onToggleWorkRow}
    />
  )
}

const WorkingTimelineRow = memo(function WorkingTimelineRow(props: { readonly startedAt: string })
{
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() =>
  {
    const intervalId = setInterval(() =>
    {
      setNowMs(Date.now())
    }, 1_000)
    return () => clearInterval(intervalId)
  }, [props.startedAt])

  const durationLabel = formatElapsed(props.startedAt, new Date(nowMs).toISOString()) ?? '0s'

  return (
    <View className="mb-4 flex-row items-center gap-2 px-1.5 py-1">
      <View className="flex-row items-center gap-1">
        <View className="h-1 w-1 rounded-full bg-adaptive-neutral-400-500" />
        <View className="h-1 w-1 rounded-full bg-adaptive-neutral-400-a80-500-a80" />
        <View className="h-1 w-1 rounded-full bg-adaptive-neutral-400-a60-500-a60" />
      </View>
      <Text className="font-sans-medium text-xs tabular-nums text-adaptive-neutral-600-400">
        Working for {durationLabel}
      </Text>
    </View>
  )
})

function UserMessageContent(props: {
  readonly text: string
  readonly markdownStyles: MarkdownStyleSets['user']
  readonly reviewCommentColors: ReviewCommentColors
  readonly skills?: ReadonlyArray<SelectableMarkdownSkill>
  readonly onLinkPress: (href: string) => void
})
{
  const segments = parseReviewCommentMessageSegments(props.text)
  const hasReviewComment = segments.some((segment) => segment.kind === 'review-comment')
  if (!hasReviewComment)
  {
    if (hasNativeSelectableMarkdownText())
    {
      return (
        <SelectableMarkdownText
          markdown={props.text}
          skills={props.skills}
          textStyle={props.markdownStyles.nativeTextStyle}
          preserveSoftBreaks
          onLinkPress={props.onLinkPress}
        />
      )
    }
    return (
      <Markdown
        options={{ gfm: true }}
        renderers={props.markdownStyles.renderers}
        styles={props.markdownStyles.styles}
        theme={props.markdownStyles.theme}
      >
        {props.text}
      </Markdown>
    )
  }

  return (
    <View className="w-full gap-2">
      {segments.map((segment) =>
      {
        if (segment.kind === 'review-comment')
        {
          return (
            <ReviewCommentCard
              key={segment.comment.id}
              comment={segment.comment}
              colors={props.reviewCommentColors}
            />
          )
        }

        const text = segment.text.trim()
        if (text.length === 0)
        {
          return null
        }

        return hasNativeSelectableMarkdownText() ? (
          <SelectableMarkdownText
            key={segment.id}
            markdown={text}
            skills={props.skills}
            textStyle={props.markdownStyles.nativeTextStyle}
            preserveSoftBreaks
            onLinkPress={props.onLinkPress}
          />
        ) : (
          <Markdown
            key={segment.id}
            options={{ gfm: true }}
            renderers={props.markdownStyles.renderers}
            styles={props.markdownStyles.styles}
            theme={props.markdownStyles.theme}
          >
            {text}
          </Markdown>
        )
      })}
    </View>
  )
}

export function ThreadFeedPlaceholder(props: {
  readonly bottomInset: number
  readonly detail: string
  readonly horizontalPadding: number
  readonly title: string
  readonly topInset: number
})
{
  return (
    <View
      style={{
        flex: 1,
        flexGrow: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingTop: props.topInset,
        paddingBottom: props.bottomInset,
        paddingHorizontal: props.horizontalPadding + 24,
      }}
    >
      <View className="max-w-[320px] items-center gap-2">
        <Text className="text-center font-sans-bold text-lg text-foreground">{props.title}</Text>
        <Text className="text-center text-sm leading-normal text-foreground-secondary">
          {props.detail}
        </Text>
      </View>
    </View>
  )
}
