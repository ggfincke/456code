// apps/mobile/src/features/threads/feed/ThreadFeedRows.tsx
// renders mobile thread feed messages and activity rows

import type { EnvironmentId, TurnId } from '@t3tools/contracts'
import { formatElapsed } from '@t3tools/shared/orchestrationTiming'
import { memo, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  ActivityIndicator,
  Image,
  Linking,
  Text as NativeText,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  useColorScheme,
  View,
  type ColorValue,
} from 'react-native'
import { TouchableOpacity } from 'react-native-gesture-handler'
import {
  Markdown,
  type CustomRenderers,
  type NodeStyleOverrides,
  type PartialMarkdownTheme,
} from 'react-native-nitro-markdown'
import Animated, { FadeIn, FadeInUp } from 'react-native-reanimated'
import { SymbolView } from '../../../components/AppSymbol'
import { useFontFamily } from '../../../lib/useFontFamily'
import { useThemeColor } from '../../../lib/useThemeColor'
import {
  hasNativeSelectableMarkdownText,
  SelectableMarkdownText,
  type NativeMarkdownTextStyle,
  type SelectableMarkdownSkill,
} from '../../../native/SelectableMarkdownText'

import { markdownFileIconSource } from '@t3tools/mobile-markdown-text/file-icons'
import { resolveMarkdownLinkPresentation } from '@t3tools/mobile-markdown-text/links'
import { AppText as Text } from '../../../components/AppText'
import { CopyTextButton } from '../../../components/CopyTextButton'
import {
  resolveMarkdownFontSizes,
  resolveNativeMarkdownTypography,
} from '../../../lib/appearancePreferences'
import { cn } from '../../../lib/cn'
import { type ThreadFeedEntry } from '../../../lib/threadActivity'
import { useAssetUrl } from '../../../state/assets'
import { resolveNativeReviewDiffView } from '../../diffs/nativeReviewDiffSurface'
import {
  buildNativeReviewDiffData,
  createNativeReviewDiffTheme,
  NATIVE_REVIEW_DIFF_CONTENT_WIDTH,
} from '../../review/nativeReviewDiffAdapter'
import {
  parseReviewCommentMessageSegments,
  type ReviewInlineComment,
} from '../../review/reviewCommentSelection'
import { buildReviewParsedDiff } from '../../review/reviewModel'
import type { ReviewDiffTheme } from '../../review/shikiReviewHighlighter'
import { useAppearancePreferences } from '../../settings/appearance/AppearancePreferencesProvider'
import { useAppearanceCodeSurface } from '../../settings/appearance/useAppearanceCodeSurface'
import { useMarkdownCodeHighlight } from '../markdownCodeHighlightState'
import { ThreadWorkGroupToggle, ThreadWorkLog } from '../thread-work-log'

import type { ThreadFeedProps } from '../ThreadFeed'
const MESSAGE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
})
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
  const uri = useAssetUrl(props.environmentId, {
    _tag: 'attachment',
    attachmentId: props.attachmentId,
  })

  if (uri === null)
  {
    return (
      <View className={`${props.className} items-center justify-center`}>
        <ActivityIndicator />
      </View>
    )
  }

  return (
    <TouchableOpacity activeOpacity={0.7} onPress={() => props.onPressImage(uri)}>
      <Image source={{ uri }} className={props.className} resizeMode="cover" />
    </TouchableOpacity>
  )
}

const MARKDOWN_COLORS = {
  light: {
    body: '#111111',
    strong: '#000000',
    link: '#2563eb',
    blockquoteBorder: 'rgba(0, 0, 0, 0.08)',
    blockquoteBackground: 'rgba(0, 0, 0, 0.02)',
    codeBackground: 'rgba(0, 0, 0, 0.04)',
    codeText: '#262626',
    inlineCodeText: '#5f6368',
    horizontalRule: 'rgba(0, 0, 0, 0.08)',
    userBody: '#ffffff',
    userCodeBackground: 'rgba(255, 255, 255, 0.22)',
    userCodeText: '#ffffff',
    userInlineCodeText: 'rgba(255, 255, 255, 0.82)',
    userFenceBackground: 'rgba(0, 0, 0, 0.16)',
    userFenceText: '#ffffff',
  },
  dark: {
    body: '#e5e5e5',
    strong: '#f5f5f5',
    link: '#60a5fa',
    blockquoteBorder: 'rgba(255, 255, 255, 0.1)',
    blockquoteBackground: 'rgba(255, 255, 255, 0.03)',
    codeBackground: 'rgba(255, 255, 255, 0.06)',
    codeText: '#e5e5e5',
    inlineCodeText: '#b8bcc2',
    horizontalRule: 'rgba(255, 255, 255, 0.08)',
    userBody: '#ffffff',
    userCodeBackground: 'rgba(255, 255, 255, 0.18)',
    userCodeText: '#ffffff',
    userInlineCodeText: 'rgba(255, 255, 255, 0.82)',
    userFenceBackground: 'rgba(0, 0, 0, 0.28)',
    userFenceText: '#ffffff',
  },
} as const

const MARKDOWN_MONO_FONT = Platform.select({
  ios: 'ui-monospace',
  android: 'monospace',
  default: 'monospace',
})

export interface MarkdownStyleSets
{
  readonly user: MarkdownStyleSet
  readonly assistant: MarkdownStyleSet
}

interface MarkdownStyleSet
{
  readonly theme: PartialMarkdownTheme
  readonly styles: NodeStyleOverrides
  readonly renderers: CustomRenderers
  readonly nativeTextStyle: NativeMarkdownTextStyle
}

export interface ReviewCommentColors
{
  readonly background: ColorValue
  readonly border: ColorValue
  readonly mutedBackground: ColorValue
  readonly text: ColorValue
  readonly mutedText: ColorValue
  readonly codeBackground: ColorValue
}

const failedMarkdownFaviconHosts = new Set<string>()
const markdownLinkStyles = StyleSheet.create({
  inlineIcon: {
    width: 14,
    height: 14,
    marginHorizontal: 3,
    transform: [{ translateY: 2 }],
  },
  favicon: {
    borderRadius: 3,
  },
})

const MarkdownExternalLink = memo(function MarkdownExternalLink(props: {
  readonly children: ReactNode
  readonly color: string
  readonly host: string
  readonly href: string
})
{
  const [failed, setFailed] = useState(() => failedMarkdownFaviconHosts.has(props.host))

  return (
    <NativeText
      className="font-sans"
      onPress={() =>
      {
        void Linking.openURL(props.href)
      }}
      style={{
        color: props.color,
        textDecorationLine: 'none',
      }}
    >
      {!failed ? (
        <Image
          source={{
            uri: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(props.host)}&sz=32`,
          }}
          style={[markdownLinkStyles.inlineIcon, markdownLinkStyles.favicon]}
          onError={() =>
            {
            failedMarkdownFaviconHosts.add(props.host)
            setFailed(true)
          }}
        />
      ) : (
        <NativeText style={{ color: props.color }}>{' ◉ '}</NativeText>
      )}
      {props.children}
    </NativeText>
  )
})

function MarkdownCodeBlock(props: {
  readonly backgroundColor: string
  readonly borderColor: string
  readonly content: string
  readonly copyTintColor: ColorValue
  readonly headerTextColor: string
  readonly fontSize: number
  readonly highlightCode: boolean
  readonly language?: string | null
  readonly lineHeight: number
  readonly textColor: string
  readonly theme: ReviewDiffTheme
})
{
  const content = props.content.replace(/\n$/, '')
  const languageLabel = props.language?.trim() || 'text'
  const highlighted = useMarkdownCodeHighlight({
    code: content,
    enabled: props.highlightCode && Boolean(props.language?.trim()),
    language: props.language,
    theme: props.theme,
  })
  let tokenOffset = 0

  return (
    <View
      className="my-3 min-w-0 max-w-full self-stretch overflow-hidden rounded-lg border"
      style={{ backgroundColor: props.backgroundColor, borderColor: props.borderColor }}
    >
      <View
        className="flex-row items-center justify-between gap-2 border-b py-1 pr-1.5 pl-3.5"
        style={{ borderBottomColor: props.borderColor }}
      >
        <NativeText
          className="flex-1 font-mono uppercase opacity-70"
          numberOfLines={1}
          style={{
            color: props.headerTextColor,
            fontSize: props.fontSize,
            ...(Platform.OS === 'android' ? { includeFontPadding: false } : null),
          }}
        >
          {languageLabel}
        </NativeText>
        <CopyTextButton
          accessibilityLabel="Copy code"
          text={content}
          tintColor={props.copyTintColor}
          buttonSize={32}
          iconSize={16}
        />
      </View>
      <ScrollView
        horizontal
        bounces={false}
        nestedScrollEnabled={Platform.OS === 'android'}
        showsHorizontalScrollIndicator={false}
        contentContainerClassName="px-3.5 py-3"
      >
        <NativeText
          selectable
          className="font-mono"
          style={{
            color: props.textColor,
            fontSize: props.fontSize,
            lineHeight: props.lineHeight,
            ...(Platform.OS === 'android' ? { includeFontPadding: false } : null),
          }}
        >
          {highlighted
            ? highlighted.map((line, lineIndex) =>
              {
                const lineStartOffset = tokenOffset
                const lineText = line.map((token) => token.content).join('')
                const renderedLine = (
                  <NativeText key={`line:${lineStartOffset}:${lineText}`}>
                    {line.map((token) =>
                      {
                      const startOffset = tokenOffset
                      tokenOffset += token.content.length
                      const fontStyle =
                        token.fontStyle !== null && (token.fontStyle & 1) === 1
                          ? ('italic' as const)
                          : ('normal' as const)
                      const fontWeight =
                        token.fontStyle !== null && (token.fontStyle & 2) === 2
                          ? ('700' as const)
                          : ('400' as const)

                      return (
                        <NativeText
                          key={`${startOffset}:${token.content}:${token.color ?? ''}:${
                            token.fontStyle ?? ''
                          }`}
                          style={{
                            color: token.color ?? props.textColor,
                            fontStyle,
                            fontWeight,
                          }}
                        >
                          {token.content}
                        </NativeText>
                      )
                    })}
                    {lineIndex + 1 < highlighted.length ? '\n' : ''}
                  </NativeText>
                )
                if (lineIndex + 1 < highlighted.length)
                  {
                  tokenOffset += 1
                }
                return renderedLine
              })
            : content}
        </NativeText>
      </ScrollView>
    </View>
  )
}

export function useReviewCommentColors(): ReviewCommentColors
{
  const colorScheme = useColorScheme()
  const isDark = colorScheme === 'dark'
  const background = isDark ? '#151515' : '#ffffff'
  const border = isDark ? '#2a2a2a' : '#d7d7d7'
  const mutedBackground = isDark ? '#242424' : '#f2f2f2'
  const text = isDark ? '#f3f3f3' : '#111111'
  const mutedText = isDark ? '#8f8f8f' : '#666666'
  const codeBackground = isDark ? '#0f0f0f' : '#ffffff'

  return useMemo(
    () => ({
      background,
      border,
      mutedBackground,
      text,
      mutedText,
      codeBackground,
    }),
    [background, border, codeBackground, mutedBackground, mutedText, text],
  )
}

export function useMarkdownStyles(onLinkPress: (href: string) => void): MarkdownStyleSets
{
  const colorScheme = useColorScheme()
  const { appearance } = useAppearancePreferences()
  const markdownFontSizes = useMemo(
    () => resolveMarkdownFontSizes(appearance.baseFontSize),
    [appearance.baseFontSize],
  )
  const nativeMarkdownTypography = useMemo(
    () => resolveNativeMarkdownTypography(appearance.baseFontSize),
    [appearance.baseFontSize],
  )
  const themeMode = colorScheme === 'dark' ? 'dark' : 'light'
  const colors = MARKDOWN_COLORS[themeMode]
  const iconSubtleColor = String(useThemeColor('--color-icon-subtle'))
  const inlineSkillForeground = String(useThemeColor('--color-inline-skill-foreground'))
  const userBubbleForegroundMuted = String(useThemeColor('--color-user-bubble-foreground-muted'))
  const regularFontFamily = useFontFamily('regular')
  const boldFontFamily = useFontFamily('bold')

  return useMemo(() =>
  {
    const markdownBodyColor = colors.body
    const markdownStrongColor = colors.strong
    const markdownLinkColor = colors.link
    const markdownBlockquoteBg = colors.blockquoteBackground
    const markdownBlockquoteBorder = colors.blockquoteBorder
    const markdownCodeBg = colors.codeBackground
    const markdownCodeText = colors.codeText
    const markdownInlineCodeText = colors.inlineCodeText
    const markdownHrColor = colors.horizontalRule
    const markdownUserBodyColor = colors.userBody
    const markdownUserCodeBg = colors.userCodeBackground
    const markdownUserCodeText = colors.userCodeText
    const markdownUserInlineCodeText = colors.userInlineCodeText
    const markdownUserFenceBg = colors.userFenceBackground
    const markdownUserFenceText = colors.userFenceText

    const baseTheme: PartialMarkdownTheme = {
      colors: {
        text: markdownBodyColor,
        heading: markdownStrongColor,
        link: markdownLinkColor,
        blockquote: markdownBlockquoteBorder,
        border: markdownHrColor,
        surface: 'transparent',
        surfaceLight: markdownBlockquoteBg,
        accent: markdownLinkColor,
        tableBorder: markdownHrColor,
        tableHeader: markdownBlockquoteBg,
        tableHeaderText: markdownStrongColor,
        tableRowOdd: 'transparent',
        tableRowEven: 'transparent',
      },
      spacing: {
        xs: 4,
        s: 4,
        m: 8,
        l: 8,
        xl: 16,
      },
      fontSizes: {
        s: markdownFontSizes.s,
        m: markdownFontSizes.m,
        h1: markdownFontSizes.h1,
        h2: markdownFontSizes.h2,
        h3: markdownFontSizes.h3,
        h4: markdownFontSizes.h4,
        h5: markdownFontSizes.h5,
        h6: markdownFontSizes.h6,
      },
      fontFamilies: {
        regular: regularFontFamily,
        heading: boldFontFamily,
        mono: MARKDOWN_MONO_FONT,
      },
      headingWeight: '700',
      borderRadius: {
        s: 4,
        m: 8,
        l: 12,
      },
      showCodeLanguage: false,
    }

    const baseStyles: NodeStyleOverrides = {
      document: { flexShrink: 1 },
      paragraph: { marginTop: 0, marginBottom: 10 },
      list: { marginTop: 4, marginBottom: 8 },
      list_item: { marginTop: 0, marginBottom: 4 },
      task_list_item: { marginTop: 0, marginBottom: 4 },
      text: { lineHeight: markdownFontSizes.bodyLineHeight },
      bold: {
        fontWeight: '700',
        color: markdownStrongColor,
        fontFamily: boldFontFamily,
      },
      italic: { fontStyle: 'italic' },
      link: {
        color: markdownLinkColor,
        textDecorationLine: 'underline' as const,
      },
      blockquote: {
        borderLeftWidth: 2,
        borderLeftColor: markdownBlockquoteBorder,
        paddingLeft: 11,
        paddingVertical: 2,
        marginLeft: 0,
        marginVertical: 10,
      },
      heading: {
        fontFamily: boldFontFamily,
        color: markdownStrongColor,
        marginTop: 18,
        marginBottom: 8,
      },
      horizontal_rule: {
        backgroundColor: markdownHrColor,
        height: 1,
        marginVertical: 12,
      },
    }

    const createMarkdownRenderers = (
      inlineTextColor: string,
      inlineCodeTextColor: string,
      blockBackgroundColor: string,
      blockTextColor: string,
      copyTintColor: ColorValue,
      preserveSoftBreaks: boolean,
      highlightCode: boolean,
    ): CustomRenderers => ({
      link: ({ children, href = '' }) =>
      {
        const presentation = resolveMarkdownLinkPresentation(href)
        if (presentation.kind === 'file')
        {
          return (
            <NativeText
              className="font-sans-bold"
              onPress={() => onLinkPress(href)}
              style={{ color: inlineTextColor }}
            >
              <Image
                source={markdownFileIconSource(presentation.icon)}
                style={markdownLinkStyles.inlineIcon}
              />
              {presentation.label}
            </NativeText>
          )
        }
        if (presentation.kind === 'external')
        {
          return (
            <MarkdownExternalLink
              href={presentation.href}
              host={presentation.host}
              color={markdownLinkColor}
            >
              {children}
            </MarkdownExternalLink>
          )
        }
        const linkHref = presentation.href
        return (
          <NativeText
            className="underline"
            onPress={
              linkHref
                ? () =>
                  {
                    void Linking.openURL(linkHref)
                  }
                : undefined
            }
            style={{ color: markdownLinkColor }}
          >
            {children}
          </NativeText>
        )
      },
      list: ({ node, Renderer, ordered = false, start = 1 }) => (
        <View className="mt-0.5 mb-2">
          {node.children?.map((child, index) =>
          {
            const childKey = `${child.type}:${child.beg ?? 'unknown'}:${child.end ?? 'unknown'}`
            if (child.type === 'task_list_item')
            {
              return (
                <Renderer key={childKey} node={child} depth={1} inListItem parentIsText={false} />
              )
            }
            return (
              <View className="mb-[3px] flex-row items-start" key={childKey}>
                <NativeText
                  className="font-sans"
                  style={{
                    width: ordered ? 22 : 12,
                    marginRight: 5,
                    color: inlineTextColor,
                    fontSize: markdownFontSizes.m,
                    lineHeight: markdownFontSizes.bodyLineHeight,
                    textAlign: ordered ? 'right' : 'center',
                  }}
                >
                  {ordered ? `${start + index}.` : '•'}
                </NativeText>
                <View className="min-w-0 flex-1">
                  <Renderer node={child} depth={1} inListItem parentIsText={false} />
                </View>
              </View>
            )
          })}
        </View>
      ),
      code_inline: ({ content }) =>
      {
        const value = content ?? ''
        return (
          <NativeText
            className="font-mono"
            style={{
              color: inlineCodeTextColor,
              fontSize: markdownFontSizes.codeBlockFontSize,
              lineHeight: markdownFontSizes.bodyLineHeight,
            }}
          >
            {value}
          </NativeText>
        )
      },
      ...(preserveSoftBreaks
        ? {
            soft_break: () => <NativeText>{'\n'}</NativeText>,
          }
        : {}),
      code_block: ({ content = '', language }) => (
        <MarkdownCodeBlock
          backgroundColor={blockBackgroundColor}
          borderColor={markdownHrColor}
          content={content}
          copyTintColor={copyTintColor}
          fontSize={markdownFontSizes.codeBlockFontSize}
          headerTextColor={blockTextColor}
          highlightCode={highlightCode}
          language={language}
          lineHeight={markdownFontSizes.codeBlockLineHeight}
          textColor={blockTextColor}
          theme={themeMode}
        />
      ),
    })

    const userTheme: PartialMarkdownTheme = {
      ...baseTheme,
      colors: {
        ...baseTheme.colors,
        text: markdownUserBodyColor,
        heading: markdownUserBodyColor,
        link: markdownUserBodyColor,
        code: markdownUserCodeText,
        codeBackground: markdownUserCodeBg,
        border: markdownUserFenceBg,
      },
    }
    const userStyles: NodeStyleOverrides = {
      ...baseStyles,
      paragraph: { marginTop: 0, marginBottom: 0 },
      bold: {
        fontWeight: '700',
        color: markdownUserBodyColor,
        fontFamily: boldFontFamily,
      },
      heading: {
        ...baseStyles.heading,
        color: markdownUserBodyColor,
        marginTop: 8,
        marginBottom: 4,
      },
      link: {
        color: markdownUserBodyColor,
        textDecorationLine: 'underline' as const,
      },
    }

    const assistantTheme: PartialMarkdownTheme = {
      ...baseTheme,
      colors: {
        ...baseTheme.colors,
        code: markdownCodeText,
        codeBackground: markdownCodeBg,
        border: markdownCodeBg,
      },
    }
    const assistantStyles: NodeStyleOverrides = {
      ...baseStyles,
    }

    return {
      user: {
        theme: userTheme,
        styles: userStyles,
        renderers: createMarkdownRenderers(
          markdownUserCodeText,
          markdownUserInlineCodeText,
          markdownUserFenceBg,
          markdownUserFenceText,
          userBubbleForegroundMuted,
          true,
          false,
        ),
        nativeTextStyle: {
          color: markdownUserBodyColor,
          strongColor: markdownUserBodyColor,
          mutedColor: markdownUserBodyColor,
          linkColor: markdownUserBodyColor,
          inlineCodeColor: markdownUserInlineCodeText,
          codeColor: markdownUserCodeText,
          codeBackgroundColor: markdownUserCodeBg,
          codeBlockBackgroundColor: markdownUserFenceBg,
          fileTextColor: '#ffffff',
          skillTextColor: '#f0abfc',
          quoteMarkerColor: markdownUserBodyColor,
          dividerColor: markdownUserBodyColor,
          fontSize: nativeMarkdownTypography.fontSize,
          lineHeight: nativeMarkdownTypography.lineHeight,
          headingFontSizes: nativeMarkdownTypography.headingFontSizes,
          fontFamily: regularFontFamily,
          headingFontFamily: boldFontFamily,
          boldFontFamily,
        },
      },
      assistant: {
        theme: assistantTheme,
        styles: assistantStyles,
        renderers: createMarkdownRenderers(
          markdownCodeText,
          markdownInlineCodeText,
          markdownCodeBg,
          markdownCodeText,
          iconSubtleColor,
          false,
          true,
        ),
        nativeTextStyle: {
          color: markdownBodyColor,
          strongColor: markdownStrongColor,
          mutedColor: markdownBodyColor,
          linkColor: markdownLinkColor,
          inlineCodeColor: markdownInlineCodeText,
          codeColor: markdownCodeText,
          codeBackgroundColor: markdownCodeBg,
          codeBlockBackgroundColor: markdownCodeBg,
          fileTextColor: markdownCodeText,
          skillTextColor: inlineSkillForeground,
          quoteMarkerColor: markdownBlockquoteBorder,
          dividerColor: markdownHrColor,
          fontSize: nativeMarkdownTypography.fontSize,
          lineHeight: nativeMarkdownTypography.lineHeight,
          headingFontSizes: nativeMarkdownTypography.headingFontSizes,
          fontFamily: regularFontFamily,
          headingFontFamily: boldFontFamily,
          boldFontFamily,
        },
      },
    }
  }, [
    boldFontFamily,
    colors,
    iconSubtleColor,
    inlineSkillForeground,
    markdownFontSizes,
    nativeMarkdownTypography,
    onLinkPress,
    regularFontFamily,
    themeMode,
    userBubbleForegroundMuted,
  ])
}

export function renderFeedEntry(
  info: { item: ThreadFeedEntry; index: number },
  props: Pick<ThreadFeedProps, 'environmentId' | 'skills'> & {
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
        className="mb-3 min-h-11 flex-row items-center gap-2 border-b border-neutral-200/80 px-2 dark:border-white/[0.08]"
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
    const styles = isUser ? markdownStyles.user : markdownStyles.assistant
    const timestampLabel = formatMessageTime(isUser ? message.createdAt : message.updatedAt)
    const attachments = message.attachments ?? []
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
                text={message.text}
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
            <Text className="font-sans-medium text-xs tabular-nums text-neutral-600 dark:text-neutral-400">
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
    if (message.text.trim().length === 0 && attachments.length === 0)
    {
      return null
    }

    const enterAnimated = isFreshTimestamp(message.createdAt)
    return (
      <Animated.View
        className={cn(showAssistantMeta ? 'mb-5 px-1' : 'mb-2 px-1')}
        {...(enterAnimated ? { entering: FadeIn.duration(220) } : {})}
      >
        {message.text.trim().length > 0 ? (
          hasNativeSelectableMarkdownText() ? (
            <SelectableMarkdownText
              markdown={message.text}
              skills={props.skills}
              textStyle={styles.nativeTextStyle}
              onLinkPress={props.onMarkdownLinkPress}
            />
          ) : (
            <Markdown
              options={{ gfm: true }}
              renderers={styles.renderers}
              styles={styles.styles}
              theme={styles.theme}
            >
              {message.text}
            </Markdown>
          )
        ) : null}
        {attachments.map((attachment) =>
        {
          return (
            <MessageAttachmentImage
              key={attachment.id}
              environmentId={props.environmentId}
              attachmentId={attachment.id}
              className="mt-1.5 aspect-[1.3] w-full rounded-[18px] bg-neutral-200 dark:bg-neutral-800"
              onPressImage={props.onPressImage}
            />
          )
        })}
        {showAssistantMeta ? (
          <View className="mt-1 flex-row items-center gap-1">
            <CopyTextButton
              accessibilityLabel="Copy message"
              text={message.text}
              tintColor={iconSubtleColor}
              buttonSize={28}
              iconSize={13}
            />
            <Text className="font-sans-medium text-xs tabular-nums text-neutral-600 dark:text-neutral-400">
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
        <View className="h-1 w-1 rounded-full bg-neutral-400 dark:bg-neutral-500" />
        <View className="h-1 w-1 rounded-full bg-neutral-400/80 dark:bg-neutral-500/80" />
        <View className="h-1 w-1 rounded-full bg-neutral-400/60 dark:bg-neutral-500/60" />
      </View>
      <Text className="font-sans-medium text-xs tabular-nums text-neutral-600 dark:text-neutral-400">
        Working for {durationLabel}
      </Text>
    </View>
  )
})

function UserMessageContent(props: {
  readonly text: string
  readonly markdownStyles: MarkdownStyleSet
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

const ReviewCommentCard = memo(function ReviewCommentCard(props: {
  readonly comment: ReviewInlineComment
  readonly colors: ReviewCommentColors
})
{
  const { codeSurface, nativeReviewDiffStyle } = useAppearanceCodeSurface()
  const colorScheme = useColorScheme()
  const appearanceScheme = colorScheme === 'light' ? 'light' : 'dark'
  const NativeReviewDiffView = resolveNativeReviewDiffView()
  const patch = useMemo(() => buildReviewCommentPatch(props.comment), [props.comment])
  const parsedDiff = useMemo(
    () => buildReviewParsedDiff(patch, `thread-review-comment:${props.comment.id}`),
    [patch, props.comment.id],
  )
  const nativeReviewDiffData = useMemo(() => buildNativeReviewDiffData(parsedDiff), [parsedDiff])
  const compactNativeRows = useMemo(
    () => nativeReviewDiffData.rows.filter((row) => row.kind !== 'file'),
    [nativeReviewDiffData.rows],
  )
  const nativeReviewDiffTheme = useMemo(
    () => createNativeReviewDiffTheme(appearanceScheme),
    [appearanceScheme],
  )
  const nativeRowsJson = useMemo(() => JSON.stringify(compactNativeRows), [compactNativeRows])
  const nativeThemeJson = useMemo(
    () => JSON.stringify(nativeReviewDiffTheme),
    [nativeReviewDiffTheme],
  )
  const nativeStyleJson = useMemo(
    () => JSON.stringify(nativeReviewDiffStyle),
    [nativeReviewDiffStyle],
  )
  const nativeDiffHeight = useMemo(
    () =>
      Math.min(
        360,
        Math.max(
          112,
          compactNativeRows.length * nativeReviewDiffStyle.rowHeight +
            nativeReviewDiffStyle.fileHeaderVerticalMargin,
        ),
      ),
    [compactNativeRows.length, nativeReviewDiffStyle],
  )
  const shouldRenderNativeDiff = NativeReviewDiffView != null && compactNativeRows.length > 0

  return (
    <View
      className="w-full overflow-hidden rounded-[16px] border border-continuous"
      style={{
        backgroundColor: props.colors.background,
        borderColor: props.colors.border,
      }}
    >
      <View
        className="flex-row items-center gap-2 border-b px-3 py-2"
        style={{ borderColor: props.colors.border }}
      >
        <View
          className="size-6 items-center justify-center rounded-[7px] border-continuous"
          style={{ backgroundColor: props.colors.mutedBackground }}
        >
          <SymbolView
            name="doc.text"
            size={13}
            tintColor={props.colors.mutedText}
            type="monochrome"
          />
        </View>
        <View className="min-w-0 flex-1">
          <Text
            className="font-mono text-xs"
            numberOfLines={1}
            style={{ color: props.colors.text }}
          >
            {compactFileName(props.comment.filePath)}
          </Text>
        </View>
      </View>
      {shouldRenderNativeDiff ? (
        <View
          className="border-t"
          collapsable={false}
          style={{
            backgroundColor: nativeReviewDiffTheme.background,
            borderColor: props.colors.border,
            height: nativeDiffHeight,
          }}
        >
          <NativeReviewDiffView
            collapsable={false}
            style={StyleSheet.absoluteFill}
            appearanceScheme={appearanceScheme}
            contentWidth={NATIVE_REVIEW_DIFF_CONTENT_WIDTH}
            rowHeight={nativeReviewDiffStyle.rowHeight}
            rowsJson={nativeRowsJson}
            styleJson={nativeStyleJson}
            themeJson={nativeThemeJson}
          />
        </View>
      ) : props.comment.diff.trim().length > 0 ? (
        <ScrollView
          horizontal
          nestedScrollEnabled
          directionalLockEnabled
          showsHorizontalScrollIndicator={false}
          bounces={false}
          className="border-t"
          style={{ backgroundColor: props.colors.codeBackground, borderColor: props.colors.border }}
          contentContainerStyle={{ padding: 10 }}
        >
          <NativeText
            selectable
            className="font-mono"
            style={{
              color: props.colors.text,
              fontSize: codeSurface.fontSize,
              lineHeight: codeSurface.rowHeight,
            }}
          >
            {props.comment.diff.trim()}
          </NativeText>
        </ScrollView>
      ) : null}
      {props.comment.text.length > 0 ? (
        <View className="border-t px-3 py-3" style={{ borderColor: props.colors.border }}>
          <Text selectable className="text-base leading-snug" style={{ color: props.colors.text }}>
            {props.comment.text}
          </Text>
        </View>
      ) : null}
    </View>
  )
})

function buildReviewCommentPatch(comment: ReviewInlineComment): string
{
  if ((comment.fenceLanguage ?? 'diff') !== 'diff')
  {
    return ''
  }
  const diff = comment.diff.trim()
  if (!diff)
  {
    return ''
  }

  if (diff.startsWith('diff --git '))
  {
    return diff
  }

  const normalizedPath = comment.filePath.replaceAll('\\', '/')
  return [
    `diff --git a/${normalizedPath} b/${normalizedPath}`,
    `--- a/${normalizedPath}`,
    `+++ b/${normalizedPath}`,
    diff,
  ].join('\n')
}

function compactFileName(filePath: string): string
{
  const normalized = filePath.replaceAll('\\', '/')
  const lastSlashIndex = normalized.lastIndexOf('/')
  return lastSlashIndex >= 0 ? normalized.slice(lastSlashIndex + 1) : normalized
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
