// apps/web/src/components/search/HighlightedSearchLine.tsx
// render bounded plaintext match windows without interpreting file contents as markup

export const SEARCH_LINE_WINDOW = 320

export interface SearchMatchRange
{
  readonly start: number
  readonly end: number
}

export function searchLineWindow(text: string, ranges: ReadonlyArray<SearchMatchRange>)
{
  const validRanges = ranges
    .filter(
      (range) =>
        Number.isInteger(range.start) &&
        Number.isInteger(range.end) &&
        range.start >= 0 &&
        range.end > range.start &&
        range.start < text.length,
    )
    .toSorted((left, right) => left.start - right.start)
  const firstStart = validRanges[0]?.start ?? 0
  let start = Math.max(0, Math.min(firstStart - 40, text.length - SEARCH_LINE_WINDOW))
  let end = Math.min(text.length, start + SEARCH_LINE_WINDOW)
  // avoid splitting a surrogate pair at either edge of the visible window
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(text[start] ?? '')) start -= 1
  if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1] ?? '')) end -= 1

  const segments: Array<{
    readonly start: number
    readonly text: string
    readonly highlighted: boolean
  }> = []
  let cursor = start
  for (const range of validRanges)
  {
    const from = Math.max(cursor, range.start)
    const to = Math.min(end, range.end)
    if (to <= from) continue
    if (cursor < from)
      segments.push({ start: cursor, text: text.slice(cursor, from), highlighted: false })
    segments.push({ start: from, text: text.slice(from, to), highlighted: true })
    cursor = to
  }
  if (cursor < end)
    segments.push({ start: cursor, text: text.slice(cursor, end), highlighted: false })
  return { leadingEllipsis: start > 0, trailingEllipsis: end < text.length, segments }
}

export function HighlightedSearchLine({
  text,
  ranges,
}: {
  readonly text: string
  readonly ranges: ReadonlyArray<SearchMatchRange>
})
{
  const window = searchLineWindow(text, ranges)
  return (
    <>
      {window.leadingEllipsis ? '…' : null}
      {window.segments.map((segment) =>
        segment.highlighted ? (
          <mark key={segment.start} className="rounded-sm bg-primary/20 text-inherit">
            {segment.text}
          </mark>
        ) : (
          <span key={segment.start}>{segment.text}</span>
        ),
      )}
      {window.trailingEllipsis ? '…' : null}
    </>
  )
}
