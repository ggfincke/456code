// apps/web/src/components/ChatMarkdown.tsx
// renders markdown, code fences, links, and interactive message content

import { useAtomValue } from '@effect/atom-react'
import { type DiffsThemeNames } from '@pierre/diffs'
import {
  CircleAlertIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  GlobeIcon,
  ImageIcon,
  MailIcon,
  MessageSquareIcon,
  PresentationIcon,
  SparklesIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from 'lucide-react'
import type {
  OrchestratePlanRevision,
  ScopedThreadRef,
  ServerProviderSkill,
} from '@t3tools/contracts'
import { isAtomCommandInterrupted } from '@t3tools/client-runtime/state/runtime'
import {
  classifyMarkdownImageSource,
  markdownImageSourceFragment,
} from '@t3tools/client-runtime/markdown-images'
import {
  codexArtifactTemplatePresentationLabel,
  type CodexArtifactTemplate,
  type CodexArtifactTemplateKind,
} from '@t3tools/client-runtime/codex-artifact-templates'
import {
  artifactTemplateFromHastProperties,
  CODEX_ARTIFACT_TEMPLATE_HAST_PROPERTIES,
  remarkCodexDirectives,
  renderCodexFileCitationsAsMarkdown,
} from '@t3tools/client-runtime/codex-markdown-directives'
import * as Cause from 'effect/Cause'
import { AsyncResult } from 'effect/unstable/reactivity'
import React, {
  Suspense,
  type CSSProperties,
  type ClipboardEvent as ReactClipboardEvent,
  type ComponentPropsWithoutRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  use,
  useCallback,
  memo,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import type { Components, ExtraProps, Options as ReactMarkdownOptions } from 'react-markdown'
import ReactMarkdown from 'react-markdown'
import { defaultUrlTransform } from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import { parseAssistantCitationHref } from '@t3tools/shared/assistantCitations'
import { AssistantCitationChip } from './chat/AssistantCitationChip'
import { renderSkillInlineMarkdownChildren } from './chat/SkillInlineText'
import { type ExpandedImagePreview } from './chat/ExpandedImagePreview'
import {
  OrchestratePlanCard,
  type OrchestratePlan,
  type OrchestratePlanActions,
  parseOrchestratePlanResult,
  resolvePersistedRevision,
} from './chat/orchestrate-plan/OrchestratePlanCard'
import {
  resolveExternalWebLinkHost,
  showExternalLinkContextMenu,
} from './chat/externalLinkContextMenu'
import { Tooltip, TooltipPopup, TooltipTrigger } from './ui/tooltip'
import { Button } from './ui/button'
import { Alert, AlertDescription, AlertTitle } from './ui/alert'
import { useOpenInPreferredEditor } from '../lib/editorPreferences'
import { useTheme } from '../hooks/useTheme'
import { useSyntaxThemeName } from '../hooks/useSyntaxThemeName'
import { chatMarkdownClipboardPayload } from '../lib/markdown/clipboard'
import { remarkLinkInlineCodePaths } from '../lib/markdown/inline-code-paths'
import { remarkNormalizeListItemIndentation } from '../lib/markdown/list-indentation'
import {
  isWindowsDrivePathHref,
  normalizeMarkdownLinkDestination,
  resolveMarkdownFileLinkMeta,
  rewriteMarkdownFileUriHref,
} from '../lib/markdown/links'
import {
  resolveWorkspaceFileActionTarget,
  WORKSPACE_BASENAME_LOOKUP_LIMIT,
  type WorkspaceFileActionSource,
} from '../lib/workspaceBasenameLookup'
import { readLocalApi } from '../localApi'
import { cn } from '../lib/utils'
import { useAssetUrlState } from '../assets/assetUrls'
import { useRightPanelStore } from '../rightPanelStore'
import { useActiveEnvironmentId } from '../state/entities'
import { projectEnvironment } from '../state/projects'
import { serverEnvironment } from '../state/server'
import { assetEnvironment } from '../state/assets'
import { usePreparedConnection } from '../state/session'
import { previewEnvironment } from '../state/preview'
import { useAtomCommand } from '../state/use-atom-command'
import { useAtomQueryRunner } from '../state/use-atom-query-runner'
import { writeTextToClipboard } from '../hooks/useCopyToClipboard'
import { isPreviewSupportedInRuntime } from '../previewStateStore'
import {
  openFileInPreview,
  openUrlInPreview,
  BrowserPreviewUnavailableError,
} from '../browser/openFileInPreview'
import { reportMarkdownActionFailure } from './markdown/actionFailure'
import {
  extractCodeBlock,
  extractFenceLanguage,
  extractFenceTitle,
  extractPreCodeMeta,
  MarkdownCodeBlock,
  MarkdownDetails,
  MarkdownTable,
  SuspenseShikiCodeBlock,
} from './markdown/codeBlocks'
import {
  buildFileLinkParentSuffixByPath,
  extractInlineCodeFilePaths,
  extractMarkdownLinkHrefs,
  handleMarkdownFragmentClick,
  isFilePathChipNode,
  MarkdownExternalLinkContent,
  MarkdownFileLink,
  normalizeMarkdownLinkHrefKey,
  plainHastText,
} from './markdown/links'
import { splitStreamingMarkdown, useBatchedStreamingText } from './markdown/streamingMarkdown'

export { splitStreamingMarkdown } from './markdown/streamingMarkdown'

class CodeHighlightErrorBoundary extends React.Component<
  { fallback: ReactNode; children: ReactNode },
  { hasError: boolean }
>
{
  constructor(props: { fallback: ReactNode; children: ReactNode })
  {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError()
  {
    return { hasError: true }
  }

  override render()
  {
    if (this.state.hasError)
    {
      return this.props.fallback
    }
    return this.props.children
  }
}

interface ChatMarkdownProps
{
  text: string
  cwd: string | undefined
  threadRef?: ScopedThreadRef | undefined
  onTaskListChange?: ((input: { markerOffset: number; checked: boolean }) => void) | undefined
  isStreaming?: boolean
  skills?: ReadonlyArray<Pick<ServerProviderSkill, 'name' | 'displayName'>>
  className?: string
  // treat single newlines as hard breaks — chat-style user input.
  lineBreaks?: boolean
  // parse sanitized raw HTML; user-authored messages disable this.
  parseRawHtml?: boolean
  onUseArtifactTemplate?: ((template: CodexArtifactTemplate) => void) | undefined
  imageBaseDir?: string | undefined
  onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined
  orchestratePlanActions?: OrchestratePlanActions | undefined
}

const EMPTY_MARKDOWN_SKILLS: ReadonlyArray<Pick<ServerProviderSkill, 'name' | 'displayName'>> = []

const ARTIFACT_TEMPLATE_ICON_BY_KIND = {
  document: FileTextIcon,
  presentation: PresentationIcon,
  spreadsheet: FileSpreadsheetIcon,
  site: GlobeIcon,
  'google-docs': FileTextIcon,
  'google-slides': PresentationIcon,
  'google-sheets': FileSpreadsheetIcon,
  image: ImageIcon,
  email: MailIcon,
  slack: MessageSquareIcon,
} satisfies Record<CodexArtifactTemplateKind, LucideIcon>

function CodexArtifactTemplateCard(props: {
  readonly template: CodexArtifactTemplate
  readonly onUse?: ((template: CodexArtifactTemplate) => void) | undefined
})
{
  const Icon = ARTIFACT_TEMPLATE_ICON_BY_KIND[props.template.artifactKind]
  const presentationLabel = codexArtifactTemplatePresentationLabel(props.template.artifactKind)
  return (
    <div
      role="group"
      aria-label={`${props.template.displayName} template`}
      className="chat-markdown-artifact-template my-[0.65rem] flex w-full min-w-0 items-center gap-3 rounded-xl border border-border/70 bg-card/60 px-3 py-2.5 text-foreground shadow-xs"
      data-artifact-kind={props.template.artifactKind}
      data-markdown-copy={`${props.template.displayName} (${presentationLabel})\n\n`}
      data-skill-name={props.template.skillName}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="relative flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background text-muted-foreground shadow-xs">
          <Icon aria-hidden className="size-5" />
          <span className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full border border-background bg-fuchsia-500 text-white shadow-xs">
            <SparklesIcon aria-hidden className="size-2.5" />
          </span>
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-foreground">
            {props.template.displayName}
          </span>
          <span className="block text-xs text-muted-foreground">{presentationLabel}</span>
        </span>
      </div>
      {props.onUse ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => props.onUse?.(props.template)}
        >
          Use template
        </Button>
      ) : null}
    </div>
  )
}

function findTaskListMarkerOffset(markdown: string, listItemStart: number): number | null
{
  const firstLineEnd = markdown.indexOf('\n', listItemStart)
  const firstLine = markdown.slice(
    listItemStart,
    firstLineEnd === -1 ? markdown.length : firstLineEnd,
  )
  const match = firstLine.match(/^(?:\s*(?:[-+*]|\d+[.)])\s+)(\[[ xX]\])/)
  if (!match?.[1]) return null
  return listItemStart + firstLine.indexOf(match[1])
}

// widen only lists whose final decimal marker no longer fits the default gutter.
export function orderedListGutterStyle(
  itemCount: number,
  start: number | undefined,
): { '--list-gutter': string } | undefined
{
  const firstNumber = typeof start === 'number' && Number.isFinite(start) ? start : 1
  const lastNumber = firstNumber + Math.max(itemCount - 1, 0)
  const digits = String(Math.abs(lastNumber)).length
  return digits > 2 ? { '--list-gutter': `${digits + 1}ch` } : undefined
}

function MarkdownOrderedList({
  node,
  start,
  style,
  ...props
}: ComponentPropsWithoutRef<'ol'> & ExtraProps)
{
  const itemCount =
    node?.children.filter((child) => child.type === 'element' && child.tagName === 'li').length ?? 0
  const gutterStyle = orderedListGutterStyle(itemCount, start)
  return <ol {...props} start={start} style={gutterStyle ? { ...style, ...gutterStyle } : style} />
}

type MarkdownAstNode = {
  type?: string
  meta?: unknown
  data?: {
    hProperties?: Record<string, unknown>
  }
  children?: MarkdownAstNode[]
}

type MarkdownImageHastNode = {
  type?: string
  value?: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: MarkdownImageHastNode[]
}

function soleBlockImage(node: MarkdownImageHastNode): MarkdownImageHastNode | undefined
{
  const children =
    node.children?.filter((child) => child.type !== 'text' || child.value?.trim()) ?? []
  if (children.length !== 1) return undefined
  const child = children[0]
  if (child?.tagName === 'img') return child
  return child && ['a', 'strong', 'em'].includes(child.tagName ?? '')
    ? soleBlockImage(child)
    : undefined
}

function remarkPreserveCodeMeta()
{
  return (tree: MarkdownAstNode) =>
  {
    const visit = (node: MarkdownAstNode) =>
    {
      if (node.type === 'code' && typeof node.meta === 'string' && node.meta.trim().length > 0)
      {
        node.data = {
          ...node.data,
          hProperties: {
            ...node.data?.hProperties,
            dataCodeMeta: node.meta.trim(),
          },
        }
      }
      node.children?.forEach(visit)
    }

    visit(tree)
  }
}

// carry authored image paths and titles through the raw HTML sanitizer.
function rehypePreserveImageSourceMeta()
{
  return (tree: MarkdownImageHastNode) =>
  {
    const visit = (node: MarkdownImageHastNode) =>
    {
      if (
        node.type === 'root' ||
        ['p', 'div', 'li', 'td', 'th', 'figure', 'center', 'blockquote'].includes(
          node.tagName ?? '',
        )
      )
      {
        const image = soleBlockImage(node)
        if (image) image.properties = { ...image.properties, dataStandalone: true }
      }
      const src = node.properties?.src
      const title = node.properties?.title
      if (node.type === 'element' && node.tagName === 'img')
      {
        node.properties = {
          ...node.properties,
          ...(typeof src === 'string' && isWindowsDrivePathHref(src) ? { dataLocalSrc: src } : {}),
          ...(typeof title === 'string' ? { dataMarkdownTitle: title } : {}),
        }
      }
      node.children?.forEach(visit)
    }

    visit(tree)
  }
}

const CHAT_MARKDOWN_SANITIZE_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    '*': (defaultSchema.attributes?.['*'] ?? []).filter((attribute) => attribute !== 'title'),
    code: [...(defaultSchema.attributes?.code ?? []), 'dataCodeMeta'],
    a: [...(defaultSchema.attributes?.a ?? []), 'dataFilePathChip'],
    div: [...(defaultSchema.attributes?.div ?? []), ...CODEX_ARTIFACT_TEMPLATE_HAST_PROPERTIES],
    img: [
      ...(defaultSchema.attributes?.img ?? []),
      'dataLocalSrc',
      'dataMarkdownTitle',
      'dataStandalone',
    ],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), 'file', 't3-citation'],
  },
} satisfies Parameters<typeof rehypeSanitize>[0]

const CHAT_MARKDOWN_REMARK_PLUGINS = [
  remarkGfm,
  remarkNormalizeListItemIndentation,
  remarkCodexDirectives,
  remarkPreserveCodeMeta,
  remarkLinkInlineCodePaths,
] satisfies NonNullable<ReactMarkdownOptions['remarkPlugins']>

const CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS = [
  remarkGfm,
  remarkNormalizeListItemIndentation,
  remarkCodexDirectives,
  remarkBreaks,
  remarkPreserveCodeMeta,
  remarkLinkInlineCodePaths,
] satisfies NonNullable<ReactMarkdownOptions['remarkPlugins']>

const CHAT_MARKDOWN_REHYPE_PLUGINS = [
  rehypeRaw,
  rehypePreserveImageSourceMeta,
  [rehypeSanitize, CHAT_MARKDOWN_SANITIZE_SCHEMA],
] satisfies NonNullable<ReactMarkdownOptions['rehypePlugins']>

export type ChatMarkdownOrchestrateFenceMount =
  | { kind: 'ignore' }
  | { kind: 'suppress' }
  | { kind: 'card'; plan: OrchestratePlan }
  | { kind: 'error'; diagnostic: string }

export function resolveChatMarkdownOrchestrateFence(input: {
  readonly language: string | null
  readonly code: string
  readonly isComplete: boolean
  readonly orchestratePlans: ReadonlyArray<OrchestratePlanRevision>
  readonly hasActions: boolean
}): ChatMarkdownOrchestrateFenceMount
{
  if (input.language !== 'orchestrate-plan') return { kind: 'ignore' }
  const result = parseOrchestratePlanResult(input.code, input.isComplete)
  if (result.status === 'incomplete') return { kind: 'ignore' }
  if (result.status === 'error') return { kind: 'error', diagnostic: result.diagnostic }
  if (!input.hasActions) return { kind: 'ignore' }
  const persisted = resolvePersistedRevision(
    input.orchestratePlans,
    result.plan.runId ?? null,
    result.plan.revision,
  )
  return persisted !== null ? { kind: 'suppress' } : { kind: 'card', plan: result.plan }
}

const MarkdownDocument = memo(function MarkdownDocument(props: {
  readonly text: string
  readonly components: Components
  readonly lineBreaks: boolean
  readonly parseRawHtml: boolean
  readonly urlTransform: NonNullable<ReactMarkdownOptions['urlTransform']>
})
{
  return (
    <ReactMarkdown
      remarkPlugins={
        props.lineBreaks ? CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS : CHAT_MARKDOWN_REMARK_PLUGINS
      }
      rehypePlugins={props.parseRawHtml ? CHAT_MARKDOWN_REHYPE_PLUGINS : undefined}
      skipHtml={false}
      components={props.components}
      urlTransform={props.urlTransform}
    >
      {props.text}
    </ReactMarkdown>
  )
})

const CHAT_MARKDOWN_IMAGE_BOUNDS_CLASS_NAME = 'max-h-[30rem] max-w-[min(100%,30rem)]'
const CHAT_MARKDOWN_IMAGE_SIZE_CLASS_NAME = cn(
  'h-auto w-auto object-contain',
  CHAT_MARKDOWN_IMAGE_BOUNDS_CLASS_NAME,
)
const CHAT_MARKDOWN_WORKSPACE_IMAGE_LAYOUT_CLASS_NAME = 'inline-block!'
const CHAT_MARKDOWN_WORKSPACE_IMAGE_CLASS_NAME = cn(
  CHAT_MARKDOWN_IMAGE_SIZE_CLASS_NAME,
  CHAT_MARKDOWN_WORKSPACE_IMAGE_LAYOUT_CLASS_NAME,
  'rounded-lg border border-border/40',
)

const MarkdownLinkContext = React.createContext(false)

function markdownImageCopy(alt: string, src: string, title: string | undefined): string
{
  const escapedAlt = alt.replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]')
  const titleSuffix =
    title === undefined ? '' : ` "${title.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
  return `![${escapedAlt}](${src}${titleSuffix})`
}

function authoredImageSizeStyle(
  width: string | number | undefined,
  height: string | number | undefined,
): CSSProperties | undefined
{
  const parsedWidth = Number(width)
  const parsedHeight = Number(height)
  const hasWidth = Number.isFinite(parsedWidth) && parsedWidth > 0
  const hasHeight = Number.isFinite(parsedHeight) && parsedHeight > 0
  if (hasWidth && hasHeight)
  {
    return {
      width: parsedWidth,
      height: 'auto',
      aspectRatio: `${parsedWidth} / ${parsedHeight}`,
      maxWidth: `min(100%, 30rem, ${(30 * parsedWidth) / parsedHeight}rem)`,
    }
  }
  if (hasWidth) return { maxWidth: `min(100%, 30rem, ${parsedWidth}px)` }
  if (hasHeight) return { maxHeight: `min(30rem, ${parsedHeight}px)` }
  return undefined
}

function expandableMarkdownImageProps(
  onImageExpand: ((preview: ExpandedImagePreview) => void) | undefined,
  src: string,
  alt: string,
)
{
  if (!onImageExpand) return {}
  const previewName = alt.trim() || 'image'
  const expand = (event: ReactMouseEvent | ReactKeyboardEvent) =>
  {
    if (event.currentTarget.closest('a')) return
    event.preventDefault()
    event.stopPropagation()
    onImageExpand({ images: [{ src, name: previewName }], index: 0 })
  }
  return {
    role: 'button' as const,
    tabIndex: 0,
    'aria-label': `Preview ${previewName}`,
    onClick: expand,
    onKeyDown: (event: ReactKeyboardEvent) =>
    {
      if (event.key === 'Enter' || event.key === ' ') expand(event)
    },
  }
}

function ChatMarkdownImageFallback(props: {
  readonly alt: string
  readonly copyMarkdown?: string | undefined
})
{
  return (
    <span
      data-markdown-copy={props.copyMarkdown}
      className={cn(
        CHAT_MARKDOWN_WORKSPACE_IMAGE_LAYOUT_CLASS_NAME,
        'rounded-md border border-border/40 bg-muted/40 px-2 py-1 text-xs text-muted-foreground',
      )}
    >
      <span className="inline-flex items-center gap-1.5">
        <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
        {props.alt.length > 0 ? `Image unavailable · ${props.alt}` : 'Image unavailable'}
      </span>
    </span>
  )
}

function ChatMarkdownImage(props: {
  readonly src: string | null
  readonly failed?: boolean | undefined
  readonly alt: string
  readonly copyMarkdown: string
  readonly standalone: boolean
  readonly style?: CSSProperties | undefined
  readonly imageProps?: ComponentPropsWithoutRef<'img'> | undefined
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined
})
{
  const [loaded, setLoaded] = useState<{ src: string; width: number; height: number } | null>(null)
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const failed = props.failed || (props.src !== null && props.src === failedSrc)
  const frame = props.standalone && (failed || loaded === null)
  const style =
    props.style ?? (loaded ? authoredImageSizeStyle(loaded.width, loaded.height) : undefined)
  const visibleSrc = loaded?.src ?? props.src
  const image = (src: string, hidden = false) => (
    <img
      {...props.imageProps}
      key={src}
      src={src}
      alt={hidden ? '' : props.alt}
      aria-hidden={hidden || undefined}
      loading="lazy"
      draggable={false}
      data-markdown-copy={hidden ? undefined : props.copyMarkdown}
      className={cn(
        CHAT_MARKDOWN_WORKSPACE_IMAGE_CLASS_NAME,
        props.imageProps?.className,
        props.onImageExpand && 'cursor-zoom-in',
      )}
      style={
        hidden
          ? { position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }
          : frame
            ? {
                ...style,
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                opacity: 0,
              }
            : style
      }
      {...(!hidden ? expandableMarkdownImageProps(props.onImageExpand, src, props.alt) : {})}
      onLoad={(event) =>
        setLoaded({
          src,
          width: event.currentTarget.naturalWidth,
          height: event.currentTarget.naturalHeight,
        })
      }
      onError={() => setFailedSrc(src)}
    />
  )
  if (failed && !props.standalone)
    return <ChatMarkdownImageFallback alt={props.alt} copyMarkdown={props.copyMarkdown} />
  return (
    <span
      data-markdown-copy={props.copyMarkdown}
      data-image-loading={(frame && !failed) || undefined}
      role={frame && !failed ? 'status' : undefined}
      aria-label={frame && !failed ? 'Loading image' : undefined}
      className={
        frame
          ? 'relative inline-flex! aspect-video w-64 max-w-full items-center justify-center overflow-hidden rounded-lg border border-border/40 bg-muted/60'
          : 'contents'
      }
      style={frame ? style : undefined}
    >
      {failed ? (
        <ChatMarkdownImageFallback alt={props.alt} copyMarkdown={props.copyMarkdown} />
      ) : visibleSrc ? (
        image(visibleSrc)
      ) : null}
      {!failed && loaded && props.src && props.src !== loaded.src ? image(props.src, true) : null}
    </span>
  )
}

const ChatMarkdownWorkspaceImage = memo(function ChatMarkdownWorkspaceImage(props: {
  readonly threadRef: ScopedThreadRef
  readonly path: string
  readonly alt: string
  readonly copyMarkdown: string
  readonly srcFragment: string
  readonly style?: CSSProperties | undefined
  readonly standalone: boolean
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined
})
{
  const assetUrl = useAssetUrlState(props.threadRef.environmentId, {
    _tag: 'workspace-file',
    threadId: props.threadRef.threadId,
    path: props.path,
  })
  return (
    <ChatMarkdownImage
      src={assetUrl._tag === 'Success' ? assetUrl.url + props.srcFragment : null}
      failed={assetUrl._tag === 'Failure'}
      alt={props.alt}
      copyMarkdown={props.copyMarkdown}
      standalone={props.standalone}
      style={props.style}
      onImageExpand={props.onImageExpand}
    />
  )
})

function useChatMarkdownState({
  text,
  cwd,
  threadRef,
  onTaskListChange,
  isStreaming = false,
  skills = EMPTY_MARKDOWN_SKILLS,
  className,
  lineBreaks = false,
  parseRawHtml = true,
  onUseArtifactTemplate,
  imageBaseDir,
  onImageExpand,
  orchestratePlanActions,
}: ChatMarkdownProps)
{
  const renderedText = useBatchedStreamingText(text, isStreaming)
  const streamingSegments = useMemo(
    () =>
      isStreaming
        ? splitStreamingMarkdown(renderedText)
        : { completedPrefix: '', activeTail: renderedText },
    [isStreaming, renderedText],
  )
  const { resolvedTheme } = useTheme()
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
  })
  const searchProjectEntries = useAtomQueryRunner(projectEnvironment.searchEntries, {
    reportFailure: false,
  })
  const openPreview = useAtomCommand(previewEnvironment.open, {
    reportFailure: false,
  })
  const preparedConnection = usePreparedConnection(threadRef?.environmentId ?? null)
  const environmentId = useActiveEnvironmentId()
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId))
  const openInPreferredEditor = useOpenInPreferredEditor(
    environmentId,
    serverConfig?.availableEditors ?? [],
  )
  const codeThemeName: DiffsThemeNames = useSyntaxThemeName()
  const markdownLinkHrefKey = useMemo(
    () =>
      JSON.stringify([
        ...extractMarkdownLinkHrefs(renderCodexFileCitationsAsMarkdown(renderedText)),
        ...extractInlineCodeFilePaths(renderedText),
      ]),
    [renderedText],
  )
  const markdownFileLinkMetaByHref = useMemo(() =>
  {
    const metaByHref = new Map<
      string,
      NonNullable<ReturnType<typeof resolveMarkdownFileLinkMeta>>
    >()
    const hrefs = JSON.parse(markdownLinkHrefKey) as string[]
    for (const href of hrefs)
    {
      const normalizedHref = normalizeMarkdownLinkHrefKey(href)
      if (metaByHref.has(normalizedHref)) continue
      const meta = resolveMarkdownFileLinkMeta(normalizedHref, cwd)
      if (meta)
      {
        metaByHref.set(normalizedHref, meta)
      }
    }
    return metaByHref
  }, [cwd, markdownLinkHrefKey])
  const fileLinkParentSuffixByPath = useMemo(() =>
  {
    const filePaths = [...markdownFileLinkMetaByHref.values()].map((meta) => meta.filePath)
    return buildFileLinkParentSuffixByPath(filePaths)
  }, [markdownFileLinkMetaByHref])
  const markdownUrlTransform = useCallback((href: string) =>
  {
    if (parseAssistantCitationHref(href)) return href
    if (isWindowsDrivePathHref(href)) return href
    return rewriteMarkdownFileUriHref(href) ?? defaultUrlTransform(href)
  }, [])
  // re-emit highlighted content as markdown so copying out of the rendered
  // view keeps links, emphasis, lists, and code fences intact.
  const handleCopy = useCallback((event: ReactClipboardEvent<HTMLDivElement>) =>
  {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || !event.clipboardData) return
    const payload = chatMarkdownClipboardPayload(selection)
    if (!payload) return
    event.preventDefault()
    event.clipboardData.setData('text/plain', payload.text)
    event.clipboardData.setData('text/html', payload.html)
  }, [])
  const openExternalLinkInPreview = useCallback(
    (url: string) =>
    {
      if (!threadRef)
      {
        return Promise.resolve(
          AsyncResult.failure<void, BrowserPreviewUnavailableError>(
            Cause.fail(
              new BrowserPreviewUnavailableError({
                message: 'Thread context is unavailable.',
              }),
            ),
          ),
        )
      }
      return openUrlInPreview({ threadRef, url, openPreview })
    },
    [openPreview, threadRef],
  )
  const openMarkdownFileInPreview = useCallback(
    (path: string) =>
    {
      if (!threadRef || preparedConnection._tag === 'None')
      {
        return Promise.resolve(
          AsyncResult.failure<void, BrowserPreviewUnavailableError>(
            Cause.fail(
              new BrowserPreviewUnavailableError({
                message: 'Environment is not connected.',
              }),
            ),
          ),
        )
      }
      return openFileInPreview({
        threadRef,
        filePath: path,
        httpBaseUrl: preparedConnection.value.httpBaseUrl,
        createAssetUrl,
        openPreview,
      })
    },
    [createAssetUrl, openPreview, preparedConnection, threadRef],
  )
  const resolveMarkdownFileActionTarget = useCallback(
    (source: WorkspaceFileActionSource) =>
    {
      return resolveWorkspaceFileActionTarget({
        source,
        cwd,
        searchEntries: async (basename) =>
        {
          if (!threadRef || !cwd) return []
          const result = await searchProjectEntries({
            environmentId: threadRef.environmentId,
            input: {
              cwd,
              query: basename,
              limit: WORKSPACE_BASENAME_LOOKUP_LIMIT,
            },
          })
          return result._tag === 'Success' ? result.value.entries : []
        },
      })
    },
    [cwd, searchProjectEntries, threadRef],
  )
  const openFileInPanel = useCallback(
    (workspaceRelativePath: string, line: number | undefined) =>
    {
      if (!threadRef) return
      useRightPanelStore.getState().openFile(threadRef, workspaceRelativePath, line)
    },
    [threadRef],
  )
  return {
    sourceText: renderedText,
    completedPrefixLength: streamingSegments.completedPrefix.length,
    isStreaming,
    className,
    lineBreaks,
    parseRawHtml,
    markdownUrlTransform,
    handleCopy,
    codeThemeName,
    cwd,
    fileLinkParentSuffixByPath,
    imageBaseDir,
    markdownFileLinkMetaByHref,
    onImageExpand,
    onTaskListChange,
    onUseArtifactTemplate,
    orchestratePlanActions,
    openFileInPanel,
    openInPreferredEditor,
    openExternalLinkInPreview,
    openMarkdownFileInPreview,
    resolveMarkdownFileActionTarget,
    resolvedTheme,
    skills,
    threadRef,
  }
}

const ChatMarkdownRendererContext = React.createContext<ReturnType<
  typeof useChatMarkdownState
> | null>(null)

function useMarkdownRendererState()
{
  const state = use(ChatMarkdownRendererContext)
  if (state === null) throw new Error('Markdown renderer state is unavailable')
  return state
}

// component identities stay fixed while current source and actions flow through context.
const CHAT_MARKDOWN_COMPONENTS: Components = {
  div({ node, children, ...props })
  {
    const { onUseArtifactTemplate } = useMarkdownRendererState()
    const artifactTemplate = artifactTemplateFromHastProperties(node?.properties)
    return artifactTemplate ? (
      <CodexArtifactTemplateCard template={artifactTemplate} onUse={onUseArtifactTemplate} />
    ) : (
      <div {...props}>{children}</div>
    )
  },
  p({ node: _node, children, ...props })
  {
    const { skills } = useMarkdownRendererState()
    return <p {...props}>{renderSkillInlineMarkdownChildren(children, skills)}</p>
  },
  ol: MarkdownOrderedList,
  li({ node, children, ...props })
  {
    const { sourceText, skills } = useMarkdownRendererState()
    const listItemStart = node?.position?.start.offset
    const markerOffset =
      typeof listItemStart === 'number' ? findTaskListMarkerOffset(sourceText, listItemStart) : null
    return (
      <li {...props} data-task-marker-offset={markerOffset === null ? undefined : markerOffset}>
        {renderSkillInlineMarkdownChildren(children, skills)}
      </li>
    )
  },
  input({ node: _node, type, checked, disabled: _disabled, ...props })
  {
    const { onTaskListChange } = useMarkdownRendererState()
    if (type !== 'checkbox' || !onTaskListChange)
    {
      return (
        <input
          {...props}
          type={type}
          checked={checked}
          disabled={_disabled}
          readOnly={type === 'checkbox'}
        />
      )
    }
    return (
      <input
        {...props}
        type="checkbox"
        name="markdown-task"
        aria-label="Toggle task"
        checked={checked}
        onChange={(event) =>
        {
          const markerOffset = Number(event.currentTarget.closest('li')?.dataset.taskMarkerOffset)
          if (!Number.isSafeInteger(markerOffset)) return
          onTaskListChange({ markerOffset, checked: event.currentTarget.checked })
        }}
      />
    )
  },
  a({ node, href, children, title: _title, ...props })
  {
    const {
      markdownFileLinkMetaByHref,
      threadRef,
      openExternalLinkInPreview,
      fileLinkParentSuffixByPath,
      resolvedTheme,
      openInPreferredEditor,
      resolveMarkdownFileActionTarget,
      openFileInPanel,
      openMarkdownFileInPreview,
    } = useMarkdownRendererState()
    const citation = href ? parseAssistantCitationHref(href) : null
    if (citation) return <AssistantCitationChip citation={citation} />
    const normalizedHref = href ? normalizeMarkdownLinkHrefKey(href) : ''
    const fileLinkMeta = normalizedHref ? markdownFileLinkMetaByHref.get(normalizedHref) : null
    const isFilePathChip = isFilePathChipNode(node)
    if (!fileLinkMeta)
    {
      // inline code we promoted to an anchor but could not resolve (no cwd)
      // must not stay a navigable link — put the code span back
      if (isFilePathChip)
      {
        return <code>{children}</code>
      }
      const faviconHost = resolveExternalWebLinkHost(href)
      const isSameDocumentLink = href?.startsWith('#') ?? false
      const onClick = props.onClick
      const canOpenInPreview = Boolean(threadRef) && isPreviewSupportedInRuntime()
      const linkChildren = <MarkdownLinkContext value>{children}</MarkdownLinkContext>
      const link = (
        <a
          {...props}
          href={href}
          target={isSameDocumentLink ? undefined : '_blank'}
          rel={isSameDocumentLink ? undefined : 'noopener noreferrer'}
          onClick={(event) =>
          {
            onClick?.(event)
            if (isSameDocumentLink && href)
            {
              handleMarkdownFragmentClick(event, href)
            }
          }}
          onContextMenu={(event) =>
          {
            if (!canOpenInPreview || !href || !faviconHost) return
            event.preventDefault()
            event.stopPropagation()
            const api = readLocalApi()
            if (!api) return
            void showExternalLinkContextMenu({
              href,
              position: { x: event.clientX, y: event.clientY },
              showContextMenu: (items, position) => api.contextMenu.show(items, position),
              openInPreview: async (target) =>
              {
                const result = await openExternalLinkInPreview(target)
                if (result._tag === 'Failure' && !isAtomCommandInterrupted(result))
                {
                  reportMarkdownActionFailure(
                    { operation: 'open-link-in-preview', target },
                    result.cause,
                  )
                }
              },
              openExternal: (target) => api.shell.openExternal(target),
              copyLink: (target) => writeTextToClipboard(target, 'link'),
              reportFailure: (operation, cause) =>
              {
                reportMarkdownActionFailure({ operation, target: href }, cause)
              },
            })
          }}
        >
          {faviconHost ? (
            <MarkdownExternalLinkContent host={faviconHost} plainText={plainHastText(node)}>
              {linkChildren}
            </MarkdownExternalLinkContent>
          ) : (
            linkChildren
          )}
        </a>
      )
      if (!faviconHost || !href)
      {
        return link
      }
      return (
        <Tooltip>
          <TooltipTrigger render={link} />
          <TooltipPopup
            side="top"
            className="max-w-[min(36rem,calc(100vw-2rem))] whitespace-normal leading-tight wrap-anywhere"
          >
            {href}
          </TooltipPopup>
        </Tooltip>
      )
    }

    const parentSuffix = fileLinkParentSuffixByPath.get(fileLinkMeta.filePath)
    const labelParts = [fileLinkMeta.basename]
    if (typeof parentSuffix === 'string' && parentSuffix.length > 0)
    {
      labelParts.push(parentSuffix)
    }
    if (fileLinkMeta.line)
    {
      labelParts.push(
        `L${fileLinkMeta.line}${fileLinkMeta.column ? `:C${fileLinkMeta.column}` : ''}`,
      )
    }

    return (
      <MarkdownFileLink
        href={fileLinkMeta.targetPath}
        filePath={fileLinkMeta.filePath}
        targetPath={fileLinkMeta.targetPath}
        iconPath={fileLinkMeta.filePath}
        displayPath={fileLinkMeta.displayPath}
        workspaceRelativePath={fileLinkMeta.workspaceRelativePath}
        line={fileLinkMeta.line}
        label={labelParts.join(' · ')}
        copyMarkdown={
          isFilePathChip ? `\`${normalizedHref}\`` : `[${fileLinkMeta.basename}](${normalizedHref})`
        }
        theme={resolvedTheme}
        threadRef={threadRef}
        onOpen={openInPreferredEditor}
        onResolveTarget={resolveMarkdownFileActionTarget}
        onOpenInPanel={openFileInPanel}
        onOpenInBrowser={
          threadRef && isPreviewSupportedInRuntime() ? openMarkdownFileInPreview : undefined
        }
        className={props.className}
      />
    )
  },
  table({ node: _node, ...props })
  {
    return <MarkdownTable {...props} />
  },
  img: function MarkdownImage({ node, title, src, alt, ...props })
  {
    const { onImageExpand, imageBaseDir, cwd, threadRef } = useMarkdownRendererState()
    const imageExpand = use(MarkdownLinkContext) ? undefined : onImageExpand
    const localSrc = node?.properties?.dataLocalSrc
    const markdownTitle = node?.properties?.dataMarkdownTitle
    const authoredSrc = typeof localSrc === 'string' ? localSrc : src
    const authoredTitle = typeof markdownTitle === 'string' ? markdownTitle : title
    const srcString =
      typeof authoredSrc === 'string' ? normalizeMarkdownLinkDestination(authoredSrc) : ''
    const classifiedSrc = typeof localSrc === 'string' ? srcString.replaceAll('\\', '/') : srcString
    const altText = alt ?? ''
    const copyMarkdown = markdownImageCopy(altText, srcString, authoredTitle)
    const authoredSizeStyle = authoredImageSizeStyle(props.width, props.height)
    const imageSource = classifyMarkdownImageSource(classifiedSrc, imageBaseDir ?? cwd)
    if (imageSource._tag === 'Direct')
    {
      return (
        <ChatMarkdownImage
          key={imageSource.uri}
          imageProps={props}
          src={imageSource.uri}
          alt={altText}
          copyMarkdown={copyMarkdown}
          standalone={node?.properties?.dataStandalone === true}
          style={authoredSizeStyle}
          onImageExpand={imageExpand}
        />
      )
    }
    if (imageSource._tag === 'WorkspaceFile' && threadRef)
    {
      return (
        <ChatMarkdownWorkspaceImage
          key={`${threadRef.environmentId}:${threadRef.threadId}:${imageSource.path}`}
          threadRef={threadRef}
          path={imageSource.path}
          alt={altText}
          copyMarkdown={copyMarkdown}
          srcFragment={markdownImageSourceFragment(classifiedSrc)}
          style={authoredSizeStyle}
          standalone={node?.properties?.dataStandalone === true}
          onImageExpand={imageExpand}
        />
      )
    }
    return <ChatMarkdownImageFallback alt={altText} copyMarkdown={copyMarkdown} />
  },
  details({ node: _node, children, open: detailsOpen })
  {
    return <MarkdownDetails open={detailsOpen}>{children}</MarkdownDetails>
  },
  pre({ node, children, ...props })
  {
    const {
      isStreaming,
      completedPrefixLength,
      orchestratePlanActions,
      resolvedTheme,
      codeThemeName,
    } = useMarkdownRendererState()
    const segmentIsStreaming =
      isStreaming && (node?.position?.end.offset ?? Infinity) > completedPrefixLength
    const codeBlock = extractCodeBlock(children)
    if (!codeBlock)
    {
      return <pre {...props}>{children}</pre>
    }

    const language = extractFenceLanguage(codeBlock.className)
    let orchestratePlanDiagnostic: string | null = null
    if (language === 'orchestrate-plan')
    {
      const mount = resolveChatMarkdownOrchestrateFence({
        language,
        code: codeBlock.code,
        isComplete: !segmentIsStreaming,
        orchestratePlans: orchestratePlanActions?.orchestratePlans ?? [],
        hasActions: orchestratePlanActions !== undefined,
      })
      if (mount.kind === 'suppress') return null
      if (mount.kind === 'card' && orchestratePlanActions !== undefined)
      {
        return <OrchestratePlanCard plan={mount.plan} actions={orchestratePlanActions} />
      }
      if (mount.kind === 'error')
      {
        orchestratePlanDiagnostic = mount.diagnostic
      }
    }
    const fenceTitle = extractFenceTitle(extractPreCodeMeta(node))
    return (
      <>
        {orchestratePlanDiagnostic ? (
          <Alert variant="error" className="mb-2">
            <CircleAlertIcon />
            <AlertTitle>Plan card could not be rendered</AlertTitle>
            <AlertDescription>{orchestratePlanDiagnostic}</AlertDescription>
          </Alert>
        ) : null}
        <MarkdownCodeBlock
          code={codeBlock.code}
          language={language}
          fenceTitle={fenceTitle}
          theme={resolvedTheme}
        >
          {segmentIsStreaming ? (
            <pre {...props}>{children}</pre>
          ) : (
            <CodeHighlightErrorBoundary fallback={<pre {...props}>{children}</pre>}>
              <Suspense fallback={<pre {...props}>{children}</pre>}>
                <SuspenseShikiCodeBlock
                  className={codeBlock.className}
                  code={codeBlock.code}
                  themeName={codeThemeName}
                />
              </Suspense>
            </CodeHighlightErrorBoundary>
          )}
        </MarkdownCodeBlock>
      </>
    )
  },
}

function ChatMarkdown(props: ChatMarkdownProps)
{
  const state = useChatMarkdownState(props)
  return (
    <div
      className={cn(
        'chat-markdown w-full min-w-0 text-sm leading-relaxed text-foreground/80',
        state.className,
      )}
      onCopy={state.handleCopy}
    >
      <ChatMarkdownRendererContext value={state}>
        <MarkdownDocument
          text={state.sourceText}
          components={CHAT_MARKDOWN_COMPONENTS}
          lineBreaks={state.lineBreaks}
          parseRawHtml={state.parseRawHtml}
          urlTransform={state.markdownUrlTransform}
        />
      </ChatMarkdownRendererContext>
    </div>
  )
}

export default memo(ChatMarkdown)
