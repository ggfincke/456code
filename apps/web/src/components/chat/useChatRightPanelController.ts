// apps/web/src/components/chat/useChatRightPanelController.ts
// coordinates thread-scoped right-panel surfaces and their resource cleanup

import type { AtomCommandResult } from '@t3tools/client-runtime/state/runtime'
import type {
  EnvironmentId,
  PreviewCloseInput,
  ScopedThreadRef,
  TerminalCloseInput,
  TerminalOpenInput,
} from '@t3tools/contracts'
import { projectScriptRuntimeEnv } from '@t3tools/shared/projectScripts'
import { nextTerminalId } from '@t3tools/shared/terminalLabels'
import { type Dispatch, type SetStateAction, useCallback, useEffect } from 'react'

import type { OpenPreviewMutation } from '~/browser/openFileInPreview'
import { isPreviewSupportedInRuntime, setActivePreviewTab } from '~/previewStateStore'
import {
  selectActiveRightPanelSurface,
  type RightPanelSurface,
  type ThreadRightPanelState,
  useRightPanelStore,
} from '~/rightPanelStore'
import { MAX_TERMINALS_PER_GROUP } from '~/types'

import { chatActionErrorMessage } from '../ChatView.logic'
import { addBrowserSurface } from '../preview/addBrowserSurface'
import { closePreviewSession } from '../preview/closePreviewSession'
import { subscribePreviewAction } from '../preview/previewActionBus'
import { stackedThreadToast, toastManager } from '../ui/toast'

type ClosePreviewMutation = (input: {
  readonly environmentId: EnvironmentId
  readonly input: PreviewCloseInput
}) => Promise<AtomCommandResult<void, unknown>>

type OpenTerminalMutation = (input: {
  readonly environmentId: EnvironmentId
  readonly input: TerminalOpenInput
}) => Promise<unknown>

type CloseTerminalMutation = (input: {
  readonly environmentId: EnvironmentId
  readonly input: TerminalCloseInput
}) => Promise<unknown>

interface UseChatRightPanelControllerInput
{
  readonly activeKnownTerminalIds: readonly string[]
  readonly activePreviewTabId: string | null
  readonly activePreviewSessions: Record<
    string,
    import('@t3tools/contracts').PreviewSessionSnapshot
  >
  readonly activeProjectWorkspaceRoot: string | null
  readonly activeRightPanelSurface: RightPanelSurface | null
  readonly activeThreadRef: ScopedThreadRef | null
  readonly activeThreadWorktreePath: string | null
  readonly canMaximizeRightPanel: boolean
  readonly closePreview: ClosePreviewMutation
  readonly closeTerminal: CloseTerminalMutation
  readonly diffOpen: boolean
  readonly dismissPlanSidebarForCurrentTurn: () => void
  readonly explorerAvailable: boolean
  readonly gitCwd: string | null
  readonly isGitRepo: boolean
  readonly isServerThread: boolean
  readonly onDiffPanelOpen: (() => void) | undefined
  readonly openPreview: OpenPreviewMutation<unknown>
  readonly openTerminal: OpenTerminalMutation
  readonly panelTerminalIds: ReadonlySet<string>
  readonly planSidebarOpen: boolean
  readonly previewPanelOpen: boolean
  readonly requestTerminalFocus: () => void
  readonly resetPlanSidebarDismissal: () => void
  readonly rightPanelOpen: boolean
  readonly rightPanelState: ThreadRightPanelState
  readonly routeThreadKey: string
  readonly setMaximizedRightPanelThreadKey: Dispatch<SetStateAction<string | null>>
  readonly storeCloseTerminal: (threadRef: ScopedThreadRef, terminalId: string) => void
}

export function useChatRightPanelController(input: UseChatRightPanelControllerInput)
{
  const {
    activeKnownTerminalIds,
    activePreviewTabId,
    activePreviewSessions,
    activeProjectWorkspaceRoot,
    activeRightPanelSurface,
    activeThreadRef,
    activeThreadWorktreePath,
    canMaximizeRightPanel,
    closePreview,
    closeTerminal,
    diffOpen,
    dismissPlanSidebarForCurrentTurn,
    explorerAvailable,
    gitCwd,
    isGitRepo,
    isServerThread,
    onDiffPanelOpen,
    openPreview,
    openTerminal,
    panelTerminalIds,
    planSidebarOpen,
    previewPanelOpen,
    requestTerminalFocus,
    resetPlanSidebarDismissal,
    rightPanelOpen,
    rightPanelState,
    routeThreadKey,
    setMaximizedRightPanelThreadKey,
    storeCloseTerminal,
  } = input

  const onToggleDiff = useCallback(() =>
  {
    if (!isServerThread)
    {
      return
    }
    if (!diffOpen)
    {
      onDiffPanelOpen?.()
    }
    if (activeThreadRef)
    {
      useRightPanelStore.getState().toggle(activeThreadRef, 'diff')
    }
  }, [activeThreadRef, diffOpen, isServerThread, onDiffPanelOpen])

  const togglePlanSidebar = useCallback(() =>
  {
    if (!activeThreadRef) return
    if (planSidebarOpen)
    {
      dismissPlanSidebarForCurrentTurn()
    }
    else
    {
      resetPlanSidebarDismissal()
    }
    useRightPanelStore.getState().toggle(activeThreadRef, 'plan')
  }, [
    activeThreadRef,
    dismissPlanSidebarForCurrentTurn,
    planSidebarOpen,
    resetPlanSidebarDismissal,
  ])

  const closePlanSidebar = useCallback(() =>
  {
    if (!activeThreadRef) return
    setMaximizedRightPanelThreadKey(null)
    useRightPanelStore.getState().close(activeThreadRef)
    dismissPlanSidebarForCurrentTurn()
  }, [activeThreadRef, dismissPlanSidebarForCurrentTurn, setMaximizedRightPanelThreadKey])

  const createBrowserSurface = useCallback(() =>
  {
    if (!activeThreadRef) return
    void addBrowserSurface({ threadRef: activeThreadRef, openPreview })
  }, [activeThreadRef, openPreview])

  const addDiffSurface = useCallback(() =>
  {
    if (!activeThreadRef || !isServerThread || !isGitRepo) return
    if (planSidebarOpen)
    {
      dismissPlanSidebarForCurrentTurn()
    }
    useRightPanelStore.getState().open(activeThreadRef, 'diff')
    onDiffPanelOpen?.()
  }, [
    activeThreadRef,
    dismissPlanSidebarForCurrentTurn,
    isGitRepo,
    isServerThread,
    onDiffPanelOpen,
    planSidebarOpen,
  ])

  const addFilesSurface = useCallback(() =>
  {
    if (!activeThreadRef || !activeProjectWorkspaceRoot) return
    useRightPanelStore.getState().open(activeThreadRef, 'files')
  }, [activeProjectWorkspaceRoot, activeThreadRef])

  // workers reads local broker state, so it is available for every thread
  const addWorkersSurface = useCallback(() =>
  {
    if (!activeThreadRef) return
    useRightPanelStore.getState().open(activeThreadRef, 'workers')
  }, [activeThreadRef])

  const addExplorerSurface = useCallback(() =>
  {
    if (!activeThreadRef || !explorerAvailable) return
    useRightPanelStore.getState().open(activeThreadRef, 'explorer')
  }, [activeThreadRef, explorerAvailable])

  const openFileSurface = useCallback(
    (relativePath: string, line?: number) =>
    {
      if (!activeThreadRef || !activeProjectWorkspaceRoot) return
      useRightPanelStore.getState().openFile(activeThreadRef, relativePath, line)
    },
    [activeProjectWorkspaceRoot, activeThreadRef],
  )

  const selectExplorerFile = useCallback(
    (relativePath: string | null) =>
    {
      if (relativePath === null) return
      openFileSurface(relativePath)
    },
    [openFileSurface],
  )

  const togglePreviewPanel = useCallback(() =>
  {
    if (!activeThreadRef || !isPreviewSupportedInRuntime()) return
    if (previewPanelOpen)
    {
      useRightPanelStore.getState().close(activeThreadRef)
      return
    }
    if (activePreviewTabId)
    {
      useRightPanelStore.getState().openBrowser(activeThreadRef, activePreviewTabId)
    }
    else
    {
      createBrowserSurface()
    }
  }, [activePreviewTabId, activeThreadRef, createBrowserSurface, previewPanelOpen])

  const closePreviewPanel = useCallback(() =>
  {
    if (!activeThreadRef) return
    setMaximizedRightPanelThreadKey(null)
    useRightPanelStore.getState().close(activeThreadRef)
  }, [activeThreadRef, setMaximizedRightPanelThreadKey])

  const openPanelTerminal = useCallback(
    (terminalId: string) =>
    {
      if (!activeThreadRef || !activeProjectWorkspaceRoot) return
      const cwd = gitCwd ?? activeProjectWorkspaceRoot
      void openTerminal({
        environmentId: activeThreadRef.environmentId,
        input: {
          threadId: activeThreadRef.threadId,
          terminalId,
          cwd,
          ...(activeThreadWorktreePath != null ? { worktreePath: activeThreadWorktreePath } : {}),
          env: projectScriptRuntimeEnv({
            project: { cwd: activeProjectWorkspaceRoot },
            worktreePath: activeThreadWorktreePath,
          }),
        },
      })
    },
    [activeProjectWorkspaceRoot, activeThreadRef, activeThreadWorktreePath, gitCwd, openTerminal],
  )

  const addTerminalSurface = useCallback(() =>
  {
    if (!activeThreadRef || !activeProjectWorkspaceRoot) return
    const terminalId = nextTerminalId([...activeKnownTerminalIds, ...panelTerminalIds])
    useRightPanelStore.getState().openTerminal(activeThreadRef, terminalId)
    requestTerminalFocus()
    openPanelTerminal(terminalId)
  }, [
    activeKnownTerminalIds,
    activeProjectWorkspaceRoot,
    activeThreadRef,
    openPanelTerminal,
    panelTerminalIds,
    requestTerminalFocus,
  ])

  const splitPanelTerminal = useCallback(
    (direction: 'horizontal' | 'vertical' = 'horizontal') =>
    {
      if (
        !activeThreadRef ||
        !activeProjectWorkspaceRoot ||
        activeRightPanelSurface?.kind !== 'terminal' ||
        activeRightPanelSurface.terminalIds.length >= MAX_TERMINALS_PER_GROUP
      )
      {
        return
      }
      const terminalId = nextTerminalId([...activeKnownTerminalIds, ...panelTerminalIds])
      useRightPanelStore
        .getState()
        .splitTerminal(activeThreadRef, activeRightPanelSurface.id, terminalId, direction)
      requestTerminalFocus()
      openPanelTerminal(terminalId)
    },
    [
      activeKnownTerminalIds,
      activeProjectWorkspaceRoot,
      activeRightPanelSurface,
      activeThreadRef,
      openPanelTerminal,
      panelTerminalIds,
      requestTerminalFocus,
    ],
  )

  const splitPanelTerminalVertical = useCallback(() =>
  {
    splitPanelTerminal('vertical')
  }, [splitPanelTerminal])

  const activatePanelTerminal = useCallback(
    (terminalId: string) =>
    {
      if (!activeThreadRef || activeRightPanelSurface?.kind !== 'terminal') return
      useRightPanelStore
        .getState()
        .activateTerminal(activeThreadRef, activeRightPanelSurface.id, terminalId)
      requestTerminalFocus()
    },
    [activeRightPanelSurface, activeThreadRef, requestTerminalFocus],
  )

  const closePanelTerminal = useCallback(
    (terminalId: string) =>
    {
      if (!activeThreadRef || activeRightPanelSurface?.kind !== 'terminal') return
      void closeTerminal({
        environmentId: activeThreadRef.environmentId,
        input: { threadId: activeThreadRef.threadId, terminalId, deleteHistory: true },
      })
      storeCloseTerminal(activeThreadRef, terminalId)
      useRightPanelStore
        .getState()
        .closeTerminal(activeThreadRef, activeRightPanelSurface.id, terminalId)
      requestTerminalFocus()
    },
    [
      activeRightPanelSurface,
      activeThreadRef,
      closeTerminal,
      requestTerminalFocus,
      storeCloseTerminal,
    ],
  )

  const activateRightPanelSurface = useCallback(
    (surface: RightPanelSurface) =>
    {
      if (!activeThreadRef) return
      if (surface.kind === 'plan')
      {
        resetPlanSidebarDismissal()
      }
      else if (planSidebarOpen)
      {
        dismissPlanSidebarForCurrentTurn()
      }
      useRightPanelStore.getState().activateSurface(activeThreadRef, surface.id)
      if (surface.kind === 'preview' && surface.resourceId)
      {
        setActivePreviewTab(activeThreadRef, surface.resourceId)
      }
      if (surface.kind === 'terminal')
      {
        requestTerminalFocus()
      }
      if (surface.kind === 'diff' && !diffOpen)
      {
        onDiffPanelOpen?.()
      }
    },
    [
      activeThreadRef,
      diffOpen,
      dismissPlanSidebarForCurrentTurn,
      onDiffPanelOpen,
      planSidebarOpen,
      requestTerminalFocus,
      resetPlanSidebarDismissal,
    ],
  )

  const toggleRightPanel = useCallback(() =>
  {
    if (!activeThreadRef) return
    if (rightPanelOpen)
    {
      if (planSidebarOpen)
      {
        closePlanSidebar()
      }
      else
      {
        closePreviewPanel()
      }
      return
    }
    useRightPanelStore.getState().toggleVisibility(activeThreadRef)
  }, [activeThreadRef, closePlanSidebar, closePreviewPanel, planSidebarOpen, rightPanelOpen])

  const toggleRightPanelMaximized = useCallback(() =>
  {
    if (!canMaximizeRightPanel) return
    setMaximizedRightPanelThreadKey((threadKey) =>
      threadKey === routeThreadKey ? null : routeThreadKey,
    )
  }, [canMaximizeRightPanel, routeThreadKey, setMaximizedRightPanelThreadKey])

  const cleanupRightPanelSurfaces = useCallback(
    (surfaces: readonly RightPanelSurface[]) =>
    {
      if (!activeThreadRef) return
      if (surfaces.some((surface) => surface.kind === 'plan'))
      {
        dismissPlanSidebarForCurrentTurn()
      }

      for (const surface of surfaces)
      {
        if (surface.kind === 'preview' && surface.resourceId)
        {
          void closePreviewSession({
            closePreview,
            snapshot: activePreviewSessions[surface.resourceId] ?? null,
            tabId: surface.resourceId,
            threadRef: activeThreadRef,
          })
        }
        if (surface.kind === 'terminal')
        {
          for (const terminalId of surface.terminalIds)
          {
            storeCloseTerminal(activeThreadRef, terminalId)
            void closeTerminal({
              environmentId: activeThreadRef.environmentId,
              input: { threadId: activeThreadRef.threadId, terminalId, deleteHistory: true },
            })
          }
        }
      }
    },
    [
      activePreviewSessions,
      activeThreadRef,
      closePreview,
      closeTerminal,
      dismissPlanSidebarForCurrentTurn,
      storeCloseTerminal,
    ],
  )

  const syncActivePreviewSurface = useCallback(() =>
  {
    if (!activeThreadRef) return
    const nextActiveSurface = selectActiveRightPanelSurface(
      useRightPanelStore.getState().byThreadKey,
      activeThreadRef,
    )
    if (nextActiveSurface?.kind === 'preview' && nextActiveSurface.resourceId)
    {
      setActivePreviewTab(activeThreadRef, nextActiveSurface.resourceId)
    }
  }, [activeThreadRef])

  const closeRightPanelSurface = useCallback(
    (surface: RightPanelSurface) =>
    {
      if (!activeThreadRef) return
      cleanupRightPanelSurfaces([surface])
      useRightPanelStore.getState().closeSurface(activeThreadRef, surface.id)
      syncActivePreviewSurface()
    },
    [activeThreadRef, cleanupRightPanelSurfaces, syncActivePreviewSurface],
  )

  const closeOtherRightPanelSurfaces = useCallback(
    (surface: RightPanelSurface) =>
    {
      if (!activeThreadRef) return
      const surfaces = rightPanelState.surfaces.filter((entry) => entry.id !== surface.id)
      cleanupRightPanelSurfaces(surfaces)
      useRightPanelStore.getState().closeOtherSurfaces(activeThreadRef, surface.id)
      syncActivePreviewSurface()
    },
    [
      activeThreadRef,
      cleanupRightPanelSurfaces,
      rightPanelState.surfaces,
      syncActivePreviewSurface,
    ],
  )

  const closeRightPanelSurfacesToRight = useCallback(
    (surface: RightPanelSurface) =>
    {
      if (!activeThreadRef) return
      const surfaceIndex = rightPanelState.surfaces.findIndex((entry) => entry.id === surface.id)
      if (surfaceIndex < 0) return
      const surfaces = rightPanelState.surfaces.slice(surfaceIndex + 1)
      cleanupRightPanelSurfaces(surfaces)
      useRightPanelStore.getState().closeSurfacesToRight(activeThreadRef, surface.id)
      syncActivePreviewSurface()
    },
    [
      activeThreadRef,
      cleanupRightPanelSurfaces,
      rightPanelState.surfaces,
      syncActivePreviewSurface,
    ],
  )

  const closeAllRightPanelSurfaces = useCallback(() =>
  {
    if (!activeThreadRef) return
    cleanupRightPanelSurfaces(rightPanelState.surfaces)
    useRightPanelStore.getState().closeAllSurfaces(activeThreadRef)
  }, [activeThreadRef, cleanupRightPanelSurfaces, rightPanelState.surfaces])

  const copyRightPanelFilePath = useCallback((relativePath: string) =>
  {
    if (typeof window === 'undefined' || !navigator.clipboard?.writeText)
    {
      toastManager.add(
        stackedThreadToast({
          type: 'error',
          title: 'Failed to copy path',
          description: 'Clipboard API unavailable.',
        }),
      )
      return
    }

    void navigator.clipboard.writeText(relativePath).then(
      () =>
      {
        toastManager.add({
          type: 'success',
          title: 'Path copied',
          description: relativePath,
        })
      },
      (error) =>
      {
        toastManager.add(
          stackedThreadToast({
            type: 'error',
            title: 'Failed to copy path',
            description: chatActionErrorMessage(error),
          }),
        )
      },
    )
  }, [])

  useEffect(
    () =>
      subscribePreviewAction((action) =>
      {
        if (action === 'toggle-panel') togglePreviewPanel()
      }),
    [togglePreviewPanel],
  )

  return {
    activatePanelTerminal,
    activateRightPanelSurface,
    addDiffSurface,
    addExplorerSurface,
    addFilesSurface,
    addTerminalSurface,
    addWorkersSurface,
    closeAllRightPanelSurfaces,
    closeOtherRightPanelSurfaces,
    closePanelTerminal,
    closePlanSidebar,
    closePreviewPanel,
    closeRightPanelSurface,
    closeRightPanelSurfacesToRight,
    copyRightPanelFilePath,
    createBrowserSurface,
    onToggleDiff,
    openFileSurface,
    selectExplorerFile,
    splitPanelTerminal,
    splitPanelTerminalVertical,
    togglePlanSidebar,
    toggleRightPanel,
    toggleRightPanelMaximized,
  }
}
