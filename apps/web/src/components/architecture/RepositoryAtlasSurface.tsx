// apps/web/src/components/architecture/RepositoryAtlasSurface.tsx
// connects one exact repository generation to the native coarse architecture map

import type {
  ArchitectureProjectionEdge,
  ArchitectureProjectionUnit,
  ArchitectureScopeSelector,
  ArchitectureStandingSource,
  CartographerGetRepositoryMapResult,
  EnvironmentId,
  ProjectAtlasStatus,
  ThreadId,
} from '@t3tools/contracts'
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from '@t3tools/client-runtime/state/runtime'
import { ArrowUpRightIcon, BoxesIcon, RefreshCwIcon } from 'lucide-react'
import { useCallback, useEffect, useId, useState } from 'react'
import { create } from 'zustand'

import { Button } from '~/components/ui/button'
import { cn } from '~/lib/utils'
import { projectEnvironment } from '~/state/projects'
import { useEnvironmentQuery } from '~/state/query'
import { useAtomCommand } from '~/state/use-atom-command'

import {
  architectureScopeSurfaceId,
  repositoryAtlasSurfaceId,
  type ArchitectureScopeTarget,
  type RepositoryAtlasTarget,
} from './architectureResourceIdentity'
import { ArchitectureBoundedView } from './ArchitectureBoundedView'
import { ArchitectureDetailsDrawer } from './ArchitectureDetailsDrawer'
import { ArchitectureHealthRow } from './ArchitectureHealthRow'
import { ArchitectureQueryState } from './ArchitectureQueryState'
import {
  ArchitectureScopeSurface,
  type ArchitectureFileOpenTarget,
} from './ArchitectureScopeSurface'
import { ArchitectureZoomControl, type ArchitectureZoomLevel } from './ArchitectureZoomControl'
import { useArchitectureSurfaceNarrow } from './useArchitectureSurfaceNarrow'

export interface RepositoryAtlasSurfaceProps
{
  readonly environmentId: EnvironmentId
  readonly threadId: ThreadId
  readonly target: RepositoryAtlasTarget
  readonly narrow?: boolean | undefined
  readonly onOpenScope: (target: ArchitectureScopeTarget) => void
  readonly onOpenFile?: ((target: ArchitectureFileOpenTarget) => void) | undefined
  readonly onViewUpdated?: ((target: RepositoryAtlasTarget) => void) | undefined
}

export interface RepositoryAtlasViewProps
{
  readonly result: CartographerGetRepositoryMapResult
  readonly isReloading: boolean
  readonly status: ProjectAtlasStatus | null
  readonly hasStatusSettled: boolean
  readonly stale: boolean
  readonly updatedTarget?: RepositoryAtlasTarget | undefined
  readonly mapError?: string | null | undefined
  readonly statusError?: string | null | undefined
  readonly rebuildError?: string | null | undefined
  readonly isRebuilding: boolean
  readonly environmentId?: EnvironmentId | undefined
  readonly threadId?: ThreadId | undefined
  readonly narrow?: boolean | undefined
  readonly onOpenScope?: ((target: ArchitectureScopeTarget) => void) | undefined
  readonly onOpenFile?: ((target: ArchitectureFileOpenTarget) => void) | undefined
  readonly onViewUpdated?: ((target: RepositoryAtlasTarget) => void) | undefined
  readonly onReloadMap: () => void
  readonly onRetryStatus: () => void
  readonly onRebuild: () => void
}

function sameStandingSource(
  left: ArchitectureStandingSource,
  right: ArchitectureStandingSource,
): boolean
{
  return (
    left.kind === right.kind &&
    left.projectId === right.projectId &&
    left.generationId === right.generationId &&
    left.side === right.side &&
    left.graphDigest === right.graphDigest
  )
}

function SourceStatus(props: {
  readonly result: CartographerGetRepositoryMapResult
  readonly reloading: boolean
  readonly stale: boolean
})
{
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-[var(--architecture-text-faint)]">
      {props.stale ? (
        <span className="inline-flex items-center gap-1.5 text-[var(--architecture-orange)]">
          <span className="size-1.5 rounded-full bg-current" />
          Update available
        </span>
      ) : null}
      {props.result.dirty ? (
        <span className="inline-flex items-center gap-1.5 text-[var(--architecture-orange)]">
          <span className="size-1.5 rounded-full bg-current" />
          Dirty snapshot
        </span>
      ) : null}
      {props.reloading ? (
        <span className="inline-flex items-center gap-1.5 text-[var(--architecture-accent)]">
          <RefreshCwIcon className="size-3 animate-spin" />
          Reloading map
        </span>
      ) : null}
      <span title={props.result.source.generationId}>
        Generation {props.result.source.generationId.slice(0, 8)}
      </span>
      <span aria-hidden="true">·</span>
      <time dateTime={props.result.builtAt}>{props.result.builtAt}</time>
    </div>
  )
}

function LifecycleStatus(props: {
  readonly settled: boolean
  readonly status: ProjectAtlasStatus | null
})
{
  const status = props.status
  if (status === null && props.settled) return null
  if (status?.state === 'ready' && !status.freshness.dirty) return null
  const label =
    status === null
      ? 'Checking build status'
      : status.state === 'building'
        ? 'Building latest map'
        : status.state === 'error'
          ? 'Latest build failed'
          : status.state === 'ready'
            ? 'Source changed'
            : 'Waiting for first build'
  const tone =
    status?.state === 'error'
      ? 'text-[var(--architecture-red)]'
      : status?.state === 'ready'
        ? 'text-[var(--architecture-orange)]'
        : status?.state === 'building'
          ? 'text-[var(--architecture-blue)]'
          : 'text-[var(--architecture-text-faint)]'

  return (
    <div
      aria-live="polite"
      className={cn('flex min-w-0 items-center gap-1.5 font-mono text-[10px]', tone)}
      data-repository-atlas-lifecycle={status?.state ?? 'loading'}
    >
      <span className="size-1.5 rounded-full bg-current" />
      <span>{label}</span>
    </div>
  )
}

function RecoveryBanner(props: {
  readonly title: string
  readonly message: string
  readonly action: string
  readonly disabled?: boolean | undefined
  readonly onAction: () => void
})
{
  return (
    <div
      className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[color-mix(in_srgb,var(--architecture-red)_35%,var(--architecture-border-soft))] bg-[color-mix(in_srgb,var(--architecture-red)_7%,var(--architecture-surface))] px-3 py-2 text-xs text-[var(--architecture-text-muted)]"
      role="alert"
    >
      <span>
        <strong className="font-medium text-[var(--architecture-text)]">{props.title}</strong>{' '}
        {props.message}
      </span>
      <Button disabled={props.disabled} size="xs" variant="outline" onClick={props.onAction}>
        {props.action}
      </Button>
    </div>
  )
}

function RepositoryCounts(props: {
  readonly narrow: boolean
  readonly result: CartographerGetRepositoryMapResult
})
{
  const counts = [
    ['Files', props.result.counts.files],
    ['Imports', props.result.counts.imports],
    ['Systems', props.result.counts.systems],
    ['Blocks', props.result.counts.blocks],
  ] as const

  return (
    <dl
      aria-label="Repository architecture counts"
      className={cn(
        'min-h-10 shrink-0 items-center',
        props.narrow ? 'grid w-full grid-cols-4' : 'flex',
      )}
    >
      {counts.map(([label, value]) => (
        <div
          className={cn(
            'flex min-w-0 flex-1 items-baseline gap-2 border-e border-[var(--architecture-border-soft)] py-1.5',
            props.narrow ? 'px-2 first:ps-0 last:border-e-0 last:pe-0' : 'min-w-24 px-3 first:ps-0',
          )}
          key={label}
        >
          <dt className="font-mono text-[9px] font-bold uppercase tracking-[0.1em] text-[var(--architecture-text-faint)]">
            {label}
          </dt>
          <dd className="ms-auto font-mono text-[13px] font-semibold tabular-nums text-[var(--architecture-text)]">
            {value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

type RepositorySelection =
  | { readonly kind: 'unit'; readonly id: string }
  | { readonly kind: 'edge'; readonly from: string; readonly to: string }

type RepositoryStandingScopeTarget = {
  readonly source: ArchitectureStandingSource
  readonly scope: ArchitectureScopeSelector
}

interface RepositoryFlowState
{
  readonly level: ArchitectureZoomLevel
  readonly systemTarget: RepositoryStandingScopeTarget | null
  readonly fileHistory: readonly ArchitectureScopeTarget[]
  readonly focusRequestId: number
}

const INITIAL_REPOSITORY_FLOW: RepositoryFlowState = {
  level: 'systems',
  systemTarget: null,
  fileHistory: [],
  focusRequestId: 0,
}

interface RepositoryJourneyStore
{
  readonly bySurfaceId: Readonly<Record<string, RepositoryFlowState>>
  readonly update: (
    surfaceId: string,
    update: (current: RepositoryFlowState) => RepositoryFlowState,
  ) => void
}

// keep the drill journey while a sibling right-panel resource is active
const useRepositoryJourneyStore = create<RepositoryJourneyStore>((set) => ({
  bySurfaceId: {},
  update: (surfaceId, update) =>
    set((state) =>
    {
      const current = state.bySurfaceId[surfaceId] ?? INITIAL_REPOSITORY_FLOW
      const next = update(current)
      if (next === current) return state
      return { bySurfaceId: { ...state.bySurfaceId, [surfaceId]: next } }
    }),
}))

function EdgeDetails(props: {
  readonly edge: ArchitectureProjectionEdge
  readonly units: readonly ArchitectureProjectionUnit[]
})
{
  const from = props.units.find((unit) => unit.id === props.edge.from)
  const to = props.units.find((unit) => unit.id === props.edge.to)

  return (
    <dl className="divide-y divide-[var(--architecture-border-soft)] border-y border-[var(--architecture-border-soft)] bg-[color-mix(in_srgb,var(--architecture-surface)_72%,transparent)] text-sm">
      <div className="px-3 py-2">
        <dt className="font-mono text-[9px] font-bold uppercase tracking-[0.1em] text-[var(--architecture-text-faint)]">
          From
        </dt>
        <dd className="mt-1 min-w-0">
          <span className="block truncate font-medium text-[var(--architecture-text)]">
            {from?.label ?? props.edge.from}
          </span>
          {from ? (
            <code className="mt-0.5 block truncate text-xs text-[var(--architecture-text-faint)]">
              {props.edge.from}
            </code>
          ) : null}
        </dd>
      </div>
      <div className="px-3 py-2">
        <dt className="font-mono text-[9px] font-bold uppercase tracking-[0.1em] text-[var(--architecture-text-faint)]">
          To
        </dt>
        <dd className="mt-1 min-w-0">
          <span className="block truncate font-medium text-[var(--architecture-text)]">
            {to?.label ?? props.edge.to}
          </span>
          {to ? (
            <code className="mt-0.5 block truncate text-xs text-[var(--architecture-text-faint)]">
              {props.edge.to}
            </code>
          ) : null}
        </dd>
      </div>
      <div className="flex items-center justify-between gap-4 px-3 py-2">
        <dt className="text-[var(--architecture-text-muted)]">Imports</dt>
        <dd className="font-mono tabular-nums text-[var(--architecture-accent)]">
          {props.edge.weight}
        </dd>
      </div>
    </dl>
  )
}

function UnitDetails(props: {
  readonly unit: ArchitectureProjectionUnit
  readonly onOpen: () => void
})
{
  return (
    <>
      {props.unit.description ? (
        <p className="text-sm leading-relaxed text-[var(--architecture-text-muted)]">
          {props.unit.description}
        </p>
      ) : null}
      <dl className="divide-y divide-[var(--architecture-border-soft)] border-y border-[var(--architecture-border-soft)] bg-[color-mix(in_srgb,var(--architecture-surface)_72%,transparent)] text-sm">
        <div className="flex items-center justify-between gap-4 px-3 py-2">
          <dt className="text-[var(--architecture-text-muted)]">Files</dt>
          <dd className="font-mono tabular-nums text-[var(--architecture-accent)]">
            {props.unit.fileCount}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-4 px-3 py-2">
          <dt className="text-[var(--architecture-text-muted)]">Incoming</dt>
          <dd className="font-mono tabular-nums text-[var(--architecture-text)]">
            {props.unit.inbound}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-4 px-3 py-2">
          <dt className="text-[var(--architecture-text-muted)]">Outgoing</dt>
          <dd className="font-mono tabular-nums text-[var(--architecture-text)]">
            {props.unit.outbound}
          </dd>
        </div>
      </dl>
      <Button className="w-full" size="sm" onClick={props.onOpen}>
        Open {props.unit.level === 'systems' ? 'system' : 'block'}
        <ArrowUpRightIcon />
      </Button>
    </>
  )
}

export function RepositoryAtlasView(props: RepositoryAtlasViewProps)
{
  const [surfaceRef, measuredNarrow] = useArchitectureSurfaceNarrow(props.narrow)
  const [selection, setSelection] = useState<RepositorySelection | null>(null)
  const [returnFocus, setReturnFocus] = useState<HTMLButtonElement | null>(null)
  const [healthExpanded, setHealthExpanded] = useState(false)
  const healthDetailsId = useId()
  const surfaceId = repositoryAtlasSurfaceId(props.result.source)
  const flow = useRepositoryJourneyStore(
    (state) => state.bySurfaceId[surfaceId] ?? INITIAL_REPOSITORY_FLOW,
  )
  const updateFlow = useRepositoryJourneyStore((state) => state.update)
  const setFlow = useCallback(
    (
      update: RepositoryFlowState | ((current: RepositoryFlowState) => RepositoryFlowState),
    ): void =>
    {
      updateFlow(surfaceId, (current) => (typeof update === 'function' ? update(current) : update))
    },
    [surfaceId, updateFlow],
  )
  const selectedUnit =
    selection?.kind === 'unit'
      ? (props.result.units.find((unit) => unit.id === selection.id) ?? null)
      : null
  const selectedEdge =
    selection?.kind === 'edge'
      ? (props.result.edges.find(
          (edge) => edge.from === selection.from && edge.to === selection.to,
        ) ?? null)
      : null
  const selectedEdgeFrom = selectedEdge
    ? props.result.units.find((unit) => unit.id === selectedEdge.from)
    : undefined
  const selectedEdgeTo = selectedEdge
    ? props.result.units.find((unit) => unit.id === selectedEdge.to)
    : undefined
  const activeScopeTarget =
    flow.level === 'blocks'
      ? flow.systemTarget
      : flow.level === 'files'
        ? (flow.fileHistory.at(-1) ?? null)
        : null

  const closeDetails = useCallback((): void =>
  {
    setSelection(null)
  }, [])

  const openUnit = useCallback(
    (unit: ArchitectureProjectionUnit): void =>
    {
      if (unit.level !== 'systems' && unit.level !== 'blocks') return
      const target: RepositoryStandingScopeTarget = {
        source: props.result.source,
        scope: { level: unit.level, id: unit.id },
      }
      if (
        props.environmentId === undefined ||
        props.threadId === undefined ||
        props.onOpenFile === undefined
      )
      {
        props.onOpenScope?.(target)
        return
      }
      closeDetails()
      if (unit.level === 'systems')
      {
        setFlow({
          level: 'blocks',
          systemTarget: target,
          fileHistory: [],
          focusRequestId: flow.focusRequestId + 1,
        })
        return
      }
      setFlow((current) => ({
        level: 'files',
        systemTarget: current.systemTarget,
        fileHistory: [target],
        focusRequestId: current.focusRequestId + 1,
      }))
    },
    [
      closeDetails,
      props.environmentId,
      props.onOpenFile,
      props.onOpenScope,
      props.result.source,
      props.threadId,
      flow.focusRequestId,
      setFlow,
    ],
  )

  const openNestedScope = useCallback(
    (target: ArchitectureScopeTarget): void =>
    {
      const targetId = architectureScopeSurfaceId(target)
      setFlow((current) =>
      {
        const currentTarget = current.fileHistory.at(-1)
        const fileHistory =
          currentTarget !== undefined && architectureScopeSurfaceId(currentTarget) === targetId
            ? current.fileHistory
            : [...current.fileHistory, target]
        return {
          ...current,
          level: 'files',
          fileHistory,
          focusRequestId: current.focusRequestId + 1,
        }
      })
    },
    [setFlow],
  )

  const changeLevel = useCallback(
    (level: ArchitectureZoomLevel): void =>
    {
      closeDetails()
      setFlow((current) =>
      {
        if (level === 'blocks' && current.systemTarget === null) return current
        if (level === 'files' && current.fileHistory.length === 0) return current
        return { ...current, level, focusRequestId: current.focusRequestId + 1 }
      })
    },
    [closeDetails, setFlow],
  )

  const goBack = useCallback((): void =>
  {
    closeDetails()
    setFlow((current) =>
    {
      if (current.level === 'systems') return current
      if (current.level === 'blocks')
      {
        return { ...current, level: 'systems', focusRequestId: current.focusRequestId + 1 }
      }
      if (current.fileHistory.length > 1)
      {
        return {
          ...current,
          fileHistory: current.fileHistory.slice(0, -1),
          focusRequestId: current.focusRequestId + 1,
        }
      }
      return {
        ...current,
        level: current.systemTarget === null ? 'systems' : 'blocks',
        focusRequestId: current.focusRequestId + 1,
      }
    })
  }, [closeDetails, setFlow])

  const drawerTitle = selectedUnit
    ? selectedUnit.label
    : selectedEdge
      ? `${selectedEdgeFrom?.label ?? selectedEdge.from} → ${selectedEdgeTo?.label ?? selectedEdge.to}`
      : 'Architecture details'
  const drawerDescription = selectedUnit
    ? `${selectedUnit.level === 'systems' ? 'System' : 'Block'} · ${selectedUnit.fileCount} files`
    : selectedEdge
      ? `${selectedEdge.weight} ${selectedEdge.weight === 1 ? 'import' : 'imports'}`
      : undefined
  const embeddedLevelsAvailable =
    props.environmentId !== undefined &&
    props.threadId !== undefined &&
    props.onOpenFile !== undefined

  return (
    <div
      ref={surfaceRef}
      className="architecture-surface relative flex h-full min-h-0 flex-1 flex-col overflow-hidden"
      data-repository-atlas
    >
      <header className="shrink-0 border-b border-[var(--architecture-border-soft)] bg-[var(--architecture-surface)] px-4 py-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-[11px] border border-[var(--architecture-border)] bg-[var(--architecture-node-store)] text-[var(--architecture-accent)] shadow-[var(--architecture-shadow-node)]">
              <BoxesIcon className="size-4.5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <p className="font-mono text-[9px] font-bold uppercase tracking-[0.12em] text-[var(--architecture-text-faint)]">
                Repository map
              </p>
              <h1 className="mt-0.5 truncate text-[15px] font-semibold text-[var(--architecture-text)]">
                {props.result.repo.name}
              </h1>
              <p className="mt-0.5 truncate font-mono text-[10px] text-[var(--architecture-text-faint)]">
                {props.result.repo.scope}
                {props.result.repo.gitRef ? ` · ${props.result.repo.gitRef}` : ''}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {props.stale && props.updatedTarget && props.onViewUpdated ? (
              <Button size="sm" onClick={() => props.onViewUpdated?.(props.updatedTarget!)}>
                View updated map
              </Button>
            ) : null}
            <Button
              aria-label="Reload map"
              disabled={props.isReloading}
              size="icon-sm"
              title="Reload map"
              variant="ghost"
              onClick={props.onReloadMap}
            >
              <RefreshCwIcon className={props.isReloading ? 'animate-spin' : undefined} />
            </Button>
          </div>
        </div>
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <SourceStatus reloading={props.isReloading} result={props.result} stale={props.stale} />
          <LifecycleStatus settled={props.hasStatusSettled} status={props.status} />
        </div>
      </header>
      {props.mapError ? (
        <RecoveryBanner
          action="Reload map"
          message={`${props.mapError} The pinned last-good map remains visible.`}
          title="Map read failed."
          onAction={props.onReloadMap}
        />
      ) : null}
      {props.statusError ? (
        <RecoveryBanner
          action="Retry"
          message={`${props.statusError} Map browsing remains available.`}
          title="Build status unavailable."
          onAction={props.onRetryStatus}
        />
      ) : null}
      {(props.statusError === undefined || props.statusError === null) &&
      props.status?.state === 'error' ? (
        <RecoveryBanner
          action={props.isRebuilding ? 'Rebuilding…' : 'Rebuild'}
          disabled={props.isRebuilding}
          message={`${
            props.rebuildError ??
            props.status.lastBuildError ??
            'The latest repository map could not be built.'
          } The pinned last-good map remains visible.`}
          title={props.rebuildError ? 'Rebuild could not start.' : 'Latest build failed.'}
          onAction={props.onRebuild}
        />
      ) : null}
      <div
        className={cn(
          'shrink-0 border-b border-[var(--architecture-border-soft)] bg-[var(--architecture-surface)] px-3',
          measuredNarrow ? 'flex flex-col' : 'flex min-h-10 flex-wrap items-stretch',
        )}
      >
        <RepositoryCounts narrow={measuredNarrow} result={props.result} />
        <div
          className={cn(
            'flex flex-1',
            measuredNarrow ? 'border-t border-[var(--architecture-border-soft)]' : 'justify-end',
          )}
        >
          <button
            aria-controls={healthDetailsId}
            aria-expanded={healthExpanded}
            className={cn(
              'shrink-0 text-[10px] font-medium text-[var(--architecture-text-muted)] outline-none hover:bg-[var(--architecture-hover)] hover:text-[var(--architecture-text)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--architecture-accent)]',
              measuredNarrow
                ? 'w-full py-1.5 text-start'
                : 'border-s border-[var(--architecture-border-soft)] px-3',
            )}
            type="button"
            onClick={() => setHealthExpanded((current) => !current)}
          >
            Health · {props.result.health.cycles} cycles · {props.result.health.orphans} orphans
          </button>
        </div>
      </div>
      {healthExpanded ? (
        <div id={healthDetailsId}>
          <ArchitectureHealthRow health={props.result.health} />
        </div>
      ) : null}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <ArchitectureZoomControl
          backLabel={
            flow.level === 'files'
              ? flow.fileHistory.length > 1
                ? 'Back to previous scope'
                : 'Back to Blocks'
              : 'Back to Systems'
          }
          blocksAvailable={embeddedLevelsAvailable && flow.systemTarget !== null}
          filesAvailable={embeddedLevelsAvailable && flow.fileHistory.length > 0}
          focusRequestId={flow.focusRequestId}
          level={flow.level}
          narrow={measuredNarrow}
          onBack={goBack}
          onLevelChange={changeLevel}
        />
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {activeScopeTarget && embeddedLevelsAvailable ? (
            <ArchitectureScopeSurface
              embedded
              environmentId={props.environmentId}
              filesOnly={flow.level === 'files'}
              narrow={measuredNarrow}
              target={activeScopeTarget}
              threadId={props.threadId}
              onOpenFile={props.onOpenFile}
              onInspectScope={(target) =>
                {
                if (target.scope.level !== 'blocks') return
                setFlow((current) => ({ ...current, fileHistory: [target] }))
              }}
              onOpenScope={openNestedScope}
            />
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex min-h-9 shrink-0 items-center justify-between gap-3 border-b border-[var(--architecture-border-soft)] bg-[var(--architecture-sunken)] px-3 py-1.5 font-mono text-[10px] text-[var(--architecture-text-faint)]">
                <span>{props.result.level === 'systems' ? 'Systems map' : 'Blocks map'}</span>
                <span>
                  {props.result.systemSource === 'authored'
                    ? 'Authored structure'
                    : 'Inferred fallback'}
                </span>
              </div>
              <ArchitectureBoundedView
                edgeCount={props.result.edgeCount}
                edges={props.result.edges}
                graphLabel={`${props.result.repo.name} ${props.result.level} dependency graph`}
                onSelect={(unit, trigger) =>
                  {
                  setSelection({ kind: 'unit', id: unit.id })
                  setReturnFocus(trigger)
                  if (unit.level === 'systems')
                    {
                    const target: RepositoryStandingScopeTarget = {
                      source: props.result.source,
                      scope: { level: 'systems', id: unit.id },
                    }
                    setFlow((current) => ({
                      ...current,
                      systemTarget: target,
                      fileHistory: [],
                    }))
                  }
                }}
                onSelectEdge={(edge, trigger) =>
                  {
                  setSelection({ kind: 'edge', from: edge.from, to: edge.to })
                  setReturnFocus(trigger)
                }}
                selectedEdge={selectedEdge}
                selectedUnitId={selectedUnit?.id ?? null}
                unitCount={props.result.unitCount}
                units={props.result.units}
              />
            </div>
          )}
        </div>
      </div>
      <ArchitectureDetailsDrawer
        description={drawerDescription}
        narrow={measuredNarrow}
        open={flow.level === 'systems' && (selectedUnit !== null || selectedEdge !== null)}
        returnFocus={returnFocus}
        title={drawerTitle}
        onClose={closeDetails}
      >
        {selectedUnit ? (
          <UnitDetails unit={selectedUnit} onOpen={() => openUnit(selectedUnit)} />
        ) : null}
        {selectedEdge ? <EdgeDetails edge={selectedEdge} units={props.result.units} /> : null}
      </ArchitectureDetailsDrawer>
    </div>
  )
}

function RepositoryAtlasQuery(props: RepositoryAtlasSurfaceProps)
{
  const rebuildProjectAtlas = useAtomCommand(projectEnvironment.rebuildProjectAtlas, {
    reportFailure: false,
  })
  const [pinnedResult, setPinnedResult] = useState<CartographerGetRepositoryMapResult | null>(null)
  const [isRebuilding, setIsRebuilding] = useState(false)
  const [rebuildError, setRebuildError] = useState<string | null>(null)
  const mapQuery = useEnvironmentQuery(
    projectEnvironment.getRepositoryMap({
      environmentId: props.environmentId,
      input: {
        threadId: props.threadId,
        projectId: props.target.projectId,
        generationId: props.target.generationId,
      },
    }),
  )
  const atlasStatusQuery = useEnvironmentQuery(
    projectEnvironment.projectAtlasStatus({
      environmentId: props.environmentId,
      input: { projectId: props.target.projectId },
    }),
  )
  const resultMatches =
    mapQuery.data !== null && sameStandingSource(mapQuery.data.source, props.target)
  const exactResult = resultMatches ? mapQuery.data : null
  useEffect(() =>
  {
    if (exactResult !== null) setPinnedResult(exactResult)
  }, [exactResult])
  const result = exactResult ?? pinnedResult
  const sourceError =
    mapQuery.data !== null && !resultMatches
      ? 'The server returned a different Repository Atlas generation. Reopen the requested generation.'
      : null
  const statusSource = atlasStatusQuery.data?.source ?? null
  const updatedTarget =
    statusSource !== null && !sameStandingSource(statusSource, props.target)
      ? statusSource
      : undefined
  const mapError = sourceError ?? mapQuery.error

  const rebuild = useCallback((): void =>
  {
    if (isRebuilding) return
    setIsRebuilding(true)
    setRebuildError(null)
    void rebuildProjectAtlas({
      environmentId: props.environmentId,
      input: { projectId: props.target.projectId },
    }).then((rebuildResult) =>
    {
      setIsRebuilding(false)
      if (rebuildResult._tag === 'Success')
      {
        atlasStatusQuery.refresh()
        return
      }
      if (isAtomCommandInterrupted(rebuildResult)) return
      const failure = squashAtomCommandFailure(rebuildResult)
      setRebuildError(
        failure instanceof Error && failure.message.trim().length > 0
          ? failure.message
          : 'The repository map rebuild could not be started.',
      )
    })
  }, [
    atlasStatusQuery,
    isRebuilding,
    props.environmentId,
    props.target.projectId,
    rebuildProjectAtlas,
  ])

  if (result === null)
  {
    const mapState =
      mapError !== null ? (
        <ArchitectureQueryState
          kind="error"
          message={mapError}
          onRetry={mapQuery.refresh}
          title="Repository Atlas unavailable"
        />
      ) : (
        <ArchitectureQueryState
          kind="loading"
          message={
            atlasStatusQuery.data?.state === 'building'
              ? 'Building the first sealed repository map.'
              : 'Loading the sealed repository map.'
          }
          title={
            atlasStatusQuery.data?.state === 'building'
              ? 'Building Repository Atlas'
              : 'Loading Repository Atlas'
          }
        />
      )
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col" data-repository-atlas>
        {atlasStatusQuery.data !== null || !atlasStatusQuery.hasSettled ? (
          <div className="shrink-0 border-b px-3 py-2">
            <LifecycleStatus settled={atlasStatusQuery.hasSettled} status={atlasStatusQuery.data} />
          </div>
        ) : null}
        {atlasStatusQuery.error ? (
          <RecoveryBanner
            action="Retry"
            message={atlasStatusQuery.error}
            title="Build status unavailable."
            onAction={atlasStatusQuery.refresh}
          />
        ) : null}
        {atlasStatusQuery.error === null && atlasStatusQuery.data?.state === 'error' ? (
          <RecoveryBanner
            action={isRebuilding ? 'Rebuilding…' : 'Rebuild'}
            disabled={isRebuilding}
            message={
              rebuildError ??
              atlasStatusQuery.data.lastBuildError ??
              'The repository map could not be built.'
            }
            title={rebuildError ? 'Rebuild could not start.' : 'Latest build failed.'}
            onAction={rebuild}
          />
        ) : null}
        {mapState}
      </div>
    )
  }

  return (
    <RepositoryAtlasView
      environmentId={props.environmentId}
      isRebuilding={isRebuilding}
      isReloading={mapQuery.isPending}
      hasStatusSettled={atlasStatusQuery.hasSettled}
      mapError={mapError}
      narrow={props.narrow}
      onOpenFile={props.onOpenFile}
      onOpenScope={props.onOpenScope}
      onRebuild={rebuild}
      onReloadMap={() =>
      {
        mapQuery.refresh()
      }}
      onRetryStatus={atlasStatusQuery.refresh}
      onViewUpdated={props.onViewUpdated}
      rebuildError={rebuildError}
      result={result}
      stale={updatedTarget !== undefined}
      status={atlasStatusQuery.data}
      statusError={atlasStatusQuery.error}
      threadId={props.threadId}
      updatedTarget={updatedTarget}
    />
  )
}

export function RepositoryAtlasSurface(props: RepositoryAtlasSurfaceProps)
{
  const resourceIdentity = repositoryAtlasSurfaceId(props.target)
  return (
    <RepositoryAtlasQuery
      key={JSON.stringify([props.environmentId, resourceIdentity])}
      {...props}
    />
  )
}
