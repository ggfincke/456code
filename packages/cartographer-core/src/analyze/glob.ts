// packages/cartographer-core/src/analyze/glob.ts
// the hardened segment-aware glob matcher; fs-free so the web bridge can use it

// bound retained compiled patterns so a long-lived MCP process can't grow
// unboundedly across many repositories
const GLOB_CACHE_MAX = 1024
const globPatterns = new Map<string, GlobToken[]>()

// the one hardened matcher; journey stop targets resolve through it too
export function matchesRule(fileId: string, pattern: string): boolean
{
  if (!pattern.includes('*'))
  {
    return fileId === pattern || fileId.startsWith(`${pattern}/`)
  }
  let compiled = globPatterns.get(pattern)
  if (!compiled)
  {
    if (globPatterns.size >= GLOB_CACHE_MAX)
    {
      globPatterns.clear()
    }
    compiled = compileGlob(pattern)
    globPatterns.set(pattern, compiled)
  }
  return matchSegments(compiled, fileId.split('/'))
}

// segment-aware glob compiled to per-segment matchers; ** is its own token
// matching zero or more whole segments (so **/*.ts matches root.ts too)
type GlobToken = { kind: 'globstar' } | { kind: 'segment'; test: (segment: string) => boolean }

function compileGlob(pattern: string): GlobToken[]
{
  const tokens: GlobToken[] = []
  for (const segment of pattern.split('/'))
  {
    // collapse repeated globstars so **/** can't spawn ambiguous backtracking
    if (segment === '**')
    {
      if (tokens.at(-1)?.kind !== 'globstar')
      {
        tokens.push({ kind: 'globstar' })
      }
      continue
    }
    tokens.push({ kind: 'segment', test: segmentMatcher(segment) })
  }
  return tokens
}

// within one segment, * matches zero+ non-slash chars; no nested wildcards ->
// linear-time matching, immune to the catastrophic backtracking of the old regex
function segmentMatcher(segment: string): (value: string) => boolean
{
  if (!segment.includes('*'))
  {
    return (value) => value === segment
  }
  const parts = segment.split('*')
  return (value) =>
  {
    let index = 0
    for (let p = 0; p < parts.length; p += 1)
    {
      const part = parts[p]!
      if (part === '')
      {
        continue
      }
      if (p === 0)
      {
        if (!value.startsWith(part))
        {
          return false
        }
        index = part.length
        continue
      }
      if (p === parts.length - 1)
      {
        return value.slice(index).endsWith(part) && value.length - index >= part.length
      }
      const found = value.indexOf(part, index)
      if (found === -1)
      {
        return false
      }
      index = found + part.length
    }
    return true
  }
}

// greedy globstar w/ failure memo on (token, segment) entry states ->
// polynomial matching even w/ many ** segments (no exponential re-search)
function matchSegments(tokens: GlobToken[], segments: string[]): boolean
{
  // true results short-circuit up the stack; only failures recur
  const failed = new Set<number>()
  const width = segments.length + 1
  const walk = (ti: number, si: number): boolean =>
  {
    const key = ti * width + si
    if (failed.has(key))
    {
      return false
    }
    let t = ti
    let s = si
    while (t < tokens.length)
    {
      const token = tokens[t]!
      if (token.kind === 'globstar')
      {
        // globstar as last token consumes the rest
        if (t === tokens.length - 1)
        {
          return true
        }
        for (let skip = s; skip <= segments.length; skip += 1)
        {
          if (walk(t + 1, skip))
          {
            return true
          }
        }
        failed.add(key)
        return false
      }
      if (s >= segments.length || !token.test(segments[s]!))
      {
        failed.add(key)
        return false
      }
      t += 1
      s += 1
    }
    if (s === segments.length)
    {
      return true
    }
    failed.add(key)
    return false
  }
  return walk(0, 0)
}
