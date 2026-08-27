// apps/web/src/components/files/ProjectFilePicker.tsx
// browse and search workspace filenames and open the selected right-panel file

import { FileIcon } from 'lucide-react'
import { useEffect, useId, useState } from 'react'

import {
  type ActiveProjectTarget,
  useActiveProjectTarget,
} from '../../hooks/useActiveProjectTarget'
import { useRightPanelStore } from '../../rightPanelStore'
import { useProjectFileSearch } from '../../state/queries'
import { cn } from '../../lib/utils'
import { ProjectSearchDialog } from '../search/ProjectSearchDialog'

function FilePickerResults({
  target,
  onOpenChange,
}: {
  readonly target: ActiveProjectTarget
  readonly onOpenChange: (open: boolean) => void
})
{
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const result = useProjectFileSearch({
    environmentId: target.environmentId,
    cwd: target.cwd,
    query,
  })
  const listId = useId()
  const activeIndex = Math.min(selectedIndex, result.entries.length - 1)
  const activeId = activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined

  useEffect(() =>
  {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' })
  }, [activeId])

  const openFile = (path: string) =>
  {
    useRightPanelStore.getState().openFile(target.threadRef, path)
    onOpenChange(false)
  }

  return (
    <ProjectSearchDialog
      label={`Search files in ${target.projectName}`}
      onOpenChange={onOpenChange}
      inputProps={{
        value: query,
        placeholder: 'Search filenames…',
        role: 'combobox',
        'aria-autocomplete': 'list',
        'aria-expanded': result.entries.length > 0,
        'aria-controls': listId,
        'aria-activedescendant': activeId,
        onChange: (event) =>
        {
          setQuery(event.currentTarget.value)
          setSelectedIndex(0)
        },
        onKeyDown: (event) =>
        {
          if (event.key === 'ArrowDown' && result.entries.length > 0)
          {
            event.preventDefault()
            setSelectedIndex((activeIndex + 1) % result.entries.length)
          }
          else if (event.key === 'ArrowUp' && result.entries.length > 0)
          {
            event.preventDefault()
            setSelectedIndex((activeIndex - 1 + result.entries.length) % result.entries.length)
          }
          else if (event.key === 'Enter')
          {
            event.preventDefault()
            const entry = result.entries[activeIndex]
            if (entry && !result.isPending) openFile(entry.path)
          }
        },
      }}
    >
      <div role="status" className="shrink-0 px-4 py-2 text-xs text-muted-foreground">
        {result.isPending
          ? 'Searching workspace files…'
          : (result.error ??
            (result.entries.length === 0
              ? 'No matching files.'
              : `${result.entries.length}${result.truncated ? '+' : ''} files in ${target.projectName}`))}
      </div>
      <div
        id={listId}
        role="listbox"
        aria-label="Workspace files"
        className="min-h-0 overflow-y-auto p-2"
      >
        {result.entries.map((entry, index) => (
          <button
            key={entry.path}
            id={`${listId}-${index}`}
            role="option"
            aria-selected={index === activeIndex}
            tabIndex={-1}
            type="button"
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent',
              index === activeIndex && 'bg-accent text-accent-foreground',
            )}
            onMouseMove={() => setSelectedIndex(index)}
            onClick={() => openFile(entry.path)}
          >
            <FileIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{entry.path.split('/').at(-1)}</span>
              <span className="block truncate text-xs text-muted-foreground">{entry.path}</span>
            </span>
          </button>
        ))}
      </div>
    </ProjectSearchDialog>
  )
}

export function ProjectFilePicker({
  onOpenChange,
}: {
  readonly onOpenChange: (open: boolean) => void
})
{
  const target = useActiveProjectTarget()
  return target ? (
    <FilePickerResults
      key={`${target.environmentId}:${target.cwd}`}
      target={target}
      onOpenChange={onOpenChange}
    />
  ) : (
    <ProjectSearchDialog
      label="Search files"
      inputProps={{ disabled: true, placeholder: 'Search filenames…' }}
      onOpenChange={onOpenChange}
    >
      <p className="px-6 py-10 text-center text-sm text-muted-foreground">
        Open a task to search its workspace files.
      </p>
    </ProjectSearchDialog>
  )
}
