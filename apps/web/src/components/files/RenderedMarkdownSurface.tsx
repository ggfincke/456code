// apps/web/src/components/files/RenderedMarkdownSurface.tsx
// rendered markdown/mdx preview surface for file preview panel

import type {
  EditorId,
  EnvironmentId,
  ResolvedKeybindingsConfig,
  ScopedThreadRef,
} from '@t3tools/contracts'
import { isWorkspaceImagePreviewPath } from '@t3tools/shared/filePreview'
import { VirtualizedFile, type SelectedLineRange } from '@pierre/diffs'
import { Editor } from '@pierre/diffs/editor'
import { EditorProvider, File, type FileOptions, Virtualizer } from '@pierre/diffs/react'
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from '@t3tools/client-runtime/state/runtime'
import { ChevronRight, Code2, Eye, FolderTree, Globe2, LoaderCircle } from 'lucide-react'
import * as Schema from 'effect/Schema'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { isBrowserPreviewFile, openFileInPreview } from '~/browser/openFileInPreview'
import { useAssetUrlState } from '~/assets/assetUrls'
import ChatMarkdown from '~/components/ChatMarkdown'
import { OpenInPicker } from '~/components/chat/OpenInPicker'
import { useClientSettings } from '~/hooks/useSettings'
import { useTheme } from '~/hooks/useTheme'
import { useSyntaxThemeName } from '~/hooks/useSyntaxThemeName'
import { getLocalStorageItem, setLocalStorageItem } from '~/hooks/useLocalStorage'
import { cn } from '~/lib/utils'
import { isPreviewSupportedInRuntime } from '~/previewStateStore'
import { resolvePathLinkTarget } from '~/terminal-links'
import { ScrollArea } from '~/components/ui/scroll-area'
import { Toggle } from '~/components/ui/toggle'
import { Tooltip, TooltipPopup, TooltipTrigger } from '~/components/ui/tooltip'
import { stackedThreadToast, toastManager } from '~/components/ui/toast'
import { type DraftId, useComposerDraftStore } from '~/composerDraftStore'
import { buildFileReviewComment } from '~/reviewCommentContext'
import { assetEnvironment } from '~/state/assets'
import { useEnvironmentHttpBaseUrl, usePrimaryEnvironmentId } from '~/state/environments'
import { useServerConfigs } from '~/state/entities'
import { previewEnvironment } from '~/state/preview'
import { projectEnvironment } from '~/state/projects'
import { useAtomCommand } from '~/state/use-atom-command'
import { useAtomQueryRunner } from '~/state/use-atom-query-runner'

import FileBrowserPanel from './FileBrowserPanel'
import {
  type FileCommentAnnotationEntry,
  type FileCommentAnnotationGroup,
  type FileCommentLineAnnotation,
  formatFileCommentRange,
  nextFileCommentId,
  normalizeFileCommentRange,
  remapFileCommentAnnotations,
} from './fileCommentAnnotations'
import { installFileEditorDismissal } from './fileEditorDismissal'
import { LocalCommentAnnotation } from './LocalCommentAnnotation'
import { projectFileCacheKey } from './fileContentRevision'
import { fileBreadcrumbs } from './filePath'
import { isMarkdownPreviewFile, isMdxPreviewFile, setMarkdownTaskChecked } from './filePreviewMode'
import {
  FileSaveCoordinator,
  type FileSavePendingOwner,
  updateFileSavePendingOwners,
} from './fileSaveCoordinator'
import {
  confirmProjectFileQueryData,
  confirmProjectMdxFileQueryData,
  getOptimisticProjectFileQueryData,
  setProjectFileQueryData,
  useProjectFileQuery,
  useProjectMdxDocumentQuery,
} from './projectFilesQueryState'
import { SafeDocumentRenderer } from './SafeDocumentRenderer'

import { type EditableFileSurfaceProps, useFileSaveCoordinator } from './EditableFileSurface'

export function RenderedMarkdownSurface({
  environmentId,
  cwd,
  relativePath,
  contents,
  threadRef,
  onPendingChange,
}: Omit<
  EditableFileSurfaceProps,
  | 'resolvedTheme'
  | 'composerDraftTarget'
  | 'revealLine'
  | 'revealRequestId'
  | 'wordWrap'
  | 'onPostRender'
>)
{
  const saveCoordinator = useFileSaveCoordinator({
    environmentId,
    cwd,
    relativePath,
    threadRef,
    onPendingChange,
  })

  return (
    <ScrollArea className="min-h-0 flex-1">
      <ChatMarkdown
        text={contents}
        cwd={cwd}
        threadRef={threadRef}
        className="mx-auto max-w-4xl px-6 py-5"
        onTaskListChange={({ markerOffset, checked }) =>
        {
          const currentContents =
            getOptimisticProjectFileQueryData(environmentId, cwd, relativePath)?.contents ??
            contents
          const nextContents = setMarkdownTaskChecked(currentContents, markerOffset, checked)
          if (nextContents === currentContents) return
          setProjectFileQueryData(environmentId, cwd, relativePath, nextContents)
          saveCoordinator.change(nextContents)
        }}
      />
    </ScrollArea>
  )
}
