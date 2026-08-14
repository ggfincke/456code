// apps/web/src/components/architecture/ArchitectureEvidenceList.tsx
// presents bounded architecture units and dependencies as a keyboard-first list

import type {
  ArchitectureProjectionCount,
  ArchitectureProjectionEdge,
  ArchitectureProjectionUnit,
} from '@t3tools/contracts'

import { cn } from '~/lib/utils'

export interface ArchitectureEvidenceListProps
{
  readonly units: readonly ArchitectureProjectionUnit[]
  readonly unitCount: ArchitectureProjectionCount
  readonly edges: readonly ArchitectureProjectionEdge[]
  readonly edgeCount: ArchitectureProjectionCount
  readonly selectedUnitId: string | null
  readonly onSelect: (unit: ArchitectureProjectionUnit, trigger: HTMLButtonElement) => void
  readonly onOpen?: ((unit: ArchitectureProjectionUnit) => void) | undefined
}

export function ArchitectureProjectionSummary(props: {
  readonly label: string
  readonly count: ArchitectureProjectionCount
})
{
  return (
    <span className="text-xs tabular-nums text-muted-foreground">
      {props.count.returned} returned of {props.count.indexed} indexed {props.label}
      {props.count.omitted > 0 ? ` · ${props.count.omitted} not indexed` : ''}
    </span>
  )
}

export function ArchitectureEvidenceList(props: ArchitectureEvidenceListProps)
{
  const unitsById = new Map(props.units.map((unit) => [unit.id, unit] as const))

  return (
    <div className="divide-y divide-border" data-architecture-evidence-list>
      <section aria-labelledby="architecture-units-list-title">
        <div className="flex items-center justify-between gap-3 px-3 py-2">
          <h3
            className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
            id="architecture-units-list-title"
          >
            Units
          </h3>
          <ArchitectureProjectionSummary count={props.unitCount} label="units" />
        </div>
        {props.units.length === 0 ? (
          <p className="px-3 pb-4 text-sm text-muted-foreground">No units on this page.</p>
        ) : (
          <ul className="divide-y divide-border/70">
            {props.units.map((unit) =>
              {
              const selected = props.selectedUnitId === unit.id
              return (
                <li key={unit.id}>
                  <button
                    aria-pressed={selected}
                    className={cn(
                      'flex w-full items-center justify-between gap-4 px-3 py-2.5 text-left outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                      selected && 'bg-accent',
                    )}
                    data-architecture-unit-id={unit.id}
                    type="button"
                    onClick={(event) => props.onSelect(unit, event.currentTarget)}
                    onDoubleClick={() => props.onOpen?.(unit)}
                    onKeyDown={(event) =>
                      {
                      if (event.key !== 'Enter' || props.onOpen === undefined) return
                      event.preventDefault()
                      props.onOpen(unit)
                    }}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-foreground">
                        {unit.label}
                      </span>
                      {unit.description ? (
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                          {unit.description}
                        </span>
                      ) : null}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {unit.fileCount} {unit.fileCount === 1 ? 'file' : 'files'}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </section>
      <section aria-labelledby="architecture-edges-list-title">
        <div className="flex items-center justify-between gap-3 px-3 py-2">
          <h3
            className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
            id="architecture-edges-list-title"
          >
            Dependencies
          </h3>
          <ArchitectureProjectionSummary count={props.edgeCount} label="dependencies" />
        </div>
        {props.edges.length === 0 ? (
          <p className="px-3 pb-4 text-sm text-muted-foreground">
            No dependencies connect the returned units.
          </p>
        ) : (
          <ul className="divide-y divide-border/70">
            {props.edges.map((edge) => (
              <li
                className="flex min-w-0 items-center gap-2 px-3 py-2 font-mono text-xs"
                key={`${edge.from}:${edge.to}`}
              >
                <span className="min-w-0 flex-1 truncate">
                  {unitsById.get(edge.from)?.label ?? edge.from}
                </span>
                <span aria-hidden="true" className="text-muted-foreground">
                  -&gt;
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {unitsById.get(edge.to)?.label ?? edge.to}
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">×{edge.weight}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {(props.unitCount.returned < props.unitCount.indexed ||
        props.edgeCount.returned < props.edgeCount.indexed ||
        props.unitCount.omitted > 0 ||
        props.edgeCount.omitted > 0) && (
        <p className="bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          This response returns {props.unitCount.returned} of {props.unitCount.indexed} indexed
          units and {props.edgeCount.returned} of {props.edgeCount.indexed} indexed dependencies.
          {props.unitCount.omitted > 0 || props.edgeCount.omitted > 0
            ? ` ${props.unitCount.omitted} units and ${props.edgeCount.omitted} dependencies were not indexed.`
            : ''}
        </p>
      )}
    </div>
  )
}
