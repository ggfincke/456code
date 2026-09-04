// apps/server/src/checkpointing/Diffs.ts
// parse turn diff file summaries from git numstat output

export interface TurnDiffFileSummary
{
  readonly path: string
  readonly additions: number
  readonly deletions: number
}

export function parseTurnDiffFilesFromNumstat(numstat: string): ReadonlyArray<TurnDiffFileSummary>
{
  const records = numstat.split('\0')
  const files: TurnDiffFileSummary[] = []

  for (let index = 0; index < records.length; index += 1)
  {
    const record = records[index]!
    const counts = /^(\d+|-)\t(\d+|-)\t/.exec(record)
    if (!counts)
    {
      continue
    }

    let path = record.slice(counts[0].length)
    if (path.length === 0)
    {
      // renames and copies use two more records: the source and destination
      path = records[index + 2] ?? ''
      index += 2
    }
    if (path.length === 0)
    {
      continue
    }

    files.push({
      path,
      additions: counts[1] === '-' ? 0 : Number(counts[1]),
      deletions: counts[2] === '-' ? 0 : Number(counts[2]),
    })
  }

  return files.toSorted((left, right) => left.path.localeCompare(right.path))
}
