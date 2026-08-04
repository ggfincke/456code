// apps/mobile/src/native/SelectableMarkdownText.ios.tsx
// render selectable markdown text ios

import {
  SelectableMarkdownText as NativeSelectableMarkdownText,
  type SelectableMarkdownTextProps,
} from '@t3tools/mobile-markdown-text/renderer'

import { highlightCodeSnippet } from '../features/review/shikiReviewHighlighter'

type MobileSelectableMarkdownTextProps = Omit<SelectableMarkdownTextProps, 'highlightCode'>

export type {
  NativeMarkdownTextStyle,
  SelectableMarkdownSkill,
} from '@t3tools/mobile-markdown-text/types'

export function hasNativeSelectableMarkdownText(): boolean
{
  return true
}

export function SelectableMarkdownText(props: MobileSelectableMarkdownTextProps)
{
  return <NativeSelectableMarkdownText {...props} highlightCode={highlightCodeSnippet} />
}
