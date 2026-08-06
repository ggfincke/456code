// apps/web/src/components/DiffPanel.tsx
// renders thread and checkpoint diffs with review controls
import { useAtomValue } from '@effect/atom-react'
import { useParams } from '@tanstack/react-router'
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from '@t3tools/client-runtime/state/runtime'
import { safeErrorLogAttributes } from '@t3tools/client-runtime/errors'
import type { ScopedThreadRef, TurnId } from '@t3tools/contracts'
import { ArrowRightIcon, CheckIcon, ChevronDownIcon, SearchIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useOpenInPreferredEditor } from '../lib/editorPreferences'
import { type DraftId } from '../composerDraftStore'
import { openDiffFilePrimaryAction } from '../lib/diffFileActions'
import { useCheckpointDiff } from '~/lib/checkpointDiffState'
import { selectThreadDiffPanelSelection, useDiffPanelStore } from '../diffPanelStore'
import { useTheme } from '../hooks/useTheme'
import { useTurnDiffSummaries } from '../hooks/useTurnDiffSummaries'
import { useProject, useThread } from '../state/entities'
import { resolveThreadRouteRef } from '../threadRoutes'
import { useClientSettings } from '../hooks/useSettings'
import { formatShortTimestamp } from '../timestampFormat'
import { DiffPanelShell, type DiffPanelMode } from './DiffPanelShell'
import {
  NativeDiffSurface,
  NativeDiffSurfaceControls,
  type NativeDiffRenderMode,
  useNativeDiffSurfaceController,
} from './diffs/NativeDiffSurface'
import { Switch } from './ui/switch'
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from './ui/combobox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from './ui/menu'
import { useEnvironmentQuery } from '../state/query'
import { serverEnvironment } from '../state/server'
import { reviewEnvironment } from '../state/review'
import { vcsEnvironment } from '../state/vcs'
import { buildBaseRefChoices, filterBaseRefChoices } from '../lib/baseRefChoices'

const AUTOMATIC_BASE_REF = '__automatic_base_ref__'

interface DiffPanelProps
{
  mode?: DiffPanelMode
  composerDraftTarget: ScopedThreadRef | DraftId
  initialGitScope: 'branch' | 'unstaged'
}

export { DiffWorkerPoolProvider } from './DiffWorkerPoolProvider'

export default function DiffPanel({
  mode = 'inline',
  composerDraftTarget,
  initialGitScope: initialGitScopeProp,
}: DiffPanelProps)
{
  const { resolvedTheme } = useTheme()
  const settings = useClientSettings()
  const [initialGitScope] = useState(initialGitScopeProp)
  const [diffRenderMode, setDiffRenderMode] = useState<NativeDiffRenderMode>('stacked')
  const [wordWrap, setWordWrap] = useState(settings.wordWrap)
  const [diffIgnoreWhitespace, setDiffIgnoreWhitespace] = useState(settings.diffIgnoreWhitespace)
  const [baseRefQuery, setBaseRefQuery] = useState('')

  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  })
  const activeThreadId = routeThreadRef?.threadId ?? null
  const activeThread = useThread(routeThreadRef)
  const activeProjectId = activeThread?.projectId ?? null
  const activeProject = useProject(
    activeThread && activeProjectId
      ? {
          environmentId: activeThread.environmentId,
          projectId: activeProjectId,
        }
      : null,
  )
  const activeCwd = activeThread?.worktreePath ?? activeProject?.workspaceRoot
  const serverConfig = useAtomValue(
    serverEnvironment.configValueAtom(activeThread?.environmentId ?? null),
  )
  const openInPreferredEditor = useOpenInPreferredEditor(
    activeThread?.environmentId ?? null,
    serverConfig?.availableEditors ?? [],
  )
  const gitStatusQuery = useEnvironmentQuery(
    activeThread !== null && activeThread !== undefined && activeCwd != null
      ? vcsEnvironment.status({
          environmentId: activeThread.environmentId,
          input: { cwd: activeCwd },
        })
      : null,
  )
  const diffSelection = useDiffPanelStore((state) =>
    selectThreadDiffPanelSelection(
      state.byThreadKey,
      routeThreadRef,
      initialGitScope === 'unstaged',
    ),
  )
  const isGitRepo = gitStatusQuery.data?.isRepo ?? true
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread)
  const orderedTurnDiffSummaries = useMemo(
    () =>
      [...turnDiffSummaries].toSorted((left, right) =>
      {
        const leftTurnCount =
          left.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[left.turnId] ?? 0
        const rightTurnCount =
          right.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[right.turnId] ?? 0
        if (leftTurnCount !== rightTurnCount)
        {
          return rightTurnCount - leftTurnCount
        }
        return right.completedAt.localeCompare(left.completedAt)
      }),
    [inferredCheckpointTurnCountByTurnId, turnDiffSummaries],
  )

  useEffect(() =>
  {
    if (!routeThreadRef || diffSelection.kind !== 'turn') return
    const availableTurnIds = orderedTurnDiffSummaries.map((summary) => summary.turnId)
    if (!availableTurnIds.includes(diffSelection.turnId))
    {
      const latestTurnId = availableTurnIds[0]
      if (latestTurnId)
      {
        useDiffPanelStore.getState().selectTurn(routeThreadRef, latestTurnId)
      }
      return
    }
    useDiffPanelStore.getState().reconcileTurnSelection(routeThreadRef, availableTurnIds)
  }, [diffSelection, orderedTurnDiffSummaries, routeThreadRef])

  const selectedTurnId = diffSelection.kind === 'turn' ? diffSelection.turnId : null
  const selectedGitScope = diffSelection.kind === 'unstaged' ? 'unstaged' : 'branch'
  const selectedBaseRef = diffSelection.kind === 'branch' ? diffSelection.baseRef : null
  const exactSelectedTurn =
    selectedTurnId === null
      ? undefined
      : orderedTurnDiffSummaries.find((summary) => summary.turnId === selectedTurnId)
  const selectedTurn =
    selectedTurnId === null ? undefined : (exactSelectedTurn ?? orderedTurnDiffSummaries[0])
  const selectedFilePath =
    diffSelection.kind === 'turn' && exactSelectedTurn ? diffSelection.filePath : null
  const selectedFileRevealRequestId =
    diffSelection.kind === 'turn' && exactSelectedTurn ? diffSelection.revealRequestId : 0
  const selectedCheckpointTurnCount =
    selectedTurn &&
    (selectedTurn.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[selectedTurn.turnId])
  const latestTurn = orderedTurnDiffSummaries[0]
  const selectedScopeLabel =
    selectedTurnId === null
      ? selectedGitScope === 'unstaged'
        ? 'Working tree'
        : 'Branch changes'
      : selectedTurn?.turnId === latestTurn?.turnId
        ? 'Latest turn'
        : `Turn ${selectedCheckpointTurnCount ?? '?'}`
  const reviewSectionId = selectedTurn ? `turn:${selectedTurn.turnId}` : selectedGitScope
  const collapseScopeKey = routeThreadRef
    ? `${routeThreadRef.environmentId}:${routeThreadRef.threadId}:${reviewSectionId}`
    : reviewSectionId
  const reviewSectionTitle = selectedTurn
    ? `Turn ${selectedCheckpointTurnCount ?? '?'}`
    : selectedGitScope === 'unstaged'
      ? 'Working tree'
      : 'Branch changes'
  const selectedCheckpointRange = useMemo(
    () =>
      typeof selectedCheckpointTurnCount === 'number'
        ? {
            fromTurnCount: Math.max(0, selectedCheckpointTurnCount - 1),
            toTurnCount: selectedCheckpointTurnCount,
          }
        : null,
    [selectedCheckpointTurnCount],
  )
  const activeCheckpointDiff = useCheckpointDiff(
    {
      environmentId: activeThread?.environmentId ?? null,
      threadId: activeThreadId,
      fromTurnCount: selectedCheckpointRange?.fromTurnCount ?? null,
      toTurnCount: selectedCheckpointRange?.toTurnCount ?? null,
      ignoreWhitespace: diffIgnoreWhitespace,
      cacheScope: selectedTurn ? `turn:${selectedTurn.turnId}` : null,
    },
    { enabled: isGitRepo && selectedTurn !== undefined },
  )
  const primaryBranchDiffPreview = useEnvironmentQuery(
    selectedTurnId === null && activeThread && activeCwd
      ? reviewEnvironment.diffPreview({
          environmentId: activeThread.environmentId,
          input: {
            cwd: activeCwd,
            ...(selectedBaseRef ? { baseRef: selectedBaseRef } : {}),
            ignoreWhitespace: diffIgnoreWhitespace,
          },
        })
      : null,
  )
  const shouldRetryBranchDiffAtEnvironmentCwd =
    selectedTurnId === null &&
    primaryBranchDiffPreview.error?.includes('configured workspace root') === true &&
    serverConfig?.cwd !== undefined &&
    serverConfig.cwd !== activeCwd
  const fallbackBranchDiffPreview = useEnvironmentQuery(
    shouldRetryBranchDiffAtEnvironmentCwd && activeThread && serverConfig
      ? reviewEnvironment.diffPreview({
          environmentId: activeThread.environmentId,
          input: {
            cwd: serverConfig.cwd,
            ...(selectedBaseRef ? { baseRef: selectedBaseRef } : {}),
            ignoreWhitespace: diffIgnoreWhitespace,
          },
        })
      : null,
  )
  const branchDiffPreview = shouldRetryBranchDiffAtEnvironmentCwd
    ? fallbackBranchDiffPreview
    : primaryBranchDiffPreview
  const selectedGitSource = branchDiffPreview.data?.sources.find(
    (source) => source.kind === (selectedGitScope === 'unstaged' ? 'working-tree' : 'branch-range'),
  )
  const localBranchRefs = useEnvironmentQuery(
    selectedTurnId === null &&
      selectedGitScope === 'branch' &&
      activeThread &&
      branchDiffPreview.data?.cwd
      ? vcsEnvironment.listRefs({
          environmentId: activeThread.environmentId,
          input: {
            cwd: branchDiffPreview.data.cwd,
            includeMatchingRemoteRefs: true,
            refKind: 'local',
            ...(baseRefQuery.trim().length > 0 ? { query: baseRefQuery.trim() } : {}),
            limit: 100,
          },
        })
      : null,
  )
  const remoteBranchRefs = useEnvironmentQuery(
    selectedTurnId === null &&
      selectedGitScope === 'branch' &&
      activeThread &&
      branchDiffPreview.data?.cwd
      ? vcsEnvironment.listRefs({
          environmentId: activeThread.environmentId,
          input: {
            cwd: branchDiffPreview.data.cwd,
            includeMatchingRemoteRefs: true,
            refKind: 'remote',
            ...(baseRefQuery.trim().length > 0 ? { query: baseRefQuery.trim() } : {}),
            limit: 100,
          },
        })
      : null,
  )
  const baseRefChoices = buildBaseRefChoices(
    localBranchRefs.data?.refs.filter((ref) => ref.name !== selectedGitSource?.headRef) ?? [],
    remoteBranchRefs.data?.refs ?? [],
  )
  const matchingBaseRefChoices = filterBaseRefChoices(baseRefChoices, baseRefQuery)
  const valueForBaseRefChoice = (choice: (typeof baseRefChoices)[number]) =>
    selectedBaseRef && selectedBaseRef === choice.remote?.name
      ? selectedBaseRef
      : (choice.local?.name ?? choice.remote?.name ?? choice.id)
  const baseRefItems = [AUTOMATIC_BASE_REF, ...baseRefChoices.map(valueForBaseRefChoice)]
  const filteredBaseRefItems = [
    ...(baseRefQuery.trim().length === 0 ? [AUTOMATIC_BASE_REF] : []),
    ...matchingBaseRefChoices.map(valueForBaseRefChoice),
  ]
  const gitDiff = selectedGitSource?.diff

  const selectedPatch = selectedTurn ? activeCheckpointDiff.data?.diff : gitDiff
  const isSelectedPatchTruncated = !selectedTurn && selectedGitSource?.truncated === true
  const isLoadingSelectedPatch = selectedTurn
    ? activeCheckpointDiff.isPending
    : branchDiffPreview.isPending
  const selectedPatchError = selectedTurn ? activeCheckpointDiff.error : branchDiffPreview.error
  const diffSurface = useNativeDiffSurfaceController({
    source: {
      patch: selectedPatch,
      cacheScope: `diff-panel:${resolvedTheme}`,
      compactPartialHunkOffsets: selectedTurnId === null,
    },
    collapseScopeKey,
    selectedFilePath,
    selectedFileRevealRequestId,
  })

  const openDiffFile = useCallback(
    (filePath: string) =>
    {
      openDiffFilePrimaryAction({
        threadRef: routeThreadRef,
        filePath,
        activeCwd,
        openInEditor: (targetPath) =>
        {
          void (async () =>
          {
            const result = await openInPreferredEditor(targetPath)
            if (result._tag === 'Failure' && !isAtomCommandInterrupted(result))
            {
              console.warn('Failed to open diff file in editor.', {
                operation: 'open-diff-file',
                ...(routeThreadRef
                  ? {
                      environmentId: routeThreadRef.environmentId,
                      threadId: routeThreadRef.threadId,
                    }
                  : {}),
                ...safeErrorLogAttributes(squashAtomCommandFailure(result)),
              })
            }
          })()
        },
      })
    },
    [activeCwd, openInPreferredEditor, routeThreadRef],
  )
  const selectTurn = (turnId: TurnId) =>
  {
    if (!routeThreadRef) return
    useDiffPanelStore.getState().selectTurn(routeThreadRef, turnId)
  }
  const selectGitScope = (scope: 'branch' | 'unstaged') =>
  {
    if (!routeThreadRef) return
    useDiffPanelStore.getState().selectGitScope(routeThreadRef, scope)
  }
  const selectBranchBaseRef = (baseRef: string | null) =>
  {
    if (!routeThreadRef) return
    useDiffPanelStore.getState().selectBranchBaseRef(routeThreadRef, baseRef)
  }

  const headerRow = (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-3 [-webkit-app-region:no-drag]">
        <DropdownMenu>
          <DropdownMenuTrigger
            className="inline-flex h-6 max-w-full items-center gap-1 rounded-md bg-muted/70 px-2 text-xs font-medium text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`Diff scope: ${selectedScopeLabel}`}
          >
            <span className="truncate">{selectedScopeLabel}</span>
            <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-60">
            <DropdownMenuItem
              className={
                selectedTurnId === null && selectedGitScope === 'unstaged'
                  ? 'bg-foreground/[0.08]'
                  : undefined
              }
              onClick={() => selectGitScope('unstaged')}
            >
              <span>Working tree</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              className={
                selectedTurnId === null && selectedGitScope === 'branch'
                  ? 'bg-foreground/[0.08]'
                  : undefined
              }
              onClick={() => selectGitScope('branch')}
            >
              <span>Branch changes</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              className={
                selectedTurnId !== null && selectedTurn?.turnId === latestTurn?.turnId
                  ? 'bg-foreground/[0.08]'
                  : undefined
              }
              onClick={() =>
              {
                if (latestTurn) selectTurn(latestTurn.turnId)
              }}
            >
              <span>Latest turn</span>
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Turn</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-64">
                {orderedTurnDiffSummaries.map((summary) =>
                {
                  const turnCount =
                    summary.checkpointTurnCount ??
                    inferredCheckpointTurnCountByTurnId[summary.turnId] ??
                    '?'
                  return (
                    <DropdownMenuItem
                      key={summary.turnId}
                      className={
                        summary.turnId === selectedTurn?.turnId ? 'bg-foreground/[0.08]' : undefined
                      }
                      onClick={() => selectTurn(summary.turnId)}
                    >
                      <span>Turn {turnCount}</span>
                      <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                        {formatShortTimestamp(summary.completedAt, settings.timestampFormat)}
                      </span>
                    </DropdownMenuItem>
                  )
                })}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
        {selectedTurnId === null && selectedGitScope === 'branch' && selectedGitSource?.baseRef && (
          <div
            className="flex min-w-0 max-w-full items-center gap-2 overflow-hidden text-xs text-muted-foreground"
            title={`${selectedGitSource.headRef ?? 'HEAD'} → ${selectedGitSource.baseRef}`}
            aria-label={`Comparing ${selectedGitSource.headRef ?? 'HEAD'} against ${selectedGitSource.baseRef}`}
          >
            <span className="min-w-0 max-w-48 truncate">{selectedGitSource.headRef ?? 'HEAD'}</span>
            <ArrowRightIcon className="size-3.5 shrink-0 opacity-70" />
            <Combobox
              items={baseRefItems}
              filteredItems={filteredBaseRefItems}
              value={selectedBaseRef ?? AUTOMATIC_BASE_REF}
              onOpenChange={(open) =>
              {
                if (!open) setBaseRefQuery('')
              }}
              onValueChange={(value) =>
              {
                if (!value) return
                selectBranchBaseRef(value === AUTOMATIC_BASE_REF ? null : value)
              }}
            >
              <ComboboxTrigger
                className="inline-flex min-w-0 max-w-48 items-center gap-1 overflow-hidden rounded-md px-1.5 py-1 outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Change comparison target. Currently ${selectedGitSource.baseRef}`}
              >
                <span className="min-w-0 truncate">{selectedGitSource.baseRef}</span>
                <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
              </ComboboxTrigger>
              <ComboboxPopup
                align="start"
                className="w-72 min-w-0 max-w-[calc(100vw-1rem)] overflow-hidden [&>[data-slot=combobox-popup]]:min-w-0 [&>[data-slot=combobox-popup]]:overflow-hidden"
              >
                <div className="min-w-0 shrink-0 px-3 pt-2.5">
                  <div className="relative -translate-y-px border-b border-border/70 pb-1.5 transition-colors focus-within:border-ring">
                    <SearchIcon
                      aria-hidden="true"
                      className="pointer-events-none absolute top-1.5 left-0 size-4 shrink-0 text-muted-foreground/55"
                    />
                    <ComboboxInput
                      className="[&_input]:h-6.5 [&_input]:ps-5 [&_input]:font-sans [&_input]:leading-6.5"
                      inputClassName="rounded-none bg-transparent text-sm"
                      placeholder="Search refs..."
                      showTrigger={false}
                      size="sm"
                      unstyled
                      value={baseRefQuery}
                      onChange={(event) => setBaseRefQuery(event.target.value)}
                    />
                  </div>
                </div>
                <div className="grid shrink-0 grid-cols-[1rem_minmax(0,1fr)] items-center gap-2 border-b border-border/70 ps-3 pe-6.5 pt-2 pb-1.5 font-medium text-[10px] text-muted-foreground uppercase tracking-wide">
                  <span aria-hidden="true" />
                  <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_2rem] items-center">
                    <span>Branch</span>
                    <span className="text-right">Remote</span>
                  </div>
                </div>
                <ComboboxEmpty>No matching refs.</ComboboxEmpty>
                <ComboboxList className="max-h-64 min-w-0 overflow-x-hidden">
                  <ComboboxItem
                    className="h-8 w-full min-w-0 grid-cols-[1rem_minmax(0,1fr)] py-0"
                    contentClassName="w-full min-w-0 overflow-hidden"
                    value={AUTOMATIC_BASE_REF}
                  >
                    <span className="block min-w-0 truncate">Automatic</span>
                  </ComboboxItem>
                  {baseRefChoices.map((choice) =>
                  {
                    const item = valueForBaseRefChoice(choice)
                    const hasBoth = choice.local !== null && choice.remote !== null
                    const useRemote = choice.remote?.name === item
                    return (
                      <ComboboxItem
                        key={choice.id}
                        className="h-8 w-full min-w-0 grid-cols-[1rem_minmax(0,1fr)] py-0"
                        contentClassName="w-full min-w-0 overflow-hidden"
                        value={item}
                      >
                        <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_2rem] items-center overflow-hidden">
                          <span className="block min-w-0 truncate pe-2">{choice.label}</span>
                          {hasBoth ? (
                            <div
                              className="flex justify-end"
                              onClick={(event) => event.stopPropagation()}
                              onPointerDown={(event) => event.stopPropagation()}
                            >
                              <Switch
                                aria-label={`Use remote version of ${choice.label}`}
                                checked={useRemote}
                                className="[--thumb-size:--spacing(3)]"
                                onCheckedChange={(checked) =>
                                  {
                                  const nextRef = checked ? choice.remote?.name : choice.local?.name
                                  if (nextRef) selectBranchBaseRef(nextRef)
                                }}
                              />
                            </div>
                          ) : choice.remote ? (
                            <span
                              className="flex justify-end text-muted-foreground"
                              title="Remote only"
                            >
                              <CheckIcon aria-hidden="true" className="size-3" />
                            </span>
                          ) : null}
                        </div>
                      </ComboboxItem>
                    )
                  })}
                </ComboboxList>
              </ComboboxPopup>
            </Combobox>
          </div>
        )}
      </div>
      <NativeDiffSurfaceControls
        controller={diffSurface}
        renderMode={diffRenderMode}
        onRenderModeChange={setDiffRenderMode}
        wordWrap={wordWrap}
        onWordWrapChange={setWordWrap}
        ignoreWhitespace={diffIgnoreWhitespace}
        onIgnoreWhitespaceChange={setDiffIgnoreWhitespace}
      />
    </>
  )

  return (
    <DiffPanelShell mode={mode} header={headerRow}>
      {!activeThread ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Select a thread to inspect turn diffs.
        </div>
      ) : !isGitRepo ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Turn diffs are unavailable because this project is not a git repository.
        </div>
      ) : selectedTurnId !== null && orderedTurnDiffSummaries.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          No completed turns yet.
        </div>
      ) : (
        <NativeDiffSurface
          controller={diffSurface}
          collapseScopeKey={collapseScopeKey}
          sectionId={reviewSectionId}
          sectionTitle={reviewSectionTitle}
          composerDraftTarget={composerDraftTarget}
          resolvedTheme={resolvedTheme}
          renderMode={diffRenderMode}
          wordWrap={wordWrap}
          loading={isLoadingSelectedPatch}
          loadingLabel={
            selectedTurn
              ? 'Loading checkpoint diff...'
              : selectedGitScope === 'unstaged'
                ? 'Loading working tree diff...'
                : 'Loading branch diff...'
          }
          error={selectedPatchError}
          emptyMessage={
            diffSurface.hasNoNetChanges
              ? 'No net changes in this selection.'
              : 'No patch available for this selection.'
          }
          truncated={isSelectedPatchTruncated}
          onOpenFile={openDiffFile}
        />
      )}
    </DiffPanelShell>
  )
}
