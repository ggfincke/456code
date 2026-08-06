// apps/web/src/components/ThreadTerminalDrawer.tsx
// manages thread terminal sessions and theme-aware xterm presentation

import {
  Plus,
  SquareSplitHorizontal,
  SquareSplitVertical,
  TerminalSquare,
  Trash2,
  XIcon,
} from 'lucide-react'
import {
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
  type ThreadId,
} from '@t3tools/contracts'
import { getTerminalLabel } from '@t3tools/shared/terminalLabels'
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Popover, PopoverPopup, PopoverTrigger } from '~/components/ui/popover'
import { cn } from '~/lib/utils'
import { type TerminalContextSelection } from '~/lib/terminalContext'
import {
  DEFAULT_THREAD_TERMINAL_HEIGHT,
  MAX_TERMINALS_PER_GROUP,
  type ThreadTerminalGroup,
} from '../types'
import { TerminalViewport, type TerminalLaunchLocation } from './thread-terminal/TerminalViewport'

export {
  resolveTerminalSelectionActionPosition,
  shouldHandleTerminalSelectionMouseUp,
  terminalSelectionActionDelayForClickCount,
} from './thread-terminal/selectionHelpers'

const MIN_DRAWER_HEIGHT = 180
const MAX_DRAWER_HEIGHT_RATIO = 0.75

function maxDrawerHeight(): number
{
  if (typeof window === 'undefined') return DEFAULT_THREAD_TERMINAL_HEIGHT
  return Math.max(MIN_DRAWER_HEIGHT, Math.floor(window.innerHeight * MAX_DRAWER_HEIGHT_RATIO))
}

function clampDrawerHeight(height: number): number
{
  const safeHeight = Number.isFinite(height) ? height : DEFAULT_THREAD_TERMINAL_HEIGHT
  const maxHeight = maxDrawerHeight()
  return Math.min(Math.max(Math.round(safeHeight), MIN_DRAWER_HEIGHT), maxHeight)
}

interface ThreadTerminalDrawerProps
{
  mode?: 'drawer' | 'panel'
  threadRef: ScopedThreadRef
  threadId: ThreadId
  cwd: string
  worktreePath?: string | null
  runtimeEnv?: Record<string, string>
  visible?: boolean
  height: number
  terminalIds: string[]
  activeTerminalId: string
  terminalGroups: ThreadTerminalGroup[]
  activeTerminalGroupId: string
  focusRequestId: number
  onSplitTerminal: () => void
  onSplitTerminalVertical: () => void
  onNewTerminal: () => void
  splitShortcutLabel?: string | undefined
  splitVerticalShortcutLabel?: string | undefined
  newShortcutLabel?: string | undefined
  closeShortcutLabel?: string | undefined
  onActiveTerminalChange: (terminalId: string) => void
  onCloseTerminal: (terminalId: string) => void
  onHeightChange: (height: number) => void
  onAddTerminalContext: (selection: TerminalContextSelection) => void
  keybindings: ResolvedKeybindingsConfig
  // prefer server-provided tab titles when present (e.g. active subprocess name).
  terminalLabelsById?: ReadonlyMap<string, string>
  // prefer per-session launch locations when the server already knows a terminal.
  terminalLaunchLocationsById?: ReadonlyMap<string, TerminalLaunchLocation>
}

interface TerminalActionButtonProps
{
  label: string
  className: string
  onClick: () => void
  children: ReactNode
}

function TerminalActionButton({ label, className, onClick, children }: TerminalActionButtonProps)
{
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        render={<button type="button" className={className} onClick={onClick} aria-label={label} />}
      >
        {children}
      </PopoverTrigger>
      <PopoverPopup
        tooltipStyle
        side="bottom"
        sideOffset={6}
        align="center"
        className="pointer-events-none select-none"
      >
        {label}
      </PopoverPopup>
    </Popover>
  )
}

export default function ThreadTerminalDrawer({
  mode = 'drawer',
  threadRef,
  threadId,
  cwd,
  worktreePath,
  runtimeEnv,
  visible = true,
  height,
  terminalIds,
  activeTerminalId,
  terminalGroups,
  activeTerminalGroupId,
  focusRequestId,
  onSplitTerminal,
  onSplitTerminalVertical,
  onNewTerminal,
  splitShortcutLabel,
  splitVerticalShortcutLabel,
  newShortcutLabel,
  closeShortcutLabel,
  onActiveTerminalChange,
  onCloseTerminal,
  onHeightChange,
  onAddTerminalContext,
  keybindings,
  terminalLabelsById,
  terminalLaunchLocationsById,
}: ThreadTerminalDrawerProps)
{
  const isPanel = mode === 'panel'
  const controlledDrawerHeight = clampDrawerHeight(height)
  const [drawerHeightState, setDrawerHeightState] = useState(() => ({
    threadId,
    height: controlledDrawerHeight,
  }))
  const drawerHeight =
    drawerHeightState.threadId === threadId ? drawerHeightState.height : controlledDrawerHeight
  const setDrawerHeight = useCallback(
    (update: SetStateAction<number>) =>
    {
      setDrawerHeightState((current) =>
      {
        const currentHeight =
          current.threadId === threadId ? current.height : controlledDrawerHeight
        const nextHeight = typeof update === 'function' ? update(currentHeight) : update
        return nextHeight === currentHeight && current.threadId === threadId
          ? current
          : { threadId, height: nextHeight }
      })
    },
    [controlledDrawerHeight, threadId],
  )
  const setDrawerHeightFromWindowResize = useEffectEvent((nextHeight: number) =>
  {
    setDrawerHeight(nextHeight)
  })
  const [resizeEpoch, setResizeEpoch] = useState(0)
  const drawerHeightRef = useRef(drawerHeight)
  const lastSyncedHeightRef = useRef(controlledDrawerHeight)
  const onHeightChangeRef = useRef(onHeightChange)
  const resizeStateRef = useRef<{
    pointerId: number
    startY: number
    startHeight: number
  } | null>(null)
  const didResizeDuringDragRef = useRef(false)

  const normalizedTerminalIds = useMemo(() =>
  {
    const normalizedIds: string[] = []
    const seen = new Set<string>()
    for (const id of terminalIds)
    {
      const trimmedId = id.trim()
      if (trimmedId.length === 0 || seen.has(trimmedId)) continue
      seen.add(trimmedId)
      normalizedIds.push(trimmedId)
    }
    return normalizedIds
  }, [terminalIds])

  const resolvedActiveTerminalId =
    normalizedTerminalIds.length === 0
      ? ''
      : normalizedTerminalIds.includes(activeTerminalId)
        ? activeTerminalId
        : (normalizedTerminalIds[0] ?? '')

  const resolvedTerminalGroups = useMemo(() =>
  {
    if (normalizedTerminalIds.length === 0)
    {
      return []
    }
    const validTerminalIdSet = new Set(normalizedTerminalIds)
    const assignedTerminalIds = new Set<string>()
    const usedGroupIds = new Set<string>()
    const nextGroups: ThreadTerminalGroup[] = []

    const assignUniqueGroupId = (groupId: string): string =>
    {
      if (!usedGroupIds.has(groupId))
      {
        usedGroupIds.add(groupId)
        return groupId
      }
      let suffix = 2
      while (usedGroupIds.has(`${groupId}-${suffix}`))
      {
        suffix += 1
      }
      const uniqueGroupId = `${groupId}-${suffix}`
      usedGroupIds.add(uniqueGroupId)
      return uniqueGroupId
    }

    for (const terminalGroup of terminalGroups)
    {
      const nextTerminalIds: string[] = []
      const seenGroupTerminalIds = new Set<string>()
      for (const id of terminalGroup.terminalIds)
      {
        const terminalId = id.trim()
        if (terminalId.length === 0) continue
        if (seenGroupTerminalIds.has(terminalId)) continue
        seenGroupTerminalIds.add(terminalId)
        if (!validTerminalIdSet.has(terminalId)) continue
        if (assignedTerminalIds.has(terminalId)) continue
        nextTerminalIds.push(terminalId)
      }
      if (nextTerminalIds.length === 0) continue

      for (const terminalId of nextTerminalIds)
      {
        assignedTerminalIds.add(terminalId)
      }

      const baseGroupId =
        terminalGroup.id.trim().length > 0
          ? terminalGroup.id.trim()
          : `group-${nextTerminalIds[0] ?? normalizedTerminalIds[0] ?? ''}`
      nextGroups.push({
        id: assignUniqueGroupId(baseGroupId),
        terminalIds: nextTerminalIds,
        ...(terminalGroup.splitDirection === 'vertical'
          ? { splitDirection: 'vertical' as const }
          : {}),
      })
    }

    for (const terminalId of normalizedTerminalIds)
    {
      if (assignedTerminalIds.has(terminalId)) continue
      nextGroups.push({
        id: assignUniqueGroupId(`group-${terminalId}`),
        terminalIds: [terminalId],
      })
    }

    const terminalOrderIndex = new Map(
      normalizedTerminalIds.map((id, index) => [id, index] as const),
    )
    nextGroups.sort((left, right) =>
    {
      const rank = (ids: readonly string[]) =>
        Math.min(...ids.map((id) => terminalOrderIndex.get(id) ?? Number.POSITIVE_INFINITY))
      return rank(left.terminalIds) - rank(right.terminalIds)
    })

    return nextGroups
  }, [normalizedTerminalIds, terminalGroups])

  const resolvedActiveGroupIndex = useMemo(() =>
  {
    const indexById = resolvedTerminalGroups.findIndex(
      (terminalGroup) => terminalGroup.id === activeTerminalGroupId,
    )
    if (indexById >= 0) return indexById
    const indexByTerminal = resolvedTerminalGroups.findIndex((terminalGroup) =>
      terminalGroup.terminalIds.includes(resolvedActiveTerminalId),
    )
    return indexByTerminal >= 0 ? indexByTerminal : 0
  }, [activeTerminalGroupId, resolvedActiveTerminalId, resolvedTerminalGroups])

  const visibleTerminalIds =
    resolvedTerminalGroups[resolvedActiveGroupIndex]?.terminalIds ??
    (normalizedTerminalIds.length > 0 ? [resolvedActiveTerminalId] : [])
  const splitDirection =
    resolvedTerminalGroups[resolvedActiveGroupIndex]?.splitDirection ?? 'horizontal'
  const hasTerminalSidebar = normalizedTerminalIds.length > 1
  const isSplitView = visibleTerminalIds.length > 1
  const showGroupHeaders =
    resolvedTerminalGroups.length > 1 ||
    resolvedTerminalGroups.some((terminalGroup) => terminalGroup.terminalIds.length > 1)
  const hasReachedSplitLimit = visibleTerminalIds.length >= MAX_TERMINALS_PER_GROUP
  const terminalLabelById = useMemo(() =>
  {
    const next = new Map<string, string>()
    for (const terminalId of normalizedTerminalIds)
    {
      next.set(terminalId, terminalLabelsById?.get(terminalId) ?? getTerminalLabel(terminalId))
    }
    return next
  }, [normalizedTerminalIds, terminalLabelsById])
  const resolveTerminalLaunchLocation = useCallback(
    (terminalId: string): TerminalLaunchLocation =>
    {
      return (
        terminalLaunchLocationsById?.get(terminalId) ?? {
          cwd,
          ...(worktreePath !== undefined ? { worktreePath } : {}),
          ...(runtimeEnv ? { runtimeEnv } : {}),
        }
      )
    },
    [cwd, runtimeEnv, terminalLaunchLocationsById, worktreePath],
  )
  const splitTerminalActionLabel = hasReachedSplitLimit
    ? `Split Terminal Horizontally (max ${MAX_TERMINALS_PER_GROUP} per group)`
    : splitShortcutLabel
      ? `Split Terminal Horizontally (${splitShortcutLabel})`
      : 'Split Terminal Horizontally'
  const splitTerminalVerticalActionLabel = hasReachedSplitLimit
    ? `Split Terminal Vertically (max ${MAX_TERMINALS_PER_GROUP} per group)`
    : splitVerticalShortcutLabel
      ? `Split Terminal Vertically (${splitVerticalShortcutLabel})`
      : 'Split Terminal Vertically'
  const newTerminalActionLabel = newShortcutLabel
    ? `New Terminal (${newShortcutLabel})`
    : 'New Terminal'
  const closeTerminalActionLabel = closeShortcutLabel
    ? `Close Terminal (${closeShortcutLabel})`
    : 'Close Terminal'
  const onSplitTerminalAction = useCallback(() =>
  {
    if (hasReachedSplitLimit) return
    onSplitTerminal()
  }, [hasReachedSplitLimit, onSplitTerminal])
  const onSplitTerminalVerticalAction = useCallback(() =>
  {
    if (hasReachedSplitLimit) return
    onSplitTerminalVertical()
  }, [hasReachedSplitLimit, onSplitTerminalVertical])
  const onNewTerminalAction = useCallback(() =>
  {
    onNewTerminal()
  }, [onNewTerminal])

  useEffect(() =>
  {
    onHeightChangeRef.current = onHeightChange
  }, [onHeightChange])

  useEffect(() =>
  {
    drawerHeightRef.current = drawerHeight
  }, [drawerHeight])

  const syncHeight = useCallback((nextHeight: number) =>
  {
    const clampedHeight = clampDrawerHeight(nextHeight)
    if (lastSyncedHeightRef.current === clampedHeight) return
    lastSyncedHeightRef.current = clampedHeight
    onHeightChangeRef.current(clampedHeight)
  }, [])

  useEffect(() =>
  {
    lastSyncedHeightRef.current = controlledDrawerHeight
  }, [controlledDrawerHeight, threadId])

  const handleResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) =>
  {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    didResizeDuringDragRef.current = false
    resizeStateRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: drawerHeightRef.current,
    }
  }, [])

  const handleResizePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) =>
    {
      const resizeState = resizeStateRef.current
      if (!resizeState || resizeState.pointerId !== event.pointerId) return
      event.preventDefault()
      const clampedHeight = clampDrawerHeight(
        resizeState.startHeight + (resizeState.startY - event.clientY),
      )
      if (clampedHeight === drawerHeightRef.current)
      {
        return
      }
      didResizeDuringDragRef.current = true
      drawerHeightRef.current = clampedHeight
      setDrawerHeight(clampedHeight)
    },
    [setDrawerHeight],
  )

  const handleResizePointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) =>
    {
      const resizeState = resizeStateRef.current
      if (!resizeState || resizeState.pointerId !== event.pointerId) return
      resizeStateRef.current = null
      if (event.currentTarget.hasPointerCapture(event.pointerId))
      {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      if (!didResizeDuringDragRef.current)
      {
        return
      }
      syncHeight(drawerHeightRef.current)
      setResizeEpoch((value) => value + 1)
    },
    [syncHeight],
  )

  useEffect(() =>
  {
    if (!visible)
    {
      return
    }

    const onWindowResize = () =>
    {
      const clampedHeight = clampDrawerHeight(drawerHeightRef.current)
      const changed = clampedHeight !== drawerHeightRef.current
      if (changed)
      {
        setDrawerHeightFromWindowResize(clampedHeight)
        drawerHeightRef.current = clampedHeight
      }
      if (!resizeStateRef.current)
      {
        syncHeight(clampedHeight)
      }
      setResizeEpoch((value) => value + 1)
    }
    window.addEventListener('resize', onWindowResize)
    return () =>
    {
      window.removeEventListener('resize', onWindowResize)
    }
  }, [syncHeight, visible])

  useEffect(() =>
  {
    if (!visible)
    {
      return
    }
    setResizeEpoch((value) => value + 1)
  }, [visible])

  useEffect(() =>
  {
    return () =>
    {
      syncHeight(drawerHeightRef.current)
    }
  }, [syncHeight])

  if (normalizedTerminalIds.length === 0)
  {
    return (
      <aside
        data-terminal-owner={isPanel ? 'right-panel' : 'drawer'}
        className={cn(
          'thread-terminal-drawer relative flex min-w-0 flex-col overflow-hidden bg-sidebar',
          isPanel ? 'h-full flex-1' : 'shrink-0 border-t border-border/80',
        )}
        style={isPanel ? undefined : { height: `${drawerHeight}px` }}
      >
        {!isPanel ? (
          <div
            className="absolute inset-x-0 top-0 z-20 h-1.5 cursor-row-resize"
            onPointerDown={handleResizePointerDown}
            onPointerMove={handleResizePointerMove}
            onPointerUp={handleResizePointerEnd}
            onPointerCancel={handleResizePointerEnd}
          />
        ) : null}
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-4 py-6 text-center text-sm text-muted-foreground">
          <p>No terminal sessions for this thread yet.</p>
          <button
            type="button"
            className="rounded-md border border-border/80 bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
            onClick={onNewTerminalAction}
          >
            {newTerminalActionLabel}
          </button>
        </div>
      </aside>
    )
  }

  const activeTerminalLaunchLocation = resolveTerminalLaunchLocation(resolvedActiveTerminalId)

  return (
    <aside
      data-terminal-owner={isPanel ? 'right-panel' : 'drawer'}
      className={cn(
        'thread-terminal-drawer relative flex min-w-0 flex-col overflow-hidden bg-sidebar',
        isPanel ? 'h-full flex-1' : 'shrink-0 border-t border-border/80',
      )}
      style={isPanel ? undefined : { height: `${drawerHeight}px` }}
    >
      {!isPanel ? (
        <div
          className="absolute inset-x-0 top-0 z-20 h-1.5 cursor-row-resize"
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          onPointerUp={handleResizePointerEnd}
          onPointerCancel={handleResizePointerEnd}
        />
      ) : null}

      {!hasTerminalSidebar && (
        <div className="pointer-events-none absolute right-2 top-2 z-20">
          <div className="pointer-events-auto inline-flex items-center overflow-hidden rounded-md border border-border/80 bg-background/70">
            <TerminalActionButton
              className={`p-1 text-foreground/90 transition-colors ${
                hasReachedSplitLimit
                  ? 'cursor-not-allowed opacity-45 hover:bg-transparent'
                  : 'hover:bg-accent'
              }`}
              onClick={onSplitTerminalAction}
              label={splitTerminalActionLabel}
            >
              <SquareSplitHorizontal className="size-3.25" />
            </TerminalActionButton>
            <div className="h-4 w-px bg-border/80" />
            <TerminalActionButton
              className={`p-1 text-foreground/90 transition-colors ${
                hasReachedSplitLimit
                  ? 'cursor-not-allowed opacity-45 hover:bg-transparent'
                  : 'hover:bg-accent'
              }`}
              onClick={onSplitTerminalVerticalAction}
              label={splitTerminalVerticalActionLabel}
            >
              <SquareSplitVertical className="size-3.25" />
            </TerminalActionButton>
            <div className="h-4 w-px bg-border/80" />
            <TerminalActionButton
              className="p-1 text-foreground/90 transition-colors hover:bg-accent"
              onClick={onNewTerminalAction}
              label={newTerminalActionLabel}
            >
              <Plus className="size-3.25" />
            </TerminalActionButton>
            <div className="h-4 w-px bg-border/80" />
            <TerminalActionButton
              className="p-1 text-foreground/90 transition-colors hover:bg-accent"
              onClick={() => onCloseTerminal(resolvedActiveTerminalId)}
              label={closeTerminalActionLabel}
            >
              <Trash2 className="size-3.25" />
            </TerminalActionButton>
          </div>
        </div>
      )}

      <div className="min-h-0 w-full flex-1">
        <div className={`flex h-full min-h-0 ${hasTerminalSidebar ? 'gap-1.5' : ''}`}>
          <div className="min-w-0 flex-1">
            {isSplitView ? (
              <div
                className="grid h-full w-full min-w-0 gap-0 overflow-hidden"
                style={
                  splitDirection === 'vertical'
                    ? {
                        gridTemplateRows: `repeat(${visibleTerminalIds.length}, minmax(0, 1fr))`,
                      }
                    : {
                        gridTemplateColumns: `repeat(${visibleTerminalIds.length}, minmax(0, 1fr))`,
                      }
                }
              >
                {visibleTerminalIds.map((terminalId) =>
                  {
                  const terminalLaunchLocation = resolveTerminalLaunchLocation(terminalId)
                  return (
                    <div
                      key={terminalId}
                      className={`min-h-0 min-w-0 ${
                        splitDirection === 'vertical'
                          ? 'border-t first:border-t-0'
                          : 'border-l first:border-l-0'
                      } ${
                        terminalId === resolvedActiveTerminalId
                          ? 'border-border'
                          : 'border-border/70'
                      }`}
                      onMouseDown={() =>
                        {
                        if (terminalId !== resolvedActiveTerminalId)
                          {
                          onActiveTerminalChange(terminalId)
                        }
                      }}
                    >
                      <div className="h-full p-1">
                        <TerminalViewport
                          threadRef={threadRef}
                          threadId={threadId}
                          terminalId={terminalId}
                          terminalLabel={terminalLabelById.get(terminalId) ?? 'Terminal'}
                          cwd={terminalLaunchLocation.cwd}
                          {...(terminalLaunchLocation.worktreePath !== undefined
                            ? { worktreePath: terminalLaunchLocation.worktreePath }
                            : {})}
                          {...(terminalLaunchLocation.runtimeEnv
                            ? { runtimeEnv: terminalLaunchLocation.runtimeEnv }
                            : {})}
                          onSessionExited={() => onCloseTerminal(terminalId)}
                          onAddTerminalContext={onAddTerminalContext}
                          focusRequestId={focusRequestId}
                          autoFocus={terminalId === resolvedActiveTerminalId}
                          resizeEpoch={resizeEpoch}
                          drawerHeight={drawerHeight}
                          keybindings={keybindings}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="h-full p-1">
                <TerminalViewport
                  key={resolvedActiveTerminalId}
                  threadRef={threadRef}
                  threadId={threadId}
                  terminalId={resolvedActiveTerminalId}
                  terminalLabel={terminalLabelById.get(resolvedActiveTerminalId) ?? 'Terminal'}
                  cwd={activeTerminalLaunchLocation.cwd}
                  {...(activeTerminalLaunchLocation.worktreePath !== undefined
                    ? { worktreePath: activeTerminalLaunchLocation.worktreePath }
                    : {})}
                  {...(activeTerminalLaunchLocation.runtimeEnv
                    ? { runtimeEnv: activeTerminalLaunchLocation.runtimeEnv }
                    : {})}
                  onSessionExited={() => onCloseTerminal(resolvedActiveTerminalId)}
                  onAddTerminalContext={onAddTerminalContext}
                  focusRequestId={focusRequestId}
                  autoFocus
                  resizeEpoch={resizeEpoch}
                  drawerHeight={drawerHeight}
                  keybindings={keybindings}
                />
              </div>
            )}
          </div>

          {hasTerminalSidebar && (
            <aside className="flex w-36 min-w-36 flex-col border border-border/70 bg-muted/10">
              <div className="flex h-[22px] items-stretch justify-end border-b border-border/70">
                <div className="inline-flex h-full items-stretch">
                  <TerminalActionButton
                    className={`inline-flex h-full items-center px-1 text-foreground/90 transition-colors ${
                      hasReachedSplitLimit
                        ? 'cursor-not-allowed opacity-45 hover:bg-transparent'
                        : 'hover:bg-accent/70'
                    }`}
                    onClick={onSplitTerminalAction}
                    label={splitTerminalActionLabel}
                  >
                    <SquareSplitHorizontal className="size-3.25" />
                  </TerminalActionButton>
                  <TerminalActionButton
                    className={`inline-flex h-full items-center border-l border-border/70 px-1 text-foreground/90 transition-colors ${
                      hasReachedSplitLimit
                        ? 'cursor-not-allowed opacity-45 hover:bg-transparent'
                        : 'hover:bg-accent/70'
                    }`}
                    onClick={onSplitTerminalVerticalAction}
                    label={splitTerminalVerticalActionLabel}
                  >
                    <SquareSplitVertical className="size-3.25" />
                  </TerminalActionButton>
                  <TerminalActionButton
                    className="inline-flex h-full items-center border-l border-border/70 px-1 text-foreground/90 transition-colors hover:bg-accent/70"
                    onClick={onNewTerminalAction}
                    label={newTerminalActionLabel}
                  >
                    <Plus className="size-3.25" />
                  </TerminalActionButton>
                  <TerminalActionButton
                    className="inline-flex h-full items-center border-l border-border/70 px-1 text-foreground/90 transition-colors hover:bg-accent/70"
                    onClick={() => onCloseTerminal(resolvedActiveTerminalId)}
                    label={closeTerminalActionLabel}
                  >
                    <Trash2 className="size-3.25" />
                  </TerminalActionButton>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
                {resolvedTerminalGroups.map((terminalGroup, groupIndex) =>
                {
                  const isGroupActive = terminalGroup.terminalIds.includes(resolvedActiveTerminalId)
                  const groupActiveTerminalId = isGroupActive
                    ? resolvedActiveTerminalId
                    : (terminalGroup.terminalIds[0] ?? resolvedActiveTerminalId)

                  return (
                    <div key={terminalGroup.id} className="pb-0.5">
                      {showGroupHeaders && (
                        <button
                          type="button"
                          className={`flex w-full items-center rounded px-1 py-0.5 text-[10px] uppercase tracking-[0.08em] ${
                            isGroupActive
                              ? 'bg-accent/70 text-foreground'
                              : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                          }`}
                          onClick={() => onActiveTerminalChange(groupActiveTerminalId)}
                        >
                          Group {groupIndex + 1}
                        </button>
                      )}

                      <div
                        className={showGroupHeaders ? 'ml-1 border-l border-border/60 pl-1.5' : ''}
                      >
                        {terminalGroup.terminalIds.map((terminalId) =>
                        {
                          const isActive = terminalId === resolvedActiveTerminalId
                          const closeTerminalLabel = `Close ${
                            terminalLabelById.get(terminalId) ?? 'terminal'
                          }${isActive && closeShortcutLabel ? ` (${closeShortcutLabel})` : ''}`
                          return (
                            <div
                              key={terminalId}
                              className={`group flex items-center gap-1 rounded px-1 py-0.5 text-[11px] ${
                                isActive
                                  ? 'bg-accent text-foreground'
                                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                              }`}
                            >
                              {showGroupHeaders && (
                                <span className="text-[10px] text-muted-foreground/80">└</span>
                              )}
                              <button
                                type="button"
                                className="flex min-w-0 flex-1 items-center gap-1 text-left"
                                onClick={() => onActiveTerminalChange(terminalId)}
                              >
                                <TerminalSquare className="size-3 shrink-0" />
                                <span className="truncate">
                                  {terminalLabelById.get(terminalId) ?? 'Terminal'}
                                </span>
                              </button>
                              {normalizedTerminalIds.length > 1 && (
                                <Popover>
                                  <PopoverTrigger
                                    openOnHover
                                    render={
                                      <button
                                        type="button"
                                        className="inline-flex size-3.5 items-center justify-center rounded text-xs font-medium leading-none text-muted-foreground opacity-0 transition hover:bg-accent hover:text-foreground group-hover:opacity-100"
                                        onClick={() => onCloseTerminal(terminalId)}
                                        aria-label={closeTerminalLabel}
                                      />
                                    }
                                  >
                                    <XIcon className="size-2.5" />
                                  </PopoverTrigger>
                                  <PopoverPopup
                                    tooltipStyle
                                    side="bottom"
                                    sideOffset={6}
                                    align="center"
                                    className="pointer-events-none select-none"
                                  >
                                    {closeTerminalLabel}
                                  </PopoverPopup>
                                </Popover>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>
            </aside>
          )}
        </div>
      </div>
    </aside>
  )
}
