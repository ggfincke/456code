// apps/web/src/components/chat/composer/ComposerStashBadge.tsx
// shows the current provider prompt stash count
import { BookmarkIcon } from 'lucide-react'
import { memo } from 'react'

import { cn } from '~/lib/utils'

// opens the stash menu and briefly acknowledges newly saved prompts
export const ComposerStashBadge = memo(function ComposerStashBadge(props: {
  count: number
  pulseKey: number
  pulsing: boolean
  menuOpen: boolean
  onToggleMenu: () => void
})
{
  if (props.count === 0) return null

  return (
    <button
      type="button"
      data-prompt-stash-badge="true"
      aria-label={`Stashed prompts: ${props.count}. Open stash.`}
      aria-expanded={props.menuOpen}
      className={cn(
        'absolute -top-3 right-4 z-10 inline-flex cursor-pointer items-center gap-1.5 rounded-full border bg-popover px-2.5 py-0.5 text-xs shadow-sm',
        'transition-[color,border-color,opacity] duration-200',
        props.menuOpen || props.pulsing
          ? 'border-border text-foreground opacity-100'
          : 'border-border/70 text-muted-foreground opacity-70 hover:opacity-100 hover:text-foreground',
      )}
      onPointerDown={(event) =>
      {
        // keep composer focus so escape and typing stay intact
        event.preventDefault()
      }}
      onClick={props.onToggleMenu}
    >
      <BookmarkIcon className="size-3" aria-hidden="true" />
      Stash
      <span
        key={props.pulseKey}
        className={cn(
          'rounded-full px-1.5 text-[10px] font-medium tabular-nums',
          props.pulsing
            ? 'prompt-stash-count-enter bg-primary text-primary-foreground'
            : 'bg-muted text-muted-foreground',
        )}
      >
        {props.count}
      </span>
    </button>
  )
})
