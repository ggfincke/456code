// apps/web/src/components/files/EditableFileSurface.tsx
// editable pierre file surface with debounced save coordination

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

import {
  FILE_LINK_REVEAL_UNSAFE_CSS,
  type FilePostRender,
  useFileLineReveal,
} from './fileLinkReveal'

const FILE_SAVE_DEBOUNCE_MS = 500

export interface EditableFileSurfaceProps
{
  environmentId: EnvironmentId
  cwd: string
  relativePath: string
  threadRef: ScopedThreadRef
  composerDraftTarget: ScopedThreadRef | DraftId
  contents: string
  resolvedTheme: 'light' | 'dark'
  revealRequestId: number
  wordWrap: boolean
  onPostRender: FilePostRender
  onPendingChange: (relativePath: string, owner: FileSavePendingOwner, pending: boolean) => void
}

interface FileSelectionOverride
{
  revealRequestId: number
  range: SelectedLineRange | null
}

export interface MdxPreviewNotice
{
  readonly kind: 'error' | 'status'
  readonly message: string
  readonly retry: boolean
}

export function useFileSaveCoordinator({
  environmentId,
  cwd,
  relativePath,
  threadRef,
  onPendingChange,
}: Pick<
  EditableFileSurfaceProps,
  'environmentId' | 'cwd' | 'relativePath' | 'threadRef' | 'onPendingChange'
>): FileSaveCoordinator
{
  const writeFile = useAtomCommand(projectEnvironment.writeFile)
  const coordinator = useMemo(() =>
  {
    const owner = Symbol('file-save-coordinator')
    return new FileSaveCoordinator({
      debounceMs: FILE_SAVE_DEBOUNCE_MS,
      onPendingChange: (pending) => onPendingChange(relativePath, owner, pending),
      persist: (nextContents) =>
        writeFile({
          environmentId,
          input: { cwd, relativePath, contents: nextContents },
        }),
      onConfirmed: (confirmedContents) =>
      {
        if (isMdxPreviewFile(relativePath))
        {
          confirmProjectMdxFileQueryData(
            environmentId,
            cwd,
            threadRef.threadId,
            relativePath,
            confirmedContents,
          )
          return
        }
        confirmProjectFileQueryData(environmentId, cwd, relativePath, confirmedContents)
      },
    })
  }, [cwd, environmentId, onPendingChange, relativePath, threadRef.threadId, writeFile])

  useEffect(() => () => coordinator.dispose(), [coordinator])
  return coordinator
}

export function EditableFileSurface({
  environmentId,
  cwd,
  relativePath,
  threadRef,
  composerDraftTarget,
  contents,
  resolvedTheme,
  revealRequestId,
  wordWrap,
  onPostRender,
  onPendingChange,
}: EditableFileSurfaceProps)
{
  const syntaxThemeName = useSyntaxThemeName()
  const addReviewComment = useComposerDraftStore((store) => store.addReviewComment)
  const removeReviewComment = useComposerDraftStore((store) => store.removeReviewComment)
  const [lineAnnotations, setLineAnnotations] = useState<FileCommentLineAnnotation[]>([])
  const [selectionOverride, setSelectionOverride] = useState<FileSelectionOverride | null>(null)
  const selectedRange =
    selectionOverride?.revealRequestId === revealRequestId ? selectionOverride.range : null
  const setSelectedRange = useCallback(
    (range: SelectedLineRange | null) =>
    {
      setSelectionOverride({ revealRequestId, range })
    },
    [revealRequestId],
  )
  const surfaceRef = useRef<HTMLDivElement>(null)
  const selectionFrameRef = useRef<number | null>(null)
  const saveCoordinator = useFileSaveCoordinator({
    environmentId,
    cwd,
    relativePath,
    threadRef,
    onPendingChange,
  })
  const editor = useMemo(
    () =>
      new Editor<FileCommentAnnotationGroup>({
        onChange: (file, nextLineAnnotations) =>
        {
          setProjectFileQueryData(environmentId, cwd, relativePath, file.contents)
          saveCoordinator.change(file.contents)
          if (nextLineAnnotations)
          {
            const remapped = remapFileCommentAnnotations(
              nextLineAnnotations as FileCommentLineAnnotation[],
            )
            setLineAnnotations(remapped)
            for (const annotation of remapped)
            {
              for (const entry of annotation.metadata.entries)
              {
                if (entry.kind !== 'comment') continue
                addReviewComment(
                  composerDraftTarget,
                  buildFileReviewComment({
                    id: entry.id,
                    filePath: relativePath,
                    startLine: entry.startLine,
                    endLine: entry.endLine,
                    text: entry.text,
                    contents: file.contents,
                  }),
                )
              }
            }
          }
        },
      }),
    [addReviewComment, composerDraftTarget, cwd, environmentId, relativePath, saveCoordinator],
  )

  useEffect(
    () => () =>
    {
      editor.cleanUp()
    },
    [editor],
  )

  const removeAnnotationEntry = useCallback(
    (entryId: string) =>
    {
      setSelectedRange(null)
      removeReviewComment(composerDraftTarget, entryId)
      setLineAnnotations((current) =>
      {
        return current.flatMap((annotation) =>
        {
          const entries = annotation.metadata.entries.filter((entry) => entry.id !== entryId)
          return entries.length > 0 ? [{ ...annotation, metadata: { entries } }] : []
        })
      })
    },
    [composerDraftTarget, removeReviewComment, setSelectedRange],
  )

  const submitAnnotationEntry = useCallback(
    (entryId: string, text: string) =>
    {
      setSelectedRange(null)
      const entry = lineAnnotations
        .flatMap((annotation) => annotation.metadata.entries)
        .find((candidate) => candidate.id === entryId)
      if (entry)
      {
        addReviewComment(
          composerDraftTarget,
          buildFileReviewComment({
            id: entry.id,
            filePath: relativePath,
            startLine: entry.startLine,
            endLine: entry.endLine,
            text,
            contents,
          }),
        )
      }
      setLineAnnotations((current) =>
        current.map((annotation) => ({
          ...annotation,
          metadata: {
            entries: annotation.metadata.entries.map((annotationEntry) =>
              annotationEntry.id === entryId
                ? { ...annotationEntry, kind: 'comment', text }
                : annotationEntry,
            ),
          },
        })),
      )
    },
    [
      addReviewComment,
      composerDraftTarget,
      contents,
      lineAnnotations,
      relativePath,
      setSelectedRange,
    ],
  )

  const beginComment = useCallback((range: SelectedLineRange) =>
  {
    const { startLine, endLine } = normalizeFileCommentRange(range)
    const draftEntry: FileCommentAnnotationEntry = {
      id: nextFileCommentId(),
      kind: 'draft',
      startLine,
      endLine,
      text: '',
    }
    setLineAnnotations((current) =>
    {
      const withoutDraft = current.flatMap((annotation) =>
      {
        const entries = annotation.metadata.entries.filter((entry) => entry.kind !== 'draft')
        return entries.length > 0 ? [{ ...annotation, metadata: { entries } }] : []
      })
      const existingIndex = withoutDraft.findIndex(
        (annotation) => annotation.lineNumber === endLine,
      )
      if (existingIndex < 0)
      {
        return [
          ...withoutDraft,
          {
            lineNumber: endLine,
            metadata: { entries: [draftEntry] },
          },
        ]
      }
      return withoutDraft.map((annotation, index) =>
        index === existingIndex
          ? {
              ...annotation,
              metadata: { entries: [...annotation.metadata.entries, draftEntry] },
            }
          : annotation,
      )
    })
  }, [])
  const hasOpenCommentForm = lineAnnotations.some((annotation) =>
    annotation.metadata.entries.some((entry) => entry.kind === 'draft'),
  )
  useEffect(() =>
  {
    const root = surfaceRef.current
    if (!root) return
    return installFileEditorDismissal({
      root,
      editor,
      isBlocked: () => hasOpenCommentForm,
      onDismiss: () => setSelectedRange(null),
    })
  }, [editor, hasOpenCommentForm, setSelectedRange])
  const handleLineSelectionEnd = useCallback(
    (range: SelectedLineRange | null) =>
    {
      setSelectedRange(range)
      if (range)
      {
        beginComment(range)
      }
    },
    [beginComment, setSelectedRange],
  )

  const handlePostRender = useCallback<FilePostRender>(
    (fileContainer, instance, phase) =>
    {
      onPostRender(fileContainer, instance, phase)

      if (selectionFrameRef.current !== null)
      {
        cancelAnimationFrame(selectionFrameRef.current)
        selectionFrameRef.current = null
      }
      if (phase === 'unmount') return

      selectionFrameRef.current = requestAnimationFrame(() =>
      {
        selectionFrameRef.current = null
        if (!fileContainer.isConnected) return
        instance.setSelectedLines(selectedRange, { notify: false })
      })
    },
    [onPostRender, selectedRange],
  )

  return (
    <EditorProvider editor={editor}>
      <div ref={surfaceRef} className="flex min-h-0 flex-1">
        <Virtualizer
          className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
          config={{
            overscrollSize: 600,
            intersectionObserverMargin: 1200,
          }}
        >
          <File<FileCommentAnnotationGroup>
            file={{
              name: relativePath,
              contents,
              cacheKey: projectFileCacheKey(cwd, relativePath, contents),
            }}
            options={{
              disableFileHeader: true,
              enableGutterUtility: !hasOpenCommentForm,
              enableLineSelection: !hasOpenCommentForm,
              onGutterUtilityClick: setSelectedRange,
              onLineSelectionChange: setSelectedRange,
              onLineSelectionEnd: handleLineSelectionEnd,
              overflow: wordWrap ? 'wrap' : 'scroll',
              theme: syntaxThemeName,
              themeType: resolvedTheme,
              unsafeCSS: FILE_LINK_REVEAL_UNSAFE_CSS,
              onPostRender: handlePostRender,
            }}
            selectedLines={selectedRange}
            lineAnnotations={lineAnnotations}
            renderAnnotation={(annotation) => (
              <div className="py-1">
                {annotation.metadata.entries.map((entry) => (
                  <LocalCommentAnnotation
                    key={entry.id}
                    kind={entry.kind}
                    rangeLabel={formatFileCommentRange(entry.startLine, entry.endLine)}
                    text={entry.text}
                    onCancel={() => removeAnnotationEntry(entry.id)}
                    onComment={(text) => submitAnnotationEntry(entry.id, text)}
                    onDelete={() => removeAnnotationEntry(entry.id)}
                  />
                ))}
              </div>
            )}
            className="min-h-full"
            contentEditable
          />
        </Virtualizer>
      </div>
    </EditorProvider>
  )
}
