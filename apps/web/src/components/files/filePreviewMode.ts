// apps/web/src/components/files/filePreviewMode.ts
// classifies rendered file modes & updates markdown task markers

export const isMarkdownPreviewFile = (path: string): boolean => /\.md$/i.test(path)

export const isMdxPreviewFile = (path: string): boolean => /\.mdx$/i.test(path)

export function setMarkdownTaskChecked(
  markdown: string,
  markerOffset: number,
  checked: boolean,
): string
{
  if (
    markerOffset < 0 ||
    markdown[markerOffset] !== '[' ||
    !/[ xX]/.test(markdown[markerOffset + 1] ?? '') ||
    markdown[markerOffset + 2] !== ']'
  )
  {
    return markdown
  }

  return `${markdown.slice(0, markerOffset + 1)}${checked ? 'x' : ' '}${markdown.slice(markerOffset + 2)}`
}
