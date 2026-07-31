// apps/web/src/components/files/FilePreviewPanel.tsx
// renders editable workspace files & safe rendered document previews

import type {
  EditorId,
  EnvironmentId,
  ResolvedKeybindingsConfig,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { isWorkspaceImagePreviewPath } from "@t3tools/shared/filePreview";
import { VirtualizedFile, type SelectedLineRange } from "@pierre/diffs";
import { Editor } from "@pierre/diffs/editor";
import { EditorProvider, File, type FileOptions, Virtualizer } from "@pierre/diffs/react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { ChevronRight, Code2, Eye, FolderTree, Globe2, LoaderCircle } from "lucide-react";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isBrowserPreviewFile, openFileInPreview } from "~/browser/openFileInPreview";
import { useAssetUrlState } from "~/assets/assetUrls";
import ChatMarkdown from "~/components/ChatMarkdown";
import { OpenInPicker } from "~/components/chat/OpenInPicker";
import { useClientSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { useSyntaxThemeName } from "~/hooks/useSyntaxThemeName";
import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { resolvePathLinkTarget } from "~/terminal-links";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Toggle } from "~/components/ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { buildFileReviewComment } from "~/reviewCommentContext";
import { assetEnvironment } from "~/state/assets";
import { useEnvironmentHttpBaseUrl, usePrimaryEnvironmentId } from "~/state/environments";
import { useServerConfigs } from "~/state/entities";
import { previewEnvironment } from "~/state/preview";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

import FileBrowserPanel from "./FileBrowserPanel";
import {
  type FileCommentAnnotationEntry,
  type FileCommentAnnotationGroup,
  type FileCommentLineAnnotation,
  formatFileCommentRange,
  nextFileCommentId,
  normalizeFileCommentRange,
  remapFileCommentAnnotations,
} from "./fileCommentAnnotations";
import { installFileEditorDismissal } from "./fileEditorDismissal";
import { LocalCommentAnnotation } from "./LocalCommentAnnotation";
import { projectFileCacheKey } from "./fileContentRevision";
import { fileBreadcrumbs } from "./filePath";
import { isMarkdownPreviewFile, isMdxPreviewFile, setMarkdownTaskChecked } from "./filePreviewMode";
import {
  FileSaveCoordinator,
  type FileSavePendingOwner,
  updateFileSavePendingOwners,
} from "./fileSaveCoordinator";
import {
  confirmProjectFileQueryData,
  confirmProjectMdxFileQueryData,
  getOptimisticProjectFileQueryData,
  setProjectFileQueryData,
  useProjectFileQuery,
  useProjectMdxDocumentQuery,
} from "./projectFilesQueryState";
import { SafeDocumentRenderer } from "./SafeDocumentRenderer";

interface FilePreviewPanelProps {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  relativePath: string | null;
  threadRef: ScopedThreadRef;
  composerDraftTarget: ScopedThreadRef | DraftId;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  revealLine: number | null;
  revealRequestId: number;
  onOpenFile: (relativePath: string, line?: number) => void;
  onPendingChange: (relativePath: string, pending: boolean) => void;
}

const FILE_EXPLORER_STORAGE_KEY = "456code.fileExplorerOpen";
const FILE_SAVE_DEBOUNCE_MS = 500;
const FILE_LINK_REVEAL_ATTRIBUTE = "data-file-link-reveal";
const FILE_LINK_REVEAL_UNSAFE_CSS = `
  [${FILE_LINK_REVEAL_ATTRIBUTE}][data-line] {
    background-color: light-dark(
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) 82%,
        var(--diffs-bg-selection-override, var(--diffs-selection-base))
      ),
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) 75%,
        var(--diffs-bg-selection-override, var(--diffs-selection-base))
      )
    ) !important;
  }

  [${FILE_LINK_REVEAL_ATTRIBUTE}][data-column-number] {
    background-color: light-dark(
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) 75%,
        var(--diffs-bg-selection-number-override, var(--diffs-selection-base))
      ),
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) 60%,
        var(--diffs-bg-selection-number-override, var(--diffs-selection-base))
      )
    ) !important;
    color: var(--diffs-selection-number-fg) !important;
  }
`;
type FilePostRender = NonNullable<FileOptions<unknown>["onPostRender"]>;

function WorkspaceImagePreview(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly absolutePath: string;
  readonly alt: string;
}) {
  const assetUrl = useAssetUrlState(props.environmentId, {
    _tag: "workspace-file",
    threadId: props.threadRef.threadId,
    path: props.absolutePath,
  });
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  if (assetUrl._tag === "Failure" || (assetUrl._tag === "Success" && failedUrl === assetUrl.url)) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-destructive">
        Unable to load workspace image.
      </div>
    );
  }

  return assetUrl._tag === "Success" ? (
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
  );
}

function clampFileLine(contents: string, requestedLine: number): number {
  let lineCount = 1;
  for (let index = 0; index < contents.length; index += 1) {
    const character = contents.charCodeAt(index);
    if (character === 10) {
      lineCount += 1;
    } else if (character === 13) {
      lineCount += 1;
      if (contents.charCodeAt(index + 1) === 10) index += 1;
    }
  }
  return Math.min(Math.max(1, requestedLine), lineCount);
}

function updateFileLinkReveal(fileContainer: HTMLElement, line: number | null): void {
  const root = fileContainer.shadowRoot ?? fileContainer;
  for (const element of root.querySelectorAll<HTMLElement>(`[${FILE_LINK_REVEAL_ATTRIBUTE}]`)) {
    element.removeAttribute(FILE_LINK_REVEAL_ATTRIBUTE);
  }
  if (line === null) return;

  root
    .querySelector<HTMLElement>(`[data-line="${line}"]`)
    ?.setAttribute(FILE_LINK_REVEAL_ATTRIBUTE, "");
  root
    .querySelector<HTMLElement>(`[data-column-number="${line}"]`)
    ?.setAttribute(FILE_LINK_REVEAL_ATTRIBUTE, "");
}

function useFileLineReveal(
  relativePath: string | null,
  revealLine: number | null,
  revealRequestId: number,
): FilePostRender {
  const [handledRequestIdsByPath] = useState(() => new Map<string, number>());
  const [latestRequestIdsByPath] = useState(() => new Map<string, number>());
  const [pendingFramesByPath] = useState(() => new Map<string, number>());

  return useCallback<FilePostRender>(
    (fileContainer, instance, phase) => {
      if (relativePath === null) return;

      const cancelPendingReveal = () => {
        const frameId = pendingFramesByPath.get(relativePath);
        if (frameId !== undefined) {
          cancelAnimationFrame(frameId);
          pendingFramesByPath.delete(relativePath);
        }
      };

      if (phase === "unmount") {
        cancelPendingReveal();
        return;
      }

      const targetLine =
        revealLine === null ? null : clampFileLine(instance.file?.contents ?? "", revealLine);
      updateFileLinkReveal(fileContainer, targetLine);

      if (!(instance instanceof VirtualizedFile)) return;

      if (latestRequestIdsByPath.get(relativePath) !== revealRequestId) {
        cancelPendingReveal();
        latestRequestIdsByPath.set(relativePath, revealRequestId);
      }

      if (targetLine === null) {
        fileContainer.style.minHeight = "";
        return;
      }

      const scrollContainer = fileContainer.closest<HTMLElement>(".file-preview-virtualizer");
      if (!scrollContainer) return;
      fileContainer.style.minHeight = `${Math.ceil(
        Math.max(instance.height, scrollContainer.clientHeight),
      )}px`;

      if (
        handledRequestIdsByPath.get(relativePath) === revealRequestId ||
        pendingFramesByPath.has(relativePath)
      ) {
        return;
      }

      const reveal = () => {
        pendingFramesByPath.delete(relativePath);
        if (
          latestRequestIdsByPath.get(relativePath) !== revealRequestId ||
          !fileContainer.isConnected
        ) {
          return;
        }

        const linePosition = instance.getLinePosition(targetLine);
        if (!linePosition) return;

        const fileTop =
          scrollContainer.scrollTop +
          fileContainer.getBoundingClientRect().top -
          scrollContainer.getBoundingClientRect().top;
        const centeredTop = Math.max(
          0,
          fileTop +
            linePosition.top -
            Math.max(0, (scrollContainer.clientHeight - linePosition.height) / 2),
        );
        const maxScrollTop = Math.max(
          0,
          scrollContainer.scrollHeight - scrollContainer.clientHeight,
        );

        scrollContainer.scrollTop = Math.min(centeredTop, maxScrollTop);
        handledRequestIdsByPath.set(relativePath, revealRequestId);
      };

      pendingFramesByPath.set(relativePath, requestAnimationFrame(reveal));
    },
    [
      handledRequestIdsByPath,
      latestRequestIdsByPath,
      pendingFramesByPath,
      relativePath,
      revealLine,
      revealRequestId,
    ],
  );
}

interface EditableFileSurfaceProps {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  threadRef: ScopedThreadRef;
  composerDraftTarget: ScopedThreadRef | DraftId;
  contents: string;
  resolvedTheme: "light" | "dark";
  revealRequestId: number;
  wordWrap: boolean;
  onPostRender: FilePostRender;
  onPendingChange: (relativePath: string, owner: FileSavePendingOwner, pending: boolean) => void;
}

interface FileSelectionOverride {
  revealRequestId: number;
  range: SelectedLineRange | null;
}

interface MdxPreviewNotice {
  readonly kind: "error" | "status";
  readonly message: string;
  readonly retry: boolean;
}

function useFileSaveCoordinator({
  environmentId,
  cwd,
  relativePath,
  threadRef,
  onPendingChange,
}: Pick<
  EditableFileSurfaceProps,
  "environmentId" | "cwd" | "relativePath" | "threadRef" | "onPendingChange"
>): FileSaveCoordinator {
  const writeFile = useAtomCommand(projectEnvironment.writeFile);
  const coordinator = useMemo(() => {
    const owner = Symbol("file-save-coordinator");
    return new FileSaveCoordinator({
      debounceMs: FILE_SAVE_DEBOUNCE_MS,
      onPendingChange: (pending) => onPendingChange(relativePath, owner, pending),
      persist: (nextContents) =>
        writeFile({
          environmentId,
          input: { cwd, relativePath, contents: nextContents },
        }),
      onConfirmed: (confirmedContents) => {
        if (isMdxPreviewFile(relativePath)) {
          confirmProjectMdxFileQueryData(
            environmentId,
            cwd,
            threadRef.threadId,
            relativePath,
            confirmedContents,
          );
          return;
        }
        confirmProjectFileQueryData(environmentId, cwd, relativePath, confirmedContents);
      },
    });
  }, [cwd, environmentId, onPendingChange, relativePath, threadRef.threadId, writeFile]);

  useEffect(() => () => coordinator.dispose(), [coordinator]);
  return coordinator;
}

function EditableFileSurface({
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
}: EditableFileSurfaceProps) {
  const syntaxThemeName = useSyntaxThemeName();
  const addReviewComment = useComposerDraftStore((store) => store.addReviewComment);
  const removeReviewComment = useComposerDraftStore((store) => store.removeReviewComment);
  const [lineAnnotations, setLineAnnotations] = useState<FileCommentLineAnnotation[]>([]);
  const [selectionOverride, setSelectionOverride] = useState<FileSelectionOverride | null>(null);
  const selectedRange =
    selectionOverride?.revealRequestId === revealRequestId ? selectionOverride.range : null;
  const setSelectedRange = useCallback(
    (range: SelectedLineRange | null) => {
      setSelectionOverride({ revealRequestId, range });
    },
    [revealRequestId],
  );
  const surfaceRef = useRef<HTMLDivElement>(null);
  const selectionFrameRef = useRef<number | null>(null);
  const saveCoordinator = useFileSaveCoordinator({
    environmentId,
    cwd,
    relativePath,
    threadRef,
    onPendingChange,
  });
  const editor = useMemo(
    () =>
      new Editor<FileCommentAnnotationGroup>({
        onChange: (file, nextLineAnnotations) => {
          setProjectFileQueryData(environmentId, cwd, relativePath, file.contents);
          saveCoordinator.change(file.contents);
          if (nextLineAnnotations) {
            const remapped = remapFileCommentAnnotations(
              nextLineAnnotations as FileCommentLineAnnotation[],
            );
            setLineAnnotations(remapped);
            for (const annotation of remapped) {
              for (const entry of annotation.metadata.entries) {
                if (entry.kind !== "comment") continue;
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
                );
              }
            }
          }
        },
      }),
    [addReviewComment, composerDraftTarget, cwd, environmentId, relativePath, saveCoordinator],
  );

  useEffect(
    () => () => {
      editor.cleanUp();
    },
    [editor],
  );

  const removeAnnotationEntry = useCallback(
    (entryId: string) => {
      setSelectedRange(null);
      removeReviewComment(composerDraftTarget, entryId);
      setLineAnnotations((current) => {
        return current.flatMap((annotation) => {
          const entries = annotation.metadata.entries.filter((entry) => entry.id !== entryId);
          return entries.length > 0 ? [{ ...annotation, metadata: { entries } }] : [];
        });
      });
    },
    [composerDraftTarget, removeReviewComment, setSelectedRange],
  );

  const submitAnnotationEntry = useCallback(
    (entryId: string, text: string) => {
      setSelectedRange(null);
      const entry = lineAnnotations
        .flatMap((annotation) => annotation.metadata.entries)
        .find((candidate) => candidate.id === entryId);
      if (entry) {
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
        );
      }
      setLineAnnotations((current) =>
        current.map((annotation) => ({
          ...annotation,
          metadata: {
            entries: annotation.metadata.entries.map((annotationEntry) =>
              annotationEntry.id === entryId
                ? { ...annotationEntry, kind: "comment", text }
                : annotationEntry,
            ),
          },
        })),
      );
    },
    [
      addReviewComment,
      composerDraftTarget,
      contents,
      lineAnnotations,
      relativePath,
      setSelectedRange,
    ],
  );

  const beginComment = useCallback((range: SelectedLineRange) => {
    const { startLine, endLine } = normalizeFileCommentRange(range);
    const draftEntry: FileCommentAnnotationEntry = {
      id: nextFileCommentId(),
      kind: "draft",
      startLine,
      endLine,
      text: "",
    };
    setLineAnnotations((current) => {
      const withoutDraft = current.flatMap((annotation) => {
        const entries = annotation.metadata.entries.filter((entry) => entry.kind !== "draft");
        return entries.length > 0 ? [{ ...annotation, metadata: { entries } }] : [];
      });
      const existingIndex = withoutDraft.findIndex(
        (annotation) => annotation.lineNumber === endLine,
      );
      if (existingIndex < 0) {
        return [
          ...withoutDraft,
          {
            lineNumber: endLine,
            metadata: { entries: [draftEntry] },
          },
        ];
      }
      return withoutDraft.map((annotation, index) =>
        index === existingIndex
          ? {
              ...annotation,
              metadata: { entries: [...annotation.metadata.entries, draftEntry] },
            }
          : annotation,
      );
    });
  }, []);
  const hasOpenCommentForm = lineAnnotations.some((annotation) =>
    annotation.metadata.entries.some((entry) => entry.kind === "draft"),
  );
  useEffect(() => {
    const root = surfaceRef.current;
    if (!root) return;
    return installFileEditorDismissal({
      root,
      editor,
      isBlocked: () => hasOpenCommentForm,
      onDismiss: () => setSelectedRange(null),
    });
  }, [editor, hasOpenCommentForm, setSelectedRange]);
  const handleLineSelectionEnd = useCallback(
    (range: SelectedLineRange | null) => {
      setSelectedRange(range);
      if (range) {
        beginComment(range);
      }
    },
    [beginComment, setSelectedRange],
  );

  const handlePostRender = useCallback<FilePostRender>(
    (fileContainer, instance, phase) => {
      onPostRender(fileContainer, instance, phase);

      if (selectionFrameRef.current !== null) {
        cancelAnimationFrame(selectionFrameRef.current);
        selectionFrameRef.current = null;
      }
      if (phase === "unmount") return;

      selectionFrameRef.current = requestAnimationFrame(() => {
        selectionFrameRef.current = null;
        if (!fileContainer.isConnected) return;
        instance.setSelectedLines(selectedRange, { notify: false });
      });
    },
    [onPostRender, selectedRange],
  );

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
              overflow: wordWrap ? "wrap" : "scroll",
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
  );
}

function RenderedMarkdownSurface({
  environmentId,
  cwd,
  relativePath,
  contents,
  threadRef,
  onPendingChange,
}: Omit<
  EditableFileSurfaceProps,
  | "resolvedTheme"
  | "composerDraftTarget"
  | "revealLine"
  | "revealRequestId"
  | "wordWrap"
  | "onPostRender"
>) {
  const saveCoordinator = useFileSaveCoordinator({
    environmentId,
    cwd,
    relativePath,
    threadRef,
    onPendingChange,
  });

  return (
    <ScrollArea className="min-h-0 flex-1">
      <ChatMarkdown
        text={contents}
        cwd={cwd}
        threadRef={threadRef}
        className="mx-auto max-w-4xl px-6 py-5"
        onTaskListChange={({ markerOffset, checked }) => {
          const currentContents =
            getOptimisticProjectFileQueryData(environmentId, cwd, relativePath)?.contents ??
            contents;
          const nextContents = setMarkdownTaskChecked(currentContents, markerOffset, checked);
          if (nextContents === currentContents) return;
          setProjectFileQueryData(environmentId, cwd, relativePath, nextContents);
          saveCoordinator.change(nextContents);
        }}
      />
    </ScrollArea>
  );
}

function initialExplorerOpen(): boolean {
  try {
    return getLocalStorageItem(FILE_EXPLORER_STORAGE_KEY, Schema.Boolean) ?? true;
  } catch (error) {
    console.error(error);
    return true;
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
}: FilePreviewPanelProps) {
  const { resolvedTheme } = useTheme();
  const syntaxThemeName = useSyntaxThemeName();
  const wordWrap = useClientSettings((settings) => settings.wordWrap);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const serverConfigs = useServerConfigs();
  const environmentHttpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
  });
  const openPreview = useAtomCommand(previewEnvironment.open, {
    reportFailure: false,
  });
  const isImage = relativePath !== null && isWorkspaceImagePreviewPath(relativePath);
  const file = useProjectFileQuery(environmentId, cwd, relativePath, !isImage);
  const [explorerOpen, setExplorerOpen] = useState(initialExplorerOpen);
  const [renderedView, setRenderedView] = useState<{
    path: string | null;
    revealRequestId: number | null;
  }>({ path: null, revealRequestId: null });
  const pendingOwnersByPathRef = useRef<ReadonlyMap<string, ReadonlySet<FileSavePendingOwner>>>(
    new Map(),
  );
  const [pendingOwnersByPath, setPendingOwnersByPath] = useState(pendingOwnersByPathRef.current);
  const breadcrumbRef = useRef<HTMLDivElement>(null);
  const isMarkdown = relativePath ? isMarkdownPreviewFile(relativePath) : false;
  const isMdx = relativePath ? isMdxPreviewFile(relativePath) : false;
  const isRenderedDocument = isMarkdown || isMdx;
  const renderRequested =
    isRenderedDocument &&
    renderedView.path === relativePath &&
    (revealLine === null || renderedView.revealRequestId === revealRequestId);
  const renderMarkdown = isMarkdown && renderRequested;
  const renderMdx = isMdx && renderRequested;
  const currentFilePending = relativePath !== null && pendingOwnersByPath.has(relativePath);
  const supportsSafeMdx =
    serverConfigs.get(environmentId)?.environment.capabilities.safeMdxDocument === true;
  const mdxQueryEnabled =
    renderMdx && supportsSafeMdx && !currentFilePending && file.data?.truncated !== true;
  const mdxDocument = useProjectMdxDocumentQuery(
    environmentId,
    threadRef.threadId,
    relativePath ?? "",
    mdxQueryEnabled,
  );
  const mdxDocumentMatchesSource =
    relativePath !== null &&
    file.data !== null &&
    mdxDocument.data?.transportVersion === 1 &&
    mdxDocument.data.relativePath === relativePath &&
    mdxDocument.data.source === file.data.contents;
  const mdxDocumentReady =
    mdxQueryEnabled &&
    !mdxDocument.isPending &&
    mdxDocument.error === null &&
    mdxDocumentMatchesSource;
  const renderedViewLabel = renderRequested
    ? isMdx
      ? "Show MDX source"
      : "Show markdown source"
    : isMdx
      ? "Show rendered MDX"
      : "Show rendered markdown";
  const mdxToggleDisabled =
    isMdx && (!supportsSafeMdx || currentFilePending || file.data?.truncated === true);
  const renderedViewTooltip =
    isMdx && !supportsSafeMdx
      ? "This server does not support safe MDX rendering"
      : isMdx && file.data?.truncated === true
        ? "Files larger than 1 MB cannot be rendered as MDX"
        : isMdx && currentFilePending
          ? "Saving before rendering MDX"
          : renderedViewLabel;
  const canOpenInBrowser =
    relativePath !== null && isPreviewSupportedInRuntime() && isBrowserPreviewFile(relativePath);
  const absolutePath = relativePath ? resolvePathLinkTarget(relativePath, cwd) : null;
  const breadcrumbs = useMemo(
    () => (relativePath ? fileBreadcrumbs(projectName, relativePath) : []),
    [projectName, relativePath],
  );
  const onFilePostRender = useFileLineReveal(relativePath, revealLine, revealRequestId);
  const handlePendingChange = useCallback(
    (path: string, owner: FileSavePendingOwner, pending: boolean) => {
      const current = pendingOwnersByPathRef.current;
      const wasPending = current.has(path);
      const next = updateFileSavePendingOwners(current, path, owner, pending);
      if (next === current) return;

      pendingOwnersByPathRef.current = next;
      setPendingOwnersByPath(next);
      const isPending = next.has(path);
      if (wasPending !== isPending) {
        onPendingChange(path, isPending);
      }
    },
    [onPendingChange],
  );

  useEffect(() => {
    const currentCrumb = breadcrumbRef.current?.querySelector<HTMLElement>(
      "[data-current-file-crumb='true']",
    );
    currentCrumb?.scrollIntoView({ block: "nearest", inline: "end" });
  }, [relativePath]);

  const toggleExplorer = () => {
    setExplorerOpen((current) => {
      const next = !current;
      try {
        setLocalStorageItem(FILE_EXPLORER_STORAGE_KEY, next, Schema.Boolean);
      } catch (error) {
        console.error(error);
      }
      return next;
    });
  };

  const handleOpenInBrowser = useCallback(() => {
    if (!absolutePath || !environmentHttpBaseUrl) return;
    void (async () => {
      const result = await openFileInPreview({
        threadRef,
        filePath: absolutePath,
        httpBaseUrl: environmentHttpBaseUrl,
        createAssetUrl,
        openPreview,
      });
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
        return;
      }
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open file in browser",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    })();
  }, [absolutePath, createAssetUrl, environmentHttpBaseUrl, openPreview, threadRef]);
  const retryMdxPreview = useCallback(() => {
    file.refresh();
    mdxDocument.refresh();
  }, [file.refresh, mdxDocument.refresh]);

  let mdxPreviewNotice: MdxPreviewNotice | null = null;
  if (renderMdx && !mdxDocumentReady) {
    if (currentFilePending) {
      mdxPreviewNotice = {
        kind: "status",
        message: "Saving the latest source before rendering MDX.",
        retry: false,
      };
    } else if (!supportsSafeMdx) {
      mdxPreviewNotice = {
        kind: "error",
        message: "This server does not support safe MDX rendering.",
        retry: false,
      };
    } else if (file.data?.truncated === true) {
      mdxPreviewNotice = {
        kind: "error",
        message: "MDX files larger than 1 MB cannot be rendered.",
        retry: false,
      };
    } else if (mdxDocument.error !== null) {
      mdxPreviewNotice = {
        kind: "error",
        message: mdxDocument.error,
        retry: true,
      };
    } else if (mdxDocument.isPending || mdxDocument.data === null) {
      mdxPreviewNotice = {
        kind: "status",
        message: "Rendering MDX from the saved source.",
        retry: false,
      };
    } else {
      mdxPreviewNotice = {
        kind: "error",
        message: "The rendered MDX does not match the visible source.",
        retry: true,
      };
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
                  key={crumb.path || "project"}
                  className="flex min-w-0 shrink-0 items-center"
                  data-current-file-crumb={crumb.kind === "file"}
                >
                  {index > 0 ? (
                    <ChevronRight className="mx-1 size-3.5 shrink-0 text-muted-foreground/60" />
                  ) : null}
                  <span
                    className={cn(
                      "max-w-40 truncate",
                      crumb.kind === "file"
                        ? "font-medium text-foreground"
                        : "text-muted-foreground",
                    )}
                    title={crumb.path || projectName}
                  >
                    {crumb.label}
                  </span>
                </div>
              ))}
            </div>
          </ScrollArea>
          {absolutePath && environmentId === primaryEnvironmentId ? (
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
                    className={cn("shrink-0", mdxToggleDisabled && "opacity-50")}
                    pressed={renderRequested}
                    aria-disabled={mdxToggleDisabled}
                    onPressedChange={(pressed) => {
                      if (mdxToggleDisabled) return;
                      setRenderedView({
                        path: pressed ? relativePath : null,
                        revealRequestId: pressed ? revealRequestId : null,
                      });
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
                  aria-label={explorerOpen ? "Hide file explorer" : "Show file explorer"}
                  variant="ghost"
                  size="sm"
                >
                  <FolderTree className="size-3.5" />
                </Toggle>
              }
            />
            <TooltipPopup>
              {explorerOpen ? "Hide file explorer" : "Show file explorer"}
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
            "min-w-0 flex-1 flex-col overflow-hidden",
            relativePath ? "flex" : "hidden",
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
                    overflow: wordWrap ? "wrap" : "scroll",
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
                      "flex shrink-0 items-center justify-between gap-3 border-b px-3 py-2 text-xs",
                      mdxPreviewNotice.kind === "error"
                        ? "border-destructive/25 bg-destructive/8 text-destructive"
                        : "border-border/60 bg-muted/25 text-muted-foreground",
                    )}
                    role={mdxPreviewNotice.kind === "error" ? "alert" : "status"}
                    aria-live={mdxPreviewNotice.kind === "error" ? "assertive" : "polite"}
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
              "flex min-h-0 shrink-0 bg-background",
              relativePath
                ? "w-[min(22rem,46%)] min-w-64 border-l border-border/60"
                : "min-w-0 flex-1",
            )}
          >
            <FileBrowserPanel
              key={`${environmentId}:${cwd}`}
              environmentId={environmentId}
              cwd={cwd}
              projectName={projectName}
              onOpenFile={onOpenFile}
            />
          </aside>
        ) : null}
      </div>
    </div>
  );
}
