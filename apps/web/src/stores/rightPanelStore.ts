// apps/web/src/stores/rightPanelStore.ts
// owns thread-scoped right-panel surface identity and persistence

// thread-scoped right-panel surface state.
//
// this is intentionally a shallow workspace model: it owns an ordered set of
// surface descriptors and the active surface, while each feature continues to
// own its durable resource state. Browser and terminal surfaces point at live
// sessions, file surfaces point at workspace or immutable architecture sources,
// and native architecture surfaces retain their exact analyzed identity.
import { scopedThreadKey } from '@t3tools/client-runtime/environment'
import type {
  OrchestratePlanRunId,
  OrchestrationProposedPlanId,
  ScopedThreadRef,
  ThreadId,
} from '@t3tools/contracts'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

import {
  architectureFileSurfaceId,
  decodeArchitectureFileSource,
  decodeArchitectureRightPanelSurface,
  isArchitectureRelativePath,
  type ArchitectureFileSource,
  type ArchitectureRightPanelSurface,
} from '../components/architecture/architectureResourceIdentity'
import { resolveStorage } from '../lib/storage'

export const RIGHT_PANEL_KINDS = [
  'plan',
  'diff',
  'files',
  'file',
  'preview',
  'terminal',
  'workers',
  'explorer',
  'repository-atlas-home',
  'architecture-impact',
  'repository-atlas',
] as const
export type RightPanelKind = (typeof RIGHT_PANEL_KINDS)[number]

type OpenRightPanelKind = Exclude<
  RightPanelKind,
  'file' | 'terminal' | 'architecture-impact' | 'repository-atlas'
>
type SingletonRightPanelKind = Exclude<OpenRightPanelKind, 'preview'>

export type ExplorerTarget =
  | {
      readonly kind: 'plan'
      readonly planId: OrchestrationProposedPlanId
    }
  | {
      readonly kind: 'orchestrate'
      readonly threadId: ThreadId
      readonly runId: OrchestratePlanRunId
      readonly revision: number
    }

export type RightPanelSurface =
  | { id: `browser:${string}`; kind: 'preview'; resourceId: string }
  | { id: 'browser:new'; kind: 'preview'; resourceId: null }
  | {
      id: `terminal:${string}`
      kind: 'terminal'
      resourceId: string
      terminalIds: string[]
      activeTerminalId: string
      splitDirection?: 'horizontal' | 'vertical'
    }
  | { id: 'diff'; kind: 'diff' }
  | { id: 'files'; kind: 'files' }
  | {
      id: `file:${string}` | `architecture-file:${string}`
      kind: 'file'
      relativePath: string
      revealLine: number | null
      revealRequestId: number
      source?: ArchitectureFileSource
    }
  | { id: 'plan'; kind: 'plan' }
  | { id: 'repository-atlas-home'; kind: 'repository-atlas-home' }
  // an optional run scopes the workers panel to one orchestration run
  | { id: 'workers'; kind: 'workers'; run?: string }
  | {
      id: 'explorer'
      kind: 'explorer'
      target: ExplorerTarget | null
    }
  | ArchitectureRightPanelSurface

const RIGHT_PANEL_STORAGE_KEY = '456code:right-panel-state:v2'
const RIGHT_PANEL_STORAGE_VERSION = 13

export interface ThreadRightPanelState
{
  isOpen: boolean
  activeSurfaceId: string | null
  surfaces: RightPanelSurface[]
}

interface RightPanelStoreState
{
  byThreadKey: Record<string, ThreadRightPanelState>
  open: (ref: ScopedThreadRef, kind: OpenRightPanelKind) => void
  openBrowser: (ref: ScopedThreadRef, tabId: string | null) => void
  openExplorer: (ref: ScopedThreadRef, target: ExplorerTarget | null) => void
  openWorkers: (ref: ScopedThreadRef, run?: string) => void
  openFile: (
    ref: ScopedThreadRef,
    relativePath: string,
    line?: number,
    afterSurfaceId?: string,
  ) => void
  openArchitectureFile: (
    ref: ScopedThreadRef,
    source: ArchitectureFileSource,
    relativePath: string,
    line?: number,
    afterSurfaceId?: string,
  ) => void
  openArchitectureSurface: (
    ref: ScopedThreadRef,
    surface: ArchitectureRightPanelSurface,
    afterSurfaceId?: string,
  ) => void
  openTerminal: (ref: ScopedThreadRef, terminalId: string) => void
  splitTerminal: (
    ref: ScopedThreadRef,
    surfaceId: string,
    terminalId: string,
    direction?: 'horizontal' | 'vertical',
  ) => void
  activateTerminal: (ref: ScopedThreadRef, surfaceId: string, terminalId: string) => void
  closeTerminal: (ref: ScopedThreadRef, surfaceId: string, terminalId: string) => void
  activateSurface: (ref: ScopedThreadRef, surfaceId: string) => void
  closeSurface: (ref: ScopedThreadRef, surfaceId: string) => void
  closeOtherSurfaces: (ref: ScopedThreadRef, surfaceId: string) => void
  closeSurfacesToRight: (ref: ScopedThreadRef, surfaceId: string) => void
  closeAllSurfaces: (ref: ScopedThreadRef) => void
  reconcileBrowserSurfaces: (ref: ScopedThreadRef, tabIds: readonly string[]) => void
  reconcileFileSurfaces: (ref: ScopedThreadRef, workspaceAvailable: boolean) => void
  show: (ref: ScopedThreadRef) => void
  close: (ref: ScopedThreadRef) => void
  toggleVisibility: (ref: ScopedThreadRef) => void
  toggle: (ref: ScopedThreadRef, kind: OpenRightPanelKind) => void
  removeThread: (ref: ScopedThreadRef) => void
}

const EMPTY_THREAD_STATE: ThreadRightPanelState = {
  isOpen: false,
  activeSurfaceId: null,
  surfaces: [],
}

const singletonSurface = (kind: SingletonRightPanelKind): RightPanelSurface =>
{
  switch (kind)
  {
    case 'diff':
      return { id: 'diff', kind }
    case 'files':
      return { id: 'files', kind }
    case 'plan':
      return { id: 'plan', kind }
    case 'workers':
      return { id: 'workers', kind }
    case 'explorer':
      return { id: 'explorer', kind, target: null }
    case 'repository-atlas-home':
      return { id: 'repository-atlas-home', kind }
  }
}

const browserSurface = (tabId: string | null): RightPanelSurface =>
  tabId
    ? { id: `browser:${tabId}`, kind: 'preview', resourceId: tabId }
    : { id: 'browser:new', kind: 'preview', resourceId: null }

const fileSurface = (
  relativePath: string,
  revealLine: number | null,
  revealRequestId: number,
): RightPanelSurface => ({
  id: `file:${relativePath}`,
  kind: 'file',
  relativePath,
  revealLine,
  revealRequestId,
})

const architectureFileSurface = (
  source: ArchitectureFileSource,
  relativePath: string,
  revealLine: number | null,
  revealRequestId: number,
): Extract<RightPanelSurface, { kind: 'file' }> => ({
  id: architectureFileSurfaceId(source, relativePath),
  kind: 'file',
  relativePath,
  revealLine,
  revealRequestId,
  source,
})

const terminalSurface = (terminalId: string): RightPanelSurface => ({
  id: `terminal:${terminalId}`,
  kind: 'terminal',
  resourceId: terminalId,
  terminalIds: [terminalId],
  activeTerminalId: terminalId,
})

const explorerSurface = (
  target: ExplorerTarget | null,
): Extract<RightPanelSurface, { kind: 'explorer' }> => ({
  id: 'explorer',
  kind: 'explorer',
  target,
})

const upsertExplorerSurface = (
  current: ThreadRightPanelState,
  target: ExplorerTarget | null,
): ThreadRightPanelState =>
{
  const surface = explorerSurface(target)
  const existing = current.surfaces.some((entry) => entry.id === surface.id)
  return {
    isOpen: true,
    activeSurfaceId: surface.id,
    surfaces: existing
      ? current.surfaces.map((entry) => (entry.id === surface.id ? surface : entry))
      : [...current.surfaces, surface],
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: ReadonlyArray<string>): boolean
{
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => actual.includes(key))
}

function decodeExplorerTarget(value: unknown): ExplorerTarget | null
{
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const target = value as Record<string, unknown>
  if (
    target.kind === 'plan' &&
    hasExactKeys(target, ['kind', 'planId']) &&
    typeof target.planId === 'string' &&
    target.planId.trim().length > 0
  )
  {
    return { kind: 'plan', planId: target.planId as OrchestrationProposedPlanId }
  }
  if (
    target.kind === 'orchestrate' &&
    hasExactKeys(target, ['kind', 'threadId', 'runId', 'revision']) &&
    typeof target.threadId === 'string' &&
    target.threadId.trim().length > 0 &&
    typeof target.runId === 'string' &&
    target.runId.trim().length > 0 &&
    typeof target.revision === 'number' &&
    Number.isSafeInteger(target.revision) &&
    target.revision >= 0
  )
  {
    return {
      kind: 'orchestrate',
      threadId: target.threadId as ThreadId,
      runId: target.runId as OrchestratePlanRunId,
      revision: target.revision,
    }
  }
  return null
}

const workersSurface = (run: string | null): Extract<RightPanelSurface, { kind: 'workers' }> => ({
  id: 'workers',
  kind: 'workers',
  ...(run === null ? {} : { run }),
})

// opening the workers panel without a run keeps whatever run is already
// pinned there, so existing openers behave exactly as before
const upsertWorkersSurface = (
  current: ThreadRightPanelState,
  run: string | null,
): ThreadRightPanelState =>
{
  const existing = current.surfaces.find((entry) => entry.id === 'workers')
  if (run === null && existing !== undefined)
  {
    return { ...current, isOpen: true, activeSurfaceId: existing.id }
  }
  const surface = workersSurface(run)
  return {
    isOpen: true,
    activeSurfaceId: surface.id,
    surfaces:
      existing === undefined
        ? [...current.surfaces, surface]
        : current.surfaces.map((entry) => (entry.id === surface.id ? surface : entry)),
  }
}

const upsertSurface = (
  current: ThreadRightPanelState,
  surface: RightPanelSurface,
  activate = true,
): ThreadRightPanelState => ({
  isOpen: true,
  surfaces: current.surfaces.some((entry) => entry.id === surface.id)
    ? current.surfaces
    : [...current.surfaces, surface],
  activeSurfaceId: activate ? surface.id : current.activeSurfaceId,
})

const insertSurfaceAfter = (
  surfaces: readonly RightPanelSurface[],
  surface: RightPanelSurface,
  afterSurfaceId: string | undefined,
): RightPanelSurface[] =>
{
  const sourceIndex =
    afterSurfaceId === undefined ? -1 : surfaces.findIndex((entry) => entry.id === afterSurfaceId)
  if (sourceIndex < 0) return [...surfaces, surface]
  return [...surfaces.slice(0, sourceIndex + 1), surface, ...surfaces.slice(sourceIndex + 1)]
}

const upsertArchitectureSurface = (
  current: ThreadRightPanelState,
  requestedSurface: ArchitectureRightPanelSurface,
  afterSurfaceId: string | undefined,
): ThreadRightPanelState =>
{
  const surface = decodeArchitectureRightPanelSurface(requestedSurface)
  if (surface === null) return current
  const existingIndex = current.surfaces.findIndex((entry) => entry.id === surface.id)
  if (existingIndex >= 0)
  {
    return {
      isOpen: true,
      activeSurfaceId: surface.id,
      surfaces: current.surfaces.map((entry, index) => (index === existingIndex ? surface : entry)),
    }
  }
  const sourceIndex =
    afterSurfaceId === undefined
      ? -1
      : current.surfaces.findIndex((entry) => entry.id === afterSurfaceId)
  if (sourceIndex < 0)
  {
    return {
      isOpen: true,
      activeSurfaceId: surface.id,
      surfaces: [...current.surfaces, surface],
    }
  }
  return {
    isOpen: true,
    activeSurfaceId: surface.id,
    surfaces: [
      ...current.surfaces.slice(0, sourceIndex + 1),
      surface,
      ...current.surfaces.slice(sourceIndex + 1),
    ],
  }
}

const updateThread = (
  byThreadKey: Record<string, ThreadRightPanelState>,
  threadKey: string,
  updater: (current: ThreadRightPanelState) => ThreadRightPanelState,
): Record<string, ThreadRightPanelState> =>
{
  const current = byThreadKey[threadKey] ?? EMPTY_THREAD_STATE
  const next = updater(current)
  if (!next.isOpen && next.activeSurfaceId === null && next.surfaces.length === 0)
  {
    if (!(threadKey in byThreadKey)) return byThreadKey
    const { [threadKey]: _removed, ...rest } = byThreadKey
    return rest
  }
  if (next === current) return byThreadKey
  return { ...byThreadKey, [threadKey]: next }
}

function normalizeRevealLine(line: number | undefined): number | null
{
  if (line === undefined || !Number.isFinite(line)) return null
  return Math.max(1, Math.trunc(line))
}

export function migratePersistedRightPanelState(
  persistedState: unknown,
  persistedVersion = 9,
): {
  byThreadKey: Record<string, ThreadRightPanelState>
}
{
  if (!persistedState || typeof persistedState !== 'object')
  {
    return { byThreadKey: {} }
  }
  const byThreadKey =
    'byThreadKey' in persistedState &&
    persistedState.byThreadKey &&
    typeof persistedState.byThreadKey === 'object'
      ? Object.fromEntries(
          Object.entries(persistedState.byThreadKey as Record<string, ThreadRightPanelState>).map(
            ([threadKey, threadState]) =>
              {
              const validThreadState =
                threadState && typeof threadState === 'object' ? threadState : null
              let repositoryAtlasHomeSeen = false
              let explorerSeen = false
              const architectureSurfaceIds = new Set<string>()
              const surfaces = Array.isArray(validThreadState?.surfaces)
                ? validThreadState.surfaces.flatMap<RightPanelSurface>((surface) =>
                  {
                    if (!surface || typeof surface !== 'object') return []
                    const persistedKind = (surface as { kind?: unknown }).kind
                    if (persistedKind === 'architecture-scope') return []
                    if (
                      persistedKind === 'architecture-impact' ||
                      persistedKind === 'repository-atlas'
                    )
                      {
                      const decoded = decodeArchitectureRightPanelSurface(surface)
                      if (decoded === null || architectureSurfaceIds.has(decoded.id)) return []
                      architectureSurfaceIds.add(decoded.id)
                      return [decoded]
                    }
                    if (
                      (surface as { kind?: unknown }).kind === 'atlas' ||
                      (surface as { kind?: unknown }).kind === 'advanced-atlas'
                    )
                      {
                      return []
                    }
                    if (surface.kind === 'repository-atlas-home')
                      {
                      if (
                        surface.id !== 'repository-atlas-home' ||
                        repositoryAtlasHomeSeen ||
                        Object.keys(surface).some((key) => key !== 'id' && key !== 'kind')
                      )
                        {
                        return []
                      }
                      repositoryAtlasHomeSeen = true
                      return [{ id: 'repository-atlas-home', kind: 'repository-atlas-home' }]
                    }
                    if (surface.kind === 'explorer')
                      {
                      if (surface.id !== 'explorer' || explorerSeen) return []
                      if (persistedVersion >= 10)
                        {
                        if (!hasExactKeys(surface, ['id', 'kind', 'target'])) return []
                        if (surface.target === null)
                          {
                          explorerSeen = true
                          return [explorerSurface(null)]
                        }
                        const target = decodeExplorerTarget(surface.target)
                        if (target === null) return []
                        explorerSeen = true
                        return [explorerSurface(target)]
                      }
                      if (!hasExactKeys(surface, ['id', 'kind', 'planId']))
                        {
                        if (!hasExactKeys(surface, ['id', 'kind'])) return []
                        explorerSeen = true
                        return [explorerSurface(null)]
                      }
                      const legacyPlanId = 'planId' in surface ? surface.planId : null
                      const planId =
                        typeof legacyPlanId === 'string' && legacyPlanId.trim().length > 0
                          ? (legacyPlanId as OrchestrationProposedPlanId)
                          : null
                      explorerSeen = true
                      return [explorerSurface(planId === null ? null : { kind: 'plan', planId })]
                    }
                    if (surface.kind === 'workers')
                      {
                      if (
                        surface.id !== 'workers' ||
                        (!hasExactKeys(surface, ['id', 'kind']) &&
                          !hasExactKeys(surface, ['id', 'kind', 'run']))
                      )
                        {
                        return []
                      }
                      const run =
                        'run' in surface &&
                        typeof surface.run === 'string' &&
                        surface.run.trim().length > 0
                          ? surface.run
                          : null
                      return [workersSurface(run)]
                    }
                    if (surface.kind === 'file')
                      {
                      if (
                        typeof surface.relativePath !== 'string' ||
                        surface.relativePath.length === 0
                      )
                        {
                        return []
                      }
                      const revealLine =
                        typeof surface.revealLine === 'number' &&
                        Number.isFinite(surface.revealLine)
                          ? Math.max(1, Math.trunc(surface.revealLine))
                          : null
                      const revealRequestId =
                        typeof surface.revealRequestId === 'number' &&
                        Number.isSafeInteger(surface.revealRequestId) &&
                        surface.revealRequestId >= 0
                          ? surface.revealRequestId
                          : 0
                      if ('source' in surface && surface.source !== undefined)
                        {
                        if (
                          persistedVersion < 11 ||
                          !isArchitectureRelativePath(surface.relativePath) ||
                          !hasExactKeys(surface, [
                            'id',
                            'kind',
                            'relativePath',
                            'revealLine',
                            'revealRequestId',
                            'source',
                          ])
                        )
                          {
                          return []
                        }
                        const source = decodeArchitectureFileSource(surface.source)
                        if (
                          source === null ||
                          surface.id !== architectureFileSurfaceId(source, surface.relativePath) ||
                          architectureSurfaceIds.has(surface.id)
                        )
                          {
                          return []
                        }
                        architectureSurfaceIds.add(surface.id)
                        return [
                          {
                            id: surface.id,
                            kind: 'file',
                            relativePath: surface.relativePath,
                            revealLine,
                            revealRequestId,
                            source,
                          },
                        ]
                      }
                      if (
                        surface.id !== `file:${surface.relativePath}` ||
                        (!hasExactKeys(surface, ['id', 'kind', 'relativePath']) &&
                          !hasExactKeys(surface, [
                            'id',
                            'kind',
                            'relativePath',
                            'revealLine',
                            'revealRequestId',
                          ]))
                      )
                        {
                        return []
                      }
                      return [
                        {
                          id: surface.id,
                          kind: 'file',
                          relativePath: surface.relativePath,
                          revealLine,
                          revealRequestId,
                        },
                      ]
                    }
                    if (
                      surface.kind === 'diff' ||
                      surface.kind === 'files' ||
                      surface.kind === 'plan'
                    )
                      {
                      if (surface.id !== surface.kind || !hasExactKeys(surface, ['id', 'kind']))
                        {
                        return []
                      }
                      return [surface]
                    }
                    if (surface.kind === 'preview')
                      {
                      if (!hasExactKeys(surface, ['id', 'kind', 'resourceId'])) return []
                      if (surface.resourceId === null)
                        {
                        return surface.id === 'browser:new' ? [browserSurface(null)] : []
                      }
                      if (
                        typeof surface.resourceId !== 'string' ||
                        surface.id !== `browser:${surface.resourceId}`
                      )
                        {
                        return []
                      }
                      return [browserSurface(surface.resourceId)]
                    }
                    if (surface.kind !== 'terminal') return []
                    if (
                      !('resourceId' in surface) ||
                      typeof surface.resourceId !== 'string' ||
                      surface.id !== `terminal:${surface.resourceId}`
                    )
                      {
                      return []
                    }
                    const terminalIds =
                      'terminalIds' in surface && Array.isArray(surface.terminalIds)
                        ? [
                            ...new Set(
                              surface.terminalIds.filter(
                                (terminalId): terminalId is string =>
                                  typeof terminalId === 'string',
                              ),
                            ),
                          ]
                        : [surface.resourceId]
                    const activeTerminalId =
                      'activeTerminalId' in surface &&
                      typeof surface.activeTerminalId === 'string' &&
                      terminalIds.includes(surface.activeTerminalId)
                        ? surface.activeTerminalId
                        : (terminalIds[0] ?? surface.resourceId)
                    return [
                      {
                        ...surface,
                        terminalIds: terminalIds.length > 0 ? terminalIds : [surface.resourceId],
                        activeTerminalId,
                      },
                    ]
                  })
                : []
              const activeSurfaceId = surfaces.some(
                (surface) => surface.id === validThreadState?.activeSurfaceId,
              )
                ? (validThreadState?.activeSurfaceId ?? null)
                : null
              const isOpen =
                typeof validThreadState?.isOpen === 'boolean'
                  ? validThreadState.isOpen
                  : activeSurfaceId !== null
              return [threadKey, { isOpen, surfaces, activeSurfaceId }]
            },
          ),
        )
      : {}
  return { byThreadKey }
}

export const useRightPanelStore = create<RightPanelStoreState>()(
  persist(
    (set) => ({
      byThreadKey: {},
      open: (ref, kind) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) =>
          {
            if (kind === 'preview')
            {
              const existing = current.surfaces.find((surface) => surface.kind === 'preview')
              return upsertSurface(current, existing ?? browserSurface(null))
            }
            if (kind === 'explorer')
            {
              return upsertExplorerSurface(current, null)
            }
            return upsertSurface(current, singletonSurface(kind))
          }),
        })),
      openBrowser: (ref, tabId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) =>
          {
            const surface = browserSurface(tabId)
            const withoutPlaceholder = tabId
              ? current.surfaces.filter((entry) => entry.id !== 'browser:new')
              : current.surfaces
            return upsertSurface({ ...current, surfaces: withoutPlaceholder }, surface)
          }),
        })),
      openExplorer: (ref, target) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) =>
            upsertExplorerSurface(current, target),
          ),
        })),
      openWorkers: (ref, run) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) =>
            upsertWorkersSurface(current, run !== undefined && run !== '' ? run : null),
          ),
        })),
      openFile: (ref, relativePath, line, afterSurfaceId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) =>
          {
            const withoutFileBrowser = current.surfaces.filter(
              (surface) => surface.kind !== 'files',
            )
            const surfaceId = `file:${relativePath}` as const
            const existing = withoutFileBrowser.find(
              (surface): surface is Extract<RightPanelSurface, { kind: 'file' }> =>
                surface.id === surfaceId && surface.kind === 'file',
            )
            const surface = fileSurface(
              relativePath,
              normalizeRevealLine(line),
              (existing?.revealRequestId ?? 0) + 1,
            )
            return {
              isOpen: true,
              activeSurfaceId: surface.id,
              surfaces: existing
                ? withoutFileBrowser.map((entry) => (entry.id === surface.id ? surface : entry))
                : insertSurfaceAfter(withoutFileBrowser, surface, afterSurfaceId),
            }
          }),
        })),
      openArchitectureFile: (ref, source, relativePath, line, afterSurfaceId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) =>
          {
            if (!isArchitectureRelativePath(relativePath)) return current
            const withoutFileBrowser = current.surfaces.filter(
              (surface) => surface.kind !== 'files',
            )
            const surfaceId = architectureFileSurfaceId(source, relativePath)
            const existing = withoutFileBrowser.find(
              (surface): surface is Extract<RightPanelSurface, { kind: 'file' }> =>
                surface.id === surfaceId && surface.kind === 'file',
            )
            const surface = architectureFileSurface(
              source,
              relativePath,
              normalizeRevealLine(line),
              (existing?.revealRequestId ?? 0) + 1,
            )
            return {
              isOpen: true,
              activeSurfaceId: surface.id,
              surfaces: existing
                ? withoutFileBrowser.map((entry) => (entry.id === surface.id ? surface : entry))
                : insertSurfaceAfter(withoutFileBrowser, surface, afterSurfaceId),
            }
          }),
        })),
      openArchitectureSurface: (ref, surface, afterSurfaceId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) =>
            upsertArchitectureSurface(current, surface, afterSurfaceId),
          ),
        })),
      openTerminal: (ref, terminalId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) =>
            upsertSurface(current, terminalSurface(terminalId)),
          ),
        })),
      splitTerminal: (ref, surfaceId, terminalId, direction = 'horizontal') =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => ({
            ...current,
            isOpen: true,
            activeSurfaceId: surfaceId,
            surfaces: current.surfaces.map((surface) =>
            {
              if (surface.id !== surfaceId || surface.kind !== 'terminal') return surface
              const { splitDirection: _splitDirection, ...baseSurface } = surface
              return {
                ...baseSurface,
                terminalIds: surface.terminalIds.includes(terminalId)
                  ? surface.terminalIds
                  : [...surface.terminalIds, terminalId],
                activeTerminalId: terminalId,
                ...(direction === 'vertical' ? { splitDirection: 'vertical' as const } : {}),
              }
            }),
          })),
        })),
      activateTerminal: (ref, surfaceId, terminalId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => ({
            ...current,
            activeSurfaceId: surfaceId,
            surfaces: current.surfaces.map((surface) =>
              surface.id === surfaceId &&
              surface.kind === 'terminal' &&
              surface.terminalIds.includes(terminalId)
                ? { ...surface, activeTerminalId: terminalId }
                : surface,
            ),
          })),
        })),
      closeTerminal: (ref, surfaceId, terminalId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) =>
          {
            const surface = current.surfaces.find(
              (entry) => entry.id === surfaceId && entry.kind === 'terminal',
            )
            if (!surface || surface.kind !== 'terminal') return current
            const terminalIds = surface.terminalIds.filter((id) => id !== terminalId)
            if (terminalIds.length === 0)
            {
              const index = current.surfaces.findIndex((entry) => entry.id === surfaceId)
              const surfaces = current.surfaces.filter((entry) => entry.id !== surfaceId)
              const fallback = surfaces[Math.min(index, surfaces.length - 1)] ?? null
              return {
                ...current,
                isOpen: surfaces.length > 0 && current.isOpen,
                surfaces,
                activeSurfaceId:
                  current.activeSurfaceId === surfaceId
                    ? (fallback?.id ?? null)
                    : current.activeSurfaceId,
              }
            }
            return {
              ...current,
              surfaces: current.surfaces.map((entry) =>
                entry.id === surfaceId && entry.kind === 'terminal'
                  ? {
                      ...entry,
                      terminalIds,
                      activeTerminalId:
                        entry.activeTerminalId === terminalId
                          ? (terminalIds.at(-1) ?? terminalIds[0]!)
                          : entry.activeTerminalId,
                    }
                  : entry,
              ),
            }
          }),
        })),
      activateSurface: (ref, surfaceId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) =>
            current.surfaces.some((surface) => surface.id === surfaceId)
              ? { ...current, isOpen: true, activeSurfaceId: surfaceId }
              : current,
          ),
        })),
      closeSurface: (ref, surfaceId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) =>
          {
            const index = current.surfaces.findIndex((surface) => surface.id === surfaceId)
            if (index < 0) return current
            const surfaces = current.surfaces.filter((surface) => surface.id !== surfaceId)
            if (current.activeSurfaceId !== surfaceId)
            {
              return { ...current, isOpen: surfaces.length > 0 && current.isOpen, surfaces }
            }
            const fallback = surfaces[Math.min(index, surfaces.length - 1)] ?? null
            return {
              ...current,
              isOpen: surfaces.length > 0 && current.isOpen,
              surfaces,
              activeSurfaceId: fallback?.id ?? null,
            }
          }),
        })),
      closeOtherSurfaces: (ref, surfaceId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) =>
          {
            const surface = current.surfaces.find((entry) => entry.id === surfaceId)
            if (!surface || current.surfaces.length === 1) return current
            return {
              ...current,
              isOpen: true,
              surfaces: [surface],
              activeSurfaceId: surface.id,
            }
          }),
        })),
      closeSurfacesToRight: (ref, surfaceId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) =>
          {
            const index = current.surfaces.findIndex((surface) => surface.id === surfaceId)
            if (index < 0 || index === current.surfaces.length - 1) return current
            const surfaces = current.surfaces.slice(0, index + 1)
            const activeStillExists = surfaces.some(
              (surface) => surface.id === current.activeSurfaceId,
            )
            return {
              ...current,
              surfaces,
              activeSurfaceId: activeStillExists ? current.activeSurfaceId : surfaceId,
            }
          }),
        })),
      closeAllSurfaces: (ref) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) =>
            current.surfaces.length === 0
              ? current
              : { ...current, isOpen: false, surfaces: [], activeSurfaceId: null },
          ),
        })),
      reconcileBrowserSurfaces: (ref, tabIds) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) =>
          {
            const validIds = new Set(tabIds.map((tabId) => `browser:${tabId}`))
            const nonBrowser = current.surfaces.filter((surface) => surface.kind !== 'preview')
            const existingBrowser = current.surfaces.filter(
              (surface): surface is Extract<RightPanelSurface, { kind: 'preview' }> =>
                surface.kind === 'preview' &&
                surface.id !== 'browser:new' &&
                validIds.has(surface.id),
            )
            const knownIds = new Set(existingBrowser.map((surface) => surface.id))
            const added = tabIds
              .filter((tabId) => !knownIds.has(`browser:${tabId}`))
              .map((tabId) => browserSurface(tabId))
            const surfaces = [...nonBrowser, ...existingBrowser, ...added]
            const activeStillExists = surfaces.some(
              (surface) => surface.id === current.activeSurfaceId,
            )
            const fallbackBrowser = surfaces.find((surface) => surface.kind === 'preview')
            return {
              ...current,
              surfaces,
              activeSurfaceId: activeStillExists
                ? current.activeSurfaceId
                : (fallbackBrowser?.id ?? surfaces[0]?.id ?? null),
            }
          }),
        })),
      reconcileFileSurfaces: (ref, workspaceAvailable) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) =>
          {
            if (workspaceAvailable) return current
            const surfaces = current.surfaces.filter(
              (surface) =>
                surface.kind !== 'files' &&
                (surface.kind !== 'file' || surface.source !== undefined) &&
                surface.kind !== 'explorer' &&
                surface.kind !== 'repository-atlas-home',
            )
            if (surfaces.length === current.surfaces.length) return current
            const activeStillExists = surfaces.some(
              (surface) => surface.id === current.activeSurfaceId,
            )
            return {
              ...current,
              isOpen: surfaces.length > 0 ? current.isOpen : false,
              surfaces,
              activeSurfaceId: activeStillExists
                ? current.activeSurfaceId
                : (surfaces.at(-1)?.id ?? null),
            }
          }),
        })),
      show: (ref) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) =>
            current.isOpen ? current : { ...current, isOpen: true },
          ),
        })),
      close: (ref) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) =>
            current.isOpen ? { ...current, isOpen: false } : current,
          ),
        })),
      toggleVisibility: (ref) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => ({
            ...current,
            isOpen: !current.isOpen,
          })),
        })),
      toggle: (ref, kind) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) =>
          {
            const active = current.surfaces.find(
              (surface) => surface.id === current.activeSurfaceId,
            )
            if (current.isOpen && active?.kind === kind)
            {
              return { ...current, isOpen: false }
            }
            if (kind === 'preview')
            {
              const existing = current.surfaces.find((surface) => surface.kind === 'preview')
              return upsertSurface(current, existing ?? browserSurface(null))
            }
            if (kind === 'explorer')
            {
              return upsertExplorerSurface(current, null)
            }
            return upsertSurface(current, singletonSurface(kind))
          }),
        })),
      removeThread: (ref) =>
        set((state) =>
        {
          const threadKey = scopedThreadKey(ref)
          if (!(threadKey in state.byThreadKey)) return state
          const { [threadKey]: _removed, ...rest } = state.byThreadKey
          return { byThreadKey: rest }
        }),
    }),
    {
      name: RIGHT_PANEL_STORAGE_KEY,
      version: RIGHT_PANEL_STORAGE_VERSION,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== 'undefined' ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ byThreadKey: state.byThreadKey }),
      migrate: migratePersistedRightPanelState,
    },
  ),
)

// opens (or focuses) the workers panel, optionally pinned to one run
export function openWorkersPanel(ref: ScopedThreadRef, run?: string): void
{
  useRightPanelStore.getState().openWorkers(ref, run)
}

export function selectThreadRightPanelState(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): ThreadRightPanelState
{
  if (!ref) return EMPTY_THREAD_STATE
  return byThreadKey[scopedThreadKey(ref)] ?? EMPTY_THREAD_STATE
}

export function selectActiveRightPanel(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): RightPanelKind | null
{
  const state = selectThreadRightPanelState(byThreadKey, ref)
  if (!state.isOpen) return null
  return state.surfaces.find((surface) => surface.id === state.activeSurfaceId)?.kind ?? null
}

export function selectActiveRightPanelSurface(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): RightPanelSurface | null
{
  const state = selectThreadRightPanelState(byThreadKey, ref)
  if (!state.isOpen) return null
  return state.surfaces.find((surface) => surface.id === state.activeSurfaceId) ?? null
}
