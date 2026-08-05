// scripts/check-directive-preservation.ts
// assert changed files keep the compiler/linter directives their base revision had

// a header or comment migration that rewrites the top of a file can silently
// drop `/// <reference>` and `@effect-diagnostics` directives; nothing but a
// full typecheck of every package catches that, and only after the fact. This
// check compares each changed file against a base revision and fails when a
// directive present at the base is missing from the working copy.
//
// usage: node scripts/check-directive-preservation.ts [<base-ref>]
// base-ref defaults to origin/main, falling back to main.

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'

const CHECKED_EXTENSIONS = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|d\.ts)$/
const DIRECTIVE_PATTERNS: ReadonlyArray<RegExp> = [
  /^[ \t]*\/\/\/\s*<reference\b.*$/,
  /^[ \t]*\/\/\s*@effect-diagnostics\b.*$/,
]

interface DirectiveOccurrence
{
  readonly directive: string
  readonly guardedLine: string | null
}

function git(args: ReadonlyArray<string>): { status: number; stdout: string }
{
  const result = NodeChildProcess.spawnSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return { status: result.status ?? 1, stdout: result.stdout ?? '' }
}

function resolveBaseRef(): string
{
  const requested = process.argv[2]
  const candidates = requested !== undefined ? [requested] : ['origin/main', 'main']
  for (const candidate of candidates)
  {
    if (git(['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]).status === 0)
    {
      return candidate
    }
  }
  NodeFS.writeSync(2, `check-directive-preservation: no base ref among ${candidates.join(', ')}\n`)
  process.exit(2)
}

function normalizeGuardedLine(line: string): string
{
  return line
    .trim()
    .replace(/[ \t]+/g, ' ')
    .replace(/["']/g, '"')
    .replace(/;$/, '')
}

function directiveOccurrences(content: string): ReadonlyArray<DirectiveOccurrence>
{
  const lines = content.split('\n')
  const found: Array<DirectiveOccurrence> = []
  for (let index = 0; index < lines.length; index += 1)
  {
    const line = lines[index] ?? ''
    if (!DIRECTIVE_PATTERNS.some((pattern) => pattern.test(line)))
    {
      continue
    }
    const directive = line.trim()
    const guardedLine = directive.startsWith('// @effect-diagnostics-next-line')
      ? normalizeGuardedLine(
          lines.slice(index + 1).find((candidate) => candidate.trim() !== '') ?? '',
        )
      : null
    found.push({ directive, guardedLine: guardedLine === '' ? null : guardedLine })
  }
  return found
}

function missingDirectives(base: string, current: string): ReadonlyArray<string>
{
  const occurrenceKey = (occurrence: DirectiveOccurrence) =>
    JSON.stringify([occurrence.directive, occurrence.guardedLine])
  const baseGroups = new Map<
    string,
    { readonly occurrence: DirectiveOccurrence; readonly count: number }
  >()
  for (const occurrence of directiveOccurrences(base))
  {
    const key = occurrenceKey(occurrence)
    const existing = baseGroups.get(key)
    baseGroups.set(key, {
      occurrence,
      count: (existing?.count ?? 0) + 1,
    })
  }

  const currentOccurrenceCounts = new Map<string, number>()
  for (const occurrence of directiveOccurrences(current))
  {
    const key = occurrenceKey(occurrence)
    currentOccurrenceCounts.set(key, (currentOccurrenceCounts.get(key) ?? 0) + 1)
  }
  const currentLineCounts = new Map<string, number>()
  for (const line of current.split('\n'))
  {
    const normalized = normalizeGuardedLine(line)
    if (normalized !== '')
    {
      currentLineCounts.set(normalized, (currentLineCounts.get(normalized) ?? 0) + 1)
    }
  }

  const missing: Array<string> = []
  for (const [key, group] of baseGroups)
  {
    const retainedOccurrences = currentOccurrenceCounts.get(key) ?? 0
    const requiredOccurrences =
      group.occurrence.guardedLine === null
        ? group.count
        : Math.min(group.count, currentLineCounts.get(group.occurrence.guardedLine) ?? 0)
    for (let index = retainedOccurrences; index < requiredOccurrences; index += 1)
    {
      missing.push(group.occurrence.directive)
    }
  }
  return missing
}

const baseRef = resolveBaseRef()
const changed = git(['diff', '--name-only', '--diff-filter=M', baseRef])
  .stdout.split('\n')
  .filter((path) => CHECKED_EXTENSIONS.test(path))

let failures = 0
for (const path of changed)
{
  const base = git(['show', `${baseRef}:${path}`])
  if (base.status !== 0) continue
  let current: string
  try
  {
    current = NodeFS.readFileSync(path, 'utf8')
  }
  catch
  {
    continue
  }
  const missing = missingDirectives(base.stdout, current)
  for (const directive of missing)
  {
    failures += 1
    NodeFS.writeSync(2, `${path}: dropped directive from ${baseRef}: ${directive}\n`)
  }
}

if (failures > 0)
{
  NodeFS.writeSync(2, `check-directive-preservation: ${failures} dropped directive(s)\n`)
  process.exit(1)
}
