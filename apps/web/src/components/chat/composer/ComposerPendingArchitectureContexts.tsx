// apps/web/src/components/chat/composer/ComposerPendingArchitectureContexts.tsx
// renders removable draft-only architecture concern chips

import { NetworkIcon } from 'lucide-react'

import {
  formatArchitectureConcernAuthority,
  formatArchitectureConcernLabel,
  formatArchitectureConcernTooltip,
  type ArchitectureConcernContext,
} from '~/composerDraftStore'

import { ComposerRemovableChip, ComposerRemovableChipList } from './ComposerRemovableChip'

export function ComposerPendingArchitectureContexts(props: {
  readonly contexts: ReadonlyArray<ArchitectureConcernContext>
  readonly onRemove: (contextId: string) => void
  readonly className?: string | undefined
})
{
  if (props.contexts.length === 0) return null
  return (
    <ComposerRemovableChipList className={props.className}>
      {props.contexts.map((context) =>
      {
        const label = formatArchitectureConcernLabel(context)
        return (
          <ComposerRemovableChip
            icon={NetworkIcon}
            key={context.id}
            label={label}
            metadata={
              <span className="select-none text-[10px] font-normal leading-tight text-muted-foreground/85">
                {formatArchitectureConcernAuthority(context)}
              </span>
            }
            removeLabel={`Remove architecture concern ${label}`}
            tooltip={formatArchitectureConcernTooltip(context)}
            onRemove={() => props.onRemove(context.id)}
          />
        )
      })}
    </ComposerRemovableChipList>
  )
}
