// apps/web/src/components/architecture/ArchitectureGraphSelectionDetails.tsx
// presents shared projection node and edge facts with resource-specific action slots

import type {
  ArchitectureGraphProjectionEdge,
  ArchitectureGraphProjectionNode,
  ArchitectureStandingAnchor,
} from '@t3tools/contracts'
import type { ReactNode } from 'react'

import { Badge } from '~/components/ui/badge'

type ArchitectureGraphSelection =
  | { readonly kind: 'node'; readonly node: ArchitectureGraphProjectionNode }
  | { readonly kind: 'edge'; readonly edge: ArchitectureGraphProjectionEdge }

export interface ArchitectureGraphSelectionDetailsProps
{
  readonly selection: ArchitectureGraphSelection
  readonly anchor?: ArchitectureStandingAnchor | undefined
  readonly actions?: ReactNode
  readonly evidence?: ReactNode
}

export function ArchitectureGraphSelectionDetails(props: ArchitectureGraphSelectionDetailsProps)
{
  const node = props.selection.kind === 'node' ? props.selection.node : null
  const edge = props.selection.kind === 'edge' ? props.selection.edge : null
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        <Badge variant="outline">{node?.stateLabel ?? edge?.stateLabel}</Badge>
        <Badge variant="outline">{node?.semanticLevel ?? edge?.relationshipKind}</Badge>
        {props.anchor ? <Badge variant="outline">{props.anchor.status}</Badge> : null}
      </div>
      {node ? (
        <dl className="grid grid-cols-2 gap-2 rounded-lg border border-border bg-muted/20 p-3 text-[11px]">
          <div>
            <dt className="text-muted-foreground">Files</dt>
            <dd className="font-mono text-foreground">{node.fileCount.toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Consumers</dt>
            <dd className="font-mono text-foreground">
              {node.affectedConsumerCount.toLocaleString()}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Inbound</dt>
            <dd className="font-mono text-foreground">{node.inbound.toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Outbound</dt>
            <dd className="font-mono text-foreground">{node.outbound.toLocaleString()}</dd>
          </div>
        </dl>
      ) : edge ? (
        <div className="rounded-lg border border-border bg-muted/20 p-3 text-[11px]">
          <p className="break-all font-mono text-foreground">{edge.from}</p>
          <p className="my-1 text-muted-foreground">to</p>
          <p className="break-all font-mono text-foreground">{edge.to}</p>
          <p className="mt-2 text-muted-foreground">Weight {edge.weight.toLocaleString()}</p>
        </div>
      ) : null}
      {props.anchor ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {props.anchor.disclosure}
        </p>
      ) : null}
      {props.actions}
      {props.evidence}
    </div>
  )
}
