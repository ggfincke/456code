// tests/apps/web/components/search/HighlightedSearchLine.test.tsx
// protect bounded match windows and plaintext rendering of repository content

import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vite-plus/test'

import {
  HighlightedSearchLine,
  SEARCH_LINE_WINDOW,
  searchLineWindow,
} from '../../../../../apps/web/src/components/search/HighlightedSearchLine'

it('centers a bounded window on a late Unicode match and ignores invalid ranges', () =>
{
  const text = 'x'.repeat(800) + '😀 needle <script>' + 'y'.repeat(800)
  const window = searchLineWindow(text, [
    { start: -1, end: 4 },
    { start: 803, end: 809 },
    { start: 805, end: 812 },
    { start: 9000, end: 9001 },
  ])
  expect(window.leadingEllipsis).toBe(true)
  expect(window.trailingEllipsis).toBe(true)
  expect(window.segments.map((segment) => segment.text).join('').length).toBeLessThanOrEqual(
    SEARCH_LINE_WINDOW + 1,
  )
  expect(
    window.segments
      .filter((segment) => segment.highlighted)
      .map((segment) => segment.text)
      .join(''),
  ).toBe('needle <s')
})

it('renders matched HTML-looking source as text rather than executable markup', () =>
{
  const markup = renderToStaticMarkup(
    <HighlightedSearchLine text="<img src=x onerror=alert(1)>" ranges={[{ start: 1, end: 4 }]} />,
  )
  expect(markup).not.toContain('<img')
  expect(markup).toContain('&lt;')
  expect(markup).toContain('img</mark>')
})
