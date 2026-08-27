// apps/web/src/components/markdown/links.tsx
// render chat-markdown file chips and external link chrome

import { GlobeIcon } from 'lucide-react'
import type { ScopedThreadRef } from '@t3tools/contracts'
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from '@t3tools/client-runtime/state/runtime'
import React, {
  Children,
  memo,
  useCallback,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import { CHAT_FILE_TAG_CHIP_CLASS_NAME, FileTagChipContent } from '../chat/FileTagChip'
import { Tooltip, TooltipPopup, TooltipTrigger } from '../ui/tooltip'
import { stackedThreadToast, toastManager } from '../ui/toast'
import { isBrowserPreviewFile } from '../../browser/openFileInPreview'
import {
  looksLikeInlineCodeFilePath,
  normalizeMarkdownLinkDestination,
  rewriteMarkdownFileUriHref,
  shouldOpenMarkdownFileLinkInBrowserByDefault,
  shouldOpenMarkdownFileLinkInEditor,
} from '../../lib/markdown/links'
import {
  resolveWorkspaceFilePrimaryAction,
  type WorkspaceFileActionSource,
  type WorkspaceFileActionTarget,
} from '../../lib/workspaceBasenameLookup'
import { readLocalApi } from '../../localApi'
import { cn } from '../../lib/utils'
import { reportMarkdownActionFailure } from './actionFailure'

export interface MarkdownFileLinkProps
{
  href: string
  filePath: string
  targetPath: string
  iconPath: string
  displayPath: string
  workspaceRelativePath: string | null
  line?: number | undefined
  label: string
  copyMarkdown: string
  theme: 'light' | 'dark'
  threadRef?: ScopedThreadRef | undefined
  onOpen: (targetPath: string) => Promise<AtomCommandResult<unknown, unknown>>
  onResolveTarget: (source: WorkspaceFileActionSource) => Promise<WorkspaceFileActionTarget | null>
  onOpenInPanel: (workspaceRelativePath: string, line: number | undefined) => void
  onOpenInBrowser?: ((filePath: string) => Promise<AtomCommandResult<unknown, unknown>>) | undefined
  className?: string | undefined
}

const MARKDOWN_LINK_HREF_PATTERN =
  /\[[^\]]*]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g
const MARKDOWN_FILE_LINK_CLASS_NAME =
  'chat-markdown-file-link cursor-pointer transition-colors hover:bg-accent/70'

function pathParentSegments(path: string): string[]
{
  const normalized = path.replaceAll('\\', '/')
  const segments = normalized.split('/').filter((segment) => segment.length > 0)
  return segments.slice(0, -1)
}

export function buildFileLinkParentSuffixByPath(
  filePaths: ReadonlyArray<string>,
): Map<string, string>
{
  const groups = new Map<string, Set<string>>()
  for (const filePath of filePaths)
  {
    const pathSegments = filePath
      .replaceAll('\\', '/')
      .split('/')
      .filter((segment) => segment.length > 0)
    const basename = pathSegments[pathSegments.length - 1]
    if (!basename) continue
    const group = groups.get(basename) ?? new Set<string>()
    group.add(filePath)
    groups.set(basename, group)
  }

  const suffixByPath = new Map<string, string>()
  for (const group of groups.values())
  {
    const uniquePaths = [...group]
    if (uniquePaths.length < 2) continue

    const parentSegmentsByPath = new Map(
      uniquePaths.map((filePath) => [filePath, pathParentSegments(filePath)]),
    )
    const minUniqueDepthByPath = new Map<string, number>()

    for (const filePath of uniquePaths)
    {
      const segments = parentSegmentsByPath.get(filePath) ?? []
      let resolvedDepth = segments.length
      for (let depth = 1; depth <= segments.length; depth += 1)
      {
        const candidate = segments.slice(-depth).join('/')
        const collision = uniquePaths.some((otherPath) =>
        {
          if (otherPath === filePath) return false
          const otherSegments = parentSegmentsByPath.get(otherPath) ?? []
          return otherSegments.slice(-depth).join('/') === candidate
        })
        if (!collision)
        {
          resolvedDepth = depth
          break
        }
      }
      minUniqueDepthByPath.set(filePath, resolvedDepth)
    }

    for (const filePath of uniquePaths)
    {
      const segments = parentSegmentsByPath.get(filePath) ?? []
      if (segments.length === 0) continue
      const minUniqueDepth = minUniqueDepthByPath.get(filePath) ?? 1
      const suffixDepth = Math.min(segments.length, Math.max(minUniqueDepth, 2))
      suffixByPath.set(filePath, segments.slice(-suffixDepth).join('/'))
    }
  }

  return suffixByPath
}

export function extractMarkdownLinkHrefs(text: string): string[]
{
  const hrefs: string[] = []
  for (const match of text.matchAll(MARKDOWN_LINK_HREF_PATTERN))
  {
    const href = (match[1] ?? match[2])?.trim()
    if (!href) continue
    hrefs.push(href)
  }
  return hrefs
}

const MARKDOWN_INLINE_CODE_PATTERN = /(`+)([^`\n]+?)\1/g

export function extractInlineCodeFilePaths(text: string): string[]
{
  const paths: string[] = []
  for (const match of text.matchAll(MARKDOWN_INLINE_CODE_PATTERN))
  {
    const value = match[2]?.trim()
    if (!value || !looksLikeInlineCodeFilePath(value)) continue
    paths.push(value)
  }
  return paths
}

export function isFilePathChipNode(node: unknown): boolean
{
  if (!node || typeof node !== 'object' || !('properties' in node)) return false
  const properties = (node as { properties?: Record<string, unknown> }).properties
  return properties?.dataFilePathChip === 'true'
}

export function normalizeMarkdownLinkHrefKey(href: string): string
{
  const normalizedHref = normalizeMarkdownLinkDestination(href)
  return rewriteMarkdownFileUriHref(normalizedHref) ?? normalizedHref
}

const MARKDOWN_LINK_FAVICON_CLASS_NAME = 'block size-full shrink-0 select-none'

// hosts whose favicon request already failed this session — skip straight to the globe.
const failedFaviconHosts = new Set<string>()

const MarkdownLinkFavicon = memo(function MarkdownLinkFavicon({ host }: { host: string })
{
  const [failedHost, setFailedHost] = useState<string | null>(null)
  return (
    <span className="chat-markdown-link-favicon" aria-hidden>
      {failedHost === host || failedFaviconHosts.has(host) ? (
        <GlobeIcon className={MARKDOWN_LINK_FAVICON_CLASS_NAME} />
      ) : (
        <img
          src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`}
          alt=""
          loading="lazy"
          draggable={false}
          className={cn(MARKDOWN_LINK_FAVICON_CLASS_NAME, 'rounded-sm')}
          onError={() =>
            {
            failedFaviconHosts.add(host)
            setFailedHost(host)
          }}
        />
      )}
    </span>
  )
})

function leadingExternalLinkTextLength(text: string): number
{
  const protocol = /^(?:https?:\/\/)/i.exec(text)?.[0]
  if (protocol) return protocol.length
  return Math.min(text.length, 1)
}

function breakableExternalLinkText(text: string): ReactNode[]
{
  return Array.from(text, (character, index) => (
    <React.Fragment key={`${index}:${character}`}>
      {character}
      <wbr />
    </React.Fragment>
  ))
}

export function plainHastText(node: unknown): string | null
{
  if (!node || typeof node !== 'object' || !('children' in node) || !Array.isArray(node.children))
  {
    return null
  }
  const parts = node.children.map((child) =>
  {
    if (
      child &&
      typeof child === 'object' &&
      'type' in child &&
      child.type === 'text' &&
      'value' in child &&
      typeof child.value === 'string'
    )
    {
      return child.value
    }
    return null
  })
  return parts.every((part) => part !== null) ? parts.join('') : null
}

const SANITIZED_FRAGMENT_PREFIX = 'user-content-'

function decodeMarkdownFragmentId(href: string): string
{
  const encodedId = href.slice(1)
  try
  {
    return decodeURIComponent(encodedId)
  }
  catch
  {
    return encodedId
  }
}

function normalizeSanitizedFragmentId(id: string): string
{
  let normalizedId = id
  while (normalizedId.startsWith(SANITIZED_FRAGMENT_PREFIX))
  {
    normalizedId = normalizedId.slice(SANITIZED_FRAGMENT_PREFIX.length)
  }
  return normalizedId
}

function findMarkdownFragmentTarget(anchor: HTMLAnchorElement, href: string): HTMLElement | null
{
  const decodedId = decodeMarkdownFragmentId(href)
  const normalizedId = normalizeSanitizedFragmentId(decodedId)
  const matchesFragment = (element: HTMLElement) =>
    element.id === decodedId || normalizeSanitizedFragmentId(element.id) === normalizedId
  const markdownRoot = anchor.closest<HTMLElement>('.chat-markdown')
  if (markdownRoot)
  {
    const localTargets = Array.from(markdownRoot.querySelectorAll<HTMLElement>('[id]'))
    const localTarget = localTargets.find(matchesFragment)
    if (localTarget) return localTarget
  }

  return (
    document.getElementById(decodedId) ??
    Array.from(document.querySelectorAll<HTMLElement>('[id]')).find(matchesFragment) ??
    null
  )
}

export function handleMarkdownFragmentClick(
  event: ReactMouseEvent<HTMLAnchorElement>,
  href: string,
)
{
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
  {
    return
  }

  const target = findMarkdownFragmentTarget(event.currentTarget, href)
  if (!target) return

  event.preventDefault()
  const nextUrl = new URL(window.location.href)
  nextUrl.hash = href.slice(1)
  window.history.pushState(window.history.state, '', nextUrl)
  target.scrollIntoView({ block: 'nearest' })
}

export function MarkdownExternalLinkContent({
  host,
  plainText,
  children,
}: {
  host: string
  plainText: string | null
  children: ReactNode
})
{
  if (plainText)
  {
    const leadingLength = leadingExternalLinkTextLength(plainText)
    return (
      <>
        <span className="chat-markdown-link-leading">
          <MarkdownLinkFavicon host={host} />
          {plainText.slice(0, leadingLength)}
        </span>
        {breakableExternalLinkText(plainText.slice(leadingLength))}
      </>
    )
  }

  const childNodes = Children.toArray(children)
  const firstChild = childNodes[0]

  if (typeof firstChild === 'string' && firstChild.length > 0)
  {
    const leadingLength = leadingExternalLinkTextLength(firstChild)
    return (
      <>
        <span className="chat-markdown-link-leading">
          <MarkdownLinkFavicon host={host} />
          {firstChild.slice(0, leadingLength)}
        </span>
        {breakableExternalLinkText(firstChild.slice(leadingLength))}
        {childNodes.slice(1)}
      </>
    )
  }

  return (
    <>
      <span className="chat-markdown-link-leading">
        <MarkdownLinkFavicon host={host} />
        {firstChild}
      </span>
      {childNodes.slice(1)}
    </>
  )
}

export const MarkdownFileLink = memo(function MarkdownFileLink({
  href,
  filePath,
  targetPath,
  iconPath,
  displayPath,
  workspaceRelativePath,
  line,
  label,
  copyMarkdown,
  theme,
  threadRef,
  onOpen,
  onResolveTarget,
  onOpenInPanel,
  onOpenInBrowser,
  className,
}: MarkdownFileLinkProps)
{
  const resolveTarget = useCallback(
    () => onResolveTarget({ filePath, targetPath, workspaceRelativePath }),
    [filePath, onResolveTarget, targetPath, workspaceRelativePath],
  )
  const openResolvedTargetInEditor = useCallback(
    async (resolvedTargetPath: string) =>
    {
      try
      {
        const result = await onOpen(resolvedTargetPath)
        if (result._tag === 'Success' || isAtomCommandInterrupted(result))
        {
          return
        }
        reportMarkdownActionFailure(
          { operation: 'open-file-in-editor', target: resolvedTargetPath },
          result.cause,
        )
        const error = squashAtomCommandFailure(result)
        toastManager.add(
          stackedThreadToast({
            type: 'error',
            title: 'Unable to open file',
            description: error instanceof Error ? error.message : 'An error occurred.',
          }),
        )
      }
      catch (cause)
      {
        reportMarkdownActionFailure(
          { operation: 'open-file-in-editor', target: resolvedTargetPath },
          cause,
        )
        toastManager.add(
          stackedThreadToast({
            type: 'error',
            title: 'Unable to open file',
            description: cause instanceof Error ? cause.message : 'An error occurred.',
          }),
        )
      }
    },
    [onOpen],
  )
  const openResolvedFileInBrowser = useCallback(
    async (resolvedFilePath: string) =>
    {
      if (!onOpenInBrowser) return
      try
      {
        const result = await onOpenInBrowser(resolvedFilePath)
        if (result._tag === 'Success' || isAtomCommandInterrupted(result))
        {
          return
        }
        reportMarkdownActionFailure(
          { operation: 'open-file-in-browser', target: resolvedFilePath },
          result.cause,
        )
        const error = squashAtomCommandFailure(result)
        toastManager.add(
          stackedThreadToast({
            type: 'error',
            title: 'Unable to open file in browser',
            description: error instanceof Error ? error.message : 'An error occurred.',
          }),
        )
      }
      catch (cause)
      {
        reportMarkdownActionFailure(
          { operation: 'open-file-in-browser', target: resolvedFilePath },
          cause,
        )
        toastManager.add(
          stackedThreadToast({
            type: 'error',
            title: 'Unable to open file in browser',
            description: cause instanceof Error ? cause.message : 'An error occurred.',
          }),
        )
      }
    },
    [onOpenInBrowser],
  )
  const reportResolutionFailure = useCallback(
    (cause: unknown) =>
    {
      reportMarkdownActionFailure({ operation: 'resolve-file-target', target: targetPath }, cause)
      toastManager.add(
        stackedThreadToast({
          type: 'error',
          title: 'Unable to open file',
          description: cause instanceof Error ? cause.message : 'An error occurred.',
        }),
      )
    },
    [targetPath],
  )
  const handleOpenInEditor = useCallback(() =>
  {
    void (async () =>
    {
      try
      {
        const target = await resolveTarget()
        if (target) await openResolvedTargetInEditor(target.targetPath)
      }
      catch (cause)
      {
        reportResolutionFailure(cause)
      }
    })()
  }, [openResolvedTargetInEditor, reportResolutionFailure, resolveTarget])

  const handleOpenPrimary = useCallback(() =>
  {
    void (async () =>
    {
      try
      {
        const action = await resolveWorkspaceFilePrimaryAction({
          resolveTarget,
          hasThreadContext: Boolean(threadRef),
          canOpenInBrowser: (resolvedFilePath) =>
            Boolean(onOpenInBrowser) &&
            shouldOpenMarkdownFileLinkInBrowserByDefault(resolvedFilePath),
        })
        if (!action) return
        if (action.kind === 'editor')
        {
          await openResolvedTargetInEditor(action.targetPath)
          return
        }
        if (action.kind === 'browser')
        {
          await openResolvedFileInBrowser(action.filePath)
          return
        }
        onOpenInPanel(action.workspaceRelativePath, line)
      }
      catch (cause)
      {
        reportResolutionFailure(cause)
      }
    })()
  }, [
    line,
    onOpenInBrowser,
    onOpenInPanel,
    openResolvedFileInBrowser,
    openResolvedTargetInEditor,
    reportResolutionFailure,
    resolveTarget,
    threadRef,
  ])

  const handleOpenInBrowser = useCallback(() =>
  {
    if (!onOpenInBrowser)
    {
      return
    }
    void (async () =>
    {
      try
      {
        const target = await resolveTarget()
        if (target && isBrowserPreviewFile(target.filePath))
        {
          await openResolvedFileInBrowser(target.filePath)
        }
      }
      catch (cause)
      {
        reportResolutionFailure(cause)
      }
    })()
  }, [onOpenInBrowser, openResolvedFileInBrowser, reportResolutionFailure, resolveTarget])

  const handleCopy = useCallback(
    (value: string, title: string) =>
    {
      if (typeof window === 'undefined' || !navigator.clipboard?.writeText)
      {
        toastManager.add(
          stackedThreadToast({
            type: 'error',
            title: `Failed to copy ${title.toLowerCase()}`,
            description: 'Clipboard API unavailable.',
          }),
        )
        return
      }

      void navigator.clipboard.writeText(value).then(
        () =>
        {
          toastManager.add({
            type: 'success',
            title: `${title} copied`,
            description: value,
          })
        },
        (error) =>
        {
          reportMarkdownActionFailure(
            { operation: 'copy-file-path', target: targetPath, copyTarget: title },
            error,
          )
          toastManager.add(
            stackedThreadToast({
              type: 'error',
              title: `Failed to copy ${title.toLowerCase()}`,
              description: error instanceof Error ? error.message : 'An error occurred.',
            }),
          )
        },
      )
    },
    [targetPath],
  )

  const handleContextMenu = useCallback(
    async (event: ReactMouseEvent<HTMLAnchorElement>) =>
    {
      event.preventDefault()
      event.stopPropagation()

      const api = readLocalApi()
      if (!api) return

      try
      {
        const clicked = await api.contextMenu.show(
          [
            { id: 'open', label: 'Open in editor' },
            ...(onOpenInBrowser && isBrowserPreviewFile(filePath)
              ? ([{ id: 'open-in-browser', label: 'Open in integrated browser' }] as const)
              : []),
            { id: 'copy-relative', label: 'Copy relative path' },
            { id: 'copy-full', label: 'Copy full path' },
          ] as const,
          { x: event.clientX, y: event.clientY },
        )

        if (clicked === 'open')
        {
          handleOpenInEditor()
          return
        }
        if (clicked === 'open-in-browser')
        {
          handleOpenInBrowser()
          return
        }
        if (clicked === 'copy-relative')
        {
          handleCopy(displayPath, 'Relative path')
          return
        }
        if (clicked === 'copy-full')
        {
          handleCopy(targetPath, 'Full path')
        }
      }
      catch (cause)
      {
        reportMarkdownActionFailure(
          { operation: 'show-file-context-menu', target: targetPath },
          cause,
        )
      }
    },
    [
      displayPath,
      filePath,
      handleCopy,
      handleOpenInBrowser,
      handleOpenInEditor,
      onOpenInBrowser,
      targetPath,
    ],
  )

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <a
            href={href}
            className={cn(CHAT_FILE_TAG_CHIP_CLASS_NAME, MARKDOWN_FILE_LINK_CLASS_NAME, className)}
            data-markdown-copy={copyMarkdown}
            onClick={(event) =>
            {
              event.preventDefault()
              event.stopPropagation()
              if (shouldOpenMarkdownFileLinkInEditor(event))
              {
                handleOpenInEditor()
                return
              }
              handleOpenPrimary()
            }}
            onContextMenu={handleContextMenu}
          >
            <FileTagChipContent path={iconPath} label={label} theme={theme} selectable />
          </a>
        }
      />
      <TooltipPopup
        side="top"
        className="max-w-[min(40rem,calc(100vw-2rem))] font-mono text-[11px] leading-tight"
      >
        {/* show the full path: the chip already displays the shortened form,
            and a link to the workspace root collapses to a bare label that
            would otherwise repeat it. */}
        <div className="markdown-file-link-tooltip-scroll overflow-x-auto whitespace-nowrap">
          {targetPath}
        </div>
      </TooltipPopup>
    </Tooltip>
  )
}, areMarkdownFileLinkPropsEqual)

function areMarkdownFileLinkPropsEqual(
  previous: Readonly<MarkdownFileLinkProps>,
  next: Readonly<MarkdownFileLinkProps>,
): boolean
{
  return (
    previous.href === next.href &&
    previous.filePath === next.filePath &&
    previous.targetPath === next.targetPath &&
    previous.iconPath === next.iconPath &&
    previous.displayPath === next.displayPath &&
    previous.workspaceRelativePath === next.workspaceRelativePath &&
    previous.line === next.line &&
    previous.label === next.label &&
    previous.copyMarkdown === next.copyMarkdown &&
    previous.theme === next.theme &&
    previous.threadRef === next.threadRef &&
    previous.onOpen === next.onOpen &&
    previous.onResolveTarget === next.onResolveTarget &&
    previous.onOpenInPanel === next.onOpenInPanel &&
    previous.onOpenInBrowser === next.onOpenInBrowser &&
    previous.className === next.className
  )
}
