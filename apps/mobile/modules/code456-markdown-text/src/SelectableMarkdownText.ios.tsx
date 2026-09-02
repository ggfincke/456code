// apps/mobile/modules/code456-markdown-text/src/SelectableMarkdownText.ios.tsx
// render selectable markdown text ios

import { useMemo } from 'react'
import { View } from 'react-native'
import { parseMarkdownWithOptions, type MarkdownNode } from 'react-native-nitro-markdown/headless'

import {
  nativeMarkdownChunkSpacing,
  nativeMarkdownDocumentChunks,
  nativeMarkdownDocumentRuns,
  nativeMarkdownWithPreservedSoftBreaks,
} from './nativeMarkdownText'
import { NativeMarkdownBlock } from './NativeMarkdownBlock.ios'
import {
  MarkdownFileActionsContext,
  NativeMarkdownSelectableText,
} from './NativeMarkdownSelectableText.ios'
import type {
  SelectableMarkdownSkill,
  SelectableMarkdownTextProps,
} from './SelectableMarkdownText.types'

const EMPTY_SKILLS: ReadonlyArray<SelectableMarkdownSkill> = []

export type {
  MarkdownCodeHighlighter,
  MarkdownHighlightedToken,
  NativeMarkdownTextStyle,
  SelectableMarkdownSkill,
  SelectableMarkdownTextProps,
} from './SelectableMarkdownText.types'

export function hasNativeSelectableMarkdownText(): boolean
{
  return true
}

export function SelectableMarkdownText({
  markdown,
  skills = EMPTY_SKILLS,
  textStyle,
  highlightCode,
  preserveSoftBreaks = false,
  onLinkPress,
  fileContextMenu,
  onFileContextMenuAction,

  marginTop = 0,
  marginBottom = 0,
}: SelectableMarkdownTextProps)
{
  const fileActions = useMemo(
    () => ({ fileContextMenu, onFileContextMenuAction }),
    [fileContextMenu, onFileContextMenuAction],
  )
  const chunks = useMemo(() =>
  {
    let parsedDocument: MarkdownNode
    try
    {
      parsedDocument = parseMarkdownWithOptions(markdown, {
        gfm: true,
        html: true,
        math: false,
      })
    }
    catch
    {
      return undefined
    }
    const document = preserveSoftBreaks
      ? nativeMarkdownWithPreservedSoftBreaks(parsedDocument)
      : parsedDocument
    return nativeMarkdownDocumentChunks(document).map((chunk) =>
      chunk.kind === 'selectable'
        ? {
            ...chunk,
            runs: nativeMarkdownDocumentRuns(chunk.node, skills),
          }
        : chunk,
    )
  }, [markdown, preserveSoftBreaks, skills])

  return (
    <MarkdownFileActionsContext.Provider value={fileActions}>
        {/* a percentage width creates cyclic measurement in shrink-to-fit message bubbles. */}
        <View style={{ flexShrink: 1, minWidth: 0, marginTop, marginBottom }}>
          {chunks === undefined ? (
            <NativeMarkdownSelectableText
              runs={[{ text: markdown }]}
              textStyle={textStyle}
              onLinkPress={onLinkPress}
              fileContextMenu={fileContextMenu}
              onFileContextMenuAction={onFileContextMenuAction}
            />
          ) : (
            chunks.map((chunk, index) =>
              {
              const content =
                chunk.kind === 'rich' ? (
                  <NativeMarkdownBlock
                    node={chunk.node}
                    textStyle={textStyle}
                    highlightCode={highlightCode}
                    onLinkPress={onLinkPress}
                  />
                ) : (
                  <NativeMarkdownSelectableText
                    runs={chunk.runs}
                    textStyle={textStyle}
                    onLinkPress={onLinkPress}
                  />
                )

              return (
                <View
                  key={chunk.key}
                  style={{ paddingTop: nativeMarkdownChunkSpacing(chunks[index - 1], chunk) }}
                >
                  {content}
                </View>
              )
            })
          )}
        </View>
    </MarkdownFileActionsContext.Provider>
  )
}
