// apps/web/src/components/chat/ProviderSwitchStatusPill.tsx
// renders in-flight provider switch status

import { type ProviderDriverKind } from '@t3tools/contracts'
import { LoaderCircleIcon } from 'lucide-react'

import {
  resolveProviderSwitchPillLabel,
  type ProviderSwitchPhase,
} from '../../providerSwitchPresentation'
import { ProviderInstanceIcon } from './ProviderInstanceIcon'

export function ProviderSwitchStatusPill({
  phase,
  targetLabel,
  targetDriverKind,
  targetDisplayName,
}: {
  readonly phase: ProviderSwitchPhase
  readonly targetLabel: string
  readonly targetDriverKind: ProviderDriverKind | null
  readonly targetDisplayName: string
})
{
  const label = resolveProviderSwitchPillLabel({ phase, targetLabel })

  return (
    <div
      aria-label={label}
      className="pointer-events-none mx-auto mb-2 flex w-fit max-w-full items-center gap-2 rounded-full border border-border/60 bg-card/95 px-3 py-1.5 text-foreground text-xs font-medium shadow-sm"
      role="status"
    >
      <LoaderCircleIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      {targetDriverKind ? (
        <ProviderInstanceIcon
          driverKind={targetDriverKind}
          displayName={targetDisplayName}
          className="size-3.5"
          iconClassName="size-3.5"
        />
      ) : null}
      <span className="truncate">{label}</span>
    </div>
  )
}
