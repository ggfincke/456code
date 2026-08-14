// apps/web/src/components/architecture/ArchitectureQueryState.tsx
// keeps bounded architecture loading and failure feedback local to its resource

import { CircleAlertIcon } from 'lucide-react'

import { Button } from '~/components/ui/button'
import { Spinner } from '~/components/ui/spinner'

export interface ArchitectureQueryStateProps
{
  readonly kind: 'loading' | 'error'
  readonly title: string
  readonly message: string
  readonly onRetry?: (() => void) | undefined
}

export function ArchitectureQueryState(props: ArchitectureQueryStateProps)
{
  return (
    <div
      aria-live="polite"
      className="flex min-h-48 flex-1 items-center justify-center px-6 py-10 text-center"
      data-architecture-query-state={props.kind}
    >
      <div className="max-w-sm">
        {props.kind === 'loading' ? (
          <Spinner className="mx-auto mb-3 size-5 text-muted-foreground" />
        ) : (
          <CircleAlertIcon className="mx-auto mb-3 size-5 text-destructive" />
        )}
        <h2 className="text-sm font-medium text-foreground">{props.title}</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{props.message}</p>
        {props.onRetry && (
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <Button size="sm" variant="outline" onClick={props.onRetry}>
              Retry
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
