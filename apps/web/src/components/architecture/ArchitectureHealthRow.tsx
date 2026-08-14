// apps/web/src/components/architecture/ArchitectureHealthRow.tsx
// renders exact repository health totals in one compact native row

import type { CartographerGetRepositoryMapResult } from '@t3tools/contracts'
import { CircleAlertIcon, CircleCheckIcon } from 'lucide-react'

export interface ArchitectureHealthRowProps
{
  readonly health: CartographerGetRepositoryMapResult['health']
}

function HealthFact(props: { readonly label: string; readonly value: string | number })
{
  return (
    <div className="flex shrink-0 items-baseline gap-1.5">
      <dt className="text-[var(--architecture-text-muted)]">{props.label}</dt>
      <dd className="font-mono font-semibold tabular-nums text-[var(--architecture-text)]">
        {props.value}
      </dd>
    </div>
  )
}

export function ArchitectureHealthRow(props: ArchitectureHealthRowProps)
{
  const issueCount =
    props.health.cycles +
    props.health.orphans +
    props.health.violatingImports +
    props.health.violatedRules

  return (
    <section
      aria-label="Repository health"
      className="flex min-h-10 shrink-0 items-center gap-4 overflow-x-auto border-b border-[var(--architecture-border-soft)] bg-[var(--architecture-sunken)] px-3 py-2 text-[11px]"
      data-architecture-health
    >
      <div className="flex shrink-0 items-center gap-1.5 font-medium text-[var(--architecture-text)]">
        {issueCount === 0 ? (
          <CircleCheckIcon className="size-3.5 text-[var(--architecture-green)]" />
        ) : (
          <CircleAlertIcon className="size-3.5 text-[var(--architecture-amber)]" />
        )}
        Health
      </div>
      <dl className="flex items-center gap-4">
        <HealthFact label="Cycles" value={props.health.cycles} />
        <HealthFact label="Orphans" value={props.health.orphans} />
        <HealthFact
          label="Rules"
          value={`${props.health.violatedRules}/${props.health.ruleTotal}`}
        />
        <HealthFact label="Violating imports" value={props.health.violatingImports} />
      </dl>
    </section>
  )
}
