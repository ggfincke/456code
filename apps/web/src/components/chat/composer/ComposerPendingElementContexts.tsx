// apps/web/src/components/chat/composer/ComposerPendingElementContexts.tsx
// render composer pending element contexts

import { MousePointerClick } from 'lucide-react'

import { ComposerRemovableChip, ComposerRemovableChipList } from './ComposerRemovableChip'
import {
  type ElementContextDraft,
  formatElementContextLabel,
  formatElementContextSourceLabel,
} from '~/lib/elementContext'

interface ComposerPendingElementContextsProps
{
  contexts: ReadonlyArray<ElementContextDraft>
  onRemove: (contextId: string) => void
  className?: string
}

interface ComposerPendingElementContextChipProps
{
  context: ElementContextDraft
  onRemove: (contextId: string) => void
}

function buildTooltipContent(context: ElementContextDraft): string
{
  const lines: string[] = []
  lines.push(formatElementContextLabel(context))
  const source = formatElementContextSourceLabel(context)
  if (source) lines.push(source)
  if (context.pageUrl) lines.push(context.pageUrl)
  if (context.selector) lines.push(context.selector)
  if (context.htmlPreview.trim().length > 0)
  {
    lines.push('')
    lines.push(context.htmlPreview.trim().slice(0, 600))
  }
  return lines.join('\n')
}

export function ComposerPendingElementContextChip({
  context,
  onRemove,
}: ComposerPendingElementContextChipProps)
{
  const label = formatElementContextLabel(context)
  const sourceLabel = formatElementContextSourceLabel(context)
  return (
    <ComposerRemovableChip
      icon={MousePointerClick}
      label={label}
      metadata={
        sourceLabel ? (
          <span className="select-none text-[10px] font-normal leading-tight text-muted-foreground/85">
            {sourceLabel}
          </span>
        ) : null
      }
      removeLabel={`Remove ${label}`}
      tooltip={buildTooltipContent(context)}
      onRemove={() => onRemove(context.id)}
    />
  )
}

export function ComposerPendingElementContexts({
  contexts,
  onRemove,
  className,
}: ComposerPendingElementContextsProps)
{
  if (contexts.length === 0) return null
  return (
    <ComposerRemovableChipList className={className}>
      {contexts.map((context) => (
        <ComposerPendingElementContextChip key={context.id} context={context} onRemove={onRemove} />
      ))}
    </ComposerRemovableChipList>
  )
}
