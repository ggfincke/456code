// apps/web/src/components/ChatMarkdown.tsx
// renders markdown, code fences, links, and interactive message content

import { useAtomValue } from '@effect/atom-react'
import { type DiffsThemeNames } from '@pierre/diffs'
import { CircleAlertIcon } from 'lucide-react'
import type {
  OrchestratePlanRevision,
  ScopedThreadRef,
  ServerProviderSkill,
} from '@t3tools/contracts'
import { isAtomCommandInterrupted } from '@t3tools/client-runtime/state/runtime'
import * as Cause from 'effect/Cause'
import { AsyncResult } from 'effect/unstable/reactivity'
import React, {
  Suspense,
  type ClipboardEvent as ReactClipboardEvent,
  type ComponentPropsWithoutRef,
  useCallback,
  memo,
  useMemo,
  type ReactNode,
} from 'react'
import type { Components, Options as ReactMarkdownOptions } from 'react-markdown'
import ReactMarkdown from 'react-markdown'
import { defaultUrlTransform } from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import { renderSkillInlineMarkdownChildren } from './chat/SkillInlineText'
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
import { Alert, AlertDescription, AlertTitle } from './ui/alert'
import { useOpenInPreferredEditor } from '../lib/editorPreferences'
import { useTheme } from '../hooks/useTheme'
import { useSyntaxThemeName } from '../hooks/useSyntaxThemeName'
import { chatMarkdownClipboardPayload } from '../lib/markdown/clipboard'
import { remarkLinkInlineCodePaths } from '../lib/markdown/inline-code-paths'
import { remarkNormalizeListItemIndentation } from '../lib/markdown/list-indentation'
import { resolveMarkdownFileLinkMeta, rewriteMarkdownFileUriHref } from '../lib/markdown/links'
import {
  resolveWorkspaceFileActionTarget,
  WORKSPACE_BASENAME_LOOKUP_LIMIT,
  type WorkspaceFileActionSource,
} from '../lib/workspaceBasenameLookup'
import { readLocalApi } from '../localApi'
import { cn } from '../lib/utils'
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
  orchestratePlanActions?: OrchestratePlanActions | undefined
}

const EMPTY_MARKDOWN_SKILLS: ReadonlyArray<Pick<ServerProviderSkill, 'name' | 'displayName'>> = []

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

type MarkdownAstNode = {
  type?: string
  meta?: unknown
  data?: {
    hProperties?: Record<string, unknown>
  }
  children?: MarkdownAstNode[]
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

const CHAT_MARKDOWN_SANITIZE_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    '*': (defaultSchema.attributes?.['*'] ?? []).filter((attribute) => attribute !== 'title'),
    code: [...(defaultSchema.attributes?.code ?? []), 'dataCodeMeta'],
    a: [...(defaultSchema.attributes?.a ?? []), 'dataFilePathChip'],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), 'file'],
  },
} satisfies Parameters<typeof rehypeSanitize>[0]

const CHAT_MARKDOWN_REMARK_PLUGINS = [
  remarkGfm,
  remarkNormalizeListItemIndentation,
  remarkPreserveCodeMeta,
  remarkLinkInlineCodePaths,
] satisfies NonNullable<ReactMarkdownOptions['remarkPlugins']>

const CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS = [
  remarkGfm,
  remarkNormalizeListItemIndentation,
  remarkBreaks,
  remarkPreserveCodeMeta,
  remarkLinkInlineCodePaths,
] satisfies NonNullable<ReactMarkdownOptions['remarkPlugins']>

const CHAT_MARKDOWN_REHYPE_PLUGINS = [
  rehypeRaw,
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

function MarkdownImage({
  node: _node,
  title: _title,
  ...props
}: ComponentPropsWithoutRef<'img'> & { readonly node?: unknown })
{
  return <img {...props} />
}

function ChatMarkdown({
  text,
  cwd,
  threadRef,
  onTaskListChange,
  isStreaming = false,
  skills = EMPTY_MARKDOWN_SKILLS,
  className,
  lineBreaks = false,
  parseRawHtml = true,
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
        ...extractMarkdownLinkHrefs(renderedText),
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
  const createMarkdownComponents = useCallback(
    (sourceText: string, sourceOffset: number, segmentIsStreaming: boolean): Components => ({
      p({ node: _node, children, ...props })
      {
        return <p {...props}>{renderSkillInlineMarkdownChildren(children, skills)}</p>
      },
      li({ node, children, ...props })
      {
        const listItemStart = node?.position?.start.offset
        const markerOffset =
          typeof listItemStart === 'number'
            ? findTaskListMarkerOffset(sourceText, listItemStart)
            : null
        return (
          <li
            {...props}
            data-task-marker-offset={
              markerOffset === null ? undefined : markerOffset + sourceOffset
            }
          >
            {renderSkillInlineMarkdownChildren(children, skills)}
          </li>
        )
      },
      input({ node: _node, type, checked, disabled: _disabled, ...props })
      {
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
              const markerOffset = Number(
                event.currentTarget.closest('li')?.dataset.taskMarkerOffset,
              )
              if (!Number.isSafeInteger(markerOffset)) return
              onTaskListChange({ markerOffset, checked: event.currentTarget.checked })
            }}
          />
        )
      },
      a({ node, href, children, title: _title, ...props })
      {
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
                  {children}
                </MarkdownExternalLinkContent>
              ) : (
                children
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
              isFilePathChip
                ? `\`${normalizedHref}\``
                : `[${fileLinkMeta.basename}](${normalizedHref})`
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
      img: MarkdownImage,
      details({ node: _node, children, open: detailsOpen })
      {
        return <MarkdownDetails open={detailsOpen}>{children}</MarkdownDetails>
      },
      pre({ node, children, ...props })
      {
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
    }),
    [
      codeThemeName,
      fileLinkParentSuffixByPath,
      markdownFileLinkMetaByHref,
      onTaskListChange,
      orchestratePlanActions,
      openFileInPanel,
      openInPreferredEditor,
      openExternalLinkInPreview,
      openMarkdownFileInPreview,
      resolveMarkdownFileActionTarget,
      resolvedTheme,
      skills,
      threadRef,
    ],
  )
  const completedMarkdownComponents = useMemo(
    () => createMarkdownComponents(streamingSegments.completedPrefix, 0, false),
    [createMarkdownComponents, streamingSegments.completedPrefix],
  )
  const activeMarkdownComponents = useMemo(
    () =>
      createMarkdownComponents(
        streamingSegments.activeTail,
        streamingSegments.completedPrefix.length,
        isStreaming,
      ),
    [
      createMarkdownComponents,
      isStreaming,
      streamingSegments.activeTail,
      streamingSegments.completedPrefix.length,
    ],
  )

  return (
    <div
      className={cn(
        'chat-markdown w-full min-w-0 text-sm leading-relaxed text-foreground/80',
        className,
      )}
      onCopy={handleCopy}
    >
      {streamingSegments.completedPrefix ? (
        <MarkdownDocument
          text={streamingSegments.completedPrefix}
          components={completedMarkdownComponents}
          lineBreaks={lineBreaks}
          parseRawHtml={parseRawHtml}
          urlTransform={markdownUrlTransform}
        />
      ) : null}
      {streamingSegments.activeTail ? (
        <MarkdownDocument
          text={streamingSegments.activeTail}
          components={activeMarkdownComponents}
          lineBreaks={lineBreaks}
          parseRawHtml={parseRawHtml}
          urlTransform={markdownUrlTransform}
        />
      ) : null}
    </div>
  )
}

export default memo(ChatMarkdown)
