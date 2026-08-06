// apps/web/src/components/settings/connections/endpoints.tsx
// advertised endpoint rows and network-access summary for connections settings

import type { AdvertisedEndpoint } from '@t3tools/contracts'
import { type ReactNode } from 'react'
import { memo } from 'react'

import { Button } from '../../ui/button'
import { endpointRowClassName, type AccessSectionPresentation } from './accessPresentation'
import { isTailscaleHttpsEndpoint } from './endpointUrls'

type AdvertisedEndpointListRowProps = {
  endpoint: AdvertisedEndpoint
  isDefault: boolean
  presentation?: AccessSectionPresentation
  onSetDefault: (endpoint: AdvertisedEndpoint) => void
  onSetupTailscaleServe: (endpoint: AdvertisedEndpoint) => void
  onDisableTailscaleServe: (endpoint: AdvertisedEndpoint) => void
  isUpdatingTailscaleServe: boolean
}

export const AdvertisedEndpointListRow = memo(function AdvertisedEndpointListRow({
  endpoint,
  isDefault,
  presentation = 'current',
  onSetDefault,
  onSetupTailscaleServe,
  onDisableTailscaleServe,
  isUpdatingTailscaleServe,
}: AdvertisedEndpointListRowProps)
{
  const isAvailable = endpoint.status === 'available'
  const needsTailscaleSetup = isTailscaleHttpsEndpoint(endpoint) && endpoint.status !== 'available'
  const canDisableTailscaleServe =
    isTailscaleHttpsEndpoint(endpoint) && endpoint.status === 'available'
  const shouldShowEndpointUrl = !needsTailscaleSetup
  const isEndpointRail = presentation === 'endpoint-rail'
  return (
    <div className={endpointRowClassName(presentation, isAvailable)}>
      {isEndpointRail && isDefault ? (
        <span className="absolute inset-y-2 left-0 w-1 rounded-r-full bg-primary" aria-hidden />
      ) : null}
      <div className="flex min-h-6 min-w-0 flex-col gap-2 sm:-my-0.5 sm:flex-row sm:items-center">
        <div className="flex min-w-0 items-baseline gap-3">
          <h3 className="shrink-0 text-sm leading-5 font-medium text-foreground">
            {endpoint.label}
          </h3>
          {shouldShowEndpointUrl ? (
            <p
              className="min-w-0 truncate text-xs leading-5 text-muted-foreground"
              title={endpoint.httpBaseUrl}
            >
              {endpoint.httpBaseUrl}
            </p>
          ) : null}
          {!isAvailable ? (
            <span className="shrink-0 rounded-md border border-border/70 px-1 py-0.5 text-[10px] text-muted-foreground">
              Setup required
            </span>
          ) : null}
        </div>
        <div className="ml-auto flex min-h-6 shrink-0 items-center justify-end gap-2">
          {isDefault ? (
            <span className="rounded-md border border-primary/30 bg-primary/10 px-1 py-0.5 text-[10px] text-primary">
              Default
            </span>
          ) : null}
          {needsTailscaleSetup ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => onSetupTailscaleServe(endpoint)}
              disabled={isUpdatingTailscaleServe}
            >
              {isUpdatingTailscaleServe ? 'Restarting…' : 'Setup'}
            </Button>
          ) : null}
          {canDisableTailscaleServe ? (
            <Button
              size="xs"
              variant="destructive-outline"
              onClick={() => onDisableTailscaleServe(endpoint)}
              disabled={isUpdatingTailscaleServe}
            >
              {isUpdatingTailscaleServe ? 'Restarting…' : 'Disable'}
            </Button>
          ) : null}
          {!needsTailscaleSetup && !isDefault ? (
            <Button size="xs" variant="outline" onClick={() => onSetDefault(endpoint)}>
              Set as default
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
})

export function NetworkAccessDescription({
  endpoint,
  hiddenEndpointCount,
  expanded,
  onToggleExpanded,
  fallback,
}: {
  endpoint: AdvertisedEndpoint | null
  hiddenEndpointCount: number
  expanded: boolean
  onToggleExpanded: () => void
  fallback: ReactNode
})
{
  if (!endpoint)
  {
    return fallback
  }

  const summary = (
    <>
      <span className="min-w-0 truncate">{endpoint.httpBaseUrl}</span>
      {hiddenEndpointCount > 0 ? (
        <span className="shrink-0 text-xs font-medium">
          {expanded ? 'Hide' : `+${hiddenEndpointCount}`}
        </span>
      ) : null}
    </>
  )

  return (
    <span className="inline-flex min-w-0 max-w-full items-baseline gap-1">
      <span className="shrink-0">Reachable at</span>
      {hiddenEndpointCount > 0 ? (
        <button
          type="button"
          className="inline-flex min-w-0 max-w-full items-baseline gap-2 border-b border-dotted border-muted-foreground/60 text-left text-muted-foreground underline-offset-4 hover:border-foreground hover:text-foreground"
          onClick={onToggleExpanded}
          aria-expanded={expanded}
        >
          {summary}
        </button>
      ) : (
        <span className="inline-flex min-w-0 max-w-full items-baseline gap-2">{summary}</span>
      )}
    </span>
  )
}
