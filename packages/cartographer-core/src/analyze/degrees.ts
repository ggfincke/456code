// packages/cartographer-core/src/analyze/degrees.ts
// pure per-file degree maps -> the one owner of fan-in/fan-out counting (f34)

export interface FileDegrees
{
  fanIn: Map<string, number>
  fanOut: Map<string, number>
}

// seedIds pre-populate zeros so callers can distinguish "no edges" from
// "unknown file" (metrics/orphan detection needs the zeros)
export function fileDegrees(
  edges: ReadonlyArray<{ from: string; to: string }>,
  seedIds?: Iterable<string>,
): FileDegrees
{
  const fanIn = new Map<string, number>()
  const fanOut = new Map<string, number>()
  if (seedIds)
  {
    for (const id of seedIds)
    {
      fanIn.set(id, 0)
      fanOut.set(id, 0)
    }
  }
  for (const edge of edges)
  {
    fanOut.set(edge.from, (fanOut.get(edge.from) ?? 0) + 1)
    fanIn.set(edge.to, (fanIn.get(edge.to) ?? 0) + 1)
  }
  return { fanIn, fanOut }
}
