// apps/web/src/components/search/ProjectSearchDialog.tsx
// share the file and content search dialog chrome and keyboard guidance

import type { ComponentProps, ReactNode } from 'react'
import { SearchIcon } from 'lucide-react'

import { CommandDialogPopup, CommandFooter } from '../ui/command'
import { Input } from '../ui/input'
import { Kbd } from '../ui/kbd'

export function ProjectSearchDialog({
  label,
  inputProps,
  controls,
  children,
  onOpenChange,
}: {
  readonly label: string
  readonly inputProps: ComponentProps<typeof Input>
  readonly controls?: ReactNode
  readonly children: ReactNode
  readonly onOpenChange: (open: boolean) => void
})
{
  return (
    <CommandDialogPopup
      aria-label={label}
      className="flex max-h-[min(38rem,80dvh)] flex-col overflow-hidden p-0"
      onBackdropPointerDown={() => onOpenChange(false)}
    >
      <div className="flex shrink-0 items-center gap-2 px-3 py-2">
        <SearchIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <Input
          autoFocus
          nativeInput
          unstyled
          type="search"
          maxLength={256}
          aria-label={label}
          className="min-w-0 flex-1 rounded-md has-focus-visible:ring-2 has-focus-visible:ring-ring"
          {...inputProps}
        />
      </div>
      {controls}
      {children}
      <CommandFooter className="shrink-0 justify-start text-xs">
        <Kbd>↑ ↓</Kbd> Navigate <Kbd>Enter</Kbd> Open file <Kbd>Esc</Kbd> Close
      </CommandFooter>
    </CommandDialogPopup>
  )
}
