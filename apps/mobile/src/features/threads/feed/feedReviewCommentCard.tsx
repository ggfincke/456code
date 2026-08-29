// apps/mobile/src/features/threads/feed/feedReviewCommentCard.tsx
// review-inline comment card for thread feed rows

import { memo, useMemo } from 'react'
import { ScrollView, StyleSheet, Text as NativeText, useColorScheme, View } from 'react-native'
import { SymbolView } from '../../../components/AppSymbol'
import { AppText as Text } from '../../../components/AppText'
import { resolveNativeReviewDiffView } from '../../diffs/nativeReviewDiffSurface'
import {
  buildNativeReviewDiffData,
  createNativeReviewDiffTheme,
  NATIVE_REVIEW_DIFF_CONTENT_WIDTH,
} from '../../review/nativeReviewDiffAdapter'
import type { ReviewInlineComment } from '../../review/reviewCommentSelection'
import { buildReviewParsedDiff } from '../../review/reviewModel'
import { useAppearanceCodeSurface } from '../../settings/appearance/useAppearanceCodeSurface'
import type { ReviewCommentColors } from './feedMarkdown'

export const ReviewCommentCard = memo(function ReviewCommentCard(props: {
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
