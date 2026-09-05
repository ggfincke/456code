// apps/mobile/src/features/threads/feed/feedMarkdown.tsx
// markdown style sets and code-block rendering for thread feed rows

import { memo, useMemo, useState, type ReactNode } from 'react'
import {
  Image,
  Linking,
  ScrollView,
  StyleSheet,
  Text as NativeText,
  useColorScheme,
  View,
  type ColorValue,
} from 'react-native'
import type {
  CustomRenderers,
  NodeStyleOverrides,
  PartialMarkdownTheme,
} from 'react-native-nitro-markdown'
import { markdownFileIconSource } from '@t3tools/mobile-markdown-text/file-icons'
import { resolveMarkdownLinkPresentation } from '@t3tools/mobile-markdown-text/links'
import { faviconUrlForOrigin } from '@t3tools/shared/favicon'
import { CopyTextButton } from '../../../components/CopyTextButton'
import {
  resolveMarkdownFontSizes,
  resolveNativeMarkdownTypography,
} from '../../../lib/appearancePreferences'
import type { NativeMarkdownTextStyle } from '../../../native/SelectableMarkdownText'
import { useAppearancePreferences } from '../../settings/appearance/AppearancePreferencesProvider'
import { useFontFamily } from '../../../lib/useFontFamily'
import { useThemeColor } from '../../../lib/useThemeColor'
import { useMarkdownCodeHighlight } from '../markdownCodeHighlightState'
import type { ReviewDiffTheme } from '../../review/shikiReviewHighlighter'

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

const MARKDOWN_MONO_FONT = 'ui-monospace'

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

export const MarkdownExternalLink = memo(function MarkdownExternalLink(props: {
  readonly children: ReactNode
  readonly color: string
  readonly host: string
  readonly href: string
})
{
  const [failedHost, setFailedHost] = useState<string | null>(null)
  const faviconUrl = faviconUrlForOrigin(`https://${props.host}`)

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
      {faviconUrl !== null &&
      failedHost !== props.host &&
      !failedMarkdownFaviconHosts.has(props.host) ? (
        <Image
          source={{
            uri: faviconUrl,
          }}
          style={[markdownLinkStyles.inlineIcon, markdownLinkStyles.favicon]}
          onError={() =>
            {
            failedMarkdownFaviconHosts.add(props.host)
            setFailedHost(props.host)
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
