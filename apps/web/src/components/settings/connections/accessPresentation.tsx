// apps/web/src/components/settings/connections/accessPresentation.tsx
// shared access-scope and endpoint row presentation for connections settings

import type { AuthEnvironmentScope } from '@t3tools/contracts'
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthReviewWriteScope,
  AuthTerminalOperateScope,
} from '@t3tools/contracts'

import { cn } from '../../../lib/utils'
import { Popover, PopoverPopup, PopoverTrigger } from '../../ui/popover'
import { ITEM_ROW_CLASSNAME } from '../itemRows'

const accessTimestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})

export function formatAccessTimestamp(value: string): string
{
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime()))
  {
    return value
  }
  return accessTimestampFormatter.format(parsed)
}

export const PAIRING_SCOPE_OPTIONS: ReadonlyArray<{
  readonly scope: AuthEnvironmentScope
  readonly title: string
  readonly description: string
}> = [
  {
    scope: AuthOrchestrationReadScope,
    title: 'View environment',
    description: 'Read threads, status, diffs, and configuration.',
  },
  {
    scope: AuthOrchestrationOperateScope,
    title: 'Operate tasks',
    description: 'Start tasks and perform changes in the environment.',
  },
  {
    scope: AuthTerminalOperateScope,
    title: 'Use terminals',
    description: 'Create terminals and send input to running shells.',
  },
  {
    scope: AuthReviewWriteScope,
    title: 'Write reviews',
    description: 'Create comments while reviewing changes.',
  },
  {
    scope: AuthAccessReadScope,
    title: 'View access',
    description: 'Inspect pairing links and authorized clients.',
  },
  {
    scope: AuthAccessWriteScope,
    title: 'Manage access',
    description: 'Issue and revoke credentials for other clients.',
  },
]

export function AccessScopeSummary({
  scopes,
  label,
}: {
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>
  readonly label: string
})
{
  const scopeCountLabel = `${scopes.length} ${scopes.length === 1 ? 'scope' : 'scopes'}`

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={250}
        closeDelay={100}
        render={
          <button
            type="button"
            aria-label={`${label}: show ${scopeCountLabel}`}
            className="cursor-help underline decoration-border underline-offset-2 outline-hidden hover:text-foreground focus-visible:text-foreground"
          />
        }
      >
        {scopeCountLabel}
      </PopoverTrigger>
      <PopoverPopup
        side="top"
        align="start"
        tooltipStyle
        className="w-max max-w-80 whitespace-normal"
      >
        <p className="mb-1 font-medium">Granted scopes</p>
        <div className="flex flex-col gap-0.5">
          {scopes.map((scope) => (
            <code key={scope} className="font-mono text-foreground/85">
              {scope}
            </code>
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  )
}

const ENDPOINT_ROW_CLASSNAME = 'rounded-xl px-3 py-2.5 sm:px-4'

export type AccessSectionPresentation = 'current' | 'endpoint-rail'

export function accessRowClassName(_presentation: AccessSectionPresentation)
{
  return ITEM_ROW_CLASSNAME
}

export function endpointRowClassName(
  presentation: AccessSectionPresentation,
  isAvailable: boolean,
)
{
  if (presentation === 'endpoint-rail')
  {
    return cn('relative rounded-xl px-3 py-3 sm:px-4', !isAvailable && 'bg-muted/15')
  }

  return cn(ENDPOINT_ROW_CLASSNAME, !isAvailable && 'bg-muted/24')
}
