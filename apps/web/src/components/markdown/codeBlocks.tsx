// apps/web/src/components/markdown/codeBlocks.tsx
// render chat-markdown code fences, tables, and syntax highlighting

import {
  type DiffsHighlighter,
  type DiffsThemeNames,
  getSharedHighlighter,
  SupportedLanguages,
} from '@pierre/diffs'
import {
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  Maximize2Icon,
  Minimize2Icon,
  WrapTextIcon,
} from 'lucide-react'
import React, {
  Children,
  isValidElement,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  hasSpecificPierreIconForFileName,
  syntheticFileNameForLanguageId,
} from '../../pierre-icons'
import { Tooltip, TooltipPopup, TooltipTrigger } from '../ui/tooltip'
import { Button } from '../ui/button'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '../ui/collapsible'
import { ScrollArea } from '../ui/scroll-area'
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '../ui/menu'
import { DIFF_THEME_NAMES } from '../../lib/diffRendering'
import { fnv1a32 } from '../../lib/diffRendering'
import { LRUCache } from '../../lib/lruCache'
import { getClientSettings } from '../../hooks/useSettings'
import {
  serializeTableElementToCsv,
  serializeTableElementToMarkdown,
} from '../../lib/markdown/clipboard'
import { writeTextToClipboard } from '../../hooks/useCopyToClipboard'
import { cn } from '../../lib/utils'
import { PierreEntryIcon } from '../chat/PierreEntryIcon'
import { reportMarkdownActionFailure } from './actionFailure'

export const CODE_FENCE_LANGUAGE_REGEX = /(?:^|\s)language-([^\s]+)/
const MAX_HIGHLIGHT_CACHE_ENTRIES = 500
const MAX_HIGHLIGHT_CACHE_MEMORY_BYTES = 50 * 1024 * 1024

const highlightedCodeCache = new LRUCache<string>(
  MAX_HIGHLIGHT_CACHE_ENTRIES,
  MAX_HIGHLIGHT_CACHE_MEMORY_BYTES,
)
const highlighterPromiseCache = new Map<string, Promise<DiffsHighlighter>>()

export function extractFenceLanguage(className: string | undefined): string
{
  const match = className?.match(CODE_FENCE_LANGUAGE_REGEX)
  const raw = match?.[1] ?? 'text'
  // shiki doesn't bundle a gitignore grammar; ini is a close match (#685)
  return raw === 'gitignore' ? 'ini' : raw
}

const FENCE_TITLE_ATTR_REGEX = /(?:^|\s)(?:title|file(?:name)?)=(?:"([^"]+)"|'([^']+)'|(\S+))/i
const FENCE_FILENAME_TOKEN_REGEX = /^[\w@][\w@./-]*\.[A-Za-z0-9]+$/

// pulls a filename out of fence meta: ```ts title="x.ts" / ```ts src/main.ts
export function extractFenceTitle(meta: string | undefined): string | null
{
  if (!meta) return null
  const attrMatch = FENCE_TITLE_ATTR_REGEX.exec(meta)
  const attrTitle = attrMatch?.[1] ?? attrMatch?.[2] ?? attrMatch?.[3]
  if (attrTitle) return attrTitle
  return meta.split(/\s+/).find((candidate) => FENCE_FILENAME_TOKEN_REGEX.test(candidate)) ?? null
}

export function extractPreCodeMeta(node: unknown): string | undefined
{
  const children = (
    node as
      | {
          children?: Array<{
            type?: string
            tagName?: string
            data?: { meta?: unknown }
            properties?: { dataCodeMeta?: unknown }
          }>
        }
      | undefined
  )?.children
  const codeNode = children?.find((child) => child?.type === 'element' && child.tagName === 'code')
  const meta = codeNode?.properties?.dataCodeMeta ?? codeNode?.data?.meta
  return typeof meta === 'string' && meta.trim().length > 0 ? meta.trim() : undefined
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

export function nodeToPlainText(node: ReactNode): string
{
  if (typeof node === 'string' || typeof node === 'number')
  {
    return String(node)
  }
  if (Array.isArray(node))
  {
    return node.map((child) => nodeToPlainText(child)).join('')
  }
  if (isValidElement<{ children?: ReactNode }>(node))
  {
    return nodeToPlainText(node.props.children)
  }
  return ''
}

export function extractCodeBlock(
  children: ReactNode,
): { className: string | undefined; code: string } | null
{
  const childNodes = Children.toArray(children)
  if (childNodes.length !== 1)
  {
    return null
  }

  const onlyChild = childNodes[0]
  if (
    !isValidElement<{ className?: string; children?: ReactNode }>(onlyChild) ||
    onlyChild.type !== 'code'
  )
  {
    return null
  }

  return {
    className: onlyChild.props.className,
    code: nodeToPlainText(onlyChild.props.children),
  }
}

function createHighlightCacheKey(
  code: string,
  language: string,
  themeName: DiffsThemeNames,
): string
{
  return `${fnv1a32(code).toString(36)}:${code.length}:${language}:${themeName}`
}

function estimateHighlightedSize(html: string, code: string): number
{
  return Math.max(html.length * 2, code.length * 3)
}

function getHighlighterPromise(language: string): Promise<DiffsHighlighter>
{
  const cached = highlighterPromiseCache.get(language)
  if (cached) return cached

  const promise = getSharedHighlighter({
    themes: Object.values(DIFF_THEME_NAMES),
    langs: [language as SupportedLanguages],
    preferredHighlighter: 'shiki-js',
  }).catch((err) =>
  {
    highlighterPromiseCache.delete(language)
    if (language === 'text')
    {
      // "text" itself failed — Shiki cannot initialize at all, surface the error
      throw err
    }
    // language not supported by Shiki — fall back to "text"
    return getHighlighterPromise('text')
  })
  highlighterPromiseCache.set(language, promise)
  return promise
}

function readInitialWordWrapSetting(): boolean
{
  return getClientSettings().wordWrap
}

export function MarkdownTable({ children, ...props }: React.ComponentProps<'table'>)
{
  const containerRef = useRef<HTMLDivElement | null>(null)
  const tableRef = useRef<HTMLTableElement | null>(null)
  const [expanded, setExpanded] = useState(readInitialWordWrapSetting)
  const [copied, setCopied] = useState(false)
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const expandLabel = expanded ? 'Collapse table cells' : 'Expand table cells'
  const copyLabel = copied ? 'Copied' : 'Copy table'

  function toggleExpanded()
  {
    const table = tableRef.current
    if (!table) return

    if (!expanded)
    {
      const rows = [...table.rows]
      const columnWidths = rows.reduce<number[]>((widths, row) =>
      {
        ;[...row.cells].forEach((cell, columnIndex) =>
        {
          widths[columnIndex] = Math.max(
            widths[columnIndex] ?? 0,
            cell.getBoundingClientRect().width,
          )
        })
        return widths
      }, [])

      ;[...(table.tHead?.rows[0]?.cells ?? [])].forEach((cell, columnIndex) =>
      {
        cell.style.minWidth = `${columnWidths[columnIndex] ?? cell.getBoundingClientRect().width}px`
      })
    }

    setExpanded((value) => !value)
  }

  const handleCopy = useCallback((format: 'markdown' | 'csv') =>
  {
    const table = containerRef.current?.querySelector('table')
    if (!table || typeof navigator === 'undefined' || navigator.clipboard == null)
    {
      return
    }
    const text =
      format === 'markdown'
        ? serializeTableElementToMarkdown(table)
        : serializeTableElementToCsv(table)
    void navigator.clipboard
      .writeText(text)
      .then(() =>
      {
        if (copiedTimerRef.current != null)
        {
          clearTimeout(copiedTimerRef.current)
        }
        setCopied(true)
        copiedTimerRef.current = setTimeout(() =>
        {
          setCopied(false)
          copiedTimerRef.current = null
        }, 1200)
      })
      .catch((cause) =>
      {
        reportMarkdownActionFailure({ operation: 'copy-table', format }, cause)
      })
  }, [])

  useEffect(
    () => () =>
    {
      if (copiedTimerRef.current != null)
      {
        clearTimeout(copiedTimerRef.current)
        copiedTimerRef.current = null
      }
    },
    [],
  )

  return (
    <div
      ref={containerRef}
      className="chat-markdown-table-container"
      data-expanded={expanded ? 'true' : 'false'}
    >
      <ScrollArea
        chainVerticalScroll
        scrollFade
        hideScrollbars
        className="w-full max-w-full rounded-none"
      >
        <table ref={tableRef} {...props}>
          {children}
        </table>
      </ScrollArea>
      <div className="chat-markdown-table-footer select-none">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="chat-markdown-chrome-action"
                aria-pressed={expanded}
                onClick={toggleExpanded}
                aria-label={expandLabel}
              />
            }
          >
            {expanded ? <Minimize2Icon className="size-3" /> : <Maximize2Icon className="size-3" />}
          </TooltipTrigger>
          <TooltipPopup side="top">{expandLabel}</TooltipPopup>
        </Tooltip>
        <Menu>
          <Tooltip>
            <TooltipTrigger
              render={
                <MenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="chat-markdown-chrome-action"
                      aria-label={copyLabel}
                    />
                  }
                />
              }
            >
              {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
            </TooltipTrigger>
            <TooltipPopup side="top">{copyLabel}</TooltipPopup>
          </Tooltip>
          <MenuPopup align="end">
            <MenuItem onClick={() => handleCopy('markdown')}>Copy as Markdown</MenuItem>
            <MenuItem onClick={() => handleCopy('csv')}>Copy as CSV</MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    </div>
  )
}

export function MarkdownDetails({
  children,
  open = false,
}: Pick<React.ComponentProps<'details'>, 'children' | 'open'>)
{
  const [isOpen, setIsOpen] = useState(open)
  const childNodes = Children.toArray(children)
  const summaryIndex = childNodes.findIndex(
    (child) => isValidElement(child) && child.type === 'summary',
  )
  const summaryNode = summaryIndex >= 0 ? childNodes[summaryIndex] : null
  const summary =
    isValidElement<{ children?: ReactNode }>(summaryNode) && summaryNode.props.children
      ? summaryNode.props.children
      : 'Details'
  const content = childNodes.filter((_, index) => index !== summaryIndex)

  return (
    <Collapsible
      defaultOpen={open}
      onOpenChange={setIsOpen}
      className="chat-markdown-details my-2 border-y border-border/60"
      data-markdown-details=""
      data-markdown-details-open={isOpen ? 'true' : 'false'}
    >
      <CollapsibleTrigger
        className="flex w-full items-center gap-2 py-2 text-left text-sm font-medium text-foreground data-panel-open:[&_svg]:rotate-90"
        data-markdown-details-summary=""
      >
        <ChevronRightIcon
          className="size-4 shrink-0 text-muted-foreground transition-transform"
          aria-hidden
        />
        <span>{summary}</span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="pb-3 ps-6 text-foreground/80" data-markdown-details-content="">
          {content}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  )
}

// filename titles render icon + text; language-only titles render just the
// icon (redundant next to its own name) and fall back to the language text
// when no specific icon exists or it fails to load.
function MarkdownCodeBlockTitleContent({
  fenceTitle,
  language,
  theme,
}: {
  fenceTitle: string | null
  language: string
  theme: 'light' | 'dark'
})
{
  if (fenceTitle)
  {
    return (
      <>
        <PierreEntryIcon pathValue={fenceTitle} kind="file" theme={theme} className="size-3.5" />
        <span className="truncate">{fenceTitle}</span>
      </>
    )
  }

  const fileName = syntheticFileNameForLanguageId(language)
  if (!hasSpecificPierreIconForFileName(fileName))
  {
    return <span className="truncate">{language}</span>
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="inline-flex shrink-0 rounded-sm" aria-label={`Language: ${language}`} />
        }
      >
        <PierreEntryIcon pathValue={fileName} kind="file" theme={theme} className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">{language}</TooltipPopup>
    </Tooltip>
  )
}

export function MarkdownCodeBlock({
  code,
  language,
  fenceTitle,
  theme,
  children,
}: {
  code: string
  language: string
  fenceTitle: string | null
  theme: 'light' | 'dark'
  children: ReactNode
})
{
  const [copied, setCopied] = useState(false)
  const [wrapped, setWrapped] = useState(readInitialWordWrapSetting)
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wrapLabel = wrapped ? 'Disable line wrap' : 'Wrap lines'
  const copyLabel = copied ? 'Copied' : 'Copy code'

  const handleCopy = useCallback(() =>
  {
    if (typeof navigator === 'undefined' || navigator.clipboard == null)
    {
      return
    }
    void navigator.clipboard
      .writeText(code)
      .then(() =>
      {
        if (copiedTimerRef.current != null)
        {
          clearTimeout(copiedTimerRef.current)
        }
        setCopied(true)
        copiedTimerRef.current = setTimeout(() =>
        {
          setCopied(false)
          copiedTimerRef.current = null
        }, 1200)
      })
      .catch((cause) =>
      {
        reportMarkdownActionFailure(
          {
            operation: 'copy-code-block',
            language,
            ...(fenceTitle ? { fenceTitle } : {}),
          },
          cause,
        )
      })
  }, [code, fenceTitle, language])

  useEffect(
    () => () =>
    {
      if (copiedTimerRef.current != null)
      {
        clearTimeout(copiedTimerRef.current)
        copiedTimerRef.current = null
      }
    },
    [],
  )

  return (
    <div
      className="chat-markdown-codeblock leading-snug"
      data-language={language}
      data-wrap={wrapped ? 'true' : 'false'}
    >
      <div className="chat-markdown-codeblock-header select-none">
        <span className="chat-markdown-codeblock-title">
          <MarkdownCodeBlockTitleContent
            fenceTitle={fenceTitle}
            language={language}
            theme={theme}
          />
        </span>
        <span className="flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="chat-markdown-chrome-action"
                  aria-pressed={wrapped}
                  onClick={() => setWrapped((value) => !value)}
                  aria-label={wrapLabel}
                />
              }
            >
              <WrapTextIcon className="size-3" />
            </TooltipTrigger>
            <TooltipPopup side="top">{wrapLabel}</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="chat-markdown-chrome-action"
                  onClick={handleCopy}
                  aria-label={copyLabel}
                />
              }
            >
              {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
            </TooltipTrigger>
            <TooltipPopup side="top">{copyLabel}</TooltipPopup>
          </Tooltip>
        </span>
      </div>
      {children}
    </div>
  )
}

interface SuspenseShikiCodeBlockProps
{
  className: string | undefined
  code: string
  themeName: DiffsThemeNames
}

export function SuspenseShikiCodeBlock({
  className,
  code,
  themeName,
}: SuspenseShikiCodeBlockProps)
{
  const language = extractFenceLanguage(className)
  const cacheKey = createHighlightCacheKey(code, language, themeName)
  const cachedHighlightedHtml = highlightedCodeCache.get(cacheKey)

  if (cachedHighlightedHtml != null)
  {
    return (
      <div
        className="chat-markdown-shiki"
        dangerouslySetInnerHTML={{ __html: cachedHighlightedHtml }}
      />
    )
  }

  return (
    <UncachedShikiCodeBlock
      code={code}
      language={language}
      themeName={themeName}
      cacheKey={cacheKey}
    />
  )
}

interface UncachedShikiCodeBlockProps
{
  code: string
  language: string
  themeName: DiffsThemeNames
  cacheKey: string
}

function UncachedShikiCodeBlock({
  code,
  language,
  themeName,
  cacheKey,
}: UncachedShikiCodeBlockProps)
{
  const highlighter = use(getHighlighterPromise(language))
  const highlightedHtml = useMemo(() =>
  {
    try
    {
      return highlighter.codeToHtml(code, { lang: language, theme: themeName })
    }
    catch (error)
    {
      // log highlighting failures for debugging while falling back to plain text
      console.warn(
        `Code highlighting failed for language "${language}", falling back to plain text.`,
        error instanceof Error ? error.message : error,
      )
      // if highlighting fails for this language, render as plain text
      return highlighter.codeToHtml(code, { lang: 'text', theme: themeName })
    }
  }, [code, highlighter, language, themeName])

  useEffect(() =>
  {
    highlightedCodeCache.set(
      cacheKey,
      highlightedHtml,
      estimateHighlightedSize(highlightedHtml, code),
    )
  }, [cacheKey, code, highlightedHtml])

  return (
    <div className="chat-markdown-shiki" dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
  )
}
