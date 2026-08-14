// apps/web/src/components/architecture/ArchitectureBoundedView.tsx
// renders one bounded architecture projection as an interactive graph

import type {
  ArchitectureProjectionCount,
  ArchitectureProjectionEdge,
  ArchitectureProjectionUnit,
} from '@t3tools/contracts'
import { ArchitectureCanvas } from './ArchitectureCanvas'
import { ArchitectureProjectionSummary } from './ArchitectureEvidenceList'

export interface ArchitectureBoundedViewProps
{
  readonly units: readonly ArchitectureProjectionUnit[]
  readonly unitCount: ArchitectureProjectionCount
  readonly edges: readonly ArchitectureProjectionEdge[]
  readonly edgeCount: ArchitectureProjectionCount
  readonly selectedUnitId: string | null
  readonly selectedEdge: ArchitectureProjectionEdge | null
  readonly graphLabel: string
  readonly onSelect: (unit: ArchitectureProjectionUnit, trigger: HTMLButtonElement) => void
  readonly onSelectEdge: (edge: ArchitectureProjectionEdge, trigger: HTMLButtonElement) => void
}

export function ArchitectureBoundedView(props: ArchitectureBoundedViewProps)
{
  const reportedInbound = props.units.reduce((total, unit) => total + unit.inbound, 0)
  const reportedOutbound = props.units.reduce((total, unit) => total + unit.outbound, 0)
  const hasReportedTraffic = reportedInbound > 0 || reportedOutbound > 0

  return (
    <section
      className="architecture-surface flex min-h-0 flex-1 flex-col"
      data-architecture-view="graph"
    >
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--architecture-border-soft)] bg-[var(--architecture-sunken)] px-3 py-1.5">
        <ArchitectureProjectionSummary count={props.unitCount} label="units" />
        <ArchitectureProjectionSummary count={props.edgeCount} label="dependencies" />
        {props.edges.length > 0 ? (
          <div
            aria-label="Graph legend"
            className="ms-auto hidden items-center gap-3 text-[10px] text-[var(--architecture-text-faint)] sm:flex"
            role="note"
          >
            <span className="flex items-center gap-1.5">
              <span className="w-4 border-t-2 border-[var(--architecture-edge)]" />
              imports
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-4 border-t-[3.5px] border-[var(--architecture-edge)]" />
              more imports
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-4 border-t-[2.5px] border-[var(--architecture-accent)]" />
              selected
            </span>
          </div>
        ) : hasReportedTraffic ? (
          <p className="ms-auto font-mono text-[10px] tabular-nums text-[var(--architecture-text-faint)]">
            No relationships in this view · visible units report {reportedInbound} incoming ·{' '}
            {reportedOutbound} outgoing
          </p>
        ) : null}
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <ArchitectureCanvas
          ariaLabel={props.graphLabel}
          edges={props.edges}
          onSelect={props.onSelect}
          onSelectEdge={props.onSelectEdge}
          selectedEdge={props.selectedEdge}
          selectedUnitId={props.selectedUnitId}
          units={props.units}
        />
      </div>
    </section>
  )
}
