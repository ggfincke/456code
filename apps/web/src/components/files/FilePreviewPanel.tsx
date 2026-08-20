// apps/web/src/components/files/FilePreviewPanel.tsx
// renders editable workspace files & safe rendered document previews

import type {
  EditorId,
  EnvironmentId,
  ResolvedKeybindingsConfig,
  ScopedThreadRef,
} from '@t3tools/contracts'
import { isWorkspaceImagePreviewPath } from '@t3tools/shared/filePreview'
import { EditorProvider, File, Virtualizer } from '@pierre/diffs/react'
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from '@t3tools/client-runtime/state/runtime'
import { ChevronRight, Code2, Eye, FolderTree, Globe2, LoaderCircle } from 'lucide-react'
import * as Schema from 'effect/Schema'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { isBrowserPreviewFile, openFileInPreview } from '~/browser/openFileInPreview'
import { useAssetUrlState } from '~/assets/assetUrls'
import { OpenInPicker } from '~/components/chat/OpenInPicker'
import { useClientSettings } from '~/hooks/useSettings'
import { getLocalStorageItem, setLocalStorageItem } from '~/hooks/useLocalStorage'
import { useTheme } from '~/hooks/useTheme'
import { useSyntaxThemeName } from '~/hooks/useSyntaxThemeName'
import { useRemoteOpenState } from '~/lib/remoteOpen'
import { cn } from '~/lib/utils'
import { isPreviewSupportedInRuntime } from '~/previewStateStore'
import { resolvePathLinkTarget } from '~/terminal-links'
import { ScrollArea } from '~/components/ui/scroll-area'
import { Toggle } from '~/components/ui/toggle'
import { Tooltip, TooltipPopup, TooltipTrigger } from '~/components/ui/tooltip'
import { stackedThreadToast, toastManager } from '~/components/ui/toast'
import { type DraftId, useComposerDraftStore } from '~/composerDraftStore'
import { assetEnvironment } from '~/state/assets'
import { useEnvironmentHttpBaseUrl, usePrimaryEnvironmentId } from '~/state/environments'
import { useServerConfigs } from '~/state/entities'
import { previewEnvironment } from '~/state/preview'
import { projectEnvironment } from '~/state/projects'
import { useAtomCommand } from '~/state/use-atom-command'
import { useAtomQueryRunner } from '~/state/use-atom-query-runner'

import FileBrowserPanel from './FileBrowserPanel'
import { EditableFileSurface, type MdxPreviewNotice } from './EditableFileSurface'
import { RenderedMarkdownSurface } from './RenderedMarkdownSurface'
import { projectFileCacheKey } from './fileContentRevision'
import { FILE_LINK_REVEAL_UNSAFE_CSS, useFileLineReveal } from './fileLinkReveal'
import { fileBreadcrumbs } from './filePath'
import { isMarkdownPreviewFile, isMdxPreviewFile } from './filePreviewMode'
import { type FileSavePendingOwner, updateFileSavePendingOwners } from './fileSaveCoordinator'
import {
  confirmProjectFileQueryData,
  confirmProjectMdxFileQueryData,
  getOptimisticProjectFileQueryData,
  setProjectFileQueryData,
  useProjectFileQuery,
  useProjectMdxDocumentQuery,
} from './projectFilesQueryState'
import { SafeDocumentRenderer } from './SafeDocumentRenderer'

interface FilePreviewPanelProps
{
  environmentId: EnvironmentId
  cwd: string
  projectName: string
  relativePath: string | null
  threadRef: ScopedThreadRef
  composerDraftTarget: ScopedThreadRef | DraftId
  keybindings: ResolvedKeybindingsConfig
  availableEditors: ReadonlyArray<EditorId>
  revealLine: number | null
  revealRequestId: number
  onOpenFile: (relativePath: string, line?: number) => void
  onPendingChange: (relativePath: string, pending: boolean) => void
}

const FILE_EXPLORER_STORAGE_KEY = '456code.fileExplorerOpen'
function WorkspaceImagePreview(props: {
  readonly environmentId: EnvironmentId
  readonly threadRef: ScopedThreadRef
  readonly absolutePath: string
  readonly alt: string
})
{
  const assetUrl = useAssetUrlState(props.environmentId, {
    _tag: 'workspace-file',
    threadId: props.threadRef.threadId,
    path: props.absolutePath,
  })
  const [failedUrl, setFailedUrl] = useState<string | null>(null)

  if (assetUrl._tag === 'Failure' || (assetUrl._tag === 'Success' && failedUrl === assetUrl.url))
  {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-destructive">
        Unable to load workspace image.
      </div>
    )
  }

  return assetUrl._tag === 'Success' ? (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
      <img
        className="max-h-full max-w-full object-contain"
        src={assetUrl.url}
        alt={props.alt}
        onError={() => setFailedUrl(assetUrl.url)}
      />
    </div>
  ) : (
    <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
      <LoaderCircle className="size-5 animate-spin" />
    </div>
  )
}

function initialExplorerOpen(): boolean
{
  try
  {
    return getLocalStorageItem(FILE_EXPLORER_STORAGE_KEY, Schema.Boolean) ?? true
  }
  catch (error)
  {
    console.error(error)
    return true
  }
}

export default function FilePreviewPanel({
  environmentId,
  cwd,
  projectName,
  relativePath,
  threadRef,
  composerDraftTarget,
  keybindings,
  availableEditors,
  revealLine,
  revealRequestId,
  onOpenFile,
  onPendingChange,
}: FilePreviewPanelProps)
{
  const { resolvedTheme } = useTheme()
  const syntaxThemeName = useSyntaxThemeName()
  const wordWrap = useClientSettings((settings) => settings.wordWrap)
  const primaryEnvironmentId = usePrimaryEnvironmentId()
  const remoteOpenState = useRemoteOpenState(environmentId)
  const serverConfigs = useServerConfigs()
  const environmentHttpBaseUrl = useEnvironmentHttpBaseUrl(environmentId)
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
  })
  const openPreview = useAtomCommand(previewEnvironment.open, {
    reportFailure: false,
  })
  const isImage = relativePath !== null && isWorkspaceImagePreviewPath(relativePath)
  const file = useProjectFileQuery(environmentId, cwd, relativePath, !isImage)
  const [explorerOpen, setExplorerOpen] = useState(initialExplorerOpen)
  const [renderedView, setRenderedView] = useState<{
    path: string | null
    revealRequestId: number | null
  }>({ path: null, revealRequestId: null })
  const pendingOwnersByPathRef = useRef<ReadonlyMap<string, ReadonlySet<FileSavePendingOwner>>>(
    new Map(),
  )
  const [pendingOwnersByPath, setPendingOwnersByPath] = useState(pendingOwnersByPathRef.current)
  const breadcrumbRef = useRef<HTMLDivElement>(null)
  const isMarkdown = relativePath ? isMarkdownPreviewFile(relativePath) : false
  const isMdx = relativePath ? isMdxPreviewFile(relativePath) : false
  const isRenderedDocument = isMarkdown || isMdx
  const renderRequested =
    isRenderedDocument &&
    renderedView.path === relativePath &&
    (revealLine === null || renderedView.revealRequestId === revealRequestId)
  const renderMarkdown = isMarkdown && renderRequested
  const renderMdx = isMdx && renderRequested
  const currentFilePending = relativePath !== null && pendingOwnersByPath.has(relativePath)
  const supportsSafeMdx =
    serverConfigs.get(environmentId)?.environment.capabilities.safeMdxDocument === true
  const mdxQueryEnabled =
    renderMdx && supportsSafeMdx && !currentFilePending && file.data?.truncated !== true
  const mdxDocument = useProjectMdxDocumentQuery(
    environmentId,
    threadRef.threadId,
    relativePath ?? '',
    mdxQueryEnabled,
  )
  const mdxDocumentMatchesSource =
    relativePath !== null &&
    file.data !== null &&
    mdxDocument.data?.transportVersion === 1 &&
    mdxDocument.data.relativePath === relativePath &&
    mdxDocument.data.source === file.data.contents
  const mdxDocumentReady =
    mdxQueryEnabled &&
    !mdxDocument.isPending &&
    mdxDocument.error === null &&
    mdxDocumentMatchesSource
  const renderedViewLabel = renderRequested
    ? isMdx
      ? 'Show MDX source'
      : 'Show markdown source'
    : isMdx
      ? 'Show rendered MDX'
      : 'Show rendered markdown'
  const mdxToggleDisabled =
    isMdx && (!supportsSafeMdx || currentFilePending || file.data?.truncated === true)
  const renderedViewTooltip =
    isMdx && !supportsSafeMdx
      ? 'This server does not support safe MDX rendering'
      : isMdx && file.data?.truncated === true
        ? 'Files larger than 1 MB cannot be rendered as MDX'
        : isMdx && currentFilePending
          ? 'Saving before rendering MDX'
          : renderedViewLabel
  const canOpenInBrowser =
    relativePath !== null && isPreviewSupportedInRuntime() && isBrowserPreviewFile(relativePath)
  const absolutePath = relativePath ? resolvePathLinkTarget(relativePath, cwd) : null
  const breadcrumbs = useMemo(
    () => (relativePath ? fileBreadcrumbs(projectName, relativePath) : []),
    [projectName, relativePath],
  )
  const onFilePostRender = useFileLineReveal(relativePath, revealLine, revealRequestId)
  const handlePendingChange = useCallback(
    (path: string, owner: FileSavePendingOwner, pending: boolean) =>
    {
      const current = pendingOwnersByPathRef.current
      const wasPending = current.has(path)
      const next = updateFileSavePendingOwners(current, path, owner, pending)
      if (next === current) return

      pendingOwnersByPathRef.current = next
      setPendingOwnersByPath(next)
      const isPending = next.has(path)
      if (wasPending !== isPending)
      {
        onPendingChange(path, isPending)
      }
    },
    [onPendingChange],
  )

  useEffect(() =>
  {
    const currentCrumb = breadcrumbRef.current?.querySelector<HTMLElement>(
      "[data-current-file-crumb='true']",
    )
    currentCrumb?.scrollIntoView({ block: 'nearest', inline: 'end' })
  }, [relativePath])

  const toggleExplorer = () =>
  {
    setExplorerOpen((current) =>
    {
      const next = !current
      try
      {
        setLocalStorageItem(FILE_EXPLORER_STORAGE_KEY, next, Schema.Boolean)
      }
      catch (error)
      {
        console.error(error)
      }
      return next
    })
  }

  const handleOpenInBrowser = useCallback(() =>
  {
    if (!absolutePath || !environmentHttpBaseUrl) return
    void (async () =>
    {
      const result = await openFileInPreview({
        threadRef,
        filePath: absolutePath,
        httpBaseUrl: environmentHttpBaseUrl,
        createAssetUrl,
        openPreview,
      })
      if (result._tag === 'Success' || isAtomCommandInterrupted(result))
      {
        return
      }
      const error = squashAtomCommandFailure(result)
      toastManager.add(
        stackedThreadToast({
          type: 'error',
          title: 'Unable to open file in browser',
          description: error instanceof Error ? error.message : 'An error occurred.',
        }),
      )
    })()
  }, [absolutePath, createAssetUrl, environmentHttpBaseUrl, openPreview, threadRef])
  const retryMdxPreview = useCallback(() =>
  {
    file.refresh()
    mdxDocument.refresh()
  }, [file.refresh, mdxDocument.refresh])

  let mdxPreviewNotice: MdxPreviewNotice | null = null
  if (renderMdx && !mdxDocumentReady)
  {
    if (currentFilePending)
    {
      mdxPreviewNotice = {
        kind: 'status',
        message: 'Saving the latest source before rendering MDX.',
        retry: false,
      }
    }
    else if (!supportsSafeMdx)
    {
      mdxPreviewNotice = {
        kind: 'error',
        message: 'This server does not support safe MDX rendering.',
        retry: false,
      }
    }
    else if (file.data?.truncated === true)
    {
      mdxPreviewNotice = {
        kind: 'error',
        message: 'MDX files larger than 1 MB cannot be rendered.',
        retry: false,
      }
    }
    else if (mdxDocument.error !== null)
    {
      mdxPreviewNotice = {
        kind: 'error',
        message: mdxDocument.error,
        retry: true,
      }
    }
    else if (mdxDocument.isPending || mdxDocument.data === null)
    {
      mdxPreviewNotice = {
        kind: 'status',
        message: 'Rendering MDX from the saved source.',
        retry: false,
      }
    }
    else
    {
      mdxPreviewNotice = {
        kind: 'error',
        message: 'The rendered MDX does not match the visible source.',
        retry: true,
      }
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {relativePath ? (
        <div className="surface-subheader gap-2 px-3" data-surface-subheader>
          <ScrollArea
            ref={breadcrumbRef}
            hideScrollbars
            scrollFade
            className="min-w-0 flex-1 rounded-none"
            data-file-breadcrumbs
          >
            <div className="flex h-full w-max min-w-full items-center text-xs">
              {breadcrumbs.map((crumb, index) => (
                <div
                  key={crumb.path || 'project'}
                  className="flex min-w-0 shrink-0 items-center"
                  data-current-file-crumb={crumb.kind === 'file'}
                >
                  {index > 0 ? (
                    <ChevronRight className="mx-1 size-3.5 shrink-0 text-muted-foreground/60" />
                  ) : null}
                  <span
                    className={cn(
                      'max-w-40 truncate',
                      crumb.kind === 'file'
                        ? 'font-medium text-foreground'
                        : 'text-muted-foreground',
                    )}
                    title={crumb.path || projectName}
                  >
                    {crumb.label}
                  </span>
                </div>
              ))}
            </div>
          </ScrollArea>
          {absolutePath &&
          (environmentId === primaryEnvironmentId || remoteOpenState.mode !== 'local-exec') ? (
            <OpenInPicker
              environmentId={environmentId}
              keybindings={keybindings}
              availableEditors={availableEditors}
              openInCwd={absolutePath}
              compact
              enableShortcut={false}
            />
          ) : null}
          {isRenderedDocument ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Toggle
                    className={cn('shrink-0', mdxToggleDisabled && 'opacity-50')}
                    pressed={renderRequested}
                    aria-disabled={mdxToggleDisabled}
                    onPressedChange={(pressed) =>
                      {
                      if (mdxToggleDisabled) return
                      setRenderedView({
                        path: pressed ? relativePath : null,
                        revealRequestId: pressed ? revealRequestId : null,
                      })
                    }}
                    aria-label={renderedViewLabel}
                    variant="ghost"
                    size="sm"
                  >
                    {renderRequested ? (
                      <Code2 className="size-3.5" />
                    ) : (
                      <Eye className="size-3.5" />
                    )}
                  </Toggle>
                }
              />
              <TooltipPopup>{renderedViewTooltip}</TooltipPopup>
            </Tooltip>
          ) : null}
          {canOpenInBrowser ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Toggle
                    className="shrink-0"
                    pressed={false}
                    onPressedChange={handleOpenInBrowser}
                    aria-label="Open file in preview browser"
                    variant="ghost"
                    size="sm"
                  >
                    <Globe2 className="size-3.5" />
                  </Toggle>
                }
              />
              <TooltipPopup>Open file in preview browser</TooltipPopup>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  className="shrink-0"
                  pressed={explorerOpen}
                  onPressedChange={toggleExplorer}
                  aria-label={explorerOpen ? 'Hide file explorer' : 'Show file explorer'}
                  variant="ghost"
                  size="sm"
                >
                  <FolderTree className="size-3.5" />
                </Toggle>
              }
            />
            <TooltipPopup>
              {explorerOpen ? 'Hide file explorer' : 'Show file explorer'}
            </TooltipPopup>
          </Tooltip>
        </div>
      ) : null}
      {relativePath && file.data?.truncated ? (
        <div className="shrink-0 border-b border-amber-500/20 bg-amber-500/8 px-3 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
          Preview limited to the first 1 MB of a {file.data.byteLength.toLocaleString()} byte file.
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div
          className={cn(
            'min-w-0 flex-1 flex-col overflow-hidden',
            relativePath ? 'flex' : 'hidden',
          )}
        >
          {relativePath && isImage && absolutePath ? (
            <WorkspaceImagePreview
              key={absolutePath}
              environmentId={environmentId}
              threadRef={threadRef}
              absolutePath={absolutePath}
              alt={relativePath}
            />
          ) : relativePath && file.error && file.data === null ? (
            <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-destructive">
              {file.error}
            </div>
          ) : relativePath && file.data === null ? (
            <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
              <LoaderCircle className="size-5 animate-spin" />
            </div>
          ) : relativePath && file.data ? (
            isMarkdown && renderMarkdown ? (
              <RenderedMarkdownSurface
                environmentId={environmentId}
                cwd={cwd}
                relativePath={relativePath}
                threadRef={threadRef}
                contents={file.data.contents}
                onPendingChange={handlePendingChange}
              />
            ) : isMdx && renderMdx && mdxDocumentReady && mdxDocument.data !== null ? (
              <SafeDocumentRenderer
                document={mdxDocument.data.document}
                source={mdxDocument.data.source}
                documentPath={mdxDocument.data.relativePath}
                environmentId={environmentId}
                threadId={threadRef.threadId}
                onOpenFile={onOpenFile}
              />
            ) : file.data.truncated ? (
              <Virtualizer
                key={`${relativePath}:${syntaxThemeName}:${file.data.byteLength}`}
                className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
                config={{
                  overscrollSize: 600,
                  intersectionObserverMargin: 1200,
                }}
              >
                <File
                  file={{
                    name: relativePath,
                    contents: file.data.contents,
                    cacheKey: projectFileCacheKey(cwd, relativePath, file.data.contents),
                  }}
                  options={{
                    disableFileHeader: true,
                    overflow: wordWrap ? 'wrap' : 'scroll',
                    theme: syntaxThemeName,
                    themeType: resolvedTheme,
                    unsafeCSS: FILE_LINK_REVEAL_UNSAFE_CSS,
                    onPostRender: onFilePostRender,
                  }}
                  className="min-h-full"
                />
              </Virtualizer>
            ) : (
              <div
                key={`${relativePath}:${resolvedTheme}`}
                className="flex min-h-0 flex-1 flex-col overflow-hidden"
              >
                {isMdx && renderMdx && mdxPreviewNotice ? (
                  <div
                    className={cn(
                      'flex shrink-0 items-center justify-between gap-3 border-b px-3 py-2 text-xs',
                      mdxPreviewNotice.kind === 'error'
                        ? 'border-destructive/25 bg-destructive/8 text-destructive'
                        : 'border-border/60 bg-muted/25 text-muted-foreground',
                    )}
                    role={mdxPreviewNotice.kind === 'error' ? 'alert' : 'status'}
                    aria-live={mdxPreviewNotice.kind === 'error' ? 'assertive' : 'polite'}
                  >
                    <span>{mdxPreviewNotice.message}</span>
                    {mdxPreviewNotice.retry ? (
                      <button
                        type="button"
                        className="shrink-0 rounded border border-current/30 px-2 py-1 font-medium hover:bg-current/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={retryMdxPreview}
                      >
                        Retry
                      </button>
                    ) : null}
                  </div>
                ) : null}
                <EditableFileSurface
                  environmentId={environmentId}
                  cwd={cwd}
                  relativePath={relativePath}
                  threadRef={threadRef}
                  composerDraftTarget={composerDraftTarget}
                  contents={file.data.contents}
                  resolvedTheme={resolvedTheme}
                  revealRequestId={revealRequestId}
                  wordWrap={wordWrap}
                  onPostRender={onFilePostRender}
                  onPendingChange={handlePendingChange}
                />
              </div>
            )
          ) : null}
        </div>
        {explorerOpen || relativePath === null ? (
          <aside
            className={cn(
              'flex min-h-0 shrink-0 bg-background',
              relativePath
                ? 'w-[min(22rem,46%)] min-w-64 border-l border-border/60'
                : 'min-w-0 flex-1',
            )}
          >
            <FileBrowserPanel
              key={`${environmentId}:${cwd}`}
              environmentId={environmentId}
              cwd={cwd}
              projectName={projectName}
              onOpenFile={onOpenFile}
              {...(relativePath && !isImage ? { onRefreshSelectedFile: file.refresh } : {})}
            />
          </aside>
        ) : null}
      </div>
    </div>
  )
}
