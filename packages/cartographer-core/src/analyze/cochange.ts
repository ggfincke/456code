// packages/cartographer-core/src/analyze/cochange.ts
// git-history co-change coupling pairs between graph files

import * as NodeChildProcess from 'node:child_process'
import type { CoChangePair } from '../contracts/types.js'

// printable commit marker (git args can't carry NUL); -z NUL-separates the
// filenames within each commit so newlines/spaces in paths stay intact (F08)
const RECORD_SEP = '@@cartographer-commit@@'
const DEFAULT_COMMIT_LIMIT = 400
// commits touching more graph files than this are bulk sweeps -> skip
const MAX_COMMIT_FILES = 25
const MIN_PAIR_COUNT = 3
const MIN_STRENGTH = 0.4
const MAX_PAIRS = 120

// pairs that repeatedly change together, strongest first; [] outside git
export function computeCoChanges(
  root: string,
  nodeIds: string[],
  scope?: string,
  commitLimit = DEFAULT_COMMIT_LIMIT,
): CoChangePair[]
{
  if (nodeIds.length < 2)
  {
    return []
  }

  let log: string
  let prefix: string
  try
  {
    // node ids are root-relative; git paths are git-root-relative
    prefix = git(root, ['rev-parse', '--show-prefix']).trim()
    // -z NUL-terminates every path; scope pathspec filters history *before*
    // -n samples, so out-of-scope commits don't consume the budget (F07)
    log = git(root, [
      'log',
      `--pretty=format:${RECORD_SEP}`,
      '--name-only',
      '-z',
      '-n',
      String(commitLimit),
      ...(scope ? ['--', scope] : []),
    ])
  }
  catch
  {
    return []
  }

  const ids = new Set(nodeIds)
  // pair identity is a structural tuple, never a delimiter-joined string (F08)
  const changeCounts = new Map<string, number>()
  const pairCounts = new Map<string, Map<string, number>>()
  const bump = (a: string, b: string): void =>
  {
    let inner = pairCounts.get(a)
    if (!inner)
    {
      inner = new Map()
      pairCounts.set(a, inner)
    }
    inner.set(b, (inner.get(b) ?? 0) + 1)
  }

  for (const block of log.split(RECORD_SEP))
  {
    // git prints a newline between the format marker & the name list;
    // strip that one leading newline, then -z NUL-separates each path
    const all = [...new Set(block.replace(/^\n/, '').split('\x00'))]
      .filter((line) => line !== '')
      .map((line) => (prefix && line.startsWith(prefix) ? line.slice(prefix.length) : line))
    const files = all.filter((line) => ids.has(line)).sort()
    // bulk sweeps skew both numerator & denominator -> exclude from both
    if (files.length === 0 || files.length > MAX_COMMIT_FILES)
    {
      continue
    }
    // every non-bulk commit's files count toward the denominator, even
    // singletons -> strength matches the documented shared / min(changes) (F06)
    for (const file of files)
    {
      changeCounts.set(file, (changeCounts.get(file) ?? 0) + 1)
    }
    for (let i = 0; i < files.length; i += 1)
    {
      for (let j = i + 1; j < files.length; j += 1)
      {
        bump(files[i]!, files[j]!)
      }
    }
  }

  const pairs: CoChangePair[] = []
  for (const [a, inner] of pairCounts)
  {
    for (const [b, count] of inner)
    {
      if (count < MIN_PAIR_COUNT)
      {
        continue
      }
      const strength = count / Math.min(changeCounts.get(a) ?? count, changeCounts.get(b) ?? count)
      if (strength < MIN_STRENGTH)
      {
        continue
      }
      pairs.push({ a, b, count, strength: Math.round(strength * 100) / 100 })
    }
  }
  return pairs
    .sort(
      (x, y) =>
        y.count - x.count ||
        y.strength - x.strength ||
        x.a.localeCompare(y.a) ||
        x.b.localeCompare(y.b),
    )
    .slice(0, MAX_PAIRS)
}

function git(root: string, args: string[]): string
{
  return NodeChildProcess.execFileSync('git', ['-C', root, ...args], {
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 32 * 1024 * 1024,
  }).toString()
}
