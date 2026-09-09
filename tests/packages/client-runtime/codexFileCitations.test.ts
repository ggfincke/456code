// tests/packages/client-runtime/codexFileCitations.test.ts
// verifies portable file citation destinations and safe visible labels

import {
  codexFileCitationMarkdown,
  resolveCodexFileCitationLink,
} from '@t3tools/client-runtime/codex-file-citations'
import { describe, expect, it } from 'vite-plus/test'

describe('Codex file citations', () =>
{
  it('carries a valid first line while escaping URL syntax in the path', () =>
  {
    expect(
      resolveCodexFileCitationLink({
        path: 'reports/100% #1? draft.md',
        line_range_start: '7',
      }),
    ).toEqual({
      path: 'reports/100% #1? draft.md',
      href: 'reports/100%25 %231%3F draft.md#L7',
      label: '100% #1? draft.md',
      lineRangeStart: 7,
    })
  })

  it('keeps missing paths literal and produces portable Markdown for valid paths', () =>
  {
    expect(resolveCodexFileCitationLink({ purpose: 'output' })).toBeNull()
    const citation = resolveCodexFileCitationLink({ path: 'reports/*draft*_[copy]`<&.txt' })
    expect(citation && codexFileCitationMarkdown(citation)).toBe(
      '[\\*draft\\*\\_\\[copy\\]\\`\\<\\&.txt](<reports/*draft*_[copy]`%3C&.txt>)',
    )
  })
})
