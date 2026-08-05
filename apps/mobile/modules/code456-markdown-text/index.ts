// apps/mobile/modules/code456-markdown-text/index.ts
// expose markdown file icon source

export { markdownFileIconSource } from './src/markdownFileIcons'
export {
  resolveMarkdownFileIcon,
  resolveMarkdownLinkPresentation,
  type MarkdownFileIcon,
  type MarkdownLinkPresentation,
} from './src/markdownLinks'
export {
  nativeMarkdownChunkSpacing,
  nativeMarkdownDocumentChunks,
  nativeMarkdownDocumentRuns,
  nativeMarkdownListItemBlocks,
  nativeMarkdownTextRuns,
  type NativeMarkdownDocumentChunk,
  type NativeMarkdownTextRun,
} from './src/nativeMarkdownText'
export { MarkdownTextPrimitive } from './src/MarkdownTextPrimitive'
export {
  SelectableMarkdownText,
  type MarkdownCodeHighlighter,
  type MarkdownHighlightedToken,
} from './src/SelectableMarkdownText'
export type {
  NativeMarkdownTextStyle,
  SelectableMarkdownSkill,
  SelectableMarkdownTextProps,
} from './src/SelectableMarkdownText.types'
