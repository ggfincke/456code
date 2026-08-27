// apps/mobile/src/features/threads/sidebar/threadSearchHighlight.ts
// splits bounded snippets with the same literal ascii case rules as sqlite search

export function splitThreadSearchHighlight(text: string, query: string)
{
  const fold = (value: string) => value.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
  const needle = fold(query.trim().replace(/\s+/g, ' '))
  if (needle.length === 0) return [{ text, highlighted: false, start: 0 }]
  const folded = fold(text)
  const parts: Array<{ text: string; highlighted: boolean; start: number }> = []
  let cursor = 0
  while (cursor < text.length)
  {
    const index = folded.indexOf(needle, cursor)
    if (index === -1)
    {
      parts.push({ text: text.slice(cursor), highlighted: false, start: cursor })
      break
    }
    if (index > cursor)
      parts.push({ text: text.slice(cursor, index), highlighted: false, start: cursor })
    parts.push({ text: text.slice(index, index + needle.length), highlighted: true, start: index })
    cursor = index + needle.length
  }
  return parts
}
