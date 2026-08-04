// tests/apps/web/components/files/FilePreviewPanel.test.ts
// verifies file preview helpers & comment range behavior

import { describe, expect, it } from 'vite-plus/test'

import {
  formatFileCommentRange,
  normalizeFileCommentRange,
  remapFileCommentAnnotations,
} from '../../../../../apps/web/src/components/files/fileCommentAnnotations'
import {
  isMdxPreviewFile,
  isMarkdownPreviewFile,
  setMarkdownTaskChecked,
} from '../../../../../apps/web/src/components/files/filePreviewMode'

describe('file comment annotations', () =>
{
  it('normalizes and formats selected line ranges', () =>
  {
    expect(normalizeFileCommentRange({ start: 16, end: 7 })).toEqual({
      startLine: 7,
      endLine: 16,
    })
    expect(formatFileCommentRange(7, 7)).toBe('L7')
    expect(formatFileCommentRange(7, 16)).toBe('L7 to L16')
  })

  it('keeps an annotation range attached when Pierre remaps its anchor line', () =>
  {
    expect(
      remapFileCommentAnnotations([
        {
          lineNumber: 20,
          metadata: {
            entries: [
              {
                id: 'comment-1',
                kind: 'comment',
                startLine: 7,
                endLine: 16,
                text: 'Keep this guarded.',
              },
            ],
          },
        },
      ]),
    ).toEqual([
      {
        lineNumber: 20,
        metadata: {
          entries: [
            {
              id: 'comment-1',
              kind: 'comment',
              startLine: 11,
              endLine: 20,
              text: 'Keep this guarded.',
            },
          ],
        },
      },
    ])
  })
})

describe('isMarkdownPreviewFile', () =>
{
  it('classifies markdown and MDX separately, case-insensitively', () =>
  {
    expect(isMarkdownPreviewFile('README.md')).toBe(true)
    expect(isMarkdownPreviewFile('docs/guide.MDX')).toBe(false)
    expect(isMdxPreviewFile('README.md')).toBe(false)
    expect(isMdxPreviewFile('docs/guide.MDX')).toBe(true)
  })

  it('does not treat other text files as markdown or MDX', () =>
  {
    expect(isMarkdownPreviewFile('docs/guide.txt')).toBe(false)
    expect(isMarkdownPreviewFile('docs/markdown.ts')).toBe(false)
    expect(isMdxPreviewFile('docs/guide.txt')).toBe(false)
    expect(isMdxPreviewFile('docs/component.mdx.ts')).toBe(false)
  })
})

describe('setMarkdownTaskChecked', () =>
{
  const markdown = '- [ ] First\n- [x] Second\n'

  it('checks and unchecks the task marker at the supplied offset', () =>
  {
    expect(setMarkdownTaskChecked(markdown, 2, true)).toBe('- [x] First\n- [x] Second\n')
    expect(setMarkdownTaskChecked(markdown, 14, false)).toBe('- [ ] First\n- [ ] Second\n')
    expect(setMarkdownTaskChecked('1. [X] Ordered\n', 3, false)).toBe('1. [ ] Ordered\n')
  })

  it('leaves the document unchanged for a stale or invalid marker offset', () =>
  {
    expect(setMarkdownTaskChecked(markdown, 0, true)).toBe(markdown)
    expect(setMarkdownTaskChecked(markdown, 200, true)).toBe(markdown)
  })
})
