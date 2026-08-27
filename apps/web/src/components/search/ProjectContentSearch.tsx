// apps/web/src/components/search/ProjectContentSearch.tsx
// search task workspace contents and open bounded plaintext matches at their source line

import type { ProjectSearchContentsResult } from '@t3tools/contracts'
import { useEffect, useId, useState } from 'react'

import {
  type ActiveProjectTarget,
  useActiveProjectTarget,
} from '../../hooks/useActiveProjectTarget'
import { cn } from '../../lib/utils'
import { useRightPanelStore } from '../../rightPanelStore'
import { useProjectContentSearch } from '../../state/queries'
import { Button } from '../ui/button'
import { HighlightedSearchLine } from './HighlightedSearchLine'
import { ProjectSearchDialog } from './ProjectSearchDialog'

type ContentMatch = ProjectSearchContentsResult['matches'][number]

function ContentSearchResults({
  target,
  onOpenChange,
}: {
  readonly target: ActiveProjectTarget
  readonly onOpenChange: (open: boolean) => void
})
{
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [useRegex, setUseRegex] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const search = useProjectContentSearch({
    environmentId: target.environmentId,
    cwd: target.cwd,
    query,
    caseSensitive,
    wholeWord,
    useRegex,
  })
  const listId = useId()
  const groups = new Map<string, ContentMatch[]>()
  for (const match of search.matches)
  {
    const group = groups.get(match.path)
    if (group) group.push(match)
    else groups.set(match.path, [match])
  }
  const matches = [...groups.values()].flat()
  const indexByMatch = new Map(matches.map((match, index) => [match, index]))
  const activeIndex = Math.min(selectedIndex, matches.length - 1)
  const activeId = activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined
  useEffect(() =>
  {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' })
  }, [activeId])

  const openMatch = (match: ContentMatch) =>
  {
    useRightPanelStore.getState().openFile(target.threadRef, match.path, match.lineNumber)
    onOpenChange(false)
  }
  const options = [
    { label: 'Match case', value: caseSensitive, set: setCaseSensitive, text: 'Aa' },
    { label: 'Match whole word', value: wholeWord, set: setWholeWord, text: 'Word' },
    { label: 'Use regular expression', value: useRegex, set: setUseRegex, text: '.*' },
  ]

  return (
    <ProjectSearchDialog
      label={`Search file contents in ${target.projectName}`}
      onOpenChange={onOpenChange}
      inputProps={{
        value: query,
        placeholder: 'Search file contents…',
        role: 'combobox',
        'aria-autocomplete': 'list',
        'aria-expanded': matches.length > 0,
        'aria-controls': listId,
        'aria-activedescendant': activeId,
        onChange: (event) =>
        {
          setQuery(event.currentTarget.value)
          setSelectedIndex(0)
        },
        onKeyDown: (event) =>
        {
          if (event.key === 'ArrowDown' && matches.length > 0)
          {
            event.preventDefault()
            setSelectedIndex((activeIndex + 1) % matches.length)
          }
          else if (event.key === 'ArrowUp' && matches.length > 0)
          {
            event.preventDefault()
            setSelectedIndex((activeIndex - 1 + matches.length) % matches.length)
          }
          else if (event.key === 'Enter')
          {
            event.preventDefault()
            const match = matches[activeIndex]
            if (match && !search.isPending) openMatch(match)
          }
        },
      }}
      controls={
        <div className="flex shrink-0 items-center gap-1 border-b px-3 pb-2">
          {options.map((option) => (
            <Button
              key={option.label}
              type="button"
              size="xs"
              variant={option.value ? 'secondary' : 'ghost'}
              aria-label={option.label}
              aria-pressed={option.value}
              onClick={() =>
              {
                option.set(!option.value)
                setSelectedIndex(0)
              }}
            >
              {option.text}
            </Button>
          ))}
          <span className="ml-auto truncate text-xs text-muted-foreground">
            {target.projectName}
          </span>
        </div>
      }
    >
      <div role="status" className="shrink-0 space-y-1 px-4 py-2 text-xs text-muted-foreground">
        <p>
          {search.isPending
            ? 'Searching…'
            : (search.error ??
              (!search.hasQuery
                ? 'Type to search the task workspace.'
                : `${matches.length}${search.truncated ? '+' : ''} results in ${groups.size} files`))}
        </p>
        {search.regexFallbackError ? (
          <p className="text-warning">{search.regexFallbackError}</p>
        ) : null}
        {search.truncated ? (
          <p>Results were limited. Refine your search to find more matches.</p>
        ) : null}
      </div>
      <div
        id={listId}
        role="listbox"
        aria-label="File content matches"
        className="min-h-0 overflow-y-auto pb-2"
      >
        {[...groups].map(([path, group]) => (
          <div key={path} role="group" aria-label={path} className="pb-2">
            <div className="sticky top-0 truncate bg-popover px-4 py-2 text-xs font-medium">
              {path}
            </div>
            {group.map((match) =>
            {
              const index = indexByMatch.get(match)!
              return (
                <button
                  type="button"
                  key={index}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === activeIndex}
                  aria-label={`${path}, line ${match.lineNumber}`}
                  tabIndex={-1}
                  className={cn(
                    'flex w-full min-w-0 gap-3 px-4 py-2 text-left font-mono text-xs hover:bg-accent',
                    index === activeIndex && 'bg-accent text-accent-foreground',
                  )}
                  onMouseMove={() => setSelectedIndex(index)}
                  onClick={() => openMatch(match)}
                >
                  <span className="w-9 shrink-0 text-right tabular-nums text-muted-foreground">
                    {match.lineNumber}
                  </span>
                  <span className="min-w-0 flex-1 truncate whitespace-pre">
                    <HighlightedSearchLine text={match.lineContent} ranges={match.matchRanges} />
                  </span>
                </button>
              )
            })}
          </div>
        ))}
      </div>
    </ProjectSearchDialog>
  )
}

export function ProjectContentSearch({
  onOpenChange,
}: {
  readonly onOpenChange: (open: boolean) => void
})
{
  const target = useActiveProjectTarget()
  return target ? (
    <ContentSearchResults
      key={`${target.environmentId}:${target.cwd}`}
      target={target}
      onOpenChange={onOpenChange}
    />
  ) : (
    <ProjectSearchDialog
      label="Search file contents"
      inputProps={{ disabled: true, placeholder: 'Search file contents…' }}
      onOpenChange={onOpenChange}
    >
      <p className="px-6 py-10 text-center text-sm text-muted-foreground">
        Open a task to search its workspace files.
      </p>
    </ProjectSearchDialog>
  )
}
