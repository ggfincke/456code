// apps/web/src/components/architecture/ArchitectureZoomControl.tsx
// keeps repository architecture drill levels in one persistent control

import { ArrowLeftIcon, BoxesIcon, FilesIcon, NetworkIcon } from 'lucide-react'
import { useEffect, useRef } from 'react'

import { Button } from '~/components/ui/button'
import { Toggle, ToggleGroup } from '~/components/ui/toggle-group'
import { cn } from '~/lib/utils'

export type ArchitectureZoomLevel = 'systems' | 'blocks' | 'files'

export interface ArchitectureZoomControlProps
{
  readonly level: ArchitectureZoomLevel
  readonly blocksAvailable: boolean
  readonly filesAvailable: boolean
  readonly focusRequestId?: number | undefined
  readonly narrow: boolean
  readonly backLabel: string
  readonly onBack: () => void
  readonly onLevelChange: (level: ArchitectureZoomLevel) => void
}

export function ArchitectureZoomControl(props: ArchitectureZoomControlProps)
{
  const previousLevel = useRef(props.level)
  const previousFocusRequestId = useRef(props.focusRequestId)
  const levelButtons = useRef<Record<ArchitectureZoomLevel, HTMLButtonElement | null>>({
    systems: null,
    blocks: null,
    files: null,
  })
  const levels = [
    {
      value: 'systems',
      label: 'Systems',
      available: true,
      icon: NetworkIcon,
      unavailableLabel: '',
    },
    {
      value: 'blocks',
      label: 'Blocks',
      available: props.blocksAvailable,
      icon: BoxesIcon,
      unavailableLabel: 'Inspect a system to make Blocks available',
    },
    {
      value: 'files',
      label: 'Files',
      available: props.filesAvailable,
      icon: FilesIcon,
      unavailableLabel: 'Inspect a block to make Files available',
    },
  ] as const
  const lockedHint =
    props.level === 'systems' && !props.blocksAvailable
      ? props.narrow
        ? 'Open a system to unlock'
        : 'Inspect a system, then use Open system to unlock Blocks.'
      : props.level === 'blocks' && !props.filesAvailable
        ? props.narrow
          ? 'Open a block to unlock'
          : 'Inspect a block, then use Open block to unlock Files.'
        : null

  useEffect(() =>
  {
    if (
      previousLevel.current === props.level &&
      previousFocusRequestId.current === props.focusRequestId
    )
    {
      return
    }
    previousLevel.current = props.level
    previousFocusRequestId.current = props.focusRequestId
    levelButtons.current[props.level]?.focus()
  }, [props.focusRequestId, props.level])

  return (
    <nav
      aria-label="Repository architecture levels"
      className={cn(
        'z-10 flex min-h-11 shrink-0 items-center gap-2 overflow-x-auto border-b border-[var(--architecture-border-soft)] bg-[var(--architecture-sunken)] px-2 py-1.5',
        props.narrow ? 'justify-center' : 'justify-start',
      )}
    >
      {props.level !== 'systems' ? (
        <>
          <Button
            aria-label={props.backLabel}
            className="text-[var(--architecture-text-muted)] hover:bg-[var(--architecture-surface)] hover:text-[var(--architecture-text)] focus-visible:ring-[var(--architecture-accent)]"
            size={props.narrow ? 'icon-sm' : 'sm'}
            title={props.backLabel}
            variant="ghost"
            onClick={props.onBack}
          >
            <ArrowLeftIcon />
            <span className={props.narrow ? 'sr-only' : undefined}>{props.backLabel}</span>
          </Button>
          <span
            aria-hidden="true"
            className="h-5 w-px shrink-0 bg-[var(--architecture-border-soft)]"
          />
        </>
      ) : null}
      {!props.narrow ? (
        <span className="shrink-0 font-mono text-[9px] font-bold uppercase tracking-[0.12em] text-[var(--architecture-text-faint)]">
          Level
        </span>
      ) : null}
      <ToggleGroup
        aria-label="Architecture level"
        className="shrink-0 gap-0.5 rounded-lg border border-[var(--architecture-border-soft)] bg-[var(--architecture-page)] p-0.5"
        orientation="horizontal"
        size="xs"
        value={[props.level]}
        variant="default"
        onValueChange={(value) =>
        {
          const next = value[0]
          if (next === 'systems' || next === 'blocks' || next === 'files')
          {
            props.onLevelChange(next)
          }
        }}
      >
        {levels.map((level) =>
        {
          const Icon = level.icon
          const description = level.available ? `${level.label} level` : level.unavailableLabel

          return (
            <Toggle
              aria-current={props.level === level.value ? 'step' : undefined}
              aria-label={description}
              className={cn(
                'h-7 min-w-[4.75rem] gap-1.5 rounded-md border border-transparent px-2.5 text-[11px] font-semibold text-[var(--architecture-text-muted)] transition-colors hover:bg-[var(--architecture-surface)] hover:text-[var(--architecture-text)] focus-visible:ring-[var(--architecture-accent)] data-pressed:border-[color-mix(in_srgb,var(--architecture-accent)_42%,transparent)] data-pressed:bg-[color-mix(in_srgb,var(--architecture-accent)_14%,transparent)] data-pressed:text-[var(--architecture-accent)] disabled:text-[var(--architecture-text-faint)]',
                props.narrow && 'min-w-[4.25rem] px-2',
              )}
              disabled={!level.available}
              key={level.value}
              ref={(button) =>
              {
                levelButtons.current[level.value] = button
              }}
              title={description}
              value={level.value}
            >
              <Icon className="size-3.5" aria-hidden="true" />
              {level.label}
            </Toggle>
          )
        })}
      </ToggleGroup>
      {lockedHint === null ? null : (
        <span className="shrink-0 whitespace-nowrap text-[10px] text-[var(--architecture-text-faint)]">
          {lockedHint}
        </span>
      )}
    </nav>
  )
}
