// apps/web/src/components/diffs/NativeDiffSurface.tsx
// renders unified diffs through the shared native review surface
import type { FileDiffMetadata } from "@pierre/diffs";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  Columns2Icon,
  PilcrowIcon,
  Rows3Icon,
  TextWrapIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { type DraftId } from "~/composerDraftStore";
import { areAllDiffFilesCollapsed, toggleAllDiffFiles } from "~/lib/diffCollapse";
import {
  buildFileDiffRenderKey,
  getDiffCollapseIconClassName,
  getDiffLineStat,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
  type DiffLineStat,
  type RenderablePatch,
} from "~/lib/diffRendering";
import { cn } from "~/lib/utils";

import { DiffPanelLoadingState } from "../DiffPanelShell";
import { DiffStatLabel } from "../chat/DiffStatLabel";
import { Button } from "../ui/button";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AnnotatableCodeView, type AnnotatableCodeViewHandle } from "./AnnotatableCodeView";

export type NativeDiffRenderMode = "stacked" | "split";
type NativeDiffThemeType = "light" | "dark";

export interface NativeDiffSource {
  readonly patch: string | undefined;
  readonly cacheScope: string;
  readonly compactPartialHunkOffsets?: boolean;
}

interface CollapsedDiffFilesState {
  readonly scopeKey: string | null;
  readonly fileKeys: ReadonlySet<string>;
}

interface NativeDiffFile {
  readonly fileDiff: FileDiffMetadata;
  readonly filePath: string;
  readonly fileKey: string;
  readonly collapsed: boolean;
}

export interface NativeDiffSurfaceController {
  readonly renderablePatch: RenderablePatch | null;
  readonly files: ReadonlyArray<NativeDiffFile>;
  readonly lineStat: DiffLineStat;
  readonly hasResolvedPatch: boolean;
  readonly hasNoNetChanges: boolean;
  readonly allFilesCollapsed: boolean;
  readonly viewerRef: React.RefObject<AnnotatableCodeViewHandle | null>;
  readonly toggleAllFiles: () => void;
  readonly toggleFile: (fileKey: string) => void;
}

const EMPTY_COLLAPSED_DIFF_FILE_KEYS: ReadonlySet<string> = new Set();

const NATIVE_DIFF_UNSAFE_CSS = `
[data-diffs-header],
[data-diff],
[data-file],
[data-error-wrapper],
[data-virtualizer-buffer] {
  --diffs-header-font-family: var(--font-sans) !important;
  --diffs-font-family: var(--font-mono) !important;
  --diffs-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-light-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-dark-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-token-light-bg: transparent;
  --diffs-token-dark-bg: transparent;

  --diffs-bg-context-override: color-mix(in srgb, var(--background) 97%, var(--foreground));
  --diffs-bg-hover-override: color-mix(in srgb, var(--background) 94%, var(--foreground));
  --diffs-bg-separator-override: color-mix(in srgb, var(--background) 95%, var(--foreground));
  --diffs-bg-buffer-override: color-mix(in srgb, var(--background) 90%, var(--foreground));

  --diffs-bg-addition-override: color-mix(in srgb, var(--background) 92%, var(--success));
  --diffs-bg-addition-number-override: color-mix(in srgb, var(--background) 88%, var(--success));
  --diffs-bg-addition-hover-override: color-mix(in srgb, var(--background) 85%, var(--success));
  --diffs-bg-addition-emphasis-override: color-mix(in srgb, var(--background) 80%, var(--success));

  --diffs-bg-deletion-override: color-mix(in srgb, var(--background) 92%, var(--destructive));
  --diffs-bg-deletion-number-override: color-mix(in srgb, var(--background) 88%, var(--destructive));
  --diffs-bg-deletion-hover-override: color-mix(in srgb, var(--background) 85%, var(--destructive));
  --diffs-bg-deletion-emphasis-override: color-mix(
    in srgb,
    var(--background) 80%,
    var(--destructive)
  );

  background-color: var(--diffs-bg) !important;
}

[data-file-info] {
  background-color: color-mix(in srgb, var(--card) 94%, var(--foreground)) !important;
  border-block-color: var(--border) !important;
  color: var(--foreground) !important;
}

[data-diffs-header] {
  position: sticky !important;
  top: 0;
  z-index: 4;
  background-color: color-mix(in srgb, var(--card) 94%, var(--foreground)) !important;
  border-bottom: 1px solid var(--border) !important;
  align-items: center !important;
  font-family: var(--font-sans) !important;
  font-size: 12px !important;
  line-height: 1 !important;
  min-height: 32px !important;
  padding-block: 6px !important;
}

[data-diffs-header] [data-header-content] {
  align-items: center !important;
  line-height: 1 !important;
}

[data-diffs-header] [data-metadata] {
  align-items: center !important;
  line-height: 1 !important;
  font-variant-numeric: tabular-nums;
}

[data-diffs-header] [data-additions-count],
[data-diffs-header] [data-deletions-count] {
  font-family: var(--font-mono) !important;
  font-size: 11px !important;
  font-variant-numeric: tabular-nums;
  line-height: 1 !important;
}

[data-diffs-header] [data-change-icon],
[data-diffs-header] [data-rename-icon] {
  display: block;
  flex-shrink: 0;
}

[data-title] {
  cursor: pointer;
  transition:
    color 120ms ease,
    text-decoration-color 120ms ease;
  text-decoration: underline;
  text-decoration-color: transparent;
  text-underline-offset: 2px;
  font-family: var(--font-sans) !important;
}

[data-title]:hover {
  color: color-mix(in srgb, var(--foreground) 84%, var(--primary)) !important;
  text-decoration-color: currentColor;
}
`;

export function useNativeDiffSurfaceController(input: {
  readonly source: NativeDiffSource;
  readonly collapseScopeKey: string;
  readonly selectedFilePath?: string | null;
  readonly selectedFileRevealRequestId?: number;
}): NativeDiffSurfaceController {
  const {
    source,
    collapseScopeKey,
    selectedFilePath = null,
    selectedFileRevealRequestId = 0,
  } = input;
  const [collapsedDiffFiles, setCollapsedDiffFiles] = useState<CollapsedDiffFilesState>(() => ({
    scopeKey: null,
    fileKeys: EMPTY_COLLAPSED_DIFF_FILE_KEYS,
  }));
  const viewerRef = useRef<AnnotatableCodeViewHandle>(null);
  const collapsedFileKeys =
    collapsedDiffFiles.scopeKey === collapseScopeKey
      ? collapsedDiffFiles.fileKeys
      : EMPTY_COLLAPSED_DIFF_FILE_KEYS;
  const renderablePatch = useMemo(
    () =>
      getRenderablePatch(
        source.patch,
        source.cacheScope,
        source.compactPartialHunkOffsets === undefined
          ? {}
          : { compactPartialHunkOffsets: source.compactPartialHunkOffsets },
      ),
    [source.cacheScope, source.compactPartialHunkOffsets, source.patch],
  );
  const renderableFiles = useMemo(() => {
    if (!renderablePatch || renderablePatch.kind !== "files") {
      return [];
    }
    return renderablePatch.files.toSorted((left, right) =>
      resolveFileDiffPath(left).localeCompare(resolveFileDiffPath(right), undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );
  }, [renderablePatch]);
  const files = useMemo(
    () =>
      renderableFiles.map((fileDiff) => {
        const fileKey = buildFileDiffRenderKey(fileDiff);
        return {
          fileDiff,
          filePath: resolveFileDiffPath(fileDiff),
          fileKey,
          collapsed: collapsedFileKeys.has(fileKey),
        };
      }),
    [collapsedFileKeys, renderableFiles],
  );
  const fileKeys = useMemo(() => files.map((file) => file.fileKey), [files]);
  const lineStat = useMemo(() => getDiffLineStat(renderableFiles), [renderableFiles]);
  const hasResolvedPatch = typeof source.patch === "string";
  const hasNoNetChanges = hasResolvedPatch && source.patch.trim().length === 0;
  const allFilesCollapsed = areAllDiffFilesCollapsed(fileKeys, collapsedFileKeys);

  useEffect(() => {
    if (!selectedFilePath) return;
    const file = files.find((candidate) => candidate.filePath === selectedFilePath);
    if (!file) return;
    viewerRef.current?.scrollTo({ type: "item", id: file.fileKey, align: "start" });
  }, [files, selectedFilePath, selectedFileRevealRequestId]);

  const toggleFile = useCallback(
    (fileKey: string) => {
      setCollapsedDiffFiles((current) => {
        const next = new Set(current.scopeKey === collapseScopeKey ? current.fileKeys : []);
        if (next.has(fileKey)) {
          next.delete(fileKey);
        } else {
          next.add(fileKey);
        }
        return { scopeKey: collapseScopeKey, fileKeys: next };
      });
    },
    [collapseScopeKey],
  );

  const toggleAllFiles = useCallback(() => {
    setCollapsedDiffFiles((current) => {
      const currentKeys =
        current.scopeKey === collapseScopeKey ? current.fileKeys : EMPTY_COLLAPSED_DIFF_FILE_KEYS;
      return {
        scopeKey: collapseScopeKey,
        fileKeys: toggleAllDiffFiles(fileKeys, currentKeys),
      };
    });
  }, [collapseScopeKey, fileKeys]);

  return {
    renderablePatch,
    files,
    lineStat,
    hasResolvedPatch,
    hasNoNetChanges,
    allFilesCollapsed,
    viewerRef,
    toggleAllFiles,
    toggleFile,
  };
}

export function NativeDiffSurfaceControls(props: {
  readonly controller: NativeDiffSurfaceController;
  readonly renderMode: NativeDiffRenderMode;
  readonly onRenderModeChange: (mode: NativeDiffRenderMode) => void;
  readonly wordWrap: boolean;
  readonly onWordWrapChange: (wordWrap: boolean) => void;
  readonly ignoreWhitespace?: boolean;
  readonly onIgnoreWhitespaceChange?: (ignoreWhitespace: boolean) => void;
}) {
  const {
    controller,
    renderMode,
    onRenderModeChange,
    wordWrap,
    onWordWrapChange,
    ignoreWhitespace,
    onIgnoreWhitespaceChange,
  } = props;
  const hasFiles = controller.files.length > 0;

  return (
    <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
      {hasFiles && (
        <DiffStatLabel
          additions={controller.lineStat.additions}
          deletions={controller.lineStat.deletions}
          className="mr-1 text-[11px]"
          layout="inline"
        />
      )}
      {hasFiles && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-xs"
                variant="outline"
                aria-label={
                  controller.allFilesCollapsed ? "Expand all files" : "Collapse all files"
                }
                onClick={controller.toggleAllFiles}
              />
            }
          >
            {controller.allFilesCollapsed ? (
              <ChevronsUpDownIcon className="size-3" />
            ) : (
              <ChevronsDownUpIcon className="size-3" />
            )}
          </TooltipTrigger>
          <TooltipPopup side="top">
            {controller.allFilesCollapsed ? "Expand all files" : "Collapse all files"}
          </TooltipPopup>
        </Tooltip>
      )}
      <ToggleGroup
        className="shrink-0"
        variant="outline"
        size="xs"
        value={[renderMode]}
        onValueChange={(value) => {
          const next = value[0];
          if (next === "stacked" || next === "split") {
            onRenderModeChange(next);
          }
        }}
      >
        <Toggle aria-label="Stacked diff view" value="stacked">
          <Rows3Icon className="size-3" />
        </Toggle>
        <Toggle aria-label="Split diff view" value="split">
          <Columns2Icon className="size-3" />
        </Toggle>
      </ToggleGroup>
      <Tooltip>
        <TooltipTrigger
          render={
            <Toggle
              aria-label={wordWrap ? "Disable diff line wrapping" : "Enable diff line wrapping"}
              variant="outline"
              size="xs"
              pressed={wordWrap}
              onPressedChange={(pressed) => {
                onWordWrapChange(Boolean(pressed));
              }}
            />
          }
        >
          <TextWrapIcon className="size-3" />
        </TooltipTrigger>
        <TooltipPopup side="top">
          {wordWrap ? "Disable line wrapping" : "Enable line wrapping"}
        </TooltipPopup>
      </Tooltip>
      {onIgnoreWhitespaceChange && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                aria-label={
                  ignoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"
                }
                variant="outline"
                size="xs"
                pressed={ignoreWhitespace === true}
                onPressedChange={(pressed) => {
                  onIgnoreWhitespaceChange(Boolean(pressed));
                }}
              />
            }
          >
            <PilcrowIcon className="size-3" />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {ignoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"}
          </TooltipPopup>
        </Tooltip>
      )}
    </div>
  );
}

function openFileFromDiffTitle(
  event: ReactMouseEvent<HTMLDivElement>,
  onOpenFile: (filePath: string) => void,
): void {
  const composedPath = event.nativeEvent.composedPath?.() ?? [];
  const title = composedPath.find(
    (node): node is HTMLElement => node instanceof HTMLElement && node.hasAttribute("data-title"),
  );
  const filePath = title?.textContent?.trim();
  if (filePath) onOpenFile(filePath);
}

export function NativeDiffSurface(props: {
  readonly controller: NativeDiffSurfaceController;
  readonly collapseScopeKey: string;
  readonly sectionId: string;
  readonly sectionTitle: string;
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
  readonly resolvedTheme: "light" | "dark";
  readonly renderMode: NativeDiffRenderMode;
  readonly wordWrap: boolean;
  readonly loading: boolean;
  readonly loadingLabel: string;
  readonly error?: string | null;
  readonly emptyMessage: string;
  readonly truncated?: boolean;
  readonly onOpenFile?: (filePath: string) => void;
}) {
  const {
    controller,
    collapseScopeKey,
    sectionId,
    sectionTitle,
    composerDraftTarget,
    resolvedTheme,
    renderMode,
    wordWrap,
    loading,
    loadingLabel,
    error,
    emptyMessage,
    truncated = false,
    onOpenFile,
  } = props;
  const { renderablePatch } = controller;

  return (
    <div
      className="diff-panel-viewport flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      data-native-diff-surface
    >
      {truncated && (
        <p className="shrink-0 border-b border-border/70 bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">
          This diff was truncated because it exceeded the preview limit. The changes shown are
          incomplete.
        </p>
      )}
      {error && !renderablePatch && (
        <div className="px-3">
          <p className="mb-2 text-[11px] text-red-500/80">{error}</p>
        </div>
      )}
      {!renderablePatch ? (
        loading ? (
          <DiffPanelLoadingState label={loadingLabel} />
        ) : (
          <div className="flex h-full items-center justify-center px-3 py-2 text-xs text-muted-foreground/70">
            <p>{emptyMessage}</p>
          </div>
        )
      ) : renderablePatch.kind === "files" ? (
        <div
          className="min-h-0 flex-1"
          {...(onOpenFile
            ? {
                onClickCapture: (event: ReactMouseEvent<HTMLDivElement>) =>
                  openFileFromDiffTitle(event, onOpenFile),
              }
            : {})}
        >
          <AnnotatableCodeView
            viewerRef={controller.viewerRef}
            key={collapseScopeKey}
            className="diff-render-surface h-full min-h-0 overflow-auto"
            files={controller.files}
            sectionId={sectionId}
            sectionTitle={sectionTitle}
            composerDraftTarget={composerDraftTarget}
            renderHeaderPrefix={(fileDiff, fileKey, collapsed) => {
              const filePath = resolveFileDiffPath(fileDiff);
              return (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        className={cn(
                          "inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent p-0 transition-colors hover:bg-foreground/10 focus-visible:outline-hidden",
                          getDiffCollapseIconClassName(fileDiff),
                        )}
                        aria-label={collapsed ? `Expand ${filePath}` : `Collapse ${filePath}`}
                        aria-expanded={!collapsed}
                        onClick={(event) => {
                          event.stopPropagation();
                          controller.toggleFile(fileKey);
                        }}
                      />
                    }
                  >
                    {collapsed ? (
                      <ChevronRightIcon className="size-4" />
                    ) : (
                      <ChevronDownIcon className="size-4" />
                    )}
                  </TooltipTrigger>
                  <TooltipPopup side="top">
                    {collapsed ? "Expand diff" : "Collapse diff"}
                  </TooltipPopup>
                </Tooltip>
              );
            }}
            options={{
              diffStyle: renderMode === "split" ? "split" : "unified",
              lineDiffType: "none",
              overflow: wordWrap ? "wrap" : "scroll",
              theme: resolveDiffThemeName(resolvedTheme),
              themeType: resolvedTheme as NativeDiffThemeType,
              unsafeCSS: NATIVE_DIFF_UNSAFE_CSS,
              stickyHeaders: true,
              itemMetrics: { diffHeaderHeight: 33 },
              layout: { paddingTop: 0, paddingBottom: 8, gap: 8 },
            }}
          />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-2">
          <div className="space-y-2">
            <p className="text-[11px] text-muted-foreground/75">{renderablePatch.reason}</p>
            <pre
              className={cn(
                "max-h-[72vh] rounded-md border border-border/70 bg-background/70 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground/90",
                wordWrap ? "overflow-auto whitespace-pre-wrap wrap-break-word" : "overflow-auto",
              )}
            >
              {renderablePatch.text}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
