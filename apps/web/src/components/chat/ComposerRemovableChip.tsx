// apps/web/src/components/chat/ComposerRemovableChip.tsx
// render shared removable composer chips and lists

import { X, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import {
  COMPOSER_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
} from '../composerInlineChip'
import { Tooltip, TooltipPopup, TooltipTrigger } from '../ui/tooltip'
import { cn } from '~/lib/utils'

interface ComposerRemovableChipProps
{
  icon: LucideIcon
  label: ReactNode
  metadata?: ReactNode
  removeLabel: string
  tooltip: ReactNode
  onRemove: () => void
}

export function ComposerRemovableChip({
  icon: Icon,
  label,
  metadata,
  removeLabel,
  tooltip,
  onRemove,
}: ComposerRemovableChipProps)
{
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className={cn(COMPOSER_INLINE_CHIP_CLASS_NAME, 'pr-1')}>
            <Icon className={cn(COMPOSER_INLINE_CHIP_ICON_CLASS_NAME, 'size-3.5')} />
            <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{label}</span>
            {metadata}
            <button
              type="button"
              aria-label={removeLabel}
              className={COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME}
              onClick={(event) =>
              {
                event.preventDefault()
                event.stopPropagation()
                onRemove()
              }}
            >
              <X className="size-3" aria-hidden />
            </button>
          </span>
        }
      />
      <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap leading-tight">
        {tooltip}
      </TooltipPopup>
    </Tooltip>
  )
}

export function ComposerRemovableChipList({
  children,
  className,
}: {
  children: ReactNode
  className?: string | undefined
})
{
  return <div className={cn('flex flex-wrap gap-1.5', className)}>{children}</div>
}
